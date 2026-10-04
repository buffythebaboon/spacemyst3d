import * as THREE from 'three'

/**
 * Procedural surface sets for each sector of the maze.
 *
 * Every texture is a seamlessly tiling 512px canvas (RepeatWrapping, anisotropy 8, sRGB). Emissive maps
 * are painted in their final colours, so the matching emissive colour is white and only the intensity
 * scales the glow. Usage follows world.ts: walls map one texture per wall face, floor maps repeat every
 * 2 cells (each 256px quarter is one cell) while floor emissive maps repeat every cell, and ceilings
 * repeat every cell. Floor details that glow are therefore laid out per cell in both maps.
 */

export interface SurfaceTex {
  map: THREE.Texture
  emissive: THREE.Texture
}

export interface SectorLook {
  name: string
  wall: SurfaceTex
  floor: SurfaceTex
  ceiling: SurfaceTex
  wallEmissive: string
  floorEmissive: string
  ceilingEmissive: string
  wallEmissiveIntensity: number
  floorEmissiveIntensity: number
  ceilingEmissiveIntensity: number
  fog: string
  background: string
  hemiSky: string
  hemiGround: string
  accent: string
}

type Ctx = CanvasRenderingContext2D
type RGB = [number, number, number]
type Pt = [number, number]

const S = 512
const TAU = Math.PI * 2

const BUILD: (() => SectorLook)[] = [coolingChannels, serverHalls, corruptedSector, theCore, hub]
const cache = new Map<number, SectorLook>()

/** 0 Cooling Channels, 1 Server Halls, 2 Corrupted Sector, 3 Core, 4 Hub (safe zone). Cached. */
export function sectorLook(sector: number): SectorLook {
  const i = Number.isFinite(sector) ? Math.max(0, Math.min(BUILD.length - 1, Math.round(sector))) : 0
  let look = cache.get(i)
  if (!look) {
    look = BUILD[i]()
    cache.set(i, look)
  }
  return look
}

// --- Helpers -------------------------------------------------------------------------------------------

function canvas(w = S, h = S): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d', { willReadFrequently: true })!]
}

function tex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const surface = (map: HTMLCanvasElement, emissive: HTMLCanvasElement): SurfaceTex => ({ map: tex(map), emissive: tex(emissive) })

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function blank(color: string): [HTMLCanvasElement, Ctx] {
  const [c, g] = canvas()
  g.fillStyle = color
  g.fillRect(0, 0, S, S)
  return [c, g]
}

/** Runs `draw` at the 9 wrap offsets so shapes crossing an edge reappear on the opposite side. */
function wrap(g: Ctx, draw: () => void) {
  for (const dy of [-S, 0, S])
    for (const dx of [-S, 0, S]) {
      g.save()
      g.translate(dx, dy)
      draw()
      g.restore()
    }
}

function rr(x: number, y: number, w: number, h: number, r = 0) {
  const p = new Path2D()
  if (r <= 0) {
    p.rect(x, y, w, h)
    return p
  }
  r = Math.min(r, w / 2, h / 2)
  p.moveTo(x + r, y)
  p.arcTo(x + w, y, x + w, y + h, r)
  p.arcTo(x + w, y + h, x, y + h, r)
  p.arcTo(x, y + h, x, y, r)
  p.arcTo(x, y, x + w, y, r)
  p.closePath()
  return p
}

function polyline(pts: Pt[], close = false) {
  const p = new Path2D()
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)))
  if (close) p.closePath()
  return p
}

function hexPath(cx: number, cy: number, rx: number, ry: number) {
  const p = new Path2D()
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    const x = cx + Math.cos(a) * rx
    const y = cy + Math.sin(a) * ry
    if (i) p.lineTo(x, y)
    else p.moveTo(x, y)
  }
  p.closePath()
  return p
}

/** Glowing stroke: soft coloured blur under a brighter core. */
function glowStroke(g: Ctx, p: Path2D, color: string, w: number, blur: number, core?: string) {
  g.save()
  g.shadowColor = color
  g.shadowBlur = blur
  g.strokeStyle = color
  g.lineWidth = w
  g.stroke(p)
  if (core) {
    g.shadowBlur = 0
    g.strokeStyle = core
    g.lineWidth = Math.max(0.8, w * 0.45)
    g.stroke(p)
  }
  g.restore()
}

function glowFill(g: Ctx, p: Path2D, color: string, blur: number, core?: string) {
  g.save()
  g.shadowColor = color
  g.shadowBlur = blur
  g.fillStyle = core ?? color
  g.fill(p)
  g.restore()
}

/** Horizontal line spanning past both edges so its glow tiles. */
function hLine(y: number) {
  return polyline([
    [-40, y],
    [S + 40, y],
  ])
}

/** Tileable value-noise fbm in [0, 1]; `cells` lattice cells across the texture at the base octave. */
function fbm(seed: number, cells: number, octaves = 4) {
  const out = new Float32Array(S * S)
  const rnd = rng(seed)
  let total = 0
  const layers: { v: Float32Array; n: number; amp: number }[] = []
  for (let o = 0; o < octaves; o++) {
    const n = cells << o
    const v = new Float32Array(n * n)
    for (let i = 0; i < v.length; i++) v[i] = rnd()
    const amp = 0.5 ** o
    layers.push({ v, n, amp })
    total += amp
  }
  for (const { v, n, amp } of layers) {
    const f = n / S
    const k = amp / total
    for (let y = 0; y < S; y++) {
      const fy = y * f
      const y0 = Math.floor(fy)
      const ty = fy - y0
      const sy = ty * ty * (3 - 2 * ty)
      const r0 = (y0 % n) * n
      const r1 = ((y0 + 1) % n) * n
      for (let x = 0; x < S; x++) {
        const fx = x * f
        const x0 = Math.floor(fx)
        const tx = fx - x0
        const sx = tx * tx * (3 - 2 * tx)
        const c0 = x0 % n
        const c1 = (x0 + 1) % n
        const a = v[r0 + c0]
        const b = v[r0 + c1]
        const c = v[r1 + c0]
        const d = v[r1 + c1]
        out[y * S + x] += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * k
      }
    }
  }
  return out
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Paints a colour whose per-pixel alpha comes from a noise field. */
function paintField(g: Ctx, field: Float32Array, rgb: RGB, alpha: (v: number, x: number, y: number) => number) {
  const img = g.createImageData(S, S)
  const d = img.data
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x
      const a = alpha(field[i], x, y)
      if (a <= 0) continue
      d[i * 4] = rgb[0]
      d[i * 4 + 1] = rgb[1]
      d[i * 4 + 2] = rgb[2]
      d[i * 4 + 3] = Math.min(255, a * 255)
    }
  const [c, cg] = canvas()
  cg.putImageData(img, 0, 0)
  g.drawImage(c, 0, 0)
}

/** Fine per-pixel grain (independent per pixel, so it always tiles). */
function grain(g: Ctx, amount: number, seed: number) {
  const img = g.getImageData(0, 0, S, S)
  const d = img.data
  const rnd = rng(seed)
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount
    d[i] += n
    d[i + 1] += n
    d[i + 2] += n
  }
  g.putImageData(img, 0, 0)
}

interface PanelStyle {
  top: string
  bottom: string
  hi?: string
  lo?: string
  r?: number
  bolt?: string
}

/** Panel with a vertical gradient, bevel light and optional corner bolts. */
function panel(g: Ctx, x: number, y: number, w: number, h: number, st: PanelStyle) {
  const p = rr(x, y, w, h, st.r ?? 0)
  const gr = g.createLinearGradient(x, y, x, y + h)
  gr.addColorStop(0, st.top)
  gr.addColorStop(1, st.bottom)
  g.fillStyle = gr
  g.fill(p)
  g.save()
  g.clip(p)
  g.lineWidth = 2
  if (st.hi) {
    g.strokeStyle = st.hi
    g.stroke(polyline([
      [x + 1, y + h],
      [x + 1, y + 1],
      [x + w, y + 1],
    ]))
  }
  if (st.lo) {
    g.strokeStyle = st.lo
    g.stroke(polyline([
      [x + w - 1, y],
      [x + w - 1, y + h - 1],
      [x, y + h - 1],
    ]))
  }
  g.restore()
  if (st.bolt) {
    g.fillStyle = st.bolt
    for (const [bx, by] of [
      [x + 9, y + 9],
      [x + w - 13, y + 9],
      [x + 9, y + h - 13],
      [x + w - 13, y + h - 13],
    ])
      g.fillRect(bx, by, 4, 4)
  }
  return p
}

