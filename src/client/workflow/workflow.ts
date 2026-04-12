/**
 * Workflow - DSL builder for defining workflow step graphs
 * Pure data structure, no side effects.
 *
 * Supports type-safe step chaining: each .step() narrows the return type
 * so subsequent steps can access previous results without casting.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
// Type erasure via `any` is required for the generic accumulator pattern.
// Each builder method narrows the return type but stores handlers in type-erased form.

import type {
  WorkflowNode,
  StepHandler,
  CompensateHandler,
  StepOptions,
  StepDefinition,
  StepContext,
  BranchCondition,
  SubWorkflowInputMapper,
  LoopCondition,
  ForEachItemsExtractor,
  MapTransformFn,
  TypedStepHandler,
} from './types';

export class Workflow<
  TInput = unknown,
  TSteps extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  readonly nodes: WorkflowNode[] = [];

  constructor(name: string) {
    this.name = name;
  }

  /** Add a step to the workflow — return type accumulates into TSteps */
  step<TName extends string, TResult>(
    name: TName,
    handler: TypedStepHandler<TInput, TSteps, TResult>,
    options?: StepOptions<TInput, TSteps>
  ): Workflow<TInput, TSteps & Record<TName, Awaited<TResult>>> {
    this.nodes.push({
      type: 'step',
      def: {
        name,
        handler: handler as StepHandler,
        compensate: options?.compensate as CompensateHandler | undefined,
        retry: options?.retry ?? 3,
        timeout: options?.timeout ?? 30_000,
        inputSchema: options?.inputSchema,
        outputSchema: options?.outputSchema,
      },
    });
    return this as any;
  }

  /** Add a branch point — call .path() after this to define paths */
  branch(condition: BranchCondition<TInput, TSteps>): this {
    this.nodes.push({
      type: 'branch',
      def: { condition: condition as BranchCondition<any, any>, paths: new Map() },
    });
    return this;
  }

  /** Define a branch path (must follow a .branch() call) */
  path(name: string, builder: (w: Workflow<TInput, TSteps>) => Workflow<TInput, any>): this {
    const lastNode = this.nodes[this.nodes.length - 1] as WorkflowNode | undefined;
    if (lastNode?.type !== 'branch') {
      throw new Error('path() must follow a branch() call');
    }
    const sub = new Workflow<TInput, TSteps>(`${this.name}:${name}`);
    builder(sub);
    const steps: StepDefinition[] = sub.nodes
      .filter((n): n is { type: 'step'; def: StepDefinition } => n.type === 'step')
      .map((n) => n.def);
    lastNode.def.paths.set(name, steps);
    return this;
  }

  /** Run multiple steps in parallel — accumulated types from sub-builder merge into TSteps */
  parallel<TNewSteps extends Record<string, unknown>>(
    builder: (w: Workflow<TInput, TSteps>) => Workflow<TInput, TSteps & TNewSteps>
  ): Workflow<TInput, TSteps & TNewSteps> {
    const sub = new Workflow<TInput, TSteps>(`${this.name}:parallel`);
    builder(sub);
    const steps: StepDefinition[] = sub.nodes
      .filter((n): n is { type: 'step'; def: StepDefinition } => n.type === 'step')
      .map((n) => n.def);
    if (steps.length === 0) {
      throw new Error('parallel() requires at least one step');
    }
    this.nodes.push({ type: 'parallel', def: { steps } });
    return this as any;
  }

  /** Call another registered workflow as a step */
  subWorkflow<TName extends string>(
    name: TName,
    inputMapper: (ctx: StepContext<TInput, TSteps>) => unknown
  ): Workflow<TInput, TSteps & Record<`sub:${TName}`, Record<string, unknown>>> {
    this.nodes.push({
      type: 'subWorkflow',
      name,
      inputMapper: inputMapper as SubWorkflowInputMapper<any, any>,
    });
    return this as any;
  }

  /** Wait for an external signal before continuing */
  waitFor(event: string, options?: { timeout?: number }): this {
    this.nodes.push({ type: 'waitFor', event, timeout: options?.timeout });
    return this;
  }

  /** Repeat steps until condition returns true (checked after each iteration) */
  doUntil(
    condition: LoopCondition<TInput, TSteps>,
    builder: (w: Workflow<TInput, TSteps>) => Workflow<TInput, any>,
    options?: { maxIterations?: number }
  ): this {
    const sub = new Workflow<TInput, TSteps>(`${this.name}:doUntil`);
    builder(sub);
    const steps = sub.nodes
      .filter((n): n is { type: 'step'; def: StepDefinition } => n.type === 'step')
      .map((n) => n.def);
    if (steps.length === 0) throw new Error('doUntil() requires at least one step');
    this.nodes.push({
      type: 'doUntil',
      def: {
        condition: condition as LoopCondition<any, any>,
        steps,
        maxIterations: options?.maxIterations ?? 100,
      },
    });
    return this;
  }

  /** Repeat steps while condition returns true (checked before each iteration) */
  doWhile(
    condition: LoopCondition<TInput, TSteps>,
    builder: (w: Workflow<TInput, TSteps>) => Workflow<TInput, any>,
    options?: { maxIterations?: number }
  ): this {
    const sub = new Workflow<TInput, TSteps>(`${this.name}:doWhile`);
    builder(sub);
    const steps = sub.nodes
      .filter((n): n is { type: 'step'; def: StepDefinition } => n.type === 'step')
      .map((n) => n.def);
    if (steps.length === 0) throw new Error('doWhile() requires at least one step');
    this.nodes.push({
      type: 'doWhile',
      def: {
        condition: condition as LoopCondition<any, any>,
        steps,
        maxIterations: options?.maxIterations ?? 100,
      },
    });
    return this;
  }

  /** Iterate over items, executing a step for each */
  forEach<TName extends string, TResult>(
    items: ForEachItemsExtractor<TInput, TSteps>,
    name: TName,
    handler: TypedStepHandler<TInput, TSteps, TResult>,
    options?: StepOptions<TInput, TSteps> & { maxIterations?: number }
  ): Workflow<TInput, TSteps & Record<TName, Awaited<TResult>>> {
    const step: StepDefinition = {
      name,
      handler: handler as StepHandler,
      compensate: options?.compensate as CompensateHandler | undefined,
      retry: options?.retry ?? 3,
      timeout: options?.timeout ?? 30_000,
      inputSchema: options?.inputSchema,
      outputSchema: options?.outputSchema,
    };
    this.nodes.push({
      type: 'forEach',
      def: {
        items: items as ForEachItemsExtractor<any, any>,
        step,
        maxIterations: options?.maxIterations ?? 1000,
      },
    });
    return this as any;
  }

  /** Transform step results into a new value stored under the given name */
  map<TName extends string, TResult>(
    name: TName,
    transform: (ctx: StepContext<TInput, TSteps>) => TResult
  ): Workflow<TInput, TSteps & Record<TName, Awaited<TResult>>> {
    this.nodes.push({
      type: 'map',
      def: { name, transform: transform as MapTransformFn<any, any> },
    });
    return this as any;
  }

  /** Get flat list of step names for validation */
  getStepNames(): string[] {
    const names: string[] = [];
    for (const node of this.nodes) {
      if (node.type === 'step') names.push(node.def.name);
      else if (node.type === 'branch') {
        for (const steps of node.def.paths.values()) {
          for (const s of steps) names.push(s.name);
        }
      } else if (node.type === 'parallel') {
        for (const s of node.def.steps) names.push(s.name);
      } else if (node.type === 'subWorkflow') names.push(`sub:${node.name}`);
      else if (node.type === 'doUntil' || node.type === 'doWhile') {
        for (const s of node.def.steps) names.push(s.name);
      } else if (node.type === 'forEach') names.push(node.def.step.name);
      else if (node.type === 'map') names.push(node.def.name);
    }
    return names;
  }
}
