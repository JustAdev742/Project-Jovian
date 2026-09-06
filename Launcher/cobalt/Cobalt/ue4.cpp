#include "ue4.h"
#include "log.h"

#include <Windows.h>
#include <vector>
#include <atomic>
#include <algorithm>

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
                return;
            }
        }
        Cobalt::Log::WriteLine("[UE4] probe finished with items still unresolved (see the last pass)");
    }
}
