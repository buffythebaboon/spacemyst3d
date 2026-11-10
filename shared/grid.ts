// Collision and line-of-sight on the world grid, shared by the server simulation and the client.
import { CELL, toCell } from './constants.ts'
import { DOOR, FAKE, FLOOR, GATE, VAULT, WALL, inRect, type WorldInfo, type WorldState } from './world.ts'

/** What a query is for: walking players, walking monsters, or sight and shots. */
export const Mode = { Player: 0, Monster: 1, Sight: 2 } as const
export type Mode = (typeof Mode)[keyof typeof Mode]

export class Grid {
  readonly width: number
  readonly height: number
  readonly cells: number[]
  readonly sector: number[]
  /** hub index + 1 for every cell inside a hub, else 0. */
  readonly hubAt: Int8Array
  /** arena index + 1 for every cell inside a boss arena, else 0. */
  readonly arenaAt: Int8Array
  /** 1 while a door is slid open. */
  readonly doorOpen: Uint8Array
  readonly gateOpen: Uint8Array
  readonly vaultOpen: Uint8Array
  readonly fakeOpen: Uint8Array

  constructor(readonly info: WorldInfo) {
    this.width = info.width
    this.height = info.height
    this.cells = info.cells
    this.sector = info.sector
    const n = info.width * info.height
    this.hubAt = new Int8Array(n)
    this.arenaAt = new Int8Array(n)
    this.doorOpen = new Uint8Array(n)
    this.gateOpen = new Uint8Array(n)
    this.vaultOpen = new Uint8Array(n)
    this.fakeOpen = new Uint8Array(n)
    for (let z = 0; z < this.height; z++)
      for (let x = 0; x < this.width; x++) {
        const i = z * this.width + x
        info.hubs.forEach((h, k) => inRect(h, x, z) && (this.hubAt[i] = k + 1))
        info.arenas.forEach((a, k) => inRect(a, x, z) && (this.arenaAt[i] = k + 1))
      }
  }

  /** Copies the dynamic parts of the world state (opened gates, vaults, revealed fake walls). */
  applyState(state: WorldState) {
    this.gateOpen.fill(0)
    this.vaultOpen.fill(0)
    this.fakeOpen.fill(0)
    for (const c of state.gates) this.gateOpen[c] = 1
    for (const v of this.info.vaults) if (state.vaults.includes(v.id)) this.vaultOpen[v.cell] = 1
    for (const c of state.fakes) this.fakeOpen[c] = 1
  }

  index(cx: number, cz: number) {
    return cz * this.width + cx
  }

  inside(cx: number, cz: number) {
    return cx >= 0 && cz >= 0 && cx < this.width && cz < this.height
  }

  code(cx: number, cz: number) {
    return this.inside(cx, cz) ? this.cells[cz * this.width + cx] : WALL
  }

  sectorAt(x: number, z: number) {
    const cx = toCell(x)
    const cz = toCell(z)
    return this.inside(cx, cz) ? this.sector[cz * this.width + cx] : 0
  }

  hubIndexAt(x: number, z: number) {
    const cx = toCell(x)
    const cz = toCell(z)
    return this.inside(cx, cz) ? this.hubAt[cz * this.width + cx] - 1 : -1
  }

  arenaIndexAt(x: number, z: number) {
    const cx = toCell(x)
    const cz = toCell(z)
    return this.inside(cx, cz) ? this.arenaAt[cz * this.width + cx] - 1 : -1
  }

  /** Whether a cell stops movement or sight for the given mode. */
  solid(cx: number, cz: number, mode: Mode) {
    if (!this.inside(cx, cz)) return true
    const i = cz * this.width + cx
    switch (this.cells[i]) {
      case FLOOR:
        return mode === Mode.Monster && this.hubAt[i] > 0
      case WALL:
        return true
      case DOOR:
        return mode === Mode.Sight && !this.doorOpen[i]
      case GATE:
        return mode === Mode.Monster || !this.gateOpen[i]
      case VAULT:
        return mode === Mode.Monster || !this.vaultOpen[i]
      case FAKE:
        return !this.fakeOpen[i]
      default:
        return true
    }
  }

