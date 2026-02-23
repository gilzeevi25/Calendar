# Supabase Migration Plan - Calendar & Roster System

## Current State

| Component | Current | Target |
|---|---|---|
| Backend | Google Apps Script | Supabase (PostgreSQL + Auth + API) |
| Database | Google Sheets (4 sheets) | Supabase PostgreSQL |
| Auth | None (shared internal tool) | Google OAuth via Supabase Auth |
| Frontend | Vanilla JS (index.html, roster.html) | Vanilla JS (same, refactored) |
| Hosting | Static files | Same (GitHub Pages / Netlify / Vercel) |

## Supabase Free Tier Constraints

| Resource | Limit | Our Expected Usage |
|---|---|---|
| Database Storage | 500 MB | ~5-50 MB (very comfortable) |
| File Storage | 1 GB | Not needed initially |
| Auth MAUs | 50,000 | Well under limit |
| API Requests | Unlimited | Comfortable |
| Concurrent Connections | 200 | Comfortable |
| Active Projects | 2 | Need 1 |
| Inactivity Pause | After 1 week | Must keep active or accept pause |

**Risk:** Free tier projects pause after 1 week of inactivity. If this calendar is used
regularly (weekly+), this is not a problem. Otherwise, consider the Pro plan ($25/month)
or implement a keep-alive cron job.

---

## Phase 0: Preparation & Supabase Project Setup

### Step 0.1 - Create Supabase Project
1. Sign up at [supabase.com](https://supabase.com) with your Google account
2. Create a new project (name: `calendar-roster` or similar)
3. Choose the region closest to your users (e.g., `eu-central-1` for Israel)
4. Save the project credentials:
   - **Project URL**: `https://<project-id>.supabase.co`
   - **Anon (public) key**: for client-side access
   - **Service role key**: for admin operations only (never expose to client)
5. Note the database connection string for direct PostgreSQL access if needed

### Step 0.2 - Configure Google OAuth
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or reuse existing)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth Client ID**
5. Choose **Web Application**
6. Set **Authorized JavaScript Origins**:
   - `https://<your-site-domain>` (production)
   - `http://localhost:8080` (local development)
   - `https://<project-id>.supabase.co`
7. Set **Authorized Redirect URIs**:
   - `https://<project-id>.supabase.co/auth/v1/callback`
8. Copy the **Client ID** and **Client Secret**
9. In Supabase Dashboard: **Authentication > Providers > Google**
   - Enable Google provider
   - Paste Client ID and Client Secret
   - Save

### Step 0.3 - Install Supabase Client Library
Since this is a vanilla JS project (no npm/bundler), use the CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
```

Create a shared config file:
```javascript
// supabase-config.js
const SUPABASE_URL = 'https://<project-id>.supabase.co';
const SUPABASE_ANON_KEY = '<your-anon-key>';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

---

## Phase 1: Database Schema Design

### Step 1.1 - Core Tables

Run the following SQL in the Supabase SQL Editor to create the multi-tenant schema:

```sql
-- ============================================================
-- USERS & ORGANIZATIONS
-- ============================================================

-- Organizations (each "calendar instance" belongs to an org)
CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_by  UUID NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Organization members (who can access which org)
CREATE TABLE organization_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, user_id)
);

-- User profiles (cached Google info)
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  full_name   TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- CALENDAR DATA (migrated from Google Sheets "data" sheet)
-- ============================================================

-- People in the calendar (replaces name list from CSV)
CREATE TABLE people (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  association TEXT,           -- team/division (e.g., "platoon 1")
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

-- Calendar entries (replaces rows in data.csv / Google Sheets "data" sheet)
CREATE TABLE calendar_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'home'
              CHECK (status IN ('activity', 'home', 'switch-home', 'switch-base')),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, person_id, date)
);

-- Calendar configuration (date range, special days, etc.)
CREATE TABLE calendar_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, key)
);

-- ============================================================
-- ROSTER DATA (migrated from Google Sheets roster sheets)
-- ============================================================

-- Mission types (replaces roster_config mission_types)
CREATE TABLE mission_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,            -- e.g., "patrol", "guard"
  display_name    TEXT NOT NULL,            -- e.g., "סיור", "שמירה"
  color           TEXT,                     -- hex color
  default_hours   NUMERIC,                 -- default shift duration
  min_people      INT DEFAULT 1,
  required_roles  TEXT[] DEFAULT '{}',      -- e.g., {"commander","driver"}
  sort_order      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

-- Shifts (replaces roster_shifts sheet)
CREATE TABLE shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mission_type_id UUID NOT NULL REFERENCES mission_types(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Shift assignments (replaces roster_assignments sheet)
CREATE TABLE shift_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role            TEXT,                    -- e.g., "commander", "driver", null for regular
  is_auto         BOOLEAN DEFAULT false,   -- auto-scheduled vs manual
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(shift_id, person_id)
);

-- Roster scheduling config (parameters, buddy rules, exclusions, tags)
CREATE TABLE roster_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, key)
);

-- ============================================================
-- INDEXES for performance
-- ============================================================

CREATE INDEX idx_calendar_entries_org_date ON calendar_entries(org_id, date);
CREATE INDEX idx_calendar_entries_person ON calendar_entries(person_id);
CREATE INDEX idx_shifts_org_date ON shifts(org_id, date);
CREATE INDEX idx_shift_assignments_shift ON shift_assignments(shift_id);
CREATE INDEX idx_shift_assignments_person ON shift_assignments(person_id);
CREATE INDEX idx_people_org ON people(org_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);
CREATE INDEX idx_org_members_org ON organization_members(org_id);
```