/** Full-width horizontal band with top/bottom bevels only, so it tiles horizontally. */
function trim(g: Ctx, y: number, h: number, st: PanelStyle) {
  const gr = g.createLinearGradient(0, y, 0, y + h)
  gr.addColorStop(0, st.top)
  gr.addColorStop(1, st.bottom)
  g.fillStyle = gr
  g.fillRect(0, y, S, h)
  if (st.hi) {
    g.fillStyle = st.hi
    g.fillRect(0, y, S, 1.5)
  }
  if (st.lo) {
    g.fillStyle = st.lo
    g.fillRect(0, y + h - 1.5, S, 1.5)
  }
}

/** Runs `draw` for each of the four cells of a floor map (one cell = 256px). */
function eachCell(draw: (x: number, y: number, L: number, i: number) => void) {
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) draw(cx * 256, cy * 256, 256, cy * 2 + cx)
}

/** Cell edge lines with corner nodes for floor emissive maps (one cell = the whole texture). */
function cellEdges(g: Ctx, color: string, alpha: number, node: number) {
  g.save()
  g.globalAlpha = alpha
  g.strokeStyle = color
  g.lineWidth = 2.5
  g.strokeRect(1.25, 1.25, S - 2.5, S - 2.5)
  g.globalAlpha = 1
  g.fillStyle = color
  for (const [x, y] of [
    [0, 0],
    [S, 0],
    [0, S],
    [S, S],
  ]) {
    g.beginPath()
    g.arc(x, y, node, 0, TAU)
    g.fill()
  }
  g.restore()
}

function text(g: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left') {
  g.save()
  g.font = `700 ${size}px "Share Tech Mono", ui-monospace, monospace`
  g.textAlign = align
  g.textBaseline = 'middle'
  g.fillStyle = color
  g.fillText(s, x, y)
  g.restore()
}

// --- 0 Cooling Channels --------------------------------------------------------------------------

function coolingChannels(): SectorLook {
  return {
    name: 'Cooling Channels',
    wall: coolingWall(),
    floor: coolingFloor(),
    ceiling: coolingCeiling(),
    wallEmissive: '#ffffff',
    floorEmissive: '#ffffff',
    ceilingEmissive: '#ffffff',
    wallEmissiveIntensity: 1.15,
    floorEmissiveIntensity: 0.6,
    ceilingEmissiveIntensity: 1.5,
    fog: '#04101a',
    background: '#02070c',
    hemiSky: '#8fd4ff',
    hemiGround: '#071018',
    accent: '#5cf2ff',
  }
}

/** Horizontal metal pipe spanning the full width (so it tiles). */
function pipe(g: Ctx, y: number, r: number, light: string) {
  const gr = g.createLinearGradient(0, y - r, 0, y + r)
  gr.addColorStop(0, '#0a1219')
  gr.addColorStop(0.22, light)
  gr.addColorStop(0.45, '#33506a')
  gr.addColorStop(0.8, '#101b25')
  gr.addColorStop(1, '#05090d')
  g.fillStyle = gr
  g.fillRect(0, y - r, S, r * 2)
}

function coolingWall(): SurfaceTex {
  const rnd = rng(1101)
  const [c, g] = blank('#070e15')
  const st: PanelStyle = { top: '#26394d', bottom: '#162434', hi: 'rgba(200,235,255,0.22)', lo: 'rgba(0,0,0,0.5)', bolt: '#3a4e62' }
  panel(g, 4, 6, 248, 288, st)
  panel(g, 260, 6, 248, 140, st)
  panel(g, 260, 154, 248, 140, st)
  // Recessed coolant channel with ribs every 64px.
  g.fillStyle = '#050a10'
  g.fillRect(0, 300, S, 156)
  wrap(g, () => {
    for (let x = 0; x < S; x += 64) {
      g.fillStyle = '#0d1720'
      g.fillRect(x - 4, 300, 8, 156)
      g.fillStyle = 'rgba(150,200,230,0.12)'
      g.fillRect(x - 4, 300, 2, 156)
    }
  })
  pipe(g, 346, 20, '#8fb4d0')
  pipe(g, 412, 13, '#7a9cb8')
  // Inspection windows on the big pipe and clamps on both.
  for (const x of [150, 406]) {
    g.fillStyle = '#04080c'
    g.fillRect(x, 336, 64, 20)
    g.strokeStyle = '#6f8ea8'
    g.lineWidth = 2
    g.strokeRect(x - 1, 335, 66, 22)
  }
  for (const x of [88, 344]) {
    for (const [y, r] of [
      [346, 20],
      [412, 13],
    ]) {
      const gr = g.createLinearGradient(x, 0, x + 14, 0)
      gr.addColorStop(0, '#1a2632')
      gr.addColorStop(0.5, '#4b6176')
      gr.addColorStop(1, '#141e28')
      g.fillStyle = gr
      g.fillRect(x, y - r - 3, 14, r * 2 + 6)
      g.fillStyle = '#9cb4c8'
      g.fillRect(x + 5, y - r - 1, 4, 3)
      g.fillRect(x + 5, y + r - 2, 4, 3)
    }
  }
  // Kick plates with vent slots.
  for (const x of [4, 260]) {
    panel(g, x, 462, 248, 44, { top: '#1b2a39', bottom: '#101a24', hi: 'rgba(200,235,255,0.15)', lo: 'rgba(0,0,0,0.5)' })
    for (let i = 0; i < 9; i++) {
      g.fillStyle = '#03070b'
      g.fillRect(x + 22 + i * 24, 476, 14, 16)
    }
  }
  text(g, 'COOLANT LOOP C-07', 22, 30, 15, 'rgba(160,215,245,0.32)')
  text(g, '-40°C', 278, 172, 13, 'rgba(160,215,245,0.3)')
  g.fillStyle = 'rgba(150,200,235,0.25)'
  for (let i = 0; i < 6; i++) g.fillRect(22 + i * 12, 266, 8, 14)
  // Frost: heavier toward the bottom of each panel and on the pipes.
  const frost = fbm(1102, 8, 5)
  paintField(g, frost, [214, 238, 255], (v, x, y) => {
    let bias = 0.3
    if (y >= 300 && y < 456) bias = 0.55
    else if (y >= 6 && y < 294) {
      if (x < 256) bias = 0.1 + ((y - 6) / 288) * 0.65
      else if (y < 150) bias = 0.1 + ((y - 6) / 140) * 0.5
      else bias = 0.15 + ((y - 150) / 144) * 0.65
    }
    return smoothstep(0.5, 0.78, v) * bias * 0.75
  })
  // Frost crystals creeping up from the panel bottoms.
  g.strokeStyle = 'rgba(225,245,255,0.35)'
  g.lineWidth = 1
  for (let i = 0; i < 26; i++) {
    let x = 30 + rnd() * 452
    let y = [292, 144, 292][i % 3] - rnd() * 6
    let a = -Math.PI / 2 + (rnd() - 0.5) * 1.2
    g.beginPath()
    g.moveTo(x, y)
    for (let s = 0; s < 6; s++) {
      x += Math.cos(a) * 4
      y += Math.sin(a) * 4
      a += (rnd() - 0.5) * 1.1
      g.lineTo(x, y)
    }
    g.stroke()
  }
  grain(g, 10, 1103)

  const [e, eg] = blank('#000')
  glowStroke(eg, hLine(298), '#7fe9ff', 4, 12, '#e6fdff')
  // Coolant glowing through the inspection windows, with bubbles.
  for (const x of [150, 406]) {
    const gr = eg.createLinearGradient(0, 336, 0, 356)
    gr.addColorStop(0, '#1b7fa0')
    gr.addColorStop(0.5, '#7ff6ff')
    gr.addColorStop(1, '#1b7fa0')
    eg.fillStyle = gr
    eg.fillRect(x + 1, 337, 62, 18)
    eg.fillStyle = '#ffffff'
    for (let i = 0; i < 6; i++) eg.fillRect(x + 4 + rnd() * 54, 340 + rnd() * 12, 2, 2)
  }
  eg.save()
  eg.globalAlpha = 0.65
  glowStroke(eg, hLine(412), '#3fc8ff', 2, 6)
  eg.restore()
  // Status lights.
  const leds: [number, number, string][] = [
    [284, 22, '#e8fbff'],
    [298, 22, '#5cf2ff'],
    [312, 22, '#5cf2ff'],
    [326, 22, '#4fa8ff'],
    [284, 170, '#e8fbff'],
    [480, 22, '#5cf2ff'],
  ]
  for (const [x, y, col] of leds) glowFill(eg, rr(x, y, 9, 4), col, 6)
  // Faint circuit traces on the big panel.
  eg.save()
  eg.strokeStyle = 'rgba(92,242,255,0.55)'
  eg.fillStyle = '#9ff6ff'
  eg.lineWidth = 1.5
  for (let i = 0; i < 6; i++) {
    let x = 30 + rnd() * 200
    let y = 120 + rnd() * 150
    eg.beginPath()
    eg.moveTo(x, y)
    for (let k = 0; k < 4; k++) {
      if (k % 2) x = Math.max(16, Math.min(240, x + (rnd() - 0.5) * 120))
      else y = Math.max(60, Math.min(286, y + (rnd() - 0.5) * 70))
      eg.lineTo(x, y)
    }
    eg.stroke()
    eg.fillRect(x - 2.5, y - 2.5, 5, 5)
  }
  eg.restore()
  // Cold air from the kick plate vents.
  for (const x of [4, 260])
    for (let i = 0; i < 9; i++) {
      eg.fillStyle = 'rgba(92,220,255,0.35)'
      eg.fillRect(x + 23 + i * 24, 478, 12, 12)
    }
  return surface(c, e)
}

