/**
 * FlowProducer - Job chaining and pipelines
 */

import { getSharedManager } from './manager';
import { jobId } from '../domain/types/job';
import type { JobOptions } from './types';

/** Step definition in a flow */
export interface FlowStep<T = unknown> {
  /** Job name */
  name: string;
  /** Queue name */
  queueName: string;
  /** Job data */
  data: T;
  /** Job options */
  opts?: JobOptions;
  /** Child steps (for tree structures) */
  children?: FlowStep[];
}

/** Result of adding a flow */
export interface FlowResult {
  /** Job IDs in order */
  jobIds: string[];
}

/**
 * FlowProducer creates job flows with automatic dependencies.
 *
 * @example
 * ```typescript
 * const flow = new FlowProducer();
 *
 * // Simple chain: A → B → C
 * const { jobIds } = await flow.addChain([
 *   { name: 'fetch', queueName: 'pipeline', data: { url: '...' } },
 *   { name: 'process', queueName: 'pipeline', data: {} },
 *   { name: 'store', queueName: 'pipeline', data: {} },
 * ]);
 *
 * // Parallel then merge
 * const result = await flow.addBulkThen(
 *   [
 *     { name: 'task1', queueName: 'parallel', data: { id: 1 } },
 *     { name: 'task2', queueName: 'parallel', data: { id: 2 } },
 *   ],
 *   { name: 'merge', queueName: 'final', data: {} }
 * );
 * ```
 */
export class FlowProducer {
  /**
   * Add a chain of jobs where each depends on the previous.
   * Jobs execute sequentially: step[0] → step[1] → step[2] → ...
   */
  async addChain(steps: FlowStep[]): Promise<FlowResult> {
    if (steps.length === 0) {
      return { jobIds: [] };
    }

    const manager = getSharedManager();
    const jobIds: string[] = [];
    let prevId: string | null = null;

    for (const step of steps) {
      const merged = step.opts ?? {};
      const input: Parameters<typeof manager.push>[1] = {
        data: { name: step.name, __flowParentId: prevId, ...(step.data as object) },
        priority: merged.priority,
        delay: merged.delay,
        maxAttempts: merged.attempts,
        backoff: merged.backoff,
        timeout: merged.timeout,
        customId: merged.jobId,
        removeOnComplete: merged.removeOnComplete,
        removeOnFail: merged.removeOnFail,
        dependsOn: prevId ? [jobId(prevId)] : undefined,
      };

      const job = await manager.push(step.queueName, input);
      const id = String(job.id);
      jobIds.push(id);
      prevId = id;
    }

    return { jobIds };
  }

  /**
   * Add parallel jobs that all converge to a final job.
   * Parallel jobs run concurrently, final job runs after all complete.
   *
   * @example
   * ```
   *   parallel[0] ──┐
   *   parallel[1] ──┼──→ final
   *   parallel[2] ──┘
   * ```
   */
  async addBulkThen(
    parallel: FlowStep[],
    final: FlowStep
  ): Promise<{ parallelIds: string[]; finalId: string }> {
    const manager = getSharedManager();

    // Create parallel jobs (no dependencies)
    const parallelIds: string[] = [];
    for (const step of parallel) {
      const merged = step.opts ?? {};
      const job = await manager.push(step.queueName, {
        data: { name: step.name, ...(step.data as object) },
        priority: merged.priority,
        delay: merged.delay,
        maxAttempts: merged.attempts,
        backoff: merged.backoff,
        timeout: merged.timeout,
        customId: merged.jobId,
        removeOnComplete: merged.removeOnComplete,
        removeOnFail: merged.removeOnFail,
      });
      parallelIds.push(String(job.id));
    }

    // Create final job with dependencies on all parallel jobs
    const finalMerged = final.opts ?? {};
    const finalJob = await manager.push(final.queueName, {
      data: { name: final.name, __flowParentIds: parallelIds, ...(final.data as object) },
      priority: finalMerged.priority,
      delay: finalMerged.delay,
      maxAttempts: finalMerged.attempts,
      backoff: finalMerged.backoff,
      timeout: finalMerged.timeout,
      customId: finalMerged.jobId,
      removeOnComplete: finalMerged.removeOnComplete,
      removeOnFail: finalMerged.removeOnFail,
      dependsOn: parallelIds.map((id) => jobId(id)),
    });

    return {
      parallelIds,
      finalId: String(finalJob.id),
    };
  }

  /**
   * Add a tree of jobs where children depend on parent.
   * Recursively creates nested dependencies.
   */
  async addTree(root: FlowStep): Promise<FlowResult> {
    const jobIds: string[] = [];
    await this.addTreeNode(root, null, jobIds);
    return { jobIds };
  }

  private async addTreeNode(
    step: FlowStep,
    parentId: string | null,
    jobIds: string[]
  ): Promise<string> {
    const manager = getSharedManager();
    const merged = step.opts ?? {};

    const job = await manager.push(step.queueName, {
      data: { name: step.name, __flowParentId: parentId, ...(step.data as object) },
      priority: merged.priority,
      delay: merged.delay,
      maxAttempts: merged.attempts,
      backoff: merged.backoff,
      timeout: merged.timeout,
      customId: merged.jobId,
      removeOnComplete: merged.removeOnComplete,
      removeOnFail: merged.removeOnFail,
      dependsOn: parentId ? [jobId(parentId)] : undefined,
    });

    const id = String(job.id);
    jobIds.push(id);

    // Create children with this job as parent
    if (step.children) {
      for (const child of step.children) {
        await this.addTreeNode(child, id, jobIds);
      }
    }

    return id;
  }

  /**
   * Get the result of a completed parent job.
   * Call this from within a worker to access the previous step's result.
   */
  getParentResult(parentId: string): unknown {
    const manager = getSharedManager();
    return manager.getResult(jobId(parentId));
  }

  /**
   * Get results from multiple parent jobs (for merge scenarios).
   */
  getParentResults(parentIds: string[]): Map<string, unknown> {
    const manager = getSharedManager();
    const results = new Map<string, unknown>();

    for (const id of parentIds) {
      const result = manager.getResult(jobId(id));
      if (result !== undefined) {
        results.set(id, result);
      }
    }

    return results;
  }
}
