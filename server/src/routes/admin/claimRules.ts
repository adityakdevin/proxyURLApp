import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query } from 'express-validator';
import { ClaimRuleService, ClaimRuleServiceError } from '../../services/claimRuleService.js';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();
const FIELDS = ['DOCUMENT_COUNT', 'REMARK_COUNT', 'ASSIGNED', 'HAS_DOCUMENT_TYPE', 'WORKFLOW_STATUS', 'SPELL_STATUS', 'QR_STATUS', 'META_STATUS', 'INTRA_STATUS', 'FULL_STATUS'];
const OPERATORS = ['EQ', 'NEQ', 'GTE', 'LTE', 'GT', 'LT'];

const getService = (req: Request) => new ClaimRuleService(prismaOf(req));

const handleErr = makeErrorHandler(ClaimRuleServiceError, {
  NOT_FOUND: 404,
  DUPLICATE_RULE_NAME: 409,
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
      const r = await getService(req).list({
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({
        data: r.data,
        pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: Math.ceil(r.total / r.limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/',
  [
    body('name').isString().trim().notEmpty().isLength({ max: 150 }),
    body('field').isIn(FIELDS),
    body('operator').isIn(OPERATORS),
    body('value').isString().trim().notEmpty().isLength({ max: 150 }),
    body('displayOrder').optional().isInt({ min: 0 }),
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

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await getService(req).getById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ data: r });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 150 }),
    body('field').optional().isIn(FIELDS),
    body('operator').optional().isIn(OPERATORS),
    body('value').optional().isString().trim().notEmpty().isLength({ max: 150 }),
    body('displayOrder').optional().isInt({ min: 0 }),
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

router.patch('/:id/status', [param('id').isUUID(), body('status').isIn(['ACTIVE', 'INACTIVE'])], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await getService(req).setStatus(req.params.id, req.body.status, req.session!.userId);
    res.json({ data: updated });
  } catch (err) {
    handleErr(err, res, next);
  }
});

router.delete('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await getService(req).delete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    handleErr(err, res, next);
  }
});

export default router;
