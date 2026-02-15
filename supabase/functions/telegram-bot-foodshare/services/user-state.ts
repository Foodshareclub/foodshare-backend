/**
 * Telegram Bot User State Service
 *
 * Thin wrapper around shared bot user state factory.
 * Uses user_id (number) as the identifier.
 */

import { createBotUserStateService } from "../../_shared/bot/user-state.ts";
import type { UserState } from "../types/index.ts";

const stateService = createBotUserStateService<UserState>({
  tableName: "telegram_user_states",
  idColumn: "user_id",
});

export function getUserState(userId: number): Promise<UserState | null> {
  return stateService.get(userId);
}

export function setUserState(userId: number, state: UserState | null): Promise<void> {
  return stateService.set(userId, state);
}

export function cleanupExpiredStates(): Promise<number> {
  return stateService.cleanup();
}
