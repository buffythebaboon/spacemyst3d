// Items: weapons, armour, implants, potions, grenades and key items, plus loot rolls.
import { SECTOR_NAMES } from './constants.ts'
import type { DamageType } from './monsters.ts'
import { hashString, mulberry32, pick, randInt, shuffle, weighted, type Rand } from './rng.ts'

export type ItemKind = 'weapon' | 'armor' | 'implant' | 'potion' | 'grenade' | 'keycard' | 'datacore'
export type WeaponType = 'laser' | 'blade' | 'plasma' | 'railgun' | 'cannon' | 'horizon'
export type StatKey =
  | 'damage'
  | 'fireRate'
  | 'critChance'
  | 'critDamage'
  | 'burnChance'
  | 'leech'
  | 'manaOnKill'
  | 'spellPower'
  | 'maxHp'
  | 'armorPct'
  | 'maxMana'
  | 'manaRegen'
  | 'moveSpeed'
  | 'resistLaser'
  | 'resistEmp'
  | 'resistHeat'
  | 'dashCdr'
  | 'cdr'

export interface Affix {
  stat: StatKey
  value: number
}

export interface Item {
  id: string
  kind: ItemKind
  /** Weapon type, armour tier, implant id, potion or grenade kind, keycard sector or quest id. */
  base: string
  level: number
  rarity: number
  qty: number
  affixes: Affix[]
  /** Legendary power: an implant effect built into the item. */
  power?: string
  name: string
}

export const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'] as const
export const RARITY_COLORS = ['#c8d2dc', '#5cff7a', '#4fa8ff', '#c77dff', '#ffa63c'] as const
const RARITY_MULT = [1, 1.1, 1.2, 1.32, 1.45]
const RARITY_VALUE = [1, 2, 4, 9, 20]

/** Gear power grows at the same rate as monster health. */
export const gearScale = (level: number) => Math.pow(1.12, level - 1)

// --- Affixes -----------------------------------------------------------------------------
interface StatInfo {
  label: string
  pct: boolean
  weapon?: [number, number]
  armor?: [number, number]
  /** Flat stats grow with item level. */
  scales?: boolean
  prefix: string
}

export const STATS: Record<StatKey, StatInfo> = {
  damage: { label: 'Weapon damage', pct: true, weapon: [8, 20], prefix: 'Overclocked' },
  fireRate: { label: 'Fire rate', pct: true, weapon: [5, 12], prefix: 'Rapid' },
  critChance: { label: 'Critical chance', pct: true, weapon: [2, 6], prefix: 'Precise' },
  critDamage: { label: 'Critical damage', pct: true, weapon: [15, 40], prefix: 'Brutal' },
  burnChance: { label: 'Burn chance', pct: true, weapon: [5, 12], prefix: 'Searing' },
  leech: { label: 'Damage returned as HP', pct: true, weapon: [1, 3], prefix: 'Vampiric' },
  manaOnKill: { label: 'Mana per kill', pct: false, weapon: [2, 5], prefix: 'Siphoning' },
  spellPower: { label: 'Spell power', pct: true, weapon: [6, 15], armor: [5, 12], prefix: 'Resonant' },
  maxHp: { label: 'Max HP', pct: false, armor: [8, 24], scales: true, prefix: 'Fortified' },
  armorPct: { label: 'Armour', pct: true, armor: [8, 20], prefix: 'Hardened' },
  maxMana: { label: 'Max mana', pct: false, armor: [6, 18], scales: true, prefix: 'Buffered' },
  manaRegen: { label: 'Mana per second', pct: false, armor: [0.5, 1.5], prefix: 'Cycling' },
  moveSpeed: { label: 'Move speed', pct: true, armor: [3, 8], prefix: 'Nimble' },
  resistLaser: { label: 'Laser resistance', pct: true, armor: [8, 20], prefix: 'Mirrored' },
  resistEmp: { label: 'EMP resistance', pct: true, armor: [8, 20], prefix: 'Grounded' },
  resistHeat: { label: 'Heat resistance', pct: true, armor: [8, 20], prefix: 'Insulated' },
  dashCdr: { label: 'Dash cooldown reduction', pct: true, armor: [8, 20], prefix: 'Agile' },
  cdr: { label: 'Spell cooldown reduction', pct: true, armor: [4, 10], prefix: 'Efficient' },
}

export function formatAffix(a: Affix) {
  const info = STATS[a.stat]
  const v = Number.isInteger(a.value) ? a.value : a.value.toFixed(1)
  return `+${v}${info.pct ? '%' : ''} ${info.label}`
}

