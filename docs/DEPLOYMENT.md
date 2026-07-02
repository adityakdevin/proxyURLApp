# Deploying to an existing Windows server

Runbook for pushing an **update** (e.g. the Forged-Documents Observation import/export feature)
to a Windows server that is already running ProxyURLApp.

> Assumes Node 18+, MySQL, and the app are already installed and running on the box.
> Adjust the app path (`C:\apps\proxyURLApp` below) and the start/stop commands to match
> however the server currently runs the process.

## What's in this release

- **DB schema change** — 7 new *nullable* columns on the `Claim` table (dealer name/code,
  invoice date, VIN, customer name, scheme type, observation remarks). Additive only — no data loss.
- **New server code** — observation import parser, import/export endpoints, status derivation.
- **New client code** — Upload/Export Observations dialog on the Admin → Claims page.
- **No new npm dependencies** (`exceljs` and `multer` were already in use).
- **Operational prerequisite** — every Sub-Category that will receive imports needs an *active
  default* workflow status (see step 7). This is the #1 cause of an "all rows failed" import.

---

## 1. Pre-deploy (one-time safety)

Open **PowerShell as Administrator** on the server.

```powershell
cd C:\apps\proxyURLApp

# Record the version you're on (for rollback)
git rev-parse HEAD > last-good-commit.txt

# Back up the database BEFORE the schema change (uses server/.env DATABASE_URL)
npm run db:backup --workspace=server
```

> **If you get `spawnSync mysqldump ENOENT`**, `mysqldump.exe` isn't on PATH. Find it (it lives in
> the MySQL `bin` folder of the install serving port 3307) and either add that folder to PATH or
> set `MYSQLDUMP_PATH` in `server/.env`:
> ```powershell
> # Locate the binary (mysqldump.exe sits next to the running mysqld.exe)
> Get-CimInstance Win32_Service | Where-Object Name -like '*mysql*' | Select-Object Name, PathName
> # then in server/.env:
> #   MYSQLDUMP_PATH="C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe"
> ```
> Immediate one-off backup without the script (use the full path + your creds):
> ```powershell
> & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" -h 127.0.0.1 -P 3307 -u root -p `
>   --single-transaction --routines --triggers proxyapp_db > C:\ProxyApp\backups\manual.sql
```

## 2. Stop the running app

Use whatever currently runs it:

```powershell
pm2 stop proxyurlapp          # if using pm2
# or:  nssm stop ProxyURLApp  # if installed as a Windows service via NSSM
# or:  stop the Task Scheduler task / close the console window
```

## 3. Get the new code onto the server

```powershell
cd C:\apps\proxyURLApp
git fetch origin
git checkout main
git pull origin main
```
(If the server has no git remote, copy the updated files over instead — at minimum the
`server/src`, `client/src`, and `server/prisma/schema.prisma` changes.)

## 4. Install, apply schema, build — one command

The repo ships a `deploy` script that does all three:

```powershell
npm install            # safe even with no new deps; ensures parity
npm run deploy         # = prisma generate  +  prisma db push  +  build (client + server)
```

`prisma db push` applies the 7 nullable columns non-destructively (no `--accept-data-loss`
needed). `build` produces `server/dist` and `client/dist`.

> If you prefer the steps individually:
> `npm run db:generate` → `npm run db:push` → `npm run build`

## 5. Confirm the production environment

`server/.env` must contain (production values):

```
DATABASE_URL="mysql://user:pass@127.0.0.1:3307/proxyapp_db"
NODE_ENV=production
PORT=3001
CLIENT_URL=https://your-server-host
```

> **`NODE_ENV=production` is required** — the Express server only serves the built React app
> (`client/dist`) and applies production cookie behavior when it's set.

## 6. Start the app

```powershell
cd C:\apps\proxyURLApp
$env:NODE_ENV="production"
npm run start          # = node dist/index.js (runs from the server/ workspace; serves API + client)
```
Or via your process manager:
```powershell
pm2 start npm --name proxyurlapp -- run start   # then: pm2 save
# or:  nssm start ProxyURLApp
```
The server listens on `PORT` (default **3001**). If IIS/ARR fronts it, no app change is needed —
just restart the Node process behind it.

## 7. Post-deploy — configure default statuses (IMPORTANT)

A claim can only be created if its Sub-Category has an **ACTIVE default** workflow status.
For each Sub-Category that will receive observation imports:

- **Admin → Status Masters** → pick the Sub-Category → **Add Status** → tick
  *"Default status for new claims"* (e.g. `Pending`). Add others (e.g. `Under Review`,
  `Approved`/`Rejected` as terminal) as needed.

Without this, every imported row fails with *"SubCategory has no active default status"* and the
dialog shows a banner pointing you here.

## 8. Smoke test

1. Log in as an admin.
2. **Claims → Upload Observations** → choose User Type → Project → Category → Sub-Category.
3. Upload `docs/samples/Forged Documents Observations.xlsx` → **Import** → expect *created/updated* counts.
4. **Export** → confirm the 10-column sheet downloads with the **Status** column filled.

## 9. Rollback

```powershell
# stop the app (step 2), then:
git checkout (Get-Content last-good-commit.txt)
npm install
npm run build
# Schema rollback is usually unnecessary (the new columns are nullable and ignored by old code).
# Only if required: restore the DB backup from step 1, then re-run prisma db push.
npm run start   # or restart via your process manager
```

---

### Notes

- **No new dependencies** were added, so `npm install` is just for parity.
- The schema change is **additive/nullable** — safe to apply to live data; old code keeps working.
- `npm run lint` is not wired into the build; editor (biome) style warnings do **not** block the
  build. Deployment correctness is gated by `tsc` + `vite build`, both of which pass.
