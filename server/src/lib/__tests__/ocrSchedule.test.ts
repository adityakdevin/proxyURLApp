import { scheduleOcr } from '../ocrSchedule';

describe('scheduleOcr', () => {
  let t = 0;
  const now = () => t;
  beforeEach(() => {
    t = 0;
  });

  const base = {
    wantsRetry: () => false,
    retry: async (_item: number, r: string) => r,
    retryBudget: 0,
    deadline: Infinity,
    now,
  };

  it('gives every page a first look before any page gets a retry', async () => {
    const calls: string[] = [];
    await scheduleOcr({
      ...base,
      items: [0, 1, 2],
      lanes: 1,
      retryBudget: 3,
      first: async (i: number) => {
        calls.push(`first:${i}`);
        t += 100;
        return `f${i}`;
      },
      wantsRetry: () => true,
      retry: async (i: number, r: string) => {
        calls.push(`retry:${i}`);
        return r;
      },
    });
    expect(calls).toEqual(['first:0', 'first:1', 'first:2', 'retry:0', 'retry:1', 'retry:2']);
  });

  it('stops starting pages at the deadline and leaves the rest null', async () => {
    const results = await scheduleOcr({
      ...base,
      items: [0, 1, 2, 3, 4],
      lanes: 1,
      deadline: 250,
      first: async (i: number) => {
        t += 100;
        return `f${i}`;
      },
    });
    expect(results).toEqual(['f0', 'f1', 'f2', null, null]);
  });

  it('starts no retry once the deadline has passed', async () => {
    const retry = jest.fn(async (_i: number, r: string) => r);
    const results = await scheduleOcr({
      ...base,
      items: [0, 1, 2],
      lanes: 1,
      deadline: 250,
      retryBudget: 3,
      first: async (i: number) => {
        t += 100;
        return `f${i}`;
      },
      wantsRetry: () => true,
      retry,
    });
    expect(retry).not.toHaveBeenCalled();
    expect(results).toEqual(['f0', 'f1', 'f2']);
  });

  it('spends at most retryBudget retries across all lanes', async () => {
    const retry = jest.fn(async (_i: number, r: string) => r);
    await scheduleOcr({
      ...base,
      items: [0, 1, 2, 3],
      lanes: 2,
      retryBudget: 2,
      first: async (i: number) => `f${i}`,
      wantsRetry: () => true,
      retry,
    });
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('reads nothing when the deadline has already passed', async () => {
    t = 1000;
    const first = jest.fn(async (i: number) => `f${i}`);
    const results = await scheduleOcr({
      ...base,
      items: [0, 1],
      lanes: 2,
      deadline: t - 1,
      first,
    });
    expect(first).not.toHaveBeenCalled();
    expect(results).toEqual([null, null]);
  });

  it('keeps results by index when lanes finish out of order', async () => {
    const results = await scheduleOcr({
      ...base,
      items: [0, 1],
      lanes: 2,
      first: (i: number) =>
        new Promise<string>((resolve) => setTimeout(() => resolve(`r${i}`), i === 0 ? 300 : 100)),
    });
    expect(results).toEqual(['r0', 'r1']);
  });
});

describe('scheduleOcr at the deadline', () => {
  // Real nextTick and setImmediate, so a late rejection can surface as unhandled.
  beforeEach(() => jest.useFakeTimers({ now: 0, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  const base = { wantsRetry: () => false, retry: async (_i: number, r: string) => r, retryBudget: 0 };

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  /** What `p` has settled to so far, or 'pending'. */
  const settled = <T>(p: Promise<T>) => Promise.race([p, Promise.resolve('pending' as const)]);
  const eventLoopTurn = () => new Promise((r) => setImmediate(r));

  it('returns at the deadline: a first look still running is unread, finished ones are kept', async () => {
    const stuck = deferred<string>();
    const out = scheduleOcr({
      ...base,
      items: [0, 1, 2],
      lanes: 2,
      deadline: 1_000,
      first: (i: number) => (i === 1 ? stuck.promise : Promise.resolve(`f${i}`)),
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(await settled(out)).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(out)).toEqual(['f0', null, 'f2']);
  });

  it('keeps the first look of a page whose retry is still running at the deadline', async () => {
    const stuck = deferred<string>();
    const out = scheduleOcr({
      ...base,
      items: [0, 1],
      lanes: 1,
      deadline: 1_000,
      retryBudget: 2,
      first: async (i: number) => `f${i}`,
      wantsRetry: () => true,
      retry: (i: number) => (i === 0 ? Promise.resolve('r0') : stuck.promise),
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await settled(out)).toEqual(['r0', 'f1']);
  });

  it('lets work that ends after the deadline change nothing and reject nowhere', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const lateFirst = deferred<string>();
      const failingFirst = deferred<string>();
      const firstLooks = scheduleOcr({
        ...base,
        items: [0, 1, 2],
        lanes: 3,
        deadline: 1_000,
        first: (i: number) => [Promise.resolve('f0'), lateFirst.promise, failingFirst.promise][i],
      });
      await jest.advanceTimersByTimeAsync(1_000);
      const returned = await settled(firstLooks);
      lateFirst.resolve('late');
      failingFirst.reject(new Error('tesseract died'));
      await eventLoopTurn();
      expect(returned).toEqual(['f0', null, null]);

      const lateRetry = deferred<string>();
      const retries = scheduleOcr({
        ...base,
        items: [0],
        lanes: 1,
        deadline: 2_000,
        retryBudget: 1,
        first: async () => 'f0',
        wantsRetry: () => true,
        retry: () => lateRetry.promise,
      });
      await jest.advanceTimersByTimeAsync(1_000);
      const kept = await settled(retries);
      lateRetry.resolve('late');
      await eventLoopTurn();
      expect(kept).toEqual(['f0']);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('stops on the clock it is given, re-arming while that clock lags the wall clock', async () => {
    let queuedMs = 0;
    const stuck = deferred<string>();
    const out = scheduleOcr({
      ...base,
      items: [0],
      lanes: 1,
      deadline: 1_000,
      now: () => Date.now() - queuedMs,
      first: () => stuck.promise,
    });
    // 400 ms spent queued for a pdf.js turn: that time does not count.
    queuedMs = 400;
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await settled(out)).toBe('pending');
    await jest.advanceTimersByTimeAsync(399);
    expect(await settled(out)).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(out)).toEqual([null]);
  });

  it('arms no timer without a deadline', async () => {
    const stuck = deferred<string>();
    const out = scheduleOcr({ ...base, items: [0], lanes: 1, deadline: Infinity, first: () => stuck.promise });
    expect(jest.getTimerCount()).toBe(0);
    stuck.resolve('f0');
    await expect(out).resolves.toEqual(['f0']);
  });
});
