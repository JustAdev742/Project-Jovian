#include "ue4.h"
#include "log.h"

#include <Windows.h>
#include <vector>
#include <atomic>
#include <algorithm>
#include <cstring>
#include <MinHook/MinHook.h>

namespace Nova::UE4
{
    namespace
    {
        // ── The 4.22 patterns, lifted verbatim from Project Reboot ────────────────────────────────
        //
        // `Project Reboot/patterns.h`, the `Engine_Version == 422` block. 7.40 is UE 4.22, and
        // Reboot runs against the same executable, so these are known-good for this build rather
        // than newly derived. Do not "improve" them — if one stops matching, the build changed, and
        // the honest response is to report that (SelfTest does) rather than to loosen the pattern
        // until something matches.
        constexpr const char* kProcessEvent =
            "40 55 56 57 41 54 41 55 41 56 41 57 48 81 EC ? ? ? ? 48 8D 6C 24 ? 48 89 9D ? ? ? ? "
            "48 8B 05 ? ? ? ? 48 33 C5 48 89 85 ? ? ? ? ? ? ? 45 33 F6";
        constexpr const char* kStaticFindObject =
            "48 89 5C 24 ? 48 89 74 24 ? 55 57 41 54 41 56 41 57 48 8B EC 48 83 EC 60 80 3D ? ? ? ? ? 45 0F B6";
        constexpr const char* kObjects =
            "48 8B 05 ? ? ? ? 48 8B 0C C8 48 8B 04 D1";

        /**
         * Pattern scan over the loaded module.
         *
         * Ported from Reboot's `Memory::FindPattern` rather than reusing Cobalt's Memcury, because
         * the `bIsVar` resolution below is exactly what the object-array pattern needs and Memcury
         * expresses it differently. Keeping the arithmetic identical to the code these patterns were
         * proven against removes a whole class of "the pattern is right but the offset maths is not".
         */
        uint64_t FindPattern(const char* signature, bool relative = false, uint32_t offset = 0, bool isVar = false)
        {
            if (!signature || !*signature) return 0;

            const auto base = reinterpret_cast<uint64_t>(GetModuleHandleW(nullptr));
            if (!base) return 0;

            std::vector<int> bytes;
            for (auto p = signature; *p; ++p)
            {
                if (*p == ' ') continue;
                if (*p == '?')
                {
                    if (*(p + 1) == '?') ++p;
                    bytes.push_back(-1);
                }
                else
                {
                    char* end = nullptr;
                    bytes.push_back(static_cast<int>(strtoul(p, &end, 16)));
                    p = end - 1;
                }
            }
            if (bytes.empty()) return 0;

            const auto dos = reinterpret_cast<PIMAGE_DOS_HEADER>(base);
            if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
            const auto nt = reinterpret_cast<PIMAGE_NT_HEADERS>(base + dos->e_lfanew);
            if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;

            const auto size = nt->OptionalHeader.SizeOfImage;
            const auto scan = reinterpret_cast<uint8_t*>(base);
            const auto n = bytes.size();
            const auto data = bytes.data();

            for (uint32_t i = 0; i + n < size; ++i)
            {
                bool found = true;
                for (size_t j = 0; j < n; ++j)
                {
                    if (data[j] != -1 && scan[i + j] != data[j]) { found = false; break; }
                }
                if (!found) continue;

                auto address = reinterpret_cast<uint64_t>(&scan[i]);
                // `isVar`: the match is a RIP-relative load of a global, so follow it to the global.
                if (isVar)          address = address + offset + *reinterpret_cast<int*>(address + 3);
                else if (relative)  address = (address + offset + 4) + *reinterpret_cast<int*>(address + offset);
                return address;
            }
            return 0;
        }

        // ── Engine types, only as far as needed ───────────────────────────────────────────────────
        //
        // UE 4.22 uses FChunkedFixedUObjectArray. Only the fields this reads are declared; the
        // layout beyond NumChunks is not relied on.
        struct FUObjectItem
        {
            void*   Object;
            int32_t Flags;
            int32_t ClusterRootIndex;
            int32_t SerialNumber;
        };

        struct FChunkedFixedUObjectArray
        {
            enum { NumElementsPerChunk = 64 * 1024 };

            FUObjectItem** Objects;
            FUObjectItem*  PreAllocatedObjects;
            int32_t        MaxElements;
            int32_t        NumElements;
            int32_t        MaxChunks;
            int32_t        NumChunks;
        };

        /** UObject's first fields, 4.22. Only what the walk reads. */
        struct UObjectLayout
        {
            void**   VFTable;
            int32_t  ObjectFlags;
            int32_t  InternalIndex;
            void*    ClassPrivate;      // the UClass - what the census filters on
            uint64_t NamePrivate;
            void*    OuterPrivate;
        };

        /** TArray<TCHAR> as FString carries it. */
        struct FStringOut
        {
            wchar_t* Data;
            int32_t  ArrayNum;
            int32_t  ArrayMax;
        };

        using ProcessEventFn    = void  (*)(void*, void*, void*);
        using StaticFindObjectFn = void* (*)(void*, void*, const wchar_t*, bool);

        ProcessEventFn             gProcessEvent = nullptr;
        StaticFindObjectFn         gStaticFindObject = nullptr;
        FChunkedFixedUObjectArray* gObjects = nullptr;

        std::atomic<bool> gInitialised{ false };
        std::atomic<bool> gResolved{ false };

        /** Set when the ProcessEvent detour is live; the trampoline back to the engine's own. */
        bool gHookInstalled = false;
        ProcessEventFn gProcessEventOriginal = nullptr;
    }

    bool Init()
    {
        // Idempotent. Cobalt's startup path may retry this while the engine comes up, and a second
        // scan of a 100 MB image for no reason is not free.
        bool expected = false;
        if (!gInitialised.compare_exchange_strong(expected, true))
            return gResolved.load();

        const auto pe  = FindPattern(kProcessEvent);
        const auto sfo = FindPattern(kStaticFindObject);
        const auto obj = FindPattern(kObjects, false, 7, true);

        gProcessEvent     = reinterpret_cast<ProcessEventFn>(pe);
        gStaticFindObject = reinterpret_cast<StaticFindObjectFn>(sfo);
        gObjects          = reinterpret_cast<FChunkedFixedUObjectArray*>(obj);

        // All three or nothing. A layer that half-resolves is worse than one that reports failure:
        // FindObject would work and ProcessEvent would jump to zero.
        const bool ok = pe && sfo && obj;
        gResolved.store(ok);

        Cobalt::Log::WriteLine(
            std::string("[UE4] ProcessEvent=") + (pe ? "ok" : "MISS") +
            " StaticFindObject=" + (sfo ? "ok" : "MISS") +
            " Objects=" + (obj ? "ok" : "MISS") +
            (ok ? "" : "  <- this build is not 4.22, or the patterns no longer match"));

        return ok;
    }

    bool Ready()
    {
        if (!gResolved.load()) return false;
        // Resolved is not the same as usable. The array pointer exists from module load, but it is
        // empty until the engine has constructed its objects — several seconds into a launch.
        return gObjects && gObjects->NumElements > 0 && gObjects->Objects != nullptr;
    }

    int ObjectCount()
    {
        return (gResolved.load() && gObjects) ? gObjects->NumElements : 0;
    }

    namespace
    {
        /**
         * The guarded call, kept in its own function ON PURPOSE.
         *
         * MSVC refuses `__try` in any function that also needs C++ object unwinding (C2712), and
         * the caller has a std::wstring. Splitting is the standard remedy and it keeps the SEH
         * region as small as it can be — exactly the call that can fault, nothing else.
         */
        void* SafeStaticFind(const wchar_t* name)
        {
            __try
            {
                return gStaticFindObject(nullptr, nullptr, name, false);
            }
            __except (EXCEPTION_EXECUTE_HANDLER)
            {
                // The engine tearing down mid-lookup is the realistic case. Cobalt must not take
                // the game with it.
                return nullptr;
            }
        }
    }

    UObject* FindObject(const std::string& path)
    {
        if (!Ready() || path.empty()) return nullptr;

        // Keep the wide string ALIVE across the call. Reboot writes
        // `std::wstring(...).c_str()` inline, which dangles the moment the temporary dies — it
        // happens to work there because nothing reuses the stack in between, but it is undefined
        // and there is no reason to copy the bug.
        const std::wstring wide(path.begin(), path.end());
        return reinterpret_cast<UObject*>(SafeStaticFind(wide.c_str()));
    }

    UFunction* FindFunction(const std::string& path)
    {
        return reinterpret_cast<UFunction*>(FindObject(path));
    }

    namespace
    {
        /** Same split as SafeStaticFind, and for the same C2712 reason. */
        bool SafeProcessEvent(void* object, void* function, void* params)
        {
            __try
            {
                gProcessEvent(object, function, params);
                return true;
            }
            __except (EXCEPTION_EXECUTE_HANDLER)
            {
                return false;
            }
        }
    }

    void ProcessEvent(UObject* object, UFunction* function, void* params)
    {
        if (!gResolved.load() || !object || !function) return;
        if (!SafeProcessEvent(object, function, params))
            Cobalt::Log::WriteLine("[UE4] ProcessEvent faulted and was contained");
    }

    namespace
    {
        /** Guarded ProcessEvent that returns success, split for C2712 as above. */
        bool SafePE(void* obj, void* fn, void* params)
        {
            __try { gProcessEvent(obj, fn, params); return true; }
            __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
        }

        /** Guarded read of an object's UClass pointer. */
        void* SafeClassOf(void* obj)
        {
            __try { return static_cast<UObjectLayout*>(obj)->ClassPrivate; }
            __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
        }

        void* GetObjectByIndex(int index)
        {
            if (!gObjects || index < 0 || index >= gObjects->NumElements) return nullptr;
            const int chunk = index / FChunkedFixedUObjectArray::NumElementsPerChunk;
            const int within = index % FChunkedFixedUObjectArray::NumElementsPerChunk;
            if (chunk > gObjects->NumChunks) return nullptr;
            FUObjectItem* c = gObjects->Objects[chunk];
            return c ? (c + within)->Object : nullptr;
        }
    }

    std::string GetName(UObject* object)
    {
        if (!Ready() || !object) return {};

        // Via the engine's own accessor rather than by decoding the FName pool. It costs a
        // ProcessEvent per call, which is why the census below resolves a name once per distinct
        // CLASS and never once per object -- 226,000 calls would stutter the game for no gain.
        static void* fn  = FindObject("/Script/Engine.KismetSystemLibrary.GetObjectName");
        static void* lib = FindObject("/Script/Engine.Default__KismetSystemLibrary");
        if (!fn || !lib) return {};

        struct { void* Object; FStringOut Return; } params{ object, {} };
        if (!SafePE(lib, fn, &params)) return {};
        if (!params.Return.Data || params.Return.ArrayNum <= 0) return {};

        std::string out;
        for (int i = 0; i < params.Return.ArrayNum && params.Return.Data[i]; ++i)
            out += static_cast<char>(params.Return.Data[i] < 128 ? params.Return.Data[i] : '?');
        return out;
    }

