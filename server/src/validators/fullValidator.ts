import { Validator, FindingInput } from './types.js';
import { completenessOutcome } from './logic.js';

export const fullValidator: Validator = {
  key: 'FULL',
  column: 'fullScanStatus',
  async run(ctx) {
    // Only REQUIRED active types gate FULL completeness (global doc-type set).
    const types = await ctx.prisma.documentTypeMaster.findMany({
      where: { status: 'ACTIVE', isRequired: true },
      select: { id: true, name: true },
    });
    const presentIds = new Set(
      ctx.documents.map((d) => d.documentTypeId).filter((x): x is string => !!x)
    );
    const presentNames = types.filter((t) => presentIds.has(t.id)).map((t) => t.name);
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
