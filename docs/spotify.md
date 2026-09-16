# Getting Spotify Ads API credentials

You need three Script Properties — **`SPOTIFY_CLIENT_ID`**, **`SPOTIFY_CLIENT_SECRET`** and
**`SPOTIFY_REFRESH_TOKEN`** — plus the UUID of each ad account you want to pull, which is
best kept in a fourth one, **`SPOTIFY_ACCOUNTS`** (see step 4).

---

## 0. Read this before anything else

**The Spotify Ads API is partner-gated.** Unlike Meta, Google and TikTok, creating a
developer app is not enough: Spotify has to approve that app for Ads API access, and until
it does, every call in `spotify.gs` answers `403` no matter how correct your token is.

Access is granted through Spotify's advertising partner programme — in practice via your
Spotify advertising rep, or by applying at
[developer.spotify.com](https://developer.spotify.com/documentation/ads-api). Agencies,
reporting vendors and larger advertisers are the usual grantees; a self-serve Ad Studio
account on its own generally is not.

If you don't have that approval, nothing else on this page will work, and there is no
workaround inside Apps Script. Export from Ads Manager by hand until you do.

The other three pullers are unaffected — this one failing leaves their tabs alone.

---

## 1. Create the app

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and
   **Create app**.
2. For **Redirect URI**, any URL you control works — `https://example.com/callback` is
   fine, since you'll read the code out of the URL bar by hand. Add it and save; a URI not
   registered here is rejected at authorization time.
3. Note the **Client ID** and **Client Secret**.
4. Get that app approved for the Ads API (step 0). The client id you submit for approval
   must be the same one you use below.

---

## 2. Authorize, as a user with a role on the ad account

The token inherits the permissions of whoever signs in, so sign in as an account that can
already see the campaigns in Ads Manager.

Open this in a browser, with your own client id and redirect URI:

```
https://accounts.spotify.com/authorize
  ?client_id=YOUR_CLIENT_ID
  &response_type=code
  &redirect_uri=https%3A%2F%2Fexample.com%2Fcallback
```

(All on one line, no spaces.) Approve, and you're redirected to your redirect URI with
`?code=…` in the query string. Copy that code — it expires in a few minutes.

The Ads API is granted at the app level rather than through user scopes, so there is no
`scope` parameter to set here.

---

## 3. Exchange the code for a refresh token

```bash
curl -X POST 'https://accounts.spotify.com/api/token' \
  -u 'YOUR_CLIENT_ID:YOUR_CLIENT_SECRET' \
  -d 'grant_type=authorization_code' \
  -d 'code=THE_CODE_FROM_THE_REDIRECT' \
  -d 'redirect_uri=https://example.com/callback'
```

The response holds both tokens:

```json
{ "access_token": "…", "refresh_token": "…", "expires_in": 3600 }
```

Save the **`refresh_token`** as `SPOTIFY_REFRESH_TOKEN` in **Project Settings → Script
Properties**, alongside `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.

Ignore the access token: it lasts an hour, and `spotify.gs` mints a fresh one from the
refresh token on every run. The refresh token itself doesn't expire unless revoked, so this
is a one-time step.

---

## 4. Configure the ad accounts

Ad account IDs are UUIDs, not numbers. Find them in the Ads Manager URL, or by calling
`GET https://api-partner.spotify.com/ads/v3/ad_accounts` with a working access token.

Put them in a fourth Script Property, **`SPOTIFY_ACCOUNTS`**, as `uuid = Name` pairs
separated by commas:

```
11111111-2222-3333-4444-555555555555 = Main Account, a1b2c3d4-0000-0000-0000-000000000000 = Second Account
```

Set once, it survives every code update — you never paste an account id into the script
again — and real account ids stay out of a repo you can fork publicly.

If you'd rather keep them in the code, `SP.ACCOUNTS` at the top of `spotify.gs` is used
whenever the property is absent:

```js
var SP = {
  ACCOUNTS: [
    { id: "11111111-2222-3333-4444-555555555555", name: "Main Account" },
    { id: "a1b2c3d4-0000-0000-0000-000000000000", name: "Second Account" }
  ],
  ...
};
```

All accounts write into the same tab and are told apart by the **Account** column, using
the `name` you set here — that name is yours to choose. Each account's own billing currency
is pulled into the **Currency** column, so accounts on different currencies can share the
tab without their spend columns being silently comparable.

---

## Checking it works

Run `spFullPull` and read the execution log:

- `Spotify: 34 campaigns with data in range.` → working.
- `Spotify OAuth refresh failed: invalid_client` → wrong client id/secret pair.
- `Spotify OAuth refresh failed: invalid_grant` → the refresh token was revoked, or you
  saved the access token by mistake.
- `Spotify API 403 on /ad_accounts/…` → almost always the partner gate in step 0, not a bad
  account id. Read the logged response body; a permissions message names the account, an
  approval message doesn't.
- `Spotify API 400 … "The time range must be less than 90 days."` → shouldn't happen: the
  puller already splits `START_DATE`–today into 89-day windows (`SP_WINDOW_DAYS`). If you see
  it, something is sending a hand-built range.
- `Spotify API 404 on /ad_accounts/…` → the UUID is wrong, or the signed-in user has no
  role on that account.
- `0 campaigns with data in range` and no error → credentials fine, but nothing delivered
  inside `START_DATE`–today.

---

## The Status column

Spotify's `status` is the campaign's on/off switch, not whether it is delivering — a
campaign that finished months ago still reports `ACTIVE` until someone pauses it, which is
why an untouched account reads all-ACTIVE.

So the puller combines it with the flight dates it already reads from the ad sets:

| Spotify says | Flight | Column shows |
|---|---|---|
| not ACTIVE (PAUSED, ARCHIVED…) | anything | Spotify's own value, untouched |
| ACTIVE | starts in the future | `SCHEDULED` |
| ACTIVE | ended before today | `ENDED` |
| ACTIVE | running, or open-ended | `ACTIVE` |

A campaign with no ad sets has no flight and keeps Spotify's value. `_spState()` in
`spotify.gs` is the whole rule, and `spSelfCheck()` covers it.

---

## A note on metrics

`SP_FIELDS` at the top of `spotify.gs` lists what's requested: spend, impressions, reach,
frequency, clicks, CTR, streams, listeners, new listeners, video views and completion rate.
(`PAID_LISTENS` is deliberately absent: it comes back 0 for every campaign, and a column of
zeros reads as a measurement rather than as nothing.) The API offers ~50 fields; add the ones you want there and to `SP_COLUMNS`
and the row builder, in the same order.

Fields an account doesn't report come back blank rather than zero, so an empty cell reads
as "not measured" instead of "measured at nought" — which keeps them out of averages.

**Reach, listeners, new listeners and frequency come back blank on long campaigns.** The
report endpoint refuses any range of 90 days or more, so lifetime figures are stitched from
consecutive 89-day windows. Spend, impressions, clicks, streams, paid listens and video views
add up across windows; CTR and completion rate are re-averaged weighted by the volume behind
them. The unique counts can't be merged at all — someone reached in two windows is one
person, not two — so a campaign that ran across a window boundary leaves them empty instead
of inflated. Campaigns that fit inside one window keep Spotify's own numbers unchanged.

**Read the numbers against the Delivery Goal column.** Spotify reports every field for
every campaign, but an awareness campaign and a website-traffic campaign are not buying the
same thing, so their clicks are not comparable. The goal column tells you which figure the
campaign was actually optimising for: `AWARENESS` → impressions, `ENGAGEMENT_ON_SPOTIFY` →
streams, `VIDEO_VIEWS` → video views, `LEAD_GEN` → leads, `WEBSITE_TRAFFIC` and
`APP_PROMOTION` → clicks.

## Start and End Date

A Spotify campaign has no dates of its own — schedules live on its **ad sets** — so the
puller reads `/ad_accounts/{id}/ad_sets` and rolls them up: **Start Date** is the earliest
`start_time` across the campaign's ad sets, **End Date** the latest `end_time`.

**A blank End Date means the campaign is open-ended**, not that the date is missing. An ad
set with no `end_time` runs until someone stops it, and one such ad set makes the whole
campaign open-ended — so the column is left blank rather than showing the latest date among
the ad sets that *do* end, which would read as a campaign that has finished when it hasn't.

Both columns are trimmed to `YYYY-MM-DD`; the hour is never the interesting part of a
flight, and dates sort and filter better in a sheet than timestamps.

One wrinkle from the upsert engine: it decides a row has changed by comparing **spend and
status**, so a flight date edited with no new spend won't rewrite the row until spend next
moves. In practice a campaign whose end date is being extended is still spending, so this
resolves itself on the following run.

---

## A note on spend units

**Check spend against Ads Manager on your first pull.** Spotify's docs don't state the unit
of the `SPEND` report field, and this puller writes it through unchanged.

There is one piece of evidence, and it points the other way: ad set budgets in the same API
are returned as `budget.micro_amount` — micros, a millionth of a currency unit, the same
convention Google Ads uses for `cost_micros`. Reporting endpoints often return plain
decimals even when the object model uses micros, so this is a hint rather than an answer.

If your sheet shows spend 1 000 000× the Ads Manager figure, that hint was right: divide
`stats.SPEND` by `1e6` in the row builder. Nothing else in the report is affected.
