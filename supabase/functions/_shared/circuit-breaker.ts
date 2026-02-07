/**
 * Unified Circuit Breaker Pattern
 *
 * Prevents cascading failures by temporarily disabling operations
 * when they fail repeatedly.
 *
 * States:
 * - CLOSED: Normal operation, requests allowed
 * - OPEN: Failures exceeded threshold, requests rejected
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  halfOpenAttempts: number;
  totalRequests: number;
  totalFailures: number;
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to close circuit (default: 60000) */
  resetTimeoutMs: number;
  /** Max attempts allowed in half-open state (default: 3) */
  halfOpenMaxAttempts: number;
  /** Successes needed to close circuit from half-open (default: 2) */
  successThreshold: number;
  /** Callback when state changes */
  onStateChange?: (
    service: string,
    from: CircuitState,
    to: CircuitState,
    state: CircuitBreakerState
  ) => void;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60000,
  halfOpenMaxAttempts: 3,
  successThreshold: 2,
};

const circuits = new Map<string, CircuitBreakerState>();
const configs = new Map<string, CircuitBreakerConfig>();

/**
 * Error thrown when circuit is open and request is rejected
 */
export class CircuitBreakerError extends Error {
  public readonly service: string;
  public readonly state: CircuitBreakerState;
  public readonly retryAfterMs: number;

