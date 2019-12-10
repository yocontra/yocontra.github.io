/* random words scene */
function RandomSlogans(ctx) {
  this.context = ctx
  this.throttle = 40
  this.messages = [
    'For Everyone',
    'Win With Warren',
    'One Nation. One Destiny',
    'Focus on the Future',
    'Lead with Love',
    'For The People',
    'We Rise',
    'Not me. Us',
    "We're all in this together",
    'Brave Wins',
    'Our Moment',
    'Humanity First',
    'Not left. Not right. Forward',
    'Join the Evolution!',
    'A Fresh Start for America',
    'Our Future Is Now',
    'Building Opportunity Together',
    'Go Big. Be Bold. Do Good',
    'Working People First',
    'Stand Tall',
    'Together, We Rise'
  ]
}

RandomSlogans.prototype.tick = function(cb) {
  var txt = this.messages[randomBetween(0, this.messages.length - 1)]
  var loc = randomLocation(this.context)
  var fontSize = randomBetween(30, 80)

  this.context.font = 'bold ' + fontSize + 'px Arial'
  this.context.shadowColor = 'black'
  this.context.shadowOffsetX = 5
  this.context.shadowOffsetY = 5
  this.context.shadowBlur = 0
  this.context.rotate(randomBetween(-1, 1, false))
  this.context.fillStyle = randomLinearGradient(this.context, loc)
  this.context.fillText(txt, loc.x, loc.y, this.context.canvas.width)
  schedule(cb, this.throttle)
}

/* random orbs scene */
function RandomLogos(ctx) {
  this.context = ctx
  this.throttle = 30
  this.logos = [
    'https://i.imgur.com/rH8YhDY.png',
    'https://i.imgur.com/8UohASg.png',
    'https://i.imgur.com/6zVctiX.png',
    'https://i.imgur.com/OjX8ET3.jpg',
    'https://i.imgur.com/RvotC7B.png',
    'https://i.imgur.com/9jqXCM1.png',
    'https://i.imgur.com/2qQGH4V.png',
    'https://i.imgur.com/bnps2zg.png',
    'https://i.imgur.com/b4x4Ma4.png',
    'https://i.imgur.com/OEzBlo9.png',
    'https://i.imgur.com/obJJTHD.png',
    'https://i.imgur.com/tXLq5xk.jpg',
    'https://i.imgur.com/gjNZKJ7.png',
    'https://i.imgur.com/YIPphix.png',
    'https://i.imgur.com/uVkBuLf.png',
    'https://i.imgur.com/xh2wbiC.jpg',
    'https://i.imgur.com/zhgQL7p.jpg',
    'https://i.imgur.com/8fIdmGF.jpg'
  ]
}

RandomLogos.prototype.tick = function(cb) {
  var logo = this.logos[randomBetween(0, this.logos.length - 1)]
  var loc = randomLocation(this.context)
  var imgEl = getImage(logo, 5, 20)
  this.context.drawImage(imgEl, loc.x, loc.y)
  schedule(cb, this.throttle)
}

/* random imgs scene */
function RandomFaces(ctx) {
  this.context = ctx
  this.throttle = 0
  this.images = [
    'https://i.imgur.com/8slJMlD.png',
    'https://i.imgur.com/QHNn7aU.png',
    'https://i.imgur.com/H7G36A9.png',
    'https://i.imgur.com/oj2bEJ4.png',
    'https://i.imgur.com/TNrRSMH.png',
    'https://i.imgur.com/O7uAGQa.png',
    'https://i.imgur.com/v8MNaJU.png',
    'https://i.imgur.com/LDubt5v.png',
    'https://i.imgur.com/wwk1HQZ.png',
    'https://i.imgur.com/NpvTmZ2.png',
    'https://i.imgur.com/GQZqOcf.png',
    'https://i.imgur.com/tgDgyvb.png',
    'https://i.imgur.com/T8s9S1A.png',
    'https://i.imgur.com/tUBQyY9.png',
    'https://i.imgur.com/XPBYEfB.png',
    'https://i.imgur.com/ADeIE5g.png',
    'https://i.imgur.com/AKdI45U.png',
    'https://i.imgur.com/Sd5rO7B.png',
    'https://i.imgur.com/0vdYe7j.png',
    'https://i.imgur.com/ditXM5z.png',
    'https://i.imgur.com/Dx3DprQ.png',
    'https://i.imgur.com/2S9TUF0.png',
    'https://i.imgur.com/bLSgefN.png'
  ]
}

RandomFaces.prototype.tick = function(cb) {
  var img = this.images[randomBetween(0, this.images.length - 1)]
  var loc = randomLocation(this.context)
  var imgEl = getImage(img, 15, 40)
  this.context.drawImage(imgEl, loc.x, loc.y)
  schedule(cb, this.throttle)
}

/* utilities */
function schedule(fn, time) {
  if (time > 16) return setTimeout(fn, time)
  requestAnimationFrame(fn)
}
function randomLocation(ctx) {
  return {
    x: randomBetween(0, ctx.canvas.width),
    y: randomBetween(0, ctx.canvas.height)
  }
}

function randomBetween(min, max, floor) {
  floor = typeof floor === 'boolean' ? floor : true
  var rand = Math.random() * (max - min + 1) + min
  if (floor) return Math.floor(rand)
  return rand
}

function randomColor() {
  var r = randomBetween(0, 256)
  var g = randomBetween(0, 256)
  var b = randomBetween(0, 256)
  return color(r, g, b)
}

function randomLinearGradient(ctx, loc) {
  var span = 100
  var gradient = ctx.createLinearGradient(
    loc.x - span,
    loc.y - span,
    loc.x + span,
    loc.y + span
  )
  gradient.addColorStop(0, randomColor())
  gradient.addColorStop(1, randomColor())
  return gradient
}

function getImage(url, minRatio, maxRatio) {
  var ratio = randomBetween(minRatio, maxRatio)
  var img = document.createElement('img')
  img.style.maxWidth = ratio + '%'
  img.style.maxHeight = ratio + '%'
  img.src = url
  return img
}

function color(r, g, b) {
  return 'rgb(' + r + ',' + g + ',' + b + ')'
}

var filters = {
  saturate: function() {
    return 'saturate(' + randomBetween(1, 5) + ')'
  },
  contrast: function() {
    return 'contrast(' + randomBetween(1, 5) + ')'
  },
  'hue-rotate': function() {
    return 'hue-rotate(' + randomBetween(100, 200) + 'deg)'
  }
}

function trip(el) {
  var randomFilter = Object.keys(filters)
    .map(function(k) {
      var fn = filters[k]
      return fn()
    })
    .join(' ')

  el.style['filter'] = randomFilter
}

/* internal to scene player */
var scenes = [RandomSlogans, RandomLogos, RandomFaces]

function startUp() {
  var can = document.getElementById('content')
  var ctx = can.getContext('2d')
  var container = $(can).parent()

  var resize = function() {
    can.width = container.width()
    can.height = container.height()
  }

  resize()
  $(window).resize(resize)
  scenes.forEach((scene) => runScene(scene, ctx))
  setInterval(trip.bind(null, can), 1000)
}

function runScene(scene, ctx) {
  var inst = new scene(ctx)
  var tick = function() {
    inst.tick(tick)
  }
  tick()
}


function begin() {
  document.body.removeEventListener('click', begin)
  document.body.className += 'started'
  document.getElementById('music').play()
  document.getElementById('pete').play()
  startUp()
}
document.body.addEventListener('click', begin)
