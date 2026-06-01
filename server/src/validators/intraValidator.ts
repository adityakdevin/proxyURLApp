import { Validator } from './types.js';
import { intraOutcome, normalizeText, matchesClaimId } from './logic.js';

export const intraValidator: Validator = {
  key: 'INTRA',
  column: 'intraClaimStatus',
  async run(ctx) {
    const target = normalizeText(ctx.claim.claimId);
    const texts = [...ctx.shared.values()];
    if (texts.length === 0 || target.length === 0) return intraOutcome(0, texts.length);
    const found = texts.filter((t) => matchesClaimId(t, ctx.claim.claimId)).length;
    return intraOutcome(found, texts.length);
  },
};