function rollAffixes(rand: Rand, slot: 'weapon' | 'armor', level: number, count: number): Affix[] {
  const pool = (Object.keys(STATS) as StatKey[]).filter((k) => STATS[k][slot])
  return shuffle(rand, pool)
    .slice(0, count)
    .map((stat) => {
      const [lo, hi] = STATS[stat][slot]!
      let value = lo + rand() * (hi - lo)
      if (STATS[stat].scales) value *= 1 + level / 10
      value = stat === 'manaRegen' ? Math.round(value * 10) / 10 : Math.round(value)
      return { stat, value }
    })
}

// --- Weapons -------------------------------------------------------------------------------
export interface WeaponDef {
  type: WeaponType
  /** Names by minimum item level. */
  names: [number, string][]
  damage: number
  interval: number
  range: number
  dtype: DamageType
  mode: 'hitscan' | 'melee' | 'beam' | 'charge' | 'projectile'
  speed?: number
  radius?: number
  /** Melee half-angle in radians. */
  arc?: number
  /** Seconds to reach full charge. */
  charge?: number
  burn?: number
  minLevel: number
  color: string
  desc: string
}

export const WEAPONS: Record<WeaponType, WeaponDef> = {
  laser: {
    type: 'laser',
    names: [[1, 'Laser Scalpel']],
    damage: 8,
    interval: 0.22,
    range: 45,
    dtype: 'laser',
    mode: 'hitscan',
    minLevel: 1,
    color: '#5cf2ff',
    desc: 'Fast, precise laser. Hold to keep firing.',
  },
  blade: {
    type: 'blade',
    names: [
      [1, 'Carbon Knife'],
      [8, 'Quantum Blade'],
    ],
    damage: 20,
    interval: 0.42,
    range: 3.3,
    dtype: 'laser',
    mode: 'melee',
    arc: 0.7,
    minLevel: 1,
    color: '#c8f0ff',
    desc: 'Close-range slash that hits everything in front of you.',
  },
  plasma: {
    type: 'plasma',
    names: [[1, 'Plasma Cutter']],
    damage: 4.5,
    interval: 0.1,
    range: 13,
    dtype: 'heat',
    mode: 'beam',
    burn: 0.12,
    minLevel: 3,
    color: '#ff8a3c',
    desc: 'Short searing beam that sets programs on fire.',
  },
  railgun: {
    type: 'railgun',
    names: [[1, 'Railgun Emitter']],
    damage: 48,
    interval: 0.85,
    range: 70,
    dtype: 'laser',
    mode: 'charge',
    charge: 0.8,
    minLevel: 5,
    color: '#9fb7ff',
    desc: 'Hold to charge, release to fire a slug that pierces every program in a line.',
  },
  cannon: {
    type: 'cannon',
    names: [[1, 'Neutron Cannon']],
    damage: 38,
    interval: 1.0,
    range: 60,
    dtype: 'heat',
    mode: 'projectile',
    speed: 24,
    radius: 3,
    minLevel: 7,
    color: '#ffd34d',
    desc: 'Slow shells that explode on impact and hurt everything nearby.',
  },
  horizon: {
    type: 'horizon',
    names: [[1, 'Event Horizon Projector']],
    damage: 46,
    interval: 2.2,
    range: 50,
    dtype: 'emp',
    mode: 'projectile',
    speed: 11,
    radius: 5,
    minLevel: 10,
    color: '#c77dff',
    desc: 'Fires a tiny black hole that drags programs together before it collapses.',
  },
}
export const WEAPON_TYPES = Object.keys(WEAPONS) as WeaponType[]

const LEGENDARY_WEAPONS: Record<WeaponType, { name: string; power: string }> = {
  laser: { name: "Theseus' Scalpel", power: 'ricochet' },
  blade: { name: 'Monomolecular Edge', power: 'vampire' },
  plasma: { name: 'Sunforge', power: 'thermal' },
  railgun: { name: 'Lance of Longinus', power: 'crit' },
  cannon: { name: 'Neutron Star', power: 'siphon' },
  horizon: { name: "Hawking's Regret", power: 'extender' },
}

export function weaponBaseName(type: WeaponType, level: number) {
  const names = WEAPONS[type].names
  let name = names[0][1]
  for (const [min, n] of names) if (level >= min) name = n
  return name
}

/** Damage per hit of a weapon item, before character bonuses. */
export function weaponDamage(item: Item) {
  const def = WEAPONS[item.base as WeaponType]
  return def.damage * gearScale(item.level) * RARITY_MULT[item.rarity]
}

