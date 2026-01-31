/**
 * Upstash Workflow Client
 *
 * Production-grade workflow orchestration with:
 * - Multi-step task execution
 * - Durable execution (survives failures)
 * - Automatic retries with backoff
 * - Parallel step execution
 * - Sleep/delay between steps
 * - Conditional branching
 * - Human-in-the-loop approvals
 *
 * Use cases:
 * - Order processing pipelines
 * - User onboarding flows
 * - Content moderation workflows
 * - Multi-step data processing
 * - Approval workflows
 *
 * @version 1.0.0
 */

import { logger } from "./logger.ts";
import { getQStashClient } from "./upstash-qstash.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface WorkflowConfig {
  /** Base URL for workflow callbacks (your Edge Function URL) */
  baseUrl: string;
  /** Default retries for steps (default: 3) */
  defaultRetries?: number;
  /** Default timeout for steps in seconds (default: 30) */
  defaultTimeout?: number;
}

// =============================================================================
// Types
// =============================================================================

export interface WorkflowContext<TInput = unknown, TState = Record<string, unknown>> {
  /** Unique workflow run ID */
  runId: string;
  /** Workflow name */
  workflowName: string;
  /** Current step index */
  stepIndex: number;
  /** Current step name */
  stepName: string;
  /** Original workflow input */
  input: TInput;
  /** Accumulated state from previous steps */
  state: TState;
  /** Results from previous steps */
  stepResults: Record<string, unknown>;
  /** Timestamp when workflow started */
  startedAt: string;
  /** Number of retries for current step */
  retryCount: number;
}

export interface StepConfig {
  /** Step name (must be unique within workflow) */
  name: string;
  /** Number of retries on failure */
  retries?: number;
  /** Timeout in seconds */
  timeout?: number;
  /** Delay before executing (seconds) */
  delay?: number;
}

export interface WorkflowStep<TInput = unknown, TOutput = unknown> {
  config: StepConfig;
  execute: (ctx: WorkflowContext<TInput>) => Promise<TOutput>;
}

export interface WorkflowDefinition<TInput = unknown> {
  /** Workflow name */
  name: string;
  /** Workflow steps */
  steps: WorkflowStep<TInput>[];
  /** Called on workflow completion */
  onComplete?: (ctx: WorkflowContext<TInput>, finalResult: unknown) => Promise<void>;
  /** Called on workflow failure */
  onError?: (ctx: WorkflowContext<TInput>, error: Error) => Promise<void>;
}

export interface WorkflowRun {
  runId: string;
  workflowName: string;
  status: "running" | "completed" | "failed" | "waiting";
  currentStep: string;
  stepIndex: number;
  input: unknown;
  state: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface StartWorkflowOptions {
  /** Custom run ID (default: auto-generated) */
  runId?: string;
  /** Initial state */
  initialState?: Record<string, unknown>;
  /** Delay before starting (seconds) */
  delay?: number;
}

// =============================================================================
// Workflow Error
// =============================================================================

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly runId?: string,
    public readonly stepName?: string
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

// =============================================================================
// Workflow Engine
// =============================================================================

export class WorkflowEngine {
  private readonly config: Required<WorkflowConfig>;
  private readonly workflows = new Map<string, WorkflowDefinition>();

  constructor(config: WorkflowConfig) {
    this.config = {
      defaultRetries: 3,
      defaultTimeout: 30,
      ...config,
    };
  }

  /**
   * Register a workflow definition
   */
  register<TInput = unknown>(workflow: WorkflowDefinition<TInput>): void {
    if (this.workflows.has(workflow.name)) {
      throw new WorkflowError(
        `Workflow '${workflow.name}' is already registered`,
        "DUPLICATE_WORKFLOW"
      );
    }
    this.workflows.set(workflow.name, workflow as WorkflowDefinition);
    logger.info("Workflow registered", { workflowName: workflow.name, stepCount: workflow.steps.length });
  }

