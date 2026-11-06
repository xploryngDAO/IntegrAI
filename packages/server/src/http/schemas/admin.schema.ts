import { z } from 'zod';
import {
  ADMIN_USERS_DEFAULT_PER_PAGE,
  ADMIN_USERS_MAX_PER_PAGE,
  ADMIN_USER_SEARCH_MAX_LENGTH,
  AUDIT_DEFAULT_PER_PAGE,
  AUDIT_MAX_PER_PAGE,
} from '@sac/shared';
import { blankAsUndefined } from './common';
import { invitationRoleSchema } from './invitation.schema';

/**
 * Zod contracts of the administrative surface (`/admin/*`).
 *
 * All query values are optional; an empty string (`?action=`) means "absent" via
 * `blankAsUndefined`, exactly like the other list endpoints. `page`/`perPage`
 * are coerced integers and `perPage` is capped at 100 (a larger request is a
 * 422, never a silent truncation).
 */

/** `:id` of `/admin/users/:id` (UUID; anything else is a 422 before Prisma). */
export const adminUserParamsSchema = z.object({
  id: z.string().uuid(),
});

/** Derived status filter of `GET /admin/users` (maps to `is_active`). */
export const adminUserStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);

/** `PATCH /admin/users/:id` - at least one field, always optional individually. */
export const updateAdminUserBodySchema = z
  .object({
    role: invitationRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'At least one of role or isActive is required',
    path: ['role'],
  });

const isoInstantSchema = z
  .string()
  .trim()
  .datetime({ offset: true, message: 'Must be an ISO-8601 instant' })
  .transform((value) => new Date(value));

const optionalPositiveInt = blankAsUndefined(z.coerce.number().int().min(1));

/**
 * Filters shared by the JSON list and the CSV export of `/admin/users`, so both
 * validate exactly the same `search`/`role`/`status` contract (`422` on an
 * unknown role or status). `search` is trimmed before the 1..120 length check.
 */
const adminUserFilterFields = {
  search: blankAsUndefined(
    z.string().trim().min(1).max(ADMIN_USER_SEARCH_MAX_LENGTH),
  ).optional(),
  role: blankAsUndefined(invitationRoleSchema).optional(),
  status: blankAsUndefined(adminUserStatusSchema).optional(),
} as const;

/** `GET /admin/users` - filters + pagination (+ 422 for perPage > 100). */
export const adminUserListQuerySchema = z.object({
  ...adminUserFilterFields,
  page: optionalPositiveInt.default(1),
  perPage: blankAsUndefined(
    z.coerce.number().int().min(1).max(ADMIN_USERS_MAX_PER_PAGE),
  ).default(ADMIN_USERS_DEFAULT_PER_PAGE),
});

/** `GET /admin/users/export.csv` - the same filters, no pagination. */
export const adminUserExportQuerySchema = z.object({ ...adminUserFilterFields });

/**
 * Filter fields shared by the JSON list and the CSV export. Keeping them in one
 * object means the export validates exactly the same `action`/`actorId`/`from`/
 * `to` contract (the export has no pagination and is capped server-side).
 */
const auditFilterFields = {
  action: blankAsUndefined(z.string().trim().min(1).max(96)).optional(),
  actorId: blankAsUndefined(z.string().uuid()).optional(),
  from: blankAsUndefined(isoInstantSchema).optional(),
  to: blankAsUndefined(isoInstantSchema).optional(),
} as const;

/** `GET /admin/audit-logs` - filters + pagination (+ 422 for perPage > 100). */
export const auditLogQuerySchema = z.object({
  ...auditFilterFields,
  page: optionalPositiveInt.default(1),
  perPage: blankAsUndefined(z.coerce.number().int().min(1).max(AUDIT_MAX_PER_PAGE)).default(
    AUDIT_DEFAULT_PER_PAGE,
  ),
});

/** `GET /admin/audit-logs/export.csv` - the same filters, no pagination. */
export const auditExportQuerySchema = z.object({ ...auditFilterFields });

export type AdminUserParams = z.infer<typeof adminUserParamsSchema>;
export type UpdateAdminUserBody = z.infer<typeof updateAdminUserBodySchema>;
export type AdminUserListQueryInput = z.infer<typeof adminUserListQuerySchema>;
export type AdminUserExportQueryInput = z.infer<typeof adminUserExportQuerySchema>;
export type AdminUserStatusInput = z.infer<typeof adminUserStatusSchema>;
export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;
export type AuditExportQueryInput = z.infer<typeof auditExportQuerySchema>;