  constructor(service: string, state: CircuitBreakerState, config: CircuitBreakerConfig) {
    const retryAfterMs = Math.max(
      0,
      config.resetTimeoutMs - (Date.now() - state.lastFailureTime)
    );
    super(`Circuit breaker is OPEN for ${service}. Retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitBreakerError";
    this.service = service;
    this.state = state;
    this.retryAfterMs = retryAfterMs;
  }
}

function getOrCreateCircuit(serviceName: string): CircuitBreakerState {
  let circuit = circuits.get(serviceName);
  if (!circuit) {
    circuit = {
      state: "closed",
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastSuccessTime: 0,
      halfOpenAttempts: 0,
      totalRequests: 0,
      totalFailures: 0,
    };
    circuits.set(serviceName, circuit);
  }
  return circuit;
}

function getConfig(serviceName: string): CircuitBreakerConfig {
  return configs.get(serviceName) || DEFAULT_CONFIG;
}

function transitionState(
  serviceName: string,
  circuit: CircuitBreakerState,
  newState: CircuitState,
  config: CircuitBreakerConfig
): void {
  if (circuit.state === newState) return;

  const oldState = circuit.state;
  circuit.state = newState;

  if (newState === "half-open") {
    circuit.halfOpenAttempts = 0;
    circuit.successes = 0;
  } else if (newState === "closed") {
    circuit.failures = 0;
    circuit.successes = 0;
  }

  config.onStateChange?.(serviceName, oldState, newState, circuit);
}

/**
 * Check if an operation can be attempted
 */
function canAttempt(serviceName: string): boolean {
  const circuit = getOrCreateCircuit(serviceName);
  const config = getConfig(serviceName);
  const now = Date.now();

  if (circuit.state === "closed") {
    return true;
  }

  if (circuit.state === "open") {
    if (now - circuit.lastFailureTime >= config.resetTimeoutMs) {
      transitionState(serviceName, circuit, "half-open", config);
      return true;
    }
    return false;
  }

  // half-open: allow limited attempts
  if (circuit.halfOpenAttempts < config.halfOpenMaxAttempts) {
    circuit.halfOpenAttempts++;
    return true;
  }

  return false;
}

/**
 * Record a successful operation
 */
function recordSuccess(serviceName: string): void {
  const circuit = getOrCreateCircuit(serviceName);
  const config = getConfig(serviceName);

  circuit.lastSuccessTime = Date.now();
  circuit.totalRequests++;

  if (circuit.state === "half-open") {
    circuit.successes++;
    if (circuit.successes >= config.successThreshold) {
      transitionState(serviceName, circuit, "closed", config);
    }
  } else if (circuit.state === "closed") {
    // Reset failure count on success in closed state
    circuit.failures = 0;
  }
}

/**
 * Record a failed operation
 */
function recordFailure(serviceName: string): void {
  const circuit = getOrCreateCircuit(serviceName);
  const config = getConfig(serviceName);

  circuit.failures++;
  circuit.totalFailures++;
  circuit.totalRequests++;
  circuit.lastFailureTime = Date.now();

  if (circuit.state === "half-open") {
    // Any failure in half-open immediately opens circuit
    transitionState(serviceName, circuit, "open", config);
  } else if (circuit.state === "closed" && circuit.failures >= config.failureThreshold) {
    transitionState(serviceName, circuit, "open", config);
  }
}

/**
 * Execute an operation with circuit breaker protection
 *
 * @example
 * ```typescript
 * const result = await withCircuitBreaker("email-provider", async () => {
 *   return await sendEmail(params);
 * }, { failureThreshold: 3 });
 * ```
 */
export async function withCircuitBreaker<T>(
  serviceName: string,
  operation: () => Promise<T>,
  options?: Partial<CircuitBreakerConfig>
): Promise<T> {
  // Merge options with defaults
  if (options) {
    const existingConfig = configs.get(serviceName);
    configs.set(serviceName, { ...DEFAULT_CONFIG, ...existingConfig, ...options });
  }

  const config = getConfig(serviceName);
  const circuit = getOrCreateCircuit(serviceName);

  if (!canAttempt(serviceName)) {
    throw new CircuitBreakerError(serviceName, circuit, config);
  }

  try {
    const result = await operation();
    recordSuccess(serviceName);
    return result;
  } catch (error) {
    recordFailure(serviceName);
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
 * Get all circuit breaker statuses
 */
export function getAllCircuitStatuses(): Record<string, CircuitBreakerState> {
  const result: Record<string, CircuitBreakerState> = {};
  circuits.forEach((state, name) => {
    result[name] = { ...state };
  });
  return result;
}

/**
 * Manually reset a circuit breaker to closed state
 */
export function resetCircuit(serviceName: string): void {
  const circuit = circuits.get(serviceName);
  if (circuit) {
    const config = getConfig(serviceName);
    transitionState(serviceName, circuit, "closed", config);
  } else {
    circuits.set(serviceName, {
      state: "closed",
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastSuccessTime: 0,
      halfOpenAttempts: 0,
      totalRequests: 0,
      totalFailures: 0,
    });
  }
}

/**
 * Configure a circuit breaker without executing an operation
 */
export function configureCircuit(
  serviceName: string,
  options: Partial<CircuitBreakerConfig>
): void {
  const existingConfig = configs.get(serviceName);
  configs.set(serviceName, { ...DEFAULT_CONFIG, ...existingConfig, ...options });
}

/**
 * Check if circuit is healthy (closed or half-open with attempts remaining)
 */
export function isCircuitHealthy(serviceName: string): boolean {
  const circuit = circuits.get(serviceName);
  if (!circuit) return true; // No circuit = healthy

  if (circuit.state === "closed") return true;
  if (circuit.state === "open") return false;

  // half-open
  const config = getConfig(serviceName);
  return circuit.halfOpenAttempts < config.halfOpenMaxAttempts;
}

/**
 * Get circuit breaker metrics for a service
 */
export function getCircuitMetrics(serviceName: string): {
  state: CircuitState;
  failureRate: number;
  totalRequests: number;
  totalFailures: number;
  isHealthy: boolean;
} | null {
  const circuit = circuits.get(serviceName);
  if (!circuit) return null;

  return {
    state: circuit.state,
    failureRate:
      circuit.totalRequests > 0
        ? Math.round((circuit.totalFailures / circuit.totalRequests) * 100)
        : 0,
    totalRequests: circuit.totalRequests,
    totalFailures: circuit.totalFailures,
    isHealthy: isCircuitHealthy(serviceName),
  };
}
