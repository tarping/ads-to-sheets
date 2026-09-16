// ============================================================
//  GOOGLE ADS → GOOGLE SHEETS  |  Lifetime campaign puller
//
//  One row per campaign, lifetime metrics since START_DATE,
//  matched by Campaign ID and updated in place.
//
//  Two GAQL queries total. The date range lives in the WHERE
//  clause and `segments.date` is NOT selected, so the API
//  aggregates lifetime totals per campaign server-side — no
//  per-campaign loop, no batching, no day-by-day summing.
//
//  Required Script Properties:
//    GADS_DEVELOPER_TOKEN, GADS_CLIENT_ID,
//    GADS_CLIENT_SECRET,   GADS_REFRESH_TOKEN
//  Docs: docs/google-ads.md
//
//  ⚠ Getting an OAuth refresh token is the hardest part of this
//  whole repo, and Google blocks unverified apps for some
//  accounts. If you hit that wall, use the drop-in alternative
//  in google-ads-script/ instead — it needs no OAuth at all.
//
//  Functions:
//    gadsFullPull           run once — rebuilds the whole tab
//    gadsDailyPull          daily trigger — updates what changed
//    gadsCreateDailyTrigger arms the 04:00 daily run
//    gadsDebugAuth          verify token + API access
// ============================================================

var GADS = {
  CUSTOMER_ID      : "0000000000",   // ← the ad account you pull FROM (digits only)
  LOGIN_CUSTOMER_ID: "0000000000",   // ← the MCC it sits under (digits only)
  SHEET_NAME       : "Google Campaigns",
  START_DATE       : "2025-01-01",   // ← earliest date to include
  API_VERSION      : "v23"
};

var GADS_HEADERS = [
  "Date Pulled",
  "Project Number", "Artist", "Release", "Objective", "Segment", "PM", "Mes",
  // ↑ from parseCampaignName()
  "Campaign Name (raw)", "Campaign ID", "Campaign Type",
  "Effective Status", "Spend",
  "Impressions", "Clicks", "CTR (%)", "CPC",
  "Video Views", "View Rate (%)", "Avg CPV"
];
var GADS_NUM_COLS   = GADS_HEADERS.length; // owns columns A–T
var GADS_COL_ID     = 9;   // column J
var GADS_COL_STATUS = 11;  // column L
var GADS_COL_SPEND  = 12;  // column M


// ============================================================
//  ENTRY POINTS
// ============================================================
function gadsFullPull()  { _gadsRun(true);  }
function gadsDailyPull() { _gadsRun(false); }

