// ============================================================
//  SPOTIFY ADS → GOOGLE SHEETS  |  Lifetime campaign puller
//
//  One row per campaign, lifetime metrics since START_DATE,
//  matched by Campaign ID and updated in place.
//
//  Four paginated calls per ad account: one for the account's
//  currency, one for campaign statuses and delivery goals, one
//  for ad set flight dates, and one aggregate report per 89-day
//  window between START_DATE and today — the report endpoint
//  rejects any range of 90 days or more, so a lifetime total is
//  stitched together from consecutive windows.
//
//  Required Script Properties:
//    SPOTIFY_CLIENT_ID
//    SPOTIFY_CLIENT_SECRET
//    SPOTIFY_REFRESH_TOKEN
//  Optional:
//    SPOTIFY_ACCOUNTS   "uuid = Name, uuid = Name" — set this and you never
//                       paste an account id into the code again
//  Docs: docs/spotify.md
//
//  Unlike the other three platforms, the Spotify Ads API is
//  partner-gated: your app has to be approved for it before any
//  of these calls return anything but 403. See docs/spotify.md.
//
//  Functions:
//    spFullPull           run once — rebuilds the whole tab
//    spDailyPull          daily trigger — updates what changed
//    spCreateDailyTrigger arms the 06:00 daily run
// ============================================================

var SP = {
  // Fallback only. Prefer the SPOTIFY_ACCOUNTS Script Property:
  //   "11111111-2222-3333-4444-555555555555 = Main Account, a1b2c3d4-… = Second"
  // It survives every code update, and keeps real account ids out of a public
  // repo. Accounts all land in the same tab, told apart by the "Account" column.
  ACCOUNTS: [
    { id: "00000000-0000-0000-0000-000000000000", name: "Main Account" }
  ],
  SHEET_NAME: "Spotify Campaigns",
  START_DATE: "2025-01-01"   // ← earliest date to include
};

var SP_HEADERS = [
  "Date Pulled",
  "Project Number", "Artist", "Release", "Objective", "Segment", "PM", "Mes",
  // ↑ from parseCampaignName()
  "Campaign Name (raw)", "Campaign ID", "Account", "Status", "Delivery Goal",
  "Start Date", "End Date",
  "Currency", "Spend", "Impressions", "Reach", "Frequency",
  "Clicks", "CTR", "Streams", "Listeners", "New Listeners",
  "Video Views", "Completion Rate"
];
var SP_NUM_COLS   = SP_HEADERS.length; // owns columns A–AA
var SP_COL_ID     = 9;   // column J
var SP_COL_STATUS = 11;  // column L
var SP_COL_SPEND  = 16;  // column Q

// Report fields, in the order they are written to the sheet.
// PAID_LISTENS is not here on purpose: the account reports it as 0 for every
// campaign, and a column of zeros reads as a measurement rather than as nothing.
var SP_FIELDS = ["SPEND", "IMPRESSIONS", "REACH", "FREQUENCY", "CLICKS", "CTR",
                 "STREAMS", "LISTENERS", "NEW_LISTENERS",
                 "VIDEO_VIEWS", "COMPLETION_RATE"];

// Spotify rejects a report range of 90 days or more, so a lifetime pull is
// stitched from consecutive windows this long.
var SP_WINDOW_DAYS = 89;

// How each field survives being merged across those windows. Rates are
// re-averaged weighted by the field named here, which also preserves whatever
// unit Spotify reports them in; the unmergeable ones are per-window uniques
// (and the frequency derived from them). Everything else is a counter and sums.
var SP_AVG_FIELDS = { CTR: "IMPRESSIONS", COMPLETION_RATE: "VIDEO_VIEWS" };
var SP_UNMERGEABLE_FIELDS = { REACH: 1, LISTENERS: 1, NEW_LISTENERS: 1, FREQUENCY: 1 };

var SP_API = "https://api-partner.spotify.com/ads/v3";
var SP_PAGE = 50;          // both list endpoints cap a page at 50
var SP_MAX_PAGES = 40;     // 2 000 campaigns; a stop so a bad token can't loop


// ============================================================
//  ENTRY POINTS
// ============================================================
function spFullPull()  { _spRun(true);  }
function spDailyPull() { _spRun(false); }

