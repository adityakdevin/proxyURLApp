import { Router, Request, Response, NextFunction } from 'express';
import { param } from 'express-validator';
import { ClaimService } from '../services/claimService.js';
import { enqueue } from '../services/validationQueue.js';
import { registry } from '../validators/registry.js';
import { validate, prismaOf } from '../lib/routeHelpers.js';

const router = Router({ mergeParams: true });

const claimSvc = (req: Request) => new ClaimService(prismaOf(req));

const requireView = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const claim = await claimSvc(req).getById(req.params.id, req.session!.userId, req.session!.role);
    if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    next();
  } catch (err) {
    next(err);
  }
};

router.post('/validate', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await claimSvc(req).canEditClaim(req.params.id, req.session!.userId, req.session!.role);
    if (!ok) return res.status(403).json({ error: 'Cannot edit this claim', code: 'CLAIM_NOT_EDITABLE' });
    const run = await enqueue(prismaOf(req), registry, req.params.id, 'MANUAL', req.session!.userId);
    res.status(202).json({ data: { runId: run.id } });
  } catch (err) {
    next(err);
  }
});

router.get('/validation', [param('id').isUUID()], validate, requireView, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = prismaOf(req);
    const run = await prisma.validationRun.findFirst({
      where: { claimId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    const results = run
      ? await prisma.validationResult.findMany({
          where: { runId: run.id },
          include: { findings: true },
        })
      : [];
    res.json({ data: { run, results } });
  } catch (err) {
    next(err);
  }
});

router.get('/validation/:runId', [param('id').isUUID(), param('runId').isUUID()], validate, requireView, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = prismaOf(req);
    const run = await prisma.validationRun.findFirst({
      where: { id: req.params.runId, claimId: req.params.id },
    });
    if (!run) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const results = await prisma.validationResult.findMany({
      where: { runId: run.id },
      include: { findings: true },
    });
    res.json({ data: { run, results } });
  } catch (err) {
    next(err);
  }
});

export default router;
