#include "harvesting.h"
#include "helper.h"
#include "inventory.h"
#include "datatables.h"

void Harvest(UObject* Controller, UObject* BuildingActor, float Damage)
{
	// No harvesting while riding the bus. The warmup pawn (with pickaxe) persists into the Aircraft
	// phase, and this handler processed the client's swings unconditionally -> pickaxe "worked" on the
	// bus. Editing is already gated the same way (edit.cpp); harvesting just never got the gate.
	if (Helper::IsInAircraft(Controller))
		return;

	auto CurrentWeapon = Helper::GetCurrentWeapon(Helper::GetPawnFromController(Controller));

	// std::cout << "CurrentWeapon: " << CurrentWeapon->GetFullName() << '\n';

	if (!CurrentWeapon || Helper::GetWeaponData(CurrentWeapon) != Helper::GetPickaxeDef(Controller))
		return;

	// std::cout << "ret!\n";

	static auto ResourceTypeOffset = BuildingActor->GetOffset("ResourceType");
	static auto CarClass = FindObject("/Game/Building/ActorBlueprints/Prop/Car_DEFAULT.Car_DEFAULT_C");

	if (!CarClass)
		CarClass = FindObject("/Game/Building/ActorBlueprints/Prop/Car_Copper.Car_Copper_C");

	bool bHitWeakspot = Damage == 100.f;
	bool bDestroyed = false;
	bool bIsCar = BuildingActor->IsA(CarClass);
	auto ResourceType = *(TEnumAsByte<EFortResourceType>*)(__int64(BuildingActor) + ResourceTypeOffset);
	
	if (bDestroyed)
		return;

	/* float */ int ResourcesToGive = 0;

	if (!bIsCar)
	{
		static auto BuildingResourceAmountOverrideOffset = BuildingActor->GetOffset("BuildingResourceAmountOverride");
		auto BuildingResourceAmountOverride = (FCurveTableRowHandle*)(__int64(BuildingActor) + BuildingResourceAmountOverrideOffset);

		if (!BuildingResourceAmountOverride->RowName.ComparisonIndex) // player placed build
			return;
	}

	float MaxResourcesToSpawn = 6;
	ResourcesToGive = round(GetRandomDouble(MaxResourcesToSpawn / 2.f, MaxResourcesToSpawn));

	ResourcesToGive += bHitWeakspot ? round(GetRandomDouble(3, 5)) : 0;

	std::cout << "ResourcesToGive: " << ResourcesToGive << '\n';

	// std::cout << "ResourcesToGive: " << ResourcesToGive << '\n';

	struct { UObject* BuildingSMActor; TEnumAsByte<EFortResourceType> PotentialResourceType; int PotentialResourceCount; bool bDestroyed; bool bJustHitWeakspot; }
	ClientReportDamagedResourceBuilding_Params{ BuildingActor,
		bIsCar ? EFortResourceType::Metal : ResourceType, ResourcesToGive, bDestroyed, bHitWeakspot };

	static auto ClientReportDamagedResourceBuilding = FindObject<UFunction>("/Script/FortniteGame.FortPlayerController.ClientReportDamagedResourceBuilding");
	Controller->ProcessEvent(ClientReportDamagedResourceBuilding, &ClientReportDamagedResourceBuilding_Params);

	auto Pawn = Helper::GetPawnFromController(Controller);

	static auto WoodItemData = FindObject(("/Game/Items/ResourcePickups/WoodItemData.WoodItemData"));
	static auto StoneItemData = FindObject(("/Game/Items/ResourcePickups/StoneItemData.StoneItemData"));
	static auto MetalItemData = FindObject(("/Game/Items/ResourcePickups/MetalItemData.MetalItemData"));

	UObject* ItemDef = WoodItemData;

	if (ClientReportDamagedResourceBuilding_Params.PotentialResourceType.Get() == EFortResourceType::Stone)
		ItemDef = StoneItemData;

	if (ClientReportDamagedResourceBuilding_Params.PotentialResourceType.Get() == EFortResourceType::Metal)
		ItemDef = MetalItemData;

	auto MaterialInstance = Inventory::FindItemInInventory(Controller, ItemDef);

	int AmountToGive = ClientReportDamagedResourceBuilding_Params.PotentialResourceCount;

	if (MaterialInstance && Pawn)
	{
		auto Entry = UFortItem::GetItemEntry(MaterialInstance);

		// BUG: You lose some mats if you have like 998 or idfk
		if (*FFortItemEntry::GetCount(Entry) >= 999)
		{
			Helper::SummonPickup(Pawn, ItemDef, Helper::GetActorLocation(Pawn), EFortPickupSourceTypeFlag::Other, EFortPickupSpawnSource::Unset, AmountToGive, false);
			return;
		}
	}

	Inventory::GiveItem(Controller, ItemDef, EFortQuickBars::Secondary, -1, AmountToGive);
}

