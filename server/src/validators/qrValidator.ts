import path from 'path';
import { promises as fs } from 'fs';
import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import { Validator, FindingInput, ValidatorContext, ValidatorDoc } from './types.js';
import { qrOutcome } from './logic.js';
import { classifyPage } from './segment.js';
import { docFieldGroups } from './docFields.js';
import { decodeAadhaarSecureQr, isNumericQrPayload } from './aadhaarSecureQr.js';
import { compareQrToFields, QrFieldComparison } from './qrCompare.js';
import { rasterizePdf } from '../lib/pdfExtractor.js';

// Policy QR codes decode at scale 3; dense ones (Aadhaar Secure QR is ~330
// bytes on a card-sized square) need ~scale 8, which is too heavy to render
// for every page — so pages with no hit at scale 3 get ONE high-res retry.
// Page cap mirrors the OCR one.
const PDF_QR_SCALE = 3;
const PDF_QR_RETRY_SCALE = 8;
// The cheap scale-3 pass covers the whole bundle — scanned motor-claim PDFs run to
// 20-60 pages and the ID card carrying the QR is rarely in the first 12. Only the
// expensive scale-8 re-render stays capped.
const MAX_QR_PAGES = Number(process.env.QR_MAX_PAGES ?? 60);
const MAX_QR_RETRY_PAGES = 12;

/** Render a decoded QR as a stable string: printable text as-is, binary
 *  payloads (Aadhaar Secure QR) as base64 so identical QRs compare equal. */
export function qrValue(text: string, bytes?: Uint8Array): string {
  // Reject CONTROL characters, not "anything non-ASCII". An Aadhaar
  // PrintLetterBarcodeData XML carrying a Devanagari or accented name is perfectly
  // renderable text; the old ASCII-only whitelist turned it into a base64 blob that the
  // UI's XML field parser then never got to see.
  if (text && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) return text.trim();
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
  if (!res) return null;
  // jsQR reports a BYTE-mode payload as data:'' with the bytes in binaryData, so testing
  // `res.data` alone threw away every binary QR it managed to read — including the ones
  // this fallback exists to catch. Route through qrValue so both shapes survive.
  const bytes = res.binaryData ? Uint8Array.from(res.binaryData) : undefined;
  const v = qrValue(res.data ?? '', bytes);
  return v ? v : null;
}

/** All QR values in one image. zxing-cpp (tryHarder + LocalAverage) reads
 *  blurry photocopied QRs that jsQR misses, and returns MULTIPLE symbols per
 *  page; falls back to jsQR only when the wasm module can't load. */
type ZxingReader = typeof import('zxing-wasm/reader');
let zxingPromise: Promise<ZxingReader> | null = null;

/** Load zxing-wasm with the wasm binary that ships INSIDE node_modules.
 *  Its default `locateFile` fetches the module from a public CDN
 *  (fastly.jsdelivr.net), so on a server with no outbound internet — which is the
 *  normal case for an insurer's box — every decode threw and silently degraded to the
 *  much weaker jsQR path, producing "QR is not scanned" for readable codes. */
async function loadZxing(): Promise<ZxingReader> {
  if (!zxingPromise) {
    zxingPromise = (async () => {
      const mod = await import('zxing-wasm/reader');
      const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
      const buf = await fs.readFile(wasmPath);
      // Emscripten wants a plain ArrayBuffer; a Buffer is a view onto a pooled one.
      const wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      mod.prepareZXingModule({ overrides: { wasmBinary } });
      return mod;
    })().catch((e) => {
      zxingPromise = null; // don't cache a rejection — the next document retries
      throw e;
    });
  }
  return zxingPromise;
}

