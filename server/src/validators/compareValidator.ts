import { Validator } from './types.js';
import { segment } from './segment.js';
import { crossDocFieldFindings } from './crossDocLogic.js';

/**
 * Data Compare — the client sheet's "Data Compare" tab: a value that disagrees BETWEEN the
 * claim's own documents (customer name on the invoice vs the policy, chassis on the RC vs
 * the insurance, employee code on the ID card vs the payslip).
 *
 * This used to be folded into FULL, so it rendered under the "Missing Docs" card and the
 * reviewers could not find it (22 Sep review). Its own check, its own card.
 */
export const compareValidator: Validator = {
  key: 'COMPARE',
  column: 'dataCompareStatus',
  async run(ctx) {
    const findings = crossDocFieldFindings(
      segment(ctx).map((i) => ({
        documentId: i.documentId,
        page: i.page,
        text: i.text,
        govtCode: i.govtCode,
      }))
    );
    const mismatches = findings.filter((f) => f.severity === 'ERROR').length;
    const advisories = findings.length - mismatches;

    const summary =
      mismatches > 0
        ? `${mismatches} mismatch(es) between documents${advisories ? `, ${advisories} advisory` : ''}.`
        : advisories > 0
        ? `No mismatches; ${advisories} advisory note(s).`
        : 'All compared values agree across documents.';
    return { status: mismatches > 0 ? 'FAILED' : 'PASSED', summary, findings };
  },
};
