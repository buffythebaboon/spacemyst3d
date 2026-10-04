// World objects: hub stations, chests, data pads, puzzle pieces and traps.
import * as THREE from 'three'
import type { CharacterData } from '../../shared/character.ts'
import { CELL, SECTOR_COLORS, WALL_HEIGHT, cellCenter } from '../../shared/constants.ts'
import { FRAGMENTS } from '../../shared/lore.ts'
import { DIRS, GLYPHS, RELAY_COLORS, RELAY_NAMES, traceBeam, type Puzzle, type WorldInfo, type WorldObject, type WorldState } from '../../shared/world.ts'
import { icon } from './art/icons.ts'
import { glowTexture, labelTexture, panelTexture, ringTexture, urlTexture } from './textures.ts'

const H = WALL_HEIGHT
const glow = glowTexture()

const dark = new THREE.MeshStandardMaterial({ color: '#18202a', metalness: 0.8, roughness: 0.38 })
const mid = new THREE.MeshStandardMaterial({ color: '#2b3744', metalness: 0.75, roughness: 0.4 })
const basic = (color: THREE.ColorRepresentation, k = 1.6) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) })

function sprite(map: THREE.Texture, w: number, h: number, opts: { color?: THREE.ColorRepresentation; additive?: boolean; opacity?: number } = {}) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map,
      color: opts.color ?? '#ffffff',
      transparent: true,
      depthWrite: false,
      opacity: opts.opacity ?? 1,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }),
  )
  s.scale.set(w, h, 1)
  return s
}

function glowSprite(color: THREE.ColorRepresentation, size: number, opacity = 0.6) {
  return sprite(glow, size, size, { color, additive: true, opacity })
}

/** Invisible box the crosshair can hit. */
function hitBox(w: number, h: number, d: number, id: string, kind: string) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }))
  m.userData.interact = id
  m.userData.kind = kind
  return m
}

/** Offset from a cell centre to the wall on side `dir`, and the yaw that faces away from that wall. */
function wallMount(dir: number) {
  const [dx, dz] = DIRS[dir]
  const off = CELL / 2 - 0.12
  // A plane's front faces +z; turn it so it faces into the cell (away from the wall).
  const yaw = Math.atan2(-dx, -dz)
  return { ox: dx * off, oz: dz * off, yaw }
}

interface Prop {
  o: WorldObject
  group: THREE.Group
  x: number
  z: number
  update?: (ctx: PropCtx, dt: number) => void
}

export interface PropCtx {
  time: number
  serverTime: number
  state: WorldState
  char: CharacterData | null
}

export class Props {
  readonly group = new THREE.Group()
  readonly pickables: THREE.Object3D[] = []
  private props: Prop[] = []
  private byId = new Map<string, Prop>()
  private beams = new Map<string, { group: THREE.Group; key: string; receiver?: Prop }>()
  private puzzles: Map<string, Puzzle>

  constructor(private info: WorldInfo) {
    this.puzzles = new Map(info.puzzles.map((p) => [p.id, p]))
    for (const o of info.objects) this.add(o)
    for (const pz of info.puzzles) if (pz.kind === 'mirror' && pz.lab) this.beams.set(pz.id, { group: new THREE.Group(), key: '' })
    for (const b of this.beams.values()) this.group.add(b.group)
  }

  get(id: string) {
    return this.byId.get(id)?.o
  }

