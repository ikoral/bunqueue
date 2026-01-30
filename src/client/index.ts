/**
 * bunqueue Client API
 *
 * @example
 * ```typescript
 * import { Queue, Worker } from 'bunqueue/client';
 *
 * const queue = new Queue('emails');
 * await queue.add('send', { to: 'user@test.com' });
 *
 * const worker = new Worker('emails', async (job) => {
 *   await job.updateProgress(50);
 *   await job.log('Processing...');
 *   return { success: true };
 * });
 *
 * worker.on('completed', (job, result) => console.log(result));
 * worker.on('progress', (job, progress) => console.log(progress));
 * ```
 */

export { Queue } from './queue';
export { Worker } from './worker';
export { QueueEvents } from './events';
export { QueueGroup } from './queueGroup';
export { FlowProducer } from './flow';
export { shutdownManager } from './manager';
export type {
  Job,
  JobOptions,
  QueueOptions,
  WorkerOptions,
  Processor,
  StallConfig,
  DlqConfig,
  DlqEntry,
  DlqStats,
  DlqFilter,
  FailureReason,
} from './types';
export type { FlowStep, FlowResult } from './flow';
