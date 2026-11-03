#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "FLClassDefinition.generated.h"

class UFLWeaponData;
class UFLEquipmentData;
class UFLAbility;
class UTexture2D;

USTRUCT(BlueprintType)
struct FFLEquipmentLoadout
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Equipment")
	TObjectPtr<UFLEquipmentData> Equipment;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Equipment", meta = (ClampMin = 0))
	int32 Count = 1;
};

/**
 * A player class (Assault, Medic, Support, Recon, ...).
 *
 * Class-specific behavior lives here and in UFLAbility subclasses, never in the
 * character or controller. Add a new class by creating a new data asset under
 * /Game/Frontline/Data/Classes.
 */
UCLASS(BlueprintType)
class FRONTLINE_API UFLClassDefinition : public UPrimaryDataAsset
{
	GENERATED_BODY()

public:
	virtual FPrimaryAssetId GetPrimaryAssetId() const override;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	FName ClassId;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	FText DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity", meta = (MultiLine = true))
	FText Description;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	TObjectPtr<UTexture2D> Icon;

	/** Sort order in class selection. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Identity")
	int32 SortOrder = 0;

	// ---- Stats ----
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Stats")
	float MaxHealth = 100.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Stats")
	float SprintSpeedMultiplier = 1.f;

	/** Seconds to revive a downed teammate. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Stats")
	float ReviveTime = 5.f;

	/** Fraction of max health a revived teammate gets back. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Stats", meta = (ClampMin = 0.05, ClampMax = 1))
	float ReviveHealthFraction = 0.3f;

	// ---- Loadout ----
	/** Selectable primary weapons. The first one is the default. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Loadout")
	TArray<TObjectPtr<UFLWeaponData>> PrimaryWeaponOptions;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Loadout")
	TArray<TObjectPtr<UFLWeaponData>> SecondaryWeaponOptions;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Loadout")
	TArray<FFLEquipmentLoadout> Equipment;

	/** Abilities granted on spawn. Slot 0 is bound to the Ability input. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Loadout")
	TArray<TSubclassOf<UFLAbility>> Abilities;

	FName GetClassId() const { return ClassId.IsNone() ? GetFName() : ClassId; }
};
