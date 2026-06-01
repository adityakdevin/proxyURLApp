import { Validator } from './types.js';
import { completenessOutcome } from './logic.js';

export const fullValidator: Validator = {
  key: 'FULL',
  column: 'fullScanStatus',
  async run(ctx) {
    // Only REQUIRED active types gate FULL completeness.
    const types = await ctx.prisma.documentTypeMaster.findMany({
      where: { subCategoryId: ctx.claim.subCategoryId, status: 'ACTIVE', isRequired: true },
      select: { id: true, name: true },
    });
    const presentIds = new Set(
      ctx.documents.map((d) => d.documentTypeId).filter((x): x is string => !!x)
    );
    const presentNames = types.filter((t) => presentIds.has(t.id)).map((t) => t.name);
    return completenessOutcome(
      presentNames,
      types.map((t) => t.name)
    );
  },
};
