import * as THREE from 'three'

function canvas(size: number) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return [c, c.getContext('2d')!] as const
}

function finish(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Dark metal wall panels; the emissive map carries thin glowing circuit lines. */
export function wallTextures() {
  const S = 512
  const [c, g] = canvas(S)
  g.fillStyle = '#0d141c'
  g.fillRect(0, 0, S, S)
  for (let i = 0; i < 2600; i++) {
    const v = 14 + Math.random() * 14
    g.fillStyle = `rgba(${v},${v + 6},${v + 12},0.5)`
    g.fillRect(Math.random() * S, Math.random() * S, 2, 2)
  }
  const panels = [
    [8, 8, 240, 300],
    [264, 8, 240, 140],
    [264, 156, 240, 152],
    [8, 316, 496, 188],
  ]
  for (const [x, y, w, h] of panels) {
    const grad = g.createLinearGradient(x, y, x, y + h)
    grad.addColorStop(0, '#1b2836')
    grad.addColorStop(1, '#111a24')
    g.fillStyle = grad
    g.fillRect(x, y, w, h)
    g.strokeStyle = '#05080c'
    g.lineWidth = 4
    g.strokeRect(x, y, w, h)
    g.strokeStyle = 'rgba(120,160,190,0.18)'
    g.lineWidth = 1
    g.strokeRect(x + 3, y + 3, w - 6, h - 6)
    g.fillStyle = '#2a3846'
    for (const [bx, by] of [
      [x + 10, y + 10],
      [x + w - 14, y + 10],
      [x + 10, y + h - 14],
      [x + w - 14, y + h - 14],
    ])
      g.fillRect(bx, by, 4, 4)
  }
  const map = finish(c)

  const [e, eg] = canvas(S)
  eg.fillStyle = '#000'
  eg.fillRect(0, 0, S, S)
  eg.lineCap = 'round'
  // Horizontal light band and circuit traces.
  eg.fillStyle = '#5cf2ff'
  eg.fillRect(8, 330, 496, 5)
  eg.globalAlpha = 0.9
  eg.strokeStyle = '#5cf2ff'
  eg.lineWidth = 2
  for (let i = 0; i < 7; i++) {
    let x = 20 + Math.random() * 470
    let y = 340 + Math.random() * 150
    eg.beginPath()
    eg.moveTo(x, y)
    for (let k = 0; k < 4; k++) {
      if (k % 2) x += (Math.random() - 0.5) * 140
      else y += (Math.random() - 0.5) * 70
      eg.lineTo(Math.max(14, Math.min(498, x)), Math.max(338, Math.min(498, y)))
    }
    eg.stroke()
    eg.fillRect(x - 3, Math.max(338, Math.min(498, y)) - 3, 6, 6)
  }
  eg.globalAlpha = 1
  // Status lights.
  for (let i = 0; i < 5; i++) {
    eg.fillStyle = i === 3 ? '#ff4fd8' : '#7dff9a'
    eg.fillRect(284 + i * 14, 24, 8, 4)
  }
  eg.fillStyle = '#ff9a3c'
  eg.fillRect(24, 24, 3, 60)
  const emissive = finish(e)
  return { map, emissive }
}

export function floorTextures() {
  const S = 512
  const [c, g] = canvas(S)
  g.fillStyle = '#0a0f15'
  g.fillRect(0, 0, S, S)
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      const px = x * 256
      const py = y * 256
      g.fillStyle = (x + y) % 2 ? '#111a23' : '#0f161e'
      g.fillRect(px + 4, py + 4, 248, 248)
      g.strokeStyle = 'rgba(160,200,230,0.07)'
      for (let i = 20; i < 248; i += 20) {
        g.beginPath()
        g.moveTo(px + 4, py + i)
        g.lineTo(px + 252, py + i)
        g.stroke()
      }
    }
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.4})`
    g.fillRect(Math.random() * S, Math.random() * S, 3, 3)
  }
  const map = finish(c)

  const [e, eg] = canvas(S)
  eg.fillStyle = '#000'
  eg.fillRect(0, 0, S, S)
  eg.strokeStyle = 'rgba(92,242,255,0.55)'
  eg.lineWidth = 2
  eg.strokeRect(1, 1, S - 2, S - 2)
  eg.fillStyle = '#5cf2ff'
  for (const [x, y] of [
    [0, 0],
    [S, 0],
    [0, S],
    [S, S],
  ]) {
    eg.beginPath()
    eg.arc(x, y, 7, 0, Math.PI * 2)
    eg.fill()
  }
  const emissive = finish(e)
  return { map, emissive }
}

export function ceilingTextures() {
  const S = 256
  const [c, g] = canvas(S)
  g.fillStyle = '#06090d'
  g.fillRect(0, 0, S, S)
  g.strokeStyle = '#0e151d'
  g.lineWidth = 6
  for (let i = 0; i <= S; i += 64) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i, S)
    g.stroke()
  }
  const map = finish(c)
  const [e, eg] = canvas(S)
  eg.fillStyle = '#000'
  eg.fillRect(0, 0, S, S)
  eg.fillStyle = '#bff8ff'
  eg.fillRect(S / 2 - 70, S / 2 - 5, 140, 10)
  const emissive = finish(e)
  return { map, emissive }
}

/** Soft round glow used for halos, muzzle flash and particles. */
export function glowTexture(color = '#ffffff') {
  const S = 128
  const [c, g] = canvas(S)
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0, color)
  grad.addColorStop(0.25, color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  return finish(c)
}

/** Procedural creature for monsters that have no artwork yet. */
export function glitchCreature(name: string, color: string) {
  const S = 256
  const [c, g] = canvas(S)
  let seed = [...name].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) >>> 0
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  g.translate(S / 2, S / 2)
  g.shadowColor = color
  g.shadowBlur = 24
  // Symmetric body made of jittered polygons.
  for (let layer = 0; layer < 3; layer++) {
    g.beginPath()
    const pts = 7 + Math.floor(rnd() * 5)
    const R = 92 - layer * 26
    const half: [number, number][] = []
    for (let i = 0; i <= pts; i++) {
      const a = -Math.PI / 2 + (i / pts) * Math.PI
      const r = R * (0.55 + rnd() * 0.45)
      half.push([Math.cos(a) * r, Math.sin(a) * r])
    }
    g.moveTo(half[0][0], half[0][1])
    for (const [x, y] of half) g.lineTo(x, y)
    for (let i = half.length - 1; i >= 0; i--) g.lineTo(-half[i][0], half[i][1])
    g.closePath()
    g.fillStyle = layer === 0 ? 'rgba(10,14,22,0.92)' : layer === 1 ? color : '#ffffff'
    g.globalAlpha = layer === 1 ? 0.55 : 1
    g.fill()
    g.globalAlpha = 1
    g.strokeStyle = color
    g.lineWidth = 3
    g.stroke()
  }
  // Eyes.
  g.shadowBlur = 16
  g.fillStyle = '#fff'
  const eyes = 1 + Math.floor(rnd() * 3)
  for (let i = 0; i < eyes; i++) {
    const ex = 14 + i * 16
    const ey = -20 + rnd() * 16
    g.beginPath()
    g.arc(ex, ey, 6, 0, Math.PI * 2)
    g.arc(-ex, ey, 6, 0, Math.PI * 2)
    g.fill()
  }
  // Glitch slices.
  g.setTransform(1, 0, 0, 1, 0, 0)
  for (let i = 0; i < 6; i++) {
    const y = Math.floor(rnd() * S)
    const h = 3 + Math.floor(rnd() * 8)
    const dx = Math.floor((rnd() - 0.5) * 30)
    const slice = g.getImageData(0, y, S, h)
    g.putImageData(slice, dx, y)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function labelTexture(text: string, color: string) {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 96
  const ctx = c.getContext('2d')!
  ctx.font = '600 44px "Share Tech Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = color
  ctx.shadowBlur = 14
  ctx.fillStyle = color
  ctx.fillText(text, 256, 48)
  ctx.shadowBlur = 0
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, 256, 48)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Light-independent metal look for the first-person weapon. */
export function metalMatcap(tint = '#5a7590') {
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
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
