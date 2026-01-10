import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { query, validationResult } from 'express-validator';

const router = Router();

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      code: 'VALIDATION_ERROR',
    });
  }
  next();
};

// GET /api/admin/audit-logs - Get audit logs with filters
router.get(
  '/',
  [
    query('userId').optional().isUUID(),
    query('userTypeId').optional().isUUID(),
    query('projectTypeId').optional().isUUID(),
    query('urlConfigId').optional().isUUID(),
    query('responseStatus').optional().isInt(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['accessedAt', 'durationMs', 'responseStatus']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        userId,
        userTypeId,
        projectTypeId,
        urlConfigId,
        responseStatus,
        startDate,
        endDate,
        page = '1',
        limit = '25',
        sortBy = 'accessedAt',
        sortOrder = 'desc',
      } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const skip = (pageNum - 1) * limitNum;

      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      if (userTypeId) where.userTypeId = userTypeId;
      if (projectTypeId) where.projectTypeId = projectTypeId;
      if (urlConfigId) where.urlConfigId = urlConfigId;
      if (responseStatus) where.responseStatus = parseInt(responseStatus as string, 10);

      if (startDate || endDate) {
        where.accessedAt = {};
        if (startDate) {
          (where.accessedAt as Record<string, unknown>).gte = new Date(startDate as string);
        }
        if (endDate) {
          (where.accessedAt as Record<string, unknown>).lte = new Date(endDate as string);
        }
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            user: { select: { id: true, username: true, fullName: true } },
            userType: { select: { id: true, name: true } },
            projectType: { select: { id: true, name: true } },
            urlConfig: { select: { id: true, label: true } },
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      res.json({
        data: logs.map((log) => ({
          id: log.id,
          user: log.user,
          userType: log.userType,
          projectType: log.projectType,
          urlConfig: log.urlConfig,
          targetUrl: log.targetUrl,
          requestMethod: log.requestMethod,
          responseStatus: log.responseStatus,
          durationMs: log.durationMs,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent,
          accessedAt: log.accessedAt,
        })),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
