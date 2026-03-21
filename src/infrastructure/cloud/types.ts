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
    totalCompleted: number;
    totalFailed: number;
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
    executions: number;
    maxLimit: number | null;
    lastRun: number | null;
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

  /** Per-queue configuration (includes rate limit + concurrency) */
  queueConfigs: Record<
    string,
    {
      paused: boolean;
      rateLimit: number | null;
      concurrencyLimit: number | null;
      concurrencyActive: number;
      stallConfig?: { stallInterval: number; maxStalls: number };
      dlqConfig?: { maxRetries: number; maxAge: number };
    }
  >;

  /** Connection stats — TCP, WebSocket, SSE clients */
  connections: {
    tcp: number;
    ws: number;
    sse: number;
  };

  /** Registered webhooks with delivery stats */
  webhooks: Array<{
    id: string;
    url: string;
    events: string[];
    queue: string | null;
    enabled: boolean;
    successCount: number;
    failureCount: number;
    lastTriggered: number | null;
  }>;

  /** Top recent errors (last ~20, grouped by message) */
  topErrors: Array<{
    message: string;
    count: number;
    queue: string;
    lastSeen: number;
  }>;

  /** Per-queue throughput (push/complete/fail per second) */
  queueThroughput: Record<
    string,
    {
      pushPerSec: number;
      completePerSec: number;
      failPerSec: number;
      errorRate: number;
    }
  >;

  /** Job duration histogram buckets (ms thresholds) */
  durationHistogram: {
    lt100ms: number;
    lt1s: number;
    lt10s: number;
    lt60s: number;
    gt60s: number;
  };

  /** Per-worker utilization (activeJobs / concurrency) */
  workerUtilization: Array<{
    id: string;
    name: string;
    utilization: number;
  }>;

  /** SQLite storage stats (null if in-memory mode) */
  sqliteStats: {
    dbSizeBytes: number;
    writeBufferPending: number;
  } | null;

  /** Runtime environment */
  runtime: {
    bunVersion: string;
    os: string;
    arch: string;
    cpus: number;
  };

  /** Per-queue priority distribution */
  queuePriorityDistribution: Record<string, Record<number, number>>;

  /** Per-queue job wait time stats (time in queue before processing) */
  queueWaitTime: Record<
    string,
    {
      avgMs: number;
      maxMs: number;
      minMs: number;
    }
  >;

  /** Per-queue retry rate (% jobs with attempts > 0) */
  queueRetryRate: Record<
    string,
    {
      retryRate: number;
      retrying: number;
      total: number;
    }
  >;

  /** Queue backlog velocity — delta of waiting jobs between snapshots */
  queueBacklogVelocity: Record<
    string,
    {
      deltaWaiting: number;
      deltaPerMin: number;
      trend: 'growing' | 'shrinking' | 'stable';
    }
  >;

  /** Stall details — currently stalled jobs */
  stallDetails: Array<{
    jobId: string;
    queue: string;
    workerId: string | null;
    stalledAt: number;
    stalledForMs: number;
  }>;

  /** Buffered events embedded in snapshot */
  events?: CloudEvent[];

  /** S3 backup status (null if not configured) */
  s3Backup: {
    enabled: boolean;
    bucket: string;
    endpoint: string;
    intervalMs: number;
    retention: number;
    isRunning: boolean;
  } | null;
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
    prev?: string;
    delay?: number;
  };
}
