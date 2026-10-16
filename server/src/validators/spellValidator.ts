import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Validator, ValidatorContext, FindingInput, WordBox } from './types.js';
import { getSpell, isRealWord as dictHasWord, type Spell } from './dictionary.js';
import {
  spellCandidates,
  findTermMisspellings,
  SPELL_MIN_TERM_HITS,
  EXPECTED_TERMS,
  MIN_TERM_LEN,
  ocrIndistinguishable,
  isTruncation,
  editDistanceCapped,
  isProperNounTerm,
} from './logic.js';
import { rasterizePdf, largestImageWidthPerPage, rasterScale, MAX_PDF_PAGES } from '../lib/pdfExtractor.js';
import { MIN_OCR_PAGE_LONG_SIDE } from '../lib/ocr.js';
import { extractNames, extractRelationNames } from './crossDocLogic.js';
import { ADDRESS_WORDS, INDIAN_PLACE_WORDS } from './indianPlaces.js';

const PLACES: ReadonlySet<string> = new Set(INDIAN_PLACE_WORDS);
/** Places and common address words: real words, so never flagged themselves. */
const KNOWN_LOCAL_WORDS: ReadonlySet<string> = new Set([...INDIAN_PLACE_WORDS, ...ADDRESS_WORDS]);

/** The expected-vocabulary the near-miss matcher checks against. Prefer the
 *  admin-managed `SpellTerm` table so the list can be tuned without a deploy;
 *  fall back to the built-in EXPECTED_TERMS when it's empty or unreadable so the
 *  check never silently degrades to "no terms → nothing ever flagged". */
async function loadTermsAndGlossary(
  prisma: PrismaClient
): Promise<{ terms: string[]; glossary: Set<string> }> {
  try {
    const rows = await prisma.spellTerm.findMany({
      where: { status: 'ACTIVE' },
      select: { term: true, expansion: true },
    });
    // A glossary entry ("pvt" → "Private") is a known abbreviation, not a near-miss target:
    // it must never be flagged, and must never be something OTHER words get corrected TO.
    const glossary = new Set(
      rows.filter((r) => r.expansion).map((r) => r.term.toLowerCase().trim())
    );
    // Rows that can never match are dropped here as a backstop; SpellTermService rejects
    // them at entry, so this only catches terms stored before that validation existed.
    const terms = rows
      .filter((r) => !r.expansion)
      .map((r) => r.term.toLowerCase().trim())
      .filter((t) => t.length >= MIN_TERM_LEN && !/\s/.test(t));
    return { terms: terms.length > 0 ? terms : EXPECTED_TERMS, glossary };
  } catch {
    return { terms: EXPECTED_TERMS, glossary: new Set() };
  }
}

/** Index a document's word boxes by their normalized text, as consumable queues,
 *  so repeated occurrences of a word map to distinct boxes in reading order.
 *  A box is indexed under EVERY letter run it contains, mirroring how spellCandidates
 *  tokenizes the text: collapsing "Quartarly Retantion" (one merged OCR/pdfjs box) or
 *  "30Dayes" to a single key meant the lookup missed and the finding lost its highlight. */
function indexBoxes(boxes: WordBox[]): Map<string, WordBox[]> {
  const idx = new Map<string, WordBox[]>();
  for (const b of boxes) {
    for (const key of b.text.toLowerCase().match(/[a-z]+/g) ?? []) {
      const arr = idx.get(key);
      if (arr) arr.push(b);
      else idx.set(key, [b]);
    }
  }
  return idx;
}

/**
 * A document whose words are mostly not words was not read, and a spell check over it proves
 * nothing. Measured on the 33 stored documents: the two salary slips OCR returned as noise
 * scored 0.24 and 0.25; every readable document scored 0.47 or more (one mock-up 0.37).
 * The word floor keeps a short, name-heavy ID card (8-15 words, few of them dictionary words)
 * from being called unreadable.
 * ponytail: whole-document ratio, so one unreadable page inside a readable PDF is not caught;
 * score per page (ctx.pageTexts) if that shows up.
 */
