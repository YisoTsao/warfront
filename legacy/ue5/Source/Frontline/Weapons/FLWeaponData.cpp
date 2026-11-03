#include "Weapons/FLWeaponData.h"

FPrimaryAssetId UFLWeaponData::GetPrimaryAssetId() const
{
	return FPrimaryAssetId(TEXT("FLWeapon"), GetFName());
}

float UFLWeaponData::GetDamageAtDistance(float DistanceCm) const
{
	const float Meters = DistanceCm / 100.f;
	if (Meters <= Damage.FalloffStartMeters)
	{
		return Damage.MaxDamage;
	}
	if (Meters >= Damage.FalloffEndMeters)
	{
		return Damage.MinDamage;
	}
	const float Alpha = (Meters - Damage.FalloffStartMeters) / FMath::Max(1.f, Damage.FalloffEndMeters - Damage.FalloffStartMeters);
	return FMath::Lerp(Damage.MaxDamage, Damage.MinDamage, Alpha);
}
