// Full-screen panels: inventory, spellbook, talents, map, journal, black market, quest board,
// beacon travel, puzzles, data fragments and settings.
import { activeWeapon, computeStats } from '../../shared/character.ts'
import { MAX_LEVEL, SECTOR_NAMES, xpToNext } from '../../shared/constants.ts'
import { ACHIEVEMENTS } from '../../shared/achievements.ts'
import {
  ARMOR_TIERS,
  IMPLANTS,
  POTIONS,
  RARITY_COLORS,
  RARITY_NAMES,
  WEAPONS,
  armorDefense,
  isStackable,
  itemLines,
  sellPrice,
  stackKey,
  weaponDamage,
  type Item,
  type WeaponType,
} from '../../shared/items.ts'
import { FRAGMENTS } from '../../shared/lore.ts'
import { MONSTERS, type MonsterDef } from '../../shared/monsters.ts'
import type { ShopEntry } from '../../shared/protocol.ts'
import { DAILY_CREDITS, MAX_ACTIVE_QUESTS, type QuestState } from '../../shared/quests.ts'
import { SPELLS, SPELL_BY_ID } from '../../shared/spells.ts'
import { BRANCHES, TALENTS, branchPoints, respecCost, spentPoints, talentBlocker, talentPointsForLevel } from '../../shared/talents.ts'
import { GLYPHS, HUB_NAMES, type WorldObject } from '../../shared/world.ts'
import { icon } from './art/icons.ts'
import { monsterSprite } from './art/monsters.ts'
import { sfx } from './audio.ts'
import { drawMap, el, escapeHtml } from './hud.ts'
import { send } from './net.ts'
import { S, itemIcon, itemName, knownSpellIds, potionKnown, saveSettings, settings, stackCount, stackIcon, stackName, type Settings } from './state.ts'
import type { WorldView } from './world.ts'

export type PanelId = 'inventory' | 'spells' | 'talents' | 'map' | 'journal' | 'shop' | 'board' | 'beacon' | 'cipher' | 'clue' | 'fragment' | 'settings'

interface Open {
  id: PanelId
  root: HTMLDivElement
  body: HTMLDivElement
  render: () => void
}

/** Things the panels need from the game loop. */
export const hooks = {
  world: null as WorldView | null,
  me: () => ({ x: 0, z: 0, yaw: 0 }),
  onClose: (_byKey: boolean) => {},
  onSettings: (_s: Settings) => {},
  logout: () => {},
}

let open: Open | null = null
let tab: Record<string, string> = { journal: 'quests', shop: 'buy' }
let selected: { where: 'inv' | 'eq'; index: number; slot?: string } | null = null
let shopData: { hub: string; stock: ShopEntry[] } | null = null
let boardData: { hub: string; offers: QuestState[] } | null = null
let beaconHub = ''
let cipherObj: WorldObject | null = null
let cipherDials = [0, 0, 0, 0]
let clueObj: WorldObject | null = null
let fragmentIndex = 0
let respecArmed = false

export const isOpen = () => !!open
export const openId = () => open?.id ?? null

// --- Tooltips ---------------------------------------------------------------------------------------
const tips = new WeakMap<Element, () => string>()
function tip(e: Element, html: () => string) {
  tips.set(e, html)
}
document.addEventListener('mouseover', (ev) => {
  let t = ev.target as Element | null
  while (t && !tips.has(t)) t = t.parentElement
  if (!t) {
    el.tooltip.classList.add('hidden')
    return
  }
  el.tooltip.innerHTML = tips.get(t)!()
  el.tooltip.classList.toggle('hidden', !el.tooltip.innerHTML)
})
document.addEventListener('mousemove', (ev) => {
  if (el.tooltip.classList.contains('hidden')) return
  const w = el.tooltip.offsetWidth
  const h = el.tooltip.offsetHeight
  el.tooltip.style.left = `${Math.min(window.innerWidth - w - 8, ev.clientX + 16)}px`
  el.tooltip.style.top = `${Math.min(window.innerHeight - h - 8, ev.clientY + 12)}px`
})

function potionLines(item: Item) {
  if (!potionKnown(item.base)) return ['Unidentified. Drink it to find out what it is, or throw it at something. The first test identifies it for everyone this season.']
  const def = POTIONS[item.base]
  return [def.desc, def.good ? '' : 'From the quickbar it is thrown, not drunk.'].filter(Boolean)
}

export function itemTip(item: Item | null, extra = '') {
  if (!item) return ''
  const color = RARITY_COLORS[item.rarity] ?? '#fff'
  const lines = item.kind === 'potion' ? potionLines(item) : itemLines(item)
  const body = lines
    .map((l) => {
      const cls = l.startsWith('+') ? 'af' : l.startsWith('Legendary') ? 'lg' : 'ln'
      return `<div class="${cls}">${escapeHtml(l)}</div>`
    })
    .join('')
  let cmp = ''
  const char = S.char
  if (char && item.kind === 'weapon') {
    const cur = activeWeapon(char)
    if (cur && cur.id !== item.id) {
      const d = (it: Item) => {
        const def = WEAPONS[it.base as WeaponType]
        const dmg = weaponDamage(it)
        return def.mode === 'charge' ? dmg / (def.interval + (def.charge ?? 0)) : dmg / def.interval
      }
      const diff = Math.round(d(item) - d(cur))
      cmp = `<div class="cmp">Compared with your ${escapeHtml(cur.name)}: ${diff >= 0 ? '+' : ''}${diff} damage per second</div>`
    }
    const def = WEAPONS[item.base as WeaponType]
    if (def && def.minLevel > char.level) cmp += `<div class="cmp" style="color:#ff7d8f">Needs level ${def.minLevel}</div>`
  }
  if (char && item.kind === 'armor' && char.equipment.armor && char.equipment.armor.id !== item.id) {
    const diff = armorDefense(item) - armorDefense(char.equipment.armor)
    cmp = `<div class="cmp">Compared with your ${escapeHtml(char.equipment.armor.name)}: ${diff >= 0 ? '+' : ''}${diff} defence</div>`
  }
  if (char && (item.kind === 'weapon' || item.kind === 'armor' || item.kind === 'implant') && item.level > char.level + 2)
    cmp += `<div class="cmp" style="color:#ff7d8f">Needs level ${item.level - 2}</div>`
  return `<div class="tt" style="color:${color}">${escapeHtml(itemName(item))}${item.qty > 1 ? ` ×${item.qty}` : ''}</div>${body}${cmp}${extra}`
}

