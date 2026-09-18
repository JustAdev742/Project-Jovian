#include "flypilot.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "helper.h"
#include "json.hpp"

// ── FLY PILOT ────────────────────────────────────────────────────────────────────────────────────
// See flypilot.h for the shape of this. Three pieces live here:
//
//   FlyNet    the leaky integrate-and-fire network, a direct port of the kernel in
//             fly-pilot/native/flykernel.c, reading the blob written by export_blob.py.
//   Retina    builds what the fly sees out of actor positions and hands it to the photoreceptors.
//   Decoder   reads the motor pools and turns them into a Command.
//
// Everything is guarded: a missing blob, a bad header, no pawn to drive, a failed function lookup —
// each one disables the feature and logs, and none of them can take the server down with it.

namespace
{
	// ── configuration ────────────────────────────────────────────────────────────────────────────
	struct Config
	{
		bool  Enabled = false;
		std::string BlobPath = "Reboot Resources/flybrain.bin";

		int   StepsPerTick = 20;      // ms of brain time per server tick
		float SynGain = 0.10f;        // mV delivered by one synapse
		float AdaptStep = 2.0f;
		float AdaptTauMs = 150.f;
		// Background drive is off. With the graded cells sitting at their own threshold a
		// 3 mV background kick fires them outright, so any background at all drowns the
		// visual signal: measured drifting-vs-static contrast went from 1.1x with bg_hz=8
		// to better than 40x with it off.
		float BgHz = 0.0f;
		float BgMv = 3.0f;
		float GradedBias = 1.0f;      // scale on the per-type tonic drive
		float PrGain = 26.f;
		float AdaptMs = 400.f;

		int   RetinaW = 96;
		int   RetinaH = 54;
		float Hfov = 120.f;           // degrees of the fly's field the view occupies
		float Vfov = 68.f;
		float SightRangeUnits = 6000.f;
		float ActorRadiusUnits = 96.f;

		float Sensitivity = 1.0f;
		float BaselineMs = 4000.f;
		float DeadZone = 0.22f;
		float YawRateDegPerSec = 90.f;
		float PitchRateDegPerSec = 45.f;

		bool  AllowMovement = true;   // actually push the pawn around
		bool  AllowLook = true;
		bool  AllowJump = true;

		std::string TargetPlayerName;                       // empty = give the fly its own pawn
		std::string BotControllerClass = "/Script/FortniteGame.FortAthenaAIBotController";
		std::string PawnClass = "/Script/FortniteGame.FortPlayerPawnAthena";

		// The fly needs a body. Reboot spawns no bots (the AI hook in dllmain.cpp is commented
		// out), and a second Fortnite client costs gigabytes, so by default we make one: a pawn
		// is a server-side actor and never needed a client in the first place.
		bool  SpawnOwnPawn = true;
		std::string SpawnPawnClass = "/Game/Athena/PlayerPawn_Athena.PlayerPawn_Athena_C";
		std::string AIControllerClass = "/Script/AIModule.AIController";
		bool  SpawnNearPlayer = true;      // put it where someone can actually watch it
		float SpawnOffsetUnits = 700.f;
		float MoveSpeedUnits = 420.f;      // used only when driving the transform directly
	};

	Config g_Cfg;
	FlyPilot::Stats g_Stats;
	std::mutex g_StatsMutex;

	void Log(const std::string& Msg)
	{
		std::cout << "[flypilot] " << Msg << '\n';
	}

	// ── the network ──────────────────────────────────────────────────────────────────────────────
	// A direct port of native/flykernel.c. Membrane constants in mV and ms.
	class FlyNet
	{
	public:
		static constexpr float V_REST = -52.f;
		static constexpr float V_THRESH = -45.f;
		static constexpr float V_RESET = -52.f;
		static constexpr float REFRACTORY_MS = 2.2f;

		int   N = 0;
		long long E = 0;
		std::vector<long long> IndPtr;
		std::vector<int>   Indices;
		std::vector<float> Weight;      // already signed by transmitter
		std::vector<float> TauMs, GradedMv, DelayMs, Azimuth, Elevation;
		std::vector<signed char> Side;
		std::unordered_map<std::string, std::vector<int>> Groups;

		std::vector<float> V, Adapt, Rate, Alpha, Bias;
		std::vector<short> Refrac, DelaySteps;
		std::vector<long long> FiredBuf;
		std::vector<std::vector<float>> Ring;
		int RingLen = 1;
		long long Steps = 0;
		int NFired = 0;
		short RefracSteps = 2;
		float AdaptDecay = 0.99f, RateAlpha = 0.02f, Dt = 1.f;

		unsigned long long s0 = 0x9E3779B97F4A7C15ull, s1 = 0xBF58476D1CE4E5B9ull;
		inline unsigned long long XNext()
		{
			unsigned long long x = s0, y = s1;
			s0 = y; x ^= x << 23;
			s1 = x ^ y ^ (x >> 17) ^ (y >> 26);
			return s1 + y;
		}

		template <typename T> static bool ReadInto(std::ifstream& F, std::vector<T>& Out, size_t Count)
		{
			Out.resize(Count);
			F.read(reinterpret_cast<char*>(Out.data()), (std::streamsize)(Count * sizeof(T)));
			return (bool)F;
		}

