# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ProxyURLApp is a full-stack web application providing controlled access to external/internal URLs through a proxy mechanism with role-based access control. Users are assigned a single Project that determines which URLs they can access via a hierarchical menu (Category → SubCategory → URL).

## Tech Stack

- **Backend:** Node.js 18+ / Express / TypeScript (CommonJS)
- **Frontend:** React 18 / TypeScript / Vite / TailwindCSS / Radix UI (shadcn style)
- **Database:** MySQL with Prisma ORM
- **State:** Zustand (client auth), React Query (data fetching)
- **Auth:** bcrypt, server-side sessions with httpOnly cookies

## Common Commands

```bash
# Development (runs both server and client concurrently)
npm run dev

# Individual services
npm run dev:server       # Express on port 3001 (tsx watch)
npm run dev:client       # Vite on port 5173

# Database
npm run db:migrate       # Run Prisma migrations (dev)
npm run db:seed          # Seed initial data
npm run db:studio        # Open Prisma Studio GUI
npm run db:generate      # Regenerate Prisma client

# Testing & Linting
npm run test             # Jest tests (server)
npm run lint             # ESLint both workspaces

# Production
npm run build            # Build both client and server
npm run start            # Run production server
```

## Architecture

### Monorepo Structure
- `/client` - React frontend (Vite workspace)
- `/server` - Express backend workspace
- Root `package.json` uses npm workspaces

### Key Backend Files
- `server/src/index.ts` - Express app setup, middleware stack, route mounting
- `server/src/routes/proxy.ts` - Main proxy handler (~700 lines) with HTML/CSS/JS URL rewriting
- `server/src/services/authService.ts` - Login, password changes, session creation
- `server/src/services/proxyService.ts` - URL access validation
- `server/prisma/schema.prisma` - Data models

### Key Frontend Files
- `client/src/App.tsx` - Route definitions with ProtectedRoute wrapper
- `client/src/stores/authStore.ts` - Zustand auth state with localStorage persistence
- `client/src/lib/api.ts` - Centralized API client

### Data Model Hierarchy
```
Project (standalone)
    ↓
Category (scoped to Project)
    ↓
SubCategory (inherits scope from parent Category)
    ↓
UrlConfiguration (explicit refs to Project/Category/SubCategory, uses UUID opaqueId for masking)
```

User → UserAssignment (single Project) → determines menu/URL access

### Auth Flow
1. Login creates server-side Session with 64-char token
2. Token stored in httpOnly cookie (30 min timeout)
3. `authMiddleware` validates session on protected routes
4. `adminMiddleware` checks `isAdmin` flag for `/admin/*` routes

### Proxy Flow
1. User accesses `/view/:opaqueId` (full-page iframe)
2. Backend validates session + URL access via `ProxyService.validateAccess`
3. Fetches target URL, rewrites HTML/CSS/JS to route sub-resources through proxy
4. Logs access to AuditLog table

## API Routes

- `/api/auth/*` - Login, logout, change-password, impersonation
- `/api/admin/*` - CRUD for Users, Projects, Categories, SubCategories, UrlConfigs
- `/api/user/*` - Menu, dashboard endpoints
- `/proxy/:opaqueId/*` - Proxy handler (all HTTP methods)

## Environment Variables

Required in `.env`:
```
DATABASE_URL="mysql://user:pass@localhost:3306/proxyapp_db"
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:5173
```

Admin seed credentials configured via `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_FULLNAME`.

## Security Features

- Account lockout after 5 failed attempts (15 min)
- Progressive delay on failed login (1s, 2s, 4s, 8s...)
- Password policy: min 8 chars, uppercase, lowercase, number
- bcrypt with 12 rounds
- Single session per user (new login invalidates previous)
- Admin impersonation with audit trail

## Database Notes

- Use `npm run db:migrate` after schema changes
- Prisma Client auto-regenerates on migrate
- `server/prisma/seed.ts` creates initial admin user
