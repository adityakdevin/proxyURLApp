import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { MAX_REGION_FALLBACK_LONG_SIDE_PX, TesseractOcrPort } from '../ocr.js';
import { rasterizePdf } from '../pdfExtractor.js';
import { imagePdfPages } from '../../__tests__/helpers/imagePdf.js';

// A worker that reads every image as the same poor text, so each page asks for a retry.
jest.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: 'zz qq' } }),
    setParameters: async () => undefined,
    terminate: async () => undefined,
  }),
}));
jest.mock('../pdfExtractor.js', () => ({
  ...jest.requireActual('../pdfExtractor.js'),
  rasterizePdf: jest.fn(),
}));

describe('TesseractOcrPort.extractPdf', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('keeps the first look of a page whose high-res retry fails', async () => {
    const raster = rasterizePdf as jest.MockedFunction<typeof rasterizePdf>;
    raster
      .mockResolvedValueOnce([{ page: 1, png: Buffer.from('page'), width: 100, height: 100, totalPages: 1 }])
      .mockRejectedValueOnce(new Error('pixdata_malloc fail'));
    const port = new TesseractOcrPort();
    try {
      const r = await port.extractPdf('/claims/scan.pdf', [1]);
      expect(raster).toHaveBeenCalledTimes(2);
      expect(r).toMatchObject({ text: 'zz qq', unreadPages: [] });
    } finally {
      await port.close();
    }
  });

  // Value: protects=both OCR reads compare META's deadline with the monotonic clock it was set on; fails_when=extractPdf or extractPdfRegions read Date.now (every page past the deadline, or a backward wall-clock step starting reads past META's timeout); why_new=META's deadline moved to performance.now; seam=Date.now spy; no_claim=queue time (pdfExtractor.test.ts)
  it('reads the deadline on the monotonic clock, whatever the wall clock does', async () => {
    const raster = rasterizePdf as jest.MockedFunction<typeof rasterizePdf>;
    raster.mockResolvedValue([{ page: 1, png: Buffer.from('page'), width: 100, height: 100, totalPages: 1 }]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000);
    const port = new TesseractOcrPort();
    try {
      const ahead = performance.now() + 60_000;
      const region = { page: 1, box: { x: 0, y: 0, w: 1, h: 1 }, scale: 2 };
      expect(await port.extractPdf('/claims/scan.pdf', [1], { deadline: ahead })).toMatchObject({ unreadPages: [] });
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region], { deadline: ahead })).not.toContain(null);
      const passed = performance.now() - 1;
      expect(await port.extractPdf('/claims/scan.pdf', [1], { deadline: passed })).toMatchObject({ unreadPages: [1] });
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region], { deadline: passed })).toEqual([null]);
    } finally {
      await port.close();
    }
  });

  // A region that did not render or read is not a sharper read that found nothing: null makes META
  // list the page as skipped, where '' made REDFLAG flag a picture nobody had looked at.
  // Value: protects=a failed region read is null, an empty one is ''; fails_when=extractPdfRegions returns '' for a render that gave no page or threw; why_new=P4 review m1; seam=mocked rasterizePdf; no_claim=the flag itself (metaValidator.test.ts)
  it('returns null for a region that gave no page or threw, and keeps the empty read', async () => {
    const raster = rasterizePdf as jest.MockedFunction<typeof rasterizePdf>;
    const region = { page: 1, box: { x: 0, y: 0, w: 1, h: 1 }, scale: 2 };
    const port = new TesseractOcrPort();
    try {
      raster.mockReset().mockResolvedValueOnce([]);
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region])).toEqual([null]);
      raster.mockReset().mockRejectedValueOnce(new Error('pixdata_malloc fail'));
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region])).toEqual([null]);
      raster.mockReset().mockResolvedValueOnce([{ page: 1, png: Buffer.from('p'), width: 10, height: 10, totalPages: 1 }]);
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region])).toEqual(['zz qq']);
    } finally {
      await port.close();
    }
  });
});

