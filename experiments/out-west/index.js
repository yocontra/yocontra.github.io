// constants
const msgEl = document.createElement('div')
const header = document.querySelectorAll('.header')[0]
const game = document.querySelectorAll('.game')[0]
const ctx = game.getContext('2d')
const maxSpeed = 5
const maxPaces = 200
const minPaces = 100
const difficulty = 0.8
const friction = 0.65
const names = [
  'Bret P. Barsh',
  'Prescott J. House',
  'Calhoun C. Trine',
  'Ace Q. McConly',
  'Burney N. Coover',
  'Salvador R. Gruell',
  'Felipe K. Wheeler',
  'Laura Bullion',
  'Thomas B. Arnold',
  'Delmer F. Gusselman',
  'Pearl Hart',
  'Luke Short',
  'Dallas Stoudenmire',
  'Harvey “Kid Curry” Logan',
  'James “Wild Bill” Hickok',
  'Underboss: William “Curly Bill” Brocius',
  'Boss: John Wesley Hardin'
]

const music = document.createElement('audio')
music.loop = true
music.autoplay = true
music.volume = 0.9

const playerFire = document.createElement('img')
playerFire.src = './assets/player-fire.png'
const playerWalk = document.createElement('img')
playerWalk.src = './assets/player-walk.png'
const enemyFire = document.createElement('img')
enemyFire.src = './assets/enemy-fire.png'
const enemyWalk = document.createElement('img')
enemyWalk.src = './assets/enemy-walk.png'

// state
let showdownTimer = null
let paces = null
let drawTime = 1000
let level = -1
let showdown = false
let playing = false
let movement = 0
let msgTimeout = null
const keys = {}

// models
const enemy = {
  color: 'black',
  x: null,
  firing: false,
  width: 160,
  height: 230,
  init: () => {
    enemy.firing = false
    enemy.x = (game.width / 2) + enemy.width
  },
  draw: (ctx) => {
    ctx.drawImage(enemy.firing ? enemyFire : enemyWalk, enemy.x, game.height / 2, player.width, player.height)
  }
}
const player = {
  speedX: 0,
  x: null,
  firing: false,
  width: 160,
  height: 230,
  init: () => {
    player.firing = false
    player.x = (game.width / 2) - player.width * 2
  },
  update: () => {
    // check key state
    if (playing && keys[37] && player.speedX > -maxSpeed) player.speedX--

    // apply some friction
    player.speedX *= friction
    player.x += player.speedX
    enemy.x -= player.speedX
    movement += player.speedX

    if (-movement >= paces) ensureShowdown()

    // constrain to bounds
    player.x = Math.max(0, Math.min(game.width - player.width, player.x))
    player.y = Math.max(0, Math.min(game.height - player.height, player.y))
  },
  draw: (ctx) => {
    ctx.drawImage(player.firing ? playerFire : playerWalk, player.x, game.height / 2, player.width, player.height)
  }
}


// render loop
const update = () => {
  player.update()
}
const draw = () => {
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, game.width, game.height)
  player.draw(ctx)
  enemy.draw(ctx)
}
const loop = () => {
  requestAnimationFrame(loop)
  update()
  draw()
}

// other stuff
const showMessage = (msg, time) => {
  msgEl.innerText = msg
  msgEl.className = 'game-message'

  if (msgTimeout) clearTimeout(msgTimeout)
  if (time) {
    msgTimeout = setTimeout(() =>
      msgEl.className += ' hidden'
    , time)
  }
}
const playSound = (fname) => {
  const a = document.createElement('audio')
  a.src = fname
  a.play()
}
const ensureShowdown = () => {
  if (showdown || !playing) return
  const delay = Math.max(20, drawTime)
  playSound('./assets/whip.wav')
  showdown = true
  showMessage('draw', delay)
  setTimeout(() => shoot('enemy'), delay)
}
const shoot = (shooter) => {
  if (!playing) return
  if (shooter === 'player') player.firing = true
  if (shooter === 'enemy') enemy.firing = true
  playSound(shooter === 'player'
    ? './assets/fire.wav'
    : './assets/fire-big.wav')
  endLevel(showdown ? shooter : 'enemy')
}
const startLevel = (retry) => {
  if (!retry) {
    ++level
    drawTime *= difficulty
    console.log(drawTime)
    if (level === names.length - 2) {
      playSong('./assets/boss.mp3') // final bosses song
    }
  }
  const name = names[level]
  if (!name) return win()
  showMessage(name, 2000)
  // reset
  paces = Math.floor(Math.random() * maxPaces) + minPaces
  movement = 0
  showdown = false
  playSound('./assets/cocking.wav')
  setTimeout(() => {
    playSound('./assets/cocking.wav')
    playing = true
  }, 2000)
  player.init()
  enemy.init()
}
const endLevel = (winner) => {
  playing = false
  if (showdown) {
    if (winner === 'player') {
      showMessage('you win', 3000)
      playSound('./assets/shout.wav')
    } else {
      showMessage('you lose', 3000)
    }
  } else {
    showMessage('coward, you lose', 2000)
  }
  setTimeout(() => startLevel(winner === 'enemy'), 3000)
}
const win = () => {
  showMessage("you're the fastest hand in the west!")
}
const start = () => {
  setGameSize()
  header.style.display = 'none'
  game.style.display = 'initial'
  document.body.appendChild(msgEl)

  console.log(`Height: ${game.height} Width: ${game.width}`)
  startLevel()
  loop()
}
const setGameSize = () => {
  game.height = window.innerHeight
  game.width = window.innerWidth
}

const playSong = (src) => {
  music.src = src
  music.play()
}

// event logic
window.addEventListener('resize', setGameSize)
document.body.addEventListener('keydown', (e) => {
  if (e.keyCode === 32) shoot('player')
  keys[e.keyCode] = true
})
document.body.addEventListener('keyup', (e) => {
  keys[e.keyCode] = false
})

// init
const begin = (e) => {
  document.body.removeEventListener('click', begin)
  document.body.className += 'started'
  playSong('./assets/intro.mp3')
  setTimeout(start, 13000)
}
document.body.addEventListener('click', begin)
