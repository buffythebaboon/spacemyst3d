// The living world: doors, gates, vaults, secrets, puzzles, traps, events, bosses and seasons.
import { MAX_LEVEL, SECTOR_CORRUPTION, SECTOR_LEVELS, SECTOR_NAMES, cellCenter, clamp, round2, toCell, xpToNext } from '../shared/constants.ts'
import { Mode } from '../shared/grid.ts'
import { WEAPON_TYPES, makeArmor, makeGrenade, makeImplant, makeKeycard, makePotion, makeWeapon, IMPLANT_IDS, POTION_KINDS } from '../shared/items.ts'
import { MONSTER_BY_KEY, SPAWN_TABLES, type MonsterDef } from '../shared/monsters.ts'
import { pick, weighted } from '../shared/rng.ts'
import { DOOR, FAKE, FLOOR, HUB_NAMES, RELAY_NAMES, inRect, traceBeam, type Arena, type Puzzle, type WorldObject, type WorldState } from '../shared/world.ts'
import * as actions from './actions.ts'
import * as ai from './ai.ts'
import { healPlayer, hitMonster, hurtPlayer, statusPlayer, yawTo } from './combat.ts'
import type { Monster, Player } from './entities.ts'
import type { Game } from './game.ts'
import * as progress from './progress.ts'

const DOOR_RANGE = 4.6
const REACH = 4.8
const BOSS_RESPAWN = 600
const TURRET_RESPAWN = 300
const SEASON_COUNTDOWN = 60

/** Per-game bookkeeping that is not part of the broadcast world state. */
interface Extra {
  world: unknown
  turretRespawn: Map<string, number>
  jobs: { at: number; run: () => void }[]
  /** Names of everyone who killed something in each sector this season (for Spotless). */
  purgers: Set<string>[]
  nextEvent: number
  trapCells: Map<number, WorldObject[]>
  monsterTrapHit: Map<string, number>
  mainframe: { nextVolley: number; nextStrike: number; nextSummon: number } | null
}
const extras = new WeakMap<Game, Extra>()

function ex(g: Game): Extra {
  let e = extras.get(g)
  if (!e || e.world !== g.world) {
    const trapCells = new Map<number, WorldObject[]>()
    for (const o of g.world.objects) {
      if (o.kind !== 'laser' && o.kind !== 'electric') continue
      const i = o.z * g.world.width + o.x
      trapCells.set(i, [...(trapCells.get(i) ?? []), o])
    }
    e = {
      world: g.world,
      turretRespawn: new Map(),
      jobs: [],
      purgers: [new Set(), new Set(), new Set(), new Set()],
      nextEvent: 0,
      trapCells,
      monsterTrapHit: new Map(),
      mainframe: null,
    }
    extras.set(g, e)
  }
  return e
}

function later(g: Game, delay: number, run: () => void) {
  ex(g).jobs.push({ at: g.time + delay, run })
}

const theSector = (s: number) => (s === 3 ? SECTOR_NAMES[3] : `the ${SECTOR_NAMES[s]}`)
const bossName = (def: MonsterDef) => (def.name.startsWith('The ') ? def.name : `The ${def.name}`)
const near = (p: Player, cx: number, cz: number, reach = REACH) => Math.hypot(cellCenter(cx) - p.x, cellCenter(cz) - p.z) <= reach

// --- State --------------------------------------------------------------------------------------
export function freshState(g: Game): WorldState {
  const mirrors: Record<string, number> = {}
  for (const o of g.world.objects) if (o.kind === 'mirror') mirrors[o.id] = o.orient ?? 0
  const bosses: WorldState['bosses'] = {}
  for (const a of g.world.arenas) bosses[a.id] = { alive: true }
  return {
    season: g.season,
    gates: [],
    vaults: [],
    fakes: [],
    solved: [],
    relays: {},
    mirrors,
    plates: [],
    corruption: SECTOR_CORRUPTION.map((c) => (c > 0 ? 1 : 0)),
    event: null,
    bosses,
    turretsDown: [],
  }
}

/** A world state saved by an earlier server run. Times restart at zero, so timers are reset. */
export function restoreState(g: Game, saved: WorldState): WorldState {
  const fresh = freshState(g)
  const state: WorldState = { ...fresh, ...saved, event: null, turretsDown: [], plates: [] }
  state.mirrors = { ...fresh.mirrors, ...(saved.mirrors ?? {}) }
  state.bosses = { ...fresh.bosses }
  for (const [id, b] of Object.entries(saved.bosses ?? {})) state.bosses[id] = b.alive ? { alive: true } : { alive: false, respawnAt: 60 }
  if (saved.seasonEndsAt !== undefined) state.seasonEndsAt = SEASON_COUNTDOWN
  return state
}

// --- Doors ----------------------------------------------------------------------------------------
/** Doors slide open when a player, or a monster that is hunting, comes close. */
export function updateDoors(g: Game) {
  const open = g.grid.doorOpen
  open.fill(0)
  const W = g.world.width
  const mark = (x: number, z: number) => {
    const cx = toCell(x)
    const cz = toCell(z)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx
        const nz = cz + dz
        if (!g.grid.inside(nx, nz)) continue
        const i = nz * W + nx
        if (g.world.cells[i] === DOOR && Math.hypot(cellCenter(nx) - x, cellCenter(nz) - z) < DOOR_RANGE) open[i] = 1
      }
  }
  for (const p of g.players.values()) if (!p.dead) mark(p.x, p.z)
  for (const m of g.monsters.values()) if (!m.dead && m.active && !m.ambush && (m.target || m.allyOf)) mark(m.x, m.z)
}