		bool Load(const std::string& Path)
		{
			std::ifstream F(Path, std::ios::binary);
			if (!F)
			{
				Log("could not open " + Path);
				return false;
			}

			char Magic[8] = {};
			F.read(Magic, 8);
			if (std::string(Magic, 8) != "FLYBRN01")
			{
				Log("bad magic in " + Path + " (expected FLYBRN01)");
				return false;
			}

			unsigned int n = 0, nGroups = 0;
			unsigned long long e = 0;
			F.read(reinterpret_cast<char*>(&n), 4);
			F.read(reinterpret_cast<char*>(&nGroups), 4);
			F.read(reinterpret_cast<char*>(&e), 8);
			if (!F || n == 0 || n > 5'000'000u || e == 0 || e > 400'000'000ull)
			{
				Log("header looks wrong; refusing to load");
				return false;
			}
			N = (int)n;
			E = (long long)e;

			bool ok = ReadInto(F, IndPtr, (size_t)N + 1)
				&& ReadInto(F, Indices, (size_t)E)
				&& ReadInto(F, Weight, (size_t)E)
				&& ReadInto(F, TauMs, (size_t)N)
				&& ReadInto(F, GradedMv, (size_t)N)
				&& ReadInto(F, DelayMs, (size_t)N)
				&& ReadInto(F, Azimuth, (size_t)N)
				&& ReadInto(F, Elevation, (size_t)N)
				&& ReadInto(F, Side, (size_t)N);
			if (!ok)
			{
				Log("truncated blob");
				return false;
			}

			for (unsigned int g = 0; g < nGroups; ++g)
			{
				unsigned short Len = 0;
				F.read(reinterpret_cast<char*>(&Len), 2);
				if (!F || Len == 0 || Len > 256) break;
				std::string Name(Len, '\0');
				F.read(&Name[0], Len);
				unsigned int Count = 0;
				F.read(reinterpret_cast<char*>(&Count), 4);
				if (!F || Count > (unsigned)N) break;
				std::vector<int> Idx;
				if (!ReadInto(F, Idx, Count)) break;
				Groups.emplace(std::move(Name), std::move(Idx));
			}

			// sanity: an out-of-range index would be a memory-safety problem, not just a wrong result
			if (IndPtr.back() != E)
			{
				Log("indptr does not end at the edge count");
				return false;
			}
			for (long long i = 0; i < E; i += 4096)
			{
				if (Indices[(size_t)i] < 0 || Indices[(size_t)i] >= N)
				{
					Log("edge index out of range");
					return false;
				}
			}

			Log("loaded " + std::to_string(N) + " neurons, " + std::to_string(E)
				+ " connections, " + std::to_string(Groups.size()) + " groups");
			return true;
		}

		void Configure(float dt)
		{
			Dt = dt;
			RefracSteps = (short)(std::max)(1, (int)std::lround(REFRACTORY_MS / dt));
			AdaptDecay = std::exp(-dt / g_Cfg.AdaptTauMs);
			RateAlpha = 1.f - std::exp(-dt / 50.f);

			V.assign(N, V_REST);
			Adapt.assign(N, 0.f);
			Rate.assign(N, 0.f);
			Refrac.assign(N, 0);
			FiredBuf.assign(N, 0);

			Alpha.resize(N);
			Bias.resize(N);
			DelaySteps.resize(N);
			int MaxDelay = 1;
			for (int i = 0; i < N; ++i)
			{
				float tau = TauMs[i] > 0.1f ? TauMs[i] : 20.f;
				Alpha[i] = dt / tau;
				Bias[i] = GradedMv[i] * g_Cfg.GradedBias;
				int d = (std::max)(1, (int)std::lround(DelayMs[i] / dt));
				DelaySteps[i] = (short)d;
				MaxDelay = (std::max)(MaxDelay, d);
			}
			RingLen = MaxDelay + 1;
			Ring.assign(RingLen, std::vector<float>(N, 0.f));
			Steps = 0;
		}

