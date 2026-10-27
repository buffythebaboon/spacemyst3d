// The heads-up display: bars, action bar, statuses, minimap, log, toasts and announcements.
import { activeWeapon } from '../../shared/character.ts'
import { CELL, SECTOR_COLORS, SECTOR_NAMES, toCell, xpToNext } from '../../shared/constants.ts'
import { WEAPONS, type WeaponType } from '../../shared/items.ts'
import { MF, STATUS_INFO, type MonsterNet, type StatusId } from '../../shared/protocol.ts'
import { MAX_ACTIVE_QUESTS } from '../../shared/quests.ts'
import { SPELL_BY_ID } from '../../shared/spells.ts'
import { DOOR, FAKE, GATE, HUB_NAMES, VAULT, WALL } from '../../shared/world.ts'
import { icon } from './art/icons.ts'
import { monsterName } from './entities.ts'
import { S, itemIcon, itemName, stackCount, stackIcon, stackName } from './state.ts'
import type { WorldView } from './world.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export const el = {
  hud: $('hud'),
  menu: $('menu'),
  login: $<HTMLFormElement>('login'),
  name: $<HTMLInputElement>('name'),
  pass: $<HTMLInputElement>('pass'),
  play: $<HTMLButtonElement>('play'),
  menuStatus: $('menu-status'),
  crosshair: $('crosshair'),
  charge: $('charge'),
  chargeFill: $('charge-fill'),
  prompt: $('prompt'),
  target: $('target'),
  targetName: $('target-name'),
  targetFill: $('target-fill'),
  targetTags: $('target-tags'),
  bossbar: $('bossbar'),
  bossName: $('boss-name'),
  bossFill: $('boss-fill'),
  banner: $('banner'),
  hudName: $('hud-name'),
  hudLevel: $('hud-level'),
  hudSector: $('hud-sector'),
  corruption: $('corruption'),
  corruptionFill: $('corruption-fill'),
  corruptionText: $('corruption-text'),
  creditsIcon: $<HTMLImageElement>('credits-icon'),
  credits: $('hud-credits'),
  tracker: $('tracker'),
  minimap: $<HTMLCanvasElement>('minimap'),
  online: $('online'),
  statuses: $('statuses'),
  xpFill: $('xp-fill'),
  xpText: $('xp-text'),
  hpFill: $('hp-fill'),
  hpText: $('hp-text'),
  manaFill: $('mana-fill'),
  manaText: $('mana-text'),
  spells: $('spells'),
  weapon: $('weapon'),
  quick: $('quick'),
  dash: $('dash'),
  log: $('log'),
  chat: $<HTMLInputElement>('chat'),
  toasts: $('toasts'),
  announce: $('announce'),
  vignette: $('vignette'),
  dead: $('dead'),
  deadMsg: $('dead-msg'),
  deadTimer: $('dead-timer'),
  paused: $('paused'),
  scoreboard: $('scoreboard'),
  fps: $('fps'),
  panels: $('panels'),
  tooltip: $('tooltip'),
}

el.creditsIcon.src = icon('item:credits')

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export { escapeHtml }

// --- Log, toasts, announcements -------------------------------------------------------------------
export function log(text: string, cls = 'sys') {
  const d = document.createElement('div')
  d.className = cls
  d.textContent = text
  el.log.appendChild(d)
  while (el.log.children.length > 60) el.log.firstChild?.remove()
}

let lastToast = ''
let lastToastAt = 0
export function toast(text: string, cls = '') {
  const t = performance.now()
  if (text === lastToast && t - lastToastAt < 1200) return
  lastToast = text
  lastToastAt = t
  const d = document.createElement('div')
  d.className = `toast ${cls}`
  d.textContent = text
  el.toasts.appendChild(d)
  setTimeout(() => d.remove(), 3300)
  while (el.toasts.children.length > 4) el.toasts.firstChild?.remove()
}

export function announce(big: string, sub = '', color = '#5cf2ff') {
  el.announce.innerHTML = ''
  const b = document.createElement('div')
  b.className = 'big'
  b.style.color = color
  b.style.textShadow = `0 0 18px ${color}`
  b.textContent = big
  el.announce.appendChild(b)
  if (sub) {
    const s = document.createElement('div')
    s.className = 'sub'
    s.textContent = sub
    el.announce.appendChild(s)
  }
}

