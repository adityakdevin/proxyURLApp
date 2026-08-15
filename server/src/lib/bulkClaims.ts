import { ValidationStatus } from '@prisma/client';
import { ClaimService, ClaimServiceError, ListClaimsFilters } from '../services/claimService.js';

/**
 * How many claims one bulk call may touch. Big enough for a filtered day's work, small
 * enough that "select all matching" on an empty filter cannot queue a validation run for
 * every claim in the database. Over the cap the call is REFUSED, never silently trimmed —
 * a caller who thinks they acted on 900 claims and actually acted on 500 is worse off than
 * one who is told to narrow the filter.
 */
export const BULK_MAX = 500;

const CHECK_STATUSES = new Set([
  'PENDING',
  'IN_PROGRESS',
  'PASSED',
  'DOUBTFUL',
  'FAILED',
  'DOCS_NOT_AVAILABLE',
]);
const CHECK_KEYS = [
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

type Refusal = { status: number; code: string; message: string };
type TargetResult = { ids: string[]; error?: undefined } | { ids?: undefined; error: Refusal };

/** The list filters a bulk call may name, mirrored from the claim list query. Unknown keys
 *  are dropped rather than passed on, so a typo can never widen the set acted on. */
function parseFilters(
  raw: Record<string, unknown>,
  base: Pick<ListClaimsFilters, 'scope' | 'callerId'>
): ListClaimsFilters | null {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const filters: ListClaimsFilters = {
    ...base,
    subCategoryId: str(raw.subCategoryId),
    workflowStatusId: str(raw.workflowStatusId),
    assignedToUserId: str(raw.assignedToUserId),
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
  base: Pick<ListClaimsFilters, 'scope' | 'callerId'>
): Promise<TargetResult> {
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length) {
    if (ids.length > BULK_MAX) {
      return {
        error: {
          status: 422,
          code: 'BULK_TOO_LARGE',
          message: `A bulk action is limited to ${BULK_MAX} claims (${ids.length} selected)`,
        },
      };
    }
    return { ids };
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
  const filters = parseFilters(body.filters as Record<string, unknown>, base);
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
  return { ids: matched };
}

export interface BulkReport {
  requested: number;
  succeeded: number;
  failed: { id: string; code: string }[];
}

/**
 * Apply a per-claim operation to every target, one at a time. Serial on purpose: each
 * operation runs the SAME permission and status checks the single-claim route runs, and a
 * claim the caller may not touch must fail on its own rather than abort the batch.
 */
export async function runBulk(
  ids: string[],
  op: (id: string) => Promise<unknown>
): Promise<BulkReport> {
  const report: BulkReport = { requested: ids.length, succeeded: 0, failed: [] };
  for (const id of ids) {
    try {
      await op(id);
      report.succeeded++;
    } catch (err) {
      report.failed.push({
        id,
        code: err instanceof ClaimServiceError ? err.code : 'FAILED',
      });
    }
  }
  return report;
}
