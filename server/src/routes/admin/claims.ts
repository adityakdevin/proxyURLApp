import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { param, query, validationResult } from 'express-validator';
import { ClaimService } from '../../services/claimService.js';

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
const getService = (req: Request) => new ClaimService(req.app.get('prisma') as PrismaClient);

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('search').optional().isString(),
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
    const c = await getService(req).getById(req.params.id, req.session!.userId, 'ADMIN');
    if (!c) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ data: c });
  }
);

router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    await getService(req).softDelete(req.params.id, req.session!.userId);
    res.json({ message: 'Soft-deleted' });
  }
);

export default router;
