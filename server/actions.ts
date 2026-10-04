// Player actions (weapons, spells, potions, grenades) plus projectiles and ground zones.
import { activeWeapon, findStack } from '../shared/character.ts'
import { EYE_HEIGHT, PLAYER_RADIUS, POTION_COOLDOWN, WALL_HEIGHT, clamp, round2 } from '../shared/constants.ts'
import { Mode } from '../shared/grid.ts'
import {
  GRENADES,
  GRENADE_FUSE,
  POTIONS,
  POTION_COLORS,
  WEAPONS,
  makeWeapon,
  potionName,
  weaponDamage,
  type Item,
  type WeaponType,
} from '../shared/items.ts'
import type { DamageType } from '../shared/monsters.ts'
import type { Aim, ClientMsg, ZoneKind } from '../shared/protocol.ts'
import { SPELL_BY_ID, knownSpells, spellBase } from '../shared/spells.ts'
import { distToSegment } from './ai.ts'
import {
  explode,
  healPlayer,
  hitMonster,
  hurtPlayer,
  maxManaNow,
  monsterHeight,
  monsterRadius,
  rayMonsters,
  statusMonster,
  statusPlayer,
} from './combat.ts'
import type { Monster, Player, Projectile, TargetRef, Zone } from './entities.ts'
import type { Game } from './game.ts'
import * as progress from './progress.ts'
import * as worldstate from './worldstate.ts'

interface Dir3 {
  dx: number
  dy: number
  dz: number
  target?: number
}

/** Used when nothing is equipped, so nobody is ever left unable to shoot. */
const POCKET_LASER: Item = { ...makeWeapon(() => 0.5, 'laser', 1, 0, 'pocket'), name: 'Pocket Laser' }

function aimOf(msg: Partial<Aim>): Dir3 | null {
  const dx = Number(msg.dx)
  const dy = Number(msg.dy)
  const dz = Number(msg.dz)
  if (![dx, dy, dz].every(Number.isFinite)) return null
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return null
  const target = Number.isInteger(msg.target) ? msg.target : undefined
  return { dx: dx / len, dy: dy / len, dz: dz / len, target }
}

/** Where the player is looking, from yaw and pitch. */
function forward(p: Player): Dir3 {
  const c = Math.cos(p.pitch)
  return { dx: -Math.sin(p.yaw) * c, dy: Math.sin(p.pitch), dz: -Math.cos(p.yaw) * c }
}

/** Horizontal unit direction of an aim, falling back to the facing when looking straight up or down. */
function flat(p: Player, aim: Dir3) {
  const l = Math.hypot(aim.dx, aim.dz)
  if (l > 0.2) return { fx: aim.dx / l, fz: aim.dz / l }
  return { fx: -Math.sin(p.yaw), fz: -Math.cos(p.yaw) }
}

const eye = (p: Player) => ({ x: p.x, y: EYE_HEIGHT - 0.15, z: p.z })

/** Attacking ends Encryption and the spawn shield. */
function breakStealth(g: Game, p: Player) {
  if (p.statuses.delete('stealth')) g.emit({ kind: 'status', p: p.id, s: 'unstealth' }, { to: p.id })
  p.shieldUntil = Math.min(p.shieldUntil, g.time)
}

function fireRate(p: Player) {
  let r = p.stats.fireRate
  if (p.statuses.has('haste')) r *= 1.3
  if (p.stats.powers.includes('adrenal') && p.hp < p.stats.maxHp * 0.3) r *= 1.25
  return r
}

function emitShot(g: Game, p: Player, w: string, o: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }, extra: { charge?: number; pts?: [number, number, number][]; crit?: boolean } = {}) {
  g.emit(
    { kind: 'shot', by: p.id, w, x: round2(o.x), y: round2(o.y), z: round2(o.z), tx: round2(end.x), ty: round2(end.y), tz: round2(end.z), ...extra },
    { x: p.x, z: p.z },
  )
}

/** Hostile monsters a player's attack can touch. */
const hostile = (g: Game, m: Monster) => !m.dead && !m.ambush && !m.allyOf && m.submergedUntil <= g.time

