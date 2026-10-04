import * as THREE from 'three'
import { glowTexture } from './textures.ts'

interface Effect {
  obj: THREE.Object3D
  life: number
  max: number
  tick: (t: number, dt: number) => void
  dispose: () => void
}

const glow = glowTexture()
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5)

export class Effects {
  private list: Effect[] = []
  constructor(private scene: THREE.Scene) {}

  private add(e: Effect) {
    this.scene.add(e.obj)
    this.list.push(e)
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, width = 0.04) {
    const group = new THREE.Group()
    const len = from.distanceTo(to)
    const core = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    core.scale.set(width, width, len)
    const outer = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    outer.scale.set(width * 3.5, width * 3.5, len)
    group.add(core, outer)
    group.position.copy(from)
    group.lookAt(to)
    this.add({
      obj: group,
      life: 0,
      max: 0.14,
      tick: (t) => {
        const f = 1 - t
        ;(core.material as THREE.MeshBasicMaterial).opacity = f
        ;(outer.material as THREE.MeshBasicMaterial).opacity = 0.35 * f
        core.scale.x = core.scale.y = width * f
      },
      dispose: () => {
        ;(core.material as THREE.Material).dispose()
        ;(outer.material as THREE.Material).dispose()
      },
    })
    this.flashAt(to, color, 0.9)
  }

  flashAt(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    s.position.copy(pos)
    s.scale.setScalar(size)
    this.add({
      obj: s,
      life: 0,
      max: 0.18,
      tick: (t) => {
        s.material.opacity = 1 - t
        s.scale.setScalar(size * (1 + t))
      },
      dispose: () => s.material.dispose(),
    })
  }

  burst(pos: THREE.Vector3, color: THREE.ColorRepresentation, count = 60, speed = 6) {
    const pts = new Float32Array(count * 3)
    const vel: THREE.Vector3[] = []
    for (let i = 0; i < count; i++) {
      pts.set([pos.x, pos.y, pos.z], i * 3)
      vel.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random())))
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    const mat = new THREE.PointsMaterial({
      map: glow,
      color,
      size: 0.35,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    this.add({
      obj: points,
      life: 0,
      max: 1.0,
      tick: (t, dt) => {
        const a = geo.attributes.position as THREE.BufferAttribute
        for (let i = 0; i < count; i++) {
          const v = vel[i]
          v.y -= 6 * dt
          v.multiplyScalar(1 - 1.5 * dt)
          a.setXYZ(i, a.getX(i) + v.x * dt, Math.max(0.02, a.getY(i) + v.y * dt), a.getZ(i) + v.z * dt)
        }
        a.needsUpdate = true
        mat.opacity = 1 - t
      },
      dispose: () => {
        geo.dispose()
        mat.dispose()
      },
    })
    this.flashAt(pos, color, 4)
  }

  /** Floating damage number. */
  number(pos: THREE.Vector3, text: string, color: string) {
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 64
    const g = c.getContext('2d')!
    g.font = 'bold 44px "Orbitron", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 6
    g.strokeStyle = 'rgba(0,0,0,0.8)'
    g.strokeText(text, 64, 32)
    g.fillStyle = color
    g.fillText(text, 64, 32)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
    s.renderOrder = 10
    s.scale.set(1, 0.5, 1)
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
}
