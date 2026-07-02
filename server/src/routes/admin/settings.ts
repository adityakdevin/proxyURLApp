import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body } from 'express-validator';
import { validate } from '../../lib/routeHelpers.js';

const router = Router();

// GET /api/admin/settings - Get all settings
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;

    const settings = await prisma.setting.findMany();

    // Convert to key-value object
    const settingsObj = settings.reduce(
      (acc, setting) => {
        acc[setting.key] = setting.value;
        return acc;
      },
      {} as Record<string, string>
    );

    res.json({
      data: settingsObj,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/admin/settings - Update settings
router.put(
  '/',
  [
    body('audit_retention_days')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Audit retention must be between 1 and 365 days'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { audit_retention_days } = req.body;

      const updates: Promise<{ id: string; key: string; value: string }>[] = [];

      if (audit_retention_days !== undefined) {
        updates.push(
          prisma.setting.upsert({
            where: { key: 'audit_retention_days' },
            update: { value: String(audit_retention_days) },
            create: { key: 'audit_retention_days', value: String(audit_retention_days) },
          })
        );
      }

      await Promise.all(updates);

      // Return updated settings
      const settings = await prisma.setting.findMany();
      const settingsObj = settings.reduce(
        (acc, setting) => {
          acc[setting.key] = setting.value;
          return acc;
        },
        {} as Record<string, string>
      );

      res.json({
        message: 'Settings updated successfully',
        data: settingsObj,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
