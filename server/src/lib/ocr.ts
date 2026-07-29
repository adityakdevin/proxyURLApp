import os from 'os';
import path from 'path';
import { Jimp } from 'jimp';
import { createWorker, Worker } from 'tesseract.js';
import { OcrPort, WordBox } from '../validators/types.js';
import { rasterizePdf } from './pdfExtractor.js';
import { estimateSkewDegrees } from './deskew.js';
import { clamp01 } from './bbox.js';

/**
 * Map a normalized box from an image rotated counter-clockwise by `deg` back onto the page
 * as the reviewer sees it. Without this, a card read at 270° highlights the wrong region —
 * the box would be drawn in the rotated frame nobody is looking at.
 */
function unrotateBox(b: WordBox['bbox'], deg: number): WordBox['bbox'] {
  const { x, y, w, h } = b;
  if (deg === 90) return { x: 1 - y - h, y: x, w: h, h: w };
  if (deg === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
  if (deg === 270) return { x: y, y: 1 - x - w, w: h, h: w };
  return b;
}

/** Walk Tesseract's block hierarchy (v5) — or the flat `words` fallback — into WordBoxes.
 *  `width`/`height` are the ORIGINAL page's; `deg` is the rotation the winning OCR pass
 *  used, which swaps the axes the boxes were measured against. */
function collectWords(data: unknown, width: number, height: number, page = 1, deg = 0): WordBox[] {
  if (!width || !height) return [];
  const turned = deg === 90 || deg === 270;
  const iw = turned ? height : width;
  const ih = turned ? width : height;
  const out: WordBox[] = [];
  const push = (w: { text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number }; confidence?: number }) => {
    const t = (w.text ?? '').trim();
    if (!t || !w.bbox) return;
    const { x0, y0, x1, y1 } = w.bbox;
    out.push({
      text: t,
      page,
      bbox: unrotateBox(
        {
          x: clamp01(x0 / iw),
          y: clamp01(y0 / ih),
          w: clamp01((x1 - x0) / iw),
          h: clamp01((y1 - y0) / ih),
        },
        deg
      ),
      conf: w.confidence,
    });
  };
  const d = data as {
    words?: unknown[];
    blocks?: { paragraphs?: { lines?: { words?: unknown[] }[] }[] }[];
  };
  if (Array.isArray(d.blocks)) {
    for (const b of d.blocks)
      for (const p of b.paragraphs ?? [])
        for (const l of p.lines ?? []) for (const w of l.words ?? []) push(w as never);
  }
  if (out.length === 0 && Array.isArray(d.words)) {
    for (const w of d.words) push(w as never);
  }
  return out;
}

// Cache tesseract language data OUTSIDE the repo. With no cachePath, tesseract.js
// writes `<lang>.traineddata` into the process cwd (the repo's server/ dir).
const OCR_CACHE_PATH = process.env.OCR_CACHE_DIR || path.join(os.tmpdir(), 'claims-ocr-cache');

/** Upper bound when the caller names the pages to OCR (mixed digital/scanned PDF).
 *  Still bounded — a 200-page bundle of scans should not stall a run. */
const MAX_OCR_TARGETED_PAGES = 40;

/**
 * Two ways a scanned ID card defeats a plain Tesseract pass, both seen on real claims:
 *
 *  1. CONTRAST. Grey ink on a pale laminated card binarizes away completely — the page
 *     returns ZERO characters, not garbled ones. A greyscale+contrast pass recovered an
 *     RC-card page from 0 chars to ~900.
 *  2. ROTATION. Cards are photographed sideways, so the page is 90°/270° off. Tesseract
 *     does not auto-orient, and reads the sideways card as punctuation soup
 *     ("€102/1 1/2) :01eQ enss|" — "Issue Date: 12/11/2013" upside-down).
 *
 * Either way the page classified as nothing and its field pane came up empty.
 */
const ROTATIONS = [90, 180, 270] as const;

/**
 * How many word-SHAPED tokens the text has. A character count cannot separate a sideways
 * page from an upright one (the sideways read is just as long), and Tesseract's own
 * confidence scored a sideways Aadhaar card ABOVE its upright reading. This separates them
 * cleanly: the policy page scores 815 upright and 265 sideways; the Aadhaar card 2 upright
 * and 13 at 270°.
 */
const wordScore = (text: string) => (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).length;

/**
 * Above this the page is plainly upright and readable, so no alternative is tried.
 *
 * This is what keeps the sweep affordable, and it is self-balancing: the pages that are
 * SLOW to OCR are the dense ones, and dense pages clear the bar by a mile (815, 54). The
 * pages that fall below it are the sparse card photos, which are the fast ones (~0.3s).
 */
const UPRIGHT_SCORE = 60;

