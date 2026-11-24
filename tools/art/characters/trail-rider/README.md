# Trail rider and Greenhorn

The packed Blender scenes contain the dressed characters, fitted accessories, skin weights, texture images and a portrait camera. Open `trail-rider.blend` for the player or [greenhorn.blend](../greenhorn/greenhorn.blend) for Bret P. Barsh. Each directory also contains a GLB interchange copy in bind pose. The game supplies the animations.

Trail Duds consists of a faded indigo denim jacket, a checked flannel shirt, cotton duck trousers and a printed cotton neckerchief. The jacket has separate body panels, shoulder yokes, a turned collar, pocket flaps, cuffs and metal tack buttons. The first-person arms use the same sleeve mesh and texture coordinates. The hat and holster attach to equipment sockets. Bret wears oatmeal cotton and blue serge.

The jacket's two photographic panels share a 3072 × 1536 atlas. The flannel uses 1536 × 1536 maps and the trousers use 2048 × 2048 maps. The game shares the color, normal and roughness maps between first- and third-person rigs. Each dye keeps the aspect ratio and resolution of the garment.

## Art credits

The rider uses the following works under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The Blender scene and its GLB export also contain the credits.

| Source | Artist | Changes |
| --- | --- | --- |
| [Regis head scan 3d](https://sketchfab.com/3d-models/6d8050f46e004c52921b74b74f4781e2) | ARmediaLab | Reduced the scan, fitted it to the head joint and built the rear scalp. |
| [Old Cowboy Hat](https://sketchfab.com/3d-models/be57a7084f9d49b2a700fe3b2b4aff4e) | Novamonk | Reduced and reshaped the photographed hat to fit the rider and head socket. |
| [Jeans Jacket](https://sketchfab.com/3d-models/4348be24475c45dd9a5bdf6e62ba7ebc) | Sircher | Reprojected the scanned panels onto new fitted geometry, rebuilt the sleeves and collar, and replaced the photographed buttons with hardware. |
| [Men's casual Shirt](https://sketchfab.com/3d-models/996c8d78905f433183ac368086580f82) | DineshThennarasan | Tucked and skinned the shirt, adjusted the check scale and color, and added yarn relief. |
| [Levi's 501 Denim Pants](https://sketchfab.com/3d-models/0ad985ca4f584b42bd2bfe4c009d4a46) | sivayuce | Fitted the pattern to the rider, shaped folds around each knee and boot, and made a cotton duck finish. |
| [Cowboy boots](https://sketchfab.com/3d-models/0bf75a6aaa9c42b1bb565cb12679cc6d) | Joe Roechow | Fitted a pair to the rider's feet and weighted the shafts to the lower legs. |

The rider's underlying neck and Bret's head adapt **Infinite, 3D Head Scan by Lee Perry-Smith** of Infinite-Realities, based on work at Triplegangers. [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) · [Source mesh and maps](https://github.com/mrdoob/three.js/tree/r180/examples/models/gltf/LeePerrySmith) · [Original notice](LICENSE-head.txt)

The fabric and leather materials use cropped and recolored photographs from Poly Haven under CC0. [Denim fabric](https://polyhaven.com/a/denim_fabric) · [Wool herringbone](https://polyhaven.com/a/poly_wool_herringbone) · [Brown leather](https://polyhaven.com/a/brown_leather)

Bret's eyes use a fitted and recolored MakeHuman eye map. [MakeHuman system asset credits and license](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html) · [Eye map](https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/eyes/materials/brown_eye.png)

## Local game preview

From the repository root, build an isolated copy and fit the Blender assets to the native game skeletons.

```sh
bun run build
review_dir=$(mktemp -d)
cp -R dist/. "$review_dir/"
bun tools/content/trail-rider-preview.ts "$review_dir/experiments/out-west/3d/native-v2/equipment"
python3 -m http.server 4692 --bind 127.0.0.1 --directory "$review_dir"
```

Select Trail Duds in [Perdition](http://127.0.0.1:4692/experiments/out-west/frontier/?server=loopback&bots=0&seed=7) or face Greenhorn in [Duel](http://127.0.0.1:4692/experiments/out-west/).
