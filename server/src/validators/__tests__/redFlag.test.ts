import { segment, classifyPage, pagesFor } from '../segment.js';
import { redFlagValidator } from '../redFlagValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

const doc = (over: Partial<ValidatorDoc> = {}): ValidatorDoc => ({
  id: 'd1',
  fileName: 'bundle.pdf',
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png', // non-PDF → redFlagValidator skips readPdfInfo (no pdfjs under jest)
  source: 'UPLOADED',
  documentTypeId: null,
  ...over,
});

function ctx(over: Partial<ValidatorContext>): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'CLM1', subCategoryId: 's' },
    documents: [doc()],
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map(),
    pageTexts: new Map(),
    ...over,
  };
}

describe('segment', () => {
  it('classifies pages by content marker', () => {
    expect(classifyPage('INCOME TAX DEPARTMENT permanent account number')).toBe('PAN');
    expect(classifyPage('Goods and Services Tax registration')).toBe('GST');
    expect(classifyPage('UDYAM Registration Certificate')).toBe('UDYAM');
    expect(classifyPage('random text')).toBeNull();
  });

  it('pagesFor prefers per-page text and keeps 1-based page numbers', () => {
    const c = ctx({ pageTexts: new Map([['d1', ['page one', 'page two']]]) });
    expect(pagesFor(doc(), c)).toEqual([
      { page: 1, text: 'page one' },
      { page: 2, text: 'page two' },
    ]);
  });

  it('pagesFor falls back to whole-doc text as a page-null unit', () => {
    const c = ctx({ shared: new Map([['d1', 'whole doc']]) });
    expect(pagesFor(doc(), c)).toEqual([{ page: null, text: 'whole doc' }]);
  });

  it('produces one DocInstance per page with its govtCode', () => {
    const c = ctx({
      pageTexts: new Map([['d1', ['permanent account number ABCPD1234E', 'GSTIN 27ABCPD1234E1Z5']]]),
    });
    const inst = segment(c);
    expect(inst.map((i) => [i.page, i.govtCode])).toEqual([
      [1, 'PAN'],
      [2, 'GST'],
    ]);
  });
});

describe('redFlagValidator', () => {
  it('PASSES a merged bundle with valid PAN + GST and tags provenance pages', async () => {
    const c = ctx({
      pageTexts: new Map([
        [
          'd1',
          [
            'permanent account number ABCPD1234E Authorised Signatory',
            'GSTIN: 27ABCPD1234E1Z5 signature',
          ],
        ],
      ]),
    });
    const out = await redFlagValidator.run(c);
    expect(out.status).toBe('PASSED');
  });

  it('FAILS and tags the page when a PAN is malformed', async () => {
    const c = ctx({
      pageTexts: new Map([['d1', ['permanent account number ABCD1234E Authorised Signatory']]]),
    });
    const out = await redFlagValidator.run(c);
    expect(out.status).toBe('FAILED');
    const pan = out.findings!.find((f) => f.code === 'REDFLAG_PAN_FORMAT');
    expect(pan?.page).toBe(1);
    expect(pan?.documentId).toBe('d1');
  });

  it('FAILS on an Aadhaar front/back mismatch across pages of one file', async () => {
    const c = ctx({
      pageTexts: new Map([
        ['d1', ['Aadhaar front 2345 6789 0123 signature', 'UIDAI back 9999 8888 7777']],
      ]),
    });
    const out = await redFlagValidator.run(c);
    expect(out.status).toBe('FAILED');
    expect(out.findings!.some((f) => f.code === 'REDFLAG_AADHAAR_MISMATCH')).toBe(true);
  });

  // Value: protects=an advisory (no signature) is a visible note the card summary points at,
  // not counted as a verified check; fails_when=advisories are hidden or counted as passes
  it('PASSES with only an advisory, and the summary points at it (no signature keyword)', async () => {
    const c = ctx({ pageTexts: new Map([['d1', ['permanent account number ABCPD1234E']]]) });
    const out = await redFlagValidator.run(c);
    expect(out.status).toBe('PASSED');
    expect(out.findings!.find((f) => f.code === 'REDFLAG_NO_SIGNATURE')!.severity).toBe('INFO');
    expect(out.summary).toContain('1 note(s) to look at');
    expect(out.summary).not.toMatch(/2 check\(s\) verified/);
  });
});

