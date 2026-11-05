import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from './auth.schema';

/** Roles an ADMIN can grant through an invitation (2FA is out of scope here). */
export const invitationRoleSchema = z.enum(['AGENT', 'SUPERVISOR', 'ADMIN']);

/** `POST /invitations` - ADMIN only; a resend reuses the same (tenant, e-mail). */
export const createInvitationBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: invitationRoleSchema,
});

/** `DELETE /invitations/:id` - route param (UUID prevents Prisma type errors). */
export const invitationParamsSchema = z.object({
  id: z.string().uuid(),
});

/** `POST /auth/accept-invitation` - public: consumes the single-use token. */
export const acceptInvitationBodySchema = z.object({
  token: z.string().trim().min(32).max(256),
  name: z.string().trim().min(1).max(120),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(200),
  /** Optional device label sent by the SPA, see `loginBodySchema`. */
  deviceName: z.string().trim().min(1).max(120).optional(),
});

export type InvitationRole = z.infer<typeof invitationRoleSchema>;
export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;
export type InvitationParams = z.infer<typeof invitationParamsSchema>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;