// --- Interaction ----------------------------------------------------------------------------------
const PUZZLE_HINTS: Record<string, string> = {
  relay: 'Sealed: no power. Three relays in this sector must be switched on in the right order. The maintenance log by this door says which.',
  cipher: 'Sealed by a cipher lock. Four glyphs are scrawled on walls around this sector. Enter them at the cipher panel.',
  mirror: "Sealed. The beam in this sector's mirror lab must reach its receiver. Turn the mirrors.",
  plates: 'Sealed. Two pressure plates in this sector must be held down at the same time. Bring a friend, or a decoy.',
}

export function interact(g: Game, p: Player, id: string, arg: number) {
  if (p.dead) return
  const vault = g.vaults.get(id)
  if (vault) return useVault(g, p, vault.id)
  if (id.startsWith('gate:')) return gateInfo(g, p, Number(id.slice(5)))
  const o = g.objects.get(id)
  if (!o) return
  if (!near(p, o.x, o.z)) return g.toast(p, 'Too far away.')
  switch (o.kind) {
    case 'shop':
      return g.send(p, { t: 'shop', hub: o.hub!, stock: progress.shopStock(g, p, o.hub!) })
    case 'board':
      return g.send(p, { t: 'board', hub: o.hub!, offers: progress.boardOffers(g, p, o.hub!) })
    case 'repair':
      return repairStation(g, p, o.hub!)
    case 'beacon':
      return g.send(p, { t: 'beacon', hub: o.hub! })
    case 'chest':
      return progress.openChest(g, p, o)
    case 'fragment':
      return progress.readFragment(g, p, o)
    case 'relay':
      return pressRelay(g, p, o)
    case 'cipher':
      return tryCipher(g, p, o, arg)
    case 'mirror':
      return turnMirror(g, p, o)
    default:
      return
  }
}

function repairStation(g: Game, p: Player, hubId: string) {
  p.hp = p.stats.maxHp
  p.mana = p.stats.maxMana
  for (const s of ['burning', 'slowed', 'rooted', 'corrupted', 'memleak', 'pulled', 'stunned', 'asleep', 'frozen'] as const) p.statuses.delete(s)
  healPlayer(g, p, 0)
  if (p.char.respawnHub !== hubId) {
    p.char.respawnHub = hubId
    p.charDirty = true
  }
  g.emit({ kind: 'heal', p: p.id, amount: 0 }, { to: p.id })
  g.toast(p, `Systems restored. You will respawn at ${HUB_NAMES[hubId] ?? 'this hub'}.`, 'heal')
}

function useVault(g: Game, p: Player, id: string) {
  const v = g.vaults.get(id)!
  if (g.state.vaults.includes(v.id)) return
  if (!near(p, v.x, v.z, REACH + 0.4)) return g.toast(p, 'Too far away.')
  if (v.lock === 'keycard') {
    const slot = p.char.inventory.findIndex((it) => it?.kind === 'keycard' && it.base === String(v.sector))
    if (slot < 0) return g.toast(p, `This vault needs a ${SECTOR_NAMES[v.sector]} keycard. ${bossName(MONSTER_BY_KEY[g.world.arenas[v.sector].boss])} carries one.`)
    p.char.inventory[slot] = null
    p.charDirty = true
    openVault(g, v.id, p)
    return
  }
  const pz = g.puzzles.get(v.puzzle ?? '')
  g.toast(p, pz ? PUZZLE_HINTS[pz.kind] : 'Sealed.')
}

function openVault(g: Game, id: string, by: Player | null) {
  if (g.state.vaults.includes(id)) return
  g.state.vaults.push(id)
  g.markState()
  g.emit({ kind: 'vault', id, byName: by?.char.name ?? '' })
}

function gateInfo(g: Game, p: Player, cell: number) {
  const gate = g.world.gates.find((gt) => gt.cell === cell)
  if (!gate || g.state.gates.includes(cell)) return
  const pct = Math.ceil(g.state.corruption[gate.sector] * 100)
  g.toast(p, `Sector gate sealed. Purge ${theSector(gate.sector)} to open it: ${pct}% corruption left.`)
}

function pressRelay(g: Game, p: Player, o: WorldObject) {
  const pz = g.puzzles.get(o.puzzle ?? '')
  if (!pz || pz.kind !== 'relay') return
  if (g.state.solved.includes(pz.id)) return g.toast(p, 'The relays hum steadily. That vault already has power.')
  const list = [...(g.state.relays[pz.id] ?? [])]
  const c = o.color ?? 0
  if (list.includes(c)) return g.toast(p, `The ${RELAY_NAMES[c]} relay is already online.`)
  list.push(c)
  const order = pz.order ?? [0, 1, 2]
  const x = cellCenter(o.x)
  const z = cellCenter(o.z)
  if (!list.every((v, i) => v === order[i])) {
    g.state.relays[pz.id] = []
    g.markState()
    hurtPlayer(g, p, p.stats.maxHp * 0.1, 'emp', { name: 'a power surge', x, z, special: 'Power Surge' }, { unavoidable: true })
    g.emit({ kind: 'puzzle', id: pz.id, msg: 'Power surge! Wrong order. Every relay in the circuit resets.', ok: false, x, z }, { to: p.id })
    return
  }
  g.state.relays[pz.id] = list
  g.markState()
  if (list.length >= order.length) return solvePuzzle(g, pz, [p])
  g.emit({ kind: 'puzzle', id: pz.id, msg: `${RELAY_NAMES[c]} relay online (${list.length}/${order.length}).`, ok: true, x, z }, { to: p.id })
}

