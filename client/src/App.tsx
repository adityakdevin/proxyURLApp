import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { useAuthStore } from '@/stores/authStore';

// Auth pages
import Login from '@/pages/auth/Login';
import ChangePassword from '@/pages/auth/ChangePassword';

// Admin pages
import AdminLayout from '@/components/layout/AdminLayout';
import AdminDashboard from '@/pages/admin/Dashboard';
import Projects from '@/pages/admin/Projects';
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

// Claims pages (admin + user share Update page)
import StatusMasters from '@/pages/admin/StatusMasters';
import DocumentTypeMasters from '@/pages/admin/DocumentTypeMasters';
import ClaimIdRules from '@/pages/admin/ClaimIdRules';
import ClaimRules from '@/pages/admin/ClaimRules';
import SpellTerms from '@/pages/admin/SpellTerms';
import AdminClaims from '@/pages/admin/AdminClaims';
import Sessions from '@/pages/admin/Sessions';
import ClaimDashboard from '@/pages/claims/ClaimDashboard';
import ClaimUpdate from '@/pages/claims/ClaimUpdate';
import DocumentView from '@/pages/claims/DocumentView';

function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole?: 'TEAM_LEAD' | 'ADMIN';
}) {
  const { user, isAuthenticated } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.forcePasswordChange) {
    return <Navigate to="/change-password" replace />;
  }

  if (requiredRole === 'ADMIN' && user?.role !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />;
  }
  if (requiredRole === 'TEAM_LEAD' && user?.role !== 'TEAM_LEAD' && user?.role !== 'ADMIN') {
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
            <ProtectedRoute requiredRole="ADMIN">
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<AdminDashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="users" element={<Users />} />
          <Route path="categories" element={<Categories />} />
          <Route path="sub-categories" element={<SubCategories />} />
          <Route path="url-configs" element={<UrlConfigs />} />
          <Route path="profile" element={<Profile />} />
          <Route path="status-masters" element={<StatusMasters />} />
          <Route path="doc-type-masters" element={<DocumentTypeMasters />} />
          <Route path="claim-id-rules" element={<ClaimIdRules />} />
          <Route path="claim-rules" element={<ClaimRules />} />
          <Route path="spell-terms" element={<SpellTerms />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="claims" element={<AdminClaims />} />
          <Route path="claims/:id" element={<ClaimUpdate />} />
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
          <Route path="claims" element={<ClaimDashboard />} />
          <Route path="claims/:id" element={<ClaimUpdate />} />
        </Route>

        {/* Document viewer — its own window, opened from the claim page (no layout) */}
        <Route
          path="/claims/:id/documents/:documentId"
          element={
            <ProtectedRoute>
              <DocumentView />
            </ProtectedRoute>
          }
        />

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
