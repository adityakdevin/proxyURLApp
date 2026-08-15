import { useState, useEffect } from 'react';
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { api, DataResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import {
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  LogOut,
  Home,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  AlertCircle,
  Loader2,
  UserCheck,
  X,
  ClipboardList,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface UrlItem {
  id: string;
  label: string;
  description: string | null;
  opaqueId: string;
}

interface SubCategory {
  id: string;
  name: string;
  description: string | null;
  urls: UrlItem[];
}

interface Category {
  id: string;
  name: string;
  description: string | null;
  subCategories: SubCategory[];
}

interface MenuData {
  menu: Category[];
  project: { id: string; name: string } | null;
  message?: string;
}

export default function UserLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { user, logout, setUser } = useAuthStore();

  const [menuData, setMenuData] = useState<MenuData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [isExiting, setIsExiting] = useState(false);

  const fetchMenu = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<DataResponse<MenuData>>('/user/menu');
      setMenuData(response.data);
    } catch (error) {
      console.error('Failed to fetch menu:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMenu();
  }, []);

  // Expand first category by default when menu loads
  useEffect(() => {
    if (menuData?.menu && menuData.menu.length > 0 && expandedCategories.size === 0) {
      setExpandedCategories(new Set([menuData.menu[0].id]));
    }
  }, [menuData]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      logout();
      navigate('/login');
    }
  };

  const handleExitImpersonation = async () => {
    setIsExiting(true);
    try {
      const response = await api.post<{ user: typeof user }>('/auth/exit-impersonation', {});
      setUser(response.user);
      toast({ title: 'Impersonation ended', description: 'Returning to admin panel' });
      navigate('/admin');
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to exit impersonation',
        variant: 'destructive',
      });
    } finally {
      setIsExiting(false);
    }
  };

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const handleSubCategoryClick = (subCategoryId: string) => {
    navigate(`/subcategory/${subCategoryId}`);
  };

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-gray-50">
        {/* Impersonation Banner */}
        {user?.impersonatedBy && (
          <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between sticky top-0 z-[60]">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4" />
              <span className="text-sm font-medium">
                You are viewing as <strong>{user.fullName}</strong> ({user.username})
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExitImpersonation}
              disabled={isExiting}
              className="bg-white text-amber-700 hover:bg-amber-50"
            >
              {isExiting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <X className="h-4 w-4 mr-2" />
              )}
              Exit Impersonation
            </Button>
          </div>
        )}

        {/* Header */}
        <header className={cn(
          "bg-white border-b sticky z-50",
          user?.impersonatedBy ? "top-[44px]" : "top-0"
        )}>
          <div className="flex items-center justify-between px-6 py-3">
            <div className="flex items-center gap-4">
              <h1 className="text-xl font-bold">Proxy URL App</h1>
              {menuData?.project && (
                <span className="text-sm text-gray-500">
                  {menuData.project.name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{user?.fullName}</span>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
            </div>
          </div>
        </header>

        <div className="flex">
          {/* Sidebar - Dynamic menu */}
          <aside className={cn(
            "w-64 bg-white border-r min-h-[calc(100vh-57px)] sticky overflow-y-auto",
            user?.impersonatedBy ? "top-[101px]" : "top-[57px]"
          )}>
            <nav className="p-4 space-y-1">
              <Link
                to="/dashboard"
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm hover:bg-gray-50',
                  location.pathname === '/dashboard'
                    ? 'bg-gray-100 text-gray-900 font-medium'
                    : 'text-gray-600 hover:text-gray-900'
                )}
              >
                <Home className="h-4 w-4" />
                Dashboard
              </Link>

              <div className="pt-4 mt-4 border-t">
                <span className="px-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Claims
                </span>
                <div className="mt-2">
                  <Link
                    to="/claims"
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                      location.pathname.startsWith('/claims')
                        ? 'bg-gray-100 text-gray-900 font-medium'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    )}
                  >
                    <ClipboardList className="h-4 w-4" />
                    Claim Dashboard
                  </Link>
                </div>
              </div>

              {isLoading && (
                <div className="flex items-center gap-2 px-3 py-4 text-gray-400 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading menu...
                </div>
              )}

              {!isLoading && menuData?.message && (
                <div className="flex items-start gap-2 px-3 py-3 text-amber-600 text-sm bg-amber-50 rounded-md">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{menuData.message}</span>
                </div>
              )}

              {!isLoading && menuData?.menu.length === 0 && !menuData?.message && (
                <div className="text-xs text-gray-400 px-3 py-4">
                  No URLs available for your account
                </div>
              )}

              {!isLoading && menuData && menuData.menu.length > 0 && (
                <div className="pt-4 border-t mt-4">
                  <span className="px-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    My URLs
                  </span>
                  <div className="mt-2 space-y-1">
                    {menuData.menu.map((category) => (
                      <div key={category.id}>
                        {/* Category */}
                        <button
                          onClick={() => toggleCategory(category.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md"
                        >
                          {expandedCategories.has(category.id) ? (
                            <>
                              <ChevronDown className="h-4 w-4 text-gray-400" />
                              <FolderOpen className="h-4 w-4 text-blue-500" />
                            </>
                          ) : (
                            <>
                              <ChevronRight className="h-4 w-4 text-gray-400" />
                              <Folder className="h-4 w-4 text-gray-400" />
                            </>
                          )}
                          <span className="truncate font-medium">{category.name}</span>
                        </button>

                        {/* Sub-Categories */}
                        {expandedCategories.has(category.id) && (
                          <div className="ml-7 space-y-0.5 mt-1">
                            {category.subCategories.map((subCategory) => (
                              <button
                                key={subCategory.id}
                                onClick={() => handleSubCategoryClick(subCategory.id)}
                                className={cn(
                                  'w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md',
                                  location.pathname === `/subcategory/${subCategory.id}`
                                    ? 'bg-blue-50 text-blue-600 font-medium'
                                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                                )}
                              >
                                <span className="w-1 h-1 rounded-full bg-current shrink-0 opacity-50" />
                                <span className="truncate">{subCategory.name}</span>
                                <span className="ml-auto text-xs text-gray-400">
                                  {subCategory.urls.length}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </nav>
          </aside>

          {/* Main content */}
          {/* min-w-0: a flex child defaults to min-width:auto, so a wide table would push
              the whole page sideways instead of scrolling inside its own container. */}
          <main className="min-w-0 flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
