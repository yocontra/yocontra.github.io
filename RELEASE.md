# Releasing contra.io

The site is GitHub Pages; the out-west API is a Cloudflare Worker on `api.contra.io`.
Out West uses PlayCanvas for rendering and physics, with Colyseus replication on SQLite Durable Objects.
The one-time setup below describes the existing hosting arrangement.

## Routine deploys

Push to `master`, or manually dispatch **Deploy** for a full release. `deploy.yml` checks and
builds one exact commit, calls the reusable `deploy-api.yml` to migrate D1 and deploy that same
commit's Worker, then publishes Pages only after the Worker succeeds. A newer push does not cancel
an in-progress publication. There is no separate manual API-only entry point.

The Worker uses immediate Durable Object updates. The Worker → Pages cutover is not atomic:
Frontier checks the public wire version, shared runtime protocol and generated collision content hash
before allocating a room. Mismatches are refused; refresh after Pages finishes publishing. The old
custom WebSocket endpoint returns 410. The new signed seat is consumed by the Colyseus SDK; reconnects
obtain fresh authenticated, Turnstile-verified one-use tickets. The Pages
build keys model, texture and catalog-image URLs by its commit SHA, bypassing old service-worker
asset keys without forcing other active tabs to reload.

The repaired native assets live under `/3d/native-v2/`. The previous GLBs remain at their original
paths so an already open v1 tab can safely load additional gear or arenas. A query hash does not
preserve historical bytes on Pages. Protocol 2 refuses outdated online clients and asks them to
refresh. Shared PBR maps load through native PlayCanvas assets as needed; retired character texture
leases and inactive arena containers release their GPU resources. KTX2 maps retain their authored
dimensions and use the pinned native Basis decoder in `/vendor/basis/2.23.3/`.
Service-worker updates wait for existing games to close. Activation preserves downloaded
non-HTML assets, including the decoder and KTX2 files, while keeping the new shell HTML.
`bun tools/test-playcanvas-cache.ts` verifies that transition and offline byte integrity in a real browser.

Run `bun run check` before pushing, or enable the hook (`git config core.hooksPath .githooks`).
The `Check` workflow gives a second, clean-runner result on every push.

## One-time setup (done)

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

## Proximity voice (Cloudflare RealtimeKit)

Production enables proximity voice with `DISABLE_VOICE=false`; players still opt in, with
push-to-talk by default. Enabling the microphone starts local standby. Idle players, a player alone,
and bots create no RealtimeKit session. The SDK and provider session start only when actual speech
or push-to-talk needs a distinct nearby human listener. Silence, audience departure and room
retirement end the session and revoke its participants; failed cleanup retries without starting
the game world.

The existing D1 guard reserves participant time against a rolling 32-day allowance of 9,000 minutes,
below RealtimeKit's [10,000 included audio participant minutes](https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/).
Reservations are conservative, are not refunded, and must succeed before admission or lease renewal.
Budget exhaustion or a failed budget check pauses voice. This is an application guard, not a provider
billing cap or a guarantee of $0 usage: token duplication, provider cleanup outages and unrelated
account usage can exceed its estimates.

To stop voice, set `DISABLE_VOICE=true` and deploy through the normal API release workflow. Verify
provider sessions have ended and no new sessions appear; do not clear usage reservations to bypass
the guard. No billing subscription or account setting needs to change.

The opt-in voice chat in Frontier and Bounty Hunt uses a RealtimeKit app named `out-west` and the
audio-only preset `out-west-voice` (video, screenshare and chat disabled). The account, app and
preset ids are `vars` in `api/wrangler.jsonc`; `REALTIMEKIT_API_TOKEN` is a Worker secret with the
**Realtime** permission and is never sent to the browser. `api/.dev.vars.example` lists the local
equivalents.

The client fetches the RealtimeKit Core SDK only when speech and an eligible listener need it.
On an iPhone 13 mini check the microphone prompt, echo with the speaker
(not headphones), the switch to a Bluetooth headset, and the Ring/Silent audio session while a
Frontier round is running.

## Service worker cache

