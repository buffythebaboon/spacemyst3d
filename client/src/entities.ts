// Monsters and other players as seen in the 3D world.
import * as THREE from 'three'
import { EYE_HEIGHT, WALL_HEIGHT } from '../../shared/constants.ts'
import { WEAPONS, type WeaponType } from '../../shared/items.ts'
import { ELITES, MONSTER_BY_KEY, type EliteKind, type MonsterDef } from '../../shared/monsters.ts'
import { MF, hasStatus, type MonsterNet, type PlayerNet } from '../../shared/protocol.ts'
import { monsterSprite } from './art/monsters.ts'
import { glowTexture, labelTexture, ringTexture } from './textures.ts'

const loader = new THREE.TextureLoader()
const texCache = new Map<string, THREE.Texture>()
const glow = glowTexture()
const FLYERS = new Set(['cloud', 'phantom', 'singularity', 'leviathan', 'zeroday', 'dragon'])
const MODELLED = new Set(['turret', 'mainframe_node'])

function monsterTexture(def: MonsterDef) {
  let t = texCache.get(def.key)
  if (!t) {
    if (def.image) t = loader.load(`/monsters/${def.image}`)
    else {
      const c = monsterSprite(def.key, def.color)
      t = c ? new THREE.CanvasTexture(c) : glow
    }
    t.colorSpace = THREE.SRGBColorSpace
    texCache.set(def.key, t)
  }
  return t
}

export const monsterName = (net: MonsterNet) => {
  const def = MONSTER_BY_KEY[net.k]
  const base = def?.name ?? net.k
  return net.e ? `${ELITES[net.e as EliteKind]?.name ?? ''} ${base}` : base
}

const symbols = new Map<string, THREE.Texture>()
function symbolTexture(text: string, color: string) {
  let t = symbols.get(text)
  if (!t) symbols.set(text, (t = labelTexture(text, color, { width: 128, height: 128, font: '700 72px "Orbitron", sans-serif' })))
  return t
}

/** A turret pod or a firewall node: the two monsters that are machines bolted in place. */
function buildModel(def: MonsterDef) {
  const g = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: '#232c37', metalness: 0.85, roughness: 0.3 })
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(def.color).multiplyScalar(2) })
  if (def.key === 'turret') {
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), metal)
    g.add(pod)
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.7, 10).rotateX(Math.PI / 2), metal)
    barrel.position.z = -0.45
    g.add(barrel)
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), glowMat)
    eye.position.set(0, 0.05, -0.36)
    g.add(eye)
  } else {
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.7).scale(1, 1.8, 1), new THREE.MeshStandardMaterial({ color: '#3a1a08', emissive: def.color, emissiveIntensity: 1.4, metalness: 0.4, roughness: 0.2 }))
    crystal.position.y = 1.6
    crystal.name = 'spin'
    g.add(crystal)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.0, 0.5, 8), metal)
    base.position.y = 0.25
    g.add(base)
    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(1.1 + i * 0.25, 0.04, 6, 40), glowMat)
      r.position.y = 1.6
      r.name = i ? 'ringB' : 'ringA'
      g.add(r)
    }
  }
  return { group: g, glowMat }
}

export class MonsterView {
  readonly def: MonsterDef
  readonly root = new THREE.Group()
  readonly sprite: THREE.Sprite
  private model: THREE.Group | null = null
  private modelGlow: THREE.MeshBasicMaterial | null = null
  private aura: THREE.Sprite
  private ring: THREE.Mesh
  private shield: THREE.Mesh | null = null
  private bar: THREE.Sprite
  private barCanvas = document.createElement('canvas')
  private barTex: THREE.CanvasTexture
  private barKey = ''
  private mark: THREE.Sprite
  private target = new THREE.Vector3()
  private flash = 0
  private windupT = 0
  private phase = Math.random() * 10
  private size = 1
  /** Seconds since the snapshot last mentioned it. */
  stale = 0
  net: MonsterNet
  /** When the local player last hurt it, so its bar stays up a while. */
  hurtAt = -99

