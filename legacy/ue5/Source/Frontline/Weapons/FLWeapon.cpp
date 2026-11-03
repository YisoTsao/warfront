#include "Weapons/FLWeapon.h"
#include "Weapons/FLWeaponData.h"
#include "Player/FLCharacter.h"
#include "Combat/FLDamageTypes.h"
#include "Data/FLContentRegistry.h"
#include "Frontline.h"

#include "Components/CapsuleComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "DrawDebugHelpers.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"
#include "Kismet/GameplayStatics.h"
#include "Net/UnrealNetwork.h"
#include "NiagaraComponent.h"
#include "NiagaraFunctionLibrary.h"
#include "TimerManager.h"

static TAutoConsoleVariable<int32> CVarDebugWeapons(
	TEXT("fl.Debug.Weapons"), 0,
	TEXT("1 = draw weapon traces and impacts."),
	ECVF_Cheat);

namespace
{
	/** Max distance (cm) between the client-reported and server-side muzzle origin. */
	constexpr float MaxOriginError = 200.f;

	/** Fraction of the fire interval tolerated for network jitter. */
	constexpr float FireRateTolerance = 0.75f;
}

AFLWeapon::AFLWeapon()
{
	PrimaryActorTick.bCanEverTick = true;
	bReplicates = true;
	bNetUseOwnerRelevancy = true;
	SetReplicateMovement(false);

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(Root);

	Mesh1P = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("Mesh1P"));
	Mesh1P->SetupAttachment(Root);
	Mesh1P->SetOnlyOwnerSee(true);
	Mesh1P->CastShadow = false;
	Mesh1P->bCastDynamicShadow = false;
	Mesh1P->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	Mesh3P = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("Mesh3P"));
	Mesh3P->SetupAttachment(Root);
	Mesh3P->SetOwnerNoSee(true);
	Mesh3P->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void AFLWeapon::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(AFLWeapon, WeaponId);
	DOREPLIFETIME(AFLWeapon, AmmoInMagazine);
	DOREPLIFETIME_CONDITION(AFLWeapon, ReserveAmmo, COND_OwnerOnly);
	DOREPLIFETIME(AFLWeapon, FireModeIndex);
	DOREPLIFETIME(AFLWeapon, bReloading);
}

AFLCharacter* AFLWeapon::GetFLOwner() const
{
	return Cast<AFLCharacter>(GetOwner());
}

bool AFLWeapon::IsLocallyControlledOwner() const
{
	const AFLCharacter* Character = GetFLOwner();
	return Character && Character->IsLocallyControlled();
}

// ---------------------------------------------------------------------------
// Setup

void AFLWeapon::InitializeWeapon(const UFLWeaponData* InData)
{
	if (!HasAuthority() || !InData)
	{
		return;
	}
	WeaponId = InData->GetWeaponId();
	OnRep_WeaponId();
	AmmoInMagazine = InData->MagazineSize;
	ReserveAmmo = InData->MaxReserveAmmo;
	FireModeIndex = 0;
}

void AFLWeapon::OnRep_WeaponId()
{
	if (const UFLContentRegistry* Registry = UFLContentRegistry::Get(this))
	{
		Data = Registry->FindWeapon(WeaponId);
	}
	if (!Data)
	{
		UE_LOG(LogFrontline, Warning, TEXT("Weapon id '%s' not found in content registry."), *WeaponId.ToString());
		return;
	}
	Mesh1P->SetSkeletalMesh(Data->FirstPersonMesh);
	Mesh3P->SetSkeletalMesh(Data->ThirdPersonMesh);
	if (bEquipped)
	{
		OnEquipped(GetFLOwner());
	}
}

void AFLWeapon::OnEquipped(AFLCharacter* NewOwner)
{
	bEquipped = true;
	if (!NewOwner)
	{
		return;
	}

	AttachToActor(NewOwner, FAttachmentTransformRules::SnapToTargetNotIncludingScale);
	if (USkeletalMeshComponent* Arms = NewOwner->GetFirstPersonMesh())
	{
		Mesh1P->AttachToComponent(Arms, FAttachmentTransformRules::SnapToTargetNotIncludingScale, FirstPersonAttachSocket);
	}
	Mesh3P->AttachToComponent(NewOwner->GetMesh(), FAttachmentTransformRules::SnapToTargetNotIncludingScale, ThirdPersonAttachSocket);
	Mesh1P->SetHiddenInGame(false);
	Mesh3P->SetHiddenInGame(false);

	EquipFinishTime = GetWorld()->GetTimeSeconds() + (Data ? Data->EquipTime : 0.5f);
	ConsecutiveShots = 0;
}

