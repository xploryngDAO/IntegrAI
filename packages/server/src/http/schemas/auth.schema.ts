import { z } from 'zod';
import { agentPresenceSchema } from './enums.schema';

/** `POST /auth/login`. */
export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

/** `PUT /auth/presence`. */
export const presenceBodySchema = z.object({
  presence: agentPresenceSchema,
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type PresenceBody = z.infer<typeof presenceBodySchema>;
