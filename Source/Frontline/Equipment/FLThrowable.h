#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "FLThrowable.generated.h"

class USphereComponent;
class UStaticMeshComponent;
class UProjectileMovementComponent;
class UFLEquipmentData;

/** Bouncing, fused grenade. Server simulates and applies radial damage; clients play FX. */
UCLASS(Blueprintable)
class FRONTLINE_API AFLThrowable : public AActor
{
	GENERATED_BODY()

public:
	AFLThrowable();

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

	/** Server: configure and launch. */
	void InitThrowable(const UFLEquipmentData* InData, AController* InInstigator, const FVector& Velocity);

protected:
	void Explode();

	UFUNCTION(NetMulticast, Reliable)
	void MulticastExplode(FVector_NetQuantize Location);

	UFUNCTION()
	void OnRep_EquipmentId();

	const UFLEquipmentData* ResolveData() const;

	UPROPERTY(VisibleAnywhere, Category = "Components")
	TObjectPtr<USphereComponent> Collision;

	UPROPERTY(VisibleAnywhere, Category = "Components")
	TObjectPtr<UStaticMeshComponent> Mesh;

	UPROPERTY(VisibleAnywhere, Category = "Components")
	TObjectPtr<UProjectileMovementComponent> Movement;

	UPROPERTY(ReplicatedUsing = OnRep_EquipmentId)
	FName EquipmentId;

	TWeakObjectPtr<AController> InstigatorController;
	FTimerHandle FuseTimer;
	bool bExploded = false;
};
