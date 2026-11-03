#include "Player/FLCharacterMovementComponent.h"
#include "Player/FLCharacter.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "Components/CapsuleComponent.h"
#include "GameFramework/Character.h"

namespace
{
	constexpr uint8 FLAG_Sprint = FSavedMove_Character::FLAG_Custom_0;
	constexpr uint8 FLAG_Prone = FSavedMove_Character::FLAG_Custom_1;
	constexpr uint8 FLAG_Aim = FSavedMove_Character::FLAG_Custom_2;
}

UFLCharacterMovementComponent::UFLCharacterMovementComponent()
{
	bWantsToSprint = false;
	bWantsToProne = false;
	bWantsToAim = false;
	bIsProne = false;

	// Realistic infantry speeds (cm/s): ~3.6 m/s walk, ~6 m/s sprint.
	MaxWalkSpeed = 360.f;
	MaxWalkSpeedCrouched = 200.f;
	MaxAcceleration = 1800.f;
	BrakingDecelerationWalking = 1800.f;
	GroundFriction = 8.f;
	JumpZVelocity = 380.f;
	AirControl = 0.15f;
	bCanWalkOffLedgesWhenCrouching = true;
	SetCrouchedHalfHeight(StandardCrouchHalfHeight);
	GetNavAgentPropertiesRef().bCanCrouch = true;
	GetNavAgentPropertiesRef().bCanJump = true;
}

bool UFLCharacterMovementComponent::IsSprinting() const
{
	if (!bWantsToSprint || bWantsToAim || IsCrouching() || !IsMovingOnGround() || !CharacterOwner)
	{
		return false;
	}
	const FVector Accel2D = FVector(Acceleration.X, Acceleration.Y, 0.f);
	if (Accel2D.IsNearlyZero())
	{
		return false;
	}
	return FVector::DotProduct(Accel2D.GetSafeNormal(), CharacterOwner->GetActorForwardVector()) >= SprintForwardDot;
}

float UFLCharacterMovementComponent::GetMaxSpeed() const
{
	const AFLCharacter* FLChar = Cast<AFLCharacter>(CharacterOwner);
	if (FLChar && !FLChar->IsAlive())
	{
		return 0.f;
	}

	if (MovementMode != MOVE_Walking && MovementMode != MOVE_NavWalking)
	{
		return Super::GetMaxSpeed();
	}

	float Speed = MaxWalkSpeed;
	if (bIsProne)
	{
		Speed = ProneSpeed;
	}
	else if (IsCrouching())
	{
		Speed = MaxWalkSpeedCrouched;
	}
	else if (IsSprinting())
	{
		const UFLClassDefinition* ClassDef = FLChar ? FLChar->GetClassDefinition() : nullptr;
		Speed = SprintSpeed * (ClassDef ? ClassDef->SprintSpeedMultiplier : 1.f);
	}

	if (bWantsToAim)
	{
		Speed *= AimSpeedMultiplier;
	}
	return Speed;
}

float UFLCharacterMovementComponent::GetMaxAcceleration() const
{
	return bIsProne ? MaxAcceleration * 0.5f : Super::GetMaxAcceleration();
}

bool UFLCharacterMovementComponent::CanAttemptJump() const
{
	return !bIsProne && Super::CanAttemptJump();
}

void UFLCharacterMovementComponent::UpdateFromCompressedFlags(uint8 Flags)
{
	Super::UpdateFromCompressedFlags(Flags);
	bWantsToSprint = (Flags & FLAG_Sprint) != 0;
	bWantsToProne = (Flags & FLAG_Prone) != 0;
	bWantsToAim = (Flags & FLAG_Aim) != 0;
}

void UFLCharacterMovementComponent::UpdateCharacterStateBeforeMovement(float DeltaSeconds)
{
	if (CharacterOwner && CharacterOwner->GetLocalRole() != ROLE_SimulatedProxy)
	{
		const AFLCharacter* FLChar = Cast<AFLCharacter>(CharacterOwner);
		const bool bAlive = !FLChar || FLChar->IsAlive();

		if (bWantsToProne && bAlive && !bIsProne && CanCrouchInCurrentState() && IsMovingOnGround())
		{
			EnterProne();
		}
		else if ((!bWantsToProne || !bAlive) && bIsProne)
		{
			ExitProne();
		}
	}

	Super::UpdateCharacterStateBeforeMovement(DeltaSeconds);
}

