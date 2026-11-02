/**
 * REDFLAG validator (Phase 1 High). Runs Indian-document format rules over the
 * classified pages of each document and emits a finding per red flag. Card is FAILED
 * when any ERROR finding fires, PASSED otherwise (WARNING findings — OCR-unreadable
 * candidates, missing-signature — surface but never fail the card).
 *
 *   segment(ctx) ──> group by document ──┬─ per-page format rules (PAN/GST/DL/Udyam/Passport)
 *                                        ├─ cross-page rules (Aadhaar f/b, Voter, Passport)
 *                                        └─ file-level rules (signature, editor watermark, dates)
 *
 * I/O (readPdfInfo for the Producer/Creator watermark check) lives HERE; redFlagLogic
 * and segment stay pure so their unit tests run under jest (spec decision 2).
 */
import { Validator, ValidatorContext, ValidatorDoc, FindingInput, WordBox } from './types.js';
import { BBox, unionBBox } from '../lib/bbox.js';
import { segment, DocInstance } from './segment.js';
import { readPdfInfo, pdfPageTextStats, rasterizePdf, clipToPage, MAX_PDF_PAGES } from '../lib/pdfExtractor.js';
import { Jimp } from 'jimp';
import { signatureArea, signatureExpected, inkFraction, BLANK_INK_MAX } from './signatureBox.js';
import {
  checkPan,
  panRead,
  checkCustomerPanType,
  checkGst,
  checkDl,
  checkUdyam,
  checkPassportNumber,
  checkPassportFileNo,
  checkPassportPages,
  checkPassportMrz,
  checkAadhaar,
  checkAadhaarChecksum,
  cleanRead,
  AadhaarRead,
  aadhaarNumbers,
  checkAadhaarFormat,
  checkVid,
  checkVoterId,
  checkSignature,
  checkSignatoryWord,
  checkEditorWatermark,
  checkTimestamps,
  checkDates,
  checkNominee,
  checkInternetImage,
  checkSpecimenCard,
  checkEditableText,
  ADVISORY_CODES,
  RedFlagFinding,
} from './redFlagLogic.js';
import { classifyDocType } from './crossDocLogic.js';
import { PASSPORT_MRZ } from './logic.js';
import { IDENTIFIER_LABEL } from './dupIdentifiers.js';
import { layerImageMismatches, smallPictureUnread } from './secondReads.js';

/** Per-page format rule per classified type. */
const PAGE_RULES: Record<string, ((text: string, page: number | null) => RedFlagFinding[])[]> = {
  PAN: [checkPan],
  GST: [checkGst],
  DL: [checkDl],
  UDYAM: [checkUdyam],
  PASSPORT: [checkPassportNumber, checkPassportFileNo],
  AADHAR: [checkAadhaarFormat, checkVid],
};

// ── Anchoring a finding to the page ───────────────────────────────────────────────────
// A red flag named a page and stopped there, so a reviewer told "VID is 14 digits, not 16"
// had to hunt page 3 by eye for the number in question. Every rule already quotes the exact
// offending value in its message and carries it in `data`, and META fills ctx.wordBoxes with
// coordinates for scanned AND digital PDFs alike — so the box can simply be looked up.

/** Compare on alphanumerics only: a VID prints as "9876 5432 1098 7654" and is recorded as
 *  "9876543210987654", and a PAN may carry stray punctuation from OCR. */
const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Below this a value is too short to identify one place on a page — a 4-character match
 *  would land on the first coincidence rather than the thing the finding is about. */
const MIN_LOCATABLE = 6;

/** How many consecutive word boxes a single value may span. Four covers a grouped Aadhaar
 *  number; the cap keeps the scan linear and stops a run swallowing half a line. */
const MAX_SPAN = 8;

/** The value this finding is about, if it names one distinctive enough to search for.
 *  Reads `data` generically rather than per-code: every rule stores its candidate there
 *  under its own key ({vid}, {aadhaar}, {pan}, {values: [...]}), and a switch over those
 *  keys is one more place to forget a new rule. */