// --- Weapons -------------------------------------------------------------------------------------
export function fire(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'fire' }>) {
  if (p.dead) return
  const aim = aimOf(msg)
  if (!aim) return
  const now = g.time
  const item = activeWeapon(p.char) ?? POCKET_LASER
  const def = WEAPONS[item.base as WeaponType] ?? WEAPONS.laser
  const interval = def.interval / fireRate(p)
  let charge = 0
  if (def.mode === 'charge') {
    // The charge counts towards the time between shots, so it cannot be skipped.
    charge = clamp(Number(msg.charge) || 0, 0, def.charge ?? 0)
    if (now - p.lastShot < interval + charge - 0.12) return
    p.fireReady = now + interval
  } else {
    // One shot of slack absorbs network jitter without raising the long-run fire rate.
    const slack = Math.min(0.1, interval * 0.5)
    if (now < p.fireReady - slack) return
    p.fireReady = Math.max(now, p.fireReady) + interval
  }
  p.lastShot = now
  breakStealth(g, p)
  const dmg = weaponDamage(item) * p.stats.damage
  const o = eye(p)
  switch (def.mode) {
    case 'hitscan':
    case 'beam': {
      const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, def.range, { hint: aim.target, forPlayer: true })
      let end = res.end
      const pts: [number, number, number][] = []
      if (res.hits.length) hitMonster(g, res.hits[0].m, p, dmg, { type: def.dtype, burn: true, fromX: p.x, fromZ: p.z })
      else if (res.wall) {
        worldstate.shotWall(g, p, res.wall.cx, res.wall.cz)
        if (def.mode === 'hitscan' && p.stats.powers.includes('ricochet') && res.wallDist < def.range - 1) {
          // Ricochet Driver: bounce off the wall once.
          const d = { ...res.dir }
          if (res.wall.face === 0) d.dx = -d.dx
          else d.dz = -d.dz
          const bx = res.end.x - res.dir.dx * 0.05
          const bz = res.end.z - res.dir.dz * 0.05
          const r2 = rayMonsters(g, bx, res.end.y, bz, d.dx, d.dy, d.dz, def.range - res.wallDist, { forPlayer: true })
          pts.push([round2(res.end.x), round2(res.end.y), round2(res.end.z)])
          if (r2.hits.length) hitMonster(g, r2.hits[0].m, p, dmg * 0.8, { type: def.dtype, burn: true, fromX: bx, fromZ: bz, tag: 'ricochet' })
          end = r2.end
        }
      }
      emitShot(g, p, item.base, o, end, pts.length ? { pts } : {})
      return
    }
    case 'melee': {
      const { fx, fz } = flat(p, aim)
      const cosArc = Math.cos(def.arc ?? 0.7)
      let hits = 0
      for (const m of [...g.monsters.values()]) {
        if (!hostile(g, m)) continue
        const dx = m.x - p.x
        const dz = m.z - p.z
        const d = Math.hypot(dx, dz)
        if (d > def.range + monsterRadius(m)) continue
        if (d > 0.4 && (dx * fx + dz * fz) / d < cosArc) continue
        if (!g.grid.canSee(p.x, p.z, m.x, m.z, monsterRadius(m))) continue
        hitMonster(g, m, p, dmg, { type: def.dtype, burn: true, fromX: p.x, fromZ: p.z })
        hits++
      }
      if (!hits) {
        const w = g.grid.rayHit(p.x, p.z, fx, fz, def.range, Mode.Sight)
        if (w.cx >= 0) worldstate.shotWall(g, p, w.cx, w.cz)
      }
      emitShot(g, p, item.base, o, { x: p.x + fx * def.range, y: o.y - 0.3, z: p.z + fz * def.range })
      return
    }
    case 'charge': {
      const frac = def.charge ? charge / def.charge : 1
      const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, def.range, { hint: aim.target, forPlayer: true, pierce: true })
      const full = frac >= 0.95
      for (const h of res.hits) hitMonster(g, h.m, p, dmg * (0.35 + 0.65 * frac), { type: def.dtype, burn: true, fromX: p.x, fromZ: p.z, ignoreFront: full, tag: full ? 'rail' : undefined })
      if (res.wall) worldstate.shotWall(g, p, res.wall.cx, res.wall.cz)
      emitShot(g, p, item.base, o, res.end, { charge: round2(frac) })
      return
    }
    case 'projectile': {
      const speed = def.speed ?? 20
      spawnProjectile(g, {
        kind: item.base,
        x: o.x + aim.dx * 0.7,
        y: o.y - 0.2 + aim.dy * 0.7,
        z: o.z + aim.dz * 0.7,
        vx: aim.dx * speed,
        vy: aim.dy * speed,
        vz: aim.dz * speed,
        owner: { kind: 'player', id: p.id },
        damage: dmg,
        dtype: def.dtype,
        radius: def.radius ?? 2,
        gravity: 0,
        ttl: def.range / speed,
        hitRadius: item.base === 'horizon' ? 0.6 : 0.35,
        data: {},
      })
      emitShot(g, p, item.base, o, { x: o.x + aim.dx * 2, y: o.y + aim.dy * 2, z: o.z + aim.dz * 2 })
      return
    }
  }
}

// --- Spells --------------------------------------------------------------------------------------
type CastResult = false | { tx?: number; tz?: number }
interface SpellCtx {
  sp: number
  ext: number
}

function noTarget(g: Game, p: Player, text = 'No target there.'): CastResult {
  g.toast(p, text)
  return false
}

