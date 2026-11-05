import { z } from 'zod';

/** `GET /files/signed?key=` - traversal guard runs in the controller as well. */
export const signedUrlQuerySchema = z.object({
  key: z.string().min(1).max(512),
});

export type SignedUrlQuery = z.infer<typeof signedUrlQuerySchema>;
