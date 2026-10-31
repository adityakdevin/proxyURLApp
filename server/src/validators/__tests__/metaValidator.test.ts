import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { metaValidator } from '../metaValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

function ctx(documents: ValidatorDoc[], ocrText: string): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents,
    prisma: {} as never,
    ocr: { extractImageText: async () => ocrText },
    shared: new Map(),
    wordBoxes: new Map(),
    pageTexts: new Map(),
  };
}
const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
  id: 'd',
  fileName: 'f.png',
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png',
  source: 'SCANNED',
  documentTypeId: null,
  ...over,
});

describe('metaValidator', () => {
  it('PASSES and stashes text when OCR yields text', async () => {
    const c = ctx([doc({ id: 'd1' })], 'hello world');
    const out = await metaValidator.run(c);
    expect(out.status).toBe('PASSED');
    expect(c.shared.get('d1')).toBe('hello world');
  });
  it('FAILS when documents exist but no text extracted', async () => {
    expect((await metaValidator.run(ctx([doc({ id: 'd1' })], '  '))).status).toBe('FAILED');
  });
  it('PASSES (N/A) when there are no documents', async () => {
    expect((await metaValidator.run(ctx([], ''))).status).toBe('PASSED');
  });
});

/** A one-page PDF; with `content`, the page draws that content stream in Helvetica. */
function onePagePdf(content?: string): Buffer {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    content
      ? '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>'
      : '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
  ];
  if (content) {
    objs.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// pdfjs starts its worker with a dynamic import(), which Jest cannot run
// without --experimental-vm-modules: in-process, every PDF throws and falls through to OCR,
// so these cases could not tell a scan from a text PDF. They run in a plain Node child
// under tsx instead, which loads the server's modules the way the server does.
const META_CHILD = `
const [, file] = process.argv;
const { metaValidator } = await import(process.env.TARGET_URL);
let ocrCalls = 0;
const c = {
  claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
  documents: [{ id: 'd1', fileName: 'f.pdf', storagePath: file, readablePath: file,
    mimeType: 'application/pdf', source: 'SCANNED', documentTypeId: null }],
  prisma: {},
  ocr: {
    extractImageText: async () => '',
    extractPdf: async () => {
      ocrCalls++;
      return { text: 'scanned page text', words: [], pages: [{ page: 1, text: 'scanned page text' }], totalPages: 1 };
    },
  },
  shared: new Map(), wordBoxes: new Map(), pageTexts: new Map(),
};
const out = await metaValidator.run(c);
console.log(JSON.stringify({
  status: out.status,
  ocrCalls,
  text: c.shared.get('d1'),
  words: c.wordBoxes.get('d1')?.length ?? 0,
  pages: out.details?.extracted?.[0]?.properties?.Pages,
}));
`;

const SRC = path.join(__dirname, '..', '..');

function runChild<T>(script: string, target: string, file: string): T {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, file], {
    cwd: path.join(SRC, '..'),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TARGET_URL: pathToFileURL(path.join(SRC, target)).href },
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as T;
}

// Five lines down the page: text in one band only reads as a picture with a caption and is
// sent to OCR as well (pdfExtractor's MIXED_PAGE_COVERAGE).
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const textPdf = () => onePagePdf(`BT /F1 12 Tf 20 180 Td ${WORDS.map((w) => `(${w}) Tj 0 -40 Td`).join(' ')} ET`);

describe('metaValidator on a real PDF', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'meta-pdf-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, pdf: Buffer) => {
    const file = path.join(dir, name);
    writeFileSync(file, pdf);
    return file;
  };
  const runMeta = (name: string, pdf: Buffer) =>
    runChild<{ status: string; ocrCalls: number; text?: string; words: number; pages?: string }>(
      META_CHILD,
      'validators/metaValidator.ts',
      write(name, pdf)
    );

  // Value: protects=a PDF with no text layer is OCR'd and its OCR text stored for the checks; fails_when=extractPdf reports text (whitespace, page markers) for a page with no text layer, so a scan skips OCR; why_new=no test fed metaValidator a real PDF; seam=none; no_claim=OCR quality, rasterizing, JBIG2/JPX scans
  it('OCRs a PDF that has no text layer', () => {
    expect(runMeta('scan.pdf', onePagePdf())).toMatchObject({
      status: 'PASSED',
      ocrCalls: 1,
      text: 'scanned page text',
    });
  });

  // Value: protects=pdfjs 6 reads a text PDF's words, boxes and Info properties with no OCR; fails_when=a pdfjs API change (getDocument options, task.destroy) makes extractPdf or readPdfInfo return nothing; why_new=pdfjs never ran under Jest; seam=none; no_claim=mixed pages, fonts, page cap
  it('reads a text-layer PDF with word boxes and properties, and no OCR', () => {
    const r = runMeta('digital.pdf', textPdf());
    expect(r).toMatchObject({ status: 'PASSED', ocrCalls: 0, text: WORDS.join(' '), pages: '1' });
    expect(r.words).toBe(WORDS.length);
  });
});
