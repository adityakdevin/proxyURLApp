import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { param, validationResult } from 'express-validator';

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

// GET /api/admin/sessions - Get all active sessions
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;

    const sessions = await prisma.session.findMany({
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            isAdmin: true,
          },
        },
      },
      orderBy: { lastActivity: 'desc' },
    });

    res.json({
      data: sessions.map((session) => ({
        id: session.id,
        userId: session.userId,
        username: session.user.username,
        fullName: session.user.fullName,
        isAdmin: session.user.isAdmin,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        loginTime: session.createdAt,
        lastActivity: session.lastActivity,
        isImpersonation: !!session.impersonatedBy,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/sessions/:id - Terminate specific session
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const session = await prisma.session.findUnique({ where: { id } });

      if (!session) {
        return res.status(404).json({
          error: 'Session not found',
          code: 'NOT_FOUND',
        });
      }

      await prisma.session.delete({ where: { id } });

      res.json({ message: 'Session terminated successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/sessions/user/:userId - Terminate all sessions for a user
router.delete(
  '/user/:userId',
  [param('userId').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { userId } = req.params;

      const result = await prisma.session.deleteMany({
        where: { userId },
      });

      res.json({
        message: 'All sessions terminated successfully',
        count: result.count,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