void AFLWeapon::OnUnequipped()
{
	bEquipped = false;
	StopFire();
	CancelReload();
	Mesh1P->SetHiddenInGame(true);
	Mesh3P->SetHiddenInGame(true);
}

// ---------------------------------------------------------------------------
// Queries

EFLFireMode AFLWeapon::GetFireMode() const
{
	if (Data && Data->FireModes.IsValidIndex(FireModeIndex))
	{
		return Data->FireModes[FireModeIndex];
	}
	return EFLFireMode::Single;
}

float AFLWeapon::GetCurrentSpread() const
{
	const AFLCharacter* Character = GetFLOwner();
	if (!Data || !Character)
	{
		return 0.f;
	}

	const FFLSpreadProfile& S = Data->Spread;
	const bool bAiming = Character->IsAiming();
	float Spread = bAiming ? S.AimSpread : S.HipSpread;

	switch (Character->GetStance())
	{
	case EFLStance::Crouching: Spread *= S.CrouchMultiplier; break;
	case EFLStance::Prone: Spread *= S.ProneMultiplier; break;
	default: break;
	}

	const UCharacterMovementComponent* Move = Character->GetCharacterMovement();
	if (Move && Move->IsFalling())
	{
		Spread *= S.AirborneMultiplier;
	}
	else if (Character->GetVelocity().Size2D() > 50.f)
	{
		Spread *= S.MovingMultiplier;
	}

	return Spread + CurrentBloom * (bAiming ? 0.5f : 1.f);
}

bool AFLWeapon::CanFire() const
{
	const AFLCharacter* Character = GetFLOwner();
	return Data && bEquipped && Character && Character->IsAlive() && !bReloading
		&& AmmoInMagazine > 0 && GetWorld()->GetTimeSeconds() >= EquipFinishTime;
}

bool AFLWeapon::CanReload() const
{
	const AFLCharacter* Character = GetFLOwner();
	return Data && bEquipped && Character && Character->IsAlive() && !bReloading
		&& ReserveAmmo > 0 && AmmoInMagazine < Data->MagazineSize;
}

// ---------------------------------------------------------------------------
// Firing (owning client)

void AFLWeapon::StartFire()
{
	if (!Data)
	{
		return;
	}
	if (bReloading && Data->bReloadPerRound && AmmoInMagazine > 0)
	{
		// Shell-by-shell reloads can be interrupted to fire.
		CancelReload();
		if (!HasAuthority())
		{
			ServerCancelReload();
		}
	}

	bWantsToFire = true;
	bTriggerConsumed = false;
	if (GetFireMode() == EFLFireMode::Burst && BurstShotsRemaining <= 0)
	{
		BurstShotsRemaining = Data->BurstCount;
	}
	TryFireNext();
}

void AFLWeapon::StopFire()
{
	bWantsToFire = false;
	if (GetFireMode() != EFLFireMode::Burst || BurstShotsRemaining <= 0)
	{
		GetWorldTimerManager().ClearTimer(FireTimer);
		BurstShotsRemaining = 0;
		ConsecutiveShots = 0;
	}
}

void AFLWeapon::TryFireNext()
{
	if (!Data)
	{
		return;
	}

	const float Now = GetWorld()->GetTimeSeconds();
	const float Interval = Data->GetFireInterval();
	const float Wait = FMath::Max(LastFireTime + Interval, EquipFinishTime) - Now;
	if (Wait > KINDA_SMALL_NUMBER)
	{
		GetWorldTimerManager().SetTimer(FireTimer, this, &AFLWeapon::TryFireNext, Wait, false);
		return;
	}

	const EFLFireMode Mode = GetFireMode();
	bool bShouldFire = false;
	switch (Mode)
	{
	case EFLFireMode::Single: bShouldFire = !bTriggerConsumed; break;
	case EFLFireMode::Burst: bShouldFire = BurstShotsRemaining > 0; break;
	case EFLFireMode::FullAuto: bShouldFire = bWantsToFire; break;
	}
	if (!bShouldFire)
	{
		return;
	}

	if (!CanFire())
	{
		if (AmmoInMagazine <= 0 && !bReloading)
		{
			if (Data->DryFireSound && !bTriggerConsumed)
			{
				UGameplayStatics::PlaySoundAtLocation(this, Data->DryFireSound, GetMuzzleLocation());
			}
			bTriggerConsumed = true;
			BurstShotsRemaining = 0;
			StartReload();
		}
		return;
	}

	FireShotLocal();
	LastFireTime = Now;
	bTriggerConsumed = true;
	if (Mode == EFLFireMode::Burst)
	{
		--BurstShotsRemaining;
	}

	const bool bContinue = (Mode == EFLFireMode::FullAuto && bWantsToFire) || (Mode == EFLFireMode::Burst && BurstShotsRemaining > 0);
	if (bContinue)
	{
		GetWorldTimerManager().SetTimer(FireTimer, this, &AFLWeapon::TryFireNext, Interval, false);
	}
	else if (Mode == EFLFireMode::Burst)
	{
		ConsecutiveShots = 0;
	}
}

