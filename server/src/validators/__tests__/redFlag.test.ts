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
