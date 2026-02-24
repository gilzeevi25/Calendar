# Plan: User Management UI + Google Sheets Removal + Daily DB Backup

## Context

The Calendar/Roster project has been partially migrated from Google Sheets to Supabase.
The Supabase schema, auth layer (`auth.html`, `supabase-auth.js`), and data access layer
(`supabase-api.js`) are already in place. Both `index.html` and `roster.html` already call
Supabase directly via `checkAuthAndInit()`.

**What's left:**
1. No UI for managing people (add/edit/remove) — admins currently need to run SQL in Supabase
2. A Google Sheets link and legacy files (`apps-script.gs`, `data.csv`) still exist
3. The existing GitHub Action (`backup-csv.yml`) still downloads from Google Sheets

---

## Part 1: User Management Admin Page (`admin.html`)

### Goal
Create a standalone admin page where org admins/owners can manage the `people` table
(the roster of soldiers/colleagues in פלוגה ב) without touching Supabase SQL.

### 1.1 — New file: `admin.html`

A single-page admin UI following the same design system as `index.html` and `roster.html`:
- Hebrew RTL, `Heebo` + `Frank Ruhl Libre` fonts
- Same CSS variables (`--clr-bg`, `--clr-surface`, `--clr-border`, etc.)
- Dark mode toggle (same implementation as other pages)
- User info bar with avatar, org name, logout (via `supabase-auth.js`)

**Sections in the page:**

#### A) People Management Table
- Loads all rows from `people` table for the current org
- Columns: **Name** (`name`), **Association** (`association`), **Actions**
- Sortable by name or association
- Search/filter bar to quickly find a person
- Inline edit for name and association (click to edit, Enter/blur to save)
- Delete button per row with confirmation dialog
- Shows total count

#### B) Add People Form
- Text input for name
- Dropdown for association (auto-populated from existing distinct values + "Other..." option)
- "Add" button
- Bulk add: textarea where multiple names (comma or newline separated) can be added at once
- On add, calls `supabase.from('people').upsert(...)` and refreshes the table

