using UnrealBuildTool;

// Dedicated server target. Building it requires a source build of Unreal Engine
// (the Epic Games Launcher build does not ship server binaries).
public class FrontlineServerTarget : TargetRules
{
	public FrontlineServerTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Server;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("Frontline");
	}
}
