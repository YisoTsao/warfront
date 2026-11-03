#pragma once

#include "CoreMinimal.h"
#include "FLTypes.generated.h"

UENUM(BlueprintType)
enum class EFLTeam : uint8
{
	None,
	Alpha,
	Bravo
};

UENUM(BlueprintType)
enum class EFLStance : uint8
{
	Standing,
	Crouching,
	Prone
};

UENUM(BlueprintType)
enum class EFLLifeState : uint8
{
	Alive,
	/** Incapacitated: can be revived by a teammate until the bleed-out timer expires. */
	Downed,
	Dead
};

UENUM(BlueprintType)
enum class EFLWeaponCategory : uint8
{
	AssaultRifle,
	SMG,
	DMR,
	SniperRifle,
	LMG,
	Shotgun,
	Pistol
};

UENUM(BlueprintType)
enum class EFLFireMode : uint8
{
	Single,
	Burst,
	FullAuto
};

UENUM(BlueprintType)
enum class EFLWeaponSlot : uint8
{
	Primary,
	Secondary
};

namespace FLTeam
{
	inline FLinearColor GetColor(EFLTeam Team)
	{
		switch (Team)
		{
		case EFLTeam::Alpha: return FLinearColor(0.15f, 0.45f, 1.0f);
		case EFLTeam::Bravo: return FLinearColor(1.0f, 0.3f, 0.15f);
		default: return FLinearColor(0.6f, 0.6f, 0.6f);
		}
	}

	inline FString GetName(EFLTeam Team)
	{
		switch (Team)
		{
		case EFLTeam::Alpha: return TEXT("ALPHA");
		case EFLTeam::Bravo: return TEXT("BRAVO");
		default: return TEXT("NONE");
		}
	}
}
