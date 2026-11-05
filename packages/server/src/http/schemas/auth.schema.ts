import { z } from 'zod';
import { agentPresenceSchema } from './enums.schema';

/** Minimum password policy (Fase 1): 12 characters. */
export const PASSWORD_MIN_LENGTH = 12;

/** `POST /auth/login`. */
export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

/** `PUT /auth/presence`. */
export const presenceBodySchema = z.object({
  presence: agentPresenceSchema,
});

/** `POST /auth/signup` - creates the tenant + first ADMIN (public). */
export const signupBodySchema = z.object({
  companyName: z.string().trim().min(2).max(160),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(200),
});

/** `POST /auth/verify-email` - consumes the single-use token (public). */
export const verifyEmailBodySchema = z.object({
  token: z.string().trim().min(32).max(256),
});

/** `POST /auth/resend-verification` - always answers 202 (public). */
export const resendVerificationBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type PresenceBody = z.infer<typeof presenceBodySchema>;
export type SignupBody = z.infer<typeof signupBodySchema>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;
export type ResendVerificationBody = z.infer<typeof resendVerificationBodySchema>;
