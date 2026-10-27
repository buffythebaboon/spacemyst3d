// Builds a season's maze: four concentric sectors around the Core, safe hubs, boss arenas,
// sector gates, vaults, secret rooms, puzzles, traps and loot spots. Deterministic per seed.
import { chance, mulberry32, pick, randInt, shuffle, type Rand } from './rng.ts'
import {
  DIRS,
  DOOR,
  FAKE,
  FLOOR,
  GATE,
  VAULT,
  WALL,
  inRect,
  traceBeam,
  type Arena,
  type Dir,
  type FakeWall,
  type Gate,
  type Hall,
  type Hub,
  type ObjKind,
  type Puzzle,
  type PuzzleKind,
  type Rect,
  type Vault,
  type WorldInfo,
  type WorldObject,
} from './world.ts'

export const ROOMS = 31
export const SIZE = ROOMS * 2 + 1
export const CENTER = (SIZE - 1) / 2
const RC = (ROOMS - 1) / 2

/** Sector of a grid cell: 0 Cooling Channels (outer ring) .. 3 The Core (centre). */
export function sectorOfCell(x: number, z: number) {
  const d = Math.max(Math.abs(x - CENTER), Math.abs(z - CENTER))
  return d <= 7 ? 3 : d <= 15 ? 2 : d <= 23 ? 1 : 0
}

function sectorOfRoom(rx: number, rz: number) {
  const d = Math.max(Math.abs(rx - RC), Math.abs(rz - RC))
  return d <= 3 ? 3 : d <= 7 ? 2 : d <= 11 ? 1 : 0
}

interface RoomRect {
  rx0: number
  rz0: number
  rx1: number
  rz1: number
}

const roomToCellRect = (r: RoomRect): Rect => ({ x0: r.rx0 * 2 + 1, z0: r.rz0 * 2 + 1, x1: r.rx1 * 2 + 1, z1: r.rz1 * 2 + 1 })

const HUB_ROOMS: RoomRect[] = [
  { rx0: RC - 1, rz0: RC + 12, rx1: RC + 1, rz1: RC + 14 },
  { rx0: RC - 1, rz0: RC - 10, rx1: RC + 1, rz1: RC - 8 },
  { rx0: RC - 1, rz0: RC + 4, rx1: RC + 1, rz1: RC + 6 },
]
const ARENA_ROOMS: { rect: RoomRect; boss: string }[] = [
  { rect: { rx0: RC - 1, rz0: RC - 14, rx1: RC + 1, rz1: RC - 12 }, boss: 'trojan_goliath' },
  { rect: { rx0: RC - 1, rz0: RC + 8, rx1: RC + 1, rz1: RC + 10 }, boss: 'kernel_guardian' },
  { rect: { rx0: RC - 1, rz0: RC - 6, rx1: RC + 1, rz1: RC - 4 }, boss: 'data_leviathan' },
  { rect: { rx0: RC - 2, rz0: RC - 2, rx1: RC + 2, rz1: RC + 2 }, boss: 'mainframe' },
]
/** Gate cells: two per sector boundary. `dir` points from the outer sector inwards. */
const GATE_CELLS: { x: number; z: number; sector: number; dir: Dir }[] = [
  { x: CENTER - 23, z: CENTER, sector: 0, dir: 1 },
  { x: CENTER + 23, z: CENTER, sector: 0, dir: 3 },
  { x: CENTER + 6, z: CENTER - 15, sector: 1, dir: 2 },
  { x: CENTER - 6, z: CENTER + 15, sector: 1, dir: 0 },
  { x: CENTER - 7, z: CENTER, sector: 2, dir: 1 },
  { x: CENTER + 7, z: CENTER, sector: 2, dir: 3 },
]
export const CORE_PILLARS: [number, number][] = [
  [CENTER - 2, CENTER - 2],
  [CENTER + 2, CENTER - 2],
  [CENTER - 2, CENTER + 2],
  [CENTER + 2, CENTER + 2],
]

const HALLS_PER_SECTOR = [5, 4, 3, 0]
const CHESTS_PER_SECTOR = [6, 5, 4, 2]
const DATAPADS_PER_SECTOR = [3, 3, 3, 1]
const LASERS_PER_SECTOR = [5, 8, 11, 4]
const ELECTRIC_PER_SECTOR = [3, 6, 9, 4]
const TURRETS_PER_SECTOR = [2, 4, 6, 4]

const RIDDLE_WORDS = [
  ['blood', 'embers', 'rust', 'a warning light'],
  ['moss', 'the old forest', 'a circuit board', 'spring leaves'],
  ['the open sky', 'deep water', 'ice', 'a cold monitor'],
]

/** A riddle that names the relay order without saying the colours outright. */
function relayRiddle(order: number[], rand: Rand) {
  const words = order.map((c) => pick(rand, RIDDLE_WORDS[c]))
  return `Maintenance log: power must flow from ${words[0]}, to ${words[1]}, and last to ${words[2]}.`
}

interface Built {
  info: WorldInfo
  /** Mirror puzzle solutions (object id -> orientation), for tests. */
  solutions: Record<string, Record<string, number>>
}

export function generateWorld(seed: number, season: number): WorldInfo {
  return buildWorld(seed, season).info
}

export function buildWorld(seed: number, season: number): Built {
  // A failed layout (very rare) just tries the next seed so callers always get a world.
  for (let attempt = 0; attempt < 20; attempt++) {
    const built = tryBuild(seed + attempt * 7919, season)
    if (built) {
      built.info.seed = seed
      return built
    }
  }
  throw new Error(`World generation failed for seed ${seed}`)
}

