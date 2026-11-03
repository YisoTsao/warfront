#include "Data/FLContentRegistry.h"
#include "Data/FLDefaultContent.h"
#include "Frontline.h"
#include "Weapons/FLWeaponData.h"
#include "Equipment/FLEquipmentData.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "Engine/AssetManager.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"

UFLContentRegistry* UFLContentRegistry::Get(const UObject* WorldContextObject)
{
	const UWorld* World = WorldContextObject ? WorldContextObject->GetWorld() : nullptr;
	const UGameInstance* GI = World ? World->GetGameInstance() : nullptr;
	return GI ? GI->GetSubsystem<UFLContentRegistry>() : nullptr;
}

void UFLContentRegistry::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	LoadFromAssetManager();
	FLDefaultContent::Register(*this);

	UE_LOG(LogFrontline, Log, TEXT("Content registry: %d weapons, %d equipment, %d classes"),
		Weapons.Num(), Equipment.Num(), Classes.Num());
}

void UFLContentRegistry::LoadFromAssetManager()
{
	if (!UAssetManager::IsInitialized())
	{
		return;
	}

	UAssetManager& AssetManager = UAssetManager::Get();

	auto LoadAll = [&AssetManager](const TCHAR* TypeName, TFunctionRef<void(UObject*)> Handler)
	{
		TArray<FPrimaryAssetId> Ids;
		AssetManager.GetPrimaryAssetIdList(FPrimaryAssetType(TypeName), Ids);
		for (const FPrimaryAssetId& Id : Ids)
		{
			const FSoftObjectPath Path = AssetManager.GetPrimaryAssetPath(Id);
			if (UObject* Loaded = Path.TryLoad())
			{
				Handler(Loaded);
			}
		}
	};

	// Weapons and equipment first so class definitions can reference them.
	LoadAll(TEXT("FLWeapon"), [this](UObject* Obj) { AddWeapon(Cast<UFLWeaponData>(Obj), true); });
	LoadAll(TEXT("FLEquipment"), [this](UObject* Obj) { AddEquipment(Cast<UFLEquipmentData>(Obj), true); });
	LoadAll(TEXT("FLClass"), [this](UObject* Obj) { AddClass(Cast<UFLClassDefinition>(Obj), true); });
}

const UFLWeaponData* UFLContentRegistry::FindWeapon(FName Id) const
{
	const TObjectPtr<UFLWeaponData>* Found = Weapons.Find(Id);
	return Found ? Found->Get() : nullptr;
}

const UFLEquipmentData* UFLContentRegistry::FindEquipment(FName Id) const
{
	const TObjectPtr<UFLEquipmentData>* Found = Equipment.Find(Id);
	return Found ? Found->Get() : nullptr;
}

const UFLClassDefinition* UFLContentRegistry::FindClass(FName Id) const
{
	const TObjectPtr<UFLClassDefinition>* Found = Classes.Find(Id);
	return Found ? Found->Get() : nullptr;
}

TArray<const UFLClassDefinition*> UFLContentRegistry::GetClasses() const
{
	TArray<const UFLClassDefinition*> Result;
	for (const TPair<FName, TObjectPtr<UFLClassDefinition>>& Pair : Classes)
	{
		Result.Add(Pair.Value);
	}
	Result.Sort([](const UFLClassDefinition& A, const UFLClassDefinition& B) { return A.SortOrder < B.SortOrder; });
	return Result;
}

void UFLContentRegistry::AddWeapon(UFLWeaponData* Data, bool bOverwrite)
{
	if (Data && (bOverwrite || !Weapons.Contains(Data->GetWeaponId())))
	{
		Weapons.Add(Data->GetWeaponId(), Data);
	}
}

void UFLContentRegistry::AddEquipment(UFLEquipmentData* Data, bool bOverwrite)
{
	if (Data && (bOverwrite || !Equipment.Contains(Data->GetEquipmentId())))
	{
		Equipment.Add(Data->GetEquipmentId(), Data);
	}
}

void UFLContentRegistry::AddClass(UFLClassDefinition* Data, bool bOverwrite)
{
	if (Data && (bOverwrite || !Classes.Contains(Data->GetClassId())))
	{
		Classes.Add(Data->GetClassId(), Data);
	}
}
