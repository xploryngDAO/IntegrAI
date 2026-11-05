import pino from 'pino';
import type { Logger as PinoLogger, LoggerOptions } from 'pino';
import type { ILogger } from '@sac/shared';

/** Structured logger settings derived from `AppConfig`. */
export interface LoggerSettings {
  nodeEnv: 'development' | 'test' | 'production';
  level: string;
  /** Service name attached to every line (`base.service`). */
  name?: string;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-amz-security-token"]',
  'password',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.clientSecret',
  '*.partnerKey',
  '*.secretAccessKey',
];

function buildLoggerOptions(settings: LoggerSettings): LoggerOptions {
  const pretty = settings.nodeEnv !== 'production' && settings.level !== 'silent';

  const options: LoggerOptions = {
    level: settings.level,
    base: { service: settings.name ?? 'sac-hub' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: true,
        ignore: 'pid,hostname,service',
      },
    };
  }

  return options;
}

/** Creates the underlying pino instance (exported for tests / pino-specific needs). */
export function createPinoLogger(settings: LoggerSettings): PinoLogger {
  return pino(buildLoggerOptions(settings));
}

/**
 * `ILogger` adapter over pino.
 *
 * The port only exposes the level helpers + `child`, keeping pino's richer
 * surface out of application code and out of `@sac/shared`.
 */
export class PinoLoggerAdapter implements ILogger {
  constructor(private readonly logger: PinoLogger) {}

  child(bindings: Record<string, unknown>): ILogger {
    return new PinoLoggerAdapter(this.logger.child(bindings));
  }

  trace(message: string, meta?: Record<string, unknown>): void {
    this.logger.trace(meta ?? {}, message);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(meta ?? {}, message);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(meta ?? {}, message);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(meta ?? {}, message);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logger.error(meta ?? {}, message);
  }
}

/** Convenience factory used by `createInfrastructure`. */
export function createLogger(settings: LoggerSettings): ILogger {
  return new PinoLoggerAdapter(createPinoLogger(settings));
}
