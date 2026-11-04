# Releasing contra.io

The site is GitHub Pages; the out-west API is a Cloudflare Worker on `api.contra.io`.
Nothing here has been run yet. Do it in this order on release day.

1. **Move contra.io DNS to Cloudflare.** Add the zone, then switch the registrar's nameservers.
   Recreate the GitHub Pages records (`A`/`AAAA` for the apex, or `CNAME`), DNS-only (grey cloud).
2. **Create a Turnstile widget** for `contra.io` in the Cloudflare dashboard. Keep the site key and
   the secret key.
3. **Log in and run the one-time setup:**

   ```bash
   bunx wrangler login
   bun scripts/release.ts
   ```

   This creates the D1 database and writes its id into `api/wrangler.jsonc`, applies all migrations,
   generates `AUTH_SECRET`, asks for the Turnstile secret, and deploys the Worker to
   `api.contra.io`. Commit the updated `api/wrangler.jsonc`.
4. **Set up GitHub:**
   - The repository variable `TURNSTILE_SITEKEY` is the Turnstile site key. The Pages build fails
     without it, so production can never ship the test key.
   - The secrets `CLOUDFLARE_API_TOKEN` (Workers, D1 and DNS edit) and `CLOUDFLARE_ACCOUNT_ID` are
     for `deploy-api.yml`.
   - Under Settings → Pages, set Source to "GitHub Actions".
5. **Merge `redesign` into `master` and push.**
   - `deploy.yml` builds and publishes the site.
   - `deploy-api.yml` migrates and deploys the API.
6. **Verify:** sign up with a passkey on https://contra.io/experiments/out-west/, play a ranked run,
   and check `https://api.contra.io/leaderboard`.

**Budget:** the Workers Paid plan is $5/month. The API enforces its own ceilings (`api/src/budget.ts`)
so usage stays inside the included quota, and Frontier closes for the month instead of overspending.

**Real-device check:** before announcing, run the iPhone 13 mini checklist in `tools/PERF.md`.

## Turnstile in an app WebView

Turnstile can fail where there's no ordinary browser. Headless Chrome returned error 600010 in
review, and an Expo app's WKWebView (iOS) or Android WebView may do the same. Nobody has tested this
on a device yet, so check it before an App Store build ships.

**What fails gracefully today:**

- **Guests playing alone never need a token.** Practice, the gauntlet and a guest's Daily Outlaw try
  don't ask for one. `POST /daily/sessions` accepts a guest's try without a token, because a guest's
  try is never posted or paid. Tries are still counted per network, 3 a day.
- **Signed-in Daily Outlaw:** without a valid token the server answers 403 `reason: 'turnstile'`.
  The sheet says "Couldn't verify this device, so your time can't be posted" and offers **Try again**
  (a fresh token) or **Play without posting**. That try runs as a guest's: no board, no pay.
- **Ranked runs:** without a token the run plays on in practice. The HUD says "Couldn't verify this
  device, so this run is practice. Restart to try ranked again."
- **Bounty Hunt queue:** "Couldn't verify this device. Try again." with a Try again button.
- **Sign-up and the first web refresh of each UTC day** still need a token. A failed daily refresh
  keeps you signed in without an access token until a check passes (`net/auth.ts`). App sessions
  refresh from native code and skip the daily check (`api/src/auth/daily-turnstile.ts`).
- **Frontier lobby joins** need a token at every join and show the refusal card without one.

**Options for the app, best first:**

1. **Verify natively.** Use App Attest (iOS) or Play Integrity (Android) through the Expo native
   bridge, and have the Worker accept that attestation wherever it accepts a Turnstile token today.
2. **Load the page from its real origin.** Point the WebView at `https://contra.io/...`, not a
   bundled `file://` or custom-scheme page, so the widget runs on a hostname it knows. Keep
   JavaScript, third-party iframes and cookies enabled for `challenges.cloudflare.com`.
3. **Allowlist the app's hostnames** on the Turnstile widget in the Cloudflare dashboard if the app
   serves the page from another host.

Test on a real device: a signed-in Daily try, a ranked run, a Bounty Hunt search and a Frontier
join. Each should either work or show its message and retry path above.
