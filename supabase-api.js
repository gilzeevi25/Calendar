/**
 * supabase-api.js — Data access layer replacing all callAppsScript() calls
 * Depends on: supabase-config.js, supabase-auth.js (provides supabase, getCurrentOrgId)
 */

// ===================== INTERNAL CACHES =====================

const _peopleCache = { byName: new Map(), byId: new Map(), loaded: false };
const _missionTypeCache = { bySlug: new Map(), byId: new Map(), loaded: false };

async function _ensurePeopleCache() {
  if (_peopleCache.loaded) return;
  const orgId = getCurrentOrgId();
  const { data, error } = await supabase
    .from('people')
    .select('id, name, association')
    .eq('org_id', orgId);
  if (error) throw error;
  _peopleCache.byName.clear();
  _peopleCache.byId.clear();
  (data || []).forEach(p => {
    _peopleCache.byName.set(p.name, p);
    _peopleCache.byId.set(p.id, p);
  });
  _peopleCache.loaded = true;
}

function _invalidatePeopleCache() {
  _peopleCache.loaded = false;
  _peopleCache.byName.clear();
  _peopleCache.byId.clear();
}

async function _ensureMissionTypeCache() {
  if (_missionTypeCache.loaded) return;
  const orgId = getCurrentOrgId();
  const { data, error } = await supabase
    .from('mission_types')
    .select('id, name, display_name, color')
    .eq('org_id', orgId);
  if (error) throw error;
  _missionTypeCache.bySlug.clear();
  _missionTypeCache.byId.clear();
  (data || []).forEach(mt => {
    _missionTypeCache.bySlug.set(mt.name, mt);
    _missionTypeCache.byId.set(mt.id, mt);
  });
  _missionTypeCache.loaded = true;
}

function _personIdByName(name) {
  const p = _peopleCache.byName.get(name);
  return p ? p.id : null;
}

function _personNameById(id) {
  const p = _peopleCache.byId.get(id);
  return p ? p.name : null;
}

function _missionTypeIdBySlug(slug) {
  const mt = _missionTypeCache.bySlug.get(slug);
  return mt ? mt.id : null;
}

function _missionTypeSlugById(id) {
  const mt = _missionTypeCache.byId.get(id);
  return mt ? mt.name : null;
}

// ===================== CALENDAR FUNCTIONS =====================

/**
 * Replaces callAppsScript({action:'getData'})
 * Returns array of { name, date, status, note, association }
 */
async function fetchCalendarData() {
  const orgId = getCurrentOrgId();
  await _ensurePeopleCache();

  const { data, error } = await supabase
    .from('calendar_entries')
    .select('date, status, note, person_id')
    .eq('org_id', orgId);

  if (error) throw error;

  const rows = (data || []).map(entry => {
    const person = _peopleCache.byId.get(entry.person_id);
    return {
      name: person ? person.name : '(unknown)',
      date: entry.date,
      status: entry.status,
      note: entry.note || '',
      association: person ? (person.association || '') : ''
    };
  });

  return rows;
}

/**
 * Replaces callAppsScript({action:'updateCells', edits, notes})
 * edits: [{ name, date, status }]
 * notes: [{ name, date, note }]
 * Returns { success, updated, skipped, missingKeys }
 */
async function updateCalendarCells(edits, notes) {
  const orgId = getCurrentOrgId();
  await _ensurePeopleCache();

  let updated = 0;
  let skipped = 0;
  const missingKeys = [];

  // Process status edits
  for (const edit of edits) {
    const personId = _personIdByName(edit.name);
    if (!personId) {
      skipped++;
      missingKeys.push(edit.name + '|' + edit.date);
      continue;
    }

    const { error } = await supabase
      .from('calendar_entries')
      .upsert({
        org_id: orgId,
        person_id: personId,
        date: edit.date,
        status: edit.status
      }, { onConflict: 'org_id,person_id,date' });

    if (error) {
      skipped++;
      missingKeys.push(edit.name + '|' + edit.date);
    } else {
      updated++;
    }
  }

  // Process note updates
  for (const n of notes) {
    const personId = _personIdByName(n.name);
    if (!personId) {
      skipped++;
      missingKeys.push(n.name + '|' + n.date);
      continue;
    }

    const { error } = await supabase
      .from('calendar_entries')
      .upsert({
        org_id: orgId,
        person_id: personId,
        date: n.date,
        note: n.note || null
      }, { onConflict: 'org_id,person_id,date' });

    if (error) {
      skipped++;
      missingKeys.push(n.name + '|' + n.date);
    } else {
      updated++;
    }
  }

  return { success: true, updated, skipped, missingKeys };
}

