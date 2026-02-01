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

  // Handle custom ID idempotency (BullMQ-style: return existing job)
  if (input.customId) {
    const existing = ctx.customIdMap.get(input.customId);
    if (existing) {
      const location = ctx.jobIndex.get(existing);
      if (location?.type === 'queue') {
        // BullMQ-style: return existing job instead of creating a duplicate
        const shard = ctx.shards[location.shardIdx];
        const existingJob = shard.getQueue(location.queueName).find(existing);
        if (existingJob) {
          return existingJob;
        }
      }
      // If job is processing, completed, or not found, clean up the map entry
      // and allow creating a new job with the same customId
      ctx.customIdMap.delete(input.customId);
    }
    ctx.customIdMap.set(input.customId, id);
  }

  // Create job
  const now = Date.now();
  const job = createJob(id, queue, input, now);

  // Pre-check dependencies (optimization to avoid unnecessary lock contention)
  const mayNeedWaitingDeps =
    job.dependsOn.length > 0 && !job.dependsOn.every((depId) => ctx.completedJobs.has(depId));

  // Insert into shard
  const idx = shardIndex(queue);
  let returnedJob: Job | undefined;

  await withWriteLock(ctx.shardLocks[idx], () => {
    const shard = ctx.shards[idx];

    // Check unique key with advanced deduplication support
    if (job.uniqueKey) {
      const existingEntry = shard.getUniqueKeyEntry(queue, job.uniqueKey);

      if (existingEntry) {
        // Duplicate detected - handle based on dedup options
        const dedupOpts = input.dedup;

        if (dedupOpts?.replace) {
          // Replace strategy: remove old job, insert new
          const existingJob = shard.getQueue(queue).find(existingEntry.jobId);
          if (existingJob) {
            shard.getQueue(queue).remove(existingEntry.jobId);
            shard.decrementQueued(existingEntry.jobId);
            ctx.jobIndex.delete(existingEntry.jobId);
          }
          // Release old unique key entry before registering new one to avoid stale TTL
          shard.releaseUniqueKey(queue, job.uniqueKey);
          // Register new key with TTL
          shard.registerUniqueKeyWithTtl(queue, job.uniqueKey, job.id, dedupOpts?.ttl);
        } else if (dedupOpts?.extend && dedupOpts?.ttl) {
          // Extend strategy: reset TTL, return existing job
          shard.extendUniqueKeyTtl(queue, job.uniqueKey, dedupOpts.ttl);
          // Rollback custom ID since we're not inserting
          if (input.customId) {
            ctx.customIdMap.delete(input.customId);
          }
          // Set returnedJob to existing job
          const existingJob = shard.getQueue(queue).find(existingEntry.jobId);
          if (existingJob) {
            returnedJob = existingJob;
            return; // Exit early from withWriteLock
          }
          throw new Error('Duplicate unique_key (extended TTL)');
        } else {
          // Default: return existing job (BullMQ-style idempotency)
          if (input.customId) {
            ctx.customIdMap.delete(input.customId);
          }
          const existingJob = shard.getQueue(queue).find(existingEntry.jobId);
          if (existingJob) {
            returnedJob = existingJob;
            return; // Exit early, return existing job
          }
          // Job not in queue (maybe completed/failed) - allow new insert
          shard.registerUniqueKeyWithTtl(queue, job.uniqueKey, job.id, input.dedup?.ttl);
        }
      } else {
        // No existing entry - register with TTL if specified
        shard.registerUniqueKeyWithTtl(queue, job.uniqueKey, job.id, input.dedup?.ttl);
      }
    }

    // Double-check dependencies inside lock to avoid race condition
    // (a dependency might have completed between pre-check and lock acquisition)
    const needsWaitingDeps =
      mayNeedWaitingDeps && !job.dependsOn.every((depId) => ctx.completedJobs.has(depId));

    // Insert based on state
    if (needsWaitingDeps) {
      shard.waitingDeps.set(job.id, job);
      // Register in dependency index for O(1) lookup when deps complete
      shard.registerDependencies(job.id, job.dependsOn);
    } else {
      shard.getQueue(queue).push(job);
      // Update running counters for O(1) stats and temporal index for cleanQueue
      const isDelayed = job.runAt > Date.now();
      shard.incrementQueued(job.id, isDelayed, job.createdAt, queue, job.runAt);
      shard.notify();
    }

    // Index job
    ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
  });

  // If extend strategy returned existing job, return it without persisting
  if (returnedJob) {
    return returnedJob;
  }

  // Persist (with optional durable flag for critical jobs)
  ctx.storage?.insertJob(job, input.durable);

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
    const now = Date.now();

    for (const job of jobs) {
      q.push(job);
      ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
      // Update running counters for O(1) stats and temporal index for cleanQueue
      const isDelayed = job.runAt > now;
      shard.incrementQueued(job.id, isDelayed, job.createdAt, queue, job.runAt);
    }

    shard.notify();
  });

  // Persist batch
  ctx.storage?.insertJobsBatch(jobs);

  // Update metrics
  ctx.totalPushed.value += BigInt(jobs.length);

  return jobs.map((j) => j.id);
}
