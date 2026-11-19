type Feedback = 'carry' | 'hurt' | 'hit-scale' | 'hit-opacity'

/** Restart a flash even within the same task, without forcing layout to commit CSS class changes. */
export class HudFeedback {
  private readonly animations = new Map<Feedback, Animation>()

  carry(element: HTMLElement): void {
    this.play('carry', element, [{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], 350)
  }

  hurt(element: HTMLElement, amount: number): void {
    this.play(
      'hurt',
      element,
      [{ opacity: Math.min(0.9, 0.25 + amount / 70) }, { opacity: 0 }],
      600,
    )
  }

  hit(element: HTMLElement, kill: boolean, crit: boolean): void {
    element.className = `fr-hitmark${kill ? ' kill' : ''}${crit ? ' crit' : ''}`
    this.play(
      'hit-scale',
      element,
      [{ transform: 'scale(1.7)' }, { transform: 'scale(1)' }],
      kill ? 200 : 120,
    )
    this.play('hit-opacity', element, [{ opacity: 1 }, { opacity: 0 }], 350)
  }

  private play(name: Feedback, element: HTMLElement, frames: Keyframe[], duration: number): void {
    this.animations.get(name)?.cancel()
    this.animations.set(name, element.animate(frames, { duration, easing: 'ease-out' }))
  }

  dispose(): void {
    for (const animation of this.animations.values()) {
      animation.cancel()
    }
    this.animations.clear()
  }
}