// --- Action bar ------------------------------------------------------------------------------------
interface SlotEls {
  root: HTMLDivElement
  img: HTMLImageElement
  key: HTMLSpanElement
  num: HTMLSpanElement
  cd: HTMLDivElement
  cdt: HTMLDivElement
  src: string
  ready: boolean
}

function makeSlot(parent: HTMLElement, key: string): SlotEls {
  const root = document.createElement('div')
  root.className = 'slot'
  const img = document.createElement('img')
  img.alt = ''
  const k = document.createElement('span')
  k.className = 'key'
  k.textContent = key
  const num = document.createElement('span')
  num.className = 'num'
  const cd = document.createElement('div')
  cd.className = 'cd'
  const cdt = document.createElement('div')
  cdt.className = 'cdt'
  root.append(img, cd, cdt, k, num)
  parent.appendChild(root)
  return { root, img, key: k, num, cd, cdt, src: '', ready: true }
}

const SPELL_KEYS = ['Q', 'E', 'R', 'F']
const spellSlots = SPELL_KEYS.map((k) => makeSlot(el.spells, k))
spellSlots[0].root.title = 'Q or right mouse'
const weaponMain = makeSlot(el.weapon, 'LMB')
const weaponAlt = makeSlot(el.weapon, 'X')
weaponAlt.root.classList.add('alt')
const quickSlots = [1, 2, 3, 4].map((k) => makeSlot(el.quick, String(k)))
const grenadeSlot = makeSlot(el.quick, 'G')
const dashSlot = makeSlot(el.dash, 'SPACE')
dashSlot.key.style.fontSize = '9px'

function setImg(s: SlotEls, src: string) {
  if (s.src === src) return
  s.src = src
  s.img.src = src
  s.img.style.visibility = src ? 'visible' : 'hidden'
}

function setCd(s: SlotEls, left: number, total: number) {
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0
  s.cd.style.height = `${frac * 100}%`
  s.cdt.textContent = left > 0.05 ? (left >= 10 ? String(Math.ceil(left)) : left.toFixed(1)) : ''
  const ready = left <= 0.05
  if (ready && !s.ready) {
    s.root.classList.remove('ready')
    void s.root.offsetWidth
    s.root.classList.add('ready')
  }
  s.ready = ready
}

/** Tracks the longest cooldown seen per slot, to draw the sweep. */
const cdMax = [0, 0, 0, 0]
let dashMax = 2.5

