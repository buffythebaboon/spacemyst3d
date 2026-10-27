// The saved character and the stats derived from level, talents and gear.
import {
  BASE_MANA_REGEN,
  DASH_COOLDOWN,
  IMPLANT_SLOTS,
  INVENTORY_SIZE,
  QUICKBAR_SIZE,
  SPELL_SLOTS,
  clamp,
  hpForLevel,
  manaForLevel,
} from './constants.ts'
import {
  STACK_MAX,
  WEAPONS,
  armorDefense,
  defenseFactor,
  makeArmor,
  makeGrenade,
  makePotion,
  makeWeapon,
  type Item,
  type StatKey,
  type WeaponType,
} from './items.ts'
import type { DamageType } from './monsters.ts'
import { mulberry32 } from './rng.ts'
import type { QuestState } from './quests.ts'

export interface Equipment {
  weapon: Item | null
  weapon2: Item | null
  armor: Item | null
  implants: (Item | null)[]
}

export interface DailyState {
  date: string
  progress: number[]
  done: boolean[]
}

export interface CharacterData {
  name: string
  level: number
  xp: number
  credits: number
  inventory: (Item | null)[]
  equipment: Equipment
  /** 0 = primary weapon, 1 = secondary. */
  active: 0 | 1
  /** Stack keys such as "potion:repair_s". */
  quickbar: (string | null)[]
  spells: (string | null)[]
  talents: Record<string, number>
  /** Hubs this character has found (for fast travel). */
  hubs: string[]
  respawnHub: string
  /** Data fragments found, by index. */
  codex: number[]
  achievements: string[]
  counters: Record<string, number>
  /** Kills per monster key. */
  bestiary: Record<string, number>
  quests: QuestState[]
  daily: DailyState
  /** Season the per-season fields below belong to. */
  season: number
  /** Chests (object ids) this character has opened this season. */
  chests: string[]
  /** Preferred grenade for the G key. */
  grenade: string
  created: number
}

export function newCharacter(name: string, season: number): CharacterData {
  const rand = mulberry32(Date.now() & 0xffffffff)
  const inventory: (Item | null)[] = new Array(INVENTORY_SIZE).fill(null)
  inventory[0] = makePotion('repair_s', 3)
  inventory[1] = makePotion('energy', 1)
  inventory[2] = makeGrenade('emp', 2)
  return {
    name,
    level: 1,
    xp: 0,
    credits: 60,
    inventory,
    equipment: {
      weapon: makeWeapon(rand, 'laser', 1, 0),
      weapon2: makeWeapon(rand, 'blade', 1, 0),
      armor: makeArmor(rand, 1, 0),
      implants: new Array(IMPLANT_SLOTS).fill(null),
    },
    active: 0,
    quickbar: ['potion:repair_s', 'potion:repair_m', 'potion:energy', null].slice(0, QUICKBAR_SIZE),
    spells: ['overload', 'repair', null, null].slice(0, SPELL_SLOTS),
    talents: {},
    hubs: ['hub0'],
    respawnHub: 'hub0',
    codex: [],
    achievements: [],
    counters: {},
    bestiary: {},
    quests: [],
    daily: { date: '', progress: [], done: [] },
    season,
    chests: [],
    grenade: 'emp',
    created: Date.now(),
  }
}

/** Fills in fields added after a character was saved, so old saves keep loading. */
export function migrateCharacter(c: Partial<CharacterData> & { name: string }, season: number): CharacterData {
  const base = newCharacter(c.name, season)
  const merged = { ...base, ...c } as CharacterData
  merged.equipment = { ...base.equipment, ...(c.equipment ?? {}) }
  while (merged.equipment.implants.length < IMPLANT_SLOTS) merged.equipment.implants.push(null)
  while (merged.inventory.length < INVENTORY_SIZE) merged.inventory.push(null)
  while (merged.quickbar.length < QUICKBAR_SIZE) merged.quickbar.push(null)
  while (merged.spells.length < SPELL_SLOTS) merged.spells.push(null)
  if (merged.season !== season) {
    // A new season: the world changed, so per-season progress resets.
    merged.season = season
    merged.chests = []
    merged.quests = merged.quests.filter((q) => q.kind !== 'fetch')
  }
  return merged
}

export const activeWeapon = (c: CharacterData) => (c.active === 0 ? c.equipment.weapon : c.equipment.weapon2)

export interface Stats {
  maxHp: number
  maxMana: number
  manaRegen: number
  defense: number
  /** Multiplier on incoming damage from armour. */
  armorFactor: number
  /** Multiplier on incoming damage per type. */
  resist: Record<DamageType, number>
  moveSpeed: number
  fireRate: number
  damage: number
  critChance: number
  critDamage: number
  burnChance: number
  burnDamage: number
  leech: number
  manaOnKill: number
  manaOnKillPct: number
  hpOnKillPct: number
  spellPower: number
  spellCost: number
  cdr: number
  dashCooldown: number
  grenadeMax: number
  grenadeDamage: number
  creditMult: number
  lootMult: number
  shopDiscount: number
  overkill: number
  chainBonus: number
  chainDamage: number
  firewallBonus: number
  /** Multiplier on spell durations and areas. */
  extender: number
  /** Implant effects, from implants and legendary items. */
  powers: string[]
}

