/** Bounded headphone direction cues for nearby enemy footfalls, through native public panners. */
import { type SoundInstance, SoundInstance3d } from 'playcanvas'

const MAX_VOICES = 6

export class FootstepSpatializer {
  private readonly playing = new Map<SoundInstance3d, () => void>()
  private destroyed = false as boolean

  apply(instance: SoundInstance): boolean {
    if (this.destroyed || !(instance instanceof SoundInstance3d) || !instance.panner) {
      return false
    }
    if (this.playing.has(instance)) {
      return true
    }
    if (this.playing.size >= MAX_VOICES) {
      return false
    }
    const release = () => {
      instance.off('end', release)
      instance.off('stop', release)
      this.playing.delete(instance)
    }
    instance.panner.panningModel = 'HRTF'
    this.playing.set(instance, release)
    instance.once('end', release)
    instance.once('stop', release)
    return true
  }

  destroy(): void {
    this.destroyed = true
    for (const [instance, release] of this.playing) {
      instance.panner.panningModel = 'equalpower'
      release()
    }
  }
}
