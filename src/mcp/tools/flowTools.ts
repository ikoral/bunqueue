/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Flow Operations
 * Create and retrieve job workflows: chains, fan-out/fan-in, and tree flows.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend, FlowJobInput } from '../adapter';
import { withErrorHandler } from './withErrorHandler';

/** Shared schema for job options */
const jobOptsSchema = z
  .object({
    priority: z.number().optional().describe('Priority (higher = processed first)'),
    delay: z.number().optional().describe('Delay in ms before processing'),
    attempts: z.number().optional().describe('Max retry attempts'),
  })
  .optional()
  .describe('Optional job settings');

/** Shared schema for flow step */
const flowStepSchema = z.object({
  name: z.string().describe('Job name/type'),
  queueName: z.string().describe('Queue to run in'),
  data: z.record(z.string(), z.unknown()).describe('Job payload data'),
  opts: jobOptsSchema,
});

/**
 * Recursive FlowJob schema.
 * z.lazy() enables self-referencing for nested children.
 */
const flowJobSchema: z.ZodType = z.lazy(() =>
  z.object({
    name: z.string().describe('Job name/type'),
    queueName: z.string().describe('Queue to run in'),
    data: z.record(z.string(), z.unknown()).optional().describe('Job payload data'),
    opts: jobOptsSchema,
    children: z.array(flowJobSchema).optional().describe('Child jobs (processed BEFORE parent)'),
  })
);

export function registerFlowTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_add_flow',
    'Create a job flow tree (BullMQ v5 compatible). Children are processed BEFORE their parent. Use for complex dependency graphs.',
    {
      name: z.string().describe('Root job name/type'),
      queueName: z.string().describe('Root queue name'),
      data: z.record(z.string(), z.unknown()).optional().describe('Root job payload'),
      opts: jobOptsSchema,
      children: z
        .array(flowJobSchema)
        .optional()
        .describe('Child jobs (processed BEFORE this job)'),
    },
    withErrorHandler(async ({ name, queueName, data, opts, children }) => {
      const result = await backend.addFlow({
        name,
        queueName,
        data,
        opts,
        children: children as FlowJobInput[] | undefined,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_add_flow_chain',
    'Create a sequential job pipeline: step[0] → step[1] → step[2]. Each step depends on the previous one completing first.',
    {
      steps: z
        .array(flowStepSchema)
        .min(1)
        .describe('Steps executed in order, each depending on the previous'),
    },
    withErrorHandler(async ({ steps }) => {
      const result = await backend.addFlowChain(steps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_add_flow_bulk_then',
    'Fan-out/fan-in: run parallel jobs, then execute a final job when ALL parallel jobs complete.',
    {
      parallel: z.array(flowStepSchema).min(1).describe('Jobs that run in parallel'),
      final: flowStepSchema.describe('Final job that runs after all parallel jobs complete'),
    },
    withErrorHandler(async ({ parallel, final: finalStep }) => {
      const result = await backend.addFlowBulkThen(parallel, finalStep);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_flow',
    'Retrieve a flow tree starting from a job. Shows the full dependency graph with children.',
    {
      jobId: z.string().describe('Job ID to get flow tree for'),
      queueName: z.string().describe('Queue name where the job is located'),
      depth: z.number().optional().describe('Max traversal depth (default: 10)'),
      maxChildren: z.number().optional().describe('Max children per level'),
    },
    withErrorHandler(async ({ jobId, queueName, depth, maxChildren }) => {
      const result = await backend.getFlow(jobId, queueName, depth ?? 10, maxChildren);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Flow not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );
}
