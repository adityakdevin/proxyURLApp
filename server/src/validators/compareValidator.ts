import { Validator, FindingInput } from './types.js';
import { segment } from './segment.js';
import { locate } from './redFlagValidator.js';
import { crossDocFieldFindings, gstCertFindings, dmsNameFindings, invoiceRcNameResult, newCarPolicyFindings, oldCarPaperFindings } from './crossDocLogic.js';
import { holderNameFindings, oldCarNameFindings } from './holderNames.js';

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
    const keysOf = (fs: FindingInput[]) => new Set(fs.map((f) => `${f.documentId}:${f.page}`));
    const holder = holderNameFindings(ctx.claim.customerName, pages, ctx.claim.claimId);
    const oldCarPaper = oldCarPaperFindings(pages, ctx.claim.claimId);
    const newCarPolicy = newCarPolicyFindings(pages, ctx.claim.claimId, keysOf(oldCarPaper));
    // One red line per page per defect: a holder finding already says the page's name is
    // wrong, and a policy or old-car chassis finding already says the page is another car's.
    const holderPages = keysOf(holder);
    const otherCarPages = keysOf([...newCarPolicy, ...oldCarPaper, ...holder.filter((f) => (f.data as { actualType?: string } | undefined)?.actualType === 'INSURANCE')]);
    const dropDuplicate = (f: FindingInput) => {
      const key = `${f.documentId}:${f.page}`;
      return (f.code === 'CROSS_NAME_MISMATCH' && holderPages.has(key)) || ((f.code === 'CROSS_OTHER_VEHICLE' || f.code === 'CROSS_CHASSIS_MISMATCH') && otherCarPages.has(key));
    };
    const findings = [
      // Sheet row 1, "1st Chk to apply" — first in the list too.
      ...dmsNameFindings(ctx.claim.customerName, pages),
      ...holder,
      ...crossDocFieldFindings(pages, ctx.claim.claimId).filter((f) => !(rcDiff && isInvoiceRcName(f)) && !dropDuplicate(f)),
      ...gstCertFindings(pages),
      ...rcResult,
      ...oldCarPaper,
      ...newCarPolicy,
      ...oldCarNameFindings(pages, ctx.claim.claimId),
    ];
    // Box the value each finding names, so its row zooms to it on the document the way Red
    // Flags and Duplicate rows do. Null (page-jump only) when the page has no word
    // coordinates or the value is not found — never a box somewhere wrong.
    for (const f of findings) {
      const d = f.data as { actual?: string; rc?: string } | undefined;
      const value = d?.actual ?? d?.rc;
      if (!f.bbox && value && f.documentId && f.page != null) {
        f.bbox = locate(ctx.wordBoxes.get(f.documentId) ?? [], f.page, value);
      }
    }
    const mismatches = findings.filter((f) => f.severity === 'ERROR').length;
    // Advisory (WARNING) findings are hidden from reviewers, so the card does not count them.
    const summary =
      mismatches > 0
        ? `${mismatches} mismatch(es) between documents.`
        : 'All compared values agree across documents.';
    // The sheet wants the Invoice vs RC outcome stated ("Same Name" / "Diff Name"), so it sits
    // on the card itself, not only in the findings.
    const rcNote = rcResult[0] ? ` ${rcResult[0].message}` : '';
    return { status: mismatches > 0 ? 'FAILED' : 'PASSED', summary: summary + rcNote, findings };
  },
};
