/**
 * backup-to-csv.js — Export Supabase tables to CSV files for daily backup.
 *
 * Runs in GitHub Actions with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 * Uses the service role key to bypass RLS.
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BACKUP_DIR = path.join(process.cwd(), 'backups');

function toCsv(rows, columns) {
  if (!rows || rows.length === 0) return columns.join(',') + '\n';
  const header = columns.join(',');
  const lines = rows.map(row =>
    columns.map(col => {
      let val = row[col];
      if (val === null || val === undefined) return '';
      val = String(val);
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(',')
  );
  return header + '\n' + lines.join('\n') + '\n';
}

async function exportTable(filename, queryFn, columns) {
  try {
    const rows = await queryFn();
    const csv = toCsv(rows, columns);
    fs.writeFileSync(path.join(BACKUP_DIR, filename), csv, 'utf8');
    console.log(`  ${filename}: ${rows.length} rows`);
  } catch (err) {
    console.error(`  ERROR exporting ${filename}:`, err.message);
    process.exit(1);
  }
}

async function main() {
  console.log('Starting Supabase database backup...\n');

  // Create backup directory
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // 1. People
  await exportTable('people.csv', async () => {
    const { data, error } = await supabase.from('people').select('name, association').order('name');
    if (error) throw error;
    return data;
  }, ['name', 'association']);

  // 2. Calendar entries (joined with people for readability)
  await exportTable('calendar_entries.csv', async () => {
    const { data, error } = await supabase
      .from('calendar_entries')
      .select('date, status, note, people(name, association)')
      .order('date');
    if (error) throw error;
    return (data || []).map(e => ({
      name: e.people ? e.people.name : '',
      date: e.date,
      status: e.status,
      note: e.note || '',
      association: e.people ? (e.people.association || '') : ''
    }));
  }, ['name', 'date', 'status', 'note', 'association']);

  // 3. Shifts (joined with mission_types)
  await exportTable('shifts.csv', async () => {
    const { data, error } = await supabase
      .from('shifts')
      .select('date, start_time, end_time, note, mission_types(name)')
      .order('date');
    if (error) throw error;
    return (data || []).map(s => ({
      date: s.date,
      mission_type: s.mission_types ? s.mission_types.name : '',
      start_time: s.start_time || '',
      end_time: s.end_time || '',
      note: s.note || ''
    }));
  }, ['date', 'mission_type', 'start_time', 'end_time', 'note']);

  // 4. Shift assignments (joined with people and shifts)
  await exportTable('shift_assignments.csv', async () => {
    const { data, error } = await supabase
      .from('shift_assignments')
      .select('role, is_auto, shifts(date, mission_types(name)), people(name)')
      .order('created_at');
    if (error) throw error;
    return (data || []).map(a => ({
      shift_date: a.shifts ? a.shifts.date : '',
      mission_type: (a.shifts && a.shifts.mission_types) ? a.shifts.mission_types.name : '',
      person_name: a.people ? a.people.name : '',
      role: a.role || '',
      is_manual: a.is_auto ? 'FALSE' : 'TRUE'
    }));
  }, ['shift_date', 'mission_type', 'person_name', 'role', 'is_manual']);

  // 5. Roster config
  await exportTable('roster_config.csv', async () => {
    const { data, error } = await supabase.from('roster_config').select('key, value');
    if (error) throw error;
    return (data || []).map(r => ({
      key: r.key,
      value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value)
    }));
  }, ['key', 'value']);

  // 6. Organizations
  await exportTable('organizations.csv', async () => {
    const { data, error } = await supabase.from('organizations').select('name, created_at');
    if (error) throw error;
    return data;
  }, ['name', 'created_at']);

  // 7. Mission types
  await exportTable('mission_types.csv', async () => {
    const { data, error } = await supabase
      .from('mission_types')
      .select('name, display_name, color, default_hours, min_people, required_roles, sort_order')
      .order('sort_order');
    if (error) throw error;
    return (data || []).map(mt => ({
      name: mt.name,
      display_name: mt.display_name,
      color: mt.color || '',
      default_hours: mt.default_hours != null ? mt.default_hours : '',
      min_people: mt.min_people != null ? mt.min_people : '',
      required_roles: Array.isArray(mt.required_roles) ? JSON.stringify(mt.required_roles) : '',
      sort_order: mt.sort_order != null ? mt.sort_order : ''
    }));
  }, ['name', 'display_name', 'color', 'default_hours', 'min_people', 'required_roles', 'sort_order']);

  // 8. Calendar config
  await exportTable('calendar_config.csv', async () => {
    const { data, error } = await supabase.from('calendar_config').select('key, value');
    if (error) throw error;
    return (data || []).map(r => ({
      key: r.key,
      value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value)
    }));
  }, ['key', 'value']);

  // 9. Organization members (no direct FK to profiles, so query separately)
  await exportTable('organization_members.csv', async () => {
    const { data: members, error: memErr } = await supabase
      .from('organization_members')
      .select('user_id, role');
    if (memErr) throw memErr;
    if (!members || members.length === 0) return [];

    const userIds = members.map(m => m.user_id);
    const { data: profiles, error: profErr } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', userIds);
    if (profErr) throw profErr;

    const profileMap = new Map();
    (profiles || []).forEach(p => profileMap.set(p.id, p));

    return members.map(m => {
      const prof = profileMap.get(m.user_id);
      return {
        email: prof ? (prof.email || '') : '',
        full_name: prof ? (prof.full_name || '') : '',
        role: m.role
      };
    });
  }, ['email', 'full_name', 'role']);

  console.log('\nBackup complete! Files saved to backups/');
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