// The ad accounts to pull: the Script Property when it is set, the config
// above otherwise.
function _spAccounts() {
  var raw = PropertiesService.getScriptProperties().getProperty("SPOTIFY_ACCOUNTS");
  return raw ? _spParseAccounts(raw) : SP.ACCOUNTS;
}

// "uuid = Name, uuid = Name" -> [{ id, name }]. A missing name falls back to the
// id's first block, so a half-filled property still produces readable rows.
function _spParseAccounts(raw) {
  return String(raw).split(",").map(function (part) {
    var bits = part.split("=");
    var id = String(bits[0] || "").trim();
    return { id: id, name: String(bits[1] || "").trim() || id.split("-")[0] };
  }).filter(function (a) { return a.id; });
}

function _spRun(rebuild) {
  var token = _spAccessToken();
  var today = todayUTC();
  var sheet = getOrCreateSheet(SP.SHEET_NAME, SP_HEADERS, "#1db954");

  var fresh = {};
  var statusOnly = {};
  // A blank Reach/Listeners column has two very different causes — the account
  // never reported the field, or the campaign crossed a window boundary and the
  // uniques could not be merged. The run log tells them apart.
  var diag = { campaigns: 0, spanned: 0, noUniques: 0, noSpend: 0, statuses: {} };

  _spAccounts().forEach(function (acct) {
    // 1) The account's billing currency. Spend is meaningless without it,
    //    and accounts in different currencies can share this tab.
    var account = _spGet("/ad_accounts/" + acct.id, {}, token);
    if (!account) return;
    var currency = account.currency_code || "";

    // 2) Status and delivery goal per campaign. The report carries a status
    //    but not the goal, and the goal is what makes "Streams" or "Clicks"
    //    the number to read for a given row.
    var meta = {};
    for (var page = 0; page < SP_MAX_PAGES; page++) {
      var list = _spGet("/ad_accounts/" + acct.id + "/campaigns",
        { limit: SP_PAGE, offset: page * SP_PAGE }, token);
      if (!list) break;
      var campaigns = list.campaigns || [];
      campaigns.forEach(function (c) {
        var st = String(c.status || "UNSET");
        diag.statuses[st] = (diag.statuses[st] || 0) + 1;
        meta[String(c.id)] = {
          status: st,
          goal  : String(c.delivery_goal_group || "")
        };
      });
      if (campaigns.length < SP_PAGE) break;
      Utilities.sleep(200);
    }

    // 3) Flight dates. A campaign has none of its own: schedules live on its
    //    ad sets, so the campaign's flight is the earliest start and the
    //    latest end across them.
    var flights = _spFlights(acct.id, token);

    // 4) Lifetime aggregate report, one window at a time, merged per campaign.
    var agg = {};
    _spWindows(SP.START_DATE, today).forEach(function (w) {
      _spReportWindow(acct.id, token, w, function (r) {
        _spMerge(agg, String(r.entity_id), r.entity_name,
                 String(r.entity_status || "PAUSED"), _spStats(r.stats));
      });
      Utilities.sleep(200);
    });

    Object.keys(agg).forEach(function (id) {
      var a      = agg[id];
      var stats  = _spTotals(a);
      // A campaign that never spent is noise: it still gets its status
      // refreshed below if it is already in the sheet, but it never adds a row.
      if (!(stats.SPEND > 0)) { diag.noSpend++; return; }
      diag.campaigns++;
      if (a.windows > 1) diag.spanned++;
      if (!("REACH" in a.last)) diag.noUniques++;
      var parsed = parseCampaignName(a.name);
      var info   = meta[id] || { status: a.status, goal: "" };
      var flight = flights[id] || { start: "", end: "", open: false };
      var state  = _spState(info.status, flight, today);
      fresh[id] = {
        status: state,
        row: [
          today,
          parsed.field1, parsed.field2, parsed.field3, parsed.field4, parsed.field5,
          parsed.field6, parsed.field7,
          a.name, id, acct.name, state, info.goal,
          flight.start, flight.end,
          currency,
          stats.SPEND, stats.IMPRESSIONS, stats.REACH, stats.FREQUENCY,
          stats.CLICKS, stats.CTR, stats.STREAMS, stats.LISTENERS,
          stats.NEW_LISTENERS, stats.VIDEO_VIEWS,
          stats.COMPLETION_RATE
        ]
      };
    });

    Object.keys(meta).forEach(function (id) {
      if (fresh[id]) return;
      statusOnly[id] = _spState(meta[id].status,
        flights[id] || { start: "", end: "", open: false }, today);
    });
  });

  Logger.log("Spotify: " + Object.keys(fresh).length + " campaigns with data in range.");
  Logger.log("Spotify statuses: " + JSON.stringify(diag.statuses));
  Logger.log("Spotify: " + diag.noSpend + " campaigns skipped for zero spend.");
  Logger.log("Spotify uniques (Reach/Frequency/Listeners/New Listeners): " +
             diag.noUniques + " of " + diag.campaigns + " campaigns never reported them; " +
             diag.spanned + " ran across more than one " + SP_WINDOW_DAYS +
             "-day window, which blanks them. Run spInspect() to see the raw fields.");
  upsertRows(sheet, SP_NUM_COLS, SP_COL_ID, SP_COL_SPEND, SP_COL_STATUS,
             fresh, "PAUSED", statusOnly, rebuild);
}


