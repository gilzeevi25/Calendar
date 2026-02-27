/**
 * restore-from-csv.js — Restore Supabase tables from backup CSVs.
 *
 * Usage:
 *   node .github/scripts/restore-from-csv.js --dry-run          # preview only (default)
 *   node .github/scripts/restore-from-csv.js --execute           # actually insert data
 *   node .github/scripts/restore-from-csv.js --dir ./backups     # custom backup directory
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 *
 * Insertion order respects foreign keys:
 *   1. organizations
 *   2. people
 *   3. mission_types
 *   4. calendar_config
 *   5. roster_config
 *   6. calendar_entries
 *   7. shifts
 *   8. shift_assignments
 *   (organization_members is skipped — requires auth.users UUIDs)
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const dryRun = !execute; // dry-run is the default
const dirFlag = args.indexOf('--dir');
const BACKUP_DIR = dirFlag !== -1 && args[dirFlag + 1]
  ? path.resolve(args[dirFlag + 1])
  : path.join(process.cwd(), 'backups');

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields, commas in values, escaped quotes
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
        if (current.length > 0 || lines.length > 0) {
          lines.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
  }
  if (current.length > 0) lines.push(current);

  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length === 0 || (values.length === 1 && values[0] === '')) continue;
    const obj = {};
    header.forEach((col, idx) => {
      obj[col] = idx < values.length ? values[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readCsv(filename) {
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  SKIP ${filename} (file not found)`);
    return null;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  console.log(`  Read ${filename}: ${rows.length} rows`);
  return rows;
}

const BATCH_SIZE = 500;

async function upsertBatch(table, rows, onConflict) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would upsert ${rows.length} rows into ${table}`);
    return;
  }
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict });
    if (error) {
      console.error(`  ERROR upserting into ${table} (batch ${i / BATCH_SIZE + 1}):`, error.message);
      process.exit(1);
    }
  }
  console.log(`  Upserted ${rows.length} rows into ${table}`);
}

// ---------------------------------------------------------------------------
// Restore steps — ordered by foreign key dependencies
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nRestore mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE (writing to database)'}`);
  console.log(`Backup dir:   ${BACKUP_DIR}\n`);

  if (!fs.existsSync(BACKUP_DIR)) {
    console.error(`Backup directory not found: ${BACKUP_DIR}`);
    process.exit(1);
  }

  // We need the org_id for all inserts. Look it up from organizations table,
  // or from the first existing org in Supabase.
  let orgId = null;

  // ------------------------------------------------------------------
  // 1. Organizations
  // ------------------------------------------------------------------
  console.log('1/8  Organizations');
  const orgRows = readCsv('organizations.csv');
  if (orgRows && orgRows.length > 0) {
    if (dryRun) {
      console.log(`  [DRY RUN] Would ensure org "${orgRows[0].name}" exists`);
      console.log('  [DRY RUN] Using placeholder org_id for remaining steps');
      orgId = '<org-id-placeholder>';
    } else {
      // Check if org already exists
      const { data: existing } = await supabase
        .from('organizations')
        .select('id, name')
        .eq('name', orgRows[0].name)
        .maybeSingle();
      if (existing) {
        orgId = existing.id;
        console.log(`  Org "${existing.name}" already exists (${orgId})`);
      } else {
        console.log('  WARNING: Cannot create org without a created_by user UUID.');
        console.log('  Please create the organization manually first, then re-run.');
        process.exit(1);
      }
    }
  } else {
    // No organizations.csv — try to find existing org
    if (!dryRun) {
      const { data: orgs } = await supabase.from('organizations').select('id, name').limit(1);
      if (orgs && orgs.length > 0) {
        orgId = orgs[0].id;
        console.log(`  Using existing org: "${orgs[0].name}" (${orgId})`);
      } else {
        console.error('  No organizations found and no organizations.csv — cannot proceed.');
        process.exit(1);
      }
    } else {
      orgId = '<org-id-placeholder>';
      console.log('  [DRY RUN] No organizations.csv, would use first existing org');
    }
  }

  // ------------------------------------------------------------------
  // 2. People
  // ------------------------------------------------------------------
  console.log('2/8  People');
  const peopleRows = readCsv('people.csv');
  const personLookup = new Map(); // name -> id (filled during execute)
  if (peopleRows) {
    const records = peopleRows.map(r => ({
      org_id: orgId,
      name: r.name,
      association: r.association || null
    }));
    await upsertBatch('people', records, 'org_id,name');

    if (!dryRun) {
      // Build lookup map: name -> UUID
      const { data: allPeople } = await supabase
        .from('people')
        .select('id, name')
        .eq('org_id', orgId);
      (allPeople || []).forEach(p => personLookup.set(p.name, p.id));
      console.log(`  Lookup map: ${personLookup.size} people`);
    }
  }

  // ------------------------------------------------------------------
  // 3. Mission types
  // ------------------------------------------------------------------
  console.log('3/8  Mission types');
  const mtRows = readCsv('mission_types.csv');
  const mtLookup = new Map(); // name -> id
  if (mtRows) {
    const records = mtRows.map(r => ({
      org_id: orgId,
      name: r.name,
      display_name: r.display_name,
      color: r.color || null,
      default_hours: r.default_hours !== '' ? Number(r.default_hours) : null,
      min_people: r.min_people !== '' ? Number(r.min_people) : 1,
      required_roles: r.required_roles ? JSON.parse(r.required_roles) : [],
      sort_order: r.sort_order !== '' ? Number(r.sort_order) : 0
    }));
    await upsertBatch('mission_types', records, 'org_id,name');

    if (!dryRun) {
      const { data: allMt } = await supabase
        .from('mission_types')
        .select('id, name')
        .eq('org_id', orgId);
      (allMt || []).forEach(mt => mtLookup.set(mt.name, mt.id));
      console.log(`  Lookup map: ${mtLookup.size} mission types`);
    }
  }

  // ------------------------------------------------------------------
  // 4. Calendar config
  // ------------------------------------------------------------------
  console.log('4/8  Calendar config');
  const ccRows = readCsv('calendar_config.csv');
  if (ccRows) {
    const records = ccRows.map(r => {
      let value = r.value;
      try { value = JSON.parse(r.value); } catch (_) { /* keep as string */ }
      return { org_id: orgId, key: r.key, value };
    });
    await upsertBatch('calendar_config', records, 'org_id,key');
  }

  // ------------------------------------------------------------------
  // 5. Roster config
  // ------------------------------------------------------------------
  console.log('5/8  Roster config');
  const rcRows = readCsv('roster_config.csv');
  if (rcRows) {
    const records = rcRows.map(r => {
      let value = r.value;
      try { value = JSON.parse(r.value); } catch (_) { /* keep as string */ }
      return { org_id: orgId, key: r.key, value };
    });
    await upsertBatch('roster_config', records, 'org_id,key');
  }

  // ------------------------------------------------------------------
  // 6. Calendar entries (depends on people)
  // ------------------------------------------------------------------
  console.log('6/8  Calendar entries');
  const ceRows = readCsv('calendar_entries.csv');
  if (ceRows) {
    if (dryRun) {
      console.log(`  [DRY RUN] Would resolve person names -> UUIDs and upsert ${ceRows.length} entries`);
    } else {
      const records = [];
      let skipped = 0;
      for (const r of ceRows) {
        const personId = personLookup.get(r.name);
        if (!personId) { skipped++; continue; }
        records.push({
          org_id: orgId,
          person_id: personId,
          date: r.date,
          status: r.status,
          note: r.note || null
        });
      }
      if (skipped > 0) console.log(`  Skipped ${skipped} entries (person not found)`);
      await upsertBatch('calendar_entries', records, 'org_id,person_id,date');
    }
  }

  // ------------------------------------------------------------------
  // 7. Shifts (depends on mission_types)
  // ------------------------------------------------------------------
  console.log('7/8  Shifts');
  const shiftRows = readCsv('shifts.csv');
  const shiftLookup = new Map(); // "date|mission_type" -> id
  if (shiftRows) {
    if (dryRun) {
      console.log(`  [DRY RUN] Would resolve mission_type names -> UUIDs and upsert ${shiftRows.length} shifts`);
    } else {
      const records = [];
      let skipped = 0;
      for (const r of shiftRows) {
        const mtId = mtLookup.get(r.mission_type);
        if (!mtId) { skipped++; continue; }
        records.push({
          org_id: orgId,
          mission_type_id: mtId,
          date: r.date,
          start_time: r.start_time,
          end_time: r.end_time,
          note: r.note || null
        });
      }
      if (skipped > 0) console.log(`  Skipped ${skipped} shifts (mission type not found)`);

      // Insert shifts and capture IDs for assignment lookup
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const { data, error } = await supabase
          .from('shifts')
          .upsert(batch)
          .select('id, date, mission_type_id');
        if (error) {
          console.error('  ERROR upserting shifts:', error.message);
          process.exit(1);
        }
        (data || []).forEach(s => {
          const mtName = [...mtLookup.entries()].find(([, v]) => v === s.mission_type_id)?.[0] || '';
          shiftLookup.set(`${s.date}|${mtName}`, s.id);
        });
      }
      console.log(`  Upserted ${records.length} shifts`);
      console.log(`  Lookup map: ${shiftLookup.size} shifts`);
    }
  }

  // ------------------------------------------------------------------
  // 8. Shift assignments (depends on shifts + people)
  // ------------------------------------------------------------------
  console.log('8/8  Shift assignments');
  const saRows = readCsv('shift_assignments.csv');
  if (saRows) {
    if (dryRun) {
      console.log(`  [DRY RUN] Would resolve shift + person lookups and upsert ${saRows.length} assignments`);
    } else {
      const records = [];
      let skipped = 0;
      for (const r of saRows) {
        const shiftId = shiftLookup.get(`${r.shift_date}|${r.mission_type}`);
        const personId = personLookup.get(r.person_name);
        if (!shiftId || !personId) { skipped++; continue; }
        records.push({
          shift_id: shiftId,
          person_id: personId,
          role: r.role || null,
          is_auto: r.is_manual === 'FALSE'
        });
      }
      if (skipped > 0) console.log(`  Skipped ${skipped} assignments (shift or person not found)`);
      await upsertBatch('shift_assignments', records, 'shift_id,person_id');
    }
  }

  // ------------------------------------------------------------------
  // Done
  // ------------------------------------------------------------------
  console.log('\n--- profiles & organization_members skipped (requires auth.users UUIDs) ---');

  if (dryRun) {
    console.log('\nDry run complete. No data was written.');
    console.log('Re-run with --execute to actually restore data.');
  } else {
    console.log('\nRestore complete!');
  }
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