// --- Armour ---------------------------------------------------------------------------------
export const ARMOR_TIERS = [
  { name: 'Reinforced Weave', level: 1, defense: 4 },
  { name: 'Plasteel Vest', level: 3, defense: 7 },
  { name: 'Ceramic Plates', level: 5, defense: 10 },
  { name: 'Aegis Overlay', level: 8, defense: 14 },
  { name: 'Forcefield Generator', level: 11, defense: 19 },
  { name: 'Dark Matter Weave', level: 14, defense: 26 },
  { name: 'Void Shell', level: 17, defense: 35 },
]

export function armorTierFor(level: number) {
  let tier = 0
  ARMOR_TIERS.forEach((t, i) => level >= t.level && (tier = i))
  return tier
}

export function armorDefense(item: Item) {
  return Math.round(ARMOR_TIERS[Number(item.base)].defense * RARITY_MULT[item.rarity])
}

/** Damage taken is multiplied by this for a given defence value. */
export const defenseFactor = (defense: number) => 1 - defense / (defense + 30)

// --- Implants -------------------------------------------------------------------------------
export const IMPLANTS: Record<string, { name: string; desc: string; rarity: number; level: number }> = {
  ricochet: { name: 'Ricochet Driver', desc: 'Hitscan shots bounce off one wall.', rarity: 2, level: 4 },
  siphon: { name: 'Mana Siphon', desc: 'Kills restore 4% of your max mana.', rarity: 1, level: 1 },
  mine: { name: 'Glitch Mine', desc: 'Glitch Step leaves a bomb where you started.', rarity: 2, level: 3 },
  capacitor: { name: 'Capacitor Bank', desc: '+20% max mana.', rarity: 1, level: 1 },
  nanoweave: { name: 'Nanoweave Lining', desc: '+15% max HP.', rarity: 1, level: 1 },
  vampire: { name: 'Vampire Routine', desc: '3% of weapon damage heals you.', rarity: 3, level: 6 },
  thermal: { name: 'Thermal Injector', desc: 'Your hits have a 15% chance to set programs on fire.', rarity: 2, level: 3 },
  emp_coil: { name: 'EMP Coil', desc: 'Taking a hit may release an EMP pulse that stuns nearby machines.', rarity: 2, level: 5 },
  adrenal: { name: 'Adrenal Spike', desc: 'Below 30% HP: +25% move speed and fire rate.', rarity: 2, level: 4 },
  extender: { name: 'Field Extender', desc: 'Spell durations and areas are 25% larger.', rarity: 3, level: 7 },
  crit: { name: 'Targeting Lens', desc: '+8% critical chance and +25% critical damage.', rarity: 2, level: 5 },
  scavenger: { name: 'Scavenger Module', desc: '+30% credits and 15% more loot.', rarity: 1, level: 2 },
}
export const IMPLANT_IDS = Object.keys(IMPLANTS)

// --- Potions and grenades ------------------------------------------------------------------
export interface PotionDef {
  name: string
  desc: string
  good: boolean
  /** Weight in loot rolls. */
  weight: number
  value: number
}

export const POTIONS: Record<string, PotionDef> = {
  repair_s: { name: 'Small Repair Potion', desc: 'Restores 25% HP over 2 seconds.', good: true, weight: 30, value: 40 },
  repair_m: { name: 'Repair Potion', desc: 'Restores 50% HP over 2 seconds.', good: true, weight: 18, value: 90 },
  repair_l: { name: 'Large Repair Potion', desc: 'Restores 80% HP over 2 seconds.', good: true, weight: 7, value: 180 },
  energy: { name: 'Energy Cell', desc: 'Restores half of your mana.', good: true, weight: 18, value: 60 },
  overclock: { name: 'Overclock Tonic', desc: 'Faster shots and movement for 10 seconds.', good: true, weight: 8, value: 120 },
  firewall: { name: 'Firewall Elixir', desc: 'Halves the damage you take for 8 seconds.', good: true, weight: 8, value: 120 },
  encryption: { name: 'Encryption Draught', desc: 'Monsters cannot see you for 6 seconds, or until you attack.', good: true, weight: 7, value: 110 },
  scanner: { name: 'Scanner Draught', desc: 'See monsters and items through walls for 15 seconds.', good: true, weight: 7, value: 90 },
  acid: { name: 'Vial of Acid', desc: 'Throw it: an acid pool that eats through programs. Drinking it hurts.', good: false, weight: 10, value: 70 },
  toxic: { name: 'Toxic Sludge', desc: 'Throw it: a toxic cloud that poisons and slows. Drinking it hurts.', good: false, weight: 10, value: 70 },
}
export const POTION_KINDS = Object.keys(POTIONS)

