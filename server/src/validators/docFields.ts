/**
 * Field panes for the document comparison screen: given one document's text, produce the
 * ordered label/value list a reviewer compares against DMS and digital verification.
 *
 * Pure (no I/O, no prisma) so it unit-tests with string fixtures, same discipline as
 * redFlagLogic. Every extractor here is one the validators already use — this module only
 * chooses WHICH fields a document type shows and in what order. The one addition is date
 * of birth, which no rule needed until now.
 */
import { classifyPage } from './segment.js';
import { classifyDocType, extractNames, extractRelationNamesByKind } from './crossDocLogic.js';
import { aadhaarNumbers } from './redFlagLogic.js';

export interface DocField {
  label: string;
  value: string | null;
}

/** The document kinds that get a field pane. Govt codes come from classifyPage, business
 *  types from classifyDocType; PAN/AADHAR win when both fire (a KYC page IS a PAN card). */
export type FieldDocType = 'PAN' | 'AADHAR' | 'INVOICE' | 'INSURANCE' | 'GST';

/**
 * A GST REGISTRATION CERTIFICATE, as opposed to any page that merely mentions GST.
 *
 * The shared GOVT_TYPE_MARKERS.GST also fires on "goods and services tax", which a dealer's
 * tax invoice prints too — routing those pages to the GST pane would strip an invoice of its
 * invoice number, chassis and model. The certificate carries its own wording (Form GST
 * REG-06, "Legal Name", "Type of Registration"), so require one of those here. The loose
 * marker is left untouched for FULL's required-document check, which only asks "is a GST
 * document present at all".
 */
const GST_CERT_RE = /gst\s*reg-?\s*0?6|registration\s+certificate|legal\s+name|type\s+of\s+registrat/i;

export function fieldDocType(text: string): FieldDocType | null {
  const govt = classifyPage(text);
  if (govt === 'PAN' || govt === 'AADHAR') return govt;
  if (govt === 'GST' && GST_CERT_RE.test(text)) return 'GST';
  const biz = classifyDocType(text);
  if (biz === 'INVOICE' || biz === 'INSURANCE') return biz;
  return null;
}

const first = (v: string[]): string | null => v[0] ?? null;

/** One label-anchored value, or null. Wraps the shared matcher so a missing field is a
 *  blank box on screen rather than a thrown error. */
function one(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m?.[1] ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// ── Extractors this screen adds ────────────────────────────────────────────────
// Date of birth: the label varies more than the value does, so anchor on the label and
// accept any of the three separators Indian documents print.
const DOB_RE = /(?:date\s*of\s*birth|d\.?o\.?b\.?|birth\s*date|जन्म)\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i;
const INVOICE_NO_RE = /invoice\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,25})/i;
const INVOICE_DATE_RE = /invoice\s*date\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i;
const CUSTOMER_ID_RE = /customer\s*id\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,25})/i;
const POLICY_NO_RE = /policy\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{4,25})/i;
// `\.?` and `[:\-\n]` mirror crossDocLogic: documents print "Chassis No. : X" as often as
// "Chassis No\nX", and both have to read the same value the comparison rules read.
const CHASSIS_RE = /chassis\s*(?:no|number)?\.?\s*[:\-\n]\s*([A-Z0-9]{6,20})/i;
const ENGINE_RE = /engine\s*(?:no|number)?\.?\s*[:\-\n]\s*([A-Z0-9]{5,20})/i;
const MODEL_RE = /(?:model|variant)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .\-]{1,40})/i;
const VID_RE = /\bV\.?I\.?D\.?\s*[:\-]?\s*((?:\d[\s-]?){13,15}\d)/i;

/**
 * The Aadhaar number on a page already classified as an Aadhaar card.
 *
 * Deliberately NOT anchored to the word "Aadhaar": a real card prints the number on its own
 * in large digits, with the word nowhere near it, so requiring the label found nothing. The
 * page classification is the anchor. Uses the SAME reader as the REDFLAG mismatch rule, so
 * the pane and the fraud check can never disagree about what the Aadhaar number is.
 */
