#include "UI/FLHUD.h"
#include "Player/FLCharacter.h"
#include "Core/FLGameState.h"
#include "Core/FLPlayerState.h"
#include "Combat/FLHealthComponent.h"
#include "Weapons/FLInventoryComponent.h"
#include "Weapons/FLWeapon.h"
#include "Weapons/FLWeaponData.h"
#include "PlayerClasses/FLAbility.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "Data/FLContentRegistry.h"
#include "Equipment/FLEquipmentData.h"

#include "Camera/CameraComponent.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"

namespace
{
	const FLinearColor White(1.f, 1.f, 1.f, 0.9f);
	const FLinearColor Dim(1.f, 1.f, 1.f, 0.55f);
	const FLinearColor Red(1.f, 0.2f, 0.15f, 1.f);
	const FLinearColor Yellow(1.f, 0.85f, 0.2f, 1.f);

	const TCHAR* FireModeName(EFLFireMode Mode)
	{
		switch (Mode)
		{
		case EFLFireMode::Single: return TEXT("SEMI");
		case EFLFireMode::Burst: return TEXT("BURST");
		case EFLFireMode::FullAuto: return TEXT("AUTO");
		}
		return TEXT("");
	}

	const TCHAR* StanceName(EFLStance Stance)
	{
		switch (Stance)
		{
		case EFLStance::Standing: return TEXT("STAND");
		case EFLStance::Crouching: return TEXT("CROUCH");
		case EFLStance::Prone: return TEXT("PRONE");
		}
		return TEXT("");
	}
}

float AFLHUD::GetServerTime() const
{
	const AGameStateBase* GS = GetWorld() ? GetWorld()->GetGameState() : nullptr;
	return GS ? GS->GetServerWorldTimeSeconds() : 0.f;
}

void AFLHUD::DrawCenteredText(const FString& Text, float Y, const FLinearColor& Color, float Scale)
{
	UFont* Font = GEngine->GetMediumFont();
	float W = 0.f;
	float H = 0.f;
	GetTextSize(Text, W, H, Font, Scale);
	DrawText(Text, Color, (Canvas->ClipX - W) * 0.5f, Y, Font, Scale);
}

void AFLHUD::DrawHUD()
{
	Super::DrawHUD();
	if (!Canvas)
	{
		return;
	}

	DrawMatchInfo();

	const AFLCharacter* Character = Cast<AFLCharacter>(GetOwningPawn());
	if (!Character)
	{
		DrawDeathScreen();
		return;
	}

	DrawTeamMarkers(Character);
	DrawStatus(Character);

	if (Character->IsAlive())
	{
		DrawCrosshair(Character);
		DrawHitMarker(Character);
	}
	else if (Character->IsDowned())
	{
		const float Bleedout = Character->GetHealthComponent()->GetBleedoutRemaining();
		DrawCenteredText(TEXT("DOWNED"), Canvas->ClipY * 0.40f, Red, 2.f);
		DrawCenteredText(FString::Printf(TEXT("Bleeding out in %.0f s - wait for a revive or hold X to give up"), Bleedout),
			Canvas->ClipY * 0.40f + 50.f, White);
	}
}

void AFLHUD::DrawCrosshair(const AFLCharacter* Character)
{
	const AFLWeapon* Weapon = Character->GetCurrentWeapon();
	if (!Weapon || Character->GetAimAlpha() > 0.6f)
	{
		return; // Iron sights / optics replace the crosshair.
	}

	const float CX = Canvas->ClipX * 0.5f;
	const float CY = Canvas->ClipY * 0.5f;
	const float FOV = Character->GetFirstPersonCamera()->FieldOfView;
	const float SpreadRad = FMath::DegreesToRadians(Weapon->GetCurrentSpread());
	const float Gap = FMath::Clamp(FMath::Tan(SpreadRad) / FMath::Tan(FMath::DegreesToRadians(FOV * 0.5f)) * CX, 3.f, 200.f);
	const float Len = 8.f;
	const FLinearColor Color = Character->IsSprinting() ? Dim : White;

	DrawLine(CX - Gap - Len, CY, CX - Gap, CY, Color, 2.f);
	DrawLine(CX + Gap, CY, CX + Gap + Len, CY, Color, 2.f);
	DrawLine(CX, CY - Gap - Len, CX, CY - Gap, Color, 2.f);
	DrawLine(CX, CY + Gap, CX, CY + Gap + Len, Color, 2.f);
	DrawRect(Color, CX - 1.f, CY - 1.f, 2.f, 2.f);
}

