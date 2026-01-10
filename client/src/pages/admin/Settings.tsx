import { useState, useEffect } from 'react';
import { api, DataResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import { Save } from 'lucide-react';

interface Settings {
  audit_retention_days?: string;
}

export default function Settings() {
  const { toast } = useToast();
  const [, setSettings] = useState<Settings>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    audit_retention_days: '90',
  });

  const fetchSettings = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<DataResponse<Settings>>('/admin/settings');
      setSettings(response.data);
      setFormData({
        audit_retention_days: response.data.audit_retention_days || '90',
      });
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to load settings', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.put('/admin/settings', {
        audit_retention_days: parseInt(formData.audit_retention_days, 10),
      });
      toast({ title: 'Success', description: 'Settings saved successfully' });
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to save settings', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <div className="max-w-xl">
        <div className="bg-white p-6 rounded-lg border">
          <h2 className="text-lg font-semibold mb-4">Audit Log Settings</h2>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="retention">Retention Period (days)</Label>
              <Input
                id="retention"
                type="number"
                min="1"
                max="365"
                value={formData.audit_retention_days}
                onChange={(e) => setFormData({ ...formData, audit_retention_days: e.target.value })}
              />
              <p className="text-sm text-muted-foreground">
                Audit logs older than this many days will be automatically deleted. (1-365 days)
              </p>
            </div>

            <Button onClick={handleSave} disabled={isSaving}>
              <Save className="mr-2 h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
