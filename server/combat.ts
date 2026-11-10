// Damage, statuses, deaths and hit detection.
import { WALL_HEIGHT } from '../shared/constants.ts'
import { Mode } from '../shared/grid.ts'
import { monsterCredits, monsterXp, ELITE_XP_MULT, type DamageType } from '../shared/monsters.ts'
import type { StatusId } from '../shared/protocol.ts'
import type { Monster, Player, StatusInst } from './entities.ts'
import type { Game } from './game.ts'
import * as ai from './ai.ts'
import * as progress from './progress.ts'
import * as worldstate from './worldstate.ts'

export const monsterRadius = (m: Monster) => Math.max(0.45, m.def.size * m.size * 0.32)
export const monsterHeight = (m: Monster) => m.def.size * m.size + 0.35

/** Facing angle from (x, z) towards (tx, tz), in the player's yaw convention. */
export const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(x - tx, z - tz)

/** Max mana right now; Memory Leak shrinks it. */
export function maxManaNow(p: Player) {
  return p.statuses.has('memleak') ? Math.round(p.stats.maxMana * 0.7) : p.stats.maxMana
}

// --- Statuses ---------------------------------------------------------------------------------
const HARD_CC: StatusId[] = ['stunned', 'asleep', 'frozen']

/** Applies (or refreshes) a status on a monster, respecting boss resistances. */
export function statusMonster(g: Game, m: Monster, id: StatusId, dur: number, power = 0, by?: string) {
  if (m.dead) return
  let s = id
  let d = dur
  const sturdy = m.boss || m.def.stationary || m.def.behaviour === 'zeroday'
  if (m.boss) {
    if (s === 'asleep' || s === 'frozen') {
      s = 'stunned'
      d = 0.6
    } else if (s === 'stunned') d *= 0.3
    else if (s === 'rooted' || s === 'pulled' || s === 'slowed') d *= 0.4
  }
  if (sturdy && (s === 'pulled' || s === 'rooted')) return
  if (m.def.behaviour === 'node') return
  const cur = m.statuses.get(s)
  if (cur && cur.until > g.time + d && cur.power >= power) return
  m.statuses.set(s, { until: g.time + d, power: Math.max(power, cur?.power ?? 0), by, next: cur?.next ?? g.time + 0.5 })
  if (HARD_CC.includes(s)) {
    m.windup = null
    m.dash = null
    if (m.distressUntil > g.time) {
      m.distressUntil = 0
      g.emit({ kind: 'distress', m: m.id, x: m.x, z: m.z, dur: 0, done: true }, m)
    }
  }
}

export function statusPlayer(g: Game, p: Player, id: StatusId, dur: number, power = 0, extra: Partial<StatusInst> = {}) {
  if (p.dead) return
  const cur = p.statuses.get(id)
  const until = Math.max(cur?.until ?? 0, g.time + dur)
  p.statuses.set(id, { until, power: Math.max(power, id === 'pulled' ? 0 : (cur?.power ?? 0)), next: cur?.next ?? g.time + 0.5, ...extra })
}

// --- Hit detection ----------------------------------------------------------------------------
export interface RayResult {
  hits: { m: Monster; t: number }[]
  wallDist: number
  end: { x: number; y: number; z: number }
  wall: { cx: number; cz: number; face: number } | null
  dir: { dx: number; dy: number; dz: number }
}

