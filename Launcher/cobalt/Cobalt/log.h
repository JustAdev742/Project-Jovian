#pragma once

//==================================================================================================
//  Cobalt logging — the ONLY change to Cobalt's behaviour.
//
//  Cobalt's code is unmodified and still writes everything with `std::cout << ...`. The single
//  difference is where that output lands. Previously Main() called AllocConsole() + freopen on
//  CONOUT$, which opened a second console window beside the game: easy to close by accident (which
//  killed the game with it), and nothing was ever recorded.
//
//  Init() instead swaps std::cout's stream buffer for one that forwards each completed line to:
//    1. the Nova backend over HTTP, so it shows up in the launcher's Logs tab tagged "cobalt", and
//    2. %LOCALAPPDATA%\ProjectNova\Logs\cobalt.log, so there is a record even with no backend.
//
//  No call sites change. No hooking, threading or curl behaviour changes.
//
//  Constraints, because std::cout is written from the curl hook on the game's own threads:
//    * Appending a line only takes a lock and pushes — NO file or network I/O on that path.
//    * The queue is bounded; on overflow the oldest lines are dropped and counted.
//    * One background thread we own does all the actual I/O.
//    * Nothing is joined from DllMain — that would deadlock against the loader lock.
//==================================================================================================

#include <string>

namespace Cobalt::Log
{
    /// Redirect std::cout and start the background writer. Safe to call twice.
    void Init();

    /// Best-effort flush from DLL_PROCESS_DETACH. Does not join the writer thread.
    void Shutdown();

    /// Queue one already-formatted line. Cheap, non-blocking, callable from any thread.
    void WriteLine(std::string line);

    /// Publish a one-line status for the launcher to display (e.g. "active, redirecting to ...").
    void SetStatus(std::string status, bool healthy);
}
