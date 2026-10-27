/** World units per grid cell. */
export const CELL = 4
export const WALL_HEIGHT = 4.2
export const PLAYER_RADIUS = 0.55
export const PLAYER_SPEED = 6.5
export const SPRINT_MULT = 1.6
export const EYE_HEIGHT = 1.7

export const TICK_RATE = 20
/** Monsters, projectiles and loot further away than this are not sent to a client. */
export const INTEREST_RADIUS = 72

// --- Movement abilities ---------------------------------------------------------
export const DASH_SPEED = 30
export const DASH_TIME = 0.18
export const DASH_COOLDOWN = 2.5
export const DASH_IFRAMES = 0.25

// --- Player progression -----------------------------------------------------------
export const START_MAX_HP = 40
export const MAX_LEVEL = 30
export const hpForLevel = (level: number) => START_MAX_HP + (level - 1) * 10
export const manaForLevel = (level: number) => 50 + (level - 1) * 4
export const BASE_MANA_REGEN = 3
/** XP needed to go from `level` to `level + 1`. */
export const xpToNext = (level: number) => Math.round(30 * Math.pow(level, 1.4))

export const INVENTORY_SIZE = 24
export const QUICKBAR_SIZE = 4
export const SPELL_SLOTS = 4
export const IMPLANT_SLOTS = 3
/** Shared cooldown after drinking or throwing a consumable. */
export const POTION_COOLDOWN = 0.8
export const PICKUP_RADIUS = 1.4

// --- World ---------------------------------------------------------------------------
export const SECTOR_NAMES = ['Cooling Channels', 'Server Halls', 'Corrupted Sector', 'The Core'] as const
export const SECTOR_COLORS = ['#5cf2ff', '#7dff9a', '#ff3b6b', '#ffe9a8'] as const
/** Monster level range per sector. */
export const SECTOR_LEVELS: readonly [number, number][] = [
  [1, 3],
  [4, 7],
  [8, 12],
  [13, 17],
]
/** Corruption points each sector starts with; the gate inwards opens at zero. */
export const SECTOR_CORRUPTION = [140, 220, 300, 0] as const
export const SECTOR_MONSTERS = [52, 46, 38, 24] as const
/** Potions lying around each sector at once. */
export const SECTOR_POTIONS = [26, 22, 18, 8] as const

export const cellCenter = (c: number) => c * CELL + CELL / 2
export const toCell = (v: number) => Math.floor(v / CELL)
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export const round2 = (v: number) => Math.round(v * 100) / 100
