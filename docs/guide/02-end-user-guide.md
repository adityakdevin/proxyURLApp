# 2. End-User Guide

This guide is for **End Users** — staff who work the claims that have been **assigned
to them**. It walks through every step of handling a claim, plus using your website
menu.

[← Back to the manual index](README.md)

> **In short:** Open your assigned claim → add/refresh its documents → run the
> automatic checks → review the results and rules → change the status and write a
> note → Save.

---

## 2.1 What you can and can't do

As an End User you see **only the claims assigned to you**. Your job is to work those
claims — not to create or hand them out.

| You **can** | You **cannot** |
|---|---|
| See claims assigned to you | See other people's claims |
| Open and download a claim's documents | Create a brand-new claim _(Team Lead/Admin only)_ |
| Upload documents and pull them in from a folder | Re-assign a claim to someone else _(Team Lead/Admin only)_ |
| Run the automatic checks | Import/export observation sheets _(Admin only)_ |
| Change the claim's status and add notes | Change settings or rules _(Admin only)_ |
| Export your visible claim list to Excel | |

---

## 2.2 The Claims Dashboard (your work list)

Open **Claims** from the main menu. This is your worklist.

> 📷 **Screenshot placeholder:** _The Claims Dashboard showing the filter row and the claims table._

You'll see a table with one row per claim. The columns are:

