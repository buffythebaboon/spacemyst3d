// Gamepad input through the browser's standard mapping. Buttons carry Xbox names; a PlayStation
// pad maps the same way (A = cross, B = circle, X = square, Y = triangle). The game polls it once
// a frame, so every read is a fresh snapshot with press and release edges.

export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const

const COUNT = 16
const MOVE_DEAD = 0.18
const LOOK_DEAD = 0.14
/** Triggers are analog; this much travel counts as a press. */
const TRIGGER = 0.3

export const pad = {
  connected: false,
  /** Left stick after the dead zone: x right, y down, length 0..1. */
  move: { x: 0, y: 0 },
  /** Right stick after the dead zone, with a curve that leaves small tilts precise. */
  look: { x: 0, y: 0 },
  held: new Array<boolean>(COUNT).fill(false),
  pressed: new Array<boolean>(COUNT).fill(false),
  released: new Array<boolean>(COUNT).fill(false),
  /** A button went down or a stick was pushed well past its dead zone: the player picked up the pad. A drifting stick is not enough. */
  wake: false,
}

let index = -1

function current(): Gamepad | null {
  const list = navigator.getGamepads?.() ?? []
  const known = index >= 0 ? list[index] : null
  if (known?.connected) return known
  index = -1
  for (const g of list)
    if (g?.connected && g.buttons.length >= COUNT) {
      index = g.index
      return g
    }
  return null
}

function stick(x: number, y: number, dead: number, curve: number) {
  const m = Math.hypot(x, y)
  if (m < dead) return { x: 0, y: 0 }
  const k = Math.pow(Math.min(1, (m - dead) / (1 - dead)), curve) / m
  return { x: x * k, y: y * k }
}

export function pollPad() {
  const g = current()
  pad.connected = !!g
  pad.wake = false
  for (let i = 0; i < COUNT; i++) {
    const b = g?.buttons[i]
    const down = !!b && (i === BTN.LT || i === BTN.RT ? b.value > TRIGGER : b.pressed)
    pad.pressed[i] = down && !pad.held[i]
    pad.released[i] = !down && pad.held[i]
    pad.held[i] = down
    if (pad.pressed[i]) pad.wake = true
  }
  pad.move = g ? stick(g.axes[0] ?? 0, g.axes[1] ?? 0, MOVE_DEAD, 1) : { x: 0, y: 0 }
  pad.look = g ? stick(g.axes[2] ?? 0, g.axes[3] ?? 0, LOOK_DEAD, 1.8) : { x: 0, y: 0 }
  if (Math.hypot(pad.move.x, pad.move.y) > 0.5 || Math.hypot(pad.look.x, pad.look.y) > 0.3) pad.wake = true
}

export type NavDir = 'up' | 'down' | 'left' | 'right'
let navHeld: NavDir | null = null
let navNext = 0

/** A direction from the d-pad or the left stick, repeating like a held key, for moving through menus. */
export function padNav(t: number): NavDir | null {
  const h = pad.held
  let d: NavDir | null = h[BTN.UP] ? 'up' : h[BTN.DOWN] ? 'down' : h[BTN.LEFT] ? 'left' : h[BTN.RIGHT] ? 'right' : null
  const { x, y } = pad.move
  if (!d && Math.hypot(x, y) > 0.6) d = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up'
  if (d !== navHeld) {
    navHeld = d
    navNext = t + 0.38
    return d
  }
  if (d && t >= navNext) {
    navNext = t + 0.11
    return d
  }
  return null
}

/** Rumble, on pads and browsers that support it. */
export function rumble(strong: number, weak: number, ms: number) {
  const g = current() as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null
  g?.vibrationActuator
    ?.playEffect?.('dual-rumble', { duration: Math.round(ms), strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })
    .catch(() => {})
}