const SPELL_FX: Record<string, (g: Game, p: Player, aim: Dir3, c: SpellCtx) => CastResult> = {
  overload(g, p, aim) {
    const item = activeWeapon(p.char) ?? POCKET_LASER
    const def = WEAPONS[item.base as WeaponType] ?? WEAPONS.laser
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 50, { hint: aim.target, forPlayer: true, radiusMult: 1.2 })
    if (res.hits.length)
      hitMonster(g, res.hits[0].m, p, weaponDamage(item) * p.stats.damage * 2.5, {
        type: def.dtype,
        ignoreShield: true,
        ignoreFront: true,
        fromX: p.x,
        fromZ: p.z,
        tag: 'overload',
      })
    else if (res.wall) worldstate.shotWall(g, p, res.wall.cx, res.wall.cz)
    emitShot(g, p, 'overload', o, res.end)
    return { tx: res.end.x, tz: res.end.z }
  },

  repair(g, p, _aim, c) {
    const dur = 2
    const mend = (who: Player, share: number) => {
      who.heals.push({ perSec: (who.stats.maxHp * 0.35 * p.stats.spellPower * share) / dur, until: g.time + dur })
      statusPlayer(g, who, 'regen', dur)
    }
    mend(p, 1)
    for (const o of g.livePlayers()) if (o !== p && Math.hypot(o.x - p.x, o.z - p.z) <= 6 * c.ext) mend(o, 0.5)
    return {}
  },

  glitch_step(g, p, aim, c) {
    if (p.statuses.has('rooted')) return noTarget(g, p, 'You are rooted in place.')
    const { fx, fz } = flat(p, aim)
    const r = PLAYER_RADIUS * 0.8
    const reach = g.grid.ray(p.x, p.z, fx, fz, 8, Mode.Player) - r - 0.05
    let x = p.x
    let z = p.z
    for (let d = Math.min(8, reach); d > 0.75; d -= 0.25) {
      const nx = p.x + fx * d
      const nz = p.z + fz * d
      if (!g.grid.blocked(nx, nz, r, Mode.Player)) {
        x = nx
        z = nz
        break
      }
    }
    if (x === p.x && z === p.z) return noTarget(g, p, 'No room to glitch there.')
    if (p.stats.powers.includes('mine')) addZone(g, { kind: 'mine', x: p.x, z: p.z, r: 1.6, dur: 12, owner: p.id, power: c.sp * 2.5 })
    g.emit({ kind: 'blink', who: p.id, x: round2(p.x), z: round2(p.z), tx: round2(x), tz: round2(z) }, p)
    p.x = x
    p.z = z
    p.vx = 0
    p.vz = 0
    p.iframesUntil = Math.max(p.iframesUntil, g.time + 0.2)
    g.send(p, { t: 'teleport', x, z })
    return { tx: x, tz: z }
  },

  system_shock(g, p, aim, c) {
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 26, { hint: aim.target, forPlayer: true, radiusMult: 1.6 })
    const pts: [number, number][] = [[round2(p.x), round2(p.z)]]
    if (!res.hits.length) {
      pts.push([round2(res.end.x), round2(res.end.z)])
      g.emit({ kind: 'chain', pts, color: '#5cf2ff' }, p)
      return { tx: res.end.x, tz: res.end.z }
    }
    const dmg = c.sp * 2.2 * p.stats.chainDamage
    const done = new Set<number>()
    let cur: Monster | null = res.hits[0].m
    for (let i = 0; i < 4 + p.stats.chainBonus && cur; i++) {
      done.add(cur.id)
      pts.push([round2(cur.x), round2(cur.z)])
      const cx = cur.x
      const cz = cur.z
      hitMonster(g, cur, p, dmg * (i === 0 ? 1 : 0.85), { type: 'pure', tag: 'shock', ignoreFront: true, fromX: p.x, fromZ: p.z })
      let next: Monster | null = null
      let best = 7 * c.ext
      for (const m of g.monsters.values()) {
        if (!hostile(g, m) || done.has(m.id)) continue
        const d = Math.hypot(m.x - cx, m.z - cz)
        if (d < best && g.grid.lineOfSight(cx, cz, m.x, m.z)) {
          best = d
          next = m
        }
      }
      cur = next
    }
    g.emit({ kind: 'chain', pts, color: '#5cf2ff' }, p)
    return { tx: pts[1][0], tz: pts[1][1] }
  },

  lullaby(g, p, aim, c) {
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 30, { hint: aim.target, forPlayer: true, radiusMult: 1.5 })
    const m = res.hits[0]?.m
    if (!m) return noTarget(g, p)
    statusMonster(g, m, 'asleep', 8 * c.ext, 0, p.id)
    emitShot(g, p, 'lullaby', o, res.end)
    g.emit({ kind: 'status', m: m.id, s: m.statuses.has('asleep') ? 'asleep' : 'stunned' }, m)
    return { tx: m.x, tz: m.z }
  },

  firewall(g, p, aim, c) {
    const { fx, fz } = flat(p, aim)
    const d = Math.max(1.5, Math.min(5, g.grid.ray(p.x, p.z, fx, fz, 5, Mode.Sight) - 0.8))
    const x = p.x + fx * d
    const z = p.z + fz * d
    const bonus = p.stats.firewallBonus
    addZone(g, {
      kind: 'firewall',
      x,
      z,
      r: 0.9,
      dur: (6 + 2 * bonus) * c.ext,
      owner: p.id,
      angle: Math.atan2(fz, fx) + Math.PI / 2,
      len: 6 * c.ext,
      power: c.sp * 1.5 * (1 + 0.25 * bonus),
    })
    return { tx: x, tz: z }
  },

  system_snooze(g, p, _aim, c) {
    const r = 6 * c.ext
    for (const m of g.monsters.values()) {
      if (!hostile(g, m) || Math.hypot(m.x - p.x, m.z - p.z) > r + monsterRadius(m)) continue
      if (!g.grid.lineOfSight(p.x, p.z, m.x, m.z)) continue
      statusMonster(g, m, 'asleep', 5 * c.ext, 0, p.id)
    }
    g.emit({ kind: 'explode', x: round2(p.x), z: round2(p.z), r, what: 'snooze', color: '#9fb7ff' }, p)
    return {}
  },

  stasis_field(g, p, aim, c) {
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 14, { hint: aim.target, forPlayer: true })
    const x = res.end.x - res.dir.dx * 0.3
    const z = res.end.z - res.dir.dz * 0.3
    const zn = addZone(g, { kind: 'stasis', x, z, r: 4 * c.ext, dur: 4 * c.ext, owner: p.id })
    tickZone(g, zn, p)
    return { tx: x, tz: z }
  },

  data_leech(g, p, aim, c) {
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 16, { hint: aim.target, forPlayer: true, radiusMult: 1.5 })
    const m = res.hits[0]?.m
    if (!m) return noTarget(g, p)
    const dur = 2 * c.ext
    p.leech = { m: m.id, until: g.time + dur, next: g.time, perTick: c.sp * 1.1 * 0.25 }
    g.emit({ kind: 'leech', p: p.id, m: m.id, dur }, p)
    return { tx: m.x, tz: m.z }
  },

  ping(g, p, _aim, c) {
    const r = 20 * c.ext
    for (const m of g.monsters.values()) if (Math.hypot(m.x - p.x, m.z - p.z) < r) m.revealedUntil = Math.max(m.revealedUntil, g.time + 6 * c.ext)
    statusPlayer(g, p, 'scanner', 6 * c.ext)
    g.emit({ kind: 'explode', x: round2(p.x), z: round2(p.z), r, what: 'ping', color: '#5cf2ff' }, p)
    return {}
  },

  honeypot(g, p, aim, c) {
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 10, { forPlayer: true })
    let x = res.end.x - res.dir.dx * 0.6
    let z = res.end.z - res.dir.dz * 0.6
    if (g.grid.blocked(x, z, 0.4, Mode.Player)) {
      x = p.x
      z = p.z
    }
    for (const zn of g.zones.values()) if (zn.kind === 'honeypot' && zn.owner === p.id) g.zones.delete(zn.id)
    addZone(g, { kind: 'honeypot', x, z, r: 15, dur: 8 * c.ext, owner: p.id, hp: p.stats.maxHp * 0.8 + c.sp * 3 })
    return { tx: x, tz: z }
  },

  hijack(g, p, aim, c) {
    const o = eye(p)
    const res = rayMonsters(g, o.x, o.y, o.z, aim.dx, aim.dy, aim.dz, 22, { hint: aim.target, forPlayer: true, radiusMult: 1.4 })
    const m = res.hits[0]?.m
    if (!m) return noTarget(g, p)
    const b = m.def.behaviour
    if (m.boss || m.def.stationary || b === 'zeroday' || b === 'dragon' || b === 'node') return noTarget(g, p, `The ${m.def.name} resists the hijack.`)
    if (m.hp > m.maxHp * 0.5) return noTarget(g, p, 'Hijack only works on programs below half HP.')
    for (const other of g.monsters.values()) if (other.allyOf === p.id) other.allyUntil = g.time
    m.allyOf = p.id
    m.allyUntil = g.time + 10 * c.ext
    m.target = null
    m.windup = null
    m.dash = null
    m.fuseAt = 0
    m.distressUntil = 0
    m.statuses.delete('asleep')
    g.emit({ kind: 'status', m: m.id, s: 'hijacked' }, m)
    return { tx: m.x, tz: m.z }
  },

  daemon(g, p, _aim, c) {
    for (const zn of g.zones.values()) if (zn.kind === 'daemon' && zn.owner === p.id) g.zones.delete(zn.id)
    addZone(g, { kind: 'daemon', x: p.x, z: p.z, r: 0.5, dur: 15 * c.ext, owner: p.id, power: c.sp * 0.5, hp: 1e9 })
    return {}
  },
}