// --- Panel frame ----------------------------------------------------------------------------------------
const TITLES: Record<PanelId, string> = {
  inventory: 'INVENTORY',
  spells: 'SPELLBOOK',
  talents: 'TALENTS',
  map: 'NETWORK MAP',
  journal: 'JOURNAL',
  shop: 'BLACK MARKET',
  board: 'QUEST BOARD',
  beacon: 'FAST TRAVEL',
  cipher: 'CIPHER LOCK',
  clue: 'CLUE',
  fragment: 'DATA FRAGMENT',
  settings: 'SETTINGS',
}
const SMALL = new Set<PanelId>(['beacon', 'cipher', 'clue', 'fragment', 'settings'])
const RENDER: Record<PanelId, (body: HTMLDivElement) => void> = {
  inventory: renderInventory,
  spells: renderSpells,
  talents: renderTalents,
  map: renderMap,
  journal: renderJournal,
  shop: renderShop,
  board: renderBoard,
  beacon: renderBeacon,
  cipher: renderCipher,
  clue: renderClue,
  fragment: renderFragment,
  settings: renderSettings,
}

export function openPanel(id: PanelId) {
  if (open?.id === id) {
    open.render()
    return
  }
  closePanel(false, true)
  const root = document.createElement('div')
  root.className = `panel${SMALL.has(id) ? ' small' : ''}`
  const header = document.createElement('header')
  const h = document.createElement('h2')
  h.textContent = TITLES[id]
  const x = document.createElement('button')
  x.className = 'x'
  x.textContent = '✕'
  x.title = 'Close (Esc)'
  x.onclick = () => closePanel(false)
  header.append(h, x)
  const body = document.createElement('div')
  body.className = 'body'
  root.append(header, body)
  el.panels.appendChild(root)
  const render = () => {
    const scroll = body.scrollTop
    RENDER[id](body)
    body.scrollTop = scroll
  }
  open = { id, root, body, render }
  selected = null
  respecArmed = false
  render()
  sfx.uiOpen()
}

export function closePanel(byKey = false, silent = false) {
  if (!open) return
  open.root.remove()
  open = null
  el.tooltip.classList.add('hidden')
  if (!silent) {
    sfx.uiClose()
    hooks.onClose(byKey)
  }
}

export function togglePanel(id: PanelId) {
  if (open?.id === id) closePanel(true)
  else openPanel(id)
}

/** Re-renders the open panel after the character or world changed. */
let refreshTimer = 0
export function refresh() {
  if (!open || refreshTimer) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0
    if (open && open.id !== 'cipher' && open.id !== 'settings') open.render()
  }, 60)
}

type Props<K extends keyof HTMLElementTagNameMap> = Omit<Partial<HTMLElementTagNameMap[K]>, 'style'> & { cls?: string; style?: string }

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props<K>, ...kids: (Node | string)[]) {
  const e = document.createElement(tag)
  const { cls, style, ...rest } = props ?? ({} as Props<K>)
  if (cls) e.className = cls
  if (style) e.style.cssText = style
  Object.assign(e, rest)
  for (const k of kids) e.append(k)
  return e
}

function btn(text: string, onClick: () => void, cls = 'btn', disabled = false) {
  const b = h('button', { cls, textContent: text, disabled })
  b.onclick = (e) => {
    e.stopPropagation()
    sfx.ui()
    onClick()
  }
  return b
}

function tabs(body: HTMLElement, key: string, list: [string, string][]) {
  const bar = h('div', { cls: 'tabs' })
  for (const [id, label] of list) {
    const b = h('button', { textContent: label, cls: tab[key] === id ? 'on' : '' })
    b.onclick = () => {
      tab[key] = id
      sfx.ui()
      open?.render()
    }
    bar.append(b)
  }
  body.append(bar)
}

// --- Inventory ----------------------------------------------------------------------------------------
const EQ_SLOTS: { slot: 'weapon' | 'weapon2' | 'armor' | 'implant0' | 'implant1' | 'implant2'; label: string }[] = [
  { slot: 'weapon', label: 'Weapon 1' },
  { slot: 'weapon2', label: 'Weapon 2' },
  { slot: 'armor', label: 'Armour' },
  { slot: 'implant0', label: 'Implant' },
  { slot: 'implant1', label: 'Implant' },
  { slot: 'implant2', label: 'Implant' },
]

function eqItem(slot: string): Item | null {
  const eq = S.char?.equipment
  if (!eq) return null
  if (slot === 'weapon') return eq.weapon
  if (slot === 'weapon2') return eq.weapon2
  if (slot === 'armor') return eq.armor
  return eq.implants[Number(slot.slice(7))] ?? null
}

