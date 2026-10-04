// The maze itself: walls, floors and ceilings per sector look, plus doors, gates, vaults and fake walls.
import * as THREE from 'three'
import { CELL, SECTOR_COLORS, WALL_HEIGHT, cellCenter, toCell } from '../../shared/constants.ts'
import { Mode, type Grid } from '../../shared/grid.ts'
import { DIRS, DOOR, FAKE, GATE, VAULT, WALL, type WorldInfo, type WorldState } from '../../shared/world.ts'
import { icon } from './art/icons.ts'
import { sectorLook, type SectorLook } from './art/sectors.ts'
import { glowTexture, labelTexture, noiseTexture, urlTexture } from './textures.ts'

export const HUB_LOOK = 4
const DOOR_RANGE = 4.6
const H = WALL_HEIGHT

/** Collects quads into one BufferGeometry. */
class Geo {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  idx: number[] = []

  /** p0..p3 counter-clockwise as seen from the front. */
  quad(p: number[][], n: number[], uv: number[][]) {
    const base = this.pos.length / 3
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2])
      this.nor.push(n[0], n[1], n[2])
      this.uv.push(uv[i][0], uv[i][1])
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }

  get empty() {
    return this.pos.length === 0
  }
}

const FACE_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/** Corners of the wall face on side d of cell (x, z), seen from inside the cell. */
function wallFace(x: number, z: number, d: number, y0 = 0, y1 = H) {
  const x0 = x * CELL
  const x1 = x0 + CELL
  const z0 = z * CELL
  const z1 = z0 + CELL
  switch (d) {
    case 0:
      return { p: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], n: [0, 0, 1] }
    case 1:
      return { p: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], n: [-1, 0, 0] }
    case 2:
      return { p: [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]], n: [0, 0, -1] }
    default:
      return { p: [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], n: [1, 0, 0] }
  }
}

interface LookMats {
  look: SectorLook
  wall: THREE.MeshStandardMaterial
  floor: THREE.MeshStandardMaterial
  ceiling: THREE.MeshStandardMaterial
}

const lookMats = new Map<number, LookMats>()
function mats(i: number): LookMats {
  let m = lookMats.get(i)
  if (m) return m
  const look = sectorLook(i)
  look.floor.map.repeat.set(0.5, 0.5)
  look.floor.emissive.repeat.set(1, 1)
  const wall = new THREE.MeshStandardMaterial({
    map: look.wall.map,
    emissiveMap: look.wall.emissive,
    emissive: new THREE.Color(look.wallEmissive),
    emissiveIntensity: look.wallEmissiveIntensity,
    roughness: 0.62,
    metalness: 0.45,
  })
  const floor = new THREE.MeshStandardMaterial({
    map: look.floor.map,
    emissiveMap: look.floor.emissive,
    emissive: new THREE.Color(look.floorEmissive),
    emissiveIntensity: look.floorEmissiveIntensity,
    roughness: 0.45,
    metalness: 0.65,
  })
  const ceiling = new THREE.MeshStandardMaterial({
    map: look.ceiling.map,
    emissiveMap: look.ceiling.emissive,
    emissive: new THREE.Color(look.ceilingEmissive),
    emissiveIntensity: look.ceilingEmissiveIntensity,
    roughness: 0.9,
    metalness: 0.2,
  })
  wall.userData.base = look.wallEmissiveIntensity
  floor.userData.base = look.floorEmissiveIntensity
  ceiling.userData.base = look.ceilingEmissiveIntensity
  m = { look, wall, floor, ceiling }
  lookMats.set(i, m)
  return m
}

export function lookFor(i: number) {
  return mats(i).look
}

// --- Doors, gates, vaults, fake walls ------------------------------------------------------------------
interface DoorView {
  cell: number
  x: number
  z: number
  /** Panel runs along x (blocks travel in z) or along z. */
  alongX: boolean
  a: THREE.Mesh
  b: THREE.Mesh
  open: number
  target: number
}

interface GateView {
  cell: number
  sector: number
  group: THREE.Group
  barrier: THREE.Mesh
  posts: THREE.MeshStandardMaterial
  open: number
}

interface VaultView {
  id: string
  group: THREE.Group
  slab: THREE.Group
  lamp: THREE.MeshBasicMaterial
  open: number
}

interface FakeView {
  cell: number
  group: THREE.Group
  mats: THREE.MeshStandardMaterial[]
  revealed: boolean
}

