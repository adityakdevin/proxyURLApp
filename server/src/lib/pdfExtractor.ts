import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'fs';
import path from 'path';
import { WordBox } from '../validators/types.js';
import { clamp01 } from './bbox.js';

/**
 * Cap pages scanned per PDF so a giant document can't dominate a run.
 *
 * ONE ceiling for the whole pipeline. Text extraction, OCR and the QR scan each used to
 * stop at a different page (50 / 40 / 60), so a bundled claim silently lost its QR at one
 * page, its OCR at another and its text at a third — with nothing anywhere saying a page
 * had been skipped. Callers that truncate now report it; see `RasterPage.totalPages` and
 * the *_PAGES_TRUNCATED findings.
 */
export const MAX_PDF_PAGES = Number(process.env.SCAN_MAX_PAGES ?? 60);
// Horizontal bands a page is divided into when judging how much of it the text layer
// actually covers, and the fraction below which the page is treated as mostly picture and
// sent for OCR even though it does carry some text.
const BANDS = 10;
const MIXED_PAGE_COVERAGE = 0.4;

// pdf.js 6 fetches its JPEG 2000 and JBIG2/CCITT wasm decoders through process-wide state that
// every document it opens overwrites, so the first such decode in a process goes through the
// document opened LAST. With two claims validating at once that could be one already closed,
// and the page then waited on a fetch nobody answered (or, opened without wasmUrl, rendered
// blank). So each export below opens its document only once the previous one has finished.
// ponytail: one queue per process; pdf.js already runs its worker on this thread in Node. If
// PDF throughput matters, move pdf.js into worker_threads, which each get their own copy.
let pdfjsTail: Promise<void> = Promise.resolve();
// A document that never settles must not stall every later PDF. Matches the default
// VALIDATION_CHECK_TIMEOUT_MS, by which time the check that opened it has timed out anyway.
const PDFJS_TURN_MAX_MS = 600_000;

/**
 * Time a timed caller has spent queued for a pdf.js turn, so its timeout can leave it
 * out. Without this, one claim's quick read waited behind the other claim's QR raster pass
 * and timed out having done nothing (META then read the document as empty). Nested timers
 * (META's per-document budget inside the per-check one) each see the wait via `parent`.
 */
class QueueWait {
  private queued = 0;
  private since = 0;
  private total = 0;
  constructor(private readonly parent?: QueueWait) {}
  start(): void {
    if (this.queued++ === 0) this.since = performance.now();
    this.parent?.start();
  }
  end(): void {
    if (--this.queued === 0) this.total += performance.now() - this.since;
    this.parent?.end();
  }
  ms(): number {
    return this.total + (this.queued > 0 ? performance.now() - this.since : 0);
  }
}
const queueWait = new AsyncLocalStorage<QueueWait>();

/** Longest delay setTimeout honours; Node fires a longer one after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Queue time of the innermost withActiveTimeout around the caller (0 outside one), so work
 *  inside it can keep a deadline on the same clock as that timeout. */
export function queuedMs(): number {
  return queueWait.getStore()?.ms() ?? 0;
}

/**
 * Run `fn`, settling with `onTimeout()` (or its throw) once `fn` has used `ms` of its own
 * time. Time spent waiting for a pdf.js turn does not count. The work itself is not
 * cancelled: it runs on, and its later queue turns are not charged to anyone.
 */
export function withActiveTimeout<T>(fn: () => Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  const wait = new QueueWait(queueWait.getStore());
  const work = queueWait.run(wait, fn);
  // Monotonic: a wall-clock step (w32time, a VM resume) must not move the deadline.
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<T>((resolve, reject) => {
    const check = () => {
      const left = ms - (performance.now() - startedAt - wait.ms());
      if (left > 0) {
        timer = setTimeout(check, Math.min(left, MAX_TIMER_MS));
        return;
      }
      try {
        resolve(onTimeout());
      } catch (e) {
        reject(e);
      }
    };
    // A longer budget re-checks every MAX_TIMER_MS instead of spinning every 1 ms.
    timer = setTimeout(check, Math.min(ms, MAX_TIMER_MS));
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// Exported for tests only: lets a test hold the queue without a real slow PDF.
export function oneDocumentAtATime<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => {
    const wait = queueWait.getStore();
    wait?.start();
    const run = pdfjsTail.then(() => {
      wait?.end();
      return fn(...args);
    });
    pdfjsTail = pdfjsTail.then(
      () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, PDFJS_TURN_MAX_MS);
          timer.unref();
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          run.then(done, done);
        })
    );
    return run;
  };
}

