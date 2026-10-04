/**
 * Procedural billboard sprites for the monsters that have no PNG artwork.
 *
 * Each creature is drawn with canvas 2D paths in a 512-unit design space on a 2x working canvas.
 * Neon strokes also go to a glow layer, which is blurred once with a cheap downsample chain (no
 * per-stroke shadowBlur) and composited behind the body. The result is auto-fitted so the solid
 * silhouette fills ~80% of a 512x512 transparent canvas, then finished with scanlines, a faint RGB
 * fringe and a few glitch slices. A seeded RNG keeps every sprite identical on all clients.
 */

export const PROCEDURAL_MONSTERS = [
  'phase_spider',
  'trojan_goliath',
  'logic_bomb',
  'recursive_worm',
  'mainframe',
  'singularity',
  'rootkit_dragon',
] as const

type Pt = [number, number]
type RGB = [number, number, number]
type Ctx = CanvasRenderingContext2D

interface Kit {
  /** Body layer, supersampled; draw in 512 design units. */
  g: Ctx
  /** Glow layer in design units; blurred and composited behind the body at the end. */
  fx: Ctx
  rnd: () => number
  rgb: RGB
  /** Neon colour as #rrggbb. */
  col: string
  /** White-hot version of the neon colour. */
  hot: string
  /** Neon colour with alpha. */
  a: (alpha: number) => string
}

const OUT = 512
/** Working-canvas supersampling of the body layer. */
const PX = 2
const WORK = OUT * PX
/** Share of the output canvas the solid silhouette spans along its longer side. */
const FILL = 0.8
const TAU = Math.PI * 2
const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]
const EYE_RED: RGB = [255, 38, 30]

const DRAW = new Map<string, (k: Kit) => void>([
  ['phase_spider', phaseSpider],
  ['trojan_goliath', trojanGoliath],
  ['logic_bomb', logicBomb],
  ['recursive_worm', recursiveWorm],
  ['mainframe', mainframe],
  ['singularity', singularity],
  ['rootkit_dragon', rootkitDragon],
])

const cache = new Map<string, HTMLCanvasElement>()

/** Procedural billboard sprite for a monster that has no PNG. Returns null for unknown keys. Cache per key+color. */
export function monsterSprite(key: string, color: string): HTMLCanvasElement | null {
  const draw = DRAW.get(key)
  if (!draw) return null
  const id = `${key}|${color}`
  let c = cache.get(id)
  if (!c) {
    c = render(key, color, draw)
    cache.set(id, c)
  }
  return c
}

// --- Pipeline ----------------------------------------------------------------------------------

function render(key: string, color: string, draw: (k: Kit) => void) {
  const [work, wg] = makeCanvas(WORK, true)
  prep(wg, PX)
  const [glow, gg] = makeCanvas(OUT)
  prep(gg, 1)
  const k = makeKit(wg, gg, neonize(parseColor(color)), hash(key))
  draw(k)

  const [out, og] = makeCanvas(OUT, true)
  const bb = alphaBounds(wg.getImageData(0, 0, WORK, WORK), 90)
  if (bb) {
    const s = Math.min((OUT * FILL) / bb.w, (OUT * FILL) / bb.h)
    og.imageSmoothingEnabled = true
    og.imageSmoothingQuality = 'high'
    og.setTransform(s, 0, 0, s, OUT / 2 - (bb.x + bb.w / 2) * s, OUT / 2 - (bb.y + bb.h / 2) * s)
    og.drawImage(work, 0, 0)
    // Bloom: progressively blurred copies of the glow layer behind the body, plus a faint bleed on top.
    const soft = blurLevels(glow)
    og.globalCompositeOperation = 'destination-over'
    const weights = [0.55, 0.75, 0.8, 0.6]
    soft.forEach((c, i) => {
      og.globalAlpha = weights[i] ?? 0.5
      og.drawImage(c, 0, 0, WORK, WORK)
    })
    og.globalCompositeOperation = 'lighter'
    og.globalAlpha = 0.16
    og.drawImage(soft[1] ?? soft[0], 0, 0, WORK, WORK)
    og.globalCompositeOperation = 'source-over'
    og.globalAlpha = 1
    og.setTransform(1, 0, 0, 1, 0, 0)
  }
  finishGlitch(out, og, k)
  return out
}

/** Halves the glow layer down to 32px, then scales every level back to 256px in smooth steps. */
function blurLevels(src: HTMLCanvasElement) {
  const levels: HTMLCanvasElement[] = []
  let cur = src
  for (let s = src.width / 2; s >= 32; s /= 2) {
    const [c, g] = makeCanvas(s)
    g.drawImage(cur, 0, 0, s, s)
    levels.push(c)
    cur = c
  }
  return levels.map((c) => {
    let up = c
    while (up.width < 256) {
      const [n, g] = makeCanvas(up.width * 2)
      g.drawImage(up, 0, 0, n.width, n.height)
      up = n
    }
    return up
  })
}

/** Scanlines, an RGB fringe, displaced slices and a little pixel debris. */
function finishGlitch(c: HTMLCanvasElement, g: Ctx, k: Kit) {
  const S = c.width
  const rnd = k.rnd
  const bb = alphaBounds(g.getImageData(0, 0, S, S), 60) ?? { x: 0, y: 0, w: S, h: S }

  // Faint chromatic fringe peeking out behind the silhouette.
  g.save()
  g.globalCompositeOperation = 'destination-over'
  g.globalAlpha = 0.3
  g.drawImage(tintCopy(c, '#ff3df0'), -3, 0)
  g.drawImage(tintCopy(c, '#3df0ff'), 3, 0)
  g.restore()

  // Scanlines only darken what is already there.
  g.save()
  g.globalCompositeOperation = 'source-atop'
  g.fillStyle = 'rgba(0,0,0,0.2)'
  for (let y = 0; y < S; y += 4) g.fillRect(0, y, S, 1.5)
  for (let i = 0; i < 6; i++) {
    g.fillStyle = i % 2 ? k.a(0.16) : 'rgba(255,255,255,0.1)'
    g.fillRect(0, Math.floor(bb.y + rnd() * bb.h), S, 1 + Math.floor(rnd() * 2))
  }
  g.restore()

  // Horizontal glitch slices.
  for (let i = 0; i < 5; i++) {
    const h = 2 + Math.floor(rnd() * 8)
    const y = Math.floor(bb.y + bb.h * (0.1 + rnd() * 0.8))
    const dx = Math.round((rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 12))
    const band = g.getImageData(0, y, S, h)
    g.clearRect(0, y, S, h)
    g.putImageData(band, dx, y)
  }

  // Pixel debris hugging the silhouette.
  const img = g.getImageData(0, 0, S, S).data
  const alphaAt = (x: number, y: number) => (x < 0 || y < 0 || x >= S || y >= S ? 0 : img[(y * S + x) * 4 + 3])
  let placed = 0
  for (let tries = 0; tries < 600 && placed < 16; tries++) {
    const x = Math.floor(bb.x - 14 + rnd() * (bb.w + 28))
    const y = Math.floor(bb.y - 14 + rnd() * (bb.h + 28))
    if (alphaAt(x, y) > 30) continue
    const near = alphaAt(x + 9, y) > 200 || alphaAt(x - 9, y) > 200 || alphaAt(x, y + 9) > 200 || alphaAt(x, y - 9) > 200
    if (!near) continue
    const s = 2 + Math.floor(rnd() * 5)
    g.fillStyle = rnd() < 0.3 ? 'rgba(255,255,255,0.85)' : k.a(0.55 + rnd() * 0.4)
    g.fillRect(x, y, s * (rnd() < 0.5 ? 2 : 1), s)
    placed++
  }
}

// --- Generic helpers -------------------------------------------------------------------------------

function makeCanvas(size: number, readback = false): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return [c, c.getContext('2d', readback ? { willReadFrequently: true } : undefined)!]
}

function prep(g: Ctx, scale: number) {
  g.lineJoin = 'round'
  g.lineCap = 'round'
  g.scale(scale, scale)
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let probe: Ctx | null = null
function parseColor(css: string): RGB {
  probe ??= document.createElement('canvas').getContext('2d')!
  probe.fillStyle = '#010203'
  probe.fillStyle = css
  const v = String(probe.fillStyle)
  if (v === '#010203' && String(css).trim().toLowerCase() !== '#010203') return [92, 242, 255]
  if (v[0] === '#') return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)]
  const m = v.match(/[\d.]+/g)
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [92, 242, 255]
}

