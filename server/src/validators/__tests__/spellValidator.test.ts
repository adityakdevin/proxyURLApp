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
    pageTexts: new Map(),
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
  it('FAILS on a SINGLE expected-term misspelling (matches human reviewer, threshold 1)', async () => {
    // Reviewers flag a form on one genuine typo; the old threshold of 3 let these pass.
    expect((await spellValidator.run(ctx('Employee salary slip with profesion listed'))).status).toBe('FAILED');
  });
  // 2026-09-03 reviewer sheet: "Name or Surname spelling not to be highlighted unless
  // different in intra document". A surname is in no dictionary, so it lands one edit from
  // an expected term by coincidence — "Dass" was reported as a misspelling of "days".
  it('never reports a person name as a misspelling', async () => {
    const doc = 'Insured Name: Rajesh Dass\nEmployee salary slip for the month';
    const res = await spellValidator.run(ctx(doc));
    expect(res.status).toBe('PASSED');
    expect((res.findings ?? []).map((f) => f.data?.word)).not.toContain('dass');
  });
  it('still flags a misspelled form word on a document that carries a name', async () => {
    // Suppression is by exact token, so the name shields itself and nothing else.
    const doc = 'Insured Name: Rajesh Dass\nEmployee profesion listed on the salary slip';
    expect((await spellValidator.run(ctx(doc))).status).toBe('FAILED');
  });
  it('does not let a name capture that ran into the next field silence a misspelling', async () => {
    // OCR puts two fields on one line, so the name capture runs to the next colon and
    // returns "Rajesh Dass profesion". Unbounded, "profesion" joined the suppression set
    // and the real misspelling went unreported.
    const doc = 'Employee Name: Rajesh Dass profesion: Engineer on the salary slip';
    expect((await spellValidator.run(ctx(doc))).status).toBe('FAILED');
  });
  it('PASSES (N/A) when there is no text', async () => {
    expect((await spellValidator.run(ctx(''))).status).toBe('PASSED');
  });
});
