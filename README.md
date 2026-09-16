# Ads → Google Sheets

Free Google Apps Script pullers that sync **Meta Ads**, **Google Ads**, **TikTok Ads** and
**Spotify Ads** campaign data into one Google Sheet, updated daily and automatically.

No Zapier, no Supermetrics, no paid connectors, no server. Everything runs on Google's
free Apps Script quota.

```
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌─────────────┐
│ Meta Ads  │  │Google Ads │  │TikTok Ads │  │ Spotify Ads │
└─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └──────┬──────┘
      │              │              │               │
      └───────── Apps Script (daily trigger) ────────┘
                         │
                ┌────────▼─────────┐
                │   Google Sheet   │  one tab per platform
                └──────────────────┘  one row per campaign
```

## What you get

One tab per platform, **one row per campaign**, holding **lifetime totals** since a start
date you choose. Rows are matched by Campaign ID and updated in place, so the sheet is a
live picture of every campaign rather than an ever-growing log.

The scripts parse your campaign naming convention into separate columns, so you can pivot
by artist, market, objective or whatever your names encode:

```
"Nova Cascade | Summer EP | National | Conversion | 200"
      ↓            ↓           ↓           ↓        ↓
   Artist      Release      Segment    Objective  Budget
```

| Behaviour | Why it matters |
|---|---|
| Matched by Campaign ID, updated in place | No duplicate rows, no re-import |
| Unchanged campaigns are skipped entirely | `Date Pulled` becomes a free "last changed" marker |
| Campaigns that stop delivering keep their metrics | Historic spend is never lost, only the status flips to `PAUSED` |
| Row order preserved, only owned columns written | Your own formulas to the right stay aligned |
| Account-level API calls, not per-campaign | An account of 1,000+ campaigns syncs in one run |
| All tokens in Script Properties | Nothing secret ever lands in your repo |

### Columns pulled

| Platform | Metrics |
|---|---|
| **Meta** | Impressions, Reach, Spend, Link Clicks, Results, Result Type, Cost per Result, Post Engagement |
| **Google** | Impressions, Clicks, CTR, CPC, Spend, Video Views, View Rate, Avg CPV |
| **TikTok** | Impressions, Clicks, CTR, CPC, CPM, Spend, Reach, 6s Video Views, Sound Clicks, Conversions, Cost per Conversion |
| **Spotify** | Start/End Date, Impressions, Reach, Frequency, Clicks, CTR, Spend, Currency, Streams, Listeners, New Listeners, Paid Listens, Video Views, Completion Rate |

Meta's "Results" column is the tricky one: Meta reports dozens of action types per
campaign, so the script picks the one matching each campaign's objective (purchases for
sales campaigns, leads for lead campaigns, landing page views for traffic, reach + CPM for
awareness…) and falls back sensibly when a campaign reports something unexpected.

Spotify solves the same problem differently: it reports every metric for every campaign, so
the puller writes them all and adds a **Delivery Goal** column telling you which one the
campaign was buying — `AWARENESS` → impressions, `ENGAGEMENT_ON_SPOTIFY` → streams,
`WEBSITE_TRAFFIC` → clicks. Spotify also reports its own **Currency** per ad account, so
two accounts billing in different currencies can share the tab without their spend columns
quietly reading as comparable.

**Spotify needs partner approval.** Unlike the other three, a developer app alone isn't
enough — Spotify has to grant your app Ads API access, and until it does every call returns
`403`. See [docs/spotify.md](docs/spotify.md) before setting it up.

## Repo layout

```
apps-script/                 ← paste these five files into ONE Apps Script project
├── shared.gs                   helpers + the upsert engine (required by all)
├── meta.gs                     Meta Ads puller
├── google-ads.gs               Google Ads puller (needs OAuth)
├── tiktok.gs                   TikTok Ads puller
└── spotify.gs                  Spotify Ads puller (needs OAuth + partner access)

google-ads-script/           ← optional, use INSTEAD of google-ads.gs
└── google-ads-native.js        runs inside the Google Ads UI, needs no OAuth at all

docs/
├── meta.md                     getting a Meta access token
├── google-ads.md               developer token, OAuth client, refresh token
├── tiktok.md                   getting a TikTok access token
├── spotify.md                  partner access, OAuth client, refresh token
└── troubleshooting.md          every error we hit, and the fix
```

## Quick start

1. Create a Google Sheet → **Extensions → Apps Script**.
2. Create the script files you need and paste in the contents of `apps-script/`.
3. Add your API tokens under **Project Settings → Script Properties** (see [`SETUP.md`](SETUP.md)).
4. Edit the config block at the top of each platform file (account IDs, start date).
5. Run `metaFullPull`, `gadsFullPull`, `ttFullPull`, `spFullPull` once each.
6. Run `metaCreateDailyTrigger`, `gadsCreateDailyTrigger`, `ttCreateDailyTrigger`,
   `spCreateDailyTrigger` to automate.

Full walkthrough: **[SETUP.md](SETUP.md)** · Credentials: **[docs/](docs/)** · Errors: **[docs/troubleshooting.md](docs/troubleshooting.md)**

You do not need all four platforms — each file is independent. Only `shared.gs` is
mandatory. Delete what you don't use.

## Cost and limits

Everything here is free. Apps Script's free tier allows 20,000 URL fetch calls/day and
90 minutes of runtime/day; these pullers use **2–3 API calls per platform per day**, so a
typical setup uses well under 1% of quota.

The one real limit is Apps Script's **6-minute cap per execution**. Because the pullers ask
each API to aggregate lifetime totals server-side instead of looping over campaigns, an
account with 1,000+ campaigns still finishes in seconds. If you ever outgrow it, the
natural next step is a Cloud Run or Cloudflare Worker cron writing to Sheets via a service
account.

## Security

- **Never commit tokens.** All secrets are read from Script Properties via `getSecret()`.
  The config blocks in these files hold only account IDs and dates.
- If you fork this and later hardcode a token "just to test", assume it is public the
  moment you push. Rotate it.
- Meta System User tokens and TikTok long-term tokens do not expire — treat them like
  passwords.
- A Google OAuth refresh token issued while your Cloud project is in *Testing* mode
  expires after 7 days. Publish the app to production before minting one, or your daily
  sync will silently die a week later. See [docs/google-ads.md](docs/google-ads.md).

## Adapting it to your setup

**Different naming convention?** Edit `parseCampaignName()` in `shared.gs` (and in
`google-ads-native.js` if you use it), then rename the matching entries in each
`*_HEADERS` array. Nothing else depends on the field names.

**Don't name campaigns systematically?** Delete those seven columns from the headers and
the row builders — the metrics work regardless.

**Want per-day rows instead of lifetime totals?** Add `segments.date` to the Google query,
switch Meta to `time_increment: 1`, and use a composite key (campaign ID + date) in
`upsertRows`. That's a different tool, but the plumbing here is a reasonable starting point.

## License

MIT — see [LICENSE](LICENSE).
