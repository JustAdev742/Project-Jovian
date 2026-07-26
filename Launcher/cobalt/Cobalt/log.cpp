#include "log.h"
#include "settings.h"

#include <Windows.h>
// Types and constants only. Including this header does NOT create an import — that would come from
// linking winhttp.lib, which we deliberately do not do. Every call goes through a pointer resolved
// with GetProcAddress at runtime, so winhttp.dll is never a load-time dependency of this DLL.
#include <winhttp.h>

#include <deque>
#include <iostream>
#include <mutex>
#include <streambuf>
#include <string>
#include <vector>

//--------------------------------------------------------------------------------------------------
//  Cobalt is loaded as GFSDK_Aftermath_Lib.x64.dll, i.e. resolved by the game's import table during
//  process startup. Its load-time dependency list must therefore stay as small as the original's:
//  kernel32 + the CRT, nothing more. That is why the log directory comes from an environment
//  variable rather than SHGetKnownFolderPath (which would drag in shell32 and ole32), and why
//  WinHttp is loaded lazily on the background thread rather than linked.
//--------------------------------------------------------------------------------------------------

namespace Cobalt::Log
{
    namespace
    {
        constexpr size_t kMaxQueued = 512;
        constexpr DWORD  kFlushIntervalMs = 750;

        std::mutex              g_mutex;
        std::deque<std::string> g_queue;
        size_t                  g_dropped = 0;

        std::mutex  g_statusMutex;
        std::string g_status;
        bool        g_statusHealthy = true;
        bool        g_statusDirty = false;

        HANDLE        g_stopEvent = nullptr;
        volatile LONG g_initialised = 0;
        std::wstring  g_logFilePath;

        std::string Timestamp()
        {
            SYSTEMTIME st;
            GetLocalTime(&st);
            char buf[24];
            _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%02d:%02d:%02d.%03d",
                        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
            return buf;
        }

        //------------------------------------------------------------------------------------------
        //  File sink — opened once per flush, not once per line.
        //------------------------------------------------------------------------------------------
        std::wstring ResolveLogPath()
        {
            wchar_t buffer[MAX_PATH] = {};
            const DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", buffer, MAX_PATH);
            if (len == 0 || len >= MAX_PATH)
                return L"";

            std::wstring dir(buffer, len);
            dir += L"\\ProjectNova";
            CreateDirectoryW(dir.c_str(), nullptr);
            dir += L"\\Logs";
            CreateDirectoryW(dir.c_str(), nullptr);
            return dir + L"\\cobalt.log";
        }

