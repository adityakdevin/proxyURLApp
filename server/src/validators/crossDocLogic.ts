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
  | 'EMP_CODE';

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
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'shri', 'smt', 'sri', 'thiru', 'dr', 'master', 'kum', 'm/s', 'ms/']);

/** Lowercase alnum tokens, honorifics dropped. "Mr. Rajesh Kumar" → ["rajesh","kumar"]. */
export function nameTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s.]/g, ' ')
    .split(/[\s.]+/)
    .filter((t) => t && !HONORIFICS.has(t));
}

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
  if (sa.length > sb.length) [sa, sb] = [sb, sa];
  const used = new Array(sb.length).fill(false);
  const aligns = (x: string, y: string) =>
    x === y ||
    (x.length === 1 && y[0] === x) ||
    (y.length === 1 && x[0] === y) ||
    // OCR drift inside a longer token ("Kumar" vs "Kumr"): tolerate one edit. Bounded to
    // 4+ char tokens so genuinely-distinct short tokens don't collapse.
    (x.length >= 4 && y.length >= 4 && within1(x, y));
  for (const t of sa) {
    const i = sb.findIndex((u, idx) => !used[idx] && aligns(t, u));
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
  return first.length === 0 || FIELD_LABEL_WORD.has(first);
}

/** Relation names tagged with WHOSE name it is. */
export function extractRelationNamesByKind(text: string): { kind: RelationKind; value: string }[] {
  const out: { kind: RelationKind; value: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(RELATION_RE)) {
    const label = (m[1] ?? m[3] ?? '').toLowerCase();
    const value = (m[2] ?? m[4] ?? '').trim().replace(/\s+/g, ' ');
    const kind = RELATION_OF[label];
    if (!kind || !value || isLabelValue(value)) continue;
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
]);

// Group 1 = the single word immediately before "Name" (if any); group 2 = the value.
// The `(?:'?s)?` after the label word catches the possessive form — without it
// "Nominee's Name: X" captured a bare "s" as the label, which is in no blocklist, so
// the nominee leaked through as the customer's name.
const NAME_RE =
  /(?:([A-Za-z]+)(?:'?s)?\s+)?name\s*(?:of\s+(?:the\s+)?(?:insured|customer|employee|applicant|proposer))?\s*[:\-]\s*([A-Za-z][A-Za-z. ]{2,40})/gi;

/** Customer/employee names, with non-person "X Name" labels and relation names removed. */
export function extractNames(text: string): string[] {
  const relations = extractRelationNames(text);
  const out: string[] = [];
  for (const m of text.matchAll(NAME_RE)) {
    if ((m[1] ?? '').toLowerCase() && NON_PERSON_NAME_LABEL.has((m[1] ?? '').toLowerCase())) continue;
    const v = (m[2] ?? '').trim().replace(/\s+/g, ' ');
    if (v && !isLabelValue(v)) out.push(v);
  }
  return [...new Set(out)].filter((n) => !relations.some((r) => nameMatches(n, r)));
}

const VEHICLE_PLACEHOLDER = /^(new|applied|apply|tba|temp|na|nil|pending)/i;
const VEHICLE_RE =
  /(?:regn?\.?|registration|vehicle)\s*(?:no|number)?\s*[:\-]?\s*([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{0,3}[\s-]?\d{1,4}|NEW|APPLIED[\s-]?FOR|TBA|TEMP\w*)/gi;

export function extractVehicleNos(text: string): string[] {
  // A new-car invoice has no registration yet ("NEW"/"APPLIED FOR") — treat as absent.
  return allMatches(text, VEHICLE_RE).filter((v) => !VEHICLE_PLACEHOLDER.test(v.replace(/\s/g, '')));
}

// CHASSIS/ENGINE require an explicit separator ([:\-] or newline) so a run-on OCR of a
// two-column header ("Chassis No Engine No <val1> <val2>") can't attach a value across the
// wrong label. Values must contain a digit (below), so a bare label word ("Engine") is rejected.
const FIELD_RE: Partial<Record<CrossField, RegExp>> = {
  CHASSIS: /chassis\s*(?:no|number)?\s*[:\-\n]\s*([A-Z0-9]{6,20})/gi,
  ENGINE: /engine\s*(?:no|number)?\s*[:\-\n]\s*([A-Z0-9]{5,20})/gi,
  MODEL: /(?:model|variant|make\s*(?:&|and)?\s*model)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .\-]{1,40})/gi,
  EMP_CODE: /(?:emp(?:loyee)?\.?\s*(?:code|id|no|number)|staff\s*(?:id|code|no))\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,20})/gi,
};

