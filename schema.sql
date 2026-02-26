-- ============================================================
-- Calendar & Roster System — Complete Database Schema
-- ============================================================
-- Source of truth for disaster recovery.
-- If schema changes are made in Supabase, update this file to match.
-- ============================================================

-- ============================================================
-- USERS & ORGANIZATIONS
-- ============================================================

CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_by  UUID NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE organization_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, user_id)
);

CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  full_name   TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- CALENDAR DATA
-- ============================================================

CREATE TABLE people (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  association TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

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

CREATE TABLE calendar_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, key)
);

-- ============================================================
-- ROSTER DATA
-- ============================================================

CREATE TABLE mission_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  color           TEXT,
  default_hours   NUMERIC,
  min_people      INT DEFAULT 1,
  required_roles  TEXT[] DEFAULT '{}',
  sort_order      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

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

CREATE TABLE shift_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role            TEXT,
  is_auto         BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(shift_id, person_id)
);

CREATE TABLE roster_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, key)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_calendar_entries_org_date ON calendar_entries(org_id, date);
CREATE INDEX idx_calendar_entries_person ON calendar_entries(person_id);
CREATE INDEX idx_shifts_org_date ON shifts(org_id, date);
CREATE INDEX idx_shift_assignments_shift ON shift_assignments(shift_id);
CREATE INDEX idx_shift_assignments_person ON shift_assignments(person_id);
CREATE INDEX idx_people_org ON people(org_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);
CREATE INDEX idx_org_members_org ON organization_members(org_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

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

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION is_org_member(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = check_org_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_org_admin(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = check_org_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- RLS POLICIES
-- ============================================================

-- Profiles
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (id = auth.uid());
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT WITH CHECK (id = auth.uid());

-- Organizations
CREATE POLICY "Members can view their orgs"
  ON organizations FOR SELECT USING (is_org_member(id));
CREATE POLICY "Authenticated users can create orgs"
  ON organizations FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Admins can update orgs"
  ON organizations FOR UPDATE USING (is_org_admin(id));

-- Organization members
CREATE POLICY "Members can view org members"
  ON organization_members FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage org members"
  ON organization_members FOR INSERT WITH CHECK (is_org_admin(org_id));
CREATE POLICY "Admins can update org members"
  ON organization_members FOR UPDATE USING (is_org_admin(org_id));
CREATE POLICY "Admins can remove org members"
  ON organization_members FOR DELETE USING (is_org_admin(org_id));

-- People
CREATE POLICY "Members can view people"
  ON people FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage people"
  ON people FOR ALL USING (is_org_admin(org_id));

-- Calendar entries
CREATE POLICY "Members can view entries"
  ON calendar_entries FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Members can manage entries"
  ON calendar_entries FOR ALL USING (is_org_member(org_id));

-- Calendar config
CREATE POLICY "Members can view config"
  ON calendar_config FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage config"
  ON calendar_config FOR ALL USING (is_org_admin(org_id));

-- Mission types
CREATE POLICY "Members can view mission types"
  ON mission_types FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage mission types"
  ON mission_types FOR ALL USING (is_org_admin(org_id));

-- Shifts
CREATE POLICY "Members can view shifts"
  ON shifts FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Members can manage shifts"
  ON shifts FOR ALL USING (is_org_member(org_id));

-- Shift assignments
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

-- Roster config
CREATE POLICY "Members can view roster config"
  ON roster_config FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Admins can manage roster config"
  ON roster_config FOR ALL USING (is_org_admin(org_id));

-- ============================================================
-- TRIGGER: Auto-create profile on signup
-- ============================================================

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

-- ============================================================
-- RPC: Accept organization invite (bypasses RLS)
-- ============================================================
-- Called from supabase-api.js: supabase.rpc('accept_invite', { invite_org_id })

CREATE OR REPLACE FUNCTION accept_invite(invite_org_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO organization_members (org_id, user_id, role)
  VALUES (invite_org_id, auth.uid(), 'member')
  ON CONFLICT (org_id, user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
