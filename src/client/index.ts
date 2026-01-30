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
export { SandboxedWorker } from './sandboxedWorker';
export { QueueEvents } from './events';
export { QueueGroup } from './queueGroup';
export { FlowProducer } from './flow';
export { shutdownManager } from './manager';
export { closeSharedTcpClient } from './tcpClient';
export { TcpConnectionPool, getSharedPool, closeSharedPool } from './tcpPool';
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
  ConnectionOptions,
} from './types';
export type { FlowStep, FlowResult } from './flow';
export type { SandboxedWorkerOptions } from './sandboxedWorker';
