// Spacemyst 3D browser client: renders the maze, moves the local player, and turns server
// snapshots and events into monsters, effects, sounds and HUD updates.
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { activeWeapon } from '../../shared/character.ts'
import {
  DASH_SPEED,
  DASH_TIME,
  EYE_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SECTOR_COLORS,
  SECTOR_NAMES,
  SPRINT_MULT,
  WALL_HEIGHT,
  cellCenter,
  clamp,
  round2,
  toCell,
} from '../../shared/constants.ts'
import { Grid, Mode } from '../../shared/grid.ts'
import { POTIONS, POTION_COLORS, WEAPONS, type WeaponType } from '../../shared/items.ts'
import { MONSTER_BY_KEY } from '../../shared/monsters.ts'
import { MF, type Aim, type GameEvent, type ProjNet, type ServerMsg, type StatusId, type Welcome } from '../../shared/protocol.ts'
import { SPELL_BY_ID } from '../../shared/spells.ts'
import { spentPoints, talentPointsForLevel } from '../../shared/talents.ts'
import { FAKE, HUB_NAMES, type WorldState } from '../../shared/world.ts'
import { generateWorld } from '../../shared/worldgen.ts'
import {
  initAudio,
  setAmbience,
  setBossMusic,
  setCombatIntensity,
  setLowHealth,
  setMasterVolume,
  setMuffled,
  setMusicVolume,
  setSfxVolume,
  sfx,
  type ExplosionKind,
  type WeaponKind,
  type WorldEventKind,
} from './audio.ts'
import { LootLayer, ProjectileLayer, ZoneLayer } from './dynamic.ts'
import { MonsterView, PlayerView, monsterName } from './entities.ts'
import { Effects } from './fx.ts'
import * as hud from './hud.ts'
import { connect, disconnect, send } from './net.ts'
import { Props, type PropCtx } from './props.ts'
import { S, now, serverNow, setChar, setState, setWorld, settings, stackCount, stackName, type Settings } from './state.ts'
import * as ui from './ui.ts'
import { WeaponRig } from './weapons.ts'
import { HUB_LOOK, WorldView, lookFor } from './world.ts'

const { el } = hud

/** Height the server fires from; aim is computed from here so shots land under the crosshair. */
const SERVER_EYE = EYE_HEIGHT - 0.15
const REACH = 4.6
const AIM_RANGE = 90

// --- Renderer and post-processing -------------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' })
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05

const scene = new THREE.Scene()
const fog = new THREE.FogExp2(0x02060b, 0.03)
scene.fog = fog
const background = new THREE.Color(0x02060b)
scene.background = background

const camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.03, 240)
camera.rotation.order = 'YXZ'
scene.add(camera)
const hemi = new THREE.HemisphereLight(0x4a7fa8, 0x06080c, 0.55)
scene.add(hemi)
const headlight = new THREE.PointLight(0xd2f4ff, 16, 26, 2)
headlight.position.set(0, 0.25, -1)
camera.add(headlight)
/** A few real lights that follow the nearest hub, arena, hall and gate lamps. */
const lampLights = Array.from({ length: 4 }, () => {
  const l = new THREE.PointLight(0xffffff, 0, 30, 2)
  scene.add(l)
  return l
})
const rig = new WeaponRig()
camera.add(rig.root)
rig.root.visible = false

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.5, 0.82)
composer.addPass(bloom)
composer.addPass(new OutputPass())
const screenFx = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uDamage: { value: 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uTintAmt: { value: 0 },
    uNoise: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uDamage;
    uniform vec3 uTint;
    uniform float uTintAmt;
    uniform float uNoise;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      if (uNoise > 0.0) uv.x += (hash(vec2(floor(uv.y * 90.0), floor(uTime * 24.0))) - 0.5) * 0.025 * uNoise;
      vec2 c = uv - 0.5;
      float d = dot(c, c);
      float ab = 0.002 + uDamage * 0.007;
      vec3 col = vec3(texture2D(tDiffuse, uv + c * ab).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - c * ab).b);
      col *= 0.97 + 0.03 * sin(uv.y * 900.0 + uTime * 6.0);
      col *= 1.0 - d * 1.05;
      col = mix(col, col * vec3(1.4, 0.5, 0.55), clamp(uDamage, 0.0, 1.0) * 0.3);
      col = mix(col, col * uTint * 1.5, uTintAmt);
      col += (hash(uv * 400.0 + uTime) - 0.5) * 0.08 * uNoise;
      col += uFlashColor * uFlash * (1.0 - d);
      gl_FragColor = vec4(col, 1.0);
    }`,
})
composer.addPass(screenFx)

function applyResolution() {
  const ratio = clamp(Math.min(window.devicePixelRatio || 1, 1.5) * settings.quality, 0.4, 2)
  renderer.setPixelRatio(ratio)
  composer.setPixelRatio(ratio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', applyResolution)

function applySettings(s: Settings) {
  setMasterVolume(s.master)
  setMusicVolume(s.music)
  setSfxVolume(s.sfx)
  bloom.enabled = s.bloom
  el.fps.classList.toggle('hidden', !s.showFps)
  applyResolution()
}
applySettings(settings)

// --- Sector looks: fog, sky light and lamps ------------------------------------------------------------
interface LookTarget {
  fog: THREE.Color
  bg: THREE.Color
  sky: THREE.Color
  ground: THREE.Color
  density: number
}
const LOOK_DENSITY = [0.03, 0.027, 0.033, 0.024, 0.02]
const lookTargets = new Map<number, LookTarget>()
function lookTarget(i: number): LookTarget {
  let t = lookTargets.get(i)
  if (!t) {
    const l = lookFor(i)
    t = { fog: new THREE.Color(l.fog), bg: new THREE.Color(l.background), sky: new THREE.Color(l.hemiSky), ground: new THREE.Color(l.hemiGround), density: LOOK_DENSITY[i] ?? 0.028 }
    lookTargets.set(i, t)
  }
  return t
}

function updateLook(dt: number, look: number, dark: boolean) {
  const tg = lookTarget(look)
  const k = 1 - Math.exp(-dt * 2.5)
  fog.color.lerp(tg.fog, k)
  background.lerp(tg.bg, k)
  hemi.color.lerp(tg.sky, k)
  hemi.groundColor.lerp(tg.ground, k)
  fog.density += (tg.density * (dark ? 1.8 : 1) - fog.density) * k
  hemi.intensity += ((dark ? 0.1 : 0.55) - hemi.intensity) * k
  headlight.intensity += ((dark ? 26 : 16) - headlight.intensity) * k
}

function updateLamps(view: WorldView, x: number, z: number, dim: number) {
  const best: { d: number; i: number }[] = []
  view.lamps.forEach((l, i) => {
    const d = Math.hypot(l.x - x, l.z - z)
    if (d > 34) return
    best.push({ d, i })
  })
  best.sort((a, b) => a.d - b.d)
  lampLights.forEach((light, k) => {
    const b = best[k]
    if (!b) {
      light.intensity = 0
      return
    }
    const l = view.lamps[b.i]
    light.position.set(l.x, l.y, l.z)
    light.color.set(l.color)
    light.intensity = l.power * clamp((34 - b.d) / 10, 0, 1) * dim
  })
}

// --- Game state -----------------------------------------------------------------------------------
const effects = new Effects(scene)
effects.eye = camera.position
const projectiles = new ProjectileLayer()
const zones = new ZoneLayer()
const loot = new LootLayer()
scene.add(projectiles.group, zones.group, loot.group)

let world: WorldView | null = null
let props: Props | null = null
let pickables: THREE.Object3D[] = []
const monsterViews = new Map<number, MonsterView>()
const playerViews = new Map<string, PlayerView>()
const power = new Map<number, number>()

const pos = { x: 0, z: 0 }
const vel = new THREE.Vector2()
let yaw = Math.PI
let pitch = 0
let time = 0
let playerName = ''
let awaitingSpawn = false
let chatting = false
let shake = 0
let kick = 0
let bob = 0
let stepDist = 0
let dashUntil = 0
let dashReady = 0
const dashDir = new THREE.Vector2()
let fovBoost = 0
let damageFlash = 0
let screenFlash = 0
const keys = new Set<string>()
let mouseHeld = false
let clickQueued = false
let suppressFire = false
let fireReady = 0
let lastShot = -10
let charging = false
let chargeStart = 0
let plasmaOn = false
let swapAt = 0
let potionLock = 0
const castLock = [0, 0, 0, 0]
const touchAt = new Map<number, number>()
let whereKey = ''
let scoreboardHeld = false
let scoreboardAt = 0
let moveSentAt = 0
let lastMoveKey = ''
let hudAt = 0
let mapAt = 0
let revealAt = 0
let lastQuestToast = 0

const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

const statusOn = (s: StatusId) => !!S.you?.status.some(([id]) => id === s)
const disabled = () => statusOn('stunned') || statusOn('frozen') || statusOn('asleep')
const canAct = () => !!S.you && !S.you.dead && !disabled()
const weaponType = (): WeaponType => ((S.char ? activeWeapon(S.char)?.base : null) ?? 'laser') as WeaponType

/** A short full-screen glow, for things that happen right where you stand. */
function flashScreen(color: string, amount: number) {
  ;(screenFx.uniforms.uFlashColor.value as THREE.Color).set(color)
  screenFlash = Math.max(screenFlash, amount)
}

/** Stereo pan and volume for a sound at a world position. */
function spatial(x: number, z: number, range = 40) {
  const dx = x - pos.x
  const dz = z - pos.z
  const d = Math.hypot(dx, dz)
  const pan = d > 0.01 ? clamp((dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d, -1, 1) * Math.min(1, d / 3) : 0
  const vol = Math.pow(clamp(1 - d / range, 0, 1), 1.3)
  return { pan, vol, d }
}

function monsterPos(id: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  const v = monsterViews.get(id)
  if (v) return out.set(v.root.position.x, v.centerY(time), v.root.position.z)
  const n = S.monsters.get(id)
  return n ? out.set(n.x, 1, n.z) : null
}

function playerPos(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
  if (id === S.myId) return out.set(pos.x, 1.2, pos.z)
  const v = playerViews.get(id)
  if (v) return out.set(v.root.position.x, 1.2, v.root.position.z)
  const n = S.players.get(id)
  return n ? out.set(n.x, 1.2, n.z) : null
}

/** A point floating in front of the camera, for feedback text about yourself. */
function frontPoint(dist = 2.6, drop = 0.45) {
  return v3(pos.x - Math.sin(yaw) * dist, EYE_HEIGHT - drop, pos.z - Math.cos(yaw) * dist)
}

// --- Attract mode: a hub of a local maze turns slowly behind the menu ------------------------------------
let attract: { world: WorldView; props: Props; state: WorldState; x: number; z: number } | null = null
let attractYaw = 0.6

function startAttract() {
  if (attract) return
  const info = generateWorld(20261004, 1)
  const grid = new Grid(info)
  const state: WorldState = {
    season: 1,
    gates: [],
    vaults: [],
    fakes: [],
    solved: [],
    relays: {},
    mirrors: {},
    plates: [],
    corruption: [1, 1, 1, 0],
    event: null,
    bosses: {},
    turretsDown: [],
  }
  grid.applyState(state)
  const view = new WorldView(info, grid)
  view.applyState(state)
  const p = new Props(info)
  scene.add(view.group, p.group)
  const hub = info.hubs[0]
  attract = { world: view, props: p, state, x: cellCenter(hub.cx), z: cellCenter(hub.cz) }
  power.clear()
  rig.root.visible = false
}

function stopAttract() {
  if (!attract) return
  attract.world.dispose()
  attract.props.dispose()
  attract = null
}

function attractFrame(dt: number) {
  const a = attract
  if (!a) return
  attractYaw += dt * 0.07
  camera.position.set(a.x, EYE_HEIGHT + Math.sin(time * 0.6) * 0.05, a.z)
  camera.rotation.set(Math.sin(time * 0.25) * 0.05 - 0.03, attractYaw, 0)
  camera.fov = settings.fov
  camera.updateProjectionMatrix()
  a.world.updateDoors([{ x: a.x, z: a.z }])
  a.world.update(dt, time)
  a.props.update({ time, serverTime: time, state: a.state, char: null }, dt, a.x, a.z)
  updateLook(dt, HUB_LOOK, false)
  updateLamps(a.world, a.x, a.z, 1)
}

// --- World building ---------------------------------------------------------------------------------
function disposeWorld() {
  world?.dispose()
  props?.dispose()
  world = null
  props = null
  pickables = []
  ui.hooks.world = null
  for (const v of monsterViews.values()) v.dispose()
  monsterViews.clear()
  for (const v of playerViews.values()) v.dispose()
  playerViews.clear()
  projectiles.clear()
  zones.clear()
  loot.clear()
  effects.clear()
}

function buildWorld() {
  disposeWorld()
  const info = S.world
  const grid = S.grid
  const state = S.state
  if (!info || !grid || !state) return
  world = new WorldView(info, grid, `spacemyst.explored.${playerName.toLowerCase()}.${info.seed}.${info.season}`)
  world.applyState(state)
  props = new Props(info)
  scene.add(world.group, props.group)
  pickables = [...props.pickables, ...world.pickables]
  ui.hooks.world = world
  power.clear()
  whereKey = ''
}

// --- Menu, login and leaving ------------------------------------------------------------------------
try {
  el.name.value = localStorage.getItem('spacemyst.name') ?? ''
} catch {
  /* storage may be unavailable */
}

el.login.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = el.name.value.trim()
  if (name.length < 2) {
    el.menuStatus.textContent = 'Pick a hacker name of at least 2 characters.'
    el.name.focus()
    return
  }
  initAudio()
  applySettings(settings)
  playerName = name
  try {
    localStorage.setItem('spacemyst.name', name)
  } catch {
    /* ignore */
  }
  el.play.disabled = true
  el.menuStatus.textContent = 'Connecting to the network…'
  connect(name, el.pass.value, { message: onMessage, close: onClose })
})

function showMenu(status: string) {
  el.menu.classList.remove('hidden')
  el.hud.classList.add('hidden')
  el.play.disabled = false
  el.menuStatus.textContent = status
}

function teardownGame() {
  S.playing = false
  awaitingSpawn = false
  ui.closePanel(false, true)
  closeChat(false)
  disposeWorld()
  S.players.clear()
  S.monsters.clear()
  S.you = null
  rig.root.visible = false
  hud.hideDeath()
  hud.setBoss(null)
  hud.setTarget(null)
  hud.setPrompt('')
  hud.setCharge(0)
  setPlasma(false)
  setBossMusic(false)
  setCombatIntensity(0)
  setLowHealth(false)
  setMuffled(false)
  mouseHeld = false
  charging = false
  keys.clear()
  if (document.pointerLockElement) document.exitPointerLock()
  el.paused.classList.add('hidden')
  el.scoreboard.classList.add('hidden')
}

function onClose(reason: string) {
  const wasIn = S.playing || awaitingSpawn
  teardownGame()
  showMenu(reason)
  if (wasIn) startAttract()
}

function logout() {
  disconnect()
  teardownGame()
  showMenu('You logged out. See you in the network.')
  startAttract()
}

function enterGame() {
  S.playing = true
  el.menu.classList.add('hidden')
  el.hud.classList.remove('hidden')
  el.play.disabled = false
  el.menuStatus.textContent = ''
  el.pass.value = ''
  rig.root.visible = true
  rig.set(weaponType())
  fireReady = 0
  lastShot = -10
  hud.log(`Season ${S.state?.season ?? 1}. Welcome, ${S.char?.name ?? 'hacker'}. Esc opens settings, M the map, J your journal.`, 'sys')
  lockPointer()
}

ui.hooks.me = () => ({ x: pos.x, z: pos.z, yaw })
ui.hooks.onClose = () => lockPointer()
ui.hooks.onSettings = applySettings
ui.hooks.logout = logout
ui.setThrowHook((slot) => {
  send({ t: 'throw', from: slot, ...aimMsg() })
  ui.closePanel(false)
})

// --- Server messages ---------------------------------------------------------------------------------------
function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome':
      return onWelcome(msg)
    case 'denied':
      disconnect()
      showMenu(msg.reason)
      return
    case 'snap':
      return onSnap(msg)
    case 'events':
      for (const e of msg.list) {
        try {
          onEvent(e)
        } catch (err) {
          console.error('event failed', e, err)
        }
      }
      return
    case 'char': {
      const before = S.char?.active
      setChar(msg.char)
      rig.set(weaponType())
      if (before !== undefined && before !== msg.char.active) {
        fireReady = 0
        charging = false
      }
      ui.refresh()
      return
    }
    case 'state':
      setState(msg.state)
      S.identified = new Set(msg.identified)
      world?.applyState(msg.state)
      ui.refresh()
      return
    case 'correct':
      pos.x = msg.x
      pos.z = msg.z
      vel.set(0, 0)
      dashUntil = 0
      return
    case 'teleport':
      pos.x = msg.x
      pos.z = msg.z
      vel.set(0, 0)
      dashUntil = 0
      if (msg.yaw !== undefined) {
        yaw = msg.yaw
        pitch = 0
      }
      flashScreen('#9ff6ff', 0.35)
      sendMove()
      return
    case 'shop':
      return ui.showShop(msg.hub, msg.stock)
    case 'board':
      return ui.showBoard(msg.hub, msg.offers)
    case 'beacon':
      return ui.showBeacon(msg.hub)
    case 'world':
      // A new season: a new maze.
      S.colors = msg.colors
      S.identified = new Set(msg.identified)
      setWorld(msg.world, msg.state)
      ui.closePanel(false, true)
      buildWorld()
      return
  }
}

function onWelcome(msg: Welcome) {
  S.myId = msg.you
  S.guest = msg.guest
  S.colors = msg.colors
  S.identified = new Set(msg.identified)
  S.daily = msg.daily
  S.serverTime = msg.time
  S.snapAt = now()
  setWorld(msg.world, msg.state)
  setChar(msg.char)
  stopAttract()
  buildWorld()
  awaitingSpawn = true
  el.menuStatus.textContent = 'Jacking in…'
}

function onSnap(msg: Extract<ServerMsg, { t: 'snap' }>) {
  const t = now()
  S.serverTime = msg.time
  S.snapAt = t
  const wasDead = S.you?.dead ?? false
  S.you = msg.you

  S.players.clear()
  for (const p of msg.players) S.players.set(p.id, p)
  for (const p of msg.players) {
    if (p.id === S.myId) continue
    const v = playerViews.get(p.id)
    if (v) v.apply(p)
    else {
      const nv = new PlayerView(p)
      scene.add(nv.root)
      playerViews.set(p.id, nv)
    }
  }
  for (const [id, v] of playerViews)
    if (!S.players.has(id)) {
      v.dispose()
      playerViews.delete(id)
    }

  S.monsters.clear()
  for (const m of msg.monsters) S.monsters.set(m.id, m)
  for (const m of msg.monsters) {
    const v = monsterViews.get(m.id)
    if (v) v.apply(m)
    else {
      const nv = new MonsterView(m)
      scene.add(nv.root)
      monsterViews.set(m.id, nv)
    }
  }
  for (const [id, v] of monsterViews)
    if (!S.monsters.has(id)) {
      v.dispose()
      monsterViews.delete(id)
    }

  S.proj = msg.proj
  projectiles.sync(msg.proj, t, onNewProjectile)
  S.zones = msg.zones
  zones.sync(msg.zones)
  if (msg.loot) {
    S.loot = msg.loot
    loot.sync(msg.loot)
  }

  if (awaitingSpawn) {
    const mine = S.players.get(S.myId)
    if (mine) {
      pos.x = mine.x
      pos.z = mine.z
      yaw = mine.yaw
      pitch = 0
      awaitingSpawn = false
      enterGame()
    }
  }
  if (wasDead && !msg.you.dead) hud.hideDeath()
}

function onNewProjectile(p: ProjNet) {
  if (p.o === 1) return
  const s = spatial(p.x, p.z)
  if (s.vol > 0.02) sfx.projectile(p.k, s.pan, s.vol)
}

// --- Events -----------------------------------------------------------------------------------------------
const TYPE_COLORS: Record<string, string> = { laser: '#ffffff', emp: '#8fc4ff', heat: '#ffaa55', pure: '#e48cff' }
const EXPLOSION_SOUNDS: Record<string, ExplosionKind> = {
  emp: 'emp',
  glitch: 'glitch',
  noise: 'noise',
  acid: 'acid',
  toxic: 'toxic',
  neutron: 'neutron',
  horizon: 'horizon',
  bomb: 'bomb',
  purge: 'emp',
  ring: 'emp',
  strike: 'bomb',
}
const SHOT_COLORS: Record<string, string> = { overload: '#ff4fd8', lullaby: '#8c7bff', daemon: '#4fa8ff' }
const EVENT_TITLES: Record<string, [string, string]> = {
  outage: ['POWER OUTAGE', '#ffd34d'],
  outbreak: ['OUTBREAK', '#9dff00'],
  zeroday: ['ZERO-DAY EXPLOIT', '#ff4fd8'],
  rootkit: ['ROOTKIT DRAGON', '#ff3b5c'],
}

function onEvent(e: GameEvent) {
  const mine = (id: string | undefined) => !!id && id === S.myId
  switch (e.kind) {
    case 'shot':
      return onShot(e)

    case 'hit': {
      const v = monsterViews.get(e.m)
      v?.hit()
      if (!mine(e.by)) return
      if (v) v.hurtAt = time
      const p = monsterPos(e.m, tmpA)
      if (!p) return
      p.y += (v?.def.size ?? 1) * 0.55
      if (e.tag === 'evade' || e.tag === 'immune') {
        effects.number(p.clone(), e.tag === 'evade' ? 'EVADE' : 'IMMUNE', '#9fb0c0', 0.9)
        return
      }
      effects.number(p.clone(), String(Math.max(1, Math.round(e.dmg))), e.crit ? '#ffd34d' : TYPE_COLORS[e.type] ?? '#ffffff', e.crit ? 1.35 : 1)
      hud.hitMarker()
      if (e.crit) sfx.crit()
      else sfx.hitmarker()
      return
    }

    case 'kill': {
      const def = MONSTER_BY_KEY[e.key]
      const color = def?.color ?? '#ff5c7a'
      const size = def?.size ?? 1
      effects.burst(v3(e.x, size * 0.55, e.z), color, e.boss ? 200 : e.elite ? 90 : 40, e.boss ? 10 : 5, 1, e.boss ? 0.4 : 0.3)
      effects.flash(v3(e.x, size * 0.55, e.z), color, size * 2.2, 0.3)
      const s = spatial(e.x, e.z)
      if (s.vol > 0.02) sfx.monster(e.key, 'die', s.pan, s.vol)
      if (mine(e.by)) sfx.killConfirm()
      if (e.boss) hud.log(`${e.byName} brought down ${e.name}!`, 'kill')
      else if (e.elite) hud.log(`${e.byName} purged an elite ${e.name}.`, 'kill')
      return
    }

    case 'hurt': {
      if (!mine(e.p)) return
      const maxHp = Math.max(1, S.you?.maxHp ?? 1)
      const frac = e.dmg / maxHp
      sfx.hurt()
      hud.hurt(frac)
      shake = Math.min(1, shake + clamp(frac * 3, 0.1, 0.5))
      damageFlash = Math.min(1, damageFlash + 0.2 + frac * 2)
      if (e.special) hud.toast(`${e.special}!`, 'bad')
      return
    }

    case 'miss':
      if (!mine(e.p)) return
      effects.number(frontPoint(), 'MISS', '#9fb0c0', 0.55)
      sfx.miss()
      return

    case 'dodge':
      if (!mine(e.p)) return
      effects.number(frontPoint(), 'DODGE', '#9ff6ff', 0.55)
      sfx.miss()
      return

    case 'death':
      if (mine(e.p)) {
        sfx.death()
        setPlasma(false)
        charging = false
        hud.setCharge(0)
        hud.showDeath(
          `Crashed by ${e.killer}.${e.dump > 0 ? ` You dropped a data dump with ${e.dump} credits where you fell. Get back to it to recover them.` : ''}`,
        )
        hud.log(`You were crashed by ${e.killer}.`, 'hurt')
      } else hud.log(`${e.name} was crashed by ${e.killer}.`, 'hurt')
      return

    case 'respawn':
      if (mine(e.p)) {
        hud.hideDeath()
        sfx.teleport()
        flashScreen('#9ff6ff', 0.45)
      } else effects.flash(v3(e.x, 1.2, e.z), '#9ff6ff', 3, 0.5)
      return

    case 'levelup':
      if (mine(e.p)) {
        sfx.levelup()
        const names = e.spells.map((id) => SPELL_BY_ID[id]?.name).filter(Boolean)
        const char = S.char
        const points = char ? talentPointsForLevel(e.level) - spentPoints(char.talents) : 0
        const sub = names.length ? `New spell: ${names.join(', ')}. Open the spellbook (B).` : points > 0 ? `Talent points to spend: ${points}. Press N.` : ''
        hud.announce(`LEVEL ${e.level}`, sub, '#ffd34d')
        effects.rise(v3(pos.x, 0.2, pos.z), '#ffd34d', 50, 1.6, 1.6)
        hud.log(`You reached level ${e.level}.`, 'lvl')
      } else hud.log(`${e.name} reached level ${e.level}.`, 'lvl')
      return

    case 'heal':
      if (!mine(e.p)) return
      if (e.amount === 0) {
        sfx.repair()
        effects.rise(v3(pos.x, 0.2, pos.z), '#7dff9a', 40, 1.5, 1.3)
      } else effects.number(frontPoint(2.6, 0.2), `+${e.amount}`, '#7dff9a', 0.55)
      return

    case 'mana':
      if (mine(e.p) && e.amount > 0) effects.number(frontPoint(2.6, 0.2), `+${e.amount} mana`, '#7fb2ff', 0.55)
      return

    case 'windup': {
      const v = monsterViews.get(e.m)
      if (!v) return
      const s = spatial(v.root.position.x, v.root.position.z, 34)
      if (e.what === 'aggro') {
        if (s.vol > 0.02) sfx.monster(v.def.key, 'aggro', s.pan, s.vol)
        return
      }
      v.windup(e.dur)
      if (s.vol <= 0.02) return
      if (e.what === 'fuse') sfx.fuse(s.pan, s.vol)
      else if (e.what === 'volley' || e.what === 'breath' || e.what === 'purge') sfx.monster(v.def.key, 'special', s.pan, s.vol)
      else sfx.monster(v.def.key, 'windup', s.pan, s.vol)
      return
    }

    case 'tele': {
      effects.telegraph(e.shape, e.x, e.z, e.r, e.a ?? 0, e.l ?? 0, e.dur, e.color ?? '#ff3355')
      const s = spatial(e.x, e.z, 30)
      if (s.vol > 0.05) sfx.telegraph(s.pan, s.vol)
      return
    }

    case 'explode': {
      const color = e.color ?? '#ffb347'
      const s = spatial(e.x, e.z, 50)
      if (e.what === 'ping') {
        effects.ring(e.x, e.z, e.r, color, 0.9, 1.2)
        effects.ring(e.x, e.z, e.r * 0.5, color, 0.6, 0.6)
        return
      }
      if (e.what === 'snooze') {
        effects.dome(e.x, 0.5, e.z, e.r, color, 0.7)
        effects.ring(e.x, e.z, e.r, color, 0.8)
        return
      }
      if (e.what === 'splash') {
        effects.ring(e.x, e.z, e.r, color, 0.5)
        effects.burst(v3(e.x, 0.5, e.z), color, 40, 4, 0.7, 0.3)
        if (s.vol > 0.02) sfx.potionShatter(s.pan, s.vol)
        return
      }
      effects.explosion(e.x, e.z, e.r, color)
      if (s.d < e.r + 0.6) flashScreen(color, 0.3)
      const sound = EXPLOSION_SOUNDS[e.what] ?? 'bomb'
      if (e.what === 'acid' || e.what === 'toxic') sfx.potionShatter(s.pan, s.vol)
      if (s.vol > 0.02) sfx.explosion(sound, s.pan, s.vol)
      shake = Math.min(1, shake + clamp(1 - s.d / (e.r * 3 + 4), 0, 1) * 0.5)
      return
    }

    case 'cast': {
      const s = mine(e.p) ? { pan: 0, vol: 1, d: 0 } : spatial(e.x, e.z)
      if (s.vol > 0.02) sfx.cast(e.spell, s.pan, s.vol)
      const color = SPELL_BY_ID[e.spell]?.color ?? '#5cf2ff'
      if (e.spell === 'repair') effects.rise(v3(e.x, 0.2, e.z), color, 40, mine(e.p) ? 1.5 : 0.9, 1.4)
      else if (e.spell === 'daemon' && !mine(e.p)) effects.flash(v3(e.x, 2.2, e.z), color, 2, 0.4)
      else if ((e.spell === 'firewall' || e.spell === 'stasis_field' || e.spell === 'honeypot') && e.tx !== undefined && e.tz !== undefined)
        effects.flash(v3(e.tx, 1, e.tz), color, 3, 0.4)
      if (mine(e.p) && e.spell === 'overload') {
        rig.fire(1.6, color)
        kick += 0.05
      }
      return
    }

    case 'chain': {
      const pts = e.pts.map(([x, z], i) => v3(x, i === 0 ? 1.4 : 1.2, z))
      if (pts.length >= 2) effects.bolt(pts, e.color, 0.4, 0.45)
      return
    }

    case 'leech': {
      const from = () => (e.p === S.myId ? rig.muzzleWorld(new THREE.Vector3()) : playerPos(e.p))
      effects.tether(from, () => monsterPos(e.m), '#ff3b5c', e.dur)
      return
    }

    case 'blink': {
      effects.blink(v3(e.x, 1.2, e.z), v3(e.tx, 1.2, e.tz), e.who === S.myId || S.players.has(e.who) ? '#c77dff' : '#ff4fd8')
      return
    }

    case 'status':
      if (e.p !== undefined) {
        if (!mine(e.p)) return
        if (e.s === 'unstealth') hud.toast('Your encryption broke.', '')
        else if (e.s === 'rooted') hud.toast('Rooted!', 'bad')
        else if (e.s === 'memleak') hud.toast('Memory leak! Your max mana is draining.', 'bad')
        return
      }
      if (e.m !== undefined) {
        const p = monsterPos(e.m)
        if (!p) return
        if (e.s === 'hijacked') effects.burst(p, '#7dff9a', 50, 4, 0.8, 0.35)
        else if (e.s === 'released') effects.burst(p, '#ff5c7a', 30, 3, 0.6, 0.3)
        else if (e.s === 'asleep' || e.s === 'stunned') effects.flash(p, e.s === 'asleep' ? '#8c7bff' : '#ffe14f', 1.6, 0.35)
      }
      return

    case 'distress': {
      if (e.done) return
      effects.ring(e.x, e.z, 3, '#ff3b5c', 0.7)
      const s = spatial(e.x, e.z, 45)
      if (s.vol > 0.02) sfx.distress(s.pan, s.vol)
      return
    }

    case 'ambush': {
      effects.burst(v3(e.x, 1, e.z), '#ff3b5c', 50, 5, 0.7, 0.35)
      const s = spatial(e.x, e.z)
      if (s.vol > 0.02) sfx.ambush(s.pan, s.vol)
      return
    }

    case 'split': {
      const key = S.monsters.get(e.m)?.k ?? 'recursive_worm'
      effects.burst(v3(e.x, 0.8, e.z), MONSTER_BY_KEY[key]?.color ?? '#9dff00', 50, 5, 0.7, 0.35)
      const s = spatial(e.x, e.z)
      if (s.vol > 0.02) sfx.monster(key, 'special', s.pan, s.vol)
      return
    }

    case 'pickup':
      if (!mine(e.p)) return
      if (e.what === 'credits' || e.what === 'dump') sfx.coins()
      else sfx.pickup(e.rarity)
      if (e.rarity >= 3 && (e.what === 'weapon' || e.what === 'armor')) return
      hud.log(e.what === 'dump' ? `Recovered your data dump: ${e.name}.` : `Picked up ${e.name}.`, e.rarity >= 2 ? 'quest' : 'loot')
      return

    case 'credits':
      if (!mine(e.p) || e.amount <= 0) return
      sfx.coins()
      effects.number(frontPoint(2.6, 0.1), `+${e.amount} cr`, '#ffd34d', 0.55)
      return

    case 'drink':
      if (!mine(e.p)) {
        const pp = playerPos(e.p)
        const s = pp ? spatial(pp.x, pp.z, 20) : null
        if (s && s.vol > 0.05) sfx.drink()
        return
      }
      sfx.drink()
      hud.log(`You drank the ${e.name}.`, 'loot')
      return

    case 'identify': {
      S.identified.add(e.base)
      const look = POTION_COLORS[e.color]?.name ?? 'strange'
      sfx.identify(POTIONS[e.base]?.good ?? true)
      hud.toast(`${e.byName} identified the ${look} potion: ${e.name}.`, 'loot')
      hud.log(`${look} potions are ${e.name}s this season.`, 'loot')
      ui.refresh()
      return
    }

    case 'throw': {
      const pp = playerPos(e.p)
      if (!pp) return
      const s = mine(e.p) ? { pan: 0, vol: 1 } : spatial(pp.x, pp.z, 25)
      if (s.vol > 0.05) sfx.throwItem()
      return
    }

    case 'gate': {
      sfx.gateOpen()
      const next = SECTOR_NAMES[e.sector + 1] ?? 'the next sector'
      hud.announce('SECTOR GATE OPEN', `The way into ${e.sector + 1 === 3 ? next : `the ${next}`} is clear.`, SECTOR_COLORS[Math.min(3, e.sector + 1)])
      return
    }

    case 'vault': {
      const v = S.vaults.get(e.id)
      if (v) {
        const s = spatial(cellCenter(v.x), cellCenter(v.z), 60)
        if (s.vol > 0.02) sfx.vaultOpen()
        effects.burst(v3(cellCenter(v.x), 2, cellCenter(v.z)), '#7dff9a', 60, 5, 1, 0.4)
      }
      hud.log(e.byName ? `${e.byName} opened a vault.` : 'A vault has opened.', 'quest')
      return
    }

    case 'secret': {
      const W = S.world?.width ?? 1
      const x = cellCenter(e.cell % W)
      const z = cellCenter(Math.floor(e.cell / W))
      effects.burst(v3(x, 2, z), '#c77dff', 80, 5, 1.1, 0.4)
      const s = spatial(x, z, 40)
      if (s.vol > 0.02) sfx.secret()
      hud.log(`${e.byName} found a secret passage!`, 'quest')
      return
    }

    case 'puzzle':
      if (e.solved) {
        sfx.puzzleSolved()
        hud.announce('PUZZLE SOLVED', e.msg, '#7dff9a')
        hud.log(e.msg, 'quest')
      } else if (e.ok) {
        sfx.lever()
        hud.toast(e.msg, 'loot')
      } else {
        sfx.denied()
        hud.toast(e.msg, 'bad')
        if (e.x !== undefined && e.z !== undefined) effects.burst(v3(e.x, 1.6, e.z), '#4fa8ff', 40, 4, 0.5, 0.3)
      }
      return

    case 'chest':
      if (mine(e.p)) sfx.lever()
      return

    case 'event': {
      if (e.what.endsWith('_end')) {
        hud.log(e.msg, 'event')
        return
      }
      const [title, color] = EVENT_TITLES[e.what] ?? [e.what.toUpperCase(), '#ff4fd8']
      sfx.event(e.what as WorldEventKind)
      hud.announce(title, e.msg, color)
      hud.log(e.msg, 'event')
      return
    }

    case 'boss':
      if (e.state === 'spawn') {
        hud.log(e.msg, 'event')
        const a = S.world?.arenas.find((ar) => ar.id === e.arena)
        if (a && spatial(cellCenter(a.cx), cellCenter(a.cz), 80).vol > 0) sfx.bossRoar()
      } else if (e.state === 'dead') {
        sfx.sectorCleared()
        hud.announce('BOSS DEFEATED', e.msg, '#ffd34d')
        hud.log(e.msg, 'kill')
      } else {
        sfx.bossRoar()
        hud.toast(e.msg, 'bad')
      }
      return

    case 'season':
      sfx.event('season')
      if (e.state === 'won') hud.announce('THE MAINFRAME HAS FALLEN', e.msg, '#ffe9a8')
      else hud.announce(`SEASON ${e.season}`, e.msg, '#5cf2ff')
      hud.log(e.msg, 'event')
      return

    case 'quest':
      if (e.done) {
        sfx.questComplete()
        hud.toast(`Quest complete: ${e.title}`, 'quest')
      } else if (time - lastQuestToast > 1.5) {
        lastQuestToast = time
        hud.toast(`${e.title}: ${Math.min(e.progress, e.goal)}/${e.goal}`, 'quest')
      }
      return

    case 'daily':
      if (e.done) {
        sfx.questComplete()
        hud.toast(`Daily challenge done: ${e.text}`, 'quest')
      }
      return

    case 'achievement':
      if (mine(e.p)) {
        sfx.achievement()
        hud.announce('ACHIEVEMENT', e.name, '#ffd34d')
      }
      hud.log(`${e.byName} earned the achievement ${e.name}.`, 'quest')
      return

    case 'fragment':
      sfx.uiOpen()
      ui.showFragment(e.index)
      return

    case 'travel':
      if (mine(e.p)) {
        sfx.teleport()
        hud.toast(`Arrived at ${HUB_NAMES[e.hub] ?? 'the hub'}.`, 'loot')
      } else {
        const pp = playerPos(e.p)
        if (pp) effects.flash(pp, '#9ff6ff', 2.4, 0.4)
      }
      return

    case 'chat':
      hud.log(`${e.name}: ${e.text}`, 'chat')
      return

    case 'system':
      hud.log(e.text, e.cls ?? 'sys')
      return

    case 'toast':
      hud.toast(e.text, e.cls ?? '')
      if (e.cls === 'nomana') sfx.noMana()
      return

    case 'sector':
      hud.announce(SECTOR_NAMES[e.sector] ?? 'Unknown sector', e.msg, SECTOR_COLORS[e.sector] ?? '#5cf2ff')
      return

    case 'shop':
      if (e.what === 'buy') sfx.buy()
      else sfx.sell()
      hud.log(e.what === 'buy' ? `Bought ${e.name}.` : `Sold ${e.name}.`, 'loot')
      return
  }
}

function onShot(e: Extract<GameEvent, { kind: 'shot' }>) {
  const to = v3(e.tx, e.ty, e.tz)
  const def = WEAPONS[e.w as WeaponType]
  const color = SHOT_COLORS[e.w] ?? def?.color ?? '#5cf2ff'
  if (e.by === S.myId) {
    // Weapon shots were drawn when fired; spells and ricochets are drawn now.
    if (e.w === 'overload' || e.w === 'lullaby') effects.beam(rig.muzzleWorld(new THREE.Vector3()), to, color, e.w === 'overload' ? 0.028 : 0.014, 0.3, true, true)
    if (e.pts?.length) {
      const [x, y, z] = e.pts[0]
      effects.beam(v3(x, y, z), to, color, 0.03, 0.15)
    }
    return
  }
  const from = v3(e.x, e.y, e.z)
  const s = spatial(e.x, e.z, 45)
  switch (e.w) {
    case 'daemon':
      effects.beam(from, to, color, 0.025, 0.12)
      if (s.vol > 0.02) sfx.turretShot(s.pan, s.vol * 0.6)
      return
    case 'overload':
      effects.beam(from, to, color, 0.07, 0.3)
      return
    case 'lullaby':
      effects.beam(from, to, color, 0.03, 0.25)
      return
    case 'blade': {
      const shooter = S.players.get(e.by)
      effects.slash(v3(e.x, 1.2, e.z), shooter?.yaw ?? Math.atan2(-(e.tx - e.x), -(e.tz - e.z)), color, def?.range ?? 3.2)
      break
    }
    case 'railgun':
      effects.beam(from, to, color, 0.04 + 0.06 * (e.charge ?? 1), 0.35)
      break
    case 'cannon':
    case 'horizon':
      effects.flash(from, color, 1.2, 0.15)
      break
    case 'plasma':
      effects.beam(from, to, color, 0.05, 0.11, false)
      break
    default:
      effects.beam(from, to, color, 0.03, 0.12)
  }
  if (e.pts?.length) {
    const [x, y, z] = e.pts[0]
    effects.beam(v3(x, y, z), to, color, 0.03, 0.15)
  }
  if (s.vol > 0.02 && def) sfx.weapon(e.w as WeaponKind, s.pan, s.vol)
}

// --- Input ------------------------------------------------------------------------------------------------
/** Automated tests cannot take the pointer, so they can pretend to have it. */
let testLock = false
const locked = () => document.pointerLockElement === canvas || testLock

/** Browsers can refuse pointer lock (no recent click, or right after Esc); the pause screen is the fallback. */
function lockPointer() {
  if (!S.playing || chatting || ui.isOpen() || locked()) return
  try {
    const request = canvas.requestPointerLock() as unknown
    if (request instanceof Promise) request.catch(() => updatePaused())
  } catch {
    updatePaused()
  }
}

function updatePaused() {
  el.paused.classList.toggle('hidden', !S.playing || locked() || chatting || ui.isOpen())
}

canvas.addEventListener('click', () => lockPointer())
el.paused.addEventListener('click', () => lockPointer())
document.addEventListener('pointerlockchange', () => {
  if (!locked()) mouseHeld = false
  updatePaused()
})
document.addEventListener('pointerlockerror', updatePaused)

document.addEventListener('mousemove', (e) => {
  if (!locked() || !S.playing) return
  const s = 0.0022 * settings.sensitivity
  yaw -= e.movementX * s
  pitch = clamp(pitch - e.movementY * s * (settings.invertY ? -1 : 1), -1.45, 1.45)
  rig.sway(e.movementX, e.movementY)
})

document.addEventListener('mousedown', (e) => {
  if (!locked() || !S.playing) return
  if (e.button === 0) {
    mouseHeld = true
    clickQueued = true
  } else if (e.button === 2) castSpell(0)
})
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    mouseHeld = false
    suppressFire = false
  }
})
document.addEventListener('contextmenu', (e) => {
  if (S.playing) e.preventDefault()
})
document.addEventListener(
  'wheel',
  (e) => {
    if (locked() && S.playing && Math.abs(e.deltaY) > 2) swapWeapon()
  },
  { passive: true },
)
window.addEventListener('blur', () => {
  keys.clear()
  mouseHeld = false
})

const PANEL_KEYS: Record<string, ui.PanelId> = { KeyI: 'inventory', KeyB: 'spells', KeyN: 'talents', KeyM: 'map', KeyJ: 'journal' }

document.addEventListener('keydown', (e) => {
  if (chatting) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const text = el.chat.value.trim()
      if (text) send({ t: 'chat', text })
      closeChat(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeChat(true)
    }
    return
  }
  if (!S.playing || e.ctrlKey || e.metaKey || e.altKey) return
  const target = e.target as HTMLInputElement | null
  if (target?.tagName === 'INPUT' && (target.type === 'text' || target.type === 'password')) return
  if (e.code === 'Escape') {
    if (ui.isOpen()) ui.closePanel(true)
    else if (!locked()) ui.openPanel('settings')
    return
  }
  if (e.code === 'Tab') {
    e.preventDefault()
    scoreboardHeld = true
    hud.showScoreboard()
    return
  }
  if (e.code === 'Space') e.preventDefault()
  keys.add(e.code)
  if (e.repeat) return
  const panel = PANEL_KEYS[e.code]
  if (panel) {
    ui.togglePanel(panel)
    return
  }
  if (ui.isOpen()) return
  switch (e.code) {
    case 'Enter':
      e.preventDefault()
      openChat()
      return
    case 'KeyQ':
      return castSpell(0)
    case 'KeyE':
      return castSpell(1)
    case 'KeyR':
      return castSpell(2)
    case 'KeyF':
      return castSpell(3)
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4':
      return useQuick(Number(e.code.slice(5)) - 1)
    case 'KeyG':
      return throwGrenade()
    case 'KeyX':
      return swapWeapon()
    case 'Space':
      return dash()
  }
})

document.addEventListener('keyup', (e) => {
  keys.delete(e.code)
  if (e.code === 'Tab') {
    scoreboardHeld = false
    el.scoreboard.classList.add('hidden')
  }
})

function openChat() {
  chatting = true
  keys.clear()
  mouseHeld = false
  el.chat.classList.remove('hidden')
  el.chat.value = ''
  el.log.classList.add('open')
  if (document.pointerLockElement) document.exitPointerLock()
  setTimeout(() => el.chat.focus(), 0)
}

function closeChat(relock: boolean) {
  if (!chatting) return
  chatting = false
  el.chat.blur()
  el.chat.classList.add('hidden')
  el.log.classList.remove('open')
  if (relock) lockPointer()
}

// --- Actions ----------------------------------------------------------------------------------------------
/** Aim from the server's eye towards whatever is under the crosshair. */
function aimMsg(): Aim {
  let dx = aim.point.x - pos.x
  let dy = aim.point.y - SERVER_EYE
  let dz = aim.point.z - pos.z
  let l = Math.hypot(dx, dy, dz)
  if (l < 0.6) {
    const c = Math.cos(pitch)
    dx = -Math.sin(yaw) * c
    dy = Math.sin(pitch)
    dz = -Math.cos(yaw) * c
    l = 1
  }
  const msg: Aim = { dx: round3(dx / l), dy: round3(dy / l), dz: round3(dz / l) }
  if (aim.monster) msg.target = aim.monster.net.id
  return msg
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

function castSpell(slot: number) {
  const char = S.char
  const you = S.you
  const stats = S.stats
  if (!char || !you || !stats || you.dead) return
  if (disabled()) {
    hud.toast('You are stunned.', 'bad')
    return
  }
  const id = char.spells[slot]
  if (!id) {
    hud.toast('That spell slot is empty. Open the spellbook (B) to fill it.')
    sfx.denied()
    return
  }
  const def = SPELL_BY_ID[id]
  if (!def) return
  const t = now()
  if ((you.cd[slot] ?? 0) > 0.1 || t < castLock[slot]) {
    sfx.empty()
    return
  }
  const cost = Math.round(def.mana * stats.spellCost)
  if (you.mana < cost) {
    sfx.noMana()
    hud.toast('Not enough mana.', 'nomana')
    return
  }
  castLock[slot] = t + 0.3
  send({ t: 'cast', slot, ...aimMsg() })
}

function useQuick(slot: number) {
  const char = S.char
  const you = S.you
  if (!char || !you || you.dead) return
  const key = char.quickbar[slot]
  if (!key) {
    hud.toast(`Quickbar slot ${slot + 1} is empty. Assign a potion from the inventory (I).`)
    sfx.denied()
    return
  }
  if (stackCount(key) <= 0) {
    hud.toast(`No ${stackName(key)} left.`)
    sfx.denied()
    return
  }
  const t = now()
  if (you.potion > 0.05 || t < potionLock) return
  potionLock = t + 0.25
  send({ t: 'use', slot, ...aimMsg() })
}

function throwGrenade() {
  const char = S.char
  const you = S.you
  if (!char || !you || you.dead) return
  if (!char.inventory.some((it) => it?.kind === 'grenade')) {
    hud.toast('No grenades left. The black market sells them.')
    sfx.denied()
    return
  }
  const t = now()
  if (you.potion > 0.05 || t < potionLock) return
  potionLock = t + 0.25
  send({ t: 'grenade', ...aimMsg() })
}

function swapWeapon() {
  const char = S.char
  if (!char || S.you?.dead) return
  const t = now()
  if (t < swapAt) return
  swapAt = t + 0.35
  const other = char.active === 0 ? char.equipment.weapon2 : char.equipment.weapon
  if (!other) {
    hud.toast('You have no second weapon. Equip one from the inventory (I).')
    return
  }
  setPlasma(false)
  charging = false
  hud.setCharge(0)
  send({ t: 'swap' })
  sfx.equip()
}

/** Movement input as a world direction, plus whether it points forward. */
function wishDir() {
  let fwd = 0
  let side = 0
  if (!chatting) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1
    if (keys.has('KeyA') || keys.has('ArrowLeft')) side -= 1
  }
  let x = -Math.sin(yaw) * fwd + Math.cos(yaw) * side
  let z = -Math.cos(yaw) * fwd - Math.sin(yaw) * side
  const l = Math.hypot(x, z)
  if (l > 0) {
    x /= l
    z /= l
  }
  return { x, z, fwd, moving: l > 0 }
}

function dash() {
  const you = S.you
  if (!you || you.dead) return
  if (statusOn('rooted') || disabled()) {
    sfx.denied()
    return
  }
  const t = now()
  if (t < dashReady || you.dash > 0.15) {
    sfx.empty()
    return
  }
  const w = wishDir()
  if (w.moving) dashDir.set(w.x, w.z)
  else dashDir.set(-Math.sin(yaw), -Math.cos(yaw))
  dashUntil = t + DASH_TIME
  dashReady = t + (S.stats?.dashCooldown ?? 2.5)
  sendMove(true)
  sfx.dash()
  fovBoost = 9
  effects.burst(v3(pos.x, 0.6, pos.z), '#9ff6ff', 24, 3, 0.4, 0.25)
}

function speedMult() {
  const st = S.stats
  const you = S.you
  let m = st?.moveSpeed ?? 1
  if (statusOn('haste')) m *= 1.25
  if (statusOn('slowed')) m *= 0.6
  if (st?.powers.includes('adrenal') && you && you.hp < you.maxHp * 0.3) m *= 1.25
  return m
}

function fireRate() {
  const st = S.stats
  const you = S.you
  let r = st?.fireRate ?? 1
  if (statusOn('haste')) r *= 1.3
  if (st?.powers.includes('adrenal') && you && you.hp < you.maxHp * 0.3) r *= 1.25
  return r
}

function sendMove(dashing = false) {
  const msg = { t: 'move' as const, x: round2(pos.x), z: round2(pos.z), yaw: round3(yaw), pitch: round3(pitch) }
  send(dashing ? { ...msg, dash: true } : msg)
  moveSentAt = now()
  lastMoveKey = `${msg.x},${msg.z},${msg.yaw},${msg.pitch}`
}

function setPlasma(on: boolean) {
  if (plasmaOn === on) return
  plasmaOn = on
  sfx.plasmaLoop(on)
  rig.firing = on
  if (!on) rig.setBeam(0)
}

// --- Aim ----------------------------------------------------------------------------------------------------
interface Interact {
  id: string
  text: string
  inReach: boolean
  dist: number
}

const raycaster = new THREE.Raycaster()
const aimCam = new THREE.PerspectiveCamera()
aimCam.rotation.order = 'YXZ'
const aim = {
  origin: new THREE.Vector3(),
  dir: new THREE.Vector3(0, 0, -1),
  point: new THREE.Vector3(),
  dist: 0,
  wallDist: 0,
  monster: null as MonsterView | null,
  interact: null as Interact | null,
}

function propCtx(): PropCtx | null {
  const state = S.state
  return state ? { time, serverTime: serverNow(), state, char: S.char } : null
}

function describe(obj: THREE.Object3D): Interact | null {
  const id = obj.userData.interact as string | undefined
  const state = S.state
  if (!id || !state) return null
  if (id.startsWith('gate:')) {
    const cell = Number(id.slice(5))
    if (state.gates.includes(cell)) return null
    const W = S.world?.width ?? 1
    const d = Math.hypot(cellCenter(cell % W) - pos.x, cellCenter(Math.floor(cell / W)) - pos.z)
    return { id, text: 'Inspect the sector gate', inReach: d <= 6, dist: 0 }
  }
  const vault = S.vaults.get(id)
  if (vault) {
    if (state.vaults.includes(id)) return null
    const d = Math.hypot(cellCenter(vault.x) - pos.x, cellCenter(vault.z) - pos.z)
    let text = 'Inspect the sealed vault'
    if (vault.lock === 'keycard') {
      const has = S.char?.inventory.some((it) => it?.kind === 'keycard' && it.base === String(vault.sector))
      text = has ? 'Open the vault with your keycard' : 'Sealed vault: it needs a keycard'
    }
    return { id, text, inReach: d <= REACH + 0.4, dist: 0 }
  }
  const o = S.objects.get(id)
  const ctx = propCtx()
  if (!o || !props || !ctx) return null
  const text = props.prompt(id, ctx)
  if (!text) return null
  const d = Math.hypot(cellCenter(o.x) - pos.x, cellCenter(o.z) - pos.z)
  return { id, text, inReach: d <= REACH, dist: 0 }
}

function computeAim() {
  const grid = S.grid
  const o = aim.origin.set(pos.x, EYE_HEIGHT, pos.z)
  const c = Math.cos(pitch)
  const dir = aim.dir.set(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c)
  let wallDist = AIM_RANGE
  const horiz = Math.hypot(dir.x, dir.z)
  if (grid && horiz > 1e-4) wallDist = grid.rayHit(o.x, o.z, dir.x, dir.z, AIM_RANGE * horiz, Mode.Sight).dist / horiz
  if (dir.y < -1e-4) wallDist = Math.min(wallDist, o.y / -dir.y)
  if (dir.y > 1e-4) wallDist = Math.min(wallDist, (WALL_HEIGHT - o.y) / dir.y)
  aim.wallDist = wallDist

  aimCam.position.copy(o)
  aimCam.rotation.set(pitch, yaw, 0)
  aimCam.updateMatrixWorld()
  raycaster.camera = aimCam
  raycaster.set(o, dir)
  raycaster.near = 0
  raycaster.far = wallDist

  const sprites: THREE.Object3D[] = []
  for (const v of monsterViews.values()) if (!v.hidden && (v.net.f & MF.ally) === 0) sprites.push(v.sprite)
  const hit = sprites.length ? raycaster.intersectObjects(sprites, false)[0] : undefined
  aim.monster = hit ? (monsterViews.get(hit.object.userData.monsterId as number) ?? null) : null
  aim.dist = hit ? hit.distance : wallDist
  if (hit) aim.point.copy(hit.point)
  else aim.point.copy(o).addScaledVector(dir, wallDist)

  aim.interact = null
  if (pickables.length) {
    raycaster.far = Math.min(wallDist + 0.6, 14)
    for (const h of raycaster.intersectObjects(pickables, false)) {
      const it = describe(h.object)
      if (!it) continue
      it.dist = h.distance
      aim.interact = it
      break
    }
  }
}

// --- Firing ---------------------------------------------------------------------------------------------------
function updateFiring() {
  const t = now()
  const type = weaponType()
  const def = WEAPONS[type]
  const ready = locked() && canAct() && !ui.isOpen() && !chatting

  // A click shorter than a frame still pulls the trigger once.
  const clicked = clickQueued
  if (clickQueued) {
    clickQueued = false
    const it = aim.interact
    if (ready && it && (!aim.monster || aim.dist > it.dist)) {
      suppressFire = true
      if (it.inReach) useObject(it.id)
      else hud.toast('Too far away. Move closer.')
    }
  }
  const trigger = ready && (mouseHeld || clicked) && !suppressFire

  if (def.mode === 'charge') {
    setPlasma(false)
    if (trigger && !charging && t >= lastShot + def.interval / fireRate()) {
      charging = true
      chargeStart = t
      sfx.railCharge()
    }
    if (charging) {
      const charge = Math.min(def.charge ?? 0.8, t - chargeStart)
      const frac = charge / (def.charge ?? 0.8)
      rig.charge = frac
      hud.setCharge(frac)
      if (!ready) {
        charging = false
        rig.charge = 0
        hud.setCharge(0)
      } else if (!mouseHeld) fireRail(charge, frac)
    }
    return
  }
  if (charging) {
    charging = false
    rig.charge = 0
    hud.setCharge(0)
  }

  if (def.mode === 'beam') {
    setPlasma(trigger)
    if (trigger) rig.setBeam(Math.min(1.4, aim.dist))
  } else setPlasma(false)

  if (!trigger || t < fireReady) return
  fireReady = Math.max(t, fireReady) + def.interval / fireRate()
  lastShot = t
  send({ t: 'fire', ...aimMsg() })
  const muzzle = rig.muzzleWorld(tmpB)
  switch (def.mode) {
    case 'hitscan':
      effects.beam(muzzle, aim.point, def.color, 0.012, 0.12, true, true)
      rig.fire(0.8)
      sfx.weapon('laser')
      kick += 0.012
      break
    case 'beam': {
      const end = tmpA.copy(aim.origin).addScaledVector(aim.dir, Math.min(aim.dist, def.range))
      effects.beam(muzzle, end, def.color, 0.02, 0.11, false, true)
      if (aim.dist <= def.range) effects.flash(end, def.color, 0.8, 0.1)
      rig.fire(0.25)
      break
    }
    case 'melee': {
      rig.slash()
      effects.slash(v3(pos.x - Math.sin(yaw) * 0.4, EYE_HEIGHT - 0.45, pos.z - Math.cos(yaw) * 0.4), yaw, def.color, def.range)
      sfx.weapon('blade')
      break
    }
    case 'projectile':
      rig.fire(1.6)
      sfx.weapon(type)
      kick += 0.05
      shake = Math.min(1, shake + 0.12)
      break
  }
}

function fireRail(charge: number, frac: number) {
  const t = now()
  charging = false
  rig.charge = 0
  hud.setCharge(0)
  lastShot = t
  fireReady = t + WEAPONS.railgun.interval / fireRate()
  send({ t: 'fire', charge: round2(charge), ...aimMsg() })
  const end = tmpA.copy(aim.origin).addScaledVector(aim.dir, Math.min(aim.wallDist, WEAPONS.railgun.range))
  effects.beam(rig.muzzleWorld(tmpB), end, WEAPONS.railgun.color, 0.016 + 0.03 * frac, 0.35, true, true)
  rig.fire(1 + frac)
  sfx.weapon('railgun')
  kick += 0.03 + 0.05 * frac
  shake = Math.min(1, shake + 0.2 * frac)
}

/** Clicking an object: clues and the cipher keypad are handled here, everything else by the server. */
function useObject(id: string) {
  const o = S.objects.get(id)
  if (o?.kind === 'clue') {
    sfx.ui()
    ui.showClue(o)
    return
  }
  if (o?.kind === 'cipher') {
    if (S.state?.solved.includes(o.puzzle ?? '')) hud.toast('The cipher lock is already open.')
    else ui.showCipher(o)
    return
  }
  send({ t: 'interact', obj: id })
}

// --- Movement ---------------------------------------------------------------------------------------------------
function moveLocal(dt: number) {
  const you = S.you
  const grid = S.grid
  if (!you || !grid) return 0
  const stopped = you.dead || disabled()
  const w = stopped ? { x: 0, z: 0, fwd: 0, moving: false } : wishDir()
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')
  let speed = PLAYER_SPEED * (sprint && w.fwd > 0 ? SPRINT_MULT : 1) * speedMult()
  if (stopped || statusOn('rooted')) speed = 0
  const k = 1 - Math.exp(-dt * 14)
  vel.x += (w.x * speed - vel.x) * k
  vel.y += (w.z * speed - vel.y) * k
  let mx = vel.x
  let mz = vel.y
  const t = now()
  if (t < dashUntil && !you.dead) {
    mx = dashDir.x * DASH_SPEED
    mz = dashDir.y * DASH_SPEED
  }
  if (you.pull && !you.dead) {
    const [px, pz, ps] = you.pull
    const dx = px - pos.x
    const dz = pz - pos.z
    const d = Math.hypot(dx, dz)
    if (d > 0.6) {
      mx += (dx / d) * ps
      mz += (dz / d) * ps
    }
  }
  const dx = mx * dt
  const dz = mz * dt
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.25))
  const x0 = pos.x
  const z0 = pos.z
  for (let i = 0; i < steps; i++) {
    const r = grid.slide(pos.x, pos.z, dx / steps, dz / steps, PLAYER_RADIUS, Mode.Player)
    if (r.hitX) bumpFake(pos.x + Math.sign(dx) * (PLAYER_RADIUS + 0.2), pos.z)
    if (r.hitZ) bumpFake(pos.x, pos.z + Math.sign(dz) * (PLAYER_RADIUS + 0.2))
    pos.x = r.x
    pos.z = r.z
  }
  const moved = Math.hypot(pos.x - x0, pos.z - z0)
  if (moved > 0 && t >= dashUntil) {
    stepDist += moved
    if (stepDist > (sprint ? 2.9 : 2.3)) {
      stepDist = 0
      sfx.step()
    }
  }
  return dt > 0 ? moved / dt : 0
}

/** Walking into a fake wall gives it away. */
function bumpFake(x: number, z: number) {
  const grid = S.grid
  if (!grid) return
  const cx = toCell(x)
  const cz = toCell(z)
  if (grid.code(cx, cz) !== FAKE) return
  const cell = grid.index(cx, cz)
  if (grid.fakeOpen[cell]) return
  const t = now()
  if (t - (touchAt.get(cell) ?? -9) < 1) return
  touchAt.set(cell, t)
  send({ t: 'touch', cell })
}

// --- Frame ---------------------------------------------------------------------------------------------------
function gameFrame(dt: number) {
  const you = S.you
  const view = world
  if (!view || !you) return
  const t = now()
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw))

  const speed = moveLocal(dt)
  const dead = you.dead

  // Camera: bob, recoil kick, shake and a slump to the floor when crashed.
  bob += speed * dt * 1.15
  const bobAmt = t < dashUntil ? 0 : Math.min(1, speed / PLAYER_SPEED)
  shake = Math.max(0, shake - dt * 2.2)
  kick = Math.max(0, kick - dt * 0.35 - kick * dt * 8)
  fovBoost = Math.max(0, fovBoost - dt * 30)
  const sh = shake * shake * 0.12
  const eyeY = dead ? 0.45 : EYE_HEIGHT + Math.sin(bob * 2) * 0.035 * bobAmt
  camera.position.set(pos.x + (Math.random() - 0.5) * sh, eyeY + (Math.random() - 0.5) * sh, pos.z + (Math.random() - 0.5) * sh)
  camera.rotation.set(pitch + kick, yaw, dead ? 0.4 : Math.sin(bob) * 0.004 * bobAmt)
  const sprinting = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && speed > PLAYER_SPEED * 1.1
  const fov = settings.fov + fovBoost + (sprinting ? 4 : 0)
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 10)
    camera.updateProjectionMatrix()
  }
  camera.updateMatrixWorld()
  rig.root.visible = !dead

  computeAim()
  updateFiring()

  // Crosshair, prompt, target frame.
  const it = aim.interact
  const showUse = !!it && (!aim.monster || aim.dist > it.dist)
  hud.setCrosshair(aim.monster ? 'hot' : showUse && it?.inReach ? 'use' : '')
  hud.setPrompt(showUse && it && !dead ? it.text : '', !!it && !it.inReach)
  hud.setTarget(aim.monster?.net ?? null)

  // Tell the server where we are.
  const key = `${round2(pos.x)},${round2(pos.z)},${round3(yaw)},${round3(pitch)}`
  if (t - moveSentAt >= 0.05 && (key !== lastMoveKey || t - moveSentAt > 0.5)) sendMove()

  // The world around us.
  const movers: { x: number; z: number }[] = []
  if (!dead) movers.push(pos)
  for (const p of S.players.values()) if (p.id !== S.myId && !p.dead) movers.push(p)
  for (const v of monsterViews.values()) {
    const f = v.net.f
    if ((f & (MF.aggro | MF.ally)) !== 0 && (f & MF.hidden) === 0) movers.push(v.net)
  }
  view.updateDoors(movers)
  view.update(dt, time, (x, z) => {
    const s = spatial(x, z, 26)
    if (s.vol > 0.02) sfx.door(s.pan, s.vol)
  })
  const ctx = propCtx()
  if (ctx && props) props.update(ctx, dt, pos.x, pos.z)

  const eye = camera.position
  const grid = S.grid
  const inArena = !!grid && grid.arenaIndexAt(pos.x, pos.z) >= 0
  let boss: MonsterView | null = null
  let bossDist = 46
  let fighting = 0
  for (const v of monsterViews.values()) {
    const f = v.net.f
    const mx = v.root.position.x
    const mz = v.root.position.z
    const d = Math.hypot(mx - pos.x, mz - pos.z)
    const showBar = (f & MF.aggro) !== 0 || time - v.hurtAt < 5 || v === aim.monster || !!v.net.e
    v.update(dt, time, eye, showBar && d < 30)
    if ((f & MF.boss) !== 0 && d < bossDist && (inArena || (!!grid && grid.lineOfSight(pos.x, pos.z, mx, mz)))) {
      boss = v
      bossDist = d
    }
    if ((f & MF.aggro) !== 0 && (f & MF.ally) === 0 && d < 24) fighting++
  }
  for (const v of playerViews.values()) v.update(dt, time)
  projectiles.update(now(), time)
  zones.update(time, dt)
  loot.update(time, eye)
  hud.setBoss(boss?.net ?? null)

  // Where are we: sector, hub, ambience and lighting.
  const cx = toCell(pos.x)
  const cz = toCell(pos.z)
  const sector = grid ? grid.sectorAt(pos.x, pos.z) : 0
  const hub = grid ? grid.hubIndexAt(pos.x, pos.z) : -1
  const wk = `${sector}|${hub}`
  if (wk !== whereKey) {
    whereKey = wk
    hud.setWhere(sector, hub)
    setAmbience(sector, hub >= 0)
  }
  const ev = S.state?.event
  for (let s = 0; s < 4; s++) {
    const want = ev && ev.kind === 'outage' && ev.sector === s ? 0.18 : 1
    if (power.get(s) !== want) {
      view.setPower(s, want)
      power.set(s, want)
    }
  }
  const dark = hub < 0 && !!ev && ev.kind === 'outage' && ev.sector === sector
  updateLook(dt, view.lookAt(cx, cz), dark)
  updateLamps(view, pos.x, pos.z, dark ? 0.3 : 1)

  // Audio mood.
  setCombatIntensity(Math.min(1, fighting / 5))
  setBossMusic(!!boss && (boss.net.f & MF.aggro) !== 0)
  setLowHealth(!dead && you.hp / Math.max(1, you.maxHp) < 0.3)
  setMuffled(ui.isOpen() || dead)

  // Screen effects.
  damageFlash = Math.max(0, damageFlash - dt * 1.6)
  const u = screenFx.uniforms
  u.uDamage.value = Math.min(1, damageFlash + (dead ? 0.6 : 0))
  const tint = statusOn('frozen') ? '#9ff6ff' : statusOn('corrupted') ? '#9dff00' : statusOn('burning') ? '#ff7a3c' : statusOn('stealth') ? '#8fb8c8' : null
  if (tint) (u.uTint.value as THREE.Color).set(tint)
  u.uTintAmt.value += ((tint ? 0.12 : 0) - (u.uTintAmt.value as number)) * Math.min(1, dt * 4)
  u.uNoise.value = Math.max(statusOn('memleak') || statusOn('corrupted') ? 0.15 : 0, dead ? 0.35 : 0, Math.min(0.3, damageFlash * 0.25))
  screenFlash = Math.max(0, screenFlash - dt * 1.4)
  u.uFlash.value = screenFlash

  rig.update(dt, time, Math.min(1.5, speed / PLAYER_SPEED))

  // The HUD, at a gentler rate than the frame.
  hud.tickHud(dt)
  if (t - hudAt > 0.05) {
    hudAt = t
    hud.updateHud()
    if (dead) el.deadTimer.textContent = you.respawn > 0 ? `Rebooting in ${Math.ceil(you.respawn)}s…` : 'Rebooting…'
  }
  if (t - revealAt > 0.25) {
    revealAt = t
    view.reveal(pos.x, pos.z)
  }
  if (t - mapAt > 0.1) {
    mapAt = t
    const scanning = statusOn('scanner')
    const near = [...S.monsters.values()].filter((m) => scanning || Math.hypot(m.x - pos.x, m.z - pos.z) < 20)
    hud.drawMap(el.minimap, view, { x: pos.x, z: pos.z, yaw }, { radius: 13, monsters: near })
    el.online.textContent = `${S.players.size} online`
  }
  if (scoreboardHeld && t - scoreboardAt > 0.5) {
    scoreboardAt = t
    hud.showScoreboard()
  }
  if (ui.isOpen() && locked()) document.exitPointerLock()
  updatePaused()
}

let lastFrame = performance.now()
let fpsFrames = 0
let fpsAt = performance.now()
renderer.setAnimationLoop(() => {
  const t = performance.now()
  const dt = Math.min(0.05, (t - lastFrame) / 1000)
  lastFrame = t
  time += dt
  if (S.playing && world) gameFrame(dt)
  else attractFrame(dt)
  effects.update(dt)
  screenFx.uniforms.uTime.value = time
  if (!S.playing) {
    screenFx.uniforms.uDamage.value = 0
    screenFx.uniforms.uTintAmt.value = 0
    screenFx.uniforms.uNoise.value = 0
    screenFx.uniforms.uFlash.value = 0
  }
  composer.render(dt)
  fpsFrames++
  if (settings.showFps && t - fpsAt > 500) {
    el.fps.textContent = `${Math.round((fpsFrames * 1000) / (t - fpsAt))} FPS · ${effects.count} effects`
    fpsFrames = 0
    fpsAt = t
  }
})

startAttract()
el.name.focus()

// A small handle for automated browser tests and debugging from the console.
;(window as unknown as { spacemyst: unknown }).spacemyst = {
  S,
  scene,
  camera,
  get pos() {
    return { x: pos.x, z: pos.z, yaw, pitch }
  },
  look(y: number, p: number) {
    yaw = y
    pitch = clamp(p, -1.45, 1.45)
  },
  testLock(on: boolean) {
    testLock = on
    updatePaused()
  },
  aim: () => ({ monster: aim.monster?.net.id ?? null, interact: aim.interact, dist: aim.dist }),
  send,
  effects: () => effects.count,
  views: () => ({ monsters: monsterViews.size, players: playerViews.size }),
  monsterName,
}
