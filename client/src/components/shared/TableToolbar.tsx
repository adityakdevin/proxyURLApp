import { useEffect, useState, ReactNode } from 'react';
import { Input } from '@/components/ui/input';

interface TableToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  placeholder?: string;
  /** Filter dropdowns rendered to the right of the search box. */
  children?: ReactNode;
}

/** Debounced search input + a slot for filter controls, shared across the admin tables. */
export function TableToolbar({
  search,
  onSearchChange,
  placeholder = 'Search…',
  children,
}: TableToolbarProps) {
  const [local, setLocal] = useState(search);

  // Keep the local box in sync if the parent resets the search externally.
  useEffect(() => setLocal(search), [search]);

  // Debounce: only push to the parent (which refetches) after the user pauses typing.
  useEffect(() => {
    const t = setTimeout(() => {
      if (local !== search) onSearchChange(local);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="max-w-xs"
      />
      {children}
    </div>
  );
}
