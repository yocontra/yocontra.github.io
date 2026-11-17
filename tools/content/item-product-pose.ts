/** Undo the authored hand seat on a display pivot, never on the gameplay asset or mesh. */
import { type Entity, Quat } from 'playcanvas'

export function orientGunProduct(subject: Entity, paired: boolean): void {
  const drawn = subject.find(
    (node) => node.name.startsWith('mount.Wrist') && node.name.endsWith('.drawn'),
  )
  for (const [index, mount] of drawn.entries()) {
    mount.enabled = index === 0 || paired
    const revolver = mount.findByName('revolver')
    if (!revolver) {
      throw new Error(`Missing product gun under ${mount.name}`)
    }
    // The revolver's local rotation is its native wrist seat; its scale/translation decode
    // quantized mesh positions and remain untouched. All mechanism/socket children travel together.
    mount.setLocalRotation(new Quat().copy(revolver.getLocalRotation()).invert())
    const offset = paired ? index * 2 - 1 : 0
    mount.setLocalPosition(offset * 0.06, offset * -0.09, 0)
  }
  if (drawn.length !== (paired ? 2 : 1)) {
    throw new Error(`Expected ${paired ? 2 : 1} product guns, found ${drawn.length}`)
  }
}
