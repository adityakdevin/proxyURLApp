import { Router } from 'express';
import { authMiddleware, adminMiddleware, passwordChangedMiddleware } from '../../middleware/auth.js';
import userTypesRoutes from './userTypes.js';
import projectTypesRoutes from './projectTypes.js';
import usersRoutes from './users.js';
import categoriesRoutes from './categories.js';
import subCategoriesRoutes from './subCategories.js';
import urlConfigsRoutes from './urlConfigs.js';
import sessionsRoutes from './sessions.js';
import auditLogsRoutes from './auditLogs.js';
import settingsRoutes from './settings.js';
import profileRoutes from './profile.js';
import statusMastersRoutes from './statusMasters.js';

const router = Router();

// All admin routes require authentication, admin role, and password changed
router.use(authMiddleware);
router.use(adminMiddleware);
router.use(passwordChangedMiddleware);

router.use('/user-types', userTypesRoutes);
router.use('/project-types', projectTypesRoutes);
router.use('/users', usersRoutes);
router.use('/categories', categoriesRoutes);
router.use('/sub-categories', subCategoriesRoutes);
router.use('/url-configs', urlConfigsRoutes);
router.use('/sessions', sessionsRoutes);
router.use('/audit-logs', auditLogsRoutes);
router.use('/settings', settingsRoutes);
router.use('/profile', profileRoutes);
router.use('/status-masters', statusMastersRoutes);

export default router;
