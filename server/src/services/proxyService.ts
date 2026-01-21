import { PrismaClient, ProxyMode, AuditLevel } from '@prisma/client';

export interface UrlAccessResult {
  authorized: boolean;
  urlConfig?: {
    id: string;
    targetUrl: string;
    label: string;
    proxyMode: ProxyMode;
    headlessTimeout: number;
    sessionTtl: number;
    auditLevel: AuditLevel;
  };
  userTypeId?: string;
  projectTypeId?: string;
  error?: string;
  errorCode?: string;
}

export class ProxyService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Validate user's access to a URL configuration by opaque ID
   * Checks:
   * 1. URL config exists and is active
   * 2. User has assignment matching URL's user type and project type
   * 3. Category and SubCategory are active
   * 4. User Type and Project Type are active
   */
  async validateAccess(userId: string, opaqueId: string): Promise<UrlAccessResult> {
    // Get user's assignment
    const assignment = await this.prisma.userAssignment.findUnique({
      where: { userId },
      include: {
        userType: { select: { id: true, status: true } },
        projectType: { select: { id: true, status: true } },
      },
    });

    if (!assignment) {
      return {
        authorized: false,
        error: 'No project assignment found',
        errorCode: 'NO_ASSIGNMENT',
      };
    }

    // Check if user type is active
    if (assignment.userType.status !== 'ACTIVE') {
      return {
        authorized: false,
        error: 'User type is inactive',
        errorCode: 'INACTIVE_USER_TYPE',
      };
    }

    // Check if project type is active
    if (assignment.projectType.status !== 'ACTIVE') {
      return {
        authorized: false,
        error: 'Project type is inactive',
        errorCode: 'INACTIVE_PROJECT_TYPE',
      };
    }

    // Get URL configuration with all related entities
    const urlConfig = await this.prisma.urlConfiguration.findUnique({
      where: { opaqueId },
      include: {
        category: { select: { id: true, status: true } },
        subCategory: { select: { id: true, status: true } },
        userType: { select: { id: true, status: true } },
        projectType: { select: { id: true, status: true } },
      },
    });

    if (!urlConfig) {
      return {
        authorized: false,
        error: 'URL not found',
        errorCode: 'NOT_FOUND',
      };
    }

    // Check if URL config is active
    if (urlConfig.status !== 'ACTIVE') {
      return {
        authorized: false,
        error: 'URL is currently unavailable',
        errorCode: 'INACTIVE_URL',
      };
    }

    // Check if category is active
    if (urlConfig.category.status !== 'ACTIVE') {
      return {
        authorized: false,
        error: 'Category is inactive',
        errorCode: 'INACTIVE_CATEGORY',
      };
    }

    // Check if sub-category is active
    if (urlConfig.subCategory.status !== 'ACTIVE') {
      return {
        authorized: false,
        error: 'Sub-category is inactive',
        errorCode: 'INACTIVE_SUBCATEGORY',
      };
    }

    // Check if URL's user type and project type match user's assignment
    if (urlConfig.userTypeId !== assignment.userTypeId) {
      return {
        authorized: false,
        error: 'Access denied',
        errorCode: 'UNAUTHORIZED',
      };
    }

    if (urlConfig.projectTypeId !== assignment.projectTypeId) {
      return {
        authorized: false,
        error: 'Access denied',
        errorCode: 'UNAUTHORIZED',
      };
    }

    return {
      authorized: true,
      urlConfig: {
        id: urlConfig.id,
        targetUrl: urlConfig.targetUrl,
        label: urlConfig.label,
        proxyMode: urlConfig.proxyMode,
        headlessTimeout: urlConfig.headlessTimeout,
        sessionTtl: urlConfig.sessionTtl,
        auditLevel: urlConfig.auditLevel,
      },
      userTypeId: assignment.userTypeId,
      projectTypeId: assignment.projectTypeId,
    };
  }
}
