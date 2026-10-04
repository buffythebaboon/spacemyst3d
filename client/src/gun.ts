import * as THREE from 'three'
import { glowTexture, metalMatcap } from './textures.ts'

/** First-person "data blaster" built from primitives. */
export function createGun() {
  const root = new THREE.Group()
  const rig = new THREE.Group()
  root.add(rig)
  const base = new THREE.Vector3(0.26, -0.24, -0.48)
  root.position.copy(base)

  const metal = new THREE.MeshMatcapMaterial({ matcap: metalMatcap(), color: '#8894a0' })
  const dark = new THREE.MeshMatcapMaterial({ matcap: metalMatcap('#34404c'), color: '#3a424c' })
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#5cf2ff').multiplyScalar(1.3) })

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.42), metal)
  rig.add(body)
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.3), dark)
  top.position.set(0, 0.08, -0.02)
  rig.add(top)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.08), dark)
  grip.position.set(0, -0.11, 0.1)
  grip.rotation.x = -0.25
  rig.add(grip)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.3, 12).rotateX(Math.PI / 2), metal)
  barrel.position.set(0, 0.01, -0.33)
  rig.add(barrel)
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.007, 6, 16), glowMat)
    ring.position.set(0, 0.01, -0.24 - i * 0.07)
    rig.add(ring)
  }
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.012, 0.3), glowMat)
  strip.position.set(0, 0.02, 0)
  rig.add(strip)
  const cell = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.08), glowMat)
  cell.position.set(-0.055, 0, 0.08)
  rig.add(cell)

  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.01, -0.5)
  rig.add(muzzle)
  const flash = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), color: '#9ff6ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  flash.scale.setScalar(0.35)
  flash.visible = false
  muzzle.add(flash)
  const flashLight = new THREE.PointLight('#5cf2ff', 0, 8, 2)
  muzzle.add(flashLight)

  let recoil = 0
  let flashT = 0
  let swayX = 0
  let swayY = 0
  let phase = 0

  return {
    root,
    muzzleWorld: () => muzzle.getWorldPosition(new THREE.Vector3()),
    fire(overload: boolean) {
      recoil = overload ? 1.6 : 1
      flashT = 0.06
      const c = overload ? '#ff4fd8' : '#9ff6ff'
      flash.material.color.set(c)
      flashLight.color.set(c)
      flash.scale.setScalar(overload ? 0.7 : 0.35)
      glowMat.color.set(overload ? '#ff4fd8' : '#5cf2ff').multiplyScalar(1.3)
    },
    sway(dx: number, dy: number) {
      swayX = Math.max(-0.04, Math.min(0.04, swayX - dx * 0.0004))
      swayY = Math.max(-0.04, Math.min(0.04, swayY + dy * 0.0004))
    },
    update(dt: number, speed01: number) {
      phase += dt * (4 + speed01 * 6)
      const walk = Math.min(1, speed01)
      recoil = Math.max(0, recoil - dt * 7)
      swayX *= 1 - Math.min(1, dt * 8)
      swayY *= 1 - Math.min(1, dt * 8)
      root.position.set(
        base.x + swayX + Math.sin(phase) * 0.012 * walk,
        base.y + swayY + Math.abs(Math.cos(phase)) * 0.014 * walk + Math.sin(phase * 0.3) * 0.003,
        base.z + recoil * 0.07,
      )
      rig.rotation.x = recoil * 0.18
      flashT -= dt
      flash.visible = flashT > 0
      flash.material.rotation = Math.random() * Math.PI
      flashLight.intensity = flashT > 0 ? 25 : 0
      if (recoil === 0) glowMat.color.set('#5cf2ff').multiplyScalar(1.3)
    },
  }
}
