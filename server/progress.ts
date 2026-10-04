// Character progression and the economy: XP, credits, loot, inventory, talents, the black market,
// quests, daily challenges and achievements.
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID } from '../shared/achievements.ts'
import { computeStats, stackLimit } from '../shared/character.ts'
import {
  MAX_LEVEL,
  PICKUP_RADIUS,
  QUICKBAR_SIZE,
  SECTOR_LEVELS,
  SECTOR_POTIONS,
  SPELL_SLOTS,
  cellCenter,
  clamp,
  round2,
  xpToNext,
} from '../shared/constants.ts'
import { Mode } from '../shared/grid.ts'
import {
  GRENADES,
  GRENADE_KINDS,
  IMPLANTS,
  IMPLANT_IDS,
  POTIONS,
  WEAPONS,
  WEAPON_TYPES,
  isStackable,
  itemValue,
  makeArmor,
  makeDatacore,
  makeGrenade,
  makeImplant,
  makePotion,
  makeWeapon,
  potionName,
  rollGear,
  rollPotion,
  rollRarity,
  sellPrice,
  type Item,
  type WeaponType,
} from '../shared/items.ts'
import { FRAGMENTS } from '../shared/lore.ts'
import type { ClientMsg, LootNet, ShopEntry } from '../shared/protocol.ts'
import { DAILY_CREDITS, MAX_ACTIVE_QUESTS, rollQuest, type QuestKind, type QuestState } from '../shared/quests.ts'
import { hashString, mulberry32, pick } from '../shared/rng.ts'
import { SPELL_BY_ID, knownSpells } from '../shared/spells.ts'
import { TALENT_BY_ID, respecCost, talentBlocker } from '../shared/talents.ts'
import { FLOOR, inRect, type WorldObject } from '../shared/world.ts'
import * as actions from './actions.ts'
import type { Loot, Monster, Player } from './entities.ts'
import type { Game } from './game.ts'
import * as worldstate from './worldstate.ts'

const LOOT_TTL = 180
const SHOP_WINDOW_MS = 10 * 60 * 1000
const BOARD_REFRESH = 600

const freshItemId = (g: Game) => `i${Date.now().toString(36)}${g.nextId().toString(36)}`

/** Keeps HP at the same fraction when max HP changes. */
function refreshStats(p: Player) {
  const ratio = p.stats.maxHp > 0 ? p.hp / p.stats.maxHp : 1
  p.stats = computeStats(p.char)
  if (!p.dead) p.hp = clamp(Math.round(p.stats.maxHp * ratio), 1, p.stats.maxHp)
  p.mana = Math.min(p.mana, p.stats.maxMana)
}

// --- Counters, daily challenges and achievements -------------------------------------------------
export function count(g: Game, p: Player, counter: string, n = 1) {
  const c = p.char.counters
  c[counter] = (c[counter] ?? 0) + n
  p.charSoft = true
  dailyProgress(g, p, counter, n)
  checkAchievements(g, p, counter)
}

/** Raises a counter to at least `value` (level, codex size and the like). */
export function setCounter(g: Game, p: Player, counter: string, value: number) {
  const c = p.char.counters
  if ((c[counter] ?? 0) >= value) return
  c[counter] = value
  p.charSoft = true
  checkAchievements(g, p, counter)
}

export function prepareDaily(g: Game, p: Player) {
  g.refreshDaily()
  if (p.char.daily.date === g.dailyDate) return
  p.char.daily = { date: g.dailyDate, progress: g.daily.map(() => 0), done: g.daily.map(() => false) }
}

function dailyProgress(g: Game, p: Player, counter: string, n: number) {
  if (p.char.daily.date !== g.dailyDate) prepareDaily(g, p)
  const d = p.char.daily
  g.daily.forEach((def, i) => {
    if (def.counter !== counter || d.done[i]) return
    d.progress[i] = Math.min(def.goal, (d.progress[i] ?? 0) + n)
    if (d.progress[i] < def.goal) return
    d.done[i] = true
    p.charDirty = true
    g.emit({ kind: 'daily', index: i, text: def.text, done: true }, { to: p.id })
    giveCredits(g, p, DAILY_CREDITS)
    addXp(g, p, Math.round(xpToNext(p.char.level) * 0.3))
  })
}

function checkAchievements(g: Game, p: Player, counter: string) {
  const v = p.char.counters[counter] ?? 0
  for (const a of ACHIEVEMENTS) if (a.counter === counter && a.goal !== undefined && v >= a.goal) grant(g, p, a.id)
}

