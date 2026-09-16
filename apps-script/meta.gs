// ============================================================
//  META ADS → GOOGLE SHEETS  |  Lifetime campaign puller
//
//  One row per campaign, lifetime metrics since START_DATE,
//  matched by Campaign ID and updated in place.
//
//  Uses ONE account-level insights call (level=campaign), so a
//  whole account costs 2–3 HTTP requests regardless of how many
//  campaigns it has — no batching, no resume triggers.
//
//  Required Script Property:  META_ACCESS_TOKEN
//  Docs: docs/meta.md
//
//  Functions:
//    metaFullPull           run once — rebuilds the whole tab
//    metaDailyPull          daily trigger — updates what changed
//    metaCreateDailyTrigger arms the 03:00 daily run
//    metaDebugCampaign      dump one campaign's raw actions
// ============================================================

var META = {
  AD_ACCOUNT_ID: "act_XXXXXXXXXXXXXXX",   // ← your ad account id, WITH the act_ prefix
  SHEET_NAME   : "Meta Campaigns",
  START_DATE   : "2025-01-01",            // ← earliest date to include
  API_VERSION  : "v23.0"
};

var META_HEADERS = [
  "Date Pulled",
  "Project Number", "Artist", "Release", "Objective", "Segment", "PM", "Mes",
  // ↑ from parseCampaignName()
  "Campaign Name (raw)", "Campaign ID", "Objective (Meta)",
  "Status", "Effective Status",
  "Impressions", "Reach", "Spend", "Link Clicks",
  "Results", "Result Type", "Cost per Result", "Post Engagement"
];
var META_NUM_COLS   = META_HEADERS.length; // owns columns A–U
var META_COL_ID     = 9;   // column J
var META_COL_STATUS = 12;  // column M
var META_COL_SPEND  = 15;  // column P

// Which action Meta counts as "the result" for each campaign objective.
var META_OBJECTIVE_TO_ACTION = {
  "BRAND_AWARENESS"      : "reach",
  "REACH"                : "reach",
  "LINK_CLICKS"          : "link_click",
  "TRAFFIC"              : "link_click",
  "POST_ENGAGEMENT"      : "post_engagement",
  "PAGE_LIKES"           : "like",
  "VIDEO_VIEWS"          : "video_view",
  "LEAD_GENERATION"      : "lead",
  "LEADS"                : "lead",
  "APP_INSTALLS"         : "app_install",
  "APP_PROMOTION"        : "app_install",
  "CONVERSIONS"          : "offsite_conversion.fb_pixel_purchase",
  "OUTCOME_SALES"        : "offsite_conversion.fb_pixel_purchase",
  "OUTCOME_LEADS"        : "lead",
  "OUTCOME_TRAFFIC"      : "link_click",
  "OUTCOME_ENGAGEMENT"   : "post_engagement",
  "OUTCOME_APP_PROMOTION": "app_install",
  "OUTCOME_AWARENESS"    : "reach",
  "MESSAGES"             : "onsite_conversion.messaging_conversation_started_7d"
};


// ============================================================
//  ENTRY POINTS
// ============================================================
function metaFullPull()  { _metaRun(true);  }
function metaDailyPull() { _metaRun(false); }

function _metaRun(rebuild) {
  var token    = getSecret("META_ACCESS_TOKEN");
  var today    = todayUTC();
  var sheet    = getOrCreateSheet(META.SHEET_NAME, META_HEADERS, "#1a1a2e");
  var meta     = _metaFetchCampaignMeta(token);      // id → name/status/objective
  var insights = _metaFetchInsights(token, today);   // one row per delivering campaign
  var convMap  = _metaFetchCustomConversions(token); // custom conversion id → name

  var fresh = {};
  insights.forEach(function (ins) {
    var id = String(ins.campaign_id);
    var m  = meta[id] || {};
    fresh[id] = {
      row   : _metaBuildRow(today, id, m, ins, convMap),
      status: m.effective_status || ""
    };
  });

  // Campaigns with zero delivery in range still get their live status stamped.
  var statusOnly = {};
  Object.keys(meta).forEach(function (id) {
    if (!fresh[id]) statusOnly[id] = meta[id].effective_status || meta[id].status || "PAUSED";
  });

  Logger.log("Meta: " + Object.keys(fresh).length + " campaigns with delivery, " +
             Object.keys(meta).length + " total in account.");
  upsertRows(sheet, META_NUM_COLS, META_COL_ID, META_COL_SPEND, META_COL_STATUS,
             fresh, "PAUSED", statusOnly, rebuild);
}