### Step 1.2 - Row Level Security (RLS) Policies

This is **critical** for multi-tenant security. Each user only sees data from
organizations they belong to.

```sql
-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_config ENABLE ROW LEVEL SECURITY;

-- Helper function: check if user is a member of an org
CREATE OR REPLACE FUNCTION is_org_member(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = check_org_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: check if user is admin/owner of an org
CREATE OR REPLACE FUNCTION is_org_admin(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = check_org_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---- PROFILES ----
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (id = auth.uid());
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT WITH CHECK (id = auth.uid());

-- ---- ORGANIZATIONS ----
CREATE POLICY "Members can view their orgs"
  ON organizations FOR SELECT USING (is_org_member(id));
CREATE POLICY "Authenticated users can create orgs"
  ON organizations FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Admins can update orgs"
  ON organizations FOR UPDATE USING (is_org_admin(id));

-- ---- ORGANIZATION MEMBERS ----
CREATE POLICY "Members can view org members"
  ON organization_members FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage org members"
  ON organization_members FOR INSERT WITH CHECK (is_org_admin(org_id));
CREATE POLICY "Admins can update org members"
  ON organization_members FOR UPDATE USING (is_org_admin(org_id));
CREATE POLICY "Admins can remove org members"
  ON organization_members FOR DELETE USING (is_org_admin(org_id));

-- ---- PEOPLE ----
CREATE POLICY "Members can view people"
  ON people FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage people"
  ON people FOR ALL USING (is_org_admin(org_id));

-- ---- CALENDAR ENTRIES ----
CREATE POLICY "Members can view entries"
  ON calendar_entries FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Members can manage entries"
  ON calendar_entries FOR ALL USING (is_org_member(org_id));

-- ---- CALENDAR CONFIG ----
CREATE POLICY "Members can view config"
  ON calendar_config FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage config"
  ON calendar_config FOR ALL USING (is_org_admin(org_id));

-- ---- MISSION TYPES ----
CREATE POLICY "Members can view mission types"
  ON mission_types FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage mission types"
  ON mission_types FOR ALL USING (is_org_admin(org_id));

-- ---- SHIFTS ----
CREATE POLICY "Members can view shifts"
  ON shifts FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Members can manage shifts"
  ON shifts FOR ALL USING (is_org_member(org_id));

-- ---- SHIFT ASSIGNMENTS ----
CREATE POLICY "Members can view assignments"
  ON shift_assignments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM shifts s WHERE s.id = shift_id AND is_org_member(s.org_id)
  ));
CREATE POLICY "Members can manage assignments"
  ON shift_assignments FOR ALL
  USING (EXISTS (
    SELECT 1 FROM shifts s WHERE s.id = shift_id AND is_org_member(s.org_id)
  ));

-- ---- ROSTER CONFIG ----
CREATE POLICY "Members can view roster config"
  ON roster_config FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage roster config"
  ON roster_config FOR ALL USING (is_org_admin(org_id));
```

### Step 1.3 - Auto-Create Profile on Signup (Database Trigger)

```sql
-- Automatically create a profile when a user signs up via Google
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
```

---

## Phase 2: Authentication Layer

### Step 2.1 - Create Auth UI

Create a new file `auth.html` (or add a login section to `index.html`):

