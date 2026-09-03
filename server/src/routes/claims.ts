import { Router, Request, Response, NextFunction } from 'express';
import { ClaimAuditAction, ClaimAuditTargeting } from '@prisma/client';
import { body, param, query } from 'express-validator';
import { adminMiddleware, authMiddleware, passwordChangedMiddleware } from '../middleware/auth.js';
import {
  scopedMiddleware,
  teamLeadOrAdminMiddleware,
  ScopedRequest,
} from '../middleware/roleGuard.js';
import { AppendRemarkInput, ClaimService, ClaimServiceError } from '../services/claimService.js';
import claimDocumentsRoutes from './claimDocuments.js';
import claimValidationRoutes from './claimValidation.js';
import { ClaimRuleService } from '../services/claimRuleService.js';
import { buildClaimsWorkbook } from '../services/claimReportService.js';
import { validate, prismaOf, makeErrorHandler } from '../lib/routeHelpers.js';
import { BulkTarget, recordClaimAudit, resolveTargets, runBulk } from '../lib/bulkClaims.js';
import { enqueue } from '../services/validationQueue.js';
import { registry } from '../validators/registry.js';

const router = Router();
router.use(authMiddleware);
router.use(passwordChangedMiddleware);
router.use(scopedMiddleware);

const getService = (req: Request) => new ClaimService(prismaOf(req));

const handleErr = makeErrorHandler(ClaimServiceError, {
  NOT_FOUND: 404,
  SUBCATEGORY_NOT_FOUND: 404,
  DUPLICATE_CLAIM_ID: 409,
  TERMINAL_STATUS: 409,
  REASSIGN_FORBIDDEN: 403,
  OUT_OF_SCOPE: 403,
});

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('assignedToMe').optional().isBoolean().toBoolean(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        // A regular USER may not filter by an arbitrary assignee; they use the
        // "assigned to me" toggle (spec §6.2). Only TL/ADMIN get the user filter.
        assignedToUserId:
          req.session!.role === 'USER'
            ? undefined
            : (req.query.assignedToUserId as string | undefined),
        assignedToMe: req.query.assignedToMe as unknown as boolean | undefined,
        search: req.query.search as string | undefined,
        scope: req.scope!,
        callerId: req.session!.userId,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({
        data: r.data,
        pagination: {
          page: r.page,
          limit: r.limit,
          total: r.total,
          totalPages: Math.ceil(r.total / r.limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/export',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('assignedToMe').optional().isBoolean().toBoolean(),
    query('search').optional().isString(),
  ],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const rows = await getService(req).exportRows({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        assignedToUserId:
          req.session!.role === 'USER'
            ? undefined
            : (req.query.assignedToUserId as string | undefined),
        assignedToMe: req.query.assignedToMe as unknown as boolean | undefined,
        search: req.query.search as string | undefined,
        scope: req.scope!,
        callerId: req.session!.userId,
      });
      const wb = buildClaimsWorkbook(rows);
      const buf = await wb.xlsx.writeBuffer();
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="claims-${date}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (err) {
      next(err);
    }
  }
);

// Shape checks for the two ways a bulk call names its targets. The resolver re-checks
// both, but a malformed body should be a 400 here rather than a per-claim "FAILED" later.
const bulkTargetValidators = [
  // No max here: the cap belongs to resolveTargets, which refuses with 422 BULK_TOO_LARGE
  // and names the number the caller actually sent. An isArray max would shadow that with a
  // bare 400 carrying no count.
  body('ids').optional().isArray(),
  body('ids.*').optional().isUUID(),
  body('filters').optional().isObject(),
  // Same value checks GET /claims runs on the same three fields. parseFilters type-checks
  // but never format-checks them, so the MUTATING path was validated more loosely than the
  // read path it mirrors; `search` in particular reached a leading-wildcard LIKE unbounded.
  body('filters.subCategoryId').optional().isUUID(),
  body('filters.workflowStatusId').optional().isUUID(),
  body('filters.assignedToUserId').optional().isUUID(),
  body('filters.search').optional().isString().isLength({ max: 200 }),
  // Lifecycle, not workflow status: only /bulk/restore has any use for INACTIVE, but the
  // shape check belongs with the others rather than in that one route.
  body('filters.status').optional().isIn(['ACTIVE', 'INACTIVE']),
];

// Bulk actions on a selection (or on everything matching the list filters). Registered
// BEFORE '/:id/...' so "bulk" is never read as a claim id. Every claim still goes through
// the same per-claim permission checks the single-claim routes use.
// Returns null ONLY when it has already answered the request. Callers must test for null
// explicitly, not for truthiness: an empty array is a legitimate result (the filters matched
// nothing) that has to flow through to a 200 with requested:0. The natural-looking tidy-up
// to `if (!ids?.length) return;` would return without ever sending a response, and hang.
const bulkTargets = async (req: ScopedRequest, res: Response): Promise<BulkTarget | null> => {
  const r = await resolveTargets(getService(req), req.body ?? {}, {
    scope: req.scope!,
    callerId: req.session!.userId,
    role: req.session!.role,
  });
  if (r.error) {
    res.status(r.error.status).json({ error: r.error.message, code: r.error.code });
    return null;
  }
  return { ids: r.ids, targeting: r.targeting, filters: r.filters };
};

/** Who is running this action, for the audit row.
 *  ponytail: `trust proxy` is NOT set on the app, so behind the IIS/ARR front end that
 *  docs/DEPLOYMENT.md describes this records the proxy's address, not the operator's. The
 *  userId is the field an investigation actually turns on; the IP is corroboration. Setting
 *  it app-wide is deliberately not done here — req.ip also feeds the login lockout and its
 *  progressive delay, so flipping it belongs in a change that can reason about those. */
const auditor = (req: ScopedRequest, action: ClaimAuditAction) => ({
  action,
  userId: req.session!.userId,
  ipAddress: req.ip,
});

router.post(
  '/bulk/validate',
  bulkTargetValidators,
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const target = await bulkTargets(req, res);
      if (target === null) return;
      const service = getService(req);
      const report = await runBulk(
        prismaOf(req),
        target,
        auditor(req, ClaimAuditAction.BULK_VALIDATE),
        async (id) => {
          const ok = await service.canEditClaim(id, req.session!.userId, req.session!.role);
          if (!ok) throw new ClaimServiceError('CLAIM_NOT_EDITABLE', 'Cannot edit this claim');
          await enqueue(prismaOf(req), registry, id, 'MANUAL', req.session!.userId);
        }
      );
      res.status(202).json({ data: report });
    } catch (err) {
      next(err);
    }
  }
);

