import type { FastifyInstance } from 'fastify';
import type { HttpRouteContext } from '../types';
import { authRoutes } from './auth.routes';
import { invitationRoutes } from './invitations.routes';
import { agentRoutes } from './agents.routes';
import { ticketRoutes } from './tickets.routes';
import { accountRoutes } from './accounts.routes';
import { fileRoutes } from './files.routes';
import { diagnosticsRoutes } from './diagnostics.routes';
import { telemetryRoutes } from './telemetry.routes';
import { healthRoutes } from './health.routes';
import { webhookRoutes } from './webhooks.routes';

/**
 * Everything under `/api/v1` (contract §1-6) plus the API-prefixed health probe.
 * `buildHttpApp` applies the prefix, so modules only declare their sub-path.
 */
export async function registerApiRoutes(app: FastifyInstance, ctx: HttpRouteContext): Promise<void> {
  await app.register(authRoutes, { prefix: '/auth', ...ctx });
  await app.register(invitationRoutes, { prefix: '/invitations', ...ctx });
  await app.register(agentRoutes, { prefix: '/agents', ...ctx });
  await app.register(ticketRoutes, { prefix: '/tickets', ...ctx });
  await app.register(accountRoutes, { prefix: '/accounts', ...ctx });
  await app.register(fileRoutes, { prefix: '/files', ...ctx });
  await app.register(diagnosticsRoutes, ctx);
  await app.register(telemetryRoutes, ctx);
  await app.register(healthRoutes, ctx);
}

/**
 * Root-mounted, unauthenticated surfaces: marketplace webhooks and the bare
 * `/health` probe (contract §7 and §4).
 */
export async function registerRootRoutes(app: FastifyInstance, ctx: HttpRouteContext): Promise<void> {
  await app.register(webhookRoutes, { prefix: '/webhooks', ...ctx });
  await app.register(healthRoutes, ctx);
}