void AFLWeapon::FireShotLocal()
{
	AFLCharacter* Character = GetFLOwner();
	AController* Controller = Character ? Character->GetController() : nullptr;
	if (!Controller)
	{
		return;
	}

	FVector Origin;
	FRotator AimRotation;
	Controller->GetPlayerViewPoint(Origin, AimRotation);
	const FVector AimDir = AimRotation.Vector();
	const int32 Seed = FMath::Rand();

	FVector ImpactPoint;
	FVector ImpactNormal;
	bool bHit = false;

	if (HasAuthority())
	{
		// Listen-server host: run the authoritative path directly.
		--AmmoInMagazine;
		LastServerFireTime = GetWorld()->GetTimeSeconds();
		ProcessShot(Origin, AimDir, Seed, true, ImpactPoint, ImpactNormal, bHit);
		MulticastShotFX(ImpactPoint, ImpactNormal, bHit);
	}
	else
	{
		--AmmoInMagazine; // predicted
		ProcessShot(Origin, AimDir, Seed, false, ImpactPoint, ImpactNormal, bHit);
		ServerFireShot(Origin, AimDir, Seed);
	}

	PlayShotFX(ImpactPoint, ImpactNormal, bHit);
	ApplyRecoil();
	CurrentBloom = FMath::Min(CurrentBloom + Data->Spread.SpreadPerShot, Data->Spread.MaxBloom);
	++ConsecutiveShots;

	if (Data->FireMontage1P && Character->GetFirstPersonMesh() && Character->GetFirstPersonMesh()->GetAnimInstance())
	{
		Character->GetFirstPersonMesh()->GetAnimInstance()->Montage_Play(Data->FireMontage1P);
	}
}

void AFLWeapon::ServerFireShot_Implementation(FVector_NetQuantize Origin, FVector_NetQuantizeNormal AimDirection, int32 Seed)
{
	AFLCharacter* Character = GetFLOwner();
	const float Now = GetWorld()->GetTimeSeconds();

	const bool bRateOk = Data && (Now - LastServerFireTime) >= Data->GetFireInterval() * FireRateTolerance;
	const bool bOriginOk = Character && FVector::DistSquared(Origin, Character->GetPawnViewLocation()) <= FMath::Square(MaxOriginError);
	if (!CanFire() || !bRateOk || !bOriginOk)
	{
		ClientSyncAmmo(AmmoInMagazine);
		return;
	}

	--AmmoInMagazine;
	LastServerFireTime = Now;

	FVector ImpactPoint;
	FVector ImpactNormal;
	bool bHit = false;
	ProcessShot(Origin, FVector(AimDirection).GetSafeNormal(), Seed, true, ImpactPoint, ImpactNormal, bHit);
	CurrentBloom = FMath::Min(CurrentBloom + Data->Spread.SpreadPerShot, Data->Spread.MaxBloom);

	MulticastShotFX(ImpactPoint, ImpactNormal, bHit);
}

void AFLWeapon::ClientSyncAmmo_Implementation(int32 ServerAmmo)
{
	AmmoInMagazine = ServerAmmo;
}

