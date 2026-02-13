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

  return jsonResponse({ success: true, updated: editCount, noted: noteCount, skipped: missingEdits.length });
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

  var names = payload.names || [];
  var defaultStatus = payload.defaultStatus || 'activity';
  var startDate = parseDateLocal(payload.dateRange.start);
  var endDate = parseDateLocal(payload.dateRange.end);

  // Collect existing names
  var existingNames = {};
  for (var i = 1; i < data.length; i++) {
    existingNames[String(data[i][0]).trim()] = true;
  }

  var newRows = [];
  var skipped = [];

  names.forEach(function(name) {
    name = name.trim();
    if (existingNames[name]) {
      skipped.push(name);
      return;
    }
    var d = new Date(startDate.getTime());
    while (d <= endDate) {
      // Write Date objects (not strings) so Sheets stores them consistently
      newRows.push([name, new Date(d.getFullYear(), d.getMonth(), d.getDate()), defaultStatus, '']);
      d.setDate(d.getDate() + 1);
    }
  });

  if (newRows.length > 0) {
    sheet.getRange(data.length + 1, 1, newRows.length, 4).setValues(newRows);
  }

  return jsonResponse({
    success: true,
    added: names.length - skipped.length,
    skipped: skipped,
    totalRows: newRows.length
  });
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