function tryCipher(g: Game, p: Player, o: WorldObject, arg: number) {
  const pz = g.puzzles.get(o.puzzle ?? '')
  if (!pz || pz.kind !== 'cipher' || !pz.code) return
  if (g.state.solved.includes(pz.id)) return g.toast(p, 'The cipher lock is already open.')
  const key = `cipher_${pz.id}`
  if (g.time - (p.trapHitAt[key] ?? -99) < 1) return
  p.trapHitAt[key] = g.time
  const n = Math.floor(arg)
  if (!(n >= 0 && n < 6 ** 4)) return
  const guess = [n % 6, Math.floor(n / 6) % 6, Math.floor(n / 36) % 6, Math.floor(n / 216) % 6]
  if (guess.every((v, i) => v === pz.code![i])) return solvePuzzle(g, pz, [p])
  hurtPlayer(g, p, p.stats.maxHp * 0.05, 'emp', { name: 'a security countermeasure', x: cellCenter(o.x), z: cellCenter(o.z), special: 'Access Denied' }, { unavoidable: true })
  g.emit({ kind: 'puzzle', id: pz.id, msg: 'ACCESS DENIED. Those glyphs are wrong.', ok: false, x: cellCenter(o.x), z: cellCenter(o.z) }, { to: p.id })
}

function mirrorAt(g: Game, pz: Puzzle) {
  const byCell = new Map<number, string>()
  for (const o of g.world.objects) if (o.kind === 'mirror' && o.puzzle === pz.id) byCell.set(o.z * g.world.width + o.x, o.id)
  return (x: number, z: number) => {
    const id = byCell.get(z * g.world.width + x)
    return id === undefined ? undefined : (g.state.mirrors[id] ?? 0)
  }
}

function turnMirror(g: Game, p: Player, o: WorldObject) {
  const pz = g.puzzles.get(o.puzzle ?? '')
  if (!pz || pz.kind !== 'mirror' || !pz.lab) return
  if (g.state.solved.includes(pz.id)) return g.toast(p, 'The beam is locked in place.')
  g.state.mirrors[o.id] = (g.state.mirrors[o.id] ?? o.orient ?? 0) ? 0 : 1
  g.markState()
  if (traceBeam(pz.lab, mirrorAt(g, pz)).solved) solvePuzzle(g, pz, [p])
}

const PUZZLE_NAMES: Record<string, string> = { relay: 'Relay circuit', cipher: 'Cipher lock', mirror: 'Mirror lab', plates: 'Pressure plates' }

export function solvePuzzle(g: Game, pz: Puzzle, solvers: Player[]) {
  if (g.state.solved.includes(pz.id)) return
  g.state.solved.push(pz.id)
  g.markState()
  const v = g.vaults.get(pz.vault)
  openVault(g, pz.vault, solvers[0] ?? null)
  g.emit({
    kind: 'puzzle',
    id: pz.id,
    msg: `${PUZZLE_NAMES[pz.kind]} solved! A vault has opened in ${theSector(pz.sector)}.`,
    ok: true,
    solved: true,
    x: v ? cellCenter(v.x) : undefined,
    z: v ? cellCenter(v.z) : undefined,
  })
  for (const s of solvers) {
    progress.count(g, s, `puzzle_${pz.kind}`)
    progress.questEvent(g, s, 'puzzle', pz.sector)
    progress.addXp(g, s, Math.round(xpToNext(s.char.level) * 0.25))
  }
}

// --- Secrets --------------------------------------------------------------------------------------
/** A player clicked or bumped a wall that may be fake. */
export function touchFake(g: Game, p: Player, cell: number) {
  if (!Number.isInteger(cell) || p.dead) return
  if (g.world.cells[cell] !== FAKE || g.state.fakes.includes(cell)) return
  const { x, z } = g.cellPos(cell)
  if (Math.hypot(x - p.x, z - p.z) > 12) return
  const hit = g.grid.rayHit(p.x, p.z, x - p.x, z - p.z, 14, Mode.Sight)
  if (hit.cx < 0 || hit.cz * g.world.width + hit.cx !== cell) return
  revealFake(g, p, cell)
}

/** A shot or swing hit a wall cell; fake walls give way. */
export function shotWall(g: Game, p: Player, cx: number, cz: number) {
  if (!g.grid.inside(cx, cz)) return
  const cell = cz * g.world.width + cx
  if (g.world.cells[cell] === FAKE && !g.state.fakes.includes(cell)) revealFake(g, p, cell)
}

