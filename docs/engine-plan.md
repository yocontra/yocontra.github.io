# out west: engine plan (Unity vs Babylon.js vs staying on three.js)

Status: decided 2026-11-04: stay on three.js (option A). This plan is kept for reference if a port is reconsidered later.

## What the research says (Nov 2026)

**Unity**
- Mobile web: supported. Unity 6's web platform officially lists iOS Safari 15+ and Android Chrome. Builds are WebGL2 (the "compatibility" renderer). WebGPU support for web export is reported inconsistently, and I couldn't confirm it from Unity's own docs.
- Mobile web in practice: builds are large (WASM + data, typically tens of MB for a 3D game), first load on phones is slow, and mobile Safari's memory ceiling is tight. Unity's web build is a secondary target, not its strength.
- TypeScript: **not official.** Unity is C#. TypeScript is possible through community runtimes:
  - **PuerTS** (Tencent; used in shipped games, mainly in China) runs TS on V8/QuickJS inside Unity, but its WebGL backend is limited to "H5/Mini Games".
  - **OneJS**, built on PuerTS, is UI-focused, with WebGL support "planned".

  Gameplay in TS on Unity's web export is not a supported path.
- Native: Unity's real strength. Call of Duty Mobile is a Unity game. Native iOS/Android performance and a huge asset store, but paid assets are out of scope here.

**Babylon.js**
- TypeScript-native, MIT-licensed, Microsoft-backed, actively released (9.33.2 on 2026-11-02). WebGL2 and WebGPU.
- What it gives us that we hand-rolled:
  - animation groups with weights, blending and masks;
  - Havok physics;
  - baked vertex animation (crowds) and thin instances;
  - a default rendering pipeline (bloom, tone mapping, etc.);
  - an inspector;
  - node materials;
  - GUI.
- Proven in web FPS: Shell Shockers.
- **Babylon React Native (native in Expo): not viable today.** The project's own tracker has an open issue (Oct 2026), "New Architecture is not supported". React Native 0.82+ and current Expo always run the New Architecture. Its README also says it isn't tested with Expo, and it's touch-only with a single view. So Babylon in an Expo app today means **WebView**, the same as three.js.

**Staying on three.js**
- Proven: Krunker is a large three.js web FPS.
- Today the game holds 60 fps at 4× CPU throttle on every screen except packed Frontier (7.3–8.2 ms vs a 7 ms target), and heap fits 110 MB.

## What we'd keep vs rewrite

About **70k lines** of TypeScript in the client and **22k** in the API.
- **Engine-agnostic (keep in any web port):**
  - the Cloudflare Worker / Durable Object server;
  - the shared Frontier simulation and netcode (client prediction uses the same TS sim as the server);
  - contracts, data, economy, progression, meta;
  - DOM UI and copy;
  - WebAudio;
  - device/platform code;
  - the test harnesses.
- **three.js-coupled:** 114 files, about **38k lines**: scene builders (town, courthouse, flora, sky), characters (bake, fit, coat, poncho, hats, holster, gunbelt, person, face, whiskers), animation (actor, draw, locomotion, crowd/VAT), rendering, post, LOD, the viewmodel and fx.

A Babylon port rewrites roughly the 38k three-coupled lines. A Unity rebuild rewrites essentially everything client-side in C#. It also means **duplicating the Frontier simulation in C#** for client prediction while the server stays TS, or rewriting the server too. That's a permanent drift risk for a server-authoritative shooter.

## The honest problem statement

What you've flagged (characters, clothing, guns, animation polish) is mostly **content**: authored assets and animation. We have no paid assets and no Blender, so we generate garments and guns in code from CC0 parts. **No engine changes that.** An engine gives better runtime systems (animation graphs, physics, editors) but the same CC0 art.

