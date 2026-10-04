// Monster spawning and behaviour.
import { CELL, PLAYER_RADIUS, SECTOR_LEVELS, SECTOR_MONSTERS, WALL_HEIGHT, cellCenter, toCell } from '../shared/constants.ts'
import { Mode } from '../shared/grid.ts'
import {
  ELITE_CHANCE,
  ELITE_DAMAGE_MULT,
  ELITE_HP_MULT,
  ELITE_KINDS,
  MONSTER_BY_KEY,
  BOSS_SIZE_MULT,
  SPAWN_TABLES,
  monsterDamage,
  monsterMaxHp,
  rollPack,
  type DamageType,
  type EliteKind,
} from '../shared/monsters.ts'
import { pick, randInt } from '../shared/rng.ts'
import { DIRS, FLOOR, inRect } from '../shared/world.ts'
import * as actions from './actions.ts'
import { explode, hitMonster, hurtPlayer, monsterRadius, statusMonster, statusPlayer, yawTo } from './combat.ts'
import type { Monster, Player, TargetRef, Zone } from './entities.ts'
import type { Game } from './game.ts'
import * as worldstate from './worldstate.ts'

// --- Spawn cells --------------------------------------------------------------------------------
interface Cache {
  world: unknown
  spawn: number[][]
  corridor: number[][]
}
let cache: Cache | null = null

/** Floor cells where monsters may appear, per sector (no hubs, arenas or sealed rooms). */
function cells(g: Game): Cache {
  if (cache && cache.world === g.world) return cache
  const W = g.world.width
  const spawn: number[][] = [[], [], [], []]
  const corridor: number[][] = [[], [], [], []]
  const pockets = [...g.world.vaults, ...g.world.fakes]
  for (let z = 1; z < g.world.height - 1; z++)
    for (let x = 1; x < W - 1; x++) {
      const i = z * W + x
      const c = g.world.cells[i]
      if (c !== FLOOR) continue
      if (g.grid.hubAt[i] || g.grid.arenaAt[i]) continue
      if (pockets.some((r) => inRect(r, x, z))) continue
      if (g.world.gates.some((gt) => Math.abs(gt.x - x) + Math.abs(gt.z - z) <= 2)) continue
      const s = g.world.sector[i]
      spawn[s].push(i)
      if ((x + z) % 2 === 1) corridor[s].push(i)
    }
  cache = { world: g.world, spawn, corridor }
  return cache
}

export interface SpawnOpts {
  level?: number
  sector?: number
  boss?: boolean
  arena?: string
  elite?: EliteKind | 'roll' | null
  pack?: number
  ambush?: boolean
  generation?: number
  size?: number
  hpMult?: number
  noCorruption?: boolean
  turretObj?: string
  despawnAt?: number
  target?: TargetRef | null
}

export function spawnMonster(g: Game, key: string, x: number, z: number, o: SpawnOpts = {}): Monster {
  const def = MONSTER_BY_KEY[key]
  const sector = o.sector ?? g.grid.sectorAt(x, z)
  const [lo, hi] = SECTOR_LEVELS[sector]
  const level = o.level ?? randInt(g.rand, lo, hi)
  let elite: EliteKind | undefined
  if (o.elite === 'roll') {
    const eligible = !o.boss && !def.stationary && def.behaviour !== 'zeroday' && def.behaviour !== 'dragon'
    if (eligible && g.rand() < ELITE_CHANCE[sector]) elite = pick(g.rand, ELITE_KINDS)
  } else if (o.elite) elite = o.elite
  const boss = !!o.boss
  const maxHp = Math.max(1, Math.round(monsterMaxHp(def, level, boss) * (elite ? ELITE_HP_MULT : 1) * (o.hpMult ?? 1)))
  const m: Monster = {
    id: g.nextId(),
    def,
    level,
    x,
    z,
    y: def.behaviour === 'turret' ? WALL_HEIGHT - 1.1 : 0,
    yaw: g.rand() * Math.PI * 2,
    hp: maxHp,
    maxHp,
    sector,
    boss,
    arena: o.arena,
    elite,
    size: (boss ? BOSS_SIZE_MULT : 1) * (o.size ?? 1),
    speed: def.speed * (elite === 'overclocked' ? 1.5 : 1),
    damage: Math.round(monsterDamage(def, level, boss) * (elite ? ELITE_DAMAGE_MULT : 1)),
    statuses: new Map(),
    target: o.target ?? null,
    lastSeen: null,
    home: { x, z },
    wander: null,
    nextThink: g.time + g.rand() * 0.25,
    attackReady: g.time + 0.5 + g.rand(),
    windup: null,
    dash: null,
    pack: o.pack ?? 0,
    ambush: !!o.ambush,
    shield: 0,
    shieldMax: 0,
    lastHurt: 0,
    contributors: new Map(),
    distressUsed: false,
    distressUntil: 0,
    revealedUntil: 0,
    allyOf: null,
    allyUntil: 0,
    generation: o.generation ?? 0,
    splitDone: false,
    fuseAt: 0,
    nextSpecial: g.time + 2 + g.rand() * 3,
    nextBlink: g.time + 3 + g.rand() * 2,
    nextJunk: g.time + 2,
    phase: boss ? 1 : 0,
    spawnedAt: g.time,
    despawnAt: o.despawnAt ?? 0,
    turretObj: o.turretObj,
    vulnerableUntil: 0,
    submergedUntil: 0,
    noCorruption: !!o.noCorruption,
    dead: false,
    active: true,
  }
  if (elite === 'encrypted') {
    m.shieldMax = Math.round(maxHp * 0.5)
    m.shield = m.shieldMax
  }
  if (m.target) m.lastSeen = null
  g.monsters.set(m.id, m)
  return m
}

let packCounter = 1

/** Spawns a pack around a cell centre. Members spread over nearby open cells. */
export function spawnPack(g: Game, sector: number, x: number, z: number, o: SpawnOpts & { keys?: string[] } = {}) {
  const keys = o.keys ?? rollPack(g.rand, sector)
  const pack = packCounter++
  const spots = openCellsNear(g, x, z, 2)
  return keys.map((key, i) => {
    const cell = spots[i % spots.length] ?? { x, z }
    const jx = (g.rand() - 0.5) * 1.6
    const jz = (g.rand() - 0.5) * 1.6
    const px = g.grid.blocked(cell.x + jx, cell.z + jz, 0.6, Mode.Monster) ? cell.x : cell.x + jx
    const pz = g.grid.blocked(px, cell.z + jz, 0.6, Mode.Monster) ? cell.z : cell.z + jz
    return spawnMonster(g, key, px, pz, { elite: 'roll', ...o, sector, pack })
  })
}

/** Open cell centres within `radius` cells of a point, nearest first. */
function openCellsNear(g: Game, x: number, z: number, radius: number) {
  const cx = toCell(x)
  const cz = toCell(z)
  const out: { x: number; z: number; d: number }[] = []
  for (let dz = -radius; dz <= radius; dz++)
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = cx + dx
      const nz = cz + dz
      if (g.grid.solid(nx, nz, Mode.Monster)) continue
      const px = cellCenter(nx)
      const pz = cellCenter(nz)
      if (!g.grid.lineOfSight(x, z, px, pz, Mode.Monster)) continue
      out.push({ x: px, z: pz, d: Math.abs(dx) + Math.abs(dz) })
    }
  return out.sort((a, b) => a.d - b.d)
}

/** A spawn cell in a sector that no player can see and that is not too close to anyone. */
function hiddenSpawnCell(g: Game, sector: number, minDist = 22) {
  const list = cells(g).spawn[sector]
  for (let tries = 0; tries < 30; tries++) {
    const i = list[Math.floor(g.rand() * list.length)]
    const { x, z } = g.cellPos(i)
    let ok = true
    for (const p of g.players.values()) {
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < minDist || (d < 48 && g.grid.lineOfSight(p.x, p.z, x, z))) {
        ok = false
        break
      }
    }
    if (ok) return { x, z, corridor: (toCell(x) + toCell(z)) % 2 === 1 }
  }
  return null
}

