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

function handleUpdateCells(payload) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var nameCol = headers.indexOf('name');
  var dateCol = headers.indexOf('date');
  var statusCol = headers.indexOf('status');
  var noteCol = headers.indexOf('note');

  // Build row lookup: "name|date" -> 1-based sheet row
  var rowMap = {};
  for (var i = 1; i < data.length; i++) {
    var dateVal = data[i][dateCol];
    // Handle Date objects from Sheets
    if (dateVal instanceof Date) {
      dateVal = formatDate(dateVal);
    }
    var key = String(data[i][nameCol]).trim() + '|' + String(dateVal).trim();
    rowMap[key] = i + 1;
  }

  var edits = payload.edits || [];
  var notes = payload.notes || [];
  var editCount = 0;
  var noteCount = 0;
  var missingEdits = [];

  edits.forEach(function(edit) {
    var key = edit.name + '|' + edit.date;
    var row = rowMap[key];
    if (row) {
      sheet.getRange(row, statusCol + 1).setValue(edit.status);
      editCount++;
    } else {
      missingEdits.push(key);
    }
  });

  notes.forEach(function(n) {
    var key = n.name + '|' + n.date;
    var row = rowMap[key];
    if (row && noteCol !== -1) {
      sheet.getRange(row, noteCol + 1).setValue(n.note);
      noteCount++;
    }
  });

  if (edits.length > 0 && editCount === 0) {
    return jsonResponse({ success: false, error: 'No matching rows found for any edit. Keys: ' + missingEdits.slice(0, 3).join(', ') });
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
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (val instanceof Date) {
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
      newRows.push([name, formatDate(d), defaultStatus, '']);
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