function revealFake(g: Game, p: Player, cell: number) {
  g.state.fakes.push(cell)
  g.markState()
  g.emit({ kind: 'secret', cell, byName: p.char.name })
  progress.count(g, p, 'secrets')
  progress.questEvent(g, p, 'secret', g.world.sector[cell])
  progress.addXp(g, p, Math.round(xpToNext(p.char.level) * 0.15))
}

// --- Travel and discovery ---------------------------------------------------------------------------
export function travel(g: Game, p: Player, hubId: string) {
  if (p.dead) return
  if (p.hub < 0) return g.toast(p, 'Fast travel works from a hub beacon.')
  const hub = g.world.hubs.find((h) => h.id === hubId)
  if (!hub || !p.char.hubs.includes(hubId)) return g.toast(p, 'You have not found that hub yet.')
  if (g.world.hubs[p.hub]?.id === hubId) return
  const a = g.rand() * Math.PI * 2
  p.x = cellCenter(hub.cx) + Math.cos(a) * 1.5
  p.z = cellCenter(hub.cz) + Math.sin(a) * 1.5
  p.vx = 0
  p.vz = 0
  p.leech = null
  g.send(p, { t: 'teleport', x: p.x, z: p.z })
  g.emit({ kind: 'travel', p: p.id, hub: hubId }, { x: p.x, z: p.z })
}

export function enterHub(g: Game, p: Player, hubId: string) {
  if (p.char.hubs.includes(hubId)) return
  p.char.hubs.push(hubId)
  p.charDirty = true
  g.toast(p, `Hub discovered: ${HUB_NAMES[hubId] ?? hubId}. You can fast travel here from any beacon.`, 'loot')
}

export function enterSector(g: Game, p: Player, sector: number) {
  const [lo, hi] = SECTOR_LEVELS[sector]
  g.emit({ kind: 'sector', sector, msg: `${SECTOR_NAMES[sector]} · monster level ${lo}–${hi}` }, { to: p.id })
}

// --- Corruption and gates ----------------------------------------------------------------------------
export function reduceCorruption(g: Game, sector: number, amount: number, contributors: Player[]) {
  if (sector < 0 || sector > 2 || amount <= 0) return
  const e = ex(g)
  for (const p of contributors) e.purgers[sector].add(p.char.name)
  if (g.corruptionPoints[sector] <= 0) return
  const outbreak = g.state.event?.kind === 'outbreak' && g.state.event.sector === sector ? 2 : 1
  const before = Math.round(g.state.corruption[sector] * 100)
  g.corruptionPoints[sector] = Math.max(0, g.corruptionPoints[sector] - amount * outbreak)
  const frac = g.corruptionPoints[sector] / SECTOR_CORRUPTION[sector]
  g.state.corruption[sector] = Math.round(frac * 1000) / 1000
  if (Math.round(frac * 100) !== before) g.markState()
  if (g.corruptionPoints[sector] === 0) sectorPurged(g, sector)
}

function sectorPurged(g: Game, s: number) {
  for (const gt of g.world.gates) {
    if (gt.sector !== s || g.state.gates.includes(gt.cell)) continue
    g.state.gates.push(gt.cell)
    g.emit({ kind: 'gate', cell: gt.cell, sector: s })
  }
  g.markState()
  g.emit({ kind: 'system', text: `${SECTOR_NAMES[s]} purged! The gates to ${theSector(s + 1)} are open.`, cls: 'big' })
  const e = ex(g)
  for (const p of g.players.values()) {
    if (!e.purgers[s].has(p.char.name)) continue
    progress.giveCredits(g, p, 150 * (s + 1))
    if (!p.deaths.some((t) => g.time - t < 1800)) progress.grant(g, p, 'spotless')
  }
}

// --- Bosses ---------------------------------------------------------------------------------------
const NODE_SPOTS: [number, number][] = [
  [-3, -3],
  [3, -3],
  [-3, 3],
  [3, 3],
]

export function spawnBosses(g: Game) {
  for (const a of g.world.arenas) {
    const st = g.state.bosses[a.id] ?? (g.state.bosses[a.id] = { alive: true })
    if (!st.alive) continue
    if ([...g.monsters.values()].some((m) => m.boss && m.arena === a.id)) continue
    spawnBoss(g, a)
  }
}

function spawnBoss(g: Game, a: Arena) {
  const level = a.sector === 3 ? 18 : SECTOR_LEVELS[a.sector][1] + 1
  const m = ai.spawnMonster(g, a.boss, cellCenter(a.cx), cellCenter(a.cz), { sector: a.sector, boss: true, arena: a.id, level, elite: null })
  m.yaw = 0
  if (a.boss === 'mainframe') ex(g).mainframe = null
  return m
}

/** Called for every monster death. */
export function monsterDied(g: Game, m: Monster, contributors: Player[]) {
  if (m.turretObj) turretDied(g, m)
  if (m.boss && m.arena) bossDied(g, m, contributors)
  if (m.def.behaviour === 'zeroday' || m.def.behaviour === 'dragon') {
    const ev = g.state.event
    if (ev && (ev.kind === 'zeroday' || ev.kind === 'rootkit')) {
      g.state.event = null
      g.markState()
      const names = contributors.map((p) => p.char.name).join(', ') || 'someone'
      g.emit({ kind: 'event', what: `${ev.kind}_end`, sector: ev.sector, msg: `${bossName(m.def)} was deleted by ${names}!`, until: 0 })
    }
  }
}

