// First-person weapon models: one per weapon type, with recoil, sway, swaps, charge and swings.
import * as THREE from 'three'
import { WEAPONS, type WeaponType } from '../../shared/items.ts'
import { glowTexture, metalMatcap } from './textures.ts'

interface Model {
  group: THREE.Group
  muzzle: THREE.Object3D
  glow: THREE.MeshBasicMaterial[]
  color: THREE.Color
  /** Extra per-frame animation (spinning orbs, coils). */
  animate?: (time: number, charge: number, firing: boolean) => void
}

const metal = () => new THREE.MeshMatcapMaterial({ matcap: metalMatcap(), color: '#8894a0' })
const dark = () => new THREE.MeshMatcapMaterial({ matcap: metalMatcap('#34404c'), color: '#3a424c' })

function glowMat(color: THREE.Color, k = 1.3) {
  return new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(k) })
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  return m
}

function cyl(r1: number, r2: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg).rotateX(Math.PI / 2), mat)
  m.position.set(x, y, z)
  return m
}

function build(type: WeaponType): Model {
  const color = new THREE.Color(WEAPONS[type].color)
  const g = new THREE.Group()
  const muzzle = new THREE.Object3D()
  const gm = glowMat(color)
  const glow = [gm]
  const m = metal()
  const d = dark()
  let animate: Model['animate']
  switch (type) {
    case 'laser': {
      g.add(box(0.1, 0.12, 0.42, m))
      g.add(box(0.06, 0.04, 0.3, d, 0, 0.08, -0.02))
      const grip = box(0.07, 0.16, 0.08, d, 0, -0.11, 0.1)
      grip.rotation.x = -0.25
      g.add(grip)
      g.add(cyl(0.028, 0.034, 0.3, m, 0, 0.01, -0.33))
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.007, 6, 16), gm)
        ring.position.set(0, 0.01, -0.24 - i * 0.07)
        g.add(ring)
      }
      g.add(box(0.104, 0.012, 0.3, gm, 0, 0.02, 0))
      g.add(box(0.05, 0.05, 0.08, gm, -0.055, 0, 0.08))
      muzzle.position.set(0, 0.01, -0.5)
      break
    }
    case 'blade': {
      const hilt = cyl(0.03, 0.035, 0.18, d, 0, -0.02, 0.08)
      g.add(hilt)
      g.add(box(0.14, 0.03, 0.04, m, 0, -0.02, -0.02))
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.06, 0.62), gm)
      blade.position.set(0, -0.02, -0.34)
      g.add(blade)
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.12, 0.66),
        new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
      )
      edge.position.copy(blade.position)
      g.add(edge)
      muzzle.position.set(0, -0.02, -0.6)
      animate = (time) => {
        ;(edge.material as THREE.MeshBasicMaterial).opacity = 0.2 + Math.sin(time * 12) * 0.06
      }
      break
    }
    case 'plasma': {
      g.add(box(0.14, 0.15, 0.38, d))
      g.add(box(0.1, 0.06, 0.26, m, 0, 0.1, 0.02))
      const grip = box(0.07, 0.17, 0.09, d, 0, -0.13, 0.08)
      grip.rotation.x = -0.25
      g.add(grip)
      g.add(cyl(0.05, 0.035, 0.2, m, 0, 0.0, -0.28))
      const coils: THREE.Mesh[] = []
      for (let i = 0; i < 4; i++) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 18), gm)
        coil.position.set(0, 0, -0.1 + i * 0.06)
        g.add(coil)
        coils.push(coil)
      }
      g.add(cyl(0.03, 0.03, 0.16, gm, 0.085, 0.02, 0.02, 8))
      muzzle.position.set(0, 0, -0.4)
      animate = (time, _c, firing) => {
        coils.forEach((c, i) => c.scale.setScalar(1 + (firing ? Math.sin(time * 40 + i) * 0.12 : 0)))
      }
      break
    }
    case 'railgun': {
      g.add(box(0.1, 0.12, 0.34, d, 0, 0, 0.08))
      const grip = box(0.07, 0.16, 0.08, d, 0, -0.12, 0.14)
      grip.rotation.x = -0.25
      g.add(grip)
      for (const s of [-1, 1]) {
        g.add(box(0.025, 0.04, 0.6, m, s * 0.045, 0.01, -0.3))
        g.add(box(0.01, 0.02, 0.56, gm, s * 0.03, 0.01, -0.3))
      }
      const cells: THREE.Mesh[] = []
      for (let i = 0; i < 3; i++) {
        const c = box(0.04, 0.04, 0.04, gm, 0, 0.08, 0.14 - i * 0.07)
        g.add(c)
        cells.push(c)
      }
      const orb = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }))
      orb.position.set(0, 0.01, -0.58)
      g.add(orb)
      muzzle.position.set(0, 0.01, -0.62)
      animate = (time, charge) => {
        orb.material.opacity = charge
        orb.scale.setScalar(0.1 + charge * 0.25 + Math.sin(time * 50) * 0.02 * charge)
        cells.forEach((c, i) => (c.visible = charge > i / 3 || charge === 0))
      }
      break
    }
    case 'cannon': {
      g.add(box(0.16, 0.17, 0.36, d, 0, 0, 0.06))
      const grip = box(0.08, 0.17, 0.09, d, 0, -0.14, 0.12)
      grip.rotation.x = -0.25
      g.add(grip)
      g.add(cyl(0.075, 0.085, 0.36, m, 0, 0.02, -0.26, 14))
      g.add(cyl(0.05, 0.05, 0.02, gm, 0, 0.02, -0.445, 14))
      for (let i = 0; i < 3; i++) g.add(box(0.172, 0.02, 0.03, gm, 0, 0.05, 0.12 - i * 0.08))
      muzzle.position.set(0, 0.02, -0.47)
      break
    }
    case 'horizon': {
      g.add(box(0.12, 0.12, 0.3, d, 0, 0, 0.08))
      const grip = box(0.07, 0.16, 0.08, d, 0, -0.12, 0.14)
      grip.rotation.x = -0.25
      g.add(grip)
      for (let i = 0; i < 3; i++) {
        const prong = box(0.02, 0.02, 0.26, m, 0, 0, -0.18)
        const a = (i / 3) * Math.PI * 2
        prong.position.set(Math.cos(a) * 0.06, Math.sin(a) * 0.06, -0.18)
        g.add(prong)
      }
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 10), new THREE.MeshBasicMaterial({ color: '#000000' }))
      core.position.set(0, 0, -0.3)
      g.add(core)
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
      halo.position.copy(core.position)
      halo.scale.setScalar(0.16)
      g.add(halo)
      muzzle.position.set(0, 0, -0.36)
      animate = (time) => {
        halo.material.rotation = time * 4
        halo.scale.setScalar(0.15 + Math.sin(time * 7) * 0.02)
      }
      break
    }
  }
  g.add(muzzle)
  return { group: g, muzzle, glow, color, animate }
}