function itemCell(item: Item | null, opts: { sel?: boolean } = {}) {
  const c = h('div', { cls: `cell${item ? ` r${item.rarity}` : ''}${opts.sel ? ' sel' : ''}` })
  if (item) {
    c.append(h('img', { src: itemIcon(item), alt: '', draggable: false }))
    if (item.qty > 1) c.append(h('span', { cls: 'num', textContent: String(item.qty) }))
  }
  return c
}

let dragFrom: { where: 'inv' | 'eq'; index: number; slot?: string } | null = null

function renderInventory(body: HTMLDivElement) {
  const char = S.char
  if (!char) return
  body.innerHTML = ''
  const wrap = h('div', { cls: 'inv' })
  const left = h('div')
  left.append(h('h3', { cls: 'sec', textContent: 'EQUIPPED' }))
  const equip = h('div', { cls: 'equip' })
  for (const s of EQ_SLOTS) {
    const item = eqItem(s.slot)
    const active = (s.slot === 'weapon' && char.active === 0) || (s.slot === 'weapon2' && char.active === 1)
    const cell = itemCell(item, { sel: selected?.where === 'eq' && selected.slot === s.slot })
    if (active) cell.style.boxShadow = '0 0 0 2px #5cf2ff'
    cell.draggable = !!item
    cell.ondragstart = () => (dragFrom = { where: 'eq', index: -1, slot: s.slot })
    cell.ondragover = (e) => e.preventDefault()
    cell.ondrop = (e) => {
      e.preventDefault()
      if (dragFrom?.where === 'inv') send({ t: 'inv', op: 'equip', from: dragFrom.index })
      dragFrom = null
    }
    cell.onclick = () => {
      selected = item ? { where: 'eq', index: -1, slot: s.slot } : null
      open?.render()
    }
    cell.oncontextmenu = (e) => {
      e.preventDefault()
      if (item) send({ t: 'inv', op: 'unequip', slot: s.slot })
    }
    tip(cell, () => (item ? itemTip(item, active ? '<div class="cmp">Active weapon</div>' : '') : `<div class="muted">${s.label}: empty</div>`))
    equip.append(h('div', { cls: 'eslot' }, cell, `${s.label}${active ? ' ●' : ''}`))
  }
  left.append(equip)
  left.append(h('h3', { cls: 'sec', textContent: 'QUICKBAR (1–4)' }))
  const qbar = h('div', { cls: 'qbar' })
  char.quickbar.forEach((key, i) => {
    const c = h('div', { cls: 'cell' })
    if (key) {
      c.append(h('img', { src: stackIcon(key), alt: '' }))
      c.append(h('span', { cls: 'num', textContent: String(stackCount(key)) }))
    }
    c.ondragover = (e) => e.preventDefault()
    c.ondrop = (e) => {
      e.preventDefault()
      if (dragFrom?.where === 'inv') {
        const it = char.inventory[dragFrom.index]
        const k = it ? stackKey(it) : null
        if (it && k && (it.kind === 'potion' || it.kind === 'grenade')) send({ t: 'inv', op: 'quick', slot: i, key: k })
      }
      dragFrom = null
    }
    c.oncontextmenu = (e) => {
      e.preventDefault()
      send({ t: 'inv', op: 'quick', slot: i, key: null })
    }
    tip(c, () => (key ? `<div class="tt">${i + 1}: ${escapeHtml(stackName(key))}</div><div class="muted">Right-click to clear. Drag a potion or grenade here to assign it.</div>` : `<div class="muted">Slot ${i + 1}: drag a potion or grenade here.</div>`))
    qbar.append(c)
  })
  left.append(qbar)
  const stats = computeStats(char)
  const w = activeWeapon(char)
  const wdef = WEAPONS[(w?.base ?? 'laser') as WeaponType]
  const dps = w ? (weaponDamage(w) * stats.damage) / (wdef.interval / stats.fireRate) : 0
  left.append(h('h3', { cls: 'sec', textContent: 'STATS' }))
  const st = h('div', { cls: 'stats' })
  const rows: [string, string][] = [
    ['Level', `${char.level}${char.level < MAX_LEVEL ? ` (${char.xp}/${xpToNext(char.level)} XP)` : ''}`],
    ['Max HP', String(stats.maxHp)],
    ['Max mana', `${stats.maxMana} (+${stats.manaRegen.toFixed(1)}/s)`],
    ['Defence', `${stats.defense} (${Math.round((1 - stats.armorFactor) * 100)}% less damage)`],
    ['Weapon damage', `${Math.round(dps)} per second`],
    ['Critical', `${Math.round(stats.critChance * 100)}% for ${Math.round(stats.critDamage * 100)}%`],
    ['Spell power', `${Math.round(stats.spellPower * 100)}%`],
    ['Move speed', `${Math.round(stats.moveSpeed * 100)}%`],
    ['Resist laser / EMP / heat', `${Math.round((1 - stats.resist.laser) * 100)}% / ${Math.round((1 - stats.resist.emp) * 100)}% / ${Math.round((1 - stats.resist.heat) * 100)}%`],
    ['Credits', char.credits.toLocaleString('en-US')],
  ]
  for (const [k, v] of rows) st.append(h('div', {}, h('span', { textContent: k }), h('b', { textContent: v })))
  left.append(st)

  const right = h('div')
  right.append(h('h3', { cls: 'sec', textContent: `BACKPACK · ${char.inventory.filter(Boolean).length}/${char.inventory.length}` }))
  const grid = h('div', { cls: 'grid' })
  char.inventory.forEach((item, i) => {
    const cell = itemCell(item, { sel: selected?.where === 'inv' && selected.index === i })
    cell.draggable = !!item
    cell.ondragstart = () => (dragFrom = { where: 'inv', index: i })
    cell.ondragover = (e) => {
      e.preventDefault()
      cell.classList.add('drop')
    }
    cell.ondragleave = () => cell.classList.remove('drop')
    cell.ondrop = (e) => {
      e.preventDefault()
      cell.classList.remove('drop')
      if (dragFrom?.where === 'inv' && dragFrom.index !== i) send({ t: 'inv', op: 'move', from: dragFrom.index, to: i })
      else if (dragFrom?.where === 'eq' && dragFrom.slot) send({ t: 'inv', op: 'unequip', slot: dragFrom.slot as 'weapon' })
      dragFrom = null
    }
    cell.onclick = () => {
      selected = item ? { where: 'inv', index: i } : null
      open?.render()
    }
    cell.oncontextmenu = (e) => {
      e.preventDefault()
      if (!item) return
      if (item.kind === 'weapon' || item.kind === 'armor' || item.kind === 'implant') send({ t: 'inv', op: 'equip', from: i })
      else if (item.kind === 'potion') send({ t: 'inv', op: 'use', from: i })
      else if (item.kind === 'grenade') send({ t: 'inv', op: 'grenade', key: item.base })
    }
    tip(cell, () => (item ? itemTip(item, '<div class="cmp">Click for actions · right-click to equip or use · drag to move</div>') : ''))
    grid.append(cell)
  })
  right.append(grid)
  right.append(itemActions())
  right.append(h('p', { cls: 'muted', textContent: 'Equipping a weapon replaces the active one. Swap weapons with X to fill the other slot. Personal loot only you can see drops from your kills and chests.', style: 'font-size:12px' }))
  wrap.append(left, right)
  body.append(wrap)
}