function aadhaarNumber(text: string): string | null {
  const digits = aadhaarNumbers(text)[0];
  return digits ? digits.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') : null;
}

// PAN is its own proof: five letters, four digits, a letter. Scanning the shape beats
// anchoring on the word "PAN", which on a real card also appears in "PAN Services Unit" —
// and duly reported the holder's PAN as "SERVICES".
const PAN_SHAPE_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/;
/** GSTIN: 2 state digits, the holder's PAN, an entity digit, 'Z', a checksum character.
 *  Label-anchored first; the bare shape is distinctive enough to stand alone as a fallback.
 *  Note the PAN inside a GSTIN has no word boundary before it, so PAN_SHAPE_RE cannot
 *  mistake "24AAGFO2658A1ZM" for the PAN — it correctly finds the separate "PAN :" line. */
const GSTIN_LABEL_RE = /gst(?:in|\s*no)\.?\s*[:\-]?\s*(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])/i;
const GSTIN_SHAPE_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/;

// Names on an ID card sit in a table cell next to their label, with no colon between them,
// and the labels are bilingual. Anything requiring "Label: Value" reads nothing off them.
const CARD_LABEL: Record<'HOLDER' | 'FATHER' | 'MOTHER', RegExp> = {
  FATHER: /(?:पिता\s*का\s*नाम|father'?s?\s*name)/i,
  MOTHER: /(?:माता\s*का\s*नाम|mother'?s?\s*name)/i,
  HOLDER: /(?:नाम|\bname\b)/i,
};
// A value of two or more ALL-CAPS words. Stops at the next label, which is mixed case
// ("Father's name") or Devanagari, and never runs across a line break.
const CAPS_NAME_RE = /([A-Z]{2,}(?:[ \t]+[A-Z]{2,})*)/;
// ALL-CAPS words printed on the card itself. Without this the masthead wins: the first
// caps run after a stray "नाम" in the Hindi footer is "GOVT", and that is what the holder
// name showed.
const CARD_BOILERPLATE = new Set([
  'GOVT', 'GOVERNMENT', 'OF', 'INDIA', 'INCOME', 'TAX', 'DEPARTMENT', 'DEPT', 'PERMANENT',
  'ACCOUNT', 'NUMBER', 'CARD', 'PAN', 'EPAN', 'SIGNATURE', 'SERVICES', 'UNIT', 'UIDAI',
  'AADHAAR', 'AADHAR', 'UNIQUE', 'IDENTIFICATION', 'AUTHORITY', 'VID', 'DOB', 'MALE',
  'FEMALE', 'GENDER', 'DATE', 'BIRTH', 'ISSUE', 'ISSUED', 'NAME', 'FATHER', 'MOTHER',
  'ADDRESS', 'HELP', 'DESK', 'TOLL', 'FREE', 'WWW', 'GOV', 'IN',
]);
const isBoilerplate = (v: string) => v.split(/\s+/).every((w) => CARD_BOILERPLATE.has(w));
// The holder label "Name" is a substring of "Father's name" / "Mother's name"; a match whose
// run-up carries one of those words belongs to the parent, not the holder.
const PARENT_RUNUP = /(?:father|mother|पिता|माता)(?:'?s)?[^A-Za-z]{0,6}(?:का\s*)?(?:नाम|name)?\s*$/i;

function cardName(text: string, kind: 'HOLDER' | 'FATHER' | 'MOTHER'): string | null {
  const label = CARD_LABEL[kind];
  let from = 0;
  for (let i = 0; i < 6; i++) {
    const m = label.exec(text.slice(from));
    if (!m) return null;
    const at = from + m.index + m[0].length;
    from = at;
    if (kind === 'HOLDER' && PARENT_RUNUP.test(text.slice(Math.max(0, at - m[0].length - 16), at))) {
      continue; // this "Name" is the tail of "Father's name" — keep looking
    }
    // Only look just past the label: a value further away belongs to another cell.
    const window = text.slice(at, at + 60);
    const v = CAPS_NAME_RE.exec(window);
    if (!v) continue;
    const value = v[1].trim().replace(/\s+/g, ' ');
    if (isBoilerplate(value)) continue; // masthead, not a person — keep looking
    return value;
  }
  return null;
}

// ── Reading names off a card by LINE POSITION ─────────────────────────────────────────
// The label-anchored readers above need a label to survive OCR. On a photographed card the
// labels are bilingual, and the Devanagari half comes back as noise that swallows the Latin
// half with it ("नाम / Name" → "Te PAT A CAI a NE"). What DOES survive is the layout: the
// holder's name is the line above the father label on a PAN card, and the line above the
// date of birth on an Aadhaar. That position is what these read.

/** A person-name run: Title Case or ALL CAPS words, 2+ of them, no digits. */
const NAME_RUN_RE = /([A-Z][A-Za-z]{1,}(?:[ \t]+[A-Z][A-Za-z]{1,})+)/g;

/**
 * The name on one line, taken as the LAST name-shaped run so leading OCR debris
 * ("° ~~) Ravi Shankar") is skipped rather than read as part of the name.
 */
function nameOnLine(line: string): string | null {
  const runs = [...line.matchAll(NAME_RUN_RE)].map((m) => m[1].trim().replace(/\s+/g, ' '));
  for (const run of runs.reverse()) {
    if (isBoilerplate(run)) continue;
    const words = run.split(' ');
    // The Devanagari label on the row below often bleeds a fragment onto the name's line
    // ("RAVI SHANKAR ATA" — "ATA" is what "नाम" OCR'd to). Drop a short trailing fragment,
    // but only when a two-word name still remains, so "RAVI KUMAR" is never truncated.
    // ponytail: costs a genuine 3-word name ending in a 3-letter word its last word. If
    // that shows up, compare the run against the other documents in the claim instead.
    if (words.length > 2 && words[words.length - 1].length <= 3) words.pop();
    if (words.length >= 2) return words.join(' ');
  }
  return null;
}

/** The nearest name-carrying line ABOVE the first line matching `anchor`. */
function nameAboveLine(text: string, anchor: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => anchor.test(l));
  if (at < 1) return null;
  // Two lines of look-back: the row directly above is sometimes pure debris.
  for (let i = at - 1; i >= Math.max(0, at - 2); i--) {
    const v = nameOnLine(lines[i]);
    if (v) return v;
  }
  return null;
}

// Aadhaar prints the date of birth directly UNDER the holder's name, so the DOB row is the
// anchor for the name — the card carries no "Name" label at all, in either script.
const AADHAAR_DOB_LINE_RE = /(?:date\s*of\s*birth|\bdob\b|जन्म)/i;

// Gender is printed on its own, unlabelled. FEMALE must be tried before MALE — it contains
// it — and Aadhaar prints the Hindi alongside, which survives OCR more often than not.
const GENDER_RE = /\b(FEMALE|MALE|TRANSGENDER)\b|(महिला|पुरुष|स्त्री)/i;

function gender(text: string): string | null {
  const m = GENDER_RE.exec(text);
  if (!m) return null;
  if (m[2]) return m[2] === 'पुरुष' ? 'MALE' : 'FEMALE';
  return m[1].toUpperCase();
}

// An Aadhaar carries the father's name only as the address's care-of line. W/O is
// deliberately NOT matched: that names a husband, and reporting one as the father is worse
// than leaving the field blank.
const CARE_OF_RE = /\b(?:C\s*\/\s*O|S\s*\/\s*O|D\s*\/\s*O|care\s*of)\b\s*[:\-]?\s*([A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*)*)/;

function careOfName(text: string): string | null {
  const m = CARE_OF_RE.exec(text);
  if (!m?.[1]) return null;
  const v = m[1].trim().replace(/\s+/g, ' ');
  return isBoilerplate(v) || v.split(' ').length < 2 ? null : v;
}

// ── Policy schedule ───────────────────────────────────────────────────────────────────
// A schedule prints "Insured's Name" against an OCR-mangled separator (the ':' comes back
// as '+', '©' or '~'), and the generic "…Name:" extractor needs a real colon. It also has
// several other names on the page — insurer, broker, MISP, nominee — so anchoring on THE
// insured label rather than taking the first name found is what keeps the dealership out.
const INSURED_LABEL_RE = /insured'?s?\s*name\s*[:\-+©~*]?\s*/i;
// Case-SENSITIVE, and deliberately not folded into the label regex: an /i there would let
// the value run straight on into the next column ("RAVI SHANKAR Period of Third Party…").
// Each token needs two+ capitals, which is what stops it at the "P" of "Period".
// ponytail: costs a single-letter initial ("R SHANKAR" → "SHANKAR"). Widen if a schedule
// that abbreviates the first name shows up.
const CAPS_VALUE_RE = /^([A-Z][A-Z_.]+(?:[ \t]+[A-Z][A-Z_.]+)*)/;
// Salutations arrive fused to the name by OCR ("MR_RAVI SHANKAR").
const SALUTATION_RE = /^(?:MR|MRS|MS|M\/S|SHRI|SMT|DR)[_.\s]+/i;

function insuredName(text: string): string | null {
  const m = INSURED_LABEL_RE.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  const v0 = CAPS_VALUE_RE.exec(text.slice(at, at + 60));
  if (!v0) return null;
  const v = v0[1].replace(SALUTATION_RE, '').trim().replace(/[_\s]+/g, ' ');
  return !v || isBoilerplate(v) ? null : v;
}

/**
 * Tokens of the row directly beneath the header line matching `header`.
 *
 * Vehicle details on a policy schedule are a TWO-LINE TABLE — the column headers on one
 * line, their values on the next — so chassis, engine and model have no "Label: value"
 * anchor anywhere on the page, which is why all three read as absent.
 */
function rowUnder(text: string, header: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => header.test(l));
  if (i < 0) return [];
  return (lines[i + 1] ?? '').trim().split(/\s+/).filter(Boolean);
}

/** An identifier-shaped token: letters AND digits, so a header word or a bare number in the
 *  same row is never mistaken for a chassis or engine number. */
const idToken = (t: string, min: number, max: number) =>
  t.length >= min && t.length <= max && /^[A-Z0-9]+$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t);

