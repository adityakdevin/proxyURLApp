import {
  metaOutcome,
  qrOutcome,
  intraOutcome,
  completenessOutcome,
  typeInText,
  normalizeText,
  matchesClaimId,
  editDistanceCapped,
  findTermMisspellings,
} from '../logic.js';

describe('validator logic', () => {
  it('metaOutcome', () => {
    expect(metaOutcome(0, 0).status).toBe('PASSED');
    expect(metaOutcome(0, 2).status).toBe('FAILED');
    expect(metaOutcome(1, 2).status).toBe('PASSED');
  });
  it('editDistanceCapped', () => {
    expect(editDistanceCapped('clerk', 'clerk', 2)).toBe(0);
    expect(editDistanceCapped('cleark', 'clerk', 2)).toBe(1); // insertion
    expect(editDistanceCapped('govemment', 'government', 2)).toBe(2);
    expect(editDistanceCapped('madhya', 'clerk', 2)).toBe(3); // capped -> cap+1
    // Damerau: an adjacent transposition is ONE edit, not two.
    expect(editDistanceCapped('nmae', 'name', 1)).toBe(1); // swapped 'ma' -> 'am'
    expect(editDistanceCapped('recieve', 'receive', 1)).toBe(1); // swapped 'ie' -> 'ei'
  });
  it('findTermMisspellings flags expected-term near-misses, not names/real words', () => {
    const real = (w: string) => ['clerk', 'engineer', 'cleaner'].includes(w.toLowerCase());
    const hits = findTermMisspellings(
      ['profesion', 'enginear', 'cleark', 'gaurav', 'madhya', 'cleaner', 'clerk'],
      real
    );
    const tokens = hits.map((h) => h.token).sort();
    expect(tokens).toEqual(['cleark', 'enginear', 'profesion']); // names + real words excluded
  });
  it('findTermMisspellings matches a caller-supplied term list (entity gazetteer)', () => {
    // Proper-noun misspellings the reviewers flag: "Bajaij" for the brand "Bajaj".
    const notReal = () => false;
    const hits = findTermMisspellings(['bajaij', 'lucnow', 'toyota'], notReal, ['bajaj', 'lucknow']);
    expect(hits.map((h) => `${h.token}->${h.term}`).sort()).toEqual([
      'bajaij->bajaj',
      'lucnow->lucknow',
    ]); // 'toyota' is near neither term
  });
  it('qrOutcome', () => {
    expect(qrOutcome(0, 0, []).status).toBe('PASSED');
    expect(qrOutcome(0, 2, []).status).toBe('FAILED');
    expect(qrOutcome(1, 2, ['x']).status).toBe('PASSED');
  });
  it('intraOutcome', () => {
    expect(intraOutcome(0, 0).status).toBe('PASSED');
    expect(intraOutcome(0, 2).status).toBe('FAILED');
    expect(intraOutcome(1, 2).status).toBe('PASSED');
  });
  it('completenessOutcome', () => {
    expect(completenessOutcome([], []).status).toBe('PASSED');
    expect(completenessOutcome(['A'], ['A', 'B']).status).toBe('FAILED');
    expect(completenessOutcome(['A', 'B'], ['A', 'B']).status).toBe('PASSED');
  });
  it('text utils', () => {
    expect(normalizeText('CLM-00001')).toBe('clm00001');
  });
  it('typeInText matches type names in document text, word-bounded, with variants', () => {
    expect(typeInText('Invoice', ['TAX INVOICE No. 123'])).toBe(true);
    expect(typeInText('Bill', ['send to billing address'])).toBe(false);
    expect(typeInText('Driving Licence', ['DRIVING LICENSE NO DL-123'])).toBe(true);
    expect(typeInText('Aadhar Card', ['Aadhaar Card No 1234'])).toBe(true);
    expect(typeInText('Passport', ['no matching words here'])).toBe(false);
    expect(typeInText('PAN Card', [])).toBe(false);
  });

  describe('matchesClaimId', () => {
    it('matches a long claim id loosely (separator/OCR tolerant)', () => {
      expect(matchesClaimId('Ref: CLM 0 0 1 2 3 4 7', 'CLM-0012347')).toBe(true);
      expect(matchesClaimId('claim clm0012347 here', 'CLM-0012347')).toBe(true);
    });
    it('does NOT false-positive a short id inside a longer number', () => {
      // The bug this guards: "001" must not match inside "Invoice 2001".
      expect(matchesClaimId('Invoice 2001 total', '001')).toBe(false);
    });
    it('matches a short id when separator-bounded', () => {
      expect(matchesClaimId('Claim 001 received', '001')).toBe(true);
      expect(matchesClaimId('001', '001')).toBe(true);
    });
    it('returns false for an empty claim id', () => {
      expect(matchesClaimId('anything', '')).toBe(false);
    });
  });
});
