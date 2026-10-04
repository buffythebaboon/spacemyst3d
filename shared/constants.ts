/** World units per grid cell. */
export const CELL = 4
export const WALL_HEIGHT = 4.2
export const PLAYER_RADIUS = 0.55
export const PLAYER_SPEED = 6.5
export const SPRINT_MULT = 1.6
export const EYE_HEIGHT = 1.7

export const TICK_RATE = 20
export const WEAPON_RANGE = CELL * 6
export const WEAPON_COOLDOWN = 0.32
export const OVERLOAD_MANA = 10
export const REPAIR_MANA = 8

export const START_MAX_HP = 40

export const levelFromMaxHp = (maxHp: number) => Math.floor((maxHp - START_MAX_HP) / 20) + 1
export const maxManaForLevel = (level: number) => 15 + (level - 1) * 3

export const cellCenter = (c: number) => c * CELL + CELL / 2
export const toCell = (v: number) => Math.floor(v / CELL)