export const POTION_COLORS = [
  { name: 'Sparkling', css: '#e8f7ff' },
  { name: 'Blue', css: '#3c7bff' },
  { name: 'Orange', css: '#ff9a3c' },
  { name: 'Cyan', css: '#5cf2ff' },
  { name: 'Metallic', css: '#9aa8b8' },
  { name: 'White', css: '#f4f4f4' },
  { name: 'Pink', css: '#ff6fcf' },
  { name: 'Tan', css: '#c8a878' },
  { name: 'Yellow', css: '#ffe14f' },
  { name: 'Murky', css: '#6b7d3c' },
]

/** Which bottle colour each potion kind has this season. */
export function potionColors(season: number): Record<string, number> {
  const rand = mulberry32(hashString(`potions-${season}`))
  const order = shuffle(rand, POTION_COLORS.map((_, i) => i))
  return Object.fromEntries(POTION_KINDS.map((k, i) => [k, order[i]]))
}

export function potionName(kind: string, color: number, identified: boolean) {
  const look = POTION_COLORS[color]?.name ?? 'Strange'
  return identified ? `${POTIONS[kind].name} (${look})` : `${look} Potion`
}

export const GRENADES: Record<string, { name: string; desc: string; radius: number; value: number }> = {
  emp: { name: 'EMP Grenade', desc: 'Stuns machines for 3 seconds, strips shields and reveals phantoms.', radius: 5, value: 80 },
  glitch: { name: 'Glitch Bomb', desc: 'A burst of corrupted data that shreds everything nearby.', radius: 4.5, value: 110 },
  noise: { name: 'Noise Cloud', desc: 'A cloud of static. Monsters lose track of anyone inside it.', radius: 5, value: 70 },
}
export const GRENADE_KINDS = Object.keys(GRENADES)
export const GRENADE_FUSE = 1.2

export const STACK_MAX = 5

// --- Item helpers ---------------------------------------------------------------------------
export const stackKey = (item: Item) =>
  item.kind === 'potion' || item.kind === 'grenade' || item.kind === 'keycard' || item.kind === 'datacore' ? `${item.kind}:${item.base}` : null

export function isStackable(item: Item) {
  return item.kind === 'potion' || item.kind === 'grenade'
}

let fallbackId = 0
const newId = () => `i${Date.now().toString(36)}${(fallbackId++).toString(36)}`

export function makeWeapon(rand: Rand, type: WeaponType, level: number, rarity: number, id = newId()): Item {
  const affixes = rarity === 0 ? [] : rollAffixes(rand, 'weapon', level, Math.min(4, rarity === 4 ? 3 : rarity))
  const base = weaponBaseName(type, level)
  let name = base
  let power: string | undefined
  if (rarity === 4) {
    name = LEGENDARY_WEAPONS[type].name
    power = LEGENDARY_WEAPONS[type].power
  } else if (affixes.length) name = `${STATS[affixes[0].stat].prefix} ${base}`
  return { id, kind: 'weapon', base: type, level, rarity, qty: 1, affixes, power, name }
}

const LEGENDARY_ARMOR = ['Aegis of the Last Admin', 'Mantle of Root', 'Exoskeleton Zero']
const LEGENDARY_ARMOR_POWERS = ['nanoweave', 'adrenal', 'emp_coil']

export function makeArmor(rand: Rand, level: number, rarity: number, id = newId(), tier = armorTierFor(level)): Item {
  const affixes = rarity === 0 ? [] : rollAffixes(rand, 'armor', level, rarity === 4 ? 3 : rarity)
  const base = ARMOR_TIERS[tier].name
  let name = base
  let power: string | undefined
  if (rarity === 4) {
    const k = randInt(rand, 0, LEGENDARY_ARMOR.length - 1)
    name = LEGENDARY_ARMOR[k]
    power = LEGENDARY_ARMOR_POWERS[k]
  } else if (affixes.length) name = `${STATS[affixes[0].stat].prefix} ${base}`
  return { id, kind: 'armor', base: String(tier), level, rarity, qty: 1, affixes, power, name }
}

export function makeImplant(implant: string, id = newId()): Item {
  const def = IMPLANTS[implant]
  return { id, kind: 'implant', base: implant, level: def.level, rarity: def.rarity, qty: 1, affixes: [], name: def.name }
}

