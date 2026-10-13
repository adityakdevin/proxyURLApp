import { Validator, FindingInput } from './types.js';
import { completenessOutcome, typePresent, customTypeOfPage, GOVT_TYPE_MARKERS } from './logic.js';
import { classifyDocType } from './crossDocLogic.js';
import { segment, type DocInstance } from './segment.js';
import { getSpell, isRealWord } from './dictionary.js';
import { spellCandidates } from './logic.js';

/**
 * Pages OCR could not make sense of, that no ID-card marker claimed: fewer than
 * MIN_REAL_WORDS dictionary words, or under REAL_WORD_RATIO of its words real (the ratio
 * SPELL uses for an unreadable document). A blank page yields no words and is not counted.
 * ponytail: dictionary words as the readability measure; use Tesseract confidence if
 * the OCR port starts returning it per page.
 */
const MIN_REAL_WORDS = 8;
const REAL_WORD_RATIO = 0.35;
async function unreadablePages(instances: DocInstance[]): Promise<DocInstance[]> {
  const spell = await getSpell();
  return instances.filter((i) => {
    if (i.govtCode) return false;
    const words = spellCandidates(i.text);
    if (words.length === 0) return false;
    const real = words.filter((w) => isRealWord(spell, w)).length;
    return real < MIN_REAL_WORDS || real / words.length < REAL_WORD_RATIO;
  });
}

export const fullValidator: Validator = {
  key: 'FULL',
  column: 'fullScanStatus',
  async run(ctx) {
    // Only REQUIRED active types gate FULL completeness (global doc-type set).
    const types = await ctx.prisma.documentTypeMaster.findMany({
      where: { status: 'ACTIVE', isRequired: true },
      select: { id: true, name: true, govtCode: true },
    });
    const presentIds = new Set(
      ctx.documents.map((d) => d.documentTypeId).filter((x): x is string => !!x)
    );
    // Provenance (spec §2): show WHERE each present type was found — "file.pdf p.3",
    // or the filename alone for a filename-classified doc. Uses the shared segment
    // classifier (spec decision 5).
    const instances = segment(ctx);
    const fmt = (fileName: string, page: number | null) => (page !== null ? `${fileName} p.${page}` : fileName);

    // Text-named types (Bill, Invoice, Bank Statement — no govt ID marker): each page counts
    // toward the ONE type it is, not every type it mentions. See customTypeOfPage.
    const hasMarker = (t: { govtCode: string | null }) => !!(t.govtCode && GOVT_TYPE_MARKERS[t.govtCode]);
    const customNames = types.filter((t) => !hasMarker(t)).map((t) => t.name);
    const customFound = new Map<string, string>(); // type name -> where
    for (const i of instances) {
      const name = customTypeOfPage(customNames, i.text, classifyDocType(i.text));
      if (name && !customFound.has(name)) customFound.set(name, fmt(i.fileName, i.page));
    }

    // A type is present if a document was classified to it (filename match) OR its content
    // says so (META runs first, fills ctx.shared) — scanned claims are one bundled PDF whose
    // filename names no type.
    // Judged PAGE by page. A bundle is one PDF holding the invoice, policy and cards, so on
    // its whole text an ID marker found the "Aadhaar No" a payslip mentions (660157 read as
    // having an Aadhaar it has none of), and the guard against that then saw policy wording
    // somewhere in the bundle and hid the genuine card on another page (624255, 004536, …)
    // (client QA 2026-10, points 7-12).
    const pageTexts = instances.map((i) => i.text);
    const presentNames = types
      .filter(
        (t) =>
          presentIds.has(t.id) ||
          (hasMarker(t) ? typePresent(t.name, t.govtCode, pageTexts) : customFound.has(t.name))
      )
      .map((t) => t.name);

    const provenance: Record<string, string> = {};
    for (const t of types) {
      if (!presentNames.includes(t.name)) continue;
      const byCode = t.govtCode ? instances.find((i) => i.govtCode === t.govtCode) : undefined;
      const where = byCode ? fmt(byCode.fileName, byCode.page) : customFound.get(t.name);
      if (where) {
        provenance[t.name] = where;
      } else {
        const doc = ctx.documents.find((d) => d.documentTypeId === t.id);
        if (doc) provenance[t.name] = doc.fileName;
      }
    }

    const outcome = completenessOutcome(
      presentNames,
      types.map((t) => t.name)
    );
    // Attach provenance without disturbing the existing present/missing details shape.
    const prevDetails = (outcome.details as Record<string, unknown> | undefined) ?? {};
    outcome.details = { ...prevDetails, present: presentNames, provenance };
    // Completeness is claim-level: a missing type isn't tied to any one file.
    const missing =
      outcome.status === 'FAILED'
        ? ((outcome.details as { missing: string[] } | undefined)?.missing ?? [])
        : [];

    // An ID card we did not find is not proof it is absent when a page could not be read.
    // Card photos OCR'd as noise (faded, sideways, upside down) were reported "missing" on
    // claims that carry both cards — 301725, 650618, 618437 (client QA 2026-10, points
    // 8-12). Such a miss names the pages to look at, so the reviewer checks them before
    // asking the customer for a card that may already be there.
    const markerNames = new Set(types.filter(hasMarker).map((t) => t.name));
    const unread = await unreadablePages(instances);
    const fmtPages = unread.map((i) => fmt(i.fileName, i.page)).join(', ');
    const soft = (name: string) => markerNames.has(name) && unread.length > 0;
    outcome.findings = [
      ...missing.map(
        (name): FindingInput =>
          soft(name)
            ? {
                documentId: null,
                code: 'FULL_MISSING_TYPE',
                // An ERROR, not a WARNING: warnings are hidden from reviewers, and a missing
                // card must never read as present. The page hint stays in the message.
                severity: 'ERROR',
                message: `Missing docs - ${name} (not found, but ${fmtPages} could not be read — check visually)`,
                data: { documentType: name, unreadable: unread.map((i) => fmt(i.fileName, i.page)) },
              }
            : {
                documentId: null,
                code: 'FULL_MISSING_TYPE',
                // Master sheet item 32: the reviewers' wording, not ours.
                message: `Missing docs - ${name}`,
                data: { documentType: name },
              }
      ),
    ];

    return outcome;
  },
};
