/**
 * Cron Command Builders
 * Cron job scheduling operations
 */

import { parseArgs } from 'node:util';
import { CommandError, requireArg, parseJsonArg, parseNumberArg } from './types';

/** Build a cron subcommand */
export function buildCronCommand(args: string[]): Record<string, unknown> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      return { cmd: 'CronList' };
    case 'add':
      return buildCronAdd(subArgs);
    case 'delete':
      return buildCronDelete(subArgs);
    default:
      throw new CommandError(`Unknown cron subcommand: ${subcommand}. Use: list, add, delete`);
  }
}

function buildCronAdd(args: string[]): Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      queue: { type: 'string', short: 'q' },
      data: { type: 'string', short: 'd' },
      schedule: { type: 'string', short: 's' },
      every: { type: 'string', short: 'e' },
      priority: { type: 'string', short: 'P' },
      'max-limit': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = requireArg(positionals, 0, 'name');

  if (!values.queue) {
    throw new CommandError('--queue (-q) is required');
  }

  if (!values.data) {
    throw new CommandError('--data (-d) is required (JSON string)');
  }

  if (!values.schedule && !values.every) {
    throw new CommandError('Either --schedule (-s) or --every (-e) is required');
  }

  const cmd: Record<string, unknown> = {
    cmd: 'Cron',
    name,
    queue: values.queue,
    data: parseJsonArg(values.data as string, 'data'),
  };

  if (values.schedule) cmd.schedule = values.schedule;

  const every = parseNumberArg(values.every as string | undefined, 'every');
  if (every !== undefined) cmd.repeatEvery = every;

  const priority = parseNumberArg(values.priority as string | undefined, 'priority');
  if (priority !== undefined) cmd.priority = priority;

  const maxLimit = parseNumberArg(values['max-limit'] as string | undefined, 'max-limit');
  if (maxLimit !== undefined) cmd.maxLimit = maxLimit;

  return cmd;
}

function buildCronDelete(args: string[]): Record<string, unknown> {
  const name = requireArg(args, 0, 'name');
  return { cmd: 'CronDelete', name };
}
