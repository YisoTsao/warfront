#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "FLHUD.generated.h"

class AFLCharacter;

/**
 * Canvas HUD for gray-box playtesting: dynamic crosshair, health, ammo, fire mode,
 * stance, tickets, downed/respawn states, team and spotted markers, hit markers.
 * Will be replaced by UMG widgets once the UI art direction is set.
 */
UCLASS()
class FRONTLINE_API AFLHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;

protected:
	void DrawCrosshair(const AFLCharacter* Character);
	void DrawHitMarker(const AFLCharacter* Character);
	void DrawStatus(const AFLCharacter* Character);
	void DrawTeamMarkers(const AFLCharacter* Viewer);
	void DrawMatchInfo();
	void DrawDeathScreen();
	void DrawCenteredText(const FString& Text, float Y, const FLinearColor& Color, float Scale = 1.f);
	float GetServerTime() const;
};
