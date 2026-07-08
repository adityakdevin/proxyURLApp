import { PrismaClient, Prisma, Status, Claim, Role, ValidationStatus } from '@prisma/client';
import {
  ObservationExportRow,
  ObservationRowError,
  ParsedObservationRow,
  deriveForgeryStatus,
} from './observationSheet.js';
import { binaryValidationStatus } from '../validators/ruleLogic.js';

export class ClaimServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * folderPath, when present, must mirror the ClaimIdRule.scanLocation rule (spec §6.3/§10).
 * The ".." traversal guard and the C:-drive ban apply on EVERY OS (the C: system drive is
 * never a valid claims folder). Only the absolute-drive-letter shape is enforced on Windows
 * (production); in macOS/Linux dev any other traversal-free path is accepted, since
 * resolveScanRoot() strips a drive-letter prefix (if present) and re-roots under
 * CLAIMS_SCAN_ROOT — so "D:\\Claims\\Daily\\<VIN>" and "Claims/Daily/<VIN>" both resolve to
 * <CLAIMS_SCAN_ROOT>/Claims/Daily/<VIN>.
 */
function validateFolderPath(value: string): void {
  if (value.split(/[\\/]/).includes('..')) {
    throw new ClaimServiceError(
      'INVALID_FOLDER_PATH',
      'folderPath must not contain ".." path segments'
    );
  }
  if (/^[Cc]:\\/.test(value)) {
    throw new ClaimServiceError('INVALID_FOLDER_PATH', 'folderPath cannot be on the C drive');
  }
  if (process.platform === 'win32' && !/^[A-Za-z]:\\.+/.test(value)) {
    throw new ClaimServiceError(
      'INVALID_FOLDER_PATH',
      'folderPath must be an absolute drive-letter path'
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

export interface ObservationImportResult {
  created: number;
  updated: number;
  errors: ObservationRowError[];
}

export interface ListClaimsFilters {
  subCategoryId?: string;
  workflowStatusId?: string;
  assignedToUserId?: string;
  assignedToMe?: boolean;
  search?: string;
  /** Admin-only lifecycle filter; ignored for scoped callers (always ACTIVE). Defaults to ACTIVE. */
  status?: Status;
  /** Per-check result filters (each of the five validation columns). */
  spellCheckStatus?: ValidationStatus;
  qrStatus?: ValidationStatus;
  metaExtractionStatus?: ValidationStatus;
  intraClaimStatus?: ValidationStatus;
  fullScanStatus?: ValidationStatus;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  scope?: { subCategoryIds: string[] } | 'ALL';
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
    scope?: { subCategoryIds: string[] } | 'ALL',
    opts?: { trustedFolderPath?: boolean }
  ): Promise<Claim> {
    const subCategory = await this.prisma.subCategory.findUnique({
      where: { id: input.subCategoryId },
    });
    if (!subCategory) {
      throw new ClaimServiceError('SUBCATEGORY_NOT_FOUND', 'SubCategory not found');
    }

    // Team Lead may only create claims inside a sub-category they are granted.
    if (scope && scope !== 'ALL') {
      if (!scope.subCategoryIds.includes(input.subCategoryId)) {
        throw new ClaimServiceError('OUT_OF_SCOPE', 'SubCategory is outside your scope');
      }
    }

    if (input.folderPath && input.folderPath.trim().length > 0 && !opts?.trustedFolderPath) {
      validateFolderPath(input.folderPath);
    }

    if (input.assignedToUserId) {
      await this.validateAssignee(input.assignedToUserId, input.subCategoryId);
    }

    const def = await this.prisma.statusMaster.findFirst({
      where: { isDefault: true, status: 'ACTIVE' },
    });
    if (!def) {
      throw new ClaimServiceError(
        'NO_DEFAULT_STATUS',
        'No active default status configured'
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

  /**
   * Bulk create-or-update claims from a parsed "Forged Documents Observations"
   * sheet (decision #1), all addressed to one Sub-Category. The Sub-Category and
   * its default status are resolved once up front (not per row); each row is then
   * upserted by the (claimId, subCategoryId) unique key, and any per-row failure
   * is collected rather than aborting the batch.
   */
  async importObservations(
    rows: ParsedObservationRow[],
    subCategoryId: string,
    actorId: string,
    scope?: { subCategoryIds: string[] } | 'ALL'
  ): Promise<ObservationImportResult> {
    const subCategory = await this.prisma.subCategory.findUnique({
      where: { id: subCategoryId },
    });
    if (!subCategory) {
      throw new ClaimServiceError('SUBCATEGORY_NOT_FOUND', 'SubCategory not found');
    }
    if (scope && scope !== 'ALL') {
      if (!scope.subCategoryIds.includes(subCategoryId)) {
        throw new ClaimServiceError('OUT_OF_SCOPE', 'SubCategory is outside your scope');
      }
    }
    // Needed only when a row creates a new claim; resolved once (may be absent).
    const def = await this.prisma.statusMaster.findFirst({
      where: { isDefault: true, status: 'ACTIVE' },
    });

    const errors: ObservationRowError[] = [];
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      try {
        const action = await this.upsertObservationRow(row, subCategoryId, def?.id ?? null, actorId);
        if (action === 'created') created++;
        else updated++;
      } catch (err) {
        const message =
          err instanceof ClaimServiceError ? err.message : 'Unexpected error saving row';
        errors.push({ rowNumber: row.rowNumber, message });
      }
    }
    return { created, updated, errors };
  }

  /**
   * Upsert a single observation row. Business fields are always (re)written; the
   * workflow status is left untouched on update. On create the claim is seeded
   * with the (pre-resolved) default status and the verbatim remarks are mirrored
   * into a ClaimRemark for the audit trail.
   */
  private async upsertObservationRow(
    row: ParsedObservationRow,
    subCategoryId: string,
    defaultStatusId: string | null,
    actorId: string
  ): Promise<'created' | 'updated'> {
    const remarks = row.remarks?.trim() || null;
    const business = {
      dealerName: row.dealerName,
      dealerCode: row.dealerCode,
      invoiceDate: row.invoiceDate,
      vinNo: row.vinNo,
      customerName: row.customerName,
      schemeType: row.schemeType,
      observationRemarks: remarks,
    };

    const existing = await this.prisma.claim.findUnique({
      where: { claimId_subCategoryId: { claimId: row.claimId, subCategoryId } },
    });
    if (existing) {
      await this.prisma.claim.update({
        where: { id: existing.id },
        data: { ...business, updatedBy: actorId },
      });
      return 'updated';
    }
    if (!defaultStatusId) {
      throw new ClaimServiceError('NO_DEFAULT_STATUS', 'SubCategory has no active default status');
    }

    return this.prisma.$transaction(async (tx): Promise<'created' | 'updated'> => {
      try {
        const claim = await tx.claim.create({
          data: {
            claimId: row.claimId,
            subCategoryId,
            workflowStatusId: defaultStatusId,
            ...business,
            createdBy: actorId,
            updatedBy: actorId,
          },
        });
        if (remarks) {
          await tx.claimRemark.create({
            data: {
              claimId: claim.id,
              userId: actorId,
              remarkText: remarks,
              statusBeforeId: null,
              statusAfterId: defaultStatusId,
            },
          });
        }
        return 'created';
      } catch (err) {
        // Lost a create race: fall back to an update so the import stays idempotent
        // (mirrors the plain update path above — no remark is added on update).
        if ((err as { code?: string }).code === 'P2002') {
          await tx.claim.update({
            where: { claimId_subCategoryId: { claimId: row.claimId, subCategoryId } },
            data: { ...business, updatedBy: actorId },
          });
          return 'updated';
        }
        throw err;
      }
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
          subCategory: { include: { category: { select: { projectId: true } } } },
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
        await this.validateAssignee(input.newAssigneeId, claim.subCategoryId);
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

  // Whether a user has been granted access to a given SubCategory.
  private async hasSubCategoryAccess(userId: string, subCategoryId: string): Promise<boolean> {
    const row = await this.prisma.userSubCategory.findUnique({
      where: { userId_subCategoryId: { userId, subCategoryId } },
      select: { id: true },
    });
    return !!row;
  }

  async canEditClaim(claimId: string, callerId: string, callerRole: Role): Promise<boolean> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { status: true, subCategoryId: true, assignedToUserId: true },
    });
    // A soft-deleted claim is editable by no one (incl. admins) until restored.
    if (!claim || claim.status !== 'ACTIVE') return false;
    if (callerRole === 'ADMIN') return true;
    if (callerRole === 'TEAM_LEAD') {
      return this.hasSubCategoryAccess(callerId, claim.subCategoryId);
    }
    // USER: must be the assignee AND still be granted the claim's sub-category
    // (closes a stale-assignment edge case).
    if (claim.assignedToUserId !== callerId) return false;
    return this.hasSubCategoryAccess(callerId, claim.subCategoryId);
  }

  /**
   * An assignee must be an ACTIVE, non-ADMIN user who has been granted the
   * claim's SubCategory. Mirrors the /user/users-in-scope lookup that
   * populates the "Assign to" dropdown.
   */
  private async validateAssignee(
    assigneeId: string,
    subCategoryId: string
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: assigneeId },
      select: { status: true, role: true },
    });
    if (!user || user.status !== 'ACTIVE' || user.role === 'ADMIN') {
      throw new ClaimServiceError(
        'INVALID_ASSIGNEE',
        'Assignee must be an active, non-admin user'
      );
    }
    if (!(await this.hasSubCategoryAccess(assigneeId, subCategoryId))) {
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
      if (!(await this.hasSubCategoryAccess(callerId, claim.subCategoryId))) {
        return null;
      }
    }
    return claim;
  }

  /** Columns clients may sort the claim list by (guards against arbitrary orderBy keys). */
  private static readonly SORTABLE_FIELDS = new Set([
    'claimId',
    'createdAt',
    'spellCheckStatus',
    'qrStatus',
    'metaExtractionStatus',
    'intraClaimStatus',
    'fullScanStatus',
  ]);

  async list(filters: ListClaimsFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where = this.buildWhere(filters);
    const sortBy =
      filters.sortBy && ClaimService.SORTABLE_FIELDS.has(filters.sortBy)
        ? filters.sortBy
        : 'createdAt';
    const sortOrder = filters.sortOrder === 'asc' ? 'asc' : 'desc';
    const [data, total] = await Promise.all([
      this.prisma.claim.findMany({
        where,
        include: {
          subCategory: { select: { id: true, name: true, categoryId: true } },
          workflowStatus: { select: { id: true, name: true, isTerminal: true } },
          assignedTo: { select: { id: true, fullName: true } },
        },
        orderBy: { [sortBy]: sortOrder },
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
    if (filters.spellCheckStatus) where.spellCheckStatus = filters.spellCheckStatus;
    if (filters.qrStatus) where.qrStatus = filters.qrStatus;
    if (filters.metaExtractionStatus) where.metaExtractionStatus = filters.metaExtractionStatus;
    if (filters.intraClaimStatus) where.intraClaimStatus = filters.intraClaimStatus;
    if (filters.fullScanStatus) where.fullScanStatus = filters.fullScanStatus;
    if (filters.scope && filters.scope !== 'ALL') {
      where.subCategoryId = { in: filters.scope.subCategoryIds };
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
      spell: binaryValidationStatus(c.spellCheckStatus),
      qr: binaryValidationStatus(c.qrStatus),
      meta: binaryValidationStatus(c.metaExtractionStatus),
      intra: binaryValidationStatus(c.intraClaimStatus),
      full: binaryValidationStatus(c.fullScanStatus),
      documents: c._count.documents,
      created: c.createdAt.toISOString().slice(0, 10),
    }));
  }

  /**
   * Rows for the "Forged Documents Observations" export (decisions #2/#3/#6):
   * the original 10-column layout, with S.No regenerated, the uploaded remarks
   * verbatim, and Status derived from the latest validation results.
   */
  async observationExportRows(filters: ListClaimsFilters): Promise<ObservationExportRow[]> {
    // Restrict to claims that actually carry observation data, so scan-discovered
    // claims (which never went through an upload) don't pad the export with blanks.
    const where: Prisma.ClaimWhereInput = {
      ...this.buildWhere(filters),
      OR: [
        { observationRemarks: { not: null } },
        { dealerName: { not: null } },
        { dealerCode: { not: null } },
        { invoiceDate: { not: null } },
        { vinNo: { not: null } },
        { customerName: { not: null } },
        { schemeType: { not: null } },
      ],
    };
    const claims = await this.prisma.claim.findMany({
      where,
      select: {
        claimId: true,
        dealerName: true,
        dealerCode: true,
        invoiceDate: true,
        vinNo: true,
        customerName: true,
        schemeType: true,
        observationRemarks: true,
        spellCheckStatus: true,
        qrStatus: true,
        metaExtractionStatus: true,
        intraClaimStatus: true,
        fullScanStatus: true,
      },
      // Ascending mirrors the source sheet's S.No ordering (oldest = row 1).
      orderBy: { createdAt: 'asc' },
      take: EXPORT_MAX,
    });
    if (claims.length === EXPORT_MAX) {
      console.warn(
        `Observation export hit the ${EXPORT_MAX}-row cap; some matching claims were omitted.`
      );
    }
    return claims.map((c, i) => ({
      sNo: i + 1,
      claimId: c.claimId,
      dealerName: c.dealerName ?? '',
      dealerCode: c.dealerCode ?? '',
      invoiceDate: c.invoiceDate ? c.invoiceDate.toISOString().slice(0, 10) : '',
      vinNo: c.vinNo ?? '',
      customerName: c.customerName ?? '',
      schemeType: c.schemeType ?? '',
      status: deriveForgeryStatus(c),
      remarks: c.observationRemarks ?? '',
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
