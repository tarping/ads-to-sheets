# Getting a Meta Ads access token

You need one Script Property: **`META_ACCESS_TOKEN`**, a token with the `ads_read`
permission on the ad account you want to pull.

There are two ways to get one. Use the System User route for anything you intend to leave
running.

---

## Option A — System User token (recommended, doesn't expire)

Requires a Meta Business Manager and admin access to it.

1. Go to **business.facebook.com** → **Business Settings**.
2. **Users → System Users → Add**. Name it something like `reporting-bot`, role
   **Employee**.
3. Select the new system user → **Add Assets** → **Ad Accounts** → pick your ad account →
   enable **View Performance** (read-only is enough; the pullers never write).
4. Click **Generate New Token**.
   - App: any app in your Business Manager (create one at developers.facebook.com if you
     have none — it needs no review for this).
   - Permissions: tick **`ads_read`**.
   - Token expiration: **Never**.
5. Copy the token immediately — it's shown once.
6. Paste it into Apps Script under **Project Settings → Script Properties** as
   `META_ACCESS_TOKEN`.

System User tokens don't expire, which is what you want for a daily trigger.

---

## Option B — Graph API Explorer token (fast, expires in ~60 days)

Fine for testing, wrong for automation — your sync will break in two months.

1. **developers.facebook.com/tools/explorer**
2. Pick your app, click **Add a Permission** → `ads_read`.
3. **Generate Access Token**, approve the dialog, copy it.
4. Optionally extend it to ~60 days at
   **developers.facebook.com/tools/debug/accesstoken** → *Extend Access Token*.

---

## Finding your ad account ID

In **Ads Manager**, the account ID appears under the account name in the account switcher,
and in the URL as `act=1234567890`.

In `meta.gs` it must carry the `act_` prefix:

```js
AD_ACCOUNT_ID: "act_1234567890",
```

Without the prefix, the Graph API doesn't recognise it as an ad account and every call
fails with `(#100) Tried accessing nonexisting field (campaigns)`.

---

## Reusing one token across several accounts

A single System User token covers every ad account assigned to that system user in Business
Manager. To pull a second account, assign it to the same system user and change
`AD_ACCOUNT_ID` — no new token needed.

If the second account lives in a **different** Business Manager, you need a system user and
token from that BM instead.

---

## Checking it works

Run `metaFullPull` and read the execution log:

- `Meta: 47 campaigns with delivery, 63 total in account.` → working.
- `Tried accessing nonexisting field (campaigns)` → missing `act_` prefix.
- `Object with ID '…' does not exist, cannot be loaded due to missing permissions` →
  wrong account ID, or the token has no access to it.
- `Error validating access token` → expired or revoked; generate a new one.

To see exactly which action types Meta reports for a campaign — useful when the Results
column picks something unexpected — put part of the campaign name into `SEARCH` inside
`metaDebugCampaign()` and run it.
