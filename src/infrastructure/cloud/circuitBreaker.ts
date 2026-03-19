/**
 * Circuit Breaker
 * Prevents hammering a dead endpoint. States: CLOSED → OPEN → HALF_OPEN → CLOSED
 */

type State = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private state: State = 'closed';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number
  ) {}

  /** Check if a request is allowed */
  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      // Check if enough time passed to try again
      if (Date.now() - this.openedAt >= this.resetMs) {
        this.state = 'half_open';
        return true;
      }
      return false;
    }

    // half_open: allow one request through
    return true;
  }

  /** Record a successful call */
  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  /** Record a failed call */
  onFailure(): void {
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  getState(): string {
    return this.state;
  }
}
