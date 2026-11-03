#include "Player/FLCharacter.h"
#include "Player/FLCharacterMovementComponent.h"
#include "Player/FLPlayerController.h"
#include "Player/FLInputConfig.h"
#include "Core/FLPlayerState.h"
#include "Core/FLGameMode.h"
#include "Combat/FLHealthComponent.h"
#include "Weapons/FLInventoryComponent.h"
#include "Weapons/FLWeapon.h"
#include "Weapons/FLWeaponData.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "PlayerClasses/FLAbility.h"
#include "Data/FLContentRegistry.h"
#include "Frontline.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "EnhancedInputComponent.h"
#include "InputAction.h"
#include "GameFramework/GameStateBase.h"
#include "InputActionValue.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Net/UnrealNetwork.h"
#include "UObject/ConstructorHelpers.h"

AFLCharacter::AFLCharacter(const FObjectInitializer& ObjectInitializer)
	: Super(ObjectInitializer.SetDefaultSubobjectClass<UFLCharacterMovementComponent>(ACharacter::CharacterMovementComponentName))
{
	PrimaryActorTick.bCanEverTick = true;
	bReplicates = true;
	SetNetUpdateFrequency(60.f);

	GetCapsuleComponent()->InitCapsuleSize(34.f, 92.f);
	// Hitscan weapons hit the skeletal mesh (physics asset), not the capsule.
	GetCapsuleComponent()->SetCollisionResponseToChannel(ECC_FLWeapon, ECR_Ignore);

	bUseControllerRotationYaw = true;
	bUseControllerRotationPitch = false;
	bUseControllerRotationRoll = false;

	FirstPersonCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("FirstPersonCamera"));
	FirstPersonCamera->SetupAttachment(GetCapsuleComponent());
	FirstPersonCamera->SetRelativeLocation(FVector(0.f, 0.f, StandingEyeHeight - 92.f));
	FirstPersonCamera->bUsePawnControlRotation = true;
	FirstPersonCamera->SetFieldOfView(DefaultFOV);

	FirstPersonMesh = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("FirstPersonMesh"));
	FirstPersonMesh->SetupAttachment(FirstPersonCamera);
	FirstPersonMesh->SetOnlyOwnerSee(true);
	FirstPersonMesh->bCastDynamicShadow = false;
	FirstPersonMesh->CastShadow = false;
	FirstPersonMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	USkeletalMeshComponent* BodyMesh = GetMesh();
	BodyMesh->SetOwnerNoSee(true);
	BodyMesh->SetRelativeLocation(FVector(0.f, 0.f, -92.f));
	BodyMesh->SetRelativeRotation(FRotator(0.f, -90.f, 0.f));
	BodyMesh->SetCollisionProfileName(TEXT("CharacterMesh"));
	BodyMesh->SetCollisionResponseToChannel(ECC_FLWeapon, ECR_Block);
	BodyMesh->SetCollisionEnabled(ECollisionEnabled::QueryOnly);
	BodyMesh->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::OnlyTickPoseWhenRendered;

	PlaceholderBody = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("PlaceholderBody"));
	PlaceholderBody->SetupAttachment(GetCapsuleComponent());
	PlaceholderBody->SetOwnerNoSee(true);
	PlaceholderBody->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderMesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	if (CylinderMesh.Succeeded())
	{
		PlaceholderBody->SetStaticMesh(CylinderMesh.Object);
	}

	HealthComponent = CreateDefaultSubobject<UFLHealthComponent>(TEXT("Health"));
	InventoryComponent = CreateDefaultSubobject<UFLInventoryComponent>(TEXT("Inventory"));
}

void AFLCharacter::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(AFLCharacter, ClassId);
	DOREPLIFETIME_CONDITION(AFLCharacter, bReplicatedAiming, COND_SkipOwner);
	DOREPLIFETIME_CONDITION(AFLCharacter, bReplicatedSprinting, COND_SkipOwner);
	DOREPLIFETIME_CONDITION(AFLCharacter, bReplicatedProne, COND_SkipOwner);
	DOREPLIFETIME(AFLCharacter, SpottedUntilServerTime);
	DOREPLIFETIME_CONDITION(AFLCharacter, Abilities, COND_OwnerOnly);
	DOREPLIFETIME_CONDITION(AFLCharacter, ReviveProgress, COND_OwnerOnly);
}