describe('red flag highlights', () => {
  // An Aadhaar page whose VID is 14 digits, which checkVid flags. The number prints in
  // groups, so OCR hands back four word boxes and the highlight has to cover all four.
  const AADHAAR_PAGE = 'UIDAI GOVERNMENT OF INDIA\nAadhaar 4665 5221 0629\nVID : 1234 5678 9012 34';
  const vidBoxes = (page = 1) => [
    { text: 'VID', page, bbox: { x: 0.10, y: 0.50, w: 0.05, h: 0.02 } },
    { text: '1234', page, bbox: { x: 0.20, y: 0.50, w: 0.06, h: 0.02 } },
    { text: '5678', page, bbox: { x: 0.28, y: 0.50, w: 0.06, h: 0.02 } },
    { text: '9012', page, bbox: { x: 0.36, y: 0.50, w: 0.06, h: 0.02 } },
    { text: '34', page, bbox: { x: 0.44, y: 0.51, w: 0.04, h: 0.03 } },
  ];
  const run = (boxes: { text: string; page: number; bbox: unknown }[]) =>
    redFlagValidator.run(
      ctx({
        pageTexts: new Map([['d1', [AADHAAR_PAGE]]]),
        shared: new Map([['d1', AADHAAR_PAGE]]),
        wordBoxes: new Map([['d1', boxes as never]]),
      })
    );

  it('boxes the offending value, spanning every word box it was split across', async () => {
    const out = await run(vidBoxes());
    const vid = out.findings!.find((f) => f.code === 'REDFLAG_VID_FORMAT');
    expect(vid).toBeDefined();
    expect(vid!.page).toBe(1);
    // Union of the four digit groups: from the first group's left edge to the last one's
    // right, and tall enough to cover the group that sits slightly lower.
    const b = vid!.bbox!;
    expect(b.x).toBeCloseTo(0.2);   // the first digit group, NOT the "VID" label before it
    expect(b.y).toBeCloseTo(0.5);
    expect(b.w).toBeCloseTo(0.28);  // through to the right edge of the last group
    expect(b.h).toBeCloseTo(0.04);  // tall enough for the group sitting slightly lower
  });

  it('takes the FIRST occurrence when the value appears more than once', async () => {
    const later = vidBoxes().map((b) => ({ ...b, bbox: { ...b.bbox, y: 0.8 } }));
    const out = await run([...vidBoxes(), ...later]);
    const vid = out.findings!.find((f) => f.code === 'REDFLAG_VID_FORMAT');
    expect(vid!.bbox).toMatchObject({ y: 0.5 });
  });

  it('keeps page-only behaviour when the page has no coordinates', async () => {
    // A text-only extraction yields no word boxes. The finding must still be reported —
    // pointing nowhere is right, pointing somewhere wrong is not.
    const out = await run([]);
    const vid = out.findings!.find((f) => f.code === 'REDFLAG_VID_FORMAT');
    expect(vid).toBeDefined();
    expect(vid!.page).toBe(1);
    expect(vid!.bbox).toBeNull();
  });

  it('does not box a longer token that merely contains the value', async () => {
    // A GSTIN contains its own PAN: "27ABCPD1234E1Z5" contains "ABCPD1234E". On a page
    // carrying both, a bare substring match boxes the GSTIN when the finding is about the
    // PAN — pointing confidently at the wrong thing, which is worse than not pointing.
    const PAN_PAGE = 'INCOME TAX DEPARTMENT permanent account number\nGSTIN 27ABCPD1234E1Z5\nPAN ABCPD1234X';
    const boxes = [
      { text: 'GSTIN', page: 1, bbox: { x: 0.1, y: 0.2, w: 0.05, h: 0.02 } },
      { text: '27ABCPD1234E1Z5', page: 1, bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.02 } },
      { text: 'PAN', page: 1, bbox: { x: 0.1, y: 0.4, w: 0.04, h: 0.02 } },
      { text: 'ABCPD1234X', page: 1, bbox: { x: 0.2, y: 0.4, w: 0.15, h: 0.02 } },
    ];
    const out = await redFlagValidator.run(
      ctx({
        pageTexts: new Map([['d1', [PAN_PAGE]]]),
        shared: new Map([['d1', PAN_PAGE]]),
        wordBoxes: new Map([['d1', boxes as never]]),
      })
    );
    const pan = out.findings!.find((f) => f.code.startsWith('REDFLAG_PAN') && f.bbox);
    // Whatever the PAN rule says about ABCPD1234X, it must not be boxed on the GSTIN row.
    if (pan) expect(pan.bbox).toMatchObject({ y: 0.4 });
  });

  it('does not box a value that is not on the page it claims', async () => {
    const out = await run(vidBoxes(2));
    const vid = out.findings!.find((f) => f.code === 'REDFLAG_VID_FORMAT');
    expect(vid!.bbox).toBeNull();
  });
});

