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
import { readPdfInfo } from '../lib/pdfExtractor.js';
import {
  checkPan,
  checkGst,
  checkDl,
  checkUdyam,
  checkPassportNumber,
  checkPassportFileNo,
  checkPassportPages,
  checkAadhaar,
  checkAadhaarFormat,
  checkVid,
  checkVoterId,
  checkSignature,
  checkSignatoryWord,
  checkEditorWatermark,
  checkDates,
  RedFlagFinding,
} from './redFlagLogic.js';

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

/** Compare on alphanumerics only: a VID prints as "9150 6457 2260 8544" and is recorded as
 *  "9150645722608544", and a PAN may carry stray punctuation from OCR. */
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
    const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
    if (s && norm(s).length >= MIN_LOCATABLE) return s;
  }
  return null;
}

/** Where `value` sits on `page`, as one box around it — the FIRST occurrence, matching how
 *  spellValidator consumes word boxes in reading order. Null when the page has no
 *  coordinates (a text-only extraction) or the value cannot be found, in which case the
 *  finding keeps today's page-number-only behaviour rather than pointing somewhere wrong. */
function locate(boxes: WordBox[], page: number, value: string): BBox | null {
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
        const rules = inst.govtCode ? PAGE_RULES[inst.govtCode] : undefined;
        if (!rules) continue;
        for (const rule of rules) for (const f of rule(inst.text, inst.page)) findings.push(toFinding(doc.id, f));
      }

      // Cross-page rules over ALL of this document's pages (a back side may be unclassified).
      const asPages = pages.map((p) => ({ page: p.page ?? 1, text: p.text }));
      if (codes.has('AADHAR')) for (const f of checkAadhaar(asPages)) findings.push(toFinding(doc.id, f));
      if (codes.has('VOTER_ID')) for (const f of checkVoterId(asPages)) findings.push(toFinding(doc.id, f));
      if (codes.has('PASSPORT')) for (const f of checkPassportPages(asPages)) findings.push(toFinding(doc.id, f));

      // File-level "Every Doc" rules (spec decision 3): whole-document text.
      const fileText = pages.map((p) => p.text).join('\n');
      for (const f of checkSignature(fileText)) findings.push(toFinding(doc.id, f));
      for (const f of checkSignatoryWord(fileText)) findings.push(toFinding(doc.id, f));
      for (const f of checkDates(fileText)) findings.push(toFinding(doc.id, f));

      // Editor/AI watermark — read the PDF Producer/Creator (I/O; PDFs only).
      if ((doc.mimeType ?? '') === 'application/pdf') {
        const info = await readPdfInfo(doc.readablePath);
        for (const f of checkEditorWatermark(info.Producer, info.Creator)) findings.push(toFinding(doc.id, f));
      }
    }

    // Cross-document field consistency moved to FULL. Red Flags is the format rules — a
    // malformed PAN, a 14-digit VID, an editor watermark. A value that disagrees BETWEEN
    // documents is a comparison, and Full Scan is the tab named after doing that.

    const errors = findings.filter((f) => f.severity === 'ERROR').length;
    const warnings = findings.filter((f) => f.severity === 'WARNING').length;
    // Spec asks for "Red Flag and its Count" on most rules. Counting per rule code here
    // keeps the number next to the rule that produced it; the summary only has a total.
    const counts: Record<string, number> = {};
    for (const f of findings) if (f.severity === 'ERROR') counts[f.code] = (counts[f.code] ?? 0) + 1;
    // INFO findings record checks that PASSED (e.g. a valid PAN and its holder category);
    // they are never a red flag, but they are what tells a reviewer the check ran.
    const notes = findings.length - errors - warnings;
    if (errors > 0) {
      return {
        status: 'FAILED',
        summary: `${errors} red flag(s) found${warnings ? `, ${warnings} advisory` : ''}.`,
        findings,
        details: { counts },
      };
    }
    return {
      status: 'PASSED',
      summary: warnings
        ? `No red flags; ${warnings} advisory note(s).`
        : notes
        ? `No red flags; ${notes} check(s) verified.`
        : 'No red flags found.',
      findings: findings.length > 0 ? findings : undefined,
    };
  },
};
