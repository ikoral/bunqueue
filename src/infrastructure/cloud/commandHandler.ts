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
