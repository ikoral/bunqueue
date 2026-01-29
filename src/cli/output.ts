/**
 * CLI Output Formatting
 * Formats command responses for terminal display
 */

/** ANSI color codes */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

/** Check if colors are supported */
const supportsColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';

/** Apply color if supported */
function color(text: string, colorCode: string): string {
  return supportsColor ? `${colorCode}${text}${colors.reset}` : text;
}

/** Format a job object for display */
function formatJob(job: Record<string, unknown>): string {
  const lines = [
    `${color('Job:', colors.bold)} ${String(job.id)}`,
    `  Queue:      ${String(job.queue)}`,
    `  State:      ${String(job.state ?? 'unknown')}`,
    `  Priority:   ${String(job.priority)}`,
    `  Attempts:   ${String(job.attempts)}/${String(job.maxAttempts)}`,
    `  Data:       ${JSON.stringify(job.data)}`,
  ];

  if (job.progress !== undefined && job.progress !== 0) {
    lines.push(`  Progress:   ${String(job.progress)}%`);
  }
  if (job.createdAt) {
    lines.push(`  Created:    ${new Date(job.createdAt as number).toISOString()}`);
  }
  if (job.startedAt) {
    lines.push(`  Started:    ${new Date(job.startedAt as number).toISOString()}`);
  }
  if (job.error) {
    lines.push(`  Error:      ${color(String(job.error), colors.red)}`);
  }

  return lines.join('\n');
}

/** Format jobs as a table */
function formatJobsTable(jobs: Record<string, unknown>[]): string {
  if (jobs.length === 0) {
    return color('No jobs found', colors.yellow);
  }

  const header = [
    color('ID', colors.bold).padEnd(20 + (supportsColor ? 9 : 0)),
    color('Queue', colors.bold).padEnd(15 + (supportsColor ? 9 : 0)),
    color('State', colors.bold).padEnd(12 + (supportsColor ? 9 : 0)),
    color('Priority', colors.bold).padEnd(10 + (supportsColor ? 9 : 0)),
    color('Attempts', colors.bold),
  ].join(' ');

  const rows = jobs.map((job) =>
    [
      String(job.id).padEnd(20),
      String(job.queue).padEnd(15),
      String(job.state ?? '-').padEnd(12),
      String(job.priority).padEnd(10),
      `${String(job.attempts)}/${String(job.maxAttempts)}`,
    ].join(' ')
  );

  return [header, '-'.repeat(75), ...rows].join('\n');
}

/** Format stats object */
function formatStats(stats: Record<string, unknown>): string {
  const lines = [
    color('Server Statistics:', colors.bold),
    '',
    `  ${color('Waiting:', colors.cyan)}     ${stats.waiting ?? 0}`,
    `  ${color('Active:', colors.green)}      ${stats.active ?? 0}`,
    `  ${color('Delayed:', colors.yellow)}     ${stats.delayed ?? 0}`,
    `  ${color('Completed:', colors.dim)}   ${stats.completed ?? 0}`,
    `  ${color('Failed:', colors.red)}      ${stats.failed ?? 0}`,
    `  ${color('DLQ:', colors.red)}         ${stats.dlq ?? 0}`,
  ];

  if (stats.totalPushed !== undefined) {
    lines.push('', `  Total Pushed:    ${stats.totalPushed}`);
    lines.push(`  Total Pulled:    ${stats.totalPulled}`);
    lines.push(`  Total Completed: ${stats.totalCompleted}`);
    lines.push(`  Total Failed:    ${stats.totalFailed}`);
  }

  return lines.join('\n');
}

/** Format counts object */
function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n');
}

/** Format queues list */
function formatQueues(queues: string[]): string {
  if (queues.length === 0) {
    return color('No queues found', colors.yellow);
  }
  return queues.map((q) => `  - ${q}`).join('\n');
}

/** Format cron jobs */
function formatCronJobs(jobs: Record<string, unknown>[]): string {
  if (jobs.length === 0) {
    return color('No cron jobs found', colors.yellow);
  }

  const lines = jobs.map((job) => {
    const schedule = job.schedule ?? `every ${String(job.repeatEvery)}ms`;
    return `  ${color(String(job.name), colors.bold)}\n    Queue: ${String(job.queue)}\n    Schedule: ${String(schedule)}\n    Executions: ${String(job.executions)}`;
  });

  return lines.join('\n\n');
}

/** Format workers list */
function formatWorkers(workers: Record<string, unknown>[]): string {
  if (workers.length === 0) {
    return color('No workers registered', colors.yellow);
  }

  return workers
    .map(
      (w) =>
        `  ${color(String(w.id), colors.bold)}: ${String(w.name)} (${(w.queues as string[]).join(', ')})`
    )
    .join('\n');
}

