#include "diagnostics.h"

// Cobalt defines these in settings.h. Reboot has no such header, and this file is shared verbatim
// between the two projects, so pick them up if present and fall back otherwise. The destination is
// the same either way: the local Nova endpoint on this machine, never a remote one.
#if __has_include("settings.h")
#include "settings.h"
#endif

#ifndef COBALT_BACKEND_HOST_W
#define COBALT_BACKEND_HOST_W L"127.0.0.1"
#endif
#ifndef COBALT_BACKEND_PORT_N
#define COBALT_BACKEND_PORT_N 3551
#endif

#include <Windows.h>
// Types only. As in log.cpp, every WinHttp call goes through a GetProcAddress pointer so that
// winhttp.dll never becomes a load-time dependency of this DLL — Cobalt is loaded via the game's
// import table as GFSDK_Aftermath_Lib.x64.dll and its dependency list must stay as small as the
// original's.
#include <winhttp.h>

#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace Nova::Diag
{
    namespace
    {
        //------------------------------------------------------------------------------------------
        //  Bounds. Every one of these is reachable from a failure loop inside the game, so each is a
        //  hard cap rather than a target.
        //------------------------------------------------------------------------------------------
        constexpr size_t kMaxDistinctProblems = 64;    // rows, not events — repeats increment a count
        constexpr size_t kMaxUrlChars         = 256;
        constexpr size_t kMaxDetailChars      = 200;
        constexpr DWORD  kFlushIntervalMs     = 30'000; // aggregates; nobody needs these sooner
        constexpr DWORD  kHttpTimeoutMs       = 4'000;

        struct Row
        {
            Source      source;
            Category    category;
            std::string method;
            std::string url;
            int         status = 0;
            std::string detail;
            std::string correlationId;
            unsigned    count = 0;
        };

        std::mutex                  g_mutex;
        std::map<std::string, Row>  g_rows;
        size_t                      g_droppedDistinct = 0;

        std::string   g_component = "cobalt";
        std::string   g_build     = "unknown";
        HANDLE        g_stopEvent = nullptr;
        volatile LONG g_initialised = 0;

        // Per-thread, so a correlation id set inside one request's hook cannot leak into another
        // thread's unrelated report.
        thread_local std::string t_correlationId;

        const char* SourceName(Source s)
        {
            switch (s)
            {
            case Source::Client:  return "CLIENT";
            case Source::Host:    return "HOST";
            case Source::Network: return "NETWORK";
            case Source::Version: return "VERSION";
            }
            return "CLIENT";
        }

        const char* CategoryName(Category c)
        {
            switch (c)
            {
            case Category::Missing:            return "MISSING";
            case Category::Failed:             return "FAILED";
            case Category::Timeout:            return "TIMEOUT";
            case Category::AuthFailure:        return "AUTH_FAILURE";
            case Category::InvalidResponse:    return "INVALID_RESPONSE";
            case Category::UnexpectedState:    return "UNEXPECTED_STATE";
            case Category::NetworkFailure:     return "NETWORK_FAILURE";
            case Category::VersionMismatch:    return "VERSION_MISMATCH";
            case Category::SessionFailure:     return "SESSION_FAILURE";
            case Category::MatchmakingFailure: return "MATCHMAKING_FAILURE";
            case Category::PartyFailure:       return "PARTY_FAILURE";
            case Category::Crash:              return "CRASH";
            case Category::Unknown:            return "UNKNOWN";
            }
            return "UNKNOWN";
        }

        /// Minimal JSON string escaping. Control characters are dropped rather than escaped — none
        /// belong in a URL or a detail line, and dropping them keeps this small.
        std::string JsonEscape(const std::string& in)
        {
            std::string out;
            out.reserve(in.size() + 8);
            for (const char ch : in)
            {
                switch (ch)
                {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                default:
                    if (static_cast<unsigned char>(ch) >= 0x20)
                        out += ch;
                    break;
                }
            }
            return out;
        }

        bool StartsWithAt(const std::string& s, size_t pos, const char* needle)
        {
            const size_t n = strlen(needle);
            return s.size() >= pos + n && s.compare(pos, n, needle) == 0;
        }
    }

    //--------------------------------------------------------------------------------------------
    //  REDACTION
    //
    //  Cobalt hooks the function that sets curl's URL, so it sees bearer tokens as a matter of
    //  course — 7.40 ends every session with `DELETE .../sessions/kill/eg1~<jwt>`. Anything queued
    //  here could otherwise carry a live credential off the machine.
    //
    //  Deliberately simple and conservative: no regex engine (that would be another dependency and
    //  another way to be slow on a game thread), and it errs towards cutting too much. The backend
    //  redacts again on receipt, so a miss here is caught there — two layers, because the cost of
    //  one credential reaching a database is not worth a clever single implementation.
    //--------------------------------------------------------------------------------------------
    std::string Redact(const std::string& text)
    {
        std::string out;
        out.reserve(text.size());

        auto isTokenChar = [](char c) {
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                   c == '.' || c == '_' || c == '-' || c == '~' || c == '+' || c == '/' || c == '=';
        };

        static const char* kSecretParams[] = {
            "access_token=", "refresh_token=", "token=", "password=",
            "secret=", "code=", "authkey=", "auth_key=",
        };

        for (size_t i = 0; i < text.size();)
        {
            // `eg1~<jwt>` — Epic session tokens, which appear in the URL PATH on this build.
            if (StartsWithAt(text, i, "eg1~"))
            {
                out += "eg1~<redacted>";
                i += 4;
                while (i < text.size() && isTokenChar(text[i])) ++i;
                continue;
            }
            // A bare JWT: three base64url segments starting `eyJ`.
            if (StartsWithAt(text, i, "eyJ"))
            {
                size_t j = i;
                int dots = 0;
                while (j < text.size() && isTokenChar(text[j]))
                {
                    if (text[j] == '.') ++dots;
                    ++j;
                }
                if (dots >= 2)
                {
                    out += "<redacted-jwt>";
                    i = j;
                    continue;
                }
            }
            // `?secret=value` / `&password=value`
            //
            // The preceding character MUST be a query separator. Without that check `code=` matched
            // anywhere, and the string Reboot emits for a crashed gameserver —
            // `Gameserver exited (code=3221225477)` — was redacted to `(code=<redacted>`, destroying
            // the single most useful host diagnostic in the project. Caught by test_redact, not by
            // reading the code.
            //
            // Over-redaction is a real cost, not a safe default: a diagnostic that has had the
            // interesting part removed is worth nothing, and the backend redacts again on receipt,
            // so a narrow rule here still has a second layer behind it.
            const bool atQueryParam = (i > 0) && (text[i - 1] == '?' || text[i - 1] == '&');
            bool matchedParam = false;
            for (const char* param : kSecretParams)
            {
                if (atQueryParam && StartsWithAt(text, i, param))
                {
                    out += param;
                    out += "<redacted>";
                    i += strlen(param);
                    while (i < text.size() && text[i] != '&' && text[i] != ' ') ++i;
                    matchedParam = true;
                    break;
                }
            }
            if (matchedParam) continue;

            out += text[i];
            ++i;
        }
        return out;
    }

    std::string NewCorrelationId()
    {
        // Not derived from anything identifying — a counter plus the tick count is enough to join
        // records within one session, which is all a correlation id needs to do.
        static volatile LONG counter = 0;
        const LONG n = InterlockedIncrement(&counter);
        char buf[32];
        _snprintf_s(buf, sizeof(buf), _TRUNCATE, "NV-%08lX%04lX",
                    static_cast<unsigned long>(GetTickCount()), static_cast<unsigned long>(n & 0xFFFF));
        return buf;
    }

    void SetCorrelationId(const std::string& id)
    {
        t_correlationId = id.substr(0, 64);
    }

    void Report(Source source, Category category, const char* method, const std::string& url,
                int status, const std::string& detail)
    {
        if (g_initialised == 0)
            return;

        // Redact and truncate BEFORE the lock, so the critical section stays as short as possible —
        // this can be called from the curl hook on the game's own threads.
        std::string safeUrl = Redact(url);
        if (safeUrl.size() > kMaxUrlChars) safeUrl.resize(kMaxUrlChars);
        std::string safeDetail = Redact(detail);
        if (safeDetail.size() > kMaxDetailChars) safeDetail.resize(kMaxDetailChars);

        const char* methodName = method ? method : "GET";
        std::string key = std::string(SourceName(source)) + '|' + CategoryName(category) + '|' +
                          methodName + '|' + safeUrl;

        std::lock_guard<std::mutex> lock(g_mutex);

        auto it = g_rows.find(key);
        if (it != g_rows.end())
        {
            ++it->second.count;
            if (status) it->second.status = status;
            return;
        }

        // At capacity: count the drop rather than evicting something that may be the interesting
        // one. The counter itself is reported, so the gap is visible instead of silent.
        if (g_rows.size() >= kMaxDistinctProblems)
        {
            ++g_droppedDistinct;
            return;
        }

        Row row;
        row.source = source;
        row.category = category;
        row.method = methodName;
        row.url = std::move(safeUrl);
        row.status = status;
        row.detail = std::move(safeDetail);
        row.correlationId = t_correlationId;
        row.count = 1;
        g_rows.emplace(std::move(key), std::move(row));
    }

    namespace
    {
        /// Drain the aggregate into a JSON body. Returns empty when there is nothing to send.
        std::string BuildBody()
        {
            std::map<std::string, Row> rows;
            size_t dropped = 0;
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                if (g_rows.empty() && g_droppedDistinct == 0)
                    return {};
                rows.swap(g_rows);
                dropped = g_droppedDistinct;
                g_droppedDistinct = 0;
            }

            std::string body = "{\"events\":[";
            bool first = true;
            for (const auto& [key, row] : rows)
            {
                if (!first) body += ',';
                first = false;
                body += "{\"source\":\"";
                body += SourceName(row.source);
                body += "\",\"category\":\"";
                body += CategoryName(row.category);
                body += "\",\"method\":\"" + JsonEscape(row.method);
                body += "\",\"url\":\"" + JsonEscape(row.url);
                body += "\",\"component\":\"" + JsonEscape(g_component);
                body += "\",\"build\":\"" + JsonEscape(g_build);
                body += "\",\"count\":" + std::to_string(row.count);
                if (row.status) body += ",\"status\":" + std::to_string(row.status);
                if (!row.detail.empty()) body += ",\"detail\":\"" + JsonEscape(row.detail) + "\"";
                if (!row.correlationId.empty())
                    body += ",\"correlationId\":\"" + JsonEscape(row.correlationId) + "\"";
                body += '}';
            }

            // Report our own overflow as an event, so "we stopped counting" is visible in the same
            // place as everything else rather than being invisible.
            if (dropped > 0)
            {
                if (!first) body += ',';
                body += "{\"source\":\"CLIENT\",\"category\":\"UNEXPECTED_STATE\",\"method\":\"DIAG\","
                        "\"url\":\"/diagnostics/overflow\",\"component\":\"" + JsonEscape(g_component) +
                        "\",\"build\":\"" + JsonEscape(g_build) +
                        "\",\"count\":" + std::to_string(dropped) +
                        ",\"detail\":\"local diagnostic table full; distinct problems dropped\"}";
            }

            body += "]}";
            return body;
        }

        void PostBody(const std::string& body)
        {
            if (body.empty())
                return;

            HMODULE module = LoadLibraryW(L"winhttp.dll");
            if (!module) return;

            auto open    = reinterpret_cast<decltype(&WinHttpOpen)>(GetProcAddress(module, "WinHttpOpen"));
            auto connect = reinterpret_cast<decltype(&WinHttpConnect)>(GetProcAddress(module, "WinHttpConnect"));
            auto openReq = reinterpret_cast<decltype(&WinHttpOpenRequest)>(GetProcAddress(module, "WinHttpOpenRequest"));
            auto send    = reinterpret_cast<decltype(&WinHttpSendRequest)>(GetProcAddress(module, "WinHttpSendRequest"));
            auto recv    = reinterpret_cast<decltype(&WinHttpReceiveResponse)>(GetProcAddress(module, "WinHttpReceiveResponse"));
            auto timeouts= reinterpret_cast<decltype(&WinHttpSetTimeouts)>(GetProcAddress(module, "WinHttpSetTimeouts"));
            auto close   = reinterpret_cast<decltype(&WinHttpCloseHandle)>(GetProcAddress(module, "WinHttpCloseHandle"));
            if (!open || !connect || !openReq || !send || !recv || !close)
                return;

            if (HINTERNET session = open(L"Nova-Diagnostics", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                         WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0))
            {
                if (timeouts) timeouts(session, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs);

                if (HINTERNET conn = connect(session, COBALT_BACKEND_HOST_W, COBALT_BACKEND_PORT_N, 0))
                {
                    // The LOCAL endpoint, deliberately. This component holds no credential and must
                    // not: the launcher forwards these upstream with its own token. See the route's
                    // comment in diagnostics.routes.ts.
                    if (HINTERNET request = openReq(conn, L"POST", L"/nova/api/diagnostics/local",
                                                    nullptr, WINHTTP_NO_REFERER,
                                                    WINHTTP_DEFAULT_ACCEPT_TYPES, 0))
                    {
                        static const wchar_t* kHeaders = L"Content-Type: application/json\r\n";
                        send(request, kHeaders, static_cast<DWORD>(-1),
                             const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                             static_cast<DWORD>(body.size()), 0);
                        // The response is irrelevant. If the backend is down, this is a no-op and the
                        // aggregate simply starts again — telemetry must never be a hard dependency.
                        recv(request, nullptr);
                        close(request);
                    }
                    close(conn);
                }
                close(session);
            }
        }

        DWORD WINAPI FlushThread(LPVOID)
        {
            for (;;)
            {
                const DWORD wait = WaitForSingleObject(g_stopEvent, kFlushIntervalMs);
                PostBody(BuildBody());
                if (wait == WAIT_OBJECT_0)
                    return 0;
            }
        }
    }

    void Init(const char* component, const char* build)
    {
        if (InterlockedCompareExchange(&g_initialised, 1, 0) != 0)
            return;

        if (component) g_component = component;
        if (build)     g_build = build;

        g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (HANDLE thread = CreateThread(nullptr, 0, FlushThread, nullptr, 0, nullptr))
            CloseHandle(thread);
    }

    void Shutdown()
    {
        if (g_initialised == 0)
            return;
        if (g_stopEvent)
            SetEvent(g_stopEvent);
        // One synchronous final flush. NOT a thread join: joining from DLL_PROCESS_DETACH deadlocks
        // against the loader lock, which is the same reason log.cpp refuses to.
        PostBody(BuildBody());
    }
}
