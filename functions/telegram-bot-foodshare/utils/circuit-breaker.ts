/**
 * Circuit Breaker pattern to prevent cascading failures
 */

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
}

const circuits = new Map<string, CircuitBreakerState>();

export class CircuitBreakerError extends Error {
  constructor(service: string) {
    super(`Circuit breaker is OPEN for ${service}`);
    this.name = "CircuitBreakerError";
  }
}

export async function withCircuitBreaker<T>(
  serviceName: string,
  operation: () => Promise<T>,
  options: {
    failureThreshold?: number;
    resetTimeout?: number;
    halfOpenAttempts?: number;
  } = {}
): Promise<T> {
  const { failureThreshold = 5, resetTimeout = 60000, halfOpenAttempts = 1 } = options;

  let circuit = circuits.get(serviceName);

  if (!circuit) {
    circuit = { failures: 0, lastFailureTime: 0, state: "CLOSED" };
    circuits.set(serviceName, circuit);
  }

  const now = Date.now();

  // Check if we should transition from OPEN to HALF_OPEN
  if (circuit.state === "OPEN" && now - circuit.lastFailureTime > resetTimeout) {
    console.log(`Circuit breaker for ${serviceName}: OPEN → HALF_OPEN`);
    circuit.state = "HALF_OPEN";
    circuit.failures = 0;
  }

  // Reject immediately if circuit is OPEN
  if (circuit.state === "OPEN") {
    console.warn(`Circuit breaker OPEN for ${serviceName}, rejecting request`);
    throw new CircuitBreakerError(serviceName);
  }

  try {
    const result = await operation();

    // Success - reset circuit if it was HALF_OPEN
    if (circuit.state === "HALF_OPEN") {
      console.log(`Circuit breaker for ${serviceName}: HALF_OPEN → CLOSED`);
      circuit.state = "CLOSED";
      circuit.failures = 0;
    }

    return result;
  } catch (error) {
    circuit.failures++;
    circuit.lastFailureTime = now;

    console.error(
      `Circuit breaker for ${serviceName}: failure ${circuit.failures}/${failureThreshold}`
    );

    // Open circuit if threshold reached
    if (circuit.failures >= failureThreshold) {
      console.error(`Circuit breaker for ${serviceName}: CLOSED → OPEN`);
      circuit.state = "OPEN";
    }

    throw error;
  }
}

/**
 * Get circuit breaker status for monitoring
 */
export function getCircuitStatus(serviceName: string): CircuitBreakerState | null {
  return circuits.get(serviceName) || null;
}

/**
 * Manually reset a circuit breaker
 */
export function resetCircuit(serviceName: string): void {
  circuits.set(serviceName, { failures: 0, lastFailureTime: 0, state: "CLOSED" });
  console.log(`Circuit breaker for ${serviceName} manually reset`);
}
