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
  HTTP_REQUEST_TIMEOUT_MS,
  MAX_API_JSON_BYTES,
} from './constants';
import type { HttpRouteContext, HttpServerOptions } from './types';
import type { RealtimeHub } from './realtime-hub';
import { registerAuthGuard } from './middleware/auth';
import { AuthRateLimiter } from '../application/auth/rate-limit';
import { registerContentTypeGuard } from './middleware/content-type-guard';
import { registerErrorHandler } from './middleware/error-handler';
import { registerRequestContext } from './middleware/request-context';
import { registerApiRoutes, registerRootRoutes } from './routes';

/** Errors are sanitized unless explicitly running a dev/test build. */
function isProductionBuild(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Content-Security-Policy for API responses.
 *
 * The API only emits JSON (plus the Socket.IO handshake), so the policy is
 * maximally restrictive: nothing may be loaded, framed or executed from an API
 * response. This is defence-in-depth against a parser-confusion/content-type
 * bug turning a JSON body into an active document - the policy that actually
 * protects the SPA lives on the edge (Vercel `headers`, see
 * `docs/SECURITY.md`), because a CSP delivered by the API does not apply to
 * documents served by another origin.
 */
const API_CONTENT_SECURITY_POLICY = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'none'"],
    baseUri: ["'none'"],
    connectSrc: ["'none'"],
    fontSrc: ["'none'"],
    formAction: ["'none'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'none'"],
    imgSrc: ["'none'"],
    manifestSrc: ["'none'"],
    mediaSrc: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'none'"],
    styleSrc: ["'none'"],
    workerSrc: ["'none'"],
  },
} as const;

/**
 * `Permissions-Policy` denying browser capabilities the API never needs.
 *
 * Helmet does not emit this header, so it is set by the `onRequest` hook below.
 * The SPA (Vercel) should send the same policy; see `docs/SECURITY.md`.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

/**
 * Normalizes the `WEB_ORIGIN` allowlist.
 *
 * Entries are trimmed, trailing slashes removed (the browser `Origin` header
 * never has one) and wildcards dropped: `Access-Control-Allow-Credentials: true`
 * plus `*` is invalid, and silently reflecting every origin would turn the
 * credentialed API into a cross-site data leak. An empty result means no
 * browser origin is allowed (fail closed), never "allow all".
 */
export function resolveAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\/+$/, ''))
    .filter((entry) => entry !== '*');
}

/**
 * Content-type parsers.
 *
 * JSON is re-parsed from the raw Buffer (instead of Fastify's default string
 * parser) so the exact bytes survive for webhook HMAC verification. Structured
 * syntax suffixes (`application/*+json`, RFC 6839) reuse the same parser so they
 * do not fall through to the buffer catch-all. Text, MIME and the catch-all are
 * buffered verbatim: the Amazon SES relay posts raw `.eml` payloads that must
 * never be decoded before the adapter signature check.
 */
