import { PrismaClient } from '@prisma/client';

export interface AuditLogEntry {
  userId: string;
  userTypeId: string;
  projectTypeId: string;
  urlConfigId: string;
  targetUrl: string;
  requestMethod: string;
  responseStatus: number;
  durationMs: number;
  ipAddress?: string;
  userAgent?: string;
}

export class AuditLogService {
  constructor(private prisma: PrismaClient) {}

  // Fire-and-forget async logging (non-blocking)
  logAccess(entry: AuditLogEntry): void {
    // Don't await - fire and forget
    this.prisma.auditLog
      .create({
        data: {
          userId: entry.userId,
          userTypeId: entry.userTypeId,
          projectTypeId: entry.projectTypeId,
          urlConfigId: entry.urlConfigId,
          targetUrl: entry.targetUrl,
          requestMethod: entry.requestMethod,
          responseStatus: entry.responseStatus,
          durationMs: entry.durationMs,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
        },
      })
      .catch((error) => {
        // Log error but don't throw - audit logging should never block
        console.error('Audit log error:', error);
      });
  }

  // Cleanup old logs based on retention period
  async cleanupOldLogs(): Promise<number> {
    const retentionSetting = await this.prisma.setting.findUnique({
      where: { key: 'audit_retention_days' },
    });

    const retentionDays = retentionSetting ? parseInt(retentionSetting.value, 10) : 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        accessedAt: {
          lt: cutoffDate,
        },
      },
    });

    return result.count;
  }

  // Get user's frequently accessed URLs
  async getFrequentUrls(userId: string, limit: number = 5) {
    const result = await this.prisma.auditLog.groupBy({
      by: ['urlConfigId'],
      where: { userId },
      _count: { urlConfigId: true },
      orderBy: { _count: { urlConfigId: 'desc' } },
      take: limit,
    });

    if (result.length === 0) return [];

    const urlConfigs = await this.prisma.urlConfiguration.findMany({
      where: {
        id: { in: result.map((r) => r.urlConfigId) },
      },
      select: {
        id: true,
        label: true,
        opaqueId: true,
      },
    });

    // Map back with counts, preserving order
    return result.map((r) => {
      const config = urlConfigs.find((c) => c.id === r.urlConfigId);
      return {
        urlConfigId: r.urlConfigId,
        label: config?.label || 'Unknown',
        opaqueId: config?.opaqueId,
        accessCount: r._count.urlConfigId,
      };
    });
  }

  // Get user's recent activity
  async getRecentActivity(userId: string, limit: number = 5) {
    const logs = await this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { accessedAt: 'desc' },
      take: limit,
      include: {
        urlConfig: {
          select: {
            id: true,
            label: true,
            opaqueId: true,
          },
        },
      },
    });

    return logs.map((log) => ({
      urlConfigId: log.urlConfigId,
      label: log.urlConfig.label,
      opaqueId: log.urlConfig.opaqueId,
      accessedAt: log.accessedAt,
    }));
  }

  // Get total accessible URL count for user
  async getAccessibleUrlCount(userTypeId: string, projectTypeId: string): Promise<number> {
    return this.prisma.urlConfiguration.count({
      where: {
        userTypeId,
        projectTypeId,
        status: 'ACTIVE',
        category: { status: 'ACTIVE' },
        subCategory: { status: 'ACTIVE' },
        userType: { status: 'ACTIVE' },
        projectType: { status: 'ACTIVE' },
      },
    });
  }
}
