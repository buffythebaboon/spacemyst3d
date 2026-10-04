// Monster templates. Stats are given at level 1 and scale with the monster's level.
import { weighted, type Rand } from './rng.ts'

export type DamageType = 'laser' | 'emp' | 'heat' | 'pure'
export const DAMAGE_TYPES: readonly DamageType[] = ['laser', 'emp', 'heat', 'pure']

export type Behaviour =
  | 'swarm'
  | 'scuttler'
  | 'cloud'
  | 'kiter'
  | 'phantom'
  | 'blinker'
  | 'tank'
  | 'bomber'
  | 'worm'
  | 'guardian'
  | 'leviathan'
  | 'singularity'
  | 'mainframe'
  | 'zeroday'
  | 'dragon'
  | 'turret'
  | 'node'

export type Role = 'melee' | 'ranged' | 'swarm' | 'tank' | 'special'

export interface MonsterDef {
  key: string
  name: string
  /** File in /monsters/, or null for a procedural sprite. */
  image: string | null
  color: string
  /** Sprite height in world units. */
  size: number
  speed: number
  hp: number
  damage: number
  /** Melee reach, or the distance a ranged monster likes to attack from. */
  range: number
  /** Seconds between attacks. */
  attackTime: number
  /** Telegraph time before an attack lands. */
  windup: number
  xp: number
  credits: number
  /** Sector corruption removed by a kill. */
  corruption: number
  behaviour: Behaviour
  role: Role
  /** Machines resist lasers and are stunned by EMP. */
  machine?: boolean
  resist: Partial<Record<DamageType, number>>
  special?: { name: string; chance: number }
  /** Passes through walls. */
  noclip?: boolean
  /** Hangs from the ceiling / never moves. */
  stationary?: boolean
  aggroRange: number
  projectile?: { kind: string; speed: number; radius?: number }
  /** Short bestiary entry. */
  lore: string
}