export function grant(g: Game, p: Player, id: string) {
  const a = ACHIEVEMENT_BY_ID[id]
  if (!a || p.char.achievements.includes(id)) return
  p.char.achievements.push(id)
  p.charDirty = true
  g.emit({ kind: 'achievement', id, name: a.name, byName: p.char.name, p: p.id })
  if (a.credits) giveCredits(g, p, a.credits)
}

export function drankKind(g: Game, p: Player, kind: string) {
  p.char.counters[`drank_${kind}`] = 1
  const kinds = Object.keys(p.char.counters).filter((k) => k.startsWith('drank_')).length
  setCounter(g, p, 'potionKinds', kinds)
}

// --- XP and credits --------------------------------------------------------------------------------
export function addXp(g: Game, p: Player, xp: number) {
  if (xp <= 0 || p.char.level >= MAX_LEVEL) return
  const before = p.char.level
  p.char.xp += Math.round(xp)
  while (p.char.level < MAX_LEVEL && p.char.xp >= xpToNext(p.char.level)) {
    p.char.xp -= xpToNext(p.char.level)
    p.char.level++
  }
  if (p.char.level >= MAX_LEVEL) p.char.xp = 0
  if (p.char.level !== before) levelChanged(g, p, before)
  else p.charSoft = true
}

/** After a level change: new spells go into empty slots, HP and mana refill, everyone hears about it. */
export function levelChanged(g: Game, p: Player, before: number) {
  const fresh = knownSpells(p.char.level, p.char.talents).filter((id) => {
    const u = SPELL_BY_ID[id].unlock
    return u !== null && u > before
  })
  for (const id of fresh) autoSlot(p, id)
  p.stats = computeStats(p.char)
  p.hp = p.stats.maxHp
  p.mana = p.stats.maxMana
  p.charDirty = true
  setCounter(g, p, 'level', p.char.level)
  if (p.char.level > before) g.emit({ kind: 'levelup', p: p.id, name: p.char.name, level: p.char.level, spells: fresh })
}

function autoSlot(p: Player, id: string) {
  if (p.char.spells.includes(id)) return
  const empty = p.char.spells.indexOf(null)
  if (empty >= 0) p.char.spells[empty] = id
}

export function giveCredits(g: Game, p: Player, amount: number) {
  const n = Math.round(amount)
  if (n <= 0) return
  p.char.credits += n
  p.charSoft = true
  g.emit({ kind: 'credits', p: p.id, amount: n }, { to: p.id })
  if (p.char.credits >= 10000) grant(g, p, 'rich')
}

// --- Loot on the ground ----------------------------------------------------------------------------
interface LootOpts {
  owner: string | null
  ownerName?: string
  item: Item | null
  credits?: number
  x: number
  z: number
  ttl?: number
  dump?: boolean
}

export function addLoot(g: Game, o: LootOpts): Loot {
  const id = g.nextId()
  const l: Loot = {
    id,
    owner: o.owner,
    ownerName: o.ownerName,
    item: o.item,
    credits: o.credits ?? 0,
    dump: !!o.dump,
    x: o.x,
    z: o.z,
    expires: g.time + (o.ttl ?? LOOT_TTL),
    sector: g.grid.sectorAt(o.x, o.z),
  }
  g.loot.set(id, l)
  return l
}

/** A spot near (x, z) that is not inside a wall. */
function scatter(g: Game, x: number, z: number, spread: number) {
  for (let i = 0; i < 6; i++) {
    const nx = x + (g.rand() - 0.5) * spread * 2
    const nz = z + (g.rand() - 0.5) * spread * 2
    if (!g.grid.blocked(nx, nz, 0.3, Mode.Player) && g.grid.lineOfSight(x, z, nx, nz)) return { x: nx, z: nz }
  }
  return { x, z }
}

export function dropPersonal(g: Game, p: Player, item: Item, x: number, z: number) {
  const at = scatter(g, x, z, 0.9)
  addLoot(g, { owner: p.id, ownerName: p.char.name, item, x: at.x, z: at.z })
}

export function dropCredits(g: Game, x: number, z: number, amount: number, ownerId: string) {
  const at = scatter(g, x, z, 0.8)
  addLoot(g, { owner: ownerId, item: null, credits: Math.round(amount), x: at.x, z: at.z })
}

