import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, DataResponse } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { Link2, Clock, TrendingUp, AlertCircle } from 'lucide-react';

interface FrequentUrl {
  urlConfigId: string;
  label: string;
  opaqueId: string;
  accessCount: number;
}

interface RecentActivity {
  urlConfigId: string;
  label: string;
  opaqueId: string;
  accessedAt: string;
}

interface DashboardData {
  stats: {
    totalUrls: number;
    userType: { id: string; name: string } | null;
    projectType: { id: string; name: string } | null;
  };
  frequentUrls: FrequentUrl[];
  recentActivity: RecentActivity[];
  isActive: boolean;
}

export default function UserDashboard() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDashboard = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<DataResponse<DashboardData>>('/user/dashboard');
      setData(response.data);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load dashboard',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const handleUrlClick = (opaqueId: string) => {
    navigate(`/view/${opaqueId}`);
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
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      {data && !data.isActive && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium text-amber-800">Limited Access</h3>
            <p className="text-sm text-amber-700">
              Your assigned user type or project type is currently inactive. Contact an administrator for assistance.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Stats Card */}
        <div className="bg-white p-6 rounded-lg shadow border">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-50 rounded-lg">
              <Link2 className="h-5 w-5 text-blue-600" />
            </div>
            <h3 className="text-sm text-gray-500 font-medium">Accessible URLs</h3>
          </div>
          <p className="text-3xl font-bold">{data?.stats.totalUrls ?? 0}</p>
          {data?.stats.userType && data?.stats.projectType && (
            <p className="text-sm text-gray-500 mt-2">
              {data.stats.userType.name} / {data.stats.projectType.name}
            </p>
          )}
        </div>

        {/* Frequently Accessed */}
        <div className="bg-white p-6 rounded-lg shadow border md:col-span-2">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-50 rounded-lg">
              <TrendingUp className="h-5 w-5 text-green-600" />
            </div>
            <h3 className="text-sm text-gray-500 font-medium">Frequently Accessed</h3>
          </div>
          {data?.frequentUrls && data.frequentUrls.length > 0 ? (
            <div className="space-y-2">
              {data.frequentUrls.map((url, index) => (
                <button
                  key={url.urlConfigId}
                  onClick={() => handleUrlClick(url.opaqueId)}
                  className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 text-left transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-gray-400 w-6">{index + 1}.</span>
                    <span className="text-sm font-medium text-gray-900">{url.label}</span>
                  </div>
                  <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                    {url.accessCount} visits
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm">No URLs accessed yet</p>
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="mt-6 bg-white p-6 rounded-lg shadow border">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-purple-50 rounded-lg">
            <Clock className="h-5 w-5 text-purple-600" />
          </div>
          <h3 className="text-sm text-gray-500 font-medium">Recent Activity</h3>
        </div>
        {data?.recentActivity && data.recentActivity.length > 0 ? (
          <div className="space-y-2">
            {data.recentActivity.map((activity) => (
              <button
                key={`${activity.urlConfigId}-${activity.accessedAt}`}
                onClick={() => handleUrlClick(activity.opaqueId)}
                className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 text-left transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Link2 className="h-4 w-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-900">{activity.label}</span>
                </div>
                <span className="text-xs text-gray-500">{formatDate(activity.accessedAt)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-sm">No recent activity</p>
        )}
      </div>

      {/* Quick Access Hint */}
      {data?.stats.totalUrls && data.stats.totalUrls > 0 && (
        <div className="mt-6 bg-blue-50 rounded-lg p-4">
          <p className="text-sm text-blue-700">
            <strong>Tip:</strong> Use the sidebar menu to browse your available URLs.
            Click on a category to expand it, then click a sub-category to view all its URLs.
          </p>
        </div>
      )}
    </div>
  );
}
