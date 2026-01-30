/**
 * Benchmark suite for algorithm optimizations
 */

import { SkipList } from '../src/shared/skipList';
import { MinHeap } from '../src/shared/minHeap';
import { LRUMap, LRUSet, TTLMap } from '../src/shared/lru';

// Benchmark utilities
function bench(name: string, fn: () => void, iterations: number = 10000): number {
  // Warmup
  for (let i = 0; i < 100; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  console.log(`  ${name}: ${elapsed.toFixed(2)}ms (${opsPerSec.toLocaleString()} ops/sec)`);
  return elapsed;
}

function header(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ============ Skip List vs Array with splice ============

function benchSkipListVsArray() {
  header('Skip List vs Array (sorted insert)');

  const SIZES = [1000, 5000, 10000];

  for (const size of SIZES) {
    console.log(`\n  Size: ${size} elements`);

    // Array with binary search + splice
    const arrayTime = bench(
      'Array splice    ',
      () => {
        const arr: number[] = [];
        for (let i = 0; i < size; i++) {
          const val = Math.random() * size;
          // Binary search
          let lo = 0,
            hi = arr.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid] < val) lo = mid + 1;
            else hi = mid;
          }
          arr.splice(lo, 0, val);
        }
      },
      10
    );

    // Skip List
    const skipTime = bench(
      'Skip List       ',
      () => {
        const skip = new SkipList<number>((a, b) => a - b);
        for (let i = 0; i < size; i++) {
          skip.insert(Math.random() * size);
        }
      },
      10
    );

    console.log(`  Speedup: ${(arrayTime / skipTime).toFixed(2)}x`);
  }
}

// ============ LRUMap optimized vs naive ============

function benchLRUMap() {
  header('LRUMap (doubly-linked list vs Map delete+set)');

  // Naive LRU implementation for comparison
  class NaiveLRUMap<K, V> {
    private readonly cache = new Map<K, V>();
    private readonly maxSize: number;

    constructor(maxSize: number) {
      this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
      const value = this.cache.get(key);
      if (value !== undefined) {
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      return value;
    }

    set(key: K, value: V): void {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      } else if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }
  }

  const SIZES = [1000, 5000, 10000];
  const OPS = 50000;

  for (const size of SIZES) {
    console.log(`\n  Cache size: ${size}, Operations: ${OPS}`);

    // Fill caches first
    const naive = new NaiveLRUMap<number, number>(size);
    const optimized = new LRUMap<number, number>(size);

    for (let i = 0; i < size; i++) {
      naive.set(i, i);
      optimized.set(i, i);
    }

    // Benchmark get operations (triggers move-to-front)
    const naiveTime = bench(
      'Naive (delete+set)',
      () => {
        for (let i = 0; i < OPS; i++) {
          naive.get(i % size);
        }
      },
      1
    );

    const optTime = bench(
      'Optimized (linked)',
      () => {
        for (let i = 0; i < OPS; i++) {
          optimized.get(i % size);
        }
      },
      1
    );

    console.log(`  Speedup: ${(naiveTime / optTime).toFixed(2)}x`);
  }
}

// ============ TTLMap with MinHeap vs Array ============

function benchTTLMap() {
  header('TTLMap insert (MinHeap vs Array splice)');

  // Naive TTLMap with array splice for comparison
  class NaiveTTLMap<K, V> {
    private readonly cache = new Map<K, { value: V; expiresAt: number }>();
    private readonly expiryArray: Array<{ expiresAt: number; key: K }> = [];
    private readonly ttlMs: number;

    constructor(ttlMs: number) {
      this.ttlMs = ttlMs;
    }

    set(key: K, value: V): void {
      const expiresAt = Date.now() + this.ttlMs;
      this.cache.set(key, { value, expiresAt });

      // Binary search + splice (O(n))
      let lo = 0,
        hi = this.expiryArray.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.expiryArray[mid].expiresAt < expiresAt) lo = mid + 1;
        else hi = mid;
      }
      this.expiryArray.splice(lo, 0, { expiresAt, key });
    }

    get size() {
      return this.cache.size;
    }
  }

  const SIZES = [1000, 5000, 10000];

  for (const size of SIZES) {
    console.log(`\n  Insertions: ${size}`);

    const naiveTime = bench(
      'Naive (array splice)',
      () => {
        const map = new NaiveTTLMap<number, number>(60000);
        for (let i = 0; i < size; i++) {
          map.set(i, i);
        }
      },
      10
    );

    const optTime = bench(
      'Optimized (MinHeap)',
      () => {
        const map = new TTLMap<number, number>(60000, 999999999);
        for (let i = 0; i < size; i++) {
          map.set(i, i);
        }
        map.stop();
      },
      10
    );

    console.log(`  Speedup: ${(naiveTime / optTime).toFixed(2)}x`);
  }
}

