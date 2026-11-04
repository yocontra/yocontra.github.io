/**
 * The account panel: sign in with a passkey, sign up with a gunslinger name, the signed-in plate,
 * add a passkey, sign out, and "Hang up your hat" (account deletion) with a typed confirmation
 * built into the panel. Stream D's hub mounts it with `mountAccount(host)`. Owned by stream A.
 */
import './account.css'
import type { PasskeyInfo, Player } from '../contract/auth.ts'
import { licenceCopy, licenceStatus } from '../data/licence.ts'
import { fetchMe } from '../net/api.ts'
import {
  type AuthResult,
  accountInfo,
  addPasskey,
  cancelPendingSignIn,
  currentPlayer,
  deleteAccount,
  onAuthChange,
  passkeysSupported,
  restoreSession,
  signIn,
  signOut,
  signUp,
} from '../net/auth.ts'

export interface AccountPanelOptions {
  /** Shows a close button and handles Escape. */
  onClose?: () => void
  /**
   * The signed-in player's `gauntletClears`, when the host already has their profile (the hub
   * does). Without it the panel asks `/me` itself before it says whether they hold a licence.
   */
  gauntletClears?: number | null
}

export interface AccountPanel {
  dispose: () => void
}

type View = 'guest' | 'player' | 'confirm-delete'
type StatusKind = 'info' | 'error' | 'ok'

const NAME_MAX = 16
const NAME_CHARS = /^[\p{L}\p{N} ._'-]+$/u
const SPACES = /\s+/gu
const NOT_ALNUM = /[^\p{L}\p{N}]/gu
const MARKS = /\p{M}/gu

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** Same tidy-up the server does, for instant feedback. The server stays the judge. */
function tidyName(raw: string): string {
  return raw.normalize('NFKC').replace(SPACES, ' ').trim()
}

function nameProblem(name: string): string | null {
  if (name.length === 0) {
    return 'Pick a name.'
  }
  if ([...name].length > NAME_MAX) {
    return `${NAME_MAX} characters or fewer.`
  }
  if (!NAME_CHARS.test(name)) {
    return "Letters, numbers, spaces and . _ ' - only."
  }
  return null
}

const key = (name: string): string =>
  name.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(NOT_ALNUM, '')

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) {
    e.className = cls
  }
  if (text !== undefined) {
    e.textContent = text
  }
  parent.appendChild(e)
  return e
}

function button(parent: HTMLElement, label: string, cls = ''): HTMLButtonElement {
  const b = el('button', `ow-acct-btn ${cls}`.trim(), parent, label)
  b.type = 'button'
  return b
}

class Panel implements AccountPanel {
  private readonly root: HTMLElement
  private readonly opts: AccountPanelOptions
  private view: View = 'guest'
  private busy = false as boolean
  private status: { text: string; kind: StatusKind } = { text: '', kind: 'info' }
  private passkeys: PasskeyInfo[] | null = null
  private draftName = ''
  private readonly off: (() => void)[] = []
  private disposed = false as boolean
  /** The licence bits of the signed-in account, once known; loaded at most once per account. */
  private clears: { accountId: string; value: number } | null = null
  private clearsLoading: string | null = null

  constructor(host: HTMLElement, opts: AccountPanelOptions) {
    this.opts = opts
    this.root = el('section', 'ow-acct', host)
    this.root.setAttribute('aria-label', 'Your account')
    // Typing a name must never walk, draw or pause the game underneath.
    for (const ev of ['keydown', 'keyup', 'pointerdown', 'pointerup'] as const) {
      const stop = (e: Event): void => {
        if (ev === 'keydown' && (e as KeyboardEvent).key === 'Escape' && this.opts.onClose) {
          this.opts.onClose()
        }
        e.stopPropagation()
      }
      this.root.addEventListener(ev, stop)
    }
    this.off.push(onAuthChange((p) => this.onPlayer(p)))
    const known = currentPlayer()
    if (known && typeof opts.gauntletClears === 'number') {
      this.clears = { accountId: known.accountId, value: opts.gauntletClears }
    }
    this.view = known ? 'player' : 'guest'
    this.render()
    void restoreSession().then((p) => this.onPlayer(p))
  }

  dispose(): void {
    this.disposed = true
    cancelPendingSignIn()
    for (const f of this.off) {
      f()
    }
    this.root.remove()
  }

  private onPlayer(p: Player | null): void {
    if (this.disposed || this.busy) {
      return
    }
    let next: View = 'guest'
    if (p) {
      next = this.view === 'confirm-delete' ? 'confirm-delete' : 'player'
    }
    if (next !== this.view || next === 'player') {
      this.view = next
      this.passkeys = next === 'player' ? this.passkeys : null
      this.render()
    }
  }

  private setStatus(text: string, kind: StatusKind = 'info'): void {
    this.status = { text, kind }
    const node = this.root.querySelector<HTMLElement>('.ow-acct-status')
    if (node) {
      node.textContent = text
      node.dataset.kind = kind
    }
  }

