#include "Equipment/FLEquipmentData.h"

FPrimaryAssetId UFLEquipmentData::GetPrimaryAssetId() const
{
	return FPrimaryAssetId(TEXT("FLEquipment"), GetFName());
}
