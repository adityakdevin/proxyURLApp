import { spellValidator } from '../spellValidator.js';
import { metaValidator } from '../metaValidator.js';
import { intraValidator } from '../intraValidator.js';
import { fullValidator } from '../fullValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';
import { extractVins, extractLabeledNames, crossDocMismatches } from '../logic.js';

function baseCtx(over: Partial<ValidatorContext>): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'CLM12345', subCategoryId: 's' },
    documents: [],
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map(),
    ...over,
  };
}

const doc = (id: string, over: Partial<ValidatorDoc> = {}): ValidatorDoc => ({
  id,
  fileName: `${id}.dat`,
  storagePath: '',
  readablePath: '',
  mimeType: null,
  source: 'UPLOADED',
  documentTypeId: null,
  ...over,
});

describe('validation findings — per-document attribution (Phase 1)', () => {
  it('SPELL attributes suspect-word findings to each source document', async () => {
    const ctx = baseCtx({
      shared: new Map([
        ['docA', 'zzzqqq wwwxxx vvvbbb'],
        ['docB', 'lkjhg fdsapo iuyt nnnmmm'],
      ]),
    });
    const out = await spellValidator.run(ctx);
    expect(out.status).toBe('FAILED');
    expect(out.findings?.length).toBeGreaterThan(0);
    const docIds = new Set(out.findings!.map((f) => f.documentId));
    expect(docIds.has('docA')).toBe(true);
    expect(docIds.has('docB')).toBe(true);
    expect(out.findings!.every((f) => f.code === 'SPELL_SUSPECT')).toBe(true);
  });

  it('SPELL anchors a suspect finding to its OCR word box when boxes are present (Phase 2)', async () => {
    const ctx = baseCtx({
      shared: new Map([['docA', 'zzzqqq hello world']]),
      wordBoxes: new Map([
        ['docA', [{ text: 'Zzzqqq', page: 1, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } }]],
      ]),
    });
    const out = await spellValidator.run(ctx);
    expect(out.status).toBe('FAILED');
    const suspect = out.findings!.find((f) => f.data?.word === 'zzzqqq');
    expect(suspect?.page).toBe(1);
    expect(suspect?.bbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.05 });
  });

  it('SPELL leaves bbox null when no word boxes are available (graceful degrade)', async () => {
    const ctx = baseCtx({ shared: new Map([['docA', 'zzzqqq wwwxxx vvvbbb']]) });
    const out = await spellValidator.run(ctx);
    expect(out.status).toBe('FAILED');
    expect(out.findings!.every((f) => (f.bbox ?? null) === null)).toBe(true);
  });

  it('SPELL emits no findings on a pass', async () => {
    const ctx = baseCtx({ shared: new Map([['docA', 'the quick brown fox jumps over the lazy dog']]) });
    const out = await spellValidator.run(ctx);
    expect(out.status).toBe('PASSED');
    expect(out.findings ?? []).toHaveLength(0);
  });

  it('META flags each document with no extractable text', async () => {
    const ctx = baseCtx({ documents: [doc('img1', { mimeType: 'image/png' })] });
    const out = await metaValidator.run(ctx);
    expect(out.status).toBe('FAILED');
    expect(out.findings).toEqual([
      expect.objectContaining({ documentId: 'img1', code: 'META_NO_TEXT' }),
    ]);
  });

  it('INTRA flags documents missing the claim ID', async () => {
    const ctx = baseCtx({
      documents: [doc('d1', { fileName: 'salary.jpg' })],
      shared: new Map([['d1', 'no claim reference in this text at all']]),
    });
    const out = await intraValidator.run(ctx);
    expect(out.status).toBe('FAILED');
    expect(out.findings).toEqual([
      expect.objectContaining({ documentId: 'd1', code: 'INTRA_CLAIMID_MISSING' }),
    ]);
  });

  it('FULL emits claim-level findings (documentId null) for missing required types', async () => {
    const prisma = {
      documentTypeMaster: { findMany: async () => [{ id: 't1', name: 'Invoice' }] },
    } as never;
    const out = await fullValidator.run(baseCtx({ prisma, documents: [] }));
    expect(out.status).toBe('FAILED');
    expect(out.findings).toEqual([
      expect.objectContaining({ documentId: null, code: 'FULL_MISSING_TYPE' }),
    ]);
  });

  it('INTRA flags a cross-document VIN mismatch as ERROR and fails the check (Phase 4)', async () => {
    const vinA = 'MZBFB812LSN538764';
    const vinB = 'MZBB6814MSN022501';
    const ctx = baseCtx({
      documents: [doc('d1', { fileName: 'a.jpg' }), doc('d2', { fileName: 'b.jpg' })],
      shared: new Map([
        ['d1', `Claim CLM12345 VIN ${vinA} customer`],
        ['d2', `Claim CLM12345 VIN ${vinB} customer`],
      ]),
    });
    const out = await intraValidator.run(ctx);
    expect(out.status).toBe('FAILED'); // claim id present in both, but VINs disagree
    const mm = out.findings!.find((f) => f.code === 'INTRA_FIELD_MISMATCH');
    expect(mm).toBeDefined();
    expect(mm!.severity).toBe('ERROR');
    expect(mm!.data).toMatchObject({ field: 'VIN' });
  });
});

describe('intra cross-document field extraction (Phase 4)', () => {
  it('extractVins finds 17-char VIN tokens and dedupes', () => {
    expect(extractVins('vin MZBFB812LSN538764 and again MZBFB812LSN538764')).toEqual([
      'MZBFB812LSN538764',
    ]);
    expect(extractVins('no vin here')).toEqual([]);
  });

  it('extractLabeledNames pulls label-anchored names', () => {
    expect(extractLabeledNames('Customer Name: John Doe\nother line')).toEqual(['john doe']);
  });

  it('crossDocMismatches flags a field that disagrees across documents', () => {
    const mm = crossDocMismatches([
      { documentId: 'd1', text: 'Name: John Doe' },
      { documentId: 'd2', text: 'Name: Jane Roe' },
    ]);
    expect(mm.some((m) => m.field === 'NAME')).toBe(true);
  });

  it('crossDocMismatches is quiet when values agree', () => {
    const mm = crossDocMismatches([
      { documentId: 'd1', text: 'Name: John Doe' },
      { documentId: 'd2', text: 'Name: John Doe' },
    ]);
    expect(mm).toHaveLength(0);
  });
});
