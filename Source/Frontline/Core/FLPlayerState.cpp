#include "Core/FLPlayerState.h"
#include "Net/UnrealNetwork.h"

void AFLPlayerState::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(AFLPlayerState, Team);
	DOREPLIFETIME(AFLPlayerState, SelectedClassId);
	DOREPLIFETIME_CONDITION(AFLPlayerState, SelectedPrimaryIndex, COND_OwnerOnly);
	DOREPLIFETIME(AFLPlayerState, Kills);
	DOREPLIFETIME(AFLPlayerState, Deaths);
	DOREPLIFETIME(AFLPlayerState, Revives);
	DOREPLIFETIME_CONDITION(AFLPlayerState, RespawnServerTime, COND_OwnerOnly);
}

void AFLPlayerState::CopyProperties(APlayerState* PlayerState)
{
	Super::CopyProperties(PlayerState);
	if (AFLPlayerState* Other = Cast<AFLPlayerState>(PlayerState))
	{
		Other->Team = Team;
		Other->SelectedClassId = SelectedClassId;
		Other->SelectedPrimaryIndex = SelectedPrimaryIndex;
	}
}

void AFLPlayerState::SetSelectedClass(FName InClassId, int32 InPrimaryIndex)
{
	SelectedClassId = InClassId;
	SelectedPrimaryIndex = FMath::Max(0, InPrimaryIndex);
}
