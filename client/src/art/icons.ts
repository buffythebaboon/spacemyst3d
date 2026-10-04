/**
 * Procedural 64x64 HUD/UI icons as PNG data URLs.
 *
 * Every icon shares one frame (dark rounded square, thin tinted border, soft backdrop glow) and one
 * bold neon pictogram drawn with Path2D. Pictograms use a solid gradient fill with a glow, dark "cut"
 * lines for details and thin neon tubes for line art, so they stay readable down to ~40px.
 */

type RGB = [number, number, number]
type Ctx = CanvasRenderingContext2D

interface Pen {
  g: Ctx
  rgb: RGB
  /** Accent colour. */
  c: string
  /** White-hot accent. */
  hot: string
  /** Darker accent for shading. */
  deep: string
}

type Draw = (p: Pen) => void

const N = 64
const TAU = Math.PI * 2
/** Frame interior colour, also used for engraved detail lines. */
const INK = '#07101a'
/** 1x1 transparent PNG, returned if a canvas is unavailable. */
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const C = {
  cyan: '#5cf2ff',
  magenta: '#ff4fd8',
  green: '#7dff9a',
  amber: '#ffb347',
  orange: '#ff7a3c',
  red: '#ff3b5c',
  violet: '#b48cff',
  purple: '#c77dff',
  blue: '#4fa8ff',
  ice: '#9feaff',
  gold: '#ffd34d',
  white: '#dce9f5',
}

/** Talent trees: hacker, soldier, engineer. */
const TREE = { hk: C.magenta, sd: C.red, en: C.amber }

const RARITY = ['#c8d2dc', '#5cff7a', '#4fa8ff', '#c77dff', '#ffa63c']
const ARMOR = ['#c8d2dc', '#5cff7a', '#4fa8ff', '#c77dff', '#ffa63c', '#ff3b5c', '#b9a2ff']

const cache = new Map<string, string>()

/** 64x64 PNG data URL for a HUD/UI icon, cached by key. Unknown keys return a generic glyph icon; never throw. */
export function icon(key: string): string {
  const id = String(key)
  const hit = cache.get(id)
  if (hit) return hit
  let url = BLANK
  try {
    const spec = ICONS.get(id)
    url = spec ? paint(spec[0], spec[1], spec[2]) : paint(generic(id), genericGlyph)
  } catch {
    url = BLANK
  }
  cache.set(id, url)
  return url
}

/** Potion bottle tinted with a CSS colour. unknown=true adds a small '?' rune (unidentified potion). Cached. */
export function potionIcon(css: string, opts?: { unknown?: boolean }): string {
  const unknown = !!opts?.unknown
  const id = `potion|${css}|${unknown}`
  const hit = cache.get(id)
  if (hit) return hit
  let url = BLANK
  try {
    url = paint(hex(parseCss(css)), (p) => potion(p, unknown))
  } catch {
    url = BLANK
  }
  cache.set(id, url)
  return url
}

/** Rarity colours: 0 common #c8d2dc, 1 uncommon #5cff7a, 2 rare #4fa8ff, 3 epic #c77dff, 4 legendary #ffa63c */
export function rarityColor(rarity: number): string {
  const i = Number.isFinite(rarity) ? Math.max(0, Math.min(4, Math.round(rarity))) : 0
  return RARITY[i]
}

// --- Painting ----------------------------------------------------------------------------------------

function paint(color: string, draw: Draw, talent = false) {
  const c = document.createElement('canvas')
  c.width = c.height = N
  const g = c.getContext('2d')
  if (!g) return BLANK
  const rgb = parseHex(color)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  frame(g, rgb, talent)
  draw({ g, rgb, c: color, hot: hex(mix(rgb, [255, 255, 255], 0.6)), deep: hex(mix(rgb, [0, 0, 0], 0.25)) })
  return c.toDataURL('image/png')
}

function frame(g: Ctx, rgb: RGB, talent: boolean) {
  const body = rrect(2, 2, 60, 60, 12)
  const bg = g.createLinearGradient(0, 2, 0, 62)
  bg.addColorStop(0, '#142233')
  bg.addColorStop(1, '#060a10')
  g.fillStyle = bg
  g.fill(body)
  g.save()
  g.clip(body)
  const glow = g.createRadialGradient(32, 34, 2, 32, 34, 30)
  glow.addColorStop(0, rgba(rgb, 0.24))
  glow.addColorStop(1, rgba(rgb, 0))
  g.fillStyle = glow
  g.fillRect(0, 0, N, N)
  g.fillStyle = 'rgba(255,255,255,0.025)'
  for (let y = 3; y < 62; y += 3) g.fillRect(2, y, 60, 1)
  g.restore()
  g.lineWidth = 1.5
  g.strokeStyle = rgba(rgb, 0.6)
  g.stroke(rrect(2.75, 2.75, 58.5, 58.5, 11.5))
  g.lineWidth = 1
  g.strokeStyle = talent ? rgba(rgb, 0.35) : 'rgba(255,255,255,0.07)'
  g.stroke(rrect(5.5, 5.5, 53, 53, 9))
  // Corner ticks.
  g.strokeStyle = rgba(mix(rgb, [255, 255, 255], 0.4), 0.9)
  g.lineWidth = 1.5
  g.stroke(pline(3, 15, 3, 3, 15, 3))
  g.stroke(pline(49, 61, 61, 61, 61, 49))
}

