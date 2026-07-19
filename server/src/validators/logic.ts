import { ValidatorOutcome } from './types.js';

/** A document FAILS the SPELL check on the FIRST distinct expected-term misspelling.
 *  Human reviewers flag a form on a single genuine typo ("enginear", "Cleark",
 *  "ninty"), so the old threshold of 3 silently passed real forgeries — on the
 *  20-doc reviewer sample it caught 5/20; threshold 1 catches 14/20 (the rest are
 *  OCR-ceiling misses where tesseract couldn't read the misspelt word).
 *  Trade-off: an interior OCR misread of an expected word ("govemment", "signatur")
 *  can now trip a fail — acceptable because SPELL is a pre-filter for human review
 *  and we favour recall over precision here.
 *  ponytail: raise this, or gate on OCR word confidence (WordBox.conf), if
 *  legitimate scans throw too many false positives. */
export const SPELL_MIN_TERM_HITS = 1;

export function metaOutcome(docsWithText: number, totalDocs: number): ValidatorOutcome {
  if (totalDocs === 0) return { status: 'PASSED', summary: 'No documents to extract.' };
  if (docsWithText === 0)
    return { status: 'FAILED', summary: `No text extracted from ${totalDocs} document(s).` };
  return {
    status: 'PASSED',
    summary: `Extracted text from ${docsWithText} of ${totalDocs} documents.`,
  };
}


