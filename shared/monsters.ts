export interface AttackDef {
  damage: number
  multiplier?: number
}

export interface MonsterTemplate {
  key: string
  name: string
  tier: number
  /** File in /monsters/, or null to draw a procedural glitch sprite. */
  image: string | null
  hp: number
  rarity: number
  coins: number
  hpReward: number
  missChance: number
  attack: AttackDef
  special: { name: string; chance: number; attack: AttackDef } | null
  /** Sprite height in world units. */
  size: number
  speed: number
  color: string
}

// Ported from the original Spacemyst monster list.
export const MONSTERS: MonsterTemplate[] = [
  { key: 'byte_mite', name: 'Byte Mite', tier: 1, image: 'byte_mite.png', hp: 15, rarity: 30, coins: 6, hpReward: 1, missChance: 0.15, attack: { damage: 4 }, special: null, size: 1.3, speed: 3.6, color: '#7dff9a' },
  { key: 'junk_scuttler', name: 'Junk-Code Scuttler', tier: 1, image: 'junk-code_scuttler.png', hp: 22, rarity: 25, coins: 10, hpReward: 1, missChance: 0.1, attack: { damage: 6 }, special: null, size: 1.6, speed: 3.2, color: '#c9ff5c' },
  { key: 'packet_swarm', name: 'Packet Swarm', tier: 1, image: 'packet_swarm.png', hp: 25, rarity: 20, coins: 12, hpReward: 1, missChance: 0.1, attack: { damage: 5 }, special: null, size: 2.0, speed: 4.2, color: '#5cf2ff' },
  { key: 'firewall_imp', name: 'Firewall Imp', tier: 1, image: 'firewall_imp.png', hp: 20, rarity: 20, coins: 15, hpReward: 2, missChance: 0.1, attack: { damage: 8 }, special: { name: 'Burst Fire', chance: 0.2, attack: { damage: 6, multiplier: 1.5 } }, size: 1.7, speed: 3.8, color: '#ff7a3c' },
  { key: 'null_phantom', name: 'Null-Pointer Phantom', tier: 2, image: 'null-pointer_phantom.png', hp: 40, rarity: 15, coins: 25, hpReward: 2, missChance: 0.15, attack: { damage: 12 }, special: { name: 'Memory Leak', chance: 0.25, attack: { damage: 10, multiplier: 1.5 } }, size: 2.2, speed: 3.4, color: '#b48cff' },
  { key: 'phase_spider', name: 'Phase Spider', tier: 2, image: null, hp: 45, rarity: 12, coins: 32, hpReward: 3, missChance: 0.45, attack: { damage: 10 }, special: { name: 'Phase Strike', chance: 0.25, attack: { damage: 12, multiplier: 1.6 } }, size: 1.8, speed: 4.6, color: '#ff4fd8' },
  { key: 'trojan_goliath', name: 'Trojan Goliath', tier: 2, image: null, hp: 65, rarity: 10, coins: 40, hpReward: 3, missChance: 0.05, attack: { damage: 16 }, special: { name: 'Payload Delivery', chance: 0.3, attack: { damage: 14, multiplier: 2 } }, size: 2.8, speed: 2.6, color: '#ffb347' },
  { key: 'logic_bomb', name: 'Logic Bomb', tier: 3, image: null, hp: 1, rarity: 8, coins: 60, hpReward: 1, missChance: 0, attack: { damage: 1 }, special: { name: 'DETONATE', chance: 0.75, attack: { damage: 40, multiplier: 1.5 } }, size: 1.4, speed: 5.2, color: '#ff3355' },
  { key: 'recursive_worm', name: 'Recursive Worm', tier: 3, image: null, hp: 80, rarity: 7, coins: 55, hpReward: 4, missChance: 0.1, attack: { damage: 22 }, special: { name: 'Fork Bomb', chance: 0.25, attack: { damage: 20, multiplier: 2.5 } }, size: 2.4, speed: 3.0, color: '#9dff00' },
  { key: 'kernel_guardian', name: 'Kernel Guardian', tier: 3, image: 'kernel_guardian.png', hp: 120, rarity: 6, coins: 80, hpReward: 6, missChance: 0.15, attack: { damage: 28 }, special: { name: 'System Purge', chance: 0.15, attack: { damage: 25, multiplier: 2 } }, size: 3.0, speed: 2.4, color: '#4fa8ff' },
  { key: 'data_leviathan', name: 'Data Leviathan', tier: 4, image: 'data_leviathan.png', hp: 200, rarity: 4, coins: 150, hpReward: 10, missChance: 0.1, attack: { damage: 35 }, special: { name: 'Corrupting Torrent', chance: 0.33, attack: { damage: 30, multiplier: 2 } }, size: 3.6, speed: 2.4, color: '#2effd5' },
  { key: 'mainframe', name: 'The Mainframe', tier: 4, image: null, hp: 350, rarity: 3, coins: 350, hpReward: 25, missChance: 0.05, attack: { damage: 45 }, special: { name: 'Administrative Override', chance: 0.2, attack: { damage: 40, multiplier: 2.5 } }, size: 3.8, speed: 1.8, color: '#ff2a2a' },
  { key: 'singularity', name: 'Singularity Anomaly', tier: 4, image: null, hp: 150, rarity: 3, coins: 180, hpReward: 5, missChance: 0, attack: { damage: 50 }, special: { name: 'Event Horizon', chance: 0.25, attack: { damage: 45, multiplier: 1.8 } }, size: 3.2, speed: 2.8, color: '#e0e0ff' },
  { key: 'zero_day', name: 'Zero-Day Exploit', tier: 5, image: 'zero-day_exploit.png', hp: 50, rarity: 1, coins: 600, hpReward: 50, missChance: 0.9, attack: { damage: 80 }, special: { name: 'Perfect Execution', chance: 0.5, attack: { damage: 100 } }, size: 2.4, speed: 5.5, color: '#ffffff' },
  { key: 'rootkit_dragon', name: 'Rootkit Dragon', tier: 5, image: null, hp: 800, rarity: 1, coins: 1200, hpReward: 100, missChance: 0.1, attack: { damage: 65 }, special: { name: 'Privilege Escalation', chance: 0.25, attack: { damage: 75, multiplier: 2.5 } }, size: 4.2, speed: 2.6, color: '#ff00aa' },
]

export const MONSTER_BY_KEY = Object.fromEntries(MONSTERS.map((m) => [m.key, m])) as Record<string, MonsterTemplate>

export const attackDamage = (a: AttackDef) => Math.floor(a.damage * (a.multiplier ?? 1))

export function pickMonster(rand: () => number, maxTier = 5): MonsterTemplate {
  const pool = MONSTERS.filter((m) => m.tier <= maxTier)
  const total = pool.reduce((s, m) => s + m.rarity, 0)
  let r = rand() * total
  for (const m of pool) {
    if (r < m.rarity) return m
    r -= m.rarity
  }
  return pool[0]
}
