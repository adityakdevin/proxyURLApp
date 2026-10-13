/**
 * Cross-document field-comparison red flags (Phase 1 High). Pure text → findings,
 * so every function unit-tests with string fixtures (spec decision 2). Folded into
 * the REDFLAG validator — no separate validator or status column.
 *
 * Model: a field must AGREE across the document types in its scope. "Customer name
 * is consistent everywhere except relation names" subsumes the pairwise name rules;
 * a field that disagrees between two in-scope docs is a red flag. New-vs-old car
 * insurance needs no distinction here — a new-car policy simply carries no vehicle
 * number, so it drops out of the vehicle-number check on its own.
 *
 *   pages ──▶ classifyDocType ──▶ extract fields ──▶ per-field consistency ──▶ findings
 *
 * Comparison unit is the classified DOC TYPE, not the documentId, because a scanned
 * claim arrives as ONE bundled PDF whose pages classify to different types — an
 * Invoice page and an RC page inside the same file must still be compared.
 */
import type { FindingInput } from './types.js';
import { editDistanceCapped } from './logic.js';

export type DocTypeCode = 'INVOICE' | 'RC' | 'INSURANCE' | 'KYC' | 'PAYSLIP' | 'STAFF_ID' | 'DMS';
/** Relation names are compared PER RELATION — a mother's name and a father's name are
 *  different people, so they must never land in the same comparison bucket. */
export type RelationKind = 'FATHER' | 'MOTHER' | 'SPOUSE' | 'GUARDIAN';
export type CrossField =
  | 'NAME'
  | 'RELATION_FATHER'
  | 'RELATION_MOTHER'
  | 'RELATION_SPOUSE'
  | 'RELATION_GUARDIAN'
  | 'CHASSIS'
  | 'ENGINE'
  | 'VEHICLE_NO'
  | 'MODEL'
  | 'EMP_CODE'
  | 'ADDRESS'
  | 'DOB'
  | 'ACCOUNT_NO'
  | 'RECEIPT_NO'
  | 'APPLICATION_NO';

export interface CrossPage {
  documentId: string;
  page: number | null;
  text: string;
  /** REDFLAG's per-page govt-ID classification, if any — govt IDs count as KYC docs. */
  govtCode?: string | null;
}

// ── Document-type classification (priority-scored, margin-gated) ─────────────────
// Business docs share vocabulary (customer name, chassis, model), so first-marker-wins
// mis-attributes. Score each type by distinctive-marker hits; a type wins only with a
// STRICT margin over the runner-up, else the page is UNKNOWN (spec: unclassifiable).
const TYPE_MARKERS: Record<DocTypeCode, RegExp[]> = {
  INVOICE: [/\btax\s*invoice\b/i, /\binvoice\s*(?:no|number|date)\b/i, /\bproforma\b/i, /\bex[-\s]?showroom\b/i, /\binvoice\s+value\b/i],
  RC: [/\bcertificate\s+of\s+registration\b/i, /\bregistration\s+certificate\b/i, /\bregn?\.?\s*(?:no|number)\b/i, /\bregistering\s+authority\b/i],
  INSURANCE: [/\bpolicy\s*(?:no|number)\b/i, /\binsured\b/i, /\bpremium\b/i, /\bsum\s+insured\b/i, /\bperiod\s+of\s+insurance\b/i, /(^|[^a-z])idv([^a-z]|$)/i],
  KYC: [/\bknow\s+your\s+customer\b/i, /(^|[^a-z])kyc([^a-z]|$)/i, /\bself[-\s]?attested\b/i],
  PAYSLIP: [/\bpay\s*slip\b/i, /\bsalary\s*slip\b/i, /\bnet\s+pay\b/i, /\bgross\s+(?:salary|pay)\b/i, /\bbasic\s+pay\b/i, /\bearnings\b/i],
  STAFF_ID: [/\bemployee\s+id\b/i, /\bstaff\s+id\b/i, /\bidentity\s+card\b/i, /\bemp(?:loyee)?\s*code\b/i],
  DMS: [/(^|[^a-z])dms([^a-z]|$)/i, /\bdealer\s+management\b/i],
};

export function classifyDocType(text: string): DocTypeCode | null {
  const scores = (Object.entries(TYPE_MARKERS) as [DocTypeCode, RegExp[]][])
    .map(([code, res]) => ({ code, score: res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  const top = scores[0];
  if (!top || top.score === 0) return null;
  if (scores[1] && scores[1].score === top.score) return null; // tie → unclassifiable
  return top.code;
}

/** Business type for a page: content markers first, else govt IDs count as KYC. */
function pageType(p: CrossPage): DocTypeCode | 'UNKNOWN' {
  return classifyDocType(p.text) ?? (p.govtCode ? 'KYC' : 'UNKNOWN');
}

// ── Name handling ────────────────────────────────────────────────────────────────
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'shri', 'smt', 'sri', 'thiru', 'dr', 'master', 'kum', 'm/s', 'ms/', 'lt', 'late']);

/** The same list as a leading-run stripper, for the places that need the name with its
 *  original casing rather than nameTokens' lowercased split. `(?![A-Za-z])` rather than
 *  `\b`: JavaScript counts `_` as a word character, so `\b` never fires between "MR" and
 *  the underscore of "MR_RAVI SHANKAR", the form OCR produces when it fuses the two. The
 *  lookahead stops at the underscore, the dot and the end of the string alike, and still
 *  refuses to bite into a name like "MSINGH". */
// LT / LATE: a deceased father is printed "Lt. Harisunder" on one document and plain on
// the next (client QA 2026-10, #25).
const HONORIFIC_RE = /^(?:M\/S|MS\/|MRS|MR|MS|SHRI|SMT|SRI|THIRU|DR|MASTER|KUM|LATE|LT)(?![A-Za-z])[_.\s]*/i;
export const dropHonorific = (v: string) => v.replace(HONORIFIC_RE, '').trim();

/** Lowercase alnum tokens, honorifics dropped. "Mr. Rajesh Kumar" → ["rajesh","kumar"]. */
export function nameTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s.]/g, ' ')
    .split(/[\s.]+/)
    .filter((t) => t && !HONORIFICS.has(t))
    // "MD Shahabuddin" on the invoice, "MOHD Shahabuddin" on the policy: one name.
    .map((t) => (MOHD.has(t) ? 'mohd' : t));
}
const MOHD = new Set(['md', 'mohd', 'mohammed', 'mohammad', 'mohamed', 'muhammad', 'muhammed']);

/**
 * Same person? Token-set alignment, order-independent, initial-aware — NOT edit
 * distance (Damerau-1 false-flags "Rajesh Kumar" vs "R. Kumar"). Every token of the
 * shorter name must align with a DISTINCT token of the longer one: exact match, or a
 * single-letter initial matching the other token's first letter. Sharing only a common
 * surname does NOT match ("Rajesh Kumar" vs "Suresh Kumar" → false).
 */