```html
<!-- Login page / modal -->
<div id="auth-container" style="display:none;">
  <h2>Calendar & Roster System</h2>
  <p>Sign in with your Google account to continue</p>
  <button id="google-login-btn" onclick="signInWithGoogle()">
    Sign in with Google
  </button>
</div>
```

### Step 2.2 - Auth JavaScript Logic

Create `supabase-auth.js`:

```javascript
// supabase-auth.js - Authentication module

async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname
    }
  });
  if (error) {
    console.error('Login error:', error.message);
    showToast('Login failed: ' + error.message, 'error');
  }
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error('Logout error:', error.message);
  window.location.reload();
}

async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Listen for auth state changes
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN') {
    document.getElementById('auth-container').style.display = 'none';
    initApp(session); // Start the app
  } else if (event === 'SIGNED_OUT') {
    document.getElementById('auth-container').style.display = 'block';
    // Hide app content
  }
});

// On page load, check if user is already logged in
async function checkAuth() {
  const session = await getSession();
  if (session) {
    document.getElementById('auth-container').style.display = 'none';
    initApp(session);
  } else {
    document.getElementById('auth-container').style.display = 'block';
  }
}
```

### Step 2.3 - Organization Selection / Creation

After login, user needs to select or create an organization:

```javascript
// After login, fetch user's orgs
async function loadUserOrganizations() {
  const { data: memberships, error } = await supabase
    .from('organization_members')
    .select('org_id, role, organizations(id, name)')
    .eq('user_id', (await getCurrentUser()).id);

  if (memberships.length === 0) {
    // Show "Create Organization" dialog
    showCreateOrgDialog();
  } else if (memberships.length === 1) {
    // Auto-select the only org
    setCurrentOrg(memberships[0].organizations);
  } else {
    // Show org picker
    showOrgPicker(memberships);
  }
}

async function createOrganization(name) {
  const user = await getCurrentUser();

  // Create org
  const { data: org, error } = await supabase
    .from('organizations')
    .insert({ name, created_by: user.id })
    .select()
    .single();

  // Add creator as owner
  await supabase
    .from('organization_members')
    .insert({ org_id: org.id, user_id: user.id, role: 'owner' });

  // Seed default mission types
  await seedDefaultMissionTypes(org.id);

  setCurrentOrg(org);
}
```

---

## Phase 3: Data Access Layer (Replace Apps Script API)

### Step 3.1 - Create `supabase-api.js`

This file replaces all calls currently going to Google Apps Script.

