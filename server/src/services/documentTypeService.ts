import {
  PrismaClient,
  Prisma,
  Status,
  DocumentTypeMaster,
  DocumentTypeCategory,
  GovtDocumentCode,
} from '@prisma/client';
import { subCategoryExists } from '../lib/subCategoryGuard.js';

export interface CreateDocumentTypeInput {
  subCategoryId: string;
  name: string;
  category: DocumentTypeCategory;
  govtCode?: GovtDocumentCode | null;
  displayOrder?: number;
  isRequired?: boolean;
  status?: Status;
}

export interface UpdateDocumentTypeInput {
  name?: string;
  displayOrder?: number;
  isRequired?: boolean;
  status?: Status;
}

export interface ListDocumentTypesFilters {
  subCategoryId?: string;
  status?: Status;
  category?: DocumentTypeCategory;
  page?: number;
  limit?: number;
}

export class DocumentTypeServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class DocumentTypeService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateDocumentTypeInput, actorId: string): Promise<DocumentTypeMaster> {
    if (input.category === 'GOVT' && !input.govtCode) {
      throw new DocumentTypeServiceError(
        'GOVT_CODE_REQUIRED',
        'govtCode is required when category is GOVT'
      );
    }
    if (input.category === 'CUSTOM' && input.govtCode) {
      throw new DocumentTypeServiceError(
        'GOVT_CODE_NOT_ALLOWED',
        'govtCode must be empty when category is CUSTOM'
      );
    }
    if (!(await subCategoryExists(this.prisma, input.subCategoryId))) {
      throw new DocumentTypeServiceError('SUBCATEGORY_NOT_FOUND', 'SubCategory not found');
    }
    if (input.category === 'GOVT') {
      const existing = await this.prisma.documentTypeMaster.findUnique({
        where: {
          govtCode_subCategoryId: {
            govtCode: input.govtCode!,
            subCategoryId: input.subCategoryId,
          },
        },
      });
      if (existing) {
        throw new DocumentTypeServiceError(
          'DUPLICATE_GOVT_CODE',
          'This Govt document type already exists in this SubCategory'
        );
      }
    }
    try {
      return await this.prisma.documentTypeMaster.create({
        data: {
          subCategoryId: input.subCategoryId,
          name: input.name,
          category: input.category,
          govtCode: input.category === 'GOVT' ? input.govtCode! : null,
          displayOrder: input.displayOrder ?? 0,
          isRequired: input.isRequired ?? true,
          status: input.status ?? Status.ACTIVE,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
        if (target.includes('govt_code')) {
          throw new DocumentTypeServiceError(
            'DUPLICATE_GOVT_CODE',
            'This Govt document type already exists in this SubCategory'
          );
        }
        throw new DocumentTypeServiceError(
          'DUPLICATE_NAME',
          'Document type name must be unique per SubCategory'
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    input: UpdateDocumentTypeInput,
    actorId: string
  ): Promise<DocumentTypeMaster> {
    try {
      return await this.prisma.documentTypeMaster.update({
        where: { id },
        data: { ...input, updatedBy: actorId },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DocumentTypeServiceError(
          'DUPLICATE_NAME',
          'Document type name must be unique per SubCategory'
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    await this.prisma.documentTypeMaster.delete({ where: { id } });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<DocumentTypeMaster> {
    return this.prisma.documentTypeMaster.update({
      where: { id },
      data: { status, updatedBy: actorId },
    });
  }

  async getById(id: string): Promise<DocumentTypeMaster | null> {
    return this.prisma.documentTypeMaster.findUnique({ where: { id } });
  }

  async list(
    filters: ListDocumentTypesFilters
  ): Promise<{ data: DocumentTypeMaster[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.DocumentTypeMasterWhereInput = {};
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.status) where.status = filters.status;
    if (filters.category) where.category = filters.category;
    const [data, total] = await Promise.all([
      this.prisma.documentTypeMaster.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.documentTypeMaster.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