// One endpoint for both "change status" and "reassign": a bulk remark is the single-claim
// remark applied N times, and that route already carries the status and assignee rules.
router.post(
  '/bulk/remarks',
  [
    ...bulkTargetValidators,
    body('remarkText')
      .isString()
      .trim()
      .notEmpty()
      // withMessage, because validate() surfaces only errors.array()[0].msg — the default
      // "Invalid value" named neither the field nor the limit, and both clients show it raw.
      .isLength({ max: 2000 })
      .withMessage('A remark is limited to 2000 characters'),
    body('newStatusId').optional().isUUID(),
    body('newAssigneeId').optional({ nullable: true }).isUUID(),
  ],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const target = await bulkTargets(req, res);
      if (target === null) return;
      const service = getService(req);
      const { remarkText, newStatusId, newAssigneeId } = req.body;
      const input: AppendRemarkInput = { remarkText };
      if (newStatusId) input.newStatusId = newStatusId;
      // Only forward a reassignment when one was actually sent — appendRemark treats the
      // KEY's presence as "reassign", so an absent field must stay absent.
      if (Object.prototype.hasOwnProperty.call(req.body, 'newAssigneeId')) {
        input.newAssigneeId = newAssigneeId;
      }
      const report = await runBulk(
        prismaOf(req),
        target,
        auditor(req, ClaimAuditAction.BULK_REMARK),
        async (id) => {
          const ok = await service.canEditClaim(id, req.session!.userId, req.session!.role);
          if (!ok) throw new ClaimServiceError('CLAIM_NOT_EDITABLE', 'Cannot edit this claim');
          await service.appendRemark(id, input, req.session!.userId, req.session!.role);
        }
      );
      res.json({ data: report });
    } catch (err) {
      next(err);
    }
  }
);

