# ProxyURLApp — User Manual

Welcome! This manual explains how to use ProxyURLApp from start to finish, in plain
language. You do **not** need any technical background to follow it.

> 📷 **Screenshot placeholder:** _Login screen of the application._

---

## What is ProxyURLApp?

ProxyURLApp is a secure web application your organization uses to **process claims**
and to give staff **controlled access to selected websites and tools**.

It does two main jobs:

1. **Claims processing** — Staff review claims (for example, dealer/warranty claims),
   check that the supporting documents are genuine using automatic checks, move each
   claim through a set of stages, and record notes about what they did.
2. **Controlled website access** — Instead of letting everyone reach every website,
   the app shows each person a tidy menu of only the links they are allowed to open,
   and opens those links safely "through" the app.

Everything you can see and do depends on your **role** and your **assignment**
(explained below). The app keeps a full history of who did what.

---

## Who should read which part

This manual is split into short guides. Read the one that matches your role — you can
ignore the rest.

| If you are a… | Read this | What you'll learn |
|---|---|---|
| **Anybody (first time)** | [1. Getting Started](guide/01-getting-started.md) | How to log in, change your password, find your way around, and log out. |
| **End User** (you handle claims assigned to you) | [2. End-User Guide](guide/02-end-user-guide.md) | Working your claim list, opening documents, running the checks, changing status, leaving notes, using the website menu. |
| **Team Lead** (you also create and assign claims) | [3. Team-Lead Guide](guide/03-team-lead-guide.md) | Everything an end user does, **plus** creating claims, assigning/reassigning, and exporting. |
| **Administrator** (you set the system up) | [4. Admin Guide](guide/04-admin-guide.md) | Creating users, scopes, categories, statuses, rules, running scans, importing/exporting observations, and managing website links. |
| **Anybody (reference)** | [5. Glossary & FAQ](guide/05-glossary-and-faq.md) | Plain-English definitions, the five automatic checks explained, and answers to common problems. |
| **Tester / Admin** | [6. Demo Test Data](guide/06-demo-seed.md) | How to load ready-made sample data so you can try everything safely. |

---

## The three roles at a glance

| Role | Can do |
|---|---|
| **End User** | See and work **only the claims assigned to them**. Add documents, run checks, change status, write notes. Use their website menu. |
| **Team Lead** | Everything an End User can do, **plus** create new claims and assign/reassign them to people. |
| **Administrator** | Full control: create accounts, build the menu structure, define rules and statuses, run bulk scans, and import/export data. |

---

## How the pieces fit together (the big picture)

Think of the system as a set of nested boxes. Access flows from the top down:

```
Project                                ← you are assigned one
        │
        ▼
     Category                          ← a top-level grouping (e.g. "Vehicle Claims")
        │
        ▼
   Sub-Category                        ← a section inside a category (e.g. "Warranty Claims");
        │                                 your "scope" is the ones granted to you
        │
        ├──────────────► Claims        ← the actual cases you work on
        │
        └──────────────► Website links ← the menu items you can open
```

- Every user is assigned **one Project**, and the admin grants them specific
  **Sub-Categories** inside it. Those granted Sub-Categories are your **scope**.
- A **Category** belongs to a Project; a **Sub-Category** sits inside a Category.
- **Claims** and **website links** live under Sub-Categories.
- Because of this, you automatically see only the claims and links that belong to
  your scope — nothing more.

You'll find the full details in each guide. If a word is unfamiliar, check the
[Glossary](guide/05-glossary-and-faq.md).

---

## A note on screenshots

Throughout these guides you'll see lines like:

> 📷 **Screenshot placeholder:** _Description of the screen to capture._

These mark where a picture should go. Capture the described screen from your own
system and replace the placeholder line with the image.