  solidAt(x: number, z: number, mode: Mode) {
    return this.solid(toCell(x), toCell(z), mode)
  }

  /** Square-footprint test used for movement. */
  blocked(x: number, z: number, r: number, mode: Mode) {
    return (
      this.solidAt(x - r, z - r, mode) ||
      this.solidAt(x + r, z - r, mode) ||
      this.solidAt(x - r, z + r, mode) ||
      this.solidAt(x + r, z + r, mode)
    )
  }

  /** Distance along a horizontal ray until it enters a solid cell (DDA). */
  ray(ox: number, oz: number, dx: number, dz: number, max: number, mode: Mode = Mode.Sight) {
    return this.rayHit(ox, oz, dx, dz, max, mode).dist
  }

  /** Like ray(), but also reports which cell stopped it and which face (0 = x face, 1 = z face) was crossed. */
  rayHit(ox: number, oz: number, dx: number, dz: number, max: number, mode: Mode = Mode.Sight) {
    const len = Math.hypot(dx, dz)
    if (len < 1e-9) return { dist: max, cx: -1, cz: -1, face: 0 }
    dx /= len
    dz /= len
    let cx = toCell(ox)
    let cz = toCell(oz)
    if (this.solid(cx, cz, mode)) return { dist: 0, cx, cz, face: 0 }
    const stepX = dx > 0 ? 1 : -1
    const stepZ = dz > 0 ? 1 : -1
    const tDeltaX = Math.abs(CELL / dx)
    const tDeltaZ = Math.abs(CELL / dz)
    let tMaxX = dx > 0 ? ((cx + 1) * CELL - ox) / dx : dx < 0 ? (cx * CELL - ox) / dx : Infinity
    let tMaxZ = dz > 0 ? ((cz + 1) * CELL - oz) / dz : dz < 0 ? (cz * CELL - oz) / dz : Infinity
    let t = 0
    let face = 0
    while (t < max) {
      if (tMaxX < tMaxZ) {
        t = tMaxX
        tMaxX += tDeltaX
        cx += stepX
        face = 0
      } else {
        t = tMaxZ
        tMaxZ += tDeltaZ
        cz += stepZ
        face = 1
      }
      if (t >= max) break
      if (this.solid(cx, cz, mode)) return { dist: t, cx, cz, face }
    }
    return { dist: max, cx: -1, cz: -1, face }
  }

  lineOfSight(ax: number, az: number, bx: number, bz: number, mode: Mode = Mode.Sight) {
    const d = Math.hypot(bx - ax, bz - az)
    if (d < 1e-6) return true
    return this.ray(ax, az, bx - ax, bz - az, d, mode) >= d - 0.01
  }

  /** Line of sight to a target's centre or either edge, so grazing a corner still counts. */
  canSee(ax: number, az: number, bx: number, bz: number, halfWidth: number) {
    if (this.lineOfSight(ax, az, bx, bz)) return true
    const d = Math.hypot(bx - ax, bz - az) || 1
    const ox = (-(bz - az) / d) * halfWidth
    const oz = ((bx - ax) / d) * halfWidth
    return this.lineOfSight(ax, az, bx + ox, bz + oz) || this.lineOfSight(ax, az, bx - ox, bz - oz)
  }

  /** Moves a circle by (dx, dz) with axis-separated sliding. Returns the new position. */
  slide(x: number, z: number, dx: number, dz: number, r: number, mode: Mode) {
    let nx = x + dx
    if (this.blocked(nx, z, r, mode)) nx = x
    let nz = z + dz
    if (this.blocked(nx, nz, r, mode)) nz = z
    return { x: nx, z: nz, hitX: nx === x && dx !== 0, hitZ: nz === z && dz !== 0 }
  }
}