		void Step(const std::vector<float>& Inject)
		{
			const int slot = (int)(Steps % RingLen);
			std::vector<float>& Pending = Ring[slot];
			const float RateKeep = 1.f - RateAlpha;

			for (int i = 0; i < N; ++i)
			{
				const float a = Alpha[i];
				V[i] = V[i] * (1.f - a) + a * V_REST + Pending[i] - Adapt[i] + Inject[i];
				Adapt[i] *= AdaptDecay;
				Rate[i] *= RateKeep;
			}

			// background drive: a stand-in for everything not modelled here, the other sensory
			// channels and the connections the weight threshold dropped
			const long long BgK = (long long)std::lround(N * g_Cfg.BgHz * Dt / 1000.0);
			for (long long k = 0; k < BgK; ++k)
				V[(size_t)(XNext() % (unsigned long long)N)] += g_Cfg.BgMv;

			NFired = 0;
			const float Kick = RateAlpha * (1000.f / Dt);
			for (int i = 0; i < N; ++i)
			{
				float v = V[i];
				if (v < -90.f) v = -90.f; else if (v > 20.f) v = 20.f;

				if (Refrac[i] > 0)
				{
					--Refrac[i];
					V[i] = V_RESET;
					continue;
				}
				if (v >= V_THRESH)
				{
					V[i] = V_RESET;
					Refrac[i] = RefracSteps;
					Adapt[i] += g_Cfg.AdaptStep;
					Rate[i] += Kick;
					FiredBuf[NFired++] = i;
				}
				else V[i] = v;
			}

			std::fill(Pending.begin(), Pending.end(), 0.f);   // consumed

			const float Gain = g_Cfg.SynGain;
			for (int k = 0; k < NFired; ++k)
			{
				const long long i = FiredBuf[k];
				float* Out = Ring[(size_t)((Steps + DelaySteps[i]) % RingLen)].data();
				const long long a = IndPtr[(size_t)i], b = IndPtr[(size_t)i + 1];
				for (long long e = a; e < b; ++e)
					Out[Indices[(size_t)e]] += Weight[(size_t)e] * Gain;
			}
			++Steps;
		}

		float GroupRate(const std::string& Name) const
		{
			auto It = Groups.find(Name);
			if (It == Groups.end() || It->second.empty()) return 0.f;
			double Acc = 0.0;
			for (int i : It->second) Acc += Rate[(size_t)i];
			return (float)(Acc / It->second.size());
		}

		bool GroupSpiked(const std::string& Name) const
		{
			auto It = Groups.find(Name);
			if (It == Groups.end()) return false;
			for (int i : It->second)
				for (int k = 0; k < NFired; ++k)
					if (FiredBuf[k] == i) return true;
			return false;
		}

		float MeanRate() const
		{
			double Acc = 0.0;
			for (int i = 0; i < N; ++i) Acc += Rate[(size_t)i];
			return N ? (float)(Acc / N) : 0.f;
		}
	};

	// ── the eye ──────────────────────────────────────────────────────────────────────────────────
	// Each photoreceptor has a direction, so we precompute which pixel of the view it looks at and
	// then a frame is just a gather. Injection goes into the lamina rather than R1-R6 because the
	// reconstruction contains only about 1,400 of roughly 9,600 outer photoreceptors, which leaves
	// half the columns blind; L1/L2/L3 are one per column and are the direct targets of R1-R6, so
	// driving them covers the eye. The drive is inverted because that synapse is histaminergic and
	// sign inverting: light hyperpolarises L1 in a real fly.
	struct Channel
	{
		std::vector<int>   Idx;
		std::vector<int>   Pix;
		std::vector<float> Adapted;
		std::vector<unsigned char> OnScreen;
		float Sign = 1.f, Scale = 1.f, Tonic = 0.f;
	};

	class Retina
	{
	public:
		std::vector<Channel> Channels;
		float AdaptAlpha = 0.01f;
		static constexpr float DARK = 0.04f;

		void Build(const FlyNet& Net, float dt)
		{
			AdaptAlpha = 1.f - std::exp(-dt / g_Cfg.AdaptMs);
			struct Spec { const char* Group; float Sign; float Scale; float Tonic; };
			const Spec Specs[] = {
				{ "L1", -1.f, 1.0f, 0.f },
				{ "L2", -1.f, 1.0f, 0.f },
				{ "L3", -1.f, 0.7f, 0.f },
				{ "R7", +1.f, 0.8f, g_Cfg.PrGain * 0.16f },
				{ "R8", +1.f, 0.8f, g_Cfg.PrGain * 0.16f },
			};

			for (const auto& S : Specs)
			{
				auto It = Net.Groups.find(S.Group);
				if (It == Net.Groups.end()) continue;

				Channel C;
				C.Sign = S.Sign; C.Scale = S.Scale; C.Tonic = S.Tonic;
				for (int i : It->second)
				{
					const float az = Net.Azimuth[(size_t)i];
					const float el = Net.Elevation[(size_t)i];
					if (std::isnan(az) || std::isnan(el)) continue;

					const float u = (az + g_Cfg.Hfov * 0.5f) / g_Cfg.Hfov;
					const float v = (g_Cfg.Vfov * 0.5f - el) / g_Cfg.Vfov;
					const bool on = (u >= 0.f && u < 1.f && v >= 0.f && v < 1.f);

					int px = (int)(u * g_Cfg.RetinaW);
					int py = (int)(v * g_Cfg.RetinaH);
					px = (std::min)((std::max)(px, 0), g_Cfg.RetinaW - 1);
					py = (std::min)((std::max)(py, 0), g_Cfg.RetinaH - 1);

					C.Idx.push_back(i);
					C.Pix.push_back(py * g_Cfg.RetinaW + px);
					C.Adapted.push_back(DARK);
					C.OnScreen.push_back(on ? 1 : 0);
				}
				if (!C.Idx.empty())
					Channels.push_back(std::move(C));
			}

			int Seeing = 0;
			for (auto& C : Channels)
				for (unsigned char b : C.OnScreen) Seeing += b;
			Log("retina bound: " + std::to_string(Channels.size()) + " channels, "
				+ std::to_string(Seeing) + " cells facing the view");
		}