/** Personal loot for one contributor to a kill. */
export function rollMonsterLoot(g: Game, m: Monster, p: Player) {
  const r = g.rand
  const weak = m.generation > 0 || m.noCorruption ? 0.5 : 1
  const swarm = m.def.behaviour === 'swarm' ? 0.5 : 1
  const special = m.def.behaviour === 'zeroday' || m.def.behaviour === 'dragon'
  let gearChance = 0.06 * p.stats.lootMult * weak * swarm
  let rolls = 1
  let bonus = 0
  if (m.elite) {
    gearChance = 0.45 * p.stats.lootMult
    bonus = 0.6
  }
  if (m.boss) {
    gearChance = 1
    rolls = 3
    bonus = 1.5
  }
  if (special) {
    gearChance = 1
    rolls = 2
    bonus = 2.5
  }
  if (m.elite === 'leaky') rolls++
  if (m.def.behaviour === 'node' || m.def.behaviour === 'turret') gearChance *= 0.3
  const items: Item[] = []
  for (let i = 0; i < rolls; i++) if (r() < gearChance) items.push(rollGear(r, m.level, bonus))
  if (special && !items.some((it) => it.rarity >= 3)) items.push(gearOfRarity(g, m.level, 3))
  if (r() < (m.elite ? 0.3 : 0.07) * weak) items.push(makePotion(rollPotion(r)))
  if (r() < (m.elite ? 0.12 : 0.03) * weak) items.push(makeGrenade(pick(r, GRENADE_KINDS)))
  for (const it of items) dropPersonal(g, p, it, m.x, m.z)
}

/** A weapon or armour piece of at least the given rarity. */
function gearOfRarity(g: Game, level: number, minRarity: number): Item {
  const rarity = Math.max(minRarity, rollRarity(g.rand, 1))
  if (g.rand() < 0.6) {
    const types = WEAPON_TYPES.filter((t) => WEAPONS[t].minLevel <= level + 1)
    return makeWeapon(g.rand, pick(g.rand, types), level, rarity)
  }
  return makeArmor(g.rand, level, rarity)
}

// Floor cells where potions may lie around, per sector, cached per world.
let potionCells: { world: unknown; cells: number[][] } | null = null

function groundCells(g: Game) {
  if (potionCells && potionCells.world === g.world) return potionCells.cells
  const W = g.world.width
  const cells: number[][] = [[], [], [], []]
  const pockets = [...g.world.vaults, ...g.world.fakes]
  for (let z = 1; z < g.world.height - 1; z += 2)
    for (let x = 1; x < W - 1; x += 2) {
      const i = z * W + x
      if (g.world.cells[i] !== FLOOR || g.grid.hubAt[i] || g.grid.arenaAt[i]) continue
      if (pockets.some((r) => inRect(r, x, z))) continue
      cells[g.world.sector[i]].push(i)
    }
  potionCells = { world: g.world, cells }
  return cells
}

/** Tops up the potions lying around in each sector (anyone can take them). */
export function spawnGroundPotions(g: Game) {
  const cells = groundCells(g)
  const have = [0, 0, 0, 0]
  for (const l of g.loot.values()) if (!l.owner && l.item?.kind === 'potion' && l.expires > g.time + 1e5) have[l.sector]++
  for (let s = 0; s < 4; s++) {
    for (let n = have[s]; n < SECTOR_POTIONS[s] && cells[s].length; n++) {
      const i = cells[s][Math.floor(g.rand() * cells[s].length)]
      const { x, z } = g.cellPos(i)
      if (g.players.size && g.nearestPlayerDist(x, z) < 20) continue
      const at = scatter(g, x, z, 1.2)
      addLoot(g, { owner: null, item: makePotion(rollPotion(g.rand)), x: at.x, z: at.z, ttl: 1e6 })
    }
  }
}

export function updateLoot(g: Game) {
  const now = g.time
  for (const [id, l] of g.loot) if (now >= l.expires) g.loot.delete(id)
  if (g.tickCount % (20 * 30) === 0) spawnGroundPotions(g)
  for (const p of g.players.values()) {
    if (p.dead) continue
    for (const l of g.loot.values()) {
      if (l.owner && l.owner !== p.id) continue
      if (l.dropper === p.id && now < (l.dropperUntil ?? 0)) continue
      if (Math.abs(l.x - p.x) > PICKUP_RADIUS || Math.abs(l.z - p.z) > PICKUP_RADIUS) continue
      if (Math.hypot(l.x - p.x, l.z - p.z) > PICKUP_RADIUS) continue
      pickUp(g, p, l)
    }
  }
}

export function itemLabel(g: Game, it: Item) {
  return it.kind === 'potion' ? potionName(it.base, g.colors[it.base] ?? 0, g.identified.has(it.base)) : it.name
}

