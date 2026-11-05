import { z } from 'zod';
import { agentPresenceSchema } from './enums.schema';

/** Minimum password policy (Fase 1): 12 characters. */
export const PASSWORD_MIN_LENGTH = 12;

/** `POST /auth/login`. */
export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
  /**
   * Optional device label sent by the SPA (e.g. "Chrome no Windows"); stored as
   * `sessions.user_agent` when the request carries no `User-Agent` header.
   */
  deviceName: z.string().trim().min(1).max(120).optional(),
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

/** `POST /auth/forgot-password` - always answers 202, no enumeration (public). */
export const forgotPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/** `POST /auth/reset-password` - consumes the single-use token (public). */
export const resetPasswordBodySchema = z.object({
  token: z.string().trim().min(32).max(256),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(200),
});

/** `POST /auth/refresh` - rotates the refresh token (public). */
export const refreshBodySchema = z.object({
  refreshToken: z.string().trim().min(32).max(256),
  /** Optional device label, see `loginBodySchema`. */
  deviceName: z.string().trim().min(1).max(120).optional(),
});

/** `POST /auth/logout` - revokes the given session (or all when omitted). */
export const logoutBodySchema = z.object({
  refreshToken: z.string().trim().min(32).max(256).optional(),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type PresenceBody = z.infer<typeof presenceBodySchema>;
export type SignupBody = z.infer<typeof signupBodySchema>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;
export type ResendVerificationBody = z.infer<typeof resendVerificationBodySchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