export function updateHud() {
  const you = S.you
  const char = S.char
  const stats = S.stats
  if (!you || !char || !stats) return
  el.hudName.textContent = char.name
  el.hudLevel.textContent = `LV ${you.level}`
  el.hpFill.style.width = `${(you.hp / Math.max(1, you.maxHp)) * 100}%`
  el.hpText.textContent = `${Math.max(0, Math.ceil(you.hp))} / ${you.maxHp} HP`
  el.manaFill.style.width = `${(you.mana / Math.max(1, you.maxMana)) * 100}%`
  el.manaText.textContent = `${Math.floor(you.mana)} / ${you.maxMana} MANA`
  const need = xpToNext(you.level)
  el.xpFill.style.width = you.level >= 30 ? '100%' : `${(you.xp / need) * 100}%`
  el.xpText.textContent = you.level >= 30 ? 'MAX LEVEL' : `${you.xp} / ${need} XP`
  el.credits.textContent = you.credits.toLocaleString('en-US')

  // Spells.
  for (let i = 0; i < 4; i++) {
    const s = spellSlots[i]
    const id = char.spells[i]
    const def = id ? SPELL_BY_ID[id] : null
    setImg(s, def ? icon(`spell:${def.id}`) : '')
    s.root.classList.toggle('empty', !def)
    const left = you.cd[i] ?? 0
    if (left > cdMax[i] || left <= 0.05) cdMax[i] = left
    setCd(s, left, cdMax[i])
    const cost = def ? Math.round(def.mana * stats.spellCost) : 0
    s.num.className = 'cost'
    s.num.textContent = def ? String(cost) : ''
    s.root.classList.toggle('nomana', !!def && you.mana < cost)
    s.root.title = def ? `${def.name} (${SPELL_KEYS[i]}${i === 0 ? ' or right mouse' : ''}): ${def.desc}` : 'Empty spell slot. Open the spellbook (B) to fill it.'
  }

  // Weapons.
  const w = activeWeapon(char)
  const other = char.active === 0 ? char.equipment.weapon2 : char.equipment.weapon
  setImg(weaponMain, w ? itemIcon(w) : icon('weapon:laser'))
  weaponMain.root.title = w ? itemName(w) : 'Pocket Laser'
  setImg(weaponAlt, other ? itemIcon(other) : '')
  weaponAlt.root.title = other ? `Swap to ${itemName(other)} (X)` : 'No second weapon'
  const def = WEAPONS[(w?.base ?? 'laser') as WeaponType]
  setCd(weaponMain, def.mode === 'charge' ? 0 : you.fire, def.interval)

  // Quickbar and grenade.
  for (let i = 0; i < 4; i++) {
    const s = quickSlots[i]
    const key = char.quickbar[i]
    if (!key) {
      setImg(s, '')
      s.num.textContent = ''
      s.root.classList.add('empty')
      s.root.title = 'Empty quickbar slot. Assign potions from the inventory (I).'
      continue
    }
    const n = stackCount(key)
    setImg(s, stackIcon(key))
    s.num.textContent = String(n)
    s.root.classList.toggle('empty', n === 0)
    s.root.title = stackName(key)
    setCd(s, you.potion, 0.8)
  }
  const gkey = `grenade:${char.grenade}`
  const gn = stackCount(gkey)
  const anyGrenade = char.inventory.find((it) => it?.kind === 'grenade')
  setImg(grenadeSlot, gn ? stackIcon(gkey) : anyGrenade ? itemIcon(anyGrenade) : icon(`item:grenade_${char.grenade}`))
  grenadeSlot.num.textContent = String(gn || char.inventory.reduce((t, it) => (it?.kind === 'grenade' ? t + it.qty : t), 0))
  grenadeSlot.root.classList.toggle('empty', !anyGrenade)
  grenadeSlot.root.title = `Throw a grenade (G): ${stackName(gkey)}`
  setCd(grenadeSlot, you.potion, 0.8)

  if (you.dash > dashMax || you.dash <= 0.05) dashMax = Math.max(0.5, you.dash || stats.dashCooldown)
  setImg(dashSlot, icon('status:haste'))
  setCd(dashSlot, you.dash, dashMax)
  dashSlot.root.title = 'Dash (Space): a quick burst of speed that dodges attacks.'

  updateStatuses()
  updateWhere()
  updateTracker()
  updateBanner()
  el.vignette.style.opacity = String(you.dead ? 0 : Math.min(0.6, hurtFlash * 0.5 + (you.hp / you.maxHp < 0.25 ? 0.25 + Math.sin(performance.now() / 160) * 0.1 : 0)))
}

let hurtFlash = 0
export function hurt(amount: number) {
  hurtFlash = Math.min(1, hurtFlash + 0.25 + amount)
}
export function tickHud(dt: number) {
  hurtFlash = Math.max(0, hurtFlash - dt * 1.4)
}

let statusKey = ''
function updateStatuses() {
  const list = S.you?.status ?? []
  const key = list.map(([s, t]) => `${s}${Math.ceil(t)}`).join(',')
  if (key === statusKey) return
  statusKey = key
  el.statuses.innerHTML = ''
  for (const [s, t] of list) {
    const info = STATUS_INFO[s as StatusId]
    if (!info) continue
    const d = document.createElement('div')
    d.className = `status ${info.good ? 'good' : 'bad'}`
    d.title = info.name
    d.innerHTML = `<img alt="" src="${icon(`status:${s}`)}"><span>${t >= 1 ? Math.ceil(t) : ''}</span>`
    el.statuses.appendChild(d)
  }
}

