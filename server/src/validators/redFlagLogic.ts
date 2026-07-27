/**
 * Pure rule functions for the REDFLAG validator (Phase 1 High). No I/O, no pdfjs —
 * every function takes plain text and returns findings, so each is unit-testable with
 * string fixtures (spec decision 2: no extraction in this module).
 *
 * Three-outcome discipline (spec decision 9): a rule only RED-FLAGS a clean candidate
 * that fails its format. A candidate that is merely OCR-garbled is ADVISORY (WARNING),
 * never a hard fail — that separation is the top defence against false positives. No
 * candidate at all → the rule stays silent (this document simply doesn't carry that field).
 *
 *   text ──> extract label-anchored candidate ──> classify
 *                                                   ├─ valid format      → ok (no finding, maybe category)
 *                                                   ├─ OCR-adjacent      → WARNING "unreadable"
 *                                                   └─ clean but invalid → ERROR   "malformed" (red flag)
 */
import { editDistanceCapped, isDoubtfulHit } from './logic.js';

export interface RedFlagFinding {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  page?: number | null;
  data?: Record<string, unknown>;
}

const err = (code: string, message: string, page: number | null, data?: Record<string, unknown>): RedFlagFinding => ({
  code,
  message,
  severity: 'ERROR',
  page,
  data,
});
const warn = (code: string, message: string, page: number | null): RedFlagFinding => ({
  code,
  message,
  severity: 'WARNING',
  page,
});
/** A check that PASSED, recorded so a reviewer can see it ran — reviewers reported
 *  "basic checks are not getting identified" when a valid document produced no output. */
const info = (code: string, message: string, page: number | null, data?: Record<string, unknown>): RedFlagFinding => ({
  code,
  message,
  severity: 'INFO',
  page,
  data,
});

/** Strip spaces/hyphens/dots that OCR sprinkles into ID numbers. */
export function stripSep(s: string): string {
  return s.replace(/[\s.\-]/g, '');
}

/** Characters OCR routinely confuses, and their alternate reading. */
const OCR_ALT: Record<string, string> = {
  O: '0', '0': 'O', I: '1', '1': 'I', L: '1', S: '5', '5': 'S', B: '8', '8': 'B', Z: '2', '2': 'Z',
};

/** Is `raw` a plausible OCR misread of a token that WOULD match `shape`? True only when
 *  it doesn't already match but some combination of single-char OCR swaps makes it match.
 *  Routes a failing candidate to "unreadable" (advisory) instead of "malformed" (red flag).
 *  Bounded: gives up past 8 ambiguous positions (256 combos) so it stays O(1) per call. */
export function ocrAdjacent(raw: string, shape: RegExp): boolean {
  const s = stripSep(raw).toUpperCase();
  const body = shape.source.replace(/^\^/, '').replace(/\$$/, '');
  const re = new RegExp(`^${body}$`);
  if (re.test(s)) return false; // already valid → not "unreadable"
  const ambig: number[] = [];
  for (let i = 0; i < s.length; i++) if (OCR_ALT[s[i]]) ambig.push(i);
  if (ambig.length === 0 || ambig.length > 8) return false;
  for (let mask = 1; mask < 1 << ambig.length; mask++) {
    const arr = [...s];
    for (let b = 0; b < ambig.length; b++) if (mask & (1 << b)) arr[ambig[b]] = OCR_ALT[arr[ambig[b]]];
    if (re.test(arr.join(''))) return true;
  }
  return false;
}

/** Pull the token following a label ("PAN No: XXX"), else the first token matching a
 *  loose scan pattern. Returns undefined when neither hits — that's the "absent" outcome. */