| Column | Meaning |
|---|---|
| **Claim ID** | The claim's reference number (click it, or **Open**, to work the claim). |
| **Sub-Category** | Which section the claim belongs to. |
| **Workflow Status** | The stage the claim is at: **New → In Progress → Verified → Closed**. |
| **Assigned To** | Who is responsible for it. |
| **Spell · QR · Meta · Intra-Claim · Full Scan** | The five **automatic check** results (see [section 2.5](#25-the-five-automatic-checks)). Each shows Pending, In Progress, Passed, or Failed. |
| **Created** | When the claim was created. |
| **Actions** | Buttons to open the claim's documents, re-run its checks, and a **⋮** menu with the rest (see [Quick actions on one row](#quick-actions-on-one-row)). This column stays visible while you scroll the table sideways. |

### Finding a claim quickly

Above the table is a **filter row**:

- **Sub-Category** — narrow to one section.
- **Workflow Status** — show only, say, "In Progress" claims.
- **Assigned to Me** — tick this to show only your own claims.
- **Search** — type part of a Claim ID to jump to it.

The list is split into pages; use the page controls at the bottom to move through it.

### Quick actions on one row

The **Actions** column on each row gives you, without opening the claim:

- **👁 Open documents** — jumps straight into the document viewer for that claim.
- **🔄 Re-validate** — re-runs all five automatic checks on that claim.
- **⋮ More actions** — **Change status** (with a note, exactly like the claim page).
  Team Leads and Admins also get **Reassign** here; Admins also get **Delete claim**.

### Acting on several claims at once

Tick the box at the left of any row you can open. A blue **action bar** appears above
the table showing how many you picked:

- **Re-validate** — queues the five checks for every picked claim.
- **Change status** — writes the same note (and, if you set one, the same new status)
  to every picked claim.
- **Reassign** — Team Leads and Admins only.
- **Delete** — Admins only.

Two things worth knowing:

- The tick box in the **header** picks every row on the **current page**. If more claims
  match your filters than fit on the page, the bar offers **"Select all N matching the
  filters"** — that acts on all N, not just the page. **Clear** drops the selection.
- One action can cover at most **500** claims. Ask for more and the app refuses the whole
  batch and tells you to narrow the filters — it never silently acts on just the first 500.

Each claim is still checked against your own permissions one by one, so a batch can
partly succeed. The result message tells you how many went through and why the rest
did not.

### Exporting your list

Click **Export** (top of the dashboard) to download the **currently filtered** list as
an Excel file — handy for sharing or offline review.

---

## 2.3 Opening a claim

Click a **Claim ID** (or its **Open** button). The **claim detail** page opens.

> 📷 **Screenshot placeholder:** _The top of a claim detail page: claim ID, breadcrumb, status, validation badges, and the Validate button._

The page is organized top to bottom:

1. **Header** — the Claim ID, a breadcrumb (Category / Sub-Category), the current
   **Workflow Status**, the **folder path** (where its files live), who it's
   **assigned to**, and the five check badges. A **Validate** button sits here.
2. **Validation results** — a short summary of the latest run of each check.
3. **Update Claim** — where you change status and add a note.
4. **Claim Rules** — a checklist showing whether the claim meets requirements.
5. **Documents** — the files attached to the claim.
6. **Remarks Timeline** — the full history of notes and status changes.

> ⚠️ You can only open a claim that is **assigned to you**. If you believe a claim
> should be yours, ask your Team Lead to assign it.

---

## 2.4 Working with documents

Scroll to the **Documents** section. This lists every file attached to the claim,
showing its name (click to download), its **type**, its **source** (Uploaded or
Scanned), size, and date.

> 📷 **Screenshot placeholder:** _The Documents section with the Upload and Sync from folder buttons and a list of files._

You have two ways to add documents:

### Upload files from your computer
1. Click **Upload**.
2. Choose one or more files.
3. They appear in the list once uploaded.
   - Allowed types include PDF, Word, Excel, and images.
   - Up to **25 MB per file**, and up to **50 files** at once.

### Pull files in from the claim's folder ("Sync from folder")
If the claim has a **folder path** set (a location on the server, like
`D:\Claims\Daily\CLM10001`), click **Sync from folder**. The app reads that folder
and registers any files it finds as documents.

### Deleting a document
Each document has a **Delete** option. Use it to remove a file added by mistake.

> 💡 **Automatic checks restart on changes.** Every time you **upload**, **sync**, or
> **delete** a document, the app **automatically re-runs the checks** in the
> background — because the evidence changed.

### Reading a document full screen (the document viewer)

Opening a document (from the **Actions** column on the dashboard, or from the Documents
list) gives you a full-screen **viewer**: the file on one side, and the findings for the
check you picked beside it. Tabs across the top switch between the checks. The window is
titled with the **Claim ID**, so several open tabs stay tellable apart.

Two controls make working through a batch quicker:

- **‹ and ›** step to the **previous / next claim** in the list and stay on the same
  check, so you can walk a day's claims without going back to the dashboard.
  They follow the dashboard's default order (newest first), not any sort or filter you
  applied.
- **The 🔍 "Go to claim ID" box** jumps straight to a claim by typing part of its Claim
  ID and picking it from the suggestions. It opens that claim's first document.

---

## 2.5 The five automatic checks

When a claim is **validated**, the app runs five automatic checks on its documents.
Each one ends up **Passed**, **Failed**, **Pending** (not run yet), or **In Progress**
(running now).

| Badge | Plain-English meaning |
|---|---|
| **Spell** | **Spell / text check** — reads the words inside the documents and flags spelling or wording mistakes that can be a sign of a fake or altered document. |
| **QR** | **QR-code check** — finds the QR codes/barcodes on the documents and confirms they are present and can be read (decoded). |
| **Meta** | **File-details check** — looks at each file's hidden details (when it was created, what software made it, edit history) for signs of tampering. |
| **Intra-Claim** | **Consistency check** — cross-checks that details (like VIN, dealer, dates, names) **match across all the documents** in the same claim. |
| **Full Scan** | **Overall deep scan** — a thorough scan of every document that produces the overall authenticity verdict for the claim. |

> 🔎 A **Passed** result means that check found no problem. A **Failed** result means
> the check found something that needs a human to look closer (for example, a QR code
> that won't read, or details that don't match between documents).

---

## 2.6 Running the checks (Validate)

You don't always have to wait for the automatic run — you can start it yourself.

1. Click the **Validate** button in the header.
2. It changes to **Validating…** while it works (the page refreshes the results on its
   own every couple of seconds).
3. When it finishes, the five badges and the **Validation results** summary update.

> 📷 **Screenshot placeholder:** _The Validate button mid-run ("Validating…") and the results summary below it._

> 💡 You don't need to keep clicking — the badges update automatically when the run
> completes.

---

## 2.7 The Claim Rules checklist

The **Claim Rules** section shows the requirements set for this kind of claim, and
whether the claim currently meets each one — for example:

- ✅ At least one document — _passed_
- ✅ Must be assigned — _passed_
- ❌ Spell check passed — _not yet_

It also shows a count like **"2 of 3 passed."** Use it as a quick checklist of what's
still outstanding before you move the claim forward.

> 📷 **Screenshot placeholder:** _The Claim Rules checklist with green ticks and red crosses._

---

## 2.8 Updating a claim (status + notes)

This is your main action. Scroll to the **Update Claim** section.

> 📷 **Screenshot placeholder:** _The Update Claim section: Change Status dropdown, Remark box, and Save button._

1. **Change Status** _(optional)_ — pick the next stage from the dropdown. The normal
   flow is:

   > **New → In Progress → Verified → Closed**

2. **Remark** _(required)_ — type a short note explaining what you did or decided.
   This is mandatory so there's always a record.
3. Click **Save**.

When you save:

- the claim moves to the new status (if you picked one),
- your note is recorded with the status change (e.g. "In Progress → Verified"), and
- the checks re-run automatically.

> ⚠️ **"Closed" is final.** Once a claim is **Closed** it is locked and can no longer
> be changed. Only move a claim to Closed when you're sure it's finished. (New, In
> Progress, and Verified can all still be edited.)

---

## 2.9 The Remarks Timeline (history)

At the bottom, the **Remarks Timeline** shows the **full history** of the claim: every
note, who wrote it, when, and any status change (shown as "old → new"). Click **Load
More** to see older entries.

This is your audit trail — it's how anyone can see exactly what happened to a claim and
why.

> 📷 **Screenshot placeholder:** _The Remarks Timeline with several dated entries and status-change labels._

---

## 2.10 A typical end-to-end example

1. Open **Claims**, tick **Assigned to Me**, and open claim **CLM10002**.
2. In **Documents**, click **Upload** and add the invoice and ID proof.
3. Click **Validate** and wait for the badges to update.
4. Check **Claim Rules** — all green.
5. In **Update Claim**, set status to **Verified**, type
   _"All documents present and checks passed."_, and click **Save**.
6. Confirm the new entry appears in the **Remarks Timeline**.

That's a complete claim handled.

---

## 2.11 Using your website menu (proxied links)

Besides claims, you may have a **menu of approved websites/tools**. It's organized as
**Category → Sub-Category → Link**, and shows **only the links your scope allows**.

1. Open the **Menu** (or the relevant area of the home screen).
2. Expand a **Category**, then a **Sub-Category**.
3. Click a **link** to open that website **through the app**.

The app opens the site safely on your behalf and keeps a record of the access. You
don't need to do anything special — just click the link you need.

> 📷 **Screenshot placeholder:** _The website menu expanded to show Category → Sub-Category → links._

---

**Need a word defined or hit a problem?** See the
[Glossary & FAQ](05-glossary-and-faq.md).
