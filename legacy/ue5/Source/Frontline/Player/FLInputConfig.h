#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "FLInputConfig.generated.h"

class UInputAction;
class UInputMappingContext;

/**
 * All gameplay input actions plus the mapping context that binds them to keys.
 *
 * Assign an asset on the player controller to rebind keys in the editor. When none is
 * assigned, CreateDefault() builds the default keyboard/mouse (and reserved gamepad)
 * layout in code so the game runs without any input assets.
 */
UCLASS(BlueprintType)
class FRONTLINE_API UFLInputConfig : public UDataAsset
{
	GENERATED_BODY()

public:
	static UFLInputConfig* CreateDefault(UObject* Outer);

	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputMappingContext> MappingContext;

	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Move;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Look;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Jump;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Sprint;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Crouch;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Prone;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Fire;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Aim;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Reload;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> NextWeapon;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> PrevWeapon;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> PrimaryWeapon;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> SecondaryWeapon;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> FireMode;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Throw;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Ability;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> Interact;
	UPROPERTY(EditAnywhere, Category = "Input") TObjectPtr<UInputAction> GiveUp;
};
