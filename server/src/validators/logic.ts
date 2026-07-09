import { ValidatorOutcome } from './types.js';

/** A document FAILS the SPELL check when it contains at least this many DISTINCT
 *  expected-term misspellings. >2 tolerates the occasional interior OCR misread
 *  ("govemment", "signatur"); a genuinely forged form carries several real typos
 *  ("Dayes", "Retantion", "Profesion" all at once). */
export const SPELL_MIN_TERM_HITS = 3;

export function metaOutcome(docsWithText: number, totalDocs: number): ValidatorOutcome {
  if (totalDocs === 0) return { status: 'PASSED', summary: 'No documents to extract.' };
  if (docsWithText === 0)
    return { status: 'FAILED', summary: `No text extracted from ${totalDocs} document(s).` };
  return {
    status: 'PASSED',
    summary: `Extracted text from ${docsWithText} of ${totalDocs} documents.`,
  };
}


export function qrOutcome(found: number, imageCount: number, values: string[]): ValidatorOutcome {
  if (imageCount === 0) return { status: 'PASSED', summary: 'No image documents to scan.' };
  if (found === 0)
    return { status: 'FAILED', summary: `No QR code found across ${imageCount} image(s).` };
  return {
    status: 'PASSED',
    summary: `${found} QR code(s) found across ${imageCount} image(s).`,
    details: { values },
  };
}

export function intraOutcome(foundInDocs: number, textDocs: number): ValidatorOutcome {
  if (textDocs === 0) return { status: 'PASSED', summary: 'No document text to compare.' };
  if (foundInDocs === 0)
    return { status: 'FAILED', summary: `Claim ID not found in any of ${textDocs} document(s).` };
  return {
    status: 'PASSED',
    summary: `Claim ID found in ${foundInDocs} of ${textDocs} document(s).`,
  };
}

