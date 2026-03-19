/**
 * Snapshot Collector
 * Gathers telemetry data from all bunqueue managers into a single snapshot
 */

import { hostname } from 'os';
import type { QueueManager } from '../../application/queueManager';
import { throughputTracker } from '../../application/throughputTracker';
import { latencyTracker } from '../../application/latencyTracker';
import { getTaskErrorStats } from '../../application/backgroundTasks';
import { VERSION } from '../../shared/version';
import type { CloudSnapshot } from './types';

/** Cached hostname — computed once */
const HOST = hostname();

/** Optional server handles for connection stats + backup */
export interface ServerHandles {
  getConnectionCount: () => number;
  getWsClientCount: () => number;
  getSseClientCount: () => number;
  getBackupStatus?: () => {
    enabled: boolean;
    bucket: string;
    endpoint: string;
    intervalMs: number;
    retention: number;
    isRunning: boolean;
  } | null;
}

/** Parameters for snapshot collection */
export interface CollectSnapshotParams {
  queueManager: QueueManager;
  instanceId: string;
  instanceName: string;
  startedAt: number;
  sequenceId: number;
  serverHandles?: ServerHandles;
}

/** Collect a full snapshot from all managers. O(SHARD_COUNT) total. */
export function collectSnapshot(params: CollectSnapshotParams): CloudSnapshot {
  const { queueManager, instanceId, instanceName, startedAt, sequenceId, serverHandles } = params;
  const stats = queueManager.getStats();
  const memStats = queueManager.getMemoryStats();
  const workerStats = queueManager.workerManager.getStats();
  const rates = throughputTracker.getRates();
  const percentiles = latencyTracker.getPercentiles();
  const averages = latencyTracker.getAverages();
  const storage = queueManager.getStorageStatus();
  const crons = queueManager.listCrons();
  const mem = process.memoryUsage();

  // Per-queue stats (includes DLQ counts)
  const perQueue = queueManager.getPerQueueStats();
  const queuesSummary = queueManager.getQueuesSummary();
  const queueNames = queuesSummary.map((q) => q.name);
  const queues = queuesSummary.map((q) => {
    const pq = perQueue.get(q.name);
    const counts = queueManager.getQueueJobCounts(q.name);
    return {
      name: q.name,
      waiting: pq?.waiting ?? q.counts.waiting,
      delayed: pq?.delayed ?? q.counts.delayed,
      active: pq?.active ?? q.counts.active,
      dlq: pq?.dlq ?? 0,
      paused: q.paused,
      totalCompleted: counts.totalCompleted,
      totalFailed: counts.totalFailed,
    };
  });

  return {
    instanceId,
    instanceName,
    version: VERSION,
    hostname: HOST,
    pid: process.pid,
    startedAt,
    timestamp: Date.now(),
    sequenceId,

    stats: {
      waiting: stats.waiting,
      delayed: stats.delayed,
      active: stats.active,
      dlq: stats.dlq,
      completed: stats.completed,
      stalled: memStats.stalledCandidates,
      paused: queuesSummary.filter((q) => q.paused).length,
      totalPushed: String(stats.totalPushed),
      totalPulled: String(stats.totalPulled),
      totalCompleted: String(stats.totalCompleted),
      totalFailed: String(stats.totalFailed),
      uptime: stats.uptime,
      cronJobs: stats.cronJobs,
      cronPending: stats.cronPending,
    },

    throughput: rates,

    latency: {
      averages,
      percentiles,
    },

    memory: {
      heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
    },

    collections: {
      jobIndex: memStats.jobIndex,
      completedJobs: memStats.completedJobs,
      jobResults: memStats.jobResults,
      jobLogs: memStats.jobLogs,
      customIdMap: memStats.customIdMap,
      jobLocks: memStats.jobLocks,
      processingTotal: memStats.processingTotal,
      queuedTotal: memStats.queuedTotal,
      temporalIndexTotal: memStats.temporalIndexTotal,
      delayedHeapTotal: memStats.delayedHeapTotal,
    },

    queues,

    workers: workerStats,

    crons: crons.map((c) => ({
      name: c.name,
      queue: c.queue,
      schedule: c.schedule ?? null,
      nextRun: c.nextRun,
      executions: c.executions,
      maxLimit: c.maxLimit,
    })),

    storage: {
      diskFull: storage.diskFull,
      error: storage.error,
    },

    taskErrors: getTaskErrorStats(),

    // Recent jobs (last 50 across all queues, lightweight — no job data)
    recentJobs: collectRecentJobs(queueManager, queueNames),

    // DLQ entries (last 50 across all queues)
    dlqEntries: collectDlqEntries(queueManager, queueNames),

    // Worker details
    workerDetails: queueManager.workerManager.list().map((w) => ({
      id: w.id,
      name: w.name,
      queues: w.queues,
      concurrency: w.concurrency,
      hostname: w.hostname,
      pid: w.pid,
      lastSeen: w.lastSeen,
      activeJobs: w.activeJobs,
      processedJobs: w.processedJobs,
      failedJobs: w.failedJobs,
      currentJob: w.currentJob,
    })),

    // Per-queue config (includes rate limit + concurrency)
    queueConfigs: collectQueueConfigs(queueManager, queueNames),

    // Connection stats
    connections: {
      tcp: serverHandles?.getConnectionCount() ?? 0,
      ws: serverHandles?.getWsClientCount() ?? 0,
      sse: serverHandles?.getSseClientCount() ?? 0,
    },

    // Webhooks with delivery stats
    webhooks: collectWebhooks(queueManager),

    // Top errors from DLQ entries
    topErrors: collectTopErrors(queueManager, queueNames),

    // S3 backup status
    s3Backup: serverHandles?.getBackupStatus?.() ?? null,
  };
}

