import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateAttachmentInput,
  IAttachmentRepository,
  MessageAttachmentRecord,
} from '@sac/shared';
import { mapAttachment } from './mappers';

const MAX_MESSAGES_PER_QUERY = 500;

/** Prisma implementation of `IAttachmentRepository`. */
export class PrismaAttachmentRepository implements IAttachmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createMany(inputs: CreateAttachmentInput[]): Promise<MessageAttachmentRecord[]> {
    if (inputs.length === 0) return [];

    // `createMany` cannot return rows with Postgres+Prisma; the transaction keeps
    // the batch atomic and returns the created records in input order.
    const records = await this.prisma.$transaction(
      inputs.map((input) =>
        this.prisma.messageAttachment.create({ data: buildCreateData(input) }),
      ),
    );
    return records.map(mapAttachment);
  }

  async listByMessageIds(messageIds: string[]): Promise<MessageAttachmentRecord[]> {
    const ids = [...new Set(messageIds.filter((id) => id.trim().length > 0))].slice(
      0,
      MAX_MESSAGES_PER_QUERY,
    );
    if (ids.length === 0) return [];

    const records = await this.prisma.messageAttachment.findMany({
      where: { messageId: { in: ids } },
      orderBy: [{ messageId: 'asc' }, { createdAt: 'asc' }],
    });
    return records.map(mapAttachment);
  }
}

function buildCreateData(input: CreateAttachmentInput): Prisma.MessageAttachmentUncheckedCreateInput {
  return {
    messageId: input.messageId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256 ?? null,
    s3Uri: input.s3Uri,
    externalUploadId: input.externalUploadId ?? null,
    isEvidence: input.isEvidence ?? false,
  };
}

export function createAttachmentRepository(prisma: PrismaClient): PrismaAttachmentRepository {
  return new PrismaAttachmentRepository(prisma);
}
