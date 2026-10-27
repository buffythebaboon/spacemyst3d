// Everything the client knows about the game, as last told by the server.
import { computeStats, type CharacterData, type Stats } from '../../shared/character.ts'
import { Grid } from '../../shared/grid.ts'
import { GRENADES, IMPLANTS, POTION_COLORS, POTIONS, potionName, type Item } from '../../shared/items.ts'
import type { LootNet, MonsterNet, PlayerNet, ProjNet, YouNet, ZoneNet } from '../../shared/protocol.ts'
import type { DailyDef } from '../../shared/quests.ts'
import { knownSpells } from '../../shared/spells.ts'
import type { Vault, WorldInfo, WorldObject, WorldState } from '../../shared/world.ts'
import { icon, potionIcon } from './art/icons.ts'

export const S = {
  myId: '',
  guest: false,
  playing: false,
  world: null as WorldInfo | null,
  grid: null as Grid | null,
  state: null as WorldState | null,
  char: null as CharacterData | null,
  stats: null as Stats | null,
  you: null as YouNet | null,
  colors: {} as Record<string, number>,
  identified: new Set<string>(),
  daily: [] as DailyDef[],
  players: new Map<string, PlayerNet>(),
  monsters: new Map<number, MonsterNet>(),
  proj: [] as ProjNet[],
  zones: [] as ZoneNet[],
  loot: [] as LootNet[],
  objects: new Map<string, WorldObject>(),
  vaults: new Map<string, Vault>(),
  /** Server simulation time at the last snapshot, and when it arrived (performance.now seconds). */
  serverTime: 0,
  snapAt: 0,
}

export const now = () => performance.now() / 1000

/** Best guess of the server's simulation time right now. */
export const serverNow = () => S.serverTime + (now() - S.snapAt)

export function setWorld(world: WorldInfo, state: WorldState) {
  S.world = world
  S.grid = new Grid(world)
  S.objects = new Map(world.objects.map((o) => [o.id, o]))
  S.vaults = new Map(world.vaults.map((v) => [v.id, v]))
  setState(state)
}

export function setState(state: WorldState) {
  S.state = state
  S.grid?.applyState(state)
}

export function setChar(char: CharacterData) {
  S.char = char
  S.stats = computeStats(char)
}

export const me = () => S.players.get(S.myId) ?? null

export function knownSpellIds() {
  return S.char ? knownSpells(S.char.level, S.char.talents) : []
}

// --- Items ---------------------------------------------------------------------------------------
export const potionKnown = (kind: string) => S.identified.has(kind)

/** The name a player sees: unidentified potions only show their colour. */
export function itemName(item: Item) {
  if (item.kind === 'potion') return potionName(item.base, S.colors[item.base] ?? 0, potionKnown(item.base))
  return item.name
}

export function potionCss(kind: string) {
  return POTION_COLORS[S.colors[kind] ?? 0]?.css ?? '#ffffff'
}

/** Icon data URL for an item. */
export function itemIcon(item: Pick<Item, 'kind' | 'base'>) {
  switch (item.kind) {
    case 'weapon':
      return icon(`weapon:${item.base}`)
    case 'armor':
      return icon(`armor:${item.base}`)
    case 'implant':
      return icon(`implant:${item.base}`)
    case 'potion':
      return potionIcon(potionCss(item.base), { unknown: !potionKnown(item.base) })
    case 'grenade':
      return icon(`item:grenade_${item.base}`)
    case 'keycard':
      return icon('item:keycard')
    case 'datacore':
      return icon('item:datacore')
    default:
      return icon('item:credits')
  }
}

/** Icon for a quickbar stack key such as "potion:repair_s". */
export function stackIcon(key: string) {
  const [kind, base] = key.split(':')
  return itemIcon({ kind: kind as Item['kind'], base })
}

export function stackName(key: string) {
  const [kind, base] = key.split(':')
  if (kind === 'potion' && POTIONS[base]) return potionName(base, S.colors[base] ?? 0, potionKnown(base))
  if (kind === 'grenade' && GRENADES[base]) return GRENADES[base].name
  if (kind === 'implant' && IMPLANTS[base]) return IMPLANTS[base].name
  return base
}

export function stackCount(key: string) {
  if (!S.char) return 0
  return S.char.inventory.reduce((n, it) => (it && `${it.kind}:${it.base}` === key ? n + it.qty : n), 0)
}

// --- Persistence of small client settings ----------------------------------------------------------
export interface Settings {
  master: number
  music: number
  sfx: number
  sensitivity: number
  fov: number
  invertY: boolean
  bloom: boolean
  quality: number
  showFps: boolean
}

const DEFAULTS: Settings = { master: 0.8, music: 0.6, sfx: 0.8, sensitivity: 1, fov: 75, invertY: false, bloom: true, quality: 1, showFps: false }

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('spacemyst.settings')
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    /* storage may be unavailable */
  }
  return { ...DEFAULTS }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem('spacemyst.settings', JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

export const settings = loadSettings()
