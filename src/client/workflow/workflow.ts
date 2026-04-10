/**
 * Workflow - DSL builder for defining workflow step graphs
 * Pure data structure, no side effects.
 */

import type {
  WorkflowNode,
  StepHandler,
  CompensateHandler,
  StepOptions,
  StepDefinition,
  StepContext,
  BranchCondition,
  SubWorkflowInputMapper,
} from './types';

export class Workflow<TInput = unknown> {
  readonly name: string;
  readonly nodes: WorkflowNode[] = [];

  constructor(name: string) {
    this.name = name;
  }

  /** Add a step to the workflow */
  step(name: string, handler: StepHandler<TInput>, options?: StepOptions<TInput>): this {
    this.nodes.push({
      type: 'step',
      def: {
        name,
        handler: handler as StepHandler,
        compensate: options?.compensate as CompensateHandler | undefined,
        retry: options?.retry ?? 3,
        timeout: options?.timeout ?? 30_000,
      },
    });
    return this;
  }

  /** Add a branch point — call .path() after this to define paths */
  branch(condition: BranchCondition): this {
    this.nodes.push({
      type: 'branch',
      def: { condition, paths: new Map() },
    });
    return this;
  }

  /** Define a branch path (must follow a .branch() call) */
  path(name: string, builder: (w: Workflow<TInput>) => Workflow<TInput>): this {
    const lastNode = this.nodes[this.nodes.length - 1] as WorkflowNode | undefined;
    if (lastNode?.type !== 'branch') {
      throw new Error('path() must follow a branch() call');
    }
    const sub = new Workflow<TInput>(`${this.name}:${name}`);
    builder(sub);
    const steps: StepDefinition[] = sub.nodes
      .filter((n): n is { type: 'step'; def: StepDefinition } => n.type === 'step')
      .map((n) => n.def);
    lastNode.def.paths.set(name, steps);
    return this;
  }

  /** Run multiple steps in parallel */
  parallel(builder: (w: Workflow<TInput>) => Workflow<TInput>): this {
    const sub = new Workflow<TInput>(`${this.name}:parallel`);
    builder(sub);
    const steps: StepDefinition[] = sub.nodes
      .filter((n): n is { type: 'step'; def: StepDefinition } => n.type === 'step')
      .map((n) => n.def);
    if (steps.length === 0) {
      throw new Error('parallel() requires at least one step');
    }
    this.nodes.push({ type: 'parallel', def: { steps } });
    return this;
  }

  /** Call another registered workflow as a step */
  subWorkflow(name: string, inputMapper: (ctx: StepContext<TInput>) => unknown): this {
    this.nodes.push({
      type: 'subWorkflow',
      name,
      inputMapper: inputMapper as SubWorkflowInputMapper,
    });
    return this;
  }

  /** Wait for an external signal before continuing */
  waitFor(event: string, options?: { timeout?: number }): this {
    this.nodes.push({
      type: 'waitFor',
      event,
      timeout: options?.timeout,
    });
    return this;
  }

  /** Get flat list of step names for validation */
  getStepNames(): string[] {
    const names: string[] = [];
    for (const node of this.nodes) {
      if (node.type === 'step') {
        names.push(node.def.name);
      } else if (node.type === 'branch') {
        for (const steps of node.def.paths.values()) {
          for (const s of steps) names.push(s.name);
        }
      } else if (node.type === 'parallel') {
        for (const s of node.def.steps) names.push(s.name);
      } else if (node.type === 'subWorkflow') {
        names.push(`sub:${node.name}`);
      }
    }
    return names;
  }
}
