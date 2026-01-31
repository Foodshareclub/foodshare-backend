/**
 * Health Module - Alert State Manager
 *
 * Manages alert deduplication state to prevent Telegram spam.
 * Uses in-memory state that persists within function instance lifetime.
 */

import { AlertState, ALERT_COOLDOWN_MS } from "../types.ts";

// =============================================================================
// Alert State Manager
// =============================================================================

export class AlertStateManager {
  private state: Map<string, AlertState>;

  constructor() {
    this.state = new Map();
  }

  /**
   * Check if we should send an alert for a function
   * @param functionName - Name of the function
   * @param isRecovery - Whether this is a recovery notification
   * @returns true if alert should be sent
   */
  shouldSendAlert(functionName: string, isRecovery: boolean): boolean {
    const now = Date.now();
    const existing = this.state.get(functionName);

    if (isRecovery) {
      // Always notify recovery if we previously alerted
      if (existing && existing.consecutiveFailures > 0) {
        this.state.set(functionName, { lastAlertTime: now, consecutiveFailures: 0 });
        return true;
      }
      return false;
    }

    // New failure or continued failure
    if (!existing) {
      this.state.set(functionName, { lastAlertTime: now, consecutiveFailures: 1 });
      return true; // First failure, alert immediately
    }

    existing.consecutiveFailures++;

    // Check cooldown
    if (now - existing.lastAlertTime < ALERT_COOLDOWN_MS) {
      // Only escalate if consecutive failures increase significantly
      if (existing.consecutiveFailures % 5 === 0) {
        existing.lastAlertTime = now;
        return true; // Escalation alert
      }
      return false; // Still in cooldown
    }

    existing.lastAlertTime = now;
    return true;
  }

  /**
   * Record a failure for a function
   */
  recordFailure(functionName: string): void {
    const now = Date.now();
    const existing = this.state.get(functionName);

    if (existing) {
      existing.consecutiveFailures++;
      existing.lastAlertTime = now;
    } else {
      this.state.set(functionName, { lastAlertTime: now, consecutiveFailures: 1 });
    }
  }

  /**
   * Record a recovery for a function
   */
  recordRecovery(functionName: string): void {
    const existing = this.state.get(functionName);
    if (existing) {
      existing.consecutiveFailures = 0;
    }
  }

  /**
   * Check if any function was previously in failure state
   */
  hasAnyFailures(): boolean {
    for (const [_, state] of this.state) {
      if (state.consecutiveFailures > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all alert state
   */
  clear(): void {
    this.state.clear();
  }

  /**
   * Get current state (for debugging/testing)
   */
  getState(): Map<string, AlertState> {
    return new Map(this.state);
  }

  /**
   * Get failure count for a specific function
   */
  getFailureCount(functionName: string): number {
    return this.state.get(functionName)?.consecutiveFailures ?? 0;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let instance: AlertStateManager | null = null;

/**
 * Get the alert state manager singleton
 */
export function getAlertStateManager(): AlertStateManager {
  if (!instance) {
    instance = new AlertStateManager();
  }
  return instance;
}

/**
 * Reset the alert state manager (for testing)
 */
export function resetAlertStateManager(): void {
  instance = null;
}