function pickUp(g: Game, p: Player, l: Loot) {
  const now = g.time
  const it = l.item
  if (it?.kind === 'datacore') {
    g.loot.delete(l.id)
    const q = p.char.quests.find((x) => x.id === it.base)
    g.emit({ kind: 'pickup', p: p.id, name: it.name, rarity: it.rarity, what: it.kind }, { to: p.id })
    if (q) questProgress(g, p, q, 1)
    return
  }
  if (it) {
    if (!giveItem(g, p, it)) {
      if (now - p.lastFullInv > 3) {
        p.lastFullInv = now
        g.toast(p, 'Inventory full. Sell or drop something.')
      }
      return
    }
    g.loot.delete(l.id)
    g.emit({ kind: 'pickup', p: p.id, name: itemLabel(g, it), rarity: it.rarity, what: it.kind }, { to: p.id })
    if (it.rarity === 4) count(g, p, 'legendaries')
    if (it.rarity >= 3 && (it.kind === 'weapon' || it.kind === 'armor')) g.emit({ kind: 'system', text: `${p.char.name} found ${it.name}!`, cls: `r${it.rarity}` })
    return
  }
  g.loot.delete(l.id)
  giveCredits(g, p, l.credits)
  if (l.dump) {
    count(g, p, 'dumps')
    g.toast(p, `Recovered ${l.credits} credits from your data dump.`, 'loot')
  }
  g.emit({ kind: 'pickup', p: p.id, name: `${l.credits} credits`, rarity: 0, what: l.dump ? 'dump' : 'credits' }, { to: p.id })
}

/** Puts an item in the inventory, stacking where possible. False if it does not fit. */
export function giveItem(g: Game, p: Player, item: Item): boolean {
  const inv = p.char.inventory
  if (isStackable(item)) {
    const limit = stackLimit(item, p.stats)
    for (const it of inv) {
      if (!it || it.kind !== item.kind || it.base !== item.base || it.qty >= limit) continue
      const n = Math.min(limit - it.qty, item.qty)
      it.qty += n
      item.qty -= n
      p.charDirty = true
      if (item.qty <= 0) return true
    }
  }
  const empty = inv.indexOf(null)
  if (empty < 0) return false
  inv[empty] = item
  p.charDirty = true
  // New consumables find an empty quickbar slot by themselves.
  if (isStackable(item)) {
    const key = `${item.kind}:${item.base}`
    const free = p.char.quickbar.indexOf(null)
    if (!p.char.quickbar.includes(key) && free >= 0 && item.kind === 'potion') p.char.quickbar[free] = key
  }
  return true
}

export function lootNet(g: Game, l: Loot, p: Player): LootNet {
  const it = l.item
  return {
    id: l.id,
    kind: it ? it.kind : l.dump ? 'dump' : 'credits',
    base: it?.base ?? '',
    name: it ? itemLabel(g, it) : l.dump ? `Your data dump (${l.credits} credits)` : `${l.credits} credits`,
    rarity: it?.rarity ?? 0,
    x: round2(l.x),
    z: round2(l.z),
    qty: it ? it.qty : l.credits,
    mine: l.owner === p.id,
  }
}

// --- Kills and quests --------------------------------------------------------------------------------
export function onKill(g: Game, p: Player, m: Monster) {
  count(g, p, 'kills')
  if (m.elite) count(g, p, 'elites')
  if (m.def.behaviour === 'zeroday' || m.def.behaviour === 'dragon') count(g, p, `kill_${m.def.key}`)
  p.char.bestiary[m.def.key] = (p.char.bestiary[m.def.key] ?? 0) + 1
  p.sessionKills++
  for (const q of [...p.char.quests]) {
    if (q.sector !== m.sector) continue
    const hit =
      (q.kind === 'kill' && q.target === m.def.key) ||
      q.kind === 'purge' ||
      (q.kind === 'elite' && !!m.elite) ||
      (q.kind === 'boss' && m.boss && q.target === m.def.key)
    if (hit) questProgress(g, p, q, 1)
  }
}

function questProgress(g: Game, p: Player, q: QuestState, n: number) {
  q.progress = Math.min(q.goal, q.progress + n)
  const done = q.progress >= q.goal
  g.emit({ kind: 'quest', id: q.id, title: q.title, progress: q.progress, goal: q.goal, done }, { to: p.id })
  if (done) completeQuest(g, p, q)
  else p.charSoft = true
}

/** Progress on quests of one kind in a sector (puzzles, secrets, chests). */
export function questEvent(g: Game, p: Player, kind: QuestKind, sector: number) {
  for (const q of [...p.char.quests]) if (q.kind === kind && q.sector === sector) questProgress(g, p, q, 1)
}

