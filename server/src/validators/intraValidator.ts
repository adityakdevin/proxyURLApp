import { Validator, FindingInput, WordBox } from './types.js';
import { intraOutcome, normalizeText, matchesClaimId, crossDocMismatches } from './logic.js';

/** Best-effort: find the word box for a field value (by its first token) to anchor a highlight. */
function findValueBox(boxes: WordBox[] | undefined, value: string): WordBox | undefined {
  if (!boxes || boxes.length === 0) return undefined;
  const first = normalizeText(value.split(/\s+/)[0] ?? '');
  if (!first) return undefined;
  return boxes.find((b) => normalizeText(b.text) === first);
}

export const intraValidator: Validator = {
  key: 'INTRA',
  column: 'intraClaimStatus',
  async run(ctx) {
    const target = normalizeText(ctx.claim.claimId);
    const entries = [...ctx.shared.entries()]; // [documentId, text]
    if (entries.length === 0 || target.length === 0) return intraOutcome(0, entries.length);

    const nameById = new Map(ctx.documents.map((d) => [d.id, d.fileName]));
    let found = 0;
    const missing: FindingInput[] = [];
    for (const [documentId, text] of entries) {
      if (matchesClaimId(text, ctx.claim.claimId)) {
        found++;
      } else {
        missing.push({
          documentId,
          code: 'INTRA_CLAIMID_MISSING',
          message: `Claim ID ${ctx.claim.claimId} not found in ${nameById.get(documentId) ?? 'this document'}.`,
        });
      }
    }

    const outcome = intraOutcome(found, entries.length);
    const findings: FindingInput[] = [];
    if (outcome.status === 'FAILED') findings.push(...missing);

    // Cross-document field mismatches (VIN / customer name) — a pasted-details fraud signal.
    const mismatches = crossDocMismatches(entries.map(([documentId, text]) => ({ documentId, text })));
    for (const mm of mismatches) {
      const expected = mm.values[0].value;
      for (const v of mm.values) {
        if (v.value === expected) continue;
        const box = findValueBox(ctx.wordBoxes.get(v.documentId), v.value);
        findings.push({
          documentId: v.documentId,
          code: 'INTRA_FIELD_MISMATCH',
          severity: 'ERROR',
          message: `${mm.field} "${v.value}" does not match "${expected}" found elsewhere in this claim.`,
          page: box?.page ?? null,
          bbox: box?.bbox ?? null,
          data: { field: mm.field, expected, actual: v.value },
        });
      }
    }
    if (mismatches.length > 0) {
      outcome.status = 'FAILED';
      outcome.summary = `${outcome.summary} ${mismatches.length} cross-document field mismatch(es).`.trim();
    }

    if (findings.length > 0) outcome.findings = findings;
    return outcome;
  },
};
