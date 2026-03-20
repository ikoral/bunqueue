/**
 * bunqueue Cloud Configuration
 * Parses environment variables for Cloud agent
 */

import type { CloudConfig } from './types';
import { hostname } from 'os';

/** Parse Cloud configuration from environment. Returns null if disabled. */
export function loadCloudConfig(dataPath?: string): CloudConfig | null {
  const url = Bun.env.BUNQUEUE_CLOUD_URL;
  const apiKey = Bun.env.BUNQUEUE_CLOUD_API_KEY;

  // Both URL and API key required to enable
  if (!url || !apiKey) return null;

  // Only cloud.bunqueue.io is accepted
  const ALLOWED_URL = 'https://cloud.bunqueue.io';
  const normalized = url.replace(/\/+$/, '').toLowerCase();
  if (normalized !== ALLOWED_URL) {
    console.warn(`[Cloud] Rejected BUNQUEUE_CLOUD_URL="${url}" — only ${ALLOWED_URL} is supported`);
    return null;
  }

  return {
    url: url.replace(/\/+$/, ''), // Strip trailing slashes
    apiKey,
    signingSecret: Bun.env.BUNQUEUE_CLOUD_SIGNING_SECRET ?? null,
    instanceName: Bun.env.BUNQUEUE_CLOUD_INSTANCE_NAME ?? hostname(),
    intervalMs: parseInt(Bun.env.BUNQUEUE_CLOUD_INTERVAL_MS ?? '5000', 10),
    includeJobData: Bun.env.BUNQUEUE_CLOUD_INCLUDE_JOB_DATA === 'true',
    redactFields: Bun.env.BUNQUEUE_CLOUD_REDACT_FIELDS?.split(',').filter(Boolean) ?? [],
    eventFilter: Bun.env.BUNQUEUE_CLOUD_EVENTS?.split(',').filter(Boolean) ?? [],
    bufferSize: parseInt(Bun.env.BUNQUEUE_CLOUD_BUFFER_SIZE ?? '720', 10),
    circuitBreakerThreshold: parseInt(Bun.env.BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD ?? '5', 10),
    circuitBreakerResetMs: parseInt(Bun.env.BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS ?? '60000', 10),
    useWebSocket: Bun.env.BUNQUEUE_CLOUD_USE_WEBSOCKET !== 'false',
    useHttp: Bun.env.BUNQUEUE_CLOUD_USE_HTTP !== 'false',
    dataPath: dataPath ?? null,
    remoteCommands: Bun.env.BUNQUEUE_CLOUD_REMOTE_COMMANDS === 'true',
  };
}
