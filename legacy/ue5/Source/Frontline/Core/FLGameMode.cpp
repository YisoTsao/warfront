#include "Core/FLGameMode.h"
#include "Core/FLGameState.h"
#include "Core/FLPlayerState.h"
#include "Player/FLCharacter.h"
#include "Player/FLPlayerController.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "Data/FLContentRegistry.h"
#include "UI/FLHUD.h"
#include "Frontline.h"

#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/PlayerStart.h"
#include "TimerManager.h"

AFLGameMode::AFLGameMode()
{
	DefaultPawnClass = AFLCharacter::StaticClass();
	PlayerControllerClass = AFLPlayerController::StaticClass();
	PlayerStateClass = AFLPlayerState::StaticClass();
	GameStateClass = AFLGameState::StaticClass();
	HUDClass = AFLHUD::StaticClass();
	bUseSeamlessTravel = false;
}

void AFLGameMode::InitGameState()
{
	Super::InitGameState();
	if (AFLGameState* GS = GetGameState<AFLGameState>())
	{
		GS->SetTickets(EFLTeam::Alpha, StartingTickets);
		GS->SetTickets(EFLTeam::Bravo, StartingTickets);
	}
}

EFLTeam AFLGameMode::PickTeamForNewPlayer(const APlayerState* Joining) const
{
	int32 Alpha = 0;
	int32 Bravo = 0;
	if (GameState)
	{
		for (const APlayerState* PS : GameState->PlayerArray)
		{
			const AFLPlayerState* FLPS = Cast<AFLPlayerState>(PS);
			if (!FLPS || FLPS == Joining)
			{
				continue;
			}
			Alpha += FLPS->GetTeam() == EFLTeam::Alpha ? 1 : 0;
			Bravo += FLPS->GetTeam() == EFLTeam::Bravo ? 1 : 0;
		}
	}
	return Alpha <= Bravo ? EFLTeam::Alpha : EFLTeam::Bravo;
}

FString AFLGameMode::InitNewPlayer(APlayerController* NewPlayerController, const FUniqueNetIdRepl& UniqueId, const FString& Options, const FString& Portal)
{
	const FString Result = Super::InitNewPlayer(NewPlayerController, UniqueId, Options, Portal);

	if (AFLPlayerState* PS = NewPlayerController ? NewPlayerController->GetPlayerState<AFLPlayerState>() : nullptr)
	{
		PS->SetTeam(PickTeamForNewPlayer(PS));

		if (PS->GetSelectedClassId().IsNone())
		{
			const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
			const TArray<const UFLClassDefinition*> Classes = Registry ? Registry->GetClasses() : TArray<const UFLClassDefinition*>();
			if (Classes.Num() > 0)
			{
				PS->SetSelectedClass(Classes[0]->GetClassId(), 0);
			}
		}
	}
	return Result;
}

AActor* AFLGameMode::ChoosePlayerStart_Implementation(AController* Player)
{
	const AFLPlayerState* PS = Player ? Player->GetPlayerState<AFLPlayerState>() : nullptr;
	const FName TeamTag = PS ? FName(*FLTeam::GetName(PS->GetTeam()).ToLower()) : NAME_None;

	TArray<APlayerStart*> TeamStarts;
	TArray<APlayerStart*> AnyStarts;
	for (TActorIterator<APlayerStart> It(GetWorld()); It; ++It)
	{
		APlayerStart* Start = *It;
		AnyStarts.Add(Start);
		if (!TeamTag.IsNone() && Start->PlayerStartTag.ToString().Equals(TeamTag.ToString(), ESearchCase::IgnoreCase))
		{
			TeamStarts.Add(Start);
		}
	}

	TArray<APlayerStart*>& Candidates = TeamStarts.Num() > 0 ? TeamStarts : AnyStarts;
	if (Candidates.Num() == 0)
	{
		return Super::ChoosePlayerStart_Implementation(Player);
	}

	// Prefer starts not occupied by a living pawn.
	TArray<APlayerStart*> Free;
	for (APlayerStart* Start : Candidates)
	{
		bool bBlocked = false;
		for (TActorIterator<AFLCharacter> It(GetWorld()); It; ++It)
		{
			if (It->IsAlive() && FVector::DistSquared(It->GetActorLocation(), Start->GetActorLocation()) < FMath::Square(150.f))
			{
				bBlocked = true;
				break;
			}
		}
		if (!bBlocked)
		{
			Free.Add(Start);
		}
	}
	TArray<APlayerStart*>& Pool = Free.Num() > 0 ? Free : Candidates;
	return Pool[FMath::RandRange(0, Pool.Num() - 1)];
}

bool AFLGameMode::PlayerCanRestart_Implementation(APlayerController* Player)
{
	const AFLGameState* GS = GetGameState<AFLGameState>();
	return (!GS || !GS->IsMatchOver()) && Super::PlayerCanRestart_Implementation(Player);
}

