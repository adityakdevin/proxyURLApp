# Proxy URL App – Technical Specification (SPEC)

## 1. Overview

The Proxy URL App is a web-based application that provides controlled access to external or internal URLs through a proxy mechanism. Access is governed by each user's role, their single assigned Project, and the Sub-Categories (within that Project's Categories) granted to them, with complete audit logging for security and traceability.

---

## 2. Technology Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js with Express |
| Frontend | React |
| Database | MySQL (via Prisma) — the spec originally called for PostgreSQL; the implementation uses MySQL, and `server/prisma/schema.prisma` declares `provider = "mysql"` |
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
- Completely separate from the Project + Sub-Category assignment system (Admin role users get no Project assignment)
- Can manage own profile (full name, password)

### 3.2 End User
- Logs in to the system
- Views dynamically generated menus based on assigned Project and granted Sub-Categories
- Accesses proxy URLs based on permissions
- Has a single Project assignment plus specific Sub-Categories granted within it (future: multiple Projects)

### 3.3 Team Lead
- Same Project + Sub-Category scope as an End User, plus the extra claim actions restricted to Team Lead or Admin

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
| Idle timeout | 8 hours by default (`SESSION_MAX_AGE_MS`); sliding: refreshed on every request, and the session cookie is re-issued with the same window, so an active session never expires mid-task |
| Concurrent sessions | Up to 3 per account by default (`SESSION_MAX_PER_USER`); past the cap the least recently active session is signed out. Impersonation is exclusive: starting an impersonated session ends the user's other sessions, and vice versa |
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
- Password change
- Manual termination by admin

---

## 6. Data Model

### 6.1 Entity Hierarchy

```
Project (standalone master, globally unique names)

Category
  - References: Project (required)
  - Each Category belongs to exactly one Project
  - Category names are unique within a Project; the same name can exist in different Projects

Sub-Category
  - References: Parent Category
  - Inherits Project from parent Category

URL Configuration
  - References: Project + Category + Sub-Category (all explicit, with validation)
  - Contains: target_url, label (display name), description (optional)
  - Opaque ID auto-generated (UUID) for URL masking

Users (End Users)
  - Has single Project assignment (mandatory at creation)
  - Stored in junction table for future multi-assignment support
  - Granted specific Sub-Categories within that Project; the grants drive the menu,
    proxy URL access and the Claims scope
```

### 6.2 Scope Rules

