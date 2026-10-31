# ProxyURLApp

A full-stack web application that provides controlled access to external and internal URLs through a secure proxy mechanism with role-based access control and comprehensive audit logging.

## Features

- **Role-Based Access Control** - Each user has a role, one Project, and the Sub-Categories granted within it, which together determine URL and claim access
- **Hierarchical Menu System** — Category → SubCategory → URL structure for organized navigation
- **URL Masking** — Target URLs are hidden behind UUID-based opaque identifiers
- **Session Management** - Server-side sessions with a sliding idle timeout and a cap on concurrent sessions per account
- **Audit Logging** — Complete access history with user, URL, timestamp, and request details
- **Admin Impersonation** — Admins can view the system as any user for troubleshooting
- **Account Security** — Progressive lockout, password policies, and bcrypt hashing

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js 24, Express, TypeScript |
| Frontend | React 19, TypeScript, Vite, TailwindCSS |
| Database | MySQL |
| ORM | Prisma |
| UI Components | Radix UI (shadcn style) |
| State Management | Zustand, React Query |

## Quick Start

### Prerequisites

- Node.js 24
- MySQL 5.7 or 8 (production runs 5.7; CI tests both)
- npm 11.17+

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd proxyURLApp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp server/.env.example server/.env
   ```

   Every variable here is read by the server, so the file belongs in `server/`. A `.env` at
   the repo root is read by nothing: the Prisma CLI loads `server/.env` from
   `server/prisma.config.ts`, the app and the `server/prisma/` scripts load it through
   `server/src/lib/prisma.ts`, and the app, seeds and backup script all run with `server/`
   as their working directory.

   Update `server/.env` with your database credentials:
   ```
   DATABASE_URL="mysql://user:password@localhost:3306/proxyapp_db"
   PORT=3001
   NODE_ENV=development
   CLIENT_URL=http://localhost:5173
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=Admin123!
   ADMIN_FULLNAME=System Administrator
   ```

4. **Set up the database**
   ```bash
   npm run db:generate
   npm run db:push
   npm run db:seed
   ```

5. **Start development servers**
   ```bash
   npm run dev
   ```

   The application will be available at:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001

## Project Structure

```
proxyURLApp/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Route pages
│   │   ├── stores/         # Zustand state
│   │   └── lib/            # Utilities
│   └── vite.config.ts
├── server/                 # Express backend
│   ├── prisma/             # Schema & migrations
│   ├── src/
│   │   ├── routes/         # API endpoints
│   │   ├── services/       # Business logic
│   │   ├── lib/            # Shared helpers
│   │   └── middleware/     # Auth, error handling
│   └── tsconfig.json
├── scripts/                # Utility scripts
└── docs/                   # Documentation
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both frontend and backend in development mode |
| `npm run dev:server` | Start backend only (port 3001) |
| `npm run dev:client` | Start frontend only (port 5173) |
| `npm run build` | Build for production |
| `npm run start` | Run production server |
| `npm run db:push` | Sync the database to `schema.prisma` (this project's mechanism — NOT `db:migrate`, see `server/prisma/migrations/README.md`) |
| `npm run db:seed` | Seed initial data |
| `npm run db:studio` | Open Prisma Studio |
| `npm run test` | Run unit tests |
| `npm run test:e2e` | Run the API and UI end-to-end suites |
| `npm run lint` | Run ESLint |

## User Roles

### Admin
- Full access to all master data management
- Manage users, URL configurations, categories
- View audit logs and active sessions
- Impersonate end users for troubleshooting

### End User
- Access URLs in the Sub-Categories granted within their assigned Project
- View personalized dashboard with recent activity
- Navigate hierarchical menu of available URLs

## Security

- **Password Policy**: Minimum 8 characters with uppercase, lowercase, and number
- **Account Lockout**: 5 failed attempts triggers 15-minute lockout
- **Session Timeout**: 8 hours of inactivity (`SESSION_MAX_AGE_MS`), refreshed on every request
- **Concurrent Sessions**: Up to 3 per account (`SESSION_MAX_PER_USER`); past the cap the least recently active one is signed out
- **Password Hashing**: bcrypt with 12 rounds

## Documentation

- [User Manual](docs/README.md) — Plain-language guides for end users, team leads and admins
- [Technical Specification](docs/SPEC.md) — Detailed feature specification
- [Deployment Guide](docs/DEPLOYMENT.md) — Server installation and deployment
- [Manual Testing Guide](TESTING.md) — Walkthrough for the claims and document-scanning module
- [E2E Test Plan](docs/testing/e2e-test-plan.md) - API and browser end-to-end suites: test database, how to run them, CI
- [Admin & User Flows](docs/flows.md) — End-to-end flow diagrams

## License

Proprietary - All rights reserved
