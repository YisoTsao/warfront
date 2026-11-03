#include "Weapons/FLInventoryComponent.h"
#include "Weapons/FLWeapon.h"
#include "Weapons/FLWeaponData.h"
#include "Equipment/FLEquipmentData.h"
#include "Equipment/FLThrowable.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "Data/FLContentRegistry.h"
#include "Player/FLCharacter.h"
#include "Engine/World.h"
#include "Net/UnrealNetwork.h"

UFLInventoryComponent::UFLInventoryComponent()
{
	SetIsReplicatedByDefault(true);
	PrimaryComponentTick.bCanEverTick = false;
}

void UFLInventoryComponent::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(UFLInventoryComponent, Weapons);
	DOREPLIFETIME(UFLInventoryComponent, CurrentWeapon);
	DOREPLIFETIME_CONDITION(UFLInventoryComponent, Equipment, COND_OwnerOnly);
}

AFLCharacter* UFLInventoryComponent::GetCharacter() const
{
	return Cast<AFLCharacter>(GetOwner());
}

void UFLInventoryComponent::GiveLoadout(const UFLClassDefinition* ClassDef, int32 PrimaryIndex)
{
	AFLCharacter* Character = GetCharacter();
	if (!Character || !Character->HasAuthority() || !ClassDef)
	{
		return;
	}

	ClearLoadout();

	auto SpawnWeapon = [this, Character](const UFLWeaponData* Data)
	{
		if (!Data)
		{
			return;
		}
		UClass* WeaponClass = Data->WeaponClass ? Data->WeaponClass.Get() : AFLWeapon::StaticClass();
		FActorSpawnParameters Params;
		Params.Owner = Character;
		Params.Instigator = Character;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		if (AFLWeapon* Weapon = GetWorld()->SpawnActor<AFLWeapon>(WeaponClass, Character->GetActorTransform(), Params))
		{
			Weapon->InitializeWeapon(Data);
			Weapons.Add(Weapon);
		}
	};

	const TArray<TObjectPtr<UFLWeaponData>>& Primaries = ClassDef->PrimaryWeaponOptions;
	if (Primaries.Num() > 0)
	{
		SpawnWeapon(Primaries[Primaries.IsValidIndex(PrimaryIndex) ? PrimaryIndex : 0]);
	}
	if (ClassDef->SecondaryWeaponOptions.Num() > 0)
	{
		SpawnWeapon(ClassDef->SecondaryWeaponOptions[0]);
	}

	for (const FFLEquipmentLoadout& Loadout : ClassDef->Equipment)
	{
		if (Loadout.Equipment)
		{
			FFLEquipmentSlot Slot;
			Slot.EquipmentId = Loadout.Equipment->GetEquipmentId();
			Slot.Count = Loadout.Count;
			Slot.MaxCount = Loadout.Count;
			Equipment.Add(Slot);
		}
	}

	if (Weapons.Num() > 0)
	{
		SetCurrentWeapon(Weapons[0], nullptr);
	}
}

void UFLInventoryComponent::ClearLoadout()
{
	if (!GetOwner() || !GetOwner()->HasAuthority())
	{
		return;
	}
	for (AFLWeapon* Weapon : Weapons)
	{
		if (Weapon)
		{
			Weapon->OnUnequipped();
			Weapon->Destroy();
		}
	}
	Weapons.Reset();
	Equipment.Reset();
	CurrentWeapon = nullptr;
}

void UFLInventoryComponent::RefillAmmoAndEquipment()
{
	if (!GetOwner() || !GetOwner()->HasAuthority())
	{
		return;
	}
	for (AFLWeapon* Weapon : Weapons)
	{
		if (Weapon)
		{
			Weapon->RefillReserveAmmo();
		}
	}
	for (FFLEquipmentSlot& Slot : Equipment)
	{
		Slot.Count = Slot.MaxCount;
	}
}