/** Casts a 3D ray against walls, floor, ceiling and monster cylinders. */
export function rayMonsters(
  g: Game,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  max: number,
  opts: { radiusMult?: number; pierce?: boolean; hint?: number; forPlayer?: boolean } = {},
): RayResult {
  const len = Math.hypot(dx, dy, dz) || 1
  dx /= len
  dy /= len
  dz /= len
  const horiz = Math.hypot(dx, dz)
  let wallDist = max
  let wall: RayResult['wall'] = null
  if (horiz > 1e-4) {
    const hit = g.grid.rayHit(ox, oz, dx, dz, max * horiz, Mode.Sight)
    wallDist = hit.dist / horiz
    if (hit.cx >= 0) wall = { cx: hit.cx, cz: hit.cz, face: hit.face }
  }
  if (dy < -1e-4 && oy / -dy < wallDist) {
    wallDist = oy / -dy
    wall = null
  }
  if (dy > 1e-4 && (WALL_HEIGHT - oy) / dy < wallDist) {
    wallDist = (WALL_HEIGHT - oy) / dy
    wall = null
  }
  const hits: { m: Monster; t: number }[] = []
  if (horiz > 1e-4) {
    const ux = dx / horiz
    const uz = dz / horiz
    for (const m of g.monsters.values()) {
      if (m.dead || m.ambush || m.submergedUntil > g.time) continue
      if (opts.forPlayer && m.allyOf) continue
      const r = monsterRadius(m) * (opts.radiusMult ?? 1)
      const cx = m.x - ox
      const cz = m.z - oz
      const proj = cx * ux + cz * uz
      if (proj < -r) continue
      const perp2 = cx * cx + cz * cz - proj * proj
      if (perp2 > r * r) continue
      const th = Math.max(0, proj - Math.sqrt(r * r - perp2))
      const t = th / horiz
      if (t > wallDist || t > max) continue
      const lo = m.y - 0.3
      const hi = m.y + monsterHeight(m) + 0.3
      const yIn = oy + dy * t
      const tMid = Math.max(0, proj) / horiz
      const yMid = oy + dy * tMid
      if ((yIn < lo || yIn > hi) && (yMid < lo || yMid > hi)) continue
      hits.push({ m, t })
    }
  }
  hits.sort((a, b) => a.t - b.t)
  if (!hits.length && opts.hint !== undefined) {
    // Forgive a little latency: accept the client's target if it is close to the ray and visible.
    const m = g.monsters.get(opts.hint)
    if (m && !m.dead && !m.ambush && !(opts.forPlayer && m.allyOf)) {
      const cx = m.x - ox
      const cz = m.z - oz
      const proj = horiz > 1e-4 ? (cx * dx + cz * dz) / horiz : 0
      const perp = Math.sqrt(Math.max(0, cx * cx + cz * cz - proj * proj))
      const t = proj / Math.max(horiz, 1e-4)
      if (proj > 0 && perp < monsterRadius(m) + 1.3 && t < max && g.grid.canSee(ox, oz, m.x, m.z, monsterRadius(m))) hits.push({ m, t })
    }
  }
  const used = opts.pierce ? hits : hits.slice(0, 1)
  const endT = opts.pierce || !used.length ? wallDist : used[0].t
  return { hits: used, wallDist, end: { x: ox + dx * endT, y: oy + dy * endT, z: oz + dz * endT }, wall: used.length && !opts.pierce ? null : wall, dir: { dx, dy, dz } }
}

// --- Damage to monsters ----------------------------------------------------------------------
export interface HitOpts {
  type: DamageType
  /** Area damage (Packet Swarms take full damage, Zero-Days cannot dodge). */
  aoe?: boolean
  ignoreShield?: boolean
  ignoreFront?: boolean
  noCrit?: boolean
  forceCrit?: boolean
  tag?: string
  fromX?: number
  fromZ?: number
  /** Allow the attacker's burn chance to proc. */
  burn?: boolean
  /** Stun machines for this long. */
  stunMachines?: number
  /** Kill credit when there is no attacking player (hijacked monsters, explosions). */
  creditTo?: Player | null
}

