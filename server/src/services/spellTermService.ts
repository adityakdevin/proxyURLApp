import { PrismaClient, Prisma, Status, SpellTerm } from '@prisma/client';
import { MIN_TERM_LEN } from '../validators/logic.js';

export interface CreateSpellTermInput {
  term: string;
  status?: Status;
}

export interface UpdateSpellTermInput {
  term?: string;
  status?: Status;
}

export interface ListSpellTermsFilters {
  status?: Status;
  search?: string;
  page?: number;
  limit?: number;
}

export class SpellTermServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Terms are stored normalized (lowercased, trimmed) so the near-miss matcher and
 *  the unique(term) constraint both see one canonical form. */
function normalize(term: string): string {
  return term.toLowerCase().trim();
}

/**
 * Reject a term the matcher could never act on, rather than storing one that silently
 * does nothing. Both shapes were accepted before and were invisible failures: an admin
 * added "Security Guard" or "For", saw it listed as ACTIVE, and no document was ever
 * flagged against it.
 *
 * - A multi-word term cannot match: a spell candidate is a single run of letters
 *   (`spellCandidates`), so nothing containing a space is ever within edit distance.
 * - A term under MIN_TERM_LEN is skipped by `findTermMisspellings` as coincidence-prone.
 */
function assertMatchable(term: string): void {
  if (/\s/.test(term)) {
    throw new SpellTermServiceError(
      'INVALID_TERM',
      'A term must be a single word — the spell check compares one word at a time, so a term containing a space can never match. Add each word as its own term.'
    );
  }
  if (term.length < MIN_TERM_LEN) {
    throw new SpellTermServiceError(
      'INVALID_TERM',
      `A term must be at least ${MIN_TERM_LEN} characters — shorter terms match too many unrelated words to be evidence of anything.`
    );
  }
}

export class SpellTermService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateSpellTermInput, actorId: string): Promise<SpellTerm> {
    const term = normalize(input.term);
    assertMatchable(term);
    try {
      return await this.prisma.spellTerm.create({
        data: {
          term,
          status: input.status ?? Status.ACTIVE,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new SpellTermServiceError('DUPLICATE_TERM', 'Spell term must be unique');
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateSpellTermInput, actorId: string): Promise<SpellTerm> {
    const existing = await this.prisma.spellTerm.findUnique({ where: { id } });
    if (!existing) throw new SpellTermServiceError('NOT_FOUND', 'SpellTerm not found');
    const term = input.term !== undefined ? normalize(input.term) : undefined;
    if (term !== undefined) assertMatchable(term);
    try {
      return await this.prisma.spellTerm.update({
        where: { id },
        data: {
          ...(term !== undefined ? { term } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedBy: actorId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new SpellTermServiceError('DUPLICATE_TERM', 'Spell term must be unique');
      }
      throw err;
    }
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<SpellTerm> {
    const existing = await this.prisma.spellTerm.findUnique({ where: { id } });
    if (!existing) throw new SpellTermServiceError('NOT_FOUND', 'SpellTerm not found');
    return this.prisma.spellTerm.update({
      where: { id },
      data: { status, updatedBy: actorId },
    });
  }

  async delete(id: string): Promise<void> {
    const existing = await this.prisma.spellTerm.findUnique({ where: { id } });
    if (!existing) throw new SpellTermServiceError('NOT_FOUND', 'SpellTerm not found');
    await this.prisma.spellTerm.delete({ where: { id } });
  }

  async getById(id: string): Promise<SpellTerm | null> {
    return this.prisma.spellTerm.findUnique({ where: { id } });
  }

  async list(
    filters: ListSpellTermsFilters
  ): Promise<{ data: SpellTerm[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.SpellTermWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.search) where.term = { contains: filters.search.toLowerCase().trim() };
    const [data, total] = await Promise.all([
      this.prisma.spellTerm.findMany({
        where,
        orderBy: [{ term: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.spellTerm.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