		void Encode(const std::vector<float>& Frame, const std::vector<float>& Bias,
		            std::vector<float>& Inject)
		{
			Inject = Bias;
			for (auto& C : Channels)
			{
				for (size_t k = 0; k < C.Idx.size(); ++k)
				{
					const float Sampled = C.OnScreen[k] ? Frame[(size_t)C.Pix[k]] : DARK;
					C.Adapted[k] += (Sampled - C.Adapted[k]) * AdaptAlpha;
					// Weber contrast against the adapted level: a fly photoreceptor reports
					// change, not absolute brightness.
					const float Contrast = (Sampled - C.Adapted[k]) / (C.Adapted[k] + 0.15f);
					Inject[(size_t)C.Idx[k]] += C.Tonic + C.Sign * C.Scale * g_Cfg.PrGain * Contrast;
				}
			}
		}
	};

	// ── reading the motor pools ──────────────────────────────────────────────────────────────────
	// Rates are read as z-scores against each group's own slow baseline, because absolute rates in a
	// model like this are not meaningful but a pool firing above its own resting level is. It also
	// means the fly calibrates itself over the first few seconds instead of needing tuned thresholds.
	struct Baseline
	{
		float A = 0.001f, Mean = 0.f, Var = 1.f;
		bool  Seeded = false;

		float Update(float X)
		{
			if (!Seeded) { Mean = X; Seeded = true; return 0.f; }
			const float D = X - Mean;
			Mean += A * D;
			Var += A * (D * D - Var);
			return D / (std::sqrt(Var) + 1e-3f);
		}
	};

	class Decoder
	{
	public:
		std::unordered_map<std::string, Baseline> Base;
		std::unordered_map<std::string, float> Smooth;
		long long WarmupSteps = 1500;
		int GiantFiberSpikes = 0;

		void Configure(float dt)
		{
			const char* Tracked[] = { "leg_L", "leg_R", "leg_all", "neck_L", "neck_R",
			                          "wing_power", "proboscis", "MDN", "DNp09",
			                          "DNa02_L", "DNa02_R", "DN_all" };
			for (const char* K : Tracked)
			{
				Baseline B; B.A = 1.f - std::exp(-dt / g_Cfg.BaselineMs);
				Base[K] = B;
				Smooth[K] = 0.f;
			}
			WarmupSteps = (long long)(1500.0 / dt);
		}

		FlyPilot::Command Read(FlyNet& Net)
		{
			const float SmoothA = 1.f - std::exp(-Net.Dt / 90.f);
			for (auto& KV : Base)
			{
				const float Z = KV.second.Update(Net.GroupRate(KV.first));
				Smooth[KV.first] += (Z - Smooth[KV.first]) * SmoothA;
			}
			if (Net.GroupSpiked("DNp01")) ++GiantFiberSpikes;

			FlyPilot::Command C;
			if (Net.Steps < WarmupSteps)
				return C;   // baselines still settling; hold still rather than twitch

			auto Z = [&](const char* K) { auto It = Smooth.find(K); return It == Smooth.end() ? 0.f : It->second; };
			auto Squash = [&](float V) { return std::tanh(V * 0.55f * g_Cfg.Sensitivity); };

			C.Freeze = (std::max)(0.f, Squash(Z("DNp09")));
			const float Gate = 1.f - (std::min)(1.f, C.Freeze);

			const float Walk = Squash(Z("leg_all"));
			const float Back = (std::max)(0.f, Squash(Z("MDN")));
			C.Forward = ((std::max)(0.f, Walk) - Back) * Gate;
			C.Strafe = Squash(Z("leg_R") - Z("leg_L")) * Gate;
			C.Yaw = Squash(Z("neck_R") - Z("neck_L") + 0.5f * (Z("DNa02_R") - Z("DNa02_L"))) * Gate;
			C.Pitch = 0.f;   // see FINDINGS.md: the vertical motion channel is not trustworthy
			C.Sprint = (std::max)(0.f, Squash(Z("wing_power"))) * Gate;
			C.Fire = (std::max)(0.f, Squash(Z("proboscis"))) * Gate;
			C.Jump = Net.GroupSpiked("DNp01");
			return C;
		}
	};

	// ── shared state between the game thread and the brain thread ────────────────────────────────
	FlyNet*  g_Net = nullptr;
	Retina*  g_Retina = nullptr;
	Decoder* g_Decoder = nullptr;

	std::thread g_Thread;
	std::atomic<bool> g_Run{ false };
	std::atomic<bool> g_Ready{ false };

	std::mutex g_FrameMutex;
	std::vector<float> g_Frame;        // written by the game thread, read by the brain
	std::mutex g_CmdMutex;
	FlyPilot::Command g_Cmd;           // written by the brain, read by the game thread

