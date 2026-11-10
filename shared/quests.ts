// Quest board offers and daily challenges.
import { SECTOR_LEVELS, SECTOR_NAMES, xpToNext } from './constants.ts'
import { MONSTER_BY_KEY, SECTOR_BOSSES, SPAWN_TABLES } from './monsters.ts'
import { hashString, mulberry32, pick, randInt, shuffle, weighted, type Rand } from './rng.ts'

export type QuestKind = 'kill' | 'purge' | 'elite' | 'fetch' | 'boss' | 'puzzle' | 'secret' | 'chest'

export interface QuestState {
  id: string
  kind: QuestKind
  sector: number
  /** Monster key for kill and boss quests. */
  target?: string
  goal: number
  progress: number
  title: string
  desc: string
  credits: number
  xp: number
  /** Also rewards a rare-or-better item. */
  item: boolean
  /** Fetch quests: the cell where the data core lies. */
  cell?: number
}

export const MAX_ACTIVE_QUESTS = 3

export const plural = (name: string) => (name.endsWith('y') ? `${name.slice(0, -1)}ies` : name.endsWith('s') ? name : `${name}s`)

const KIND_WEIGHT: Record<QuestKind, number> = { kill: 30, purge: 18, elite: 10, fetch: 12, boss: 8, puzzle: 8, secret: 8, chest: 10 }
const KIND_REWARD: Record<QuestKind, number> = { kill: 1, purge: 1.2, elite: 1.4, fetch: 1.2, boss: 3, puzzle: 2, secret: 1.5, chest: 1.2 }

/**
 * Rolls a quest for a sector. `allowed` lets the server leave out kinds that cannot be done right now
 * (no puzzle vault left closed, boss already down, and so on).
 */
export function rollQuest(rand: Rand, sector: number, id: string, allowed: QuestKind[]): QuestState {
  const kinds = allowed.length ? allowed : (['kill', 'purge'] as QuestKind[])
  const kind = weighted(rand, kinds, (k) => KIND_WEIGHT[k])
  const where = SECTOR_NAMES[sector]
  const [lo, hi] = SECTOR_LEVELS[sector]
  const mid = Math.round((lo + hi) / 2)
  const mult = KIND_REWARD[kind]
  const credits = Math.round(40 * (1 + mid * 0.4) * mult)
  const xp = Math.round(xpToNext(mid) * 0.22 * mult)
  const base = { id, kind, sector, progress: 0, credits, xp, item: kind === 'boss' || kind === 'puzzle' }
  switch (kind) {
    case 'kill': {
      const table = SPAWN_TABLES[sector]
      const key = weighted(rand, Object.keys(table), (k) => table[k])
      const def = MONSTER_BY_KEY[key]
      const goal = def.behaviour === 'swarm' ? randInt(rand, 12, 18) : randInt(rand, 5, 9)
      return { ...base, target: key, goal, title: `Delete ${goal} ${plural(def.name)}`, desc: `Hunt them down in the ${where}.` }
    }
    case 'purge': {
      const goal = randInt(rand, 15, 25)
      return { ...base, goal, title: `Purge ${goal} programs`, desc: `Any program in the ${where} counts.` }
    }
    case 'elite': {
      const goal = randInt(rand, 1, 2)
      return { ...base, goal, title: goal === 1 ? 'Delete an elite program' : `Delete ${goal} elite programs`, desc: `Elites glow with a coloured aura. Find them in the ${where}.` }
    }
    case 'fetch':
      return { ...base, goal: 1, title: 'Recover the lost data core', desc: `A data core went missing in the ${where}. Its last known position is marked on your map.` }
    case 'boss': {
      const key = SECTOR_BOSSES[sector]
      return { ...base, target: key, goal: 1, title: `Defeat the ${MONSTER_BY_KEY[key].name.replace(/^The /, '')}`, desc: `It waits in the arena of the ${where}.` }
    }
    case 'puzzle':
      return { ...base, goal: 1, title: 'Crack a puzzle vault', desc: `Solve one of the sealed vaults in the ${where}.` }
    case 'secret':
      return { ...base, goal: 1, title: 'Find a hidden room', desc: `Some walls in the ${where} are not what they seem. Look for a glitch.` }
    case 'chest': {
      const goal = randInt(rand, 2, 3)
      return { ...base, goal, title: `Open ${goal} supply chests`, desc: `Supply chests hide in dead ends of the ${where}.` }
    }
  }
}

// --- Daily challenges ------------------------------------------------------------------------
export interface DailyDef {
  id: string
  text: string
  goal: number
  counter: string
}

const DAILY_POOL: { id: string; text: string; goals: number[]; counter: string }[] = [
  { id: 'kills', text: 'Delete {n} programs', goals: [40, 60, 80], counter: 'kills' },
  { id: 'elites', text: 'Delete {n} elite programs', goals: [2, 3, 4], counter: 'elites' },
  { id: 'spells', text: 'Cast {n} spells', goals: [30, 50, 70], counter: 'spells' },
  { id: 'potions', text: 'Drink or throw {n} potions', goals: [4, 6, 8], counter: 'potions' },
  { id: 'chests', text: 'Open {n} supply chests', goals: [2, 3, 4], counter: 'chests' },
  { id: 'grenades', text: 'Throw {n} grenades', goals: [3, 5, 7], counter: 'grenades' },
  { id: 'dashes', text: 'Dash {n} times', goals: [25, 40, 60], counter: 'dashes' },
  { id: 'crits', text: 'Land {n} critical hits', goals: [30, 50, 80], counter: 'crits' },
  { id: 'quests', text: 'Complete {n} quests', goals: [2, 3, 4], counter: 'quests' },
  { id: 'fragments', text: 'Find a data fragment', goals: [1], counter: 'fragments' },
]

export const DAILY_CREDITS = 250

/** Today's date as used for daily challenges (UTC). */
export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/** The same three challenges for everyone on a given day. */
export function dailyChallenges(date: string): DailyDef[] {
  const rand = mulberry32(hashString(`daily-${date}`))
  return shuffle(rand, [...DAILY_POOL])
    .slice(0, 3)
    .map((d) => {
      const goal = pick(rand, d.goals)
      return { id: d.id, text: d.text.replace('{n}', String(goal)), goal, counter: d.counter }
    })
}