/** Deals damage to a monster. Returns the damage dealt after all modifiers. */
export function hitMonster(g: Game, m: Monster, attacker: Player | null, raw: number, o: HitOpts): number {
  if (m.dead || m.hp <= 0) return 0
  const now = g.time
  const by = attacker ?? o.creditTo ?? null
  if (m.submergedUntil > now) return 0
  if (m.allyOf && attacker && m.allyOf === attacker.id) return 0
  if (m.def.behaviour === 'mainframe' && worldstate.mainframeShielded(g)) {
    g.emit({ kind: 'hit', m: m.id, dmg: 0, by: by?.id ?? '', type: o.type, tag: 'immune' }, m)
    return 0
  }
  if (m.def.behaviour === 'zeroday' && !o.aoe && g.rand() < 0.5) {
    g.emit({ kind: 'hit', m: m.id, dmg: 0, by: by?.id ?? '', type: o.type, tag: 'evade' }, m)
    m.revealedUntil = Math.max(m.revealedUntil, now + 1.5)
    return 0
  }
  let dmg = raw
  let crit = false
  let tag = o.tag
  const asleep = m.statuses.has('asleep')
  if (attacker && !o.noCrit) {
    if (asleep) {
      crit = true
      dmg *= Math.max(2, attacker.stats.critDamage)
      progress.count(g, attacker, 'sleepcrits')
    } else if (o.forceCrit || g.rand() < attacker.stats.critChance) {
      crit = true
      dmg *= attacker.stats.critDamage
    }
    if (crit) progress.count(g, attacker, 'crits')
  }
  dmg *= m.def.resist[o.type] ?? 1
  if (m.statuses.has('frozen')) {
    if (o.tag === 'shock') {
      dmg *= 2
      tag = 'shatter'
      m.statuses.delete('frozen')
      if (attacker) progress.count(g, attacker, 'shatters')
    } else dmg *= 1.5
  }
  if (attacker && attacker.stats.overkill > 0 && m.hp < m.maxHp * 0.3) dmg *= 1 + attacker.stats.overkill
  if (m.vulnerableUntil > now) dmg *= 1.5
  if (m.def.behaviour === 'cloud' && !o.aoe) dmg *= 0.5
  // Trojan Goliath's shield plate blocks most frontal damage.
  if (m.def.behaviour === 'tank' && !o.ignoreFront && o.fromX !== undefined && o.fromZ !== undefined) {
    const fx = -Math.sin(m.yaw)
    const fz = -Math.cos(m.yaw)
    const ax = o.fromX - m.x
    const az = o.fromZ - m.z
    const d = Math.hypot(ax, az) || 1
    if ((fx * ax + fz * az) / d > 0.5) {
      dmg *= 0.25
      tag = 'blocked'
    }
  }
  // Encrypted elites: shield first. EMP strips it outright.
  if (m.shield > 0 && !o.ignoreShield) {
    if (o.type === 'emp') m.shield = 0
    else {
      const absorbed = Math.min(m.shield, dmg)
      m.shield -= absorbed
      dmg -= absorbed
      if (dmg <= 0) tag = 'shield'
    }
  }
  m.lastHurt = now
  dmg = Math.max(0, Math.round(dmg))
  if (asleep) m.statuses.delete('asleep')
  m.hp -= dmg
  if (by) {
    const c = m.contributors.get(by.id)
    m.contributors.set(by.id, { dmg: (c?.dmg ?? 0) + Math.max(1, dmg), at: now })
    if (!m.allyOf) ai.provoke(g, m, by)
  }
  g.emit({ kind: 'hit', m: m.id, dmg, by: by?.id ?? '', crit, type: o.type, tag }, m)
  if (attacker && dmg > 0) {
    if (attacker.stats.leech > 0) healPlayer(g, attacker, dmg * attacker.stats.leech, true)
    if (o.burn && g.rand() < attacker.stats.burnChance) statusMonster(g, m, 'burning', 3, raw * 0.25 * attacker.stats.burnDamage, attacker.id)
  }
  if (o.stunMachines && m.def.machine) statusMonster(g, m, 'stunned', o.stunMachines)
  if (m.elite === 'leaky' && dmg > 0 && g.rand() < 0.15 && by) progress.dropCredits(g, m.x, m.z, Math.max(1, Math.round(m.level * 2)), by.id)
  if (m.hp <= 0) {
    killMonster(g, m, by)
    return dmg
  }
  ai.afterHit(g, m, dmg, by)
  return dmg
}

/** A monster's kill: rewards, corruption, special death effects. */
export function killMonster(g: Game, m: Monster, killer: Player | null) {
  if (m.dead) return
  m.dead = true
  m.hp = 0
  g.monsters.delete(m.id)
  const now = g.time
  const name = (m.elite ? 'Elite ' : '') + m.def.name
  g.emit(
    { kind: 'kill', m: m.id, key: m.def.key, name, by: killer?.id ?? '', byName: killer?.char.name ?? '', x: m.x, z: m.z, elite: m.elite, boss: m.boss },
    m.boss ? undefined : m,
  )
  const contributors = [...m.contributors.entries()]
    .filter(([id, c]) => now - c.at < 30 && g.players.has(id))
    .map(([id]) => g.players.get(id)!)
  if (killer && !contributors.includes(killer) && g.players.has(killer.id)) contributors.push(killer)
  const eliteMult = m.elite ? ELITE_XP_MULT : 1
  const childMult = m.generation > 0 ? 0.5 : 1
  const xp = Math.round(monsterXp(m.def, m.level) * eliteMult * childMult)
  // Power outages: programs in the dark drop double credits.
  const outage = g.state.event?.kind === 'outage' && g.state.event.sector === m.sector ? 2 : 1
  const credits = Math.round(monsterCredits(m.def, m.level) * eliteMult * childMult * outage * (m.elite === 'leaky' ? 3 : 1))
  for (const p of contributors) {
    progress.addXp(g, p, xp)
    progress.giveCredits(g, p, Math.round(credits * p.stats.creditMult * (0.8 + g.rand() * 0.4)))
    progress.onKill(g, p, m)
    if (p.stats.manaOnKill || p.stats.manaOnKillPct) p.mana = Math.min(maxManaNow(p), p.mana + p.stats.manaOnKill + p.stats.maxMana * p.stats.manaOnKillPct)
    if (p.stats.hpOnKillPct) healPlayer(g, p, p.stats.maxHp * p.stats.hpOnKillPct, true)
    progress.rollMonsterLoot(g, m, p)
  }
  // Worm children are worth a single point each, so a fork does not multiply the purge.
  const corruption = m.generation > 0 ? 1 : m.def.corruption * (m.elite ? 3 : 1)
  if (!m.noCorruption && corruption > 0) worldstate.reduceCorruption(g, m.sector, corruption, contributors)
  ai.onDeath(g, m, killer)
  worldstate.monsterDied(g, m, contributors)
}

