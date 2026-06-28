# Claims Phase 2E — Configurable Claim Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins define per-SubCategory "Field · Operator · Value" checks in the web UI, and show each claim's ✅/❌ against its SubCategory's active rules (evaluated live).

**Architecture:** A `ClaimRule` master table (CRUD mirrors `ClaimIdRule`), a **pure** `evaluateRule(rule, facts)` engine + a fact-gatherer in `ClaimRuleService`, a live-eval endpoint `GET /api/claims/:id/rules`, a new admin "Claim Rules" page, and a "Rules" section on the Claim Update page. No new dependencies; no Excel.

**Tech Stack:** Node/Express/TS (NodeNext ESM) · Prisma 5 / MySQL (`db push`) · React 18 / Vite. Static gate: `npx tsc --noEmit` per workspace.

**Spec:** `docs/superpowers/specs/2026-05-31-claims-phase2e-claim-rules-design.md`.

---

## File Structure (locked in advance)

**Server — created:** `server/src/validators/ruleLogic.ts` (pure) · `server/src/services/claimRuleService.ts` · `server/src/routes/admin/claimRules.ts` · tests `validators/__tests__/ruleLogic.test.ts`, `services/__tests__/claimRuleService.test.ts`
**Server — modified:** `prisma/schema.prisma` (enums + `ClaimRule` + relation) · `routes/admin/index.ts` (mount) · `routes/claims.ts` (GET `/:id/rules`)
**Client — created:** `client/src/pages/admin/ClaimRules.tsx`
**Client — modified:** `client/src/App.tsx` (route) · `client/src/components/layout/AdminLayout.tsx` (sidebar) · `client/src/pages/claims/ClaimUpdate.tsx` (Rules section)

---

## Phase A — Backend

### Task 1: Schema

**Files:** Modify `server/prisma/schema.prisma`

- [ ] **Step 1: Add enums** after the `ValidationTrigger` enum:

```prisma
enum RuleField {
  DOCUMENT_COUNT
  REMARK_COUNT
  ASSIGNED
  HAS_DOCUMENT_TYPE
  WORKFLOW_STATUS
  SPELL_STATUS
  QR_STATUS
  META_STATUS
  INTRA_STATUS
  FULL_STATUS
}

enum RuleOperator {
  EQ
  NEQ
  GTE
  LTE
  GT
  LT
}
```

- [ ] **Step 2: Add the model** at the bottom of the file:

```prisma
model ClaimRule {
  id            String       @id @default(uuid()) @db.VarChar(36)
  subCategoryId String       @map("sub_category_id") @db.VarChar(36)
  name          String       @db.VarChar(150)
  field         RuleField
  operator      RuleOperator
  value         String       @db.VarChar(150)
  status        Status       @default(ACTIVE)
  displayOrder  Int          @default(0) @map("display_order")
  createdAt     DateTime     @default(now()) @map("created_at")
  updatedAt     DateTime     @updatedAt @map("updated_at")
  createdBy     String?      @map("created_by") @db.VarChar(36)
  updatedBy     String?      @map("updated_by") @db.VarChar(36)

  subCategory SubCategory @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)

  @@index([subCategoryId])
  @@map("claim_rules")
}
```

- [ ] **Step 3: Add the relation** inside `model SubCategory { ... }` above its closing brace:

```prisma
  claimRules ClaimRule[]
```

- [ ] **Step 4: Validate + push + generate**

Run: `cd server && npx prisma validate && npm run db:push && npm run db:generate`
Expected: "valid", "in sync", client regenerated.

- [ ] **Step 5: Commit** — `git add server/prisma/schema.prisma && git commit -m "feat(claims): ClaimRule schema"`

### Task 2: Pure rule logic

**Files:** Create `server/src/validators/ruleLogic.ts`, `server/src/validators/__tests__/ruleLogic.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/validators/__tests__/ruleLogic.test.ts`

