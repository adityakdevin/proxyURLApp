import { Validator, FindingInput } from './types.js';
import { completenessOutcome, typePresent, typeInText } from './logic.js';
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
    // A type is present if a document was classified to it (filename match) OR
    // the extracted text (META runs first, fills ctx.shared) mentions it —
    // scanned claims are one bundled PDF whose filename names no type.
    const texts = [...ctx.shared.values()];
    const presentNames = types
      .filter((t) => presentIds.has(t.id) || typePresent(t.name, t.govtCode, texts))
      .map((t) => t.name);

    // Provenance (spec §2): show WHERE each present type was found — "file.pdf p.3",
    // or the filename alone for a filename-classified doc. Uses the shared segment
    // classifier (spec decision 5).
    const instances = segment(ctx);
    const fmt = (fileName: string, page: number | null) => (page !== null ? `${fileName} p.${page}` : fileName);
    const provenance: Record<string, string> = {};
    for (const t of types) {
      if (!presentNames.includes(t.name)) continue;
      const byCode = t.govtCode ? instances.find((i) => i.govtCode === t.govtCode) : undefined;
      const byName = byCode ?? instances.find((i) => typeInText(t.name, [i.text]));
      if (byName) {
        provenance[t.name] = fmt(byName.fileName, byName.page);
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
    // Completeness is claim-level (a missing type isn't tied to any one file).
    if (outcome.status === 'FAILED') {
      const missing = (outcome.details as { missing: string[] } | undefined)?.missing ?? [];
      outcome.findings = missing.map(
        (name): FindingInput => ({
          documentId: null,
          code: 'FULL_MISSING_TYPE',
          message: `Required document type missing: ${name}.`,
          data: { documentType: name },
        })
      );
    }
    return outcome;
  },
};