function locatableValue(data?: Record<string, unknown>): string | null {
  for (const v of Object.values(data ?? {})) {
    const first: unknown = Array.isArray(v) ? v[0] : v;
    // checkAadhaar records {page, num} pairs; reading only plain strings left every
    // Aadhaar mismatch without a highlight (client QA 2026-10).
    const s =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object' && typeof (first as { num?: unknown }).num === 'string'
          ? (first as { num: string }).num
          : null;
    if (s && norm(s).length >= MIN_LOCATABLE) return s;
  }
  return null;
}

/** Where `value` sits on `page`, as one box around it — the FIRST occurrence, matching how
 *  spellValidator consumes word boxes in reading order. Null when the page has no
 *  coordinates (a text-only extraction) or the value cannot be found, in which case the
 *  finding keeps today's page-number-only behaviour rather than pointing somewhere wrong. */
export function locate(boxes: WordBox[], page: number, value: string): BBox | null {
  const target = norm(value);
  const onPage = boxes.filter((b) => b.page === page);
  for (let i = 0; i < onPage.length; i++) {
    let acc = '';
    const run: WordBox[] = [];
    for (let j = i; j < Math.min(i + MAX_SPAN, onPage.length); j++) {
      acc += norm(onPage[j].text);
      run.push(onPage[j]);
      if (acc.includes(target)) {
        const trimmed = trimToValue(run, target);
        // The value must START this run, not sit inside a longer token. A GSTIN contains
        // its own PAN ("27ABCPD1234E1Z5" contains "ABCPD1234E"), so on a page carrying
        // both, a bare substring match boxes the GSTIN when the finding is about the PAN —
        // pointing confidently at the wrong thing, which is worse than not pointing.
        const runText = trimmed.map((b) => norm(b.text)).join('');
        if (runText.startsWith(target)) return unionBBox(trimmed.map((b) => b.bbox));
        break; // this start position only matches mid-token; try the next one
      }
      // Overshot without matching — this start position cannot produce the value.
      if (acc.length > target.length * 2) break;
    }
  }
  return null;
}

/** Drop leading boxes the value does not need. The run is grown from a start position, so
 *  a match found at "VID : 1234 5678" includes the label box — and a highlight around the
 *  label as well as the number is a highlight around the wrong thing. */
function trimToValue(run: WordBox[], target: string): WordBox[] {
  let start = 0;
  while (
    start < run.length - 1 &&
    run
      .slice(start + 1)
      .map((b) => norm(b.text))
      .join('')
      .includes(target)
  ) {
    start++;
  }
  return run.slice(start);
}

const makeToFinding =
  (ctx: ValidatorContext) =>
  (documentId: string, f: RedFlagFinding): FindingInput => {
    const value = f.page != null ? locatableValue(f.data) : null;
    return {
      documentId,
      code: f.code,
      severity: f.severity,
      message: f.message,
      page: f.page ?? null,
      bbox: value ? locate(ctx.wordBoxes.get(documentId) ?? [], f.page!, value) : null,
      data: f.data,
    };
  };

/** govtCodes of identity cards, where a DEMO/SPECIMEN/SAMPLE stamp means a non-issued card. */
const ID_CARD_CODES = new Set(['PAN', 'AADHAR', 'DL', 'VOTER_ID', 'PASSPORT']);