```ts
import { evaluateRule, validOperatorsFor, ClaimFacts } from '../ruleLogic.js';

const facts: ClaimFacts = {
  documentCount: 3,
  remarkCount: 1,
  assigned: true,
  presentDocTypeNames: ['Aadhar Card', 'PAN Card'],
  workflowStatusName: 'Pending',
  spellCheckStatus: 'PASSED',
  qrStatus: 'FAILED',
  metaExtractionStatus: 'PASSED',
  intraClaimStatus: 'PASSED',
  fullScanStatus: 'PASSED',
};

describe('ruleLogic', () => {
  it('validOperatorsFor', () => {
    expect(validOperatorsFor('DOCUMENT_COUNT')).toContain('GTE');
    expect(validOperatorsFor('QR_STATUS')).toEqual(['EQ', 'NEQ']);
  });
  it('numeric comparisons', () => {
    expect(evaluateRule({ field: 'DOCUMENT_COUNT', operator: 'GTE', value: '3' }, facts)).toEqual({ passed: true, actual: '3' });
    expect(evaluateRule({ field: 'DOCUMENT_COUNT', operator: 'GT', value: '3' }, facts).passed).toBe(false);
    expect(evaluateRule({ field: 'REMARK_COUNT', operator: 'EQ', value: '1' }, facts).passed).toBe(true);
  });
  it('enum/status EQ/NEQ', () => {
    expect(evaluateRule({ field: 'QR_STATUS', operator: 'EQ', value: 'PASSED' }, facts).passed).toBe(false);
    expect(evaluateRule({ field: 'QR_STATUS', operator: 'NEQ', value: 'PASSED' }, facts).passed).toBe(true);
    expect(evaluateRule({ field: 'WORKFLOW_STATUS', operator: 'EQ', value: 'Pending' }, facts).passed).toBe(true);
  });
  it('HAS_DOCUMENT_TYPE presence', () => {
    expect(evaluateRule({ field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Aadhar Card' }, facts)).toEqual({ passed: true, actual: 'present' });
    expect(evaluateRule({ field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Bill' }, facts)).toEqual({ passed: false, actual: 'absent' });
    expect(evaluateRule({ field: 'HAS_DOCUMENT_TYPE', operator: 'NEQ', value: 'Bill' }, facts).passed).toBe(true);
  });
  it('ASSIGNED boolean', () => {
    expect(evaluateRule({ field: 'ASSIGNED', operator: 'EQ', value: 'true' }, facts).passed).toBe(true);
    expect(evaluateRule({ field: 'ASSIGNED', operator: 'EQ', value: 'false' }, facts).passed).toBe(false);
  });
  it('numeric operator on non-numeric field is false', () => {
    expect(evaluateRule({ field: 'QR_STATUS', operator: 'GTE', value: 'PASSED' }, facts).passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run (expect fail)** — `cd server && npm test -- ruleLogic` → FAIL (module not found).

- [ ] **Step 3: Create `server/src/validators/ruleLogic.ts`**

```ts
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
      return { passed: cmpStr(facts.spellCheckStatus, rule.operator, rule.value), actual: facts.spellCheckStatus };
    case 'QR_STATUS':
      return { passed: cmpStr(facts.qrStatus, rule.operator, rule.value), actual: facts.qrStatus };
    case 'META_STATUS':
      return { passed: cmpStr(facts.metaExtractionStatus, rule.operator, rule.value), actual: facts.metaExtractionStatus };
    case 'INTRA_STATUS':
      return { passed: cmpStr(facts.intraClaimStatus, rule.operator, rule.value), actual: facts.intraClaimStatus };
    case 'FULL_STATUS':
      return { passed: cmpStr(facts.fullScanStatus, rule.operator, rule.value), actual: facts.fullScanStatus };
    default:
      return { passed: false, actual: '' };
  }
}
```

- [ ] **Step 4: Run (expect pass)** — `cd server && npm test -- ruleLogic` → PASS.
- [ ] **Step 5: Commit** — `git add server/src/validators/ruleLogic.ts server/src/validators/__tests__/ruleLogic.test.ts && git commit -m "feat(claims): pure rule evaluation logic"`

### Task 3: ClaimRuleService (CRUD + facts + evaluate)

**Files:** Create `server/src/services/claimRuleService.ts`, `server/src/services/__tests__/claimRuleService.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/services/__tests__/claimRuleService.test.ts`

```ts
import { PrismaClient } from '@prisma/client';
import { ClaimRuleService, ClaimRuleServiceError } from '../claimRuleService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('ClaimRuleService', () => {
  let prisma: PrismaClient;
  let service: ClaimRuleService;
  let subCategoryId: string;
  let adminId: string;
  let workflowStatusId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utId: string; let ptId: string; let catId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimRuleService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const ut = await prisma.userType.create({ data: { name: `cr-ut-${SUF}` } });
    const pt = await prisma.projectType.create({ data: { name: `cr-pt-${SUF}` } });
    utId = ut.id; ptId = pt.id;
    const cat = await prisma.category.create({ data: { name: `cr-cat-${SUF}`, userTypeId: utId, projectTypeId: ptId } });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `cr-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await prisma.claimRule.deleteMany({ where: { subCategoryId } });
    const st = await prisma.statusMaster.create({ data: { subCategoryId, name: 'Pending', isDefault: true, createdBy: adminId, updatedBy: adminId } });
    workflowStatusId = st.id;
    await prisma.documentTypeMaster.create({ data: { subCategoryId, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 1, createdBy: adminId, updatedBy: adminId } });
  });

  afterAll(async () => {
    await prisma.claimRule.deleteMany({ where: { subCategoryId } });
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.userType.deleteMany({ where: { id: utId } });
    await prisma.projectType.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('create rejects an operator invalid for the field', async () => {
    await expect(
      service.create({ subCategoryId, name: 'bad', field: 'QR_STATUS', operator: 'GTE', value: 'PASSED' }, adminId)
    ).rejects.toMatchObject({ code: 'INVALID_RULE' });
  });

  it('create rejects a non-integer value for a numeric field', async () => {
    await expect(
      service.create({ subCategoryId, name: 'bad', field: 'DOCUMENT_COUNT', operator: 'GTE', value: 'three' }, adminId)
    ).rejects.toMatchObject({ code: 'INVALID_RULE' });
  });

  it('evaluateForClaim gathers facts and evaluates active rules', async () => {
    await service.create({ subCategoryId, name: 'min docs', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '1' }, adminId);
    await service.create({ subCategoryId, name: 'has aadhar', field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Aadhar Card' }, adminId);
    const aadharType = await prisma.documentTypeMaster.findFirst({ where: { subCategoryId, name: 'Aadhar Card' } });
    const claim = await prisma.claim.create({ data: { claimId: 'C-RULE', subCategoryId, workflowStatusId, createdBy: adminId, updatedBy: adminId } });
    await prisma.document.create({ data: { claimId: claim.id, source: 'UPLOADED', fileName: 'a.png', storagePath: `/x/${claim.id}/a.png`, documentTypeId: aadharType!.id } });

    const res = await service.evaluateForClaim(claim.id, adminId, 'ADMIN');
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.passedCount).toBe(2); // 1 doc (>=1) and Aadhar present
    const aadharRule = res!.rules.find((r) => r.name === 'has aadhar')!;
    expect(aadharRule.passed).toBe(true);
    expect(aadharRule.actual).toBe('present');
  });
});
```

