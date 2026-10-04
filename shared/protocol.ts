export interface PlayerState {
  id: string
  name: string
  x: number
  z: number
  yaw: number
  hp: number
  maxHp: number
  mana: number
  maxMana: number
  level: number
  coins: number
  kills: number
  hue: number
}

export interface MonsterState {
  id: string
  key: string
  x: number
  z: number
  hp: number
  maxHp: number
  /** 1 while chasing a player, 0 while wandering. */
  aggro: number
}

export interface WorldInfo {
  width: number
  height: number
  /** Row-major, 1 = wall, 0 = floor. */
  grid: number[]
}

export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'move'; x: number; z: number; yaw: number }
  | { t: 'shoot'; target: string | null; dx: number; dz: number; overload?: boolean }
  | { t: 'repair' }
  | { t: 'chat'; text: string }

export type GameEvent =
  | { kind: 'shot'; by: string; x: number; z: number; tx: number; tz: number; overload: boolean }
  | { kind: 'hit'; monster: string; dmg: number; by: string }
  | { kind: 'kill'; monster: string; name: string; by: string; byName: string; coins: number }
  | { kind: 'bite'; monster: string; player: string; dmg: number; special: string | null; miss: boolean }
  | { kind: 'death'; player: string; name: string; killer: string }
  | { kind: 'levelup'; player: string; name: string; level: number }
  | { kind: 'repair'; player: string; amount: number }
  | { kind: 'chat'; name: string; text: string }
  | { kind: 'system'; text: string }

export type ServerMsg =
  | { t: 'welcome'; you: string; world: WorldInfo; spawn: { x: number; z: number } }
  | { t: 'snap'; players: PlayerState[]; monsters: MonsterState[] }
  | { t: 'events'; list: GameEvent[] }
  | { t: 'correct'; x: number; z: number }
