import { PrismaClient, Prisma, Status, StatusMaster } from '@prisma/client';

export interface CreateStatusMasterInput {
  name: string;
  displayOrder?: number;
  isDefault?: boolean;
  isTerminal?: boolean;
  status?: Status;
}

export interface UpdateStatusMasterInput {
  name?: string;
  displayOrder?: number;
  isDefault?: boolean;
  isTerminal?: boolean;
  status?: Status;
}

export interface ListStatusMastersFilters {
  status?: Status;
  page?: number;
  limit?: number;
}

export class StatusMasterServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class StatusMasterService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateStatusMasterInput, actorId: string): Promise<StatusMaster> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.statusMaster.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.statusMaster.create({
          data: {
            name: input.name,
            displayOrder: input.displayOrder ?? 0,
            isDefault: input.isDefault ?? false,
            isTerminal: input.isTerminal ?? false,
            status: input.status ?? Status.ACTIVE,
            createdBy: actorId,
            updatedBy: actorId,
          },
        });
      });
    } catch (err) {
      // Translate the unique(name) violation here (was handled inline in the
      // route, inconsistently with sibling services).
      if ((err as { code?: string }).code === 'P2002') {
        throw new StatusMasterServiceError(
          'DUPLICATE_STATUS_NAME',
          'Status name must be unique'
        );
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateStatusMasterInput, actorId: string): Promise<StatusMaster> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.statusMaster.findUnique({ where: { id } });
      if (!existing) throw new StatusMasterServiceError('NOT_FOUND', 'StatusMaster not found');
      // The default status can't be deactivated or un-defaulted — claim creation
      // and scan enqueue both require an ACTIVE default to exist.
      if (existing.isDefault && input.status === 'INACTIVE') {
        throw new StatusMasterServiceError(
          'STATUS_IS_DEFAULT',
          'Cannot deactivate the default status; set another status as default first'
        );
      }
      if (existing.isDefault && input.isDefault === false) {
        throw new StatusMasterServiceError(
          'STATUS_IS_DEFAULT',
          'Cannot unset the default status; promote another status to default instead'
        );
      }
      if (input.isDefault) {
        await tx.statusMaster.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.statusMaster.update({
        where: { id },
        data: { ...input, updatedBy: actorId },
      });
    });
  }

  async delete(id: string): Promise<void> {
    // Count claim + remark references atomically so a status can't be deleted
    // out from under a claim's current status OR its audit timeline.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.statusMaster.findUnique({ where: { id } });
      if (!existing) throw new StatusMasterServiceError('NOT_FOUND', 'StatusMaster not found');
      if (existing.isDefault) {
        throw new StatusMasterServiceError(
          'STATUS_IS_DEFAULT',
          'Cannot delete the default status; promote another status to default first'
        );
      }
      const [claimRefs, remarkRefs] = await Promise.all([
        tx.claim.count({ where: { workflowStatusId: id } }),
        tx.claimRemark.count({
          where: { OR: [{ statusBeforeId: id }, { statusAfterId: id }] },
        }),
      ]);
      if (claimRefs + remarkRefs > 0) {
        throw new StatusMasterServiceError(
          'STATUS_IN_USE',
          'Cannot delete a StatusMaster referenced by claims or remark history'
        );
      }
      await tx.statusMaster.delete({ where: { id } });
    });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<StatusMaster> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.statusMaster.findUnique({ where: { id } });
      if (!existing) throw new StatusMasterServiceError('NOT_FOUND', 'StatusMaster not found');
      if (existing.isDefault && status === 'INACTIVE') {
        throw new StatusMasterServiceError(
          'STATUS_IS_DEFAULT',
          'Cannot deactivate the default status; set another status as default first'
        );
      }
      return tx.statusMaster.update({
        where: { id },
        data: { status, updatedBy: actorId },
      });
    });
  }

  async getById(id: string): Promise<StatusMaster | null> {
    return this.prisma.statusMaster.findUnique({ where: { id } });
  }

  async list(
    filters: ListStatusMastersFilters
  ): Promise<{ data: StatusMaster[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.StatusMasterWhereInput = {};
    if (filters.status) where.status = filters.status;
    const [data, total] = await Promise.all([
      this.prisma.statusMaster.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.statusMaster.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
