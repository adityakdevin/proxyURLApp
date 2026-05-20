import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/authService.js';
import {
  authMiddleware,
  setSessionCookie,
  clearSessionCookie,
} from '../middleware/auth.js';

const router = Router();

// Validation middleware helper
const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
  }
  next();
};

// POST /api/auth/login
router.post(
  '/login',
  [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const authService = new AuthService(prisma);

      const { username, password } = req.body;
      const ipAddress = req.ip || req.socket.remoteAddress;
      const userAgent = req.get('User-Agent');

      const result = await authService.login(username, password, ipAddress, userAgent);

      if (!result.success) {
        const status = result.retryAfter ? 429 : 401;
        return res.status(status).json({
          error: result.error,
          code: result.retryAfter ? 'RATE_LIMITED' : 'LOGIN_FAILED',
          retryAfter: result.retryAfter,
        });
      }

      // Set session cookie
      setSessionCookie(res, result.sessionToken!);

      res.json({
        message: 'Login successful',
        user: result.user,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/auth/logout
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const authService = new AuthService(prisma);

    const sessionToken = req.cookies['proxy_session'];
    if (sessionToken) {
      await authService.logout(sessionToken);
    }

    clearSessionCookie(res);

    res.json({ message: 'Logout successful' });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/change-password
router.post(
  '/change-password',
  authMiddleware,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('Password must contain uppercase, lowercase, and number'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const authService = new AuthService(prisma);

      const { currentPassword, newPassword } = req.body;
      const userId = req.session!.userId;

      const result = await authService.changePassword(userId, currentPassword, newPassword);

      if (!result.success) {
        return res.status(400).json({
          error: result.error,
          code: 'PASSWORD_CHANGE_FAILED',
        });
      }

      // Clear session cookie - user must re-login
      clearSessionCookie(res);

      res.json({
        message: 'Password changed successfully. Please login again.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/auth/me - Get current user
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  res.json({
    user: req.session,
  });
});

// POST /api/auth/exit-impersonation - End impersonation and restore admin session
router.post('/exit-impersonation', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const authService = new AuthService(prisma);

    const impersonatedBy = req.session?.impersonatedBy;

    if (!impersonatedBy) {
      return res.status(400).json({
        error: 'Not currently impersonating',
        code: 'NOT_IMPERSONATING',
      });
    }

    // Delete current impersonation session
    const sessionToken = req.cookies['proxy_session'];
    if (sessionToken) {
      await authService.logout(sessionToken);
    }

    // Get the original admin user
    const adminUser = await prisma.user.findUnique({
      where: { id: impersonatedBy },
    });

    if (!adminUser || adminUser.role !== 'ADMIN' || adminUser.status !== 'ACTIVE') {
      clearSessionCookie(res);
      return res.status(401).json({
        error: 'Admin session no longer valid',
        code: 'ADMIN_SESSION_INVALID',
      });
    }

    // Create new admin session
    const ipAddress = req.ip || req.socket.remoteAddress;
    const userAgent = req.get('User-Agent');

    const session = await prisma.session.create({
      data: {
        userId: adminUser.id,
        sessionToken: require('crypto').randomBytes(32).toString('hex'),
        ipAddress,
        userAgent,
        lastActivity: new Date(),
      },
    });

    setSessionCookie(res, session.sessionToken);

    res.json({
      message: 'Impersonation ended',
      user: {
        userId: adminUser.id,
        username: adminUser.username,
        fullName: adminUser.fullName,
        role: adminUser.role,
        forcePasswordChange: adminUser.forcePasswordChange,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