export function labeledCandidate(text: string, label: RegExp, scan: RegExp): string | undefined {
  // `label` MUST use only non-capturing groups so the value is capture group 1.
  // The captured token excludes whitespace so it stops at the number and doesn't
  // swallow the following words.
  // Wrap the label so its own `|` alternation doesn't detach the value capture group.
  // Also swallow a "No"/"Number"/"#" noise word that sits between label and value.
  const labelled = new RegExp(
    `(?:${label.source})\\s*(?:no\\.?|number|#)?\\s*[:\\-]?\\s*([A-Z0-9][A-Z0-9.\\-]{4,20})`,
    'i'
  ).exec(text);
  if (labelled) {
    const tok = stripSep(labelled[1]).toUpperCase();
    if (tok.length >= 5) return tok;
  }
  const scanned = scan.exec(text.toUpperCase());
  return scanned ? stripSep(scanned[0]) : undefined;
}

// ── PAN ────────────────────────────────────────────────────────────────────────
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** 4th char = holder category. */
export const PAN_CATEGORY: Record<string, string> = {
  P: 'Individual',
  F: 'Firm/LLP',
  C: 'Company',
  H: 'HUF',
  A: 'Association of Persons',
  T: 'Trust',
  B: 'Body of Individuals',
  L: 'Local Authority',
  J: 'Artificial Juridical Person',
  G: 'Government',
};

export function checkPan(text: string, page: number | null = null): RedFlagFinding[] {
  const cand = labeledCandidate(text, /\bP\.?A\.?N\b|permanent\s+account\s+number/i, /\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
  if (!cand) return [];
  if (PAN_RE.test(cand)) {
    const cat = PAN_CATEGORY[cand[3]];
    return cat
      ? [info('REDFLAG_PAN_OK', `PAN "${cand}" format is valid; 4th letter '${cand[3]}' = ${cat}`, page, { pan: cand, category: cat })]
      : [err('REDFLAG_PAN_CATEGORY', `PAN 4th letter '${cand[3]}' is not a valid holder category`, page, { pan: cand })];
  }
  if (ocrAdjacent(cand, PAN_RE)) return [warn('REDFLAG_PAN_UNREADABLE', `Possible PAN "${cand}" too OCR-garbled to verify`, page)];
  return [err('REDFLAG_PAN_FORMAT', `PAN "${cand}" is not a valid 10-char format (AAAAA9999A)`, page, { pan: cand })];
}

// ── GST ──────────────────────────────────────────────────────────────────────
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export function checkGst(text: string, page: number | null = null): RedFlagFinding[] {
  const cand = labeledCandidate(text, /\bGSTIN\b|\bGST\s*(?:no|reg)/i, /\b[0-9]{2}[A-Z0-9]{13}\b/);
  if (!cand) return [];
  if (GST_RE.test(cand)) return [];
  if (ocrAdjacent(cand, GST_RE)) return [warn('REDFLAG_GST_UNREADABLE', `Possible GSTIN "${cand}" too OCR-garbled to verify`, page)];
  const why = cand.length !== 15 ? `is ${cand.length} chars, not 15` : cand[13] !== 'Z' ? 'is missing the mandatory Z at position 14' : 'has an invalid format';
  return [err('REDFLAG_GST_FORMAT', `GSTIN "${cand}" ${why}`, page, { gst: cand })];
}

// ── DL (state 2 letters + 13 digits = 15 alphanumeric) ──────────────────────────
const DL_RE = /^[A-Z]{2}[0-9]{13}$/;
export function checkDl(text: string, page: number | null = null): RedFlagFinding[] {
  const cand = labeledCandidate(text, /\bD\.?L\.?\s*(?:no|number)?\b|driving\s+licen[cs]e/i, /\b[A-Z]{2}[0-9]{2}\s?[0-9]{11}\b/);
  if (!cand) return [];
  if (DL_RE.test(cand)) return [];
  if (ocrAdjacent(cand, DL_RE)) return [warn('REDFLAG_DL_UNREADABLE', `Possible DL number "${cand}" too OCR-garbled to verify`, page)];
  return [err('REDFLAG_DL_FORMAT', `DL number "${cand}" is not 2 letters + 13 digits`, page, { dl: cand })];
}

// ── Udyam ──────────────────────────────────────────────────────────────────────
const UDYAM_RE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
export function checkUdyam(text: string, page: number | null = null): RedFlagFinding[] {
  // Capture permissively (letters allowed in every group) so a malformed number is
  // still extracted and then rejected by UDYAM_RE, rather than silently missed.
  const m = /UDYAM[-\s]?[A-Z0-9]{2}[-\s]?[A-Z0-9]{2}[-\s]?[A-Z0-9]{7}/i.exec(text);
  if (!m) return [];
  const cand = m[0].toUpperCase().replace(/[\s]/g, '-').replace(/-+/g, '-');
  if (UDYAM_RE.test(cand)) return [];
  return [err('REDFLAG_UDYAM_FORMAT', `Udyam number "${cand}" is not UDYAM-SS-DD-NNNNNNN`, page, { udyam: cand })];
}

// ── Passport number (1 letter + 7 digits) ───────────────────────────────────────
const PASSPORT_NO_RE = /^[A-Z][0-9]{7}$/;
export function checkPassportNumber(text: string, page: number | null = null): RedFlagFinding[] {
  const cand = labeledCandidate(text, /\bpassport\s*(?:no|number)\b/i, /\b[A-PR-WYa-pr-wy][0-9]{7}\b/);
  if (!cand) return [];
  if (PASSPORT_NO_RE.test(cand)) return [];
  if (ocrAdjacent(cand, PASSPORT_NO_RE)) return [warn('REDFLAG_PASSPORT_UNREADABLE', `Possible passport no. "${cand}" too OCR-garbled to verify`, page)];
  return [err('REDFLAG_PASSPORT_FORMAT', `Passport number "${cand}" is not 1 letter + 7 digits`, page, { passport: cand })];
}

// ── Passport file number (12-15 alphanumeric) ───────────────────────────────────
export function checkPassportFileNo(text: string, page: number | null = null): RedFlagFinding[] {
  const m = /file\s*(?:no|number)\s*[:\-]?\s*([A-Z0-9]{3,20})/i.exec(text);
  if (!m) return [];
  const cand = m[1].toUpperCase();
  if (cand.length >= 12 && cand.length <= 15) return [];
  return [err('REDFLAG_PASSPORT_FILENO', `Passport file no. "${cand}" is ${cand.length} chars, not 12-15`, page, { fileNo: cand })];
}

/** Extract distinct 12-digit Aadhaar numbers from one page's text (spaces optional). */
export function aadhaarNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b\d{4}\s?\d{4}\s?\d{4}\b/g)) out.add(stripSep(m[0]));
  return [...out];
}

