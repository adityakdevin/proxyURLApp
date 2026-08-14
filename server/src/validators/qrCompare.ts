/**
 * Compare a QR code's payload against the fields read off the document it is printed on.
 *
 * A policy QR carries the insurer's own copy of the policy number, insured name, chassis
 * and model. The printed page carries the same values in ink. When the two disagree, the
 * page has been altered after issue — which is exactly what a reviewer is looking for.
 *
 * Pure (no I/O, no prisma) so it unit-tests with string fixtures, same discipline as
 * redFlagLogic and docFields.
 *
 * Comparable payloads: plaintext policy QRs, the older Aadhaar XML QR, and — since
 * qrValidator now expands it before we see it — the Aadhaar Secure QR, which arrives here
 * already rendered as "Label:Value|…". The enhanced PAN QR is signed and bit-packed with no
 * public specification, so it stays unreadable and qrValidator shows guidance instead.
 */
import { DocField } from './docFields.js';
import { isUnreadableQrPayload } from './aadhaarSecureQr.js';
import { nameMatches } from './crossDocLogic.js';
import { editDistanceCapped } from './logic.js';

export type QrVerdict = 'MATCH' | 'MISMATCH';

export interface QrFieldComparison {
  /** The pane row this QR value was checked against, e.g. "Chassis No". */
  label: string;
  /** What the QR says. */
  qrValue: string;
  /** What was read off the page. */
  documentValue: string;
  verdict: QrVerdict;
}

/**
 * Which pane row each QR key answers to. A QR key can map to several because the same
 * key means different things per document type ("Name" is the insured on a policy and the
 * holder on an Aadhaar) — the first label the document actually has wins.
 */
const QR_KEY_TO_LABELS: Record<string, string[]> = {
  name: ["Insured's Name", 'Holder Name', 'Customer Name'],
  polno: ['Policy No'],
  policyno: ['Policy No'],
  chassisno: ['Chassis No'],
  chassis: ['Chassis No'],
  engineno: ['Engine No'],
  engine: ['Engine No'],
  model: ['Model'],
  uid: ['Aadhaar Number'],
  pan: ['PAN Number'],
  panno: ['PAN Number'],
  gender: ['Gender'],
  dob: ['Date of Birth'],
  // GST e-invoice QR. Measured from the payloads already stored in validation_results:
  // comma-delimited "Key :Value" carrying suppliergstno, invoiceno, invoicedate, totalamt,
  // cgstamt, sgstamt, igstamt, cessamt, supplierupiid, payeebankaccountno, ifsccode.
  // parseQrPayload reads them fine — none had a row here, so compareQrToFields returned
  // nothing and the reviewer saw a decoded code with no verdict against it.
  //
  // Only the invoice number is mapped. The others have no home yet:
  //  - invoicedate  the pane's 'Invoice Date' is a raw regex capture in whatever format the
  //                 invoice prints, while the QR emits DD/MM/YYYY. identifierMatches folds
  //                 punctuation but not date formats, so mapping it would raise a MISMATCH —
  //                 and a MISMATCH FAILS the check — on correct invoices. Needs date
  //                 normalization on both sides first.
  //  - suppliergstno / the amount and bank fields have no docFields label to compare against.
  //                 Adding one means writing a GSTIN extractor, which wants a real GST
  //                 invoice sample to get right.
  invoiceno: ['Invoice No'],
};

const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Characters OCR routinely confuses on a photographed document. Folding them before
 * comparing is what stops a legitimate claim being flagged: this claim's chassis reads
 * MZBB2SIALSNO10383 off the page and MZBB2814LSN010383 out of the QR — same number, four
 * misread glyphs.
 */
const CONFUSABLE: Record<string, string> = {
  O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8',
};

const fold = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[ODQILZASGTB]/g, (c) => CONFUSABLE[c]);

/**
 * Identifiers agree when they agree after glyph folding, within a length-scaled slack.
 *
 * DELIBERATE LIMIT: the document side of this comparison is OCR of a photograph, so
 * character-perfect agreement is not achievable — demanding it would flag every honest
 * claim. The cost is that tampering of one or two characters in a long identifier reads as
 * a match. Catching that needs a cleaner document image, not a tighter threshold here.
 */
