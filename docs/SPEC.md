# Proxy URL App – Technical Specification (SPEC)

## 1. Overview

The Proxy URL App is a web-based application that provides controlled access to external or internal URLs through a proxy mechanism. Access is governed by Projects, User Types, Categories, and Sub-Categories, with complete audit logging for security and traceability.

---

## 2. Technology Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js with Express |
| Frontend | React |
| Database | PostgreSQL |
| Password Hashing | bcrypt |
| Protocol | HTTPS only (all environments) |

---

## 3. User Roles

### 3.1 Admin
- Managed via database seed script only (no UI to create admins)
- Full access to all master data management
- Reviews audit logs
- Manages user sessions (view active sessions, force terminate)
- Impersonates end users for troubleshooting (sees exactly what user sees; all actions logged as "admin as user")
- All admins have equal permissions (flat hierarchy)
- Completely separate from User Type + Project assignment system
- Can manage own profile (full name, password)

### 3.2 End User
- Logs in to the system
- Views dynamically generated menus based on assigned Project + User Type
- Accesses proxy URLs based on permissions
- Has a single Project + User Type assignment (future: multiple pairs)

---

## 4. Application Architecture

### 4.1 Single Application Structure
- Single application with role-based views
- Admin features accessible under `/admin` route prefix
- User features under root routes
- Single login page for all users; redirect based on role after authentication

### 4.2 Initial Setup
- First admin account created via database seed script
- Additional admins created via seed script only (no admin creation UI)
- Seed script creates admin with known credentials (to be changed on first use)

---

## 5. Authentication & Session Management

### 5.1 Login
- Username and password-based authentication
- Single login page for admins and end users
- Post-login redirect: admins to `/admin`, users to `/dashboard`
- No "forgot password" feature (admin must manually reset)
- No "remember me" option
- Usernames globally unique across admins and end users

### 5.2 Password Policy
- Minimum 8 characters
- Must contain uppercase letter
- Must contain lowercase letter
- Must contain number

### 5.3 Account Lockout
- Lock after 5 failed login attempts
- Progressive delay after each failed attempt (1s, 2s, 4s, 8s...)
- Auto-unlock after 15 minutes
- Same rules apply to admin accounts

### 5.4 Session Behavior
| Setting | Value |
|---------|-------|
| Idle timeout | 30 minutes |
| Concurrent sessions | Single session only (new login invalidates previous) |
| Password change | Invalidates all sessions (including current), must re-login |
| Session storage | Server-side with secure session ID |
| Parallel tabs | Allowed; all tabs share same session with unified last-activity |

### 5.5 Initial Password Flow
- Admin sets temporary password when creating user
- User forced to change password on first login
- Dedicated full page for password change (cannot navigate away until changed)

### 5.6 Session Termination Triggers
- User deactivation
- Project deactivation (immediate termination for all affected users)
- User Type deactivation (immediate termination for all affected users)
- Password change
- Manual termination by admin

---

## 6. Data Model

### 6.1 Entity Hierarchy

```
User Type (standalone master, globally unique names)
Project (standalone master, globally unique names)

Category
  - References: User Type + Project (both required)
  - Each Category belongs to exactly one User Type + Project pair
  - Same category name can exist as separate records for different pairs

Sub-Category
  - References: Parent Category
  - Inherits User Type + Project from parent Category

URL Configuration
  - References: User Type + Project + Category + Sub-Category (all explicit, with validation)
  - Contains: target_url, label (display name), description (optional)
  - Opaque ID auto-generated (UUID) for URL masking

Users (End Users)
  - Has single Project + User Type assignment (mandatory at creation)
  - Stored in junction table for future multi-assignment support
```

### 6.2 Scope Rules

