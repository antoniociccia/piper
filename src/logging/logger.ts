import { scrubText } from '../security/scrub.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(bindings: LogContext): Logger;
}

export interface CreateLoggerOptions {
  level?: Level;
  destination?: (line: string) => void;
  bindings?: LogContext;
  scrubUserPatterns?: readonly RegExp[];
}

const LEVEL_PRIORITY: Readonly<Record<Level, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function defaultDestination(line: string): void {
  process.stderr.write(line);
}

function scrubContext(
  ctx: LogContext,
  userPatterns: readonly RegExp[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = typeof value === 'string' ? scrubText(value, userPatterns) : value;
  }
  return out;
}

function serializeEvent(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

class LoggerImpl implements Logger {
  private readonly levelPriority: number;
  private readonly destination: (line: string) => void;
  private readonly bindings: LogContext;
  private readonly userPatterns: readonly RegExp[];

  constructor(opts: Required<Omit<CreateLoggerOptions, 'bindings' | 'scrubUserPatterns'>> & {
    bindings: LogContext;
    scrubUserPatterns: readonly RegExp[];
  }) {
    this.levelPriority = LEVEL_PRIORITY[opts.level];
    this.destination = opts.destination;
    this.bindings = opts.bindings;
    this.userPatterns = opts.scrubUserPatterns;
  }

  private emit(level: Level, msg: string, ctx?: LogContext): void {
    if (LEVEL_PRIORITY[level] < this.levelPriority) return;

    const scrubbedBindings = scrubContext(this.bindings, this.userPatterns);
    const scrubbedCtx = ctx === undefined ? {} : scrubContext(ctx, this.userPatterns);

    const event: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: scrubText(msg, this.userPatterns),
      ...scrubbedBindings,
      ...scrubbedCtx,
    };

    this.destination(serializeEvent(event));
  }

  debug(msg: string, ctx?: LogContext): void {
    this.emit('debug', msg, ctx);
  }

  info(msg: string, ctx?: LogContext): void {
    this.emit('info', msg, ctx);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.emit('warn', msg, ctx);
  }

  error(msg: string, ctx?: LogContext): void {
    this.emit('error', msg, ctx);
  }

  child(bindings: LogContext): Logger {
    const merged: LogContext = { ...this.bindings, ...bindings };
    return new LoggerImpl({
      level: this.priorityToLevel(this.levelPriority),
      destination: this.destination,
      bindings: merged,
      scrubUserPatterns: this.userPatterns,
    });
  }

  private priorityToLevel(priority: number): Level {
    for (const [name, p] of Object.entries(LEVEL_PRIORITY)) {
      if (p === priority) return name as Level;
    }
    return 'info';
  }
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return new LoggerImpl({
    level: options.level ?? 'info',
    destination: options.destination ?? defaultDestination,
    bindings: options.bindings ?? {},
    scrubUserPatterns: options.scrubUserPatterns ?? [],
  });
}

export const logger: Logger = createLogger();
