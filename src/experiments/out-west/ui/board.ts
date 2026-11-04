import { money } from '../data/economy.ts'
import {
  type BoardEntry,
  cleanName,
  fetchTop,
  loadName,
  NAME_MAX,
  type Result,
  saveName,
} from '../net/leaderboard.ts'
import { mountMostWanted } from './most-wanted.ts'
import { closeButton, onSwipeDown } from './sheet.ts'
import { recallOne, remember } from './store-memory.ts'

export interface Banked {
  total: number
  rank: number
}

export interface BoardOpen {
  /** The purse being banked (shown above the name field). */
  purse?: number
  /** Bank the run under a name (ranked only); omit for a view-only board. */
  submit?: (name: string) => Promise<Result<Banked>>
  /** Button label, e.g. "Submit to leaderboard". */
  submitLabel?: string
  /** A short line for view-only boards ("Practice runs aren’t ranked."). */
  note?: string
  /** View-only boards open on this tab (the gauntlet's by default). */
  tab?: BoardTab
  onClose?: () => void
}

/** The gauntlet's all-time run board, or the monthly Most Wanted earnings board. */
export type BoardTab = 'gauntlet' | 'most-wanted'

const BOARD_TAB_KEY = 'out-west-board-tab'

/** The board tab you last looked at on this device, else `fallback`. */
export function lastBoardTab(fallback: BoardTab): BoardTab {
  return recallOne<BoardTab>(BOARD_TAB_KEY, ['gauntlet', 'most-wanted'], fallback)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) {
    e.textContent = text
  }
  parent.appendChild(e)
  return e
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/**
 * The leaderboard overlay: top 25, name entry and submit. Swallows keys and
 * pointers so typing a name never walks, draws or pauses the game.
 */
