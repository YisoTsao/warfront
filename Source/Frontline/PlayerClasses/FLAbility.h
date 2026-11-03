#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "FLAbility.generated.h"

class AFLCharacter;

/**
 * Base class for class abilities. Abilities are replicated components created on
 * the server from the class definition at spawn. Activation is server-authoritative;
 * subclasses (C++ or Blueprint) implement ExecuteAbility.
 */
UCLASS(Abstract, Blueprintable, ClassGroup = (Frontline))
class FRONTLINE_API UFLAbility : public UActorComponent
{
	GENERATED_BODY()

public:
	UFLAbility();

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

	/** Server only. Returns true if the ability fired. */
	bool TryActivate();

	UFUNCTION(BlueprintPure, Category = "Ability")
	float GetCooldownRemaining() const;

	UFUNCTION(BlueprintPure, Category = "Ability")
	AFLCharacter* GetFLCharacter() const;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Ability")
	FText DisplayName;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Ability")
	float Cooldown = 20.f;

protected:
	UFUNCTION(BlueprintNativeEvent, Category = "Ability")
	bool CanActivateAbility() const;

	/** Runs on the server. Return false if nothing happened (no cooldown is consumed). */
	UFUNCTION(BlueprintNativeEvent, Category = "Ability")
	bool ExecuteAbility();

	float GetServerTime() const;

	UPROPERTY(Replicated, BlueprintReadOnly, Category = "Ability")
	float CooldownEndServerTime = 0.f;
};

/** Assault: instant self-heal. */
UCLASS()
class FRONTLINE_API UFLAbility_Stim : public UFLAbility
{
	GENERATED_BODY()

public:
	UFLAbility_Stim();

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float HealAmount = 50.f;

protected:
	virtual bool ExecuteAbility_Implementation() override;
};

/** Medic: heals self and teammates in a radius. */
UCLASS()
class FRONTLINE_API UFLAbility_HealPulse : public UFLAbility
{
	GENERATED_BODY()

public:
	UFLAbility_HealPulse();

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float Radius = 800.f;

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float HealAmount = 40.f;

protected:
	virtual bool ExecuteAbility_Implementation() override;
};

/** Support: refills ammo and equipment for self and teammates in a radius. */
UCLASS()
class FRONTLINE_API UFLAbility_Resupply : public UFLAbility
{
	GENERATED_BODY()

public:
	UFLAbility_Resupply();

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float Radius = 800.f;

protected:
	virtual bool ExecuteAbility_Implementation() override;
};

/** Recon: marks enemies in a cone in front of the player for the whole team. */
UCLASS()
class FRONTLINE_API UFLAbility_Spot : public UFLAbility
{
	GENERATED_BODY()

public:
	UFLAbility_Spot();

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float Range = 20000.f;

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float ConeHalfAngleDegrees = 12.f;

	UPROPERTY(EditDefaultsOnly, Category = "Ability")
	float SpotDuration = 8.f;

protected:
	virtual bool ExecuteAbility_Implementation() override;
};
