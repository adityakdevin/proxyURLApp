import { Router, Request, Response, NextFunction } from 'express';
import { query } from 'express-validator';
import { validate, prismaOf, parsePagination, paginated } from '../../lib/routeHelpers.js';

const router = Router();

// GET /api/admin/audit-logs - Get audit logs with filters
router.get(
  '/',
  [
    query('userId').optional().isUUID(),
    query('projectId').optional().isUUID(),
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
      const prisma = prismaOf(req);
      const {
        userId,
        projectId,
        urlConfigId,
        responseStatus,
        startDate,
        endDate,
        sortBy = 'accessedAt',
        sortOrder = 'desc',
      } = req.query;
      const { page, limit, skip, take } = parsePagination(req.query, 25);

      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      if (projectId) where.projectId = projectId;
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
          take,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            user: { select: { id: true, username: true, fullName: true } },
            project: { select: { id: true, name: true } },
            urlConfig: { select: { id: true, label: true } },
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      res.json(
        paginated(
          logs.map((log) => ({
            id: log.id,
            user: log.user,
            project: log.project,
            urlConfig: log.urlConfig,
            targetUrl: log.targetUrl,
            requestMethod: log.requestMethod,
            responseStatus: log.responseStatus,
            durationMs: log.durationMs,
            ipAddress: log.ipAddress,
            userAgent: log.userAgent,
            accessedAt: log.accessedAt,
          })),
          total,
          page,
          limit
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