```javascript
// supabase-api.js - Data access layer
// Replaces apps-script.gs API calls

let currentOrgId = null; // Set after org selection

function setCurrentOrg(org) {
  currentOrgId = org.id;
  localStorage.setItem('currentOrgId', org.id);
}

// ============================================================
// CALENDAR DATA (replaces getData, updateCells, addPeople)
// ============================================================

async function fetchCalendarData() {
  // Replaces: action=getData
  const { data: people, error: pErr } = await supabase
    .from('people')
    .select('id, name, association')
    .eq('org_id', currentOrgId)
    .order('name');

  const { data: entries, error: eErr } = await supabase
    .from('calendar_entries')
    .select('id, person_id, date, status, note')
    .eq('org_id', currentOrgId)
    .order('date');

  // Transform to the format the existing frontend expects:
  // Array of { name, date, status, note, association }
  const peopleMap = Object.fromEntries(people.map(p => [p.id, p]));
  const rows = entries.map(e => ({
    name: peopleMap[e.person_id]?.name,
    date: e.date,
    status: e.status,
    note: e.note || '',
    association: peopleMap[e.person_id]?.association || ''
  }));

  return rows;
}

async function updateCalendarCells(updates) {
  // Replaces: action=updateCells
  // updates = [{ name, date, status, note }, ...]

  for (const update of updates) {
    // Look up person_id
    const { data: person } = await supabase
      .from('people')
      .select('id')
      .eq('org_id', currentOrgId)
      .eq('name', update.name)
      .single();

    if (!person) continue;

    await supabase
      .from('calendar_entries')
      .upsert({
        org_id: currentOrgId,
        person_id: person.id,
        date: update.date,
        status: update.status,
        note: update.note || null
      }, {
        onConflict: 'org_id,person_id,date'
      });
  }
}

async function addPeople(names, dateStart, dateEnd, defaultStatus) {
  // Replaces: action=addPeople
  for (const name of names) {
    // Insert person
    const { data: person } = await supabase
      .from('people')
      .upsert({ org_id: currentOrgId, name }, { onConflict: 'org_id,name' })
      .select()
      .single();

    // Generate date range entries
    const entries = [];
    let d = new Date(dateStart);
    const end = new Date(dateEnd);
    while (d <= end) {
      entries.push({
        org_id: currentOrgId,
        person_id: person.id,
        date: d.toISOString().slice(0, 10),
        status: defaultStatus || 'home'
      });
      d.setDate(d.getDate() + 1);
    }

    await supabase
      .from('calendar_entries')
      .upsert(entries, { onConflict: 'org_id,person_id,date' });
  }
}

// ============================================================
// ROSTER DATA (replaces getRosterShifts, saveRosterShifts, etc.)
// ============================================================

async function fetchRosterShifts(dateStart, dateEnd) {
  // Replaces: action=getRosterShifts
  const { data: shifts } = await supabase
    .from('shifts')
    .select(`
      id, date, start_time, end_time, note,
      mission_type_id,
      mission_types(name, display_name, color),
      shift_assignments(id, person_id, role, is_auto,
        people(name))
    `)
    .eq('org_id', currentOrgId)
    .gte('date', dateStart)
    .lte('date', dateEnd)
    .order('date')
    .order('start_time');

  return shifts;
}

async function saveRosterShifts(shiftsData) {
  // Replaces: action=saveRosterShifts
  const rows = shiftsData.map(s => ({
    id: s.id || undefined,
    org_id: currentOrgId,
    mission_type_id: s.mission_type_id,
    date: s.date,
    start_time: s.start_time,
    end_time: s.end_time,
    note: s.note || null
  }));

  const { data, error } = await supabase
    .from('shifts')
    .upsert(rows)
    .select();

  return data;
}

async function deleteRosterShifts(shiftIds) {
  // Replaces: action=deleteRosterShifts
  // Assignments cascade-delete automatically
  await supabase
    .from('shifts')
    .delete()
    .in('id', shiftIds);
}

async function saveRosterAssignments(assignments) {
  // Replaces: action=saveRosterAssignments
  const rows = assignments.map(a => ({
    shift_id: a.shift_id,
    person_id: a.person_id,
    role: a.role || null,
    is_auto: a.is_auto || false
  }));

  await supabase
    .from('shift_assignments')
    .upsert(rows, { onConflict: 'shift_id,person_id' });
}

async function clearRosterAssignments(shiftIds, autoOnly) {
  // Replaces: action=clearRosterAssignments
  let query = supabase
    .from('shift_assignments')
    .delete()
    .in('shift_id', shiftIds);

  if (autoOnly) {
    query = query.eq('is_auto', true);
  }

  await query;
}

// ============================================================
// ROSTER CONFIG (replaces getRosterConfig, saveRosterConfig)
// ============================================================

async function fetchRosterConfig() {
  const { data } = await supabase
    .from('roster_config')
    .select('key, value')
    .eq('org_id', currentOrgId);

  // Convert array of {key, value} to object
  return Object.fromEntries((data || []).map(r => [r.key, r.value]));
}

async function saveRosterConfig(key, value) {
  await supabase
    .from('roster_config')
    .upsert({
      org_id: currentOrgId,
      key,
      value
    }, { onConflict: 'org_id,key' });
}

// ============================================================
// MISSION TYPES
// ============================================================

async function fetchMissionTypes() {
  const { data } = await supabase
    .from('mission_types')
    .select('*')
    .eq('org_id', currentOrgId)
    .order('sort_order');
  return data;
}

async function seedDefaultMissionTypes(orgId) {
  const defaults = [
    { name: 'patrol', display_name: 'סיור', color: '#4a90d9',
      default_hours: 8, min_people: 3, required_roles: ['commander', 'driver'], sort_order: 1 },
    { name: 'guard', display_name: 'שמירה', color: '#e8a838',
      default_hours: 4, min_people: 1, required_roles: [], sort_order: 2 },
    { name: 'kitchen', display_name: 'תורנות מטבח', color: '#50b86c',
      default_hours: 24, min_people: 1, required_roles: [], sort_order: 3 },
    { name: 'qrf', display_name: 'כח כונן', color: '#d94a4a',
      default_hours: 24, min_people: 3, required_roles: ['commander'], sort_order: 4 }
  ];

  await supabase
    .from('mission_types')
    .insert(defaults.map(d => ({ ...d, org_id: orgId })));
}
```

---

## Phase 4: Frontend Migration (Step-by-Step Refactor)