| Entity | Scope |
|--------|-------|
| User Types | Global, standalone master |
| Projects | Global, standalone master |
| Categories | Per User Type + Project pair |
| Sub-Categories | Per Category (inherits parent's scope) |
| URL Configurations | Per Category + Sub-Category (validated against parent scopes) |
| End Users | Single Project + User Type assignment |
| Admins | No assignments; full system access |

### 6.3 Audit Fields (All Entities)

Every master entity includes:
- `created_at` (timestamp)
- `updated_at` (timestamp)
- `created_by` (user reference)
- `updated_by` (user reference)

Note: Audit fields stored in database but hidden from admin UI.

### 6.4 Soft Delete vs Hard Delete

- Both options available (deactivate or delete)
- Deactivate: Sets status to inactive, can be reactivated
- Delete: Permanent removal from database
- **Deletion blocked for entities with dependencies:**
  - Cannot delete User Type if users assigned to it
  - Cannot delete Project if users or categories reference it
  - Cannot delete Category if sub-categories exist
  - Cannot delete Sub-Category if URL configs exist
- When User Type or Project deactivated: dependent Categories, URLs become hidden from menus

### 6.5 Status Values

All entities use binary status: `active` or `inactive`

---

## 7. Admin Panel Modules

### 7.1 User Type Master

**Purpose:** Define user roles/types as standalone entities

**Features:**
- CRUD operations
- Names must be globally unique
- Deletion blocked if users are assigned

**Fields:**
- User type name (unique)
- Description
- Status (active/inactive)
- Audit fields

---

### 7.2 Project Master

**Purpose:** Define projects as standalone entities

**Features:**
- CRUD operations
- Names must be globally unique
- Deletion blocked if users or categories reference it

**Fields:**
- Project name (unique)
- Description
- Status (active/inactive)
- Audit fields

---

### 7.3 Users Master

**Purpose:** Manage end users

**Features:**
- Create and manage users (one at a time via UI)
- Assign User Type and Project (both mandatory at creation)
- Two independent dropdowns for assignment (not cascading)
- Dropdowns show only active User Types and Projects
- Activate/deactivate/delete users
- Deactivation immediately terminates user's active sessions
- Deletion removes all user's audit log entries

**Fields:**
- Username (globally unique)
- Password (bcrypt hashed)
- Full name
- User Type reference (required)
- Project reference (required)
- Status (active/inactive)
- Force password change flag
- Failed login attempts
- Locked until timestamp
- Audit fields

---

### 7.4 Category Master

**Purpose:** Define menu categories scoped to User Type + Project pairs

**Features:**
- CRUD operations
- Requires both User Type AND Project selection (independent dropdowns)
- Same category name can exist as separate records for different pairs
- Dropdowns show only active User Types and Projects
- Deletion blocked if sub-categories exist
- Cannot change User Type or Project if sub-categories exist
- Display order: alphabetical by name

**List View:**
- Columns: Category Name, User Type, Project, Status
- Filters: User Type, Project (both available)
- Search: Per-list search box

**Fields:**
- Category name
- User Type reference (required)
- Project reference (required)
- Description
- Status (active/inactive)
- Audit fields

---

### 7.5 Sub-Category Master

**Purpose:** Define nested menu items under categories

**Features:**
- CRUD operations
- Linked to parent category
- Inherits User Type + Project from parent Category
- Deletion blocked if URL configurations exist
- Display order: alphabetical by name

**List View:**
- Columns: Sub-Category Name, Category, User Type, Project, Status (full context)
- Filters: User Type, Project, Category
- Search: Per-list search box

**Fields:**
- Sub-category name
- Parent category reference
- Description
- Status (active/inactive)
- Audit fields

---

### 7.6 URL Configurations

**Purpose:** Configure proxy URLs accessible through the system

**Features:**
- Define target URL (actual destination)
- Explicit selection of all four fields: User Type, Project, Category, Sub-Category
- **Cascading filters:** Select User Type + Project first → Category dropdown filters to matching categories → Sub-Category dropdown filters to selected category's children
- System validates all selections align
- Opaque ID (UUID) auto-generated on creation for URL masking
- Enable/disable access
- Same target URL can exist multiple times with different mappings
- Changes take immediate effect (no caching)
- Disabled URLs hidden completely from menus

**List View:**
- Columns: Label, Target URL, User Type, Project, Category, Sub-Category, Status
- Filters: User Type, Project, Category, Sub-Category, Status (all available)
- Search: Per-list search box

**Fields:**
- Label (display name shown to users)
- Description (optional; shown as tooltip in user menu)
- Target URL
- User Type reference (required)
- Project reference (required)
- Category reference (required)
- Sub-category reference (required)
- Opaque ID (auto-generated UUID)
- Status (active/inactive)
- Audit fields

---

### 7.7 Session Management

**Purpose:** Monitor and manage active user sessions

**Features:**
- View list of currently active sessions (both admin and end user sessions)
- Display: username, role, IP address, login time, last activity
- Force terminate any session
- Bulk terminate sessions by user

---

### 7.8 Audit Log Report

**Purpose:** Administrative visibility into user access activity

**Features:**
- View-only access (no modification)
- No export capability
- Logs user access to proxy URLs only (not admin config changes)
- Logs successful access only (not denied attempts)
- Async fire-and-forget logging (non-blocking)

**Captured Data:**
- User identity
- User Type ID (from user's assignment at time of access)
- Project ID (from user's assignment at time of access)
- URL accessed (display name + target)
- Timestamp (displayed in user's local timezone)
- IP address
- User agent
- Request method (GET, POST, etc.)
- Response status code
- Request duration (ms)

**Filters:**
- Filter by user
- Filter by User Type
- Filter by Project
- Filter by date range
- Filter by URL
- Filter by response status

---

### 7.9 Settings

**Purpose:** System configuration

**Features:**
- Minimal configuration scope
- Audit log retention period (days)

---

### 7.10 Admin Profile

**Purpose:** Self-management for admin user

**Features:**
- Update own full name
- Change own password

---

## 8. User Panel Modules

### 8.1 Landing Page (Dashboard)

**Purpose:** Entry point after login

**Features:**
- Summary dashboard with:
  - Total accessible URLs count (single number)
  - Frequently Accessed: Top 5 most accessed URLs (all time), showing label only
  - Recent Activity: Last 5 accessed URLs, showing label + timestamp
- All scoped automatically to user's assigned Project + User Type

---

### 8.2 Dynamic Menu

**Purpose:** Show accessible URLs based on user permissions

**Location:** Left sidebar

**Features:**
- Menu generated based on user's assigned Project + User Type
- Hierarchical display: Category → Sub-Category → URL items (3 levels)
- Alphabetical ordering at each level
- **Auto-expand behavior:** Expanding Category auto-expands all its Sub-Categories
- Show all Categories/Sub-Categories even if empty (no URLs yet)
- URL label displayed; description shown as tooltip on hover
- No search/filter functionality
- Unauthorized/disabled items hidden completely
- Deep linking supported (bookmarked URLs load after login)

**Future (multi-pair support):** Categories grouped by Project headers when user has multiple assignments

---

### 8.3 Proxied Content Display

**Purpose:** Show target URL content through proxy

**Display Mode:** Full page
- App header and sidebar disappear when viewing proxied content
- Proxied content takes entire viewport
- Floating "Exit" button in corner to return to menu
- Navigation back via browser controls or floating button

**Browser Navigation:**
- Native browser history behavior
- Back/forward works naturally with proxied content history

---

## 9. Proxy Server Configuration

### 9.1 Proxy Behavior

| Setting | Value |
|---------|-------|
| Mode | Transparent pass-through |
| Content rewriting | None (forwards request/response as-is) |
| Custom headers | None (no header injection) |
| Timeout | 60 seconds |
| HTTP methods | All allowed (GET, POST, PUT, DELETE, PATCH, etc.) |
| File downloads | Allowed, no size limit |
| Parallel access | Allowed (multiple proxied URLs in separate tabs) |
| Rate limiting | None |

### 9.2 URL Masking

- Proxy URLs use opaque identifiers
- Format: `/proxy/{opaque-id}` (e.g., `/proxy/550e8400-e29b-41d4-a716-446655440000`)
- Opaque ID is auto-generated UUID on URL Config creation
- No hints about target URL in proxy path
- Target URL never exposed to browser
- Users never see target URL (only label/display name)

### 9.3 Access Control

- Every proxy request validated against:
  - Valid session
  - User's Project assignment
  - User's User Type assignment
  - URL configuration active status
  - Matching User Type + Project between user and URL Config

### 9.4 Error Handling

**Session Timeout During Proxy Request:**
- Return JSON 401 response
- Let client-side handle re-authentication flow

**Unauthorized Access (direct URL manipulation):**
- Return 403 error page
- Display for 5 seconds
- Auto-redirect to dashboard

**Target URL Unavailable:**
- Show generic "Service unavailable" error
- Do not expose target URL or technical details

---

## 10. Security Requirements

### 10.1 Authentication
- bcrypt password hashing with configurable rounds
- Secure session tokens (cryptographically random)
- Session stored server-side
- HTTPS enforced in all environments
- Progressive delay on failed login attempts

### 10.2 Authorization
- Role-based access control (RBAC)
- No direct exposure of target URLs
- All proxy requests validated
- Admin impersonation fully logged

### 10.3 Session Security
- Single active session per user
- Immediate session invalidation on:
  - User deactivation
  - User Type deactivation (for affected users)
  - Project deactivation (for affected users)
  - Password change
  - Manual termination by admin

---

## 11. UI/UX Specifications

### 11.1 General Design
- Fixed design (no branding customization)
- Clean, professional interface
- Responsive layout for desktop browsers

### 11.2 Form Validation
- Required fields marked with red asterisk (*)
- Inline errors only (displayed next to invalid fields)
- No summary error block at top

### 11.3 Confirmations
- Modal dialog for destructive actions (delete, deactivate)
- Requires explicit "Delete" / "Cancel" choice

### 11.4 Feedback
- Toast notifications for success messages (auto-dismiss)
- Global spinner in header for loading states

### 11.5 Timestamps
- All timestamps displayed in user's local timezone (browser-detected)

### 11.6 Navigation
- Left sidebar for menu
- Top header for user info and actions
- Full-page mode for proxied content with floating exit button

### 11.7 List Views (Admin)
- Configurable pagination: 10, 25, 50, 100 items per page
- Clickable column headers for sorting (asc/desc)
- Per-list search box
- Filters via dropdown selectors

---

## 12. Non-Functional Requirements

### 12.1 Security
- HTTPS only
- bcrypt password hashing
- No direct URL exposure
- Centralized proxy enforcement
- Session management controls

### 12.2 Audit & Compliance
- All successful access events logged (async)
- Detailed logging (method, status, duration, User Type, Project)
- Configurable retention period (via admin settings)
- User deletion removes associated logs

### 12.3 Maintainability
- Modular master data design
- Clear separation between admin and user features
- Full audit trail on all entities (stored, not displayed)

---

## 13. Out of Scope

- Email notifications (password reset, alerts)
- Bulk user import
- Audit log export
- Custom branding/theming
- Rate limiting
- Content rewriting in proxy
- SSO/MFA authentication
- Third-party integrations
- Mobile-optimized design
- Admin action logging (only user access logged)
- Admin creation via UI (seed script only)
- Clone/duplicate feature for entities
- Notifications for unusual events
- Concurrent edit detection (single admin assumption)
- Super-admin hierarchy

---

## 14. Acceptance Criteria

- [ ] User Type and Project masters implemented as standalone entities
- [ ] Categories correctly scoped to User Type + Project pairs
- [ ] Sub-Categories inherit scope from parent Category
- [ ] URL Configurations have cascading dropdown validation
- [ ] User assignment mandatory at creation (single pair)
- [ ] Role-based access verified for all operations
- [ ] Audit logs capture User Type + Project from user's assignment
- [ ] Dynamic menus reflect correct permissions per Project + User Type
- [ ] Menu shows 3-level hierarchy with auto-expand
- [ ] Proxy correctly masks all target URLs with UUID-based opaque IDs
- [ ] Session management enforces single-session rule
- [ ] Immediate session termination on User Type/Project deactivation
- [ ] Password policy enforced on creation and change
- [ ] Account lockout with progressive delay working as specified
- [ ] Deep linking functions correctly
- [ ] Admin impersonation shows exact user view and logs correctly
- [ ] Admin profile management (name, password) functional
- [ ] Settings page for audit retention functional
- [ ] User dashboard shows correct stats, frequent links, recent activity

---

## 15. Change Management

Any change to this specification after approval will be handled through a formal change request with revised cost and timeline.

---

## Appendix A: API Endpoint Overview

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `POST /api/auth/change-password` - Change password (forces re-login)

### Admin - User Types
- `GET/POST /api/admin/user-types`
- `GET/PUT/DELETE /api/admin/user-types/:id`

### Admin - Projects
- `GET/POST /api/admin/projects`
- `GET/PUT/DELETE /api/admin/projects/:id`

### Admin - Users
- `GET/POST /api/admin/users`
- `GET/PUT/DELETE /api/admin/users/:id`
- `POST /api/admin/users/:id/impersonate`

### Admin - Categories
- `GET/POST /api/admin/categories`
- `GET/PUT/DELETE /api/admin/categories/:id`

### Admin - Sub-categories
- `GET/POST /api/admin/sub-categories`
- `GET/PUT/DELETE /api/admin/sub-categories/:id`

### Admin - URL Configurations
- `GET/POST /api/admin/url-configs`
- `GET/PUT/DELETE /api/admin/url-configs/:id`

### Admin - Sessions
- `GET /api/admin/sessions`
- `DELETE /api/admin/sessions/:id`

### Admin - Audit Logs
- `GET /api/admin/audit-logs`

### Admin - Settings
- `GET/PUT /api/admin/settings`

### Admin - Profile
- `GET/PUT /api/admin/profile`

### User
- `GET /api/user/menu` - Get dynamic menu for current user
- `GET /api/user/dashboard` - Dashboard data (stats, frequent, recent)

### Proxy
- `ALL /proxy/:opaqueId` - Proxy endpoint (all HTTP methods)

---

## Appendix B: Database Schema Overview

```sql
-- User Types (standalone)
user_types (
  id,
  name,              -- unique
  description,
  status,            -- active/inactive
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- Projects (standalone)
projects (
  id,
  name,              -- unique
  description,
  status,            -- active/inactive
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- Users
users (
  id,
  username,          -- globally unique
  password_hash,
  full_name,
  is_admin,          -- boolean flag
  status,            -- active/inactive
  force_password_change,
  failed_attempts,
  locked_until,
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- User Assignments (junction table for future multi-pair support)
user_assignments (
  id,
  user_id,           -- references users
  project_id,   -- references projects
  user_type_id       -- references user_types
)

-- Categories (scoped to User Type + Project pair)
categories (
  id,
  name,
  user_type_id,      -- references user_types
  project_id,   -- references projects
  description,
  status,            -- active/inactive
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- Sub-categories (inherits scope from parent)
sub_categories (
  id,
  category_id,       -- references categories
  name,
  description,
  status,            -- active/inactive
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- URL Configurations
url_configurations (
  id,
  label,             -- display name
  description,       -- optional, shown as tooltip
  target_url,
  opaque_id,         -- auto-generated UUID
  user_type_id,      -- references user_types
  project_id,   -- references projects
  category_id,       -- references categories
  sub_category_id,   -- references sub_categories
  status,            -- active/inactive
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- Sessions
sessions (
  id,
  user_id,           -- references users
  session_token,
  ip_address,
  user_agent,
  created_at,
  last_activity
)

-- Audit Logs
audit_logs (
  id,
  user_id,           -- references users
  user_type_id,      -- user's assignment at time of access
  project_id,   -- user's assignment at time of access
  url_config_id,     -- references url_configurations
  target_url,
  request_method,
  response_status,
  duration_ms,
  ip_address,
  user_agent,
  accessed_at
)

-- Settings
settings (
  id,
  key,
  value
)
-- Keys: audit_retention_days
```

---

## Appendix C: Entity Relationship Diagram

```
┌─────────────────┐     ┌─────────────────┐
│   User Types    │     │  Projects  │
│   (standalone)  │     │   (standalone)  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │    ┌──────────────────┤
         │    │                  │
         ▼    ▼                  │
┌─────────────────┐              │
│   Categories    │◄─────────────┤
│ (UserType+Proj) │              │
└────────┬────────┘              │
         │                       │
         ▼                       │
┌─────────────────┐              │
│ Sub-Categories  │              │
│(inherits scope) │              │
└────────┬────────┘              │
         │                       │
         ▼                       │
┌─────────────────┐              │
│URL Configurations│◄────────────┘
│(explicit refs)  │
└─────────────────┘

┌─────────────────┐     ┌─────────────────┐
│     Users       │────▶│ User Assignments│
│  (is_admin flag)│     │ (junction table)│
└─────────────────┘     └─────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
            ┌─────────────┐       ┌─────────────┐
            │ User Types  │       │Projects│
            └─────────────┘       └─────────────┘
```
