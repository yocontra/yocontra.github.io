# Third-party notices

The generated Ammo factory and compiled Ammo module come from the
[PlayCanvas engine v2.23.3 Ammo assets](https://github.com/playcanvas/engine/tree/v2.23.3/examples/assets/wasm/ammo).
The factory is altered to use the web environment, export ESM, and accept a precompiled callback module.
The package includes the Ammo zlib license and PlayCanvas MIT license in `dist/vendor/`.

The package uses the official Colyseus core, shared protocol constants, and message encoders by
dependency. The Cloudflare socket adapter is independently authored. Its feasibility research
included [c-py’s Cloudflare adapter at b0f296e](https://github.com/c-py/colyseus-cloudflare-worker-transport/tree/b0f296e444867dc2edb47e351c28b7238e08289f),
which declares UNLICENSED. No source from that project is incorporated.