// Soft-delete stays admin-only, exactly like DELETE /admin/claims/:id — it lives here so
// all four bulk actions share one target-resolution path.
router.post(
  '/bulk/delete',
  adminMiddleware,
  bulkTargetValidators,
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const target = await bulkTargets(req, res);
      if (target === null) return;
      const service = getService(req);
      // No canEditClaim gate here, deliberately, and NOT an oversight: softDelete is
      // idempotent by design (already-INACTIVE returns untouched), which is what makes a
      // retry safe. Gating on canEditClaim — false for a non-ACTIVE claim — would report a
      // whole batch as failures when a reviewer retries after the 504 that TODOS.md P1 says
      // to expect on a 500-claim run, and would turn the specific NOT_FOUND a missing claim
      // reports today into a vaguer CLAIM_NOT_EDITABLE. The cost is that re-deleting an
      // already-deleted claim counts as a success; retry-safety is worth more than that
      // count. Admin-only is enforced by adminMiddleware above.
      const report = await runBulk(
        prismaOf(req),
        target,
        auditor(req, ClaimAuditAction.BULK_DELETE),
        (id) => service.softDelete(id, req.session!.userId)
      );
      res.json({ data: report });
    } catch (err) {
      next(err);
    }
  }
);

// The way back from a bulk delete. Admin-only for the same reason delete is: an INACTIVE
// claim is invisible to everyone else, so only the role that can hide one can bring it back.
router.post(
  '/bulk/restore',
  adminMiddleware,
  bulkTargetValidators,
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      // A restore aimed by filters is pinned to the deleted claims, whatever the caller
      // sent. Without this a client that forwards its list filters unchanged (which is what
      // the bulk bar does everywhere else) resolves the ACTIVE set instead — and because
      // restore is idempotent on an already-active claim, that answers "restored 133 of
      // 133" having changed nothing at all. The pinned value is what the audit row records.
      if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'ids') && req.body?.filters) {
        req.body.filters = { ...req.body.filters, status: 'INACTIVE' };
      }
      const target = await bulkTargets(req, res);
      if (target === null) return;
      const service = getService(req);
      // No canEditClaim gate, matching /bulk/delete: canEditClaim is false for exactly the
      // non-ACTIVE claims this route exists to act on, so gating on it would refuse every
      // legitimate target. restore() is idempotent on an already-ACTIVE claim.
      const report = await runBulk(
        prismaOf(req),
        target,
        auditor(req, ClaimAuditAction.BULK_RESTORE),
        (id) => service.restore(id, req.session!.userId)
      );
      res.json({ data: report });
    } catch (err) {
      next(err);
    }
  }
);

// Neighbours in the claim list, for the document viewer's step arrows — that window is
// opened by URL and so has no list state of its own to step through.
router.get(
  '/:id/adjacent',
  [param('id').isUUID()],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).adjacent(req.params.id, {
        scope: req.scope!,
        callerId: req.session!.userId,
      });
      if (!r) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: r });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await getService(req).getById(
        req.params.id,
        req.session!.userId,
        req.session!.role
      );
      if (!c) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: c });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/',
  teamLeadOrAdminMiddleware,
  [
    body('subCategoryId').isUUID(),
    body('claimId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('folderPath').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('assignedToUserId').optional({ nullable: true }).isUUID(),
    body('remarkText').optional().isString(),
  ],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId, req.scope);
      res.status(201).json({ data: created });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.post(
  '/:id/remarks',
  [
    param('id').isUUID(),
    body('remarkText')
      .isString()
      .trim()
      .notEmpty()
      // withMessage, because validate() surfaces only errors.array()[0].msg — the default
      // "Invalid value" named neither the field nor the limit, and both clients show it raw.
      .isLength({ max: 2000 })
      .withMessage('A remark is limited to 2000 characters'),
    body('newStatusId').optional().isUUID(),
    body('newAssigneeId').optional({ nullable: true }).isUUID(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getService(req);
      const allowed = await service.canEditClaim(
        req.params.id,
        req.session!.userId,
        req.session!.role
      );
      if (!allowed) {
        return res
          .status(403)
          .json({ error: 'Cannot edit this claim', code: 'CLAIM_NOT_EDITABLE' });
      }
      const updated = await service.appendRemark(
        req.params.id,
        req.body,
        req.session!.userId,
        req.session!.role
      );
      res.json({ data: updated });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.get(
  '/:id/remarks',
  [
    param('id').isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claim = await getService(req).getById(
        req.params.id,
        req.session!.userId,
        req.session!.role
      );
      if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      const r = await getService(req).listRemarks(
        req.params.id,
        req.query.page as unknown as number | undefined,
        req.query.limit as unknown as number | undefined
      );
      res.json({
        data: r.data,
        pagination: {
          page: r.page,
          limit: r.limit,
          total: r.total,
          totalPages: Math.ceil(r.total / r.limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id/rules',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await new ClaimRuleService(prismaOf(req)).evaluateForClaim(
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

router.use('/:id/documents', claimDocumentsRoutes);
router.use('/:id', claimValidationRoutes);

export default router;
