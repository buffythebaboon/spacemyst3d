// Things that come and go with each snapshot: projectiles, area zones and loot on the floor.
import * as THREE from 'three'
import { WALL_HEIGHT } from '../../shared/constants.ts'
import { POTION_COLORS, RARITY_COLORS } from '../../shared/items.ts'
import type { LootNet, ProjNet, ZoneNet } from '../../shared/protocol.ts'
import { icon } from './art/icons.ts'
import { itemIcon } from './state.ts'
import { cloudTexture, discTexture, glowTexture, labelTexture, noiseTexture, ringTexture, urlTexture, webTexture } from './textures.ts'

const glow = glowTexture()
const additive = (color: THREE.ColorRepresentation, opacity = 1, map: THREE.Texture | null = glow) =>
  new THREE.SpriteMaterial({ map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })

// --- Projectiles ---------------------------------------------------------------------------------------
const PROJ_LOOK: Record<string, { color: string; size: number; core?: string }> = {
  cannon: { color: '#ffd34d', size: 0.9 },
  horizon: { color: '#c77dff', size: 1.6, core: '#000000' },
  grenade_emp: { color: '#4fa8ff', size: 0.5 },
  grenade_glitch: { color: '#ff4fd8', size: 0.5 },
  grenade_noise: { color: '#c8d2dc', size: 0.5 },
  potion: { color: '#ffffff', size: 0.45 },
  fireball: { color: '#ff7a3c', size: 0.9 },
  web: { color: '#e0e0ff', size: 0.7 },
  bolt: { color: '#ff5c5c', size: 0.55 },
  admin: { color: '#ff2a2a', size: 1.3 },
}

interface ProjView {
  net: ProjNet
  at: number
  group: THREE.Group
  trail: THREE.Line
  trailPts: Float32Array
  seen: number
  gravity: number
}

export class ProjectileLayer {
  readonly group = new THREE.Group()
  private views = new Map<number, ProjView>()
  private stamp = 0

  sync(list: ProjNet[], at: number, onNew?: (p: ProjNet) => void) {
    this.stamp++
    for (const p of list) {
      let v = this.views.get(p.id)
      if (!v) {
        v = this.create(p)
        this.views.set(p.id, v)
        onNew?.(p)
      }
      v.net = p
      v.at = at
      v.seen = this.stamp
    }
    for (const [id, v] of this.views)
      if (v.seen !== this.stamp) {
        this.disposeView(v)
        this.views.delete(id)
      }
  }

  private create(p: ProjNet): ProjView {
    const look = PROJ_LOOK[p.k] ?? { color: p.o ? '#5cf2ff' : '#ff5c5c', size: 0.6 }
    const color = p.k === 'potion' && p.c !== undefined ? (POTION_COLORS[p.c]?.css ?? '#ffffff') : look.color
    const group = new THREE.Group()
    const halo = new THREE.Sprite(additive(color, 0.9))
    halo.scale.setScalar(look.size)
    group.add(halo)
    if (look.core) {
      const core = new THREE.Mesh(new THREE.SphereGeometry(look.size * 0.22, 16, 12), new THREE.MeshBasicMaterial({ color: look.core }))
      group.add(core)
    } else {
      const core = new THREE.Sprite(additive('#ffffff', 1))
      core.scale.setScalar(look.size * 0.35)
      group.add(core)
    }
    if (p.k.startsWith('grenade_') || p.k === 'potion') {
      const body = new THREE.Mesh(
        p.k === 'potion' ? new THREE.SphereGeometry(0.12, 10, 8) : new THREE.CylinderGeometry(0.09, 0.09, 0.22, 10),
        new THREE.MeshStandardMaterial({ color: p.k === 'potion' ? color : '#2b3744', emissive: color, emissiveIntensity: 0.6, metalness: 0.5, roughness: 0.3 }),
      )
      body.name = 'spin'
      group.add(body)
    }
    const N = 10
    const trailPts = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) trailPts.set([p.x, p.y, p.z], i * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(trailPts, 3))
    const trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }))
    trail.frustumCulled = false
    this.group.add(group, trail)
    const gravity = p.k.startsWith('grenade_') || p.k === 'potion' ? 18 : 0
    return { net: p, at: performance.now() / 1000, group, trail, trailPts, seen: this.stamp, gravity }
  }

  /** Where a projectile is right now, extrapolated from its last snapshot. */
  update(now: number, time: number) {
    for (const v of this.views.values()) {
      const t = Math.min(0.25, now - v.at)
      const p = v.net
      const x = p.x + p.vx * t
      const z = p.z + p.vz * t
      const y = Math.max(0.12, Math.min(WALL_HEIGHT - 0.1, p.y + p.vy * t - 0.5 * v.gravity * t * t))
      v.group.position.set(x, y, z)
      const spin = v.group.getObjectByName('spin')
      if (spin) spin.rotation.set(time * 9, time * 7, 0)
      const a = v.trailPts
      a.copyWithin(3, 0, a.length - 3)
      a[0] = x
      a[1] = y
      a[2] = z
      ;(v.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  positions() {
    return [...this.views.values()].map((v) => ({ k: v.net.k, pos: v.group.position }))
  }

  private disposeView(v: ProjView) {
    v.group.removeFromParent()
    v.trail.removeFromParent()
    v.trail.geometry.dispose()
    ;(v.trail.material as THREE.Material).dispose()
    v.group.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      ;(m.material as THREE.Material | undefined)?.dispose()
    })
  }

  clear() {
    for (const v of this.views.values()) this.disposeView(v)
    this.views.clear()
  }
}

