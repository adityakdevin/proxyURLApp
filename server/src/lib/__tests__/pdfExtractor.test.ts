import { spawnSync } from 'child_process';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { mulTransform, oneDocumentAtATime, pdfjsAssetDir, queuedMs, runToWords, withActiveTimeout } from '../pdfExtractor.js';

describe('pdfExtractor coordinate math', () => {
  it('mulTransform matches affine matrix composition', () => {
    // Identity ∘ M = M
    expect(mulTransform([1, 0, 0, 1, 0, 0], [12, 0, 0, 12, 100, 700])).toEqual([12, 0, 0, 12, 100, 700]);
  });

  it('maps a text run on a standard 612x792 page to a normalized top-left box', () => {
    // Portrait page: viewport transform flips y (user-space bottom-left -> device top-left).
    const viewportTransform = [1, 0, 0, -1, 0, 792];
    // Font size 12 at x=100, baseline y=700 (user space), run width 50.
    const words = runToWords('Hello', [12, 0, 0, 12, 100, 700], 50, 12, viewportTransform, 612, 792, 1);
    expect(words).toHaveLength(1);
    const b = words[0].bbox;
    expect(words[0].text).toBe('Hello');
    expect(words[0].page).toBe(1);
    expect(b.x).toBeCloseTo(100 / 612, 5); // left
    expect(b.y).toBeCloseTo((792 - 700 - 12) / 792, 5); // top = 792 - baseline - ascent
    expect(b.w).toBeCloseTo(50 / 612, 5);
    expect(b.h).toBeCloseTo(12 / 792, 5);
  });

  it('splits a multi-word run into proportional boxes that stay in [0,1]', () => {
    const words = runToWords('ab cd', [10, 0, 0, 10, 0, 100], 100, 10, [1, 0, 0, -1, 0, 200], 100, 200, 2);
    expect(words.map((w) => w.text)).toEqual(['ab', 'cd']);
    // "ab" (2 of 5 chars) then a space, then "cd": second word starts after 3/5 of the width.
    expect(words[1].bbox.x).toBeCloseTo(0.6, 5);
    for (const w of words) {
      expect(w.bbox.x).toBeGreaterThanOrEqual(0);
      expect(w.bbox.x).toBeLessThanOrEqual(1);
      expect(w.bbox.w).toBeGreaterThanOrEqual(0);
      expect(w.page).toBe(2);
    }
  });

  it('returns nothing for blank or zero-size input', () => {
    expect(runToWords('   ', [1, 0, 0, 1, 0, 0], 10, 10, [1, 0, 0, 1, 0, 0], 100, 100, 1)).toHaveLength(0);
    expect(runToWords('x', [1, 0, 0, 1, 0, 0], 10, 10, [1, 0, 0, 1, 0, 0], 0, 0, 1)).toHaveLength(0);
  });
});

describe('pdfjsAssetDir', () => {
  // pdf.js 5+ throws on a factory URL without a trailing "/" ("must include trailing slash").
  // path.win32.join turns 'wasm/' into 'wasm\', which on the Windows box silently disabled
  // rasterizing (OCR of scans, QR) and the editable-text red flag. The host's own module, not
  // path.posix: on Windows the resolved path has backslashes, which path.posix cannot split.
  it.each([
    ['this OS', path],
    ['win32', path.win32],
  ])('keeps a trailing "/" on %s', (_os, p) => {
    expect(pdfjsAssetDir('wasm/', p)).toMatch(/[\\/]wasm\/$/);
    expect(pdfjsAssetDir('standard_fonts/', p)).toMatch(/[\\/]standard_fonts\/$/);
  });

  it('points at the installed wasm decoders', () => {
    expect(fs.existsSync(`${pdfjsAssetDir('wasm/')}jbig2.wasm`)).toBe(true);
  });
});

// A 32x32 all-black image as a raw JPEG 2000 codestream (opj_compress, lossless).
const BLACK_32PX_J2K =
  '/0//UQApAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABBwEB/1IADAAAAAEAAQQEAAH/XAAHQEBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAAAZAAH/k9+AOBFQVK/0yH+A/9k=';

/** A 100x100pt page whose only content is that image, drawn over the whole page. With
 *  `blankFirstPage`, a large empty page comes first, so the scan is page 2. */