// --- Damage to players ------------------------------------------------------------------------
export interface Source {
  name: string
  x: number
  z: number
  key?: string
  special?: string
}

export function hurtPlayer(g: Game, p: Player, raw: number, type: DamageType, src: Source, opts: { unavoidable?: boolean } = {}): number {
  if (p.dead || raw <= 0) return 0
  const now = g.time
  if (now < p.shieldUntil) return 0
  if (now < p.iframesUntil && !opts.unavoidable) {
    g.emit({ kind: 'dodge', p: p.id }, { to: p.id })
    return 0
  }
  let dmg = raw * p.stats.resist[type]
  if (type !== 'pure') dmg *= p.stats.armorFactor
  if (p.statuses.has('shielded')) dmg *= 0.5
  dmg = Math.max(1, Math.round(dmg))
  p.hp -= dmg
  g.emit({ kind: 'hurt', p: p.id, dmg, src: src.name, x: src.x, z: src.z, type, special: src.special }, p)
  if (p.stats.powers.includes('emp_coil') && now - (p.trapHitAt.emp_coil ?? -99) > 8 && g.rand() < 0.2) {
    p.trapHitAt.emp_coil = now
    explode(g, p.x, p.z, 5, p.char.level * 4, 'emp', p, { what: 'emp', stunMachines: 2.5 })
  }
  if (p.hp <= 0) killPlayer(g, p, src.name)
  return dmg
}

export function healPlayer(g: Game, p: Player, amount: number, quiet = false) {
  if (p.dead || amount <= 0) return
  const before = p.hp
  p.hp = Math.min(p.stats.maxHp, p.hp + amount)
  if (!quiet && p.hp - before >= 1) g.emit({ kind: 'heal', p: p.id, amount: Math.round(p.hp - before) }, { to: p.id })
}

export function killPlayer(g: Game, p: Player, killer: string) {
  if (p.dead) return
  p.dead = true
  p.hp = 0
  p.respawnAt = g.time + 4
  p.statuses.clear()
  p.heals = []
  p.leech = null
  p.deaths.push(g.time)
  progress.count(g, p, 'deaths')
  const dumped = Math.floor(p.char.credits / 2)
  // The data dump holds half your credits until you get back to it.
  for (const [id, l] of g.loot) if (l.dump && l.owner === p.id) g.loot.delete(id)
  if (dumped > 0) {
    p.char.credits -= dumped
    const id = g.nextId()
    g.loot.set(id, {
      id,
      owner: p.id,
      ownerName: p.char.name,
      item: null,
      credits: dumped,
      dump: true,
      x: p.x,
      z: p.z,
      expires: g.time + 15 * 60,
      sector: g.grid.sectorAt(p.x, p.z),
    })
    p.charDirty = true
  }
  for (const m of g.monsters.values()) if (m.target?.kind === 'player' && m.target.id === p.id) m.target = null
  g.emit({ kind: 'death', p: p.id, name: p.char.name, killer, dump: dumped })
}