/** Reviewer-facing rule names for the per-rule counts in the card summary. */
const RULE_LABEL: Record<string, string> = {
  REDFLAG_INTERNET_IMAGE: 'Internet image',
  REDFLAG_SPECIMEN_CARD: 'Specimen card',
  REDFLAG_PAN_FORMAT: 'PAN format',
  REDFLAG_PAN_CATEGORY: 'PAN category',
  REDFLAG_PAN_HOLDER_TYPE: 'PAN holder type',
  REDFLAG_PAN_NAME_LETTER: 'PAN 5th letter',
  REDFLAG_AADHAAR_FORMAT: 'Aadhaar format',
  REDFLAG_AADHAAR_MISMATCH: 'Aadhaar front/back',
  REDFLAG_AADHAAR_CHECKSUM: 'Aadhaar check digit',
  REDFLAG_VID_FORMAT: 'VID format',
  REDFLAG_GST_FORMAT: 'GST format',
  REDFLAG_DL_FORMAT: 'DL format',
  REDFLAG_UDYAM_FORMAT: 'Udyam format',
  REDFLAG_PASSPORT_FORMAT: 'Passport format',
  REDFLAG_PASSPORT_FILENO: 'Passport file no.',
  REDFLAG_PASSPORT_MISMATCH: 'Passport page mismatch',
  REDFLAG_PASSPORT_MRZ: 'Passport MRZ check digit',
  REDFLAG_PASSPORT_MRZ_UNSURE: 'Passport MRZ to confirm',
  REDFLAG_PASSPORT_EXPIRED: 'Passport expired',
  REDFLAG_VOTER_MISMATCH: 'Voter ID front/back',
  REDFLAG_SIGNATORY_TYPO: 'Signatory misspelt',
  REDFLAG_AI_WATERMARK: 'AI watermark',
  REDFLAG_EDITOR_WATERMARK: 'Editor watermark',
  REDFLAG_TIMESTAMP_ORDER: 'Modified before created',
  REDFLAG_MODIFIED_AFTER_CREATE: 'Modified after creation',
  REDFLAG_NOMINEE_NO_NAME: 'Nominee without name',
  REDFLAG_BAD_DATE: 'Impossible date',
  REDFLAG_VID_UNREADABLE: 'VID unreadable',
  REDFLAG_PAN_UNREADABLE: 'PAN unreadable',
  REDFLAG_GST_UNREADABLE: 'GSTIN unreadable',
  REDFLAG_DL_UNREADABLE: 'DL unreadable',
  REDFLAG_PASSPORT_UNREADABLE: 'Passport no. unreadable',
  REDFLAG_LAYER_IMAGE_MISMATCH: 'Picture vs text layer',
  REDFLAG_SMALL_IMAGE_UNREAD: 'Small picture, no ID read',
  REDFLAG_PAN_UNSIGNED: 'PAN not signed',
};

const SIGNATURE_RENDER_SCALE = 2;
/** Long-side bound of the clipped render: a large OCR box on a "fit to image" page is otherwise
 *  a multi-megapixel PNG for Jimp to decode synchronously. */
const SIGNATURE_MAX_LONG_SIDE_PX = 2400;

const WHOLE: BBox = { x: 0, y: 0, w: 1, h: 1 };

/** Ink share of `area` in a decoded bitmap. */
function inkOf(img: { bitmap: { width: number; height: number; data: ArrayLike<number> } }, area: BBox): number | null {
  const { width, height, data } = img.bitmap;
  const luma = new Uint8Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return inkFraction(luma, width, height, area);
}

/** Share of a picture's signature area that may be transparent (alpha under 128) and still be
 *  measured. Transparency is neither paper nor ink, and canvas returns it black: a cut-out card's
 *  clear strip read as ink at its edge, and a wholly clear picture as blank paper, an ERROR. */
const TRANSPARENT_MAX = 0.05;

/** Ink share of `area` in a picture file. @napi-rs/canvas decodes it off the main thread
 *  (Jimp.read held the event loop about 0.5-0.9 s on a 12 MP photo) and only the area is copied
 *  out: the pixels inkFraction takes from the whole picture, by its own rounding.
 *  Canvas turns a photo by a standard (SHORT) EXIF Orientation tag as Jimp does, and OCR's boxes
 *  are in Jimp's frame (probed on jimp 1.6.1 and @napi-rs/canvas 1.0.11: orientations 3, 5, 6
 *  and 8, both byte orders). A malformed LONG tag is applied by Jimp only, so such a photo is
 *  measured in the wrong frame.
 *  Canvas cannot decode TIFF, so a picture it cannot open goes to Jimp as before.
 *  Canvas decodes a truncated file and fills the missing part with one colour, which reads as
 *  blank paper. Such a file cannot reach here today: OCR gives a picture word boxes only after
 *  Jimp decodes it (`upscaleSmallImage` in ocr.ts), and Jimp rejects truncation. If OCR's decode
 *  moves to canvas, add a guard against a partial decode here. */