void AFLHUD::DrawHitMarker(const AFLCharacter* Character)
{
	const float Age = GetWorld()->GetTimeSeconds() - Character->GetLastHitConfirmTime();
	if (Age > 0.25f)
	{
		return;
	}
	const float CX = Canvas->ClipX * 0.5f;
	const float CY = Canvas->ClipY * 0.5f;
	const FLinearColor Color = Character->WasLastHitHeadshot() ? Red : White;
	const float A = 6.f;
	const float B = 14.f;
	DrawLine(CX - B, CY - B, CX - A, CY - A, Color, 2.f);
	DrawLine(CX + B, CY - B, CX + A, CY - A, Color, 2.f);
	DrawLine(CX - B, CY + B, CX - A, CY + A, Color, 2.f);
	DrawLine(CX + B, CY + B, CX + A, CY + A, Color, 2.f);
}

void AFLHUD::DrawStatus(const AFLCharacter* Character)
{
	UFont* Font = GEngine->GetMediumFont();
	const float Margin = 40.f;
	const float BottomY = Canvas->ClipY - Margin;

	// Health bar (bottom left)
	const UFLHealthComponent* Health = Character->GetHealthComponent();
	const float Pct = Health->GetMaxHealth() > 0.f ? Health->GetHealth() / Health->GetMaxHealth() : 0.f;
	DrawRect(FLinearColor(0.f, 0.f, 0.f, 0.5f), Margin, BottomY - 20.f, 260.f, 16.f);
	DrawRect(Pct > 0.35f ? White : Red, Margin, BottomY - 20.f, 260.f * Pct, 16.f);
	DrawText(FString::Printf(TEXT("%.0f"), Health->GetHealth()), White, Margin, BottomY - 50.f, Font, 1.2f);

	// Class, stance, ability
	const UFLClassDefinition* ClassDef = Character->GetClassDefinition();
	FString Info = FString::Printf(TEXT("%s   %s"),
		ClassDef ? *ClassDef->DisplayName.ToString().ToUpper() : TEXT("-"), StanceName(Character->GetStance()));
	if (Character->GetAbilities().Num() > 0 && Character->GetAbilities()[0])
	{
		const UFLAbility* Ability = Character->GetAbilities()[0];
		const float CD = Ability->GetCooldownRemaining();
		Info += FString::Printf(TEXT("   [Q] %s %s"), *Ability->DisplayName.ToString(),
			CD > 0.f ? *FString::Printf(TEXT("(%.0fs)"), CD) : TEXT("READY"));
	}
	DrawText(Info, Dim, Margin, BottomY - 80.f, Font, 1.f);

	// Weapon (bottom right)
	if (const AFLWeapon* Weapon = Character->GetCurrentWeapon())
	{
		const UFLWeaponData* Data = Weapon->GetWeaponData();
		const FString Ammo = FString::Printf(TEXT("%d / %d"), Weapon->GetAmmoInMagazine(), Weapon->GetReserveAmmo());
		float W = 0.f;
		float H = 0.f;
		GetTextSize(Ammo, W, H, Font, 2.f);
		const bool bLow = Data && Weapon->GetAmmoInMagazine() <= Data->MagazineSize / 4;
		DrawText(Ammo, bLow ? Yellow : White, Canvas->ClipX - Margin - W, BottomY - 50.f, Font, 2.f);

		const FString Name = FString::Printf(TEXT("%s  [%s]%s"),
			Data ? *Data->DisplayName.ToString() : TEXT("?"), FireModeName(Weapon->GetFireMode()),
			Weapon->IsReloading() ? TEXT("  RELOADING") : TEXT(""));
		GetTextSize(Name, W, H, Font, 1.f);
		DrawText(Name, Dim, Canvas->ClipX - Margin - W, BottomY - 80.f, Font, 1.f);
	}

	// Equipment
	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	const TArray<FFLEquipmentSlot>& Equipment = Character->GetInventoryComponent()->GetEquipment();
	if (Equipment.Num() > 0 && Registry)
	{
		const UFLEquipmentData* Eq = Registry->FindEquipment(Equipment[0].EquipmentId);
		const FString Text = FString::Printf(TEXT("[G] %s x%d"), Eq ? *Eq->DisplayName.ToString() : *Equipment[0].EquipmentId.ToString(), Equipment[0].Count);
		float W = 0.f;
		float H = 0.f;
		GetTextSize(Text, W, H, Font, 1.f);
		DrawText(Text, Dim, Canvas->ClipX - Margin - W, BottomY - 105.f, Font, 1.f);
	}

	// Revive progress
	if (Character->GetReviveProgress() > 0.f)
	{
		const float BarW = 240.f;
		const float X = (Canvas->ClipX - BarW) * 0.5f;
		const float Y = Canvas->ClipY * 0.62f;
		DrawCenteredText(TEXT("REVIVING"), Y - 28.f, White);
		DrawRect(FLinearColor(0.f, 0.f, 0.f, 0.5f), X, Y, BarW, 8.f);
		DrawRect(White, X, Y, BarW * Character->GetReviveProgress(), 8.f);
	}
}