| Entity | Scope |
|--------|-------|
| Projects | Global, standalone master |
| Categories | Per Project |
| Sub-Categories | Per Category (inherits parent's scope) |
| URL Configurations | Per Category + Sub-Category (validated against parent scopes) |
| End Users (User and Team Lead roles) | Single Project assignment, plus the Sub-Categories granted within it |
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
  - Cannot delete Project if users or categories reference it
  - Cannot delete Category if sub-categories exist
  - Cannot delete Sub-Category if URL configs exist
- When Project deactivated: dependent Categories, URLs become hidden from menus

### 6.5 Status Values

All entities use binary status: `active` or `inactive`

---

## 7. Admin Panel Modules

### 7.1 User Type Master

Removed: the app has no user types; access is a role, one Project and granted Sub-Categories, see 6.2.

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
- Assign a role (User, Team Lead or Admin); User and Team Lead also get one Project (mandatory at creation) and the Sub-Categories they may access within it
- Sub-Categories are picked per Category of the selected Project (cascading)
- Dropdowns show only active Projects, Categories and Sub-Categories
- Activate/deactivate/delete users
- Deactivation immediately terminates user's active sessions
- Deletion removes all user's audit log entries

**Fields:**
- Username (globally unique)
- Password (bcrypt hashed)
- Full name
- Role (User, Team Lead or Admin)
- Project reference (required; Admin role users get no Project assignment)
- Granted Sub-Categories (within the assigned Project)
- Status (active/inactive)
- Force password change flag
- Failed login attempts
- Locked until timestamp
- Audit fields

---

### 7.4 Category Master

**Purpose:** Define menu categories scoped to a Project

**Features:**
- CRUD operations
- Requires a Project selection
- Category names are unique within a Project; the same name can exist in different Projects
- Only an active Project is accepted (checked server-side)
- Deletion blocked if sub-categories exist
- Cannot change Project if sub-categories exist
- Display order: alphabetical by name

**List View:**
- Columns: Category Name, Project, Status
- Filters: Project
- Search: Per-list search box

**Fields:**
- Category name
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
- Inherits Project from parent Category
- Deletion blocked if URL configurations exist
- Display order: alphabetical by name

**List View:**
- Columns: Sub-Category Name, Category, Project, Status (full context)
- Filters: Project, Category
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
- Explicit selection of all three fields: Project, Category, Sub-Category
- **Cascading filters:** Select Project first -> Category dropdown filters to matching categories -> Sub-Category dropdown filters to selected category's children
- System validates all selections align
- Opaque ID (UUID) auto-generated on creation for URL masking
- Enable/disable access
- Same target URL can exist multiple times with different mappings
- Changes take immediate effect (no caching)
- Disabled URLs hidden completely from menus

**List View:**
- Columns: Label, Target URL, Project, Category, Sub-Category, Status
- Filters: Project, Category, Sub-Category, Status (all available)
- Search: Per-list search box

**Fields:**
- Label (display name shown to users)
- Description (optional; shown as tooltip in user menu)
- Target URL
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
- Accessible URL count scoped automatically to the user's granted Sub-Categories (within their assigned Project); frequent and recent lists come from the user's own access history

---

### 8.2 Dynamic Menu

**Purpose:** Show accessible URLs based on user permissions

**Location:** Left sidebar

**Features:**
- Menu generated from the user's assigned Project and the Sub-Categories granted to them
- Hierarchical display: Category → Sub-Category → URL items (3 levels)
- Alphabetical ordering at each level
- **Auto-expand behavior:** Expanding Category auto-expands all its Sub-Categories
- Shows every active granted Sub-Category even if it has no URLs yet; a Category appears only if it holds at least one granted Sub-Category
- URL label displayed; description shown as tooltip on hover
- No search/filter functionality
- Unauthorized/disabled items hidden completely
- Deep linking supported (bookmarked URLs load after login)

**Future (multi-Project support):** Categories grouped by Project headers when user has multiple assignments

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
  - User's Project assignment (the Project must be active)
  - URL configuration, its Category and its Sub-Category all active
  - URL Config's Project matches the user's assigned Project
  - User holds a grant for the URL Config's Sub-Category

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
- Up to 3 concurrent sessions per account (`SESSION_MAX_PER_USER`); past the cap the least recently active one is evicted; impersonated sessions are exclusive (see 5.4)
- Immediate session invalidation on:
  - User deactivation
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
- Detailed logging (method, status, duration, Project)
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

- [ ] Project master implemented as a standalone entity
- [ ] Categories correctly scoped to a single Project
- [ ] Sub-Categories inherit scope from parent Category
- [ ] URL Configurations have cascading dropdown validation
- [ ] User assignment mandatory at creation (single Project)
- [ ] Role-based access verified for all operations
- [ ] Audit logs capture the Project from user's assignment
- [ ] Dynamic menus reflect correct permissions per Project and granted Sub-Categories
- [ ] Menu shows 3-level hierarchy with auto-expand
- [ ] Proxy correctly masks all target URLs with UUID-based opaque IDs
- [ ] Session management enforces the per-account concurrent session cap and exclusive impersonation
- [ ] Immediate session termination on Project deactivation
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
  role,              -- USER, TEAM_LEAD or ADMIN
  status,            -- active/inactive
  force_password_change,
  failed_attempts,
  locked_until,
  created_at,
  updated_at,
  created_by,
  updated_by
)

-- User Assignments (one per user; junction table for future multi-Project support)
user_assignments (
  id,
  user_id,           -- references users; unique
  project_id         -- references projects
)

-- User Sub-Category grants (the Sub-Categories a user may access in their Project)
user_sub_categories (
  id,
  user_id,           -- references users
  sub_category_id,   -- references sub_categories; unique per user
  created_at
)

-- Categories (scoped to one Project; name unique per Project)
categories (
  id,
  name,
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
+-----------------+
|    Projects     |
|  (standalone)   |
+--------+--------+
         |
         +--------------------+
         |                    |
         v                    |
+-----------------+           |
|   Categories    |           |
|  (one Project)  |           |
+--------+--------+           |
         |                    |
         v                    |
+-----------------+           |
| Sub-Categories  |           |
|(inherits scope) |           |
+--------+--------+           |
         |                    |
         v                    |
+------------------+          |
|URL Configurations|<---------+
|(explicit refs)   |
+------------------+

+-----------------+     +--------------------+     +----------------+
|     Users       |---->|  User Assignments  |---->|    Projects    |
|     (role)      |     |  (one per user)    |     +----------------+
+--------+--------+     +--------------------+
         |
         |              +--------------------+     +----------------+
         +------------->|User Sub-Categories |---->| Sub-Categories |
                        |  (granted access)  |     +----------------+
                        +--------------------+
```