// --- Zones ---------------------------------------------------------------------------------------------
const fireVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const fireFrag = /* glsl */ `
uniform float uTime; uniform vec3 uColor; uniform float uFade; varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
  vec2 p = vec2(vUv.x * 8.0, vUv.y * 3.0 - uTime * 2.5);
  float n = noise(p) * 0.6 + noise(p * 2.3) * 0.4;
  float h = 1.0 - vUv.y;
  float a = smoothstep(0.15, 0.9, n * h * 1.6) * uFade;
  a *= smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
  gl_FragColor = vec4(uColor * (1.5 + n), a);
}`

interface ZoneView {
  net: ZoneNet
  group: THREE.Group
  seen: number
  tick?: (time: number, dt: number) => void
  mats: THREE.Material[]
}

const ZONE_COLORS: Record<string, string> = {
  firewall: '#ff7a3c',
  stasis: '#9ff6ff',
  acid: '#9dff00',
  toxic: '#7dff5c',
  noise: '#c8d2dc',
  junk: '#c9ff5c',
  web: '#e0e0ff',
  honeypot: '#ffd34d',
  daemon: '#4fa8ff',
  blackhole: '#c77dff',
  mine: '#ff3b5c',
  crater: '#ff8a3c',
  torrent: '#2effd5',
}

export class ZoneLayer {
  readonly group = new THREE.Group()
  private views = new Map<number, ZoneView>()
  private stamp = 0

  sync(list: ZoneNet[]) {
    this.stamp++
    for (const z of list) {
      let v = this.views.get(z.id)
      if (!v) {
        v = this.create(z)
        this.views.set(z.id, v)
      }
      v.net = z
      v.seen = this.stamp
      v.group.position.set(z.x, 0, z.z)
    }
    for (const [id, v] of this.views)
      if (v.seen !== this.stamp) {
        this.disposeView(v)
        this.views.delete(id)
      }
  }

