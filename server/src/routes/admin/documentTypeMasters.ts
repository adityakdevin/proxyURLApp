import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query } from 'express-validator';
import {
  DocumentTypeService,
  DocumentTypeServiceError,
} from '../../services/documentTypeService.js';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();

const getService = (req: Request) => new DocumentTypeService(prismaOf(req));
const GOVT_CODES = ['AADHAR', 'PAN', 'DL', 'PASSPORT', 'VOTER_ID', 'RATION_CARD'];

const handleErr = makeErrorHandler(DocumentTypeServiceError, {
  DUPLICATE_GOVT_CODE: 409,
  DUPLICATE_NAME: 409,
  NOT_FOUND: 404,
  SUBCATEGORY_NOT_FOUND: 404,
});

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('category').optional().isIn(['GOVT', 'CUSTOM']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        category: req.query.category as 'GOVT' | 'CUSTOM' | undefined,
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
    body('category').isIn(['GOVT', 'CUSTOM']),
    body('govtCode').optional({ nullable: true }).isIn(GOVT_CODES),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('isRequired').optional().isBoolean().toBoolean(),
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
      const d = await getService(req).getById(req.params.id);
      if (!d) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: d });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty(),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('isRequired').optional().isBoolean().toBoolean(),
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