export function nameMatches(a: string, b: string): boolean {
  let sa = nameTokens(a);
  let sb = nameTokens(b);
  if (sa.length === 0 || sb.length === 0) return true; // nothing to compare → not a mismatch
  // OCR token merge/split: "Rajeshkumar Sharma" vs "Rajesh Kumar Sharma" — compare the
  // whitespace-free forms (order-preserving, which is how OCR joins/splits words).
  if (sa.join('') === sb.join('')) return true;
  // Joined/split AND one letter off at once: "RAJESH V G" vs "RAJEESHV G" (client QA
  // 2026-10). Whole-name forms of 8+ letters only, so short names keep the strict rules.
  if (Math.min(sa.join('').length, sb.join('').length) >= 8 && within1(sa.join(''), sb.join(''))) return true;
  if (sa.length > sb.length) [sa, sb] = [sb, sa];
  // The shorter name written as one word for consecutive tokens of the longer, surname
  // left off: "Harisunder" vs "Hari Sunder Mishra" (client QA 2026-10, #25).
  const joined = sa.join('');
  for (let i = 0; i < sb.length; i++) {
    for (let j = i + 2; j <= sb.length; j++) if (sb.slice(i, j).join('') === joined) return true;
  }
  const used = new Array(sb.length).fill(false);
  const aligns = (x: string, y: string, surnames: boolean) =>
    x === y ||
    (x.length === 1 && y[0] === x) ||
    (y.length === 1 && x[0] === y) ||
    // OCR drift inside a longer token ("Kumar" vs "Kumr"): tolerate one edit. Bounded to
    // 4+ char tokens so genuinely-distinct short tokens don't collapse.
    (x.length >= 4 && y.length >= 4 && within1(x, y)) ||
    // Two letters on a long token: "SURENTHS" / "SUREJNITHS", "GOPARADDI" / "GOPAREDDY".
    (Math.min(x.length, y.length) >= 8 && editDistanceCapped(x, y, 2) <= 2) ||
    // A clipped last letter on the surname only: "Son" for "Soni" (#23). One letter, at the
    // end, 3+ kept. On a given name it would make "Kumar" and "Kumari" one person.
    (surnames && Math.min(x.length, y.length) >= 3 && Math.abs(x.length - y.length) === 1 && (x.startsWith(y) || y.startsWith(x)));
  for (const [ti, t] of sa.entries()) {
    const i = sb.findIndex((u, idx) => !used[idx] && aligns(t, u, ti === sa.length - 1 && idx === sb.length - 1));
    if (i < 0) return false;
    used[i] = true;
  }
  return true;
}

// ── ID handling (chassis / engine / vehicle no / emp code) ──────────────────────
// Fold OCR-ambiguous glyphs to a canonical digit so two OCR reads of the same ID
// compare equal; then allow one edit for a single dropped/extra char.
const OCR_FOLD: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
export function idNorm(s: string): string {
  return s
    .toUpperCase()
    .replace(/[\s.\-/]/g, '')
    .split('')
    .map((c) => OCR_FOLD[c] ?? c)
    .join('');
}

/** True when Levenshtein(a, b) <= 1. Bounded, O(min·max) but strings are short. */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a]; // s is 1 shorter
  for (let i = 0, j = 0, skipped = false; j < l.length; ) {
    if (s[i] === l[j]) { i++; j++; }
    else if (skipped) return false;
    else { skipped = true; j++; }
  }
  return true;
}

export function idMatches(a: string, b: string): boolean {
  const na = idNorm(a);
  const nb = idNorm(b);
  if (!na || !nb) return true;
  return within1(na, nb);
}

/** Models agree loosely: one token set is a subset of the other ("Swift VXI" vs
 *  "Swift VXI BS6"). Ignores trim/BS-norm suffixes without false-flagging real diffs. */
