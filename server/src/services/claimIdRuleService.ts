import { PrismaClient, Prisma, Status, ClaimIdRule, ScanTarget } from '@prisma/client';
import { subCategoryExists } from '../lib/subCategoryGuard.js';

export class ClaimIdRuleServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function validateScanLocation(value: string): void {
  if (!/^[A-Za-z]:\\.+/.test(value)) {
    throw new ClaimIdRuleServiceError(
      'INVALID_SCAN_LOCATION',
      'scanLocation must be an absolute drive-letter path like D:\\Claims'
    );
  }
  if (/^[Cc]:\\/.test(value)) {
    throw new ClaimIdRuleServiceError(
      'INVALID_SCAN_LOCATION',
      'scanLocation cannot be on the C drive'
    );
  }
  // Reject '..' segments so a stored path can't escape its root when resolved.
  if (value.split(/[\\/]/).includes('..')) {
    throw new ClaimIdRuleServiceError(
      'INVALID_SCAN_LOCATION',
      'scanLocation must not contain ".." path segments'
    );
  }
}

export interface CreateClaimIdRuleInput {
  subCategoryId: string;
  startPosition: number;
  length: number;
  scanTarget: ScanTarget;
  scanLocation: string;
  status?: Status;
}

export interface UpdateClaimIdRuleInput {
  startPosition?: number;
  length?: number;
  scanTarget?: ScanTarget;
  scanLocation?: string;
  status?: Status;
}

export class ClaimIdRuleService {
  constructor(private prisma: PrismaClient) {}

  private validateRange(start: number, length: number) {
    if (start < 1)
      throw new ClaimIdRuleServiceError('INVALID_RANGE', 'startPosition must be >= 1');
    if (length < 1) throw new ClaimIdRuleServiceError('INVALID_RANGE', 'length must be >= 1');
    if (start + length - 1 > 200)
      throw new ClaimIdRuleServiceError(
        'INVALID_RANGE',
        'startPosition + length - 1 must be <= 200'
      );
  }

  async create(input: CreateClaimIdRuleInput, actorId: string): Promise<ClaimIdRule> {
    this.validateRange(input.startPosition, input.length);
    validateScanLocation(input.scanLocation);
    if (!(await subCategoryExists(this.prisma, input.subCategoryId))) {
      throw new ClaimIdRuleServiceError('SUBCATEGORY_NOT_FOUND', 'SubCategory not found');
    }
    const existing = await this.prisma.claimIdRule.findUnique({
      where: { subCategoryId: input.subCategoryId },
    });
    if (existing) {
      throw new ClaimIdRuleServiceError(
        'RULE_EXISTS',
        'A Claim ID Rule already exists for this SubCategory'
      );
    }
    try {
      return await this.prisma.claimIdRule.create({
        data: {
          subCategoryId: input.subCategoryId,
          startPosition: input.startPosition,
          length: input.length,
          scanTarget: input.scanTarget,
          scanLocation: input.scanLocation,
          status: input.status ?? Status.ACTIVE,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
    } catch (err) {
      // subCategoryId is @unique; a concurrent create loses the race here.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ClaimIdRuleServiceError(
          'RULE_EXISTS',
          'A Claim ID Rule already exists for this SubCategory'
        );
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateClaimIdRuleInput, actorId: string): Promise<ClaimIdRule> {
    const existing = await this.prisma.claimIdRule.findUnique({ where: { id } });
    if (!existing) throw new ClaimIdRuleServiceError('NOT_FOUND', 'ClaimIdRule not found');
    const start = input.startPosition ?? existing.startPosition;
    const length = input.length ?? existing.length;
    this.validateRange(start, length);
    if (input.scanLocation) validateScanLocation(input.scanLocation);
    return this.prisma.claimIdRule.update({
      where: { id },
      data: { ...input, updatedBy: actorId },
    });
  }

  async delete(id: string): Promise<void> {
    // A live scan's job would be cascade-deleted and the runner would then hit
    // P2025; refuse the delete until the scan finishes.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.claimIdRule.findUnique({ where: { id } });
      if (!existing) throw new ClaimIdRuleServiceError('NOT_FOUND', 'ClaimIdRule not found');
      const live = await tx.scanJob.findFirst({
        where: { claimIdRuleId: id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (live) {
        throw new ClaimIdRuleServiceError(
          'SCAN_IN_PROGRESS',
          'A scan is running for this rule; wait for it to finish before deleting'
        );
      }
      await tx.claimIdRule.delete({ where: { id } });
    });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<ClaimIdRule> {
    return this.prisma.claimIdRule.update({
      where: { id },
      data: { status, updatedBy: actorId },
    });
  }

  async getById(id: string): Promise<ClaimIdRule | null> {
    return this.prisma.claimIdRule.findUnique({ where: { id } });
  }

  async list(filters: {
    subCategoryId?: string;
    status?: Status;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.ClaimIdRuleWhereInput = {};
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.status) where.status = filters.status;
    const [data, total] = await Promise.all([
      this.prisma.claimIdRule.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claimIdRule.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
