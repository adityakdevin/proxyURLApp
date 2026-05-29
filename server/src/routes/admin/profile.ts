import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, validationResult } from 'express-validator';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../../utils/password.js';
import { SessionService } from '../../services/sessionService.js';

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

// GET /api/admin/profile - Get current admin's profile
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;

    const user = await prisma.user.findUnique({
      where: { id: req.session!.userId },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'NOT_FOUND',
      });
    }

    res.json({ data: user });
  } catch (error) {
    next(error);
  }
});

// PUT /api/admin/profile - Update admin's profile
router.put(
  '/',
  [
    body('fullName').optional().trim().notEmpty().withMessage('Full name cannot be empty'),
    body('currentPassword').optional().notEmpty().withMessage('Current password is required'),
    body('newPassword').optional().notEmpty().withMessage('New password is required'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { fullName, currentPassword, newPassword } = req.body;
      const userId = req.session!.userId;

      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      // Handle password change
      let passwordHash: string | undefined;
      if (currentPassword && newPassword) {
        // Verify current password
        const passwordValid = await verifyPassword(currentPassword, user.passwordHash);
        if (!passwordValid) {
          return res.status(400).json({
            error: 'Current password is incorrect',
            code: 'INVALID_PASSWORD',
          });
        }

        // Validate new password policy
        const validation = validatePasswordPolicy(newPassword);
        if (!validation.valid) {
          return res.status(400).json({
            error: validation.error,
            code: 'INVALID_PASSWORD',
          });
        }

        passwordHash = await hashPassword(newPassword);
      } else if (currentPassword || newPassword) {
        return res.status(400).json({
          error: 'Both current password and new password are required to change password',
          code: 'VALIDATION_ERROR',
        });
      }

      // Update profile
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          ...(fullName && { fullName }),
          ...(passwordHash && { passwordHash }),
        },
        select: {
          id: true,
          username: true,
          fullName: true,
          role: true,
        },
      });

      // If password changed, invalidate all sessions except current
      if (passwordHash) {
        const sessionService = new SessionService(prisma);
        await sessionService.deleteUserSessions(userId);

        // Return instruction to re-login
        return res.json({
          message: 'Profile updated. Please login again with your new password.',
          data: updatedUser,
          requireRelogin: true,
        });
      }

      res.json({
        message: 'Profile updated successfully',
        data: updatedUser,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
