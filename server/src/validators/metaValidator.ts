import { promises as fs } from 'fs';
import { basename } from 'path';
import { Validator, ValidatorContext, ValidatorDoc, FindingInput, WordBox, SecondRead } from './types.js';
import { pickImageCheckPages, pickUpscaleRegions, pickCertRescalePages, certRescaleRegion } from './secondReads.js';
import { metaOutcome } from './logic.js';
import {
  extractPdf,
  readPdfInfo,
  largestImageWidthPerPage,
  MAX_PDF_PAGES,
  withActiveTimeout,
  queuedMs,
  PageImage,
} from '../lib/pdfExtractor.js';
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

type ExtractResult = {
  text: string;
  words: WordBox[];
  pageTexts: string[];
  totalPages?: number;
  unreadPages?: number[];
  textLayerPages?: number[];
  pageImages?: Map<number, PageImage>;
  secondReads?: SecondRead[];
};

/** A second-read step starts only with this much of the OCR deadline left. Its rasterizing and
 *  worker start-up run before OCR looks at the deadline (6 IMAGE pages measured 5-11 s on live),
 *  and a read still in flight at the deadline keeps the shared workers busy into the next
 *  document's budget. */
const SECOND_READ_MIN_BUDGET_MS = 30_000;

/** Extra OCR reads, run after the main read and inside the same deadline: the picture under a
 *  text-layer ID or certificate page, then a cropped, upscaled read of a small picture on a
 *  scanned page, and a scale-4 re-read of a scanned civil certificate with no registration
 *  number. They stay out of the page text so no other validator's input changes. A read the
 *  deadline cut is dropped silently: it is not an unread page. The picture scan costs time
 *  before OCR looks at the deadline, so it runs only before the deadline, and each read step
 *  only with SECOND_READ_MIN_BUDGET_MS left: running past it would trip META's overall timeout
 *  and lose the main text. */
async function secondReadsFor(
  ctx: ValidatorContext,
  path: string,
  layer: { pageTexts: string[]; textlessPages: number[] } | null,
  deadline: number,
  mainPages: { page: number; text: string }[] = []
): Promise<Pick<ExtractResult, 'pageImages' | 'secondReads'>> {
  if (!layer) return {};
  // Same clock as TesseractOcrPort.extractPdf: queue time behind other PDFs is not charged.
  const left = () => deadline - (Date.now() - queuedMs());
  if (left() <= 0) return {};
  const reads: SecondRead[] = [];
  let images = new Map<number, PageImage>();
  try {
    const pages = Array.from({ length: layer.pageTexts.length }, (_, i) => i + 1);
    images = (await largestImageWidthPerPage(path, pages)) ?? images;
    const checks = pickImageCheckPages(layer.pageTexts, layer.textlessPages, images);
    if (checks.length > 0 && ctx.ocr.extractPdf && left() >= SECOND_READ_MIN_BUDGET_MS) {
      const r = await ctx.ocr.extractPdf(path, checks, { deadline });
      for (const p of r.pages ?? []) if (p.text) reads.push({ page: p.page, text: p.text, kind: 'IMAGE' });
    }
    // Crops of small pictures come first, then certificate re-reads: the deadline cuts the latest first.
    const tagged = [
      ...pickUpscaleRegions(layer.textlessPages, images).map((region) => ({ region, kind: 'UPSCALE' as const })),
      ...pickCertRescalePages(mainPages, images).map((page) => ({
        region: certRescaleRegion(page),
        kind: 'RESCALE' as const,
      })),
    ];
    if (tagged.length > 0 && ctx.ocr.extractPdfRegions && left() >= SECOND_READ_MIN_BUDGET_MS) {
      const texts = await ctx.ocr.extractPdfRegions(path, tagged.map((t) => t.region), { deadline });
      tagged.forEach((t, i) => {
        const text = texts[i];
        if (text) reads.push({ page: t.region.page, text, kind: t.kind });
      });
    }
  } catch (err) {
    // A failed extra read must never cost the document its main text.
    console.error('[meta] second reads failed', basename(path), err);
  }
  return {
    ...(images.size > 0 ? { pageImages: images } : {}),
    ...(reads.length > 0 ? { secondReads: reads } : {}),
  };
}