/** Format webhooks list */
function formatWebhooks(webhooks: Record<string, unknown>[]): string {
  if (webhooks.length === 0) {
    return color('No webhooks registered', colors.yellow);
  }

  return webhooks
    .map(
      (w) =>
        `  ${color(String(w.id), colors.bold)}: ${String(w.url)}\n    Events: ${(w.events as string[]).join(', ')}`
    )
    .join('\n\n');
}

/** Format DLQ jobs */
function formatDlqJobs(jobs: Record<string, unknown>[]): string {
  if (jobs.length === 0) {
    return color('DLQ is empty', colors.green);
  }

  return jobs
    .map(
      (job) =>
        `  ${color(String(job.jobId), colors.bold)}\n    Queue: ${String(job.queue)}\n    Error: ${color(String(job.error ?? 'Unknown'), colors.red)}\n    Failed: ${new Date(job.failedAt as number).toISOString()}`
    )
    .join('\n\n');
}

/** Format logs */
function formatLogs(logs: Record<string, unknown>[]): string {
  if (logs.length === 0) {
    return color('No logs found', colors.yellow);
  }

  return logs
    .map((log) => {
      const levelColor =
        log.level === 'error' ? colors.red : log.level === 'warn' ? colors.yellow : colors.dim;
      return `  [${new Date(log.timestamp as number).toISOString()}] ${color(String(log.level).toUpperCase(), levelColor)}: ${String(log.message)}`;
    })
    .join('\n');
}

/** Format a successful response based on its content */
function formatSuccess(response: Record<string, unknown>, command: string): string {
  // Job created
  if ('id' in response && typeof response.id === 'string' && command === 'push') {
    return color(`Job created: ${response.id}`, colors.green);
  }

  // Batch jobs created
  if ('ids' in response && Array.isArray(response.ids)) {
    return color(`Created ${response.ids.length} jobs: ${response.ids.join(', ')}`, colors.green);
  }

  // Single job
  if ('job' in response) {
    if (response.job === null) {
      return color('No job available', colors.yellow);
    }
    return formatJob(response.job as Record<string, unknown>);
  }

  // Jobs list
  if ('jobs' in response && Array.isArray(response.jobs)) {
    return formatJobsTable(response.jobs as Record<string, unknown>[]);
  }

  // Stats
  if ('stats' in response) {
    return formatStats(response.stats as Record<string, unknown>);
  }

  // Counts
  if ('counts' in response) {
    return formatCounts(response.counts as Record<string, number>);
  }

  // Queues
  if ('queues' in response && Array.isArray(response.queues)) {
    return formatQueues(response.queues as string[]);
  }

  // Cron jobs
  if ('cronJobs' in response && Array.isArray(response.cronJobs)) {
    return formatCronJobs(response.cronJobs as Record<string, unknown>[]);
  }

  // Workers
  if ('workers' in response && Array.isArray(response.workers)) {
    return formatWorkers(response.workers as Record<string, unknown>[]);
  }

  // Webhooks
  if ('webhooks' in response && Array.isArray(response.webhooks)) {
    return formatWebhooks(response.webhooks as Record<string, unknown>[]);
  }

  // DLQ jobs
  if ('dlqJobs' in response && Array.isArray(response.dlqJobs)) {
    return formatDlqJobs(response.dlqJobs as Record<string, unknown>[]);
  }

  // Logs
  if ('logs' in response && Array.isArray(response.logs)) {
    return formatLogs(response.logs as Record<string, unknown>[]);
  }

  // State
  if ('state' in response) {
    return `State: ${String(response.state)}`;
  }

  // Result
  if ('result' in response) {
    return `Result: ${JSON.stringify(response.result, null, 2)}`;
  }

  // Progress
  if ('progress' in response) {
    return `Progress: ${String(response.progress)}%${response.message ? ` - ${String(response.message)}` : ''}`;
  }

  // Paused status
  if ('paused' in response) {
    return response.paused
      ? color('Queue is paused', colors.yellow)
      : color('Queue is active', colors.green);
  }

  // Count
  if ('count' in response) {
    return `Count: ${String(response.count)}`;
  }

  // Metrics (Prometheus format)
  if ('metrics' in response && typeof response.metrics === 'string') {
    return response.metrics;
  }

  // Generic success
  return color('OK', colors.green);
}

/** Main output formatter */
export function formatOutput(
  response: Record<string, unknown>,
  command: string,
  asJson: boolean
): string {
  if (asJson) {
    return JSON.stringify(response, null, 2);
  }

  if (!response.ok) {
    return formatError(String(response.error ?? 'Unknown error'), false);
  }

  return formatSuccess(response, command);
}

/** Format error message */
export function formatError(message: string, asJson: boolean): string {
  if (asJson) {
    return JSON.stringify({ ok: false, error: message });
  }
  return color(`Error: ${message}`, colors.red);
}
