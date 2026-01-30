#!/usr/bin/env bun
/**
 * bunqueue MCP Server
 *
 * Model Context Protocol server for bunqueue job queue management.
 * Allows AI assistants to manage queues, jobs, DLQ, and cron schedules.
 *
 * @example
 * Add to Claude Desktop config:
 * ```json
 * {
 *   "mcpServers": {
 *     "bunqueue": {
 *       "command": "bunx",
 *       "args": ["bunqueue-mcp"]
 *     }
 *   }
 * }
 * ```
 */

import { getSharedManager, shutdownManager } from '../client/manager';
import { jobId } from '../domain/types/job';

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: Tool[] = [
  // Job Operations
  {
    name: 'bunqueue_add_job',
    description: 'Add a job to a queue. Returns the job ID.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
        name: { type: 'string', description: 'Job name/type' },
        data: { type: 'object', description: 'Job payload data' },
        priority: { type: 'number', description: 'Priority (higher = processed first)' },
        delay: { type: 'number', description: 'Delay in milliseconds before processing' },
        attempts: { type: 'number', description: 'Max retry attempts (default: 3)' },
      },
      required: ['queue', 'name', 'data'],
    },
  },
  {
    name: 'bunqueue_add_jobs_bulk',
    description: 'Add multiple jobs to a queue in a single operation.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
        jobs: {
          type: 'array',
          description: 'Array of jobs to add',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              data: { type: 'object' },
              priority: { type: 'number' },
              delay: { type: 'number' },
            },
          },
        },
      },
      required: ['queue', 'jobs'],
    },
  },
  {
    name: 'bunqueue_get_job',
    description: 'Get a job by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'bunqueue_cancel_job',
    description: 'Cancel a waiting or delayed job.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID to cancel' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'bunqueue_update_progress',
    description: 'Update job progress (0-100).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        progress: { type: 'number', description: 'Progress value (0-100)' },
        message: { type: 'string', description: 'Optional progress message' },
      },
      required: ['jobId', 'progress'],
    },
  },
  // Queue Control
  {
    name: 'bunqueue_pause_queue',
    description: 'Pause job processing on a queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
      },
      required: ['queue'],
    },
  },
  {
    name: 'bunqueue_resume_queue',
    description: 'Resume job processing on a paused queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
      },
      required: ['queue'],
    },
  },
  {
    name: 'bunqueue_drain_queue',
    description: 'Remove all waiting jobs from a queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
      },
      required: ['queue'],
    },
  },
  {
    name: 'bunqueue_obliterate_queue',
    description: 'Remove ALL data from a queue (waiting, active, completed, failed).',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
      },
      required: ['queue'],
    },
  },
  {
    name: 'bunqueue_list_queues',
    description: 'List all queues.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bunqueue_count_jobs',
    description: 'Count jobs in a queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
      },
      required: ['queue'],
    },
  },
  // Rate Limiting
  {
    name: 'bunqueue_set_rate_limit',
    description: 'Set rate limit for a queue (jobs per second).',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
        limit: { type: 'number', description: 'Max jobs per second' },
      },
      required: ['queue', 'limit'],
    },
  },
  {
    name: 'bunqueue_set_concurrency',
    description: 'Set concurrency limit for a queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
        limit: { type: 'number', description: 'Max concurrent jobs' },
      },
      required: ['queue', 'limit'],
    },
  },
  // DLQ Operations
  {
    name: 'bunqueue_get_dlq',
    description: 'Get Dead Letter Queue entries for a queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
        limit: { type: 'number', description: 'Max entries to return (default: 20)' },
      },
      required: ['queue'],
    },
  },
  {
    name: 'bunqueue_retry_dlq',
    description: 'Retry jobs from the Dead Letter Queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
        jobId: { type: 'string', description: 'Specific job ID to retry (optional)' },
      },
      required: ['queue'],
    },
  },
  {
    name: 'bunqueue_purge_dlq',
    description: 'Remove all entries from the Dead Letter Queue.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'Queue name' },
      },
      required: ['queue'],
    },
  },
  // Cron Jobs
  {
    name: 'bunqueue_add_cron',
    description: 'Add a recurring cron job.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique cron job name' },
        queue: { type: 'string', description: 'Target queue name' },
        data: { type: 'object', description: 'Job payload data' },
        schedule: { type: 'string', description: 'Cron pattern (e.g., "0 * * * *" for hourly)' },
        repeatEvery: { type: 'number', description: 'Alternative: repeat every N milliseconds' },
        priority: { type: 'number', description: 'Job priority' },
      },
      required: ['name', 'queue', 'data'],
    },
  },
  {
    name: 'bunqueue_list_crons',
    description: 'List all scheduled cron jobs.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bunqueue_delete_cron',
    description: 'Delete a cron job by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Cron job name to delete' },
      },
      required: ['name'],
    },
  },
  // Stats & Logs
  {
    name: 'bunqueue_get_stats',
    description: 'Get overall queue statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bunqueue_get_job_logs',
    description: 'Get logs for a specific job.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'bunqueue_add_job_log',
    description: 'Add a log entry to a job.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        message: { type: 'string', description: 'Log message' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Log level' },
      },
      required: ['jobId', 'message'],
    },
  },
];

