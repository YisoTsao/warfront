#pragma once

#include "CoreMinimal.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "FLCharacterMovementComponent.generated.h"

/**
 * Character movement with sprint, prone and aim-down-sights speed, all client-predicted
 * through the saved-move compressed flags so they are cheat-safe and correction-free.
 *
 * Prone is implemented as a second, lower crouch height: the engine's crouch handling
 * (capsule resize, encroachment checks, replication) is reused with a smaller capsule.
 */
UCLASS()
class FRONTLINE_API UFLCharacterMovementComponent : public UCharacterMovementComponent
{
	GENERATED_BODY()

	friend class FFLSavedMove;

public:
	UFLCharacterMovementComponent();

	virtual float GetMaxSpeed() const override;
	virtual float GetMaxAcceleration() const override;
	virtual void UpdateFromCompressedFlags(uint8 Flags) override;
	virtual FNetworkPredictionData_Client* GetPredictionData_Client() const override;
	virtual void UpdateCharacterStateBeforeMovement(float DeltaSeconds) override;
	virtual bool CanAttemptJump() const override;

	void SetWantsToSprint(bool bInWants) { bWantsToSprint = bInWants; }
	void SetWantsToProne(bool bInWants) { bWantsToProne = bInWants; }
	void SetWantsToAim(bool bInWants) { bWantsToAim = bInWants; }

	bool WantsToSprint() const { return bWantsToSprint; }
	bool WantsToProne() const { return bWantsToProne; }
	bool WantsToAim() const { return bWantsToAim; }

	/** True if the sprint speed is actually applied this frame (moving forward, standing, not aiming). */
	bool IsSprinting() const;
	bool IsProne() const { return bIsProne; }

	/** Called on simulated proxies when the replicated prone flag changes. */
	void ApplySimulatedProne(bool bProne);

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Movement")
	float SprintSpeed = 600.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Movement")
	float ProneSpeed = 90.f;

	/** Multiplier applied to any speed while aiming down sights. */
	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Movement")
	float AimSpeedMultiplier = 0.6f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Movement")
	float StandardCrouchHalfHeight = 60.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Movement")
	float ProneHalfHeight = 34.f;

	/** Minimum dot between acceleration and facing for sprint to apply (forward-only sprint). */
	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Movement")
	float SprintForwardDot = 0.6f;

private:
	void EnterProne();
	void ExitProne();

	uint8 bWantsToSprint : 1;
	uint8 bWantsToProne : 1;
	uint8 bWantsToAim : 1;
	uint8 bIsProne : 1;
};

class FFLSavedMove : public FSavedMove_Character
{
public:
	typedef FSavedMove_Character Super;

	virtual void Clear() override;
	virtual uint8 GetCompressedFlags() const override;
	virtual bool CanCombineWith(const FSavedMovePtr& NewMove, ACharacter* InCharacter, float MaxDelta) const override;
	virtual void SetMoveFor(ACharacter* C, float InDeltaTime, FVector const& NewAccel, FNetworkPredictionData_Client_Character& ClientData) override;
	virtual void PrepMoveFor(ACharacter* C) override;

	uint8 bSavedWantsToSprint : 1;
	uint8 bSavedWantsToProne : 1;
	uint8 bSavedWantsToAim : 1;
};

class FFLNetworkPredictionData_Client : public FNetworkPredictionData_Client_Character
{
public:
	typedef FNetworkPredictionData_Client_Character Super;

	explicit FFLNetworkPredictionData_Client(const UCharacterMovementComponent& ClientMovement)
		: Super(ClientMovement)
	{
	}

	virtual FSavedMovePtr AllocateNewMove() override;
};