export function modelMatches(a: string, b: string): boolean {
  const ta = new Set(a.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return true;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

// An address is the one common field nobody writes the same way twice: line breaks move,
// "Road"/"Rd" alternate, a floor or landmark appears on one document and not the other.
// Comparing the strings would flag every honest claim, so compare the DISTINCTIVE tokens
// and require most of the shorter side to appear in the longer one.
const ADDRESS_NOISE = new Set([
  'house', 'no', 'flat', 'plot', 'door', 'room', 'floor', 'flr', 'near', 'opp', 'opposite',
  'behind', 'beside', 'above', 'below', 'block', 'sector', 'phase', 'lane', 'street', 'road',
  'nagar', 'colony', 'post', 'dist', 'district', 'tehsil', 'taluk', 'village', 'vill', 'city',
  'town', 'state', 'pin', 'pincode', 'india', 'the', 'and', 'building', 'bldg', 'cross', 'main',
]);
const ADDRESS_MIN_OVERLAP = 0.6;
const PIN_RE = /\b(\d{6})\b/;

/** Addresses agree when most distinctive tokens are shared AND the PIN codes do not
 *  contradict. Deliberately loose: a false mismatch on an address costs a reviewer more
 *  than a missed one, so this reports as a WARNING at the call site. */
export function addressMatches(a: string, b: string): boolean {
  const pinA = PIN_RE.exec(a)?.[1];
  const pinB = PIN_RE.exec(b)?.[1];
  // A PIN is the one part of an address written identically everywhere. Two different PINs
  // are two different places, whatever the rest of the text looks like.
  if (pinA && pinB && pinA !== pinB) return false;
  const toks = (v: string) =>
    new Set(
      v
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2 && !ADDRESS_NOISE.has(t))
    );
  const ta = toks(a);
  const tb = toks(b);
  if (ta.size === 0 || tb.size === 0) return true; // nothing distinctive → not a mismatch
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return hit / small.size >= ADDRESS_MIN_OVERLAP;
}

/** Dates agree on the DAY, whatever separator or year width the document used:
 *  "05/11/1994", "5-11-94" and "05.11.1994" are one birth date. */
export function dateMatches(a: string, b: string): boolean {
  const parts = (v: string) => {
    const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(v.trim());
    if (!m) return null;
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${+m[1]}-${+m[2]}-${y}`;
  };
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return true; // unparseable → not evidence of a mismatch
  return pa === pb;
}

// ── Field extraction (label-anchored) ────────────────────────────────────────────
function allMatches(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const v = (m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' ');
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

// Group 1 = the relation word, group 2 = its value; group 3 = the s/o-style prefix,
// group 4 = its value. Keeping the relation word captured is what lets a mother's name
// be compared only against other MOTHERS' names (see RELATION_OF).
const RELATION_RE =
  /(father|mother|husband|wife|guardian|spouse)(?:'?s)?\s*name\s*[:\-]\s*([A-Za-z][A-Za-z. ]{2,40})|(s\/o|d\/o|w\/o|c\/o)\s*[:\-]?\s*([A-Za-z][A-Za-z. ]{2,40})/gi;

/** Which person a relation label refers to. s/o and d/o name the FATHER; w/o names the
 *  SPOUSE; c/o names a GUARDIAN. Labels that denote the same person share a kind so
 *  "Spouse Name" on one doc and "Husband Name" on another still compare. */
const RELATION_OF: Record<string, RelationKind> = {
  father: 'FATHER',
  's/o': 'FATHER',
  'd/o': 'FATHER',
  mother: 'MOTHER',
  husband: 'SPOUSE',
  wife: 'SPOUSE',
  spouse: 'SPOUSE',
  'w/o': 'SPOUSE',
  guardian: 'GUARDIAN',
  'c/o': 'GUARDIAN',
};

/** Words that are FORM LABELS, never people. Indian ID cards print each label above its
 *  value, so once OCR flattens the page the NEXT LABEL lands where the value should be —
 *  "S/O: Address: Government of India" on an Aadhaar card yielded a father's name of
 *  "Address", which then mismatched the real father's name on the policy page. */
const FIELD_LABEL_WORD = new Set([
  'address', 'date', 'dob', 'birth', 'gender', 'name', 'pin', 'pincode', 'phone', 'mobile',
  'email', 'district', 'state', 'city', 'town', 'village', 'signature', 'photo', 'year',
  'issue', 'issued', 'download', 'downloaded', 'enrolment', 'enrollment', 'vid', 'uid',
  'aadhaar', 'aadhar', 'pan', 'father', 'mother', 'husband', 'wife', 'guardian', 'spouse',
  'age', 'occupation', 'nationality', 'sex', 'mob', 'tel',
]);

/** Does this captured value just repeat a form label instead of naming a person? */
function isLabelValue(v: string): boolean {
  const first = v.trim().toLowerCase().split(/[\s.]+/)[0];
  return first.length === 0 || FIELD_LABEL_WORD.has(first) || NEXT_LABEL_WORD.has(first);
}

/**
 * Words that START the next field on a form, where a value read off a flattened line runs on
 * into it. Every one of these was stored as part of a value on a real claim, and each such
 * value produced a false duplicate or mismatch finding:
 *   "Sanjay Kumar Singh Date of"            (payslip: "... Date of Joining:")
 *   "MOHAN KUMAR IFSC"                       (bank details)
 *   "RAMESH KUMAR Period of Third Pa"        (policy schedule, next column)
 *   "... 387002 Vehicle Particulars", "... TAMIL NADU-608601 Previous TP Policy No."
 * Deliberately NOT here: words that genuinely occur inside an address (village, district,
 * state, city, pin, road, bank colony) — ADDRESS is cut with this set too.
 */
const NEXT_LABEL_WORD = new Set([
  'date', 'dob', 'gender', 'phone', 'mobile', 'mob', 'tel', 'email', 'signature', 'ifsc',
  'registration', 'vehicle', 'policy', 'invoice', 'receipt', 'period', 'previous', 'proposal',
  'designation', 'department', 'joining', 'relationship', 'nominee', 'engine', 'chassis',
  'model', 'particulars', 'premium', 'gstin', 'pan', 'uid', 'vid', 'account',
]);

/** Extra label words that end a PERSON's name but are ordinary words inside an address. */
const NAME_ONLY_LABEL_WORD = new Set([
  'address', 'district', 'state', 'city', 'town', 'village', 'pin', 'pincode', 'bank', 'branch',
  'customer', 'insured', 'employee', 'emp', 'code', 'age', 'sex', 'occupation', 'nationality',
  'birth', 'issue', 'issued', 'father', 'mother', 'husband', 'wife', 'guardian', 'spouse',
  'aadhaar', 'aadhar', 'name',
]);

/** A label word as the document misspelt it: "Desigantion", "Departmant". Only long labels,
 *  where one or two slips cannot turn one into another real word. Without this the misspelt
 *  label ran on into the person's name, and SPELL then treated it as a name word and only
 *  ever called it "doubtful" (client QA 2026-10, #44-46). */
function nearLabelWord(bare: string): boolean {
  if (bare.length < 7) return false;
  for (const label of NEXT_LABEL_WORD) {
    if (label.length < 7 || label[0] !== bare[0]) continue;
    if (editDistanceCapped(bare, label, 2) <= 2) return true;
  }
  return false;
}

/** Cut a value at the first word (after its first) that begins the next form label. */
function cutAtNextLabel(v: string, forName: boolean): string {
  const words = v.split(' ');
  const i = words.findIndex((w, k) => {
    if (k === 0) return false;
    const bare = w.toLowerCase().replace(/[^a-z]/g, '');
    return NEXT_LABEL_WORD.has(bare) || (forName && NAME_ONLY_LABEL_WORD.has(bare)) || nearLabelWord(bare);
  });
  return (i === -1 ? words : words.slice(0, i)).join(' ').replace(/[\s,.:\-]+$/, '');
}

/**
 * Clean a person-name reading, or null when it is not a name at all.
 *  - cut at the next label ("... Date of Joining");
 *  - drop a trailing OCR fragment that is not an initial ("K SATISHKUMAR Te"; "RAVI K" keeps K);
 *  - reject a reading that starts lower-case or contains prose ("r repair of the vehicle
 *    subject to", "r Family"): OCR debris, not a person.
 * ponytail: the lower-case rule would reject a name OCR'd entirely in lower case; documents
 * print names capitalised, so none has shown up.
 */
/**
 * Words that never occur in a person's name but do in the company, brand and helpline text
 * OCR puts after a "Name" label. Each was read as a customer on a real production claim
 * (2026-09-26): "TOYOTA KIRLOSKAR" (RC maker), "My TVS Toll Free" (helpline block).
 */
const NOT_A_PERSON_WORD = new Set([
  'toll', 'free', 'helpline', 'care', 'www', 'com', 'ltd', 'limited', 'pvt', 'private',
  'motor', 'motors', 'automobiles', 'auto', 'corporation', 'company', 'services', 'finance',
  'insurance', 'general', 'bank', 'toyota', 'kirloskar', 'tvs', 'maruti', 'suzuki', 'hyundai',
  'kia', 'honda', 'mahindra', 'tata', 'renault', 'nissan', 'skoda', 'volkswagen', 'mg',
  // Dealer and MISP trading names the client QA of 2026-10 saw read as the customer:
  // "PARASAVNATH AUTOWHEELS", "DRIVE N RIDE".
  'autowheels', 'wheels', 'automotive', 'agency', 'agencies', 'traders', 'trading',
  'enterprise', 'enterprises', 'industries', 'ride', 'rides',
  // "DIRECT BUSINESS" (a policy's sales channel), "THE AREA MANAGER CANTEEN STORES" (an
  // invoice billed to the CSD canteen) — read as the customer on the 570-claim re-run.
  'business', 'manager', 'canteen', 'stores',
]);

function cleanPersonName(raw: string): string | null {
  let v = cutAtNextLabel(raw, true);
  const words = v.split(' ');
  const last = words[words.length - 1];
  if (words.length > 1 && last.length <= 2 && last !== last.toUpperCase()) v = words.slice(0, -1).join(' ');
  if (!v || !/^[A-Z]/.test(v) || /\b(?:the|to|for|of|and|with|subject|from)\b/.test(v)) return null;
  const tokens = v.toLowerCase().split(/[\s.]+/).filter(Boolean);
  // A name has at least one word of 3+ letters: "Ch" is an OCR fragment of the RC's "Chassis",
  // and it produced a false Invoice vs RC "Diff Name" on MZBEP812TSN.
  if (!tokens.some((t) => /^[a-z]{3,}$/.test(t))) return null;
  if (tokens.some((t) => NOT_A_PERSON_WORD.has(t))) return null;
  return v;
}

/** Relation names tagged with WHOSE name it is. */
export function extractRelationNamesByKind(text: string): { kind: RelationKind; value: string }[] {
  const out: { kind: RelationKind; value: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(RELATION_RE)) {
    const label = (m[1] ?? m[3] ?? '').toLowerCase();
    const raw = (m[2] ?? m[4] ?? '').trim().replace(/\s+/g, ' ');
    const kind = RELATION_OF[label];
    if (!kind || !raw || isLabelValue(raw)) continue;
    const value = cleanPersonName(raw);
    if (!value) continue;
    const key = `${kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, value });
  }
  return out;
}

