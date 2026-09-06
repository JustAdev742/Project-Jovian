#pragma once
/**
 * Cobalt's hook-target signature registry, and the report that makes porting to a new build possible.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Cobalt finds its hook targets by scanning the client for byte patterns. Whether it works on a
 * given build is therefore entirely a question of whether those patterns are present — and until
 * now, the only way to find out was to run the game and see whether the redirect happened. When it
 * did not, nothing said which target had failed, or whether a fallback had matched something wrong.
 *
 * You cannot answer it from the file either, and that is the constraint that shapes this design:
 * **the shipping client's `.text` section is encrypted on disk.** Measured on 7.40 — Shannon entropy
 * 8.00, the maximum possible, across two `.text` sections (a protector's stub plus its payload).
 * `.rdata` is plain, so STRING scans of the file work perfectly and give a thoroughly false
 * impression that code scans should too. `tools/sigcheck.mjs` reports 0 of 41 signatures present on
 * 7.40, a build Cobalt demonstrably works on.
 *
 * So the decrypted code only exists in the running process, and Cobalt is already in there scanning
 * it. That makes Cobalt the only thing that CAN answer the question — hence this registry and
 * `Report()`.
 *
 * ── HOW TO PORT COBALT TO A NEW BUILD ────────────────────────────────────────────────────────────
 *
 *   1. Install the build and launch it once through the launcher.
 *   2. Read the SIGNATURE COVERAGE block in the Cobalt log (it is also raised as a diagnostic, so it
 *      appears on the coordinator dashboard).
 *   3. Every target listed `MISSING` needs a pattern for that build. Add it to the table below with
 *      a note naming the build; that is a data change, not a code change.
 *   4. Re-run. The block should show every REQUIRED target resolved.
 *
 * A target reported `AMBIGUOUS` is the dangerous case and the reason the count is printed rather
 * than a bare yes/no: the scanner takes the FIRST match, so a pattern that hits twice may be hooking
 * the wrong function. That fails in ways that look like anything except a bad signature.
 */

#include <Windows.h>
#include <cstdint>
#include <string>
#include <vector>

#include "log.h"
#include "diagnostics.h"

namespace Cobalt::Signatures
{
    /** What a target is for, which decides how loudly a miss is reported. */
    enum class Need
    {
        /// Without this, the redirect does not happen at all and the game talks to Epic.
        Required,
        /// Improves behaviour; its absence is survivable and already handled at the call site.
        Optional,
    };

    struct Pattern
    {
        /// Which hook target this pattern resolves.
        const char* target;
        /// The byte pattern, in the `48 89 ? 24` form `sigscan` accepts.
        const char* bytes;
        /// Which build(s) it was written for. Free text, but say something — an unlabelled
        /// signature is one nobody can reason about later.
        const char* build;
        Need need;
    };

    /**
     * Every pattern Cobalt knows, grouped by target and ordered best-guess first.
     *
     * The order matters and matches what the resolver does: the first pattern that matches wins, so
     * the most specific / most-tested one for the primary target build goes first.
     *
     * Notes marked "or sum" are inherited verbatim from upstream and their build ranges are the
     * author's, not verified here. They are kept rather than tidied because a vague attribution is
     * still more than none, and rewriting it to look confident would be worse.
     */
    inline const std::vector<Pattern>& Table()
    {
        static const std::vector<Pattern> kTable = {
            // ── curl_easy_setopt — the URL rewrite AND the TLS-verification bypass ──────────────
            // This is the whole redirect. Without it nothing else in Cobalt matters.
            { "curl_easy_setopt",
              "89 54 24 10 4C 89 44 24 18 4C 89 4C 24 20 48 83 EC 28 48 85 C9 75 08 8D 41 2B 48 83 C4 28 C3 4C",
              "7.40 (primary target)", Need::Required },

            // ── curl_setopt — the internal setter curl_easy_setopt forwards to ──────────────────
            // Optional: the call site already says "we will go ahead" without it.
            { "curl_setopt",
              "48 89 5C 24 08 48 89 6C 24 10 48 89 74 24 18 57 48 83 EC 30 33 ED 49 8B F0 48 8B D9",
              "7.40", Need::Optional },
            { "curl_setopt",
              "48 89 5C 24 08 48 89 6C 24 10 56 57 41 56 48 83 EC 50 33 ED 49 8B F0 8B DA 48 8B F9",
              "later builds (upstream, unlabelled)", Need::Optional },
            { "curl_setopt",
              "48 89 5C 24 ? 55 56 57 41 56 41 57 48 83 EC 50 33 DB 49 8B F0 48 8B F9 8B EB 81 FA",
              "28.00 (upstream: tested)", Need::Optional },

            // ── PushWidget — no longer used to choose a hooking method ──────────────────────────
            // Kept ONLY because these three carry the only later-build attributions Cobalt has, and
            // a run on a new build reporting which of them matches is genuine evidence about that
            // build. See the comment on the curl hook in dllmain.cpp for why the method choice this
            // used to drive was removed: a VEH hook on curl is not merely slower, it is wrong.
            { "PushWidget",
              "48 89 5C 24 ? 48 89 6C 24 ? 48 89 74 24 ? 57 48 83 EC 30 48 8B E9 49 8B D9 48 8D 0D ? ? ? ? 49 8B F8 48 8B F2 E8 ? ? ? ? 4C 8B CF 48 89 5C 24 ? 4C 8B C6 48 8B D5 48 8B 48 78",
              "never matches on 7.40", Need::Optional },
            { "PushWidget",
              "48 8B C4 4C 89 40 18 48 89 50 10 48 89 48 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D 68 B8 48 81 EC ? ? ? ? 65 48 8B 04 25",
              "26.00+ (upstream: 'or sum')", Need::Optional },
            { "PushWidget",
              "48 8B C4 48 89 58 10 48 89 70 18 48 89 78 20 55 41 56 41 57 48 8D 68 A1 48 81 EC ? ? ? ? 65 48 8B 04 25 ? ? ? ? 48 8B F9 B9 ? ? ? ? 49",
              "28.00+ (upstream: 'or sum')", Need::Optional },

            // ── The 8.51 memory-leak fix — behind #if 0 at the call site, listed for coverage ────
            { "MemoryLeakFix",
              "4C 8B DC 55 57 41 56 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 48 8B 01 41 B6",
              "8.51", Need::Optional },
        };
        return kTable;
    }

