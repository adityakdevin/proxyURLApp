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
import { Validator, ValidatorContext, FindingInput, WordBox } from './types.js';
import { BBox, unionBBox } from '../lib/bbox.js';
import { segment, DocInstance } from './segment.js';
import { readPdfInfo, pdfPageTextStats } from '../lib/pdfExtractor.js';
import {
  checkPan,
  checkGst,
  checkDl,
  checkUdyam,
  checkPassportNumber,
  checkPassportFileNo,
  checkPassportPages,
  checkAadhaar,
  aadhaarNumbers,
  checkAadhaarFormat,
  checkVid,
  checkVoterId,
  VOTER_BACK_RE,
  checkSignature,
  checkSignatoryWord,
  checkEditorWatermark,
  checkTimestamps,
  checkDates,
  checkNominee,
  checkEditableText,
  ADVISORY_CODES,
  RedFlagFinding,
} from './redFlagLogic.js';
import { classifyDocType } from './crossDocLogic.js';

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

/** Reviewer-facing rule names for the per-rule counts in the card summary. */
const RULE_LABEL: Record<string, string> = {
  REDFLAG_PAN_FORMAT: 'PAN format',
  REDFLAG_PAN_CATEGORY: 'PAN category',
  REDFLAG_AADHAAR_FORMAT: 'Aadhaar format',
  REDFLAG_AADHAAR_MISMATCH: 'Aadhaar front/back',
  REDFLAG_VID_FORMAT: 'VID format',
  REDFLAG_GST_FORMAT: 'GST format',
  REDFLAG_DL_FORMAT: 'DL format',
  REDFLAG_UDYAM_FORMAT: 'Udyam format',
  REDFLAG_PASSPORT_FORMAT: 'Passport format',
  REDFLAG_PASSPORT_FILENO: 'Passport file no.',
  REDFLAG_PASSPORT_MISMATCH: 'Passport page mismatch',
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
};

export const redFlagValidator: Validator = {
  key: 'REDFLAG',
  column: 'redFlagStatus',
  async run(ctx) {
    const toFinding = makeToFinding(ctx);
    const instances = segment(ctx);
    if (instances.length === 0) {
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
    for (const doc of ctx.documents) {
      const pages = byDoc.get(doc.id) ?? [];
      if (pages.length === 0) continue;
      const codes = new Set(pages.map((p) => p.govtCode));

      // Per-page format rules, only on pages classified to that type.
      for (const inst of pages) {
        // Nominee rows sit on insurance pages, which carry no govt code — check every page.
        for (const f of checkNominee(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
        const rules = inst.govtCode ? PAGE_RULES[inst.govtCode] : undefined;
        if (!rules) continue;
        for (const rule of rules) for (const f of rule(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
      }

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
      }
      if (codes.has('VOTER_ID')) {
        // Only the Voter ID's own sides: the bundle's RC or engine-number pages carry
        // AAA9999999-shaped tokens too, and comparing them reported a mismatch on a card
        // whose two sides agree (client QA 2026-10). An unclassified page right after a
        // Voter page is its back side.
        // …but only when it reads like one: on 648914 the page after the Voter ID was a
        // Government of Gujarat card whose "GCN1234567" was compared as the EPIC.
        // The back's own wording counts too: OCR read 638633's "Electoral Registration Officer"
        // as "EkcomiRegsraion Oficer", so its back (p17) was dropped and the front reported
        // "Back side NA" (client QA 2026-10, #3).
        const voterBack = /elector|election|\bepic\b|voter|मतदाता|निर्वाचन/i;
        const voterPages = asPages.filter(
          (p, i) =>
            pages[i].govtCode === 'VOTER_ID' ||
            (!pages[i].govtCode &&
              i > 0 &&
              pages[i - 1].govtCode === 'VOTER_ID' &&
              (voterBack.test(p.text) || VOTER_BACK_RE.test(p.text)))
        );
        for (const f of checkVoterId(voterPages)) findings.push(toFinding(doc.id, f));
      }
      if (codes.has('PASSPORT')) for (const f of checkPassportPages(asPages)) findings.push(toFinding(doc.id, f));

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
      if ((doc.mimeType ?? '') === 'application/pdf') {
        const info = await readPdfInfo(doc.readablePath);
        for (const f of checkEditorWatermark(info.Producer, info.Creator)) findings.push(toFinding(doc.id, f));
        // Created vs Modified: the same Info dictionary, so no extra read.
        for (const f of checkTimestamps(info.Created, info.Modified)) findings.push(toFinding(doc.id, f));
        const stats = await pdfPageTextStats(doc.readablePath);
        for (const f of checkEditableText(stats, doc.fileName)) findings.push(toFinding(doc.id, f));
      }
    }

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
    return {
      status: 'PASSED',
      summary:
        (notes ? `No red flags; ${notes} check(s) verified.` : 'No red flags found.') +
        (advisories ? ` ${advisories} note(s) to look at.` : ''),
      findings: findings.length > 0 ? findings : undefined,
    };
  },
};
