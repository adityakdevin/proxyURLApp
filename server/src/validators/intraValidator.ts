import { Validator, FindingInput } from './types.js';
import { intraOutcome, normalizeText, matchesClaimId } from './logic.js';

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

    // Cross-document field mismatches moved to the REDFLAG validator (crossDocLogic) —
    // INTRA now only checks Claim-ID presence.
    const outcome = intraOutcome(found, entries.length);
    if (outcome.status === 'FAILED') outcome.findings = missing;
    return outcome;
  },
};
