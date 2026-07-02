# 6. Demo Test Data (Seed)

This page explains how to load a complete set of **ready-made example data** so you can
explore and test every part of the app without setting anything up by hand.

[← Back to the manual index](README.md)

> ⚠️ **Use a separate test database.** The demo seed is meant for a test environment.
> Point the app at your test database before running it (see [section 6.4](#64-which-database-does-it-use)).
> Don't run it against real/production data.

---

## 6.1 What the demo seed creates

Running it builds one full, connected example you can immediately log into and use:

- **3 login accounts**, one per role (see credentials below).
- **1 scope:** User Type **"Claims Officer"** + Project **"FY2025"**.
- **1 Category** "Vehicle Claims" → **1 Sub-Category** "Warranty Claims".
- **Workflow statuses:** New (default) → In Progress → Verified → Closed (final).
- **Document types:** Aadhar Card, PAN Card, Invoice.
- **A Claim-ID Rule** (Start 1, Length 8, Folder names, `D:\Claims\Daily`).
- **Claim Rules — one per field**, so the checklist exercises **every** option in the
  rule "Field" dropdown (see [6.6](#66-the-claim-rules-one-per-field)).
- **2 website links** under the menu (Vehicle Lookup Portal, Dealer Directory).
- **5 sample claims** in mixed states, each with its own documents, so you can see
  every situation:

| Claim ID | Status | Assigned to | Documents | Checks at seed time |
|---|---|---|---|---|
| CLM10001 | New | (unassigned) | none | all Pending |
| CLM10002 | In Progress | user | Invoice, Aadhar | all Pending |
| CLM10003 | Verified | user | Invoice, PAN, Aadhar | all Pending |
| CLM10004 | In Progress | teamlead | Aadhar + duplicate-QR PDFs | all Pending (suspected forged) |
| CLM10005 | Closed | user | Invoice, PAN | all Pending |

> ✅ **Checks are live, not scripted.** Every claim seeds with all five checks
> **Pending**. The real Spell/QR/Meta/Intra/Full results are computed **when you click
> Validate** (or on upload/sync) — so a badge can never contradict what the document
> actually contains.
>
> **Who can click Validate:** Admin and Team Lead on **any** claim (even Closed — the
> lock only blocks status changes, not re-running checks); an End User only on claims
> **assigned to them**. So validate **CLM10004** as `teamlead`/`admin` (it's the
> teamlead's), and CLM10002/10003/10005 as `user`.

> 📁 **Real specimen files.** Each claim's documents are the actual sample files in
> `docs/samples/Claims/Daily/CLM100xx/` (duplicate-QR PDFs, spelling-error scans, and a
> clean "OK" image). On macOS `server/.env` sets `CLAIMS_SCAN_ROOT` to `docs/samples`,
> so **Validate** and **Sync from folder** run the genuine detectors against them —
> e.g. validating **CLM10004** really flags its problems. Note the QR detector scans
> **image** files only (not PDFs). (See [07 – Demo Script](07-demo-script.md).)

---

## 6.2 Demo login accounts

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `Admin@123` |
| Team Lead | `teamlead` | `Lead@1234` |
| End User | `user` | `User@1234` |

These accounts are ready to use immediately — they do **not** force a password change,
so you can log straight in and test each role's view.

---

## 6.3 How to run it

From the project's main folder, run **one** of these:

```bash
# from the repo root
npm run db:seed:demo
```

```bash
# or from inside the server folder
cd server
npm run db:seed:demo
```

When it finishes you'll see a confirmation and a table of the demo logins printed in
the terminal.

> 💡 **Safe to run again.** The seed is **idempotent** — running it a second time
> updates the same example records instead of creating duplicates. It will not throw
> errors on a re-run.

### Suggested test walkthrough

1. Run the seed.
2. Log in as **user / User@1234** → open **CLM10002**, upload a file, click
   **Validate**, then move it to **Verified** with a note.
3. Log in as **teamlead / Lead@1234** → click **Add Claim**, create a new claim, and
   assign it to **user**.
4. Log in as **admin / Admin@123** → explore **Admin → Categories / Sub-Categories**
   and the **observation import/export** under **Admin → Claims**.

---

## 6.4 Which database does it use?

The seed writes to whatever database the app is configured to use — the
`DATABASE_URL` setting in **`server/.env`**.

**Before running, make sure `server/.env` points at your test database**, not a real
one. The seed creates and updates real rows in that database.

---

## 6.5 Difference from the normal seed

| Command | Purpose |
|---|---|
| `npm run db:seed` | The **standard** seed — mainly ensures an admin account and a few defaults exist. Run once on a fresh install. |
| `npm run db:seed:demo` | The **demo** seed described here — a full, navigable example with users, hierarchy, rules, and sample claims for testing. |

---

## 6.6 The Claim Rules (one per field)

The demo seeds **ten** claim rules — one for every option in the rule **Field**
dropdown — so you can show the whole feature. All ten appear in the **Claim Rules**
checklist on every claim's detail page; each claim passes or fails them differently.

| # | Rule name | Field | Condition |
|---|---|---|---|
| 1 | At least one document | Document Count | `>= 1` |
| 2 | Has a remark logged | Remark Count | `>= 1` |
| 3 | Must be assigned | Assigned | `= true` |
| 4 | Invoice attached | Has Document Type | `= Invoice` |
| 5 | Work has started (not New) | Workflow Status | `≠ New` |
| 6 | Spell check passed | Spell Check | `= PASSED` |
| 7 | QR check passed | QR Check | `= PASSED` |
| 8 | Metadata check passed | Meta Extraction | `= PASSED` |
| 9 | Intra-claim consistency passed | Intra-Claim | `= PASSED` |
| 10 | Full scan passed | Full Scan | `= PASSED` |

> 💡 **Operators:** the two count fields accept `=, ≠, ≥, ≤, >, <`; every other field
> accepts only `=` / `≠`. Status values must match exactly: `PENDING`,
> `IN_PROGRESS`, `PASSED`, `FAILED`, `DOCS_NOT_AVAILABLE`.

### How each sample claim scores (✅ pass / ❌ fail)

Rules **1–5** depend only on seeded facts (documents, remarks, assignment, workflow),
so they score immediately. Rules **6–10** read the five checks, which start **Pending**
— so at seed time they're ❌ and only turn green/red after you click **Validate** (real
results, based on the actual files):

| Rule ↓ / Claim → | 10001 | 10002 | 10003 | 10004 | 10005 |
|---|:--:|:--:|:--:|:--:|:--:|
| 1 Document Count ≥ 1 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 2 Remark Count ≥ 1 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 3 Assigned = true | ❌ | ✅ | ✅ | ✅ | ✅ |
| 4 Invoice attached | ❌ | ✅ | ✅ | ❌ | ✅ |
| 5 Workflow ≠ New | ❌ | ✅ | ✅ | ✅ | ✅ |
| 6–10 Spell/QR/Meta/Intra/Full | ❌ | ⏳ | ⏳ | ⏳ | ⏳ |

_⏳ = Pending until you Validate (real result then); ❌ on CLM10001 because it has no documents yet. Validate CLM10004 as `teamlead`/`admin`; the rest as `user`._

- **Rules 1–5** already give the full "all cases" picture — each shows both a ✅ and a ❌
  across the five claims.
- **CLM10001** — all ❌ (new, unassigned, no docs). Great "before" shot; **Sync from
  folder** pulls its file in and rules 1 & 4 flip to ✅.
- **CLM10004** — the forged claim: click **Validate** and the real detectors flag its
  problems for genuine reasons.
- **CLM10002 / CLM10003** — editable, so **Validate** computes their real check results
  live during the demo.

> 🔧 To demo editing rules, log in as **admin → Admin → Claim Rules** and change a
> value (e.g. set "Invoice attached" to require a PAN Card) — the checklist re-scores
> on the next validate.

---

[← Back to the manual index](README.md)
