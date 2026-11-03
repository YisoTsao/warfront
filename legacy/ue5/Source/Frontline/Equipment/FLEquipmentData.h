#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "FLEquipmentData.generated.h"

class AFLThrowable;
class UNiagaraSystem;
class USoundBase;
class UStaticMesh;

/** A throwable / deployable piece of equipment (frag grenade, etc.). */
UCLASS(BlueprintType)
class FRONTLINE_API UFLEquipmentData : public UPrimaryDataAsset
{
	GENERATED_BODY()

public:
	virtual FPrimaryAssetId GetPrimaryAssetId() const override;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	FName EquipmentId;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	FText DisplayName;

	/** Leave empty to use AFLThrowable. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	TSubclassOf<AFLThrowable> ThrowableClass;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Throw")
	float ThrowSpeed = 1500.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Throw")
	float FuseTime = 3.5f;

	/** Minimum time between throws. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Throw")
	float Cooldown = 1.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Explosion")
	float Damage = 120.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Explosion")
	float MinDamage = 5.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Explosion")
	float InnerRadius = 250.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Explosion")
	float OuterRadius = 800.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UStaticMesh> Mesh;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<UNiagaraSystem> ExplosionFX;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Presentation")
	TObjectPtr<USoundBase> ExplosionSound;

	FName GetEquipmentId() const { return EquipmentId.IsNone() ? GetFName() : EquipmentId; }
};