const regularCount = (g: Game, sector: number) => {
  let n = 0
  for (const m of g.monsters.values()) if (m.sector === sector && !m.boss && !m.def.stationary && !m.despawnAt && !m.noCorruption) n++
  return n
}

export function populateWorld(g: Game) {
  cache = null
  for (let s = 0; s < 4; s++) {
    let guard = 0
    while (regularCount(g, s) < SECTOR_MONSTERS[s] && guard++ < 200) {
      const spot = hiddenSpawnCell(g, s, 18)
      if (!spot) break
      spawnPack(g, s, spot.x, spot.z, { ambush: spot.corridor && g.rand() < 0.15 })
    }
  }
  for (const o of g.world.objects) if (o.kind === 'turret' && !g.state.turretsDown.includes(o.id)) spawnTurret(g, o.id)
  worldstate.spawnBosses(g)
}

export function spawnTurret(g: Game, objId: string) {
  const o = g.objects.get(objId)
  if (!o) return
  spawnMonster(g, 'turret', cellCenter(o.x), cellCenter(o.z), { sector: o.sector, turretObj: o.id, elite: null })
}

const spawnClock = [0, 0, 0, 0]

/** Keeps every sector populated as monsters die. */
export function spawner(g: Game, dt: number) {
  if (!g.players.size || g.state.seasonEndsAt !== undefined) return
  for (let s = 0; s < 4; s++) {
    spawnClock[s] -= dt
    if (spawnClock[s] > 0) continue
    spawnClock[s] = 1.2
    const outbreak = g.state.event?.kind === 'outbreak' && g.state.event.sector === s ? 14 : 0
    if (regularCount(g, s) >= SECTOR_MONSTERS[s] + outbreak) continue
    const spot = hiddenSpawnCell(g, s)
    if (spot) spawnPack(g, s, spot.x, spot.z, { ambush: spot.corridor && g.rand() < 0.15 })
  }
}

// --- Flow fields ----------------------------------------------------------------------------------
const FLOW_RADIUS = 26
const flowCache = new Map<number, { dist: Int16Array; at: number; world: unknown }>()

/** BFS distances (in cells) to a goal cell for walking monsters, cached briefly. */
function flowTo(g: Game, goal: number) {
  const cached = flowCache.get(goal)
  if (cached && cached.world === g.world && g.time - cached.at < 1) return cached.dist
  const W = g.world.width
  const H = g.world.height
  const dist = cached && cached.world === g.world ? cached.dist : new Int16Array(W * H)
  dist.fill(-1)
  dist[goal] = 0
  const queue = new Int32Array(W * H)
  let head = 0
  let tail = 0
  queue[tail++] = goal
  while (head < tail) {
    const i = queue[head++]
    const d = dist[i]
    if (d >= FLOW_RADIUS) continue
    const x = i % W
    const z = (i - x) / W
    for (const [dx, dz] of DIRS) {
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue
      const n = nz * W + nx
      if (dist[n] !== -1 || g.grid.solid(nx, nz, Mode.Monster)) continue
      dist[n] = d + 1
      queue[tail++] = n
    }
  }
  if (flowCache.size > 64) flowCache.clear()
  flowCache.set(goal, { dist, at: g.time, world: g.world })
  return dist
}

/** True if a fat body can walk straight from a to b. */
function clearPath(g: Game, ax: number, az: number, bx: number, bz: number, r: number) {
  const d = Math.hypot(bx - ax, bz - az) || 1
  const ox = (-(bz - az) / d) * r
  const oz = ((bx - ax) / d) * r
  return (
    g.grid.lineOfSight(ax, az, bx, bz, Mode.Monster) &&
    g.grid.lineOfSight(ax + ox, az + oz, bx + ox, bz + oz, Mode.Monster) &&
    g.grid.lineOfSight(ax - ox, az - oz, bx - ox, bz - oz, Mode.Monster)
  )
}

// --- Targets --------------------------------------------------------------------------------------
interface TargetInfo {
  x: number
  z: number
  r: number
  player?: Player
  monster?: Monster
  zone?: Zone
}

function resolve(g: Game, ref: TargetRef | null): TargetInfo | null {
  if (!ref) return null
  if (ref.kind === 'player') {
    const p = g.players.get(ref.id)
    return p && !p.dead ? { x: p.x, z: p.z, r: 0.5, player: p } : null
  }
  if (ref.kind === 'monster') {
    const m = g.monsters.get(ref.id)
    return m && !m.dead ? { x: m.x, z: m.z, r: monsterRadius(m), monster: m } : null
  }
  const zn = g.zones.get(ref.id)
  return zn ? { x: zn.x, z: zn.z, r: 0.6, zone: zn } : null
}

const inNoise = (g: Game, x: number, z: number) => {
  for (const zn of g.zones.values()) if (zn.kind === 'noise' && Math.hypot(zn.x - x, zn.z - z) < zn.r) return true
  return false
}

/** Whether a monster may (keep) hunting a player. */
function canHunt(g: Game, m: Monster, p: Player, dist: number) {
  if (p.dead || g.time < p.shieldUntil || p.hub >= 0) return false
  if (p.statuses.has('stealth')) return false
  if (dist > 2.5 && inNoise(g, p.x, p.z)) return false
  if (m.arena) {
    const arena = g.world.arenas.find((a) => a.id === m.arena)
    if (arena && !inRect(arena, toCell(p.x), toCell(p.z))) return false
  }
  return true
}

/** A monster was hit: it turns on the attacker and wakes its pack. */
export function provoke(g: Game, m: Monster, p: Player) {
  if (m.ambush) wakeAmbush(g, m, p)
  if (!canHunt(g, m, p, 0)) return
  if (!m.target || m.target.kind !== 'player' || g.rand() < 0.3) m.target = { kind: 'player', id: p.id }
  m.lastSeen = { x: p.x, z: p.z, at: g.time }
  alertPack(g, m)
}

function alertPack(g: Game, m: Monster) {
  if (!m.pack || !m.target) return
  for (const o of g.monsters.values()) {
    if (o === m || o.pack !== m.pack || o.target || o.allyOf) continue
    if (Math.hypot(o.x - m.x, o.z - m.z) > 28) continue
    o.target = m.target
    o.lastSeen = m.lastSeen
    if (o.ambush) wakeAmbush(g, o, null)
  }
}

function wakeAmbush(g: Game, m: Monster, p: Player | null) {
  if (!m.ambush) return
  m.ambush = false
  g.emit({ kind: 'ambush', m: m.id, x: m.x, z: m.z }, m)
  statusMonster(g, m, 'stunned', 0.45)
  if (p) {
    m.target = { kind: 'player', id: p.id }
    m.lastSeen = { x: p.x, z: p.z, at: g.time }
  }
}

