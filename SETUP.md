# Setup guide

Start to finish this takes about 20 minutes if you already have API access to your ad
accounts, and considerably longer if you don't — most of the time is spent getting
credentials out of Meta, Google, TikTok and Spotify, not on the scripts themselves.

Spotify is the exception to the 20 minutes: its Ads API is partner-gated, so the wait is on
Spotify approving your app, not on you. Read [docs/spotify.md](docs/spotify.md) first.

Work through it platform by platform. Each one is independent, so a Meta-only setup is
perfectly valid — skip the sections you don't need.

---

## 1. Create the spreadsheet and the script project

1. Create a new Google Sheet. Name it whatever you like; the scripts create their own tabs.
2. **Extensions → Apps Script**. This opens an Apps Script project bound to the sheet.
3. Delete the default `Code.gs` content.
4. Create one script file per puller (the **+** next to "Files" → *Script*) and paste in
   the matching file from `apps-script/`:

   | Script file name | Paste from | Required? |
   |---|---|---|
   | `shared` | `apps-script/shared.gs` | **Yes — always** |
   | `meta` | `apps-script/meta.gs` | only if you use Meta |
   | `google-ads` | `apps-script/google-ads.gs` | only if you use Google Ads |
   | `tiktok` | `apps-script/tiktok.gs` | only if you use TikTok |
   | `spotify` | `apps-script/spotify.gs` | only if you use Spotify |

   Apps Script adds the `.gs` extension itself — name the files without it.

5. **Save** (Ctrl/Cmd + S). Apps Script runs the last *saved* version, so unsaved edits
   silently do nothing.

> **One project, one copy of each file.** All `.gs` files share a single global scope. Two
> copies of the same file produce `Identifier 'META' has already been declared`, and
> duplicated *functions* don't error at all — the last one loaded silently wins. If a fix
> you just made appears to have no effect, search the whole project for the old code.

Set the project timezone while you're here: **Project Settings → Time zone**. Trigger hours
are interpreted in it.

---

## 2. Store your API tokens

**Project Settings (⚙) → Script Properties → Add script property.**

Add only the ones for platforms you're using:

| Property | Platform | How to get it |
|---|---|---|
| `META_ACCESS_TOKEN` | Meta | [docs/meta.md](docs/meta.md) |
| `GADS_DEVELOPER_TOKEN` | Google Ads | [docs/google-ads.md](docs/google-ads.md) |
| `GADS_CLIENT_ID` | Google Ads | [docs/google-ads.md](docs/google-ads.md) |
| `GADS_CLIENT_SECRET` | Google Ads | [docs/google-ads.md](docs/google-ads.md) |
| `GADS_REFRESH_TOKEN` | Google Ads | [docs/google-ads.md](docs/google-ads.md) |
| `TIKTOK_ACCESS_TOKEN` | TikTok | [docs/tiktok.md](docs/tiktok.md) |
| `SPOTIFY_CLIENT_ID` | Spotify | [docs/spotify.md](docs/spotify.md) |
| `SPOTIFY_CLIENT_SECRET` | Spotify | [docs/spotify.md](docs/spotify.md) |
| `SPOTIFY_REFRESH_TOKEN` | Spotify | [docs/spotify.md](docs/spotify.md) |
| `SPOTIFY_ACCOUNTS` (optional) | Spotify | [docs/spotify.md](docs/spotify.md) |

Script Properties are private to the project and never appear in the source, which is what
keeps this repo safe to fork publicly. Don't move them back into the code.

---

## 3. Configure each puller

Every platform file opens with a config block. These hold account IDs and dates only — no
secrets.

### Meta — `meta.gs`

```js
var META = {
  AD_ACCOUNT_ID: "act_XXXXXXXXXXXXXXX",   // WITH the act_ prefix
  SHEET_NAME   : "Meta Campaigns",
  START_DATE   : "2025-01-01",
  API_VERSION  : "v23.0"
};
```

The `act_` prefix is mandatory. Without it every call fails with
`Tried accessing nonexisting field (campaigns)`. Find the number in Ads Manager under the
account name, or in the URL as `act=…`.

### Google Ads — `google-ads.gs`

```js
var GADS = {
  CUSTOMER_ID      : "0000000000",   // the ad account you pull FROM
  LOGIN_CUSTOMER_ID: "0000000000",   // the MCC it sits under
  ...
};
```

Digits only, no dashes. `LOGIN_CUSTOMER_ID` is the **manager (MCC) account** you reach the
ad account through — it's sent as the `login-customer-id` header. If the account isn't
under an MCC, set it to the same value as `CUSTOMER_ID`.

### TikTok — `tiktok.gs`