function completeQuest(g: Game, p: Player, q: QuestState) {
  p.char.quests = p.char.quests.filter((x) => x !== q)
  p.charDirty = true
  for (const [id, l] of g.loot) if (l.item?.kind === 'datacore' && l.item.base === q.id) g.loot.delete(id)
  g.emit({ kind: 'system', text: `Quest complete: ${q.title}. +${q.credits} credits.`, cls: 'quest' }, { to: p.id })
  giveCredits(g, p, q.credits)
  addXp(g, p, q.xp)
  if (q.item) {
    const top = SECTOR_LEVELS[q.sector][1]
    dropPersonal(g, p, gearOfRarity(g, clamp(p.char.level, top, top + 3), 2), p.x, p.z)
  }
  worldstate.reduceCorruption(g, q.sector, 8, [p])
  count(g, p, 'quests')
}

/** A random floor cell in a sector, well away from the hubs, for fetch quests. */
function questCell(g: Game, sector: number) {
  const cells = groundCells(g)[sector]
  for (let i = 0; i < 40; i++) {
    const c = cells[Math.floor(g.rand() * cells.length)]
    const { x, z } = g.cellPos(c)
    if (g.world.hubs.every((h) => Math.hypot(cellCenter(h.cx) - x, cellCenter(h.cz) - z) > 30)) return c
  }
  return cells[0]
}

function spawnDatacore(g: Game, p: Player, q: QuestState) {
  if (q.cell === undefined) q.cell = questCell(g, q.sector)
  const { x, z } = g.cellPos(q.cell)
  addLoot(g, { owner: p.id, ownerName: p.char.name, item: makeDatacore(q.id), x, z, ttl: 24 * 3600 })
}

/** Fetch quests survive a reconnect: their data cores come back. */
export function restoreQuestLoot(g: Game, p: Player) {
  for (const q of p.char.quests) {
    if (q.kind !== 'fetch') continue
    if ([...g.loot.values()].some((l) => l.item?.kind === 'datacore' && l.item.base === q.id)) continue
    spawnDatacore(g, p, q)
  }
}

export function boardOffers(g: Game, p: Player, hubId: string): QuestState[] {
  const hub = g.world.hubs.find((h) => h.id === hubId)
  if (!hub) return []
  const cur = p.board[hubId]
  if (cur && g.time - cur.at < BOARD_REFRESH && cur.offers.length) return cur.offers
  const s = hub.sector
  const allowed: QuestKind[] = ['kill', 'purge', 'elite', 'fetch']
  const arena = g.world.arenas.find((a) => a.sector === s)
  if (arena && g.state.bosses[arena.id]?.alive) allowed.push('boss')
  if (g.world.puzzles.some((pz) => pz.sector === s && !g.state.solved.includes(pz.id))) allowed.push('puzzle')
  if (g.world.fakes.some((f) => f.sector === s && !g.state.fakes.includes(f.cell))) allowed.push('secret')
  const chests = g.world.objects.filter((o) => o.kind === 'chest' && o.sector === s && !o.vault && !p.char.chests.includes(o.id))
  if (chests.length >= 3) allowed.push('chest')
  const offers: QuestState[] = []
  for (let i = 0; i < 3; i++) {
    const q = rollQuest(g.rand, s, `q${g.nextId()}`, allowed)
    if (q.kind === 'fetch') q.cell = questCell(g, s)
    offers.push(q)
  }
  p.board[hubId] = { offers, at: g.time }
  return offers
}

export function questAction(g: Game, p: Player, op: 'accept' | 'abandon', id: string) {
  if (op === 'accept') {
    if (p.hub < 0) return g.toast(p, 'Quests are handed out at hub boards.')
    const hubId = g.world.hubs[p.hub].id
    const board = p.board[hubId]
    const q = board?.offers.find((o) => o.id === id)
    if (!board || !q) return
    if (p.char.quests.length >= MAX_ACTIVE_QUESTS) return g.toast(p, `You can carry ${MAX_ACTIVE_QUESTS} quests at once. Finish or abandon one first.`)
    board.offers = board.offers.filter((o) => o !== q)
    p.char.quests.push(q)
    if (q.kind === 'fetch') spawnDatacore(g, p, q)
    p.charDirty = true
    g.send(p, { t: 'board', hub: hubId, offers: board.offers })
    g.toast(p, `Quest accepted: ${q.title}`, 'quest')
    return
  }
  const q = p.char.quests.find((x) => x.id === id)
  if (!q) return
  p.char.quests = p.char.quests.filter((x) => x !== q)
  for (const [lid, l] of g.loot) if (l.item?.kind === 'datacore' && l.item.base === q.id) g.loot.delete(lid)
  p.charDirty = true
  g.toast(p, `Quest abandoned: ${q.title}`)
}

