#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerState.h"
#include "Core/FLTypes.h"
#include "FLPlayerState.generated.h"

UCLASS()
class FRONTLINE_API AFLPlayerState : public APlayerState
{
	GENERATED_BODY()

public:
	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;
	virtual void CopyProperties(APlayerState* PlayerState) override;

	UFUNCTION(BlueprintPure, Category = "Frontline") EFLTeam GetTeam() const { return Team; }
	UFUNCTION(BlueprintPure, Category = "Frontline") FName GetSelectedClassId() const { return SelectedClassId; }
	UFUNCTION(BlueprintPure, Category = "Frontline") int32 GetSelectedPrimaryIndex() const { return SelectedPrimaryIndex; }
	UFUNCTION(BlueprintPure, Category = "Frontline") int32 GetKills() const { return Kills; }
	UFUNCTION(BlueprintPure, Category = "Frontline") int32 GetDeaths() const { return Deaths; }
	UFUNCTION(BlueprintPure, Category = "Frontline") int32 GetRevives() const { return Revives; }
	UFUNCTION(BlueprintPure, Category = "Frontline") float GetRespawnServerTime() const { return RespawnServerTime; }

	// ---- Server ----
	void SetTeam(EFLTeam InTeam) { Team = InTeam; }
	void SetSelectedClass(FName InClassId, int32 InPrimaryIndex);
	void AddKill() { ++Kills; }
	void AddDeath() { ++Deaths; }
	void AddRevive() { ++Revives; }
	void SetRespawnServerTime(float Time) { RespawnServerTime = Time; }

protected:
	UPROPERTY(Replicated)
	EFLTeam Team = EFLTeam::None;

	UPROPERTY(Replicated)
	FName SelectedClassId;

	UPROPERTY(Replicated)
	int32 SelectedPrimaryIndex = 0;

	UPROPERTY(Replicated)
	int32 Kills = 0;

	UPROPERTY(Replicated)
	int32 Deaths = 0;

	UPROPERTY(Replicated)
	int32 Revives = 0;

	/** Server world time at which the player will respawn (0 when alive). */
	UPROPERTY(Replicated)
	float RespawnServerTime = 0.f;
};