function doorTexture(accent: string) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = '#10161e'
  g.fillRect(0, 0, 256, 512)
  for (let y = 0; y < 512; y += 64) {
    g.fillStyle = '#18222e'
    g.fillRect(10, y + 6, 236, 52)
    g.strokeStyle = '#06090d'
    g.lineWidth = 3
    g.strokeRect(10, y + 6, 236, 52)
  }
  g.fillStyle = accent
  g.fillRect(0, 238, 256, 10)
  g.fillRect(0, 262, 256, 4)
  g.globalAlpha = 0.85
  for (let i = 0; i < 6; i++) g.fillRect(20 + i * 38, 120, 16, 4)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function emissiveDoorTexture(accent: string) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, 256, 512)
  g.fillStyle = accent
  g.fillRect(0, 238, 256, 10)
  g.fillRect(0, 262, 256, 4)
  for (let i = 0; i < 6; i++) g.fillRect(20 + i * 38, 120, 16, 4)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const doorMats = new Map<number, THREE.MeshStandardMaterial>()
function doorMat(look: number) {
  let m = doorMats.get(look)
  if (!m) {
    const accent = mats(look).look.accent
    m = new THREE.MeshStandardMaterial({
      map: doorTexture(accent),
      emissiveMap: emissiveDoorTexture(accent),
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 1.2,
      metalness: 0.7,
      roughness: 0.35,
    })
    doorMats.set(look, m)
  }
  return m
}

const barrierVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const barrierFrag = /* glsl */ `
uniform float uTime; uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 g = vUv * vec2(10.0, 11.0);
  vec2 cell = fract(g);
  float hex = smoothstep(0.08, 0.0, min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y)));
  float scan = 0.5 + 0.5 * sin(vUv.y * 60.0 - uTime * 6.0);
  float flick = 0.85 + 0.15 * hash(vec2(floor(uTime * 20.0), floor(vUv.y * 40.0)));
  float edge = smoothstep(0.1, 0.0, min(vUv.x, 1.0 - vUv.x)) + smoothstep(0.06, 0.0, min(vUv.y, 1.0 - vUv.y));
  float a = (0.18 + hex * 0.45 + scan * 0.12 + edge * 0.6) * flick * uOpacity;
  gl_FragColor = vec4(uColor * (1.2 + hex + edge), a);
}`

export class WorldView {
  readonly group = new THREE.Group()
  readonly explored: Uint8Array
  private doors: DoorView[] = []
  private doorAt = new Map<number, DoorView>()
  private gates = new Map<number, GateView>()
  private vaults = new Map<string, VaultView>()
  private fakes = new Map<number, FakeView>()
  private barrierMats: THREE.ShaderMaterial[] = []
  /** Points that deserve a real light when the player is near: hubs, arenas, gates. */
  readonly lamps: { x: number; y: number; z: number; color: string; power: number }[] = []
  /** Meshes the crosshair can click: userData.interact holds the object id. */
  readonly pickables: THREE.Object3D[] = []
  private exploredKey = ''
  private exploredDirty = false
  private savedAt = 0

  constructor(
    readonly info: WorldInfo,
    readonly grid: Grid,
    saveKey = '',
  ) {
    this.explored = new Uint8Array(info.width * info.height)
    this.exploredKey = saveKey
    this.loadExplored()
    this.build()
  }

  /** Look index (0..3 sectors, 4 hub) for a cell. */
  lookAt(cx: number, cz: number) {
    if (!this.grid.inside(cx, cz)) return 0
    const i = cz * this.info.width + cx
    return this.grid.hubAt[i] > 0 ? HUB_LOOK : this.info.sector[i]
  }

  private code(cx: number, cz: number) {
    return this.grid.code(cx, cz)
  }