void UFLInventoryComponent::EquipWeaponAt(int32 Index)
{
	if (!Weapons.IsValidIndex(Index) || Weapons[Index] == CurrentWeapon)
	{
		return;
	}
	// Predict locally, then tell the server.
	AFLWeapon* Old = CurrentWeapon;
	CurrentWeapon = Weapons[Index];
	SetCurrentWeapon(CurrentWeapon, Old);
	if (!GetOwner()->HasAuthority())
	{
		ServerEquipWeaponAt(Index);
	}
}

void UFLInventoryComponent::CycleWeapon(int32 Direction)
{
	if (Weapons.Num() < 2)
	{
		return;
	}
	const int32 CurrentIndex = FMath::Max(0, Weapons.IndexOfByKey(CurrentWeapon));
	EquipWeaponAt((CurrentIndex + Direction + Weapons.Num()) % Weapons.Num());
}

void UFLInventoryComponent::ServerEquipWeaponAt_Implementation(int32 Index)
{
	EquipWeaponAt(Index);
}

void UFLInventoryComponent::SetCurrentWeapon(AFLWeapon* NewWeapon, AFLWeapon* OldWeapon)
{
	CurrentWeapon = NewWeapon;
	if (OldWeapon && OldWeapon != NewWeapon)
	{
		OldWeapon->OnUnequipped();
	}
	if (NewWeapon)
	{
		NewWeapon->OnEquipped(GetCharacter());
	}
}

void UFLInventoryComponent::OnRep_CurrentWeapon(AFLWeapon* OldWeapon)
{
	SetCurrentWeapon(CurrentWeapon, OldWeapon);
}

void UFLInventoryComponent::ThrowEquipment(int32 SlotIndex)
{
	AFLCharacter* Character = GetCharacter();
	if (!Character || !Equipment.IsValidIndex(SlotIndex) || Equipment[SlotIndex].Count <= 0)
	{
		return;
	}
	FVector Origin;
	FRotator Rotation;
	Character->GetActorEyesViewPoint(Origin, Rotation);
	ServerThrowEquipment(SlotIndex, Origin, Rotation.Vector());
}

void UFLInventoryComponent::ServerThrowEquipment_Implementation(int32 SlotIndex, FVector_NetQuantize Origin, FVector_NetQuantizeNormal Direction)
{
	AFLCharacter* Character = GetCharacter();
	if (!Character || !Character->IsAlive() || !Equipment.IsValidIndex(SlotIndex) || Equipment[SlotIndex].Count <= 0)
	{
		return;
	}

	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	const UFLEquipmentData* Data = Registry ? Registry->FindEquipment(Equipment[SlotIndex].EquipmentId) : nullptr;
	if (!Data)
	{
		return;
	}

	const float Now = GetWorld()->GetTimeSeconds();
	if (Now - LastThrowTime < Data->Cooldown)
	{
		return;
	}

	// Never trust the client origin: clamp it to the server's view of the eyes.
	FVector ServerEyes;
	FRotator ServerRot;
	Character->GetActorEyesViewPoint(ServerEyes, ServerRot);
	const FVector SafeOrigin = FVector::DistSquared(Origin, ServerEyes) < FMath::Square(150.f) ? FVector(Origin) : ServerEyes;
	const FVector Dir = FVector(Direction).GetSafeNormal();

	UClass* ThrowClass = Data->ThrowableClass ? Data->ThrowableClass.Get() : AFLThrowable::StaticClass();
	FActorSpawnParameters Params;
	Params.Owner = Character;
	Params.Instigator = Character;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	const FVector SpawnLoc = SafeOrigin + Dir * 40.f;
	if (AFLThrowable* Throwable = GetWorld()->SpawnActor<AFLThrowable>(ThrowClass, SpawnLoc, Dir.Rotation(), Params))
	{
		const FVector Velocity = Dir * Data->ThrowSpeed + Character->GetVelocity() * 0.5f + FVector(0.f, 0.f, 150.f);
		Throwable->InitThrowable(Data, Character->GetController(), Velocity);
		--Equipment[SlotIndex].Count;
		LastThrowTime = Now;
	}
}
