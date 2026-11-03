#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Core/FLTypes.h"
#include "FLHealthComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FFLHealthChangedSignature, float, NewHealth, float, Delta);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FFLLifeStateChangedSignature, EFLLifeState, NewState, EFLLifeState, OldState, AController*, Instigator);

/**
 * Server-authoritative health, downed and death states.
 *
 * Alive --(health reaches 0)--> Downed --(bleed-out / further damage / give up)--> Dead
 * Downed --(revive)--> Alive
 */
UCLASS(ClassGroup = (Frontline), meta = (BlueprintSpawnableComponent))
class FRONTLINE_API UFLHealthComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UFLHealthComponent();

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;
	virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

	// ---- Server API ----
	void InitializeHealth(float InMaxHealth);
	void ApplyDamage(float Amount, AController* Instigator, AActor* DamageCauser, bool bAllowDowned = true);
	void Heal(float Amount);
	void Revive(float HealthFraction, AController* Reviver);
	void Kill(AController* Instigator);

	// ---- Queries ----
	UFUNCTION(BlueprintPure, Category = "Health")
	float GetHealth() const { return Health; }

	UFUNCTION(BlueprintPure, Category = "Health")
	float GetMaxHealth() const { return MaxHealth; }

	UFUNCTION(BlueprintPure, Category = "Health")
	EFLLifeState GetLifeState() const { return LifeState; }

	UFUNCTION(BlueprintPure, Category = "Health")
	float GetBleedoutRemaining() const;

	UPROPERTY(BlueprintAssignable, Category = "Health")
	FFLHealthChangedSignature OnHealthChanged;

	/** Fires on server and clients. Instigator is only valid on the server. */
	UPROPERTY(BlueprintAssignable, Category = "Health")
	FFLLifeStateChangedSignature OnLifeStateChanged;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Health")
	bool bCanBeDowned = true;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Health")
	float BleedoutTime = 30.f;

	/** Seconds without damage before regeneration starts. */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Health")
	float RegenDelay = 7.f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Health")
	float RegenPerSecond = 8.f;

	/** Regeneration stops at this fraction of max health. */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Health", meta = (ClampMin = 0, ClampMax = 1))
	float RegenCapFraction = 1.f;

protected:
	void SetLifeState(EFLLifeState NewState, AController* Instigator);
	float GetServerTime() const;

	UFUNCTION()
	void OnRep_Health(float OldHealth);

	UFUNCTION()
	void OnRep_LifeState(EFLLifeState OldState);

	UPROPERTY(ReplicatedUsing = OnRep_Health)
	float Health = 100.f;

	UPROPERTY(Replicated)
	float MaxHealth = 100.f;

	UPROPERTY(ReplicatedUsing = OnRep_LifeState)
	EFLLifeState LifeState = EFLLifeState::Alive;

	UPROPERTY(Replicated)
	float BleedoutEndServerTime = 0.f;

	float LastDamageTime = -1000.f;

	TWeakObjectPtr<AController> LastInstigator;
};