  private build() {
    const { width: W, height: Hh } = this.info
    const walls = new Map<number, Geo>()
    const floors = new Map<number, Geo>()
    const ceilings = new Map<number, Geo>()
    const geo = (m: Map<number, Geo>, k: number) => {
      let g = m.get(k)
      if (!g) m.set(k, (g = new Geo()))
      return g
    }
    for (let z = 0; z < Hh; z++)
      for (let x = 0; x < W; x++) {
        if (this.code(x, z) === WALL) continue
        const look = this.lookAt(x, z)
        const x0 = x * CELL
        const x1 = x0 + CELL
        const z0 = z * CELL
        const z1 = z0 + CELL
        geo(floors, look).quad(
          [
            [x0, 0, z0],
            [x0, 0, z1],
            [x1, 0, z1],
            [x1, 0, z0],
          ],
          [0, 1, 0],
          [
            [x, z],
            [x, z + 1],
            [x + 1, z + 1],
            [x + 1, z],
          ],
        )
        geo(ceilings, look).quad(
          [
            [x0, H, z0],
            [x1, H, z0],
            [x1, H, z1],
            [x0, H, z1],
          ],
          [0, -1, 0],
          [
            [x, z],
            [x + 1, z],
            [x + 1, z + 1],
            [x, z + 1],
          ],
        )
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0]
          const nz = z + DIRS[d][1]
          if (this.code(nx, nz) !== WALL) continue
          const f = wallFace(x, z, d)
          geo(walls, look).quad(f.p, f.n, FACE_UV)
        }
      }
    for (const [look, g] of walls) this.group.add(new THREE.Mesh(g.build(), mats(look).wall))
    for (const [look, g] of floors) this.group.add(new THREE.Mesh(g.build(), mats(look).floor))
    for (const [look, g] of ceilings) this.group.add(new THREE.Mesh(g.build(), mats(look).ceiling))

    for (let i = 0; i < this.info.cells.length; i++) {
      const code = this.info.cells[i]
      const x = i % W
      const z = Math.floor(i / W)
      if (code === DOOR) this.addDoor(i, x, z)
      else if (code === FAKE) this.addFake(i, x, z)
    }
    for (const gate of this.info.gates) this.addGate(gate.cell, gate.x, gate.z, gate.sector)
    for (const v of this.info.vaults) this.addVault(v.id, v.x, v.z, v.lock)

    for (const h of this.info.hubs) this.lamps.push({ x: cellCenter(h.cx), y: H - 0.5, z: cellCenter(h.cz), color: '#ffc27a', power: 90 })
    for (const a of this.info.arenas) this.lamps.push({ x: cellCenter(a.cx), y: H - 0.4, z: cellCenter(a.cz), color: SECTOR_COLORS[a.sector], power: 120 })
    for (const hall of this.info.halls)
      this.lamps.push({ x: ((hall.x0 + hall.x1 + 1) / 2) * CELL, y: H - 0.5, z: ((hall.z0 + hall.z1 + 1) / 2) * CELL, color: SECTOR_COLORS[hall.sector], power: 70 })
  }

  /** Panels run across the passage: along x when the walls are east and west of the door. */
  private passageAlongX(x: number, z: number) {
    const ew = this.code(x - 1, z) === WALL && this.code(x + 1, z) === WALL
    const ns = this.code(x, z - 1) === WALL && this.code(x, z + 1) === WALL
    if (ew && !ns) return true
    if (ns && !ew) return false
    return this.code(x - 1, z) === WALL || this.code(x + 1, z) === WALL
  }

  private addDoor(cell: number, x: number, z: number) {
    const alongX = this.passageAlongX(x, z)
    const mat = doorMat(this.lookAt(x, z))
    const half = new THREE.BoxGeometry(CELL / 2, H, 0.22)
    const a = new THREE.Mesh(half, mat)
    const b = new THREE.Mesh(half, mat)
    const cx = cellCenter(x)
    const cz = cellCenter(z)
    for (const m of [a, b]) {
      m.position.set(cx, H / 2, cz)
      if (!alongX) m.rotation.y = Math.PI / 2
      this.group.add(m)
    }
    const door: DoorView = { cell, x: cx, z: cz, alongX, a, b, open: 0, target: 0 }
    this.placeDoor(door)
    this.doors.push(door)
    this.doorAt.set(cell, door)
  }

  private placeDoor(d: DoorView) {
    const off = CELL / 4 + d.open * (CELL / 2 - 0.1)
    if (d.alongX) {
      d.a.position.x = d.x - off
      d.b.position.x = d.x + off
    } else {
      d.a.position.z = d.z - off
      d.b.position.z = d.z + off
    }
    const shown = d.open < 0.98
    d.a.visible = shown
    d.b.visible = shown
  }

  private addGate(cell: number, x: number, z: number, sector: number) {
    const alongX = this.passageAlongX(x, z)
    const group = new THREE.Group()
    group.position.set(cellCenter(x), 0, cellCenter(z))
    if (!alongX) group.rotation.y = Math.PI / 2
    const color = new THREE.Color(SECTOR_COLORS[sector])
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: color }, uOpacity: { value: 1 } },
      vertexShader: barrierVert,
      fragmentShader: barrierFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    this.barrierMats.push(mat)
    const barrier = new THREE.Mesh(new THREE.PlaneGeometry(CELL - 0.4, H - 0.2), mat)
    barrier.position.y = H / 2
    barrier.userData.interact = `gate:${cell}`
    group.add(barrier)
    const posts = new THREE.MeshStandardMaterial({ color: '#1a222c', emissive: color, emissiveIntensity: 1.6, metalness: 0.8, roughness: 0.3 })
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, H, 0.6), posts)
      post.position.set(s * (CELL / 2 - 0.17), H / 2, 0)
      group.add(post)
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(CELL, 0.35, 0.6), posts)
    top.position.y = H - 0.17
    group.add(top)
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture('SECTOR GATE', SECTOR_COLORS[sector]), transparent: true, depthWrite: false }))
    sign.scale.set(2.6, 0.5, 1)
    sign.position.set(0, H - 0.75, 0)
    group.add(sign)
    this.group.add(group)
    this.pickables.push(barrier)
    this.gates.set(cell, { cell, sector, group, barrier, posts, open: 0 })
    this.lamps.push({ x: cellCenter(x), y: H - 0.6, z: cellCenter(z), color: SECTOR_COLORS[sector], power: 40 })
  }

  private addVault(id: string, x: number, z: number, lock: 'keycard' | 'puzzle') {
    const alongX = this.passageAlongX(x, z)
    const group = new THREE.Group()
    group.position.set(cellCenter(x), 0, cellCenter(z))
    if (!alongX) group.rotation.y = Math.PI / 2
    const slab = new THREE.Group()
    group.add(slab)
    const metal = new THREE.MeshStandardMaterial({ color: '#2a2f38', metalness: 0.9, roughness: 0.35, emissive: '#000000' })
    const body = new THREE.Mesh(new THREE.BoxGeometry(CELL, H, 0.7), metal)
    body.position.y = H / 2
    body.userData.interact = id
    slab.add(body)
    const accent = lock === 'keycard' ? '#ffd34d' : '#c77dff'
    const stripe = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent).multiplyScalar(1.6) })
    for (const y of [0.6, H - 0.6]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(CELL - 0.3, 0.08, 0.74), stripe)
      s.position.y = y
      slab.add(s)
    }
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3b5c').multiplyScalar(2) })
    for (const side of [-1, 1]) {
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), lamp)
      l.position.set(0.9, 1.6, side * 0.36)
      if (side < 0) l.rotation.y = Math.PI
      slab.add(l)
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 1.2),
        new THREE.MeshBasicMaterial({ map: urlTexture(icon(lock === 'keycard' ? 'item:keycard' : 'ui:puzzle')), transparent: true }),
      )
      plate.position.set(-0.6, 1.8, side * 0.36)
      if (side < 0) plate.rotation.y = Math.PI
      slab.add(plate)
    }
    this.group.add(group)
    this.pickables.push(body)
    this.vaults.set(id, { id, group, slab, lamp, open: 0 })
  }

  private addFake(cell: number, x: number, z: number) {
    const group = new THREE.Group()
    const list: THREE.MeshStandardMaterial[] = []
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0]
      const nz = z + DIRS[d][1]
      if (this.code(nx, nz) === WALL || this.code(nx, nz) === FAKE) continue
      // The face seen from the neighbouring cell: that cell's wall face pointing back at us.
      const back = (d + 2) % 4
      const f = wallFace(nx, nz, back)
      const g = new Geo()
      g.quad(f.p, f.n, FACE_UV)
      const base = mats(this.lookAt(nx, nz)).wall
      const mat = base.clone()
      mat.map = base.map!.clone()
      mat.map.needsUpdate = true
      list.push(mat)
      const mesh = new THREE.Mesh(g.build(), mat)
      mesh.userData.fake = cell
      group.add(mesh)
    }
    this.group.add(group)
    this.fakes.set(cell, { cell, group, mats: list, revealed: false })
  }

  /** Applies opened gates, vaults and revealed fake walls. */
  applyState(state: WorldState) {
    for (const [cell, f] of this.fakes) {
      const rev = state.fakes.includes(cell)
      f.revealed = rev
      f.group.visible = !rev
    }
    for (const g of this.gates.values()) g.barrier.userData.open = state.gates.includes(g.cell)
    for (const v of this.vaults.values()) v.slab.userData.open = state.vaults.includes(v.id)
  }

  /** Doors open for nearby players and for hunting monsters, like on the server. */
  updateDoors(movers: { x: number; z: number }[]) {
    const open = this.grid.doorOpen
    for (const d of this.doors) {
      let want = 0
      for (const m of movers) {
        if (Math.abs(m.x - d.x) < DOOR_RANGE && Math.abs(m.z - d.z) < DOOR_RANGE && Math.hypot(m.x - d.x, m.z - d.z) < DOOR_RANGE) {
          want = 1
          break
        }
      }
      d.target = want
      open[d.cell] = want
    }
  }

  /** Is the door on this cell sliding or open (for sounds). */
  doorTarget(cell: number) {
    return this.doorAt.get(cell)?.target ?? 0
  }

  update(dt: number, time: number, onDoor?: (x: number, z: number, opening: boolean) => void) {
    for (const d of this.doors) {
      if (d.open === d.target) continue
      const was = d.open
      d.open = d.target > d.open ? Math.min(1, d.open + dt * 3.2) : Math.max(0, d.open - dt * 2.4)
      if ((was === 0 || was === 1) && onDoor) onDoor(d.x, d.z, d.target > was)
      this.placeDoor(d)
    }
    for (const m of this.barrierMats) m.uniforms.uTime.value = time
    for (const g of this.gates.values()) {
      const want = g.barrier.userData.open ? 1 : 0
      g.open += (want - g.open) * Math.min(1, dt * 2)
      ;(g.barrier.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1 - g.open
      g.barrier.visible = g.open < 0.98
      g.posts.emissive.set(want ? '#7dff9a' : SECTOR_COLORS[g.sector])
    }
    for (const v of this.vaults.values()) {
      const want = v.slab.userData.open ? 1 : 0
      v.open = want ? Math.min(1, v.open + dt * 0.6) : Math.max(0, v.open - dt)
      v.slab.position.y = v.open * (H - 0.3)
      v.slab.visible = v.open < 0.99
      v.lamp.color.set(want ? '#7dff9a' : '#ff3b5c').multiplyScalar(2)
    }
    // Fake walls give themselves away with a rare flicker, for those who look closely.
    for (const f of this.fakes.values()) {
      if (f.revealed) continue
      const phase = (time + f.cell * 0.37) % 7
      const glitch = phase < 0.18
      for (const m of f.mats) {
        m.emissiveIntensity = (m.userData.base ?? 1) * (glitch ? 1.8 + Math.random() : 1)
        m.map!.offset.x = glitch ? (Math.random() - 0.5) * 0.04 : 0
      }
    }
  }

  /** Brightness multiplier on every surface (power outages). */
  setPower(look: number, k: number) {
    const m = mats(look)
    for (const mat of [m.wall, m.floor, m.ceiling]) mat.emissiveIntensity = (mat.userData.base as number) * k
  }

  // --- Exploration (for the map) ------------------------------------------------------------------
  reveal(x: number, z: number) {
    const R = 7
    const pcx = toCell(x)
    const pcz = toCell(z)
    const W = this.info.width
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const cx = pcx + dx
        const cz = pcz + dz
        if (!this.grid.inside(cx, cz)) continue
        const i = cz * W + cx
        if (this.explored[i]) continue
        const tx = cellCenter(cx)
        const tz = cellCenter(cz)
        const d = Math.hypot(tx - x, tz - z)
        if (d > R * CELL) continue
        if (this.grid.ray(x, z, tx - x, tz - z, d, Mode.Sight) >= d - CELL * 0.75) {
          this.explored[i] = 1
          this.exploredDirty = true
        }
      }
    const t = performance.now()
    if (this.exploredDirty && t - this.savedAt > 5000) this.saveExplored()
  }

  private loadExplored() {
    if (!this.exploredKey) return
    try {
      const raw = localStorage.getItem(this.exploredKey)
      if (!raw) return
      const bin = atob(raw)
      for (let i = 0; i < Math.min(bin.length * 8, this.explored.length); i++) this.explored[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1
    } catch {
      /* ignore */
    }
  }

  saveExplored() {
    this.savedAt = performance.now()
    this.exploredDirty = false
    if (!this.exploredKey) return
    try {
      const bytes = new Uint8Array(Math.ceil(this.explored.length / 8))
      for (let i = 0; i < this.explored.length; i++) if (this.explored[i]) bytes[i >> 3] |= 1 << (i & 7)
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      localStorage.setItem(this.exploredKey, btoa(s))
    } catch {
      /* ignore */
    }
  }

  dispose() {
    this.saveExplored()
    this.group.removeFromParent()
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    for (const f of this.fakes.values()) for (const m of f.mats) m.dispose()
    for (const m of this.barrierMats) m.dispose()
  }
}

/** A faint glitch overlay used on revealed secret openings. */
export function glitchSprite() {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: noiseTexture(), color: '#c77dff', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }))
  s.scale.set(3, 3, 1)
  return s
}

export const glow = glowTexture()