let whereKey = ''
let currentSector = -1
let currentHub = -1
export const where = () => ({ sector: currentSector, hub: currentHub })

export function setWhere(sector: number, hub: number) {
  currentSector = sector
  currentHub = hub
}

function updateWhere() {
  const st = S.state
  if (!st) return
  const s = currentSector
  const hub = currentHub >= 0 ? S.world?.hubs[currentHub] : null
  const corr = s >= 0 && s < 3 ? st.corruption[s] : 0
  const key = `${s}|${hub?.id ?? ''}|${corr.toFixed(3)}`
  if (key === whereKey) return
  whereKey = key
  el.hudSector.textContent = hub ? `${HUB_NAMES[hub.id] ?? 'Hub'} · safe zone` : s >= 0 ? SECTOR_NAMES[s] : ''
  el.hudSector.style.color = hub ? '#ffcf8f' : SECTOR_COLORS[Math.max(0, s)]
  const show = s >= 0 && s < 3
  el.corruption.classList.toggle('hidden', !show)
  if (show) {
    el.corruptionFill.style.width = `${corr * 100}%`
    el.corruptionText.textContent = corr > 0 ? `CORRUPTION ${Math.ceil(corr * 100)}%` : 'PURGED · GATE OPEN'
  }
}

let trackerKey = ''
function updateTracker() {
  const char = S.char
  if (!char) return
  const daily = S.daily
  const key = JSON.stringify([char.quests.map((q) => [q.id, q.progress]), char.daily.progress, char.daily.done])
  if (key === trackerKey) return
  trackerKey = key
  const rows: string[] = []
  for (const q of char.quests) {
    const done = q.progress >= q.goal
    rows.push(`<div class="q ${done ? 'done' : ''}"><b>${escapeHtml(q.title)}</b> <span>${Math.min(q.progress, q.goal)}/${q.goal}</span></div>`)
  }
  if (!char.quests.length) rows.push(`<div class="q"><span>No quests. Visit a hub quest board (max ${MAX_ACTIVE_QUESTS}).</span></div>`)
  daily.forEach((d, i) => {
    if (char.daily.done[i]) return
    rows.push(`<div class="q"><span>Daily: ${escapeHtml(d.text)} ${Math.min(char.daily.progress[i] ?? 0, d.goal)}/${d.goal}</span></div>`)
  })
  el.tracker.innerHTML = rows.join('')
}

function updateBanner() {
  const st = S.state
  const you = S.you
  if (!st || !you) return
  if (you.seasonEnds > 0) {
    el.banner.className = 'season'
    el.banner.textContent = `THE MAINFRAME HAS FALLEN · The network rebuilds in ${Math.ceil(you.seasonEnds)}s`
    return
  }
  if (st.event) {
    const left = Math.max(0, st.event.until - (S.serverTime + (performance.now() / 1000 - S.snapAt)))
    const names: Record<string, string> = { outage: 'POWER OUTAGE', outbreak: 'OUTBREAK', zeroday: 'ZERO-DAY EXPLOIT', rootkit: 'ROOTKIT DRAGON' }
    el.banner.className = ''
    el.banner.textContent = `${names[st.event.kind] ?? st.event.kind.toUpperCase()} in the ${SECTOR_NAMES[st.event.sector]} · ${Math.ceil(left)}s`
    return
  }
  el.banner.className = 'hidden'
}

// --- Crosshair, prompt, target, boss --------------------------------------------------------------
export function setCrosshair(mode: '' | 'hot' | 'use') {
  el.crosshair.classList.toggle('hot', mode === 'hot')
  el.crosshair.classList.toggle('use', mode === 'use')
}

export function hitMarker() {
  el.crosshair.classList.add('hitmark')
  setTimeout(() => el.crosshair.classList.remove('hitmark'), 90)
}

export function setPrompt(text: string, far = false) {
  el.prompt.classList.toggle('hidden', !text)
  if (text) {
    el.prompt.textContent = far ? `${text} (move closer)` : `[Click] ${text}`
    el.prompt.classList.toggle('far', far)
  }
}

export function setCharge(frac: number) {
  el.charge.classList.toggle('hidden', frac <= 0)
  el.chargeFill.style.width = `${Math.min(1, frac) * 100}%`
}