type ToolArgs = Record<string, unknown>;

interface JobData {
  name: string;
  data: unknown;
  priority?: number;
  delay?: number;
}

async function handleAddJob(args: ToolArgs) {
  const manager = getSharedManager();
  const job = await manager.push(args.queue as string, {
    data: { name: args.name as string, ...(args.data as object) },
    priority: args.priority as number | undefined,
    delay: args.delay as number | undefined,
    maxAttempts: args.attempts as number | undefined,
  });
  return { jobId: String(job.id), queue: args.queue, message: 'Job added successfully' };
}

async function handleAddJobsBulk(args: ToolArgs) {
  const manager = getSharedManager();
  const jobs = args.jobs as JobData[];
  const inputs = jobs.map((j) => ({
    data: { name: j.name, ...(j.data as object) },
    priority: j.priority,
    delay: j.delay,
  }));
  const jobIds = await manager.pushBatch(args.queue as string, inputs);
  return { count: jobIds.length, jobIds: jobIds.map(String), queue: args.queue };
}

async function handleGetJob(args: ToolArgs) {
  const manager = getSharedManager();
  const job = await manager.getJob(jobId(args.jobId as string));
  if (!job) return { error: 'Job not found' };
  const data = job.data as { name?: string } | null;
  return {
    id: String(job.id),
    name: data?.name ?? 'default',
    data: job.data,
    queue: job.queue,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

async function handleCancelJob(args: ToolArgs) {
  const manager = getSharedManager();
  const cancelled = await manager.cancel(jobId(args.jobId as string));
  return { success: cancelled, jobId: args.jobId };
}

async function handleUpdateProgress(args: ToolArgs) {
  const manager = getSharedManager();
  const updated = await manager.updateProgress(
    jobId(args.jobId as string),
    args.progress as number,
    args.message as string | undefined
  );
  return { success: updated, jobId: args.jobId, progress: args.progress };
}

function handlePauseQueue(args: ToolArgs) {
  const manager = getSharedManager();
  manager.pause(args.queue as string);
  return { success: true, queue: args.queue, message: 'Queue paused' };
}

function handleResumeQueue(args: ToolArgs) {
  const manager = getSharedManager();
  manager.resume(args.queue as string);
  return { success: true, queue: args.queue, message: 'Queue resumed' };
}

function handleDrainQueue(args: ToolArgs) {
  const manager = getSharedManager();
  const removed = manager.drain(args.queue as string);
  return { success: true, queue: args.queue, removed, message: `Removed ${removed} waiting jobs` };
}

function handleObliterateQueue(args: ToolArgs) {
  const manager = getSharedManager();
  manager.obliterate(args.queue as string);
  return { success: true, queue: args.queue, message: 'Queue obliterated' };
}

function handleListQueues() {
  const manager = getSharedManager();
  return { queues: manager.listQueues() };
}

function handleCountJobs(args: ToolArgs) {
  const manager = getSharedManager();
  return { queue: args.queue, count: manager.count(args.queue as string) };
}

function handleSetRateLimit(args: ToolArgs) {
  const manager = getSharedManager();
  manager.setRateLimit(args.queue as string, args.limit as number);
  return { success: true, queue: args.queue, rateLimit: args.limit };
}

function handleSetConcurrency(args: ToolArgs) {
  const manager = getSharedManager();
  manager.setConcurrency(args.queue as string, args.limit as number);
  return { success: true, queue: args.queue, concurrency: args.limit };
}

function handleGetDlq(args: ToolArgs) {
  const manager = getSharedManager();
  const limit = (args.limit as number) || 20;
  const jobs = manager.getDlq(args.queue as string, limit);
  return jobs.map((j) => {
    const data = j.data as { name?: string } | null;
    return {
      id: String(j.id),
      name: data?.name ?? 'default',
      data: j.data,
      attempts: j.attempts,
      createdAt: new Date(j.createdAt).toISOString(),
    };
  });
}

function handleRetryDlq(args: ToolArgs) {
  const manager = getSharedManager();
  const id = args.jobId ? jobId(args.jobId as string) : undefined;
  const retried = manager.retryDlq(args.queue as string, id);
  return { success: true, queue: args.queue, retried };
}

function handlePurgeDlq(args: ToolArgs) {
  const manager = getSharedManager();
  const purged = manager.purgeDlq(args.queue as string);
  return { success: true, queue: args.queue, purged };
}

function handleAddCron(args: ToolArgs) {
  const manager = getSharedManager();
  const cron = manager.addCron({
    name: args.name as string,
    queue: args.queue as string,
    data: args.data as Record<string, unknown>,
    schedule: args.schedule as string | undefined,
    repeatEvery: args.repeatEvery as number | undefined,
    priority: args.priority as number | undefined,
  });
  return {
    success: true,
    name: cron.name,
    queue: cron.queue,
    nextRun: cron.nextRun ? new Date(cron.nextRun).toISOString() : null,
  };
}

function handleListCrons() {
  const manager = getSharedManager();
  return manager.listCrons().map((c) => ({
    name: c.name,
    queue: c.queue,
    schedule: c.schedule,
    repeatEvery: c.repeatEvery,
    nextRun: c.nextRun ? new Date(c.nextRun).toISOString() : null,
    executions: c.executions,
  }));
}

function handleDeleteCron(args: ToolArgs) {
  const manager = getSharedManager();
  const deleted = manager.removeCron(args.name as string);
  return { success: deleted, name: args.name };
}

function handleGetStats() {
  const manager = getSharedManager();
  return manager.getStats();
}

function handleGetJobLogs(args: ToolArgs) {
  const manager = getSharedManager();
  return manager.getLogs(jobId(args.jobId as string));
}

function handleAddJobLog(args: ToolArgs) {
  const manager = getSharedManager();
  const level = (args.level as 'info' | 'warn' | 'error' | undefined) ?? 'info';
  const added = manager.addLog(jobId(args.jobId as string), args.message as string, level);
  return { success: added, jobId: args.jobId };
}

type ToolHandler = (args: ToolArgs) => unknown;

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ['bunqueue_add_job', handleAddJob],
  ['bunqueue_add_jobs_bulk', handleAddJobsBulk],
  ['bunqueue_get_job', handleGetJob],
  ['bunqueue_cancel_job', handleCancelJob],
  ['bunqueue_update_progress', handleUpdateProgress],
  ['bunqueue_pause_queue', handlePauseQueue],
  ['bunqueue_resume_queue', handleResumeQueue],
  ['bunqueue_drain_queue', handleDrainQueue],
  ['bunqueue_obliterate_queue', handleObliterateQueue],
  ['bunqueue_list_queues', () => handleListQueues()],
  ['bunqueue_count_jobs', handleCountJobs],
  ['bunqueue_set_rate_limit', handleSetRateLimit],
  ['bunqueue_set_concurrency', handleSetConcurrency],
  ['bunqueue_get_dlq', handleGetDlq],
  ['bunqueue_retry_dlq', handleRetryDlq],
  ['bunqueue_purge_dlq', handlePurgeDlq],
  ['bunqueue_add_cron', handleAddCron],
  ['bunqueue_list_crons', () => handleListCrons()],
  ['bunqueue_delete_cron', handleDeleteCron],
  ['bunqueue_get_stats', () => handleGetStats()],
  ['bunqueue_get_job_logs', handleGetJobLogs],
  ['bunqueue_add_job_log', handleAddJobLog],
]);