function bossDied(g: Game, m: Monster, contributors: Player[]) {
  g.state.bosses[m.arena!] = { alive: false, respawnAt: g.time + BOSS_RESPAWN }
  g.markState()
  const names = contributors.map((p) => p.char.name).join(', ') || 'the network'
  if (m.def.behaviour === 'mainframe') return seasonWon(g, m, contributors, names)
  g.emit({ kind: 'boss', key: m.def.key, arena: m.arena!, state: 'dead', msg: `${bossName(m.def)} has been defeated by ${names}!` })
  for (const p of contributors) {
    progress.count(g, p, `boss_${m.def.key}`)
    progress.dropPersonal(g, p, makeKeycard(m.sector), m.x, m.z)
  }
  reduceCorruption(g, m.sector, SECTOR_CORRUPTION[m.sector] * 0.4, contributors)
}

function seasonWon(g: Game, m: Monster, contributors: Player[], names: string) {
  g.state.seasonEndsAt = g.time + SEASON_COUNTDOWN
  g.markState()
  g.emit({ kind: 'boss', key: m.def.key, arena: m.arena!, state: 'dead', msg: `The Mainframe has been defeated by ${names}!` })
  g.emit({
    kind: 'season',
    state: 'won',
    season: g.season,
    at: SEASON_COUNTDOWN,
    msg: `THE MAINFRAME HAS FALLEN! The network reboots in ${SEASON_COUNTDOWN} seconds. A new maze awaits.`,
  })
  for (const p of contributors) progress.count(g, p, 'boss_mainframe')
  for (const p of g.players.values()) {
    progress.count(g, p, 'seasons')
    progress.grant(g, p, 'season')
  }
  // Every program shuts down for the victory lap.
  for (const o of [...g.monsters.values()]) {
    if (o.allyOf) continue
    o.dead = true
    g.monsters.delete(o.id)
  }
}

export function resetBoss(g: Game, m: Monster) {
  if (m.def.behaviour !== 'mainframe') return
  for (const o of [...g.monsters.values()]) {
    if (o === m || o.arena !== m.arena) continue
    o.dead = true
    g.monsters.delete(o.id)
  }
  ex(g).mainframe = null
  m.phase = 1
}

export const mainframeShielded = (g: Game) => {
  for (const m of g.monsters.values()) if (m.def.behaviour === 'node' && !m.dead) return true
  return false
}

function shootAt(g: Game, m: Monster, p: Player, kind: string, speed: number, mult: number) {
  const d = Math.hypot(p.x - m.x, p.z - m.z) || 1
  const lead = (d / speed) * 0.5
  const tx = p.x + p.vx * lead
  const tz = p.z + p.vz * lead
  const a = Math.atan2(tz - m.z, tx - m.x)
  const y = 2.6
  actions.spawnProjectile(g, {
    kind,
    x: m.x + Math.cos(a) * 1.5,
    y,
    z: m.z + Math.sin(a) * 1.5,
    vx: Math.cos(a) * speed,
    vy: ((1.2 - y) / d) * speed,
    vz: Math.sin(a) * speed,
    owner: { kind: 'monster', id: m.id },
    damage: m.damage * mult,
    dtype: 'emp',
    radius: 0,
    gravity: 0,
    ttl: 4,
    hitRadius: 0.55,
    data: {},
  })
}

function enterPhase(g: Game, m: Monster, phase: number) {
  m.phase = phase
  for (const [ox, oz] of NODE_SPOTS) {
    const x = m.home.x + ox * 4
    const z = m.home.z + oz * 4
    const node = ai.spawnMonster(g, 'mainframe_node', x, z, { sector: m.sector, level: m.level, arena: m.arena, noCorruption: true, elite: null })
    node.yaw = yawTo(x, z, m.x, m.z)
  }
  const msg =
    phase === 2
      ? 'The Mainframe raises its firewall! Destroy the four power nodes to break it.'
      : 'The Mainframe overclocks! Its power nodes are back online.'
  g.emit({ kind: 'boss', key: m.def.key, arena: m.arena ?? '', state: 'phase', phase, msg })
}

