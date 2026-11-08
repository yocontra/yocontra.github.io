# Pinned native Basis decoder

Unmodified Basis Universal transcoder files from PlayCanvas engine tag `v2.23.3`:
https://github.com/playcanvas/engine/tree/v2.23.3/examples/assets/wasm/basis

| File | Upstream Git blob SHA-1 | SHA-256 |
| --- | --- | --- |
| basis.js | 0e0a97633469811a22d6637c8d28c760f0160bac | c85407f23254399027517c51dc129e49f3e4abec47450c8f144b2007f64565e9 |
| basis.wasm.js | 3ad6183499714edbc07ef0c82326636f4668806c | 82143c2193310331a3186530cc1615950f5ddd4d308aa6a25d82ad1d5933c624 |
| basis.wasm.wasm | 059befa2a308973b79317e46846f916eecfdca50 | 70ed1e72dea7132706ee4e8637d9fc1e348ea03bb3a46644372f309067c47eef |

`scripts/no-js.ts` verifies these exact bytes, including the WebAssembly binary.
The native PlayCanvas texture loader selects the device's supported GPU format;
two lazy native decoder workers are shared across mounted engine applications.
Basis Universal is Copyright Binomial LLC, distributed under Apache License 2.0;
see `LICENSE.txt`. These files are not generated or modified by application builds.