function coolingFloor(): SurfaceTex {
  const [c, g] = blank('#060b11')
  eachCell((x, y, L, i) => {
    const plate: PanelStyle = { top: i % 3 ? '#18252f' : '#1a2833', bottom: '#111b24', hi: 'rgba(190,230,255,0.14)', lo: 'rgba(0,0,0,0.5)' }
    const h = L / 2
    for (const [px, py] of [
      [0, 0],
      [h, 0],
      [0, h],
      [h, h],
    ]) {
      panel(g, x + px + 3, y + py + 3, h - 6, h - 6, plate)
      // Raised grip pattern.
      g.fillStyle = 'rgba(170,215,245,0.07)'
      for (let gy = 12; gy < h - 12; gy += 10)
        for (let gx = 12 + ((gy / 10) % 2) * 5; gx < h - 12; gx += 10) g.fillRect(x + px + gx, y + py + gy, 4, 1.5)
    }
    // Coolant port in the cell centre.
    const cx = x + L / 2
    const cy = y + L / 2
    g.fillStyle = '#05090d'
    g.beginPath()
    g.arc(cx, cy, L * 0.11, 0, TAU)
    g.fill()
    g.strokeStyle = '#4d6a82'
    g.lineWidth = 3
    g.beginPath()
    g.arc(cx, cy, L * 0.105, 0, TAU)
    g.stroke()
    g.strokeStyle = '#22323f'
    g.lineWidth = 2.5
    for (let k = 0; k < 8; k++) {
      const a = (k * TAU) / 8
      g.beginPath()
      g.moveTo(cx + Math.cos(a) * L * 0.03, cy + Math.sin(a) * L * 0.03)
      g.lineTo(cx + Math.cos(a) * L * 0.095, cy + Math.sin(a) * L * 0.095)
      g.stroke()
    }
  })
  const frost = fbm(1202, 6, 5)
  paintField(g, frost, [214, 238, 255], (v) => smoothstep(0.55, 0.82, v) * 0.32)
  grain(g, 12, 1203)

  const [e, eg] = blank('#000')
  cellEdges(eg, '#5cf2ff', 0.6, 7)
  eg.save()
  eg.shadowColor = '#5cf2ff'
  eg.shadowBlur = 12
  eg.strokeStyle = '#5cf2ff'
  eg.lineWidth = 4
  eg.beginPath()
  eg.arc(S / 2, S / 2, S * 0.105, 0, TAU)
  eg.stroke()
  eg.restore()
  const core = eg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.095)
  core.addColorStop(0, 'rgba(160,250,255,0.55)')
  core.addColorStop(1, 'rgba(30,120,160,0.15)')
  eg.fillStyle = core
  eg.beginPath()
  eg.arc(S / 2, S / 2, S * 0.095, 0, TAU)
  eg.fill()
  // Grill bars stay dark.
  eg.strokeStyle = '#000'
  eg.lineWidth = 5
  for (let k = 0; k < 8; k++) {
    const a = (k * TAU) / 8
    eg.beginPath()
    eg.moveTo(S / 2 + Math.cos(a) * S * 0.03, S / 2 + Math.sin(a) * S * 0.03)
    eg.lineTo(S / 2 + Math.cos(a) * S * 0.095, S / 2 + Math.sin(a) * S * 0.095)
    eg.stroke()
  }
  return surface(c, e)
}

function coolingCeiling(): SurfaceTex {
  const [c, g] = blank('#05090e')
  const st: PanelStyle = { top: '#121c26', bottom: '#0c141c', hi: 'rgba(170,215,245,0.12)', lo: 'rgba(0,0,0,0.5)' }
  for (let y = 0; y < S; y += 128) for (let x = 0; x < S; x += 128) panel(g, x + 3, y + 3, 122, 122, st)
  // Light housings with frosted diffusers.
  for (const y of [146, 346]) {
    g.fillStyle = '#04070a'
    g.fillRect(56, y - 4, 400, 28)
    g.fillStyle = '#b8cad6'
    g.fillRect(64, y + 2, 384, 16)
  }
  const frost = fbm(1302, 8, 4)
  paintField(g, frost, [214, 238, 255], (v) => smoothstep(0.6, 0.85, v) * 0.18)
  grain(g, 8, 1303)
  const [e, eg] = blank('#000')
  for (const y of [146, 346]) {
    glowFill(eg, rr(64, y + 2, 384, 16, 3), '#9ff4ff', 22, '#effdff')
    eg.fillStyle = '#ffffff'
    eg.fillRect(72, y + 7, 368, 6)
  }
  for (let y = 0; y <= S; y += 128)
    for (let x = 0; x <= S; x += 128) {
      eg.fillStyle = 'rgba(92,242,255,0.5)'
      eg.beginPath()
      eg.arc(x, y, 3, 0, TAU)
      eg.fill()
    }
  return surface(c, e)
}

// --- 1 Server Halls -------------------------------------------------------------------------------------

interface Led {
  x: number
  y: number
  w: number
  h: number
  color: string | null
}

interface RackUnit {
  x: number
  y: number
  w: number
  h: number
  kind: 'srv' | 'drives' | 'switch' | 'blank'
  leds: Led[]
}

const LED_GREEN = '#39ff6a'
const LED_AMBER = '#ffae1a'

function serverHalls(): SectorLook {
  return {
    name: 'Server Halls',
    wall: serverWall(),
    floor: serverFloor(),
    ceiling: serverCeiling(),
    wallEmissive: '#ffffff',
    floorEmissive: '#ffffff',
    ceilingEmissive: '#ffffff',
    wallEmissiveIntensity: 1.3,
    floorEmissiveIntensity: 0.75,
    ceilingEmissiveIntensity: 1.3,
    fog: '#03100a',
    background: '#010604',
    hemiSky: '#86ffaa',
    hemiGround: '#04100a',
    accent: '#7dff9a',
  }
}

function rackLayout(rnd: () => number): RackUnit[] {
  const units: RackUnit[] = []
  const led = (on: number, amber: number): string | null => (rnd() > on ? null : rnd() < amber ? LED_AMBER : LED_GREEN)
  for (const rx of [0, 256]) {
    let y = 32
    while (y < 478) {
      const r = rnd()
      const kind: RackUnit['kind'] = r < 0.38 ? 'srv' : r < 0.66 ? 'drives' : r < 0.84 ? 'switch' : 'blank'
      let h = kind === 'drives' ? (rnd() < 0.5 ? 32 : 48) : kind === 'switch' ? 16 : kind === 'srv' ? (rnd() < 0.6 ? 16 : 24) : rnd() < 0.5 ? 16 : 32
      h = Math.min(h, 480 - y)
      if (h < 12) break
      const u: RackUnit = { x: rx + 28, y, w: 200, h, kind, leds: [] }
      if (kind === 'srv' || kind === 'blank') {
        u.leds.push({ x: u.x + 6, y: y + h / 2 - 1.5, w: 4, h: 3, color: kind === 'srv' ? LED_GREEN : led(0.5, 0.2) })
        if (kind === 'srv')
          for (let i = 0; i < 3; i++) u.leds.push({ x: u.x + 14 + i * 7, y: y + h / 2 - 1.5, w: 4, h: 3, color: led(0.7, 0.3) })
      } else if (kind === 'drives') {
        const rows = h >= 48 ? 2 : 1
        const bw = (u.w - 12) / 8
        for (let row = 0; row < rows; row++)
          for (let i = 0; i < 8; i++)
            u.leds.push({ x: u.x + 6 + i * bw + 3, y: y + 4 + row * ((h - 4) / rows), w: 3, h: 2, color: led(0.85, 0.12) })
      } else {
        for (let i = 0; i < 12; i++) u.leds.push({ x: u.x + 30 + i * 13, y: y + 3, w: 3, h: 2, color: led(0.7, 0.35) })
      }
      units.push(u)
      y += h + 2
    }
  }
  return units
}