function itemActions() {
  const box = h('div', { cls: 'actions' })
  const char = S.char
  if (!selected || !char) return box
  if (selected.where === 'eq' && selected.slot) {
    const slot = selected.slot as 'weapon'
    const item = eqItem(slot)
    if (!item) return box
    box.append(h('span', { textContent: itemName(item), style: `color:${RARITY_COLORS[item.rarity]};align-self:center` }))
    box.append(btn('Unequip', () => send({ t: 'inv', op: 'unequip', slot })))
    return box
  }
  const i = selected.index
  const item = char.inventory[i]
  if (!item) return box
  box.append(h('span', { textContent: itemName(item), style: `color:${RARITY_COLORS[item.rarity]};align-self:center;margin-right:6px` }))
  if (item.kind === 'weapon' || item.kind === 'armor' || item.kind === 'implant') box.append(btn('Equip', () => send({ t: 'inv', op: 'equip', from: i }), 'btn gold'))
  if (item.kind === 'potion') {
    box.append(btn('Drink', () => send({ t: 'inv', op: 'use', from: i }), 'btn gold'))
    box.append(btn('Throw', () => throwHook(i)))
  }
  if (item.kind === 'grenade') {
    box.append(btn('Throw', () => throwHook(i), 'btn gold'))
    box.append(btn(char.grenade === item.base ? 'G grenade ✓' : 'Use for G', () => send({ t: 'inv', op: 'grenade', key: item.base }), 'btn', char.grenade === item.base))
  }
  if (item.kind === 'potion' || item.kind === 'grenade') {
    const key = stackKey(item)!
    for (let q = 0; q < 4; q++) box.append(btn(`→${q + 1}`, () => send({ t: 'inv', op: 'quick', slot: q, key }), char.quickbar[q] === key ? 'btn gold' : 'btn'))
  }
  if (item.kind !== 'keycard' && item.kind !== 'datacore') box.append(btn('Drop', () => send({ t: 'inv', op: 'drop', from: i }), 'btn red'))
  return box
}

/** Set by the game: throws the item in slot i where the player is looking. */
export let throwHook = (_slot: number) => {}
export function setThrowHook(f: (slot: number) => void) {
  throwHook = f
}

// --- Spellbook --------------------------------------------------------------------------------------------
const KEYS = ['Q', 'E', 'R', 'F']
function renderSpells(body: HTMLDivElement) {
  const char = S.char
  if (!char) return
  body.innerHTML = ''
  const known = new Set(knownSpellIds())
  body.append(h('h3', { cls: 'sec', textContent: 'LOADOUT · right mouse also casts slot Q' }))
  const load = h('div', { cls: 'loadout' })
  char.spells.forEach((id, i) => {
    const c = h('div', { cls: 'slot' })
    if (id) c.append(h('img', { src: icon(`spell:${id}`), alt: '' }))
    c.append(h('span', { cls: 'key', textContent: KEYS[i] }))
    c.oncontextmenu = (e) => {
      e.preventDefault()
      send({ t: 'spell', slot: i, id: null })
    }
    tip(c, () => (id ? `<div class="tt">${escapeHtml(SPELL_BY_ID[id].name)}</div><div class="muted">Right-click to clear</div>` : '<div class="muted">Empty</div>'))
    load.append(c)
  })
  body.append(load)
  const stats = S.stats
  for (const s of SPELLS) {
    const k = known.has(s.id)
    const row = h('div', { cls: `spellrow${k ? '' : ' locked'}` })
    row.append(h('img', { src: icon(`spell:${s.id}`), alt: '' }))
    const mid = h('div')
    mid.append(h('div', { cls: 'name', textContent: s.name, style: `color:${s.color}` }))
    const cost = Math.round(s.mana * (stats?.spellCost ?? 1))
    const unlock = s.unlock !== null ? `Level ${s.unlock}` : `Talent: ${TALENTS.find((t) => t.id === s.talent)?.name ?? ''}`
    mid.append(h('div', { cls: 'meta', textContent: `${cost} mana · ${s.cooldown}s cooldown · ${k ? 'known' : `unlocks at ${unlock}`}` }))
    mid.append(h('div', { cls: 'desc', textContent: s.desc }))
    row.append(mid)
    const assign = h('div', { cls: 'assign' })
    KEYS.forEach((key, i) => {
      const b = btn(key, () => send({ t: 'spell', slot: i, id: s.id }), char.spells[i] === s.id ? 'btn on' : 'btn', !k)
      b.title = `Put ${s.name} on ${key}`
      assign.append(b)
    })
    row.append(assign)
    body.append(row)
  }
}

