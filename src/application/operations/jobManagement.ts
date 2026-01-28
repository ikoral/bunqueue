/**
 * Job Management Operations
 * Cancel, update progress, change priority, promote, move to delayed, discard
 */

import type { Job, JobId } from '../../domain/types/job';
import type { JobLocation } from '../../domain/types/queue';
import type { Shard } from '../../domain/queue/shard';
import type { SqliteStorage } from '../../infrastructure/persistence/sqlite';
import type { WebhookManager } from '../webhookManager';
import { shardIndex } from '../../shared/hash';
import { webhookLog } from '../../shared/logger';

/** Context for job management operations */
export interface JobManagementContext {
  storage: SqliteStorage | null;
  shards: Shard[];
  processingShards: Map<JobId, Job>[];
  jobIndex: Map<JobId, JobLocation>;
  webhookManager: WebhookManager;
}

/** Cancel a job (remove from queue) */
export async function cancelJob(jobId: JobId, ctx: JobManagementContext): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (!location) return false;

  if (location.type === 'queue') {
    const shard = ctx.shards[location.shardIdx];
    const job = shard.getQueue(location.queueName).remove(jobId);
    if (job) {
      if (job.uniqueKey) shard.releaseUniqueKey(location.queueName, job.uniqueKey);
      ctx.jobIndex.delete(jobId);
      ctx.storage?.deleteJob(jobId);
      return true;
    }
  }
  return false;
}

/** Update job progress */
export async function updateJobProgress(
  jobId: JobId,
  progress: number,
  ctx: JobManagementContext,
  message?: string
): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (location?.type !== 'processing') return false;

  const job = ctx.processingShards[location.shardIdx].get(jobId);
  if (!job) return false;

  job.progress = Math.max(0, Math.min(100, progress));
  if (message !== undefined) job.progressMessage = message;

  ctx.webhookManager
    .trigger('job.progress', String(jobId), job.queue, { progress: job.progress })
    .catch((err: unknown) => {
      webhookLog.error('Progress webhook failed', {
        jobId: String(jobId),
        queue: job.queue,
        error: String(err),
      });
    });

  return true;
}

/** Update job data */
export async function updateJobData(
  jobId: JobId,
  data: unknown,
  ctx: JobManagementContext
): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (!location) return false;

  if (location.type === 'queue') {
    const job = ctx.shards[location.shardIdx].getQueue(location.queueName).find(jobId);
    if (job) {
      (job as { data: unknown }).data = data;
      return true;
    }
  } else if (location.type === 'processing') {
    const job = ctx.processingShards[location.shardIdx].get(jobId);
    if (job) {
      (job as { data: unknown }).data = data;
      return true;
    }
  }
  return false;
}

/** Change job priority */
export async function changeJobPriority(
  jobId: JobId,
  priority: number,
  ctx: JobManagementContext
): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (location?.type !== 'queue') return false;

  const q = ctx.shards[location.shardIdx].getQueue(location.queueName);
  return q.updatePriority(jobId, priority);
}

/** Promote delayed job to waiting */
export async function promoteJob(jobId: JobId, ctx: JobManagementContext): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (location?.type !== 'queue') return false;

  const q = ctx.shards[location.shardIdx].getQueue(location.queueName);
  const job = q.find(jobId);
  if (!job || job.runAt <= Date.now()) return false;

  job.runAt = Date.now();
  return true;
}

/** Move active job back to delayed */
export async function moveJobToDelayed(
  jobId: JobId,
  delay: number,
  ctx: JobManagementContext
): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (location?.type !== 'processing') return false;

  const procShard = ctx.processingShards[location.shardIdx];
  const job = procShard.get(jobId);
  if (!job) return false;

  procShard.delete(jobId);

  job.runAt = Date.now() + delay;
  job.startedAt = null;
  const idx = shardIndex(job.queue);
  ctx.shards[idx].getQueue(job.queue).push(job);
  ctx.jobIndex.set(jobId, { type: 'queue', shardIdx: idx, queueName: job.queue });

  return true;
}

/** Discard job to DLQ */
export async function discardJob(jobId: JobId, ctx: JobManagementContext): Promise<boolean> {
  const location = ctx.jobIndex.get(jobId);
  if (!location) return false;

  let job: Job | null = null;

  if (location.type === 'queue') {
    job = ctx.shards[location.shardIdx].getQueue(location.queueName).remove(jobId);
  } else if (location.type === 'processing') {
    job = ctx.processingShards[location.shardIdx].get(jobId) ?? null;
    if (job) ctx.processingShards[location.shardIdx].delete(jobId);
  }

  if (job) {
    const idx = shardIndex(job.queue);
    ctx.shards[idx].addToDlq(job);
    ctx.jobIndex.set(jobId, { type: 'dlq', queueName: job.queue });
    return true;
  }
  return false;
}