One free lever: **Mixamo** has a large professional animation library, free with an Adobe account (you would sign in and download; I can't create accounts). Plus Quaternius, Kenney and Poly Haven, all CC0.

## Options

### A. Stay on three.js, adopt proven libraries (recommended now)
- Libraries: Rapier (physics/character controller), three-mesh-bvh (collision and raycasts), a small animation state-graph layer over AnimationMixer, and Mixamo animations (free) retargeted to our rig.
- Keeps everything that works and keeps shipping continuously.
- Gets most of the remaining animation quality, the main visible gap.
- Cost: low and incremental.

### B. Port the client to Babylon.js
- Same web + Expo WebView story as today. Native Babylon in Expo isn't available, so this doesn't buy native performance.
- Gains: engine-grade animation blending and masks, Havok, built-in baked-vertex-animation crowds, an inspector, WebGPU.
- Cost: rewrite about 38k lines. Realistically several weeks of multi-agent work with a period of two renderers, plus regressions to re-fix (everything we've tuned: lighting, shading, garments, LOD, perf).
- Do it if we hit a wall three.js can't pass (e.g. we need Havok-grade physics, or WebGPU-only features).

### C. Rebuild in Unity (native-first)
- The CoD Mobile route: best native performance on iPhone and Android, a mature animation system, Unity UI.
- Web version: a Unity Web build (heavy, slow first load on mobile Safari) or keep the three.js game on contra.io as a separate client.
- Costs:
  - a full C# rewrite of the client;
  - the Frontier sim duplicated in C# (or the server rewritten);
  - giving up TS-only and the web-first portfolio angle.
- Do it if the App Store premium game becomes the primary product and native performance is non-negotiable.

## Recommendation

**A now, keep B as the fallback, and choose C only if the product becomes native-first.**

1. Finish the current agents' work (in progress).
2. Spike A for 1–2 days:
   - retarget 15–20 Mixamo clips (aim, fire, reload per weapon, crouch, slide, sprint, strafe, deaths, hits) onto our rig, via `tools/build-moves.ts`;
   - add a small animation state graph;
   - add three-mesh-bvh for camera and shot raycasts;
   - measure perf.

   Needs you to download the Mixamo pack (free account).
3. Spike B in parallel for 2–3 days, as a throwaway:
   - Frontier's town and one animated, aiming rider in Babylon;
   - compare animation quality, perf on the iPhone 13 mini emulation, and code size.
4. Decide with real numbers. If B clearly wins, migrate Frontier first (it benefits most), then the duel, behind a flag, with the shared sim, net, UI and audio unchanged.

## If B is chosen: migration outline
1. **Render boundary.** Define a `RenderBackend` interface that the game state calls: scene graph, actors, cameras, fx. Keep sim, net, UI and audio untouched.
2. **Assets.** glTF stays (both engines load it). Port the procedural builders (`BufferGeometry` → `VertexData`) or bake them to GLB with tool scripts (the better long-term choice, and engine-agnostic).
3. **Characters and animation.**
   - AnimationGroups with weights and masks replace the procedural layers.
   - Babylon's BakedVertexAnimationManager replaces our VAT crowd.
   - Bone IK for guns.
4. **Rendering.**
   - DefaultRenderingPipeline replaces our post stack.
   - Re-tune AgX/LUT, the sky, height fog and shadows.
5. **Frontier first.** It has the most to gain. Ship behind `?engine=babylon`, A/B the perf suite, then cut over. Then the duel, hub and Outfitter.
6. **Tools.** Port float-audit, material-audit, anim-audit and perf-suite hooks. ui-audit is unchanged (DOM).

## Sources
- Unity web browser compatibility (6000.6 manual): https://docs.unity3d.com/Manual/webgl-browsercompatibility.html
- Unity web runtime updates (blog): https://unity.com/blog/engine-platform/web-runtime-updates-enhance-browser-experience
- Web engine comparison 2026 (third-party): https://app.cinevva.com/guides/web-game-engines-comparison
- PuerTS / OneJS: https://onejs.com/docs/core/scriptengine/puerts and https://onejs.com/docs/new-in-v2
- Babylon React Native: https://github.com/BabylonJS/BabylonReactNative (releases 2.0.8, 2026-10-26; open issue "Docs: New Architecture is not supported", 2026-10-18)
- Expo New Architecture: https://docs.expo.dev/guides/new-architecture.md