// --- Colour helpers ------------------------------------------------------------------------------

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const hex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`

function parseHex(h: string): RGB {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

let probe: Ctx | null = null
function parseCss(css: string): RGB {
  probe ??= document.createElement('canvas').getContext('2d')
  if (!probe) return [92, 242, 255]
  probe.fillStyle = '#010203'
  probe.fillStyle = String(css)
  const v = String(probe.fillStyle)
  if (v === '#010203' && String(css).trim().toLowerCase() !== '#010203') return [92, 242, 255]
  if (v[0] === '#') return parseHex(v)
  const m = v.match(/[\d.]+/g)
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [92, 242, 255]
}

function generic(key: string) {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  const pool = [C.cyan, C.magenta, C.green, C.amber, C.violet, C.blue]
  return pool[h % pool.length]
}

// --- Path helpers ----------------------------------------------------------------------------------

function poly(...n: number[]) {
  const p = new Path2D()
  for (let i = 0; i < n.length; i += 2) i ? p.lineTo(n[i], n[i + 1]) : p.moveTo(n[i], n[i + 1])
  p.closePath()
  return p
}

function pline(...n: number[]) {
  const p = new Path2D()
  for (let i = 0; i < n.length; i += 2) i ? p.lineTo(n[i], n[i + 1]) : p.moveTo(n[i], n[i + 1])
  return p
}

function circ(x: number, y: number, r: number) {
  const p = new Path2D()
  p.arc(x, y, r, 0, TAU)
  return p
}

function ell(x: number, y: number, rx: number, ry: number, rot = 0) {
  const p = new Path2D()
  p.ellipse(x, y, rx, ry, rot, 0, TAU)
  return p
}

function arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) {
  const p = new Path2D()
  p.arc(x, y, r, a0, a1, ccw)
  return p
}

function rrect(x: number, y: number, w: number, h: number, r: number) {
  const p = new Path2D()
  r = Math.min(r, w / 2, h / 2)
  p.moveTo(x + r, y)
  p.arcTo(x + w, y, x + w, y + h, r)
  p.arcTo(x + w, y + h, x, y + h, r)
  p.arcTo(x, y + h, x, y, r)
  p.arcTo(x, y, x + w, y, r)
  p.closePath()
  return p
}

/** Combines paths into one (for a single fill or stroke). */
function join(...paths: Path2D[]) {
  const p = new Path2D()
  for (const q of paths) p.addPath(q)
  return p
}

/** Path transformed by translate/rotate/scale around an origin. */
function moved(path: Path2D, x: number, y: number, rot = 0, s = 1) {
  const p = new Path2D()
  p.addPath(path, new DOMMatrix().translate(x, y).rotate((rot * 180) / Math.PI).scale(s))
  return p
}

function star(x: number, y: number, ro: number, ri: number, n: number, rot = -Math.PI / 2) {
  const pts: number[] = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro
    const a = rot + (i * Math.PI) / n
    pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r)
  }
  return poly(...pts)
}

function regular(x: number, y: number, r: number, n: number, rot = -Math.PI / 2) {
  const pts: number[] = []
  for (let i = 0; i < n; i++) pts.push(x + Math.cos(rot + (i * TAU) / n) * r, y + Math.sin(rot + (i * TAU) / n) * r)
  return poly(...pts)
}

// --- Rendering primitives ----------------------------------------------------------------------------

/** Solid glowing glyph with a light-to-accent gradient. */
function solid(p: Pen, path: Path2D, rule: CanvasFillRule = 'nonzero', glow = 7) {
  const g = p.g
  g.save()
  const gr = g.createLinearGradient(0, 10, 0, 54)
  gr.addColorStop(0, p.hot)
  gr.addColorStop(0.5, p.c)
  gr.addColorStop(1, p.deep)
  g.shadowColor = rgba(p.rgb, 0.85)
  g.shadowBlur = glow
  g.fillStyle = gr
  g.fill(path, rule)
  g.restore()
}

/** Neon tube: accent stroke with glow and a white-hot core. */
function tube(p: Pen, path: Path2D, w = 3.2, alpha = 1) {
  const g = p.g
  g.save()
  g.globalAlpha = alpha
  g.shadowColor = p.c
  g.shadowBlur = 7
  g.strokeStyle = p.c
  g.lineWidth = w
  g.stroke(path)
  g.shadowBlur = 0
  g.strokeStyle = p.hot
  g.lineWidth = Math.max(0.9, w * 0.4)
  g.stroke(path)
  g.restore()
}

/** Engraved dark detail line. */
function cut(p: Pen, path: Path2D, w = 2) {
  p.g.strokeStyle = INK
  p.g.lineWidth = w
  p.g.stroke(path)
}

function ink(p: Pen, path: Path2D, rule: CanvasFillRule = 'nonzero') {
  p.g.fillStyle = INK
  p.g.fill(path, rule)
}

/** White-hot fill with a small glow. */
function hotFill(p: Pen, path: Path2D, color = '#ffffff') {
  const g = p.g
  g.save()
  g.shadowColor = p.c
  g.shadowBlur = 6
  g.fillStyle = color
  g.fill(path)
  g.restore()
}

/** Pen with another accent, for multi-coloured icons. */
function withColor(p: Pen, color: string): Pen {
  const rgb = parseHex(color)
  return { g: p.g, rgb, c: color, hot: hex(mix(rgb, [255, 255, 255], 0.6)), deep: hex(mix(rgb, [0, 0, 0], 0.25)) }
}

function scoped(p: Pen, x: number, y: number, rot: number, s: number, draw: () => void) {
  p.g.save()
  p.g.translate(x, y)
  p.g.rotate(rot)
  p.g.scale(s, s)
  draw()
  p.g.restore()
}

// --- Shared shapes -------------------------------------------------------------------------------------

/** Lightning bolt centred on (x, y), ~40px tall at s=1. */
const bolt = (x: number, y: number, s = 1) => moved(poly(4, -20, -10, 3, -1, 3, -5, 20, 10, -4, 1, -4, 8, -20), x, y, 0, s)

function heart(x: number, y: number, s: number) {
  const p = new Path2D()
  p.moveTo(x, y + 16 * s)
  p.bezierCurveTo(x - 4 * s, y + 12 * s, x - 20 * s, y + 2 * s, x - 20 * s, y - 7 * s)
  p.bezierCurveTo(x - 20 * s, y - 15 * s, x - 13 * s, y - 19 * s, x - 8 * s, y - 19 * s)
  p.bezierCurveTo(x - 3 * s, y - 19 * s, x, y - 15 * s, x, y - 12 * s)
  p.bezierCurveTo(x, y - 15 * s, x + 3 * s, y - 19 * s, x + 8 * s, y - 19 * s)
  p.bezierCurveTo(x + 13 * s, y - 19 * s, x + 20 * s, y - 15 * s, x + 20 * s, y - 7 * s)
  p.bezierCurveTo(x + 20 * s, y + 2 * s, x + 4 * s, y + 12 * s, x, y + 16 * s)
  p.closePath()
  return p
}

function drop(x: number, y: number, s: number) {
  const p = new Path2D()
  p.moveTo(x, y - 20 * s)
  p.bezierCurveTo(x + 4 * s, y - 10 * s, x + 14 * s, y - 2 * s, x + 14 * s, y + 7 * s)
  p.bezierCurveTo(x + 14 * s, y + 15 * s, x + 8 * s, y + 21 * s, x, y + 21 * s)
  p.bezierCurveTo(x - 8 * s, y + 21 * s, x - 14 * s, y + 15 * s, x - 14 * s, y + 7 * s)
  p.bezierCurveTo(x - 14 * s, y - 2 * s, x - 4 * s, y - 10 * s, x, y - 20 * s)
  p.closePath()
  return p
}

function shield(x: number, y: number, w: number, h: number) {
  const p = new Path2D()
  p.moveTo(x, y - h / 2)
  p.quadraticCurveTo(x + w * 0.28, y - h / 2 + h * 0.1, x + w / 2, y - h / 2 + h * 0.08)
  p.lineTo(x + w / 2, y - h * 0.02)
  p.quadraticCurveTo(x + w / 2, y + h * 0.32, x, y + h / 2)
  p.quadraticCurveTo(x - w / 2, y + h * 0.32, x - w / 2, y - h * 0.02)
  p.lineTo(x - w / 2, y - h / 2 + h * 0.08)
  p.quadraticCurveTo(x - w * 0.28, y - h / 2 + h * 0.1, x, y - h / 2)
  p.closePath()
  return p
}

function flame(x: number, base: number, w: number, h: number) {
  const p = new Path2D()
  p.moveTo(x, base)
  p.bezierCurveTo(x - w * 0.62, base, x - w * 0.58, base - h * 0.45, x - w * 0.2, base - h * 0.7)
  p.bezierCurveTo(x - w * 0.1, base - h * 0.55, x + w * 0.02, base - h * 0.62, x, base - h)
  p.bezierCurveTo(x + w * 0.3, base - h * 0.75, x + w * 0.62, base - h * 0.45, x + w * 0.5, base - h * 0.18)
  p.bezierCurveTo(x + w * 0.45, base - h * 0.05, x + w * 0.25, base, x, base)
  p.closePath()
  return p
}

function eyeShape(x: number, y: number, w: number, h: number) {
  const p = new Path2D()
  p.moveTo(x - w / 2, y)
  p.quadraticCurveTo(x, y - h, x + w / 2, y)
  p.quadraticCurveTo(x, y + h, x - w / 2, y)
  p.closePath()
  return p
}

function skull(x: number, y: number, s: number) {
  const p = new Path2D()
  p.arc(x, y - 3 * s, 15 * s, Math.PI * 0.82, Math.PI * 0.18)
  p.lineTo(x + 9 * s, y + 10 * s)
  p.lineTo(x + 9 * s, y + 16 * s)
  p.lineTo(x - 9 * s, y + 16 * s)
  p.lineTo(x - 9 * s, y + 10 * s)
  p.closePath()
  return p
}

function skullDetails(p: Pen, x: number, y: number, s: number, eyes = INK) {
  p.g.fillStyle = eyes
  p.g.fill(ell(x - 6 * s, y - 1 * s, 4.6 * s, 5.2 * s))
  p.g.fill(ell(x + 6 * s, y - 1 * s, 4.6 * s, 5.2 * s))
  ink(p, poly(x, y + 4 * s, x + 2.4 * s, y + 8 * s, x - 2.4 * s, y + 8 * s))
  const teeth = new Path2D()
  for (const dx of [-4.5, 0, 4.5]) {
    teeth.moveTo(x + dx * s, y + 11 * s)
    teeth.lineTo(x + dx * s, y + 16 * s)
  }
  cut(p, teeth, 1.6 * s)
}

function gear(x: number, y: number, ro: number, ri: number, teeth: number, hole: number) {
  const p = new Path2D()
  const step = TAU / teeth
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    const pts: [number, number][] = [
      [a - step * 0.5, ri],
      [a - step * 0.22, ri],
      [a - step * 0.16, ro],
      [a + step * 0.16, ro],
      [a + step * 0.22, ri],
    ]
    pts.forEach(([aa, r], j) => {
      const px = x + Math.cos(aa) * r
      const py = y + Math.sin(aa) * r
      if (i === 0 && j === 0) p.moveTo(px, py)
      else p.lineTo(px, py)
    })
  }
  p.closePath()
  p.moveTo(x + hole, y)
  p.arc(x, y, hole, 0, TAU, true)
  return p
}

function zGlyph(x: number, y: number, s: number) {
  return pline(x - s, y - s, x + s, y - s, x - s, y + s, x + s, y + s)
}

function qMark(x: number, y: number, s: number) {
  const p = new Path2D()
  p.moveTo(x - 6 * s, y - 6 * s)
  p.bezierCurveTo(x - 6 * s, y - 14 * s, x + 7 * s, y - 14 * s, x + 7 * s, y - 6 * s)
  p.bezierCurveTo(x + 7 * s, y - 1 * s, x, y - 1 * s, x, y + 4 * s)
  return p
}

function chevron(x: number, y: number, w: number, h: number, t: number) {
  return poly(x, y - h / 2, x + t, y - h / 2, x + t + w, y, x + t, y + h / 2, x, y + h / 2, x + w, y)
}

function arrowHead(x: number, y: number, ang: number, s: number) {
  return moved(poly(s, 0, -s * 0.7, -s * 0.8, -s * 0.3, 0, -s * 0.7, s * 0.8), x, y, ang)
}

function sparkle(p: Pen, x: number, y: number, r: number) {
  hotFill(p, star(x, y, r, r * 0.28, 4, 0))
}

function crosshair(p: Pen, r = 16) {
  tube(p, circ(32, 32, r), 3)
  const t = new Path2D()
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    t.moveTo(32 + dx * (r - 6), 32 + dy * (r - 6))
    t.lineTo(32 + dx * (r + 7), 32 + dy * (r + 7))
  }
  tube(p, t, 3)
}

function sonar(p: Pen) {
  solid(p, circ(32, 32, 5))
  tube(p, circ(32, 32, 11), 3)
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    tube(p, arc(32, 32, 18, a - 0.5, a + 0.5), 3)
    tube(p, arc(32, 32, 25, a - Math.PI / 4 - 0.35, a - Math.PI / 4 + 0.35), 2.4, 0.7)
  }
}

function cursor(p: Pen) {
  const arrow = poly(18, 12, 18, 46, 26, 38.5, 32, 51, 38.5, 48, 32.5, 35.5, 43, 35.5)
  solid(p, arrow)
  cut(p, pline(22, 22, 22, 36), 1.6)
  tube(p, arc(40, 22, 6, -Math.PI * 0.85, -Math.PI * 0.15), 2.4)
  tube(p, arc(40, 22, 12, -Math.PI * 0.85, -Math.PI * 0.15), 2.4, 0.75)
}

function daemonHead(p: Pen) {
  solid(p, join(poly(19, 26, 13, 9, 28, 22), poly(45, 26, 51, 9, 36, 22)))
  solid(p, rrect(15, 22, 34, 28, 9))
  ink(p, join(poly(21, 32, 30, 34.5, 29, 39, 21, 36.5), poly(43, 32, 34, 34.5, 35, 39, 43, 36.5)))
  hotFill(p, join(circ(25.5, 35.5, 1.6), circ(38.5, 35.5, 1.6)))
  cut(p, pline(22, 43, 25.6, 46, 29.2, 43, 32.8, 46, 36.4, 43, 40, 46, 42, 44), 2)
}

function honeyPot(p: Pen) {
  const body = new Path2D()
  body.moveTo(22, 22)
  body.bezierCurveTo(10, 26, 10, 52, 32, 53)
  body.bezierCurveTo(54, 52, 54, 26, 42, 22)
  body.closePath()
  solid(p, join(body, rrect(22, 17, 20, 7, 2)))
  solid(p, rrect(17, 12, 30, 7, 3.5))
  const hexes = new Path2D()
  for (const [hx, hy] of [
    [27, 33],
    [37, 33],
    [32, 42],
  ])
    hexes.addPath(regular(hx, hy, 5, 6, 0))
  cut(p, hexes, 1.8)
  solid(p, drop(44, 26, 0.32))
}

function firewall(p: Pen) {
  const fl = withColor(p, C.amber)
  solid(fl, join(flame(20, 34, 12, 20), flame(32, 34, 14, 26), flame(44, 34, 12, 20)))
  hotFill(p, join(flame(20, 34, 5, 9), flame(32, 34, 6, 12), flame(44, 34, 5, 9)), '#fff4d8')
  solid(p, rrect(10, 33, 44, 21, 2))
  const bricks = new Path2D()
  for (const y of [40, 47]) {
    bricks.moveTo(10, y)
    bricks.lineTo(54, y)
  }
  for (const [x, y0, y1] of [
    [21, 33, 40],
    [43, 33, 40],
    [32, 40, 47],
    [21, 47, 54],
    [43, 47, 54],
  ]) {
    bricks.moveTo(x, y0)
    bricks.lineTo(x, y1)
  }
  cut(p, bricks, 1.8)
}

function thermalEye(p: Pen) {
  tube(p, eyeShape(32, 34, 40, 22), 3.2)
  const g = p.g
  const iris = g.createRadialGradient(32, 34, 1, 32, 34, 10)
  iris.addColorStop(0, '#ffffff')
  iris.addColorStop(0.3, '#ffe066')
  iris.addColorStop(0.65, '#ff7a3c')
  iris.addColorStop(1, '#c0204a')
  g.save()
  g.shadowColor = p.c
  g.shadowBlur = 8
  g.fillStyle = iris
  g.fill(circ(32, 34, 9.5))
  g.restore()
  const waves = new Path2D()
  for (const x of [22, 32, 42]) {
    waves.moveTo(x, 20)
    waves.bezierCurveTo(x - 3, 17, x + 3, 15, x, 11)
  }
  tube(p, waves, 2, 0.85)
}

function grenade(p: Pen, emblem: (p: Pen) => void) {
  tube(p, circ(19, 17, 4.6), 2.2)
  solid(p, rrect(24, 15, 13, 8, 2))
  solid(p, poly(35, 16, 45, 19, 47, 42, 42.5, 42, 40.5, 23, 35, 22))
  solid(p, ell(30, 39, 15, 16))
  const grooves = new Path2D()
  grooves.moveTo(16, 34)
  grooves.quadraticCurveTo(30, 37, 44, 34)
  grooves.moveTo(16, 45)
  grooves.quadraticCurveTo(30, 48, 44, 45)
  cut(p, grooves, 1.4)
  emblem(p)
}

function book(p: Pen) {
  solid(p, rrect(16, 10, 33, 45, 4))
  cut(p, pline(22, 11, 22, 54), 2)
  cut(p, pline(46, 50, 25, 50), 1.6)
}

function vest(): Path2D {
  return poly(18, 16, 26, 12.5, 32, 22, 38, 12.5, 46, 16, 50, 30, 46.5, 52, 17.5, 52, 14, 30)
}

function armor(tier: number): Draw {
  return (p) => {
    const g = p.g
    if (tier === 6) {
      const outline = join(poly(9, 19, 7, 8, 16, 13), poly(55, 19, 57, 8, 48, 13), ell(15, 19, 9, 6.75, -0.4), ell(49, 19, 9, 6.75, 0.4), poly(22, 15, 32, 25, 42, 15, 40, 9, 32, 16, 24, 9), vest())
      g.save()
      g.shadowColor = p.c
      g.shadowBlur = 12
      const voidFill = g.createRadialGradient(32, 32, 2, 32, 32, 28)
      voidFill.addColorStop(0, '#34265c')
      voidFill.addColorStop(1, '#0b0716')
      g.fillStyle = voidFill
      g.fill(outline)
      g.restore()
      tube(p, vest(), 2.2)
      tube(p, join(ell(15, 19, 9, 6.75, -0.4), ell(49, 19, 9, 6.75, 0.4)), 1.8)
      g.save()
      g.clip(outline)
      for (const [sx, sy] of [
        [20, 24],
        [44, 22],
        [45, 44],
        [19, 45],
        [27, 49],
        [38, 48],
        [24, 34],
        [41, 33],
        [13, 17],
        [52, 20],
      ])
        hotFill(p, circ(sx, sy, 0.8))
      g.restore()
      ink(p, circ(32, 34, 7.5))
      tube(p, circ(32, 34, 7.5), 2.2)
      tube(p, ell(32, 34, 13, 3, -0.3), 1.4, 0.9)
    } else {
      const torso = vest()
      if (tier >= 2) {
        const pad = tier >= 3 ? 9 : 6.5
        const pads = join(ell(15, 19, pad, pad * 0.75, -0.4), ell(49, 19, pad, pad * 0.75, 0.4))
        if (tier >= 5) {
          solid(p, join(poly(9, 19, 7, 8, 16, 13), poly(55, 19, 57, 8, 48, 13)))
        }
        solid(p, pads)
      }
      if (tier >= 4) solid(p, poly(22, 15, 32, 25, 42, 15, 40, 9, 32, 16, 24, 9))
      solid(p, torso)
      g.save()
      g.clip(torso)
      const d = new Path2D()
      if (tier === 0) {
        for (let i = -40; i < 60; i += 6) {
          d.moveTo(i, 10)
          d.lineTo(i + 44, 54)
          d.moveTo(i + 44, 10)
          d.lineTo(i, 54)
        }
        cut(p, d, 0.9)
      } else {
        d.moveTo(32, 23)
        d.lineTo(32, 52)
        for (const y of tier >= 4 ? [36, 42, 47] : [37, 45]) {
          d.moveTo(15, y)
          d.lineTo(49, y)
        }
        if (tier >= 2) {
          d.moveTo(18, 30)
          d.quadraticCurveTo(25, 34, 32, 30)
          d.quadraticCurveTo(39, 34, 46, 30)
        }
        cut(p, d, 1.6)
      }
      g.restore()
      if (tier >= 3) {
        ink(p, circ(32, 30, 5))
        hotFill(p, circ(32, 30, 3))
      }
      if (tier >= 5) {
        const vents = new Path2D()
        for (const x of [20, 24, 40, 44]) {
          vents.moveTo(x, 39)
          vents.lineTo(x, 48)
        }
        cut(p, vents, 1.5)
      }
    }
    // Tier pips.
    for (let i = 0; i <= tier; i++) hotFill(p, circ(32 - tier * 2.5 + i * 5, 58, 1.2), p.hot)
  }
}

function potion(p: Pen, unknown: boolean) {
  const g = p.g
  const flask = new Path2D()
  flask.moveTo(27, 14)
  flask.lineTo(27, 25)
  flask.bezierCurveTo(16, 28, 13, 38, 15, 44)
  flask.bezierCurveTo(17, 52, 24, 55, 32, 55)
  flask.bezierCurveTo(40, 55, 47, 52, 49, 44)
  flask.bezierCurveTo(51, 38, 48, 28, 37, 25)
  flask.lineTo(37, 14)
  flask.closePath()
  g.save()
  g.fillStyle = 'rgba(200,230,255,0.08)'
  g.fill(flask)
  g.clip(flask)
  const liquid = g.createLinearGradient(0, 30, 0, 56)
  liquid.addColorStop(0, p.hot)
  liquid.addColorStop(0.35, p.c)
  liquid.addColorStop(1, p.deep)
  g.fillStyle = liquid
  g.fillRect(10, 33, 44, 24)
  g.fillStyle = rgba(mix(p.rgb, [255, 255, 255], 0.75), 0.9)
  g.fill(ell(32, 33, 18, 2.4))
  g.fillStyle = 'rgba(255,255,255,0.75)'
  for (const [bx, by, br] of [
    [26, 44, 1.8],
    [35, 40, 1.3],
    [38, 48, 2.2],
    [30, 50, 1.1],
  ])
    g.fill(circ(bx, by, br))
  g.restore()
  g.save()
  g.shadowColor = p.c
  g.shadowBlur = 9
  g.strokeStyle = 'rgba(225,245,255,0.85)'
  g.lineWidth = 2
  g.stroke(flask)
  g.restore()
  g.strokeStyle = 'rgba(255,255,255,0.55)'
  g.lineWidth = 2
  g.stroke(arc(32, 41, 12, Math.PI * 1.05, Math.PI * 1.35))
  // Metal cap with a lit seal.
  const cap = rrect(24.5, 9, 15, 7, 2)
  const capFill = g.createLinearGradient(0, 9, 0, 16)
  capFill.addColorStop(0, '#9fb2c6')
  capFill.addColorStop(1, '#3a4656')
  g.fillStyle = capFill
  g.fill(cap)
  g.fillStyle = p.c
  g.fillRect(27, 15.5, 10, 1.5)
  if (unknown) {
    g.save()
    g.shadowColor = '#000'
    g.shadowBlur = 4
    g.fillStyle = INK
    g.fill(circ(48, 17, 8.5))
    g.restore()
    g.strokeStyle = 'rgba(255,255,255,0.6)'
    g.lineWidth = 1.2
    g.stroke(circ(48, 17, 8.5))
    const q = withColor(p, '#ffffff')
    tube(q, qMark(48, 17.5, 0.62), 2.4)
    hotFill(q, circ(48, 23, 1.4))
  }
}

function genericGlyph(p: Pen) {
  tube(p, regular(32, 32, 20, 6, 0), 3)
  solid(p, poly(32, 20, 42, 32, 32, 44, 22, 32))
  hotFill(p, circ(32, 32, 3))
}

// --- Icon table ---------------------------------------------------------------------------------------

const ICONS = new Map<string, [string, Draw, boolean?]>()
const def = (key: string, color: string, draw: Draw, talent = false) => ICONS.set(key, [color, draw, talent])

// Spells.
def('spell:overload', C.magenta, (p) => {
  const rays = new Path2D()
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8 + Math.PI / 8
    rays.moveTo(32 + Math.cos(a) * 18, 32 + Math.sin(a) * 18)
    rays.lineTo(32 + Math.cos(a) * 25, 32 + Math.sin(a) * 25)
  }
  tube(p, rays, 2.6)
  solid(p, bolt(32, 32, 1.05))
  sparkle(p, 33, 31, 5)
})
def('spell:repair', C.green, (p) => {
  tube(p, arc(32, 32, 23, -0.3, Math.PI * 1.6), 1.6, 0.6)
  solid(p, join(rrect(26, 13, 12, 38, 3), rrect(13, 26, 38, 12, 3)))
  for (const a of [-0.3, Math.PI * 0.75, Math.PI * 1.6]) hotFill(p, circ(32 + Math.cos(a) * 23, 32 + Math.sin(a) * 23, 2.6))
})
def('spell:glitch_step', C.cyan, (p) => {
  const chev = join(pline(16, 16, 30, 32, 16, 48), pline(31, 16, 45, 32, 31, 48))
  const m = withColor(p, C.magenta)
  scoped(p, -3, 0, 0, 1, () => tube(m, chev, 5.5, 0.85))
  scoped(p, 2, 0, 0, 1, () => tube(p, chev, 5.5))
  for (const [x, y, s] of [
    [7, 20, 3],
    [10, 40, 4],
    [50, 22, 3],
    [53, 44, 2.5],
  ])
    hotFill(p, rrect(x, y, s * 1.6, s, 0.5), p.c)
})
def('spell:system_shock', C.blue, (p) => {
  const zz = new Path2D()
  for (let i = 0; i < 6; i++) {
    const a = (i * TAU) / 6 - Math.PI / 2
    const pt = (r: number, o: number) => [32 + Math.cos(a) * r - Math.sin(a) * o, 32 + Math.sin(a) * r + Math.cos(a) * o]
    const pts = [pt(10, 0), pt(15, 3), pt(19, -3), pt(25, 1)]
    zz.moveTo(pts[0][0], pts[0][1])
    for (const [x, y] of pts.slice(1)) zz.lineTo(x, y)
  }
  tube(p, zz, 3.2)
  solid(p, circ(32, 32, 8))
  hotFill(p, circ(32, 32, 3.5))
})
def('spell:lullaby', C.violet, (p) => {
  solid(p, join(ell(21, 45, 6.5, 5, -0.4), ell(41, 41, 6.5, 5, -0.4)))
  solid(p, join(rrect(25, 17, 3.6, 28, 1), rrect(45, 13, 3.6, 28, 1)))
  solid(p, poly(25, 17, 48.6, 12, 48.6, 19, 25, 24))
  tube(p, zGlyph(52, 50, 3.4), 2)
})
def('spell:system_snooze', '#8c7bff', (p) => {
  tube(p, arc(30, 35, 15, -Math.PI * 0.32, Math.PI * 1.32), 4.5)
  tube(p, pline(30, 16, 30, 33), 4.5)
  tube(p, zGlyph(49, 18, 4.5), 2.6)
  tube(p, zGlyph(54, 8.5, 2.6), 1.8, 0.8)
})
def('spell:stasis_field', C.ice, (p) => {
  tube(p, regular(32, 32, 24, 6, 0), 2.4, 0.85)
  solid(p, join(rrect(21, 15, 22, 4, 1.5), rrect(21, 45, 22, 4, 1.5)))
  solid(p, poly(23, 19, 41, 19, 34, 32, 41, 45, 23, 45, 30, 32))
  hotFill(p, poly(27, 42, 37, 42, 32, 36), '#ffffff')
  ink(p, poly(27, 22, 37, 22, 32, 28))
})
def('spell:firewall', C.orange, firewall)
def('spell:data_leech', C.red, (p) => {
  solid(p, drop(36, 32, 0.95))
  cut(p, join(pline(29, 34, 43, 34), pline(31, 40, 41, 40), pline(33, 28, 39, 28)), 2.2)
  tube(p, pline(9, 18, 18, 24), 2.6)
  solid(p, arrowHead(19, 25, 0.6, 5))
  tube(p, pline(9, 48, 17, 42), 2.6)
  solid(p, arrowHead(18, 41.5, -0.6, 5))
})
def('spell:ping', C.cyan, sonar)
def('spell:honeypot', C.gold, honeyPot)
def('spell:hijack', C.purple, cursor)
def('spell:daemon', '#ff6a3c', daemonHead)

// Grenades.
def('item:grenade_emp', C.blue, (p) => grenade(p, (q) => ink(q, bolt(30, 39, 0.5))))
def('item:grenade_glitch', C.magenta, (p) =>
  grenade(p, (q) => {
    ink(q, join(rrect(22, 32, 8, 5, 0.5), rrect(31, 37, 9, 5, 0.5), rrect(24, 42, 6, 5, 0.5), rrect(33, 45, 5, 4, 0.5)))
    const c = withColor(q, C.cyan)
    hotFill(c, rrect(44, 30, 5, 3, 0.5), C.cyan)
    hotFill(c, rrect(10, 44, 4, 3, 0.5), C.cyan)
  }),
)
def('item:grenade_noise', C.amber, (p) =>
  grenade(p, (q) => {
    const w = new Path2D()
    w.addPath(arc(24, 39, 5, -0.9, 0.9))
    w.addPath(arc(24, 39, 10, -0.8, 0.8))
    w.addPath(arc(24, 39, 15, -0.65, 0.65))
    cut(q, w, 2)
  }),
)

// Weapons, drawn horizontally then tilted.
const TILT = -0.45
def('weapon:laser', C.cyan, (p) =>
  scoped(p, 30, 33, TILT, 1, () => {
    solid(p, poly(-20, -7, 12, -7, 17, -3, 12, 1, -2, 1, -6, 13, -14, 13, -11, 1, -20, 1))
    cut(p, pline(-16, -3, 6, -3), 1.4)
    tube(p, pline(20, -3, 30, -3), 2.4)
    hotFill(p, circ(19, -3, 2.6))
  }),
)
def('weapon:blade', C.magenta, (p) =>
  scoped(p, 32, 32, -Math.PI / 4, 1, () => {
    solid(p, poly(-4, -3.2, 24, -3.2, 31, 0, 24, 3.2, -4, 3.2), 'nonzero', 10)
    hotFill(p, rrect(-3, -0.8, 27, 1.6, 0.8))
    const hilt = withColor(p, '#8fa3b8')
    solid(hilt, rrect(-8, -8, 4, 16, 1.5))
    solid(hilt, rrect(-22, -2.6, 14, 5.2, 2))
    cut(p, pline(-18, -2.6, -18, 2.6, -14, -2.6, -14, 2.6), 1)
  }),
)
def('weapon:plasma', C.green, (p) =>
  scoped(p, 28, 34, TILT, 1, () => {
    solid(p, join(rrect(-19, -8, 27, 15, 5), rrect(7, -5, 10, 9, 2)))
    solid(p, poly(-13, 6, -5, 6, -7, 16, -15, 16))
    ink(p, circ(-6, -0.5, 5))
    hotFill(p, circ(-6, -0.5, 3))
    solid(p, circ(24, -0.5, 6.5), 'nonzero', 12)
    hotFill(p, circ(24, -0.5, 3))
  }),
)
def('weapon:railgun', C.blue, (p) =>
  scoped(p, 32, 33, TILT, 1, () => {
    solid(p, join(poly(-29, -3, -14, -5, -14, 6, -27, 8), rrect(-14, -6, 16, 11, 2)))
    solid(p, join(rrect(2, -7.5, 25, 3.4, 1), rrect(2, 1.6, 25, 3.4, 1)))
    for (const x of [8, 15, 22]) tube(p, ell(x, -0.5, 1.6, 5), 1.4)
    tube(p, pline(28, -0.5, 33, -0.5), 2)
    solid(p, poly(-8, 5, -2, 5, -4, 13, -10, 13))
  }),
)
def('weapon:cannon', C.amber, (p) =>
  scoped(p, 30, 33, TILT, 1, () => {
    solid(p, join(rrect(-27, -9, 11, 18, 2), rrect(-17, -6.5, 32, 13, 2)))
    solid(p, rrect(13, -10, 9, 20, 2))
    solid(p, join(rrect(-9, -12, 12, 4, 1), poly(-12, 6, -4, 6, -6, 16, -14, 16)))
    cut(p, join(pline(-17, -6.5, -17, 6.5), pline(-5, -6.5, -5, 6.5), pline(5, -6.5, 5, 6.5), pline(17.5, -10, 17.5, -4), pline(17.5, 4, 17.5, 10)), 1.6)
    hotFill(p, circ(22.5, 0, 3.4))
  }),
)
def('weapon:horizon', C.purple, (p) =>
  scoped(p, 30, 34, TILT, 1, () => {
    solid(p, join(rrect(-24, -4.5, 20, 9, 2.5), poly(-20, 4, -13, 4, -15, 13, -22, 13)))
    solid(p, join(rrect(-5, -9, 11, 3, 1), rrect(-5, 6, 11, 3, 1)))
    const g = p.g
    g.save()
    g.shadowColor = p.c
    g.shadowBlur = 10
    g.fillStyle = '#05030a'
    g.fill(circ(15, 0, 9))
    g.restore()
    tube(p, circ(15, 0, 9), 2)
    tube(p, ell(15, 0, 15, 3.6, 0.35), 1.6, 0.9)
  }),
)

// Armour tiers.
for (let t = 0; t <= 6; t++) def(`armor:${t}`, ARMOR[t], armor(t))

// Implants.
def('implant:ricochet', C.cyan, (p) => {
  solid(p, rrect(46, 11, 5, 42, 1.5))
  tube(p, pline(11, 47, 44, 31, 17, 15), 3)
  solid(p, arrowHead(16, 14.5, Math.atan2(15 - 31, 17 - 44), 6))
  sparkle(p, 44, 31, 6)
})
def('implant:siphon', C.blue, (p) => {
  solid(p, poly(11, 18, 53, 18, 37, 35, 37, 47, 27, 47, 27, 35))
  cut(p, ell(32, 20.5, 16, 2.4), 1.6)
  solid(p, drop(32, 54, 0.22))
  hotFill(p, join(circ(22, 11, 1.8), circ(32, 9, 2.2), circ(42, 11, 1.8)), p.hot)
})
def('implant:mine', C.red, (p) => {
  const dome = new Path2D()
  dome.moveTo(16, 42)
  dome.bezierCurveTo(16, 24, 48, 24, 48, 42)
  dome.closePath()
  solid(p, join(poly(31, 21, 33, 21, 34, 12, 30, 12), poly(19, 31, 21, 29, 14, 22, 12, 24), poly(45, 31, 43, 29, 50, 22, 52, 24)))
  solid(p, dome)
  solid(p, rrect(11, 41, 42, 9, 3))
  cut(p, pline(14, 45.5, 50, 45.5), 1.4)
  hotFill(p, circ(32, 35, 3.6))
})
def('implant:capacitor', C.cyan, (p) => {
  solid(p, rrect(28, 9, 8, 6, 1.5))
  solid(p, rrect(21, 14, 22, 40, 5))
  ink(p, bolt(32, 34, 0.62))
  cut(p, pline(21, 22, 43, 22), 1.6)
})
def('implant:nanoweave', C.green, (p) => {
  const sh = shield(32, 32, 38, 44)
  solid(p, sh)
  p.g.save()
  p.g.clip(sh)
  const mesh = new Path2D()
  for (let row = 0; row < 7; row++)
    for (let col = 0; col < 7; col++) mesh.addPath(regular(8 + col * 8.6 + (row % 2) * 4.3, 10 + row * 7.5, 5, 6, 0))
  cut(p, mesh, 1.3)
  p.g.restore()
})
def('implant:vampire', C.red, (p) => {
  const lip = new Path2D()
  lip.moveTo(12, 21)
  lip.quadraticCurveTo(32, 32, 52, 21)
  tube(p, lip, 3.2)
  solid(p, join(poly(20, 26, 28, 28.5, 24, 46), poly(36, 28.5, 44, 26, 40, 46)))
  solid(p, drop(24, 53, 0.22))
})
def('implant:thermal', C.orange, thermalEye)
def('implant:emp_coil', C.blue, (p) => {
  const coil = new Path2D()
  for (let i = 0; i < 4; i++) coil.addPath(ell(32, 22 + i * 7, 11, 3.6))
  tube(p, coil, 2.4)
  solid(p, rrect(18, 47, 28, 6, 2))
  tube(p, pline(32, 18, 32, 10), 2.4)
  tube(p, pline(24, 12, 20, 8, 23, 6, 18, 2), 1.6, 0.9)
  tube(p, pline(40, 12, 44, 8, 41, 6, 46, 2), 1.6, 0.9)
  hotFill(p, circ(32, 9, 3))
})
def('implant:adrenal', '#ff5a3c', (p) => {
  solid(p, heart(32, 33, 1.12))
  const ecg = pline(8, 33, 20, 33, 24, 25, 29, 43, 34, 19, 39, 38, 43, 33, 56, 33)
  cut(p, ecg, 5)
  p.g.save()
  p.g.shadowColor = p.c
  p.g.shadowBlur = 6
  p.g.strokeStyle = '#ffffff'
  p.g.lineWidth = 2.2
  p.g.stroke(ecg)
  p.g.restore()
})
def('implant:extender', C.cyan, (p) => {
  tube(p, pline(15, 32, 49, 32), 3)
  solid(p, join(arrowHead(15, 32, Math.PI, 7), arrowHead(49, 32, 0, 7)))
  tube(p, join(pline(8, 21, 8, 43), pline(56, 21, 56, 43)), 3)
  solid(p, rrect(26, 26, 12, 12, 2.5))
  ink(p, rrect(29, 29, 6, 6, 1))
})
def('implant:crit', C.red, (p) => {
  crosshair(p, 16)
  sparkle(p, 32, 32, 9)
})
def('implant:scavenger', C.gold, (p) => {
  const u = new Path2D()
  u.moveTo(19, 22)
  u.lineTo(19, 37)
  u.arc(32, 37, 13, Math.PI, 0, true)
  u.lineTo(45, 22)
  tube(p, u, 8)
  cut(p, join(pline(15, 27, 23, 27), pline(41, 27, 49, 27)), 2)
  hotFill(p, join(rrect(22, 10, 4, 4, 0.5), rrect(30, 8, 4, 4, 0.5), rrect(38, 11, 4, 4, 0.5)), p.hot)
})

// Misc items.
def('item:keycard', C.cyan, (p) =>
  scoped(p, 32, 32, -0.22, 1, () => {
    solid(p, rrect(-20, -14, 40, 28, 4))
    ink(p, rrect(-14, -7, 11, 9, 1.5))
    const lines = new Path2D()
    lines.moveTo(-14, -2.5)
    lines.lineTo(-3, -2.5)
    lines.moveTo(-8.5, -7)
    lines.lineTo(-8.5, 2)
    p.g.strokeStyle = p.c
    p.g.lineWidth = 1
    p.g.stroke(lines)
    ink(p, rrect(-20, 6, 40, 4, 0))
    ink(p, circ(14, -8, 2.4))
  }),
)
def('item:fragment', C.magenta, (p) => {
  solid(p, poly(30, 9, 45, 24, 40, 51, 25, 55, 17, 31))
  cut(p, pline(30, 9, 31, 39, 40, 51), 1.6)
  cut(p, pline(17, 31, 31, 39), 1.6)
  solid(p, poly(50, 14, 55, 18, 52, 23, 48, 19))
  solid(p, poly(11, 45, 15, 47, 13, 52, 9, 50))
})
def('item:datacore', C.cyan, (p) => {
  const g = p.g
  g.save()
  g.shadowColor = p.c
  g.shadowBlur = 8
  g.fillStyle = p.hot
  g.fill(poly(32, 11, 51, 21.5, 32, 32, 13, 21.5))
  g.fillStyle = p.c
  g.fill(poly(13, 21.5, 32, 32, 32, 53, 13, 42.5))
  g.fillStyle = p.deep
  g.fill(poly(51, 21.5, 51, 42.5, 32, 53, 32, 32))
  g.restore()
  cut(p, join(pline(19, 30, 19, 38, 25, 41), pline(45, 30, 45, 38, 39, 41)), 1.4)
  ink(p, regular(32, 32, 6, 6, 0))
  hotFill(p, regular(32, 32, 3.6, 6, 0))
})
def('item:credits', C.gold, (p) => {
  for (const y of [47, 41]) {
    solid(p, join(rrect(10, y - 4, 26, 6, 2), ell(23, y - 4, 13, 3.5)))
    cut(p, ell(23, y - 4, 13, 3.5), 1)
  }
  solid(p, circ(39, 29, 15))
  cut(p, circ(39, 29, 11.5), 1.4)
  cut(p, arc(39, 29, 6.5, Math.PI * 0.28, Math.PI * 1.72), 2.6)
  cut(p, pline(39, 19.5, 39, 38.5), 2)
})
def('item:chest', C.amber, (p) => {
  solid(p, rrect(11, 29, 42, 24, 3))
  const lid = new Path2D()
  lid.moveTo(11, 29)
  lid.lineTo(11, 22)
  lid.bezierCurveTo(11, 13, 53, 13, 53, 22)
  lid.lineTo(53, 29)
  lid.closePath()
  solid(p, lid)
  cut(p, join(pline(11, 29, 53, 29), pline(20, 16, 20, 53), pline(44, 16, 44, 53)), 2)
  ink(p, rrect(27, 25, 10, 12, 2))
  hotFill(p, circ(32, 30, 2))
  hotFill(p, rrect(31.2, 30, 1.6, 4.5, 0.5))
})

// Statuses.
def('status:burning', C.orange, (p) => {
  solid(p, flame(32, 54, 34, 46))
  hotFill(p, flame(32, 54, 15, 24), '#fff1cc')
})
def('status:slowed', C.blue, (p) => {
  solid(p, join(rrect(9, 44, 46, 8, 4), rrect(10, 32, 10, 16, 5)))
  solid(p, circ(37, 32, 14))
  const spiral = new Path2D()
  for (let i = 0; i <= 40; i++) {
    const a = i * 0.32
    const r = 1 + i * 0.27
    const x = 37 + Math.cos(a) * r
    const y = 32 + Math.sin(a) * r
    if (i) spiral.lineTo(x, y)
    else spiral.moveTo(x, y)
  }
  cut(p, spiral, 2)
  tube(p, join(pline(12, 33, 8, 22), pline(18, 33, 19, 21)), 2)
  hotFill(p, join(circ(8, 22, 2), circ(19, 21, 2)))
})
def('status:rooted', C.green, (p) => {
  const roots = join(
    pline(32, 15, 32, 52),
    pline(32, 28, 21, 39, 21, 52),
    pline(32, 28, 43, 39, 43, 52),
    pline(32, 36, 13, 47),
    pline(32, 36, 51, 47),
  )
  tube(p, roots, 3.4)
  solid(p, rrect(20, 9, 24, 7, 2.5))
  for (const [x, y] of [
    [32, 52],
    [21, 52],
    [43, 52],
    [13, 47],
    [51, 47],
  ])
    hotFill(p, rrect(x - 2.5, y - 2.5, 5, 5, 1), p.hot)
})
def('status:corrupted', '#ff3b6b', (p) => {
  const page = poly(16, 9, 38, 9, 48, 19, 48, 55, 16, 55)
  const g = p.g
  g.save()
  g.clip(rrect(0, 0, 64, 33, 0))
  solid(p, page)
  g.restore()
  g.save()
  g.clip(rrect(0, 33, 64, 31, 0))
  g.translate(4, 0)
  solid(p, page)
  g.restore()
  ink(p, poly(38, 9, 38, 19, 48, 19))
  cut(p, pline(16, 32, 24, 28, 30, 34, 38, 27, 52, 33), 2.4)
  cut(p, join(pline(21, 41, 40, 41), pline(21, 47, 34, 47)), 1.8)
  const cy = withColor(p, C.cyan)
  hotFill(cy, rrect(52, 38, 5, 4, 0.5), C.cyan)
  hotFill(p, rrect(8, 24, 5, 4, 0.5), p.hot)
  hotFill(p, rrect(52, 22, 3, 3, 0.5), p.hot)
})
def('status:memleak', C.violet, (p) => {
  solid(p, rrect(9, 15, 46, 19, 2))
  ink(p, join(rrect(13, 19, 8, 9, 1), rrect(24, 19, 8, 9, 1), rrect(35, 19, 8, 9, 1)))
  const pins = new Path2D()
  for (let x = 12; x < 54; x += 4) {
    pins.moveTo(x, 30)
    pins.lineTo(x, 34)
  }
  cut(p, pins, 1.4)
  tube(p, pline(48, 34, 48, 39), 2.4)
  solid(p, drop(48, 46, 0.36))
  hotFill(p, circ(30, 47, 1.6), p.hot)
  hotFill(p, circ(36, 54, 1.2), p.hot)
})
def('status:haste', C.gold, (p) => {
  solid(p, join(chevron(18, 32, 14, 34, 9), chevron(33, 32, 14, 34, 9)))
  tube(p, join(pline(7, 24, 13, 24), pline(5, 32, 13, 32), pline(7, 40, 13, 40)), 2.4)
})
def('status:shielded', C.blue, (p) => {
  solid(p, shield(32, 32, 38, 44))
  cut(p, shield(32, 32, 28, 33), 1.8)
  hotFill(p, poly(22, 18, 30, 15, 30, 30, 22, 30), 'rgba(255,255,255,0.35)')
})
def('status:stealth', '#a0a8ff', (p) => {
  tube(p, eyeShape(32, 32, 42, 24), 3)
  solid(p, circ(32, 32, 7.5))
  ink(p, circ(32, 32, 3))
  cut(p, pline(13, 51, 51, 13), 8)
  tube(p, pline(14, 50, 50, 14), 3.2)
})
def('status:scanner', C.green, (p) => {
  const g = p.g
  const sweep = new Path2D()
  sweep.moveTo(32, 32)
  sweep.arc(32, 32, 20, -Math.PI / 2, -Math.PI / 2 + 1.1)
  sweep.closePath()
  const sg = g.createRadialGradient(32, 32, 0, 32, 32, 20)
  sg.addColorStop(0, rgba(p.rgb, 0.1))
  sg.addColorStop(1, rgba(p.rgb, 0.75))
  g.fillStyle = sg
  g.fill(sweep)
  tube(p, circ(32, 32, 21), 2.6)
  tube(p, circ(32, 32, 11), 1.4, 0.6)
  tube(p, join(pline(32, 14, 32, 50), pline(14, 32, 50, 32)), 1.2, 0.5)
  tube(p, pline(32, 32, 32 + Math.cos(-Math.PI / 2 + 1.1) * 20, 32 + Math.sin(-Math.PI / 2 + 1.1) * 20), 2)
  hotFill(p, circ(41, 21, 2.4))
  hotFill(p, circ(23, 40, 2))
})
def('status:regen', C.green, (p) => {
  solid(p, heart(32, 33, 1.12))
  cut(p, join(pline(32, 22, 32, 38), pline(24, 30, 40, 30)), 4)
})
def('status:pulled', C.violet, (p) => {
  const spiral = new Path2D()
  for (let i = 0; i <= 60; i++) {
    const a = i * 0.19
    const r = 23 - i * 0.32
    const x = 32 + Math.cos(a) * r
    const y = 32 + Math.sin(a) * r
    if (i) spiral.lineTo(x, y)
    else spiral.moveTo(x, y)
  }
  tube(p, spiral, 3)
  const a = 60 * 0.19
  const r = 23 - 60 * 0.32
  solid(p, arrowHead(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, a + Math.PI / 2 + 0.3, 6))
  hotFill(p, circ(32, 32, 2.5))
})
def('status:stunned', C.gold, (p) => {
  tube(p, ell(32, 30, 22, 8), 2.2, 0.8)
  solid(p, star(14, 31, 7, 3, 5))
  solid(p, star(36, 22, 8, 3.4, 5))
  solid(p, star(49, 37, 6, 2.6, 5))
  tube(p, arc(32, 46, 6, Math.PI * 1.1, Math.PI * 2.9), 2, 0.8)
})
def('status:asleep', C.violet, (p) => {
  tube(p, zGlyph(23, 41, 9), 4.2)
  tube(p, zGlyph(39, 25, 6.5), 3.2)
  tube(p, zGlyph(51, 12.5, 4), 2.4)
})
def('status:frozen', '#bff8ff', (p) => {
  const flake = new Path2D()
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 - Math.PI / 2
    const x = (r: number, o = 0) => 32 + Math.cos(a) * r - Math.sin(a) * o
    const y = (r: number, o = 0) => 32 + Math.sin(a) * r + Math.cos(a) * o
    flake.moveTo(x(4), y(4))
    flake.lineTo(x(22), y(22))
    flake.moveTo(x(13, -6), y(13, -6))
    flake.lineTo(x(17), y(17))
    flake.lineTo(x(13, 6), y(13, 6))
  }
  tube(p, flake, 3.2)
  solid(p, regular(32, 32, 5, 6, 0))
})

// Talents.
def('talent:hk_mana', TREE.hk, (p) => {
  solid(p, poly(30, 9, 45, 31, 30, 54, 15, 31))
  cut(p, join(pline(15, 31, 45, 31), pline(30, 9, 30, 54)), 1.6)
  tube(p, join(pline(50, 10, 50, 22), pline(44, 16, 56, 16)), 3)
}, true)
def('talent:hk_ping', TREE.hk, sonar, true)
def('talent:hk_efficient', TREE.hk, (p) => {
  tube(p, arc(32, 38, 20, Math.PI * 0.95, Math.PI * 2.05), 4)
  const ticks = new Path2D()
  for (let i = 0; i <= 4; i++) {
    const a = Math.PI + (i * Math.PI) / 4
    ticks.moveTo(32 + Math.cos(a) * 12, 38 + Math.sin(a) * 12)
    ticks.lineTo(32 + Math.cos(a) * 15, 38 + Math.sin(a) * 15)
  }
  tube(p, ticks, 2, 0.8)
  const a = Math.PI * 1.22
  solid(p, poly(32 + Math.cos(a) * 17, 38 + Math.sin(a) * 17, 32 + Math.cos(a + 1.57) * 3, 38 + Math.sin(a + 1.57) * 3, 32 + Math.cos(a - 1.57) * 3, 38 + Math.sin(a - 1.57) * 3))
  solid(p, circ(32, 38, 4.5))
  hotFill(p, circ(32, 38, 1.8))
  solid(p, rrect(20, 47, 24, 5, 2))
}, true)
def('talent:hk_chain', TREE.hk, (p) => {
  tube(p, join(pline(15, 45, 20, 34, 25, 38, 31, 22), pline(33, 22, 39, 34, 43, 30, 49, 40)), 2.6)
  for (const [x, y] of [
    [14, 46],
    [32, 19],
    [50, 41],
  ]) {
    solid(p, circ(x, y, 6))
    hotFill(p, circ(x, y, 2.4))
  }
}, true)
def('talent:hk_hijack', TREE.hk, cursor, true)
def('talent:hk_root', TREE.hk, (p) => {
  solid(p, rrect(9, 13, 46, 38, 5))
  ink(p, rrect(12, 20, 40, 28, 2))
  const hashSign = join(pline(19, 26, 17, 42), pline(25, 26, 23, 42), pline(14, 31, 28, 31), pline(13, 37, 27, 37))
  tube(p, hashSign, 2.2)
  hotFill(p, rrect(32, 38, 10, 4, 1), p.hot)
  hotFill(p, join(circ(14, 16.5, 1.3), circ(18.5, 16.5, 1.3)), INK)
}, true)
def('talent:sd_chassis', TREE.sd, (p) => {
  tube(p, poly(16, 17, 25, 13, 32, 19, 39, 13, 48, 17, 51, 31, 46, 52, 18, 52, 13, 31), 3)
  solid(p, join(rrect(28, 24, 8, 22, 2), rrect(21, 31, 22, 8, 2)))
}, true)
def('talent:sd_aim', TREE.sd, (p) => {
  crosshair(p, 15)
  solid(p, circ(32, 32, 3.5))
}, true)
def('talent:sd_rapid', TREE.sd, (p) => {
  for (const [x, y] of [
    [14, 22],
    [27, 16],
    [40, 22],
  ]) {
    const b = new Path2D()
    b.moveTo(x, y + 8)
    b.quadraticCurveTo(x, y - 2, x + 5, y - 6)
    b.quadraticCurveTo(x + 10, y - 2, x + 10, y + 8)
    b.lineTo(x + 10, y + 30)
    b.lineTo(x, y + 30)
    b.closePath()
    solid(p, b)
    cut(p, pline(x, y + 9, x + 10, y + 9), 1.6)
  }
}, true)
def('talent:sd_dash', TREE.sd, (p) => {
  solid(p, poly(21, 25, 37, 25, 37, 15, 55, 32, 37, 49, 37, 39, 21, 39))
  tube(p, join(pline(8, 25, 15, 25), pline(5, 32, 15, 32), pline(8, 39, 15, 39)), 2.6)
}, true)
def('talent:sd_overkill', TREE.sd, (p) => {
  const burst = withColor(p, C.amber)
  solid(burst, star(32, 32, 27, 17, 12, 0), 'nonzero', 9)
  ink(p, circ(32, 32, 17))
  solid(p, skull(32, 30, 0.8))
  skullDetails(p, 32, 30, 0.8)
}, true)
def('talent:sd_blood', TREE.sd, (p) => {
  solid(p, drop(30, 33, 1.0))
  hotFill(p, ell(24, 38, 3, 6, 0.4), 'rgba(255,255,255,0.55)')
  solid(p, drop(48, 46, 0.3))
  solid(p, drop(47, 18, 0.22))
}, true)
def('talent:en_honeypot', TREE.en, honeyPot, true)
def('talent:en_thermal', TREE.en, thermalEye, true)
def('talent:en_firewall', TREE.en, firewall, true)
def('talent:en_grenadier', TREE.en, (p) => grenade(p, (q) => ink(q, star(30, 40, 8, 3.4, 5))), true)
def('talent:en_daemon', TREE.en, daemonHead, true)
def('talent:en_scrap', TREE.en, (p) => {
  solid(p, gear(28, 34, 19, 14, 9, 6))
  const nut = withColor(p, '#c8d2dc')
  solid(nut, regular(48, 15, 7, 6, 0))
  ink(p, circ(48, 15, 2.6))
}, true)

// UI.
def('ui:shop', C.gold, (p) => {
  tube(p, arc(32, 23, 8, Math.PI, 0), 3)
  solid(p, poly(14, 23, 50, 23, 53, 54, 11, 54))
  cut(p, arc(32, 39, 7.5, Math.PI * 0.3, Math.PI * 1.7), 2.6)
  cut(p, pline(32, 29, 32, 49), 2)
})
def('ui:board', C.cyan, (p) => {
  tube(p, rrect(9, 11, 46, 40, 3), 2.6)
  const notes: [number, number, number, number, number][] = [
    [21, 24, 14, 16, -0.08],
    [42, 20, 16, 10, 0.06],
    [41, 37, 14, 14, -0.05],
    [20, 42, 12, 9, 0.1],
  ]
  for (const [x, y, w, h, r] of notes) {
    solid(p, moved(rrect(-w / 2, -h / 2, w, h, 1), x, y, r))
    const lines = new Path2D()
    for (let ly = -h / 2 + 5; ly < h / 2 - 1; ly += 3.5) {
      lines.moveTo(-w / 2 + 3, ly)
      lines.lineTo(w / 2 - 3, ly)
    }
    cut(p, moved(lines, x, y, r), 1.2)
    hotFill(p, circ(x + Math.sin(-r) * (h / 2 - 1), y - h / 2 + 1, 1.9), C.red)
  }
  tube(p, pline(20, 51, 16, 56), 2.2)
  tube(p, pline(44, 51, 48, 56), 2.2)
})
def('ui:repair', C.green, (p) => {
  const sd = withColor(p, C.cyan)
  scoped(p, 32, 32, Math.PI / 4, 1, () => {
    solid(sd, rrect(-2, -24, 4, 22, 1.5))
    solid(sd, rrect(-4.5, 2, 9, 20, 3))
  })
  scoped(p, 32, 32, -Math.PI / 4, 1, () => {
    solid(p, rrect(-3.5, -6, 7, 30, 3))
    const a = Math.asin(4 / 10)
    const head = new Path2D()
    head.moveTo(4, -14 - Math.sqrt(84))
    head.arc(0, -14, 10, -Math.PI / 2 + a, Math.PI * 1.5 - a)
    head.lineTo(-4, -15)
    head.lineTo(4, -15)
    head.closePath()
    solid(p, head)
  })
})
def('ui:beacon', C.cyan, (p) => {
  tube(p, join(pline(32, 17, 22, 54), pline(32, 17, 42, 54), pline(26, 38, 38, 38), pline(24, 46, 40, 46), pline(27, 31, 38, 46), pline(37, 31, 26, 46)), 2.4)
  hotFill(p, circ(32, 15, 4))
  tube(p, join(arc(32, 15, 9, -Math.PI * 0.82, -Math.PI * 0.58), arc(32, 15, 9, -Math.PI * 0.42, -Math.PI * 0.18)), 2.4)
  tube(p, join(arc(32, 15, 15, -Math.PI * 0.85, -Math.PI * 0.6), arc(32, 15, 15, -Math.PI * 0.4, -Math.PI * 0.15)), 2.2, 0.75)
})
def('ui:vault', C.gold, (p) => {
  solid(p, circ(32, 32, 22))
  cut(p, circ(32, 32, 16.5), 2)
  const spokes = new Path2D()
  for (let i = 0; i < 3; i++) {
    const a = (i * TAU) / 3 - Math.PI / 2
    spokes.moveTo(32, 32)
    spokes.lineTo(32 + Math.cos(a) * 12, 32 + Math.sin(a) * 12)
  }
  cut(p, spokes, 3)
  ink(p, circ(32, 32, 4.5))
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8
    ink(p, circ(32 + Math.cos(a) * 19.5, 32 + Math.sin(a) * 19.5, 1.2))
  }
})
def('ui:puzzle', C.magenta, (p) => {
  const piece = new Path2D()
  piece.moveTo(15, 22)
  piece.lineTo(26, 22)
  piece.arc(31, 19, 6.5, Math.PI * 0.8, Math.PI * 0.2, false)
  piece.lineTo(47, 22)
  piece.lineTo(47, 32)
  piece.arc(50, 37, 6.5, Math.PI * 1.3, Math.PI * 0.7, false)
  piece.lineTo(47, 52)
  piece.lineTo(15, 52)
  piece.lineTo(15, 42)
  piece.arc(18, 37, 5.5, Math.PI * 0.7, Math.PI * 1.3, true)
  piece.closePath()
  solid(p, piece)
  hotFill(p, ell(24, 30, 3, 1.6, -0.5), 'rgba(255,255,255,0.5)')
})
def('ui:hub', C.amber, (p) => {
  solid(p, poly(8, 31, 32, 10, 56, 31, 51, 31, 32, 15, 13, 31))
  solid(p, poly(16, 30, 32, 17, 48, 30, 48, 53, 16, 53))
  ink(p, rrect(27, 37, 10, 16, 2))
  hotFill(p, rrect(29, 39, 6, 14, 1.5), '#fff0d0')
  ink(p, join(rrect(19, 34, 6, 6, 1), rrect(39, 34, 6, 6, 1)))
})
def('ui:gate', C.violet, (p) => {
  const g = p.g
  const inner = new Path2D()
  inner.moveTo(20, 54)
  inner.lineTo(20, 31)
  inner.arc(32, 31, 12, Math.PI, 0)
  inner.lineTo(44, 54)
  inner.closePath()
  const portal = g.createRadialGradient(32, 38, 2, 32, 38, 18)
  portal.addColorStop(0, rgba([255, 255, 255], 0.9))
  portal.addColorStop(0.3, rgba(p.rgb, 0.7))
  portal.addColorStop(1, rgba(p.rgb, 0.15))
  g.fillStyle = portal
  g.fill(inner)
  const arch = new Path2D()
  arch.moveTo(15, 55)
  arch.lineTo(15, 31)
  arch.arc(32, 31, 17, Math.PI, 0)
  arch.lineTo(49, 55)
  tube(p, arch, 5)
  tube(p, arc(32, 39, 6, 0, Math.PI * 1.5), 1.6, 0.9)
  solid(p, rrect(10, 52, 44, 4, 1.5))
})
def('ui:boss', C.red, (p) => {
  solid(p, join(poly(18, 22, 8, 6, 11, 22, 17, 30), poly(46, 22, 56, 6, 53, 22, 47, 30)))
  solid(p, skull(32, 32, 1))
  skullDetails(p, 32, 32, 1)
  hotFill(p, join(circ(26, 31, 1.6), circ(38, 31, 1.6)), '#ffd0d8')
})
def('ui:quest', C.gold, (p) => {
  tube(p, poly(32, 8, 56, 32, 32, 56, 8, 32), 3)
  solid(p, poly(28.5, 18, 35.5, 18, 34, 36, 30, 36))
  solid(p, circ(32, 43, 3.6))
})
def('ui:skull', C.white, (p) => {
  solid(p, skull(32, 31, 1.08))
  skullDetails(p, 32, 31, 1.08)
})
def('ui:map', C.cyan, (p) => {
  solid(p, poly(9, 16, 24, 11, 40, 17, 55, 12, 55, 48, 40, 53, 24, 47, 9, 52))
  cut(p, join(pline(24, 11, 24, 47), pline(40, 17, 40, 53)), 1.6)
  p.g.save()
  p.g.setLineDash([2.5, 3])
  cut(p, pline(14, 44, 21, 33, 30, 37, 36, 27), 1.8)
  p.g.restore()
  const red = withColor(p, C.red)
  const pin = new Path2D()
  pin.arc(44, 24, 6, Math.PI * 0.85, Math.PI * 0.15)
  pin.lineTo(44, 38)
  pin.closePath()
  solid(red, pin)
  ink(p, circ(44, 24, 2.4))
})
def('ui:journal', C.amber, (p) => {
  book(p)
  cut(p, join(pline(27, 20, 42, 20), pline(27, 26, 42, 26), pline(27, 32, 38, 32)), 1.8)
  const rib = withColor(p, C.red)
  solid(rib, poly(40, 10, 45, 10, 45, 22, 42.5, 19, 40, 22))
})
def('ui:talents', C.magenta, (p) => {
  const edges = join(pline(32, 50, 20, 32), pline(32, 50, 44, 32), pline(20, 32, 12, 15), pline(20, 32, 32, 15), pline(44, 32, 32, 15), pline(44, 32, 52, 15))
  tube(p, edges, 2.4)
  for (const [x, y, r] of [
    [32, 50, 5.5],
    [20, 32, 5],
    [44, 32, 5],
    [12, 15, 4.2],
    [32, 15, 4.2],
    [52, 15, 4.2],
  ]) {
    solid(p, circ(x, y, r))
    hotFill(p, circ(x, y, r * 0.4))
  }
})
def('ui:spellbook', C.violet, (p) => {
  book(p)
  ink(p, star(35, 30, 10, 4.2, 5))
  hotFill(p, star(35, 30, 6.5, 2.8, 5))
})
def('ui:inventory', C.cyan, (p) => {
  tube(p, arc(32, 17, 6, Math.PI, 0), 3)
  solid(p, rrect(14, 17, 36, 38, 9))
  cut(p, pline(16, 30, 48, 30), 2)
  ink(p, rrect(22, 37, 20, 12, 3))
  solid(p, rrect(24, 39, 16, 8, 2))
  hotFill(p, rrect(30, 28, 4, 5, 1), p.hot)
})
