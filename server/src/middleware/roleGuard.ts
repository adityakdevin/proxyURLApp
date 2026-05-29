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
  scope?: { userTypeId: string; projectTypeId: string } | 'ALL';
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
  req.scope = { userTypeId: assignment.userTypeId, projectTypeId: assignment.projectTypeId };
  next();
};
