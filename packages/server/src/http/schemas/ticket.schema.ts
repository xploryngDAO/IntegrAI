import { z } from 'zod';
import {
  marketplaceCsvSchema,
  queueFilterSchema,
  ticketStatusCsvSchema,
  ticketStatusSchema,
  uuidSchema,
} from './enums.schema';
import { blankAsUndefined } from './common';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';

/** `GET /tickets` query string. */
export const ticketListQuerySchema = z.object({
  filter: blankAsUndefined(queueFilterSchema.optional()),
  marketplace: blankAsUndefined(marketplaceCsvSchema.optional()),
  accountId: blankAsUndefined(uuidSchema.optional()),
  search: blankAsUndefined(z.string().trim().min(1).max(200).optional()),
  status: blankAsUndefined(ticketStatusCsvSchema.optional()),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const ticketIdParamsSchema = z.object({
  id: uuidSchema,
});

/** `POST /tickets/:id/assign`. */
export const assignTicketBodySchema = z.object({
  agentId: uuidSchema,
});

/** `POST /tickets/:id/status`. */
export const changeTicketStatusBodySchema = z.object({
  status: ticketStatusSchema,
});

/** `POST /tickets/:id/notes`. */
export const ticketNoteBodySchema = z.object({
  text: z.string().trim().min(1).max(10_000),
});

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export type AssignTicketBody = z.infer<typeof assignTicketBodySchema>;
export type ChangeTicketStatusBody = z.infer<typeof changeTicketStatusBodySchema>;
export type TicketNoteBody = z.infer<typeof ticketNoteBodySchema>;
