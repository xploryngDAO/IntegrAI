import { z } from 'zod';

/**
 * `PATCH /tenants/me` (Fase 2 onboarding).
 *
 * The workspace identity comes from the JWT; the body can only rename the tenant
 * and complete/restart the guided onboarding. An empty body is rejected so a
 * typo never silently becomes a no-op.
 */
export const updateTenantBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    onboardingCompleted: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.onboardingCompleted !== undefined, {
    message: 'At least one of name or onboardingCompleted is required',
  });

export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>;

/**
 * `DELETE /tenants/me` (Fase 4 LGPD soft delete).
 *
 * Double confirmation: the caller re-types the workspace slug and the password
 * of the authenticated ADMIN. Both are checked server-side (`bcrypt.compare`
 * plus exact slug match); `.strict()` rejects any smuggled field.
 */
export const deleteTenantBodySchema = z
  .object({
    password: z.string().min(1).max(200),
    confirmSlug: z.string().trim().min(1).max(80),
  })
  .strict();

export type DeleteTenantBody = z.infer<typeof deleteTenantBodySchema>;
