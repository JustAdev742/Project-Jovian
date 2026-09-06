#include "ue4.h"
#include "log.h"

#include <Windows.h>
#include <vector>
#include <atomic>

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

    void SelfTest()
    {
        if (!Ready())
        {
            Cobalt::Log::WriteLine("[UE4] self-test skipped — engine not ready");
            return;
        }

        Cobalt::Log::WriteLine("[UE4] self-test: " + std::to_string(ObjectCount()) + " objects live");

        // The inventory that decides whether the in-game bumper is buildable.
        //
        // A binary scan already said these strings are in the executable. That is a weaker claim
        // than it sounds — it cannot distinguish a live UClass from a leftover symbol. Resolving
        // them through StaticFindObject in the running process is the real answer.
        struct Probe { const char* what; const char* path; };
        static const Probe probes[] = {
            // Control. If this misses, the lookup itself is broken and nothing below means anything.
            { "control",       "/Script/Engine.KismetSystemLibrary" },
            { "media player",  "/Script/MediaAssets.MediaPlayer" },
            { "media texture", "/Script/MediaAssets.MediaTexture" },
            { "file source",   "/Script/MediaAssets.FileMediaSource" },
            { "media sound",   "/Script/MediaAssets.MediaSoundComponent" },
            { "umg image",     "/Script/UMG.Image" },
            { "umg library",   "/Script/UMG.WidgetBlueprintLibrary" },
            // The call we would make to start playback.
            { "OpenFile fn",   "/Script/MediaAssets.MediaPlayer.OpenFile" },
            { "SetMediaPlayer","/Script/MediaAssets.MediaTexture.SetMediaPlayer" },
        };

        int found = 0;
        for (const auto& p : probes)
        {
            const bool ok = FindObject(p.path) != nullptr;
            if (ok) ++found;
            Cobalt::Log::WriteLine(std::string("[UE4]   ") + (ok ? "FOUND   " : "MISSING ") + p.what + "  " + p.path);
        }
        Cobalt::Log::WriteLine("[UE4] self-test: " + std::to_string(found) + "/" +
                               std::to_string(sizeof(probes) / sizeof(probes[0])) + " resolved");
    }
}