void AFLWeapon::ProcessShot(const FVector& Origin, const FVector& AimDirection, int32 Seed, bool bAuthoritative,
	FVector& OutImpactPoint, FVector& OutImpactNormal, bool& bOutHit)
{
	bOutHit = false;
	const float Range = Data->Damage.MaxRangeMeters * 100.f;
	OutImpactPoint = Origin + AimDirection * Range;
	OutImpactNormal = -AimDirection;

	FRandomStream Stream(Seed);
	const float SpreadRad = FMath::DegreesToRadians(GetCurrentSpread());
	const FVector CenterDir = SpreadRad > 0.f ? Stream.VRandCone(AimDirection, SpreadRad) : AimDirection;
	const float PelletRad = FMath::DegreesToRadians(Data->Damage.PelletSpread);

	FCollisionQueryParams Params(SCENE_QUERY_STAT(FLWeaponTrace), true, this);
	Params.AddIgnoredActor(GetOwner());
	Params.bReturnPhysicalMaterial = true;

	const bool bDebug = CVarDebugWeapons.GetValueOnGameThread() > 0;

	for (int32 Pellet = 0; Pellet < Data->Damage.Pellets; ++Pellet)
	{
		const FVector Dir = (Data->Damage.Pellets > 1 && PelletRad > 0.f) ? Stream.VRandCone(CenterDir, PelletRad) : CenterDir;
		const FVector End = Origin + Dir * Range;

		FHitResult Hit;
		const bool bBlocked = GetWorld()->LineTraceSingleByChannel(Hit, Origin, End, ECC_FLWeapon, Params);

		if (bDebug)
		{
			DrawDebugLine(GetWorld(), Origin, bBlocked ? Hit.ImpactPoint : End, bAuthoritative ? FColor::Red : FColor::Green, false, 2.f, 0, 0.5f);
			if (bBlocked)
			{
				DrawDebugPoint(GetWorld(), Hit.ImpactPoint, 8.f, bAuthoritative ? FColor::Red : FColor::Green, false, 2.f);
			}
		}

		if (bBlocked && Pellet == 0)
		{
			bOutHit = true;
			OutImpactPoint = Hit.ImpactPoint;
			OutImpactNormal = Hit.ImpactNormal;
		}

		if (bBlocked && bAuthoritative)
		{
			ApplyHit(Hit, Origin, Dir);
		}
	}
}

float AFLWeapon::GetHitZoneMultiplier(const FHitResult& Hit) const
{
	const AFLCharacter* Victim = Cast<AFLCharacter>(Hit.GetActor());
	if (!Victim)
	{
		return 1.f;
	}

	if (Victim->UsesCapsuleHitDetection())
	{
		// Gray-box: top 25 cm of the capsule counts as the head.
		const UCapsuleComponent* Capsule = Victim->GetCapsuleComponent();
		const float Top = Capsule->GetComponentLocation().Z + Capsule->GetScaledCapsuleHalfHeight();
		return Hit.ImpactPoint.Z >= Top - 25.f ? Data->Damage.HeadMultiplier : 1.f;
	}

	const FString Bone = Hit.BoneName.ToString().ToLower();
	if (Bone.Contains(TEXT("head")) || Bone.Contains(TEXT("neck")))
	{
		return Data->Damage.HeadMultiplier;
	}
	static const TCHAR* LimbTokens[] = { TEXT("arm"), TEXT("hand"), TEXT("thigh"), TEXT("calf"), TEXT("foot"), TEXT("leg") };
	for (const TCHAR* Token : LimbTokens)
	{
		if (Bone.Contains(Token))
		{
			return Data->Damage.LimbMultiplier;
		}
	}
	return 1.f;
}

void AFLWeapon::ApplyHit(const FHitResult& Hit, const FVector& Origin, const FVector& Direction)
{
	AActor* HitActor = Hit.GetActor();
	if (!HitActor || !HitActor->CanBeDamaged())
	{
		return;
	}

	AFLCharacter* Shooter = GetFLOwner();
	const float ZoneMultiplier = GetHitZoneMultiplier(Hit);
	const float Damage = Data->GetDamageAtDistance(FVector::Dist(Origin, Hit.ImpactPoint)) * ZoneMultiplier;

	AFLCharacter* Victim = Cast<AFLCharacter>(HitActor);
	const bool bWasAlive = Victim && Victim->IsAlive();

	const float Applied = UGameplayStatics::ApplyPointDamage(HitActor, Damage, Direction, Hit,
		Shooter ? Shooter->GetController() : nullptr, this, UFLDamageType_Bullet::StaticClass());

	if (Applied > 0.f && Victim && Shooter)
	{
		const bool bHeadshot = ZoneMultiplier > 1.f;
		Shooter->ClientNotifyHitConfirmed(bHeadshot, bWasAlive && !Victim->IsAlive());
	}
}

// ---------------------------------------------------------------------------
// Recoil & bloom

