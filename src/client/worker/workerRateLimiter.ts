/**
 * WorkerRateLimiter - Rate limiting for worker job processing
 * BullMQ v5 compatible sliding window rate limiter
 *
 * Uses a head-pointer approach instead of Array.filter() for O(1) amortized
 * token expiration. Tokens are always pushed in chronological order, so
 * expired tokens are always at the front — we just advance the head pointer.
 */

import type { RateLimiterOptions } from '../types';

export class WorkerRateLimiter {
  private limiterTokens: number[] = [];
  private head = 0;
  private rateLimitExpiration = 0;

  constructor(private readonly limiter: RateLimiterOptions | null) {}

  /**
   * Check if rate limiter allows processing another job.
   * Returns true if we can process, false if rate limited.
   * O(1) amortized — advances head pointer past expired tokens.
   */
  canProcessWithinLimit(): boolean {
    if (!this.limiter) return true;

    const windowStart = Date.now() - this.limiter.duration;
    this.evictExpired(windowStart);

    return this.activeCount() < this.limiter.max;
  }

  /** Record a job completion for rate limiting. */
  recordJobForLimiter(): void {
    if (!this.limiter) return;
    this.limiterTokens.push(Date.now());
  }

  /**
   * Get time until rate limiter allows next job (ms).
   * Returns 0 if not rate limited.
   * O(1) — oldest active token is at this.limiterTokens[this.head].
   */
  getTimeUntilNextSlot(): number {
    if (!this.limiter) return 0;

    const now = Date.now();
    const windowStart = now - this.limiter.duration;
    this.evictExpired(windowStart);

    if (this.activeCount() < this.limiter.max) {
      return 0;
    }

    // Oldest active token is at head — no need for Math.min(...spread)
    const oldestToken = this.limiterTokens[this.head];
    return oldestToken + this.limiter.duration - now;
  }

  /** Get rate limiter info (for debugging/monitoring). */
  getRateLimiterInfo(): { current: number; max: number; duration: number } | null {
    if (!this.limiter) return null;

    const windowStart = Date.now() - this.limiter.duration;
    this.evictExpired(windowStart);

    return {
      current: this.activeCount(),
      max: this.limiter.max,
      duration: this.limiter.duration,
    };
  }

  /**
   * Apply rate limiting (BullMQ v5 compatible).
   * The worker will not process jobs until the rate limit expires.
   */
  rateLimit(expireTimeMs: number): void {
    if (expireTimeMs <= 0) return;

    if (this.limiter) {
      const now = Date.now();
      for (let i = 0; i < this.limiter.max; i++) {
        this.limiterTokens.push(now + expireTimeMs - this.limiter.duration);
      }
    }

    this.rateLimitExpiration = Date.now() + expireTimeMs;
  }

  /** Check if worker is currently rate limited. */
  isRateLimited(): boolean {
    return Date.now() < this.rateLimitExpiration;
  }

  /** Number of active (non-expired) tokens. */
  private activeCount(): number {
    return this.limiterTokens.length - this.head;
  }

  /** Advance head pointer past expired tokens. Compact when head > half the array. */
  private evictExpired(windowStart: number): void {
    while (this.head < this.limiterTokens.length && this.limiterTokens[this.head] <= windowStart) {
      this.head++;
    }

    // Compact: reclaim memory when more than half the array is dead space
    if (this.head > 0 && this.head > this.limiterTokens.length / 2) {
      this.limiterTokens = this.limiterTokens.slice(this.head);
      this.head = 0;
    }
  }
}
