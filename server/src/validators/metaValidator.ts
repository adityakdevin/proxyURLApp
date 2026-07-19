import { promises as fs } from 'fs';
// Subpath import avoids pdf-parse's import-time debug-mode test-file read.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Validator, ValidatorContext, ValidatorDoc, FindingInput, WordBox } from './types.js';
import { metaOutcome } from './logic.js';
import { extractPdf, readPdfInfo } from '../lib/pdfExtractor.js';
import { readFileMeta } from '../lib/fileMeta.js';

/** Document properties (created/modified/author/…), NOT body text. PDFs read the Info
 *  dictionary; images read EXIF; both fall back to file size + filesystem mtime so the
 *  panel is never empty. */
async function documentProperties(doc: ValidatorDoc): Promise<Record<string, string>> {
  const props: Record<string, string> = {};
  const mime = doc.mimeType ?? '';
  if (mime === 'application/pdf') {
    Object.assign(props, await readPdfInfo(doc.readablePath));
  } else if (mime.startsWith('image/')) {
    const m = await readFileMeta(doc.readablePath, doc.mimeType);
    if (m.createDate) props.Created = m.createDate;
    if (m.modifyDate) props.Modified = m.modifyDate;
    if (m.software) props.Software = m.software;
    if (m.make) props.Make = m.make;
    if (m.model) props.Model = m.model;
  }
  try {
    const st = await fs.stat(doc.readablePath);
    props['File Size'] = `${(st.size / 1024).toFixed(1)} KB`;
    if (!props.Modified) props.Modified = st.mtime.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    // stat failure → whatever properties we already have
  }
  return props;
}

/** Group per-word OCR/text boxes into per-page text (index 0 = page 1). Words arrive
 *  in reading order per page, so a space-join is a fair reconstruction — good enough
 *  for the page-scoped classification and format rules REDFLAG runs. */
function pageTextsFromWords(words: WordBox[]): string[] {
  const byPage = new Map<number, string[]>();
  for (const w of words) {
    const arr = byPage.get(w.page) ?? [];
    arr.push(w.text);
    byPage.set(w.page, arr);
  }
  const maxPage = words.reduce((m, w) => Math.max(m, w.page), 0);
  const out: string[] = [];
  for (let p = 1; p <= maxPage; p++) out[p - 1] = (byPage.get(p) ?? []).join(' ').trim();
  return out;
}

async function extract(
  ctx: ValidatorContext,
  doc: ValidatorDoc
): Promise<{ text: string; words: WordBox[]; pageTexts: string[] }> {
  const mime = doc.mimeType ?? '';
  if (mime.startsWith('image/')) {
    // A single image is one "page".
    if (ctx.ocr.extractImage) {
      const r = await ctx.ocr.extractImage(doc.readablePath);
      return { ...r, pageTexts: [r.text] };
    }
    const text = await ctx.ocr.extractImageText(doc.readablePath);
    return { text, words: [], pageTexts: [text] };
  }
  if (mime === 'application/pdf') {
    // Prefer pdfjs (text + per-word coordinates + per-page text); fall back to pdf-parse.
    const withCoords = await extractPdf(doc.readablePath);
    if (withCoords && withCoords.text) {
      const pageTexts = [...withCoords.pageTexts];
      // Mixed PDF: digital pages have a text layer, but scanned pages (bundled
      // ID cards, stamps) don't — OCR just those pages and merge, otherwise
      // they're invisible to every text-based check.
      if (withCoords.textlessPages.length > 0 && ctx.ocr.extractPdf) {
        const ocrd = await ctx.ocr.extractPdf(doc.readablePath, withCoords.textlessPages);
        if (ocrd.text) {
          // Merge the OCR'd pages back into their page slots so classification sees them.
          for (const [i, t] of pageTextsFromWords(ocrd.words).entries()) {
            if (t) pageTexts[i] = pageTexts[i] ? `${pageTexts[i]} ${t}` : t;
          }
          return {
            text: `${withCoords.text}\n${ocrd.text}`,
            words: [...withCoords.words, ...ocrd.words],
            pageTexts,
          };
        }
      }
      return { text: withCoords.text, words: withCoords.words, pageTexts };
    }
    try {
      const buf = await fs.readFile(doc.readablePath);
      const data = await pdfParse(buf);
      const text = (data.text ?? '').trim();
      // pdf-parse gives no page boundaries → one page-null unit (spec decision 1 fallback).
      if (text) return { text, words: [], pageTexts: [text] };
    } catch {
      // fall through to OCR
    }
    // No text layer → scanned PDF. Rasterize the pages and OCR them.
    if (ctx.ocr.extractPdf) {
      const r = await ctx.ocr.extractPdf(doc.readablePath);
      return { ...r, pageTexts: pageTextsFromWords(r.words) };
    }
    return { text: '', words: [], pageTexts: [] };
  }
  return { text: '', words: [], pageTexts: [] };
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
      properties: Record<string, string>;
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
      const { text, words, pageTexts } = await withTimeout(extract(ctx, doc), timeoutMs, {
        text: '',
        words: [],
        pageTexts: [],
      });
      if (text && text.replace(/\s/g, '').length >= 3) {
        ctx.shared.set(doc.id, text);
        if (words.length > 0) ctx.wordBoxes.set(doc.id, words);
        if (pageTexts.length > 0) ctx.pageTexts.set(doc.id, pageTexts);
        withText++;
        extracted.push({
          documentId: doc.id,
          fileName: doc.fileName,
          text: text.slice(0, MAX_DETAIL_CHARS),
          truncated: text.length > MAX_DETAIL_CHARS,
          properties: await documentProperties(doc),
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