void AFLWeapon::ApplyRecoil()
{
	AFLCharacter* Character = GetFLOwner();
	APlayerController* PC = Character ? Cast<APlayerController>(Character->GetController()) : nullptr;
	if (!PC || !PC->IsLocalController() || !Data)
	{
		return;
	}

	const FFLRecoilProfile& R = Data->Recoil;
	float Multiplier = Character->IsAiming() ? R.AimMultiplier : 1.f;
	switch (Character->GetStance())
	{
	case EFLStance::Crouching: Multiplier *= R.CrouchMultiplier; break;
	case EFLStance::Prone: Multiplier *= R.ProneMultiplier; break;
	default: break;
	}
	if (ConsecutiveShots == 0)
	{
		Multiplier *= R.FirstShotMultiplier;
	}

	const float Vertical = R.VerticalKick * Multiplier * FMath::FRandRange(0.85f, 1.15f);
	const float Horizontal = (FMath::FRandRange(-1.f, 1.f) + R.HorizontalBias) * R.HorizontalKick * Multiplier;

	FRotator Control = PC->GetControlRotation();
	Control.Pitch += Vertical;
	Control.Yaw += Horizontal;
	PC->SetControlRotation(Control);

	PendingRecoilRecovery += Vertical * R.RecoveryFraction;
}

void AFLWeapon::UpdateRecoilRecovery(float DeltaSeconds)
{
	if (PendingRecoilRecovery <= 0.f || !Data)
	{
		return;
	}
	if (GetWorld()->GetTimeSeconds() - LastFireTime < Data->Recoil.RecoveryDelay)
	{
		return;
	}
	AFLCharacter* Character = GetFLOwner();
	APlayerController* PC = Character ? Cast<APlayerController>(Character->GetController()) : nullptr;
	if (!PC)
	{
		PendingRecoilRecovery = 0.f;
		return;
	}
	const float Step = FMath::Min(PendingRecoilRecovery, Data->Recoil.RecoverySpeed * DeltaSeconds);
	FRotator Control = PC->GetControlRotation();
	Control.Pitch -= Step;
	PC->SetControlRotation(Control);
	PendingRecoilRecovery -= Step;
}

void AFLWeapon::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (!Data)
	{
		return;
	}

	// Bloom decays on both server (authoritative spread) and owning client (crosshair).
	if (GetWorld()->GetTimeSeconds() - FMath::Max(LastFireTime, LastServerFireTime) > Data->GetFireInterval() * 1.5f)
	{
		CurrentBloom = FMath::Max(0.f, CurrentBloom - Data->Spread.BloomRecoveryPerSecond * DeltaSeconds);
	}

	if (IsLocallyControlledOwner())
	{
		UpdateRecoilRecovery(DeltaSeconds);
	}
}

// ---------------------------------------------------------------------------
// Reload

void AFLWeapon::StartReload()
{
	if (!CanReload())
	{
		return;
	}
	if (!HasAuthority())
	{
		ServerStartReload();
	}
	BeginReload();
}

void AFLWeapon::ServerStartReload_Implementation()
{
	if (CanReload())
	{
		BeginReload();
	}
}

void AFLWeapon::BeginReload()
{
	StopFire();
	bReloading = true;

	const float Duration = Data->bReloadPerRound
		? Data->PerRoundReloadTime
		: (AmmoInMagazine == 0 ? Data->EmptyReloadTime : Data->ReloadTime);
	GetWorldTimerManager().SetTimer(ReloadTimer, this, &AFLWeapon::FinishReload, FMath::Max(0.05f, Duration), false);

	if (GetNetMode() != NM_DedicatedServer)
	{
		AFLCharacter* Character = GetFLOwner();
		if (Data->ReloadSound)
		{
			UGameplayStatics::PlaySoundAtLocation(this, Data->ReloadSound, GetActorLocation());
		}
		if (Character && Data->ReloadMontage1P && Character->GetFirstPersonMesh()->GetAnimInstance())
		{
			Character->GetFirstPersonMesh()->GetAnimInstance()->Montage_Play(Data->ReloadMontage1P);
		}
	}
}

void AFLWeapon::FinishReload()
{
	if (!Data)
	{
		return;
	}

	// Runs on the server (authoritative) and the owning client (prediction).
	const int32 Needed = Data->MagazineSize - AmmoInMagazine;
	const int32 Loaded = FMath::Min(Data->bReloadPerRound ? 1 : Needed, ReserveAmmo);
	AmmoInMagazine += Loaded;
	ReserveAmmo -= Loaded;

	if (Data->bReloadPerRound && AmmoInMagazine < Data->MagazineSize && ReserveAmmo > 0)
	{
		GetWorldTimerManager().SetTimer(ReloadTimer, this, &AFLWeapon::FinishReload, Data->PerRoundReloadTime, false);
		return;
	}
	bReloading = false;
}

