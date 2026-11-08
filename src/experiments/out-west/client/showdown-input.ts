import type { ServerControl } from '../contract/town.ts'
import type { World } from '../ffa/sim/state.ts'
import { Buttons, type PlayerInput } from '../runtime/protocol.ts'

/** Preserve wall-clock quick-draw timing independently of render and simulation tick rates. */
export class ShowdownInput {
  private readonly world: World
  private readonly self: number
  private readonly send: (text: string) => void
  private call: { id: number; at: number } | undefined
  private sent = -1
  private held = false as boolean
  constructor(options: { world: World; self: number; send: (text: string) => void }) {
    this.world = options.world
    this.self = options.self
    this.send = options.send
  }
  control(message: ServerControl): void {
    if (message.type === 'showdown_call') {
      this.call = { id: message.showdownId, at: performance.now() }
    }
  }
  sample(input: PlayerInput): void {
    const fire = Boolean(input.buttons & Buttons.fire)
    const showdown = this.world.showdowns.get(this.world.players[this.self]?.showdown ?? -1)
    if (fire && !this.held && showdown?.phase === 'called' && this.sent !== showdown.id) {
      this.sent = showdown.id
      const localMs = this.call?.id === showdown.id ? performance.now() - this.call.at : null
      this.send(JSON.stringify({ type: 'showdown_shot', showdownId: showdown.id, localMs }))
    }
    this.held = fire
  }
}
