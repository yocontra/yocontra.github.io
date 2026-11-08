/**
 * UE-mannequin joint names (Quaternius's packs) → the game's rig names (Hips, Torso, UpperArmR,
 * WristR…). Used by the offline animation importer `build-moves.ts`.
 */

const SIDE: Record<string, string> = { l: 'L', r: 'R' }
const FINGER: Record<string, string> = {
  index: 'Index',
  middle: 'Middle',
  ring: 'Ring',
  pinky: 'Pinky',
  thumb: 'Thumb',
}
const DIRECT: Record<string, string> = {
  root: 'Root',
  pelvis: 'Hips',
  spine01: 'Abdomen',
  spine02: 'Torso',
  spine03: 'Chest',
  neck01: 'Neck',
  Head: 'Head',
}
const LIMB: Record<string, string> = {
  clavicle: 'Shoulder',
  upperarm: 'UpperArm',
  lowerarm: 'LowerArm',
  hand: 'Wrist',
  thigh: 'UpperLeg',
  calf: 'LowerLeg',
  foot: 'Foot',
  ball: 'Toe',
}

/** UE-mannequin joint name → the game's rig name (punctuation-free, as boneKey() sees it). */
/** `<part>_[NN_][leaf_]<l|r>` UE-mannequin joint names. */
const MANNEQUIN_JOINT = /^(?<part>[a-z]+)_(?:(?<num>\d\d)_)?(?:(?<leaf>leaf)_)?(?<side>[lr])$/u

export function rigName(n: string): string {
  const flat = n.replace(/_/gu, '')
  const direct = DIRECT[n] ?? DIRECT[flat]
  if (direct) {
    return direct
  }
  const m = MANNEQUIN_JOINT.exec(n)
  if (!m) {
    return flat
  }
  const { part = '', num, leaf, side = 'l' } = m.groups ?? {}
  const s = SIDE[side] ?? 'L'
  if (part === 'ball' && leaf) {
    return `ToeTip${s}`
  }
  const limb = LIMB[part]
  if (limb) {
    return `${limb}${s}`
  }
  const finger = FINGER[part]
  if (finger) {
    return `${finger}${Number(num ?? '1')}${s}`
  }
  return flat
}
