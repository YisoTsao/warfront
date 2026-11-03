#include "Equipment/FLThrowable.h"
#include "Equipment/FLEquipmentData.h"
#include "Combat/FLDamageTypes.h"
#include "Data/FLContentRegistry.h"
#include "Frontline.h"

#include "Components/SphereComponent.h"
#include "Components/StaticMeshComponent.h"
#include "DrawDebugHelpers.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/ProjectileMovementComponent.h"
#include "Kismet/GameplayStatics.h"
#include "Net/UnrealNetwork.h"
#include "NiagaraFunctionLibrary.h"
#include "TimerManager.h"
#include "UObject/ConstructorHelpers.h"

AFLThrowable::AFLThrowable()
{
	bReplicates = true;
	SetReplicateMovement(true);

	Collision = CreateDefaultSubobject<USphereComponent>(TEXT("Collision"));
	Collision->InitSphereRadius(5.f);
	Collision->SetCollisionProfileName(TEXT("BlockAllDynamic"));
	Collision->SetCollisionResponseToChannel(ECC_Pawn, ECR_Ignore);
	Collision->SetCollisionResponseToChannel(ECC_FLWeapon, ECR_Ignore);
	SetRootComponent(Collision);

	Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
	Mesh->SetupAttachment(Collision);
	Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Mesh->SetRelativeScale3D(FVector(0.1f));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	if (SphereMesh.Succeeded())
	{
		Mesh->SetStaticMesh(SphereMesh.Object);
	}

	Movement = CreateDefaultSubobject<UProjectileMovementComponent>(TEXT("Movement"));
	Movement->UpdatedComponent = Collision;
	Movement->bShouldBounce = true;
	Movement->Bounciness = 0.35f;
	Movement->Friction = 0.4f;
	Movement->bRotationFollowsVelocity = true;
	Movement->InitialSpeed = 0.f;
	Movement->MaxSpeed = 5000.f;
}

void AFLThrowable::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(AFLThrowable, EquipmentId);
}

const UFLEquipmentData* AFLThrowable::ResolveData() const
{
	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	return Registry ? Registry->FindEquipment(EquipmentId) : nullptr;
}

void AFLThrowable::OnRep_EquipmentId()
{
	const UFLEquipmentData* Data = ResolveData();
	if (Data && Data->Mesh)
	{
		Mesh->SetStaticMesh(Data->Mesh);
		Mesh->SetRelativeScale3D(FVector(1.f));
	}
}

void AFLThrowable::InitThrowable(const UFLEquipmentData* InData, AController* InInstigator, const FVector& Velocity)
{
	if (!HasAuthority() || !InData)
	{
		return;
	}
	EquipmentId = InData->GetEquipmentId();
	OnRep_EquipmentId();
	InstigatorController = InInstigator;
	Movement->Velocity = Velocity;
	if (GetOwner())
	{
		Collision->IgnoreActorWhenMoving(GetOwner(), true);
	}
	GetWorldTimerManager().SetTimer(FuseTimer, this, &AFLThrowable::Explode, FMath::Max(0.1f, InData->FuseTime), false);
}

void AFLThrowable::Explode()
{
	if (bExploded || !HasAuthority())
	{
		return;
	}
	bExploded = true;

	const UFLEquipmentData* Data = ResolveData();
	const FVector Location = GetActorLocation() + FVector(0.f, 0.f, 10.f);
	if (Data)
	{
		const TArray<AActor*> Ignore;
		UGameplayStatics::ApplyRadialDamageWithFalloff(this, Data->Damage, Data->MinDamage, Location,
			Data->InnerRadius, Data->OuterRadius, 1.f, UFLDamageType_Explosive::StaticClass(), Ignore,
			this, InstigatorController.Get(), ECC_Visibility);
	}

	MulticastExplode(Location);
	SetLifeSpan(0.5f);
	Mesh->SetHiddenInGame(true);
	Movement->StopMovementImmediately();
}

void AFLThrowable::MulticastExplode_Implementation(FVector_NetQuantize Location)
{
	if (GetNetMode() == NM_DedicatedServer)
	{
		return;
	}
	Mesh->SetHiddenInGame(true);

	const UFLEquipmentData* Data = ResolveData();
	if (Data && Data->ExplosionFX)
	{
		UNiagaraFunctionLibrary::SpawnSystemAtLocation(this, Data->ExplosionFX, Location);
	}
	if (Data && Data->ExplosionSound)
	{
		UGameplayStatics::PlaySoundAtLocation(this, Data->ExplosionSound, Location);
	}
	if (!Data || !Data->ExplosionFX)
	{
		// Gray-box feedback until real VFX exist.
		DrawDebugSphere(GetWorld(), Location, Data ? Data->InnerRadius : 250.f, 16, FColor::Orange, false, 0.6f);
	}
}
