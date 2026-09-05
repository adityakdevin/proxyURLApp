import path from 'path';
import { promises as fs } from 'fs';
import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import { Validator, FindingInput, ValidatorContext, ValidatorDoc } from './types.js';
import { qrOutcome } from './logic.js';
import { classifyPage } from './segment.js';
import { docFieldGroups } from './docFields.js';
import { aadhaarQrAsFields, isUnreadableQrPayload } from './aadhaarSecureQr.js';
import { compareQrToFields, QrFieldComparison } from './qrCompare.js';
import { rasterizePdf, largestImageWidthPerPage, MAX_PDF_PAGES } from '../lib/pdfExtractor.js';
import { BBox, clamp01 } from '../lib/bbox.js';

// Policy QR codes decode at scale 3; dense ones (Aadhaar Secure QR is ~330
// bytes on a card-sized square) need ~scale 8, which is too heavy to render
// for every page — so pages with no hit at scale 3 get ONE high-res retry.
// Page cap mirrors the OCR one.
const PDF_QR_SCALE = 3;
const PDF_QR_RETRY_SCALE = 8;
// The cheap scale-3 pass covers the whole bundle — scanned motor-claim PDFs run to
// 20-60 pages and the ID card carrying the QR is rarely in the first 12. Only the
// expensive scale-8 re-render stays capped.
// Shares the pipeline-wide ceiling (SCAN_MAX_PAGES); QR_MAX_PAGES stays honoured for any
// deployment already setting it.
const MAX_QR_PAGES = Number(process.env.QR_MAX_PAGES ?? MAX_PDF_PAGES);
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

/**
 * Turn a payload we DO understand into readable fields, at the single point where every
 * decode passes through.
 *
 * An Aadhaar Secure QR arrives as a ~3,000-digit number. Expanding it here — into the same
 * "Label:Value|Label:Value" shape the policy QRs already use — is what lets it flow through
 * the rest of the system unchanged: the field comparison parses it, the reviewer's dialog
 * renders it as rows, and the QR-vs-document check finally works on ID cards.
 *
 * Anything we cannot expand is returned untouched, and `isOpaqueQrValue` then keeps it away
 * from the reviewer.
 */
function expandKnownPayload(value: string): string {
  return aadhaarQrAsFields(value) ?? value;
}

/** One decoded QR: its payload, and where it sits on the page it was read from.
 *  The box is what lets the viewer outline the code — without it a QR that read
 *  perfectly showed the reviewer nothing at all on the document. */
export interface QrHit {
  value: string;
  bbox?: BBox;
}

/** Normalize a decoder's corner points to a [0..1] top-left-origin box. Returns undefined
 *  for a decoder that reported no usable position, so the caller degrades to "no outline"
 *  rather than drawing a box at the origin. */