// --- Chests and data fragments -----------------------------------------------------------------------
export function openChest(g: Game, p: Player, o: WorldObject) {
  if (o.vault && !g.state.vaults.includes(o.vault)) return g.toast(p, 'It is locked inside the vault.')
  if (p.char.chests.includes(o.id)) return g.toast(p, 'You already emptied this chest. Others can still open it.')
  p.char.chests.push(o.id)
  p.charDirty = true
  const r = g.rand
  const [lo, hi] = SECTOR_LEVELS[o.sector]
  const better = (o.tier ?? o.sector) > o.sector
  const level = clamp(p.char.level, lo, hi + 2) + (better ? 1 : 0)
  const bonus = 0.3 + (better ? 0.6 : 0)
  const items: Item[] = [rollGear(r, level, bonus)]
  if (better) items.push(rollGear(r, level, bonus))
  items.push(makePotion(rollPotion(r)))
  if (r() < 0.5) items.push(makePotion(rollPotion(r)))
  if (r() < 0.4) items.push(makeGrenade(pick(r, GRENADE_KINDS)))
  const x = cellCenter(o.x)
  const z = cellCenter(o.z)
  for (const it of items) dropPersonal(g, p, it, x, z)
  dropCredits(g, x, z, 25 * (1 + level * 0.5) * (0.8 + r() * 0.4) * (better ? 2 : 1) * p.stats.creditMult, p.id)
  g.emit({ kind: 'chest', obj: o.id, p: p.id }, { to: p.id })
  count(g, p, 'chests')
  questEvent(g, p, 'chest', o.sector)
}

export function readFragment(g: Game, p: Player, o: WorldObject) {
  if (o.vault && !g.state.vaults.includes(o.vault)) return g.toast(p, 'It is locked inside the vault.')
  const index = clamp(o.fragment ?? 0, 0, FRAGMENTS.length - 1)
  const title = FRAGMENTS[index].title
  if (p.char.codex.includes(index)) return g.emit({ kind: 'fragment', index, title }, { to: p.id })
  p.char.codex.push(index)
  p.char.codex.sort((a, b) => a - b)
  p.charDirty = true
  g.emit({ kind: 'fragment', index, title }, { to: p.id })
  setCounter(g, p, 'codex', p.char.codex.length)
  count(g, p, 'fragments')
  addXp(g, p, Math.round(xpToNext(p.char.level) * 0.1))
}

// --- Inventory and equipment ---------------------------------------------------------------------------
export function inventoryOp(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'inv' }>) {
  const inv = p.char.inventory
  const ok = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < inv.length
  switch (msg.op) {
    case 'equip':
      if (ok(msg.from)) equip(g, p, msg.from)
      return
    case 'unequip':
      return unequip(g, p, msg.slot)
    case 'drop': {
      if (!ok(msg.from)) return
      const item = inv[msg.from]
      if (!item) return
      inv[msg.from] = null
      p.charDirty = true
      const l = addLoot(g, { owner: null, item, x: p.x, z: p.z, ttl: 300 })
      l.dropper = p.id
      l.dropperUntil = g.time + 4
      return
    }
    case 'move': {
      if (!ok(msg.from) || !ok(msg.to) || msg.from === msg.to) return
      const a = inv[msg.from]
      const b = inv[msg.to]
      if (a && b && isStackable(a) && a.kind === b.kind && a.base === b.base) {
        const limit = stackLimit(b, p.stats)
        const n = Math.min(limit - b.qty, a.qty)
        b.qty += n
        a.qty -= n
        if (a.qty <= 0) inv[msg.from] = null
      } else {
        inv[msg.from] = b
        inv[msg.to] = a
      }
      p.charDirty = true
      return
    }
    case 'use': {
      if (!ok(msg.from)) return
      const item = inv[msg.from]
      if (!item) return
      if (item.kind === 'potion') return actions.drinkSlot(g, p, msg.from)
      if (item.kind === 'weapon' || item.kind === 'armor' || item.kind === 'implant') return equip(g, p, msg.from)
      return
    }
    case 'quick': {
      const slot = Number(msg.slot)
      if (!Number.isInteger(slot) || slot < 0 || slot >= QUICKBAR_SIZE) return
      const key = msg.key
      if (key !== null) {
        const [kind, base] = String(key).split(':')
        if (!((kind === 'potion' && POTIONS[base]) || (kind === 'grenade' && GRENADES[base]))) return
        const cur = p.char.quickbar.indexOf(key)
        if (cur >= 0) p.char.quickbar[cur] = p.char.quickbar[slot]
      }
      p.char.quickbar[slot] = key
      p.charDirty = true
      return
    }
    case 'grenade':
      if (GRENADES[msg.key]) {
        p.char.grenade = msg.key
        p.charDirty = true
      }
      return
  }
}

