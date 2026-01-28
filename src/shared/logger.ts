/**
 * Structured Logger
 * JSON-formatted logging for production environments
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  reqId?: string;
  data?: Record<string, unknown>;
}

/** Logger class for structured logging */
export class Logger {
  private static jsonMode = false;

  constructor(private readonly component: string) {}

  /** Enable JSON output mode */
  static enableJsonMode(): void {
    Logger.jsonMode = true;
  }

  /** Disable JSON output mode (use human-readable) */
  static disableJsonMode(): void {
    Logger.jsonMode = false;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (Logger.jsonMode) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        component: this.component,
        message,
        ...(data && { data }),
      };
      console.log(JSON.stringify(entry));
    } else {
      const prefix = `[${this.component}]`;
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      switch (level) {
        case 'debug':
          console.debug(`${prefix} ${message}${dataStr}`);
          break;
        case 'info':
          console.log(`${prefix} ${message}${dataStr}`);
          break;
        case 'warn':
          console.warn(`${prefix} ${message}${dataStr}`);
          break;
        case 'error':
          console.error(`${prefix} ${message}${dataStr}`);
          break;
      }
    }
  }
}

/** Create a logger for a component */
export function createLogger(component: string): Logger {
  return new Logger(component);
}

/** Global loggers */
export const serverLog = createLogger('Server');
export const tcpLog = createLogger('TCP');
export const httpLog = createLogger('HTTP');
export const wsLog = createLogger('WS');
export const cronLog = createLogger('Cron');
export const statsLog = createLogger('Stats');
export const storageLog = createLogger('Storage');
export const queueLog = createLogger('Queue');
export const webhookLog = createLogger('Webhook');