    void EnumerateMedia()
    {
        if (!Ready()) return;

        // Classes whose INSTANCES are worth listing individually -- there should be few, and each
        // one is a candidate to reuse instead of constructing our own.
        struct Watch { const char* label; void* cls; };
        Watch watches[] = {
            { "MediaPlayer",         FindObject("/Script/MediaAssets.MediaPlayer") },
            { "MediaTexture",        FindObject("/Script/MediaAssets.MediaTexture") },
            { "FileMediaSource",     FindObject("/Script/MediaAssets.FileMediaSource") },
            { "MediaSoundComponent", FindObject("/Script/MediaAssets.MediaSoundComponent") },
        };

        const int total = ObjectCount();
        Cobalt::Log::WriteLine("[UE4] media census over " + std::to_string(total) + " objects");

        // Pass 1: instances of the media classes. Cheap -- a pointer compare per object.
        int listed = 0;
        for (int i = 0; i < total && listed < 40; ++i)
        {
            void* obj = GetObjectByIndex(i);
            if (!obj) continue;
            void* cls = SafeClassOf(obj);
            if (!cls) continue;

            for (const auto& w : watches)
            {
                if (!w.cls || cls != w.cls) continue;
                Cobalt::Log::WriteLine(std::string("[UE4]   instance ") + w.label + " -> " +
                                       GetName(reinterpret_cast<UObject*>(obj)));
                ++listed;
                break;
            }
        }
        if (listed == 0)
            Cobalt::Log::WriteLine("[UE4]   no live instances of any media class -- nothing to reuse, build from scratch");

        // Pass 2: which CLASSES exist whose name looks video-shaped. One name lookup per distinct
        // class pointer, not per object, which is what keeps this affordable.
        std::vector<void*> seen;
        seen.reserve(4096);
        int classesNamed = 0, hits = 0;
        for (int i = 0; i < total && classesNamed < 6000; ++i)
        {
            void* obj = GetObjectByIndex(i);
            if (!obj) continue;
            void* cls = SafeClassOf(obj);
            if (!cls) continue;
            if (std::find(seen.begin(), seen.end(), cls) != seen.end()) continue;
            seen.push_back(cls);
            ++classesNamed;

            const std::string n = GetName(reinterpret_cast<UObject*>(cls));
            if (n.empty()) continue;
            if (n.find("Media") != std::string::npos || n.find("Movie") != std::string::npos ||
                n.find("Video") != std::string::npos || n.find("Cinematic") != std::string::npos)
            {
                Cobalt::Log::WriteLine("[UE4]   class  " + n);
                if (++hits >= 30) break;
            }
        }
        Cobalt::Log::WriteLine("[UE4] media census done: " + std::to_string(listed) + " instance(s), " +
                               std::to_string(hits) + " video-shaped class(es), " +
                               std::to_string(classesNamed) + " classes examined");
    }

    namespace
    {
        /** FString as the engine lays it out: TArray<TCHAR>. */
        struct FStringIn
        {
            const wchar_t* Data;
            int32_t ArrayNum;
            int32_t ArrayMax;
            FStringIn() : Data(nullptr), ArrayNum(0), ArrayMax(0) {}
            explicit FStringIn(const std::wstring& s)
                : Data(s.c_str()), ArrayNum((int32_t)s.size() + 1), ArrayMax((int32_t)s.size() + 1) {}
        };

        /** GameplayStatics.SpawnObject(Class, Outer) — the reflection-reachable way to make one. */
        void* SpawnObject(void* cls, void* outer)
        {
            if (!cls || !outer) return nullptr;
            static void* gs = FindObject("/Script/Engine.Default__GameplayStatics");
            static void* fn = FindObject("/Script/Engine.GameplayStatics.SpawnObject");
            if (!gs || !fn) return nullptr;
            struct { void* Class; void* Outer; void* Return; } p{ cls, outer, nullptr };
            if (!SafePE(gs, fn, &p)) return nullptr;
            return p.Return;
        }

        /** Where the bumper may live. Every candidate is reported, so a missing file is obvious. */
        std::vector<std::wstring> BumperCandidates()
        {
            std::vector<std::wstring> out;
            wchar_t buf[MAX_PATH]{};
            if (GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH))
            {
                out.push_back(std::wstring(buf) + L"\\ProjectNova\\bumper.mp4");
                out.push_back(std::wstring(buf) + L"\\FortniteGame\\bumper.mp4");
            }
            wchar_t exe[MAX_PATH]{};
            if (GetModuleFileNameW(nullptr, exe, MAX_PATH))
            {
                std::wstring p(exe);
                const size_t slash = p.find_last_of(L"\\");
                if (slash != std::wstring::npos) out.push_back(p.substr(0, slash + 1) + L"bumper.mp4");
            }
            return out;
        }

        std::string Narrow(const std::wstring& w)
        {
            std::string s;
            for (size_t i = 0; i < w.size(); ++i) s += (w[i] < 128 ? (char)w[i] : '?');
            return s;
        }

        // ── THE SOUNDTRACK ───────────────────────────────────────────────────────────────────────
        //
        // UE4's MediaPlayer only makes sound through a MediaSoundComponent, which needs an actor to
        // live on and the audio mixer underneath it -- two more things to get wrong from outside
        // the engine. Windows will play a WAV on its own thread with one call. So the launcher
        // ships the clip's audio as bumper.wav beside bumper.mp4, and this starts it alongside the
        // video. winmm is loaded on first use rather than imported, so the DLL's import table --
        // which the game's loader resolves at startup -- does not change.
        std::wstring gWavPath;
        using PlaySoundWFn = BOOL (WINAPI*)(LPCWSTR, HMODULE, DWORD);
        PlaySoundWFn gPlaySound = nullptr;
        constexpr DWORD kSndAsync = 0x0001, kSndNoDefault = 0x0002, kSndFilename = 0x00020000;

        bool LoadPlaySound()
        {
            if (gPlaySound) return true;
            HMODULE winmm = LoadLibraryW(L"winmm.dll");
            if (!winmm) return false;
            gPlaySound = reinterpret_cast<PlaySoundWFn>(GetProcAddress(winmm, "PlaySoundW"));
            return gPlaySound != nullptr;
        }

        void StartAudio()
        {
            if (gWavPath.empty()) { Cobalt::Log::WriteLine("[UE4] bumper: no bumper.wav - playing silent"); return; }
            if (!LoadPlaySound()) { Cobalt::Log::WriteLine("[UE4] bumper: winmm.PlaySoundW unavailable - playing silent"); return; }
            const BOOL ok = gPlaySound(gWavPath.c_str(), nullptr, kSndAsync | kSndNoDefault | kSndFilename);
            Cobalt::Log::WriteLine(std::string("[UE4] bumper: audio ") + (ok ? "started" : "FAILED to start"));
        }