/** Spells that count as an attack (they end Encryption). */
const QUIET_SPELLS = new Set(['repair', 'glitch_step', 'ping', 'honeypot'])

export function cast(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'cast' }>) {
  if (p.dead) return
  const id = p.char.spells[Number(msg.slot)]
  if (!id) return
  const def = SPELL_BY_ID[id]
  const fx = SPELL_FX[id]
  if (!def || !fx || !knownSpells(p.char.level, p.char.talents).includes(id)) return
  const now = g.time
  if ((p.spellReady[id] ?? 0) > now + 0.05) return
  if (p.statuses.has('stunned') || p.statuses.has('frozen')) return g.toast(p, 'You are stunned.')
  const cost = Math.round(def.mana * p.stats.spellCost)
  if (p.mana < cost) return g.toast(p, 'Not enough mana.', 'nomana')
  const aim = aimOf(msg) ?? forward(p)
  const res = fx(g, p, aim, { sp: spellBase(p.char.level) * p.stats.spellPower, ext: p.stats.extender })
  if (!res) return
  p.mana -= cost
  p.spellReady[id] = now + def.cooldown * (1 - p.stats.cdr)
  if (!QUIET_SPELLS.has(id)) breakStealth(g, p)
  progress.count(g, p, 'spells')
  g.emit(
    { kind: 'cast', p: p.id, spell: id, x: round2(p.x), z: round2(p.z), tx: res.tx === undefined ? undefined : round2(res.tx), tz: res.tz === undefined ? undefined : round2(res.tz) },
    p,
  )
}

// --- Potions and grenades --------------------------------------------------------------------------
function consume(p: Player, slot: number) {
  const item = p.char.inventory[slot]
  if (!item) return
  item.qty -= 1
  if (item.qty <= 0) p.char.inventory[slot] = null
  p.charDirty = true
}

/** The first drink or splash of a potion kind identifies it for everyone this season. */
function identify(g: Game, kind: string, by: Player | null) {
  if (g.identified.has(kind)) return
  g.identified.add(kind)
  g.emit({ kind: 'identify', base: kind, color: g.colors[kind] ?? 0, byName: by?.char.name ?? 'Someone', name: POTIONS[kind].name })
  g.markState()
}

/** A potion's effect on a player; splashes apply at reduced strength. */
export function applyPotion(g: Game, p: Player, kind: string, strength: number) {
  if (p.dead) return
  switch (kind) {
    case 'repair_s':
    case 'repair_m':
    case 'repair_l': {
      const pct = kind === 'repair_s' ? 0.25 : kind === 'repair_m' ? 0.5 : 0.8
      p.heals.push({ perSec: (p.stats.maxHp * pct * strength) / 2, until: g.time + 2 })
      statusPlayer(g, p, 'regen', 2)
      return
    }
    case 'energy': {
      const before = p.mana
      p.mana = Math.min(maxManaNow(p), p.mana + p.stats.maxMana * 0.5 * strength)
      g.emit({ kind: 'mana', p: p.id, amount: Math.round(p.mana - before) }, { to: p.id })
      return
    }
    case 'overclock':
      return statusPlayer(g, p, 'haste', 10 * strength)
    case 'firewall':
      return statusPlayer(g, p, 'shielded', 8 * strength)
    case 'encryption':
      statusPlayer(g, p, 'stealth', 6 * strength)
      for (const m of g.monsters.values()) if (m.target?.kind === 'player' && m.target.id === p.id) m.target = null
      return
    case 'scanner':
      return statusPlayer(g, p, 'scanner', 15 * strength)
    case 'acid':
      hurtPlayer(g, p, p.stats.maxHp * 0.2 * strength, 'pure', { name: 'a Vial of Acid', x: p.x, z: p.z }, { unavoidable: true })
      return
    case 'toxic':
      statusPlayer(g, p, 'corrupted', 6, p.stats.maxHp * 0.04 * strength)
      statusPlayer(g, p, 'slowed', 4)
      return
  }
}

