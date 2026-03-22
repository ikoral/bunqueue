/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Job Management
 * Update data, change priority, delay, discard
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { withErrorHandler } from './withErrorHandler';

export function registerJobMgmtTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_update_job_data',
    'Update the payload data of a job.',
    {
      jobId: z.string().describe('Job ID'),
      data: z.record(z.string(), z.unknown()).describe('New job payload data'),
    },
    withErrorHandler('bunqueue_update_job_data', async ({ jobId, data }) => {
      const success = await backend.updateJobData(jobId, data);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_change_job_priority',
    'Change the priority of a waiting job. Higher priority = processed first.',
    {
      jobId: z.string().describe('Job ID'),
      priority: z.number().describe('New priority value'),
    },
    withErrorHandler('bunqueue_change_job_priority', async ({ jobId, priority }) => {
      const success = await backend.changeJobPriority(jobId, priority);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, priority }) }],
      };
    })
  );

  server.tool(
    'bunqueue_move_to_delayed',
    'Move a job to delayed state with a specific delay in milliseconds.',
    {
      jobId: z.string().describe('Job ID'),
      delay: z.number().min(0).describe('Delay in milliseconds'),
    },
    withErrorHandler('bunqueue_move_to_delayed', async ({ jobId, delay }) => {
      const success = await backend.moveToDelayed(jobId, delay);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, delay }) }],
      };
    })
  );

  server.tool(
    'bunqueue_discard_job',
    'Discard a job permanently, removing it from the queue.',
    {
      jobId: z.string().describe('Job ID to discard'),
    },
    withErrorHandler('bunqueue_discard_job', async ({ jobId }) => {
      const success = await backend.discardJob(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_get_progress',
    'Get the progress and progress message of a job.',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_progress', async ({ jobId }) => {
      const result = await backend.getProgress(jobId);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, ...result }) }] };
    })
  );

  server.tool(
    'bunqueue_change_delay',
    'Change the delay of a delayed job.',
    {
      jobId: z.string().describe('Job ID'),
      delay: z.number().min(0).describe('New delay in milliseconds'),
    },
    withErrorHandler('bunqueue_change_delay', async ({ jobId, delay }) => {
      const success = await backend.changeDelay(jobId, delay);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, delay }) }],
      };
    })
  );
}