// ============================================================
//  FETCHERS
// ============================================================
function _metaFetchCampaignMeta(token) {
  var params = {
    fields          : "id,name,status,effective_status,objective",
    effective_status: JSON.stringify(["ACTIVE", "PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"]),
    limit           : "200",
    access_token    : token
  };
  var map = {};
  _metaPaginate(_metaUrl(META.AD_ACCOUNT_ID + "/campaigns", params), function (c) {
    map[String(c.id)] = c;
  });
  return map;
}

function _metaFetchInsights(token, until) {
  var params = {
    level       : "campaign",
    fields      : "campaign_id,campaign_name,impressions,reach,spend,actions," +
                  "cost_per_action_type,conversions,cost_per_conversion",
    time_range  : JSON.stringify({ since: META.START_DATE, until: until }),
    limit       : "100",
    access_token: token
  };
  var out = [];
  _metaPaginate(_metaUrl(META.AD_ACCOUNT_ID + "/insights", params), function (r) { out.push(r); });
  return out;
}

function _metaFetchCustomConversions(token) {
  var map = {};
  var params = { fields: "id,name", limit: "100", access_token: token };
  _metaPaginate(_metaUrl(META.AD_ACCOUNT_ID + "/customconversions", params), function (cc) {
    map["offsite_conversion.custom." + cc.id] = cc.name;
  });
  return map;
}

function _metaUrl(path, params) {
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
  }).join("&");
  return "https://graph.facebook.com/" + META.API_VERSION + "/" + path + "?" + qs;
}

function _metaPaginate(url, onItem) {
  while (url) {
    try {
      var res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var data = JSON.parse(res.getContentText());
      if (data.error) {
        Logger.log("Meta API error: " + JSON.stringify(data.error));
        return;
      }
      (data.data || []).forEach(onItem);
      url = (data.paging && data.paging.next) ? data.paging.next : null;
      if (url) Utilities.sleep(200);
    } catch (e) {
      Logger.log("Meta exception: " + e.message);
      return;
    }
  }
}


// ============================================================
//  RESULT SELECTION
//  Meta returns dozens of action types per campaign; this picks
//  the one a human would call "the result" and its unit cost.
// ============================================================
function _metaFriendlyResultType(actionType, customConvMap) {
  if (!actionType) return "";
  if (actionType.indexOf("offsite_conversion.custom.") === 0) {
    return customConvMap[actionType] || actionType;
  }
  var labels = {
    "offsite_conversion.fb_pixel_purchase"               : "Purchase (Pixel)",
    "offsite_conversion.fb_pixel_lead"                   : "Lead (Pixel)",
    "offsite_conversion.fb_pixel_add_to_cart"            : "Add to Cart",
    "offsite_conversion.fb_pixel_view_content"           : "View Content",
    "offsite_conversion.fb_pixel_initiate_checkout"      : "Checkout",
    "offsite_conversion.fb_pixel_custom"                 : "Custom Pixel Event",
    "lead"                                               : "Lead",
    "offsite_complete_registration_add_meta_leads"       : "Meta Lead (Registration)",
    "offsite_content_view_add_meta_leads"                : "Meta Lead (View)",
    "offsite_search_add_meta_leads"                      : "Meta Lead (Search)",
    "onsite_conversion.lead_grouped"                     : "Lead (Onsite)",
    "link_click"                                         : "Link Click",
    "landing_page_view"                                  : "Landing Page View",
    "omni_landing_page_view"                             : "Landing Page View",
    "video_view"                                         : "Video View",
    "post_engagement"                                    : "Post Engagement",
    "page_engagement"                                    : "Page Engagement",
    "post_reaction"                                      : "Post Reaction",
    "comment"                                            : "Comment",
    "post"                                               : "Share",
    "app_install"                                        : "App Install",
    "like"                                               : "Page Like",
    "reach"                                              : "Reach",
    "onsite_conversion.messaging_conversation_started_7d": "Messenger Conversation",
    "call_confirm_grouped"                               : "Call Confirmed",
    "click_to_call_call_confirm"                         : "Click to Call"
  };
  return labels[actionType] || actionType;
}

function _metaGetAction(actions, type) {
  if (!actions) return 0;
  var match = actions.find(function (a) { return a.action_type === type; });
  return match ? parseFloat(match.value || 0) : 0;
}

