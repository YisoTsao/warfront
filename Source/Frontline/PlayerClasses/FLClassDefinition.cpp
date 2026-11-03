#include "PlayerClasses/FLClassDefinition.h"

FPrimaryAssetId UFLClassDefinition::GetPrimaryAssetId() const
{
	return FPrimaryAssetId(TEXT("FLClass"), GetFName());
}
