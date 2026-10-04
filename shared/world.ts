// World data shared by the server (which generates it) and the client (which draws it).

/** Cell codes in WorldInfo.cells. */
export const FLOOR = 0
export const WALL = 1
/** Sliding door: always walkable, blocks sight while closed. */
export const DOOR = 2
/** Sector gate: solid until the outer sector's corruption is purged. */
export const GATE = 3
/** Vault door: solid until opened by a keycard or a solved puzzle. */
export const VAULT = 4
/** Fake wall: looks solid until someone shoots or touches it. */
export const FAKE = 5

export type Dir = 0 | 1 | 2 | 3
/** 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x). */
export const DIRS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

export interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

export interface Hub extends Rect {
  id: string
  sector: number
  cx: number
  cz: number
}

export interface Arena extends Rect {
  id: string
  sector: number
  boss: string
  cx: number
  cz: number
}

export interface Gate {
  cell: number
  x: number
  z: number
  /** The outer sector; the gate opens when it is purged. */
  sector: number
  dir: Dir
}

export interface Vault extends Rect {
  id: string
  cell: number
  x: number
  z: number
  sector: number
  lock: 'keycard' | 'puzzle'
  puzzle?: string
}

export interface Hall extends Rect {
  sector: number
}

/** A secret room behind a fake wall; the rect is the room behind it. */
export interface FakeWall extends Rect {
  cell: number
  x: number
  z: number
  sector: number
}

export type PuzzleKind = 'relay' | 'cipher' | 'mirror' | 'plates'

export interface Puzzle {
  id: string
  kind: PuzzleKind
  sector: number
  vault: string
  /** relay: the colour order to switch the relays in, and the clue that describes it. */
  order?: number[]
  riddle?: string
  /** cipher: the four glyphs, 0..5. */
  code?: number[]
  /** mirror: the open lab and where the beam starts and must end. */
  lab?: Rect & { entry: { x: number; z: number; dir: Dir }; exit: { x: number; z: number; dir: Dir } }
}

export type ObjKind =
  | 'shop'
  | 'board'
  | 'repair'
  | 'beacon'
  | 'chest'
  | 'fragment'
  | 'relay'
  | 'clue'
  | 'cipher'
  | 'mirror'
  | 'emitter'
  | 'receiver'
  | 'plate'
  | 'laser'
  | 'electric'
  | 'turret'

export interface WorldObject {
  id: string
  kind: ObjKind
  /** Cell coordinates. */
  x: number
  z: number
  sector: number
  dir?: Dir
  hub?: string
  puzzle?: string
  /** relay colour index 0..2 */
  color?: number
  /** clue index 0..3 and its glyph */
  index?: number
  glyph?: number
  /** mirror orientation at season start: 0 = '/', 1 = '\' */
  orient?: number
  /** chest quality: the sector it belongs to, +1 inside vaults */
  tier?: number
  vault?: string
  fragment?: number
  /** trap timing offset in seconds */
  phase?: number
}

export interface WorldInfo {
  seed: number
  season: number
  width: number
  height: number
  cells: number[]
  sector: number[]
  hubs: Hub[]
  arenas: Arena[]
  halls: Hall[]
  gates: Gate[]
  vaults: Vault[]
  fakes: FakeWall[]
  doors: number[]
  puzzles: Puzzle[]
  objects: WorldObject[]
  spawn: { x: number; z: number }
}

/** Dynamic world state, broadcast whenever it changes. */
export interface WorldState {
  season: number
  gates: number[]
  vaults: string[]
  fakes: number[]
  solved: string[]
  /** relay puzzle id -> colours switched on so far, in order */
  relays: Record<string, number[]>
  /** mirror object id -> orientation */
  mirrors: Record<string, number>
  plates: string[]
  /** 0..1 per sector */
  corruption: number[]
  event: { kind: string; sector: number; until: number } | null
  /** arena id -> boss alive, or when it returns */
  bosses: Record<string, { alive: boolean; respawnAt?: number }>
  turretsDown: string[]
  seasonEndsAt?: number
}

export const HUB_NAMES: Record<string, string> = {
  hub0: 'Coolant Plaza',
  hub1: 'Hall Junction',
  hub2: 'Quarantine Post',
}

export const GLYPHS = ['Ψ', 'Δ', 'Ω', 'Σ', 'Φ', 'Λ'] as const
export const RELAY_COLORS = ['#ff3b5c', '#7dff9a', '#4fa8ff'] as const
export const RELAY_NAMES = ['RED', 'GREEN', 'BLUE'] as const

export const inRect = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1

/**
 * Traces the mirror lab beam. Returns the cells it passes and whether it leaves through the exit.
 * Mirrors: orient 0 is '/', 1 is '\'.
 */
export function traceBeam(lab: NonNullable<Puzzle['lab']>, mirrorAt: (x: number, z: number) => number | undefined) {
  const path: [number, number][] = []
  let x = lab.entry.x
  let z = lab.entry.z
  let dir: number = lab.entry.dir
  for (let steps = 0; steps < 64; steps++) {
    if (!inRect(lab, x, z)) {
      const last = path[path.length - 1]
      const hit = !!last && last[0] === lab.exit.x && last[1] === lab.exit.z && dir === lab.exit.dir
      return { path, solved: hit }
    }
    path.push([x, z])
    const m = mirrorAt(x, z)
    if (m !== undefined) {
      // '/' turns N<->E and S<->W, '\' turns N<->W and S<->E.
      if (m === 0) dir = [1, 0, 3, 2][dir]
      else dir = [3, 2, 1, 0][dir]
    }
    x += DIRS[dir][0]
    z += DIRS[dir][1]
  }
  return { path, solved: false }
}
