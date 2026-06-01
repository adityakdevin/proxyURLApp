import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query } from 'express-validator';
import { authMiddleware, passwordChangedMiddleware } from '../middleware/auth.js';
import {
  scopedMiddleware,
  teamLeadOrAdminMiddleware,
  ScopedRequest,
} from '../middleware/roleGuard.js';
import { ClaimService, ClaimServiceError } from '../services/claimService.js';
import claimDocumentsRoutes from './claimDocuments.js';
import claimValidationRoutes from './claimValidation.js';
import { ClaimRuleService } from '../services/claimRuleService.js';
import { buildClaimsWorkbook } from '../services/claimReportService.js';
import { validate, prismaOf, makeErrorHandler } from '../lib/routeHelpers.js';

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
    body('remarkText').isString().trim().notEmpty(),
    body('newStatusId').optional().isUUID(),
    body('newAssigneeId')
      .optional({ nullable: true })
      .custom((v) => v === null || /^[0-9a-fA-F-]{36}$/.test(v)),
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
