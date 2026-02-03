/**
 * 4-ary MinHeap Priority Queue
 * Same implementation as bunqueue for accurate simulation
 */

import type { Job } from './types';

interface HeapEntry {
  jobId: string;
  priority: number;
  runAt: number;
  generation: bigint;
}

export class PriorityQueue {
  private heap: HeapEntry[] = [];
  private index: Map<string, { job: Job; generation: bigint }> = new Map();
  private currentGen: bigint = 0n;

  get size(): number {
    return this.index.size;
  }

  push(job: Job): void {
    const gen = ++this.currentGen;
    this.index.set(job.id, { job, generation: gen });

    const entry: HeapEntry = {
      jobId: job.id,
      priority: -job.priority, // Negate for max-heap behavior
      runAt: job.runAt,
      generation: gen,
    };

    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): Job | undefined {
    while (this.heap.length > 0) {
      const entry = this.heap[0];
      const indexed = this.index.get(entry.jobId);

      // Skip stale entries
      if (!indexed || indexed.generation !== entry.generation) {
        this.removeTop();
        continue;
      }

      // Skip delayed jobs not yet ready
      if (entry.runAt > Date.now()) {
        return undefined;
      }

      this.removeTop();
      const job = indexed.job;
      this.index.delete(entry.jobId);
      return job;
    }
    return undefined;
  }

  peek(): Job | undefined {
    for (const entry of this.heap) {
      const indexed = this.index.get(entry.jobId);
      if (indexed && indexed.generation === entry.generation) {
        return indexed.job;
      }
    }
    return undefined;
  }

  remove(jobId: string): Job | undefined {
    const indexed = this.index.get(jobId);
    if (!indexed) return undefined;

    this.index.delete(jobId);
    return indexed.job;
  }

  has(jobId: string): boolean {
    return this.index.has(jobId);
  }

  get(jobId: string): Job | undefined {
    return this.index.get(jobId)?.job;
  }

  getAll(): Job[] {
    return Array.from(this.index.values()).map(v => v.job);
  }

  getReady(): Job[] {
    const now = Date.now();
    return this.getAll()
      .filter(j => j.runAt <= now)
      .sort((a, b) => b.priority - a.priority || a.runAt - b.runAt);
  }

  getDelayed(): Job[] {
    const now = Date.now();
    return this.getAll()
      .filter(j => j.runAt > now)
      .sort((a, b) => a.runAt - b.runAt);
  }

  private removeTop(): void {
    if (this.heap.length <= 1) {
      this.heap.pop();
      return;
    }
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIdx = Math.floor((index - 1) / 4);
      if (this.compare(index, parentIdx) >= 0) break;
      this.swap(index, parentIdx);
      index = parentIdx;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      let smallest = index;
      const firstChild = index * 4 + 1;

      for (let i = 0; i < 4 && firstChild + i < this.heap.length; i++) {
        if (this.compare(firstChild + i, smallest) < 0) {
          smallest = firstChild + i;
        }
      }

      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  private compare(i: number, j: number): number {
    const a = this.heap[i];
    const b = this.heap[j];
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.runAt - b.runAt;
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}
