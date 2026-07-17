import { promises as fs } from 'fs';
// Subpath import avoids pdf-parse's import-time debug-mode test-file read.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Validator, ValidatorContext, ValidatorDoc, FindingInput, WordBox } from './types.js';
import { metaOutcome } from './logic.js';
import { extractPdf } from '../lib/pdfExtractor.js';
import { readFileMeta } from '../lib/fileMeta.js';

async function extract(
  ctx: ValidatorContext,
  doc: ValidatorDoc
): Promise<{ text: string; words: WordBox[] }> {
  const mime = doc.mimeType ?? '';
  if (mime.startsWith('image/')) {
    if (ctx.ocr.extractImage) return ctx.ocr.extractImage(doc.readablePath);
    return { text: await ctx.ocr.extractImageText(doc.readablePath), words: [] };
  }
  if (mime === 'application/pdf') {
    // Prefer pdfjs (text + per-word coordinates); fall back to text-only pdf-parse.
    const withCoords = await extractPdf(doc.readablePath);
    if (withCoords && withCoords.text) return withCoords;
    try {
      const buf = await fs.readFile(doc.readablePath);
      const data = await pdfParse(buf);
      const text = (data.text ?? '').trim();
      if (text) return { text, words: [] };
    } catch {
      // fall through to OCR
    }
    // No text layer → scanned PDF. Rasterize the pages and OCR them.
    if (ctx.ocr.extractPdf) return ctx.ocr.extractPdf(doc.readablePath);
    return { text: '', words: [] };
  }
  return { text: '', words: [] };
}

/** Hardening bounds so one huge/slow document can't stall a whole validation run. */
const MAX_FILE_BYTES = 25 * 1024 * 1024; // matches the 25 MB upload limit
const EXTRACT_TIMEOUT_MS = 30_000;
// Scanned PDFs are rasterized + OCR'd page-by-page on one worker — far slower than a
// single image, so give them a wider budget before the run gives up on the document.
const PDF_EXTRACT_TIMEOUT_MS = 120_000;

/** Resolve `p`, but fall back to `fallback` if it doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    const finish = (v: T) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    p.then(finish, () => finish(fallback));
  });
}

export const metaValidator: Validator = {
  key: 'META',
  column: 'metaExtractionStatus',
  async run(ctx) {
    let withText = 0;
    const noText: FindingInput[] = [];
    const aiFindings: FindingInput[] = [];
    // Extracted text per document, persisted in result.details so the UI can show it.
    // ponytail: 20k chars/doc cap keeps the JSON column and API payload bounded.
    const MAX_DETAIL_CHARS = 20_000;
    const extracted: {
      documentId: string;
      fileName: string;
      text: string;
      truncated: boolean;
    }[] = [];
    for (const doc of ctx.documents) {
      // Skip oversized files up front — never OCR/parse a 100 MB upload.
      let sizeBytes = 0;
      try {
        sizeBytes = (await fs.stat(doc.readablePath)).size;
      } catch {
        // stat failure (e.g. missing scanned file) → falls through to no-text handling below
      }
      if (sizeBytes > MAX_FILE_BYTES) {
        noText.push({
          documentId: doc.id,
          code: 'META_NO_TEXT',
          message: `${doc.fileName} is too large to scan (${(sizeBytes / 1048576).toFixed(1)} MB).`,
        });
        continue;
      }
      const timeoutMs =
        (doc.mimeType ?? '') === 'application/pdf' ? PDF_EXTRACT_TIMEOUT_MS : EXTRACT_TIMEOUT_MS;
      const { text, words } = await withTimeout(extract(ctx, doc), timeoutMs, {
        text: '',
        words: [],
      });
      if (text && text.replace(/\s/g, '').length >= 3) {
        ctx.shared.set(doc.id, text);
        if (words.length > 0) ctx.wordBoxes.set(doc.id, words);
        withText++;
        extracted.push({
          documentId: doc.id,
          fileName: doc.fileName,
          text: text.slice(0, MAX_DETAIL_CHARS),
          truncated: text.length > MAX_DETAIL_CHARS,
        });
      } else {
        noText.push({
          documentId: doc.id,
          code: 'META_NO_TEXT',
          message: `No readable text could be extracted from ${doc.fileName}.`,
        });
      }
      // AI-origin is ADVISORY: a WARNING finding that never flips the check to FAILED.
      if ((doc.mimeType ?? '').startsWith('image/')) {
        const meta = await readFileMeta(doc.readablePath, doc.mimeType);
        if (meta.aiSignals.length > 0) {
          aiFindings.push({
            documentId: doc.id,
            code: 'META_AI_ORIGIN',
            severity: 'WARNING',
            message: `Possible AI-generated / non-camera origin: ${meta.aiSignals.join('; ')}.`,
            data: { signals: meta.aiSignals, software: meta.software ?? null },
          });
        }
      }
    }
    const outcome = metaOutcome(withText, ctx.documents.length);
    // AI findings always surface; no-text findings only when the check itself failed.
    const findings = [...aiFindings, ...(outcome.status === 'FAILED' ? noText : [])];
    if (findings.length > 0) outcome.findings = findings;
    if (extracted.length > 0) outcome.details = { extracted };
    return outcome;
  },
};