const VEHICLE_ROW_RE = /chassis\s*no/i;

function chassisFromRow(text: string): string | null {
  return rowUnder(text, VEHICLE_ROW_RE).find((t) => idToken(t, 15, 20)) ?? null;
}

function engineFromRow(text: string): string | null {
  const row = rowUnder(text, VEHICLE_ROW_RE);
  const chassis = row.find((t) => idToken(t, 15, 20));
  return row.find((t) => t !== chassis && idToken(t, 8, 14)) ?? null;
}

/** "Make Model Variant …" over "KIA SYROS SYROS D1.5 6MT HTK(O) …" — the model is the
 *  column after the make. ponytail: positional, so a schedule that drops the Make column
 *  would read the variant instead; the label-anchored MODEL_RE is still tried first. */
function modelFromRow(text: string): string | null {
  const row = rowUnder(text, /\bmake\b[\s\S]{0,40}?\bmodel\b/i);
  return row[1] ?? null;
}

// A vehicle invoice never labels the buyer "Name" — it says "Bill To" or "Sold To", so the
// shared name extractor (which anchors on "…Name:") read nothing and Customer Name showed
// as absent on an invoice that plainly carries it.
const BILL_TO_RE = /\b(?:bill(?:ed)?\s*to|sold\s*to|buyer)\b\s*[:\-]?\s*/i;

