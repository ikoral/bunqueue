/**
 * Bunqueue Simple Mode — Type definitions
 */

import type {
  Job,
  JobOptions,
  Processor,
  ConnectionOptions,
  QueueOptions,
  WorkerOptions,
  RateLimiterOptions,
} from '../types';

/** Middleware function: receives job and next(), returns result */
export type BunqueueMiddleware<T = unknown, R = unknown> = (
  job: Job<T>,
  next: () => Promise<R>
) => Promise<R>;

/** Retry strategy for advanced backoff */
export type RetryStrategy = 'fixed' | 'exponential' | 'jitter' | 'fibonacci' | 'custom';

/** Advanced retry configuration */
export interface RetryConfig {
  /** Max attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms (default: 1000) */
  delay?: number;
  /** Strategy (default: exponential) */
  strategy?: RetryStrategy;
  /** Custom backoff function: attempt → delay in ms */
  customBackoff?: (attempt: number, error: Error) => number;
  /** Only retry if this returns true */
  retryIf?: (error: Error, attempt: number) => boolean;
}

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  /** Max consecutive failures before opening (default: 5) */
  threshold?: number;
  /** Time in ms before half-open retry (default: 30000) */
  resetTimeout?: number;
  /** Callback when circuit opens */
  onOpen?: (failures: number) => void;
  /** Callback when circuit closes */
  onClose?: () => void;
  /** Callback on half-open probe */
  onHalfOpen?: () => void;
}

/** Circuit breaker state */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Event trigger rule */
export interface TriggerRule<T = unknown> {
  /** Job name that triggers this rule */
  on: string;
  /** Event type (default: completed) */
  event?: 'completed' | 'failed';
  /** Job name to create */
  create: string;
  /** Data builder from the triggering job */
  data: (result: unknown, job: Job<T>) => T;
  /** Optional job options */
  opts?: JobOptions;
  /** Optional condition */
  condition?: (result: unknown, job: Job<T>) => boolean;
}

/** Priority aging configuration */
export interface PriorityAgingConfig {
  /** Check interval in ms (default: 60000) */
  interval?: number;
  /** Min age in ms before boost (default: 60000) */
  minAge?: number;
  /** Priority boost per interval (default: 1) */
  boost?: number;
  /** Max priority cap (default: 100) */
  maxPriority?: number;
  /** Max jobs to scan per tick (default: 100) */
  maxScan?: number;
}

/** Batch processor function */
export type BatchProcessor<T = unknown, R = unknown> = (jobs: Array<Job<T>>) => Promise<R[]>;

/** Batch processing configuration */
export interface BatchConfig<T = unknown, R = unknown> {
  /** Batch size (default: 10) */
  size: number;
  /** Max wait in ms before flushing partial batch (default: 5000) */
  timeout?: number;
  /** Batch processor function */
  processor: BatchProcessor<T, R>;
}

/** Job TTL configuration */
export interface JobTtlConfig {
  /** Default TTL in ms (0 = no TTL) */
  defaultTtl?: number;
  /** Per-job-name TTL overrides */
  perName?: Record<string, number>;
}

/** Deduplication configuration for Simple Mode */
export interface BunqueueDeduplicationConfig {
  /** Default deduplication TTL in ms (default: 3600000 = 1 hour) */
  ttl?: number;
  /** Extend TTL when duplicate arrives (default: false) */
  extend?: boolean;
  /** Replace data when duplicate arrives in delayed state (default: false) */
  replace?: boolean;
}

/** Debounce configuration for Simple Mode */
export interface BunqueueDebounceConfig {
  /** Default debounce TTL in ms */
  ttl: number;
}

/** DLQ configuration for Simple Mode */
export interface BunqueueDlqConfig {
  /** Enable auto-retry from DLQ (default: false) */
  autoRetry?: boolean;
  /** Auto-retry interval in ms (default: 3600000 = 1 hour) */
  autoRetryInterval?: number;
  /** Max auto-retries (default: 3) */
  maxAutoRetries?: number;
  /** Max age before auto-purge in ms (default: 604800000 = 7 days) */
  maxAge?: number | null;
  /** Max entries per queue (default: 10000) */
  maxEntries?: number;
}

/** Bunqueue options */
export interface BunqueueOptions<T = unknown, R = unknown> {
  processor?: Processor<T, R>;
  routes?: Record<string, Processor<T, R>>;
  batch?: BatchConfig<T, R>;
  concurrency?: number;
  connection?: ConnectionOptions;
  embedded?: boolean;
  dataPath?: string;
  defaultJobOptions?: JobOptions;
  autorun?: boolean;
  heartbeatInterval?: number;
  batchSize?: number;
  pollTimeout?: number;
  autoBatch?: QueueOptions['autoBatch'];
  limiter?: WorkerOptions['limiter'];
  removeOnComplete?: WorkerOptions['removeOnComplete'];
  removeOnFail?: WorkerOptions['removeOnFail'];
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  ttl?: JobTtlConfig;
  priorityAging?: PriorityAgingConfig;
  /** Job deduplication defaults — applied via defaultJobOptions */
  deduplication?: BunqueueDeduplicationConfig;
  /** Job debouncing defaults — applied via defaultJobOptions */
  debounce?: BunqueueDebounceConfig;
  /** Rate limiting for the worker */
  rateLimit?: RateLimiterOptions;
  /** Dead letter queue auto-management */
  dlq?: BunqueueDlqConfig;
  /**
   * Namespace prefix prepended to the queue name on the server. Lets multiple
   * environments (e.g. `dev:`, `prod:`) share the same broker without their
   * jobs, workers, cron schedulers, stats, or DLQ overlapping. Forwarded to
   * both the internal Queue and Worker. See `QueueOptions.prefixKey`.
   */
  prefixKey?: string;
}