async function pictureInk(file: string, area: BBox): Promise<number | null> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(file).catch(() => null);
  if (!img) return inkOf(await Jimp.read(file), area);
  const x0 = Math.max(0, Math.round(area.x * img.width));
  const y0 = Math.max(0, Math.round(area.y * img.height));
  const w = Math.min(img.width, Math.round((area.x + area.w) * img.width)) - x0;
  const h = Math.min(img.height, Math.round((area.y + area.h) * img.height)) - y0;
  if (w < 1 || h < 1) return null;
  const ctx = createCanvas(w, h).getContext('2d');
  ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) clear++;
  if (clear > TRANSPARENT_MAX * w * h) return null;
  return inkOf({ bitmap: { width: w, height: h, data } }, WHOLE);
}

/** Ink share in the customer's signature area of a PAN page, and that area clamped to
 *  the page; null when there is no anchor, no part of the area is on the page, or the page cannot
 *  be opened.
 *  A PDF renders only the area, so Jimp never decodes a full-page PNG on the main thread (a
 *  "fit to image" page at scale 2 is tens of megapixels). pdf.js still decodes the page's
 *  embedded picture to draw it, as every OCR render does. Under the size bound the clipped
 *  render matches the same pixels of a full render, so the ink share is unchanged. */
export async function signatureInk(
  doc: ValidatorDoc,
  page: number,
  words: WordBox[]
): Promise<{ ink: number; bbox: BBox } | null> {
  // A clip past the page edge renders as white paper, so only the on-page part is measured,
  // and an area with no on-page part is not checked.
  const area = signatureArea(words, page);
  const bbox = area ? clipToPage(area.bbox) : undefined;
  if (!bbox) return null;
  try {
    const mime = doc.mimeType ?? '';
    if (mime === 'application/pdf') {
      const [r] = await rasterizePdf(doc.readablePath, MAX_PDF_PAGES, SIGNATURE_RENDER_SCALE, [page], {
        clip: bbox,
        maxLongSidePx: SIGNATURE_MAX_LONG_SIDE_PX,
      });
      const ink = r ? inkOf(await Jimp.read(r.png), WHOLE) : null;
      return ink === null ? null : { ink, bbox };
    }
    if (!mime.startsWith('image/') || page !== 1) return null;
    const ink = await pictureInk(doc.readablePath, bbox);
    return ink === null ? null : { ink, bbox };
  } catch {
    return null;
  }
}

