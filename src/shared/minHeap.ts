/**
 * Generic Min-Heap implementation
 * O(log n) push/pop, O(1) peek
 */

export class MinHeap<T> {
  private heap: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  /**
   * Create a min-heap with custom comparator
   * @param compare Returns negative if a < b, positive if a > b, 0 if equal
   */
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  /** Get current size */
  get size(): number {
    return this.heap.length;
  }

  /** Check if empty */
  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** Push item - O(log n) */
  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  /** Pop minimum item - O(log n) */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    const last = this.heap.pop();
    if (last !== undefined) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return min;
  }

  /** Peek at minimum without removing - O(1) */
  peek(): T | undefined {
    return this.heap[0];
  }

  /** Clear the heap */
  clear(): void {
    this.heap = [];
  }

  /** Get all items (for iteration) */
  toArray(): T[] {
    return [...this.heap];
  }

  /** Rebuild heap from array - O(n) */
  buildFrom(items: T[]): void {
    this.heap = [...items];
    // Heapify from bottom up
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.bubbleDown(i);
    }
  }

  /** Remove item by predicate - O(n) */
  removeWhere(predicate: (item: T) => boolean): T | undefined {
    const idx = this.heap.findIndex(predicate);
    if (idx === -1) return undefined;

    const item = this.heap[idx];
    if (idx === this.heap.length - 1) {
      this.heap.pop();
    } else {
      const last = this.heap.pop();
      if (last !== undefined) {
        this.heap[idx] = last;
        // Try both directions since we don't know the relative order
        this.bubbleUp(idx);
        this.bubbleDown(idx);
      }
    }
    return item;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.compare(this.heap[idx], this.heap[parentIdx]) >= 0) break;
      this.swap(idx, parentIdx);
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number): void {
    const length = this.heap.length;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let smallest = idx;

      if (leftIdx < length && this.compare(this.heap[leftIdx], this.heap[smallest]) < 0) {
        smallest = leftIdx;
      }
      if (rightIdx < length && this.compare(this.heap[rightIdx], this.heap[smallest]) < 0) {
        smallest = rightIdx;
      }

      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}
