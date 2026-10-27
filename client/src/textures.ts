// Small procedural textures shared by the effects, entities and world props.
import * as THREE from 'three'

function canvas(w: number, h = w) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!] as const
}

function finish(c: HTMLCanvasElement, repeat = false) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

const cache = new Map<string, THREE.Texture>()
function cached(key: string, make: () => THREE.Texture) {
  let t = cache.get(key)
  if (!t) {
    t = make()
    cache.set(key, t)
  }
  return t
}

/** Soft round glow for sprites and particles. */
export function glowTexture(color = '#ffffff') {
  return cached(`glow${color}`, () => {
    const S = 128
    const [c, g] = canvas(S)
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
    grad.addColorStop(0, color)
    grad.addColorStop(0.25, color)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, S, S)
    return finish(c)
  })
}

/** Thin bright ring, used for shockwaves, auras and telegraph edges. */
export function ringTexture() {
  return cached('ring', () => {
    const S = 256
    const [c, g] = canvas(S)
    const grad = g.createRadialGradient(S / 2, S / 2, S * 0.36, S / 2, S / 2, S / 2)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(0.7, 'rgba(255,255,255,0.9)')
    grad.addColorStop(0.85, 'rgba(255,255,255,1)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, S, S)
    return finish(c)
  })
}

/** Filled disc with a bright rim, for telegraphs and floor zones. */
export function discTexture() {
  return cached('disc', () => {
    const S = 256
    const [c, g] = canvas(S)
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
    grad.addColorStop(0, 'rgba(255,255,255,0.25)')
    grad.addColorStop(0.8, 'rgba(255,255,255,0.4)')
    grad.addColorStop(0.93, 'rgba(255,255,255,1)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, S, S)
    return finish(c)
  })
}

/** Horizontal gradient strip with bright edges, for line telegraphs and beams on the floor. */
export function stripTexture() {
  return cached('strip', () => {
    const [c, g] = canvas(64, 256)
    const grad = g.createLinearGradient(0, 0, 64, 0)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(0.08, 'rgba(255,255,255,1)')
    grad.addColorStop(0.18, 'rgba(255,255,255,0.35)')
    grad.addColorStop(0.82, 'rgba(255,255,255,0.35)')
    grad.addColorStop(0.92, 'rgba(255,255,255,1)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 256)
    return finish(c)
  })
}

/** Blotchy cloud puff for toxic gas, noise clouds and smoke. */
export function cloudTexture() {
  return cached('cloud', () => {
    const S = 128
    const [c, g] = canvas(S)
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < 18; i++) {
      const x = S / 2 + (rnd() - 0.5) * S * 0.5
      const y = S / 2 + (rnd() - 0.5) * S * 0.5
      const r = S * (0.12 + rnd() * 0.18)
      const grad = g.createRadialGradient(x, y, 0, x, y, r)
      grad.addColorStop(0, 'rgba(255,255,255,0.35)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, S, S)
    }
    return finish(c)
  })
}

/** Static noise, for glitch effects and the noise cloud. */
export function noiseTexture() {
  return cached('noise', () => {
    const S = 128
    const [c, g] = canvas(S)
    const img = g.createImageData(S, S)
    for (let i = 0; i < S * S; i++) {
      const v = Math.random() < 0.5 ? 0 : 255
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
      img.data[i * 4 + 3] = Math.random() < 0.6 ? 0 : 200
    }
    g.putImageData(img, 0, 0)
    const t = finish(c, true)
    t.magFilter = THREE.NearestFilter
    return t
  })
}

/** Sticky web decal. */
export function webTexture() {
  return cached('web', () => {
    const S = 256
    const [c, g] = canvas(S)
    g.strokeStyle = 'rgba(235,240,255,0.9)'
    g.lineWidth = 2
    g.translate(S / 2, S / 2)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(Math.cos(a) * S * 0.48, Math.sin(a) * S * 0.48)
      g.stroke()
    }
    for (let r = 14; r < S * 0.48; r += 16) {
      g.beginPath()
      for (let i = 0; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2
        const rr = r + Math.sin(i * 2.3) * 3
        if (i) g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
        else g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr)
      }
      g.stroke()
    }
    return finish(c)
  })
}

/** Text label for name tags and props. */
export function labelTexture(text: string, color: string, opts: { font?: string; width?: number; height?: number; sub?: string; subColor?: string } = {}) {
  const W = opts.width ?? 512
  const H = opts.height ?? 96
  const [c, ctx] = canvas(W, H)
  const font = opts.font ?? `600 ${Math.round(H * 0.46)}px "Share Tech Mono", monospace`
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const y = opts.sub ? H * 0.36 : H / 2
  ctx.shadowColor = color
  ctx.shadowBlur = 14
  ctx.fillStyle = color
  ctx.fillText(text, W / 2, y)
  ctx.shadowBlur = 0
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, W / 2, y)
  if (opts.sub) {
    ctx.font = `500 ${Math.round(H * 0.26)}px "Share Tech Mono", monospace`
    ctx.fillStyle = opts.subColor ?? color
    ctx.fillText(opts.sub, W / 2, H * 0.78)
  }
  return finish(c)
}