```js
var TT = {
  ADVERTISERS: [
    { id: "0000000000000000000", name: "Main Account" }
  ],
  ...
};
```

Multiple advertiser accounts can share one tab — add more entries and they're
distinguished by the `Account` column.

### Spotify — `spotify.gs`

```js
var SP = {
  ACCOUNTS: [
    { id: "11111111-2222-3333-4444-555555555555", name: "Main Account" }
  ],
  ...
};
```

Spotify ad account IDs are UUIDs, not numbers. As with TikTok, several accounts share one
tab and are told apart by the `Account` column — and each one's billing currency is written
to its own `Currency` column, so mixed-currency tabs stay readable.

### Campaign naming — `shared.gs`

`parseCampaignName()` splits campaign names into seven columns. The default expects
underscore-separated names:

```
"PRJ-1042_Nova Cascade_Summer EP_In feed Display_Streaming_Ana_Junho 2026"
 │        │             │          │               │         │     └ Mes
 │        │             │          │               │         └ PM
 │        │             │          │               └ Segment
 │        │             │          └ Objective
 │        │             └ Release
 │        └ Artist
 └ Project Number
```

Names that don't follow it cost nothing: the missing segments come back blank, the raw
name is kept in its own column, and the metrics land in the sheet either way.

Change the split character and the field comments to match your convention, then rename
the matching entries in each `*_HEADERS` array. If you don't name campaigns
systematically, delete those seven columns from the headers and row builders.

`START_DATE` should be the earliest date you want included. It's a lifetime window: every
run refetches totals from that date to today.

---

## 4. First run

Run each platform's **full pull** once, from the function dropdown in the editor toolbar:

| Platform | Run this | Verify first with |
|---|---|---|
| Meta | `metaFullPull` | — |
| Google Ads | `gadsFullPull` | `gadsDebugAuth` |
| TikTok | `ttFullPull` | — |
| Spotify | `spFullPull` | — |

For Google Ads, always run `gadsDebugAuth` first — it tests the token *and* API access
separately, which makes a permissions problem obvious before you debug the wrong thing.

**The first run asks for authorization.** Apps Script needs permission to call external
APIs, edit the spreadsheet and manage triggers. Pick the Google account that owns the
sheet, then — because your script isn't a Google-verified app — click
**Advanced → Go to *(project name)* (unsafe) → Allow**. That warning is normal for personal
scripts; you're approving your own code.

Open **Executions** (left sidebar) to read the logs. A healthy Meta run looks like:

```
Sheet created: Meta Campaigns
Meta: 47 campaigns with delivery, 63 total in account.
Upsert done — updated: 0 | new: 47 | unchanged: 0 | status refreshed: 16 | total rows: 47
```

If you see `0 campaigns with delivery` alongside a non-zero account total, the credentials
work but something's off with the account ID or date range — see
[docs/troubleshooting.md](docs/troubleshooting.md).

---

## 5. Automate it

Run each of these once to arm the daily triggers:

| Function | Runs at |
|---|---|
| `metaCreateDailyTrigger` | 03:00 |
| `gadsCreateDailyTrigger` | 04:00 |
| `ttCreateDailyTrigger` | 05:00 |
| `spCreateDailyTrigger` | 06:00 |

Hours are in the project timezone, and they're staggered so the runs don't overlap. Each
function deletes its own previous trigger first, so running it twice is safe.

Check them under **Triggers** (⏰ in the sidebar). Failed runs appear under **Executions**,
and Google emails you when a trigger throws.

To stop everything, run `deleteAllTriggers`.

### What the daily run does

It refetches lifetime totals (2–3 API calls) and compares each campaign's spend and status
against the sheet:

- **unchanged** → row untouched, keeping its old `Date Pulled` as a last-changed marker
- **changed** → row rewritten in place
- **new** → row appended at the bottom
- **missing from the pull** → only the status cell updates, metrics preserved

Nothing is ever re-sorted, and only the columns each puller owns are written, so charts,
formulas and notes you add to the right stay put.

---

## 6. When something breaks

Read the execution log first — every failure path logs a specific message rather than
throwing. Then check [docs/troubleshooting.md](docs/troubleshooting.md), which covers the
errors you're most likely to hit: missing `act_` prefixes, duplicate declarations,
unrecognized API fields, expired tokens, and Google's OAuth verification wall.

If Google Ads OAuth blocks you entirely — `Error 403: access_denied` or
*"This app is blocked"* — don't fight it. Use `google-ads-script/google-ads-native.js`
instead: it runs inside the Google Ads UI, needs no OAuth, no developer token and no Cloud
project, and writes to the same sheet. Setup instructions are in the file header.