function selectTarget(g: Game, m: Monster): TargetRef | null {
  const now = g.time
  // Hijacked: hunt the nearest hostile program.
  if (m.allyOf) {
    let best: Monster | null = null
    let bestD = 22
    for (const o of g.monsters.values()) {
      if (o === m || o.dead || o.allyOf || o.ambush || o.def.behaviour === 'node') continue
      const d = Math.hypot(o.x - m.x, o.z - m.z)
      if (d < bestD && g.grid.lineOfSight(m.x, m.z, o.x, o.z)) {
        best = o
        bestD = d
      }
    }
    return best ? { kind: 'monster', id: best.id } : null
  }
  // Honeypots draw everyone nearby.
  for (const zn of g.zones.values()) {
    if (zn.kind !== 'honeypot') continue
    const d = Math.hypot(zn.x - m.x, zn.z - m.z)
    if (d < zn.r && (d < 4 || g.grid.lineOfSight(m.x, m.z, zn.x, zn.z))) return { kind: 'zone', id: zn.id }
  }
  // Keep the current target while it stays valid.
  const cur = resolve(g, m.target)
  if (cur?.player) {
    const d = Math.hypot(cur.x - m.x, cur.z - m.z)
    if (canHunt(g, m, cur.player, d)) {
      if (g.grid.lineOfSight(m.x, m.z, cur.x, cur.z) || m.def.noclip) {
        m.lastSeen = { x: cur.x, z: cur.z, at: now }
        return m.target
      }
      if (m.lastSeen && now - m.lastSeen.at < 7) return m.target
    }
  } else if (cur?.monster && m.target?.kind === 'monster') {
    if (cur.monster.allyOf) return m.target
  }
  // Look for a new player.
  let best: Player | null = null
  let bestD = m.def.aggroRange * (m.elite === 'overclocked' ? 1.2 : 1)
  for (const p of g.players.values()) {
    const d = Math.hypot(p.x - m.x, p.z - m.z)
    if (d > bestD || !canHunt(g, m, p, d)) continue
    if (d > 4 && !g.grid.lineOfSight(m.x, m.z, p.x, p.z)) continue
    best = p
    bestD = d
  }
  if (best) {
    m.lastSeen = { x: best.x, z: best.z, at: now }
    return { kind: 'player', id: best.id }
  }
  return null
}

// --- Movement ---------------------------------------------------------------------------------------
function blockedByFirewall(g: Game, m: Monster, x: number, z: number) {
  if (m.boss) return false
  for (const zn of g.zones.values()) {
    if (zn.kind !== 'firewall') continue
    if (distToSegment(x, z, zn) < 0.9 + monsterRadius(m) * 0.5) return true
  }
  return false
}

/** Distance from a point to a line-shaped zone (centre x/z, angle, length). */
export function distToSegment(px: number, pz: number, zn: { x: number; z: number; angle: number; len: number }) {
  const ux = Math.cos(zn.angle)
  const uz = Math.sin(zn.angle)
  const half = zn.len / 2
  const rx = px - zn.x
  const rz = pz - zn.z
  const t = Math.max(-half, Math.min(half, rx * ux + rz * uz))
  return Math.hypot(rx - ux * t, rz - uz * t)
}

function moveBy(g: Game, m: Monster, dx: number, dz: number) {
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return
  const r = Math.min(0.85, Math.max(0.35, m.def.size * m.size * 0.28))
  let nx: number
  let nz: number
  if (m.def.noclip) {
    nx = m.x + dx
    nz = m.z + dz
    const cx = toCell(nx)
    const cz = toCell(nz)
    if (!g.grid.inside(cx, cz) || cx < 1 || cz < 1 || cx >= g.world.width - 1 || cz >= g.world.height - 1) return
    if (g.grid.hubAt[cz * g.world.width + cx]) return
    if (g.grid.sector[cz * g.world.width + cx] !== m.sector && !m.boss) return
  } else {
    const res = g.grid.slide(m.x, m.z, dx, dz, r, Mode.Monster)
    nx = res.x
    nz = res.z
  }
  if (blockedByFirewall(g, m, nx, nz)) return
  if (m.arena) {
    const a = g.world.arenas.find((ar) => ar.id === m.arena)
    if (a) {
      nx = Math.max(a.x0 * CELL + r, Math.min((a.x1 + 1) * CELL - r, nx))
      nz = Math.max(a.z0 * CELL + r, Math.min((a.z1 + 1) * CELL - r, nz))
    }
  }
  m.x = nx
  m.z = nz
}

function speedOf(g: Game, m: Monster) {
  let s = m.speed
  if (m.statuses.has('slowed')) s *= 0.6
  for (const zn of g.zones.values()) if (zn.kind === 'toxic' && Math.hypot(zn.x - m.x, zn.z - m.z) < zn.r) s *= 0.6
  for (const zn of g.zones.values()) if (zn.kind === 'noise' && Math.hypot(zn.x - m.x, zn.z - m.z) < zn.r) s *= 0.7
  return s
}

/** Walks towards a goal using direct steering when the way is clear and the flow field otherwise. */
function walkTo(g: Game, m: Monster, gx: number, gz: number, speed: number, dt: number) {
  let dirX = gx - m.x
  let dirZ = gz - m.z
  const d = Math.hypot(dirX, dirZ)
  if (d < 0.05) return
  if (!m.def.noclip && !clearPath(g, m.x, m.z, gx, gz, Math.min(0.6, m.def.size * 0.25))) {
    const goal = g.cellOf(gx, gz)
    const flow = flowTo(g, goal)
    const W = g.world.width
    const mc = g.cellOf(m.x, m.z)
    const here = flow[mc]
    if (here > 0) {
      let best = -1
      let bestScore = Infinity
      const cx = mc % W
      const cz = (mc - cx) / W
      for (const [ox, oz] of DIRS) {
        const n = (cz + oz) * W + cx + ox
        const v = flow[n]
        if (v < 0 || v >= here) continue
        const p = g.cellPos(n)
        const score = v * 10 + Math.hypot(p.x - gx, p.z - gz) * 0.01
        if (score < bestScore) {
          bestScore = score
          best = n
        }
      }
      if (best >= 0) {
        const p = g.cellPos(best)
        // Steer at the next cell's centre; once lined up with it the body slides through doorways.
        dirX = p.x - m.x
        dirZ = p.z - m.z
      }
    }
  }
  const len = Math.hypot(dirX, dirZ) || 1
  let vx = (dirX / len) * speed
  let vz = (dirZ / len) * speed
  // Keep a little space between monsters.
  for (const o of g.monsters.values()) {
    if (o === m || o.dead || o.ambush) continue
    const ox = m.x - o.x
    const oz = m.z - o.z
    const dd = Math.hypot(ox, oz)
    const min = monsterRadius(m) + monsterRadius(o)
    if (dd > 0.001 && dd < min) {
      vx += (ox / dd) * speed * 0.6 * (1 - dd / min)
      vz += (oz / dd) * speed * 0.6 * (1 - dd / min)
    }
  }
  const step = Math.min(speed * dt, d)
  const vl = Math.hypot(vx, vz) || 1
  let mx = (vx / vl) * step
  let mz = (vz / vl) * step
  // Stop at arm's length from players and slide around them: a monster inside you can't be seen or shot.
  const min = monsterRadius(m) + PLAYER_RADIUS
  for (const p of g.players.values()) {
    if (p.dead || Math.abs(p.x - m.x) > min + 1 || Math.abs(p.z - m.z) > min + 1) continue
    if (Math.hypot(m.x + mx - p.x, m.z + mz - p.z) >= min) continue
    const cd = Math.hypot(p.x - m.x, p.z - m.z)
    const ux = cd > 0.001 ? (p.x - m.x) / cd : Math.cos(m.id)
    const uz = cd > 0.001 ? (p.z - m.z) / cd : Math.sin(m.id)
    const toward = mx * ux + mz * uz
    if (toward > 0) {
      mx -= ux * toward
      mz -= uz * toward
    }
    if (cd < min) {
      const back = Math.min(speed * dt * 0.5, min - cd)
      mx -= ux * back
      mz -= uz * back
    }
  }
  moveBy(g, m, mx, mz)
}

function faceTowards(m: Monster, tx: number, tz: number, maxTurn = Infinity) {
  const want = yawTo(m.x, m.z, tx, tz)
  let diff = want - m.yaw
  diff = Math.atan2(Math.sin(diff), Math.cos(diff))
  m.yaw += Math.max(-maxTurn, Math.min(maxTurn, diff))
}

// --- Attacks ------------------------------------------------------------------------------------------
const pending: { at: number; run: () => void }[] = []