/** The opened document. Each caller's finally destroys the task only once it has a document,
 *  so a corrupt or encrypted file, which rejects here, would leave its worker and transport
 *  alive: pdf.js does not destroy a task whose document failed to open. The open error is
 *  what the caller reports, so a failed teardown must not replace it. */
function openDocument<D>(task: { promise: Promise<D>; destroy(): Promise<void> }): Promise<D> {
  return task.promise.catch(async (e) => {
    await task.destroy().catch(() => undefined);
    throw e;
  });
}

type Matrix = number[]; // [a, b, c, d, e, f]

/** 2D affine matrix product (same semantics as pdfjs Util.transform). */
export function mulTransform(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Convert one pdfjs text run into normalized ([0..1], top-left) per-word boxes. The page
 * viewport transform already bakes in rotation and the y-flip, so we just multiply and
 * divide by the viewport dimensions. The run width is distributed across whitespace-split
 * words proportionally to character count. Exported for unit testing the coordinate math.
 */
export function runToWords(
  str: string,
  itemTransform: Matrix,
  itemWidth: number,
  itemHeight: number,
  viewportTransform: Matrix,
  vw: number,
  vh: number,
  page: number
): WordBox[] {
  if (str.trim() === '' || !vw || !vh) return [];
  const tx = mulTransform(viewportTransform, itemTransform);
  const fontHeight = Math.hypot(tx[2], tx[3]) || itemHeight;
  const left = tx[4];
  const top = tx[5] - fontHeight; // tx[5] is the baseline; subtract ascent for the top edge
  const scaleX = Math.hypot(viewportTransform[0], viewportTransform[1]);
  const runWidth = itemWidth * scaleX;
  const len = str.length || 1;
  const out: WordBox[] = [];
  let cursor = left;
  for (const token of str.split(/(\s+)/)) {
    const tokW = (token.length / len) * runWidth;
    const t = token.trim();
    if (t) {
      out.push({
        text: t,
        page,
        bbox: {
          x: clamp01(cursor / vw),
          y: clamp01(top / vh),
          w: clamp01(tokW / vw),
          h: clamp01(fontHeight / vh),
        },
      });
    }
    cursor += tokW;
  }
  return out;
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Extract a PDF's text plus per-word NORMALIZED boxes using pdfjs-dist. Returns null on ANY
 * failure (image-only/scanned PDFs still return {text:'',words:[]}; hard errors return null)
 * so the caller can fall back to text-only extraction — highlighting degrades to no boxes.
 *
 * Waits for any PDF this process already has open; see oneDocumentAtATime.
 */
export const extractPdf = oneDocumentAtATime(extractPdfUnqueued);
async function extractPdfUnqueued(absolutePath: string): Promise<{
  text: string;
  words: WordBox[];
  textlessPages: number[];
  pageTexts: string[];
  /** Pages in the file. Compare against MAX_PDF_PAGES to see whether the cap truncated it. */
  totalPages: number;
} | null> {
  try {
    // Dynamic import: pdfjs-dist ships ESM-only; NodeNext keeps this a native import()
    // so it loads under both tsx (dev) and compiled dist (prod).
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const task = getDocument({ data, useSystemFonts: true });
    const doc = await openDocument(task);
    // Read before the finally below destroys the document — the return statement runs after it.
    const totalPages = doc.numPages;
    const words: WordBox[] = [];
    const parts: string[] = [];
    // Per-page text (index 0 = page 1), so REDFLAG/segment can classify and run
    // format rules page-by-page without re-joining word boxes in stream order.
    const pageTexts: string[] = [];
    // Pages with no text layer (scanned images inside an otherwise digital PDF) —
    // the caller OCRs just these so bundled ID-card pages aren't invisible.
    const textlessPages: number[] = [];
    try {
      const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
      for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        let pageHasText = false;
        const pageParts: string[] = [];
        // Which horizontal bands of the page carry text. A page whose text sits in a couple
        // of bands is mostly picture — see the coverage check below.
        const bands = new Set<number>();
        for (const item of content.items as PdfTextItem[]) {
          const str = typeof item.str === 'string' ? item.str : '';
          if (str.trim() === '' || !item.transform) continue;
          pageHasText = true;
          parts.push(str);
          pageParts.push(str);
          // item.transform[5] is the text's y in PDF space (origin bottom-left).
          const y = (item.transform as Matrix)[5];
          if (viewport.height > 0) {
            bands.add(Math.min(BANDS - 1, Math.max(0, Math.floor((y / viewport.height) * BANDS))));
          }
          words.push(
            ...runToWords(
              str,
              item.transform,
              item.width ?? 0,
              item.height ?? 0,
              viewport.transform as Matrix,
              viewport.width,
              viewport.height,
              p
            )
          );
        }
        pageTexts[p - 1] = pageParts.join(' ').trim();
        // A page counts as needing OCR when it has NO text layer, or when what text it has
        // covers only a small band of the page. The second case is the e-PAN / scanned-card
        // page: the card itself is an image and only the legal footer is real text, so the
        // page looked "digital" and its every field stayed invisible to the checks.
        // ponytail: band coverage is a proxy for "mostly picture". If it starts OCRing
        // legitimately sparse pages, gate it on an embedded-image check via getOperatorList.
        if (!pageHasText || bands.size / BANDS < MIXED_PAGE_COVERAGE) textlessPages.push(p);
      }
    } finally {
      await doc.cleanup?.();
      await task.destroy();
    }
    return { text: parts.join(' ').trim(), words, textlessPages, pageTexts, totalPages };
  } catch {
    return null;
  }
}

/** Turn a PDF date string (`D:20250610123456+05'30'`) into a readable ISO-ish stamp.
 *  Leaves anything that isn't a recognisable PDF date untouched. */
export function formatPdfDate(raw: string): string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-].*)?$/.exec(raw.trim());
  if (!m) return raw.trim();
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz] = m;
  const zone = !tz || tz === 'Z' || tz === 'z' ? 'Z' : tz.replace(/'/g, ':').replace(/:$/, '');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}${zone === 'Z' ? ' UTC' : ' ' + zone}`;
}

