/**
 * Protocol Rate Limiter
 * Prevents abuse by limiting requests per client
 */

export interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
  cleanupIntervalMs?: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  windowMs: 60_000,
  maxRequests: 1000,
  cleanupIntervalMs: 60_000,
};

/** Rate limiter for protocol-level request limiting */
export class ProtocolRateLimiter {
  private readonly requests = new Map<string, number[]>();
  private readonly config: RateLimiterConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanup();
  }

  /** Check if a request from clientId is allowed */
  isAllowed(clientId: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(clientId) ?? [];

    // Remove timestamps outside the window
    const valid = timestamps.filter((t) => now - t < this.config.windowMs);

    if (valid.length >= this.config.maxRequests) {
      return false;
    }

    valid.push(now);
    this.requests.set(clientId, valid);
    return true;
  }

  /** Get remaining requests for a client */
  getRemaining(clientId: string): number {
    const now = Date.now();
    const timestamps = this.requests.get(clientId) ?? [];
    const valid = timestamps.filter((t) => now - t < this.config.windowMs);
    return Math.max(0, this.config.maxRequests - valid.length);
  }

  /** Remove a client from tracking */
  removeClient(clientId: string): void {
    this.requests.delete(clientId);
  }

  /** Start cleanup interval */
  private startCleanup(): void {
    if (this.config.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, this.config.cleanupIntervalMs);
    }
  }

  /** Clean up old entries */
  private cleanup(): void {
    const now = Date.now();
    for (const [clientId, timestamps] of this.requests) {
      const valid = timestamps.filter((t) => now - t < this.config.windowMs);
      if (valid.length === 0) {
        this.requests.delete(clientId);
      } else {
        this.requests.set(clientId, valid);
      }
    }
  }

  /** Stop the rate limiter */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/** Global rate limiter instance */
let globalRateLimiter: ProtocolRateLimiter | null = null;

/** Get or create global rate limiter */
export function getRateLimiter(config?: Partial<RateLimiterConfig>): ProtocolRateLimiter {
  globalRateLimiter ??= new ProtocolRateLimiter(config);
  return globalRateLimiter;
}
