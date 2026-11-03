#include "Player/FLPlayerController.h"
#include "Player/FLInputConfig.h"
#include "Player/FLCharacter.h"
#include "Core/FLGameMode.h"
#include "Core/FLPlayerState.h"
#include "Combat/FLHealthComponent.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "Data/FLContentRegistry.h"

#include "EnhancedInputSubsystems.h"
#include "InputMappingContext.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"

void AFLPlayerController::BeginPlay()
{
	Super::BeginPlay();

	if (IsLocalController())
	{
		AddMappingContext();
		FInputModeGameOnly Mode;
		SetInputMode(Mode);
		bShowMouseCursor = false;
	}
}

UFLInputConfig* AFLPlayerController::GetInputConfig()
{
	if (!InputConfig)
	{
		InputConfig = UFLInputConfig::CreateDefault(this);
	}
	return InputConfig;
}

void AFLPlayerController::AddMappingContext()
{
	UFLInputConfig* Config = GetInputConfig();
	if (UEnhancedInputLocalPlayerSubsystem* Subsystem = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(GetLocalPlayer()))
	{
		if (Config && Config->MappingContext)
		{
			Subsystem->AddMappingContext(Config->MappingContext, 0);
		}
	}
}

void AFLPlayerController::SetupInputComponent()
{
	Super::SetupInputComponent();

	// Class selection hotkeys (placeholder until the deploy screen UI exists).
	InputComponent->BindKey(EKeys::F1, IE_Pressed, this, &AFLPlayerController::SelectClass1);
	InputComponent->BindKey(EKeys::F2, IE_Pressed, this, &AFLPlayerController::SelectClass2);
	InputComponent->BindKey(EKeys::F3, IE_Pressed, this, &AFLPlayerController::SelectClass3);
	InputComponent->BindKey(EKeys::F4, IE_Pressed, this, &AFLPlayerController::SelectClass4);
	InputComponent->BindKey(EKeys::F5, IE_Pressed, this, &AFLPlayerController::NextPrimaryOption);
}

void AFLPlayerController::SelectClass(FName ClassId, int32 PrimaryIndex)
{
	ServerSelectClass(ClassId, PrimaryIndex);
}

void AFLPlayerController::SelectClassIndex(int32 ClassIndex)
{
	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	if (!Registry)
	{
		return;
	}
	const TArray<const UFLClassDefinition*> Classes = Registry->GetClasses();
	if (Classes.IsValidIndex(ClassIndex))
	{
		SelectClass(Classes[ClassIndex]->GetClassId(), 0);
	}
}

void AFLPlayerController::NextPrimaryOption()
{
	const AFLPlayerState* PS = GetPlayerState<AFLPlayerState>();
	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	const UFLClassDefinition* ClassDef = (PS && Registry) ? Registry->FindClass(PS->GetSelectedClassId()) : nullptr;
	if (ClassDef && ClassDef->PrimaryWeaponOptions.Num() > 0)
	{
		const int32 Next = (PS->GetSelectedPrimaryIndex() + 1) % ClassDef->PrimaryWeaponOptions.Num();
		SelectClass(ClassDef->GetClassId(), Next);
	}
}

void AFLPlayerController::ServerSelectClass_Implementation(FName ClassId, int32 PrimaryIndex)
{
	if (AFLGameMode* GameMode = GetWorld()->GetAuthGameMode<AFLGameMode>())
	{
		GameMode->RequestClassChange(this, ClassId, PrimaryIndex);
	}
}

void AFLPlayerController::Redeploy()
{
	ServerRedeploy();
}

void AFLPlayerController::ServerRedeploy_Implementation()
{
	if (AFLCharacter* Character = GetPawn<AFLCharacter>())
	{
		Character->GetHealthComponent()->Kill(nullptr);
	}
}