function _metaGetCostPerAction(costArr, type) {
  if (!costArr) return "";
  var match = costArr.find(function (a) { return a.action_type === type; });
  return match ? parseFloat(parseFloat(match.value || 0).toFixed(4)) : "";
}

function _metaCleanConvName(actionType) {
  if (!actionType) return "";
  var idx = actionType.indexOf("fb_pixel_custom.");
  if (idx >= 0) return actionType.substring(idx + "fb_pixel_custom.".length);
  if (actionType.indexOf("offsite_conversion.fb_pixel_") === 0) {
    return actionType.replace("offsite_conversion.fb_pixel_", "").replace(/_/g, " ");
  }
  return actionType;
}

function _metaFindCost(costArr, type) {
  if (!costArr) return null;
  var m = costArr.find(function (c) { return c.action_type === type; });
  return m ? parseFloat(parseFloat(m.value || 0).toFixed(4)) : null;
}

function _metaGetPrimaryResult(objective, actions, costArr, customConvMap, spendVal, conversions, costPerConv) {
  if (!actions || actions.length === 0) return { value: 0, type: "", cost: 0 };

  function makeResult(type) {
    var val = _metaGetAction(actions, type);
    if (val <= 0) return null;
    var cost = _metaGetCostPerAction(costArr, type);
    if (cost === "" || cost === null || isNaN(cost)) {
      cost = (spendVal && val > 0) ? parseFloat((spendVal / val).toFixed(4)) : 0;
    }
    return { value: val, type: _metaFriendlyResultType(type, customConvMap), cost: cost };
  }

  var isConversionObj = (objective === "OUTCOME_SALES" || objective === "CONVERSIONS" ||
                         objective === "OUTCOME_LEADS" || objective === "PRODUCT_CATALOG_SALES");

  // Conversion campaigns: prefer the named pixel events in `conversions`.
  if (isConversionObj && conversions && conversions.length > 0) {
    var clickConvs = conversions.filter(function (c) {
      return /click/i.test(c.action_type) && parseFloat(c.value || 0) > 0;
    });
    var chosen = null;
    if (clickConvs.length > 0) {
      chosen = clickConvs.reduce(function (a, b) {
        return parseFloat(a.value || 0) > parseFloat(b.value || 0) ? a : b;
      });
    } else {
      chosen = conversions.reduce(function (a, b) {
        return parseFloat(a.value || 0) > parseFloat(b.value || 0) ? a : b;
      });
    }
    if (chosen && parseFloat(chosen.value || 0) > 0) {
      var cVal = parseFloat(chosen.value);
      var cCost = _metaFindCost(costPerConv, chosen.action_type);
      if (cCost === null) cCost = (spendVal && cVal > 0) ? parseFloat((spendVal / cVal).toFixed(4)) : 0;
      return { value: cVal, type: _metaCleanConvName(chosen.action_type), cost: cCost };
    }
  }

  var actionType = META_OBJECTIVE_TO_ACTION[objective] || null;
  var r;

  // 1. The objective's own action ("reach" is handled by the row builder).
  if (actionType && actionType !== "reach") { r = makeResult(actionType); if (r) return r; }

  // 2. Custom conversions — highest volume wins.
  var customActions = actions.filter(function (a) {
    return a.action_type.indexOf("offsite_conversion.custom.") === 0 && parseFloat(a.value || 0) > 0;
  });
  if (customActions.length > 0) {
    var best = customActions.reduce(function (a, b) {
      return parseFloat(a.value || 0) > parseFloat(b.value || 0) ? a : b;
    });
    var bestVal = parseFloat(best.value);
    var bestCost = _metaGetCostPerAction(costArr, best.action_type);
    if (bestCost === "" || bestCost === null || isNaN(bestCost)) {
      bestCost = (spendVal && bestVal > 0) ? parseFloat((spendVal / bestVal).toFixed(4)) : 0;
    }
    return { value: bestVal, type: _metaFriendlyResultType(best.action_type, customConvMap), cost: bestCost };
  }

  // 3–9. Fall back through pixel events, leads, traffic, video, calls, engagement.
  r = makeResult("offsite_conversion.fb_pixel_custom"); if (r) return r;

  var pixelTypes = ["offsite_conversion.fb_pixel_purchase", "offsite_conversion.fb_pixel_lead",
                    "offsite_conversion.fb_pixel_initiate_checkout", "offsite_conversion.fb_pixel_add_to_cart",
                    "offsite_conversion.fb_pixel_view_content"];
  for (var i = 0; i < pixelTypes.length; i++) { r = makeResult(pixelTypes[i]); if (r) return r; }

  var leadTypes = ["lead", "offsite_complete_registration_add_meta_leads",
                   "offsite_search_add_meta_leads", "onsite_conversion.lead_grouped"];
  for (var j = 0; j < leadTypes.length; j++) { r = makeResult(leadTypes[j]); if (r) return r; }

  r = makeResult("landing_page_view");      if (r) return r;
  r = makeResult("omni_landing_page_view"); if (r) return r;
  r = makeResult("link_click");             if (r) return r;
  r = makeResult("video_view");             if (r) return r;
  r = makeResult("call_confirm_grouped");   if (r) return r;
  r = makeResult("post_engagement");        if (r) return r;

  return { value: 0, type: "", cost: 0 };
}