void AFLCharacter::BeginPlay()
{
	Super::BeginPlay();

	HealthComponent->OnLifeStateChanged.AddDynamic(this, &AFLCharacter::HandleLifeStateChanged);

	// Gray-box fallback: with no skeletal mesh there is no physics asset to hit,
	// so let the capsule take bullets and show a placeholder body.
	bUseCapsuleHitDetection = GetMesh()->GetSkeletalMeshAsset() == nullptr;
	GetCapsuleComponent()->SetCollisionResponseToChannel(ECC_FLWeapon, bUseCapsuleHitDetection ? ECR_Block : ECR_Ignore);
	PlaceholderBody->SetVisibility(bUseCapsuleHitDetection);
	if (bUseCapsuleHitDetection && PlaceholderBody->GetStaticMesh())
	{
		PlaceholderMaterial = PlaceholderBody->CreateDynamicMaterialInstance(0);
	}

	SmoothedEyeHeight = StandingEyeHeight;
}

UFLCharacterMovementComponent* AFLCharacter::GetFLMovement() const
{
	return Cast<UFLCharacterMovementComponent>(GetCharacterMovement());
}

AFLWeapon* AFLCharacter::GetCurrentWeapon() const
{
	return InventoryComponent ? InventoryComponent->GetCurrentWeapon() : nullptr;
}

float AFLCharacter::GetServerTime() const
{
	const UWorld* World = GetWorld();
	const AGameStateBase* GS = World ? World->GetGameState() : nullptr;
	return GS ? GS->GetServerWorldTimeSeconds() : (World ? World->GetTimeSeconds() : 0.f);
}

// ---------------------------------------------------------------------------
// Class & loadout

void AFLCharacter::ApplyClass(const UFLClassDefinition* ClassDef, int32 PrimaryIndex)
{
	if (!HasAuthority() || !ClassDef)
	{
		return;
	}

	ClassId = ClassDef->GetClassId();
	CachedClassDef = ClassDef;

	HealthComponent->InitializeHealth(ClassDef->MaxHealth);
	InventoryComponent->GiveLoadout(ClassDef, PrimaryIndex);

	for (UFLAbility* Ability : Abilities)
	{
		if (Ability)
		{
			Ability->DestroyComponent();
		}
	}
	Abilities.Reset();

	for (const TSubclassOf<UFLAbility>& AbilityClass : ClassDef->Abilities)
	{
		if (!AbilityClass)
		{
			continue;
		}
		UFLAbility* Ability = NewObject<UFLAbility>(this, AbilityClass);
		Ability->SetIsReplicated(true);
		Ability->RegisterComponent();
		Abilities.Add(Ability);
	}
}

void AFLCharacter::OnRep_ClassId()
{
	if (const UFLContentRegistry* Registry = UFLContentRegistry::Get(this))
	{
		CachedClassDef = Registry->FindClass(ClassId);
	}
}

// ---------------------------------------------------------------------------
// State queries

bool AFLCharacter::IsAlive() const
{
	return HealthComponent && HealthComponent->GetLifeState() == EFLLifeState::Alive;
}

bool AFLCharacter::IsDowned() const
{
	return HealthComponent && HealthComponent->GetLifeState() == EFLLifeState::Downed;
}

EFLLifeState AFLCharacter::GetLifeState() const
{
	return HealthComponent ? HealthComponent->GetLifeState() : EFLLifeState::Dead;
}

bool AFLCharacter::IsAiming() const
{
	if (GetLocalRole() == ROLE_SimulatedProxy)
	{
		return bReplicatedAiming;
	}
	const UFLCharacterMovementComponent* Move = GetFLMovement();
	return Move && Move->WantsToAim();
}

bool AFLCharacter::IsSprinting() const
{
	if (GetLocalRole() == ROLE_SimulatedProxy)
	{
		return bReplicatedSprinting;
	}
	const UFLCharacterMovementComponent* Move = GetFLMovement();
	return Move && Move->IsSprinting();
}

