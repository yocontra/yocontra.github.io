interface NativePrimitive {
  extras?: { outWestInertWind?: number }
  targets?: Record<string, number>[]
}

interface NativeFrontierGltf {
  meshes?: { primitives: NativePrimitive[] }[]
}

/** PlayCanvas creates morphs per primitive, while its animation tracks use the unchanged node. */
export function removeInertFrontierWind(gltf: NativeFrontierGltf): void {
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.extras?.outWestInertWind === 1) {
        // PlayCanvas checks for the presence of this property before creating a morph.
        Reflect.deleteProperty(primitive, 'targets')
      }
    }
  }
}
