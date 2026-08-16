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
 */
export async function extractPdf(absolutePath: string): Promise<{
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
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
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
      await doc.destroy?.();
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
 *  failure or an encrypted/imageless PDF — the caller degrades to file-level metadata. */
export async function readPdfInfo(absolutePath: string): Promise<Record<string, string>> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
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
      await doc.destroy?.();
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

/**
 * Rasterize a PDF's pages to PNG buffers via pdfjs + @napi-rs/canvas. This is the
 * bridge that lets scanned (image-only, no text layer) PDFs be OCR'd — pdfjs text
 * extraction returns '' for them, and Tesseract can't read PDFs directly. `scale`
 * ~2 keeps small print legible to OCR without ballooning render time. Returns [] on
 * any failure so the caller degrades to no-text rather than throwing.
 */
export async function rasterizePdf(
  absolutePath: string,
  maxPages = MAX_PDF_PAGES,
  scale = 2,
  onlyPages?: number[]
): Promise<RasterPage[]> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // @napi-rs/canvas ships prebuilt binaries (incl. Windows) — no node-gyp build.
    const { createCanvas } = await import('@napi-rs/canvas');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    // Without the bundled standard fonts, pages using non-embedded fonts render
    // BLANK in Node ("Requesting object that isn't resolved yet Times_path_…"),
    // which hid whole policy pages from the QR scan and OCR.
    let standardFontDataUrl: string | undefined;
    try {
      standardFontDataUrl = path.join(
        path.dirname(require.resolve('pdfjs-dist/package.json')),
        'standard_fonts/'
      );
    } catch {
      // resolution failure → render without; scanned (image) pages still work
    }
    const doc = await getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl,
    }).promise;
    const out: RasterPage[] = [];
    try {
      const pageCount = Math.min(doc.numPages, maxPages);
      for (let p = 1; p <= pageCount; p++) {
        if (onlyPages && !onlyPages.includes(p)) continue;
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(viewport.width, viewport.height);
        // @napi-rs/canvas's 2D context is API-compatible with what pdfjs renders into;
        // cast through unknown since the DOM lib isn't in this project's tsconfig.
        const canvasContext = canvas.getContext('2d') as unknown;
        await page.render({ canvasContext, viewport } as never).promise;
        out.push({
          page: p,
          png: canvas.toBuffer('image/png'),
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          totalPages: doc.numPages,
        });
      }
    } finally {
      await doc.cleanup?.();
      await doc.destroy?.();
    }
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
 * Returns an empty map rather than throwing — this only ever decorates a message.
 */
export async function largestImageWidthPerPage(
  absolutePath: string,
  pages: number[]
): Promise<Map<number, { width: number; height: number }>> {
  const out = new Map<number, { width: number; height: number }>();
  try {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      let best: { width: number; height: number } | undefined;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
        const name = ops.argsArray[i]?.[0];
        if (typeof name !== 'string') continue;
        const img = await new Promise<unknown>((res) => {
          try {
            page.objs.get(name, res);
          } catch {
            res(null);
          }
        });
        const wh = img as { width?: number; height?: number } | null;
        if (wh?.width && wh?.height && (!best || wh.width > best.width)) {
          best = { width: wh.width, height: wh.height };
        }
      }
      if (best) out.set(n, best);
    }
  } catch {
    // Measurement is a nicety; never let it break a validation run.
  }
  return out;
}