function later(g: Game, delay: number, run: () => void) {
  pending.push({ at: g.time + delay, run })
}

function windup(g: Game, m: Monster, what: string, dur: number, tx: number, tz: number, extra?: number) {
  const d = m.elite === 'overclocked' ? dur * 0.8 : dur
  m.windup = { what, until: g.time + d, tx, tz, extra }
  g.emit({ kind: 'windup', m: m.id, what, dur: d }, m)
  return d
}

function attackCooldown(m: Monster, mult = 1) {
  return m.def.attackTime * mult * (m.elite === 'overclocked' ? 0.66 : 1)
}

/** Damage from a monster to whatever it is fighting. */
function strike(g: Game, m: Monster, t: TargetInfo, mult: number, type: DamageType, special?: string) {
  const dmg = m.damage * mult
  if (t.player) return hurtPlayer(g, t.player, dmg, type, { name: m.def.name, x: m.x, z: m.z, key: m.def.key, special })
  if (t.monster) {
    const credit = m.allyOf ? (g.players.get(m.allyOf) ?? null) : null
    return hitMonster(g, t.monster, null, dmg * 1.5, { type, noCrit: true, creditTo: credit, fromX: m.x, fromZ: m.z })
  }
  if (t.zone) {
    t.zone.hp -= dmg
    if (t.zone.hp <= 0) g.zones.delete(t.zone.id)
    return dmg
  }
  return 0
}

/** Players (and decoys) inside a circle. */
function playersInCircle(g: Game, x: number, z: number, r: number) {
  return g.livePlayers().filter((p) => Math.hypot(p.x - x, p.z - z) <= r + 0.4)
}

function meleeReach(m: Monster, t: TargetInfo) {
  return m.def.range * Math.max(1, m.size * 0.8) + t.r
}

/** Starts or resolves a basic telegraphed melee attack. Returns true while busy attacking. */
function melee(g: Game, m: Monster, t: TargetInfo, dist: number, opts: { mult?: number; type?: DamageType; onHit?: (t: TargetInfo) => void; special?: string } = {}) {
  const now = g.time
  if (m.windup?.what === 'melee') {
    if (now < m.windup.until) return true
    m.windup = null
    m.attackReady = now + attackCooldown(m)
    if (dist <= meleeReach(m, t) + 0.7) {
      const dealt = strike(g, m, t, opts.mult ?? 1, opts.type ?? 'laser', opts.special)
      if (dealt > 0) opts.onHit?.(t)
    } else if (t.player) g.emit({ kind: 'miss', p: t.player.id, src: m.def.name }, { to: t.player.id })
    return true
  }
  if (!m.windup && dist <= meleeReach(m, t) && now >= m.attackReady) {
    windup(g, m, 'melee', m.def.windup, t.x, t.z)
    return true
  }
  return false
}

function leadAim(m: Monster, t: TargetInfo, speed: number) {
  const p = t.player
  if (!p) return { x: t.x, z: t.z }
  const d = Math.hypot(t.x - m.x, t.z - m.z)
  const time = (d / speed) * 0.6
  return { x: t.x + p.vx * time, z: t.z + p.vz * time }
}

function shoot(g: Game, m: Monster, t: TargetInfo, kind: string, speed: number, mult: number, type: DamageType, spread = 0, extra: Record<string, number | string> = {}) {
  const aim = leadAim(m, t, speed)
  const a = Math.atan2(aim.z - m.z, aim.x - m.x) + spread
  const y = m.def.behaviour === 'turret' ? m.y : Math.max(1, m.def.size * m.size * 0.55)
  const ty = 1.2
  const d = Math.hypot(aim.x - m.x, aim.z - m.z) || 1
  actions.spawnProjectile(g, {
    kind,
    x: m.x + Math.cos(a) * 0.6,
    y,
    z: m.z + Math.sin(a) * 0.6,
    vx: Math.cos(a) * speed,
    vy: ((ty - y) / d) * speed,
    vz: Math.sin(a) * speed,
    owner: { kind: 'monster', id: m.id },
    damage: m.damage * mult,
    dtype: type,
    radius: 0,
    gravity: 0,
    ttl: 3,
    hitRadius: 0.45,
    data: extra as never,
  })
}

// --- The update loop ------------------------------------------------------------------------------------
export function updateMonsters(g: Game, dt: number) {
  const now = g.time
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].at <= now) {
      const job = pending.splice(i, 1)[0]
      job.run()
    }
  }
  for (const m of [...g.monsters.values()]) {
    if (m.dead) continue
    if (m.despawnAt && now >= m.despawnAt) {
      g.monsters.delete(m.id)
      g.emit({ kind: 'system', text: `The ${m.def.name} slipped away into the network.`, cls: 'sys' })
      continue
    }
    // Only simulate monsters near someone.
    if (now >= m.nextThink) {
      m.active = g.nearestPlayerDist(m.x, m.z) < 95 || m.boss || !!m.allyOf
    }
    if (!m.active) continue
    tickStatuses(g, m)
    if (m.dead) continue
    if (m.shieldMax > 0 && m.shield < m.shieldMax && now - m.lastHurt > 5) m.shield = Math.min(m.shieldMax, m.shield + m.shieldMax * dt * 0.5)
    if (m.allyOf && now >= m.allyUntil) {
      const owner = g.players.get(m.allyOf)
      m.allyOf = null
      m.target = owner && !owner.dead ? { kind: 'player', id: owner.id } : null
      g.emit({ kind: 'status', m: m.id, s: 'released' }, m)
    }
    const disabled = m.statuses.has('stunned') || m.statuses.has('asleep') || m.statuses.has('frozen')
    // Pulled by a black hole.
    const pull = m.statuses.get('pulled')
    if (pull && pull.x !== undefined && pull.z !== undefined) {
      const dx = pull.x - m.x
      const dz = pull.z - m.z
      const d = Math.hypot(dx, dz)
      if (d > 0.4) moveBy(g, m, (dx / d) * Math.min(d, pull.power * dt), (dz / d) * Math.min(d, pull.power * dt))
    }
    if (disabled) continue
    // Ambushers wait in the vents until someone walks underneath.
    if (m.ambush) {
      if (now >= m.nextThink) {
        m.nextThink = now + 0.25
        for (const p of g.players.values()) {
          const d = Math.hypot(p.x - m.x, p.z - m.z)
          if (!p.dead && now >= p.shieldUntil && d < 4.5 && g.grid.lineOfSight(m.x, m.z, p.x, p.z)) {
            wakeAmbush(g, m, p)
            alertPack(g, m)
            break
          }
        }
      }
      continue
    }
    // Distress beacon channel.
    if (m.distressUntil > 0) {
      if (now >= m.distressUntil) finishDistress(g, m)
      continue
    }
    if (now >= m.nextThink) {
      m.nextThink = now + 0.25
      const before = m.target
      m.target = selectTarget(g, m)
      if (m.target && !before) {
        alertPack(g, m)
        if (m.target.kind === 'player') g.emit({ kind: 'windup', m: m.id, what: 'aggro', dur: 0 }, m)
      }
      if (!m.target && m.boss) bossIdle(g, m)
    }
    // Charging (Trojan Goliath).
    if (m.dash) {
      tickDash(g, m, dt)
      continue
    }
    const t = resolve(g, m.target)
    if (!t) {
      if (m.windup) m.windup = null
      idle(g, m, dt)
      continue
    }
    behave(g, m, t, dt)
  }
}

function tickStatuses(g: Game, m: Monster) {
  const now = g.time
  for (const [id, s] of m.statuses) {
    if (s.until <= now) {
      m.statuses.delete(id)
      continue
    }
    if ((id === 'burning' || id === 'corrupted') && (s.next ?? 0) <= now) {
      s.next = now + 0.5
      const owner = s.by ? (g.players.get(s.by) ?? null) : null
      hitMonster(g, m, null, s.power * 0.5, { type: id === 'burning' ? 'heat' : 'pure', noCrit: true, aoe: true, tag: id, creditTo: owner })
      if (m.dead) return
    }
  }
}

