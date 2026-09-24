import { Validator, FindingInput } from './types.js';
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
    // When the Invoice vs RC result is "Diff Name", that line is the red flag for the pair;
    // the claim-wide name check reporting the same invoice/RC disagreement again is dropped.
    const rcDiff = rcResult[0]?.severity === 'ERROR';
    const isInvoiceRcName = (f: FindingInput) => {
      const d = f.data as { expectedType?: string; actualType?: string } | undefined;
      const pair = [d?.expectedType, d?.actualType].sort().join('/');
      return f.code === 'CROSS_NAME_MISMATCH' && pair === 'INVOICE/RC';
    };
    const findings = [
      // Sheet row 1, "1st Chk to apply" — first in the list too.
      ...dmsNameFindings(ctx.claim.customerName, pages),
      ...crossDocFieldFindings(pages).filter((f) => !(rcDiff && isInvoiceRcName(f))),
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