// ============================================================
//  FLIGHT DATES
// ============================================================
//  Campaign id -> { start, end } as YYYY-MM-DD, rolled up from the
//  campaign's ad sets.
//
//  An ad set with no end_time runs open-ended, and one open-ended ad set
//  makes the whole campaign open-ended — so End Date is left blank rather
//  than reporting the latest of the ad sets that DO end, which would read
//  as a campaign that has finished when it has not.
function _spFlights(accountId, token) {
  var flights = {};
  for (var page = 0; page < SP_MAX_PAGES; page++) {
    var body = _spGet("/ad_accounts/" + accountId + "/ad_sets",
      { limit: SP_PAGE, offset: page * SP_PAGE }, token);
    if (!body) break;
    var adSets = body.ad_sets || [];
    adSets.forEach(function (a) {
      var cid = String(a.campaign_id || "");
      if (!cid) return;
      var f = flights[cid] || { start: "", end: "", open: false };
      // Both are ISO 8601 UTC with a fixed layout, so string comparison
      // orders them correctly without parsing anything into a Date.
      var start = String(a.start_time || "");
      if (start && (!f.start || start < f.start)) f.start = start;
      if (!a.end_time) {
        f.open = true;
      } else {
        var end = String(a.end_time);
        if (!f.end || end > f.end) f.end = end;
      }
      flights[cid] = f;
    });
    if (adSets.length < SP_PAGE) break;
    Utilities.sleep(200);
  }

  // Trim to dates: a sheet reads better with 2026-03-14 than with a
  // timestamp, and the hour is never the interesting part of a flight.
  Object.keys(flights).forEach(function (cid) {
    var f = flights[cid];
    f.start = f.start ? f.start.slice(0, 10) : "";
    f.end = (f.open || !f.end) ? "" : f.end.slice(0, 10);
  });
  return flights;
}


// ============================================================
//  STATUS
// ============================================================
//  Spotify's `status` is the on/off switch, not whether the campaign is
//  delivering: a campaign that finished in March still reads ACTIVE until
//  somebody pauses it, which is why the column came back all-ACTIVE. So the
//  flight dates decide the state whenever the switch is still on:
//
//    PAUSED / ARCHIVED / anything not ACTIVE  → left exactly as Spotify says
//    ACTIVE, starts in the future             → SCHEDULED
//    ACTIVE, ended before today               → ENDED
//    ACTIVE, running or open-ended            → ACTIVE
//
//  A campaign with no ad sets has no flight, so it keeps Spotify's value.
//  Dates are YYYY-MM-DD, which compares correctly as a string.
function _spState(status, flight, today) {
  if (String(status).toUpperCase() !== "ACTIVE") return status;
  if (flight.start && flight.start > today) return "SCHEDULED";
  if (!flight.open && flight.end && flight.end < today) return "ENDED";
  return status;
}


