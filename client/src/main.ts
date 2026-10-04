import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import {
  CELL,
  EYE_HEIGHT,
  OVERLOAD_MANA,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  REPAIR_MANA,
  SPRINT_MULT,
  WALL_HEIGHT,
  WEAPON_COOLDOWN,
  WEAPON_RANGE,
  cellCenter,
} from '../../shared/constants.ts'
import { generateMaze } from '../../shared/maze.ts'
import { MONSTER_BY_KEY } from '../../shared/monsters.ts'
import type { ClientMsg, GameEvent, MonsterState, PlayerState, ServerMsg } from '../../shared/protocol.ts'
import { initAudio, sfx } from './audio.ts'
import { Effects } from './effects.ts'
import { MonsterView, PlayerView } from './entities.ts'
import { drawMinimap, el, log, showScoreboard, updateStats } from './hud.ts'
import { World } from './world.ts'
import { createGun } from './gun.ts'

// --- Renderer and post-processing -----------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05

const scene = new THREE.Scene()
scene.background = new THREE.Color('#02060b')
scene.fog = new THREE.FogExp2('#02060b', 0.032)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.03, 200)
camera.rotation.order = 'YXZ'
scene.add(camera)
scene.add(new THREE.HemisphereLight('#4a7fa8', '#06080c', 0.35))
const headlight = new THREE.PointLight('#d2f4ff', 14, CELL * 4, 2)
headlight.position.set(0, 0.4, -1.5)
camera.add(headlight)

