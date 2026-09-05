import { Validator, ValidatorContext, FindingInput } from './types.js';
import { CrossField, extractField } from './crossDocLogic.js';

/**
 * Duplicacy check — the same unique data point appearing on a DIFFERENT claim.
 *
 * Scope is the sub-project (the claim's sub-category), per the reviewers' decision: the
 * fraud this exists to catch is one person's KYC, account or receipt being recycled across
 * claims in the same programme. A match in an unrelated sub-project is not evidence.
 *
 * Values are read off the documents on every run and stored in ClaimFieldValue, so the
 * lookup is an indexed query rather than a re-read of every other claim's paperwork.
 */

/** The "Unique Data Points" the requirement names, with how hard each one counts.
 *
 *  A shared reference number is near-conclusive: two claims quoting one receipt or account
 *  number is not a coincidence. A shared name, birth date or address is NOT — families
 *  share addresses, common names repeat, and a genuine repeat customer is not fraud. Those
 *  are reported for a reviewer's eye and cannot fail a claim on their own.
 */
const DUP_FIELDS: { field: CrossField; hard: boolean }[] = [
  { field: 'ACCOUNT_NO', hard: true },
  { field: 'RECEIPT_NO', hard: true },
  { field: 'APPLICATION_NO', hard: true },
  { field: 'EMP_CODE', hard: true },
  { field: 'VEHICLE_NO', hard: true },
  { field: 'NAME', hard: false },
  { field: 'RELATION_FATHER', hard: false },
  { field: 'DOB', hard: false },
  { field: 'ADDRESS', hard: false },
];

const LABEL: Record<string, string> = {
  ACCOUNT_NO: 'Account number',
  RECEIPT_NO: 'Receipt number',
  APPLICATION_NO: 'Application number',
  EMP_CODE: 'Employee code',
  VEHICLE_NO: 'Vehicle number',
  NAME: 'Name',
  RELATION_FATHER: "Father's name",
  DOB: 'Date of birth',
  ADDRESS: 'Address',
};

/** Match key. Folds the ways the same value gets printed differently, per field kind. */
export function normValue(field: CrossField, v: string): string {
  if (field === 'DOB') {
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(v.trim());
    if (!m) return v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${+m[1]}-${+m[2]}-${y}`;
  }
  if (field === 'ADDRESS' || field === 'NAME' || field === 'RELATION_FATHER') {
    // Word order and punctuation vary between documents; the set of letters does not.
    return v
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join(' ');
  }
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Below this a "value" is too short to be evidence of anything (OCR noise, "NA", "01"). */
const MIN_NORM_LEN = 4;
/** Guard against a pathological document flooding the table. */
const MAX_VALUES_PER_CLAIM = 500;

interface Extracted {
  field: CrossField;
  value: string;
  norm: string;
  documentId: string;
  page: number | null;
}

function extractAll(ctx: ValidatorContext): Extracted[] {
  const out: Extracted[] = [];
  const seen = new Set<string>();
  for (const [documentId, text] of ctx.shared) {
    // Per-page where we have it, so a finding can point at a page the way red flags do.
    const pages = ctx.pageTexts.get(documentId);
    const units: { text: string; page: number | null }[] =
      pages && pages.length > 0
        ? pages.map((t, i) => ({ text: t, page: i + 1 }))
        : [{ text, page: null }];
    for (const unit of units) {
      for (const { field } of DUP_FIELDS) {
        for (const value of extractField(field, unit.text)) {
          const norm = normValue(field, value);
          if (norm.replace(/\s/g, '').length < MIN_NORM_LEN) continue;
          const key = `${field}:${norm}`;
          if (seen.has(key)) continue; // one row per distinct value per claim
          seen.add(key);
          out.push({ field, value, norm, documentId, page: unit.page });
          if (out.length >= MAX_VALUES_PER_CLAIM) return out;
        }
      }
    }
  }
  return out;
}

export const dupValidator: Validator = {
  key: 'DUP',
  column: 'duplicateStatus',
  async run(ctx: ValidatorContext) {
    const mine = extractAll(ctx);

    // Rewrite this claim's index from scratch: a re-run must reflect what the documents say
    // NOW, and leaving stale rows behind would make other claims match a value this claim
    // no longer carries.
    await ctx.prisma.claimFieldValue.deleteMany({ where: { claimId: ctx.claim.id } });
    if (mine.length > 0) {
      await ctx.prisma.claimFieldValue.createMany({
        data: mine.map((m) => ({
          claimId: ctx.claim.id,
          documentId: m.documentId,
          field: m.field,
          value: m.value.slice(0, 255),
          norm: m.norm.slice(0, 255),
          page: m.page,
        })),
      });
    }

    if (mine.length === 0) {
      return { status: 'PASSED' as const, summary: 'No unique data points found to compare.' };
    }

    // One query per field with an IN list — indexed on (field, norm), unlike a giant OR.
    const byField = new Map<CrossField, Extracted[]>();
    for (const m of mine) byField.set(m.field, [...(byField.get(m.field) ?? []), m]);

    const findings: FindingInput[] = [];
    let hardHits = 0;
    for (const [field, items] of byField) {
      const hard = DUP_FIELDS.find((f) => f.field === field)!.hard;
      const rows = await ctx.prisma.claimFieldValue.findMany({
        where: {
          field,
          norm: { in: items.map((i) => i.norm) },
          claimId: { not: ctx.claim.id },
          // Sub-project scope, and never match against a soft-deleted claim.
          claim: { subCategoryId: ctx.claim.subCategoryId, status: 'ACTIVE' },
        },
        select: { norm: true, claim: { select: { claimId: true } } },
        take: 200,
      });
      if (rows.length === 0) continue;
      const others = new Map<string, Set<string>>();
      for (const r of rows) {
        const set = others.get(r.norm) ?? new Set<string>();
        set.add(r.claim.claimId);
        others.set(r.norm, set);
      }
      for (const item of items) {
        const claims = others.get(item.norm);
        if (!claims || claims.size === 0) continue;
        if (hard) hardHits++;
        const list = [...claims].slice(0, 5).join(', ');
        findings.push({
          documentId: item.documentId,
          code: `DUP_${field}`,
          severity: hard ? 'ERROR' : 'WARNING',
          message:
            `${LABEL[field] ?? field} "${item.value}" also appears on claim ` +
            `${list}${claims.size > 5 ? ` and ${claims.size - 5} more` : ''}.`,
          page: item.page,
          data: { field, value: item.value, claims: [...claims].slice(0, 20) },
        });
      }
    }

    if (findings.length === 0) {
      return {
        status: 'PASSED' as const,
        summary: `No duplicates found across ${mine.length} unique data point(s).`,
        findings,
      };
    }
    return {
      // Only a shared reference number fails the claim. A shared name or address is
      // reported and left to the reviewer — deriveCheckStatus turns warning-only into
      // DOUBTFUL rather than a pass.
      status: hardHits > 0 ? ('FAILED' as const) : ('PASSED' as const),
      summary:
        `${findings.length} duplicate data point(s) shared with other claims` +
        `${hardHits > 0 ? `, ${hardHits} of them a reference number` : ''}.`,
      findings,
    };
  },
};
