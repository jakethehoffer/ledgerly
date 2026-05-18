/**
 * Minimal structured logger contract. Downstream consumers can wire this to
 * pino, winston, or a custom backend; ledgerly does not depend on any
 * specific logger library.
 *
 * Each method takes a message string and optional structured metadata. The
 * metadata is logger-implementation-defined — pino expects it before the
 * message, winston expects it after, etc. The default `consoleLogger`
 * formats it as a JSON object alongside the message.
 */
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/**
 * Options for {@link consoleLogger}.
 *
 * `level` filters output below the configured threshold. Default `'info'`
 * suppresses debug-level messages. Set `'debug'` for verbose output.
 */
export interface ConsoleLoggerOptions {
  readonly level?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Default console-backed logger. Maps levels to `console.log` / `.warn` /
 * `.error`, with `debug` going to `console.debug` (typically same as
 * `console.log` on Node).
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const priority = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const threshold = priority[level];

  function emit(
    method: (msg: string, ...meta: unknown[]) => void,
    msg: string,
    meta?: unknown,
  ): void {
    if (meta === undefined) {
      method(msg);
    } else {
      method(msg, meta);
    }
  }

  return {
    debug(msg, meta): void {
      if (priority.debug >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.debug.bind(console), msg, meta);
      }
    },
    info(msg, meta): void {
      if (priority.info >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.log.bind(console), msg, meta);
      }
    },
    warn(msg, meta): void {
      if (priority.warn >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.warn.bind(console), msg, meta);
      }
    },
    error(msg, meta): void {
      if (priority.error >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.error.bind(console), msg, meta);
      }
    },
  };
}

/** A logger that discards all output. Useful in tests. */
export function silentLogger(): Logger {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}

/**
 * Options for {@link jsonLogger}.
 *
 * `level` filters output below the configured threshold (same semantics as
 * {@link consoleLogger}). `out` / `err` are write streams the logger sends
 * info-/debug-level and warn-/error-level lines to; both default to
 * `process.stdout` / `process.stderr` and are overridable for tests.
 */
export interface JsonLoggerOptions {
  readonly level?: 'debug' | 'info' | 'warn' | 'error';
  readonly out?: NodeJS.WritableStream;
  readonly err?: NodeJS.WritableStream;
}

/**
 * Convert an Error instance into a plain object so `JSON.stringify` actually
 * serializes the fields. Error's `message` / `stack` / `name` are
 * non-enumerable so the default stringification gives `{}` — which is the
 * most common gotcha when wiring a JSON logger.
 */
function errorToObj(err: Error): Record<string, unknown> {
  return { name: err.name, message: err.message, stack: err.stack };
}

/**
 * One JSON object per line, written to stdout (debug/info) or stderr
 * (warn/error). Schema:
 *
 *   { "ts": "<ISO 8601>", "level": "<debug|info|warn|error>", "msg": "...",
 *     ...meta }
 *
 * Object-valued meta is merged into the root record (pino convention); the
 * standard fields `ts`, `level`, `msg` always win against meta keys with
 * the same name, so a careless `log.info('x', { level: 'oops' })` can't
 * shadow the real level in a downstream log query.
 *
 * Error instances inside meta are converted via {@link errorToObj} so their
 * stack and message survive the round-trip. Non-object meta (string,
 * number, ...) lands under a `meta` key so it isn't lost.
 *
 * Use when shipping ledgerly into a log aggregator (Datadog, CloudWatch,
 * Loki, Splunk, Vector, ...). For local development, prefer
 * {@link consoleLogger}, which is more readable in a terminal.
 */
export function jsonLogger(options: JsonLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const priority = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const threshold = priority[level];
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;

  function buildRecord(
    levelName: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta: unknown,
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    if (meta !== undefined) {
      if (meta instanceof Error) {
        record.err = errorToObj(meta);
      } else if (typeof meta === 'object' && meta !== null) {
        for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
          record[k] = v instanceof Error ? errorToObj(v) : v;
        }
      } else {
        // Non-object meta (number, string, boolean) — preserve it under
        // a `meta` key so a careless caller doesn't drop it on the floor.
        record.meta = meta;
      }
    }
    // Standard fields written LAST so they win against any meta keys with
    // the same name. JSON object property order isn't strict but most
    // engines preserve insertion order; this also yields a predictable
    // serialization for grep-friendly log lines.
    record.ts = new Date().toISOString();
    record.level = levelName;
    record.msg = msg;
    return record;
  }

  function write(
    dest: NodeJS.WritableStream,
    levelName: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta: unknown,
  ): void {
    dest.write(`${JSON.stringify(buildRecord(levelName, msg, meta))}\n`);
  }

  return {
    debug(msg, meta): void {
      if (priority.debug >= threshold) write(out, 'debug', msg, meta);
    },
    info(msg, meta): void {
      if (priority.info >= threshold) write(out, 'info', msg, meta);
    },
    warn(msg, meta): void {
      if (priority.warn >= threshold) write(err, 'warn', msg, meta);
    },
    error(msg, meta): void {
      if (priority.error >= threshold) write(err, 'error', msg, meta);
    },
  };
}
