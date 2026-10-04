import * as THREE from 'three'
import { EYE_HEIGHT } from '../../shared/constants.ts'
import { MONSTER_BY_KEY, type MonsterTemplate } from '../../shared/monsters.ts'
import type { MonsterState, PlayerState } from '../../shared/protocol.ts'
import { glitchCreature, glowTexture, labelTexture } from './textures.ts'

const loader = new THREE.TextureLoader()
const textureCache = new Map<string, THREE.Texture>()
const glow = glowTexture()

function monsterTexture(tpl: MonsterTemplate) {
  let t = textureCache.get(tpl.key)
  if (!t) {
    if (tpl.image) {
      t = loader.load(`/monsters/${tpl.image}`)
      t.colorSpace = THREE.SRGBColorSpace
    } else {
      t = glitchCreature(tpl.name, tpl.color)
    }
    textureCache.set(tpl.key, t)
  }
  return t
}

export class MonsterView {
  readonly tpl: MonsterTemplate
  readonly root = new THREE.Group()
  readonly sprite: THREE.Sprite
  private halo: THREE.Sprite
  private bar: THREE.Sprite
  private barCanvas = document.createElement('canvas')
  private barTex: THREE.CanvasTexture
  private target = new THREE.Vector3()
  private flash = 0
  private shownHp = -1
  private phase = Math.random() * 10
  state: MonsterState

  constructor(state: MonsterState) {
    this.state = state
    this.tpl = MONSTER_BY_KEY[state.key]
    const mat = new THREE.SpriteMaterial({ map: monsterTexture(this.tpl), transparent: true, alphaTest: 0.08 })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.setScalar(this.tpl.size)
    this.sprite.userData.monsterId = state.id
    this.root.add(this.sprite)

    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: new THREE.Color(this.tpl.color),
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.halo.scale.setScalar(this.tpl.size * 1.8)
    this.root.add(this.halo)

    this.barCanvas.width = 128
    this.barCanvas.height = 14
    this.barTex = new THREE.CanvasTexture(this.barCanvas)
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.barTex, transparent: true, depthWrite: false }))
    this.bar.scale.set(1.4, 0.15, 1)
    this.bar.visible = false
    this.root.add(this.bar)

    this.root.position.set(state.x, 0, state.z)
    this.target.copy(this.root.position)
  }

  apply(state: MonsterState) {
    this.state = state
    this.target.set(state.x, 0, state.z)
  }

  hit() {
    this.flash = 0.18
  }

  update(dt: number, time: number) {
    const k = 1 - Math.exp(-dt * 10)
    this.root.position.lerp(this.target, k)
    const size = this.tpl.size
    const hover = size * 0.5 + 0.15 + Math.sin(time * 2.2 + this.phase) * 0.12
    this.sprite.position.y = hover
    this.halo.position.y = hover
    this.bar.position.y = hover + size * 0.55 + 0.15

    const aggro = this.state.aggro === 1
    const haloMat = this.halo.material
    haloMat.opacity = aggro ? 0.3 + Math.sin(time * 10) * 0.1 : 0.22
    haloMat.color.set(aggro ? '#ff2a4a' : this.tpl.color)

    this.flash = Math.max(0, this.flash - dt)
    const mat = this.sprite.material
    if (this.flash > 0) mat.color.setRGB(3, 0.6, 0.6)
    else mat.color.setRGB(1, 1, 1)

    if (this.state.hp !== this.shownHp) {
      this.shownHp = this.state.hp
      this.bar.visible = this.state.hp < this.state.maxHp
      const g = this.barCanvas.getContext('2d')!
      g.clearRect(0, 0, 128, 14)
      g.fillStyle = 'rgba(0,0,0,0.7)'
      g.fillRect(0, 0, 128, 14)
      g.fillStyle = '#ff3b5c'
      g.fillRect(2, 2, 124 * Math.max(0, this.state.hp / this.state.maxHp), 10)
      this.barTex.needsUpdate = true
    }
  }

  dispose() {
    this.root.removeFromParent()
    this.sprite.material.dispose()
    this.halo.material.dispose()
    this.bar.material.dispose()
    this.barTex.dispose()
  }
}

export class PlayerView {
  readonly root = new THREE.Group()
  private target = new THREE.Vector3()
  private targetYaw = 0
  private label: THREE.Sprite
  private body: THREE.Mesh
  private walk = 0
  readonly color: THREE.Color
  state: PlayerState

  constructor(state: PlayerState) {
    this.state = state
    this.color = new THREE.Color().setHSL(state.hue, 0.9, 0.6)
    const suit = new THREE.MeshStandardMaterial({ color: '#1a2330', metalness: 0.7, roughness: 0.35, emissive: this.color, emissiveIntensity: 0.25 })
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.9, 6, 12), suit)
    this.body.position.y = 0.85
    this.root.add(this.body)
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.12, 0.2),
      new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(2.5) }),
    )
    visor.position.set(0, EYE_HEIGHT - 0.25, -0.3)
    this.root.add(visor)
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.25), suit)
    pack.position.set(0, 1.05, 0.35)
    this.root.add(pack)
    const light = new THREE.PointLight(this.color, 8, 6, 2)
    light.position.set(0, 1.4, -0.6)
    this.root.add(light)

    const hex = `#${this.color.getHexString()}`
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(state.name, hex), transparent: true, depthWrite: false }))
    this.label.scale.set(2.4, 0.45, 1)
    this.label.position.y = 2.3
    this.root.add(this.label)

    this.root.position.set(state.x, 0, state.z)
    this.target.copy(this.root.position)
  }

  apply(state: PlayerState) {
    this.state = state
    this.target.set(state.x, 0, state.z)
    this.targetYaw = state.yaw
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 12)
    const before = this.root.position.clone()
    this.root.position.lerp(this.target, k)
    const moved = before.distanceTo(this.root.position)
    this.walk += moved * 3
    this.body.position.y = 0.85 + Math.abs(Math.sin(this.walk)) * 0.06
    let dy = this.targetYaw - this.root.rotation.y
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.root.rotation.y += dy * k
    this.root.visible = this.state.hp > 0
  }

  dispose() {
    this.root.removeFromParent()
  }
}
