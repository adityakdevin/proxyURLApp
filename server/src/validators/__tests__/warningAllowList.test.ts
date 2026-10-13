import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Value: protects=no fraud signal silently becomes invisible; fails_when=a validator emits a
// new WARNING (hidden from reviewers, and a check whose findings are all warnings PASSES);
// why_new=three red-flag advisories and unclassified-page mismatches went dark that way
// (review, 2026-10-13); seam=source scan; no_claim=which codes each file emits
//
// Each entry was decided: a WARNING is only for a reading the reviewer must NOT be shown —
// a spelling hit explained by a scan misread, a soft duplicate field, a claim ID found only
// as a misread (the serial still matches), META's OCR-stage notes, and loose address matches.
// Anything a reviewer should see is ERROR (red flag) or INFO (note). Changing this list is a
// product decision, not a test fix.
const ALLOWED: Record<string, number> = {
  'spellValidator.ts': 1, // SPELL_DOUBTFUL
  'dupValidator.ts': 1, // soft DUP_* fields
  'intraValidator.ts': 1, // INTRA_CLAIMID_MISREAD
  'metaValidator.ts': 3, // OCR-stage notes; META is hidden
  'crossDocLogic.ts': 1, // CROSS_ADDRESS_MISMATCH
};

describe('hidden WARNING findings are an allow-list', () => {
  it('only the decided validators emit WARNING', () => {
    const dir = join(__dirname, '..');
    const found: Record<string, number> = {};
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const n = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => /severity:[^,\n]*'WARNING'/.test(l) && !l.includes('|')).length;
      if (n > 0) found[file] = n;
    }
    expect(found).toEqual(ALLOWED);
  });
});
