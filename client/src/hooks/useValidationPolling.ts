import { useCallback, useEffect, useRef, useState } from 'react';

/** The one claim-column value that means a run is executing right now. */
const IN_FLIGHT = 'IN_PROGRESS';

/** Slow enough not to hammer a serial drainer, fast enough that a badge flip feels live. */
const POLL_MS = 4000;

/**
 * Keep polling for a while after queueing, even before anything reads IN_PROGRESS.
 *
 * Queued work does not change any claim column until the drainer reaches it, so the instant
 * after a bulk re-validate every row still shows its OLD status. Without this window the
 * poll would look at that, see nothing running, and stop — which is exactly the state that
 * made "bulk re-validate" look broken.
 */
const GRACE_MS = 30000;

/**
 * True when any visible row has validation work outstanding — queued OR executing.
 *
 * `validationState` is the load-bearing half. The five status columns hold their PREVIOUS
 * values until a validator starts writing, so a claim sitting in the queue is indistinguishable
 * from one nobody touched. Queue 116 claims against a drainer running 2 at a time and 114 rows
 * report "nothing happening" — which is exactly what "re-validate just queues it and no row
 * shows anything" is. The columns alone can only ever light up the handful currently executing,
 * and only if they happen to be on the page you are looking at.
 *
 * The columns are still checked, and not just for older payloads: a validator writes
 * IN_PROGRESS to them, and the run row reaches RUNNING, at slightly different moments.
 */
export function hasRunningChecks(
  rows: {
    validationState?: string | null;
    spellCheckStatus?: string;
    qrStatus?: string;
    metaExtractionStatus?: string;
    intraClaimStatus?: string;
    fullScanStatus?: string;
  }[]
): boolean {
  return rows.some(
    (r) =>
      r.validationState === 'QUEUED' ||
      r.validationState === 'RUNNING' ||
      r.spellCheckStatus === IN_FLIGHT ||
      r.qrStatus === IN_FLIGHT ||
      r.metaExtractionStatus === IN_FLIGHT ||
      r.intraClaimStatus === IN_FLIGHT ||
      r.fullScanStatus === IN_FLIGHT
  );
}

/**
 * Refetch a claims list while validation is in flight.
 *
 * The list refetched once, immediately, when a re-validate was queued — before the drainer
 * had touched anything — so every badge still showed its previous value and the action read
 * as a no-op. A reviewer queued 116 claims, saw nothing change, and reported bulk
 * re-validate as broken; it had worked, and the results landed minutes later behind a manual
 * refresh. The document viewer already polls for exactly this reason; the list never did.
 *
 * Returns a `watch()` to call after queueing work, which keeps polling through the window
 * where runs are queued but nothing has started yet.
 *
 * Stops on its own: once nothing is IN_PROGRESS and the grace window has passed, the
 * interval is torn down, so an idle list costs nothing.
 */
export function useValidationPolling(
  hasRunning: boolean,
  refetch: () => void | Promise<unknown>
): { watch: () => void; polling: boolean; refreshing: boolean } {
  const [graceUntil, setGraceUntil] = useState(0);
  // Surfaced so the list can show a small spinner while a refresh is in flight. The table
  // itself must never blank for a background refresh — that is the bug this hook caused
  // once already — so the only honest signal is a quiet one beside the status text.
  const [refreshing, setRefreshing] = useState(false);

  // Held in a ref because the pages pass a plain (unmemoized) fetchData: putting it in the
  // effect's deps would tear down and rebuild the interval on every render, and it could
  // never reach POLL_MS.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // One poll at a time. setInterval fires on a clock, not on completion, so on a box busy
  // draining validation — exactly when this hook is active — a list query slower than the
  // tick stacks request on request and adds to the load that made it slow. Skip the tick
  // instead of queueing behind it.
  const inFlight = useRef(false);

  const polling = hasRunning || Date.now() < graceUntil;

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      Promise.resolve(refetchRef.current()).finally(() => {
        inFlight.current = false;
        setRefreshing(false);
      });
      // Expire the window from inside the tick so the effect re-evaluates and can stop.
      setGraceUntil((g) => (Date.now() >= g ? 0 : g));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [polling]);

  const watch = useCallback(() => setGraceUntil(Date.now() + GRACE_MS), []);
  return { watch, polling, refreshing };
}
