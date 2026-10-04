import { CELL, toCell } from '../../shared/constants.ts'
import type { PlayerState } from '../../shared/protocol.ts'
import type { MonsterView, PlayerView } from './entities.ts'
import type { World } from './world.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export const el = {
  hud: $('hud'),
  menu: $('menu'),
  name: $<HTMLInputElement>('name'),
  play: $<HTMLButtonElement>('play'),
  menuStatus: $('menu-status'),
  crosshair: $('crosshair'),
  log: $('log'),
  chat: $<HTMLInputElement>('chat'),
  scoreboard: $('scoreboard'),
  vignette: $('vignette'),
  dead: $('dead'),
  deadMsg: $('dead-msg'),
  paused: $('paused'),
  target: $('target'),
  targetName: $('target-name'),
  targetFill: $('target-fill'),
  minimap: $<HTMLCanvasElement>('minimap'),
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function log(text: string, cls = 'sys') {
  const div = document.createElement('div')
  div.className = cls
  div.innerHTML = escapeHtml(text)
  el.log.appendChild(div)
  while (el.log.children.length > 9) el.log.firstElementChild!.remove()
}

export function updateStats(me: PlayerState, online: number) {
  $('hud-name').textContent = me.name
  $('hud-level').textContent = String(me.level)
  $('hud-coins').textContent = String(me.coins)
  $('hud-kills').textContent = String(me.kills)
  $('hud-online').textContent = String(online)
  $('hp-fill').style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`
  $('hp-text').textContent = `HP ${Math.max(0, me.hp)} / ${me.maxHp}`
  $('mana-fill').style.width = `${(me.mana / me.maxMana) * 100}%`
  $('mana-text').textContent = `MANA ${me.mana} / ${me.maxMana}`
}

export function showScoreboard(players: PlayerState[]) {
  const rows = [...players]
    .sort((a, b) => b.level - a.level || b.kills - a.kills)
    .map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.level}</td><td>${p.kills}</td><td>${p.coins}</td></tr>`)
    .join('')
  el.scoreboard.innerHTML = `<h3>UPPKOPPLADE</h3><table><tr><th>Namn</th><th>Nivå</th><th>Kills</th><th>Krediter</th></tr>${rows}</table>`
}

/** Heading-up radar: explored maze, nearby monsters and other players. */
export function drawMinimap(
  world: World,
  x: number,
  z: number,
  yaw: number,
  monsters: Iterable<MonsterView>,
  players: Iterable<PlayerView>,
) {
  const c = el.minimap
  const g = c.getContext('2d')!
  const S = c.width
  const px = 7 // pixels per cell
  const R = Math.ceil(S / px / 2) + 2
  g.clearRect(0, 0, S, S)
  g.save()
  g.beginPath()
  g.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2)
  g.clip()
  g.fillStyle = 'rgba(0,8,14,0.85)'
  g.fillRect(0, 0, S, S)
  g.translate(S / 2, S / 2)
  g.rotate(yaw)
  const scale = px / CELL
  const pcx = toCell(x)
  const pcz = toCell(z)
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      const cx = pcx + dx
      const cz = pcz + dz
      if (cx < 0 || cz < 0 || cx >= world.width || cz >= world.height) continue
      if (!world.explored[cz * world.width + cx]) continue
      const sx = (cx * CELL - x) * scale
      const sz = (cz * CELL - z) * scale
      g.fillStyle = world.isWall(cx, cz) ? 'rgba(92,242,255,0.55)' : 'rgba(30,60,80,0.55)'
      g.fillRect(sx, sz, px + 0.5, px + 0.5)
    }
  for (const m of monsters) {
    const mx = m.root.position.x
    const mz = m.root.position.z
    if (Math.hypot(mx - x, mz - z) > CELL * 7 || !world.lineOfSight(x, z, mx, mz)) continue
    g.fillStyle = m.state.aggro ? '#ff3b5c' : '#ffb347'
    g.beginPath()
    g.arc((mx - x) * scale, (mz - z) * scale, 3, 0, Math.PI * 2)
    g.fill()
  }
  for (const p of players) {
    g.fillStyle = `#${p.color.getHexString()}`
    g.beginPath()
    g.arc((p.root.position.x - x) * scale, (p.root.position.z - z) * scale, 3.5, 0, Math.PI * 2)
    g.fill()
  }
  g.restore()
  // The player arrow always points up.
  g.fillStyle = '#ffffff'
  g.shadowColor = '#5cf2ff'
  g.shadowBlur = 8
  g.beginPath()
  g.moveTo(S / 2, S / 2 - 7)
  g.lineTo(S / 2 + 5, S / 2 + 5)
  g.lineTo(S / 2, S / 2 + 2)
  g.lineTo(S / 2 - 5, S / 2 + 5)
  g.closePath()
  g.fill()
  g.shadowBlur = 0
}