// --- Talents ------------------------------------------------------------------------------------------------
function renderTalents(body: HTMLDivElement) {
  const char = S.char
  if (!char) return
  body.innerHTML = ''
  const left = talentPointsForLevel(char.level) - spentPoints(char.talents)
  const top = h('div', { cls: 'row' })
  top.append(h('div', { textContent: `Talent points: ${left} left · one per level from level 2` }))
  top.append(h('div', { cls: 'spacer' }))
  const cost = respecCost(char.level)
  top.append(
    btn(respecArmed ? `Confirm reset for ${cost} credits` : `Reset talents (${cost} credits)`, () => {
      if (!respecArmed) {
        respecArmed = true
        open?.render()
        return
      }
      respecArmed = false
      send({ t: 'respec' })
    }, respecArmed ? 'btn red' : 'btn', spentPoints(char.talents) === 0),
  )
  body.append(top)
  const cols = h('div', { cls: 'talents', style: 'margin-top:12px' })
  for (const b of BRANCHES) {
    const col = h('div', { cls: 'branch' })
    col.append(h('h4', { textContent: b.name, style: `color:${b.color}` }))
    col.append(h('div', { cls: 'bdesc', textContent: `${b.desc} · ${branchPoints(char.talents, b.id)} points spent` }))
    for (const t of TALENTS.filter((x) => x.branch === b.id)) {
      const rank = char.talents[t.id] ?? 0
      const blocker = talentBlocker(char.talents, char.level, t.id)
      const max = rank >= t.ranks
      const locked = !max && branchPoints(char.talents, t.branch) < t.requires
      const row = h('div', { cls: `talent${max ? ' max' : !blocker ? ' can' : locked ? ' locked' : ''}` })
      row.append(h('img', { src: icon(`talent:${t.id}`), alt: '' }))
      const txt = h('div')
      txt.append(h('div', { cls: 'tn', textContent: t.name }))
      txt.append(h('div', { cls: 'tr', textContent: `${rank}/${t.ranks}${t.requires ? ` · needs ${t.requires} in ${b.name}` : ''}` }))
      txt.append(h('div', { cls: 'td', textContent: t.desc }))
      row.append(txt)
      row.onclick = () => {
        if (blocker) return
        sfx.talent()
        send({ t: 'talent', id: t.id })
      }
      tip(row, () => (blocker && !max ? `<div class="muted">${escapeHtml(blocker)}</div>` : ''))
      col.append(row)
    }
    cols.append(col)
  }
  body.append(cols)
}

// --- Map ----------------------------------------------------------------------------------------------------
function renderMap(body: HTMLDivElement) {
  body.innerHTML = ''
  const world = hooks.world
  if (!world) return
  const wrap = h('div', { cls: 'mapwrap' })
  const c = h('canvas', { id: 'bigmap', width: world.info.width * 12, height: world.info.height * 12 })
  wrap.append(c)
  body.append(wrap)
  const markers: { x: number; z: number; color: string; label?: string }[] = []
  for (const q of S.char?.quests ?? [])
    if (q.kind === 'fetch' && q.cell !== undefined && q.progress < q.goal) {
      const x = (q.cell % world.info.width) * 4 + 2
      const z = Math.floor(q.cell / world.info.width) * 4 + 2
      markers.push({ x, z, color: '#ffd34d', label: 'Data core' })
    }
  for (const hb of world.info.hubs) if (S.char?.hubs.includes(hb.id)) markers.push({ x: hb.cx * 4 + 2, z: hb.cz * 4 + 2, color: '#ffb347', label: HUB_NAMES[hb.id] })
  drawMap(c, world, hooks.me(), { full: true, markers })
  const legend = h('div', { cls: 'legend' })
  for (const [label, color] of [
    ['You', '#5cf2ff'],
    ['Hub', '#ffb347'],
    ['Boss arena', '#ff3b5c'],
    ['Sealed vault', '#c77dff'],
    ['Door', '#6a8aa0'],
    ['Quest target', '#ffd34d'],
  ]) {
    const s = h('span', { textContent: label })
    s.style.setProperty('--c', color)
    legend.append(s)
  }
  body.append(legend)
  body.append(h('p', { cls: 'muted', textContent: 'The map fills in as you explore. Sector gates open when the sector behind you is purged.', style: 'text-align:center;font-size:12px' }))
}

// --- Journal -------------------------------------------------------------------------------------------------
const beastImg = new Map<string, string>()
function beastSrc(def: MonsterDef) {
  if (def.image) return `/monsters/${def.image}`
  let s = beastImg.get(def.key)
  if (!s) {
    const c = monsterSprite(def.key, def.color)
    s = c ? c.toDataURL() : icon('ui:skull')
    beastImg.set(def.key, s)
  }
  return s
}

