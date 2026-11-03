#include "Core/FLGameState.h"
#include "Net/UnrealNetwork.h"

void AFLGameState::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(AFLGameState, AlphaTickets);
	DOREPLIFETIME(AFLGameState, BravoTickets);
	DOREPLIFETIME(AFLGameState, bMatchOver);
	DOREPLIFETIME(AFLGameState, WinningTeam);
}

int32 AFLGameState::GetTickets(EFLTeam Team) const
{
	switch (Team)
	{
	case EFLTeam::Alpha: return AlphaTickets;
	case EFLTeam::Bravo: return BravoTickets;
	default: return 0;
	}
}

void AFLGameState::SetTickets(EFLTeam Team, int32 Value)
{
	Value = FMath::Max(0, Value);
	if (Team == EFLTeam::Alpha) { AlphaTickets = Value; }
	else if (Team == EFLTeam::Bravo) { BravoTickets = Value; }
}

void AFLGameState::EndMatch(EFLTeam Winner)
{
	bMatchOver = true;
	WinningTeam = Winner;
}