/**
 * Replaces callAppsScript({action:'addPeople', names, dateRange, defaultStatus, association})
 */
async function addPeople(names, dateRange, defaultStatus, association) {
  const orgId = getCurrentOrgId();

  // Upsert people
  const peopleRows = names.map(name => ({
    org_id: orgId,
    name,
    association: association || null
  }));

  const { data: insertedPeople, error: peopleErr } = await supabase
    .from('people')
    .upsert(peopleRows, { onConflict: 'org_id,name' })
    .select('id, name');

  if (peopleErr) throw peopleErr;

  _invalidatePeopleCache();
  await _ensurePeopleCache();

  // Generate calendar entries for each person in the date range
  const entries = [];
  for (const person of insertedPeople) {
    const start = new Date(dateRange.start);
    const end = new Date(dateRange.end);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      entries.push({
        org_id: orgId,
        person_id: person.id,
        date: `${y}-${m}-${dd}`,
        status: defaultStatus || 'activity'
      });
    }
  }

  // Batch upsert entries in chunks of 500
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    const { error } = await supabase
      .from('calendar_entries')
      .upsert(chunk, { onConflict: 'org_id,person_id,date' });
    if (error) throw error;
  }

  return { success: true, added: names.length };
}

/**
 * Delete people and their calendar entries (cascade via FK).
 * names: array of name strings to remove
 */
async function removePeople(names) {
  const orgId = getCurrentOrgId();
  await _ensurePeopleCache();

  const ids = names
    .map(n => _personIdByName(n))
    .filter(id => id != null);

  if (ids.length === 0) return { success: true, removed: 0 };

  const { error } = await supabase
    .from('people')
    .delete()
    .in('id', ids)
    .eq('org_id', orgId);

  if (error) throw error;

  _invalidatePeopleCache();
  return { success: true, removed: ids.length };
}

// ===================== ROSTER CONFIG FUNCTIONS =====================

/**
 * Replaces callAppsScript({action:'getRosterConfig'})
 * Returns { success, config } where config values are JSON strings
 */
async function fetchRosterConfig() {
  const orgId = getCurrentOrgId();

  const { data, error } = await supabase
    .from('roster_config')
    .select('key, value')
    .eq('org_id', orgId);

  if (error) throw error;

  const config = {};
  (data || []).forEach(row => {
    // Convert JSONB value back to JSON string for frontend compatibility
    config[row.key] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  });

  return { success: true, config };
}

/**
 * Replaces callAppsScript({action:'saveRosterConfig', key, value})
 * value is a JSON string from the frontend
 */
async function saveRosterConfigKey(key, value) {
  const orgId = getCurrentOrgId();

  // Parse JSON string to JSONB for storage
  let jsonbValue;
  try {
    jsonbValue = JSON.parse(value);
  } catch (e) {
    jsonbValue = value;
  }

  const { error } = await supabase
    .from('roster_config')
    .upsert({
      org_id: orgId,
      key,
      value: jsonbValue
    }, { onConflict: 'org_id,key' });

  if (error) throw error;
  return { success: true };
}

// ===================== ROSTER SHIFT FUNCTIONS =====================

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces callAppsScript({action:'getRosterShifts', startDate, endDate})
 * Returns { success, shifts } with assignments nested, names resolved, is_manual as 'TRUE'/'FALSE'
 */
