import { PrismaClient, Prisma, Status, Claim, Role, ValidationStatus } from '@prisma/client';
import {
  ObservationExportRow,
  ObservationRowError,
  ParsedObservationRow,
  deriveForgeryStatus,
} from './observationSheet.js';
import { collapseValidationStatus } from '../validators/ruleLogic.js';

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
  redFlagStatus?: ValidationStatus;
  duplicateStatus?: ValidationStatus;
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
  redFlag: string;
  duplicate: string;
  /** The bifurcated QR result (NO_QR / UNREADABLE / MISMATCH / OK). Empty for claims
   *  validated before the column existed — `qr` still carries the pass/fail status. */
  qrOutcome: string;
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
        // Status masters are global now — any existing status is valid for any claim
        // (the old per-SubCategory ownership check referenced a removed column).
        const newStatus = await tx.statusMaster.findUnique({ where: { id: input.newStatusId } });
        if (!newStatus) {
          throw new ClaimServiceError('INVALID_STATUS', 'New status does not exist');
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

  /**
   * The claims either side of this one in the default list order (createdAt desc, id desc
   * as the tiebreak so equal timestamps — a bulk import — still step deterministically),
   * within the caller's scope. Each neighbour carries its first document, so the document
   * viewer can walk claims without bouncing through the claim page to pick a file.
   * ponytail: default order only. If the viewer ever has to follow the list's own sort and
   * filters, pass them in — buildWhere already takes them.
   */
  async adjacent(id: string, filters: ListClaimsFilters) {
    const where = this.buildWhere(filters);
    // The anchor goes through the SAME scope as its neighbours. An unscoped findUnique here
    // answered 200 for a claim in another project — telling the caller that id exists and
    // where it sits in their own timeline.
    const current = await this.prisma.claim.findFirst({
      where: { AND: [where, { id }] },
      select: { id: true, createdAt: true },
    });
    if (!current) return null;
    const neighbour = async (dir: 'prev' | 'next') => {
      // 'prev' is the row ABOVE in the list — newer — because the list is newest-first.
      const [cmp, order] = dir === 'prev' ? (['gt', 'asc'] as const) : (['lt', 'desc'] as const);
      const c = await this.prisma.claim.findFirst({
        where: {
          AND: [
            where,
            {
              OR: [
                { createdAt: { [cmp]: current.createdAt } },
                { createdAt: current.createdAt, id: { [cmp]: current.id } },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: order }, { id: order }],
        select: {
          id: true,
          claimId: true,
          documents: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true } },
        },
      });
      return c && { id: c.id, claimId: c.claimId, documentId: c.documents[0]?.id ?? null };
    };
    const [prev, next] = await Promise.all([neighbour('prev'), neighbour('next')]);
    return { prev, next };
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
    'redFlagStatus',
    'duplicateStatus',
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
        // id as a tiebreak so the order is total: claims imported by one scan share a
        // createdAt, and without it MySQL may repeat or skip rows across pages — and the
        // viewer's step arrows (which order by createdAt THEN id) would walk a different
        // sequence than the list the reviewer is stepping through. Not applied to claimId,
        // which is already unique per sub-category: appending id there matches no index and
        // turns an index-ordered scan into a filesort of every ACTIVE claim.
        orderBy:
          sortBy === 'claimId'
            ? [{ claimId: sortOrder }]
            : [{ [sortBy]: sortOrder }, { id: sortOrder }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claim.count({ where }),
    ]);
    // Attach the misspelled words per claim so the dashboard can show WHY the Spell
    // badge is red on hover, without opening the claim. Use each claim's LATEST SPELL
    // result and only if it FAILED — a newer PASS must not inherit an old run's tooltip.
    const spellByClaim = new Map<string, string>();
    // Only FAILED claims get a tooltip, so query results for just those — skips the
    // passed majority (whose summaries we'd discard anyway) and is often empty.
    const failedIds = data.filter((c) => c.spellCheckStatus === 'FAILED').map((c) => c.id);
    if (failedIds.length) {
      const results = await this.prisma.validationResult.findMany({
        where: { claimId: { in: failedIds }, validatorKey: 'SPELL', status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        select: { claimId: true, summary: true },
      });
      const seen = new Set<string>();
      for (const r of results) {
        if (seen.has(r.claimId)) continue; // rows are newest-first → first per claim is latest FAILED
        seen.add(r.claimId);
        if (r.summary) spellByClaim.set(r.claimId, r.summary);
      }
    }
    // Whether each claim has validation work outstanding.
    //
    // The five status columns cannot answer this. They hold their PREVIOUS values until a
    // validator actually starts writing, so a claim queued behind a hundred others looks
    // byte-identical to one nobody touched. That is the whole of "re-validate does nothing":
    // the work was queued correctly and the list had no way to say so, which is also why a
    // list polling on those columns alone stops polling while its own work is still pending.
    //
    // One indexed query per page, on @@index([claimId]), bounded by the page size.
    const claimIds = data.map((c) => c.id);
    const runState = new Map<string, 'QUEUED' | 'RUNNING'>();
    if (claimIds.length) {
      const pending = await this.prisma.validationRun.findMany({
        where: { claimId: { in: claimIds }, status: { in: ['QUEUED', 'RUNNING'] } },
        select: { claimId: true, status: true },
      });
      for (const r of pending) {
        // RUNNING wins: re-queueing a claim mid-run leaves both rows outstanding, and
        // "running" is the more specific truth of the two.
        if (r.status === 'RUNNING' || !runState.has(r.claimId)) {
          runState.set(r.claimId, r.status as 'QUEUED' | 'RUNNING');
        }
      }
    }
    const rows = data.map((c) => ({
      ...c,
      spellSummary: spellByClaim.get(c.id) ?? null,
      validationState: runState.get(c.id) ?? null,
    }));
    return { data: rows, total, page, limit };
  }

  /**
   * Every claim id matching these filters, for "act on all matching" bulk calls. Counts
   * first and returns the count untouched when it exceeds `cap`, so the caller can refuse
   * the whole batch instead of acting on an arbitrary slice of it.
   */
  async idsMatching(filters: ListClaimsFilters, cap: number) {
    const where = this.buildWhere(filters);
    const total = await this.prisma.claim.count({ where });
    if (total > cap) return { ids: [], total };
    const rows = await this.prisma.claim.findMany({
      where,
      select: { id: true },
      // cap + 1, and re-checked below: count and select are two statements, so a claim
      // inserted between them would otherwise slip past the cap the count just cleared.
      // Refusing the batch is the contract; returning an arbitrary cap-sized slice of it
      // is exactly what this method promises never to do. No orderBy — the caller uses
      // this as a set, and sorting it was a filesort for nothing.
      take: cap + 1,
    });
    // Re-count rather than reporting rows.length, which is always exactly cap+1 and made the
    // refusal say "501 claims match" no matter how many really did. The caller puts this
    // number in front of the reviewer as the amount to narrow down to.
    if (rows.length > cap) return { ids: [], total: await this.prisma.claim.count({ where }) };
    return { ids: rows.map((r) => r.id), total };
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
    if (filters.redFlagStatus) where.redFlagStatus = filters.redFlagStatus;
    if (filters.duplicateStatus) where.duplicateStatus = filters.duplicateStatus;
    if (filters.scope && filters.scope !== 'ALL') {
      // Intersect, never overwrite. Overwriting silently discarded a scoped caller's own
      // sub-category filter — harmless while this only fed a list, but bulk MUTATES through
      // the same where: "select all 12 matching" then acted on every claim in their scope.
      // An out-of-scope pick matches nothing rather than falling back to everything.
      const allowed = filters.scope.subCategoryIds;
      where.subCategoryId = filters.subCategoryId
        ? allowed.includes(filters.subCategoryId)
          ? filters.subCategoryId
          : { in: [] }
        : { in: allowed };
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
      spell: collapseValidationStatus(c.spellCheckStatus),
      qr: collapseValidationStatus(c.qrStatus),
      meta: collapseValidationStatus(c.metaExtractionStatus),
      intra: collapseValidationStatus(c.intraClaimStatus),
      full: collapseValidationStatus(c.fullScanStatus),
      redFlag: collapseValidationStatus(c.redFlagStatus),
      duplicate: collapseValidationStatus(c.duplicateStatus),
      qrOutcome: c.qrOutcome ?? '',
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
        redFlagStatus: true,
        duplicateStatus: true,
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
      // The five outcomes travel with the row: `status` collapses them to Forged/OK, and
      // the export needs to say which check produced that verdict.
      checks: {
        spellCheckStatus: c.spellCheckStatus,
        qrStatus: c.qrStatus,
        metaExtractionStatus: c.metaExtractionStatus,
        intraClaimStatus: c.intraClaimStatus,
        fullScanStatus: c.fullScanStatus,
        redFlagStatus: c.redFlagStatus,
        duplicateStatus: c.duplicateStatus,
      },
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
