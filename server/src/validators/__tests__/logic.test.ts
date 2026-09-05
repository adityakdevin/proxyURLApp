import {
  metaOutcome,
  qrOutcome,
  intraOutcome,
  completenessOutcome,
  typeInText,
  typePresent,
  normalizeText,
  matchesClaimId,
  editDistanceCapped,
  findTermMisspellings,
  pluralStems,
  ocrFold,
  ocrIndistinguishable,
  deriveCheckStatus,
} from '../logic.js';

describe('validator logic', () => {
  it('deriveCheckStatus downgrades a warning-only pass to DOUBTFUL', () => {
    const warn = [{ code: 'SPELL_DOUBTFUL', severity: 'WARNING' as const, message: 'm' }];
    const err = [{ code: 'SPELL_SUSPECT', severity: 'ERROR' as const, message: 'm' }];
    const info = [{ code: 'X', severity: 'INFO' as const, message: 'm' }];
    expect(deriveCheckStatus('PASSED', warn)).toBe('DOUBTFUL');
    expect(deriveCheckStatus('PASSED', [...warn, ...err])).toBe('DOUBTFUL'); // status wins, not severity
    expect(deriveCheckStatus('PASSED', info)).toBe('PASSED');
    expect(deriveCheckStatus('PASSED', [])).toBe('PASSED');
    expect(deriveCheckStatus('PASSED', undefined)).toBe('PASSED');
    // A real failure is never softened, whatever its findings look like.
    expect(deriveCheckStatus('FAILED', warn)).toBe('FAILED');
    expect(deriveCheckStatus('FAILED', undefined)).toBe('FAILED');
  });

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
  // Client UAT: six claims reported "wrong identified as spelling of X is wrong" where the
  // word is printed correctly and the scanner misread one glyph. Those become DOUBTFUL
  // (shown + highlighted, never failing the check); genuine typos stay confident.
  it('marks glyph-confusable near-misses as doubtful, real typos as confident', () => {
    const notReal = () => false;
    const flag = (token: string, term: string) =>
      findTermMisspellings([token], notReal, [term])[0];

    // Scanner-explainable: rn/m, c/e, i/l glyph pairs.
    expect(flag('novernber', 'november').doubtful).toBe(true);
    expect(flag('manaqer', 'manager').doubtful).toBe(true);
    // A leading m→rn misread ("rnanager") used to be dropped outright by the first-letter
    // rule. It is now reported as DOUBTFUL instead — the same rule made a real leading-letter
    // error ("Oesignation") uncatchable, so edge hits surface for the reviewer but still
    // cannot fail a claim.
    expect(flag('rnanager', 'manager').doubtful).toBe(true);
    expect(flag('cierk', 'clerk').doubtful).toBe(true);
    expect(flag('englneer', 'engineer').doubtful).toBe(true);
    expect(flag('nincty', 'ninety').doubtful).toBe(true);

    // Genuine misspellings the reviewers DO want flagged — a↔e is never folded away.
    expect(flag('quartarly', 'quarterly').doubtful).toBe(false);
    expect(flag('retantion', 'retention').doubtful).toBe(false);
    expect(flag('profesion', 'profession').doubtful).toBe(false); // dropped char, not a glyph swap
  });

  it('ocrFold leaves a/e distinct so real typos survive', () => {
    expect(ocrIndistinguishable('november', 'novernber')).toBe(true);
    expect(ocrIndistinguishable('retention', 'retantion')).toBe(false);
    expect(ocrFold('clerk')).toBe(ocrFold('cierk'));
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
  it('typePresent uses distinctive govt markers, not bare name phrases', () => {
    // Policy boilerplate mentions "driving license" — must NOT count as a DL.
    const policy = ['provided that the person driving holds an effective driving license'];
    expect(typePresent('Driving Licence', 'DL', policy)).toBe(false);
    expect(typePresent('Driving Licence', 'DL', ['INDIAN UNION DRIVING LICENCE DL No UK07 LMV'])).toBe(true);
    // Aadhaar cards never print "Aadhar Card" in English — uidai/gov markers do.
    expect(typePresent('Aadhar Card', 'AADHAR', ['help@uidai.gov.in www.uidai.gov.in'])).toBe(true);
    expect(typePresent('Aadhar Card', 'AADHAR', policy)).toBe(false);
    // Blurry OCR drops spaces on the PAN card header.
    expect(typePresent('PAN Card', 'PAN', ['INCOMETAX DEPARTMENT GOVT. OF INDIA'])).toBe(true);
    // Custom types fall back to the name-phrase match.
    expect(typePresent('Invoice', null, ['TAX INVOICE No. 1'])).toBe(true);
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

describe('pluralStems', () => {
  it('strips a regular plural', () => {
    expect(pluralStems('dealers')).toContain('dealer');
  });
  it('handles -ies and -es', () => {
    expect(pluralStems('policies')).toContain('policy');
    expect(pluralStems('boxes')).toContain('box');
  });
  it('leaves a word that merely ends in double-s alone', () => {
    expect(pluralStems('class')).toEqual([]);
  });
});

describe('findTermMisspellings — plurals are not misspellings', () => {
  // "maruti" is a Spell Term; the dictionary knows neither it nor its plural.
  const dictionaryless = () => false;

  it('does not report the plural of a term as a misspelling of it', () => {
    expect(findTermMisspellings(['marutis'], dictionaryless, ['maruti'])).toEqual([]);
  });

  it('still reports a genuine misspelling of the same term', () => {
    const [hit] = findTermMisspellings(['maruthi'], dictionaryless, ['maruti']);
    expect(hit.term).toBe('maruti');
  });
});
