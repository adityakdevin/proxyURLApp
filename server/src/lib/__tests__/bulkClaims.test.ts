import { ClaimAuditAction, ClaimAuditTargeting, PrismaClient } from '@prisma/client';
import { ClaimService, ClaimServiceError } from '../../services/claimService.js';
import { BULK_MAX, BulkTarget, resolveTargets, runBulk } from '../bulkClaims.js';

// No DB: resolveTargets only needs idsMatching, so a stub stands in for the service and the
// cases that matter (cap, unknown filter value, no targets) stay fast and deterministic.
const stubService = (result: { ids: string[]; total: number }) =>
  ({ idsMatching: async () => result }) as unknown as ClaimService;

const base = { scope: 'ALL' as const, callerId: 'caller', role: 'ADMIN' as const };

/** Captures the filters resolveTargets forwards, so parseFilters can be asserted on. */
const capturingService = () => {
  const seen: Record<string, unknown>[] = [];
  const svc = {
    idsMatching: async (f: Record<string, unknown>) => {
      seen.push(f);
      return { ids: [], total: 0 };
    },
  } as unknown as ClaimService;
  return { svc, seen };
};


/** Captures the audit row runBulk writes, without a database. */
const auditSpy = () => {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    claimAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
};

const audit = { action: ClaimAuditAction.BULK_DELETE, userId: 'admin-1', ipAddress: '10.0.0.1' };
const targetOf = (ids: string[]): BulkTarget => ({ ids, targeting: ClaimAuditTargeting.IDS });

afterEach(() => jest.restoreAllMocks());