function renderJournal(body: HTMLDivElement) {
  const char = S.char
  if (!char) return
  body.innerHTML = ''
  tabs(body, 'journal', [
    ['quests', `Quests ${char.quests.length}/${MAX_ACTIVE_QUESTS}`],
    ['daily', 'Daily'],
    ['codex', `Codex ${char.codex.length}/${FRAGMENTS.length}`],
    ['bestiary', 'Bestiary'],
    ['achievements', `Achievements ${char.achievements.length}/${ACHIEVEMENTS.length}`],
  ])
  const inner = h('div', { style: 'margin-top:10px' })
  body.append(inner)
  switch (tab.journal) {
    case 'quests': {
      if (!char.quests.length) inner.append(h('p', { cls: 'muted', textContent: 'No active quests. Quest boards stand in every hub.' }))
      for (const q of char.quests) {
        const d = h('div', { cls: 'quest' })
        d.append(h('div', { cls: 't', textContent: q.title }))
        d.append(h('div', { cls: 'd', textContent: `${q.desc} (${SECTOR_NAMES[q.sector]})` }))
        const bar = h('div', { cls: 'pbar' })
        bar.append(h('div', { style: `width:${Math.min(100, (q.progress / q.goal) * 100)}%` }))
        d.append(bar)
        const row = h('div', { cls: 'row' })
        row.append(h('span', { cls: 'rw', textContent: `${Math.min(q.progress, q.goal)}/${q.goal} · Reward: ${q.credits} credits, ${q.xp} XP${q.item ? ', a rare item' : ''}` }))
        row.append(h('span', { cls: 'spacer' }))
        row.append(btn('Abandon', () => send({ t: 'quest', op: 'abandon', id: q.id }), 'btn red'))
        d.append(row)
        inner.append(d)
      }
      break
    }
    case 'daily': {
      inner.append(h('p', { cls: 'muted', textContent: `Three challenges, the same for everyone, new every day (UTC). Each one pays ${DAILY_CREDITS} credits and a chunk of XP.` }))
      S.daily.forEach((d, i) => {
        const prog = char.daily.progress[i] ?? 0
        const done = !!char.daily.done[i]
        const q = h('div', { cls: 'quest' })
        q.append(h('div', { cls: 't', textContent: `${done ? '✓ ' : ''}${d.text}` }))
        const bar = h('div', { cls: 'pbar' })
        bar.append(h('div', { style: `width:${Math.min(100, (prog / d.goal) * 100)}%` }))
        q.append(bar)
        q.append(h('div', { cls: 'rw', textContent: done ? 'Done' : `${prog}/${d.goal}` }))
        inner.append(q)
      })
      break
    }
    case 'codex': {
      const list = h('div', { cls: 'codex' })
      FRAGMENTS.forEach((f, i) => {
        const found = char.codex.includes(i)
        const e = h('div', { cls: `entry${found ? '' : ' locked'}` })
        e.append(h('div', { cls: 't', textContent: found ? `${i + 1}. ${f.title}` : `${i + 1}. ???` }))
        e.append(h('p', { textContent: found ? f.text : 'Not found yet. Data pads glow in quiet corners of the maze.' }))
        list.append(e)
      })
      inner.append(list)
      break
    }
    case 'bestiary': {
      const grid = h('div', { cls: 'beasts' })
      for (const m of MONSTERS) {
        if (m.key === 'mainframe_node') continue
        const kills = char.bestiary[m.key] ?? 0
        const b = h('div', { cls: 'beast' })
        const img = h('img', { src: beastSrc(m), alt: '' })
        if (!kills) img.style.filter = 'brightness(0) drop-shadow(0 0 4px #5cf2ff)'
        b.append(img)
        const t = h('div')
        t.append(h('div', { cls: 'n', textContent: kills ? m.name : '???', style: `color:${kills ? m.color : '#8fb8c8'}` }))
        t.append(h('div', { cls: 'muted', textContent: kills ? `Deleted ${kills}${m.machine ? ' · machine' : ''}` : 'Not encountered yet' }))
        if (kills) t.append(h('div', { textContent: m.lore }))
        b.append(t)
        grid.append(b)
      }
      inner.append(grid)
      break
    }
    case 'achievements': {
      const grid = h('div', { cls: 'ach' })
      for (const a of ACHIEVEMENTS) {
        const done = char.achievements.includes(a.id)
        const prog = a.counter && a.goal ? ` (${Math.min(a.goal, char.counters[a.counter] ?? 0)}/${a.goal})` : ''
        const d = h('div', { cls: done ? 'done' : '' })
        d.append(h('div', { cls: 'n', textContent: `${done ? '✓ ' : ''}${a.name}` }))
        d.append(h('div', { cls: 'muted', textContent: `${a.desc}${done ? '' : prog}${a.credits ? ` · ${a.credits} credits` : ''}` }))
        grid.append(d)
      }
      inner.append(grid)
      break
    }
  }
}

// --- Black market ----------------------------------------------------------------------------------------------
export function showShop(hub: string, stock: ShopEntry[]) {
  shopData = { hub, stock }
  openPanel('shop')
}

