# 5. Glossary & FAQ

Plain-English definitions and answers to common questions.

[← Back to the manual index](README.md)

---

## 5.1 Glossary

| Term | What it means |
|---|---|
| **User Type** | A label for a kind of user (e.g. _Claims Officer_). Half of a user's "scope." |
| **Project** | A label for a project, region, or year (e.g. _FY2025_). The other half of the scope. |
| **Scope** | A **User Type + Project** pair. It decides what a user can see. Each user has exactly one. |
| **Assignment** | The link between a user and their scope. |
| **Category** | A top-level grouping, built for one scope (e.g. _Vehicle Claims_). |
| **Sub-Category** | A section inside a category (e.g. _Warranty Claims_). Claims and website links live here. |
| **Claim** | A single case you work on. Has documents, a status, checks, and a history. |
| **Claim ID** | The reference number of a claim. |
| **Workflow Status** | The stage a claim is at: **New → In Progress → Verified → Closed**. |
| **Default status** | The status a brand-new claim starts at (here, **New**). |
| **Terminal status** | A final status that **locks** the claim from edits (here, **Closed**). |
| **The five checks** | The automatic authenticity tests: **Spell, QR, Meta, Intra-Claim, Full Scan** (see below). |
| **Validate** | To run the five checks on a claim. |
| **Remark** | A note added to a claim. Required whenever you change a claim. |
| **Remarks Timeline** | The full dated history of a claim's notes and status changes. |
| **Document Type** | A label for a kind of file (e.g. _Invoice_, _PAN Card_). |
| **Claim Rule** | A pass/fail item on the claim's checklist (e.g. "must have ≥1 document"). |
| **Claim-ID Rule** | The instruction for cutting a Claim ID out of folder/file names during a scan. |
| **Scan** | An automatic job that creates claims in bulk from folders on the server. |
| **Folder Path** | The location on the **server** where a claim's files are stored (e.g. `D:\Claims\Daily\CLM10001`). |
| **Observation sheet** | The Excel file admins use to bulk-import/export claim details. |
| **Proxy / Website link** | An approved website opened safely "through" the app, shown in your menu. |
| **Impersonation** | An admin temporarily viewing the app as another user, for support. |
| **Role** | **User**, **Team Lead**, or **Admin** — what a person is allowed to do. |

---

## 5.2 The five automatic checks, explained

| Check | What it actually does |
|---|---|
| **Spell** | Reads the words inside the documents and flags spelling/wording mistakes that can indicate a fake or altered document. |
| **QR** | Finds the QR codes/barcodes on the documents and confirms they are present and can be read. |
| **Meta** | Inspects each file's hidden details (creation date, software used, edit history) for signs of tampering. |
| **Intra-Claim** | Cross-checks that details (VIN, dealer, dates, names) are **consistent across all documents** in the same claim. |
| **Full Scan** | A thorough scan of every document that produces the overall authenticity verdict. |

Each check ends as **Passed** (no problem found), **Failed** (needs a human to look),
**Pending** (not run yet), or **In Progress** (running now).

---

## 5.3 Frequently asked questions

**Q: I can't see any claims. Why?**
You only see claims **assigned to you**. Ask your Team Lead to assign one, or — if
you're a Team Lead/Admin — untick "Assigned to Me" on the dashboard.

**Q: I can't see my menu / it's empty.**
Your scope (User Type + Project) may be set to Inactive, or there are no links in
it yet. Ask an administrator to check your assignment.

**Q: Why can't I change a claim's status?**
The claim is probably **Closed**, which is final and locks the claim. Closed claims
can't be edited.

**Q: I uploaded a document — do I need to press Validate?**
Not necessarily. Uploading, syncing, or deleting a document **re-runs the checks
automatically**. You can still press **Validate** to run them on demand.

**Q: A check shows "Failed." Is the claim rejected?**
No. **Failed** means that automatic check found something worth a closer human look —
not an automatic rejection. Review the documents and decide.

**Q: The app keeps logging me out.**
You're logged out after **30 minutes** of no activity, and logging in elsewhere ends
your other session. Just log back in.

**Q: My account is locked.**
After **5 wrong passwords** the account locks for **15 minutes**. Wait, or ask an
admin to unlock it.

**Q: "Sync from folder" found nothing.**
The folder path must exist on the **server's** drive and contain files. Check the path
is correct and that the files are actually there.

**Q: A scan skipped some folders.**
Usually the folder name was **too short** for the Start Position + Length in the
Claim-ID Rule, or produced an empty ID. Check the rule against your folder naming.

**Q: Why won't the app accept `C:\...` as a scan/folder path?**
For safety, paths must be on a drive letter **other than C:** (the system drive). Use
`D:\...` or another data drive.

**Q (Admin): A user can't see a category I made.**
Their **scope must match the category's scope exactly** (same User Type **and** Project
Type). Use **impersonation** to see exactly what they see, then fix the assignment or
the category.

**Q (Admin): I can't create a claim / import — it complains about status.**
The sub-category needs **one Default status**. Add statuses and mark one as Default.

---

[← Back to the manual index](README.md)