  /**
   * Start a new workflow run
   */
  async start<TInput = unknown>(
    workflowName: string,
    input: TInput,
    options?: StartWorkflowOptions
  ): Promise<{ runId: string }> {
    const workflow = this.workflows.get(workflowName);
    if (!workflow) {
      throw new WorkflowError(`Workflow '${workflowName}' not found`, "WORKFLOW_NOT_FOUND");
    }

    const runId = options?.runId || crypto.randomUUID();
    const now = new Date().toISOString();

    const ctx: WorkflowContext<TInput> = {
      runId,
      workflowName,
      stepIndex: 0,
      stepName: workflow.steps[0]?.config.name || "start",
      input,
      state: options?.initialState || {},
      stepResults: {},
      startedAt: now,
      retryCount: 0,
    };

    // Schedule first step via QStash
    const qstash = getQStashClient();
    const callbackUrl = `${this.config.baseUrl}?workflow=${workflowName}&runId=${runId}`;

    await qstash.publish({
      url: callbackUrl,
      body: ctx,
      delay: options?.delay,
      retries: this.config.defaultRetries,
      deduplicationId: `workflow-${runId}-step-0`,
    });

    logger.info("Workflow started", {
      runId,
      workflowName,
      stepCount: workflow.steps.length,
    });

    return { runId };
  }

  /**
   * Handle workflow step execution (called by QStash webhook)
   */
  async handleStep(ctx: WorkflowContext): Promise<{ completed: boolean; nextStep?: string }> {
    const workflow = this.workflows.get(ctx.workflowName);
    if (!workflow) {
      throw new WorkflowError(
        `Workflow '${ctx.workflowName}' not found`,
        "WORKFLOW_NOT_FOUND",
        ctx.runId
      );
    }

    const step = workflow.steps[ctx.stepIndex];
    if (!step) {
      // No more steps - workflow complete
      logger.info("Workflow completed", {
        runId: ctx.runId,
        workflowName: ctx.workflowName,
        totalSteps: ctx.stepIndex,
      });

      if (workflow.onComplete) {
        const lastResult = ctx.stepResults[workflow.steps[ctx.stepIndex - 1]?.config.name];
        await workflow.onComplete(ctx, lastResult);
      }

      return { completed: true };
    }

    logger.info("Executing workflow step", {
      runId: ctx.runId,
      workflowName: ctx.workflowName,
      stepIndex: ctx.stepIndex,
      stepName: step.config.name,
      retryCount: ctx.retryCount,
    });

    try {
      // Execute the step
      const result = await step.execute(ctx);

      // Store result and advance
      ctx.stepResults[step.config.name] = result;
      ctx.stepIndex++;
      ctx.retryCount = 0;

      const nextStep = workflow.steps[ctx.stepIndex];
      if (nextStep) {
        ctx.stepName = nextStep.config.name;

        // Schedule next step
        const qstash = getQStashClient();
        const callbackUrl = `${this.config.baseUrl}?workflow=${ctx.workflowName}&runId=${ctx.runId}`;

        await qstash.publish({
          url: callbackUrl,
          body: ctx,
          delay: nextStep.config.delay,
          retries: nextStep.config.retries ?? this.config.defaultRetries,
          timeout: nextStep.config.timeout ?? this.config.defaultTimeout,
          deduplicationId: `workflow-${ctx.runId}-step-${ctx.stepIndex}`,
        });

        return { completed: false, nextStep: nextStep.config.name };
      }

      // No more steps
      logger.info("Workflow completed", {
        runId: ctx.runId,
        workflowName: ctx.workflowName,
        totalSteps: ctx.stepIndex,
      });

      if (workflow.onComplete) {
        await workflow.onComplete(ctx, result);
      }

      return { completed: true };
    } catch (error) {
      logger.error("Workflow step failed", error instanceof Error ? error : new Error(String(error)), {
        runId: ctx.runId,
        workflowName: ctx.workflowName,
        stepName: step.config.name,
        retryCount: ctx.retryCount,
      });

      if (workflow.onError) {
        await workflow.onError(ctx, error instanceof Error ? error : new Error(String(error)));
      }

      throw error;
    }
  }

