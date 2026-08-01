
#include <Windows.h>
#include <iostream>
#include <detours.h>
#include "log.h"
#include "curlhook.h"
#include "exithook.h"
#include <MinHook/MinHook.h>

#define DetoursEasy(address, hook) \
	DetourTransactionBegin(); \
    DetourUpdateThread(GetCurrentThread()); \
    DetourAttach(reinterpret_cast<void**>(&address), hook); \
    DetourTransactionCommit();

void returnNone() { return; }

auto FindPushWidget()
{
    // OnlinePresence call
    auto pattern = sigscan("48 89 5C 24 ? 48 89 6C 24 ? 48 89 74 24 ? 57 48 83 EC 30 48 8B E9 49 8B D9 48 8D 0D ? ? ? ? 49 8B F8 48 8B F2 E8 ? ? ? ? 4C 8B CF 48 89 5C 24 ? 4C 8B C6 48 8B D5 48 8B 48 78");

    if (!pattern)
        pattern = sigscan("48 8B C4 4C 89 40 18 48 89 50 10 48 89 48 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D 68 B8 48 81 EC ? ? ? ? 65 48 8B 04 25"); // 26.00+ or sum

    if (!pattern)
        pattern = sigscan("48 8B C4 48 89 58 10 48 89 70 18 48 89 78 20 55 41 56 41 57 48 8D 68 A1 48 81 EC ? ? ? ? 65 48 8B 04 25 ? ? ? ? 48 8B F9 B9 ? ? ? ? 49"); // 28.00+ or sum

    return pattern;
}

/**
 * Are these five bytes `mov [rsp+8], rcx` — the first-argument spill that opens curl_easy_setopt?
 *
 * Lives in its own function because __try cannot be used where C++ objects need unwinding, and the
 * caller builds strings. The SEH is not decoration: this reads memory computed by subtracting from a
 * scan result, and if that lands outside a mapped page the alternative to catching it is faulting
 * inside the game. An unreadable address means "unconfirmed", which makes the caller fall back
 * rather than patch.
 */
