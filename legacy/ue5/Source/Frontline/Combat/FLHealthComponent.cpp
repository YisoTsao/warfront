#include "Combat/FLHealthComponent.h"
#include "Engine/World.h"
#include "GameFramework/Controller.h"
#include "GameFramework/GameStateBase.h"
#include "Net/UnrealNetwork.h"

UFLHealthComponent::UFLHealthComponent()
{
	SetIsReplicatedByDefault(true);
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.TickInterval = 0.1f;
}

void UFLHealthComponent::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(UFLHealthComponent, Health);
	DOREPLIFETIME(UFLHealthComponent, MaxHealth);
	DOREPLIFETIME(UFLHealthComponent, LifeState);
	DOREPLIFETIME(UFLHealthComponent, BleedoutEndServerTime);
}

float UFLHealthComponent::GetServerTime() const
{
	const UWorld* World = GetWorld();
	const AGameStateBase* GS = World ? World->GetGameState() : nullptr;
	return GS ? GS->GetServerWorldTimeSeconds() : (World ? World->GetTimeSeconds() : 0.f);
}

float UFLHealthComponent::GetBleedoutRemaining() const
{
	return LifeState == EFLLifeState::Downed ? FMath::Max(0.f, BleedoutEndServerTime - GetServerTime()) : 0.f;
}

void UFLHealthComponent::InitializeHealth(float InMaxHealth)
{
	if (!GetOwner()->HasAuthority())
	{
		return;
	}
	MaxHealth = FMath::Max(1.f, InMaxHealth);
	Health = MaxHealth;
	LifeState = EFLLifeState::Alive;
	OnHealthChanged.Broadcast(Health, 0.f);
}

void UFLHealthComponent::ApplyDamage(float Amount, AController* Instigator, AActor* DamageCauser, bool bAllowDowned)
{
	if (!GetOwner()->HasAuthority() || Amount <= 0.f || LifeState == EFLLifeState::Dead)
	{
		return;
	}

	LastDamageTime = GetWorld()->GetTimeSeconds();
	if (Instigator)
	{
		LastInstigator = Instigator;
	}

	if (LifeState == EFLLifeState::Downed)
	{
		// Any further damage while downed finishes the player.
		SetLifeState(EFLLifeState::Dead, Instigator);
		return;
	}

	const float OldHealth = Health;
	Health = FMath::Max(0.f, Health - Amount);
	OnHealthChanged.Broadcast(Health, Health - OldHealth);

	if (Health <= 0.f)
	{
		if (bCanBeDowned && bAllowDowned)
		{
			BleedoutEndServerTime = GetServerTime() + BleedoutTime;
			SetLifeState(EFLLifeState::Downed, Instigator);
		}
		else
		{
			SetLifeState(EFLLifeState::Dead, Instigator);
		}
	}
}

void UFLHealthComponent::Heal(float Amount)
{
	if (!GetOwner()->HasAuthority() || LifeState != EFLLifeState::Alive || Amount <= 0.f)
	{
		return;
	}
	const float OldHealth = Health;
	Health = FMath::Min(MaxHealth, Health + Amount);
	if (Health != OldHealth)
	{
		OnHealthChanged.Broadcast(Health, Health - OldHealth);
	}
}

void UFLHealthComponent::Revive(float HealthFraction, AController* Reviver)
{
	if (!GetOwner()->HasAuthority() || LifeState != EFLLifeState::Downed)
	{
		return;
	}
	Health = FMath::Clamp(HealthFraction, 0.05f, 1.f) * MaxHealth;
	LastDamageTime = GetWorld()->GetTimeSeconds();
	OnHealthChanged.Broadcast(Health, Health);
	SetLifeState(EFLLifeState::Alive, Reviver);
}

void UFLHealthComponent::Kill(AController* Instigator)
{
	if (!GetOwner()->HasAuthority() || LifeState == EFLLifeState::Dead)
	{
		return;
	}
	Health = 0.f;
	SetLifeState(EFLLifeState::Dead, Instigator ? Instigator : LastInstigator.Get());
}

void UFLHealthComponent::SetLifeState(EFLLifeState NewState, AController* Instigator)
{
	if (NewState == LifeState)
	{
		return;
	}
	const EFLLifeState OldState = LifeState;
	LifeState = NewState;
	if (NewState == EFLLifeState::Dead)
	{
		Health = 0.f;
	}
	OnLifeStateChanged.Broadcast(NewState, OldState, Instigator);
}

void UFLHealthComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);

	if (!GetOwner()->HasAuthority())
	{
		return;
	}

	if (LifeState == EFLLifeState::Downed && GetServerTime() >= BleedoutEndServerTime)
	{
		SetLifeState(EFLLifeState::Dead, LastInstigator.Get());
		return;
	}

	if (LifeState == EFLLifeState::Alive && RegenPerSecond > 0.f)
	{
		const float Cap = MaxHealth * RegenCapFraction;
		if (Health < Cap && GetWorld()->GetTimeSeconds() - LastDamageTime >= RegenDelay)
		{
			const float OldHealth = Health;
			Health = FMath::Min(Cap, Health + RegenPerSecond * DeltaTime);
			OnHealthChanged.Broadcast(Health, Health - OldHealth);
		}
	}
}

void UFLHealthComponent::OnRep_Health(float OldHealth)
{
	OnHealthChanged.Broadcast(Health, Health - OldHealth);
}

void UFLHealthComponent::OnRep_LifeState(EFLLifeState OldState)
{
	OnLifeStateChanged.Broadcast(LifeState, OldState, nullptr);
}