  constructor(net: MonsterNet) {
    this.net = net
    this.def = MONSTER_BY_KEY[net.k] ?? MONSTER_BY_KEY.byte_mite
    const modelled = MODELLED.has(this.def.key)
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: modelled ? glow : monsterTexture(this.def), transparent: true, alphaTest: modelled ? 0 : 0.06, opacity: modelled ? 0 : 1, depthWrite: !modelled }),
    )
    this.sprite.userData.monsterId = net.id
    this.root.add(this.sprite)
    if (modelled) {
      const m = buildModel(this.def)
      this.model = m.group
      this.modelGlow = m.glowMat
      this.root.add(m.group)
    }
    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: this.def.color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.root.add(this.aura)
    this.ring = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: ringTexture(), color: this.def.color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.05
    this.root.add(this.ring)
    this.barCanvas.width = 256
    this.barCanvas.height = 64
    this.barTex = new THREE.CanvasTexture(this.barCanvas)
    this.barTex.colorSpace = THREE.SRGBColorSpace
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.barTex, transparent: true, depthWrite: false, depthTest: false }))
    this.bar.renderOrder = 5
    this.bar.visible = false
    this.root.add(this.bar)
    this.mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: symbolTexture('Zz', '#8c7bff'), transparent: true, depthWrite: false }))
    this.mark.visible = false
    this.root.add(this.mark)
    this.root.position.set(net.x, 0, net.z)
    this.target.copy(this.root.position)
    this.apply(net)
  }

  apply(net: MonsterNet) {
    this.net = net
    this.stale = 0
    this.target.set(net.x, 0, net.z)
    this.size = this.def.size * (net.s ?? 1)
    this.sprite.scale.setScalar(this.size)
    if (this.model) this.model.scale.setScalar(this.def.key === 'turret' ? 1 : net.s ?? 1)
    const shielded = (net.f & MF.shield) !== 0
    if (shielded && !this.shield) {
      this.shield = new THREE.Mesh(
        new THREE.SphereGeometry(0.62, 20, 14),
        new THREE.MeshBasicMaterial({ color: '#4fa8ff', transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
      )
      this.root.add(this.shield)
    }
    if (this.shield) this.shield.visible = shielded
  }

  hit() {
    this.flash = 0.16
  }

  windup(dur: number) {
    this.windupT = Math.max(this.windupT, dur || 0.4)
  }

  /** Height of the sprite centre above the floor. */
  centerY(time = 0) {
    if (this.def.key === 'turret') return WALL_HEIGHT - 0.9
    if (this.def.key === 'mainframe_node') return 1.4
    const base = this.size * 0.5
    if (FLYERS.has(this.def.behaviour)) return base + 0.35 + Math.sin(time * 1.8 + this.phase) * 0.18
    return base + 0.04
  }

  get hidden() {
    return (this.net.f & MF.hidden) !== 0
  }

  update(dt: number, time: number, eye: THREE.Vector3, showBar: boolean) {
    const k = 1 - Math.exp(-dt * 12)
    this.root.position.lerp(this.target, k)
    const f = this.net.f
    const st = this.net.st
    this.root.visible = !this.hidden
    if (!this.root.visible) return
    const y = this.centerY(time)
    this.sprite.position.y = y
    this.aura.position.y = y
    if (this.model) {
      this.model.position.y = this.def.key === 'turret' ? y : 0
      this.model.rotation.y = this.net.y
      const spin = this.model.getObjectByName('spin')
      if (spin) spin.rotation.y = time * 0.8
      const ra = this.model.getObjectByName('ringA')
      const rb = this.model.getObjectByName('ringB')
      if (ra) ra.rotation.set(time * 0.7, time * 0.4, 0)
      if (rb) rb.rotation.set(-time * 0.5, 0, time * 0.6)
    }
    if (this.shield) {
      this.shield.position.y = y
      this.shield.scale.setScalar(this.size * 1.05)
      ;(this.shield.material as THREE.MeshBasicMaterial).opacity = 0.12 + (this.net.sh ?? 1) * 0.22 + Math.sin(time * 6) * 0.04
    }

    // Colour: elites glow their kind's colour, hunters glow red, allies green.
    const elite = this.net.e ? ELITES[this.net.e as EliteKind] : null
    const ally = (f & MF.ally) !== 0
    const aggro = (f & MF.aggro) !== 0
    const auraColor = ally ? '#7dff9a' : elite ? elite.color : aggro ? '#ff2a4a' : this.def.color
    const am = this.aura.material
    am.color.set(auraColor)
    am.opacity = elite ? 0.45 + Math.sin(time * 4) * 0.12 : aggro ? 0.28 + Math.sin(time * 9) * 0.08 : 0.18
    this.aura.scale.setScalar(this.size * (elite ? 2.1 : 1.7))
    const rm = this.ring.material as THREE.MeshBasicMaterial
    rm.color.set(auraColor)
    rm.opacity = elite || ally ? 0.7 : (f & MF.boss) !== 0 ? 0.6 : 0
    this.ring.scale.setScalar(this.size * 1.4 + Math.sin(time * 3) * 0.1)

    // Visibility: phantoms are a faint shimmer until something reveals them.
    const invisible = (f & MF.invisible) !== 0
    const revealed = (f & MF.revealed) !== 0
    const sm = this.sprite.material
    const baseOpacity = MODELLED.has(this.def.key) ? 0 : invisible ? 0.07 + Math.random() * 0.05 : 1
    sm.opacity = baseOpacity
    am.opacity *= invisible ? 0.15 : 1
    if (revealed) {
      am.color.set('#5cf2ff')
      am.opacity = 0.5
    }

    // Tint: hits flash white-red, windups flash, frozen goes icy, fuses blink.
    this.flash = Math.max(0, this.flash - dt)
    this.windupT = Math.max(0, this.windupT - dt)
    let r = 1
    let g = 1
    let b = 1
    if (hasStatus(st, 'frozen')) [r, g, b] = [0.6, 1.1, 1.4]
    else if (hasStatus(st, 'burning')) {
      const fl = 0.85 + Math.random() * 0.3
      ;[r, g, b] = [1.4 * fl, 0.85 * fl, 0.6]
    } else if (hasStatus(st, 'corrupted')) [r, g, b] = [0.8, 1.3, 0.5]
    if ((f & MF.windup) !== 0 || this.windupT > 0) {
      const p = 0.5 + 0.5 * Math.sin(time * 30)
      r += p * 1.2
      g += p * 0.2
      b += p * 0.2
    }
    if ((f & MF.fuse) !== 0) {
      const rate = 4 + 18 * Math.max(0, 1 - (this.net.t ?? 2) / 2)
      if (Math.sin(time * rate) > 0) [r, g, b] = [2.5, 0.4, 0.4]
    }
    if (this.flash > 0) [r, g, b] = [3, 2, 2]
    if (ally) g += 0.3
    sm.color.setRGB(r, g, b)
    if (this.modelGlow) this.modelGlow.color.setRGB(r * 1.6, g * 0.5, b * 0.5)
    const pulse = (f & MF.windup) !== 0 ? 1 + Math.sin(time * 24) * 0.05 : 1
    this.sprite.scale.setScalar(this.size * pulse)

    // Status marks above the head.
    const asleep = hasStatus(st, 'asleep')
    const stunned = hasStatus(st, 'stunned')
    const distress = (f & MF.distress) !== 0
    if (asleep || stunned || distress) {
      if (distress) this.mark.material.map = symbolTexture('!', '#ff3b5c')
      else if (asleep) this.mark.material.map = symbolTexture('Zz', '#8c7bff')
      else this.mark.material.map = symbolTexture('✶', '#ffe14f')
      this.mark.visible = true
      this.mark.position.y = y + this.size * 0.55 + 0.7 + Math.sin(time * 3) * 0.08
      const s = distress ? 0.9 + Math.sin(time * 10) * 0.2 : 0.7
      this.mark.scale.set(s, s, 1)
      this.mark.material.rotation = stunned && !asleep ? time * 3 : 0
    } else this.mark.visible = false

    // Floating health bar.
    const d = eye.distanceTo(this.root.position)
    const wantBar = showBar && d < 26 && !invisible && !MODELLED.has(this.def.key) && (this.net.f & MF.boss) === 0
    this.bar.visible = wantBar || (showBar && d < 26 && MODELLED.has(this.def.key))
    if (this.bar.visible) {
      this.bar.position.y = y + this.size * 0.5 + 0.35
      const s = 1.6 + d * 0.02
      this.bar.scale.set(s, s / 4, 1)
      this.drawBar()
    }
  }

  private drawBar() {
    const n = this.net
    const key = `${n.hp}|${n.mhp}|${n.lv}|${n.e ?? ''}|${n.f & (MF.ally | MF.fuse)}|${n.t ?? ''}`
    if (key === this.barKey) return
    this.barKey = key
    const g = this.barCanvas.getContext('2d')!
    g.clearRect(0, 0, 256, 64)
    const elite = n.e ? ELITES[n.e as EliteKind] : null
    g.font = '600 22px "Share Tech Mono", monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 4
    g.strokeStyle = 'rgba(0,0,0,0.85)'
    const fuse = (n.f & MF.fuse) !== 0 && n.t !== undefined ? ` ${n.t.toFixed(1)}s` : ''
    const label = `${(n.f & MF.ally) !== 0 ? 'ALLY ' : ''}${monsterName(n)} ${n.lv}${fuse}`
    g.strokeText(label, 128, 18)
    g.fillStyle = elite ? elite.color : (n.f & MF.ally) !== 0 ? '#7dff9a' : '#e6f6ff'
    g.fillText(label, 128, 18)
    g.fillStyle = 'rgba(0,0,0,0.7)'
    g.fillRect(28, 38, 200, 14)
    g.fillStyle = (n.f & MF.ally) !== 0 ? '#7dff9a' : '#ff3b5c'
    g.fillRect(30, 40, 196 * Math.max(0, Math.min(1, n.hp / n.mhp)), 10)
    this.barTex.needsUpdate = true
  }

  dispose() {
    this.root.removeFromParent()
    this.sprite.material.dispose()
    this.aura.material.dispose()
    ;(this.ring.material as THREE.Material).dispose()
    this.ring.geometry.dispose()
    this.bar.material.dispose()
    this.mark.material.dispose()
    this.barTex.dispose()
    if (this.shield) {
      this.shield.geometry.dispose()
      ;(this.shield.material as THREE.Material).dispose()
    }
    this.model?.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
  }
}

// --- Other players ----------------------------------------------------------------------------------
const ARMOR_COLORS = ['#3a4654', '#3f5a48', '#3c4f6e', '#563f6e', '#6e5a2c', '#6e2c3a', '#4a3f7a']

export class PlayerView {
  readonly root = new THREE.Group()
  readonly color: THREE.Color
  private target = new THREE.Vector3()
  private targetYaw = 0
  private label: THREE.Sprite
  private labelKey = ''
  private body: THREE.Mesh
  private suit: THREE.MeshStandardMaterial
  private weapon: THREE.Mesh
  private weaponMat: THREE.MeshBasicMaterial
  private bubble: THREE.Mesh
  private walk = 0
  net: PlayerNet

  constructor(net: PlayerNet) {
    this.net = net
    this.color = new THREE.Color().setHSL(net.hue, 0.9, 0.6)
    this.suit = new THREE.MeshStandardMaterial({ color: '#1a2330', metalness: 0.7, roughness: 0.35, emissive: this.color, emissiveIntensity: 0.25, transparent: true })
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.9, 6, 12), this.suit)
    this.body.position.y = 0.85
    this.root.add(this.body)
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.2), new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(2.5) }))
    visor.position.set(0, EYE_HEIGHT - 0.25, -0.3)
    this.root.add(visor)
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.25), this.suit)
    pack.position.set(0, 1.05, 0.35)
    this.root.add(pack)
    this.weaponMat = new THREE.MeshBasicMaterial({ color: '#5cf2ff' })
    this.weapon = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.6), this.weaponMat)
    this.weapon.position.set(0.32, 1.1, -0.35)
    this.root.add(this.weapon)
    this.bubble = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 18, 12),
      new THREE.MeshBasicMaterial({ color: '#ff9a3c', transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.bubble.position.y = 1
    this.root.add(this.bubble)
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: symbolTexture('Zz', '#8c7bff'), transparent: true, depthWrite: false }))
    this.label.scale.set(2.6, 0.48, 1)
    this.label.position.y = 2.3
    this.root.add(this.label)
    this.root.position.set(net.x, 0, net.z)
    this.target.copy(this.root.position)
    this.apply(net)
  }

  apply(net: PlayerNet) {
    this.net = net
    this.target.set(net.x, 0, net.z)
    this.targetYaw = net.yaw
    const key = `${net.name}|${net.level}|${net.badges}`
    if (key !== this.labelKey) {
      if (this.labelKey) this.label.material.map?.dispose()
      this.labelKey = key
      const hex = `#${this.color.getHexString()}`
      this.label.material.map = labelTexture(`${net.name}  ${net.level}${net.badges ? ` ${'★'.repeat(Math.min(5, net.badges))}` : ''}`, hex)
      this.label.material.needsUpdate = true
    }
    this.suit.color.set(net.armor >= 0 ? ARMOR_COLORS[Math.min(ARMOR_COLORS.length - 1, net.armor)] : '#1a2330')
    this.weaponMat.color.set(WEAPONS[net.weapon as WeaponType]?.color ?? '#5cf2ff').multiplyScalar(1.4)
  }

  update(dt: number, time: number) {
    const k = 1 - Math.exp(-dt * 12)
    const bx = this.root.position.x
    const bz = this.root.position.z
    this.root.position.lerp(this.target, k)
    const moved = Math.hypot(this.root.position.x - bx, this.root.position.z - bz)
    this.walk += moved * 3
    this.body.position.y = 0.85 + Math.abs(Math.sin(this.walk)) * 0.06
    let dy = this.targetYaw - this.root.rotation.y
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.root.rotation.y += dy * k
    this.root.visible = !this.net.dead
    const st = this.net.st
    this.bubble.visible = hasStatus(st, 'shielded')
    this.suit.opacity = hasStatus(st, 'stealth') ? 0.3 : 1
    this.suit.emissiveIntensity = hasStatus(st, 'regen') ? 0.6 + Math.sin(time * 8) * 0.2 : hasStatus(st, 'haste') ? 0.5 : 0.25
  }

  dispose() {
    this.root.removeFromParent()
    this.label.material.map?.dispose()
    this.label.material.dispose()
  }
}