void UFLCharacterMovementComponent::EnterProne()
{
	// The engine's Crouch() assumes it starts from standing height, so stand up first.
	if (IsCrouching())
	{
		UnCrouch(false);
		if (IsCrouching())
		{
			return; // Blocked; stay crouched.
		}
	}

	SetCrouchedHalfHeight(ProneHalfHeight);
	bWantsToCrouch = true;
	Crouch(false);

	if (IsCrouching())
	{
		bIsProne = true;
	}
	else
	{
		SetCrouchedHalfHeight(StandardCrouchHalfHeight);
	}
}

void UFLCharacterMovementComponent::ExitProne()
{
	UnCrouch(false);
	if (IsCrouching())
	{
		return; // Not enough room to get up; stay prone.
	}
	bIsProne = false;
	SetCrouchedHalfHeight(StandardCrouchHalfHeight);
	// If the player asked for crouch (bWantsToCrouch), the base class re-crouches this frame.
}

void UFLCharacterMovementComponent::ApplySimulatedProne(bool bProne)
{
	bIsProne = bProne;
	SetCrouchedHalfHeight(bProne ? ProneHalfHeight : StandardCrouchHalfHeight);
	if (CharacterOwner && CharacterOwner->bIsCrouched)
	{
		// Re-apply the crouch so the capsule matches the new height.
		UnCrouch(true);
		Crouch(true);
	}
}

FNetworkPredictionData_Client* UFLCharacterMovementComponent::GetPredictionData_Client() const
{
	if (ClientPredictionData == nullptr)
	{
		UFLCharacterMovementComponent* MutableThis = const_cast<UFLCharacterMovementComponent*>(this);
		MutableThis->ClientPredictionData = new FFLNetworkPredictionData_Client(*this);
	}
	return ClientPredictionData;
}

// ---------------------------------------------------------------------------

void FFLSavedMove::Clear()
{
	Super::Clear();
	bSavedWantsToSprint = false;
	bSavedWantsToProne = false;
	bSavedWantsToAim = false;
}

uint8 FFLSavedMove::GetCompressedFlags() const
{
	uint8 Result = Super::GetCompressedFlags();
	if (bSavedWantsToSprint) { Result |= FLAG_Sprint; }
	if (bSavedWantsToProne) { Result |= FLAG_Prone; }
	if (bSavedWantsToAim) { Result |= FLAG_Aim; }
	return Result;
}

bool FFLSavedMove::CanCombineWith(const FSavedMovePtr& NewMove, ACharacter* InCharacter, float MaxDelta) const
{
	const FFLSavedMove* Other = static_cast<const FFLSavedMove*>(NewMove.Get());
	if (bSavedWantsToSprint != Other->bSavedWantsToSprint
		|| bSavedWantsToProne != Other->bSavedWantsToProne
		|| bSavedWantsToAim != Other->bSavedWantsToAim)
	{
		return false;
	}
	return Super::CanCombineWith(NewMove, InCharacter, MaxDelta);
}

void FFLSavedMove::SetMoveFor(ACharacter* C, float InDeltaTime, FVector const& NewAccel, FNetworkPredictionData_Client_Character& ClientData)
{
	Super::SetMoveFor(C, InDeltaTime, NewAccel, ClientData);
	if (const UFLCharacterMovementComponent* Move = Cast<UFLCharacterMovementComponent>(C->GetCharacterMovement()))
	{
		bSavedWantsToSprint = Move->bWantsToSprint;
		bSavedWantsToProne = Move->bWantsToProne;
		bSavedWantsToAim = Move->bWantsToAim;
	}
}

void FFLSavedMove::PrepMoveFor(ACharacter* C)
{
	Super::PrepMoveFor(C);
	if (UFLCharacterMovementComponent* Move = Cast<UFLCharacterMovementComponent>(C->GetCharacterMovement()))
	{
		Move->bWantsToSprint = bSavedWantsToSprint;
		Move->bWantsToProne = bSavedWantsToProne;
		Move->bWantsToAim = bSavedWantsToAim;
	}
}

FSavedMovePtr FFLNetworkPredictionData_Client::AllocateNewMove()
{
	return FSavedMovePtr(new FFLSavedMove());
}
