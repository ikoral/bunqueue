/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Job Operations
 * Add, get, cancel, promote jobs
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { withErrorHandler } from './withErrorHandler';

export function registerJobTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_add_job',
    'Add a job to a queue. Returns the job ID.',
    {
      queue: z.string().describe('Queue name'),
      name: z.string().describe('Job name/type'),
      data: z.record(z.string(), z.unknown()).describe('Job payload data'),
      priority: z.number().optional().describe('Priority (higher = processed first)'),
      delay: z.number().optional().describe('Delay in milliseconds before processing'),
      attempts: z.number().optional().describe('Max retry attempts (default: 3)'),
    },
    withErrorHandler(
      'bunqueue_add_job',
      async ({ queue, name, data, priority, delay, attempts }) => {
        const result = await backend.addJob(queue, name, data, { priority, delay, attempts });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      }
    )
  );

  server.tool(
    'bunqueue_add_jobs_bulk',
    'Add multiple jobs to a queue in a single operation.',
    {
      queue: z.string().describe('Queue name'),
      jobs: z
        .array(
          z.object({
            name: z.string(),
            data: z.record(z.string(), z.unknown()),
            priority: z.number().optional(),
            delay: z.number().optional(),
          })
        )
        .describe('Array of jobs to add'),
    },
    withErrorHandler('bunqueue_add_jobs_bulk', async ({ queue, jobs }) => {
      const result = await backend.addJobsBulk(queue, jobs);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_job',
    'Get a job by ID. Returns job details including state, progress, and data.',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_job', async ({ jobId }) => {
      const job = await backend.getJob(jobId);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_job_state',
    'Get the current state of a job (waiting, delayed, active, completed, failed).',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_job_state', async ({ jobId }) => {
      const state = await backend.getJobState(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, state }) }] };
    })
  );

  server.tool(
    'bunqueue_get_job_result',
    'Get the result of a completed job.',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_job_result', async ({ jobId }) => {
      const result = await backend.getJobResult(jobId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ jobId, result }, null, 2) }],
      };
    })
  );

  server.tool(
    'bunqueue_cancel_job',
    'Cancel a waiting or delayed job.',
    {
      jobId: z.string().describe('Job ID to cancel'),
    },
    withErrorHandler('bunqueue_cancel_job', async ({ jobId }) => {
      const success = await backend.cancelJob(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_promote_job',
    'Promote a delayed job to waiting state for immediate processing.',
    {
      jobId: z.string().describe('Job ID to promote'),
    },
    withErrorHandler('bunqueue_promote_job', async ({ jobId }) => {
      const success = await backend.promoteJob(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_update_progress',
    'Update job progress (0-100).',
    {
      jobId: z.string().describe('Job ID'),
      progress: z.number().min(0).max(100).describe('Progress value (0-100)'),
      message: z.string().optional().describe('Optional progress message'),
    },
    withErrorHandler('bunqueue_update_progress', async ({ jobId, progress, message }) => {
      const success = await backend.updateProgress(jobId, progress, message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, progress }) }],
      };
    })
  );

  server.tool(
    'bunqueue_get_children_values',
    'Get return values from all child jobs of a parent job. Used with FlowProducer workflows.',
    {
      parentJobId: z.string().describe('Parent job ID'),
    },
    withErrorHandler('bunqueue_get_children_values', async ({ parentJobId }) => {
      const values = await backend.getChildrenValues(parentJobId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ parentJobId, children: values }, null, 2),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_get_job_by_custom_id',
    'Look up a job by its custom ID (set via jobId option during creation).',
    {
      customId: z.string().describe('Custom job ID'),
    },
    withErrorHandler('bunqueue_get_job_by_custom_id', async ({ customId }) => {
      const job = await backend.getJobByCustomId(customId);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_wait_for_job',
    'Wait for a job to complete within a timeout. Returns true if completed, false if timed out.',
    {
      jobId: z.string().describe('Job ID to wait for'),
      timeoutMs: z.number().min(100).max(30000).describe('Maximum wait time in milliseconds'),
    },
    withErrorHandler('bunqueue_wait_for_job', async ({ jobId, timeoutMs }) => {
      const completed = await backend.waitForJobCompletion(jobId, timeoutMs);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, completed }) }] };
    })
  );
}