### Step 4.1 - Add Shared Scripts to Both Pages

Add to both `index.html` and `roster.html`:

```html
<!-- Before closing </body> tag, add: -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script src="supabase-config.js"></script>
<script src="supabase-auth.js"></script>
<script src="supabase-api.js"></script>
```

### Step 4.2 - Refactor `index.html` Data Loading

**Current flow:**
```
loadData() -> fetch(APPS_SCRIPT_URL, {action: 'getData'}) -> parse CSV -> build maps
```

**New flow:**
```
checkAuth() -> loadUserOrganizations() -> initApp() -> fetchCalendarData() -> build maps
```

Key changes:
1. Wrap the existing `DOMContentLoaded` initialization in a new `initApp(session)` function
2. Replace `loadData()` internals to call `fetchCalendarData()` instead of Apps Script
3. Replace `saveChanges()` to call `updateCalendarCells()` instead of Apps Script
4. Replace `addPeopleToSheet()` to call `addPeople()` instead of Apps Script
5. Add auth UI (login button, user avatar, org name display, logout button)
6. Keep all existing UI logic (calendar grid, drag-edit, notes, etc.) unchanged

### Step 4.3 - Refactor `roster.html` Data Loading

**Current flow:**
```
loadRosterConfig() -> fetch(APPS_SCRIPT_URL, {action: 'getRosterConfig'})
loadShifts()       -> fetch(APPS_SCRIPT_URL, {action: 'getRosterShifts'})
```

**New flow:**
```
checkAuth() -> initApp() -> fetchRosterConfig() + fetchRosterShifts() + fetchMissionTypes()
```

Key changes:
1. Replace all `fetchFromAppsScript()` calls with Supabase API calls
2. Replace shift save/delete operations
3. Replace assignment save/clear operations
4. Replace config save/load operations
5. Keep all existing UI and auto-scheduling algorithm unchanged

### Step 4.4 - Add Navigation & User UI

Add to both pages:
- User avatar + name display (from Google profile)
- Organization name display
- Organization switcher (if user belongs to multiple)
- "Invite members" button (for org admins)
- Logout button

---

## Phase 5: Data Migration (One-Time)

### Step 5.1 - Export Current Data

```javascript
// Run this in browser console on current site to export data
// Or use the existing data.csv + Apps Script data

// Option A: Download from current Google Sheets directly
// Option B: Use the existing data.csv as source
```

### Step 5.2 - Import Script

Create a one-time migration script (`migrate-data.js`) to:

1. Read existing `data.csv` (or fetch from current Apps Script)
2. Create an organization for the existing team
3. Insert all people (extract unique names from CSV)
4. Insert all calendar entries (map CSV rows to calendar_entries)
5. Fetch existing roster config from Apps Script and insert into roster_config
6. Fetch existing shifts and assignments and insert into shifts/shift_assignments
7. Invite existing team members (if their emails are known)

```javascript
// migrate-data.js (run once, using service role key)
async function migrateFromCSV(csvText, orgId) {
  const rows = parseCSV(csvText);
  const uniqueNames = [...new Set(rows.map(r => r.name))];

  // 1. Insert people
  const { data: people } = await supabase
    .from('people')
    .upsert(uniqueNames.map(name => ({
      org_id: orgId,
      name,
      association: rows.find(r => r.name === name)?.association || null
    })), { onConflict: 'org_id,name' })
    .select();

  const personMap = Object.fromEntries(people.map(p => [p.name, p.id]));

  // 2. Insert calendar entries (batch in chunks of 500)
  const entries = rows.map(r => ({
    org_id: orgId,
    person_id: personMap[r.name],
    date: r.date,
    status: r.status,
    note: r.note || null
  }));

  for (let i = 0; i < entries.length; i += 500) {
    await supabase
      .from('calendar_entries')
      .upsert(entries.slice(i, i + 500), { onConflict: 'org_id,person_id,date' });
  }

  console.log(`Migrated ${people.length} people, ${entries.length} entries`);
}
```

### Step 5.3 - Verify Migration

- Compare row counts: CSV rows vs calendar_entries count
- Spot-check random entries for correctness
- Verify roster shifts and assignments transferred correctly
- Test the UI loads data correctly from Supabase

---

## Phase 6: Realtime Collaboration (Optional Enhancement)

Supabase supports realtime subscriptions on the free tier:

