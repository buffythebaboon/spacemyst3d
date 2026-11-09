// The game's music, written as step patterns for the synthesiser in audio.ts. Every area of the
// station has its own song, and every boss has its own theme.
//
// A song is a chord progression per section (one chord per bar, as scale degrees) played in the
// order of its form, with parts layered on top. Each part plays a pattern of sixteenth notes; a
// pattern of 16 steps repeats every bar, a longer one spans several bars. Spaces and | in a pattern
// are only there to make it readable.
//
//   drums           x hit, o soft hit, . rest
//   bass, sub ...   x root, 3 third, 5 fifth, 7 seventh, o root an octave up
//   pads, keys ...  x the bar's chord
//   arp, pluck      0-7 the chord's notes from the bottom up
//   lead, bell      1-9 and a-e: scale degrees (8 is the octave)
//   any             - holds the note before it
//
// Tiers decide when a part plays. 0 always plays, -1 only while calm, 1 joins as a fight starts and
// 2 only in a heavy fight. In a boss theme the fight level rises as the boss loses health, so the
// theme builds toward the kill.

export type Inst =
  | 'kick'
  | 'kick2'
  | 'snare'
  | 'clap'
  | 'hat'
  | 'ohat'
  | 'shaker'
  | 'rim'
  | 'tom'
  | 'crash'
  | 'sub'
  | 'bass'
  | 'acid'
  | 'growl'
  | 'power'
  | 'pad'
  | 'strings'
  | 'choir'
  | 'organ'
  | 'brass'
  | 'keys'
  | 'arp'
  | 'pluck'
  | 'lead'
  | 'bell'
  | 'glitch'

export interface Part {
  i: Inst
  p: string
  tier?: -1 | 0 | 1 | 2
  /** Octave shift. */
  o?: number
  /** Volume, 1 by default. */
  v?: number
  /** Only in these sections. */
  in?: string
  /** Echo send. */
  d?: number
  /** Reverb send. */
  r?: number
}

export interface Song {
  name: string
  bpm: number
  /** The tonic as a MIDI note, around octave 2. */
  key: number
  scale: readonly number[]
  /** Chord roots per bar, as scale degrees, for each section. */
  prog: Record<string, string>
  form: string
  /** Where the form starts over, after an intro. */
  loop?: number
  swing?: number
  /** Overall level: 0.65 for an area, 1.15 for a boss unless set. */
  gain?: number
  /** A crash on the very first beat, for an entrance. */
  crash?: boolean
  parts: Part[]
}

export interface Step {
  c: string
  /** Length in steps, holds included. */
  len: number
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const HARMONIC = [0, 2, 3, 5, 7, 8, 11]
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10]

