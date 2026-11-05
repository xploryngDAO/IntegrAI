import { z } from 'zod';
import { marketplaceCsvSchema, queueFilterSchema, uuidSchema } from './enums.schema';
import { blankAsUndefined } from './common';

/** `GET /stats?marketplace=&accountId=` (also accepted by `/queue/snapshot`). */
export const statsQuerySchema = z.object({
  marketplace: blankAsUndefined(marketplaceCsvSchema.optional()),
  accountId: blankAsUndefined(uuidSchema.optional()),
  filter: blankAsUndefined(queueFilterSchema.optional()),
});

export type StatsQuery = z.infer<typeof statsQuerySchema>;
