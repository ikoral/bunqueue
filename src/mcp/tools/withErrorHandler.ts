/**
 * MCP Tool Error Handler
 * Wraps tool handlers with try/catch and records invocations for cloud telemetry.
 */

import { mcpTracker } from './mcpTracker';

/** MCP tool result compatible with SDK's expected return type */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Extract queue name from tool arguments.
 * Checks common field names: queue, queueName.
 */
function extractQueue(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (typeof a.queue === 'string') return a.queue;
  if (typeof a.queueName === 'string') return a.queueName;
  return null;
}

/**
 * Wraps an MCP tool handler with error handling and invocation tracking.
 * Records tool name, queue, duration, and success/failure for cloud telemetry.
 */
export function withErrorHandler<T>(
  toolName: string,
  fn: (args: T) => Promise<ToolResult>
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    const start = Date.now();
    try {
      const result = await fn(args);
      mcpTracker.record({
        tool: toolName,
        queue: extractQueue(args),
        timestamp: start,
        durationMs: Date.now() - start,
        success: !result.isError,
        error: result.isError ? extractErrorText(result) : null,
      });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      mcpTracker.record({
        tool: toolName,
        queue: extractQueue(args),
        timestamp: start,
        durationMs: Date.now() - start,
        success: false,
        error: message,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  };
}

/** Extract error text from a tool result that has isError: true */
function extractErrorText(result: ToolResult): string | null {
  const text = result.content[0]?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON — fall through
  }
  // Fall back to raw text content (truncated to avoid huge payloads)
  return text.length > 200 ? text.slice(0, 200) : text;
}
