// Messages between the browser and the game server (JSON over WebSocket).
import type { CharacterData } from './character.ts'
import type { Item, ItemKind } from './items.ts'
import type { DamageType } from './monsters.ts'
import type { DailyDef, QuestState } from './quests.ts'
import type { WorldInfo, WorldState } from './world.ts'

// --- Statuses ------------------------------------------------------------------------------
export type StatusId =
  | 'burning'
  | 'slowed'
  | 'rooted'
  | 'corrupted'
  | 'memleak'
  | 'haste'
  | 'shielded'
  | 'stealth'
  | 'scanner'
  | 'regen'
  | 'pulled'
  | 'stunned'
  | 'asleep'
  | 'frozen'

/** Bit order for status masks in snapshots. */
export const STATUS_IDS: StatusId[] = [
  'burning',
  'slowed',
  'rooted',
  'corrupted',
  'memleak',
  'haste',
  'shielded',
  'stealth',
  'scanner',
  'regen',
  'pulled',
  'stunned',
  'asleep',
  'frozen',
]
export const statusBit = (s: StatusId) => 1 << STATUS_IDS.indexOf(s)
export const hasStatus = (mask: number, s: StatusId) => (mask & statusBit(s)) !== 0

export const STATUS_INFO: Record<StatusId, { name: string; good: boolean; color: string }> = {
  burning: { name: 'Burning', good: false, color: '#ff7a3c' },
  slowed: { name: 'Slowed', good: false, color: '#c9a35c' },
  rooted: { name: 'Rooted', good: false, color: '#ff4fd8' },
  corrupted: { name: 'Corrupted', good: false, color: '#9dff00' },
  memleak: { name: 'Memory Leak', good: false, color: '#b48cff' },
  haste: { name: 'Overclocked', good: true, color: '#ffd34d' },
  shielded: { name: 'Firewalled', good: true, color: '#ff9a3c' },
  stealth: { name: 'Encrypted', good: true, color: '#8fb8c8' },
  scanner: { name: 'Scanning', good: true, color: '#5cf2ff' },
  regen: { name: 'Repairing', good: true, color: '#7dff9a' },
  pulled: { name: 'Pulled', good: false, color: '#e0e0ff' },
  stunned: { name: 'Stunned', good: false, color: '#ffe14f' },
  asleep: { name: 'Asleep', good: false, color: '#8c7bff' },
  frozen: { name: 'Frozen', good: false, color: '#9ff6ff' },
}

// --- Snapshot entities -----------------------------------------------------------------------
export interface PlayerNet {
  id: string
  name: string
  x: number
  z: number
  yaw: number
  pitch: number
  hp: number
  maxHp: number
  level: number
  hue: number
  /** Armour tier for the visible suit, -1 for none. */
  armor: number
  /** Active weapon type. */
  weapon: string
  /** Status bitmask. */
  st: number
  dead: boolean
  kills: number
  /** Season badges earned. */
  badges: number
}

/** Monster flags. */
export const MF = {
  aggro: 1,
  boss: 2,
  invisible: 4,
  revealed: 8,
  hidden: 16,
  windup: 32,
  shield: 64,
  distress: 128,
  ally: 256,
  fuse: 512,
} as const

export interface MonsterNet {
  id: number
  k: string
  x: number
  z: number
  /** Facing angle (radians, same convention as player yaw). */
  y: number
  hp: number
  mhp: number
  lv: number
  /** MF flags. */
  f: number
  /** Status bitmask. */
  st: number
  /** Elite kind, if any. */
  e?: string
  /** Encrypted shield left, 0..1. */
  sh?: number
  /** Size multiplier (bosses, worm children). */
  s?: number
  /** Countdown seconds for fuses and channels. */
  t?: number
  /** Boss phase. */
  ph?: number
}

export interface ProjNet {
  id: number
  k: string
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Potion colour index for thrown potions. */
  c?: number
  /** Fired by a player (1) or a monster (0). */
  o: number
}

