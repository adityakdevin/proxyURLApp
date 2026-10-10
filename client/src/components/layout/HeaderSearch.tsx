import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

export interface SearchHit {
  key: string;
  label: string;
  hint?: string;
}

interface Props {
  /** Resolves matches for a non-empty query. */
  find: (query: string) => Promise<SearchHit[]> | SearchHit[];
  onPick: (hit: SearchHit) => void;
  placeholder?: string;
}

export default function HeaderSearch({ find, onPick, placeholder = 'Search URLs…' }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const found = await find(q);
        if (!stale) setHits(found);
      } catch {
        if (!stale) setHits([]);
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (hit: SearchHit) => {
    setOpen(false);
    setQuery('');
    onPick(hit);
  };

  return (
    <div ref={box} className="relative w-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && hits[0]) pick(hits[0]);
        }}
        placeholder={placeholder}
        aria-label="Search"
        className="h-9 pl-9"
      />
      {open && query.trim() && (
        <ul className="absolute right-0 top-full z-50 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border bg-white py-1 shadow-lg">
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-500">No matches</li>
          ) : (
            hits.map((h) => (
              <li key={h.key}>
                <button
                  type="button"
                  onClick={() => pick(h)}
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                >
                  <span className="block text-sm text-gray-900">{h.label}</span>
                  {h.hint && <span className="block text-xs text-gray-500">{h.hint}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