function jpxScanPdf(blankFirstPage = false): Buffer {
  const j2k = Buffer.from(BLACK_32PX_J2K, 'base64');
  const content = 'q 100 0 0 100 0 0 cm /Im1 Do Q';
  const objs = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),
    Buffer.from(blankFirstPage ? '<</Type/Pages/Kids[6 0 R 3 0 R]/Count 2>>' : '<</Type/Pages/Kids[3 0 R]/Count 1>>'),
    Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</XObject<</Im1 5 0 R>>>>/Contents 4 0 R>>'),
    Buffer.from(`<</Length ${content.length}>>\nstream\n${content}\nendstream`),
    Buffer.concat([
      Buffer.from(`<</Type/XObject/Subtype/Image/Width 32/Height 32/Filter/JPXDecode/Length ${j2k.length}>>\nstream\n`),
      j2k,
      Buffer.from('\nendstream'),
    ]),
    ...(blankFirstPage ? [Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 1200 1600]>>')] : []),
  ];
  const parts = [Buffer.from('%PDF-1.5\n')];
  let size = parts[0].length;
  const offsets = objs.map((o, i) => {
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(part);
    size += part.length;
    return size - part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
        offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${size}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
}

// pdfjs starts its worker with a dynamic import(), which Jest cannot run without
// --experimental-vm-modules, so this runs in a plain Node child under tsx (as metaValidator's
// real-PDF tests do). The rendered page's centre pixel tells a drawn image from a blank page.
const JPX_CHILD = `
const [, file] = process.argv;
const { largestImageWidthPerPage, pdfPageTextStats, rasterizePdf } = await import(process.env.TARGET_URL);
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const sizes = await largestImageWidthPerPage(file, [1]);
const stats = await pdfPageTextStats(file);
const [page] = await rasterizePdf(file, 1, 1);
let centre = null;
if (page) {
  const img = await loadImage(page.png);
  const ctx = createCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  centre = Array.from(ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data);
}
console.log(JSON.stringify({ size: sizes?.get(1) ?? null, stats, centre }));
`;

// Two claims validate at once, so another claim can open and close a PDF while this one is
// still rendering. The first wait loads pdf.js, so the 100 ms wait lands inside page 1's render.
const OVERLAP_CHILD = `
const [, scan, other] = process.argv;
const { rasterizePdf, readPdfInfo } = await import(process.env.TARGET_URL);
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
await readPdfInfo(other);
const raster = rasterizePdf(scan, 2, 4);
await new Promise((r) => setTimeout(r, 100));
await readPdfInfo(other);
const pages = await Promise.race([raster, new Promise((r) => setTimeout(() => r(null), 20_000))]);
const page = pages?.find((p) => p.page === 2);
let centre = null;
if (page) {
  const img = await loadImage(page.png);
  const ctx = createCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  centre = Array.from(ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data);
}
console.log(JSON.stringify({ rendered: pages !== null, centre }));
process.exit(0);
`;

// A file pdf.js refuses to open, then a good one: the failed open must not escape, hang the
// queue, or leave pdf.js unable to open the next document.
const UNOPENABLE_CHILD = `
const [, bad, good] = process.argv;
const m = await import(process.env.TARGET_URL);
const empty = [
  await m.extractPdf(bad),
  await m.readPdfInfo(bad),
  await m.rasterizePdf(bad),
  await m.largestImageWidthPerPage(bad, [1]),
  await m.pdfPageTextStats(bad),
];
console.log(JSON.stringify({ empty, after: await m.pdfPageTextStats(good) }));
process.exit(0);
`;

/** Runs `script` in a Node child under tsx with pdfExtractor at TARGET_URL; returns its last stdout line, parsed. */
function runPdfChild(script: string, args: string[]): unknown {
  const src = path.join(__dirname, '..', '..');
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, ...args], {
    cwd: path.join(src, '..'),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TARGET_URL: pathToFileURL(path.join(src, 'lib', 'pdfExtractor.ts')).href },
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

describe('pdfExtractor on a JPEG 2000 scan', () => {
  // pdf.js sizes a JPX image from its header without decoding it, so only the render needs the
  // wasm decoder; the two measures are pinned here because nothing else runs them on pdfjs 6.
  // Value: protects=a JPEG 2000 scanned page renders, and its image is measured, under pdfjs 6; fails_when=rasterizePdf drops wasmUrl (blank page) or pdfjs image paint-op args stop giving the size; why_new=no test ran rasterize or the image measures on a real PDF; seam=none; no_claim=JBIG2 scans, OCR or QR
  it('renders and measures a JPEG 2000 image with the wasm decoder', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'jpx-pdf-'));
    try {
      const file = path.join(dir, 'scan.pdf');
      fs.writeFileSync(file, jpxScanPdf());
      expect(runPdfChild(JPX_CHILD, [file])).toEqual({
        size: { width: 32, height: 32 },
        stats: [{ image: true, visibleText: false }],
        // Opaque black: a page whose image was dropped renders white.
        centre: [0, 0, 0, 255],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // pdf.js 6 fetches its wasm decoders through the document opened last, so a document opened
  // and closed mid-render left this page waiting on a fetch nobody answered.
  // Value: protects=a scan's JPEG 2000 page renders while another claim opens and closes a PDF; fails_when=pdfExtractor lets pdf.js documents overlap again; why_new=the hang needs two documents in one process, which no other test opens; seam=none; no_claim=JBIG2 or CCITT scans, the turn bound
  it('renders it while another PDF is opened and closed mid-render', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'jpx-overlap-'));
    try {
      const scan = path.join(dir, 'scan.pdf');
      const other = path.join(dir, 'other.pdf');
      fs.writeFileSync(scan, jpxScanPdf(true));
      fs.writeFileSync(other, jpxScanPdf());
      expect(runPdfChild(OVERLAP_CHILD, [scan, other])).toEqual({ rendered: true, centre: [0, 0, 0, 255] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=every export returns its documented empty value when pdf.js cannot open the file, and the next PDF still opens; fails_when=a failed open escapes the catch, hangs the queue, or leaves pdf.js unable to open the next document; why_new=no test opened an unreadable file; seam=none; no_claim=that the task's worker is released (pdf.js exposes nothing to observe it)
  it('returns empty results for a file pdf.js cannot open, then opens the next one', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'pdf-unopenable-'));
    try {
      const bad = path.join(dir, 'bad.pdf');
      const good = path.join(dir, 'good.pdf');
      fs.writeFileSync(bad, 'not a pdf');
      fs.writeFileSync(good, jpxScanPdf());
      expect(runPdfChild(UNOPENABLE_CHILD, [bad, good])).toEqual({
        empty: [null, {}, [], null, []],
        after: [{ image: true, visibleText: false }],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withActiveTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Holds the pdf.js queue until released, like the other claim's long QR raster pass. */
  function holdQueue(): () => void {
    let release!: () => void;
    void oneDocumentAtATime(() => new Promise<void>((r) => (release = r)))();
    return () => release();
  }
  const quickRead = oneDocumentAtATime(async () => 'read');

  it('does not charge a check for time spent queued behind another PDF', async () => {
    const release = holdQueue();
    const result = withActiveTimeout(() => quickRead(), 50, () => 'timed out');
    await jest.advanceTimersByTimeAsync(500);
    release();
    await expect(result).resolves.toBe('read');
  });

  it('does not charge an outer budget either when timers nest', async () => {
    const release = holdQueue();
    const result = withActiveTimeout(
      () => withActiveTimeout(() => quickRead(), 1_000, () => 'inner timed out'),
      50,
      () => 'outer timed out'
    );
    await jest.advanceTimersByTimeAsync(500);
    release();
    await expect(result).resolves.toBe('read');
  });

  it('tells the timed work how long it has queued, so OCR can stop on the same clock', async () => {
    expect(queuedMs()).toBe(0);
    const release = holdQueue();
    let seen = -1;
    const result = withActiveTimeout(
      async () => {
        const read = await quickRead();
        seen = queuedMs();
        return read;
      },
      50,
      () => 'timed out'
    );
    await jest.advanceTimersByTimeAsync(500);
    release();
    await expect(result).resolves.toBe('read');
    expect(seen).toBe(500);
  });

  it('still times out work that is slow on its own', async () => {
    const result = withActiveTimeout(() => new Promise<string>(() => {}), 50, () => 'timed out');
    await jest.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe('timed out');
  });

  it('times out on schedule when the wall clock steps back', async () => {
    let settled: string | undefined;
    void withActiveTimeout(() => new Promise<string>(() => {}), 1_000, () => 'timed out').then(
      (v) => (settled = v)
    );
    await jest.advanceTimersByTimeAsync(500);
    // w32time pulling a fast clock back an hour; the monotonic clock does not move.
    jest.setSystemTime(Date.now() - 3_600_000);
    await jest.advanceTimersByTimeAsync(600);
    expect(settled).toBe('timed out');
  });

  it('arms no timer past the 32-bit limit, and still times out on schedule', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const maxDelay = () => Math.max(...spy.mock.calls.map((c) => Number(c[1] ?? 0)));
    try {
      let settled: string | undefined;
      void withActiveTimeout(() => new Promise<string>(() => {}), 3_000_000_000, () => 'timed out').then(
        (v) => (settled = v)
      );
      // Node, like the fake clock, fires an oversized delay after 1 ms, and check() would spin.
      expect(maxDelay()).toBeLessThanOrEqual(2 ** 31 - 1);
      await jest.advanceTimersByTimeAsync(2 ** 31 - 1);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(3_000_000_000 - (2 ** 31 - 1));
      expect(settled).toBe('timed out');
      expect(maxDelay()).toBeLessThanOrEqual(2 ** 31 - 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects with what onTimeout throws', async () => {
    const result = withActiveTimeout(() => new Promise<string>(() => {}), 50, () => {
      throw new Error('META timed out after 0s');
    });
    const settled = expect(result).rejects.toThrow('META timed out after 0s');
    await jest.advanceTimersByTimeAsync(50);
    await settled;
  });
});
