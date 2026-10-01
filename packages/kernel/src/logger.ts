export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON-lines logger — agent decisions must be machine-readable. */
export class ConsoleLogger implements Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta });
    // Single line per event, stderr keeps stdout clean for CLI output.
    process.stderr.write(line + '\n');
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }
}

export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