/** Every relation name, relation-blind — used only to subtract them from customer names. */
export function extractRelationNames(text: string): string[] {
  return [...new Set(extractRelationNamesByKind(text).map((r) => r.value))];
}

// The word right before "Name" that denotes a NON-person entity — its value is not a
// customer/employee name (e.g. "Bank Name: HDFC", "Company Name: Maruti"). Person
// qualifiers (customer/insured/…) and relation labels (father/…, handled separately)
// are NOT here, so they still count.
// Intermediaries (broker/agent/surveyor/…) belong here too: a motor policy prints the
// BROKER's name in the same "X Name:" shape as the insured's, and treating it as the
// customer's name is what made every such claim report a bogus name mismatch.
const NON_PERSON_NAME_LABEL = new Set([
  'bank', 'company', 'firm', 'dealer', 'dealership', 'branch', 'nominee',
  'product', 'scheme', 'plan', 'trade', 'showroom', 'brand', 'make', 'model', 'group',
  'broker', 'agent', 'intermediary', 'surveyor', 'workshop', 'garage', 'financier',
  'financer', 'insurer', 'insurance', 'employer', 'hypothecation', 'organisation',
  'organization', 'institution', 'hospital', 'school', 'college', 'university',
  // A policy schedule credits the selling dealer as "MISP Name : <dealership>". Without
  // this the dealership was reported as the insured — the one name on the page that is
  // certainly NOT the customer.
  'misp',
  // ...and as OCR prints that label: "MIS Name", "MSP Name" (client QA 2026-10, #18, #24, #28).
  'mis', 'msp',
  // RC "Maker's Name : TOYOTA KIRLOSKAR MOTOR" — the manufacturer, not the owner.
  'maker', 'manufacturer',
  // "Payer Name : DRIVE N RIDE" — whoever paid the premium, often the dealer; and the
  // payslip's "Authorised Signatory Name" — HR, not the employee (client QA 2026-10).
  'payer', 'signatory', 'authorised', 'authorized', 'issuer',
  // The broker's "Designated Person Name : SANJAY KUMAR" on Go Digit / Reliance schedules
  // (also "Contact Person Name"): an intermediary's staff member, never the customer. It
  // surfaced once "Bill To" made the invoice's name readable (claim …014084).
  'person',
  // "Issue Office Name : BO NEAR GHADI CHOWK" — the insurer's branch (client QA 2026-10).
  'office',
]);

// Group 1 = the single word immediately before "Name" (if any); group 2 = the value.
// The `(?:'?s)?` after the label word catches the possessive form — without it
// "Nominee's Name: X" captured a bare "s" as the label, which is in no blocklist, so
// the nominee leaked through as the customer's name.
// "Bill To" is how Kia dealer invoices label the customer ("Bill To : KARAN SINGH"); without
// it no name was read off those invoices, so the DMS-vs-invoice check had nothing to compare.
// The gap after the label word is [ \t]+, not \s+: with \s+ a heading on the line above
// became the label word ("Nominee Details\nName : X" took "Details", "Authorised
// Signatory\nName : Deepak" took "Signatory"), and the nominee or the HR signatory was read
// as the customer (client QA 2026-10). Headings are handled by sectionHeadingBefore.
// The label word allows digits so an OCR'd "M1SP" still reaches the blocklist.
// Separator `\.?\s*[:\-+]`: OCR prints a policy's "Insured's Name :" as "Name +" or
// "Name. +", and with only [:\-] no insured name was read off those schedules (client QA
// 2026-10, #20, #35). "M/S" may lead the value: "M/S A B C PLASTIC" stopped at the "/".
const NAME_RE =
  /(?:(?:([A-Za-z][A-Za-z0-9]*)(?:'?s)?[ \t]+)?name\s*(?:of\s+(?:the\s+)?(?:insured|customer|employee|applicant|proposer))?|\bbill(?:ed)?\s+to)\.?\s*[:\-+]\s*((?:M\/S\.?\s*)*[A-Za-z][A-Za-z. ]{2,40})/gi;

/** "Bill To" as OCR misreads it with no separator ("Bil 10 PREM Customer Id"): the capitals
 *  that follow, up to the first word with a lower-case letter (#20). */
const BILL_TO_LOOSE = /\b[Bb][Ii][Ll]{1,2}\s*[Tt1][Oo0]\b\s*[:\-]?\s*([A-Z][A-Z. ]{2,40}?)(?=\s+[A-Z]?[a-z]|\s*$)/gm;

/** A heading on the line just above a bare "Name :" that says whose name it is. */
const NON_PERSON_SECTION =
  /\b(?:nominee|m[i1l]sp|payer|signatory|authori[sz]ed|financier|hypothecat\w*|broker|agent|intermediary|dealer|employer|appointee|guardian)\b/i;

function sectionHeadingBefore(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 120), at);
  // Text on the same line before "Name", then the previous non-empty line.
  const lines = before.split('\n');
  const sameLine = lines.pop() ?? '';
  if (sameLine.trim() !== '') return false; // "Customer Name" etc. — the label word decides
  const prev = [...lines].reverse().find((l) => l.trim() !== '') ?? '';
  if (NON_PERSON_SECTION.test(prev)) return true;
  // A signature block runs several lines: "Authorized Signatory, / For, National Medical
  // College … / (Managing …) / Name: Deepak Rao" read the signatory as the employee and
  // failed the claim (client QA 2026-10, #25). Only this unmistakable heading reaches back.
  return /\bauthori[sz]ed\s+signator/i.test(
    text.slice(Math.max(0, at - 300), at).split('\n').slice(-7).join('\n')
  );
}

/** "F.Name" / "M.Name": a staff ID card's father's / mother's name, not the holder's (#24). */
const RELATION_INITIAL_BEFORE = /\b[FM]\.\s*$/i;


/** "M1SP" → "misp": OCR swaps in a label word must not slip past the blocklist. */
const labelWord = (w: string) => w.toLowerCase().replace(/1/g, 'i').replace(/0/g, 'o');

/** Customer/employee names, with non-person "X Name" labels and relation names removed. */
export function extractNames(text: string): string[] {
  const relations = extractRelationNames(text);
  const out: string[] = [];
  for (const m of text.matchAll(NAME_RE)) {
    if (m[1] && NON_PERSON_NAME_LABEL.has(labelWord(m[1]))) continue;
    if (!m[1] && /^name/i.test(m[0]) && sectionHeadingBefore(text, m.index ?? 0)) continue;
    if (!m[1] && RELATION_INITIAL_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0))) continue;
    let v = (m[2] ?? '').trim().replace(/\s+/g, ' ');
    // The value runs until a character the name class rejects, and ':' is one — so when OCR
    // puts two fields on one line ("Employee Name: Rajesh Das profesion: Engineer") the
    // NEXT field's label is the last word of this "name". A colon right after the match is
    // what identifies it; drop that word rather than carry a label into a person's name.
    if (/^\s*:/.test(text.slice((m.index ?? 0) + m[0].length))) {
      v = v.split(' ').slice(0, -1).join(' ');
    }
    // A salutation is no part of a name: reviewers compare "Anil Mehra" against the salary
    // slip, not "Mr. Anil Mehra", and nameMatches already drops honorifics on both sides.
    v = dropHonorific(v);
    if (!v || isLabelValue(v)) continue;
    const name = cleanPersonName(v);
    if (name) out.push(name);
  }
  for (const m of text.matchAll(BILL_TO_LOOSE)) {
    const name = cleanPersonName(m[1].trim());
    if (name) out.push(name);
  }
  return [...new Set(out)].filter((n) => !relations.some((r) => nameMatches(n, r)));
}