export function setTarget(m: MonsterNet | null) {
  if (!m || (m.f & MF.boss) !== 0) {
    el.target.classList.add('hidden')
    return
  }
  el.target.classList.remove('hidden')
  el.targetName.textContent = `${monsterName(m)} · ${m.lv}`
  el.targetName.style.color = (m.f & MF.ally) !== 0 ? '#7dff9a' : m.e ? '#ffd34d' : '#ff9aa9'
  el.targetFill.style.width = `${(m.hp / m.mhp) * 100}%`
  const tags: string[] = []
  if ((m.f & MF.ally) !== 0) tags.push('ALLY')
  if ((m.f & MF.shield) !== 0) tags.push(`SHIELD ${Math.round((m.sh ?? 0) * 100)}%`)
  if ((m.f & MF.distress) !== 0) tags.push('CALLING FOR HELP')
  if ((m.f & MF.fuse) !== 0) tags.push(`FUSE ${(m.t ?? 0).toFixed(1)}s`)
  el.targetTags.textContent = tags.join(' · ')
}

export function setBoss(m: MonsterNet | null) {
  el.bossbar.classList.toggle('hidden', !m)
  if (!m) return
  el.bossName.textContent = `${monsterName(m).toUpperCase()}${m.ph ? ` · PHASE ${m.ph}` : ''}`
  el.bossFill.style.width = `${(m.hp / m.mhp) * 100}%`
}

// --- Death ---------------------------------------------------------------------------------------------
export function showDeath(msg: string) {
  el.deadMsg.textContent = msg
  el.dead.classList.remove('hidden')
}
export function hideDeath() {
  el.dead.classList.add('hidden')
}

// --- Scoreboard -----------------------------------------------------------------------------------------
export function showScoreboard() {
  const rows = [...S.players.values()]
    .sort((a, b) => b.level - a.level || b.kills - a.kills)
    .map((p) => {
      const hue = Math.round(p.hue * 360)
      return `<tr><td style="color:hsl(${hue},90%,65%)">${escapeHtml(p.name)}${p.id === S.myId ? ' (you)' : ''}</td><td>${p.level}</td><td>${p.kills}</td><td>${'★'.repeat(Math.min(5, p.badges))}</td><td>${p.dead ? 'crashed' : `${p.hp}/${p.maxHp}`}</td></tr>`
    })
    .join('')
  el.scoreboard.innerHTML = `<h3>HACKERS ONLINE · SEASON ${S.state?.season ?? 1}</h3><table><tr><th>Name</th><th>Level</th><th>Kills</th><th>Seasons</th><th>HP</th></tr>${rows}</table>`
  el.scoreboard.classList.remove('hidden')
}

// --- Minimap ------------------------------------------------------------------------------------------
const FLOOR_TINT = ['#0f3a44', '#0f3a20', '#3d0f20', '#4a4636']