function billToName(text: string): string | null {
  const m = BILL_TO_RE.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  const v = CAPS_NAME_RE.exec(text.slice(at, at + 60));
  if (!v) return null;
  const value = v[1].trim().replace(/\s+/g, ' ');
  return isBoilerplate(value) ? null : value;
}

/** A relation name, from the shared label-anchored extractor first (it handles "S/o X" and
 *  "Father's Name: X"), falling back to the card-table reading. */
const relation = (text: string, kind: 'FATHER' | 'MOTHER' | 'SPOUSE') =>
  first(extractRelationNamesByKind(text).filter((r) => r.kind === kind).map((r) => r.value)) ??
  (kind === 'SPOUSE' ? null : cardName(text, kind));

/** The first REAL dd/mm/yyyy on the page, as a fallback when the date sits in a cell away
 *  from its label. The calendar check is what stops "+91-20-2721 8080" — the NSDL helpline
 *  printed on every PAN card — from being reported as a date of birth. */
const ANY_DATE_RE = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g;

function anyDate(text: string): string | null {
  for (const m of text.matchAll(ANY_DATE_RE)) {
    const [, d, mo, y] = m.map(Number);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 1900 && y <= 2100) return m[0];
  }
  return null;
}

/**
 * The fields one document type shows, in the order the reviewer reads them off the page.
 * A field with no value renders as an empty box — that is information too ("the document
 * does not carry this"), so absent fields are kept rather than filtered out.
 */
