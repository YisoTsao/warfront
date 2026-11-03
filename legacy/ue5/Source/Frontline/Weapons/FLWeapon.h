#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Core/FLTypes.h"
#include "FLWeapon.generated.h"

class AFLCharacter;
class UFLWeaponData;
class USkeletalMeshComponent;

/**
 * Generic hitscan firearm driven entirely by UFLWeaponData.
 *
 * Network model:
 *  - The owning client fires immediately (cosmetics, recoil, predicted ammo) and sends
 *    the aim origin/direction plus a random seed to the server.
 *  - The server validates rate of fire, ammo and origin, recomputes spread from its own
 *    view of the shooter's state using the same seed, traces and applies damage.
 *  - Other clients receive a lightweight unreliable multicast for muzzle/impact effects.
 */
UCLASS(Blueprintable)
class FRONTLINE_API AFLWeapon : public AActor
{
	GENERATED_BODY()

public:
	AFLWeapon();

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;
	virtual void Tick(float DeltaSeconds) override;

	/** Server: set data and fill ammo. */
	void InitializeWeapon(const UFLWeaponData* InData);

	void OnEquipped(AFLCharacter* NewOwner);
	void OnUnequipped();

	// ---- Owning client actions ----
	void StartFire();
	void StopFire();
	void StartReload();
	void CycleFireMode();

	// ---- Server ----
	void RefillReserveAmmo();

	// ---- Queries ----
	const UFLWeaponData* GetWeaponData() const { return Data; }

	UFUNCTION(BlueprintPure, Category = "Weapon")
	int32 GetAmmoInMagazine() const { return AmmoInMagazine; }

	UFUNCTION(BlueprintPure, Category = "Weapon")
	int32 GetReserveAmmo() const { return ReserveAmmo; }

	UFUNCTION(BlueprintPure, Category = "Weapon")
	bool IsReloading() const { return bReloading; }

	UFUNCTION(BlueprintPure, Category = "Weapon")
	EFLFireMode GetFireMode() const;

	/** Current cone half-angle in degrees, including stance, movement and bloom. */
	UFUNCTION(BlueprintPure, Category = "Weapon")
	float GetCurrentSpread() const;

	bool CanFire() const;
	bool CanReload() const;

protected:
	UFUNCTION()
	void OnRep_WeaponId();

	UFUNCTION(Server, Reliable)
	void ServerFireShot(FVector_NetQuantize Origin, FVector_NetQuantizeNormal AimDirection, int32 Seed);

	UFUNCTION(Server, Reliable)
	void ServerStartReload();

	UFUNCTION(Server, Reliable)
	void ServerCancelReload();

	UFUNCTION(Server, Reliable)
	void ServerSetFireMode(uint8 NewIndex);

	/** Corrects the owner's predicted ammo when the server rejects a shot. */
	UFUNCTION(Client, Reliable)
	void ClientSyncAmmo(int32 ServerAmmo);

	UFUNCTION(NetMulticast, Unreliable)
	void MulticastShotFX(FVector_NetQuantize ImpactPoint, FVector_NetQuantizeNormal ImpactNormal, bool bHit);

	void TryFireNext();
	void FireShotLocal();

	/** Traces every pellet. When bAuthoritative, applies damage. Returns the first impact for FX. */
	void ProcessShot(const FVector& Origin, const FVector& AimDirection, int32 Seed, bool bAuthoritative,
		FVector& OutImpactPoint, FVector& OutImpactNormal, bool& bOutHit);

	void ApplyHit(const FHitResult& Hit, const FVector& Origin, const FVector& Direction);
	float GetHitZoneMultiplier(const FHitResult& Hit) const;

	void BeginReload();
	void FinishReload();
	void CancelReload();

	void ApplyRecoil();
	void UpdateRecoilRecovery(float DeltaSeconds);
	void PlayShotFX(const FVector& ImpactPoint, const FVector& ImpactNormal, bool bHit);
	FVector GetMuzzleLocation() const;
	AFLCharacter* GetFLOwner() const;
	bool IsLocallyControlledOwner() const;

	UPROPERTY(VisibleAnywhere, Category = "Components")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY(VisibleAnywhere, Category = "Components")
	TObjectPtr<USkeletalMeshComponent> Mesh1P;

	UPROPERTY(VisibleAnywhere, Category = "Components")
	TObjectPtr<USkeletalMeshComponent> Mesh3P;

	/** Socket on the first-person arms mesh. */
	UPROPERTY(EditDefaultsOnly, Category = "Weapon")
	FName FirstPersonAttachSocket = TEXT("GripPoint");

	/** Socket on the third-person body mesh. */
	UPROPERTY(EditDefaultsOnly, Category = "Weapon")
	FName ThirdPersonAttachSocket = TEXT("weapon_r");

	UPROPERTY(ReplicatedUsing = OnRep_WeaponId)
	FName WeaponId;

	UPROPERTY(Transient)
	TObjectPtr<const UFLWeaponData> Data;

	UPROPERTY(Replicated)
	int32 AmmoInMagazine = 0;

	UPROPERTY(Replicated)
	int32 ReserveAmmo = 0;

	UPROPERTY(Replicated)
	uint8 FireModeIndex = 0;

	UPROPERTY(Replicated)
	bool bReloading = false;

	// ---- Local firing state ----
	bool bWantsToFire = false;
	bool bTriggerConsumed = false;
	bool bEquipped = false;
	int32 BurstShotsRemaining = 0;
	int32 ConsecutiveShots = 0;
	float LastFireTime = -100.f;
	float EquipFinishTime = 0.f;
	float CurrentBloom = 0.f;
	float PendingRecoilRecovery = 0.f;
	float LastServerFireTime = -100.f;
	FTimerHandle FireTimer;
	FTimerHandle ReloadTimer;
};
