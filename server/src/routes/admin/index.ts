import { Router } from 'express';
import { authMiddleware, adminMiddleware, passwordChangedMiddleware } from '../../middleware/auth.js';
import projectsRoutes from './projects.js';
import usersRoutes from './users.js';
import categoriesRoutes from './categories.js';
import subCategoriesRoutes from './subCategories.js';
import urlConfigsRoutes from './urlConfigs.js';
import sessionsRoutes from './sessions.js';
import auditLogsRoutes from './auditLogs.js';
import settingsRoutes from './settings.js';
import profileRoutes from './profile.js';
import statusMastersRoutes from './statusMasters.js';
import documentTypeMastersRoutes from './documentTypeMasters.js';
import claimIdRulesRoutes from './claimIdRules.js';
import claimsRoutes from './claims.js';
import scansRoutes from './scans.js';
import claimRulesRoutes from './claimRules.js';
import spellTermsRoutes from './spellTerms.js';

const router = Router();

// All admin routes require authentication, admin role, and password changed
router.use(authMiddleware);
router.use(adminMiddleware);
router.use(passwordChangedMiddleware);

router.use('/projects', projectsRoutes);
router.use('/users', usersRoutes);
router.use('/categories', categoriesRoutes);
router.use('/sub-categories', subCategoriesRoutes);
router.use('/url-configs', urlConfigsRoutes);
router.use('/sessions', sessionsRoutes);
router.use('/audit-logs', auditLogsRoutes);
router.use('/settings', settingsRoutes);
router.use('/profile', profileRoutes);
router.use('/status-masters', statusMastersRoutes);
router.use('/document-type-masters', documentTypeMastersRoutes);
router.use('/claim-id-rules', claimIdRulesRoutes);
router.use('/claims', claimsRoutes);
router.use('/scans', scansRoutes);
router.use('/claim-rules', claimRulesRoutes);
router.use('/spell-terms', spellTermsRoutes);

export default router;