describe('resolveTargets', () => {
  it('takes an explicit selection as-is', async () => {
    const r = await resolveTargets(stubService({ ids: [], total: 0 }), { ids: ['a', 'b'] }, base);
    expect(r.ids).toEqual(['a', 'b']);
  });

  it('refuses a selection over the cap instead of trimming it', async () => {
    const ids = Array.from({ length: BULK_MAX + 1 }, (_, i) => `id-${i}`);
    const r = await resolveTargets(stubService({ ids: [], total: 0 }), { ids }, base);
    expect(r.ids).toBeUndefined();
    expect(r.error?.code).toBe('BULK_TOO_LARGE');
  });

  it('resolves "all matching" through the filters', async () => {
    const r = await resolveTargets(
      stubService({ ids: ['x', 'y'], total: 2 }),
      { filters: { search: 'MZB', spellCheckStatus: 'FAILED' } },
      base
    );
    expect(r.ids).toEqual(['x', 'y']);
  });

  it('refuses when more claims match than the cap allows', async () => {
    const r = await resolveTargets(
      stubService({ ids: [], total: BULK_MAX + 25 }),
      { filters: {} },
      base
    );
    expect(r.error?.code).toBe('BULK_TOO_LARGE');
    expect(r.error?.message).toContain(String(BULK_MAX + 25));
  });

  it('rejects an unknown check status rather than passing it to Prisma', async () => {
    const r = await resolveTargets(
      stubService({ ids: ['x'], total: 1 }),
      { filters: { qrStatus: 'NOT_A_STATUS' } },
      base
    );
    expect(r.error?.code).toBe('INVALID_FILTER');
  });

  it('rejects a call with neither ids nor filters', async () => {
    const r = await resolveTargets(stubService({ ids: [], total: 0 }), {}, base);
    expect(r.error?.code).toBe('NO_TARGETS');
  });

  // An empty selection used to fall through to the filters branch, so a body carrying BOTH
  // keys — `{ids: [], filters: {}}` — resolved to every claim in scope. For an admin on
  // /bulk/delete that is the whole table.
  it('refuses an empty selection instead of falling through to the filters', async () => {
    const r = await resolveTargets(
      stubService({ ids: ['everything', 'in', 'scope'], total: 3 }),
      { ids: [], filters: {} },
      base
    );
    expect(r.ids).toBeUndefined();
    expect(r.error?.code).toBe('NO_TARGETS');
  });

  it('deduplicates ids so one claim cannot be acted on N times', async () => {
    const dupes = Array.from({ length: 40 }, () => 'same-claim');
    const r = await resolveTargets(stubService({ ids: [], total: 0 }), { ids: dupes }, base);
    expect(r.ids).toEqual(['same-claim']);
  });

  it('counts ids AFTER dedup when applying the cap', async () => {
    const dupes = Array.from({ length: BULK_MAX + 50 }, () => 'same-claim');
    const r = await resolveTargets(stubService({ ids: [], total: 0 }), { ids: dupes }, base);
    expect(r.ids).toEqual(['same-claim']);
  });

  it('rejects a malformed ids payload rather than silently narrowing it', async () => {
    for (const ids of [['a', 123], 'not-an-array', { 0: 'a' }]) {
      const r = await resolveTargets(stubService({ ids: [], total: 0 }), { ids }, base);
      expect(r.error?.code).toBe('INVALID_TARGETS');
    }
  });

  it('drops a USER assignee filter, as the list route does (spec §6.2)', async () => {
    let seen: Record<string, unknown> | undefined;
    const spy = {
      idsMatching: async (f: Record<string, unknown>) => {
        seen = f;
        return { ids: [], total: 0 };
      },
    } as unknown as ClaimService;
    await resolveTargets(spy, { filters: { assignedToUserId: 'someone-else' } }, {
      ...base,
      role: 'USER',
    });
    expect(seen?.assignedToUserId).toBeUndefined();
    await resolveTargets(spy, { filters: { assignedToUserId: 'someone-else' } }, {
      ...base,
      role: 'TEAM_LEAD',
    });
    expect(seen?.assignedToUserId).toBe('someone-else');
  });

  it('drops an unknown filter key instead of forwarding it', async () => {
    let seen: Record<string, unknown> | undefined;
    const spy = {
      idsMatching: async (f: Record<string, unknown>) => {
        seen = f;
        return { ids: [], total: 0 };
      },
    } as unknown as ClaimService;
    await resolveTargets(spy, { filters: { search: 'MZB', notAFilter: 'x' } }, base);
    expect(seen).not.toHaveProperty('notAFilter');
    expect(seen).toMatchObject({ search: 'MZB' });
  });

  it('dedupes ids the DATABASE would consider equal, not just byte-equal ones', async () => {
    // claims.id is utf8mb4_unicode_ci, so MySQL matches these as one row; a case-sensitive
    // Set let the same claim through 500 times and wrote 500 remarks to one timeline.
    const id = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    const spellings = [id, id.toLowerCase(), id.toUpperCase()];
    const r = await resolveTargets(stubService({ ids: [], total: 0 }), { ids: spellings }, base);
    expect(r.ids).toEqual([id.toLowerCase()]);
  });

  it('validates the status filter rather than forwarding an arbitrary one', async () => {
    const bad = await resolveTargets(
      stubService({ ids: [], total: 0 }),
      { filters: { status: 'ARCHIVED' } },
      base
    );
    expect(bad.error?.code).toBe('INVALID_FILTER');

    const { svc, seen } = capturingService();
    await resolveTargets(svc, { filters: { status: 'INACTIVE' } }, base);
    expect(seen[0].status).toBe('INACTIVE');
  });

  it('coerces assignedToMe from the string a query string would carry', async () => {
    const { svc, seen } = capturingService();
    await resolveTargets(svc, { filters: { assignedToMe: true } }, base);
    await resolveTargets(svc, { filters: { assignedToMe: 'true' } }, base);
    await resolveTargets(svc, { filters: { assignedToMe: 'false' } }, base);
    await resolveTargets(svc, { filters: {} }, base);
    // Anything that is not the boolean or the exact string 'true' means "not mine" — a
    // looser coercion here widens the set a bulk MUTATION acts on.
    expect(seen.map((f) => f.assignedToMe)).toEqual([true, true, false, false]);
  });
});

