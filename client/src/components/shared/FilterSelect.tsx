import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface FilterOption {
  value: string;
  label: string;
}

/** The ACTIVE/INACTIVE options shared by every admin table's Status filter. */
export const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];

interface FilterSelectProps {
  /** '' means "no filter" (the All option). */
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: FilterOption[];
  className?: string;
  /** Prefix each label, e.g. "Spell: Passed" for the per-check claim filters. */
  prefix?: string;
}

/**
 * A dropdown filter with a first-class "All" option, used across the admin tables.
 * Centralizes the '' (no filter) ↔ 'ALL' (Radix can't hold '') translation in one place
 * so call sites just pass value/onChange without the sentinel juggling.
 */
export function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  className = 'w-[150px]',
  prefix,
}: FilterSelectProps) {
  const withPrefix = (label: string) => (prefix ? `${prefix}: ${label}` : label);
  return (
    <Select value={value || 'ALL'} onValueChange={(v) => onChange(v === 'ALL' ? '' : v)}>
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ALL">{withPrefix(allLabel)}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {withPrefix(o.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
