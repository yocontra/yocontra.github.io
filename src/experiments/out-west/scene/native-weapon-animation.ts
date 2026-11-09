/** Authored prop motion uses native Anim alongside the masked skeletal controller. */
import { type AnimTrack, type ContainerResource, Entity } from 'playcanvas'
import { nativeActionSpeed } from './native-animation-timing.ts'
import type { WeaponMount } from './native-mounts.ts'
export function animateWeaponMount(mount: Entity, resource: ContainerResource, key: string): void {
  const clips = resource.animations
    .map((asset) => asset.resource as AnimTrack)
    .filter((clip) => clip.name.startsWith('Weapon_') && clip.name.endsWith(`_${key}`))
  const initial = `Weapon_Idle_${key}`
  const indexed = new Map(clips.map((clip) => [clip.name, clip]))
  const idle = indexed.get(initial)
  if (!idle) {
    throw new Error(`Missing native ${key} weapon mechanism`)
  }
  mount.addComponent('anim', { activate: false })
  mount.anim?.loadStateGraph({
    layers: [
      {
        name: 'Weapon',
        states: [
          { name: 'START' },
          ...clips.map((clip) => ({
            name: clip.name,
            speed: nativeActionSpeed(clip),
            loop: clip === idle,
          })),
        ],
        transitions: [{ from: 'START', to: initial }],
      },
    ],
    parameters: {},
  })
  for (const clip of clips) {
    mount.anim?.baseLayer?.assignAnimation(clip.name, clip)
  }
  mount.anim?.baseLayer?.play(initial)
  if (mount.anim) {
    mount.anim.activate = true
    mount.anim.playing = true
  }
}
export function playWeaponMount(mount: Entity, action: string, key: string): void {
  const name = `Weapon_${action}_${key}`
  if (!mount.anim?.baseLayer?.states.includes(name)) {
    return
  }
  mount.anim.baseLayer.play(name)
  mount.anim.update(0)
}

export function animateRevolvers(
  mounts: readonly WeaponMount[],
  resource: ContainerResource,
): void {
  for (const mount of mounts) {
    if (mount.drawn && mount.node instanceof Entity) {
      animateWeaponMount(mount.node, resource, mount.hand ?? 'R')
    }
  }
}