EFLStance AFLCharacter::GetStance() const
{
	const UFLCharacterMovementComponent* Move = GetFLMovement();
	const bool bProne = GetLocalRole() == ROLE_SimulatedProxy ? bReplicatedProne : (Move && Move->IsProne());
	if (bProne)
	{
		return EFLStance::Prone;
	}
	return bIsCrouched ? EFLStance::Crouching : EFLStance::Standing;
}

EFLTeam AFLCharacter::GetTeam() const
{
	const AFLPlayerState* PS = GetPlayerState<AFLPlayerState>();
	return PS ? PS->GetTeam() : EFLTeam::None;
}

bool AFLCharacter::AreEnemies(const AActor* A, const AActor* B)
{
	const AFLCharacter* CA = Cast<AFLCharacter>(A);
	const AFLCharacter* CB = Cast<AFLCharacter>(B);
	if (!CA || !CB || CA == CB)
	{
		return false;
	}
	const EFLTeam TA = CA->GetTeam();
	const EFLTeam TB = CB->GetTeam();
	return TA == EFLTeam::None || TB == EFLTeam::None || TA != TB;
}

void AFLCharacter::MarkSpotted(float Duration)
{
	if (HasAuthority())
	{
		SpottedUntilServerTime = FMath::Max(SpottedUntilServerTime, GetServerTime() + Duration);
	}
}

bool AFLCharacter::IsSpotted() const
{
	return GetServerTime() < SpottedUntilServerTime;
}

FVector AFLCharacter::GetPawnViewLocation() const
{
	return FirstPersonCamera ? FirstPersonCamera->GetComponentLocation() : Super::GetPawnViewLocation();
}

bool AFLCharacter::CanJumpInternal_Implementation() const
{
	return IsAlive() && Super::CanJumpInternal_Implementation();
}

// ---------------------------------------------------------------------------
// Tick

void AFLCharacter::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (HasAuthority())
	{
		if (const UFLCharacterMovementComponent* Move = GetFLMovement())
		{
			bReplicatedAiming = Move->WantsToAim();
			bReplicatedSprinting = Move->IsSprinting();
			bReplicatedProne = Move->IsProne();
		}
		UpdateRevive(DeltaSeconds);
	}

	if (GetNetMode() != NM_DedicatedServer)
	{
		UpdateCamera(DeltaSeconds);
		UpdatePlaceholderVisuals();
	}
}

void AFLCharacter::UpdateCamera(float DeltaSeconds)
{
	// Eye height is tracked relative to the ground so stance changes blend smoothly
	// even though the capsule resizes instantly.
	float TargetEye = StandingEyeHeight;
	switch (GetLifeState())
	{
	case EFLLifeState::Downed:
		TargetEye = DownedEyeHeight;
		break;
	case EFLLifeState::Dead:
		TargetEye = DownedEyeHeight * 0.5f;
		break;
	default:
		switch (GetStance())
		{
		case EFLStance::Crouching: TargetEye = CrouchingEyeHeight; break;
		case EFLStance::Prone: TargetEye = ProneEyeHeight; break;
		default: break;
		}
	}

	SmoothedEyeHeight = FMath::FInterpTo(SmoothedEyeHeight, TargetEye, DeltaSeconds, StanceCameraSpeed);
	const float HalfHeight = GetCapsuleComponent()->GetUnscaledCapsuleHalfHeight();
	FirstPersonCamera->SetRelativeLocation(FVector(0.f, 0.f, SmoothedEyeHeight - HalfHeight));

	// Aim-down-sights blend.
	const AFLWeapon* Weapon = GetCurrentWeapon();
	const UFLWeaponData* Data = Weapon ? Weapon->GetWeaponData() : nullptr;
	const float AdsTime = Data ? FMath::Max(0.05f, Data->AimDownSightTime) : 0.25f;
	const float TargetAlpha = (IsAiming() && IsAlive()) ? 1.f : 0.f;
	AimAlpha = FMath::FInterpConstantTo(AimAlpha, TargetAlpha, DeltaSeconds, 1.f / AdsTime);

	const float AimFOV = Data ? Data->AimFOV : 60.f;
	FirstPersonCamera->SetFieldOfView(FMath::Lerp(DefaultFOV, AimFOV, FMath::SmoothStep(0.f, 1.f, AimAlpha)));
}