function renderShop(body: HTMLDivElement) {
  const char = S.char
  if (!char || !shopData) return
  body.innerHTML = ''
  tabs(body, 'shop', [
    ['buy', 'Buy'],
    ['sell', 'Sell'],
  ])
  const inner = h('div', { cls: 'list', style: 'margin-top:10px' })
  inner.append(h('p', { cls: 'muted', textContent: `${HUB_NAMES[shopData.hub] ?? 'Hub'} black market · you have ${char.credits.toLocaleString('en-US')} credits. Gear restocks every few minutes.` }))
  if (tab.shop === 'buy') {
    for (const e of shopData.stock) {
      const row = h('div', { cls: 'item' })
      row.append(h('img', { src: itemIcon(e.item), alt: '' }))
      const mid = h('div')
      mid.append(h('div', { cls: 'n', textContent: itemName(e.item), style: `color:${RARITY_COLORS[e.item.rarity]}` }))
      const sub = e.item.kind === 'weapon' || e.item.kind === 'armor' ? `${RARITY_NAMES[e.item.rarity]} · level ${e.item.level}` : e.item.kind === 'implant' ? IMPLANTS[e.item.base]?.desc ?? '' : e.item.kind === 'potion' ? POTIONS[e.item.base]?.desc ?? '' : itemLines(e.item)[0] ?? ''
      mid.append(h('div', { cls: 's', textContent: sub }))
      row.append(mid)
      const right = h('div', { cls: 'row' })
      right.append(h('span', { cls: 'price', textContent: `${e.price} cr` }))
      right.append(btn('Buy', () => send({ t: 'shop', op: 'buy', id: e.id }), 'btn gold', char.credits < e.price))
      row.append(right)
      tip(row, () => itemTip(e.item))
      inner.append(row)
    }
  } else {
    const items = char.inventory.map((it, i) => [it, i] as const).filter(([it]) => it && it.kind !== 'keycard' && it.kind !== 'datacore')
    if (!items.length) inner.append(h('p', { cls: 'muted', textContent: 'Nothing to sell.' }))
    for (const [item, i] of items) {
      if (!item) continue
      const one = isStackable(item) ? { ...item, qty: 1 } : item
      const price = Math.max(1, sellPrice(one))
      const row = h('div', { cls: 'item' })
      row.append(h('img', { src: itemIcon(item), alt: '' }))
      const mid = h('div')
      mid.append(h('div', { cls: 'n', textContent: `${itemName(item)}${item.qty > 1 ? ` ×${item.qty}` : ''}`, style: `color:${RARITY_COLORS[item.rarity]}` }))
      mid.append(h('div', { cls: 's', textContent: item.kind === 'weapon' || item.kind === 'armor' ? `${RARITY_NAMES[item.rarity]} · level ${item.level}` : item.kind }))
      row.append(mid)
      const right = h('div', { cls: 'row' })
      right.append(h('span', { cls: 'price', textContent: `${price} cr${isStackable(item) && item.qty > 1 ? ' each' : ''}` }))
      right.append(btn('Sell', () => send({ t: 'shop', op: 'sell', from: i })))
      row.append(right)
      tip(row, () => itemTip(item))
      inner.append(row)
    }
  }
  body.append(inner)
}

// --- Quest board -------------------------------------------------------------------------------------------------
export function showBoard(hub: string, offers: QuestState[]) {
  boardData = { hub, offers }
  openPanel('board')
}

function renderBoard(body: HTMLDivElement) {
  const char = S.char
  if (!char || !boardData) return
  body.innerHTML = ''
  body.append(h('p', { cls: 'muted', textContent: `${HUB_NAMES[boardData.hub] ?? 'Hub'} · active quests ${char.quests.length}/${MAX_ACTIVE_QUESTS}. New contracts are posted every few minutes.` }))
  if (!boardData.offers.length) body.append(h('p', { textContent: 'No contracts right now. Check back later.' }))
  for (const q of boardData.offers) {
    const d = h('div', { cls: 'quest' })
    d.append(h('div', { cls: 't', textContent: q.title }))
    d.append(h('div', { cls: 'd', textContent: q.desc }))
    const row = h('div', { cls: 'row' })
    row.append(h('span', { cls: 'rw', textContent: `Reward: ${q.credits} credits, ${q.xp} XP${q.item ? ', a rare item' : ''}` }))
    row.append(h('span', { cls: 'spacer' }))
    row.append(btn('Accept', () => send({ t: 'quest', op: 'accept', id: q.id }), 'btn gold', char.quests.length >= MAX_ACTIVE_QUESTS))
    d.append(row)
    body.append(d)
  }
  if (char.quests.length) {
    body.append(h('h3', { cls: 'sec', textContent: 'ACTIVE' }))
    for (const q of char.quests) body.append(h('div', { cls: 'muted', textContent: `${q.title} · ${Math.min(q.progress, q.goal)}/${q.goal}` }))
  }
}

// --- Beacon ---------------------------------------------------------------------------------------------------------
export function showBeacon(hub: string) {
  beaconHub = hub
  openPanel('beacon')
}

function renderBeacon(body: HTMLDivElement) {
  const char = S.char
  const world = S.world
  if (!char || !world) return
  body.innerHTML = ''
  body.append(h('p', { cls: 'muted', textContent: 'Beacons link every hub you have found. Travel is instant.' }))
  const list = h('div', { cls: 'list' })
  for (const hb of world.hubs) {
    const found = char.hubs.includes(hb.id)
    const here = hb.id === beaconHub
    const row = h('div', { cls: 'item' })
    row.append(h('img', { src: icon('ui:beacon'), alt: '' }))
    const mid = h('div')
    mid.append(h('div', { cls: 'n', textContent: found ? HUB_NAMES[hb.id] ?? hb.id : 'Undiscovered hub' }))
    mid.append(h('div', { cls: 's', textContent: `${SECTOR_NAMES[hb.sector]}${here ? ' · you are here' : ''}` }))
    row.append(mid)
    row.append(
      btn('Travel', () => {
        send({ t: 'travel', hub: hb.id })
        closePanel(false)
      }, 'btn gold', !found || here),
    )
    list.append(row)
  }
  body.append(list)
}

