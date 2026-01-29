/**
 * Queue Command Builders
 * Queue control subcommands
 */

import { parseArgs } from 'node:util';
import { CommandError, requireArg, parseNumberArg } from './types';

/** Valid job states */
const VALID_STATES = ['waiting', 'delayed', 'active', 'completed', 'failed'];

/** Build a queue subcommand */
export function buildQueueCommand(args: string[]): Record<string, unknown> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      return { cmd: 'ListQueues' };
    case 'pause':
      return buildPause(subArgs);
    case 'resume':
      return buildResume(subArgs);
    case 'drain':
      return buildDrain(subArgs);
    case 'obliterate':
      return buildObliterate(subArgs);
    case 'clean':
      return buildClean(subArgs);
    case 'count':
      return buildCount(subArgs);
    case 'jobs':
      return buildGetJobs(subArgs);
    case 'paused':
      return buildIsPaused(subArgs);
    default:
      throw new CommandError(
        `Unknown queue subcommand: ${subcommand}. Use: list, pause, resume, drain, obliterate, clean, count, jobs, paused`
      );
  }
}

function buildPause(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'Pause', queue };
}

function buildResume(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'Resume', queue };
}

function buildDrain(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'Drain', queue };
}

function buildObliterate(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'Obliterate', queue };
}

function buildClean(args: string[]): Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      grace: { type: 'string', short: 'g' },
      state: { type: 'string', short: 's' },
      limit: { type: 'string', short: 'l' },
    },
    allowPositionals: true,
    strict: false,
  });

  const queue = requireArg(positionals, 0, 'queue');
  const grace = parseNumberArg(values.grace as string | undefined, 'grace');

  if (grace === undefined) {
    throw new CommandError('--grace is required for clean command (time in milliseconds)');
  }

  const state = values.state as string | undefined;
  if (state && !VALID_STATES.includes(state)) {
    throw new CommandError(`Invalid state: ${state}. Must be one of: ${VALID_STATES.join(', ')}`);
  }

  const cmd: Record<string, unknown> = {
    cmd: 'Clean',
    queue,
    grace,
  };

  if (state) cmd.state = state;

  const limit = parseNumberArg(values.limit as string | undefined, 'limit');
  if (limit !== undefined) cmd.limit = limit;

  return cmd;
}

function buildCount(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'Count', queue };
}

function buildGetJobs(args: string[]): Record<string, unknown> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      state: { type: 'string', short: 's' },
      limit: { type: 'string', short: 'l' },
      offset: { type: 'string', short: 'o' },
    },
    allowPositionals: true,
    strict: false,
  });

  const queue = requireArg(positionals, 0, 'queue');

  const state = values.state as string | undefined;
  if (state && !VALID_STATES.includes(state)) {
    throw new CommandError(`Invalid state: ${state}. Must be one of: ${VALID_STATES.join(', ')}`);
  }

  const cmd: Record<string, unknown> = {
    cmd: 'GetJobs',
    queue,
  };

  if (state) cmd.state = state;

  const limit = parseNumberArg(values.limit as string | undefined, 'limit');
  if (limit !== undefined) cmd.limit = limit;

  const offset = parseNumberArg(values.offset as string | undefined, 'offset');
  if (offset !== undefined) cmd.offset = offset;

  return cmd;
}

function buildIsPaused(args: string[]): Record<string, unknown> {
  const queue = requireArg(args, 0, 'queue');
  return { cmd: 'IsPaused', queue };
}