export function completenessOutcome(
  presentTypeNames: string[],
  requiredTypeNames: string[]
): ValidatorOutcome {
  if (requiredTypeNames.length === 0)
    return { status: 'PASSED', summary: 'No required document types configured.' };
  const missing = requiredTypeNames.filter((t) => !presentTypeNames.includes(t));
  const present = requiredTypeNames.length - missing.length;
  if (missing.length === 0)
    return {
      status: 'PASSED',
      summary: `All ${requiredTypeNames.length} required document types present.`,
    };
  return {
    status: 'FAILED',
    summary: `${present} of ${requiredTypeNames.length} required document types present.`,
    details: { missing },
  };
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Claim IDs shorter than this match too loosely as a bare substring. */
export const INTRA_MIN_LOOSE_LEN = 6;

/**
 * Does the document text contain the claim ID? Long IDs use a normalized,
 * OCR-tolerant substring match; short IDs (< INTRA_MIN_LOOSE_LEN) require a
 * separator-bounded match so "001" doesn't match inside "Invoice 2001".
 */
export function matchesClaimId(text: string, claimId: string): boolean {
  const norm = normalizeText(claimId);
  if (norm.length === 0) return false;
  if (norm.length >= INTRA_MIN_LOOSE_LEN) {
    return normalizeText(text).includes(norm);
  }
  const escaped = claimId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(text);
}

/** Spell-check candidates: 3+ letter alphabetic tokens with CASE PRESERVED, minus
 *  all-caps acronyms/codes (PAN, HDFC, VIN prefixes).
 *  Case is kept so the caller can test proper-noun capitalisation against the
 *  dictionary — dictionary-en holds many proper nouns only in capitalised form
 *  ("India" is known, "india" is not), so lowercasing everything (as the old
 *  tokenizer did) flagged every name as misspelled. */
export function spellCandidates(text: string): string[] {
  const out: string[] = [];
  for (const w of text.match(/[A-Za-z]{3,}/g) ?? []) {
    if (/^[A-Z]{2,}$/.test(w)) continue; // acronym / all-caps code
    out.push(w);
  }
  return out;
}

/** Vocabulary the forged forms are expected to contain (salary slips, ID cards,
 *  dealer/insurance paperwork). A token that is a 1–2 edit near-miss of one of
 *  these — but isn't itself a real word — is the high-signal forgery marker the
 *  human reviewers actually cite ("profession" printed as "profesion"). Place
 *  names, personal names and OCR garbage aren't near any expected term, so they
 *  don't trigger it — which is exactly the noise the old ratio drowned in.
 *  Extend this list as new document types / real misses surface. */
export const EXPECTED_TERMS: string[] = [
  // salary slip
  'salary', 'profession', 'professional', 'designation', 'department', 'employee',
  'employer', 'employment', 'engineer', 'manager', 'executive', 'officer', 'clerk',
  'supervisor', 'accountant', 'basic', 'allowance', 'allowances', 'deduction',
  'deductions', 'earnings', 'gross', 'total', 'retention', 'attendance', 'present',
  'absent', 'leave', 'overtime', 'bonus', 'incentive', 'provident', 'pension', 'wages',
  // identity / address
  'father', 'mother', 'address', 'district', 'pincode', 'signature', 'government',
  'identity', 'identification', 'account', 'number', 'birth', 'gender', 'nationality',
  'company', 'private', 'limited', 'division', 'branch', 'office',
  // insurance / dealer
  'insurance', 'policy', 'premium', 'vehicle', 'invoice', 'dealer', 'customer',
  'warranty', 'chassis', 'registration',
];

/** Levenshtein distance, capped: returns `cap + 1` as soon as the best cell in a
 *  row exceeds `cap`, so near-miss checks stay O(cap·len) instead of O(len²). */
export function editDistanceCapped(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

export interface TermMisspelling {
  token: string;
  term: string;
}

/**
 * From spell candidates, find DISTINCT tokens that misspell an expected term:
 * a token ≥4 chars that isn't a real word (`isRealWord` false in any case) yet
 * lands 1–2 edits from an EXPECTED_TERM. Short terms (<6 chars) match at edit
 * distance 1 only — distance 2 on a 4–5 letter word is mostly coincidence.
 */
export function findTermMisspellings(
  candidates: string[],
  isRealWord: (w: string) => boolean
): TermMisspelling[] {
  const hits = new Map<string, string>(); // token -> matched term (dedupes repeats)
  const seen = new Set<string>(); // skip re-checking an identical token (same header word on every page)
  for (const raw of candidates) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const token = raw.toLowerCase();
    if (token.length < 4 || hits.has(token)) continue;
    if (isRealWord(raw)) continue; // a genuine word (e.g. "cleaner" near "clerk") is fine
    for (const term of EXPECTED_TERMS) {
      if (token === term) continue;
      // Require the first letter to match. Real misspellings alter an INTERIOR
      // letter ("profeSion", "retAntion"); OCR drops leading characters
      // ("nsurance", "ddress", "ustomer") — that edge-drop noise is not forgery.
      if (token[0] !== term[0]) continue;
      const cap = term.length >= 6 ? 2 : 1;
      const d = editDistanceCapped(token, term, cap);
      if (d >= 1 && d <= cap) {
        hits.set(token, term);
        break;
      }
    }
  }
  return [...hits].map(([token, term]) => ({ token, term }));
}

// ── Intra-claim cross-document field extraction (Phase 4) ──────────────────────

/** Extract distinct VIN-shaped tokens (17 chars, excluding I/O/Q per the VIN standard). */
export function extractVins(text: string): string[] {
  const found = text.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) ?? [];
  return [...new Set(found)];
}

/** Extract distinct label-anchored customer names ("Customer Name: X" / "Name: X"). */
export function extractLabeledNames(text: string): string[] {
  const re = /(?:customer\s*name|name)\s*[:\-]\s*([A-Za-z][A-Za-z. ]{2,40})/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim().replace(/\s+/g, ' ').toLowerCase();
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

export type IntraField = 'VIN' | 'NAME';

export interface FieldMismatch {
  field: IntraField;
  /** Every (document, value) pair observed for this field across the claim. */
  values: { documentId: string; value: string }[];
}

const FIELD_EXTRACTORS: { field: IntraField; fn: (t: string) => string[] }[] = [
  { field: 'VIN', fn: extractVins },
  { field: 'NAME', fn: extractLabeledNames },
];

/**
 * Detect fields whose value disagrees ACROSS a claim's documents — the classic
 * "customer/vehicle details pasted, but they don't match" fraud signal. A field is a
 * mismatch when the documents that carry it yield 2+ distinct values. (Dates are
 * deliberately excluded — too noisy to compare reliably.)
 */
export function crossDocMismatches(
  perDoc: { documentId: string; text: string }[]
): FieldMismatch[] {
  const out: FieldMismatch[] = [];
  for (const { field, fn } of FIELD_EXTRACTORS) {
    const pairs: { documentId: string; value: string }[] = [];
    for (const d of perDoc) for (const v of fn(d.text)) pairs.push({ documentId: d.documentId, value: v });
    const distinct = new Set(pairs.map((p) => p.value));
    if (distinct.size > 1) out.push({ field, values: pairs });
  }
  return out;
}