/** Multi-line text panel texture, for wall logs and the quest board. */
export function panelTexture(lines: string[], color: string, opts: { width?: number; height?: number; title?: string; size?: number } = {}) {
  const W = opts.width ?? 512
  const H = opts.height ?? 384
  const [c, g] = canvas(W, H)
  g.fillStyle = 'rgba(2,10,16,0.92)'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = color
  g.lineWidth = 4
  g.strokeRect(6, 6, W - 12, H - 12)
  g.globalAlpha = 0.08
  g.fillStyle = color
  for (let y = 10; y < H; y += 4) g.fillRect(8, y, W - 16, 1)
  g.globalAlpha = 1
  let y = 22
  if (opts.title) {
    g.font = `700 ${Math.round(W * 0.06)}px "Orbitron", sans-serif`
    g.fillStyle = color
    g.textAlign = 'center'
    g.textBaseline = 'top'
    g.fillText(opts.title, W / 2, y)
    y += W * 0.085
  }
  const size = opts.size ?? Math.round(W * 0.05)
  g.font = `${size}px "Share Tech Mono", monospace`
  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.fillStyle = '#d8faff'
  for (const raw of lines) {
    for (const line of wrap(g, raw, W - 48)) {
      if (y > H - size - 12) break
      g.fillText(line, 24, y)
      y += size * 1.25
    }
    y += size * 0.4
  }
  return finish(c)
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number) {
  const words = text.split(' ')
  const out: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (g.measureText(next).width > max && line) {
      out.push(line)
      line = w
    } else line = next
  }
  if (line) out.push(line)
  return out
}

/** Light-independent metal look for the first-person weapons and props. */
export function metalMatcap(tint = '#5a7590') {
  return cached(`matcap${tint}`, () => {
    const S = 256
    const [c, g] = canvas(S)
    g.fillStyle = '#05070a'
    g.fillRect(0, 0, S, S)
    const base = g.createRadialGradient(S * 0.38, S * 0.32, 4, S / 2, S / 2, S / 2)
    base.addColorStop(0, '#b8c8d8')
    base.addColorStop(0.2, tint)
    base.addColorStop(0.55, '#1e2834')
    base.addColorStop(0.85, '#080c12')
    base.addColorStop(1, '#2a6a78')
    g.fillStyle = base
    g.beginPath()
    g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2)
    g.fill()
    return finish(c)
  })
}

/** Image texture from a data URL (the UI icons), cached by URL. */
export function urlTexture(url: string) {
  return cached(`url${url}`, () => {
    const t = new THREE.TextureLoader().load(url)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })
}