function tryBuild(seed: number, season: number): Built | null {
  const rand = mulberry32(seed)
  const W = SIZE
  const H = SIZE
  const cells = new Array<number>(W * H).fill(WALL)
  const sector = new Array<number>(W * H)
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) sector[z * W + x] = sectorOfCell(x, z)
  const idx = (x: number, z: number) => z * W + x
  const inside = (x: number, z: number) => x > 0 && z > 0 && x < W - 1 && z < H - 1
  const get = (x: number, z: number) => (x < 0 || z < 0 || x >= W || z >= H ? WALL : cells[idx(x, z)])
  const set = (x: number, z: number, v: number) => {
    if (inside(x, z)) cells[idx(x, z)] = v
  }

  // Room bookkeeping. 0 = maze room, 1 = block (hub/arena/lab/core), 2 = secret or vault room.
  const reserved = new Int8Array(ROOMS * ROOMS)
  const rIdx = (rx: number, rz: number) => rz * ROOMS + rx
  const roomIn = (rx: number, rz: number) => rx >= 0 && rz >= 0 && rx < ROOMS && rz < ROOMS
  const roomCell = (r: number): [number, number] => [(r % ROOMS) * 2 + 1, Math.floor(r / ROOMS) * 2 + 1]

  // Rooms right next to a gate must stay plain maze rooms.
  const gateRooms = new Set<number>()
  for (const g of GATE_CELLS) {
    const [dx, dz] = DIRS[g.dir]
    for (const s of [-1, 1]) {
      const cx = g.x + dx * s
      const cz = g.z + dz * s
      gateRooms.add(rIdx((cx - 1) / 2, (cz - 1) / 2))
    }
  }

  interface Block {
    kind: 'hub' | 'arena' | 'lab' | 'core'
    id: string
    sector: number
    rr: RoomRect
    rect: Rect
    entrances: number
    doorChance: number
    avoid?: Set<number>
  }
  const blocks: Block[] = []
  const markRooms = (rr: RoomRect, v: number) => {
    for (let rz = rr.rz0; rz <= rr.rz1; rz++) for (let rx = rr.rx0; rx <= rr.rx1; rx++) reserved[rIdx(rx, rz)] = v
  }
  const addBlock = (b: Omit<Block, 'rect'>) => {
    const block = { ...b, rect: roomToCellRect(b.rr) }
    blocks.push(block)
    markRooms(b.rr, 1)
    return block
  }

  HUB_ROOMS.forEach((rr, i) => addBlock({ kind: 'hub', id: `hub${i}`, sector: i, rr, entrances: 4, doorChance: 1 }))
  ARENA_ROOMS.forEach((a, i) =>
    addBlock({ kind: i === 3 ? 'core' : 'arena', id: `arena${i}`, sector: i, rr: a.rect, entrances: 2, doorChance: 1 }),
  )
  // The Core's outer ring of rooms is hand-built below, so keep it out of the maze.
  for (let rz = RC - 3; rz <= RC + 3; rz++)
    for (let rx = RC - 3; rx <= RC + 3; rx++) if (sectorOfRoom(rx, rz) === 3 && !reserved[rIdx(rx, rz)]) reserved[rIdx(rx, rz)] = 3

  /** Maze rooms of a sector stay one connected region (4-neighbour). */
  const sectorConnected = (s: number) => {
    let start = -1
    let total = 0
    for (let r = 0; r < ROOMS * ROOMS; r++) {
      const rx = r % ROOMS
      const rz = Math.floor(r / ROOMS)
      if (sectorOfRoom(rx, rz) !== s || reserved[r] !== 0) continue
      total++
      if (start < 0) start = r
    }
    if (start < 0) return true
    const seen = new Uint8Array(ROOMS * ROOMS)
    const queue = [start]
    seen[start] = 1
    let count = 0
    while (queue.length) {
      const r = queue.pop()!
      count++
      const rx = r % ROOMS
      const rz = Math.floor(r / ROOMS)
      for (const [dx, dz] of DIRS) {
        const nx = rx + dx
        const nz = rz + dz
        if (!roomIn(nx, nz)) continue
        const n = rIdx(nx, nz)
        if (seen[n] || reserved[n] !== 0 || sectorOfRoom(nx, nz) !== s) continue
        seen[n] = 1
        queue.push(n)
      }
    }
    return count === total
  }

  /** True when every room in rr is a free maze room of sector s, with a free margin around it. */
  const rectFree = (rr: RoomRect, s: number, margin: number) => {
    for (let rz = rr.rz0 - margin; rz <= rr.rz1 + margin; rz++)
      for (let rx = rr.rx0 - margin; rx <= rr.rx1 + margin; rx++) {
        const inner = rx >= rr.rx0 && rx <= rr.rx1 && rz >= rr.rz0 && rz <= rr.rz1
        if (!roomIn(rx, rz)) {
          if (inner) return false
          continue
        }
        const r = rIdx(rx, rz)
        if (inner) {
          if (sectorOfRoom(rx, rz) !== s || reserved[r] !== 0 || gateRooms.has(r)) return false
        } else if (reserved[r] === 1 || reserved[r] === 2) return false
      }
    return true
  }

  // --- Puzzles: two different kinds per outer sector, every kind at least once, no co-op plates in sector 0.
  const KINDS: PuzzleKind[] = ['relay', 'cipher', 'mirror', 'plates']
  let assign: PuzzleKind[][] = []
  for (let t = 0; t < 200; t++) {
    assign = [0, 1, 2].map(() => shuffle(rand, [...KINDS]).slice(0, 2))
    const all = new Set(assign.flat())
    if (all.size === 4 && !assign[0].includes('plates')) break
  }

  // --- Mirror labs: open 3x3-room halls, placed before the maze so it routes around them.
  interface LabPlan {
    sector: number
    block: Block
  }
  const labs: LabPlan[] = []
  for (let s = 0; s < 3; s++) {
    if (!assign[s].includes('mirror')) continue
    let placed: Block | null = null
    for (let t = 0; t < 400 && !placed; t++) {
      const rx0 = randInt(rand, 0, ROOMS - 3)
      const rz0 = randInt(rand, 0, ROOMS - 3)
      const rr = { rx0, rz0, rx1: rx0 + 2, rz1: rz0 + 2 }
      if (!rectFree(rr, s, 1)) continue
      markRooms(rr, 1)
      if (!sectorConnected(s)) {
        markRooms(rr, 0)
        continue
      }
      markRooms(rr, 0)
      placed = addBlock({ kind: 'lab', id: `lab${s}`, sector: s, rr, entrances: 2, doorChance: 0.6 })
    }
    if (!placed) return null
    labs.push({ sector: s, block: placed })
  }

  // --- Secret rooms and vaults: rooms cut off from the maze and reached through one special wall.
  interface Pocket {
    sector: number
    rr: RoomRect
    rect: Rect
    host: number
    link: { x: number; z: number }
    dir: Dir
  }
  const pockets: Pocket[] = []
  const reservePocket = (s: number, w: number, h: number): Pocket | null => {
    for (let t = 0; t < 400; t++) {
      const rx0 = randInt(rand, 0, ROOMS - w)
      const rz0 = randInt(rand, 0, ROOMS - h)
      const rr = { rx0, rz0, rx1: rx0 + w - 1, rz1: rz0 + h - 1 }
      if (!rectFree(rr, s, 1)) continue
      // Host rooms: maze rooms orthogonally next to the pocket, linked at a room column/row.
      const hosts: { host: number; link: { x: number; z: number }; dir: Dir }[] = []
      for (let rz = rr.rz0; rz <= rr.rz1; rz++)
        for (let rx = rr.rx0; rx <= rr.rx1; rx++)
          DIRS.forEach(([dx, dz], d) => {
            const nx = rx + dx
            const nz = rz + dz
            if (!roomIn(nx, nz)) return
            if (nx >= rr.rx0 && nx <= rr.rx1 && nz >= rr.rz0 && nz <= rr.rz1) return
            const n = rIdx(nx, nz)
            if (reserved[n] !== 0 || sectorOfRoom(nx, nz) !== s) return
            // dir points from the host into the pocket.
            const back = ((d + 2) % 4) as Dir
            hosts.push({ host: n, link: { x: rx * 2 + 1 + dx, z: rz * 2 + 1 + dz }, dir: back })
          })
      if (!hosts.length) continue
      markRooms(rr, 2)
      if (!sectorConnected(s)) {
        markRooms(rr, 0)
        continue
      }
      const h0 = pick(rand, hosts)
      const pocket = { sector: s, rr, rect: roomToCellRect(rr), host: h0.host, link: h0.link, dir: h0.dir }
      pockets.push(pocket)
      return pocket
    }
    return null
  }

  const vaultPockets: { sector: number; pocket: Pocket; lock: 'keycard' | 'puzzle'; kind?: PuzzleKind }[] = []
  const secretPockets: Pocket[] = []
  for (let s = 0; s < 3; s++) {
    const kv = reservePocket(s, 2, 2)
    if (!kv) return null
    vaultPockets.push({ sector: s, pocket: kv, lock: 'keycard' })
    for (const kind of assign[s]) {
      const pv = reservePocket(s, 1, 1)
      if (!pv) return null
      vaultPockets.push({ sector: s, pocket: pv, lock: 'puzzle', kind })
    }
    for (let i = 0; i < 2; i++) {
      const sp = reservePocket(s, 1, 1)
      if (!sp) return null
      secretPockets.push(sp)
    }
  }

  // --- Maze: a straight-biased depth-first search per sector over the free rooms.
  for (let s = 0; s < 3; s++) {
    const rooms: number[] = []
    for (let r = 0; r < ROOMS * ROOMS; r++)
      if (reserved[r] === 0 && sectorOfRoom(r % ROOMS, Math.floor(r / ROOMS)) === s) rooms.push(r)
    if (!rooms.length) continue
    const visited = new Uint8Array(ROOMS * ROOMS)
    const start = pick(rand, rooms)
    const stack: [number, number][] = [[start, -1]]
    visited[start] = 1
    const [sx, sz] = roomCell(start)
    set(sx, sz, FLOOR)
    while (stack.length) {
      const [r, lastDir] = stack[stack.length - 1]
      const rx = r % ROOMS
      const rz = Math.floor(r / ROOMS)
      const opts: number[] = []
      DIRS.forEach(([dx, dz], d) => {
        const nx = rx + dx
        const nz = rz + dz
        if (!roomIn(nx, nz)) return
        const n = rIdx(nx, nz)
        if (visited[n] || reserved[n] !== 0 || sectorOfRoom(nx, nz) !== s) return
        opts.push(d)
      })
      if (!opts.length) {
        stack.pop()
        continue
      }
      let d = pick(rand, opts)
      if (opts.includes(lastDir) && chance(rand, 0.5)) d = lastDir
      const [dx, dz] = DIRS[d]
      const n = rIdx(rx + dx, rz + dz)
      const [cx, cz] = roomCell(r)
      set(cx + dx, cz + dz, FLOOR)
      set(cx + dx * 2, cz + dz * 2, FLOOR)
      visited[n] = 1
      stack.push([n, d])
    }
  }

  // --- The Core: a ring corridor around the Mainframe's arena.
  for (let rz = RC - 3; rz <= RC + 3; rz++)
    for (let rx = RC - 3; rx <= RC + 3; rx++) {
      if (reserved[rIdx(rx, rz)] !== 3) continue
      const cx = rx * 2 + 1
      const cz = rz * 2 + 1
      set(cx, cz, FLOOR)
      for (const [dx, dz] of DIRS) {
        const nx = rx + dx
        const nz = rz + dz
        if (roomIn(nx, nz) && reserved[rIdx(nx, nz)] === 3) set(cx + dx, cz + dz, FLOOR)
      }
    }

  // --- Open the blocks and give each a few entrances.
  const fill = (r: Rect, v: number) => {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) set(x, z, v)
  }
  for (const b of blocks) fill(b.rect, FLOOR)
  for (const v of vaultPockets) fill(v.pocket.rect, FLOOR)
  for (const p of secretPockets) fill(p.rect, FLOOR)

  const entranceCells = new Map<number, number>() // cell -> door chance
  const blockOf = new Map<number, Block>()
  for (const b of blocks) {
    if (b.kind === 'core') {
      // North and south entrances; players walk the ring from the side gates.
      for (const z of [b.rect.z0 - 1, b.rect.z1 + 1]) {
        set(CENTER, z, FLOOR)
        entranceCells.set(idx(CENTER, z), 1)
      }
      continue
    }
    const sides: { x: number; z: number }[][] = [[], [], [], []]
    for (let rz = b.rr.rz0; rz <= b.rr.rz1; rz++)
      for (let rx = b.rr.rx0; rx <= b.rr.rx1; rx++)
        DIRS.forEach(([dx, dz], d) => {
          const nx = rx + dx
          const nz = rz + dz
          if (!roomIn(nx, nz)) return
          if (nx >= b.rr.rx0 && nx <= b.rr.rx1 && nz >= b.rr.rz0 && nz <= b.rr.rz1) return
          if (reserved[rIdx(nx, nz)] !== 0 || sectorOfRoom(nx, nz) !== b.sector) return
          sides[d].push({ x: rx * 2 + 1 + dx, z: rz * 2 + 1 + dz })
        })
    const order = shuffle(rand, [0, 1, 2, 3]).filter((d) => sides[d].length)
    if (!order.length) return null
    let made = 0
    for (let pass = 0; made < b.entrances && pass < 3; pass++)
      for (const d of order) {
        if (made >= b.entrances) break
        const free = sides[d].filter((c) => get(c.x, c.z) === WALL)
        if (!free.length) continue
        // Prefer the middle of a side for hubs and arenas, so entrances read as proper doorways.
        const c = b.kind === 'lab' ? pick(rand, free) : free[Math.floor(free.length / 2)]
        set(c.x, c.z, FLOOR)
        entranceCells.set(idx(c.x, c.z), b.doorChance)
        made++
      }
    if (!made) return null
  }
  for (const b of blocks)
    for (let z = b.rect.z0; z <= b.rect.z1; z++) for (let x = b.rect.x0; x <= b.rect.x1; x++) blockOf.set(idx(x, z), b)

  // --- Loops: knock out some extra walls between maze rooms so not everything is a dead end.
  for (let r = 0; r < ROOMS * ROOMS; r++) {
    if (reserved[r] !== 0) continue
    const rx = r % ROOMS
    const rz = Math.floor(r / ROOMS)
    const s = sectorOfRoom(rx, rz)
    for (const d of [1, 2]) {
      const [dx, dz] = DIRS[d]
      const nx = rx + dx
      const nz = rz + dz
      if (!roomIn(nx, nz) || reserved[rIdx(nx, nz)] !== 0 || sectorOfRoom(nx, nz) !== s) continue
      const wx = rx * 2 + 1 + dx
      const wz = rz * 2 + 1 + dz
      if (get(wx, wz) === WALL && chance(rand, 0.1)) set(wx, wz, FLOOR)
    }
  }

  // --- Open halls for bigger fights.
  const halls: Hall[] = []
  const hallRooms = new Uint8Array(ROOMS * ROOMS)
  for (let s = 0; s < 4; s++) {
    let made = 0
    for (let t = 0; t < 300 && made < HALLS_PER_SECTOR[s]; t++) {
      const w = randInt(rand, 2, 3)
      const h = w === 3 ? 2 : randInt(rand, 2, 3)
      const rx0 = randInt(rand, 0, ROOMS - w)
      const rz0 = randInt(rand, 0, ROOMS - h)
      const rr = { rx0, rz0, rx1: rx0 + w - 1, rz1: rz0 + h - 1 }
      if (!rectFree(rr, s, 1)) continue
      let overlap = false
      for (let rz = rz0 - 1; rz <= rr.rz1 + 1 && !overlap; rz++)
        for (let rx = rx0 - 1; rx <= rr.rx1 + 1; rx++) if (roomIn(rx, rz) && hallRooms[rIdx(rx, rz)]) overlap = true
      if (overlap) continue
      // Keep pockets' host rooms out of halls so their special walls stay readable.
      let hostInside = false
      for (const p of pockets) {
        const hx = p.host % ROOMS
        const hz = Math.floor(p.host / ROOMS)
        if (hx >= rx0 - 1 && hx <= rr.rx1 + 1 && hz >= rz0 - 1 && hz <= rr.rz1 + 1) hostInside = true
      }
      if (hostInside) continue
      for (let rz = rz0; rz <= rr.rz1; rz++) for (let rx = rx0; rx <= rr.rx1; rx++) hallRooms[rIdx(rx, rz)] = 1
      const rect = roomToCellRect(rr)
      fill(rect, FLOOR)
      halls.push({ ...rect, sector: s })
      made++
    }
  }

  // --- Gates between sectors.
  const gates: Gate[] = GATE_CELLS.map((g) => {
    set(g.x, g.z, GATE)
    const [dx, dz] = DIRS[g.dir]
    set(g.x - dx, g.z - dz, FLOOR)
    set(g.x + dx, g.z + dz, FLOOR)
    return { cell: idx(g.x, g.z), x: g.x, z: g.z, sector: g.sector, dir: g.dir }
  })

  // --- Vault doors and fake walls.
  const vaults: Vault[] = []
  const puzzles: Puzzle[] = []
  let vaultCount = 0
  for (const v of vaultPockets) {
    const p = v.pocket
    set(p.link.x, p.link.z, VAULT)
    const id = v.lock === 'keycard' ? `key${v.sector}` : `vault${v.sector}_${vaultCount++}`
    const vault: Vault = { id, cell: idx(p.link.x, p.link.z), x: p.link.x, z: p.link.z, sector: v.sector, lock: v.lock, ...p.rect }
    if (v.kind) vault.puzzle = `puz_${id}`
    vaults.push(vault)
  }
  const fakes: FakeWall[] = secretPockets.map((p) => {
    set(p.link.x, p.link.z, FAKE)
    return { cell: idx(p.link.x, p.link.z), x: p.link.x, z: p.link.z, sector: p.sector, ...p.rect }
  })

  // --- Core arena pillars to hide behind.
  for (const [x, z] of CORE_PILLARS) set(x, z, WALL)

  // --- Doors.
  const inAnyRect = (x: number, z: number, list: Rect[]) => list.some((r) => inRect(r, x, z))
  const blockRects = blocks.map((b) => b.rect)
  const doors: number[] = []
  /** A floor cell with walls on two opposite sides and open on the other two. */
  const isDoorway = (x: number, z: number) => {
    if (get(x, z) !== FLOOR) return false
    const w = get(x - 1, z) === WALL
    const e = get(x + 1, z) === WALL
    const n = get(x, z - 1) === WALL
    const s = get(x, z + 1) === WALL
    return (w && e && !n && !s) || (n && s && !w && !e)
  }
  const nearGate = (x: number, z: number) => gates.some((g) => Math.abs(g.x - x) + Math.abs(g.z - z) <= 2)
  for (let z = 1; z < H - 1; z++)
    for (let x = 1; x < W - 1; x++) {
      if ((x + z) % 2 === 0) continue // passages sit between rooms: one odd and one even coordinate
      if (!isDoorway(x, z) || nearGate(x, z)) continue
      if (inAnyRect(x, z, blockRects) || inAnyRect(x, z, halls)) continue
      const i = idx(x, z)
      let p = entranceCells.get(i)
      if (p === undefined) {
        const touchesHall = DIRS.some(([dx, dz]) => inAnyRect(x + dx, z + dz, halls))
        p = touchesHall ? 0.6 : 0.1
      }
      if (chance(rand, p)) {
        cells[i] = DOOR
        doors.push(i)
      }
    }

  // --- Objects.
  const objects: WorldObject[] = []
  const used = new Set<number>()
  let objCount = 0
  const addObj = (kind: ObjKind, x: number, z: number, extra: Partial<WorldObject> = {}) => {
    const o: WorldObject = { id: `o${objCount++}`, kind, x, z, sector: sectorOfCell(x, z), ...extra }
    objects.push(o)
    used.add(idx(x, z))
    return o
  }
  /** A wall side of a cell for wall-mounted objects, preferring `prefer`. */
  const wallSide = (x: number, z: number, prefer?: Dir): Dir => {
    if (prefer !== undefined && get(x + DIRS[prefer][0], z + DIRS[prefer][1]) === WALL) return prefer
    const opts = ([0, 1, 2, 3] as Dir[]).filter((d) => get(x + DIRS[d][0], z + DIRS[d][1]) === WALL)
    return opts.length ? pick(rand, opts) : 0
  }

  const hubs: Hub[] = blocks
    .filter((b) => b.kind === 'hub')
    .map((b) => ({ id: b.id, sector: b.sector, ...b.rect, cx: (b.rect.x0 + b.rect.x1) / 2, cz: (b.rect.z0 + b.rect.z1) / 2 }))
  for (const h of hubs) {
    addObj('shop', h.x0 + 1, h.z0 + 1, { hub: h.id, dir: 0 })
    addObj('board', h.x0 + 3, h.z0 + 1, { hub: h.id, dir: 0 })
    addObj('repair', h.x0 + 1, h.z0 + 3, { hub: h.id, dir: 2 })
    addObj('beacon', h.x0 + 3, h.z0 + 3, { hub: h.id })
    used.add(idx(h.cx, h.cz))
  }
  const arenas: Arena[] = blocks
    .filter((b) => b.kind === 'arena' || b.kind === 'core')
    .map((b) => ({
      id: b.id,
      sector: b.sector,
      boss: ARENA_ROOMS[Number(b.id.slice(5))].boss,
      ...b.rect,
      cx: (b.rect.x0 + b.rect.x1) / 2,
      cz: (b.rect.z0 + b.rect.z1) / 2,
    }))

  // Plain maze room cells (not in blocks, halls or pockets), by sector.
  const mazeRooms: number[][] = [[], [], [], []]
  const deadEnds: number[][] = [[], [], [], []]
  for (let r = 0; r < ROOMS * ROOMS; r++) {
    if (reserved[r] !== 0 && reserved[r] !== 3) continue
    const [x, z] = roomCell(r)
    if (get(x, z) !== FLOOR || inAnyRect(x, z, halls)) continue
    const s = sectorOfCell(x, z)
    mazeRooms[s].push(idx(x, z))
    const open = DIRS.filter(([dx, dz]) => get(x + dx, z + dz) !== WALL).length
    if (open === 1) deadEnds[s].push(idx(x, z))
  }
  const spawnCell = idx(hubs[0].cx, hubs[0].cz)
  const cx = (i: number) => i % W
  const cz = (i: number) => Math.floor(i / W)
  const farFromSpawn = (i: number, cellsAway: number) => Math.abs(cx(i) - cx(spawnCell)) + Math.abs(cz(i) - cz(spawnCell)) > cellsAway
  const isHost = new Set(pockets.map((p) => idx(...roomCell(p.host))))
  const free = (i: number) => !used.has(i) && !isHost.has(i)

  /** Picks up to n free cells from a list, spread apart by at least minDist (Manhattan cells) when possible. */
  const spread = (list: number[], n: number, minDist: number, avoid: number[] = []) => {
    const out: number[] = []
    const pool = shuffle(rand, list.filter(free))
    for (let pass = 0; pass < 2 && out.length < n; pass++) {
      const need = pass === 0 ? minDist : Math.floor(minDist / 2)
      for (const i of pool) {
        if (out.length >= n) break
        if (out.includes(i)) continue
        const ok = [...out, ...avoid].every((j) => Math.abs(cx(i) - cx(j)) + Math.abs(cz(i) - cz(j)) >= need)
        if (ok) out.push(i)
      }
    }
    return out
  }

  // Puzzles and their vaults.
  const solutions: Record<string, Record<string, number>> = {}
  for (const v of vaultPockets) {
    const vault = vaults.find((x) => x.cell === idx(v.pocket.link.x, v.pocket.link.z))!
    const [hx, hz] = roomCell(v.pocket.host)
    const hostCell = idx(hx, hz)
    used.add(hostCell)
    if (v.lock === 'keycard') {
      const r = vault
      addObj('chest', r.x0, r.z0, { tier: v.sector + 1, vault: vault.id })
      addObj('chest', r.x1, r.z1, { tier: v.sector + 1, vault: vault.id })
      addObj('fragment', r.x1, r.z0, { vault: vault.id })
      continue
    }
    addObj('chest', vault.x0, vault.z0, { tier: v.sector + 1, vault: vault.id })
    const s = v.sector
    const puzzle: Puzzle = { id: vault.puzzle!, kind: v.kind!, sector: s, vault: vault.id }
    if (v.kind === 'relay') {
      puzzle.order = shuffle(rand, [0, 1, 2])
      puzzle.riddle = relayRiddle(puzzle.order, rand)
      addObj('clue', hx, hz, { puzzle: puzzle.id, dir: wallSide(hx, hz) })
      const spots = spread(mazeRooms[s], 3, 14, [hostCell])
      if (spots.length < 3) return null
      spots.forEach((i, c) => addObj('relay', cx(i), cz(i), { puzzle: puzzle.id, color: c, dir: wallSide(cx(i), cz(i)) }))
    } else if (v.kind === 'cipher') {
      puzzle.code = [0, 1, 2, 3].map(() => randInt(rand, 0, 5))
      addObj('cipher', hx, hz, { puzzle: puzzle.id, dir: v.pocket.dir })
      const spots = spread(mazeRooms[s], 4, 12, [hostCell])
      if (spots.length < 4) return null
      spots.forEach((i, k) =>
        addObj('clue', cx(i), cz(i), { puzzle: puzzle.id, index: k, glyph: puzzle.code![k], dir: wallSide(cx(i), cz(i)) }),
      )
    } else if (v.kind === 'plates') {
      addObj('plate', hx, hz, { puzzle: puzzle.id, index: 0 })
      // The twin plate sits a few rooms away so one person cannot hold both.
      const near = mazeRooms[s].filter((i) => {
        const d = Math.abs(cx(i) - hx) + Math.abs(cz(i) - hz)
        return free(i) && d >= 6 && d <= 12
      })
      const other = near.length ? pick(rand, near) : spread(mazeRooms[s], 1, 6, [hostCell])[0]
      if (other === undefined) return null
      addObj('plate', cx(other), cz(other), { puzzle: puzzle.id, index: 1 })
    } else if (v.kind === 'mirror') {
      const lab = labs.find((l) => l.sector === s)!.block.rect
      const plan = planMirrorLab(rand, lab)
      if (!plan) return null
      puzzle.lab = { ...lab, entry: plan.entry, exit: plan.exit }
      const back = (d: Dir) => ((d + 2) % 4) as Dir
      addObj('emitter', plan.entry.x, plan.entry.z, { puzzle: puzzle.id, dir: back(plan.entry.dir) })
      addObj('receiver', plan.exit.x, plan.exit.z, { puzzle: puzzle.id, dir: plan.exit.dir })
      const sol: Record<string, number> = {}
      for (const m of plan.mirrors) {
        const o = addObj('mirror', m.x, m.z, { puzzle: puzzle.id, orient: m.start })
        sol[o.id] = m.solution
      }
      solutions[puzzle.id] = sol
      // Entrances must not be blocked by wall-mounted emitter/receiver: they never share a cell column/row parity.
    }
    puzzles.push(puzzle)
  }

  // Secret rooms: one holds a data fragment, the other a chest.
  secretPockets.forEach((p, i) => {
    if (i % 2 === 0) addObj('fragment', p.rect.x0, p.rect.z0)
    else addObj('chest', p.rect.x0, p.rect.z0, { tier: p.sector + 1 })
  })

  // Chests in dead ends, data pads around the maze.
  for (let s = 0; s < 4; s++) {
    const pool = deadEnds[s].length >= CHESTS_PER_SECTOR[s] ? deadEnds[s] : mazeRooms[s]
    for (const i of spread(pool, CHESTS_PER_SECTOR[s], 8).filter((i) => farFromSpawn(i, 6)))
      addObj('chest', cx(i), cz(i), { tier: s })
    for (const i of spread(mazeRooms[s], DATAPADS_PER_SECTOR[s], 10)) addObj('fragment', cx(i), cz(i))
  }

  // Traps.
  const passages: number[][] = [[], [], [], []]
  for (let z = 1; z < H - 1; z++)
    for (let x = 1; x < W - 1; x++) {
      if ((x + z) % 2 === 0) continue
      const i = idx(x, z)
      if (cells[i] !== FLOOR || !isDoorway(x, z) || nearGate(x, z) || entranceCells.has(i)) continue
      if (inAnyRect(x, z, blockRects) || inAnyRect(x, z, halls)) continue
      if (DIRS.some(([dx, dz]) => inAnyRect(x + dx, z + dz, blockRects))) continue
      passages[sectorOfCell(x, z)].push(i)
    }
  const trapSafe = (i: number) => farFromSpawn(i, 10) && free(i) && !DIRS.some(([dx, dz]) => used.has(idx(cx(i) + dx, cz(i) + dz)))
  for (let s = 0; s < 4; s++) {
    for (const i of spread(passages[s].filter(trapSafe), LASERS_PER_SECTOR[s], 6)) {
      const x = cx(i)
      const z = cz(i)
      // dir 0: corridor runs north-south (lasers span east-west); 1: corridor runs east-west.
      const dir: Dir = get(x, z - 1) !== WALL ? 0 : 1
      addObj('laser', x, z, { dir, phase: Math.round(rand() * 400) / 100 })
    }
    for (const i of spread(mazeRooms[s].filter(trapSafe), ELECTRIC_PER_SECTOR[s], 6))
      addObj('electric', cx(i), cz(i), { phase: Math.round(rand() * 400) / 100 })
    const turretSpots = [...mazeRooms[s]]
    for (const hall of halls.filter((h) => h.sector === s)) turretSpots.push(idx(hall.x0 + 1, hall.z0 + 1), idx(hall.x1 - 1, hall.z1 - 1))
    for (const i of spread(turretSpots.filter(trapSafe), TURRETS_PER_SECTOR[s], 8)) addObj('turret', cx(i), cz(i))
  }

  // Data fragment numbering follows the sectors from the edge inwards.
  objects
    .filter((o) => o.kind === 'fragment')
    .sort((a, b) => a.sector - b.sector || a.z - b.z || a.x - b.x)
    .forEach((o, i) => (o.fragment = i))

  const info: WorldInfo = {
    seed,
    season,
    width: W,
    height: H,
    cells,
    sector,
    hubs,
    arenas,
    halls,
    gates,
    vaults,
    fakes,
    doors,
    puzzles,
    objects,
    spawn: { x: hubs[0].cx, z: hubs[0].cz },
  }
  return { info, solutions }
}