function _gadsRun(rebuild) {
  var today = todayUTC();
  var sheet = getOrCreateSheet(GADS.SHEET_NAME, GADS_HEADERS, "#0f4c81");

  // Query 1 — lifetime metrics per campaign.
  var metricRows = _gadsSearch(
    "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, " +
    "campaign.advertising_channel_type, metrics.impressions, metrics.clicks, " +
    "metrics.cost_micros, metrics.video_trueview_views " +
    "FROM campaign " +
    "WHERE campaign.status != 'REMOVED' " +
    "AND segments.date BETWEEN '" + GADS.START_DATE + "' AND '" + today + "'"
  );

  // Query 2 — every non-removed campaign, because query 1 omits
  // campaigns that never delivered inside the date range.
  var statusRows = _gadsSearch(
    "SELECT campaign.id, campaign.status, campaign.primary_status " +
    "FROM campaign WHERE campaign.status != 'REMOVED'"
  );

  var fresh = {};
  metricRows.forEach(function (r) {
    var c = r.campaign || {};
    var m = r.metrics || {};
    var id = String(c.id);

    var impressions = parseInt(m.impressions || 0);
    var clicks      = parseInt(m.clicks || 0);
    // The REST API returns camelCase JSON; snake_case fallbacks keep this
    // working if you switch to a client library that preserves field names.
    var spend      = parseFloat((parseInt(m.costMicros || m.cost_micros || 0) / 1e6).toFixed(2));
    var videoViews = parseInt(m.videoTrueviewViews || m.video_trueview_views || 0);

    if (impressions === 0 && spend === 0) return;

    var status      = c.primaryStatus || c.primary_status || c.status || "";
    var channelType = c.advertisingChannelType || c.advertising_channel_type || "UNKNOWN";
    var parsed      = parseCampaignName(c.name || "");

    fresh[id] = {
      status: status,
      row: [
        today,
        parsed.field1, parsed.field2, parsed.field3, parsed.field4, parsed.field5,
            parsed.field6, parsed.field7,
        c.name, id,
        channelType,
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
  });

  var statusOnly = {};
  statusRows.forEach(function (r) {
    var c = r.campaign || {};
    var id = String(c.id);
    if (!fresh[id]) statusOnly[id] = c.primaryStatus || c.primary_status || c.status || "PAUSED";
  });

  Logger.log("Google Ads: " + Object.keys(fresh).length + " campaigns with delivery, " +
             statusRows.length + " total in account.");
  upsertRows(sheet, GADS_NUM_COLS, GADS_COL_ID, GADS_COL_SPEND, GADS_COL_STATUS,
             fresh, "PAUSED", statusOnly, rebuild);
}


// ============================================================
//  API — searchStream returns the whole result set in one call
// ============================================================
function _gadsSearch(query) {
  var cleanCustomerId = String(GADS.CUSTOMER_ID).replace(/[^0-9]/g, "");
  var url = "https://googleads.googleapis.com/" + GADS.API_VERSION +
            "/customers/" + cleanCustomerId + "/googleAds:searchStream";
  var out = [];

  try {
    var res = UrlFetchApp.fetch(url, {
      method: "POST",
      contentType: "application/json",
      headers: _gadsHeaders(),
      payload: JSON.stringify({ query: query }),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var text = res.getContentText();

    if (code !== 200) {
      Logger.log("❌ Google Ads API HTTP " + code + ": " + text.substring(0, 500));
      return out;
    }

    // searchStream responds with an ARRAY of batches, each holding `results`.
    var batches = JSON.parse(text);
    if (Array.isArray(batches)) {
      batches.forEach(function (batch) {
        if (batch.results && Array.isArray(batch.results)) {
          batch.results.forEach(function (r) { out.push(r); });
        }
      });
    }
  } catch (e) {
    Logger.log("❌ Google Ads exception: " + e.message);
  }

  return out;
}


// ============================================================
//  AUTH — secrets come from Script Properties, never source
// ============================================================
function _gadsAccessToken() {
  var res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    payload: "client_id=" + encodeURIComponent(getSecret("GADS_CLIENT_ID")) +
             "&client_secret=" + encodeURIComponent(getSecret("GADS_CLIENT_SECRET")) +
             "&refresh_token=" + encodeURIComponent(getSecret("GADS_REFRESH_TOKEN")) +
             "&grant_type=refresh_token",
    muteHttpExceptions: true
  });
  var token = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw new Error("Google Ads auth failed: " + (token.error_description || token.error));
  }
  return token.access_token;
}

function _gadsHeaders() {
  return {
    "Authorization"    : "Bearer " + _gadsAccessToken(),
    "developer-token"  : getSecret("GADS_DEVELOPER_TOKEN"),
    "login-customer-id": String(GADS.LOGIN_CUSTOMER_ID).replace(/[^0-9]/g, "")
  };
}


// ============================================================
//  DEBUG — run this before the first full pull
// ============================================================
function gadsDebugAuth() {
  try {
    _gadsAccessToken();
    Logger.log("✅ Token OK");
  } catch (e) {
    Logger.log("❌ Token FAILED: " + e.message);
    return;
  }
  var rows = _gadsSearch("SELECT campaign.id, campaign.name FROM campaign LIMIT 3");
  Logger.log("✅ API returned " + rows.length + " rows: " + JSON.stringify(rows).substring(0, 300));
}


// ============================================================
//  TRIGGER
// ============================================================
function gadsCreateDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "gadsDailyPull") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("gadsDailyPull").timeBased().everyDays(1).atHour(4).create();
  Logger.log("Google Ads daily trigger set (04:00 script timezone).");
}
