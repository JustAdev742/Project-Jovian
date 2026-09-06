#include "ue4.h"
#include "log.h"

#include <Windows.h>
#include <vector>
#include <atomic>
#include <algorithm>
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

    // ── DISPLAY ──────────────────────────────────────────────────────────────────────────────────
    //
    // A UUserWidget created from native code has no WidgetTree -- normally the blueprint's generated
    // class supplies one -- so it adds to the viewport and draws nothing. The tree and its root have
    // to be built by hand, which is what the property offsets above are for.
    namespace
    {
        void* gPlayer = nullptr;
        void* gTexture = nullptr;

        void BuildAndShow()
        {
            if (!gTexture) { Cobalt::Log::WriteLine("[UE4] display: no texture"); return; }

            void* transient = FindObject("/Engine/Transient");
            void* userWidgetCls = FindObject("/Script/UMG.UserWidget");
            void* widgetTreeCls = FindObject("/Script/UMG.WidgetTree");
            void* imageCls = FindObject("/Script/UMG.Image");
            if (!transient || !userWidgetCls || !widgetTreeCls || !imageCls)
            {
                Cobalt::Log::WriteLine("[UE4] display: a UMG class is missing (UserWidget/WidgetTree/Image)");
                return;
            }

            void* widget = SpawnObject(userWidgetCls, transient);
            void* tree = widget ? SpawnObject(widgetTreeCls, widget) : nullptr;
            void* image = tree ? SpawnObject(imageCls, tree) : nullptr;
            Cobalt::Log::WriteLine(std::string("[UE4] display: widget=") + (widget ? "ok" : "FAIL") +
                                   " tree=" + (tree ? "ok" : "FAIL") + " image=" + (image ? "ok" : "FAIL"));
            if (!widget || !tree || !image) return;

            const int treeOff = OffsetOf(widget, "WidgetTree");
            const int rootOff = OffsetOf(tree, "RootWidget");
            Cobalt::Log::WriteLine("[UE4] display: WidgetTree@" + std::to_string(treeOff) +
                                   " RootWidget@" + std::to_string(rootOff));
            if (treeOff < 0 || rootOff < 0)
            {
                Cobalt::Log::WriteLine("[UE4] display: could not locate the properties to wire the tree");
                return;
            }
            SafeWritePtr(tree, rootOff, image);
            SafeWritePtr(widget, treeOff, tree);

            // ProcessEvent does not type-check, so the MediaTexture goes straight into the brush's
            // resource slot even though the parameter is declared UTexture2D*. Slate draws whatever
            // the brush's ResourceObject is.
            if (void* setBrush = FindObject("/Script/UMG.Image.SetBrushFromTexture"))
            {
                struct { void* Texture; bool MatchSize; char pad[7]; } p{ gTexture, false, {} };
                Cobalt::Log::WriteLine(std::string("[UE4] display: SetBrushFromTexture ") +
                                       (SafePE(image, setBrush, &p) ? "ok" : "faulted"));
            }

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
            if (void* update = FindObject("/Script/Engine.Texture.UpdateResource"))
                Cobalt::Log::WriteLine(std::string("[UE4] display: UpdateResource ") +
                                       (SafePE(gTexture, update, nullptr) ? "ok" : "faulted"));
            else
                Cobalt::Log::WriteLine("[UE4] display: Texture.UpdateResource not found");

            // Viewport size, so the image covers the screen instead of sitting at a default.
            float vw = 1920.f, vh = 1080.f;
            if (void* getVp = FindObject("/Script/UMG.WidgetLayoutLibrary.GetViewportSize"))
            {
                if (void* lib = FindObject("/Script/UMG.Default__WidgetLayoutLibrary"))
                {
                    struct { void* World; float X; float Y; } vp{ nullptr, 0.f, 0.f };
                    if (SafePE(lib, getVp, &vp) && vp.X > 0.f && vp.Y > 0.f) { vw = vp.X; vh = vp.Y; }
                }
            }
            Cobalt::Log::WriteLine("[UE4] display: viewport " + std::to_string((int)vw) + "x" + std::to_string((int)vh));

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

            if (void* addToViewport = FindObject("/Script/UMG.UserWidget.AddToViewport"))
            {
                struct { int ZOrder; } p{ 9999 };
                Cobalt::Log::WriteLine(std::string("[UE4] display: AddToViewport ") +
                                       (SafePE(widget, addToViewport, &p) ? "ok" : "faulted"));
            }
            Cobalt::Log::WriteLine("[UE4] display: done - if the bumper is visible, this is it");
        }
    }

    void ShowBumper(void* player, void* texture)
    {
        gPlayer = player;
        gTexture = texture;
        if (!RunOnGameThread(&BuildAndShow))
            Cobalt::Log::WriteLine("[UE4] display: could not schedule onto the game thread");
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
                TryDecodeBumper();
                return;
            }
        }
        Cobalt::Log::WriteLine("[UE4] probe finished with items still unresolved (see the last pass)");
    }
}
