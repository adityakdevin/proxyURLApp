import {
  metaOutcome,
  spellOutcome,
  qrOutcome,
  intraOutcome,
  completenessOutcome,
  normalizeText,
  tokenizeWords,
  matchesClaimId,
  SPELL_MAX_RATIO,
} from '../logic.js';

describe('validator logic', () => {
  it('metaOutcome', () => {
    expect(metaOutcome(0, 0).status).toBe('PASSED');
    expect(metaOutcome(0, 2).status).toBe('FAILED');
    expect(metaOutcome(1, 2).status).toBe('PASSED');
  });
  it('spellOutcome threshold', () => {
    expect(spellOutcome(0, 0, []).status).toBe('PASSED');
    expect(spellOutcome(1, 100, []).status).toBe('PASSED');
    expect(spellOutcome(30, 100, []).status).toBe('FAILED');
    expect(SPELL_MAX_RATIO).toBe(0.2);
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
    expect(tokenizeWords('The qux cat')).toEqual(['the', 'qux', 'cat']);
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