function serverWall(): SurfaceTex {
  const rnd = rng(2101)
  const units = rackLayout(rnd)
  const [c, g] = blank('#040605')
  for (const rx of [0, 256]) {
    // Cabinet body, rails with mounting holes, top cap and plinth.
    panel(g, rx + 4, 4, 248, 504, { top: '#121816', bottom: '#0b0f0d', hi: 'rgba(200,255,220,0.08)', lo: 'rgba(0,0,0,0.6)' })
    for (const x of [rx + 10, rx + 232]) {
      panel(g, x, 26, 14, 458, { top: '#232b28', bottom: '#181e1c', hi: 'rgba(220,255,235,0.14)', lo: 'rgba(0,0,0,0.5)' })
      g.fillStyle = '#050706'
      for (let y = 34; y < 480; y += 12) g.fillRect(x + 5, y, 4, 4)
    }
    panel(g, rx + 8, 6, 240, 20, { top: '#26302c', bottom: '#151b19', hi: 'rgba(220,255,235,0.14)' })
    panel(g, rx + 8, 484, 240, 22, { top: '#1b2220', bottom: '#0d1110', hi: 'rgba(220,255,235,0.1)' })
    g.fillStyle = '#050706'
    for (let i = 0; i < 18; i++) g.fillRect(rx + 22 + i * 12, 12, 7, 8)
  }
  for (const u of units) {
    const gr = g.createLinearGradient(0, u.y, 0, u.y + u.h)
    gr.addColorStop(0, '#202725')
    gr.addColorStop(1, '#131816')
    g.fillStyle = gr
    g.fillRect(u.x, u.y, u.w, u.h)
    g.fillStyle = 'rgba(220,255,235,0.1)'
    g.fillRect(u.x, u.y, u.w, 1)
    g.fillStyle = 'rgba(0,0,0,0.6)'
    g.fillRect(u.x, u.y + u.h - 1, u.w, 1)
    if (u.kind === 'srv') {
      g.fillStyle = '#070908'
      for (let y = u.y + 4; y < u.y + u.h - 4; y += 4) for (let x = u.x + 46; x < u.x + u.w - 30; x += 4) g.fillRect(x, y, 2, 2)
      g.fillStyle = '#3a4541'
      g.fillRect(u.x + u.w - 18, u.y + 3, 4, u.h - 6)
    } else if (u.kind === 'drives') {
      const rows = u.h >= 48 ? 2 : 1
      const bw = (u.w - 12) / 8
      const bh = (u.h - 4) / rows
      for (let row = 0; row < rows; row++)
        for (let i = 0; i < 8; i++) {
          const x = u.x + 6 + i * bw
          const y = u.y + 2 + row * bh
          g.fillStyle = '#0b0e0d'
          g.fillRect(x + 1, y + 1, bw - 2, bh - 2)
          g.fillStyle = '#2c3532'
          g.fillRect(x + 2, y + bh - 6, bw - 4, 3)
          g.fillStyle = 'rgba(220,255,235,0.08)'
          g.fillRect(x + 1, y + 1, bw - 2, 1)
        }
    } else if (u.kind === 'switch') {
      g.fillStyle = '#060807'
      for (let i = 0; i < 12; i++) g.fillRect(u.x + 28 + i * 13, u.y + 7, 8, 6)
    } else {
      g.fillStyle = '#0c0f0e'
      for (let y = u.y + 4; y < u.y + u.h - 3; y += 5)
        for (let x = u.x + 20 + ((y / 5) % 2) * 3; x < u.x + u.w - 10; x += 6) g.fillRect(x, y, 2, 2)
    }
    for (const l of u.leds) {
      g.fillStyle = l.color ? l.color : '#1d2522'
      g.globalAlpha = l.color ? 0.7 : 1
      g.fillRect(l.x, l.y, l.w, l.h)
      g.globalAlpha = 1
    }
  }
  text(g, 'RACK 14', 20, 16, 11, 'rgba(160,255,190,0.35)')
  text(g, 'RACK 15', 276, 16, 11, 'rgba(160,255,190,0.35)')
  grain(g, 9, 2102)

  const [e, eg] = blank('#000')
  for (const rx of [0, 256]) {
    // Green light along the inner rail edges and a status bar in the top cap.
    for (const x of [rx + 25, rx + 231]) {
      eg.save()
      eg.globalAlpha = 0.5
      glowStroke(eg, polyline([
        [x, 30],
        [x, 480],
      ]), '#1fd25a', 1.5, 6)
      eg.restore()
    }
    glowFill(eg, rr(rx + 196, 11, 40, 4, 1), '#39ff6a', 6)
  }
  for (const u of units)
    for (const l of u.leds) if (l.color) glowFill(eg, rr(l.x - 0.5, l.y - 0.5, l.w + 1, l.h + 1), l.color, 5)
  return surface(c, e)
}

/** Bar grating tiles for one floor cell, shared by the map and the emissive map. */
function gratingTiles(L: number, draw: (x: number, y: number, w: number, h: number, horizontal: boolean, pitch: number) => void) {
  const h = L / 2
  const inset = L * 0.035
  for (let ty = 0; ty < 2; ty++)
    for (let tx = 0; tx < 2; tx++) draw(tx * h + inset, ty * h + inset, h - inset * 2, h - inset * 2, (tx + ty) % 2 === 0, (h - inset * 2) / 14)
}

function serverFloor(): SurfaceTex {
  const rnd = rng(2201)
  const [c, g] = blank('#0a0e0c')
  eachCell((ox, oy, L) => {
    panel(g, ox + 2, oy + 2, L - 4, L - 4, { top: '#1e2522', bottom: '#151a18', hi: 'rgba(220,255,235,0.1)', lo: 'rgba(0,0,0,0.6)' })
    gratingTiles(L, (x, y, w, h, horizontal, pitch) => {
      x += ox
      y += oy
      g.fillStyle = '#020403'
      g.fillRect(x, y, w, h)
      // Cable runs under the grating.
      g.save()
      g.beginPath()
      g.rect(x, y, w, h)
      g.clip()
      for (let k = 0; k < 3; k++) {
        const y0 = y + rnd() * h
        g.strokeStyle = k % 2 ? '#0d1612' : '#101a2a'
        g.lineWidth = 5 + rnd() * 4
        g.beginPath()
        g.moveTo(x - 4, y0)
        g.bezierCurveTo(x + w * 0.3, y0 + (rnd() - 0.5) * 40, x + w * 0.7, y0 + (rnd() - 0.5) * 40, x + w + 4, y + rnd() * h)
        g.stroke()
      }
      g.restore()
      g.fillStyle = '#3a4641'
      for (let i = 0; i <= 14; i++) {
        const t = i * pitch - pitch * 0.28
        if (horizontal) g.fillRect(x, y + t, w, pitch * 0.56)
        else g.fillRect(x + t, y, pitch * 0.56, h)
      }
      g.fillStyle = 'rgba(220,255,235,0.12)'
      for (let i = 0; i <= 14; i++) {
        const t = i * pitch - pitch * 0.28
        if (horizontal) g.fillRect(x, y + t, w, 1)
        else g.fillRect(x + t, y, 1, h)
      }
      g.strokeStyle = '#26302c'
      g.lineWidth = 3
      g.strokeRect(x, y, w, h)
    })
  })
  grain(g, 10, 2202)

  const [e, eg] = blank('#000')
  gratingTiles(S, (x, y, w, h, horizontal, pitch) => {
    const glow = eg.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w * 0.7)
    glow.addColorStop(0, 'rgba(60,255,120,0.55)')
    glow.addColorStop(1, 'rgba(20,140,60,0.12)')
    eg.fillStyle = glow
    eg.fillRect(x, y, w, h)
    eg.fillStyle = '#000'
    for (let i = 0; i <= 14; i++) {
      const t = i * pitch - pitch * 0.28
      if (horizontal) eg.fillRect(x, y + t, w, pitch * 0.56)
      else eg.fillRect(x + t, y, pitch * 0.56, h)
    }
    eg.lineWidth = 6
    eg.strokeStyle = '#000'
    eg.strokeRect(x, y, w, h)
  })
  cellEdges(eg, '#39ff6a', 0.55, 6)
  return surface(c, e)
}

