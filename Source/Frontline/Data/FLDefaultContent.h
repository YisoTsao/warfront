#pragma once

#include "CoreMinimal.h"

class UFLContentRegistry;

/**
 * Built-in fallback content: one weapon per category, a frag grenade and the four
 * MVP classes. Tuned as a starting point; designers override any of them by
 * creating a data asset with the same id.
 */
namespace FLDefaultContent
{
	void Register(UFLContentRegistry& Registry);
}
