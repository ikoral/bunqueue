/**
 * Compensation logic - runs compensate handlers in reverse order on failure
 */

import type { Execution } from './types';
import type { Workflow } from './workflow';
import type { WorkflowStore } from './store';
import type { WorkflowEmitter } from './emitter';
import { findStepDef, buildContext } from './runner';

/** Sentinel error thrown when execution must pause for a signal */
export class WaitForSignalError extends Error {
  constructor(readonly event: string) {
    super(`Waiting for signal: ${event}`);
  }
}

/** Run compensation handlers in reverse order for all completed steps */
export async function runCompensation(
  exec: Execution,
  wf: Workflow,
  store: WorkflowStore,
  emitter: WorkflowEmitter | null
): Promise<void> {
  const completed = Object.entries(exec.steps)
    .filter(([name, s]) => s.status === 'completed' && !name.startsWith('__'))
    .reverse();
  if (completed.length === 0) return;

  exec.state = 'compensating';
  store.update(exec);
  emitter?.emitWorkflow('workflow:compensating', exec.id, exec.workflowName, 'compensating');

  const ctx = buildContext(exec);
  for (const [name] of completed) {
    const def = findStepDef(wf, name);
    if (def?.compensate) {
      try {
        await def.compensate(ctx);
      } catch {
        // Compensation errors don't stop the chain
      }
    }
  }
  exec.state = 'failed';
  store.update(exec);
}
