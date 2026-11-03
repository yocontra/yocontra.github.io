import { money, type RunResult } from '../data/economy'
import {
  type BoardEntry,
  cleanName,
  fetchTop,
  loadName,
  NAME_MAX,
  saveName,
  submitRun,
} from '../net/leaderboard'

export interface BoardOpen {
  /** A run that may be submitted (omit for a view-only board). */
  run?: RunResult | null
  /** Button label, e.g. "Submit to leaderboard" or "Submit run so far". */
  submitLabel?: string
  /** Called after a successful submit. */
  onSubmitted?: () => void
  onClose?: () => void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
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
  private myRank: number | null = null
  private loadSeq = 0
  /** Run states already submitted this session, so the same run can't post twice. */
  private readonly sent = new Set<string>()
  private static key(run: RunResult): string {
    return `${run.duels.length}:${run.total}`
  }

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ow-board', parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Leaderboard')
    for (const ev of ['keydown', 'keyup', 'pointerdown', 'pointerup'] as const) {
      this.root.addEventListener(ev, (e) => e.stopPropagation())
    }
    // a click on the backdrop closes it
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close()
    })
  }

  /** While open, keys belong to the board: Escape closes it, nothing reaches the game. */
  private readonly onWindowKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return
    if (this.root.contains(e.target instanceof Node ? e.target : null)) {
      if (e.type === 'keydown' && e.key === 'Escape') this.close()
      return
    }
    e.stopImmediatePropagation()
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
    this.render()
    this.root.classList.add('on')
    window.addEventListener('keydown', this.onWindowKey, true)
    window.addEventListener('keyup', this.onWindowKey, true)
    const first = this.root.querySelector<HTMLElement>('.ow-board-name') ?? this.closeBtn
    if (first && !(first instanceof HTMLInputElement && first.value)) first.focus()
    else this.closeBtn?.focus()
    void this.refresh()
  }

  close(): void {
    if (!this.isOpen) return
    this.root.classList.remove('on')
    window.removeEventListener('keydown', this.onWindowKey, true)
    window.removeEventListener('keyup', this.onWindowKey, true)
    this.root.innerHTML = ''
    this.loadSeq++
    this.opts.onClose?.()
  }

  private closeBtn: HTMLButtonElement | null = null
  private status: HTMLElement | null = null
  private list: HTMLElement | null = null

  private render(): void {
    const r = this.root
    r.innerHTML = ''
    const panel = el('div', 'ow-board-panel', r)
    el('h2', 'ow-board-title', panel, 'LEADERBOARD')
    const run = this.opts.run ?? null
    if (run && run.total > 0) {
      const form = el('form', 'ow-board-form', panel)
      el('div', 'ow-board-purse', form, `Your purse: ${money(run.total)}`)
      const row = el('div', 'ow-board-row', form)
      const label = el('label', 'ow-board-label', row, 'Name')
      const input = el('input', 'ow-board-name', label)
      input.type = 'text'
      input.maxLength = NAME_MAX
      input.setAttribute('autocomplete', 'nickname')
      input.spellcheck = false
      input.placeholder = 'Your handle'
      input.value = loadName()
      const btn = el('button', 'ow-btn ow-btn-primary', row, this.opts.submitLabel ?? 'Submit')
      btn.type = 'submit'
      if (this.sent.has(Board.key(run))) {
        btn.disabled = true
        btn.textContent = 'Submitted'
      }
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        void this.submit(run, input, btn)
      })
    }
    this.status = el('div', 'ow-board-status', panel)
    this.status.setAttribute('aria-live', 'polite')
    this.list = el('ol', 'ow-board-list', panel)
    const close = el('button', 'ow-btn', panel, 'Close')
    close.type = 'button'
    close.addEventListener('click', () => this.close())
    this.closeBtn = close
  }

  private setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    if (!this.status) return
    this.status.textContent = text
    this.status.dataset['kind'] = kind
  }

  private async refresh(): Promise<void> {
    const seq = ++this.loadSeq
    this.setStatus('Loading…')
    const r = await fetchTop(25)
    if (seq !== this.loadSeq) return
    if (!r.ok) {
      this.setStatus(r.error, 'error')
      return
    }
    if (this.status?.dataset['kind'] !== 'ok')
      this.setStatus(r.value.length ? '' : 'No names yet. Be the first.')
    this.fill(r.value)
  }

  private fill(entries: BoardEntry[]): void {
    const list = this.list
    if (!list) return
    list.innerHTML = ''
    const me = loadName().trim().toLowerCase()
    for (const e of entries) {
      const li = el('li', 'ow-board-entry', list)
      const mine =
        this.myRank !== null ? e.rank === this.myRank : me !== '' && e.name.toLowerCase() === me
      if (mine) li.classList.add('mine')
      el('span', 'ow-board-rank', li, String(e.rank))
      el('span', 'ow-board-who', li, e.name)
      el('span', 'ow-board-total', li, money(e.total))
      el('span', 'ow-board-date', li, dateFmt.format(new Date(e.createdAt)))
    }
  }

  private async submit(
    run: RunResult,
    input: HTMLInputElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    if (this.sent.has(Board.key(run))) return
    const name = cleanName(input.value)
    if (!name) {
      this.setStatus(`Pick a name of 1–${NAME_MAX} characters.`, 'error')
      input.focus()
      return
    }
    saveName(name)
    btn.disabled = true
    btn.textContent = 'Sending…'
    const r = await submitRun(name, run)
    if (!this.isOpen) return
    if (!r.ok) {
      btn.disabled = false
      btn.textContent = this.opts.submitLabel ?? 'Submit'
      this.setStatus(r.error, 'error')
      return
    }
    this.sent.add(Board.key(run))
    this.myRank = r.value.rank
    btn.textContent = 'Submitted'
    this.setStatus(`You’re #${r.value.rank} with ${money(r.value.total)}.`, 'ok')
    this.opts.onSubmitted?.()
    await this.refresh()
  }
}
