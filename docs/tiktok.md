# Getting a TikTok Ads access token

You need one Script Property: **`TIKTOK_ACCESS_TOKEN`**, plus the advertiser ID of each ad
account you want to pull.

TikTok requires a developer app even for pulling your own data, and tokens are scoped to
the specific advertiser accounts you approve during authorization.

---

## 1. Create a developer app

1. Go to **business-api.tiktok.com** → **My Apps** → **Create an App**.
   (You'll need a TikTok for Business account with access to the ad accounts.)
2. Fill in the app details. For **Advertiser Redirect URL**, any URL you control works —
   `https://example.com/callback` is fine, since you'll read the code out of the URL bar
   manually.
3. Under **Scope of Permission**, enable at minimum:
   - **Ad Account Management → Read**
   - **Reporting → Read**
4. Submit. Basic read access is usually approved quickly.
5. From the app page, note the **App ID** and **Secret**.

---

## 2. Authorize your ad accounts

1. On the app page, copy the **Advertiser Authorization URL** TikTok generates for you.
2. Open it in a browser, sign in, and **tick every advertiser account** you want the token
   to cover. This is the step people get wrong — an account not ticked here is invisible to
   the token, and adding it later means redoing the authorization.
3. After approving you're redirected to your redirect URL with `?auth_code=…` in the query
   string. Copy that code.

---

## 3. Exchange the code for a long-term token

Send the auth code to TikTok's token endpoint. Any HTTP client works; with curl:

```bash
curl -X POST 'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/' \
  -H 'Content-Type: application/json' \
  -d '{
    "app_id":    "YOUR_APP_ID",
    "secret":    "YOUR_APP_SECRET",
    "auth_code": "THE_CODE_FROM_THE_REDIRECT"
  }'
```

The response contains `data.access_token` and a list of the advertiser IDs it covers:

```json
{ "code": 0, "data": { "access_token": "…", "advertiser_ids": ["7123456789012345678"] } }
```

Save the token as `TIKTOK_ACCESS_TOKEN` in **Project Settings → Script Properties**.

TikTok long-term tokens don't expire, but they're revoked if the app's permissions change
or a user removes access.

---

## 4. Configure the advertiser accounts

Put the advertiser IDs from that response into `tiktok.gs`:

```js
var TT = {
  ADVERTISERS: [
    { id: "7123456789012345678", name: "Main Account" },
    { id: "7987654321098765432", name: "Second Account" }
  ],
  ...
};
```

All advertisers write into the same tab and are told apart by the **Account** column, which
uses the `name` you set here — that name is yours to choose and doesn't need to match
TikTok's.

You can also find advertiser IDs in TikTok Ads Manager: they're the long numeric ID in the
URL as `aadvid=…`.

---

## Checking it works

Run `ttFullPull` and read the execution log:

- `TikTok: 34 campaigns with data in range.` → working.
- `TikTok API error: Access token is invalid` → wrong or revoked token.
- `TikTok API error: No permission for this advertiser` → the advertiser ID wasn't ticked
  during authorization; redo step 2.
- `0 campaigns with data in range` with no error → the token and account are fine, but no
  campaign delivered inside `START_DATE`–today. Check your start date.

---

## A note on metrics

The pullers request `video_watched_6s`, `sound_usage_clicks`, `conversion` and
`cost_per_conversion` alongside the basics. Not every account or objective populates all of
them; empty ones come back blank rather than zero, which keeps them out of averages and
charts. The full metric list is in `TT_METRICS` at the top of `tiktok.gs` — add or remove
fields there and update `TT_HEADERS` and the row builder to match.