export function qrOutcome(found: number, docCount: number, values: string[]): ValidatorOutcome {
  if (docCount === 0) return { status: 'PASSED', summary: 'No image or PDF documents to scan.' };
  if (found === 0)
    return { status: 'FAILED', summary: `No QR code found across ${docCount} document(s).` };
  return {
    status: 'PASSED',
    summary: `${found} QR code(s) found across ${docCount} document(s).`,
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
  if (missing.length === 0)
    return {
      status: 'PASSED',
      summary: `All ${requiredTypeNames.length} required document types present.`,
      details: { present: presentTypeNames },
    };
  return {
    status: 'FAILED',
    summary: `${presentTypeNames.length} of ${requiredTypeNames.length} required document types present.`,
    details: { missing, present: presentTypeNames },
  };
}

/** Distinctive per-type markers for govt document types, keyed by govtCode.
 *  A bare name-phrase match is wrong for these: policy boilerplate mentions
 *  "holds an effective driving license" (false present) while an actual Aadhaar
 *  card never prints the English phrase "Aadhar Card" (false missing). Each
 *  predicate needs wording that appears ON the card itself and not in insurance
 *  legalese. ponytail: extend inline; move to a DocumentTypeMaster alias column
 *  if reviewers need to tune these without a deploy. */
export const GOVT_TYPE_MARKERS: Record<string, (t: string) => boolean> = {
  AADHAR: (t) =>
    /(^|[^a-z])(uidai|aad?haa?r)([^a-z]|$)/i.test(t) ||
    /unique\s+identification\s+authority/i.test(t),
  // OCR of blurry cards drops spaces ("INCOMETAX DEPARTMENT") — keep \s* loose.
  PAN: (t) => /income\s*tax\s*depart/i.test(t) || /permanent\s*account\s*number/i.test(t),
  // Cards carry a DL number / class-of-vehicle codes; policy clauses just say
  // "driving license", so require both signals.
  DL: (t) =>
    /driving\s+licen[cs]e/i.test(t) &&
    /(^|[^a-z])(dl\s*no|cov|lmv|mcwg|hgmv|hpmv)([^a-z]|$)/i.test(t),
  VOTER_ID: (t) =>
    /election\s+commission/i.test(t) || /(^|[^a-z])(epic|voter)([^a-z]|$)/i.test(t),
  PASSPORT: (t) =>
    /(^|[^a-z])passport([^a-z]|$)/i.test(t) &&
    /republic\s+of\s+india|nationality|place\s+of\s+birth/i.test(t),
  // GST certificate (Form GST REG-06). GSTIN or the tax name on the cert body;
  // a bare "GST" appears in dealer invoices, so require a certificate signal.
  GST: (t) =>
    /(^|[^a-z])gstin([^a-z]|$)/i.test(t) ||
    /goods\s+and\s+services\s+tax/i.test(t) ||
    /gst\s*reg-?\s*0?6/i.test(t),
  // Udyam / MSME registration certificate.
  UDYAM: (t) =>
    /udyam/i.test(t) || /(^|[^a-z])msme([^a-z]|$)/i.test(t) ||
    /micro,?\s*small\s*(and|&)\s*medium/i.test(t),
};

/** Is this document type present, judging by the documents' extracted text?
 *  Govt types use their distinctive markers; custom types (Invoice, Bill, …)
 *  match their name as a whole word/phrase. */
export function typePresent(name: string, govtCode: string | null, texts: string[]): boolean {
  const marker = govtCode ? GOVT_TYPE_MARKERS[govtCode] : undefined;
  if (marker) return texts.some(marker);
  return typeInText(name, texts);
}

/** Does any document's extracted text mention this document-type name as a
 *  whole word/phrase? Scanned claims arrive as ONE bundled PDF named by chassis
 *  number, so filename classification can never see the invoice/licence pages
 *  inside — this content fallback is what marks them present. Recall-favoring
 *  pre-filter like SPELL; word boundaries keep "Bill" from matching "billing". */
export function typeInText(name: string, texts: string[]): boolean {
  const pattern = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/licence/i, 'licen[cs]e')
    .replace(/aadhar/i, 'aad?haa?r')
    .replace(/\s+/g, '\\s+');
  if (!pattern) return false;
  const re = new RegExp(`(^|[^A-Za-z])${pattern}([^A-Za-z]|$)`, 'i');
  return texts.some((t) => re.test(t));
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
 *  don't trigger it — which is exactly the noise a full-dictionary check drowns in
 *  (measured: full-dict flagged ~35 tokens/doc vs ~3.5 with this list).
 *
 *  This is the BUILT-IN FALLBACK/seed list. At runtime the SPELL validator prefers
 *  the admin-managed `SpellTerm` table (CRUD in the admin dashboard) and only uses
 *  this when that table is empty or unreadable. Keep the two in sync via the seed. */
export const EXPECTED_TERMS: string[] = [
  // salary slip / payroll
  'salary', 'profession', 'professional', 'designation', 'department', 'employee',
  'employer', 'employment', 'engineer', 'manager', 'executive', 'officer', 'clerk',
  'supervisor', 'accountant', 'basic', 'allowance', 'allowances', 'deduction',
  'deductions', 'earnings', 'gross', 'total', 'retention', 'attendance', 'present',
  'absent', 'leave', 'overtime', 'bonus', 'incentive', 'provident', 'pension', 'wages',
  'conveyance', 'gratuity', 'reimbursement', 'stipend', 'payslip', 'payroll', 'remuneration',
  // identity / address
  'father', 'mother', 'address', 'district', 'pincode', 'signature', 'signatory',
  // British spelling ONLY — it's what appears on these Indian forms; adding the US
  // 'authorized' too would flag every correct "Authorised" as a typo of it, since
  // dictionary-en (US) rejects the British form. Same rule for any en-GB/en-US pair.
  'authorised', 'government', 'identity', 'identification', 'account',
  'number', 'birth', 'gender', 'nationality', 'name', 'company', 'private', 'limited',
  'division', 'branch', 'office', 'staff', 'deputy', 'female', 'male',
  // organisations / education (ID cards)
  'institute', 'institution', 'university', 'college', 'school', 'hospital', 'hospitality',
  'medical', 'sciences', 'science', 'engineering', 'technology', 'corporation',
  'industries', 'enterprises', 'solutions', 'services',
  // insurance / dealer / vehicle
  'insurance', 'policy', 'premium', 'vehicle', 'invoice', 'dealer', 'customer',
  'warranty', 'chassis', 'registration', 'automobile', 'motors', 'finance',
  // common form vocabulary reviewers flag
  'ninety', 'three', 'does', 'require', 'required', 'days', 'letterhead', 'declaration',
  'certificate', 'special',
  // months
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  // entity gazetteer (brands / orgs / places reviewers name) — extend via admin CRUD
  'bajaj', 'jindal', 'prudential', 'lucknow', 'flipkart',
];

/** Damerau (optimal string alignment) edit distance, capped: returns `cap + 1` as
 *  soon as the best cell in a row exceeds `cap`, so near-miss checks stay O(cap·len)
 *  instead of O(len²). Counts an adjacent transposition as ONE edit so a swapped
 *  pair ("nmae"→"name") reads as a single typo, not two — transpositions are among
 *  the most common human/forgery misspellings. */
export function editDistanceCapped(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // Adjacent transposition (OSA): a[i-1]a[i-2] == b[j-2]b[j-1].
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prevPrev = prev;
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
 * lands 1–2 edits from a term in `terms`. Short terms (<6 chars) match at edit
 * distance 1 only — distance 2 on a 4–5 letter word is mostly coincidence.
 * `terms` defaults to the built-in EXPECTED_TERMS; the validator passes the
 * admin-managed list. Terms shorter than 4 chars are ignored (too noisy).
 */
export function findTermMisspellings(
  candidates: string[],
  isRealWord: (w: string) => boolean,
  terms: string[] = EXPECTED_TERMS
): TermMisspelling[] {
  const hits = new Map<string, string>(); // token -> matched term (dedupes repeats)
  const seen = new Set<string>(); // skip re-checking an identical token (same header word on every page)
  for (const raw of candidates) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const token = raw.toLowerCase();
    if (token.length < 4 || hits.has(token)) continue;
    if (isRealWord(raw)) continue; // a genuine word (e.g. "cleaner" near "clerk") is fine
    for (const term of terms) {
      if (term.length < 4 || token === term) continue;
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
