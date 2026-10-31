import { spawnSync } from 'child_process';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { mulTransform, pdfjsAssetDir, runToWords } from '../pdfExtractor.js';

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

/** A one-page 100x100pt PDF whose only content is that image, drawn over the whole page. */
function jpxScanPdf(): Buffer {
  const j2k = Buffer.from(BLACK_32PX_J2K, 'base64');
  const content = 'q 100 0 0 100 0 0 cm /Im1 Do Q';
  const objs = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>'),
    Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</XObject<</Im1 5 0 R>>>>/Contents 4 0 R>>'),
    Buffer.from(`<</Length ${content.length}>>\nstream\n${content}\nendstream`),
    Buffer.concat([
      Buffer.from(`<</Type/XObject/Subtype/Image/Width 32/Height 32/Filter/JPXDecode/Length ${j2k.length}>>\nstream\n`),
      j2k,
      Buffer.from('\nendstream'),
    ]),
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

describe('pdfExtractor on a JPEG 2000 scan', () => {
  // pdf.js sizes a JPX image from its header without decoding it, so only the render needs the
  // wasm decoder; the two measures are pinned here because nothing else runs them on pdfjs 6.
  // Value: protects=a JPEG 2000 scanned page renders, and its image is measured, under pdfjs 6; fails_when=rasterizePdf drops wasmUrl (blank page) or pdfjs image paint-op args stop giving the size; why_new=no test ran rasterize or the image measures on a real PDF; seam=none; no_claim=JBIG2 scans, OCR or QR
  it('renders and measures a JPEG 2000 image with the wasm decoder', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'jpx-pdf-'));
    try {
      const file = path.join(dir, 'scan.pdf');
      fs.writeFileSync(file, jpxScanPdf());
      const src = path.join(__dirname, '..', '..');
      const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', JPX_CHILD, file], {
        cwd: path.join(src, '..'),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TARGET_URL: pathToFileURL(path.join(src, 'lib', 'pdfExtractor.ts')).href },
      });
      if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
      expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({
        size: { width: 32, height: 32 },
        stats: [{ image: true, visibleText: false }],
        // Opaque black: a page whose image was dropped renders white.
        centre: [0, 0, 0, 255],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
