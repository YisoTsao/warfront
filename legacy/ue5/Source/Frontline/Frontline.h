#pragma once

#include "CoreMinimal.h"

DECLARE_LOG_CATEGORY_EXTERN(LogFrontline, Log, All);

/** Custom trace channel used by all hitscan weapons (see Config/DefaultEngine.ini). */
#define ECC_FLWeapon ECC_GameTraceChannel1
