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
 * Collapse a validation-check status to a binary PASSED/FAILED for both display
 * and rule evaluation: only an explicit FAILED counts as failed; every other
 * state (PASSED / PENDING / IN_PROGRESS / DOCS_NOT_AVAILABLE) reads as PASSED.
 * Shared by the claims xlsx export so the two agree.
 */
export function binaryValidationStatus(raw: string): 'PASSED' | 'FAILED' {
  return raw === 'FAILED' ? 'FAILED' : 'PASSED';
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

/** A validation-status field: compare the raw status directly, so `= PASSED`
 *  matches only a literal PASSED — DOCS_NOT_AVAILABLE / PENDING / IN_PROGRESS
 *  do NOT count as passed (a no-document claim must not read as validated). */
function statusEval(status: string, op: RuleOperator, value: string): RuleEvaluation {
  return { passed: cmpStr(status, op, value), actual: status };
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
