/**
 * bunqueue Cloud - Remote dashboard telemetry agent
 *
 * Sends periodic snapshots and real-time events to bunqueue Cloud (bunqueue.io).
 * Enabled by setting BUNQUEUE_CLOUD_URL and BUNQUEUE_CLOUD_API_KEY env vars.
 * Zero overhead when disabled.
 */

export { CloudAgent } from './cloudAgent';
export { loadCloudConfig } from './config';
export type { CloudConfig, CloudSnapshot, CloudEvent } from './types';
