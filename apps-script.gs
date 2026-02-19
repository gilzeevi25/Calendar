// Calendar Write API — Google Apps Script Web App
// Deploy: Extensions > Apps Script > Deploy > Web App
//   Execute as: Me | Who has access: Anyone

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Server busy, try again' });
  }

  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;

    if (action === 'updateCells') {
      return handleUpdateCells(payload);
    } else if (action === 'addPeople') {
      return handleAddPeople(payload);
    } else if (action === 'getData') {
      return handleGetData();
    } else if (action === 'getRosterConfig') {
      return handleGetRosterConfig();
    } else if (action === 'saveRosterConfig') {
      return handleSaveRosterConfig(payload);
    } else if (action === 'getRosterShifts') {
      return handleGetRosterShifts(payload);
    } else if (action === 'saveRosterShifts') {
      return handleSaveRosterShifts(payload);
    } else if (action === 'deleteRosterShifts') {
      return handleDeleteRosterShifts(payload);
    } else if (action === 'saveRosterAssignments') {
      return handleSaveRosterAssignments(payload);
    } else if (action === 'clearRosterAssignments') {
      return handleClearRosterAssignments(payload);
    } else {
      return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

// Normalize any date value (Date object, number, or string) to "YYYY-MM-DD"
function normalizeDate(val) {
  if (val instanceof Date) return formatDate(val);
  var s = String(val).trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try DD/MM/YYYY or D/M/YYYY (common in Hebrew locale sheets)
  var slashParts = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashParts) {
    return slashParts[3] + '-' + String(parseInt(slashParts[2])).padStart(2, '0') + '-' + String(parseInt(slashParts[1])).padStart(2, '0');
  }
  // Try parsing as generic date string
  var d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return formatDate(d);
  return s;
}

// Find column index by header name (trimmed, case-insensitive)
function findCol(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === name.toLowerCase()) return i;
  }
  return -1;
}

function handleUpdateCells(payload) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var nameCol = findCol(headers, 'name');
  var dateCol = findCol(headers, 'date');
  var statusCol = findCol(headers, 'status');
  var noteCol = findCol(headers, 'note');

  if (nameCol === -1 || dateCol === -1 || statusCol === -1) {
    return jsonResponse({ success: false, error: 'Missing required columns. Found headers: ' + headers.join(', ') });
  }

  // Build row lookup: "name|YYYY-MM-DD" -> 1-based sheet row
  var rowMap = {};
  for (var i = 1; i < data.length; i++) {
    var dateVal = normalizeDate(data[i][dateCol]);
    var key = String(data[i][nameCol]).trim() + '|' + dateVal;
    rowMap[key] = i + 1;
  }

  var edits = payload.edits || [];
  var notes = payload.notes || [];
  var editCount = 0;
  var noteCount = 0;
  var missingEdits = [];

  edits.forEach(function(edit) {
    var editDate = normalizeDate(edit.date);
    var key = String(edit.name).trim() + '|' + editDate;
    var row = rowMap[key];
    if (row) {
      sheet.getRange(row, statusCol + 1).setValue(edit.status);
      editCount++;
    } else {
      missingEdits.push(key);
    }
  });

  notes.forEach(function(n) {
    var noteDate = normalizeDate(n.date);
    var key = String(n.name).trim() + '|' + noteDate;
    var row = rowMap[key];
    if (row && noteCol !== -1) {
      sheet.getRange(row, noteCol + 1).setValue(n.note);
      noteCount++;
    }
  });

  if (edits.length > 0 && editCount === 0) {
    // Include debug info: show a few rowMap keys for comparison
    var sampleKeys = Object.keys(rowMap).slice(0, 5);
    return jsonResponse({
      success: false,
      error: 'No matching rows found for any edit. Keys: ' + missingEdits.slice(0, 3).join(', ') +
             ' | Sample sheet keys: ' + sampleKeys.join(', ')
    });
  }

  return jsonResponse({ success: true, updated: editCount, noted: noteCount, skipped: missingEdits.length, missingKeys: missingEdits });
}

function parseDateLocal(dateStr) {
  var parts = String(dateStr).split('-');
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

function formatDate(d) {
  var yy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return yy + '-' + mm + '-' + dd;
}

function handleGetData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var dateCol = findCol(headers, 'date');

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (j === dateCol) {
        val = normalizeDate(val);
      } else if (val instanceof Date) {
        val = formatDate(val);
      }
      row[String(headers[j]).trim()] = String(val).trim();
    }
    rows.push(row);
  }
  return jsonResponse({ success: true, rows: rows });
}

