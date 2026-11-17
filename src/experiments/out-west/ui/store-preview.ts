/** Preview controls use the live native scene; posters reuse the real wanted-poster component. */
import type { MeResponse } from '../contract/economy.ts'
import type { CatalogItem, ItemId, Loadout } from '../data/catalog.ts'
import { button, el, swallow } from './sheet.ts'
import { posterEl } from './wanted.ts'

export interface PreviewDeps {
  me: () => MeResponse | null
  item?: (id: ItemId | null) => void
  rotate?: (degrees: number) => void
  sound?: (id: ItemId) => (() => void) | undefined
}
export class StorePreview {
  private readonly root: HTMLElement
  private readonly turn: HTMLButtonElement
  private readonly content: HTMLElement
  private readonly life = new AbortController()
  private stopSound: (() => void) | undefined
  private pointer: number | null = null
  private x = 0
  private selection = ''
  private readonly deps: PreviewDeps
  constructor(parent: HTMLElement, deps: PreviewDeps) {
    this.deps = deps
    this.root = el('section', 'ow-store-preview', parent)
    this.root.setAttribute('aria-label', 'Item preview')
    swallow(this.root)
    this.turn = el('button', 'ow-store-turntable', this.root)
    this.turn.type = 'button'
    this.turn.setAttribute('aria-label', 'Rotate preview: drag, or use left and right arrow keys')
    this.content = el('div', 'ow-store-preview-content', this.root)
    const hint = el('span', 'ow-store-preview-hint', this.turn, 'Drag to turn')
    hint.setAttribute('aria-hidden', 'true')
    const options = { signal: this.life.signal }
    this.turn.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.isPrimary || event.button !== 0 || this.pointer !== null) {
          return
        }
        event.preventDefault()
        this.pointer = event.pointerId
        this.x = event.clientX
        this.turn.setPointerCapture(event.pointerId)
      },
      options,
    )
    this.turn.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId !== this.pointer) {
          return
        }
        event.preventDefault()
        this.deps.rotate?.((event.clientX - this.x) * 0.5)
        this.x = event.clientX
      },
      options,
    )
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.turn.addEventListener(
        name,
        (event) => {
          if (event.pointerId === this.pointer) {
            this.cancelDrag()
          }
        },
        options,
      )
    }
    this.turn.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          this.deps.rotate?.(event.key === 'ArrowLeft' ? -15 : 15)
        }
      },
      options,
    )
    window.addEventListener('blur', () => this.cancelDrag(), options)
  }
  private cancelDrag(): void {
    const pointer = this.pointer
    this.pointer = null
    if (pointer !== null && this.turn.hasPointerCapture(pointer)) {
      this.turn.releasePointerCapture(pointer)
    }
  }
  show(item: CatalogItem | null, loadout: Loadout, playSound = false): void {
    if (this.life.signal.aborted) {
      return
    }
    const me = this.deps.me()
    const key = JSON.stringify([
      item?.id ?? null,
      item?.slot === 'frame' ? [loadout, me?.name, me?.level, me?.prestige, me?.bounty] : null,
    ])
    if (key === this.selection) {
      if (playSound && item?.slot === 'drawSound') {
        this.replay(item.id)
      } else if (playSound && item?.slot === 'saddlebag') {
        // The native owner keeps a loaded bag, but can retry a failed selection.
        this.deps.item?.(item.id)
      }
      return
    }
    this.selection = key
    this.cancelDrag()
    this.stopSound?.()
    this.stopSound = undefined
    this.content.replaceChildren()
    this.turn.hidden = item?.slot === 'frame' || item?.slot === 'drawSound'
    this.deps.item?.(item?.id ?? null)
    if (item?.slot === 'frame') {
      this.content.append(
        posterEl(
          {
            kind: 'human',
            name: me?.name ?? 'Your gunslinger',
            level: me?.level ?? 1,
            prestige: me?.prestige ?? 0,
            bounty: me?.bounty ?? 0,
            streak: 0,
            cowardice: 0,
            loadout,
          },
          'you',
        ),
      )
    } else if (item?.slot === 'drawSound') {
      const sample = el('div', 'ow-store-sound', this.content)
      el('h2', 'ow-hub-h', sample, item.name)
      el('p', 'ow-hub-note', sample, 'Your Bounty Hunt gunshot')
      button(sample, 'Replay', () => this.replay(item.id))
      if (playSound) {
        this.replay(item.id)
      }
    }
  }
  private replay(id: ItemId): void {
    if (this.life.signal.aborted) {
      return
    }
    this.stopSound?.()
    const stop = this.deps.sound?.(id)
    this.stopSound = typeof stop === 'function' ? stop : undefined
  }
  destroy(): void {
    this.cancelDrag()
    this.life.abort()
    this.stopSound?.()
    this.root.remove()
    this.deps.item?.(null)
  }
}
