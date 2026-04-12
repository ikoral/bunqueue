/**
 * WorkflowRunner - Step execution with retry, parallel execution, sub-workflow dispatch
 */

import type { StepDefinition, StepContext, Execution } from './types';
import type { Workflow } from './workflow';
import type { WorkflowEmitter } from './emitter';

/** Exponential backoff with jitter */
function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const delay = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  const jitter = delay * 0.5 * Math.random();
  return delay + jitter;
}

/** Run a promise with a timeout */
export function runWithTimeout<T>(promise: Promise<T> | T, timeoutMs: number): Promise<T> {
  if (!(promise instanceof Promise)) return Promise.resolve(promise);
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Step timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/** Execute a step with retry logic and exponential backoff */
export async function executeStepWithRetry(
  def: StepDefinition,
  ctx: StepContext,
  exec: Execution,
  emitter: WorkflowEmitter | null,
  updateFn: (exec: Execution) => void
): Promise<void> {
  const maxAttempts = def.retry;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prev = exec.steps[def.name] as { startedAt?: number } | undefined;
    exec.steps[def.name] = {
      status: 'running',
      startedAt: prev?.startedAt ?? Date.now(),
      attempts: attempt,
    };
    updateFn(exec);
    emitter?.emitStep('step:started', exec.id, exec.workflowName, def.name, {
      attempt,
      maxAttempts,
    });

    try {
      if (def.inputSchema) {
        try {
          def.inputSchema.parse(ctx.input);
        } catch (e) {
          throw new Error(
            `Input validation failed for "${def.name}": ${e instanceof Error ? e.message : String(e)}`,
            { cause: e }
          );
        }
      }
      const result = await runWithTimeout(def.handler(ctx), def.timeout);
      if (def.outputSchema) {
        try {
          def.outputSchema.parse(result);
        } catch (e) {
          throw new Error(
            `Output validation failed for "${def.name}": ${e instanceof Error ? e.message : String(e)}`,
            { cause: e }
          );
        }
      }
      exec.steps[def.name] = {
        status: 'completed',
        result,
        startedAt: exec.steps[def.name].startedAt,
        completedAt: Date.now(),
        attempts: attempt,
      };
      updateFn(exec);
      emitter?.emitStep('step:completed', exec.id, exec.workflowName, def.name, {
        result,
        attempt,
        maxAttempts,
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        emitter?.emitStep('step:retry', exec.id, exec.workflowName, def.name, {
          error: lastError.message,
          attempt,
          maxAttempts,
        });
        await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
        continue;
      }
    }
  }

  const finalError = lastError ?? new Error('Step failed');
  exec.steps[def.name] = {
    status: 'failed',
    error: String(finalError),
    startedAt: exec.steps[def.name].startedAt,
    completedAt: Date.now(),
    attempts: maxAttempts,
  };
  updateFn(exec);
  emitter?.emitStep('step:failed', exec.id, exec.workflowName, def.name, {
    error: String(finalError),
    attempt: maxAttempts,
    maxAttempts,
  });
  throw finalError;
}

/** Execute multiple steps in parallel via Promise.allSettled */
export async function executeParallelSteps(
  steps: StepDefinition[],
  ctx: StepContext,
  exec: Execution,
  emitter: WorkflowEmitter | null,
  updateFn: (exec: Execution) => void
): Promise<void> {
  const results = await Promise.allSettled(
    steps.map((def) => executeStepWithRetry(def, ctx, exec, emitter, updateFn))
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    const errors = failed.map((r) =>
      r.reason instanceof Error ? r.reason : new Error(String(r.reason))
    );
    throw new AggregateError(errors, errors[0].message);
  }
}

/** Execute a sub-workflow by starting it and polling for completion */
export async function executeSubWorkflow(
  workflowName: string,
  input: unknown,
  startFn: (name: string, input: unknown) => Promise<{ id: string }>,
  getFn: (id: string) => Execution | null,
  pollIntervalMs = 100
): Promise<Record<string, unknown>> {
  const handle = await startFn(workflowName, input);
  const maxWait = 300_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const subExec = getFn(handle.id);
    if (subExec?.state === 'completed') {
      const results: Record<string, unknown> = {};
      for (const [name, record] of Object.entries(subExec.steps)) {
        if (record.status === 'completed') results[name] = record.result;
      }
      return results;
    }
    if (subExec?.state === 'failed') {
      throw new Error(`Sub-workflow "${workflowName}" (${handle.id}) failed`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Sub-workflow "${workflowName}" (${handle.id}) timed out`);
}

/** Find a step definition by name across all node types */
export function findStepDef(wf: Workflow, name: string): StepDefinition | null {
  for (const node of wf.nodes) {
    if (node.type === 'step' && node.def.name === name) return node.def;
    if (node.type === 'branch') {
      for (const steps of node.def.paths.values()) {
        const found = steps.find((s) => s.name === name);
        if (found) return found;
      }
    }
    if (node.type === 'parallel') {
      const found = node.def.steps.find((s) => s.name === name);
      if (found) return found;
    }
    if (node.type === 'doUntil' || node.type === 'doWhile') {
      const found = node.def.steps.find((s) => s.name === name);
      if (found) return found;
    }
    if (node.type === 'forEach') {
      if (node.def.step.name === name || name.startsWith(node.def.step.name + ':')) {
        return node.def.step;
      }
    }
  }
  return null;
}

/** Build a StepContext from the current execution state */
export function buildContext(exec: Execution): StepContext {
  const stepResults: Record<string, unknown> = {};
  for (const [name, record] of Object.entries(exec.steps)) {
    if (record.status === 'completed') stepResults[name] = record.result;
  }
  return {
    input: exec.input,
    steps: stepResults,
    signals: exec.signals,
    executionId: exec.id,
  };
}
