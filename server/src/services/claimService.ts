import { PrismaClient, Prisma, Status, Claim, Role } from '@prisma/client';

export class ClaimServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface CreateClaimInput {
  subCategoryId: string;
  claimId: string;
  folderPath?: string | null;
  assignedToUserId?: string | null;
  remarkText?: string;
}

export interface AppendRemarkInput {
  remarkText: string;
  newStatusId?: string;
  newAssigneeId?: string | null;
}

export interface ListClaimsFilters {
  subCategoryId?: string;
  workflowStatusId?: string;
  assignedToUserId?: string;
  assignedToMe?: boolean;
  search?: string;
  scope?: { userTypeId: string; projectTypeId: string } | 'ALL';
  callerId?: string;
  page?: number;
  limit?: number;
}

export class ClaimService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateClaimInput, actorId: string): Promise<Claim> {
    const def = await this.prisma.statusMaster.findFirst({
      where: { subCategoryId: input.subCategoryId, isDefault: true, status: 'ACTIVE' },
    });
    if (!def) {
      throw new ClaimServiceError(
        'NO_DEFAULT_STATUS',
        'SubCategory has no active default status'
      );
    }

    const duplicate = await this.prisma.claim.findUnique({
      where: { claimId_subCategoryId: { claimId: input.claimId, subCategoryId: input.subCategoryId } },
    });
    if (duplicate) {
      throw new ClaimServiceError(
        'DUPLICATE_CLAIM_ID',
        'Claim ID already exists in this SubCategory'
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.create({
        data: {
          claimId: input.claimId,
          subCategoryId: input.subCategoryId,
          workflowStatusId: def.id,
          assignedToUserId: input.assignedToUserId ?? null,
          folderPath: input.folderPath ?? null,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
      if (input.remarkText && input.remarkText.trim().length > 0) {
        await tx.claimRemark.create({
          data: {
            claimId: claim.id,
            userId: actorId,
            remarkText: input.remarkText.trim(),
            statusBeforeId: null,
            statusAfterId: def.id,
          },
        });
      }
      return claim;
    });
  }

  async appendRemark(
    claimId: string,
    input: AppendRemarkInput,
    actorId: string,
    actorRole?: Role
  ): Promise<Claim> {
    if (!input.remarkText || input.remarkText.trim().length === 0) {
      throw new ClaimServiceError('REMARK_REQUIRED', 'remarkText is required');
    }
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id: claimId } });
      if (!claim) throw new ClaimServiceError('NOT_FOUND', 'Claim not found');

      const reassignRequested = Object.prototype.hasOwnProperty.call(input, 'newAssigneeId');
      if (reassignRequested && actorRole === 'USER') {
        throw new ClaimServiceError(
          'REASSIGN_FORBIDDEN',
          'Only Team Lead or Admin can reassign claims'
        );
      }

      let statusAfterId: string | null = null;
      let statusBeforeId: string | null = null;
      if (input.newStatusId && input.newStatusId !== claim.workflowStatusId) {
        const newStatus = await tx.statusMaster.findUnique({ where: { id: input.newStatusId } });
        if (!newStatus || newStatus.subCategoryId !== claim.subCategoryId) {
          throw new ClaimServiceError(
            'INVALID_STATUS',
            'New status does not belong to this SubCategory'
          );
        }
        if (newStatus.status !== 'ACTIVE') {
          throw new ClaimServiceError('STATUS_INACTIVE', 'Cannot set claim to an inactive status');
        }
        statusBeforeId = claim.workflowStatusId;
        statusAfterId = newStatus.id;
      }

      await tx.claimRemark.create({
        data: {
          claimId: claim.id,
          userId: actorId,
          remarkText: input.remarkText.trim(),
          statusBeforeId,
          statusAfterId,
        },
      });

      const dataPatch: Prisma.ClaimUpdateInput = { updatedBy: actorId };
      if (statusAfterId) dataPatch.workflowStatus = { connect: { id: statusAfterId } };
      if (reassignRequested) {
        dataPatch.assignedTo = input.newAssigneeId
          ? { connect: { id: input.newAssigneeId } }
          : { disconnect: true };
      }

      return tx.claim.update({ where: { id: claim.id }, data: dataPatch });
    });
  }

  async canEditClaim(claimId: string, callerId: string, callerRole: Role): Promise<boolean> {
    if (callerRole === 'ADMIN') return true;
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { subCategory: { include: { category: true } } },
    });
    if (!claim) return false;
    if (callerRole === 'TEAM_LEAD') {
      const assignment = await this.prisma.userAssignment.findUnique({
        where: { userId: callerId },
      });
      if (!assignment) return false;
      return (
        claim.subCategory.category.userTypeId === assignment.userTypeId &&
        claim.subCategory.category.projectTypeId === assignment.projectTypeId
      );
    }
    return claim.assignedToUserId === callerId;
  }

  async getById(id: string, callerId: string, callerRole: Role) {
    const claim = await this.prisma.claim.findUnique({
      where: { id },
      include: {
        subCategory: { include: { category: true } },
        workflowStatus: true,
        assignedTo: { select: { id: true, username: true, fullName: true } },
        remarks: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            user: { select: { id: true, fullName: true } },
            statusBefore: { select: { id: true, name: true } },
            statusAfter: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!claim) return null;
    if (callerRole !== 'ADMIN') {
      const assignment = await this.prisma.userAssignment.findUnique({
        where: { userId: callerId },
      });
      if (!assignment) return null;
      if (
        claim.subCategory.category.userTypeId !== assignment.userTypeId ||
        claim.subCategory.category.projectTypeId !== assignment.projectTypeId
      ) {
        return null;
      }
    }
    return claim;
  }

  async list(filters: ListClaimsFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where: Prisma.ClaimWhereInput = { status: 'ACTIVE' };
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.workflowStatusId) where.workflowStatusId = filters.workflowStatusId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.assignedToMe && filters.callerId) where.assignedToUserId = filters.callerId;
    if (filters.search) where.claimId = { contains: filters.search };
    if (filters.scope && filters.scope !== 'ALL') {
      where.subCategory = {
        category: {
          userTypeId: filters.scope.userTypeId,
          projectTypeId: filters.scope.projectTypeId,
        },
      };
    }
    const [data, total] = await Promise.all([
      this.prisma.claim.findMany({
        where,
        include: {
          subCategory: { select: { id: true, name: true, categoryId: true } },
          workflowStatus: { select: { id: true, name: true, isTerminal: true } },
          assignedTo: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claim.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async softDelete(id: string, actorId: string): Promise<Claim> {
    return this.prisma.claim.update({
      where: { id },
      data: { status: Status.INACTIVE, updatedBy: actorId },
    });
  }

  async listRemarks(claimId: string, page = 1, limit = 20) {
    const where = { claimId };
    const [data, total] = await Promise.all([
      this.prisma.claimRemark.findMany({
        where,
        include: {
          user: { select: { id: true, fullName: true } },
          statusBefore: { select: { id: true, name: true } },
          statusAfter: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claimRemark.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
