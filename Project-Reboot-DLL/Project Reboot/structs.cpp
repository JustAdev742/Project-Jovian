#include "structs.h"
#include <iostream> // TODO REMOVE
#include <format>
#include <mutex>
#include <set>
#include "definitions.h"

std::string FName::ToString()
{
	static auto KismetStringLibrary = FindObject("/Script/Engine.Default__KismetStringLibrary");

	static auto Conv_NameToString = FindObject<UFunction>("/Script/Engine.KismetStringLibrary.Conv_NameToString");

	struct { FName InName; FString OutStr; } Conv_NameToString_Params{*this};

	KismetStringLibrary->ProcessEvent(Conv_NameToString, &Conv_NameToString_Params);

	auto Str = Conv_NameToString_Params.OutStr.ToString();

	Conv_NameToString_Params.OutStr.Free();

	return Str;
}

// The assignment lives in its own function so TryNameToString's frame owns no C++ object that needs
// unwinding; MSVC refuses __try in such a frame (C2712). Do not inline this back in.
static bool NameToStringInner(FName* Name, std::string* Out)
{
	*Out = Name->ToString();
	return true;
}

bool TryNameToString(FName* Name, std::string* Out)
{
	if (!Name || !Out)
		return false;

	__try
	{
		return NameToStringInner(Name, Out);
	}
	__except (EXCEPTION_EXECUTE_HANDLER)
	{
		// The crash handler in dllmain.cpp is a VECTORED handler, so it already ran and wrote
		// crash.log/crash.dmp before we got here. That is deliberate: we still want the evidence, we
		// just refuse to die for a cosmetic lookup.
		return false;
	}
}

std::string UObject::GetName()
{
	/* if (!StaticFindObjectO)
	{
		FString temp;

		ToStringO(&this->NamePrivate, temp);

		auto Str = temp.ToString();

		temp.Free();

		return Str;
	}
	else */
	{
		static auto GetObjectNameFunction = FindObject<UFunction>("/Script/Engine.KismetSystemLibrary.GetObjectName");
		static auto KismetSystemLibrary = FindObject("/Script/Engine.Default__KismetSystemLibrary");

		struct { UObject* Object; FString ReturnValue; } GetObjectName_Params{ this };

		KismetSystemLibrary->ProcessEvent(GetObjectNameFunction, &GetObjectName_Params);

		auto Ret = GetObjectName_Params.ReturnValue;
		auto RetStr = Ret.ToString();

		Ret.Free();

		return RetStr;
	}
}

std::string UObject::GetPathName()
{	
	/* if (!StaticFindObjectO)
	{
		std::string temp;

		for (auto outer = OuterPrivate; outer; outer = outer->OuterPrivate)
			temp = std::format("{}.{}", outer->GetName(), temp);

		return std::format("{}{}", ClassPrivate->GetName(), temp, this->GetName());
	}
	else */
	{
		static auto GetPathNameFunction = FindObject<UFunction>("/Script/Engine.KismetSystemLibrary.GetPathName");
		static auto KismetSystemLibrary = FindObject("/Script/Engine.Default__KismetSystemLibrary");

		struct { UObject* Object; FString ReturnValue; } GetPathName_Params{ this };

		KismetSystemLibrary->ProcessEvent(GetPathNameFunction, &GetPathName_Params);

		auto Ret = GetPathName_Params.ReturnValue;
		auto RetStr = Ret.ToString();

		Ret.Free();

		return RetStr;
	}
}

std::string UObject::GetFullName()
{
	return ClassPrivate ? ClassPrivate->GetName() + " " + GetPathName() : "NoClassPrivate";
}

void UObject::ProcessEvent(struct UFunction* Function, void* Parameters)
{
	return ProcessEventO(this, reinterpret_cast<UObject*>(Function), Parameters);
}

template <typename ObjectType>
ObjectType* FindObject(const std::string& ObjectName, UObject* Class, UObject* InOuter)
{
	if (!StaticFindObjectO)
		return (ObjectType*)FindObjectSlow(ObjectName); // (ObjectType*)FindObjectSlow(Class->GetName() + " " + ObjectName, false);

	auto& ObjectNameCut = ObjectName; // ObjectName.substr(ObjectName.find(" ") + 1);
	auto ObjectNameWide = std::wstring(ObjectNameCut.begin(), ObjectNameCut.end()).c_str();

	return (ObjectType*)StaticFindObjectO(Class, InOuter, ObjectNameWide, false);
}