export const MONSTERS: MonsterDef[] = [
  {
    key: 'byte_mite',
    name: 'Byte Mite',
    image: 'byte_mite.png',
    color: '#7dff9a',
    size: 1.15,
    speed: 5.2,
    hp: 12,
    damage: 3,
    range: 1.4,
    attackTime: 1.0,
    windup: 0.3,
    xp: 3,
    credits: 3,
    corruption: 1,
    behaviour: 'swarm',
    role: 'swarm',
    resist: { heat: 1.5 },
    aggroRange: 16,
    lore: 'Hunts in swarms of four to six. Each bite chews a little mana out of your buffers.',
  },
  {
    key: 'junk_scuttler',
    name: 'Junk-Code Scuttler',
    image: 'junk-code_scuttler.png',
    color: '#c9ff5c',
    size: 1.55,
    speed: 3.7,
    hp: 30,
    damage: 6,
    range: 1.6,
    attackTime: 1.3,
    windup: 0.45,
    xp: 7,
    credits: 8,
    corruption: 2,
    behaviour: 'scuttler',
    role: 'melee',
    machine: true,
    resist: { laser: 0.85, emp: 1.25 },
    aggroRange: 15,
    lore: 'Leaks sticky junk code wherever it crawls. Standing in it slows you down.',
  },
  {
    key: 'packet_swarm',
    name: 'Packet Swarm',
    image: 'packet_swarm.png',
    color: '#5cf2ff',
    size: 1.9,
    speed: 4.3,
    hp: 34,
    damage: 5,
    range: 1.8,
    attackTime: 1.1,
    windup: 0.35,
    xp: 8,
    credits: 9,
    corruption: 2,
    behaviour: 'cloud',
    role: 'swarm',
    resist: { emp: 1.5 },
    aggroRange: 16,
    lore: 'A cloud of loose packets. Single shots only scatter half of it; area damage hits all of it.',
  },
  {
    key: 'firewall_imp',
    name: 'Firewall Imp',
    image: 'firewall_imp.png',
    color: '#ff7a3c',
    size: 1.6,
    speed: 3.9,
    hp: 26,
    damage: 7,
    range: 11,
    attackTime: 2.2,
    windup: 0.6,
    xp: 9,
    credits: 12,
    corruption: 2,
    behaviour: 'kiter',
    role: 'ranged',
    resist: { heat: 0.25 },
    special: { name: 'Burst Fire', chance: 0.25 },
    aggroRange: 20,
    projectile: { kind: 'fireball', speed: 15 },
    lore: 'Keeps its distance and lobs fireballs, sometimes three in a row. Break line of sight.',
  },
  {
    key: 'null_phantom',
    name: 'Null-Pointer Phantom',
    image: 'null-pointer_phantom.png',
    color: '#b48cff',
    size: 2.1,
    speed: 3.5,
    hp: 48,
    damage: 10,
    range: 1.7,
    attackTime: 1.5,
    windup: 0.5,
    xp: 14,
    credits: 18,
    corruption: 3,
    behaviour: 'phantom',
    role: 'melee',
    noclip: true,
    resist: { laser: 0.75, emp: 1.5 },
    special: { name: 'Memory Leak', chance: 0.3 },
    aggroRange: 18,
    lore: 'Almost invisible and drifts through walls. Memory Leak shrinks your mana for a while. Ping reveals it.',
  },
  {
    key: 'phase_spider',
    name: 'Phase Spider',
    image: null,
    color: '#ff4fd8',
    size: 1.75,
    speed: 4.7,
    hp: 52,
    damage: 9,
    range: 1.7,
    attackTime: 1.4,
    windup: 0.45,
    xp: 15,
    credits: 20,
    corruption: 3,
    behaviour: 'blinker',
    role: 'special',
    resist: { heat: 1.25 },
    special: { name: 'Phase Strike', chance: 0.35 },
    aggroRange: 18,
    projectile: { kind: 'web', speed: 18 },
    lore: 'Blinks around you and spits webs that pin you in place. Freeze it or put it to sleep.',
  },
  {
    key: 'trojan_goliath',
    name: 'Trojan Goliath',
    image: null,
    color: '#ffb347',
    size: 2.7,
    speed: 2.6,
    hp: 140,
    damage: 16,
    range: 2.4,
    attackTime: 2.0,
    windup: 0.8,
    xp: 30,
    credits: 35,
    corruption: 6,
    behaviour: 'tank',
    role: 'tank',
    machine: true,
    resist: { laser: 0.6, emp: 1.5 },
    special: { name: 'Payload Delivery', chance: 0.3 },
    aggroRange: 18,
    lore: 'A slow siege engine with a shield plate in front. Hit it from the side or behind, or stun it with EMP. Byte Mites pour out when it breaks.',
  },
  {
    key: 'logic_bomb',
    name: 'Logic Bomb',
    image: null,
    color: '#ff3355',
    size: 1.3,
    speed: 4.9,
    hp: 20,
    damage: 30,
    range: 3.0,
    attackTime: 3,
    windup: 2.0,
    xp: 10,
    credits: 25,
    corruption: 2,
    behaviour: 'bomber',
    role: 'special',
    machine: true,
    resist: {},
    special: { name: 'DETONATE', chance: 1 },
    aggroRange: 18,
    lore: 'Rolls at you and starts a visible countdown. Shoot it early and it blows up among its friends instead.',
  },
  {
    key: 'recursive_worm',
    name: 'Recursive Worm',
    image: null,
    color: '#9dff00',
    size: 2.3,
    speed: 3.2,
    hp: 70,
    damage: 14,
    range: 1.9,
    attackTime: 1.5,
    windup: 0.5,
    xp: 18,
    credits: 24,
    corruption: 3,
    behaviour: 'worm',
    role: 'melee',
    resist: { heat: 1.25, emp: 0.8 },
    special: { name: 'Fork Bomb', chance: 1 },
    aggroRange: 16,
    lore: 'Splits in two when it takes a big hit. Finish it with heavy blows, not a thousand small ones.',
  },
  {
    key: 'kernel_guardian',
    name: 'Kernel Guardian',
    image: 'kernel_guardian.png',
    color: '#4fa8ff',
    size: 2.9,
    speed: 2.6,
    hp: 220,
    damage: 22,
    range: 2.6,
    attackTime: 2.4,
    windup: 1.1,
    xp: 45,
    credits: 60,
    corruption: 8,
    behaviour: 'guardian',
    role: 'tank',
    machine: true,
    resist: { laser: 0.7, emp: 1.3 },
    special: { name: 'System Purge', chance: 0.4 },
    aggroRange: 16,
    lore: 'Guards doors and vaults. System Purge slams the floor in a marked circle, then it needs a moment to recover.',
  },
  {
    key: 'data_leviathan',
    name: 'Data Leviathan',
    image: 'data_leviathan.png',
    color: '#2effd5',
    size: 3.4,
    speed: 3.0,
    hp: 260,
    damage: 20,
    range: 18,
    attackTime: 3.0,
    windup: 1.0,
    xp: 60,
    credits: 80,
    corruption: 10,
    behaviour: 'leviathan',
    role: 'special',
    noclip: true,
    resist: { emp: 1.25, heat: 0.8 },
    special: { name: 'Corrupting Torrent', chance: 1 },
    aggroRange: 22,
    lore: 'Swims through the walls and sweeps corridors with a corrupting torrent. Hide behind a corner.',
  },
  {
    key: 'singularity',
    name: 'Singularity Anomaly',
    image: null,
    color: '#e0e0ff',
    size: 2.6,
    speed: 2.8,
    hp: 110,
    damage: 18,
    range: 2.2,
    attackTime: 2.6,
    windup: 0.7,
    xp: 30,
    credits: 40,
    corruption: 5,
    behaviour: 'singularity',
    role: 'special',
    resist: { laser: 0.8, emp: 1.2 },
    special: { name: 'Event Horizon', chance: 1 },
    aggroRange: 18,
    lore: 'Its gravity drags you in. Dash or Glitch Step out before the event horizon closes.',
  },
  {
    key: 'mainframe',
    name: 'The Mainframe',
    image: null,
    color: '#ff2a2a',
    size: 4.6,
    speed: 0,
    hp: 300,
    damage: 18,
    range: 30,
    attackTime: 2.0,
    windup: 0.8,
    xp: 400,
    credits: 1000,
    corruption: 0,
    behaviour: 'mainframe',
    role: 'tank',
    machine: true,
    stationary: true,
    resist: { laser: 0.8, emp: 1.2 },
    special: { name: 'Administrative Override', chance: 1 },
    aggroRange: 30,
    projectile: { kind: 'admin', speed: 16 },
    lore: 'The system administrator that never logged off. Shields itself with firewall nodes and calls reinforcements.',
  },
  {
    key: 'zero_day',
    name: 'Zero-Day Exploit',
    image: 'zero-day_exploit.png',
    color: '#ffffff',
    size: 2.2,
    speed: 6.0,
    hp: 90,
    damage: 0,
    range: 1.8,
    attackTime: 2.0,
    windup: 0.4,
    xp: 150,
    credits: 400,
    corruption: 10,
    behaviour: 'zeroday',
    role: 'special',
    noclip: false,
    resist: {},
    special: { name: 'Perfect Execution', chance: 0.15 },
    aggroRange: 22,
    lore: 'Extremely rare and invisible. It almost always misses, but one hit can delete you. Ping it and gang up on it.',
  },
  {
    key: 'rootkit_dragon',
    name: 'Rootkit Dragon',
    image: null,
    color: '#ff00aa',
    size: 4.4,
    speed: 3.3,
    hp: 400,
    damage: 26,
    range: 12,
    attackTime: 2.8,
    windup: 1.0,
    xp: 500,
    credits: 1500,
    corruption: 20,
    behaviour: 'dragon',
    role: 'tank',
    resist: { heat: 0.5, emp: 1.2 },
    special: { name: 'Privilege Escalation', chance: 1 },
    aggroRange: 26,
    lore: 'A raid boss that grows stronger for every hacker nearby. Bring friends.',
  },
  {
    key: 'turret',
    name: 'Ceiling Turret',
    image: null,
    color: '#ff5c5c',
    size: 1.2,
    speed: 0,
    hp: 40,
    damage: 7,
    range: 15,
    attackTime: 1.7,
    windup: 0.55,
    xp: 6,
    credits: 6,
    corruption: 1,
    behaviour: 'turret',
    role: 'ranged',
    machine: true,
    stationary: true,
    resist: { emp: 1.5 },
    aggroRange: 15,
    projectile: { kind: 'bolt', speed: 22 },
    lore: 'Hangs from the ceiling and paints you with a laser sight before it fires. EMP knocks it out.',
  },
  {
    key: 'mainframe_node',
    name: 'Firewall Node',
    image: null,
    color: '#ff8a3c',
    size: 2.2,
    speed: 0,
    hp: 120,
    damage: 0,
    range: 0,
    attackTime: 99,
    windup: 0,
    xp: 20,
    credits: 0,
    corruption: 0,
    behaviour: 'node',
    role: 'special',
    machine: true,
    stationary: true,
    resist: { emp: 1.3 },
    aggroRange: 0,
    lore: 'Feeds the Mainframe its shield. Destroy all four.',
  },
]

