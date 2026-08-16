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

/** True when any visible row has a check currently executing. */
export function hasRunningChecks(
  rows: {
    spellCheckStatus?: string;
    qrStatus?: string;
    metaExtractionStatus?: string;
    intraClaimStatus?: string;
    fullScanStatus?: string;
  }[]
): boolean {
  return rows.some(
    (r) =>
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
  refetch: () => void
): { watch: () => void; polling: boolean } {
  const [graceUntil, setGraceUntil] = useState(0);

  // Held in a ref because the pages pass a plain (unmemoized) fetchData: putting it in the
  // effect's deps would tear down and rebuild the interval on every render, and it could
  // never reach POLL_MS.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const polling = hasRunning || Date.now() < graceUntil;

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      refetchRef.current();
      // Expire the window from inside the tick so the effect re-evaluates and can stop.
      setGraceUntil((g) => (Date.now() >= g ? 0 : g));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [polling]);

  const watch = useCallback(() => setGraceUntil(Date.now() + GRACE_MS), []);
  return { watch, polling };
}
