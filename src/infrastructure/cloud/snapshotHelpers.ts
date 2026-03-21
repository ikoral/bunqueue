/**
 * Snapshot Helper Collectors
 * Heavy and analytics data collectors used by snapshotCollector.
 */

import type { QueueManager } from '../../application/queueManager';
import { jobId as toJobId } from '../../domain/types/job';
import type { CloudSnapshot } from './types';

/** Per-queue previous totals for delta-based throughput calculation */
const prevQueueTotals = new Map<
  string,
  { completed: number; failed: number; pushed: number; timestamp: number }
>();

/** Per-queue previous waiting count for backlog velocity */
const prevQueueWaiting = new Map<string, { waiting: number; timestamp: number }>();

// ─── Heavy data collectors (called every ~90s) ───

/** Collect recent jobs — only from active queues */
export function collectRecentJobs(
  queueManager: QueueManager,
  activeQueueNames: string[]
): CloudSnapshot['recentJobs'] {
  if (activeQueueNames.length === 0) return [];

  const jobs: CloudSnapshot['recentJobs'] = [];
  const perQueue = Math.max(1, Math.floor(50 / activeQueueNames.length));

  for (const name of activeQueueNames) {
    try {
      const queueJobs = queueManager.getJobs(name, {
        state: ['waiting', 'active', 'delayed', 'completed', 'failed'],
        start: 0,
        end: perQueue - 1,
      });
      for (const j of queueJobs) {
        const data = j.data as Record<string, unknown> | undefined;
        const state = j.completedAt
          ? 'completed'
          : j.startedAt
            ? 'active'
            : j.runAt > Date.now()
              ? 'delayed'
              : 'waiting';

        jobs.push({
          id: String(j.id),
          name: (data?.name as string | undefined) ?? 'default',
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
          duration: j.completedAt && j.startedAt ? j.completedAt - j.startedAt : undefined,
          progress: j.progress > 0 ? j.progress : undefined,
        });
      }
    } catch {
      // Skip queue on error
    }
  }

  return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

/** Collect DLQ entries — only from queues with DLQ > 0 */
export function collectDlqEntries(
  queueManager: QueueManager,
  dlqQueueNames: string[]
): CloudSnapshot['dlqEntries'] {
  if (dlqQueueNames.length === 0) return [];

  const entries: CloudSnapshot['dlqEntries'] = [];

  for (const name of dlqQueueNames) {
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
      // Skip
    }
  }

  return entries.sort((a, b) => b.enteredAt - a.enteredAt).slice(0, 50);
}

/** Collect per-queue config */
export function collectQueueConfigs(
  queueManager: QueueManager,
  queueNames: Set<string>
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
        rateLimit: null,
        concurrencyLimit: null,
        concurrencyActive: pq?.active ?? 0,
        stallConfig: { stallInterval: stall.stallInterval, maxStalls: stall.maxStalls },
        dlqConfig: { maxRetries: dlq.maxAutoRetries, maxAge: dlq.maxAge ?? 0 },
      };
    } catch {
      // Skip
    }
  }

  return configs;
}