    /** One target's outcome across every pattern that claims to resolve it. */
    struct Coverage
    {
        std::string target;
        Need need;
        /// Index into Table() of the pattern that matched, or -1.
        int matchedPattern = -1;
        const char* matchedBuild = nullptr;
        int patternsTried = 0;
    };

    /**
     * Scan every known pattern and report what this build actually has.
     *
     * `scan` is passed in rather than called directly so this header stays free of memcury and can
     * be unit-tested with a stub. It must return 0 for "not found".
     *
     * Deliberately NOT used to drive hook installation — the call sites keep their own resolution so
     * that adding a diagnostic can never change which address gets hooked. This only observes.
     */
    template <typename ScanFn>
    inline std::vector<Coverage> Measure(ScanFn scan)
    {
        std::vector<Coverage> out;
        for (size_t i = 0; i < Table().size(); ++i)
        {
            const Pattern& p = Table()[i];

            // Index, not a pointer: push_back below can reallocate, and a Coverage* taken before it
            // would dangle. It happens to be safe as written today only because nothing else pushes
            // between taking the pointer and using it, which is exactly the kind of "safe for now"
            // that breaks when someone adds a line.
            size_t at = out.size();
            for (size_t j = 0; j < out.size(); ++j)
                if (out[j].target == p.target) { at = j; break; }
            if (at == out.size())
                out.push_back(Coverage{ p.target, p.need, -1, nullptr, 0 });

            out[at].patternsTried++;

            // Once a target has resolved, later patterns for it are not tried — mirroring the
            // first-match-wins behaviour of the real call sites. Measuring them anyway would
            // report coverage the running code would never have used.
            if (out[at].matchedPattern >= 0) continue;

            if (scan(p.bytes))
            {
                out[at].matchedPattern = static_cast<int>(i);
                out[at].matchedBuild = p.build;
            }
        }
        return out;
    }

    /**
     * Write the coverage report to the Cobalt log, and raise a diagnostic when a required target is
     * missing so an unsupported build is visible on the coordinator dashboard rather than only in a
     * log nobody has asked for yet.
     *
     * `build` is the client build string as Cobalt knows it.
     */
    inline void Report(const std::vector<Coverage>& cov, const char* build)
    {
        int missingRequired = 0;
        std::string missingList;

        Cobalt::Log::WriteLine("── SIGNATURE COVERAGE ──────────────────────────────────────");
        Cobalt::Log::WriteLine(std::string("build: ") + (build ? build : "unknown"));

        for (const auto& c : cov)
        {
            const bool required = c.need == Need::Required;
            std::string line = "  " + c.target;
            line += required ? "  [required]  " : "  [optional]  ";

            if (c.matchedPattern >= 0)
            {
                line += "resolved  <- ";
                line += c.matchedBuild ? c.matchedBuild : "unlabelled pattern";
            }
            else
            {
                line += "MISSING   (";
                line += std::to_string(c.patternsTried);
                line += c.patternsTried == 1 ? " pattern tried)" : " patterns tried)";
                if (required)
                {
                    missingRequired++;
                    if (!missingList.empty()) missingList += ", ";
                    missingList += c.target;
                }
            }
            Cobalt::Log::WriteLine(line);
        }

        if (missingRequired > 0)
        {
            Cobalt::Log::WriteLine("  -> a REQUIRED target has no pattern for this build.");
            Cobalt::Log::WriteLine("     Add one to Cobalt/signatures.h; see the porting steps at the top of that file.");
            Nova::Diag::Report(Nova::Diag::Source::Version,
                               Nova::Diag::Category::VersionMismatch,
                               "SIGSCAN", missingList, 0,
                               "no signature matches this build");
        }
        Cobalt::Log::WriteLine("────────────────────────────────────────────────────────────");
    }
}
