# Getting Google Ads API credentials

This is the most painful part of the whole repo. Google Ads needs **four** credentials, and
its OAuth consent flow blocks unverified apps for many accounts.

> **Shortcut worth considering first.** If you only need Google Ads (not Meta or TikTok),
> or Google blocks your OAuth app, use `google-ads-script/google-ads-native.js` instead. It
> runs inside the Google Ads UI, needs **none** of the credentials below, and writes to the
> same sheet. Everything on this page becomes unnecessary. See
> [the shortcut section](#shortcut-skip-oauth-entirely) at the bottom.

You need four Script Properties:

| Property | What it is |
|---|---|
| `GADS_DEVELOPER_TOKEN` | Identifies your MCC to the API |
| `GADS_CLIENT_ID` | OAuth client, from Google Cloud |
| `GADS_CLIENT_SECRET` | OAuth client secret |
| `GADS_REFRESH_TOKEN` | Long-lived user authorization |

---

## 1. Developer token

1. Sign into your **manager (MCC) account** at ads.google.com.
2. **Tools & Settings → Setup → API Center**.
3. Apply for a token if you have none. **Basic access** is enough for this repo.

The token belongs to the MCC and works for every client account linked under it. A brand
new token starts with *test account only* access — you must reach at least Basic before it
returns data for live accounts.

---

## 2. OAuth client (ID + secret)

1. **console.cloud.google.com** → create or select a project.
2. **APIs & Services → Library** → search **Google Ads API** → **Enable**. Skipping this
   makes every call fail regardless of credentials.
3. **APIs & Services → OAuth consent screen**:
   - User type **External**
   - Fill in app name, support email, developer email
   - Add the scope `https://www.googleapis.com/auth/adwords`
   - **Publish App** → status must read **In production**
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`
   - Create, then copy the **Client ID** and **Client secret**

> **Publish the app before step 3.** Refresh tokens issued while the consent screen is in
> *Testing* mode **expire after 7 days**, so your daily sync will die silently a week after
> you set it up. Publishing needs no Google review for your own use — it only changes
> whether you see an "unverified app" warning during sign-in.

---

## 3. Refresh token

1. Open **developers.google.com/oauthplayground**.
2. Click the **⚙ gear** (top right) → tick **Use your own OAuth credentials** → paste your
   Client ID and Client secret.
3. In **Step 1**, ignore the API list and type this scope into the input box:
   ```
   https://www.googleapis.com/auth/adwords
   ```
4. **Authorize APIs** → sign in with a Google account that has access to the MCC → approve.
   Click through **Advanced → Go to … (unsafe)** if the unverified-app warning appears.
5. In **Step 2**, click **Exchange authorization code for tokens**.
6. Copy the **Refresh token**.

The refresh token is bound to the client ID/secret pair that created it — resetting the
secret invalidates it. If you plan to rotate the secret, do that *first*, then mint the
token.

One refresh token covers every account the signed-in user can reach through the MCC. To add
another ad account, just change `CUSTOMER_ID`.

---

## 4. Account IDs

In `google-ads.gs`:

```js
CUSTOMER_ID      : "1234567890",   // the ad account you pull FROM
LOGIN_CUSTOMER_ID: "9876543210",   // the MCC it sits under
```

Digits only, no dashes.

- **`CUSTOMER_ID`** — the client account whose campaigns you want. Shown top-right in the
  Ads UI while inside that account.
- **`LOGIN_CUSTOMER_ID`** — the manager account you reach it through, sent as the
  `login-customer-id` header. Shown top-right while inside the MCC. If the account isn't
  under any MCC and your user has direct access, set it to the same value as `CUSTOMER_ID`.

A mismatch here is the usual cause of `USER_PERMISSION_DENIED`.

---

## Verifying

Run **`gadsDebugAuth`** before anything else. It tests the two failure modes separately:

```
✅ Token OK                              ← OAuth works
✅ API returned 3 rows: [...]            ← developer token + IDs + permissions all work
```

If the token line fails, the problem is the client ID/secret/refresh token. If the token
passes but the API line fails, the problem is the developer token, the account IDs, or the
signed-in user's access.

Then run `gadsFullPull`.

---

## Shortcut: skip OAuth entirely

Google blocks unverified apps for some accounts with **"This app is blocked"** or
**`Error 403: access_denied`**, and personal Gmail accounts have no admin console to
whitelist anything. Rather than pursuing Google's app verification process, use the native
Google Ads Script:

1. **ads.google.com** → open the **ad account** (not the MCC).
2. **Tools & Settings → Bulk actions → Scripts → [+]**.
3. Paste `google-ads-script/google-ads-native.js`.
4. Set `SPREADSHEET_URL` at the top to your sheet's URL.
5. **Authorize** — this is Google authorizing its own product against your account, so
   there's no app verification involved.
6. **Preview**, then **Run**, then set **Frequency → Daily**.

It produces the same columns in the same tab with the same update-in-place behaviour. The
trade-off is that it lives in the Ads UI rather than alongside your Meta and TikTok
pullers, and it must be installed per ad account.