function equip(g: Game, p: Player, from: number) {
  const inv = p.char.inventory
  const item = inv[from]
  if (!item) return
  const eq = p.char.equipment
  if (item.kind === 'weapon' || item.kind === 'armor' || item.kind === 'implant') {
    if (item.level > p.char.level + 2) return g.toast(p, `You need level ${item.level - 2} to use that.`)
    if (item.kind === 'weapon') {
      const def = WEAPONS[item.base as WeaponType]
      if (!def) return
      if (def.minLevel > p.char.level) return g.toast(p, `${def.names[0][1]}s need level ${def.minLevel}.`)
    }
  }
  switch (item.kind) {
    case 'weapon': {
      const slot = p.char.active === 0 ? 'weapon' : 'weapon2'
      inv[from] = eq[slot]
      eq[slot] = item
      p.fireReady = Math.max(p.fireReady, g.time + 0.35)
      break
    }
    case 'armor':
      inv[from] = eq.armor
      eq.armor = item
      break
    case 'implant': {
      if (!IMPLANTS[item.base]) return
      if (eq.implants.some((x) => x?.base === item.base)) return g.toast(p, 'You already run that implant.')
      let slot = eq.implants.indexOf(null)
      if (slot < 0) slot = 0
      inv[from] = eq.implants[slot]
      eq.implants[slot] = item
      break
    }
    case 'potion':
      return actions.drinkSlot(g, p, from)
    default:
      return g.toast(p, "That can't be equipped.")
  }
  p.charDirty = true
  refreshStats(p)
  g.emit({ kind: 'toast', text: `Equipped ${item.name}.`, cls: 'equip' }, { to: p.id })
}

function unequip(g: Game, p: Player, slot: string) {
  const eq = p.char.equipment
  const inv = p.char.inventory
  const empty = inv.indexOf(null)
  if (empty < 0) return g.toast(p, 'Inventory full.')
  let item: Item | null = null
  if (slot === 'weapon' || slot === 'weapon2' || slot === 'armor') {
    item = eq[slot]
    eq[slot] = null
  } else if (/^implant[0-2]$/.test(slot)) {
    const i = Number(slot.slice(7))
    item = eq.implants[i] ?? null
    eq.implants[i] = null
  }
  if (!item) return
  inv[empty] = item
  p.charDirty = true
  refreshStats(p)
}

export function swapWeapon(g: Game, p: Player) {
  const next = p.char.active === 0 ? 1 : 0
  const other = next === 0 ? p.char.equipment.weapon : p.char.equipment.weapon2
  const cur = next === 0 ? p.char.equipment.weapon2 : p.char.equipment.weapon
  if (!other && !cur) return
  p.char.active = next
  p.fireReady = Math.max(p.fireReady, g.time + 0.3)
  p.charDirty = true
  refreshStats(p)
}

export function assignSpell(g: Game, p: Player, slot: number, id: string | null) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SPELL_SLOTS) return
  if (id !== null && !knownSpells(p.char.level, p.char.talents).includes(id)) return
  const spells = p.char.spells
  if (id !== null) {
    const cur = spells.indexOf(id)
    if (cur >= 0) spells[cur] = spells[slot]
  }
  spells[slot] = id
  p.charDirty = true
}

export function learnTalent(g: Game, p: Player, id: string) {
  const why = talentBlocker(p.char.talents, p.char.level, id)
  if (why) return g.toast(p, why)
  const before = knownSpells(p.char.level, p.char.talents)
  p.char.talents[id] = (p.char.talents[id] ?? 0) + 1
  for (const s of knownSpells(p.char.level, p.char.talents)) if (!before.includes(s)) autoSlot(p, s)
  p.charDirty = true
  refreshStats(p)
  g.emit({ kind: 'toast', text: `Learned ${TALENT_BY_ID[id].name} (rank ${p.char.talents[id]}).`, cls: 'talent' }, { to: p.id })
}