/** Document properties (Info dictionary + page count), NOT body text. Used by the META
 *  validator so reviewers can see created/modified/author/producer. Returns {} on any
 *  failure or an encrypted/imageless PDF — the caller degrades to file-level metadata.
 *  Waits for any PDF this process already has open; see oneDocumentAtATime. */
export const readPdfInfo = oneDocumentAtATime(readPdfInfoUnqueued);
async function readPdfInfoUnqueued(absolutePath: string): Promise<Record<string, string>> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const task = getDocument({ data, useSystemFonts: true });
    const doc = await openDocument(task);
    const out: Record<string, string> = {};
    try {
      const { info, metadata } = (await doc.getMetadata()) as unknown as {
        info?: Record<string, unknown>;
        metadata?: { getAll?: () => Record<string, unknown> } | null;
      };
      const fields: [string, string][] = [
        ['Title', 'Title'],
        ['Author', 'Author'],
        ['Subject', 'Subject'],
        ['Keywords', 'Keywords'],
        ['Creator', 'Creator'],
        ['Producer', 'Producer'],
        ['CreationDate', 'Created'],
        ['ModDate', 'Modified'],
        ['PDFFormatVersion', 'PDF Version'],
      ];
      for (const [key, label] of fields) {
        const v = info?.[key];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const s = String(v).trim();
        out[label] = key === 'CreationDate' || key === 'ModDate' ? formatPdfDate(s) : s;
      }
      out.Pages = String(doc.numPages);

      // XMP metadata — fills blanks the Info dict dropped (dates/tool often survive a
      // re-save) and carries the edit-trail IDs that flag a tampered document.
      const xmp = metadata?.getAll?.() ?? {};
      const xmpStr = (k: string): string | undefined => {
        const v = xmp[k];
        return v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim();
      };
      const xmpDate = (k: string): string | undefined => {
        const v = xmpStr(k);
        return v ? v.replace('T', ' ').replace(/([+-]\d{2}:\d{2}|Z)$/, (m) => (m === 'Z' ? ' UTC' : ' ' + m)) : undefined;
      };
      const xmpFill: [string, string | undefined][] = [
        ['Created', xmpDate('xmp:createdate')],
        ['Modified', xmpDate('xmp:modifydate')],
        ['Creator', xmpStr('xmp:creatortool')],
        ['Title', xmpStr('dc:title')],
        ['Document ID', xmpStr('xmpmm:documentid')],
        ['Instance ID', xmpStr('xmpmm:instanceid')],
      ];
      for (const [label, v] of xmpFill) if (v && !out[label]) out[label] = v;

      // Security / structure flags — genuine dealer invoices are plain, unsigned PDFs;
      // encryption, signatures, and embedded forms are all worth a reviewer's eye.
      const flag = (k: string) => info?.[k] === true;
      if (info?.EncryptFilterName) out.Encrypted = 'Yes';
      if (flag('IsSignaturesPresent')) out['Digitally Signed'] = 'Yes';
      if (flag('IsAcroFormPresent') || flag('IsXFAPresent')) out['Has Form'] = 'Yes';
      if (flag('IsLinearized')) out.Linearized = 'Yes';
    } finally {
      await doc.cleanup?.();
      await task.destroy();
    }
    return out;
  } catch {
    return {};
  }
}