/** Rotate (counter-clockwise, verified against Jimp) and contrast-boost a copy to try. */
async function prepare(image: Buffer | string, deg: number): Promise<Buffer | null> {
  try {
    const img = await Jimp.read(image as never);
    if (deg) img.rotate(deg);
    img.greyscale().contrast(0.5);
    return Buffer.from(await img.getBuffer('image/png'));
  } catch {
    return null; // preprocessing unavailable → keep whatever the plain pass gave
  }
}

/** Estimation runs on a downscaled copy — skew is a property of the whole page, and the
 *  candidate-angle scan is O(ink pixels) per angle. */
const SKEW_SAMPLE_WIDTH = 700;

/**
 * Square up a page that was photographed at an angle, then contrast-boost it.
 *
 * Returns null when the page is already square (or too blank/too solid to judge), so the
 * caller does not pay for an extra OCR pass that would read the same as the last one.
 */
async function prepareDeskewed(
  image: Buffer | string,
  deg: number
): Promise<{ png: Buffer; skew: number } | null> {
  try {
    const img = await Jimp.read(image as never);
    if (deg) img.rotate(deg);
    img.greyscale();

    const probe = img.clone();
    if (probe.bitmap.width > SKEW_SAMPLE_WIDTH) {
      probe.resize({ w: SKEW_SAMPLE_WIDTH });
    }
    // Jimp keeps RGBA; the estimator wants one byte per pixel, and the image is already grey.
    const { data, width, height } = probe.bitmap;
    const grey = new Uint8Array(width * height);
    for (let i = 0; i < grey.length; i++) grey[i] = data[i * 4];

    const skew = estimateSkewDegrees(grey, width, height);
    if (skew === 0) return null;

    // The estimator reports the tilt; rotating by its negation removes it.
    img.rotate(-skew);
    img.contrast(0.5);
    return { png: Buffer.from(await img.getBuffer('image/png')), skew };
  } catch {
    return null;
  }
}

/** Rasterization scale for the second look at a page that read poorly. A photographed
 *  invoice is resolution-starved rather than badly filtered: at the same contrast setting
 *  one real claim page scored 54 at scale 2, 108 at scale 3 and 140 at scale 4. */
const HIGH_RASTER_SCALE = 4;
/** Bound the expensive retries per document, as the QR scan does for its scale-8 pass. */
const MAX_HIGHRES_RETRY_PAGES = 8;
/**
 * How much better the second look must read before it REPLACES the first.
 *
 * The retry rewrites the whole page, so a marginal score gain is a bad trade: on a real
 * Aadhaar back the larger render scored 51 against 44, but re-read "C/O:" as "Jo:" and lost
 * the father's name with it. A page that genuinely needed the pixels wins by much more than
 * that — the invoice in the same bundle went 54 → 140.
 */
const HIGHRES_GAIN = 1.4;

/** One recognition at a KNOWN configuration — used for the high-resolution second look,
 *  where the winning rotation is already established and re-sweeping would be waste. */
async function recognizeWith(
  worker: Worker,
  image: Buffer,
  rotation: number,
  deskew: boolean
): Promise<{ data: Awaited<ReturnType<Worker['recognize']>>['data']; score: number } | null> {
  const png = deskew
    ? (await prepareDeskewed(image, rotation))?.png
    : await prepare(image, rotation);
  if (!png) return null;
  const r = await worker.recognize(png, {}, { blocks: true });
  return { data: r.data, score: wordScore(r.data.text ?? '') };
}

/**
 * Recognize `image`, falling back to contrast-boosted and rotated copies when the plain
 * upright pass reads as noise. Returns the winning rotation so word boxes can be mapped
 * back to the page as the reviewer sees it.
 */
async function recognize(worker: Worker, image: Buffer | string) {
  const plain = await worker.recognize(image, {}, { blocks: true });
  let best: { data: typeof plain.data; rotation: number; score: number; skew?: number } = {
    data: plain.data,
    rotation: 0,
    score: wordScore(plain.data.text ?? ''),
  };
  if (best.score >= UPRIGHT_SCORE) return best;
  // Upright-boosted first, so a tie keeps the page the way it was scanned.
  for (const deg of [0, ...ROTATIONS]) {
    const prepped = await prepare(image, deg);
    if (!prepped) continue;
    const r = await worker.recognize(prepped, {}, { blocks: true });
    const score = wordScore(r.data.text ?? '');
    if (score > best.score) best = { data: r.data, rotation: deg, score };
    // Once a candidate reads as proper text, stop — the remaining rotations cost seconds
    // each on a dense page and cannot beat a page that is already right way up.
    if (best.score >= UPRIGHT_SCORE) break;
  }

  // Still poor at every quarter turn? The page may be a few degrees off square, which
  // Tesseract barely tolerates. One more pass, squared up at whichever turn read best.
  if (best.score < UPRIGHT_SCORE) {
    const straightened = await prepareDeskewed(image, best.rotation);
    if (straightened) {
      const r = await worker.recognize(straightened.png, {}, { blocks: true });
      const score = wordScore(r.data.text ?? '');
      if (score > best.score) {
        best = { data: r.data, rotation: best.rotation, score, skew: straightened.skew };
      }
    }
  }
  return best;
}