/** The final boss: volleys, Kernel Strikes, shield nodes and summons. */
export function mainframeAct(g: Game, m: Monster, _dt: number) {
  const e = ex(g)
  const now = g.time
  const mf = e.mainframe ?? (e.mainframe = { nextVolley: now + 2, nextStrike: now + 4, nextSummon: now + 18 })
  const arena = g.world.arenas.find((a) => a.id === m.arena)
  if (!arena) return
  const targets = g.livePlayers().filter((p) => inRect(arena, toCell(p.x), toCell(p.z)) && now >= p.shieldUntil && !p.statuses.has('stealth'))
  if (!targets.length) return
  const frac = m.hp / m.maxHp
  if (m.phase <= 1 && frac < 0.66) enterPhase(g, m, 2)
  else if (m.phase === 2 && frac < 0.33) enterPhase(g, m, 3)
  let nearest = targets[0]
  for (const p of targets) if (Math.hypot(p.x - m.x, p.z - m.z) < Math.hypot(nearest.x - m.x, nearest.z - m.z)) nearest = p
  m.yaw = yawTo(m.x, m.z, nearest.x, nearest.z)
  if (now >= mf.nextVolley) {
    mf.nextVolley = now + (m.phase === 3 ? 1.6 : 2.4)
    g.emit({ kind: 'windup', m: m.id, what: 'volley', dur: 0.3 }, m)
    for (const p of targets.slice(0, 4)) if (g.grid.lineOfSight(m.x, m.z, p.x, p.z)) shootAt(g, m, p, 'admin', 16, 1)
  }
  if (now >= mf.nextStrike) {
    mf.nextStrike = now + (m.phase === 3 ? 3.5 : 5)
    const p = pick(g.rand, targets)
    const x = p.x
    const z = p.z
    const r = 3
    g.emit({ kind: 'tele', shape: 'circle', x: round2(x), z: round2(z), r, dur: 1.6, color: '#ffe9a8' }, m)
    later(g, 1.6, () => {
      if (m.dead) return
      g.emit({ kind: 'explode', x: round2(x), z: round2(z), r, what: 'strike', color: '#ffe9a8' }, { x, z })
      for (const pl of g.livePlayers())
        if (Math.hypot(pl.x - x, pl.z - z) <= r + 0.3) hurtPlayer(g, pl, m.damage * 1.6, 'heat', { name: m.def.name, x, z, special: 'Kernel Strike' })
      actions.addZone(g, { kind: 'crater', x, z, r, dur: 6, ownerMonster: m.id, power: m.damage * 0.35 })
    })
  }
  if (m.phase >= 2 && now >= mf.nextSummon) {
    mf.nextSummon = now + 20
    const table = SPAWN_TABLES[3]
    const keys = [0, 1, 2].map(() => weighted(g.rand, Object.keys(table), (k) => table[k]))
    const [ox, oz] = pick(g.rand, NODE_SPOTS)
    ai.spawnPack(g, 3, m.home.x + ox * 2, m.home.z + oz * 2, {
      keys,
      arena: m.arena,
      noCorruption: true,
      level: m.level - 3,
      elite: null,
      target: { kind: 'player', id: nearest.id },
    })
  }
}

function turretDied(g: Game, m: Monster) {
  const id = m.turretObj!
  if (!g.state.turretsDown.includes(id)) g.state.turretsDown.push(id)
  ex(g).turretRespawn.set(id, g.time + TURRET_RESPAWN)
  g.markState()
}

// --- Per-tick world update -----------------------------------------------------------------------------
export function update(g: Game, _dt: number) {
  const e = ex(g)
  const now = g.time
  for (let i = e.jobs.length - 1; i >= 0; i--) {
    if (e.jobs[i].at > now) continue
    const job = e.jobs.splice(i, 1)[0]
    job.run()
  }
  traps(g)
  plates(g)
  events(g)
  respawns(g)
  if (g.state.seasonEndsAt !== undefined && now >= g.state.seasonEndsAt) g.resetSeason()
}

/** Is a point inside a trap's danger area right now? */
function trapLive(g: Game, o: WorldObject, x: number, z: number) {
  const t = (((g.time + (o.phase ?? 0)) % 4) + 4) % 4
  if (o.kind === 'laser') {
    if (t >= 2) return false
    // The beams form a curtain across the middle of the passage.
    return o.dir === 0 ? Math.abs(z - cellCenter(o.z)) < 0.9 : Math.abs(x - cellCenter(o.x)) < 0.9
  }
  return t >= 2.5
}

function traps(g: Game) {
  const e = ex(g)
  const now = g.time
  for (const p of g.players.values()) {
    if (p.dead || p.hub >= 0) continue
    const list = e.trapCells.get(g.cellOf(p.x, p.z))
    if (!list) continue
    for (const o of list) {
      if (!trapLive(g, o, p.x, p.z)) continue
      const gap = o.kind === 'laser' ? 0.6 : 0.5
      if (now - (p.trapHitAt[o.id] ?? -99) < gap) continue
      p.trapHitAt[o.id] = now
      const src = { name: o.kind === 'laser' ? 'a laser grid' : 'an electrified floor', x: cellCenter(o.x), z: cellCenter(o.z), special: o.kind === 'laser' ? 'Laser Grid' : 'Electric Floor' }
      if (o.kind === 'laser') hurtPlayer(g, p, p.stats.maxHp * 0.12, 'laser', src)
      else {
        if (hurtPlayer(g, p, p.stats.maxHp * 0.08, 'emp', src) > 0) statusPlayer(g, p, 'slowed', 1)
      }
    }
  }
  // Monsters chasing someone get caught too, so luring them through a trap works.
  for (const m of g.monsters.values()) {
    if (m.dead || !m.active || !m.target || m.boss || m.def.noclip || m.def.stationary) continue
    const list = e.trapCells.get(g.cellOf(m.x, m.z))
    if (!list) continue
    for (const o of list) {
      if (!trapLive(g, o, m.x, m.z)) continue
      const key = `${m.id}:${o.id}`
      if (now - (e.monsterTrapHit.get(key) ?? -99) < 0.6) continue
      e.monsterTrapHit.set(key, now)
      hitMonster(g, m, null, m.maxHp * (o.kind === 'laser' ? 0.12 : 0.08), { type: o.kind === 'laser' ? 'laser' : 'emp', noCrit: true, aoe: true, tag: 'trap' })
      if (m.dead) break
    }
  }
  if (e.monsterTrapHit.size > 2000) e.monsterTrapHit.clear()
}

