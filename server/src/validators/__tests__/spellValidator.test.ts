import { spellValidator } from '../spellValidator.js';
import { findTermMisspellings } from '../logic.js';
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
  // What OCR returned for a 613x393 salary slip that DID carry "Dayes" and "Profesion".
  // Finding nothing wrong in noise is not a pass: nothing was checked.
  it('warns (DOUBTFUL, not PASSED) when a document read as noise', async () => {
    const noise =
      '[REE RR RR EE FREESE HE CFE EI J SEE celicidliiiis i: HERR S REE FENRIS ET ENN) ' +
      'EEER CIEREEamsnen lk Eiii: [HEEREEIEEE EI 5232s ||| AERIS Sf Bl? id § ERE H H i. ili';
    const res = await spellValidator.run(ctx(noise));
    const unreadable = (res.findings ?? []).filter((f) => f.code === 'SPELL_UNREADABLE');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].severity).toBe('WARNING');
  });
  it('does not call a readable document unreadable', async () => {
    const slip =
      'LG SOFT INDIA PRIVATE LIMITED Payslip for the month of April Branch Department Grade ' +
      'Designation Total Days Present Earnings Amount Deductions Basic Salary Profession Tax';
    const res = await spellValidator.run(ctx(slip));
    expect((res.findings ?? []).some((f) => f.code === 'SPELL_UNREADABLE')).toBe(false);
  });
  // Master sheet item 13: correctly spelled places must never be flagged, but a misspelled
  // one should be ("Bhopl", "1angalore").
  describe('place names', () => {
    const hits = async (text: string) =>
      ((await spellValidator.run(ctx(text))).findings ?? []).map((f) => (f.data as { word: string }).word);

    it('never flags a correctly spelled place, and never "corrects" one into a form word', async () => {
      expect(await hits('Address: Bhopal, Madhya Pradesh. Branch Pune, Medchal, Bangalore')).toEqual([]);
    });
    it('flags a misspelled place for the reviewer, as doubtful', async () => {
      const res = await spellValidator.run(ctx('Address: Bhopl, Madhya Pradesh 462001, 1angalore'));
      const words = (res.findings ?? []).map((f) => (f.data as { word: string; expected: string }));
      expect(words.map((w) => w.word).sort()).toEqual(['angalore', 'bhopl']);
      expect((res.findings ?? []).every((f) => f.severity === 'WARNING')).toBe(true); // doubtful, never fails alone
    });
  });

  it('FAILS when several expected form terms are misspelled', async () => {
    const forged = 'Employee profesion enginear with retantion of 30 dayes on salary slip';
    expect((await spellValidator.run(ctx(forged))).status).toBe('FAILED');
  });
  it('FAILS on a SINGLE expected-term misspelling (matches human reviewer, threshold 1)', async () => {
    // Reviewers flag a form on one genuine typo; the old threshold of 3 let these pass.
    expect((await spellValidator.run(ctx('Employee salary slip with profesion listed'))).status).toBe('FAILED');
  });
  // Names are SHOWN but never fail a claim. Dropping them outright hid genuine errors
  // ("ignoring all nouns regardless of spelling mistakes"); failing on them reported "Dass"
  // as a misspelling of "days". Doubtful is the tier that does both.
  it('reports a person name as doubtful, and does not fail the claim for it', async () => {
    const doc = 'Insured Name: Rajesh Dass\nEmployee salary slip for the month';
    const res = await spellValidator.run(ctx(doc));
    expect(res.status).toBe('PASSED');
    const dass = (res.findings ?? []).find((f) => f.data?.word === 'dass');
    expect(dass?.code).toBe('SPELL_DOUBTFUL');
    expect(dass?.severity).toBe('WARNING');
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
  it('treats a surname the same however many words the name has', async () => {
    // A word cap here made name LENGTH decide the tier: at three, "Mohammed Abdul Rahman
    // Dass" left "Dass" as a hard failure while a shorter name did not.
    const doc = 'Insured Name: Mohammed Abdul Rahman Dass\nEmployee salary slip';
    const res = await spellValidator.run(ctx(doc));
    expect(res.status).toBe('PASSED');
    expect((res.findings ?? []).find((f) => f.data?.word === 'dass')?.code).toBe('SPELL_DOUBTFUL');
  });
  it('reports a misspelt place name, but never fails a claim on one', async () => {
    // The follow-up ask: 'Bhopl' must be visible, not silently ignored. It only becomes
    // visible once 'bhopal' is a Spell Term; a proper-noun term can never hard-fail, because
    // a forged "Bhopl" and a correctly printed "Bhopal" our scanner misread look identical.
    const hits = findTermMisspellings(['Bhopl'], () => false, ['bhopal']);
    expect(hits).toEqual([{ token: 'bhopl', term: 'bhopal', doubtful: true }]);
  });

  it('still hard-fails a misspelt FORM word, including ones absent from the dictionary', async () => {
    // The proper-noun rule must not demote real vocabulary. 'authorised' is in the shipped
    // list precisely because dictionary-en (US) rejects it.
    const real = (w: string) => w === 'authorized';
    expect(findTermMisspellings(['authorised'], real, ['authorised'])).toEqual([]);
    expect(findTermMisspellings(['authorisd'], real, ['authorised'])[0]).toMatchObject({
      term: 'authorised',
      doubtful: false,
    });
  });

  it('PASSES (N/A) when there is no text', async () => {
    expect((await spellValidator.run(ctx(''))).status).toBe('PASSED');
  });
});