interface MirrorPlan {
  entry: { x: number; z: number; dir: Dir }
  exit: { x: number; z: number; dir: Dir }
  mirrors: { x: number; z: number; solution: number; start: number }[]
}

/**
 * Lays out a mirror lab: a beam enters through one wall and must leave through a receiver on another.
 * Emitter and receiver sit at even offsets (between room columns), which are never entrances.
 */
function planMirrorLab(rand: Rand, lab: Rect): MirrorPlan | null {
  const w = lab.x1 - lab.x0 + 1
  const h = lab.z1 - lab.z0 + 1
  const sidesStart = (d: Dir) => {
    // Cells on the lab edge where a beam can enter heading `d` (i.e. coming from the opposite wall).
    const offs = [1, 3]
    if (d === 2) return offs.map((o) => ({ x: lab.x0 + o, z: lab.z0 }))
    if (d === 0) return offs.map((o) => ({ x: lab.x0 + o, z: lab.z1 }))
    if (d === 1) return offs.map((o) => ({ x: lab.x0, z: lab.z0 + o }))
    return offs.map((o) => ({ x: lab.x1, z: lab.z0 + o }))
  }
  const validExit = (x: number, z: number, d: number) => {
    const ox = x - lab.x0
    const oz = z - lab.z0
    if (d === 0) return z === lab.z0 && (ox === 1 || ox === 3)
    if (d === 2) return z === lab.z1 && (ox === 1 || ox === 3)
    if (d === 3) return x === lab.x0 && (oz === 1 || oz === 3)
    return x === lab.x1 && (oz === 1 || oz === 3)
  }
  for (let t = 0; t < 4000; t++) {
    const dir = randInt(rand, 0, 3) as Dir
    const entry = { ...pick(rand, sidesStart(dir)), dir }
    const count = randInt(rand, 3, 4)
    const mirrors = new Map<string, number>()
    for (let k = 0; k < count; k++) {
      const x = lab.x0 + randInt(rand, 0, w - 1)
      const z = lab.z0 + randInt(rand, 0, h - 1)
      if (x === entry.x && z === entry.z) continue
      mirrors.set(`${x},${z}`, randInt(rand, 0, 1))
    }
    const labFull = { ...lab, entry, exit: { x: 0, z: 0, dir: 0 as Dir } }
    const { path } = traceBeam(labFull, (x, z) => mirrors.get(`${x},${z}`))
    if (path.length < 7 || path.length > 40) continue
    // Every mirror must be on the path, the beam must leave cleanly, and not on the entry wall.
    const onPath = new Set(path.map(([x, z]) => `${x},${z}`))
    if ([...mirrors.keys()].some((k) => !onPath.has(k))) continue
    if (mirrors.size < 3) continue
    // Find the exit: follow the beam to its last cell and direction.
    let x = entry.x
    let z = entry.z
    let d: number = entry.dir
    let steps = 0
    let loops = false
    const seen = new Set<string>()
    while (inRect(lab, x, z)) {
      const key = `${x},${z},${d}`
      if (seen.has(key) || steps++ > 60) {
        loops = true
        break
      }
      seen.add(key)
      const m = mirrors.get(`${x},${z}`)
      if (m !== undefined) d = m === 0 ? [1, 0, 3, 2][d] : [3, 2, 1, 0][d]
      const nx = x + DIRS[d][0]
      const nz = z + DIRS[d][1]
      if (!inRect(lab, nx, nz)) break
      x = nx
      z = nz
    }
    if (loops || !validExit(x, z, d)) continue
    if ((d + 2) % 4 === entry.dir) continue // never out through the emitter's own wall
    const exit = { x, z, dir: d as Dir }
    // Scramble: flip some mirrors so the lab starts unsolved.
    const list = [...mirrors.entries()].map(([k, solution]) => {
      const [mx, mz] = k.split(',').map(Number)
      return { x: mx, z: mz, solution, start: solution }
    })
    for (let tries = 0; tries < 20; tries++) {
      for (const m of list) m.start = chance(rand, 0.6) ? 1 - m.solution : m.solution
      const lab2 = { ...lab, entry, exit }
      const starts = new Map(list.map((m) => [`${m.x},${m.z}`, m.start]))
      if (!traceBeam(lab2, (mx, mz) => starts.get(`${mx},${mz}`)).solved) break
    }
    const starts = new Map(list.map((m) => [`${m.x},${m.z}`, m.start]))
    if (traceBeam({ ...lab, entry, exit }, (mx, mz) => starts.get(`${mx},${mz}`)).solved) continue
    // One decoy mirror off the solution path makes the lab less obvious.
    const free: [number, number][] = []
    for (let zz = lab.z0; zz <= lab.z1; zz++)
      for (let xx = lab.x0; xx <= lab.x1; xx++) if (!onPath.has(`${xx},${zz}`)) free.push([xx, zz])
    if (free.length) {
      const [fx, fz] = pick(rand, free)
      const o = randInt(rand, 0, 1)
      const decoy = { x: fx, z: fz, solution: o, start: o }
      const withDecoy = new Map([...starts, [`${fx},${fz}`, o]])
      if (!traceBeam({ ...lab, entry, exit }, (mx, mz) => withDecoy.get(`${mx},${mz}`)).solved) list.push(decoy)
    }
    return { entry, exit, mirrors: list }
  }
  return null
}