/** One rendered page: PNG bytes plus the raster dimensions (for box normalization). */
export interface RasterPage {
  page: number;
  png: Buffer;
  width: number;
  height: number;
  /** Pages in the source PDF, not in this array — so a caller can tell that the cap (or an
   *  `onlyPages` filter) left pages unscanned and say so instead of reporting a clean run. */
  totalPages: number;
}

/** The scale to render a `width`x`height`pt page at: `scale`, or more if that would leave its
 *  long side under `minLongSide` px. */
export function rasterScale(width: number, height: number, scale: number, minLongSide: number): number {
  const long = Math.max(width, height);
  return long ? Math.max(scale, minLongSide / long) : scale;
}

/** A directory inside the server's pdfjs-dist, for the asset URLs pdf.js needs in Node.
 *  Always ends in "/": pdf.js 5+ throws on any other ending, and on Windows path.join ends it
 *  in a backslash (fs accepts the mixed separators). Undefined if it cannot be resolved: pdf.js then
 *  degrades rather than fails. */
export function pdfjsAssetDir(sub: string, p: path.PlatformPath = path): string | undefined {
  try {
    return p.join(p.dirname(require.resolve('pdfjs-dist/package.json')), sub).replace(/\\$/, '/');
  } catch {
    return undefined;
  }
}

/** pdf.js 5+ decodes JPEG 2000 and JBIG2 images with wasm from this directory. Without it
 *  those images fail to decode and pdf.js drops them, so a scanned page renders blank. */
const pdfjsWasmUrl = () => pdfjsAssetDir('wasm/');

/**
 * Rasterize a PDF's pages to PNG buffers via pdfjs + @napi-rs/canvas. This is the
 * bridge that lets scanned (image-only, no text layer) PDFs be OCR'd — pdfjs text
 * extraction returns '' for them, and Tesseract can't read PDFs directly. `scale`
 * ~2 keeps small print legible to OCR without ballooning render time. Returns [] on
 * any failure so the caller degrades to no-text rather than throwing.
 *
 * `smooth: false` scales embedded images by nearest neighbour. A phone-scanned card is
 * often a ~110 DPI JPEG drawn up to page size; smoothing blurs its QR modules into each
 * other, and the QR scan missed codes zxing reads from the same page unsmoothed (client
 * QA 2026-10, #34: 642615, 612342, 059741 p15). OCR keeps smoothing — it reads text better.
 *
 * `minLongSide` raises the scale for a page that would otherwise come out shorter than that
 * on its long side — a card saved as its own small page. See MIN_OCR_PAGE_LONG_SIDE in ocr.ts.
 *
 * Waits for any PDF this process already has open; see oneDocumentAtATime.
 */