describe('claim audit row', () => {
  it('lowercases recorded ids so array_contains can find them', async () => {
    // The single-claim routes hand over req.params.id verbatim and `param('id').isUUID()`
    // accepts uppercase; MySQL's _ci collation matches the claim either way, so without
    // this the delete succeeded and its audit row was unfindable by that claim's id.
    const { prisma, rows } = auditSpy();
    await runBulk(prisma, targetOf(['AB-1', 'cd-2']), audit, async () => undefined);
    expect(rows[0].claimIds).toEqual(['ab-1', 'cd-2']);
  });

  it('records the filters the server applied, not the ones the caller sent', async () => {
    // A USER may not aim at another user's claims: parseFilters drops assignedToUserId, so
    // an audit row echoing the raw body would name a scope that was never used.
    const r = await resolveTargets(
      stubService({ ids: [], total: 0 }),
      { filters: { assignedToUserId: 'someone-else', search: 'abc', nonsense: 'x' } },
      { scope: 'ALL', callerId: 'caller', role: 'USER' }
    );
    if (r.error) throw new Error(`unexpected refusal: ${r.error.code}`);
    // assignedToMe is absent, not false: parseFilters coerces the missing flag to false and
    // recording that would describe a narrowing the caller never asked for. status IS
    // present: buildWhere applies ACTIVE when none is named, so the row says so.
    expect(r.filters).toEqual({ search: 'abc', status: 'ACTIVE' });
  });

  it('records the lifecycle buildWhere will apply, not the one a scoped caller asked for', async () => {
    // buildWhere honours `status` only for scope ALL. A scoped caller asking for the deleted
    // set acts on the ACTIVE one, and the row has to say ACTIVE or it names a set that was
    // never touched.
    const r = await resolveTargets(
      stubService({ ids: [], total: 0 }),
      { filters: { status: 'INACTIVE' } },
      { scope: { subCategoryIds: ['s'] }, callerId: 'caller', role: 'TEAM_LEAD' }
    );
    if (r.error) throw new Error(`unexpected refusal: ${r.error.code}`);
    expect(r.filters).toEqual({ status: 'ACTIVE' });
  });
});

describe('runBulk', () => {
  it('keeps going past a failure and reports the reason per claim', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { prisma } = auditSpy();
    const report = await runBulk(prisma, targetOf(['ok-1', 'bad', 'ok-2']), audit, async (id) => {
      if (id === 'bad') throw new ClaimServiceError('TERMINAL_STATUS', 'nope');
    });
    // A rule saying no is not a fault — it must NOT reach the log.
    expect(logged).not.toHaveBeenCalled();
    expect(report).toEqual({
      requested: 3,
      succeeded: 2,
      failed: [{ id: 'bad', code: 'TERMINAL_STATUS' }],
    });
  });

  it('labels a non-service error rather than leaking it, and logs it', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { prisma } = auditSpy();
    const report = await runBulk(prisma, targetOf(['boom']), audit, async () => {
      throw new Error('kaboom');
    });
    expect(report.failed).toEqual([{ id: 'boom', code: 'FAILED' }]);
    // A fault that answers 200 must at least leave a trace on the server.
    expect(logged).toHaveBeenCalled();
  });


  it('reports a no-op for an empty target list', async () => {
    const { prisma } = auditSpy();
    expect(await runBulk(prisma, targetOf([]), audit, async () => undefined)).toEqual({
      requested: 0,
      succeeded: 0,
      failed: [],
    });
  });

  it('records who acted, how they aimed it, and which claims failed', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { prisma, rows } = auditSpy();
    await runBulk(
      prisma,
      { ids: ['ok-1', 'bad'], targeting: ClaimAuditTargeting.FILTERS, filters: { search: 'MZB' } },
      audit,
      async (id) => {
        if (id === 'bad') throw new ClaimServiceError('NOT_FOUND', 'gone');
      }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 'admin-1',
      action: ClaimAuditAction.BULK_DELETE,
      targeting: ClaimAuditTargeting.FILTERS,
      filters: { search: 'MZB' },
      claimIds: ['ok-1', 'bad'],
      failures: [{ id: 'bad', code: 'NOT_FOUND' }],
      requested: 2,
      succeeded: 1,
      failed: 1,
      ipAddress: '10.0.0.1',
    });
  });

  // The 31-claim delete this table was added for would have been unrecorded if a failed
  // insert could take the response down with it — the claims are already changed by then.
  it('still returns the report when the audit write itself fails', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const prisma = {
      claimAuditLog: {
        create: async () => {
          throw new Error('audit table missing');
        },
      },
    } as unknown as PrismaClient;
    const report = await runBulk(prisma, targetOf(['ok-1']), audit, async () => undefined);
    expect(report).toEqual({ requested: 1, succeeded: 1, failed: [] });
    expect(logged).toHaveBeenCalled();
  });
});
