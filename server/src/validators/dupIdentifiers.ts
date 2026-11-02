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
 *  - Civil-certificate registration numbers: beside their label, or (for the two-column and
 *    bilingual layouts) on the line below it, or above a "Date of ..." label row.
 *  - Ration card numbers: beside their label, or (label lost to OCR) a long number near the
 *    title that does not follow some other label.
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
  | 'KEY_NO'
  | 'RATION_CARD_NO';

export const IDENTIFIER_FIELDS: IdentifierField[] = [
  'POLICY_NO', 'PAN', 'AADHAAR', 'DL_NO', 'PASSPORT_NO', 'VOTER_ID', 'GSTIN', 'UDYAM_NO',
  'FSSAI_NO', 'PF_NO', 'UAN', 'GPF_NO', 'PRAN', 'ESI_NO', 'PENSION_NO', 'CERT_REG_NO', 'KEY_NO', 'RATION_CARD_NO',
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
  KEY_NO: 'Certificate key number',
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
 * Bajaj policy — and two unrelated claims "shared a policy number" (claims …010383 and
 * …575194). A value ending in a separator is continued from the next line; one that
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
// The Act phrase comes first so it wins at its own position: it names two kinds.
const CIVIL_CERT_RE =
  /registration\s+of\s+births?\s*(?:and|&)\s*deaths?|(?:birth|death|marriage)\s+(?:registration\s+)?certificate|certificate\s+of\s+(?:registration\s+of\s+)?(?:birth|death|marriage)|(?:record|registration)\s+of\s+(?:the\s+)?(?:birth|death|marriage)|marriage\s+regist(?:rar|ration\s+officer)/i;
const REG_LABEL = /\bregi[a-z]{2,6}ion\s*(?:no|number)(?![a-z])\.?/gi; // "Registation", "Regiswation"
const SAME_LINE = /^\s*(?:\/(?![^:\n]*\bdate\b)\s*[^\d\s:][^:\n]{0,30}:)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{0,30})/i;
// Only real month names in the middle: an office code ("45/KMC/2020", "7-GHMC-19") is a number.
const DATE_SHAPE =
  /^(?:\d{1,2}[\/.\-](?:\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6})[\/.\-]\d{2,4}|\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})$/i;
// "N of 2024" / "N 2024": the year is part of the number, so marriages of different years differ.
const YEAR_AFTER = /^\s+(?:of\s+)?((?:19|20)\d{2})\b/i;
// Insurers, trusts, councils, dealers and the like print their own registration number on every
// document they issue; it is theirs, not the customer's. Hospital and clinic are left out on
// purpose: a birth certificate's "Place of Birth: City Hospital  Registration No: ..." row is real.
const OWNER_BEFORE_LABEL =
  /\b(?:irdai?|insurance|trust|society|samaj|council|medical|doctor|notary|advocate|school|college|vehicle|dealer|trade|shop|firm|company|patient)\b[^\n:]{0,30}$/i;
const REG_DATE = /date\s+of\s+(?:registration|issu\w*)|registration\s+date|issue\s+date/i;
const SHORT_MIN = 2;

/** undefined: not a civil certificate. null: one, but it names no single kind (the Act names two). */
function civilCertKind(text: string): 'birth' | 'death' | 'marriage' | null | undefined {
  const m = CIVIL_CERT_RE.exec(text);
  if (!m) return undefined;
  const kinds = (['birth', 'death', 'marriage'] as const).filter((k) => m[0].toLowerCase().includes(k));
  return kinds.length === 1 ? kinds[0] : null;
}

const normLen = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').length;
const acceptable = (v: string) => hasDigit(v) && !DATE_SHAPE.test(v);
const joinSlash = (s: string) => s.replace(/(\d)\s*\/\s*(?=\d)/g, '$1/');
const tokens = (line: string) =>
  joinSlash(line).split(/\s+/).map((t) => t.replace(/[^A-Z0-9\-\/]/gi, '')).filter(Boolean);
// A value from a neighbouring line is a guess about layout, so it must be long enough not to be
// a serial number, ward number or page number from some other column.
const neighbour = (v: string | undefined) => (v && acceptable(v) && normLen(v) >= 4 ? v : undefined);

// Bilingual and two-column certificates put the label and its value on different lines, so the
// value is looked for on the label's line first, then below it, then above it. Only the label's
// own line may yield a 2-3 character number (see extractIdentifiers). The line above is read
// only for a two-column label row ("Registration No   Date of Registration <"), never for prose
// that merely mentions the label, or the office phone or PIN above it would become the number.
function certRegNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REG_LABEL)) {
    const at = m.index ?? 0;
    const labelEnd = at + m[0].length; // a label OCR wrapped over two lines ends on its second line
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const end = text.indexOf('\n', labelEnd);
    const lineEnd = end < 0 ? text.length : end;
    const rest = joinSlash(text.slice(labelEnd, lineEnd));

    if (OWNER_BEFORE_LABEL.test(text.slice(Math.max(0, at - 40), at))) continue;

    const sameMatch = SAME_LINE.exec(rest);
    const same = sameMatch?.[1];
    const after = sameMatch ? rest.slice(sameMatch[0].length) : '';
    // A form's item number ("11. Registration No.: 12. Date of ...") is not a registration number.
    const itemNumber = !!same && normLen(same) <= 3 && /^[.)]/.test(after);
    if (same && acceptable(same) && !itemNumber) {
      const year = /^\d{1,4}$/.test(same) ? YEAR_AFTER.exec(after)?.[1] : undefined;
      out.push(year ? `${same}/${year}` : same);
      continue;
    }
    const colon = rest.indexOf(':');
    const slot = colon < 0 ? rest : rest.slice(colon + 1);
    // An empty value slot, or a second label after the first colon, means the value is below.
    if (!rest.trim() || (colon >= 0 && (!slot.trim() || slot.includes(':')))) {
      const next = text.slice(lineEnd).split('\n').find((l) => l.trim());
      const t = next ? tokens(next) : [];
      const v = neighbour(t[0] && DATE_SHAPE.test(t[0]) ? t[1] : t[0]);
      if (v) out.push(v);
    } else if (colon < 0 && lineStart > 0 && /\bdate\b/i.test(rest)) {
      const prev = text.slice(0, lineStart - 1).split('\n').pop() ?? '';
      const pc = prev.indexOf(':');
      const v = pc < 0 ? undefined : neighbour(tokens(prev.slice(pc + 1)).find(acceptable));
      if (v) out.push(v);
    }
  }
  return out;
}