function serverCeiling(): SurfaceTex {
  const rnd = rng(2301)
  const [c, g] = blank('#040605')
  for (let y = 0; y < S; y += 128)
    for (let x = 0; x < S; x += 128) panel(g, x + 3, y + 3, 122, 122, { top: '#121815', bottom: '#0b0f0d', hi: 'rgba(200,255,220,0.08)', lo: 'rgba(0,0,0,0.5)' })
  // Cable trays running along the hall.
  for (const y of [70, 410]) {
    g.fillStyle = '#1c2421'
    g.fillRect(0, y - 26, S, 52)
    g.fillStyle = '#0a0d0c'
    g.fillRect(0, y - 22, S, 44)
    for (let k = 0; k < 7; k++) {
      g.fillStyle = ['#0f1a2c', '#1a0f0f', '#0f1d14', '#202020'][k % 4]
      g.fillRect(0, y - 20 + k * 6, S, 5)
      g.fillStyle = 'rgba(255,255,255,0.06)'
      g.fillRect(0, y - 20 + k * 6, S, 1)
    }
    g.fillStyle = '#2a3430'
    for (let x = 0; x < S; x += 64) g.fillRect(x, y - 28, 6, 56)
  }
  g.fillStyle = '#05080a'
  g.fillRect(40, 236, 432, 40)
  g.fillStyle = '#b9d6c2'
  g.fillRect(48, 244, 416, 24)
  grain(g, 8, 2302)
  const [e, eg] = blank('#000')
  glowFill(eg, rr(48, 244, 416, 24, 3), '#7dffa8', 24, '#eafff0')
  eg.fillStyle = '#ffffff'
  eg.fillRect(56, 252, 400, 8)
  for (const y of [70, 410])
    for (let x = 20; x < S; x += 64) glowFill(eg, rr(x + rnd() * 30, y - 30, 4, 3), rnd() < 0.2 ? LED_AMBER : LED_GREEN, 5)
  return surface(c, e)
}

// --- 2 Corrupted Sector ---------------------------------------------------------------------------------

interface Block {
  x: number
  y: number
  s: number
  color: string
  glow: string | null
}

interface Tear {
  y: number
  h: number
  dx: number
}

function corruptedSector(): SectorLook {
  return {
    name: 'Corrupted Sector',
    wall: corruptedWall(),
    floor: corruptedFloor(),
    ceiling: corruptedCeiling(),
    wallEmissive: '#ffffff',
    floorEmissive: '#ffffff',
    ceilingEmissive: '#ffffff',
    wallEmissiveIntensity: 1.35,
    floorEmissiveIntensity: 0.8,
    ceilingEmissiveIntensity: 1.25,
    fog: '#13030b',
    background: '#070105',
    hemiSky: '#ff5c9a',
    hemiGround: '#14030c',
    accent: '#ff3b6b',
  }
}

/** Branching random-walk cracks; points may leave the canvas, so draw them with wrap(). */
function crackPaths(rnd: () => number, count: number, len: number, x0 = 0, y0 = 0, span = S): Pt[][] {
  const out: Pt[][] = []
  const walk = (x: number, y: number, a: number, steps: number, depth: number) => {
    const pts: Pt[] = [[x, y]]
    for (let i = 0; i < steps; i++) {
      a += (rnd() - 0.5) * 0.9
      const step = 5 + rnd() * 9
      x += Math.cos(a) * step
      y += Math.sin(a) * step
      pts.push([x, y])
      if (depth < 2 && rnd() < 0.09) walk(x, y, a + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6), Math.floor(steps * 0.4), depth + 1)
    }
    out.push(pts)
  }
  for (let i = 0; i < count; i++) walk(x0 + rnd() * span, y0 + rnd() * span, rnd() * TAU, len, 0)
  return out
}

function corruptBlocks(rnd: () => number, clusters: number, x0 = 0, y0 = 0, span = S, glowShare = 0.35): Block[] {
  const fills = ['#3a0f22', '#5a1430', '#1a0610', '#0f2a33', '#2a2a2a', '#4a0a14', '#12060c']
  const glows = ['#ff4fd8', '#ff2a3a', '#ff2a3a', '#5cf2ff', '#ffffff']
  const out: Block[] = []
  for (let c = 0; c < clusters; c++) {
    const cx = x0 + rnd() * span
    const cy = y0 + rnd() * span
    const n = 8 + Math.floor(rnd() * 12)
    for (let i = 0; i < n; i++) {
      const s = rnd() < 0.3 ? 16 : rnd() < 0.6 ? 8 : 4
      out.push({
        x: Math.round((cx + (rnd() - 0.5) * 70) / 4) * 4,
        y: Math.round((cy + (rnd() - 0.5) * 40) / 4) * 4,
        s,
        color: fills[Math.floor(rnd() * fills.length)],
        glow: rnd() < glowShare ? glows[Math.floor(rnd() * glows.length)] : null,
      })
    }
  }
  return out
}

function tearBands(rnd: () => number, n: number): Tear[] {
  return Array.from({ length: n }, () => ({
    y: Math.floor(rnd() * (S - 30)),
    h: 3 + Math.floor(rnd() * 22),
    dx: Math.round((rnd() < 0.5 ? -1 : 1) * (10 + rnd() * 56)),
  }))
}

/** Shifts horizontal bands with wrap-around, so the texture still tiles. */
function applyTears(g: Ctx, tears: Tear[]) {
  for (const t of tears) {
    const [b, bg] = canvas(S, t.h)
    bg.drawImage(g.canvas, 0, t.y, S, t.h, 0, 0, S, t.h)
    for (const dx of [t.dx - S, t.dx, t.dx + S]) g.drawImage(b, dx, t.y)
  }
}

function drawCracks(g: Ctx, cracks: Pt[][]) {
  wrap(g, () => {
    for (const pts of cracks) {
      const p = polyline(pts)
      g.strokeStyle = 'rgba(255,120,170,0.14)'
      g.lineWidth = 4
      g.stroke(p)
      g.strokeStyle = '#050103'
      g.lineWidth = 2.5
      g.stroke(p)
    }
  })
}

function glowCracks(g: Ctx, cracks: Pt[][], share: number, rnd: () => number) {
  const lit = cracks.filter(() => rnd() < share)
  wrap(g, () => {
    for (const pts of lit) glowStroke(g, polyline(pts), '#ff2d6f', 1.6, 7, '#ffd6e6')
  })
}

function drawBlocks(g: Ctx, blocks: Block[], glow: boolean) {
  wrap(g, () => {
    for (const b of blocks) {
      if (glow) {
        if (!b.glow) continue
        g.globalAlpha = 0.85
        g.fillStyle = b.glow
        g.fillRect(b.x, b.y, b.s, b.s)
        g.globalAlpha = 1
      } else {
        g.fillStyle = b.color
        g.fillRect(b.x, b.y, b.s, b.s)
        g.fillStyle = 'rgba(255,255,255,0.05)'
        g.fillRect(b.x, b.y, b.s, 1)
      }
    }
  })
}

