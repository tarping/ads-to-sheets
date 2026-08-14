// ============================================================
//  SHARED HELPERS — required by meta.gs, google-ads.gs, tiktok.gs
//
//  All .gs files in an Apps Script project share one global
//  scope, so these functions are visible to the other files.
//  Paste this as its own script file named "shared".
// ============================================================


// ─────────────────────────────────────────────────────────────
//  CAMPAIGN NAME PARSING  ← EDIT THIS TO MATCH YOUR CONVENTION
// ─────────────────────────────────────────────────────────────
//  The pullers split each campaign name into columns so you can
//  pivot by artist, market, objective, etc.
//
//  Default convention (pipe-separated, 5 fields):
//
//    "Artist Name | Release | Segment | Objective | Budget"
//     e.g. "Nova Cascade | Summer EP | National | Conversion | 200"
//
//  If your campaigns are named differently, change the split
//  character and the field names here, then update:
//    - the *_HEADERS array in each platform file
//    - the row builder in each platform file
//  Nothing else depends on these field names.
// ─────────────────────────────────────────────────────────────
function parseCampaignName(name) {
  var p = String(name || "").split("|").map(function (s) { return s.trim(); });
  return {
    field1: p[0] || "",   // Artist
    field2: p[1] || "",   // Release
    field3: p[2] || "",   // Segment
    field4: p[3] || "",   // Objective
    field5: p[4] || ""    // Budget
  };
}


// ─────────────────────────────────────────────────────────────
//  SECRETS
// ─────────────────────────────────────────────────────────────
//  Tokens live in Project Settings > Script Properties, never in
//  the source. This keeps them out of git when you fork this repo.
function getSecret(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) {
    throw new Error("Missing Script Property: " + key +
      " — add it in Project Settings > Script Properties.");
  }
  return v;
}

function todayUTC() {
  return Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
}


// ─────────────────────────────────────────────────────────────
//  UPSERT ENGINE — shared by all three pullers
// ─────────────────────────────────────────────────────────────
//  Keeps one row per campaign, matched by Campaign ID:
//    - campaign already in the sheet  → row updated in place
//    - campaign is new                → row appended at the bottom
//    - spend AND status unchanged     → row left completely alone
//                                       (so "Date Pulled" doubles as
//                                        a last-changed marker)
//    - campaign missing from the pull → only its status cell is
//                                       refreshed; metrics are kept
//
//  Row order is never re-sorted and only the first `numCols`
//  columns are written, so any formulas you add to the right of
//  the pulled data stay aligned and untouched.
//
//  Arguments:
//    sheet       target sheet (headers in row 1)
//    numCols     how many columns this puller owns
//    idCol       0-based index of the Campaign ID column
//    spendCol    0-based index of the Spend column
//    statusCol   0-based index of the Status column
//    fresh       { campaignId: { row: [...], status: "..." } }
//    pausedLabel status to write when a campaign vanished entirely
//    statusOnly  { campaignId: "STATUS" } for campaigns we know the
//                status of but pulled no metrics for
//    rebuild     true = ignore existing rows (full pull)
function upsertRows(sheet, numCols, idCol, spendCol, statusCol, fresh, pausedLabel, statusOnly, rebuild) {
  var prevLast = sheet.getLastRow();
  var rows = (!rebuild && prevLast > 1)
    ? sheet.getRange(2, 1, prevLast - 1, numCols).getValues()
    : [];

  var index = {};
  rows.forEach(function (r, i) {
    var id = String(r[idCol]).trim();
    if (id) index[id] = i;
  });

  var updated = 0, added = 0, unchanged = 0, restamped = 0;
  var seen = {};

  Object.keys(fresh).forEach(function (id) {
    seen[id] = true;
    var entry = fresh[id];
    var i = index[id];

    if (i !== undefined) {
      var oldSpend = parseFloat(rows[i][spendCol]) || 0;
      var newSpend = parseFloat(entry.row[spendCol]) || 0;
      var oldStatus = String(rows[i][statusCol] || "");
      if (oldSpend === newSpend && oldStatus === String(entry.status)) { unchanged++; return; }
      rows[i] = entry.row;
      updated++;
    } else {
      rows.push(entry.row);
      index[id] = rows.length - 1;
      added++;
    }
  });

  rows.forEach(function (r) {
    var id = String(r[idCol]).trim();
    if (!id || seen[id]) return;
    var newStatus = (statusOnly && statusOnly[id]) ? statusOnly[id] : pausedLabel;
    if (String(r[statusCol]) !== newStatus) {
      r[statusCol] = newStatus;
      restamped++;
    }
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, numCols).setValues(rows);
  }
  // Only relevant after a rebuild that returned fewer campaigns than before.
  if (prevLast > rows.length + 1) {
    sheet.getRange(rows.length + 2, 1, prevLast - rows.length - 1, numCols).clearContent();
  }

  Logger.log("Upsert done — updated: " + updated + " | new: " + added +
             " | unchanged: " + unchanged + " | status refreshed: " + restamped +
             " | total rows: " + rows.length);
}


// ─────────────────────────────────────────────────────────────
//  SHEET SETUP
// ─────────────────────────────────────────────────────────────
function getOrCreateSheet(name, headers, headerColor) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setBackground(headerColor || "#1a1a2e");
    hr.setFontColor("#ffffff").setFontWeight("bold").setFontSize(10);
    sheet.setFrozenRows(1);
    Logger.log("Sheet created: " + name);
  }
  return sheet;
}


// ─────────────────────────────────────────────────────────────
//  MAINTENANCE
// ─────────────────────────────────────────────────────────────
function deleteAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log("Deleted " + triggers.length + " triggers.");
}