        void AppendToFile(const std::string& text)
        {
            if (g_logFilePath.empty() || text.empty())
                return;

            HANDLE file = CreateFileW(g_logFilePath.c_str(), FILE_APPEND_DATA,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                      OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (file == INVALID_HANDLE_VALUE)
                return;

            DWORD written = 0;
            SetFilePointer(file, 0, nullptr, FILE_END);
            WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
            CloseHandle(file);
        }

        //------------------------------------------------------------------------------------------
        //  WinHttp, resolved lazily. Only ever touched from the writer thread.
        //------------------------------------------------------------------------------------------
        struct WinHttpApi
        {
            HMODULE module = nullptr;
            bool    tried = false;

            decltype(&WinHttpOpen)           Open = nullptr;
            decltype(&WinHttpConnect)        Connect = nullptr;
            decltype(&WinHttpOpenRequest)    OpenRequest = nullptr;
            decltype(&WinHttpSendRequest)    SendRequest = nullptr;
            decltype(&WinHttpReceiveResponse) ReceiveResponse = nullptr;
            decltype(&WinHttpSetTimeouts)    SetTimeouts = nullptr;
            decltype(&WinHttpCloseHandle)    Close = nullptr;

            bool Ready()
            {
                if (tried)
                    return module != nullptr;
                tried = true;

                module = LoadLibraryW(L"winhttp.dll");
                if (!module)
                    return false;

                Open            = reinterpret_cast<decltype(Open)>(GetProcAddress(module, "WinHttpOpen"));
                Connect         = reinterpret_cast<decltype(Connect)>(GetProcAddress(module, "WinHttpConnect"));
                OpenRequest     = reinterpret_cast<decltype(OpenRequest)>(GetProcAddress(module, "WinHttpOpenRequest"));
                SendRequest     = reinterpret_cast<decltype(SendRequest)>(GetProcAddress(module, "WinHttpSendRequest"));
                ReceiveResponse = reinterpret_cast<decltype(ReceiveResponse)>(GetProcAddress(module, "WinHttpReceiveResponse"));
                SetTimeouts     = reinterpret_cast<decltype(SetTimeouts)>(GetProcAddress(module, "WinHttpSetTimeouts"));
                Close           = reinterpret_cast<decltype(Close)>(GetProcAddress(module, "WinHttpCloseHandle"));

                if (!Open || !Connect || !OpenRequest || !SendRequest || !ReceiveResponse || !Close)
                {
                    FreeLibrary(module);
                    module = nullptr;
                    return false;
                }
                return true;
            }
        };

        WinHttpApi g_http;

        std::string JsonEscape(const std::string& in)
        {
            std::string out;
            out.reserve(in.size() + 16);
            for (unsigned char c : in)
            {
                switch (c)
                {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                default:
                    if (c < 0x20)
                    {
                        char b[8];
                        _snprintf_s(b, sizeof(b), _TRUNCATE, "\\u%04x", c);
                        out += b;
                    }
                    else out += static_cast<char>(c);
                }
            }
            return out;
        }

        /// Fire-and-forget. A failure just means the backend is not up; the file sink still has it.
        void PostBatch(const std::string& body)
        {
            if (!g_http.Ready())
                return;

            HINTERNET session = g_http.Open(L"Cobalt", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
            if (!session)
                return;

            if (g_http.SetTimeouts)
                g_http.SetTimeouts(session, 1000, 1000, 2000, 2000);   // never wedge this thread

            if (HINTERNET connect = g_http.Connect(session, COBALT_BACKEND_HOST_W,
                                                   static_cast<INTERNET_PORT>(COBALT_BACKEND_PORT_N), 0))
            {
                if (HINTERNET request = g_http.OpenRequest(connect, L"POST", L"/nova/api/logs/ingest",
                                                           nullptr, WINHTTP_NO_REFERER,
                                                           WINHTTP_DEFAULT_ACCEPT_TYPES, 0))
                {
                    const wchar_t* headers = L"Content-Type: application/json\r\n";
                    g_http.SendRequest(request, headers, static_cast<DWORD>(-1),
                                       const_cast<char*>(body.data()),
                                       static_cast<DWORD>(body.size()),
                                       static_cast<DWORD>(body.size()), 0);
                    g_http.ReceiveResponse(request, nullptr);
                    g_http.Close(request);
                }
                g_http.Close(connect);
            }
            g_http.Close(session);
        }

        void FlushOnce()
        {
            std::vector<std::string> batch;
            size_t dropped = 0;
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                if (!g_queue.empty())
                {
                    batch.assign(g_queue.begin(), g_queue.end());
                    g_queue.clear();
                }
                dropped = g_dropped;
                g_dropped = 0;
            }

            if (dropped > 0)
                batch.push_back("[cobalt] log queue overflowed, dropped " + std::to_string(dropped) + " line(s)");

            std::string status;
            bool healthy = true, sendStatus = false;
            {
                std::lock_guard<std::mutex> lock(g_statusMutex);
                if (g_statusDirty)
                {
                    status = g_status;
                    healthy = g_statusHealthy;
                    g_statusDirty = false;
                    sendStatus = true;
                }
            }

            if (batch.empty() && !sendStatus)
                return;

            // One file open for the whole batch.
            if (!batch.empty())
            {
                std::string blob;
                for (const auto& line : batch)
                    blob += Timestamp() + " " + line + "\r\n";
                AppendToFile(blob);
            }

            std::string body = "{\"source\":\"cobalt\",\"entries\":[";
            for (size_t i = 0; i < batch.size(); ++i)
            {
                if (i) body += ',';
                body += "{\"level\":\"info\",\"msg\":\"" + JsonEscape(batch[i]) + "\"}";
            }
            body += "]";
            if (sendStatus)
            {
                body += ",\"status\":{\"text\":\"" + JsonEscape(status) + "\",\"healthy\":";
                body += healthy ? "true" : "false";
                body += "}";
            }
            body += "}";

            PostBatch(body);
        }

        DWORD WINAPI WriterThread(LPVOID)
        {
            for (;;)
            {
                const DWORD wait = WaitForSingleObject(g_stopEvent, kFlushIntervalMs);
                FlushOnce();
                if (wait == WAIT_OBJECT_0)
                    break;
            }
            return 0;
        }

        //------------------------------------------------------------------------------------------
        //  std::cout -> queue. This is the whole trick: Cobalt's own code is untouched.
        //------------------------------------------------------------------------------------------
        class QueueStreamBuf : public std::streambuf
        {
        public:
            int_type overflow(int_type ch) override
            {
                if (ch == traits_type::eof())
                    return traits_type::not_eof(ch);

                const char c = static_cast<char>(ch);
                std::lock_guard<std::mutex> lock(m_mutex);

                if (c == '\n')
                {
                    if (!m_line.empty())
                    {
                        WriteLine(m_line);
                        m_line.clear();
                    }
                }
                else if (c != '\r')
                {
                    if (m_line.size() < 2000)       // never let one runaway line grow unbounded
                        m_line += c;
                }
                return ch;
            }

            std::streamsize xsputn(const char* s, std::streamsize count) override
            {
                for (std::streamsize i = 0; i < count; ++i)
                    overflow(traits_type::to_int_type(s[i]));
                return count;
            }

        private:
            std::mutex  m_mutex;    // std::cout is written from several game threads
            std::string m_line;
        };

        // Function-local static: constructed on first use, and never destroyed before the process
        // ends, so a late std::cout write during shutdown cannot touch a dead object.
        QueueStreamBuf& Buf()
        {
            static QueueStreamBuf buf;
            return buf;
        }
    }

