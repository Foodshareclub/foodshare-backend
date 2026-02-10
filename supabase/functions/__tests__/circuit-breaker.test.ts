/**
 * Circuit Breaker Tests
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CircuitBreakerError,
  getCircuitStatus,
  resetCircuit,
  withCircuitBreaker,
} from "../_shared/circuit-breaker.ts";

Deno.test("Circuit Breaker - Successful operation", async () => {
  const result = await withCircuitBreaker("test-service-1", async () => {
    return "success";
  });

  assertEquals(result, "success");

  const status = getCircuitStatus("test-service-1");
  assertEquals(status?.state, "closed");
  assertEquals(status?.failures, 0);
});

Deno.test("Circuit Breaker - Opens after threshold failures", async () => {
  const serviceName = "test-service-2";

  // Trigger failures
  for (let i = 0; i < 5; i++) {
    try {
      await withCircuitBreaker(serviceName, async () => {
        throw new Error("Service unavailable");
      }, { failureThreshold: 5 });
    } catch {
      // Expected
    }
  }

  const status = getCircuitStatus(serviceName);
  assertEquals(status?.state, "open");

  // Next request should be rejected immediately
  await assertRejects(
    async () => {
      await withCircuitBreaker(serviceName, async () => "success");
    },
    CircuitBreakerError,
  );
});

Deno.test("Circuit Breaker - Transitions to half-open after timeout", async () => {
  const serviceName = "test-service-3";

  // Open the circuit
  for (let i = 0; i < 3; i++) {
    try {
      await withCircuitBreaker(serviceName, async () => {
        throw new Error("Fail");
      }, { failureThreshold: 3, resetTimeoutMs: 100 });
    } catch {
      // Expected
    }
  }

  assertEquals(getCircuitStatus(serviceName)?.state, "open");

  // Wait for reset timeout
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Should allow one attempt (half-open)
  const result = await withCircuitBreaker(serviceName, async () => "recovered");
  assertEquals(result, "recovered");

  // Should be closed now
  assertEquals(getCircuitStatus(serviceName)?.state, "closed");
});

Deno.test("Circuit Breaker - Manual reset", async () => {
  const serviceName = "test-service-4";

  // Open the circuit
  for (let i = 0; i < 3; i++) {
    try {
      await withCircuitBreaker(serviceName, async () => {
        throw new Error("Fail");
      }, { failureThreshold: 3 });
    } catch {
      // Expected
    }
  }

  assertEquals(getCircuitStatus(serviceName)?.state, "open");

  // Manual reset
  resetCircuit(serviceName);
  assertEquals(getCircuitStatus(serviceName)?.state, "closed");

  // Should work now
  const result = await withCircuitBreaker(serviceName, async () => "success");
  assertEquals(result, "success");
});
