# ProxyURLApp — Admin & User Flows

Flowcharts of the two main journeys through the app, including the Claims module (Phases 1 + 2A–2F).
Diagrams use [Mermaid](https://mermaid.js.org/) — they render on GitHub and in VS Code's Markdown preview (with the Mermaid extension).

**Roles:** `USER` < `TEAM_LEAD` < `ADMIN`. Auth is a server-side session (httpOnly cookie); `ProtectedRoute` gates the client; `adminMiddleware` / `scopedMiddleware` gate the server.

---

## Admin flow

```mermaid
flowchart TD
  Start(["Admin opens app"]) --> Login["POST /api/auth/login"]
  Login -->|"role = ADMIN"| Dash["/admin dashboard"]
  Dash --> Pick{"Choose area"}

  %% Proxy / core master data
  Pick --> Core["Core master data:<br/>User Types · Projects · Users<br/>Categories · Sub-Categories · URL Configs"]

  %% Claims configuration
  Pick --> CC["Claims Config (sidebar group)"]
  CC --> SM["Status Masters"]
  CC --> DT["Doc Type Masters"]
  CC --> CIR["Claim ID Rules"]
  CC --> CR["Claim Rules<br/>(Field · Operator · Value)"]
  CC --> CA["Claims (All)"]

  %% Ingestion pipeline (2A + 2B)
  CIR -->|"Scan now"| Scan["Scanner reads scanLocation<br/>→ creates Claims (idempotent)"]
  Scan --> Docs["Discovers documents in each<br/>claim folder, auto-classified (2B)"]
  Docs --> AutoVal["Auto-enqueues validation"]

  %% Validation (2C)
  AutoVal --> Drain["Serial drainer runs a ValidationRun"]
  Drain --> Vals["Validators: META · SPELL · QR · INTRA · FULL<br/>→ set the 5 status columns"]

  %% Review + rules + export
  CA --> View["Open a claim → Claim Update"]
  View --> Detail["Documents · validation badges<br/>· rule results ✓/✗ · Re-validate · timeline"]
  CR -.->|"rules evaluated live on claim view"| Detail
  Vals -.-> Detail
  CA -->|"Export"| Xlsx["Download claims-DATE.xlsx (2F)"]
```

---

## User / Team Lead flow

```mermaid
flowchart TD
  Start(["User / Team Lead opens app"]) --> Login["POST /api/auth/login"]
  Login -->|"role = USER or TEAM_LEAD"| FPC{"forcePasswordChange?"}
  FPC -->|"yes"| Change["Change password"] --> Login
  FPC -->|"no"| Dash["/dashboard — URL activity"]

  Dash --> Nav{"Sidebar"}

  %% Proxy usage (existing feature)
  Nav --> MyUrls["My URLs:<br/>Category → Sub-Category → URL"]
  MyUrls --> Proxy["Open URL → /view/:opaqueId<br/>(proxied page, access-logged)"]

  %% Claims
  Nav --> CDash["Claim Dashboard"]
  CDash --> HasAssign{"Has an active assignment?"}
  HasAssign -->|"no"| Limited["Limited Access banner<br/>(no claims shown)"]
  HasAssign -->|"yes"| List["List in-scope claims<br/>filters: sub-category · status · assignee/me · search"]

  List -->|"Export"| Xlsx["Download claims-DATE.xlsx"]
  List --> RoleChk{"role"}
  RoleChk -->|"TEAM_LEAD / ADMIN"| Add["+ Add Claim · assign in scope"]
  List --> Open["Open a claim → Claim Update"]

  Open --> CanEdit{"canEditClaim?<br/>USER: assigned to me ·<br/>TL: in my pair · ADMIN: all"}
  CanEdit -->|"yes"| Edit["Change status · reassign (TL/Admin)<br/>· add remark · upload / sync documents · Validate"]
  CanEdit -->|"no"| RO["Read-only: view details only"]

  Open --> Show["Always visible: documents · validation badges<br/>· claim rules ✓/✗ · remarks timeline"]
```

---

## Legend / notes

- **Solid arrows** = navigation or a triggered action. **Dotted arrows** = data feeding a view (e.g., validation results and live-evaluated rules show on the Claim Update page).
- **Scope:** a `USER` sees all claims in their `(UserType, Project)` pair but can only edit ones assigned to them; a `TEAM_LEAD` can edit any claim in their pair; an `ADMIN` sees/edits everything. The same scope governs the export.
- **Validation lifecycle:** each of the 5 columns goes `PENDING → IN_PROGRESS → PASSED/FAILED` during a `ValidationRun`. Runs are auto-enqueued after ingestion/upload and can be triggered manually ("Validate").
- **Claim Rules (2E)** are admin-defined and evaluated **live** when a claim is viewed (not stored).
