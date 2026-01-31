#!/usr/bin/env bun
/**
 * bunqueue CLI Entry Point
 * Routes to server or client mode based on arguments
 */

import { runServer } from './commands/server';
import { executeCommand } from './client';
import { printHelp, printVersion } from './help';
import { isBackupCommand, executeBackupCommand } from './commands/backup';
import { VERSION } from '../shared/version';

/** Global CLI options */
interface GlobalOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Parse global options from process.argv */
function parseGlobalOptions(): { options: GlobalOptions; commandArgs: string[] } {
  const allArgs = process.argv.slice(2);

  // Extract global options manually to preserve subcommand flags
  let host = 'localhost';
  let port = 6789;
  let token: string | undefined;
  let json = false;
  let help = false;
  let version = false;

  const commandArgs: string[] = [];
  let i = 0;

  while (i < allArgs.length) {
    const arg = allArgs[i];

    if (arg === '--host' || arg === '-H') {
      host = allArgs[++i] ?? 'localhost';
    } else if (arg === '--port' || arg === '-p') {
      port = parseInt(allArgs[++i] ?? '6789', 10);
    } else if (arg === '--token' || arg === '-t') {
      token = allArgs[++i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help') {
      help = true;
    } else if (arg === '--version') {
      version = true;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice(7);
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.slice(7), 10);
    } else if (arg.startsWith('--token=')) {
      token = arg.slice(8);
    } else {
      // Not a global option, pass to command
      commandArgs.push(arg);
    }
    i++;
  }

  return {
    options: { host, port, token, json, help, version },
    commandArgs,
  };
}

/** Main CLI entry */
export async function main(): Promise<void> {
  const { options, commandArgs } = parseGlobalOptions();

  // Handle --version
  if (options.version) {
    printVersion(VERSION);
    process.exit(0);
  }

  // Handle --help with no command
  if (options.help && commandArgs.length === 0) {
    printHelp();
    process.exit(0);
  }

  // Get the command (first positional argument)
  const command = commandArgs[0];

  // No command or 'start' = server mode
  if (!command || command === 'start') {
    const serverArgs = command === 'start' ? commandArgs.slice(1) : commandArgs;
    await runServer(serverArgs, options.help);
    return;
  }

  // Help for specific command
  if (options.help) {
    // Could add command-specific help here
    printHelp();
    process.exit(0);
  }

  // Backup command - executed locally, not via TCP
  if (isBackupCommand(command)) {
    try {
      const result = await executeBackupCommand(commandArgs.slice(1));
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
        if (result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        }
      }
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      if (err instanceof Error) {
        console.error(`Error: ${err.message}`);
      } else {
        console.error('Unknown error occurred');
      }
      process.exit(1);
    }
    return;
  }

  // Client mode - execute command against server
  try {
    await executeCommand(command, commandArgs.slice(1), {
      host: options.host,
      port: options.port,
      token: options.token,
      json: options.json,
    });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error('Unknown error occurred');
    }
    process.exit(1);
  }
}

// Run if this is the main module
main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