const VEHICLE_PLACEHOLDER = /^(new|applied|apply|tba|temp|na|nil|pending)/i;
// "Vehicle" alone is not a label: a premium table's "BASIC PREMIUM - Vehicle\nTP 5114" read as
// registration TP 5114 (client QA 2026-10, #29). Vehicle needs "No"/"Number"/"Regn";
// Regn/Registration may stand alone. `\.?` after the noise word: "Regn. No. : MH 12 AB 1234"
// extracted nothing with the dot in the way (#32).
const VEHICLE_RE =
  /(?:\bregn?\.?|\bregistration|\bvehicle\s*(?=(?:no|number|regn?|registration)\b))\s*(?:(?:regn?|registration)\.?\s*)?(?:no|number)?\.?\s*[:\-]?\s*([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{0,3}[\s-]?\d{1,4}|NEW|APPLIED[\s-]?FOR|TBA|TEMP\w*)/gi;

/** Indian state / UT registration codes, so a lower-case prose word cannot pass as one. */
const STATE_CODES = new Set(
  ('AN AP AR AS BR CH CG DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY ' +
    'RJ SK TN TR TS UK UA UP WB BH').split(' ')
);

/** Any dash OCR or a word processor may print (en/em dash, minus, figure dash) → '-'. */
export const normDashes = (s: string) => s.replace(/[\u2010-\u2015\u2212]/g, '-');

export function extractVehicleNos(text: string): string[] {
  // A new-car invoice has no registration yet ("NEW"/"APPLIED FOR") — treat as absent.
  return allMatches(normDashes(text), VEHICLE_RE).filter((v) => {
    const bare = v.replace(/[\s-]/g, '');
    if (VEHICLE_PLACEHOLDER.test(bare)) return false;
    if (/^(?:NEW|APPLIED|TBA|TEMP)/i.test(bare)) return true;
    // Printed in capitals with a real state code: "tp 5114" or "Ve 12" is prose.
    return v === v.toUpperCase() && STATE_CODES.has(bare.slice(0, 2));
  });
}

// CHASSIS/ENGINE require an explicit separator ([:\-] or newline) so a run-on OCR of a
// two-column header ("Chassis No Engine No <val1> <val2>") can't attach a value across the
// wrong label. Values must contain a digit (below), so a bare label word ("Engine") is rejected.
const FIELD_RE: Partial<Record<CrossField, RegExp>> = {
  // `\.?` after the noise word: policy schedules print "Chassis No. : X" and "Chassis No.\nX",
  // and without it the dot blocked the separator, so no chassis/engine was ever read off an
  // insurance document — that side of the comparison silently had nothing to compare.
  CHASSIS: /chassis\s*(?:no|number)?\.?\s*[:\-\n]\s*([A-Z0-9]{6,20})/gi,
  ENGINE: /engine\s*(?:no|number)?\.?\s*[:\-\n]\s*([A-Z0-9]{5,20})/gi,
  MODEL: /(?:model|variant|make\s*(?:&|and)?\s*model)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .\-]{1,40})/gi,
  // `\.?` after the noise word: "Employee No. : E1234" read nothing (client QA 2026-10, #16).
  EMP_CODE: /(?:emp(?:loyee)?\.?\s*(?:code|id|no|number)|staff\s*(?:id|code|no))\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,20})/gi,
  // Runs to the end of the line: the character class excludes newlines, so a following
  // field on the next line cannot be swallowed into the address.
  ADDRESS:
    /(?:address|addr|residence|r\/o|resident\s+of)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .,\-\/#()]{9,150})/gi,
  // The label is required: a bare date on a page is an invoice/issue date far more often
  // than a birth date, and comparing those would flag every honest claim.
  DOB: /(?:date\s*of\s*birth|d\.?o\.?b\.?|birth\s*date)\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi,
  // Word-bounded, and no bare "act": that form matched the tail of "Contact No: 9000000001",
  // so a dealer's phone on every policy was read as an account number and failed the
  // Duplicate check on every claim from that dealer.
  // "A/c No. : 1234…" and "Account No 1234…" (dot, or no separator) read nothing, so a
  // shared salary account was never a duplicate (client QA 2026-10, #13). The separator is
  // optional only when "No"/"Number" is present, so "Account 2024-25" is not a number.
  ACCOUNT_NO:
    // A space may split the digit groups, but not lead into the next table column: Infosys
    // payslips print "Bank A/C No 09876543210987 31.00" (days payable), and swallowing "31"
    // split one shared account into two duplicate groups (client QA 2026-10, #16).
    /\b(?:a\/c|acct|account)\.?\s*(?:(?:no|number|#)\.?\s*[:\-]?|[:\-])\s*([0-9](?:[0-9\-]| (?!\d+[.,]\d)){5,22}[0-9])/gi,
  RECEIPT_NO: /receipt\s*(?:no|number|#)?\s*[:\-]\s*([A-Z0-9][A-Z0-9\-\/]{3,24})/gi,
  APPLICATION_NO:
    /(?:application|appl?n)\.?\s*(?:no|number|id|#)?\s*[:\-]\s*([A-Z0-9][A-Z0-9\-\/]{3,24})/gi,
};

/**
 * Words that make an "Address:" the COMPANY's address, not a person's.
 *
 * A policy schedule prints its insurer's head office under "Registered & Corporate Office
 * Address:", in the same shape as "Insured's Address:". Every claim insured by that company
 * then carried it, so the insurer's Mumbai office read as a duplicate data point shared across
 * claims AND as an address mismatch against the customer's own address.
 */
const COMPANY_ADDRESS_WORD =
  /\b(?:corporate|registered|regd|office|branch|broker|agent|dealer|dealership|showroom|workshop|garage|misp|insurer|insurance|company|bank|financier|financer|hypothecation)\b/i;

/**
 * Is this address labelled as a company's?
 *
 * Judged on the run-up SINCE THE LAST COLON OR NEWLINE only. A whole-window look-back would
 * read "Previous OD Insurer : NA Insured's Address" as the insurer's — the word belongs to the
 * field before it, and the colon is what says so.
 */
function isCompanyAddress(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 60), at);
  const runUp = before.slice(Math.max(before.lastIndexOf(':'), before.lastIndexOf('\n')) + 1);
  return COMPANY_ADDRESS_WORD.test(runUp);
}

const DIGIT_REQUIRED = new Set<CrossField>(['CHASSIS', 'ENGINE', 'RECEIPT_NO', 'APPLICATION_NO', 'EMP_CODE']);

export function extractField(field: CrossField, text: string): string[] {
  if (field === 'NAME') return extractNames(text);
  if (field.startsWith('RELATION_')) {
    const kind = field.slice('RELATION_'.length) as RelationKind;
    return extractRelationNamesByKind(text).filter((r) => r.kind === kind).map((r) => r.value);
  }
  if (field === 'VEHICLE_NO') return extractVehicleNos(text);
  const re = FIELD_RE[field];
  if (!re) return [];
  if (field === 'ADDRESS') {
    const out: string[] = [];
    for (const m of text.matchAll(re)) {
      if (isCompanyAddress(text, m.index ?? 0)) continue;
      let raw = (m[1] ?? '').trim();
      // An Aadhaar prints its address over three or four lines ending at the PIN code, and
      // the first line alone ("S/O Ram Kumar,") overlapped too little with the insurance's
      // one-line address to match (client QA 2026-10, #31). When the line carries no PIN and
      // one follows within the next three lines, take the address through it.
      if (!/\b\d{6}\b/.test(raw)) {
        const after = text.slice((m.index ?? 0) + m[0].length).split('\n').slice(0, 4).join('\n');
        const pin = /^([\s\S]*?\b\d{3}\s?\d{3})\b/.exec(after);
        if (pin && pin[1].split('\n').length <= 4) raw = `${raw} ${pin[1]}`;
      }
      // The guardian prefix is a relation, not part of where anyone lives.
      raw = raw.replace(/^(?:[sdwc]\s*\/\s*o|son\s+of|daughter\s+of|wife\s+of|care\s+of)\b[^,\n]*,?\s*/i, '');
      const v = cutAtNextLabel(raw.replace(/\s+/g, ' '), false);
      if (v) out.push(v);
    }
    return [...new Set(out)];
  }
  const vals = allMatches(text, re);
  // A real chassis/engine/reference number always carries a digit; this drops a stray label
  // word that slipped through as a value. The patterns are case-insensitive, so [A-Z0-9]
  // also accepts "Invoice" — stored as a receipt number, it "matched" 49 other claims.
  return DIGIT_REQUIRED.has(field) ? vals.filter((v) => /\d/.test(v)) : vals;
}

// ── Consistency checks ───────────────────────────────────────────────────────────
const ALL_TYPES: DocTypeCode[] = ['INVOICE', 'RC', 'INSURANCE', 'KYC', 'PAYSLIP', 'STAFF_ID', 'DMS'];

interface Check {
  field: CrossField;
  scope: DocTypeCode[];
  match: (a: string, b: string) => boolean;
}

const CHECKS: Check[] = [
  { field: 'NAME', scope: ALL_TYPES, match: nameMatches },
  // One check PER RELATION. Pooling them meant a PAN card printing "Mother's Name" was
  // compared against another document's "Father's Name" — two different people, reported
  // as a mismatch on every claim whose ID card carries the mother's name.
  { field: 'RELATION_FATHER', scope: ALL_TYPES, match: nameMatches },
  { field: 'RELATION_MOTHER', scope: ALL_TYPES, match: nameMatches },
  { field: 'RELATION_SPOUSE', scope: ALL_TYPES, match: nameMatches },
  { field: 'RELATION_GUARDIAN', scope: ALL_TYPES, match: nameMatches },
  { field: 'CHASSIS', scope: ['INVOICE', 'RC', 'INSURANCE'], match: idMatches },
  { field: 'ENGINE', scope: ['INVOICE', 'RC', 'INSURANCE'], match: idMatches },
  { field: 'VEHICLE_NO', scope: ['RC', 'INSURANCE'], match: idMatches },
  { field: 'MODEL', scope: ['INVOICE', 'RC', 'INSURANCE'], match: modelMatches },
  { field: 'EMP_CODE', scope: ['STAFF_ID', 'PAYSLIP'], match: idMatches },
  { field: 'ADDRESS', scope: ALL_TYPES, match: addressMatches },
  // One person has one birth date, so a disagreement between a claim's own documents is
  // real. The reference numbers below are deliberately NOT compared: each document
  // legitimately carries its own receipt/application number.
  { field: 'DOB', scope: ALL_TYPES, match: dateMatches },
];

/** Fields still red when a page could not be classified: label-anchored vehicle IDs. */
const BLIND_RED_FIELDS = new Set<CrossField>(['CHASSIS', 'ENGINE', 'VEHICLE_NO']);

const FIELD_LABEL: Record<CrossField, string> = {
  NAME: 'Customer name',
  RELATION_FATHER: "Father's name",
  RELATION_MOTHER: "Mother's name",
  RELATION_SPOUSE: "Spouse's name",
  RELATION_GUARDIAN: "Guardian's name",
  CHASSIS: 'Chassis number',
  ENGINE: 'Engine number',
  VEHICLE_NO: 'Vehicle number',
  MODEL: 'Model',
  EMP_CODE: 'Employee code',
  ADDRESS: 'Address',
  DOB: 'Date of birth',
  ACCOUNT_NO: 'Account number',
  RECEIPT_NO: 'Receipt number',
  APPLICATION_NO: 'Application number',
};

interface Val {
  value: string;
  documentId: string;
  page: number | null;
  docType: DocTypeCode | 'UNKNOWN';
}

/** VIN-shaped codes on a page (17 chars, 5+ digits), labelled or not. I, O and Q are no VIN
 *  letters but are what OCR prints for 1 and 0 ("MZBEB8I2TTN100005"); idMatches folds them. */
const pageVins = (text: string) =>
  [...text.toUpperCase().matchAll(/\b[A-Z0-9]{17}\b/g)].map((m) => m[0]).filter((v) => (v.match(/\d/g) ?? []).length >= 5);

/** Whose relation this is on a KYC card: the person-shaped text just before "S/O"-style
 *  prefix on its line, else the line above. Null when none reads as a name. */
function relationHolder(text: string, value: string): string | null {
  const at = text.indexOf(value);
  if (at < 0) return null;
  const lines = text.slice(0, at).split('\n');
  const own = (lines.pop() ?? '').replace(/(?:[sdwc]\s*\/\s*o|son\s+of|daughter\s+of|wife\s+of)\s*[:\-]?\s*$/i, '').trim();
  const prev = [...lines].reverse().find((l) => l.trim() !== '') ?? '';
  for (const cand of [own, prev]) {
    const v = cleanPersonName(dropHonorific(cand.replace(/^(?:to|name)\s*[:\-]?\s*/i, '').replace(/[^A-Za-z. ]/g, ' ').replace(/\s+/g, ' ').trim()));
    if (v && v.split(' ').length >= 2) return v;
  }
  return null;
}

/**
 * Compare each field across the claim's classified pages and emit a red flag when a
 * value disagrees across doc types (or documents). Values from UNKNOWN (unclassifiable)
 * pages still take part — type-blind fallback — but any flag they cause is a WARNING
 * (stored, hidden from reviewers), not a red flag, and the page is noted as unclassified.
 */
export function crossDocFieldFindings(pages: CrossPage[], claimVin?: string): FindingInput[] {
  const classified = pages.map((p) => ({ ...p, docType: pageType(p) }));
  const findings: FindingInput[] = [];
  const seen = new Set<string>();
  const unknownContributed = new Set<string>();
  // This claim's car: the claim's own VIN, else what its invoice prints.
  const claimVins = claimVin && pageVins(claimVin).length > 0
    ? [claimVin.toUpperCase()]
    : classified.filter((p) => p.docType === 'INVOICE').flatMap((p) => pageVins(p.text));

  // Two vehicles, not two values for one customer: an exchange or loyalty claim holds the
  // OLD car's policy, or a family member's RC and policy for THEIR car. 325042 compared
  // the old car's registration (client QA 2026-10, #32); 063751 (spouse's Kia), 050310
  // (brother's), 048259 (father's) and 618543 (old Alto) compared their owners' names, on
  // the 570-claim re-run. Pages naming different VINs are about different cars.
  // Only an RC or policy is set aside: a VIN-shaped string on a payslip, KYC card or
  // invoice must not buy it out of the comparison.
  // Judged against THIS claim's car — its VIN — not against whichever
  // cluster is larger, so a family car's papers outnumbering the customer's own cannot
  // set the customer's own RC or policy aside.
  // Same car when the serial — the last six — agrees once OCR glyphs are folded (OCR mangles
  // a VIN's front, "MZBBISHILSN100007" on a customer's own policy, far more than its serial),
  // or within one edit, for a serial digit OCR misread. Deliberately loose: a page close to
  // the claim's VIN is never set aside, so the next car of the batch stays compared and a
  // different owner fails as a name mismatch; an exact-serial rule instead stopped a
  // customer's own misread policy counting as theirs (review, 2026-10-13).
  const sameCar = (x: string, y: string) => idNorm(x).slice(-6) === idNorm(y).slice(-6) || idMatches(x, y);
  const vehiclePaper = (p: { docType: DocTypeCode | 'UNKNOWN' }) => p.docType === 'RC' || p.docType === 'INSURANCE';
  const vinsOn = (documentId: string, page: number | null) =>
    pageVins(classified.find((p) => p.documentId === documentId && p.page === page)?.text ?? '');
  // Another car's papers are set aside only when the customer's OWN RC or policy is in the
  // bundle too: then the other set is the old or family car. Without it, a policy for a
  // different VIN is the fraud this check exists for, and it is compared as before. "Own"
  // uses the same loose sameCar, so the next car of the batch counts as own paper too: a
  // bundle of that car's policy plus a family car's sets the family car aside (still shown,
  // as CROSS_OTHER_VEHICLE). Accepted: the stricter rule failed real claims on one misread.
  const ownCarPapers =
    claimVins.length > 0 &&
    classified.some((p) => vehiclePaper(p) && pageVins(p.text).some((x) => claimVins.some((y) => sameCar(x, y))));
  // An unclassifiable page that prints a VIN is judged the same way: a family car's RC too
  // poorly scanned to classify is still another car's paper.
  const otherCar = (v: Val) => {
    if (!ownCarPapers || !(vehiclePaper(v) || v.docType === 'UNKNOWN')) return false;
    const vins = vinsOn(v.documentId, v.page);
    return vins.length > 0 && !vins.some((x) => claimVins.some((y) => sameCar(x, y)));
  };
  const setAside = new Map<string, Val>(); // documentId:page -> one value from that page

  for (const check of CHECKS) {
    const vals: Val[] = [];
    for (const p of classified) {
      const inScope = p.docType !== 'UNKNOWN' && check.scope.includes(p.docType);
      const isUnknown = p.docType === 'UNKNOWN';
      if (!inScope && !isUnknown) continue;
      for (const value of extractField(check.field, p.text)) {
        vals.push({ value, documentId: p.documentId, page: p.page, docType: p.docType });
        if (isUnknown) unknownContributed.add(`${p.documentId}:${p.page}`);
      }
    }
    // One page has one father. When it yields two and one agrees with another document, the
    // other is the Hindi line read as English: the Aadhaar back's "S/O FAL fig" beside
    // "S/O Gurdeep Singh", or "WHY Oram TER J" beside "Rakesh Arora" (client QA 2026-10,
    // #26-27). Dropped rather than reported.
    if (check.field.startsWith('RELATION_')) {
      // Only the customer's own relation: a family member's KYC in the bundle prints THEIR
      // father ("Pradeep Jain / S/O Mohanlal Jain" in Ankit Jain's claim), and
      // comparing it failed the claim (client QA 2026-10, #30). The holder is the name on
      // the line the "S/O" opens or the line above it; skipped when it is clearly someone
      // else. No holder found, or no customer name to judge by: kept, as before.
      const customers = classified
        .filter((p) => p.docType === 'INVOICE')
        .flatMap((p) => extractNames(p.text));
      if (customers.length > 0) {
        for (let i = vals.length - 1; i >= 0; i--) {
          const p = classified.find((c) => c.documentId === vals[i].documentId && c.page === vals[i].page);
          // A card names its holder above the S/O line; a policy or invoice names the
          // customer under its own label, already in scope.
          const card = p && (p.docType === 'KYC' || p.docType === 'UNKNOWN');
          const holder = card ? relationHolder(p.text, vals[i].value) : null;
          if (holder && !customers.some((c) => nameMatches(c, holder))) vals.splice(i, 1);
        }
      }
      const pageOf = (v: Val) => `${v.documentId}:${v.page}`;
      const agrees = (v: Val) => vals.some((o) => pageOf(o) !== pageOf(v) && check.match(o.value, v.value));
      const settled = new Set(vals.filter(agrees).map(pageOf));
      for (let i = vals.length - 1; i >= 0; i--) {
        if (settled.has(pageOf(vals[i])) && !agrees(vals[i])) vals.splice(i, 1);
      }
    }
    // Set aside before choosing what counts as "expected", so the other car's papers neither
    // get compared nor outvote the customer's own.
    for (let i = vals.length - 1; i >= 0; i--) {
      if (!otherCar(vals[i])) continue;
      setAside.set(`${vals[i].documentId}:${vals[i].page}`, vals[i]);
      vals.splice(i, 1);
    }
    if (vals.length < 2) continue;

    // Greedy equivalence clusters by the field's matcher.
    const clusters: Val[][] = [];
    for (const v of vals) {
      const c = clusters.find((cl) => check.match(cl[0].value, v.value));
      if (c) c.push(v);
      else clusters.push([v]);
    }
    if (clusters.length < 2) continue;

    clusters.sort((a, b) => b.length - a.length);
    const expected = clusters[0];
    const expType = expected[0].docType;
    const expDocs = new Set(expected.map((v) => v.documentId));
    const expVal = expected[0].value;

    for (const cl of clusters.slice(1)) {
      const o = cl[0];
      // Only a cross-doc signal if it crosses a doc-type or document boundary — a second
      // value on the same page/type is extraction noise, not a mismatch.
      if (o.docType === expType && expDocs.has(o.documentId)) continue;
      const key = `${check.field}:${o.documentId}:${o.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A KYC-vs-customer name mismatch is a hard red flag: the client's Data Compare sheet
      // lists every KYC row as "Red Flag" (decision of 2026-09-24). It was a WARNING because
      // a KYC card is often a relative's; relation names are compared separately, so a
      // relative's KYC still disagrees here and the reviewer judges it.
      // Address is always soft: the matcher is deliberately loose, and the sheet does not
      // compare addresses within a claim. An unclassifiable (UNKNOWN) page compares type-blind:
      // its vehicle IDs are read precisely and are what a substituted document changes, so
      // they stay red (a poor scan must not hide a swapped policy); its names, dates and codes
      // are mostly stray text ("Address" as a father, the dealer as the customer), so they are
      // INFO notes the reviewer still sees, not red flags (review, 2026-10-13).
      const soft = check.field === 'ADDRESS';
      const blind = o.docType === 'UNKNOWN' || expType === 'UNKNOWN';
      const note = blind && !BLIND_RED_FIELDS.has(check.field);
      findings.push({
        documentId: o.documentId,
        code: `CROSS_${check.field}_MISMATCH`,
        severity: soft ? 'WARNING' : note ? 'INFO' : 'ERROR',
        message:
          `${FIELD_LABEL[check.field]} "${o.value}" (${o.docType}) does not match "${expVal}" (${expType}) found elsewhere in this claim.` +
          (blind ? ' One page could not be classified; please confirm by eye.' : ''),
        page: o.page,
        data: { field: check.field, expected: expVal, actual: o.value, expectedType: expType, actualType: o.docType },
      });
    }
  }

  // Say which pages were set aside as another vehicle's, so a reviewer can see it was a
  // judgement, not a silent skip. INFO: shown, never a red flag on its own.
  for (const v of setAside.values()) {
    findings.push({
      documentId: v.documentId,
      code: 'CROSS_OTHER_VEHICLE',
      severity: 'INFO',
      message:
        `This ${v.docType === 'RC' ? 'RC' : v.docType === 'INSURANCE' ? 'policy' : 'page'} is for another vehicle ` +
        `(${vinsOn(v.documentId, v.page)[0]}), not this claim's; it was not compared with the customer's documents.`,
      page: v.page,
      data: { vins: vinsOn(v.documentId, v.page) },
    });
  }

  // Record every page we could not classify but that carried a comparable field — the flag
  // above ran type-blind. INFO: shown to the reviewer, never a red flag on its own.
  for (const p of classified) {
    if (p.docType !== 'UNKNOWN') continue;
    if (!unknownContributed.has(`${p.documentId}:${p.page}`)) continue;
    findings.push({
      documentId: p.documentId,
      code: 'CROSS_UNCLASSIFIED',
      severity: 'INFO',
      message: 'Could not classify this document type; cross-document checks ran without type scoping.',
      page: p.page,
    });
  }

  return findings;
}

/** Customer names read off the claim's pages of one document type. */
function namesOn(pages: CrossPage[], type: DocTypeCode): { value: string; documentId: string; page: number | null }[] {
  return pages
    .filter((p) => pageType(p) === type)
    .flatMap((p) => extractField('NAME', p.text).map((value) => ({ value, documentId: p.documentId, page: p.page })));
}

/**
 * Data Compare row 1, "1st Chk to apply": the customer name in the DMS upload (the imported
 * observation sheet) against the invoice. Nothing to say when either side is absent.
 */
export function dmsNameFindings(dmsName: string | null | undefined, pages: CrossPage[]): FindingInput[] {
  if (!dmsName?.trim()) return [];
  return namesOn(pages, 'INVOICE')
    .filter((n) => !nameMatches(dmsName, n.value))
    .slice(0, 1)
    .map((n) => ({
      documentId: n.documentId,
      code: 'CROSS_DMS_NAME_MISMATCH',
      severity: 'ERROR' as const,
      message: `Customer name "${n.value}" on the invoice does not match "${dmsName.trim()}" in the DMS upload.`,
      page: n.page,
      data: { field: 'NAME', expected: dmsName.trim(), actual: n.value, expectedType: 'DMS', actualType: 'INVOICE' },
    }));
}

/**
 * Data Compare, Invoice vs Old car RC: "If details are different with both documents - Red
 * Flag — Same Name / Diff Name". Diff Name IS the red flag for this pair (compareValidator
 * drops the claim-wide name check's line for it, so it is not reported twice); Same Name is
 * a note stating the result.
 */
export function invoiceRcNameResult(pages: CrossPage[]): FindingInput[] {
  const inv = namesOn(pages, 'INVOICE')[0];
  const rc = namesOn(pages, 'RC')[0];
  if (!inv || !rc) return [];
  const same = nameMatches(inv.value, rc.value);
  return [
    {
      documentId: rc.documentId,
      code: same ? 'CROSS_INVOICE_RC_SAME_NAME' : 'CROSS_INVOICE_RC_DIFF_NAME',
      severity: same ? 'INFO' : 'ERROR',
      message: same
        ? `Invoice vs RC customer name: Same Name ("${inv.value}").`
        : `Invoice vs RC customer name: Diff Name ("${inv.value}" vs "${rc.value}").`,
      page: rc.page,
      data: { invoice: inv.value, rc: rc.value },
    },
  ];
}
