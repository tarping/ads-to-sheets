// ============================================================
//  GOOGLE ADS SCRIPT (native) → GOOGLE SHEETS
//  Drop-in replacement for apps-script/google-ads.gs.
//
//  NO OAuth. No refresh token. No developer token. No Google
//  Cloud project. Use this if the OAuth flow blocks you (see
//  docs/troubleshooting.md → "This app is blocked").
//
//  ⚠ This does NOT go in the Apps Script project. Install it in
//  the Google Ads UI:
//     ads.google.com → open the ad account (not the MCC) →
//     Tools & Settings → Bulk actions → Scripts → [ + ]
//
//  Then:
//   1. Paste this file in and set SPREADSHEET_URL below.
//   2. Click Authorize (Google's own consent — no app review).
//   3. Preview, then Run.
//   4. Frequency → Daily, at any hour you like.
//
//  This file is self-contained: it does not use shared.gs.
// ============================================================

var GCONFIG = {
  SPREADSHEET_URL: "PASTE_YOUR_GOOGLE_SHEET_URL_HERE",
  SHEET_NAME     : "Google Campaigns",
  START_DATE     : "2025-01-01"   // ← earliest date to include
};

var GHEADERS = [
  "Date Pulled",
  "Project Number", "Artist", "Release", "Objective", "Segment", "PM", "Mes",
  "Campaign Name (raw)", "Campaign ID", "Campaign Type",
  "Effective Status", "Spend",
  "Impressions", "Clicks", "CTR (%)", "CPC",
  "Video Views", "View Rate (%)", "Avg CPV"
];
var G_NUM_COLS   = GHEADERS.length; // owns columns A–T
var G_COL_ID     = 9;   // column J
var G_COL_STATUS = 11;  // column L
var G_COL_SPEND  = 12;  // column M


function main() {
  var tz    = AdsApp.currentAccount().getTimeZone();
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var sheet = getOrCreateSheet();

  // Lifetime metrics per campaign: the date range lives in WHERE and
  // segments.date is not selected, so the API aggregates server-side.
  var metricRows = AdsApp.search(
    "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, " +
    "campaign.advertising_channel_type, metrics.impressions, metrics.clicks, " +
    "metrics.cost_micros, metrics.video_trueview_views " +
    "FROM campaign " +
    "WHERE campaign.status != 'REMOVED' " +
    "AND segments.date BETWEEN '" + GCONFIG.START_DATE + "' AND '" + today + "'"
  );

  var fresh = {};
  while (metricRows.hasNext()) {
    var r = metricRows.next();
    var c = r.campaign;
    var m = r.metrics || {};
    var id          = String(c.id);
    var impressions = parseInt(m.impressions || 0, 10);
    var clicks      = parseInt(m.clicks || 0, 10);
    var spend       = parseFloat((parseInt(m.costMicros || 0, 10) / 1e6).toFixed(2));
    var videoViews  = parseInt(m.videoTrueviewViews || 0, 10);
    if (impressions === 0 && spend === 0) continue;

    var status = c.primaryStatus || c.status || "";
    var parsed = parseCampaignName(c.name);
    fresh[id] = {
      status: status,
      row: [
        today,
        parsed.field1, parsed.field2, parsed.field3, parsed.field4, parsed.field5,
        parsed.field6, parsed.field7,
        c.name, id,
        c.advertisingChannelType || "UNKNOWN",
        status,
        spend,
        impressions,
        clicks,
        impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(4)) : 0,
        clicks > 0 ? parseFloat((spend / clicks).toFixed(4)) : 0,
        videoViews,
        impressions > 0 ? parseFloat(((videoViews / impressions) * 100).toFixed(4)) : 0,
        videoViews > 0 ? parseFloat((spend / videoViews).toFixed(4)) : 0
      ]
    };
  }

  // Campaigns that never delivered in the range are missing above,
  // so fetch every non-removed campaign to refresh their status.
  var statusOnly = {};
  var statusRows = AdsApp.search(
    "SELECT campaign.id, campaign.status, campaign.primary_status " +
    "FROM campaign WHERE campaign.status != 'REMOVED'"
  );
  var totalCampaigns = 0;
  while (statusRows.hasNext()) {
    var sr = statusRows.next();
    totalCampaigns++;
    var sid = String(sr.campaign.id);
    if (!fresh[sid]) statusOnly[sid] = sr.campaign.primaryStatus || sr.campaign.status || "PAUSED";
  }

  Logger.log("Google Ads: " + Object.keys(fresh).length + " campaigns with delivery, " +
             totalCampaigns + " total in account.");
  upsertRows(sheet, fresh, statusOnly);
}


