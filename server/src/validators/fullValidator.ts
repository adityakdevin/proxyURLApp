import { Validator, FindingInput } from './types.js';
import { completenessOutcome, typePresent, customTypeOfPage, GOVT_TYPE_MARKERS } from './logic.js';
import { classifyDocType } from './crossDocLogic.js';
import { segment } from './segment.js';

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
    const texts = [...ctx.shared.values()];
    const presentNames = types
      .filter(
        (t) =>
          presentIds.has(t.id) ||
          (hasMarker(t) ? typePresent(t.name, t.govtCode, texts) : customFound.has(t.name))
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
    outcome.findings = [
      ...missing.map(
        (name): FindingInput => ({
          documentId: null,
          code: 'FULL_MISSING_TYPE',
          // Master sheet item 32: the reviewers' wording, not ours.
          message: `Missing docs - ${name}`,
          data: { documentType: name },
        })
      ),
    ];

    return outcome;
  },
};