- [ ] **Step 2: Run (expect fail)** — `cd server && npm test -- claimRuleService` → FAIL (module not found).

- [ ] **Step 3: Create `server/src/services/claimRuleService.ts`**

```ts
import { PrismaClient, Prisma, Status, ClaimRule, RuleField, RuleOperator, Role } from '@prisma/client';
import { ClaimFacts, evaluateRule, validOperatorsFor } from '../validators/ruleLogic.js';
import { ClaimService } from './claimService.js';

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
  }

  async create(input: CreateClaimRuleInput, actorId: string): Promise<ClaimRule> {
    this.validateRule(input.field, input.operator, input.value);
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
    return { rules: evaluated, passedCount: evaluated.filter((e) => e.passed).length, total: evaluated.length };
  }
}
```

- [ ] **Step 4: Run (expect pass)** — `cd server && npm test -- claimRuleService` → PASS.
- [ ] **Step 5: Commit** — `git add server/src/services/claimRuleService.ts server/src/services/__tests__/claimRuleService.test.ts && git commit -m "feat(claims): ClaimRuleService (CRUD + facts + evaluate)"`

### Task 4: Admin CRUD routes + live-eval route + mounts

**Files:** Create `server/src/routes/admin/claimRules.ts`; modify `server/src/routes/admin/index.ts`, `server/src/routes/claims.ts`