void AFLWeapon::CancelReload()
{
	GetWorldTimerManager().ClearTimer(ReloadTimer);
	bReloading = false;
}

void AFLWeapon::ServerCancelReload_Implementation()
{
	if (Data && Data->bReloadPerRound)
	{
		CancelReload();
	}
}

void AFLWeapon::RefillReserveAmmo()
{
	if (HasAuthority() && Data)
	{
		ReserveAmmo = Data->MaxReserveAmmo;
	}
}

// ---------------------------------------------------------------------------
// Fire mode

void AFLWeapon::CycleFireMode()
{
	if (!Data || Data->FireModes.Num() < 2)
	{
		return;
	}
	StopFire();
	const uint8 NewIndex = static_cast<uint8>((FireModeIndex + 1) % Data->FireModes.Num());
	FireModeIndex = NewIndex;
	if (!HasAuthority())
	{
		ServerSetFireMode(NewIndex);
	}
}

void AFLWeapon::ServerSetFireMode_Implementation(uint8 NewIndex)
{
	if (Data && Data->FireModes.IsValidIndex(NewIndex))
	{
		FireModeIndex = NewIndex;
	}
}

// ---------------------------------------------------------------------------
// Effects

FVector AFLWeapon::GetMuzzleLocation() const
{
	const USkeletalMeshComponent* Mesh = IsLocallyControlledOwner() ? Mesh1P.Get() : Mesh3P.Get();
	if (Data && Mesh && Mesh->GetSkeletalMeshAsset() && Mesh->DoesSocketExist(Data->MuzzleSocket))
	{
		return Mesh->GetSocketLocation(Data->MuzzleSocket);
	}
	if (const AFLCharacter* Character = GetFLOwner())
	{
		FVector EyeLoc;
		FRotator EyeRot;
		Character->GetActorEyesViewPoint(EyeLoc, EyeRot);
		return EyeLoc + EyeRot.Vector() * 60.f - FVector(0.f, 0.f, 10.f);
	}
	return GetActorLocation();
}

void AFLWeapon::MulticastShotFX_Implementation(FVector_NetQuantize ImpactPoint, FVector_NetQuantizeNormal ImpactNormal, bool bHit)
{
	// The shooter already played local effects; the dedicated server has nothing to show.
	if (IsLocallyControlledOwner() || GetNetMode() == NM_DedicatedServer)
	{
		return;
	}
	PlayShotFX(ImpactPoint, ImpactNormal, bHit);
}

void AFLWeapon::PlayShotFX(const FVector& ImpactPoint, const FVector& ImpactNormal, bool bHit)
{
	if (!Data || GetNetMode() == NM_DedicatedServer)
	{
		return;
	}

	const FVector Muzzle = GetMuzzleLocation();
	const bool bFirstPerson = IsLocallyControlledOwner();
	USkeletalMeshComponent* Mesh = bFirstPerson ? Mesh1P.Get() : Mesh3P.Get();

	if (Data->FireSound)
	{
		UGameplayStatics::PlaySoundAtLocation(this, Data->FireSound, Muzzle);
	}
	if (Data->MuzzleFX)
	{
		if (Mesh && Mesh->GetSkeletalMeshAsset())
		{
			UNiagaraFunctionLibrary::SpawnSystemAttached(Data->MuzzleFX, Mesh, Data->MuzzleSocket,
				FVector::ZeroVector, FRotator::ZeroRotator, EAttachLocation::SnapToTarget, true);
		}
		else
		{
			UNiagaraFunctionLibrary::SpawnSystemAtLocation(this, Data->MuzzleFX, Muzzle);
		}
	}
	if (Data->TracerFX)
	{
		if (UNiagaraComponent* Tracer = UNiagaraFunctionLibrary::SpawnSystemAtLocation(this, Data->TracerFX, Muzzle, (ImpactPoint - Muzzle).Rotation()))
		{
			Tracer->SetVariableVec3(TEXT("User.ImpactPoint"), ImpactPoint);
		}
	}
	if (bHit && Data->ImpactFX)
	{
		UNiagaraFunctionLibrary::SpawnSystemAtLocation(this, Data->ImpactFX, ImpactPoint, ImpactNormal.Rotation());
	}
}
