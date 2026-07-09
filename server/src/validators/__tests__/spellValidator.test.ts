import { spellValidator } from '../spellValidator.js';
import { ValidatorContext } from '../types.js';

function ctx(text: string): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents: [],
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(text ? [['d1', text]] : []),
    wordBoxes: new Map(),
  };
}

describe('spellValidator', () => {
  it('PASSES clean English text (no expected-term misspellings)', async () => {
    expect((await spellValidator.run(ctx('the quick brown fox jumps over the lazy dog'))).status).toBe('PASSED');
  });
  it('PASSES gibberish/names that are near no expected term', async () => {
    // Random OCR garbage and personal/place names are not near any form vocabulary.
    expect((await spellValidator.run(ctx('zzzqqq wwwxxx gaurav madhya taluka jaiswal'))).status).toBe('PASSED');
  });
  it('FAILS when several expected form terms are misspelled', async () => {
    const forged = 'Employee profesion enginear with retantion of 30 dayes on salary slip';
    expect((await spellValidator.run(ctx(forged))).status).toBe('FAILED');
  });
  it('PASSES a single stray misspelling (tolerates one OCR glitch)', async () => {
    expect((await spellValidator.run(ctx('Employee salary slip with profesion listed'))).status).toBe('PASSED');
  });
  it('PASSES (N/A) when there is no text', async () => {
    expect((await spellValidator.run(ctx(''))).status).toBe('PASSED');
  });
});