export function makePotion(kind: string, qty = 1, id = newId()): Item {
  return { id, kind: 'potion', base: kind, level: 1, rarity: 0, qty, affixes: [], name: POTIONS[kind].name }
}

export function makeGrenade(kind: string, qty = 1, id = newId()): Item {
  return { id, kind: 'grenade', base: kind, level: 1, rarity: 0, qty, affixes: [], name: GRENADES[kind].name }
}

export function makeKeycard(sector: number, id = newId()): Item {
  return { id, kind: 'keycard', base: String(sector), level: 1, rarity: 3, qty: 1, affixes: [], name: `${SECTOR_NAMES[sector]} Keycard` }
}

export function makeDatacore(questId: string, id = newId()): Item {
  return { id, kind: 'datacore', base: questId, level: 1, rarity: 2, qty: 1, affixes: [], name: 'Lost Data Core' }
}

/** Rarity roll; bonus shifts the odds towards better items (elites, bosses, vaults). */
export function rollRarity(rand: Rand, bonus = 0) {
  const w = [70, 22, 6, 1.6, 0.4]
  const shifted = w.map((x, i) => x * Math.pow(1 + bonus, i))
  return weighted(
    rand,
    [0, 1, 2, 3, 4],
    (i) => shifted[i],
  )
}

/** A random piece of gear for a given item level. */
export function rollGear(rand: Rand, level: number, rarityBonus = 0): Item {
  const rarity = rollRarity(rand, rarityBonus)
  const r = rand()
  if (r < 0.15 && level >= 3) {
    const options = IMPLANT_IDS.filter((k) => IMPLANTS[k].level <= level + 2)
    return makeImplant(pick(rand, options))
  }
  if (r < 0.55) {
    const types = WEAPON_TYPES.filter((t) => WEAPONS[t].minLevel <= level + 1)
    return makeWeapon(rand, pick(rand, types), level, rarity)
  }
  return makeArmor(rand, level, rarity)
}

export function rollPotion(rand: Rand) {
  return weighted(rand, POTION_KINDS, (k) => POTIONS[k].weight)
}

export function itemValue(item: Item): number {
  switch (item.kind) {
    case 'potion':
      return POTIONS[item.base].value * item.qty
    case 'grenade':
      return GRENADES[item.base].value * item.qty
    case 'implant':
      return 250 * RARITY_VALUE[item.rarity]
    case 'weapon':
    case 'armor':
      return Math.round(25 * Math.pow(gearScale(item.level), 0.9) * RARITY_VALUE[item.rarity])
    default:
      return 0
  }
}

/** Credits the black market pays for an item. */
export const sellPrice = (item: Item) => Math.floor(itemValue(item) * 0.3)

/** Tooltip lines (no name) describing an item. */
export function itemLines(item: Item): string[] {
  const lines: string[] = []
  switch (item.kind) {
    case 'weapon': {
      const def = WEAPONS[item.base as WeaponType]
      const dmg = weaponDamage(item)
      const dps = def.mode === 'charge' ? dmg / (def.interval + (def.charge ?? 0)) : dmg / def.interval
      lines.push(`${RARITY_NAMES[item.rarity]} ${weaponBaseName(item.base as WeaponType, item.level)} · Level ${item.level}`)
      lines.push(`${Math.round(dmg)} ${def.dtype} damage · ${Math.round(dps)} per second`)
      lines.push(def.desc)
      break
    }
    case 'armor':
      lines.push(`${RARITY_NAMES[item.rarity]} ${ARMOR_TIERS[Number(item.base)].name} · Level ${item.level}`)
      lines.push(`${armorDefense(item)} defence (${Math.round((1 - defenseFactor(armorDefense(item))) * 100)}% less damage)`)
      break
    case 'implant':
      lines.push(`${RARITY_NAMES[item.rarity]} implant`)
      lines.push(IMPLANTS[item.base].desc)
      break
    case 'grenade':
      lines.push(GRENADES[item.base].desc)
      break
    case 'keycard':
      lines.push(`Opens the keycard vault in the ${SECTOR_NAMES[Number(item.base)]}.`)
      break
    case 'datacore':
      lines.push('A quest item. It completes the quest when you pick it up.')
      break
  }
  for (const a of item.affixes) lines.push(formatAffix(a))
  if (item.power) lines.push(`Legendary: ${IMPLANTS[item.power].desc}`)
  return lines
}

