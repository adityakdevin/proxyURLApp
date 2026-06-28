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
- **1 scope:** User Type **"Claims Officer"** + Project Type **"FY2025"**.
- **1 Category** "Vehicle Claims" → **1 Sub-Category** "Warranty Claims".
- **Workflow statuses:** New (default) → In Progress → Verified → Closed (final).
- **Document types:** Aadhar Card, PAN Card, Invoice.
- **A Claim-ID Rule** (Start 1, Length 8, Folder names, `D:\Claims\Daily`).
- **Claim Rules** (at least one document, must be assigned, spell check passed).
- **2 website links** under the menu (Vehicle Lookup Portal, Dealer Directory).
- **5 sample claims** in mixed states, so you can see every situation:

| Claim ID | Status | Assigned to | Check results (Spell/QR/Meta/Intra/Full) |
|---|---|---|---|
| CLM10001 | New | (unassigned) | all Pending |
| CLM10002 | In Progress | user | Pass / Pass / Pass / In&nbsp;Progress / Pending |
| CLM10003 | Verified | user | all Passed |
| CLM10004 | In Progress | teamlead | Pass / **Fail** / Pass / **Fail** / **Fail** (suspected forged) |
| CLM10005 | Closed | user | all Passed |

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

[← Back to the manual index](README.md)