export const rasterizePdf = oneDocumentAtATime(rasterizePdfUnqueued);
async function rasterizePdfUnqueued(
  absolutePath: string,
  maxPages = MAX_PDF_PAGES,
  scale = 2,
  onlyPages?: number[],
  { smooth = true, minLongSide = 0 }: { smooth?: boolean; minLongSide?: number } = {}
): Promise<RasterPage[]> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // @napi-rs/canvas ships prebuilt binaries (incl. Windows) — no node-gyp build.
    const { createCanvas } = await import('@napi-rs/canvas');
    // Clock starts AFTER the dynamic imports. Node caches them, so they cost something once
    // per process and nothing thereafter — counting them made the first line of a run report
    // a 712ms "load" that was almost entirely module resolution, which is the opposite of
    // the steady-state number this is here to produce.
    const startedAt = Date.now();
    const data = new Uint8Array(await fs.readFile(absolutePath));
    // Without the bundled standard fonts, pages using non-embedded fonts render
    // BLANK in Node ("Requesting object that isn't resolved yet Times_path_…"),
    // which hid whole policy pages from the QR scan and OCR.
    const task = getDocument({
      data,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: pdfjsAssetDir('standard_fonts/'),
      wasmUrl: pdfjsWasmUrl(),
    });
    const doc = await openDocument(task);
    const loadedAt = Date.now();
    const out: RasterPage[] = [];
    try {
      const pageCount = Math.min(doc.numPages, maxPages);
      for (let p = 1; p <= pageCount; p++) {
        if (onlyPages && !onlyPages.includes(p)) continue;
        const page = await doc.getPage(p);
        const { width, height } = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: rasterScale(width, height, scale, minLongSide) });
        const canvas = createCanvas(viewport.width, viewport.height);
        // @napi-rs/canvas's 2D context is API-compatible with what pdfjs renders into;
        // cast through unknown since the DOM lib isn't in this project's tsconfig.
        const canvasContext = canvas.getContext('2d') as unknown;
        // pdfjs sets imageSmoothingEnabled itself per image, so pin it rather than set it once.
        if (!smooth) {
          Object.defineProperty(canvasContext, 'imageSmoothingEnabled', { get: () => false, set: () => {} });
        }
        await page.render({ canvasContext, viewport } as never).promise;
        out.push({
          page: p,
          // encode(), NOT toBuffer(). toBuffer is SYNCHRONOUS: at the QR retry scale of 8 an
          // A4 page is ~4760x6736, so PNG-deflating ~128 MB of RGBA ran on the main thread
          // and froze the whole process for tens of seconds. Prisma's interactive-transaction
          // timeout is a JS timer, so a transaction opened by a check that had already
          // finished expired while this blocked, and the run failed with "Transaction already
          // closed ... however 70368 ms passed" against a 30000 ms budget — numbers that match
          // the QR check's own timings, not any query. It also froze every HTTP request on the
          // box, which is why the claims list crawled during validation. encode() does the
          // same work on the libuv threadpool.
          png: await canvas.encode('png'),
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          totalPages: doc.numPages,
        });
      }
    } finally {
      await doc.cleanup?.();
      await task.destroy();
    }
    // Split LOAD from RENDER, because they answer different questions. Every call re-reads
    // the whole file and re-parses it, and the high-resolution retries in ocr.ts and
    // qrValidator call this once PER PAGE — so a claim can pay two dozen full document loads
    // to render two dozen single pages. Whether that is worth restructuring depends on the
    // load/render split, which nothing was measuring. The filename is operator-supplied, so
    // strip control characters rather than let it forge log lines.
    console.log(
      `[pdf] raster ${path.basename(absolutePath).replace(/[\p{C}]/gu, '?')} scale ${scale}: ` +
        `${out.length}p in ${Date.now() - startedAt}ms ` +
        `(load ${loadedAt - startedAt}ms, render+encode ${Date.now() - loadedAt}ms)`
    );
    return out;
  } catch (e) {
    // Never silent. Every failure here — a missing file, a corrupt or password-protected
    // PDF, a pdfjs import error, or @napi-rs/canvas failing to load its native binary —
    // used to return the same empty array. Downstream that is indistinguishable from "this
    // document genuinely has no QR code", so the REVIEWER was told the scan was too blurred
    // while the truth was that no image ever reached the decoder. Observed in production:
    // a claim reported "No QR code was found" on a page whose QR is large and crisp, and
    // rasterizePdf had returned nothing at every scale with nothing written anywhere.
    console.error(
      `[pdf] rasterize failed for ${absolutePath} (scale ${scale}): ` +
        `${e instanceof Error ? e.message : String(e)}`
    );
    return [];
  }
}

/**
 * The NATIVE pixel width of the largest image embedded on each of the given pages.
 *
 * Rendering tells you nothing about capture. rasterizePdf renders a PAGE at a scale, so a
 * page carrying a 777x488 photo comes out 4760px wide at scale 8 — a clean-looking upscale
 * of data that was never there. A QR whose modules fell below ~2 source pixels each is
 * unreadable by any decoder, and no scale, filter or crop recovers it. This is the only
 * measurement that separates "our decoder missed it" from "the scan does not contain it".
 *
 * Largest image per page, because an ID-card page is one photo plus, sometimes, a small
 * logo or signature strip; the card is the one that matters.
 *
 * Read from the paint operators' own arguments: pdfjs's evaluator puts each image's size there
 * (4.10: paintImageXObject [objId, width, height]; a mask carries an object with width and
 * height), so nothing is decoded or waited for. Not inline images: pdfjs inlines only images
 * under 200 px, never a card, and one on a vector page made it "too coarse" for its QR
 * (ship review r3). Waiting on page.objs for the
 * decoded image is what hung 045360's QR check to the 600s run timeout, when two pages shared
 * an image pdfjs keeps in the document-wide pool. A monochrome scan arrives as an image MASK,
 * which the old lookup never counted (ship review 2026-10-16).
 *
 * A page with no entry paints no image. null when the file could not be read at all: SPELL
 * then leaves its doubtful words alone rather than re-reading a page it could not measure.
 *
 * Waits for any PDF this process already has open; see oneDocumentAtATime.
 */