void AFLHUD::DrawTeamMarkers(const AFLCharacter* Viewer)
{
	APlayerController* PC = GetOwningPlayerController();
	if (!PC)
	{
		return;
	}
	const EFLTeam MyTeam = Viewer->GetTeam();

	for (TActorIterator<AFLCharacter> It(GetWorld()); It; ++It)
	{
		const AFLCharacter* Other = *It;
		if (!Other || Other == Viewer || Other->GetLifeState() == EFLLifeState::Dead)
		{
			continue;
		}

		const bool bFriendly = MyTeam != EFLTeam::None && Other->GetTeam() == MyTeam;
		if (!bFriendly && !Other->IsSpotted())
		{
			continue;
		}

		FVector2D Screen;
		const FVector Head = Other->GetActorLocation() + FVector(0.f, 0.f, Other->GetSimpleCollisionHalfHeight() + 30.f);
		if (!PC->ProjectWorldLocationToScreen(Head, Screen, false))
		{
			continue;
		}

		const FLinearColor Color = bFriendly ? FLTeam::GetColor(MyTeam) : Red;
		const float S = 6.f;
		DrawLine(Screen.X - S, Screen.Y, Screen.X, Screen.Y - S, Color, 2.f);
		DrawLine(Screen.X, Screen.Y - S, Screen.X + S, Screen.Y, Color, 2.f);
		DrawLine(Screen.X + S, Screen.Y, Screen.X, Screen.Y + S, Color, 2.f);
		DrawLine(Screen.X, Screen.Y + S, Screen.X - S, Screen.Y, Color, 2.f);

		if (bFriendly && Other->IsDowned())
		{
			DrawText(TEXT("REVIVE [E]"), Color, Screen.X - 30.f, Screen.Y - 26.f, GEngine->GetSmallFont(), 1.f);
		}
	}
}

void AFLHUD::DrawMatchInfo()
{
	const AFLGameState* GS = GetWorld()->GetGameState<AFLGameState>();
	if (!GS)
	{
		return;
	}
	UFont* Font = GEngine->GetMediumFont();
	const FString Alpha = FString::Printf(TEXT("ALPHA %d"), GS->GetTickets(EFLTeam::Alpha));
	const FString Bravo = FString::Printf(TEXT("%d BRAVO"), GS->GetTickets(EFLTeam::Bravo));
	float W = 0.f;
	float H = 0.f;
	GetTextSize(Alpha, W, H, Font, 1.2f);
	DrawText(Alpha, FLTeam::GetColor(EFLTeam::Alpha), Canvas->ClipX * 0.5f - W - 20.f, 20.f, Font, 1.2f);
	DrawText(Bravo, FLTeam::GetColor(EFLTeam::Bravo), Canvas->ClipX * 0.5f + 20.f, 20.f, Font, 1.2f);

	if (GS->IsMatchOver())
	{
		DrawCenteredText(FString::Printf(TEXT("%s WINS"), *FLTeam::GetName(GS->GetWinningTeam())), Canvas->ClipY * 0.3f,
			FLTeam::GetColor(GS->GetWinningTeam()), 3.f);
	}
}

void AFLHUD::DrawDeathScreen()
{
	const APlayerController* PC = GetOwningPlayerController();
	const AFLPlayerState* PS = PC ? PC->GetPlayerState<AFLPlayerState>() : nullptr;
	if (!PS)
	{
		return;
	}

	const float Remaining = PS->GetRespawnServerTime() - GetServerTime();
	if (Remaining > 0.f)
	{
		DrawCenteredText(TEXT("KILLED IN ACTION"), Canvas->ClipY * 0.35f, Red, 2.f);
		DrawCenteredText(FString::Printf(TEXT("Redeploying in %.0f"), FMath::CeilToFloat(Remaining)), Canvas->ClipY * 0.35f + 50.f, White);
	}

	// Class selection hint
	const UFLContentRegistry* Registry = UFLContentRegistry::Get(this);
	if (!Registry)
	{
		return;
	}
	const TArray<const UFLClassDefinition*> Classes = Registry->GetClasses();
	FString Line;
	for (int32 i = 0; i < Classes.Num() && i < 4; ++i)
	{
		const bool bSelected = Classes[i]->GetClassId() == PS->GetSelectedClassId();
		Line += FString::Printf(TEXT("%s[F%d] %s%s   "), bSelected ? TEXT(">") : TEXT(""), i + 1,
			*Classes[i]->DisplayName.ToString(), bSelected ? TEXT("<") : TEXT(""));
	}
	DrawCenteredText(Line, Canvas->ClipY * 0.55f, White);

	if (const UFLClassDefinition* Selected = Registry->FindClass(PS->GetSelectedClassId()))
	{
		const int32 Index = PS->GetSelectedPrimaryIndex();
		const UFLWeaponData* Primary = Selected->PrimaryWeaponOptions.IsValidIndex(Index) ? Selected->PrimaryWeaponOptions[Index].Get() : nullptr;
		DrawCenteredText(FString::Printf(TEXT("Primary: %s   [F5] change"), Primary ? *Primary->DisplayName.ToString() : TEXT("-")),
			Canvas->ClipY * 0.55f + 30.f, Dim);
	}
}
