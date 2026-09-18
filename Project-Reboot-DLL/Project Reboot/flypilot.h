#pragma once

// ── FLY PILOT (EXPERIMENTAL) ─────────────────────────────────────────────────────────────────────
// Drives a pawn from a simulation of a real fly brain: the Janelia male CNS connectome, 168,730
// neurons and 15.27M connections, every weight a counted synapse from the electron-microscopy
// reconstruction. It is off unless flypilot.json next to the exe says otherwise, and it is an
// experiment, not a feature — see FINDINGS.md in fly-pilot/ for what it does and does not do.
//
// Why this lives server-side rather than driving a mouse: the fly should be a participant in the
// match, not a program pressing keys on somebody's desktop. That also buys a better eye. A compound
// eye is a bundle of ~892 fixed-direction sampling tubes per side, so instead of scraping a rendered
// frame we hand each ommatidium its own direction into the world and ask what lies along it. The
// retinotopy comes out of the connectome itself (see fly-pilot/flypilot/atlas.py).
//
// Threading: the network runs on its own thread and never touches a UObject. The game thread writes
// a small float image into one buffer and reads a handful of floats out of another, both under a
// short mutex. A stall in the brain therefore costs frames of fly reaction time, never server hitches.

#include "definitions.h"

namespace FlyPilot
{
	// What the brain is asking the body to do. All in -1..1 except the flags.
	struct Command
	{
		float Forward = 0.f;
		float Strafe = 0.f;       // + is right
		float Yaw = 0.f;          // + is turn right
		float Pitch = 0.f;        // + is look up
		float Sprint = 0.f;
		float Fire = 0.f;         // reported only, never wired to a weapon: see flypilot.cpp
		bool  Jump = false;
		float Freeze = 0.f;
	};

	// Telemetry for the log and for the launcher's diagnostics tab.
	struct Stats
	{
		bool   Loaded = false;
		bool   Running = false;
		int    Neurons = 0;
		long long Edges = 0;
		long long Steps = 0;
		float  MeanRateHz = 0.f;
		float  BrainMsPerTick = 0.f;
		float  VisionMsPerTick = 0.f;
		int    GiantFiberSpikes = 0;
		int    ActorsSeen = 0;
		std::string TargetName;
	};

	// Reads flypilot.json. Safe to call repeatedly; does nothing if the file is absent.
	void LoadConfig();

	bool IsEnabled();

	// Loads the blob and starts the brain thread. Returns false and disables itself on any problem.
	bool Init();

	// Called once per server tick from Server::Hooks::TickFlush. Cheap, and a no-op when disabled.
	void OnTick(float DeltaSeconds);

	// Stops the thread and frees the network.
	void Shutdown();

	Stats GetStats();
}
