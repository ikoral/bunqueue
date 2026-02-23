/**
 * MCP Tool Error Handler
 * Wraps tool handlers with try/catch to return proper MCP error responses.
 */

/** MCP tool result compatible with SDK's expected return type */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Wraps an MCP tool handler with error handling.
 * Catches exceptions and returns a proper MCP error response with isError: true
 * instead of letting raw stack traces propagate to the AI agent.
 */
export function withErrorHandler<T>(
  fn: (args: T) => Promise<ToolResult>
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  };
}
