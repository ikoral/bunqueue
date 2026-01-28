/**
 * Monitoring Handlers
 * Handles logs, workers, webhooks, and prometheus metrics
 */

import type { JobId } from '../../../domain/types/job';
import type {
  AddLogCommand,
  GetLogsCommand,
  HeartbeatCommand,
  RegisterWorkerCommand,
  UnregisterWorkerCommand,
  ListWorkersCommand,
  AddWebhookCommand,
  RemoveWebhookCommand,
  ListWebhooksCommand,
  PrometheusCommand,
} from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import type { HandlerContext } from '../types';

// ============ Job Logs ============

export async function handleAddLog(
  cmd: AddLogCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const jobId = BigInt(cmd.id) as JobId;
  const level = cmd.level ?? 'info';
  const success = ctx.queueManager.addLog(jobId, cmd.message, level);

  if (success) {
    return resp.data({ added: true }, reqId);
  }
  return resp.error('Job not found', reqId);
}

export async function handleGetLogs(
  cmd: GetLogsCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const jobId = BigInt(cmd.id) as JobId;
  const logs = ctx.queueManager.getLogs(jobId);
  return resp.data({ logs }, reqId);
}

// ============ Worker Heartbeat ============

export async function handleHeartbeat(
  cmd: HeartbeatCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = ctx.queueManager.workerManager.heartbeat(cmd.id);
  if (success) {
    return resp.data({ ok: true }, reqId);
  }
  return resp.error('Worker not found', reqId);
}

// ============ Worker Management ============

export async function handleRegisterWorker(
  cmd: RegisterWorkerCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const worker = ctx.queueManager.workerManager.register(cmd.name, cmd.queues);
  return resp.data(
    {
      workerId: worker.id,
      name: worker.name,
      queues: worker.queues,
      registeredAt: worker.registeredAt,
    },
    reqId
  );
}

export async function handleUnregisterWorker(
  cmd: UnregisterWorkerCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = ctx.queueManager.workerManager.unregister(cmd.workerId);
  if (success) {
    return resp.data({ removed: true }, reqId);
  }
  return resp.error('Worker not found', reqId);
}

export async function handleListWorkers(
  _cmd: ListWorkersCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const workers = ctx.queueManager.workerManager.list();
  return resp.data(
    {
      workers: workers.map((w) => ({
        id: w.id,
        name: w.name,
        queues: w.queues,
        registeredAt: w.registeredAt,
        lastSeen: w.lastSeen,
        activeJobs: w.activeJobs,
        processedJobs: w.processedJobs,
        failedJobs: w.failedJobs,
      })),
      stats: ctx.queueManager.workerManager.getStats(),
    },
    reqId
  );
}

// ============ Webhooks ============

export async function handleAddWebhook(
  cmd: AddWebhookCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const webhook = ctx.queueManager.webhookManager.add(cmd.url, cmd.events, cmd.queue, cmd.secret);
  return resp.data(
    {
      webhookId: webhook.id,
      url: webhook.url,
      events: webhook.events,
      queue: webhook.queue,
      createdAt: webhook.createdAt,
    },
    reqId
  );
}

export async function handleRemoveWebhook(
  cmd: RemoveWebhookCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const success = ctx.queueManager.webhookManager.remove(cmd.webhookId);
  if (success) {
    return resp.data({ removed: true }, reqId);
  }
  return resp.error('Webhook not found', reqId);
}

export async function handleListWebhooks(
  _cmd: ListWebhooksCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const webhooks = ctx.queueManager.webhookManager.list();
  return resp.data(
    {
      webhooks: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        events: w.events,
        queue: w.queue,
        createdAt: w.createdAt,
        lastTriggered: w.lastTriggered,
        successCount: w.successCount,
        failureCount: w.failureCount,
        enabled: w.enabled,
      })),
      stats: ctx.queueManager.webhookManager.getStats(),
    },
    reqId
  );
}

// ============ Prometheus Metrics ============

export async function handlePrometheus(
  _cmd: PrometheusCommand,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const metrics = ctx.queueManager.getPrometheusMetrics();
  return resp.data({ metrics }, reqId);
}
