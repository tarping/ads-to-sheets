# Troubleshooting

Every error below was hit while building and running these scripts. Read the **Executions**
log in the Apps Script editor first — the pullers log a specific message for each failure
path rather than throwing a generic error.

---

## Apps Script project errors

### `SyntaxError: Identifier 'META' has already been declared`

The same file is in the project twice, or was pasted into one file twice. All `.gs` files
share a single global scope, so a duplicate `var`/`const` at top level collides before any
code runs.

Search the whole project (Ctrl/Cmd + F) for `var META` / `var GADS` / `var TT` — each
should appear exactly once. Delete the extra file.

### A fix you just made has no effect

Two causes, both common:

1. **The file wasn't saved.** Apps Script runs the last *saved* version. Press
   Ctrl/Cmd + S.
2. **A second copy of the old code is still in the project.** Unlike duplicate `var`
   declarations, duplicate *functions* don't error — whichever loads last silently wins. So
   an old `gadsFullPull` in another file can shadow your updated one.

Search the project for the exact string from the error message. If it appears somewhere you
didn't just edit, that's your culprit.

### `ReferenceError: getSecret is not defined` (or `upsertRows`, `todayUTC`, `parseCampaignName`)

`shared.gs` is missing from the project. Every platform file depends on it.

### `Missing Script Property: GADS_CLIENT_ID`

Exactly what it says — add it under **Project Settings → Script Properties**. This error is
deliberate: the scripts refuse to run with missing credentials rather than failing
obscurely later.

---

## Google authorization errors

These happen during the consent popup, before your code runs.

### `Error 403: access_denied` — "app is currently being tested"

Your Cloud project's OAuth consent screen is in **Testing** mode, and the account you're
signing in with isn't on its tester list.

Fix it by publishing: **Cloud Console → APIs & Services → OAuth consent screen →
Publish App**. Status must read *In production*. No Google review is required for personal
use.

Adding yourself as a test user also clears the error, but **refresh tokens issued in
Testing mode expire after 7 days**, so your daily sync dies a week later. Publish instead.

### "This app is blocked" — Google blocked this access

A hard block, not the click-through warning. Usual causes:

- **Workspace-managed account.** Your domain admin blocks unverified third-party apps. The
  admin can whitelist it in **Admin Console → Security → Access and data control → API
  controls → App access control**, or you can use a personal Gmail that has access to the
  ad account instead.
- **Advanced Protection Program.** No bypass exists; use a different account.
- **Neither applies.** Sign in as the Cloud project's own owner, confirm the consent screen
  is External + In production with the `adwords` scope declared, and retry in an incognito
  window — cached denials can re-trigger the block.

If it keeps blocking, stop fighting it and switch to
`google-ads-script/google-ads-native.js`, which needs no OAuth at all.

### "Google hasn't verified this app"

Expected for personal scripts. Click **Advanced → Go to *(project)* (unsafe) → Allow**. It's
your own code accessing your own data.

---

## Meta API errors

### `(#100) Tried accessing nonexisting field (campaigns)`

`AD_ACCOUNT_ID` is missing the `act_` prefix. It must read `act_1234567890`, not
`1234567890`.

### `Object with ID '…' does not exist, cannot be loaded due to missing permissions`

The account ID is wrong, or your token has no access to it. Meta ad account IDs are
typically 15 digits — if yours is much shorter, you probably copied a page or business ID
by mistake. Confirm it in Ads Manager under the account name.

If the ID is right, assign the ad account to your System User in Business Settings with
*View Performance*, then regenerate the token.

### `Error validating access token: Session has expired`

Graph API Explorer tokens last ~60 days. Switch to a System User token, which doesn't
expire — see [meta.md](meta.md).

### Results column shows an unexpected metric

Meta reports dozens of action types per campaign and the script picks the one matching the
campaign's objective, then falls back through pixel conversions, leads, landing page views,
clicks and engagement.

To see the raw data, set `SEARCH` inside `metaDebugCampaign()` to part of the campaign name
and run it. The log prints every action type, its value, and which one was picked — then
adjust `META_OBJECTIVE_TO_ACTION` or the fallback order in `_metaGetPrimaryResult()`.

---

## Google Ads API errors

### `UNRECOGNIZED_FIELD: Unrecognized field in the query: 'metrics.video_views'`

That field doesn't exist in recent API versions. Use `metrics.video_trueview_views` (and
read it as `videoTrueviewViews` in the camelCase JSON response). The scripts in this repo
already do.

Generally: if a field name is rejected, check it against the [GAQL field
reference](https://developers.google.com/google-ads/api/fields/v23/campaign) for the API
version in your config. Field names change between versions.

### `USER_PERMISSION_DENIED`

Usually `LOGIN_CUSTOMER_ID` doesn't reflect how your user actually reaches the account.
Set it to the MCC that links the ad account (digits only), or to `CUSTOMER_ID` itself if
there's no MCC.

Also check that the developer token belongs to *that* MCC — a token from a different
manager account won't work.

### `Google Ads auth failed: invalid_grant`

The refresh token is dead. Either the client secret was reset after the token was minted
(they're bound together), or it was issued in Testing mode and hit the 7-day expiry, or
access was revoked. Mint a new one — [google-ads.md](google-ads.md) step 3.

### `DEVELOPER_TOKEN_NOT_APPROVED`

Your developer token still has test-account-only access. Apply for **Basic access** in the
MCC's API Center.

### The API returns 0 rows but reports a campaign count

The log line `0 campaigns with delivery, 1061 total in account` means auth is fine and the
metrics query failed or matched nothing. Scroll up for an `❌ Google Ads API HTTP 400` line
— the real error is there, usually a bad field name.

---

## TikTok API errors

### `TikTok API error: Access token is invalid`

Token wrong, revoked, or from a different app. Regenerate it — [tiktok.md](tiktok.md).

### `TikTok API error: No permission for this advertiser`

That advertiser account wasn't ticked during the authorization step. Redo the advertiser
authorization and select it.

---

## Data looks wrong

### Rows exist but `Date Pulled` is old

Working as designed. A campaign whose spend and status haven't changed is skipped entirely
and keeps its previous `Date Pulled`, which makes that column a free "last changed" marker.
It is not a "last checked" timestamp.

### A campaign disappeared from the sheet

It shouldn't — nothing is ever deleted except by a full pull that returns fewer campaigns.
Check whether someone ran `metaFullPull`/`gadsFullPull`/`ttFullPull` (rebuild mode) rather
than the daily pull, and whether the campaign was removed (not just paused) in the platform,
since the queries exclude `REMOVED` campaigns.

### Paused campaigns show stale metrics

By design. When a campaign stops appearing in the report, its metrics are frozen at the last
known lifetime totals and only the status flips to `PAUSED`. This preserves historic spend
that the platform stops returning.

### Lifetime totals changed retroactively

Normal. All three platforms restate recent data as conversions attribute late and invalid
traffic is refunded — usually within a 7-day window. The daily pull refetches lifetime
totals precisely so these corrections land in the sheet.