export class TesseractOcrPort implements OcrPort {
  private worker: Worker | null = null;

  private async getWorker(): Promise<Worker> {
    if (!this.worker) {
      // Reuse one worker across all images in a run — spinning one up (and loading
      // the language data) per image is the dominant cost otherwise.
      this.worker = await createWorker('eng', undefined, { cachePath: OCR_CACHE_PATH });
    }
    return this.worker;
  }

  async extractImageText(absolutePath: string): Promise<string> {
    try {
      const worker = await this.getWorker();
      const { data } = await recognize(worker, absolutePath);
      return (data.text ?? '').trim();
    } catch {
      return '';
    }
  }

  async extractImage(absolutePath: string): Promise<{ text: string; words: WordBox[] }> {
    try {
      const worker = await this.getWorker();
      // blocks:true keeps the word hierarchy (with per-word bbox) in the result.
      const { data, rotation, skew } = await recognize(worker, absolutePath);
      const text = (data.text ?? '').trim();
      let width = 0;
      let height = 0;
      try {
        const img = await Jimp.read(absolutePath);
        width = img.bitmap.width;
        height = img.bitmap.height;
      } catch {
        // dimensions unavailable → words emitted without boxes (text still returned)
      }
      // A deskewed pass read a page that had been rotated by a few degrees, and
      // unrotateBox only undoes quarter turns — so its boxes would sit slightly off the
      // words they mark. Text still counts; a highlight in the wrong place does not.
      return { text, words: skew ? [] : collectWords(data, width, height, 1, rotation) };
    } catch {
      return { text: '', words: [] };
    }
  }

  async extractPdf(
    absolutePath: string,
    onlyPages?: number[]
  ): Promise<{ text: string; words: WordBox[]; pages?: { page: number; text: string }[] }> {
    try {
      // Cap OCR pages: the relevant docs (salary slip / ID card) sit in the first
      // pages, and OCRing a long PDF serially on one worker is the slow path.
      // onlyPages narrows to specific pages (mixed digital/scanned PDFs OCR just
      // the pages that have no text layer).
      // The 12-page cap bounds a BLIND whole-document OCR. When the caller already knows
      // exactly which pages lack a text layer, honour that list instead — applying the cap
      // first meant an ID-card page at position 13+ of a bundled claim PDF was never read.
      const pages = onlyPages
        ? await rasterizePdf(absolutePath, MAX_OCR_TARGETED_PAGES, 2, onlyPages)
        : await rasterizePdf(absolutePath, 12);
      if (pages.length === 0) return { text: '', words: [] };
      const worker = await this.getWorker();
      const parts: string[] = [];
      const words: WordBox[] = [];
      const perPage: { page: number; text: string }[] = [];
      let highResBudget = MAX_HIGHRES_RETRY_PAGES;
      for (const pg of pages) {
        let { data, rotation, skew, score } = await recognize(worker, pg.png);
        let dims = { w: pg.width, h: pg.height };

        // Still reading poorly? Render the SAME page larger and look once more, at the
        // configuration that won — a photographed page is usually short of pixels, not
        // badly filtered, and re-sweeping every rotation at this size would not pay.
        if (score < UPRIGHT_SCORE && highResBudget > 0) {
          highResBudget--;
          const [hi] = await rasterizePdf(absolutePath, MAX_OCR_TARGETED_PAGES, HIGH_RASTER_SCALE, [pg.page]);
          const retry = hi && (await recognizeWith(worker, hi.png, rotation, skew !== undefined));
          if (retry && retry.score > score * HIGHRES_GAIN) {
            data = retry.data;
            score = retry.score;
            // Boxes are measured against the image actually recognized.
            dims = { w: hi.width, h: hi.height };
          }
        }

        const t = (data.text ?? '').trim();
        if (t) {
          parts.push(t);
          // Kept verbatim (newlines and all) — the card extractors read line structure.
          perPage.push({ page: pg.page, text: t });
        }
        // Deskewed pages contribute text but no boxes — see extractImage above.
        if (!skew) words.push(...collectWords(data, dims.w, dims.h, pg.page, rotation));
      }
      return { text: parts.join('\n').trim(), words, pages: perPage };
    } catch {
      return { text: '', words: [] };
    }
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}