function corruptedWall(): SurfaceTex {
  const rnd = rng(3101)
  const [c, g] = blank('#0a0407')
  const st: PanelStyle = { top: '#3a1c2b', bottom: '#21101a', hi: 'rgba(255,170,210,0.16)', lo: 'rgba(0,0,0,0.55)', bolt: '#5a3346' }
  const plates: [number, number, number, number][] = [
    [4, 6, 248, 316],
    [260, 6, 248, 150],
    [260, 164, 248, 158],
    [4, 338, 504, 120],
  ]
  for (const [x, y, w, h] of plates) panel(g, x, y, w, h, st)
  for (const x of [4, 260]) panel(g, x, 466, 248, 40, { top: '#2a1420', bottom: '#170a11', hi: 'rgba(255,170,210,0.1)' })
  g.fillStyle = '#050103'
  g.fillRect(0, 326, S, 8)
  // Scorch and grime.
  const scorch = fbm(3102, 6, 5)
  paintField(g, scorch, [6, 1, 3], (v) => smoothstep(0.45, 0.75, v) * 0.75)
  // Holes torn through the plating.
  wrap(g, () => {
    const r2 = rng(3103)
    for (let i = 0; i < 3; i++) {
      const cx = r2() * S
      const cy = 40 + r2() * 420
      const R = 14 + r2() * 22
      const pts: Pt[] = []
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU
        const rr2 = R * (0.55 + r2() * 0.6)
        pts.push([cx + Math.cos(a) * rr2, cy + Math.sin(a) * rr2 * 0.8])
      }
      const p = polyline(pts, true)
      g.fillStyle = '#020001'
      g.fill(p)
      g.strokeStyle = 'rgba(255,110,160,0.25)'
      g.lineWidth = 1.5
      g.stroke(p)
    }
  })
  const cracks = crackPaths(rnd, 9, 26)
  drawCracks(g, cracks)
  const blocks = corruptBlocks(rnd, 4)
  drawBlocks(g, blocks, false)
  text(g, 'ERR 0x0000DEAD', 22, 30, 15, 'rgba(255,120,170,0.3)')
  text(g, 'SEG/FAULT', 278, 182, 13, 'rgba(255,120,170,0.28)')
  grain(g, 14, 3104)

  const [e, eg] = blank('#000')
  // A faint sick glow keeps the plates readable in the dark.
  eg.fillStyle = '#16050b'
  for (const [x, y, w, h] of plates) eg.fillRect(x, y, w, h)
  glowCracks(eg, cracks, 0.4, rnd)
  drawBlocks(eg, blocks, true)
  // Broken light band in uneven segments, like a failing tube.
  let x = 0
  while (x < S) {
    const w = Math.min(S - x, 18 + Math.floor(rnd() * 60))
    const on = rnd() > 0.28
    if (on) {
      const a = 0.35 + rnd() * 0.65
      const seg = polyline([
        [x + 2, 330],
        [x + w - 2, 330],
      ])
      eg.save()
      eg.globalAlpha = a
      wrap(eg, () => glowStroke(eg, seg, '#ff3b6b', 4, 10, '#ffd0de'))
      eg.restore()
    }
    x += w
  }
  // Status lights, half of them failing red.
  for (let i = 0; i < 5; i++) glowFill(eg, rr(284 + i * 14, 22, 9, 4), i % 2 ? '#ff2a3a' : '#ff4fd8', 6)
  const tears = tearBands(rnd, 6)
  for (const t of tears) {
    const len = 60 + rnd() * 300
    const start = rnd() * S
    const col = rnd() < 0.5 ? '#ff7ac0' : '#7ff6ff'
    eg.save()
    eg.globalAlpha = 0.8
    eg.fillStyle = col
    wrap(eg, () => eg.fillRect(start, t.y, len, 1.5))
    eg.restore()
  }
  applyTears(g, tears)
  applyTears(eg, tears)
  return surface(c, e)
}

function corruptedFloor(): SurfaceTex {
  const rnd = rng(3201)
  const [c, g] = blank('#080306')
  eachCell((x, y, L) => {
    const h = L / 2
    for (const [px, py] of [
      [0, 0],
      [h, 0],
      [0, h],
      [h, h],
    ]) {
      const shift = rnd() < 0.3 ? (rnd() - 0.5) * 8 : 0
      panel(g, x + px + 3 + shift, y + py + 3, h - 6, h - 6, { top: '#2e1724', bottom: '#1e0e17', hi: 'rgba(255,170,210,0.12)', lo: 'rgba(0,0,0,0.55)' })
    }
  })
  const scorch = fbm(3202, 4, 5)
  paintField(g, scorch, [5, 1, 3], (v) => smoothstep(0.42, 0.75, v) * 0.7)
  const mapCracks = crackPaths(rnd, 10, 24)
  drawCracks(g, mapCracks)
  drawBlocks(g, corruptBlocks(rnd, 5, 0, 0, S, 0), false)
  grain(g, 14, 3203)

  const [e, eg] = blank('#000')
  // Broken cell border: dashes centred on the cell edges, so neighbouring cells share every dash.
  const dashes = () => {
    const out: [number, number, number][] = []
    let t = 0
    while (t < S) {
      const len = 20 + rnd() * 90
      if (rnd() > 0.3) out.push([t, Math.min(S, t + len), 0.3 + rnd() * 0.5])
      t += len + 8 + rnd() * 16
    }
    return out
  }
  const across = dashes()
  const down = dashes()
  eg.save()
  eg.strokeStyle = '#ff2d55'
  eg.shadowColor = '#ff2d55'
  eg.shadowBlur = 6
  eg.lineWidth = 5
  wrap(eg, () => {
    for (const [a, b, alpha] of across) {
      eg.globalAlpha = alpha
      eg.stroke(polyline([
        [a, 0],
        [b, 0],
      ]))
    }
    for (const [a, b, alpha] of down) {
      eg.globalAlpha = alpha
      eg.stroke(polyline([
        [0, a],
        [0, b],
      ]))
    }
  })
  eg.restore()
  // Glowing fissures and a few hot pixels inside the cell.
  const cracks = crackPaths(rnd, 2, 16, 120, 120, S - 240)
  wrap(eg, () => {
    for (const pts of cracks) glowStroke(eg, polyline(pts), '#ff2d6f', 2.2, 8, '#ffd6e6')
  })
  drawBlocks(eg, corruptBlocks(rnd, 2, 100, 100, S - 200, 0.6), true)
  return surface(c, e)
}

function corruptedCeiling(): SurfaceTex {
  const rnd = rng(3301)
  const [c, g] = blank('#060205')
  for (let y = 0; y < S; y += 128)
    for (let x = 0; x < S; x += 128) panel(g, x + 3, y + 3, 122, 122, { top: '#1a0c13', bottom: '#11060c', hi: 'rgba(255,170,210,0.08)', lo: 'rgba(0,0,0,0.5)' })
  for (const y of [146, 346]) {
    g.fillStyle = '#030102'
    g.fillRect(56, y - 4, 400, 28)
    g.fillStyle = '#6a3a50'
    g.fillRect(64, y + 2, 384, 16)
  }
  const cracks = crackPaths(rnd, 6, 22)
  drawCracks(g, cracks)
  grain(g, 10, 3302)
  const [e, eg] = blank('#000')
  // Flickering tubes: uneven segments, some dead.
  for (const y of [146, 346]) {
    let x = 64
    while (x < 448) {
      const w = Math.min(448 - x, 24 + Math.floor(rnd() * 70))
      if (rnd() > 0.25) {
        eg.save()
        eg.globalAlpha = 0.3 + rnd() * 0.7
        glowFill(eg, rr(x + 1, y + 2, w - 2, 16, 2), '#ff3b8a', 18, '#ffd0e4')
        eg.restore()
      }
      x += w
    }
  }
  glowCracks(eg, cracks, 0.5, rnd)
  drawBlocks(eg, corruptBlocks(rnd, 2, 0, 0, S, 0.6), true)
  return surface(c, e)
}

// --- 3 The Core ---------------------------------------------------------------------------------------

function theCore(): SectorLook {
  return {
    name: 'The Core',
    wall: coreWall(),
    floor: coreFloor(),
    ceiling: coreCeiling(),
    wallEmissive: '#ffffff',
    floorEmissive: '#ffffff',
    ceilingEmissive: '#ffffff',
    wallEmissiveIntensity: 1.0,
    floorEmissiveIntensity: 0.65,
    ceilingEmissiveIntensity: 1.2,
    fog: '#6c675c',
    background: '#2a2822',
    hemiSky: '#fff3d6',
    hemiGround: '#4a4336',
    accent: '#ffe9a8',
  }
}

const GOLD: PanelStyle = { top: '#f2d488', bottom: '#a8802e', hi: 'rgba(255,250,225,0.7)', lo: 'rgba(80,50,10,0.6)' }
const WHITE_PANEL: PanelStyle = { top: '#dfe4ea', bottom: '#bdc5ce', hi: 'rgba(255,255,255,0.85)', lo: 'rgba(80,90,105,0.55)' }

