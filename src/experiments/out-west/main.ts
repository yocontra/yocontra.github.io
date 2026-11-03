import { AudioEngine } from './audio/audio'
import { OUTLAWS } from './data/outlaws'
import type { Tier } from './engine/render'
import type { Game } from './game'
import { load, save } from './save'

/**
 * Entry point. Kept tiny so the red title is interactive immediately; the
 * three.js game streams in behind it via a dynamic import.
 */
export function boot(root: HTMLElement): void {
  const audio = new AudioEngine()
  audio.prefetch()
  const data = load()
  const hash = new URLSearchParams(location.hash.slice(1))
  const debug = hash.has('debug')
  window.addEventListener('hashchange', () => location.reload())
  const levelParam = hash.get('level')
  let jump = false
  if (levelParam) {
    const n = Number.parseInt(levelParam, 10)
    if (Number.isFinite(n)) {
      data.level = Math.min(OUTLAWS.length, Math.max(1, n)) - 1
      data.seenIntro = true
      jump = true
      save(data)
    }
  }
  if (hash.has('legend')) data.legend = true
  const coarse = matchMedia('(pointer: coarse)').matches
  const small = Math.min(screen.width, screen.height) < 700
  const tierParam = hash.get('tier')
  const tier: Tier =
    tierParam === 'low' || tierParam === 'high' ? tierParam : coarse || small ? 'low' : 'high'

  const canvas = root.querySelector<HTMLCanvasElement>('canvas.ow-canvas')
  const title = root.querySelector<HTMLElement>('.ow-title')
  const loading = root.querySelector<HTMLElement>('.ow-loading')
  const startText = root.querySelector<HTMLElement>('.ow-start')
  const creditsBtn = root.querySelector<HTMLButtonElement>('.ow-credits-btn')
  const credits = root.querySelector<HTMLElement>('.ow-credits')
  if (!canvas || !title) return

  creditsBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    credits?.classList.toggle('on')
  })
  for (const a of title.querySelectorAll('a, button, .ow-credits')) {
    a.addEventListener('pointerdown', (e) => e.stopPropagation())
  }

  let game: Game | null = null
  let pressed = false
  let started = false

  const setProgress = (f: number) => {
    if (loading) loading.textContent = f >= 1 ? '' : `loading ${Math.round(f * 100)}%`
  }

  const go = () => {
    if (started || !game) return
    started = true
    title.classList.add('wipe')
    setTimeout(() => title.remove(), 1100)
    const g = game
    // Everything is decoded before the first duel; nothing decodes mid-duel.
    void audio.whenDecoded().then(() => g.begin(jump))
  }

  const press = (e: Event) => {
    if (pressed) return
    if (e instanceof KeyboardEvent) {
      if (!['Space', 'Enter', 'KeyJ', 'KeyW', 'ArrowUp', 'ArrowLeft'].includes(e.code)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    pressed = true
    audio.unlock()
    audio.playSong(data.level >= 15 ? 'boss' : 'intro')
    title.classList.add('pressed')
    if (startText) startText.textContent = game ? '' : 'saddling up…'
    go()
  }
  title.addEventListener('pointerdown', press)
  window.addEventListener('keydown', press)

  import('./game')
    .then((m) =>
      m.createGame({ root, canvas, audio, save: data, debug, tier, onProgress: setProgress }),
    )
    .then((g) => {
      game = g
      if (debug) (window as unknown as { __ow: Game }).__ow = g
      if (hash.has('lineup') || hash.has('posters')) {
        title.remove()
        if (hash.has('lineup')) void g.director.lineup(Number(hash.get('day') ?? '0.3'))
        if (hash.has('posters')) void g.director.posters()
        return
      }
      title.classList.add('ready')
      if (startText && pressed) startText.textContent = ''
      if (pressed) go()
    })
    .catch(() => {
      if (loading) loading.textContent = 'This needs WebGL2. Try the 2019 original below.'
    })
}
