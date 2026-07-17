import { Validator, FindingInput } from './types.js';
import { completenessOutcome, typePresent } from './logic.js';

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
    const outcome = completenessOutcome(
      presentNames,
      types.map((t) => t.name)
    );
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
