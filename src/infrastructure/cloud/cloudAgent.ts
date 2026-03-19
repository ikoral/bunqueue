/**
 * bunqueue Cloud Agent
 * Main orchestrator that collects telemetry and sends it to bunqueue Cloud.
 *
 * Two channels:
 *   1. HTTP POST (periodic snapshots every N seconds)
 *   2. WebSocket (real-time event forwarding)
 *
 * Zero overhead when disabled (BUNQUEUE_CLOUD_URL not set).
 */

import type { QueueManager } from '../../application/queueManager';
import type { JobEvent } from '../../domain/types/queue';
import type { CloudConfig, CloudEvent } from './types';
import { loadCloudConfig } from './config';
import { getInstanceId } from './instanceId';
import { collectSnapshot, type ServerHandles } from './snapshotCollector';
import { HttpSender } from './httpSender';
import { WsSender } from './wsSender';
import { handleCommand } from './commandHandler';
import { cloudLog } from './logger';

export class CloudAgent {
  private readonly config: CloudConfig;
  private readonly instanceId: string;
  private readonly startedAt = Date.now();
  private readonly httpSender: HttpSender;
  private readonly wsSender: WsSender | null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private sequenceId = 0;
  private snapshotCount = 0;
  private stopped = false;
  private serverHandles?: ServerHandles;
  /** Heavy data collected every N snapshots (default: every 6th = every 30s at 5s interval) */
  private readonly heavyEveryN = 6;

  constructor(
    private readonly queueManager: QueueManager,
    config: CloudConfig
  ) {
    this.config = config;
    this.instanceId = getInstanceId(config.dataPath);
    this.httpSender = new HttpSender(config);
    this.wsSender = config.useWebSocket ? new WsSender(config, this.instanceId) : null;
  }

  /** Set server handles for connection stats */
  setServerHandles(handles: ServerHandles): void {
    this.serverHandles = handles;
  }

  /** Create and start a Cloud agent if configured. Returns null if disabled. */
  static create(queueManager: QueueManager, dataPath?: string): CloudAgent | null {
    const config = loadCloudConfig(dataPath);
    if (!config) return null;

    const agent = new CloudAgent(queueManager, config);
    agent.start();
    return agent;
  }

  /** Start both channels */
  start(): void {
    cloudLog.info('Connecting to dashboard', {
      url: this.config.url,
      instance: this.config.instanceName,
      id: this.instanceId,
      intervalMs: this.config.intervalMs,
      ws: this.config.useWebSocket,
    });

    // Channel 1: HTTP snapshots
    if (this.config.useHttp) {
      // Send first snapshot immediately
      void this.sendSnapshot();
      this.snapshotTimer = setInterval(() => {
        void this.sendSnapshot();
      }, this.config.intervalMs);
    }

    // Channel 2: WebSocket events + remote commands
    if (this.wsSender) {
      // Register command handler if remote commands enabled
      if (this.config.remoteCommands) {
        cloudLog.info('Remote commands enabled');
        this.wsSender.setCommandHandler((cmd) => {
          handleCommand(this.queueManager, cmd)
            .then((result) => this.wsSender?.sendRaw(result))
            .catch((err: unknown) => {
              cloudLog.debug('Command handler error', { error: String(err) });
            });
        });
      }

      this.wsSender.connect();
      this.subscribeToEvents();
    }
  }

  /** Graceful shutdown: send final snapshot, close connections */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = null;
    }

    // Send final shutdown snapshot (best-effort, 2s timeout)
    try {
      const snapshot = collectSnapshot({
        queueManager: this.queueManager,
        instanceId: this.instanceId,
        instanceName: this.config.instanceName,
        startedAt: this.startedAt,
        sequenceId: ++this.sequenceId,
        serverHandles: this.serverHandles,
        includeHeavy: true,
      });
      snapshot.shutdown = true;

      await Promise.race([this.httpSender.send(snapshot), Bun.sleep(2000)]);
    } catch {
      // Best-effort
    }

    this.wsSender?.stop();
    cloudLog.info('Disconnected from dashboard');
  }

  /** Collect and send a snapshot. Heavy data included every Nth snapshot. */
  private async sendSnapshot(): Promise<void> {
    try {
      this.snapshotCount++;
      const includeHeavy = this.snapshotCount % this.heavyEveryN === 1 || this.snapshotCount === 1;

      const snapshot = collectSnapshot({
        queueManager: this.queueManager,
        instanceId: this.instanceId,
        instanceName: this.config.instanceName,
        startedAt: this.startedAt,
        sequenceId: ++this.sequenceId,
        serverHandles: this.serverHandles,
        includeHeavy,
      });
      await this.httpSender.send(snapshot);
    } catch (err) {
      cloudLog.debug('Snapshot send failed', { error: String(err) });
    }
  }

  /** Subscribe to job events for WebSocket forwarding */
  private subscribeToEvents(): void {
    this.unsubscribeEvents = this.queueManager.subscribe((event: JobEvent) => {
      if (!this.wsSender) return;

      // Apply event filter
      if (
        this.config.eventFilter.length > 0 &&
        !this.config.eventFilter.includes(event.eventType)
      ) {
        return;
      }

      const cloudEvent: CloudEvent = {
        instanceId: this.instanceId,
        timestamp: event.timestamp,
        jobEvent: {
          eventType: event.eventType,
          queue: event.queue,
          jobId: event.jobId,
          error: event.error,
          progress: event.progress,
          data: this.config.includeJobData ? this.redactData(event.data) : undefined,
        },
      };

      this.wsSender.send(cloudEvent);
    });
  }

  /** Redact sensitive fields from job data */
  private redactData(data: unknown): unknown {
    if (!data || typeof data !== 'object' || this.config.redactFields.length === 0) {
      return data;
    }

    const redacted = { ...(data as Record<string, unknown>) };
    for (const field of this.config.redactFields) {
      if (field in redacted) {
        redacted[field] = '[REDACTED]';
      }
    }
    return redacted;
  }

  getInstanceId(): string {
    return this.instanceId;
  }
}
