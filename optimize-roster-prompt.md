# Optimize roster.html Performance

## Context
`roster.html` is a ~3,100-line single-page application that manages shift scheduling. It renders day/week views, runs an auto-scheduling algorithm, and communicates with a Google Apps Script backend. The app feels sluggish — rendering views and running auto-schedule are the main pain points.

All changes are in one file: `roster.html`. Do NOT change `apps-script.gs` or any backend logic.

---

## Optimization 1: Replace linear lookups with Maps (HIGHEST IMPACT)

### 1a. `getMissionType()` — called 17+ times per render cycle

**File:** `roster.html`, lines 1004–1006

```js
function getMissionType(id) {
  return missionTypes.find(m => m.id === id); // O(n) every call
}
```

**Fix:** Build a `Map` once when `missionTypes` is loaded/changed. Replace the function body with a Map lookup:

```js
let missionTypeMap = new Map();
// Call this whenever missionTypes array is set/updated:
function buildMissionTypeMap() {
  missionTypeMap = new Map(missionTypes.map(m => [m.id, m]));
}
function getMissionType(id) {
  return missionTypeMap.get(id);
}
```

Make sure `buildMissionTypeMap()` is called every place `missionTypes` is assigned (search for `missionTypes =` to find all sites).

### 1b. Shift lookup in `autoSchedule()` — O(n) per assignment

**File:** `roster.html`, line 1272

```js
allAssignments.forEach(a => {
  const shift = shifts.find(s => s.id === a.shift_id); // O(n) inside loop
```

**Fix:** Build a shift map at the top of `autoSchedule()`:

```js
const shiftMap = new Map(shifts.map(s => [s.id, s]));
// then:
const shift = shiftMap.get(a.shift_id);
```

### 1c. Convert array `.includes()` checks to Sets in candidate filtering

**File:** `roster.html`, lines 1368–1416

`manualAssigned.includes(name)` is O(n). Convert `manualAssigned` to a Set before the filter:

```js
const manualSet = new Set(manualAssigned);
// then inside filter:
if (manualSet.has(name)) return false;
```

Do the same for exclusion lists — convert `exclusions[name]` arrays to Sets if they are checked repeatedly.

---

## Optimization 2: Pre-index shifts by date (HIGHEST IMPACT for rendering)

Both `renderDayView()` (line 1726) and `renderWeekView()` (lines 1836, 1869, 1881) repeatedly filter the entire `shifts` array:

```js
// renderDayView:
const dayShifts = shifts.filter(s => s.date === dateStr);   // full scan

// renderWeekView:
const weekShifts = shifts.filter(s => s.date >= startStr && s.date <= endStr); // full scan
weekDates.forEach(date => {
  const dayShifts = weekShifts.filter(s => s.date === dateStr);       // scan again
  activeMts.forEach(mt => {
    const mtShifts = dayShifts.filter(s => s.mission_type === mt.id); // scan yet again
  });
});
```

**Fix:** After `loadShifts()` returns, build a `Map<date, shifts[]>` index. In `renderWeekView`, also build a nested index `Map<date, Map<missionType, shifts[]>>`:

```js
// After shifts are loaded, build index:
const shiftsByDate = new Map();
shifts.forEach(s => {
  if (!shiftsByDate.has(s.date)) shiftsByDate.set(s.date, []);
  shiftsByDate.get(s.date).push(s);
});

// In renderWeekView, build nested index for the week:
const weekIndex = new Map(); // date -> missionType -> shifts[]
weekDates.forEach(date => {
  const dateStr = formatDateStr(date);
  const dayShifts = shiftsByDate.get(dateStr) || [];
  const byMt = new Map();
  dayShifts.forEach(s => {
    if (!byMt.has(s.mission_type)) byMt.set(s.mission_type, []);
    byMt.get(s.mission_type).push(s);
  });
  weekIndex.set(dateStr, { dayShifts, byMt });
});
```

Then replace all the nested `.filter()` chains with direct Map lookups.

---

## Optimization 3: Replace DOM-based `escapeHtml()` with string replacement

**File:** `roster.html`, lines 981–985

```js
function escapeHtml(str) {
  const div = document.createElement('div');  // allocates DOM node
  div.textContent = str;
  return div.innerHTML;
}
```

This creates and discards a DOM element on every call. It's called on every person name, mission type name, and note — easily 100+ times per render.

**Fix:** Use a pure string replacement:

```js
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}
```

---

## Optimization 4: Use array-join pattern instead of string concatenation

**File:** `roster.html`, lines 1747–1808 (day view), lines 1859–1914 (week view)

Both renderers build HTML via repeated `html += ...` in loops, which creates many intermediate string objects.

**Fix:** Push to an array and join once:

```js
// Before:
let html = '<div>';
items.forEach(item => { html += `<div>${item}</div>`; });
html += '</div>';

// After:
const parts = ['<div>'];
items.forEach(item => { parts.push(`<div>${item}</div>`); });
parts.push('</div>');
const html = parts.join('');
```

Apply this pattern to `renderDayView()`, `renderWeekView()`, `renderAlerts()`, and `renderConfigBody()`.