	void BrainThread()
	{
		std::vector<float> Local(g_Frame.size(), 0.5f);
		std::vector<float> Inject;
		while (g_Run.load(std::memory_order_relaxed))
		{
			{
				std::lock_guard<std::mutex> Lock(g_FrameMutex);
				Local = g_Frame;
			}

			const auto T0 = std::chrono::steady_clock::now();
			g_Retina->Encode(Local, g_Net->Bias, Inject);
			for (int s = 0; s < g_Cfg.StepsPerTick; ++s)
				g_Net->Step(Inject);
			const FlyPilot::Command C = g_Decoder->Read(*g_Net);
			const float Ms = std::chrono::duration<float, std::milli>(
				std::chrono::steady_clock::now() - T0).count();

			{
				std::lock_guard<std::mutex> Lock(g_CmdMutex);
				g_Cmd = C;
			}
			{
				std::lock_guard<std::mutex> Lock(g_StatsMutex);
				g_Stats.Steps = g_Net->Steps;
				g_Stats.MeanRateHz = g_Net->MeanRate();
				g_Stats.BrainMsPerTick = Ms;
				g_Stats.GiantFiberSpikes = g_Decoder->GiantFiberSpikes;
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(1));
		}
	}

	// ── building the view ────────────────────────────────────────────────────────────────────────
	// No rendering and no line traces. The scene is the horizon plus a dark blob for every actor
	// near enough to matter, which is roughly what a fly's spatial acuity would resolve anyway and
	// costs a few hundred floating point operations a tick.
	UObject* g_TargetPawn = nullptr;
	UObject* g_TargetController = nullptr;

	// Set when the pawn is one we spawned. If we also managed to possess it with an AI controller
	// the engine's movement component does the work; if not we move the actor ourselves, which
	// costs gravity and terrain following but always produces something visible.
	bool  g_OwnPawn = false;
	bool  g_UseMovementInput = false;
	float g_Heading = 0.f;              // our own yaw, since an unpossessed pawn has no controller
	FVector g_Pos{};
	int   g_SpawnAttempts = 0;

	inline float NormaliseDeg(float D)
	{
		while (D > 180.f) D -= 360.f;
		while (D < -180.f) D += 360.f;
		return D;
	}

	void DrawDisc(std::vector<float>& Frame, float Az, float El, float RadiusDeg, float Value)
	{
		const float U = (Az + g_Cfg.Hfov * 0.5f) / g_Cfg.Hfov;
		const float Vv = (g_Cfg.Vfov * 0.5f - El) / g_Cfg.Vfov;
		const float Ru = RadiusDeg / g_Cfg.Hfov * g_Cfg.RetinaW;
		const float Rv = RadiusDeg / g_Cfg.Vfov * g_Cfg.RetinaH;
		const int Cx = (int)(U * g_Cfg.RetinaW), Cy = (int)(Vv * g_Cfg.RetinaH);
		const int R = (int)std::ceil((std::max)(Ru, Rv)) + 1;

		for (int y = Cy - R; y <= Cy + R; ++y)
		{
			if (y < 0 || y >= g_Cfg.RetinaH) continue;
			for (int x = Cx - R; x <= Cx + R; ++x)
			{
				if (x < 0 || x >= g_Cfg.RetinaW) continue;
				const float dx = (float)(x - Cx) / (std::max)(Ru, 0.5f);
				const float dy = (float)(y - Cy) / (std::max)(Rv, 0.5f);
				if (dx * dx + dy * dy <= 1.f)
					Frame[(size_t)(y * g_Cfg.RetinaW + x)] = Value;
			}
		}
	}

	int BuildFrame(std::vector<float>& Frame)
	{
		const FVector Eye = Helper::GetActorLocation(g_TargetPawn);
		const FRotator View = g_TargetController ? Helper::GetControlRotation(g_TargetController)
			: Helper::GetActorRotation(g_TargetPawn);

		// horizon: sky above, ground below, placed by the pawn's own pitch
		for (int y = 0; y < g_Cfg.RetinaH; ++y)
		{
			const float El = g_Cfg.Vfov * 0.5f - (y + 0.5f) / g_Cfg.RetinaH * g_Cfg.Vfov;
			const float Value = (El + View.Pitch) > 0.f ? 0.85f : 0.28f;
			for (int x = 0; x < g_Cfg.RetinaW; ++x)
				Frame[(size_t)(y * g_Cfg.RetinaW + x)] = Value;
		}

		static UObject* PawnClass = nullptr;
		if (!PawnClass) PawnClass = FindObject(g_Cfg.PawnClass);
		if (!PawnClass) return 0;

		auto Actors = Helper::GetAllActorsOfClass(PawnClass);
		int Seen = 0;
		for (int i = 0; i < Actors.Num(); ++i)
		{
			UObject* A = Actors.At(i);
			if (!A || A == g_TargetPawn) continue;

			const FVector P = Helper::GetActorLocation(A);
			const float dx = P.X - Eye.X, dy = P.Y - Eye.Y, dz = P.Z - Eye.Z;
			const float Flat = std::sqrt(dx * dx + dy * dy);
			const float Dist = std::sqrt(Flat * Flat + dz * dz);
			if (Dist < 1.f || Dist > g_Cfg.SightRangeUnits) continue;

			const float Az = NormaliseDeg(std::atan2(dy, dx) * 57.29578f - View.Yaw);
			const float El = std::atan2(dz, Flat) * 57.29578f - View.Pitch;
			if (std::fabs(Az) > g_Cfg.Hfov * 0.5f || std::fabs(El) > g_Cfg.Vfov * 0.5f) continue;

			// angular radius: this is what makes an approaching player loom
			const float RadiusDeg = std::atan2(g_Cfg.ActorRadiusUnits, Dist) * 57.29578f;
			DrawDisc(Frame, Az, El, RadiusDeg, 0.05f);
			++Seen;
		}
		return Seen;
	}