// ============================================================
//  API
// ============================================================
//  The access token is minted per run from the refresh token, so
//  nothing here expires between daily pulls. Spotify takes the
//  client credentials as HTTP Basic, not as form fields.
function _spAccessToken() {
  var id     = getSecret("SPOTIFY_CLIENT_ID");
  var secret = getSecret("SPOTIFY_CLIENT_SECRET");
  var res = UrlFetchApp.fetch("https://accounts.spotify.com/api/token", {
    method : "post",
    headers: { Authorization: "Basic " + Utilities.base64Encode(id + ":" + secret) },
    payload: {
      grant_type   : "refresh_token",
      refresh_token: getSecret("SPOTIFY_REFRESH_TOKEN")
    },
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || !body.access_token) {
    throw new Error("Spotify OAuth refresh failed: " +
      (body.error_description || body.error || res.getContentText()));
  }
  return body.access_token;
}

// Returns the parsed body, or null after logging — one failing account
// must not take the other accounts' rows down with it.
function _spGet(path, params, token) {
  var qs = [];
  Object.keys(params).forEach(function (k) {
    var v = params[k];
    // Array params (`fields`) repeat the key rather than joining with commas.
    if (Object.prototype.toString.call(v) === "[object Array]") {
      v.forEach(function (item) { qs.push(k + "=" + encodeURIComponent(item)); });
    } else {
      qs.push(k + "=" + encodeURIComponent(v));
    }
  });
  var url = SP_API + path + (qs.length ? "?" + qs.join("&") : "");

  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get", headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      // A bare 403 here almost always means the app is not approved for the
      // Ads API, which looks nothing like a bad account id — log the body.
      Logger.log("Spotify API " + res.getResponseCode() + " on " + path + ": " +
                 res.getContentText().slice(0, 300));
      return null;
    }
    return JSON.parse(res.getContentText());
  } catch (e) {
    Logger.log("Spotify exception on " + path + ": " + e.message);
    return null;
  }
}

// stats arrive as [{field_type, field_value}]; flatten to {FIELD: number}.
// Fields the account does not report stay blank rather than becoming zeros,
// so an empty cell reads as "not measured" and not as "measured at nought".
function _spStats(stats) {
  var out = {};
  SP_FIELDS.forEach(function (f) { out[f] = ""; });
  (stats || []).forEach(function (s) {
    var n = Number(s.field_value);
    out[s.field_type] = isNaN(n) ? s.field_value : n;
  });
  return out;
}


// ============================================================
//  WINDOWED LIFETIME TOTALS
// ============================================================
//  Consecutive report windows covering START_DATE..today, each short
//  enough for the endpoint's limit.
function _spWindows(start, end) {
  var DAY = 86400000;
  var cur = Date.parse(start + "T00:00:00Z");
  var last = Date.parse(end + "T00:00:00Z");
  var out = [];
  while (cur <= last) {
    var stop = Math.min(cur + (SP_WINDOW_DAYS - 1) * DAY, last);
    out.push({ start: _spDay(cur), end: _spDay(stop) });
    cur = stop + DAY;
  }
  return out;
}

function _spDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Every report row for one window, page by page, handed to `onRow`.
function _spReportWindow(accountId, token, w, onRow) {
  var continuation = null;
  for (var p = 0; p < SP_MAX_PAGES; p++) {
    // Once a continuation token is sent, every other parameter is rejected.
    var params = continuation ? { continuation_token: continuation } : {
      entity_type : "CAMPAIGN",
      granularity : "LIFETIME",
      report_start: w.start + "T00:00:00Z",
      report_end  : w.end + "T23:59:59Z",
      limit       : SP_PAGE,
      fields      : SP_FIELDS
    };
    var report = _spGet("/ad_accounts/" + accountId + "/aggregate_reports", params, token);
    if (!report) return;
    (report.rows || []).forEach(onRow);
    continuation = report.continuation_token || null;
    if (!continuation) return;
    Utilities.sleep(200);
  }
}

