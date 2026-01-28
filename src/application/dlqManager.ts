/**
 * DLQ Manager
 * Dead Letter Queue operations
 */

import type { Job, JobId } from '../domain/types/job';
import type { JobLocation } from '../domain/types/queue';
import type { Shard } from '../domain/queue/shard';
import { shardIndex } from '../shared/hash';

/** Context for DLQ operations */
export interface DlqContext {
  shards: Shard[];
  jobIndex: Map<JobId, JobLocation>;
}

/** Get jobs from DLQ */
export function getDlqJobs(queue: string, ctx: DlqContext, count?: number): Job[] {
  const idx = shardIndex(queue);
  const jobs = ctx.shards[idx].getDlq(queue);
  return count ? jobs.slice(0, count) : jobs;
}

/** Retry jobs from DLQ */
export function retryDlqJobs(queue: string, ctx: DlqContext, jobId?: JobId): number {
  const idx = shardIndex(queue);
  const shard = ctx.shards[idx];

  if (jobId) {
    const job = shard.removeFromDlq(queue, jobId);
    if (job) {
      job.attempts = 0;
      job.runAt = Date.now();
      shard.getQueue(queue).push(job);
      ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
      return 1;
    }
    return 0;
  }

  // Retry all
  const jobs = shard.getDlq(queue);
  const count = jobs.length;
  shard.clearDlq(queue);

  for (const job of jobs) {
    job.attempts = 0;
    job.runAt = Date.now();
    shard.getQueue(queue).push(job);
    ctx.jobIndex.set(job.id, { type: 'queue', shardIdx: idx, queueName: queue });
  }

  return count;
}

/** Purge all jobs from DLQ */
export function purgeDlqJobs(queue: string, ctx: DlqContext): number {
  const idx = shardIndex(queue);
  return ctx.shards[idx].clearDlq(queue);
}