- [ ] **Step 1: Create `server/src/routes/admin/claimRules.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { ClaimRuleService, ClaimRuleServiceError } from '../../services/claimRuleService.js';

const router = Router();
const FIELDS = ['DOCUMENT_COUNT', 'REMARK_COUNT', 'ASSIGNED', 'HAS_DOCUMENT_TYPE', 'WORKFLOW_STATUS', 'SPELL_STATUS', 'QR_STATUS', 'META_STATUS', 'INTRA_STATUS', 'FULL_STATUS'];
const OPERATORS = ['EQ', 'NEQ', 'GTE', 'LTE', 'GT', 'LT'];

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR' });
  }
  next();
};
const getService = (req: Request) => new ClaimRuleService(req.app.get('prisma') as PrismaClient);

const handleErr = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof ClaimRuleServiceError) {
    return res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message, code: err.code });
  }
  next(err);
};

router.get(
  '/',
  [query('subCategoryId').optional().isUUID(), query('status').optional().isIn(['ACTIVE', 'INACTIVE']), query('page').optional().isInt({ min: 1 }).toInt(), query('limit').optional().isInt({ min: 1, max: 100 }).toInt()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({ data: r.data, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: Math.ceil(r.total / r.limit) } });
    } catch (err) { next(err); }
  }
);

router.post(
  '/',
  [body('subCategoryId').isUUID(), body('name').isString().trim().notEmpty().isLength({ max: 150 }), body('field').isIn(FIELDS), body('operator').isIn(OPERATORS), body('value').isString().trim().notEmpty().isLength({ max: 150 }), body('displayOrder').optional().isInt({ min: 0 })],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
      res.status(201).json({ data: created });
    } catch (err) { handleErr(err, res, next); }
  }
);

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await getService(req).getById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ data: r });
  } catch (err) { next(err); }
});

router.put(
  '/:id',
  [param('id').isUUID(), body('name').optional().isString().trim().notEmpty().isLength({ max: 150 }), body('field').optional().isIn(FIELDS), body('operator').optional().isIn(OPERATORS), body('value').optional().isString().trim().notEmpty().isLength({ max: 150 }), body('displayOrder').optional().isInt({ min: 0 }), body('status').optional().isIn(['ACTIVE', 'INACTIVE'])],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).update(req.params.id, req.body, req.session!.userId);
      res.json({ data: updated });
    } catch (err) { handleErr(err, res, next); }
  }
);

router.patch('/:id/status', [param('id').isUUID(), body('status').isIn(['ACTIVE', 'INACTIVE'])], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await getService(req).setStatus(req.params.id, req.body.status, req.session!.userId);
    res.json({ data: updated });
  } catch (err) { handleErr(err, res, next); }
});

router.delete('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await getService(req).delete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { handleErr(err, res, next); }
});

export default router;
```

- [ ] **Step 2: Mount in `server/src/routes/admin/index.ts`.** Add import near the others:

```ts
import claimRulesRoutes from './claimRules.js';
```

Add below the `router.use('/scans', scansRoutes);` line:

```ts
router.use('/claim-rules', claimRulesRoutes);
```

- [ ] **Step 3: Add the live-eval route to `server/src/routes/claims.ts`.** Add the import near the other service import:

```ts
import { ClaimRuleService } from '../services/claimRuleService.js';
```

Add this route immediately before `router.use('/:id/documents', claimDocumentsRoutes);`:

```ts
router.get(
  '/:id/rules',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await new ClaimRuleService(req.app.get('prisma') as PrismaClient).evaluateForClaim(
        req.params.id,
        req.session!.userId,
        req.session!.role
      );
      if (!result) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);
```

(`param`, `validate`, `Request/Response/NextFunction`, and `PrismaClient` are already imported in `claims.ts`.)

- [ ] **Step 4: Type-check + full tests + re-seed**

Run: `cd server && npx tsc --noEmit && npm test`
Then: `npm run db:seed` (repo root).
Expected: tsc clean; all suites pass; seed completes.

- [ ] **Step 5: Commit** — `git add server/src/routes/admin/claimRules.ts server/src/routes/admin/index.ts server/src/routes/claims.ts && git commit -m "feat(claims): claim-rules admin CRUD + live-eval route"`

---

## Phase B — Frontend

### Task 5: Admin "Claim Rules" page + route + sidebar

**Files:** Create `client/src/pages/admin/ClaimRules.tsx`; modify `client/src/App.tsx`, `client/src/components/layout/AdminLayout.tsx`

