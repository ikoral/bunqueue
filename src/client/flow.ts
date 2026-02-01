/**
 * FlowProducer - Job chaining and pipelines
 * BullMQ v5 compatible
 */

import { getSharedManager } from './manager';
import { TcpConnectionPool, getSharedPool, releaseSharedPool } from './tcpPool';
import { jobId } from '../domain/types/job';
import type { JobOptions, ConnectionOptions, Job } from './types';

const FORCE_EMBEDDED = process.env.BUNQUEUE_EMBEDDED === '1';

/** FlowProducer options */
export interface FlowProducerOptions {
  /** Use embedded mode (no server) */
  embedded?: boolean;
  /** TCP connection options */
  connection?: ConnectionOptions;
}

/** Step definition in a flow (legacy bunqueue API) */
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

/** Result of adding a flow (legacy bunqueue API) */
export interface FlowResult {
  /** Job IDs in order */
  jobIds: string[];
}

// ============================================================================
// BullMQ v5 Compatible Types
// ============================================================================

/**
 * FlowJob - BullMQ v5 compatible flow job definition.
 * Children are processed BEFORE the parent.
 */
export interface FlowJob<T = unknown> {
  /** Job name */
  name: string;
  /** Queue name */
  queueName: string;
  /** Job data */
  data?: T;
  /** Job options */
  opts?: JobOptions;
  /** Child jobs (processed BEFORE this job) */
  children?: FlowJob[];
}

/**
 * JobNode - BullMQ v5 compatible result from adding a flow.
 * Contains the job and its children nodes.
 */
export interface JobNode<T = unknown> {
  /** The job instance */
  job: Job<T>;
  /** Child nodes (if any) */
  children?: JobNode[];
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

  /**
   * Disconnect from the server (BullMQ v5 compatible).
   * Alias for close().
   */
  disconnect(): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  /**
   * Wait until the FlowProducer is ready (BullMQ v5 compatible).
   * In embedded mode, resolves immediately. In TCP mode, ensures connection.
   */
  async waitUntilReady(): Promise<void> {
    if (this.embedded) {
      // Embedded mode is always ready
      return;
    }
    // TCP mode - ensure we can send a ping
    if (this.tcp) {
      await this.tcp.send({ cmd: 'Ping' });
    }
  }

  // ============================================================================
  // BullMQ v5 Compatible Methods
  // ============================================================================

  /**
   * Add a flow (BullMQ v5 compatible).
   *
   * Children are processed BEFORE their parent. When all children complete,
   * the parent becomes processable and can access children results via
   * `job.getChildrenValues()`.
   *
   * @example
   * ```typescript
   * const flow = new FlowProducer();
   *
   * // Children execute first, then parent
   * const { job, children } = await flow.add({
   *   name: 'parent',
   *   queueName: 'main',
   *   data: { type: 'aggregate' },
   *   children: [
   *     { name: 'child1', queueName: 'main', data: { id: 1 } },
   *     { name: 'child2', queueName: 'main', data: { id: 2 } },
   *   ],
   * });
   * ```
   */
  async add<T = unknown>(flow: FlowJob<T>): Promise<JobNode<T>> {
    return this.addFlowNode(flow, null);
  }

  /**
   * Add multiple flows (BullMQ v5 compatible).
   */
  async addBulk<T = unknown>(flows: FlowJob<T>[]): Promise<JobNode<T>[]> {
    const results: JobNode<T>[] = [];
    for (const flow of flows) {
      results.push(await this.add(flow));
    }
    return results;
  }

  /**
   * Internal: Recursively add a flow node and its children.
   * Children are created first with parent reference, then parent is created.
   */
  private async addFlowNode<T>(
    node: FlowJob<T>,
    parentRef: { id: string; queue: string } | null
  ): Promise<JobNode<T>> {
    // First, create all children recursively
    const childNodes: JobNode[] = [];
    const childIds: string[] = [];

    if (node.children && node.children.length > 0) {
      // Create a placeholder parent ID for children to reference
      // In BullMQ, children reference the parent, not the other way around
      const tempParentRef = { id: 'pending', queue: node.queueName };

      for (const child of node.children) {
        const childNode = await this.addFlowNode(child, tempParentRef);
        childNodes.push(childNode);
        childIds.push(childNode.job.id);
      }
    }

    // Create the job data with parent info if this is a child
    const jobData: Record<string, unknown> = {
      name: node.name,
      ...(node.data as object | undefined),
    };

    // Add parent reference if this job has a parent
    if (parentRef) {
      jobData.__parentId = parentRef.id;
      jobData.__parentQueue = parentRef.queue;
    }

    // Add children IDs so parent knows its children
    if (childIds.length > 0) {
      jobData.__childrenIds = childIds;
    }

    // Push the job
    const jobIdStr = await this.pushJobWithParent(
      node.queueName,
      jobData,
      node.opts ?? {},
      parentRef,
      childIds
    );

    // Create the Job object
    const job = this.createJobObject<T>(jobIdStr, node.name, node.data as T, node.queueName);

    return {
      job,
      children: childNodes.length > 0 ? childNodes : undefined,
    };
  }

