// Spellbook. Nine spells come from the first Spacemyst; four more are unlocked in the talent tree.

export type SpellTarget = 'self' | 'aim' | 'point' | 'area'

export interface SpellDef {
  id: string
  name: string
  desc: string
  mana: number
  cooldown: number
  /** Character level that unlocks it, or null when a talent does. */
  unlock: number | null
  talent?: string
  target: SpellTarget
  color: string
  range?: number
  radius?: number
  duration?: number
  /** Damage as a multiple of spell power (or of weapon damage for Overload). */
  power?: number
}

export const SPELLS: SpellDef[] = [
  {
    id: 'overload',
    name: 'Overload',
    desc: 'Fire a supercharged bolt for 250% weapon damage. Ignores shields and armour plates.',
    mana: 12,
    cooldown: 4,
    unlock: 1,
    target: 'aim',
    color: '#ff4fd8',
    range: 50,
    power: 2.5,
  },
  {
    id: 'repair',
    name: 'Nanite Repair',
    desc: 'Restore 35% of your HP over 2 seconds. Allies within 6 m get half.',
    mana: 16,
    cooldown: 8,
    unlock: 1,
    target: 'self',
    color: '#7dff9a',
    radius: 6,
    duration: 2,
    power: 0.35,
  },
  {
    id: 'glitch_step',
    name: 'Glitch Step',
    desc: 'Teleport 8 m where you look, straight through monsters but not walls.',
    mana: 14,
    cooldown: 6,
    unlock: 2,
    target: 'aim',
    color: '#c77dff',
    range: 8,
  },
  {
    id: 'system_shock',
    name: 'System Shock',
    desc: 'A bolt of raw data that jumps between up to four programs and ignores armour. Shatters frozen targets for double damage.',
    mana: 18,
    cooldown: 5,
    unlock: 3,
    target: 'aim',
    color: '#5cf2ff',
    range: 26,
    radius: 7,
    power: 2.2,
  },
  {
    id: 'lullaby',
    name: 'Lullaby',
    desc: 'A sleep dart. The target sleeps for 8 seconds or until hit, and the first hit is a critical.',
    mana: 12,
    cooldown: 10,
    unlock: 4,
    target: 'aim',
    color: '#8c7bff',
    range: 30,
    duration: 8,
  },
  {
    id: 'firewall',
    name: 'Firewall',
    desc: 'Raise a burning wall across the corridor ahead for 6 seconds. Monsters cannot pass it and burn when they touch it.',
    mana: 20,
    cooldown: 14,
    unlock: 5,
    target: 'point',
    color: '#ff7a3c',
    range: 5,
    radius: 3,
    duration: 6,
    power: 1.5,
  },
  {
    id: 'system_snooze',
    name: 'System Snooze',
    desc: 'Put every monster within 6 m to sleep for 5 seconds.',
    mana: 24,
    cooldown: 18,
    unlock: 7,
    target: 'self',
    color: '#9fb7ff',
    radius: 6,
    duration: 5,
  },
  {
    id: 'stasis_field',
    name: 'Stasis Field',
    desc: 'Freeze all monsters in a 4 m field for 4 seconds. Frozen programs take 50% more damage.',
    mana: 26,
    cooldown: 20,
    unlock: 9,
    target: 'area',
    color: '#9ff6ff',
    range: 14,
    radius: 4,
    duration: 4,
  },
  {
    id: 'data_leech',
    name: 'Data Leech',
    desc: 'Lock a draining beam onto a program for 2 seconds. Half of the damage comes back to you as HP.',
    mana: 22,
    cooldown: 12,
    unlock: 11,
    target: 'aim',
    color: '#ff3b5c',
    range: 16,
    duration: 2,
    power: 1.1,
  },
  {
    id: 'ping',
    name: 'Ping',
    desc: 'Reveal monsters and items within 20 m through walls for 6 seconds. Invisible programs light up for everyone.',
    mana: 8,
    cooldown: 10,
    unlock: null,
    talent: 'hk_ping',
    target: 'self',
    color: '#5cf2ff',
    radius: 20,
    duration: 6,
  },
  {
    id: 'honeypot',
    name: 'Honeypot',
    desc: 'Drop a decoy that monsters attack instead of you for 8 seconds. It also weighs down pressure plates.',
    mana: 18,
    cooldown: 20,
    unlock: null,
    talent: 'en_honeypot',
    target: 'point',
    color: '#ffd34d',
    range: 10,
    radius: 15,
    duration: 8,
  },
  {
    id: 'hijack',
    name: 'Hijack',
    desc: 'Take over a program below half HP for 10 seconds. It fights for you. Bosses cannot be hijacked.',
    mana: 24,
    cooldown: 25,
    unlock: null,
    talent: 'hk_hijack',
    target: 'aim',
    color: '#7dff9a',
    range: 22,
    duration: 10,
  },
  {
    id: 'daemon',
    name: 'Daemon',
    desc: 'Summon a little drone that follows you and shoots monsters for 15 seconds.',
    mana: 22,
    cooldown: 24,
    unlock: null,
    talent: 'en_daemon',
    target: 'self',
    color: '#4fa8ff',
    duration: 15,
    power: 0.5,
  },
]

export const SPELL_BY_ID = Object.fromEntries(SPELLS.map((s) => [s.id, s])) as Record<string, SpellDef>

/** Spell power at a character level, before talents and gear. */
export const spellBase = (level: number) => 10 * Math.pow(1.12, level - 1)

/** Spells a character knows from level and talents. */
export function knownSpells(level: number, talents: Record<string, number>) {
  return SPELLS.filter((s) => (s.unlock !== null ? level >= s.unlock : !!s.talent && (talents[s.talent] ?? 0) > 0)).map((s) => s.id)
}
