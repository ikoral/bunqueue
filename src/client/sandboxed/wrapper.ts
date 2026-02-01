/**
 * Worker Wrapper Script Generator
 * Creates the wrapper script that loads processor in worker process
 */

import { join } from 'path';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

/**
 * Escape a string for safe embedding in a template literal
 * Prevents code injection via backticks or backslashes in paths
 */
function escapeForTemplateLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

/**
 * Create wrapper script file that loads the processor
 */
export function createWrapperScript(queueName: string, processorPath: string): string {
  const fullPath = processorPath.startsWith('/')
    ? processorPath
    : join(process.cwd(), processorPath);

  // Escape the path to prevent code injection via backticks or template expressions
  const escapedPath = escapeForTemplateLiteral(fullPath);

  const wrapperCode = `
// Sandboxed Worker Wrapper
const processor = (await import('${escapedPath}')).default;

self.onmessage = async (event) => {
  const { type, job } = event.data;
  if (type !== 'job') return;

  try {
    const result = await processor({
      id: job.id,
      data: job.data,
      queue: job.queue,
      attempts: job.attempts,
      progress: (value) => {
        self.postMessage({ type: 'progress', jobId: job.id, progress: value });
      },
    });

    self.postMessage({ type: 'result', jobId: job.id, result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
`;

  const tempDir = join(tmpdir(), 'bunqueue-workers');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const wrapperPath = join(tempDir, `worker-${queueName}-${Date.now()}.ts`);
  writeFileSync(wrapperPath, wrapperCode);

  return wrapperPath;
}

/**
 * Cleanup wrapper script file
 */
export function cleanupWrapperScript(wrapperPath: string | null): void {
  if (wrapperPath && existsSync(wrapperPath)) {
    try {
      unlinkSync(wrapperPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