```javascript
// Subscribe to calendar changes for live collaboration
const channel = supabase
  .channel('calendar-changes')
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'calendar_entries',
      filter: `org_id=eq.${currentOrgId}` },
    (payload) => {
      // Update local state when another user makes changes
      handleRealtimeUpdate(payload);
    }
  )
  .subscribe();
```

This gives you live multi-user editing for free.

---

## Phase 7: Invite & Member Management

### Step 7.1 - Invite Flow

```javascript
async function inviteUserByEmail(email, role = 'member') {
  // Option A: Generate a shareable invite link with org ID
  const inviteLink = `${window.location.origin}/index.html?invite=${currentOrgId}`;

  // Option B: Use Supabase Edge Function to send email invite
  // (requires Edge Function setup)

  // On the receiving end, after Google login:
  // Check URL for invite param, add user to organization
}

async function handleInviteAcceptance(orgId) {
  const user = await getCurrentUser();
  await supabase
    .from('organization_members')
    .insert({ org_id: orgId, user_id: user.id, role: 'member' });
}
```

### Step 7.2 - Role-Based UI

| Role | Can View | Can Edit Calendar | Can Edit Roster | Can Manage Members | Can Delete Org |
|---|---|---|---|---|---|
| viewer | Yes | No | No | No | No |
| member | Yes | Yes | Yes | No | No |
| admin | Yes | Yes | Yes | Yes | No |
| owner | Yes | Yes | Yes | Yes | Yes |

---

## Phase 8: Testing & Cutover

### Step 8.1 - Testing Checklist

- [ ] Google OAuth login works
- [ ] New user auto-creates profile
- [ ] Organization creation works
- [ ] Calendar data loads correctly
- [ ] Calendar edit + save works
- [ ] Add people works
- [ ] Roster shifts load correctly
- [ ] Shift create/edit/delete works
- [ ] Assignment create/clear works
- [ ] Auto-scheduling algorithm works with new data format
- [ ] Roster config save/load works
- [ ] Multi-user: two users see same data
- [ ] RLS: users cannot see other orgs' data
- [ ] Realtime updates work between browsers
- [ ] Invite flow works
- [ ] Mobile responsiveness preserved

### Step 8.2 - Cutover Plan

1. Deploy new frontend files (with Supabase integration) alongside old ones
2. Run data migration script
3. Test thoroughly with 2-3 team members
4. Switch DNS / update links to point to new version
5. Keep Google Sheets as read-only backup for 2 weeks
6. Decommission Apps Script after confidence period

---

## File Structure After Migration

```
/home/user/Calendar/
├── index.html              (refactored - calendar view with auth)
├── roster.html             (refactored - roster view with auth)
├── supabase-config.js      (NEW - Supabase client init)
├── supabase-auth.js        (NEW - Google OAuth auth logic)
├── supabase-api.js         (NEW - data access layer)
├── migrate-data.js         (NEW - one-time migration script)
├── apps-script.gs          (DEPRECATED - keep for reference)
├── data.csv                (DEPRECATED - keep as backup)
├── README.md               (update with new setup instructions)
└── ...
```

---

## Implementation Order (Recommended)

| Step | Description | Dependencies |
|---|---|---|
| 1 | Create Supabase project + configure Google OAuth | None |
| 2 | Run Phase 1 SQL (schema + RLS + triggers) | Step 1 |
| 3 | Create `supabase-config.js` | Step 1 |
| 4 | Create `supabase-auth.js` + add auth UI | Step 3 |
| 5 | Create `supabase-api.js` | Step 3 |
| 6 | Refactor `index.html` to use new API | Steps 4, 5 |
| 7 | Refactor `roster.html` to use new API | Steps 4, 5 |
| 8 | Run data migration script | Steps 2, 6 |
| 9 | Test end-to-end | Steps 6, 7, 8 |
| 10 | Add realtime collaboration | Step 9 |
| 11 | Add invite/member management | Step 9 |
| 12 | Cutover & decommission Apps Script | Steps 9, 10, 11 |

---

## Cost Projection

| Users | Tier | Monthly Cost |
|---|---|---|
| 1-10 users, light usage | Free | $0 |
| 10-50 users, daily usage | Free | $0 |
| 50-100+ users, heavy usage | Pro | $25/month |
| 500+ users, enterprise | Pro + compute addon | $25 + usage |

The free tier is more than sufficient for the initial rollout. The 500 MB database
limit can hold millions of calendar entries. Upgrade to Pro only when you need:
- No auto-pause on inactivity
- Daily backups
- 8 GB database
- Email support
