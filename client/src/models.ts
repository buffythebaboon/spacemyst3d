// The monsters as animated 3D models. Every model is built at runtime from three.js shapes, so the
// game ships no model files. A kind is built once as a template; each monster on screen is a clone
// that shares the template's geometry but owns its materials, so a hit, a freeze or an elite glow
// tints one monster and not the whole pack. Shapes that move together and share a material are
// merged into one mesh, which keeps a crowd of monsters cheap to draw.
//
// Models face -Z and stand on y = 0. Most are built one unit tall and scaled by the monster's size;
// the turret and the firewall node are built in metres, like the rooms they are bolted into.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** What a monster is doing this frame, as the animations read it. */
export interface Anim {
  /** Animation clock in seconds. It stops while the monster is frozen. */
  t: number
  dt: number
  /** Ground speed in body lengths per second. */
  pace: number
  /** Body lengths walked so far, which drives the gait. */
  walk: number
  /** 0..1 while an attack is being telegraphed. */
  windup: number
  /** 1 as an attack lands, fading to 0. */
  strike: number
  /** Health left, 0..1. */
  hp: number
  /** 0..1, kind specific: how close a logic bomb is to going off. */
  special: number
  /** A fixed random number per monster, so a pack does not move in step. */
  seed: number
}

type V3 = [number, number, number]
type Nodes = Record<string, THREE.Object3D>
type Mats = Record<string, THREE.Material>

interface Kind {
  mats: (color: THREE.Color) => Mats
  build: (b: Build, color: THREE.Color) => void
  anim: (n: Nodes, a: Anim, legs: THREE.Object3D[]) => void
  /** Built in metres and scaled by the monster's own scale only. */
  fixed?: boolean
}

// --- Shapes and materials --------------------------------------------------------------------------
const PI = Math.PI
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)
const sph = (r: number, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h)
const cyl = (rt: number, rb: number, h: number, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s)
const cone = (r: number, h: number, s = 8) => new THREE.ConeGeometry(r, h, s)
/** A cone with no base, for trails and jets. */
const funnel = (r: number, h: number, s = 12) => new THREE.ConeGeometry(r, h, s, 1, true)
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)
const rbox = (w: number, h: number, d: number, r = 0.025) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.1, h / 2.1, d / 2.1))
const tor = (R: number, r: number, rs = 6, ts = 32, arc = PI * 2) => new THREE.TorusGeometry(R, r, rs, ts, arc)
/** A limb segment from the origin along +X. */
const segX = (len: number, r0: number, r1 = r0, s = 8) => cyl(r1, r0, len, s).rotateZ(-PI / 2).translate(len / 2, 0, 0)
/** A limb segment from the origin down -Y. */
const segD = (len: number, r0: number, r1 = r0, s = 8) => cyl(r0, r1, len, s).translate(0, -len / 2, 0)
/** A limb segment from the origin back along +Z. */
const segZ = (len: number, r0: number, r1 = r0, s = 8) => cyl(r1, r0, len, s).rotateX(PI / 2).translate(0, 0, len / 2)
const UP = new THREE.Vector3(0, 1, 0)
/** A tapered rod from a to b. */
function link(a: V3, b: V3, r0: number, r1 = r0, s = 6) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const g = cyl(r1, r0, d.length(), s).translate(0, d.length() / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()))
  return g.translate(...a)
}

/** A copy reflected across x = 0, with its triangles turned so they still face out. */
function mirrorX(geo: THREE.BufferGeometry) {
  const g = (geo.index ? geo.toNonIndexed() : geo.clone()).scale(-1, 1, 1)
  for (const attr of Object.values(g.attributes) as THREE.BufferAttribute[]) {
    const a = attr.array as Float32Array
    const n = attr.itemSize
    for (let t = 0; t + 3 * n <= a.length; t += 3 * n)
      for (let k = 0; k < n; k++) {
        const v = a[t + n + k]
        a[t + n + k] = a[t + 2 * n + k]
        a[t + 2 * n + k] = v
      }
  }
  return g
}

const std = (color: string, metalness = 0.7, roughness = 0.35, emissive = '#000000', emissiveIntensity = 1) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, emissive, emissiveIntensity })
/** Unlit and brighter than white, so the bloom pass makes it glow. */
const glow = (color: THREE.ColorRepresentation, k = 1.5) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) })
const additive = (color: THREE.ColorRepresentation, opacity = 1, map: THREE.Texture | null = null) =>
  new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })

const M = new THREE.Matrix4()
const Q = new THREE.Quaternion()
const E = new THREE.Euler()
const P = new THREE.Vector3()
const S = new THREE.Vector3()

/** Collects shapes per node and material, then merges each group into one mesh. */
class Build {
  readonly root = new THREE.Group()
  private parts = new Map<THREE.Object3D, Map<string, THREE.BufferGeometry[]>>()
  constructor(readonly mats: Mats) {}

  node(name: string, parent: THREE.Object3D = this.root, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0]) {
    const g = new THREE.Group()
    g.name = name
    g.position.set(...p)
    g.rotation.set(...r)
    parent.add(g)
    return g
  }

  add(to: THREE.Object3D, mat: string, geo: THREE.BufferGeometry, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: number | V3 = 1) {
    if (typeof s === 'number') S.set(s, s, s)
    else S.set(...s)
    M.compose(P.set(...p), Q.setFromEuler(E.set(...r)), S)
    const g = geo.index ? geo.toNonIndexed() : geo.clone()
    geo.dispose()
    g.applyMatrix4(M)
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k)
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((g.attributes.position.count * 2) | 0), 2))
    if (!g.attributes.normal) g.computeVertexNormals()
    let byMat = this.parts.get(to)
    if (!byMat) this.parts.set(to, (byMat = new Map()))
    const list = byMat.get(mat)
    if (list) list.push(g)
    else byMat.set(mat, [g])
  }

  /** add(), plus a copy mirrored to the other side of the body. Without a position, the shape is mirrored as it is. */
  pair(to: THREE.Object3D, mat: string, geo: THREE.BufferGeometry, p?: V3, r: V3 = [0, 0, 0], s: number | V3 = 1) {
    if (!p) {
      this.add(to, mat, mirrorX(geo))
      this.add(to, mat, geo)
      return
    }
    this.add(to, mat, geo.clone(), p, r, s)
    this.add(to, mat, geo, [-p[0], p[1], p[2]], [r[0], -r[1], -r[2]], s)
  }

  /** A two-part leg from a hip on `parent`, reaching from the hip out along its yaw and down to the floor. */
  leg(parent: THREE.Object3D, at: V3, yaw: number, l1: number, l2: number, r: number, mat: string, lift: number, off: number, floor = 0, joint?: string) {
    const hip = this.node('', parent, at, [0, yaw, lift])
    hip.userData = { leg: 1, yaw, lift, off, front: at[2] <= -0.12 ? 1 : 0 }
    this.add(hip, mat, segX(l1, r, r * 0.85))
    this.add(hip, joint ?? mat, sph(r * 1.15, 8, 6))
    const kneeH = at[1] - floor + l1 * Math.sin(lift)
    const drop = Math.asin(clamp(kneeH / l2, -1, 1))
    const knee = this.node('', hip, [l1, 0, 0], [0, 0, -(lift + drop)])
    this.add(knee, mat, segX(l2, r * 0.85, r * 0.25))
    this.add(knee, joint ?? mat, sph(r * 1.05, 8, 6))
    return hip
  }

  done() {
    for (const [node, byMat] of this.parts)
      for (const [mat, list] of byMat) {
        const geo = mergeGeometries(list)
        for (const g of list) g.dispose()
        if (!geo) continue
        geo.computeBoundingSphere()
        const mesh = new THREE.Mesh(geo, this.mats[mat])
        mesh.name = `${mat}`
        node.add(mesh)
      }
    this.parts.clear()
    return this.root
  }
}

/** Swings and lifts every leg of a walking creature. */
function walkLegs(legs: THREE.Object3D[], ph: number, move: number, swing: number, lift: number) {
  for (const h of legs) {
    const u = h.userData
    const p = ph + u.off
    h.rotation.y = u.yaw + Math.sin(p) * swing * move
    h.rotation.z = u.lift + Math.max(0, Math.cos(p)) * lift * move
  }
}

