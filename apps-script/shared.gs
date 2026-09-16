// ============================================================
//  SHARED HELPERS — required by meta.gs, google-ads.gs, tiktok.gs, spotify.gs
//
//  All .gs files in an Apps Script project share one global
//  scope, so these functions are visible to the other files.
//  Paste this as its own script file named "shared".
// ============================================================


// ─────────────────────────────────────────────────────────────
//  CAMPAIGN NAMING  ← THE ONE PLACE TO EDIT FOR YOUR CONVENTION
// ─────────────────────────────────────────────────────────────
//  Every puller splits each campaign name on NAME_SEPARATOR and
//  writes one column per entry in NAME_FIELDS, in this order,
//  right after "Date Pulled". Headers, rows and column positions
//  in all four pullers are built from these two values, so
//  changing them here is the whole change.
//
//  Default convention (underscore-separated, 7 fields):
//
//    "Project Number_Artist_Release_Objective_Segment_PM_Mes"
//     e.g. "PRJ-1042_Nova Cascade_Summer EP_In feed Display_Streaming_Ana_Junho 2026"
//     (PM = the person managing the campaign, Mes = month)
//
//  Yours is probably different. Examples:
//    "Brand | Market | Objective"  → NAME_SEPARATOR = "|";
//                                    NAME_FIELDS = ["Brand", "Market", "Objective"];
//    no convention at all          → NAME_FIELDS = [];  (the raw name is always kept)
//
//  A name that does not follow the convention costs nothing: the
//  segments it lacks come back blank, and the raw name has its own
//  column, so the campaign still lands with its metrics intact.
//
//  Changing either value changes the column layout. The next run
//  notices, rewrites the headers and rebuilds the tab from the API.
//  If you use google-ads-script/google-ads-native.js, make the same
//  change there — it runs outside this project and has its own copy.
// ─────────────────────────────────────────────────────────────
var NAME_SEPARATOR = "_";
var NAME_FIELDS = ["Project Number", "Artist", "Release", "Objective", "Segment", "PM", "Mes"];

// Campaign name → one trimmed value per NAME_FIELDS entry, blanks for
// missing segments. Anything past the last field is dropped.
function parseCampaignName(name) {
  var p = String(name || "").split(NAME_SEPARATOR);
  return NAME_FIELDS.map(function (_, i) { return (p[i] || "").trim(); });
}

// A puller's full header row: "Date Pulled", the naming columns, then its own.
// Built on call, not at load time: Apps Script loads files in the order they
// were created, so a top-level reference to NAME_FIELDS from another file can
// run before this file exists.
function buildHeaders(platformHeaders) {
  return ["Date Pulled"].concat(NAME_FIELDS, platformHeaders);
}

// 0-based position of a header, failing loudly instead of writing to column -1.
function colIndex(headers, name) {
  var i = headers.indexOf(name);
  if (i < 0) throw new Error("Header not found: " + name);
  return i;
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
//  UPSERT ENGINE — shared by all four pullers
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
  var created = !sheet;
  if (created) sheet = ss.insertSheet(name);

  // Row 1 is rewritten whenever it no longer matches — a tab created under an
  // older column layout would otherwise keep stale headers while the puller
  // writes the new ones, which puts Campaign ID in a column the upsert isn't
  // reading and turns every campaign into a "new" duplicate row.
  // Only the columns this puller owns are compared: a column you added to the
  // right is yours, and must not read as a layout change on every run.
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (String(current) !== String(headers)) {
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setValues([headers]);
    hr.setBackground(headerColor || "#1a1a2e");
    hr.setFontColor("#ffffff").setFontWeight("bold").setFontSize(10);
    sheet.setFrozenRows(1);
    // Rows written under the old layout are misaligned against the new one, so
    // they go and this run repopulates the tab from the API.
    // ponytail: if that pull then fails the tab stays empty until the next run;
    // the data is a mirror of the API, so the next good run refills it.
    if (!created && sheet.getLastRow() > 1) {
      // Only the columns this puller owns: anything you added to the right of
      // them is yours and stays put.
      sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
      Logger.log("Sheet " + name + ": column layout changed — headers rewritten and rows " +
                 "cleared; this run rebuilds them.");
    } else {
      Logger.log(created ? "Sheet created: " + name : "Sheet " + name + ": headers rewritten.");
    }
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
