/**
 * Shared types for QueueManager modules
 */

import type { Job, JobId, JobLock } from '../domain/types/job';
import type { JobLocation } from '../domain/types/queue';
import type { JobLogEntry } from '../domain/types/worker';
import type { Shard } from '../domain/queue/shard';
import type { SqliteStorage } from '../infrastructure/persistence/sqlite';
import type { RWLock } from '../shared/lock';
import type { LRUMap, BoundedSet, SetLike } from '../shared/lru';
import type { EventsManager } from './eventsManager';
import type { WebhookManager } from './webhookManager';

/** Queue Manager configuration */
export interface QueueManagerConfig {
  dataPath?: string;
  maxCompletedJobs?: number;
  maxJobResults?: number;
  maxJobLogs?: number;
  maxCustomIds?: number;
  maxWaitingDeps?: number;
  cleanupIntervalMs?: number;
  jobTimeoutCheckMs?: number;
  dependencyCheckMs?: number;
  stallCheckMs?: number;
  dlqMaintenanceMs?: number;
}

export const DEFAULT_CONFIG = {
  maxCompletedJobs: 50_000,
  maxJobResults: 10_000,
  maxJobLogs: 10_000,
  maxCustomIds: 50_000,
  maxWaitingDeps: 10_000,
  cleanupIntervalMs: 10_000,
  jobTimeoutCheckMs: 5_000,
  dependencyCheckMs: 30_000, // Safety fallback only; event-driven handles fast path
  stallCheckMs: 5_000,
  dlqMaintenanceMs: 60_000,
};

/** Shared state accessible by all modules */
export interface QueueManagerState {
  readonly config: typeof DEFAULT_CONFIG & { dataPath?: string };
  readonly storage: SqliteStorage | null;

  // Sharded data structures
  readonly shards: Shard[];
  readonly shardLocks: RWLock[];
  readonly processingShards: Map<JobId, Job>[];
  readonly processingLocks: RWLock[];

  // Global indexes
  readonly jobIndex: Map<JobId, JobLocation>;
  readonly completedJobs: BoundedSet<JobId>;
  readonly jobResults: LRUMap<JobId, unknown>;
  readonly customIdMap: LRUMap<string, JobId>;
  readonly jobLogs: LRUMap<JobId, JobLogEntry[]>;

  // Lock tracking
  readonly jobLocks: Map<JobId, JobLock>;
  readonly clientJobs: Map<string, Set<JobId>>;

  // Stall detection
  readonly stalledCandidates: Set<JobId>;

  // Dependency tracking
  readonly pendingDepChecks: Set<JobId>;

  // Queue names cache
  readonly queueNamesCache: Set<string>;

  // Managers
  readonly eventsManager: EventsManager;
  readonly webhookManager: WebhookManager;

  // Metrics
  readonly metrics: {
    totalPushed: { value: bigint };
    totalPulled: { value: bigint };
    totalCompleted: { value: bigint };
    totalFailed: { value: bigint };
  };
  readonly startTime: number;

  // Per-queue metrics
  readonly perQueueMetrics: Map<string, { totalCompleted: bigint; totalFailed: bigint }>;
}

/** Context for lock operations */
export interface LockContext {
  jobIndex: Map<JobId, JobLocation>;
  jobLocks: Map<JobId, JobLock>;
  clientJobs: Map<string, Set<JobId>>;
  processingShards: Map<JobId, Job>[];
  processingLocks: RWLock[];
  shards: Shard[];
  shardLocks: RWLock[];
  eventsManager: EventsManager;
}

/** Context for background tasks */
export interface BackgroundContext extends QueueManagerState {
  // Methods that background tasks need to call
  fail: (jobId: JobId, error?: string) => Promise<void>;
  registerQueueName: (queue: string) => void;
  unregisterQueueName: (queue: string) => void;
}

/** Context for stats operations */
export interface StatsContext {
  shards: Shard[];
  processingShards: Map<JobId, Job>[];
  completedJobs: SetLike<JobId>;
  jobIndex: Map<JobId, JobLocation>;
  jobResults: LRUMap<JobId, unknown>;
  jobLogs: LRUMap<JobId, JobLogEntry[]>;
  customIdMap: LRUMap<string, JobId>;
  jobLocks: Map<JobId, JobLock>;
  clientJobs: Map<string, Set<JobId>>;
  pendingDepChecks: Set<JobId>;
  stalledCandidates: Set<JobId>;
  metrics: {
    totalPushed: { value: bigint };
    totalPulled: { value: bigint };
    totalCompleted: { value: bigint };
    totalFailed: { value: bigint };
  };
  startTime: number;
  perQueueMetrics?: Map<string, { totalCompleted: bigint; totalFailed: bigint }>;
}