void AFLCharacter::UpdatePlaceholderVisuals()
{
	if (!bUseCapsuleHitDetection)
	{
		return;
	}

	const float HalfHeight = GetCapsuleComponent()->GetUnscaledCapsuleHalfHeight();
	const float Radius = GetCapsuleComponent()->GetUnscaledCapsuleRadius();
	PlaceholderBody->SetRelativeScale3D(FVector(Radius * 2.f / 100.f, Radius * 2.f / 100.f, HalfHeight * 2.f / 100.f));
	PlaceholderBody->SetRelativeRotation(GetLifeState() == EFLLifeState::Alive ? FRotator::ZeroRotator : FRotator(90.f, 0.f, 0.f));

	const EFLTeam Team = GetTeam();
	if (PlaceholderMaterial && Team != CachedVisualTeam)
	{
		CachedVisualTeam = Team;
		PlaceholderMaterial->SetVectorParameterValue(TEXT("Color"), FLTeam::GetColor(Team));
	}
}

// ---------------------------------------------------------------------------
// Damage & life state

float AFLCharacter::TakeDamage(float DamageAmount, FDamageEvent const& DamageEvent, AController* EventInstigator, AActor* DamageCauser)
{
	if (!HasAuthority() || GetLifeState() == EFLLifeState::Dead)
	{
		return 0.f;
	}

	if (const AFLGameMode* GameMode = GetWorld()->GetAuthGameMode<AFLGameMode>())
	{
		DamageAmount = GameMode->ModifyDamage(DamageAmount, this, EventInstigator);
	}
	if (DamageAmount <= 0.f)
	{
		return 0.f;
	}

	const float Applied = Super::TakeDamage(DamageAmount, DamageEvent, EventInstigator, DamageCauser);
	if (Applied > 0.f)
	{
		HealthComponent->ApplyDamage(Applied, EventInstigator, DamageCauser, true);
	}
	return Applied;
}

void AFLCharacter::HandleLifeStateChanged(EFLLifeState NewState, EFLLifeState OldState, AController* InstigatorController)
{
	if (NewState != EFLLifeState::Alive)
	{
		if (AFLWeapon* Weapon = GetCurrentWeapon())
		{
			Weapon->StopFire();
		}
		if (UFLCharacterMovementComponent* Move = GetFLMovement())
		{
			Move->SetWantsToSprint(false);
			Move->SetWantsToAim(false);
		}
		ReviveTarget = nullptr;
		ReviveProgress = 0.f;
	}

	AFLGameMode* GameMode = HasAuthority() ? GetWorld()->GetAuthGameMode<AFLGameMode>() : nullptr;

	switch (NewState)
	{
	case EFLLifeState::Downed:
		if (GameMode)
		{
			GameMode->OnCharacterDowned(this, InstigatorController);
		}
		break;

	case EFLLifeState::Dead:
		GetCharacterMovement()->DisableMovement();
		GetCapsuleComponent()->SetCollisionResponseToChannel(ECC_Pawn, ECR_Ignore);
		GetCapsuleComponent()->SetCollisionResponseToChannel(ECC_FLWeapon, ECR_Ignore);
		if (GetMesh()->GetSkeletalMeshAsset() && GetMesh()->GetPhysicsAsset())
		{
			GetMesh()->SetCollisionProfileName(TEXT("Ragdoll"));
			GetMesh()->SetSimulatePhysics(true);
		}
		FirstPersonMesh->SetHiddenInGame(true, true);
		if (HasAuthority())
		{
			InventoryComponent->ClearLoadout();
			if (GameMode)
			{
				GameMode->OnCharacterKilled(this, InstigatorController);
			}
		}
		break;

	case EFLLifeState::Alive:
		if (OldState == EFLLifeState::Downed && GameMode)
		{
			GameMode->OnCharacterRevived(this, InstigatorController);
		}
		break;
	}
}

// ---------------------------------------------------------------------------
// Revive