/** Aadhaar 12-digit + front/back consistency, across the pages of ONE file. */
export function checkAadhaar(pages: { page: number; text: string }[]): RedFlagFinding[] {
  const seen: { page: number; num: string }[] = [];
  for (const p of pages) for (const n of aadhaarNumbers(p.text)) seen.push({ page: p.page, num: n });
  if (seen.length === 0) return [];
  const distinct = new Set(seen.map((s) => s.num));
  if (distinct.size > 1) {
    return [
      err('REDFLAG_AADHAAR_MISMATCH', `Aadhaar number differs across pages (${[...distinct].join(', ')})`, seen[0].page, {
        values: seen,
      }),
    ];
  }
  return [];
}

/** Voter ID (EPIC) number must match on the back side if present. EPIC = 3 letters + 7 digits. */
export function checkVoterId(pages: { page: number; text: string }[]): RedFlagFinding[] {
  const epics = new Set<string>();
  let firstPage: number | null = null;
  for (const p of pages) {
    for (const m of p.text.toUpperCase().matchAll(/\b[A-Z]{3}[0-9]{7}\b/g)) {
      epics.add(m[0]);
      if (firstPage === null) firstPage = p.page;
    }
  }
  if (epics.size <= 1) return [];
  return [err('REDFLAG_VOTER_MISMATCH', `Voter ID differs across sides (${[...epics].join(', ')})`, firstPage, { values: [...epics] })];
}

