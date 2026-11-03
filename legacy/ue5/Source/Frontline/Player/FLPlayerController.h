#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "FLPlayerController.generated.h"

class UFLInputConfig;

UCLASS()
class FRONTLINE_API AFLPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	virtual void BeginPlay() override;
	virtual void SetupInputComponent() override;

	/** The asset assigned in Blueprint, or the built-in default layout. */
	UFLInputConfig* GetInputConfig();

	/** Console: SelectClass Medic 1  (takes effect on next spawn). */
	UFUNCTION(Exec)
	void SelectClass(FName ClassId, int32 PrimaryIndex = 0);

	/** Console: SelectClassIndex 2 */
	UFUNCTION(Exec)
	void SelectClassIndex(int32 ClassIndex);

	/** Console: cycles the primary weapon option of the selected class. */
	UFUNCTION(Exec)
	void NextPrimaryOption();

	/** Console (testing): kill yourself to respawn with a new class. */
	UFUNCTION(Exec)
	void Redeploy();

protected:
	UFUNCTION(Server, Reliable)
	void ServerSelectClass(FName ClassId, int32 PrimaryIndex);

	UFUNCTION(Server, Reliable)
	void ServerRedeploy();

	void AddMappingContext();

	void SelectClass1() { SelectClassIndex(0); }
	void SelectClass2() { SelectClassIndex(1); }
	void SelectClass3() { SelectClassIndex(2); }
	void SelectClass4() { SelectClassIndex(3); }

	UPROPERTY(EditDefaultsOnly, Category = "Input")
	TObjectPtr<UFLInputConfig> InputConfig;
};
