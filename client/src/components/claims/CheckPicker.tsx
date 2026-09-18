import { ChevronDown, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** The checks an operator can tick. META is not here: it is the text extraction every other
 *  check reads, so it always runs. */
export const SELECTABLE_CHECKS = [
  { key: 'SPELL', label: 'Spell' },
  { key: 'QR', label: 'QR' },
  { key: 'INTRA', label: 'Intra-Claim' },
  { key: 'FULL', label: 'Missing Docs' },
  { key: 'REDFLAG', label: 'Red Flags' },
  { key: 'DUP', label: 'Duplicate' },
] as const;

export const ALL_CHECK_KEYS = SELECTABLE_CHECKS.map((c) => c.key) as unknown as string[];

/** What to send to the server: nothing when every check is ticked, so "all" stays the
 *  default the API has always had. */
export const checksPayload = (selected: string[]): string[] | undefined =>
  selected.length === ALL_CHECK_KEYS.length ? undefined : selected;

/**
 * Tick-box picker for which checks a run should perform.
 *
 * "All" leads the list and is ticked by default, per the requirement. Un-ticking everything
 * is not offered: a run with no checks is a run that does nothing, so the last tick cannot
 * be removed — clear it with "All" instead.
 */
export function CheckPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const all = selected.length === ALL_CHECK_KEYS.length;
  const label = all
    ? 'Checks: All'
    : `Checks: ${selected.length === 1 ? SELECTABLE_CHECKS.find((c) => c.key === selected[0])!.label : selected.length}`;

  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
    if (next.length > 0) onChange(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5" title="Choose which checks to run">
          <ListChecks className="h-3.5 w-3.5" />
          {label}
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuCheckboxItem checked={all} onCheckedChange={() => onChange(ALL_CHECK_KEYS)}>
          All
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {SELECTABLE_CHECKS.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.key}
            checked={selected.includes(c.key)}
            onCheckedChange={() => toggle(c.key)}
            // Radix closes the menu on select; ticking several checks in one go should not
            // mean re-opening it each time.
            onSelect={(e) => e.preventDefault()}
          >
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