static bool IsRcxSpill(const unsigned char* p)
{
    static const unsigned char kRcxSpill[5] = { 0x48, 0x89, 0x4C, 0x24, 0x08 };
    __try {
        for (int i = 0; i < 5; ++i)
            if (p[i] != kRcxSpill[i]) return false;
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

/** Copy `n` bytes safely; returns false if the range is not readable. */
static bool SafeRead(const unsigned char* src, unsigned char* dst, int n)
{
    __try {
        for (int i = 0; i < n; ++i) dst[i] = src[i];
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

/**
 * Find the start of the function containing `inner`, by walking back to MSVC's inter-function padding.
 *
 * The scan signature matches partway into curl_easy_setopt, and a fixed -5 offset was a guess that
 * turned out wrong on the real build ("could not confirm the function entry" in a player's log). This
 * asks the binary instead of assuming: MSVC pads between functions with int3 (0xCC), so the first
 * byte after the last run of padding IS the entry. That works regardless of how the prologue happens
 * to be encoded, which is exactly the assumption that failed last time.
 *
 * Bounded to 64 bytes because a prologue is short; anything further back means the layout is not what
 * is expected and guessing would be worse than falling back. Returns nullptr when unsure — every
 * caller treats that as "do not patch".
 */
static const unsigned char* FindFunctionEntry(const unsigned char* inner)
{
    unsigned char buf[64];
    if (!SafeRead(inner - 64, buf, 64)) return nullptr;
    // buf[63] is the byte immediately before `inner`. Walk backwards for padding.
    for (int i = 63; i >= 0; --i) {
        if (buf[i] == 0xCC) {
            const unsigned char* entry = inner - 64 + i + 1;
            // Padding directly against the scan point would mean the scan IS the entry, which
            // contradicts the signature. Treat that as unsure rather than hooking a boundary.
            return (entry < inner) ? entry : nullptr;
        }
    }
    return nullptr;
}

void Hook(void* Target, void* Detour)
{
#ifdef USE_MINHOOK
    MH_CreateHook(Target, Detour, nullptr);
    MH_EnableHook(Target);
#else
    Memcury::VEHHook::AddHook(Target, Detour);
#endif
}

bool FixMemoryLeak() // 8.51
{
    auto memoryleak = sigscan("4C 8B DC 55 57 41 56 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 48 8B 01 41 B6");

    if (!memoryleak)
    {
        return false;
    }

    Hook((void*)memoryleak, returnNone);
    return true;
}

void InitializeEOSCurlHook()
{
}

bool InitializeCurlHook()
{
    auto CurlEasySetOptAddr = sigscan("89 54 24 10 4C 89 44 24 18 4C 89 4C 24 20 48 83 EC 28 48 85 C9 75 08 8D 41 2B 48 83 C4 28 C3 4C");

    if (!CurlEasySetOptAddr)
    {
        std::cout << "Fallback!\n";

        while (!CurlEasySetOptAddr)
        {
            CurlEasySetOptAddr = sigscan("89 54 24 10 4C 89 44 24 18 4C 89 4C 24 20 48 83 EC 28 48 85 C9 75 08 8D 41 2B 48 83 C4 28 C3 4C");
            Sleep(200);
        }
    }

    if (!CurlEasySetOptAddr) // impossibel ol
    {
        std::cout << "Failed to find CurlEasySetOptAddr!\n";
        return false;
    }

    auto CurlSetOptAddr = sigscan("48 89 5C 24 08 48 89 6C 24 10 48 89 74 24 18 57 48 83 EC 30 33 ED 49 8B F0 48 8B D9");

    if (!CurlSetOptAddr)
    {
        CurlSetOptAddr = sigscan("48 89 5C 24 08 48 89 6C 24 10 56 57 41 56 48 83 EC 50 33 ED 49 8B F0 8B DA 48 8B F9");

        if (!CurlSetOptAddr)
            CurlSetOptAddr = sigscan("48 89 5C 24 ? 55 56 57 41 56 41 57 48 83 EC 50 33 DB 49 8B F0 48 8B F9 8B EB 81 FA"); // tested 28.00 // fixed crash
    }

    if (!CurlSetOptAddr)
    {
        std::cout << "Failed to find CurlSetOptAddr! But we will go ahead..\n";
    }

    CurlEasySetOpt = decltype(CurlEasySetOpt)(CurlEasySetOptAddr);
    CurlSetOpt = decltype(CurlSetOpt)(CurlSetOptAddr);

    // ── THE CURL HOOK MUST BE INLINE, NOT VEH ────────────────────────────────────────────────────
    //
    // This used to pick a hooking method based on FindPushWidget(). On 7.40 that signature never
    // matches — every startup logs "Failed to find PushWidget (This may be fine)!" — so it always
    // took the VEH path. And a VEH hook here is not merely slower, it is WRONG:
    //
    //   • VEHHook arms a PAGE_GUARD on the target. PAGE_GUARD is a ONE-SHOT alarm: the kernel clears
    //     the guard bit the moment it raises the exception, so from that instant the function is
    //     unhooked.
    //   • The guard bit lives in the PAGE TABLE, not the thread. Clearing it unhooks the function
    //     for EVERY thread in the process at once.
    //   • Re-arming is deferred to a second exception (STATUS_SINGLE_STEP) on the faulting thread.
    //     If that thread is descheduled in between, the hole stays open for a scheduler quantum.
    //   • The guard covers the whole 4KB page, so every call to any neighbouring libcurl function
    //     also knocks it down.
    //
    // UE4 issues ~25-30 curl_easy_setopt calls per request from more than one thread, and Fortnite
    // fetches its four hotfix .ini files back-to-back in the same millisecond. Any call landing in
    // one of those holes runs the REAL curl_easy_setopt, so its URL is never rewritten and it leaves
    // the machine for Epic's live servers.
    //
    // Observed exactly once in a four-file batch: three files were redirected and logged, the fourth
    // (DefaultRuntimeOptions.ini) was not logged at all and came back 401 "Token is missing key ID
    // value" — Epic's own error text, from Epic's own servers. UE4 discards the ENTIRE hotfix batch
    // when one file fails, so that single escaped request threw away the other three and left the
    // client on its built-in XMPP address, which ends in "Fortnite was not started correctly".
    //
    // ── RESOLVE THE TRUE FUNCTION ENTRY, THEN HOOK IT INLINE ─────────────────────────────────────
    //
    // The signature above deliberately does not match the start of curl_easy_setopt. It matches the
    // variadic home-register spill, which begins at the SECOND argument:
    //
    //     48 89 4C 24 08     mov  [rsp+8],  rcx      <-- the REAL entry (arg 1, the CURL*)
    //     89 54 24 10        mov  [rsp+10], edx      <-- the scan matches HERE (arg 2, an int)
    //     4C 89 44 24 18     mov  [rsp+18], r8       <-- arg 3
    //     4C 89 4C 24 20     mov  [rsp+20], r9       <-- arg 4
    //     48 83 EC 28        sub  rsp, 28
    //
    // In the x64 calling convention rcx/rdx/r8/r9 carry the first four arguments, and a variadic
    // function spills them to their home slots so va_start can walk them. `mov [rsp+8], rcx` is
    // exactly five bytes, so the entry is scanned_address - 5. CURLoption is an int, which is why
    // its spill uses edx and is one byte shorter than the others.
    //
    // 1.4.3 hooked the scanned address inline and hard-crashed the game while loading the Frontend
    // map: an inline hook writes a five-byte jump and builds a trampoline from wherever it is
    // pointed, so pointing it mid-prologue corrupts the function. A VEH page-guard hook tolerated
    // that only because it compares RIP rather than patching code.
    //
    // But VEH is not a safe resting place either. PAGE_GUARD is a ONE-SHOT alarm: the kernel clears
    // the guard bit when it fires, which unhooks the function for EVERY thread until a second
    // exception re-arms it. UE4 issues ~25-30 curl_easy_setopt calls per request across threads, and
    // any call landing in that window runs the real function, so its URL is never rewritten and the
    // request leaves for Epic's live servers. Observed repeatedly: a hotfix file 401ing and taking
    // the whole batch down, and later ReadFriendsList/QueryBlockedPlayers 401ing with Epic's own
    // "Token is missing key ID value" — each ending in "Fortnite was not started correctly".
    //
    // So: verify the entry before trusting it. If the five bytes are not the exact rcx spill, do NOT
    // patch — fall back to VEH, which is unreliable but never corrupts anything. A wrong guess here
    // crashes on a player's machine, so it has to be checked rather than assumed.
    const unsigned char* scan = reinterpret_cast<const unsigned char*>(CurlEasySetOptAddr);

    // Log what is actually there. The -5 guess was wrong on the real build and the log only said
    // "could not confirm", which left nothing to work from. Print the bytes so a single player log
    // is enough to settle the encoding, instead of another round of inference.
    {
        unsigned char pre[24];
        if (SafeRead(scan - 24, pre, 24)) {
            std::cout << "Curl hook: 24 bytes before scan point:";
            for (int i = 0; i < 24; ++i) {
                char b[8];
                sprintf_s(b, " %02X", pre[i]);
                std::cout << b;
            }
            std::cout << '\n';
        }
    }

    // Two ways to locate the entry, most reliable first.
    const unsigned char* entry = FindFunctionEntry(scan);
    if (entry) {
        std::cout << "Curl hook: entry via int3 padding, " << (int)(scan - entry) << " bytes back.\n";
    }
    else if (IsRcxSpill(scan - 5)) {
        // The textbook variadic prologue. Kept as a second chance in case padding is absent.
        entry = scan - 5;
        std::cout << "Curl hook: entry via rcx-spill prologue, 5 bytes back.\n";
    }

    if (entry) {
        void* target = const_cast<unsigned char*>(entry);
        if (MH_CreateHook(target, CurlEasySetOptDetour, nullptr) == MH_OK
            && MH_EnableHook(target) == MH_OK)
        {
            std::cout << "Curl hook: inline at function entry (no race).\n";
        }
        else
        {
            std::cout << "Curl hook: MinHook refused the entry — falling back to VEH.\n";
            Hook(CurlEasySetOpt, CurlEasySetOptDetour);
        }
    }
    else {
        // Different compiler output than expected. Do not guess at an offset — take the unreliable
        // hook over a corrupted function.
        std::cout << "Curl hook: could not confirm the function entry — falling back to VEH.\n";
        Hook(CurlEasySetOpt, CurlEasySetOptDetour);
    }

    return true;
}

void InitializeExitHook()
{
    if (!FindPushWidget())
    {
        std::cout << "Failed to find PushWidget (This may be fine)!\n";

        /*
        auto RequestExitWithStatusAddr = sigscan("40 53 48 83 EC 40 80 3D ? ? ? ? ? 0F B6 D9 72 3A 48 8B 05"); // S9

        std::cout << "RequestExitWithStatusAddr: " << RequestExitWithStatusAddr << '\n';

        RequestExitWithStatus = decltype(RequestExitWithStatus)(RequestExitWithStatusAddr);
        Memcury::VEHHook::AddHook(RequestExitWithStatus, RequestExitWithStatusHook);

        auto UnsafeEnvironmentPopupAddr = sigscan("4C 8B DC 55 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 49 89 73 E8 33 F6 49 89 7B E0 0F B6 FA"); // S9

        std::cout << "UnsafeEnvironmentPopupAddr: " << UnsafeEnvironmentPopupAddr << '\n';

        UnsafeEnvironmentPopup = decltype(UnsafeEnvironmentPopup)(UnsafeEnvironmentPopupAddr);
        Memcury::VEHHook::AddHook(UnsafeEnvironmentPopup, UnsafeEnvironmentPopupHook);

        auto RequestExitAddrs = Memcury::Scanner::FindPatterns("40 53 48 83 EC 30 80 3D ? ? ? ? ? 0F B6 D9 72 33 48 8B 05 ? ? ? ? 4C 8D 44 24 ? 48 89 44 24 ? 41 B9 ? ? ? ? 0F"); // S9

        std::cout << "RequestExitAddrs: " << RequestExitAddrs.size() << '\n';

        for (auto RequestExitAddr : RequestExitAddrs)
        {
            RequestExit = decltype(RequestExit)(Memcury::Scanner(RequestExitAddr).Get());
            Memcury::VEHHook::AddHook(RequestExit, RequestExitHook);
        }
        */


        return;
    }

    auto UnsafeEnvironmentPopupAddr = sigscan("4C 8B DC 55 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 49 89 73 F0 49 89 7B E8 48 8B F9 4D 89 63 E0 4D 8B E0 4D 89 6B D8");

    if (!UnsafeEnvironmentPopupAddr)
    {
        UnsafeEnvironmentPopupAddr = sigscan("4C 8B DC 55 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ?");

        if (!UnsafeEnvironmentPopupAddr)
            UnsafeEnvironmentPopupAddr = sigscan("48 89 5C 24 ? 55 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 80 B9 ? ? ? ? ? 48 8B DA 48 8B F1");
    }

    if (!UnsafeEnvironmentPopupAddr)
    {
        std::cout << "Failed to find UnsafeEnvironmentPopupAddr (This may be fine)!\n";
    }

    // probably unnneeeded
    auto RequestExitWithStatusAddr = sigscan("48 89 5C 24 ? 57 48 83 EC 40 41 B9 ? ? ? ? 0F B6 F9 44 38 0D ? ? ? ? 0F B6 DA 72 24 89 5C 24 30 48 8D 05 ? ? ? ? 89 7C 24 28 4C 8D 05 ? ? ? ? 33 D2 48 89 44 24 ? 33 C9 E8 ? ? ? ?");

    if (!RequestExitWithStatusAddr)
    {
        RequestExitWithStatusAddr = sigscan("48 8B C4 48 89 58 18 88 50 10 88 48 08 57 48 83 EC 30"); // ion know whta version this for

        if (!RequestExitWithStatusAddr)
            RequestExitWithStatusAddr = sigscan("4C 8B DC 49 89 5B 08 49 89 6B 10 49 89 73 18 49 89 7B 20 41 56 48 83 EC 30 80 3D ? ? ? ? ? 49 8B"); // dk how often this change
    }

    if (!RequestExitWithStatusAddr)
    {
        std::cout << "Failed to find RequestExitWithStatusAddr (This may be fine)!\n";
    }

    DetoursEasy(UnsafeEnvironmentPopupAddr, UnsafeEnvironmentPopupHook);
    DetoursEasy(RequestExitWithStatusAddr, RequestExitWithStatusHook);
}

DWORD WINAPI Main(LPVOID)
{
    // Was: AllocConsole() + freopen on CONOUT$, which opened a second console window next to the
    // game. This redirects std::cout to the launcher's Logs tab and to a log file instead. Nothing
    // else in Cobalt changes — every std::cout below still works exactly as before.
    Cobalt::Log::Init();

#ifndef URL_HOST // todo staticassert?
    std::cout << "\n\n\n!!!!!!! URL_HOST IS NOT DEFINED !!!!!!!\n\n\n\n";
#else
    std::cout << "Redirecting to " << URL_PROTOCOL << "://" << URL_HOST << ":" << URL_PORT << '\n';
#endif

    std::cout << "Initializing Cobalt (made by Milxnor#3531).\n";

    std::cout << "Credits:\n\n";

    std::cout << "Memcury - https://github.com/kem0x/Memcury\n";
    std::cout << "Neonite++ for most of the signatures and curl hook - https://github.com/PeQuLeaks/NeonitePP-Fixed/tree/1.4\n\n";

    // BOTH engines come up, deliberately — this block used to pick one via USE_MINHOOK.
    //
    // MinHook is now required unconditionally: the curl hook has to be an INLINE hook, and nothing
    // else will do (see InitializeCurlHook for the full reasoning).
    //
    // VEH still has to be initialised too, because Hook() falls through to VEHHook::AddHook and
    // FixMemoryLeak() still goes through Hook(). That one is an 8.51 signature which does not match
    // on 7.40, so in practice it installs nothing here — but it is live code, and leaving VEH
    // uninitialised would arm a hook against a handler that was never registered the moment anyone
    // runs this on a build where the signature DOES match.
    //
    // The exit hooks are not affected either way: they use DetoursEasy. The VEHHook::AddHook calls
    // alongside them are inside a /* */ block and have not been live.
    MH_Initialize();
    Memcury::VEHHook::Init();

    bool curlResult = InitializeCurlHook();
    InitializeEOSCurlHook();
    InitializeExitHook();

    bool result = curlResult;

    if (result)
    {
        std::cout << "Cobalt v0.1 initialized sucessfully.\n";
        Cobalt::Log::SetStatus("active - redirecting to " URL_PROTOCOL "://" URL_HOST ":" URL_PORT, true);
    }
    else
    {
        Cobalt::Log::SetStatus("failed to initialise - the game will not reach the Nova backend", false);
        MessageBoxA(0, "Failed to initialize!", "Cobalt", MB_ICONERROR);
    }

#if 0
    Sleep(3000);

    if (!FixMemoryLeak())
    {
        std::cout << "Failed to apply memory leak fix (this may be fine)!\n";
    }
    else
    {
        std::cout << "Applied memory leak fix!\n";
    }
#endif

    return 0;
}

BOOL APIENTRY DllMain( HMODULE hModule,
                       DWORD  ul_reason_for_call,
                       LPVOID lpReserved
                     )
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        CreateThread(0, 0, Main, 0, 0, 0);
        break;
    case DLL_PROCESS_DETACH:
        break;
    }
    return TRUE;
}

