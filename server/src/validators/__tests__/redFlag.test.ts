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

  it('PASSES with only advisory warnings (no signature keyword)', async () => {
    const c = ctx({ pageTexts: new Map([['d1', ['permanent account number ABCPD1234E']]]) });
    const out = await redFlagValidator.run(c);
    expect(out.status).toBe('PASSED');
    expect(out.findings!.some((f) => f.code === 'REDFLAG_NO_SIGNATURE')).toBe(true);
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

  it('does not box a value that is not on the page it claims', async () => {
    const out = await run(vidBoxes(2));
    const vid = out.findings!.find((f) => f.code === 'REDFLAG_VID_FORMAT');
    expect(vid!.bbox).toBeNull();
  });
});
