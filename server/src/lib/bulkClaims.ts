import {
  ClaimAuditAction,
  ClaimAuditTargeting,
  Prisma,
  PrismaClient,
  Role,
  ValidationStatus,
} from '@prisma/client';
import { ClaimService, ClaimServiceError, ListClaimsFilters } from '../services/claimService.js';

/**
 * How many claims one bulk call may touch. Big enough for a filtered day's work, small
 * enough that "select all matching" on an empty filter cannot queue a validation run for
 * every claim in the database. Over the cap the call is REFUSED, never silently trimmed —
 * a caller who thinks they acted on 900 claims and actually acted on 500 is worse off than
 * one who is told to narrow the filter.
 */
export const BULK_MAX = 500;

// From the Prisma enum, not a hand-copied list: this was the third copy, and a new member
// would have been silently rejected here while the list route accepted it.
const CHECK_STATUSES = new Set<string>(Object.values(ValidationStatus));
export const CHECK_KEYS = [
  'spellCheckStatus',
  'qrStatus',
  'metaExtractionStatus',
  'intraClaimStatus',
  'fullScanStatus',
] as const;

export interface BulkBody {
  ids?: unknown;
  filters?: unknown;
}

/** The caller, as every target-resolution decision needs all three. */
export interface BulkCaller extends Pick<ListClaimsFilters, 'scope' | 'callerId'> {
  role: Role;
}

type Refusal = { status: number; code: string; message: string };

/** The claims a bulk call resolved to, plus HOW it named them. The targeting is carried
 *  through rather than re-derived at the call site: resolveTargets branches on the PRESENCE
 *  of `ids` (never its length), and a second copy of that rule in each route is a second
 *  place for it to drift — an audit row saying "ticked selection" for a filters-aimed
 *  delete is worse than none. */
export interface BulkTarget {
  ids: string[];
  targeting: ClaimAuditTargeting;
  /** The filters the call was aimed with, when it was aimed by filters. */
  filters?: Record<string, unknown>;
}

type TargetResult = (BulkTarget & { error?: undefined }) | { ids?: undefined; error: Refusal };

/** The list filters a bulk call may name, mirrored from the claim list query. Unknown keys
 *  are dropped rather than passed on, so a typo can never widen the set acted on. */
function parseFilters(raw: Record<string, unknown>, caller: BulkCaller): ListClaimsFilters | null {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const { role, ...base } = caller;
  const filters: ListClaimsFilters = {
    ...base,
    subCategoryId: str(raw.subCategoryId),
    workflowStatusId: str(raw.workflowStatusId),
    // A regular USER may not filter by an arbitrary assignee (spec §6.2) — the list and
    // export routes drop it, and this path has to drop it too or it becomes the one way
    // round the rule.
    assignedToUserId: role === 'USER' ? undefined : str(raw.assignedToUserId),
    assignedToMe: raw.assignedToMe === true || raw.assignedToMe === 'true',
    search: str(raw.search),
  };
  const status = str(raw.status);
  if (status) {
    if (status !== 'ACTIVE' && status !== 'INACTIVE') return null;
    filters.status = status;
  }
  for (const key of CHECK_KEYS) {
    const value = str(raw[key]);
    if (!value) continue;
    if (!CHECK_STATUSES.has(value)) return null;
    filters[key] = value as ValidationStatus;
  }
  return filters;
}

/**
 * The claims a bulk action applies to: an explicit selection, or — when the caller ticked
 * "all matching" — every claim the current filters return, resolved server-side so the
 * client never has to page through ids it cannot see anyway.
 */
