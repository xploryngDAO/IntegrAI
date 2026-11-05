import { z } from 'zod';
import { uuidSchema } from './enums.schema';

/**
 * `POST /accounts/:id/diagnose` path params.
 *
 * The account id is a Prisma `uuid()`; unknown ids are resolved (and mapped to
 * HTTP 404) by `IDiagnosticsService.account`, never here.
 */
export const diagnoseAccountParamsSchema = z.object({
  id: uuidSchema,
});

export type DiagnoseAccountParams = z.infer<typeof diagnoseAccountParamsSchema>;