  /** Runs one ceremony with the panel locked; reports failures politely. */
  private async run<T>(
    pending: string,
    task: () => Promise<AuthResult<T>>,
  ): Promise<AuthResult<T>> {
    this.busy = true
    this.root.setAttribute('aria-busy', 'true')
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      b.disabled = true
    }
    this.setStatus(pending)
    const result = await task()
    this.busy = false
    this.root.removeAttribute('aria-busy')
    if (this.disposed) {
      return result
    }
    this.status = result.ok
      ? { text: '', kind: 'info' }
      : { text: result.cancelled ? '' : result.error, kind: 'error' }
    return result
  }

  private render(): void {
    this.root.replaceChildren()
    this.root.dataset.view = this.view
    const head = el('div', 'ow-acct-head', this.root)
    const titles: Record<View, string> = {
      guest: 'Sign in',
      player: 'Signed in',
      'confirm-delete': 'Delete account',
    }
    el('h2', 'ow-acct-title', head, titles[this.view])
    if (this.opts.onClose) {
      const close = el('button', 'ow-acct-close', head, '×')
      close.type = 'button'
      close.setAttribute('aria-label', 'Close')
      close.addEventListener('click', () => this.opts.onClose?.())
    }
    if (this.view === 'guest') {
      this.renderGuest()
    } else if (this.view === 'player') {
      this.renderPlayer()
    } else {
      this.renderConfirm()
    }
    const status = el('p', 'ow-acct-status', this.root, this.status.text)
    status.dataset.kind = this.status.kind
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
  }

  private renderGuest(): void {
    if (!passkeysSupported()) {
      el(
        'p',
        'ow-acct-lede',
        this.root,
        'This browser can’t use passkeys. Online play is off, but Quick Draw works.',
      )
      return
    }
    el(
      'p',
      'ow-acct-lede',
      this.root,
      'Use your face, fingerprint or device PIN. No password or email.',
    )
    const signInBtn = button(this.root, 'Sign in with a passkey', 'primary')
    signInBtn.addEventListener('click', () => void this.doSignIn(false))
    el('div', 'ow-acct-or', this.root, 'New here?')
    this.renderSignUp()
    el(
      'p',
      'ow-acct-note',
      this.root,
      'Your name is public. Everyone sees it on posters and leaderboards.',
    )
    // Offer saved passkeys in the name field's autofill, too.
    void this.doSignIn(true)
  }

  private renderSignUp(): void {
    const form = el('form', 'ow-acct-form', this.root)
    form.noValidate = true
    const label = el('label', 'ow-acct-label', form, 'Name')
    const input = el('input', 'ow-acct-input', label)
    input.name = 'username'
    input.autocomplete = 'username webauthn'
    input.maxLength = NAME_MAX * 2
    input.placeholder = 'e.g. Calamity Jane'
    input.spellcheck = false
    input.autocapitalize = 'words'
    input.enterKeyHint = 'go'
    input.value = this.draftName
    const hint = el('div', 'ow-acct-hint', form)
    const hintText = el('span', '', hint, "Letters, numbers, spaces, . _ ' -")
    const count = el('span', '', hint)
    const update = (): void => {
      this.draftName = input.value
      const n = [...tidyName(input.value)].length
      count.textContent = `${n}/${NAME_MAX}`
      const problem = input.value ? nameProblem(tidyName(input.value)) : null
      input.setAttribute('aria-invalid', problem ? 'true' : 'false')
      hintText.textContent = problem ?? "Letters, numbers, spaces, . _ ' -"
    }
    input.addEventListener('input', update)
    update()
    const submit = button(form, 'Sign up', '')
    submit.type = 'submit'
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const name = tidyName(input.value)
      const problem = nameProblem(name)
      if (problem) {
        this.setStatus(problem, 'error')
        input.focus()
        return
      }
      void this.doSignUp(name)
    })
  }

  private async doSignIn(conditional: boolean): Promise<void> {
    if (conditional) {
      // Quiet: resolves only if the player picks a passkey from autofill.
      const r = await signIn({ conditional: true })
      if (r.ok && !this.disposed) {
        this.view = 'player'
        this.status = { text: `Welcome back, ${r.value.name}.`, kind: 'ok' }
        this.render()
      }
      return
    }
    const r = await this.run('Waiting for your passkey…', () => signIn())
    this.view = r.ok ? 'player' : 'guest'
    this.render()
  }

  private async doSignUp(name: string): Promise<void> {
    const r = await this.run(`Making a passkey for ${name}…`, () => signUp(name))
    if (r.ok) {
      this.draftName = ''
      this.view = 'player'
      this.status = { text: `Welcome, ${r.value.name}.`, kind: 'ok' }
    }
    this.render()
  }

  private renderPlayer(): void {
    const p = currentPlayer()
    const plate = el('div', 'ow-acct-plate', this.root)
    // Never claim a licence we haven't checked: plain "Gunslinger" until the clears are known.
    const kicker = el('span', 'ow-acct-plate-kicker', plate, 'Gunslinger')
    el('span', 'ow-acct-plate-name', plate, p?.name ?? '…')
    const sub = el('span', 'ow-acct-plate-sub', plate, 'Signed in with a passkey')
    const progress = el('span', 'ow-acct-plate-licence', plate)
    progress.hidden = true
    this.fillLicence(p, kicker, progress)
    const list = el('ul', 'ow-acct-keys', this.root)
    list.setAttribute('aria-label', 'Your passkeys')
    this.fillPasskeys(list, sub)
    const btns = el('div', 'ow-acct-btns', this.root)
    button(btns, 'Add a passkey').addEventListener('click', () => void this.doAddPasskey())
    button(btns, 'Sign out').addEventListener('click', () => void this.doSignOut())
    const del = button(this.root, 'Delete account', 'danger quiet')
    del.addEventListener('click', () => {
      this.view = 'confirm-delete'
      this.status = { text: '', kind: 'info' }
      this.render()
    })
  }

  /** The licence line: "Licensed gunslinger", or how many outlaws are left to earn it. */
  private fillLicence(p: Player | null, kicker: HTMLElement, progress: HTMLElement): void {
    const paint = (clears: number): void => {
      const copy = licenceCopy(licenceStatus(clears))
      kicker.textContent = copy.kicker
      progress.textContent = copy.progress ?? ''
      progress.hidden = copy.progress === null
    }
    if (!p) {
      return
    }
    if (this.clears?.accountId === p.accountId) {
      paint(this.clears.value)
      return
    }
    if (this.clearsLoading === p.accountId) {
      return
    }
    this.clearsLoading = p.accountId
    void fetchMe().then((r) => {
      this.clearsLoading = null
      if (this.disposed || !r.ok || typeof r.value.gauntletClears !== 'number') {
        return
      }
      this.clears = { accountId: p.accountId, value: r.value.gauntletClears }
      if (kicker.isConnected) {
        paint(r.value.gauntletClears)
      } else if (this.view === 'player') {
        this.render()
      }
    })
  }

  private fillPasskeys(list: HTMLElement, sub: HTMLElement): void {
    const paint = (keys: PasskeyInfo[]): void => {
      list.replaceChildren()
      sub.textContent = keys.length === 1 ? '1 passkey' : `${keys.length} passkeys`
      for (const [i, k] of keys.entries()) {
        const li = el('li', '', list)
        el('span', '', li, k.label ?? `Passkey ${i + 1}${k.backedUp ? ' · synced' : ''}`)
        el(
          'span',
          '',
          li,
          k.lastUsedAt
            ? `used ${dateFmt.format(k.lastUsedAt)}`
            : `added ${dateFmt.format(k.createdAt)}`,
        )
      }
    }
    if (this.passkeys) {
      paint(this.passkeys)
      return
    }
    void accountInfo().then((r) => {
      if (r.ok && !this.disposed) {
        this.passkeys = r.value.passkeys
        paint(r.value.passkeys)
      }
    })
  }

  private async doAddPasskey(): Promise<void> {
    const r = await this.run('Waiting for the new passkey…', () => addPasskey())
    if (r.ok) {
      this.passkeys = r.value
      this.status = { text: 'Passkey added. Sign in with either one.', kind: 'ok' }
    }
    this.render()
  }

  private async doSignOut(): Promise<void> {
    await this.run('Signing out…', async () => {
      await signOut()
      return { ok: true, value: null }
    })
    this.view = 'guest'
    this.passkeys = null
    this.status = { text: 'Signed out. Your passkey will sign you back in.', kind: 'ok' }
    this.render()
  }

  private renderConfirm(): void {
    const name = currentPlayer()?.name ?? ''
    const warn = el('p', 'ow-acct-warn', this.root)
    el('b', '', warn, 'This can’t be undone. ')
    warn.append(
      `This deletes ${name}’s purse, kit, ghost, passkeys and history. Past duels stay, without your name. No one can take the name for 30 days.`,
    )
    const form = el('form', 'ow-acct-form', this.root)
    form.noValidate = true
    const label = el('label', 'ow-acct-label', form, `Type ${name} to confirm`)
    const input = el('input', 'ow-acct-input', label)
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('autocapitalize', 'off')
    const btns = el('div', 'ow-acct-btns', form)
    const go = button(btns, 'Delete forever', 'danger primary')
    go.type = 'submit'
    go.disabled = true
    const keep = button(btns, 'Keep my account')
    keep.addEventListener('click', () => {
      this.view = 'player'
      this.status = { text: '', kind: 'info' }
      this.render()
    })
    input.addEventListener('input', () => {
      go.disabled = key(input.value) !== key(name) || key(name) === ''
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      if (!go.disabled) {
        void this.doDelete()
      }
    })
    el('p', 'ow-acct-note', this.root, 'Your passkey will ask once more to confirm it’s you.')
    requestAnimationFrame(() => input.focus())
  }

  private async doDelete(): Promise<void> {
    const r = await this.run('Confirm with your passkey…', () => deleteAccount())
    if (r.ok) {
      this.view = 'guest'
      this.passkeys = null
      this.status = { text: 'Account deleted.', kind: 'ok' }
    }
    this.render()
  }
}

/** Renders the account panel into `host`. Call `dispose()` when the hub closes it. */
export function mountAccount(host: HTMLElement, opts: AccountPanelOptions = {}): AccountPanel {
  return new Panel(host, opts)
}
