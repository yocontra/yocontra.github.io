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
