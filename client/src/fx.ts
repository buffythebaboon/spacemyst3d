// Short-lived visual effects: beams, flashes, sparks, shockwaves, numbers and telegraphs.
import * as THREE from 'three'
import { discTexture, glowTexture, ringTexture, stripTexture } from './textures.ts'

interface Effect {
  obj: THREE.Object3D
  life: number
  max: number
  tick: (t: number, dt: number) => void
  dispose: () => void
}

const glow = glowTexture()
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5)
// Thin at the start: your own shots leave the gun right in front of the camera.
const taperGeo = new THREE.CylinderGeometry(1, 0.25, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5)
const planeGeo = new THREE.PlaneGeometry(1, 1)
const tmp = new THREE.Vector3()

export class Effects {
  private list: Effect[] = []
  /** The camera, so glows that go off right in your face fade instead of whiting out the view. */
  eye: THREE.Vector3 | null = null
  constructor(private scene: THREE.Scene) {}

  /** 0..1: how much of a glow of this size to show at a point, fading as the camera gets inside it. */
  private nearFade(pos: THREE.Vector3, size: number) {
    if (!this.eye) return 1
    return Math.min(1, Math.max(0, (pos.distanceTo(this.eye) - size * 0.5) / size))
  }

  private add(e: Effect) {
    this.scene.add(e.obj)
    this.list.push(e)
    return e
  }

  get count() {
    return this.list.length
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, width = 0.04, life = 0.14, flash = true, taper = false) {
    const group = new THREE.Group()
    const len = Math.max(0.01, from.distanceTo(to))
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const outerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
    const geo = taper ? taperGeo : beamGeo
    const core = new THREE.Mesh(geo, coreMat)
    core.scale.set(width, width, len)
    const outer = new THREE.Mesh(geo, outerMat)
    outer.scale.set(width * 3.5, width * 3.5, len)
    group.add(core, outer)
    group.position.copy(from)
    group.lookAt(to)
    this.add({
      obj: group,
      life: 0,
      max: life,
      tick: (t) => {
        const f = 1 - t
        coreMat.opacity = f
        outerMat.opacity = 0.35 * f
        core.scale.x = core.scale.y = width * f
      },
      dispose: () => {
        coreMat.dispose()
        outerMat.dispose()
      },
    })
    if (flash) this.flash(to, color, Math.min(0.9, 0.2 + len * 0.2))
  }

  /** A jagged bolt through a list of points (System Shock, Event Horizon pulls). */
  bolt(points: THREE.Vector3[], color: THREE.ColorRepresentation, life = 0.35, jitter = 0.35) {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      const n = Math.max(2, Math.ceil(a.distanceTo(b) / 0.7))
      for (let k = 0; k < n; k++) {
        const p = a.clone().lerp(b, k / n)
        if (k > 0) p.add(new THREE.Vector3((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter))
        pts.push(p)
      }
    }
    pts.push(points[points.length - 1].clone())
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const line = new THREE.Line(geo, mat)
    this.add({
      obj: line,
      life: 0,
      max: life,
      tick: (t) => {
        mat.opacity = (1 - t) * (0.6 + Math.random() * 0.4)
      },
      dispose: () => {
        geo.dispose()
        mat.dispose()
      },
    })
    for (const p of points.slice(1)) this.flash(p, color, 1.4)
  }

