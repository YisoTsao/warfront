#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "Core/FLTypes.h"
#include "FLWeaponData.generated.h"

class AFLWeapon;
class USkeletalMesh;
class UNiagaraSystem;
class USoundBase;
class UAnimMontage;

/** Damage model. Distances are in meters, damage in health points (players have 100 by default). */
USTRUCT(BlueprintType)
struct FFLDamageProfile
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float MaxDamage = 25.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float MinDamage = 18.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float FalloffStartMeters = 20.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float FalloffEndMeters = 60.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float HeadMultiplier = 1.8f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float LimbMultiplier = 0.9f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float MaxRangeMeters = 1000.f;

	/** >1 for shotguns. Damage values are per pellet. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage", meta = (ClampMin = 1))
	int32 Pellets = 1;

	/** Extra cone (degrees) each pellet is scattered within, on top of weapon spread. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Damage")
	float PelletSpread = 0.f;
};

/** Spread (cone half-angle in degrees). */
USTRUCT(BlueprintType)
struct FFLSpreadProfile
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float HipSpread = 3.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float AimSpread = 0.2f;

	/** Bloom added per shot. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float SpreadPerShot = 0.25f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float MaxBloom = 2.5f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float BloomRecoveryPerSecond = 6.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float MovingMultiplier = 1.6f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float AirborneMultiplier = 3.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float CrouchMultiplier = 0.8f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spread")
	float ProneMultiplier = 0.6f;
};

/** View-kick recoil, applied to the owning client's control rotation. */
USTRUCT(BlueprintType)
struct FFLRecoilProfile
{
	GENERATED_BODY()

	/** Degrees of upward kick per shot. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float VerticalKick = 0.4f;

	/** Max random horizontal kick per shot (degrees, +/-). */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float HorizontalKick = 0.15f;

	/** -1 = always left, 0 = random, 1 = always right. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil", meta = (ClampMin = -1, ClampMax = 1))
	float HorizontalBias = 0.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float FirstShotMultiplier = 1.5f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float AimMultiplier = 0.75f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float CrouchMultiplier = 0.85f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float ProneMultiplier = 0.6f;

	/** Portion of vertical kick that recovers automatically after firing stops. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil", meta = (ClampMin = 0, ClampMax = 1))
	float RecoveryFraction = 0.6f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float RecoverySpeed = 10.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Recoil")
	float RecoveryDelay = 0.1f;
};

/**
 * Everything that defines a weapon. Create one data asset per weapon under
 * /Game/Frontline/Data/Weapons; no code changes are needed to add a weapon.
 */
UCLASS(BlueprintType)
class FRONTLINE_API UFLWeaponData : public UPrimaryDataAsset
{
	GENERATED_BODY()

public:
	virtual FPrimaryAssetId GetPrimaryAssetId() const override;

	/** Stable id used for replication and loadouts. Defaults to the asset name when empty. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	FName WeaponId;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	FText DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	EFLWeaponCategory Category = EFLWeaponCategory::AssaultRifle;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	EFLWeaponSlot Slot = EFLWeaponSlot::Primary;

	/** Actor class to spawn. Leave empty to use AFLWeapon; set a Blueprint subclass for custom behavior. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	TSubclassOf<AFLWeapon> WeaponClass;

	// ---- Firing ----
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Firing")
	TArray<EFLFireMode> FireModes = { EFLFireMode::FullAuto, EFLFireMode::Single };

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Firing", meta = (ClampMin = 1))
	float RoundsPerMinute = 750.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Firing", meta = (ClampMin = 2))
	int32 BurstCount = 3;

	// ---- Ammo ----
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ammo", meta = (ClampMin = 1))
	int32 MagazineSize = 30;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ammo", meta = (ClampMin = 0))
	int32 MaxReserveAmmo = 120;

	/** Tactical reload (rounds left in magazine). */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ammo")
	float ReloadTime = 2.2f;

	/** Reload from empty (includes chambering). */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ammo")
	float EmptyReloadTime = 2.8f;

	/** Load one round at a time (pump shotguns, some bolt-actions). Firing interrupts. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ammo")
	bool bReloadPerRound = false;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ammo", meta = (EditCondition = "bReloadPerRound"))
	float PerRoundReloadTime = 0.55f;

	// ---- Handling ----
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Handling")
	float EquipTime = 0.6f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Handling")
	float AimDownSightTime = 0.25f;

	/** Camera field of view while aiming down sights. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Handling")
	float AimFOV = 55.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Handling")
	FFLDamageProfile Damage;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Handling")
	FFLSpreadProfile Spread;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Handling")
	FFLRecoilProfile Recoil;

	// ---- Presentation (all optional) ----
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<USkeletalMesh> FirstPersonMesh;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<USkeletalMesh> ThirdPersonMesh;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	FName MuzzleSocket = TEXT("Muzzle");

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UNiagaraSystem> MuzzleFX;

	/** Spawned at the muzzle; receives the impact point in the user parameter "User.ImpactPoint". */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UNiagaraSystem> TracerFX;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UNiagaraSystem> ImpactFX;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<USoundBase> FireSound;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<USoundBase> DryFireSound;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<USoundBase> ReloadSound;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UAnimMontage> FireMontage1P;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UAnimMontage> ReloadMontage1P;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UAnimMontage> ReloadMontage3P;

	FName GetWeaponId() const { return WeaponId.IsNone() ? GetFName() : WeaponId; }
	float GetFireInterval() const { return 60.f / FMath::Max(1.f, RoundsPerMinute); }

	/** Per-pellet damage at the given distance (cm), before hit-zone multipliers. */
	float GetDamageAtDistance(float DistanceCm) const;
};
