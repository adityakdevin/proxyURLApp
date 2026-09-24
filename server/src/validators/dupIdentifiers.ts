/**
 * The identity and reference numbers from the client's Duplicacy sheet, read off one page for
 * the duplicate check (Master sheet item 1). Every one is a hard duplicate: the same number on
 * two claims fails the check.
 *
 * The danger with "the same number on two claims" is the numbers every claim shares for an
 * honest reason. A dealer prints its own GSTIN and PAN on every invoice; an insurer prints its
 * PAN on every policy. Treated as duplicates they would fail every claim from that dealer or
 * insurer. So each number is read only where it can belong to the CUSTOMER:
 *  - PAN: an individual's only (fourth letter P). Company PANs (C, F, H, …) are never read.
 *  - GSTIN: only from a GST registration certificate, or a "Customer GSTIN" label.
 *  - Aadhaar, DL, passport, voter ID: only on that card's own page, or beside its label —
 *    their bare shapes (12 digits, a letter and seven digits) match plenty of other numbers.
 *  - Everything else only beside its own label.
 */
import { GOVT_TYPE_MARKERS } from './logic.js';
import { aadhaarNumbers } from './redFlagLogic.js';

export type IdentifierField =
  | 'POLICY_NO'
  | 'PAN'
  | 'AADHAAR'
  | 'DL_NO'
  | 'PASSPORT_NO'
  | 'VOTER_ID'
  | 'GSTIN'
  | 'UDYAM_NO'
  | 'FSSAI_NO'
  | 'PF_NO'
  | 'UAN'
  | 'GPF_NO'
  | 'PRAN'
  | 'ESI_NO'
  | 'PENSION_NO'
  | 'CERT_REG_NO'
  | 'RATION_CARD_NO';

export const IDENTIFIER_FIELDS: IdentifierField[] = [
  'POLICY_NO', 'PAN', 'AADHAAR', 'DL_NO', 'PASSPORT_NO', 'VOTER_ID', 'GSTIN', 'UDYAM_NO',
  'FSSAI_NO', 'PF_NO', 'UAN', 'GPF_NO', 'PRAN', 'ESI_NO', 'PENSION_NO', 'CERT_REG_NO', 'RATION_CARD_NO',
];

export const IDENTIFIER_LABEL: Record<IdentifierField, string> = {
  POLICY_NO: 'Policy number',
  PAN: 'PAN',
  AADHAAR: 'Aadhaar number',
  DL_NO: 'Driving licence number',
  PASSPORT_NO: 'Passport number',
  VOTER_ID: 'Voter ID (EPIC)',
  GSTIN: 'GSTIN',
  UDYAM_NO: 'Udyam number',
  FSSAI_NO: 'FSSAI licence number',
  PF_NO: 'PF number',
  UAN: 'UAN',
  GPF_NO: 'GPF number',
  PRAN: 'PRAN',
  ESI_NO: 'ESI number',
  PENSION_NO: 'Pension number',
  CERT_REG_NO: 'Certificate registration number',
  RATION_CARD_NO: 'Ration / family card number',
};

const hasDigit = (v: string) => /\d/.test(v);
const compact = (v: string) => v.replace(/[\s-]/g, '');

/** Every capture group 1 of `re` in `text`, trimmed; only the ones carrying a digit. */
function labelled(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const v = (m[1] ?? '').trim();
    if (v && hasDigit(v)) out.push(v);
  }
  return out;
}

/**
 * Policy / certificate numbers, joined across a line wrap.
 *
 * A schedule's table cell wraps a long number: "0G-26-1021-1825-" on one line, "00036132" on
 * the next. Read alone, the first half is the insurer's product prefix — identical on every
 * Bajaj policy — and two unrelated claims "shared a policy number" (MZBB2814LSN010383 and
 * MZBFB812LSN575194). A value ending in a separator is continued from the next line; one that
 * still ends in a separator is dropped rather than compared as a fragment.
 */
function policyNumbers(text: string): string[] {
  const out: string[] = [];
  // Dots are allowed inside: OCR reads a hyphen as a full stop often enough ("0G-26-1021-1825.
  // 00036132" on the same Bajaj schedule), and stopping there leaves the shared prefix again.
  // "certifica\w*": the client's own pair of forged policies prints "Policy / Certificate No",
  // and one scan of it OCRs as "Certificato" — the label must survive that, or the one
  // duplicate the sheet names outright goes unseen.
  for (const m of text.matchAll(/(?:policy|certifica[a-z]*)\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/.]{5,30})/gi)) {
    let v = m[1].replace(/\.+$/, ''); // a sentence's full stop is not part of the number
    if (/[\-\/]$/.test(v)) {
      const next = /^\s*([A-Z0-9][A-Z0-9\-\/]*)/i.exec(text.slice((m.index ?? 0) + m[0].length));
      if (next) v += next[1];
    }
    if (hasDigit(v) && !/[\-\/]$/.test(v)) out.push(v);
  }
  return out;
}