/**
 * Resolve one parameter's offset on an OnDamageServer function, safely.
 *
 * ── WHY A HELPER RATHER THAN THREE MORE GetOffset CALLS ──────────────────────────────────────────
 *
 * Three separate hazards, and the naive call site had all three:
 *
 *  1. `Fn` can be null. `FindObject` returns null when a build does not have that blueprint, and the
 *     old code called `Fn->GetOffset(...)` unconditionally. GetOffset reads ClassPrivate, so that is
 *     a null dereference inside the gameserver — it only survives because 7.40 happens to have both
 *     Car blueprints.
 *
 *  2. `GetOffset` returns 0 for BOTH "not found" and "found, and it is the first member". Zero is a
 *     perfectly legitimate offset, so a caller cannot tell success from failure — this is
 *     `trap8-systemic-unguarded-offsets` in KNOWN_ISSUES. `GetProperty` returns a pointer and is
 *     null only when genuinely absent, so asking it first is what makes a real guard possible.
 *
 *  3. A name may be absent on one build and present on another. Hence the fallback: if the correct
 *     name is missing, use whatever the code used before rather than failing outright.
 *
 * Returns -1 — not 0 — when nothing usable was found, precisely because 0 is a valid offset. Every
 * caller must check for it before using the result as an offset.
 */
static int ParamOffset(UObject* Fn, const char* Name, const char* Fallback, const char* Label)
{
	if (!Fn)
	{
		std::cout << "[Harvest] " << Label << ": function not present in this build\n";
		return -1;
	}

	// GetOffsetChecked, not GetOffset: it returns -1 for an absent member rather than 0, which is
	// also a legitimate offset. It records the miss for Offsets::Report() too, so a build missing one
	// of these appears in the startup summary alongside every other failed lookup instead of only in
	// this handler's own output. See structs.h.
	const int direct = Fn->GetOffsetChecked(Name, true);
	if (direct >= 0)
		return direct;

	if (Fallback)
	{
		const int fell = Fn->GetOffsetChecked(Fallback, true);
		if (fell >= 0)
		{
			std::cout << "[Harvest] " << Label << ": no '" << Name << "' on this build, falling back to '"
			          << Fallback << "' (behaviour unchanged from before this fix)\n";
			return fell;
		}
	}

	std::cout << "[Harvest] " << Label << ": neither '" << Name << "' nor '"
	          << (Fallback ? Fallback : "(none)") << "' found - harvesting disabled for it\n";
	return -1;
}

