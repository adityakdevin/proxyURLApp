import { RuleField, RuleOperator } from '@prisma/client';

export interface ClaimFacts {
  documentCount: number;
  remarkCount: number;
  assigned: boolean;
  presentDocTypeNames: string[];
  workflowStatusName: string;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
}
export interface RuleEvaluation {
  passed: boolean;
  actual: string;
}

const NUMERIC_FIELDS: RuleField[] = ['DOCUMENT_COUNT', 'REMARK_COUNT'];

/**
 * Collapse a validation-check status for rule evaluation and the claims xlsx
 * export (shared so the two agree): PENDING / IN_PROGRESS read as PASSED (a
 * mid-run claim shouldn't flunk rules), but DOCS_NOT_AVAILABLE and DOUBTFUL keep
 * their own state — a claim with zero documents was never checked, and a doubtful
 * one needs a reviewer's eye, so neither may satisfy "= PASSED" status rules
 * (neither reads as FAILED either).
 */
export function collapseValidationStatus(
  raw: string
): 'PASSED' | 'FAILED' | 'DOUBTFUL' | 'DOCS N/A' {
  if (raw === 'FAILED') return 'FAILED';
  if (raw === 'DOCS_NOT_AVAILABLE' || raw === 'DOCS N/A') return 'DOCS N/A';
  // Like DOCS N/A, DOUBTFUL keeps its own state: warning-level findings need a human
  // decision, so the check satisfies neither "= PASSED" nor "= FAILED".
  if (raw === 'DOUBTFUL') return 'DOUBTFUL';
  return 'PASSED';
}

export function validOperatorsFor(field: RuleField): RuleOperator[] {
  return NUMERIC_FIELDS.includes(field)
    ? ['EQ', 'NEQ', 'GTE', 'LTE', 'GT', 'LT']
    : ['EQ', 'NEQ'];
}

function cmpNum(a: number, op: RuleOperator, b: number): boolean {
  switch (op) {
    case 'EQ': return a === b;
    case 'NEQ': return a !== b;
    case 'GTE': return a >= b;
    case 'LTE': return a <= b;
    case 'GT': return a > b;
    case 'LT': return a < b;
    default: return false;
  }
}
function cmpStr(a: string, op: RuleOperator, b: string): boolean {
  if (op === 'EQ') return a === b;
  if (op === 'NEQ') return a !== b;
  return false; // numeric operators are invalid for string fields
}

/** A validation-status field: compare on the collapsed status, so rules agree
 *  with the claims report and summary (which use the same collapse). `actual`
 *  is reported collapsed too, so a passing claim never shows a raw PENDING
 *  next to a satisfied `= PASSED` rule — and a zero-doc claim shows DOCS N/A. */
function statusEval(status: string, op: RuleOperator, value: string): RuleEvaluation {
  const actual = collapseValidationStatus(status);
  return { passed: cmpStr(actual, op, collapseValidationStatus(value.trim().toUpperCase())), actual };
}

export function evaluateRule(
  rule: { field: RuleField; operator: RuleOperator; value: string },
  facts: ClaimFacts
): RuleEvaluation {
  switch (rule.field) {
    case 'DOCUMENT_COUNT':
      return { passed: cmpNum(facts.documentCount, rule.operator, Number(rule.value)), actual: String(facts.documentCount) };
    case 'REMARK_COUNT':
      return { passed: cmpNum(facts.remarkCount, rule.operator, Number(rule.value)), actual: String(facts.remarkCount) };
    case 'ASSIGNED': {
      const want = rule.value.trim().toLowerCase() === 'true';
      const passed = rule.operator === 'NEQ' ? facts.assigned !== want : facts.assigned === want;
      return { passed, actual: String(facts.assigned) };
    }
    case 'HAS_DOCUMENT_TYPE': {
      const present = facts.presentDocTypeNames.includes(rule.value);
      const passed = rule.operator === 'NEQ' ? !present : present;
      return { passed, actual: present ? 'present' : 'absent' };
    }
    case 'WORKFLOW_STATUS':
      return { passed: cmpStr(facts.workflowStatusName, rule.operator, rule.value), actual: facts.workflowStatusName };
    case 'SPELL_STATUS':
      return statusEval(facts.spellCheckStatus, rule.operator, rule.value);
    case 'QR_STATUS':
      return statusEval(facts.qrStatus, rule.operator, rule.value);
    case 'META_STATUS':
      return statusEval(facts.metaExtractionStatus, rule.operator, rule.value);
    case 'INTRA_STATUS':
      return statusEval(facts.intraClaimStatus, rule.operator, rule.value);
    case 'FULL_STATUS':
      return statusEval(facts.fullScanStatus, rule.operator, rule.value);
    default:
      return { passed: false, actual: '' };
  }
}