const JSON_STRUCTURED_SUFFIX = /^application\/[a-z0-9!#$&^_.+-]+\+json(?:;.*)?$/i;

function registerBodyParsers(app: FastifyInstance, bodyLimitBytes: number): void {
  app.removeContentTypeParser(['application/json', 'text/plain']);

  const jsonParser = (
    request: FastifyRequest,
    body: Buffer,
    done: (error: Error | null, result?: unknown) => void,
  ): void => {
    request.rawBody = body;
    if (body.length === 0) {
      done(null, null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      done(null, parsed);
    } catch {
      done(
        new AppError('VALIDATION_ERROR', 'Malformed JSON request body', 400, {
          contentType: 'application/json',
        }),
        undefined,
      );
    }
  };

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: bodyLimitBytes },
    jsonParser,
  );
  app.addContentTypeParser(
    JSON_STRUCTURED_SUFFIX,
    { parseAs: 'buffer', bodyLimit: bodyLimitBytes },
    jsonParser,
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
  const production = isProductionBuild();

  const app = Fastify({
    logger: false,
    // Client IP resolution. Default `false`: `X-Forwarded-For` is ignored and
    // `request.ip` is the socket address, which is the only safe default when
    // the API can be reached directly. Behind an edge (Render/Vercel/Cloudflare)
    // set `TRUST_PROXY` to the edge IPs/CIDRs (recommended) or `true` only when
    // the API is unreachable except through that edge and it overwrites XFF -
    // otherwise the per-IP rate limits are trivially spoofed. See
    // `docs/SECURITY.md` §6.8.
    trustProxy: options.trustProxy ?? false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    // Backstop against slowloris/body-drip: 60 s is above the 30 s diagnostics
    // budget and the webhook budgets, below Node's 300 s default.
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    genReqId: () => randomUUID(),
  });

  const requestedOrigins = options.webOrigin
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const allowedOrigins = resolveAllowedOrigins(options.webOrigin);
  if (allowedOrigins.length !== requestedOrigins.length) {
    options.logger.warn('http.cors.wildcard_ignored', {
      configured: requestedOrigins.length,
      allowed: allowedOrigins.length,
    });
  }

  await app.register(cors, {
    // `WEB_ORIGIN` accepts a comma-separated list so the same API can serve the
    // operators app, the hosted SPA and local development at once. Never `*`:
    // credentials are enabled and the API carries per-operator data.
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-sac-duration-ms'],
    maxAge: 600,
    strictPreflight: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: API_CONTENT_SECURITY_POLICY,
    // The API never serves a document: COEP stays off, while COOP/CORP are set
    // to the strictest value that still lets the SPA `fetch()` JSON with CORS.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Framing is denied twice (X-Frame-Options + CSP frame-ancestors).
    frameguard: { action: 'deny' },
    noSniff: true,
    dnsPrefetchControl: { allow: false },
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    originAgentCluster: true,
    xssFilter: true,
    // HSTS only in production: sending it from localhost/dev can poison the
    // developer's browser for other projects. 180 days, subdomains included;
    // `preload` stays off until the domain owner opts in explicitly.
    hsts: production ? { maxAge: 15_552_000, includeSubDomains: true, preload: false } : false,
  });

  // Helmet has no Permissions-Policy helper. Registering the hook before the
  // routes makes it run for every response, including 401/404/429/500.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('permissions-policy', PERMISSIONS_POLICY);
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
    exposeDetails: !production,
  });
  // Reject non-JSON mutations under `/api/v1` before the body is buffered.
  // Registered ahead of the Redis-backed limiter: a malformed content type is
  // cheaper to refuse than to count, and it never reaches a route.
  registerContentTypeGuard(app);
  // Global per-IP shield in front of every route (including public ones except
  // liveness probes). Tiered auth limits still apply on top of this.
  const globalLimiter = new AuthRateLimiter({
    cache: services.cache,
    clock: services.clock,
    logger: options.logger,
  });
  app.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0] ?? '';
    if (path === '/health' || path === '/status' || path.startsWith('/socket.io')) return;
    await globalLimiter.assertAllowed(
      { bucket: 'http.global', limit: 600, windowSeconds: 60 },
      `sac:http:global:${request.ip}`,
    );
  });
  registerAuthGuard(app, {
    agents: services.agents,
    tickets: services.tickets,
    logger: options.logger,
  });

  // Authenticated JSON must never be served from a shared/browser cache: the
  // same URL can return different data per operator and per store state.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith(API_PREFIX) || request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store, no-cache, must-revalidate');
      reply.header('pragma', 'no-cache');
    }
    return payload;
  });

  // Fastify resolves `bodyLimit` per ROUTE (a plugin-level option is not
  // inherited by the nested route plugins), so the 1 MiB cap for the
  // authenticated JSON surface is stamped here instead of editing every route
  // module. Root-mounted `/webhooks/*` keep the 12 MiB SES/MIME allowance and
  // multipart uploads keep their own `fileSize` limit.
  app.addHook('onRoute', (routeOptions) => {
    if (
      routeOptions.url === API_PREFIX ||
      routeOptions.url.startsWith(`${API_PREFIX}/`)
    ) {
      routeOptions.bodyLimit = Math.min(
        routeOptions.bodyLimit ?? MAX_API_JSON_BYTES,
        MAX_API_JSON_BYTES,
      );
    }
  });

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
