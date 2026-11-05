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
