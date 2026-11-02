import { MAX_TIMER_MS } from './pdfExtractor.js';

export interface OcrScheduleOptions<P, R> {
  items: readonly P[];
  lanes: number;
  /**
   * Ms on the `now` clock. No first look and no retry starts at or after it, and the
   * schedule returns there with what it has: an item whose first look is still running is
   * null, an item whose retry is still running keeps its first look. Infinity = no deadline.
   */
  deadline: number;
  /** Retries allowed across all lanes together. */
  retryBudget: number;
  first: (item: P, lane: number) => Promise<R>;
  wantsRetry: (result: R) => boolean;
  /** Second look; resolves to whichever result should be kept. */
  retry: (item: P, firstResult: R, lane: number) => Promise<R>;
  /** The clock `deadline` is read on. Defaults to performance.now: monotonic, so a wall-clock
   *  step cannot move the deadline. */
  now?: () => number;
}

/**
 * Every item gets a first look before any item gets a retry, so a slow document spends its
 * time reading new pages rather than re-reading poor ones.
 *
 * At the deadline it returns without waiting for work in flight: a high-res retry started just
 * before it can run for most of a minute, past the caller's own budget, whose fallback would
 * then throw away every page already read. That work cannot be cancelled; it runs on, but
 * writes nothing the caller sees.
 *
 * Results land BY INDEX, not by completion order: lanes finish out of order, and downstream
 * code reads page order. null = the item never finished a first look.
 */
export async function scheduleOcr<P, R>(o: OcrScheduleOptions<P, R>): Promise<(R | null)[]> {
  const now = o.now ?? (() => performance.now());
  const results: (R | null)[] = new Array(o.items.length).fill(null);
  const lanes = Array.from({ length: Math.max(1, o.lanes) }, (_, n) => n);

  const work = (async () => {
    let cursor = 0;
    await Promise.all(
      lanes.map(async (lane) => {
        while (cursor < o.items.length && now() < o.deadline) {
          const index = cursor++;
          results[index] = await o.first(o.items[index], lane);
        }
      })
    );

    const queue = results.flatMap((r, i) => (r !== null && o.wantsRetry(r) ? [i] : []));
    let next = 0;
    let budget = o.retryBudget;
    await Promise.all(
      lanes.map(async (lane) => {
        // Test and decrement sit together with no await between them, so no two lanes can
        // both see the last unit and spend it.
        while (next < queue.length && budget > 0 && now() < o.deadline) {
          budget--;
          const index = queue[next++];
          results[index] = await o.retry(o.items[index], results[index] as R, lane);
        }
      })
    );
    return results;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<(R | null)[]>((resolve) => {
    if (o.deadline === Infinity) return;
    // `now` may run behind real time (the caller leaves out time queued for pdf.js), so a
    // timer that fires before `now` reaches the deadline waits again for what is left.
    const check = () => {
      const left = o.deadline - now();
      if (left > 0) timer = setTimeout(check, Math.min(left, MAX_TIMER_MS));
      // A copy, because work still in flight goes on writing into `results`.
      else resolve(results.slice());
    };
    check();
  });
  try {
    // The race also takes any later rejection of the abandoned work, so none goes unhandled.
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
  }
}