    void Init()
    {
        if (InterlockedCompareExchange(&g_initialised, 1, 0) != 0)
            return;

        g_logFilePath = ResolveLogPath();
        AppendToFile("\r\n==== Cobalt starting (" __DATE__ " " __TIME__ ") ====\r\n");

        g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (HANDLE t = CreateThread(nullptr, 0, WriterThread, nullptr, 0, nullptr))
            CloseHandle(t);

        // Everything Cobalt already prints now lands in the queue instead of a console window.
        std::cout.rdbuf(&Buf());
    }

    void Shutdown()
    {
        if (g_initialised == 0)
            return;

        if (g_stopEvent)
            SetEvent(g_stopEvent);

        // No thread join: Shutdown runs from DLL_PROCESS_DETACH under the loader lock, and the
        // writer thread needs that same lock to exit. Flush to file synchronously instead.
        std::vector<std::string> remaining;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            remaining.assign(g_queue.begin(), g_queue.end());
            g_queue.clear();
        }
        std::string blob;
        for (const auto& line : remaining)
            blob += Timestamp() + " " + line + "\r\n";
        blob += "==== Cobalt unloaded ====\r\n";
        AppendToFile(blob);
    }

    void WriteLine(std::string line)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (g_queue.size() >= kMaxQueued)
        {
            g_queue.pop_front();
            ++g_dropped;
        }
        g_queue.push_back(std::move(line));
    }

    void SetStatus(std::string status, bool healthy)
    {
        std::lock_guard<std::mutex> lock(g_statusMutex);
        g_status = std::move(status);
        g_statusHealthy = healthy;
        g_statusDirty = true;
    }
}