export async function decodeAll(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Promise<string[]> {
  try {
    const { readBarcodes } = await loadZxing();
    const results = await readBarcodes(
      { data, width, height },
      { formats: ['QRCode'], tryHarder: true, binarizer: 'LocalAverage', maxNumberOfSymbols: 4 }
    );
    return results.filter((r) => r.isValid).map((r) => qrValue(r.text, r.bytes));
  } catch (e) {
    // Never silent: a failed wasm load turns every QR check in the system weak.
    console.warn(`[qr] zxing decode unavailable, falling back to jsQR: ${(e as Error).message}`);
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
    const retry = misses.slice(0, MAX_QR_RETRY_PAGES);
    for (const p of await rasterizePdf(absolutePath, MAX_QR_PAGES, PDF_QR_RETRY_SCALE, retry)) {
      for (const value of await decodePage(p)) out.push({ page: p.page, value });
    }
  }
  return out;
}

/** A payload qrValue() could not render as text — PAN and Aadhaar Secure QR codes carry
 *  signed/compressed binary that only the issuer's own reader app can expand into fields. */
export const isOpaqueQrValue = (v: string): boolean => v.startsWith('binary:');

/** Guidance a reviewer can act on when the QR decodes but its contents stay opaque.
 *  ponytail: two constants; move to a master table if the wording needs tuning per client. */
export const OPAQUE_QR_GUIDANCE: Record<string, string> = {
  PAN: 'This PAN QR code is encrypted and cannot be expanded here. Please use the PAN QR Code Reader App to generate the QR code result.',
  AADHAR:
    'This Aadhaar Secure QR code is encrypted and cannot be expanded here. Please use the Aadhaar QR Scanner App to generate the QR code result.',
};

/** PAN / AADHAR, judged from the text META already extracted for this document. */
function govtKindFor(doc: ValidatorDoc, ctx: ValidatorContext): string | null {
  const pages = ctx.pageTexts.get(doc.id);
  const texts = pages && pages.length > 0 ? pages : [ctx.shared.get(doc.id) ?? ''];
  for (const t of texts) {
    const code = classifyPage(t);
    if (code && OPAQUE_QR_GUIDANCE[code]) return code;
  }
  return null;
}

/**
 * The field pane for the page a QR sits on. A bundle holds several documents, so the QR on
 * the policy page must be checked against the POLICY's fields — not against everything the
 * file contains, which would compare a policy number to an Aadhaar.
 */
function fieldsForQrPage(doc: ValidatorDoc, ctx: ValidatorContext, page?: number) {
  const pages = ctx.pageTexts.get(doc.id);
  if (!pages || pages.length === 0) return [];
  const groups = docFieldGroups(pages);
  // No page number (a plain image is one page) → the file's only group, if it has one.
  const group =
    page === undefined
      ? groups.length === 1
        ? groups[0]
        : undefined
      : groups.find((g) => g.pages.includes(page));
  return group?.fields ?? [];
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
    // INFO-level guidance: the QR was read, but its payload is issuer-encrypted.
    const guidance: FindingInput[] = [];
    // Field-by-field verdicts, persisted so the QR tab can show matched/not matched, and
    // ERROR findings for the ones that disagree.
    const comparisons: (QrFieldComparison & { documentId: string; page?: number })[] = [];
    const mismatches: FindingInput[] = [];
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
          // Does the QR agree with what is printed on the same page?
          for (const c of compareQrToFields(h.value, fieldsForQrPage(doc, ctx, h.page))) {
            comparisons.push({ ...c, documentId: doc.id, ...(h.page !== undefined ? { page: h.page } : {}) });
            if (c.verdict === 'MISMATCH') {
              mismatches.push({
                documentId: doc.id,
                code: 'QR_FIELD_MISMATCH',
                severity: 'ERROR',
                message: `QR code says ${c.label} is "${c.qrValue}", but ${doc.fileName} reads "${c.documentValue}".`,
                page: h.page ?? null,
                data: { label: c.label, qrValue: c.qrValue, documentValue: c.documentValue },
              });
            }
          }
        }
        const opaque = hits.find((h) => isOpaqueQrValue(h.value));
        if (opaque) {
          const kind = govtKindFor(doc, ctx);
          if (kind) {
            guidance.push({
              documentId: doc.id,
              code: 'QR_ENCRYPTED_PAYLOAD',
              severity: 'INFO',
              message: OPAQUE_QR_GUIDANCE[kind],
              page: opaque.page ?? null,
              data: { kind },
            });
          }
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
    // A QR that disagrees with its own page fails the check outright: the point of reading
    // it is to confirm the printed values, so "found a QR" is not a pass on its own.
    if (mismatches.length > 0) {
      outcome.status = 'FAILED';
      outcome.summary = `${mismatches.length} field(s) do not match the QR code.`;
    }
    // Documents that decoded nothing are always listed. Hiding them whenever ANY other
    // document had a QR is what made a claim read "1 QR code(s) found across 6" with no
    // hint as to which five were empty.
    outcome.findings = [
      ...mismatches,
      ...guidance,
      ...(values.length === 0 ? missing : missing.map((f) => ({ ...f, severity: 'INFO' as const }))),
    ];
    if (decoded.length > 0) outcome.details = { values, decoded, comparisons };
    return outcome;
  },
};