function handleAddPeople(payload) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var nameCol = findCol(headers, 'name');
  var dateCol = findCol(headers, 'date');
  var statusCol = findCol(headers, 'status');
  var noteCol = findCol(headers, 'note');
  var assocCol = findCol(headers, 'association');

  if (nameCol === -1 || dateCol === -1 || statusCol === -1) {
    return jsonResponse({ success: false, error: 'Missing required columns. Found headers: ' + headers.join(', ') });
  }

  var names = payload.names || [];
  var defaultStatus = payload.defaultStatus || 'activity';
  var startDate = parseDateLocal(payload.dateRange.start);
  var endDate = parseDateLocal(payload.dateRange.end);

  // Collect existing names using dynamic column index
  var existingNames = {};
  for (var i = 1; i < data.length; i++) {
    existingNames[String(data[i][nameCol]).trim()] = true;
  }

  var newRows = [];
  var skipped = [];
  var numCols = headers.length;

  names.forEach(function(name) {
    name = name.trim();
    if (existingNames[name]) {
      skipped.push(name);
      return;
    }
    var d = new Date(startDate.getTime());
    while (d <= endDate) {
      var row = new Array(numCols).fill('');
      row[nameCol] = name;
      row[dateCol] = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      row[statusCol] = defaultStatus;
      if (noteCol !== -1) row[noteCol] = '';
      if (assocCol !== -1) row[assocCol] = payload.association || '';
      newRows.push(row);
      d.setDate(d.getDate() + 1);
    }
  });

  if (newRows.length > 0) {
    sheet.getRange(data.length + 1, 1, newRows.length, numCols).setValues(newRows);
  }

  return jsonResponse({
    success: true,
    added: names.length - skipped.length,
    skipped: skipped,
    totalRows: newRows.length
  });
}

// ---- Roster helpers ----

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    }
  }
  return sheet;
}

function formatTime(d) {
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (val instanceof Date) {
        // Google Sheets stores time-only values as Date with year 1899/1900
        if (val.getFullYear() <= 1900) {
          val = formatTime(val);
        } else {
          val = formatDate(val);
        }
      }
      row[headers[j]] = String(val).trim();
    }
    rows.push(row);
  }
  return rows;
}

// ---- Roster Config (key-value store) ----

function handleGetRosterConfig() {
  var sheet = getOrCreateSheet('roster_config', ['key', 'value']);
  var rows = sheetToObjects(sheet);
  var config = {};
  rows.forEach(function(r) {
    config[r.key] = r.value;
  });
  return jsonResponse({ success: true, config: config });
}

function handleSaveRosterConfig(payload) {
  var sheet = getOrCreateSheet('roster_config', ['key', 'value']);
  var data = sheet.getDataRange().getValues();
  var key = payload.key;
  var value = payload.value;

  // Find existing row for this key
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return jsonResponse({ success: true, action: 'updated', key: key });
    }
  }
  // Insert new row
  sheet.appendRow([key, value]);
  return jsonResponse({ success: true, action: 'inserted', key: key });
}

// ---- Roster Shifts ----

function handleGetRosterShifts(payload) {
  var shiftSheet = getOrCreateSheet('roster_shifts', ['id', 'date', 'mission_type', 'start_time', 'end_time', 'note']);
  var assignSheet = getOrCreateSheet('roster_assignments', ['shift_id', 'name', 'role', 'is_manual', 'assigned_at']);

  var shifts = sheetToObjects(shiftSheet);
  var assignments = sheetToObjects(assignSheet);

  // Optional date range filter
  if (payload.startDate && payload.endDate) {
    shifts = shifts.filter(function(s) {
      return s.date >= payload.startDate && s.date <= payload.endDate;
    });
  }

  // Group assignments by shift_id
  var assignMap = {};
  assignments.forEach(function(a) {
    if (!assignMap[a.shift_id]) assignMap[a.shift_id] = [];
    assignMap[a.shift_id].push(a);
  });

  // Attach assignments to shifts
  shifts.forEach(function(s) {
    s.assignments = assignMap[s.id] || [];
  });

  return jsonResponse({ success: true, shifts: shifts });
}