// Fold one window's row for a campaign into its running lifetime total.
function _spMerge(agg, id, name, status, stats) {
  var a = agg[id];
  if (!a) a = agg[id] = { name: "", status: status, windows: 0,
                          sum: {}, wsum: {}, wgt: {}, last: {} };
  // The latest window wins for name and status: campaigns get renamed and
  // paused, and the current state is the one worth putting in the sheet.
  if (name) a.name = String(name);
  a.status = status;
  // A campaign shows up in every window of its account's history, most of them
  // with nothing but zeros. Only a window it actually delivered in counts —
  // otherwise every campaign would look like it spans the whole date range and
  // lose its unique metrics for nothing.
  var delivered = false;
  SP_FIELDS.forEach(function (f) {
    var v = stats[f];
    if (typeof v !== "number" || isNaN(v)) return;   // "" = not measured
    if (v > 0) delivered = true;
    a.last[f] = v;
    if (SP_AVG_FIELDS[f]) {
      var w = Number(stats[SP_AVG_FIELDS[f]]);
      if (w > 0) {
        a.wsum[f] = (a.wsum[f] || 0) + v * w;
        a.wgt[f]  = (a.wgt[f]  || 0) + w;
      }
    } else {
      a.sum[f] = (a.sum[f] || 0) + v;
    }
  });
  if (delivered) a.windows++;
}

// Lifetime value per field once every window has been merged.
//  A campaign that fits inside one window comes out exactly as Spotify
//  reported it; only campaigns that span windows go through the maths.
// ponytail: reach and listeners are per-window uniques — the same person in
// two windows is one person, so a multi-window campaign reports them blank
// rather than inflated. Only a per-campaign lifetime endpoint, which v3 does
// not expose, could fill them in.
function _spTotals(a) {
  var out = {};
  SP_FIELDS.forEach(function (f) {
    if (SP_AVG_FIELDS[f]) {
      out[f] = a.wgt[f] ? a.wsum[f] / a.wgt[f] : (f in a.last ? a.last[f] : "");
    } else if (SP_UNMERGEABLE_FIELDS[f] && a.windows > 1) {
      out[f] = "";
    } else {
      out[f] = (f in a.sum) ? a.sum[f] : "";
    }
  });
  return out;
}


// ============================================================
//  SELF-CHECK  —  run spSelfCheck() from the editor; calls no API.
// ============================================================
function spSelfCheck() {
  function ok(cond, msg) { if (!cond) throw new Error("spSelfCheck: " + msg); }

  var w = _spWindows("2025-01-01", "2026-09-07");
  ok(w[0].start === "2025-01-01", "first window starts at START_DATE");
  ok(w[w.length - 1].end === "2026-09-07", "last window ends today");
  w.forEach(function (win, i) {
    var days = (Date.parse(win.end) - Date.parse(win.start)) / 86400000 + 1;
    ok(days <= 89, "window " + i + " spans " + days + " days; Spotify caps at <90");
    if (i) ok(Date.parse(win.start) - Date.parse(w[i - 1].end) === 86400000,
              "window " + i + " starts the day after the previous one ends");
  });
  ok(_spWindows("2025-01-01", "2025-01-01").length === 1, "a single day is one window");

  var one = {};
  _spMerge(one, "c1", "Campaign", "ACTIVE",
           { SPEND: 100, IMPRESSIONS: 1000, CLICKS: 10, CTR: 1, REACH: 400 });
  var t1 = _spTotals(one.c1);
  ok(t1.SPEND === 100 && t1.REACH === 400 && t1.CTR === 1,
     "a single window passes Spotify's own numbers through untouched");
  ok(t1.STREAMS === "", "a field the account never reported stays blank");

  var two = {};
  _spMerge(two, "c1", "Campaign", "ACTIVE",
           { SPEND: 100, IMPRESSIONS: 1000, CLICKS: 10, CTR: 1, REACH: 400 });
  _spMerge(two, "c1", "Campaign v2", "PAUSED",
           { SPEND: 50, IMPRESSIONS: 3000, CLICKS: 60, CTR: 2, REACH: 900 });
  var t2 = _spTotals(two.c1);
  ok(t2.SPEND === 150 && t2.IMPRESSIONS === 4000 && t2.CLICKS === 70,
     "counters add up across windows");
  ok(t2.CTR === (1 * 1000 + 2 * 3000) / 4000, "rates re-average weighted by volume");
  ok(t2.REACH === "", "unique reach is blanked, not double-counted");
  ok(two.c1.name === "Campaign v2" && two.c1.status === "PAUSED",
     "the latest window's name and status win");

  var accts = _spParseAccounts("11111111-2222-3333-4444-555555555555 = Main Account , abc-1 =");
  ok(accts.length === 2, "one entry per comma-separated account");
  ok(accts[0].id === "11111111-2222-3333-4444-555555555555" && accts[0].name === "Main Account",
     "ids and names are trimmed");
  ok(accts[1].name === "abc", "an account with no name falls back to the id's first block");
  ok(_spParseAccounts("").length === 0, "an empty property yields no accounts");

  var flight = function (start, end, open) { return { start: start, end: end, open: !!open }; };
  ok(_spState("ACTIVE", flight("2026-01-01", "2026-03-31"), "2026-09-07") === "ENDED",
     "a campaign whose flight is over reads ENDED, not ACTIVE");
  ok(_spState("ACTIVE", flight("2026-12-01", ""), "2026-09-07") === "SCHEDULED",
     "a campaign that has not started yet reads SCHEDULED");
  ok(_spState("ACTIVE", flight("2026-08-01", "2026-09-30"), "2026-09-07") === "ACTIVE",
     "a campaign in flight stays ACTIVE");
  ok(_spState("ACTIVE", flight("2026-01-01", "", true), "2026-09-07") === "ACTIVE",
     "an open-ended campaign never reads ENDED");
  ok(_spState("ACTIVE", flight("2026-01-01", "2026-09-07"), "2026-09-07") === "ACTIVE",
     "a campaign ending today is still running today");
  ok(_spState("PAUSED", flight("2026-01-01", "2026-03-31"), "2026-09-07") === "PAUSED",
     "Spotify's own status wins whenever the campaign is not ACTIVE");
  ok(_spState("ACTIVE", flight("", "", false), "2026-09-07") === "ACTIVE",
     "a campaign with no ad sets keeps Spotify's status");

  Logger.log("spSelfCheck: all checks passed.");
}

