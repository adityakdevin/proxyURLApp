import { dupValidator, normValue } from '../dupValidator.js';

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

describe('dupValidator findings', () => {
  const box = (text: string, x: number) => ({ text, page: 1, bbox: { x, y: 0.5, w: 0.05, h: 0.02 } });

  it('boxes the shared value so the finding row can zoom to it', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { norm: { in: string[] } } }) =>
          where.norm.in.includes('501234567890')
            ? [{ norm: '501234567890', claim: { claimId: 'OTHER-CLAIM' } }]
            : [],
      },
    };
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: 'THIS-CLAIM', subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', 'Account No: 5012 3456 7890']]),
      pageTexts: new Map([['d1', ['Account No: 5012 3456 7890']]]),
      wordBoxes: new Map([
        ['d1', [box('Account', 0.1), box('No:', 0.2), box('5012', 0.3), box('3456', 0.4), box('7890', 0.5)]],
      ]),
    });
    const f = outcome.findings!.find((x) => x.code === 'DUP_ACCOUNT_NO')!;
    expect(f.page).toBe(1);
    // Around the number only — not the "Account No:" label beside it.
    expect(f.bbox).toEqual({ x: 0.3, y: 0.5, w: expect.closeTo(0.25, 5), h: expect.closeTo(0.02, 5) });
  });
});