export function documentFields(text: string, type: FieldDocType): DocField[] {
  switch (type) {
    // ID cards are tables of bilingual labels beside their values, so each field falls back
    // to the card reading when the shared "Label: Value" extractors find nothing.
    case 'PAN': {
      // A PAN card prints a father's OR a mother's name, never both — so show the ONE row
      // the card carries instead of a pair with a permanently empty half.
      const mother = relation(text, 'MOTHER');
      const parent = mother
        ? { label: "Mother's Name", value: mother }
        : { label: "Father's Name", value: relation(text, 'FATHER') };
      return [
        { label: 'PAN Number', value: one(text.toUpperCase(), PAN_SHAPE_RE) },
        {
          label: 'Holder Name',
          value:
            first(extractNames(text)) ??
            cardName(text, 'HOLDER') ??
            nameAboveLine(text, CARD_LABEL.FATHER) ??
            nameAboveLine(text, CARD_LABEL.MOTHER),
        },
        parent,
        { label: 'Date of Birth', value: one(text, DOB_RE) ?? anyDate(text) },
      ];
    }
    case 'AADHAR':
      return [
        { label: 'Aadhaar Number', value: aadhaarNumber(text) },
        { label: 'VID', value: one(text, VID_RE) },
        {
          label: 'Holder Name',
          value:
            first(extractNames(text)) ??
            cardName(text, 'HOLDER') ??
            nameAboveLine(text, AADHAAR_DOB_LINE_RE),
        },
        { label: 'Gender', value: gender(text) },
        { label: "Father's Name", value: relation(text, 'FATHER') ?? careOfName(text) },
        { label: 'Date of Birth', value: one(text, DOB_RE) ?? anyDate(text) },
      ];
    // GST registration certificate. Its QR repeats what the certificate prints, so these
    // rows are what a reviewer checks the code against — the whole point of reading it.
    case 'GST':
      return [
        { label: 'GSTIN', value: one(text.toUpperCase(), GSTIN_LABEL_RE) ?? one(text.toUpperCase(), GSTIN_SHAPE_RE) },
        // The holder's PAN is printed separately AND embedded in the GSTIN; PAN_SHAPE_RE's
        // word boundaries mean it reads the printed one, not the substring.
        { label: 'PAN Number', value: one(text.toUpperCase(), PAN_SHAPE_RE) },
        // NO Legal Name / Trade Name / Date of Registration rows. A real REG-06 is a NUMBERED
        // FORM whose labels OCR into one run — "1. Legal Name 2. Trade Name, if any
        // 3. Constitution of Business ..." — with the values in a separate column. A
        // label-anchored regex captures the FOLLOWING LABELS as the value: on claim
        // MZBEU813LSN749087 p.6 "Legal Name" returned "2. Trade Name, if any 3. Constitution
        // of Business Partnership 4. Address of Prin". Showing that to a reviewer is worse
        // than showing nothing. Reinstate only with a layout-aware extractor tested against
        // real OCR text, not a hand-written fixture.
      ];
    case 'INVOICE':
      return [
        { label: 'Invoice No', value: one(text, INVOICE_NO_RE) },
        { label: 'Invoice Date', value: one(text, INVOICE_DATE_RE) },
        { label: 'Customer Id', value: one(text, CUSTOMER_ID_RE) },
        { label: 'Customer Name', value: first(extractNames(text)) ?? billToName(text) },
        { label: 'Chassis No', value: one(text, CHASSIS_RE) },
        { label: 'Engine No', value: one(text, ENGINE_RE) },
        { label: 'Model', value: one(text, MODEL_RE) },
      ];
    case 'INSURANCE':
      return [
        { label: 'Policy No', value: one(text, POLICY_NO_RE) },
        // The insured's own label first: a schedule names the insurer, broker, MISP and
        // nominee too, and the generic extractor returns whichever it meets first.
        { label: "Insured's Name", value: insuredName(text) ?? first(extractNames(text)) },
        { label: 'Chassis No', value: one(text, CHASSIS_RE) ?? chassisFromRow(text) },
        { label: 'Engine No', value: one(text, ENGINE_RE) ?? engineFromRow(text) },
        { label: 'Model', value: one(text, MODEL_RE) ?? modelFromRow(text) },
      ];
  }
}

