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

describe('dupValidator — Duplicacy sheet numbers', () => {
  // The client's cases 9 and 10: MZBEP812LSN709538 and MZBEP812LSN709192 carry the same
  // policy number, 251589936500. That must fail the duplicate check, not pass it.
  it('fails a claim whose policy number appears on another claim', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.field === 'POLICY_NO' && where.norm.in.includes('251589936500')
            ? [{ norm: '251589936500', claim: { claimId: 'MZBEP812LSN709192' } }]
            : [],
      },
    };
    const text = 'CERTIFICATE OF INSURANCE\nPolicy No.\n251589936500\nPrevious TP Policy No. : NA';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: 'MZBEP812LSN709538', subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(outcome.status).toBe('FAILED');
    const f = outcome.findings!.find((x) => x.code === 'DUP_POLICY_NO')!;
    expect(f.severity).toBe('ERROR');
    expect(f.message).toBe('Policy number "251589936500" also appears on claim MZBEP812LSN709192.');
  });

  // Duplicacy sheet: "If Address is Same in 2 different Case Ids, then Redflag".
  it('fails a claim whose address appears on another claim', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.field === 'ADDRESS'
            ? where.norm.in.map((norm) => ({ norm, claim: { claimId: 'OTHER-1' } }))
            : [],
      },
    };
    const text = 'Address: VILLAGE BIJAURI, DISTRICT JABALPUR, PIN 482003';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: 'CLM-1', subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.findings!.find((x) => x.code === 'DUP_ADDRESS')!.severity).toBe('ERROR');
  });
});