export function drinkSlot(g: Game, p: Player, slot: number) {
  const item = p.char.inventory[slot]
  if (!item || item.kind !== 'potion' || p.dead || !POTIONS[item.base]) return
  const now = g.time
  if (now < p.potionReady - 0.05) return
  p.potionReady = now + POTION_COOLDOWN
  consume(p, slot)
  const kind = item.base
  const color = g.colors[kind] ?? 0
  const known = g.identified.has(kind)
  applyPotion(g, p, kind, 1)
  identify(g, kind, p)
  g.emit({ kind: 'drink', p: p.id, base: kind, color, name: potionName(kind, color, true), known }, p)
  progress.count(g, p, 'potions')
  progress.drankKind(g, p, kind)
}

/** Throws a potion or grenade from an inventory slot. */
export function throwItem(g: Game, p: Player, slot: number, aim: Dir3) {
  const item = p.char.inventory[slot]
  if (!item || p.dead) return
  if (item.kind !== 'potion' && item.kind !== 'grenade') return g.toast(p, "You can't throw that.")
  const now = g.time
  if (now < p.potionReady - 0.05) return
  p.potionReady = now + POTION_COOLDOWN
  consume(p, slot)
  const grenade = item.kind === 'grenade'
  const o = eye(p)
  const speed = grenade ? 17 : 15
  const pr = spawnProjectile(g, {
    kind: grenade ? 'grenade' : 'potion',
    x: o.x + aim.dx * 0.5,
    y: o.y - 0.1,
    z: o.z + aim.dz * 0.5,
    vx: aim.dx * speed,
    vy: aim.dy * speed + 3.5,
    vz: aim.dz * speed,
    owner: { kind: 'player', id: p.id },
    damage: 0,
    dtype: 'heat',
    radius: 0,
    gravity: 18,
    ttl: grenade ? GRENADE_FUSE + 0.5 : 4,
    hitRadius: 0.3,
    data: grenade ? { grenade: item.base } : { potion: item.base, color: g.colors[item.base] ?? 0 },
  })
  if (grenade) pr.fuseAt = now + GRENADE_FUSE
  if (grenade || !POTIONS[item.base]?.good) breakStealth(g, p)
  progress.count(g, p, grenade ? 'grenades' : 'potions')
  g.emit({ kind: 'throw', p: p.id, what: grenade ? item.base : 'potion' }, p)
}

export function useQuickbar(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'use' }>) {
  if (p.dead) return
  const key = p.char.quickbar[Number(msg.slot)]
  if (!key) return
  const [kind, base] = key.split(':')
  const slot = findStack(p.char, key)
  if (slot < 0) {
    const label = kind === 'potion' && POTIONS[base] ? potionName(base, g.colors[base] ?? 0, g.identified.has(base)) : (GRENADES[base]?.name ?? 'that')
    return g.toast(p, `No ${label} left.`)
  }
  const aim = aimOf(msg) ?? forward(p)
  if (kind === 'grenade') return throwItem(g, p, slot, aim)
  // Known poisons are thrown; everything else is drunk (unknown poisons too, which is the risk).
  if (kind === 'potion' && g.identified.has(base) && !POTIONS[base]?.good) return throwItem(g, p, slot, aim)
  if (kind === 'potion') return drinkSlot(g, p, slot)
}

export function throwGrenade(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'grenade' }>) {
  if (p.dead) return
  let slot = findStack(p.char, `grenade:${p.char.grenade}`)
  if (slot < 0) slot = p.char.inventory.findIndex((it) => it?.kind === 'grenade')
  if (slot < 0) return g.toast(p, 'No grenades left. The black market sells them.')
  throwItem(g, p, slot, aimOf(msg) ?? forward(p))
}

export function throwFromInventory(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'throw' }>) {
  const slot = Number(msg.from)
  if (!Number.isInteger(slot) || slot < 0 || slot >= p.char.inventory.length) return
  throwItem(g, p, slot, aimOf(msg) ?? forward(p))
}

// --- Projectiles -----------------------------------------------------------------------------------
export interface ProjectileOpts {
  kind: string
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  owner: TargetRef
  damage: number
  dtype: DamageType
  radius: number
  gravity: number
  ttl: number
  hitRadius: number
  data: Projectile['data']
}

export function spawnProjectile(g: Game, o: ProjectileOpts): Projectile {
  const pr: Projectile = {
    id: g.nextId(),
    kind: o.kind,
    x: o.x,
    y: o.y,
    z: o.z,
    vx: o.vx,
    vy: o.vy,
    vz: o.vz,
    owner: o.owner,
    damage: o.damage,
    dtype: o.dtype,
    radius: o.radius,
    gravity: o.gravity,
    expires: g.time + o.ttl,
    fuseAt: 0,
    bounces: 0,
    hitRadius: o.hitRadius,
    data: o.data ?? {},
  }
  g.projectiles.set(pr.id, pr)
  return pr
}

