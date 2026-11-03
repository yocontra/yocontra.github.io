import { GameAudio } from './audio'
import {
  COCK_DELAY,
  COWARD_DURATION,
  DIFFICULTY,
  FRICTION,
  INITIAL_DRAW_TIME,
  INTRO_DURATION,
  MAX_PACES,
  MAX_SPEED,
  MIN_DRAW_TIME,
  MIN_PACES,
  MIN_WORLD_WIDTH,
  NAME_DURATION,
  NAMES,
  NEXT_LEVEL_DELAY,
  RESULT_DURATION,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  TICK_MS,
} from './constants'
import { isReady, loadSprites } from './sprites'

type Shooter = 'player' | 'enemy'

interface Actor {
  x: number
  firing: boolean
  readonly width: number
  readonly height: number
}

const query = <T extends Element>(root: ParentNode, selector: string, type: new () => T): T => {
  const el = root.querySelector(selector)
  if (!(el instanceof type)) throw new Error(`out-west: missing ${selector}`)
  return el
}

export const mount = (root: HTMLElement): void => {
  const canvas = query(root, '.game', HTMLCanvasElement)
  const header = query(root, '.header', HTMLElement)
  const walkButton = query(root, '[data-control="walk"]', HTMLButtonElement)
  const fireButton = query(root, '[data-control="fire"]', HTMLButtonElement)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('out-west: 2d canvas unsupported')

  const msgEl = document.createElement('div')
  msgEl.setAttribute('role', 'status')
  msgEl.setAttribute('aria-live', 'assertive')

  const audio = new GameAudio()
  const sprites = loadSprites()

  // world size in logical pixels (see MIN_WORLD_WIDTH)
  const world = { width: 0, height: 0 }

  // state
  let paces = 0
  let drawTime = INITIAL_DRAW_TIME
  let level = -1
  let showdown = false
  let playing = false
  let movement = 0
  let msgTimeout: number | undefined
  let keyWalk = false
  let pointerWalk = false

  // models
  const enemy: Actor = { x: 0, firing: false, width: SPRITE_WIDTH, height: SPRITE_HEIGHT }
  const player: Actor & { speedX: number } = {
    x: 0,
    speedX: 0,
    firing: false,
    width: SPRITE_WIDTH,
    height: SPRITE_HEIGHT,
  }

  const initEnemy = (): void => {
    enemy.firing = false
    enemy.x = world.width / 2 + enemy.width
  }
  const initPlayer = (): void => {
    player.firing = false
    player.x = world.width / 2 - player.width * 2
  }

  const drawActor = (actor: Actor, img: HTMLImageElement): void => {
    if (!isReady(img)) return
    ctx.drawImage(img, actor.x, world.height / 2, actor.width, actor.height)
  }

  // render loop
  const update = (): void => {
    // check key state
    if (playing && (keyWalk || pointerWalk) && player.speedX > -MAX_SPEED) player.speedX--

    // apply some friction
    player.speedX *= FRICTION
    player.x += player.speedX
    enemy.x -= player.speedX
    movement += player.speedX

    if (-movement >= paces) ensureShowdown()

    // constrain to bounds
    player.x = Math.max(0, Math.min(world.width - player.width, player.x))
  }
  const draw = (): void => {
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, world.width, world.height)
    drawActor(player, player.firing ? sprites.playerFire : sprites.playerWalk)
    drawActor(enemy, enemy.firing ? sprites.enemyFire : sprites.enemyWalk)
  }

  // Fixed 60Hz physics so 120Hz phones don't walk twice as fast.
  let last = 0
  let acc = 0
  const loop = (now: number): void => {
    requestAnimationFrame(loop)
    acc += Math.min(250, last ? now - last : TICK_MS)
    last = now
    while (acc >= TICK_MS) {
      update()
      acc -= TICK_MS
    }
    draw()
  }

  // other stuff
  const showMessage = (msg: string, time?: number): void => {
    msgEl.textContent = msg
    msgEl.className = 'game-message'

    window.clearTimeout(msgTimeout)
    if (time) {
      msgTimeout = window.setTimeout(() => msgEl.classList.add('hidden'), time)
    }
  }
  const ensureShowdown = (): void => {
    if (showdown || !playing) return
    const delay = Math.max(MIN_DRAW_TIME, drawTime)
    audio.play('whip')
    showdown = true
    showMessage('draw', delay)
    window.setTimeout(() => shoot('enemy'), delay)
  }
  const shoot = (shooter: Shooter): void => {
    if (!playing) return
    if (shooter === 'player') player.firing = true
    if (shooter === 'enemy') enemy.firing = true
    audio.play(shooter === 'player' ? 'fire' : 'fireBig')
    endLevel(showdown ? shooter : 'enemy')
  }
  const startLevel = (retry = false): void => {
    if (!retry) {
      ++level
      drawTime *= DIFFICULTY
      if (level === NAMES.length - 2) audio.playSong('boss') // final bosses song
    }
    const name = NAMES[level]
    if (!name) {
      win()
      return
    }
    showMessage(name, NAME_DURATION)
    // reset
    paces = Math.floor(Math.random() * MAX_PACES) + MIN_PACES
    movement = 0
    showdown = false
    audio.play('cocking')
    window.setTimeout(() => {
      audio.play('cocking')
      playing = true
    }, COCK_DELAY)
    initPlayer()
    initEnemy()
  }
  const endLevel = (winner: Shooter): void => {
    playing = false
    if (showdown) {
      if (winner === 'player') {
        showMessage('you win', RESULT_DURATION)
        audio.play('shout')
      } else {
        showMessage('you lose', RESULT_DURATION)
      }
    } else {
      showMessage('coward, you lose', COWARD_DURATION)
    }
    window.setTimeout(() => startLevel(winner === 'enemy'), NEXT_LEVEL_DELAY)
  }
  const win = (): void => {
    showMessage('you’re the fastest hand in the west!')
  }

  const setGameSize = (): void => {
    const cssWidth = window.innerWidth
    const cssHeight = window.innerHeight
    const scale = Math.min(1, cssWidth / MIN_WORLD_WIDTH)
    const dpr = window.devicePixelRatio || 1
    world.width = cssWidth / scale
    world.height = cssHeight / scale
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(cssHeight * dpr)
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)
  }

  const start = (): void => {
    setGameSize()
    header.style.display = 'none'
    canvas.style.display = 'initial'
    root.appendChild(msgEl)
    startLevel()
    requestAnimationFrame(loop)
  }

  // event logic
  window.addEventListener('resize', setGameSize)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault()
      shoot('player')
    }
    if (e.code === 'ArrowLeft') keyWalk = true
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft') keyWalk = false
  })
  window.addEventListener('blur', () => {
    keyWalk = false
    pointerWalk = false
  })

  // touch / pointer controls
  const stopWalk = (): void => {
    pointerWalk = false
    walkButton.classList.remove('held')
  }
  walkButton.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    walkButton.setPointerCapture(e.pointerId)
    pointerWalk = true
    walkButton.classList.add('held')
  })
  walkButton.addEventListener('pointerup', stopWalk)
  walkButton.addEventListener('pointercancel', stopWalk)
  walkButton.addEventListener('lostpointercapture', stopWalk)
  fireButton.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    shoot('player')
  })
  for (const button of [walkButton, fireButton]) {
    button.addEventListener('contextmenu', (e) => e.preventDefault())
    // keyboard users already have arrow/space; don't double-fire via click
    button.addEventListener('click', (e) => e.preventDefault())
  }

  // init
  const begin = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('a')) return
    document.removeEventListener('click', begin)
    audio.unlock()
    root.classList.add('started')
    audio.playSong('intro')
    window.setTimeout(start, INTRO_DURATION)
  }
  document.addEventListener('click', begin)
}
