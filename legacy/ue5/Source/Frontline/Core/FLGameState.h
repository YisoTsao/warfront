#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameStateBase.h"
#include "Core/FLTypes.h"
#include "FLGameState.generated.h"

/** Team tickets and match result. */
UCLASS()
class FRONTLINE_API AFLGameState : public AGameStateBase
{
	GENERATED_BODY()

public:
	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	int32 GetTickets(EFLTeam Team) const;

	UFUNCTION(BlueprintPure, Category = "Frontline")
	bool IsMatchOver() const { return bMatchOver; }

	UFUNCTION(BlueprintPure, Category = "Frontline")
	EFLTeam GetWinningTeam() const { return WinningTeam; }

	// ---- Server ----
	void SetTickets(EFLTeam Team, int32 Value);
	void EndMatch(EFLTeam Winner);

protected:
	UPROPERTY(Replicated)
	int32 AlphaTickets = 0;

	UPROPERTY(Replicated)
	int32 BravoTickets = 0;

	UPROPERTY(Replicated)
	bool bMatchOver = false;

	UPROPERTY(Replicated)
	EFLTeam WinningTeam = EFLTeam::None;
};
