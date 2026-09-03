import { Validator, FindingInput } from './types.js';
import { completenessOutcome, typePresent, typeInText } from './logic.js';
import { segment } from './segment.js';
import { crossDocFieldFindings } from './crossDocLogic.js';

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

    // Cross-document field consistency, claim-wide across every classified page. This
    // lived under REDFLAG, which meant the tab named after comparing documents did not
    // compare them and the tab named after format rules did. Red Flags keeps the format
    // rules (a malformed PAN, a 14-digit VID); FULL is where a value that disagrees
    // BETWEEN documents belongs, alongside the question of which documents are there at all.
    const crossDoc = crossDocFieldFindings(
      instances.map((i) => ({
        documentId: i.documentId,
        page: i.page,
        text: i.text,
        govtCode: i.govtCode,
      }))
    );
    const mismatches = crossDoc.filter((f) => f.severity === 'ERROR').length;

    const outcome = completenessOutcome(
      presentNames,
      types.map((t) => t.name)
    );
    // Attach provenance without disturbing the existing present/missing details shape.
    const prevDetails = (outcome.details as Record<string, unknown> | undefined) ?? {};
    outcome.details = { ...prevDetails, present: presentNames, provenance };
    // Completeness is claim-level (a missing type isn't tied to any one file); a cross
    // document mismatch already carries the outlier's own documentId.
    const missing =
      outcome.status === 'FAILED'
        ? ((outcome.details as { missing: string[] } | undefined)?.missing ?? [])
        : [];
    outcome.findings = [
      ...missing.map(
        (name): FindingInput => ({
          documentId: null,
          code: 'FULL_MISSING_TYPE',
          message: `Required document type missing: ${name}.`,
          data: { documentType: name },
        })
      ),
      ...crossDoc,
    ];

    // Either half can condemn the claim: a required document absent, or a value that
    // disagrees between the documents that ARE present.
    if (mismatches > 0) outcome.status = 'FAILED';
    const parts = [outcome.summary];
    if (crossDoc.length > 0) {
      parts.push(
        mismatches > 0
          ? `${mismatches} cross-document mismatch(es).`
          : `${crossDoc.length} cross-document advisory.`
      );
    }
    outcome.summary = parts.join(' ');
    return outcome;
  },
};
