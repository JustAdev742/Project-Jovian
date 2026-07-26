#pragma once

#include "structs.h"

namespace Interaction
{
	bool ServerAttemptInteract(UObject* cController, UFunction* Function, void* Parameters);
	bool ServerOnExitVehicle(UObject* Pawn, UFunction*, void*);
}