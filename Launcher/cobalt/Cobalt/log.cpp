#include "log.h"
#include "settings.h"
#include "diagnostics.h"   // Redact() - see WriteLine

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

        /**
         * A stamp that actually identifies THIS binary.
         *
         * The banner used to read `__DATE__ " " __TIME__`, which is the compile time of **this
         * translation unit** — and log.cpp changes far less often than dllmain.cpp does. So two
         * genuinely different Cobalt builds introduced themselves identically, and a log could not
         * be matched to the binary that produced it. That is `cobalt-stamp-frozen` in KNOWN_ISSUES,
         * and it has already cost time twice: this project's recurring failure is a component being
         * older than everyone assumes, and the banner was the one place that should have said so.
         *
         * The DLL's own last-write time cannot go stale — it changes whenever the linker runs,
         * whichever source file caused it. Falls back to the compile-time macros if the module path
         * or its timestamp cannot be read, since a slightly-wrong stamp still beats none.
         */
        std::string BuildStamp()
        {
            HMODULE self = nullptr;
            if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                       GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                   // Any address inside this DLL identifies it. ResolveLogPath is
                                   // declared just above, so it is in scope and unambiguous.
                                   reinterpret_cast<LPCWSTR>(&ResolveLogPath), &self) && self)
            {
                wchar_t path[MAX_PATH] = {};
                if (GetModuleFileNameW(self, path, MAX_PATH))
                {
                    WIN32_FILE_ATTRIBUTE_DATA fad{};
                    if (GetFileAttributesExW(path, GetFileExInfoStandard, &fad))
                    {
                        SYSTEMTIME st{};
                        FILETIME local{};
                        if (FileTimeToLocalFileTime(&fad.ftLastWriteTime, &local) &&
                            FileTimeToSystemTime(&local, &st))
                        {
                            char buf[40];
                            _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                                        "built %04d-%02d-%02d %02d:%02d:%02d",
                                        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
                            return buf;
                        }
                    }
                }
            }
            return "compiled " __DATE__ " " __TIME__ " (module time unavailable)";
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
        AppendToFile("\r\n==== Cobalt starting (" + BuildStamp() + ") ====\r\n");

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

    /**
     * Queue one line for the log file and the backend upload.
     *
     * ── EVERY LINE IS REDACTED HERE, AND THIS IS THE ONLY PLACE IT NEEDS TO BE ───────────────────
     *
     * `cobalt-logs-bearer-tokens` in KNOWN_ISSUES: Cobalt sees the player's session token as a
     * matter of course — 7.40 puts `eg1~<jwt>` in the URL PATH, and this DLL's whole job is to
     * inspect the URL curl is about to fetch. Those URLs were logged verbatim.
     *
     * The backend half was closed in NOVA-AUDIT-012 (it redacts on ingest, so nothing is stored or
     * served with a live token). What remained was the PLAINTEXT COPY ON DISK, in a file players are
     * routinely asked to send when something breaks — which is exactly the moment a live token gets
     * pasted into a chat.
     *
     * This is the right choke point because it is the ONLY one: `std::cout` is redirected into
     * QueueStreamBuf, which calls WriteLine per line, and both consumers — the file blob and the
     * JSON upload body — are built from the queue this fills. One call covers both.
     *
     * Reusing Nova::Diag::Redact rather than writing a second redactor is deliberate: there is one
     * implementation, `tests/test_redact.cpp` covers it, and two would drift.
     *
     * Redacting BEFORE the lock, matching diagnostics.cpp — it allocates, and the critical section
     * is contended by several game threads.
     */
    void WriteLine(std::string line)
    {
        line = Nova::Diag::Redact(line);

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