function idle(g: Game, m: Monster, dt: number) {
  if (m.def.stationary || m.def.speed === 0) return
  const home = Math.hypot(m.home.x - m.x, m.home.z - m.z)
  if (home > 32) m.wander = { ...m.home }
  if (!m.wander || Math.hypot(m.wander.x - m.x, m.wander.z - m.z) < 0.4) {
    m.wander = null
    if (g.rand() < 0.01) {
      const cx = toCell(m.home.x) + randInt(g.rand, -3, 3)
      const cz = toCell(m.home.z) + randInt(g.rand, -3, 3)
      if (!g.grid.solid(cx, cz, Mode.Monster)) m.wander = { x: cellCenter(cx), z: cellCenter(cz) }
    }
    return
  }
  walkTo(g, m, m.wander.x, m.wander.z, speedOf(g, m) * 0.35, dt)
  faceTowards(m, m.wander.x, m.wander.z, dt * 4)
}

function behave(g: Game, m: Monster, t: TargetInfo, dt: number) {
  const now = g.time
  const dist = Math.hypot(t.x - m.x, t.z - m.z)
  const visible = m.def.noclip || g.grid.lineOfSight(m.x, m.z, t.x, t.z)
  const chaseX = visible ? t.x : (m.lastSeen?.x ?? t.x)
  const chaseZ = visible ? t.z : (m.lastSeen?.z ?? t.z)
  const speed = speedOf(g, m)
  const rooted = m.statuses.has('rooted')
  const chase = (mult = 1) => {
    if (!rooted) walkTo(g, m, chaseX, chaseZ, speed * mult, dt)
  }
  switch (m.def.behaviour) {
    case 'swarm': {
      if (!melee(g, m, t, dist, { onHit: (tt) => tt.player && (tt.player.mana = Math.max(0, tt.player.mana - (2 + m.level * 0.5))) })) {
        if (dist > 3 && !rooted) {
          const side = Math.sin(now * 4 + m.id) * 1.4
          const nx = -(t.z - m.z) / (dist || 1)
          const nz = (t.x - m.x) / (dist || 1)
          walkTo(g, m, chaseX + nx * side, chaseZ + nz * side, speed, dt)
        } else chase()
      }
      faceTowards(m, t.x, t.z)
      return
    }
    case 'scuttler': {
      if (!melee(g, m, t, dist)) {
        chase()
        if (now >= m.nextJunk && dist > 2) {
          m.nextJunk = now + 3.5
          const mine = [...g.zones.values()].filter((zn) => zn.kind === 'junk' && zn.ownerMonster === m.id)
          if (mine.length < 3 && !mine.some((zn) => Math.hypot(zn.x - m.x, zn.z - m.z) < 3))
            actions.addZone(g, { kind: 'junk', x: m.x, z: m.z, r: 1.5, dur: 8, ownerMonster: m.id })
        }
      }
      faceTowards(m, t.x, t.z)
      return
    }
    case 'cloud': {
      if (!melee(g, m, t, dist)) {
        const wob = Math.sin(now * 2.3 + m.id * 1.7) * 0.9
        walkTo(g, m, chaseX + wob, chaseZ - wob, speed, dt)
      }
      faceTowards(m, t.x, t.z)
      return
    }
    case 'kiter':
      return kiter(g, m, t, dist, visible, speed, dt)
    case 'phantom': {
      if (!melee(g, m, t, dist, { special: undefined, onHit: (tt) => {
        if (tt.player && g.rand() < 0.3) {
          statusPlayer(g, tt.player, 'memleak', 10)
          g.emit({ kind: 'status', p: tt.player.id, s: 'memleak' }, tt.player)
        }
      } }))
        chase()
      faceTowards(m, t.x, t.z)
      return
    }
    case 'blinker':
      return blinker(g, m, t, dist, visible, speed, dt)
    case 'tank':
      return tank(g, m, t, dist, visible, speed, dt)
    case 'bomber':
      return bomber(g, m, t, dist, speed, dt)
    case 'worm': {
      if (!melee(g, m, t, dist)) chase()
      faceTowards(m, t.x, t.z)
      return
    }
    case 'guardian':
      return guardian(g, m, t, dist, speed, dt)
    case 'leviathan':
      return leviathan(g, m, t, dist, speed, dt)
    case 'singularity':
      return singularity(g, m, t, dist, visible, speed, dt)
    case 'mainframe':
      return worldstate.mainframeAct(g, m, dt)
    case 'zeroday':
      return zeroday(g, m, t, dist, speed, dt)
    case 'dragon':
      return dragon(g, m, t, dist, visible, speed, dt)
    case 'turret':
      return turret(g, m, t, dist, visible)
    case 'node':
      return
  }
}

function kiter(g: Game, m: Monster, t: TargetInfo, dist: number, visible: boolean, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z)
  if (m.windup) {
    if (now < m.windup.until) return
    const burst = m.windup.extra ?? 0
    m.windup = null
    shoot(g, m, t, 'fireball', m.def.projectile!.speed, burst > 0 ? 0.7 : 1, 'heat', burst > 0 ? (g.rand() - 0.5) * 0.15 : 0, { burn: 0.25 })
    if (burst > 1) windup(g, m, 'burst', 0.22, t.x, t.z, burst - 1)
    else m.attackReady = now + attackCooldown(m)
    return
  }
  if (visible && dist < 16 && now >= m.attackReady) {
    const burst = g.rand() < (m.def.special?.chance ?? 0) ? 3 : 0
    windup(g, m, burst ? 'burst' : 'cast', m.def.windup, t.x, t.z, burst)
    return
  }
  if (m.statuses.has('rooted')) return
  if (!visible || dist > 12) walkTo(g, m, visible ? t.x : (m.lastSeen?.x ?? t.x), visible ? t.z : (m.lastSeen?.z ?? t.z), speed, dt)
  else if (dist < 6.5) {
    const ax = m.x - t.x
    const az = m.z - t.z
    const d = Math.hypot(ax, az) || 1
    walkTo(g, m, m.x + (ax / d) * 3, m.z + (az / d) * 3, speed * 0.9, dt)
  } else {
    const dir = Math.floor(now / 2.2 + m.id) % 2 === 0 ? 1 : -1
    const nx = (-(t.z - m.z) / dist) * dir
    const nz = ((t.x - m.x) / dist) * dir
    walkTo(g, m, m.x + nx * 2, m.z + nz * 2, speed * 0.6, dt)
  }
}

function blinker(g: Game, m: Monster, t: TargetInfo, dist: number, visible: boolean, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z)
  if (m.windup?.what === 'web') {
    if (now < m.windup.until) return
    m.windup = null
    shoot(g, m, t, 'web', m.def.projectile!.speed, 0.4, 'laser', 0, { special: 'web' })
    m.attackReady = now + 0.8
    return
  }
  if (m.windup?.what === 'strike') {
    if (now < m.windup.until) return
    m.windup = null
    m.attackReady = now + attackCooldown(m)
    if (dist <= meleeReach(m, t) + 0.8) strike(g, m, t, 1.5, 'laser', 'Phase Strike')
    return
  }
  if (melee(g, m, t, dist)) return
  if (!m.windup && visible && dist <= 16 && dist > 3 && now >= m.nextBlink && !m.statuses.has('rooted')) {
    m.nextBlink = now + 4 + g.rand() * 2
    for (let tries = 0; tries < 8; tries++) {
      const a = g.rand() * Math.PI * 2
      const r = 2.4 + g.rand() * 1.4
      const nx = t.x + Math.cos(a) * r
      const nz = t.z + Math.sin(a) * r
      if (g.grid.blocked(nx, nz, 0.5, Mode.Monster) || !g.grid.lineOfSight(nx, nz, t.x, t.z)) continue
      g.emit({ kind: 'blink', who: String(m.id), x: m.x, z: m.z, tx: nx, tz: nz }, m)
      m.x = nx
      m.z = nz
      faceTowards(m, t.x, t.z)
      if (g.rand() < (m.def.special?.chance ?? 0)) windup(g, m, 'strike', 0.3, t.x, t.z)
      return
    }
  }
  if (!m.windup && visible && dist > 4 && dist < 12 && now >= m.nextSpecial) {
    m.nextSpecial = now + 6
    windup(g, m, 'web', 0.45, t.x, t.z)
    return
  }
  if (!m.statuses.has('rooted')) walkTo(g, m, visible ? t.x : (m.lastSeen?.x ?? t.x), visible ? t.z : (m.lastSeen?.z ?? t.z), speed, dt)
}