export async function resolveTargets(
  service: ClaimService,
  body: BulkBody,
  caller: BulkCaller
): Promise<TargetResult> {
  // Branch on the PRESENCE of `ids`, never on its length. An empty selection means "act on
  // nothing"; treating it as "fall through to the filters" turns `{ids: [], filters: {}}` —
  // the natural body for a client that always sends both — into "every claim in scope".
  if (Object.prototype.hasOwnProperty.call(body, 'ids')) {
    if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string')) {
      return {
        error: {
          status: 400,
          code: 'INVALID_TARGETS',
          message: 'ids must be an array of claim ids',
        },
      };
    }
    // Deduplicated BEFORE the cap: 500 copies of one id passed the cap and wrote 500
    // remarks onto a single claim, reported as 500 successes. Lowercased first because the
    // claims table is utf8mb4_unicode_ci — MySQL matches ids case-insensitively, so a
    // case-sensitive Set let the SAME claim through 500 times in 500 spellings. Prisma's
    // uuid() emits lowercase, so this is also the stored form.
    const ids = [...new Set((body.ids as string[]).map((id) => id.toLowerCase()))];
    if (ids.length === 0) {
      return {
        error: { status: 400, code: 'NO_TARGETS', message: 'The selection was empty' },
      };
    }
    if (ids.length > BULK_MAX) {
      return {
        error: {
          status: 422,
          code: 'BULK_TOO_LARGE',
          message: `A bulk action is limited to ${BULK_MAX} claims (${ids.length} selected)`,
        },
      };
    }
    return { ids, targeting: ClaimAuditTargeting.IDS };
  }
  if (!body.filters || typeof body.filters !== 'object') {
    return {
      error: {
        status: 400,
        code: 'NO_TARGETS',
        message: 'Select claims, or send the filters to act on',
      },
    };
  }
  const filters = parseFilters(body.filters as Record<string, unknown>, caller);
  if (!filters) {
    return { error: { status: 400, code: 'INVALID_FILTER', message: 'Unknown filter value' } };
  }
  const { ids: matched, total } = await service.idsMatching(filters, BULK_MAX);
  if (total > BULK_MAX) {
    return {
      error: {
        status: 422,
        code: 'BULK_TOO_LARGE',
        message: `${total} claims match — narrow the filters to ${BULK_MAX} or fewer`,
      },
    };
  }
  return {
    ids: matched,
    targeting: ClaimAuditTargeting.FILTERS,
    filters: body.filters as Record<string, unknown>,
  };
}

export interface BulkReport {
  requested: number;
  succeeded: number;
  failed: { id: string; code: string }[];
}

/** Who ran a claim action, and which one. The route supplies this; runBulk turns it into
 *  the audit row so no bulk endpoint can be added without one. */
export interface ClaimAudit {
  action: ClaimAuditAction;
  userId: string;
  ipAddress?: string;
}

/**
 * Write the audit row for a claim action. Never throws: the claims have ALREADY changed by
 * the time this runs, so a failed insert must not turn a completed delete into a 500 the
 * client will retry — that would delete twice and record neither. It is loud in the log
 * instead, which is the one place a missing row can still be noticed.
 */
export async function recordClaimAudit(
  prisma: PrismaClient,
  audit: ClaimAudit,
  target: BulkTarget,
  report: BulkReport
): Promise<void> {
  try {
    await prisma.claimAuditLog.create({
      data: {
        userId: audit.userId,
        action: audit.action,
        targeting: target.targeting,
        filters: (target.filters as Prisma.InputJsonValue) ?? Prisma.DbNull,
        claimIds: target.ids as Prisma.InputJsonValue,
        failures: report.failed.length
          ? (report.failed as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        requested: report.requested,
        succeeded: report.succeeded,
        failed: report.failed.length,
        ipAddress: audit.ipAddress ?? null,
      },
    });
  } catch (err) {
    console.error(`[claim-audit] failed to record ${audit.action} by ${audit.userId}:`, err);
  }
}

/**
 * Apply a per-claim operation to every target, one at a time, and record what was done.
 * Serial on purpose: each operation runs the SAME permission and status checks the
 * single-claim route runs, and a claim the caller may not touch must fail on its own rather
 * than abort the batch.
 *
 * The audit write lives HERE rather than in each route because the routes are where it
 * would be forgotten: 31 claims were soft-deleted in one call with nothing but a shared
 * updated_at to show for it, and the fix is worth nothing if the fifth bulk action ships
 * without it. Requiring the audit argument makes that a compile error.
 */
export async function runBulk(
  prisma: PrismaClient,
  target: BulkTarget,
  audit: ClaimAudit,
  op: (id: string) => Promise<unknown>
): Promise<BulkReport> {
  const report: BulkReport = { requested: target.ids.length, succeeded: 0, failed: [] };
  for (const id of target.ids) {
    try {
      await op(id);
      report.succeeded++;
    } catch (err) {
      // A ClaimServiceError is a rule saying no, and its code tells the reviewer which one.
      // Anything else is a fault — a dropped connection, a bug — and would otherwise leave
      // no trace at all: the response says "FAILED" and the batch answers 200.
      if (!(err instanceof ClaimServiceError)) {
        console.error(`[bulk] claim ${id} failed:`, err);
      }
      report.failed.push({
        id,
        code: err instanceof ClaimServiceError ? err.code : 'FAILED',
      });
    }
  }
  // Recorded even when everything failed and when the filters matched nothing: a refused or
  // empty attempt is exactly the thing an investigation looks for, and a table that only
  // holds successes cannot answer "did anyone try".
  await recordClaimAudit(prisma, audit, target, report);
  return report;
}