interface Victim {
  player?: Player
  monster?: Monster
  zone?: Zone
  t: number
}

/** Closest approach of segment a->b to a point, as segment parameter and squared distance (2D). */
function approach(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0
  const cx = ax + dx * t - px
  const cz = az + dz * t - pz
  return { t, d2: cx * cx + cz * cz }
}

/** Finds what a projectile touches along its step, up to segment parameter maxT. */
function sweep(g: Game, pr: Projectile, sx: number, sy: number, sz: number, nx: number, ny: number, nz: number, maxT: number): Victim | null {
  let best: Victim | null = null
  const consider = (v: Victim) => {
    if (v.t <= maxT && (!best || v.t < best.t)) best = v
  }
  const yAt = (t: number) => sy + (ny - sy) * t
  const ownerMonster = pr.owner.kind === 'monster' ? g.monsters.get(pr.owner.id) : undefined
  const hostileShot = pr.owner.kind === 'monster' && !ownerMonster?.allyOf
  if (hostileShot) {
    for (const p of g.players.values()) {
      if (p.dead) continue
      const a = approach(sx, sz, nx, nz, p.x, p.z)
      const r = pr.hitRadius + 0.45
      const y = yAt(a.t)
      if (a.d2 <= r * r && y > -0.2 && y < 2.1) consider({ player: p, t: a.t })
    }
    for (const zn of g.zones.values()) {
      if (zn.kind !== 'honeypot') continue
      const a = approach(sx, sz, nx, nz, zn.x, zn.z)
      const r = pr.hitRadius + 0.6
      if (a.d2 <= r * r && yAt(a.t) < 1.8) consider({ zone: zn, t: a.t })
    }
    return best
  }
  const allyOf = pr.owner.kind === 'player' ? pr.owner.id : (ownerMonster?.allyOf ?? null)
  for (const m of g.monsters.values()) {
    if (m.dead || m.ambush || m.submergedUntil > g.time || (allyOf && m.allyOf === allyOf) || m.allyOf) continue
    if (pr.owner.kind === 'monster' && m.id === pr.owner.id) continue
    const a = approach(sx, sz, nx, nz, m.x, m.z)
    const r = pr.hitRadius + monsterRadius(m)
    const y = yAt(a.t)
    if (a.d2 <= r * r && y >= m.y - 0.3 && y <= m.y + monsterHeight(m) + 0.3) consider({ monster: m, t: a.t })
  }
  return best
}

export function updateProjectiles(g: Game, dt: number) {
  const now = g.time
  for (const pr of [...g.projectiles.values()]) {
    if (!g.projectiles.has(pr.id)) continue
    if (pr.fuseAt && now >= pr.fuseAt) {
      impact(g, pr, pr.x, pr.y, pr.z, null)
      continue
    }
    if (now >= pr.expires) {
      if (pr.owner.kind === 'player') impact(g, pr, pr.x, pr.y, pr.z, null)
      else g.projectiles.delete(pr.id)
      continue
    }
    pr.vy -= pr.gravity * dt
    const sx = pr.x
    const sy = pr.y
    const sz = pr.z
    let nx = sx + pr.vx * dt
    let ny = sy + pr.vy * dt
    let nz = sz + pr.vz * dt
    // Walls.
    let wallT = 1
    let wall: { cx: number; cz: number; face: number } | null = null
    const step = Math.hypot(nx - sx, nz - sz)
    if (step > 1e-6) {
      const hit = g.grid.rayHit(sx, sz, nx - sx, nz - sz, step, Mode.Sight)
      if (hit.dist < step) {
        wallT = Math.max(0, (hit.dist - 0.05) / step)
        wall = { cx: hit.cx, cz: hit.cz, face: hit.face }
      }
    }
    // Floor and ceiling.
    let floorT = 1
    if (ny < 0.05 && sy >= 0.05) floorT = (sy - 0.05) / Math.max(1e-6, sy - ny)
    else if (ny < 0.05) floorT = 0
    let ceilT = 1
    if (ny > WALL_HEIGHT - 0.05) ceilT = Math.max(0, (WALL_HEIGHT - 0.05 - sy) / Math.max(1e-6, ny - sy))
    const stopT = Math.min(wallT, floorT, ceilT)
    const victim = sweep(g, pr, sx, sy, sz, nx, ny, nz, stopT)
    const at = (t: number) => ({ x: sx + (nx - sx) * t, y: sy + (ny - sy) * t, z: sz + (nz - sz) * t })
    if (victim) {
      const pt = at(victim.t)
      if (pr.kind === 'grenade') {
        // Grenades stop dead against a body and drop.
        pr.x = pt.x
        pr.y = pt.y
        pr.z = pt.z
        pr.vx *= -0.15
        pr.vz *= -0.15
        continue
      }
      impact(g, pr, pt.x, pt.y, pt.z, victim)
      continue
    }
    if (stopT < 1) {
      const pt = at(stopT)
      if (pr.kind === 'grenade') {
        pr.x = pt.x
        pr.y = Math.max(0.05, Math.min(WALL_HEIGHT - 0.05, pt.y))
        pr.z = pt.z
        if (stopT === wallT && wall) {
          if (wall.face === 0) pr.vx = -pr.vx * 0.45
          else pr.vz = -pr.vz * 0.45
        } else if (stopT === floorT) {
          pr.vy = Math.abs(pr.vy) * 0.35
          pr.vx *= 0.6
          pr.vz *= 0.6
        } else pr.vy = -Math.abs(pr.vy) * 0.35
        pr.bounces++
        continue
      }
      if (wall && stopT === wallT && pr.owner.kind === 'player') {
        const owner = g.players.get(pr.owner.id)
        if (owner) worldstate.shotWall(g, owner, wall.cx, wall.cz)
      }
      impact(g, pr, pt.x, pt.y, pt.z, null)
      continue
    }
    pr.x = nx
    pr.y = ny
    pr.z = nz
  }
}