export function cornersToBBox(
  corners: { x: number; y: number }[],
  width: number,
  height: number
): BBox | undefined {
  if (corners.length === 0 || width <= 0 || height <= 0) return undefined;
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = clamp01(Math.min(...xs) / width);
  const y = clamp01(Math.min(...ys) / height);
  const w = clamp01(Math.max(...xs) / width) - x;
  const h = clamp01(Math.max(...ys) / height) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/** Single-QR sync decode via jsQR — the fallback when the zxing wasm can't
 *  load (e.g. under jest, which can't do dynamic import()). */
export function decodePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number
): QrHit | null {
  const res = jsQR(data, width, height);
  if (!res) return null;
  // jsQR reports a BYTE-mode payload as data:'' with the bytes in binaryData, so testing
  // `res.data` alone threw away every binary QR it managed to read — including the ones
  // this fallback exists to catch. Route through qrValue so both shapes survive.
  const bytes = res.binaryData ? Uint8Array.from(res.binaryData) : undefined;
  const v = qrValue(res.data ?? '', bytes);
  if (!v) return null;
  const loc = res.location;
  const bbox = loc
    ? cornersToBBox(
        [loc.topLeftCorner, loc.topRightCorner, loc.bottomLeftCorner, loc.bottomRightCorner],
        width,
        height
      )
    : undefined;
  return { value: expandKnownPayload(v), bbox };
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

/**
 * Set when a decode had to fall back to jsQR. zxing reads blurry and dense codes that jsQR
 * cannot, so once this is true every "no QR found" in the run is suspect: the code may be
 * perfectly readable and the server simply lost the decoder that reads it. Module-level and
 * reset per scan because the fallback happens deep inside a per-page call.
 */
let decoderDegraded = false;

export function resetDecoderDegraded(): void {
  decoderDegraded = false;
}
export function isDecoderDegraded(): boolean {
  return decoderDegraded;
}

export async function decodeAll(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Promise<QrHit[]> {
  try {
    const { readBarcodes } = await loadZxing();
    const results = await readBarcodes(
      { data, width, height },
      { formats: ['QRCode'], tryHarder: true, binarizer: 'LocalAverage', maxNumberOfSymbols: 4 }
    );
    return results
      .filter((r) => r.isValid)
      .map((r) => {
        const p = r.position;
        return {
          value: expandKnownPayload(qrValue(r.text, r.bytes)),
          bbox: p
            ? cornersToBBox([p.topLeft, p.topRight, p.bottomLeft, p.bottomRight], width, height)
            : undefined,
        };
      });
  } catch (e) {
    // Never silent: a failed wasm load turns every QR check in the system weak. The log
    // alone was not enough — it lands in the server journal while the REVIEWER is told the
    // scan is too blurred, so an infrastructure fault reads as a document problem.
    decoderDegraded = true;
    console.warn(`[qr] zxing decode unavailable, falling back to jsQR: ${(e as Error).message}`);
    const hit = decodePixels(data, width, height);
    return hit ? [hit] : [];
  }
}

async function decodeQrImage(absolutePath: string): Promise<QrHit[]> {
  try {
    const img = await Jimp.read(absolutePath);
    const { data, width, height } = img.bitmap;
    return await decodeAll(new Uint8ClampedArray(data), width, height);
  } catch {
    return [];
  }
}

/** What a PDF scan found, plus what it did NOT look at. The skipped counts are returned
 *  rather than swallowed so the validator can tell the reviewer that "no QR found" may
 *  mean "we never rendered that page". */
export interface PdfQrScan {
  hits: (QrHit & { page: number })[];
  /** Pages in the file; 0 when it could not be rendered at all. */
  totalPages: number;
  /** Pages beyond MAX_QR_PAGES that were never scanned. */
  skippedPages: number;
  /** Pages that missed at low resolution and did not fit in the high-res retry budget. */
  skippedRetries: number;
  /** True when zxing was unavailable and the weaker jsQR path did the reading, so a miss
   *  says more about this server than about the document. */
  decoderDegraded: boolean;
}

export async function decodeQrPdf(absolutePath: string): Promise<PdfQrScan> {
  const hits: (QrHit & { page: number })[] = [];
  const decodePage = async (p: { page: number; png: Buffer }): Promise<QrHit[]> => {
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
  const pages = await rasterizePdf(absolutePath, MAX_QR_PAGES, PDF_QR_SCALE);
  const totalPages = pages[0]?.totalPages ?? 0;
  for (const p of pages) {
    const found = await decodePage(p);
    if (found.length > 0) for (const h of found) hits.push({ ...h, page: p.page });
    else misses.push(p.page);
  }
  let skippedRetries = 0;
  if (misses.length > 0) {
    // High-res retry (~1-3s/page render+decode) only for pages that had no QR.
    const retry = misses.slice(0, MAX_QR_RETRY_PAGES);
    skippedRetries = misses.length - retry.length;
    for (const p of await rasterizePdf(absolutePath, MAX_QR_PAGES, PDF_QR_RETRY_SCALE, retry)) {
      for (const h of await decodePage(p)) hits.push({ ...h, page: p.page });
    }
  }
  return {
    hits,
    totalPages,
    skippedPages: Math.max(0, totalPages - pages.length),
    skippedRetries,
    decoderDegraded: isDecoderDegraded(),
  };
}

/**
 * A payload we cannot turn into fields.
 *
 * Shared rather than redefined: "opaque" used to be `startsWith('binary:')` in three
 * separate places, which missed the shape that actually matters — a long DIGIT string. An
 * Aadhaar/PAN secure QR decodes to printable digits, so every one of those tests called it
 * readable text and the reviewer was shown a ~3,000-digit number.
 */
export const isOpaqueQrValue = isUnreadableQrPayload;

/**
 * Guidance a reviewer can act on when a QR reads but its contents cannot be expanded.
 *
 * Deliberately no longer says "encrypted" — neither card's QR is. The Aadhaar Secure QR is
 * gzipped and openly specified (UIDAI publishes it so agencies can verify offline), and we
 * now expand it ourselves, so the AADHAR string is only reached when a payload is damaged.
 * The enhanced PAN QR is signed and bit-packed with no public specification, so "we do not
 * expand it here" is the honest position rather than a claim about cryptography.
 */
export const OPAQUE_QR_GUIDANCE: Record<string, string> = {
  PAN: 'This PAN QR code holds a signed, compressed record that this tool does not expand. It carries the same PAN, name, parent name and date of birth printed on the card — check those against the card face, or scan the physical card with the official PAN QR Code Reader app.',
  AADHAR:
    'This Aadhaar QR code read, but its contents were not in the expected Secure QR format, so it could not be expanded. Scan the physical card with the mAadhaar or Aadhaar QR Scanner app.',
  UNKNOWN:
    "This QR code holds encoded data that this tool does not expand. Scan the physical document with the issuing authority's own reader app.",
};

/**
 * Pages that read as a PAN or Aadhaar card but produced no QR of their own.
 *
 * These are the pages the client asked us to be explicit about. Reported as INFO, not a
 * failure: MEASURED across the sample corpus, most older PAN and Aadhaar designs carry no
 * QR at all, so treating absence as a fault would raise a false alarm on the majority of
 * genuine ID pages.
 */
/**
 * A card image narrower than this is too coarse for a dense ID-card QR.
 *
 * Both PAN and Aadhaar are ID-1 cards, 85.6mm wide, and their secure QR is roughly 20mm
 * square. A PAN Secure QR runs to 77-97 modules across, and a decoder needs about 3 pixels
 * per module to resolve them. That works back to ~1000px across the card.
 *
 * Measured, not guessed: a claim whose card image is 777x488 (~230 DPI) fails on every
 * scale, filter, tile and upscale we can throw at it, while one at 1080x685 (~320 DPI)
 * decodes first time. The threshold sits between them, nearer the failing end so the
 * message only fires when the scan really is the problem.
 */
const MIN_CARD_IMAGE_WIDTH = 1000;

/** ID-1 card width, for turning a pixel count into a DPI a scanner operator can act on. */
const CARD_WIDTH_INCHES = 85.6 / 25.4;

function idCardPagesWithoutQr(
  doc: ValidatorDoc,
  ctx: ValidatorContext,
  hits: { page?: number }[]
): { page: number; kind: string }[] {
  const pages = ctx.pageTexts.get(doc.id);
  if (!pages || pages.length === 0) return [];
  const withQr = new Set(hits.map((h) => h.page).filter((p): p is number => p !== undefined));
  const out: { page: number; kind: string }[] = [];
  pages.forEach((text, i) => {
    const code = classifyPage(text);
    if ((code === 'PAN' || code === 'AADHAR') && !withQr.has(i + 1)) {
      out.push({ page: i + 1, kind: code });
    }
  });
  return out;
}

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
    const decoded: {
      documentId: string;
      fileName: string;
      value: string;
      page?: number;
      bbox?: BBox;
    }[] = [];
    const missing: FindingInput[] = [];
    // A code that read cleanly is evidence too. Without a finding here the reviewer saw a
    // "1 QR code" badge and a completely unmarked page — the code had nothing to anchor to.
    const found: FindingInput[] = [];
    // Pages the scan never rendered. Reported so "no QR code found" cannot be mistaken for
    // "this document carries no QR code".
    const truncated: FindingInput[] = [];
    // INFO-level guidance: the QR was read, but its payload is issuer-encrypted.
    const guidance: FindingInput[] = [];
    // Field-by-field verdicts, persisted so the QR tab can show matched/not matched, and
    // ERROR findings for the ones that disagree.
    const comparisons: (QrFieldComparison & { documentId: string; page?: number })[] = [];
    const mismatches: FindingInput[] = [];
    // Once per run, so a degradation on document 1 still colours the report for document 5.
    // Reset here rather than inside decodeQrPdf: an image decoded after a PDF would
    // otherwise clear a flag the PDF had already raised.
    resetDecoderDegraded();
    for (const doc of scannable) {
      let hits: (QrHit & { page?: number })[];
      if (doc.mimeType === 'application/pdf') {
        const scan = await decodeQrPdf(doc.readablePath);
        hits = scan.hits;
        if (scan.skippedPages > 0) {
          truncated.push({
            documentId: doc.id,
            code: 'QR_PAGES_TRUNCATED',
            severity: 'WARNING',
            message:
              `Only the first ${scan.totalPages - scan.skippedPages} of ${scan.totalPages} pages of ` +
              `${doc.fileName} were scanned for QR codes. A code on pages ` +
              `${scan.totalPages - scan.skippedPages + 1}-${scan.totalPages} would not have been found. ` +
              `Raise SCAN_MAX_PAGES to scan further.`,
            data: { totalPages: scan.totalPages, skippedPages: scan.skippedPages },
          });
        }
        if (scan.skippedRetries > 0) {
          truncated.push({
            documentId: doc.id,
            code: 'QR_RETRY_BUDGET_EXHAUSTED',
            severity: 'WARNING',
            message:
              `${scan.skippedRetries} page(s) of ${doc.fileName} showed no QR at standard resolution ` +
              `and were not re-rendered at high resolution (budget is ${MAX_QR_RETRY_PAGES} pages). ` +
              `A dense code such as a PAN card's needs the high-resolution pass to read.`,
            data: { skippedRetries: scan.skippedRetries, retryBudget: MAX_QR_RETRY_PAGES },
          });
        }
      } else {
        hits = await decodeQrImage(doc.readablePath);
      }
      if (hits.length > 0) {
        for (const h of hits) {
          values.push(h.value);
          decoded.push({
            documentId: doc.id,
            fileName: doc.fileName,
            value: h.value,
            ...(h.page !== undefined ? { page: h.page } : {}),
            ...(h.bbox ? { bbox: h.bbox } : {}),
          });
          // INFO, so it draws the outline and lists in the sidebar without ever changing
          // the check's status (deriveCheckStatus only softens on WARNING).
          found.push({
            documentId: doc.id,
            code: 'QR_FOUND',
            severity: 'INFO',
            message: `QR code read from ${doc.fileName}${h.page !== undefined ? ` page ${h.page}` : ''}.`,
            page: h.page ?? null,
            bbox: h.bbox ?? null,
            data: { value: h.value },
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
                bbox: h.bbox ?? null,
                data: { label: c.label, qrValue: c.qrValue, documentValue: c.documentValue },
              });
            }
          }
        }
        const opaque = hits.find((h) => isOpaqueQrValue(h.value));
        if (opaque) {
          // Fall back to the generic wording rather than staying silent: the kind comes from
          // OCR, and on a poorly-scanned card that returns nothing — which used to mean the
          // reviewer was shown an unexplained payload and no guidance at all.
          const kind = govtKindFor(doc, ctx) ?? 'UNKNOWN';
          guidance.push({
            documentId: doc.id,
            code: 'QR_ENCRYPTED_PAYLOAD',
            severity: 'INFO',
            message: OPAQUE_QR_GUIDANCE[kind] ?? OPAQUE_QR_GUIDANCE.UNKNOWN,
            page: opaque.page ?? null,
            bbox: opaque.bbox ?? null,
            data: { kind },
          });
        }
      } else {
        missing.push({
          documentId: doc.id,
          code: 'QR_MISSING',
          message: `No QR code found in ${doc.fileName}.`,
        });
      }

      // Per-PAGE reporting for ID cards. The check above is per DOCUMENT, so one readable
      // policy QR on page 2 of a bundle silenced the Aadhaar on page 20 entirely. A card
      // page with no QR of its own is what a reviewer is actually being asked to judge.
      const idCardMisses = idCardPagesWithoutQr(doc, ctx, hits);
      // Only parse the file again when there is actually something to explain.
      const cardImages =
        idCardMisses.length > 0 && doc.mimeType === 'application/pdf'
          ? await largestImageWidthPerPage(
              doc.readablePath,
              idCardMisses.map((p) => p.page)
            )
          : new Map<number, { width: number; height: number }>();

      for (const p of idCardMisses) {
        // Do not blame the scan when the server lost its decoder. zxing reads dense and
        // blurry codes that jsQR cannot, so on the fallback path a crisp, perfectly good
        // Aadhaar or PAN QR reads as "missing" — and the reviewer, told it is too blurred,
        // goes looking for a better copy of a document that was never the problem.
        const degraded = isDecoderDegraded();
        const card = p.kind === 'PAN' ? 'a PAN card' : 'an Aadhaar card';
        const img = cardImages.get(p.page);
        // Say WHICH it is. "Too small or blurred" sent reviewers hunting for a better copy
        // of documents that were fine, and left the one real cause — a scanner set too low
        // — invisible. The source width is the measurement that tells them apart.
        const tooCoarse = img !== undefined && img.width < MIN_CARD_IMAGE_WIDTH;
        const dpi = img ? Math.round(img.width / CARD_WIDTH_INCHES) : 0;
        missing.push({
          documentId: doc.id,
          code: 'QR_MISSING',
          severity: 'INFO',
          message: degraded
            ? `No QR code was read on page ${p.page} of ${doc.fileName}, which reads as ` +
              `${card} — but the high-accuracy QR decoder was unavailable on the server for ` +
              `this run, so the weaker fallback did the reading. Treat this as unchecked ` +
              `rather than as a bad scan; the server log records the reason ` +
              `("[qr] zxing decode unavailable").`
            : tooCoarse
              ? `No QR code could be read on page ${p.page} of ${doc.fileName}, which reads ` +
                `as ${card}. The card image in this file is only ${img!.width}x${img!.height} ` +
                `pixels (about ${dpi} DPI), which puts the QR below the detail any reader ` +
                `needs — its squares are under ~2 pixels each, so they blur together in the ` +
                `scan itself. This is not a fault in the document: rescan the card at 400 DPI ` +
                `or higher and it will read.`
              : `No QR code was found on page ${p.page} of ${doc.fileName}, which reads as ` +
                `${card}. Many older card designs carry no QR code at all; if this one does, ` +
                `the scan may be too small or blurred to read it.`,
          page: p.page,
          data: {
            kind: p.kind,
            decoderDegraded: degraded,
            sourceWidth: img?.width,
            sourceHeight: img?.height,
            approxDpi: img ? dpi : undefined,
            tooCoarse,
          },
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
    // Row 19 — bifurcate the column by WHAT happened, not just pass/fail. Ordered by what a
    // reviewer must act on first: a QR contradicting its own page is a DOCUMENT problem, a
    // missing one is a PAPERWORK problem, an undecodable one is a SCAN problem. "OK" also
    // covers a claim with nothing scannable in it — there is no QR to be wrong about.
    outcome.claimFields = {
      qrOutcome:
        mismatches.length > 0
          ? 'MISMATCH'
          : values.length === 0
            ? scannable.length === 0
              ? 'OK'
              : 'NO_QR'
            : guidance.length > 0
              ? 'UNREADABLE'
              : 'OK',
    };
    // Documents that decoded nothing are always listed. Hiding them whenever ANY other
    // document had a QR is what made a claim read "1 QR code(s) found across 6" with no
    // hint as to which five were empty.
    outcome.findings = [
      ...mismatches,
      ...truncated,
      ...guidance,
      ...found,
      ...(values.length === 0 ? missing : missing.map((f) => ({ ...f, severity: 'INFO' as const }))),
    ];
    if (decoded.length > 0) outcome.details = { values, decoded, comparisons };
    return outcome;
  },
};
