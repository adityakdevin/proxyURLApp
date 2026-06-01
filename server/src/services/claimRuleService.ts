import { PrismaClient, Prisma, Status, ClaimRule, RuleField, RuleOperator, Role } from '@prisma/client';
import { ClaimFacts, evaluateRule, validOperatorsFor } from '../validators/ruleLogic.js';
import { ClaimService } from './claimService.js';
import { subCategoryExists } from '../lib/subCategoryGuard.js';

export class ClaimRuleServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface CreateClaimRuleInput {
  subCategoryId: string;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  displayOrder?: number;
  status?: Status;
}
export interface UpdateClaimRuleInput {
  name?: string;
  field?: RuleField;
  operator?: RuleOperator;
  value?: string;
  displayOrder?: number;
  status?: Status;
}

export class ClaimRuleService {
  constructor(private prisma: PrismaClient) {}

  private validateRule(field: RuleField, operator: RuleOperator, value: string): void {
    if (!value || value.trim().length === 0)
      throw new ClaimRuleServiceError('INVALID_RULE', 'Value is required');
    if (!validOperatorsFor(field).includes(operator))
      throw new ClaimRuleServiceError('INVALID_RULE', 'Operator is not valid for this field');
    if ((field === 'DOCUMENT_COUNT' || field === 'REMARK_COUNT') && !Number.isInteger(Number(value)))
      throw new ClaimRuleServiceError('INVALID_RULE', 'Value must be an integer for this field');
    // ASSIGNED is a boolean fact; only 'true'/'false' evaluate meaningfully
    // (ruleLogic treats anything else as false), so reject other values up front.
    if (field === 'ASSIGNED' && !['true', 'false'].includes(value.trim().toLowerCase()))
      throw new ClaimRuleServiceError('INVALID_RULE', "Value must be 'true' or 'false' for ASSIGNED");
  }

  async create(input: CreateClaimRuleInput, actorId: string): Promise<ClaimRule> {
    this.validateRule(input.field, input.operator, input.value);
    if (!(await subCategoryExists(this.prisma, input.subCategoryId))) {
      throw new ClaimRuleServiceError('SUBCATEGORY_NOT_FOUND', 'SubCategory not found');
    }
    return this.prisma.claimRule.create({
      data: {
        subCategoryId: input.subCategoryId,
        name: input.name,
        field: input.field,
        operator: input.operator,
        value: input.value,
        displayOrder: input.displayOrder ?? 0,
        status: input.status ?? Status.ACTIVE,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
  }

  async update(id: string, input: UpdateClaimRuleInput, actorId: string): Promise<ClaimRule> {
    const existing = await this.prisma.claimRule.findUnique({ where: { id } });
    if (!existing) throw new ClaimRuleServiceError('NOT_FOUND', 'ClaimRule not found');
    const field = input.field ?? existing.field;
    const operator = input.operator ?? existing.operator;
    const value = input.value ?? existing.value;
    this.validateRule(field, operator, value);
    return this.prisma.claimRule.update({ where: { id }, data: { ...input, updatedBy: actorId } });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<ClaimRule> {
    return this.prisma.claimRule.update({ where: { id }, data: { status, updatedBy: actorId } });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.claimRule.delete({ where: { id } });
  }

  async getById(id: string): Promise<ClaimRule | null> {
    return this.prisma.claimRule.findUnique({ where: { id } });
  }

  async list(filters: { subCategoryId?: string; status?: Status; page?: number; limit?: number }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.ClaimRuleWhereInput = {};
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.status) where.status = filters.status;
    const [data, total] = await Promise.all([
      this.prisma.claimRule.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claimRule.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async gatherFacts(claimId: string): Promise<ClaimFacts | null> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: {
        workflowStatus: { select: { name: true } },
        documents: { select: { documentTypeId: true } },
      },
    });
    if (!claim) return null;
    const [remarkCount, docTypes] = await Promise.all([
      this.prisma.claimRemark.count({ where: { claimId } }),
      this.prisma.documentTypeMaster.findMany({
        where: { subCategoryId: claim.subCategoryId },
        select: { id: true, name: true },
      }),
    ]);
    const presentIds = new Set(
      claim.documents.map((d) => d.documentTypeId).filter((x): x is string => !!x)
    );
    return {
      documentCount: claim.documents.length,
      remarkCount,
      assigned: !!claim.assignedToUserId,
      presentDocTypeNames: docTypes.filter((t) => presentIds.has(t.id)).map((t) => t.name),
      workflowStatusName: claim.workflowStatus.name,
      spellCheckStatus: claim.spellCheckStatus,
      qrStatus: claim.qrStatus,
      metaExtractionStatus: claim.metaExtractionStatus,
      intraClaimStatus: claim.intraClaimStatus,
      fullScanStatus: claim.fullScanStatus,
    };
  }

  async evaluateForClaim(claimId: string, callerId: string, callerRole: Role) {
    const claim = await new ClaimService(this.prisma).getById(claimId, callerId, callerRole);
    if (!claim) return null; // not found or out of scope
    const facts = await this.gatherFacts(claimId);
    if (!facts) return null;
    const rules = await this.prisma.claimRule.findMany({
      where: { subCategoryId: claim.subCategoryId, status: 'ACTIVE' },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
    const evaluated = rules.map((r) => {
      const e = evaluateRule(r, facts);
      return {
        id: r.id,
        name: r.name,
        field: r.field,
        operator: r.operator,
        value: r.value,
        passed: e.passed,
        actual: e.actual,
      };
    });
    return {
      rules: evaluated,
      passedCount: evaluated.filter((e) => e.passed).length,
      total: evaluated.length,
    };
  }
}
