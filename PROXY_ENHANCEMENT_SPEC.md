# ProxyURLApp Enhancement Specification
## 100% URL Compatibility via Headless Browser Integration

**Version:** 1.0
**Date:** January 2026
**Status:** Technical Specification

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Requirements Summary](#3-requirements-summary)
4. [Architecture Overview](#4-architecture-overview)
5. [Detailed Technical Specification](#5-detailed-technical-specification)
6. [Database Schema Changes](#6-database-schema-changes)
7. [API Endpoints](#7-api-endpoints)
8. [Frontend Changes](#8-frontend-changes)
9. [Deployment & Infrastructure](#9-deployment--infrastructure)
10. [Security Considerations](#10-security-considerations)
11. [Monitoring & Observability](#11-monitoring--observability)
12. [Implementation Phases](#12-implementation-phases)
13. [Risk Assessment](#13-risk-assessment)

---

## 1. Executive Summary

### Problem Statement

The current proxy implementation successfully handles ~50% of target URLs but fails on:
- **Akamai WAF-protected sites (3):** Kotak General Insurance, PolicyBazaar, Royal Sundaram
- **Authentication-gated sites (1):** NIC Portal

### Solution Overview

Implement a **headless browser rendering layer** using **Playwright** with **live DOM mirroring** via WebSocket to achieve 100% URL compatibility. For URLs that still cannot be proxied, provide an **admin-configurable "open in new window"** fallback with access logging.

### Key Decisions Made

| Decision Area | Choice | Rationale |
|---------------|--------|-----------|
| Headless Library | Playwright | Better Windows support, auto-manages browsers |
| Browser Lifecycle | Per-request spawn | Clean isolation, no session bleed |
| Session Escalation | Per-URL admin config | Explicit control over which URLs use headless |
| Concurrency Limit | 2-3 instances | Matches server resources (~2GB RAM) |
| Content Delivery | Live WebSocket mirroring | Full interactivity required |
| Target Latency | <500ms | Near-instant user feedback |
| Authentication | Pass-through + OAuth breakout | Cleanest security model |
| Fallback Option | New window with logged redirect | Last resort for unproxiable URLs |

---

## 2. Current State Analysis

### Working Features (Keep As-Is)

| Feature | Implementation | Status |
|---------|----------------|--------|
| X-Frame-Options stripping | Header deletion | ✅ Working |
| CSP stripping | All variants removed | ✅ Working |
| URL rewriting (HTML) | Regex-based src/href/action rewrite | ✅ Working |
| URL rewriting (CSS) | url() pattern rewriting | ✅ Working |
| URL rewriting (JS) | Client-side interception script | ✅ Working |
| Redirect following | Recursive up to 10 redirects | ✅ Working |
| Cookie management | Per-domain in-memory store | ✅ Working |
| Frame-busting defeat | `if(top!==self)` → `if(false)` | ✅ Working |
| Sub-resource proxying | Cached target URL, path routing | ✅ Working |
| RBAC validation | Multi-level hierarchy check | ✅ Working |

### Current Limitations (To Be Addressed)

| Limitation | Impact | Solution |
|------------|--------|----------|
| Akamai WAF detection | 403 errors on 3 sites | Headless browser rendering |
| No JS rendering | Bot challenges fail | Playwright executes JS |
| No WebSocket passthrough | Real-time features broken | WebSocket proxy support |
| Authentication-gated sites | 401 errors | Pass-through auth + OAuth breakout |
| Static User-Agent | Detection risk | Rotate realistic UAs |
| No retry mechanism | Single point of failure | Retry with escalation |

---

## 3. Requirements Summary

### Functional Requirements

#### FR-1: Headless Browser Rendering
- **FR-1.1:** Integrate Playwright for headless Chrome/Chromium rendering
- **FR-1.2:** Per-URL configuration flag (`proxy_mode`: direct/headless/new_window)
- **FR-1.3:** Spawn isolated browser instance per request (no shared state)
- **FR-1.4:** Maximum 2-3 concurrent headless instances with queue for overflow
- **FR-1.5:** 30-second idle timeout for session reclamation

#### FR-2: Live DOM Mirroring
- **FR-2.1:** WebSocket connection between client and server
- **FR-2.2:** Stream DOM changes to client in real-time
- **FR-2.3:** Forward user interactions (clicks, keystrokes, scrolls) to headless browser
- **FR-2.4:** Target latency: <500ms for user action feedback
- **FR-2.5:** Hybrid connection lifecycle (persistent while active, auto-disconnect on idle)

#### FR-3: Authentication Handling
- **FR-3.1:** Pass-through authentication (proxy login pages within iframe)
- **FR-3.2:** Detect OAuth/SSO redirects to external identity providers
- **FR-3.3:** Open OAuth flows in new window, capture cookies on return
- **FR-3.4:** MFA forms render normally in iframe (no special handling)

#### FR-4: Download Handling
- **FR-4.1:** Intercept file downloads initiated by target sites
- **FR-4.2:** Stream downloads through proxy server to user
- **FR-4.3:** Log download events in audit trail

#### FR-5: WebSocket Passthrough
- **FR-5.1:** Proxy WebSocket connections from target sites
- **FR-5.2:** Maintain connection state per user session
- **FR-5.3:** Handle WS reconnection on connection drops

#### FR-6: Fallback Mechanism
- **FR-6.1:** Admin-configurable "open in new window" mode per URL
- **FR-6.2:** Redirect endpoint `/redirect/:opaqueId` for access logging
- **FR-6.3:** 302 redirect to target URL after logging

#### FR-7: Cookie Handling Enhancement
- **FR-7.1:** Intelligent SameSite attribute rewriting
- **FR-7.2:** Identify session/auth cookies by pattern (JSESSIONID, .ASPXAUTH, etc.)
- **FR-7.3:** Rewrite critical cookies to `SameSite=None; Secure`
- **FR-7.4:** Preserve non-critical cookie attributes

### Non-Functional Requirements

#### NFR-1: Performance
- Request-to-first-byte for headless: <3 seconds (cold start)
- User interaction latency: <500ms (target)
- Concurrent headless capacity: 2-3 instances

#### NFR-2: Reliability
- Friendly error messages with retry button on failure
- Silent fallback to alternative proxy method when possible
- Auto-retry on transient failures (network timeouts)

#### NFR-3: Observability
- Per-request metrics logged to database
- Admin dashboard with success rate, latency, resource usage
- Real-time session monitoring

#### NFR-4: Security
- Process isolation for each headless instance
- Unrestricted navigation within session (trust model)
- Standard audit logging (access events only)

---

## 4. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT BROWSER                                  │
│  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────────┐  │
│  │   React App     │    │  Viewer Page     │    │  WebSocket Client      │  │
│  │   /view/:id     │───▶│  (iframe/canvas) │◀───│  (DOM sync/events)     │  │
│  └─────────────────┘    └──────────────────┘    └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     │ HTTP / WebSocket
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXPRESS SERVER                                  │
│  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────────┐  │
│  │  Proxy Router   │    │  WebSocket       │    │  Headless Manager      │  │
│  │  /proxy/:id/*   │    │  Server          │    │  (Browser Pool/Queue)  │  │
│  └────────┬────────┘    └────────┬─────────┘    └──────────┬─────────────┘  │
│           │                      │                         │                 │
│           ▼                      ▼                         ▼                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         PROXY SERVICE                                    ││
│  │  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────┐ ││
│  │  │Direct Proxy  │  │Headless Proxy │  │Cookie Manager │  │URL Rewriter│ ││
│  │  │(existing)    │  │(Playwright)   │  │(SameSite fix) │  │(existing)  │ ││
│  │  └──────────────┘  └───────────────┘  └───────────────┘  └───────────┘ ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL RESOURCES                                 │
│  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────────┐  │
│  │  Normal Sites   │    │  Akamai WAF      │    │  Auth-Gated Sites      │  │
│  │  (direct proxy) │    │  (headless only) │    │  (pass-through auth)   │  │
│  └─────────────────┘    └──────────────────┘    └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Request Flow Decision Tree

```
                    ┌─────────────────┐
                    │ Incoming Request │
                    │ /proxy/:opaqueId │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Validate Session │
                    │ & URL Access     │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Check proxy_mode │
                    │ from UrlConfig   │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ mode=direct  │  │ mode=headless│  │mode=new_window│
    │              │  │              │  │              │
    │ Use existing │  │ Queue for    │  │ Return       │
    │ HTTP proxy   │  │ Playwright   │  │ redirect URL │
    └──────────────┘  └──────────────┘  └──────────────┘
           │                 │                 │
           ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ Rewrite HTML │  │ Spawn Browser│  │ Log access + │
    │ Return to    │  │ Load URL     │  │ 302 redirect │
    │ iframe       │  │ Setup WS     │  │ to target    │
    └──────────────┘  └──────────────┘  └──────────────┘
                             │
                    ┌────────▼────────┐
                    │ Stream DOM via  │
                    │ WebSocket       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Forward user    │
                    │ events to       │
                    │ headless        │
                    └─────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Location |
|-----------|----------------|----------|
| ProxyRouter | Route requests, validate access, select proxy mode | `server/src/routes/proxy.ts` |
| HeadlessManager | Browser pool, queue, lifecycle management | `server/src/services/headlessManager.ts` (new) |
| HeadlessSession | Single browser session, DOM capture, event forwarding | `server/src/services/headlessSession.ts` (new) |
| WebSocketServer | WS connection management, message routing | `server/src/websocket/server.ts` (new) |
| DOMSerializer | Convert DOM to transferable format | `server/src/services/domSerializer.ts` (new) |
| CookieManager | Enhanced cookie handling with SameSite fix | `server/src/services/cookieManager.ts` (new) |
| MetricsService | Collect and store per-request metrics | `server/src/services/metricsService.ts` (new) |
| ViewerPage | Enhanced React component for headless rendering | `client/src/pages/ViewerPage.tsx` (modify) |

---

## 5. Detailed Technical Specification

### 5.1 Headless Browser Manager

#### HeadlessManager Class

```typescript
// server/src/services/headlessManager.ts

interface HeadlessConfig {
  maxConcurrent: number;      // 2-3 per requirements
  idleTimeoutMs: number;      // 30000ms (30 seconds)
  requestTimeoutMs: number;   // 60000ms (60 seconds)
  queueMaxSize: number;       // Max pending requests
}

interface QueuedRequest {
  id: string;
  opaqueId: string;
  targetUrl: string;
  userId: number;
  resolve: (session: HeadlessSession) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

class HeadlessManager {
  private activeSessions: Map<string, HeadlessSession>;
  private requestQueue: QueuedRequest[];
  private config: HeadlessConfig;

  // Lifecycle methods
  async acquireSession(opaqueId: string, targetUrl: string, userId: number): Promise<HeadlessSession>;
  async releaseSession(sessionId: string): void;

  // Queue management
  private processQueue(): void;
  private checkIdleSessions(): void;

  // Metrics
  getActiveCount(): number;
  getQueueLength(): number;
  getMetrics(): HeadlessMetrics;
}
```

#### Session Lifecycle

```
┌─────────────────┐
│ Session Request │
└────────┬────────┘
         │
         ▼
┌────────────────────┐     ┌─────────────────┐
│ Active < MaxConc?  │─No─▶│ Add to Queue    │
└────────┬───────────┘     └────────┬────────┘
         │Yes                       │
         ▼                          ▼
┌────────────────────┐     ┌─────────────────┐
│ Spawn Browser      │     │ Wait for slot   │
│ (Playwright)       │◀────│ (FIFO)          │
└────────┬───────────┘     └─────────────────┘
         │
         ▼
┌────────────────────┐
│ Create Session     │
│ Connect WebSocket  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Active Session     │
│ - Stream DOM       │
│ - Forward events   │
└────────┬───────────┘
         │
         ├──────────────────────────────┐
         │ Idle > 30s                   │ User disconnects
         ▼                              ▼
┌────────────────────┐     ┌─────────────────┐
│ Idle Timeout       │     │ Explicit Close  │
└────────┬───────────┘     └────────┬────────┘
         │                          │
         └──────────┬───────────────┘
                    ▼
         ┌─────────────────┐
         │ Close Browser   │
         │ Process Queue   │
         └─────────────────┘
```

### 5.2 Live DOM Mirroring Protocol

#### WebSocket Message Types

```typescript
// Shared types for server and client

// Server → Client messages
interface DOMSnapshotMessage {
  type: 'dom_snapshot';
  html: string;           // Full HTML content
  baseUrl: string;        // For relative URL resolution
  timestamp: number;
}

interface DOMMutationMessage {
  type: 'dom_mutation';
  mutations: SerializedMutation[];
  timestamp: number;
}

interface SerializedMutation {
  type: 'childList' | 'attributes' | 'characterData';
  targetPath: number[];   // DOM path from document
  addedNodes?: string[];  // Serialized HTML
  removedNodes?: number[];// Indices to remove
  attributeName?: string;
  attributeValue?: string | null;
  characterData?: string;
}

interface NavigationMessage {
  type: 'navigation';
  url: string;
  title: string;
}

interface ScrollMessage {
  type: 'scroll';
  x: number;
  y: number;
}

interface LoadingMessage {
  type: 'loading';
  state: 'started' | 'domcontentloaded' | 'load' | 'networkidle';
}

interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  retryable: boolean;
}

// Client → Server messages
interface ClickEventMessage {
  type: 'click';
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle';
  modifiers: string[];    // ['ctrl', 'shift', etc.]
}

interface KeyEventMessage {
  type: 'key';
  eventType: 'keydown' | 'keyup' | 'keypress';
  key: string;
  code: string;
  modifiers: string[];
}

interface InputEventMessage {
  type: 'input';
  targetPath: number[];
  value: string;
}

interface ScrollRequestMessage {
  type: 'scroll_request';
  deltaX: number;
  deltaY: number;
}

interface RefreshMessage {
  type: 'refresh';
}
```

#### DOM Serialization Strategy

```typescript
// server/src/services/domSerializer.ts

class DOMSerializer {
  // Full snapshot on initial load
  serializeDocument(page: Page): Promise<string>;

  // Mutation tracking
  setupMutationObserver(page: Page): void;

  // Efficient diff for changes
  serializeMutation(mutation: MutationRecord): SerializedMutation;

  // Path computation for element targeting
  computeElementPath(element: Element): number[];
  resolveElementByPath(path: number[]): Element;
}
```

### 5.3 Authentication Flow

#### Pass-Through Authentication

```
User                   Proxy Server              Target Site
  │                         │                         │
  │  Request /proxy/:id     │                         │
  │────────────────────────▶│                         │
  │                         │  GET /login             │
  │                         │────────────────────────▶│
  │                         │  200 + Login HTML       │
  │                         │◀────────────────────────│
  │  Login page in iframe   │                         │
  │◀────────────────────────│                         │
  │                         │                         │
  │  Submit credentials     │                         │
  │  (via WebSocket)        │                         │
  │────────────────────────▶│  POST /login            │
  │                         │────────────────────────▶│
  │                         │  302 + Set-Cookie       │
  │                         │◀────────────────────────│
  │                         │                         │
  │                         │  [Store cookies]        │
  │                         │  [Follow redirect]      │
  │                         │                         │
  │  Authenticated page     │                         │
  │◀────────────────────────│                         │
```

#### OAuth Breakout Flow

```
User                   Proxy Server              Target Site         OAuth Provider
  │                         │                         │                    │
  │  Click "Login with Google"                        │                    │
  │────────────────────────▶│                         │                    │
  │                         │  Detect OAuth redirect  │                    │
  │                         │  to external domain     │                    │
  │                         │                         │                    │
  │  {type: 'oauth_breakout',                         │                    │
  │   url: 'accounts.google.com/...',                 │                    │
  │   returnUrl: '/proxy/:id/_oauth_return'}          │                    │
  │◀────────────────────────│                         │                    │
  │                         │                         │                    │
  │  [Opens new window]     │                         │                    │
  │─────────────────────────────────────────────────────────────────────▶│
  │                         │                         │                    │
  │  [User completes OAuth] │                         │                    │
  │◀─────────────────────────────────────────────────────────────────────│
  │                         │                         │                    │
  │  Callback to returnUrl  │                         │                    │
  │────────────────────────▶│  Extract cookies        │                    │
  │                         │────────────────────────▶│                    │
  │                         │  Authenticated session  │                    │
  │                         │◀────────────────────────│                    │
  │  Close popup, resume    │                         │                    │
  │◀────────────────────────│                         │                    │
```

### 5.4 Download Handling

```typescript
// Intercept downloads in Playwright

page.on('download', async (download) => {
  const suggestedFilename = download.suggestedFilename();
  const stream = await download.createReadStream();

  // Send download initiation to client
  ws.send(JSON.stringify({
    type: 'download_start',
    filename: suggestedFilename,
    contentType: download.contentType() || 'application/octet-stream'
  }));

  // Stream file data to client
  for await (const chunk of stream) {
    ws.send(chunk); // Binary frame
  }

  // Signal completion
  ws.send(JSON.stringify({
    type: 'download_complete',
    filename: suggestedFilename
  }));
});
```

### 5.5 WebSocket Passthrough for Target Sites

```typescript
// Handle target site WebSocket connections

interface WSProxy {
  clientWs: WebSocket;     // Client ↔ Proxy
  targetWs: WebSocket;     // Proxy ↔ Target
  targetUrl: string;
}

class TargetWebSocketProxy {
  private connections: Map<string, WSProxy>;

  // Intercept WS connections from headless browser
  async interceptWebSocket(page: Page): Promise<void> {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.isWebSocketRequest()) {
        // Create proxy WS to target
        // Bridge messages between client and target
      }
    });
  }
}
```

### 5.6 Intelligent Cookie SameSite Rewriting

```typescript
// server/src/services/cookieManager.ts

interface CookieRule {
  pattern: RegExp;
  isAuthCookie: boolean;
}

const AUTH_COOKIE_PATTERNS: CookieRule[] = [
  { pattern: /^JSESSIONID$/i, isAuthCookie: true },
  { pattern: /^\.ASPXAUTH$/i, isAuthCookie: true },
  { pattern: /^session[_-]?id$/i, isAuthCookie: true },
  { pattern: /^auth[_-]?token$/i, isAuthCookie: true },
  { pattern: /^access[_-]?token$/i, isAuthCookie: true },
  { pattern: /^sid$/i, isAuthCookie: true },
  { pattern: /^connect\.sid$/i, isAuthCookie: true },
  { pattern: /^__session$/i, isAuthCookie: true },
  // Add more patterns as discovered
];

class CookieManager {
  rewriteCookie(cookie: SetCookie): SetCookie {
    const isAuthCookie = AUTH_COOKIE_PATTERNS.some(
      rule => rule.pattern.test(cookie.name)
    );

    if (isAuthCookie) {
      return {
        ...cookie,
        sameSite: 'None',
        secure: true  // Required for SameSite=None
      };
    }

    // Preserve original for non-auth cookies
    return cookie;
  }
}
```

---

## 6. Database Schema Changes

### Prisma Schema Additions

```prisma
// server/prisma/schema.prisma

// Add to existing UrlConfiguration model
model UrlConfiguration {
  // ... existing fields ...

  // New fields for proxy mode
  proxyMode         ProxyMode     @default(DIRECT)
  headlessTimeout   Int           @default(60000)    // ms, default 60s
  sessionTtl        Int           @default(30000)    // ms, default 30s idle

  // New fields for audit depth (future use)
  auditLevel        AuditLevel    @default(STANDARD)

  // Relation to metrics
  proxyMetrics      ProxyMetric[]
}

enum ProxyMode {
  DIRECT      // Standard HTTP proxy (existing behavior)
  HEADLESS    // Playwright rendering
  NEW_WINDOW  // Open in new tab with logged redirect
}

enum AuditLevel {
  STANDARD    // Access only
  NAVIGATION  // Include navigation path
  FULL        // Include all interactions
}

// New model for per-request metrics
model ProxyMetric {
  id                Int             @id @default(autoincrement())
  urlConfigId       Int
  urlConfig         UrlConfiguration @relation(fields: [urlConfigId], references: [id])

  userId            Int
  user              User            @relation(fields: [userId], references: [id])

  sessionId         String          // ProxyURLApp session, not headless session
  proxyMode         ProxyMode

  // Timing metrics
  startTime         DateTime
  endTime           DateTime?
  durationMs        Int?

  // Performance metrics
  ttfbMs            Int?            // Time to first byte
  domLoadMs         Int?            // DOM content loaded

  // Status
  success           Boolean         @default(true)
  errorCode         String?
  errorMessage      String?

  // Request details
  targetUrl         String
  httpStatus        Int?
  bytesTransferred  Int?

  // Headless-specific
  browserSpawnMs    Int?            // Time to spawn browser
  queueWaitMs       Int?            // Time spent in queue

  createdAt         DateTime        @default(now())

  @@index([urlConfigId])
  @@index([userId])
  @@index([startTime])
  @@index([proxyMode])
}
```

### Migration SQL

```sql
-- Add new columns to UrlConfiguration
ALTER TABLE `UrlConfiguration`
ADD COLUMN `proxyMode` ENUM('DIRECT', 'HEADLESS', 'NEW_WINDOW') NOT NULL DEFAULT 'DIRECT',
ADD COLUMN `headlessTimeout` INT NOT NULL DEFAULT 60000,
ADD COLUMN `sessionTtl` INT NOT NULL DEFAULT 30000,
ADD COLUMN `auditLevel` ENUM('STANDARD', 'NAVIGATION', 'FULL') NOT NULL DEFAULT 'STANDARD';

-- Create ProxyMetric table
CREATE TABLE `ProxyMetric` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `urlConfigId` INT NOT NULL,
  `userId` INT NOT NULL,
  `sessionId` VARCHAR(191) NOT NULL,
  `proxyMode` ENUM('DIRECT', 'HEADLESS', 'NEW_WINDOW') NOT NULL,
  `startTime` DATETIME(3) NOT NULL,
  `endTime` DATETIME(3),
  `durationMs` INT,
  `ttfbMs` INT,
  `domLoadMs` INT,
  `success` BOOLEAN NOT NULL DEFAULT true,
  `errorCode` VARCHAR(50),
  `errorMessage` TEXT,
  `targetUrl` TEXT NOT NULL,
  `httpStatus` INT,
  `bytesTransferred` INT,
  `browserSpawnMs` INT,
  `queueWaitMs` INT,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `ProxyMetric_urlConfigId_idx` (`urlConfigId`),
  INDEX `ProxyMetric_userId_idx` (`userId`),
  INDEX `ProxyMetric_startTime_idx` (`startTime`),
  INDEX `ProxyMetric_proxyMode_idx` (`proxyMode`),

  CONSTRAINT `ProxyMetric_urlConfigId_fkey`
    FOREIGN KEY (`urlConfigId`) REFERENCES `UrlConfiguration`(`id`) ON DELETE CASCADE,
  CONSTRAINT `ProxyMetric_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE
);
```

---

## 7. API Endpoints

### New Endpoints

#### WebSocket Endpoint

```
WS /ws/proxy/:opaqueId
```

**Authentication:** Session token from cookie (validated on connection)

**Messages:** See Section 5.2 for message types

#### Redirect Endpoint (for NEW_WINDOW mode)

```
GET /redirect/:opaqueId
```

**Response:**
- Logs access to AuditLog
- Returns 302 redirect to actual target URL

#### Admin Metrics Endpoint

```
GET /api/admin/proxy-metrics
```

**Query Parameters:**
- `urlConfigId`: Filter by URL configuration
- `userId`: Filter by user
- `proxyMode`: Filter by mode (DIRECT/HEADLESS/NEW_WINDOW)
- `startDate`: Filter from date
- `endDate`: Filter to date
- `success`: Filter by success status

**Response:**
```json
{
  "metrics": [
    {
      "id": 1,
      "urlConfig": { "id": 1, "url": "https://example.com", "name": "Example" },
      "user": { "id": 1, "username": "john" },
      "proxyMode": "HEADLESS",
      "startTime": "2026-01-21T10:30:00Z",
      "durationMs": 3500,
      "success": true,
      "httpStatus": 200,
      "browserSpawnMs": 2100,
      "queueWaitMs": 0
    }
  ],
  "aggregates": {
    "totalRequests": 1250,
    "successRate": 0.94,
    "avgDurationMs": 2800,
    "avgQueueWaitMs": 150,
    "byMode": {
      "DIRECT": { "count": 1000, "successRate": 0.99 },
      "HEADLESS": { "count": 200, "successRate": 0.85 },
      "NEW_WINDOW": { "count": 50, "successRate": 1.0 }
    }
  },
  "pagination": {
    "total": 1250,
    "page": 1,
    "pageSize": 50
  }
}
```

#### Admin URL Configuration Update

Extend existing endpoint to include new fields:

```
PUT /api/admin/url-configurations/:id
```

**Request Body (additions):**
```json
{
  "proxyMode": "HEADLESS",
  "headlessTimeout": 60000,
  "sessionTtl": 30000,
  "auditLevel": "STANDARD"
}
```

### Modified Endpoints

#### Proxy Route Enhancement

```
GET /proxy/:opaqueId/*
```

**Changes:**
- Check `proxyMode` from UrlConfiguration
- Route to appropriate handler (direct/headless/redirect)
- For HEADLESS mode, return initial HTML with WebSocket connection script

---

## 8. Frontend Changes

### 8.1 ViewerPage Enhancements

```tsx
// client/src/pages/ViewerPage.tsx

interface ViewerPageProps {
  opaqueId: string;
}

interface ViewerState {
  mode: 'loading' | 'direct' | 'headless' | 'error';
  wsConnected: boolean;
  loadingStage: 'initializing' | 'connecting' | 'loading' | 'ready';
  error?: string;
}

const ViewerPage: React.FC<ViewerPageProps> = ({ opaqueId }) => {
  const [state, setState] = useState<ViewerState>({
    mode: 'loading',
    wsConnected: false,
    loadingStage: 'initializing'
  });

  // Determine proxy mode from initial response
  useEffect(() => {
    fetchProxyMode(opaqueId).then(config => {
      if (config.proxyMode === 'HEADLESS') {
        setState(s => ({ ...s, mode: 'headless' }));
        initWebSocket();
      } else if (config.proxyMode === 'NEW_WINDOW') {
        window.open(`/redirect/${opaqueId}`, '_blank');
        // Show message in current page
      } else {
        setState(s => ({ ...s, mode: 'direct' }));
      }
    });
  }, [opaqueId]);

  // WebSocket management for headless mode
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const initWebSocket = () => {
    const ws = new WebSocket(`ws://${location.host}/ws/proxy/${opaqueId}`);
    ws.onmessage = handleWSMessage;
    ws.onclose = handleWSClose;
    ws.onerror = handleWSError;
    wsRef.current = ws;
  };

  // Event forwarding
  const handleClick = (e: React.MouseEvent) => {
    if (state.mode === 'headless' && wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'click',
        x: e.clientX,
        y: e.clientY,
        button: 'left',
        modifiers: []
      }));
    }
  };

  // Render based on mode
  return (
    <div className={cn(
      "viewer-container",
      state.mode === 'headless' && "border-2 border-blue-500" // Color-coded frame
    )}>
      {state.mode === 'loading' && <FullScreenLoader stage={state.loadingStage} />}

      {state.mode === 'direct' && (
        <iframe
          src={`/proxy/${opaqueId}`}
          className="w-full h-full border-0"
        />
      )}

      {state.mode === 'headless' && (
        <div
          ref={canvasRef}
          className="headless-viewport"
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          tabIndex={0}
        >
          {/* DOM content rendered here */}
          <InAppRefreshButton onClick={handleRefresh} />
        </div>
      )}

      {state.mode === 'error' && (
        <ErrorDisplay
          message={state.error}
          onRetry={() => window.location.reload()}
        />
      )}
    </div>
  );
};
```

### 8.2 Full-Screen Loader Component

```tsx
// client/src/components/FullScreenLoader.tsx

interface LoaderProps {
  stage: 'initializing' | 'connecting' | 'loading' | 'ready';
}

const STAGE_MESSAGES = {
  initializing: 'Initializing secure browser...',
  connecting: 'Establishing secure connection...',
  loading: 'Loading content...',
  ready: 'Almost ready...'
};

const FullScreenLoader: React.FC<LoaderProps> = ({ stage }) => {
  return (
    <div className="fixed inset-0 bg-slate-900 flex flex-col items-center justify-center">
      <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500 mb-6" />
      <p className="text-white text-lg">{STAGE_MESSAGES[stage]}</p>
      <div className="w-64 mt-4">
        <ProgressBar stage={stage} />
      </div>
    </div>
  );
};
```

### 8.3 Admin Dashboard - Metrics Panel

```tsx
// client/src/pages/admin/ProxyMetrics.tsx

const ProxyMetricsPage: React.FC = () => {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [filters, setFilters] = useState<MetricsFilters>({});

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Proxy Metrics</h1>

      {/* Aggregate Stats */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          title="Total Requests"
          value={metrics?.aggregates.totalRequests}
        />
        <StatCard
          title="Success Rate"
          value={`${(metrics?.aggregates.successRate * 100).toFixed(1)}%`}
          color={metrics?.aggregates.successRate > 0.9 ? 'green' : 'yellow'}
        />
        <StatCard
          title="Avg Latency"
          value={`${metrics?.aggregates.avgDurationMs}ms`}
        />
        <StatCard
          title="Queue Wait"
          value={`${metrics?.aggregates.avgQueueWaitMs}ms`}
        />
      </div>

      {/* Mode Breakdown */}
      <div className="grid grid-cols-3 gap-4">
        <ModeCard mode="DIRECT" stats={metrics?.aggregates.byMode.DIRECT} />
        <ModeCard mode="HEADLESS" stats={metrics?.aggregates.byMode.HEADLESS} />
        <ModeCard mode="NEW_WINDOW" stats={metrics?.aggregates.byMode.NEW_WINDOW} />
      </div>

      {/* Filters */}
      <MetricsFilters filters={filters} onChange={setFilters} />

      {/* Request Table */}
      <MetricsTable
        metrics={metrics?.metrics || []}
        pagination={metrics?.pagination}
      />
    </div>
  );
};
```

### 8.4 Admin URL Configuration Form Extension

```tsx
// Add to existing URL config form

<FormField
  control={form.control}
  name="proxyMode"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Proxy Mode</FormLabel>
      <Select onValueChange={field.onChange} value={field.value}>
        <SelectTrigger>
          <SelectValue placeholder="Select proxy mode" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="DIRECT">
            Direct Proxy (Standard)
          </SelectItem>
          <SelectItem value="HEADLESS">
            Headless Browser (For WAF-protected sites)
          </SelectItem>
          <SelectItem value="NEW_WINDOW">
            Open in New Window (Fallback)
          </SelectItem>
        </SelectContent>
      </Select>
      <FormDescription>
        Use Headless for sites with Akamai/Cloudflare protection.
        Use New Window as last resort for unproxiable sites.
      </FormDescription>
    </FormItem>
  )}
/>
```

---

## 9. Deployment & Infrastructure

### 9.1 Server Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 2GB | 4GB |
| CPU | 2 cores | 4 cores |
| Disk | 10GB | 20GB |
| OS | Windows Server 2019+ | Windows Server 2022 |
| Node.js | 18.x | 20.x LTS |

### 9.2 Playwright Installation on Windows

```powershell
# Install Playwright with Chromium
npm install playwright

# Download browser binaries
npx playwright install chromium

# Verify installation
npx playwright --version
```

### 9.3 Task Scheduler Configuration

Create a scheduled task to start the application on system boot:

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </BootTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>node.exe</Command>
      <Arguments>dist/index.js</Arguments>
      <WorkingDirectory>C:\ProxyURLApp\server</WorkingDirectory>
    </Exec>
  </Actions>
  <Settings>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
</Task>
```

### 9.4 Environment Variables

Add to existing `.env`:

```env
# Headless browser configuration
HEADLESS_MAX_CONCURRENT=3
HEADLESS_IDLE_TIMEOUT_MS=30000
HEADLESS_REQUEST_TIMEOUT_MS=60000
HEADLESS_QUEUE_MAX_SIZE=10

# WebSocket configuration
WS_PATH=/ws
WS_HEARTBEAT_INTERVAL_MS=30000

# Playwright configuration
PLAYWRIGHT_BROWSER=chromium
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_ARGS=--disable-gpu,--no-sandbox
```

### 9.5 Process Management

Since using Task Scheduler, add graceful shutdown handling:

```typescript
// server/src/index.ts

import { HeadlessManager } from './services/headlessManager';

const headlessManager = new HeadlessManager();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await headlessManager.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await headlessManager.shutdown();
  process.exit(0);
});
```

---

## 10. Security Considerations

### 10.1 Threat Model

| Threat | Risk | Mitigation |
|--------|------|------------|
| Malicious JS in target page | High | Process isolation per browser instance |
| Session hijacking | Medium | httpOnly cookies, session validation on WS connect |
| DoS via queue flooding | Medium | Queue max size limit, rate limiting |
| Data exfiltration | Low | Standard audit logging, no sensitive data stored |
| Cross-tenant access | Low | User validation on every request |

### 10.2 Security Controls

#### Browser Isolation

```typescript
// Playwright launch options for security
const browserOptions: LaunchOptions = {
  headless: true,
  args: [
    '--disable-gpu',
    '--no-sandbox',              // Required for some Windows configs
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-web-security',    // Required for cross-origin content
    '--disable-features=IsolateOrigins,site-per-process'
  ]
};
```

#### WebSocket Authentication

```typescript
// Validate session on WebSocket connection
wss.on('connection', async (ws, req) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies['session_token'];

  if (!sessionToken) {
    ws.close(4001, 'Authentication required');
    return;
  }

  const session = await validateSession(sessionToken);
  if (!session) {
    ws.close(4001, 'Invalid session');
    return;
  }

  // Validate URL access
  const opaqueId = extractOpaqueId(req.url);
  const hasAccess = await ProxyService.validateAccess(session.userId, opaqueId);
  if (!hasAccess) {
    ws.close(4003, 'Access denied');
    return;
  }

  // Proceed with connection
});
```

### 10.3 Data Privacy

- No target site credentials stored (pass-through auth)
- Session cookies stored in memory only (not persisted)
- Audit logs contain access metadata only (not content)
- User interactions not logged by default (standard audit level)

---

## 11. Monitoring & Observability

### 11.1 Metrics Collection

```typescript
// server/src/services/metricsService.ts

interface ProxyRequestMetrics {
  urlConfigId: number;
  userId: number;
  sessionId: string;
  proxyMode: 'DIRECT' | 'HEADLESS' | 'NEW_WINDOW';

  startTime: Date;
  endTime?: Date;
  durationMs?: number;

  ttfbMs?: number;
  domLoadMs?: number;

  success: boolean;
  errorCode?: string;
  errorMessage?: string;

  targetUrl: string;
  httpStatus?: number;
  bytesTransferred?: number;

  browserSpawnMs?: number;
  queueWaitMs?: number;
}

class MetricsService {
  async recordRequest(metrics: ProxyRequestMetrics): Promise<void>;
  async getAggregates(filters: MetricsFilters): Promise<AggregateMetrics>;
  async getRequests(filters: MetricsFilters, pagination: Pagination): Promise<ProxyRequestMetrics[]>;
}
```

### 11.2 Health Checks

```typescript
// GET /api/health/headless

interface HeadlessHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  activeSessions: number;
  maxSessions: number;
  queueLength: number;
  avgSpawnTimeMs: number;
  lastError?: string;
}
```

### 11.3 Admin Dashboard Graphs

1. **Request Volume Over Time** - Line chart, hourly buckets
2. **Success Rate by Mode** - Stacked bar chart
3. **Latency Distribution** - Histogram
4. **Queue Wait Time** - Line chart with threshold markers
5. **Active Sessions** - Real-time gauge
6. **Error Breakdown** - Pie chart by error code

---

## 12. Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Deliverables:**
- [ ] Database schema migration (proxyMode, metrics table)
- [ ] HeadlessManager basic implementation
- [ ] Single browser spawn/close lifecycle
- [ ] Admin UI for proxyMode configuration

**Acceptance Criteria:**
- Can set proxyMode on UrlConfiguration
- Headless browser spawns when proxyMode=HEADLESS
- Basic page loads without interactivity

### Phase 2: Live Mirroring (Week 3-4)

**Deliverables:**
- [ ] WebSocket server setup
- [ ] DOM serialization and streaming
- [ ] Client-side DOM reconstruction
- [ ] Basic event forwarding (click, key)

**Acceptance Criteria:**
- Full page renders via WebSocket
- User can click links and navigate
- Basic form input works

### Phase 3: Interactivity & Edge Cases (Week 5-6)

**Deliverables:**
- [ ] Complete event forwarding (scroll, hover, drag)
- [ ] Download handling
- [ ] Target site WebSocket passthrough
- [ ] OAuth breakout flow
- [ ] Intelligent cookie SameSite rewriting

**Acceptance Criteria:**
- All user interactions work
- File downloads succeed
- OAuth login completes successfully
- Akamai-protected sites fully functional

### Phase 4: Reliability & Observability (Week 7-8)

**Deliverables:**
- [ ] Queue management with overflow handling
- [ ] Retry mechanism with fallback
- [ ] Per-request metrics collection
- [ ] Admin dashboard metrics panel
- [ ] Error handling with friendly messages

**Acceptance Criteria:**
- Graceful handling under load
- Clear error messages for users
- Complete metrics in admin dashboard
- System stable over 24+ hours

### Phase 5: Polish & Hardening (Week 9-10)

**Deliverables:**
- [ ] Full-screen loader UI
- [ ] Color-coded frame indicator
- [ ] In-app refresh button
- [ ] NEW_WINDOW fallback with logged redirect
- [ ] Performance optimization (<500ms target)
- [ ] Documentation

**Acceptance Criteria:**
- All 8 test URLs working (including Akamai-protected)
- Latency meets <500ms target for interactions
- Complete user documentation
- System ready for production

---

## 13. Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| <500ms latency not achievable | Medium | High | Accept 500ms-1s; optimize protocol; consider edge deployment |
| Playwright instability on Windows | Low | High | Extensive testing; fallback to Puppeteer if needed |
| Memory leaks from browser processes | Medium | Medium | Aggressive session timeout; process monitoring; auto-restart |
| Target sites detect headless browser | Medium | Medium | Stealth plugins; realistic browser fingerprint; user-agent rotation |
| WebSocket scaling issues | Low | Medium | Connection limits; graceful degradation to polling |

### Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Increased server resource usage | High | Medium | Resource monitoring; clear limits; queue management |
| Complex debugging for headless issues | Medium | Medium | Comprehensive logging; screenshot on error; metrics dashboard |
| User confusion about headless mode | Medium | Low | Clear UI indicators; loading messages; documentation |

### Mitigation for High-Impact Risks

**Latency Target:**
- Implement DOM diffing (only send changes, not full DOM)
- Use binary WebSocket frames for efficiency
- Consider CDN for static assets
- Profile and optimize serialization

**Browser Stability:**
- Auto-restart crashed browsers
- Monitor memory usage per instance
- Implement circuit breaker pattern
- Regular browser process cleanup

---

## Appendix A: Test URLs and Expected Behavior

| URL | Current Status | Expected After Enhancement |
|-----|----------------|---------------------------|
| Liberty Insurance | ✅ Works (header stripped) | ✅ Continues working (DIRECT) |
| Maruti Suzuki Insurance | ✅ Works (header stripped) | ✅ Continues working (DIRECT) |
| Navi Insurance | ✅ Works (header stripped) | ✅ Continues working (DIRECT) |
| UIIC | ✅ Works (redirects handled) | ✅ Continues working (DIRECT) |
| Kotak General Insurance | ❌ Akamai blocks | ✅ Works (HEADLESS) |
| PolicyBazaar | ❌ Akamai blocks | ✅ Works (HEADLESS) |
| Royal Sundaram | ❌ Akamai blocks | ✅ Works (HEADLESS) |
| NIC Portal | ❌ Requires auth | ✅ Works (pass-through auth) |

---

## Appendix B: Technology Decisions

| Component | Choice | Alternatives Considered | Reason |
|-----------|--------|------------------------|--------|
| Headless Browser | Playwright | Puppeteer | Better Windows support, browser management |
| WebSocket | ws (npm) | Socket.io | Lightweight, no overhead of Socket.io features |
| DOM Serialization | Custom | jsdom | Need live DOM, not parsed HTML |
| Metrics Storage | MySQL (existing) | InfluxDB, Prometheus | Simplicity, existing infrastructure |
| Process Manager | Task Scheduler | PM2, NSSM | Already in use, sufficient for scale |

---

## Appendix C: Configuration Reference

### Default Configuration Values

```typescript
const DEFAULT_CONFIG = {
  headless: {
    maxConcurrent: 3,
    idleTimeoutMs: 30000,      // 30 seconds
    requestTimeoutMs: 60000,   // 60 seconds
    queueMaxSize: 10,
    browserArgs: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  },
  websocket: {
    path: '/ws',
    heartbeatIntervalMs: 30000,
    closeTimeoutMs: 5000
  },
  cookies: {
    authCookiePatterns: [
      'JSESSIONID',
      '.ASPXAUTH',
      'session_id',
      'auth_token',
      'sid',
      'connect.sid'
    ]
  },
  metrics: {
    retentionDays: 90,
    aggregationIntervalMs: 3600000  // 1 hour
  }
};
```

---

*End of Specification*