/** Collect recent jobs across queues (max 50, newest first) */
function collectRecentJobs(
  queueManager: QueueManager,
  queueNames: string[]
): CloudSnapshot['recentJobs'] {
  const jobs: CloudSnapshot['recentJobs'] = [];
  const perQueue = Math.max(1, Math.floor(50 / (queueNames.length || 1)));

  for (const name of queueNames) {
    try {
      const queueJobs = queueManager.getJobs(name, {
        state: ['waiting', 'active', 'delayed'],
        start: 0,
        end: perQueue - 1,
      });
      for (const j of queueJobs) {
        const data = j.data as Record<string, unknown> | undefined;
        const jobName = (data?.name as string | undefined) ?? 'default';
        const state = j.completedAt
          ? 'completed'
          : j.startedAt
            ? 'active'
            : j.runAt > Date.now()
              ? 'delayed'
              : 'waiting';
        const duration = j.completedAt && j.startedAt ? j.completedAt - j.startedAt : undefined;

        jobs.push({
          id: String(j.id),
          name: jobName,
          queue: j.queue,
          state,
          data,
          priority: j.priority,
          createdAt: j.createdAt,
          startedAt: j.startedAt ?? undefined,
          completedAt: j.completedAt ?? undefined,
          failedReason:
            state === 'active' && j.attempts > 0
              ? `Retry ${j.attempts}/${j.maxAttempts}`
              : undefined,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          duration,
          progress: j.progress > 0 ? j.progress : undefined,
        });
      }
    } catch {
      // Skip queue on error
    }
  }

  // Sort by createdAt desc, limit 50
  return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

/** Collect DLQ entries across queues (max 50) */
function collectDlqEntries(
  queueManager: QueueManager,
  queueNames: string[]
): CloudSnapshot['dlqEntries'] {
  const entries: CloudSnapshot['dlqEntries'] = [];

  for (const name of queueNames) {
    try {
      const dlq = queueManager.getDlqEntries(name);
      for (const e of dlq.slice(0, 20)) {
        entries.push({
          jobId: String(e.job.id),
          queue: e.job.queue,
          reason: e.reason,
          error: e.error,
          enteredAt: e.enteredAt,
          retryCount: e.retryCount,
          attempts: e.job.attempts,
        });
      }
    } catch {
      // Skip queue on error
    }
  }

  return entries.sort((a, b) => b.enteredAt - a.enteredAt).slice(0, 50);
}

/** Collect per-queue config */
function collectQueueConfigs(
  queueManager: QueueManager,
  queueNames: string[]
): CloudSnapshot['queueConfigs'] {
  const configs: CloudSnapshot['queueConfigs'] = {};
  const perQueue = queueManager.getPerQueueStats();

  for (const name of queueNames) {
    try {
      const stall = queueManager.getStallConfig(name);
      const dlq = queueManager.getDlqConfig(name);
      const pq = perQueue.get(name);
      configs[name] = {
        paused: queueManager.isPaused(name),
        rateLimit: null, // TODO: expose from QueueManager
        concurrencyLimit: null, // TODO: expose from QueueManager
        concurrencyActive: pq?.active ?? 0,
        stallConfig: { stallInterval: stall.stallInterval, maxStalls: stall.maxStalls },
        dlqConfig: { maxRetries: dlq.maxAutoRetries, maxAge: dlq.maxAge ?? 0 },
      };
    } catch {
      // Skip on error
    }
  }

  return configs;
}

/** Collect webhook delivery stats */
function collectWebhooks(queueManager: QueueManager): CloudSnapshot['webhooks'] {
  try {
    const webhooks = queueManager.webhookManager.list();
    return webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      queue: w.queue,
      enabled: w.enabled,
      successCount: w.successCount,
      failureCount: w.failureCount,
      lastTriggered: w.lastTriggered,
    }));
  } catch {
    return [];
  }
}

/** Collect top errors from DLQ entries, grouped by message */
function collectTopErrors(
  queueManager: QueueManager,
  queueNames: string[]
): CloudSnapshot['topErrors'] {
  const errorMap = new Map<string, { count: number; queue: string; lastSeen: number }>();

  const allEntries = queueNames.flatMap((name) => {
    try {
      return queueManager.getDlqEntries(name);
    } catch {
      return [];
    }
  });

  for (const e of allEntries) {
    const msg = e.error ?? e.reason;
    const existing = errorMap.get(msg);
    if (existing) {
      existing.count++;
      if (e.enteredAt > existing.lastSeen) {
        existing.lastSeen = e.enteredAt;
        existing.queue = e.job.queue;
      }
    } else {
      errorMap.set(msg, { count: 1, queue: e.job.queue, lastSeen: e.enteredAt });
    }
  }

  return [...errorMap.entries()]
    .map(([message, data]) => ({ message, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}
