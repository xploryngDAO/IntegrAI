import type { InvitationSummary } from '@sac/shared';

import type { HttpRouteContext, RouteHandler } from '../types';
import { createInvitationBodySchema, invitationParamsSchema } from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { requireAgent, requireTenantId } from '../middleware/auth';

/** JSON projection of `GET /invitations` (dates as ISO strings). */
function toInvitationView(invitation: InvitationSummary): {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string;
} {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

export interface InvitationControllers {
  create: RouteHandler;
  list: RouteHandler;
  revoke: RouteHandler;
}

export function createInvitationControllers(ctx: HttpRouteContext): InvitationControllers {
  const { services } = ctx;

  return {
    /**
     * `POST /invitations` - ADMIN only.
     *
     * 201 with the invitation envelope. A resend for the same e-mail refreshes
     * the pending row (new token + new TTL) instead of creating a duplicate.
     */
    async create(request, reply) {
      const actor = requireAgent(request);
      const tenantId = requireTenantId(request);
      const body = parseInput(createInvitationBodySchema, request.body, 'body');

      const result = await services.invitations.create({
        email: body.email,
        role: body.role,
        actor: { id: actor.id, name: actor.name, tenantId },
      });

      reply.code(201);
      return ok({
        invitationId: result.invitationId,
        email: result.email,
        role: result.role,
        expiresAt: result.expiresAt.toISOString(),
      });
    },

    /** `GET /invitations` - ADMIN only: every invitation of the caller tenant. */
    async list(request) {
      const tenantId = requireTenantId(request);
      const invitations = await services.invitations.list(tenantId);
      return ok(invitations.map(toInvitationView));
    },

    /**
     * `DELETE /invitations/:id` - ADMIN only.
     *
     * Revokes a pending invitation by expiring it now. 204 on success, 404 when
     * the id is unknown or belongs to another tenant, 409 when already accepted.
     */
    async revoke(request, reply) {
      const tenantId = requireTenantId(request);
      const params = parseInput(invitationParamsSchema, request.params, 'params');

      await services.invitations.revoke(params.id, tenantId);

      reply.code(204);
      return undefined;
    },
  };
}