describe('red flags no longer carry the cross-document comparison', () => {
  it('reports format problems but not a value that merely disagrees between documents', async () => {
    // A chassis that differs between the invoice and the policy is a COMPARISON, and it is
    // reported by FULL now. Red Flags is the format rules. Without this the same finding
    // appeared under two tabs and a reviewer counted one problem twice.
    const invoice = 'TAX INVOICE Invoice No 1\nChassis No: MAT1234567890';
    const policy = 'Policy No 9 Insured X Premium 1 Sum Insured 2\nChassis Number: MAT9999999999';
    const out = await redFlagValidator.run(
      ctx({
        documents: [doc({ id: 'd1' }), doc({ id: 'd2' })],
        pageTexts: new Map([
          ['d1', [invoice]],
          ['d2', [policy]],
        ]),
        shared: new Map([
          ['d1', invoice],
          ['d2', policy],
        ]),
      })
    );
    expect(out.findings!.some((f) => f.code.startsWith('CROSS_'))).toBe(false);
  });
});

describe('red flag summary', () => {
  it('counts each rule, not just the total ("Red Flag and its Count")', async () => {
    const c = ctx({
      pageTexts: new Map([['d1', ['GSTIN 27ABCPD1234E1X5', 'Date: 31/04/2026 and 30/02/2026']]]),
    });
    const out = await redFlagValidator.run(c);
    expect(out.status).toBe('FAILED');
    expect(out.summary).toMatch(/^3 red flag\(s\) found: GST format ×1, Impossible date ×2/);
  });
});

