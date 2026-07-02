import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

export const teamLeadOrAdminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.session) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.session.role !== 'TEAM_LEAD' && req.session.role !== 'ADMIN') {
    return res
      .status(403)
      .json({ error: 'Team Lead or Admin access required', code: 'TEAM_LEAD_OR_ADMIN_REQUIRED' });
  }
  next();
};

export interface ScopedRequest extends Request {
  scope?: { projectId: string; subCategoryIds: string[] } | 'ALL';
}

export const scopedMiddleware = async (
  req: ScopedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.session) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.session.role === 'ADMIN') {
    req.scope = 'ALL';
    return next();
  }
  const prisma = req.app.get('prisma') as PrismaClient;
  const assignment = await prisma.userAssignment.findUnique({
    where: { userId: req.session.userId },
  });
  if (!assignment) {
    return res.status(403).json({ error: 'No assignment found', code: 'NO_ASSIGNMENT' });
  }
  // Access is restricted to the specific sub-categories granted to this user.
  const access = await prisma.userSubCategory.findMany({
    where: { userId: req.session.userId },
    select: { subCategoryId: true },
  });
  req.scope = {
    projectId: assignment.projectId,
    subCategoryIds: access.map((a) => a.subCategoryId),
  };
  next();
};
