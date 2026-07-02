# 7. Demo Script & Presenter Cheat-Sheet

A one-page script for presenting the **Claim Module** on a live call. Read it top to
bottom while sharing your screen — every step has the exact click and the one line to
say out loud.

[← Back to the manual index](README.md)

> **Total time:** ~10 minutes demo + 5 minutes setup beforehand.
> **Goal of the demo:** show a claim travel from creation → documents → automatic
> checks → status change → audit trail, across all three roles.

---

## 7.0 Before the call (5 min — do this off-screen)

1. **Point at a test database.** In `server/.env`, make sure `DATABASE_URL` is your
   **test** DB — the seed writes real rows.
   > ⚠️ Never run the demo seed against dev or production data.
2. **Load the demo data:**
   ```bash
   npm run db:seed:demo
   ```
   This creates 3 role logins, one full Category → Sub-Category, the rules, and
   **5 sample claims in mixed states** (including one suspected-forged claim).
3. **Start the app:**
   ```bash
   npm run dev
   ```
4. Open the **Login** screen, get your screen-share ready, and have this page open on
   a second monitor or phone.

> 🍎 **Presenting on a Mac?** The seed stores Windows folder paths like
> `D:\Claims\Daily\CLM10002`, which don't exist on macOS, so **Sync from folder**
> would fail. It's already wired to the **real sample documents** in
> `docs/samples/Claims/Daily/CLM100xx/` (duplicate-QR, spelling-error and clean
> specimens). `server/.env` sets
> `CLAIMS_SCAN_ROOT=<repo>/docs/samples`; at runtime the app strips the `D:\` prefix
> and re-roots the path under it (see `resolveScanRoot` in
> `server/src/lib/directoryReader.ts`), so **Sync from folder** finds those files with
> the seeded Windows paths unchanged. Just **restart the server** after any `.env`
> edit. If you'd rather skip Sync entirely, demo **Upload** instead.

### Logins to keep handy

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `Admin@123` |
| Team Lead | `teamlead` | `Lead@1234` |
| End User | `user` | `User@1234` |

### The sample claims you'll use

All five checks **start Pending** — you click **Validate** to compute real results.

| Claim ID | Status | Assigned | Documents | Use it to show… |
|---|---|---|---|---|
| CLM10001 | New | (none) | none | a fresh claim → Sync pulls files in |
| CLM10002 | In Progress | user | Invoice, Aadhar | the main end-user workflow + live Validate |
| CLM10003 | Verified | user | Invoice, PAN, Aadhar | a fuller claim to validate |
| CLM10004 | In Progress | teamlead | Aadhar + duplicate-QR PDFs | **the forged-document catch (Validate to flag it)** |
| CLM10005 | Closed | user | Invoice, PAN | a locked, final claim (status can't change) |

> 👤 **Who can Validate:** Admin/Team Lead on any claim; a user only on their own.
> Validate **CLM10004** as `teamlead`/`admin` (it's the teamlead's); the rest as `user`.

---

## 7.1 Opening line (30 seconds)

> *"This is the Claim Module. It lets a team receive claims, attach the supporting
> documents, run five automatic authenticity checks on those documents, and move each
> claim through **New → In Progress → Verified → Closed** — with a full audit trail and
> role-based access at every step."*

Then: *"Let me walk one claim through its whole life, wearing all three hats."*

---

## 7.2 Act 1 — Team Lead creates & assigns (log in as `teamlead`)

| Do | Say |
|---|---|
| Open **Claims** → click **Add Claim**. | *"A Team Lead or Admin creates the claim — end users can't."* |
| Fill the form, **assign it to `user`**, save. | *"I assign it to the officer who'll work it. Assignment controls who can even see it."* |

> 💡 **Point to make:** access is scoped — an End User only ever sees claims assigned
> to them; they can't create or reassign.

---

## 7.3 Act 2 — End User works the claim (log in as `user`) — *the core*

| Do | Say |
|---|---|
| Open **Claims**, tick **Assigned to Me**, open **CLM10002**. | *"This is the officer's worklist — only their claims."* |
| Walk the page top-to-bottom (header, validation, update, rules, documents, timeline). | *"Everything for one claim on a single page."* |
| **Documents** — the claim already has its files; optionally **Upload** one more or **Sync from folder**. | *"Here's the evidence. I can upload files or pull them straight from the server folder."* |
| Click **Validate**. Watch the five badges resolve. | *"Now the five automatic checks actually run against these files — the page refreshes results on its own."* |

### The five checks — one line each (say as the badges light up)

- **Spell** — reads the text inside docs, flags wording that signals a fake.
- **QR** — finds and decodes the QR/barcodes.
- **Meta** — inspects hidden file details (created date, software, edit history) for tampering.
- **Intra-Claim** — cross-checks that details (VIN, dealer, dates, names) **match across all documents**.
- **Full Scan** — the overall deep scan and authenticity verdict.

| Do | Say |
|---|---|
| Show the **Claim Rules** checklist. | *"A live checklist — the check rows go green as the checks pass, so I can see what's still outstanding."* |
| **Update Claim** → set status **Verified**, type a note, **Save**. | *"The note is mandatory — there's always a record of why."* |
| Scroll to **Remarks Timeline**. | *"And here's the audit trail: who, when, and the status change In&nbsp;Progress → Verified."* |

> 💡 **Point to make:** every upload / sync / delete **auto-re-runs the checks** —
> because the evidence changed.

---

## 7.4 Act 3 — The forged-document catch (open `CLM10004`)

This is the moment that sells the product. The checks start **Pending** — you run them live.

| Do | Say |
|---|---|
| Logged in as **`teamlead`** (or `admin`), open **CLM10004** — its documents are the duplicate-QR / spelling-error specimens. | *"This one came in flagged as suspicious. Let's run the checks and see."* |
| Click **Validate**, wait for the badges to resolve. | *"The engine actually scans the files — this isn't a canned result."* |
| Point at the **red** badges the real detectors raise. | *"The QR/consistency checks fail on the real files — a suspected forgery. The system flags it for a human instead of letting it slip through."* |

> 🔎 **Land it:** *"These are genuine detector results on the actual documents — the
> system really catches tampering, it isn't scripted."*
>
> ⚠️ **Reality check:** results come from the actual files. The QR detector scans
> **images only**, and the specimens are mostly problem documents — so expect real
> failures rather than a tidy all-green. That's the honest, credible version of the demo.

---

## 7.5 Act 4 — Admin governance (log in as `admin`, keep it quick)

| Do | Say |
|---|---|
| **Admin → Claim Rules** and **Claim-ID Rules**. | *"Admins configure what 'valid' means — which checks are required and how claim IDs are formatted."* |
| **Admin → Claims** → show observation **import/export**. | *"Bulk observation sheets go in and out here for offline review."* |

---

## 7.6 Closing points (land these before Q&A)

- **Role-based access** — users see only their own claims; Team Leads assign; Admins configure.
- **Automatic, self-refreshing checks** that re-run whenever evidence changes.
- **Real fraud detection** — the forged claim proves the checks have teeth.
- **Closed is final and locked** — protects the integrity of a finished claim.
- **Full audit trail** — every note and status change is recorded in the timeline.

> *"So: created, evidenced, checked, verified, and fully auditable — with the right
> person in control at each step."*

---

## 7.7 If something goes wrong (quick recovery)

| Problem | Fix on the spot |
|---|---|
| Badges stuck on "Validating…" | Refresh the page; they update on completion. Move on and come back. |
| Logged out mid-demo | 30-min idle timeout / single-session — just log back in. |
| A claim looks wrong / edited | Re-run the seed: `npm run db:seed:demo` (idempotent — safe to re-run). |
| Can't open a claim as `user` | It isn't assigned to them — that's the access rule working, not a bug. |

---

[← Back to the manual index](README.md) · Related: [End-User Guide](02-end-user-guide.md) · [Demo Seed](06-demo-seed.md)