/** Checks a generated world for problems; returns a list of human-readable issues (empty = fine). */
export function validateWorld(info: WorldInfo): string[] {
  const problems: string[] = []
  const W = info.width
  const H = info.height
  const walk = (open: (code: number) => boolean) => {
    const seen = new Uint8Array(W * H)
    const start = info.spawn.z * W + info.spawn.x
    const queue = [start]
    seen[start] = 1
    while (queue.length) {
      const i = queue.pop()!
      const x = i % W
      const z = Math.floor(i / W)
      for (const [dx, dz] of DIRS) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue
        const n = nz * W + nx
        if (seen[n] || !open(info.cells[n])) continue
        seen[n] = 1
        queue.push(n)
      }
    }
    return seen
  }
  const all = walk((c) => c !== WALL)
  for (let i = 0; i < W * H; i++) if (info.cells[i] !== WALL && !all[i]) problems.push(`unreachable cell ${i % W},${Math.floor(i / W)}`)
  // With every gate, vault and fake wall closed, the whole outer sector (except pockets) is reachable from spawn.
  const closed = walk((c) => c === FLOOR || c === DOOR)
  const pockets: Rect[] = [...info.vaults, ...info.fakes]
  for (let i = 0; i < W * H; i++) {
    const x = i % W
    const z = Math.floor(i / W)
    if (info.sector[i] !== 0 || (info.cells[i] !== FLOOR && info.cells[i] !== DOOR)) continue
    if (pockets.some((r) => inRect(r, x, z))) continue
    if (!closed[i]) problems.push(`sector 0 cell ${x},${z} unreachable while gates are closed`)
  }
  for (const g of info.gates) {
    const [dx, dz] = DIRS[g.dir]
    if (info.cells[(g.z - dz) * W + g.x - dx] === WALL || info.cells[(g.z + dz) * W + g.x + dx] === WALL)
      problems.push(`gate ${g.x},${g.z} is walled in`)
  }
  for (const p of info.puzzles) {
    if (p.kind === 'mirror') {
      const mirrors = info.objects.filter((o) => o.puzzle === p.id && o.kind === 'mirror')
      const start = new Map(mirrors.map((m) => [`${m.x},${m.z}`, m.orient ?? 0]))
      if (traceBeam(p.lab!, (x, z) => start.get(`${x},${z}`)).solved) problems.push(`mirror puzzle ${p.id} starts solved`)
      let solvable = false
      for (let mask = 0; mask < 1 << mirrors.length && !solvable; mask++) {
        const m = new Map(mirrors.map((o, k) => [`${o.x},${o.z}`, (mask >> k) & 1]))
        if (traceBeam(p.lab!, (x, z) => m.get(`${x},${z}`)).solved) solvable = true
      }
      if (!solvable) problems.push(`mirror puzzle ${p.id} cannot be solved`)
    }
    if (!info.vaults.some((v) => v.id === p.vault)) problems.push(`puzzle ${p.id} has no vault`)
  }
  return problems
}
