import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { useAuthStore } from '@/stores/authStore';

// Auth pages
import Login from '@/pages/auth/Login';
import ChangePassword from '@/pages/auth/ChangePassword';

// Admin pages
import AdminLayout from '@/components/layout/AdminLayout';
import AdminDashboard from '@/pages/admin/Dashboard';
import UserTypes from '@/pages/admin/UserTypes';
import ProjectTypes from '@/pages/admin/ProjectTypes';
import Users from '@/pages/admin/Users';
import Categories from '@/pages/admin/Categories';
import SubCategories from '@/pages/admin/SubCategories';
import UrlConfigs from '@/pages/admin/UrlConfigs';
import Profile from '@/pages/admin/Profile';

// User pages
import UserLayout from '@/components/layout/UserLayout';
import UserDashboard from '@/pages/user/Dashboard';
import SubCategoryUrls from '@/pages/user/SubCategoryUrls';
import ProxyView from '@/pages/user/ProxyView';

function ProtectedRoute({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, isAuthenticated } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.forcePasswordChange) {
    return <Navigate to="/change-password" replace />;
  }

  if (adminOnly && !user?.isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<ChangePassword />} />

        {/* Admin routes */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute adminOnly>
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<AdminDashboard />} />
          <Route path="user-types" element={<UserTypes />} />
          <Route path="project-types" element={<ProjectTypes />} />
          <Route path="users" element={<Users />} />
          <Route path="categories" element={<Categories />} />
          <Route path="sub-categories" element={<SubCategories />} />
          <Route path="url-configs" element={<UrlConfigs />} />
          <Route path="profile" element={<Profile />} />
        </Route>

        {/* User routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <UserLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<UserDashboard />} />
          <Route path="subcategory/:subCategoryId" element={<SubCategoryUrls />} />
        </Route>

        {/* Proxy view (full page, no layout) */}
        <Route
          path="/view/:opaqueId"
          element={
            <ProtectedRoute>
              <ProxyView />
            </ProtectedRoute>
          }
        />

        {/* Catch all */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}

export default App;