---

## Optimization 5: Use event delegation instead of per-element listeners

**File:** `roster.html`, lines 1812–1824 and 1918–1928

After rendering, the code queries all action buttons and attaches individual click handlers:

```js
container.querySelectorAll('.shift-card__action-btn').forEach(btn => {
  btn.addEventListener('click', (e) => { ... });
});
```

**Fix:** Attach a single delegated listener on the container:

```js
container.addEventListener('click', (e) => {
  const btn = e.target.closest('.shift-card__action-btn');
  if (btn) {
    const action = btn.dataset.action;
    const shiftId = btn.dataset.shiftId;
    if (action === 'delete') {
      if (confirm('למחוק את המשמרת?')) deleteShift(shiftId);
    } else if (action === 'note') {
      promptShiftNote(shiftId);
    } else if (action === 'manual') {
      promptManualAssign(shiftId);
    }
  }

  const row = e.target.closest('.week-summary__day-row');
  if (row) {
    currentDate = parseDateStr(row.dataset.date);
    currentView = 'day';
    document.getElementById('btnDayView').classList.add('view-toggle__btn--active');
    document.getElementById('btnWeekView').classList.remove('view-toggle__btn--active');
    updateDateDisplay();
    refreshView();
  }
});
```

Attach this once during `init()` on `#mainContent` rather than re-attaching after every render.

---

## Optimization 6: Eliminate redundant `getMissionType()` calls in week view

**File:** `roster.html`, lines 1888–1891

Inside the nested week view loop, `getMissionType()` is called again for each shift even though we already have the mission type object (`mt`) from the outer loop:

```js
activeMts.forEach(mt => {
  const mtShifts = dayShifts.filter(s => s.mission_type === mt.id);
  const totalRequired = mtShifts.reduce((sum, s) => {
    const m = getMissionType(s.mission_type); // REDUNDANT — mt.id === s.mission_type
    return sum + (m ? m.min_team : 1);
  }, 0);
});
```

**Fix:** Just use `mt.min_team` directly:

```js
const totalRequired = mtShifts.length * mt.min_team;
```

Since all shifts in `mtShifts` share the same mission type (we just filtered for it), the min_team is the same for all of them.

---

## Optimization 7: Optimize `autoSchedule()` inner loops

**File:** `roster.html`, lines 1258–1563

### 7a. Pre-group target shifts by date (already partially done at line 1290, but improve)

The consecutive-days tracking loop at lines 1327–1338 iterates ALL personnel for EVERY date:

```js
calendarData.names.forEach(name => {
  if (!history[name]) return;
  // ... consecutive day tracking
});
```

**Fix:** Only iterate personnel who have assignments. Maintain a `Set` of active personnel and only loop those.

### 7b. Pre-compute time ranges to avoid repeated `timeToMinutes()` calls

In the conflict check (lines 1377–1393), `timeToMinutes()` is called 4 times per candidate per existing assignment. Cache shift start/end as minutes on the shift object itself when shifts are loaded:

```js
// After loading shifts, pre-compute:
shifts.forEach(s => {
  s._startMin = timeToMinutes(s.start_time);
  s._endMin = timeToMinutes(s.end_time);
  if (s._endMin <= s._startMin) s._endMin += 1440;
});
```

Then use `shift._startMin` / `shift._endMin` in all time calculations. Similarly cache these on `newAssignments` entries.

### 7c. Index `newAssignments` by date for faster conflict checks

The conflict check at line 1377 iterates ALL of a person's assignments, but only cares about those on the same date:

```js
const myAssignments = newAssignments[name] || [];
const hasConflict = myAssignments.some(a => {
  if (a.date !== date) return false; // skips most entries
```

**Fix:** Structure `newAssignments` as `name -> date -> assignments[]` so the date filter is a Map lookup instead of iterating and skipping.

---

## Summary of changes (priority order)

| # | What | Where (lines) | Impact |
|---|------|----------------|--------|
| 1 | Mission type Map | 1004–1006, all callers | High — eliminates ~17+ linear scans per render |
| 2 | Pre-index shifts by date | 1726, 1836, 1869, 1881 | High — eliminates nested filter chains |
| 3 | String-based escapeHtml | 981–985 | High — eliminates 100+ DOM allocations per render |
| 4 | Array-join HTML building | 1747–1808, 1859–1914 | Medium — reduces GC pressure |
| 5 | Event delegation | 1812–1824, 1918–1928 | Medium — single listener vs N listeners |
| 6 | Remove redundant getMissionType in week view | 1888–1891 | Medium — use `mt.min_team` directly |
| 7 | autoSchedule Map/Set/cache optimizations | 1258–1563 | High — scheduling with large rosters |

## Constraints
- All changes are in `roster.html` only (the inline `<script>` section)
- Do not change HTML structure or CSS
- Do not change the Apps Script backend
- Preserve all existing functionality — scheduling logic, manual assignments, alerts, config modal, etc.
- Test that day view, week view, auto-schedule, manual assignment, and alerts all still work correctly after changes
