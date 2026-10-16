import os from 'os';
import path from 'path';
import { Jimp } from 'jimp';
import { createWorker, Worker } from 'tesseract.js';
import { OcrPort, WordBox } from '../validators/types.js';
import { rasterizePdf, MAX_PDF_PAGES } from './pdfExtractor.js';
import { estimateSkewDegrees } from './deskew.js';
import { clamp01 } from './bbox.js';
import { getSpell, isRealWord, type Spell } from '../validators/dictionary.js';

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
 *  Still bounded — a 200-page bundle of scans should not stall a run. Shares the
 *  pipeline-wide ceiling: at 40 while text extraction ran to 50 and the QR scan to 60, a
 *  scanned page at position 45 was silently skipped even when explicitly requested. */
const MAX_OCR_TARGETED_PAGES = MAX_PDF_PAGES;

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
 * How much REAL text a read holds: the dictionary words of 5+ letters in it.
 *
 * A character count cannot separate a sideways page from an upright one, and Tesseract's own
 * confidence scored a sideways Aadhaar card ABOVE its upright reading. Counting word-SHAPED
 * tokens did, until card photos: turned upside down, a card yields MORE letter clusters than
 * upright ("AMRAHS RAMUK IVAR" is "RAVI KUMAR SHARMA" read at 180°), so clear PAN and Aadhaar
 * cards were read the wrong way up and reported missing (client QA 2026-10: 650930 p.7,
 * 301725 p.3-4, 650618 p.7-10), and a card whose background pattern read upright as 145
 * clusters of noise never got a second look (643885 p.6). Real words do not have that flaw:
 * the wrong way up those cards read 0-1 of them, the right way up 2-13.
 *
 * Short dictionary hits are no evidence: noise is full of "ERR", "SEE", "EAR", and with
 * 4-letter words counted, a wrong-way read of "Issue Date ABLE" came within one word of the
 * right-way Aadhaar ("GOVERNMENT Chandra MALE Mobile", 059741 p.9). At 5+ letters it is 1
 * against 3.
 */
export function readScore(text: string, spell: Spell): number {
  return (text.match(/\b[A-Za-z]{5,}\b/g) ?? []).filter((w) => isRealWord(spell, w)).length;
}

/** Word-shaped tokens (3+ letters) in a read, real or not. */
const wordShaped = (text: string) => (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).length;

/**
 * Whether a read holding `real` real words is plainly upright and readable, so no alternative
 * is tried: ten real words, and at least one word-shaped token in ten a real one.
 *
 * This is what keeps the sweep affordable, and it is self-balancing: the pages that are
 * SLOW to OCR are the dense ones, and dense pages clear the bar by a mile (an upright policy
 * page reads 400+ real words). The pages that fall below it are the sparse card photos, which
 * are the fast ones (~0.3s).
 *
 * The share is there for dense pages. Read upside down, a policy page still turns up 20-26
 * dictionary words by chance, but among 400+ letter clusters: measured on 54 claims, no
 * wrong-way-up read reached a 6.2% share, and 176 of 177 upright pages with ten real words
 * were at 10% or more. The exception, a Hindi-heavy Aadhaar letter at 8%, costs a wasted
 * sweep and nothing else.
 */
export function readsAsText(text: string, real: number): boolean {
  return real >= 10 && real * 10 >= wordShaped(text);
}

/**
 * Whether a quarter turn that read `turned` real words is believed over the best upright read
 * (`upright`): it needs at least two, and more than twice as many.
 *
 * Pages mostly arrive the right way up. A turn taken on one stray word was wrong every time
 * it was measured (four upright ID badges and photocopies turned sideways or over, e.g.
 * 616760 p.5), and a narrow lead was no better: a ration card upside down on 2 against 1
 * (739562 p.9), a PAN card sideways on 7 against 6 (321756 p.3). Cards that really were
 * turned win clearly — 13 against 1, 41 against 3 — and the closest real ones were 2 against 0
 * (650618 p.9) and 3 against 1 (059741 p.9).
 */
export function turnBeatsUpright(turned: number, upright: number): boolean {
  return turned >= 2 && turned > 2 * upright;
}

