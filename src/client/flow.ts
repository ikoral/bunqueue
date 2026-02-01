/**
 * FlowProducer - Job chaining and pipelines
 */

import { getSharedManager } from './manager';
import { TcpConnectionPool, getSharedPool, releaseSharedPool } from './tcpPool';
import { jobId } from '../domain/types/job';
import type { JobOptions, ConnectionOptions } from './types';

const FORCE_EMBEDDED = process.env.BUNQUEUE_EMBEDDED === '1';

/** FlowProducer options */
export interface FlowProducerOptions {
  /** Use embedded mode (no server) */
  embedded?: boolean;
  /** TCP connection options */
  connection?: ConnectionOptions;
}

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
  private readonly embedded: boolean;
  private readonly tcp: TcpConnectionPool | null;
  private readonly useSharedPool: boolean;

  constructor(opts: FlowProducerOptions = {}) {
    this.embedded = opts.embedded ?? FORCE_EMBEDDED;

    if (this.embedded) {
      this.tcp = null;
      this.useSharedPool = false;
    } else {
      const connOpts: ConnectionOptions = opts.connection ?? {};
      const poolSize = connOpts.poolSize ?? 4;

      if (poolSize === 4 && !connOpts.token) {
        this.tcp = getSharedPool({ host: connOpts.host, port: connOpts.port, poolSize });
        this.useSharedPool = true;
      } else {
        this.tcp = new TcpConnectionPool({
          host: connOpts.host ?? 'localhost',
          port: connOpts.port ?? 6789,
          token: connOpts.token,
          poolSize,
        });
        this.useSharedPool = false;
      }
    }
  }

  /** Close the connection pool (only if using dedicated pool) */
  close(): void {
    if (this.tcp && !this.useSharedPool) {
      this.tcp.close();
    } else if (this.tcp && this.useSharedPool) {
      releaseSharedPool(this.tcp);
    }
  }

  /** Push a job via embedded manager or TCP */
  private async pushJob(
    queueName: string,
    data: unknown,
    opts: JobOptions = {},
    dependsOn?: string[]
  ): Promise<string> {
    if (this.embedded) {
      const manager = getSharedManager();
      const job = await manager.push(queueName, {
        data,
        priority: opts.priority,
        delay: opts.delay,
        maxAttempts: opts.attempts,
        backoff: opts.backoff,
        timeout: opts.timeout,
        customId: opts.jobId,
        removeOnComplete: opts.removeOnComplete,
        removeOnFail: opts.removeOnFail,
        dependsOn: dependsOn?.map((id) => jobId(id)),
      });
      return String(job.id);
    }

    // TCP mode - tcp is guaranteed to exist when not embedded
    if (!this.tcp) throw new Error('TCP connection not initialized');
    const response = await this.tcp.send({
      cmd: 'PUSH',
      queue: queueName,
      data,
      priority: opts.priority,
      delay: opts.delay,
      maxAttempts: opts.attempts,
      backoff: opts.backoff,
      timeout: opts.timeout,
      jobId: opts.jobId,
      removeOnComplete: opts.removeOnComplete,
      removeOnFail: opts.removeOnFail,
      dependsOn,
    });

    if (!response.ok) {
      throw new Error((response.error as string | undefined) ?? 'Failed to add job');
    }
    return response.id as string;
  }

  /**
   * Add a chain of jobs where each depends on the previous.
   * Jobs execute sequentially: step[0] → step[1] → step[2] → ...
   */
  async addChain(steps: FlowStep[]): Promise<FlowResult> {
    if (steps.length === 0) {
      return { jobIds: [] };
    }

    const jobIds: string[] = [];
    let prevId: string | null = null;

    try {
      for (const step of steps) {
        const merged = step.opts ?? {};
        const data = { name: step.name, __flowParentId: prevId, ...(step.data as object) };
        const id = await this.pushJob(step.queueName, data, merged, prevId ? [prevId] : undefined);
        jobIds.push(id);
        prevId = id;
      }
    } catch (error) {
      // Cleanup already-created jobs on failure
      await this.cleanupJobs(jobIds);
      throw error;
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
    // Create parallel jobs (no dependencies)
    const parallelIds: string[] = [];
    try {
      for (const step of parallel) {
        const merged = step.opts ?? {};
        const data = { name: step.name, ...(step.data as object) };
        const id = await this.pushJob(step.queueName, data, merged);
        parallelIds.push(id);
      }

      // Create final job with dependencies on all parallel jobs
      const finalMerged = final.opts ?? {};
      const finalData = {
        name: final.name,
        __flowParentIds: parallelIds,
        ...(final.data as object),
      };
      const finalId = await this.pushJob(final.queueName, finalData, finalMerged, parallelIds);

      return {
        parallelIds,
        finalId,
      };
    } catch (error) {
      // Cleanup already-created parallel jobs on failure
      await this.cleanupJobs(parallelIds);
      throw error;
    }
  }

  /**
   * Add a tree of jobs where children depend on parent.
   * Recursively creates nested dependencies.
   */
  async addTree(root: FlowStep): Promise<FlowResult> {
    const jobIds: string[] = [];
    try {
      await this.addTreeNode(root, null, jobIds);
    } catch (error) {
      // Cleanup already-created jobs on failure
      await this.cleanupJobs(jobIds);
      throw error;
    }
    return { jobIds };
  }

  private async addTreeNode(
    step: FlowStep,
    parentId: string | null,
    jobIds: string[]
  ): Promise<string> {
    const merged = step.opts ?? {};
    const data = { name: step.name, __flowParentId: parentId, ...(step.data as object) };
    const id = await this.pushJob(step.queueName, data, merged, parentId ? [parentId] : undefined);
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
   * Cleanup jobs that were created before a failure occurred.
   * Cancels each job to prevent orphaned jobs in the queue.
   */
  private async cleanupJobs(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;

    if (this.embedded) {
      const manager = getSharedManager();
      const cleanupPromises = jobIds.map(async (id) => {
        try {
          await manager.cancel(jobId(id));
        } catch {
          // Ignore errors during cleanup - job may already be processed or removed
        }
      });
      await Promise.all(cleanupPromises);
    } else if (this.tcp) {
      // TCP mode cleanup
      const cleanupPromises = jobIds.map(async (id) => {
        try {
          await this.tcp?.send({ cmd: 'Cancel', id });
        } catch {
          // Ignore errors during cleanup
        }
      });
      await Promise.all(cleanupPromises);
    }
  }

  /**
   * Get the result of a completed parent job.
   * Call this from within a worker to access the previous step's result.
   * Note: Only works in embedded mode.
   */
  getParentResult(parentId: string): unknown {
    if (!this.embedded) {
      throw new Error('getParentResult is only available in embedded mode');
    }
    const manager = getSharedManager();
    return manager.getResult(jobId(parentId));
  }

  /**
   * Get results from multiple parent jobs (for merge scenarios).
   * Note: Only works in embedded mode.
   */
  getParentResults(parentIds: string[]): Map<string, unknown> {
    if (!this.embedded) {
      throw new Error('getParentResults is only available in embedded mode');
    }
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