        void StopAudio()
        {
            if (gPlaySound) gPlaySound(nullptr, nullptr, 0);
        }
    }

    void TryDecodeBumper()
    {
        if (!Ready()) return;

        // 1. The file. Nothing else matters if it is not on disk, and "no video appeared" is a
        //    useless symptom when the real reason was a path.
        std::wstring path;
        std::vector<std::wstring> candidates = BumperCandidates();
        for (size_t i = 0; i < candidates.size(); ++i)
        {
            const DWORD attr = GetFileAttributesW(candidates[i].c_str());
            const bool ok = attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
            Cobalt::Log::WriteLine(std::string("[UE4] bumper ") + (ok ? "FOUND  " : "absent ") + Narrow(candidates[i]));
            if (ok && path.empty()) path = candidates[i];
        }
        if (path.empty())
        {
            Cobalt::Log::WriteLine("[UE4] no bumper.mp4 in any candidate location - copy the file to one of the above");
            return;
        }
        // Its soundtrack, beside it. Absent is not fatal: the video plays silent and the log says so.
        {
            const std::wstring wav = path.substr(0, path.find_last_of(L'.')) + L".wav";
            const DWORD attr = GetFileAttributesW(wav.c_str());
            const bool ok = attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
            Cobalt::Log::WriteLine(std::string("[UE4] bumper audio ") + (ok ? "FOUND  " : "absent ") + Narrow(wav));
            gWavPath = ok ? wav : L"";
        }

        // 2. Construct a player. The transient package is what engine code uses for objects that
        //    must not be saved with a level.
        void* transientPkg = FindObject("/Engine/Transient");
        void* playerCls = FindObject("/Script/MediaAssets.MediaPlayer");
        if (!transientPkg || !playerCls)
        {
            Cobalt::Log::WriteLine("[UE4] transient package or MediaPlayer class missing - cannot construct");
            return;
        }

        void* player = SpawnObject(playerCls, transientPkg);
        Cobalt::Log::WriteLine(std::string("[UE4] MediaPlayer construct: ") + (player ? "ok" : "FAILED"));
        if (!player) return;

        // 3. Open it. This is the moment WmfMedia either decodes an mp4 in this process or does not.
        void* openFile = FindObject("/Script/MediaAssets.MediaPlayer.OpenFile");
        if (!openFile) { Cobalt::Log::WriteLine("[UE4] OpenFile function missing"); return; }

        // RETRY, rather than calling once at a moment I chose.
        //
        // The first attempt failed and the engine said why, in FortniteGame.log:
        //
        //   LogMediaUtils: Error: Cannot play file://...bumper.mp4:
        //   no media player plug-ins are installed and enabled in this project
        //
        // Which is not what it sounds like. WmfMedia IS mounted -- the plugin is enabled. But the
        // module that REGISTERS the player factory loads much later than the media modules
        // themselves: at shutdown the engine reports WmfMediaFactory as module 244 against
        // MediaAssets 86 and WmfMedia 96. The call went out ~7 seconds into startup, when the
        // factory list was still empty.
        //
        // That message also proved the path marshalling is right -- the engine echoed the exact
        // file back as a file:// URL. So the only thing wrong was when.
        //
        // Rather than guess a better fixed moment (this subsystem has now cost three releases to
        // exactly that mistake), keep asking. Bounded at two minutes; quiet except when the answer
        // changes, because this runs while somebody is trying to play.
        struct OpenParams { FStringIn Path; bool Return; char pad[7]; };
        bool opened = false;
        for (int attempt = 1; attempt <= 24 && !opened; ++attempt)
        {
            OpenParams openParams{ FStringIn(path), false, {} };
            if (!SafePE(player, openFile, &openParams))
            {
                Cobalt::Log::WriteLine("[UE4] OpenFile faulted");
                return;
            }
            opened = openParams.Return;
            if (opened)
            {
                Cobalt::Log::WriteLine("[UE4] OpenFile SUCCEEDED on attempt " + std::to_string(attempt) +
                                       " (~" + std::to_string(attempt * 5) + "s after the engine came up)");
                break;
            }
            if (attempt == 1)
                Cobalt::Log::WriteLine("[UE4] OpenFile refused - waiting for the media player factory to register");
            Sleep(5000);
        }
        if (!opened)
        {
            Cobalt::Log::WriteLine("[UE4] OpenFile never succeeded in 2 minutes - the factory never registered");
            return;
        }

        // 4. Duration. Opening is asynchronous, so poll — reading once and concluding would report
        //    a failure that is really just "not yet".
        void* getDuration = FindObject("/Script/MediaAssets.MediaPlayer.GetDuration");
        if (getDuration)
        {
            bool got = false;
            for (int i = 0; i < 20 && !got; ++i)
            {
                Sleep(250);
                struct { long long Ticks; } dur{ 0 };
                if (!SafePE(player, getDuration, &dur)) break;
                if (dur.Ticks > 0)
                {
                    // FTimespan ticks are 100ns.
                    const double seconds = (double)dur.Ticks / 10000000.0;
                    Cobalt::Log::WriteLine("[UE4] DECODED - duration " + std::to_string(seconds) + "s");
                    got = true;
                }
            }
            if (!got) Cobalt::Log::WriteLine("[UE4] duration stayed 0 after 5s - opened but not decoding");
        }

        // 5. Bind a texture. Proves the frames have somewhere to land; drawing it is the next step.
        void* texCls = FindObject("/Script/MediaAssets.MediaTexture");
        void* tex = texCls ? SpawnObject(texCls, transientPkg) : nullptr;
        Cobalt::Log::WriteLine(std::string("[UE4] MediaTexture construct: ") + (tex ? "ok" : "FAILED"));
        if (tex)
        {
            void* setPlayer = FindObject("/Script/MediaAssets.MediaTexture.SetMediaPlayer");
            if (setPlayer)
            {
                struct { void* Player; } sp{ player };
                Cobalt::Log::WriteLine(std::string("[UE4] SetMediaPlayer: ") +
                    (SafePE(tex, setPlayer, &sp) ? "ok" : "faulted"));
            }
        }

        void* play = FindObject("/Script/MediaAssets.MediaPlayer.Play");
        if (play)
        {
            struct { bool Return; char pad[7]; } pr{ false, {} };
            SafePE(player, play, &pr);
            Cobalt::Log::WriteLine(std::string("[UE4] Play returned: ") + (pr.Return ? "TRUE" : "false"));
        }

        // Decoding is proven. Hand it to the display step, which runs on the game thread.
        if (tex) ShowBumper(player, tex);
    }

    // ── PROPERTY OFFSETS ─────────────────────────────────────────────────────────────────────────
    //
    // Needed because the display path has to WRITE two properties that no UFunction exposes:
    // UUserWidget::WidgetTree and UWidgetTree::RootWidget. Everything up to now got by with
    // functions alone.
    //
    // The walk is Reboot's, and it is small because StaticFindObject already does the hard part:
    // a UProperty is an object whose Outer is the class that declares it, so finding one is the
    // same lookup as finding anything else, with Class and Outer supplied.
    //
    // 4.22 layout, from Project Reboot/patterns.h: InternalOffset 0x44, SuperStruct 0x40.
    namespace
    {
        constexpr int kOffset_InternalOffset = 0x44;
        constexpr int kOffset_SuperStruct = 0x40;

        void* SafeStaticFindIn(void* cls, void* outer, const wchar_t* name)
        {
            __try { return gStaticFindObject(cls, outer, name, false); }
            __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
        }

        void* SafeDeref(void* base, int off)
        {
            __try { return *(void**)((char*)base + off); }
            __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
        }

        int SafeReadInt(void* base, int off)
        {
            __try { return *(int*)((char*)base + off); }
            __except (EXCEPTION_EXECUTE_HANDLER) { return -1; }
        }

        bool SafeWritePtr(void* base, int off, void* value)
        {
            __try { *(void**)((char*)base + off) = value; return true; }
            __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
        }

        /**
         * Read the old ImageSize and write the new one. Split out because MSVC forbids __try in a
         * function that also needs C++ object unwinding (C2712), and the caller builds log strings.
         */
        bool SwapImageSize(void* addr, float w, float h, float outBefore[2])
        {
            __try
            {
                float* p = (float*)addr;
                outBefore[0] = p[0];
                outBefore[1] = p[1];
                p[0] = w;
                p[1] = h;
                return true;
            }
            __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
        }

        /**
         * Offset of a property declared directly on a UScriptStruct.
         *
         * OffsetOf walks an OBJECT's class chain, which is the wrong lookup for FSlateBrush --
         * that is a struct, and its properties are outered to the UScriptStruct itself.
         */
        int OffsetInStruct(void* scriptStruct, const std::string& member)
        {
            if (!Ready() || !scriptStruct) return -1;
            static void* propClass = FindObject("/Script/CoreUObject.Property");
            if (!propClass) return -1;
            const std::wstring wide(member.begin(), member.end());
            void* prop = SafeStaticFindIn(propClass, scriptStruct, wide.c_str());
            return prop ? SafeReadInt(prop, kOffset_InternalOffset) : -1;
        }

        /** Offset of a named property on an object's class, walking up the super chain. -1 if absent. */
        int OffsetOf(void* obj, const std::string& member)
        {
            if (!Ready() || !obj) return -1;
            static void* propClass = FindObject("/Script/CoreUObject.Property");
            if (!propClass) return -1;

            const std::wstring wide(member.begin(), member.end());
            for (void* cls = SafeClassOf(obj); cls; cls = SafeDeref(cls, kOffset_SuperStruct))
            {
                if (void* prop = SafeStaticFindIn(propClass, cls, wide.c_str()))
                    return SafeReadInt(prop, kOffset_InternalOffset);
            }
            return -1;
        }

        /**
         * A UFunction by name on an OBJECT, walking its class chain -- the way the engine itself
         * resolves a call.
         *
         * A function's path names the class that DECLARES it. SetVisibility is declared on Widget,
         * so "/Script/UMG.UserWidget.SetVisibility" finds nothing -- and the code that hid the
         * bumper until Battle Royale looked it up exactly that way, inside an `if`, for two
         * releases. The hide silently never happened: the control texture sat over the login
         * screen, full-screen and hit-testable, and swallowed every click.
         */
        void* FindFunctionOn(void* obj, const char* name)
        {
            if (!Ready() || !obj || !name) return nullptr;
            static void* funcClass = FindObject("/Script/CoreUObject.Function");
            if (!funcClass) return nullptr;
            const std::string narrow(name);
            const std::wstring wide(narrow.begin(), narrow.end());
            for (void* cls = SafeClassOf(obj); cls; cls = SafeDeref(cls, kOffset_SuperStruct))
                if (void* fn = SafeStaticFindIn(funcClass, cls, wide.c_str())) return fn;
            return nullptr;
        }
    }

    // ── GAME-THREAD HOP ──────────────────────────────────────────────────────────────────────────
    //
    // Constructing a MediaPlayer off-thread happened to work. Slate will not be so forgiving:
    // building widgets and calling AddToViewport from a worker thread is the kind of thing that
    // crashes a player's game rather than logging a failure, and this DLL is in everyone's client.
    //
    // ProcessEvent is called constantly and overwhelmingly from the game thread, so hooking it gives
    // a cheap ride there. The detour is one relaxed atomic load in the common case; the task is run
    // once and the flag cleared, so the steady-state cost after that is the same load returning
    // false forever.
    namespace
    {
        std::atomic<bool> gTaskPending{ false };
        void (*gTask)() = nullptr;

        void ProcessEventDetour(void* obj, void* fn, void* params)
        {
            if (gTaskPending.load(std::memory_order_relaxed))
            {
                // Clear FIRST. If the task faults, it must not be retried on every subsequent
                // ProcessEvent call for the rest of the session.
                bool expected = true;
                if (gTaskPending.compare_exchange_strong(expected, false) && gTask)
                {
                    __try { gTask(); } __except (EXCEPTION_EXECUTE_HANDLER) {}
                }
            }
            gProcessEventOriginal(obj, fn, params);
        }
    }

    bool RunOnGameThread(void (*task)())
    {
        if (!gResolved.load() || !task) return false;
        if (!gHookInstalled)
        {
            if (MH_CreateHook((LPVOID)gProcessEvent, &ProcessEventDetour,
                              (LPVOID*)&gProcessEventOriginal) != MH_OK) return false;
            if (MH_EnableHook((LPVOID)gProcessEvent) != MH_OK) return false;
            gHookInstalled = true;
            Cobalt::Log::WriteLine("[UE4] game-thread hook installed");
        }
        gTask = task;
        gTaskPending.store(true, std::memory_order_relaxed);
        return true;
    }

    // ── ALLOCATING THE TEXTURE'S RENDERING SURFACE ───────────────────────────────────────────────
    //
    // The class listing settled it: UMediaTexture exposes exactly six UFunctions --
    // SetMediaPlayer, GetWidth, GetMediaPlayer, GetHeight, GetAspectRatio, ExecuteUbergraph --
    // and UTexture exposes none. UpdateResource is a plain C++ virtual, so reflection cannot reach
    // it, which is why the brush had nothing to sample and Slate drew white.
    //
    // It IS in the vtable, though, and MediaTexture gives us something almost no other case does:
    // a way to CHECK. GetWidth returns 0 until a resource exists and the video's real width after.
    // So the slot can be searched rather than guessed:
    //
    //   for each candidate slot -> call it -> ask GetWidth -> if it became non-zero, that was it.
    //
    // Every call is SEH-guarded and the search stops the moment it works. This is still the riskiest
    // thing in this file by a distance -- calling an arbitrary virtual is calling arbitrary code --
    // so the range is deliberately narrow and the whole thing is skipped if the width is already
    // non-zero.
    namespace
    {
        int MediaTextureWidth(void* tex)
        {
            static void* fn = FindObject("/Script/MediaAssets.MediaTexture.GetWidth");
            if (!fn || !tex) return -1;
            struct { int Return; } p{ 0 };
            if (!SafePE(tex, fn, &p)) return -1;
            return p.Return;
        }

        // CallVirtual lived here. It is deleted, not commented out: leaving a function that
        // calls an arbitrary vtable slot in a DLL that ships to players is leaving a loaded gun on
        // the table, and the next person to need "just one native call" would reach for it.
    }

    bool AllocateTextureResource(void*)
    {
        // Deliberately does nothing. See the note at the call site: the vtable search this used to
        // perform hung the game, and the kept shape is a reminder rather than a switch to flip.
        return false;
    }

    // ── THE GAME'S OWN MEDIA TEXTURE ─────────────────────────────────────────────────────────────
    //
    // A MediaTexture constructed here never draws, because the one thing that gives a texture a
    // rendering resource -- UTexture::UpdateResource -- is a C++ virtual with no UFunction, and
    // calling it through a guessed vtable slot hung the game. That route is closed for good.
    //
    // The engine allocates the resource ITSELF for any texture it loads: UTexture::PostLoad calls
    // UpdateResource. And 7.40 ships MediaTexture assets of its own. The pak index (read offline
    // with the 7.40 key; the reader is tools/paklist.mjs) lists
    //
    //   FortniteGame/Content/UI/Foundation/Movie/DefaultMediaTexture.uasset  (+ DefaultMediaPlayer)
    //   FortniteGame/Content/Movies/PlaceholderMediaTexture.uasset
    //   FortniteGame/Content/Movies/**/FMS_*.uasset     FileMediaSources for the STW clips
    //   FortniteGame/AssetRegistry.bin
    //
    // which is exactly the machinery Fortnite's own movie widget draws the STW tutorial and gadget
    // clips through -- "use the game's own video system", done with the game's own texture rather
    // than by hijacking its widget.
    //
    // So: load that texture and point it at the player that already decodes the bumper. Every step
    // is a UFunction the game exposes, every offset is read from the engine's reflection data, and
    // the only engine memory ever written is parameter buffers this code owns:
    //
    //   AssetRegistryHelpers.GetAssetRegistry()           the registry (AssetRegistry.bin ships)
    //   AssetRegistry.GetAssetsByClass("MediaTexture")    an FAssetData per such asset
    //   AssetRegistryHelpers.GetAsset(FAssetData)         StaticLoadObject; PostLoad allocates
    //   MediaTexture.SetMediaPlayer(ours)                 frames now land in a real resource
    namespace
    {
        /**
         * Offset of a UFunction parameter. Parameters are properties outered to the function, so
         * this is the same lookup OffsetInStruct does for a struct member.
         */
        int ParamOffset(void* fn, const char* name) { return OffsetInStruct(fn, name); }

        /** Defined with the display code below; the object library it roots is created here. */
        bool AddToRoot(void* obj);

        /**
         * A zeroed parameter buffer, deliberately larger than any parameter struct used here.
         * ProcessEvent copies ParmsSize bytes out of it and writes results back at offsets the
         * engine reports, so a generous buffer means no hand-computed struct can be too small.
         */
        struct Params
        {
            alignas(16) unsigned char bytes[1024];
            Params() { memset(bytes, 0, sizeof(bytes)); }
            template <typename T> T& at(int off) { return *reinterpret_cast<T*>(bytes + off); }
        };

        struct FScriptInterfaceOut { void* Object; void* Interface; };   // TScriptInterface<>
        struct TArrayRaw { void* Data; int32_t Num; int32_t Max; };

        std::wstring Widen(const std::string& s) { return std::wstring(s.begin(), s.end()); }

        /** An FName for `text`, made by the engine (KismetStringLibrary.Conv_StringToName). 0 if that fails. */
        uint64_t MakeName(const std::wstring& text)
        {
            static void* lib = FindObject("/Script/Engine.Default__KismetStringLibrary");
            static void* fn  = FindObject("/Script/Engine.KismetStringLibrary.Conv_StringToName");
            if (!lib || !fn) return 0;
            const int inOff = ParamOffset(fn, "InString"), retOff = ParamOffset(fn, "ReturnValue");
            if (inOff < 0 || retOff < 0) return 0;
            Params p;
            p.at<FStringIn>(inOff) = FStringIn(text);
            if (!SafePE(lib, fn, p.bytes)) return 0;
            return p.at<uint64_t>(retOff);
        }

        /** The text of an FName (KismetStringLibrary.Conv_NameToString). Empty if that fails. */
        std::string NameText(uint64_t name)
        {
            static void* lib = FindObject("/Script/Engine.Default__KismetStringLibrary");
            static void* fn  = FindObject("/Script/Engine.KismetStringLibrary.Conv_NameToString");
            if (!lib || !fn) return {};
            const int inOff = ParamOffset(fn, "InName"), retOff = ParamOffset(fn, "ReturnValue");
            if (inOff < 0 || retOff < 0) return {};
            Params p;
            p.at<uint64_t>(inOff) = name;
            if (!SafePE(lib, fn, p.bytes)) return {};
            const FStringOut& s = p.at<FStringOut>(retOff);
            std::string out;
            for (int i = 0; s.Data && i < s.ArrayNum && s.Data[i]; ++i)
                out += (s.Data[i] < 128 ? (char)s.Data[i] : '?');
            return out;
        }

        /**
         * The asset registry, and the two calls needed to find and load an asset through it.
         *
         * Resolved once, and every layout fact is read from the engine: FAssetData's size is where
         * GetAsset's return value starts (its one parameter is an FAssetData at offset 0), and
         * ObjectPath's position comes from the struct itself. If any of that fails to resolve, the
         * whole thing reports why and does nothing -- there is no fallback to a guessed number.
         */
        class GameAssets
        {
        public:
            struct Ref
            {
                std::vector<unsigned char> data;   // one FAssetData, byte for byte
                std::string path;                  // its ObjectPath, e.g. /Game/Movies/X.X
            };

            bool Resolve()
            {
                if (resolved) return ok;
                resolved = true;

                void* getRegistry = FindObject("/Script/AssetRegistry.AssetRegistryHelpers.GetAssetRegistry");
                helpers   = FindObject("/Script/AssetRegistry.Default__AssetRegistryHelpers");
                byClass   = FindObject("/Script/AssetRegistry.AssetRegistry.GetAssetsByClass");
                getAsset  = FindObject("/Script/AssetRegistry.AssetRegistryHelpers.GetAsset");
                void* assetData = FindObject("/Script/AssetRegistry.AssetData");

                bool all = true;
                auto need = [&all](const char* what, void* p)
                {
                    if (!p) { Cobalt::Log::WriteLine(std::string("[UE4] assets: MISSING ") + what); all = false; }
                };
                need("AssetRegistryHelpers.GetAssetRegistry", getRegistry);
                need("Default__AssetRegistryHelpers", helpers);
                need("AssetRegistry.GetAssetsByClass", byClass);
                need("AssetRegistryHelpers.GetAsset", getAsset);
                need("AssetData struct", assetData);
                if (!all) return ok = false;

                // The registry object itself.
                {
                    const int retOff = ParamOffset(getRegistry, "ReturnValue");
                    Params p;
                    if (retOff < 0 || !SafePE(helpers, getRegistry, p.bytes))
                    {
                        Cobalt::Log::WriteLine("[UE4] assets: GetAssetRegistry faulted");
                        return ok = false;
                    }
                    registry = p.at<FScriptInterfaceOut>(retOff).Object;
                    if (!registry)
                    {
                        Cobalt::Log::WriteLine("[UE4] assets: GetAssetRegistry returned null");
                        return ok = false;
                    }
                }

                inOff   = ParamOffset(getAsset, "InAssetData");
                stride  = ParamOffset(getAsset, "ReturnValue");
                pathOff = OffsetInStruct(assetData, "ObjectPath");
                nameOff = ParamOffset(byClass, "ClassName");
                outOff  = ParamOffset(byClass, "OutAssetData");
                subOff  = ParamOffset(byClass, "bSearchSubClasses");
                Cobalt::Log::WriteLine("[UE4] assets: FAssetData is " + std::to_string(stride) + " bytes, ObjectPath@" +
                                       std::to_string(pathOff) + "; GetAssetsByClass ClassName@" +
                                       std::to_string(nameOff) + " Out@" + std::to_string(outOff) +
                                       " Sub@" + std::to_string(subOff));
                // 80 is the 4.22 size; anything far from it means the layout read went wrong.
                ok = inOff == 0 && stride >= 64 && stride <= 256 && pathOff >= 0 && pathOff + 8 <= stride &&
                     nameOff >= 0 && outOff >= 0 && subOff >= 0;
                if (!ok) Cobalt::Log::WriteLine("[UE4] assets: layout did not resolve sanely - not loading anything");
                return ok;
            }

            /** Every asset of `className` the registry knows, up to `max`. */
            std::vector<Ref> Find(const char* className, int max)
            {
                std::vector<Ref> out;
                if (!Resolve()) return out;

                const std::wstring wide = Widen(className);
                const uint64_t cls = MakeName(wide);
                if (!cls)
                {
                    Cobalt::Log::WriteLine(std::string("[UE4] assets: could not make an FName for ") + className);
                    return out;
                }

                Params q;
                q.at<uint64_t>(nameOff) = cls;
                q.at<bool>(subOff) = false;
                if (!SafePE(registry, byClass, q.bytes))
                {
                    Cobalt::Log::WriteLine("[UE4] assets: GetAssetsByClass faulted");
                    return out;
                }

                // The array's storage was allocated by the engine. It is copied out and then
                // deliberately leaked: there is no UFunction to free it, and a few hundred bytes
                // once per session is a better trade than freeing it with the wrong allocator.
                const TArrayRaw arr = q.at<TArrayRaw>(outOff);
                Cobalt::Log::WriteLine("[UE4] assets: " + std::to_string(arr.Num) + " " + className +
                                       " asset(s) in the registry");
                if (!arr.Data || arr.Num <= 0) return out;

                for (int i = 0; i < arr.Num && i < max; ++i)
                {
                    const unsigned char* ad = (const unsigned char*)arr.Data + (size_t)i * stride;
                    Ref r;
                    r.data.assign(ad, ad + stride);
                    r.path = NameText(*(const uint64_t*)(ad + pathOff));
                    out.push_back(r);
                }
                return out;
            }

            /** Load one. StaticLoadObject under the hood, so PostLoad -- and UpdateResource -- run. */
            void* Load(const Ref& ref)
            {
                if (!Resolve() || ref.data.size() != (size_t)stride) return nullptr;
                Params g;
                memcpy(g.bytes + inOff, ref.data.data(), ref.data.size());
                if (!SafePE(helpers, getAsset, g.bytes))
                {
                    Cobalt::Log::WriteLine("[UE4] assets: GetAsset faulted for " + ref.path);
                    return nullptr;
                }
                void* obj = g.at<void*>(stride);
                Cobalt::Log::WriteLine("[UE4] assets: load " + ref.path + (obj ? " -> ok" : " -> returned null"));
                return obj;
            }

        private:
            bool resolved = false, ok = false;
            void* registry = nullptr;
            void* helpers = nullptr;
            void* byClass = nullptr;
            void* getAsset = nullptr;
            int inOff = -1, stride = 0, pathOff = -1, nameOff = -1, outOff = -1, subOff = -1;
        };

        GameAssets gAssets;

        // The MediaTexture assets 7.40 ships, in preference order, as object paths -- and the
        // directories they live in, for the route that loads by directory. Both come from the pak
        // index, not from a guess.
        static const char* kGameMediaTextures[] = {
            "/Game/UI/Foundation/Movie/DefaultMediaTexture.DefaultMediaTexture",
            "/Game/Movies/PlaceholderMediaTexture.PlaceholderMediaTexture",
        };
        static const char* kGameMediaTextureDirs[] = { "/Game/UI/Foundation/Movie", "/Game/Movies" };

        /** Either known texture, if it is already in memory. */
        void* ResidentGameMediaTexture()
        {
            for (const char* p : kGameMediaTextures)
                if (void* o = FindObject(p)) return o;
            return nullptr;
        }

        /**
         * Route B: UObjectLibrary.
         *
         * The registry route needs AssetRegistry.GetAssetsByClass to be a UFunction, and on this
         * build it is not (1.8.2 logged it MISSING). ObjectLibrary is older and plainer:
         * CreateLibrary(class) then LoadAssetsFromPath(dir) loads every package under a directory
         * of the mounted paks, PostLoad and all. The directory that holds DefaultMediaTexture has
         * two packages in it. A library loads a path once, so it is one library per directory.
         */
        void* LoadViaObjectLibrary()
        {
            void* texCls   = FindObject("/Script/MediaAssets.MediaTexture");
            void* cdo      = FindObject("/Script/Engine.Default__ObjectLibrary");
            void* create   = FindObject("/Script/Engine.ObjectLibrary.CreateLibrary");
            void* fromPath = FindObject("/Script/Engine.ObjectLibrary.LoadAssetsFromPath");
            bool all = true;
            auto need = [&all](const char* what, void* p)
            {
                if (!p) { Cobalt::Log::WriteLine(std::string("[UE4] assets: MISSING ") + what); all = false; }
            };
            need("MediaTexture class", texCls);
            need("Default__ObjectLibrary", cdo);
            need("ObjectLibrary.CreateLibrary", create);
            need("ObjectLibrary.LoadAssetsFromPath", fromPath);
            if (!all) return nullptr;

            const int baseOff = ParamOffset(create, "InBaseClass");
            const int bpOff   = ParamOffset(create, "bInHasBlueprintClasses");
            const int weakOff = ParamOffset(create, "bInUseWeak");
            const int libOff  = ParamOffset(create, "ReturnValue");
            const int pathOff = ParamOffset(fromPath, "Path");
            const int cntOff  = ParamOffset(fromPath, "ReturnValue");
            if (baseOff < 0 || bpOff < 0 || weakOff < 0 || libOff < 0 || pathOff < 0 || cntOff < 0)
            {
                Cobalt::Log::WriteLine("[UE4] assets: ObjectLibrary parameter layout did not resolve");
                return nullptr;
            }

            for (const char* dir : kGameMediaTextureDirs)
            {
                Params c;
                c.at<void*>(baseOff) = texCls;
                c.at<bool>(bpOff) = false;
                c.at<bool>(weakOff) = false;
                if (!SafePE(cdo, create, c.bytes)) { Cobalt::Log::WriteLine("[UE4] assets: CreateLibrary faulted"); return nullptr; }
                void* lib = c.at<void*>(libOff);
                if (!lib) { Cobalt::Log::WriteLine("[UE4] assets: CreateLibrary returned null"); return nullptr; }
                AddToRoot(lib);

                const std::wstring wide = Widen(dir);
                Params l;
                l.at<FStringIn>(pathOff) = FStringIn(wide);
                const bool ok = SafePE(lib, fromPath, l.bytes);
                const int count = ok ? l.at<int>(cntOff) : -1;
                Cobalt::Log::WriteLine(std::string("[UE4] assets: ObjectLibrary.LoadAssetsFromPath(") + dir + ") " +
                                       (ok ? "-> " + std::to_string(count) + " MediaTexture(s)" : "FAULTED"));
                if (void* o = ResidentGameMediaTexture()) return o;
            }
            return nullptr;
        }

        /**
         * The game's own MediaTexture, loaded. Already resident wins; then the registry; then the
         * object library. Null with the reasons logged if none of them produce one.
         * Must run on the game thread -- it loads packages.
         */
        void* LoadGameMediaTexture()
        {
            if (void* o = ResidentGameMediaTexture())
            {
                Cobalt::Log::WriteLine("[UE4] assets: game MediaTexture already resident");
                return o;
            }

            // Route A: the registry.
            std::vector<GameAssets::Ref> found = gAssets.Find("MediaTexture", 64);
            for (size_t i = 0; i < found.size() && i < 12; ++i)
                Cobalt::Log::WriteLine("[UE4] assets:   " + found[i].path);
            if (!found.empty())
            {
                static const char* kPreferred[] = { "DefaultMediaTexture", "PlaceholderMediaTexture" };
                const GameAssets::Ref* pick = nullptr;
                for (const char* want : kPreferred)
                {
                    for (const auto& r : found)
                        if (r.path.find(want) != std::string::npos) { pick = &r; break; }
                    if (pick) break;
                }
                if (!pick) pick = &found[0];
                if (void* o = gAssets.Load(*pick)) return o;
            }

            // Route B.
            return LoadViaObjectLibrary();
        }

        /**
         * Set a widget's visibility -- and its image's, so the two never disagree -- and read it
         * back, because the previous version reported "hidden" without ever checking.
         * ESlateVisibility: 0 Visible, 1 Collapsed, 2 Hidden. Returns the read-back, -1 if unknown.
         */
        int ApplyVisibility(void* widget, void* image, unsigned char vis)
        {
            void* set = FindFunctionOn(widget, "SetVisibility");
            void* get = FindFunctionOn(widget, "GetVisibility");
            if (!set)
            {
                Cobalt::Log::WriteLine("[UE4] display: SetVisibility NOT FOUND on the widget's class chain");
                return -1;
            }
            struct { unsigned char V; char pad[7]; } p{ vis, {} };
            SafePE(widget, set, &p);
            if (image) { struct { unsigned char V; char pad[7]; } q{ vis, {} }; SafePE(image, set, &q); }
            if (!get) return -1;
            struct { unsigned char R; char pad[7]; } r{ 255, {} };
            if (!SafePE(widget, get, &r)) return -1;
            return r.R;
        }

        /** What else the game has, for the record. Lists; loads nothing. */
        void ListGameMediaAssets()
        {
            static const char* kClasses[] = { "MediaPlayer", "FileMediaSource" };
            for (const char* cls : kClasses)
            {
                std::vector<GameAssets::Ref> found = gAssets.Find(cls, 4);
                for (const auto& r : found) Cobalt::Log::WriteLine("[UE4] assets:   " + r.path);
            }
        }
    }

    // ── DISPLAY ──────────────────────────────────────────────────────────────────────────────────
    //
    // A UUserWidget created from native code has no WidgetTree -- normally the blueprint's generated
    // class supplies one -- so it adds to the viewport and draws nothing. The tree and its root have
    // to be built by hand, which is what the property offsets above are for.
    namespace
    {
        void* gPlayer = nullptr;
        void* gTexture = nullptr;
        void* gImage = nullptr;
        void* gSetBrush = nullptr;
        void* gWidget = nullptr;
        void* gControlTex = nullptr;
        bool  gShowVideoNext = true;

        // How the game-thread build ended, read by the worker that scheduled it. The wait for a
        // local player lives on the WORKER: sleeping inside the game-thread task would stall the
        // very thread that creates the PlayerController it is waiting for.
        enum { kBuildPending = 0, kBuildNoPlayer = 1, kBuildDone = 2, kBuildFailed = 3 };
        std::atomic<int> gBuildOutcome{ kBuildPending };

        /**
         * Keep an object alive across garbage collection.
         *
         * THIS IS WHY NOTHING SURVIVED. Objects made with SpawnObject and outered to the transient
         * package have nothing referencing them, so the next GC pass takes them. The evidence was
         * the swap ten seconds later faulting on pointers that were valid when they were created --
         * that is a collected object, not a bad call.
         *
         * There is no UFunction for AddToRoot, but the root set is a bit on the object's entry in
         * the global array, and that array is already reachable here. EInternalObjectFlags::RootSet
         * is 1<<30 in 4.22.
         */
        bool AddToRoot(void* obj)
        {
            if (!Ready() || !obj) return false;
            const int index = SafeReadInt(obj, 0x0C); // UObject::InternalIndex
            if (index < 0 || !gObjects || index >= gObjects->NumElements) return false;
            const int chunk = index / FChunkedFixedUObjectArray::NumElementsPerChunk;
            const int within = index % FChunkedFixedUObjectArray::NumElementsPerChunk;
            if (chunk > gObjects->NumChunks) return false;
            __try
            {
                FUObjectItem* c = gObjects->Objects[chunk];
                if (!c) return false;
                FUObjectItem* item = c + within;
                if (item->Object != obj) return false;   // index did not agree; do not touch it
                item->Flags |= (1 << 30);                // EInternalObjectFlags::RootSet
                return true;
            }
            __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
        }

        // UStruct::Children sits just past SuperStruct, and UField::Next is at 0x28 (UObject is
        // 0x28 bytes in 4.22). Both are needed to walk what a class actually declares.
        constexpr int kOffset_Children = kOffset_SuperStruct + 8;   // 0x48
        constexpr int kOffset_FieldNext = 0x28;

        /**
         * Log every UFunction a class exposes, walking the super chain.
         *
         * Guessing paths has cost several builds -- Texture.UpdateResource does not exist because
         * UTexture::UpdateResource is a plain C++ virtual, not a UFunction, and no amount of trying
         * more paths would have found it. This asks the class what it has instead.
         */
        void ListFunctions(const char* label, const char* classPath, int maxOut)
        {
            void* cls = FindObject(classPath);
            if (!cls) { Cobalt::Log::WriteLine(std::string("[UE4] fn: ") + label + " CLASS MISSING"); return; }

            static void* funcCls = FindObject("/Script/CoreUObject.Function");
            int shown = 0;
            for (void* c = cls; c && shown < maxOut; c = SafeDeref(c, kOffset_SuperStruct))
            {
                for (void* f = SafeDeref(c, kOffset_Children); f && shown < maxOut;
                     f = SafeDeref(f, kOffset_FieldNext))
                {
                    if (funcCls && SafeClassOf(f) != funcCls) continue;
                    const std::string n = GetName(reinterpret_cast<UObject*>(f));
                    if (n.empty()) continue;
                    Cobalt::Log::WriteLine(std::string("[UE4] fn: ") + label + "  " + n);
                    ++shown;
                }
            }
            if (shown == 0) Cobalt::Log::WriteLine(std::string("[UE4] fn: ") + label + " exposes NO UFunctions");
        }

        /** Walk the SuperStruct chain to test inheritance. */
        bool IsSubclassOf(void* cls, void* base)
        {
            for (void* c = cls; c; c = SafeDeref(c, kOffset_SuperStruct))
                if (c == base) return true;
            return false;
        }

        /** The live UWorld, found by walking the object array for one. */
        void* FindWorld()
        {
            void* worldCls = FindObject("/Script/Engine.World");
            if (!worldCls) return nullptr;
            const int total = ObjectCount();
            void* best = nullptr;
            for (int i = 0; i < total; ++i)
            {
                void* o = GetObjectByIndex(i);
                if (o && SafeClassOf(o) == worldCls) best = o;  // last one is the live one
            }
            return best;
        }


        int BuildAndShowInner()
        {
            if (!gTexture) { Cobalt::Log::WriteLine("[UE4] display: no texture"); return kBuildFailed; }

            void* transient = FindObject("/Engine/Transient");
            void* userWidgetCls = FindObject("/Script/UMG.UserWidget");
            void* widgetTreeCls = FindObject("/Script/UMG.WidgetTree");
            void* imageCls = FindObject("/Script/UMG.Image");
            if (!transient || !userWidgetCls || !widgetTreeCls || !imageCls)
            {
                Cobalt::Log::WriteLine("[UE4] display: a UMG class is missing (UserWidget/WidgetTree/Image)");
                return kBuildFailed;
            }

            // A WIDGET NEEDS A WORLD, AND THE CONTROL PROVED IT NEVER DREW.
            //
            // The control texture did not appear either, which rules out the MediaTexture entirely:
            // the widget was never rendering. A UUserWidget outered to the transient package has no
            // World -- UUserWidget::GetWorld() walks the Outer chain and finds a package -- so
            // AddToViewport has no viewport to add to and returns without complaint.
            //
            // So: find the live World, get its local PlayerController, and let UMG's own factory
            // build the widget with that context instead of constructing it bare.
            // A PLAYER IS REQUIRED, AND THE WAITING HAPPENS ELSEWHERE.
            //
            // An earlier build found a World and no PlayerController, so Create returned null and
            // it fell back to bare construction -- which has no world, so AddToViewport had nothing
            // to add to. The display ran ~15s in, before the frontend map had even loaded.
            //
            // The retry used to live here, as a Sleep loop. That was wrong in a way that only bites
            // sometimes: this function runs ON the game thread, so sleeping in it stalls the thread
            // that would have created the player. One pass now; the worker in ShowBumper sees
            // kBuildNoPlayer and schedules another pass a few seconds later. Every live World is
            // tried, because "the last World in the array" is not necessarily the player's.
            void* world = nullptr;
            void* pc = nullptr;
            void* getPC = FindObject("/Script/Engine.GameplayStatics.GetPlayerController");
            void* gs = FindObject("/Script/Engine.Default__GameplayStatics");
            void* worldCls = FindObject("/Script/Engine.World");

            if (worldCls && getPC && gs)
            {
                const int total = ObjectCount();
                for (int i = 0; i < total && !pc; ++i)
                {
                    void* o = GetObjectByIndex(i);
                    if (!o || SafeClassOf(o) != worldCls) continue;
                    struct { void* World; int Index; char pad[4]; void* Return; } p{ o, 0, {}, nullptr };
                    if (SafePE(gs, getPC, &p) && p.Return) { world = o; pc = p.Return; }
                }
            }
            if (!pc) return kBuildNoPlayer;
            Cobalt::Log::WriteLine(std::string("[UE4] display: world=") + (world ? "found" : "MISSING") +
                                   " playerController=" + (pc ? "found" : "MISSING"));

            // UUserWidget IS ABSTRACT, which is why Create kept returning null even once a
            // PlayerController existed.
            //
            // UE4 declares it UCLASS(Abstract), and CreateWidgetInstance refuses any class with
            // CLASS_Abstract. The bare-construction fallback DID produce an object -- SpawnObject
            // does not check -- but an abstract base with none of the setup Create performs, which
            // is exactly why AddToViewport has reported ok and drawn nothing for five builds. Every
            // layer under it (world, player, GC, size) was a real bug and none of them was THE bug.
            //
            // So: find a concrete subclass the game already defines and let Create build that. The
            // test is Create's own return value rather than reading class flags -- if it hands back
            // a widget, the class was acceptable by definition, and that needs no offset for
            // CLASS_Abstract and cannot disagree with the engine.
            void* widget = nullptr;
            void* usedClass = nullptr;
            void* create = FindObject("/Script/UMG.WidgetBlueprintLibrary.Create");
            void* lib = FindObject("/Script/UMG.Default__WidgetBlueprintLibrary");

            if (world && create && lib)
            {
                // Try the base first, purely to record that it is refused.
                {
                    struct { void* WorldContext; void* WidgetType; void* OwningPlayer; void* Return; }
                        p{ world, userWidgetCls, pc, nullptr };
                    if (SafePE(lib, create, &p) && p.Return) { widget = p.Return; usedClass = userWidgetCls; }
                    Cobalt::Log::WriteLine(std::string("[UE4] display: Create(UserWidget base) ") +
                                           (widget ? "ok" : "refused - class is abstract, as expected"));
                }

                // Then walk for concrete subclasses and take the first one Create accepts.
                if (!widget)
                {
                    const int total = ObjectCount();
                    std::vector<void*> tried;
                    tried.reserve(64);
                    int candidates = 0;
                    for (int i = 0; i < total && !widget && candidates < 40; ++i)
                    {
                        void* o = GetObjectByIndex(i);
                        if (!o) continue;
                        // A UClass whose own class is UClass, deriving from UUserWidget.
                        void* meta = SafeClassOf(o);
                        static void* classCls = FindObject("/Script/CoreUObject.Class");
                        if (!meta || meta != classCls) continue;
                        if (o == userWidgetCls || !IsSubclassOf(o, userWidgetCls)) continue;
                        if (std::find(tried.begin(), tried.end(), o) != tried.end()) continue;
                        tried.push_back(o);
                        ++candidates;

                        struct { void* WorldContext; void* WidgetType; void* OwningPlayer; void* Return; }
                            p{ world, o, pc, nullptr };
                        if (SafePE(lib, create, &p) && p.Return)
                        {
                            widget = p.Return;
                            usedClass = o;
                            Cobalt::Log::WriteLine("[UE4] display: Create succeeded with concrete class " +
                                                   GetName(reinterpret_cast<UObject*>(o)));
                        }
                    }
                    if (!widget)
                        Cobalt::Log::WriteLine("[UE4] display: tried " + std::to_string(candidates) +
                                               " concrete widget classes, none accepted");
                }
            }
            if (!widget)
            {
                widget = SpawnObject(userWidgetCls, transient);
                Cobalt::Log::WriteLine(std::string("[UE4] display: fell back to bare construction ") +
                                       (widget ? "ok (this has never drawn)" : "FAIL"));
            }
            (void)usedClass;

            void* tree = widget ? SpawnObject(widgetTreeCls, widget) : nullptr;
            void* image = tree ? SpawnObject(imageCls, tree) : nullptr;
            Cobalt::Log::WriteLine(std::string("[UE4] display: widget=") + (widget ? "ok" : "FAIL") +
                                   " tree=" + (tree ? "ok" : "FAIL") + " image=" + (image ? "ok" : "FAIL"));
            if (!widget || !tree || !image) return kBuildFailed;

            // Root everything, including the player and texture made earlier. Without this the next
            // GC pass takes them and the pointers held here go stale -- which is exactly what the
            // faulting swap in the last build was.
            const bool rooted = AddToRoot(widget) && AddToRoot(tree) && AddToRoot(image) &&
                                AddToRoot(gPlayer) && AddToRoot(gTexture);
            Cobalt::Log::WriteLine(std::string("[UE4] display: rooted against GC: ") + (rooted ? "ok" : "PARTIAL"));

            const int treeOff = OffsetOf(widget, "WidgetTree");
            const int rootOff = OffsetOf(tree, "RootWidget");
            Cobalt::Log::WriteLine("[UE4] display: WidgetTree@" + std::to_string(treeOff) +
                                   " RootWidget@" + std::to_string(rootOff));
            if (treeOff < 0 || rootOff < 0)
            {
                Cobalt::Log::WriteLine("[UE4] display: could not locate the properties to wire the tree");
                return kBuildFailed;
            }
            SafeWritePtr(tree, rootOff, image);
            SafeWritePtr(widget, treeOff, tree);

            // A CONTROL TEXTURE FIRST.
            //
            // Every step has reported ok for two builds and nothing has appeared, which leaves two
            // very different causes: the widget is not drawing at all, or it is drawing and a
            // MediaTexture cannot be sampled through a Slate brush (it derives from UTexture, not
            // UTexture2D, and SetBrushFromTexture only accepts the latter -- ProcessEvent does not
            // type-check, so the call "succeeds" either way).
            //
            // Showing a known-good texture the game already has separates those in one run. If the
            // control appears and the video does not, the widget is fine and the texture type is
            // the problem. If neither appears, the widget never drew and the texture is innocent.
            // Guessing between those without a control is how the last two builds were spent.
            static const char* kControlTextures[] = {
                "/Game/UI/Foundation/Textures/Icons/Items/T-Icon-S-Loot-Stone.T-Icon-S-Loot-Stone",
                "/Game/UI/Foundation/Textures/Icons/Items/T-Icon-Logs.T-Icon-Logs",
                "/Engine/EngineResources/DefaultTexture.DefaultTexture",
                "/Engine/EngineResources/WhiteSquareTexture.WhiteSquareTexture",
            };
            void* control = nullptr;
            for (const char* p : kControlTextures)
            {
                control = FindObject(p);
                if (control) { Cobalt::Log::WriteLine(std::string("[UE4] display: control texture ") + p); break; }
            }
            if (!control) Cobalt::Log::WriteLine("[UE4] display: no control texture found - showing the video only");

            void* setBrush = FindObject("/Script/UMG.Image.SetBrushFromTexture");
            if (setBrush)
            {
                struct { void* Texture; bool MatchSize; char pad[7]; } p{ control ? control : gTexture, false, {} };
                Cobalt::Log::WriteLine(std::string("[UE4] display: SetBrushFromTexture(") +
                                       (control ? "CONTROL" : "video") + ") " +
                                       (SafePE(image, setBrush, &p) ? "ok" : "faulted"));
            }
            gImage = image;
            gSetBrush = setBrush;
            gWidget = widget;

            // ── SIZE, AND WHY NOTHING WAS DRAWN ──────────────────────────────────────────────
            //
            // Every step reported ok last build and the engine logged no Slate complaint, which
            // rules out "the widget was rejected" and leaves "the widget drew nothing visible".
            // Two causes, both addressed here rather than guessed between:
            //
            //   1. A UImage's desired size comes from its brush's ImageSize, which defaults to
            //      32x32. A 32-pixel square in a 1080p menu is indistinguishable from nothing.
            //   2. A freshly constructed UMediaTexture has no rendering resource until
            //      UpdateResource() allocates one, so the brush would have had nothing to sample.
            //
            // The old ImageSize is logged before it is changed, so the 32x32 theory is confirmed
            // or killed by this run rather than assumed.
            // NO VTABLE SEARCH. It is removed, not disabled, and this comment is why.
            //
            // 1.8.0 walked vtable slots calling each one and checking GetWidth for a non-zero
            // result. Slot 88 returned width 2 -- the video is 854 wide -- and the check passed
            // anyway because it only asked "> 0" instead of "is this a plausible video width".
            // So an arbitrary virtual was called, something was written that should not have been,
            // and the game hung on the loading screen.
            //
            // The test was the problem, not just the range. A verification that accepts a value it
            // should have rejected is worse than no verification: it turned "this is risky" into
            // "this worked", and shipped.
            //
            // THE GAME'S OWN TEXTURE INSTEAD. Loaded from the pak, so the engine allocated its
            // resource in PostLoad -- see the section above. The texture constructed in
            // TryDecodeBumper stays rooted and unused if this succeeds; it is the fallback only
            // so that a failure here degrades to "blank video", never to "no widget".
            if (void* loaded = LoadGameMediaTexture())
            {
                AddToRoot(loaded);
                bool bound = false;
                if (void* setPlayer = FindObject("/Script/MediaAssets.MediaTexture.SetMediaPlayer"))
                {
                    struct { void* Player; } sp{ gPlayer };
                    bound = SafePE(loaded, setPlayer, &sp);
                }
                Cobalt::Log::WriteLine(std::string("[UE4] texture: game asset ") + GetName(reinterpret_cast<UObject*>(loaded)) +
                                       " bound to our player: " + (bound ? "ok" : "FAULTED") +
                                       " (reports " + std::to_string(MediaTextureWidth(loaded)) +
                                       " wide before any frame)");
                if (bound) gTexture = loaded;
            }
            else
            {
                Cobalt::Log::WriteLine("[UE4] texture: no game MediaTexture asset could be loaded - the"
                                       " constructed one has no resource and will draw blank");
            }
            // (ListGameMediaAssets used to run here. Discovery is done -- the pak index answered it --
            //  and on this build its registry lookup only produced a MISSING line every session.)

            // SIZE. The previous build read the viewport as 1x1 and then dutifully set the image to
            // 1x1 -- taking a 32-pixel square down to a single pixel. That was my bug, and the shape
            // of it matters: an unchecked value from the engine was trusted over an obviously sane
            // default.
            //
            // So the result is now sanity-checked, and the size never shrinks: whatever the query
            // says, the image is at least as big as it already was.
            float vw = 1920.f, vh = 1080.f;
            if (void* getVp = FindObject("/Script/UMG.WidgetLayoutLibrary.GetViewportSize"))
            {
                if (void* lib = FindObject("/Script/UMG.Default__WidgetLayoutLibrary"))
                {
                    struct { void* World; float X; float Y; } vp{ nullptr, 0.f, 0.f };
                    if (SafePE(lib, getVp, &vp))
                    {
                        Cobalt::Log::WriteLine("[UE4] display: viewport query returned " +
                                               std::to_string((int)vp.X) + "x" + std::to_string((int)vp.Y));
                        // 64 is the floor for "plausibly a screen". 1x1 is not a screen.
                        if (vp.X >= 64.f && vp.Y >= 64.f) { vw = vp.X; vh = vp.Y; }
                        else Cobalt::Log::WriteLine("[UE4] display: implausible - using 1920x1080 instead");
                    }
                }
            }

            const int brushOff = OffsetOf(image, "Brush");
            void* slateBrushStruct = FindObject("/Script/SlateCore.SlateBrush");
            const int sizeOff = OffsetInStruct(slateBrushStruct, "ImageSize");
            Cobalt::Log::WriteLine("[UE4] display: Brush@" + std::to_string(brushOff) +
                                   " ImageSize@" + std::to_string(sizeOff));
            if (brushOff >= 0 && sizeOff >= 0)
            {
                float before[2] = { -1.f, -1.f };
                const bool wrote = SwapImageSize((char*)image + brushOff + sizeOff, vw, vh, before);
                if (wrote)
                    Cobalt::Log::WriteLine("[UE4] display: ImageSize was " +
                                           std::to_string((int)before[0]) + "x" + std::to_string((int)before[1]) +
                                           ", set to " + std::to_string((int)vw) + "x" + std::to_string((int)vh));
                else
                    Cobalt::Log::WriteLine("[UE4] display: writing ImageSize faulted");
            }

            // Added now but HIDDEN, so it is ready the instant Battle Royale is chosen rather than
            // being built at the moment it is needed -- construction takes long enough that doing it
            // on the trigger would show a gap.
            //
            // Hidden BEFORE and AGAIN AFTER AddToViewport, and read back both times. Before, so the
            // Slate widget is built hidden; after, in case building it re-synchronised properties.
            // Hidden is also not hit-testable, which is what gives the player their mouse back.
            int visBefore = ApplyVisibility(widget, image, 2);   // ESlateVisibility::Hidden
            if (void* addToViewport = FindObject("/Script/UMG.UserWidget.AddToViewport"))
            {
                struct { int ZOrder; } p{ 9999 };
                Cobalt::Log::WriteLine(std::string("[UE4] display: AddToViewport ") +
                                       (SafePE(widget, addToViewport, &p) ? "ok" : "faulted"));
            }
            const int visAfter = ApplyVisibility(widget, image, 2);
            Cobalt::Log::WriteLine("[UE4] display: visibility read back " + std::to_string(visBefore) +
                                   " before AddToViewport, " + std::to_string(visAfter) +
                                   " after (2 = Hidden, which is what it must be)");
            if (visAfter != 2)
                Cobalt::Log::WriteLine("[UE4] display: WARNING - the widget is not hidden; it will cover the screen");

            gControlTex = control;
            Cobalt::Log::WriteLine("[UE4] display: built and hidden - waiting for Battle Royale");
            return kBuildDone;
        }

        /** The game-thread task: run one build pass and publish how it ended. */
        void BuildAndShow()
        {
            gBuildOutcome.store(BuildAndShowInner());
        }
    }

    void ShowBumper(void* player, void* texture)
    {
        gPlayer = player;
        gTexture = texture;

        // Runs on the worker that decoded the bumper. Each pass is scheduled onto the game thread
        // and waited for HERE; "no player yet" comes back as an outcome and the next pass goes out
        // a few seconds later. The game thread never sleeps on this.
        for (int attempt = 1; attempt <= 40; ++attempt)
        {
            gBuildOutcome.store(kBuildPending);
            if (!RunOnGameThread(&BuildAndShow))
            {
                Cobalt::Log::WriteLine("[UE4] display: could not schedule onto the game thread");
                return;
            }
            // The task runs on the next ProcessEvent call, which is at most a frame away; the
            // bound is for a game thread that is loading and not calling ProcessEvent at all.
            int waited = 0;
            while (gBuildOutcome.load() == kBuildPending && waited < 30000) { Sleep(50); waited += 50; }

            const int outcome = gBuildOutcome.load();
            if (outcome == kBuildNoPlayer)
            {
                if (attempt == 1)
                    Cobalt::Log::WriteLine("[UE4] display: no local player yet - waiting for the frontend");
                Sleep(3000);
                continue;
            }
            if (outcome == kBuildPending)
                Cobalt::Log::WriteLine("[UE4] display: the game-thread task did not run within 30s");
            return;
        }
        Cobalt::Log::WriteLine("[UE4] display: gave up waiting for a local player after 40 passes");
    }

    // ── THE LOBBY MUSIC ──────────────────────────────────────────────────────────────────────────
    //
    // Choosing Battle Royale starts the lobby music, and the bumper covers the next seven seconds,
    // so the two overlapped and the music was already mid-track when the clip ended. The bumper's
    // own sound goes through Windows (winmm), not the engine, so the engine's music can be silenced
    // underneath it without touching the bumper:
    //
    //   on show:  a SoundMix override at volume 0 on every SoundClass with "Music" in its name,
    //             children included, pushed -- the same mechanism the game's own audio settings use.
    //             Class-level, so music that starts DURING the bumper is covered too.
    //   at end:   restart whatever music component is playing (Stop, then Play from 0), then pop
    //             the mix. The music starts from the top as the bumper ends, which is the point.
    namespace
    {
        void* gMusicMix = nullptr;   // our USoundMix, rooted; created on first use
        int   gMutedClasses = 0;

        /** The world with a local player in it; failing that, the last World object. */
        void* LiveWorld()
        {
            void* getPC = FindObject("/Script/Engine.GameplayStatics.GetPlayerController");
            void* gs = FindObject("/Script/Engine.Default__GameplayStatics");
            void* worldCls = FindObject("/Script/Engine.World");
            if (!getPC || !gs || !worldCls) return nullptr;
            void* fallback = nullptr;
            const int total = ObjectCount();
            for (int i = 0; i < total; ++i)
            {
                void* o = GetObjectByIndex(i);
                if (!o || SafeClassOf(o) != worldCls) continue;
                fallback = o;
                struct { void* World; int Index; char pad[4]; void* Return; } p{ o, 0, {}, nullptr };
                if (SafePE(gs, getPC, &p) && p.Return) return o;
            }
            return fallback;
        }

        /** ASCII lower-case. Not tolower(): that would add a CRT import the DLL does not have today. */
        std::string Lower(std::string s)
        {
            for (auto& c : s) if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
            return s;
        }

        void MuteMusic()
        {
            void* world = LiveWorld();
            void* gs = FindObject("/Script/Engine.Default__GameplayStatics");
            void* setOverride = FindObject("/Script/Engine.GameplayStatics.SetSoundMixClassOverride");
            void* push = FindObject("/Script/Engine.GameplayStatics.PushSoundMixModifier");
            void* mixCls = FindObject("/Script/Engine.SoundMix");
            void* classCls = FindObject("/Script/Engine.SoundClass");
            void* transient = FindObject("/Engine/Transient");
            if (!world || !gs || !setOverride || !push || !mixCls || !classCls || !transient)
            {
                Cobalt::Log::WriteLine(std::string("[UE4] music: cannot mute -") + (world ? "" : " no world") +
                                       (setOverride ? "" : " no SetSoundMixClassOverride") + (push ? "" : " no PushSoundMixModifier") +
                                       (mixCls ? "" : " no SoundMix class") + (classCls ? "" : " no SoundClass class"));
                return;
            }
            if (!gMusicMix)
            {
                gMusicMix = SpawnObject(mixCls, transient);
                if (!gMusicMix) { Cobalt::Log::WriteLine("[UE4] music: could not construct a SoundMix"); return; }
                AddToRoot(gMusicMix);
            }

            const int oWorld = ParamOffset(setOverride, "WorldContextObject");
            const int oMix   = ParamOffset(setOverride, "InSoundMixModifier");
            const int oCls   = ParamOffset(setOverride, "InSoundClass");
            const int oVol   = ParamOffset(setOverride, "Volume");
            const int oPitch = ParamOffset(setOverride, "Pitch");
            const int oFade  = ParamOffset(setOverride, "FadeInTime");
            const int oKids  = ParamOffset(setOverride, "bApplyToChildren");
            const int pWorld = ParamOffset(push, "WorldContextObject");
            const int pMix   = ParamOffset(push, "InSoundMixModifier");
            if (oWorld < 0 || oMix < 0 || oCls < 0 || oVol < 0 || oPitch < 0 || oFade < 0 || oKids < 0 || pWorld < 0 || pMix < 0)
            {
                Cobalt::Log::WriteLine("[UE4] music: SoundMix parameter layout did not resolve");
                return;
            }

            // Every SoundClass named like music. Names are logged so the next person knows what the
            // game actually calls them.
            gMutedClasses = 0;
            const int total = ObjectCount();
            for (int i = 0; i < total && gMutedClasses < 8; ++i)
            {
                void* o = GetObjectByIndex(i);
                if (!o || SafeClassOf(o) != classCls) continue;
                const std::string n = GetName(reinterpret_cast<UObject*>(o));
                if (Lower(n).find("music") == std::string::npos) continue;
                Params p;
                p.at<void*>(oWorld) = world;
                p.at<void*>(oMix)   = gMusicMix;
                p.at<void*>(oCls)   = o;
                p.at<float>(oVol)   = 0.f;
                p.at<float>(oPitch) = 1.f;
                p.at<float>(oFade)  = 0.f;
                p.at<bool>(oKids)   = true;
                if (SafePE(gs, setOverride, p.bytes))
                {
                    ++gMutedClasses;
                    Cobalt::Log::WriteLine("[UE4] music: muting sound class " + n);
                }
            }
            if (gMutedClasses == 0)
            {
                Cobalt::Log::WriteLine("[UE4] music: no SoundClass with 'music' in its name - nothing muted");
                return;
            }
            Params q;
            q.at<void*>(pWorld) = world;
            q.at<void*>(pMix)   = gMusicMix;
            Cobalt::Log::WriteLine(std::string("[UE4] music: mix pushed ") + (SafePE(gs, push, q.bytes) ? "ok" : "FAULTED"));
        }

        void RestartMusicAndUnmute()
        {
            // 1. Restart. Any playing AudioComponent whose sound is named like music: Stop, and if
            //    nothing else started it again in response, Play from the top. The playing sounds
            //    are logged so a music track under another name is findable next time.
            void* acCls = FindObject("/Script/Engine.AudioComponent");
            void* isPlaying = FindObject("/Script/Engine.AudioComponent.IsPlaying");
            void* stop = FindObject("/Script/Engine.AudioComponent.Stop");
            void* play = FindObject("/Script/Engine.AudioComponent.Play");
            int seen = 0, restarted = 0;
            if (acCls && isPlaying && stop && play)
            {
                const int startOff = ParamOffset(play, "StartTime");
                const int total = ObjectCount();
                for (int i = 0; i < total && restarted < 4; ++i)
                {
                    void* o = GetObjectByIndex(i);
                    if (!o) continue;
                    void* cls = SafeClassOf(o);
                    if (!cls || !IsSubclassOf(cls, acCls)) continue;
                    struct { bool R; char pad[7]; } ip{ false, {} };
                    if (!SafePE(o, isPlaying, &ip) || !ip.R) continue;
                    const int soundOff = OffsetOf(o, "Sound");
                    void* snd = soundOff >= 0 ? SafeDeref(o, soundOff) : nullptr;
                    const std::string sn = snd ? GetName(reinterpret_cast<UObject*>(snd)) : std::string("(no sound)");
                    if (++seen <= 12) Cobalt::Log::WriteLine("[UE4] music: playing at bumper end: " + sn);
                    if (Lower(sn).find("music") == std::string::npos) continue;
                    SafePE(o, stop, nullptr);
                    struct { bool R; char pad[7]; } again{ false, {} };
                    SafePE(o, isPlaying, &again);
                    if (!again.R)
                    {
                        Params pp;
                        if (startOff >= 0) pp.at<float>(startOff) = 0.f;
                        SafePE(o, play, pp.bytes);
                    }
                    ++restarted;
                    Cobalt::Log::WriteLine("[UE4] music: restarted " + sn + (again.R ? " (the game restarted it itself)" : ""));
                }
            }
            Cobalt::Log::WriteLine("[UE4] music: " + std::to_string(seen) + " sound(s) playing, " +
                                   std::to_string(restarted) + " music track(s) restarted from the top");

            // 2. Unmute: pop the mix. The music comes up over the mix's own fade-out.
            if (!gMusicMix || gMutedClasses == 0) return;
            void* world = LiveWorld();
            void* gs = FindObject("/Script/Engine.Default__GameplayStatics");
            void* pop = FindObject("/Script/Engine.GameplayStatics.PopSoundMixModifier");
            const int pWorld = pop ? ParamOffset(pop, "WorldContextObject") : -1;
            const int pMix   = pop ? ParamOffset(pop, "InSoundMixModifier") : -1;
            if (!world || !gs || !pop || pWorld < 0 || pMix < 0)
            {
                Cobalt::Log::WriteLine("[UE4] music: cannot pop the mix - the music stays muted this session");
                return;
            }
            Params q;
            q.at<void*>(pWorld) = world;
            q.at<void*>(pMix)   = gMusicMix;
            Cobalt::Log::WriteLine(std::string("[UE4] music: mix popped ") + (SafePE(gs, pop, q.bytes) ? "ok - music audible" : "FAULTED"));
            gMutedClasses = 0;
        }
    }

    void EnumerateCinematics()
    {
        if (!Ready()) return;

        // THE GAME ALREADY PLAYS LOCAL MP4s. FortniteGame/Content/Movies/Events/Winter2018.mp4 is
        // the Season 7 intro, and it ships with subtitle files -- which is what FortMediaSubtitlesPlayer
        // is for. So there IS a working local-video path in this build; four builds have been spent
        // constructing a replacement for it instead of finding it.
        //
        // The movie filenames are absent from the executable because they are referenced from data
        // assets inside the paks, not from C++ literals. So this looks for the machinery at runtime:
        // the subtitles player, anything media-shaped Fortnite defines itself, and any live
        // FileMediaSource or MediaPlayer ASSET (as opposed to the class defaults the census already
        // reported).
        static const char* kProbes[] = {
            "/Script/FortniteGame.FortMediaSubtitlesPlayer",
            "/Script/FortniteGame.Default__FortMediaSubtitlesPlayer",
            "/Script/MediaAssets.MediaSource",
            "/Script/MediaAssets.StreamMediaSource",
            "/Script/MediaAssets.MediaSoundComponent",
            "/Script/Engine.Default__GameViewportClient",
        };
        for (const char* p : kProbes)
            Cobalt::Log::WriteLine(std::string("[UE4] cine: ") + (FindObject(p) ? "FOUND   " : "missing ") + p);

        // Every class Fortnite itself declares whose name looks cinematic. One name lookup per
        // distinct class, same as the media census.
        void* fortMediaCls = FindObject("/Script/FortniteGame.FortMediaSubtitlesPlayer");
        std::vector<void*> seen;
        seen.reserve(4096);
        int hits = 0;
        const int total = ObjectCount();
        for (int i = 0; i < total && hits < 25; ++i)
        {
            void* o = GetObjectByIndex(i);
            if (!o) continue;
            void* cls = SafeClassOf(o);
            if (!cls) continue;
            if (cls == fortMediaCls)
            {
                Cobalt::Log::WriteLine("[UE4] cine: LIVE FortMediaSubtitlesPlayer -> " +
                                       GetName(reinterpret_cast<UObject*>(o)));
                ++hits;
                continue;
            }
            if (std::find(seen.begin(), seen.end(), cls) != seen.end()) continue;
            seen.push_back(cls);
            const std::string n = GetName(reinterpret_cast<UObject*>(cls));
            if (n.empty()) continue;
            if (n.find("Cine") != std::string::npos || n.find("Subtitle") != std::string::npos ||
                (n.find("Fort") == 0 && n.find("Media") != std::string::npos))
            {
                Cobalt::Log::WriteLine("[UE4] cine: class " + n);
                ++hits;
            }
        }
        Cobalt::Log::WriteLine("[UE4] cine: " + std::to_string(hits) + " cinematic-shaped item(s)");
    }

    bool BumperEnabled()
    {
        // A file, not a registry key or a config parser: the launcher writes or deletes it from the
        // Settings switch, and Cobalt only has to answer "is it there". Absent means ON, so the
        // feature works on a fresh install without the launcher having written anything.
        wchar_t buf[MAX_PATH]{};
        if (!GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH)) return true;
        // Double backslashes: the previous spelling had \P and \b in it, which the compiler read as
        // escapes (the build even warned), so this checked a garbled path and never saw the file.
        const std::wstring off = std::wstring(buf) + L"\\ProjectNova\\bumper.off";
        return GetFileAttributesW(off.c_str()) == INVALID_FILE_ATTRIBUTES;
    }

    void OnEnteredBattleRoyale()
    {
        static std::atomic<bool> fired{ false };
        bool expected = false;
        if (!fired.compare_exchange_strong(expected, true)) return;   // once per session

        if (!BumperEnabled())
        {
            Cobalt::Log::WriteLine("[UE4] bumper: switched off in Settings - not playing");
            return;
        }
        if (!gImage || !gSetBrush || !gTexture || !gWidget)
        {
            Cobalt::Log::WriteLine("[UE4] bumper: entered BR but the player is not ready yet");
            return;
        }

        Cobalt::Log::WriteLine("[UE4] bumper: entered Battle Royale - playing");
        RunOnGameThread([]()
        {
            // Restart from the top so it plays in full from this moment, not from wherever the
            // warm-up left it.
            if (void* rewind = FindObject("/Script/MediaAssets.MediaPlayer.Rewind")) {
                struct { bool R; char pad[7]; } p{ false, {} }; SafePE(gPlayer, rewind, &p);
            }
            if (void* play = FindObject("/Script/MediaAssets.MediaPlayer.Play")) {
                struct { bool R; char pad[7]; } p{ false, {} }; SafePE(gPlayer, play, &p);
            }
            // Same moment as Play, same thread, so the two start within a frame of each other.
            StartAudio();
            // And the game's music goes quiet underneath, until the bumper ends.
            MuteMusic();
            struct { void* Texture; bool MatchSize; char pad[7]; } b{ gTexture, false, {} };
            SafePE(gImage, gSetBrush, &b);
            // Visible, not just un-hidden: Visible is hit-testable, so a full-screen widget takes
            // the clicks for the seven seconds it is up. That is what unskippable means.
            const int vis = ApplyVisibility(gWidget, gImage, 0);   // ESlateVisibility::Visible
            Cobalt::Log::WriteLine("[UE4] bumper: shown - visibility read back " + std::to_string(vis) +
                                   " (0 = Visible)");
        });

        // Remove it when the clip ends. Unskippable is the point, so nothing watches for input --
        // the only way past it is the Settings switch, and the only way out is the clip finishing.
        CreateThread(nullptr, 0, [](LPVOID) -> DWORD
        {
            Sleep(7200);   // 6.867s of video, plus a beat
            RunOnGameThread([]()
            {
                // The proof, in the log rather than a screenshot: a MediaTexture reports the size
                // of the last frame it rendered. 854 means frames were drawn; 0 means none were.
                const int w = MediaTextureWidth(gTexture);
                if (void* remove = FindObject("/Script/UMG.UserWidget.RemoveFromViewport"))
                    SafePE(gWidget, remove, nullptr);
                if (void* stop = FindObject("/Script/MediaAssets.MediaPlayer.Close"))
                    SafePE(gPlayer, stop, nullptr);
                StopAudio();
                RestartMusicAndUnmute();
                Cobalt::Log::WriteLine("[UE4] bumper: finished - back to the lobby (texture reported " +
                                       std::to_string(w) + " wide during playback; 854 = frames drawn, 0 = none)");
            });
            return 0;
        }, nullptr, 0, nullptr);
    }

    void SelfTest()
    {
        if (!Ready())
        {
            Cobalt::Log::WriteLine("[UE4] probe skipped - engine not ready");
            return;
        }

        // ── WHY THIS PROBES REPEATEDLY, AND WHY THE CONTROLS ARE FUNCTIONS ──────────────────────
        //
        // The first version ran once, the moment the object array became non-empty, and reported
        // 4,527 objects live - the engine barely awake, fifteen seconds before the game made its
        // first network call. Every /Script/ CLASS resolved; both UFUNCTIONS missed.
        //
        // That is exactly what "too early" looks like: compiled-in classes are registered at static
        // init, their UFunction children in a later pass. But it is ALSO what "wrong path syntax"
        // looks like, and the two need completely different fixes.
        //
        // So the control set now includes functions Project Reboot resolves successfully on this
        // build with this exact dotted syntax (/Script/Engine.Actor.ForceNetUpdate). If those miss
        // alongside the media ones, the problem is function lookup in general and the paths are a
        // red herring. If they resolve and the media ones do not, the names are genuinely different
        // here and enumeration is the next step. Either way the answer is unambiguous, which the
        // single-shot version was not.
        struct Probe { const char* what; const char* path; };
        static const Probe probes[] = {
            // Controls - classes.
            { "CTRL class    ", "/Script/Engine.KismetSystemLibrary" },
            // Controls - FUNCTIONS. Reboot resolves both of these on 7.40.
            { "CTRL function ", "/Script/Engine.Actor.ForceNetUpdate" },
            { "CTRL function ", "/Script/Engine.Actor.K2_GetActorLocation" },
            // What the bumper needs.
            { "media player  ", "/Script/MediaAssets.MediaPlayer" },
            { "media texture ", "/Script/MediaAssets.MediaTexture" },
            { "file source   ", "/Script/MediaAssets.FileMediaSource" },
            { "umg image     ", "/Script/UMG.Image" },
            { "fn OpenFile   ", "/Script/MediaAssets.MediaPlayer.OpenFile" },
            { "fn OpenSource ", "/Script/MediaAssets.MediaPlayer.OpenSource" },
            { "fn OpenUrl    ", "/Script/MediaAssets.MediaPlayer.OpenUrl" },
            { "fn Play       ", "/Script/MediaAssets.MediaPlayer.Play" },
            { "fn SetMediaPlr", "/Script/MediaAssets.MediaTexture.SetMediaPlayer" },
            { "fn SetBrushTex", "/Script/UMG.Image.SetBrushFromTexture" },
            { "fn AddToVwport", "/Script/UMG.UserWidget.AddToViewport" },
        };
        static const int kProbeCount = sizeof(probes) / sizeof(probes[0]);

        // Staged: the point is to watch results CHANGE as the engine fills in, which is the only
        // way to separate "not there yet" from "not there". Bounded and quiet - it logs a line per
        // pass, stops as soon as everything resolves, and gives up rather than looping forever.
        static const int kWaitsMs[] = { 0, 5000, 10000, 20000, 30000, 60000 };
        static const int kStages = sizeof(kWaitsMs) / sizeof(kWaitsMs[0]);

        for (int stage = 0; stage < kStages; ++stage)
        {
            if (kWaitsMs[stage] > 0) Sleep(kWaitsMs[stage]);
            if (!Ready()) continue;

            int found = 0;
            std::vector<std::string> missing;
            for (int i = 0; i < kProbeCount; ++i)
            {
                if (FindObject(probes[i].path)) { ++found; continue; }
                missing.push_back(std::string(probes[i].what) + " " + probes[i].path);
            }

            Cobalt::Log::WriteLine(
                "[UE4] probe " + std::to_string(stage + 1) + "/" + std::to_string(kStages) +
                " at " + std::to_string(ObjectCount()) + " objects: " +
                std::to_string(found) + "/" + std::to_string(kProbeCount) + " resolved");
            // One line each: the Logs tab is line-oriented, and a miss is the thing worth reading.
            for (const auto& m : missing)
                Cobalt::Log::WriteLine("[UE4]      MISSING " + m);

            if (found == kProbeCount)
            {
                Cobalt::Log::WriteLine("[UE4] everything the bumper needs is live - stopping probe");
                EnumerateMedia();
                EnumerateCinematics();
                TryDecodeBumper();
                return;
            }
        }
        Cobalt::Log::WriteLine("[UE4] probe finished with items still unresolved (see the last pass)");
    }
}