function handleSaveRosterShifts(payload) {
  var headers = ['id', 'date', 'mission_type', 'start_time', 'end_time', 'note'];
  var sheet = getOrCreateSheet('roster_shifts', headers);
  var data = sheet.getDataRange().getValues();

  // Find column indices for time fields (0-based)
  var startTimeCol = headers.indexOf('start_time') + 1; // 1-based for Sheets
  var endTimeCol = headers.indexOf('end_time') + 1;

  // Build id -> row index map
  var idMap = {};
  for (var i = 1; i < data.length; i++) {
    idMap[String(data[i][0]).trim()] = i + 1;
  }

  var shifts = payload.shifts || [];
  var created = 0, updated = 0;

  shifts.forEach(function(s) {
    var rowData = [s.id, s.date, s.mission_type, s.start_time, s.end_time, s.note || ''];
    var existingRow = idMap[s.id];
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, headers.length).setValues([rowData]);
      // Force time columns to plain text so Sheets doesn't auto-convert to Date
      sheet.getRange(existingRow, startTimeCol).setNumberFormat('@').setValue(s.start_time);
      sheet.getRange(existingRow, endTimeCol).setNumberFormat('@').setValue(s.end_time);
      updated++;
    } else {
      var newRow = data.length + created + 1;
      sheet.appendRow(rowData);
      // Force time columns to plain text so Sheets doesn't auto-convert to Date
      sheet.getRange(newRow, startTimeCol).setNumberFormat('@').setValue(s.start_time);
      sheet.getRange(newRow, endTimeCol).setNumberFormat('@').setValue(s.end_time);
      created++;
    }
  });

  return jsonResponse({ success: true, created: created, updated: updated });
}

function handleDeleteRosterShifts(payload) {
  var sheet = getOrCreateSheet('roster_shifts', ['id', 'date', 'mission_type', 'start_time', 'end_time', 'note']);
  var assignSheet = getOrCreateSheet('roster_assignments', ['shift_id', 'name', 'role', 'is_manual', 'assigned_at']);
  var ids = payload.ids || [];
  var idSet = {};
  ids.forEach(function(id) { idSet[id] = true; });

  // Delete assignments for these shifts
  var aData = assignSheet.getDataRange().getValues();
  var aRowsToDelete = [];
  for (var i = 1; i < aData.length; i++) {
    if (idSet[String(aData[i][0]).trim()]) aRowsToDelete.push(i + 1);
  }
  // Delete from bottom to top to preserve row indices
  for (var j = aRowsToDelete.length - 1; j >= 0; j--) {
    assignSheet.deleteRow(aRowsToDelete[j]);
  }

  // Delete shifts
  var sData = sheet.getDataRange().getValues();
  var sRowsToDelete = [];
  for (var i = 1; i < sData.length; i++) {
    if (idSet[String(sData[i][0]).trim()]) sRowsToDelete.push(i + 1);
  }
  for (var j = sRowsToDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(sRowsToDelete[j]);
  }

  return jsonResponse({ success: true, deletedShifts: sRowsToDelete.length, deletedAssignments: aRowsToDelete.length });
}

// ---- Roster Assignments ----

function handleSaveRosterAssignments(payload) {
  var headers = ['shift_id', 'name', 'role', 'is_manual', 'assigned_at'];
  var sheet = getOrCreateSheet('roster_assignments', headers);
  var assignments = payload.assignments || [];
  var now = new Date().toISOString();

  assignments.forEach(function(a) {
    sheet.appendRow([a.shift_id, a.name, a.role || 'member', a.is_manual ? 'TRUE' : 'FALSE', a.assigned_at || now]);
  });

  return jsonResponse({ success: true, saved: assignments.length });
}

function handleClearRosterAssignments(payload) {
  var sheet = getOrCreateSheet('roster_assignments', ['shift_id', 'name', 'role', 'is_manual', 'assigned_at']);
  var shiftIds = payload.shiftIds || [];
  var idSet = {};
  shiftIds.forEach(function(id) { idSet[id] = true; });

  // Only clear non-manual assignments unless clearManual is true
  var clearManual = payload.clearManual || false;
  var data = sheet.getDataRange().getValues();
  var rowsToDelete = [];

  for (var i = 1; i < data.length; i++) {
    var sid = String(data[i][0]).trim();
    var isManual = String(data[i][3]).trim().toUpperCase() === 'TRUE';
    if (idSet[sid] && (clearManual || !isManual)) {
      rowsToDelete.push(i + 1);
    }
  }

  for (var j = rowsToDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(rowsToDelete[j]);
  }

  return jsonResponse({ success: true, cleared: rowsToDelete.length });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', message: 'Calendar API is running' })
  ).setMimeType(ContentService.MimeType.JSON);
}
