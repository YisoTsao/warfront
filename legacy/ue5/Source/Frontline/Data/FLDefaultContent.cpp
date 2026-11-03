#include "Data/FLDefaultContent.h"
#include "Data/FLContentRegistry.h"
#include "Weapons/FLWeaponData.h"
#include "Equipment/FLEquipmentData.h"
#include "PlayerClasses/FLClassDefinition.h"
#include "PlayerClasses/FLAbility.h"

namespace
{
	struct FWeaponSpec
	{
		const TCHAR* Id;
		const TCHAR* Name;
		EFLWeaponCategory Category;
		EFLWeaponSlot Slot;
		TArray<EFLFireMode> Modes;
		float RPM;
		int32 Mag;
		int32 Reserve;
		float Reload;
		float EmptyReload;
		float MaxDamage;
		float MinDamage;
		float FalloffStart;
		float FalloffEnd;
		float HeadMult;
		float HipSpread;
		float AimSpread;
		float SpreadPerShot;
		float VerticalKick;
		float HorizontalKick;
		float AimFOV;
		float AdsTime;
		int32 Pellets = 1;
		float PelletSpread = 0.f;
		bool bPerRound = false;
	};

	UFLWeaponData* MakeWeapon(UObject* Outer, const FWeaponSpec& S)
	{
		UFLWeaponData* W = NewObject<UFLWeaponData>(Outer, FName(S.Id));
		W->WeaponId = FName(S.Id);
		W->DisplayName = FText::FromString(S.Name);
		W->Category = S.Category;
		W->Slot = S.Slot;
		W->FireModes = S.Modes;
		W->RoundsPerMinute = S.RPM;
		W->MagazineSize = S.Mag;
		W->MaxReserveAmmo = S.Reserve;
		W->ReloadTime = S.Reload;
		W->EmptyReloadTime = S.EmptyReload;
		W->bReloadPerRound = S.bPerRound;
		W->Damage.MaxDamage = S.MaxDamage;
		W->Damage.MinDamage = S.MinDamage;
		W->Damage.FalloffStartMeters = S.FalloffStart;
		W->Damage.FalloffEndMeters = S.FalloffEnd;
		W->Damage.HeadMultiplier = S.HeadMult;
		W->Damage.Pellets = S.Pellets;
		W->Damage.PelletSpread = S.PelletSpread;
		W->Spread.HipSpread = S.HipSpread;
		W->Spread.AimSpread = S.AimSpread;
		W->Spread.SpreadPerShot = S.SpreadPerShot;
		W->Recoil.VerticalKick = S.VerticalKick;
		W->Recoil.HorizontalKick = S.HorizontalKick;
		W->AimFOV = S.AimFOV;
		W->AimDownSightTime = S.AdsTime;
		return W;
	}

	using M = EFLFireMode;
	using C = EFLWeaponCategory;
	using SL = EFLWeaponSlot;
}