// ============================================================
//  UPSERT — one row per campaign, matched by Campaign ID
// ============================================================
function upsertRows(sheet, fresh, statusOnly) {
  var prevLast = sheet.getLastRow();
  var rows = (prevLast > 1) ? sheet.getRange(2, 1, prevLast - 1, G_NUM_COLS).getValues() : [];

  var index = {};
  rows.forEach(function (r, i) {
    var id = String(r[G_COL_ID]).trim();
    if (id) index[id] = i;
  });

  var updated = 0, added = 0, unchanged = 0, restamped = 0;
  var seen = {};

  Object.keys(fresh).forEach(function (id) {
    seen[id] = true;
    var entry = fresh[id];
    var i = index[id];
    if (i !== undefined) {
      var oldSpend = parseFloat(rows[i][G_COL_SPEND]) || 0;
      var newSpend = parseFloat(entry.row[G_COL_SPEND]) || 0;
      var oldStatus = String(rows[i][G_COL_STATUS] || "");
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
    var id = String(r[G_COL_ID]).trim();
    if (!id || seen[id]) return;
    var newStatus = statusOnly[id] || "PAUSED";
    if (String(r[G_COL_STATUS]) !== newStatus) {
      r[G_COL_STATUS] = newStatus;
      restamped++;
    }
  });

  if (rows.length) sheet.getRange(2, 1, rows.length, G_NUM_COLS).setValues(rows);

  Logger.log("Upsert done — updated: " + updated + " | new: " + added +
             " | unchanged: " + unchanged + " | status refreshed: " + restamped +
             " | total rows: " + rows.length);
}


// ============================================================
//  HELPERS
// ============================================================

// Keep this identical to parseCampaignName() in apps-script/shared.gs
// so both pullers split names the same way.
function parseCampaignName(name) {
  var p = String(name || "").split("_").map(function (s) { return s.trim(); });
  return {
    field1: p[0] || "",   // Project Number
    field2: p[1] || "",   // Artist
    field3: p[2] || "",   // Release
    field4: p[3] || "",   // Objective
    field5: p[4] || "",   // Segment
    field6: p[5] || "",   // PM
    field7: p[6] || ""    // Mes
  };
}

function getOrCreateSheet() {
  if (GCONFIG.SPREADSHEET_URL.indexOf("http") !== 0) {
    throw new Error("Set GCONFIG.SPREADSHEET_URL to your Google Sheet URL first.");
  }
  var ss = SpreadsheetApp.openByUrl(GCONFIG.SPREADSHEET_URL);
  var sheet = ss.getSheetByName(GCONFIG.SHEET_NAME);
  var created = !sheet;
  if (created) sheet = ss.insertSheet(GCONFIG.SHEET_NAME);

  // Same rule as getOrCreateSheet() in shared.gs: a tab left on an older column
  // layout gets row 1 rewritten, and its misaligned rows cleared so this run
  // rebuilds them.
  var current = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    : [];
  if (String(current) !== String(GHEADERS)) {
    var hr = sheet.getRange(1, 1, 1, GHEADERS.length);
    hr.setValues([GHEADERS]);
    hr.setBackground("#0f4c81");
    hr.setFontColor("#ffffff").setFontWeight("bold").setFontSize(10);
    sheet.setFrozenRows(1);
    if (!created && sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, GHEADERS.length).clearContent();
      Logger.log("Sheet " + GCONFIG.SHEET_NAME + ": column layout changed — headers " +
                 "rewritten and rows cleared; this run rebuilds them.");
    } else {
      Logger.log(created ? "Sheet created: " + GCONFIG.SHEET_NAME
                         : "Sheet " + GCONFIG.SHEET_NAME + ": headers rewritten.");
    }
  }
  return sheet;
}