export interface FieldGroup {
  type: FieldDocType;
  /** 1-based pages this group was read from, so a reviewer can jump to them. */
  pages: number[];
  fields: DocField[];
}

export const TYPE_LABEL: Record<FieldDocType, string> = {
  PAN: 'PAN Card',
  AADHAR: 'Aadhaar',
  INVOICE: 'Invoice',
  INSURANCE: 'Insurance Policy',
  GST: 'GST Certificate',
};

/**
 * One group per document type found across the pages of a file.
 *
 * A claim document is routinely a BUNDLE — invoice, then policy, then PAN, then Aadhaar, in
 * one PDF. Classifying the joined text picks a single type for all of it and then reads
 * every field from everywhere, so an invoice's toll-free number lands in the Aadhaar box.
 * Each type is instead extracted from only its own pages.
 */
export function docFieldGroups(pageTexts: string[]): FieldGroup[] {
  const byType = new Map<FieldDocType, { pages: number[]; text: string[] }>();
  pageTexts.forEach((text, i) => {
    const type = fieldDocType(text);
    if (!type) return;
    const entry = byType.get(type) ?? { pages: [], text: [] };
    entry.pages.push(i + 1);
    entry.text.push(text);
    byType.set(type, entry);
  });
  return [...byType.entries()].map(([type, e]) => ({
    type,
    pages: e.pages,
    // Pages of the SAME type are joined: a policy schedule spans pages, and its chassis
    // number can sit on a different page from the insured's name.
    fields: documentFields(e.text.join('\n'), type),
  }));
}

/**
 * Groups for one document. `pages` is what META persists now; `text` is the joined
 * fallback for a claim validated before page texts were stored — it still produces a pane,
 * just the single-type one, rather than nothing at all.
 */
export function docFieldPane(text: string, pages?: string[]): FieldGroup[] {
  if (pages && pages.length > 0) return docFieldGroups(pages);
  const type = fieldDocType(text);
  return type ? [{ type, pages: [], fields: documentFields(text, type) }] : [];
}