function plates(g: Game) {
  const pressed: string[] = []
  const live = g.livePlayers()
  for (const pz of g.world.puzzles) {
    if (pz.kind !== 'plates' || g.state.solved.includes(pz.id)) continue
    const objs = g.world.objects.filter((o) => o.kind === 'plate' && o.puzzle === pz.id)
    const on = (o: WorldObject) => {
      const x = cellCenter(o.x)
      const z = cellCenter(o.z)
      return live.some((p) => Math.hypot(p.x - x, p.z - z) < 1.3) || [...g.zones.values()].some((zn) => zn.kind === 'honeypot' && Math.hypot(zn.x - x, zn.z - z) < 1.3)
    }
    const down = objs.filter(on)
    for (const o of down) pressed.push(o.id)
    if (objs.length >= 2 && down.length === objs.length) {
      const solvers = live.filter((p) => objs.some((o) => Math.hypot(p.x - cellCenter(o.x), p.z - cellCenter(o.z)) < 1.3))
      solvePuzzle(g, pz, solvers)
    }
  }
  if (pressed.join() !== g.state.plates.join()) {
    g.state.plates = pressed
    g.markState()
  }
}

// --- Random events -------------------------------------------------------------------------------------
type EventKind = 'outage' | 'outbreak' | 'zeroday' | 'rootkit'
const EVENT_WEIGHTS: Record<EventKind, number> = { outage: 35, outbreak: 35, zeroday: 18, rootkit: 12 }
const EVENT_END: Record<EventKind, string> = {
  outage: 'Power is back on.',
  outbreak: 'The outbreak is contained.',
  zeroday: 'The Zero-Day Exploit vanished back into the network.',
  rootkit: 'The Rootkit Dragon burrowed away.',
}

function events(g: Game) {
  const e = ex(g)
  const now = g.time
  const ev = g.state.event
  if (ev && now >= ev.until) {
    g.state.event = null
    g.markState()
    g.emit({ kind: 'event', what: `${ev.kind}_end`, sector: ev.sector, msg: EVENT_END[ev.kind as EventKind] ?? 'The event is over.', until: 0 })
  }
  if (!g.players.size || g.state.seasonEndsAt !== undefined) return
  if (e.nextEvent === 0) e.nextEvent = now + 240 + g.rand() * 180
  if (now < e.nextEvent || g.state.event) return
  e.nextEvent = now + 240 + g.rand() * 180
  startEvent(g, weighted(g.rand, Object.keys(EVENT_WEIGHTS) as EventKind[], (k) => EVENT_WEIGHTS[k]))
}

/** A floor cell in a sector some distance from a point, out of the way of hubs and arenas. */
function spotNear(g: Game, x: number, z: number, sector: number, minD: number, maxD: number) {
  const W = g.world.width
  for (let tries = 0; tries < 200; tries++) {
    const a = g.rand() * Math.PI * 2
    const d = minD + g.rand() * (maxD - minD)
    const cx = toCell(x + Math.cos(a) * d)
    const cz = toCell(z + Math.sin(a) * d)
    if (!g.grid.inside(cx, cz)) continue
    const i = cz * W + cx
    if (g.world.cells[i] !== FLOOR || g.grid.hubAt[i] || g.grid.arenaAt[i] || g.world.sector[i] !== sector) continue
    if (g.world.vaults.some((v) => inRect(v, cx, cz)) || g.world.fakes.some((f) => inRect(f, cx, cz))) continue
    return { x: cellCenter(cx), z: cellCenter(cz) }
  }
  return null
}

export function startEvent(g: Game, kind: EventKind, forceSector?: number) {
  const out = g.livePlayers().filter((p) => p.hub < 0)
  const anchor = out.length ? pick(g.rand, out) : g.livePlayers()[0]
  if (!anchor) return
  const sector = forceSector ?? anchor.sector
  const name = theSector(sector)
  const now = g.time
  let dur = 60
  let msg = ''
  if (kind === 'outage') {
    dur = 60
    msg = `POWER OUTAGE in ${name}! The lights are out for a minute, and programs there drop double credits.`
  } else if (kind === 'outbreak') {
    dur = 90
    msg = `OUTBREAK in ${name}! Programs are pouring in, and every kill there purges twice the corruption.`
  } else {
    const key = kind === 'zeroday' ? 'zero_day' : 'rootkit_dragon'
    dur = kind === 'zeroday' ? 120 : 180
    const spot = spotNear(g, anchor.x, anchor.z, sector, 18, 40) ?? spotNear(g, anchor.x, anchor.z, sector, 6, 60)
    if (!spot) return
    const level = clamp(SECTOR_LEVELS[sector][1] + (kind === 'rootkit' ? 2 : 1), 1, MAX_LEVEL)
    ai.spawnMonster(g, key, spot.x, spot.z, { sector, level, elite: null, despawnAt: now + dur, hpMult: kind === 'rootkit' ? 3 : 1, noCorruption: true })
    msg =
      kind === 'zeroday'
        ? `A ZERO-DAY EXPLOIT has appeared in ${name}! It dodges most shots and one hit can take most of your HP. Area damage never misses.`
        : `A ROOTKIT DRAGON has broken into ${name}! Bring friends.`
  }
  g.state.event = { kind, sector, until: now + dur }
  g.markState()
  g.emit({ kind: 'event', what: kind, sector, msg, until: dur })
}