function tank(g: Game, m: Monster, t: TargetInfo, dist: number, visible: boolean, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z, dt * (m.boss ? 1.3 : 1.6))
  if (m.boss && now >= m.nextJunk) {
    // The Goliath's belly bay keeps releasing Byte Mites.
    m.nextJunk = now + 14
    g.emit({ kind: 'boss', key: m.def.key, arena: m.arena ?? '', state: 'phase', msg: 'The Trojan Goliath opens its belly bay!' }, m)
    spawnPack(g, m.sector, m.x, m.z, { keys: ['byte_mite', 'byte_mite', 'byte_mite'], noCorruption: true, level: m.level - 1, elite: null, target: m.target })
  }
  if (m.windup?.what === 'slam') {
    if (now < m.windup.until) return
    const w = m.windup
    m.windup = null
    m.attackReady = now + attackCooldown(m)
    for (const p of playersInCircle(g, w.tx, w.tz, 2.7)) strike(g, m, { x: p.x, z: p.z, r: 0.5, player: p }, 1.2, 'laser')
    if (t.monster && Math.hypot(t.x - w.tx, t.z - w.tz) < 2.7) strike(g, m, t, 1.2, 'laser')
    return
  }
  if (m.windup?.what === 'charge') {
    if (now < m.windup.until) return
    const w = m.windup
    m.windup = null
    const a = w.a ?? 0
    const len = w.extra ?? 12
    m.dash = { vx: Math.cos(a) * 15, vz: Math.sin(a) * 15, until: now + len / 15, hit: new Set() }
    return
  }
  if (!m.windup && visible && dist > 5 && dist < 15 && now >= m.nextSpecial && clearPath(g, m.x, m.z, t.x, t.z, 0.8)) {
    m.nextSpecial = now + (m.boss ? 5 : 7)
    const a = Math.atan2(t.z - m.z, t.x - m.x)
    const len = Math.min(dist + 3, 15)
    m.yaw = yawTo(m.x, m.z, t.x, t.z)
    const dur = windup(g, m, 'charge', 1.0, t.x, t.z)
    m.windup!.a = a
    m.windup!.extra = len
    g.emit({ kind: 'tele', shape: 'line', x: m.x, z: m.z, r: 1.3, a, l: len, dur }, m)
    return
  }
  if (!m.windup && dist <= meleeReach(m, t) + 0.6 && now >= m.attackReady) {
    const fx = m.x - Math.sin(m.yaw) * 1.4
    const fz = m.z - Math.cos(m.yaw) * 1.4
    const dur = windup(g, m, 'slam', m.def.windup, fx, fz)
    g.emit({ kind: 'tele', shape: 'circle', x: fx, z: fz, r: 2.7, dur }, m)
    return
  }
  if (!m.windup && !m.statuses.has('rooted')) walkTo(g, m, visible ? t.x : (m.lastSeen?.x ?? t.x), visible ? t.z : (m.lastSeen?.z ?? t.z), speed, dt)
}

function tickDash(g: Game, m: Monster, dt: number) {
  const d = m.dash!
  const now = g.time
  const bx = m.x
  const bz = m.z
  moveBy(g, m, d.vx * dt, d.vz * dt)
  const moved = Math.hypot(m.x - bx, m.z - bz)
  for (const p of g.livePlayers()) {
    if (d.hit.has(p.id) || Math.hypot(p.x - m.x, p.z - m.z) > 1.8) continue
    d.hit.add(p.id)
    hurtPlayer(g, p, m.damage * 1.5, 'laser', { name: m.def.name, x: m.x, z: m.z, key: m.def.key, special: 'Payload Delivery' })
  }
  if (now >= d.until || moved < 0.01) {
    m.dash = null
    m.attackReady = now + 1.2
  }
}

function bomber(g: Game, m: Monster, t: TargetInfo, dist: number, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z)
  if (m.fuseAt > 0) {
    if (now >= m.fuseAt) {
      detonate(g, m, null)
      return
    }
    if (!m.statuses.has('rooted')) walkTo(g, m, t.x, t.z, speed * 0.3, dt)
    return
  }
  if (dist <= 3) {
    m.fuseAt = now + 2
    g.emit({ kind: 'windup', m: m.id, what: 'fuse', dur: 2 }, m)
    g.emit({ kind: 'tele', shape: 'circle', x: m.x, z: m.z, r: 4.5, dur: 2, color: '#ff3355' }, m)
    return
  }
  if (!m.statuses.has('rooted')) walkTo(g, m, t.x, t.z, speed, dt)
}

/** A Logic Bomb goes off. Shot early it hurts monsters far more than players. */
export function detonate(g: Game, m: Monster, killer: Player | null) {
  if (!m.dead) {
    m.dead = true
    g.monsters.delete(m.id)
  }
  // A hijacked bomb only hurts programs, and its owner gets the credit.
  const ally = m.allyOf ? (g.players.get(m.allyOf) ?? null) : null
  explode(g, m.x, m.z, 4.5, m.damage, 'heat', null, {
    what: 'bomb',
    hurtPlayers: ally ? 0 : killer ? m.damage * 0.6 : m.damage,
    monsterMult: killer || ally ? 3 : 1.5,
    creditTo: killer ?? ally,
    src: m.def.name,
    color: '#ff3355',
  })
}

function guardian(g: Game, m: Monster, t: TargetInfo, dist: number, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z, dt * 3)
  const r = m.boss ? 7 : 5
  if (m.windup?.what === 'purge') {
    if (now < m.windup.until) return
    m.windup = null
    for (const p of playersInCircle(g, m.x, m.z, r)) strike(g, m, { x: p.x, z: p.z, r: 0.5, player: p }, 1.8, 'emp', 'System Purge')
    if (t.monster && dist < r) strike(g, m, t, 1.8, 'emp')
    g.emit({ kind: 'explode', x: m.x, z: m.z, r, what: 'purge', color: '#4fa8ff' }, m)
    m.vulnerableUntil = now + 1.6
    m.attackReady = now + 1.6
    statusMonster(g, m, 'stunned', m.boss ? 1.2 : 1.6)
    if (m.boss) {
      // Shockwave rings roll outwards after the slam.
      for (const [delay, ring] of [
        [0.6, 10],
        [1.2, 13],
      ] as const) {
        g.emit({ kind: 'tele', shape: 'circle', x: m.x, z: m.z, r: ring, dur: delay, color: '#4fa8ff' }, m)
        const cx = m.x
        const cz = m.z
        later(g, delay, () => {
          if (m.dead) return
          g.emit({ kind: 'explode', x: cx, z: cz, r: ring, what: 'ring', color: '#4fa8ff' }, { x: cx, z: cz })
          for (const p of g.livePlayers()) {
            const d = Math.hypot(p.x - cx, p.z - cz)
            if (d <= ring + 0.5 && d >= ring - 2.2) hurtPlayer(g, p, m.damage * 1.1, 'emp', { name: m.def.name, x: cx, z: cz, special: 'Purge Wave' })
          }
        })
      }
    }
    return
  }
  if (melee(g, m, t, dist, { type: 'laser' })) return
  if (!m.windup && dist < r - 0.5 && now >= m.nextSpecial && g.rand() < (m.def.special?.chance ?? 0.4) + 0.3) {
    m.nextSpecial = now + (m.boss ? 6 : 8)
    const dur = windup(g, m, 'purge', m.def.windup, m.x, m.z)
    g.emit({ kind: 'tele', shape: 'circle', x: m.x, z: m.z, r, dur, color: '#4fa8ff' }, m)
    return
  }
  if (!m.windup && !m.statuses.has('rooted')) {
    const leash = Math.hypot(m.home.x - m.x, m.home.z - m.z)
    if (leash > 20 && !m.boss) {
      m.target = null
      return
    }
    walkTo(g, m, t.x, t.z, speed, dt)
  }
}

