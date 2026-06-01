import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query } from 'express-validator';
import {
  ClaimIdRuleService,
  ClaimIdRuleServiceError,
} from '../../services/claimIdRuleService.js';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();
const getService = (req: Request) => new ClaimIdRuleService(prismaOf(req));

const handleErr = makeErrorHandler(ClaimIdRuleServiceError, {
  NOT_FOUND: 404,
  SUBCATEGORY_NOT_FOUND: 404,
  RULE_EXISTS: 409,
  SCAN_IN_PROGRESS: 409,
});

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
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

router.post(
  '/',
  [
    body('subCategoryId').isUUID(),
    body('startPosition').isInt({ min: 1 }),
    body('length').isInt({ min: 1 }),
    body('scanTarget').isIn(['FOLDER', 'FILE']),
    body('scanLocation').isString().isLength({ max: 500 }),
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

router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).getById(req.params.id);
      if (!r) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: r });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('startPosition').optional().isInt({ min: 1 }),
    body('length').optional().isInt({ min: 1 }),
    body('scanTarget').optional().isIn(['FOLDER', 'FILE']),
    body('scanLocation').optional().isString().isLength({ max: 500 }),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).update(req.params.id, req.body, req.session!.userId);
      res.json({ data: updated });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.patch(
  '/:id/status',
  [param('id').isUUID(), body('status').isIn(['ACTIVE', 'INACTIVE'])],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).setStatus(
        req.params.id,
        req.body.status,
        req.session!.userId
      );
      res.json({ data: updated });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await getService(req).delete(req.params.id);
      res.json({ message: 'Deleted' });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

export default router;