function respawns(g: Game) {
  const now = g.time
  const e = ex(g)
  for (const a of g.world.arenas) {
    if (a.boss === 'mainframe') continue
    const st = g.state.bosses[a.id]
    if (!st || st.alive || st.respawnAt === undefined || now < st.respawnAt) continue
    g.state.bosses[a.id] = { alive: true }
    spawnBoss(g, a)
    g.markState()
    g.emit({ kind: 'boss', key: a.boss, arena: a.id, state: 'spawn', msg: `${bossName(MONSTER_BY_KEY[a.boss])} has rebooted in ${theSector(a.sector)}.` })
  }
  for (const [id, at] of e.turretRespawn) {
    if (now < at) continue
    e.turretRespawn.delete(id)
    g.state.turretsDown = g.state.turretsDown.filter((t) => t !== id)
    ai.spawnTurret(g, id)
    g.markState()
  }
}

// --- Developer commands (DEV_COMMANDS=1) ----------------------------------------------------------------
export function devCommand(g: Game, p: Player, text: string) {
  const [cmd, ...args] = text.slice(1).trim().split(/\s+/)
  const say = (t: string) => g.toast(p, t)
  switch (cmd) {
    case 'purge': {
      const s = args[0] !== undefined ? Number(args[0]) : p.sector
      reduceCorruption(g, s, 1e6, [p])
      return say(`Purged sector ${s}.`)
    }
    case 'level': {
      const before = p.char.level
      p.char.level = clamp(Math.floor(Number(args[0]) || 1), 1, MAX_LEVEL)
      p.char.xp = 0
      progress.levelChanged(g, p, before)
      return
    }
    case 'credits':
      p.char.credits += Math.floor(Number(args[0]) || 1000)
      p.charDirty = true
      return
    case 'heal':
      p.hp = p.stats.maxHp
      p.mana = p.stats.maxMana
      return
    case 'tp': {
      const where = args[0] ?? ''
      let x = Number(args[0])
      let z = Number(args[1])
      const hub = g.world.hubs.find((h) => h.id === where)
      const arena = g.world.arenas.find((a) => a.id === where)
      const obj = g.objects.get(where) ?? g.vaults.get(where)
      if (hub || arena) {
        const r = (hub ?? arena)!
        x = cellCenter(r.cx)
        z = cellCenter(r.z1)
      } else if (obj) {
        x = cellCenter(obj.x)
        z = cellCenter(obj.z)
      } else if (!Number.isFinite(x) || !Number.isFinite(z)) return say('Usage: /tp hub1 | arena0 | <object id> | <x> <z>')
      p.x = x
      p.z = z
      g.send(p, { t: 'teleport', x, z })
      return
    }
    case 'spawn': {
      const key = args[0]
      if (!MONSTER_BY_KEY[key]) return say(`Unknown monster. Try one of: ${Object.keys(MONSTER_BY_KEY).join(', ')}`)
      const n = clamp(Number(args[1]) || 1, 1, 10)
      const fx = -Math.sin(p.yaw)
      const fz = -Math.cos(p.yaw)
      for (let i = 0; i < n; i++) ai.spawnMonster(g, key, p.x + fx * 5 + (i % 3) - 1, p.z + fz * 5 + Math.floor(i / 3), { elite: (args[2] as never) ?? null })
      return
    }
    case 'event':
      return startEvent(g, (args[0] as EventKind) in EVENT_WEIGHTS ? (args[0] as EventKind) : 'outage')
    case 'season':
      g.state.seasonEndsAt = g.time + 5
      g.markState()
      return
    case 'boss':
      for (const a of g.world.arenas) {
        const st = g.state.bosses[a.id]
        if (st && !st.alive) st.respawnAt = g.time
      }
      return
    case 'give': {
      const lvl = p.char.level
      const what = args[0] ?? 'gear'
      const rand = g.rand
      const items =
        what === 'potions'
          ? POTION_KINDS.map((k) => makePotion(k, 3))
          : what === 'grenades'
            ? ['emp', 'glitch', 'noise'].map((k) => makeGrenade(k, 3))
            : what === 'keycards'
              ? [0, 1, 2].map((s) => makeKeycard(s))
              : what === 'implants'
                ? IMPLANT_IDS.slice(0, 6).map((k) => makeImplant(k))
                : [...WEAPON_TYPES.map((t) => makeWeapon(rand, t, lvl, 3)), makeArmor(rand, lvl, 3)]
      for (const it of items) progress.dropPersonal(g, p, it, p.x, p.z)
      return
    }
    default:
      return say('Dev commands: /purge [sector], /level n, /credits n, /heal, /tp <where>, /spawn <key> [n] [elite], /event <kind>, /season, /boss, /give gear|potions|grenades|keycards|implants')
  }
}
