import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { metaValidator } from '../metaValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';
import { imagePdf, imagePdfPages } from '../../__tests__/helpers/imagePdf.js';

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
  it('reports a document that ran out of time as unread, not as empty', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let started!: () => void;
      const ocrStarted = new Promise<void>((r) => (started = r));
      const c = ctx([doc({ id: 'd1', fileName: 'slow.png' })], '');
      c.ocr = {
        extractImageText: () => {
          started();
          return new Promise<string>(() => {});
        },
      };
      const run = metaValidator.run(c);
      await ocrStarted;
      await jest.advanceTimersByTimeAsync(30_000);
      const codes = ((await run).findings ?? []).map((f) => f.code);
      expect(codes).toContain('META_EXTRACT_TIMEOUT');
      expect(codes).not.toContain('META_NO_TEXT');
      expect(c.unreadPages?.get('d1')).toBe('all');
    } finally {
      jest.useRealTimers();
    }
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
let onlyPages, deadlineLeft;
const c = {
  claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
  documents: [{ id: 'd1', fileName: 'f.pdf', storagePath: file, readablePath: file,
    mimeType: 'application/pdf', source: 'SCANNED', documentTypeId: null }],
  prisma: {},
  ocr: {
    extractImageText: async () => '',
    extractPdf: async (_path, only, opts) => {
      ocrCalls++;
      onlyPages = only;
      // The OCR deadline runs on performance.now, the clock of META's own timeout.
      deadlineLeft = opts?.deadline - performance.now();
      if (process.env.NO_FIRST_LOOK) {
        return { text: '', words: [], pages: [], totalPages: 2, unreadPages: [2] };
      }
      if (process.env.UNREAD) {
        return { text: 'RC page text', words: [], pages: [{ page: 1, text: 'RC page text' }], totalPages: 3, unreadPages: [2, 3] };
      }
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
  onlyPages,
  deadlineLeft,
  unread: c.unreadPages?.get('d1'),
  findings: (out.findings ?? []).map((f) => ({ code: f.code, severity: f.severity })),
  textLayerPages: [...(c.textLayerPages?.get('d1') ?? [])],
}));
`;

const SECOND_CHILD = `
const [, file] = process.argv;
const { metaValidator } = await import(process.env.TARGET_URL);
const { redFlagValidator } = await import(new URL('./redFlagValidator.ts', process.env.TARGET_URL).href);
const { dupValidator } = await import(new URL('./dupValidator.ts', process.env.TARGET_URL).href);
const pdfCalls = [];
const regionCalls = [];
const dupRows = [];
const c = {
  claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
  documents: [{ id: 'd1', fileName: 'f.pdf', storagePath: file, readablePath: file,
    mimeType: 'application/pdf', source: 'SCANNED', documentTypeId: null }],
  // DUP's index of this claim's values; no other claim holds any.
  prisma: { claimFieldValue: {
    deleteMany: async () => ({}),
    createMany: async ({ data }) => dupRows.push(...data.map(({ field, norm, page }) => ({ field, norm, page }))),
    findMany: async () => [],
  } },
  ocr: {
    extractImageText: async () => '',
    extractPdf: async (_path, only, opts) => {
      pdfCalls.push([only, opts]);
      // TesseractOcrPort.extractPdf's shape when a page's recognize rejects.
      if (process.env.CRASH) return { text: '', words: [] };
      if (process.env.NO_UNREAD_FIELD) {
        return { text: 'PICTURE TEXT', words: [], pages: only.map((p) => ({ page: p, text: 'PICTURE TEXT' })), totalPages: 1 };
      }
      // The OCR deadline runs on performance.now (META's timeout clock), so time passing is faked there.
      if (process.env.LEFT_MS && pdfCalls.length === 1) {
        // Leave the second reads LEFT_MS of the OCR deadline, as a long main read would.
        const real = performance.now.bind(performance);
        const shift = opts.deadline - real() - Number(process.env.LEFT_MS);
        performance.now = () => real() + shift;
      }
      if (process.env.LATE) {
        // Move the clock past the OCR deadline, as a main read that used all its time would.
        const real = performance.now.bind(performance);
        performance.now = () => real() + 1_000_000;
      }
      if (process.env.WALL_JUMP_MS && pdfCalls.length === 1) {
        // A wall-clock step mid-read (w32time, a VM resume): no deadline may move with it.
        const real = Date.now;
        Date.now = () => real() + Number(process.env.WALL_JUMP_MS);
      }
      const mainText = process.env.MAIN_TEXT ?? 'PICTURE TEXT';
      return {
        text: mainText, words: [], pages: only.map((p) => ({ page: p, text: mainText })), totalPages: 1,
        unreadPages: process.env.IMAGE_UNREAD ? [1] : [],
      };
    },
    extractPdfRegions: async (_path, regions, opts) => {
      regionCalls.push([regions, opts]);
      const mode = process.env.REGION_TEXT;
      // 'first-only': the port's deadline came before any region but the first could start.
      if (mode === 'first-only') return regions.map((_, i) => (i === 0 ? '' : null));
      return regions.map((r) => (mode === 'none' ? '' : mode === 'tagged' ? 'region p' + r.page + ' x' + r.scale : mode ?? 'CROP TEXT'));
    },
  },
  shared: new Map(), wordBoxes: new Map(), pageTexts: new Map(),
};
const out = await metaValidator.run(c);
if (process.env.DUP) await dupValidator.run(c);
const red = process.env.REDFLAG ? await redFlagValidator.run(c) : undefined;
console.log(JSON.stringify({
  pdfCalls, regionCalls, dupRows,
  redFlagCodes: red && (red.findings ?? []).map((f) => f.code),
  smallFlagPages: red && (red.findings ?? []).filter((f) => f.code === 'REDFLAG_SMALL_IMAGE_UNREAD').map((f) => f.page),
  secondReads: c.secondReads?.get('d1'),
  pageImages: c.pageImages?.get('d1') ? Object.fromEntries(c.pageImages.get('d1')) : undefined,
  pageTexts: c.pageTexts.get('d1'),
  shared: c.shared.get('d1'),
  unread: c.unreadPages?.get('d1'),
  codes: (out.findings ?? []).map((f) => f.code),
}));
`;

const SRC = path.join(__dirname, '..', '..');

function runChild<T>(script: string, target: string, file: string, extraEnv: Record<string, string> = {}): T {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, file], {
    cwd: path.join(SRC, '..'),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...extraEnv, TARGET_URL: pathToFileURL(path.join(SRC, target)).href },
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as T;
}

// Five lines down the page: text in one band only reads as a picture with a caption and is
// sent to OCR as well (pdfExtractor's MIXED_PAGE_COVERAGE).
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const textPdf = () => onePagePdf(`BT /F1 12 Tf 20 180 Td ${WORDS.map((w) => `(${w}) Tj 0 -40 Td`).join(' ')} ET`);

/** Page 1 carries a text layer, page 2 is blank (a scan): the mixed-PDF case. */
function textThenBlankPdf(): Buffer {
  const content = `BT /F1 12 Tf 20 180 Td ${WORDS.map((w) => `(${w}) Tj 0 -40 Td`).join(' ')} ET`;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 6 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
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
  const runMeta = (name: string, pdf: Buffer, extraEnv: Record<string, string> = {}) =>
    runChild<{
      status: string;
      ocrCalls: number;
      text?: string;
      words: number;
      pages?: string;
      onlyPages?: number[];
      deadlineLeft?: number;
      unread?: number[] | 'all';
      findings: { code: string; severity?: string }[];
      textLayerPages: number[];
    }>(
      META_CHILD,
      'validators/metaValidator.ts',
      write(name, pdf),
      extraEnv
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

  it('gives OCR a deadline inside the PDF budget and records the pages it could not reach', () => {
    const r = runMeta('unread.pdf', onePagePdf(), { UNREAD: '1' });
    // Fully scanned path passes its textless page list, so the blind page cap does not apply.
    expect(r.onlyPages).toEqual([1]);
    // Left on the child's monotonic clock when OCR starts: at most the 300 s budget less the
    // 20 s margin, and the child (60 s timeout) cannot have used more than 60 s of it.
    expect(r.deadlineLeft).toBeLessThanOrEqual(300_000 - 20_000);
    expect(r.deadlineLeft).toBeGreaterThan(300_000 - 20_000 - 60_000);
    expect(r.unread).toEqual([2, 3]);
    expect(r.findings).toContainEqual({ code: 'META_PAGES_UNREAD', severity: 'WARNING' });
    expect(r.text).toBe('RC page text');
  });

  it('flags the scanned pages of a mixed PDF as unread when OCR never got a first look', () => {
    const r = runMeta('mixed-no-look.pdf', textThenBlankPdf(), { NO_FIRST_LOOK: '1' });
    expect(r.onlyPages).toEqual([2]);
    expect(r.unread).toEqual([2]);
    expect(r.findings).toContainEqual({ code: 'META_PAGES_UNREAD', severity: 'WARNING' });
    expect(r.text).toBe(WORDS.join(' '));
  });

  it('records the text-layer pages of a digital PDF and none of a scan', () => {
    expect(runMeta('digital2.pdf', textPdf()).textLayerPages).toEqual([1]);
    expect(runMeta('scan2.pdf', onePagePdf()).textLayerPages).toEqual([]);
  });

  it('leaves a page with no text layer out of textLayerPages', () => {
    expect(runMeta('mixed.pdf', textThenBlankPdf()).textLayerPages).toEqual([1]);
  });
});

describe('metaValidator second OCR reads', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'meta-second-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const PAN = ['INCOME TAX DEPARTMENT', 'GOVT. OF INDIA', 'Permanent Account Number Card', 'PQRPT5678K'];
  type SecondOut = {
    pdfCalls: [number[], { deadline?: number }][];
    regionCalls: [{ page: number; box: object; scale: number }[], { deadline?: number }][];
    secondReads?: { page: number; text: string; kind: string }[];
    pageImages?: Record<string, { box?: object }>;
    pageTexts?: string[];
    shared?: string;
    unread?: number[];
    codes: string[];
    redFlagCodes?: string[];
    smallFlagPages?: number[];
    dupRows: { field: string; norm: string; page: number | null }[];
  };
  const runSecond = (name: string, pdf: Buffer, env: Record<string, string> = {}) => {
    const file = path.join(dir, name);
    writeFileSync(file, pdf);
    return runChild<SecondOut>(SECOND_CHILD, 'validators/metaValidator.ts', file, env);
  };

  it("reads the picture under an ID page's text layer, apart from the page text", () => {
    const r = runSecond('id.pdf', imagePdf({ cm: '160 0 0 100 20 60', text: PAN }));
    expect(r.pdfCalls).toHaveLength(1);
    expect(r.pdfCalls[0][0]).toEqual([1]);
    expect(typeof r.pdfCalls[0][1].deadline).toBe('number');
    expect(r.regionCalls).toHaveLength(0);
    expect(r.secondReads).toEqual([{ page: 1, text: 'PICTURE TEXT', kind: 'IMAGE' }]);
    expect(r.pageTexts?.[0]).not.toContain('PICTURE TEXT');
    expect(r.shared).not.toContain('PICTURE TEXT');
    expect(r.pageImages?.['1'].box).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: 0.5 });
  });

  it('crops and re-reads a small picture on a scanned page', () => {
    const r = runSecond('small.pdf', imagePdf({ cm: '60 0 0 80 20 100' }));
    expect(r.pdfCalls).toHaveLength(1);
    expect(r.pdfCalls[0][0]).toEqual([1]);
    expect(r.regionCalls).toHaveLength(1);
    expect(r.regionCalls[0][0]).toEqual([{ page: 1, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.4 }, scale: 6 }]);
    expect(r.regionCalls[0][1].deadline).toBe(r.pdfCalls[0][1].deadline);
    expect(r.secondReads).toEqual([{ page: 1, text: 'CROP TEXT', kind: 'UPSCALE' }]);
  });

  const C0 = 'Birth Certificate\nRegistration of Births and Deaths Act, 1969\nDate of Registration: 01/01/2020';

  it('re-reads a scanned certificate page at scale 4 when no number parsed', () => {
    const r = runSecond('cert.pdf', imagePdf({ cm: '1 0 0 1 0 0' }), { MAIN_TEXT: C0 });
    expect(r.pdfCalls).toHaveLength(1);
    expect(r.pdfCalls[0][0]).toEqual([1]);
    expect(r.regionCalls).toHaveLength(1);
    expect(r.regionCalls[0][0]).toEqual([{ page: 1, box: { x: 0, y: 0, w: 1, h: 1 }, scale: 4 }]);
    expect(r.regionCalls[0][1].deadline).toBe(r.pdfCalls[0][1].deadline);
    expect(r.secondReads).toEqual([{ page: 1, text: 'CROP TEXT', kind: 'RESCALE' }]);
  });

  it('does not re-read a certificate whose number parsed', () => {
    const text = 'Birth Certificate\nRegistration No: 4321/2023';
    const r = runSecond('cert-ok.pdf', imagePdf({ cm: '1 0 0 1 0 0' }), { MAIN_TEXT: text });
    expect(r.regionCalls).toHaveLength(0);
    expect(r.secondReads).toBeUndefined();
  });

  it('makes no second read once the OCR deadline has passed, and keeps the main text', () => {
    const r = runSecond('late.pdf', imagePdf({ cm: '60 0 0 80 20 100' }), { LATE: '1' });
    expect(r.pdfCalls).toHaveLength(1); // the main read only
    expect(r.regionCalls).toHaveLength(0);
    expect(r.secondReads).toBeUndefined();
    expect(r.pageImages).toBeUndefined();
    expect(r.shared).toContain('PICTURE TEXT');
    expect(r.codes).not.toContain('META_EXTRACT_TIMEOUT');
  });

  it("ignores the picture read's unreadPages", () => {
    const r = runSecond('unread.pdf', imagePdf({ cm: '160 0 0 100 20 60', text: PAN }), { IMAGE_UNREAD: '1' });
    expect(r.pdfCalls).toHaveLength(1);
    expect(r.unread).toBeUndefined();
    expect(r.codes).not.toContain('META_PAGES_UNREAD');
  });

  // Page 1 has a text layer; page 2 is a scan whose only picture is small.
  const mixed = (page1: string[], page1Picture?: string) =>
    imagePdfPages([{ text: page1, cm: page1Picture }, { cm: '60 0 0 80 20 100' }]);

  // Value: protects=a page OCR failed to read is reported unread, not judged as a customer's unreadable picture; fails_when=META drops the crash shape silently or REDFLAG judges unread pages; why_new=every second-read test read its pages successfully; seam=none; no_claim=the scanned-only path
  it('reports the pages of a crashed OCR read as unread, and does not judge their pictures', () => {
    const r = runSecond('crash.pdf', mixed(['alpha', 'bravo', 'charlie', 'delta', 'echo']), {
      CRASH: '1',
      REGION_TEXT: 'none',
      REDFLAG: '1',
    });
    expect(r.pdfCalls[0][0]).toEqual([2]);
    expect(r.pageImages?.['2']).toBeDefined();
    expect(r.unread).toEqual([2]);
    expect(r.codes).toContain('META_PAGES_UNREAD');
    expect(r.redFlagCodes).toBeDefined();
    expect(r.redFlagCodes).not.toContain('REDFLAG_SMALL_IMAGE_UNREAD');
  });

  // Value: protects=only the crash shape (no list AND no text) marks pages unread; fails_when=META treats a successful read that omits unreadPages as a crash; why_new=the mock always returned the list; seam=none; no_claim=the scanned-only path
  it('does not report pages unread when a read returns text but no unreadPages list', () => {
    const r = runSecond('nolist.pdf', mixed(['alpha', 'bravo', 'charlie', 'delta', 'echo']), {
      NO_UNREAD_FIELD: '1',
      REGION_TEXT: 'none',
    });
    expect(r.pdfCalls[0][0]).toEqual([2]);
    expect(r.unread).toBeUndefined();
    expect(r.codes).not.toContain('META_PAGES_UNREAD');
  });

  it('makes no second read with under 30 s of the OCR deadline left', () => {
    const r = runSecond('short.pdf', mixed(PAN, '160 0 0 100 20 60'), { LEFT_MS: '10000' });
    expect(r.pdfCalls).toHaveLength(1); // the main read of page 2 only
    expect(r.pdfCalls[0][0]).toEqual([2]);
    expect(r.regionCalls).toHaveLength(0);
    expect(r.secondReads).toBeUndefined();
    // The picture scan still ran: only the reads were skipped.
    expect(Object.keys(r.pageImages ?? {})).toEqual(['1', '2']);
  });

  // Value: protects=the OCR deadline and the second-read budget checks run on the monotonic clock of META's own timeout, so a wall-clock step mid-read moves none of them; fails_when=any of them reads Date.now (a forward step skips every second read; a backward one starts reads past the outer timeout, whose fallback drops the main text); why_new=F1 made the outer timeout monotonic while the OCR deadline stayed on Date.now; seam=Date.now and performance.now overrides in the child; no_claim=TesseractOcrPort's clock (ocrExtractPdf.test.ts)
  it('keeps its second-read decisions when the wall clock steps mid-read', () => {
    const ahead = runSecond('jump-ahead.pdf', mixed(PAN, '160 0 0 100 20 60'), { WALL_JUMP_MS: '3600000' });
    expect(ahead.pdfCalls.map(([pages]) => pages)).toEqual([[2], [1]]); // main read, then the picture
    expect(ahead.pdfCalls[1][1].deadline).toBe(ahead.pdfCalls[0][1].deadline);
    expect(ahead.regionCalls).toHaveLength(1);
    expect(ahead.secondReads?.map((s) => s.kind)).toEqual(['IMAGE', 'UPSCALE']);

    // 10 s left on the monotonic clock: an hour's step back on the wall clock must not buy more.
    const back = runSecond('jump-back.pdf', mixed(PAN, '160 0 0 100 20 60'), {
      WALL_JUMP_MS: '-3600000',
      LEFT_MS: '10000',
    });
    expect(back.pdfCalls).toHaveLength(1);
    expect(back.regionCalls).toHaveLength(0);
    expect(back.secondReads).toBeUndefined();
  });

  it('files each region read under its own kind and page', () => {
    const pdf = imagePdfPages([{ cm: '60 0 0 80 20 100' }, { cm: '1 0 0 1 0 0' }]);
    const r = runSecond('both.pdf', pdf, { MAIN_TEXT: C0, REGION_TEXT: 'tagged' });
    expect(r.regionCalls).toHaveLength(1);
    expect(r.regionCalls[0][0].map((g) => [g.page, g.scale])).toEqual([
      [1, 6],
      [2, 4],
    ]);
    expect(r.secondReads).toEqual([
      { page: 1, text: 'region p1 x6', kind: 'UPSCALE' },
      { page: 2, text: 'region p2 x4', kind: 'RESCALE' },
    ]);
  });

  // The review's input (P4 M5): a 1-page scan with a small, blurry Aadhaar picture. The main read
  // gets nothing from it, so META stores no page text; only the crop read can see the card.
  // Value: protects=a document whose main read gave under 3 characters keeps its second reads for DUP and REDFLAG; fails_when=DUP walks only documents with page text, or REDFLAG skips a document with no classified pages; why_new=every second-read test had a readable main text; seam=none; no_claim=text-layer pages, DUP matches against other claims
  it('judges the second reads of a document whose main read was empty', () => {
    const AF = 'Government of India\nDOB: 01/01/1990\nMALE';
    const run = (name: string, regionText: string) =>
      runSecond(name, imagePdf({ cm: '60 0 0 80 20 100' }), {
        MAIN_TEXT: '',
        REGION_TEXT: regionText,
        DUP: '1',
        REDFLAG: '1',
      });
    const read = run('blank-read.pdf', AF + '\n2345 6789 0123');
    expect(read.shared).toBeUndefined();
    expect(read.codes).toContain('META_NO_TEXT');
    expect(read.secondReads).toEqual([{ page: 1, text: AF + '\n2345 6789 0123', kind: 'UPSCALE' }]);
    expect(read.dupRows).toEqual([{ field: 'AADHAAR', norm: '234567890123', page: 1 }]);
    expect(read.redFlagCodes).not.toContain('REDFLAG_SMALL_IMAGE_UNREAD');

    const unread = run('blank-unread.pdf', AF);
    expect(unread.dupRows).toEqual([]);
    expect(unread.smallFlagPages).toEqual([1]);
  });

  // Fix round 1, I1: a whole document with no readable text is most often a photo with no ID.
  // Value: protects=a picture-only document is flagged only when some read of it shows ID evidence; fails_when=the no-instance path flags on an empty read or on vehicle words; why_new=P4X judged every such document; seam=none; no_claim=none
  it('does not flag a picture-only document that shows no sign of an ID', () => {
    const AF = 'Government of India\nDOB: 01/01/1990\nMALE';
    const run = (name: string, regionText: string) =>
      runSecond(name, imagePdf({ cm: '60 0 0 80 20 100' }), {
        MAIN_TEXT: '',
        REGION_TEXT: regionText,
        DUP: '1',
        REDFLAG: '1',
      });
    expect(run('photo-empty.pdf', 'none').smallFlagPages).toEqual([]);
    expect(run('photo-car.pdf', 'TATA MOTORS\nNEXON XZ').smallFlagPages).toEqual([]);
    expect(run('photo-af.pdf', AF).smallFlagPages).toEqual([1]);
  });

  // REDFLAG skipped such a scan for having no classified pages, which was all that kept a crashed
  // main read (the port's { text: '', words: [] }) from being judged as the customer's picture.
  // Value: protects=a scanned PDF whose main read crashed gets no second reads, so neither DUP nor REDFLAG judges a page we failed to read; fails_when=second reads run after the crash shape on the scanned-only path; why_new=REDFLAG now judges documents with no classified pages; seam=none; no_claim=the mixed path (its crash test above)
  it('makes no second read of a scan whose main read crashed', () => {
    const r = runSecond('crash-scan.pdf', imagePdf({ cm: '60 0 0 80 20 100' }), {
      CRASH: '1',
      REGION_TEXT: 'Government of India\nDOB: 01/01/1990\nMALE\n2345 6789 0123',
      DUP: '1',
      REDFLAG: '1',
    });
    expect(r.codes).toContain('META_NO_TEXT');
    expect(r.regionCalls).toHaveLength(0);
    expect(r.secondReads).toBeUndefined();
    expect(r.dupRows).toEqual([]);
    expect(r.redFlagCodes).not.toContain('REDFLAG_SMALL_IMAGE_UNREAD');
  });

  // The flag says a sharper read failed too, so a page no sharper read was tried on is not judged.
  // Value: protects=a small-picture page whose crop read a cap or the deadline skipped is left out of REDFLAG_SMALL_IMAGE_UNREAD; fails_when=META stops recording the skipped pages or REDFLAG stops reading them; why_new=every small-picture test had its crop read (P4 review M6); seam=none; no_claim=a crashed picture read
  it('does not judge a small picture whose second read was skipped', () => {
    const AF = 'Government of India\nDOB: 01/01/1990\nMALE';
    const nine = imagePdfPages(Array.from({ length: 9 }, () => ({ cm: '60 0 0 80 20 100' })));
    const run = (name: string, env: Record<string, string>) =>
      runSecond(name, nine, { MAIN_TEXT: AF, REDFLAG: '1', ...env });
    // MAX_UPSCALE_PAGES is 8: page 9 gets no crop read. Pages 1-8 were read and gave no number.
    const capped = run('nine.pdf', { REGION_TEXT: 'none' });
    expect(capped.regionCalls[0][0].map((g) => g.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(capped.smallFlagPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Under 30 s of the deadline left: no crop read at all.
    expect(run('nine-late.pdf', { REGION_TEXT: 'none', LEFT_MS: '10000' }).smallFlagPages).toEqual([]);
    // The port's deadline stopped every region but the first.
    expect(run('nine-cut.pdf', { REGION_TEXT: 'first-only' }).smallFlagPages).toEqual([1]);

    // A text-layer PAN page with no number and a small card picture: the picture read checks it.
    // Four lines, so the layer spans the page and META does not OCR it as a captioned picture.
    const pan = imagePdf({ cm: '160 0 0 100 20 60', text: [...PAN.slice(0, 3), 'RAVI KUMAR'] });
    expect(runSecond('pan-read.pdf', pan, { REDFLAG: '1' }).smallFlagPages).toEqual([1]);
    expect(runSecond('pan-late.pdf', pan, { REDFLAG: '1', IMAGE_UNREAD: '1' }).smallFlagPages).toEqual([]);
  });

  it('makes no second read for a page whose only picture is a logo', () => {
    const r = runSecond('logo.pdf', imagePdf({ cm: '30 0 0 20 10 170', text: PAN }));
    expect(r.pdfCalls).toHaveLength(0);
    expect(r.regionCalls).toHaveLength(0);
    expect(r.secondReads).toBeUndefined();
  });
});