function leviathan(g: Game, m: Monster, t: TargetInfo, dist: number, speed: number, dt: number) {
  const now = g.time
  if (m.submergedUntil > now) {
    // Swims through the walls to a new spot near the target.
    walkTo(g, m, m.wander?.x ?? t.x, m.wander?.z ?? t.z, speed * 2.2, dt)
    return
  }
  faceTowards(m, t.x, t.z)
  if (m.windup?.what === 'torrent') {
    if (now < m.windup.until) return
    const w = m.windup
    m.windup = null
    m.attackReady = now + attackCooldown(m, m.boss ? 0.8 : 1)
    const angles = m.boss ? [(w.a ?? 0) - 0.4, (w.a ?? 0) + 0.4] : [w.a ?? 0]
    for (const a of angles) torrent(g, m, a)
    return
  }
  if (m.boss && now >= m.nextBlink && !m.windup) {
    m.nextBlink = now + 18
    m.submergedUntil = now + 2.5
    const a = g.rand() * Math.PI * 2
    m.wander = { x: t.x + Math.cos(a) * 8, z: t.z + Math.sin(a) * 8 }
    g.emit({ kind: 'boss', key: m.def.key, arena: m.arena ?? '', state: 'phase', msg: 'The Data Leviathan dives into the walls!' }, m)
    return
  }
  if (!m.windup && dist < 18 && now >= m.attackReady) {
    const a = Math.atan2(t.z - m.z, t.x - m.x)
    const dur = windup(g, m, 'torrent', m.def.windup, t.x, t.z)
    m.windup!.a = a
    const angles = m.boss ? [a - 0.4, a + 0.4] : [a]
    for (const aa of angles) g.emit({ kind: 'tele', shape: 'line', x: m.x, z: m.z, r: 1.4, a: aa, l: 18, dur, color: '#2effd5' }, m)
    return
  }
  if (!m.windup) {
    // Hover at a comfortable range, often inside a wall.
    const want = 8
    const ax = m.x - t.x
    const az = m.z - t.z
    const d = Math.hypot(ax, az) || 1
    const gx = t.x + (ax / d) * want + Math.cos(now * 0.7 + m.id) * 2
    const gz = t.z + (az / d) * want + Math.sin(now * 0.7 + m.id) * 2
    walkTo(g, m, gx, gz, speed, dt)
  }
}

function torrent(g: Game, m: Monster, a: number) {
  const len = 18
  const zn = actions.addZone(g, {
    kind: 'torrent',
    x: m.x + Math.cos(a) * (len / 2),
    z: m.z + Math.sin(a) * (len / 2),
    r: 1.4,
    dur: 0.6,
    angle: a,
    len,
    ownerMonster: m.id,
  })
  for (const p of g.livePlayers()) {
    if (distToSegment(p.x, p.z, zn) > 1.5) continue
    // Walls protect: the torrent needs a clear line from the Leviathan.
    if (!g.grid.lineOfSight(m.x, m.z, p.x, p.z) && !inSameCellLine(g, m, p)) continue
    const dealt = hurtPlayer(g, p, m.damage, 'emp', { name: m.def.name, x: m.x, z: m.z, special: 'Corrupting Torrent' })
    if (dealt > 0) statusPlayer(g, p, 'corrupted', 4, m.damage * 0.25)
  }
}

/** The Leviathan sits inside walls; let the torrent start from the nearest open cell along its line. */
function inSameCellLine(g: Game, m: Monster, p: Player) {
  const a = Math.atan2(p.z - m.z, p.x - m.x)
  for (let s = 1; s < 4; s++) {
    const x = m.x + Math.cos(a) * s * 1.5
    const z = m.z + Math.sin(a) * s * 1.5
    if (!g.grid.solidAt(x, z, Mode.Sight)) return g.grid.lineOfSight(x, z, p.x, p.z)
  }
  return false
}

function singularity(g: Game, m: Monster, t: TargetInfo, dist: number, visible: boolean, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z)
  if (m.windup?.what === 'pull') {
    if (now < m.windup.until) return
    m.windup = null
    for (const p of playersInCircle(g, m.x, m.z, 10)) {
      if (!g.grid.lineOfSight(m.x, m.z, p.x, p.z)) continue
      statusPlayer(g, p, 'pulled', 2.2, 3.6, { x: m.x, z: m.z })
    }
    return
  }
  if (melee(g, m, t, dist, { mult: 2, type: 'emp', special: 'Event Horizon' })) return
  if (!m.windup && visible && dist < 12 && dist > 3 && now >= m.nextSpecial) {
    m.nextSpecial = now + 7
    const dur = windup(g, m, 'pull', 0.6, m.x, m.z)
    g.emit({ kind: 'tele', shape: 'circle', x: m.x, z: m.z, r: 10, dur, color: '#e0e0ff' }, m)
    return
  }
  if (!m.windup && !m.statuses.has('rooted')) walkTo(g, m, visible ? t.x : (m.lastSeen?.x ?? t.x), visible ? t.z : (m.lastSeen?.z ?? t.z), speed, dt)
}

function zeroday(g: Game, m: Monster, t: TargetInfo, dist: number, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z)
  if (m.windup?.what === 'melee') {
    if (now < m.windup.until) return
    m.windup = null
    m.attackReady = now + attackCooldown(m)
    const a = g.rand() * Math.PI * 2
    m.wander = { x: m.x + Math.cos(a) * 8, z: m.z + Math.sin(a) * 8 }
    m.nextSpecial = now + 2
    if (!t.player || dist > meleeReach(m, t) + 0.8) return
    if (g.rand() < 0.85) {
      g.emit({ kind: 'miss', p: t.player.id, src: m.def.name }, { to: t.player.id })
      return
    }
    hurtPlayer(g, t.player, t.player.stats.maxHp * 0.6, 'pure', { name: m.def.name, x: m.x, z: m.z, special: 'Perfect Execution' })
    return
  }
  if (now < m.nextSpecial && m.wander) {
    walkTo(g, m, m.wander.x, m.wander.z, speed, dt)
    return
  }
  if (!m.windup && dist <= meleeReach(m, t) && now >= m.attackReady) {
    windup(g, m, 'melee', m.def.windup, t.x, t.z)
    return
  }
  walkTo(g, m, t.x, t.z, speed, dt)
}

