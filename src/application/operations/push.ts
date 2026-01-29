/**
 * Push Operations
 * Job push and batch push logic
 */

import {
  type Job,
  type JobId,
  type JobInput,
  createJob,
  generateJobId,
} from '../../domain/types/job';
import type { JobLocation, EventType } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import type { RWLock } from '../../shared/lock';
import { withWriteLock } from '../../shared/lock';
import { shardIndex } from '../../shared/hash';
import type { SetLike, MapLike } from '../../shared/lru';

/** Push operation context */
export interface PushContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  shardLocks: RWLock[];
  completedJobs: SetLike<JobId>;
  customIdMap: MapLike<string, JobId>;
  jobIndex: Map<JobId, JobLocation>;
  totalPushed: { value: bigint };
  broadcast: (event: {
    eventType: EventType;
    queue: string;
    jobId: JobId;
    timestamp: number;
  }) => void;
}

/**
 * Push a single job to queue
 */
export async function pushJob(queue: string, input: JobInput, ctx: PushContext): Promise<Job> {
  // Generate UUIDv7 ID
  const id = generateJobId();

  // Handle custom ID idempotency
  if (input.customId) {
    const existing = ctx.customIdMap.get(input.customId);
    if (existing) {
      const location = ctx.jobIndex.get(existing);
      if (location) {
        // Return existing job ID - caller should fetch the job
        throw new Error(`Job with customId ${input.customId} already exists`);
      }
      ctx.customIdMap.delete(input.customId);
    }
    ctx.customIdMap.set(input.customId, id);
  }

  // Create job
  const now = Date.now();
  const job = createJob(id, queue, input, now);

  // Check dependencies
  const needsWaitingDeps =
    job.dependsOn.length > 0 && !job.dependsOn.every((depId) => ctx.completedJobs.has(depId));

  // Insert into shard
  const idx = shardIndex(queue);
  await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];

    // Check unique key
    if (job.uniqueKey && !shard.isUniqueAvailable(queue, job.uniqueKey)) {
      // Rollback custom ID
      if (input.customId) {
        ctx.customIdMap.delete(input.customId);
      }
      throw new Error('Duplicate unique_key');
    }
    if (job.uniqueKey) {
      shard.registerUniqueKey(queue, job.uniqueKey);
    }

    // Insert based on state
    if (needsWaitingDeps) {
      shard.waitingDeps.set(job.id, job);
    } else {
      shard.getQueue(queue).push(job);
      shard.notify();
    }

    // Index job
    ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
  });

  // Persist
  ctx.storage?.insertJob(job);

  // Update metrics & notify
  ctx.totalPushed.value++;
  ctx.broadcast({ eventType: 'pushed' as EventType, queue, jobId: id, timestamp: now });

  return job;
}

/**
 * Push multiple jobs to queue
 */
export async function pushJobBatch(
  queue: string,
  inputs: JobInput[],
  ctx: PushContext
): Promise<JobId[]> {
  const jobs: Job[] = [];
  const now = Date.now();

  // Generate all jobs
  for (const input of inputs) {
    const id = generateJobId();
    jobs.push(createJob(id, queue, input, now));
  }

  // Insert into shard
  const idx = shardIndex(queue);
  await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];
    const q = shard.getQueue(queue);

    for (const job of jobs) {
      q.push(job);
      ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
    }

    shard.notify();
  });

  // Persist batch
  ctx.storage?.insertJobsBatch(jobs);

  // Update metrics
  ctx.totalPushed.value += BigInt(jobs.length);

  return jobs.map((j) => j.id);
}