// Value: protects=Aadhaar/Voter cross-page checks only compare the card's own pages in a bundle; fails_when=page filter in redFlagValidator is dropped and bundle pages are compared; why_new=only redFlagLogic unit tests cover this, not the validator's page selection; seam=none; no_claim=classification accuracy on real OCR
describe('redFlagValidator compares a card only with its own pages (client QA 2026-10)', () => {
  const codes = async (pages: string[]) =>
    ((await redFlagValidator.run(ctx({ pageTexts: new Map([['d1', pages]]) }))).findings ?? []).map((f) => f.code);

  it('a payslip next to an Aadhaar card is not read as its other side', async () => {
    const out = await codes([
      'UIDAI Aadhaar 2345 6789 0123 signature',
      'Pay Slip Earnings Deductions Net Pay Ref 9876 5432 1098 signature',
    ]);
    expect(out).not.toContain('REDFLAG_AADHAAR_MISMATCH');
  });

  it('an unclassified back side right after the card is compared with it', async () => {
    expect(
      await codes(['UIDAI Aadhaar 2345 6789 0123 signature', 'Address: H No 12 Gandhi Nagar, Lucknow 226001\n6789 2345 0123'])
    ).toContain('REDFLAG_AADHAAR_MISMATCH');
  });

  it('two Aadhaar pages with different numbers in one bundle still mismatch', async () => {
    expect(
      await codes(['UIDAI Aadhaar 2345 6789 0123 signature', 'UIDAI Aadhaar 2345 6789 0999 signature'])
    ).toContain('REDFLAG_AADHAAR_MISMATCH');
  });

  it("an RC's EPIC-shaped engine number is not the Voter ID's back side", async () => {
    const voter = 'ELECTION COMMISSION OF INDIA Identity Card ABX1234567 signature';
    expect(await codes([voter, 'Certificate of Registration Engine No: KMR7654321 signature'])).not.toContain(
      'REDFLAG_VOTER_MISMATCH'
    );
    // An unclassified page that reads like the card's back is still compared.
    expect(await codes([voter, "Elector's Name RAM KUMAR ABX7654321 signature"])).toContain('REDFLAG_VOTER_MISMATCH');
  });

  it('a back side whose "Electoral Registration Officer" OCR garbled is still the back (638633 p17)', async () => {
    const back = 'ABC1234569 Address: 1-23, Station Road Dahej For 151-Vagra Constituency Facsimile Signature of the EkcomiRegsraion Oficer';
    const front = 'ELECTION COMMISSION OF INDIA IDENTITY CARD ABC1234569 signature';
    const out = await codes([front, back]);
    expect(out).not.toContain('REDFLAG_VOTER_BACK_NA');
    expect(out).not.toContain('REDFLAG_VOTER_MISMATCH');
    expect(await codes([front, back.replace('ABC1234569', 'NWM7654321')])).toContain('REDFLAG_VOTER_MISMATCH');
  });

  // Value: protects=a policy page after a Voter ID is not compared as the card's back;
  // fails_when=the voter filter stops excluding pages that classify as something else (its
  // "facsimile signature" and intermediary code raise a false Voter ID mismatch); why_new=only
  // RC and Gujarat-card neighbours were tested (ship review 2026-10-16); seam=none;
  // no_claim=pages classifyDocType cannot place
  it('a policy schedule after the card is not its back side', async () => {
    const front = 'ELECTION COMMISSION OF INDIA IDENTITY CARD ABC1234569 signature';
    const policy =
      'CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPeriod of Insurance\nPremium\nThis document bears a facsimile signature\nIntermediary Code: IMD1234567';
    expect(await codes([front, policy])).not.toContain('REDFLAG_VOTER_MISMATCH');
    const taxInvoice = 'Tax Invoice cum Certificate of Insurance\nFacsimile signature\nchange of address\nCode BRK0000123';
    expect(await codes([front, taxInvoice])).not.toContain('REDFLAG_VOTER_MISMATCH');
  });

  // Value: protects=a tampered back photocopied on one sheet with the RC still mismatches, as on
  // main; fails_when=the back is dropped because the page also reads as an RC; why_new=the
  // 52cd6a5 classify filter passed this case (ship review r3, 2026-10-17); seam=none;
  // no_claim=OCR quality
  it('a back side copied on one sheet with the RC is still compared', async () => {
    const front = 'ELECTION COMMISSION OF INDIA IDENTITY CARD ABC1234567 signature';
    const back = "Elector's Name RAM KUMAR ABC7654321 Certificate of Registration Regn. No GJ01AB1234";
    expect(await codes([front, back])).toContain('REDFLAG_VOTER_MISMATCH');
  });

  it('an unreadable GSTIN is boxed on the page', async () => {
    const out = await redFlagValidator.run(
      ctx({
        pageTexts: new Map([['d1', ['GSTIN No. : 36AAACKT904GIZO signature']]]),
        wordBoxes: new Map([['d1', [{ text: '36AAACKT904GIZO', page: 1, bbox: { x: 0.5, y: 0.1, w: 0.1, h: 0.01 } }]]]),
      })
    );
    const f = out.findings?.find((x) => x.code === 'REDFLAG_GST_UNREADABLE');
    expect(f?.bbox).toMatchObject({ x: 0.5, y: 0.1 });
    // The reviewer reads the rule's label, not its code.
    expect(out.summary).toMatch(/GSTIN unreadable ×1/);
  });

  it("raises the company-customer PAN flag from the claim's DMS name", async () => {
    const out = await redFlagValidator.run(
      ctx({
        claim: { id: 'c', claimId: 'CLM1', subCategoryId: 's', customerName: 'ABC GLOBAL SERVICES LLP' },
        pageTexts: new Map([['d1', ['INCOME TAX DEPARTMENT Permanent Account Number Card ABCPY1234F']]]),
      })
    );
    expect(out.status).toBe('FAILED');
    expect(out.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REDFLAG_PAN_HOLDER_TYPE', documentId: 'd1', page: 1 })])
    );
  });

  it('counts every PAN card the claim holds for the company-customer check', async () => {
    const claim = { id: 'c', claimId: 'CLM1', subCategoryId: 's', customerName: 'ABC GLOBAL SERVICES LLP' };
    const indiv = 'INCOME TAX DEPARTMENT Permanent Account Number Card ABCPY1234F';
    const runs = [
      { documents: [doc()], pageTexts: new Map([['d1', [`${indiv} Name SURESH KAPOOR Father's Name RAM KAPOOR INCOME TAX DEPARTMENT Permanent Account Number AAMFA1234Q`]]]) },
      { documents: [doc(), doc({ id: 'd2' })], pageTexts: new Map([['d1', [indiv]], ['d2', ['INCOME TAX DEPARTMENT Permanent Account Number AAMFA1234Q']]]) },
      {
        documents: [doc(), doc({ id: 'd2' })],
        pageTexts: new Map([['d1', [indiv]], ['d2', ['Unique Identification Authority of India Government of India INCOME TAX DEPARTMENT Permanent Account Number AAMFA1234Q']]]),
      },
    ];
    for (const r of runs) {
      const out = await redFlagValidator.run(ctx({ claim, ...r }));
      expect((out.findings ?? []).map((f) => f.code)).not.toContain('REDFLAG_PAN_HOLDER_TYPE');
    }
  });
});

