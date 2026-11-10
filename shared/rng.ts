/** Small seeded PRNG (mulberry32) plus helpers. Shared so world generation is deterministic. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rand = () => number

export const randInt = (rand: Rand, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
export const randRange = (rand: Rand, lo: number, hi: number) => lo + rand() * (hi - lo)
export const pick = <T>(rand: Rand, list: readonly T[]): T => list[Math.floor(rand() * list.length)]
export const chance = (rand: Rand, p: number) => rand() < p

export function shuffle<T>(rand: Rand, list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

export function weighted<T>(rand: Rand, list: readonly T[], weight: (t: T) => number): T {
  const total = list.reduce((s, t) => s + weight(t), 0)
  let r = rand() * total
  for (const t of list) {
    const w = weight(t)
    if (r < w) return t
    r -= w
  }
  return list[list.length - 1]
}

/** Stable 32-bit hash of a string, for seeding from names and dates. */
export function hashString(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
