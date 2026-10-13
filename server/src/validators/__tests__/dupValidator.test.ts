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
  // The client's cases 9 and 10: two claims carry the same
  // policy number. That must fail the duplicate check, not pass it.
  it('fails a claim whose policy number appears on another claim', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.field === 'POLICY_NO' && where.norm.in.includes('300112345678')
            ? [{ norm: '300112345678', claim: { claimId: 'MZBEP812LSN100009' } }]
            : [],
      },
    };
    const text = 'CERTIFICATE OF INSURANCE\nPolicy No.\n300112345678\nPrevious TP Policy No. : NA';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: 'MZBEP812LSN100008', subCategoryId: 's1' },
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
    expect(f.message).toBe('Policy number "300112345678" also appears on claim MZBEP812LSN100009.');
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
    expect(outcome.summary).toContain('all red flags');
  });

  // Client QA 2026-10, #18: a policy's wrapped town line matched unrelated claims.
  it('does not treat a bare town, state and PIN as a shared address', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.norm.in.map((norm) => ({ norm, claim: { claimId: 'OTHER-1' } })),
      },
    };
    const text = 'Address: HANUMANGARH , RAJASTHAN-335512\nAddress: RAJAHMUNDRY, EAST GODAVARI, ANDHRA PRADESH';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: 'CLM-1', subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(outcome.findings?.find((x) => x.code === 'DUP_ADDRESS')).toBeUndefined();
  });

  // Security review: a long village address with no PIN is a home, not a town line.
  it('still compares a long address that carries no number', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.field === 'ADDRESS' ? where.norm.in.map((norm) => ({ norm, claim: { claimId: 'OTHER-1' } })) : [],
      },
    };
    const text = 'Address: VILL RAMPUR POST KHAMARIA TEHSIL SIHORA DISTT JABALPUR';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: 'CLM-1', subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(outcome.findings?.find((x) => x.code === 'DUP_ADDRESS')?.severity).toBe('ERROR');
  });
});

// Value: protects=a shared name/DOB (WARNING) neither fails DUP nor is counted in its summary; fails_when=summary/status count WARNINGs again (pre-2026-10 behaviour); why_new=no name/DOB-only dup case existed; seam=none; no_claim=does not check UI hiding
describe('dupValidator soft (name / birth date) matches', () => {
  const run = (text: string, hardFields: string[]) =>
    dupValidator.run({
      claim: { id: 'c1', claimId: 'CLM-1', subCategoryId: 's1' },
      documents: [],
      prisma: {
        claimFieldValue: {
          deleteMany: async () => ({}),
          createMany: async () => ({}),
          findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
            ['NAME', 'DOB', ...hardFields].includes(where.field)
              ? where.norm.in.map((norm) => ({ norm, claim: { claimId: 'OTHER-1' } }))
              : [],
        },
      } as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });

  it('passes, with the no-duplicates summary, when only a name and birth date are shared', async () => {
    const out = await run('Customer Name: RAM KUMAR\nDate of Birth: 01/01/1990', []);
    expect(out.findings?.some((f) => f.severity === 'WARNING')).toBe(true);
    expect(out.findings?.some((f) => f.severity === 'ERROR')).toBe(false);
    expect(out.status).toBe('PASSED');
    expect(out.summary).toMatch(/^No duplicates found/);
  });

  it('counts only the hard data points when both kinds are shared', async () => {
    const out = await run(
      'Customer Name: RAM KUMAR\nDate of Birth: 01/01/1990\nAddress: 12 MG ROAD, SECTOR 4, BHOPAL 462001',
      ['ADDRESS']
    );
    const hard = out.findings!.filter((f) => f.severity === 'ERROR').length;
    expect(hard).toBe(1);
    expect(out.findings!.length).toBeGreaterThan(hard);
    expect(out.status).toBe('FAILED');
    expect(out.summary).toBe('1 duplicate data point(s) shared with other claims, all red flags.');
  });
});