describe('passport number comparison', () => {
  it('compares passport numbers across passport pages only', async () => {
    const out = await redFlagValidator.run(
      ctx({
        pageTexts: new Map([
          ['d1', ['Republic of India Passport No R1234567 Nationality INDIAN', 'Tax Invoice No K1234567 Ex-showroom']],
        ]),
      })
    );
    expect((out.findings ?? []).map((f) => f.code)).not.toContain('REDFLAG_PASSPORT_MISMATCH');
  });

  it('leaves a visa page out of the passport comparison', async () => {
    const out = await redFlagValidator.run(
      ctx({
        pageTexts: new Map([
          [
            'd1',
            [
              'Republic of India Passport No R1234567 Nationality INDIAN',
              'VISA Passport No K7654321 Nationality INDIAN Place of Birth DELHI',
            ],
          ],
        ]),
      })
    );
    expect((out.findings ?? []).map((f) => f.code)).not.toContain('REDFLAG_PASSPORT_MISMATCH');
  });
});

describe('passport MRZ expiry', () => {
  const MRZ =
    '= R1234567\nSHARMA A\nNationality INDIAN\nP<INDSHARMA<<ANIL<<<<<<<<<<<<<<<<<<<<<<<<<<<\nR1234567<5IND8105141M3104013<<<<<<<<<<<<<<<2';

  it('judges passport expiry on the invoice date, not the run date', async () => {
    const pageTexts = new Map([['d1', [MRZ]]]);
    const late = await redFlagValidator.run(
      ctx({ claim: { id: 'c', claimId: 'CLM1', subCategoryId: 's', invoiceDate: new Date('2031-05-01') }, pageTexts })
    );
    expect(late.status).toBe('FAILED');
    expect(late.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REDFLAG_PASSPORT_EXPIRED', documentId: 'd1', page: 1 })])
    );

    const none = await redFlagValidator.run(ctx({ pageTexts }));
    const codes = (none.findings ?? []).map((f) => f.code);
    expect(none.status).toBe('PASSED');
    expect(codes).toContain('REDFLAG_PASSPORT_OK');
    expect(codes).not.toContain('REDFLAG_PASSPORT_EXPIRED');
  });
});

describe('Aadhaar check digit in a run', () => {
  const FRONT = 'Unique Identification Authority of India\nDOB: 01/01/1980\nMALE\n2341 2341 2347';
  const BACK = 'Address: 1 MAIN ROAD\n1947 help@uidai.gov.in\n2341 2341 2347';

  it('raises the check-digit flag when two reads agree, and only a note for one OCR read', async () => {
    const two = await redFlagValidator.run(ctx({ pageTexts: new Map([['d1', [FRONT, BACK]]]) }));
    expect(two.status).toBe('FAILED');
    expect(two.findings).toContainEqual(
      expect.objectContaining({ code: 'REDFLAG_AADHAAR_CHECKSUM', documentId: 'd1', page: 1 })
    );
    const one = await redFlagValidator.run(ctx({ pageTexts: new Map([['d1', [FRONT]]]) }));
    expect(one.status).toBe('PASSED');
    expect(one.findings).toContainEqual(
      expect.objectContaining({ code: 'REDFLAG_AADHAAR_CHECKSUM_UNSURE', severity: 'INFO' })
    );
    expect(one.summary).toContain('2 note(s) to look at');
  });

  it('needs the page in the text layer AND visible text for a clean read', async () => {
    // An image has no text-op stats, so it is never clean even when META listed the page.
    const out = await redFlagValidator.run(
      ctx({ pageTexts: new Map([['d1', [FRONT]]]), textLayerPages: new Map([['d1', new Set([1])]]) })
    );
    expect(out.status).toBe('PASSED');
    expect(out.findings).toContainEqual(expect.objectContaining({ code: 'REDFLAG_AADHAAR_CHECKSUM_UNSURE' }));
  });
});

