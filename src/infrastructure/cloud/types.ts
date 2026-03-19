/**
 * bunqueue Cloud Types
 * Interfaces for the Cloud agent that sends telemetry to the remote dashboard
 */

/** Cloud configuration from environment variables */
export interface CloudConfig {
  /** Remote dashboard URL (e.g. https://bunqueue.io) */
  readonly url: string;
  /** API key for authentication */
  readonly apiKey: string;
  /** HMAC signing secret (optional) */
  readonly signingSecret: string | null;
  /** Human-readable instance name */
  readonly instanceName: string;
  /** Snapshot interval in ms (default: 5000) */
  readonly intervalMs: number;
  /** Include job data in events (default: false) */
  readonly includeJobData: boolean;
  /** Fields to redact from job data */
  readonly redactFields: string[];
  /** Event types to forward (empty = all) */
  readonly eventFilter: string[];
  /** Max snapshots in offline buffer (default: 720) */
  readonly bufferSize: number;
  /** Circuit breaker: failures before OPEN (default: 5) */
  readonly circuitBreakerThreshold: number;
  /** Circuit breaker: ms in OPEN before HALF_OPEN (default: 60000) */
  readonly circuitBreakerResetMs: number;
  /** Enable WebSocket event stream (default: true) */
  readonly useWebSocket: boolean;
  /** Enable HTTP snapshot posting (default: true) */
  readonly useHttp: boolean;
  /** Data directory for persisting instance ID */
  readonly dataPath: string | null;
  /** Enable remote commands from dashboard (default: false) */
  readonly remoteCommands: boolean;
}

/** Snapshot payload sent every N seconds via HTTP POST */
export interface CloudSnapshot {
  instanceId: string;
  instanceName: string;
  version: string;
  hostname: string;
  pid: number;
  startedAt: number;
  timestamp: number;
  sequenceId: number;
  shutdown?: boolean;

  stats: {
    waiting: number;
    delayed: number;
    active: number;
    dlq: number;
    completed: number;
    totalPushed: string;
    totalPulled: string;
    totalCompleted: string;
    totalFailed: string;
    stalled: number;
    paused: number;
    uptime: number;
    cronJobs: number;
    cronPending: number;
  };

  throughput: {
    pushPerSec: number;
    pullPerSec: number;
    completePerSec: number;
    failPerSec: number;
  };

  latency: {
    averages: { pushMs: number; pullMs: number; ackMs: number };
    percentiles: {
      push: { p50: number; p95: number; p99: number };
      pull: { p50: number; p95: number; p99: number };
      ack: { p50: number; p95: number; p99: number };
    };
  };

  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };

  collections: {
    jobIndex: number;
    completedJobs: number;
    jobResults: number;
    jobLogs: number;
    customIdMap: number;
    jobLocks: number;
    processingTotal: number;
    queuedTotal: number;
    temporalIndexTotal: number;
    delayedHeapTotal: number;
  };

  queues: Array<{
    name: string;
    waiting: number;
    delayed: number;
    active: number;
    dlq: number;
    paused: boolean;
  }>;

  workers: {
    total: number;
    active: number;
    totalProcessed: number;
    totalFailed: number;
    activeJobs: number;
  };

  crons: Array<{
    name: string;
    queue: string;
    schedule: string | null;
    nextRun: number;
  }>;

  storage: {
    diskFull: boolean;
    error: string | null;
  };

  taskErrors: Record<
    string,
    {
      consecutiveFailures: number;
      lastError?: string;
      lastFailureAt?: number;
    }
  >;

  /** Recent jobs across all queues (last ~50, newest first) */
  recentJobs: Array<{
    id: string;
    name: string;
    queue: string;
    state: string;
    data?: unknown;
    priority: number;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    failedReason?: string;
    attempts: number;
    maxAttempts: number;
    duration?: number;
    progress?: number;
  }>;

  /** DLQ entries across all queues (last ~50) */
  dlqEntries: Array<{
    jobId: string;
    queue: string;
    reason: string;
    error: string | null;
    enteredAt: number;
    retryCount: number;
    attempts: number;
  }>;

  /** Individual worker details */
  workerDetails: Array<{
    id: string;
    name: string;
    queues: string[];
    concurrency: number;
    hostname: string;
    pid: number;
    lastSeen: number;
    activeJobs: number;
    processedJobs: number;
    failedJobs: number;
    currentJob: string | null;
  }>;

  /** Per-queue configuration */
  queueConfigs: Record<
    string,
    {
      paused: boolean;
      stallConfig?: { stallInterval: number; maxStalls: number };
      dlqConfig?: { maxRetries: number; maxAge: number };
    }
  >;
}

/** Event payload forwarded via WebSocket */
export interface CloudEvent {
  instanceId: string;
  timestamp: number;
  jobEvent?: {
    eventType: string;
    queue: string;
    jobId: string;
    error?: string;
    progress?: number;
    data?: unknown;
  };
}
