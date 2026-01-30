/**
 * Skip List Implementation
 * Probabilistic data structure with O(log n) insert, delete, search
 * Ideal for sorted collections with frequent modifications
 */

/** Skip list node */
interface SkipNode<T> {
  value: T;
  forward: Array<SkipNode<T> | null>;
}

/** Sentinel node (head) */
function createHead<T>(maxLevel: number): SkipNode<T> {
  const forward: Array<SkipNode<T> | null> = [];
  for (let i = 0; i <= maxLevel; i++) {
    forward.push(null);
  }
  return {
    value: null as unknown as T,
    forward,
  };
}

/**
 * Skip List with O(log n) operations
 * - insert: O(log n)
 * - delete: O(log n)
 * - search: O(log n)
 * - range query: O(log n + k) where k = results
 */
export class SkipList<T> {
  private readonly maxLevel: number;
  private readonly probability: number;
  private readonly compare: (a: T, b: T) => number;
  private head: SkipNode<T>;
  private level: number = 0;
  private _size: number = 0;

  /**
   * Create a skip list
   * @param compare Comparator function (negative if a < b, positive if a > b, 0 if equal)
   * @param maxLevel Maximum level (default 16, supports ~65k elements efficiently)
   * @param probability Level promotion probability (default 0.5)
   */
  constructor(compare: (a: T, b: T) => number, maxLevel: number = 16, probability: number = 0.5) {
    this.compare = compare;
    this.maxLevel = maxLevel;
    this.probability = probability;
    this.head = createHead<T>(maxLevel);
  }

  /** Current number of elements */
  get size(): number {
    return this._size;
  }

  /** Check if empty */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /** Generate random level for new node */
  private randomLevel(): number {
    let lvl = 0;
    while (Math.random() < this.probability && lvl < this.maxLevel) {
      lvl++;
    }
    return lvl;
  }

  /**
   * Insert value - O(log n)
   */
  insert(value: T): void {
    const update: Array<SkipNode<T> | null> = [];
    for (let i = 0; i <= this.maxLevel; i++) {
      update.push(null);
    }
    let current = this.head;

    // Find insert position at each level
    for (let i = this.level; i >= 0; i--) {
      let fwd = current.forward[i];
      while (fwd !== null && this.compare(fwd.value, value) < 0) {
        current = fwd;
        fwd = current.forward[i];
      }
      update[i] = current;
    }

    // Generate level for new node
    const newLevel = this.randomLevel();

    // If new level is higher than current, update head
    if (newLevel > this.level) {
      for (let i = this.level + 1; i <= newLevel; i++) {
        update[i] = this.head;
      }
      this.level = newLevel;
    }

    // Create new node
    const newNodeForward: Array<SkipNode<T> | null> = [];
    for (let i = 0; i <= newLevel; i++) {
      newNodeForward.push(null);
    }
    const newNode: SkipNode<T> = {
      value,
      forward: newNodeForward,
    };

    // Insert at each level
    for (let i = 0; i <= newLevel; i++) {
      const updateNode = update[i];
      if (updateNode) {
        newNode.forward[i] = updateNode.forward[i];
        updateNode.forward[i] = newNode;
      }
    }

    this._size++;
  }

  /**
   * Delete value - O(log n)
   * @returns true if found and deleted
   */
  delete(value: T): boolean {
    const update: Array<SkipNode<T> | null> = [];
    for (let i = 0; i <= this.maxLevel; i++) {
      update.push(null);
    }
    let current = this.head;

    // Find node at each level
    for (let i = this.level; i >= 0; i--) {
      let fwd = current.forward[i];
      while (fwd !== null && this.compare(fwd.value, value) < 0) {
        current = fwd;
        fwd = current.forward[i];
      }
      update[i] = current;
    }

    // Check if found
    const target = current.forward[0];
    if (target === null || this.compare(target.value, value) !== 0) {
      return false;
    }

    // Remove from each level
    for (let i = 0; i <= this.level; i++) {
      const updateNode = update[i];
      if (updateNode?.forward[i] === target) {
        updateNode.forward[i] = target.forward[i];
      } else {
        break;
      }
    }

    // Reduce level if necessary
    while (this.level > 0 && this.head.forward[this.level] === null) {
      this.level--;
    }

    this._size--;
    return true;
  }

  /**
   * Delete by predicate - O(n) worst case, but typically O(log n + k)
   * Useful when you need to match by a subset of fields
   */
  deleteWhere(predicate: (value: T) => boolean): T | null {
    let current = this.head.forward[0];
    while (current !== null) {
      if (predicate(current.value)) {
        this.delete(current.value);
        return current.value;
      }
      current = current.forward[0];
    }
    return null;
  }

  /**
   * Find exact value - O(log n)
   */
  find(value: T): T | null {
    let current = this.head;

    for (let i = this.level; i >= 0; i--) {
      let fwd = current.forward[i];
      while (fwd !== null && this.compare(fwd.value, value) < 0) {
        current = fwd;
        fwd = current.forward[i];
      }
    }

    const target = current.forward[0];
    if (target !== null && this.compare(target.value, value) === 0) {
      return target.value;
    }
    return null;
  }

  /**
   * Check if value exists - O(log n)
   */
  has(value: T): boolean {
    return this.find(value) !== null;
  }

  /**
   * Get first (minimum) element - O(1)
   */
  first(): T | null {
    return this.head.forward[0]?.value ?? null;
  }

  /**
   * Remove and return first element - O(log n)
   */
  shift(): T | null {
    const first = this.head.forward[0];
    if (first === null) return null;
    this.delete(first.value);
    return first.value;
  }

  /**
   * Range query: get all values where comparator returns <= 0
   * O(log n + k) where k = number of results
   * @param maxValue Upper bound (inclusive)
   * @param limit Maximum number of results
   */
  rangeUntil(maxValue: T, limit?: number): T[] {
    const result: T[] = [];
    let current = this.head.forward[0];

    while (current !== null && this.compare(current.value, maxValue) <= 0) {
      result.push(current.value);
      if (limit !== undefined && result.length >= limit) break;
      current = current.forward[0];
    }

    return result;
  }

  /**
   * Get all values where predicate is true, starting from first
   * Stops at first false (assumes sorted order matches predicate)
   * O(k) where k = matching results
   */
  takeWhile(predicate: (value: T) => boolean, limit?: number): T[] {
    const result: T[] = [];
    let current = this.head.forward[0];

    while (current !== null && predicate(current.value)) {
      result.push(current.value);
      if (limit !== undefined && result.length >= limit) break;
      current = current.forward[0];
    }

    return result;
  }

  /**
   * Iterate all values in order
   */
  *values(): Generator<T> {
    let current = this.head.forward[0];
    while (current !== null) {
      yield current.value;
      current = current.forward[0];
    }
  }

  /**
   * Convert to array
   */
  toArray(): T[] {
    return Array.from(this.values());
  }

  /**
   * Clear all elements
   */
  clear(): void {
    this.head = createHead<T>(this.maxLevel);
    this.level = 0;
    this._size = 0;
  }

  /**
   * Filter and remove elements matching predicate
   * Returns removed elements
   * O(n) but removes in-place
   */
  removeAll(predicate: (value: T) => boolean): T[] {
    const removed: T[] = [];
    let current = this.head.forward[0];

    while (current !== null) {
      const next = current.forward[0];
      if (predicate(current.value)) {
        removed.push(current.value);
        this.delete(current.value);
      }
      current = next;
    }

    return removed;
  }
}