// ============================================================
//  INSPECT  —  run spInspect() from the editor
// ============================================================
//  Logs one raw campaign object and one raw report row from the first
//  account. This is how you find out what a blank column means: whether
//  Spotify returns the field at all, and which status values it uses.
function spInspect() {
  var token = _spAccessToken();
  var acct = _spAccounts()[0];

  var list = _spGet("/ad_accounts/" + acct.id + "/campaigns", { limit: 3 }, token);
  var campaigns = (list && list.campaigns) || [];
  Logger.log("Raw campaign object:\n" + JSON.stringify(campaigns[0] || null, null, 2));
  Logger.log("Statuses on this page: " + JSON.stringify(campaigns.map(function (c) {
    return c.status;
  })));

  var sets = _spGet("/ad_accounts/" + acct.id + "/ad_sets", { limit: 3 }, token);
  Logger.log("Raw ad set object:\n" +
             JSON.stringify(((sets && sets.ad_sets) || [])[0] || null, null, 2));

  var ads = _spGet("/ad_accounts/" + acct.id + "/ads", { limit: 3 }, token);
  Logger.log("Raw ad object:\n" +
             JSON.stringify(((ads && ads.ads) || [])[0] || null, null, 2));

  // The same report at each level. Reach and listeners are per-entity uniques,
  // so an account that reports nothing for a campaign may still report them for
  // its ad sets or ads — and an entity type the API refuses logs its own 400.
  var windows = _spWindows(SP.START_DATE, todayUTC());
  var w = windows[windows.length - 1];
  ["CAMPAIGN", "AD_SET", "AD"].forEach(function (level) {
    var report = _spGet("/ad_accounts/" + acct.id + "/aggregate_reports", {
      entity_type : level,
      granularity : "LIFETIME",
      report_start: w.start + "T00:00:00Z",
      report_end  : w.end + "T23:59:59Z",
      limit       : 3,
      fields      : SP_FIELDS
    }, token);
    if (!report) return;                       // _spGet already logged the body
    var rows = report.rows || [];
    Logger.log(level + ": " + rows.length + " rows in " + w.start + "..." + w.end +
               " | fields returned: " + JSON.stringify(
                 ((rows[0] || {}).stats || []).map(function (x) { return x.field_type; })));
    Logger.log(level + " row:\n" + JSON.stringify(rows[0] || null, null, 2));
  });
}


// ============================================================
//  TRIGGER
// ============================================================
function spCreateDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "spDailyPull") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("spDailyPull").timeBased().everyDays(1).atHour(6).create();
  Logger.log("Spotify daily trigger set (06:00 script timezone).");
}