  private add(o: WorldObject) {
    const group = new THREE.Group()
    const x = cellCenter(o.x)
    const z = cellCenter(o.z)
    group.position.set(x, 0, z)
    const prop: Prop = { o, group, x, z }
    const hub = this.info.hubs.find((h) => h.id === o.hub)
    const faceHub = hub ? Math.atan2(cellCenter(hub.cx) - x, cellCenter(hub.cz) - z) : 0
    const pick = (m: THREE.Object3D) => {
      group.add(m)
      this.pickables.push(m)
    }
    switch (o.kind) {
      case 'shop': {
        group.rotation.y = faceHub
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.5, 0.8), dark)
        body.position.y = 0.75
        group.add(body)
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9), new THREE.MeshBasicMaterial({ map: panelTexture(['Weapons, armour, potions, grenades.', 'Sell your junk here.'], '#ffb347', { title: 'BLACK MARKET', width: 512, height: 384 }) }))
        screen.position.set(0, 1.9, 0.1)
        group.add(screen)
        const icn = sprite(urlTexture(icon('ui:shop')), 0.8, 0.8)
        icn.position.y = 2.9
        group.add(icn)
        const halo = glowSprite('#ffb347', 3, 0.35)
        halo.position.set(0, 1.9, 0.2)
        group.add(halo)
        pick(hitBox(1.6, 2.6, 1.2, o.id, o.kind).translateY(1.3))
        prop.update = (c) => {
          icn.position.y = 2.9 + Math.sin(c.time * 2) * 0.08
        }
        break
      }
      case 'board': {
        group.rotation.y = faceHub
        for (const s of [-1, 1]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), mid)
          leg.position.set(s * 0.95, 1.3, 0)
          group.add(leg)
        }
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(1.9, 1.4),
          new THREE.MeshBasicMaterial({ map: panelTexture(['> Purge contracts', '> Bounties on elites', '> Lost data cores', '> Sealed vaults'], '#5cf2ff', { title: 'QUEST BOARD', width: 512, height: 384 }), side: THREE.DoubleSide }),
        )
        panel.position.y = 1.85
        group.add(panel)
        const icn = sprite(urlTexture(icon('ui:board')), 0.7, 0.7)
        icn.position.y = 2.95
        group.add(icn)
        pick(hitBox(2.1, 2.8, 0.8, o.id, o.kind).translateY(1.4))
        break
      }
      case 'repair': {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.25, 24), mid)
        base.position.y = 0.12
        group.add(base)
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color('#7dff9a').multiplyScalar(1.5), transparent: true, side: THREE.DoubleSide }))
        ring.rotation.x = -Math.PI / 2
        ring.position.y = 0.27
        group.add(ring)
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.6, 24, 1, true), new THREE.MeshBasicMaterial({ color: '#7dff9a', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))
        column.position.y = 1.55
        group.add(column)
        const icn = sprite(urlTexture(icon('ui:repair')), 0.9, 0.9)
        icn.position.y = 1.6
        group.add(icn)
        pick(hitBox(2, 2.8, 2, o.id, o.kind).translateY(1.4))
        prop.update = (c) => {
          icn.position.y = 1.6 + Math.sin(c.time * 1.6) * 0.15
          ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(c.time * 3) * 0.3
        }
        break
      }
      case 'beacon': {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 2.2, 12), dark)
        pillar.position.y = 1.1
        group.add(pillar)
        const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), basic('#5cf2ff', 2))
        core.position.y = 2.6
        group.add(core)
        const rings: THREE.Mesh[] = []
        for (let i = 0; i < 3; i++) {
          const r = new THREE.Mesh(new THREE.TorusGeometry(0.6 + i * 0.18, 0.025, 6, 40), basic('#5cf2ff', 1.4))
          r.position.y = 2.6
          group.add(r)
          rings.push(r)
        }
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, H, 8, 1, true), new THREE.MeshBasicMaterial({ color: '#5cf2ff', transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }))
        beam.position.y = H / 2
        group.add(beam)
        pick(hitBox(1.4, 3.4, 1.4, o.id, o.kind).translateY(1.7))
        prop.update = (c) => {
          core.rotation.y = c.time * 1.5
          rings.forEach((r, i) => {
            r.rotation.x = c.time * (0.6 + i * 0.3)
            r.rotation.y = c.time * (0.4 + i * 0.2)
          })
        }
        break
      }
      case 'chest': {
        const color = o.vault ? '#ffd34d' : SECTOR_COLORS[Math.min(3, o.tier ?? o.sector)]
        group.rotation.y = (o.x * 7 + o.z * 3) % 4 * (Math.PI / 2)
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.62, 0.85), mid)
        box.position.y = 0.31
        group.add(box)
        const seam = basic(color, 1.8)
        const band = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.06, 0.89), seam)
        band.position.y = 0.5
        group.add(band)
        const lidPivot = new THREE.Group()
        lidPivot.position.set(0, 0.62, -0.42)
        group.add(lidPivot)
        const lid = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.22, 0.85), dark)
        lid.position.set(0, 0.11, 0.42)
        lidPivot.add(lid)
        const g = glowSprite(color, 1.6, 0.45)
        g.position.y = 0.7
        group.add(g)
        pick(hitBox(1.5, 1.2, 1.1, o.id, o.kind).translateY(0.6))
        prop.update = (c) => {
          const opened = !!c.char?.chests.includes(o.id)
          const locked = !!o.vault && !c.state.vaults.includes(o.vault)
          lidPivot.rotation.x += ((opened ? -1.2 : 0) - lidPivot.rotation.x) * 0.1
          g.visible = !opened && !locked
          seam.color.set(opened ? '#3a4652' : color).multiplyScalar(opened ? 1 : 1.8)
        }
        break
      }
      case 'fragment': {
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.22, 1.0, 8), mid)
        stand.position.y = 0.5
        group.add(stand)
        const pad = new THREE.Group()
        pad.position.y = 1.25
        group.add(pad)
        const slab = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.04, 0.8), dark)
        pad.add(slab)
        const screenMat = new THREE.MeshBasicMaterial({ map: urlTexture(icon('item:fragment')), transparent: true })
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), screenMat)
        screen.rotation.x = -Math.PI / 2
        screen.position.y = 0.025
        pad.add(screen)
        const g = glowSprite('#5cf2ff', 1.5, 0.5)
        g.position.y = 1.3
        group.add(g)
        pick(hitBox(1, 1.8, 1, o.id, o.kind).translateY(0.9))
        prop.update = (c) => {
          const read = !!c.char && c.char.codex.includes(o.fragment ?? -1)
          pad.rotation.y = c.time * 0.6
          pad.rotation.x = -0.35
          pad.position.y = 1.25 + Math.sin(c.time * 2 + o.x) * 0.06
          g.material.opacity = read ? 0.12 : 0.5
          screenMat.color.setScalar(read ? 0.45 : 1)
        }
        break
      }
      case 'relay': {
        const m = wallMount(o.dir ?? 0)
        const mount = new THREE.Group()
        mount.position.set(m.ox, 0, m.oz)
        mount.rotation.y = m.yaw
        group.add(mount)
        const color = RELAY_COLORS[o.color ?? 0]
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.28), dark)
        box.position.set(0, 1.4, 0.14)
        mount.add(box)
        const lampMat = basic(color, 0.35)
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), lampMat)
        lamp.position.set(0, 1.8, 0.32)
        mount.add(lamp)
        const lever = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.45, 0.1), mid)
        lever.position.set(0, 1.2, 0.34)
        mount.add(lever)
        const label = sprite(labelTexture(`RELAY ${RELAY_NAMES[o.color ?? 0]}`, color), 1.4, 0.26)
        label.position.set(0, 2.35, 0.3)
        mount.add(label)
        const g = glowSprite(color, 1.2, 0)
        g.position.set(0, 1.8, 0.4)
        mount.add(g)
        const hb = hitBox(1.1, 1.6, 0.8, o.id, o.kind)
        hb.position.set(0, 1.4, 0.3)
        mount.add(hb)
        this.pickables.push(hb)
        prop.update = (c) => {
          const pz = o.puzzle ?? ''
          const on = c.state.solved.includes(pz) || (c.state.relays[pz] ?? []).includes(o.color ?? 0)
          lampMat.color.set(color).multiplyScalar(on ? 2.2 : 0.35)
          g.material.opacity = on ? 0.7 : 0
          lever.rotation.x = on ? -0.6 : 0.6
        }
        break
      }
      case 'clue': {
        const m = wallMount(o.dir ?? 0)
        const mount = new THREE.Group()
        mount.position.set(m.ox + (DIRS[o.dir ?? 0][0] * 0.1), 0, m.oz + DIRS[o.dir ?? 0][1] * 0.1)
        mount.rotation.y = m.yaw
        group.add(mount)
        const pz = this.puzzles.get(o.puzzle ?? '')
        if (pz?.kind === 'relay') {
          const tex = panelTexture([(pz.riddle ?? '').replace(/^Maintenance log:\s*/i, '')], '#ffb347', { title: 'MAINTENANCE LOG', width: 512, height: 512, size: 30 })
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.7), new THREE.MeshBasicMaterial({ map: tex }))
          plane.position.set(0, 1.75, 0.02)
          mount.add(plane)
        } else {
          const glyph = GLYPHS[o.glyph ?? 0]
          const tex = labelTexture(glyph, '#ff4fd8', { width: 256, height: 256, font: '700 180px "Share Tech Mono", monospace', sub: `${(o.index ?? 0) + 1} / 4`, subColor: '#ffb6ef' })
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }))
          plane.position.set(0, 2.0, 0.02)
          mount.add(plane)
        }
        const hb = hitBox(1.8, 1.8, 0.6, o.id, o.kind)
        hb.position.set(0, 1.8, 0.2)
        mount.add(hb)
        this.pickables.push(hb)
        break
      }
      case 'cipher': {
        const m = wallMount(o.dir ?? 0)
        const mount = new THREE.Group()
        mount.position.set(m.ox, 0, m.oz)
        mount.rotation.y = m.yaw
        group.add(mount)
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.22), dark)
        box.position.set(0, 1.55, 0.11)
        mount.add(box)
        const screenMat = new THREE.MeshBasicMaterial({ map: labelTexture('? ? ? ?', '#ff4fd8', { width: 512, height: 128 }), transparent: true })
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.36), screenMat)
        screen.position.set(0, 1.7, 0.23)
        mount.add(screen)
        const label = sprite(labelTexture('CIPHER LOCK', '#ff4fd8'), 1.4, 0.26)
        label.position.set(0, 2.35, 0.25)
        mount.add(label)
        const hb = hitBox(1.8, 1.4, 0.8, o.id, o.kind)
        hb.position.set(0, 1.55, 0.3)
        mount.add(hb)
        this.pickables.push(hb)
        prop.update = (c) => {
          const solved = c.state.solved.includes(o.puzzle ?? '')
          screenMat.color.set(solved ? '#7dff9a' : '#ffffff')
        }
        break
      }
      case 'mirror': {
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 0.5, 10), mid)
        stand.position.y = 0.25
        group.add(stand)
        const pivot = new THREE.Group()
        pivot.position.y = 1.3
        group.add(pivot)
        const frame = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.6, 0.12), dark)
        pivot.add(frame)
        const glass = new THREE.MeshStandardMaterial({ color: '#cfefff', metalness: 1, roughness: 0.05, emissive: '#2a6a88', emissiveIntensity: 0.6 })
        for (const s of [-1, 1]) {
          const face = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.4), glass)
          face.position.z = s * 0.065
          if (s < 0) face.rotation.y = Math.PI
          pivot.add(face)
        }
        pick(hitBox(1.8, 2.2, 1.8, o.id, o.kind).translateY(1.1))
        pivot.rotation.y = (o.orient ?? 0) === 0 ? Math.PI / 4 : -Math.PI / 4
        prop.update = (c) => {
          const orient = c.state.mirrors[o.id] ?? o.orient ?? 0
          const want = orient === 0 ? Math.PI / 4 : -Math.PI / 4
          pivot.rotation.y += (want - pivot.rotation.y) * 0.15
        }
        break
      }
      case 'emitter':
      case 'receiver': {
        const m = wallMount(o.dir ?? 0)
        const mount = new THREE.Group()
        mount.position.set(m.ox, 0, m.oz)
        mount.rotation.y = m.yaw
        group.add(mount)
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.5, 16).rotateX(Math.PI / 2), dark)
        body.position.set(0, 1.2, 0.2)
        mount.add(body)
        const lensMat = basic(o.kind === 'emitter' ? '#ff3b5c' : '#3a4652', o.kind === 'emitter' ? 2 : 1)
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.26, 20), lensMat)
        lens.position.set(0, 1.2, 0.46)
        mount.add(lens)
        if (o.kind === 'receiver') {
          const label = sprite(labelTexture('RECEIVER', '#ff3b5c'), 1.2, 0.24)
          label.position.set(0, 1.9, 0.4)
          mount.add(label)
          prop.update = (c) => {
            const solved = c.state.solved.includes(o.puzzle ?? '')
            lensMat.color.set(solved ? '#7dff9a' : '#3a4652').multiplyScalar(solved ? 2 : 1)
          }
          const beam = this.beams.get(o.puzzle ?? '')
          if (beam) beam.receiver = prop
        }
        break
      }
      case 'plate': {
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.08, 32), mid)
        disc.position.y = 0.04
        group.add(disc)
        const ringMat = new THREE.MeshBasicMaterial({ map: ringTexture(), color: '#ffd34d', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
        const ring = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), ringMat)
        ring.rotation.x = -Math.PI / 2
        ring.position.y = 0.1
        group.add(ring)
        const label = sprite(labelTexture(`PLATE ${(o.index ?? 0) === 0 ? 'A' : 'B'}`, '#ffd34d'), 1.2, 0.24)
        label.position.y = 0.9
        group.add(label)
        prop.update = (c) => {
          const solved = c.state.solved.includes(o.puzzle ?? '')
          const down = solved || c.state.plates.includes(o.id)
          disc.position.y = down ? 0.0 : 0.04
          ringMat.color.set(solved ? '#7dff9a' : down ? '#ffffff' : '#ffd34d')
          ringMat.opacity = down ? 1 : 0.45 + Math.sin(c.time * 3) * 0.2
        }
        break
      }
      case 'laser': {
        const alongX = (o.dir ?? 0) === 0
        const beams: THREE.Mesh[] = []
        const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2340').multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
        for (const y of [0.35, 0.8, 1.25, 1.7, 2.15]) {
          const b = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, CELL, 6).rotateZ(Math.PI / 2), beamMat)
          b.position.y = y
          if (!alongX) b.rotation.y = Math.PI / 2
          group.add(b)
          beams.push(b)
        }
        for (const s of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.4, 0.3), dark)
          post.position.set(alongX ? s * (CELL / 2 - 0.08) : 0, 1.2, alongX ? 0 : s * (CELL / 2 - 0.08))
          if (!alongX) post.rotation.y = Math.PI / 2
          group.add(post)
        }
        const g = glowSprite('#ff2340', 3.4, 0)
        g.position.y = 1.2
        group.add(g)
        prop.update = (c) => {
          const t = (((c.serverTime + (o.phase ?? 0)) % 4) + 4) % 4
          const live = t < 2
          const warn = !live && t > 3.5
          beamMat.opacity = live ? 0.9 + Math.random() * 0.1 : warn ? (Math.sin(c.time * 40) > 0 ? 0.25 : 0.05) : 0
          for (const b of beams) b.visible = live || warn
          g.material.opacity = live ? 0.35 : 0
        }
        break
      }
      case 'electric': {
        const grate = new THREE.Mesh(new THREE.PlaneGeometry(CELL - 0.3, CELL - 0.3), new THREE.MeshStandardMaterial({ color: '#1a2532', metalness: 0.9, roughness: 0.3, emissive: '#3c7bff', emissiveIntensity: 0.1, emissiveMap: gridTexture() }))
        grate.rotation.x = -Math.PI / 2
        grate.position.y = 0.02
        group.add(grate)
        const mat = grate.material as THREE.MeshStandardMaterial
        const arcs: THREE.Sprite[] = []
        for (let i = 0; i < 5; i++) {
          const s = glowSprite('#7fb2ff', 0.8, 0)
          arcs.push(s)
          group.add(s)
        }
        prop.update = (c) => {
          const t = (((c.serverTime + (o.phase ?? 0)) % 4) + 4) % 4
          const live = t >= 2.5
          const warn = !live && t > 2.0
          mat.emissiveIntensity = live ? 2.2 + Math.random() : warn ? (Math.sin(c.time * 30) > 0 ? 0.8 : 0.1) : 0.12
          for (const s of arcs) {
            s.material.opacity = live ? Math.random() : 0
            if (live) s.position.set((Math.random() - 0.5) * (CELL - 0.6), 0.1 + Math.random() * 0.5, (Math.random() - 0.5) * (CELL - 0.6))
          }
        }
        break
      }
      case 'turret': {
        const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.3, 16), dark)
        mount.position.y = H - 0.15
        group.add(mount)
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 8), mid)
        arm.position.y = H - 0.5
        group.add(arm)
        const sparks = glowSprite('#ffb347', 0.6, 0)
        sparks.position.y = H - 0.4
        group.add(sparks)
        prop.update = (c) => {
          const down = c.state.turretsDown.includes(o.id)
          arm.visible = !down
          sparks.material.opacity = down && Math.random() < 0.15 ? 1 : 0
        }
        break
      }
    }
    this.group.add(group)
    this.props.push(prop)
    this.byId.set(o.id, prop)
  }

  /** Redraws the mirror lab beams when the mirrors change. */
  private updateBeams(state: WorldState) {
    for (const [pid, b] of this.beams) {
      const pz = this.puzzles.get(pid)
      if (!pz?.lab) continue
      const solved = state.solved.includes(pid)
      const mirrors = this.info.objects.filter((o) => o.kind === 'mirror' && o.puzzle === pid)
      const key = mirrors.map((m) => state.mirrors[m.id] ?? m.orient ?? 0).join('') + (solved ? 's' : '')
      if (key === b.key) continue
      b.key = key
      for (const c of [...b.group.children]) {
        b.group.remove(c)
        ;(c as THREE.Mesh).geometry?.dispose()
      }
      const byCell = new Map(mirrors.map((m) => [`${m.x},${m.z}`, m]))
      const res = traceBeam(pz.lab, (x, z) => {
        const m = byCell.get(`${x},${z}`)
        return m ? (state.mirrors[m.id] ?? m.orient ?? 0) : undefined
      })
      const color = solved ? '#7dff9a' : '#ff3b5c'
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
      // Start at the emitter on the wall behind the entry cell.
      const entry = pz.lab.entry
      const pts: THREE.Vector3[] = [new THREE.Vector3(cellCenter(entry.x) - DIRS[entry.dir][0] * (CELL / 2 - 0.3), 1.2, cellCenter(entry.z) - DIRS[entry.dir][1] * (CELL / 2 - 0.3))]
      for (const [x, z] of res.path) pts.push(new THREE.Vector3(cellCenter(x), 1.2, cellCenter(z)))
      const last = res.path[res.path.length - 1]
      if (last) {
        // Carry the beam on to the wall it ends on.
        const prev = res.path.length > 1 ? res.path[res.path.length - 2] : [entry.x - DIRS[entry.dir][0], entry.z - DIRS[entry.dir][1]]
        let dx = last[0] - prev[0]
        let dz = last[1] - prev[1]
        const mm = byCell.get(`${last[0]},${last[1]}`)
        if (mm) {
          const dir = DIRS.findIndex(([a, b]) => a === Math.sign(dx) && b === Math.sign(dz))
          const orient = state.mirrors[mm.id] ?? mm.orient ?? 0
          const nd = orient === 0 ? [1, 0, 3, 2][dir] : [3, 2, 1, 0][dir]
          dx = DIRS[nd][0]
          dz = DIRS[nd][1]
        }
        pts.push(new THREE.Vector3(cellCenter(last[0]) + Math.sign(dx) * (CELL / 2 - 0.1), 1.2, cellCenter(last[1]) + Math.sign(dz) * (CELL / 2 - 0.1)))
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const bb = pts[i + 1]
        const len = a.distanceTo(bb)
        if (len < 0.01) continue
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, len, 6).rotateX(Math.PI / 2).translate(0, 0, len / 2), mat)
        seg.position.copy(a)
        seg.lookAt(bb)
        b.group.add(seg)
      }
    }
  }

  update(ctx: PropCtx, dt: number, eyeX: number, eyeZ: number) {
    this.updateBeams(ctx.state)
    for (const p of this.props) {
      const near = Math.abs(p.x - eyeX) < 56 && Math.abs(p.z - eyeZ) < 56
      p.group.visible = near
      if (near && p.update) p.update(ctx, dt)
    }
  }

  /** What clicking a prop does, for the crosshair prompt. */
  prompt(id: string, ctx: PropCtx): string {
    const o = this.byId.get(id)?.o
    if (!o) return ''
    switch (o.kind) {
      case 'shop':
        return 'Open the black market'
      case 'board':
        return 'Browse the quest board'
      case 'repair':
        return 'Repair and set your respawn point'
      case 'beacon':
        return 'Fast travel'
      case 'chest':
        if (o.vault && !ctx.state.vaults.includes(o.vault)) return 'Locked inside the vault'
        return ctx.char?.chests.includes(o.id) ? 'Emptied' : 'Open the supply chest'
      case 'fragment':
        return ctx.char?.codex.includes(o.fragment ?? -1) ? `Read "${FRAGMENTS[o.fragment ?? 0]?.title ?? 'Data fragment'}" again` : 'Read the data fragment'
      case 'relay':
        return `Switch on the ${RELAY_NAMES[o.color ?? 0]} relay`
      case 'clue':
        return this.puzzles.get(o.puzzle ?? '')?.kind === 'relay' ? 'Read the maintenance log' : 'Examine the glyph'
      case 'cipher':
        return 'Use the cipher lock'
      case 'mirror':
        return 'Turn the mirror'
      default:
        return ''
    }
  }

  dispose() {
    this.group.removeFromParent()
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
  }
}

let grid: THREE.Texture | null = null
function gridTexture() {
  if (grid) return grid
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, 256, 256)
  g.strokeStyle = '#7fb2ff'
  g.lineWidth = 4
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i, 256)
    g.moveTo(0, i)
    g.lineTo(256, i)
    g.stroke()
  }
  grid = new THREE.CanvasTexture(c)
  grid.colorSpace = THREE.SRGBColorSpace
  return grid
}
