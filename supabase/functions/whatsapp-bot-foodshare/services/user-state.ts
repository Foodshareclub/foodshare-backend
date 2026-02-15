/**
 * WhatsApp Bot User State Service
 *
 * Thin wrapper around shared bot user state factory.
 * Uses phone_number (string) as the identifier.
 */

import { createBotUserStateService } from "../../_shared/bot/user-state.ts";
import type { UserState } from "../types/index.ts";

const stateService = createBotUserStateService<UserState>({
  tableName: "whatsapp_user_states",
  idColumn: "phone_number",
});

export function getUserState(phoneNumber: string): Promise<UserState | null> {
  return stateService.get(phoneNumber);
}

export function setUserState(phoneNumber: string, state: UserState | null): Promise<void> {
  return stateService.set(phoneNumber, state);
}

export function cleanupExpiredStates(): Promise<number> {
  return stateService.cleanup();
}
