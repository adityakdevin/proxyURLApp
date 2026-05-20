import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import {
  ClaimIdRuleService,
  ClaimIdRuleServiceError,
} from '../../services/claimIdRuleService.js';

const router = Router();
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
const getService = (req: Request) =>
  new ClaimIdRuleService(req.app.get('prisma') as PrismaClient);

const handleErr = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof ClaimIdRuleServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404 : err.code === 'RULE_EXISTS' ? 409 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  next(err);
};

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
    const r = await getService(req).getById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ data: r });
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
    const updated = await getService(req).setStatus(
      req.params.id,
      req.body.status,
      req.session!.userId
    );
    res.json({ data: updated });
  }
);

router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    await getService(req).delete(req.params.id);
    res.json({ message: 'Deleted' });
  }
);

export default router;
