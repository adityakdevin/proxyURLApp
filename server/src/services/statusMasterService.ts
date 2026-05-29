import { PrismaClient, Prisma, Status, StatusMaster } from '@prisma/client';

export interface CreateStatusMasterInput {
  subCategoryId: string;
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
  subCategoryId?: string;
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
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.statusMaster.updateMany({
          where: { subCategoryId: input.subCategoryId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.statusMaster.create({
        data: {
          subCategoryId: input.subCategoryId,
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
  }

  async update(id: string, input: UpdateStatusMasterInput, actorId: string): Promise<StatusMaster> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.statusMaster.findUnique({ where: { id } });
      if (!existing) throw new StatusMasterServiceError('NOT_FOUND', 'StatusMaster not found');
      if (input.isDefault) {
        await tx.statusMaster.updateMany({
          where: { subCategoryId: existing.subCategoryId, isDefault: true, id: { not: id } },
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
    const inUse = await this.prisma.claim.count({ where: { workflowStatusId: id } });
    if (inUse > 0) {
      throw new StatusMasterServiceError(
        'STATUS_IN_USE',
        'Cannot delete a StatusMaster referenced by claims'
      );
    }
    await this.prisma.statusMaster.delete({ where: { id } });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<StatusMaster> {
    return this.prisma.statusMaster.update({
      where: { id },
      data: { status, updatedBy: actorId },
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
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
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