function coreWall(): SurfaceTex {
  const [c, g] = blank('#8a939e')
  // Gold trim centred on the top/bottom edge, so stacked walls share one continuous band.
  trim(g, -6, 12, GOLD)
  trim(g, S - 6, 12, GOLD)
  const upper: [number, number, number, number][] = [
    [6, 14, 244, 300],
    [262, 14, 244, 300],
  ]
  const lower: [number, number, number, number][] = [
    [6, 342, 244, 152],
    [262, 342, 244, 152],
  ]
  for (const [x, y, w, h] of [...upper, ...lower]) panel(g, x, y, w, h, { ...WHITE_PANEL, r: 6 })
  trim(g, 320, 16, GOLD)
  // Recessed light channels and inset seams.
  for (const [x, y, w, h] of upper) {
    const cx = x + w / 2
    g.fillStyle = '#7d8792'
    g.fillRect(cx - 4, y + 26, 8, h - 52)
    g.fillStyle = 'rgba(255,255,255,0.8)'
    g.fillRect(cx + 4, y + 26, 1, h - 52)
    g.strokeStyle = 'rgba(120,130,145,0.45)'
    g.lineWidth = 1.5
    g.strokeRect(x + 16, y + 16, w - 32, h - 32)
  }
  // Gold-rimmed hex vents on the lower panels.
  for (const [x, y, w, h] of lower) {
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 7; col++) {
        const hx = x + 42 + col * 26 + (row % 2) * 13
        const hy = y + h / 2 - 22 + row * 22
        const p = hexPath(hx, hy, 9, 9)
        g.fillStyle = '#4a4f57'
        g.fill(p)
        g.strokeStyle = '#c9a14a'
        g.lineWidth = 2
        g.stroke(p)
      }
  }
  text(g, 'CORE ACCESS // LEVEL 9', 24, 32, 13, 'rgba(150,120,50,0.6)')
  grain(g, 5, 4101)

  const [e, eg] = blank('#000')
  // Faint base glow keeps the white panels bright in dim light.
  for (const [x, y, w, h] of [...upper, ...lower]) {
    eg.fillStyle = '#262626'
    eg.fill(rr(x, y, w, h, 6))
  }
  for (const [x, y, w, h] of upper) {
    const cx = x + w / 2
    glowStroke(eg, polyline([
      [cx, y + 30],
      [cx, y + h - 30],
    ]), '#fff2cc', 4, 14, '#ffffff')
  }
  glowStroke(eg, hLine(328), '#ffc84a', 2.5, 10, '#fff1c4')
  for (const y of [0, S]) {
    eg.save()
    eg.globalAlpha = 0.6
    glowStroke(eg, hLine(y), '#ffc84a', 2, 6)
    eg.restore()
  }
  for (const [x, y, w, h] of lower)
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 7; col++) {
        const hx = x + 42 + col * 26 + (row % 2) * 13
        const hy = y + h / 2 - 22 + row * 22
        eg.fillStyle = (row + col) % 3 ? 'rgba(255,210,120,0.35)' : 'rgba(255,240,200,0.8)'
        eg.fill(hexPath(hx, hy, 6, 6))
      }
  return surface(c, e)
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * Hex lattice for one floor cell: 5 hexes across and 6 rows (3 vertical periods, slightly squashed so it
 * tiles). `i`/`j` are the lattice indices wrapped to the cell, `ri`/`rj` the raw ones (-1 to 5 / -1 to 6).
 */
function coreHexes(L: number, draw: (cx: number, cy: number, rx: number, ry: number, i: number, j: number, ri: number, rj: number) => void) {
  const n = 5
  const m = 3
  const w = L / n
  const ry = L / (m * 3)
  const rx = w / Math.sqrt(3)
  for (let j = -1; j <= m * 2; j++)
    for (let i = -1; i <= n; i++) draw(i * w + (mod(j, 2) ? w / 2 : 0), j * ry * 1.5, rx, ry, mod(i, n), mod(j, m * 2), i, j)
}

/** Stable pseudo-random value in [0, 1) for a lattice position. */
function hash2(i: number, j: number) {
  const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
  return h - Math.floor(h)
}

const LIT_HEX = new Set(['1,1', '3,4'])

function coreFloor(): SurfaceTex {
  const [c, g] = blank('#8f7a46')
  eachCell((ox, oy, L) => {
    g.save()
    g.beginPath()
    g.rect(ox, oy, L, L)
    g.clip()
    coreHexes(L, (cx, cy, rx, ry, i, j, ri, rj) => {
      const x = ox + cx
      const y = oy + cy
      const lit = LIT_HEX.has(`${i},${j}`)
      const p = hexPath(x, y, rx - 1.6, ry - 1.6)
      const gr = g.createLinearGradient(x - rx, y - ry, x + rx, y + ry)
      // Shade by position in the 2x2-cell map so hexes cut by a cell edge match on both sides.
      const v = hash2(mod((ox / L) * 5 + ri, 10), mod((oy / L) * 6 + rj, 12)) * 12
      gr.addColorStop(0, lit ? '#fbfcfd' : `rgb(${216 - v},${221 - v},${227 - v})`)
      gr.addColorStop(1, lit ? '#e4e9ee' : `rgb(${180 - v},${187 - v},${196 - v})`)
      g.fillStyle = gr
      g.fill(p)
      g.strokeStyle = 'rgba(255,255,255,0.75)'
      g.lineWidth = 1
      g.stroke(hexPath(x - 0.6, y - 0.6, rx - 3, ry - 3))
      if (!lit && (i + j) % 4 === 0) {
        g.strokeStyle = '#c9a14a'
        g.lineWidth = 1.5
        g.stroke(hexPath(x, y, rx * 0.45, ry * 0.45))
      }
    })
    g.restore()
  })
  grain(g, 4, 4202)

  const [e, eg] = blank('#000')
  coreHexes(S, (cx, cy, rx, ry, i, j) => {
    const lit = LIT_HEX.has(`${i},${j}`)
    if (lit) glowFill(eg, hexPath(cx, cy, rx - 6, ry - 6), '#fff2cc', 18, 'rgba(255,250,235,0.85)')
    eg.strokeStyle = 'rgba(255,200,90,0.45)'
    eg.lineWidth = 2.5
    eg.stroke(hexPath(cx, cy, rx, ry))
    if (!lit && (i + j) % 4 === 0) {
      eg.strokeStyle = 'rgba(255,215,120,0.8)'
      eg.lineWidth = 2
      eg.stroke(hexPath(cx, cy, rx * 0.45, ry * 0.45))
    }
  })
  return surface(c, e)
}

function coreCeiling(): SurfaceTex {
  const [c, g] = blank('#9aa3ad')
  for (let y = 0; y < S; y += 256) for (let x = 0; x < S; x += 256) panel(g, x + 4, y + 4, 248, 248, { ...WHITE_PANEL, r: 8 })
  // Gold-rimmed fixture with four diffuser panels.
  panel(g, 108, 108, 296, 296, { ...GOLD, r: 16 })
  panel(g, 116, 116, 280, 280, { top: '#3a3f46', bottom: '#2c3036', r: 10 })
  const quads: [number, number][] = [
    [124, 124],
    [262, 124],
    [124, 262],
    [262, 262],
  ]
  for (const [x, y] of quads) {
    panel(g, x, y, 126, 126, { top: '#f6f7f2', bottom: '#e2e4dd', r: 6 })
    g.strokeStyle = 'rgba(150,160,170,0.3)'
    g.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      g.beginPath()
      g.moveTo(x + i * 31.5, y + 4)
      g.lineTo(x + i * 31.5, y + 122)
      g.moveTo(x + 4, y + i * 31.5)
      g.lineTo(x + 122, y + i * 31.5)
      g.stroke()
    }
  }
  // Small status lamps in the panel corners.
  g.fillStyle = '#c9a14a'
  for (const [x, y] of [
    [24, 24],
    [488, 24],
    [24, 488],
    [488, 488],
  ])
    g.fillRect(x - 3, y - 3, 6, 6)
  grain(g, 4, 4301)

  const [e, eg] = blank('#000')
  eg.save()
  eg.globalAlpha = 0.75
  glowStroke(eg, rr(110, 110, 292, 292, 15), '#ffc84a', 3, 10)
  eg.restore()
  for (const [x, y] of quads) {
    const light = eg.createRadialGradient(x + 63, y + 63, 8, x + 63, y + 63, 96)
    light.addColorStop(0, '#fffaf0')
    light.addColorStop(0.65, '#f7e7c4')
    light.addColorStop(1, '#d9b974')
    glowFill(eg, rr(x, y, 126, 126, 6), '#fff2cc', 16)
    eg.fillStyle = light
    eg.fill(rr(x, y, 126, 126, 6))
  }
  for (const [x, y] of [
    [24, 24],
    [488, 24],
    [24, 488],
    [488, 488],
  ])
    glowFill(eg, rr(x - 3, y - 3, 6, 6), '#ffc84a', 6)
  return surface(c, e)
}

// --- 4 Hub ------------------------------------------------------------------------------------------------

function hub(): SectorLook {
  return {
    name: 'Hub',
    wall: hubWall(),
    floor: hubFloor(),
    ceiling: hubCeiling(),
    wallEmissive: '#ffffff',
    floorEmissive: '#ffffff',
    ceilingEmissive: '#ffffff',
    wallEmissiveIntensity: 1.0,
    floorEmissiveIntensity: 0.55,
    ceilingEmissiveIntensity: 1.15,
    fog: '#140c06',
    background: '#080402',
    hemiSky: '#ffcf8f',
    hemiGround: '#1c1208',
    accent: '#ffb347',
  }
}

