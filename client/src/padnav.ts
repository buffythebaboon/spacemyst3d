// Using the open panel with a gamepad: a highlight moves between its buttons, item cells and
// sliders. A clicks, X does what a right-click does, B closes, the bumpers switch panels.
import { BTN, pad, padNav, type NavDir } from './gamepad.ts'
import { el } from './hud.ts'
import * as ui from './ui.ts'

/** The panels Back opens, in the order the bumpers step through them. */
const MAIN: ui.PanelId[] = ['inventory', 'spells', 'talents', 'map', 'journal']
const TARGETS = 'button:not([disabled]), input, .cell, .slot, .talent'

let focused: HTMLElement | null = null
let focusIndex = 0
let panelId: ui.PanelId | null = null

function targets(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(TARGETS)].filter((e) => e.getClientRects().length > 0)
}

function setFocus(e: HTMLElement | null, list: HTMLElement[]) {
  focused?.classList.remove('padfocus')
  focused = e
  if (!e) return ui.tipFor(null)
  focusIndex = Math.max(0, list.indexOf(e))
  e.classList.add('padfocus')
  e.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  ui.tipFor(e)
}

/** The closest target in a direction, preferring ones in line with the current one. */
function neighbour(from: HTMLElement, list: HTMLElement[], dir: NavDir) {
  const a = from.getBoundingClientRect()
  const ax = a.left + a.width / 2
  const ay = a.top + a.height / 2
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const e of list) {
    if (e === from) continue
    const b = e.getBoundingClientRect()
    const dx = b.left + b.width / 2 - ax
    const dy = b.top + b.height / 2 - ay
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    const across = dir === 'left' || dir === 'right' ? dy : dx
    if (along < 2) continue
    const score = along + Math.abs(across) * 2.5
    if (score < bestScore) {
      bestScore = score
      best = e
    }
  }
  return best
}

/** Panels redraw when the character changes, so a highlight that lost its element moves to the one in the same place. */
export function restorePadFocus() {
  const root = el.panels.querySelector<HTMLElement>('.panel')
  if (!root || ui.openId() !== panelId || focused?.isConnected) return
  const list = targets(root)
  setFocus(list[Math.min(focusIndex, list.length - 1)] ?? null, list)
}

/** Drops the highlight, when the panel closes or the mouse takes over. */
export function clearPadFocus() {
  if (!focused && !panelId) return
  focused?.classList.remove('padfocus')
  focused = null
  panelId = null
  ui.tipFor(null)
}

export function panelPad(t: number, dt: number) {
  const id = ui.openId()
  const root = el.panels.querySelector<HTMLElement>('.panel')
  if (!id || !root) return
  const list = targets(root)
  // A newly opened panel starts on its first control.
  if (id !== panelId) {
    panelId = id
    setFocus(list.find((e) => !e.closest('header')) ?? list[0] ?? null, list)
  } else restorePadFocus()

  const p = pad.pressed
  if (p[BTN.B] || p[BTN.START] || p[BTN.BACK]) return ui.closePanel(true)
  const main = MAIN.indexOf(id)
  if ((p[BTN.LB] || p[BTN.RB]) && main >= 0) return ui.openPanel(MAIN[(main + (p[BTN.RB] ? 1 : MAIN.length - 1)) % MAIN.length])
  if (p[BTN.LT] || p[BTN.RT]) {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('.tabs button')]
    const on = tabs.findIndex((b) => b.classList.contains('on'))
    if (tabs.length > 1 && on >= 0) tabs[(on + (p[BTN.RT] ? 1 : tabs.length - 1)) % tabs.length].click()
    return
  }

  const dir = padNav(t)
  if (dir && focused) {
    if (focused instanceof HTMLInputElement && focused.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'right') focused.stepUp()
      else focused.stepDown()
      focused.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      const next = neighbour(focused, list, dir)
      if (next) setFocus(next, list)
    }
  }
  if (focused && p[BTN.A]) focused.click()
  if (focused && p[BTN.X]) focused.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  const body = root.querySelector<HTMLElement>('.body')
  if (body && pad.look.y) body.scrollTop += pad.look.y * 900 * dt
}
