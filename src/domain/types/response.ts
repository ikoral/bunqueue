/**
 * Protocol responses
 * All response types for TCP/HTTP protocol
 */

import type { Job, JobState } from './job';

/** Base response interface */
interface BaseResponse {
  readonly ok: boolean;
  readonly reqId?: string;
}

/** Success response with job ID */
export interface OkResponse extends BaseResponse {
  readonly ok: true;
  readonly id?: string;
}

/** Batch success response */
export interface BatchResponse extends BaseResponse {
  readonly ok: true;
  readonly ids: string[];
}

/** Single job response */
export interface JobResponse extends BaseResponse {
  readonly ok: true;
  readonly job: Job;
}

/** Nullable job response (for pull with timeout) */
export interface NullableJobResponse extends BaseResponse {
  readonly ok: true;
  readonly job: Job | null;
}

/** Pulled job response (includes lock token for ownership) */
export interface PulledJobResponse extends BaseResponse {
  readonly ok: true;
  readonly job: Job | null;
  readonly token: string | null; // Lock token for job ownership
}

/** Pulled jobs batch response (includes lock tokens) */
export interface PulledJobsResponse extends BaseResponse {
  readonly ok: true;
  readonly jobs: Job[];
  readonly tokens: string[]; // Lock tokens for each job (same order)
}

/** Multiple jobs response */
export interface JobsResponse extends BaseResponse {
  readonly ok: true;
  readonly jobs: Job[];
}

/** Job state response */
export interface StateResponse extends BaseResponse {
  readonly ok: true;
  readonly id: string;
  readonly state: JobState;
}

/** Job result response */
export interface ResultResponse extends BaseResponse {
  readonly ok: true;
  readonly id: string;
  readonly result: unknown;
}

/** Job counts by state */
export interface JobCounts {
  readonly waiting: number;
  readonly delayed: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly paused: number;
}

/** Job counts response */
export interface JobCountsResponse extends BaseResponse {
  readonly ok: true;
  readonly counts: JobCounts;
}

/** Queue info */
export interface QueueInfo {
  readonly name: string;
  readonly waiting: number;
  readonly delayed: number;
  readonly active: number;
  readonly paused: boolean;
}

/** Queue list response */
export interface QueuesResponse extends BaseResponse {
  readonly ok: true;
  readonly queues: QueueInfo[];
}

/** Progress response */
export interface ProgressResponse extends BaseResponse {
  readonly ok: true;
  readonly progress: number;
  readonly message: string | null;
}

/** Boolean response */
export interface BoolResponse extends BaseResponse {
  readonly ok: true;
  readonly value: boolean;
}

/** Count response */
export interface CountResponse extends BaseResponse {
  readonly ok: true;
  readonly count: number;
}

/** Stats response */
export interface StatsData {
  readonly queued: number;
  readonly processing: number;
  readonly delayed: number;
  readonly dlq: number;
  readonly completed: number;
  readonly uptime: number;
  readonly pushPerSec: number;
  readonly pullPerSec: number;
}

export interface StatsResponse extends BaseResponse {
  readonly ok: true;
  readonly stats: StatsData;
}

/** Metrics response */
export interface MetricsData {
  readonly totalPushed: number;
  readonly totalPulled: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
  readonly avgLatencyMs: number;
  readonly avgProcessingMs: number;
  readonly memoryUsageMb: number;
  readonly sqliteSizeMb: number;
  readonly activeConnections: number;
}

export interface MetricsResponse extends BaseResponse {
  readonly ok: true;
  readonly metrics: MetricsData;
}

/** Cron job info */
export interface CronInfo {
  readonly name: string;
  readonly queue: string;
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  readonly nextRun: number;
  readonly executions: number;
}

/** Cron list response */
export interface CronListResponse extends BaseResponse {
  readonly ok: true;
  readonly crons: CronInfo[];
}

/** Error response */
export interface ErrorResponse extends BaseResponse {
  readonly ok: false;
  readonly error: string;
}

/** Protocol capability */
export type ProtocolCapability = 'pipelining';

/** Hello response for protocol negotiation */
export interface HelloResponse extends BaseResponse {
  readonly ok: true;
  /** Server protocol version */
  readonly protocolVersion: number;
  /** Supported capabilities */
  readonly capabilities: ProtocolCapability[];
  /** Server name */
  readonly server: string;
  /** Server version */
  readonly version: string;
}

/** Union of all responses */
export type Response =
  | OkResponse
  | BatchResponse
  | JobResponse
  | NullableJobResponse
  | PulledJobResponse
  | PulledJobsResponse
  | JobsResponse
  | StateResponse
  | ResultResponse
  | JobCountsResponse
  | QueuesResponse
  | ProgressResponse
  | BoolResponse
  | CountResponse
  | StatsResponse
  | MetricsResponse
  | CronListResponse
  | HelloResponse
  | ErrorResponse
  | DataResponse<unknown>;

// ============ Response Builders ============

export function ok(id?: string, reqId?: string): OkResponse {
  return {
    ok: true,
    id,
    reqId,
  };
}

export function batch(ids: string[], reqId?: string): BatchResponse {
  return {
    ok: true,
    ids,
    reqId,
  };
}

export function job(j: Job, reqId?: string): JobResponse {
  return {
    ok: true,
    job: j,
    reqId,
  };
}

export function nullableJob(j: Job | null, reqId?: string): NullableJobResponse {
  return {
    ok: true,
    job: j,
    reqId,
  };
}

export function pulledJob(j: Job | null, token: string | null, reqId?: string): PulledJobResponse {
  return {
    ok: true,
    job: j,
    token,
    reqId,
  };
}

export function pulledJobs(list: Job[], tokens: string[], reqId?: string): PulledJobsResponse {
  return {
    ok: true,
    jobs: list,
    tokens,
    reqId,
  };
}

export function jobs(list: Job[], reqId?: string): JobsResponse {
  return {
    ok: true,
    jobs: list,
    reqId,
  };
}

export function error(message: string, reqId?: string): ErrorResponse {
  return {
    ok: false,
    error: message,
    reqId,
  };
}

export function hello(
  protocolVersion: number,
  capabilities: ProtocolCapability[],
  server: string,
  version: string,
  reqId?: string
): HelloResponse {
  return {
    ok: true,
    protocolVersion,
    capabilities,
    server,
    version,
    reqId,
  };
}

/** Generic success response with data payload */
export interface DataResponse<T> extends BaseResponse {
  readonly ok: true;
  readonly data: T;
}

export function data<T>(payload: T, reqId?: string): DataResponse<T> {
  return {
    ok: true,
    data: payload,
    reqId,
  };
}

export function counts(c: JobCounts, reqId?: string): JobCountsResponse {
  return {
    ok: true,
    counts: c,
    reqId,
  };
}

export function stats(s: StatsData, reqId?: string): StatsResponse {
  return {
    ok: true,
    stats: s,
    reqId,
  };
}

export function metrics(m: MetricsData, reqId?: string): MetricsResponse {
  return {
    ok: true,
    metrics: m,
    reqId,
  };
}