export type ZoneKind =
  | 'firewall'
  | 'stasis'
  | 'acid'
  | 'toxic'
  | 'noise'
  | 'junk'
  | 'web'
  | 'honeypot'
  | 'daemon'
  | 'blackhole'
  | 'mine'
  | 'crater'
  | 'torrent'

export interface ZoneNet {
  id: number
  k: ZoneKind
  x: number
  z: number
  r: number
  /** Seconds left. */
  t: number
  /** Angle of line-shaped zones (firewall, torrent). */
  a?: number
  /** Length of line-shaped zones. */
  l?: number
  /** Owner player id (daemons, honeypots). */
  o?: string
}

export interface LootNet {
  id: number
  kind: ItemKind | 'credits' | 'dump'
  base: string
  name: string
  rarity: number
  x: number
  z: number
  qty: number
  /** Personal loot (only this player sees it). */
  mine: boolean
}

/** The receiving player's private state, sent every tick. */
export interface YouNet {
  hp: number
  maxHp: number
  mana: number
  maxMana: number
  xp: number
  level: number
  credits: number
  /** Active statuses with seconds left. */
  status: [StatusId, number][]
  /** Seconds until each spell slot is ready. */
  cd: number[]
  dash: number
  potion: number
  /** Seconds until the next shot. */
  fire: number
  dead: boolean
  respawn: number
  /** Index of the hub the player stands in, or -1. */
  hub: number
  /** A gravity pull on the player: source x, z and speed. The client moves itself. */
  pull: [number, number, number] | null
  /** Seconds until the server season resets, when the Mainframe has fallen. */
  seasonEnds: number
}

export interface ShopEntry {
  id: string
  item: Item
  price: number
}

// --- Events ------------------------------------------------------------------------------------
export type GameEvent =
  | { kind: 'shot'; by: string; w: string; x: number; y: number; z: number; tx: number; ty: number; tz: number; crit?: boolean; charge?: number; pts?: [number, number, number][] }
  | { kind: 'hit'; m: number; dmg: number; by: string; crit?: boolean; type: DamageType; tag?: string }
  | { kind: 'kill'; m: number; key: string; name: string; by: string; byName: string; x: number; z: number; elite?: string; boss?: boolean }
  | { kind: 'hurt'; p: string; dmg: number; src: string; x: number; z: number; type: DamageType; special?: string }
  | { kind: 'miss'; p: string; src: string }
  | { kind: 'dodge'; p: string }
  | { kind: 'death'; p: string; name: string; killer: string; dump: number }
  | { kind: 'respawn'; p: string; x: number; z: number }
  | { kind: 'levelup'; p: string; name: string; level: number; spells: string[] }
  | { kind: 'heal'; p: string; amount: number }
  | { kind: 'mana'; p: string; amount: number }
  | { kind: 'windup'; m: number; what: string; dur: number }
  | { kind: 'tele'; shape: 'circle' | 'line' | 'cone'; x: number; z: number; r: number; a?: number; l?: number; dur: number; color?: string }
  | { kind: 'explode'; x: number; z: number; r: number; what: string; color?: string }
  | { kind: 'cast'; p: string; spell: string; x: number; z: number; tx?: number; tz?: number }
  | { kind: 'chain'; pts: [number, number][]; color: string }
  | { kind: 'leech'; p: string; m: number; dur: number }
  | { kind: 'blink'; who: string; x: number; z: number; tx: number; tz: number }
  | { kind: 'status'; m?: number; p?: string; s: string }
  | { kind: 'distress'; m: number; x: number; z: number; dur: number; done?: boolean }
  | { kind: 'ambush'; m: number; x: number; z: number }
  | { kind: 'split'; m: number; x: number; z: number }
  | { kind: 'pickup'; p: string; name: string; rarity: number; what: string }
  | { kind: 'credits'; p: string; amount: number }
  | { kind: 'drink'; p: string; base: string; color: number; name: string; known: boolean }
  | { kind: 'identify'; base: string; color: number; byName: string; name: string }
  | { kind: 'throw'; p: string; what: string }
  | { kind: 'gate'; cell: number; sector: number }
  | { kind: 'vault'; id: string; byName: string }
  | { kind: 'secret'; cell: number; byName: string }
  | { kind: 'puzzle'; id: string; msg: string; ok?: boolean; solved?: boolean; x?: number; z?: number }
  | { kind: 'chest'; obj: string; p: string }
  | { kind: 'event'; what: string; sector: number; msg: string; until: number }
  | { kind: 'boss'; key: string; arena: string; state: 'spawn' | 'phase' | 'dead' | 'enrage'; phase?: number; msg: string }
  | { kind: 'season'; state: 'won' | 'reset'; season: number; at: number; msg: string }
  | { kind: 'quest'; id: string; title: string; progress: number; goal: number; done: boolean }
  | { kind: 'daily'; index: number; text: string; done: boolean }
  | { kind: 'achievement'; id: string; name: string; byName: string; p: string }
  | { kind: 'fragment'; index: number; title: string }
  | { kind: 'travel'; p: string; hub: string }
  | { kind: 'chat'; name: string; text: string }
  | { kind: 'system'; text: string; cls?: string }
  | { kind: 'toast'; text: string; cls?: string }
  | { kind: 'sector'; sector: number; msg: string }
  | { kind: 'shop'; what: 'buy' | 'sell'; name: string }