AFLCharacter* AFLCharacter::FindReviveTarget() const
{
	FVector ViewLoc;
	FRotator ViewRot;
	GetActorEyesViewPoint(ViewLoc, ViewRot);
	const FVector Forward = ViewRot.Vector();

	AFLCharacter* Best = nullptr;
	float BestScore = -1.f;
	for (TActorIterator<AFLCharacter> It(GetWorld()); It; ++It)
	{
		AFLCharacter* Other = *It;
		if (!Other || Other == this || !Other->IsDowned() || AreEnemies(this, Other))
		{
			continue;
		}
		const FVector ToOther = Other->GetActorLocation() - GetActorLocation();
		if (ToOther.SizeSquared() > FMath::Square(ReviveRange))
		{
			continue;
		}
		const float Score = FVector::DotProduct(ToOther.GetSafeNormal2D(), Forward.GetSafeNormal2D());
		if (Score > BestScore)
		{
			BestScore = Score;
			Best = Other;
		}
	}
	return Best;
}

void AFLCharacter::UpdateRevive(float DeltaSeconds)
{
	AFLCharacter* Target = ReviveTarget.Get();
	if (!Target)
	{
		return;
	}

	const bool bValid = IsAlive() && Target->IsDowned()
		&& FVector::DistSquared(Target->GetActorLocation(), GetActorLocation()) <= FMath::Square(ReviveRange * 1.25f);
	if (!bValid)
	{
		ReviveTarget = nullptr;
		ReviveProgress = 0.f;
		return;
	}

	const float ReviveTime = CachedClassDef ? CachedClassDef->ReviveTime : 5.f;
	ReviveProgress += DeltaSeconds / FMath::Max(0.1f, ReviveTime);
	if (ReviveProgress >= 1.f)
	{
		const float Fraction = CachedClassDef ? CachedClassDef->ReviveHealthFraction : 0.3f;
		Target->GetHealthComponent()->Revive(Fraction, GetController());
		ReviveTarget = nullptr;
		ReviveProgress = 0.f;
	}
}

void AFLCharacter::ServerBeginInteract_Implementation()
{
	if (IsAlive())
	{
		ReviveTarget = FindReviveTarget();
		ReviveProgress = 0.f;
	}
}

void AFLCharacter::ServerEndInteract_Implementation()
{
	ReviveTarget = nullptr;
	ReviveProgress = 0.f;
}

void AFLCharacter::ServerGiveUp_Implementation()
{
	if (IsDowned())
	{
		HealthComponent->Kill(nullptr);
	}
}

void AFLCharacter::ServerActivateAbility_Implementation(int32 Index)
{
	if (Abilities.IsValidIndex(Index) && Abilities[Index])
	{
		Abilities[Index]->TryActivate();
	}
}

// ---------------------------------------------------------------------------
// Feedback

void AFLCharacter::ClientNotifyHitConfirmed_Implementation(bool bHeadshot, bool bKilledOrDowned)
{
	LastHitConfirmTime = GetWorld()->GetTimeSeconds();
	bLastHitHeadshot = bHeadshot;
}

void AFLCharacter::OnRep_IsProne()
{
	if (UFLCharacterMovementComponent* Move = GetFLMovement())
	{
		Move->ApplySimulatedProne(bReplicatedProne);
	}
}

void AFLCharacter::Destroyed()
{
	if (HasAuthority() && InventoryComponent)
	{
		InventoryComponent->ClearLoadout();
	}
	Super::Destroyed();
}

// ---------------------------------------------------------------------------
// Input

void AFLCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	AFLPlayerController* PC = Cast<AFLPlayerController>(GetController());
	const UFLInputConfig* Config = PC ? PC->GetInputConfig() : nullptr;
	if (!Input || !Config)
	{
		UE_LOG(LogFrontline, Warning, TEXT("AFLCharacter: Enhanced Input or input config missing; input not bound."));
		return;
	}

	auto Bind = [Input, this](const UInputAction* Action, ETriggerEvent Event, void (AFLCharacter::*Func)())
	{
		if (Action)
		{
			Input->BindAction(Action, Event, this, Func);
		}
	};

	if (Config->Move) { Input->BindAction(Config->Move, ETriggerEvent::Triggered, this, &AFLCharacter::Input_Move); }
	if (Config->Look) { Input->BindAction(Config->Look, ETriggerEvent::Triggered, this, &AFLCharacter::Input_Look); }

	Bind(Config->Jump, ETriggerEvent::Started, &AFLCharacter::Input_JumpPressed);
	Bind(Config->Jump, ETriggerEvent::Completed, &AFLCharacter::Input_JumpReleased);
	Bind(Config->Sprint, ETriggerEvent::Started, &AFLCharacter::Input_SprintPressed);
	Bind(Config->Sprint, ETriggerEvent::Completed, &AFLCharacter::Input_SprintReleased);
	Bind(Config->Crouch, ETriggerEvent::Started, &AFLCharacter::Input_Crouch);
	Bind(Config->Prone, ETriggerEvent::Started, &AFLCharacter::Input_Prone);
	Bind(Config->Fire, ETriggerEvent::Started, &AFLCharacter::Input_FirePressed);
	Bind(Config->Fire, ETriggerEvent::Completed, &AFLCharacter::Input_FireReleased);
	Bind(Config->Aim, ETriggerEvent::Started, &AFLCharacter::Input_AimPressed);
	Bind(Config->Aim, ETriggerEvent::Completed, &AFLCharacter::Input_AimReleased);
	Bind(Config->Reload, ETriggerEvent::Started, &AFLCharacter::Input_Reload);
	Bind(Config->NextWeapon, ETriggerEvent::Started, &AFLCharacter::Input_NextWeapon);
	Bind(Config->PrevWeapon, ETriggerEvent::Started, &AFLCharacter::Input_PrevWeapon);
	Bind(Config->PrimaryWeapon, ETriggerEvent::Started, &AFLCharacter::Input_PrimaryWeapon);
	Bind(Config->SecondaryWeapon, ETriggerEvent::Started, &AFLCharacter::Input_SecondaryWeapon);
	Bind(Config->FireMode, ETriggerEvent::Started, &AFLCharacter::Input_FireMode);
	Bind(Config->Throw, ETriggerEvent::Started, &AFLCharacter::Input_Throw);
	Bind(Config->Ability, ETriggerEvent::Started, &AFLCharacter::Input_Ability);
	Bind(Config->Interact, ETriggerEvent::Started, &AFLCharacter::Input_InteractPressed);
	Bind(Config->Interact, ETriggerEvent::Completed, &AFLCharacter::Input_InteractReleased);
	Bind(Config->GiveUp, ETriggerEvent::Triggered, &AFLCharacter::Input_GiveUp);
}

void AFLCharacter::Input_Move(const FInputActionValue& Value)
{
	if (!IsAlive())
	{
		return;
	}
	const FVector2D Axis = Value.Get<FVector2D>();
	AddMovementInput(GetActorForwardVector(), Axis.Y);
	AddMovementInput(GetActorRightVector(), Axis.X);
}

void AFLCharacter::Input_Look(const FInputActionValue& Value)
{
	if (GetLifeState() == EFLLifeState::Dead)
	{
		return;
	}
	// Scale sensitivity with zoom so aiming feels consistent at any FOV.
	const float ZoomScale = FirstPersonCamera->FieldOfView / DefaultFOV;
	const FVector2D Axis = Value.Get<FVector2D>() * LookSensitivity * ZoomScale;
	AddControllerYawInput(Axis.X);
	AddControllerPitchInput(Axis.Y);
}

void AFLCharacter::Input_JumpPressed()
{
	if (!IsAlive())
	{
		return;
	}
	UFLCharacterMovementComponent* Move = GetFLMovement();
	if (Move && Move->IsProne())
	{
		// Prone -> crouch
		Move->SetWantsToProne(false);
		Crouch();
	}
	else if (bIsCrouched)
	{
		UnCrouch();
	}
	else
	{
		Jump();
	}
}

void AFLCharacter::Input_JumpReleased()
{
	StopJumping();
}

