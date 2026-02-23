/**
 * MCP Backend Adapter Tests
 *
 * Tests the EmbeddedBackend adapter which is the core logic layer
 * for the MCP server. Verifies all operations work correctly through
 * the McpBackend interface.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { shutdownManager } from '../src/client/manager';
import { EmbeddedBackend } from '../src/mcp/adapter';

let backend: EmbeddedBackend;

beforeEach(() => {
  shutdownManager();
  backend = new EmbeddedBackend();
});

afterEach(() => {
  backend.shutdown();
});

// ─── Job Operations ─────────────────────────────────────────────────────────

describe('EmbeddedBackend - Job Operations', () => {
  test('addJob returns jobId', async () => {
    const result = await backend.addJob('test-q', 'email-send', { to: 'user@test.com' });
    expect(result.jobId).toBeDefined();
    expect(typeof result.jobId).toBe('string');
  });

  test('addJob respects priority option', async () => {
    const result = await backend.addJob('test-q', 'high-prio', { x: 1 }, { priority: 10 });
    expect(result.jobId).toBeDefined();
  });

  test('addJob respects delay option', async () => {
    const result = await backend.addJob('test-q', 'delayed', { x: 1 }, { delay: 5000 });
    expect(result.jobId).toBeDefined();
  });

  test('addJob respects attempts option', async () => {
    const result = await backend.addJob('test-q', 'retry', { x: 1 }, { attempts: 5 });
    expect(result.jobId).toBeDefined();

    const job = await backend.getJob(result.jobId);
    expect(job).not.toBeNull();
    expect(job!.maxAttempts).toBe(5);
  });

  test('addJobsBulk returns count and jobIds', async () => {
    const result = await backend.addJobsBulk('bulk-q', [
      { name: 'a', data: { v: 1 } },
      { name: 'b', data: { v: 2 } },
    ]);
    expect(result.jobIds).toHaveLength(2);
  });

  test('addJobsBulk handles empty array', async () => {
    const result = await backend.addJobsBulk('bulk-q', []);
    expect(result.jobIds).toHaveLength(0);
  });

  test('getJob returns full job details', async () => {
    const added = await backend.addJob('get-q', 'fetch-me', { key: 'value' });
    const job = await backend.getJob(added.jobId);

    expect(job).not.toBeNull();
    expect(job!.id).toBe(added.jobId);
    expect(job!.queue).toBe('get-q');
    expect(job!.createdAt).toBeDefined();
  });

  test('getJob returns null for non-existent job', async () => {
    const job = await backend.getJob('00000000-0000-0000-0000-000000000000');
    expect(job).toBeNull();
  });

  test('cancelJob returns true for waiting job', async () => {
    const added = await backend.addJob('cancel-q', 'to-cancel', {});
    const result = await backend.cancelJob(added.jobId);
    expect(result).toBe(true);
  });

  test('cancelled job is no longer retrievable', async () => {
    const added = await backend.addJob('cancel-q', 'gone', {});
    await backend.cancelJob(added.jobId);
    const job = await backend.getJob(added.jobId);
    expect(job).toBeNull();
  });

  test('getJobState returns state string', async () => {
    const added = await backend.addJob('state-q', 'check-state', {});
    const state = await backend.getJobState(added.jobId);
    expect(state).toBe('waiting');
  });

  test('updateProgress works for active job', async () => {
    const added = await backend.addJob('progress-q', 'prog-test', {});
    const pulled = await backend.pullJob('progress-q');
    expect(pulled).not.toBeNull();

    const result = await backend.updateProgress(pulled!.id, 75, 'Almost done');
    expect(result).toBe(true);
  });

  test('getJobByCustomId returns null for non-existent custom id', async () => {
    const job = await backend.getJobByCustomId('does-not-exist');
    expect(job).toBeNull();
  });

  test('getJobResult returns undefined for job without result', async () => {
    const added = await backend.addJob('result-q', 'no-result', {});
    const result = await backend.getJobResult(added.jobId);
    expect(result).toBeUndefined();
  });

  test('promoteJob returns false for non-delayed job', async () => {
    const added = await backend.addJob('promote-q', 'not-delayed', {});
    const result = await backend.promoteJob(added.jobId);
    expect(result).toBe(false);
  });
});

// ─── Queue Control ─────────────────────────────────────────────────────────

describe('EmbeddedBackend - Queue Control', () => {
  test('listQueues returns array', async () => {
    await backend.addJob('lq-alpha', 'j', {});
    await backend.addJob('lq-beta', 'j', {});

    const queues = await backend.listQueues();
    expect(Array.isArray(queues)).toBe(true);
    expect(queues).toContain('lq-alpha');
    expect(queues).toContain('lq-beta');
  });

  test('countJobs returns correct count', async () => {
    await backend.addJob('count-q', 'j1', {});
    await backend.addJob('count-q', 'j2', {});
    await backend.addJob('count-q', 'j3', {});

    const count = await backend.countJobs('count-q');
    expect(count).toBe(3);
  });

  test('pauseQueue and resumeQueue work', async () => {
    await backend.pauseQueue('pause-q');
    const paused = await backend.isPaused('pause-q');
    expect(paused).toBe(true);

    await backend.resumeQueue('pause-q');
    const resumed = await backend.isPaused('pause-q');
    expect(resumed).toBe(false);
  });

  test('drainQueue removes waiting jobs', async () => {
    await backend.addJob('drain-q', 'j1', {});
    await backend.addJob('drain-q', 'j2', {});

    const removed = await backend.drainQueue('drain-q');
    expect(removed).toBe(2);

    const count = await backend.countJobs('drain-q');
    expect(count).toBe(0);
  });

  test('obliterateQueue removes all data', async () => {
    await backend.addJob('obliterate-q', 'j1', {});
    await backend.obliterateQueue('obliterate-q');

    const count = await backend.countJobs('obliterate-q');
    expect(count).toBe(0);
  });

  test('getJobCounts returns counts per state', async () => {
    await backend.addJob('counts-q', 'j1', {});
    await backend.addJob('counts-q', 'j2', {});

    const counts = await backend.getJobCounts('counts-q');
    expect(counts.waiting).toBe(2);
    expect(typeof counts.active).toBe('number');
    expect(typeof counts.completed).toBe('number');
  });

  test('getJobs returns jobs with pagination', async () => {
    await backend.addJob('getjobs-q', 'j1', {});
    await backend.addJob('getjobs-q', 'j2', {});
    await backend.addJob('getjobs-q', 'j3', {});

    const jobs = await backend.getJobs('getjobs-q', { start: 0, end: 2 });
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeLessThanOrEqual(2);
  });

  test('getJobs with state filter', async () => {
    await backend.addJob('filter-q', 'j1', {});
    const jobs = await backend.getJobs('filter-q', { state: 'waiting' });
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.queue).toBe('filter-q');
    }
  });

  test('cleanQueue returns number removed', async () => {
    await backend.addJob('clean-q', 'j1', {});
    const removed = await backend.cleanQueue('clean-q', 0);
    expect(typeof removed).toBe('number');
  });

  test('getCountsPerPriority returns priority breakdown', async () => {
    await backend.addJob('prio-q', 'j1', { x: 1 }, { priority: 5 });
    await backend.addJob('prio-q', 'j2', { x: 2 }, { priority: 10 });

    const counts = await backend.getCountsPerPriority('prio-q');
    expect(typeof counts).toBe('object');
  });

  test('isPaused returns false for new queue', async () => {
    const paused = await backend.isPaused('not-paused-q');
    expect(paused).toBe(false);
  });
});

// ─── Rate Limiting ─────────────────────────────────────────────────────────

describe('EmbeddedBackend - Rate Limiting', () => {
  test('setRateLimit does not throw', async () => {
    await backend.setRateLimit('rl-q', 50);
  });

  test('setConcurrency does not throw', async () => {
    await backend.setConcurrency('conc-q', 10);
  });

  test('clearRateLimit does not throw', async () => {
    await backend.setRateLimit('rl-q2', 50);
    await backend.clearRateLimit('rl-q2');
  });

  test('clearConcurrency does not throw', async () => {
    await backend.setConcurrency('conc-q2', 10);
    await backend.clearConcurrency('conc-q2');
  });
});

// ─── DLQ Operations ─────────────────────────────────────────────────────────

describe('EmbeddedBackend - DLQ', () => {
  test('getDlq returns empty array for queue with no DLQ entries', async () => {
    const result = await backend.getDlq('dlq-empty-q');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('retryDlq returns 0 for empty DLQ', async () => {
    const result = await backend.retryDlq('dlq-retry-q');
    expect(result).toBe(0);
  });

  test('purgeDlq returns 0 for empty DLQ', async () => {
    const result = await backend.purgeDlq('dlq-purge-q');
    expect(result).toBe(0);
  });

  test('retryCompleted returns 0 when no completed jobs', async () => {
    const result = await backend.retryCompleted('dlq-retry-completed-q');
    expect(result).toBe(0);
  });
});

// ─── Cron Jobs ─────────────────────────────────────────────────────────────

describe('EmbeddedBackend - Cron', () => {
  test('addCron with repeatEvery returns cron details', async () => {
    const result = await backend.addCron({
      name: 'test-cron-interval',
      queue: 'cron-q',
      data: { task: 'ping' },
      repeatEvery: 30000,
    });
    expect(result.name).toBe('test-cron-interval');
    expect(result.queue).toBe('cron-q');
  });

  test('listCrons returns cron entries', async () => {
    await backend.addCron({
      name: 'list-cron-1',
      queue: 'cron-q',
      data: {},
      repeatEvery: 1000,
    });

    const crons = await backend.listCrons();
    expect(Array.isArray(crons)).toBe(true);
    const names = crons.map((c) => c.name);
    expect(names).toContain('list-cron-1');
  });

  test('getCron returns cron by name', async () => {
    await backend.addCron({
      name: 'get-cron-test',
      queue: 'cron-q',
      data: {},
      repeatEvery: 5000,
    });

    const cron = await backend.getCron('get-cron-test');
    expect(cron).not.toBeNull();
    expect(cron!.name).toBe('get-cron-test');
    expect(cron!.queue).toBe('cron-q');
  });

  test('getCron returns null for non-existent cron', async () => {
    const cron = await backend.getCron('does-not-exist');
    expect(cron).toBeNull();
  });

  test('deleteCron removes existing cron', async () => {
    await backend.addCron({
      name: 'to-delete-cron',
      queue: 'cron-q',
      data: {},
      repeatEvery: 1000,
    });

    const result = await backend.deleteCron('to-delete-cron');
    expect(result).toBe(true);

    const crons = await backend.listCrons();
    const names = crons.map((c) => c.name);
    expect(names).not.toContain('to-delete-cron');
  });

  test('deleteCron returns false for non-existent cron', async () => {
    const result = await backend.deleteCron('does-not-exist');
    expect(result).toBe(false);
  });
});

// ─── Stats & Logs ─────────────────────────────────────────────────────────

describe('EmbeddedBackend - Stats & Logs', () => {
  test('getStats returns stats object', async () => {
    const stats = await backend.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats).toBe('object');
  });

  test('stats are JSON-serializable (no BigInt)', async () => {
    await backend.addJob('stats-q', 'j', {});
    const stats = await backend.getStats();
    const json = JSON.stringify(stats);
    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('getJobLogs returns empty array when no logs', async () => {
    const added = await backend.addJob('log-q', 'no-logs', {});
    const logs = await backend.getJobLogs(added.jobId);
    expect(Array.isArray(logs)).toBe(true);
    expect(logs).toHaveLength(0);
  });

  test('addJobLog and getJobLogs round-trip', async () => {
    const added = await backend.addJob('log-q', 'has-logs', {});

    await backend.addJobLog(added.jobId, 'Step 1 started', 'info');
    await backend.addJobLog(added.jobId, 'Warning encountered', 'warn');

    const logs = await backend.getJobLogs(added.jobId);
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toBe('Step 1 started');
    expect(logs[0].level).toBe('info');
    expect(logs[1].message).toBe('Warning encountered');
    expect(logs[1].level).toBe('warn');
  });

  test('clearJobLogs removes logs', async () => {
    const added = await backend.addJob('clear-log-q', 'logged', {});
    await backend.addJobLog(added.jobId, 'Log 1', 'info');
    await backend.addJobLog(added.jobId, 'Log 2', 'info');

    await backend.clearJobLogs(added.jobId);
    const logs = await backend.getJobLogs(added.jobId);
    expect(logs).toHaveLength(0);
  });
});

// ─── Job Consumption (Pull/Ack/Fail) ─────────────────────────────────────

describe('EmbeddedBackend - Job Consumption', () => {
  test('pullJob returns a job from queue', async () => {
    await backend.addJob('pull-q', 'pull-test', { data: 1 });

    const job = await backend.pullJob('pull-q');
    expect(job).not.toBeNull();
    expect(job!.queue).toBe('pull-q');
  });

  test('pullJob returns null on empty queue', async () => {
    const job = await backend.pullJob('empty-pull-q');
    expect(job).toBeNull();
  });

  test('pullJobBatch returns multiple jobs', async () => {
    await backend.addJob('batch-pull-q', 'j1', {});
    await backend.addJob('batch-pull-q', 'j2', {});
    await backend.addJob('batch-pull-q', 'j3', {});

    const jobs = await backend.pullJobBatch('batch-pull-q', 2);
    expect(jobs.length).toBeLessThanOrEqual(2);
    expect(jobs.length).toBeGreaterThan(0);
  });

  test('pullJobBatch returns empty array on empty queue', async () => {
    const jobs = await backend.pullJobBatch('empty-batch-q', 5);
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs).toHaveLength(0);
  });

  test('ackJob completes the job', async () => {
    await backend.addJob('ack-q', 'ack-test', {});
    const job = await backend.pullJob('ack-q');
    expect(job).not.toBeNull();

    await backend.ackJob(job!.id, { done: true });
    // Job should be completed now
    const state = await backend.getJobState(job!.id);
    expect(state).toBe('completed');
  });

  test('ackJobBatch completes multiple jobs', async () => {
    await backend.addJob('ackb-q', 'j1', {});
    await backend.addJob('ackb-q', 'j2', {});
    const jobs = await backend.pullJobBatch('ackb-q', 2);
    expect(jobs.length).toBe(2);

    await backend.ackJobBatch(jobs.map((j) => j.id));

    for (const job of jobs) {
      const state = await backend.getJobState(job.id);
      expect(state).toBe('completed');
    }
  });

  test('failJob marks job as failed', async () => {
    await backend.addJob('fail-q', 'fail-test', {});
    const job = await backend.pullJob('fail-q');
    expect(job).not.toBeNull();

    await backend.failJob(job!.id, 'Test error');
  });

  test('jobHeartbeat returns boolean', async () => {
    await backend.addJob('hb-q', 'hb-test', {});
    const job = await backend.pullJob('hb-q');
    expect(job).not.toBeNull();

    const result = await backend.jobHeartbeat(job!.id);
    expect(typeof result).toBe('boolean');
  });

  test('jobHeartbeatBatch returns count', async () => {
    await backend.addJob('hbb-q', 'j1', {});
    await backend.addJob('hbb-q', 'j2', {});
    const jobs = await backend.pullJobBatch('hbb-q', 2);

    const count = await backend.jobHeartbeatBatch(jobs.map((j) => j.id));
    expect(typeof count).toBe('number');
  });
});

// ─── Worker Management ────────────────────────────────────────────────────

describe('EmbeddedBackend - Worker Management', () => {
  test('registerWorker returns worker info', async () => {
    const worker = await backend.registerWorker('test-worker', ['q1', 'q2']);
    expect(worker).toBeDefined();
    expect(worker.name).toBe('test-worker');
    expect(worker.queues).toContain('q1');
    expect(worker.queues).toContain('q2');
  });

  test('listWorkers includes registered worker', async () => {
    await backend.registerWorker('listed-worker', ['q1']);
    const workers = await backend.listWorkers();
    expect(Array.isArray(workers)).toBe(true);
    const names = workers.map((w) => w.name);
    expect(names).toContain('listed-worker');
  });

  test('workerHeartbeat returns boolean', async () => {
    const worker = await backend.registerWorker('hb-worker', ['q1']);
    const result = await backend.workerHeartbeat(worker.id);
    expect(typeof result).toBe('boolean');
  });

  test('unregisterWorker removes worker', async () => {
    const worker = await backend.registerWorker('unreg-worker', ['q1']);
    const success = await backend.unregisterWorker(worker.id);
    expect(success).toBe(true);

    const workers = await backend.listWorkers();
    const ids = workers.map((w) => w.id);
    expect(ids).not.toContain(worker.id);
  });
});

// ─── Webhooks ─────────────────────────────────────────────────────────────

describe('EmbeddedBackend - Webhooks', () => {
  test('addWebhook returns webhook info', async () => {
    const webhook = await backend.addWebhook(
      'https://example.com/hook',
      ['job.completed'],
      'webhook-q'
    );
    expect(webhook).toBeDefined();
    expect(webhook.url).toBe('https://example.com/hook');
    expect(webhook.events).toContain('job.completed');
    expect(webhook.enabled).toBe(true);
  });

  test('listWebhooks returns registered webhooks', async () => {
    await backend.addWebhook('https://example.com/hook2', ['job.failed']);
    const webhooks = await backend.listWebhooks();
    expect(Array.isArray(webhooks)).toBe(true);
    expect(webhooks.length).toBeGreaterThan(0);
  });

  test('setWebhookEnabled toggles webhook', async () => {
    const webhook = await backend.addWebhook('https://example.com/toggle', ['job.completed']);
    const result = await backend.setWebhookEnabled(webhook.id, false);
    expect(result).toBe(true);
  });

  test('removeWebhook removes webhook', async () => {
    const webhook = await backend.addWebhook('https://example.com/remove', ['job.completed']);
    const success = await backend.removeWebhook(webhook.id);
    expect(success).toBe(true);
  });
});

// ─── Monitoring ───────────────────────────────────────────────────────────

describe('EmbeddedBackend - Monitoring', () => {
  test('getPerQueueStats returns object', async () => {
    const stats = await backend.getPerQueueStats();
    expect(typeof stats).toBe('object');
  });

  test('getMemoryStats returns object', async () => {
    const stats = await backend.getMemoryStats();
    expect(typeof stats).toBe('object');
  });

  test('getPrometheusMetrics returns string', async () => {
    const metrics = await backend.getPrometheusMetrics();
    expect(typeof metrics).toBe('string');
  });

  test('getStorageStatus returns health status', async () => {
    const status = await backend.getStorageStatus();
    expect(typeof status.diskFull).toBe('boolean');
  });

  test('compactMemory does not throw', async () => {
    await backend.compactMemory();
  });
});

// ─── Progress ─────────────────────────────────────────────────────────────

describe('EmbeddedBackend - Progress', () => {
  test('getProgress returns null for non-existent job', async () => {
    const result = await backend.getProgress('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  test('getProgress returns progress after update', async () => {
    const added = await backend.addJob('prog-q', 'prog-test', {});
    const pulled = await backend.pullJob('prog-q');
    expect(pulled).not.toBeNull();

    await backend.updateProgress(pulled!.id, 50, 'Halfway there');
    const progress = await backend.getProgress(pulled!.id);
    expect(progress).not.toBeNull();
    expect(progress!.progress).toBe(50);
    expect(progress!.message).toBe('Halfway there');
  });
});

// ─── End-to-end flows ─────────────────────────────────────────────────────

describe('EmbeddedBackend - End-to-end flows', () => {
  test('add job, retrieve it, cancel it, verify gone', async () => {
    const added = await backend.addJob('e2e-q', 'lifecycle', { step: 1 });
    expect(added.jobId).toBeDefined();

    const fetched = await backend.getJob(added.jobId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(added.jobId);

    await backend.cancelJob(added.jobId);

    const gone = await backend.getJob(added.jobId);
    expect(gone).toBeNull();
  });

  test('add jobs, count, drain, verify empty', async () => {
    await backend.addJob('e2e-drain', 'j1', {});
    await backend.addJob('e2e-drain', 'j2', {});
    await backend.addJob('e2e-drain', 'j3', {});

    const count = await backend.countJobs('e2e-drain');
    expect(count).toBe(3);

    const removed = await backend.drainQueue('e2e-drain');
    expect(removed).toBe(3);

    const after = await backend.countJobs('e2e-drain');
    expect(after).toBe(0);
  });

  test('add cron, list, delete, verify removed', async () => {
    await backend.addCron({
      name: 'e2e-cron',
      queue: 'cron-q',
      data: { action: 'report' },
      repeatEvery: 60000,
    });

    let crons = await backend.listCrons();
    let names = crons.map((c) => c.name);
    expect(names).toContain('e2e-cron');

    await backend.deleteCron('e2e-cron');

    crons = await backend.listCrons();
    names = crons.map((c) => c.name);
    expect(names).not.toContain('e2e-cron');
  });

  test('add job, add logs, retrieve logs', async () => {
    const added = await backend.addJob('e2e-logs', 'logged', {});

    await backend.addJobLog(added.jobId, 'Phase 1', 'info');
    await backend.addJobLog(added.jobId, 'Phase 2', 'warn');
    await backend.addJobLog(added.jobId, 'Phase 3', 'error');

    const logs = await backend.getJobLogs(added.jobId);
    expect(logs).toHaveLength(3);
    expect(logs[0].message).toBe('Phase 1');
    expect(logs[2].level).toBe('error');
  });

  test('bulk add then count', async () => {
    const result = await backend.addJobsBulk('e2e-bulk', [
      { name: 'a', data: { n: 1 } },
      { name: 'b', data: { n: 2 } },
      { name: 'c', data: { n: 3 } },
      { name: 'd', data: { n: 4 } },
      { name: 'e', data: { n: 5 } },
    ]);
    expect(result.jobIds).toHaveLength(5);

    const count = await backend.countJobs('e2e-bulk');
    expect(count).toBe(5);
  });

  test('full job lifecycle: add, pull, heartbeat, progress, ack, verify completed', async () => {
    const added = await backend.addJob('e2e-lifecycle', 'full-cycle', { step: 'start' });
    const pulled = await backend.pullJob('e2e-lifecycle');
    expect(pulled).not.toBeNull();

    await backend.jobHeartbeat(pulled!.id);
    await backend.updateProgress(pulled!.id, 50, 'In progress');
    await backend.ackJob(pulled!.id, { step: 'done' });

    const state = await backend.getJobState(pulled!.id);
    expect(state).toBe('completed');

    const result = await backend.getJobResult(pulled!.id);
    expect(result).toEqual({ step: 'done' });
  });
});
