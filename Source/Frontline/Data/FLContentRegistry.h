#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "FLContentRegistry.generated.h"

class UFLWeaponData;
class UFLEquipmentData;
class UFLClassDefinition;

/**
 * Resolves content ids (weapons, equipment, classes) to their definitions.
 *
 * Only ids are replicated over the network; every machine resolves them here.
 * Content comes from data assets found by the Asset Manager. Any id that has no
 * asset falls back to a built-in default (see FLDefaultContent), so the game is
 * playable in an empty level before art and data assets exist.
 */
UCLASS()
class FRONTLINE_API UFLContentRegistry : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	static UFLContentRegistry* Get(const UObject* WorldContextObject);

	virtual void Initialize(FSubsystemCollectionBase& Collection) override;

	const UFLWeaponData* FindWeapon(FName Id) const;
	const UFLEquipmentData* FindEquipment(FName Id) const;
	const UFLClassDefinition* FindClass(FName Id) const;

	/** All classes, sorted by SortOrder. */
	TArray<const UFLClassDefinition*> GetClasses() const;

	/** Registration (used by the asset scan and the built-in defaults). Existing ids are kept unless bOverwrite. */
	void AddWeapon(UFLWeaponData* Data, bool bOverwrite = false);
	void AddEquipment(UFLEquipmentData* Data, bool bOverwrite = false);
	void AddClass(UFLClassDefinition* Data, bool bOverwrite = false);

private:
	void LoadFromAssetManager();

	UPROPERTY(Transient)
	TMap<FName, TObjectPtr<UFLWeaponData>> Weapons;

	UPROPERTY(Transient)
	TMap<FName, TObjectPtr<UFLEquipmentData>> Equipment;

	UPROPERTY(Transient)
	TMap<FName, TObjectPtr<UFLClassDefinition>> Classes;
};