// A certificate, as opposed to any page that mentions GST (every dealer invoice does).
const GST_CERT_RE = /gst\s*reg-?\s*0?6|registration\s+certificate|legal\s+name|type\s+of\s+registrat/i;
const GSTIN_SHAPE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;
const CIVIL_CERT_RE =
  /(?:birth|death|marriage)\s+(?:registration\s+)?certificate|certificate\s+of\s+(?:birth|death|marriage)/i;

export function extractIdentifiers(text: string): { field: IdentifierField; value: string }[] {
  const out: { field: IdentifierField; value: string }[] = [];
  const add = (field: IdentifierField, values: string[]) => {
    for (const value of new Set(values)) out.push({ field, value });
  };

  add('POLICY_NO', policyNumbers(text));

  // Fourth letter P = an individual. Companies (C), firms (F), HUFs (H) and the rest are the
  // dealer's or insurer's own PAN, printed on every claim they touch.
  add('PAN', [...text.matchAll(/\b([A-Z]{3}P[A-Z]\d{4}[A-Z])\b/g)].map((m) => m[1]));

  add('AADHAAR', [
    ...(GOVT_TYPE_MARKERS.AADHAR(text) ? aadhaarNumbers(text) : []),
    ...labelled(text, /aad?haa?r\s*(?:card\s*)?(?:no|number)\.?\s*[:\-]?\s*(\d{4}\s?\d{4}\s?\d{4})\b/gi).map(compact),
  ]);

  const dlPage = GOVT_TYPE_MARKERS.DL(text);
  add(
    'DL_NO',
    [
      ...(dlPage ? [...text.matchAll(/\b([A-Z]{2}[\s-]?\d{2}[\s-]?\d{4}[\s-]?\d{7})\b/g)].map((m) => m[1]) : []),
      ...labelled(text, /(?:dl|licen[cs]e)\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z]{2}[\s-]?\d{2}[\s-]?\d{4}[\s-]?\d{7})\b/gi),
    ].map(compact)
  );

  add('PASSPORT_NO', [
    ...(GOVT_TYPE_MARKERS.PASSPORT(text) ? [...text.matchAll(/\b([A-Z][0-9]{7})\b/g)].map((m) => m[1]) : []),
    ...labelled(text, /passport\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z][0-9]{7})\b/gi),
  ]);

  add('VOTER_ID', [
    ...(GOVT_TYPE_MARKERS.VOTER_ID(text) ? [...text.matchAll(/\b([A-Z]{3}[0-9]{7})\b/g)].map((m) => m[1]) : []),
    ...labelled(text, /epic\s*(?:no|number)?\.?\s*[:\-]?\s*([A-Z]{3}[0-9]{7})\b/gi),
  ]);

  add('GSTIN', [
    ...(GST_CERT_RE.test(text) ? [...text.matchAll(GSTIN_SHAPE)].map((m) => m[1]) : []),
    ...labelled(text, /customer\s*gst(?:in)?\s*(?:no|number)?\.?\s*[:\-]?\s*(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/gi),
  ]);

  add('UDYAM_NO', [...text.matchAll(/\b(UDYAM-[A-Z]{2}-\d{2}-\d{7})\b/gi)].map((m) => m[1].toUpperCase()));

  add('FSSAI_NO', labelled(text, /fssai[^\n]{0,40}?\b(\d{14})\b/gi));

  add('PF_NO', labelled(text, /\bP\.?\s?F\.?\s*(?:A\/?c\.?\s*)?(?:No|Number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{5,30})/gi));

  add('UAN', labelled(text, /\bUAN\s*(?:No|Number)?\.?\s*[:\-]?\s*(\d{12})\b/gi));

  add('GPF_NO', labelled(text, /\bGPF\s*(?:A\/?c\.?\s*)?(?:No|Number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{3,25})/gi));

  // NPS PRAN is 12 digits.
  add('PRAN', labelled(text, /\bPRAN\s*(?:No|Number)?\.?\s*[:\-]?\s*(\d{12})\b/gi));

  // ESI / ESIC insurance number. Must start with a digit: a payslip's empty "ESIC No" field is
  // followed by the next label ("PAN : ...") and must not capture it.
  add('ESI_NO', labelled(text, /\bESIC?\s*(?:IP\s*)?(?:No|Number)\.?\s*[:\-]?\s*(\d[\d\/\-]{8,20})/gi));

  // Pension / PPO (Pension Payment Order) number.
  add(
    'PENSION_NO',
    labelled(text, /\b(?:pension(?:\s+payment\s+order)?|PPO)\s*(?:No|Number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{5,25})/gi)
  );

  // "Registration No" alone is also a vehicle's — only a civil certificate's counts here.
  if (CIVIL_CERT_RE.test(text)) {
    add('CERT_REG_NO', labelled(text, /registration\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,30})/gi));
  }

  add('RATION_CARD_NO', labelled(text, /(?:ration|family)\s*card\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{5,25})/gi));

  return out;
}