export const MONSTER_BY_KEY = Object.fromEntries(MONSTERS.map((m) => [m.key, m])) as Record<string, MonsterDef>

/** Health and damage growth per monster level. */
export const hpScale = (level: number) => Math.pow(1.12, level - 1)
export const damageScale = (level: number) => Math.pow(1.075, level - 1)
export const BOSS_HP_MULT = 10
export const BOSS_DAMAGE_MULT = 1.3
export const BOSS_SIZE_MULT = 1.45

export const monsterMaxHp = (def: MonsterDef, level: number, boss = false) =>
  Math.round(def.hp * hpScale(level) * (boss ? BOSS_HP_MULT : 1))
export const monsterDamage = (def: MonsterDef, level: number, boss = false) =>
  Math.max(1, Math.round(def.damage * damageScale(level) * (boss ? BOSS_DAMAGE_MULT : 1)))
export const monsterXp = (def: MonsterDef, level: number) => Math.round(def.xp * (1 + 0.5 * (level - 1)))
export const monsterCredits = (def: MonsterDef, level: number) => Math.round(def.credits * (1 + 0.3 * (level - 1)))

// --- Elites ------------------------------------------------------------------------
export type EliteKind = 'encrypted' | 'overclocked' | 'recursive' | 'leaky'
export const ELITES: Record<EliteKind, { name: string; color: string; desc: string }> = {
  encrypted: { name: 'Encrypted', color: '#4fa8ff', desc: 'Protected by a shield that recharges when left alone. EMP strips it.' },
  overclocked: { name: 'Overclocked', color: '#ff9a3c', desc: 'Moves and attacks much faster.' },
  recursive: { name: 'Recursive', color: '#7dff9a', desc: 'Splits into two copies when it dies.' },
  leaky: { name: 'Leaky', color: '#ffd34d', desc: 'Drops extra loot and credits.' },
}
export const ELITE_KINDS = Object.keys(ELITES) as EliteKind[]
export const ELITE_HP_MULT = 2.5
export const ELITE_DAMAGE_MULT = 1.3
export const ELITE_XP_MULT = 3
export const ELITE_CHANCE = [0.05, 0.07, 0.09, 0.11]

