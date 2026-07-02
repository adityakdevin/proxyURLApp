import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query } from 'express-validator';
import { hashPassword, validatePasswordPolicy } from '../../utils/password.js';
import { SessionService } from '../../services/sessionService.js';
import { validate, prismaOf, parsePagination, paginated } from '../../lib/routeHelpers.js';

const router = Router();

// Every assigned SubCategory must exist, be ACTIVE, and live under the given Project.
async function assertSubCategoriesInProject(
  prisma: PrismaClient,
  projectId: string,
  subCategoryIds: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const unique = [...new Set(subCategoryIds)];
  if (unique.length === 0) {
    return { ok: false, error: 'Select at least one sub-category' };
  }
  const found = await prisma.subCategory.findMany({
    where: { id: { in: unique }, status: 'ACTIVE', category: { projectId } },
    select: { id: true },
  });
  if (found.length !== unique.length) {
    return {
      ok: false,
      error: 'One or more sub-categories are invalid, inactive, or outside the selected Project',
    };
  }
  return { ok: true };
}

// Include block that returns a user's Project assignment + granular sub-category access.
const userAssignmentInclude = {
  assignments: {
    include: { project: { select: { id: true, name: true } } },
  },
  subCategoryAccess: {
    include: {
      subCategory: {
        select: {
          id: true,
          name: true,
          categoryId: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

// GET /api/admin/users
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('role').optional().isIn(['USER', 'TEAM_LEAD']),
    query('projectId').optional().isUUID(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['username', 'fullName', 'createdAt', 'status']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const { status, role, projectId, search, sortBy = 'username', sortOrder = 'asc' } =
        req.query;
      const { page, limit, skip, take } = parsePagination(req.query);

      const where: Record<string, unknown> = {
        role: { not: 'ADMIN' }, // Only non-admin users in this list
      };
      // A specific role narrows further (still non-admin: only USER / TEAM_LEAD are allowed).
      if (role) where.role = role;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { username: { contains: search as string } },
          { fullName: { contains: search as string } },
        ];
      }
      if (projectId) {
        where.assignments = {
          some: {
            projectId: projectId as string,
          },
        };
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take,
          orderBy: { [sortBy as string]: sortOrder },
          include: userAssignmentInclude,
          omit: { passwordHash: true },
        }),
        prisma.user.count({ where }),
      ]);

      res.json(paginated(users, total, page, limit));
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
    body('projectId').isUUID().withMessage('Valid Project is required'),
    body('subCategoryIds').isArray().withMessage('subCategoryIds must be an array'),
    body('subCategoryIds.*').isUUID().withMessage('Each sub-category id must be a UUID'),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('role').optional().isIn(['USER', 'TEAM_LEAD', 'ADMIN']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        username,
        password,
        fullName,
        projectId,
        subCategoryIds = [],
        status = 'ACTIVE',
        role = 'USER',
      } = req.body;

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

      // Verify Project exists and is active
      const project = await prisma.project.findUnique({ where: { id: projectId } });

      if (!project || project.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Invalid or inactive Project',
          code: 'INVALID_PROJECT',
        });
      }

      // Non-admin users must be granted at least one sub-category, all within the Project.
      if (role !== 'ADMIN') {
        const scopeCheck = await assertSubCategoriesInProject(prisma, projectId, subCategoryIds);
        if (!scopeCheck.ok) {
          return res.status(400).json({ error: scopeCheck.error, code: 'INVALID_SUBCATEGORIES' });
        }
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user with assignment + granular sub-category access. Admin role still
      // goes via this route but gets neither an assignment nor sub-category access.
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
          ...(role !== 'ADMIN' && {
            assignments: { create: { projectId } },
            subCategoryAccess: {
              create: [...new Set<string>(subCategoryIds)].map((subCategoryId) => ({
                subCategoryId,
              })),
            },
          }),
        },
        include: userAssignmentInclude,
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
        include: userAssignmentInclude,
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
    body('projectId').optional().isUUID(),
    body('subCategoryIds').optional().isArray(),
    body('subCategoryIds.*').optional().isUUID(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('role').optional().isIn(['USER', 'TEAM_LEAD', 'ADMIN']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const { username, password, fullName, projectId, subCategoryIds, status, role } = req.body;

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

      // Re-assignment: if the Project and/or sub-categories are being changed, the
      // whole scope is revalidated together (non-admin users only).
      const reassigning = projectId !== undefined || subCategoryIds !== undefined;
      const effectiveProjectId: string | undefined =
        projectId ?? existing.assignments[0]?.projectId;

      if (reassigning) {
        if (projectId) {
          const project = await prisma.project.findUnique({ where: { id: projectId } });
          if (!project || project.status !== 'ACTIVE') {
            return res
              .status(400)
              .json({ error: 'Invalid or inactive Project', code: 'INVALID_PROJECT' });
          }
        }
        if (!effectiveProjectId) {
          return res.status(400).json({ error: 'A Project is required', code: 'INVALID_PROJECT' });
        }
        if (!Array.isArray(subCategoryIds)) {
          return res.status(400).json({
            error: "subCategoryIds is required when changing a user's assignment",
            code: 'INVALID_SUBCATEGORIES',
          });
        }
        const scopeCheck = await assertSubCategoriesInProject(
          prisma,
          effectiveProjectId,
          subCategoryIds
        );
        if (!scopeCheck.ok) {
          return res.status(400).json({ error: scopeCheck.error, code: 'INVALID_SUBCATEGORIES' });
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

      // Update user base fields
      await prisma.user.update({
        where: { id },
        data: {
          ...(username && { username }),
          ...(passwordHash && { passwordHash, forcePasswordChange: true }),
          ...(fullName && { fullName }),
          ...(status && { status }),
          ...(role && { role }),
          updatedBy: req.session!.userId,
        },
      });

      // Persist re-assignment (Project + granular sub-category access) as a unit.
      if (reassigning && effectiveProjectId) {
        const currentAssignment = existing.assignments[0];
        if (currentAssignment) {
          await prisma.userAssignment.update({
            where: { id: currentAssignment.id },
            data: { projectId: effectiveProjectId },
          });
        } else {
          await prisma.userAssignment.create({
            data: { userId: id, projectId: effectiveProjectId },
          });
        }
        // Replace the sub-category set wholesale.
        await prisma.userSubCategory.deleteMany({ where: { userId: id } });
        if (Array.isArray(subCategoryIds) && subCategoryIds.length) {
          await prisma.userSubCategory.createMany({
            data: [...new Set<string>(subCategoryIds)].map((subCategoryId) => ({
              userId: id,
              subCategoryId,
            })),
          });
        }
      }

      const user = await prisma.user.findUnique({
        where: { id },
        include: userAssignmentInclude,
        omit: { passwordHash: true },
      });

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
          projectId: assignment?.projectId,
          impersonatedBy: req.session!.userId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