void FLDefaultContent::Register(UFLContentRegistry& Registry)
{
	UObject* Outer = &Registry;

	// Id, Name, Category, Slot, Modes, RPM, Mag, Reserve, Reload, EmptyReload,
	// MaxDmg, MinDmg, FalloffStart(m), FalloffEnd(m), HeadMult,
	// HipSpread, AimSpread, SpreadPerShot, VKick, HKick, AimFOV, AdsTime, [Pellets, PelletSpread, PerRound]
	const TArray<FWeaponSpec> Specs =
	{
		{ TEXT("AR_Carbine"),    TEXT("Carbine"),          C::AssaultRifle, SL::Primary,   { M::FullAuto, M::Burst, M::Single }, 750.f, 30, 120, 2.1f, 2.7f, 25.f, 18.f, 20.f,  60.f, 1.8f, 3.0f, 0.15f, 0.25f, 0.42f, 0.18f, 55.f, 0.25f },
		{ TEXT("SMG_Compact"),   TEXT("Compact SMG"),      C::SMG,          SL::Primary,   { M::FullAuto, M::Single },           900.f, 32, 160, 1.9f, 2.4f, 22.f, 12.f, 10.f,  35.f, 1.6f, 2.2f, 0.30f, 0.20f, 0.30f, 0.24f, 60.f, 0.18f },
		{ TEXT("DMR_Marksman"),  TEXT("Marksman Rifle"),   C::DMR,          SL::Primary,   { M::Single },                        300.f, 20,  80, 2.4f, 3.0f, 45.f, 35.f, 40.f, 100.f, 2.0f, 4.0f, 0.05f, 0.60f, 1.20f, 0.30f, 40.f, 0.30f },
		{ TEXT("SR_BoltAction"), TEXT("Bolt-Action Rifle"), C::SniperRifle, SL::Primary,   { M::Single },                         45.f,  5,  25, 3.0f, 3.6f, 95.f, 80.f, 100.f, 300.f, 2.5f, 6.0f, 0.00f, 0.00f, 3.00f, 0.50f, 20.f, 0.40f },
		{ TEXT("LMG_Belt"),      TEXT("Belt-Fed LMG"),     C::LMG,          SL::Primary,   { M::FullAuto },                      650.f, 100, 200, 4.5f, 5.5f, 24.f, 18.f, 30.f,  80.f, 1.7f, 4.0f, 0.30f, 0.20f, 0.40f, 0.30f, 55.f, 0.35f },
		{ TEXT("SG_Pump"),       TEXT("Pump Shotgun"),     C::Shotgun,      SL::Primary,   { M::Single },                         70.f,  6,  30, 0.55f, 0.55f, 12.f, 3.f,  8.f,  25.f, 1.3f, 4.0f, 3.00f, 0.00f, 2.50f, 0.40f, 65.f, 0.25f, 9, 3.5f, true },
		{ TEXT("PT_Sidearm"),    TEXT("Sidearm"),          C::Pistol,       SL::Secondary, { M::Single },                        400.f, 15,  45, 1.5f, 1.9f, 24.f, 14.f, 10.f,  30.f, 1.7f, 2.0f, 0.40f, 0.35f, 0.70f, 0.20f, 70.f, 0.15f },
	};

	for (const FWeaponSpec& Spec : Specs)
	{
		if (!Registry.FindWeapon(FName(Spec.Id)))
		{
			UFLWeaponData* W = MakeWeapon(Outer, Spec);
			if (Spec.Category == C::SniperRifle)
			{
				W->Damage.MaxRangeMeters = 1500.f;
				W->Recoil.FirstShotMultiplier = 1.f;
			}
			if (Spec.Category == C::LMG)
			{
				W->Spread.ProneMultiplier = 0.35f;
				W->Recoil.ProneMultiplier = 0.4f;
			}
			if (Spec.bPerRound)
			{
				W->PerRoundReloadTime = Spec.Reload;
			}
			Registry.AddWeapon(W);
		}
	}

	if (!Registry.FindEquipment(TEXT("Frag")))
	{
		UFLEquipmentData* Frag = NewObject<UFLEquipmentData>(Outer, TEXT("Frag"));
		Frag->EquipmentId = TEXT("Frag");
		Frag->DisplayName = FText::FromString(TEXT("Frag Grenade"));
		Registry.AddEquipment(Frag);
	}

	auto W = [&Registry](const TCHAR* Id) { return const_cast<UFLWeaponData*>(Registry.FindWeapon(FName(Id))); };
	UFLEquipmentData* FragData = const_cast<UFLEquipmentData*>(Registry.FindEquipment(TEXT("Frag")));

	auto MakeClass = [&](const TCHAR* Id, const TCHAR* Name, const TCHAR* Desc, int32 Order,
		TArray<UFLWeaponData*> Primaries, int32 Frags, TSubclassOf<UFLAbility> Ability,
		float ReviveTime, float ReviveFraction)
	{
		if (Registry.FindClass(FName(Id)))
		{
			return;
		}
		UFLClassDefinition* Def = NewObject<UFLClassDefinition>(Outer, FName(Id));
		Def->ClassId = FName(Id);
		Def->DisplayName = FText::FromString(Name);
		Def->Description = FText::FromString(Desc);
		Def->SortOrder = Order;
		for (UFLWeaponData* P : Primaries)
		{
			if (P) { Def->PrimaryWeaponOptions.Add(P); }
		}
		if (UFLWeaponData* Sidearm = W(TEXT("PT_Sidearm")))
		{
			Def->SecondaryWeaponOptions.Add(Sidearm);
		}
		if (FragData && Frags > 0)
		{
			FFLEquipmentLoadout Loadout;
			Loadout.Equipment = FragData;
			Loadout.Count = Frags;
			Def->Equipment.Add(Loadout);
		}
		if (Ability)
		{
			Def->Abilities.Add(Ability);
		}
		Def->ReviveTime = ReviveTime;
		Def->ReviveHealthFraction = ReviveFraction;
		Registry.AddClass(Def);
	};

	MakeClass(TEXT("Assault"), TEXT("Assault"), TEXT("Frontline rifleman. Extra grenades and a combat stim."), 0,
		{ W(TEXT("AR_Carbine")), W(TEXT("SG_Pump")) }, 2, UFLAbility_Stim::StaticClass(), 5.f, 0.3f);

	MakeClass(TEXT("Medic"), TEXT("Medic"), TEXT("Fast full-health revives and a healing pulse for nearby squadmates."), 1,
		{ W(TEXT("SMG_Compact")), W(TEXT("SG_Pump")) }, 1, UFLAbility_HealPulse::StaticClass(), 2.f, 1.f);

	MakeClass(TEXT("Support"), TEXT("Support"), TEXT("Suppressive fire and ammunition resupply for the squad."), 2,
		{ W(TEXT("LMG_Belt")), W(TEXT("AR_Carbine")) }, 1, UFLAbility_Resupply::StaticClass(), 5.f, 0.3f);

	MakeClass(TEXT("Recon"), TEXT("Recon"), TEXT("Long-range marksman who spots enemies for the team."), 3,
		{ W(TEXT("SR_BoltAction")), W(TEXT("DMR_Marksman")) }, 1, UFLAbility_Spot::StaticClass(), 5.f, 0.3f);
}
