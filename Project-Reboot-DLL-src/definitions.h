#pragma once

#include "structs.h"
#include "log.h"

// #define TEST_NEW_LOOTING
// #define DEVELOPER_LOGGING
// #define MILXNOR_H

#ifdef DEVELOPER_LOGGING
#define DEV_LOG(...) std::cout << std::format(__VA_ARGS__) << '\n';
#else
#define DEV_LOG(...)
#endif

#define LOG(...) std::cout << std::format(__VA_ARGS__) << '\n';

namespace Defines
{
	inline bool bLogProcessEvent = false;
	inline bool bReadyForStartMatch = true;
	inline bool bIsPlayground = false;
	inline bool bIsLateGame = false;
	inline bool bIsCreative = false;
	inline bool bIsGoingToPlayMainEvent = false;
	inline bool bTraveled = false;
	inline bool bWipeInventoryOnAircraft = true;
	inline bool bInfiniteAmmo = false;
	inline bool bInfiniteMats = false;
	inline bool bIsSTW = false; // not implemeneted
	inline bool bRespawning = false;
	inline bool bLogRPCs = false;
	inline bool bCustomLootpool = false;
	inline bool bShouldRestart = false;

	// LISTEN-SERVER / host-can-play. When true, the machine running the server is ALSO a player:
	// GIsClient is left true, the world reports NM_ListenServer, and the host's local player is not
	// stripped out.
	//
	// Currently FALSE (dedicated). The listen-server build was proven to work at the engine level —
	// the host got a real Athena_PlayerController and a pawn — but Reboot's match flow (player
	// registration, bus, loot, match start) is built entirely around players arriving as NETWORK
	// clients through the beacon. A local player never enters that flow, so the host ended up frozen
	// with no inventory and a match that never started. Running dedicated and joining over the
	// network uses the path Reboot actually supports.
	inline bool bHostCanPlay = false;

	inline int SecondsUntilTravel = 5;

	// WARMUP HOLD — how long the lobby stays open before the bus launches.
	//
	// Stock behaviour is whatever the playlist's warmup duration says, which on 7.40 solo is ~14
	// seconds measured from the FIRST player being ready. That is far too short for a private
	// server: a second player who is still loading the map misses the bus entirely and drops into
	// a match already in progress. 90s gives people time to actually get in.
	//
	// The countdown is pinned every tick (see Server::Hooks::TickFlush) because the game recomputes
	// WarmupCountdownEndTime as players join, which would otherwise pull the bus back in.
	inline float WarmupWaitSeconds = 90.f;

	// Absolute world time the warmup hold expires. 0 = not warming up. Set when warmup begins.
	inline float WarmupHoldUntil = 0.f;

	// MATCH-END AUTO-RESTART. Without this the server is finished after one match and every
	// subsequent game costs a full re-host (process launch + ~60-90s of map load). Server::Restart()
	// already existed and worked — it was just only reachable from the debug GUI's button.
	// RE-ENABLED. The leave/match-end crash it used to sit on top of is fixed (the death handler now
	// guards DeadPlayerState + the Place offset — proven by "[Death] place ok" surviving a leave).
	// Flow: last player dies/leaves -> death handler fires ClientNotifyWon + EndMatch -> GamePhase
	// goes to EndGame -> OnGamePhaseChanged spawns MatchRestartThread -> Server::Restart(). The
	// 120s watchdog TerminateProcess still backstops a stuck recycle.
	inline bool bAutoRestartAfterMatch = true;

	// Grace period before recycling, so whoever won actually sees the Victory Royale screen.
	inline int SecondsBeforeRestart = 20;