  private create(z: ZoneNet): ZoneView {
    const group = new THREE.Group()
    group.position.set(z.x, 0, z.z)
    const color = ZONE_COLORS[z.k] ?? '#ffffff'
    const mats: THREE.Material[] = []
    const view: ZoneView = { net: z, group, seen: this.stamp, mats }
    const floorDisc = (map: THREE.Texture, opacity: number, r = z.r, tint = color, add = true) => {
      const m = new THREE.MeshBasicMaterial({ map, color: tint, transparent: true, opacity, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending })
      mats.push(m)
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), m)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = 0.05
      group.add(mesh)
      return mesh
    }
    const angle = z.a ?? 0
    switch (z.k) {
      case 'firewall':
      case 'torrent': {
        const len = z.l ?? 6
        const holder = new THREE.Group()
        holder.rotation.y = -angle
        group.add(holder)
        if (z.k === 'firewall') {
          const mat = new THREE.ShaderMaterial({
            uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uFade: { value: 1 } },
            vertexShader: fireVert,
            fragmentShader: fireFrag,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          })
          mats.push(mat)
          for (const off of [-0.25, 0.25]) {
            const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.6), mat)
            wall.position.set(0, 1.3, off)
            holder.add(wall)
          }
          view.tick = (time) => {
            mat.uniforms.uTime.value = time
            mat.uniforms.uFade.value = Math.min(1, view.net.t * 2)
          }
        } else {
          const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
          mats.push(m)
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(z.r * 0.7, z.r * 0.7, len, 12, 1, true).rotateZ(Math.PI / 2), m)
          beam.position.y = 1.2
          holder.add(beam)
          view.tick = () => {
            m.opacity = 0.5 + Math.random() * 0.4
          }
        }
        break
      }
      case 'stasis': {
        const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })
        mats.push(m)
        const dome = new THREE.Mesh(new THREE.SphereGeometry(z.r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), m)
        group.add(dome)
        floorDisc(discTexture(), 0.6)
        view.tick = (time) => {
          m.opacity = 0.14 + Math.sin(time * 4) * 0.04
        }
        break
      }
      case 'acid':
      case 'junk':
      case 'crater': {
        const disc = floorDisc(discTexture(), z.k === 'junk' ? 0.55 : 0.75)
        const bubbles: THREE.Sprite[] = []
        for (let i = 0; i < 6; i++) {
          const s = new THREE.Sprite(additive(color, 0))
          s.scale.setScalar(0.35)
          group.add(s)
          bubbles.push(s)
          mats.push(s.material)
        }
        view.tick = (time) => {
          ;(disc.material as THREE.MeshBasicMaterial).opacity = (z.k === 'crater' ? 0.5 + Math.random() * 0.3 : 0.6) * Math.min(1, view.net.t)
          for (const s of bubbles) {
            if (Math.random() < 0.05) {
              const a = Math.random() * Math.PI * 2
              const r = Math.random() * z.r * 0.8
              s.position.set(Math.cos(a) * r, 0.1, Math.sin(a) * r)
              s.material.opacity = 0.9
            }
            s.position.y += 0.01
            s.material.opacity *= 0.95
          }
          void time
        }
        break
      }
      case 'toxic':
      case 'noise': {
        const puffs: THREE.Sprite[] = []
        const map = z.k === 'toxic' ? cloudTexture() : noiseTexture()
        for (let i = 0; i < 9; i++) {
          const m = new THREE.SpriteMaterial({ map, color, transparent: true, opacity: z.k === 'toxic' ? 0.5 : 0.35, depthWrite: false, blending: z.k === 'noise' ? THREE.AdditiveBlending : THREE.NormalBlending })
          mats.push(m)
          const s = new THREE.Sprite(m)
          const a = (i / 9) * Math.PI * 2
          const r = i === 0 ? 0 : z.r * 0.55
          s.position.set(Math.cos(a) * r, 1 + Math.random() * 0.8, Math.sin(a) * r)
          s.scale.setScalar(z.r * 1.3)
          group.add(s)
          puffs.push(s)
        }
        view.tick = (time) => {
          puffs.forEach((s, i) => {
            s.material.rotation = time * 0.2 * (i % 2 ? 1 : -1)
            if (z.k === 'noise') s.material.map!.offset.set(Math.random(), Math.random())
            s.material.opacity = (z.k === 'toxic' ? 0.45 : 0.3) * Math.min(1, view.net.t)
          })
        }
        break
      }
      case 'web':
        floorDisc(webTexture(), 0.85, z.r, '#e0e0ff', false)
        break
      case 'honeypot': {
        const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), wireframe: true, transparent: true, opacity: 0.7 })
        mats.push(m)
        const decoy = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.9, 4, 8), m)
        decoy.position.y = 0.9
        group.add(decoy)
        const ring = floorDisc(ringTexture(), 0.4, 1.4)
        view.tick = (time) => {
          decoy.rotation.y = time * 2
          ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(time * 5) * 0.2
        }
        break
      }
      case 'daemon': {
        const m = new THREE.MeshStandardMaterial({ color: '#1b2a3c', emissive: color, emissiveIntensity: 1.2, metalness: 0.6, roughness: 0.3 })
        mats.push(m)
        const drone = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), m)
        group.add(drone)
        const halo = new THREE.Sprite(additive(color, 0.6))
        halo.scale.setScalar(1.1)
        group.add(halo)
        mats.push(halo.material)
        view.tick = (time) => {
          drone.position.y = 2.4 + Math.sin(time * 3) * 0.12
          halo.position.y = drone.position.y
          drone.rotation.y = time * 3
        }
        break
      }
      case 'blackhole': {
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshBasicMaterial({ color: '#000000' }))
        core.position.y = 1.2
        group.add(core)
        mats.push(core.material as THREE.Material)
        const swirl = new THREE.Sprite(additive(color, 0.8, ringTexture()))
        swirl.position.y = 1.2
        swirl.scale.setScalar(2.4)
        group.add(swirl)
        mats.push(swirl.material)
        floorDisc(discTexture(), 0.4)
        view.tick = (time) => {
          swirl.material.rotation = time * 6
          const s = 2 + Math.sin(time * 20) * 0.3
          swirl.scale.setScalar(s)
        }
        break
      }
      case 'mine': {
        const disc = floorDisc(discTexture(), 0.8, 0.5)
        view.tick = (time) => {
          ;(disc.material as THREE.MeshBasicMaterial).opacity = Math.sin(time * 8) > 0 ? 0.9 : 0.2
        }
        break
      }
    }
    this.group.add(group)
    return view
  }

  update(time: number, dt: number) {
    for (const v of this.views.values()) v.tick?.(time, dt)
  }

  private disposeView(v: ZoneView) {
    v.group.removeFromParent()
    v.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    for (const m of v.mats) m.dispose()
  }

  clear() {
    for (const v of this.views.values()) this.disposeView(v)
    this.views.clear()
  }
}

