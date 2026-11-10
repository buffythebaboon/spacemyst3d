// Achievements. Most are counter goals; a few are granted directly by the server.

export interface AchievementDef {
  id: string
  name: string
  desc: string
  /** Counter in CharacterData.counters, and the value that unlocks it. */
  counter?: string
  goal?: number
  credits: number
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_blood', name: 'First Blood', desc: 'Delete your first program.', counter: 'kills', goal: 1, credits: 25 },
  { id: 'kills_100', name: 'Garbage Collector', desc: 'Delete 100 programs.', counter: 'kills', goal: 100, credits: 200 },
  { id: 'kills_1000', name: 'Antivirus', desc: 'Delete 1,000 programs.', counter: 'kills', goal: 1000, credits: 1500 },
  { id: 'elites_10', name: 'Elite Hunter', desc: 'Delete 10 elite programs.', counter: 'elites', goal: 10, credits: 300 },
  { id: 'boss_trojan_goliath', name: 'Beware of Geeks', desc: 'Defeat the Trojan Goliath.', counter: 'boss_trojan_goliath', goal: 1, credits: 300 },
  { id: 'boss_kernel_guardian', name: 'Kernel Panic', desc: 'Defeat the Kernel Guardian.', counter: 'boss_kernel_guardian', goal: 1, credits: 500 },
  { id: 'boss_data_leviathan', name: 'Deep Dive', desc: 'Defeat the Data Leviathan.', counter: 'boss_data_leviathan', goal: 1, credits: 800 },
  { id: 'boss_mainframe', name: 'Logged Off', desc: 'Defeat The Mainframe.', counter: 'boss_mainframe', goal: 1, credits: 2000 },
  { id: 'zero_day', name: 'Patched', desc: 'Delete a Zero-Day Exploit.', counter: 'kill_zero_day', goal: 1, credits: 600 },
  { id: 'rootkit', name: 'Dragonslayer', desc: 'Slay the Rootkit Dragon.', counter: 'kill_rootkit_dragon', goal: 1, credits: 1200 },
  { id: 'alchemist', name: 'Alchemist', desc: 'Drink every kind of potion at least once.', counter: 'potionKinds', goal: 10, credits: 400 },
  { id: 'puzzle_relay', name: 'Electrician', desc: 'Restore power to a relay vault.', counter: 'puzzle_relay', goal: 1, credits: 250 },
  { id: 'puzzle_cipher', name: 'Cryptographer', desc: 'Crack a cipher door.', counter: 'puzzle_cipher', goal: 1, credits: 250 },
  { id: 'puzzle_mirror', name: 'Lightbender', desc: 'Guide the beam in a mirror lab.', counter: 'puzzle_mirror', goal: 1, credits: 250 },
  { id: 'puzzle_plates', name: 'Better Together', desc: 'Hold down twin pressure plates.', counter: 'puzzle_plates', goal: 1, credits: 250 },
  { id: 'secrets_5', name: 'Wall Whisperer', desc: 'Find 5 hidden rooms.', counter: 'secrets', goal: 5, credits: 400 },
  { id: 'fragments_8', name: 'Archivist', desc: 'Collect 8 data fragments.', counter: 'codex', goal: 8, credits: 300 },
  { id: 'fragments_all', name: 'The Whole Story', desc: 'Collect every data fragment.', counter: 'codex', goal: 16, credits: 1000 },
  { id: 'level_10', name: 'Upgraded', desc: 'Reach level 10.', counter: 'level', goal: 10, credits: 300 },
  { id: 'level_20', name: 'Overclocked', desc: 'Reach level 20.', counter: 'level', goal: 20, credits: 800 },
  { id: 'level_30', name: 'Root User', desc: 'Reach level 30.', counter: 'level', goal: 30, credits: 2000 },
  { id: 'legendary', name: 'Shiny', desc: 'Find a legendary item.', counter: 'legendaries', goal: 1, credits: 200 },
  { id: 'shatter', name: 'Shatterpoint', desc: 'Shatter a frozen program with System Shock.', counter: 'shatters', goal: 1, credits: 150 },
  { id: 'sleeper', name: 'Rude Awakening', desc: 'Land a critical hit on a sleeping program.', counter: 'sleepcrits', goal: 1, credits: 150 },
  { id: 'dump', name: 'Data Recovery', desc: 'Get back to your data dump after a crash.', counter: 'dumps', goal: 1, credits: 150 },
  { id: 'rich', name: 'Crypto Whale', desc: 'Hold 10,000 credits at once.', credits: 0 },
  { id: 'spotless', name: 'Spotless', desc: 'Help purge a sector without crashing in the last 30 minutes.', credits: 500 },
  { id: 'season', name: 'End of an Era', desc: 'Be there when The Mainframe falls.', credits: 1000 },
]

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a])) as Record<string, AchievementDef>