// --- Explosions -------------------------------------------------------------------------------
export function explode(
  g: Game,
  x: number,
  z: number,
  r: number,
  dmg: number,
  type: DamageType,
  owner: Player | null,
  o: { what: string; hurtPlayers?: number; monsterMult?: number; stunMachines?: number; stunAll?: number; color?: string; src?: string; creditTo?: Player | null; reveal?: boolean } = { what: 'bomb' },
) {
  g.emit({ kind: 'explode', x, z, r, what: o.what, color: o.color }, { x, z })
  for (const m of [...g.monsters.values()]) {
    if (m.dead || m.ambush) continue
    const d = Math.hypot(m.x - x, m.z - z)
    if (d > r + monsterRadius(m)) continue
    if (!g.grid.lineOfSight(x, z, m.x, m.z) && d > 1) continue
    if (owner && m.allyOf === owner.id) continue
    const fall = d < r * 0.4 ? 1 : 1 - 0.5 * ((d - r * 0.4) / (r * 0.6))
    if (o.reveal) m.revealedUntil = Math.max(m.revealedUntil, g.time + 5)
    if (dmg > 0) hitMonster(g, m, owner, dmg * (o.monsterMult ?? 1) * Math.max(0.5, fall), { type, aoe: true, fromX: x, fromZ: z, creditTo: o.creditTo, noCrit: !owner })
    if (m.dead) continue
    if (o.stunMachines && m.def.machine) statusMonster(g, m, 'stunned', o.stunMachines)
    else if (o.stunAll) statusMonster(g, m, 'stunned', o.stunAll)
  }
  if (o.hurtPlayers) {
    for (const p of g.players.values()) {
      const d = Math.hypot(p.x - x, p.z - z)
      if (p.dead || d > r || (!g.grid.lineOfSight(x, z, p.x, p.z) && d > 1)) continue
      hurtPlayer(g, p, o.hurtPlayers, type, { name: o.src ?? 'an explosion', x, z })
    }
  }
}

// --- Per-tick player upkeep ----------------------------------------------------------------------
export function updatePlayers(g: Game, dt: number) {
  const now = g.time
  for (const p of g.players.values()) {
    if (p.dead) {
      if (now >= p.respawnAt) respawn(g, p)
      continue
    }
    // Statuses and damage over time.
    for (const [id, s] of p.statuses) {
      if (s.until <= now) {
        p.statuses.delete(id)
        continue
      }
      if ((id === 'burning' || id === 'corrupted') && (s.next ?? 0) <= now) {
        s.next = now + 0.5
        hurtPlayer(g, p, s.power * 0.5, id === 'burning' ? 'heat' : 'pure', { name: id === 'burning' ? 'fire' : 'corruption', x: p.x, z: p.z }, { unavoidable: true })
        if (p.dead) break
      }
    }
    if (p.dead) continue
    // Heals over time.
    if (p.heals.length) {
      let amount = 0
      for (const h of p.heals) amount += h.perSec * Math.min(dt, Math.max(0, h.until - (now - dt)))
      p.heals = p.heals.filter((h) => h.until > now)
      healPlayer(g, p, amount, true)
      if (p.heals.length) statusPlayer(g, p, 'regen', Math.max(...p.heals.map((h) => h.until - now)))
    }
    const hub = g.grid.hubIndexAt(p.x, p.z)
    const maxMana = maxManaNow(p)
    p.mana = Math.min(maxMana, p.mana + p.stats.manaRegen * dt * (hub >= 0 ? 3 : 1))
    if (hub >= 0) p.hp = Math.min(p.stats.maxHp, p.hp + p.stats.maxHp * 0.05 * dt)
    if (hub !== p.hub) {
      p.hub = hub
      if (hub >= 0) worldstate.enterHub(g, p, g.world.hubs[hub].id)
    }
    const sector = g.grid.sectorAt(p.x, p.z)
    if (sector !== p.sector) {
      p.sector = sector
      worldstate.enterSector(g, p, sector)
    }
    // Data Leech channel.
    if (p.leech) {
      const m = g.monsters.get(p.leech.m)
      if (!m || m.dead || now > p.leech.until || Math.hypot(m.x - p.x, m.z - p.z) > 20 || !g.grid.lineOfSight(p.x, p.z, m.x, m.z)) p.leech = null
      else if (now >= p.leech.next) {
        p.leech.next = now + 0.25
        const dealt = hitMonster(g, m, p, p.leech.perTick, { type: 'pure', noCrit: true, tag: 'leech', fromX: p.x, fromZ: p.z, ignoreFront: true })
        healPlayer(g, p, dealt * 0.5, true)
      }
    }
  }
}

export function respawn(g: Game, p: Player) {
  const spawn = g.spawnPoint(p)
  p.dead = false
  p.x = spawn.x
  p.z = spawn.z
  p.hp = p.stats.maxHp
  p.mana = p.stats.maxMana
  p.shieldUntil = g.time + 4
  p.statuses.clear()
  g.send(p, { t: 'teleport', x: p.x, z: p.z, yaw: Math.PI })
  g.emit({ kind: 'respawn', p: p.id, x: p.x, z: p.z })
}

