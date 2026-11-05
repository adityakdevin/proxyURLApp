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

  const H = 'INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number Card\n';
  const runWithSecond = (
    layer: string,
    second: { page: number; text: string; kind: 'IMAGE' | 'UPSCALE' | 'RESCALE' }[],
    match: string,
  ) =>
    dupValidator.run({
      claim: { id: 'c1', claimId: 'THIS-CLAIM', subCategoryId: 's1' },
      documents: [],
      prisma: {
        claimFieldValue: {
          deleteMany: async () => ({}),
          createMany: async () => ({}),
          findMany: async ({ where }: { where: { norm: { in: string[] } } }) =>
            where.norm.in.includes(match) ? [{ norm: match, claim: { claimId: 'OTHER-CLAIM' } }] : [],
        },
      } as never,
      ocr: {} as never,
      shared: new Map([['d1', layer]]),
      pageTexts: new Map([['d1', [layer]]]),
      wordBoxes: new Map(),
      secondReads: new Map([['d1', second]]),
    });

  it('matches an ID number read only from the picture under a text layer', async () => {
    const outcome = await runWithSecond(
      H + 'Signature',
      [{ page: 1, text: H + 'ABCPE1234F', kind: 'IMAGE' }],
      'ABCPE1234F',
    );
    expect(outcome.status).toBe('FAILED');
    const f = outcome.findings!.find((x) => x.code === 'DUP_PAN')!;
    expect(f.page).toBe(1);
    expect(f.severity).toBe('ERROR');
  });

  it('matches a registration number from a certificate re-read', async () => {
    const c0 = 'Birth Certificate\nRegistration of Births and Deaths Act, 1969\nDate of Registration: 01/01/2020';
    const outcome = await runWithSecond(
      c0,
      [{ page: 1, text: 'Birth Certificate\nRegistration No: 4321/2023', kind: 'RESCALE' }],
      normValue('CERT_REG_NO', '4321/2023'),
    );
    expect(outcome.status).toBe('FAILED');
    const f = outcome.findings!.find((x) => x.code === 'DUP_CERT_REG_NO')!;
    expect(f.page).toBe(1);
    expect(f.severity).toBe('ERROR');
  });

  describe('a shared number printed on more than one page', () => {
    const run = (pages: string[], match: string | string[], second: { page: number; text: string; kind: 'IMAGE' | 'UPSCALE' | 'RESCALE' }[] = []) => {
      const rows: { field: string; page: number | null }[] = [];
      return dupValidator
        .run({
          claim: { id: 'c1', claimId: 'THIS-CLAIM', subCategoryId: 's1' },
          documents: [],
          prisma: {
            claimFieldValue: {
              deleteMany: async () => ({}),
              createMany: async ({ data }: { data: typeof rows }) => {
                rows.push(...data);
                return {};
              },
              findMany: async ({ where }: { where: { norm: { in: string[] } } }) =>
                [match].flat()
                  .filter((m) => where.norm.in.includes(m))
                  .map((norm) => ({ norm, claim: { claimId: 'OTHER-CLAIM' } })),
            },
          } as never,
          ocr: {} as never,
          shared: new Map([['d1', pages.join('\n')]]),
          pageTexts: new Map([['d1', pages]]),
          wordBoxes: new Map(),
          secondReads: new Map([['d1', second]]),
        })
        .then((outcome) => ({ outcome, rows }));
    };
    const pagesOf = (outcome: Awaited<ReturnType<typeof run>>['outcome'], code: string) =>
      outcome.findings!.filter((f) => f.code === code).map((f) => f.page);

    const invoice = 'TAX INVOICE\nCustomer PAN: ABCPE1234F';

    // Client feedback, 2026-11: the shared PAN pointed at the invoice alone, so a reviewer
    // opening the PAN card saw nothing on it.
    it('flags a PAN on the card as well as on the invoice', async () => {
      const { outcome } = await run([invoice, H + 'ABCPE1234F'], 'ABCPE1234F');
      expect(pagesOf(outcome, 'DUP_PAN')).toEqual([1, 2]);
    });

    it('flags the card when only a second read found the number there', async () => {
      const { outcome } = await run(
        [invoice, H + 'Signature'],
        'ABCPE1234F',
        [{ page: 2, text: H + 'ABCPE1234F', kind: 'IMAGE' }],
      );
      expect(pagesOf(outcome, 'DUP_PAN')).toEqual([1, 2]);
    });

    it('flags a page once when both reads found the number on it', async () => {
      const { outcome } = await run(
        [H + 'ABCPE1234F'],
        'ABCPE1234F',
        [{ page: 1, text: H + 'ABCPE1234F', kind: 'IMAGE' }],
      );
      expect(pagesOf(outcome, 'DUP_PAN')).toEqual([1]);
    });

    it('counts one data point in the summary, however many pages print it', async () => {
      const { outcome } = await run([invoice, H + 'ABCPE1234F'], 'ABCPE1234F');
      expect(outcome.summary).toMatch(/^1 duplicate data point/);
    });

    it('indexes the value once, so a repeat cannot crowd other values out of the lookup', async () => {
      const { rows } = await run([invoice, H + 'ABCPE1234F'], 'ABCPE1234F');
      expect(rows.filter((r) => r.field === 'PAN')).toHaveLength(1);
    });

    // A run stores only its first findings. A number repeated down a long document must not
    // push another value out: that red flag would vanish, and the partner would never name
    // it, so it would be re-queued on every run.
    it('lists every shared value before any repeat page', async () => {
      const card = H + 'ABCPE1234F';
      const { outcome } = await run([card, card, 'Account No: 5012 3456 7890'], ['ABCPE1234F', '501234567890']);
      expect(outcome.findings!.map((f) => `${f.code}@${f.page}`)).toEqual([
        'DUP_PAN@1',
        'DUP_ACCOUNT_NO@3',
        'DUP_PAN@2',
      ]);
    });

    // A statement prints its account number on every page: one row each would bury the list.
    it('keeps one finding for a number a document repeats on every page', async () => {
      const statement = 'Account No: 5012 3456 7890';
      const { outcome } = await run([statement, statement, statement], '501234567890');
      expect(pagesOf(outcome, 'DUP_ACCOUNT_NO')).toEqual([1]);
    });
  });

  it('takes only ID numbers from a second read', async () => {
    const outcome = await runWithSecond(
      'Statement',
      [{ page: 1, text: 'Account No: 5012 3456 7890', kind: 'UPSCALE' }],
      '501234567890',
    );
    expect(outcome.findings?.some((x) => x.code === 'DUP_ACCOUNT_NO')).toBeFalsy();
  });

  // A policy number is a free-form labelled number, not a checksummed ID: a misread insurer
  // prefix in a picture read would match unrelated claims.
  it('takes no policy number from a second read', async () => {
    const outcome = await runWithSecond(
      'Statement',
      [{ page: 1, text: 'Policy No: 3001/12345678/00/000', kind: 'IMAGE' }],
      normValue('POLICY_NO', '3001/12345678/00/000'),
    );
    expect(outcome.findings?.some((x) => x.code === 'DUP_POLICY_NO')).toBeFalsy();
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

  it('fails a claim whose short marriage registration number appears on another claim', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.field === 'CERT_REG_NO' && where.norm.in.includes('318MARRIAGECERTIFICATE')
            ? [{ norm: '318MARRIAGECERTIFICATE', claim: { claimId: 'MZBEP812LSN100009' } }]
            : [],
      },
    };
    const text = 'MARRIAGE REGISTRATION CERTIFICATE\nRegistration No: 318\nDate of Registration : 18/01/2024';
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
    const f = outcome.findings!.find((x) => x.code === 'DUP_CERT_REG_NO')!;
    expect(f.severity).toBe('ERROR');
    expect(f.message).toBe(
      'Certificate registration number "318 (marriage certificate)" also appears on claim MZBEP812LSN100009.'
    );
  });

  it('fails a claim whose certificate key number appears on another claim', async () => {
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) =>
          where.field === 'KEY_NO' && where.norm.in.includes('K12345678901234567890')
            ? [{ norm: 'K12345678901234567890', claim: { claimId: 'MZBEP812LSN100009' } }]
            : [],
      },
    };
    const text = 'CERTIFICATE OF MARRIAGE\nKey No. K12345678901234567890';
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
    const f = outcome.findings!.find((x) => x.code === 'DUP_KEY_NO')!;
    expect(f.severity).toBe('ERROR');
    expect(f.message).toBe('Certificate key number "K12345678901234567890" also appears on claim MZBEP812LSN100009.');
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
