# Trail rider and Greenhorn

The packed Blender scenes contain the dressed characters, fitted accessories, skin weights, texture images and a portrait camera. Open `trail-rider.blend` for the player or [greenhorn.blend](../greenhorn/greenhorn.blend) for Bret P. Barsh. Each directory also contains a GLB interchange copy in bind pose. The game supplies the animations.

The Trail Duds rider wears an open leather jacket over a wool waistcoat and striped work shirt. The jacket fronts part around the five-button waistcoat. Its sleeves follow the elbows and wrists in both third and first person. The boot soles and leather creases come from a separate scan. The hat and holster attach to equipment sockets. Bret wears oatmeal cotton and blue serge. [Before and after in PlayCanvas](rider-comparison.jpg)

The shoulder fit and jacket opening follow the proportions of the layered clothing in the cowboy photograph. The museum lists the original waistcoat at 480 mm from the collar to the center front. The reference sheet shows two period photographs and the source garments before fitting. [Reference sheet](rider-references.jpg) · [Cowboy group photograph, circa 1904](https://www.loc.gov/item/2006679142/) · [The horse wrangler, 1910](https://www.loc.gov/item/2002716009/) · [Museum measurements](https://museum.wa.gov.au/online-collections/content/H1998.29/) · [Rockstar’s visual reference](https://www.rockstargames.com/newswire/article/9k1248838o1a1k/Screens-From-Red-Dead-Redemption-2)

## Art credits

The rider uses the following works under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The Blender scene and its GLB export also contain the credits.

| Source                                                                                                 | Artist                    | Changes                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Regis head scan 3d](https://sketchfab.com/3d-models/6d8050f46e004c52921b74b74f4781e2)                 | ARmediaLab                | Joined the face scan to a modeled scalp, jaw and neck, and blended the skin weights into the chest.     |
| [Old Cowboy Hat](https://sketchfab.com/3d-models/be57a7084f9d49b2a700fe3b2b4aff4e)                     | Novamonk                  | Reduced and reshaped the photographed hat to fit the rider and head socket.                             |
| [Brown Leather Jacket](https://sketchfab.com/3d-models/357d2f25e3a34d16beea1ac295b33091)               | GlenR52                   | Opened the fronts, posed the sleeves around the elbows and wrists, and darkened the hide.               |
| [Thomas Chapman waistcoat, H1998.29](https://sketchfab.com/3d-models/988d633830eb4f4a9ebf2d6f012771d3) | Western Australian Museum | Reduced the scan, refitted the armholes, skinned the shoulder seams, and dyed the photographed fabric.  |
| [Men's casual Shirt](https://sketchfab.com/3d-models/996c8d78905f433183ac368086580f82)                 | DineshThennarasan         | Fitted the collar and button stand under the waistcoat and added a striped woven surface.               |
| [Levi's 501 Denim Pants](https://sketchfab.com/3d-models/0ad985ca4f584b42bd2bfe4c009d4a46)             | sivayuce                  | Fitted the pattern to the rider, shaped folds around each knee and boot, and made a cotton duck finish. |
| [boots and cowboy hat](https://sketchfab.com/3d-models/f2eb6879afd34893bdf8f7c0cfbabe8d)               | hcwiley                   | Isolated one boot, baked its scanned color onto a UV map, and fitted a mirrored pair to the rider.      |

Bret's head adapts **Infinite, 3D Head Scan by Lee Perry-Smith** of Infinite-Realities, based on work at Triplegangers. [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) · [Source mesh and maps](https://github.com/mrdoob/three.js/tree/r180/examples/models/gltf/LeePerrySmith) · [Original notice](LICENSE-head.txt)

The fabric and leather materials use cropped and recolored photographs from Poly Haven under CC0. [Denim fabric](https://polyhaven.com/a/denim_fabric) · [Wool herringbone](https://polyhaven.com/a/poly_wool_herringbone) · [Brown leather](https://polyhaven.com/a/brown_leather)

Bret's eyes use a fitted and recolored MakeHuman eye map. [MakeHuman system asset credits and license](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html) · [Eye map](https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/eyes/materials/brown_eye.png)

## Rebuild the game models

Run the following commands from the repository root. The fitter reads the native base rigs and the packed Blender exports. The game loads the fitted models in Perdition and Duel.

```sh
native=public/experiments/out-west/3d/native-v2
bun tools/content/trail-rider-preview.ts "$native/fitted/equipment"
bun tools/content/manifest.ts
```
