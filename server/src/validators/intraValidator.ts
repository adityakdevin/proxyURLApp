import { Validator, FindingInput } from './types.js';
import { intraOutcome, normalizeText, matchesClaimId, fuzzyClaimIdMatch } from './logic.js';

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
    const misread: FindingInput[] = [];
    for (const [documentId, text] of entries) {
      const name = nameById.get(documentId) ?? 'this document';
      if (matchesClaimId(text, ctx.claim.claimId)) {
        found++;
        continue;
      }
      // Found only through a likely scan misread: present, but the reviewer confirms it.
      // Recorded as a WARNING, which reviewers do not see (Doubtful is hidden, 2026-10-12).
      const seen = fuzzyClaimIdMatch(text, ctx.claim.claimId);
      if (seen) {
        found++;
        misread.push({
          documentId,
          code: 'INTRA_CLAIMID_MISREAD',
          severity: 'WARNING',
          message:
            `Claim ID ${ctx.claim.claimId} found in ${name} only as "${seen}" — ` +
            `likely a scan misread, please confirm visually.`,
          data: { read: seen },
        });
        continue;
      }
      missing.push({
        documentId,
        code: 'INTRA_CLAIMID_MISSING',
        message: `Claim ID ${ctx.claim.claimId} not found in ${name}.`,
      });
    }

    // Cross-document field mismatches moved to the REDFLAG validator (crossDocLogic) —
    // INTRA now only checks Claim-ID presence.
    const outcome = intraOutcome(found, entries.length);
    outcome.findings = outcome.status === 'FAILED' ? missing : misread;
    return outcome;
  },
};