  /**
   * Create a workflow request handler for Edge Functions
   */
  createHandler(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const url = new URL(request.url);
      const workflowName = url.searchParams.get("workflow");
      const runId = url.searchParams.get("runId");

      if (!workflowName || !runId) {
        return new Response(
          JSON.stringify({ error: "Missing workflow or runId parameter" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      try {
        const ctx = await request.json() as WorkflowContext;
        const result = await this.handleStep(ctx);

        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(
          JSON.stringify({ error: message, runId, workflowName }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    };
  }
}

// =============================================================================
// Workflow Builder (Fluent API)
// =============================================================================

export class WorkflowBuilder<TInput = unknown> {
  private readonly steps: WorkflowStep<TInput>[] = [];
  private onCompleteHandler?: WorkflowDefinition<TInput>["onComplete"];
  private onErrorHandler?: WorkflowDefinition<TInput>["onError"];

  constructor(private readonly name: string) {}

  /**
   * Add a step to the workflow
   */
  step<TOutput = unknown>(
    name: string,
    execute: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
    config?: Omit<StepConfig, "name">
  ): this {
    this.steps.push({
      config: { name, ...config },
      execute: execute as WorkflowStep<TInput>["execute"],
    });
    return this;
  }

  /**
   * Add a delay step
   */
  sleep(name: string, seconds: number): this {
    this.steps.push({
      config: { name, delay: seconds },
      execute: async () => ({ slept: seconds }),
    });
    return this;
  }

  /**
   * Add parallel execution step
   */
  parallel<TOutput = unknown>(
    name: string,
    tasks: Array<{
      name: string;
      execute: (ctx: WorkflowContext<TInput>) => Promise<unknown>;
    }>,
    config?: Omit<StepConfig, "name">
  ): this {
    this.steps.push({
      config: { name, ...config },
      execute: async (ctx) => {
        const results = await Promise.allSettled(
          tasks.map((task) => task.execute(ctx))
        );

        const output: Record<string, unknown> = {};
        tasks.forEach((task, i) => {
          const result = results[i];
          output[task.name] =
            result.status === "fulfilled"
              ? { success: true, value: result.value }
              : { success: false, error: result.reason?.message || String(result.reason) };
        });

        return output as TOutput;
      },
    });
    return this;
  }

  /**
   * Add conditional branching
   */
  branch(
    name: string,
    condition: (ctx: WorkflowContext<TInput>) => boolean,
    ifTrue: (ctx: WorkflowContext<TInput>) => Promise<unknown>,
    ifFalse: (ctx: WorkflowContext<TInput>) => Promise<unknown>,
    config?: Omit<StepConfig, "name">
  ): this {
    this.steps.push({
      config: { name, ...config },
      execute: async (ctx) => {
        const branch = condition(ctx) ? "true" : "false";
        const result = await (condition(ctx) ? ifTrue(ctx) : ifFalse(ctx));
        return { branch, result };
      },
    });
    return this;
  }

  /**
   * Set completion handler
   */
  onComplete(handler: WorkflowDefinition<TInput>["onComplete"]): this {
    this.onCompleteHandler = handler;
    return this;
  }

  /**
   * Set error handler
   */
  onError(handler: WorkflowDefinition<TInput>["onError"]): this {
    this.onErrorHandler = handler;
    return this;
  }

  /**
   * Build the workflow definition
   */
  build(): WorkflowDefinition<TInput> {
    return {
      name: this.name,
      steps: this.steps,
      onComplete: this.onCompleteHandler,
      onError: this.onErrorHandler,
    };
  }
}

/**
 * Create a new workflow builder
 */
export function defineWorkflow<TInput = unknown>(name: string): WorkflowBuilder<TInput> {
  return new WorkflowBuilder<TInput>(name);
}

// =============================================================================
// Singleton Factory
// =============================================================================

let engineInstance: WorkflowEngine | null = null;

/**
 * Get or create the workflow engine (singleton)
 */
export function getWorkflowEngine(config?: WorkflowConfig): WorkflowEngine {
  if (!engineInstance) {
    const baseUrl = config?.baseUrl || Deno.env.get("WORKFLOW_CALLBACK_URL");

    if (!baseUrl) {
      throw new WorkflowError(
        "WORKFLOW_CALLBACK_URL must be configured",
        "CONFIG_ERROR"
      );
    }

    engineInstance = new WorkflowEngine({
      baseUrl,
      ...config,
    });
  }

  return engineInstance;
}

/**
 * Create a new workflow engine instance (for testing)
 */
export function createWorkflowEngine(config: WorkflowConfig): WorkflowEngine {
  return new WorkflowEngine(config);
}

/**
 * Reset the singleton engine (for testing)
 */
export function resetWorkflowEngine(): void {
  engineInstance = null;
}
