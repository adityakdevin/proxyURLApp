import { promises as fs } from 'fs';
import path from 'path';
import { WordBox } from '../validators/types.js';
import { clamp01 } from './bbox.js';

/** Cap pages scanned per PDF so a giant document can't dominate a run. */
const MAX_PDF_PAGES = 50;

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
export async function extractPdf(
  absolutePath: string
): Promise<{ text: string; words: WordBox[]; textlessPages: number[]; pageTexts: string[] } | null> {
  try {
    // Dynamic import: pdfjs-dist ships ESM-only; NodeNext keeps this a native import()
    // so it loads under both tsx (dev) and compiled dist (prod).
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
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
        for (const item of content.items as PdfTextItem[]) {
          const str = typeof item.str === 'string' ? item.str : '';
          if (str.trim() === '' || !item.transform) continue;
          pageHasText = true;
          parts.push(str);
          pageParts.push(str);
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
        if (!pageHasText) textlessPages.push(p);
      }
    } finally {
      await doc.cleanup?.();
      await doc.destroy?.();
    }
    return { text: parts.join(' ').trim(), words, textlessPages, pageTexts };
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
        });
      }
    } finally {
      await doc.cleanup?.();
      await doc.destroy?.();
    }
    return out;
  } catch {
    return [];
  }
}