export const UNREADABLE_REAL_WORD_RATIO = 0.35;
const UNREADABLE_MIN_WORDS = 12;

/** Tesseract word confidence (0-100) below which a hit is treated as doubtful rather
 *  than as a misspelling — unless a second reading confirms it. A word from a PDF text
 *  layer has no confidence. */
const LOW_OCR_CONFIDENCE = 70;
/** At or above this a softened near-miss is reported as a misspelling: the scan was clear.
 *  Also what a second reading must reach to confirm one. */
const CONFIDENT_OCR = 85;
/** Below this the OCR word was a guess (it rated itself more likely wrong than right), and a
 *  second reading by the same engine is not asked to confirm it. */
const GUESS_OCR_CONFIDENCE = 50;

/** Close enough to a form word that a trusted reading of it is a misspelling: a form word
 *  (not a place), same first letter, not a clipped word, and one letter off — two only on a
 *  long word ("Degination"). Across all 570 claims a looser gate failed real words and names:
 *  "enquire" (require) on 107 claims, "licence" (science), "Sahoo" (school), "Kalan"
 *  (Kalyan), "Shree" (three).
 *  ponytail: length as the two-edit gate; a per-term allow list if it lets noise in. */
function nearFormWord(token: string, term: string): boolean {
  return (
    !PLACES.has(term) &&
    token[0] === term[0] &&
    editDistanceCapped(token, term, 2) <= (term.length >= 9 ? 2 : 1) &&
    !isTruncation(token, term)
  );
}

/** The scale META's OCR renders a PDF page at (ocr.ts; 4 on a poor page's retry). Tesseract is
 *  deterministic, so a second reading at the same scale would only repeat the first. */
const OCR_RENDER_SCALE = 2;
const REREAD_SCALE = 3;

/**
 * How many pixels META's first look gave a page this long (points), on its long side. Scale 2,
 * but never under ocr.ts's MIN_OCR_PAGE_LONG_SIDE: a 465pt voter card was read at 1400 px, not
 * 930, so a scale-3 re-read (1395 px) shows Tesseract nothing it has not seen and could only
 * "confirm" its own misread (ship review 2026-10-16).
 */
export function metaFirstLook(longSidePt: number): number {
  return longSidePt * rasterScale(longSidePt, longSidePt, OCR_RENDER_SCALE, MIN_OCR_PAGE_LONG_SIDE);
}
/** Pages read a second time per document. Mirrors META's cap on its own high-res retries;
 *  a near-miss on a page past it simply stays doubtful, as it was before. */
const MAX_REREAD_PAGES = 8;

/** Words printed on the line people sign and stamp. A pen stroke through a letter reads the
 *  same to every engine: a signature crossing the "n" of "Signature" was read "Sighature"
 *  by the scanning app and again by ours at 93. A second reading cannot confirm these.
 *  ponytail: add 'authorised' if a stamped "Authorised" is ever confirmed the same way. */
const SIGNING_LINE_WORDS: ReadonlySet<string> = new Set(['signature', 'signatory']);

/**
 * Our OCR's second reading of some pages of a PDF, rendered at REREAD_SCALE. Empty for
 * anything else, or when the reading fails: a missing second reading changes nothing.
 * ponytail: PDFs only; an uploaded photo keeps its single reading. Resize and re-read it
 * here if photos turn out to carry the hidden misspellings too.
 */