async function fetchRosterShifts(startDate, endDate) {
  const orgId = getCurrentOrgId();
  await Promise.all([_ensurePeopleCache(), _ensureMissionTypeCache()]);

  const { data: shiftsData, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, date, mission_type_id, start_time, end_time, note')
    .eq('org_id', orgId)
    .gte('date', startDate)
    .lte('date', endDate);

  if (shiftErr) throw shiftErr;

  if (!shiftsData || shiftsData.length === 0) {
    return { success: true, shifts: [] };
  }

  const shiftIds = shiftsData.map(s => s.id);

  // Fetch assignments for these shifts
  const { data: assignData, error: assignErr } = await supabase
    .from('shift_assignments')
    .select('id, shift_id, person_id, role, is_auto, created_at')
    .in('shift_id', shiftIds);

  if (assignErr) throw assignErr;

  // Group assignments by shift_id
  const assignmentsByShift = {};
  (assignData || []).forEach(a => {
    if (!assignmentsByShift[a.shift_id]) assignmentsByShift[a.shift_id] = [];
    assignmentsByShift[a.shift_id].push({
      id: a.id,
      shift_id: a.shift_id,
      name: _personNameById(a.person_id) || '(unknown)',
      role: a.role || '',
      is_manual: a.is_auto ? 'FALSE' : 'TRUE',
      assigned_at: a.created_at || ''
    });
  });

  const shifts = shiftsData.map(s => ({
    id: s.id,
    date: s.date,
    mission_type: _missionTypeSlugById(s.mission_type_id) || '',
    start_time: (s.start_time || '').slice(0, 5),
    end_time: (s.end_time || '').slice(0, 5),
    note: s.note || '',
    assignments: assignmentsByShift[s.id] || []
  }));

  return { success: true, shifts };
}

/**
 * Replaces callAppsScript({action:'saveRosterShifts', shifts})
 * For NEW shifts (non-UUID id), inserts and MUTATES s.id to the new UUID.
 * For existing shifts (UUID id), updates.
 */
async function saveRosterShifts(shifts) {
  const orgId = getCurrentOrgId();
  await _ensureMissionTypeCache();

  for (const s of shifts) {
    const missionTypeId = _missionTypeIdBySlug(s.mission_type);
    const startTime = s.start_time ? s.start_time + (s.start_time.length === 5 ? ':00' : '') : null;
    const endTime = s.end_time ? s.end_time + (s.end_time.length === 5 ? ':00' : '') : null;

    if (_UUID_RE.test(s.id)) {
      // Update existing shift
      const { error } = await supabase
        .from('shifts')
        .update({
          date: s.date,
          mission_type_id: missionTypeId,
          start_time: startTime,
          end_time: endTime,
          note: s.note || ''
        })
        .eq('id', s.id);
      if (error) throw error;
    } else {
      // Insert new shift
      const { data, error } = await supabase
        .from('shifts')
        .insert({
          org_id: orgId,
          date: s.date,
          mission_type_id: missionTypeId,
          start_time: startTime,
          end_time: endTime,
          note: s.note || ''
        })
        .select('id')
        .single();
      if (error) throw error;
      // Mutate in place so callers get the UUID
      s.id = data.id;
    }
  }

  return { success: true };
}

/**
 * Replaces callAppsScript({action:'deleteRosterShifts', ids})
 * FK cascade deletes assignments automatically.
 */
async function deleteRosterShifts(ids) {
  const { error } = await supabase
    .from('shifts')
    .delete()
    .in('id', ids);
  if (error) throw error;
  return { success: true };
}

/**
 * Replaces callAppsScript({action:'saveRosterAssignments', assignments})
 * assignments: [{ shift_id, name, role, is_manual }]
 * Resolves name → person_id, inverts is_manual → is_auto
 */
async function saveRosterAssignments(assignments) {
  const orgId = getCurrentOrgId();
  await _ensurePeopleCache();

  const rows = assignments.map(a => {
    const personId = _personIdByName(a.name);
    if (!personId) throw new Error('Person not found: ' + a.name);
    return {
      shift_id: a.shift_id,
      person_id: personId,
      role: a.role || null,
      is_auto: a.is_manual === 'TRUE' ? false : true
    };
  });

  // Batch insert in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase
      .from('shift_assignments')
      .insert(chunk);
    if (error) throw error;
  }

  return { success: true };
}

/**
 * Replaces callAppsScript({action:'clearRosterAssignments', shiftIds, clearManual})
 * If clearManual is false, only deletes is_auto=true rows.
 * If clearManual is true, deletes all assignments for the given shifts.
 */
async function clearRosterAssignments(shiftIds, clearManual) {
  let query = supabase
    .from('shift_assignments')
    .delete()
    .in('shift_id', shiftIds);

  if (!clearManual) {
    query = query.eq('is_auto', true);
  }

  const { error } = await query;
  if (error) throw error;
  return { success: true };
}