  flash(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life = 0.18) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
    s.position.copy(pos)
    s.scale.setScalar(size)
    s.material.opacity = this.nearFade(pos, size)
    this.add({
      obj: s,
      life: 0,
      max: life,
      tick: (t) => {
        const grown = size * (1 + t)
        s.scale.setScalar(grown)
        s.material.opacity = (1 - t) * this.nearFade(s.position, grown)
      },
      dispose: () => s.material.dispose(),
    })
  }

  burst(pos: THREE.Vector3, color: THREE.ColorRepresentation, count = 60, speed = 6, life = 1, size = 0.35) {
    const pts = new Float32Array(count * 3)
    const vel: THREE.Vector3[] = []
    for (let i = 0; i < count; i++) {
      pts.set([pos.x, pos.y, pos.z], i * 3)
      vel.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random())))
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    // Sparks that start right next to the camera would fly through it as huge blobs.
    const near = this.eye ? Math.min(1, Math.max(0.2, pos.distanceTo(this.eye) / 4)) : 1
    const mat = new THREE.PointsMaterial({ map: glow, color, size: size * near, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const points = new THREE.Points(geo, mat)
    this.add({
      obj: points,
      life: 0,
      max: life,
      tick: (t, dt) => {
        const a = geo.attributes.position as THREE.BufferAttribute
        for (let i = 0; i < count; i++) {
          const v = vel[i]
          v.y -= 6 * dt
          v.multiplyScalar(1 - 1.5 * dt)
          a.setXYZ(i, a.getX(i) + v.x * dt, Math.max(0.02, a.getY(i) + v.y * dt), a.getZ(i) + v.z * dt)
        }
        a.needsUpdate = true
        mat.opacity = (1 - t) * near
      },
      dispose: () => {
        geo.dispose()
        mat.dispose()
      },
    })
    this.flash(pos, color, Math.min(5, count / 15))
  }

  /** Rising particles, for heals and level-ups. */
  rise(pos: THREE.Vector3, color: THREE.ColorRepresentation, count = 30, radius = 0.8, life = 1.2) {
    const pts = new Float32Array(count * 3)
    const speed: number[] = []
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const r = radius * (0.5 + Math.random() * 0.5)
      pts.set([pos.x + Math.cos(a) * r, pos.y + Math.random() * 0.6, pos.z + Math.sin(a) * r], i * 3)
      speed.push(1 + Math.random() * 1.5)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    const mat = new THREE.PointsMaterial({ map: glow, color, size: 0.25, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const points = new THREE.Points(geo, mat)
    this.add({
      obj: points,
      life: 0,
      max: life,
      tick: (t, dt) => {
        const a = geo.attributes.position as THREE.BufferAttribute
        for (let i = 0; i < count; i++) a.setY(i, a.getY(i) + speed[i] * dt)
        a.needsUpdate = true
        mat.opacity = 1 - t
      },
      dispose: () => {
        geo.dispose()
        mat.dispose()
      },
    })
  }

  /** Expanding ring on the floor. */
  ring(x: number, z: number, radius: number, color: THREE.ColorRepresentation, life = 0.5, y = 0.08) {
    const mat = new THREE.MeshBasicMaterial({ map: ringTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    const m = new THREE.Mesh(planeGeo, mat)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y, z)
    this.add({
      obj: m,
      life: 0,
      max: life,
      tick: (t) => {
        const r = radius * (0.2 + 0.8 * Math.sqrt(t)) * 2
        m.scale.set(r, r, 1)
        mat.opacity = 1 - t
      },
      dispose: () => mat.dispose(),
    })
  }

  /** A glowing dome that swells and fades: explosions. */
  dome(x: number, y: number, z: number, radius: number, color: THREE.ColorRepresentation, life = 0.45) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat)
    m.position.set(x, y, z)
    this.add({
      obj: m,
      life: 0,
      max: life,
      tick: (t) => {
        m.scale.setScalar(radius * (0.3 + 0.7 * Math.sqrt(t)))
        mat.opacity = 0.5 * (1 - t)
      },
      dispose: () => {
        m.geometry.dispose()
        mat.dispose()
      },
    })
  }

  explosion(x: number, z: number, radius: number, color: THREE.ColorRepresentation, y = 0.6) {
    this.dome(x, y, z, radius, color)
    this.ring(x, z, radius, color, 0.6)
    this.burst(new THREE.Vector3(x, y, z), color, 40 + Math.round(radius * 10), radius * 2.2, 0.9, 0.4)
  }

  /** Floating damage or reward text. */
  number(pos: THREE.Vector3, text: string, color: string, scale = 1) {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 64
    const g = c.getContext('2d')!
    g.font = 'bold 44px "Orbitron", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 6
    g.strokeStyle = 'rgba(0,0,0,0.8)'
    g.strokeText(text, 128, 32)
    g.fillStyle = color
    g.fillText(text, 128, 32)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
    s.renderOrder = 10
    s.scale.set(1.6 * scale, 0.4 * scale, 1)
    s.position.copy(pos)
    const drift = (Math.random() - 0.5) * 0.8
    this.add({
      obj: s,
      life: 0,
      max: 0.9,
      tick: (t, dt) => {
        s.position.y += dt * 1.6
        s.position.x += dt * drift
        s.material.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4
      },
      dispose: () => {
        tex.dispose()
        s.material.dispose()
      },
    })
  }

  /** Melee slash: a bright arc in front of a point. */
  slash(origin: THREE.Vector3, yaw: number, color: THREE.ColorRepresentation, reach = 3.2) {
    const geo = new THREE.RingGeometry(reach * 0.55, reach, 24, 1, -0.75, 1.5)
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(origin)
    m.rotation.set(-Math.PI / 2, 0, yaw + Math.PI / 2)
    this.add({
      obj: m,
      life: 0,
      max: 0.18,
      tick: (t) => {
        mat.opacity = 0.7 * (1 - t)
        m.rotation.z = yaw + Math.PI / 2 + (t - 0.5) * 0.6
      },
      dispose: () => {
        geo.dispose()
        mat.dispose()
      },
    })
  }

  /** Floor warning for an incoming attack. It fills up until the hit lands. */
  telegraph(shape: 'circle' | 'line' | 'cone', x: number, z: number, r: number, a: number, l: number, dur: number, color = '#ff3355') {
    const group = new THREE.Group()
    group.position.set(x, 0.06, z)
    let outline: THREE.Mesh
    let fill: THREE.Mesh
    const outlineMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    let grow: (t: number) => void
    if (shape === 'circle') {
      outlineMat.map = ringTexture()
      fillMat.map = discTexture()
      outline = new THREE.Mesh(planeGeo, outlineMat)
      fill = new THREE.Mesh(planeGeo, fillMat)
      outline.scale.set(r * 2, r * 2, 1)
      grow = (t) => fill.scale.set(r * 2 * t, r * 2 * t, 1)
      outline.rotation.x = fill.rotation.x = -Math.PI / 2
    } else if (shape === 'line') {
      outlineMat.map = stripTexture()
      fillMat.map = stripTexture()
      const g1 = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
      outline = new THREE.Mesh(g1, outlineMat)
      fill = new THREE.Mesh(g1, fillMat)
      outline.scale.set(r * 2, l, 1)
      grow = (t) => fill.scale.set(r * 2, l * t, 1)
      // Plane lies flat with its length along the angle a (atan2 convention: cos a, sin a on x, z).
      for (const m of [outline, fill]) {
        m.rotation.order = 'YXZ'
        m.rotation.set(-Math.PI / 2, -a - Math.PI / 2, 0)
      }
    } else {
      const g1 = new THREE.CircleGeometry(1, 24, -r, r * 2)
      outline = new THREE.Mesh(g1, outlineMat)
      fill = new THREE.Mesh(g1, fillMat)
      outlineMat.opacity = 0.3
      outline.scale.set(l, l, 1)
      grow = (t) => fill.scale.set(l * t, l * t, 1)
      for (const m of [outline, fill]) {
        m.rotation.order = 'YXZ'
        m.rotation.set(-Math.PI / 2, -a, 0)
      }
    }
    group.add(outline, fill)
    this.add({
      obj: group,
      life: 0,
      max: Math.max(0.15, dur),
      tick: (t) => {
        grow(Math.max(0.02, t))
        outlineMat.opacity = (shape === 'cone' ? 0.3 : 0.6) + Math.sin(t * 30) * 0.2
        fillMat.opacity = 0.2 + t * 0.35
      },
      dispose: () => {
        outlineMat.dispose()
        fillMat.dispose()
        if (shape !== 'circle') outline.geometry.dispose()
      },
    })
  }

  /** Glitchy afterimages along a teleport. */
  blink(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation) {
    for (let i = 0; i <= 5; i++) {
      tmp.copy(from).lerp(to, i / 5)
      this.flash(tmp.clone(), color, 1.6 - i * 0.15, 0.35 + i * 0.04)
    }
    this.burst(to.clone(), color, 30, 4, 0.6, 0.25)
  }

  /** A beam that follows moving ends for a while (Data Leech). */
  tether(getFrom: () => THREE.Vector3 | null, getTo: () => THREE.Vector3 | null, color: THREE.ColorRepresentation, dur: number) {
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const m = new THREE.Mesh(beamGeo, coreMat)
    this.add({
      obj: m,
      life: 0,
      max: dur,
      tick: () => {
        const a = getFrom()
        const b = getTo()
        if (!a || !b) {
          m.visible = false
          return
        }
        m.visible = true
        m.position.copy(a)
        m.lookAt(b)
        const w = 0.05 + Math.random() * 0.04
        m.scale.set(w, w, a.distanceTo(b))
        coreMat.opacity = 0.6 + Math.random() * 0.4
      },
      dispose: () => coreMat.dispose(),
    })
  }

  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i]
      e.life += dt
      const t = Math.min(1, e.life / e.max)
      e.tick(t, dt)
      if (t >= 1) {
        e.obj.removeFromParent()
        e.dispose()
        this.list.splice(i, 1)
      }
    }
  }

  clear() {
    for (const e of this.list) {
      e.obj.removeFromParent()
      e.dispose()
    }
    this.list = []
  }
}
