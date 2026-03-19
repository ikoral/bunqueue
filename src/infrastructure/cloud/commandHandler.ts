/**
 * Cloud Command Handler
 * Processes commands received from the dashboard via WebSocket.
 * Only active when BUNQUEUE_CLOUD_REMOTE_COMMANDS=true.
 *
 * All commands are whitelisted — unknown actions are rejected.
 */

import type { QueueManager } from '../../application/queueManager';
import { jobId } from '../../domain/types/job';
import { cloudLog } from './logger';

/** Incoming command from dashboard (fields at top level) */
export interface CloudCommand {
  type: 'command';
  id: string;
  action: string;
  queue?: string;
  jobId?: string;
  name?: string;
  schedule?: string;
  data?: unknown;
  config?: Record<string, unknown>;
  graceMs?: number;
  state?: string;
  limit?: number;
  offset?: number;
}

/** Result sent back to dashboard */
export interface CloudCommandResult {
  type: 'command_result';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type Handler = (qm: QueueManager, cmd: CloudCommand) => unknown;

/** Whitelisted commands */
const COMMANDS: Partial<Record<string, Handler>> = {
  'queue:pause': (qm, cmd) => {
    qm.pause(cmd.queue ?? '');
    return { queue: cmd.queue, paused: true };
  },

  'queue:resume': (qm, cmd) => {
    qm.resume(cmd.queue ?? '');
    return { queue: cmd.queue, paused: false };
  },

  'queue:drain': (qm, cmd) => {
    const count = qm.drain(cmd.queue ?? '');
    return { queue: cmd.queue, drained: count };
  },

  'queue:clean': (qm, cmd) => {
    const count = qm.clean(cmd.queue ?? '', cmd.graceMs ?? 0, cmd.state, cmd.limit);
    return { queue: cmd.queue, cleaned: count };
  },

  'job:cancel': async (qm, cmd) => {
    const ok = await qm.cancel(jobId(cmd.jobId ?? ''));
    return { cancelled: ok };
  },

  'job:promote': async (qm, cmd) => {
    const ok = await qm.promote(jobId(cmd.jobId ?? ''));
    return { promoted: ok };
  },

  'job:retry': (qm, cmd) => {
    if (cmd.queue) {
      const count = qm.retryDlq(cmd.queue, cmd.jobId ? jobId(cmd.jobId) : undefined);
      return { retried: count };
    }
    return { retried: 0 };
  },

  'dlq:retry': (qm, cmd) => {
    const count = qm.retryDlq(cmd.queue ?? '', cmd.jobId ? jobId(cmd.jobId) : undefined);
    return { retried: count };
  },

  'dlq:purge': (qm, cmd) => {
    const count = qm.purgeDlq(cmd.queue ?? '');
    return { purged: count };
  },

  'cron:upsert': (qm, cmd) => {
    // Remove existing if any, then add
    qm.removeCron(cmd.name ?? '');
    const cron = qm.addCron({
      name: cmd.name ?? '',
      queue: cmd.queue ?? '',
      data: cmd.data ?? {},
      schedule: cmd.schedule,
    });
    return { name: cron.name, nextRun: cron.nextRun };
  },

  'cron:delete': (qm, cmd) => {
    const ok = qm.removeCron(cmd.name ?? '');
    return { deleted: ok };
  },

  'stats:refresh': (qm) => {
    return qm.getStats();
  },

  'job:logs': (qm, cmd) => {
    const logs = qm.getLogs(jobId(cmd.jobId ?? ''));
    return { logs };
  },

  'job:result': (qm, cmd) => {
    const result = qm.getResult(jobId(cmd.jobId ?? ''));
    return { result: result ?? null };
  },

  'job:list': (qm, cmd) => {
    const limit = cmd.limit ?? 50;
    const offset = cmd.offset ?? 0;
    const states = cmd.state
      ? cmd.state.split(',')
      : ['waiting', 'active', 'delayed', 'completed', 'failed'];
    const jobs = qm.getJobs(cmd.queue ?? '', {
      state: states,
      start: offset,
      end: offset + limit - 1,
    });
    return {
      jobs: jobs.map((j) => {
        const data = j.data as Record<string, unknown> | undefined;
        return {
          id: String(j.id),
          name: (data?.name as string | undefined) ?? 'default',
          queue: j.queue,
          state: j.completedAt
            ? 'completed'
            : j.startedAt
              ? 'active'
              : j.runAt > Date.now()
                ? 'delayed'
                : 'waiting',
          data,
          priority: j.priority,
          createdAt: j.createdAt,
          startedAt: j.startedAt ?? null,
          completedAt: j.completedAt ?? null,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          progress: j.progress,
          duration: j.completedAt && j.startedAt ? j.completedAt - j.startedAt : null,
        };
      }),
      total: qm.count(cmd.queue ?? ''),
      offset,
      limit,
    };
  },

  'job:get': async (qm, cmd) => {
    const job = await qm.getJob(jobId(cmd.jobId ?? ''));
    if (!job) return { job: null };
    const data = job.data as Record<string, unknown> | undefined;
    const logs = qm.getLogs(jobId(cmd.jobId ?? ''));
    const result = qm.getResult(jobId(cmd.jobId ?? ''));
    return {
      job: {
        id: String(job.id),
        name: (data?.name as string | undefined) ?? 'default',
        queue: job.queue,
        state: job.completedAt
          ? 'completed'
          : job.startedAt
            ? 'active'
            : job.runAt > Date.now()
              ? 'delayed'
              : 'waiting',
        data,
        priority: job.priority,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        completedAt: job.completedAt ?? null,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        progress: job.progress,
        duration: job.completedAt && job.startedAt ? job.completedAt - job.startedAt : null,
        logs,
        result: result ?? null,
      },
    };
  },

  'queue:detail': (qm, cmd) => {
    const queue = cmd.queue ?? '';
    const counts = qm.getQueueJobCounts(queue);
    const paused = qm.isPaused(queue);
    const stallConfig = qm.getStallConfig(queue);
    const dlqConfig = qm.getDlqConfig(queue);
    const dlqEntries = qm.getDlqEntries(queue).slice(0, 50);
    const jobs = qm.getJobs(queue, {
      state: ['waiting', 'active', 'delayed', 'completed', 'failed'],
      start: 0,
      end: 49,
    });

    return {
      queue,
      paused,
      counts,
      stallConfig: { stallInterval: stallConfig.stallInterval, maxStalls: stallConfig.maxStalls },
      dlqConfig: { maxRetries: dlqConfig.maxAutoRetries, maxAge: dlqConfig.maxAge ?? 0 },
      dlqEntries: dlqEntries.map((e) => ({
        jobId: String(e.job.id),
        reason: e.reason,
        error: e.error,
        enteredAt: e.enteredAt,
        retryCount: e.retryCount,
      })),
      jobs: jobs.map((j) => {
        const data = j.data as Record<string, unknown> | undefined;
        return {
          id: String(j.id),
          name: (data?.name as string | undefined) ?? 'default',
          state: j.completedAt
            ? 'completed'
            : j.startedAt
              ? 'active'
              : j.runAt > Date.now()
                ? 'delayed'
                : 'waiting',
          priority: j.priority,
          createdAt: j.createdAt,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
        };
      }),
    };
  },
};

/** Process a command and return the result */
export async function handleCommand(
  queueManager: QueueManager,
  cmd: CloudCommand
): Promise<CloudCommandResult> {
  const handler = COMMANDS[cmd.action];

  if (!handler) {
    cloudLog.warn('Unknown remote command', { action: cmd.action, id: cmd.id });
    return {
      type: 'command_result',
      id: cmd.id,
      success: false,
      error: `Unknown command: ${cmd.action}`,
    };
  }

  try {
    const data = await handler(queueManager, cmd);
    cloudLog.info('Remote command executed', { action: cmd.action, id: cmd.id });
    return { type: 'command_result', id: cmd.id, success: true, data };
  } catch (err) {
    cloudLog.error('Remote command failed', {
      action: cmd.action,
      id: cmd.id,
      error: String(err),
    });
    return {
      type: 'command_result',
      id: cmd.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