function identifierMatches(a: string, b: string): boolean {
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb) return true; // nothing to compare → not a mismatch
  if (fa === fb) return true;
  const slack = Math.max(1, Math.floor(Math.max(fa.length, fb.length) / 8));
  return editDistanceCapped(fa, fb, slack) <= slack;
}

const NAME_LABELS = new Set(["Insured's Name", 'Holder Name', 'Customer Name', "Father's Name"]);

/**
 * Parse a QR payload into key → value.
 *
 * Three shapes in the wild: the pipe-delimited "Label:Value" a policy QR carries, the XML of
 * an older Aadhaar QR, and the NEWLINE-delimited block a GST certificate or e-invoice uses.
 * Returns an empty map for anything else (including the `binary:` blob, or a still-unexpanded
 * digit run), so the caller compares nothing rather than comparing noise.
 *
 * NOT handled on purpose: a single-line run of "Label: Value Label: Value" with no delimiter
 * at all, as the scrappage Certificate of Deposit uses ("CD No.: … First Owner Name: …").
 * Splitting that needs guessing where one value ends and the next label begins, and none of
 * its fields (CD number, owner names, validity) has a docFields row to be compared against —
 * so a parser for it would buy nothing. Such a QR is still decoded, counted, and now
 * outlined on the page, which is what the reviewer was missing.
 */
export function parseQrPayload(value: string): Map<string, string> {
  const out = new Map<string, string>();
  // Shared predicate, not a local prefix test: a payload we could not expand is a long
  // DIGIT string as often as a base64 blob, and splitting it on commas below would produce
  // junk "fields" rather than an honest "nothing to compare".
  if (!value || isUnreadableQrPayload(value)) return out;

  if (value.trimStart().startsWith('<')) {
    for (const m of value.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) {
      const v = m[2].trim();
      if (v) out.set(normalizeKey(m[1]), v);
    }
    return out;
  }

  // Delimiter, most-specific first. A NEWLINE wins over everything: the GST registration
  // certificate (Form GST REG-06) puts one field per line AND carries an address full of
  // commas, so splitting on ',' shredded it — measured on production, a real certificate
  // yielded the keys ["legalname", "360005typeofregistration"] and lost GSTIN and PAN
  // entirely. Pipe stays ahead of comma for the policy QRs.
  const sep = /[\r\n]/.test(value) ? /[\r\n]+/ : value.includes('|') ? '|' : ',';
  for (const part of value.split(sep as never)) {
    // Split at the first colon that is not a time colon ("1:00PM" — digits both sides).
    const m = /(?<!\d):|:(?!\d)/.exec(part);
    if (!m || m.index <= 0) continue;
    const key = normalizeKey(part.slice(0, m.index));
    const v = part.slice(m.index + 1).trim();
    // A URL's value contains colons of its own; keep the first-colon split, it is the key
    // boundary either way. Empty values carry nothing to compare.
    if (key && v && !out.has(key)) out.set(key, v);
  }
  return out;
}

/**
 * Compare one QR payload against one document's field pane.
 *
 * Only fields present on BOTH sides are compared — a QR key the pane has no row for (a
 * policy QR's registration number, its URL) is not evidence of anything, and neither is a
 * pane row the QR does not carry.
 */
export function compareQrToFields(qrValue: string, fields: DocField[]): QrFieldComparison[] {
  const payload = parseQrPayload(qrValue);
  if (payload.size === 0) return [];
  const byLabel = new Map(fields.map((f) => [f.label, f.value]));
  const out: QrFieldComparison[] = [];
  const seen = new Set<string>();

  for (const [key, qrRaw] of payload) {
    for (const label of QR_KEY_TO_LABELS[key] ?? []) {
      const documentValue = byLabel.get(label);
      if (!documentValue || seen.has(label)) continue;
      seen.add(label);
      const ok = NAME_LABELS.has(label)
        ? nameMatches(qrRaw, documentValue)
        : identifierMatches(qrRaw, documentValue);
      out.push({
        label,
        qrValue: qrRaw.replace(/\s+/g, ' ').trim(),
        documentValue,
        verdict: ok ? 'MATCH' : 'MISMATCH',
      });
      break; // this QR key is answered by the first label the document actually has
    }
  }
  return out;
}