export const largestImageWidthPerPage = oneDocumentAtATime(largestImageWidthPerPageUnqueued);
async function largestImageWidthPerPageUnqueued(
  absolutePath: string,
  pages: number[]
): Promise<Map<number, { width: number; height: number }> | null> {
  const out = new Map<number, { width: number; height: number }>();
  try {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const task = getDocument({ data, useSystemFonts: false, verbosity: 0, wasmUrl: pdfjsWasmUrl() });
    const doc = await openDocument(task);
    try {
      for (const n of pages) {
        if (n < 1 || n > doc.numPages) continue;
        const page = await doc.getPage(n);
        const ops = await page.getOperatorList();
        let best: { width: number; height: number } | undefined;
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          const args = ops.argsArray[i];
          const [width, height] =
            fn === OPS.paintImageXObject
              ? [args?.[1], args?.[2]]
              : fn === OPS.paintImageMaskXObject
                ? [args?.[0]?.width, args?.[0]?.height]
                : [undefined, undefined];
          if (typeof width === 'number' && typeof height === 'number' && width > 0 && (!best || width > best.width)) {
            best = { width, height };
          }
        }
        if (best) out.set(n, best);
        page.cleanup();
      }
    } finally {
      await doc.cleanup?.();
      await task.destroy();
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * Per page (index 0 = page 1): does it paint an image, and does it draw text a viewer SHOWS?
 * An OCR text layer is drawn invisible (render mode 3) and does not count; real text does,
 * and real text is what an editor can change. Feeds the "text insertable" red-flag rule.
 * Returns [] on any failure — a nicety, never a reason to break a validation run.
 *
 * Waits for any PDF this process already has open; see oneDocumentAtATime.
 */
export const pdfPageTextStats = oneDocumentAtATime(pdfPageTextStatsUnqueued);
async function pdfPageTextStatsUnqueued(
  absolutePath: string,
  maxPages = MAX_PDF_PAGES
): Promise<{ image: boolean; visibleText: boolean; hiddenText: boolean }[]> {
  const out: { image: boolean; visibleText: boolean; hiddenText: boolean }[] = [];
  try {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    // verbosity 0: the operator list makes pdf.js try to load every font, and each one it
    // cannot ("standardFontDataUrl") logs a warning — six per PDF in production. Only paint
    // and text operators are read here, never glyphs, so the fonts are irrelevant.
    const task = getDocument({ data, useSystemFonts: false, verbosity: 0, wasmUrl: pdfjsWasmUrl() });
    const doc = await openDocument(task);
    // Every way a page paints a raster — a monochrome scan arrives as an image MASK — and
    // every text-show operator, including the ' and " shorthands.
    const IMAGE_OPS = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObject,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat,
    ]);
    const TEXT_OPS = new Set([
      OPS.showText,
      OPS.showSpacedText,
      OPS.nextLineShowText,
      OPS.nextLineSetSpacingShowText,
    ]);
    try {
      for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
        const ops = await (await doc.getPage(n)).getOperatorList();
        // The render mode is graphics state: an OCR layer set to invisible inside q/Q is
        // visible again after the Q, so track it on the same save/restore stack.
        let mode = 0;
        const saved: number[] = [];
        const stat = { image: false, visibleText: false, hiddenText: false };
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (fn === OPS.save) saved.push(mode);
          else if (fn === OPS.restore) mode = saved.pop() ?? 0;
          else if (fn === OPS.setTextRenderingMode) mode = ops.argsArray[i][0];
          else if (IMAGE_OPS.has(fn)) stat.image = true;
          else if (TEXT_OPS.has(fn)) {
            // Mode 3 is invisible and 7 only clips: someone's OCR layer, not text a reader sees.
            if (mode === 3 || mode === 7) stat.hiddenText = true;
            if (mode !== 3) stat.visibleText = true;
          }
        }
        out.push(stat);
      }
    } finally {
      await task.destroy();
    }
  } catch {
    return [];
  }
  return out;
}