int FindOffsetStruct(const std::string& StructName, const std::string& MemberName, bool bExactStruct)
{
	return FindOffsetStruct2(StructName, MemberName);

	auto Struct = bExactStruct ? FindObjectSlow(StructName, false) : FindObject(StructName);

	if (!Struct)
		return 0;

	if (Engine_Version >= 425)
		return Struct->GetOffset(MemberName);

	static auto PropertyClass = FindObject("/Script/CoreUObject.Property");

	auto Prop = FindObject(MemberName, PropertyClass, Struct);

	if (!Prop)
	{
		std::cout << "Failed to find1 " << MemberName << '\n';
		return 0;
	}

	return *(uint32_t*)(__int64(Prop) + Offset_InternalOffset);
}

std::string GetNameOfChild(void* Child)
{
	FName* NamePrivate = nullptr;

	if (Engine_Version >= 425)
		NamePrivate = (FName*)(__int64(Child) + 0x28);
	else
		NamePrivate = &((UField*)Child)->NamePrivate;

	return NamePrivate ? NamePrivate->ToString() : "";
}

void* GetNextOfChild(void* Child)
{
	if (Engine_Version >= 425)
		return *(void**)(__int64(Child) + 0x20);
	else
		return ((UField*)Child)->Next;
}

void* FindPropStruct2(const std::string& StructName, const std::string& MemberName, bool bPrint, bool bContain, bool bWarnIfNotFound)
{
	UObject* CurrentClass = nullptr;

	if (!bContain)
		CurrentClass = FindObjectSlow(StructName, false);
	else
		CurrentClass = FindObject(StructName);

	if (bPrint)
		std::cout << "CurrentClass: " << CurrentClass << '\n';

	if (CurrentClass)
	{
		auto Property = *(void**)(__int64(CurrentClass) + ChildPropertiesOffset);

		if (bPrint)
			std::cout << "Property: " << Property << '\n';

		if (Property)
		{
			auto PropName = GetNameOfChild(Property);

			while (Property)
			{
				if (bPrint)
					std::cout << "PropName: " << PropName << '\n';

				if (PropName == MemberName)
				{
					return Property;
				}
				else
				{
					Property = GetNextOfChild(Property);

					if (Property)
					{
						PropName = GetNameOfChild(Property);
					}
				}
			}
		}
	}

	if (bWarnIfNotFound)
		std::cout << "Unable to find2 " << MemberName << '\n';

	return 0;
}

UObject* LoadObject(UObject* Class, const std::string& Name) // dont trust ret
{
	UObject* Object = FindObject(Name);

	if (!Object)
	{
		Defines::ObjectsToLoad.push_back(std::make_pair(Class, Name));

		int attempts = 0;

		while (attempts < 1000 && !Object)
		{
			Object = FindObject(Name);
			attempts++;
			// Sleep(5);
		}
	}

	return Object;
}

int FindOffsetStruct2(const std::string& StructName, const std::string& MemberName, bool bPrint, bool bContain, bool bWarnIfNotFound)
{
	UObject* CurrentClass = nullptr;

	if (!bContain)
		CurrentClass = FindObjectSlow(StructName, false);
	else
		CurrentClass = FindObject(StructName);

	if (bPrint)
		std::cout << "CurrentClass: " << CurrentClass << '\n';

	if (CurrentClass)
	{
		auto Property = *(void**)(__int64(CurrentClass) + ChildPropertiesOffset);

		if (bPrint)
			std::cout << "Property: " << Property << '\n';

		if (Property)
		{
			auto PropName = GetNameOfChild(Property);

			while (Property)
			{
				if (bPrint)
					std::cout << "PropName: " << PropName << '\n';

				if (PropName == MemberName)
				{
					return *(int*)(__int64(Property) + Offset_InternalOffset);
				}
				else
				{
					Property = GetNextOfChild(Property);

					if (Property)
					{
						PropName = GetNameOfChild(Property);
					}
				}
			}
		}
	}

	if (bWarnIfNotFound)
		std::cout << "Unable to find2 " << MemberName << '\n';

	return 0;
}

