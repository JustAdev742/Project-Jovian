#pragma once
//
// A minimal Unreal reflection layer for Cobalt.
//
// ── WHY COBALT NEEDS ONE AT ALL ──────────────────────────────────────────────────────────────────
//
// Cobalt hooks curl and nothing else. It has never touched an Unreal object, which is fine for
// redirecting HTTP — and useless for anything that has to happen *inside the game*, such as playing
// a bumper when the player enters Battle Royale.
//
// Project Reboot already has this plumbing, 524 call sites of it. But Reboot runs in the GAMESERVER
// process, and a bumper has to render on every player's own client. Only Cobalt is there.
//
// ── WHY THIS IS A PORT AND NOT A REWRITE ─────────────────────────────────────────────────────────
//
// Reboot resolves `ProcessEvent`, `StaticFindObject` and the object array by byte-pattern scan
// against the loaded module — and the client and the gameserver are THE SAME EXECUTABLE
// (`FortniteClient-Win64-Shipping.exe`, launched twice with different arguments). So Reboot's 4.22
// patterns resolve identically in the client process. Nothing here was derived independently; the
// patterns below are lifted from `Project Reboot/patterns.h`, `Engine_Version == 422`.
//
// That is the whole reason this is tractable: no new signature work for 7.40.
//
// ── SCOPE ────────────────────────────────────────────────────────────────────────────────────────
//
// Deliberately small. Reboot's `structs.h` is 1,274 lines because it drives an entire game mode;
// this needs to find objects, call functions, and read a property offset. Anything beyond that is
// not ported until something actually requires it — a large surface copied "in case" is a large
// surface to be wrong in.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────────────────────────
//
// Cobalt lives inside the game, and the game must not die because a diagnostic did. Every entry
// point here is non-throwing and returns null / false when the engine is not ready, which is the
// normal state for the first seconds of a launch. `Ready()` is the only thing a caller needs to
// check, and nothing here installs a hook or mutates engine state.
//
#include <cstdint>
#include <string>

namespace Nova::UE4
{
    /** Opaque — this layer deliberately does not model UObject's layout beyond what it needs. */
    struct UObject;
    struct UFunction;

    /**
     * Resolve the engine entry points. Safe to call more than once; only the first does work.
     *
     * Returns false when the patterns do not match, which is the expected answer on a build this
     * was not written for. It is not an error and must not be treated as one — Cobalt's job is
     * redirecting HTTP, and that keeps working regardless.
     */
    bool Init();

    /** Whether the engine entry points resolved AND the object array is populated. */
    bool Ready();

    /** `/Script/Engine.KismetSystemLibrary`, `/Script/MediaAssets.MediaPlayer`, … Null when absent. */
    UObject* FindObject(const std::string& path);

    /** Call a UFunction on an object. `params` must match the function's parameter struct. */
    void ProcessEvent(UObject* object, UFunction* function, void* params);

    /** Convenience: find a UFunction by full path. */
    UFunction* FindFunction(const std::string& path);

    /** How many objects the engine currently holds. 0 before the array is up. */
    int ObjectCount();

    /** An object's name, via KismetSystemLibrary.GetObjectName. Empty when unavailable. */
    std::string GetName(UObject* object);

    /**
     * Census of everything media-shaped the game already has.
     *
     * This decides how the bumper gets on screen. Driving UE4's media framework from scratch means
     * building a widget to show the texture in, which is the hard part; if Fortnite already owns a
     * player/texture/widget for its own videos, reusing that is far cheaper and far less likely to
     * fight the game's UI. That is not answerable by reading the binary — only by looking at what is
     * actually constructed at runtime.
     */
    void EnumerateMedia();

    /**
     * Try to actually decode the bumper: construct a MediaPlayer, open the file, bind a
     * MediaTexture, and report what happened.
     *
     * The first thing here that is not a probe. It stops short of drawing anything -- the census
     * proved the game builds no media UI of its own, so a display surface has to be constructed
     * too, and there is no point building one until the file is known to decode in-process.
     * Reports the exact path used and the duration the engine read back.
     */
    void TryDecodeBumper();

    /**
     * Put a media texture on screen: build a widget tree by hand, point an Image at the texture,
     * and add it to the viewport.
     *
     * Runs on the GAME THREAD. Constructing a MediaPlayer off-thread happened to work; Slate will
     * not be so forgiving, and this DLL is in every player's client.
     */
    void ShowBumper(void* player, void* texture);

    /** Schedule a callback onto the game thread via a ProcessEvent detour. */
    bool RunOnGameThread(void (*task)());

    /**
     * Log what resolved and which classes the bumper needs are actually live.
     *
     * THIS IS THE POINT OF THE FIRST BUILD. A binary scan can only say a string exists in the
     * executable; this says the UClass exists in the running process, which is the claim that
     * actually matters. It writes to cobalt.log and changes nothing.
     */
    void SelfTest();
}
