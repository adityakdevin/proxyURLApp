import { PrismaClient, Prisma, Status, Claim, Role } from '@prisma/client';

export class ClaimServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** folderPath, when present, must mirror the ClaimIdRule.scanLocation rule (spec §6.3/§10). */
function validateFolderPath(value: string): void {
  if (!/^[A-Za-z]:\\.+/.test(value) || /^[Cc]:\\/.test(value)) {
    throw new ClaimServiceError(
      'INVALID_FOLDER_PATH',
      'folderPath must be an absolute drive-letter path and cannot be on the C drive'
    );
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new ClaimServiceError(
      'INVALID_FOLDER_PATH',
      'folderPath must not contain ".." path segments'
    );
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
  /** Admin-only lifecycle filter; ignored for scoped callers (always ACTIVE). Defaults to ACTIVE. */
  status?: Status;
  scope?: { userTypeId: string; projectTypeId: string } | 'ALL';
  callerId?: string;
  page?: number;
  limit?: number;
}

export interface ExportRow {
  claimId: string;
  subCategory: string;
  category: string;
  workflowStatus: string;
  assignedTo: string;
  spell: string;
  qr: string;
  meta: string;
  intra: string;
  full: string;
  documents: number;
  created: string;
}

const EXPORT_MAX = 50000;

export class ClaimService {
  constructor(private prisma: PrismaClient) {}

  async create(
    input: CreateClaimInput,
    actorId: string,
    scope?: { userTypeId: string; projectTypeId: string } | 'ALL',
    opts?: { trustedFolderPath?: boolean }
  ): Promise<Claim> {
    const subCategory = await this.prisma.subCategory.findUnique({
      where: { id: input.subCategoryId },
      include: { category: { select: { userTypeId: true, projectTypeId: true } } },
    });
    if (!subCategory) {
      throw new ClaimServiceError('SUBCATEGORY_NOT_FOUND', 'SubCategory not found');
    }
    const pairUserTypeId = subCategory.category.userTypeId;
    const pairProjectTypeId = subCategory.category.projectTypeId;

    // Team Lead may only create claims inside their assigned (UserType, ProjectType) pair.
    if (scope && scope !== 'ALL') {
      if (scope.userTypeId !== pairUserTypeId || scope.projectTypeId !== pairProjectTypeId) {
        throw new ClaimServiceError('OUT_OF_SCOPE', 'SubCategory is outside your scope');
      }
    }

    if (input.folderPath && input.folderPath.trim().length > 0 && !opts?.trustedFolderPath) {
      validateFolderPath(input.folderPath);
    }

    if (input.assignedToUserId) {
      await this.validateAssignee(input.assignedToUserId, pairUserTypeId, pairProjectTypeId);
    }

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
      let claim: Claim;
      try {
        claim = await tx.claim.create({
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
      } catch (err) {
        // Race-loser path: translate the unique-constraint violation to the typed
        // code so scanService's skip-counting and doc discovery still work.
        if ((err as { code?: string }).code === 'P2002') {
          throw new ClaimServiceError(
            'DUPLICATE_CLAIM_ID',
            'Claim ID already exists in this SubCategory'
          );
        }
        throw err;
      }
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
      const claim = await tx.claim.findUnique({
        where: { id: claimId },
        include: {
          subCategory: { include: { category: { select: { userTypeId: true, projectTypeId: true } } } },
          workflowStatus: { select: { isTerminal: true } },
        },
      });
      if (!claim) throw new ClaimServiceError('NOT_FOUND', 'Claim not found');
      // Never mutate a soft-deleted claim (defense in depth behind canEditClaim).
      if (claim.status !== 'ACTIVE') throw new ClaimServiceError('NOT_FOUND', 'Claim not found');

      const reassignRequested = Object.prototype.hasOwnProperty.call(input, 'newAssigneeId');
      if (reassignRequested && actorRole === 'USER') {
        throw new ClaimServiceError(
          'REASSIGN_FORBIDDEN',
          'Only Team Lead or Admin can reassign claims'
        );
      }
      // A (non-null) reassignment target must be an active, non-admin user in the claim's scope.
      if (reassignRequested && input.newAssigneeId) {
        await this.validateAssignee(
          input.newAssigneeId,
          claim.subCategory.category.userTypeId,
          claim.subCategory.category.projectTypeId
        );
      }

      let statusAfterId: string | null = null;
      let statusBeforeId: string | null = null;
      if (input.newStatusId && input.newStatusId !== claim.workflowStatusId) {
        // Block transitions out of a terminal status; ADMIN may override.
        if (claim.workflowStatus.isTerminal && actorRole !== 'ADMIN') {
          throw new ClaimServiceError(
            'TERMINAL_STATUS',
            'Claim is in a terminal status and cannot be changed'
          );
        }
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
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { subCategory: { include: { category: true } } },
    });
    // A soft-deleted claim is editable by no one (incl. admins) until restored.
    if (!claim || claim.status !== 'ACTIVE') return false;
    if (callerRole === 'ADMIN') return true;
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
    // USER: must be the assignee AND still in the claim's scope (closes a
    // stale-assignment edge case).
    if (claim.assignedToUserId !== callerId) return false;
    const assignment = await this.prisma.userAssignment.findUnique({
      where: { userId: callerId },
    });
    if (!assignment) return false;
    return (
      claim.subCategory.category.userTypeId === assignment.userTypeId &&
      claim.subCategory.category.projectTypeId === assignment.projectTypeId
    );
  }

  /**
   * An assignee must be an ACTIVE, non-ADMIN user who holds an assignment
   * matching the claim's (UserType, ProjectType) pair. Mirrors the
   * /user/users-in-scope lookup that populates the "Assign to" dropdown.
   */
  private async validateAssignee(
    assigneeId: string,
    userTypeId: string,
    projectTypeId: string
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: assigneeId },
      include: { assignments: true },
    });
    if (!user || user.status !== 'ACTIVE' || user.role === 'ADMIN') {
      throw new ClaimServiceError(
        'INVALID_ASSIGNEE',
        'Assignee must be an active, non-admin user'
      );
    }
    const inScope = user.assignments.some(
      (a) => a.userTypeId === userTypeId && a.projectTypeId === projectTypeId
    );
    if (!inScope) {
      throw new ClaimServiceError('INVALID_ASSIGNEE', "Assignee is not in this claim's scope");
    }
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
    // Non-admins never see soft-deleted claims; admins may, for audit/restore.
    if (claim.status !== 'ACTIVE' && callerRole !== 'ADMIN') return null;
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
    const where = this.buildWhere(filters);
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

  private buildWhere(filters: ListClaimsFilters): Prisma.ClaimWhereInput {
    const where: Prisma.ClaimWhereInput = {};
    // Only admins (scope 'ALL') may view non-ACTIVE claims; default ACTIVE.
    where.status = filters.scope === 'ALL' ? filters.status ?? 'ACTIVE' : 'ACTIVE';
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.workflowStatusId) where.workflowStatusId = filters.workflowStatusId;
    // "assigned to me" wins over an explicit assignee filter (deterministically).
    if (filters.assignedToMe && filters.callerId) {
      where.assignedToUserId = filters.callerId;
    } else if (filters.assignedToUserId) {
      where.assignedToUserId = filters.assignedToUserId;
    }
    if (filters.search) where.claimId = { contains: filters.search };
    if (filters.scope && filters.scope !== 'ALL') {
      where.subCategory = {
        category: {
          userTypeId: filters.scope.userTypeId,
          projectTypeId: filters.scope.projectTypeId,
        },
      };
    }
    return where;
  }

  async exportRows(filters: ListClaimsFilters): Promise<ExportRow[]> {
    const where = this.buildWhere(filters);
    const claims = await this.prisma.claim.findMany({
      where,
      include: {
        subCategory: { select: { name: true, category: { select: { name: true } } } },
        workflowStatus: { select: { name: true } },
        assignedTo: { select: { fullName: true } },
        _count: { select: { documents: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_MAX,
    });
    if (claims.length === EXPORT_MAX) {
      console.warn(`Claims export hit the ${EXPORT_MAX}-row cap; some matching claims were omitted.`);
    }
    return claims.map((c) => ({
      claimId: c.claimId,
      subCategory: c.subCategory.name,
      category: c.subCategory.category.name,
      workflowStatus: c.workflowStatus.name,
      assignedTo: c.assignedTo?.fullName ?? 'Unassigned',
      spell: c.spellCheckStatus,
      qr: c.qrStatus,
      meta: c.metaExtractionStatus,
      intra: c.intraClaimStatus,
      full: c.fullScanStatus,
      documents: c._count.documents,
      created: c.createdAt.toISOString().slice(0, 10),
    }));
  }

  async softDelete(id: string, actorId: string): Promise<Claim> {
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id } });
      if (!claim) throw new ClaimServiceError('NOT_FOUND', 'Claim not found');
      if (claim.status !== 'ACTIVE') return claim; // idempotent
      await tx.claimRemark.create({
        data: { claimId: id, userId: actorId, remarkText: 'Claim soft-deleted' },
      });
      return tx.claim.update({
        where: { id },
        data: { status: Status.INACTIVE, updatedBy: actorId },
      });
    });
  }

  /** Reverse a soft-delete. Admin-only recovery path (see routes/admin/claims). */
  async restore(id: string, actorId: string): Promise<Claim> {
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id } });
      if (!claim) throw new ClaimServiceError('NOT_FOUND', 'Claim not found');
      if (claim.status === 'ACTIVE') return claim; // idempotent
      await tx.claimRemark.create({
        data: { claimId: id, userId: actorId, remarkText: 'Claim restored from soft-delete' },
      });
      return tx.claim.update({
        where: { id },
        data: { status: Status.ACTIVE, updatedBy: actorId },
      });
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
