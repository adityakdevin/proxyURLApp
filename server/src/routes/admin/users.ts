import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { hashPassword, validatePasswordPolicy } from '../../utils/password.js';
import { SessionService } from '../../services/sessionService.js';

const router = Router();

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

// GET /api/admin/users
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('userTypeId').optional().isUUID(),
    query('projectTypeId').optional().isUUID(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['username', 'fullName', 'createdAt', 'status']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        status,
        userTypeId,
        projectTypeId,
        search,
        page = '1',
        limit = '10',
        sortBy = 'username',
        sortOrder = 'asc',
      } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const skip = (pageNum - 1) * limitNum;

      const where: Record<string, unknown> = {
        role: { not: 'ADMIN' }, // Only non-admin users in this list
      };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { username: { contains: search as string, mode: 'insensitive' } },
          { fullName: { contains: search as string, mode: 'insensitive' } },
        ];
      }
      if (userTypeId || projectTypeId) {
        where.assignments = {
          some: {
            ...(userTypeId && { userTypeId: userTypeId as string }),
            ...(projectTypeId && { projectTypeId: projectTypeId as string }),
          },
        };
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            assignments: {
              include: {
                userType: { select: { id: true, name: true } },
                projectType: { select: { id: true, name: true } },
              },
            },
          },
          omit: { passwordHash: true },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({
        data: users,
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

// POST /api/admin/users
router.post(
  '/',
  [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('userTypeId').isUUID().withMessage('Valid User Type is required'),
    body('projectTypeId').isUUID().withMessage('Valid Project Type is required'),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('role').optional().isIn(['USER', 'TEAM_LEAD', 'ADMIN']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { username, password, fullName, userTypeId, projectTypeId, status = 'ACTIVE', role = 'USER' } = req.body;

      // Validate password policy
      const passwordValidation = validatePasswordPolicy(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          error: passwordValidation.error,
          code: 'INVALID_PASSWORD',
        });
      }

      // Check for duplicate username
      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing) {
        return res.status(409).json({
          error: 'A user with this username already exists',
          code: 'DUPLICATE_USERNAME',
        });
      }

      // Verify User Type and Project Type exist and are active
      const [userType, projectType] = await Promise.all([
        prisma.userType.findUnique({ where: { id: userTypeId } }),
        prisma.projectType.findUnique({ where: { id: projectTypeId } }),
      ]);

      if (!userType || userType.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Invalid or inactive User Type',
          code: 'INVALID_USER_TYPE',
        });
      }

      if (!projectType || projectType.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Invalid or inactive Project Type',
          code: 'INVALID_PROJECT_TYPE',
        });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user with assignment. Admin role still goes via this route but does
      // not get a UserAssignment (we skip the assignment for ADMIN).
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash,
          fullName,
          role,
          status,
          forcePasswordChange: true,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
          assignments: {
            create: {
              userTypeId,
              projectTypeId,
            },
          },
        },
        include: {
          assignments: {
            include: {
              userType: { select: { id: true, name: true } },
              projectType: { select: { id: true, name: true } },
            },
          },
        },
        omit: { passwordHash: true },
      });

      res.status(201).json(user);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/admin/users/:id
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          assignments: {
            include: {
              userType: { select: { id: true, name: true } },
              projectType: { select: { id: true, name: true } },
            },
          },
        },
        omit: { passwordHash: true },
      });

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(user);
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/admin/users/:id
router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('username').optional().trim().notEmpty(),
    body('password').optional().notEmpty(),
    body('fullName').optional().trim().notEmpty(),
    body('userTypeId').optional().isUUID(),
    body('projectTypeId').optional().isUUID(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('role').optional().isIn(['USER', 'TEAM_LEAD', 'ADMIN']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const { username, password, fullName, userTypeId, projectTypeId, status, role } = req.body;

      const existing = await prisma.user.findUnique({
        where: { id },
        include: { assignments: true },
      });

      if (!existing) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      // Cannot edit admin users through this endpoint (admin self-service is via /admin/profile)
      if (existing.role === 'ADMIN') {
        return res.status(403).json({
          error: 'Cannot edit admin users',
          code: 'FORBIDDEN',
        });
      }

      // Check for duplicate username
      if (username && username !== existing.username) {
        const duplicate = await prisma.user.findUnique({ where: { username } });
        if (duplicate) {
          return res.status(409).json({
            error: 'A user with this username already exists',
            code: 'DUPLICATE_USERNAME',
          });
        }
      }

      // Validate password if provided
      let passwordHash: string | undefined;
      if (password) {
        const passwordValidation = validatePasswordPolicy(password);
        if (!passwordValidation.valid) {
          return res.status(400).json({
            error: passwordValidation.error,
            code: 'INVALID_PASSWORD',
          });
        }
        passwordHash = await hashPassword(password);
      }

      // Verify User Type and Project Type if provided
      if (userTypeId) {
        const userType = await prisma.userType.findUnique({ where: { id: userTypeId } });
        if (!userType || userType.status !== 'ACTIVE') {
          return res.status(400).json({
            error: 'Invalid or inactive User Type',
            code: 'INVALID_USER_TYPE',
          });
        }
      }

      if (projectTypeId) {
        const projectType = await prisma.projectType.findUnique({ where: { id: projectTypeId } });
        if (!projectType || projectType.status !== 'ACTIVE') {
          return res.status(400).json({
            error: 'Invalid or inactive Project Type',
            code: 'INVALID_PROJECT_TYPE',
          });
        }
      }

      const sessionService = new SessionService(prisma);

      // Handle status change - terminate sessions if deactivating
      if (status === 'INACTIVE' && existing.status === 'ACTIVE') {
        await sessionService.deleteUserSessions(id);
      }

      // Handle password change - terminate sessions and set force change flag
      if (passwordHash) {
        await sessionService.deleteUserSessions(id);
      }

      // Update user
      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(username && { username }),
          ...(passwordHash && { passwordHash, forcePasswordChange: true }),
          ...(fullName && { fullName }),
          ...(status && { status }),
          ...(role && { role }),
          updatedBy: req.session!.userId,
        },
        include: {
          assignments: {
            include: {
              userType: { select: { id: true, name: true } },
              projectType: { select: { id: true, name: true } },
            },
          },
        },
        omit: { passwordHash: true },
      });

      // Update assignment if User Type or Project Type changed
      if (userTypeId || projectTypeId) {
        const currentAssignment = existing.assignments[0];
        if (currentAssignment) {
          await prisma.userAssignment.update({
            where: { id: currentAssignment.id },
            data: {
              ...(userTypeId && { userTypeId }),
              ...(projectTypeId && { projectTypeId }),
            },
          });
        }
      }

      res.json(user);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/users/:id
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const existing = await prisma.user.findUnique({ where: { id } });

      if (!existing) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      // Cannot delete admin users through this endpoint
      if (existing.role === 'ADMIN') {
        return res.status(403).json({
          error: 'Cannot delete admin users',
          code: 'FORBIDDEN',
        });
      }

      // Delete user (cascades to assignments, sessions, and audit logs)
      await prisma.user.delete({ where: { id } });

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/admin/users/:id/impersonate
router.post(
  '/:id/impersonate',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
        include: { assignments: true },
      });

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      if (user.role === 'ADMIN') {
        return res.status(403).json({
          error: 'Cannot impersonate admin users',
          code: 'FORBIDDEN',
        });
      }

      if (user.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Cannot impersonate inactive users',
          code: 'USER_INACTIVE',
        });
      }

      const sessionService = new SessionService(prisma);
      const ipAddress = req.ip || req.socket.remoteAddress;
      const userAgent = req.get('User-Agent');

      // Create impersonation session
      const session = await sessionService.createSession(
        user.id,
        ipAddress,
        userAgent,
        req.session!.userId // impersonatedBy
      );

      const assignment = user.assignments[0];

      // Import setSessionCookie
      const { setSessionCookie } = await import('../../middleware/auth.js');
      setSessionCookie(res, session.sessionToken);

      res.json({
        message: 'Impersonation started',
        user: {
          userId: user.id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
          forcePasswordChange: user.forcePasswordChange,
          userTypeId: assignment?.userTypeId,
          projectTypeId: assignment?.projectTypeId,
          impersonatedBy: req.session!.userId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