export function computeStats(c: CharacterData): Stats {
  const t = (id: string) => c.talents[id] ?? 0
  const affix: Partial<Record<StatKey, number>> = {}
  const powers = new Set<string>()
  const weapon = activeWeapon(c)
  const gear = [weapon, c.equipment.armor, ...c.equipment.implants]
  for (const item of gear) {
    if (!item) continue
    for (const a of item.affixes) affix[a.stat] = (affix[a.stat] ?? 0) + a.value
    if (item.power) powers.add(item.power)
    if (item.kind === 'implant') powers.add(item.base)
  }
  const a = (k: StatKey) => affix[k] ?? 0
  const has = (p: string) => powers.has(p)

  const maxHp = Math.round((hpForLevel(c.level) * (1 + 0.08 * t('sd_chassis')) + a('maxHp')) * (has('nanoweave') ? 1.15 : 1))
  const maxMana = Math.round((manaForLevel(c.level) * (1 + 0.1 * t('hk_mana')) + a('maxMana')) * (has('capacitor') ? 1.2 : 1))
  const defense = c.equipment.armor ? Math.round(armorDefense(c.equipment.armor) * (1 + a('armorPct') / 100)) : 0
  const weaponBurn = weapon ? (WEAPONS[weapon.base as WeaponType].burn ?? 0) : 0
  return {
    maxHp,
    maxMana,
    manaRegen: BASE_MANA_REGEN + c.level * 0.1 + a('manaRegen'),
    defense,
    armorFactor: defenseFactor(defense),
    resist: {
      laser: 1 - clamp(a('resistLaser'), 0, 60) / 100,
      emp: 1 - clamp(a('resistEmp'), 0, 60) / 100,
      heat: 1 - clamp(a('resistHeat'), 0, 60) / 100,
      pure: 1,
    },
    moveSpeed: 1 + a('moveSpeed') / 100,
    fireRate: 1 + 0.05 * t('sd_rapid') + a('fireRate') / 100,
    damage: 1 + a('damage') / 100,
    critChance: clamp(0.05 + 0.03 * t('sd_aim') + a('critChance') / 100 + (has('crit') ? 0.08 : 0), 0, 0.75),
    critDamage: 1.75 + a('critDamage') / 100 + (has('crit') ? 0.25 : 0),
    burnChance: clamp(weaponBurn + 0.06 * t('en_thermal') + a('burnChance') / 100 + (has('thermal') ? 0.15 : 0), 0, 0.9),
    burnDamage: 1 + 0.2 * t('en_thermal'),
    leech: a('leech') / 100 + (has('vampire') ? 0.03 : 0),
    manaOnKill: a('manaOnKill'),
    manaOnKillPct: has('siphon') ? 0.04 : 0,
    hpOnKillPct: 0.03 * t('sd_blood'),
    spellPower: 1 + a('spellPower') / 100 + 0.1 * t('hk_root'),
    spellCost: 1 - 0.06 * t('hk_efficient'),
    cdr: clamp(a('cdr') / 100 + 0.1 * t('hk_root'), 0, 0.5),
    dashCooldown: DASH_COOLDOWN * (1 - 0.2 * t('sd_dash')) * (1 - clamp(a('dashCdr'), 0, 50) / 100),
    grenadeMax: STACK_MAX + t('en_grenadier'),
    grenadeDamage: 1 + 0.15 * t('en_grenadier'),
    creditMult: 1 + 0.1 * t('en_scrap') + (has('scavenger') ? 0.3 : 0),
    lootMult: has('scavenger') ? 1.15 : 1,
    shopDiscount: 0.05 * t('en_scrap'),
    overkill: 0.2 * t('sd_overkill'),
    chainBonus: t('hk_chain'),
    chainDamage: 1 + 0.1 * t('hk_chain'),
    firewallBonus: t('en_firewall'),
    extender: has('extender') ? 1.25 : 1,
    powers: [...powers],
  }
}

/** Max stack size for an item kind, given the character's stats. */
export function stackLimit(item: Item, stats: Stats) {
  if (item.kind === 'grenade') return stats.grenadeMax
  if (item.kind === 'potion') return STACK_MAX
  return 1
}

/** Finds the inventory slot holding a stack key ("potion:repair_s"). */
export function findStack(c: CharacterData, key: string) {
  return c.inventory.findIndex((it) => !!it && `${it.kind}:${it.base}` === key)
}

/** Total count of a stack key in the inventory. */
export function countStack(c: CharacterData, key: string) {
  return c.inventory.reduce((n, it) => (it && `${it.kind}:${it.base}` === key ? n + it.qty : n), 0)
}
