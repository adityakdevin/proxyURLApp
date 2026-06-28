# 3. Team-Lead Guide

A **Team Lead** does everything an End User does — **plus** creates claims and assigns
them to people. This guide only covers the **extra** abilities. For the day-to-day
claim handling (documents, checks, status, notes), read the
[End-User Guide](02-end-user-guide.md) first.

[← Back to the manual index](README.md)

---

## 3.1 What's different for a Team Lead

| Team Lead can also… | Where |
|---|---|
| **Create** a new claim | "Add Claim" button on the Claims Dashboard |
| **Assign / reassign** a claim to any team member | "Reassign" field inside a claim |
| See **all claims in their scope**, not only their own | Claims Dashboard |

You also still do all normal claim work yourself.

---

## 3.2 Creating a new claim

1. Open the **Claims Dashboard**.
2. Click **Add Claim** (top right).
3. The **Add Claim** dialog opens.

> 📷 **Screenshot placeholder:** _The "Add Claim" dialog with its fields._

Fill in:

| Field | Required? | Notes |
|---|---|---|
| **Sub-Category** | ✅ Yes | Which section the claim belongs to. Determines its statuses and rules. |
| **Claim ID** | ✅ Yes | The claim's reference number (up to 100 characters). Must be unique within the sub-category. |
| **Folder Path** | Optional | The Windows folder on the server where the claim's files live, e.g. `D:\Claims\Daily\CLM10006`. Must start with a drive letter — **`C:\` is not allowed**. |
| **Assign to** | Optional | Pick the team member who will handle it. Leave blank to assign later. |
| **Initial Remark** | Optional | A first note to start the claim's history. |

4. Click **Save**.

The claim is created at the sub-category's **default status** (in our setup, **New**).

> 💡 If you set a **Folder Path**, the handler can later use **Sync from folder** on
> the claim to pull in the files automatically.

---

## 3.3 Assigning and reassigning a claim

A claim should normally have an owner so someone is responsible for it.

1. Open the claim from the dashboard.
2. In the **Update Claim** section, use the **Reassign** dropdown.
3. Choose the team member — or choose **Unassigned** to remove the current owner.
4. Add a **Remark** explaining the change (required) and click **Save**.

> 📷 **Screenshot placeholder:** _The Update Claim section showing the Reassign dropdown (Team Lead view)._

The reassignment is recorded in the **Remarks Timeline**, so there's always a record of
who handed the claim to whom and why.

> ⚠️ Once you reassign a claim to an End User, **only that user** (and Team
> Leads/Admins) will see it. Make sure you pick the right person.

---

## 3.4 Seeing the whole team's work

On the **Claims Dashboard**, a Team Lead is not limited to "Assigned to Me." You can:

- Leave **Assigned to Me** unticked to see **all claims in your scope**.
- Filter by **Workflow Status** to find, for example, everything stuck at **In
  Progress**.
- Filter by **Sub-Category** to focus on one section.

This makes it easy to spot claims that are unassigned, overdue, or piling up at a
stage.

---

## 3.5 Exporting

Like End Users, you can click **Export** on the dashboard to download the currently
filtered claim list as Excel — useful for status meetings or sharing progress.

---

**Everything else** (opening claims, documents, the five checks, statuses, notes, the
website menu) works exactly as described in the [End-User Guide](02-end-user-guide.md).
