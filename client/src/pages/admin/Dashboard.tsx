import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, PaginatedResponse } from '@/lib/api';
import { Users, Briefcase, Link2, FolderTree, Monitor, Activity } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

interface Stats {
  userTypes: number;
  projectTypes: number;
  users: number;
  urlConfigs: number;
  categories: number;
  sessions: number;
}

export default function AdminDashboard() {
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats>({
    userTypes: 0,
    projectTypes: 0,
    users: 0,
    urlConfigs: 0,
    categories: 0,
    sessions: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = async () => {
    setIsLoading(true);
    try {
      const [userTypes, projectTypes, users, urlConfigs, categories, sessions] = await Promise.all([
        api.get<PaginatedResponse<unknown>>('/admin/user-types?limit=1'),
        api.get<PaginatedResponse<unknown>>('/admin/project-types?limit=1'),
        api.get<PaginatedResponse<unknown>>('/admin/users?limit=1'),
        api.get<PaginatedResponse<unknown>>('/admin/url-configs?limit=1'),
        api.get<PaginatedResponse<unknown>>('/admin/categories?limit=1'),
        api.get<{ data: unknown[] }>('/admin/sessions'),
      ]);

      setStats({
        userTypes: userTypes.pagination.total,
        projectTypes: projectTypes.pagination.total,
        users: users.pagination.total,
        urlConfigs: urlConfigs.pagination.total,
        categories: categories.pagination.total,
        sessions: sessions.data.length,
      });
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to load dashboard stats', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const statCards = [
    { label: 'User Types', value: stats.userTypes, icon: Users, link: '/admin/user-types', color: 'text-blue-600' },
    { label: 'Project Types', value: stats.projectTypes, icon: Briefcase, link: '/admin/project-types', color: 'text-green-600' },
    { label: 'Users', value: stats.users, icon: Users, link: '/admin/users', color: 'text-purple-600' },
    { label: 'Categories', value: stats.categories, icon: FolderTree, link: '/admin/categories', color: 'text-orange-600' },
    { label: 'URL Configs', value: stats.urlConfigs, icon: Link2, link: '/admin/url-configs', color: 'text-red-600' },
    { label: 'Active Sessions', value: stats.sessions, icon: Monitor, link: '/admin/sessions', color: 'text-cyan-600' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.label}
              to={card.link}
              className="bg-white p-6 rounded-lg shadow hover:shadow-md transition-shadow border"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm text-gray-500 font-medium">{card.label}</h3>
                  <p className="text-3xl font-bold mt-1">
                    {isLoading ? (
                      <span className="inline-block w-8 h-8 bg-gray-200 rounded animate-pulse"></span>
                    ) : (
                      stats[card.label.toLowerCase().replace(' ', '') as keyof Stats] ?? card.value
                    )}
                  </p>
                </div>
                <div className={`${card.color} bg-gray-50 p-3 rounded-full`}>
                  <Icon className="h-6 w-6" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-lg shadow border">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <Link to="/admin/users" className="p-3 border rounded-lg hover:bg-gray-50 text-center">
              <Users className="h-5 w-5 mx-auto mb-1" />
              <span className="text-sm">Manage Users</span>
            </Link>
            <Link to="/admin/url-configs" className="p-3 border rounded-lg hover:bg-gray-50 text-center">
              <Link2 className="h-5 w-5 mx-auto mb-1" />
              <span className="text-sm">URL Configs</span>
            </Link>
            <Link to="/admin/sessions" className="p-3 border rounded-lg hover:bg-gray-50 text-center">
              <Monitor className="h-5 w-5 mx-auto mb-1" />
              <span className="text-sm">Sessions</span>
            </Link>
            <Link to="/admin/audit-logs" className="p-3 border rounded-lg hover:bg-gray-50 text-center">
              <Activity className="h-5 w-5 mx-auto mb-1" />
              <span className="text-sm">Audit Logs</span>
            </Link>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border">
          <h2 className="text-lg font-semibold mb-4">System Overview</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">Total URL Configurations</span>
              <span className="font-medium">{stats.urlConfigs}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">Active Users Online</span>
              <span className="font-medium">{stats.sessions}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">User Types</span>
              <span className="font-medium">{stats.userTypes}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-gray-500">Project Types</span>
              <span className="font-medium">{stats.projectTypes}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
