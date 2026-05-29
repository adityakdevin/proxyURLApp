import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, passwordChangedMiddleware } from '../middleware/auth.js';
import { AuditLogService } from '../services/auditLogService.js';

const router = Router();

// All user routes require authentication and password changed
router.use(authMiddleware);
router.use(passwordChangedMiddleware);

// GET /api/user/menu - Get dynamic menu for current user
router.get('/menu', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const userId = req.session!.userId;

    // Get user's assignment
    const assignment = await prisma.userAssignment.findUnique({
      where: { userId },
    });

    if (!assignment) {
      return res.json({
        data: {
          menu: [],
          userType: null,
          projectType: null,
        },
      });
    }

    // Get user type and project type names
    const [userType, projectType] = await Promise.all([
      prisma.userType.findUnique({
        where: { id: assignment.userTypeId },
        select: { id: true, name: true, status: true },
      }),
      prisma.projectType.findUnique({
        where: { id: assignment.projectTypeId },
        select: { id: true, name: true, status: true },
      }),
    ]);

    // Check if user type or project type is inactive
    if (!userType || userType.status !== 'ACTIVE' || !projectType || projectType.status !== 'ACTIVE') {
      return res.json({
        data: {
          menu: [],
          userType: userType ? { id: userType.id, name: userType.name } : null,
          projectType: projectType ? { id: projectType.id, name: projectType.name } : null,
          message: 'Your assigned user type or project type is currently inactive.',
        },
      });
    }

    // Get all active categories for this user type and project type
    const categories = await prisma.category.findMany({
      where: {
        userTypeId: assignment.userTypeId,
        projectTypeId: assignment.projectTypeId,
        status: 'ACTIVE',
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
      },
    });

    // Get all active sub-categories for these categories
    const categoryIds = categories.map((c) => c.id);
    const subCategories = await prisma.subCategory.findMany({
      where: {
        categoryId: { in: categoryIds },
        status: 'ACTIVE',
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        categoryId: true,
      },
    });

    // Get all active URL configurations for these sub-categories
    const subCategoryIds = subCategories.map((sc) => sc.id);
    const urlConfigs = await prisma.urlConfiguration.findMany({
      where: {
        subCategoryId: { in: subCategoryIds },
        userTypeId: assignment.userTypeId,
        projectTypeId: assignment.projectTypeId,
        status: 'ACTIVE',
      },
      orderBy: { label: 'asc' },
      select: {
        id: true,
        label: true,
        description: true,
        opaqueId: true,
        subCategoryId: true,
      },
    });

    // Build hierarchical menu structure
    const menu = categories.map((category) => {
      const categorySubCategories = subCategories.filter((sc) => sc.categoryId === category.id);

      return {
        id: category.id,
        name: category.name,
        description: category.description,
        subCategories: categorySubCategories.map((subCategory) => {
          const subCategoryUrls = urlConfigs.filter((url) => url.subCategoryId === subCategory.id);

          return {
            id: subCategory.id,
            name: subCategory.name,
            description: subCategory.description,
            urls: subCategoryUrls.map((url) => ({
              id: url.id,
              label: url.label,
              description: url.description,
              opaqueId: url.opaqueId,
            })),
          };
        }).filter((sc) => sc.urls.length > 0), // Only include sub-categories with URLs
      };
    }).filter((cat) => cat.subCategories.length > 0); // Only include categories with sub-categories

    res.json({
      data: {
        menu,
        userType: { id: userType.id, name: userType.name },
        projectType: { id: projectType.id, name: projectType.name },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/dashboard - Dashboard data (stats, frequent, recent)
router.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const auditLogService = new AuditLogService(prisma);
    const userId = req.session!.userId;

    // Get user's assignment
    const assignment = await prisma.userAssignment.findUnique({
      where: { userId },
      include: {
        userType: { select: { id: true, name: true, status: true } },
        projectType: { select: { id: true, name: true, status: true } },
      },
    });

    if (!assignment) {
      return res.json({
        data: {
          stats: {
            totalUrls: 0,
            userType: null,
            projectType: null,
          },
          frequentUrls: [],
          recentActivity: [],
        },
      });
    }

    // Check if user type and project type are active
    const isActive =
      assignment.userType.status === 'ACTIVE' && assignment.projectType.status === 'ACTIVE';

    // Get dashboard data in parallel
    const [totalUrls, frequentUrls, recentActivity] = await Promise.all([
      isActive
        ? auditLogService.getAccessibleUrlCount(assignment.userTypeId, assignment.projectTypeId)
        : 0,
      auditLogService.getFrequentUrls(userId, 5),
      auditLogService.getRecentActivity(userId, 5),
    ]);

    res.json({
      data: {
        stats: {
          totalUrls,
          userType: {
            id: assignment.userType.id,
            name: assignment.userType.name,
          },
          projectType: {
            id: assignment.projectType.id,
            name: assignment.projectType.name,
          },
        },
        frequentUrls,
        recentActivity,
        isActive,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/subcategory/:id - Get URLs for a specific sub-category
router.get('/subcategory/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const userId = req.session!.userId;
    const subCategoryId = req.params.id;

    // Get user's assignment
    const assignment = await prisma.userAssignment.findUnique({
      where: { userId },
    });

    if (!assignment) {
      return res.status(403).json({
        error: 'No assignment found',
        code: 'NO_ASSIGNMENT',
      });
    }

    // Get sub-category with its category
    const subCategory = await prisma.subCategory.findUnique({
      where: { id: subCategoryId },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            userTypeId: true,
            projectTypeId: true,
            status: true,
          },
        },
      },
    });

    if (!subCategory) {
      return res.status(404).json({
        error: 'Sub-category not found',
        code: 'NOT_FOUND',
      });
    }

    // Verify the sub-category belongs to user's assigned userType and projectType
    if (
      subCategory.category.userTypeId !== assignment.userTypeId ||
      subCategory.category.projectTypeId !== assignment.projectTypeId
    ) {
      return res.status(403).json({
        error: 'Access denied',
        code: 'ACCESS_DENIED',
      });
    }

    // Check if category and sub-category are active
    if (subCategory.category.status !== 'ACTIVE' || subCategory.status !== 'ACTIVE') {
      return res.status(403).json({
        error: 'This sub-category is not currently available',
        code: 'INACTIVE',
      });
    }

    // Get URLs for this sub-category
    const urls = await prisma.urlConfiguration.findMany({
      where: {
        subCategoryId: subCategoryId,
        userTypeId: assignment.userTypeId,
        projectTypeId: assignment.projectTypeId,
        status: 'ACTIVE',
      },
      orderBy: { label: 'asc' },
      select: {
        id: true,
        label: true,
        description: true,
        opaqueId: true,
      },
    });

    res.json({
      data: {
        subCategory: {
          id: subCategory.id,
          name: subCategory.name,
          description: subCategory.description,
        },
        category: {
          id: subCategory.category.id,
          name: subCategory.category.name,
        },
        urls,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/profile - Get current user's profile
router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const userId = req.session!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        createdAt: true,
        assignments: {
          include: {
            userType: { select: { id: true, name: true } },
            projectType: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'NOT_FOUND',
      });
    }

    const assignment = user.assignments[0];

    res.json({
      data: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        createdAt: user.createdAt,
        assignment: assignment
          ? {
              userType: assignment.userType,
              projectType: assignment.projectType,
            }
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/sub-categories - SubCategories visible to caller (used by Claim Dashboard filters + forms)
router.get('/sub-categories', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const userId = req.session!.userId;
    const role = req.session!.role;

    if (role === 'ADMIN') {
      const all = await prisma.subCategory.findMany({
        where: { status: 'ACTIVE' },
        include: {
          category: { select: { id: true, name: true, userTypeId: true, projectTypeId: true } },
        },
        orderBy: { name: 'asc' },
      });
      return res.json({ data: all });
    }

    const assignment = await prisma.userAssignment.findUnique({ where: { userId } });
    if (!assignment) return res.json({ data: [] });

    const list = await prisma.subCategory.findMany({
      where: {
        status: 'ACTIVE',
        category: {
          userTypeId: assignment.userTypeId,
          projectTypeId: assignment.projectTypeId,
          status: 'ACTIVE',
        },
      },
      include: { category: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: list });
  } catch (err) {
    next(err);
  }
});

// GET /api/user/status-masters?subCategoryId=...
router.get('/status-masters', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const subCategoryId = req.query.subCategoryId as string | undefined;
    if (!subCategoryId) {
      return res
        .status(400)
        .json({ error: 'subCategoryId required', code: 'VALIDATION_ERROR' });
    }
    const list = await prisma.statusMaster.findMany({
      where: { subCategoryId, status: 'ACTIVE' },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ data: list });
  } catch (err) {
    next(err);
  }
});

// GET /api/user/users-in-scope - TL/ADMIN only
router.get('/users-in-scope', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const role = req.session!.role;
    if (role !== 'TEAM_LEAD' && role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }
    if (role === 'ADMIN') {
      const all = await prisma.user.findMany({
        where: { status: 'ACTIVE', role: { not: 'ADMIN' } },
        select: { id: true, fullName: true, username: true },
        orderBy: { fullName: 'asc' },
      });
      return res.json({ data: all });
    }
    const assignment = await prisma.userAssignment.findUnique({
      where: { userId: req.session!.userId },
    });
    if (!assignment) return res.json({ data: [] });
    const list = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { not: 'ADMIN' },
        assignments: {
          some: {
            userTypeId: assignment.userTypeId,
            projectTypeId: assignment.projectTypeId,
          },
        },
      },
      select: { id: true, fullName: true, username: true },
      orderBy: { fullName: 'asc' },
    });
    res.json({ data: list });
  } catch (err) {
    next(err);
  }
});

export default router;
