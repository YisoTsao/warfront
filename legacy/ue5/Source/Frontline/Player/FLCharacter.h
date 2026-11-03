#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "Core/FLTypes.h"
#include "FLCharacter.generated.h"

class UCameraComponent;
class USkeletalMeshComponent;
class UStaticMeshComponent;
class UMaterialInstanceDynamic;
class UFLHealthComponent;
class UFLInventoryComponent;
class UFLCharacterMovementComponent;
class UFLClassDefinition;
class UFLAbility;
class AFLWeapon;
struct FInputActionValue;

/**
 * First-person soldier. Owns movement, stance, aiming and input routing, and delegates
 * to components: health (UFLHealthComponent), weapons/equipment (UFLInventoryComponent)
 * and class abilities (UFLAbility). It contains no class-specific behavior.
 */
UCLASS()
class FRONTLINE_API AFLCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	AFLCharacter(const FObjectInitializer& ObjectInitializer);

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;
	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;
	virtual float TakeDamage(float DamageAmount, struct FDamageEvent const& DamageEvent, AController* EventInstigator, AActor* DamageCauser) override;
	virtual void Destroyed() override;
	virtual bool CanJumpInternal_Implementation() const override;
	virtual FVector GetPawnViewLocation() const override;

	// ---- Class / loadout (server) ----
	void ApplyClass(const UFLClassDefinition* ClassDef, int32 PrimaryIndex);

	const UFLClassDefinition* GetClassDefinition() const { return CachedClassDef; }

	// ---- State queries ----
	UFUNCTION(BlueprintPure, Category = "Frontline")
	bool IsAlive() const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	bool IsDowned() const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	EFLLifeState GetLifeState() const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	bool IsAiming() const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	bool IsSprinting() const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	EFLStance GetStance() const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	EFLTeam GetTeam() const;

	/** 0 = hip, 1 = fully aimed (local smoothing, for camera/HUD/animation). */
	UFUNCTION(BlueprintPure, Category = "Frontline")
	float GetAimAlpha() const { return AimAlpha; }

	static bool AreEnemies(const AActor* A, const AActor* B);

	UFLHealthComponent* GetHealthComponent() const { return HealthComponent; }
	UFLInventoryComponent* GetInventoryComponent() const { return InventoryComponent; }
	UFLCharacterMovementComponent* GetFLMovement() const;
	UCameraComponent* GetFirstPersonCamera() const { return FirstPersonCamera; }
	USkeletalMeshComponent* GetFirstPersonMesh() const { return FirstPersonMesh; }
	AFLWeapon* GetCurrentWeapon() const;
	const TArray<TObjectPtr<UFLAbility>>& GetAbilities() const { return Abilities; }

	// ---- Spotting ----
	void MarkSpotted(float Duration);

	UFUNCTION(BlueprintPure, Category = "Frontline")
	bool IsSpotted() const;

	// ---- Revive ----
	UFUNCTION(BlueprintPure, Category = "Frontline")
	float GetReviveProgress() const { return ReviveProgress; }

	// ---- Feedback ----
	UFUNCTION(Client, Unreliable)
	void ClientNotifyHitConfirmed(bool bHeadshot, bool bKilledOrDowned);

	float GetLastHitConfirmTime() const { return LastHitConfirmTime; }
	bool WasLastHitHeadshot() const { return bLastHitHeadshot; }

	/** True when the body has no skeletal mesh and the capsule is used for hit detection. */
	bool UsesCapsuleHitDetection() const { return bUseCapsuleHitDetection; }

protected:
	// ---- Input ----
	void Input_Move(const FInputActionValue& Value);
	void Input_Look(const FInputActionValue& Value);
	void Input_JumpPressed();
	void Input_JumpReleased();
	void Input_SprintPressed();
	void Input_SprintReleased();
	void Input_Crouch();
	void Input_Prone();
	void Input_FirePressed();
	void Input_FireReleased();
	void Input_AimPressed();
	void Input_AimReleased();
	void Input_Reload();
	void Input_NextWeapon();
	void Input_PrevWeapon();
	void Input_PrimaryWeapon();
	void Input_SecondaryWeapon();
	void Input_FireMode();
	void Input_Throw();
	void Input_Ability();
	void Input_InteractPressed();
	void Input_InteractReleased();
	void Input_GiveUp();

	void SetAiming(bool bAim);
	void SetSprinting(bool bSprint);

	UFUNCTION(Server, Reliable)
	void ServerActivateAbility(int32 Index);

	UFUNCTION(Server, Reliable)
	void ServerBeginInteract();

	UFUNCTION(Server, Reliable)
	void ServerEndInteract();

	UFUNCTION(Server, Reliable)
	void ServerGiveUp();

	UFUNCTION()
	void HandleLifeStateChanged(EFLLifeState NewState, EFLLifeState OldState, AController* InstigatorController);

	UFUNCTION()
	void OnRep_ClassId();

	UFUNCTION()
	void OnRep_IsProne();

	void UpdateCamera(float DeltaSeconds);
	void UpdateRevive(float DeltaSeconds);
	void UpdatePlaceholderVisuals();
	AFLCharacter* FindReviveTarget() const;
	float GetServerTime() const;

	// ---- Components ----
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<UCameraComponent> FirstPersonCamera;

	/** First-person arms, only visible to the owner. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<USkeletalMeshComponent> FirstPersonMesh;

	/** Gray-box body shown to other players until a character mesh is assigned. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<UStaticMeshComponent> PlaceholderBody;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<UFLHealthComponent> HealthComponent;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<UFLInventoryComponent> InventoryComponent;

	// ---- Tuning ----
	/** Eye height above the ground (cm) per stance. */
	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Camera")
	float StandingEyeHeight = 165.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Camera")
	float CrouchingEyeHeight = 110.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Camera")
	float ProneEyeHeight = 35.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Camera")
	float DownedEyeHeight = 45.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Camera")
	float StanceCameraSpeed = 10.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Camera")
	float DefaultFOV = 90.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Input")
	float LookSensitivity = 1.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Revive")
	float ReviveRange = 220.f;

	// ---- Replicated state ----
	UPROPERTY(ReplicatedUsing = OnRep_ClassId)
	FName ClassId;

	UPROPERTY(Transient)
	TObjectPtr<const UFLClassDefinition> CachedClassDef;

	UPROPERTY(Replicated)
	bool bReplicatedAiming = false;

	UPROPERTY(Replicated)
	bool bReplicatedSprinting = false;

	UPROPERTY(ReplicatedUsing = OnRep_IsProne)
	bool bReplicatedProne = false;

	UPROPERTY(Replicated)
	float SpottedUntilServerTime = 0.f;

	UPROPERTY(Replicated)
	TArray<TObjectPtr<UFLAbility>> Abilities;

	UPROPERTY(Replicated)
	float ReviveProgress = 0.f;

	TWeakObjectPtr<AFLCharacter> ReviveTarget;

	// ---- Local state ----
	float AimAlpha = 0.f;
	float SmoothedEyeHeight = 165.f;
	float LastHitConfirmTime = -100.f;
	bool bLastHitHeadshot = false;
	bool bUseCapsuleHitDetection = false;
	EFLTeam CachedVisualTeam = EFLTeam::None;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> PlaceholderMaterial;
};