const WARM: PanelStyle = { top: '#43372b', bottom: '#2c241c', hi: 'rgba(255,225,180,0.2)', lo: 'rgba(0,0,0,0.5)', r: 10 }

function hubWall(): SurfaceTex {
  const [c, g] = blank('#120d09')
  panel(g, 6, 8, 244, 272, WARM)
  panel(g, 262, 8, 244, 272, WARM)
  for (const x of [6, 262]) {
    panel(g, x, 318, 244, 182, { ...WARM, top: '#3a2f25', bottom: '#261f18' })
    // Vertical slats on the lower panels.
    for (let sx = x + 18; sx < x + 232; sx += 16) {
      g.fillStyle = 'rgba(0,0,0,0.35)'
      g.fillRect(sx, 334, 3, 150)
      g.fillStyle = 'rgba(255,225,180,0.07)'
      g.fillRect(sx + 3, 334, 1, 150)
    }
  }
  // Brushed finish on the upper panels.
  const rnd = rng(5101)
  const upper = new Path2D()
  upper.addPath(rr(6, 8, 244, 272, 10))
  upper.addPath(rr(262, 8, 244, 272, 10))
  g.save()
  g.clip(upper)
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(255,230,190,${0.02 + rnd() * 0.035})`
    g.fillRect(12 + rnd() * 488, 14 + rnd() * 262, 30 + rnd() * 90, 1)
  }
  g.restore()
  // Light channel and sconce housings.
  g.fillStyle = '#0a0705'
  g.fillRect(0, 290, S, 18)
  g.fillStyle = '#5a4630'
  g.fillRect(0, 296, S, 6)
  for (const x of [128, 384]) {
    g.fillStyle = '#1a130d'
    g.fill(rr(x - 15, 100, 30, 96, 12))
    g.fillStyle = '#5a4630'
    g.fill(rr(x - 12, 103, 24, 90, 10))
    g.fillStyle = '#c8a77a'
    g.fill(rr(x - 7, 110, 14, 76, 6))
  }
  text(g, 'SAFE ZONE', 22, 30, 15, 'rgba(255,200,140,0.35)')
  text(g, 'HUB-01', 278, 30, 13, 'rgba(255,200,140,0.3)')
  grain(g, 7, 5102)

  const [e, eg] = blank('#000')
  // Soft amber band: wide gentle wash plus a bright core line.
  const wash = eg.createLinearGradient(0, 270, 0, 330)
  wash.addColorStop(0, 'rgba(255,170,70,0)')
  wash.addColorStop(0.5, 'rgba(255,170,70,0.35)')
  wash.addColorStop(1, 'rgba(255,170,70,0)')
  eg.fillStyle = wash
  eg.fillRect(0, 270, S, 60)
  glowStroke(eg, hLine(299), '#ffb347', 4, 14, '#fff0d8')
  for (const x of [128, 384]) {
    const halo = eg.createRadialGradient(x, 148, 6, x, 148, 96)
    halo.addColorStop(0, 'rgba(255,180,90,0.42)')
    halo.addColorStop(0.5, 'rgba(255,150,60,0.12)')
    halo.addColorStop(1, 'rgba(255,150,60,0)')
    eg.fillStyle = halo
    eg.fillRect(x - 100, 48, 200, 200)
    const lens = eg.createLinearGradient(0, 110, 0, 186)
    lens.addColorStop(0, '#ffb85c')
    lens.addColorStop(0.5, '#ffe9c8')
    lens.addColorStop(1, '#ffb85c')
    glowFill(eg, rr(x - 7, 110, 14, 76, 6), '#ffb347', 14, '#ffd9a0')
    eg.fillStyle = lens
    eg.fill(rr(x - 5, 113, 10, 70, 5))
  }
  for (const [x, y] of [
    [24, 260],
    [36, 260],
    [480, 260],
  ])
    glowFill(eg, rr(x, y, 6, 6, 3), '#ffb347', 6)
  return surface(c, e)
}

function hubFloor(): SurfaceTex {
  const [c, g] = blank('#15100c')
  eachCell((x, y, L) => {
    const h = L / 2
    for (const [px, py] of [
      [0, 0],
      [h, 0],
      [0, h],
      [h, h],
    ])
      panel(g, x + px + 2.5, y + py + 2.5, h - 5, h - 5, { top: '#2f2821', bottom: '#241e18', hi: 'rgba(255,225,180,0.12)', lo: 'rgba(0,0,0,0.45)', r: 4 })
    // Inlaid diamond at each cell corner (completed by neighbours) and in the centre.
    g.fillStyle = '#6a5034'
    for (const [dx, dy] of [
      [0, 0],
      [L, 0],
      [0, L],
      [L, L],
      [L / 2, L / 2],
    ]) {
      g.beginPath()
      g.moveTo(x + dx, y + dy - 10)
      g.lineTo(x + dx + 10, y + dy)
      g.lineTo(x + dx, y + dy + 10)
      g.lineTo(x + dx - 10, y + dy)
      g.closePath()
      g.fill()
    }
  })
  const sheen = fbm(5201, 4, 3)
  paintField(g, sheen, [255, 220, 170], (v) => smoothstep(0.55, 0.8, v) * 0.06)
  grain(g, 6, 5202)
  const [e, eg] = blank('#000')
  cellEdges(eg, '#ffb347', 0.4, 0)
  eg.save()
  eg.shadowColor = '#ffb347'
  eg.shadowBlur = 10
  eg.fillStyle = '#ffcf8f'
  for (const [dx, dy, r] of [
    [0, 0, 12],
    [S, 0, 12],
    [0, S, 12],
    [S, S, 12],
    [S / 2, S / 2, 12],
  ]) {
    eg.beginPath()
    eg.moveTo(dx, dy - r)
    eg.lineTo(dx + r, dy)
    eg.lineTo(dx, dy + r)
    eg.lineTo(dx - r, dy)
    eg.closePath()
    eg.fill()
  }
  eg.restore()
  return surface(c, e)
}

function hubCeiling(): SurfaceTex {
  const [c, g] = blank('#100b07')
  for (let y = 0; y < S; y += 256) for (let x = 0; x < S; x += 256) panel(g, x + 4, y + 4, 248, 248, { ...WARM, top: '#2e251d', bottom: '#221b15' })
  // Round pendant lamp with a brass rim, and four small downlights.
  g.fillStyle = '#0a0604'
  g.beginPath()
  g.arc(256, 256, 96, 0, TAU)
  g.fill()
  const rim = g.createLinearGradient(160, 160, 352, 352)
  rim.addColorStop(0, '#d9b27a')
  rim.addColorStop(1, '#6a4a28')
  g.strokeStyle = rim
  g.lineWidth = 8
  g.beginPath()
  g.arc(256, 256, 88, 0, TAU)
  g.stroke()
  g.fillStyle = '#d6b88e'
  g.beginPath()
  g.arc(256, 256, 78, 0, TAU)
  g.fill()
  const downs: Pt[] = [
    [64, 64],
    [448, 64],
    [64, 448],
    [448, 448],
  ]
  for (const [x, y] of downs) {
    g.fillStyle = '#0a0604'
    g.beginPath()
    g.arc(x, y, 14, 0, TAU)
    g.fill()
    g.fillStyle = '#b89870'
    g.beginPath()
    g.arc(x, y, 9, 0, TAU)
    g.fill()
  }
  grain(g, 6, 5301)

  const [e, eg] = blank('#000')
  const wash = eg.createRadialGradient(256, 256, 80, 256, 256, 200)
  wash.addColorStop(0, 'rgba(255,170,80,0.3)')
  wash.addColorStop(1, 'rgba(255,170,80,0)')
  eg.fillStyle = wash
  eg.fillRect(0, 0, S, S)
  const light = eg.createRadialGradient(256, 256, 6, 256, 256, 78)
  light.addColorStop(0, '#fff3e0')
  light.addColorStop(0.55, '#ffd9a0')
  light.addColorStop(1, '#f0a050')
  eg.save()
  eg.shadowColor = '#ffb347'
  eg.shadowBlur = 26
  eg.fillStyle = light
  eg.beginPath()
  eg.arc(256, 256, 78, 0, TAU)
  eg.fill()
  eg.restore()
  for (const [x, y] of downs) {
    const p = new Path2D()
    p.arc(x, y, 9, 0, TAU)
    glowFill(eg, p, '#ffb347', 10, '#ffe2b8')
  }
  return surface(c, e)
}
