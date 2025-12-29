/**
 * Circuit Breaker Pattern for service resilience
 */

import { CONFIG } from "./config.ts";
import { log } from "./logger.ts";

export type CircuitState = "closed" | "open" | "half-open";

interface ServiceCircuit {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
}

// In-memory state (resets on cold start)
export const circuits: Record<string, ServiceCircuit> = {
  tinypng: { state: "closed", failures: 0, lastFailureTime: 0, halfOpenAttempts: 0 },
  cloudinary: { state: "closed", failures: 0, lastFailureTime: 0, halfOpenAttempts: 0 },
};

export function getCircuitState(service: string): CircuitState {
  const circuit = circuits[service];
  if (!circuit) return "closed";

  if (circuit.state === "open") {
    const timeSinceFailure = Date.now() - circuit.lastFailureTime;
    if (timeSinceFailure >= CONFIG.circuitBreaker.resetTimeoutMs) {
      circuit.state = "half-open";
      circuit.halfOpenAttempts = 0;
      log("info", "Circuit breaker state change", {
        service,
        from: "open",
        to: "half-open",
        reason: "timeout_elapsed",
      });
    }
  }
  return circuit.state;
}

export function recordSuccess(service: string): void {
  const circuit = circuits[service];
  if (!circuit) return;

  const previousState = circuit.state;
  circuit.state = "closed";
  circuit.failures = 0;
  circuit.halfOpenAttempts = 0;

  if (previousState === "half-open") {
    log("info", "Circuit breaker recovered", {
      service,
      from: "half-open",
      to: "closed",
    });
  }
}

export function recordFailure(service: string): void {
  const circuit = circuits[service];
  if (!circuit) return;

  circuit.failures++;
  circuit.lastFailureTime = Date.now();

  if (circuit.state === "half-open") {
    circuit.state = "open";
    log("warn", "Circuit breaker reopened", {
      service,
      from: "half-open",
      to: "open",
      failures: circuit.failures,
    });
  } else if (circuit.failures >= CONFIG.circuitBreaker.failureThreshold) {
    circuit.state = "open";
    log("warn", "Circuit breaker opened", {
      service,
      from: "closed",
      to: "open",
      failures: circuit.failures,
    });
  }
}

export function canAttempt(service: string): boolean {
  const state = getCircuitState(service);
  if (state === "closed") return true;
  if (state === "open") return false;
  // half-open: allow limited attempts
  const circuit = circuits[service];
  if (circuit.halfOpenAttempts < CONFIG.circuitBreaker.halfOpenMaxAttempts) {
    circuit.halfOpenAttempts++;
    return true;
  }
  return false;
}
