#include "Player/FLInputConfig.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputTriggers.h"

namespace
{
	UInputAction* MakeAction(UObject* Outer, const TCHAR* Name, EInputActionValueType Type = EInputActionValueType::Boolean)
	{
		UInputAction* Action = NewObject<UInputAction>(Outer, FName(Name));
		Action->ValueType = Type;
		return Action;
	}

	FEnhancedActionKeyMapping& Map(UInputMappingContext* Ctx, UInputAction* Action, FKey Key)
	{
		return Ctx->MapKey(Action, Key);
	}

	void AddSwizzle(UInputMappingContext* Ctx, FEnhancedActionKeyMapping& Mapping)
	{
		UInputModifierSwizzleAxis* Swizzle = NewObject<UInputModifierSwizzleAxis>(Ctx);
		Swizzle->Order = EInputAxisSwizzle::YXZ;
		Mapping.Modifiers.Add(Swizzle);
	}

	void AddNegate(UInputMappingContext* Ctx, FEnhancedActionKeyMapping& Mapping, bool bX = true, bool bY = true)
	{
		UInputModifierNegate* Negate = NewObject<UInputModifierNegate>(Ctx);
		Negate->bX = bX;
		Negate->bY = bY;
		Negate->bZ = false;
		Mapping.Modifiers.Add(Negate);
	}
}

UFLInputConfig* UFLInputConfig::CreateDefault(UObject* Outer)
{
	UFLInputConfig* Config = NewObject<UFLInputConfig>(Outer, TEXT("FLDefaultInputConfig"));
	UInputMappingContext* Ctx = NewObject<UInputMappingContext>(Config, TEXT("IMC_FLDefault"));
	Config->MappingContext = Ctx;

	Config->Move = MakeAction(Config, TEXT("IA_Move"), EInputActionValueType::Axis2D);
	Config->Look = MakeAction(Config, TEXT("IA_Look"), EInputActionValueType::Axis2D);
	Config->Jump = MakeAction(Config, TEXT("IA_Jump"));
	Config->Sprint = MakeAction(Config, TEXT("IA_Sprint"));
	Config->Crouch = MakeAction(Config, TEXT("IA_Crouch"));
	Config->Prone = MakeAction(Config, TEXT("IA_Prone"));
	Config->Fire = MakeAction(Config, TEXT("IA_Fire"));
	Config->Aim = MakeAction(Config, TEXT("IA_Aim"));
	Config->Reload = MakeAction(Config, TEXT("IA_Reload"));
	Config->NextWeapon = MakeAction(Config, TEXT("IA_NextWeapon"));
	Config->PrevWeapon = MakeAction(Config, TEXT("IA_PrevWeapon"));
	Config->PrimaryWeapon = MakeAction(Config, TEXT("IA_PrimaryWeapon"));
	Config->SecondaryWeapon = MakeAction(Config, TEXT("IA_SecondaryWeapon"));
	Config->FireMode = MakeAction(Config, TEXT("IA_FireMode"));
	Config->Throw = MakeAction(Config, TEXT("IA_Throw"));
	Config->Ability = MakeAction(Config, TEXT("IA_Ability"));
	Config->Interact = MakeAction(Config, TEXT("IA_Interact"));
	Config->GiveUp = MakeAction(Config, TEXT("IA_GiveUp"));

	// ---- Keyboard & mouse ----
	// Move: W/S on Y, D/A on X.
	AddSwizzle(Ctx, Map(Ctx, Config->Move, EKeys::W));
	{
		FEnhancedActionKeyMapping& S = Map(Ctx, Config->Move, EKeys::S);
		AddSwizzle(Ctx, S);
		AddNegate(Ctx, S);
	}
	Map(Ctx, Config->Move, EKeys::D);
	AddNegate(Ctx, Map(Ctx, Config->Move, EKeys::A));

	// Look: mouse Y is negated so that AddControllerPitchInput (legacy -2.5 scale) looks up on mouse up.
	AddNegate(Ctx, Map(Ctx, Config->Look, EKeys::Mouse2D), false, true);

	Map(Ctx, Config->Jump, EKeys::SpaceBar);
	Map(Ctx, Config->Sprint, EKeys::LeftShift);
	Map(Ctx, Config->Crouch, EKeys::C);
	Map(Ctx, Config->Crouch, EKeys::LeftControl);
	Map(Ctx, Config->Prone, EKeys::Z);
	Map(Ctx, Config->Fire, EKeys::LeftMouseButton);
	Map(Ctx, Config->Aim, EKeys::RightMouseButton);
	Map(Ctx, Config->Reload, EKeys::R);
	Map(Ctx, Config->NextWeapon, EKeys::MouseScrollDown);
	Map(Ctx, Config->PrevWeapon, EKeys::MouseScrollUp);
	Map(Ctx, Config->PrimaryWeapon, EKeys::One);
	Map(Ctx, Config->SecondaryWeapon, EKeys::Two);
	Map(Ctx, Config->FireMode, EKeys::B);
	Map(Ctx, Config->Throw, EKeys::G);
	Map(Ctx, Config->Ability, EKeys::Q);
	Map(Ctx, Config->Interact, EKeys::E);
	{
		FEnhancedActionKeyMapping& GiveUp = Map(Ctx, Config->GiveUp, EKeys::X);
		UInputTriggerHold* Hold = NewObject<UInputTriggerHold>(Ctx);
		Hold->HoldTimeThreshold = 1.0f;
		Hold->bIsOneShot = true;
		GiveUp.Triggers.Add(Hold);
	}

	// ---- Gamepad (reserved: basic layout, tune later) ----
	{
		FEnhancedActionKeyMapping& Stick = Map(Ctx, Config->Move, EKeys::Gamepad_Left2D);
		Stick.Modifiers.Add(NewObject<UInputModifierDeadZone>(Ctx));
	}
	{
		FEnhancedActionKeyMapping& Stick = Map(Ctx, Config->Look, EKeys::Gamepad_Right2D);
		Stick.Modifiers.Add(NewObject<UInputModifierDeadZone>(Ctx));
		AddNegate(Ctx, Stick, false, true);
		UInputModifierScalar* Scale = NewObject<UInputModifierScalar>(Ctx);
		Scale->Scalar = FVector(2.5, 2.5, 1.0);
		Stick.Modifiers.Add(Scale);
	}
	Map(Ctx, Config->Jump, EKeys::Gamepad_FaceButton_Bottom);
	Map(Ctx, Config->Crouch, EKeys::Gamepad_FaceButton_Right);
	Map(Ctx, Config->Reload, EKeys::Gamepad_FaceButton_Left);
	Map(Ctx, Config->NextWeapon, EKeys::Gamepad_FaceButton_Top);
	Map(Ctx, Config->Sprint, EKeys::Gamepad_LeftThumbstick);
	Map(Ctx, Config->Fire, EKeys::Gamepad_RightTrigger);
	Map(Ctx, Config->Aim, EKeys::Gamepad_LeftTrigger);
	Map(Ctx, Config->Throw, EKeys::Gamepad_RightShoulder);
	Map(Ctx, Config->Ability, EKeys::Gamepad_LeftShoulder);
	Map(Ctx, Config->Interact, EKeys::Gamepad_DPad_Up);
	Map(Ctx, Config->FireMode, EKeys::Gamepad_DPad_Left);

	return Config;
}