// ============================================================
//  ROW BUILDER
// ============================================================
function _metaBuildRow(today, campaignId, meta, insights, customConvMap) {
  var name     = meta.name || insights.campaign_name || "";
  var parsed   = parseCampaignName(name);
  var actions  = insights.actions || [];
  var costs    = insights.cost_per_action_type || [];
  var reachVal = parseInt(insights.reach || 0);
  var spendVal = parseFloat(insights.spend || 0);

  var isReach = (meta.objective === "REACH" || meta.objective === "BRAND_AWARENESS" ||
                 meta.objective === "OUTCOME_AWARENESS");

  var result;
  if (isReach && reachVal > 0) {
    // Awareness campaigns report reach, and their unit cost is CPM.
    result = {
      value: reachVal,
      type : "Reach",
      cost : parseFloat(((spendVal / reachVal) * 1000).toFixed(4))
    };
  } else {
    result = _metaGetPrimaryResult(meta.objective, actions, costs, customConvMap, spendVal,
                                   insights.conversions || [], insights.cost_per_conversion || []);
  }

  return [
    today,
    parsed.field1, parsed.field2, parsed.field3, parsed.field4, parsed.field5,
            parsed.field6, parsed.field7,
    name,
    campaignId,
    meta.objective        || "",
    meta.status           || "",
    meta.effective_status || "",
    parseInt(insights.impressions || 0),
    reachVal,
    parseFloat(spendVal.toFixed(2)),
    _metaGetAction(actions, "link_click"),
    result.value || 0,
    result.type  || "",
    (result.cost === "" || result.cost === null || isNaN(result.cost)) ? 0 : result.cost,
    _metaGetAction(actions, "post_engagement")
  ];
}


// ============================================================
//  DEBUG — see every action type Meta returns for one campaign
// ============================================================
function metaDebugCampaign() {
  var SEARCH = "";   // ← put part of a campaign name here
  if (!SEARCH) { Logger.log("Set SEARCH to part of a campaign name first."); return; }

  var token = getSecret("META_ACCESS_TOKEN");
  var meta  = _metaFetchCampaignMeta(token);
  var id    = Object.keys(meta).find(function (k) { return meta[k].name.indexOf(SEARCH) >= 0; });
  if (!id) { Logger.log("No campaign matching: " + SEARCH); return; }

  var ins = _metaFetchInsights(token, todayUTC()).find(function (r) {
    return String(r.campaign_id) === id;
  });
  Logger.log("Campaign: " + meta[id].name + " | Objective: " + meta[id].objective);
  if (!ins) { Logger.log("No delivery in range."); return; }

  Logger.log("Spend: " + ins.spend);
  ["actions", "cost_per_action_type", "conversions", "cost_per_conversion"].forEach(function (f) {
    Logger.log("=== " + f + " ===");
    (ins[f] || []).forEach(function (a) { Logger.log(a.action_type + " = " + a.value); });
  });

  var result = _metaGetPrimaryResult(meta[id].objective, ins.actions || [],
    ins.cost_per_action_type || [], _metaFetchCustomConversions(token),
    parseFloat(ins.spend || 0), ins.conversions || [], ins.cost_per_conversion || []);
  Logger.log("PICKED → " + result.value + " | " + result.type + " | " + result.cost);
}


// ============================================================
//  TRIGGER
// ============================================================
function metaCreateDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "metaDailyPull") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("metaDailyPull").timeBased().everyDays(1).atHour(3).create();
  Logger.log("Meta daily trigger set (03:00 script timezone).");
}