export class Board {
  readonly root: HTMLElement
  private opts: BoardOpen = {}
  private myRank = null as number | null
  private loadSeq = 0
  private banked = false as boolean
  private closeBtn = null as HTMLButtonElement | null
  private status = null as HTMLElement | null
  private list = null as HTMLElement | null

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ow-board', parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Leaderboard')
    for (const ev of ['keydown', 'keyup', 'pointerdown', 'pointerup'] as const) {
      this.root.addEventListener(ev, (e) => e.stopPropagation())
    }
    // a click on the backdrop closes it
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) {
        this.close()
      }
    })
  }

  /** While open, keys belong to the board: Escape closes it, nothing reaches the game. */
  private readonly onWindowKey = (e: KeyboardEvent): void => {
    const inside = e.target instanceof Node && this.root.contains(e.target)
    if (!inside) {
      e.stopImmediatePropagation()
    }
    if (e.type === 'keydown' && e.key === 'Escape') {
      e.preventDefault()
      this.close()
    }
  }

  get isOpen(): boolean {
    return this.root.classList.contains('on')
  }

  open(opts: BoardOpen = {}): void {
    this.opts = opts
    this.myRank = null
    this.banked = false
    this.render()
    this.root.classList.add('on')
    globalThis.addEventListener('keydown', this.onWindowKey, true)
    globalThis.addEventListener('keyup', this.onWindowKey, true)
    const name = this.root.querySelector<HTMLInputElement>('.ow-board-name')
    if (name && !name.value) {
      name.focus()
    } else {
      this.closeBtn?.focus()
    }
    this.refresh().catch(() => undefined)
  }

  close(): void {
    if (!this.isOpen) {
      return
    }
    this.root.classList.remove('on')
    globalThis.removeEventListener('keydown', this.onWindowKey, true)
    globalThis.removeEventListener('keyup', this.onWindowKey, true)
    this.root.innerHTML = ''
    this.loadSeq++
    this.opts.onClose?.()
  }

  private render(): void {
    const r = this.root
    r.innerHTML = ''
    const panel = el('div', 'ow-board-panel', r)
    // the sheets' head: the title and its Close on one line (sheets.css)
    const head = el('div', 'ow-hub-row ow-sheet-head', panel)
    el('h2', 'ow-hub-h ow-board-title', head, 'LEADERBOARD')
    this.closeButton(head)
    onSwipeDown(panel, () => this.close())
    const submit = this.opts.submit
    if (!submit) {
      this.tabs(panel)
    }
    if (!submit && this.opts.tab === 'most-wanted') {
      mountMostWanted(el('div', 'ow-feat-mw', panel), this.root)
      this.status = null
      this.list = null
      return
    }
    if (submit) {
      const form = el('form', 'ow-board-form', panel)
      el('div', 'ow-board-purse', form, `Your purse: ${money(this.opts.purse ?? 0)}`)
      const row = el('div', 'ow-board-row', form)
      const label = el('label', 'ow-board-label', row, 'Name')
      const input = el('input', 'ow-board-name', label)
      input.type = 'text'
      input.maxLength = NAME_MAX
      input.setAttribute('autocomplete', 'nickname')
      input.spellcheck = false
      input.placeholder = 'Your name'
      input.value = loadName()
      const btn = el('button', 'ow-btn ow-btn-primary', row, this.opts.submitLabel ?? 'Submit')
      btn.type = 'submit'
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        this.send(submit, { input, btn }).catch(() => undefined)
      })
    } else if (this.opts.note) {
      el('div', 'ow-board-note', panel, this.opts.note)
    }
    this.status = el('div', 'ow-board-status', panel)
    this.status.setAttribute('aria-live', 'polite')
    this.list = el('ol', 'ow-board-list', panel)
  }

  private closeButton(panel: HTMLElement): void {
    this.closeBtn = closeButton(panel, () => this.close())
  }

  /** Gauntlet runs | Most Wanted, for a view-only board. */
  private tabs(panel: HTMLElement): void {
    const bar = el('div', 'ow-store-tabs ow-feat-board-tabs', panel)
    bar.setAttribute('role', 'tablist')
    const current = this.opts.tab ?? 'gauntlet'
    const tabs: readonly [BoardTab, string][] = [
      ['gauntlet', 'Gauntlet runs'],
      ['most-wanted', 'Most Wanted'],
    ]
    for (const [tab, label] of tabs) {
      const b = el('button', `ow-store-tab${tab === current ? ' on' : ''}`, bar, label)
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(tab === current))
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        if (tab !== (this.opts.tab ?? 'gauntlet')) {
          remember(BOARD_TAB_KEY, tab)
          this.opts = { ...this.opts, tab }
          this.loadSeq++
          this.render()
          this.refresh().catch(() => undefined)
        }
      })
    }
  }

  private setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    if (!this.status) {
      return
    }
    this.status.textContent = text
    this.status.dataset.kind = kind
  }

  private async refresh(): Promise<void> {
    if (!this.list) {
      return
    }
    const seq = ++this.loadSeq
    if (this.status?.dataset.kind !== 'ok') {
      this.setStatus('Loading…')
    }
    const r = await fetchTop(25)
    if (seq !== this.loadSeq) {
      return
    }
    if (!r.ok) {
      this.setStatus(r.error, 'error')
      return
    }
    if (this.status?.dataset.kind !== 'ok') {
      this.setStatus(r.value.length > 0 ? '' : 'No names on the board yet.')
    }
    this.fill(r.value)
  }

  private fill(entries: BoardEntry[]): void {
    const list = this.list
    if (!list) {
      return
    }
    list.innerHTML = ''
    const me = loadName().trim().toLowerCase()
    for (const e of entries) {
      const li = el('li', 'ow-board-entry', list)
      const mine =
        this.myRank === null ? me !== '' && e.name.toLowerCase() === me : e.rank === this.myRank
      if (mine) {
        li.classList.add('mine')
      }
      el('span', 'ow-board-rank', li, String(e.rank))
      el('span', 'ow-board-who', li, e.name)
      el('span', 'ow-board-total', li, money(e.total))
      el('span', 'ow-board-date', li, dateFmt.format(new Date(e.createdAt)))
    }
  }

  private async send(
    submit: (name: string) => Promise<Result<Banked>>,
    ui: { input: HTMLInputElement; btn: HTMLButtonElement },
  ): Promise<void> {
    const { input, btn } = ui
    if (this.banked) {
      return
    }
    const name = cleanName(input.value)
    if (!name) {
      this.setStatus(`Pick a name of 1–${NAME_MAX} characters.`, 'error')
      input.focus()
      return
    }
    saveName(name)
    btn.disabled = true
    btn.textContent = 'Sending…'
    const r = await submit(name)
    if (!this.isOpen) {
      return
    }
    if (!r.ok) {
      btn.disabled = false
      btn.textContent = this.opts.submitLabel ?? 'Submit'
      this.setStatus(r.error, 'error')
      return
    }
    this.banked = true
    this.myRank = r.value.rank
    btn.textContent = 'Submitted'
    this.setStatus(`You’re #${r.value.rank} with ${money(r.value.total)}.`, 'ok')
    await this.refresh()
  }
}