export const redFlagValidator: Validator = {
  key: 'REDFLAG',
  column: 'redFlagStatus',
  async run(ctx) {
    const toFinding = makeToFinding(ctx);
    const instances = segment(ctx);
    // A document whose main read gave META too little text to store has no pages here, but its
    // pictures and second reads still answer the two picture rules.
    if (instances.length === 0 && !ctx.pageImages?.size && !ctx.secondReads?.size) {
      return { status: 'PASSED', summary: 'No document pages to check.' };
    }

    // Group classified pages by document.
    const byDoc = new Map<string, DocInstance[]>();
    for (const inst of instances) {
      const arr = byDoc.get(inst.documentId) ?? [];
      arr.push(inst);
      byDoc.set(inst.documentId, arr);
    }

    const findings: FindingInput[] = [];
    const pans: { documentId: string; page: number; pan: string }[] = [];
    const aadhaarReads: AadhaarRead[] = [];

    /** The picture rules, which read META's picture scan and second reads, not classified pages. */
    const pictureRules = (doc: ValidatorDoc) => {
      // A page's picture read against its text layer: one of the two was edited.
      for (const read of ctx.secondReads?.get(doc.id) ?? []) {
        if (read.kind !== 'IMAGE') continue;
        const layerText = ctx.pageTexts.get(doc.id)?.[read.page - 1] ?? '';
        for (const m of layerImageMismatches(layerText, read.text)) {
          findings.push({
            documentId: doc.id,
            code: 'REDFLAG_LAYER_IMAGE_MISMATCH',
            severity: 'ERROR',
            message: `${IDENTIFIER_LABEL[m.field]} on page ${read.page} of ${doc.fileName} reads "${m.image}" in the picture but "${m.layer}" in the text layer. One of the two was edited; check the page visually.`,
            page: read.page,
            bbox: ctx.pageImages?.get(doc.id)?.get(read.page)?.box ?? null,
            data: { field: m.field, image: m.image, layer: m.layer },
          });
        }
      }

      // A small ID picture the OCR could not read a number from, even after the second reads.
      // Not on a page OCR never read: that is our failure, and FULL already reports it. Nor on
      // one a cap or the deadline kept from its second read: the message claims a sharper read.
      const unread = ctx.unreadPages?.get(doc.id);
      const skipped = ctx.secondReadsSkipped?.get(doc.id);
      for (const [page, img] of ctx.pageImages?.get(doc.id) ?? []) {
        if (unread === 'all' || unread?.includes(page) || skipped?.includes(page)) continue;
        const texts = [
          ctx.pageTexts.get(doc.id)?.[page - 1] ?? '',
          ...(ctx.secondReads?.get(doc.id) ?? []).filter((r) => r.page === page).map((r) => r.text),
        ];
        if (!smallPictureUnread(img, texts)) continue;
        findings.push({
          documentId: doc.id,
          code: 'REDFLAG_SMALL_IMAGE_UNREAD',
          severity: 'ERROR',
          message: `Page ${page} of ${doc.fileName} is a small picture (${img.width}x${img.height} pixels) and no ID number could be read from it. Check it visually or ask for a clearer copy.`,
          page,
          bbox: img.box ?? null,
          data: { width: img.width, height: img.height },
        });
      }
    };

    for (const doc of ctx.documents) {
      const pages = byDoc.get(doc.id) ?? [];
      if (pages.length === 0) {
        pictureRules(doc);
        continue;
      }
      const codes = new Set(pages.map((p) => p.govtCode));
      const pdf = (doc.mimeType ?? '') === 'application/pdf';
      const stats = pdf ? await pdfPageTextStats(doc.readablePath) : [];

      // Per-page format rules, only on pages classified to that type.
      for (const inst of pages) {
        // Nominee rows sit on insurance pages, which carry no govt code — check every page.
        for (const f of checkNominee(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
        for (const f of checkInternetImage(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
        if (inst.govtCode && ID_CARD_CODES.has(inst.govtCode)) {
          for (const f of checkSpecimenCard(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
        }
        const rules = inst.govtCode ? PAGE_RULES[inst.govtCode] : undefined;
        if (inst.govtCode === 'PAN' || inst.govtCode === 'AADHAR') {
          // Every PAN-shaped token counts (a page can hold a firm's and a partner's card, and an
          // Aadhaar-classified page can carry a PAN scanned beside it); other page types do not
          // (an invoice prints the dealer's PAN). A PAN page with no shaped token keeps panRead's read.
          const shaped = new Set(inst.text.toUpperCase().match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g));
          for (const pan of shaped) pans.push({ documentId: doc.id, page: inst.page ?? 1, pan });
          const read = shaped.size === 0 && inst.govtCode === 'PAN' ? panRead(inst.text) : undefined;
          if (read) pans.push({ documentId: doc.id, page: inst.page ?? 1, pan: read.pan });
        }
        if (inst.govtCode === 'PAN' && inst.page && signatureExpected(inst.text, inst.page)) {
          const m = await signatureInk(doc, inst.page, ctx.wordBoxes.get(doc.id) ?? []);
          if (m && m.ink < BLANK_INK_MAX) {
            findings.push({
              documentId: doc.id,
              code: 'REDFLAG_PAN_UNSIGNED',
              severity: 'ERROR',
              message: `Customer signature box on the PAN card (page ${inst.page}) is blank`,
              page: inst.page,
              bbox: m.bbox,
              data: { inkPct: Math.round(m.ink * 10000) / 100 },
            });
          }
        }
        if (!rules) continue;
        for (const rule of rules) for (const f of rule(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
      }

      pictureRules(doc);

      // Cross-page rules over ALL of this document's pages (a back side may be unclassified).
      const asPages = pages.map((p) => ({ page: p.page ?? 1, text: p.text }));
      if (codes.has('AADHAR')) {
        // An unclassified page right after an Aadhaar page is its back side when it reads like
        // one: an address block and an Aadhaar-shaped number, and not a payslip or invoice whose
        // UAN merely has the shape (security review, 2026-10-13).
        const aadhaarBack = /address|पता|uidai|1947|help@/i;
        const aadhaarPages = asPages.filter(
          (p, i) =>
            pages[i].govtCode === 'AADHAR' ||
            (!pages[i].govtCode &&
              i > 0 &&
              pages[i - 1].govtCode === 'AADHAR' &&
              aadhaarBack.test(p.text) &&
              aadhaarNumbers(p.text).length > 0 &&
              !['PAYSLIP', 'INVOICE', 'INSURANCE', 'RC'].includes(classifyDocType(p.text) ?? ''))
        );
        for (const f of checkAadhaar(aadhaarPages)) findings.push(toFinding(doc.id, f));
        for (const p of aadhaarPages) {
          aadhaarReads.push({
            documentId: doc.id,
            page: p.page,
            text: p.text,
            clean: cleanRead(ctx.textLayerPages?.get(doc.id)?.has(p.page) ?? false, stats[p.page - 1]),
          });
        }
      }
      if (codes.has('VOTER_ID')) {
        // Only the Voter ID's own sides: the bundle's RC or engine-number pages carry
        // AAA9999999-shaped tokens too, and comparing them reported a mismatch on a card
        // whose two sides agree (client QA 2026-10). An unclassified page right after a
        // Voter page is its back side.
        // …but only when it reads like one: on 648914 the page after the Voter ID was a
        // Government of Gujarat card whose "GCN1234567" was compared as the EPIC.
        // The back's constituency line counts too: OCR read 638633's "Electoral Registration
        // Officer" as "EkcomiRegsraion Oficer", so its back (p17) was dropped and the front
        // reported "Back side NA" (client QA 2026-10, #3). Not "facsimile" or "change of
        // address": a policy schedule after the card says both, and its intermediary code was
        // compared as the EPIC (ship review 2026-10-16).
        const voterBack = /elector|election|\bepic\b|voter|मतदाता|निर्वाचन|constituency|registration\s+officer/i;
        const voterPages = asPages.filter(
          (p, i) =>
            pages[i].govtCode === 'VOTER_ID' ||
            (!pages[i].govtCode && i > 0 && pages[i - 1].govtCode === 'VOTER_ID' && voterBack.test(p.text))
        );
        for (const f of checkVoterId(voterPages)) findings.push(toFinding(doc.id, f));
      }
      // Passport pages only: an invoice, visa or policy number is passport-shaped too.
      if (codes.has('PASSPORT')) {
        // A visa page prints "Passport No" and "Nationality", so it classifies PASSPORT and its
        // number joins the comparison. The drop lives here, not in GOVT_TYPE_MARKERS.PASSPORT:
        // Missing Docs' typePresent reuses the marker on whole-document text, and a passport PDF
        // holds visa pages, so excluding "visa" there would call a passport missing when its MRZ
        // is unread. A visa's own MRZ starts "V<", so the MRZ test keeps real passport pages.
        const passportPages = asPages.filter(
          (p, i) => pages[i].govtCode === 'PASSPORT' && (!/\bvisa\b/i.test(p.text) || PASSPORT_MRZ.test(p.text))
        );
        for (const f of checkPassportPages(passportPages)) findings.push(toFinding(doc.id, f));
        // Expiry is judged on the invoice date, not today: a re-validation months later must not turn a
        // passport that was valid at the sale into a red (Decision 11). No invoice date, no expiry check.
        for (const f of checkPassportMrz(passportPages, ctx.claim.invoiceDate)) findings.push(toFinding(doc.id, f));
      }

      // File-level "Every Doc" rules (spec decision 3): whole-document text.
      const fileText = pages.map((p) => p.text).join('\n');
      for (const f of checkSignature(fileText)) findings.push(toFinding(doc.id, f));
      for (const f of checkSignatoryWord(fileText)) findings.push(toFinding(doc.id, f));
      // Dates per page so the finding names a page and can be boxed; the same bad date
      // printed on several pages is reported once.
      const seenDates = new Set<string>();
      for (const inst of pages) {
        for (const f of checkDates(inst.text, inst.page ?? 1)) {
          const key = String(f.data?.date ?? f.message);
          if (seenDates.has(key)) continue;
          seenDates.add(key);
          findings.push(toFinding(doc.id, f));
        }
      }

      // Editor/AI watermark — read the PDF Producer/Creator (I/O; PDFs only).
      if (pdf) {
        const info = await readPdfInfo(doc.readablePath);
        for (const f of checkEditorWatermark(info.Producer, info.Creator)) findings.push(toFinding(doc.id, f));
        // Created vs Modified: the same Info dictionary, so no extra read.
        for (const f of checkTimestamps(info.Created, info.Modified)) findings.push(toFinding(doc.id, f));
        for (const f of checkEditableText(stats, doc.fileName)) findings.push(toFinding(doc.id, f));
      }
    }

    for (const r of checkAadhaarChecksum(aadhaarReads)) findings.push(toFinding(r.documentId, r.finding));

    const holder = checkCustomerPanType(ctx.claim.customerName, pans);
    if (holder) findings.push(toFinding(holder.documentId, holder.finding));

    // Cross-document field consistency lives in Data Compare. Red Flags is the format rules —
    // a malformed PAN, a short VID, an editor watermark.

    const errors = findings.filter((f) => f.severity === 'ERROR').length;
    const warnings = findings.filter((f) => f.severity === 'WARNING').length;
    // Spec asks for "Red Flag and its Count" on most rules, so the summary carries a count
    // per rule, not just the total.
    const counts: Record<string, number> = {};
    for (const f of findings) if (f.severity === 'ERROR') counts[f.code] = (counts[f.code] ?? 0) + 1;
    const perRule = Object.entries(counts)
      .map(([code, n]) => `${RULE_LABEL[code] ?? code.replace(/^REDFLAG_/, '')} ×${n}`)
      .join(', ');
    // INFO findings record checks that PASSED (e.g. a valid PAN and its holder category);
    // they are never a red flag, but they are what tells a reviewer the check ran.
    const advisories = findings.filter((f) => ADVISORY_CODES.has(f.code)).length;
    const notes = findings.length - errors - warnings - advisories;
    if (errors > 0) {
      return {
        status: 'FAILED',
        // Advisories (WARNING) are hidden from reviewers, so the card does not count them.
        summary: `${errors} red flag(s) found: ${perRule}.`,
        findings,
        details: { counts },
      };
    }
    if (instances.length === 0 && findings.length === 0) {
      return { status: 'PASSED', summary: 'No document pages to check.' };
    }
    return {
      status: 'PASSED',
      summary:
        (notes ? `No red flags; ${notes} check(s) verified.` : 'No red flags found.') +
        (advisories ? ` ${advisories} note(s) to look at.` : ''),
      findings: findings.length > 0 ? findings : undefined,
    };
  },
};
