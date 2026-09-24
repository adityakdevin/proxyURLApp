import { Validator } from './types.js';
import { segment } from './segment.js';
import { crossDocFieldFindings, dmsNameFindings, invoiceRcNameResult } from './crossDocLogic.js';

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
    const pages = segment(ctx).map((i) => ({
      documentId: i.documentId,
      page: i.page,
      text: i.text,
      govtCode: i.govtCode,
    }));
    const rcResult = invoiceRcNameResult(pages);
    const findings = [
      // Sheet row 1, "1st Chk to apply" — first in the list too.
      ...dmsNameFindings(ctx.claim.customerName, pages),
      ...crossDocFieldFindings(pages),
      ...rcResult,
    ];
    const mismatches = findings.filter((f) => f.severity === 'ERROR').length;
    const advisories = findings.filter((f) => f.severity === 'WARNING').length;

    const summary =
      mismatches > 0
        ? `${mismatches} mismatch(es) between documents${advisories ? `, ${advisories} advisory` : ''}.`
        : advisories > 0
        ? `No mismatches; ${advisories} advisory note(s).`
        : 'All compared values agree across documents.';
    // The sheet wants the Invoice vs RC outcome stated ("Same Name" / "Diff Name"), so it sits
    // on the card itself, not only in the findings.
    const rcNote = rcResult[0] ? ` ${rcResult[0].message}` : '';
    return { status: mismatches > 0 ? 'FAILED' : 'PASSED', summary: summary + rcNote, findings };
  },
};