void AFLCharacter::SetSprinting(bool bSprint)
{
	if (UFLCharacterMovementComponent* Move = GetFLMovement())
	{
		if (bSprint)
		{
			Move->SetWantsToProne(false);
			UnCrouch();
			SetAiming(false);
			if (AFLWeapon* Weapon = GetCurrentWeapon())
			{
				Weapon->StopFire();
			}
		}
		Move->SetWantsToSprint(bSprint);
	}
}

void AFLCharacter::Input_SprintPressed()
{
	if (IsAlive())
	{
		SetSprinting(true);
	}
}

void AFLCharacter::Input_SprintReleased()
{
	SetSprinting(false);
}

void AFLCharacter::Input_Crouch()
{
	if (!IsAlive())
	{
		return;
	}
	UFLCharacterMovementComponent* Move = GetFLMovement();
	if (Move && Move->WantsToProne())
	{
		Move->SetWantsToProne(false);
		Crouch();
	}
	else if (bIsCrouched)
	{
		UnCrouch();
	}
	else
	{
		SetSprinting(false);
		Crouch();
	}
}

void AFLCharacter::Input_Prone()
{
	if (!IsAlive())
	{
		return;
	}
	UFLCharacterMovementComponent* Move = GetFLMovement();
	if (!Move)
	{
		return;
	}
	if (Move->WantsToProne())
	{
		Move->SetWantsToProne(false);
		UnCrouch();
	}
	else
	{
		SetSprinting(false);
		Move->SetWantsToProne(true);
	}
}

void AFLCharacter::SetAiming(bool bAim)
{
	if (UFLCharacterMovementComponent* Move = GetFLMovement())
	{
		const bool bCanAim = bAim && IsAlive() && GetCurrentWeapon() != nullptr;
		if (bCanAim)
		{
			Move->SetWantsToSprint(false);
		}
		Move->SetWantsToAim(bCanAim);
	}
}

void AFLCharacter::Input_FirePressed()
{
	if (!IsAlive())
	{
		return;
	}
	if (AFLWeapon* Weapon = GetCurrentWeapon())
	{
		if (UFLCharacterMovementComponent* Move = GetFLMovement())
		{
			Move->SetWantsToSprint(false);
		}
		Weapon->StartFire();
	}
}

void AFLCharacter::Input_FireReleased()
{
	if (AFLWeapon* Weapon = GetCurrentWeapon())
	{
		Weapon->StopFire();
	}
}

void AFLCharacter::Input_AimPressed()
{
	SetAiming(true);
}

void AFLCharacter::Input_AimReleased()
{
	SetAiming(false);
}

void AFLCharacter::Input_Reload()
{
	if (AFLWeapon* Weapon = GetCurrentWeapon(); Weapon && IsAlive())
	{
		Weapon->StartReload();
	}
}

void AFLCharacter::Input_NextWeapon()
{
	if (IsAlive())
	{
		InventoryComponent->CycleWeapon(1);
	}
}

void AFLCharacter::Input_PrevWeapon()
{
	if (IsAlive())
	{
		InventoryComponent->CycleWeapon(-1);
	}
}

void AFLCharacter::Input_PrimaryWeapon()
{
	if (IsAlive())
	{
		InventoryComponent->EquipWeaponAt(0);
	}
}

void AFLCharacter::Input_SecondaryWeapon()
{
	if (IsAlive())
	{
		InventoryComponent->EquipWeaponAt(1);
	}
}

void AFLCharacter::Input_FireMode()
{
	if (AFLWeapon* Weapon = GetCurrentWeapon(); Weapon && IsAlive())
	{
		Weapon->CycleFireMode();
	}
}

void AFLCharacter::Input_Throw()
{
	if (IsAlive())
	{
		InventoryComponent->ThrowEquipment(0);
	}
}

void AFLCharacter::Input_Ability()
{
	if (IsAlive())
	{
		ServerActivateAbility(0);
	}
}

void AFLCharacter::Input_InteractPressed()
{
	if (IsAlive())
	{
		ServerBeginInteract();
	}
}

void AFLCharacter::Input_InteractReleased()
{
	ServerEndInteract();
}

void AFLCharacter::Input_GiveUp()
{
	if (IsDowned())
	{
		ServerGiveUp();
	}
}