#### C) Organization Members Section (visible to owners/admins only)
- Lists `organization_members` joined with `profiles` (name, email, role)
- Shows each member's role badge (owner/admin/member/viewer)
- Admin can change roles via dropdown (except: can't demote themselves from owner)
- "Generate invite link" button — creates a URL like `index.html?invite=<org_id>`
- This is the core feature that removes the need to enter Supabase for user management

### 1.2 — Data flow

```
admin.html
  ├── loads supabase-config.js, supabase-auth.js, supabase-api.js
  ├── checkAuthAndInit(initAdmin)
  └── initAdmin():
       ├── fetch people → render table
       ├── fetch org members + profiles → render members section
       └── bind CRUD event handlers
```

All Supabase calls use the existing authenticated client. RLS policies already restrict
access to the current org. The `is_org_admin()` PostgreSQL function already gates
write access on `people` and `organization_members`.

### 1.3 — New API functions (add to `supabase-api.js`)

```javascript
// Fetch all people for current org
async function fetchPeople()
  → supabase.from('people').select('id, name, association').eq('org_id', currentOrgId).order('name')

// Update a person's name or association
async function updatePerson(personId, { name, association })
  → supabase.from('people').update({ name, association, updated_at: new Date() }).eq('id', personId)

// Delete a person (cascades to calendar_entries, shift_assignments via FK)
async function deletePerson(personId)
  → supabase.from('people').delete().eq('id', personId)

// Fetch org members with profiles
async function fetchOrgMembers()
  → supabase.from('organization_members')
      .select('id, user_id, role, profiles(email, full_name, avatar_url)')
      .eq('org_id', currentOrgId)

// Update a member's role
async function updateMemberRole(membershipId, newRole)
  → supabase.from('organization_members').update({ role: newRole }).eq('id', membershipId)

// Remove a member from the org
async function removeMember(membershipId)
  → supabase.from('organization_members').delete().eq('id', membershipId)
```

### 1.4 — Navigation

Add a link/button to `admin.html` from both `index.html` and `roster.html` headers
(visible only to admins/owners). Use a gear/settings icon with the text "ניהול" (Management).

---

## Part 2: Remove All Google Sheets References

### Goal
After migration is complete, there should be **no trace** of Google Sheets — no links,
no opening, no referral.

### 2.1 — `index.html`: Remove the Google Sheets link

**Current code** (line ~2579):
```html
<a class="header__sheet-link" href="https://docs.google.com/spreadsheets/d/1AL55-KKFtd2jM2pAGwqZoacYm-kIcqFx-K-DOht-COA/edit" ...>
  פתח גיליון נתונים
</a>
```

**Action:** Remove this entire `<a>` element and the related CSS classes:
- `.header__sheet-link`
- `.header__sheet-link:hover`
- `.header__sheet-link svg`

Replace with a link to the new admin page (for admins):
```html
<a class="header__admin-link" href="admin.html">
  <svg><!-- gear icon --></svg>
  ניהול אנשים
</a>
```

### 2.2 — Delete `apps-script.gs`

This file contains the legacy Google Apps Script backend. It's no longer called by
any frontend code (all calls now go through `supabase-api.js`). Delete it entirely.

### 2.3 — Clean up `migrate-data.js`

This file references the Apps Script URL for one-time migration. Two options:
- **Option A (recommended):** Keep the file but add a clear header comment marking it as
  "already executed, kept for reference only". Remove the Apps Script URL constant to
  prevent accidental calls.
- **Option B:** Delete it entirely if migration has been completed.

### 2.4 — `data.csv`

This is the legacy CSV export from Google Sheets. Two options:
- **Option A (recommended):** Keep it as a static backup but remove from `.gitignore` tracking
  (stop committing updates). Add a comment to the top or rename to `data.csv.bak`.
- **Option B:** Delete it if confident all data is in Supabase.

### 2.5 — `SUPABASE_MIGRATION_PLAN.md`

Remove references to Google Sheets being "read-only backup for 2 weeks" (Phase 8.2 step 5)
since migration is now complete. Or mark the entire plan as "COMPLETED".

---

## Part 3: GitHub Action — Daily Supabase Database Backup to CSV

### Goal
Replace the current `backup-csv.yml` (which downloads from Google Sheets) with a new
workflow that exports data from Supabase into CSV files, stored as GitHub Actions artifacts.
Each day's backup should have a unique name — artifacts must NOT override each other.

### 3.1 — New workflow: `.github/workflows/backup-csv.yml` (replace existing)

```yaml
name: Daily Supabase Database Backup

on:
  schedule:
    - cron: '0 3 * * *'   # Every day at 3:00 AM UTC (6:00 AM Israel)
  workflow_dispatch:        # Manual trigger

jobs:
  backup:
    runs-on: ubuntu-latest
    env:
      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}

    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm install @supabase/supabase-js

      - name: Export database tables to CSV
        run: node .github/scripts/backup-to-csv.js

      - name: Upload backup artifact (per-day, never overrides)
        uses: actions/upload-artifact@v4
        with:
          name: db-backup-${{ github.run_id }}-$(date +%Y-%m-%d)
          path: backups/
          retention-days: 90
```

### 3.2 — New script: `.github/scripts/backup-to-csv.js`

A Node.js script that:

1. Connects to Supabase using the **service role key** (bypasses RLS)
2. Exports each table as a separate CSV file into a `backups/` directory
3. Mirrors the original Google Sheets structure with multiple "sheets":

| CSV File | Source Table | Columns |
|---|---|---|
| `people.csv` | `people` | name, association |
| `calendar_entries.csv` | `calendar_entries` + `people` join | name, date, status, note, association |
| `shifts.csv` | `shifts` + `mission_types` join | date, mission_type, start_time, end_time, note |
| `shift_assignments.csv` | `shift_assignments` + `people` + `shifts` join | shift_date, mission_type, person_name, role, is_manual |
| `roster_config.csv` | `roster_config` | key, value |
| `organization_members.csv` | `organization_members` + `profiles` | email, full_name, role |

```
backups/
├── people.csv
├── calendar_entries.csv
├── shifts.csv
├── shift_assignments.csv
├── roster_config.csv
└── organization_members.csv
```

**Key implementation details:**

```javascript
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// For each table: query all rows, convert to CSV, write to backups/ dir
// Join people names into calendar_entries and shift_assignments for readability
```

### 3.3 — Artifact naming strategy

Artifacts are named with the pattern:
```
db-backup-<run_id>-<YYYY-MM-DD>
```

Since `run_id` is unique per workflow run and the date is appended, artifacts
**never override each other**. GitHub retains them for 90 days (configurable).

### 3.4 — Required GitHub Secrets

Two secrets must be configured in the repository settings:

| Secret | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://kcujtvxekwsrycjzeiuy.supabase.co` | Already known from `supabase-config.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | (from Supabase dashboard) | **Never expose in client code** — only used server-side in the GitHub Action |

### 3.5 — Remove old secret

The old `GOOGLE_SHEET_PUBID` secret is no longer needed and can be removed from
repository settings.

---

## File Changes Summary

| File | Action | Description |
|---|---|---|
| `admin.html` | **CREATE** | User management admin page |
| `supabase-api.js` | **EDIT** | Add `fetchPeople`, `updatePerson`, `deletePerson`, `fetchOrgMembers`, `updateMemberRole`, `removeMember` |
| `index.html` | **EDIT** | Remove Google Sheets link + CSS, add admin link |
| `roster.html` | **EDIT** | Add admin link to header (optional) |
| `apps-script.gs` | **DELETE** | Legacy Google Apps Script — no longer used |
| `migrate-data.js` | **EDIT** | Mark as completed, remove Apps Script URL |
| `.github/workflows/backup-csv.yml` | **REPLACE** | From Google Sheets download to Supabase CSV export |
| `.github/scripts/backup-to-csv.js` | **CREATE** | Node.js backup export script |

---

## Implementation Order

```
Step 1: Add new API functions to supabase-api.js
Step 2: Create admin.html (user management page)
Step 3: Edit index.html — remove Google Sheets link, add admin link
Step 4: Delete apps-script.gs
Step 5: Clean up migrate-data.js
Step 6: Replace backup-csv.yml with Supabase backup workflow
Step 7: Create .github/scripts/backup-to-csv.js
Step 8: Commit and push
```

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Deleting a person cascades to all their calendar entries and shift assignments | Show a strong confirmation dialog with count of affected records |
| Service role key exposure | Only used in GitHub Actions env, never in client code |
| Backup workflow fails silently | Add a validation step that checks CSV row counts > 0 |
| Free tier project pauses after inactivity | The daily backup workflow pings Supabase, keeping it active |
