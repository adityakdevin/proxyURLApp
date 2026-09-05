import { normValue } from '../dupValidator.js';

describe('normValue — the duplicacy match key', () => {
  it('folds the ways one account number gets printed', () => {
    expect(normValue('ACCOUNT_NO', '5012 3456 7890')).toBe(normValue('ACCOUNT_NO', '5012-3456-7890'));
  });

  it('folds date separators and 2-digit years to one birth date', () => {
    expect(normValue('DOB', '05/11/1994')).toBe(normValue('DOB', '5-11-94'));
    expect(normValue('DOB', '05.11.1994')).toBe(normValue('DOB', '05/11/1994'));
  });

  it('does not collapse two different birth dates', () => {
    expect(normValue('DOB', '05/11/1994')).not.toBe(normValue('DOB', '06/11/1994'));
  });

  it('ignores word order and punctuation in a name or address', () => {
    expect(normValue('NAME', 'TRIDEEP HAZARIKA')).toBe(normValue('NAME', 'Hazarika, Trideep'));
    expect(normValue('ADDRESS', 'G.S. Road, Guwahati')).toBe(
      normValue('ADDRESS', 'guwahati  g s road')
    );
  });

  it('keeps genuinely different values apart', () => {
    expect(normValue('NAME', 'TRIDEEP HAZARIKA')).not.toBe(normValue('NAME', 'DIPAK HAZARIKA'));
    expect(normValue('RECEIPT_NO', 'RC-1001')).not.toBe(normValue('RECEIPT_NO', 'RC-1002'));
  });
});