The game registers `/experiments/out-west/sw.js` in production. After the first visit it serves
the shell and the game's assets from the cache, so a home-screen launch is a cache read (the
repeat load is ~0 MB on the wire). Bump `VERSION` in that file whenever an unhashed file under
`public/experiments/out-west/` changes (models, textures, fonts, UI art). Hashed `/_astro/` bundles
carry their own names and need no bump.

**Budget:** Out West targets **Workers Free, $0/month** with SQLite Durable Objects. Workers Free
was confirmed in the signed-in account dashboard on 2026-11-08. The available API token has no billing
read permission; its Workers Standard usage-model metadata does not establish the subscription tier.
No billing setting has been changed by this rewrite.

Gameplay admits at most 80% of the documented daily allowance: 10,400 GB-s, split into 66,560
Frontier room-seconds and 16,640 duel room-seconds at the conservative 128 MiB allocation. Incoming
WebSocket messages are capped at 1,200,000/day (60,000 request equivalents), leaving 20,000 of the
80,000 gameplay request allocation for coordination and 20,000 requests for account/settlement work.
These counters are application admission controls; they do not account for unrelated account traffic
or replace the provider's Free-plan limits.

The singleton SQLite directory atomically reserves 60-second Frontier leases and a worst-case
32-player × 20 messages/second allowance. Rooms renew on an independent 30-second timer, reconcile
occupied time against the directory's actual UTC timestamp, and close on denial or five-second renewal
failure. A socket closes above 20 outer messages/second; normal inputs batch two SDK frames at 10 Hz.
Expired, unreported reservations remain charged conservatively. Usage keys reset at UTC midnight;
old monthly rows stay intact. Admission refuses new online play after a ceiling, while local practice
continues. Frontier keeps at most four bots, independently of its 32 human seats. Last-human departure
immediately retires the native world, fixed timer and duration lease. A new authenticated connection
starts a fresh room; banked money and settled XP persist. Reservations retain only one-use SQLite
seat metadata for 30 seconds, with a durable cleanup alarm. They allocate no SDK room, native physics,
gameplay timer or duration lease until an authenticated WebSocket arrives. Pending D1 settlements
retain their idempotency keys and autonomous retry alarms.

## Native runtime checks

Frontier runs 20 Hz game rules with three native 60 Hz physics steps. Rendering, PBR materials,
animation and local prediction use PlayCanvas; the authoritative DO uses AppBase with
NullGraphicsDevice and a room-owned AmmoPhysicsWorld. Colyseus supplies schema replication, input
encoding and prediction. The SQLite directory selects the owner DO before its local Colyseus
registry is consulted; LocalPresence/LocalDriver do not represent global room state.

Run `bun test tests/runtime` for real workerd physics, Wrangler-bundled quiet-client state delivery,
room isolation, global lease races and authenticated production-route input/lease shutdown tests.
`bun test --timeout 30000 api` covers accounts, economy, settlement and native gameplay parity.
See `src/experiments/out-west/runtime/vendor/README.md` for reproducible Ammo assets, licenses and
the Workers-only precompiled callback trampoline. Do not replace the Wrangler bundle test with a
Node-only physics test: Workers prohibit dynamic Wasm compilation.

**Simulator QA:** use the requested iPhone 13 mini simulator checklist in `tools/PERF.md` and
record the build/content revision, release engine, actual canvas buffer, host GPU and frame times.
Verify the device window and host foreground state; prior measurements without that verification
are diagnostic evidence. The 30 FPS target remains open. Simulator and desktop results do not
guarantee physical A15 performance or thermal behavior. Publication does not wait for a physical phone.

## Quick Draw balance and the ranked board

The second gauntlet retune (outlaws 3–17 ramp 405→295 ms and never miss) makes a ranked clear
harder than before. Runs posted under the old curve stay on the board as they are. Every run
stores `economy_version`. If the board should restart with the new curve, bump `ECONOMY_VERSION` in
`data/economy.ts` and filter the board to it.

The touch allowance (+40 ms on his draw for a tap) applies only to unranked play: practice, the
story and an unposted guest Daily. Ranked runs and posted Daily runs judge every device the same,
because a client could claim to be on touch.

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
