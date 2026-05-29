import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { authMiddleware, passwordChangedMiddleware } from '../middleware/auth.js';
import {
  scopedMiddleware,
  teamLeadOrAdminMiddleware,
  ScopedRequest,
} from '../middleware/roleGuard.js';
import { ClaimService, ClaimServiceError } from '../services/claimService.js';

const router = Router();
router.use(authMiddleware);
router.use(passwordChangedMiddleware);
router.use(scopedMiddleware);

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg,
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
  }
  next();
};
const getService = (req: Request) => new ClaimService(req.app.get('prisma') as PrismaClient);

const handleErr = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof ClaimServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'DUPLICATE_CLAIM_ID'
        ? 409
        : err.code === 'REASSIGN_FORBIDDEN'
        ? 403
        : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  next(err);
};

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
        assignedToUserId: req.query.assignedToUserId as string | undefined,
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
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

export default router;