function impact(g: Game, pr: Projectile, x: number, y: number, z: number, victim: Victim | null) {
  g.projectiles.delete(pr.id)
  const owner = pr.owner.kind === 'player' ? (g.players.get(pr.owner.id) ?? null) : null
  const shooter = pr.owner.kind === 'monster' ? (g.monsters.get(pr.owner.id) ?? null) : null
  switch (pr.kind) {
    case 'grenade':
      return grenadeBurst(g, pr, x, z, owner)
    case 'potion':
      return potionSplash(g, pr, x, z, owner)
    case 'cannon':
      explode(g, x, z, pr.radius, pr.damage, pr.dtype, owner, { what: 'neutron', color: '#ffd34d' })
      return
    case 'horizon':
      addZone(g, { kind: 'blackhole', x, z, r: pr.radius, dur: 1.4, owner: owner?.id ?? null, power: pr.damage })
      return
  }
  // Monster shots.
  if (victim?.player) {
    const p = victim.player
    const dealt = hurtPlayer(g, p, pr.damage, pr.dtype, { name: shooter?.def.name ?? 'a stray shot', x: shooter?.x ?? x, z: shooter?.z ?? z, key: shooter?.def.key })
    if (dealt > 0) {
      if (pr.data.special === 'web') {
        statusPlayer(g, p, 'rooted', 1.2)
        g.emit({ kind: 'status', p: p.id, s: 'rooted' }, p)
      }
      if (pr.data.burn) statusPlayer(g, p, 'burning', 3, pr.damage * pr.data.burn)
    }
  } else if (victim?.monster) {
    const credit = shooter?.allyOf ? (g.players.get(shooter.allyOf) ?? null) : null
    hitMonster(g, victim.monster, null, pr.damage * 1.5, { type: pr.dtype, noCrit: true, creditTo: credit, fromX: x, fromZ: z })
  } else if (victim?.zone) {
    victim.zone.hp -= pr.damage
    if (victim.zone.hp <= 0) g.zones.delete(victim.zone.id)
  } else if (pr.data.special === 'web' && y < 1.5) {
    addZone(g, { kind: 'web', x, z, r: 1.3, dur: 6, ownerMonster: pr.owner.kind === 'monster' ? pr.owner.id : null })
  }
}

function grenadeBurst(g: Game, pr: Projectile, x: number, z: number, owner: Player | null) {
  const kind = pr.data.grenade ?? 'emp'
  const def = GRENADES[kind] ?? GRENADES.emp
  const base = spellBase(owner?.char.level ?? 1) * 2 * (owner?.stats.grenadeDamage ?? 1)
  if (kind === 'emp') explode(g, x, z, def.radius, base * 0.6, 'emp', owner, { what: 'emp', stunMachines: 3, reveal: true, color: '#4fa8ff' })
  else if (kind === 'glitch') explode(g, x, z, def.radius, base * 2.2, 'pure', owner, { what: 'glitch', color: '#c77dff' })
  else {
    addZone(g, { kind: 'noise', x, z, r: def.radius, dur: 6, owner: owner?.id ?? null })
    g.emit({ kind: 'explode', x: round2(x), z: round2(z), r: def.radius, what: 'noise', color: '#c8d2dc' }, { x, z })
  }
}

function potionSplash(g: Game, pr: Projectile, x: number, z: number, owner: Player | null) {
  const kind = pr.data.potion ?? 'repair_s'
  if (!POTIONS[kind]) return
  const color = pr.data.color ?? 0
  g.emit(
    { kind: 'explode', x: round2(x), z: round2(z), r: kind === 'toxic' ? 3.5 : 2.5, what: kind === 'acid' || kind === 'toxic' ? kind : 'splash', color: POTION_COLORS[color]?.css },
    { x, z },
  )
  identify(g, kind, owner)
  const base = spellBase(owner?.char.level ?? 1)
  if (kind === 'acid') {
    addZone(g, { kind: 'acid', x, z, r: 2.5, dur: 6, owner: owner?.id ?? null, power: base * 1.2 })
    return
  }
  if (kind === 'toxic') {
    addZone(g, { kind: 'toxic', x, z, r: 3.5, dur: 7, owner: owner?.id ?? null, power: base * 0.6 })
    return
  }
  // Good potions splash onto everyone nearby at reduced strength.
  for (const p of g.livePlayers()) if (Math.hypot(p.x - x, p.z - z) <= 3) applyPotion(g, p, kind, 0.75)
}

// --- Zones -----------------------------------------------------------------------------------------
export interface ZoneOpts {
  kind: ZoneKind
  x: number
  z: number
  r: number
  dur: number
  owner?: string | null
  ownerMonster?: number | null
  angle?: number
  len?: number
  power?: number
  hp?: number
  data?: Record<string, number>
}

const MAX_ZONES = 300

export function addZone(g: Game, o: ZoneOpts): Zone {
  const zn: Zone = {
    id: g.nextId(),
    kind: o.kind,
    x: o.x,
    z: o.z,
    r: o.r,
    until: g.time + o.dur,
    angle: o.angle ?? 0,
    len: o.len ?? 0,
    owner: o.owner ?? null,
    ownerMonster: o.ownerMonster ?? null,
    power: o.power ?? 0,
    nextTick: g.time,
    hp: o.hp ?? 1,
    data: o.data ?? {},
  }
  g.zones.set(zn.id, zn)
  if (g.zones.size > MAX_ZONES) {
    const oldest = g.zones.keys().next().value
    if (oldest !== undefined) g.zones.delete(oldest)
  }
  return zn
}