export const SONGS: Record<string, Song> = {
  // The hub: a safe place to sell loot and patch up. Warm, slow and a little lazy.
  hub: {
    name: 'Safehouse',
    bpm: 84,
    key: 48,
    scale: MAJOR,
    prog: { A: '6415', B: '2516' },
    form: 'AABA',
    swing: 0.14,
    parts: [
      { i: 'keys', p: 'x.......x..x.... ', r: 0.35, v: 0.9 },
      { i: 'pad', p: 'x---------------', v: 0.45, r: 0.4 },
      { i: 'sub', p: 'x-------x---5---', v: 0.9 },
      { i: 'kick', p: 'x.....x...x.....', v: 0.45 },
      { i: 'rim', p: '....x.......x...', v: 0.55 },
      { i: 'shaker', p: 'o.x.o.x.o.x.o.x.', v: 0.5 },
      { i: 'bell', in: 'A', d: 0.3, r: 0.3, v: 0.8, p: '3-..5-..6---.... |6-..5-..4---.... |3-..2-..1-..3-.. |2-------........' },
      { i: 'bell', in: 'B', d: 0.3, r: 0.3, v: 0.8, p: '4-..5-..6-..8-.. |7---5---........ |5-..3-..1-..2-.. |3-------........' },
    ],
  },

  // Cooling Channels: cold, glassy and wide.
  cooling: {
    name: 'Coolant Drift',
    bpm: 92,
    key: 42,
    scale: MINOR,
    prog: { A: '1637', B: '4167' },
    form: 'AABB',
    parts: [
      { i: 'pad', p: 'x---------------', v: 0.7, r: 0.5 },
      { i: 'pluck', p: '0..2..4..3..1...', o: 1, d: 0.45, r: 0.3, v: 0.75 },
      { i: 'sub', p: 'x-------5-------', v: 0.8 },
      { i: 'shaker', p: '..x...x...x...x.', v: 0.45 },
      { i: 'bell', tier: -1, in: 'B', d: 0.4, r: 0.4, v: 0.75, p: '6-------4---5--- |3-------1------- |6---5---3---1--- |2-------7-------' },
      { i: 'kick', tier: 1, p: 'x...x...x...x...', v: 0.8 },
      { i: 'hat', tier: 1, p: '..x...x...x...x.', v: 0.8 },
      { i: 'bass', tier: 1, p: 'x.x.x.xox.x.x.xo', v: 0.8 },
      { i: 'snare', tier: 2, p: '....x.......x...', v: 0.8 },
      { i: 'arp', tier: 2, p: '0123432101234321', o: 1, d: 0.25, v: 0.7 },
    ],
  },

  // Server Halls: a driving synth pulse between the racks.
  servers: {
    name: 'Server Halls',
    bpm: 112,
    key: 45,
    scale: MINOR,
    prog: { A: '1675', B: '4167' },
    form: 'AABA',
    parts: [
      { i: 'pad', p: 'x---------------', v: 0.5, r: 0.3 },
      { i: 'sub', p: 'x-------x-------', v: 0.8 },
      { i: 'arp', p: '0.1.2.3.2.1.0.1.', d: 0.4, v: 0.7 },
      { i: 'hat', p: '..o...o...o...o.', v: 0.6 },
      { i: 'lead', in: 'B', d: 0.3, r: 0.2, v: 0.7, p: '8-----7-6------- |5-----3-1------- |3-----4-5-----6- |7---------------' },
      { i: 'kick', tier: 1, p: 'x...x...x...x...' },
      { i: 'snare', tier: 1, p: '....x.......x...', v: 0.8 },
      { i: 'bass', tier: 1, p: 'x.x.x.x.x.x.x.xo', v: 0.85 },
      { i: 'arp', tier: 2, p: '0123012301230123', o: 1, d: 0.2, v: 0.6 },
      { i: 'clap', tier: 2, p: '....x.......x...', v: 0.7 },
      { i: 'hat', tier: 2, p: '.x.x.x.x.x.x.x.x', v: 0.6 },
    ],
  },

  // Corrupted Sector: wrong notes, stutters and an off-kilter beat.
  corrupted: {
    name: 'Corruption',
    bpm: 100,
    key: 40,
    scale: PHRYGIAN,
    prog: { A: '1217', B: '1621' },
    form: 'AABA',
    parts: [
      { i: 'strings', p: 'x---------------', v: 0.6, r: 0.4 },
      { i: 'sub', p: 'x--x--x--x--x-x-', v: 0.8 },
      { i: 'glitch', p: '...x.......x..x.', v: 0.6 },
      { i: 'rim', p: 'x..x..x..x..x...', v: 0.45 },
      { i: 'pluck', d: 0.5, v: 0.6, p: '0.1.......0.1... |................ |4...5...4...1... |................' },
      { i: 'kick2', tier: 1, p: 'x..x..x...x..x..', v: 0.8 },
      { i: 'growl', tier: 1, p: 'x.xx.x.xx.x.x.xx', v: 0.7 },
      { i: 'snare', tier: 1, p: '....x.......x...', v: 0.8 },
      { i: 'hat', tier: 2, p: 'xoxoxoxoxoxoxoxo', v: 0.6 },
      { i: 'glitch', tier: 2, p: 'x.x...xx..x.x.xx', v: 0.6 },
    ],
  },

  // The Core: slow, huge and solemn, a choir over a bell.
  core: {
    name: 'The Core',
    bpm: 76,
    key: 38,
    scale: HARMONIC,
    prog: { A: '1645', B: '4165' },
    form: 'AABA',
    parts: [
      { i: 'choir', p: 'x---------------', v: 0.9, r: 0.5 },
      { i: 'sub', p: 'x---------------', v: 0.9 },
      { i: 'bell', p: '1---------------', o: -1, v: 0.8, r: 0.6 },
      { i: 'strings', in: 'B', p: 'x-------x-------', v: 0.5, r: 0.4 },
      { i: 'tom', p: 'x.........o.....', v: 0.6, r: 0.3 },
      { i: 'kick', tier: 1, p: 'x.......x.x.....', v: 0.9 },
      { i: 'snare', tier: 1, p: '........x.......', v: 0.9, r: 0.3 },
      { i: 'pluck', tier: 1, p: '0.1.2.1.0.1.2.1.', o: -1, v: 0.8 },
      { i: 'brass', tier: 2, p: 'x.....x.....x...', v: 0.8 },
      { i: 'hat', tier: 2, p: '..x...x...x...x.', v: 0.7 },
    ],
  },

  // --- Bosses ---------------------------------------------------------------------------------------
  'boss:trojan_goliath': {
    name: 'Heavy Payload',
    bpm: 128,
    key: 40,
    scale: MINOR,
    prog: { A: '1167', B: '4465' },
    form: 'AABA',
    crash: true,
    parts: [
      { i: 'kick2', p: 'x...x...x...x..x' },
      { i: 'clap', p: '....x.......x...', v: 0.8 },
      { i: 'growl', p: 'x.xxx.x.x.xxx.x.', v: 0.8 },
      { i: 'power', p: 'x--.x--.x-x-x---', v: 0.7 },
      { i: 'rim', p: 'x..x..x..x..x.x.', v: 0.5 },
      { i: 'hat', p: '.x.x.x.x.x.x.x.x', v: 0.5 },
      { i: 'lead', tier: 1, in: 'B', d: 0.2, v: 0.8, p: '8---7-5-6---5-3- |5-------3------- |6---5-3-1---3-5- |7-------2---4---' },
      { i: 'crash', tier: 2, p: 'x...............................................................' },
      { i: 'hat', tier: 2, p: 'xxxxxxxxxxxxxxxx', v: 0.4 },
    ],
  },

  'boss:kernel_guardian': {
    name: 'Root Access',
    bpm: 136,
    key: 47,
    scale: HARMONIC,
    prog: { A: '1465', B: '6415' },
    form: 'AABA',
    crash: true,
    parts: [
      { i: 'organ', p: 'x-------x-------', v: 0.7, r: 0.4 },
      { i: 'kick', p: 'x.......x.......' },
      { i: 'snare', p: 'o.oxo.o.o.oxo.xx', v: 0.6 },
      { i: 'tom', p: 'x...............', v: 0.7 },
      { i: 'bass', p: 'x.x.x.x.x.x.x.x.', v: 0.8 },
      { i: 'lead', d: 0.2, r: 0.2, v: 0.8, p: '1---5---8---7-6- |6---4---1------- |3---1---6---5-6- |7---5---2---7---' },
      { i: 'strings', tier: 1, p: 'x---------------', v: 0.6 },
      { i: 'arp', tier: 2, p: '0123012301230123', o: 1, v: 0.5 },
    ],
  },

  'boss:data_leviathan': {
    name: 'Deep Packet',
    bpm: 104,
    key: 44,
    scale: MINOR,
    prog: { A: '1767', B: '6415' },
    form: 'AABA',
    crash: true,
    parts: [
      { i: 'acid', p: 'x..x..x.x..x..xo', v: 0.9 },
      { i: 'pad', p: 'x---------------', v: 0.6, r: 0.5 },
      { i: 'pluck', p: '0.2.4.2.0.2.4.6.', d: 0.5, v: 0.7 },
      { i: 'kick', p: 'x.....x...x.....' },
      { i: 'snare', p: '........x.......', v: 0.8, r: 0.3 },
      { i: 'lead', in: 'B', d: 0.35, r: 0.3, v: 0.75, p: '1---3---6---5--- |4-------3------- |1---5---8---7--- |5-------........' },
      { i: 'hat', tier: 1, p: '..x...x...x...x.', v: 0.6 },
      { i: 'hat', tier: 2, p: '.x.x.x.x.x.x.x.x', v: 0.5 },
    ],
  },

  'boss:mainframe': {
    name: 'Administrator',
    bpm: 150,
    key: 38,
    scale: HARMONIC,
    prog: { A: '1645', B: '4165' },
    form: 'AABA',
    crash: true,
    gain: 1.3,
    parts: [
      { i: 'choir', p: 'x-------x-------', v: 0.8, r: 0.4 },
      { i: 'kick2', p: 'x..x..x.x..x..x.', v: 0.9 },
      { i: 'snare', p: '....x.......x...', v: 0.9 },
      { i: 'growl', p: 'x.x.x.x.x.x.x.x.', v: 0.7 },
      { i: 'tom', p: '................................................................ |............................................................xxoo' },
      { i: 'lead', d: 0.2, r: 0.3, v: 0.8, p: '1---5---8------- |6---8---a------- |9---8---6---4--- |7-------5-------' },
      { i: 'pluck', tier: 1, p: '0102010201020102', v: 0.7 },
      { i: 'hat', tier: 1, p: '..x...x...x...x.', v: 0.6 },
      { i: 'brass', tier: 2, p: 'x..x..x...x..x..', v: 0.8 },
      { i: 'crash', tier: 2, p: 'x...............................................................' },
    ],
  },

  'boss:zero_day': {
    name: 'Exploit',
    bpm: 160,
    key: 37,
    scale: PHRYGIAN,
    prog: { A: '1212', B: '6521' },
    form: 'AABA',
    crash: true,
    parts: [
      { i: 'kick', p: 'x.....x...x.....' },
      { i: 'clap', p: '....x..x.x..x...', v: 0.7 },
      { i: 'glitch', p: 'x.x...xx..x.x.xx', v: 0.7 },
      { i: 'acid', p: 'x.xox.xox.xox.xo', v: 0.8 },
      { i: 'arp', p: '0123012301230123', o: 1, d: 0.3, v: 0.6 },
      { i: 'hat', p: '.xxx.xxx.xxx.xxx', v: 0.4 },
      { i: 'lead', tier: 1, in: 'B', d: 0.25, v: 0.7, p: '8-8-7-8-5---.... |6-6-5-6-2---.... |1-2-1-2-3-2-1-.. |2---------------' },
    ],
  },

  'boss:rootkit_dragon': {
    name: 'Privilege Escalation',
    bpm: 144,
    key: 41,
    scale: MINOR,
    prog: { A: '1671', B: '4671' },
    form: 'AABA',
    crash: true,
    gain: 1.3,
    parts: [
      { i: 'power', p: 'x.xxx.xxx.xxx.xx', v: 0.7 },
      { i: 'kick2', p: 'x.x.x.x.x.x.x.x.', v: 0.8 },
      { i: 'snare', p: '....x.......x...', v: 0.9 },
      { i: 'growl', p: 'x.xxx.xxx.xxx.xx', v: 0.6 },
      { i: 'lead', in: 'A', d: 0.2, r: 0.2, v: 0.8, p: '1-3-5-8-7---5--- |6---8---a---8--- |7---5---2---7--- |8---------------' },
      { i: 'lead', in: 'B', d: 0.2, r: 0.2, v: 0.8, p: '8---7---6---5--- |6---5---4---3--- |4---5---6---7--- |8-------........' },
      { i: 'choir', tier: 1, p: 'x---------------', v: 0.6 },
      { i: 'hat', tier: 2, p: 'xxxxxxxxxxxxxxxx', v: 0.4 },
    ],
  },
}

/** The pattern as one entry per step: the note that starts there, or null. */
export function steps(p: string): (Step | null)[] {
  const s = p.replace(/[\s|]/g, '')
  const out: (Step | null)[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '.' || c === '-') {
      out.push(null)
      continue
    }
    let len = 1
    while (s[(i + len) % s.length] === '-' && len < s.length) len++
    out.push({ c, len })
  }
  return out
}