int GetEnumValue(UObject* Enum, const std::string& EnumMemberName)
{
	if (!Enum)
		return -1;

	auto Names = (TArray<TPair<FName, __int64>>*)(__int64(Enum) + sizeof(UField) + sizeof(FString));

	if (Names)
	{
		for (int i = 0; i < Names->Num(); i++)
		{
			auto Pair = Names->At(i);
			auto& Name = Pair.Key();
			auto Value = Pair.Value();

			if (Name.ComparisonIndex && Name.ToString().contains(EnumMemberName))
				return Value;
		}
	}

	return -1;
}

UObject* GetDefaultObject(UObject* Class)
{
	auto name = Class->GetFullName();

	// skunked class to default
	auto ending = name.substr(name.find_last_of(".") + 1);
	auto path = name.substr(0, name.find_last_of(".") + 1);

	path = path.substr(path.find_first_of(" ") + 1);

	auto DefaultAbilityName = std::format("{0}Default__{1}", path, ending);

	return FindObject(DefaultAbilityName);
}

void* UObject::GetProperty(const std::string& MemberName, bool bIsSuperStruct, bool bPrint, bool bWarnIfNotFound)
{
	if (Engine_Version >= 425) // fprop dont think work with this
		return GetPropertySlow(MemberName, bPrint, bWarnIfNotFound);

	static auto PropertyClass = FindObject("/Script/CoreUObject.Property");

	UObject* Property = nullptr;

	if (bIsSuperStruct)
	{
		Property = FindObject(MemberName, PropertyClass, this);
	}
	else
	{
		UObject* super = ClassPrivate;

		while (super && !Property)
		{
			Property = FindObject(MemberName, PropertyClass, super);

			super = *(UObject**)(__int64(super) + SuperStructOffset);
		}
	}

	if (!Property) // Didn't find property
	{
		// Record it even when the caller asked not to warn. A probe that deliberately suppresses the
		// warning (GetOffsetChecked does exactly that) still wants the miss counted — the report is
		// the whole point, and a silent probe is how 307 of these stayed invisible.
		Offsets::NoteMissing(this, MemberName);

		// Deliberately does NOT name the owner here — GetName() is a ProcessEvent into the engine and
		// this is an error path that can run before the engine is ready. Offsets::Report() prints the
		// owner, resolved later when that is safe. (The original text was "Failed to find3", which
		// named neither the owner nor anything greppable.)
		if (bWarnIfNotFound)
			std::cout << "Failed to find property '" << MemberName << "' (see the offset report)\n";

		return 0;
	}

	return Property;
}

void* UObject::GetPropertySlow(const std::string& MemberName, bool bPrint, bool bWarnIfNotFound)
{
	for (auto CurrentClass = ClassPrivate; CurrentClass; CurrentClass = *(UObject**)(__int64(CurrentClass) + SuperStructOffset))
	{
		auto Property = *(void**)(__int64(CurrentClass) + ChildPropertiesOffset);

		if (Property)
		{
			auto PropName = GetNameOfChild(Property);

			if (bPrint)
				std::cout << "PropName: " << PropName << '\n';

			if (PropName == MemberName) // somehow it didnt work without this?!?!?!?!?!?!?!?!!?!!?!?!?!?
			{
				return Property;
			}

			while (Property)
			{
				if (bPrint)
					std::cout << "PropName: " << PropName << '\n';

				if (PropName == MemberName)
				{
					return Property;
				}

				Property = GetNextOfChild(Property);
				PropName = Property ? GetNameOfChild(Property) : "";
			}
		}
	}

	// Same as the fast path above: count it regardless of whether the caller wanted it printed.
	Offsets::NoteMissing(this, MemberName);

	// Same reasoning as the fast path: no GetName() on an error path.
	if (bWarnIfNotFound)
		std::cout << "Failed to find property '" << MemberName << "' (slow path, see the offset report)\n";

	return nullptr;
}

int UObject::GetOffset(const std::string& MemberName, bool bIsSuperStruct, bool bPrint, bool bWarnIfNotFound)
{
	auto Property = GetProperty(MemberName, bIsSuperStruct, bPrint, bWarnIfNotFound);

	if (Property)
		return *(int*)(__int64(Property) + Offset_InternalOffset);

	return 0;
}

