import { useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/button';
import {
  FolderTree,
  Folder,
  Link2,
  User,
  LogOut,
  LayoutDashboard,
  Briefcase,
  FileText,
  Crosshair,
  ClipboardList,
  BookText,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';

/** Remembered across pages and reloads: a reviewer who wants the width keeps it. */
const COLLAPSED_KEY = 'adminSidebarCollapsed';

type NavItem = { path: string; label: string; icon: LucideIcon; exact?: boolean };

const navItems: NavItem[] = [
  { path: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { path: '/admin/projects', label: 'Projects', icon: Briefcase },
  { path: '/admin/users', label: 'Users', icon: User },
  { path: '/admin/categories', label: 'Categories', icon: FolderTree },
  { path: '/admin/sub-categories', label: 'Sub-Categories', icon: Folder },
  { path: '/admin/url-configs', label: 'URL Configs', icon: Link2 },
];

const claimsNavItems: NavItem[] = [
  { path: '/admin/doc-type-masters', label: 'Doc Type Masters', icon: FileText },
  { path: '/admin/claim-id-rules', label: 'Claim ID Rules', icon: Crosshair },
  { path: '/admin/spell-terms', label: 'Spell Dictionary', icon: BookText },
  { path: '/admin/claims', label: 'Claims Dashboard', icon: ClipboardList },
];

export default function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

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

  const isActive = (path: string, exact = false) => {
    if (exact) return location.pathname === path;
    return location.pathname.startsWith(path);
  };

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const toggleSidebar = () =>
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      return !c;
    });

  // Collapsed, the label is gone from the page but not from the accessibility tree, and the
  // tooltip says what the icon is — otherwise the rail is a column of guesses.
  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    return (
      <Link
        key={item.path}
        to={item.path}
        title={collapsed ? item.label : undefined}
        className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
          collapsed ? 'justify-center' : ''
        } ${
          isActive(item.path, item.exact)
            ? 'bg-gray-100 text-gray-900 font-medium'
            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
        }`}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-50">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={toggleSidebar}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              className="rounded p-1.5 text-gray-600 hover:bg-gray-100"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
            <h1 className="text-xl font-bold">Proxy URL App</h1>
            <span className="text-sm text-gray-500">Admin Panel</span>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/admin/profile" className="text-sm text-gray-600 hover:text-gray-900">
              {user?.fullName}
            </Link>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside
          className={`sticky top-[57px] min-h-[calc(100vh-57px)] shrink-0 border-r bg-white transition-[width] duration-200 ${
            collapsed ? 'w-16' : 'w-64'
          }`}
        >
          <nav className={`space-y-1 py-4 ${collapsed ? 'px-2' : 'px-4'}`}>
            {navItems.map(renderItem)}

            {/* Collapsed there is no room for the heading, so the rail keeps the grouping
                with a rule instead of dropping it. */}
            {collapsed ? (
              <div className="mx-2 my-3 border-t" />
            ) : (
              <div className="mt-6 mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Claims Config
              </div>
            )}
            {claimsNavItems.map(renderItem)}
          </nav>
        </aside>

        {/* Main content */}
        {/* min-w-0: a flex child defaults to min-width:auto, so a wide table would push the
            whole page sideways instead of scrolling inside its own container. */}
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