function handleToolCall(name: string, args: ToolArgs): unknown {
  const handler = TOOL_HANDLERS.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}

function createResponse(id: number | string, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function createError(id: number | string, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(request: McpRequest): Promise<McpResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return createResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'bunqueue-mcp', version: '1.0.0' },
        });

      case 'tools/list':
        return createResponse(id, { tools: TOOLS });

      case 'tools/call': {
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as ToolArgs;
        const result = await handleToolCall(toolName, args);
        return createResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return createResponse(id, {});

      default:
        return createError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createError(id, -32603, message);
  }
}

async function main() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  process.stderr.write('bunqueue MCP server started\n');

  let buffer = '';

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    shutdownManager();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdownManager();
    process.exit(0);
  });

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);

    let headerEnd = buffer.indexOf('\r\n\r\n');
    while (headerEnd !== -1) {
      const header = buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        headerEnd = buffer.indexOf('\r\n\r\n');
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (buffer.length < messageEnd) break;

      const message = buffer.slice(messageStart, messageEnd);
      buffer = buffer.slice(messageEnd);

      try {
        const request = JSON.parse(message) as McpRequest;
        const response = await handleRequest(request);
        const responseJson = JSON.stringify(response);
        const responseHeader = `Content-Length: ${Buffer.byteLength(responseJson)}\r\n\r\n`;
        process.stdout.write(encoder.encode(responseHeader + responseJson));
      } catch {
        process.stderr.write(`Failed to parse message: ${message}\n`);
      }

      headerEnd = buffer.indexOf('\r\n\r\n');
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
