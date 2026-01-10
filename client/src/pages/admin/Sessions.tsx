import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { Trash2, UserCheck } from 'lucide-react';
import { api, DataResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';

interface Session {
  id: string;
  userId: string;
  username: string;
  fullName: string;
  isAdmin: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  loginTime: string;
  lastActivity: string;
  isImpersonation: boolean;
}

export default function Sessions() {
  const { toast } = useToast();
  const [data, setData] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Session | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<DataResponse<Session[]>>('/admin/sessions');
      setData(response.data);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to fetch data', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const handleTerminate = async () => {
    if (!selectedItem) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/sessions/${selectedItem.id}`);
      toast({ title: 'Success', description: 'Session terminated successfully' });
      setIsDeleteOpen(false);
      fetchData();
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to terminate session', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const formatDuration = (start: string, end: string) => {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  const columns: ColumnDef<Session>[] = [
    {
      accessorKey: 'fullName',
      header: 'User',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.fullName}</div>
          <div className="text-sm text-muted-foreground">{row.original.username}</div>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Badge variant={row.original.isAdmin ? 'default' : 'secondary'}>
            {row.original.isAdmin ? 'Admin' : 'User'}
          </Badge>
          {row.original.isImpersonation && (
            <Badge variant="warning">
              <UserCheck className="w-3 h-3 mr-1" />
              Impersonated
            </Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'ipAddress',
      header: 'IP Address',
      cell: ({ row }) => row.original.ipAddress || '-',
    },
    {
      accessorKey: 'loginTime',
      header: 'Login Time',
      cell: ({ row }) => formatTime(row.original.loginTime),
    },
    {
      id: 'duration',
      header: 'Duration',
      cell: ({ row }) => formatDuration(row.original.loginTime, row.original.lastActivity),
    },
    {
      accessorKey: 'lastActivity',
      header: 'Last Activity',
      cell: ({ row }) => formatTime(row.original.lastActivity),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            setSelectedItem(row.original);
            setIsDeleteOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Terminate
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Active Sessions</h1>
          <p className="text-muted-foreground">
            {data.length} active session{data.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button variant="outline" onClick={fetchData} disabled={isLoading}>
          Refresh
        </Button>
      </div>

      <DataTable columns={columns} data={data} isLoading={isLoading} />

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        title="Terminate Session"
        description={`Are you sure you want to terminate the session for "${selectedItem?.fullName}"? They will be logged out immediately.`}
        confirmText="Terminate"
        onConfirm={handleTerminate}
        variant="destructive"
        isLoading={isSubmitting}
      />
    </div>
  );
}
