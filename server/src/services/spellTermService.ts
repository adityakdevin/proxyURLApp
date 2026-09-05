import { PrismaClient, Prisma, Status, SpellTerm } from '@prisma/client';
import { EXPECTED_TERMS, MIN_TERM_LEN } from '../validators/logic.js';
import { getSpell, isRealWord } from '../validators/dictionary.js';

const BUILT_IN = new Set(EXPECTED_TERMS.map((t) => t.toLowerCase().trim()));

export interface CreateSpellTermInput {
  term: string;
  /** Set to make this a glossary entry ("pvt" → "Private"). */
  expansion?: string | null;
  status?: Status;
}

export interface UpdateSpellTermInput {
  term?: string;
  expansion?: string | null;
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
function assertMatchable(term: string, isGlossary: boolean): void {
  if (/\s/.test(term)) {
    throw new SpellTermServiceError(
      'INVALID_TERM',
      'A term must be a single word — the spell check compares one word at a time, so a term containing a space can never match. Add each word as its own term.'
    );
  }
  // Length only constrains NEAR-MISS terms. A glossary entry is matched exactly, never
  // fuzzily, so the coincidence argument does not apply — and the abbreviations this exists
  // for ("pvt", "ltd") are all shorter than the floor.
  if (!isGlossary && term.length < MIN_TERM_LEN) {
    throw new SpellTermServiceError(
      'INVALID_TERM',
      `A term must be at least ${MIN_TERM_LEN} characters — shorter terms match too many unrelated words to be evidence of anything.`
    );
  }
}

/** Blank/absent expansion means "ordinary term"; anything else is a glossary entry. */
function normalizeExpansion(v?: string | null): string | null {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
}

/**
 * A non-blocking heads-up for a term that looks like a proper noun.
 *
 * NOT a rejection: there is no reliable way to tell a place or brand name from a form word,
 * and an admin may have a good reason. But this class of term is the main source of false
 * positives, so adding one silently is worse than saying something.
 *
 * The signal is "the English dictionary does not know this word". Form vocabulary — the
 * words the check exists for — is nearly all dictionary words (designation, allowance,
 * signatory). Place and brand names mostly are not (lucknow, bhopal, jindal, bajaj,
 * flipkart). It is a heuristic and it misses words that are both, e.g. "prudential" is an
 * English adjective as well as an insurer, so that one passes quietly.
 *
 * Why it matters: the matcher flags any non-word within an edit-distance cap of a term, and
 * that cap is 2 for terms of 6+ characters. On scanned Indian paperwork a place name like
 * "lucknow" therefore catches a wide spread of OCR noise and reports every hit as a
 * misspelling — the loudest false-positive complaint on record for this check.
 */
export async function properNounWarning(term: string): Promise<string | null> {
  // The curated built-in list is known-good by definition, and 11 of its 136 terms are not
  // in the US dictionary: every month name, plus 'pincode' and the British 'authorised'
  // (which is in the list precisely BECAUSE dictionary-en rejects it). Without this exemption
  // the check nags about 8% of the vocabulary it ships with, and a warning that cries wolf
  // gets ignored on the one term that matters.
  if (BUILT_IN.has(term)) return null;
  try {
    const spell = await getSpell();
    if (isRealWord(spell, term)) return null;
  } catch {
    // Dictionary unavailable — say nothing rather than warn about every term.
    return null;
  }
  const cap = term.length >= 6 ? 2 : 1;
  return (
    `"${term}" is not an English dictionary word, so it may be a place or brand name. ` +
    `Those are the main cause of false positives: the check flags any unrecognised word ` +
    `within ${cap} character${cap === 1 ? '' : 's'} of a term, and scanned place names vary ` +
    `a lot. It has been saved — deactivate it here if reviewers start seeing false alarms.`
  );
}

export class SpellTermService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateSpellTermInput, actorId: string): Promise<SpellTerm> {
    const term = normalize(input.term);
    const expansion = normalizeExpansion(input.expansion);
    assertMatchable(term, expansion !== null);
    try {
      return await this.prisma.spellTerm.create({
        data: {
          term,
          expansion,
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
    const expansion =
      input.expansion !== undefined ? normalizeExpansion(input.expansion) : undefined;
    // Validate against the expansion this row will HAVE after the update, not the one it
    // had before — clearing an expansion turns a 3-letter glossary entry back into an
    // unmatchable term, and that has to be refused rather than silently stored.
    if (term !== undefined) {
      const after = expansion !== undefined ? expansion : existing.expansion;
      assertMatchable(term, after !== null);
    }
    try {
      return await this.prisma.spellTerm.update({
        where: { id },
        data: {
          ...(term !== undefined ? { term } : {}),
          ...(expansion !== undefined ? { expansion } : {}),
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

  /**
   * Bulk glossary import (reviewer request: "feature to be given to upload Glossary").
   *
   * Accepts pasted lines in the shape the reviewers already write them — "Pvt - Private",
   * "Ltd = Limited", "Corpn, Corporation". Upserts rather than inserts: re-importing a
   * corrected list is the normal way this gets used, and failing the whole run on a term
   * that already exists would make that impossible.
   *
   * Every line is reported on. A partial import that silently drops the three lines it
   * could not read is worse than one that says which three.
   */
  async importGlossary(
    text: string,
    actorId: string
  ): Promise<{ saved: number; failed: { line: string; reason: string }[] }> {
    const failed: { line: string; reason: string }[] = [];
    let saved = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // First separator wins, so an expansion may itself contain a dash ("Pvt - Private
      // Limited - Non Banking"). The short form never can: it is one word.
      const m = /^([^\s,=:-]+)\s*[-,=:]\s*(.+)$/.exec(line);
      if (!m) {
        failed.push({ line, reason: 'Expected "short form - expansion"' });
        continue;
      }
      const term = normalize(m[1]);
      const expansion = normalizeExpansion(m[2]);
      if (!expansion) {
        failed.push({ line, reason: 'Expansion is empty' });
        continue;
      }
      try {
        assertMatchable(term, true);
        await this.prisma.spellTerm.upsert({
          where: { term },
          create: { term, expansion, status: Status.ACTIVE, createdBy: actorId, updatedBy: actorId },
          update: { expansion, updatedBy: actorId },
        });
        saved++;
      } catch (err) {
        failed.push({
          line,
          reason: err instanceof SpellTermServiceError ? err.message : 'Could not be saved',
        });
      }
    }
    return { saved, failed };
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
