import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import { Validator, FindingInput } from './types.js';
import { qrOutcome } from './logic.js';
import { rasterizePdf } from '../lib/pdfExtractor.js';

// Policy QR codes decode at scale 3; dense ones (Aadhaar Secure QR is ~330
// bytes on a card-sized square) need ~scale 8, which is too heavy to render
// for every page — so pages with no hit at scale 3 get ONE high-res retry.
// Page cap mirrors the OCR one.
const PDF_QR_SCALE = 3;
const PDF_QR_RETRY_SCALE = 8;
const MAX_QR_PAGES = 12;

/** Render a decoded QR as a stable string: printable text as-is, binary
 *  payloads (Aadhaar Secure QR) as base64 so identical QRs compare equal. */
export function qrValue(text: string, bytes?: Uint8Array): string {
  if (text && /^[\x20-\x7E\s]+$/.test(text)) return text.trim();
  return bytes && bytes.length > 0 ? `binary:${Buffer.from(bytes).toString('base64')}` : text.trim();
}

/** Single-QR sync decode via jsQR — the fallback when the zxing wasm can't
 *  load (e.g. under jest, which can't do dynamic import()). */
export function decodePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number
): string | null {
  const res = jsQR(data, width, height);
  // jsQR can locate a QR but decode a 0-byte payload on low-res rasters —
  // that's a failed decode, not a value.
  return res && res.data ? res.data : null;
}

/** All QR values in one image. zxing-cpp (tryHarder + LocalAverage) reads
 *  blurry photocopied QRs that jsQR misses, and returns MULTIPLE symbols per
 *  page; falls back to jsQR only when the wasm module can't load. */
export async function decodeAll(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Promise<string[]> {
  try {
    const { readBarcodes } = await import('zxing-wasm/reader');
    const results = await readBarcodes(
      { data, width, height },
      { formats: ['QRCode'], tryHarder: true, binarizer: 'LocalAverage', maxNumberOfSymbols: 4 }
    );
    return results.filter((r) => r.isValid).map((r) => qrValue(r.text, r.bytes));
  } catch {
    const v = decodePixels(data, width, height);
    return v ? [v] : [];
  }
}

async function decodeQrImage(absolutePath: string): Promise<string[]> {
  try {
    const img = await Jimp.read(absolutePath);
    const { data, width, height } = img.bitmap;
    return await decodeAll(new Uint8ClampedArray(data), width, height);
  } catch {
    return [];
  }
}

export async function decodeQrPdf(
  absolutePath: string
): Promise<{ page: number; value: string }[]> {
  const out: { page: number; value: string }[] = [];
  const decodePage = async (p: { page: number; png: Buffer }): Promise<string[]> => {
    try {
      const img = await Jimp.read(p.png);
      const { data, width, height } = img.bitmap;
      return await decodeAll(new Uint8ClampedArray(data), width, height);
    } catch {
      return [];
    }
  };
  // rasterizePdf returns [] on any failure, so an unreadable PDF just yields no QR.
  const misses: number[] = [];
  for (const p of await rasterizePdf(absolutePath, MAX_QR_PAGES, PDF_QR_SCALE)) {
    const values = await decodePage(p);
    if (values.length > 0) for (const value of values) out.push({ page: p.page, value });
    else misses.push(p.page);
  }
  if (misses.length > 0) {
    // High-res retry (~1-3s/page render+decode) only for pages that had no QR.
    for (const p of await rasterizePdf(absolutePath, MAX_QR_PAGES, PDF_QR_RETRY_SCALE, misses)) {
      for (const value of await decodePage(p)) out.push({ page: p.page, value });
    }
  }
  return out;
}

export const qrValidator: Validator = {
  key: 'QR',
  column: 'qrStatus',
  async run(ctx) {
    const scannable = ctx.documents.filter(
      (d) => (d.mimeType ?? '').startsWith('image/') || d.mimeType === 'application/pdf'
    );
    const values: string[] = [];
    // Per-document decoded values, persisted in result.details so the UI can show them.
    const decoded: { documentId: string; fileName: string; value: string; page?: number }[] = [];
    const missing: FindingInput[] = [];
    for (const doc of scannable) {
      const hits: { page?: number; value: string }[] =
        doc.mimeType === 'application/pdf'
          ? await decodeQrPdf(doc.readablePath)
          : (await decodeQrImage(doc.readablePath)).map((value) => ({ value }));
      if (hits.length > 0) {
        for (const h of hits) {
          values.push(h.value);
          decoded.push({
            documentId: doc.id,
            fileName: doc.fileName,
            value: h.value,
            ...(h.page !== undefined ? { page: h.page } : {}),
          });
        }
      } else {
        missing.push({
          documentId: doc.id,
          code: 'QR_MISSING',
          message: `No QR code found in ${doc.fileName}.`,
        });
      }
    }
    const outcome = qrOutcome(values.length, scannable.length, values);
    if (outcome.status === 'FAILED') outcome.findings = missing;
    if (decoded.length > 0) outcome.details = { values, decoded };
    return outcome;
  },
};
