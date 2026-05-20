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
  userTypeId: string;
  projectTypeId: string;
  categoryId: string;
  subCategoryId: string;
}

interface Props {
  value: Partial<SubCategoryPickerValue>;
  onChange: (next: Partial<SubCategoryPickerValue>) => void;
  disabled?: boolean;
}

export function SubCategoryPicker({ value, onChange, disabled }: Props) {
  const [userTypes, setUserTypes] = useState<Option[]>([]);
  const [projectTypes, setProjectTypes] = useState<Option[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [subCategories, setSubCategories] = useState<Option[]>([]);

  useEffect(() => {
    Promise.all([
      api.get<{ data: Option[] }>('/admin/user-types?limit=100&status=ACTIVE'),
      api.get<{ data: Option[] }>('/admin/project-types?limit=100&status=ACTIVE'),
    ]).then(([ut, pt]) => {
      setUserTypes(ut.data);
      setProjectTypes(pt.data);
    });
  }, []);

  useEffect(() => {
    if (value.userTypeId && value.projectTypeId) {
      api
        .get<{ data: Option[] }>(
          `/admin/categories?userTypeId=${value.userTypeId}&projectTypeId=${value.projectTypeId}&limit=200&status=ACTIVE`
        )
        .then((r) => setCategories(r.data));
    } else {
      setCategories([]);
    }
  }, [value.userTypeId, value.projectTypeId]);

  useEffect(() => {
    if (value.categoryId) {
      api
        .get<{ data: Option[] }>(
          `/admin/sub-categories?categoryId=${value.categoryId}&limit=200&status=ACTIVE`
        )
        .then((r) => setSubCategories(r.data));
    } else {
      setSubCategories([]);
    }
  }, [value.categoryId]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label>User Type</Label>
        <Select
          value={value.userTypeId ?? ''}
          onValueChange={(v) =>
            onChange({
              userTypeId: v,
              projectTypeId: undefined,
              categoryId: undefined,
              subCategoryId: undefined,
            })
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select user type" />
          </SelectTrigger>
          <SelectContent>
            {userTypes.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Project Type</Label>
        <Select
          value={value.projectTypeId ?? ''}
          onValueChange={(v) =>
            onChange({
              ...value,
              projectTypeId: v,
              categoryId: undefined,
              subCategoryId: undefined,
            })
          }
          disabled={disabled || !value.userTypeId}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select project type" />
          </SelectTrigger>
          <SelectContent>
            {projectTypes.map((p) => (
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
          disabled={disabled || !value.projectTypeId}
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
