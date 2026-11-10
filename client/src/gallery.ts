// A gallery of the monster models, drawn the way the game draws them (tone mapping, reflections and
// bloom), for checking new models: /models.html on the dev server. Every model turns and walks.
// ?kind=byte_mite shows one kind, ?painted=0 shows the shapes built in code instead of the painted
// models, and ?still=1 stops the turning for side-by-side screenshots.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { MonsterModel, loadPaintedModels, modelKinds, setModelEnvironment, type Anim } from './models.ts'
import { MONSTER_BY_KEY } from '../../shared/monsters.ts'

const params = new URLSearchParams(location.search)
const only = params.get('kind')
const still = params.get('still') === '1'

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
document.body.appendChild(renderer.domElement)
{
  const pmrem = new THREE.PMREMGenerator(renderer)
  setModelEnvironment(pmrem.fromScene(new RoomEnvironment(), 0.04).texture)
  pmrem.dispose()
}

const scene = new THREE.Scene()
scene.background = new THREE.Color('#07090c')
scene.add(new THREE.HemisphereLight(0x4a7fa8, 0x06080c, 0.8))
const key = new THREE.DirectionalLight(0xfff1e0, 2.2)
key.position.set(-3, 5, 4)
scene.add(key)
const rim = new THREE.DirectionalLight(0x6fb8ff, 1.4)
rim.position.set(3, 3, -5)
scene.add(rim)

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 200)
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.5, 0.82))
composer.addPass(new OutputPass())

const labels = document.getElementById('labels')!
const kinds = only ? [only] : modelKinds()
const cols = only ? 1 : Math.ceil(Math.sqrt(kinds.length * (innerWidth / innerHeight)))
const rows = Math.ceil(kinds.length / cols)
const CELL = 2.2

interface Shown {
  model: MonsterModel
  pivot: THREE.Group
  anim: Anim
}
let shown: Shown[] = []

function build() {
  for (const s of shown) s.pivot.removeFromParent()
  labels.textContent = ''
  shown = kinds.map((k, i) => {
    const def = MONSTER_BY_KEY[k]
    const model = new MonsterModel(k, def.color)
    const pivot = new THREE.Group()
    pivot.add(model.root)
    // Every model fills its cell, whatever its size in the game.
    const box = new THREE.Box3().setFromObject(model.root)
    const size = box.getSize(new THREE.Vector3())
    const k1 = (CELL * 0.8) / Math.max(size.x, size.y, size.z, 0.01)
    model.root.scale.setScalar(k1)
    model.root.position.set(0, -box.min.y * k1, 0)
    const cx = (i % cols) - (cols - 1) / 2
    const cy = (rows - 1) / 2 - Math.floor(i / cols)
    pivot.position.set(cx * CELL, cy * CELL - CELL * 0.4, 0)
    pivot.rotation.y = Math.PI + 0.6
    scene.add(pivot)
    const label = document.createElement('div')
    label.textContent = def.name
    labels.appendChild(label)
    return { model, pivot, anim: { t: 0, dt: 0, pace: 0, walk: 0, windup: 0, strike: 0, hp: 1, special: 0, seed: i * 0.37 } }
  })
  const dist = (Math.max(cols * CELL / camera.aspect, rows * CELL) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05
  camera.position.set(0, 0.6, dist)
  camera.lookAt(0, 0, 0)
  shown.forEach((s, i) => {
    const p = s.pivot.position.clone().setY(s.pivot.position.y - 0.08).project(camera)
    const el = labels.children[i] as HTMLElement
    el.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`
    el.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`
  })
}

if (params.get('painted') === '0') build()
else loadPaintedModels().then(build)

let last = performance.now()
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  for (const s of shown) {
    const a = s.anim
    a.t += dt
    a.dt = dt
    a.pace = 0.25
    a.walk += dt * 0.25
    if (!still) s.pivot.rotation.y += dt * 0.35
    s.model.update(a)
  }
  composer.render(dt)
})
