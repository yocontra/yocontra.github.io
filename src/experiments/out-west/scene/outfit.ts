import {
  type Bone,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Shape,
  ShapeGeometry,
  Skeleton,
  type SkinnedMesh,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { PartSrc } from '../data/outlaws'
import type { ClothKey } from './cloth'

export type PartSlot = 'head' | 'body' | 'legs' | 'feet'

/** Sub-meshes to drop from a head (hard hat, crown, mohawk): our hats replace them. */
export const HEAD_HIDE: Partial<Record<PartSrc, string[]>> = {
  worker: ['Worker_Yellow'],
  king: ['Gold'],
  punk: ['Red_Dark', 'Red'],
}

/** Which Poly Haven scan dresses each source material. */
export const CLOTH_BY_MATERIAL: Record<string, ClothKey> = {
  Suit: 'wool',
  Tie: 'wool',
  White: 'linen',
  Black: 'leather',
  Grey: 'leather',
  Green: 'wool',
  LightGreen: 'linen',
  Brown: 'hessian',
  Brown2: 'leather',
  Brown_02: 'leather',
  LightBrown: 'linen',
  LightBlue: 'denim',
  Worker_Vest: 'leather',
  Red_Dark: 'leather',
  Beige: 'linen',
  DarkBrown: 'leather',
  Coat: 'wool',
  Poncho: 'hessian',
  Felt: 'wool',
}

const SUFFIX: Record<PartSlot, string[]> = {
  head: ['_Head'],
  body: ['_Body'],
  legs: ['_Legs', '_Pants'],
  feet: ['_Feet'],
}

function partRoot(gltf: GLTF, slot: PartSlot): Object3D | null {
  let found: Object3D | null = null
  gltf.scene.traverse((o) => {
    if (found) return
    if (SUFFIX[slot].some((s) => o.name.endsWith(s))) found = o
  })
  return found
}

const clean = (n: string) => n.replace(/[.\s]/g, '').replace(/_\d+$/, '')

/**
 * Replace the rig's own meshes with head/body/legs/feet taken from other
 * characters of the same rig, rebinding each to the rig's skeleton.
 */
export function kitbash(
  model: Object3D,
  parts: Record<PartSlot, { gltf: GLTF; src: PartSrc }>,
): void {
  const bones = new Map<string, Bone>()
  let host: Object3D | null = null
  const drop: Object3D[] = []
  const partNode = /_(Head|Body|Legs|Pants|Feet)$/
  model.traverse((o) => {
    const b = o as Bone
    if (b.isBone) bones.set(clean(b.name), b)
    const sm = o as SkinnedMesh
    if (sm.isSkinnedMesh) {
      const parent = sm.parent
      const node = parent && partNode.test(parent.name) && !partNode.test(sm.name) ? parent : sm
      if (!host) host = node.parent
      drop.push(node)
    }
  })
  for (const d of drop) d.removeFromParent()
  const target: Object3D = host ?? model
  for (const slot of ['head', 'body', 'legs', 'feet'] as PartSlot[]) {
    const { gltf, src } = parts[slot]
    const root = partRoot(gltf, slot)
    if (!root) continue
    const hide = slot === 'head' ? (HEAD_HIDE[src] ?? []) : []
    root.traverse((o) => {
      const sm = o as SkinnedMesh
      if (!sm.isSkinnedMesh) return
      const mat = Array.isArray(sm.material) ? sm.material[0] : sm.material
      if (mat && hide.includes(mat.name)) return
      const copy = sm.clone() as SkinnedMesh
      const mapped = sm.skeleton.bones.map((b) => bones.get(clean(b.name)) ?? b)
      const sk = new Skeleton(mapped, sm.skeleton.boneInverses)
      copy.bind(sk, sm.bindMatrix)
      copy.userData['slot'] = slot
      target.add(copy)
    })
  }
}

/** Slot children are authored in metres, upright, facing +Z (see Actor.slotAt). */
export function makeCoat(color: number): Object3D {
  const g = new Group()
  // An open-fronted duster skirt from the waist to mid-shin.
  const mat = new MeshStandardMaterial({ color, roughness: 0.85, side: DoubleSide, name: 'Coat' })
  const gap = 0.9
  const skirt = new Mesh(
    new CylinderGeometry(0.19, 0.27, 0.74, 16, 3, true, Math.PI / 2 + gap / 2, Math.PI * 2 - gap),
    mat,
  )
  skirt.position.y = -0.36
  skirt.castShadow = true
  g.add(skirt)
  // shoulder cape line
  return g
}

export function makePoncho(color: number): Object3D {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
    ctx.fillRect(0, 0, 256, 64)
    const stripes = ['#e8d8b0', '#1a1a1a', '#c08a2a', '#e8d8b0']
    stripes.forEach((s, i) => {
      ctx.fillStyle = s
      ctx.fillRect(0, 40 + i * 5, 256, 3)
      ctx.fillRect(0, 8 + i * 4, 256, 2)
    })
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  const mat = new MeshStandardMaterial({
    map: tex,
    roughness: 0.95,
    side: DoubleSide,
    name: 'Poncho',
  })
  const m = new Mesh(new CylinderGeometry(0.1, 0.42, 0.5, 18, 2, true), mat)
  m.position.y = -0.2
  m.scale.z = 0.72
  m.castShadow = true
  const g = new Group()
  g.add(m)
  return g
}

export function makeMoustache(color: number, big = false): Object3D {
  const mat = new MeshStandardMaterial({ color, roughness: 0.9 })
  const g = new Group()
  for (const s of [-1, 1]) {
    const m = new Mesh(new SphereGeometry(0.03, 8, 6), mat)
    m.scale.set(big ? 1.5 : 1.2, 0.42, 0.55)
    m.position.set(s * 0.024, 0, 0)
    m.rotation.z = s * -0.35
    g.add(m)
  }
  return g
}

export function makeBeard(color: number): Object3D {
  const mat = new MeshStandardMaterial({ color, roughness: 0.95 })
  const m = new Mesh(
    new SphereGeometry(0.075, 10, 8, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65),
    mat,
  )
  m.scale.set(1, 1.2, 0.75)
  return m
}

export function makeBandoliers(): Object3D {
  const mat = new MeshStandardMaterial({ color: 0x3a2412, roughness: 0.7, name: 'Black' })
  const brass = new MeshStandardMaterial({ color: 0xc8a050, metalness: 0.8, roughness: 0.35 })
  const g = new Group()
  for (const s of [-1, 1]) {
    const strap = new Mesh(new TorusGeometry(0.2, 0.018, 4, 20), mat)
    strap.scale.set(1, 1.35, 0.62)
    strap.rotation.z = s * 0.55
    g.add(strap)
    for (let i = 0; i < 7; i++) {
      const a = -0.6 + i * 0.2
      const shell = new Mesh(new CylinderGeometry(0.007, 0.007, 0.04, 5), brass)
      shell.position.set(Math.sin(a) * 0.2 * Math.cos(s * 0.55), Math.cos(a) * 0.27, 0.13)
      shell.rotation.z = s * 0.55
      g.add(shell)
    }
  }
  return g
}

export function makeStar(): Object3D {
  const s = new Shape()
  for (let i = 0; i < 12; i++) {
    const r = i % 2 === 0 ? 0.045 : 0.02
    const a = (i / 12) * Math.PI * 2
    if (i === 0) s.moveTo(Math.sin(a) * r, Math.cos(a) * r)
    else s.lineTo(Math.sin(a) * r, Math.cos(a) * r)
  }
  const m = new Mesh(
    new ShapeGeometry(s),
    new MeshStandardMaterial({
      color: 0xe0c060,
      metalness: 0.9,
      roughness: 0.3,
      emissive: 0x3a2a00,
    }),
  )
  return m
}

export function makeMask(color: number): Object3D {
  const mat = new MeshStandardMaterial({ color, roughness: 0.95, side: DoubleSide, name: 'Linen' })
  const m = new Mesh(
    new CylinderGeometry(0.105, 0.12, 0.12, 14, 1, true, -Math.PI * 0.6, Math.PI * 1.2),
    mat,
  )
  return m
}
