import { ClaimService, ClaimServiceError } from '../../services/claimService.js';
import { BULK_MAX, resolveTargets, runBulk } from '../bulkClaims.js';

// No DB: resolveTargets only needs idsMatching, so a stub stands in for the service and the
// cases that matter (cap, unknown filter value, no targets) stay fast and deterministic.
const stubService = (result: { ids: string[]; total: number }) =>
  ({ idsMatching: async () => result }) as unknown as ClaimService;

const base = { scope: 'ALL' as const, callerId: 'caller' };

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

  it('labels a non-service error rather than leaking it', async () => {
    const report = await runBulk(['boom'], async () => {
      throw new Error('kaboom');
    });
    expect(report.failed).toEqual([{ id: 'boom', code: 'FAILED' }]);
  });
});