const gun = createGun()
camera.add(gun.root)

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.5, 0.82)
composer.addPass(bloom)
composer.addPass(new OutputPass())
const screenFx = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uDamage: { value: 0 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uDamage; varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      float ab = 0.004 + uDamage * 0.012;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + c * ab).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - c * ab).b);
      col *= 0.965 + 0.035 * sin(vUv.y * 800.0 + uTime * 8.0);
      col *= 1.0 - d * 1.1;
      col = mix(col, col * vec3(1.5, 0.45, 0.45), clamp(uDamage, 0.0, 1.0) * 0.45);
      gl_FragColor = vec4(col, 1.0);
    }`,
})
composer.addPass(screenFx)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
})

const effects = new Effects(scene)

// --- Game state -------------------------------------------------------------
let world: World | null = null
let ws: WebSocket | null = null
let myId = ''
let me: PlayerState | null = null
let playing = false
let chatting = false
const monsterViews = new Map<string, MonsterView>()
const playerViews = new Map<string, PlayerView>()
let allPlayers: PlayerState[] = []

const pos = new THREE.Vector3()
const vel = new THREE.Vector3()
let yaw = 0
let pitch = 0
let lastShot = 0
let damage = 0
let shake = 0
let bob = 0
let stepTimer = 0
let sendTimer = 0
let mapTimer = 0
let revealTimer = 0
const keys = new Set<string>()

// Attract mode: a small local maze slowly orbits behind the menu.
let demoAngle = 0
function setWorld(next: World) {
  if (world) {
    world.group.removeFromParent()
    world.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      mesh.geometry?.dispose()
    })
  }
  world = next
  scene.add(world.group)
}
setWorld(new World(generateMaze(9, 9, 7)))
const demoSpot = (() => {
  const w = world!
  let best: [number, number] = [1, 1]
  let bestScore = -1
  for (let z = 1; z < w.height - 1; z++)
    for (let x = 1; x < w.width - 1; x++) {
      if (w.isWall(x, z)) continue
      let open = 0
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!w.isWall(x + dx, z + dz)) open++
      const score = open * 100 - Math.hypot(x - w.width / 2, z - w.height / 2)
      if (score > bestScore) {
        bestScore = score
        best = [x, z]
      }
    }
  return new THREE.Vector3(cellCenter(best[0]), 2.1, cellCenter(best[1]))
})()

function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// --- Networking ---------------------------------------------------------------
function connect() {
  const name = el.name.value.trim()
  try {
    localStorage.setItem('spacemyst.name', name)
  } catch {
    /* storage may be unavailable */
  }
  el.play.disabled = true
  el.menuStatus.textContent = 'Kopplar upp…'
  initAudio()
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  ws = new WebSocket(url)
  ws.onopen = () => send({ t: 'join', name })
  ws.onmessage = (e) => onServer(JSON.parse(e.data) as ServerMsg)
  ws.onclose = () => {
    playing = false
    el.play.disabled = false
    el.hud.classList.add('hidden')
    el.menu.classList.remove('hidden')
    el.menuStatus.textContent = 'Anslutningen bröts. Försök igen.'
    document.exitPointerLock()
  }
}

function onServer(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome': {
      myId = msg.you
      setWorld(new World(msg.world))
      for (const v of monsterViews.values()) v.dispose()
      for (const v of playerViews.values()) v.dispose()
      monsterViews.clear()
      playerViews.clear()
      pos.set(msg.spawn.x, 0, msg.spawn.z)
      faceOpenCorridor()
      playing = true
      el.menu.classList.add('hidden')
      el.hud.classList.remove('hidden')
      el.menuStatus.textContent = ''
      log('Uppkopplad. Rensa nätet från skadlig kod.', 'lvl')
      lockPointer()
      return
    }
    case 'snap':
      onSnapshot(msg.players, msg.monsters)
      return
    case 'events':
      msg.list.forEach(onEvent)
      return
    case 'correct':
      pos.set(msg.x, 0, msg.z)
      vel.set(0, 0, 0)
      return
  }
}

function faceOpenCorridor() {
  if (!world) return
  let best = 0
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const d = world.rayWall(pos.x, pos.z, -Math.sin(a), -Math.cos(a), 60)
    if (d > best) {
      best = d
      yaw = a
    }
  }
  pitch = 0
}

function onSnapshot(players: PlayerState[], monsters: MonsterState[]) {
  allPlayers = players
  const seen = new Set<string>()
  for (const p of players) {
    if (p.id === myId) {
      const wasDead = me && me.hp <= 0
      me = p
      if (wasDead && p.hp > 0) {
        el.dead.classList.add('hidden')
        faceOpenCorridor()
      }
      continue
    }
    seen.add(p.id)
    let v = playerViews.get(p.id)
    if (!v) {
      v = new PlayerView(p)
      playerViews.set(p.id, v)
      scene.add(v.root)
    }
    v.apply(p)
  }
  for (const [id, v] of playerViews) if (!seen.has(id)) (v.dispose(), playerViews.delete(id))

  const seenM = new Set<string>()
  for (const m of monsters) {
    seenM.add(m.id)
    let v = monsterViews.get(m.id)
    if (!v) {
      v = new MonsterView(m)
      monsterViews.set(m.id, v)
      scene.add(v.root)
    }
    v.apply(m)
  }
  for (const [id, v] of monsterViews) if (!seenM.has(id)) (v.dispose(), monsterViews.delete(id))

  if (me) updateStats(me, players.length)
  if (!el.scoreboard.classList.contains('hidden')) showScoreboard(allPlayers)
}

const tmp = new THREE.Vector3()
function onEvent(e: GameEvent) {
  switch (e.kind) {
    case 'shot': {
      if (e.by === myId) return
      const shooter = playerViews.get(e.by)
      const color = shooter ? shooter.color : new THREE.Color('#5cf2ff')
      effects.beam(new THREE.Vector3(e.x, 1.35, e.z), new THREE.Vector3(e.tx, 1.2, e.tz), e.overload ? '#ff4fd8' : color, e.overload ? 0.09 : 0.04)
      const d = Math.hypot(e.x - pos.x, e.z - pos.z)
      if (d < CELL * 8) {
        const rel = Math.atan2(e.x - pos.x, e.z - pos.z) - yaw
        sfx.remoteShot(Math.max(-1, Math.min(1, -Math.sin(rel))), 1 - d / (CELL * 8))
      }
      return
    }
    case 'hit': {
      const v = monsterViews.get(e.monster)
      if (!v) return
      v.hit()
      v.sprite.getWorldPosition(tmp)
      tmp.y += v.tpl.size * 0.4
      effects.number(tmp, String(e.dmg), e.by === myId ? '#ffd34d' : '#ffffff')
      if (e.by === myId) sfx.hit()
      return
    }
    case 'kill': {
      const v = monsterViews.get(e.monster)
      if (v) {
        v.sprite.getWorldPosition(tmp)
        effects.burst(tmp.clone(), v.tpl.color, 90, 7)
        v.dispose()
        monsterViews.delete(e.monster)
      }
      if (e.by === myId) {
        sfx.kill()
        log(`Du raderade ${e.name}. +${e.coins} krediter`, 'kill')
      } else log(`${e.byName} raderade ${e.name}.`, 'kill')
      return
    }
    case 'bite': {
      if (e.player !== myId) return
      const v = monsterViews.get(e.monster)
      const name = v?.tpl.name ?? 'Något'
      if (e.miss) {
        sfx.miss()
        log(`${name} missar dig.`, 'sys')
        return
      }
      damage = Math.min(0.8, damage + 0.2 + e.dmg / 60)
      shake = Math.min(0.35, shake + 0.08 + e.dmg / 120)
      sfx.hurt()
      log(e.special ? `${name} använder ${e.special}! −${e.dmg} HP` : `${name} träffar dig. −${e.dmg} HP`, 'hurt')
      return
    }
    case 'death': {
      if (e.player === myId) {
        sfx.death()
        el.deadMsg.textContent = `Raderad av ${e.killer}. Du tappar hälften av dina krediter.`
        el.dead.classList.remove('hidden')
        log(`Du raderades av ${e.killer}.`, 'hurt')
      } else log(`${e.name} raderades av ${e.killer}.`, 'hurt')
      return
    }
    case 'levelup': {
      if (e.player === myId) {
        sfx.levelup()
        effects.burst(pos.clone().setY(1), '#5cf2ff', 140, 9)
        log(`NIVÅ ${e.level}! Systemet uppgraderat.`, 'lvl')
      } else log(`${e.name} nådde nivå ${e.level}.`, 'lvl')
      return
    }
    case 'repair':
      if (e.player === myId) {
        sfx.repair()
        log(`Nanoreparation +${e.amount} HP`, 'lvl')
      }
      return
    case 'chat':
      log(`${e.name}: ${e.text}`, 'chat')
      return
    case 'system':
      log(e.text, 'sys')
      return
  }
}

// --- Input ----------------------------------------------------------------------
const locked = () => document.pointerLockElement === canvas

el.play.addEventListener('click', connect)
el.name.addEventListener('keydown', (e) => e.key === 'Enter' && connect())
try {
  el.name.value = localStorage.getItem('spacemyst.name') ?? ''
} catch {
  /* ignore */
}

/** Browsers can refuse pointer lock (no recent click, or right after Esc), so fall back to the pause screen. */
function lockPointer() {
  try {
    const request = canvas.requestPointerLock() as unknown
    if (request instanceof Promise) request.catch(showPaused)
  } catch {
    showPaused()
  }
}
function showPaused() {
  if (!playing || chatting || locked()) return
  el.paused.classList.remove('hidden')
  el.paused.style.pointerEvents = 'auto'
}

canvas.addEventListener('click', () => {
  if (playing && !locked() && !chatting) lockPointer()
})
el.paused.addEventListener('click', lockPointer)
document.addEventListener('pointerlockchange', () => {
  el.paused.classList.toggle('hidden', locked() || !playing || chatting)
  el.paused.style.pointerEvents = locked() ? 'none' : 'auto'
})
document.addEventListener('pointerlockerror', showPaused)

document.addEventListener('mousemove', (e) => {
  if (!locked()) return
  yaw -= e.movementX * 0.0022
  pitch = Math.max(-1.35, Math.min(1.35, pitch - e.movementY * 0.0022))
  gun.sway(e.movementX, e.movementY)
})

document.addEventListener('mousedown', (e) => {
  if (!locked() || !playing) return
  if (e.button === 0) shoot(false)
  if (e.button === 2) shoot(true)
})
document.addEventListener('contextmenu', (e) => playing && e.preventDefault())

document.addEventListener('keydown', (e) => {
  if (chatting) {
    if (e.key === 'Enter') {
      const text = el.chat.value.trim()
      if (text) send({ t: 'chat', text })
      closeChat()
    } else if (e.key === 'Escape') closeChat()
    return
  }
  if (!playing) return
  if (e.key === 'Tab') {
    e.preventDefault()
    showScoreboard(allPlayers)
    el.scoreboard.classList.remove('hidden')
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    chatting = true
    keys.clear()
    el.chat.classList.remove('hidden')
    el.chat.value = ''
    document.exitPointerLock()
    setTimeout(() => el.chat.focus(), 0)
    return
  }
  keys.add(e.code)
  if (e.code === 'KeyQ' && locked()) shoot(true)
  if (e.code === 'KeyE' && locked()) {
    if (me && me.mana >= REPAIR_MANA && me.hp < me.maxHp) send({ t: 'repair' })
    else sfx.empty()
  }
})
document.addEventListener('keyup', (e) => {
  keys.delete(e.code)
  if (e.key === 'Tab') el.scoreboard.classList.add('hidden')
})

function closeChat() {
  chatting = false
  el.chat.blur()
  el.chat.classList.add('hidden')
  lockPointer()
}

// --- Shooting -------------------------------------------------------------------
const raycaster = new THREE.Raycaster()
const aimCam = new THREE.PerspectiveCamera()
aimCam.rotation.order = 'YXZ'

/** Finds what the crosshair is on: the nearest monster in front of any wall. */
function aim() {
  // Built from yaw and pitch rather than the camera, so input that arrives between
  // frames aims correctly and screen shake doesn't throw shots off.
  const origin = new THREE.Vector3(pos.x, EYE_HEIGHT, pos.z)
  const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  raycaster.set(origin, dir)
  // Sprites face the camera, so the hit test needs a camera that matches this ray.
  aimCam.position.copy(origin)
  aimCam.rotation.set(pitch, yaw, 0)
  aimCam.updateMatrixWorld()
  raycaster.camera = aimCam
  raycaster.far = WEAPON_RANGE
  const horiz = Math.hypot(dir.x, dir.z)
  let wallDist = WEAPON_RANGE
  if (world && horiz > 1e-4) wallDist = world.rayWall(origin.x, origin.z, dir.x, dir.z, WEAPON_RANGE * horiz) / horiz
  // Floor and ceiling also stop the beam.
  if (dir.y < 0) wallDist = Math.min(wallDist, origin.y / -dir.y)
  if (dir.y > 0) wallDist = Math.min(wallDist, (WALL_HEIGHT - origin.y) / dir.y)
  const sprites = [...monsterViews.values()].map((v) => v.sprite)
  const hit = raycaster.intersectObjects(sprites, false).find((h) => h.distance < wallDist)
  const monster = hit ? monsterViews.get(hit.object.userData.monsterId as string) : undefined
  const point = hit ? hit.point : raycaster.ray.at(Math.min(wallDist, WEAPON_RANGE), new THREE.Vector3())
  return { monster, point, dir }
}

function shoot(overload: boolean) {
  if (!me || me.hp <= 0) return
  const now = performance.now() / 1000
  if (now - lastShot < WEAPON_COOLDOWN) return
  if (overload && me.mana < OVERLOAD_MANA) {
    sfx.empty()
    overload = false
  }
  lastShot = now
  const { monster, point, dir } = aim()
  send({ t: 'shoot', target: monster?.state.id ?? null, dx: dir.x, dz: dir.z, overload })
  const muzzle = gun.muzzleWorld()
  effects.beam(muzzle, point, overload ? '#ff4fd8' : '#5cf2ff', overload ? 0.1 : 0.035)
  if (!monster) effects.flashAt(point, overload ? '#ff4fd8' : '#5cf2ff', 0.6)
  gun.fire(overload)
  sfx.shoot(overload)
  if (overload) shake = Math.min(0.5, shake + 0.12)
}

// --- Main loop ----------------------------------------------------------------
const clock = new THREE.Clock()

function movePlayer(dt: number) {
  if (!world || !me) return
  const alive = me.hp > 0
  const forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
  const strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
  const wish = new THREE.Vector3(strafe, 0, -forward)
  if (wish.lengthSq() > 0) wish.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')
  const speed = alive && locked() ? PLAYER_SPEED * (sprint ? SPRINT_MULT : 1) : 0
  const accel = 1 - Math.exp(-dt * 12)
  vel.x += (wish.x * speed - vel.x) * accel
  vel.z += (wish.z * speed - vel.z) * accel

  const nx = pos.x + vel.x * dt
  if (!world.blocked(nx, pos.z, PLAYER_RADIUS)) pos.x = nx
  else vel.x = 0
  const nz = pos.z + vel.z * dt
  if (!world.blocked(pos.x, nz, PLAYER_RADIUS)) pos.z = nz
  else vel.z = 0

  const moving = Math.hypot(vel.x, vel.z)
  bob += moving * dt * 1.4
  stepTimer -= dt * moving
  if (moving > 1 && stepTimer <= 0) {
    stepTimer = sprint ? 2.6 : 3
    sfx.step()
  }
  gun.update(dt, moving / PLAYER_SPEED)
}

function updateCamera(dt: number, time: number) {
  shake = Math.max(0, shake - dt * 1.5)
  damage = Math.max(0, damage - dt * 1.2)
  const sx = (Math.random() - 0.5) * shake * 0.25
  const sy = (Math.random() - 0.5) * shake * 0.25
  camera.position.set(pos.x, EYE_HEIGHT + Math.sin(bob * 2) * 0.05, pos.z)
  camera.rotation.set(pitch + sy, yaw + sx, 0)
  if (me && me.hp <= 0) {
    camera.position.y = 0.5
    camera.rotation.z = 0.5
  }
  screenFx.uniforms.uTime.value = time
  screenFx.uniforms.uDamage.value = damage
  el.vignette.style.opacity = String(Math.min(0.6, damage * 0.5 + (me && me.hp / me.maxHp < 0.25 ? 0.25 + Math.sin(time * 6) * 0.1 : 0)))
}

function loop() {
  const dt = Math.min(0.05, clock.getDelta())
  const time = clock.elapsedTime

  if (playing && world) {
    movePlayer(dt)
    updateCamera(dt, time)
    sendTimer -= dt
    if (sendTimer <= 0) {
      sendTimer = 0.05
      send({ t: 'move', x: pos.x, z: pos.z, yaw })
    }
    revealTimer -= dt
    if (revealTimer <= 0) {
      revealTimer = 0.25
      world.reveal(pos.x, pos.z)
    }
    mapTimer -= dt
    if (mapTimer <= 0) {
      mapTimer = 1 / 20
      drawMinimap(world, pos.x, pos.z, yaw, monsterViews.values(), playerViews.values())
    }
    const { monster } = aim()
    el.crosshair.classList.toggle('hot', !!monster)
    if (monster) {
      el.target.classList.remove('hidden')
      el.targetName.textContent = monster.tpl.name
      el.targetName.style.color = monster.tpl.color
      el.targetFill.style.width = `${(monster.state.hp / monster.state.maxHp) * 100}%`
    } else el.target.classList.add('hidden')
  } else if (world) {
    // Menu camera drifts through the demo maze.
    demoAngle += dt * 0.12
    camera.position.copy(demoSpot)
    camera.rotation.set(-0.05 + Math.sin(time * 0.3) * 0.05, demoAngle, 0)
    gun.root.visible = false
  }
  if (playing) gun.root.visible = !!me && me.hp > 0

  world?.update(dt, time)
  for (const v of monsterViews.values()) v.update(dt, time)
  for (const v of playerViews.values()) v.update(dt)
  effects.update(dt)
  composer.render(dt)
  requestAnimationFrame(loop)
}

loop()

// Expose a tiny debug handle for automated smoke tests.
;(window as unknown as { spacemyst: object }).spacemyst = {
  state: () => ({ playing, me, monsters: monsterViews.size, players: playerViews.size, pos: pos.toArray(), yaw }),
  shoot: (overload = false) => shoot(overload),
  world: () => world,
  key: (code: string, down: boolean) => (down ? keys.add(code) : keys.delete(code)),
  others: () => {
    const v = [...playerViews.values()][0]
    if (!v) return null
    const { x, z } = v.root.position
    return { x, z, d: Math.hypot(x - pos.x, z - pos.z) }
  },
  monsters: () =>
    [...monsterViews.values()].map((v) => ({
      id: v.state.id,
      name: v.tpl.name,
      x: v.root.position.x,
      z: v.root.position.z,
      los: !!world && world.lineOfSight(pos.x, pos.z, v.root.position.x, v.root.position.z),
    })),
  look: (y: number, p = 0) => {
    yaw = y
    pitch = p
  },
}
