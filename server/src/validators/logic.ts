import { ValidatorOutcome } from './types.js';

export const SPELL_MAX_RATIO = 0.2;

export function metaOutcome(docsWithText: number, totalDocs: number): ValidatorOutcome {
  if (totalDocs === 0) return { status: 'PASSED', summary: 'No documents to extract.' };
  if (docsWithText === 0)
    return { status: 'FAILED', summary: `No text extracted from ${totalDocs} document(s).` };
  return {
    status: 'PASSED',
    summary: `Extracted text from ${docsWithText} of ${totalDocs} documents.`,
  };
}

export function spellOutcome(
  misspelled: number,
  total: number,
  sample: string[]
): ValidatorOutcome {
  if (total === 0) return { status: 'PASSED', summary: 'No text to spell-check.' };
  const ratio = misspelled / total;
  const pct = Math.round(ratio * 100);
  const status = ratio <= SPELL_MAX_RATIO ? 'PASSED' : 'FAILED';
  return {
    status,
    summary: `${pct}% suspect (${misspelled}/${total} words).`,
    details: { suspect: sample },
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

export function tokenizeWords(s: string): string[] {
  return s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
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