// --- Spawning ------------------------------------------------------------------------
/** Which monsters roam each sector, with spawn weights. */
export const SPAWN_TABLES: Record<string, number>[] = [
  { byte_mite: 30, junk_scuttler: 25, packet_swarm: 20, firewall_imp: 20, logic_bomb: 5 },
  {
    byte_mite: 12,
    junk_scuttler: 14,
    packet_swarm: 10,
    firewall_imp: 16,
    null_phantom: 16,
    phase_spider: 14,
    logic_bomb: 8,
    recursive_worm: 10,
  },
  {
    packet_swarm: 8,
    firewall_imp: 12,
    null_phantom: 14,
    phase_spider: 14,
    logic_bomb: 10,
    recursive_worm: 16,
    trojan_goliath: 8,
    singularity: 10,
    kernel_guardian: 4,
  },
  {
    firewall_imp: 12,
    null_phantom: 12,
    phase_spider: 12,
    logic_bomb: 8,
    recursive_worm: 14,
    trojan_goliath: 12,
    singularity: 16,
    kernel_guardian: 10,
  },
]

export const SECTOR_BOSSES = ['trojan_goliath', 'kernel_guardian', 'data_leviathan', 'mainframe'] as const

/** Picks a pack for a sector: a leader plus followers that fill other roles. */
export function rollPack(rand: Rand, sector: number): string[] {
  const table = SPAWN_TABLES[sector]
  const keys = Object.keys(table)
  const leader = weighted(rand, keys, (k) => table[k])
  const def = MONSTER_BY_KEY[leader]
  if (def.behaviour === 'swarm') return new Array(4 + Math.floor(rand() * 3)).fill(leader)
  const size = [1, 1, 2, 2][sector] + Math.floor(rand() * 2)
  const pack = [leader]
  for (let i = 1; i < size; i++) {
    // Followers prefer roles the pack is missing: a tank wants shooters, shooters want a wall of melee.
    const roles = new Set(pack.map((k) => MONSTER_BY_KEY[k].role))
    const pick = weighted(rand, keys, (k) => {
      const d = MONSTER_BY_KEY[k]
      if (d.behaviour === 'swarm' || d.role === 'tank' || d.behaviour === 'bomber') return 0
      return table[k] * (roles.has(d.role) ? 0.4 : 1.6)
    })
    pack.push(pick)
  }
  return pack
}
