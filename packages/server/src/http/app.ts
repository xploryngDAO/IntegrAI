import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { AppError, type IAppServices } from '@sac/shared';
import {
  API_PREFIX,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
} from './constants';
import type { HttpRouteContext, HttpServerOptions } from './types';
import type { RealtimeHub } from './realtime-hub';
import { registerAuthGuard } from './middleware/auth';
import { registerErrorHandler } from './middleware/error-handler';
import { registerRequestContext } from './middleware/request-context';
import { registerApiRoutes, registerRootRoutes } from './routes';

/** Errors are sanitized unless explicitly running a dev/test build. */
function isProductionBuild(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Content-type parsers.
 *
 * JSON is re-parsed from the raw Buffer (instead of Fastify's default string
 * parser) so the exact bytes survive for webhook HMAC verification. Text, MIME
 * and the catch-all are buffered verbatim: the Amazon SES relay posts raw
 * `.eml` payloads that must never be decoded before the adapter signature check.
 */
function registerBodyParsers(app: FastifyInstance, bodyLimitBytes: number): void {
  app.removeContentTypeParser(['application/json', 'text/plain']);

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: bodyLimitBytes },
    (request, body, done) => {
      // `parseAs: 'buffer'` guarantees bytes at runtime; the union in Fastify's
      // typings is a conditional-type inference artifact.
      const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        done(null, parsed);
      } catch {
        done(
          new AppError('VALIDATION_ERROR', 'Malformed JSON request body', 400, {
            contentType: 'application/json',
          }),
          undefined,
        );
      }
    },
  );

  const bufferParser = (
    request: FastifyRequest,
    body: Buffer,
    done: (error: Error | null, result?: unknown) => void,
  ): void => {
    request.rawBody = body;
    done(null, body);
  };

  app.addContentTypeParser('text/plain', { parseAs: 'buffer', bodyLimit: bodyLimitBytes }, bufferParser);
  app.addContentTypeParser(
    'message/rfc822',
    { parseAs: 'buffer', bodyLimit: bodyLimitBytes },
    bufferParser,
  );
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: bodyLimitBytes }, bufferParser);
}

/**
 * Builds the HTTP application (REST + webhook ingress) and attaches the
 * Socket.IO hub to `fastify.server`.
 *
 * This factory never calls `listen` - the composition root owns the lifecycle -
 * and it is the only place where plugins, parsers, hooks and routers are wired.
 */
export async function buildHttpApp(
  services: IAppServices,
  hub: RealtimeHub,
  options: HttpServerOptions,
): Promise<FastifyInstance> {
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
  });

  await app.register(cors, {
    origin: options.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-sac-duration-ms'],
    maxAge: 600,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(multipart, {
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 10,
      parts: 12,
    },
    throwFileSizeLimit: true,
  });

  registerBodyParsers(app, DEFAULT_BODY_LIMIT_BYTES);

  registerRequestContext(app, { logger: options.logger });
  registerErrorHandler(app, {
    logger: options.logger,
    exposeDetails: !isProductionBuild(),
  });
  registerAuthGuard(app, { agents: services.agents, logger: options.logger });

  const ctx: HttpRouteContext = { services, hub, options };
  await registerRootRoutes(app, ctx);
  await app.register(
    async (api) => {
      await registerApiRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  // Socket.IO shares the Fastify HTTP server; attaching before `listen` lets
  // engine.io wrap the request listener without racing the first connection.
  hub.attach(app.server);

  app.addHook('onClose', async () => {
    await hub.close();
  });

  return app;
}
