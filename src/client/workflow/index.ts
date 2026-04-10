/**
 * bunqueue Workflow Engine
 *
 * Lightweight workflow orchestration built on top of bunqueue.
 *
 * @example
 * ```typescript
 * import { Workflow, Engine } from 'bunqueue/workflow';
 *
 * const flow = new Workflow('onboarding')
 *   .step('create', async (ctx) => { ... })
 *   .step('notify', async (ctx) => { ... });
 *
 * const engine = new Engine({ embedded: true });
 * engine.register(flow);
 * const run = await engine.start('onboarding', { email: 'user@test.com' });
 * ```
 */

export { Workflow } from './workflow';
export { Engine } from './engine';
export { WorkflowEmitter } from './emitter';
export type {
  StepContext,
  StepHandler,
  CompensateHandler,
  StepOptions,
  Execution,
  ExecutionState,
  StepState,
  StepRecord,
  EngineOptions,
  RunHandle,
  ParallelDefinition,
  SubWorkflowInputMapper,
  CleanupOptions,
  WorkflowEventType,
  WorkflowEvent,
  StepEvent,
  WorkflowLifecycleEvent,
  SignalEvent,
  WorkflowEventListener,
} from './types';
