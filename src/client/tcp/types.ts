/**
 * TCP Client Types
 * Type definitions for TCP connection management
 */

/** Connection options */
export interface ConnectionOptions {
  /** Server host */
  host: string;
  /** Server port */
  port: number;
  /** Auth token */
  token?: string;
  /** Max reconnection attempts (default: Infinity) */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms (default: 100) */
  reconnectDelay?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Connection timeout in ms (default: 5000) */
  connectTimeout?: number;
  /** Command timeout in ms (default: 30000) */
  commandTimeout?: number;
  /** Enable auto-reconnect (default: true) */
  autoReconnect?: boolean;
  /** Health check ping interval in ms (default: 30000, 0 to disable) */
  pingInterval?: number;
  /** Max consecutive ping failures before forcing reconnect (default: 3) */
  maxPingFailures?: number;
}

/** Connection health metrics */
export interface ConnectionHealth {
  /** Whether connection is currently healthy */
  healthy: boolean;
  /** Current connection state */
  state: 'connected' | 'connecting' | 'disconnected' | 'closed';
  /** Timestamp of last successful command */
  lastSuccessAt: number | null;
  /** Timestamp of last error */
  lastErrorAt: number | null;
  /** Average latency of last 10 commands in ms */
  avgLatencyMs: number;
  /** Consecutive ping failures */
  consecutivePingFailures: number;
  /** Total commands sent */
  totalCommands: number;
  /** Total errors */
  totalErrors: number;
  /** Uptime since last connect in ms */
  uptimeMs: number;
}

/** Default connection options */
export const DEFAULT_CONNECTION: Required<ConnectionOptions> = {
  host: 'localhost',
  port: 6789,
  token: '',
  maxReconnectAttempts: Infinity,
  reconnectDelay: 100,
  maxReconnectDelay: 30000,
  connectTimeout: 5000,
  commandTimeout: 30000,
  autoReconnect: true,
  pingInterval: 30000,
  maxPingFailures: 3,
};

/** Pending command awaiting response */
export interface PendingCommand {
  id: number;
  command: Record<string, unknown>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Socket wrapper interface */
export interface SocketWrapper {
  write: (data: Uint8Array | string) => void;
  end: () => void;
  frameParser: FrameParser;
}

/** Frame parser interface for binary protocol parsing */
export interface FrameParser {
  addData(data: Uint8Array): Uint8Array[];
}