async function extract(
  ctx: ValidatorContext,
  doc: ValidatorDoc,
  deadline: number
): Promise<ExtractResult> {
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
    // pdfjs gives text, per-word coordinates and per-page text.
    const withCoords = await extractPdf(doc.readablePath);
    if (withCoords && withCoords.text) {
      const pageTexts = [...withCoords.pageTexts];
      const textless = new Set(withCoords.textlessPages);
      const textLayerPages = pageTexts.map((_, i) => i + 1).filter((p) => !textless.has(p));
      // Mixed PDF: digital pages have a text layer, but scanned pages (bundled
      // ID cards, stamps) don't — OCR just those pages and merge, otherwise
      // they're invisible to every text-based check.
      let unreadPages: number[] | undefined;
      if (withCoords.textlessPages.length > 0 && ctx.ocr.extractPdf) {
        const ocrd = await ctx.ocr.extractPdf(doc.readablePath, withCoords.textlessPages, { deadline });
        // No list AND no text is the port's failure shape ({ text: '', words: [] }, e.g. a
        // Tesseract malloc failure): none of the pages was read, and they must be reported, not
        // judged. A read that returned text without a list did read them.
        unreadPages =
          ocrd.unreadPages ?? (ocrd.text?.trim() ? undefined : withCoords.textlessPages);
        if (ocrd.text) {
          // Merge the OCR'd pages back into their page slots so classification sees them.
          // Prefer the OCR's own per-page text: it keeps the line breaks that the ID-card
          // field extractors anchor on, which a space-join of word boxes throws away.
          const ocrPages =
            ocrd.pages?.map((p) => [p.page - 1, p.text] as const) ??
            pageTextsFromWords(ocrd.words).map((t, i) => [i, t] as const);
          for (const [i, t] of ocrPages) {
            if (t) pageTexts[i] = pageTexts[i] ? `${pageTexts[i]}\n${t}` : t;
          }
          return {
            text: `${withCoords.text}\n${ocrd.text}`,
            words: [...withCoords.words, ...ocrd.words],
            pageTexts,
            totalPages: withCoords.totalPages,
            unreadPages,
            textLayerPages,
            ...(await secondReadsFor(ctx, doc.readablePath, withCoords, deadline, ocrd.pages)),
          };
        }
      }
      // Also reached when OCR finished no page before its deadline (e.g. raster ran past it):
      // the scanned pages are still unread and FULL must say so.
      return {
        text: withCoords.text,
        words: withCoords.words,
        pageTexts,
        totalPages: withCoords.totalPages,
        unreadPages,
        textLayerPages,
        ...(await secondReadsFor(ctx, doc.readablePath, withCoords, deadline)),
      };
    }
    // No text layer → scanned PDF. Rasterize the pages and OCR them.
    if (ctx.ocr.extractPdf) {
      // Pass the textless pages when pdfjs could open the file, so the blind page cap in
      // the OCR only applies to a PDF pdfjs could not read at all.
      const r = await ctx.ocr.extractPdf(doc.readablePath, withCoords?.textlessPages, { deadline });
      // Same reason as the mixed-PDF merge above: keep the OCR's line breaks when it
      // reports per-page text, and only rebuild from word boxes when it doesn't.
      const pageTexts: string[] = [];
      if (r.pages) for (const p of r.pages) pageTexts[p.page - 1] = p.text;
      return {
        ...r,
        pageTexts: r.pages ? pageTexts : pageTextsFromWords(r.words),
        totalPages: r.totalPages,
        unreadPages: r.unreadPages,
        ...(await secondReadsFor(ctx, doc.readablePath, withCoords, deadline, r.pages)),
      };
    }
    return { text: '', words: [], pageTexts: [] };
  }
  return { text: '', words: [], pageTexts: [] };
}

/** Hardening bounds so one huge/slow document can't stall a whole validation run. */
const MAX_FILE_BYTES = 25 * 1024 * 1024; // matches the 25 MB upload limit
const EXTRACT_TIMEOUT_MS = 30_000;
// Scanned PDFs are rasterized and OCR'd page by page (a few lanes at once, see ocrWorkers in
// lib/ocr.ts), far slower than a single image, so give them a wider budget before the run
// gives up on the document.
// 120s was not enough once sideways ID-card pages started being retried at other
// rotations: a real 8-page claim bundle measured 111s here, i.e. it would have timed out
// on any slower machine and produced NOTHING. Validation is a background run, so the cost
// of a wider budget is only that a pathological document occupies the drainer longer.
const PDF_EXTRACT_TIMEOUT_MS = 300_000;
// OCR stops this long before the PDF budget runs out, so it returns the pages it read and
// names the ones it did not, instead of being cut off with nothing.
const OCR_DEADLINE_MARGIN_MS = 20_000;

