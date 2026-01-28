/**
 * Queue Control Operations
 * Pause, resume, drain, obliterate, clean, list queues
 */

import type { JobId } from '../../domain/types/job';
import type { Shard } from '../../domain/queue/shard';
import { shardIndex, SHARD_COUNT } from '../../shared/hash';

/** Context for queue control operations */
export interface QueueControlContext {
  shards: Shard[];
  jobIndex: Map<JobId, { type: string; shardIdx?: number; queueName?: string }>;
}

/** Pause a queue */
export function pauseQueue(queue: string, ctx: QueueControlContext): void {
  const idx = shardIndex(queue);
  ctx.shards[idx].pause(queue);
}

/** Resume a queue */
export function resumeQueue(queue: string, ctx: QueueControlContext): void {
  const idx = shardIndex(queue);
  ctx.shards[idx].resume(queue);
}

/** Check if queue is paused */
export function isQueuePaused(queue: string, ctx: QueueControlContext): boolean {
  const idx = shardIndex(queue);
  return ctx.shards[idx].isPaused(queue);
}

/** Drain all waiting jobs from queue */
export function drainQueue(queue: string, ctx: QueueControlContext): number {
  const idx = shardIndex(queue);
  return ctx.shards[idx].drain(queue);
}

/** Remove all queue data */
export function obliterateQueue(queue: string, ctx: QueueControlContext): void {
  const idx = shardIndex(queue);
  ctx.shards[idx].obliterate(queue);
}

/** List all queue names */
export function listAllQueues(ctx: QueueControlContext): string[] {
  const queues = new Set<string>();
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const name of ctx.shards[i].getQueueNames()) {
      queues.add(name);
    }
  }
  return Array.from(queues);
}

/** Clean old jobs from queue */
export function cleanQueue(
  queue: string,
  graceMs: number,
  ctx: QueueControlContext,
  state?: string,
  limit?: number
): number {
  const idx = shardIndex(queue);
  const shard = ctx.shards[idx];
  const now = Date.now();
  const maxJobs = limit ?? 1000;
  let cleaned = 0;

  if (!state || state === 'waiting' || state === 'delayed') {
    const q = shard.getQueue(queue);
    const toRemove: JobId[] = [];

    for (const job of q.values()) {
      if (now - job.createdAt > graceMs) {
        toRemove.push(job.id);
        if (toRemove.length >= maxJobs) break;
      }
    }

    for (const id of toRemove) {
      q.remove(id);
      ctx.jobIndex.delete(id);
      cleaned++;
    }
  }

  return cleaned;
}

/** Get count of jobs in queue */
export function getQueueCount(queue: string, ctx: QueueControlContext): number {
  const idx = shardIndex(queue);
  const q = ctx.shards[idx].getQueue(queue);
  return q.size;
}
