/**
 * ACK Batcher
 * Batches acknowledgments for efficient TCP communication
 */

import type { PendingAck, TcpConnection } from './types';
import { getSharedManager } from '../manager';
import { jobId } from '../../domain/types/job';

/** ACK batcher configuration */
export interface AckBatcherConfig {
  batchSize: number;
  interval: number;
  embedded: boolean;
}

/**
 * Batches ACK operations for efficient processing
 */
export class AckBatcher {
  private readonly pendingAcks: PendingAck[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly config: AckBatcherConfig;
  private tcp: TcpConnection | null = null;

  constructor(config: AckBatcherConfig) {
    this.config = config;
  }

  /** Set TCP connection */
  setTcp(tcp: TcpConnection | null): void {
    this.tcp = tcp;
  }

  /** Queue ACK for batch processing */
  queue(id: string, result: unknown): void {
    this.pendingAcks.push({
      id,
      result,
      resolve: () => {},
      reject: () => {},
    });

    if (this.pendingAcks.length >= this.config.batchSize) {
      void this.flush();
    } else {
      this.ackTimer ??= setTimeout(() => {
        this.ackTimer = null;
        void this.flush();
      }, this.config.interval);
    }
  }

  /** Flush pending ACKs */
  async flush(): Promise<void> {
    if (this.pendingAcks.length === 0) return;

    const batch = this.pendingAcks.splice(0, this.pendingAcks.length);

    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }

    try {
      if (this.config.embedded) {
        const manager = getSharedManager();
        const items = batch.map((a) => ({ id: jobId(a.id), result: a.result }));
        await manager.ackBatchWithResults(items);
      } else if (this.tcp) {
        const response = await this.tcp.send({
          cmd: 'ACKB',
          ids: batch.map((a) => a.id),
          results: batch.map((a) => a.result),
        });

        if (!response.ok) {
          throw new Error((response.error as string | undefined) ?? 'Batch ACK failed');
        }
      }

      for (const ack of batch) {
        ack.resolve();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const ack of batch) {
        ack.reject(error);
      }
    }
  }

  /** Stop and cleanup */
  stop(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }
}