/** Collect webhook delivery stats */
export function collectWebhooks(queueManager: QueueManager): CloudSnapshot['webhooks'] {
  try {
    return queueManager.webhookManager.list().map((w) => ({
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

/** Collect top errors — only from queues with DLQ entries */
export function collectTopErrors(
  queueManager: QueueManager,
  dlqQueueNames: string[]
): CloudSnapshot['topErrors'] {
  if (dlqQueueNames.length === 0) return [];

  const errorMap = new Map<string, { count: number; queue: string; lastSeen: number }>();

  const allEntries = dlqQueueNames.flatMap((name) => {
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

// ─── Analytics collectors (derived from recent jobs + queue state) ───

/** Compute per-queue throughput from delta of totalCompleted/totalFailed */
export function collectQueueThroughput(
  queues: Array<{ name: string; totalCompleted: number; totalFailed: number }>
): CloudSnapshot['queueThroughput'] {
  const now = Date.now();
  const result: CloudSnapshot['queueThroughput'] = {};

  for (const q of queues) {
    const prev = prevQueueTotals.get(q.name);
    const total = q.totalCompleted + q.totalFailed;

    if (prev) {
      const elapsedSec = (now - prev.timestamp) / 1000;
      if (elapsedSec > 0.5) {
        const completeDelta = q.totalCompleted - prev.completed;
        const failDelta = q.totalFailed - prev.failed;
        result[q.name] = {
          pushPerSec: Math.round(((completeDelta + failDelta) / elapsedSec) * 100) / 100,
          completePerSec: Math.round((completeDelta / elapsedSec) * 100) / 100,
          failPerSec: Math.round((failDelta / elapsedSec) * 100) / 100,
          errorRate: total > 0 ? Math.round((q.totalFailed / total) * 10000) / 10000 : 0,
        };
      }
    }

    prevQueueTotals.set(q.name, {
      completed: q.totalCompleted,
      failed: q.totalFailed,
      pushed: q.totalCompleted + q.totalFailed,
      timestamp: now,
    });
  }

  return result;
}

/** Compute per-worker utilization */
export function collectWorkerUtilization(
  queueManager: QueueManager
): CloudSnapshot['workerUtilization'] {
  return queueManager.workerManager.list().map((w) => ({
    id: w.id,
    name: w.name,
    utilization: w.concurrency > 0 ? Math.round((w.activeJobs / w.concurrency) * 100) / 100 : 0,
  }));
}

/** Compute duration histogram from recent jobs */
export function collectDurationHistogram(
  recentJobs: CloudSnapshot['recentJobs']
): CloudSnapshot['durationHistogram'] {
  const h = { lt100ms: 0, lt1s: 0, lt10s: 0, lt60s: 0, gt60s: 0 };
  for (const j of recentJobs) {
    if (!j.duration) continue;
    if (j.duration < 100) h.lt100ms++;
    else if (j.duration < 1000) h.lt1s++;
    else if (j.duration < 10000) h.lt10s++;
    else if (j.duration < 60000) h.lt60s++;
    else h.gt60s++;
  }
  return h;
}

/** Compute per-queue wait time (createdAt → startedAt) from recent jobs */
export function collectQueueWaitTime(
  recentJobs: CloudSnapshot['recentJobs']
): CloudSnapshot['queueWaitTime'] {
  const byQueue = new Map<string, number[]>();
  for (const j of recentJobs) {
    if (!j.startedAt || !j.createdAt) continue;
    const wait = j.startedAt - j.createdAt;
    if (wait < 0) continue;
    let arr = byQueue.get(j.queue);
    if (!arr) {
      arr = [];
      byQueue.set(j.queue, arr);
    }
    arr.push(wait);
  }

  const result: CloudSnapshot['queueWaitTime'] = {};
  for (const [queue, waits] of byQueue) {
    const sum = waits.reduce((a, b) => a + b, 0);
    result[queue] = {
      avgMs: Math.round(sum / waits.length),
      maxMs: Math.max(...waits),
      minMs: Math.min(...waits),
    };
  }
  return result;
}

/** Compute per-queue retry rate from recent jobs */
export function collectQueueRetryRate(
  recentJobs: CloudSnapshot['recentJobs']
): CloudSnapshot['queueRetryRate'] {
  const byQueue = new Map<string, { retrying: number; total: number }>();
  for (const j of recentJobs) {
    let entry = byQueue.get(j.queue);
    if (!entry) {
      entry = { retrying: 0, total: 0 };
      byQueue.set(j.queue, entry);
    }
    entry.total++;
    if (j.attempts > 0) entry.retrying++;
  }

  const result: CloudSnapshot['queueRetryRate'] = {};
  for (const [queue, data] of byQueue) {
    result[queue] = {
      retryRate: data.total > 0 ? Math.round((data.retrying / data.total) * 10000) / 10000 : 0,
      retrying: data.retrying,
      total: data.total,
    };
  }
  return result;
}

/** Compute queue backlog velocity (delta waiting between snapshots) */
export function collectBacklogVelocity(
  queues: Array<{ name: string; waiting: number }>
): CloudSnapshot['queueBacklogVelocity'] {
  const now = Date.now();
  const result: CloudSnapshot['queueBacklogVelocity'] = {};

  for (const q of queues) {
    const prev = prevQueueWaiting.get(q.name);
    if (prev) {
      const elapsedMin = (now - prev.timestamp) / 60000;
      if (elapsedMin > 0.1) {
        const delta = q.waiting - prev.waiting;
        const deltaPerMin = Math.round((delta / elapsedMin) * 100) / 100;
        result[q.name] = {
          deltaWaiting: delta,
          deltaPerMin,
          trend: deltaPerMin > 5 ? 'growing' : deltaPerMin < -5 ? 'shrinking' : 'stable',
        };
      }
    }
    prevQueueWaiting.set(q.name, { waiting: q.waiting, timestamp: now });
  }

  return result;
}

/** Collect stall details from processing shards */
export async function collectStallDetails(
  queueManager: QueueManager
): Promise<CloudSnapshot['stallDetails']> {
  try {
    const memStats = queueManager.getMemoryStats();
    if (memStats.stalledCandidates === 0) return [];

    const stalledIds = (queueManager as unknown as { stalledCandidates: Set<string> })
      .stalledCandidates;
    if (stalledIds.size === 0) return [];

    const now = Date.now();
    const details: CloudSnapshot['stallDetails'] = [];
    const ids = [...stalledIds].slice(0, 20);
    for (const id of ids) {
      try {
        const job = await queueManager.getJob(toJobId(id));
        if (!job) continue;
        details.push({
          jobId: id,
          queue: job.queue,
          workerId: null,
          stalledAt: job.startedAt ?? now,
          stalledForMs: now - (job.startedAt ?? now),
        });
      } catch {
        // Skip
      }
    }
    return details;
  } catch {
    return [];
  }
}

/** Compute per-queue priority distribution from recent jobs */
export function collectPriorityDistribution(
  recentJobs: CloudSnapshot['recentJobs']
): CloudSnapshot['queuePriorityDistribution'] {
  const result: CloudSnapshot['queuePriorityDistribution'] = {};
  for (const j of recentJobs) {
    result[j.queue] ??= {};
    result[j.queue][j.priority] = (result[j.queue][j.priority] ?? 0) + 1;
  }
  return result;
}