const moving = (a: Anim, k = 3) => clamp(a.pace * k, 0, 1)

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d')!, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// --- The monsters ----------------------------------------------------------------------------------
const KINDS: Record<string, Kind> = {
  byte_mite: {
    mats: (c) => ({
      shell: std('#17472c', 0.55, 0.3),
      head: std('#0d2a19', 0.6, 0.35),
      leg: std('#0a1d12', 0.75, 0.4),
      glow: glow(c, 1.36),
      eye: glow('#b8ffc8', 1.86),
    }),
    build(b) {
      const body = b.node('body', b.root, [0, 0.24, 0])
      const shellS: V3 = [0.95, 0.62, 1.2]
      b.add(body, 'shell', sph(0.3, 22, 16), [0, 0.03, 0.05], [0, 0, 0], shellS)
      for (const tilt of [-0.55, 0, 0.55]) b.add(body, 'glow', tor(0.303, 0.006, 4, 40, PI).rotateY(PI / 2).rotateZ(tilt), [0, 0.03, 0.05], [0, 0, 0], shellS)
      b.add(body, 'head', sph(0.26, 16, 10), [0, -0.04, 0.03], [0, 0, 0], [0.85, 0.42, 1.05])
      b.add(body, 'head', sph(0.15, 16, 12), [0, -0.01, -0.33], [0, 0, 0], [1.1, 0.8, 1])
      b.pair(body, 'eye', sph(0.045, 10, 8), [0.075, 0.04, -0.44])
      b.pair(body, 'leg', link([0.04, 0.06, -0.42], [0.16, 0.3, -0.6], 0.008, 0.003))
      for (const s of [1, -1]) {
        const jaw = b.node(s > 0 ? 'jawR' : 'jawL', body, [0.06 * s, -0.05, -0.44])
        b.add(jaw, 'leg', cone(0.024, 0.12, 6).rotateX(-PI / 2), [-0.015 * s, 0, -0.05], [0, 0.4 * s, 0])
      }
      ;[0.55, 0, -0.55].forEach((yaw, i) => {
        b.leg(b.root, [0.19, 0.22, -0.15 + i * 0.15], yaw, 0.2, 0.36, 0.03, 'leg', 0.45, i % 2 ? PI : 0)
        b.leg(b.root, [-0.19, 0.22, -0.15 + i * 0.15], PI - yaw, 0.2, 0.36, 0.03, 'leg', 0.45, i % 2 ? 0 : PI)
      })
    },
    anim(n, a, legs) {
      const mv = moving(a)
      const ph = a.walk * PI * 2 * 1.4
      walkLegs(legs, ph, mv, 0.35, 0.35)
      n.body.position.y = 0.24 + Math.abs(Math.sin(ph)) * 0.02 * mv + Math.sin(a.t * 3 + a.seed * 9) * 0.006
      n.body.rotation.x = 0.4 * a.windup - 0.3 * a.strike
      const open = 0.15 + 0.5 * a.windup + Math.sin(a.t * 18) * 0.12 * a.windup
      n.jawR.rotation.y = open
      n.jawL.rotation.y = -open
    },
  },

  junk_scuttler: {
    mats: (c) => ({
      shell: std('#2b3036', 0.75, 0.45),
      plate: std('#4c4134', 0.55, 0.65),
      dark: std('#14171b', 0.8, 0.4),
      glow: glow(c, 1.36),
      vent: glow('#ff8a3c', 1.49),
    }),
    build(b) {
      const body = b.node('body', b.root, [0, 0.3, 0])
      b.add(body, 'shell', sph(0.4, 24, 14), [0, 0.02, 0], [0, 0, 0], [1.2, 0.42, 0.95])
      b.add(body, 'dark', sph(0.36, 20, 10), [0, -0.04, 0], [0, 0, 0], [1.1, 0.3, 0.85])
      b.add(body, 'vent', tor(0.4, 0.012, 4, 32, PI).rotateX(-PI / 2), [0, 0, 0], [0, 0, 0], [1.21, 1, 0.96])
      const junk: [V3, V3, V3][] = [
        [[-0.16, 0.16, -0.06], [0.2, 0.3, 0.12], [0.22, 0.05, 0.18]],
        [[0.17, 0.15, 0.06], [-0.15, -0.4, -0.14], [0.2, 0.05, 0.2]],
        [[0.0, 0.17, 0.2], [0.25, 0.1, 0], [0.26, 0.04, 0.14]],
        [[0.02, 0.18, -0.15], [-0.1, 0.6, 0.05], [0.14, 0.06, 0.1]],
      ]
      for (const [p, r, s] of junk) b.add(body, 'plate', rbox(...s, 0.015), p, r)
      b.add(body, 'glow', box(0.1, 0.02, 0.03), [0.02, 0.2, -0.15], [-0.1, 0.6, 0.05])
      b.pair(body, 'dark', link([0.1, 0.12, 0.2], [0.24, 0.5, 0.42], 0.008, 0.004))
      b.pair(body, 'dark', link([0.04, 0.14, 0.24], [0.08, 0.42, 0.5], 0.006, 0.003))
      b.pair(body, 'glow', sph(0.014, 6, 4), [0.24, 0.5, 0.42])
      b.pair(body, 'dark', link([0.08, 0.1, -0.3], [0.09, 0.24, -0.33], 0.014, 0.012))
      b.pair(body, 'glow', sph(0.036, 10, 8), [0.09, 0.25, -0.34])
      for (const s of [1, -1]) {
        const yaw = s > 0 ? 0.95 : PI - 0.95
        const arm = b.node(s > 0 ? 'armR' : 'armL', body, [0.33 * s, -0.02, -0.2], [0, yaw, 0.1])
        arm.userData.yaw = yaw
        b.add(arm, 'dark', segX(0.22, 0.04, 0.035))
        const claw = b.node(s > 0 ? 'clawR' : 'clawL', arm, [0.22, 0, 0], [0, 0.6 * s, 0])
        b.add(claw, 'shell', sph(0.1, 14, 10), [0.08, 0, 0], [0, 0, 0], [1.4, 0.75, 0.8])
        b.add(claw, 'shell', cone(0.055, 0.2, 8).rotateZ(-PI / 2), [0.26, 0.025, 0])
        b.add(claw, 'glow', box(0.1, 0.012, 0.02), [0.1, 0.06, 0])
        const pinch = b.node(s > 0 ? 'pinchR' : 'pinchL', claw, [0.13, -0.035, 0])
        b.add(pinch, 'plate', cone(0.035, 0.17, 6).rotateZ(-PI / 2), [0.085, 0, 0])
      }
      ;[0.15, -0.25, -0.7].forEach((yaw, i) => {
        b.leg(b.root, [0.36, 0.28, -0.04 + i * 0.16], yaw, 0.26, 0.42, 0.042, 'dark', 0.5, i % 2 ? PI : 0)
        b.leg(b.root, [-0.36, 0.28, -0.04 + i * 0.16], PI - yaw, 0.26, 0.42, 0.042, 'dark', 0.5, i % 2 ? 0 : PI)
      })
    },
    anim(n, a, legs) {
      const mv = moving(a)
      const ph = a.walk * PI * 2 * 1.1
      walkLegs(legs, ph, mv, 0.3, 0.3)
      n.body.position.y = 0.3 + Math.abs(Math.sin(ph)) * 0.02 * mv
      n.body.rotation.z = Math.sin(ph) * 0.04 * mv
      n.body.rotation.x = 0.12 * a.windup - 0.15 * a.strike
      for (const s of [1, -1]) {
        const arm = n[s > 0 ? 'armR' : 'armL']
        arm.rotation.z = 0.1 + 0.7 * a.windup - 0.3 * a.strike + Math.sin(a.t * 1.7 + s + a.seed * 7) * 0.06
        const snap = a.strike > 0.2 ? 0 : 0.15 + 0.25 * (0.5 + 0.5 * Math.sin(a.t * 2.3 + s * 1.3 + a.seed * 5)) + 0.45 * a.windup
        n[s > 0 ? 'pinchR' : 'pinchL'].rotation.z = -snap
      }
    },
  },

  packet_swarm: {
    mats: (c) => ({
      glow: glow(c, 1.61),
      wire: new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(1.6), wireframe: true, transparent: true, opacity: 0.55 }),
      packet: glow('#ffffff', 0.9),
    }),
    build(b, c) {
      const core = b.node('core', b.root, [0, 0.5, 0])
      b.add(core, 'glow', new THREE.IcosahedronGeometry(0.12, 0))
      const shell = b.node('shell', core)
      b.add(shell, 'wire', new THREE.IcosahedronGeometry(0.22, 1))
      const N = 90
      const packets = new THREE.InstancedMesh(box(0.05, 0.05, 0.05), b.mats.packet, N)
      packets.name = 'packets'
      const col = new THREE.Color()
      for (let i = 0; i < N; i++) packets.setColorAt(i, col.copy(c).multiplyScalar(0.5 + ((i * 0.618) % 1) * 0.9))
      packets.frustumCulled = false
      core.add(packets)
    },
    anim(n, a) {
      const core = n.core
      core.position.y = 0.5 + Math.sin(a.t * 1.3) * 0.03
      n.shell.rotation.set(a.t * 0.7, a.t * 1.1, 0)
      const s = 1 + 0.25 * a.windup + 0.6 * a.strike
      n.shell.scale.setScalar(s)
      const pk = n.packets as THREE.InstancedMesh
      const spread = 1 - 0.35 * a.windup + 0.7 * a.strike
      for (let i = 0; i < pk.count; i++) {
        const f = (i * 0.6180339) % 1
        const g = (i * 0.7548776) % 1
        const R = (0.14 + 0.36 * Math.sqrt(f)) * spread
        const w = (1.2 + 2.2 * (1 - f)) * (i % 2 ? 1 : -1)
        const ang = a.t * w + g * PI * 2
        const tilt = g * PI
        const lean = f * PI * 2
        const x = Math.cos(ang) * R
        const z = Math.sin(ang) * R
        const y = z * Math.sin(tilt)
        P.set(x * Math.cos(lean) - z * Math.cos(tilt) * Math.sin(lean), y + Math.sin(a.t * 2 + i) * 0.02, x * Math.sin(lean) + z * Math.cos(tilt) * Math.cos(lean))
        E.set(a.t * w, a.t * 1.3 + i, 0)
        const k = 0.6 + 0.6 * ((i * 0.37) % 1) + (Math.sin(a.t * 9 + i * 3) > 0.92 ? 0.6 : 0)
        M.compose(P, Q.setFromEuler(E), S.set(k, k, k))
        pk.setMatrixAt(i, M)
      }
      pk.instanceMatrix.needsUpdate = true
    },
  },

  firewall_imp: {
    mats: (c) => ({
      skin: std('#c2381c', 0.35, 0.38, '#4a0c00', 0.8),
      dark: std('#3a0d06', 0.5, 0.5),
      horn: std('#f06a34', 0.4, 0.3, '#3a0a00', 1),
      glow: glow(c, 1.36),
      eye: glow('#fff4e0', 1.86),
      fire: additive(new THREE.Color('#ffb347').multiplyScalar(1.6), 0.9),
    }),
    build(b) {
      const hips = b.node('hips', b.root, [0, 0.34, 0])
      b.add(hips, 'dark', sph(0.12, 12, 10), [0, 0.02, 0], [0, 0, 0], [1.1, 0.7, 0.9])
      const torso = b.node('torso', hips, [0, 0.02, 0])
      b.add(torso, 'skin', sph(0.17, 18, 14), [0, 0.13, 0], [0, 0, 0], [1.05, 1.1, 0.85])
      b.add(torso, 'glow', tor(0.172, 0.007, 4, 32).rotateX(PI / 2), [0, 0.09, 0], [0, 0, 0], [1.05, 1, 0.85])
      b.add(torso, 'glow', box(0.012, 0.16, 0.012), [0, 0.15, -0.142])
      b.pair(torso, 'glow', box(0.07, 0.01, 0.01), [0.045, 0.19, -0.135], [0, 0.4, -0.5])
      const head = b.node('head', torso, [0, 0.36, 0])
      b.add(head, 'skin', sph(0.19, 20, 16), [0, 0, 0], [0, 0, 0], [1.1, 0.95, 1])
      b.pair(head, 'eye', sph(0.05, 12, 8), [0.075, 0.0, -0.165], [0, 0.35, 0.35], [1.4, 0.7, 0.5])
      b.pair(head, 'dark', box(0.1, 0.02, 0.04), [0.075, 0.05, -0.16], [0, 0.35, 0.4])
      b.add(head, 'glow', tor(0.06, 0.009, 4, 16, PI).rotateZ(PI), [0, -0.06, -0.17])
      b.pair(head, 'horn', cone(0.045, 0.22, 10), [0.12, 0.16, -0.02], [-0.25, 0, -0.65])
      b.pair(head, 'horn', cone(0.03, 0.13, 8), [0.07, 0.17, 0.09], [0.6, 0, -0.35])
      b.pair(head, 'skin', cone(0.045, 0.16, 8), [0.21, 0.0, 0.0], [0, 0, -1.25])
      const flame = b.node('flame', head, [0, 0.16, 0.03])
      b.add(flame, 'fire', cone(0.05, 0.2, 8), [0, 0.08, 0])
      b.pair(flame, 'fire', cone(0.035, 0.13, 8), [0.05, 0.04, 0.03], [0, 0, -0.45])
      for (const s of [1, -1]) {
        const arm = b.node(s > 0 ? 'armR' : 'armL', torso, [0.17 * s, 0.2, 0])
        b.add(arm, 'skin', sph(0.055, 10, 8))
        b.add(arm, 'skin', segD(0.15, 0.045, 0.04))
        const fore = b.node(s > 0 ? 'foreR' : 'foreL', arm, [0, -0.15, 0])
        b.add(fore, 'glow', tor(0.042, 0.007, 4, 16).rotateX(PI / 2))
        b.add(fore, 'skin', segD(0.12, 0.04, 0.035))
        b.add(fore, 'skin', sph(0.058, 12, 10), [0, -0.15, 0])
        b.add(fore, 'horn', cone(0.014, 0.05, 5).rotateX(-PI / 2), [0, -0.17, -0.05])
        b.add(fore, 'horn', cone(0.014, 0.05, 5).rotateX(-PI / 2), [0.025 * s, -0.16, -0.045])
        const leg = b.node(s > 0 ? 'legR' : 'legL', hips, [0.08 * s, 0, 0])
        b.add(leg, 'skin', segD(0.14, 0.055, 0.045))
        const shin = b.node(s > 0 ? 'shinR' : 'shinL', leg, [0, -0.14, 0])
        b.add(shin, 'skin', segD(0.15, 0.045, 0.035))
        b.add(shin, 'dark', rbox(0.08, 0.04, 0.15, 0.015), [0, -0.165, -0.03])
        b.add(shin, 'horn', cone(0.015, 0.05, 5).rotateX(-PI / 2), [0, -0.17, -0.12])
      }
      let tail = b.node('tail0', hips, [0, 0.0, 0.1], [-0.6, 0, 0])
      for (let k = 1; k <= 4; k++) {
        b.add(tail, 'skin', segZ(0.1, 0.03 - k * 0.004, 0.026 - k * 0.004))
        tail = b.node(`tail${k}`, tail, [0, 0, 0.1], [0.35, 0, 0])
      }
      b.add(tail, 'horn', cone(0.05, 0.1, 4).rotateX(PI / 2), [0, 0, 0.04], [0, 0, 0], [1, 0.3, 1])
    },
    anim(n, a) {
      const mv = moving(a, 2.5)
      const ph = a.walk * PI * 2 * 1.3
      const sw = Math.sin(ph) * mv
      const cast = a.windup
      n.hips.position.y = 0.34 + Math.abs(Math.sin(ph)) * 0.035 * mv + Math.sin(a.t * 2.5 + a.seed * 6) * 0.008
      n.legR.rotation.x = sw * 0.6
      n.legL.rotation.x = -sw * 0.6
      n.shinR.rotation.x = -Math.max(0, -Math.sin(ph)) * 0.9 * mv
      n.shinL.rotation.x = -Math.max(0, Math.sin(ph)) * 0.9 * mv
      n.torso.rotation.x = -0.12 * a.strike + 0.06 * mv
      for (const s of [1, -1]) {
        const arm = n[s > 0 ? 'armR' : 'armL']
        arm.rotation.x = -sw * 0.5 * s + 1.5 * cast + 1.7 * a.strike
        arm.rotation.z = 0.25 * s + Math.sin(a.t * 1.6 + s) * 0.04
        n[s > 0 ? 'foreR' : 'foreL'].rotation.x = 0.3 + 0.4 * cast - 0.3 * a.strike
      }
      n.head.rotation.y = Math.sin(a.t * 0.9 + a.seed * 4) * 0.25 * (1 - cast)
      const fl = 1 + Math.sin(a.t * 23) * 0.15 + Math.sin(a.t * 37) * 0.1 + cast * 0.5
      n.flame.scale.set(1, fl, 1)
      for (let k = 0; k < 5; k++) n[`tail${k}`].rotation.y = Math.sin(a.t * 2.5 - k * 0.7) * 0.3
    },
  },

  null_phantom: {
    mats: (c) => {
      const ghost = std('#d6d0e6', 0.1, 0.55, '#2a1a48', 0.9)
      ghost.transparent = true
      ghost.opacity = 0.93
      return {
        ghost,
        trail: additive(new THREE.Color('#b9a8ff').multiplyScalar(0.55), 0.55),
        glow: glow(c, 1.61),
        eye: glow('#e2c8ff', 2.17),
        vein: glow(c, 0.87),
      }
    },
    build(b) {
      const body = b.node('body', b.root)
      const pts = [
        [0.0, 0.4],
        [0.06, 0.42],
        [0.09, 0.48],
        [0.1, 0.56],
        [0.12, 0.66],
        [0.15, 0.74],
        [0.12, 0.78],
        [0.05, 0.8],
        [0.035, 0.84],
        [0, 0.85],
      ].map(([r, y]) => new THREE.Vector2(r, y))
      b.add(body, 'ghost', new THREE.LatheGeometry(pts, 18), [0, 0, 0], [0, 0, 0], [1, 1, 0.62])
      b.add(body, 'glow', sph(0.032, 12, 10), [0, 0.65, -0.075])
      for (let k = 0; k < 7; k++) {
        const ang = (k / 7) * PI * 2
        b.add(body, 'vein', box(0.005, 0.1, 0.004), [Math.cos(ang) * 0.045, 0.65 + Math.sin(ang) * 0.05, -0.073], [0, 0, ang - PI / 2])
      }
      b.add(body, 'trail', funnel(0.11, 0.5, 18).rotateX(PI), [0, 0.17, 0])
      b.add(body, 'trail', funnel(0.07, 0.36, 12).rotateX(PI), [0, 0.22, 0])
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * PI * 2
        const t = b.node(`tendril${k}`, body, [Math.cos(ang) * 0.07, 0.42, Math.sin(ang) * 0.05])
        b.add(t, 'vein', segD(0.32 + (k % 3) * 0.06, 0.008, 0.001, 4))
      }
      const head = b.node('head', body, [0, 0.9, 0])
      b.add(head, 'ghost', sph(0.075, 16, 12), [0, 0, 0.01], [0, 0, 0], [0.9, 1.2, 1.05])
      b.pair(head, 'eye', sph(0.017, 8, 6), [0.028, 0.0, -0.062], [0, 0, 0.3], [1.5, 0.75, 0.6])
      for (const s of [1, -1]) {
        const arm = b.node(s > 0 ? 'armR' : 'armL', body, [0.15 * s, 0.75, 0], [0, 0, 0.12 * s])
        b.add(arm, 'ghost', segD(0.22, 0.026, 0.02))
        const fore = b.node(s > 0 ? 'foreR' : 'foreL', arm, [0, -0.22, 0])
        b.add(fore, 'ghost', segD(0.2, 0.02, 0.014))
        for (const f of [-1, 0, 1]) b.add(fore, 'ghost', segD(0.1, 0.006, 0.002, 4), [f * 0.01, -0.2, 0], [0, 0, f * 0.15])
      }
    },
    anim(n, a) {
      const reach = a.windup + a.strike * 0.5
      n.body.rotation.z = Math.sin(a.t * 0.8 + a.seed * 5) * 0.05
      n.body.rotation.x = -0.15 * reach + 0.1 * moving(a)
      for (const s of [1, -1]) {
        n[s > 0 ? 'armR' : 'armL'].rotation.x = Math.sin(a.t * 1.1 + s) * 0.15 + 1.3 * reach + 0.3 * moving(a)
        n[s > 0 ? 'foreR' : 'foreL'].rotation.x = 0.2 + Math.sin(a.t * 1.4 + s) * 0.12 - 0.15 * reach
      }
      n.head.rotation.z = Math.sin(a.t * 0.7 + a.seed) * 0.15
      n.head.rotation.x = -0.2 * reach
      for (let k = 0; k < 6; k++) {
        const t = n[`tendril${k}`]
        t.rotation.x = Math.sin(a.t * 1.7 + k * 1.3) * 0.35 + 0.3 * moving(a)
        t.rotation.z = Math.sin(a.t * 1.3 + k * 2.1) * 0.35
      }
    },
  },

  phase_spider: {
    mats: (c) => ({
      chitin: std('#1a0f1e', 0.8, 0.22),
      plate: std('#33163a', 0.7, 0.3),
      leg: std('#0f0a12', 0.8, 0.3),
      glow: glow(c, 1.49),
      eye: glow('#ffb0f4', 1.86),
    }),
    build(b) {
      const body = b.node('body', b.root, [0, 0.36, 0])
      b.add(body, 'chitin', sph(0.15, 18, 12), [0, 0, -0.08], [0, 0, 0], [1, 0.7, 1.1])
      b.add(body, 'plate', sph(0.12, 14, 10), [0, 0.04, -0.09], [0, 0, 0], [0.9, 0.5, 0.9])
      const ab = { x: 0.228, y: 0.192, z: 0.3 }
      b.add(body, 'chitin', sph(0.24, 22, 16), [0, 0.08, 0.3], [0, 0, 0], [0.95, 0.8, 1.25])
      for (const dz of [-0.13, -0.02, 0.09, 0.19]) {
        const k = Math.sqrt(1 - (dz / ab.z) ** 2) * 1.02
        b.add(body, 'glow', tor(1, 0.04, 4, 36), [0, 0.08, 0.3 + dz], [0, 0, 0], [ab.x * k, ab.y * k, 0.25])
      }
      b.add(body, 'glow', cone(0.04, 0.09, 4), [0, 0.27, 0.26], [PI / 2, 0, 0])
      b.add(body, 'glow', cone(0.04, 0.09, 4), [0, 0.27, 0.36], [-PI / 2, 0, 0])
      const eyes: V3[] = [
        [0.035, 0.05, -0.2],
        [0.068, 0.03, -0.18],
        [0.018, 0.075, -0.185],
        [0.05, 0.075, -0.17],
      ]
      for (const e of eyes) b.pair(body, 'eye', sph(e[0] < 0.03 ? 0.016 : 0.022, 8, 6), e)
      b.pair(body, 'plate', cone(0.02, 0.1, 6).rotateX(PI), [0.035, -0.07, -0.2], [0.3, 0, 0])
      ;[0.95, 0.35, -0.25, -0.8].forEach((yaw, i) => {
        b.leg(b.root, [0.1, 0.37, -0.15 + i * 0.07], yaw, 0.34, 0.6, 0.03, 'leg', 0.55, i % 2 ? PI : 0, 0, 'glow')
        b.leg(b.root, [-0.1, 0.37, -0.15 + i * 0.07], PI - yaw, 0.34, 0.6, 0.03, 'leg', 0.55, i % 2 ? 0 : PI, 0, 'glow')
      })
    },
    anim(n, a, legs) {
      const mv = moving(a)
      const ph = a.walk * PI * 2 * 1.6
      walkLegs(legs, ph, mv, 0.3, 0.35)
      for (const h of legs) if (h.userData.front) h.rotation.z += 0.9 * a.windup
      const glitch = a.windup > 0.05 && Math.sin(a.t * 41 + a.seed * 50) > 0.7 ? 1 : 0
      n.body.position.set(glitch * (Math.random() - 0.5) * 0.08, 0.36 + Math.abs(Math.sin(ph)) * 0.015 * mv, 0)
      n.body.rotation.x = 0.25 * a.windup - 0.2 * a.strike
      n.body.scale.set(1 + glitch * 0.15, 1, 1)
    },
  },

  trojan_goliath: {
    mats: (c) => ({
      hull: std('#3e413c', 0.8, 0.45),
      plate: std('#5d5747', 0.7, 0.5),
      dark: std('#1a1b1c', 0.8, 0.5),
      hazard: std('#c98a1e', 0.5, 0.45),
      glow: glow(c, 1.43),
    }),
    build(b) {
      const hips = b.node('hips', b.root, [0, 0.36, 0])
      b.add(hips, 'dark', rbox(0.36, 0.12, 0.24, 0.03))
      for (const s of [1, -1]) {
        const leg = b.node(s > 0 ? 'legR' : 'legL', hips, [0.13 * s, -0.02, 0])
        b.add(leg, 'hull', rbox(0.13, 0.2, 0.15, 0.03), [0, -0.1, 0])
        const shin = b.node(s > 0 ? 'shinR' : 'shinL', leg, [0, -0.2, 0])
        b.add(shin, 'plate', rbox(0.15, 0.16, 0.18, 0.03), [0, -0.07, 0])
        b.add(shin, 'glow', box(0.08, 0.015, 0.01), [0, -0.05, -0.093])
        b.add(shin, 'dark', rbox(0.19, 0.06, 0.27, 0.02), [0, -0.15, -0.03])
      }
      const torso = b.node('torso', hips, [0, 0.07, 0])
      b.add(torso, 'hull', rbox(0.62, 0.4, 0.42, 0.06), [0, 0.22, 0])
      b.add(torso, 'dark', rbox(0.4, 0.12, 0.3, 0.03), [0, -0.01, 0])
      b.add(torso, 'plate', rbox(0.32, 0.24, 0.05, 0.02), [0, 0.22, -0.2])
      for (const y of [0.15, 0.2, 0.25, 0.3]) b.add(torso, 'glow', box(0.24, 0.016, 0.012), [0, y, -0.228])
      b.add(torso, 'hazard', box(0.63, 0.03, 0.43), [0, 0.06, 0])
      for (const s of [1, -1]) {
        b.add(torso, 'dark', cyl(0.04, 0.05, 0.26), [0.16 * s, 0.44, 0.17])
        b.add(torso, 'glow', tor(0.04, 0.01, 4, 16).rotateX(PI / 2), [0.16 * s, 0.57, 0.17])
        b.add(torso, 'plate', rbox(0.22, 0.17, 0.26, 0.05), [0.36 * s, 0.38, 0], [0, 0, -0.2 * s])
        b.add(torso, 'hazard', box(0.225, 0.03, 0.265), [0.36 * s, 0.32, 0], [0, 0, -0.2 * s])
      }
      const head = b.node('head', torso, [0, 0.47, -0.1])
      b.add(head, 'plate', sph(0.1, 16, 12), [0, 0, 0], [0, 0, 0], [1.2, 0.8, 1])
      b.add(head, 'glow', box(0.16, 0.025, 0.02), [0, 0.01, -0.095])
      for (const s of [1, -1]) {
        const arm = b.node(s > 0 ? 'armR' : 'armL', torso, [0.42 * s, 0.32, 0])
        b.add(arm, 'dark', segD(0.18, 0.06, 0.055))
        const fore = b.node(s > 0 ? 'foreR' : 'foreL', arm, [0, -0.18, 0])
        b.add(fore, 'dark', sph(0.065, 10, 8))
        b.add(fore, 'hull', segD(0.2, 0.085, 0.1, 10))
        b.add(fore, 'plate', rbox(0.18, 0.16, 0.18, 0.04), [0, -0.27, 0])
        b.add(fore, 'glow', box(0.14, 0.02, 0.01), [0, -0.25, -0.092])
      }
    },
    anim(n, a) {
      const mv = moving(a, 3.5)
      const ph = a.walk * PI * 2 * 0.9
      const sw = Math.sin(ph) * mv
      n.hips.position.y = 0.36 + Math.abs(Math.cos(ph)) * 0.025 * mv
      n.hips.rotation.z = Math.sin(ph) * 0.05 * mv
      n.legR.rotation.x = sw * 0.45
      n.legL.rotation.x = -sw * 0.45
      n.shinR.rotation.x = -Math.max(0, -Math.sin(ph)) * 0.7 * mv
      n.shinL.rotation.x = -Math.max(0, Math.sin(ph)) * 0.7 * mv
      n.torso.rotation.y = -sw * 0.08
      n.torso.rotation.x = 0.15 * a.windup - 0.22 * a.strike + Math.sin(a.t * 1.5) * 0.01
      for (const s of [1, -1]) {
        n[s > 0 ? 'armR' : 'armL'].rotation.x = -sw * 0.35 * s + 2.6 * a.windup + 0.9 * a.strike
        n[s > 0 ? 'armR' : 'armL'].rotation.z = 0.08 * s
        n[s > 0 ? 'foreR' : 'foreL'].rotation.x = 0.25 - 0.3 * a.windup
      }
    },
  },

  logic_bomb: {
    mats: (c) => ({
      casing: std('#2c0d13', 0.8, 0.3),
      metal: std('#5a5f66', 0.9, 0.3),
      glow: glow(c, 1.55),
      led: glow('#ffd34d', 1.86),
    }),
    build(b) {
      const body = b.node('body', b.root, [0, 0.38, 0])
      b.add(body, 'casing', sph(0.28, 26, 18))
      b.add(body, 'glow', tor(0.283, 0.01, 4, 48).rotateX(PI / 2))
      b.add(body, 'glow', tor(0.283, 0.008, 4, 48))
      b.add(body, 'glow', tor(0.283, 0.008, 4, 48).rotateY(PI / 2))
      for (const y of [-0.16, 0.16]) b.add(body, 'metal', tor(Math.sqrt(0.28 ** 2 - y * y), 0.02, 6, 40).rotateX(PI / 2), [0, y, 0])
      b.add(body, 'metal', cyl(0.1, 0.12, 0.06, 12), [0, 0.29, 0])
      const fuse = b.node('fuse', body, [0, 0.32, 0])
      b.add(fuse, 'metal', cyl(0.012, 0.015, 0.14, 6), [0, 0.07, 0], [0, 0, 0.2])
      b.add(fuse, 'led', sph(0.03, 8, 6), [-0.014, 0.139, 0])
      b.add(body, 'metal', rbox(0.22, 0.09, 0.05, 0.015), [0, 0.02, -0.26])
      b.add(body, 'led', box(0.17, 0.05, 0.01), [0, 0.02, -0.288])
      ;[0.6, -0.6].forEach((yaw, i) => {
        b.leg(b.root, [0.2, 0.26, 0.12 * (i ? 1 : -1)], yaw, 0.16, 0.36, 0.026, 'metal', 0.4, i ? PI : 0)
        b.leg(b.root, [-0.2, 0.26, 0.12 * (i ? 1 : -1)], PI - yaw, 0.16, 0.36, 0.026, 'metal', 0.4, i ? 0 : PI)
      })
    },
    anim(n, a, legs) {
      const mv = moving(a)
      const ph = a.walk * PI * 2 * 2
      walkLegs(legs, ph, mv, 0.35, 0.35)
      const tick = a.special > 0 ? Math.abs(Math.sin(a.t * (6 + 20 * a.special))) : 0
      n.body.position.y = 0.38 + Math.abs(Math.sin(ph)) * 0.02 * mv
      n.body.scale.setScalar(1 + tick * 0.08 * a.special + a.windup * 0.06)
      n.body.rotation.y = Math.sin(a.t * 0.8 + a.seed * 4) * 0.15
      n.fuse.scale.setScalar(1 + (Math.random() - 0.5) * 0.3 * (0.3 + a.special))
    },
  },

  recursive_worm: {
    mats: (c) => ({
      skin: std('#20381a', 0.6, 0.35),
      plate: std('#3e5c1c', 0.6, 0.3),
      teeth: std('#e8f0d0', 0.2, 0.4),
      glow: glow(c, 1.36),
      maw: glow('#d6ff6a', 1.86),
    }),
    build(b) {
      for (let i = 0; i < 9; i++) {
        const r = 0.17 - i * 0.011
        const seg = b.node(`w${i}`, b.root, [0, r, i * 0.14])
        if (i === 0) {
          b.add(seg, 'skin', sph(0.19, 20, 16), [0, 0, 0], [0, 0, 0], [1, 0.9, 1.1])
          b.add(seg, 'plate', new THREE.SphereGeometry(0.2, 18, 8, 0, PI * 2, 0, PI * 0.42), [0, 0, 0.02], [-0.3, 0, 0], [1, 0.9, 1.1])
          b.add(seg, 'plate', tor(0.11, 0.025, 8, 24), [0, 0, -0.18])
          b.add(seg, 'maw', sph(0.085, 12, 10), [0, 0, -0.13])
          for (let k = 0; k < 10; k++) {
            const f = (k / 10) * PI * 2
            b.add(seg, 'teeth', cone(0.018, 0.07, 5), [Math.cos(f) * 0.1, Math.sin(f) * 0.1, -0.2], [0, 0, f - PI / 2 + PI])
          }
          for (const s of [1, -1]) b.add(seg, 'glow', sph(0.018, 8, 6), [0.08 * s, 0.12, -0.12])
          b.add(seg, 'glow', sph(0.018, 8, 6), [0, 0.15, -0.1])
        } else {
          b.add(seg, 'skin', sph(r, 16, 12), [0, 0, 0], [0, 0, 0], [1, 0.9, 1.15])
          b.add(seg, 'plate', new THREE.SphereGeometry(r * 1.05, 14, 6, 0, PI * 2, 0, PI * 0.4), [0, 0, 0], [0, 0, 0], [1, 0.9, 1.15])
          b.add(seg, 'glow', tor(r * 0.97, r * 0.1, 5, 24), [0, 0, -r * 0.55])
          b.add(seg, 'plate', cone(r * 0.25, r * 0.6, 5), [0, r * 0.95, 0], [0.5, 0, 0])
        }
      }
    },
    anim(n, a) {
      const mv = moving(a, 2.5)
      const s = a.walk * PI * 2 * 0.9 + a.t * 0.8
      const amp = 0.035 + 0.08 * mv
      let px = 0
      let pz = 0
      for (let i = 0; i < 9; i++) {
        const w = n[`w${i}`]
        const r = 0.17 - i * 0.011
        const rear = i === 0 ? 0.32 : i === 1 ? 0.18 : i === 2 ? 0.07 : 0
        const x = Math.sin(s - i * 0.75) * amp * (0.4 + i * 0.08)
        const z = i * 0.14 - (i === 0 ? 0.12 * a.strike : 0)
        w.position.set(x, r + rear * a.windup + Math.max(0, Math.sin(s * 2 - i)) * 0.01, z)
        if (i > 0) w.rotation.y = Math.atan2(px - x, z - pz) * -1
        px = x
        pz = z
      }
      n.w0.rotation.x = 0.5 * a.windup - 0.3 * a.strike
      n.w0.rotation.y = Math.sin(s + 0.75) * 0.25
      n.w1.rotation.x = 0.3 * a.windup
    },
  },

  kernel_guardian: {
    mats: (c) => {
      const cape = std('#e6eaf0', 0.0, 0.8)
      cape.side = THREE.DoubleSide
      return {
        armor: std('#8e96a2', 0.7, 0.3),
        trim: std('#c9a24a', 1.0, 0.25),
        under: std('#2a2f3a', 0.7, 0.5),
        blade: std('#c8e6ff', 0.9, 0.15, '#4fa8ff', 0.8),
        glow: glow(c, 1.49),
        cape,
      }
    },
    build(b) {
      const hips = b.node('hips', b.root, [0, 0.45, 0])
      b.add(hips, 'under', rbox(0.22, 0.1, 0.14, 0.03))
      b.add(hips, 'armor', rbox(0.27, 0.12, 0.19, 0.03), [0, -0.05, 0])
      b.add(hips, 'trim', box(0.28, 0.02, 0.2), [0, 0.01, 0])
      for (const s of [1, -1]) {
        const leg = b.node(s > 0 ? 'legR' : 'legL', hips, [0.07 * s, -0.04, 0])
        b.add(leg, 'under', segD(0.2, 0.05, 0.045))
        b.add(leg, 'armor', rbox(0.1, 0.17, 0.1, 0.03), [0, -0.1, -0.005])
        const shin = b.node(s > 0 ? 'shinR' : 'shinL', leg, [0, -0.2, 0])
        b.add(shin, 'trim', sph(0.045, 10, 8), [0, 0, -0.03])
        b.add(shin, 'armor', rbox(0.09, 0.2, 0.1, 0.03), [0, -0.1, 0])
        b.add(shin, 'armor', rbox(0.09, 0.05, 0.17, 0.02), [0, -0.21, -0.03])
      }
      const torso = b.node('torso', hips, [0, 0.05, 0])
      b.add(torso, 'under', rbox(0.22, 0.12, 0.14, 0.03), [0, 0.03, 0])
      b.add(torso, 'armor', rbox(0.3, 0.26, 0.18, 0.05), [0, 0.18, 0])
      b.add(torso, 'trim', box(0.31, 0.016, 0.012), [0, 0.3, -0.088])
      b.add(torso, 'trim', box(0.016, 0.22, 0.012), [0, 0.18, -0.091])
      b.add(torso, 'trim', tor(0.048, 0.011, 6, 24), [0, 0.19, -0.095])
      b.add(torso, 'glow', sph(0.036, 12, 10), [0, 0.19, -0.095])
      for (const s of [1, -1]) {
        b.add(torso, 'armor', sph(0.09, 16, 12), [0.19 * s, 0.29, 0], [0, 0, -0.3 * s], [1.25, 0.85, 1.15])
        b.add(torso, 'trim', tor(0.1, 0.01, 4, 24).rotateX(PI / 2), [0.2 * s, 0.26, 0], [0, 0, -0.35 * s], [1.15, 1, 1.1])
        b.add(torso, 'glow', sph(0.016, 8, 6), [0.22 * s, 0.33, -0.08])
      }
      const head = b.node('head', torso, [0, 0.33, 0])
      b.add(head, 'armor', rbox(0.12, 0.14, 0.13, 0.04), [0, 0.06, 0])
      b.add(head, 'glow', box(0.09, 0.012, 0.01), [0, 0.07, -0.066])
      b.add(head, 'trim', box(0.014, 0.09, 0.15), [0, 0.15, 0.01])
      b.pair(head, 'trim', cone(0.02, 0.11, 6), [0.075, 0.12, 0.02], [0, 0, -0.7])
      const cape = b.node('cape', torso, [0, 0.3, 0.09])
      b.add(cape, 'cape', box(0.3, 0.58, 0.012), [0, -0.29, 0])
      b.add(cape, 'trim', box(0.31, 0.02, 0.016), [0, -0.575, 0])
      for (const s of [1, -1]) {
        const arm = b.node(s > 0 ? 'armR' : 'armL', torso, [0.21 * s, 0.25, 0])
        b.add(arm, 'under', segD(0.16, 0.04, 0.035))
        b.add(arm, 'armor', rbox(0.08, 0.12, 0.085, 0.025), [0, -0.07, 0])
        const fore = b.node(s > 0 ? 'foreR' : 'foreL', arm, [0, -0.16, 0])
        b.add(fore, 'armor', rbox(0.075, 0.14, 0.08, 0.025), [0, -0.07, 0])
        b.add(fore, 'trim', sph(0.04, 10, 8), [0, -0.16, 0])
      }
      const sword = b.node('sword', b.root.getObjectByName('foreR')!, [0, -0.17, 0])
      b.add(sword, 'trim', cyl(0.012, 0.012, 0.09, 6).rotateX(PI / 2), [0, 0, 0.0])
      b.add(sword, 'trim', box(0.13, 0.02, 0.025), [0, 0, -0.05])
      b.add(sword, 'trim', sph(0.02, 8, 6), [0, 0, 0.05])
      b.add(sword, 'blade', box(0.045, 0.009, 0.52), [0, 0, -0.31])
      b.add(sword, 'blade', cone(0.0225, 0.06, 4).rotateX(-PI / 2), [0, 0, -0.6], [0, 0, PI / 4], [1, 1, 0.2])
      b.add(sword, 'glow', box(0.008, 0.012, 0.48), [0, 0, -0.3])
      const shield = b.node('shield', b.root.getObjectByName('foreL')!, [0, -0.1, -0.06])
      b.add(shield, 'armor', rbox(0.26, 0.4, 0.03, 0.03), [0, 0, -0.03])
      b.add(shield, 'trim', box(0.27, 0.02, 0.035), [0, 0.19, -0.03])
      b.add(shield, 'trim', box(0.27, 0.02, 0.035), [0, -0.19, -0.03])
      b.add(shield, 'trim', box(0.02, 0.4, 0.035), [0.125, 0, -0.03])
      b.add(shield, 'trim', box(0.02, 0.4, 0.035), [-0.125, 0, -0.03])
      b.add(shield, 'trim', box(0.025, 0.26, 0.012), [0, 0, -0.05])
      b.add(shield, 'trim', box(0.16, 0.025, 0.012), [0, 0.05, -0.05])
      b.add(shield, 'glow', sph(0.035, 12, 8), [0, 0.05, -0.055], [0, 0, 0], [1, 1, 0.5])
    },
    anim(n, a) {
      const mv = moving(a, 3)
      const ph = a.walk * PI * 2 * 1.0
      const sw = Math.sin(ph) * mv
      n.hips.position.y = 0.45 + Math.abs(Math.cos(ph)) * 0.015 * mv + Math.sin(a.t * 1.6) * 0.004
      n.legR.rotation.x = sw * 0.4
      n.legL.rotation.x = -sw * 0.4
      n.shinR.rotation.x = -Math.max(0, -Math.sin(ph)) * 0.6 * mv
      n.shinL.rotation.x = -Math.max(0, Math.sin(ph)) * 0.6 * mv
      n.torso.rotation.y = -0.25 * a.windup + 0.35 * a.strike
      n.torso.rotation.x = 0.06 * a.windup - 0.1 * a.strike
      n.armR.rotation.x = 0.45 + 1.9 * a.windup - 0.1 * a.strike - sw * 0.15
      n.armR.rotation.z = 0.12
      n.foreR.rotation.x = 0.6 - 0.4 * a.windup + 0.2 * a.strike
      n.sword.rotation.x = 0.25 + 0.3 * a.windup - 0.9 * a.strike
      n.armL.rotation.x = 0.65 + sw * 0.1
      n.armL.rotation.z = -0.15
      n.foreL.rotation.x = 0.9
      n.shield.rotation.x = -(n.armL.rotation.x + n.foreL.rotation.x) + 0.1
      n.shield.rotation.y = 0.35
      n.cape.rotation.x = 0.08 + 0.12 * mv + Math.sin(a.t * 2.1) * 0.03
    },
  },

  data_leviathan: {
    mats: (c) => ({
      skin: std('#1f6a52', 0.45, 0.4),
      belly: std('#8fbf9a', 0.2, 0.6),
      dark: std('#0c2a22', 0.6, 0.4),
      teeth: std('#f2f2e8', 0.1, 0.4),
      spine: glow('#ff4f8a', 1.05),
      glow: glow(c, 1.36),
      eye: glow('#ff5ccf', 1.86),
    }),
    build(b) {
      const head = b.node('head', b.root, [0, 0.5, -0.22])
      b.add(head, 'skin', sph(0.22, 22, 16), [0, 0.02, 0], [0, 0, 0], [1.0, 0.8, 1.15])
      b.pair(head, 'dark', tor(0.068, 0.018, 6, 16), [0.13, 0.08, -0.13], [0, 0.9, 0])
      b.pair(head, 'eye', sph(0.06, 12, 10), [0.13, 0.08, -0.13])
      b.pair(head, 'skin', sph(0.06, 10, 8), [0.12, 0.14, -0.12], [0, 0, -0.3], [1.4, 0.5, 1])
      for (let k = 0; k < 9; k++) {
        const t = (k / 8 - 0.5) * 2.2
        b.add(head, 'teeth', cone(0.018, 0.065, 5).rotateX(PI), [Math.sin(t) * 0.17, -0.06, -Math.cos(t) * 0.2 + 0.02])
      }
      b.pair(head, 'spine', cone(0.035, 0.22, 6), [0.13, 0.13, 0.06], [-0.9, 0, -0.7])
      b.pair(head, 'spine', cone(0.028, 0.16, 6), [0.17, 0.05, 0.1], [-1.1, 0, -1.2])
      for (let k = 0; k < 3; k++) b.add(head, 'spine', cone(0.025, 0.12 - k * 0.02, 6), [0, 0.17 - k * 0.01, -0.02 + k * 0.08], [-0.5, 0, 0])
      const jaw = b.node('jaw', head, [0, -0.06, 0.06])
      b.add(jaw, 'belly', new THREE.SphereGeometry(0.19, 20, 10, 0, PI * 2, PI / 2, PI / 2), [0, 0.02, -0.08], [0, 0, 0], [0.95, 0.6, 1.1])
      for (let k = 0; k < 8; k++) {
        const t = (k / 7 - 0.5) * 2
        b.add(jaw, 'teeth', cone(0.015, 0.05, 5), [Math.sin(t) * 0.15, 0.03, -Math.cos(t) * 0.18 - 0.06])
      }
      let prev: THREE.Object3D = b.root
      const rs = [0.19, 0.16, 0.13, 0.1, 0.07]
      rs.forEach((r, k) => {
        const seg = b.node(`b${k}`, prev, k === 0 ? [0, 0.5, 0] : [0, 0, 0.21])
        b.add(seg, 'skin', sph(r, 18, 12), [0, 0, 0], [0, 0, 0], [1, 0.95, 1.4])
        b.add(seg, 'belly', sph(r * 0.9, 14, 10), [0, -r * 0.28, 0], [0, 0, 0], [0.88, 0.6, 1.3])
        b.add(seg, 'spine', cone(0.03, 0.1 + r * 0.6, 6), [0, r * 0.95, 0], [0.5, 0, 0])
        b.pair(seg, 'glow', box(0.012, 0.02, r * 2.2), [r * 0.97, 0.01, 0])
        prev = seg
      })
      for (const s of [1, -1]) {
        const fin = b.node(s > 0 ? 'finR' : 'finL', b.root.getObjectByName('b0')!, [0.16 * s, -0.06, -0.02])
        b.add(fin, 'skin', cone(0.09, 0.32, 3).rotateZ(-PI / 2 * s).translate(0.16 * s, 0, 0), [0, 0, 0], [0, 0, 0], [1, 0.18, 1])
        b.add(fin, 'spine', box(0.3, 0.01, 0.01).translate(0.15 * s, 0, 0.05), [0, 0, 0], [0, -0.3 * s, 0])
      }
      const tail = b.node('tail', prev, [0, 0, 0.1])
      b.add(tail, 'skin', cone(0.13, 0.3, 4).rotateX(PI / 2).translate(0, 0, 0.12), [0, 0, 0], [0, 0, 0], [0.12, 1, 1])
      b.add(tail, 'spine', box(0.012, 0.24, 0.012), [0, 0, 0.22])
    },
    anim(n, a) {
      const sp = 1 + moving(a, 2)
      const w = a.t * 2.2 * sp
      for (let k = 0; k < 5; k++) {
        n[`b${k}`].rotation.y = Math.sin(w - k * 0.9) * (k ? 0.28 : 0.08)
        n[`b${k}`].rotation.x = Math.sin(a.t * 1.6 - k * 0.7) * 0.07
      }
      n.head.rotation.y = -Math.sin(w + 0.9) * 0.1
      n.head.rotation.x = 0.25 * a.windup - 0.2 * a.strike
      n.head.position.z = -0.22 - a.strike * 0.14
      n.jaw.rotation.x = -(0.07 + Math.sin(a.t * 1.3) * 0.04 + 0.65 * a.windup + 0.35 * a.strike)
      n.finR.rotation.z = Math.sin(a.t * 3 * sp) * 0.4
      n.finL.rotation.z = -Math.sin(a.t * 3 * sp) * 0.4
      n.tail.rotation.y = Math.sin(w - 5) * 0.4
    },
  },

  singularity: {
    mats: () => {
      const disk = canvasTexture(256, (g, s) => {
        const c = s / 2
        const grad = g.createRadialGradient(c, c, s * 0.17, c, c, c)
        grad.addColorStop(0, 'rgba(255,255,255,1)')
        grad.addColorStop(0.12, 'rgba(210,220,255,0.95)')
        grad.addColorStop(0.35, 'rgba(160,140,255,0.6)')
        grad.addColorStop(0.7, 'rgba(90,60,200,0.18)')
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = grad
        g.fillRect(0, 0, s, s)
        g.globalCompositeOperation = 'lighter'
        for (let i = 0; i < 70; i++) {
          const r = c * (0.38 + Math.random() * 0.58)
          const a0 = Math.random() * PI * 2
          g.strokeStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.25})`
          g.lineWidth = 1 + Math.random() * 2
          g.beginPath()
          g.arc(c, c, r, a0, a0 + 0.3 + Math.random() * 1.2)
          g.stroke()
        }
      })
      return {
        void: new THREE.MeshBasicMaterial({ color: '#000000' }),
        disk: additive(new THREE.Color('#ffffff').multiplyScalar(1.4), 1, disk),
        jet: additive(new THREE.Color('#9db4ff').multiplyScalar(1.2), 0.35),
        glow: glow('#e0e0ff', 1.61),
        rock: std('#3a3442', 0.5, 0.7),
      }
    },
    build(b) {
      const core = b.node('core', b.root, [0, 0.5, 0])
      b.add(core, 'void', sph(0.2, 28, 20))
      const tilt = b.node('tilt', core, [0, 0, 0], [0.38, 0, 0.15])
      const disk = b.node('disk', tilt)
      b.add(disk, 'disk', new THREE.RingGeometry(0.205, 0.62, 72, 1).rotateX(-PI / 2))
      const inner = b.node('inner', tilt)
      b.add(inner, 'disk', new THREE.RingGeometry(0.205, 0.38, 48, 1).rotateX(-PI / 2).rotateY(1))
      b.add(tilt, 'glow', tor(0.21, 0.006, 6, 64).rotateX(PI / 2))
      const halo = b.node('halo', core)
      b.add(halo, 'glow', tor(0.215, 0.004, 4, 64))
      b.add(core, 'jet', funnel(0.05, 0.55), [0, 0.42, 0])
      b.add(core, 'jet', funnel(0.05, 0.55).rotateX(PI), [0, -0.42, 0])
      const rocks = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.03), b.mats.rock, 26)
      rocks.name = 'rocks'
      rocks.frustumCulled = false
      tilt.add(rocks)
    },
    anim(n, a) {
      const k = 1 + 2.5 * a.windup + 3 * a.strike
      n.disk.rotation.y = a.t * 0.9 * k
      n.inner.rotation.y = a.t * 1.7 * k
      n.halo.rotation.y = a.t * 0.5
      n.core.scale.setScalar(1 + 0.12 * a.windup * Math.sin(a.t * 20) + 0.25 * a.strike)
      n.core.position.y = 0.5 + Math.sin(a.t * 1.2) * 0.03
      const rk = n.rocks as THREE.InstancedMesh
      for (let i = 0; i < rk.count; i++) {
        const f = (i * 0.6180339) % 1
        const R = 0.3 + f * 0.36
        const ang = a.t * (1.6 - f) * k + i * 2.4
        P.set(Math.cos(ang) * R, Math.sin(i * 7.1) * 0.04, Math.sin(ang) * R)
        E.set(a.t * 2 + i, a.t * 3 + i, 0)
        M.compose(P, Q.setFromEuler(E), S.setScalar(0.6 + ((i * 0.37) % 1)))
        rk.setMatrixAt(i, M)
      }
      rk.instanceMatrix.needsUpdate = true
    },
  },

  mainframe: {
    mats: (c) => {
      const rack = canvasTexture(128, (g, s) => {
        g.fillStyle = '#05070a'
        g.fillRect(0, 0, s, s)
        for (let y = 2; y < s; y += 6)
          for (let x = 4; x < s - 4; x += 8) {
            const on = Math.random()
            g.fillStyle = on > 0.8 ? '#ff4040' : on > 0.6 ? '#ffb347' : on > 0.45 ? '#40ff9a' : '#1a1f26'
            g.fillRect(x, y, 4, 2)
          }
      })
      rack.wrapS = rack.wrapT = THREE.RepeatWrapping
      return {
        tower: std('#1b1f26', 0.85, 0.35),
        panel: std('#2c323c', 0.8, 0.4),
        trim: std('#5a1414', 0.7, 0.35, '#ff2a2a', 0.25),
        rack: new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(1.8), map: rack }),
        glow: glow(c, 1.49),
        eye: glow('#ff5a40', 1.98),
        void: new THREE.MeshBasicMaterial({ color: '#000000' }),
        shield: additive(new THREE.Color(c).multiplyScalar(0.8), 0.45),
      }
    },
    build(b) {
      const r = b.root
      b.add(r, 'tower', cyl(0.42, 0.5, 0.1, 8), [0, 0.05, 0])
      b.add(r, 'panel', cyl(0.34, 0.4, 0.07, 8), [0, 0.13, 0])
      b.add(r, 'glow', tor(0.405, 0.008, 4, 48).rotateX(PI / 2), [0, 0.1, 0])
      b.add(r, 'tower', cyl(0.19, 0.24, 0.8, 8), [0, 0.55, 0])
      for (let k = 0; k < 4; k++) {
        const f = PI / 4 + (k * PI) / 2
        const at: V3 = [Math.sin(f) * 0.23, 0.48, Math.cos(f) * 0.23]
        b.add(r, 'panel', rbox(0.17, 0.56, 0.08, 0.02), at, [0, f, 0])
        b.add(r, 'rack', box(0.13, 0.5, 0.004), [Math.sin(f) * 0.272, 0.48, Math.cos(f) * 0.272], [0, f, 0])
      }
      for (let k = 0; k < 6; k++) {
        const f = (k / 6) * PI * 2 + 0.3
        const pts = [new THREE.Vector3(Math.sin(f) * 0.2, 0.32, Math.cos(f) * 0.2), new THREE.Vector3(Math.sin(f) * 0.34, 0.2, Math.cos(f) * 0.34), new THREE.Vector3(Math.sin(f) * 0.5, 0.02, Math.cos(f) * 0.5)]
        b.add(r, 'panel', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.018, 5))
      }
      b.add(r, 'tower', cone(0.19, 0.22, 8), [0, 1.06, 0])
      b.add(r, 'trim', cyl(0.2, 0.2, 0.04, 8), [0, 0.95, 0])
      b.add(r, 'glow', cyl(0.008, 0.008, 0.24, 4), [0, 1.24, 0])
      b.add(r, 'eye', sph(0.02, 8, 6), [0, 1.36, 0])
      const eye = b.node('eye', r, [0, 0.72, -0.29])
      b.add(eye, 'trim', tor(0.13, 0.035, 10, 32))
      b.add(eye, 'tower', sph(0.12, 20, 14))
      const iris = b.node('iris', eye)
      b.add(iris, 'eye', sph(0.088, 22, 16), [0, 0, -0.065], [0, 0, 0], [1, 1, 0.5])
      b.add(iris, 'void', sph(0.036, 12, 10), [0, 0, -0.105], [0, 0, 0], [1, 1, 0.4])
      for (let k = 0; k < 6; k++) {
        const sh = b.node(`sh${k}`, eye, [0, 0, -0.1], [0, 0, (k * PI) / 3])
        const blade = b.node(`shb${k}`, sh, [0, 0.07, 0])
        b.add(blade, 'panel', rbox(0.085, 0.09, 0.015, 0.006), [0, 0, 0], [0, 0, 0])
      }
      for (const name of ['ringA', 'ringB']) {
        const ring = b.node(name, r, [0, 0.58, 0])
        b.add(ring, 'glow', tor(0.44, 0.01, 5, 72))
        for (let k = 0; k < 8; k++) {
          const f = (k / 8) * PI * 2
          b.add(ring, 'panel', rbox(0.06, 0.03, 0.03, 0.008), [Math.cos(f) * 0.44, Math.sin(f) * 0.44, 0], [0, 0, f])
        }
      }
      const orbit = b.node('orbit', r, [0, 0.55, 0])
      for (let k = 0; k < 4; k++) {
        const f = (k / 4) * PI * 2
        b.add(orbit, 'shield', rbox(0.2, 0.32, 0.02, 0.01), [Math.sin(f) * 0.6, 0, Math.cos(f) * 0.6], [0, f, 0])
        b.add(orbit, 'glow', box(0.21, 0.01, 0.025), [Math.sin(f) * 0.6, 0.16, Math.cos(f) * 0.6], [0, f, 0])
      }
    },
    anim(n, a) {
      const phase = a.hp > 0.66 ? 0 : a.hp > 0.33 ? 1 : 2
      const spin = [0.35, 0.8, 1.5][phase] * (1 + a.windup)
      n.ringA.rotation.set(PI / 2 + Math.sin(a.t * 0.3) * 0.3, a.t * spin, 0)
      n.ringB.rotation.set(PI / 2 + 0.5, -a.t * spin * 0.7, a.t * 0.2)
      n.orbit.rotation.y = a.t * (0.3 + phase * 0.35)
      n.orbit.visible = phase > 0
      const open = 0.45 + phase * 0.18 + a.windup * 0.3 + Math.sin(a.t * 2) * 0.03
      for (let k = 0; k < 6; k++) n[`shb${k}`].position.y = 0.035 + open * 0.12
      n.iris.scale.setScalar(1 + a.windup * 0.25 * (0.5 + 0.5 * Math.sin(a.t * 18)) + a.strike * 0.3)
      n.iris.position.x = Math.sin(a.t * 0.7) * 0.012
      n.iris.position.y = Math.sin(a.t * 0.53) * 0.01
    },
  },

  zero_day: {
    mats: () => {
      const v = new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide })
      return {
        chrome: std('#15171c', 1, 0.18),
        void: v,
        glow: glow('#ffffff', 1.61),
        ember: glow('#ff6a2a', 1.49),
        beam: additive(new THREE.Color('#ffe8d0').multiplyScalar(1.5), 0.7),
      }
    },
    build(b) {
      const ring = b.node('ring', b.root, [0, 0.5, 0])
      const spin = b.node('spin', ring)
      b.add(spin, 'chrome', tor(0.3, 0.07, 16, 64))
      b.add(ring, 'void', new THREE.CircleGeometry(0.25, 48), [0, 0, 0.01])
      b.add(ring, 'ember', tor(0.12, 0.006, 4, 40), [0, 0, -0.02])
      b.add(ring, 'ember', tor(0.22, 0.004, 4, 48), [0, 0, -0.02])
      const pupil = b.node('pupil', ring, [0, 0, -0.03])
      b.add(pupil, 'glow', sph(0.035, 12, 10))
      let seed = 7
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
      for (let k = 0; k < 30; k++) {
        const f = (k / 30) * PI * 2 + rnd() * 0.1
        const L = 0.12 + rnd() * 0.22
        const R = 0.34 + L / 2
        b.add(spin, 'chrome', cone(0.022 + rnd() * 0.012, L, 6), [Math.cos(f) * R, Math.sin(f) * R, (rnd() - 0.5) * 0.06], [(rnd() - 0.5) * 0.5, 0, f - PI / 2])
        if (k % 3 === 0) b.add(spin, 'ember', sph(0.014, 6, 4), [Math.cos(f) * (0.34 + L * 0.55), Math.sin(f) * (0.34 + L * 0.55), 0])
      }
      for (let k = 0; k < 10; k++) {
        const f = (k / 10) * PI * 2
        b.add(spin, 'chrome', cone(0.02, 0.15, 5).rotateX(PI / 2), [Math.cos(f) * 0.26, Math.sin(f) * 0.26, 0.1])
      }
      for (const x of [-0.06, 0.0, 0.05]) b.add(b.root, 'beam', cyl(0.004, 0.004, 0.5, 4), [x, 1.08, 0.02])
    },
    anim(n, a) {
      const g = a.windup + a.strike
      const jit = Math.sin(a.t * 31 + a.seed * 40) > 0.85 - g * 0.5 ? 1 : 0
      n.spin.rotation.z = a.t * (0.5 + 3 * g)
      n.ring.position.set(jit * (Math.random() - 0.5) * 0.05, 0.5 + jit * (Math.random() - 0.5) * 0.05, 0)
      n.ring.rotation.z = jit * (Math.random() - 0.5) * 0.2
      n.pupil.scale.setScalar(1 + 0.8 * a.windup * (0.5 + 0.5 * Math.sin(a.t * 24)) + 2 * a.strike)
    },
  },

  rootkit_dragon: {
    mats: (c) => {
      const wing = std('#3a0a34', 0.2, 0.6, '#ff00aa', 0.18)
      wing.side = THREE.DoubleSide
      wing.transparent = true
      wing.opacity = 0.9
      return {
        scale: std('#2c102c', 0.6, 0.35),
        belly: std('#4c2242', 0.4, 0.5),
        horn: std('#dccbdc', 0.3, 0.4),
        glow: glow(c, 1.36),
        eye: glow('#ffd0ff', 1.86),
        wing,
      }
    },
    build(b) {
      const torso = b.node('torso', b.root, [0, 0.45, 0.05])
      b.add(torso, 'scale', sph(0.16, 20, 14), [0, 0, 0], [0, 0, 0], [1, 0.95, 1.5])
      b.add(torso, 'belly', sph(0.15, 18, 12), [0, -0.04, -0.02], [0, 0, 0], [0.85, 0.8, 1.35])
      for (let k = 0; k < 4; k++) b.add(torso, 'glow', cone(0.025, 0.09, 4), [0, 0.15, -0.15 + k * 0.1], [0.5, 0, 0])
      b.pair(torso, 'glow', box(0.01, 0.015, 0.3), [0.15, 0.0, 0])
      for (const s of [1, -1]) {
        b.add(torso, 'scale', link([0.09 * s, -0.08, 0.12], [0.14 * s, -0.2, 0.08], 0.035, 0.028))
        b.add(torso, 'scale', link([0.14 * s, -0.2, 0.08], [0.12 * s, -0.27, 0.18], 0.028, 0.018))
        b.add(torso, 'horn', cone(0.012, 0.05, 4).rotateX(-PI / 2), [0.12 * s, -0.28, 0.13])
        b.add(torso, 'scale', link([0.08 * s, -0.08, -0.14], [0.11 * s, -0.17, -0.2], 0.026, 0.02))
        b.add(torso, 'horn', cone(0.01, 0.04, 4).rotateX(-PI), [0.11 * s, -0.2, -0.21])
      }
      let prev: THREE.Object3D = torso
      for (let k = 0; k < 3; k++) {
        const nk = b.node(`n${k}`, prev, k === 0 ? [0, 0.06, -0.21] : [0, 0, -0.11], [0.3, 0, 0])
        b.add(nk, 'scale', sph(0.075 - k * 0.008, 14, 10), [0, 0, 0], [0, 0, 0], [1, 1, 1.5])
        b.add(nk, 'glow', cone(0.018, 0.06, 4), [0, 0.07 - k * 0.008, 0], [0.5, 0, 0])
        prev = nk
      }
      const head = b.node('head', prev, [0, 0, -0.1], [-0.6, 0, 0])
      b.add(head, 'scale', rbox(0.13, 0.1, 0.18, 0.04), [0, 0, -0.05])
      b.add(head, 'scale', rbox(0.09, 0.06, 0.14, 0.025), [0, -0.01, -0.18])
      b.pair(head, 'glow', sph(0.008, 6, 4), [0.025, 0.02, -0.25])
      b.pair(head, 'eye', sph(0.02, 8, 6), [0.055, 0.025, -0.1], [0, 0.3, 0], [1.6, 0.8, 1])
      b.pair(head, 'horn', cone(0.022, 0.2, 6), [0.045, 0.06, 0.04], [2.0, 0, -0.25])
      b.pair(head, 'horn', cone(0.014, 0.1, 5), [0.07, 0.0, 0.03], [1.8, 0, -0.9])
      for (let k = 0; k < 3; k++) b.add(head, 'glow', cone(0.012, 0.04, 4), [0, 0.055, -0.1 + k * 0.05], [0.4, 0, 0])
      const jaw = b.node('jaw', head, [0, -0.04, 0])
      b.add(jaw, 'belly', rbox(0.08, 0.03, 0.2, 0.012), [0, -0.01, -0.12])
      b.pair(jaw, 'horn', cone(0.008, 0.03, 4), [0.03, 0.015, -0.2])
      const throat = b.node('throat', head, [0, -0.02, -0.2])
      b.add(throat, 'eye', sph(0.03, 8, 6))
      for (const s of [1, -1]) {
        const wing = b.node(s > 0 ? 'wingR' : 'wingL', torso, [0.11 * s, 0.09, -0.06])
        const wrist: V3 = [0.36 * s, 0.03, 0.04]
        const tips: V3[] = [
          [0.72 * s, -0.04, 0.12],
          [0.6 * s, -0.08, 0.36],
          [0.38 * s, -0.08, 0.44],
          [0.14 * s, -0.04, 0.3],
        ]
        b.add(wing, 'scale', link([0, 0, 0], wrist, 0.022, 0.016))
        b.add(wing, 'horn', cone(0.014, 0.07, 4), [0.36 * s, 0.07, 0.03], [0, 0, -0.3 * s])
        for (const t of tips.slice(0, 3)) b.add(wing, 'scale', link(wrist, t, 0.012, 0.004))
        const pos: number[] = []
        const pts: V3[] = [[0, 0, 0], wrist, ...tips]
        for (let k = 1; k < pts.length - 1; k++) {
          const from = k <= 1 ? pts[0] : wrist
          pos.push(...from, ...pts[k], ...pts[k + 1])
        }
        pos.push(0, 0, 0, ...wrist, ...tips[3])
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.computeVertexNormals()
        b.add(wing, 'wing', g)
      }
      prev = torso
      for (let k = 0; k < 6; k++) {
        const tk = b.node(`t${k}`, prev, k === 0 ? [0, -0.02, 0.22] : [0, 0, 0.1], [k === 0 ? 0.15 : -0.05, 0, 0])
        b.add(tk, 'scale', segZ(0.11, 0.065 - k * 0.009, 0.058 - k * 0.009, 8))
        b.add(tk, 'glow', cone(0.012, 0.04, 4), [0, 0.06 - k * 0.009, 0.05], [0.5, 0, 0])
        prev = tk
      }
      b.add(prev, 'glow', cone(0.06, 0.12, 4).rotateX(PI / 2), [0, 0, 0.16], [0, 0, 0], [1, 0.2, 1])
    },
    anim(n, a) {
      const flap = Math.sin(a.t * 3.2)
      n.wingR.rotation.z = flap * 0.6 + 0.1
      n.wingL.rotation.z = -flap * 0.6 - 0.1
      n.wingR.rotation.y = n.wingL.rotation.y = 0
      n.torso.position.y = 0.45 - flap * 0.03
      n.torso.rotation.x = -0.06 * a.strike + Math.sin(a.t * 3.2 + 1) * 0.03
      const rear = a.windup
      n.n0.rotation.x = 0.3 + 0.35 * rear - 0.5 * a.strike
      n.n1.rotation.x = 0.1 * rear - 0.1 * a.strike
      n.n0.rotation.y = Math.sin(a.t * 0.9 + a.seed * 3) * 0.2
      n.n2.rotation.y = Math.sin(a.t * 0.9 + 1 + a.seed * 3) * 0.15
      n.head.rotation.x = -0.6 - 0.25 * rear + 0.5 * a.strike
      n.jaw.rotation.x = -(0.05 + 0.5 * rear + 0.5 * a.strike)
      n.throat.scale.setScalar(0.5 + rear * 1.5 + a.strike * 2)
      for (let k = 0; k < 6; k++) n[`t${k}`].rotation.y = Math.sin(a.t * 1.8 - k * 0.6) * 0.18
    },
  },

  turret: {
    fixed: true,
    mats: (c) => ({
      hull: std('#26303c', 0.85, 0.3),
      dark: std('#11161c', 0.8, 0.4),
      glow: glow(c, 1.36),
    }),
    build(b) {
      const r = b.root
      b.add(r, 'hull', cyl(0.3, 0.32, 0.05, 12), [0, 0.88, 0])
      b.add(r, 'dark', cyl(0.05, 0.08, 0.5, 8), [0, 0.62, 0])
      b.add(r, 'glow', tor(0.06, 0.012, 4, 16).rotateX(PI / 2), [0, 0.5, 0])
      const pod = b.node('pod', r)
      b.add(pod, 'dark', cyl(0.12, 0.16, 0.18, 10), [0, 0.38, 0])
      b.add(pod, 'hull', sph(0.38, 22, 16), [0, 0, 0], [0, 0, 0], [1, 0.82, 1])
      b.add(pod, 'glow', tor(0.383, 0.01, 4, 48).rotateX(PI / 2), [0, 0.02, 0], [0, 0, 0], [1, 1, 1])
      b.add(pod, 'dark', rbox(0.34, 0.18, 0.12, 0.04), [0, -0.02, -0.3])
      b.add(pod, 'glow', sph(0.08, 14, 10), [0, 0.08, -0.33], [0, 0, 0], [1, 1, 0.6])
      b.add(pod, 'dark', tor(0.085, 0.015, 6, 20), [0, 0.08, -0.34])
      const guns = b.node('guns', pod)
      for (const s of [1, -1]) {
        b.add(guns, 'dark', cyl(0.045, 0.055, 0.5, 10).rotateX(PI / 2), [0.1 * s, -0.06, -0.48])
        b.add(guns, 'glow', tor(0.04, 0.008, 4, 14), [0.1 * s, -0.06, -0.73])
      }
    },
    anim(n, a) {
      n.guns.position.z = 0.08 * a.strike
      n.pod.rotation.x = Math.sin(a.t * 0.8 + a.seed) * 0.04 - 0.08 * a.windup
    },
  },

  mainframe_node: {
    fixed: true,
    mats: (c) => ({
      metal: std('#232c37', 0.85, 0.3),
      crystal: std('#3a1a08', 0.4, 0.2, c.getStyle(), 1.4),
      glow: glow(c, 1.24),
    }),
    build(b) {
      const r = b.root
      b.add(r, 'metal', cyl(0.8, 1.0, 0.5, 8), [0, 0.25, 0])
      b.add(r, 'glow', tor(0.82, 0.02, 4, 48).rotateX(PI / 2), [0, 0.45, 0])
      for (let k = 0; k < 4; k++) {
        const f = (k / 4) * PI * 2 + PI / 4
        b.add(r, 'metal', link([Math.sin(f) * 0.7, 0.5, Math.cos(f) * 0.7], [Math.sin(f) * 0.32, 1.25, Math.cos(f) * 0.32], 0.05, 0.03))
      }
      const spin = b.node('spin', r, [0, 1.6, 0])
      b.add(spin, 'crystal', new THREE.OctahedronGeometry(0.7).scale(1, 1.8, 1))
      for (let i = 0; i < 2; i++) {
        const ring = b.node(i ? 'ringB' : 'ringA', r, [0, 1.6, 0])
        b.add(ring, 'glow', tor(1.1 + i * 0.25, 0.04, 6, 40))
      }
    },
    anim(n, a) {
      n.spin.rotation.y = a.t * 0.8
      n.spin.position.y = 1.6 + Math.sin(a.t * 1.5) * 0.06
      n.ringA.rotation.set(a.t * 0.7, a.t * 0.4, 0)
      n.ringB.rotation.set(-a.t * 0.5, 0, a.t * 0.6)
    },
  },
}

export const hasModel = (key: string) => key in KINDS
export const isFixedModel = (key: string) => !!KINDS[key]?.fixed

// --- Templates and instances -----------------------------------------------------------------------
const templates = new Map<string, THREE.Group>()
let envMap: THREE.Texture | null = null

/** A soft reflection map for metal, so armour reads as metal in the dark corridors. */
export function setModelEnvironment(t: THREE.Texture) {
  envMap = t
}

function template(key: string, color: string) {
  const id = `${key}|${color}`
  let t = templates.get(id)
  if (!t) {
    const kind = KINDS[key]
    const c = new THREE.Color(color)
    const mats = kind.mats(c)
    for (const [k, m] of Object.entries(mats)) m.name = k
    const b = new Build(mats)
    kind.build(b, c)
    t = b.done()
    templates.set(id, t)
  }
  return t
}

interface MatState {
  m: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
  color: THREE.Color
  emissive: THREE.Color | null
  opacity: number
  transparent: boolean
  depthWrite: boolean
  accent: boolean
}

const tmp = new THREE.Color()

export class MonsterModel {
  readonly root: THREE.Group
  readonly fixed: boolean
  private kind: Kind
  private nodes: Nodes = {}
  private legs: THREE.Object3D[] = []
  private mats: MatState[] = []
  private opacity = 1
  private accent: THREE.Color | null = null

  constructor(key: string, color: string) {
    this.kind = KINDS[key]
    this.fixed = !!this.kind.fixed
    this.root = template(key, color).clone(true)
    const copies = new Map<THREE.Material, THREE.Material>()
    this.root.traverse((o) => {
      if (o.name) this.nodes[o.name] = o
      if (o.userData.leg) this.legs.push(o)
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const src = mesh.material as THREE.Material
      let m = copies.get(src)
      if (!m) {
        m = src.clone()
        copies.set(src, m)
        const s = m as THREE.MeshStandardMaterial
        if (s.isMeshStandardMaterial && envMap) {
          s.envMap = envMap
          s.envMapIntensity = 0.55
        }
        this.mats.push({
          m: m as THREE.MeshStandardMaterial,
          color: (m as THREE.MeshBasicMaterial).color.clone(),
          emissive: s.isMeshStandardMaterial ? s.emissive.clone() : null,
          opacity: m.opacity,
          transparent: m.transparent,
          depthWrite: m.depthWrite,
          accent: m.name === 'glow',
        })
      }
      mesh.material = m
    })
  }

  update(a: Anim) {
    this.kind.anim(this.nodes, a, this.legs)
  }

  /** Multiplies every colour, as the sprites were tinted: icy when frozen, white-hot on a hit. */
  tint(r: number, g: number, b: number) {
    const hot = Math.max(0, Math.max(r, g, b) - 1.6) * 0.5
    for (const s of this.mats) {
      tmp.copy(s.color)
      if (s.accent && this.accent) tmp.lerp(this.accent, 0.6)
      s.m.color.setRGB(tmp.r * r, tmp.g * g, tmp.b * b)
      const st = s.m as THREE.MeshStandardMaterial
      if (s.emissive) st.emissive.setRGB(s.emissive.r * r + hot * 0.6, s.emissive.g * g + hot * 0.5, s.emissive.b * b + hot * 0.5)
    }
  }

  /** Recolours the glowing parts toward an elite's or an ally's colour; null restores them. */
  setAccent(color: string | null) {
    this.accent = color ? new THREE.Color(color).multiplyScalar(2.2) : null
  }

  /** Fades the whole model, for phantoms that are hiding. */
  setOpacity(o: number) {
    if (Math.abs(o - this.opacity) < 0.005) return
    const was = this.opacity < 0.999
    this.opacity = o
    const now = o < 0.999
    for (const s of this.mats) {
      s.m.opacity = s.opacity * o
      if (was !== now) {
        s.m.transparent = now || s.transparent
        s.m.depthWrite = now ? false : s.depthWrite
        s.m.needsUpdate = true
      }
    }
  }

  dispose() {
    this.root.removeFromParent()
    for (const s of this.mats) s.m.dispose()
  }
}

/** The monster kinds that have a model. */
export const modelKinds = () => Object.keys(KINDS)