export function respec(g: Game, p: Player) {
  if (p.hub < 0) return g.toast(p, 'Talents can only be reset inside a hub.')
  if (!Object.keys(p.char.talents).length) return g.toast(p, 'You have no talents to reset.')
  const cost = respecCost(p.char.level)
  if (p.char.credits < cost) return g.toast(p, `Resetting your talents costs ${cost} credits.`)
  p.char.credits -= cost
  p.char.talents = {}
  const known = knownSpells(p.char.level, {})
  p.char.spells = p.char.spells.map((s) => (s && known.includes(s) ? s : null))
  p.charDirty = true
  refreshStats(p)
  g.toast(p, `Talents reset for ${cost} credits. Spend your points again.`, 'talent')
}

// --- The black market -------------------------------------------------------------------------------------
export function shopStock(g: Game, p: Player, hubId: string): ShopEntry[] {
  const hub = g.world.hubs.find((h) => h.id === hubId)
  if (!hub) return []
  const window = Math.floor(Date.now() / SHOP_WINDOW_MS)
  if (p.boughtWindow !== window) {
    p.boughtWindow = window
    p.bought.clear()
  }
  const [lo, hi] = SECTOR_LEVELS[hub.sector]
  const level = clamp(p.char.level, lo, hi + 3)
  const rand = mulberry32(hashString(`${g.seed}:${hubId}:${window}:${level}`))
  const disc = 1 - p.stats.shopDiscount
  const entries: ShopEntry[] = []
  const add = (id: string, item: Item, price: number) => {
    if (!p.bought.has(id)) entries.push({ id, item, price: Math.max(1, Math.round(price * disc)) })
  }
  const potions = hub.sector >= 1 ? ['repair_s', 'repair_m', 'repair_l', 'energy'] : ['repair_s', 'repair_m', 'energy']
  for (const k of potions) add(`potion:${k}`, makePotion(k, 1, `shop-${k}`), POTIONS[k].value)
  for (const k of GRENADE_KINDS) add(`grenade:${k}`, makeGrenade(k, 1, `shop-${k}`), GRENADES[k].value)
  const types = WEAPON_TYPES.filter((t) => WEAPONS[t].minLevel <= level)
  for (let i = 0; i < 5; i++) {
    const rarity = 1 + Math.floor(rand() * 2.6)
    const item = i < 3 ? makeWeapon(rand, pick(rand, types), level, rarity, `shop-g${i}`) : makeArmor(rand, level, rarity, `shop-g${i}`)
    add(`gear:${i}`, item, itemValue(item))
  }
  if (rand() < 0.6) {
    const options = IMPLANT_IDS.filter((k) => IMPLANTS[k].level <= level + 2)
    const item = makeImplant(pick(rand, options), 'shop-implant')
    add('implant', item, itemValue(item))
  }
  return entries
}

export function shopAction(g: Game, p: Player, msg: Extract<ClientMsg, { t: 'shop' }>) {
  if (p.hub < 0) return g.toast(p, 'The black market only trades inside hubs.')
  const hubId = g.world.hubs[p.hub].id
  if (msg.op === 'buy') {
    const entry = shopStock(g, p, hubId).find((e) => e.id === msg.id)
    if (!entry) return g.toast(p, 'That is no longer for sale.')
    if (p.char.credits < entry.price) return g.toast(p, 'Not enough credits.')
    const item: Item = { ...entry.item, id: freshItemId(g), affixes: entry.item.affixes.map((a) => ({ ...a })) }
    if (!giveItem(g, p, item)) return g.toast(p, 'Inventory full.')
    p.char.credits -= entry.price
    if (entry.id.startsWith('gear:') || entry.id === 'implant') p.bought.add(entry.id)
    p.charDirty = true
    g.emit({ kind: 'shop', what: 'buy', name: itemLabel(g, item) }, { to: p.id })
    g.send(p, { t: 'shop', hub: hubId, stock: shopStock(g, p, hubId) })
    return
  }
  const from = Number(msg.from)
  const item = p.char.inventory[from]
  if (!Number.isInteger(from) || !item) return
  if (item.kind === 'keycard' || item.kind === 'datacore') return g.toast(p, "The black market won't touch that.")
  const one: Item = isStackable(item) ? { ...item, qty: 1 } : item
  const price = Math.max(1, sellPrice(one))
  if (isStackable(item) && item.qty > 1) item.qty -= 1
  else p.char.inventory[from] = null
  p.char.credits += price
  p.charDirty = true
  g.emit({ kind: 'shop', what: 'sell', name: `${itemLabel(g, one)} for ${price} credits` }, { to: p.id })
  if (p.char.credits >= 10000) grant(g, p, 'rich')
}
