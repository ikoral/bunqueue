/**
 * MCP Operation Tracker
 * Bounded ring buffer that records MCP tool invocations for cloud dashboard telemetry.
 * O(n) worst-case per record due to Array.shift() at capacity, but n is capped at 200.
 * Constant memory (~40KB max).
 */

/** Single MCP tool invocation record */
export interface McpOperation {
  /** Tool name (e.g., "bunqueue_add_job") */
  tool: string;
  /** Queue affected (null for global operations like list_queues, get_stats) */
  queue: string | null;
  /** Invocation timestamp (Date.now()) */
  timestamp: number;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether the invocation succeeded */
  success: boolean;
  /** Error message if failed */
  error: string | null;
}

/** Aggregated MCP usage summary */
export interface McpSummary {
  /** Total invocations since last drain */
  totalInvocations: number;
  /** Successful invocations */
  successCount: number;
  /** Failed invocations */
  failureCount: number;
  /** Average execution duration in ms */
  avgDurationMs: number;
  /** Top tools by invocation count */
  topTools: Array<{ tool: string; count: number }>;
}

const MAX_BUFFER_SIZE = 200;

class McpOperationTracker {
  private buffer: McpOperation[] = [];

  /** Record a tool invocation */
  record(op: McpOperation): void {
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
    this.buffer.push(op);
  }

  /** Drain all recorded operations (consumer calls this each snapshot) */
  drain(): McpOperation[] {
    return this.buffer.splice(0);
  }

  /** Peek at buffered operations without draining */
  peek(): readonly McpOperation[] {
    return this.buffer;
  }

  /** Get summary stats from current buffer */
  getSummary(): McpSummary {
    const ops = this.buffer;
    const total = ops.length;
    if (total === 0) {
      return {
        totalInvocations: 0,
        successCount: 0,
        failureCount: 0,
        avgDurationMs: 0,
        topTools: [],
      };
    }

    let successCount = 0;
    let totalDuration = 0;
    const toolCounts = new Map<string, number>();

    for (const op of ops) {
      if (op.success) successCount++;
      totalDuration += op.durationMs;
      toolCounts.set(op.tool, (toolCounts.get(op.tool) ?? 0) + 1);
    }

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    return {
      totalInvocations: total,
      successCount,
      failureCount: total - successCount,
      avgDurationMs: Math.round(totalDuration / total),
      topTools,
    };
  }

  get count(): number {
    return this.buffer.length;
  }
}

/** Global singleton — shared between withErrorHandler (producer) and cloud agent (consumer) */
export const mcpTracker = new McpOperationTracker();