// Jimp.read and @napi-rs/canvas load through dynamic imports, which Jest cannot run, so this runs
// in a plain Node child under tsx: the real port and renders, with a stand-in Tesseract worker
// that records the size of every image it is asked to read. The page is blank, so the deskew
// pass finds no skew and is skipped: plain, upright-boosted, three turns and Sauvola.
const PASSES_CHILD = `
const [, file] = process.argv;
const { TesseractOcrPort, recognize } = await import(process.env.TARGET_URL);
const { rasterizePdf } = await import(new URL('./pdfExtractor.ts', process.env.TARGET_URL).href);
console.log = () => undefined;
const seen = [];
const worker = {
  recognize: async (img) => {
    seen.push([img.readUInt32BE(16), img.readUInt32BE(20)]);
    return { data: { text: 'zz qq' } };
  },
  setParameters: async () => undefined,
  terminate: async () => undefined,
};
const port = new TesseractOcrPort();
port.getPool = async (n) => Array(n).fill(worker);
// A full-width band, a tenth of the 200 pt page tall: 2800x280 px at scale 14, 2000x200 at 10.
const band = { x: 0, y: 0, w: 1, h: 0.1 };
const out = {};
for (const [name, scale] of [['over', 14], ['under', 10]]) {
  await port.extractPdfRegions(file, [{ page: 1, box: band, scale }]);
  out[name] = seen.splice(0);
}
// The main read's call: no copy, whatever the size.
const [pg] = await rasterizePdf(file, 1, 14, [1], { clip: band });
await recognize(worker, pg.png);
out.main = seen.splice(0);
// The main read of a page far over the bound: through extractPdf, not recognize called by hand.
await port.extractPdf(process.argv[2]);
out.extract = seen.splice(0);
process.stdout.write(JSON.stringify(out) + '\\n');
process.exit(0);
`;

describe('region read fallback passes', () => {
  // Jimp decodes, turns and re-encodes each fallback pass's image on the main thread, which the
  // HTTP server shares: on a full region render one pass blocked it for about 0.9 s.
  // Value: protects=a region read over MAX_REGION_FALLBACK_LONG_SIDE_PX runs its plain pass on the full render and every Jimp fallback on a copy that long, and every other read keeps one image for all passes; fails_when=a fallback reads the full render, the plain pass reads the copy, a region under the bound is shrunk, or a read without a copy is shrunk; why_new=P4 fix report concern 1; seam=a stand-in Tesseract worker; no_claim=OCR quality on the copy, the deskew pass, the event-loop block itself (measured by hand)
  it('runs the fallback passes of a large region on a smaller copy, and nothing else', () => {
    expect(MAX_REGION_FALLBACK_LONG_SIDE_PX).toBeLessThanOrEqual(2400);
    const dir = mkdtempSync(path.join(tmpdir(), 'region-passes-'));
    try {
      const file = path.join(dir, 'blank.pdf');
      writeFileSync(file, imagePdfPages([{}]));
      const src = path.join(__dirname, '..', '..');
      // A 2500 pt page renders about 5000 px on its long side at the main read's scale; pdf.js
      // rebuilds the xref the longer MediaBox leaves stale.
      const big = path.join(dir, 'big.pdf');
      writeFileSync(big, Buffer.from(imagePdfPages([{}]).toString('latin1').replace('[0 0 200 200]', '[0 0 2500 2500]'), 'latin1'));
      const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PASSES_CHILD, file, big], {
        cwd: path.join(src, '..'),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TARGET_URL: pathToFileURL(path.join(src, 'lib', 'ocr.ts')).href },
      });
      if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number[][]>;
      const either = (w: number, h: number) => [[w, h], [h, w]];
      const long = MAX_REGION_FALLBACK_LONG_SIDE_PX;
      expect(out.over).toHaveLength(6);
      expect(out.over[0]).toEqual([2800, 280]);
      for (const s of out.over.slice(1)) expect(either(long, long / 10)).toContainEqual(s);
      expect(out.under).toHaveLength(6);
      for (const s of out.under) expect(either(2000, 200)).toContainEqual(s);
      expect(out.main).toHaveLength(6);
      for (const s of out.main) expect(either(2800, 280)).toContainEqual(s);
      // extractPdf reads no copy: every image is the full render or larger, never the bound.
      expect(out.extract.length).toBeGreaterThan(0);
      for (const [w, h] of out.extract) expect(Math.max(w, h)).toBeGreaterThan(MAX_REGION_FALLBACK_LONG_SIDE_PX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