const TICK: Partial<Record<ZoneKind, number>> = { mine: 0.1, blackhole: 0.1, stasis: 0.25, junk: 0.25, web: 0.25 }

export function updateZones(g: Game, dt: number) {
  const now = g.time
  for (const zn of [...g.zones.values()]) {
    if (!g.zones.has(zn.id)) continue
    const owner = zn.owner ? (g.players.get(zn.owner) ?? null) : null
    if (now >= zn.until) {
      g.zones.delete(zn.id)
      if (zn.kind === 'blackhole') explode(g, zn.x, zn.z, zn.r, zn.power, 'emp', owner, { what: 'horizon', color: '#c77dff' })
      continue
    }
    if (zn.kind === 'daemon') {
      if (!owner || owner.dead) {
        g.zones.delete(zn.id)
        continue
      }
      const a = now * 1.5 + zn.id
      const k = Math.min(1, dt * 5)
      zn.x += (owner.x + Math.cos(a) * 1.3 - zn.x) * k
      zn.z += (owner.z + Math.sin(a) * 1.3 - zn.z) * k
    }
    if (now < zn.nextTick) continue
    zn.nextTick = now + (TICK[zn.kind] ?? 0.5)
    tickZone(g, zn, owner)
  }
}

function tickZone(g: Game, zn: Zone, owner: Player | null) {
  const now = g.time
  const inside = (x: number, z: number, pad = 0) => Math.hypot(x - zn.x, z - zn.z) <= zn.r + pad
  switch (zn.kind) {
    case 'firewall':
      for (const m of g.monsters.values()) {
        if (!hostile(g, m) || distToSegment(m.x, m.z, zn) > 1.1 + monsterRadius(m)) continue
        statusMonster(g, m, 'burning', 2, zn.power, owner?.id)
      }
      return
    case 'stasis':
      for (const m of g.monsters.values()) {
        if (!hostile(g, m) || zn.data[m.id] || !inside(m.x, m.z, monsterRadius(m))) continue
        zn.data[m.id] = 1
        statusMonster(g, m, 'frozen', Math.max(0.5, zn.until - now), 0, owner?.id)
      }
      return
    case 'acid':
      for (const m of [...g.monsters.values()]) {
        if (!hostile(g, m) || !inside(m.x, m.z, monsterRadius(m) * 0.5)) continue
        hitMonster(g, m, null, zn.power * 0.5, { type: 'pure', aoe: true, noCrit: true, tag: 'acid', creditTo: owner })
      }
      return
    case 'toxic':
      for (const m of g.monsters.values()) {
        if (!hostile(g, m) || !inside(m.x, m.z, monsterRadius(m) * 0.5)) continue
        statusMonster(g, m, 'corrupted', 1.5, zn.power, owner?.id)
      }
      return
    case 'mine':
      for (const m of g.monsters.values()) {
        if (!hostile(g, m) || !inside(m.x, m.z, monsterRadius(m))) continue
        g.zones.delete(zn.id)
        explode(g, zn.x, zn.z, 3.5, zn.power, 'pure', owner, { what: 'glitch', color: '#c77dff' })
        return
      }
      return
    case 'blackhole':
      for (const m of g.monsters.values()) {
        if (!hostile(g, m) || !inside(m.x, m.z, 2.5)) continue
        statusMonster(g, m, 'pulled', 0.4, 7, owner?.id)
        const s = m.statuses.get('pulled')
        if (s) {
          s.x = zn.x
          s.z = zn.z
        }
      }
      return
    case 'daemon': {
      if (!owner) return
      let target: Monster | null = null
      let best = 18
      for (const m of g.monsters.values()) {
        if (!hostile(g, m)) continue
        const d = Math.hypot(m.x - zn.x, m.z - zn.z)
        if (d < best && g.grid.lineOfSight(zn.x, zn.z, m.x, m.z)) {
          best = d
          target = m
        }
      }
      if (!target) return
      g.emit(
        { kind: 'shot', by: owner.id, w: 'daemon', x: round2(zn.x), y: 2.4, z: round2(zn.z), tx: round2(target.x), ty: round2(target.y + 1), tz: round2(target.z) },
        { x: zn.x, z: zn.z },
      )
      hitMonster(g, target, owner, zn.power, { type: 'laser', noCrit: true, fromX: zn.x, fromZ: zn.z, tag: 'daemon' })
      return
    }
    case 'junk':
      for (const p of g.livePlayers()) if (inside(p.x, p.z, 0.3)) statusPlayer(g, p, 'slowed', 0.6)
      return
    case 'web':
      for (const p of g.livePlayers()) {
        if (!inside(p.x, p.z, 0.2) || now < p.iframesUntil) continue
        const key = `web${zn.id}`
        if (now - (p.trapHitAt[key] ?? -99) < 2) continue
        p.trapHitAt[key] = now
        statusPlayer(g, p, 'rooted', 1)
        g.emit({ kind: 'status', p: p.id, s: 'rooted' }, p)
      }
      return
    case 'crater':
      for (const p of g.livePlayers()) {
        if (!inside(p.x, p.z, 0.3)) continue
        hurtPlayer(g, p, zn.power * 0.5, 'heat', { name: 'burning ground', x: zn.x, z: zn.z })
      }
      return
    default:
      return
  }
}

/** Heals a little when a potion splash lands on the thrower's friends; exported for tests. */
export const _test = { healPlayer, POCKET_LASER }
