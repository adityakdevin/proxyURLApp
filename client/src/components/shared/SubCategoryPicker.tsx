import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Option {
  id: string;
  name: string;
}

export interface SubCategoryPickerValue {
  projectId: string;
  categoryId: string;
  subCategoryId: string;
}

interface Props {
  value: Partial<SubCategoryPickerValue>;
  onChange: (next: Partial<SubCategoryPickerValue>) => void;
  disabled?: boolean;
}

export function SubCategoryPicker({ value, onChange, disabled }: Props) {
  const [projects, setProjects] = useState<Option[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [subCategories, setSubCategories] = useState<Option[]>([]);

  useEffect(() => {
    api
      .get<{ data: Option[] }>('/admin/projects?limit=100&status=ACTIVE')
      .then((pt) => {
        setProjects(pt.data);
      })
      .catch((e) => console.error('SubCategoryPicker: load projects failed', e));
  }, []);

  useEffect(() => {
    if (value.projectId) {
      api
        .get<{ data: Option[] }>(
          `/admin/categories?projectId=${value.projectId}&limit=100&status=ACTIVE`
        )
        .then((r) => setCategories(r.data))
        .catch((e) => console.error('SubCategoryPicker: load categories failed', e));
    } else {
      setCategories([]);
    }
  }, [value.projectId]);

  useEffect(() => {
    if (value.categoryId) {
      api
        .get<{ data: Option[] }>(
          `/admin/sub-categories?categoryId=${value.categoryId}&limit=100&status=ACTIVE`
        )
        .then((r) => setSubCategories(r.data))
        .catch((e) => console.error('SubCategoryPicker: load sub-categories failed', e));
    } else {
      setSubCategories([]);
    }
  }, [value.categoryId]);

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="space-y-1">
        <Label>Project</Label>
        <Select
          value={value.projectId ?? ''}
          onValueChange={(v) =>
            onChange({
              projectId: v,
              categoryId: undefined,
              subCategoryId: undefined,
            })
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Category</Label>
        <Select
          value={value.categoryId ?? ''}
          onValueChange={(v) =>
            onChange({ ...value, categoryId: v, subCategoryId: undefined })
          }
          disabled={disabled || !value.projectId}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select category" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Sub-Category</Label>
        <Select
          value={value.subCategoryId ?? ''}
          onValueChange={(v) => onChange({ ...value, subCategoryId: v })}
          disabled={disabled || !value.categoryId}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select sub-category" />
          </SelectTrigger>
          <SelectContent>
            {subCategories.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
