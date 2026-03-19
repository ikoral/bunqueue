/**
 * Snapshot Buffer
 * Stores snapshots locally when the dashboard is unreachable.
 * On reconnect, flushes buffered data so the dashboard fills historical gaps.
 */

import type { CloudSnapshot } from './types';

export class SnapshotBuffer {
  private readonly items: CloudSnapshot[] = [];

  constructor(private readonly maxSize: number) {}

  /** Add a snapshot. Drops oldest if full. */
  push(snapshot: CloudSnapshot): void {
    if (this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(snapshot);
  }

  /** Drain up to `count` snapshots for sending */
  drain(count: number): CloudSnapshot[] {
    return this.items.splice(0, Math.min(count, this.items.length));
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}