	// MATCH-END SHUTDOWN.
	//
	// A dedicated server cannot recycle in-process, so Server::Restart TerminateProcess()es itself. Do
	// that while someone is still connected and their client reports "Ack! We lost our connection to
	// the match" — the connection did not fail, the server was killed underneath it.
	//
	// Kicking them first only trades one dialog for another: ClientReturnToMainMenu is a disconnect
	// (it is what the ban path uses), so the game still renders it as an error. The results screen
	// already has a "Return To Lobby" button, so the clean answer is to WAIT for them to press it —
	// a disconnect they initiated produces no error at all — and recycle the moment the last player
	// is gone. The kick stays only as a backstop for someone who never leaves.
	//
	// GetTickCount64 when EndGame fired; 0 while a match is live.
	inline unsigned long long MatchEndedAt = 0;
	// Set by the GAME THREAD once recycling is safe: every client has disconnected, or the backstop
	// fired and they were sent home. MatchRestartThread waits on this instead of a fixed sleep.
	inline bool bSafeToRecycle = false;
	// How long to let someone sit on the results screen before we stop waiting for them.
	inline int SecondsToWaitForPlayersToLeave = 120;

	// MCP CXC_Public hook (Server::Hooks::SendRequestNow). Installs cleanly — a live match logged
	// "[MCP] SendRequestNow found ... MH_OK" and ran to completion — but it did NOT fix profile
	// loading: GetAthenaLoadoutWithOverrides() still failed for every controller afterwards. Off by
	// default because it is an engine-internals hook currently buying us nothing; the HTTP locker
	// bridge is what actually applies the player's skin. Flip to true to experiment further.
	inline bool bForceMcpPublicContext = false;

	inline std::string MapName;

	inline std::string Playlist = Defines::bIsCreative ? ("/Game/Athena/Playlists/Creative/Playlist_PlaygroundV2.Playlist_PlaygroundV2") :
		Defines::bIsPlayground ? ("/Game/Athena/Playlists/Playground/Playlist_Playground.Playlist_Playground") :
		("/Game/Athena/Playlists/Playlist_DefaultSolo.Playlist_DefaultSolo");
		// ("/Game/Athena/Playlists/Playlist_DefaultDuo.Playlist_DefaultDuo");
		// ("/Game/Athena/Playlists/DefaultBots/Playlist_Bots_DefaultSolo.Playlist_Bots_DefaultSolo");
		// ("Playlist_SolidGold_Solo");

	inline std::string urlForPortal = "";

	// DON'T CHANGE BELOW THIS

	inline bool bMatchmakingSupported = false;
	inline bool bShouldSpawnFloorLoot = false;
	inline bool bShouldSpawnVehicles = false;
	inline bool bShouldSpawnForagedItems = false;
	inline bool bIsRestarting = false;
	inline bool bShouldStartBus = false;
	inline UObject* Portal = nullptr;

	inline float test1 = 0;
	inline bool test2 = false;
	inline int AmountOfRestarts = 0;

	inline std::vector<std::pair<UObject*, std::string>> ObjectsToLoad;
	inline std::vector<ActorSpawnStruct> ActorsToSpawn;

	inline bool (*InitHost)(UObject* Beacon);
	inline void (*PauseBeaconRequests)(UObject* Beacon, bool bPause);
	inline void* (*SetWorld)(UObject* NetDriver, UObject* World);
	inline bool (*InitListen)(UObject* Driver, void* InNotify, FURL& LocalURL, bool bReuseAddressAndPort, FString& Error);
	inline void (*TickFlush)(UObject* NetDriver, float DeltaSeconds);
	inline void* (*SendRequestNow)(void* Arg1, void* MCPData, int ContextCredentials);
	inline void (*ServerReplicateActors)(UObject* ReplicationDriver);
	inline char (*KickPlayer)(UObject* GameSession, UObject* Controller, FText a3);
	inline char (*ValidationFailure)(__int64* a1, __int64 a2);
	inline __int64 (*NoReservation)(__int64* a1, __int64 a2, char a3, __int64 a4);
	inline __int64 (*CantBuild)(UObject*, UObject*, FVector, FRotator, char, TArray<UObject*>*, char*);
	inline __int64 (*CantBuildDouble)(UObject*, UObject*, DVector, DRotator, char, TArray<UObject*>*, char*);
	inline void (*HandleReloadCost)(UObject* Weapon, int AmountToRemove);
	inline UObject* (*ReplaceBuildingActor)(UObject* BuildingSMActor, unsigned int a2, UObject* a3, unsigned int a4, int a5, unsigned __int8 bMirrored, UObject* Controller);

