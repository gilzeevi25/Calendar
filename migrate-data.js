/**
 * migrate-data.js — One-time data migration from Google Apps Script to Supabase
 *
 * USAGE:
 *   1. Log in via auth.html and create your organization
 *   2. Open browser console on index.html (you should be logged in)
 *   3. Paste this script and call:  migrate()
 *
 * Uses your authenticated session — no secret keys needed.
 * You must be logged in and have an organization selected.
 */

async function migrate() {
  // Use the authenticated supabase client (window.supabase)
  const db = window.supabase;

  // Verify auth
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    console.error('Not logged in. Open auth.html first, then come back.');
    return;
  }
  const userId = session.user.id;
  console.log('Authenticated as:', session.user.email);

  const ORG_NAME = 'פלוגה ב';
  const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx7tIx9awHDsdXZ0y01QElrDNv4F9sy_7ENDFVlHPOns7H-KhRrHLGJG5zhpuVBZ_YV0A/exec';

  async function callAppsScript(payload) {
    const resp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    return resp.json();
  }

  console.log('=== Starting Migration ===');

  // Step 1: Create organization
  console.log('1. Creating organization...');
  const { data: org, error: orgErr } = await db
    .from('organizations')
    .insert({ name: ORG_NAME, created_by: userId })
    .select()
    .single();
  if (orgErr) { console.error('Org creation failed:', orgErr); return; }
  console.log('   Organization created:', org.id);
  const orgId = org.id;

  // Step 2: Add owner membership
  console.log('2. Adding owner membership...');
  const { error: memErr } = await db
    .from('organization_members')
    .insert({ org_id: orgId, user_id: userId, role: 'owner' });
  if (memErr) { console.error('Membership failed:', memErr); return; }
  console.log('   Owner added');

  // Step 3: Import people from Apps Script / data.csv
  console.log('3. Importing people + calendar entries...');
  let rows;
  try {
    const result = await callAppsScript({ action: 'getData' });
    rows = result.rows || [];
    console.log('   Fetched', rows.length, 'rows from Apps Script');
  } catch (e) {
    console.warn('   Apps Script failed, trying local data.csv...');
    try {
      const resp = await fetch('data.csv');
      const text = await resp.text();
      const lines = text.split('\n').filter(l => l.trim());
      const header = lines[0].split(',');
      rows = lines.slice(1).map(line => {
        const vals = line.split(',');
        const obj = {};
        header.forEach((h, i) => obj[h.trim()] = (vals[i] || '').trim());
        return obj;
      });
      console.log('   Parsed', rows.length, 'rows from data.csv');
    } catch (e2) {
      console.error('   No data source available:', e2);
      return;
    }
  }

  // Extract unique people
  const peopleMap = new Map();
  rows.forEach(r => {
    if (r.name && !peopleMap.has(r.name)) {
      peopleMap.set(r.name, r.association || '');
    }
  });

  const peopleRows = Array.from(peopleMap.entries()).map(([name, association]) => ({
    org_id: orgId,
    name,
    association: association || null
  }));

  const { data: insertedPeople, error: peopleErr } = await db
    .from('people')
    .insert(peopleRows)
    .select('id, name');
  if (peopleErr) { console.error('People import failed:', peopleErr); return; }
  console.log('   Imported', insertedPeople.length, 'people');

  // Build name → id map
  const nameToId = new Map();
  insertedPeople.forEach(p => nameToId.set(p.name, p.id));

  // Step 4: Import calendar entries
  console.log('4. Importing calendar entries...');
  const calEntries = rows
    .filter(r => r.name && r.date && nameToId.has(r.name))
    .map(r => ({
      org_id: orgId,
      person_id: nameToId.get(r.name),
      date: r.date,
      status: r.status || 'activity',
      note: r.note || null
    }));

  let calCount = 0;
  for (let i = 0; i < calEntries.length; i += 500) {
    const chunk = calEntries.slice(i, i + 500);
    const { error } = await db
      .from('calendar_entries')
      .upsert(chunk, { onConflict: 'org_id,person_id,date' });
    if (error) { console.error('Calendar batch failed at', i, ':', error); return; }
    calCount += chunk.length;
  }
  console.log('   Imported', calCount, 'calendar entries');

  // Step 5: Seed mission types
  console.log('5. Seeding mission types...');
  const missionTypes = [
    { org_id: orgId, slug: 'patrol', label: 'סיור', color: '#2563eb', requires_officer: false },
    { org_id: orgId, slug: 'guard', label: 'שמירה', color: '#16a34a', requires_officer: false },
    { org_id: orgId, slug: 'kitchen', label: 'מטבח', color: '#d97706', requires_officer: false },
    { org_id: orgId, slug: 'qrf', label: 'כוננות', color: '#dc2626', requires_officer: true }
  ];
  const { data: mtData, error: mtErr } = await db
    .from('mission_types')
    .insert(missionTypes)
    .select('id, slug');
  if (mtErr) { console.error('Mission types failed:', mtErr); return; }
  console.log('   Seeded', mtData.length, 'mission types');

  const slugToMtId = new Map();
  mtData.forEach(mt => slugToMtId.set(mt.slug, mt.id));

  // Step 6: Import roster config
  console.log('6. Importing roster config...');
  try {
    const configResult = await callAppsScript({ action: 'getRosterConfig' });
    const configObj = configResult.config || {};
    const configKeys = ['mission_types', 'personnel_tags', 'exclusions', 'buddy_rules', 'scheduling_params', 'shift_templates'];
    let configCount = 0;
    for (const key of configKeys) {
      if (configObj[key]) {
        let jsonbValue;
        try { jsonbValue = JSON.parse(configObj[key]); } catch { jsonbValue = configObj[key]; }
        const { error } = await db
          .from('roster_config')
          .upsert({ org_id: orgId, key, value: jsonbValue }, { onConflict: 'org_id,key' });
        if (error) console.warn('   Config key', key, 'failed:', error);
        else configCount++;
      }
    }
    console.log('   Imported', configCount, 'config keys');
  } catch (e) {
    console.warn('   Config import failed (non-critical):', e);
  }

  // Step 7: Import shifts + assignments
  console.log('7. Importing shifts + assignments...');
  try {
    const shiftsResult = await callAppsScript({
      action: 'getRosterShifts',
      startDate: '2026-04-26',
      endDate: '2026-06-18'
    });
    const oldShifts = shiftsResult.shifts || [];
    let shiftCount = 0;
    let assignCount = 0;

    for (const s of oldShifts) {
      const missionTypeId = slugToMtId.get(s.mission_type);
      if (!missionTypeId) {
        console.warn('   Unknown mission type:', s.mission_type, '— skipping shift');
        continue;
      }

      const startTime = s.start_time ? s.start_time + (s.start_time.length === 5 ? ':00' : '') : null;
      const endTime = s.end_time ? s.end_time + (s.end_time.length === 5 ? ':00' : '') : null;
      const actualEndTime = s.actual_end_time ? s.actual_end_time + (s.actual_end_time.length === 5 ? ':00' : '') : null;

      const { data: newShift, error: shiftErr } = await db
        .from('shifts')
        .insert({
          org_id: orgId,
          date: s.date,
          mission_type_id: missionTypeId,
          start_time: startTime,
          end_time: endTime,
          actual_end_time: actualEndTime,
          note: s.note || ''
        })
        .select('id')
        .single();

      if (shiftErr) {
        console.warn('   Shift insert failed:', shiftErr);
        continue;
      }
      shiftCount++;

      const assignments = (s.assignments || [])
        .filter(a => a.name && nameToId.has(a.name))
        .map(a => ({
          shift_id: newShift.id,
          person_id: nameToId.get(a.name),
          role: a.role || null,
          is_auto: String(a.is_manual || '').toUpperCase() === 'TRUE' ? false : true,
          assigned_at: a.assigned_at || new Date().toISOString()
        }));

      if (assignments.length > 0) {
        const { error: aErr } = await db
          .from('shift_assignments')
          .insert(assignments);
        if (aErr) console.warn('   Assignment insert failed for shift:', newShift.id, aErr);
        else assignCount += assignments.length;
      }
    }
    console.log('   Imported', shiftCount, 'shifts and', assignCount, 'assignments');
  } catch (e) {
    console.warn('   Shifts/assignments import failed (non-critical):', e);
  }

  console.log('=== Migration Complete ===');
  console.log('Verify in Supabase Dashboard:');
  console.log('  - People:', peopleRows.length);
  console.log('  - Calendar entries:', calCount);
  console.log('  - Mission types:', missionTypes.length);
  console.log('  - Org ID:', orgId);
  console.log('');
  console.log('Now reload the page to see your data!');
}
