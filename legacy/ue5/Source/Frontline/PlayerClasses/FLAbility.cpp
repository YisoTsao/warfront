#include "PlayerClasses/FLAbility.h"
#include "Player/FLCharacter.h"
#include "Combat/FLHealthComponent.h"
#include "Weapons/FLInventoryComponent.h"
#include "Frontline.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/GameStateBase.h"
#include "Net/UnrealNetwork.h"

UFLAbility::UFLAbility()
{
	SetIsReplicatedByDefault(true);
	PrimaryComponentTick.bCanEverTick = false;
}

void UFLAbility::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME_CONDITION(UFLAbility, CooldownEndServerTime, COND_OwnerOnly);
}

float UFLAbility::GetServerTime() const
{
	const UWorld* World = GetWorld();
	const AGameStateBase* GS = World ? World->GetGameState() : nullptr;
	return GS ? GS->GetServerWorldTimeSeconds() : (World ? World->GetTimeSeconds() : 0.f);
}

float UFLAbility::GetCooldownRemaining() const
{
	return FMath::Max(0.f, CooldownEndServerTime - GetServerTime());
}

AFLCharacter* UFLAbility::GetFLCharacter() const
{
	return Cast<AFLCharacter>(GetOwner());
}

bool UFLAbility::TryActivate()
{
	if (!GetOwner() || !GetOwner()->HasAuthority())
	{
		return false;
	}
	if (GetCooldownRemaining() > 0.f || !CanActivateAbility())
	{
		return false;
	}
	if (ExecuteAbility())
	{
		CooldownEndServerTime = GetServerTime() + Cooldown;
		return true;
	}
	return false;
}

bool UFLAbility::CanActivateAbility_Implementation() const
{
	const AFLCharacter* Character = GetFLCharacter();
	return Character && Character->IsAlive();
}

bool UFLAbility::ExecuteAbility_Implementation()
{
	return false;
}

// ---------------------------------------------------------------------------

namespace
{
	template <typename Func>
	void ForEachTeammateInRadius(AFLCharacter* Source, float Radius, Func&& Callback)
	{
		for (TActorIterator<AFLCharacter> It(Source->GetWorld()); It; ++It)
		{
			AFLCharacter* Other = *It;
			if (Other && Other->IsAlive() && !AFLCharacter::AreEnemies(Source, Other)
				&& FVector::DistSquared(Other->GetActorLocation(), Source->GetActorLocation()) <= FMath::Square(Radius))
			{
				Callback(Other);
			}
		}
	}
}

UFLAbility_Stim::UFLAbility_Stim()
{
	DisplayName = FText::FromString(TEXT("Combat Stim"));
	Cooldown = 25.f;
}

bool UFLAbility_Stim::ExecuteAbility_Implementation()
{
	AFLCharacter* Character = GetFLCharacter();
	UFLHealthComponent* Health = Character ? Character->GetHealthComponent() : nullptr;
	if (!Health || Health->GetHealth() >= Health->GetMaxHealth())
	{
		return false;
	}
	Health->Heal(HealAmount);
	return true;
}

UFLAbility_HealPulse::UFLAbility_HealPulse()
{
	DisplayName = FText::FromString(TEXT("Heal Pulse"));
	Cooldown = 20.f;
}

bool UFLAbility_HealPulse::ExecuteAbility_Implementation()
{
	AFLCharacter* Character = GetFLCharacter();
	if (!Character)
	{
		return false;
	}
	int32 Healed = 0;
	ForEachTeammateInRadius(Character, Radius, [this, &Healed](AFLCharacter* Mate)
	{
		UFLHealthComponent* Health = Mate->GetHealthComponent();
		if (Health && Health->GetHealth() < Health->GetMaxHealth())
		{
			Health->Heal(HealAmount);
			++Healed;
		}
	});
	return Healed > 0;
}

UFLAbility_Resupply::UFLAbility_Resupply()
{
	DisplayName = FText::FromString(TEXT("Ammo Resupply"));
	Cooldown = 30.f;
}

bool UFLAbility_Resupply::ExecuteAbility_Implementation()
{
	AFLCharacter* Character = GetFLCharacter();
	if (!Character)
	{
		return false;
	}
	ForEachTeammateInRadius(Character, Radius, [](AFLCharacter* Mate)
	{
		if (UFLInventoryComponent* Inventory = Mate->GetInventoryComponent())
		{
			Inventory->RefillAmmoAndEquipment();
		}
	});
	return true;
}

UFLAbility_Spot::UFLAbility_Spot()
{
	DisplayName = FText::FromString(TEXT("Spot"));
	Cooldown = 6.f;
}

bool UFLAbility_Spot::ExecuteAbility_Implementation()
{
	AFLCharacter* Character = GetFLCharacter();
	if (!Character)
	{
		return false;
	}

	FVector ViewLoc;
	FRotator ViewRot;
	Character->GetActorEyesViewPoint(ViewLoc, ViewRot);
	const FVector ViewDir = ViewRot.Vector();
	const float MinDot = FMath::Cos(FMath::DegreesToRadians(ConeHalfAngleDegrees));

	int32 Spotted = 0;
	for (TActorIterator<AFLCharacter> It(Character->GetWorld()); It; ++It)
	{
		AFLCharacter* Other = *It;
		if (!Other || !Other->IsAlive() || !AFLCharacter::AreEnemies(Character, Other))
		{
			continue;
		}
		const FVector Target = Other->GetActorLocation();
		const FVector ToTarget = Target - ViewLoc;
		if (ToTarget.SizeSquared() > FMath::Square(Range) || FVector::DotProduct(ToTarget.GetSafeNormal(), ViewDir) < MinDot)
		{
			continue;
		}

		FCollisionQueryParams Params(SCENE_QUERY_STAT(FLSpot), false, Character);
		Params.AddIgnoredActor(Other);
		if (!Character->GetWorld()->LineTraceTestByChannel(ViewLoc, Target, ECC_Visibility, Params))
		{
			Other->MarkSpotted(SpotDuration);
			++Spotted;
		}
	}
	return Spotted > 0;
}
