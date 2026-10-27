// Talent tree: three branches, one point per level from level 2.

export type Branch = 'hacker' | 'soldier' | 'engineer'

export interface TalentDef {
  id: string
  branch: Branch
  name: string
  desc: string
  ranks: number
  /** Points already spent in the branch before this talent can be learned. */
  requires: number
}

export const BRANCHES: { id: Branch; name: string; desc: string; color: string }[] = [
  { id: 'hacker', name: 'Hacker', desc: 'Spells and mana', color: '#5cf2ff' },
  { id: 'soldier', name: 'Soldier', desc: 'Weapons and HP', color: '#ff7a3c' },
  { id: 'engineer', name: 'Engineer', desc: 'Drones, traps and Firewall', color: '#ffd34d' },
]

export const TALENTS: TalentDef[] = [
  { id: 'hk_mana', branch: 'hacker', name: 'Expanded Buffer', desc: '+10% max mana per rank.', ranks: 3, requires: 0 },
  { id: 'hk_efficient', branch: 'hacker', name: 'Efficient Code', desc: 'Spells cost 6% less mana per rank.', ranks: 3, requires: 0 },
  { id: 'hk_ping', branch: 'hacker', name: 'Ping', desc: 'Unlocks Ping: see monsters and items through walls.', ranks: 1, requires: 3 },
  { id: 'hk_chain', branch: 'hacker', name: 'Daisy Chain', desc: 'System Shock jumps to one more target and deals 10% more damage per rank.', ranks: 2, requires: 3 },
  { id: 'hk_hijack', branch: 'hacker', name: 'Hijack', desc: 'Unlocks Hijack: take over a wounded program.', ranks: 1, requires: 6 },
  { id: 'hk_root', branch: 'hacker', name: 'Root Access', desc: '10% shorter spell cooldowns and 10% more spell damage per rank.', ranks: 2, requires: 6 },

  { id: 'sd_chassis', branch: 'soldier', name: 'Reinforced Chassis', desc: '+8% max HP per rank.', ranks: 3, requires: 0 },
  { id: 'sd_aim', branch: 'soldier', name: 'Target Lock', desc: '+3% critical chance per rank.', ranks: 3, requires: 0 },
  { id: 'sd_rapid', branch: 'soldier', name: 'Rapid Cycling', desc: '+5% fire rate per rank.', ranks: 3, requires: 3 },
  { id: 'sd_dash', branch: 'soldier', name: 'Afterburner', desc: 'Dash recharges 20% faster per rank.', ranks: 2, requires: 3 },
  { id: 'sd_overkill', branch: 'soldier', name: 'Overkill', desc: '+20% damage to programs below 30% HP per rank.', ranks: 2, requires: 6 },
  { id: 'sd_blood', branch: 'soldier', name: 'Blood Protocol', desc: 'Kills restore 3% of your max HP per rank.', ranks: 2, requires: 6 },

  { id: 'en_thermal', branch: 'engineer', name: 'Thermal Rounds', desc: '+6% burn chance and 20% more burn damage per rank.', ranks: 3, requires: 0 },
  { id: 'en_firewall', branch: 'engineer', name: 'Hardened Firewall', desc: 'Firewall lasts 2 seconds longer and burns 25% harder per rank.', ranks: 2, requires: 0 },
  { id: 'en_honeypot', branch: 'engineer', name: 'Honeypot', desc: 'Unlocks Honeypot: a decoy monsters attack instead of you.', ranks: 1, requires: 3 },
  { id: 'en_grenadier', branch: 'engineer', name: 'Grenadier', desc: 'Carry one more of each grenade and deal 15% more grenade damage per rank.', ranks: 2, requires: 3 },
  { id: 'en_daemon', branch: 'engineer', name: 'Daemon', desc: 'Unlocks Daemon: a drone that fights beside you.', ranks: 1, requires: 6 },
  { id: 'en_scrap', branch: 'engineer', name: 'Scrap Dealer', desc: '+10% credits and 5% lower black market prices per rank.', ranks: 2, requires: 6 },
]

export const TALENT_BY_ID = Object.fromEntries(TALENTS.map((t) => [t.id, t])) as Record<string, TalentDef>

export const talentPointsForLevel = (level: number) => Math.max(0, level - 1)

export const spentPoints = (talents: Record<string, number>) => Object.values(talents).reduce((s, n) => s + n, 0)

export const branchPoints = (talents: Record<string, number>, branch: Branch) =>
  TALENTS.filter((t) => t.branch === branch).reduce((s, t) => s + (talents[t.id] ?? 0), 0)

/** Why a talent cannot be learned right now, or null if it can. */
export function talentBlocker(talents: Record<string, number>, level: number, id: string): string | null {
  const t = TALENT_BY_ID[id]
  if (!t) return 'Unknown talent.'
  if ((talents[id] ?? 0) >= t.ranks) return 'Already at max rank.'
  if (spentPoints(talents) >= talentPointsForLevel(level)) return 'No talent points left. You get one per level.'
  if (branchPoints(talents, t.branch) < t.requires) return `Spend ${t.requires} points in ${t.branch === 'hacker' ? 'Hacker' : t.branch === 'soldier' ? 'Soldier' : 'Engineer'} first.`
  return null
}

/** Credits it costs to reset all talents. */
export const respecCost = (level: number) => 50 * level
