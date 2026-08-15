import { spellValidator } from '../spellValidator.js';
import { metaValidator } from '../metaValidator.js';
import { intraValidator } from '../intraValidator.js';
import { fullValidator } from '../fullValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

function baseCtx(over: Partial<ValidatorContext>): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'CLM12345', subCategoryId: 's' },
    documents: [],
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map(),
    pageTexts: new Map(),
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

// SPELL flags NEAR-MISSES of the expected form vocabulary, not raw dictionary misses:
// on scanned Indian paperwork a dictionary-miss ratio just tracked OCR quality. So the
// fixtures below are single interior edits of EXPECTED_TERMS ("retantion" ← "retention"),
// which is what a reviewer actually flags. Pure gibberish ("zzzqqq") is near nothing and
// is correctly ignored — it was what these tests used to assert on.
describe('validation findings — per-document attribution (Phase 1)', () => {
  it('SPELL attributes suspect-word findings to each source document', async () => {
    const ctx = baseCtx({
      shared: new Map([
        ['docA', 'retantion profesion'],
        ['docB', 'allowence deducton'],
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
      shared: new Map([['docA', 'retantion hello world']]),
      wordBoxes: new Map([
        ['docA', [{ text: 'Retantion', page: 1, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } }]],
      ]),
    });
    const out = await spellValidator.run(ctx);
    expect(out.status).toBe('FAILED');
    const suspect = out.findings!.find((f) => f.data?.word === 'retantion');
    expect(suspect?.page).toBe(1);
    expect(suspect?.bbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.05 });
  });

  it('SPELL leaves bbox null when no word boxes are available (graceful degrade)', async () => {
    const ctx = baseCtx({ shared: new Map([['docA', 'retantion profesion allowence']]) });
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
});