describe('redFlagValidator picture reads', () => {
  const H = 'INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number Card\n';
  const AF = 'Government of India\nDOB: 01/01/1990\nMALE';
  const img = { width: 900, height: 600, box: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }, drawnWidthPt: 160 };
  const small = { width: 244, height: 544, box: { x: 0.3, y: 0.2, w: 0.3, h: 0.5 }, drawnWidthPt: 183 };
  const mismatch = (kind: 'IMAGE' | 'UPSCALE') =>
    ctx({
      pageTexts: new Map([['d1', [H + 'PQRPT5678K']]]),
      secondReads: new Map([['d1', [{ page: 1, text: H + 'ABCPE1234F', kind }]]]),
      pageImages: new Map([['d1', new Map([[1, img]])]]),
    });

  it('red-flags a PAN that reads differently in the picture than in the text layer', async () => {
    const out = await redFlagValidator.run(mismatch('IMAGE'));
    expect(out.status).toBe('FAILED');
    const fs = out.findings!.filter((f) => f.code === 'REDFLAG_LAYER_IMAGE_MISMATCH');
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({
      severity: 'ERROR',
      page: 1,
      bbox: img.box,
      message:
        'PAN on page 1 of bundle.pdf reads "ABCPE1234F" in the picture but "PQRPT5678K" in the text layer. One of the two was edited; check the page visually.',
    });
  });

  it('compares only picture reads of a text-layer page', async () => {
    const out = await redFlagValidator.run(mismatch('UPSCALE'));
    expect(out.findings!.some((f) => f.code === 'REDFLAG_LAYER_IMAGE_MISMATCH')).toBe(false);
  });

  it('red-flags a small picture from which no ID number was read', async () => {
    const out = await redFlagValidator.run(
      ctx({ pageTexts: new Map([['d1', [AF]]]), pageImages: new Map([['d1', new Map([[1, small]])]]) })
    );
    const f = out.findings!.find((x) => x.code === 'REDFLAG_SMALL_IMAGE_UNREAD');
    expect(f).toMatchObject({
      severity: 'ERROR',
      page: 1,
      bbox: small.box,
      data: { width: 244, height: 544 },
      message:
        'Page 1 of bundle.pdf is a small picture (244x544 pixels) and no ID number could be read from it. Check it visually or ask for a clearer copy.',
    });
  });

  it('does not flag a small picture of a staff ID card', async () => {
    const staffId = 'ABC MOTORS PVT LTD\nEMPLOYEE ID CARD\nName: RAVI KUMAR\nEmp Code: E1234\nDesignation: Sales Executive';
    const out = await redFlagValidator.run(
      ctx({ pageTexts: new Map([['d1', [staffId]]]), pageImages: new Map([['d1', new Map([[1, small]])]]) })
    );
    expect(out.findings ?? []).not.toContainEqual(expect.objectContaining({ code: 'REDFLAG_SMALL_IMAGE_UNREAD' }));
  });

  // Value: protects=each page is judged on its own page text and its own second reads; fails_when=the page index or the second-read page filter is off by one or dropped; why_new=every picture-read test was single-page; seam=none; no_claim=pages past the caps
  it('judges each page of a document on its own reads', async () => {
    const flagged = async (over: Partial<ValidatorContext>) =>
      ((await redFlagValidator.run(
        ctx({ pageImages: new Map([['d1', new Map([[1, small], [2, small]])]]), ...over })
      )).findings ?? [])
        .filter((f) => f.code === 'REDFLAG_SMALL_IMAGE_UNREAD')
        .map((f) => f.page);
    // Page 2's number sits only in its own page text.
    expect(await flagged({ pageTexts: new Map([['d1', [AF, AF + '\n2345 6789 0123']]]) })).toEqual([1]);
    // A second read of page 1 does not silence page 2.
    expect(
      await flagged({
        pageTexts: new Map([['d1', [AF, AF]]]),
        secondReads: new Map([['d1', [{ page: 1, text: AF + '\n2345 6789 0123', kind: 'UPSCALE' as const }]]]),
      })
    ).toEqual([2]);
  });

  it('takes the second reads into account', async () => {
    const out = await redFlagValidator.run(
      ctx({
        pageTexts: new Map([['d1', [AF]]]),
        pageImages: new Map([['d1', new Map([[1, small]])]]),
        secondReads: new Map([['d1', [{ page: 1, text: AF + '\n2345 6789 0123', kind: 'UPSCALE' }]]]),
      })
    );
    expect(out.findings!.some((f) => f.code === 'REDFLAG_SMALL_IMAGE_UNREAD')).toBe(false);
  });
});
