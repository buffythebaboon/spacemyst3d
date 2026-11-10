// Server-side entity types. Everything here lives in memory; characters are saved through the store.
import type { CharacterData, Stats } from '../shared/character.ts'
import type { Item } from '../shared/items.ts'
import type { DamageType, EliteKind, MonsterDef } from '../shared/monsters.ts'
import type { ServerMsg, StatusId, ZoneKind } from '../shared/protocol.ts'
import type { QuestState } from '../shared/quests.ts'

/** Anything that can receive messages: a WebSocket in production, a recorder in tests. */
export interface Client {
  send(msg: ServerMsg): void
  close?(): void
}

export interface StatusInst {
  until: number
  /** Damage per second for damage-over-time statuses, or strength for slows and pulls. */
  power: number
  /** Who applied it (player id or monster id), for kill credit. */
  by?: string
  /** Pull source. */
  x?: number
  z?: number
  next?: number
}

export interface HealOverTime {
  perSec: number
  until: number
}

export interface Player {
  id: string
  client: Client
  char: CharacterData
  stats: Stats
  /** Account key, or null for guests. */
  account: string | null
  x: number
  z: number
  /** Recent velocity from movement updates, for monsters that lead their shots. */
  vx: number
  vz: number
  yaw: number
  pitch: number
  hp: number
  mana: number
  hue: number
  dead: boolean
  respawnAt: number
  lastMove: number
  dashUntil: number
  iframesUntil: number
  dashReady: number
  fireReady: number
  potionReady: number
  spellReady: Record<string, number>
  statuses: Map<StatusId, StatusInst>
  heals: HealOverTime[]
  /** Monsters ignore the player until this time, after joining or respawning. */
  shieldUntil: number
  /** Data Leech channel. */
  leech: { m: number; until: number; next: number; perTick: number } | null
  /** Crash times, for the Spotless achievement. */
  deaths: number[]
  /** Quest board offers per hub (not saved). */
  board: Record<string, { offers: QuestState[]; at: number }>
  hub: number
  sector: number
  /** Send the full character at the end of the tick. */
  charDirty: boolean
  /** Small changes (counters, credits): send the character within a couple of seconds. */
  charSoft: boolean
  charSentAt: number
  /** Time of the last shot, for the railgun's charge check. */
  lastShot: number
  /** Black market items this player bought in the current stock window. */
  bought: Set<string>
  boughtWindow: number
  sessionKills: number
  lootSentAt: number
  lastFullInv: number
  chatTimes: number[]
  trapHitAt: Record<string, number>
  joinedAt: number
  /** Leaves the server when the socket closes. */
  connected: boolean
}

export type TargetRef = { kind: 'player'; id: string } | { kind: 'monster'; id: number } | { kind: 'zone'; id: number }

export interface Monster {
  id: number
  def: MonsterDef
  level: number
  x: number
  z: number
  /** Height above the floor (turrets hang from the ceiling). */
  y: number
  yaw: number
  hp: number
  maxHp: number
  sector: number
  boss: boolean
  arena?: string
  elite?: EliteKind
  size: number
  speed: number
  damage: number
  statuses: Map<StatusId, StatusInst>
  target: TargetRef | null
  /** Where the target was last seen, and when. */
  lastSeen: { x: number; z: number; at: number } | null
  home: { x: number; z: number }
  wander: { x: number; z: number } | null
  nextThink: number
  attackReady: number
  windup: { what: string; until: number; tx: number; tz: number; a?: number; extra?: number } | null
  /** Charging (Trojan Goliath) or blink-dashing state. */
  dash: { vx: number; vz: number; until: number; hit: Set<string> } | null
  pack: number
  ambush: boolean
  shield: number
  shieldMax: number
  lastHurt: number
  contributors: Map<string, { dmg: number; at: number }>
  distressUsed: boolean
  distressUntil: number
  revealedUntil: number
  allyOf: string | null
  allyUntil: number
  generation: number
  splitDone: boolean
  fuseAt: number
  nextSpecial: number
  nextBlink: number
  nextJunk: number
  phase: number
  spawnedAt: number
  despawnAt: number
  turretObj?: string
  /** Kernel Guardian: takes extra damage while recovering after System Purge. */
  vulnerableUntil: number
  /** Leviathan dive: invulnerable and hidden until this time. */
  submergedUntil: number
  /** Extra spawns from the Mainframe and events don't reduce corruption. */
  noCorruption: boolean
  /** Simulated this tick (someone is near). */
  active: boolean
  dead: boolean
}

export interface Projectile {
  id: number
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
  /** Explosion radius, 0 for single-target projectiles. */
  radius: number
  gravity: number
  expires: number
  /** Grenades explode at this time. */
  fuseAt: number
  bounces: number
  hitRadius: number
  data: { grenade?: string; potion?: string; color?: number; crit?: boolean; special?: string; burn?: number }
}

export interface Zone {
  id: number
  kind: ZoneKind
  x: number
  z: number
  r: number
  until: number
  angle: number
  len: number
  owner: string | null
  ownerMonster: number | null
  /** Damage per second, or another strength value. */
  power: number
  nextTick: number
  hp: number
  data: Record<string, number>
}

export interface Loot {
  id: number
  /** Player id for personal loot; null for loot anyone can take. */
  owner: string | null
  /** Character name of the owner, so a data dump finds its owner again after a reconnect. */
  ownerName?: string
  item: Item | null
  credits: number
  dump: boolean
  x: number
  z: number
  expires: number
  sector: number
  /** Whoever dropped it cannot pick it straight back up. */
  dropper?: string
  dropperUntil?: number
}