- [ ] **Step 1: Create `client/src/pages/admin/ClaimRules.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { SubCategoryPicker, SubCategoryPickerValue } from '@/components/shared/SubCategoryPicker';

type RuleField = 'DOCUMENT_COUNT' | 'REMARK_COUNT' | 'ASSIGNED' | 'HAS_DOCUMENT_TYPE' | 'WORKFLOW_STATUS' | 'SPELL_STATUS' | 'QR_STATUS' | 'META_STATUS' | 'INTRA_STATUS' | 'FULL_STATUS';
type RuleOperator = 'EQ' | 'NEQ' | 'GTE' | 'LTE' | 'GT' | 'LT';
interface Rule {
  id: string;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  status: 'ACTIVE' | 'INACTIVE';
}
const FIELD_LABELS: Record<RuleField, string> = {
  DOCUMENT_COUNT: 'Document Count', REMARK_COUNT: 'Remark Count', ASSIGNED: 'Assigned', HAS_DOCUMENT_TYPE: 'Has Document Type',
  WORKFLOW_STATUS: 'Workflow Status', SPELL_STATUS: 'Spell Check', QR_STATUS: 'QR Check', META_STATUS: 'Meta Extraction', INTRA_STATUS: 'Intra-Claim', FULL_STATUS: 'Full Scan',
};
const OP_LABELS: Record<RuleOperator, string> = { EQ: '=', NEQ: '≠', GTE: '≥', LTE: '≤', GT: '>', LT: '<' };
const NUMERIC_FIELDS: RuleField[] = ['DOCUMENT_COUNT', 'REMARK_COUNT'];
const STATUS_FIELDS: RuleField[] = ['SPELL_STATUS', 'QR_STATUS', 'META_STATUS', 'INTRA_STATUS', 'FULL_STATUS'];
const VALIDATION_VALUES = ['PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED'];
const opsFor = (f: RuleField): RuleOperator[] => (NUMERIC_FIELDS.includes(f) ? ['EQ', 'NEQ', 'GTE', 'LTE', 'GT', 'LT'] : ['EQ', 'NEQ']);

export default function ClaimRules() {
  const { toast } = useToast();
  const [data, setData] = useState<Rule[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<Rule | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [docTypeNames, setDocTypeNames] = useState<string[]>([]);
  const [statusNames, setStatusNames] = useState<string[]>([]);
  const [form, setForm] = useState<{ name: string; field: RuleField; operator: RuleOperator; value: string }>({ name: '', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '' });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = picker.subCategoryId
        ? `/admin/claim-rules?page=${page}&limit=${limit}&subCategoryId=${picker.subCategoryId}`
        : `/admin/claim-rules?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<Rule>>(url);
      setData(r.data);
      setPagination(r.pagination);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    if (picker.subCategoryId) {
      api.get<{ data: { name: string }[] }>(`/admin/document-type-masters?subCategoryId=${picker.subCategoryId}&limit=100`).then((r) => setDocTypeNames(r.data.map((d) => d.name))).catch(() => setDocTypeNames([]));
      api.get<{ data: { name: string }[] }>(`/admin/status-masters?subCategoryId=${picker.subCategoryId}&limit=100`).then((r) => setStatusNames(r.data.map((s) => s.name))).catch(() => setStatusNames([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker.subCategoryId]);

  const valueOptions = useMemo((): string[] | null => {
    if (form.field === 'ASSIGNED') return ['true', 'false'];
    if (form.field === 'HAS_DOCUMENT_TYPE') return docTypeNames;
    if (form.field === 'WORKFLOW_STATUS') return statusNames;
    if (STATUS_FIELDS.includes(form.field)) return VALIDATION_VALUES;
    return null; // numeric → free input
  }, [form.field, docTypeNames, statusNames]);

  const openAdd = () => {
    setSelected(null);
    setForm({ name: '', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '' });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!picker.subCategoryId) return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    if (!form.name.trim()) return toast({ title: 'Name required', variant: 'destructive' });
    if (!form.value.trim()) return toast({ title: 'Value required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      if (selected) {
        await api.put(`/admin/claim-rules/${selected.id}`, { name: form.name, field: form.field, operator: form.operator, value: form.value });
      } else {
        await api.post('/admin/claim-rules', { subCategoryId: picker.subCategoryId, name: form.name, field: form.field, operator: form.operator, value: form.value });
      }
      toast({ title: 'Saved' });
      setIsFormOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/claim-rules/${selected.id}`);
      toast({ title: 'Deleted' });
      setIsDeleteOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Delete failed' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (r: Rule) => {
    try {
      await api.patch(`/admin/claim-rules/${r.id}/status`, { status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' });
    }
  };

  const columns: ColumnDef<Rule>[] = [
    { accessorKey: 'name', header: 'Name' },
    { id: 'rule', header: 'Rule', cell: ({ row }) => `${FIELD_LABELS[row.original.field]} ${OP_LABELS[row.original.operator]} ${row.original.value}` },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge> },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setSelected(row.original); setForm({ name: row.original.name, field: row.original.field, operator: row.original.operator, value: row.original.value }); setIsFormOpen(true); }}>
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleToggle(row.original)}>
              {row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" /> Deactivate</> : <><Power className="mr-2 h-4 w-4" /> Activate</>}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => { setSelected(row.original); setIsDeleteOpen(true); }}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claim Rules</h1>
        <Button onClick={openAdd} disabled={!picker.subCategoryId}><Plus className="mr-2 h-4 w-4" /> Add Rule</Button>
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md">
        <SubCategoryPicker value={picker} onChange={setPicker} />
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(p) => fetchData(p, pagination.limit)} onPageSizeChange={(l) => fetchData(1, l)} isLoading={isLoading} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selected ? 'Edit Rule' : 'Add Rule'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Field</Label>
              <Select value={form.field} onValueChange={(v) => { const field = v as RuleField; const ops = opsFor(field); setForm({ ...form, field, operator: ops.includes(form.operator) ? form.operator : ops[0], value: '' }); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(FIELD_LABELS) as RuleField[]).map((f) => <SelectItem key={f} value={f}>{FIELD_LABELS[f]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Operator</Label>
              <Select value={form.operator} onValueChange={(v) => setForm({ ...form, operator: v as RuleOperator })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {opsFor(form.field).map((o) => <SelectItem key={o} value={o}>{OP_LABELS[o]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              {valueOptions ? (
                <Select value={form.value} onValueChange={(v) => setForm({ ...form, value: v })}>
                  <SelectTrigger><SelectValue placeholder="Select a value" /></SelectTrigger>
                  <SelectContent>
                    {valueOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete rule?" description="This cannot be undone." onConfirm={handleDelete} />
    </div>
  );
}
```

- [ ] **Step 2: Add the route in `client/src/App.tsx`.** Add the import next to the other admin page imports (near `ClaimIdRules`):

```tsx
import ClaimRules from '@/pages/admin/ClaimRules';
```

Add the route next to the other admin claim routes (after `<Route path="claim-id-rules" element={<ClaimIdRules />} />`):

```tsx
          <Route path="claim-rules" element={<ClaimRules />} />
```

- [ ] **Step 3: Add the sidebar item in `client/src/components/layout/AdminLayout.tsx`.** First add an icon to the lucide-react import (add `ShieldCheck`):

```tsx
import {
```
…ensure `ShieldCheck` is in the `lucide-react` import list (add it alongside `Crosshair`, `ClipboardList`).

Then add to the `claimsNavItems` array (after the `claim-id-rules` entry):

```tsx
  { path: '/admin/claim-rules', label: 'Claim Rules', icon: ShieldCheck },
```

- [ ] **Step 4: Type-check** — `cd client && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git add client/src/pages/admin/ClaimRules.tsx client/src/App.tsx client/src/components/layout/AdminLayout.tsx && git commit -m "feat(claims): Claim Rules admin page + route + sidebar"`

### Task 6: "Rules" section on Claim Update

**Files:** Modify `client/src/pages/claims/ClaimUpdate.tsx`

- [ ] **Step 1: Add a type** after the `ValRun` interface:

```tsx
interface RuleEval {
  id: string;
  name: string;
  field: string;
  operator: string;
  value: string;
  passed: boolean;
  actual: string;
}
const OP_SYMBOL: Record<string, string> = { EQ: '=', NEQ: '≠', GTE: '≥', LTE: '≤', GT: '>', LT: '<' };
```

- [ ] **Step 2: Add state + fetch** after the validation handlers (after `resultFor`):

```tsx
  const [rules, setRules] = useState<RuleEval[]>([]);
  const [rulesPassed, setRulesPassed] = useState({ passed: 0, total: 0 });

  const fetchRules = async () => {
    try {
      const r = await api.get<{ data: { rules: RuleEval[]; passedCount: number; total: number } }>(`/claims/${id}/rules`);
      setRules(r.data.rules);
      setRulesPassed({ passed: r.data.passedCount, total: r.data.total });
    } catch {
      /* none */
    }
  };

  useEffect(() => {
    if (claim) fetchRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id, valRun?.status]);
```

- [ ] **Step 3: Render the section.** Insert this block immediately before the "Documents" card (`<div className="bg-white border rounded-md p-6 mb-6">` that contains `<h2 ...>Documents</h2>`):

```tsx
      <div className="bg-white border rounded-md p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">
          Claim Rules{' '}
          {rules.length > 0 && (
            <span className="text-sm font-normal text-gray-500">
              ({rulesPassed.passed} of {rulesPassed.total} passed)
            </span>
          )}
        </h2>
        {rules.length === 0 ? (
          <p className="text-sm text-gray-400">No rules configured for this sub-category.</p>
        ) : (
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border rounded px-3 py-2">
                <span>
                  <span className="font-medium">{r.name}</span>{' '}
                  <span className="text-gray-500">
                    ({r.field} {OP_SYMBOL[r.operator] ?? r.operator} {r.value})
                  </span>
                </span>
                <span className={r.passed ? 'text-green-600' : 'text-destructive'}>
                  {r.passed ? '✓' : '✗'} {r.actual}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
```

- [ ] **Step 4: Type-check** — `cd client && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git add client/src/pages/claims/ClaimUpdate.tsx && git commit -m "feat(claims): Rules section on Claim Update page"`

---

## Phase C — Verification

### Task 7: End-to-end verification

- [ ] **Step 1: Backend green + re-seed** — `cd server && npx tsc --noEmit && npm test` then `npm run db:seed` (root). Expected: all suites pass (existing 82 + ruleLogic + claimRuleService); seed completes.
- [ ] **Step 2: Frontend green** — `cd client && npx tsc --noEmit` → clean.
- [ ] **Step 3: Manual smoke** — start dev (`CLAIMS_SCAN_ROOT`/`UPLOADS_ROOT` not needed for rules). As admin: Claims Config → **Claim Rules** → pick the seeded SubCategory → add `Document Count ≥ 1` and `Has Document Type = Aadhar Card`. Open a claim under that SubCategory → the **Claim Rules** section shows each rule ✅/❌ with the actual value and "N of M passed".
- [ ] **Step 4: Final status** — `git status` (clean if committing per task).

---

## Self-Review (completed during plan writing)

- **Spec coverage:** `ClaimRule` model + enums + relation (T1) ✓ · field vocabulary + operator validity + pure `evaluateRule` incl. HAS_DOCUMENT_TYPE presence, ASSIGNED bool, numeric-op-on-non-numeric→false (T2) ✓ · CRUD + `validateRule` (INVALID_RULE) + fact-gatherer + `evaluateForClaim` with scope via `ClaimService.getById` (T3) ✓ · admin CRUD routes + `/admin/claim-rules` mount + live-eval `GET /claims/:id/rules` (T4) ✓ · admin page with field→operator→value dynamic form + value dropdowns for enum-ish fields + App route + sidebar (T5) ✓ · Claim Update "Rules" section with ✅/❌ + N-of-M (T6) ✓ · live evaluation, no stored table ✓ · no new deps ✓.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `RuleField`/`RuleOperator` unions, `ClaimFacts`, `evaluateRule(rule, facts)`, `validOperatorsFor`, `ClaimRuleService` method names, `evaluateForClaim` return shape `{ rules, passedCount, total }`, and the client `Rule`/`RuleEval` + `FIELD_LABELS`/`OP_LABELS`/`opsFor` are consistent across tasks. The client `opsFor` mirrors the server `validOperatorsFor`.
- **Note:** the live-eval route reuses `ClaimService.getById` for scope, so a USER sees rules for any in-scope claim (read) — consistent with the rest of the claim read model.
