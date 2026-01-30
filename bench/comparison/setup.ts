/**
 * BullMQ vs bunqueue Benchmark Setup
 *
 * Prerequisites:
 * - Redis running on localhost:6379 (for BullMQ)
 * - bun install bullmq ioredis
 */

export interface BenchmarkResult {
  library: 'bunqueue' | 'bullmq';
  operation: string;
  opsPerSec: number;
  avgLatencyMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  memoryMB: number;
}

export interface ComparisonResults {
  timestamp: string;
  hardware: {
    cpu: string;
    memory: string;
    os: string;
    bunVersion: string;
    nodeVersion: string;
  };
  results: BenchmarkResult[];
}

export function getHardwareInfo(): ComparisonResults['hardware'] {
  const os = require('os');
  return {
    cpu: os.cpus()[0]?.model || 'Unknown',
    memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
    os: `${os.platform()} ${os.release()}`,
    bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'N/A',
    nodeVersion: process.version,
  };
}

export function calculatePercentiles(latencies: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  const len = sorted.length;
  return {
    p50: sorted[Math.floor(len * 0.5)] || 0,
    p95: sorted[Math.floor(len * 0.95)] || 0,
    p99: sorted[Math.floor(len * 0.99)] || 0,
  };
}

export function getMemoryUsageMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

export async function warmup(fn: () => Promise<void>, iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
}
