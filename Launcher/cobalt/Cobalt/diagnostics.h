#pragma once

//==================================================================================================
//  Structured diagnostics for the in-process components.
//
//  SHARED BETWEEN TWO PROJECTS — Cobalt (in the game client) and Project Reboot (in the gameserver).
//  The two copies are BYTE-IDENTICAL and must stay that way; the central dashboard's ability to
//  compare a client failure against a host failure depends on both emitting the same schema.
//
//  Copied rather than referenced by a relative path on purpose: Reboot is built from two locations
//  (this tree and backends/_extracted/Project-Reboot-main per RELEASING.md), and a `../../..` include
//  that resolves in one and not the other is a worse problem than a duplicate file.
//
//  `Launcher/cobalt/Cobalt/tests/build-and-run.cmd` fails if the copies have drifted.
//
//
//  WHAT THIS IS FOR, AND WHY IT IS NOT JUST MORE LOGGING.
//
//  Cobalt already ships every std::cout line to the backend (log.h). That is the right tool for
//  reading what one machine did, and the wrong tool for answering "how many players are hitting
//  this, on which build, and is it getting worse". Free text cannot be counted, grouped or ranked,
//  and shipping every line from every player would be a lot of bandwidth to produce a pile nobody
//  can query.
//
//  So this is a SECOND, much smaller channel: a bounded set of structured events, aggregated
//  locally, flushed rarely. One row per distinct problem with an occurrence count — not one row per
//  occurrence.
//
//  WHAT IT COSTS. This is the part that has to be true rather than hoped for, because it runs inside
//  the game:
//    * Report() takes a lock, hashes a short key, and either increments a counter or inserts into a
//      map capped at 64 entries. No I/O, no allocation beyond the key on first sight of a problem.
//    * The map is bounded, so a pathological failure loop costs a counter increment, not memory.
//    * One background thread, shared with nothing, flushes every 30 seconds — 120x less often than
//      the log channel's 750ms, because these are aggregates and nobody needs them sooner.
//    * If the backend is unreachable the queue simply stops growing at its cap. Telemetry must never
//      be the reason a player cannot play, so nothing here blocks, retries hard, or fails loudly.
//
//  WHAT IT MUST NEVER DO.
//    * Never send a token, cookie, password or key. Cobalt SEES bearer tokens — it hooks the function
//      that sets curl's URL — so this is a real risk, not a theoretical one. Redact() strips them
//      before anything is queued, and the backend redacts again on receipt. Two layers, because the
//      cost of a miss is a live credential in a database.
//    * Never carry an account id. The in-game component has no business handling identity; the
//      launcher attributes events when it forwards them.
//    * Never block a game thread.
//==================================================================================================

#include <string>

namespace Nova::Diag
{
    /// Which component observed the failure. Matches DiagnosticSource in the backend schema.
    enum class Source
    {
        Client,   // Cobalt, inside the game client
        Host,     // Reboot, inside the gameserver
        Network,  // the request never reached anything
        Version,  // a build/compatibility mismatch
    };

    /// Failure taxonomy. Matches DiagnosticCategory in the backend schema; names are sent verbatim
    /// and the backend normalises aliases, so adding one here needs no server change.
    enum class Category
    {
        Missing,            // no route matched — the catch-all answered
        Failed,             // the server rejected it
        Timeout,
        AuthFailure,
        InvalidResponse,
        UnexpectedState,
        NetworkFailure,
        VersionMismatch,
        SessionFailure,
        MatchmakingFailure,
        PartyFailure,
        Crash,
        Unknown,
    };

    /// Start the aggregator and its flush thread. Safe to call twice; cheap if diagnostics are off.
    /// `component` is "cobalt" or "reboot"; `build` is the client build id, e.g. "7.40".
    void Init(const char* component, const char* build);

    /// Best-effort final flush. Does NOT join the thread — joining from DllMain deadlocks against
    /// the loader lock, which is the same reason log.h refuses to.
    void Shutdown();

    /// Record one failure. Cheap, non-blocking, callable from any thread including a curl hook.
    ///
    /// `url` is the path or operation. `detail` is short free text and is redacted before storage.
    /// Repeats of the same (category, method, url) collapse into one row with a count.
    void Report(Source source, Category category, const char* method, const std::string& url,
                int status = 0, const std::string& detail = {});

    /// Attach a correlation id to subsequent reports on THIS thread, so one player action can be
    /// followed from the game through the backend to the host. Pass an empty string to clear.
    void SetCorrelationId(const std::string& id);

    /// Generate a fresh correlation id. Short, opaque, and not derived from anything identifying.
    std::string NewCorrelationId();

    /// Strip credentials from a string. Exposed for testing and for callers that build their own
    /// detail text. Handles `eg1~…` tokens, bare JWTs, and common secret query parameters.
    std::string Redact(const std::string& text);
}
