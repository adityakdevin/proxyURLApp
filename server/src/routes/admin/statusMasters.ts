import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import {
  StatusMasterService,
  StatusMasterServiceError,
} from '../../services/statusMasterService.js';

const router = Router();

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
  }
  next();
};

const getService = (req: Request) =>
  new StatusMasterService(req.app.get('prisma') as PrismaClient);

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
      const result = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({
        data: result.data,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: Math.ceil(result.total / result.limit),
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
    body('name').isString().trim().notEmpty().isLength({ max: 100 }),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('isDefault').optional().isBoolean(),
    body('isTerminal').optional().isBoolean(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
      res.status(201).json({ data: created });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return res.status(409).json({
          error: 'Status name must be unique per SubCategory',
          code: 'DUPLICATE_STATUS_NAME',
        });
      }
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
      const s = await getService(req).getById(req.params.id);
      if (!s) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: s });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 100 }),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('isDefault').optional().isBoolean(),
    body('isTerminal').optional().isBoolean(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).update(req.params.id, req.body, req.session!.userId);
      res.json({ data: updated });
    } catch (err) {
      if (err instanceof StatusMasterServiceError) {
        return res
          .status(err.code === 'NOT_FOUND' ? 404 : 400)
          .json({ error: err.message, code: err.code });
      }
      next(err);
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
      next(err);
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
      if (err instanceof StatusMasterServiceError) {
        return res
          .status(err.code === 'STATUS_IN_USE' ? 409 : 400)
          .json({ error: err.message, code: err.code });
      }
      next(err);
    }
  }
);

export default router;
