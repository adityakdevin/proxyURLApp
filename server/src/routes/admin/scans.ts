import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { body, param, query } from 'express-validator';
import { ScanService, ScanServiceError } from '../../services/scanService.js';
import { FsDirectoryReader } from '../../services/fsDirectoryReader.js';
import { DocumentService } from '../../services/documentService.js';
import { FsFileSystemPort } from '../../services/fsFileSystemPort.js';
import { enqueue } from '../../services/validationQueue.js';
import { registry } from '../../validators/registry.js';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();

const getService = (req: Request) => {
  const prisma = prismaOf(req);
  return new ScanService(
    prisma,
    new FsDirectoryReader(),
    new DocumentService(prisma, new FsFileSystemPort()),
    (claimId, actorId) => {
      void enqueue(prisma, registry, claimId, 'AUTO', actorId).catch((e) =>
        console.error(`Auto-validation enqueue failed for claim ${claimId}:`, e)
      );
    }
  );
};

const handleErr = makeErrorHandler(ScanServiceError, {
  RULE_NOT_FOUND: 404,
  SCAN_IN_PROGRESS: 409,
});

router.post(
  '/',
  [body('claimIdRuleId').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const svc = getService(req);
      const job = await svc.enqueue(req.body.claimIdRuleId, req.session!.userId);
      // Fire-and-forget (progress polled via GET /scans/:id); log on late rejection.
      void svc.run(job.id).catch((e) => console.error(`Scan job ${job.id} failed:`, e));
      res.status(202).json({ data: { jobId: job.id } });
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
      const prisma = prismaOf(req);
      const job = await prisma.scanJob.findUnique({ where: { id: req.params.id } });
      if (!job) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: job });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('claimIdRuleId').optional().isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const page = (req.query.page as unknown as number) ?? 1;
      const limit = (req.query.limit as unknown as number) ?? 20;
      const where: Prisma.ScanJobWhereInput = {};
      if (req.query.subCategoryId) where.subCategoryId = req.query.subCategoryId as string;
      if (req.query.claimIdRuleId) where.claimIdRuleId = req.query.claimIdRuleId as string;
      const [data, total] = await Promise.all([
        prisma.scanJob.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.scanJob.count({ where }),
      ]);
      res.json({
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