	// ── moving the pawn ──────────────────────────────────────────────────────────────────────────
	void ApplyCommand(const FlyPilot::Command& C, float DeltaSeconds)
	{
		if (g_Cfg.AllowLook && g_TargetController && (std::fabs(C.Yaw) > g_Cfg.DeadZone * 0.5f))
		{
			static auto ControlRotationOffset = g_TargetController->GetOffset("ControlRotation");
			if (ControlRotationOffset)
			{
				auto Rot = Get<FRotator>(g_TargetController, ControlRotationOffset);
				if (Rot)
				{
					Rot->Yaw = NormaliseDeg(Rot->Yaw + C.Yaw * g_Cfg.YawRateDegPerSec * DeltaSeconds);
					Rot->Pitch = (std::min)(85.f, (std::max)(-85.f,
						Rot->Pitch + C.Pitch * g_Cfg.PitchRateDegPerSec * DeltaSeconds));
				}
			}
		}

		// Unpossessed pawn: no controller, no movement component input, so we are the physics.
		if (g_OwnPawn && !g_UseMovementInput)
		{
			if (g_Cfg.AllowLook)
				g_Heading = NormaliseDeg(g_Heading + C.Yaw * g_Cfg.YawRateDegPerSec * DeltaSeconds);

			if (g_Cfg.AllowMovement)
			{
				const float Rad = g_Heading * 0.0174533f;
				const float FX = std::cos(Rad), FY = std::sin(Rad);
				const float Step = g_Cfg.MoveSpeedUnits * DeltaSeconds;
				g_Pos.X += (FX * C.Forward - FY * C.Strafe) * Step;
				g_Pos.Y += (FY * C.Forward + FX * C.Strafe) * Step;
			}

			// K2_TeleportTo rather than K2_SetActorLocation: the latter takes an FHitResult by
			// value and this codebase has no definition for one, so its parameter block cannot be
			// laid out safely.
			static auto TeleportTo = FindObject<UFunction>("/Script/Engine.Actor.K2_TeleportTo");
			if (TeleportTo)
			{
				struct { FVector DestLocation; FRotator DestRotation; bool ReturnValue; } Params{};
				Params.DestLocation = g_Pos;
				Params.DestRotation = FRotator{ 0.f, g_Heading, 0.f };
				g_TargetPawn->ProcessEvent(TeleportTo, &Params);
			}
			return;
		}

		if (g_Cfg.AllowMovement && (std::fabs(C.Forward) > g_Cfg.DeadZone
			|| std::fabs(C.Strafe) > g_Cfg.DeadZone))
		{
			static auto AddMovementInput = FindObject<UFunction>("/Script/Engine.Pawn.AddMovementInput");
			if (AddMovementInput)
			{
				const FRotator View = g_TargetController
					? Helper::GetControlRotation(g_TargetController)
					: Helper::GetActorRotation(g_TargetPawn);
				const float Yaw = View.Yaw * 0.0174533f;
				const float FX = std::cos(Yaw), FY = std::sin(Yaw);

				struct { FVector WorldDirection; float ScaleValue; bool bForce; } Params{};
				if (std::fabs(C.Forward) > g_Cfg.DeadZone)
				{
					Params.WorldDirection = FVector{ FX, FY, 0.f };
					Params.ScaleValue = C.Forward;
					Params.bForce = true;
					g_TargetPawn->ProcessEvent(AddMovementInput, &Params);
				}
				if (std::fabs(C.Strafe) > g_Cfg.DeadZone)
				{
					Params.WorldDirection = FVector{ -FY, FX, 0.f };
					Params.ScaleValue = C.Strafe;
					Params.bForce = true;
					g_TargetPawn->ProcessEvent(AddMovementInput, &Params);
				}
			}
		}

		if (g_Cfg.AllowJump && C.Jump)
		{
			static auto Jump = FindObject<UFunction>("/Script/Engine.Character.Jump");
			if (Jump) g_TargetPawn->ProcessEvent(Jump);
		}

		// Firing is deliberately not wired up. Pulling a trigger server-side means driving the
		// weapon's fire path, and getting that wrong on a live match is a far worse failure than a
		// fly that cannot shoot. The signal is reported in the stats so it can be watched first.
	}

