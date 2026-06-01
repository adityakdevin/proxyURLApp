import { Router, Request, Response, NextFunction } from 'express';
import { param, query } from 'express-validator';
import { ClaimService, ClaimServiceError } from '../../services/claimService.js';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();
const getService = (req: Request) => new ClaimService(prismaOf(req));
const handleErr = makeErrorHandler(ClaimServiceError, { NOT_FOUND: 404 });

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('search').optional().isString(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        assignedToUserId: req.query.assignedToUserId as string | undefined,
        search: req.query.search as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        scope: 'ALL',
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
      const c = await getService(req).getById(req.params.id, req.session!.userId, 'ADMIN');
      if (!c) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: c });
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
      await getService(req).softDelete(req.params.id, req.session!.userId);
      res.json({ message: 'Soft-deleted' });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

// Recover a soft-deleted claim (the only way back from INACTIVE).
router.post(
  '/:id/restore',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restored = await getService(req).restore(req.params.id, req.session!.userId);
      res.json({ data: restored });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

export default router;