// --- Puzzles and lore ----------------------------------------------------------------------------------------------
export function showCipher(o: WorldObject) {
  cipherObj = o
  cipherDials = [0, 0, 0, 0]
  openPanel('cipher')
}

function renderCipher(body: HTMLDivElement) {
  const o = cipherObj
  if (!o) return
  body.innerHTML = ''
  body.append(h('p', { textContent: 'Four glyphs are scrawled on walls around this sector, each with its position. Set the dials and submit. A wrong code shocks you.' }))
  const dials = h('div', { cls: 'dials' })
  cipherDials.forEach((v, i) => {
    const d = h('div', { cls: 'dial' })
    d.append(btn('▲', () => {
      cipherDials[i] = (cipherDials[i] + 1) % 6
      open?.render()
    }))
    d.append(h('div', { cls: 'g', textContent: GLYPHS[v] }))
    d.append(btn('▼', () => {
      cipherDials[i] = (cipherDials[i] + 5) % 6
      open?.render()
    }))
    d.append(h('div', { cls: 'muted', textContent: `${i + 1}` }))
    dials.append(d)
  })
  body.append(dials)
  const row = h('div', { cls: 'row', style: 'justify-content:center' })
  row.append(
    btn('Submit code', () => {
      const [a, b, c, d] = cipherDials
      send({ t: 'interact', obj: o.id, arg: a + b * 6 + c * 36 + d * 216 })
    }, 'btn gold'),
  )
  body.append(row)
}

export function showClue(o: WorldObject) {
  clueObj = o
  openPanel('clue')
}

function renderClue(body: HTMLDivElement) {
  const o = clueObj
  if (!o) return
  body.innerHTML = ''
  const pz = S.world?.puzzles.find((p) => p.id === o.puzzle)
  if (pz?.kind === 'relay') {
    body.append(h('div', { cls: 'cluetext', textContent: pz.riddle ?? '' }))
    body.append(h('p', { cls: 'muted', textContent: 'Three relays hide in this sector: red, green and blue. Switch them on in this order. The wrong order sends a power surge through you and resets the circuit.' }))
  } else {
    body.append(h('div', { cls: 'bigglyph', textContent: GLYPHS[o.glyph ?? 0] }))
    body.append(h('p', { style: 'text-align:center', textContent: `Glyph ${(o.index ?? 0) + 1} of 4 for the cipher lock in the ${SECTOR_NAMES[o.sector]}.` }))
  }
}

export function showFragment(index: number) {
  fragmentIndex = index
  openPanel('fragment')
}

function renderFragment(body: HTMLDivElement) {
  const f = FRAGMENTS[fragmentIndex]
  if (!f) return
  body.innerHTML = ''
  body.append(h('h3', { cls: 'sec', textContent: `${fragmentIndex + 1} / ${FRAGMENTS.length} · ${f.title.toUpperCase()}` }))
  body.append(h('div', { cls: 'cluetext', textContent: f.text }))
  body.append(h('p', { cls: 'muted', textContent: 'Saved to your codex (J).' }))
}

// --- Settings ----------------------------------------------------------------------------------------------------------
function renderSettings(body: HTMLDivElement) {
  body.innerHTML = ''
  const box = h('div', { cls: 'settings' })
  const slider = (label: string, key: 'master' | 'music' | 'sfx' | 'sensitivity' | 'fov' | 'quality', min: number, max: number, step: number, fmt: (v: number) => string) => {
    const l = h('label')
    const val = h('span', { textContent: fmt(settings[key]) })
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(settings[key]) })
    input.oninput = () => {
      settings[key] = Number(input.value)
      val.textContent = fmt(settings[key])
      saveSettings(settings)
      hooks.onSettings(settings)
    }
    l.append(h('span', { textContent: label }), input, val)
    box.append(l)
  }
  const check = (label: string, key: 'invertY' | 'bloom' | 'showFps') => {
    const l = h('label', { cls: 'check' })
    const input = h('input', { type: 'checkbox', checked: settings[key] })
    input.onchange = () => {
      settings[key] = input.checked
      saveSettings(settings)
      hooks.onSettings(settings)
    }
    l.append(h('span', { textContent: label }), input, h('span'))
    box.append(l)
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`
  slider('Master volume', 'master', 0, 1, 0.05, pct)
  slider('Music', 'music', 0, 1, 0.05, pct)
  slider('Effects', 'sfx', 0, 1, 0.05, pct)
  slider('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2))
  slider('Field of view', 'fov', 60, 100, 1, (v) => `${v}°`)
  slider('Render scale', 'quality', 0.5, 1.5, 0.05, pct)
  check('Invert mouse Y', 'invertY')
  check('Bloom glow', 'bloom')
  check('Show FPS', 'showFps')
  body.append(box)
  const row = h('div', { cls: 'row' })
  row.append(btn('Resume', () => closePanel(false), 'btn gold'))
  row.append(h('span', { cls: 'spacer' }))
  row.append(btn('Log out', () => hooks.logout(), 'btn red'))
  body.append(row)
  body.append(h('p', { cls: 'muted', style: 'font-size:12px;margin-top:12px', textContent: S.guest ? 'You are playing as a guest: your progress is lost when you log out.' : 'Your hacker is saved on the server.' }))
}

/** Armour tier names, for the item tooltip in the shop. */
export const armorName = (tier: number) => ARMOR_TIERS[tier]?.name ?? 'Armour'