export class WeaponRig {
  readonly root = new THREE.Group()
  private holder = new THREE.Group()
  private models = new Map<WeaponType, Model>()
  private current: Model | null = null
  private currentType: WeaponType | null = null
  private pending: WeaponType | null = null
  private swap = 0
  private recoil = 0
  private flashT = 0
  private swing = 0
  private swayX = 0
  private swayY = 0
  private phase = 0
  private flash: THREE.Sprite
  readonly light: THREE.PointLight
  private beam: THREE.Mesh
  private beamMat: THREE.MeshBasicMaterial
  charge = 0
  firing = false
  private readonly base = new THREE.Vector3(0.26, -0.24, -0.48)

  constructor() {
    this.root.add(this.holder)
    this.root.position.copy(this.base)
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#9ff6ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.flash.scale.setScalar(0.35)
    this.flash.visible = false
    this.light = new THREE.PointLight('#5cf2ff', 0, 8, 2)
    this.beamMat = new THREE.MeshBasicMaterial({ color: '#ff8a3c', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5), this.beamMat)
    this.beam.visible = false
  }

  /** Switch to a weapon type, with a quick lower-and-raise. */
  set(type: WeaponType) {
    if (type === this.currentType && !this.pending) return
    if (!this.current) {
      this.mount(type)
      return
    }
    if (this.pending === type) return
    this.pending = type
  }

