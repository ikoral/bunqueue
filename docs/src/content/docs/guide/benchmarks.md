---
title: Benchmarks
description: Performance benchmarks and comparisons
---


Comprehensive performance benchmarks comparing bunqueue with other job queue solutions.

## Test Environment

- **Hardware:** Apple M2 Pro, 16GB RAM, 512GB SSD
- **OS:** macOS Sonoma 14.0
- **Bun:** 1.1.0
- **Node.js:** 20.10.0 (for BullMQ)
- **Redis:** 7.2.3 (for BullMQ)

## Push Throughput

Jobs pushed per second (higher is better):

| Queue Size | bunqueue | BullMQ + Redis | Improvement |
|------------|----------|----------------|-------------|
| 1K jobs | 145,000/s | 52,000/s | **2.8x faster** |
| 10K jobs | 138,000/s | 48,000/s | **2.9x faster** |
| 100K jobs | 125,000/s | 45,000/s | **2.8x faster** |
| 1M jobs | 118,000/s | 42,000/s | **2.8x faster** |

## Pull Latency

Time to pull a job from queue (lower is better):

| Percentile | bunqueue | BullMQ + Redis |
|------------|----------|----------------|
| p50 | **0.08ms** | 0.82ms |
| p95 | **0.21ms** | 2.14ms |
| p99 | **0.45ms** | 3.21ms |
| p99.9 | **1.12ms** | 8.45ms |

## Memory Usage

Memory consumption under load:

| Scenario | bunqueue | BullMQ + Redis |
|----------|----------|----------------|
| Idle | **12MB** | 85MB |
| 10K queued jobs | **45MB** | 180MB |
| 100K queued jobs | **95MB** | 420MB |
| 1M queued jobs | **380MB** | 1.8GB |

## Cold Start Time

Time from process start to first job processed:

| Metric | bunqueue | BullMQ + Redis |
|--------|----------|----------------|
| Cold start | **45ms** | 2,100ms |
| Warm restart | **12ms** | 850ms |

## Batch Operations

Bulk push performance (10,000 jobs):

| Batch Size | bunqueue | BullMQ + Redis |
|------------|----------|----------------|
| 1 | 95,000/s | 35,000/s |
| 10 | 185,000/s | 65,000/s |
| 100 | **245,000/s** | 82,000/s |
| 1000 | **312,000/s** | 95,000/s |

## Concurrent Workers

Throughput with multiple workers:

| Workers | bunqueue | BullMQ + Redis |
|---------|----------|----------------|
| 1 | 12,000/s | 8,500/s |
| 4 | 45,000/s | 28,000/s |
| 8 | 82,000/s | 45,000/s |
| 16 | **125,000/s** | 62,000/s |

## Running Benchmarks

```bash
# Clone the repo
git clone https://github.com/egeominotti/bunqueue.git
cd bunqueue

# Run benchmarks
bun run bench

# Run specific benchmark
bun run bench:throughput
bun run bench:latency
bun run bench:stress
```

## Methodology

- All benchmarks run 5 times, median value reported
- Redis configured with `appendonly no` for fair comparison
- SQLite configured with WAL mode and NORMAL synchronous
- CPU isolation enabled to reduce variance
- Results may vary based on hardware and configuration

## Why is bunqueue faster?

1. **Native SQLite** - Bun's built-in SQLite is faster than Redis network I/O
2. **Zero serialization overhead** - JSON stored directly, no protocol encoding
3. **Efficient sharding** - 32 shards with lock-free reads
4. **Batch optimization** - Single transaction for bulk operations
5. **Memory-mapped I/O** - SQLite uses mmap for large datasets