int UObject::GetOffsetSlow(const std::string& MemberName, bool bPrint, bool bWarnIfNotFound)
{
	auto Property = GetPropertySlow(MemberName, bPrint, bWarnIfNotFound);

	if (Property)
		return *(int*)(__int64(Property) + Offset_InternalOffset);

	return 0;
}

bool UObject::IsA(UObject* otherClass)
{
	UObject* super = ClassPrivate;

	while (super)
	{
		if (otherClass == super)
			return true;

		super = *(UObject**)(__int64(super) + SuperStructOffset);
	}

	return false;
}
// ── Offset failure tracking ──────────────────────────────────────────────────────────────────────
//
// See the comment on `namespace Offsets` in structs.h for why this exists. In short: ~307 lookup
// sites treat GetOffset's 0 as a usable offset, the two failure paths print a line nobody can search
// for and that does not say what was being searched, and nothing counts them. This makes the failures
// enumerable without changing a single decision the code makes.


namespace Offsets
{
	namespace
	{
		std::mutex g_mutex;
		// Keyed on (owner pointer, member) so two different classes missing the same member name stay
		// distinct — and deduplicated, which matters because a non-static call site re-runs its lookup
		// on every call and would otherwise flood this.
		//
		// Holding the owner as a raw pointer is safe for what actually lands here: these are UClass
		// and UFunction objects, which live for the process. It is NOT dereferenced until Report().
		std::set<std::pair<UObject*, std::string>> g_missing;
		std::set<std::pair<UObject*, std::string>> g_reported;
	}

	void NoteMissing(UObject* Owner, const std::string& Member)
	{
		std::lock_guard<std::mutex> lock(g_mutex);
		g_missing.insert({ Owner, Member });
	}

	int MissingCount()
	{
		std::lock_guard<std::mutex> lock(g_mutex);
		return static_cast<int>(g_missing.size());
	}

	void Report()
	{
		std::vector<std::pair<UObject*, std::string>> fresh;
		{
			std::lock_guard<std::mutex> lock(g_mutex);
			for (const auto& m : g_missing)
			{
				if (g_reported.insert(m).second)
					fresh.push_back(m);
			}
		}

		if (fresh.empty())
			return;

		std::cout << "\n-- OFFSETS NOT FOUND ON THIS BUILD -----------------------------\n";
		for (const auto& [owner, member] : fresh)
		{
			// Resolve the owner's name HERE, not at record time — GetName() calls into the engine,
			// and the point of deferring it is that by now the engine is up. IsPlausibleName is the
			// same guard FName::ToString needs elsewhere in this file: a ComparisonIndex that did not
			// come from a real name field walks GNames out of bounds and kills the process.
			std::string ownerName = "<unnamed>";
			if (owner && IsPlausibleName(owner->NamePrivate))
				ownerName = owner->GetName();

			std::cout << "  " << ownerName << " :: " << member << '\n';
		}
		std::cout << "  " << fresh.size() << " new, " << MissingCount() << " total.\n";
		std::cout << "  Each of these gave offset 0 at its call site, which is\n";
		std::cout << "  indistinguishable from a real first-member offset. Anything that\n";
		std::cout << "  dereferences one is reading the start of the struct instead.\n";
		std::cout << "  See KNOWN_ISSUES trap8-systemic-unguarded-offsets.\n";
		std::cout << "---------------------------------------------------------------\n\n";
	}
}

int UObject::GetOffsetChecked(const std::string& MemberName, bool bIsSuperStruct)
{
	// A null `this` is a real case, not paranoia: FindObject returns null for a class a build does
	// not have, and calling straight through that result is the easiest mistake here to make.
	if (!this)
		return -1;

	// Ask for the PROPERTY, not the offset. GetOffset cannot distinguish "absent" from "offset 0";
	// GetProperty is null only when genuinely absent. bWarnIfNotFound is false because this function
	// reports the miss itself, with the owner's name attached — which the built-in warning lacks.
	auto Property = GetProperty(MemberName, bIsSuperStruct, false, false);
	if (!Property)
	{
		Offsets::NoteMissing(this, MemberName);
		return -1;
	}

	return *(int*)(__int64(Property) + Offset_InternalOffset);
}
