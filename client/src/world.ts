import * as THREE from 'three'
import { CELL, WALL_HEIGHT, cellCenter, toCell } from '../../shared/constants.ts'
import type { WorldInfo } from '../../shared/protocol.ts'
import { ceilingTextures, floorTextures, wallTextures } from './textures.ts'

export class World {
  readonly width: number
  readonly height: number
  readonly grid: number[]
  readonly group = new THREE.Group()
  /** Cells the local player has seen, for the minimap. */
  readonly explored: Uint8Array

  constructor(info: WorldInfo) {
    this.width = info.width
    this.height = info.height
    this.grid = info.grid
    this.explored = new Uint8Array(info.width * info.height)
    this.build()
  }

  isWall(cx: number, cz: number) {
    return cx < 0 || cz < 0 || cx >= this.width || cz >= this.height || this.grid[cz * this.width + cx] === 1
  }

  solidAt(x: number, z: number) {
    return this.isWall(toCell(x), toCell(z))
  }

  /** Circle-vs-grid test used for player movement. */
  blocked(x: number, z: number, r: number) {
    return this.solidAt(x - r, z - r) || this.solidAt(x + r, z - r) || this.solidAt(x - r, z + r) || this.solidAt(x + r, z + r)
  }

  /** Distance along a horizontal ray until it enters a wall cell (DDA). */
  rayWall(ox: number, oz: number, dx: number, dz: number, max: number) {
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) return max
    dx /= len
    dz /= len
    let cx = toCell(ox)
    let cz = toCell(oz)
    const stepX = dx > 0 ? 1 : -1
    const stepZ = dz > 0 ? 1 : -1
    const tDeltaX = Math.abs(CELL / dx)
    const tDeltaZ = Math.abs(CELL / dz)
    let tMaxX = dx > 0 ? ((cx + 1) * CELL - ox) / dx : dx < 0 ? (cx * CELL - ox) / dx : Infinity
    let tMaxZ = dz > 0 ? ((cz + 1) * CELL - oz) / dz : dz < 0 ? (cz * CELL - oz) / dz : Infinity
    let t = 0
    while (t < max) {
      if (tMaxX < tMaxZ) {
        t = tMaxX
        tMaxX += tDeltaX
        cx += stepX
      } else {
        t = tMaxZ
        tMaxZ += tDeltaZ
        cz += stepZ
      }
      if (this.isWall(cx, cz)) return Math.min(t, max)
    }
    return max
  }

  lineOfSight(ax: number, az: number, bx: number, bz: number) {
    const d = Math.hypot(bx - ax, bz - az)
    return this.rayWall(ax, az, bx - ax, bz - az, d) >= d - 0.01
  }

  /** Marks cells within sight as explored. Cheap enough to run a few times per second. */
  reveal(x: number, z: number) {
    const R = 6
    const pcx = toCell(x)
    const pcz = toCell(z)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const cx = pcx + dx
        const cz = pcz + dz
        if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) continue
        const i = cz * this.width + cx
        if (this.explored[i]) continue
        const tx = cellCenter(cx)
        const tz = cellCenter(cz)
        // Walls count as seen when the ray reaches their face.
        const d = Math.hypot(tx - x, tz - z)
        if (this.rayWall(x, z, tx - x, tz - z, d) >= d - CELL * 0.75) this.explored[i] = 1
      }
  }

  private build() {
    const W = this.width
    const H = this.height
    const wall = wallTextures()
    const wallMat = new THREE.MeshStandardMaterial({
      map: wall.map,
      emissiveMap: wall.emissive,
      emissive: new THREE.Color('#5cf2ff'),
      emissiveIntensity: 1.1,
      roughness: 0.6,
      metalness: 0.5,
    })

    const visible: [number, number][] = []
    for (let z = 0; z < H; z++)
      for (let x = 0; x < W; x++) {
        if (!this.isWall(x, z)) continue
        const nearFloor =
          (x > 0 && !this.isWall(x - 1, z)) ||
          (x < W - 1 && !this.isWall(x + 1, z)) ||
          (z > 0 && !this.isWall(x, z - 1)) ||
          (z < H - 1 && !this.isWall(x, z + 1))
        if (nearFloor) visible.push([x, z])
      }
    const box = new THREE.BoxGeometry(CELL, WALL_HEIGHT, CELL)
    const walls = new THREE.InstancedMesh(box, wallMat, visible.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3(1, 1, 1)
    const up = new THREE.Vector3(0, 1, 0)
    visible.forEach(([x, z], i) => {
      // Rotate each block by a random quarter turn so the panel pattern doesn't tile visibly.
      q.setFromAxisAngle(up, (Math.floor(Math.random() * 4) * Math.PI) / 2)
      m.compose(new THREE.Vector3(cellCenter(x), WALL_HEIGHT / 2, cellCenter(z)), q, s)
      walls.setMatrixAt(i, m)
    })
    walls.receiveShadow = false
    this.group.add(walls)

    const floor = floorTextures()
    floor.map.repeat.set(W / 2, H / 2)
    floor.emissive.repeat.set(W, H)
    const floorMat = new THREE.MeshStandardMaterial({
      map: floor.map,
      emissiveMap: floor.emissive,
      emissive: new THREE.Color('#5cf2ff'),
      emissiveIntensity: 0.5,
      roughness: 0.4,
      metalness: 0.7,
    })
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(W * CELL, H * CELL), floorMat)
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.set((W * CELL) / 2, 0, (H * CELL) / 2)
    this.group.add(floorMesh)

    const ceil = ceilingTextures()
    ceil.map.repeat.set(W, H)
    ceil.emissive.repeat.set(W, H)
    const ceilMat = new THREE.MeshStandardMaterial({
      map: ceil.map,
      emissiveMap: ceil.emissive,
      emissive: new THREE.Color('#d8fbff'),
      emissiveIntensity: 1.6,
      roughness: 0.9,
    })
    const ceilMesh = new THREE.Mesh(new THREE.PlaneGeometry(W * CELL, H * CELL), ceilMat)
    ceilMesh.rotation.x = Math.PI / 2
    ceilMesh.position.set((W * CELL) / 2, WALL_HEIGHT, (H * CELL) / 2)
    this.group.add(ceilMesh)

    this.addHallLights()
    this.addDust()
  }

  /** Coloured lights in the open halls give each area its own mood. */
  private addHallLights() {
    const palette = ['#ff4fd8', '#5cf2ff', '#7dff9a', '#ffb347', '#8c7bff']
    const spots: [number, number][] = []
    for (let z = 2; z < this.height - 2; z++)
      for (let x = 2; x < this.width - 2; x++) {
        let open = 0
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.isWall(x + dx, z + dz)) open++
        if (open === 9 && spots.every(([sx, sz]) => Math.hypot(sx - x, sz - z) > 8)) spots.push([x, z])
      }
    spots.slice(0, 8).forEach(([x, z], i) => {
      const color = palette[i % palette.length]
      const light = new THREE.PointLight(color, 60, CELL * 6, 1.6)
      light.position.set(cellCenter(x), WALL_HEIGHT - 0.6, cellCenter(z))
      this.group.add(light)
      // A floating holo-core marks the hall.
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.5, 0),
        new THREE.MeshBasicMaterial({ color, wireframe: true }),
      )
      core.position.set(cellCenter(x), 2.2, cellCenter(z))
      core.userData.spin = 0.6 + Math.random()
      this.group.add(core)
      this.cores.push(core)
    })
  }

  readonly cores: THREE.Object3D[] = []
  private dust?: THREE.Points

  private addDust() {
    const N = 2500
    const pos = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random() * this.width * CELL
      pos[i * 3 + 1] = Math.random() * WALL_HEIGHT
      pos[i * 3 + 2] = Math.random() * this.height * CELL
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: '#8feaff', size: 0.05, transparent: true, opacity: 0.6, depthWrite: false }),
    )
    this.group.add(this.dust)
  }

  update(dt: number, time: number) {
    for (const c of this.cores) {
      c.rotation.y += dt * c.userData.spin
      c.rotation.x += dt * 0.3
      c.position.y = 2.2 + Math.sin(time * 1.5 + c.userData.spin * 10) * 0.2
    }
    if (this.dust) this.dust.position.y = Math.sin(time * 0.2) * 0.3
  }
}
