import { ClaimService, ClaimServiceError } from '../../services/claimService.js';
import { BULK_MAX, resolveTargets, runBulk } from '../bulkClaims.js';

// No DB: resolveTargets only needs idsMatching, so a stub stands in for the service and the
// cases that matter (cap, unknown filter value, no targets) stay fast and deterministic.
const stubService = (result: { ids: string[]; total: number }) =>
  ({ idsMatching: async () => result }) as unknown as ClaimService;

const base = { scope: 'ALL' as const, callerId: 'caller', role: 'ADMIN' as const };

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
});

describe('runBulk', () => {
  it('keeps going past a failure and reports the reason per claim', async () => {
    const report = await runBulk(['ok-1', 'bad', 'ok-2'], async (id) => {
      if (id === 'bad') throw new ClaimServiceError('TERMINAL_STATUS', 'nope');
    });
    expect(report).toEqual({
      requested: 3,
      succeeded: 2,
      failed: [{ id: 'bad', code: 'TERMINAL_STATUS' }],
    });
  });

  it('labels a non-service error rather than leaking it, and logs it', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const report = await runBulk(['boom'], async () => {
      throw new Error('kaboom');
    });
    expect(report.failed).toEqual([{ id: 'boom', code: 'FAILED' }]);
    // A fault that answers 200 must at least leave a trace on the server.
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('reports a no-op for an empty target list', async () => {
    expect(await runBulk([], async () => undefined)).toEqual({
      requested: 0,
      succeeded: 0,
      failed: [],
    });
  });
});