/** Lifts very dark colours so outlines still glow. */
function neonize(c: RGB): RGB {
  const m = Math.max(...c)
  if (m < 1) return [200, 214, 230]
  if (m >= 170) return c
  const f = 170 / m
  return c.map((v) => Math.min(255, Math.round(v * f))) as RGB
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const hex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`

function makeKit(g: Ctx, fx: Ctx, rgb: RGB, seed: number): Kit {
  return {
    g,
    fx,
    rnd: mulberry32(seed),
    rgb,
    col: hex(rgb),
    hot: hex(mix(rgb, WHITE, 0.62)),
    a: (alpha) => rgba(rgb, alpha),
  }
}

function alphaBounds(img: ImageData, threshold: number) {
  const { width: W, height: H, data } = img
  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < H; y++) {
    const row = y * W * 4
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4 + 3] < threshold) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function tintCopy(src: HTMLCanvasElement, color: string, amount = 1) {
  const [c, g] = makeCanvas(src.width)
  g.drawImage(src, 0, 0)
  g.globalCompositeOperation = 'source-atop'
  g.globalAlpha = amount
  g.fillStyle = color
  g.fillRect(0, 0, c.width, c.height)
  return c
}

/** Applies the same transform to the body and glow layers for the duration of `draw`. */
function scoped(k: Kit, setup: (c: Ctx) => void, draw: () => void) {
  for (const c of [k.g, k.fx]) {
    c.save()
    setup(c)
  }
  draw()
  k.g.restore()
  k.fx.restore()
}

// --- Path helpers -------------------------------------------------------------------------------------

function poly(pts: Pt[], close = true) {
  const p = new Path2D()
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)))
  if (close) p.closePath()
  return p
}

/** Catmull-Rom spline through the points as a bezier path. */
function smooth(pts: Pt[], closed = true) {
  const n = pts.length
  if (n < 3) return poly(pts, closed)
  const at = (i: number) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))])
  const p = new Path2D()
  p.moveTo(pts[0][0], pts[0][1])
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    p.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    )
  }
  if (closed) p.closePath()
  return p
}

/** Dense samples along a Catmull-Rom spline. */
function spline(pts: Pt[], steps: number): Pt[] {
  const out: Pt[] = []
  const n = pts.length
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(n - 1, i + 2)]
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[n - 1])
  return out
}

function ellipse(x: number, y: number, rx: number, ry: number, rot = 0) {
  const p = new Path2D()
  p.ellipse(x, y, rx, ry, rot, 0, TAU)
  return p
}

const circle = (x: number, y: number, r: number) => ellipse(x, y, r, r)

function rrect(x: number, y: number, w: number, h: number, r: number) {
  const p = new Path2D()
  p.moveTo(x + r, y)
  p.arcTo(x + w, y, x + w, y + h, r)
  p.arcTo(x + w, y + h, x, y + h, r)
  p.arcTo(x, y + h, x, y, r)
  p.arcTo(x, y, x + w, y, r)
  p.closePath()
  return p
}

function taper(a: Pt, b: Pt, wa: number, wb: number) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  return poly([
    [a[0] + (nx * wa) / 2, a[1] + (ny * wa) / 2],
    [b[0] + (nx * wb) / 2, b[1] + (ny * wb) / 2],
    [b[0] - (nx * wb) / 2, b[1] - (ny * wb) / 2],
    [a[0] - (nx * wa) / 2, a[1] - (ny * wa) / 2],
  ])
}

const mirror = (pts: Pt[], cx = 256): Pt[] => pts.map(([x, y]) => [cx * 2 - x, y])
const line2 = (a: Pt, b: Pt) => poly([a, b], false)

function boundsOf(pts: Pt[]) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1] as const
}

// --- Rendering helpers ------------------------------------------------------------------------------

function strokeP(k: Kit, p: Path2D, w: number, style: string | CanvasGradient) {
  k.g.strokeStyle = style
  k.g.lineWidth = w
  k.g.stroke(p)
}

function fillP(k: Kit, p: Path2D, style: string | CanvasGradient) {
  k.g.fillStyle = style
  k.g.fill(p)
}

function glowLine(k: Kit, p: Path2D, w: number, color: string | CanvasGradient, alpha = 0.6) {
  k.fx.globalAlpha = alpha
  k.fx.strokeStyle = color
  k.fx.lineWidth = w
  k.fx.stroke(p)
  k.fx.globalAlpha = 1
}

function glowFill(k: Kit, p: Path2D, color: string, alpha = 0.6) {
  k.fx.globalAlpha = alpha
  k.fx.fillStyle = color
  k.fx.fill(p)
  k.fx.globalAlpha = 1
}

/** Neon tube: crisp coloured stroke with a white-hot core, plus a wide stroke on the glow layer. */
function neon(k: Kit, p: Path2D, w = 3, blur = 12, rgb = k.rgb) {
  const c = hex(rgb)
  strokeP(k, p, w, c)
  strokeP(k, p, Math.max(0.7, w * 0.38), hex(mix(rgb, WHITE, 0.62)))
  glowLine(k, p, w + blur * 0.7, c, 0.6)
}

/** Soft coloured light along the inside of a shape's edge (rim light). */
function innerGlow(k: Kit, p: Path2D, w: number, alpha = 0.35, rgb = k.rgb) {
  const g = k.g
  g.save()
  g.clip(p)
  for (const [m, a] of [
    [2, 0.25],
    [1.2, 0.45],
    [0.5, 0.8],
  ]) {
    g.strokeStyle = rgba(rgb, alpha * a)
    g.lineWidth = w * m
    g.stroke(p)
  }
  g.restore()
}

function metalStops(k: Kit, gr: CanvasGradient, light: number) {
  gr.addColorStop(0, hex(mix(mix([66, 78, 98], [134, 148, 170], light), k.rgb, 0.1)))
  gr.addColorStop(0.45, hex(mix([27, 34, 46], k.rgb, 0.05)))
  gr.addColorStop(1, '#06080c')
  return gr
}

/** Dark gunmetal gradient lit from the upper left. */
function metal(k: Kit, x0: number, y0: number, x1: number, y1: number, light = 0) {
  return metalStops(k, k.g.createLinearGradient(x0, y0, x1, y1), light)
}

function radialMetal(k: Kit, x: number, y: number, r: number, light = 0) {
  return metalStops(k, k.g.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.05, x, y, r * 1.08), light)
}

/** Filled armour plate with rim light and neon outline. */
function plate(k: Kit, pts: Pt[], opts: { light?: number; line?: number; rim?: number; smoothed?: boolean } = {}) {
  const p = opts.smoothed ? smooth(pts) : poly(pts)
  const [x0, y0, x1, y1] = boundsOf(pts)
  fillP(k, p, metal(k, x0, y0, x1, y1, opts.light ?? 0.25))
  innerGlow(k, p, opts.rim ?? 6, 0.3)
  neon(k, p, opts.line ?? 2.4, 9)
  return p
}

/** Radial glow orb with a white-hot centre. */
function orb(k: Kit, x: number, y: number, r: number, rgb = k.rgb, alpha = 1) {
  const g = k.g
  const gr = g.createRadialGradient(x, y, 0, x, y, r)
  gr.addColorStop(0, `rgba(255,255,255,${alpha})`)
  gr.addColorStop(0.2, rgba(mix(rgb, WHITE, 0.6), alpha))
  gr.addColorStop(0.45, rgba(rgb, 0.85 * alpha))
  gr.addColorStop(1, rgba(rgb, 0))
  g.fillStyle = gr
  g.beginPath()
  g.arc(x, y, r, 0, TAU)
  g.fill()
  glowFill(k, circle(x, y, r * 0.7), hex(rgb), 0.5 * alpha)
}

function joint(k: Kit, p: Pt, r: number) {
  const c = circle(p[0], p[1], r)
  fillP(k, c, radialMetal(k, p[0], p[1], r, 0.4))
  neon(k, c, Math.max(1.2, r * 0.2), 7)
  orb(k, p[0], p[1], r * 0.7)
}

/** Tapered limb segment with tube shading and neon edges. */
function limb(k: Kit, a: Pt, b: Pt, wa: number, wb: number, line = 2) {
  const p = taper(a, b, wa, wb)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const w = Math.max(wa, wb) / 2
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  // Light the side that faces up.
  const s = ny < 0 ? 1 : -1
  const gr = k.g.createLinearGradient(mx + nx * w * s, my + ny * w * s, mx - nx * w * s, my - ny * w * s)
  gr.addColorStop(0, hex(mix([92, 106, 130], k.rgb, 0.16)))
  gr.addColorStop(0.4, '#1c2330')
  gr.addColorStop(1, '#05060a')
  fillP(k, p, gr)
  neon(k, p, line, 8)
}

/** Short orthogonal circuit traces with pads inside a rectangle. */
function traces(k: Kit, x0: number, y0: number, x1: number, y1: number, n: number, alpha = 0.45, w = 1.4) {
  const g = k.g
  g.save()
  g.strokeStyle = k.a(alpha)
  g.fillStyle = k.a(Math.min(1, alpha + 0.25))
  g.lineWidth = w
  for (let i = 0; i < n; i++) {
    let x = x0 + k.rnd() * (x1 - x0)
    let y = y0 + k.rnd() * (y1 - y0)
    g.beginPath()
    g.moveTo(x, y)
    for (let s = 0; s < 3; s++) {
      if (s % 2 === 0) x += (k.rnd() - 0.5) * (x1 - x0) * 0.5
      else y += (k.rnd() - 0.5) * (y1 - y0) * 0.5
      g.lineTo(x, y)
    }
    g.stroke()
    g.fillRect(x - w * 1.5, y - w * 1.5, w * 3, w * 3)
  }
  g.restore()
}

function spark(k: Kit, x: number, y: number, r: number, rays = 12) {
  orb(k, x, y, r * 1.5, k.rgb, 0.55)
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * TAU + k.rnd() * 0.4
    const l = r * (0.6 + k.rnd() * 0.9)
    const ray = line2([x + Math.cos(a) * r * 0.25, y + Math.sin(a) * r * 0.25], [x + Math.cos(a) * l, y + Math.sin(a) * l])
    const w = 1.2 + k.rnd() * 1.6
    strokeP(k, ray, w, i % 3 ? k.hot : '#ffffff')
    glowLine(k, ray, w + 5, k.col, 0.7)
  }
  for (let i = 0; i < 9; i++) {
    const a = k.rnd() * TAU
    const d = r * (1.1 + k.rnd() * 1.1)
    fillP(k, rrect(x + Math.cos(a) * d, y + Math.sin(a) * d, 2.4, 2.4, 0.5), k.rnd() < 0.5 ? '#ffffff' : k.hot)
  }
  orb(k, x, y, r * 0.75)
}

// --- Phase Spider ------------------------------------------------------------------------------------

interface Leg {
  hip: Pt
  knee: Pt
  ankle: Pt
  tip: Pt
}

function phaseSpider(k: Kit) {
  drawSpider(k)
  // Phasing afterimages: sliced, tinted copies offset to the sides, behind the real body.
  const [snap, sg] = makeCanvas(WORK)
  sg.drawImage(k.g.canvas, 0, 0)
  const ghost = tintCopy(snap, k.col, 0.8)
  const g = k.g
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'destination-over'
  const echoes: [number, number, number][] = [
    [-30, -4, 0.3],
    [30, -4, 0.3],
    [-60, -8, 0.14],
    [60, -8, 0.14],
  ]
  for (const [dx, dy, alpha] of echoes) slicedDraw(g, ghost, dx * PX, dy * PX, alpha, k.rnd)
  g.restore()
}

/** Draws a copy in horizontal bands with jitter, like a signal phasing in and out. */
function slicedDraw(g: Ctx, src: HTMLCanvasElement, dx: number, dy: number, alpha: number, rnd: () => number) {
  const W = src.width
  for (let y = 0; y < W; ) {
    const h = Math.min(W - y, 8 + Math.floor(rnd() * 44))
    if (rnd() > 0.15) {
      g.globalAlpha = alpha * (0.55 + rnd() * 0.45)
      g.drawImage(src, 0, y, W, h, dx + (rnd() - 0.5) * 28, y + dy, W, h)
    }
    y += h
  }
  g.globalAlpha = 1
}

function drawSpider(k: Kit) {
  const legs: Leg[] = [
    { hip: [218, 236], knee: [132, 112], ankle: [62, 166], tip: [34, 266] },
    { hip: [214, 252], knee: [106, 148], ankle: [48, 250], tip: [40, 354] },
    { hip: [214, 268], knee: [122, 198], ankle: [82, 322], tip: [82, 424] },
    { hip: [224, 284], knee: [166, 240], ankle: [138, 352], tip: [156, 450] },
  ]
  const flip = (l: Leg): Leg => {
    const [hip, knee, ankle, tip] = mirror([l.hip, l.knee, l.ankle, l.tip])
    return { hip, knee, ankle, tip }
  }
  for (const l of legs.slice(0, 2)) {
    spiderLeg(k, l)
    spiderLeg(k, flip(l))
  }
  spiderAbdomen(k)
  for (const l of legs.slice(2)) {
    spiderLeg(k, l)
    spiderLeg(k, flip(l))
  }
  spiderHead(k)
}

function spiderLeg(k: Kit, l: Leg) {
  limb(k, l.hip, l.knee, 24, 17, 2.4)
  limb(k, l.knee, l.ankle, 17, 12, 2.2)
  limb(k, l.ankle, l.tip, 12, 2, 2)
  joint(k, l.knee, 11)
  joint(k, l.ankle, 8)
  orb(k, l.tip[0], l.tip[1], 10)
}

function spiderAbdomen(k: Kit) {
  const g = k.g
  const cx = 256
  const cy = 190
  const p = ellipse(cx, cy, 96, 80)
  fillP(k, p, radialMetal(k, cx, cy, 96, 0.35))
  g.save()
  g.clip(p)
  for (let i = 0; i < 4; i++) {
    const band = new Path2D()
    band.ellipse(cx, cy - 150 + i * 40, 160, 124, 0, 0.16 * Math.PI, 0.84 * Math.PI)
    strokeP(k, band, 6, 'rgba(0,0,0,0.6)')
    strokeP(k, band, 1.4, k.a(0.4))
  }
  traces(k, cx - 80, cy - 60, cx + 80, cy + 60, 7, 0.35)
  g.restore()
  innerGlow(k, p, 12, 0.4)
  neon(k, p, 3.6, 14)
  // Glowing hourglass rune.
  const top = poly([
    [cx - 22, cy - 44],
    [cx + 22, cy - 44],
    [cx, cy - 6],
  ])
  const bottom = poly([
    [cx, cy + 6],
    [cx + 22, cy + 44],
    [cx - 22, cy + 44],
  ])
  for (const r of [top, bottom]) {
    fillP(k, r, k.a(0.3))
    neon(k, r, 2.6, 12)
  }
  orb(k, cx, cy - 22, 13)
  orb(k, cx, cy + 22, 13)
}

function spiderHead(k: Kit) {
  const cx = 256
  const cy = 270
  for (const s of [-1, 1]) {
    plate(k, [
      [cx + s * 6, cy + 26],
      [cx + s * 34, cy + 24],
      [cx + s * 36, cy + 50],
      [cx + s * 20, cy + 60],
      [cx + s * 6, cy + 52],
    ], { smoothed: true, line: 2 })
    const fang = smooth([
      [cx + s * 32, cy + 50],
      [cx + s * 30, cy + 74],
      [cx + s * 18, cy + 96],
      [cx + s * 16, cy + 70],
      [cx + s * 12, cy + 54],
    ])
    fillP(k, fang, metal(k, cx, cy + 50, cx, cy + 96, 0.5))
    neon(k, fang, 2.2, 8)
    orb(k, cx + s * 18, cy + 92, 7)
  }
  const head = ellipse(cx, cy, 66, 50)
  fillP(k, head, radialMetal(k, cx, cy, 66, 0.4))
  innerGlow(k, head, 10, 0.35)
  const seam = new Path2D()
  seam.moveTo(cx, cy - 48)
  seam.lineTo(cx, cy - 30)
  seam.moveTo(cx - 40, cy + 20)
  seam.quadraticCurveTo(cx, cy + 40, cx + 40, cy + 20)
  strokeP(k, seam, 4, 'rgba(0,0,0,0.6)')
  strokeP(k, seam, 1.2, k.a(0.45))
  neon(k, head, 3.2, 12)
  const eyes: [number, number, number][] = [
    [cx - 19, cy - 4, 12],
    [cx + 19, cy - 4, 12],
    [cx - 36, cy - 19, 7],
    [cx + 36, cy - 19, 7],
    [cx - 11, cy - 26, 5.5],
    [cx + 11, cy - 26, 5.5],
    [cx - 44, cy + 3, 5],
    [cx + 44, cy + 3, 5],
  ]
  for (const [x, y, r] of eyes) {
    fillP(k, circle(x, y, r + 2.5), '#020306')
    orb(k, x, y, r * 2.2)
    fillP(k, circle(x, y, r * 0.5), '#ffffff')
  }
}

// --- Trojan Goliath ----------------------------------------------------------------------------------

function trojanGoliath(k: Kit) {
  // The body is shrunk around the feet so the big horse head reads clearly above it.
  const body = (c: Ctx) => {
    c.translate(256, 490)
    c.scale(0.88, 0.88)
    c.translate(-256, -472)
  }
  scoped(k, body, () => trojanBody(k))
  scoped(k, (c) => {
    c.translate(206, 92)
    c.scale(1.15, 1.15)
  }, () => trojanHead(k))
  scoped(k, body, () => trojanShield(k))
}

function trojanBody(k: Kit) {
  const g = k.g
  const thigh: Pt[] = [
    [186, 318],
    [240, 318],
    [234, 380],
    [194, 380],
  ]
  const shin: Pt[] = [
    [190, 394],
    [238, 394],
    [252, 444],
    [178, 444],
  ]
  const foot: Pt[] = [
    [162, 442],
    [262, 442],
    [272, 472],
    [152, 472],
  ]
  for (const side of [false, true]) {
    const f = (pts: Pt[]) => (side ? mirror(pts) : pts)
    plate(k, f(thigh))
    plate(k, f(shin), { light: 0.35 })
    plate(k, f(foot), { light: 0.2 })
    joint(k, [side ? 512 - 214 : 214, 386], 19)
    for (let i = 0; i < 3; i++) {
      const x = side ? 512 - (176 + i * 30) : 176 + i * 30
      fillP(k, rrect(x - 3, 462, 6, 4, 1), k.a(0.9))
    }
  }
  plate(k, [
    [166, 294],
    [346, 294],
    [360, 344],
    [306, 354],
    [256, 342],
    [206, 354],
    [152, 344],
  ])
  // Right arm (viewer's right) with a heavy gauntlet.
  plate(k, [
    [350, 220],
    [394, 214],
    [404, 292],
    [358, 296],
  ])
  joint(k, [382, 298], 17)
  const gauntlet = plate(k, [
    [346, 304],
    [412, 298],
    [428, 368],
    [404, 400],
    [356, 396],
    [342, 352],
  ], { light: 0.35 })
  g.save()
  g.clip(gauntlet)
  for (let i = 0; i < 3; i++) {
    const slit = poly([
      [362 + i * 18, 322],
      [372 + i * 18, 322],
      [376 + i * 18, 360],
      [366 + i * 18, 360],
    ])
    fillP(k, slit, '#020305')
    fillP(k, slit, k.a(0.6))
  }
  g.restore()
  for (let i = 0; i < 4; i++)
    plate(k, [
      [356 + i * 13, 392],
      [367 + i * 13, 392],
      [367 + i * 13, 408],
      [356 + i * 13, 408],
    ], { line: 1.4, rim: 2 })
  const torso = plate(k, [
    [158, 158],
    [354, 158],
    [378, 226],
    [358, 304],
    [154, 304],
    [134, 226],
  ], { light: 0.3, rim: 10 })
  g.save()
  g.clip(torso)
  const chest = new Path2D()
  chest.moveTo(256, 160)
  chest.lineTo(256, 302)
  for (let y = 196; y < 300; y += 26) {
    chest.moveTo(150, y)
    chest.lineTo(362, y)
  }
  strokeP(k, chest, 4, 'rgba(0,0,0,0.55)')
  strokeP(k, chest, 1.2, k.a(0.35))
  g.restore()
  fillP(k, circle(322, 236, 24), '#030406')
  neon(k, circle(322, 236, 24), 3, 12)
  orb(k, 322, 236, 30)
  const pauldron: Pt[] = [
    [88, 182],
    [138, 142],
    [204, 148],
    [218, 194],
    [182, 238],
    [102, 236],
  ]
  plate(k, pauldron, { light: 0.45, rim: 8 })
  plate(k, mirror(pauldron), { light: 0.45, rim: 8 })
}

function trojanShield(k: Kit) {
  const g = k.g
  const shieldPts: Pt[] = [
    [94, 190],
    [196, 174],
    [294, 188],
    [304, 318],
    [262, 404],
    [196, 458],
    [132, 404],
    [88, 318],
  ]
  const shield = plate(k, shieldPts, { light: 0.4, rim: 12, line: 3.6 })
  g.save()
  g.clip(shield)
  const planks = new Path2D()
  for (let x = 120; x < 300; x += 30) {
    planks.moveTo(x, 170)
    planks.lineTo(x, 460)
  }
  strokeP(k, planks, 3, 'rgba(0,0,0,0.45)')
  strokeP(k, planks, 1, k.a(0.2))
  g.restore()
  const inner = shieldPts.map(([x, y]): Pt => [196 + (x - 196) * 0.86, 312 + (y - 312) * 0.86])
  neon(k, poly(inner), 2, 10)
  for (const [x, y] of inner) {
    fillP(k, circle(x, y, 4.5), '#0a0d12')
    neon(k, circle(x, y, 4.5), 1.2, 5)
  }
  // Trojan horse emblem.
  const emblem: Pt[] = [
    [24, 44],
    [-24, 44],
    [-20, 30],
    [-6, 14],
    [-24, 8],
    [-40, 4],
    [-44, -8],
    [-30, -22],
    [-10, -36],
    [-2, -54],
    [6, -42],
    [18, -36],
    [28, -16],
    [30, 10],
  ]
  const e = poly(emblem.map(([x, y]): Pt => [196 + x * 1.15, 304 + y * 1.15]))
  fillP(k, e, k.a(0.25))
  neon(k, e, 3, 14)
  orb(k, 196 - 12, 304 - 26, 7)
  plate(k, [
    [78, 270],
    [100, 262],
    [108, 300],
    [84, 306],
  ], { line: 1.8, rim: 3 })
}

/** Horse head and neck in profile facing the viewer's left, in local units around the poll. */
function trojanHead(k: Kit) {
  const g = k.g
  // Mane of blade fins along the back of the neck.
  for (let i = 0; i < 7; i++) {
    const t = i / 6
    const bx = 30 + t * 50
    const by = -12 + t * 120
    const fin = poly([
      [bx - 6, by - 4],
      [bx + 30 - t * 6, by - 18 + t * 4],
      [bx + 4, by + 14],
    ])
    fillP(k, fin, metal(k, bx, by - 18, bx + 30, by + 14, 0.35))
    neon(k, fin, 1.8, 8)
    orb(k, bx + 29 - t * 6, by - 17 + t * 4, 5.5)
  }
  const head = plate(k, [
    [14, -26],
    [8, -56],
    [-6, -26],
    [-30, -14],
    [-58, 6],
    [-84, 28],
    [-104, 46],
    [-116, 64],
    [-110, 80],
    [-92, 86],
    [-62, 78],
    [-30, 72],
    [-4, 62],
    [12, 74],
    [26, 100],
    [32, 128],
    [86, 128],
    [80, 82],
    [62, 32],
    [38, -6],
    [24, -22],
  ], { light: 0.5, rim: 9, line: 3, smoothed: true })
  g.save()
  g.clip(head)
  const seams = new Path2D()
  seams.moveTo(-26, -6)
  seams.quadraticCurveTo(-60, 20, -96, 52)
  seams.moveTo(-82, 34)
  seams.quadraticCurveTo(-72, 62, -80, 84)
  seams.moveTo(-6, 30)
  seams.quadraticCurveTo(18, 60, 4, 66)
  for (let i = 0; i < 3; i++) {
    seams.moveTo(20 + i * 4, 82 + i * 16)
    seams.lineTo(74 + i * 3, 70 + i * 18)
  }
  strokeP(k, seams, 4, 'rgba(0,0,0,0.55)')
  strokeP(k, seams, 1.3, k.a(0.45))
  g.restore()
  const cheek = circle(-8, 40, 22)
  fillP(k, cheek, radialMetal(k, -8, 40, 22, 0.55))
  neon(k, cheek, 2, 8)
  orb(k, -8, 40, 9)
  neon(k, poly([
    [-10, 38],
    [-50, 30],
    [-90, 48],
  ], false), 1.6, 8)
  neon(k, line2([-94, 50], [-84, 72]), 1.6, 8)
  const eye = poly([
    [-42, 6],
    [-18, -6],
    [-14, 2],
    [-36, 12],
  ])
  fillP(k, eye, '#020305')
  orb(k, -28, 3, 22)
  fillP(k, eye, k.hot)
  orb(k, -104, 62, 8)
  neon(k, line2([8, -48], [4, -30]), 1.6, 6)
}

// --- Logic Bomb --------------------------------------------------------------------------------------

const SEVEN: Record<string, number> = {
  '0': 0b1111110,
  '1': 0b0110000,
  '2': 0b1101101,
  '3': 0b1111001,
  '4': 0b0110011,
  '5': 0b1011011,
  '6': 0b1011111,
  '7': 0b1110000,
  '8': 0b1111111,
  '9': 0b1111011,
}

function segBar(x1: number, y1: number, x2: number, y2: number, t: number) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  const nx = -uy
  const ny = ux
  const gap = t * 0.55
  const ax = x1 + ux * gap
  const ay = y1 + uy * gap
  const bx = x2 - ux * gap
  const by = y2 - uy * gap
  const h = t / 2
  return poly([
    [ax, ay],
    [ax + ux * h + nx * h, ay + uy * h + ny * h],
    [bx - ux * h + nx * h, by - uy * h + ny * h],
    [bx, by],
    [bx - ux * h - nx * h, by - uy * h - ny * h],
    [ax + ux * h - nx * h, ay + uy * h - ny * h],
  ])
}

function sevenSeg(k: Kit, ch: string, x: number, y: number, w: number, h: number) {
  const t = w * 0.24
  const m = SEVEN[ch] ?? 0
  const hh = h / 2
  const segs: [number, number, number, number][] = [
    [x, y, x + w, y],
    [x + w, y, x + w, y + hh],
    [x + w, y + hh, x + w, y + h],
    [x, y + h, x + w, y + h],
    [x, y + hh, x, y + h],
    [x, y, x, y + hh],
    [x, y + hh, x + w, y + hh],
  ]
  segs.forEach(([x1, y1, x2, y2], i) => {
    const p = segBar(x1, y1, x2, y2, t)
    if ((m >> (6 - i)) & 1) {
      fillP(k, p, k.col)
      glowFill(k, p, k.col, 0.9)
      fillP(k, segBar(x1, y1, x2, y2, t * 0.4), k.hot)
    } else fillP(k, p, k.a(0.08))
  })
}

function logicBomb(k: Kit) {
  const g = k.g
  const cx = 256
  const cy = 296
  const R = 150
  const sphere = circle(cx, cy, R)
  fillP(k, sphere, radialMetal(k, cx, cy, R, 0.35))
  g.save()
  g.clip(sphere)
  const seams = new Path2D()
  seams.ellipse(cx, cy + 6, R, R * 0.3, 0, 0, TAU)
  seams.moveTo(cx + R * 0.4, cy - R)
  seams.ellipse(cx, cy, R * 0.4, R, 0, -Math.PI / 2, Math.PI / 2)
  seams.moveTo(cx - R * 0.4, cy - R)
  seams.ellipse(cx, cy, R * 0.4, R, 0, -Math.PI / 2, Math.PI / 2, true)
  strokeP(k, seams, 7, 'rgba(0,0,0,0.6)')
  strokeP(k, seams, 1.5, k.a(0.35))
  traces(k, cx - 120, cy + 60, cx + 120, cy + 130, 6, 0.4)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU
    fillP(k, circle(cx + Math.cos(a) * R * 0.86, cy + 6 + Math.sin(a) * R * 0.26, 3.2), '#3a4658')
  }
  g.restore()
  innerGlow(k, sphere, 18, 0.45)
  neon(k, sphere, 4.4, 18)
  const glint = g.createRadialGradient(cx - 62, cy - 84, 2, cx - 62, cy - 84, 46)
  glint.addColorStop(0, 'rgba(255,255,255,0.5)')
  glint.addColorStop(1, 'rgba(255,255,255,0)')
  fillP(k, ellipse(cx - 62, cy - 84, 46, 26, -0.6), glint)
  // Countdown display.
  const dx = cx - 96
  const dy = cy - 34
  const bezel = rrect(dx - 8, dy - 8, 208, 92, 14)
  fillP(k, bezel, metal(k, dx, dy - 8, dx, dy + 84, 0.5))
  neon(k, bezel, 2, 8)
  const glass = rrect(dx, dy, 192, 76, 9)
  fillP(k, glass, '#040203')
  fillP(k, glass, k.a(0.08))
  let x = dx + 20
  for (const ch of ['0', '0', ':', '0', '3']) {
    if (ch === ':') {
      for (const yy of [dy + 26, dy + 50]) {
        const dot = rrect(x + 2, yy - 4, 8, 8, 2)
        fillP(k, dot, k.hot)
        glowFill(k, dot, k.col, 0.9)
      }
      x += 18
      continue
    }
    const at = x
    scoped(k, (c) => {
      c.translate(at, dy + 14)
      c.transform(1, 0, -0.1, 1, 0, 0)
    }, () => sevenSeg(k, ch, 2, 0, 26, 48))
    x += 40
  }
  g.save()
  g.clip(glass)
  const shine = g.createLinearGradient(dx, dy, dx + 70, dy + 76)
  shine.addColorStop(0, 'rgba(255,255,255,0.14)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  fillP(k, poly([
    [dx, dy],
    [dx + 90, dy],
    [dx + 30, dy + 76],
    [dx, dy + 76],
  ]), shine)
  g.restore()
  for (let i = 0; i < 5; i++) orb(k, cx - 40 + i * 20, dy - 24, i === 2 ? 9 : 6, i === 2 ? WHITE : k.rgb)
  for (const s of [-1, 1]) {
    const wire = smooth([
      [cx + s * 104, cy + 10],
      [cx + s * 128, cy + 40],
      [cx + s * 118, cy + 96],
      [cx + s * 70, cy + 120],
    ], false)
    strokeP(k, wire, 9, '#06080c')
    neon(k, wire, 3, 8)
  }
  // Cap and fuse.
  const cap = plate(k, [
    [cx - 44, cy - R - 26],
    [cx + 44, cy - R - 26],
    [cx + 50, cy - R + 14],
    [cx - 50, cy - R + 14],
  ], { light: 0.5 })
  g.save()
  g.clip(cap)
  for (let i = 0; i < 3; i++) strokeP(k, line2([cx - 60, cy - R - 14 + i * 9], [cx + 60, cy - R - 14 + i * 9]), 2, 'rgba(0,0,0,0.6)')
  g.restore()
  const tipX = cx + 96
  const tipY = cy - R - 112
  const fuse = new Path2D()
  fuse.moveTo(cx, cy - R - 24)
  fuse.bezierCurveTo(cx + 4, cy - R - 84, cx + 70, cy - R - 58, tipX, tipY)
  strokeP(k, fuse, 13, '#05070a')
  g.save()
  g.setLineDash([5, 5])
  strokeP(k, fuse, 9, k.a(0.55))
  g.restore()
  neon(k, fuse, 2, 6)
  spark(k, tipX, tipY, 30, 14)
}

// --- Recursive Worm ---------------------------------------------------------------------------------

interface Seg {
  x: number
  y: number
  r: number
  rot: number
}

function recursiveWorm(k: Kit) {
  // The body arcs up behind the head and curls back over it; each segment is a smaller copy of the head.
  const raw: Seg[] = []
  let x = 0
  let y = 0
  let r = 100
  let dir = -0.2
  for (let i = 0; i < 11 && r > 8; i++) {
    raw.push({ x, y, r, rot: i * 0.55 })
    const nr = r * 0.8
    const d = (r + nr) * 0.72
    dir -= 0.44
    x += Math.cos(dir) * d
    y += Math.sin(dir) * d
    r = nr
  }
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const s of raw) {
    x0 = Math.min(x0, s.x - s.r)
    y0 = Math.min(y0, s.y - s.r)
    x1 = Math.max(x1, s.x + s.r)
    y1 = Math.max(y1, s.y + s.r)
  }
  const sc = Math.min(420 / (x1 - x0), 420 / (y1 - y0))
  const segs = raw.map((s) => ({
    x: 256 + (s.x - (x0 + x1) / 2) * sc,
    y: 256 + (s.y - (y0 + y1) / 2) * sc,
    r: s.r * sc,
    rot: s.rot,
  }))
  // Spine cable linking the segments.
  const spine = smooth(segs.map((s): Pt => [s.x, s.y]), false)
  strokeP(k, spine, segs[0].r * 0.42, '#0b0f16')
  neon(k, spine, 2.6, 10)
  // Tail spike.
  const last = segs[segs.length - 1]
  const prev = segs[segs.length - 2]
  const ang = Math.atan2(last.y - prev.y, last.x - prev.x)
  const tip: Pt = [last.x + Math.cos(ang) * last.r * 3.2, last.y + Math.sin(ang) * last.r * 3.2]
  const spike = poly([
    [last.x + Math.cos(ang + 1.4) * last.r, last.y + Math.sin(ang + 1.4) * last.r],
    tip,
    [last.x + Math.cos(ang - 1.4) * last.r, last.y + Math.sin(ang - 1.4) * last.r],
  ])
  fillP(k, spike, metal(k, last.x, last.y, tip[0], tip[1], 0.4))
  neon(k, spike, 1.8, 8)
  for (let i = segs.length - 1; i >= 0; i--) wormSegment(k, segs[i], 2, i === 0)
}

function wormSegment(k: Kit, s: Seg, depth: number, head: boolean) {
  const g = k.g
  const { x, y, r, rot } = s
  const line = Math.max(0.8, r * 0.035)
  if (head) {
    for (const side of [-1, 1]) {
      const a = Math.PI / 2 + side * 0.72
      const tipA = a + side * 0.5
      const mandible = smooth([
        [x + Math.cos(a - 0.22) * r * 0.92, y + Math.sin(a - 0.22) * r * 0.92],
        [x + Math.cos(tipA) * r * 1.32, y + Math.sin(tipA) * r * 1.32],
        [x + Math.cos(tipA + side * 0.42) * r * 1.42, y + Math.sin(tipA + side * 0.42) * r * 1.42],
        [x + Math.cos(a + 0.22) * r * 0.92, y + Math.sin(a + 0.22) * r * 0.92],
      ])
      const bx = x + Math.cos(a) * r
      const by = y + Math.sin(a) * r
      fillP(k, mandible, metal(k, bx - r * 0.4, by - r * 0.4, bx + r * 0.4, by + r * 0.4, 0.5))
      neon(k, mandible, 2.4, 10)
    }
  }
  const shell = circle(x, y, r)
  fillP(k, shell, radialMetal(k, x, y, r, 0.35))
  g.save()
  g.clip(shell)
  for (let i = 0; i < 6; i++) {
    const a = rot + (i / 6) * TAU
    const cut = line2([x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7], [x + Math.cos(a) * r * 1.05, y + Math.sin(a) * r * 1.05])
    strokeP(k, cut, Math.max(1, r * 0.06), 'rgba(0,0,0,0.7)')
    strokeP(k, cut, Math.max(0.5, r * 0.016), k.a(0.45))
  }
  g.restore()
  innerGlow(k, shell, r * 0.14, 0.35)
  // Maw ringed with teeth.
  const maw = circle(x, y, r * 0.66)
  fillP(k, maw, '#020306')
  orb(k, x, y, r * 0.64, k.rgb, 0.3)
  const n = 10
  for (let i = 0; i < n; i++) {
    const a = rot + ((i + 0.5) / n) * TAU
    const ha = (TAU / n) * 0.3
    const tooth = poly([
      [x + Math.cos(a - ha) * r * 0.65, y + Math.sin(a - ha) * r * 0.65],
      [x + Math.cos(a + ha) * r * 0.65, y + Math.sin(a + ha) * r * 0.65],
      [x + Math.cos(a) * r * 0.42, y + Math.sin(a) * r * 0.42],
    ])
    fillP(k, tooth, hex(mix([86, 100, 120], k.rgb, 0.22)))
    strokeP(k, tooth, Math.max(0.5, r * 0.012), k.a(0.9))
  }
  neon(k, maw, line, r * 0.12)
  // The core holds a smaller copy of the whole segment.
  if (depth > 0 && r > 18) wormSegment(k, { x, y, r: r * 0.36, rot: rot + 0.4 }, depth - 1, false)
  else orb(k, x, y, r * 0.38)
  const eyes = head ? [-0.6, -0.22, 0.22, 0.6] : [-0.34, 0.34]
  for (const e of eyes) {
    const a = -Math.PI / 2 + e
    const ex = x + Math.cos(a) * r * 0.84
    const ey = y + Math.sin(a) * r * 0.84
    const er = r * 0.09
    fillP(k, circle(ex, ey, er * 1.35), '#020306')
    orb(k, ex, ey, er * 2.4)
    fillP(k, circle(ex, ey, er * 0.55), '#ffffff')
  }
  neon(k, shell, line * 1.25, r * 0.12)
}

// --- The Mainframe -------------------------------------------------------------------------------------

function cable(k: Kit, pts: Pt[], end: 'plug' | 'spark' | 'none', w = 10) {
  const p = smooth(pts, false)
  strokeP(k, p, w + 4, 'rgba(0,0,0,0.85)')
  strokeP(k, p, w, '#1b2330')
  strokeP(k, p, w * 0.24, k.a(0.6))
  glowLine(k, p, w * 0.8, k.col, 0.25)
  const a = pts[pts.length - 1]
  const b = pts[pts.length - 2]
  const ang = Math.atan2(a[1] - b[1], a[0] - b[0])
  if (end === 'plug') {
    scoped(k, (c) => {
      c.translate(a[0], a[1])
      c.rotate(ang)
    }, () => {
      const body = rrect(-8, -w * 0.8, 22, w * 1.6, 3)
      fillP(k, body, metal(k, 0, -w, 0, w, 0.5))
      neon(k, body, 1.6, 6)
      for (const yy of [-w * 0.4, w * 0.4]) strokeP(k, line2([14, yy], [22, yy]), 2.4, k.hot)
    })
    orb(k, a[0] + Math.cos(ang) * 20, a[1] + Math.sin(ang) * 20, 10)
  } else if (end === 'spark') {
    scoped(k, (c) => {
      c.translate(a[0], a[1])
      c.rotate(ang)
    }, () => {
      for (const t of [-0.5, 0, 0.5]) strokeP(k, line2([0, 0], [12, t * 14]), 1.6, k.hot)
    })
    spark(k, a[0] + Math.cos(ang) * 14, a[1] + Math.sin(ang) * 14, 16, 9)
  }
}

function mainframe(k: Kit) {
  const g = k.g
  const top = 52
  const bot = 404
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const xl = (y: number) => lerp(180, 150, (y - top) / (bot - top))
  const xr = (y: number) => lerp(332, 362, (y - top) / (bot - top))
  // Cables hanging from the back like tentacles.
  cable(k, [[330, 110], [404, 96], [452, 170], [440, 260], [458, 318]], 'plug', 14)
  cable(k, [[182, 100], [110, 92], [62, 160], [74, 252], [52, 300]], 'spark', 14)
  cable(k, [[340, 230], [420, 236], [444, 330], [418, 392]], 'plug', 12)
  const side = poly([
    [332, top],
    [366, top + 14],
    [394, bot - 12],
    [362, bot],
  ])
  fillP(k, side, metal(k, 332, top, 394, bot, 0))
  fillP(k, side, 'rgba(0,0,0,0.35)')
  neon(k, side, 2, 8)
  g.save()
  g.clip(side)
  for (let y = top + 30; y < bot; y += 22) strokeP(k, line2([330, y], [400, y + 8]), 1.2, k.a(0.3))
  g.restore()
  const front = plate(k, [
    [180, top],
    [332, top],
    [362, bot],
    [150, bot],
  ], { light: 0.2, rim: 10, line: 3.2 })
  // Rack units.
  g.save()
  g.clip(front)
  let y = top + 12
  let row = 0
  while (y < bot - 18) {
    const h = [14, 14, 22, 30, 14, 22][Math.floor(k.rnd() * 6)]
    if (y > 96 && y < 246) {
      y = 246
      continue
    }
    const l = xl(y + h / 2) + 12
    const r = xr(y + h / 2) - 12
    const unit = rrect(l, y, r - l, h, 2)
    fillP(k, unit, '#06090d')
    strokeP(k, unit, 1, 'rgba(160,190,220,0.18)')
    const leds = 3 + Math.floor(k.rnd() * 4)
    for (let i = 0; i < leds; i++) {
      const on = k.rnd() > 0.25
      const c = k.rnd() < 0.15 ? WHITE : k.rgb
      const led = rrect(l + 6 + i * 9, y + h / 2 - 2, 5, 4, 1)
      fillP(k, led, on ? hex(mix(c, WHITE, 0.3)) : 'rgba(80,90,100,0.4)')
      if (on) glowFill(k, led, hex(c), 0.9)
    }
    const vents = new Path2D()
    for (let vx = l + 70 + (row % 2) * 4; vx < r - 22; vx += 7) {
      vents.moveTo(vx, y + 3)
      vents.lineTo(vx, y + h - 3)
    }
    strokeP(k, vents, 2, 'rgba(0,0,0,0.8)')
    strokeP(k, vents, 0.6, 'rgba(150,180,210,0.25)')
    fillP(k, rrect(r - 16, y + 3, 9, h - 6, 2), k.a(0.3))
    y += h + 4
    row++
  }
  g.restore()
  // The single red eye.
  const ex = 256
  const ey = 170
  const bezel = circle(ex, ey, 62)
  fillP(k, bezel, radialMetal(k, ex, ey, 62, 0.6))
  neon(k, bezel, 3, 12)
  fillP(k, circle(ex, ey, 50), '#050102')
  glowFill(k, circle(ex, ey, 46), hex(EYE_RED), 1)
  const iris = g.createRadialGradient(ex, ey, 0, ex, ey, 42)
  iris.addColorStop(0, '#fff4ee')
  iris.addColorStop(0.12, '#ffc2b0')
  iris.addColorStop(0.3, '#ff3a26')
  iris.addColorStop(0.65, '#a00806')
  iris.addColorStop(0.9, '#360000')
  iris.addColorStop(1, '#120000')
  fillP(k, circle(ex, ey, 42), iris)
  for (const rr of [30, 36]) strokeP(k, circle(ex, ey, rr), 1, 'rgba(255,90,70,0.35)')
  orb(k, ex, ey, 20, EYE_RED)
  fillP(k, ellipse(ex - 16, ey - 18, 10, 5, -0.6), 'rgba(255,255,255,0.55)')
  neon(k, circle(ex, ey, 50), 2.4, 16, EYE_RED)
  // Heat-sink crown and antenna.
  for (let i = 0; i < 9; i++) {
    const fx = 190 + i * 16
    plate(k, [
      [fx, top - 26 + (i % 2) * 6],
      [fx + 9, top - 26 + (i % 2) * 6],
      [fx + 9, top + 2],
      [fx, top + 2],
    ], { line: 1.3, rim: 2, light: 0.5 })
  }
  neon(k, line2([318, top - 4], [326, top - 44]), 2.4, 8)
  orb(k, 326, top - 46, 9, WHITE)
  const plinth = plate(k, [
    [138, bot - 4],
    [400, bot - 14],
    [408, bot + 18],
    [132, bot + 24],
  ], { light: 0.15 })
  g.save()
  g.clip(plinth)
  for (let i = 0; i < 9; i++) fillP(k, rrect(162 + i * 26, bot + 4, 16, 6, 2), k.a(0.8))
  g.restore()
  // Cables spilling from the front ports.
  cable(k, [[178, 392], [160, 430], [120, 422], [96, 466]], 'plug', 13)
  cable(k, [[214, 398], [210, 444], [232, 470], [214, 492]], 'spark', 11)
  cable(k, [[318, 396], [336, 452], [372, 438], [392, 484]], 'plug', 13)
}

// --- Singularity Anomaly ----------------------------------------------------------------------------

function singularity(k: Kit) {
  const g = k.g
  const cx = 256
  const cy = 256
  const rh = 96
  const tilt = -0.16
  const rx = 226
  const flat = 0.27
  const rin = rh * 1.3
  const cosT = Math.cos(tilt)
  const sinT = Math.sin(tilt)
  const place = (lx: number, ly: number): Pt => [cx + lx * cosT - ly * sinT, cy + lx * sinT + ly * cosT]
  const halo = g.createRadialGradient(cx, cy, rh, cx, cy, rh * 2.4)
  halo.addColorStop(0, k.a(0.32))
  halo.addColorStop(1, k.a(0))
  fillP(k, circle(cx, cy, rh * 2.4), halo)
  // Warped light streaks spiralling inwards.
  for (let i = 0; i < 18; i++) {
    const r0 = rh * (1.45 + k.rnd() * 1.05)
    const a0 = k.rnd() * TAU
    const sweep = 0.7 + k.rnd() * 1.5
    const w = 1.4 + k.rnd() * 2.6
    const color = k.rnd() < 0.35 ? WHITE : k.rgb
    const steps = 20
    const pt = (t: number) => {
      const a = a0 + sweep * t
      const rr = r0 * (1 - 0.2 * t)
      return place(Math.cos(a) * rr, Math.sin(a) * rr * 0.78)
    }
    for (let s = 0; s < steps; s++) {
      const t1 = (s + 1) / steps
      const seg = line2(pt(s / steps), pt(t1))
      strokeP(k, seg, w * (0.4 + t1 * 0.6), rgba(color, 0.15 + t1 * 0.8))
      glowLine(k, seg, w * 3, hex(color), 0.35 * t1)
    }
  }
  // Accretion disk: far half, then the hole, then the near half on top.
  const diskHalf = (front: boolean) =>
    scoped(k, (c) => {
      c.translate(cx, cy)
      c.rotate(tilt)
    }, () => {
      const bright = g.createLinearGradient(-rx, 0, rx, 0)
      bright.addColorStop(0, '#ffffff')
      bright.addColorStop(0.35, k.hot)
      bright.addColorStop(1, k.col)
      const bands = 18
      for (let i = 0; i < bands; i++) {
        const t = i / (bands - 1)
        const r = rin + (rx - rin) * t
        const p = new Path2D()
        p.ellipse(0, 0, r, r * flat, 0, front ? 0 : Math.PI, front ? Math.PI : TAU)
        g.globalAlpha = (1 - t) * 0.85 + 0.12
        strokeP(k, p, ((rx - rin) / bands) * 1.25, i < 3 ? '#ffffff' : bright)
        g.globalAlpha = 1
        if (i % 3 === 0) glowLine(k, p, 10, k.col, 0.45 * (1 - t))
      }
    })
  diskHalf(false)
  // Lensed image of the far disk bent over the top of the hole.
  const lens = new Path2D()
  lens.ellipse(cx, cy, rh * 1.2, rh * 1.12, tilt, Math.PI * 1.04, Math.PI * 1.96)
  strokeP(k, lens, 12, k.a(0.85))
  strokeP(k, lens, 4, '#ffffff')
  glowLine(k, lens, 26, k.col, 0.8)
  const lower = new Path2D()
  lower.ellipse(cx, cy, rh * 1.08, rh * 1.05, tilt, Math.PI * 0.1, Math.PI * 0.9)
  strokeP(k, lower, 3, k.a(0.8))
  glowLine(k, lower, 10, k.col, 0.5)
  // Event horizon.
  const dark = g.createRadialGradient(cx, cy, rh * 0.6, cx, cy, rh)
  dark.addColorStop(0, '#000000')
  dark.addColorStop(0.92, '#020106')
  dark.addColorStop(1, hex(mix(k.rgb, BLACK, 0.8)))
  fillP(k, circle(cx, cy, rh), dark)
  strokeP(k, circle(cx, cy, rh + 2), 2.6, '#ffffff')
  glowLine(k, circle(cx, cy, rh + 2), 12, '#ffffff', 0.6)
  neon(k, circle(cx, cy, rh + 5), 2, 12)
  diskHalf(true)
  // Matter being spaghettified on the way in.
  for (let i = 0; i < 28; i++) {
    const a = k.rnd() * TAU
    const rr = rh * (1.3 + k.rnd() * 1.4)
    const [px, py] = place(Math.cos(a) * rr, Math.sin(a) * rr * 0.6)
    g.save()
    g.translate(px, py)
    g.rotate(a + Math.PI / 2 + tilt)
    fillP(k, rrect(-6 - k.rnd() * 8, -1.4, 14 + k.rnd() * 10, 2.8, 1.4), k.rnd() < 0.4 ? '#ffffff' : k.a(0.9))
    g.restore()
  }
}

// --- Rootkit Dragon ------------------------------------------------------------------------------------

const CODE = ['0x7F', 'root', 'sudo', '{ }', '</>', '01101', '#!', '&&', 'rm -rf', '0xDEAD', ';;', 'su', '1001', 'jmp', 'ff', '%x']

interface Wing {
  s: Pt
  e: Pt
  w: Pt
  tips: Pt[]
  anchor: Pt
}

function rootkitDragon(k: Kit) {
  const g = k.g
  const wing: Wing = {
    s: [236, 196],
    e: [164, 116],
    w: [98, 50],
    tips: [
      [26, 40],
      [16, 140],
      [44, 226],
      [118, 270],
    ],
    anchor: [214, 262],
  }
  dragonWing(k, wing)
  dragonWing(k, {
    s: mirror([wing.s])[0],
    e: mirror([wing.e])[0],
    w: mirror([wing.w])[0],
    tips: mirror(wing.tips),
    anchor: mirror([wing.anchor])[0],
  })
  // Serpentine body.
  const ctrl: Pt[] = [
    [248, 124],
    [272, 166],
    [262, 218],
    [230, 270],
    [242, 326],
    [298, 354],
    [332, 404],
    [302, 452],
    [232, 464],
    [176, 438],
    [156, 396],
    [178, 362],
  ]
  const spine = spline(ctrl, 14)
  const n = spine.length
  const width = (t: number) => {
    if (t < 0.1) return 30 + t * 160
    if (t < 0.3) return 46 + Math.sin(((t - 0.1) / 0.2) * Math.PI) * 6
    return 46 * Math.pow(1 - (t - 0.3) / 0.7, 0.85) + 3
  }
  const L: Pt[] = []
  const R: Pt[] = []
  const N: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = spine[Math.max(0, i - 1)]
    const b = spine[Math.min(n - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / len
    const ny = (b[0] - a[0]) / len
    const w = width(i / (n - 1)) / 2
    N.push([nx, ny])
    L.push([spine[i][0] + nx * w, spine[i][1] + ny * w])
    R.push([spine[i][0] - nx * w, spine[i][1] - ny * w])
  }
  // Dorsal spikes on the outer (convex) side of each bend.
  for (let i = 8; i < n * 0.88; i += 6) {
    const w = width(i / (n - 1))
    const a = spine[i - 4]
    const b = spine[i]
    const c = spine[Math.min(n - 1, i + 4)]
    const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    const side = turn > 0 ? -1 : 1
    const edge = side > 0 ? L : R
    const [nx, ny] = N[i]
    const tip: Pt = [edge[i][0] + side * nx * (w * 0.5 + 8), edge[i][1] + side * ny * (w * 0.5 + 8)]
    const spike = poly([edge[Math.max(0, i - 2)], tip, edge[Math.min(n - 1, i + 2)]])
    fillP(k, spike, metal(k, edge[i][0], edge[i][1], tip[0], tip[1], 0.5))
    neon(k, spike, 1.8, 8)
  }
  const body = poly([...L, ...R.slice().reverse()])
  fillP(k, body, metal(k, 150, 110, 340, 470, 0.35))
  g.save()
  g.clip(body)
  for (let i = 2; i < n - 2; i += 4) {
    const plateLine = line2(L[i], R[i])
    strokeP(k, plateLine, 3.2, 'rgba(0,0,0,0.6)')
    strokeP(k, plateLine, 1, k.a(0.35))
  }
  g.restore()
  innerGlow(k, body, 9, 0.38)
  neon(k, body, 2.8, 12)
  // Circuit trace down the spine with branching pads.
  const trace = poly(spine.slice(4, n - 6), false)
  g.save()
  g.setLineDash([10, 4, 2, 4])
  neon(k, trace, 1.8, 8)
  g.restore()
  for (let i = 8; i < n - 8; i += 9) {
    const [px, py] = spine[i]
    const w = width(i / (n - 1)) * 0.36
    const [nx, ny] = N[i]
    strokeP(k, line2([px, py], [px - nx * w, py - ny * w]), 1.4, k.a(0.8))
    fillP(k, rrect(px - nx * w - 2.4, py - ny * w - 2.4, 4.8, 4.8, 1), k.hot)
    fillP(k, rrect(px - 3, py - 3, 6, 6, 1), k.hot)
  }
  // Tail blade.
  const tA = spine[n - 3]
  const tB = spine[n - 1]
  const ta = Math.atan2(tB[1] - tA[1], tB[0] - tA[0])
  const blade = poly([
    [tB[0] + Math.cos(ta + 1.6) * 8, tB[1] + Math.sin(ta + 1.6) * 8],
    [tB[0] + Math.cos(ta + 0.25) * 36, tB[1] + Math.sin(ta + 0.25) * 36],
    [tB[0] + Math.cos(ta) * 24, tB[1] + Math.sin(ta) * 24],
    [tB[0] + Math.cos(ta - 0.5) * 32, tB[1] + Math.sin(ta - 0.5) * 32],
    [tB[0] + Math.cos(ta - 1.6) * 8, tB[1] + Math.sin(ta - 1.6) * 8],
  ])
  fillP(k, blade, metal(k, tB[0] - 20, tB[1] - 20, tB[0] + 20, tB[1] + 20, 0.5))
  neon(k, blade, 2, 10)
  dragonHead(k, spine[0], 0.32)
  // Floating code fragments.
  for (const c of [g, k.fx]) {
    c.textAlign = 'center'
    c.textBaseline = 'middle'
  }
  for (let i = 0; i < 18; i++) {
    const txt = CODE[Math.floor(k.rnd() * CODE.length)]
    const side = i % 2 ? 1 : -1
    const fx = 256 + side * (60 + k.rnd() * 170)
    const fy = 70 + k.rnd() * 340
    const font = `bold ${9 + Math.floor(k.rnd() * 7)}px monospace`
    g.font = font
    g.fillStyle = k.rnd() < 0.3 ? k.hot : k.a(0.45 + k.rnd() * 0.45)
    g.fillText(txt, fx, fy)
    k.fx.font = font
    k.fx.fillStyle = k.col
    k.fx.fillText(txt, fx, fy)
  }
}

function dragonWing(k: Kit, w: Wing) {
  const g = k.g
  const p = new Path2D()
  p.moveTo(w.s[0], w.s[1])
  p.lineTo(w.e[0], w.e[1])
  p.lineTo(w.w[0], w.w[1])
  p.lineTo(w.tips[0][0], w.tips[0][1])
  const edge: Pt[] = [...w.tips, w.anchor]
  for (let i = 1; i < edge.length; i++) {
    const a = edge[i - 1]
    const b = edge[i]
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    p.quadraticCurveTo(mx + (w.w[0] - mx) * 0.22, my + (w.w[1] - my) * 0.22, b[0], b[1])
  }
  p.closePath()
  const mem = g.createRadialGradient(w.w[0], w.w[1], 10, w.w[0], w.w[1], 260)
  mem.addColorStop(0, '#182030')
  mem.addColorStop(1, '#070a10')
  fillP(k, p, mem)
  g.save()
  g.clip(p)
  // Hex mesh membrane.
  const hexR = 13
  const hw = Math.sqrt(3) * hexR
  const mesh = new Path2D()
  for (let row = -1; row < 40; row++)
    for (let col = -1; col < 40; col++) {
      const hx = col * hw + (row % 2 ? hw / 2 : 0)
      const hy = row * hexR * 1.5
      for (let s = 0; s < 6; s++) {
        const a = Math.PI / 6 + (s * TAU) / 6
        if (s === 0) mesh.moveTo(hx + Math.cos(a) * hexR, hy + Math.sin(a) * hexR)
        else mesh.lineTo(hx + Math.cos(a) * hexR, hy + Math.sin(a) * hexR)
      }
      mesh.closePath()
    }
  strokeP(k, mesh, 1, k.a(0.18))
  g.restore()
  innerGlow(k, p, 14, 0.35)
  neon(k, p, 1.8, 10)
  limb(k, w.s, w.e, 17, 12, 2.2)
  limb(k, w.e, w.w, 12, 9, 2)
  for (const t of w.tips) limb(k, w.w, t, 8, 2, 1.8)
  joint(k, w.e, 9)
  joint(k, w.w, 8)
  const dir = w.w[0] < 256 ? 1 : -1
  const claw = poly([
    [w.w[0] - 2, w.w[1] - 6],
    [w.w[0] + dir * 16, w.w[1] - 26],
    [w.w[0] + dir * 6, w.w[1] - 2],
  ])
  fillP(k, claw, k.hot)
  neon(k, claw, 1.2, 6)
}

function dragonHead(k: Kit, at: Pt, tilt: number) {
  scoped(k, (c) => {
    c.translate(at[0], at[1])
    // Face the viewer's left: mirror, scale up, then tilt the snout down a little.
    c.scale(-1.25, 1.25)
    c.rotate(tilt)
    c.translate(-8, -6)
  }, () => {
    const horns: Pt[][] = [
      [
        [18, -18],
        [-8, -46],
        [-30, -60],
        [-6, -40],
        [6, -14],
      ],
      [
        [34, -22],
        [18, -60],
        [6, -76],
        [26, -56],
        [44, -22],
      ],
    ]
    for (const h of horns) {
      const p = smooth(h)
      fillP(k, p, metal(k, -30, -76, 44, -14, 0.5))
      neon(k, p, 1.8, 8)
    }
    const jaw = poly([
      [8, 10],
      [40, 16],
      [74, 26],
      [96, 34],
      [98, 40],
      [70, 40],
      [36, 32],
      [6, 24],
    ])
    fillP(k, jaw, metal(k, 0, 10, 98, 40, 0.3))
    neon(k, jaw, 2, 8)
    const mouth = poly([
      [30, 8],
      [96, 6],
      [96, 32],
      [36, 18],
    ])
    fillP(k, mouth, '#030204')
    orb(k, 40, 14, 30, k.rgb, 0.8)
    const skull = poly([
      [-6, -12],
      [10, -24],
      [40, -28],
      [64, -22],
      [88, -16],
      [108, -10],
      [112, -2],
      [102, 4],
      [64, 6],
      [36, 8],
      [14, 14],
      [-6, 14],
    ])
    fillP(k, skull, metal(k, -6, -28, 112, 14, 0.5))
    innerGlow(k, skull, 6, 0.35)
    neon(k, skull, 2.4, 10)
    for (let i = 0; i < 6; i++) {
      const tx = 44 + i * 10
      fillP(k, poly([
        [tx, 5],
        [tx + 6, 5],
        [tx + 3, 13],
      ]), k.hot)
      fillP(k, poly([
        [tx + 2, 30 + i * 1.2],
        [tx + 8, 31 + i * 1.2],
        [tx + 4, 22 + i * 1.2],
      ]), k.hot)
    }
    const plates = new Path2D()
    plates.moveTo(18, -20)
    plates.lineTo(30, 4)
    plates.moveTo(72, -18)
    plates.lineTo(84, 2)
    strokeP(k, plates, 3, 'rgba(0,0,0,0.55)')
    strokeP(k, plates, 1, k.a(0.45))
    const eye = poly([
      [40, -16],
      [66, -20],
      [62, -11],
      [44, -9],
    ])
    fillP(k, eye, '#020305')
    orb(k, 54, -14, 18)
    fillP(k, eye, k.hot)
    orb(k, 104, -6, 6)
  })
  // Code spilling from the jaws.
  const g = k.g
  for (const c of [g, k.fx]) {
    c.textAlign = 'center'
    c.textBaseline = 'middle'
  }
  ;['1', '0', '{', '1', '}', '0', '#'].forEach((ch, i) => {
    const font = `bold ${17 - i * 1.4}px monospace`
    const x = at[0] - 128 - i * 14
    const y = at[1] + 40 + i * 11
    g.font = font
    g.fillStyle = i < 2 ? '#ffffff' : k.a(0.9 - i * 0.1)
    g.fillText(ch, x, y)
    k.fx.font = font
    k.fx.fillStyle = k.col
    k.fx.fillText(ch, x, y)
  })
}
