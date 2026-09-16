# AGENTS.md

Guidance for AI coding assistants (Claude Code, Codex, Cursor, Copilot…) working in this
repo, most often to **set it up for a new person** or **add a platform**. Humans should
start with [README.md](README.md) and [SETUP.md](SETUP.md).

## What this is

Google Apps Script files that pull campaign data from ad platforms into one Google Sheet:
one tab per platform, one row per campaign, lifetime totals since a start date, refreshed
by a daily trigger. No server, no build step, no dependencies. Users copy the `.gs` files
into an Apps Script project bound to their sheet.

```
apps-script/shared.gs       naming config, secrets, upsert engine, sheet setup (always required)
apps-script/meta.gs         Meta Ads        → "Meta Campaigns"
apps-script/google-ads.gs   Google Ads      → "Google Campaigns"   (OAuth)
apps-script/tiktok.gs       TikTok Ads      → "TikTok Campaigns"
apps-script/spotify.gs      Spotify Ads     → "Spotify Campaigns"  (OAuth + partner approval)
google-ads-script/google-ads-native.js   alternative Google Ads puller that runs inside
                                         the Google Ads UI; self-contained, no shared.gs
docs/<platform>.md          how to get each platform's credentials
docs/troubleshooting.md     known errors and fixes
```

## Runtime facts that shape the code

- **Apps Script V8, not Node.** No `require`, no npm, no `fetch` — use `UrlFetchApp`,
  `SpreadsheetApp`, `PropertiesService`, `ScriptApp`, `Utilities`, `Logger`. Code is ES5
  style (`var`, `function`) to match the files.
- **All `.gs` files share one global scope** and are loaded in the order they were created
  in the project. So: no top-level code may call into another file (build headers inside
  the run function, as the pullers do), and every global needs a platform prefix (`META_`,
  `GADS_`, `TT_`, `SP_`, `_meta…`, `_sp…`) to avoid collisions.
- **6-minute execution cap.** Use account-level report endpoints that aggregate
  server-side; never loop one API call per campaign.

## Invariants — do not break these

1. **Secrets live only in Script Properties**, read with `getSecret("NAME")`. Never put a
   token, client secret or refresh token in a file.
2. **The public repo holds no real identities.** No real account ids, company, client,
   artist or employee names. Use zero placeholders (`act_XXXXXXXXXXXXXXX`,
   `0000000000`, `00000000-0000-0000-0000-000000000000`) and the fictional examples
   already used ("Nova Cascade", "Acme"). Real values belong in the user's Apps Script
   project or Script Properties (e.g. `SPOTIFY_ACCOUNTS`), not in git.
3. **Campaign naming is configured in one place:** `NAME_SEPARATOR` and `NAME_FIELDS` at
   the top of `shared.gs` (mirrored at the top of `google-ads-native.js`). Pullers call
   `buildHeaders(PLATFORM_COLUMNS)` and start each row with
   `[today].concat(parseCampaignName(name), [...])`. Never hardcode naming columns or
   column numbers in a puller; find positions with `colIndex(headers, "Campaign ID")`.
4. **Row shape must match headers.** Each row is `"Date Pulled"`, the naming values, then
   exactly one value per entry in the platform's `*_COLUMNS`, in the same order.
5. **The upsert contract** (`upsertRows` in `shared.gs`): rows matched by Campaign ID;
   unchanged spend + status → row untouched; missing campaigns keep their metrics and only
   get a status update; row order never re-sorted; only the puller's own columns written.
   Users put formulas to the right of the pulled data and rely on this.
6. **Blank means "not measured", 0 means "measured zero".** Don't coerce missing metrics to
   0.
7. **Each platform stays independent.** A user may install only one puller; a failure in
   one must not affect another's tab.

## Setting it up for a new person

Ask for these, then edit only the config blocks and naming values. Don't change the
engine.

1. **Which platforms?** Delete nothing from the repo; tell them which files to paste.
2. **Account ids per platform** (config block at the top of each file):
   Meta `act_…` (with prefix) · Google Ads customer id + MCC id, digits only · TikTok
   advertiser ids · Spotify ad account UUIDs (prefer the `SPOTIFY_ACCOUNTS` Script
   Property). These go into *their* Apps Script copy, not into commits to this repo.
3. **Their campaign naming convention.** Get 2–3 real campaign names, work out the
   separator and the meaning of each part, and set `NAME_SEPARATOR` / `NAME_FIELDS`. No
   consistent convention → `NAME_FIELDS = []`. Names that don't fit simply leave blanks.
4. **Start date** (`START_DATE`, `YYYY-MM-DD`) — the earliest data they want.
5. **Timezone** for the daily triggers (Apps Script → Project Settings).
6. **Credentials** — walk them through `docs/<platform>.md`, then list which Script
   Properties to add (table in SETUP.md §2). Warn early that Spotify needs partner
   approval and Google Ads OAuth may be blocked (fallback: `google-ads-native.js`).
7. **First run order** — `gadsDebugAuth` before `gadsFullPull`; then each `*FullPull`, then
   each `*CreateDailyTrigger`. Healthy log lines are shown in SETUP.md §4.

## Adding a platform

Copy the shape of `tiktok.gs`, the simplest puller:

1. A config object (`XX = { ACCOUNTS/IDs, SHEET_NAME, START_DATE }`) with placeholder ids.
2. `XX_COLUMNS` — the platform's own columns, which must include `"Campaign ID"`, a status
   column and `"Spend"`.
3. `xxFullPull()` / `xxDailyPull()` → `_xxRun(rebuild)`: build headers, fetch campaign
   statuses and one aggregated lifetime report, fill `fresh[id] = { status, row }` and
   `statusOnly[id]`, then call `upsertRows(...)` with `colIndex` positions.
4. `xxCreateDailyTrigger()` at an hour not used by the others (03–06 are taken).
5. Secrets via `getSecret`; add them to SETUP.md §2.
6. `docs/xx.md` for credentials, plus rows in README's tables and SETUP §1, §4 and §5.
7. For non-trivial logic (date windows, merging, status rules), add an `xxSelfCheck()`
   that calls no API and throws on failure — see `spSelfCheck()` in `spotify.gs`.

Platform quirks worth knowing before you touch a puller are documented next to the code
(e.g. Meta's result selection in `meta.gs`, Spotify's 90-day report limit and unmergeable
unique metrics in `spotify.gs` and `docs/spotify.md`).

## Checking your work

There is no test runner. Before finishing:

- Run a syntax check: `node --check` doesn't accept `.gs`, so copy each file to a `.js`
  temp file and `node --check` it.
- Confirm every puller's row has the same length as its headers.
- In Apps Script, run `spSelfCheck()` if Spotify changed, and a `*FullPull` against a real
  account when the user can.
- Search the diff for anything that looks like a real id, token, email or company name.
