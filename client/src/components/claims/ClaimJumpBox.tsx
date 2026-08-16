import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';

export interface ClaimHit {
  id: string;
  claimId: string;
  workflowStatus?: { name: string };
  subCategory?: { name: string };
}

interface ClaimJumpBoxProps {
  /** What opening the picked claim means differs per host (claim page vs document viewer). */
  onPick: (claim: ClaimHit) => void | Promise<void>;
  /** Width/height of the input, so a compact toolbar and a page header can both use it. */
  inputClassName?: string;
  placeholder?: string;
  /** Start as just the magnifier and open the field on click — for bars short of width. */
  collapsible?: boolean;
}

const MIN_CHARS = 2;
const LIMIT = 8;
const DEBOUNCE_MS = 250;

/** Bold the typed part, so a list of near-identical claim ids shows WHERE it matched. */
function Highlighted({ text, term }: { text: string; term: string }) {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0 || !term) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="font-semibold text-gray-900">{text.slice(at, at + term.length)}</span>
      {text.slice(at + term.length)}
    </>
  );
}

/**
 * Type-ahead jump to a claim by id. Shared by the claim page and the document viewer: both
 * want "I know the id, take me there" without going back to the list, and a reviewer
 * half-remembering an id needs to SEE the candidates rather than guess the rest of it.
 */
export function ClaimJumpBox({
  onPick,
  inputClassName,
  placeholder,
  collapsible,
}: ClaimJumpBoxProps) {
  const [expanded, setExpanded] = useState(!collapsible);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ClaimHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const term = query.trim();
  // Suppresses the search that would otherwise fire from setQuery('') after a pick.
  const skipNextSearch = useRef(false);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    if (term.length < MIN_CHARS) {
      setHits([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: ClaimHit[] }>(
          `/claims?search=${encodeURIComponent(term)}&limit=${LIMIT}`
        );
        if (cancelled) return;
        setHits(r.data);
        setActive(0);
        setOpen(true);
      } catch {
        if (!cancelled) setHits([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term]);

  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flash = (message: string) => {
    setError(message);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setError(''), 3000);
  };

  const pick = async (claim: ClaimHit) => {
    skipNextSearch.current = true;
    setQuery('');
    setHits([]);
    setOpen(false);
    if (collapsible) setExpanded(false);
    await onPick(claim);
  };

  /** Enter with nothing highlighted: fall back to resolving the typed id on its own — an
   *  exact id wins, otherwise a single partial match is good enough to jump to. */
  const submit = async () => {
    if (!term) return;
    if (open && hits[active]) return pick(hits[active]);
    setBusy(true);
    setError('');
    try {
      const r = await api.get<{ data: ClaimHit[] }>(
        `/claims?search=${encodeURIComponent(term)}&limit=${LIMIT}`
      );
      const exact = r.data.find((c) => c.claimId.toLowerCase() === term.toLowerCase());
      const target = exact ?? (r.data.length === 1 ? r.data[0] : null);
      if (!target) {
        return flash(
          r.data.length ? `${r.data.length} claims match — type the full ID` : 'No claim found'
        );
      }
      await pick(target);
    } catch {
      flash('Search failed');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Escape') {
      setOpen(false);
      if (collapsible && !term) setExpanded(false);
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        title="Go to claim ID"
        aria-label="Go to claim ID"
        aria-expanded={false}
        onClick={() => {
          setExpanded(true);
          // Focus after the input exists, so the click lands straight in the field.
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="flex items-center rounded border p-1.5 text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        <Search className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-gray-400" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        // Combobox semantics: arrow keys moved a highlight nothing announced, so a screen
        // reader user never learned suggestions existed or which one Enter would take.
        role="combobox"
        aria-expanded={open && hits.length > 0}
        // Gated like its two siblings: the <ul> only exists while the list is open, and
        // pointing aria-controls at an absent id is the attribute a future "why is the
        // listbox not announced" debug would trust.
        aria-controls={open && hits.length ? 'claim-jump-list' : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && hits.length ? `claim-jump-opt-${active}` : undefined}
        // Blur closes the list, but a click on a row blurs first — the rows commit on
        // mousedown, so by the time this runs the pick has already happened. An empty
        // collapsible field folds back to its icon rather than sitting there taking width.
        onBlur={() => {
          setOpen(false);
          if (collapsible && !term) setExpanded(false);
        }}
        onFocus={() => hits.length && setOpen(true)}
        placeholder={placeholder ?? 'Go to claim ID…'}
        aria-label="Go to claim ID"
        autoComplete="off"
        className={
          inputClassName ??
          'h-9 w-52 rounded-md border border-gray-200 pl-7 pr-8 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600'
        }
      />
      <button
        type="submit"
        disabled={!term || busy}
        title="Go to this claim"
        className="absolute right-0.5 top-0.5 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <CornerDownLeft className="h-3.5 w-3.5" />
        )}
        <span className="sr-only">Go to this claim</span>
      </button>

      {open && hits.length > 0 && (
        <ul
          id="claim-jump-list"
          role="listbox"
          className="absolute right-0 top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto rounded-md border bg-white py-1 shadow-lg"
        >
          {hits.map((hit, i) => (
            <li
              key={hit.id}
              role="option"
              id={`claim-jump-opt-${i}`}
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(hit);
              }}
              onClick={() => pick(hit)}
              onMouseEnter={() => setActive(i)}
              // blue-50 as the only marker was ~1.05:1 against the dropdown — invisible, on
              // the row Enter commits.
              className={`flex w-full cursor-pointer items-center gap-2 border-l-2 px-2 py-1.5 text-left text-xs ${
                i === active ? 'border-blue-600 bg-blue-100 font-medium' : 'border-transparent'
              }`}
            >
                <span className="min-w-0 flex-1 truncate font-mono text-gray-600">
                  <Highlighted text={hit.claimId} term={term} />
                </span>
                {hit.workflowStatus && (
                  <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                    {hit.workflowStatus.name}
                  </span>
                )}
                {hit.subCategory && (
                  <span className="max-w-[35%] shrink-0 truncate text-[11px] text-gray-600">
                    {hit.subCategory.name}
                  </span>
                )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p
          role="status"
          aria-live="polite"
          className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded bg-red-50 px-2 py-1 text-xs text-red-600 shadow"
        >
          {error}
        </p>
      )}
    </form>
  );
}