void AFLGameMode::SetPlayerDefaults(APawn* PlayerPawn)
{
	Super::SetPlayerDefaults(PlayerPawn);

	AFLCharacter* Character = Cast<AFLCharacter>(PlayerPawn);
	AFLPlayerState* PS = PlayerPawn ? PlayerPawn->GetPlayerState<AFLPlayerState>() : nullptr;
	if (!Character || !PS)
	{
		return;
	}

	PS->SetRespawnServerTime(0.f);

	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	const UFLClassDefinition* ClassDef = Registry ? Registry->FindClass(PS->GetSelectedClassId()) : nullptr;
	if (!ClassDef && Registry)
	{
		const TArray<const UFLClassDefinition*> Classes = Registry->GetClasses();
		ClassDef = Classes.Num() > 0 ? Classes[0] : nullptr;
	}
	if (ClassDef)
	{
		Character->ApplyClass(ClassDef, PS->GetSelectedPrimaryIndex());
	}
	else
	{
		UE_LOG(LogFrontline, Warning, TEXT("No player class available; spawning without a loadout."));
	}
}

float AFLGameMode::ModifyDamage(float Damage, const AFLCharacter* Victim, const AController* DamageInstigator) const
{
	const AFLGameState* GS = GetGameState<AFLGameState>();
	if (GS && GS->IsMatchOver())
	{
		return 0.f;
	}
	if (!Victim || !DamageInstigator || DamageInstigator == Victim->GetController())
	{
		return Damage; // Environment and self damage (own grenade) always apply.
	}

	const AFLPlayerState* AttackerPS = DamageInstigator->GetPlayerState<AFLPlayerState>();
	const AFLPlayerState* VictimPS = Victim->GetPlayerState<AFLPlayerState>();
	if (AttackerPS && VictimPS && AttackerPS->GetTeam() != EFLTeam::None && AttackerPS->GetTeam() == VictimPS->GetTeam())
	{
		return bFriendlyFire ? Damage * FriendlyFireScale : 0.f;
	}
	return Damage;
}

void AFLGameMode::OnCharacterDowned(AFLCharacter* Victim, AController* DamageInstigator)
{
	UE_LOG(LogFrontline, Verbose, TEXT("%s downed by %s"), *GetNameSafe(Victim), *GetNameSafe(DamageInstigator));
}

void AFLGameMode::OnCharacterRevived(AFLCharacter* Victim, AController* Reviver)
{
	if (AFLPlayerState* PS = Reviver ? Reviver->GetPlayerState<AFLPlayerState>() : nullptr)
	{
		PS->AddRevive();
	}
}

void AFLGameMode::OnCharacterKilled(AFLCharacter* Victim, AController* Killer)
{
	if (!Victim)
	{
		return;
	}

	AController* VictimController = Victim->GetController();
	AFLPlayerState* VictimPS = Victim->GetPlayerState<AFLPlayerState>();
	AFLPlayerState* KillerPS = Killer ? Killer->GetPlayerState<AFLPlayerState>() : nullptr;

	if (VictimPS)
	{
		VictimPS->AddDeath();
	}
	if (KillerPS && KillerPS != VictimPS && (!VictimPS || KillerPS->GetTeam() != VictimPS->GetTeam()))
	{
		KillerPS->AddKill();
	}

	// Tickets
	AFLGameState* GS = GetGameState<AFLGameState>();
	if (GS && VictimPS && !GS->IsMatchOver())
	{
		const EFLTeam Team = VictimPS->GetTeam();
		GS->SetTickets(Team, GS->GetTickets(Team) - 1);
		if (GS->GetTickets(Team) <= 0)
		{
			GS->EndMatch(Team == EFLTeam::Alpha ? EFLTeam::Bravo : EFLTeam::Alpha);
			GetWorldTimerManager().SetTimer(RestartTimer, this, &AFLGameMode::RestartMatch, MatchRestartDelay, false);
		}
	}

	// Detach the controller, keep the body around for a while, and schedule a respawn.
	Victim->SetLifeSpan(CorpseLifeSpan);
	if (VictimController)
	{
		Victim->DetachFromControllerPendingDestroy();
		if (APlayerController* PC = Cast<APlayerController>(VictimController))
		{
			PC->SetViewTarget(Victim);
		}

		if (VictimPS && GS)
		{
			VictimPS->SetRespawnServerTime(GS->GetServerWorldTimeSeconds() + RespawnDelay);
		}

		FTimerHandle Handle;
		FTimerDelegate Delegate = FTimerDelegate::CreateUObject(this, &AFLGameMode::RespawnPlayer, TWeakObjectPtr<AController>(VictimController));
		GetWorldTimerManager().SetTimer(Handle, Delegate, RespawnDelay, false);
	}
}

void AFLGameMode::RespawnPlayer(TWeakObjectPtr<AController> Controller)
{
	AController* C = Controller.Get();
	if (!C || C->GetPawn())
	{
		return;
	}
	APlayerController* PC = Cast<APlayerController>(C);
	if (PC && !PlayerCanRestart(PC))
	{
		return;
	}
	RestartPlayer(C);
}

void AFLGameMode::RequestClassChange(AFLPlayerController* Player, FName ClassId, int32 PrimaryIndex)
{
	AFLPlayerState* PS = Player ? Player->GetPlayerState<AFLPlayerState>() : nullptr;
	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	if (PS && Registry && Registry->FindClass(ClassId))
	{
		PS->SetSelectedClass(ClassId, PrimaryIndex);
	}
}

void AFLGameMode::RestartMatch()
{
	GetWorld()->ServerTravel(TEXT("?Restart"), false);
}
