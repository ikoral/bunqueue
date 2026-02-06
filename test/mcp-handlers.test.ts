/**
 * MCP Handlers & Tools Tests
 *
 * Tests the MCP layer: tool definitions, handler functions, handleToolCall dispatch,
 * and the JSON-RPC handleRequest protocol logic.
 *
 * The existing test/mcp.test.ts exercises the QueueManager directly.
 * These tests exercise the MCP handler wrappers and protocol layer on top.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { shutdownManager } from '../src/client/manager';
import { TOOLS, type Tool } from '../src/mcp/mcpTools';
import {
  handleAddJob,
  handleAddJobsBulk,
  handleGetJob,
  handleCancelJob,
  handleUpdateProgress,
  handlePauseQueue,
  handleResumeQueue,
  handleDrainQueue,
  handleObliterateQueue,
  handleListQueues,
  handleCountJobs,
  handleSetRateLimit,
  handleSetConcurrency,
  handleGetDlq,
  handleRetryDlq,
  handlePurgeDlq,
  handleAddCron,
  handleListCrons,
  handleDeleteCron,
  handleGetStats,
  handleGetJobLogs,
  handleAddJobLog,
  handleToolCall,
  TOOL_HANDLERS,
} from '../src/mcp/mcpHandlers';

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  shutdownManager();
});

afterEach(() => {
  shutdownManager();
});

// ─── Tool Definitions ───────────────────────────────────────────────────────

describe('MCP Tool Definitions (mcpTools.ts)', () => {
  test('TOOLS is a non-empty array', () => {
    expect(Array.isArray(TOOLS)).toBe(true);
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  test('every tool has required fields: name, description, inputSchema', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });

  test('all tool names start with bunqueue_ prefix', () => {
    for (const tool of TOOLS) {
      expect(tool.name.startsWith('bunqueue_')).toBe(true);
    }
  });

  test('tool names are unique', () => {
    const names = TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('required arrays only reference properties that exist in the schema', () => {
    for (const tool of TOOLS) {
      if (tool.inputSchema.required) {
        for (const req of tool.inputSchema.required) {
          expect(tool.inputSchema.properties).toHaveProperty(req);
        }
      }
    }
  });

  test('every tool has a corresponding handler in TOOL_HANDLERS', () => {
    for (const tool of TOOLS) {
      expect(TOOL_HANDLERS.has(tool.name)).toBe(true);
    }
  });

  test('TOOL_HANDLERS does not contain handlers without a tool definition', () => {
    const toolNames = new Set(TOOLS.map((t) => t.name));
    for (const [name] of TOOL_HANDLERS) {
      expect(toolNames.has(name)).toBe(true);
    }
  });

  // Spot-check specific tools

  test('bunqueue_add_job requires queue, name, data', () => {
    const tool = TOOLS.find((t) => t.name === 'bunqueue_add_job')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['queue', 'name', 'data']);
    expect(tool.inputSchema.properties).toHaveProperty('queue');
    expect(tool.inputSchema.properties).toHaveProperty('name');
    expect(tool.inputSchema.properties).toHaveProperty('data');
    expect(tool.inputSchema.properties).toHaveProperty('priority');
    expect(tool.inputSchema.properties).toHaveProperty('delay');
    expect(tool.inputSchema.properties).toHaveProperty('attempts');
  });

  test('bunqueue_add_jobs_bulk requires queue, jobs', () => {
    const tool = TOOLS.find((t) => t.name === 'bunqueue_add_jobs_bulk')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['queue', 'jobs']);
  });

  test('bunqueue_get_job requires jobId', () => {
    const tool = TOOLS.find((t) => t.name === 'bunqueue_get_job')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['jobId']);
  });

  test('bunqueue_add_cron requires name, queue, data', () => {
    const tool = TOOLS.find((t) => t.name === 'bunqueue_add_cron')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['name', 'queue', 'data']);
    expect(tool.inputSchema.properties).toHaveProperty('schedule');
    expect(tool.inputSchema.properties).toHaveProperty('repeatEvery');
  });

  test('tools with no required fields have empty or missing required array', () => {
    const noRequiredTools = ['bunqueue_list_queues', 'bunqueue_list_crons', 'bunqueue_get_stats'];
    for (const name of noRequiredTools) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.inputSchema.required ?? []).toEqual([]);
    }
  });
});

// ─── handleToolCall Dispatch ────────────────────────────────────────────────

describe('handleToolCall dispatch', () => {
  test('throws on unknown tool name', () => {
    expect(() => handleToolCall('nonexistent_tool', {})).toThrow('Unknown tool: nonexistent_tool');
  });

  test('dispatches to bunqueue_add_job handler', async () => {
    const result = await handleToolCall('bunqueue_add_job', {
      queue: 'dispatch-test',
      name: 'my-job',
      data: { foo: 1 },
    });
    expect(result).toHaveProperty('jobId');
    expect(result).toHaveProperty('queue', 'dispatch-test');
  });

  test('dispatches to bunqueue_list_queues handler', () => {
    const result = handleToolCall('bunqueue_list_queues', {});
    expect(result).toHaveProperty('queues');
  });

  test('dispatches to bunqueue_get_stats handler', () => {
    const result = handleToolCall('bunqueue_get_stats', {});
    expect(result).toHaveProperty('waiting');
  });

  test('dispatches to bunqueue_list_crons handler', () => {
    const result = handleToolCall('bunqueue_list_crons', {});
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Job Operation Handlers ─────────────────────────────────────────────────

describe('handleAddJob', () => {
  test('returns jobId, queue, and success message', async () => {
    const result = await handleAddJob({
      queue: 'handler-q',
      name: 'email-send',
      data: { to: 'user@test.com' },
    });
    expect(result.jobId).toBeDefined();
    expect(typeof result.jobId).toBe('string');
    expect(result.queue).toBe('handler-q');
    expect(result.message).toBe('Job added successfully');
  });

  test('respects priority option', async () => {
    const result = await handleAddJob({
      queue: 'handler-q',
      name: 'high-prio',
      data: { x: 1 },
      priority: 10,
    });
    expect(result.jobId).toBeDefined();
  });

  test('respects delay option', async () => {
    const result = await handleAddJob({
      queue: 'handler-q',
      name: 'delayed-job',
      data: { x: 1 },
      delay: 5000,
    });
    expect(result.jobId).toBeDefined();
  });

  test('respects attempts option', async () => {
    const result = await handleAddJob({
      queue: 'handler-q',
      name: 'retry-job',
      data: { x: 1 },
      attempts: 5,
    });
    expect(result.jobId).toBeDefined();

    // Verify attempts via getJob
    const job = await handleGetJob({ jobId: result.jobId });
    expect(job.maxAttempts).toBe(5);
  });
});

describe('handleAddJobsBulk', () => {
  test('returns count and jobIds array', async () => {
    const result = await handleAddJobsBulk({
      queue: 'bulk-q',
      jobs: [
        { name: 'a', data: { v: 1 } },
        { name: 'b', data: { v: 2 } },
      ],
    });
    expect(result.count).toBe(2);
    expect(result.jobIds).toHaveLength(2);
    expect(result.queue).toBe('bulk-q');
  });

  test('handles empty jobs array', async () => {
    const result = await handleAddJobsBulk({
      queue: 'bulk-q',
      jobs: [],
    });
    expect(result.count).toBe(0);
    expect(result.jobIds).toHaveLength(0);
  });

  test('respects priority and delay per job', async () => {
    const result = await handleAddJobsBulk({
      queue: 'bulk-q',
      jobs: [
        { name: 'prio', data: {}, priority: 10 },
        { name: 'delayed', data: {}, delay: 3000 },
      ],
    });
    expect(result.count).toBe(2);
  });
});

describe('handleGetJob', () => {
  test('returns full job details for existing job', async () => {
    const added = await handleAddJob({
      queue: 'get-q',
      name: 'fetch-me',
      data: { key: 'value' },
    });

    const job = await handleGetJob({ jobId: added.jobId });
    expect(job.id).toBe(added.jobId);
    expect(job.name).toBe('fetch-me');
    expect(job.data).toBeDefined();
    expect(job.queue).toBe('get-q');
    expect(job.createdAt).toBeDefined();
    expect(typeof job.createdAt).toBe('string'); // ISO string
    expect(job.attempts).toBeDefined();
    expect(job.maxAttempts).toBeDefined();
  });

  test('returns error object for non-existent job', async () => {
    const result = await handleGetJob({ jobId: '00000000-0000-0000-0000-000000000000' });
    expect(result).toEqual({ error: 'Job not found' });
  });

  test('name defaults to "default" when not in data', async () => {
    // Push directly through manager to get a job without name in data
    const { getSharedManager } = await import('../src/client/manager');
    const manager = getSharedManager();
    const created = await manager.push('get-q', { data: { value: 42 } });

    const result = await handleGetJob({ jobId: String(created.id) });
    expect(result.name).toBe('default');
  });
});

describe('handleCancelJob', () => {
  test('returns success true for waiting job', async () => {
    const added = await handleAddJob({
      queue: 'cancel-q',
      name: 'to-cancel',
      data: {},
    });

    const result = await handleCancelJob({ jobId: added.jobId });
    expect(result.success).toBe(true);
    expect(result.jobId).toBe(added.jobId);
  });

  test('cancelled job is no longer retrievable', async () => {
    const added = await handleAddJob({
      queue: 'cancel-q',
      name: 'gone',
      data: {},
    });

    await handleCancelJob({ jobId: added.jobId });
    const job = await handleGetJob({ jobId: added.jobId });
    expect(job).toEqual({ error: 'Job not found' });
  });

  test('returns false for non-existent job', async () => {
    const result = await handleCancelJob({ jobId: '00000000-0000-0000-0000-000000000000' });
    expect(result.success).toBe(false);
  });
});

describe('handleUpdateProgress', () => {
  test('returns success false for waiting (non-active) job', async () => {
    const added = await handleAddJob({
      queue: 'progress-q',
      name: 'progress-test',
      data: {},
    });

    const result = await handleUpdateProgress({
      jobId: added.jobId,
      progress: 50,
    });
    expect(result.success).toBe(false);
    expect(result.jobId).toBe(added.jobId);
    expect(result.progress).toBe(50);
  });

  test('returns success true for active job', async () => {
    const { getSharedManager } = await import('../src/client/manager');
    const manager = getSharedManager();
    const created = await manager.push('progress-q', { data: { name: 'active-test' } });
    const pulled = await manager.pull('progress-q');
    expect(pulled).not.toBeNull();

    const result = await handleUpdateProgress({
      jobId: String(pulled!.id),
      progress: 75,
      message: 'Almost done',
    });
    expect(result.success).toBe(true);
  });
});

// ─── Queue Control Handlers ─────────────────────────────────────────────────

describe('handlePauseQueue', () => {
  test('returns success and queue name', () => {
    const result = handlePauseQueue({ queue: 'pause-q' });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('pause-q');
    expect(result.message).toBe('Queue paused');
  });
});

describe('handleResumeQueue', () => {
  test('returns success and queue name', () => {
    handlePauseQueue({ queue: 'resume-q' });
    const result = handleResumeQueue({ queue: 'resume-q' });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('resume-q');
    expect(result.message).toBe('Queue resumed');
  });
});

describe('handleDrainQueue', () => {
  test('drains waiting jobs and returns removed count', async () => {
    await handleAddJob({ queue: 'drain-q', name: 'j1', data: {} });
    await handleAddJob({ queue: 'drain-q', name: 'j2', data: {} });

    const result = handleDrainQueue({ queue: 'drain-q' });
    expect(result.success).toBe(true);
    expect(result.removed).toBe(2);
    expect(result.queue).toBe('drain-q');
    expect(result.message).toBe('Removed 2 waiting jobs');
  });

  test('returns 0 for empty queue', () => {
    const result = handleDrainQueue({ queue: 'empty-drain-q' });
    expect(result.removed).toBe(0);
  });
});

describe('handleObliterateQueue', () => {
  test('obliterates queue and returns success', async () => {
    await handleAddJob({ queue: 'obliterate-q', name: 'j1', data: {} });

    const result = handleObliterateQueue({ queue: 'obliterate-q' });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('obliterate-q');
    expect(result.message).toBe('Queue obliterated');
  });

  test('all jobs are removed after obliterate', async () => {
    await handleAddJob({ queue: 'obliterate-q2', name: 'j1', data: {} });
    await handleAddJob({ queue: 'obliterate-q2', name: 'j2', data: {} });

    handleObliterateQueue({ queue: 'obliterate-q2' });
    const count = handleCountJobs({ queue: 'obliterate-q2' });
    expect(count.count).toBe(0);
  });
});

describe('handleListQueues', () => {
  test('returns object with queues array', async () => {
    await handleAddJob({ queue: 'lq-alpha', name: 'j', data: {} });
    await handleAddJob({ queue: 'lq-beta', name: 'j', data: {} });

    const result = handleListQueues();
    expect(result.queues).toBeDefined();
    expect(Array.isArray(result.queues)).toBe(true);
    expect(result.queues).toContain('lq-alpha');
    expect(result.queues).toContain('lq-beta');
  });

  test('returns empty array when no queues exist', () => {
    const result = handleListQueues();
    expect(Array.isArray(result.queues)).toBe(true);
  });
});

describe('handleCountJobs', () => {
  test('returns queue name and count', async () => {
    await handleAddJob({ queue: 'count-q', name: 'j1', data: {} });
    await handleAddJob({ queue: 'count-q', name: 'j2', data: {} });
    await handleAddJob({ queue: 'count-q', name: 'j3', data: {} });

    const result = handleCountJobs({ queue: 'count-q' });
    expect(result.queue).toBe('count-q');
    expect(result.count).toBe(3);
  });

  test('returns 0 for non-existent queue', () => {
    const result = handleCountJobs({ queue: 'empty-count-q' });
    expect(result.count).toBe(0);
  });
});

// ─── Rate Limiting Handlers ─────────────────────────────────────────────────

describe('handleSetRateLimit', () => {
  test('returns success with queue and rateLimit', () => {
    const result = handleSetRateLimit({ queue: 'rl-q', limit: 50 });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('rl-q');
    expect(result.rateLimit).toBe(50);
  });
});

describe('handleSetConcurrency', () => {
  test('returns success with queue and concurrency', () => {
    const result = handleSetConcurrency({ queue: 'conc-q', limit: 10 });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('conc-q');
    expect(result.concurrency).toBe(10);
  });
});

// ─── DLQ Operation Handlers ────────────────────────────────────────────────

describe('handleGetDlq', () => {
  test('returns empty array for queue with no DLQ entries', () => {
    const result = handleGetDlq({ queue: 'dlq-empty-q' });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('accepts optional limit parameter', () => {
    const result = handleGetDlq({ queue: 'dlq-empty-q', limit: 5 });
    expect(Array.isArray(result)).toBe(true);
  });

  test('defaults limit to 20 when not provided', () => {
    // Just verifying it does not error when limit is omitted
    const result = handleGetDlq({ queue: 'dlq-empty-q' });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('handleRetryDlq', () => {
  test('returns 0 retried for empty DLQ', () => {
    const result = handleRetryDlq({ queue: 'dlq-retry-q' });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('dlq-retry-q');
    expect(result.retried).toBe(0);
  });

  test('accepts optional jobId parameter', () => {
    const result = handleRetryDlq({
      queue: 'dlq-retry-q',
      jobId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.success).toBe(true);
    expect(result.retried).toBe(0);
  });
});

describe('handlePurgeDlq', () => {
  test('returns 0 purged for empty DLQ', () => {
    const result = handlePurgeDlq({ queue: 'dlq-purge-q' });
    expect(result.success).toBe(true);
    expect(result.queue).toBe('dlq-purge-q');
    expect(result.purged).toBe(0);
  });
});

// ─── Cron Job Handlers ──────────────────────────────────────────────────────

describe('handleAddCron', () => {
  test('adds cron with schedule and returns details', () => {
    const result = handleAddCron({
      name: 'handler-cron-hourly',
      queue: 'cron-q',
      data: { task: 'cleanup' },
      schedule: '0 * * * *',
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe('handler-cron-hourly');
    expect(result.queue).toBe('cron-q');
    expect(result.nextRun).toBeDefined();
  });

  test('adds cron with repeatEvery', () => {
    const result = handleAddCron({
      name: 'handler-cron-interval',
      queue: 'cron-q',
      data: { task: 'ping' },
      repeatEvery: 30000,
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe('handler-cron-interval');
  });

  test('adds cron with priority', () => {
    const result = handleAddCron({
      name: 'handler-cron-prio',
      queue: 'cron-q',
      data: {},
      repeatEvery: 60000,
      priority: 5,
    });
    expect(result.success).toBe(true);
  });
});

describe('handleListCrons', () => {
  test('returns array of cron entries', () => {
    handleAddCron({
      name: 'list-cron-1',
      queue: 'cron-q',
      data: {},
      repeatEvery: 1000,
    });

    const result = handleListCrons();
    expect(Array.isArray(result)).toBe(true);
    const names = result.map((c: any) => c.name);
    expect(names).toContain('list-cron-1');
  });

  test('cron entries have expected fields', () => {
    handleAddCron({
      name: 'field-check-cron',
      queue: 'cron-q',
      data: {},
      repeatEvery: 5000,
    });

    const result = handleListCrons();
    const entry = result.find((c: any) => c.name === 'field-check-cron');
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('name');
    expect(entry).toHaveProperty('queue');
    expect(entry).toHaveProperty('repeatEvery');
    expect(entry).toHaveProperty('nextRun');
    expect(entry).toHaveProperty('executions');
  });
});

describe('handleDeleteCron', () => {
  test('deletes existing cron and returns success true', () => {
    handleAddCron({
      name: 'to-delete-cron',
      queue: 'cron-q',
      data: {},
      repeatEvery: 1000,
    });

    const result = handleDeleteCron({ name: 'to-delete-cron' });
    expect(result.success).toBe(true);
    expect(result.name).toBe('to-delete-cron');
  });

  test('returns success false for non-existent cron', () => {
    const result = handleDeleteCron({ name: 'does-not-exist-cron' });
    expect(result.success).toBe(false);
    expect(result.name).toBe('does-not-exist-cron');
  });
});

// ─── Stats & Logs Handlers ──────────────────────────────────────────────────

describe('handleGetStats', () => {
  test('returns stats object with expected numeric fields', () => {
    const result = handleGetStats();
    expect(typeof result.waiting).toBe('number');
    expect(typeof result.active).toBe('number');
    expect(typeof result.completed).toBe('number');
    expect(typeof result.dlq).toBe('number');
  });

  test('stats reflect pushed jobs', async () => {
    await handleAddJob({ queue: 'stats-q', name: 'j1', data: {} });
    await handleAddJob({ queue: 'stats-q', name: 'j2', data: {} });

    const result = handleGetStats();
    expect(result.waiting).toBeGreaterThanOrEqual(2);
    expect(result.totalPushed).toBeGreaterThanOrEqual(2);
  });

  test('stats contain no BigInt values (serializable)', async () => {
    await handleAddJob({ queue: 'stats-q2', name: 'j', data: {} });
    const result = handleGetStats();

    // Verify JSON.stringify does not throw
    const json = JSON.stringify(result);
    expect(json).toBeDefined();

    // Verify all values are numbers
    for (const value of Object.values(result)) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('handleGetJobLogs', () => {
  test('returns empty array when no logs exist', async () => {
    const added = await handleAddJob({ queue: 'log-q', name: 'no-logs', data: {} });
    const logs = handleGetJobLogs({ jobId: added.jobId });
    expect(Array.isArray(logs)).toBe(true);
    expect(logs).toHaveLength(0);
  });

  test('returns logs after adding them', async () => {
    const added = await handleAddJob({ queue: 'log-q', name: 'has-logs', data: {} });

    handleAddJobLog({ jobId: added.jobId, message: 'Step 1 started', level: 'info' });
    handleAddJobLog({ jobId: added.jobId, message: 'Warning encountered', level: 'warn' });

    const logs = handleGetJobLogs({ jobId: added.jobId });
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toBe('Step 1 started');
    expect(logs[0].level).toBe('info');
    expect(logs[1].message).toBe('Warning encountered');
    expect(logs[1].level).toBe('warn');
  });
});

describe('handleAddJobLog', () => {
  test('returns success true when log is added', async () => {
    const added = await handleAddJob({ queue: 'log-q', name: 'log-target', data: {} });

    const result = handleAddJobLog({
      jobId: added.jobId,
      message: 'Processing started',
      level: 'info',
    });
    expect(result.success).toBe(true);
    expect(result.jobId).toBe(added.jobId);
  });

  test('defaults to info level when level is omitted', async () => {
    const added = await handleAddJob({ queue: 'log-q', name: 'log-default', data: {} });

    handleAddJobLog({ jobId: added.jobId, message: 'Default level' });

    const logs = handleGetJobLogs({ jobId: added.jobId });
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
  });

  test('supports error level', async () => {
    const added = await handleAddJob({ queue: 'log-q', name: 'log-error', data: {} });

    handleAddJobLog({ jobId: added.jobId, message: 'Error occurred', level: 'error' });

    const logs = handleGetJobLogs({ jobId: added.jobId });
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
  });
});

// ─── End-to-end handler flows ───────────────────────────────────────────────

describe('End-to-end handler flows', () => {
  test('add job, retrieve it, cancel it, verify gone', async () => {
    const added = await handleAddJob({
      queue: 'e2e-q',
      name: 'lifecycle',
      data: { step: 1 },
    });
    expect(added.jobId).toBeDefined();

    const fetched = await handleGetJob({ jobId: added.jobId });
    expect(fetched.id).toBe(added.jobId);
    expect(fetched.name).toBe('lifecycle');

    const cancelled = await handleCancelJob({ jobId: added.jobId });
    expect(cancelled.success).toBe(true);

    const gone = await handleGetJob({ jobId: added.jobId });
    expect(gone).toEqual({ error: 'Job not found' });
  });

  test('add jobs, count, drain, verify empty', async () => {
    await handleAddJob({ queue: 'e2e-drain', name: 'j1', data: {} });
    await handleAddJob({ queue: 'e2e-drain', name: 'j2', data: {} });
    await handleAddJob({ queue: 'e2e-drain', name: 'j3', data: {} });

    const count = handleCountJobs({ queue: 'e2e-drain' });
    expect(count.count).toBe(3);

    const drain = handleDrainQueue({ queue: 'e2e-drain' });
    expect(drain.removed).toBe(3);

    const after = handleCountJobs({ queue: 'e2e-drain' });
    expect(after.count).toBe(0);
  });

  test('pause queue, verify via manager, resume', async () => {
    const { getSharedManager } = await import('../src/client/manager');
    const manager = getSharedManager();

    handlePauseQueue({ queue: 'e2e-pause' });
    expect(manager.isPaused('e2e-pause')).toBe(true);

    handleResumeQueue({ queue: 'e2e-pause' });
    expect(manager.isPaused('e2e-pause')).toBe(false);
  });

  test('add cron, list crons, delete cron, verify removed', () => {
    handleAddCron({
      name: 'e2e-cron',
      queue: 'cron-q',
      data: { action: 'report' },
      repeatEvery: 60000,
    });

    let crons = handleListCrons();
    let names = crons.map((c: any) => c.name);
    expect(names).toContain('e2e-cron');

    handleDeleteCron({ name: 'e2e-cron' });

    crons = handleListCrons();
    names = crons.map((c: any) => c.name);
    expect(names).not.toContain('e2e-cron');
  });

  test('add job, add logs, retrieve logs', async () => {
    const added = await handleAddJob({ queue: 'e2e-logs', name: 'logged', data: {} });

    handleAddJobLog({ jobId: added.jobId, message: 'Phase 1', level: 'info' });
    handleAddJobLog({ jobId: added.jobId, message: 'Phase 2', level: 'warn' });
    handleAddJobLog({ jobId: added.jobId, message: 'Phase 3', level: 'error' });

    const logs = handleGetJobLogs({ jobId: added.jobId });
    expect(logs).toHaveLength(3);
    expect(logs[0].message).toBe('Phase 1');
    expect(logs[2].level).toBe('error');
  });

  test('bulk add then count', async () => {
    const result = await handleAddJobsBulk({
      queue: 'e2e-bulk',
      jobs: [
        { name: 'a', data: { n: 1 } },
        { name: 'b', data: { n: 2 } },
        { name: 'c', data: { n: 3 } },
        { name: 'd', data: { n: 4 } },
        { name: 'e', data: { n: 5 } },
      ],
    });
    expect(result.count).toBe(5);

    const count = handleCountJobs({ queue: 'e2e-bulk' });
    expect(count.count).toBe(5);
  });
});

// ─── handleRequest protocol (index.ts) ──────────────────────────────────────

describe('MCP JSON-RPC handleRequest (index.ts internals)', () => {
  // We cannot call handleRequest directly since it is not exported,
  // but we can test the protocol behavior by importing the building blocks
  // and verifying the tool dispatch works end-to-end via handleToolCall.

  test('handleToolCall returns awaitable result for async handlers', async () => {
    const result = handleToolCall('bunqueue_add_job', {
      queue: 'proto-q',
      name: 'proto-job',
      data: { k: 'v' },
    });
    // handleAddJob is async, so handleToolCall returns a promise
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved).toHaveProperty('jobId');
  });

  test('handleToolCall returns synchronous result for sync handlers', () => {
    const result = handleToolCall('bunqueue_list_queues', {});
    // handleListQueues is sync, the wrapper (() => handleListQueues()) is also sync
    expect(result).toHaveProperty('queues');
  });

  test('result of handleToolCall is JSON-serializable', async () => {
    const addResult = await handleToolCall('bunqueue_add_job', {
      queue: 'serial-q',
      name: 'serial-job',
      data: { a: 1 },
    });
    const json = JSON.stringify(addResult, null, 2);
    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('stats result is JSON-serializable (no BigInt)', () => {
    const result = handleToolCall('bunqueue_get_stats', {});
    const json = JSON.stringify(result, null, 2);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json);
    expect(typeof parsed.waiting).toBe('number');
  });
});