// ── Every-doc rules (run at FILE level, spec decision 3) ─────────────────────────
export function checkSignature(fileText: string): RedFlagFinding[] {
  // `\bsign(ed)?\b` accepts the abbreviated stamp ("Auth. Sign") that Indian dealer and
  // employer paperwork actually carries; without it every such document raised a
  // spurious "no signature" advisory.
  if (/authoris(ed|ing)|signator|signature|\bsign(ed)?\b|sign\s*here/i.test(fileText)) return [];
  return [warn('REDFLAG_NO_SIGNATURE', 'No signature / authorised-signatory wording found in the document', null)];
}

// The word a signature stamp is allowed to use, in any of its correct forms.
const SIGN_OK_RE = /^sign(?:s|ed|ing|ature|atures|atory|atories)?$/i;
const SIGN_TERMS = ['sign', 'signature', 'signatory'];
// "Auth."/"Auth"/"Authorised"/"Authorized" followed by the stamp's own word.
const SIGN_BLOCK_RE = /\bauth(?:\.|orise?d?|orize?d?)?\b\s*\.?\s*([A-Za-z]{3,12})\b/gi;

/**
 * A signature block whose own word is misspelt — "Auth. Sing" for "Auth. Sign".
 * SPELL structurally cannot catch this: "sing" is an ordinary English word, so the
 * dictionary accepts it and the near-miss matcher never looks at it. The surrounding
 * label is the only thing that makes the error visible.
 *
 * Uses the same doubt discipline as SPELL, so a merely OCR-garbled stamp
 * ("Sighatopy", "Signotiry") stays advisory instead of failing an honest scan.
 */
export function checkSignatoryWord(fileText: string, page: number | null = null): RedFlagFinding[] {
  const out: RedFlagFinding[] = [];
  const seen = new Set<string>();
  for (const m of fileText.matchAll(SIGN_BLOCK_RE)) {
    const word = m[1];
    const w = word.toLowerCase();
    if (SIGN_OK_RE.test(w) || seen.has(w)) continue;
    seen.add(w);
    let best: { term: string; d: number } | null = null;
    for (const term of SIGN_TERMS) {
      const d = editDistanceCapped(w, term, 2);
      if (d >= 1 && d <= 2 && (!best || d < best.d)) best = { term, d };
    }
    // Far from every signature word — this is "Authorised Dealer"/"Authorised Person",
    // not a signature block at all. Stay silent.
    if (!best) continue;
    const quote = m[0].trim().replace(/\s+/g, ' ');
    out.push(
      isDoubtfulHit(w, best.term, best.d)
        ? warn('REDFLAG_SIGNATORY_UNREADABLE', `Signature block "${quote}" is too garbled to confirm`, page)
        : err('REDFLAG_SIGNATORY_TYPO', `Signature block reads "${quote}" — "${word}" is not "${best.term}"`, page, {
            word,
            expected: best.term,
          })
    );
  }
  return out;
}

const EDITOR_RE = /itext|ilovepdf|pdfsam|pdf24|smallpdf|nitro|foxit|sejda|soda\s*pdf|libreoffice|reportlab|tcpdf|dompdf|wkhtmltopdf/i;
/** Editor/AI watermark: the PDF Producer/Creator names a document editor. */
export function checkEditorWatermark(producer?: string | null, creator?: string | null): RedFlagFinding[] {
  const hit = [producer, creator].find((v) => v && EDITOR_RE.test(v));
  return hit ? [err('REDFLAG_EDITOR_WATERMARK', `Document produced/edited by "${hit.trim()}"`, null, { tool: hit.trim() })] : [];
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=28; leap adds a day below
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Reject calendar-impossible dates (31 in a 30-day month, 29+ Feb in a non-leap year). */
export function checkDates(fileText: string): RedFlagFinding[] {
  const out: RedFlagFinding[] = [];
  const seen = new Set<string>();
  for (const m of fileText.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const day = +m[1];
    const month = +m[2];
    let year = +m[3];
    if (year < 100) year += year < 50 ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1) {
      out.push(err('REDFLAG_BAD_DATE', `Impossible date "${raw}"`, null, { date: raw }));
      continue;
    }
    const max = month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
    if (day > max) out.push(err('REDFLAG_BAD_DATE', `Impossible date "${raw}" (${day} > ${max} for month ${month})`, null, { date: raw }));
  }
  return out;
}