  private mount(type: WeaponType) {
    if (this.current) this.holder.remove(this.current.group)
    let m = this.models.get(type)
    if (!m) {
      m = build(type)
      this.models.set(type, m)
    }
    this.current = m
    this.currentType = type
    this.holder.add(m.group)
    m.muzzle.add(this.flash)
    m.muzzle.add(this.light)
    m.muzzle.add(this.beam)
    this.flash.material.color.copy(m.color)
    this.light.color.copy(m.color)
    this.beamMat.color.copy(m.color).multiplyScalar(2)
  }

  muzzleWorld(out = new THREE.Vector3()) {
    return this.current ? this.current.muzzle.getWorldPosition(out) : this.root.getWorldPosition(out)
  }

  fire(strength = 1, color?: THREE.ColorRepresentation) {
    this.recoil = Math.min(2, 0.6 + strength)
    this.flashT = 0.06
    const c = color ? new THREE.Color(color) : (this.current?.color ?? new THREE.Color('#9ff6ff'))
    this.flash.material.color.copy(c)
    this.light.color.copy(c)
    this.flash.scale.setScalar(0.25 + strength * 0.25)
    for (const g of this.current?.glow ?? []) g.color.copy(c).multiplyScalar(2.2)
  }

  slash() {
    this.swing = 1
  }

  /** Plasma beam length in metres while the trigger is held. */
  setBeam(length: number) {
    this.beam.visible = length > 0
    if (length > 0) {
      const w = 0.03 + Math.random() * 0.02
      this.beam.scale.set(w, w, length)
      this.beamMat.opacity = 0.6 + Math.random() * 0.4
    }
  }

  sway(dx: number, dy: number) {
    this.swayX = Math.max(-0.04, Math.min(0.04, this.swayX - dx * 0.0004))
    this.swayY = Math.max(-0.04, Math.min(0.04, this.swayY + dy * 0.0004))
  }

  update(dt: number, time: number, speed01: number) {
    if (this.pending) {
      this.swap = Math.min(1, this.swap + dt * 6)
      if (this.swap >= 1) {
        this.mount(this.pending)
        this.pending = null
      }
    } else this.swap = Math.max(0, this.swap - dt * 5)
    this.phase += dt * (4 + speed01 * 6)
    const walk = Math.min(1, speed01)
    this.recoil = Math.max(0, this.recoil - dt * 7)
    this.swing = Math.max(0, this.swing - dt * 5.5)
    this.swayX *= 1 - Math.min(1, dt * 8)
    this.swayY *= 1 - Math.min(1, dt * 8)
    this.root.position.set(
      this.base.x + this.swayX + Math.sin(this.phase) * 0.012 * walk,
      this.base.y + this.swayY + Math.abs(Math.cos(this.phase)) * 0.014 * walk + Math.sin(this.phase * 0.3) * 0.003 - this.swap * 0.35 + this.charge * 0.01,
      this.base.z + this.recoil * 0.06 - this.charge * 0.03,
    )
    // A swing sweeps the blade from right to left.
    const s = this.swing
    this.holder.rotation.set(this.recoil * 0.16 + s * 0.4, s > 0 ? Math.sin((1 - s) * Math.PI) * 1.1 - 0.3 * s : 0, s > 0 ? -Math.sin((1 - s) * Math.PI) * 0.6 : 0)
    this.flashT -= dt
    this.flash.visible = this.flashT > 0
    this.flash.material.rotation = Math.random() * Math.PI
    this.light.intensity = this.flashT > 0 ? 25 : this.beam.visible ? 12 : 0
    if (this.recoil === 0 && this.current) for (const g of this.current.glow) g.color.copy(this.current.color).multiplyScalar(1.3 + this.charge * 1.5)
    this.current?.animate?.(time, this.charge, this.firing)
  }
}