// --- Messages ----------------------------------------------------------------------------------
/** Aim direction (unit vector) and an optional client-side target hint. */
export interface Aim {
  dx: number
  dy: number
  dz: number
  target?: number
}

export type InvOp =
  | { op: 'equip'; from: number }
  | { op: 'unequip'; slot: 'weapon' | 'weapon2' | 'armor' | 'implant0' | 'implant1' | 'implant2' }
  | { op: 'drop'; from: number }
  | { op: 'move'; from: number; to: number }
  | { op: 'use'; from: number }
  | { op: 'quick'; slot: number; key: string | null }
  | { op: 'grenade'; key: string }

export type ClientMsg =
  | { t: 'join'; name: string; pass: string }
  | { t: 'move'; x: number; z: number; yaw: number; pitch: number; dash?: boolean }
  | ({ t: 'fire'; charge?: number } & Aim)
  | ({ t: 'cast'; slot: number } & Aim)
  | ({ t: 'use'; slot: number } & Aim)
  | ({ t: 'grenade' } & Aim)
  | ({ t: 'throw'; from: number } & Aim)
  | { t: 'swap' }
  | { t: 'interact'; obj: string; arg?: number }
  | { t: 'touch'; cell: number }
  | ({ t: 'inv' } & InvOp)
  | { t: 'spell'; slot: number; id: string | null }
  | { t: 'talent'; id: string }
  | { t: 'respec' }
  | { t: 'shop'; op: 'buy' | 'sell'; id?: string; from?: number }
  | { t: 'quest'; op: 'accept' | 'abandon'; id: string }
  | { t: 'travel'; hub: string }
  | { t: 'chat'; text: string }

export interface Welcome {
  t: 'welcome'
  you: string
  guest: boolean
  world: WorldInfo
  state: WorldState
  char: CharacterData
  /** Potion kind -> bottle colour index for this season. */
  colors: Record<string, number>
  /** Potion kinds everyone has identified this season. */
  identified: string[]
  daily: DailyDef[]
  time: number
}

export type ServerMsg =
  | Welcome
  | { t: 'denied'; reason: string }
  | {
      t: 'snap'
      time: number
      you: YouNet
      players: PlayerNet[]
      monsters: MonsterNet[]
      proj: ProjNet[]
      zones: ZoneNet[]
      loot?: LootNet[]
    }
  | { t: 'events'; list: GameEvent[] }
  | { t: 'char'; char: CharacterData }
  | { t: 'state'; state: WorldState; identified: string[] }
  | { t: 'correct'; x: number; z: number }
  | { t: 'teleport'; x: number; z: number; yaw?: number }
  | { t: 'shop'; hub: string; stock: ShopEntry[] }
  | { t: 'board'; hub: string; offers: QuestState[] }
  | { t: 'beacon'; hub: string }
  | { t: 'world'; world: WorldInfo; state: WorldState; colors: Record<string, number>; identified: string[] }
