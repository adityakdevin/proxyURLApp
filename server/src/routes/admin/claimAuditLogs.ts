import { Router, Request, Response, NextFunction } from 'express';
import { ClaimAuditAction, Prisma } from '@prisma/client';
import { query } from 'express-validator';
import { validate, prismaOf, parsePagination, paginated } from '../../lib/routeHelpers.js';

const router = Router();

/**
 * GET /api/admin/claim-audit-logs — who ran which claim lifecycle action, and on what.
 *
 * Read-only and admin-only. There is no write endpoint: rows come from runBulk and the
 * single-claim delete/restore routes, and an audit trail an operator can edit is not one.
 */
router.get(
  '/',
  [
    query('userId').optional().isUUID(),
    query('action').optional().isIn(Object.values(ClaimAuditAction)),
    // The question this table exists to answer is "who touched this claim", so it is
    // searchable by claim id — a JSON containment test against the recorded target list.
    query('claimId').optional().isUUID(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const { userId, action, claimId, startDate, endDate, sortOrder = 'desc' } = req.query;
      const { page, limit, skip, take } = parsePagination(req.query, 25);

      const where: Prisma.ClaimAuditLogWhereInput = {};
      if (userId) where.userId = userId as string;
      if (action) where.action = action as ClaimAuditAction;
      if (claimId) {
        // Lowercased to match what resolveTargets stored: it lowercases every incoming id
        // before acting, and this is an exact JSON array-element match, not a LIKE.
        where.claimIds = { array_contains: (claimId as string).toLowerCase() };
      }
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = new Date(startDate as string);
        // A date with no time means the WHOLE of that day. `new Date('2026-09-03')` is
        // midnight UTC, so an `lte` on it excluded everything that happened on the 3rd —
        // filtering "up to today" returned nothing from today and read as "nobody did
        // anything". A caller who sends an explicit time is taken at their word.
        if (endDate) {
          const end = new Date(endDate as string);
          if (!/[T\s]\d{2}:/.test(endDate as string)) end.setUTCHours(23, 59, 59, 999);
          where.createdAt.lte = end;
        }
      }

      const [logs, total] = await Promise.all([
        prisma.claimAuditLog.findMany({
          where,
          skip,
          take,
          // `id` breaks a createdAt tie. Offset pagination over an unstable order can show
          // one row twice and skip another between pages, and ties are the NORM here: a
          // bulk action and its neighbours land in the same second, which is exactly when
          // an investigation is reading.
          orderBy: [{ createdAt: sortOrder as 'asc' | 'desc' }, { id: sortOrder as 'asc' | 'desc' }],
          include: { user: { select: { id: true, username: true, fullName: true } } },
        }),
        prisma.claimAuditLog.count({ where }),
      ]);

      res.json(
        paginated(
          logs.map((log) => ({
            id: log.id,
            user: log.user,
            action: log.action,
            targeting: log.targeting,
            filters: log.filters,
            claimIds: log.claimIds,
            failures: log.failures,
            requested: log.requested,
            succeeded: log.succeeded,
            failed: log.failed,
            ipAddress: log.ipAddress,
            createdAt: log.createdAt,
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