/** Paints the map: explored cells, gates, vaults, hubs, players and nearby monsters. */
export function drawMap(
  canvas: HTMLCanvasElement,
  world: WorldView,
  me: { x: number; z: number; yaw: number },
  opts: { radius?: number; full?: boolean; monsters?: MonsterNet[]; markers?: { x: number; z: number; color: string; label?: string }[] },
) {
  const g = canvas.getContext('2d')!
  const W = canvas.width
  const info = world.info
  const full = !!opts.full
  const cells = full ? info.width : (opts.radius ?? 13) * 2
  const scale = W / cells
  g.clearRect(0, 0, W, W)
  g.save()
  if (!full) {
    g.beginPath()
    g.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2)
    g.clip()
    g.fillStyle = 'rgba(0,8,14,0.75)'
    g.fillRect(0, 0, W, W)
  } else {
    g.fillStyle = '#01060a'
    g.fillRect(0, 0, W, W)
  }
  const cx = me.x / CELL
  const cz = me.z / CELL
  const ox = full ? 0 : cx - cells / 2
  const oz = full ? 0 : cz - cells / 2
  const toX = (wx: number) => (wx - ox) * scale
  const toZ = (wz: number) => (wz - oz) * scale
  const x0 = Math.max(0, Math.floor(ox))
  const z0 = Math.max(0, Math.floor(oz))
  const x1 = Math.min(info.width - 1, Math.ceil(ox + cells))
  const z1 = Math.min(info.height - 1, Math.ceil(oz + cells))
  const grid = world.grid
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const i = z * info.width + x
      if (!world.explored[i]) continue
      const code = info.cells[i]
      let color: string | null = null
      if (code === WALL || (code === FAKE && !grid.fakeOpen[i])) color = full ? '#1c2a36' : '#22313f'
      else if (code === GATE) color = grid.gateOpen[i] ? '#2a7a4a' : SECTOR_COLORS[info.gates.find((gt) => gt.cell === i)?.sector ?? 0]
      else if (code === VAULT) color = grid.vaultOpen[i] ? '#2a7a4a' : '#c77dff'
      else if (code === DOOR) color = '#6a8aa0'
      else color = grid.hubAt[i] ? '#5a4024' : FLOOR_TINT[info.sector[i]]
      g.fillStyle = color
      g.fillRect(toX(x), toZ(z), scale + 0.6, scale + 0.6)
    }
  // Hubs and arenas the player has seen.
  for (const h of info.hubs) {
    if (!world.explored[Math.round(h.cz) * info.width + Math.round(h.cx)]) continue
    dot(g, toX(h.cx + 0.5), toZ(h.cz + 0.5), Math.max(3, scale * 0.9), '#ffb347')
  }
  for (const a of info.arenas) {
    if (!world.explored[Math.round(a.cz) * info.width + Math.round(a.cx)]) continue
    const alive = S.state?.bosses[a.id]?.alive
    dot(g, toX(a.cx + 0.5), toZ(a.cz + 0.5), Math.max(3, scale * 0.9), alive ? '#ff3b5c' : '#55606a')
  }
  for (const mk of opts.markers ?? []) {
    dot(g, toX(mk.x / CELL), toZ(mk.z / CELL), Math.max(3, scale * 0.5), mk.color)
    if (mk.label && full) {
      g.fillStyle = mk.color
      g.font = `${Math.max(10, scale * 1.4)}px "Share Tech Mono", monospace`
      g.fillText(mk.label, toX(mk.x / CELL) + 6, toZ(mk.z / CELL) + 4)
    }
  }
  for (const m of opts.monsters ?? []) {
    if (m.f & (MF.hidden | MF.invisible) && !(m.f & MF.revealed)) continue
    const color = m.f & MF.ally ? '#7dff9a' : m.f & MF.boss ? '#ff2a2a' : m.e ? '#ffd34d' : '#ff5c7a'
    dot(g, toX(m.x / CELL), toZ(m.z / CELL), Math.max(2, scale * (m.f & MF.boss ? 0.6 : 0.3)), color)
  }
  for (const p of S.players.values()) {
    if (p.id === S.myId || p.dead) continue
    dot(g, toX(p.x / CELL), toZ(p.z / CELL), Math.max(2.5, scale * 0.4), `hsl(${Math.round(p.hue * 360)},90%,65%)`)
  }
  // You: an arrow.
  const px = toX(cx)
  const pz = toZ(cz)
  g.translate(px, pz)
  g.rotate(-me.yaw)
  g.fillStyle = '#5cf2ff'
  g.shadowColor = '#5cf2ff'
  g.shadowBlur = 8
  const s = Math.max(6, scale * 0.8)
  g.beginPath()
  g.moveTo(0, -s)
  g.lineTo(s * 0.65, s * 0.7)
  g.lineTo(0, s * 0.35)
  g.lineTo(-s * 0.65, s * 0.7)
  g.closePath()
  g.fill()
  g.restore()
  if (!full) {
    g.strokeStyle = 'rgba(92,242,255,0.35)'
    g.lineWidth = 2
    g.beginPath()
    g.arc(W / 2, W / 2, W / 2 - 1, 0, Math.PI * 2)
    g.stroke()
  }
}

function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  g.fillStyle = color
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fill()
}

export const cellOf = (x: number) => toCell(x)
