#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "FLInventoryComponent.generated.h"

class AFLWeapon;
class AFLCharacter;
class UFLClassDefinition;

USTRUCT(BlueprintType)
struct FFLEquipmentSlot
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Equipment")
	FName EquipmentId;

	UPROPERTY(BlueprintReadOnly, Category = "Equipment")
	int32 Count = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Equipment")
	int32 MaxCount = 0;
};

/** Weapons and equipment carried by a character. The server spawns and owns everything. */
UCLASS(ClassGroup = (Frontline), meta = (BlueprintSpawnableComponent))
class FRONTLINE_API UFLInventoryComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UFLInventoryComponent();

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

	// ---- Server ----
	void GiveLoadout(const UFLClassDefinition* ClassDef, int32 PrimaryIndex);
	void ClearLoadout();
	void RefillAmmoAndEquipment();

	// ---- Owning client or server ----
	void EquipWeaponAt(int32 Index);
	void CycleWeapon(int32 Direction);
	void ThrowEquipment(int32 SlotIndex);

	UFUNCTION(BlueprintPure, Category = "Inventory")
	AFLWeapon* GetCurrentWeapon() const { return CurrentWeapon; }

	const TArray<TObjectPtr<AFLWeapon>>& GetWeapons() const { return Weapons; }
	const TArray<FFLEquipmentSlot>& GetEquipment() const { return Equipment; }

protected:
	UFUNCTION(Server, Reliable)
	void ServerEquipWeaponAt(int32 Index);

	UFUNCTION(Server, Reliable)
	void ServerThrowEquipment(int32 SlotIndex, FVector_NetQuantize Origin, FVector_NetQuantizeNormal Direction);

	UFUNCTION()
	void OnRep_CurrentWeapon(AFLWeapon* OldWeapon);

	void SetCurrentWeapon(AFLWeapon* NewWeapon, AFLWeapon* OldWeapon);
	AFLCharacter* GetCharacter() const;

	UPROPERTY(Replicated)
	TArray<TObjectPtr<AFLWeapon>> Weapons;

	UPROPERTY(ReplicatedUsing = OnRep_CurrentWeapon)
	TObjectPtr<AFLWeapon> CurrentWeapon;

	UPROPERTY(Replicated)
	TArray<FFLEquipmentSlot> Equipment;

	float LastThrowTime = -100.f;
};