function dragon(g: Game, m: Monster, t: TargetInfo, dist: number, visible: boolean, speed: number, dt: number) {
  const now = g.time
  faceTowards(m, t.x, t.z, dt * 2.5)
  if (now >= m.nextJunk) {
    m.nextJunk = now + 20
    g.emit({ kind: 'boss', key: m.def.key, arena: '', state: 'phase', msg: 'The Rootkit Dragon roars and calls its brood!' }, m)
    spawnPack(g, m.sector, m.x, m.z, { noCorruption: true, elite: null, target: m.target })
  }
  if (m.windup?.what === 'breath') {
    if (now < m.windup.until) return
    const a = m.windup.a ?? 0
    m.windup = null
    m.attackReady = now + attackCooldown(m)
    for (const p of g.livePlayers()) {
      const d = Math.hypot(p.x - m.x, p.z - m.z)
      if (d > 12.5) continue
      let da = Math.atan2(p.z - m.z, p.x - m.x) - a
      da = Math.atan2(Math.sin(da), Math.cos(da))
      if (Math.abs(da) > 0.5 || !g.grid.lineOfSight(m.x, m.z, p.x, p.z)) continue
      if (hurtPlayer(g, p, m.damage * 1.2, 'heat', { name: m.def.name, x: m.x, z: m.z, special: 'Privilege Escalation' }) > 0)
        statusPlayer(g, p, 'burning', 3, m.damage * 0.2)
    }
    return
  }
  if (m.windup?.what === 'sweep') {
    if (now < m.windup.until) return
    m.windup = null
    m.attackReady = now + attackCooldown(m, 0.7)
    for (const p of playersInCircle(g, m.x, m.z, 4.8)) strike(g, m, { x: p.x, z: p.z, r: 0.5, player: p }, 1.4, 'laser', 'Tail Sweep')
    return
  }
  if (!m.windup && now >= m.attackReady) {
    if (dist < 4.8) {
      const dur = windup(g, m, 'sweep', 0.8, m.x, m.z)
      g.emit({ kind: 'tele', shape: 'circle', x: m.x, z: m.z, r: 4.8, dur }, m)
      return
    }
    if (visible && dist < 12) {
      const a = Math.atan2(t.z - m.z, t.x - m.x)
      const dur = windup(g, m, 'breath', m.def.windup, t.x, t.z)
      m.windup!.a = a
      g.emit({ kind: 'tele', shape: 'cone', x: m.x, z: m.z, r: 0.5, a, l: 12, dur, color: '#ff00aa' }, m)
      return
    }
  }
  if (!m.windup && !m.statuses.has('rooted')) walkTo(g, m, visible ? t.x : (m.lastSeen?.x ?? t.x), visible ? t.z : (m.lastSeen?.z ?? t.z), speed, dt)
}

function turret(g: Game, m: Monster, t: TargetInfo, dist: number, visible: boolean) {
  const now = g.time
  faceTowards(m, t.x, t.z)
  if (m.windup?.what === 'aim') {
    if (now < m.windup.until) return
    m.windup = null
    m.attackReady = now + attackCooldown(m)
    if (visible) shoot(g, m, t, 'bolt', m.def.projectile!.speed, 1, 'laser')
    return
  }
  if (visible && dist < m.def.range && now >= m.attackReady) windup(g, m, 'aim', m.def.windup, t.x, t.z)
}

function bossIdle(g: Game, m: Monster) {
  // Nobody in the arena for a while: heal up and go back to the middle.
  if (g.time - m.lastHurt > 8 && m.hp < m.maxHp) {
    m.hp = m.maxHp
    m.contributors.clear()
    m.x = m.home.x
    m.z = m.home.z
    m.phase = 1
    worldstate.resetBoss(g, m)
  }
}

// --- Reactions to damage and death -------------------------------------------------------------------
export function afterHit(g: Game, m: Monster, dmg: number, by: Player | null) {
  const now = g.time
  // Distress beacon: wounded programs may call for help.
  const canCall = !m.boss && !m.def.stationary && m.def.behaviour !== 'bomber' && m.def.behaviour !== 'zeroday' && !m.allyOf
  if (canCall && !m.distressUsed && m.hp < m.maxHp * 0.25 && !m.statuses.has('stunned') && !m.statuses.has('asleep') && !m.statuses.has('frozen')) {
    m.distressUsed = true
    if (g.rand() < 0.3) {
      m.distressUntil = now + 2.5
      m.windup = null
      g.emit({ kind: 'distress', m: m.id, x: m.x, z: m.z, dur: 2.5 }, m)
    }
  }
  // Recursive Worms fork when they take a big hit or drop below half.
  if (m.def.behaviour === 'worm' && !m.splitDone && m.generation < 2 && (m.hp < m.maxHp * 0.5 || dmg >= m.maxHp * 0.3)) {
    m.splitDone = true
    m.dead = true
    g.monsters.delete(m.id)
    g.emit({ kind: 'split', m: m.id, x: m.x, z: m.z }, m)
    for (const side of [-1, 1]) {
      const a = m.yaw + (side * Math.PI) / 2
      const x = m.x - Math.sin(a) * 0.9
      const z = m.z - Math.cos(a) * 0.9
      const child = spawnMonster(g, m.def.key, g.grid.blocked(x, z, 0.4, Mode.Monster) ? m.x : x, g.grid.blocked(x, z, 0.4, Mode.Monster) ? m.z : z, {
        level: m.level,
        sector: m.sector,
        generation: m.generation + 1,
        size: m.size * 0.75,
        elite: null,
        target: m.target,
        pack: m.pack,
        noCorruption: m.noCorruption,
      })
      child.maxHp = Math.max(1, Math.round(m.maxHp * 0.45))
      child.hp = Math.max(1, Math.round(Math.max(m.hp, m.maxHp * 0.2) * 0.6))
      child.contributors = new Map(m.contributors)
      child.lastSeen = m.lastSeen
      child.attackReady = now + 0.6
    }
    void by
  }
}

function finishDistress(g: Game, m: Monster) {
  m.distressUntil = 0
  g.emit({ kind: 'distress', m: m.id, x: m.x, z: m.z, dur: 0, done: true }, m)
  // Reinforcements arrive from somewhere out of sight nearby.
  const spots = openCellsNear(g, m.x, m.z, 3).filter((c) => c.d >= 2)
  const visible = (x: number, z: number) => g.livePlayers().some((p) => Math.hypot(p.x - x, p.z - z) < 30 && g.grid.lineOfSight(p.x, p.z, x, z))
  const spot = spots.find((c) => !visible(c.x, c.z)) ?? spots[spots.length - 1]
  if (!spot) return
  const table = SPAWN_TABLES[m.sector]
  const keys = Object.keys(table).filter((k) => MONSTER_BY_KEY[k].behaviour !== 'swarm')
  const count = 2 + (g.rand() < 0.5 ? 1 : 0)
  const list = new Array(count).fill(0).map(() => pick(g.rand, keys))
  const group = spawnPack(g, m.sector, spot.x, spot.z, { keys: list, target: m.target, elite: null, noCorruption: true })
  for (const o of group) o.lastSeen = m.lastSeen
  g.emit({ kind: 'system', text: `A ${m.def.name} called for reinforcements!`, cls: 'hurt' }, m)
}

export function onDeath(g: Game, m: Monster, killer: Player | null) {
  if (m.def.behaviour === 'bomber') detonate(g, m, killer)
  if (m.def.behaviour === 'tank' && !m.noCorruption) {
    // The Trojan's payload: Byte Mites spill out.
    spawnPack(g, m.sector, m.x, m.z, { keys: ['byte_mite', 'byte_mite', 'byte_mite', 'byte_mite'], noCorruption: true, level: m.level, elite: null, target: killer ? { kind: 'player', id: killer.id } : null })
  }
  if (m.elite === 'recursive') {
    for (let i = 0; i < 2; i++) {
      const c = spawnMonster(g, m.def.key, m.x + (i ? 0.8 : -0.8), m.z, {
        level: m.level,
        sector: m.sector,
        size: 0.8,
        hpMult: 0.35 / ELITE_HP_MULT,
        elite: null,
        noCorruption: true,
        target: killer ? { kind: 'player', id: killer.id } : null,
      })
      if (g.grid.blocked(c.x, c.z, 0.4, Mode.Monster)) c.x = m.x
    }
  }
  for (const o of g.monsters.values()) if (o.target?.kind === 'monster' && o.target.id === m.id) o.target = null
}

