// ============================================================
//  TIKTOK ADS → GOOGLE SHEETS  |  Lifetime campaign puller
//
//  One row per campaign, lifetime metrics since START_DATE,
//  matched by Campaign ID and updated in place.
//
//  Two paginated calls per advertiser account: one for campaign
//  statuses, one for the aggregated lifetime report.
//
//  Required Script Property:  TIKTOK_ACCESS_TOKEN
//  Docs: docs/tiktok.md
//
//  Functions:
//    ttFullPull           run once — rebuilds the whole tab
//    ttDailyPull          daily trigger — updates what changed
//    ttCreateDailyTrigger arms the 05:00 daily run
// ============================================================

var TT = {
  ADVERTISERS: [
    { id: "0000000000000000000", name: "Main Account" }
    // Add more advertiser accounts here; they all land in the same tab
    // and are told apart by the "Account" column:
    // , { id: "0000000000000000000", name: "Second Account" }
  ],
  SHEET_NAME: "TikTok Campaigns",
  START_DATE: "2025-01-01"   // ← earliest date to include
};

var TT_HEADERS = [
  "Date Pulled",
  "Artist", "Release", "Segment", "Objective", "Budget",   // ← from parseCampaignName()
  "Campaign Name (raw)", "Campaign ID", "Account", "Status",
  "Spend", "Impressions", "Clicks", "CTR", "CPC", "CPM", "Reach",
  "Video Watched 6s", "Sound Clicks", "Conversions", "Cost per Conversion"
];
var TT_NUM_COLS   = TT_HEADERS.length; // owns columns A–U
var TT_COL_ID     = 7;   // column H
var TT_COL_STATUS = 9;   // column J
var TT_COL_SPEND  = 10;  // column K

var TT_METRICS = ["campaign_name", "spend", "impressions", "clicks", "ctr", "cpc", "cpm",
                  "reach", "video_watched_6s", "sound_usage_clicks", "conversion",
                  "cost_per_conversion"];


// ============================================================
//  ENTRY POINTS
// ============================================================
function ttFullPull()  { _ttRun(true);  }
function ttDailyPull() { _ttRun(false); }

function _ttRun(rebuild) {
  var token = getSecret("TIKTOK_ACCESS_TOKEN");
  var today = todayUTC();
  var sheet = getOrCreateSheet(TT.SHEET_NAME, TT_HEADERS, "#161823");

  var fresh = {};
  var statusOnly = {};

  TT.ADVERTISERS.forEach(function (acct) {
    // 1) Live status per campaign.
    var statusMap = {};
    _ttPaginate("https://business-api.tiktok.com/open_api/v1.3/campaign/get/", {
      advertiser_id: acct.id,
      fields       : JSON.stringify(["campaign_id", "campaign_name", "operation_status"]),
      page_size    : 100
    }, token, function (c) {
      statusMap[String(c.campaign_id)] = (c.operation_status === "ENABLE") ? "ACTIVE" : "PAUSED";
    });

    // 2) Lifetime report — one aggregated row per campaign with data in range.
    _ttPaginate("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
      advertiser_id: acct.id,
      report_type  : "BASIC",
      data_level   : "AUCTION_CAMPAIGN",
      dimensions   : JSON.stringify(["campaign_id"]),
      metrics      : JSON.stringify(TT_METRICS),
      start_date   : TT.START_DATE,
      end_date     : today,
      page_size    : 200
    }, token, function (row) {
      var id     = String(row.dimensions.campaign_id);
      var m      = row.metrics;
      var parsed = parseCampaignName(m.campaign_name);
      var status = statusMap[id] || "PAUSED";
      fresh[id] = {
        status: status,
        row: [
          today,
          parsed.field1, parsed.field2, parsed.field3, parsed.field4, parsed.field5,
          m.campaign_name, id, acct.name, status,
          _ttNum(m.spend), _ttNum(m.impressions), _ttNum(m.clicks), _ttNum(m.ctr),
          _ttNum(m.cpc), _ttNum(m.cpm), _ttNum(m.reach), _ttNum(m.video_watched_6s),
          _ttNum(m.sound_usage_clicks), _ttNum(m.conversion), _ttNum(m.cost_per_conversion)
        ]
      };
    });

    Object.keys(statusMap).forEach(function (id) {
      if (!fresh[id]) statusOnly[id] = statusMap[id];
    });
  });

  Logger.log("TikTok: " + Object.keys(fresh).length + " campaigns with data in range.");
  upsertRows(sheet, TT_NUM_COLS, TT_COL_ID, TT_COL_SPEND, TT_COL_STATUS,
             fresh, "PAUSED", statusOnly, rebuild);
}


// ============================================================
//  API — page / total_page pagination
// ============================================================
function _ttPaginate(baseUrl, params, token, onItem) {
  var page = 1, totalPages = 1;
  do {
    params.page = page;
    var qs = Object.keys(params).map(function (k) {
      return k + "=" + encodeURIComponent(params[k]);
    }).join("&");

    try {
      var res  = UrlFetchApp.fetch(baseUrl + "?" + qs, {
        method: "get", headers: { "Access-Token": token }, muteHttpExceptions: true
      });
      var data = JSON.parse(res.getContentText());
      if (data.code !== 0) {
        Logger.log("TikTok API error: " + data.message);
        return;
      }
      (data.data.list || []).forEach(onItem);
      totalPages = (data.data.page_info && data.data.page_info.total_page) || 1;
      page++;
      if (page <= totalPages) Utilities.sleep(200);
    } catch (e) {
      Logger.log("TikTok exception: " + e.message);
      return;
    }
  } while (page <= totalPages);
}

// TikTok returns numbers as strings; keep blanks blank so empty
// cells don't become zeros in charts.
function _ttNum(v) {
  if (v === "" || v === null || v === undefined) return "";
  var n = Number(v);
  return isNaN(n) ? v : n;
}


// ============================================================
//  TRIGGER
// ============================================================
function ttCreateDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "ttDailyPull") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("ttDailyPull").timeBased().everyDays(1).atHour(5).create();
  Logger.log("TikTok daily trigger set (05:00 script timezone).");
}