function extractField(field: CrossField, text: string): string[] {
  if (field === 'NAME') return extractNames(text);
  if (field.startsWith('RELATION_')) {
    const kind = field.slice('RELATION_'.length) as RelationKind;
    return extractRelationNamesByKind(text).filter((r) => r.kind === kind).map((r) => r.value);
  }
  if (field === 'VEHICLE_NO') return extractVehicleNos(text);
  const re = FIELD_RE[field];
  if (!re) return [];
  const vals = allMatches(text, re);
  // A real chassis/engine number always carries a digit; this drops a stray label word
  // ("Engine", "Model") that slipped through as a value.
  return field === 'CHASSIS' || field === 'ENGINE' ? vals.filter((v) => /\d/.test(v)) : vals;
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
];

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
};

interface Val {
  value: string;
  documentId: string;
  page: number | null;
  docType: DocTypeCode | 'UNKNOWN';
}

/**
 * Compare each field across the claim's classified pages and emit a red flag when a
 * value disagrees across doc types (or documents). Values from UNKNOWN (unclassifiable)
 * pages still take part — type-blind fallback — but any flag they cause is a WARNING,
 * not a hard red flag, and the page is separately noted as unclassified.
 */
export function crossDocFieldFindings(pages: CrossPage[]): FindingInput[] {
  const classified = pages.map((p) => ({ ...p, docType: pageType(p) }));
  const findings: FindingInput[] = [];
  const seen = new Set<string>();
  const unknownContributed = new Set<string>();

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
      // A KYC doc's own name is often a relation/nominee's, so a KYC-vs-customer name
      // disagreement is ambiguous — surface it as WARNING, not a hard red flag. Name
      // agreement across the other doc types (Invoice/RC/Insurance/Payslip/Staff-ID/DMS)
      // stays ERROR. Same soft treatment for unclassifiable (UNKNOWN) pages.
      const kycInvolved = check.field === 'NAME' && (o.docType === 'KYC' || expType === 'KYC');
      const soft = o.docType === 'UNKNOWN' || expType === 'UNKNOWN' || kycInvolved;
      findings.push({
        documentId: o.documentId,
        code: `CROSS_${check.field}_MISMATCH`,
        severity: soft ? 'WARNING' : 'ERROR',
        message: `${FIELD_LABEL[check.field]} "${o.value}" (${o.docType}) does not match "${expVal}" (${expType}) found elsewhere in this claim.`,
        page: o.page,
        data: { field: check.field, expected: expVal, actual: o.value, expectedType: expType, actualType: o.docType },
      });
    }
  }

  // Surface every page we could not classify but that carried a comparable field —
  // the flag above ran type-blind, so the WARNING tells a reviewer precision was reduced.
  for (const p of classified) {
    if (p.docType !== 'UNKNOWN') continue;
    if (!unknownContributed.has(`${p.documentId}:${p.page}`)) continue;
    findings.push({
      documentId: p.documentId,
      code: 'CROSS_UNCLASSIFIED',
      severity: 'WARNING',
      message: 'Could not classify this document type; cross-document checks ran without type scoping.',
      page: p.page,
    });
  }

  return findings;
}