async function rereadPages(ctx: ValidatorContext, documentId: string, pages: number[]): Promise<WordBox[]> {
  const doc = ctx.documents.find((d) => d.id === documentId);
  const out: WordBox[] = [];
  if (!doc || doc.mimeType !== 'application/pdf' || !ctx.ocr.extractImage) return out;
  const ocrRead = new Set(
    (ctx.wordBoxes.get(documentId) ?? []).filter((w) => w.conf !== undefined).map((w) => w.page)
  );
  for (const page of [...new Set(pages)].slice(0, MAX_REREAD_PAGES)) {
    // extractImage reads a file, and nothing else in OcrPort renders at a chosen scale.
    const file = path.join(os.tmpdir(), `spell-reread-${randomUUID()}.png`);
    try {
      const [render] = await rasterizePdf(doc.readablePath, MAX_PDF_PAGES, REREAD_SCALE, [page]);
      if (!render) continue;
      // A page our OCR has already read is worth reading again only when the larger render
      // shows it something new: a scan with more pixels than META's render had. Below that
      // it is the same blur, enlarged, and both readings make the same mistake — bold
      // "Policy" and "Employee" on 91 ppi scans were read "palicy" and "employes" twice,
      // while every real misspelling it confirmed on a page it had read sat on a 154-300
      // ppi scan. A page with no image is vector print, and sharper at any scale. A page
      // only the scanning app's text layer read is a first reading for our engine either way.
      // ponytail: largest image vs the whole page, long side to long side, so a photo filling
      // part of a page counts as coarser than it is (it stays doubtful). Measure the image's
      // placed size from the operator list's transform if that hides real misspellings.
      if (ocrRead.has(page)) {
        const reread = Math.max(render.width, render.height);
        const firstRender = metaFirstLook(reread / REREAD_SCALE);
        if (reread <= firstRender) continue;
        const img = (await largestImageWidthPerPage(doc.readablePath, [page])).get(page);
        if (img && Math.max(img.width, img.height) <= firstRender) continue;
      }
      await fs.writeFile(file, render.png);
      out.push(...(await ctx.ocr.extractImage(file)).words.map((w) => ({ ...w, page })));
    } catch {
      // no second reading for this page
    } finally {
      // A locked temp file (antivirus on the Windows box) must not throw out of finally and
      // fail the whole SPELL check, losing every finding with it.
      await fs.rm(file, { force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
  return out;
}

/** Swappable in tests: rendering a PDF page is out of Jest's reach (ESM dynamic import). */
export const secondReading = { pages: rereadPages };

/** Every word used in a person's name anywhere in the claim, lowercased.
 *
 *  A hit on one of these is reported as DOUBTFUL rather than suppressed. The 2026-09-03
 *  sheet asked for names not to be highlighted at all ("Name or Surname spelling not to be
 *  highlighted unless different in intra document") and they were dropped outright, but the
 *  follow-up asked for a misspelt name to be visible: ignoring a name "regardless of
 *  spelling mistakes" hid real errors.
 *
 *  Doubtful is the honest tier for it. A surname is in no dictionary, so the matcher can
 *  only say it RESEMBLES a form word — "Dass" reported against "days", "Sahoo" against
 *  "school" — which is worth a reviewer's glance and is not grounds to fail a claim. What
 *  actually catches a wrong name is the cross-document comparison in INTRA/REDFLAG
 *  (nameMatches), which is what the sheet's "unless different in intra document" meant.
 *
 *  Collected across the WHOLE claim so a name labelled on one document is recognised on the
 *  documents that print it without a label. */
function claimNameWords(shared: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const text of shared.values()) {
    for (const name of [...extractNames(text), ...extractRelationNames(text)]) {
      // EVERY word, no length cap. A cap was tried here and was the wrong tool: it made
      // name length decide whether a surname is spell-flagged, so "Mohammed Abdul Karim
      // Dass" left "Dass" exposed as the "days" near-miss this exists to prevent. Spillover
      // from an adjacent field is bounded at extraction instead, where the colon that marks
      // the next label is still visible.
      // ponytail: extractNames drops ONE trailing label word, so a multiword label
      // ("date of birth", "profesion type") still leaks its leading words into this set and
      // can silence a real misspelling. Bound it by field geometry — word boxes, not the
      // flattened line — if that shows up in a reviewer sample.
      for (const w of name.toLowerCase().match(/[a-z]+/g) ?? []) out.add(w);
    }
  }
  return out;
}

export const spellValidator: Validator = {
  key: 'SPELL',
  column: 'spellCheckStatus',
  async run(ctx) {
    // Forgery signal = misspellings of EXPECTED form vocabulary, not a raw
    // dictionary-miss ratio. On scanned Indian paperwork the ratio just tracked OCR
    // quality (place/personal names + OCR garbage swamp the real typos); matching
    // near-misses of a curated term list isolates the words reviewers actually flag.
    // The dictionary loads lazily on the first document that has candidate words.
    let spell: Spell | null = null;
    const { terms, glossary } = await loadTermsAndGlossary(ctx.prisma);
    const nameWords = claimNameWords(ctx.shared);
    const sample: string[] = []; // details.suspect: "token→term" (<=50)
    const doubtfulSample: string[] = [];
    const findings: FindingInput[] = [];
    const distinct = new Set<string>();
    const doubtful = new Set<string>();
    for (const [documentId, text] of ctx.shared) {
      const words = spellCandidates(text);
      if (words.length === 0) continue;
      const s = spell ?? (spell = await getSpell());
      // A token counts as a real word if the dictionary accepts it in its own case
      // or lowercased (dictionary-en holds many proper nouns only capitalised).
      // A glossary abbreviation counts as a real word: that is the whole point of the
      // reviewers being able to add "Pvt" and "Ltd" themselves.
      // A correctly spelled place is a real word too: never flagged, and never "corrected"
      // into a form word ("Pune" was reported as a misspelling of "june").
      const isRealWord = (w: string) =>
        dictHasWord(s, w) || glossary.has(w.toLowerCase()) || KNOWN_LOCAL_WORDS.has(w.toLowerCase());
      // Finding no misspelling in OCR noise is not a pass — nothing was actually checked.
      if (words.length >= UNREADABLE_MIN_WORDS) {
        const real = words.filter(isRealWord).length;
        if (real / words.length < UNREADABLE_REAL_WORD_RATIO) {
          const name = ctx.documents.find((d) => d.id === documentId)?.fileName ?? 'A document';
          findings.push({
            documentId,
            code: 'SPELL_UNREADABLE',
            severity: 'ERROR',
            message:
              `${name} could not be read reliably (only ${Math.round((100 * real) / words.length)}% ` +
              `of its words are real words), so its spelling was not checked — please check it visually`,
            data: { realWords: real, words: words.length },
          });
          continue;
        }
      }
      // OCR word boxes let us anchor each hit to a region on an image (Phase 2).
      const boxIndex = indexBoxes(ctx.wordBoxes.get(documentId) ?? []);
      // Places are near-miss targets too, after the form terms so a tie goes to the form
      // word, and a hit against one is only ever doubtful.
      const hits = findTermMisspellings(words, isRealWord, [...terms, ...PLACES], PLACES).map((hit) => {
        const { token, term } = hit;
        const box = boxIndex.get(token)?.shift();
        // A low-confidence OCR read is itself grounds for doubt, whatever the glyphs say.
        // A confident read is not a scan error. Two edits are softened because OCR garbage
        // looks like that — but "Degination" (conf 93) was printed that way, and Doubtful hid
        // a real misspelling (client QA 2026-10, #45). Glyph swaps stay soft on one confident
        // reading: that IS what a confident misread looks like.
        const confidentlyPrinted =
          box?.conf !== undefined &&
          box.conf >= CONFIDENT_OCR &&
          nearFormWord(token, term) &&
          !ocrIndistinguishable(token, term);
        const unsure =
          (hit.doubtful && !confidentlyPrinted) || (box?.conf !== undefined && box.conf < LOW_OCR_CONFIDENCE);
        return { ...hit, box, unsure };
      });
      // Two kinds of single reading were hiding real misspellings (client QA 2026-10), and are
      // read again, by our OCR at REREAD_SCALE, before the hit is hidden:
      //  - #42 "Assoolate": a word from a PDF's text layer has no confidence at all, and on a
      //    scanned page that layer is the scanning app's own invisible OCR. Trusting it as
      //    printed would fail claims on its misreads ("invoicc" on 12 claims, "totai" on 10);
      //    a different engine agreeing with it, even on a glyph swap, is independent evidence.
      //    Measured on all 570 claims: our OCR confirmed 7 of 77 such words, all printed that
      //    way but "Sighature" (see SIGNING_LINE_WORDS), and none of the "invoicc"/"totai".
      //  - #44 "Enginear" read at 69. Low confidence alone does not separate a misprint from a
      //    misread, nor does the page reading well around it: a printed "vehcile" read at 64
      //    and a pen-crossed "Customer" read "cudtomer" at 58, both on pages whose median
      //    word read 93-95. A misread belongs to one rendering of the pixels; a misprint
      //    survives another. Of 120 such words read at 50-69, the re-render confirmed 7 —
      //    "Enginear" on all four slips, "vehcile", and two bold words on 91 ppi scans that
      //    rereadPages now refuses to read again.
      // Our own engine is NOT a second opinion on its glyph swaps or its guesses: re-rendered,
      // it read a bold "Period" as "Perlod" and a stamped "TOTAL" as "toial" again, and the
      // bold "Policy" it first read as "palicy" at 13 and 41. So an OCR word is re-read only
      // when it is one plain letter off (not doubtful in itself) and its first reading beat a
      // coin toss.
      // Names and places are not re-read: their doubt is the word, not the reading.
      const askAgain = ({ box, token, term, unsure, doubtful: shaky }: (typeof hits)[number]) =>
        unsure &&
        box !== undefined &&
        !nameWords.has(token) &&
        !SIGNING_LINE_WORDS.has(term) &&
        (box.conf === undefined
          ? nearFormWord(token, term) && !isProperNounTerm(term, isRealWord)
          : !shaky && box.conf >= GUESS_OCR_CONFIDENCE);
      const reread = indexBoxes(
        await secondReading.pages(ctx, documentId, hits.filter(askAgain).map((h) => h.box!.page))
      );
      for (const hit of hits) {
        const { token, term, box } = hit;
        const confirmed =
          askAgain(hit) &&
          (reread.get(token) ?? []).some((b) => b.page === box!.page && (b.conf ?? 0) >= CONFIDENT_OCR);
        // A word the claim uses as somebody's name is doubtful however it reads.
        const soft = nameWords.has(token) || (hit.unsure && !confirmed);
        (soft ? doubtful : distinct).add(token);
        const into = soft ? doubtfulSample : sample;
        if (into.length < 50) into.push(`${token}→${term}`);
        findings.push({
          documentId,
          code: soft ? 'SPELL_DOUBTFUL' : 'SPELL_SUSPECT',
          severity: soft ? 'WARNING' : 'ERROR',
          message: soft
            ? `Doubtful "${token}" (expected "${term}") — the scan quality can account for this, please confirm visually`
            : `Misspelled "${token}" (expected "${term}")`,
          page: box?.page ?? null,
          bbox: box?.bbox ?? null,
          data: { word: token, expected: term, doubtful: soft },
        });
      }
    }

    // FAILS on a confident misspelling, or when a document could not be read at all (nothing
    // was checked). Doubtful hits are WARNINGs, hidden from reviewers: they neither fail the
    // check nor appear in its summary.
    const unread = findings.filter((f) => f.code === 'SPELL_UNREADABLE').length;
    const status = distinct.size >= SPELL_MIN_TERM_HITS || unread > 0 ? 'FAILED' : 'PASSED';
    const parts: string[] = [];
    if (distinct.size) parts.push(`${distinct.size} expected-term misspelling(s): ${sample.slice(0, 8).join(', ')}`);
    if (unread) parts.push(`${unread} document(s) could not be read reliably — please check them visually`);
    return {
      status,
      summary: parts.length ? parts.join('. ') : 'No expected-term misspellings found.',
      details: { suspect: sample, doubtful: doubtfulSample },
      // Doubtful (WARNING) hits are stored but hidden from reviewers; only SUSPECT shows.
      findings: findings.slice(0, 200),
    };
  },
};
