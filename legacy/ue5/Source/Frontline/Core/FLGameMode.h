#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "Core/FLTypes.h"
#include "FLGameMode.generated.h"

class AFLCharacter;
class AFLPlayerController;

/**
 * Team deathmatch with tickets (MVP mode). Handles team assignment, team spawns,
 * class selection, friendly fire, downed/kill/revive scoring and respawns.
 * Objective modes (e.g. Conquest) should subclass this.
 */
UCLASS()
class FRONTLINE_API AFLGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AFLGameMode();

	virtual void InitGameState() override;
	virtual FString InitNewPlayer(APlayerController* NewPlayerController, const FUniqueNetIdRepl& UniqueId, const FString& Options, const FString& Portal) override;
	virtual AActor* ChoosePlayerStart_Implementation(AController* Player) override;
	virtual void SetPlayerDefaults(APawn* PlayerPawn) override;
	virtual bool PlayerCanRestart_Implementation(APlayerController* Player) override;

	/** Applies team rules (friendly fire) and match state to incoming damage. */
	float ModifyDamage(float Damage, const AFLCharacter* Victim, const AController* DamageInstigator) const;

	void OnCharacterDowned(AFLCharacter* Victim, AController* DamageInstigator);
	void OnCharacterKilled(AFLCharacter* Victim, AController* Killer);
	void OnCharacterRevived(AFLCharacter* Victim, AController* Reviver);

	/** Class change takes effect on next spawn. */
	void RequestClassChange(AFLPlayerController* Player, FName ClassId, int32 PrimaryIndex);

protected:
	void RespawnPlayer(TWeakObjectPtr<AController> Controller);
	EFLTeam PickTeamForNewPlayer(const APlayerState* Joining) const;
	void RestartMatch();

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Rules")
	float RespawnDelay = 6.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Rules")
	int32 StartingTickets = 100;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Rules")
	bool bFriendlyFire = false;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Rules", meta = (EditCondition = "bFriendlyFire"))
	float FriendlyFireScale = 0.5f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Rules")
	float MatchRestartDelay = 15.f;

	UPROPERTY(EditDefaultsOnly, Category = "Frontline|Rules")
	float CorpseLifeSpan = 20.f;

	FTimerHandle RestartTimer;
};
