# 4. Administrator Guide

Administrators set up and run the whole system: accounts, the menu structure, claim
rules, bulk scans, and data import/export. This guide is written so a non-technical
administrator can follow it step by step.

[← Back to the manual index](../README.md)

> **The golden rule of setup order.** Build from the top of the hierarchy down. If you
> try to create something before its "parent" exists, the app won't let you. The
> recommended order is in [section 4.1](#41-recommended-setup-order).

All admin screens live under the **Admin** area, which only administrators can see.

> 📷 **Screenshot placeholder:** _The Admin navigation menu listing all admin sections._

---

## 4.1 Recommended setup order

Set things up in this order the first time:

1. **Projects**: the top of the hierarchy, and the outer boundary of a user's "scope."
2. **Categories**: top-level groupings, each inside one Project.
3. **Sub-Categories**: sections inside a category.
4. **Users**: the people, each given a role, one Project, and the Sub-Categories they
   may use. (Sub-Categories must exist first, because a non-admin user needs at least
   one.)
5. For each Sub-Category that holds claims:
   - **Statuses** (the workflow stages),
   - **Document Types**,
   - **Claim Rules** (the checklist),
   - **Claim-ID Rule** (for automatic folder scans), if you use scanning.
6. **Website Links** (proxy URLs) — if you use the website menu.
7. **Claims** — created by hand, by bulk **scan**, or by **observation import**.

---

## 4.2 Projects (the "scope")

Every non-admin user is given a **Role**, **one Project**, and the **Sub-Categories**
you grant them inside that Project, all on the **Users** page
([section 4.3](#43-users)). The Project plus those granted Sub-Categories form their
**scope**: the boundary of what they can see. Categories are built inside a Project,
so the two line up.

- **Project** — usually a project, region, or financial year, e.g. _FY2025_.

### To create one
1. Go to **Admin → Projects**.
2. Click **Add**.
3. Enter a **Name** (required) and optional **Description**.
4. Leave **Status** as **Active**.
5. Click **Save**.

> 📷 **Screenshot placeholder:** _The Projects list and the Add dialog._

> ⚠️ Setting a Project to **Inactive** hides everything in that Project from its
> users, including their whole menu. Only deactivate when you mean to.

---

## 4.3 Users

### Creating a user
1. Go to **Admin → Users**.
2. Click **Add User**.
3. Fill in:
   - **Username** (unique),
   - **Full Name**,
   - **Temporary Password** (must be 8+ chars with uppercase, lowercase, and a number),
   - **Role** — **User**, **Team Lead**, or **Admin**,
   - **Project**: the one Project this person belongs to (not shown for **Admin**;
     admins get no Project),
   - **Category access**: click **Add Category**, pick a category in that Project, and
     tick the **Sub-Categories** this person may use. Repeat for other categories. At
     least one Sub-Category is required. These grants decide both their website menu
     and which claims they can reach.
4. Click **Save**.

> 📷 **Screenshot placeholder:** _The Add User form showing the Role, Project and Category access fields._

The new user logs in with the temporary password and is asked to set their own on
first login.

### Resetting & unlocking
- **Reset password** — if someone forgets theirs, edit the user and set a new temporary
  password; they'll be asked to change it next login.
- **Unlock** — if an account is locked from too many wrong attempts, you can clear the
  lock so they don't have to wait 15 minutes.
- **Deactivate** — set a user to **Inactive** to block access without deleting them.

### Impersonation (view as a user)
Administrators can **impersonate** a user to see exactly what that person sees — useful
for troubleshooting "I can't find my claim" reports. Every impersonation is recorded in
the audit trail. Stop impersonating to return to your own account.

> ⚠️ Each user can only have **one Project**. To move someone to a different Project,
> edit the user, pick the new Project, and grant the Sub-Categories they need there.

---

## 4.4 Categories

A **Category** is a top-level grouping that is **bound to one Project**.

1. Go to **Admin → Categories**.
2. Click **Add Category**.
3. Fill in:
   - **Name** (required),
   - **Description** (optional),
   - **Project** (required).
4. Click **Save** / **Create**.

> 📷 **Screenshot placeholder:** _The Create Category dialog with the Project dropdown._

> ⚠️ The **Project** is locked once the category is created, so you can't move a
> category to a different Project afterwards. Choose carefully.

The list shows each category's Project and a **usage** count (how many sub-categories it
holds).

---

## 4.5 Sub-Categories

A **Sub-Category** sits **inside a Category**. It automatically **inherits the
category's Project**, so you don't pick a Project here; you just pick the parent
category.

1. Go to **Admin → Sub-Categories**.
2. Click **Add Sub-Category**.
3. Fill in:
   - **Name** (required),
   - **Description** (optional),
   - **Category** (required): the dropdown shows each category with its Project in
     brackets, e.g. **"Vehicle Claims (FY2025)"**, so you can tell them apart.
4. Click **Save** / **Create**.

> 📷 **Screenshot placeholder:** _The Create Sub-Category dialog with the Category dropdown showing the Project in brackets._

Sub-Categories are where **claims** and **website links** live, so most further setup
(statuses, rules, scanning) happens **per sub-category**.

---

## 4.6 Workflow Statuses (per sub-category)

Each sub-category has its own set of **workflow statuses** — the stages a claim moves
through. In the standard setup these are:

> **New → In Progress → Verified → Closed**

For each status you set:

- **Name** (e.g. "Verified"),
- **Display Order** (the order they appear in dropdowns),
- **Default?** — exactly **one** status is the default; new claims start here (e.g.
  **New**),
- **Terminal?** — a terminal status **locks** the claim (no more edits). In the
  standard setup, only **Closed** is terminal.

### To set them up
1. Open the sub-category's **Statuses** screen.
2. **Add** each status with its name and order.
3. Mark one as **Default** and mark the final one(s) as **Terminal**.
4. Save.

> 📷 **Screenshot placeholder:** _The Statuses screen for a sub-category with Default and Terminal toggles._

> ⚠️ Every sub-category that holds claims **must** have one **Default** status, or new
> claims can't be created.

---

## 4.7 Document Types (per sub-category)

**Document Types** label the kinds of files a claim should have (e.g. _Aadhar Card_,
_PAN Card_, _Invoice_). They can be marked **Required**, which the **Full Scan** check
can use to confirm a claim has all its needed documents.

1. Open the sub-category's **Document Types** screen.
2. **Add** a type: give it a **Name**, choose whether it's a **Government** ID (with a
   code like AADHAR/PAN) or a **Custom** type, set its order, and whether it's
   **Required**. A new type is **not** required unless you tick the box — so Full Scan
   won't start failing claims for a type you only just created.
3. Save.

> 📷 **Screenshot placeholder:** _The Document Types screen._

---

## 4.8 Claim Rules — the checklist (per sub-category)

**Claim Rules** are the pass/fail checklist shown to handlers on each claim (the "Claim
Rules" section). Each rule checks one thing about the claim.

A rule is made of three parts: **what to check**, **how to compare**, and **the
value**. Examples:

| What to check (Field) | Compare (Operator) | Value | Means |
|---|---|---|---|
| Document count | is at least (≥) | 1 | The claim must have at least one document |
| Assigned | equals | true | The claim must be assigned to someone |
| Spell status | equals | PASSED | The spell check must have passed |
| Has document type | equals | (a type) | A specific document type must be present |

### To add a rule
1. Open the sub-category's **Claim Rules** screen.
2. Click **Add Rule**.
3. Pick the **Field**, the **Operator**, and type the **Value**; give the rule a
   **Name** and order.
4. Save.

> 📷 **Screenshot placeholder:** _The Claim Rules screen with a rule being added._

Handlers then see each rule as a green tick or red cross, with a "X of Y passed" count.

---

## 4.9 Claim-ID Rule & folder Scanning (per sub-category)

This is for teams that keep claim documents in **folders on the server** and want the
app to **create claims automatically** from those folders, instead of adding each by
hand.

### Step 1 — Define the Claim-ID Rule

A **Claim-ID Rule** tells the scanner **how to read a Claim ID out of each folder or
file name**. Think of it as a cookie-cutter: "take these characters from each name."

1. Open the sub-category's **Claim-ID Rules** screen and click **Add Rule**.
2. Set:
   - **Start Position** — which character to start from. **It counts from 1** (1 = the
     first character).
   - **Length** — how many characters to take.
   - **Scan Target** — **Folder names** (read the folder names) or **File names**
     (read the file names).
   - **Scan Location** — the Windows path to scan, e.g. `D:\Claims\Daily`. It **must
     start with a drive letter and `C:\` is not allowed** (a safety rule).
3. Click **Save**.

> 📷 **Screenshot placeholder:** _The "Add Rule" dialog: Start Position, Length, Scan Target radio buttons, Scan Location._

**Worked example** — with **Start Position = 1, Length = 8, Folder names**:

| Folder on disk | Extracted Claim ID |
|---|---|
| `CLM10001_warranty` | `CLM10001` |
| `20250615_dealerXYZ` | `20250615` |
| `AB99` (shorter than 8) | _skipped — name too short_ |

> 💡 Only **one** Claim-ID Rule can exist per sub-category.

### Step 2 — Run a Scan

Once the rule exists, run a **Scan** from the sub-category's scan screen. The scanner:

1. Looks inside the **Scan Location**.
2. Reads each folder/file name and cuts out the Claim ID using the rule.
3. **Creates a claim** for each one (at the default status), recording the folder as
   the claim's folder path.
4. **Registers the documents** found inside each claim's folder.
5. Shows a results summary: how many were **created**, **skipped**, and any **errors**
   (e.g. names too short).

> 📷 **Screenshot placeholder:** _A completed scan showing created/skipped/error counts._

> ⚠️ The folders must be reachable by the **server** (they live on the server's drive),
> not on your own PC.

---

## 4.10 Observation Import / Export (forged-document sheet)

This is an **admin-only** bulk tool for working with claims through an Excel
**observations sheet**. It's under **Admin → Claims**.

### The sheet layout (10 columns)

| # | Column | On Import | On Export |
|---|---|---|---|
| 1 | S. No | ignored | auto-numbered |
| 2 | **Claim ID** | **required** (matches/creates the claim) | filled |
| 3 | Dealer Name | saved to claim | filled |
| 4 | Dealer Code | saved to claim | filled |
| 5 | Invoice Date | saved to claim | filled |
| 6 | VIN No. | saved to claim | filled |
| 7 | Customer Name | saved to claim | filled |
| 8 | Scheme Type | saved to claim | filled |
| 9 | **Status** | ignored | **calculated** from the checks (see below) |
| 10 | Remarks | saved to claim | filled |

### Importing observations
1. Go to **Admin → Claims** and open the **Forged-Document Observations** dialog.
2. Choose the **Sub-Category** to import into.
3. Select your **.xlsx** file (max 5 MB, up to 5000 rows).
4. Click **Import**.

The app **creates** new claims and **updates** existing ones (matched by Claim ID),
filling in the dealer/VIN/customer details. You get a report: parsed, created, updated,
failed, and the first errors if any.

> 📷 **Screenshot placeholder:** _The observation import dialog with sub-category picker and file chooser, plus a results report._

> ⚠️ The target sub-category must already have a **Default** status, or imported claims
> can't be created.

### Exporting observations
1. In the same area, choose a **Sub-Category** and click **Export**.
2. You get `forged-observations-<date>.xlsx`.

On export, **column 9 (Status)** is calculated from the five checks:

- **Forged** — any check **Failed**,
- **OK** — all checks **Passed**,
- **Pending** — any check still Pending/In Progress.

---

## 4.11 Website Links (proxy URLs)

These build the **website menu** users see. A link lives under a specific
**Project, Category and Sub-Category**, so only users granted that Sub-Category get it.

1. Go to **Admin → URL Configurations** (or **Website Links**).
2. Click **Add**.
3. Fill in:
   - **Label** — the name users see in the menu,
   - **Target URL** — the real website address,
   - **Project**, **Category**, **Sub-Category**: where it belongs and who may see
     it,
   - (Advanced) the **proxy mode** and timeouts — leave at defaults unless you have a
     reason to change them.
4. Save.

> 📷 **Screenshot placeholder:** _The Add Website Link form._

The link now appears in the menu for users in that Project who were granted that
Sub-Category, under that Category → Sub-Category. The app opens it safely "through"
itself and logs the access.

> 💡 A Category or Sub-Category with **no links** is hidden from the menu — so users
> never see empty sections.

---

## 4.12 Keeping things tidy

- **Deactivate, don't delete**, when you can — setting something **Inactive** hides it
  while preserving history.
- **Bulk delete is admin-only, and it is a soft delete.** On the claims list you can tick
  rows and delete them from the blue action bar. Nothing is erased — the claims are
  marked deleted and drop out of everyone else's list. One batch covers at most 500
  claims; larger selections are refused outright rather than half-applied.
- **One default status** per sub-category, always.
- **Check access grants**: a user only sees a Sub-Category's links and claims if it
  is in their Project **and** you granted it to them on the **Users** page. "User can't
  see anything" almost always means a missing grant or the wrong Project; use
  **impersonation** to confirm.

---

**See also:** the [Glossary & FAQ](05-glossary-and-faq.md) for definitions and common
problems, and [Demo Test Data](06-demo-seed.md) to load a ready-made example you can
explore.