// Mobile, landline with its trunk 0, toll-free, and mobile with the country code:
// never a card number.
const PHONE_SHAPE = /^(?:[6-9]\d{9}|0\d+|(?:1800|1860)\d{6,7}|91[6-9]\d{9})$/;
const OTHER_NUMBER_LABEL = /\b(?:ph(?:one)?|tel(?:ephone)?|mob(?:ile)?|help\w*|toll|fps|shop|lpg|consumer|aadhaa?r|uid)\b/i;

const OTHER_LABEL_END = /\b(?:no|number|code|id|cin|a\/?c|account)\.?\s*[:\-]?\s*$/i;
const CARD_LABEL_END = /\bcard\s*(?:no|number)\.?\s*[:\-]?\s*$/i;
const BARE_NO_LINE = /^\s*(?:no|number)\.?\s*[:\-]?\s*$/i;

/**
 * Ration / family card numbers. The labelled form is the common one. Kerala's bilingual card
 * prints the number beside "(Card Number)" instead, which OCR garbles ("Card Mumier"), and
 * some scans lose the label altogether, leaving only a long number under the title.
 */
function rationCardNumbers(text: string): string[] {
  const out = labelled(text, /(?:ration|family)\s*card\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{5,25})/gi);
  if (!/\bration\s*card\b|\bfamily\s*card\b|rationing\s+inspector/i.test(text)) return out;
  // "(Card Type)" is the label above it, not the number's.
  out.push(
    ...labelled(text, /\(\s*card\s+(?!type)[a-z]{4,7}\s*\)\s*[:\-]?\s*(\d{8,15})\b/gi).filter((v) => !PHONE_SHAPE.test(v))
  );
  if (out.length) return out;

  // Last resort, no label: look only near the title, where the card number is printed, because
  // further down the page the same shapes are member ids and phone numbers. The title must be a
  // line of its own, at most 30 characters on each side: a claim form's "ID proof: [ ] Aadhaar
  // [ ] PAN [ ] Ration Card" checkbox line is longer, and a number pre-printed on every copy of
  // the form would become a shared duplicate. Digits are allowed on the line because OCR noise
  // on real titles carries them (e.g. "99%"). A number inside a longer digit run (Aadhaar 4-4-4,
  // dates) is not a standalone card number. A number that follows another label (dealer code,
  // depot "ARD No", bank account, CIN) belongs to that label; only a card-number label, or a bare
  // "No:" opening the line under the title, may precede the card number.
  const title = /^[^\n]{0,30}\bration\s*card\b[^\n]{0,30}$/im.exec(text);
  if (!title) return out;
  for (const line of text.slice(title.index).split('\n').slice(0, 6)) {
    // A line labelled as another number (phone, FPS, LPG, Aadhaar) holds that number, not ours.
    if (OTHER_NUMBER_LABEL.test(line)) continue;
    for (const m of line.matchAll(/(?<!\d[ \-]?)(\d{10,15})(?![ \-]?\d)/g)) {
      const before = line.slice(0, m.index);
      if (OTHER_LABEL_END.test(before) && !CARD_LABEL_END.test(before) && !BARE_NO_LINE.test(before)) continue;
      if (!PHONE_SHAPE.test(m[1])) return [m[1]];
    }
  }
  return out;
}

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

  // Payslips print the UAN grouped ("1012 3456 7890") as often as not; the plain \d{12}
  // missed every one of those (client QA 2026-10: 5 of 12 duplicate UANs found).
  add('UAN', labelled(text, /\bUAN\s*(?:No|Number)?\.?\s*[:\-]?\s*(\d{4}[ \t-]?\d{4}[ \t-]?\d{4})(?![ \t-]?\d)/gi).map((v) => v.replace(/[ \t-]/g, '')));

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
  const certKind = civilCertKind(text);
  if (certKind !== undefined) {
    const values: string[] = [];
    for (const n of new Set(certRegNumbers(text))) {
      const len = normLen(n);
      if (len >= 4) values.push(n);
      // A 2-3 character number repeats across unrelated registers, so it carries its kind and
      // only counts when the page is clearly one certificate with a registration or issue date.
      else if (len >= SHORT_MIN && certKind && REG_DATE.test(text)) values.push(`${n} (${certKind} certificate)`);
    }
    add('CERT_REG_NO', values);
    // Kerala certificates print "The Key Number is unique to each event", so the key number
    // identifies one birth, death or marriage. "Key No" alone is a vehicle key's, a lock's or
    // an index's, so it is read only on a civil certificate.
    add('KEY_NO', labelled(text, /\bkey\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z]\d{10,24})\b/gi));
  }

  add('RATION_CARD_NO', rationCardNumbers(text));

  return out;
}