bool Harvesting::OnDamageServer(UObject* BuildingActor, UFunction* Function, void* Parameters)
{
	if (!Parameters) // possible??
		return false;

	static auto CarDefault_OnDamageServer_Function = FindObject("/Game/Building/ActorBlueprints/Prop/Car_DEFAULT.Car_DEFAULT_C.OnDamageServer");
	static auto CarCopper_OnDamageServer_Function = FindObject("/Game/Building/ActorBlueprints/Prop/Car_Copper.Car_Copper_C.OnDamageServer");
	static auto BuildingActor_OnDamageServerFunction = FindObject("/Script/FortniteGame.BuildingActor.OnDamageServer");

	// ── CARS NEVER YIELDED MATERIALS, AND THIS IS WHY ────────────────────────────────────────────
	//
	// All six Car lookups asked for "InstigatedBy". The commented-out originals beside them named
	// DamageCauser and Damage, so the intent was never in doubt — the three-line block for
	// BuildingActor immediately below does it correctly, which is what makes the Car block look like
	// copy-paste that was never finished. (`harvesting-wrong-property-name` in KNOWN_ISSUES, which
	// graded the consequence PLAUSIBLE. It is not: the mechanism is exact.)
	//
	// DamageCauserOffset therefore equalled InstigatedByOffset, so this ran:
	//
	//     auto InstigatedBy  = *(UObject**)(Parameters + InstigatedByOffset);   // the controller
	//     auto DamageCauser  = *(UObject**)(Parameters + DamageCauserOffset);   // the SAME controller
	//     ...
	//     if (!DamageCauser->IsA(FortWeaponPickaxeAthenaClass) && !DamageCauser->IsA(MeleeClass))
	//         return false;
	//
	// `InstigatedBy` has just passed `Helper::IsPlayerController`, and a PlayerController is never a
	// pickaxe or a melee weapon. So that early return fired on EVERY car hit and `Harvest` was
	// unreachable for Car_DEFAULT and Car_Copper. Not intermittent — unconditional.
	//
	// `Damage` was aimed at the same slot too, making a `float*` out of half a UObject pointer. It is
	// never dereferenced only because the function returns above it, which is luck rather than
	// design and would have become a real problem the moment the check above was fixed alone.
	//
	// SELF-GUARDING, because none of this can be tested here — a match cannot be run in this
	// environment, and a wrong offset in the gameserver is a crash on a player's machine. So each
	// lookup asks for the correct name and falls back to "InstigatedBy" if a build does not have it,
	// which reproduces exactly today's behaviour rather than risking something new. See ParamOffset.
	static auto CarDefault_InstigatedByOffset = ParamOffset(CarDefault_OnDamageServer_Function, "InstigatedBy",  nullptr,        "Car_DEFAULT.InstigatedBy");
	static auto CarDefault_DamageCauserOffset = ParamOffset(CarDefault_OnDamageServer_Function, "DamageCauser",  "InstigatedBy", "Car_DEFAULT.DamageCauser");
	static auto CarDefault_DamageOffset       = ParamOffset(CarDefault_OnDamageServer_Function, "Damage",        "InstigatedBy", "Car_DEFAULT.Damage");

	static auto CarCopper_InstigatedByOffset  = ParamOffset(CarCopper_OnDamageServer_Function,  "InstigatedBy",  nullptr,        "Car_Copper.InstigatedBy");
	static auto CarCopper_DamageCauserOffset  = ParamOffset(CarCopper_OnDamageServer_Function,  "DamageCauser",  "InstigatedBy", "Car_Copper.DamageCauser");
	static auto CarCopper_DamageOffset        = ParamOffset(CarCopper_OnDamageServer_Function,  "Damage",        "InstigatedBy", "Car_Copper.Damage");

	// These three were already correct. Routed through the same helper for the null-function guard,
	// and so that all nine report themselves the same way.
	static auto BuildingActor_InstigatedByOffset = ParamOffset(BuildingActor_OnDamageServerFunction, "InstigatedBy", nullptr, "BuildingActor.InstigatedBy");
	static auto BuildingActor_DamageCauserOffset = ParamOffset(BuildingActor_OnDamageServerFunction, "DamageCauser", nullptr, "BuildingActor.DamageCauser");
	static auto BuildingActor_DamageOffset       = ParamOffset(BuildingActor_OnDamageServerFunction, "Damage",       nullptr, "BuildingActor.Damage");

	static auto BuildingSMActorClass = FindObject(("/Script/FortniteGame.BuildingSMActor"));

	if (BuildingActor->IsA(BuildingSMActorClass))
	{
		auto InstigatedByOffset = Function == BuildingActor_OnDamageServerFunction ? BuildingActor_InstigatedByOffset
			: (Function == CarCopper_OnDamageServer_Function ? CarCopper_InstigatedByOffset : CarDefault_InstigatedByOffset);
		
		// std::cout << "InstigatedByOffset: " << InstigatedByOffset << '\n';

		auto DamageCauserOffset = Function == BuildingActor_OnDamageServerFunction ? BuildingActor_DamageCauserOffset
			: (Function == CarCopper_OnDamageServer_Function ? CarCopper_DamageCauserOffset : CarDefault_DamageCauserOffset);

		// std::cout << "DamageCauserOffset: " << DamageCauserOffset << '\n';

		auto DamageOffset = Function == BuildingActor_OnDamageServerFunction ? BuildingActor_DamageOffset
			: (Function == CarCopper_OnDamageServer_Function ? CarCopper_DamageOffset : CarDefault_DamageOffset);

		// std::cout << "DamageOffset: " << DamageOffset << '\n';

		static auto MeleeClass = Fortnite_Version < 10.00 ? FindObject("/Game/Weapons/FORT_Melee/Blueprints/B_Melee_Generic.B_Melee_Generic_C") :
			FindObject("/Game/Weapons/FORT_Melee/Blueprints/B_Athena_Pickaxe_Generic.B_Athena_Pickaxe_Generic_C");

		static auto FortWeaponPickaxeAthenaClass = FindObject("/Script/FortniteGame.FortWeaponPickaxeAthena");

		// THE GUARD. ParamOffset returns -1 for "no usable offset", and -1 is not a sentinel that can
		// be quietly tolerated here: these three lines take it as a byte offset into the parameter
		// block, so a negative value reads BEFORE the struct and a garbage pointer gets dereferenced
		// two lines later. Refuse instead. Losing harvesting on one actor type is a bad afternoon;
		// reading wild memory inside the gameserver takes the whole match down.
		//
		// Checked here rather than at resolution because these are per-actor: BuildingActor can
		// resolve cleanly while a Car blueprint absent from some build does not, and that case should
		// cost only the cars.
		if (InstigatedByOffset < 0 || DamageCauserOffset < 0 || DamageOffset < 0)
			return false;

		auto InstigatedBy = *(UObject**)(__int64(Parameters) + InstigatedByOffset);
		auto DamageCauser = *(UObject**)(__int64(Parameters) + DamageCauserOffset);
		auto Damage = (float*)(__int64(Parameters) + DamageOffset);

		if (!InstigatedBy || !DamageCauser || !Damage)
		{
			// std::cout << "fail5!\n";
			return false;
		}

		if (!Helper::IsPlayerController(InstigatedBy))
		{
			// std::cout << "fail4!\n";
			return false;
		}

		// static auto PlayerControllerClass = FindObject("/Game/Athena/Athena_PlayerController.Athena_PlayerController_C");

		if (!DamageCauser->IsA(FortWeaponPickaxeAthenaClass) && !DamageCauser->IsA(MeleeClass))
		{			
			/* UObject* Super = DamageCauser->ClassPrivate;

			while (Super)
			{
				std::cout << "Super Name: " << Super->GetFullName() << '\n';
				Super = *(UObject**)(__int64(Super) + SuperStructOffset);
			} */

			return false;
		}

		Harvest(InstigatedBy, BuildingActor, *Damage);
	}

	return false;
}

bool Harvesting::BlueprintCanAttemptGenerateResources(UObject* BuildingActor, UFunction* Function, void* Parameters)
{
	if (!Parameters)
		return false;

	struct BlueprintCanAttemptGenerateResources_Params { FGameplayTagContainer InTags; UObject* InstigatorController; bool ret; };

	auto Params = (BlueprintCanAttemptGenerateResources_Params*)Parameters;

	auto Controller = Params->InstigatorController;

	// std::cout << "Controller: " << Controller->GetFullName() << '\n';

	if (!Controller || !Helper::IsPlayerController(Controller))
		return false;

	Harvest(Controller, BuildingActor, 50.f);

	return false;
}