// ============ MinHeap operations ============

function benchMinHeap() {
  header('MinHeap vs Sorted Array');

  const SIZES = [1000, 5000, 10000];

  for (const size of SIZES) {
    console.log(`\n  Size: ${size} elements`);

    // Sorted array with shift (O(1) pop but O(n) insert)
    const arrayTime = bench(
      'Sorted Array   ',
      () => {
        const arr: number[] = [];
        // Insert
        for (let i = 0; i < size; i++) {
          const val = Math.random() * size;
          let lo = 0,
            hi = arr.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid] < val) lo = mid + 1;
            else hi = mid;
          }
          arr.splice(lo, 0, val);
        }
        // Pop half
        for (let i = 0; i < size / 2; i++) {
          arr.shift();
        }
      },
      10
    );

    // MinHeap (O(log n) insert, O(log n) pop)
    const heapTime = bench(
      'MinHeap        ',
      () => {
        const heap = new MinHeap<number>((a, b) => a - b);
        // Insert
        for (let i = 0; i < size; i++) {
          heap.push(Math.random() * size);
        }
        // Pop half
        for (let i = 0; i < size / 2; i++) {
          heap.pop();
        }
      },
      10
    );

    console.log(`  Speedup: ${(arrayTime / heapTime).toFixed(2)}x`);
  }
}

// ============ Delayed Jobs Refresh Simulation ============

function benchDelayedRefresh() {
  header('Delayed Jobs Refresh (MinHeap vs Full Scan)');

  const QUEUE_COUNTS = [10, 50, 100];
  const DELAYED_JOBS = 5000;

  for (const queueCount of QUEUE_COUNTS) {
    console.log(`\n  Queues: ${queueCount}, Delayed jobs: ${DELAYED_JOBS}`);

    // Simulate old approach: iterate all delayed jobs, then all queues
    const oldTime = bench(
      'Old (O(n × queues))',
      () => {
        const delayedJobIds = new Set<number>();
        const queues = new Map<string, Map<number, { runAt: number }>>();

        // Setup
        for (let i = 0; i < queueCount; i++) {
          queues.set(`queue-${i}`, new Map());
        }
        const now = Date.now();
        for (let i = 0; i < DELAYED_JOBS; i++) {
          const queueIdx = i % queueCount;
          const queue = queues.get(`queue-${queueIdx}`)!;
          const runAt = now + Math.random() * 10000 - 5000; // Some ready, some not
          queue.set(i, { runAt });
          delayedJobIds.add(i);
        }

        // Old refresh: O(delayed × queues)
        const toRemove: number[] = [];
        for (const jobId of delayedJobIds) {
          for (const q of queues.values()) {
            const job = q.get(jobId);
            if (job && job.runAt <= now) {
              toRemove.push(jobId);
              break;
            }
          }
        }
        for (const id of toRemove) {
          delayedJobIds.delete(id);
        }
      },
      10
    );

    // New approach: MinHeap ordered by runAt
    const newTime = bench(
      'New (O(k) heap)    ',
      () => {
        const delayedHeap = new MinHeap<{ jobId: number; runAt: number }>((a, b) => a.runAt - b.runAt);
        const delayedRunAt = new Map<number, number>();

        // Setup
        const now = Date.now();
        for (let i = 0; i < DELAYED_JOBS; i++) {
          const runAt = now + Math.random() * 10000 - 5000;
          delayedHeap.push({ jobId: i, runAt });
          delayedRunAt.set(i, runAt);
        }

        // New refresh: O(k) where k = ready jobs
        while (!delayedHeap.isEmpty) {
          const top = delayedHeap.peek();
          if (!top || top.runAt > now) break;
          delayedHeap.pop();
          const currentRunAt = delayedRunAt.get(top.jobId);
          if (currentRunAt === top.runAt) {
            delayedRunAt.delete(top.jobId);
          }
        }
      },
      10
    );

    console.log(`  Speedup: ${(oldTime / newTime).toFixed(2)}x`);
  }
}

// ============ Run all benchmarks ============

console.log('\n');
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║           BUNQ ALGORITHM OPTIMIZATION BENCHMARKS           ║');
console.log('╚════════════════════════════════════════════════════════════╝');

benchSkipListVsArray();
benchLRUMap();
benchTTLMap();
benchMinHeap();
benchDelayedRefresh();

console.log('\n' + '='.repeat(60));
console.log('  Benchmark complete!');
console.log('='.repeat(60) + '\n');