export const metaValidator: Validator = {
  key: 'META',
  column: 'metaExtractionStatus',
  async run(ctx) {
    let withText = 0;
    const noText: FindingInput[] = [];
    const aiFindings: FindingInput[] = [];
    const truncated: FindingInput[] = [];
    // Extracted text per document, persisted in result.details so the UI can show it.
    // ponytail: 20k chars/doc cap keeps the JSON column and API payload bounded.
    const MAX_DETAIL_CHARS = 20_000;
    const extracted: {
      documentId: string;
      fileName: string;
      text: string;
      truncated: boolean;
      // Per-page text, under the same char budget as `text`. Persisted because a bundle PDF
      // holds several document types, and reading fields off the joined text attributes an
      // invoice's numbers to the Aadhaar page that follows it.
      pages: string[];
      properties: Record<string, string>;
    }[] = [];
    /** Trim page texts so their total stays inside the same budget as the joined text. */
    const cappedPages = (pages: string[]): string[] => {
      const out: string[] = [];
      let left = MAX_DETAIL_CHARS;
      for (const p of pages) {
        if (left <= 0) break;
        out.push(p.slice(0, left));
        left -= Math.min(p.length, left);
      }
      return out;
    };
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
      // Both budgets count only this document's own work: time queued for a pdf.js turn behind
      // the other claim's PDF work is left out of this one (see withActiveTimeout) and of the
      // OCR deadline inside it, which TesseractOcrPort.extractPdf reads on the same clock.
      let timedOut = false;
      const empty = (): Awaited<ReturnType<typeof extract>> => ({ text: '', words: [], pageTexts: [] });
      const deadline = Date.now() + timeoutMs - OCR_DEADLINE_MARGIN_MS;
      const extractedDoc = await withActiveTimeout(
        () => extract(ctx, doc, deadline).catch(empty),
        timeoutMs,
        () => {
          timedOut = true;
          return empty();
        }
      );
      const { text, words, totalPages } = extractedDoc;
      if (extractedDoc.textLayerPages?.length) (ctx.textLayerPages ??= new Map()).set(doc.id, new Set(extractedDoc.textLayerPages));
      // OCR leaves a page that read nothing OUT of its per-page list, and extract() writes
      // pages back by index — so a blank or unreadable page leaves a HOLE. Every reader of
      // these pages iterates them (cappedPages below, DUP, segment, QR) and crashed on the
      // hole with "Cannot read properties of undefined", failing META and with it every
      // check on the claim. An unread page is an empty page, not a missing slot.
      const pageTexts = Array.from(extractedDoc.pageTexts, (t) => t ?? '');
      // A scan that stopped at the page cap must not read as a clean scan. SPELL, INTRA and
      // FULL all work off the text this validator stores, so an unread page is a check that
      // never ran — FULL will report a required document "missing" when it is simply past
      // the cap. META is hidden from reviewers, so this stays a WARNING here and FULL raises
      // the visible red flag from ctx.truncatedPages (security review, 2026-10-13).
      const scanned = Math.min(totalPages ?? 0, MAX_PDF_PAGES);
      if (totalPages && totalPages > scanned) {
        (ctx.truncatedPages ??= new Map()).set(doc.id, { scanned, total: totalPages });
        truncated.push({
          documentId: doc.id,
          code: 'META_PAGES_TRUNCATED',
          severity: 'WARNING',
          message:
            `Only the first ${scanned} of ${totalPages} pages of ${doc.fileName} were read. ` +
            `Pages ${scanned + 1}-${totalPages} were not spell-checked, not searched for the claim ID, ` +
            `and do not count towards the required-document check. Raise SCAN_MAX_PAGES to scan further.`,
          data: { scannedPages: scanned, totalPages },
        });
      }
      const unreadPages = extractedDoc.unreadPages ?? [];
      if (unreadPages.length > 0) {
        (ctx.unreadPages ??= new Map()).set(doc.id, unreadPages);
        truncated.push({
          documentId: doc.id,
          code: 'META_PAGES_UNREAD',
          severity: 'WARNING',
          message:
            `Pages ${unreadPages.join(', ')} of ${doc.fileName} were not read in time. ` +
            `They were not spell-checked, not searched for the claim ID, ` +
            `and do not count towards the required-document check.`,
          data: { unreadPages },
        });
      }
      if (extractedDoc.pageImages) (ctx.pageImages ??= new Map()).set(doc.id, extractedDoc.pageImages);
      if (extractedDoc.secondReads) (ctx.secondReads ??= new Map()).set(doc.id, extractedDoc.secondReads);
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
          pages: cappedPages(pageTexts),
          properties: await documentProperties(doc),
        });
      } else if (timedOut) {
        // A document that ran out of time was never read, which is not the same as a
        // document with no text in it.
        // META is hidden from reviewers, so this stays a WARNING; FULL raises the visible
        // red flag from ctx.unreadPages.
        (ctx.unreadPages ??= new Map()).set(doc.id, 'all');
        noText.push({
          documentId: doc.id,
          code: 'META_EXTRACT_TIMEOUT',
          message: `${doc.fileName} was not read: reading it took longer than ${Math.round(timeoutMs / 1000)}s.`,
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
    // Every unreadable document surfaces, even when other documents DID yield text.
    // Hiding them on an overall pass is what made a skipped employee ID card look like
    // the portal had simply never scanned it — with nothing in the UI to say so.
    const findings = [
      ...aiFindings,
      ...truncated,
      ...noText.map((f) => ({ ...f, severity: 'WARNING' as const })),
    ];
    if (findings.length > 0) outcome.findings = findings;
    if (extracted.length > 0) outcome.details = { extracted };
    return outcome;
  },
};