// --- Loot ------------------------------------------------------------------------------------------------
interface LootView {
  net: LootNet
  group: THREE.Group
  icon: THREE.Sprite
  label: THREE.Sprite
  beam: THREE.Mesh
  seen: number
  phase: number
}

export class LootLayer {
  readonly group = new THREE.Group()
  private views = new Map<number, LootView>()
  private stamp = 0

  sync(list: LootNet[]) {
    this.stamp++
    for (const l of list) {
      let v = this.views.get(l.id)
      if (!v) {
        v = this.create(l)
        this.views.set(l.id, v)
      }
      v.seen = this.stamp
      v.net = l
      v.group.position.set(l.x, 0, l.z)
    }
    for (const [id, v] of this.views)
      if (v.seen !== this.stamp) {
        this.disposeView(v)
        this.views.delete(id)
      }
  }

  private create(l: LootNet): LootView {
    const group = new THREE.Group()
    const color = l.kind === 'credits' ? '#ffd34d' : l.kind === 'dump' ? '#c77dff' : RARITY_COLORS[l.rarity] ?? '#ffffff'
    const url = l.kind === 'credits' || l.kind === 'dump' ? icon('item:credits') : itemIcon({ kind: l.kind, base: l.base })
    const ic = new THREE.Sprite(new THREE.SpriteMaterial({ map: urlTexture(url), transparent: true, depthWrite: false }))
    ic.scale.setScalar(l.kind === 'dump' ? 0.9 : 0.6)
    group.add(ic)
    const halo = new THREE.Sprite(additive(color, 0.5))
    halo.scale.setScalar(1.2)
    halo.position.y = 0.5
    group.add(halo)
    const tall = l.kind === 'dump' ? WALL_HEIGHT : l.kind === 'credits' ? 0.6 : 0.8 + l.rarity * 0.7
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06 + l.rarity * 0.02, 0.12 + l.rarity * 0.03, tall, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    beam.position.y = tall / 2
    group.add(beam)
    const text = l.kind === 'credits' ? `${l.qty} credits` : l.kind === 'dump' ? 'YOUR DATA DUMP' : l.qty > 1 ? `${l.name} ×${l.qty}` : l.name
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, color, { width: 640, height: 80 }), transparent: true, depthWrite: false, depthTest: false }))
    label.renderOrder = 4
    label.scale.set(2.8, 0.35, 1)
    label.position.y = 1.15
    label.visible = false
    group.add(label)
    group.position.set(l.x, 0, l.z)
    this.group.add(group)
    return { net: l, group, icon: ic, label, beam, seen: this.stamp, phase: Math.random() * 6 }
  }

  update(time: number, eye: THREE.Vector3) {
    for (const v of this.views.values()) {
      v.icon.position.y = 0.55 + Math.sin(time * 2.5 + v.phase) * 0.1
      const d = Math.hypot(v.group.position.x - eye.x, v.group.position.z - eye.z)
      v.label.visible = d < 7 || v.net.kind === 'dump'
      ;(v.beam.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(time * 3 + v.phase) * 0.1
    }
  }

  all() {
    return [...this.views.values()].map((v) => v.net)
  }

  private disposeView(v: LootView) {
    v.group.removeFromParent()
    v.beam.geometry.dispose()
    ;(v.beam.material as THREE.Material).dispose()
    v.label.material.map?.dispose()
    v.label.material.dispose()
    v.icon.material.dispose()
  }

  clear() {
    for (const v of this.views.values()) this.disposeView(v)
    this.views.clear()
  }
}
