/**
 * Worker Wrapper Script Generator
 * Creates the wrapper script that loads processor in worker process
 */

import { mkdir, unlink } from 'node:fs/promises';

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
export async function createWrapperScript(
  queueName: string,
  processorPath: string
): Promise<string> {
  const fullPath = processorPath.startsWith('/')
    ? processorPath
    : `${process.cwd()}/${processorPath}`;

  // Escape the path to prevent code injection via backticks or template expressions
  const escapedPath = escapeForTemplateLiteral(fullPath);

  const wrapperCode = `
// Sandboxed Worker Wrapper
const processor = (await import('${escapedPath}')).default;

// Signal ready to parent
self.postMessage({ type: 'ready' });

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

  const tempDir = `${Bun.env.TMPDIR ?? '/tmp'}/bunqueue-workers`;
  const tempDirFile = Bun.file(tempDir);
  if (!(await tempDirFile.exists())) {
    await mkdir(tempDir, { recursive: true });
  }

  const wrapperPath = `${tempDir}/worker-${queueName}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.ts`;
  await Bun.write(wrapperPath, wrapperCode);

  return wrapperPath;
}

/**
 * Cleanup wrapper script file
 */
export async function cleanupWrapperScript(wrapperPath: string | null): Promise<void> {
  if (!wrapperPath) return;

  try {
    const file = Bun.file(wrapperPath);
    if (await file.exists()) {
      await unlink(wrapperPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