	// Give the fly a body of its own.
	//
	// Two ways this can go. If we can spawn an AI controller and possess the pawn with it, the
	// engine's own character movement takes over and the fly gets gravity, collision and terrain
	// following for free. If any part of that fails we keep the pawn and drive its transform
	// ourselves, which still moves and is still visible, but hovers at the height it spawned at.
	// Either way the fly ends up in the match without a second Fortnite client.
	bool SpawnOwnPawn()
	{
		if (++g_SpawnAttempts > 8)
			return false;   // stop retrying every tick if the classes are not in this build

		UObject* PawnClass = FindObject(g_Cfg.SpawnPawnClass);
		if (!PawnClass)
		{
			if (g_SpawnAttempts == 1)
				Log("cannot spawn: " + g_Cfg.SpawnPawnClass + " not found in this build");
			return false;
		}

		// somewhere a person can actually watch it
		FVector Where{ 1250.f, 1818.f, 3284.f };
		bool Placed = false;
		if (g_Cfg.SpawnNearPlayer)
		{
			Helper::LoopConnections([&](UObject* Controller)
			{
				if (Placed || !Controller) return;
				if (UObject* Pawn = Helper::GetPawnFromController(Controller))
				{
					const FVector P = Helper::GetActorLocation(Pawn);
					Where = FVector{ P.X + g_Cfg.SpawnOffsetUnits, P.Y, P.Z + 120.f };
					Placed = true;
				}
			}, false);
			if (!Placed)
				return false;   // nobody in the match yet; try again next tick
		}

		UObject* Pawn = Helper::Easy::SpawnActor(PawnClass, Where, FRotator{});
		if (!Pawn)
		{
			Log("spawn failed");
			return false;
		}

		g_TargetPawn = Pawn;
		g_OwnPawn = true;
		g_Pos = Where;
		g_Heading = 0.f;

		// try for real movement
		if (UObject* AIClass = FindObject(g_Cfg.AIControllerClass))
		{
			if (UObject* Ctrl = Helper::Easy::SpawnActor(AIClass, Where, FRotator{}))
			{
				static auto PossessFn = FindObject<UFunction>("/Script/Engine.Controller.Possess");
				if (PossessFn)
				{
					struct { UObject* InPawn; } Params{ Pawn };
					Ctrl->ProcessEvent(PossessFn, &Params);
					if (Helper::GetPawnFromController(Ctrl) == Pawn)
					{
						g_TargetController = Ctrl;
						g_UseMovementInput = true;
					}
				}
			}
		}

		Log(g_UseMovementInput
			? "spawned a pawn and possessed it; the engine will do the walking"
			: "spawned a pawn but could not possess it; driving its transform directly "
			  "(no gravity or terrain following)");
		return true;
	}

