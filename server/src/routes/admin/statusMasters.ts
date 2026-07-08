import { Router, Request, Response, NextFunction } from 'express';
import {
  StatusMasterService,
  StatusMasterServiceError,
} from '../../services/statusMasterService.js';
import { body, param, query } from 'express-validator';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();

const getService = (req: Request) => new StatusMasterService(prismaOf(req));

const handleErr = makeErrorHandler(StatusMasterServiceError, {
  NOT_FOUND: 404,
  STATUS_IN_USE: 409,
  STATUS_IS_DEFAULT: 409,
  DUPLICATE_STATUS_NAME: 409,
});

router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getService(req).list({
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