  /** Push a job with parent/children tracking */
  private async pushJobWithParent(
    queueName: string,
    data: unknown,
    opts: JobOptions,
    parentRef: { id: string; queue: string } | null,
    childIds: string[]
  ): Promise<string> {
    if (this.embedded) {
      const manager = getSharedManager();
      // Parse removeOnComplete/removeOnFail (can be boolean, number, or KeepJobs)
      const removeOnComplete =
        typeof opts.removeOnComplete === 'boolean' ? opts.removeOnComplete : false;
      const removeOnFail = typeof opts.removeOnFail === 'boolean' ? opts.removeOnFail : false;
      const job = await manager.push(queueName, {
        data,
        priority: opts.priority,
        delay: opts.delay,
        maxAttempts: opts.attempts,
        backoff: opts.backoff,
        timeout: opts.timeout,
        customId: opts.jobId,
        removeOnComplete,
        removeOnFail,
        parentId: parentRef ? jobId(parentRef.id) : undefined,
        // Note: childrenIds tracking happens via job.childrenIds field
      });

      // If this job has children, update the children's parent references
      // with the actual parent ID (they were created with 'pending')
      if (childIds.length > 0) {
        for (const childIdStr of childIds) {
          await manager.updateJobParent(jobId(childIdStr), job.id);
        }
      }

      return String(job.id);
    }

    // TCP mode
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
      parentId: parentRef?.id,
      childIds,
    });

    if (!response.ok) {
      throw new Error((response.error as string | undefined) ?? 'Failed to add job');
    }
    return response.id as string;
  }

  /** Create a simple Job object */
  private createJobObject<T>(id: string, name: string, data: T, queueName: string): Job<T> {
    const ts = Date.now();
    return {
      id,
      name,
      data,
      queueName,
      attemptsMade: 0,
      timestamp: ts,
      progress: 0,
      // BullMQ v5 properties
      delay: 0,
      processedOn: undefined,
      finishedOn: undefined,
      stacktrace: null,
      stalledCounter: 0,
      priority: 0,
      parentKey: undefined,
      opts: {},
      token: undefined,
      processedBy: undefined,
      deduplicationId: undefined,
      repeatJobKey: undefined,
      attemptsStarted: 0,
      // Methods
      updateProgress: () => Promise.resolve(),
      log: () => Promise.resolve(),
      getState: () => Promise.resolve('waiting' as const),
      remove: () => Promise.resolve(),
      retry: () => Promise.resolve(),
      getChildrenValues: () => Promise.resolve({}),
      // BullMQ v5 state check methods
      isWaiting: () => Promise.resolve(true),
      isActive: () => Promise.resolve(false),
      isDelayed: () => Promise.resolve(false),
      isCompleted: () => Promise.resolve(false),
      isFailed: () => Promise.resolve(false),
      isWaitingChildren: () => Promise.resolve(false),
      // BullMQ v5 mutation methods
      updateData: () => Promise.resolve(),
      promote: () => Promise.resolve(),
      changeDelay: () => Promise.resolve(),
      changePriority: () => Promise.resolve(),
      extendLock: () => Promise.resolve(0),
      clearLogs: () => Promise.resolve(),
      // BullMQ v5 dependency methods
      getDependencies: () => Promise.resolve({ processed: {}, unprocessed: [] }),
      getDependenciesCount: () => Promise.resolve({ processed: 0, unprocessed: 0 }),
      // BullMQ v5 serialization methods
      toJSON: () => ({
        id,
        name,
        data,
        opts: {},
        progress: 0,
        delay: 0,
        timestamp: ts,
        attemptsMade: 0,
        stacktrace: null,
        queueQualifiedName: `bull:${queueName}`,
      }),
      asJSON: () => ({
        id,
        name,
        data: JSON.stringify(data),
        opts: '{}',
        progress: '0',
        delay: '0',
        timestamp: String(ts),
        attemptsMade: '0',
        stacktrace: null,
      }),
      // BullMQ v5 move methods
      moveToCompleted: () => Promise.resolve(null),
      moveToFailed: () => Promise.resolve(),
      moveToWait: () => Promise.resolve(false),
      moveToDelayed: () => Promise.resolve(),
      moveToWaitingChildren: () => Promise.resolve(false),
      waitUntilFinished: () => Promise.resolve(undefined),
    };
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
      // Parse removeOnComplete/removeOnFail (can be boolean, number, or KeepJobs)
      const removeOnComplete =
        typeof opts.removeOnComplete === 'boolean' ? opts.removeOnComplete : false;
      const removeOnFail = typeof opts.removeOnFail === 'boolean' ? opts.removeOnFail : false;
      const job = await manager.push(queueName, {
        data,
        priority: opts.priority,
        delay: opts.delay,
        maxAttempts: opts.attempts,
        backoff: opts.backoff,
        timeout: opts.timeout,
        customId: opts.jobId,
        removeOnComplete,
        removeOnFail,
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
