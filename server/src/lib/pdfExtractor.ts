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
): Promise<{ text: string; words: WordBox[]; textlessPages: number[] } | null> {
  try {
    // Dynamic import: pdfjs-dist ships ESM-only; NodeNext keeps this a native import()
    // so it loads under both tsx (dev) and compiled dist (prod).
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    const words: WordBox[] = [];
    const parts: string[] = [];
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
        for (const item of content.items as PdfTextItem[]) {
          const str = typeof item.str === 'string' ? item.str : '';
          if (str.trim() === '' || !item.transform) continue;
          pageHasText = true;
          parts.push(str);
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
        if (!pageHasText) textlessPages.push(p);
      }
    } finally {
      await doc.cleanup?.();
      await doc.destroy?.();
    }
    return { text: parts.join(' ').trim(), words, textlessPages };
  } catch {
    return null;
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
