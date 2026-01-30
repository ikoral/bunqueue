/**
 * Line Buffer
 * Efficient parsing of newline-delimited JSON protocol
 */

import type { LineBuffer as ILineBuffer } from './types';

/**
 * Line buffer for efficient parsing of streaming data
 * Handles partial messages across TCP packet boundaries
 */
export class LineBuffer implements ILineBuffer {
  private partial = '';

  /** Add data and return complete lines */
  addData(data: string): string[] {
    const combined = this.partial + data;
    const lines: string[] = [];
    let start = 0;
    let idx: number;

    while ((idx = combined.indexOf('\n', start)) !== -1) {
      const line = combined.slice(start, idx);
      if (line.length > 0) {
        lines.push(line);
      }
      start = idx + 1;
    }

    this.partial = start < combined.length ? combined.slice(start) : '';
    return lines;
  }

  /** Clear buffer */
  clear(): void {
    this.partial = '';
  }
}
