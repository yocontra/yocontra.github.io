/** Texture-storage meter for the browser visual/performance harness. */
interface Image {
  width: number
  height: number
  depth: number
  bpp: number
}
interface Texture {
  levels: Map<string, number>
  bases: Map<number, Image>
  immutable: number | null
  target: number
}
interface Context {
  unit: number
  bindings: Map<string, object | null>
  textures: Map<object, Texture>
}

class TextureMeter {
  private readonly contexts = new WeakMap<WebGL2RenderingContext, Context>()
  private readonly all = new Set<Context>()
  private readonly sized = new Map([
    [0x82_29, 1],
    [0x82_2b, 2],
    [0x80_51, 3],
    [0x80_58, 4],
    [0x8c_41, 3],
    [0x8c_43, 4],
    [0x82_2d, 2],
    [0x82_2f, 4],
    [0x88_1b, 6],
    [0x88_1a, 8],
    [0x82_2e, 4],
    [0x82_30, 8],
    [0x88_15, 12],
    [0x88_14, 16],
    [0x81_a5, 2],
    [0x81_a6, 4],
    [0x8c_ac, 4],
    [0x88_f0, 4],
    [0x8c_ad, 8],
    [0x8c_3a, 4],
    [0x8c_3d, 4],
    [0x80_59, 4],
    [0x80_56, 2],
    [0x80_57, 2],
    [0x8d_62, 2],
  ])
  private readonly bytesPerPixel = (internal: number, format: number, type: number): number => {
    const known = this.sized.get(internal)
    if (known) {
      return known
    }
    if ([0x80_33, 0x80_34, 0x83_63].includes(type)) {
      return 2
    }
    if ([0x83_68, 0x8c_3b, 0x8c_3e, 0x84_fa].includes(type)) {
      return 4
    }
    if (type === 0x8d_ad) {
      return 8
    }
    let components = 4
    if ([0x19_03, 0x8d_94, 0x19_02, 0x19_06, 0x19_09].includes(format)) {
      components = 1
    } else if ([0x82_27, 0x82_28].includes(format)) {
      components = 2
    } else if ([0x19_07, 0x8d_98].includes(format)) {
      components = 3
    }
    let bytes = 1
    if ([0x14_06, 0x14_05, 0x14_04].includes(type)) {
      bytes = 4
    } else if ([0x14_02, 0x14_03, 0x14_0b].includes(type)) {
      bytes = 2
    }
    return components * bytes
  }
  private static readonly normalized = (target: number): number =>
    target >= 0x85_15 && target <= 0x85_1a ? 0x85_13 : target
  private readonly state = (gl: WebGL2RenderingContext): Context => {
    let context = this.contexts.get(gl)
    if (!context) {
      context = { unit: 0x84_c0, bindings: new Map(), textures: new Map() }
      this.contexts.set(gl, context)
      this.all.add(context)
      const current = context
      gl.canvas.addEventListener('webglcontextlost', () => current.textures.clear())
    }
    return context
  }
  private readonly bound = (gl: WebGL2RenderingContext, target: number): Texture | null => {
    const context = this.state(gl)
    const object = context.bindings.get(`${context.unit}/${TextureMeter.normalized(target)}`)
    if (!object) {
      return null
    }
    let texture = context.textures.get(object)
    if (!texture) {
      texture = {
        levels: new Map(),
        bases: new Map(),
        immutable: null,
        target: TextureMeter.normalized(target),
      }
      context.textures.set(object, texture)
    }
    return texture
  }
  private static readonly image = (
    texture: Texture,
    face: number,
    level: number,
    size: Image,
  ): void => {
    texture.levels.set(
      `${face}/${level}`,
      Math.max(0, size.width) * Math.max(0, size.height) * Math.max(0, size.depth) * size.bpp,
    )
    if (level === 0) {
      texture.bases.set(face, size)
    }
  }
  private static readonly mipSize = (size: Image, level: number, array: boolean): Image => ({
    width: Math.max(1, Math.floor(size.width / 2 ** level)),
    height: Math.max(1, Math.floor(size.height / 2 ** level)),
    depth: array ? size.depth : Math.max(1, Math.floor(size.depth / 2 ** level)),
    bpp: size.bpp,
  })
  private static readonly sourceSize = (source: unknown): { width: number; height: number } => {
    if (typeof source !== 'object' || source === null) {
      return { width: 0, height: 0 }
    }
    const w =
      Reflect.get(source, 'videoWidth') ??
      Reflect.get(source, 'naturalWidth') ??
      Reflect.get(source, 'width')
    const h =
      Reflect.get(source, 'videoHeight') ??
      Reflect.get(source, 'naturalHeight') ??
      Reflect.get(source, 'height')
    return { width: typeof w === 'number' ? w : 0, height: typeof h === 'number' ? h : 0 }
  }
  private static readonly wrap = (
    name: string,
    after: (gl: WebGL2RenderingContext, args: unknown[]) => void,
  ): void => {
    const original = Reflect.get(WebGL2RenderingContext.prototype, name)
    if (typeof original !== 'function') {
      return
    }
    Reflect.set(
      WebGL2RenderingContext.prototype,
      name,
      function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args)
        after(this, args)
        return result
      },
    )
  }
  private readonly storage = (gl: WebGL2RenderingContext, args: unknown[], depth: number): void => {
    const target = Number(args[0])
    const texture = this.bound(gl, target)
    if (!texture) {
      return
    }
    const levels = Number(args[1])
    const internal = Number(args[2])
    const size = {
      width: Number(args[3]),
      height: Number(args[4]),
      depth,
      bpp: this.bytesPerPixel(internal, internal, 0x14_01),
    }
    texture.levels.clear()
    texture.bases.clear()
    texture.immutable = levels
    const faces =
      target === 0x85_13 ? [0x85_15, 0x85_16, 0x85_17, 0x85_18, 0x85_19, 0x85_1a] : [target]
    for (const face of faces) {
      for (let level = 0; level < levels; level++) {
        TextureMeter.image(
          texture,
          face,
          level,
          TextureMeter.mipSize(size, level, target === 0x8c_1a),
        )
      }
    }
  }
  private readonly stats = () => {
    let bytes = 0
    let textures = 0
    for (const context of this.all) {
      for (const texture of context.textures.values()) {
        textures++
        for (const size of texture.levels.values()) {
          bytes += size
        }
      }
    }
    return { bytes, textures }
  }

  constructor() {
    if (typeof WebGL2RenderingContext === 'undefined') {
      return
    }
    TextureMeter.wrap('activeTexture', (gl, args) => {
      this.state(gl).unit = Number(args[0])
    })
    TextureMeter.wrap('bindTexture', (gl, args) => {
      const context = this.state(gl)
      const target = Number(args[0])
      const texture = args[1]
      context.bindings.set(
        `${context.unit}/${TextureMeter.normalized(target)}`,
        typeof texture === 'object' ? texture : null,
      )
    })
    TextureMeter.wrap('deleteTexture', (gl, args) => {
      const object = args[0]
      if (typeof object === 'object' && object !== null) {
        this.state(gl).textures.delete(object)
      }
    })
    TextureMeter.wrap('texImage2D', (gl, args) => {
      const target = Number(args[0])
      const level = Number(args[1])
      const internal = Number(args[2])
      const texture = this.bound(gl, target)
      if (!texture) {
        return
      }
      const source =
        args.length >= 9
          ? { width: Number(args[3]), height: Number(args[4]) }
          : TextureMeter.sourceSize(args[5])
      const format = Number(args[args.length >= 9 ? 6 : 3])
      const type = Number(args[args.length >= 9 ? 7 : 4])
      TextureMeter.image(texture, target, level, {
        ...source,
        depth: 1,
        bpp: this.bytesPerPixel(internal, format, type),
      })
    })
    TextureMeter.wrap('texImage3D', (gl, args) => {
      const target = Number(args[0])
      const texture = this.bound(gl, target)
      if (!texture) {
        return
      }
      TextureMeter.image(texture, target, Number(args[1]), {
        width: Number(args[3]),
        height: Number(args[4]),
        depth: Number(args[5]),
        bpp: this.bytesPerPixel(Number(args[2]), Number(args[7]), Number(args[8])),
      })
    })
    TextureMeter.wrap('texStorage2D', (gl, args) => this.storage(gl, args, 1))
    TextureMeter.wrap('texStorage3D', (gl, args) => this.storage(gl, args, Number(args[5])))
    TextureMeter.wrap('generateMipmap', (gl, args) => {
      const target = Number(args[0])
      const texture = this.bound(gl, target)
      if (!texture) {
        return
      }
      for (const [face, base] of texture.bases) {
        const levels =
          texture.immutable ??
          1 +
            Math.floor(
              Math.log2(Math.max(base.width, base.height, target === 0x80_6f ? base.depth : 1)),
            )
        for (let level = 1; level < levels; level++) {
          TextureMeter.image(
            texture,
            face,
            level,
            TextureMeter.mipSize(base, level, target === 0x8c_1a),
          )
        }
      }
    })
    Reflect.set(globalThis, '__owTextureBytes', () => this.stats().bytes)
    Reflect.set(globalThis, '__owTextureStats', this.stats)
  }
}

/** Playwright addInitScript content; installs before any renderer creates a context. */
export const textureMeterScript = `new (${TextureMeter.toString()})();`