	inline bool (*IsNetRelevantFor)(UObject*, UObject*, UObject*, void*); // end var is location
	inline void (*ActorChannelClose)(UObject*, EChannelCloseReason);

	inline void(*CallPreReplication)(UObject* actor, UObject* driver);
	inline char(*ReplicateActor)(UObject* ActorChannel);
	inline UObject* (*CreateChannelByName)(UObject* Connection, FName* ChName, EChannelCreateFlags CreateFlags, int32_t ChannelIndex); // = -1);
	inline void (*SetChannelActor)(UObject* ActorChannel, UObject* InActor, ESetChannelActorFlags Flags);
	inline UObject* (*CreateChannel)(UObject* Connection, EChannelType Type, bool bOpenedLocally, int32_t ChannelIndex);
	inline void (*SendClientAdjustment)(UObject* PlayerController);

	inline bool (*InternalTryActivateAbility)(UObject* comp, FGameplayAbilitySpecHandle Handle, PadHex18 InPredictionKey, UObject** /* UGameplayAbility** */ OutInstancedAbility, void* OnGameplayAbilityEndedDelegate, __int64* TriggerEventData); // // https://github.com/EpicGames/UnrealEngine/blob/46544fa5e0aa9e6740c19b44b0628b72e7bbd5ce/Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/AbilitySystemComponent_Abilities.cpp#L1327
	inline bool (*InternalTryActivateAbilityFTS)(UObject* comp, FGameplayAbilitySpecHandle Handle, PadHex10 InPredictionKey, UObject** /* UGameplayAbility** */ OutInstancedAbility, void* OnGameplayAbilityEndedDelegate, __int64* TriggerEventData); // // https://github.com/EpicGames/UnrealEngine/blob/46544fa5e0aa9e6740c19b44b0628b72e7bbd5ce/Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/AbilitySystemComponent_Abilities.cpp#L1327
	// inline bool (*InternalTryActivateAbilityTest)(UObject* comp, FGameplayAbilitySpecHandle Handle, void* InPredictionKey,
		// UObject** OutInstancedAbility, void* OnGameplayAbilityEndedDelegate, __int64* TriggerEventData);

	inline bool (*InternalTryActivateAbilityTest)(UObject* comp, FGameplayAbilitySpecHandle Handle, PadHex18 InPredictionKey, ...);

	inline FGameplayAbilitySpecHandle* (*GiveAbilityOld)(UObject* comp, FGameplayAbilitySpecHandle* outHandle, PadHex78 inSpec); // 419
	inline FGameplayAbilitySpecHandle* (*GiveAbility)(UObject* comp, FGameplayAbilitySpecHandle* outHandle, PadHexC8 inSpec); // 4.20-4.25 etc.
	inline FGameplayAbilitySpecHandle* (*GiveAbilityS13)(UObject* comp, FGameplayAbilitySpecHandle* outHandle, PadHexC0 inSpec);
	inline FGameplayAbilitySpecHandle* (*GiveAbilityS14ABOVE)(UObject* comp, FGameplayAbilitySpecHandle* outHandle, PadHexE0 inSpec);
	inline FGameplayAbilitySpecHandle* (*GiveAbilityS17ABOVE)(UObject* comp, FGameplayAbilitySpecHandle* outHandle, PadHexE8 inSpec);
}

template <typename T = void>
T* Alloc(size_t Bytes)
{
	return (T*)FMemory::Realloc(nullptr, Bytes, 0);
}

inline FString* GetRequestURL(UObject* Connection)
{
	if (Engine_Version <= 420)
		return (FString*)(__int64(Connection) + 432);
	if (Fortnite_Season >= 5 && Engine_Version < 424)
		return (FString*)(__int64(Connection) + 424);
	else if (Engine_Version >= 424)
		return (FString*)(__int64(Connection) + 440);

	return nullptr;
}