	bool AcquireTarget()
	{
		if (g_TargetPawn) return true;

		if (!g_Cfg.TargetPlayerName.empty())
		{
			UObject* Found = nullptr;
			Helper::LoopConnections([&](UObject* Controller)
			{
				if (Found || !Controller) return;
				if (Helper::GetPlayerName(Controller) == g_Cfg.TargetPlayerName)
					Found = Controller;
			}, false);
			if (Found)
			{
				g_TargetController = Found;
				g_TargetPawn = Helper::GetPawnFromController(Found);
			}
		}
		else
		{
			static UObject* BotClass = nullptr;
			if (!BotClass) BotClass = FindObject(g_Cfg.BotControllerClass);
			if (BotClass)
			{
				auto Bots = Helper::GetAllActorsOfClass(BotClass);
				for (int i = 0; i < Bots.Num(); ++i)
				{
					UObject* Ctrl = Bots.At(i);
					if (!Ctrl) continue;
					if (UObject* Pawn = Helper::GetPawnFromController(Ctrl))
					{
						g_TargetController = Ctrl;
						g_TargetPawn = Pawn;
						break;
					}
				}
			}
		}

		if (!g_TargetPawn && g_Cfg.SpawnOwnPawn && g_Cfg.TargetPlayerName.empty())
			SpawnOwnPawn();

		if (g_TargetPawn)
		{
			const std::string Name = g_TargetController
				? Helper::GetPlayerName(g_TargetController) : std::string("bot");
			Log("flying " + (Name.empty() ? std::string("an unnamed pawn") : Name));
			std::lock_guard<std::mutex> Lock(g_StatsMutex);
			g_Stats.TargetName = Name;
			return true;
		}
		return false;
	}
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────
void FlyPilot::LoadConfig()
{
	std::ifstream F("flypilot.json");
	if (!F) return;

	try
	{
		nlohmann::json J;
		F >> J;
		auto Get = [&](const char* K, auto& Out)
		{
			if (J.contains(K)) Out = J[K].get<std::decay_t<decltype(Out)>>();
		};
		Get("enabled", g_Cfg.Enabled);
		Get("blobPath", g_Cfg.BlobPath);
		Get("stepsPerTick", g_Cfg.StepsPerTick);
		Get("synGain", g_Cfg.SynGain);
		Get("bgHz", g_Cfg.BgHz);
		Get("gradedBias", g_Cfg.GradedBias);
		Get("prGain", g_Cfg.PrGain);
		Get("retinaW", g_Cfg.RetinaW);
		Get("retinaH", g_Cfg.RetinaH);
		Get("hfov", g_Cfg.Hfov);
		Get("vfov", g_Cfg.Vfov);
		Get("sensitivity", g_Cfg.Sensitivity);
		Get("deadZone", g_Cfg.DeadZone);
		Get("yawRateDegPerSec", g_Cfg.YawRateDegPerSec);
		Get("allowMovement", g_Cfg.AllowMovement);
		Get("allowLook", g_Cfg.AllowLook);
		Get("allowJump", g_Cfg.AllowJump);
		Get("targetPlayerName", g_Cfg.TargetPlayerName);
		Get("botControllerClass", g_Cfg.BotControllerClass);
		Get("pawnClass", g_Cfg.PawnClass);
		Get("sightRangeUnits", g_Cfg.SightRangeUnits);
		Get("spawnOwnPawn", g_Cfg.SpawnOwnPawn);
		Get("spawnPawnClass", g_Cfg.SpawnPawnClass);
		Get("aiControllerClass", g_Cfg.AIControllerClass);
		Get("spawnNearPlayer", g_Cfg.SpawnNearPlayer);
		Get("spawnOffsetUnits", g_Cfg.SpawnOffsetUnits);
		Get("moveSpeedUnits", g_Cfg.MoveSpeedUnits);

		g_Cfg.StepsPerTick = (std::min)((std::max)(g_Cfg.StepsPerTick, 1), 200);
		g_Cfg.RetinaW = (std::min)((std::max)(g_Cfg.RetinaW, 16), 512);
		g_Cfg.RetinaH = (std::min)((std::max)(g_Cfg.RetinaH, 9), 512);

		Log(std::string("config: ") + (g_Cfg.Enabled ? "enabled" : "disabled")
			+ ", " + std::to_string(g_Cfg.StepsPerTick) + " ms of brain time per tick");
	}
	catch (const std::exception& E)
	{
		Log(std::string("could not parse flypilot.json: ") + E.what());
		g_Cfg.Enabled = false;
	}
}

bool FlyPilot::IsEnabled() { return g_Cfg.Enabled; }

bool FlyPilot::Init()
{
	if (!g_Cfg.Enabled || g_Ready.load()) return g_Ready.load();

	auto* Net = new FlyNet();
	if (!Net->Load(g_Cfg.BlobPath))
	{
		Log("disabling: the brain could not be loaded. Build it with fly-pilot/flypilot/export_blob.py");
		delete Net;
		g_Cfg.Enabled = false;
		return false;
	}
	Net->Configure(1.0f);

	g_Net = Net;
	g_Retina = new Retina();
	g_Retina->Build(*g_Net, 1.0f);
	g_Decoder = new Decoder();
	g_Decoder->Configure(1.0f);

	g_Frame.assign((size_t)g_Cfg.RetinaW * g_Cfg.RetinaH, 0.5f);
	g_Run.store(true);
	g_Thread = std::thread(BrainThread);
	g_Ready.store(true);

	{
		std::lock_guard<std::mutex> Lock(g_StatsMutex);
		g_Stats.Loaded = true;
		g_Stats.Running = true;
		g_Stats.Neurons = g_Net->N;
		g_Stats.Edges = g_Net->E;
	}
	Log("running. This is an experiment, not a feature.");
	return true;
}

void FlyPilot::OnTick(float DeltaSeconds)
{
	if (!g_Cfg.Enabled) return;

	// Loading 121 MB and spinning up a thread is done on the first tick rather than during
	// Initialize, so it cannot race the engine's own start-up ordering. One attempt only:
	// Init() clears Enabled if it fails, so a bad install costs one try, not one per tick.
	if (!g_Ready.load())
	{
		Init();
		return;
	}

	if (!AcquireTarget()) return;

	// the pawn can die or be replaced between matches
	if (g_TargetController && !Helper::GetPawnFromController(g_TargetController))
	{
		g_TargetPawn = nullptr;
		return;
	}

	const auto T0 = std::chrono::steady_clock::now();
	std::vector<float> Frame((size_t)g_Cfg.RetinaW * g_Cfg.RetinaH, 0.5f);
	const int Seen = BuildFrame(Frame);
	{
		std::lock_guard<std::mutex> Lock(g_FrameMutex);
		g_Frame.swap(Frame);
	}
	const float VisionMs = std::chrono::duration<float, std::milli>(
		std::chrono::steady_clock::now() - T0).count();

	FlyPilot::Command C;
	{
		std::lock_guard<std::mutex> Lock(g_CmdMutex);
		C = g_Cmd;
	}
	ApplyCommand(C, DeltaSeconds);

	{
		std::lock_guard<std::mutex> Lock(g_StatsMutex);
		g_Stats.VisionMsPerTick = VisionMs;
		g_Stats.ActorsSeen = Seen;
	}
}

void FlyPilot::Shutdown()
{
	g_Run.store(false);
	if (g_Thread.joinable()) g_Thread.join();
	delete g_Net;      g_Net = nullptr;
	delete g_Retina;   g_Retina = nullptr;
	delete g_Decoder;  g_Decoder = nullptr;
	g_Ready.store(false);
	std::lock_guard<std::mutex> Lock(g_StatsMutex);
	g_Stats.Running = false;
}

FlyPilot::Stats FlyPilot::GetStats()
{
	std::lock_guard<std::mutex> Lock(g_StatsMutex);
	return g_Stats;
}
