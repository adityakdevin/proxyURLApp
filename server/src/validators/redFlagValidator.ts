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
import { Validator, ValidatorContext, FindingInput } from './types.js';
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

const toFinding = (documentId: string, f: RedFlagFinding): FindingInput => ({
  documentId,
  code: f.code,
  severity: f.severity,
  message: f.message,
  page: f.page ?? null,
  data: f.data,
});

export const redFlagValidator: Validator = {
  key: 'REDFLAG',
  column: 'redFlagStatus',
  async run(ctx) {
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
