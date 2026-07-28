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
export type FieldDocType = 'PAN' | 'AADHAR' | 'INVOICE' | 'INSURANCE';

export function fieldDocType(text: string): FieldDocType | null {
  const govt = classifyPage(text);
  if (govt === 'PAN' || govt === 'AADHAR') return govt;
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
    case 'PAN':
      return [
        { label: 'PAN Number', value: one(text.toUpperCase(), PAN_SHAPE_RE) },
        { label: 'Holder Name', value: first(extractNames(text)) ?? cardName(text, 'HOLDER') },
        // A PAN card prints one or the other, never both.
        { label: "Father's Name", value: relation(text, 'FATHER') },
        { label: "Mother's Name", value: relation(text, 'MOTHER') },
        { label: 'Date of Birth', value: one(text, DOB_RE) ?? anyDate(text) },
      ];
    case 'AADHAR':
      return [
        { label: 'Aadhaar Number', value: aadhaarNumber(text) },
        { label: 'VID', value: one(text, VID_RE) },
        { label: 'Holder Name', value: first(extractNames(text)) ?? cardName(text, 'HOLDER') },
        { label: "Father's Name", value: relation(text, 'FATHER') },
        { label: 'Date of Birth', value: one(text, DOB_RE) ?? anyDate(text) },
      ];
    case 'INVOICE':
      return [
        { label: 'Invoice No', value: one(text, INVOICE_NO_RE) },
        { label: 'Invoice Date', value: one(text, INVOICE_DATE_RE) },
        { label: 'Customer Id', value: one(text, CUSTOMER_ID_RE) },
        { label: 'Customer Name', value: first(extractNames(text)) },
        { label: 'Chassis No', value: one(text, CHASSIS_RE) },
        { label: 'Engine No', value: one(text, ENGINE_RE) },
        { label: 'Model', value: one(text, MODEL_RE) },
      ];
    case 'INSURANCE':
      return [
        { label: 'Policy No', value: one(text, POLICY_NO_RE) },
        { label: "Insured's Name", value: first(extractNames(text)) },
        { label: 'Chassis No', value: one(text, CHASSIS_RE) },
        { label: 'Engine No', value: one(text, ENGINE_RE) },
        { label: 'Model', value: one(text, MODEL_RE) },
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