/** Rotate (counter-clockwise, verified against Jimp) and, unless `boost` is off, contrast-boost
 *  a copy to try. */
async function prepare(image: Buffer | string, deg: number, boost = true): Promise<Buffer | null> {
  try {
    const img = await Jimp.read(image as never);
    if (deg) img.rotate(deg);
    if (boost) img.greyscale().contrast(0.5);
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

/**
 * Photos narrower than this are enlarged to it before OCR.
 *
 * Claim photos arrive small: salary slips at ~613x393, employee cards at ~290x450. At that
 * size the print is ~8px tall and Tesseract returns noise — two slips carrying "Dayes",
 * "Profesion" and "Retantion" read as "[REE RR RR EE FREESE…", so the spell check had nothing
 * to check and passed them. PDF pages get a high-resolution second look; photos got none.
 * Measured on the six sample photos: 1600 read both slips (25 → 111 words) and caught "Sing"
 * on one more ID card, with no regressions; 1200 missed that card, 2000 read one slip worse.
 */
const MIN_OCR_IMAGE_WIDTH = 1600;

/**
 * PDF pages get a floor too, on their LONG side: a page that would render shorter than this
 * at the usual scale 2 — a card saved as its own small page — is rendered larger.
 *
 * A voter card saved as a 465x280pt page rendered 930 px wide, and its EPIC ABC1234569 read
 * as ABC1234565 — so the back of the same card, read right, was flagged as a possible misread
 * (638633 p.16). Rendered anywhere from 1163 to 1860 px wide it read right. The
 * high-resolution retry had read it right too, but on 6 real words against 7, and a retry
 * that does not read clearly more is rightly not believed (HIGHRES_GAIN): it was the first
 * look that was short of pixels.
 *
 * 1400, not the photos' 1600: A4 and Letter (1584 px) stay as they are, and so do the pages
 * a little short of them — cropped document scans of 700-790pt, where a few percent more
 * only reshuffled the OCR noise: on 88 claims it lost a PAN number from three such pages and
 * found no marker or number they had missed.
 *
 * The long side, where photos use the width: by width, every portrait A4 page would qualify.
 */
export const MIN_OCR_PAGE_LONG_SIDE = 1400;

/** The image as OCR should see it: small photos enlarged, everything else untouched. */
async function upscaleSmallImage(
  absolutePath: string
): Promise<{ input: Buffer | string; width: number; height: number }> {
  try {
    const img = await Jimp.read(absolutePath);
    const { width, height } = img.bitmap;
    if (width >= MIN_OCR_IMAGE_WIDTH) return { input: absolutePath, width, height };
    img.resize({ w: MIN_OCR_IMAGE_WIDTH });
    return {
      input: Buffer.from(await img.getBuffer('image/png')),
      width: img.bitmap.width,
      height: img.bitmap.height,
    };
  } catch {
    // Unreadable by Jimp → let Tesseract try the file as-is; no dimensions means no boxes.
    return { input: absolutePath, width: 0, height: 0 };
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
 *
 * Those figures are word-shaped tokens; the score is now real words (readScore), still a
 * count. On 118 retries across 54 claims the same 1.4 turned away 7 of the 8 rereads that
 * would have lost a card's PAN/Aadhaar marker.
 */
const HIGHRES_GAIN = 1.4;

/**
 * Recognize with Tesseract's thresholding_method set to Sauvola, a threshold per
 * neighbourhood, instead of its default single global (Otsu) threshold for the whole page.
 *
 * A card printed on a tinted, patterned ground has no one grey level that separates its ink
 * from its background. A clear PAN card photo (301725 p.4) read as "Pern anent Account
 * Number", a name line and noise — no "INCOME TAX DEPARTMENT", no number — so PAN was
 * reported missing; thresholded locally, it read "INCOMETAX DEPARTMENT", the PAN number,
 * the name and the date of birth. It is not short of pixels: rendered 1607 and 1786 px wide
 * instead of 1191, it still read 3 real words and no marker.
 */
async function recognizeSauvola(worker: Worker, png: Buffer) {
  await worker.setParameters({ thresholding_method: '2' });
  try {
    return await worker.recognize(png, {}, { blocks: true });
  } finally {
    // The worker reads every other page in its lane too; put the default back.
    await worker.setParameters({ thresholding_method: '0' });
  }
}

/**
 * Whether the Sauvola read (`sauvola` real words) replaces the best read so far (`first`).
 *
 * The high-resolution retry's HIGHRES_GAIN, for the same reason — it rewrites the whole page
 * — and four real words at least. Below that, one poor read is as likely as another to hold
 * the card's marker. On 88 claims, of the 9 Sauvola reads that cleared the gain on two or
 * three words, one found a marker the first read lacked and two lost one ("INCOME TAX" read
 * as "COMETAX", 632308 p.3; "Male" as "Make", 648687 p.7). The 33 on four or more found 15
 * and lost none.
 */
export function sauvolaWins(sauvola: number, first: number): boolean {
  return sauvola >= 4 && sauvola > first * HIGHRES_GAIN;
}

/** One recognition at a KNOWN configuration — used for the high-resolution second look,
 *  where the winning rotation is already established and re-sweeping would be waste. */
async function recognizeWith(
  worker: Worker,
  image: Buffer,
  { rotation, skew, sauvola }: { rotation: number; skew?: number; sauvola?: boolean }
): Promise<{ data: Awaited<ReturnType<Worker['recognize']>>['data']; score: number } | null> {
  const png =
    skew !== undefined
      ? (await prepareDeskewed(image, rotation))?.png
      : await prepare(image, rotation, !sauvola);
  if (!png) return null;
  const r = sauvola
    ? await recognizeSauvola(worker, png)
    : await worker.recognize(png, {}, { blocks: true });
  return { data: r.data, score: readScore(r.data.text ?? '', await getSpell()) };
}

/**
 * Recognize `image`, falling back to contrast-boosted and rotated copies when the plain
 * upright pass reads as noise. Returns the winning rotation so word boxes can be mapped
 * back to the page as the reviewer sees it.
 */
async function recognize(worker: Worker, image: Buffer | string) {
  const spell = await getSpell();
  const score = (text?: string) => readScore(text ?? '', spell);
  const readable = (b: { data: { text?: string }; score: number }) =>
    readsAsText(b.data.text ?? '', b.score);
  const plain = await worker.recognize(image, {}, { blocks: true });
  let best: {
    data: typeof plain.data;
    rotation: number;
    score: number;
    skew?: number;
    sauvola?: boolean;
  } = {
    data: plain.data,
    rotation: 0,
    score: score(plain.data.text),
  };
  if (readable(best)) return best;
  // Upright-boosted first, so a tie keeps the page the way it was scanned.
  let upright = best.score;
  for (const deg of [0, ...ROTATIONS]) {
    const prepped = await prepare(image, deg);
    if (!prepped) continue;
    const r = await worker.recognize(prepped, {}, { blocks: true });
    const s = score(r.data.text);
    // The boost is there for pages the plain pass read NOTHING from (see ROTATIONS), so its
    // letters replace an empty read even without a real word: FULL flags letter soup as an
    // unreadable page, but takes an empty one for a blank page and says nothing.
    const better =
      deg === 0
        ? s > best.score || wordShaped(best.data.text ?? '') === 0
        : s > best.score && turnBeatsUpright(s, upright);
    if (better) best = { data: r.data, rotation: deg, score: s };
    if (deg === 0) upright = best.score;
    // Once a candidate reads as proper text, stop — the remaining rotations cost seconds
    // each on a dense page and cannot beat a page that is already right way up.
    if (readable(best)) break;
  }

  // Still poor at every quarter turn? The page may be a few degrees off square, which
  // Tesseract barely tolerates. One more pass, squared up at whichever turn read best.
  if (!readable(best)) {
    const straightened = await prepareDeskewed(image, best.rotation);
    if (straightened) {
      const r = await worker.recognize(straightened.png, {}, { blocks: true });
      const s = score(r.data.text);
      if (s > best.score) {
        best = { data: r.data, rotation: best.rotation, score: s, skew: straightened.skew };
      }
    }
  }

  // Still poor? The ink may not separate from a patterned ground at any one grey level. One
  // more pass, thresholded locally, at whichever turn read best — see recognizeSauvola.
  if (!readable(best)) {
    const turned = await prepare(image, best.rotation, false);
    if (turned) {
      const r = await recognizeSauvola(worker, turned);
      const s = score(r.data.text);
      if (sauvolaWins(s, best.score)) {
        best = { data: r.data, rotation: best.rotation, score: s, sauvola: true };
      }
    }
  }
  return best;
}

/**
 * How many Tesseract workers OCR a single document's pages at once.
 *
 * Pages were read strictly one after another on one worker. Measured on production, a
 * scanned 8-page bundle spent 53.5s of a 115s claim inside `recognize` — 46% of the whole
 * run, and all of it serial on one core of four.
 *
 * Default 2, not "number of cores". Each worker is a separate thread holding its own wasm
 * instance and language data, and VALIDATION_CONCURRENCY already runs 2 claims at once, so
 * the default is really 4 workers against 8 GB while QR is rasterising scale-8 canvases
 * alongside. This buys LATENCY on one claim; it does not buy batch throughput, because the
 * box is already CPU-bound with two claims in flight. Raise it with RSS in view.
 */
function ocrWorkers(): number {
  const raw = Number(process.env.OCR_WORKERS ?? 2);
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
}

export class TesseractOcrPort implements OcrPort {
  private workers: Worker[] = [];

  /** Grow the pool to `n` workers and hand back that many. Spun up once per run: creating
   *  one (and loading its language data) costs seconds, far more than any single page. */
  private async getPool(n: number): Promise<Worker[]> {
    while (this.workers.length < n) {
      this.workers.push(await createWorker('eng', undefined, { cachePath: OCR_CACHE_PATH }));
    }
    return this.workers.slice(0, n);
  }

  private async getWorker(): Promise<Worker> {
    return (await this.getPool(1))[0];
  }

  async extractImageText(absolutePath: string): Promise<string> {
    try {
      const worker = await this.getWorker();
      const { input } = await upscaleSmallImage(absolutePath);
      const { data } = await recognize(worker, input);
      return (data.text ?? '').trim();
    } catch {
      return '';
    }
  }

  async extractImage(absolutePath: string): Promise<{ text: string; words: WordBox[] }> {
    try {
      const worker = await this.getWorker();
      // Dimensions are those of the image actually recognized; boxes are normalized to it,
      // so they land in the same place on the original photo.
      const { input, width, height } = await upscaleSmallImage(absolutePath);
      // blocks:true keeps the word hierarchy (with per-word bbox) in the result.
      const { data, rotation, skew } = await recognize(worker, input);
      const text = (data.text ?? '').trim();
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
  ): Promise<{
    text: string;
    words: WordBox[];
    pages?: { page: number; text: string }[];
    totalPages?: number;
  }> {
    try {
      // Cap OCR pages: the relevant docs (salary slip / ID card) sit in the first
      // pages, and OCRing a long PDF serially on one worker is the slow path.
      // onlyPages narrows to specific pages (mixed digital/scanned PDFs OCR just
      // the pages that have no text layer).
      // The 12-page cap bounds a BLIND whole-document OCR. When the caller already knows
      // exactly which pages lack a text layer, honour that list instead — applying the cap
      // first meant an ID-card page at position 13+ of a bundled claim PDF was never read.
      const rasterStartedAt = Date.now();
      const small = { minLongSide: MIN_OCR_PAGE_LONG_SIDE };
      const pages = onlyPages
        ? await rasterizePdf(absolutePath, MAX_OCR_TARGETED_PAGES, 2, onlyPages, small)
        : await rasterizePdf(absolutePath, 12, 2, undefined, small);
      const rasterMs = Date.now() - rasterStartedAt;
      if (pages.length === 0) return { text: '', words: [] };
      // One lane per worker, each pulling the next page off a shared cursor, so a page that
      // needs the full rotation sweep does not hold up the pages behind it. Never more lanes
      // than pages: spinning up a worker costs seconds and an idle one still holds its
      // language data.
      const lanes = Math.min(ocrWorkers(), pages.length);
      const pool = await this.getPool(lanes);
      // Results land BY INDEX, not by completion order. Pages finish out of order once they
      // run in parallel, and the card extractors downstream read line and page structure —
      // text stitched in finishing order is text in the wrong order.
      const perIndex: ({ text: string; words: WordBox[]; page: number } | null)[] = new Array(
        pages.length
      ).fill(null);
      let cursor = 0;
      let highResBudget = MAX_HIGHRES_RETRY_PAGES;
      // META is the most expensive check in a run and reported only one total, so there was
      // no way to tell a slow OCR engine from a slow rasteriser from too many high-res
      // retries — three problems with three different fixes. These sum CPU time across
      // lanes, so with lanes > 1 they deliberately exceed the wall time; the lane count is
      // logged beside them so the two cannot be confused.
      let recognizeMs = 0;
      let retryMs = 0;
      let retries = 0;
      const ocrStartedAt = Date.now();

      await Promise.all(
        pool.map(async (worker) => {
          for (;;) {
            const index = cursor++;
            if (index >= pages.length) return;
            const pg = pages[index];
            const recognizeStartedAt = Date.now();
            const recognized = await recognize(worker, pg.png);
            const { rotation, skew } = recognized;
            let { data, score } = recognized;
            recognizeMs += Date.now() - recognizeStartedAt;
            let dims = { w: pg.width, h: pg.height };

            // Still reading poorly? Render the SAME page larger and look once more, at the
            // configuration that won — a photographed page is usually short of pixels, not
            // badly filtered, and re-sweeping every rotation at this size would not pay.
            //
            // The budget is shared across lanes. Test and decrement sit together with no
            // await between them, so no two lanes can both see the last unit and spend it.
            if (!readsAsText(data.text ?? '', score) && highResBudget > 0) {
              highResBudget--;
              retries++;
              const retryStartedAt = Date.now();
              // Twice the first look, on a small page too.
              const [hi] = await rasterizePdf(
                absolutePath,
                MAX_OCR_TARGETED_PAGES,
                HIGH_RASTER_SCALE,
                [pg.page],
                { minLongSide: 2 * MIN_OCR_PAGE_LONG_SIDE }
              );
              const retry = hi && (await recognizeWith(worker, hi.png, recognized));
              if (retry && retry.score > score * HIGHRES_GAIN) {
                data = retry.data;
                score = retry.score;
                // Boxes are measured against the image actually recognized.
                dims = { w: hi.width, h: hi.height };
              }
              retryMs += Date.now() - retryStartedAt;
            }

            perIndex[index] = {
              text: (data.text ?? '').trim(),
              // Deskewed pages contribute text but no boxes — see extractImage above.
              words: skew ? [] : collectWords(data, dims.w, dims.h, pg.page, rotation),
              page: pg.page,
            };
          }
        })
      );

      const parts: string[] = [];
      const words: WordBox[] = [];
      const perPage: { page: number; text: string }[] = [];
      for (const r of perIndex) {
        if (!r) continue;
        if (r.text) {
          parts.push(r.text);
          // Kept verbatim (newlines and all) — the card extractors read line structure.
          perPage.push({ page: r.page, text: r.text });
        }
        words.push(...r.words);
      }
      console.log(
        `[ocr] ${path.basename(absolutePath).replace(/[\p{C}]/gu, '?')} ${pages.length}p ` +
          `${lanes} lane(s): raster ${rasterMs}ms, ocr wall ${Date.now() - ocrStartedAt}ms ` +
          `(recognize ${recognizeMs}ms cpu, ${retries} high-res retry ${retryMs}ms cpu)`
      );
      return {
        text: parts.join('\n').trim(),
        words,
        pages: perPage,
        totalPages: pages[0].totalPages,
      };
    } catch {
      return { text: '', words: [] };
    }
  }

  async close(): Promise<void> {
    // Every worker, not just the first: a leaked thread holds its wasm instance and language
    // data for the life of the process, and the drainer creates a port per run.
    const open = this.workers;
    this.workers = [];
    await Promise.all(open.map((w) => w.terminate()));
  }
}
