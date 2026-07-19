/**
 * Per-page document segmentation + classification. Consumes ONLY already-populated
 * context data (`ctx.pageTexts` → `ctx.wordBoxes` → `ctx.shared`), never re-extracts
 * (spec decision 2), so it runs under jest with plain fixtures. Shared by FULL
 * (provenance) and REDFLAG (which rules run where) — the single classification path
 * (spec decision 5).
 *
 *   doc ──> pagesFor ──> [{page, text}, ...] ──> classifyPage each ──> DocInstance[]
 *
 * page is the real 1-based page number wherever we have page boundaries, or null for a
 * page-less unit (pdf-parse fallback / plain image). Page is ALWAYS retained here
 * (spec decision 10) — collapsing to filename-only is a UI concern, never data loss.
 */
import { ValidatorContext, ValidatorDoc } from './types.js';
import { GOVT_TYPE_MARKERS } from './logic.js';

export interface DocInstance {
  documentId: string;
  fileName: string;
  page: number | null;
  govtCode: string | null;
  text: string;
}

/** Per-page text for a document, from the richest source available. */
export function pagesFor(doc: ValidatorDoc, ctx: ValidatorContext): { page: number | null; text: string }[] {
  const pageTexts = ctx.pageTexts.get(doc.id);
  if (pageTexts && pageTexts.length > 0) {
    return pageTexts.map((text, i) => ({ page: i + 1, text }));
  }
  // Fallback: rebuild per-page text from word boxes (data, not extraction).
  const words = ctx.wordBoxes.get(doc.id);
  if (words && words.length > 0) {
    const byPage = new Map<number, string[]>();
    for (const w of words) {
      const arr = byPage.get(w.page) ?? [];
      arr.push(w.text);
      byPage.set(w.page, arr);
    }
    return [...byPage.keys()].sort((a, b) => a - b).map((page) => ({ page, text: (byPage.get(page) ?? []).join(' ') }));
  }
  // Last resort: whole-doc text with no page boundary.
  const whole = ctx.shared.get(doc.id);
  return whole ? [{ page: null, text: whole }] : [];
}

/** Best document-type guess for one page's text, using the content markers. null when
 *  no marker fires (an unrecognised page — e.g. a blank back side). */
export function classifyPage(text: string): string | null {
  for (const [code, marker] of Object.entries(GOVT_TYPE_MARKERS)) {
    if (marker(text)) return code;
  }
  return null;
}

/** One DocInstance per (document, page). */
export function segment(ctx: ValidatorContext): DocInstance[] {
  const out: DocInstance[] = [];
  for (const doc of ctx.documents) {
    for (const { page, text } of pagesFor(doc, ctx)) {
      out.push({ documentId: doc.id, fileName: doc.fileName, page, govtCode: classifyPage(text), text });
    }
  }
  return out;
}
