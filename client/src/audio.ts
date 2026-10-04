// Spacemyst 3D sound kit. Everything is synthesised at runtime from oscillators,
// filtered noise and gain envelopes, so the game ships no audio files.
//
// Signal flow
//   one-shot voice -> per-sound bus (volume, distance low-pass, pan) -> sfx bus
//                                        \-> reverb send -> convolver -> sfx bus
//   sfx bus -> muffle low-pass (setMuffled) -> master
//   ambience layers -> ambience bus -> master
//   combat / boss music -> music bus -> master
//   master -> compressor -> limiter -> speakers
//
// Every export is a safe no-op until initAudio() has created the AudioContext, and
// stays one when the browser has no Web Audio. The setters remember what they were
// asked for, so a volume or ambience chosen before initAudio() applies once it runs.

type NoiseColor = 'white' | 'pink' | 'brown' | 'crackle' | 'digital'
type Shape = 'drive' | 'crush'
type Srcs = AudioScheduledSourceNode[]

export type WeaponKind = 'laser' | 'blade' | 'plasma' | 'railgun' | 'cannon' | 'horizon'
export type ExplosionKind = 'emp' | 'glitch' | 'noise' | 'acid' | 'toxic' | 'neutron' | 'bomb' | 'horizon'
export type MonsterSoundKind = 'aggro' | 'windup' | 'attack' | 'die' | 'special'
export type WorldEventKind = 'outage' | 'outbreak' | 'zeroday' | 'rootkit' | 'season'

const MAX_VOICES = 40 // one-shot voices alive at once; newer sounds are dropped beyond this
const THROTTLE_MS = 25 // the same sound fired again within this window is skipped
const LOOKAHEAD = 0.1 // seconds of music scheduled ahead of the audio clock
// Bus levels. The compressor adds ~4 dB of make-up gain, which MASTER_LEVEL offsets.
const MASTER_LEVEL = 0.55
const SFX_LEVEL = 0.9
const MUSIC_LEVEL = 1.1
const AMB_LEVEL = 0.3

let ctx: AudioContext | null = null
let master: GainNode | null = null
let musicBus: GainNode | null = null
let ambBus: GainNode | null = null
let sfxBus: GainNode | null = null
let muffle: BiquadFilterNode | null = null
let muffleGain: GainNode | null = null
let reverbIn: GainNode | null = null
let heartGain: GainNode | null = null
let startedAt = 0
let driveCurve: Float32Array<ArrayBuffer> | null = null
let crushCurve: Float32Array<ArrayBuffer> | null = null
const noiseBufs = new Map<NoiseColor, AudioBuffer>()

const AMBIENCES = ['cooling', 'servers', 'corrupted', 'core'] as const
type AmbienceId = (typeof AMBIENCES)[number] | 'hub'

// What the game asked for. Applied at once while audio runs, otherwise by initAudio().
const want = {
  master: 1,
  music: 1,
  sfx: 1,
  amb: 'cooling' as AmbienceId,
  combat: 0,
  boss: false,
  lowHealth: false,
  muffled: false,
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)
const fin = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d)
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const hz = (f: number) => clamp(fin(f, 440), 1, 20000)
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const ramp01 = (x: number, a: number, b: number) => clamp((x - a) / (b - a), 0, 1)
const curve = (v: number) => v * v // perceptual volume curve for the setters

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function initAudio() {
  if (ctx) {
    resume()
    return
  }
  if (typeof window === 'undefined') return
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  const AC = w.AudioContext ?? w.webkitAudioContext
  if (!AC) return
  let c: AudioContext
  try {
    c = new AC()
  } catch {
    return
  }
  ctx = c
  startedAt = performance.now()

  // Gentle glue compression, then a soft-knee safety clipper as the limiter: it is
  // linear below 0.6 and can never exceed ~0.9, and unlike a second compressor it
  // adds no automatic make-up gain.
  const comp = c.createDynamicsCompressor()
  comp.threshold.value = -12
  comp.knee.value = 12
  comp.ratio.value = 2.5
  comp.attack.value = 0.006
  comp.release.value = 0.25
  const limiter = c.createWaveShaper()
  limiter.curve = makeCurve(2048, (x) => (Math.abs(x) < 0.6 ? x : Math.sign(x) * (0.6 + 0.4 * Math.tanh((Math.abs(x) - 0.6) / 0.4))))
  limiter.oversample = '2x'
  master = c.createGain()
  master.connect(comp)
  comp.connect(limiter)
  limiter.connect(c.destination)

  musicBus = gainTo(c, 0, master)
  ambBus = gainTo(c, 0, master)
  muffleGain = gainTo(c, 1, master)
  muffle = filterTo(c, 'lowpass', maxCutoff(c), 0.7, muffleGain)
  sfxBus = gainTo(c, 0, muffle)
  heartGain = gainTo(c, 0, sfxBus)

  for (const [color, seconds] of [['white', 2], ['pink', 4], ['brown', 4], ['crackle', 2], ['digital', 1]] as const) {
    noiseBufs.set(color, makeNoise(c, color, seconds))
  }
  driveCurve = makeCurve(1024, (x) => Math.tanh(3 * x) / Math.tanh(3))
  crushCurve = makeCurve(1024, (x) => Math.round(x * 6) / 6)

  reverbIn = c.createGain()
  const verb = c.createConvolver()
  verb.buffer = makeImpulse(c, 1.8)
  reverbIn.connect(verb)
  verb.connect(gainTo(c, 0.4, sfxBus))

  applyMix(true)
  applyMuffle()
  applyLowHealth()
  applyAmbience()
  if (want.combat > 0 || want.boss) startMusic()
  setInterval(bgTick, 50) // lives for the whole session, like the context itself

  // Browsers may create the context suspended until a gesture; resume on the next one.
  resume()
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, resume, true)
}

function resume() {
  if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return
  const p = ctx.resume() as Promise<void> | undefined // very old WebKit returns nothing
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

function maxCutoff(c: BaseAudioContext) {
  return Math.min(20000, c.sampleRate * 0.45)
}

function makeNoise(c: AudioContext, color: NoiseColor, seconds: number): AudioBuffer {
  const rate = c.sampleRate
  const len = Math.floor(rate * seconds)
  const fade = Math.floor(rate * 0.05)
  const raw = new Float32Array(len + fade)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, amp = 0, hold = 0
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1
    switch (color) {
      case 'pink':
        b0 = 0.99886 * b0 + w * 0.0555179
        b1 = 0.99332 * b1 + w * 0.0750759
        b2 = 0.969 * b2 + w * 0.153852
        b3 = 0.8665 * b3 + w * 0.3104856
        b4 = 0.55 * b4 + w * 0.5329522
        b5 = -0.7616 * b5 - w * 0.016898
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
        b6 = w * 0.115926
        break
      case 'brown':
        last = (last + 0.02 * w) / 1.02
        raw[i] = last * 3.5
        break
      case 'crackle': // sparse decaying clicks: fire, sparks, relays
        if (Math.random() < 0.0012) amp = (0.3 + 0.7 * Math.random()) * (w < 0 ? -1 : 1)
        raw[i] = amp
        amp *= 0.6
        break
      case 'digital': // stepped sample-and-hold noise: bit-crushed data hash
        if (--hold <= 0) {
          last = Math.round(w * 4) / 4
          hold = 3 + Math.floor(Math.random() * 28)
        }
        raw[i] = last
        break
      default:
        raw[i] = w
    }
  }
  // Cross-fade the overhang into the start so the buffer loops without a click.
  const buf = c.createBuffer(1, len, rate)
  const d = buf.getChannelData(0)
  d.set(raw.subarray(0, len))
  for (let i = 0; i < fade; i++) {
    const k = i / fade
    d[i] = raw[i] * k + raw[len + i] * (1 - k)
  }
  return buf
}

function makeImpulse(c: AudioContext, seconds: number): AudioBuffer {
  const rate = c.sampleRate
  const len = Math.floor(rate * seconds)
  const pre = Math.floor(rate * 0.012)
  const buf = c.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let y = 0
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre)
      y += (Math.random() * 2 - 1 - y) * (0.85 - 0.7 * x) // darker as the tail decays
      d[i] = y * (1 - x) * (1 - x) * Math.exp(-4 * x)
    }
  }
  return buf
}

function makeCurve(n: number, fn: (x: number) => number): Float32Array<ArrayBuffer> {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = fn((i / (n - 1)) * 2 - 1)
  return a
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function gainTo(c: BaseAudioContext, v: number, dest: AudioNode): GainNode {
  const g = c.createGain()
  g.gain.value = v
  g.connect(dest)
  return g
}

function filterTo(c: BaseAudioContext, type: BiquadFilterType, f: number, q: number, dest: AudioNode): BiquadFilterNode {
  const b = c.createBiquadFilter()
  b.type = type
  b.frequency.value = hz(f)
  b.Q.value = q
  b.connect(dest)
  return b
}

function oscTo(c: BaseAudioContext, S: Srcs, type: OscillatorType, f: number, dest: AudioNode, gain = 1, detune = 0): OscillatorNode {
  const o = c.createOscillator()
  o.type = type
  o.frequency.value = hz(f)
  o.detune.value = detune
  o.connect(gain === 1 ? dest : gainTo(c, gain, dest))
  o.start()
  S.push(o)
  return o
}

function lfoTo(c: BaseAudioContext, S: Srcs, rate: number, depth: number, ...params: AudioParam[]): OscillatorNode {
  const o = c.createOscillator()
  o.frequency.value = rate
  const g = c.createGain()
  g.gain.value = depth
  o.connect(g)
  for (const p of params) g.connect(p)
  o.start()
  S.push(o)
  return o
}

function bedTo(c: BaseAudioContext, S: Srcs, color: NoiseColor, dest: AudioNode, gain: number, rate = 1) {
  const b = noiseBufs.get(color)
  if (!b) return
  const s = c.createBufferSource()
  s.buffer = b
  s.loop = true
  s.playbackRate.value = rate
  s.connect(gainTo(c, gain, dest))
  s.start(0, Math.random() * b.duration * 0.9)
  S.push(s)
}

function shaperNode(c: BaseAudioContext, s: Shape): WaveShaperNode {
  const w = c.createWaveShaper()
  w.curve = s === 'drive' ? driveCurve : crushCurve
  return w
}

function pannerNode(c: BaseAudioContext, p: number): AudioNode {
  if (typeof c.createStereoPanner !== 'function') return c.createGain()
  const sp = c.createStereoPanner()
  sp.pan.value = clamp(fin(p, 0), -1, 1)
  return sp
}

function sweepFilter(c: BaseAudioContext, type: BiquadFilterType, f: number, q: number, t: number, f2?: number, t2?: number) {
  const b = c.createBiquadFilter()
  b.type = type
  b.Q.value = q
  b.frequency.setValueAtTime(hz(f), t)
  if (f2 !== undefined && t2 !== undefined) b.frequency.exponentialRampToValueAtTime(hz(f2), t2)
  return b
}

function envelope(p: AudioParam, t: number, a: number, hold: number, d: number, peak: number) {
  const pk = Math.max(0.0002, peak)
  p.setValueAtTime(0.0001, t)
  // Long attacks (wind-ups, charges, swells) rise linearly so they are heard building;
  // an exponential rise from silence stays inaudible for most of its length.
  if (a >= 0.05) p.linearRampToValueAtTime(pk, t + a)
  else p.exponentialRampToValueAtTime(pk, t + a)
  if (hold > 0) p.setValueAtTime(pk, t + a + hold)
  p.exponentialRampToValueAtTime(0.0001, t + a + hold + d)
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

// Where the next voices go. begin() points this at a fresh per-sound bus; the music,
// heartbeat and ambience schedulers point it at their own buses (uncounted).
const cur: { out: AudioNode | null; t0: number; count: boolean } = { out: null, t0: 0, count: false }
const ends: number[] = [] // stop times of counted voices still sounding
const lastPlayed = new Map<string, number>()

interface SoundOpts {
  prio?: 0 | 1 | 2 // 0 background (cap 32), 1 normal (cap 40), 2 important (cap 48)
  rev?: number // reverb send
  gap?: number // throttle window in ms
}

// Admits a sound (throttle + voice cap) and builds its bus. False means: stay silent.
function begin(key: string, pan?: number, vol?: number, o: SoundOpts = {}): boolean {
  cur.out = null
  const c = ctx
  if (!c || !sfxBus || !reverbIn || c.state === 'closed') return false
  // A context stuck suspended would queue sounds and blurt them out on resume.
  if (c.state !== 'running' && performance.now() - startedAt > 1500) return false
  const v = clamp(fin(vol, 1), 0, 1)
  if (v < 0.01) return false
  const now = performance.now()
  const last = lastPlayed.get(key)
  if (last !== undefined && now - last < (o.gap ?? THROTTLE_MS)) return false
  const t = c.currentTime
  let n = 0
  for (const e of ends) if (e > t) ends[n++] = e
  ends.length = n
  if (n >= MAX_VOICES + ((o.prio ?? 1) - 1) * 8) return false
  if (lastPlayed.size > 400) lastPlayed.clear()
  lastPlayed.set(key, now)

  const g = c.createGain()
  g.gain.value = v
  let node: AudioNode = g
  if (v < 0.95) {
    // Distance cue: far-away sounds lose their top end as well as level.
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1200 + 18000 * v * v
    lp.Q.value = 0.7
    node = node.connect(lp)
  }
  const p = clamp(fin(pan, 0), -1, 1)
  if (Math.abs(p) > 0.02) node = node.connect(pannerNode(c, p))
  node.connect(sfxBus)
  if (o.rev) node.connect(gainTo(c, o.rev, reverbIn))
  cur.out = g
  cur.t0 = t
  cur.count = true
  return true
}

interface ToneOpts {
  type?: OscillatorType
  f: number // start frequency
  f2?: number // end frequency (exponential glide)
  dur: number // decay time after attack and hold
  peak?: number
  when?: number // delay from the sound's start
  a?: number // attack
  hold?: number // time held at peak before the decay
  glide?: number // glide time, default the whole note
  pan?: number // extra per-voice pan
  detune?: number // cents
  vib?: number // vibrato rate (Hz)
  vibD?: number // vibrato depth (Hz)
  fm?: number // FM modulator ratio
  fmI?: number // FM depth (Hz), decays over the note for a bell-like fade
  lp?: number // low-pass cutoff ...
  lp2?: number // ... swept to this by the end of the note
  q?: number
  bp?: number // band-pass centre
  hp?: number // high-pass cutoff
  shape?: Shape
}

function tone(o: ToneOpts) {
  const c = ctx
  const out = cur.out
  if (!c || !out) return
  const t = cur.t0 + (o.when ?? 0)
  const a = Math.max(0.001, o.a ?? 0.005)
  const hold = o.hold ?? 0
  const dur = Math.max(0.005, o.dur)
  const end = t + a + hold + dur
  const stop = end + 0.03
  const f = hz(o.f)
  const f2 = o.f2 === undefined ? f : hz(o.f2)
  const gl = t + Math.max(0.005, o.glide ?? a + hold + dur)
  const osc = c.createOscillator()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(f, t)
  if (f2 !== f) osc.frequency.exponentialRampToValueAtTime(f2, gl)
  if (o.detune) osc.detune.value = o.detune
  if (o.vib) {
    const l = c.createOscillator()
    const lg = c.createGain()
    l.frequency.value = o.vib
    lg.gain.value = o.vibD ?? f * 0.03
    l.connect(lg).connect(osc.frequency)
    l.start(t)
    l.stop(stop)
  }
  if (o.fm) {
    const m = c.createOscillator()
    const mg = c.createGain()
    m.frequency.setValueAtTime(hz(f * o.fm), t)
    if (f2 !== f) m.frequency.exponentialRampToValueAtTime(hz(f2 * o.fm), gl)
    const idx = Math.max(1, o.fmI ?? f)
    mg.gain.setValueAtTime(idx, t)
    mg.gain.exponentialRampToValueAtTime(Math.max(0.5, idx * 0.08), end)
    m.connect(mg).connect(osc.frequency)
    m.start(t)
    m.stop(stop)
  }
  let node: AudioNode = osc
  if (o.shape) node = node.connect(shaperNode(c, o.shape))
  if (o.lp) node = node.connect(sweepFilter(c, 'lowpass', o.lp, o.q ?? 0.8, t, o.lp2, end))
  if (o.bp) node = node.connect(sweepFilter(c, 'bandpass', o.bp, o.q ?? 2, t))
  if (o.hp) node = node.connect(sweepFilter(c, 'highpass', o.hp, 0.7, t))
  const g = c.createGain()
  envelope(g.gain, t, a, hold, dur, o.peak ?? 0.2)
  node = node.connect(g)
  if (o.pan) node = node.connect(pannerNode(c, o.pan))
  node.connect(out)
  osc.start(t)
  osc.stop(stop)
  if (cur.count) ends.push(stop)
}

interface NoiseOpts {
  dur: number
  peak?: number
  f?: number // filter frequency ...
  f2?: number // ... swept to this by the end
  ft?: BiquadFilterType // default band-pass
  q?: number
  when?: number
  a?: number
  hold?: number
  color?: NoiseColor
  rate?: number // playback rate of the noise buffer
  pan?: number
  shape?: Shape
}

function noise(o: NoiseOpts) {
  const c = ctx
  const out = cur.out
  if (!c || !out) return
  const buf = noiseBufs.get(o.color ?? 'white')
  if (!buf) return
  const t = cur.t0 + (o.when ?? 0)
  const a = Math.max(0.001, o.a ?? 0.003)
  const hold = o.hold ?? 0
  const dur = Math.max(0.005, o.dur)
  const end = t + a + hold + dur
  const stop = end + 0.03
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  if (o.rate) src.playbackRate.value = o.rate
  let node: AudioNode = src
  if (o.shape) node = node.connect(shaperNode(c, o.shape))
  node = node.connect(sweepFilter(c, o.ft ?? 'bandpass', o.f ?? 1000, o.q ?? 1, t, o.f2, end))
  const g = c.createGain()
  envelope(g.gain, t, a, hold, dur, o.peak ?? 0.2)
  node = node.connect(g)
  if (o.pan) node = node.connect(pannerNode(c, o.pan))
  node.connect(out)
  src.start(t, Math.random() * buf.duration * 0.9)
  src.stop(stop)
  if (cur.count) ends.push(stop)
}

// Positional shorthands: T(type, from Hz, to Hz, decay, peak, delay, extras), N(decay, peak, filter Hz, delay, extras).
function T(type: OscillatorType, f: number, f2: number, dur: number, peak: number, when = 0, x?: Partial<ToneOpts>) {
  tone({ type, f, f2, dur, peak, when, ...x })
}

function N(dur: number, peak: number, f: number, when = 0, x?: Partial<NoiseOpts>) {
  noise({ dur, peak, f, when, ...x })
}

function arp(type: OscillatorType, freqs: readonly number[], step: number, dur: number, peak: number, when = 0, x?: Partial<ToneOpts>) {
  for (let i = 0; i < freqs.length; i++) tone({ type, f: freqs[i], dur, peak, when: when + i * step, ...x })
}

// ---------------------------------------------------------------------------
// Mix controls
// ---------------------------------------------------------------------------

function applyMix(immediate = false) {
  const c = ctx
  if (!c || !master || !musicBus || !ambBus || !sfxBus) return
  const t = c.currentTime
  const set = (p: AudioParam, v: number) => (immediate ? (p.value = v) : p.setTargetAtTime(v, t, 0.03))
  set(master.gain, MASTER_LEVEL * curve(want.master))
  set(musicBus.gain, MUSIC_LEVEL * curve(want.music))
  set(sfxBus.gain, SFX_LEVEL * curve(want.sfx))
  set(ambBus.gain, AMB_LEVEL * curve(want.sfx)) // ambience is environmental sound: it follows the sfx slider
}

export function setMasterVolume(v: number): void {
  want.master = clamp(fin(v, want.master), 0, 1)
  applyMix()
}

export function setMusicVolume(v: number): void {
  want.music = clamp(fin(v, want.music), 0, 1)
  applyMix()
}

export function setSfxVolume(v: number): void {
  want.sfx = clamp(fin(v, want.sfx), 0, 1)
  applyMix()
}

function applyMuffle() {
  const c = ctx
  if (!c || !muffle || !muffleGain) return
  const t = c.currentTime
  muffle.frequency.setTargetAtTime(want.muffled ? 520 : maxCutoff(c), t, want.muffled ? 0.12 : 0.25)
  muffleGain.gain.setTargetAtTime(want.muffled ? 0.7 : 1, t, 0.2)
}

export function setMuffled(on: boolean): void {
  want.muffled = !!on
  applyMuffle()
}

// ---------------------------------------------------------------------------
// Low-health heartbeat and background scheduling
// ---------------------------------------------------------------------------

const heart = { on: false, next: 0 }
const HEART_PERIOD = 0.82

function applyLowHealth() {
  const c = ctx
  if (!c || !heartGain) return
  const t = c.currentTime
  heartGain.gain.setTargetAtTime(want.lowHealth ? 1 : 0, t, want.lowHealth ? 0.05 : 0.4)
  if (want.lowHealth && !heart.on) heart.next = t + 0.05
  heart.on = want.lowHealth
}

export function setLowHealth(on: boolean): void {
  want.lowHealth = !!on
  applyLowHealth()
}

function heartbeat(t: number) {
  if (!heartGain) return
  cur.out = heartGain
  cur.t0 = t
  cur.count = false
  T('sine', 78, 42, 0.13, 0.26, 0, { a: 0.01 }) // lub
  N(0.07, 0.08, 110, 0, { color: 'brown', ft: 'lowpass', a: 0.006 })
  T('sine', 70, 40, 0.15, 0.19, 0.27, { a: 0.01 }) // dub
}

// Runs every 50 ms for the whole session: heartbeat beats and the ambience's
// sparse random events (drips, data chatter, glitches, chord changes).
function bgTick() {
  const c = ctx
  if (!c) return
  const now = c.currentTime
  if (heart.on) {
    if (heart.next < now) heart.next = now + 0.03 // timer was throttled: resync
    while (heart.next < now + 0.2) {
      heartbeat(heart.next)
      heart.next += HEART_PERIOD
    }
  }
  const L = amb
  if (L && L.ev) {
    if (L.next < now) L.next = now + 0.02
    while (L.next < now + 0.2) {
      cur.out = L.evt
      cur.t0 = L.next
      cur.count = false
      L.ev()
      L.next += rnd(L.every[0], L.every[1])
    }
  }
  cur.out = null
}

// ---------------------------------------------------------------------------
// Ambience: one long-running layer per sector, crossfaded over ~2 s
// ---------------------------------------------------------------------------

interface Layer {
  id: AmbienceId
  gain: GainNode // crossfade gain
  evt: GainNode // where the layer's random events play
  srcs: Srcs
  ev: (() => void) | null
  every: [number, number] // seconds between events
  next: number
  kill: ReturnType<typeof setTimeout> | undefined
}

let amb: Layer | null = null
const dying: Layer[] = []
const AMB_TRIM: Record<AmbienceId, number> = { cooling: 1, servers: 1, corrupted: 1.8, core: 1, hub: 1.6 }

// Core: i - VI - iv - V in D minor over a D pedal. Hub: Cmaj9 - Am9 - Fmaj9 - G6/9.
const CORE_CHORDS = [
  [50, 57, 62, 65, 69],
  [46, 58, 62, 65, 70],
  [43, 55, 62, 67, 70],
  [45, 57, 61, 64, 69],
]
const HUB_CHORDS = [
  [48, 55, 59, 62, 64],
  [45, 52, 55, 59, 60],
  [41, 48, 52, 55, 57],
  [43, 50, 52, 57, 59],
]

function buildLayer(c: AudioContext, bus: AudioNode, id: AmbienceId): Layer {
  const gain = gainTo(c, 0, bus)
  const evt = gainTo(c, 1, gain)
  if (reverbIn) evt.connect(gainTo(c, 0.35, reverbIn))
  const L: Layer = { id, gain, evt, srcs: [], ev: null, every: [3, 8], next: 0, kill: undefined }
  const S = L.srcs
  const side = () => rnd(-0.85, 0.85)
  switch (id) {
    case 'cooling': {
      // Cold airflow through the coolant ducts, a refrigeration hum and a faint icy whistle.
      const air = filterTo(c, 'bandpass', 650, 0.5, gain)
      bedTo(c, S, 'pink', air, 0.55)
      lfoTo(c, S, 0.05, 300, air.frequency)
      bedTo(c, S, 'white', filterTo(c, 'highpass', 7000, 0.7, gain), 0.012)
      const hum = filterTo(c, 'lowpass', 380, 0.7, gain)
      oscTo(c, S, 'sine', 55, hum, 0.16)
      oscTo(c, S, 'sine', 55.3, hum, 0.1)
      oscTo(c, S, 'triangle', 110.5, hum, 0.05)
      const whistle = gainTo(c, 0.004, gain)
      oscTo(c, S, 'sine', 1760, whistle)
      oscTo(c, S, 'sine', 1765, whistle)
      lfoTo(c, S, 0.08, 0.004, whistle.gain)
      L.every = [2.5, 7]
      L.ev = () => {
        const r = Math.random()
        if (r < 0.45) {
          const f = rnd(1400, 3000) // coolant drip
          T('sine', f, f * 0.98, 0.7, 0.03, 0, { fm: 2.1, fmI: f * 0.2, pan: side() })
        } else if (r < 0.75) N(1.2, 0.035, 5000, 0, { ft: 'highpass', a: 0.3, pan: side() }) // steam vent
        else T('sine', rnd(140, 200), 120, 0.6, 0.04, 0, { fm: 2.7, fmI: 200, pan: side() }) // pipe knock
      }
      break
    }
    case 'servers': {
      // Server fans (rumble, blade-rate flutter, whine), mains hum and chattering data.
      bedTo(c, S, 'brown', filterTo(c, 'lowpass', 320, 0.7, gain), 0.6)
      const blade = gainTo(c, 0.035, filterTo(c, 'lowpass', 700, 1, gain))
      oscTo(c, S, 'sawtooth', 118, blade)
      lfoTo(c, S, 23, 0.015, blade.gain)
      oscTo(c, S, 'sine', 236, gain, 0.015)
      oscTo(c, S, 'sine', 50, gain, 0.05)
      oscTo(c, S, 'sine', 100, gain, 0.025)
      oscTo(c, S, 'sine', 3150, gain, 0.0025)
      bedTo(c, S, 'white', filterTo(c, 'bandpass', 1400, 0.4, gain), 0.03)
      L.every = [0.12, 0.8]
      L.ev = () => {
        const r = Math.random()
        const p = side()
        if (r < 0.6) {
          const f = rnd(1200, 4000)
          T('square', f, f, rnd(0.02, 0.05), 0.012, 0, { pan: p, lp: 6000 })
        } else if (r < 0.85) {
          const n = 3 + Math.floor(Math.random() * 4) // modem-like burst
          for (let i = 0; i < n; i++) {
            const f = rnd(1500, 4000)
            T('square', f, f, 0.015, 0.01, i * 0.035, { pan: p, lp: 6000 })
          }
        } else N(0.05, 0.05, 3000, 0, { color: 'crackle', q: 1.5, pan: p }) // drive seek
      }
      break
    }
    case 'corrupted': {
      // Detuned, beating drones with digital crackle and random glitches.
      const low = filterTo(c, 'lowpass', 320, 2, gain)
      oscTo(c, S, 'sawtooth', 46.25, low, 0.09)
      oscTo(c, S, 'sawtooth', 49, low, 0.08)
      oscTo(c, S, 'sawtooth', 65.4, low, 0.06, 13)
      lfoTo(c, S, 0.09, 160, low.frequency)
      const high = filterTo(c, 'bandpass', 800, 1.5, gain)
      const o1 = oscTo(c, S, 'triangle', 370, high, 0.03)
      const o2 = oscTo(c, S, 'triangle', 377, high, 0.03)
      lfoTo(c, S, 0.3, 6, o1.frequency)
      lfoTo(c, S, 0.23, 8, o2.frequency)
      bedTo(c, S, 'crackle', filterTo(c, 'bandpass', 2200, 0.8, gain), 0.06)
      L.every = [0.5, 2.8]
      L.ev = () => {
        const r = Math.random()
        const p = side()
        if (r < 0.4) {
          const f = rnd(200, 1700) // stutter
          const n = 3 + Math.floor(Math.random() * 6)
          const gap = rnd(0.03, 0.07)
          for (let i = 0; i < n; i++) T('square', f, f, 0.02, 0.025, i * gap, { pan: p, shape: 'crush', lp: 4000 })
        } else if (r < 0.65) T('sawtooth', rnd(300, 600), 35, 0.6, 0.03, 0, { pan: p, lp: 1500 }) // tape stop
        else if (r < 0.85) N(rnd(0.12, 0.32), 0.04, rnd(1500, 4500), 0, { color: 'digital', pan: p })
        else {
          const f = rnd(60, 100) // corrupted groan
          T('sine', f, f * 0.5, 1.2, 0.06, 0, { fm: 3.3, fmI: 80, pan: p })
        }
      }
      break
    }
    case 'core': {
      // A deep choir: detuned saws through an "ah" formant bank over a D pedal.
      const out = filterTo(c, 'lowpass', 3200, 0.7, gain)
      const voice = c.createGain()
      const fa = filterTo(c, 'bandpass', 700, 4, out)
      const fb = filterTo(c, 'bandpass', 1150, 5, gainTo(c, 0.6, out))
      const fc = filterTo(c, 'bandpass', 2700, 7, gainTo(c, 0.3, out))
      voice.connect(fa)
      voice.connect(fb)
      voice.connect(fc)
      lfoTo(c, S, 0.031, 150, fa.frequency) // slow vowel drift
      lfoTo(c, S, 0.023, 250, fb.frequency)
      lfoTo(c, S, 0.045, 0.35, voice.gain) // breathing swell
      const choir: OscillatorNode[] = []
      for (const m of CORE_CHORDS[0]) for (const d of [-8, 8]) choir.push(oscTo(c, S, 'sawtooth', mtof(m), voice, 0.06, d))
      lfoTo(c, S, 5.1, 9, ...choir.filter((_, i) => i % 2 === 0).map((o) => o.detune))
      lfoTo(c, S, 5.7, 9, ...choir.filter((_, i) => i % 2 === 1).map((o) => o.detune))
      oscTo(c, S, 'sine', mtof(26), gain, 0.16)
      oscTo(c, S, 'sine', mtof(38), gain, 0.05)
      bedTo(c, S, 'pink', filterTo(c, 'bandpass', 400, 0.5, gain), 0.025)
      let ci = 0
      L.every = [9, 9]
      L.ev = () => {
        ci = (ci + 1) % CORE_CHORDS.length
        const ch = CORE_CHORDS[ci]
        choir.forEach((o, i) => o.frequency.setTargetAtTime(mtof(ch[i >> 1]), cur.t0, 0.9))
        const f = mtof(ch[0] + 12) // distant toll on each chord change
        T('sine', f, f, 4, 0.035, 0, { fm: 1.4, fmI: 90, pan: rnd(-0.4, 0.4) })
      }
      break
    }
    case 'hub': {
      // Calm, warm pad with slow chord changes and the odd soft chime.
      const lp = filterTo(c, 'lowpass', 900, 0.6, gain)
      lfoTo(c, S, 0.07, 300, lp.frequency)
      const pads: OscillatorNode[] = []
      for (const m of HUB_CHORDS[0]) {
        pads.push(oscTo(c, S, 'triangle', mtof(m), lp, 0.045))
        pads.push(oscTo(c, S, 'sawtooth', mtof(m), lp, 0.012, 6))
      }
      const sub = oscTo(c, S, 'sine', mtof(HUB_CHORDS[0][0] - 12), gain, 0.06)
      bedTo(c, S, 'pink', filterTo(c, 'lowpass', 500, 0.7, gain), 0.02)
      let ci = 0
      L.every = [8, 8]
      L.ev = () => {
        ci = (ci + 1) % HUB_CHORDS.length
        const ch = HUB_CHORDS[ci]
        pads.forEach((o, i) => o.frequency.setTargetAtTime(mtof(ch[i >> 1]), cur.t0, 1.2))
        sub.frequency.setTargetAtTime(mtof(ch[0] - 12), cur.t0, 1.2)
        if (Math.random() < 0.6) {
          const f = mtof(ch[1 + Math.floor(Math.random() * 4)] + 24)
          T('triangle', f, f, 1.6, 0.025, rnd(0.5, 3), { pan: rnd(-0.6, 0.6), vib: 4, vibD: 2 })
        }
      }
      break
    }
  }
  L.next = c.currentTime + rnd(L.every[0] * 0.5, L.every[1]) // the first chord or event isn't instant
  return L
}

function teardownLayer(L: Layer) {
  const i = dying.indexOf(L)
  if (i >= 0) dying.splice(i, 1)
  for (const s of L.srcs) {
    try {
      s.stop()
    } catch {
      /* already stopped */
    }
  }
  L.gain.disconnect()
}

function applyAmbience() {
  const c = ctx
  if (!c || !ambBus || amb?.id === want.amb) return
  const now = c.currentTime
  if (amb) {
    const old = amb
    old.gain.gain.setTargetAtTime(0, now, 0.5)
    old.kill = setTimeout(() => teardownLayer(old), 2600)
    dying.push(old)
  }
  // Switching back while the previous layer is still fading out revives it.
  const i = dying.findIndex((l) => l.id === want.amb)
  if (i >= 0) {
    amb = dying.splice(i, 1)[0]
    clearTimeout(amb.kill)
    amb.kill = undefined
  } else amb = buildLayer(c, ambBus, want.amb)
  amb.gain.gain.setTargetAtTime(AMB_TRIM[amb.id], now, 0.6)
}

export function setAmbience(sector: number, hub = false): void {
  const s = Math.floor(clamp(fin(sector, 0), 0, AMBIENCES.length - 1))
  want.amb = hub ? 'hub' : AMBIENCES[s]
  applyAmbience()
}

// ---------------------------------------------------------------------------
// Music: combat pulse/arp (110 bpm, A minor) and a heavier boss layer
// (140 bpm, E phrygian), driven by a lookahead scheduler.
// ---------------------------------------------------------------------------

interface Chord {
  bass: number
  arp: readonly number[]
  pad: readonly number[]
}

const PROG: readonly (readonly Chord[])[] = [
  [
    { bass: 45, arp: [69, 72, 76, 81], pad: [57, 60, 64] }, // Am
    { bass: 41, arp: [65, 69, 72, 77], pad: [57, 60, 65] }, // F
    { bass: 48, arp: [67, 72, 76, 79], pad: [55, 60, 64] }, // C
    { bass: 43, arp: [67, 71, 74, 79], pad: [55, 59, 62] }, // G
  ],
  [
    { bass: 40, arp: [64, 67, 71, 76], pad: [52, 55, 59] }, // Em
    { bass: 41, arp: [65, 69, 72, 77], pad: [53, 57, 60] }, // F
    { bass: 38, arp: [62, 66, 69, 74], pad: [50, 54, 57] }, // D
    { bass: 35, arp: [63, 66, 71, 75], pad: [51, 54, 59] }, // B
  ],
]
const ARP_STEPS = [0, 1, 2, 3, 2, 1, 0, 1, 0, 2, 3, 2, 1, 2, 3, 1]
const BOSS_LEAD = [
  [76, 77, 76, 74],
  [77, 0, 76, 0],
  [74, 76, 77, 74],
  [75, 0, 71, 0],
]
const TEMPO = [110, 140]

interface Music {
  timer: ReturnType<typeof setInterval>
  srcs: Srcs
  combat: GainNode
  boss: GainNode
  arpBus: GainNode
  delay: DelayNode
  feedback: GainNode
  padFilter: BiquadFilterNode
  pad: OscillatorNode[]
  drone: OscillatorNode[]
  next: number // audio time of the next 16th
  step: number // 16th within the 4-bar loop (0..63)
  mode: number // 0 combat, 1 boss; switches on bar lines
  level: number // smoothed combat intensity
  bossLevel: number
  lastReal: number
  idleSince: number
  setG: number
  setB: number
}

let mus: Music | null = null

export function setCombatIntensity(x: number): void {
  want.combat = clamp(fin(x, 0), 0, 1)
  if (want.combat > 0) startMusic()
}

export function setBossMusic(on: boolean): void {
  want.boss = !!on
  if (want.boss) startMusic()
}

function startMusic() {
  const c = ctx
  if (!c || !musicBus || mus) return
  const S: Srcs = []
  const mode = want.boss ? 1 : 0
  const first = PROG[mode][0]
  const combat = gainTo(c, 0, musicBus)
  const boss = gainTo(c, 0, musicBus)
  // Arp with a dotted-8th feedback echo.
  const arpBus = gainTo(c, 1, combat)
  const delay = c.createDelay(1)
  delay.delayTime.value = (60 / TEMPO[mode]) * 0.75
  const feedback = c.createGain()
  feedback.gain.value = 0.3
  const damp = filterTo(c, 'lowpass', 2400, 0.7, feedback)
  arpBus.connect(delay)
  delay.connect(damp)
  feedback.connect(delay)
  damp.connect(gainTo(c, 0.4, combat))
  // Sustained saw pad that follows the chords and brightens with intensity.
  const padFilter = filterTo(c, 'lowpass', 600, 1, gainTo(c, 0.05, combat))
  const pad: OscillatorNode[] = []
  for (let i = 0; i < 6; i++) pad.push(oscTo(c, S, 'sawtooth', mtof(first.pad[i >> 1]), padFilter, 1, i % 2 ? 9 : -9))
  // Boss: distorted, growling low drone.
  const droneOut = filterTo(c, 'lowpass', 380, 2, gainTo(c, 0.05, boss))
  lfoTo(c, S, 0.25, 140, droneOut.frequency)
  const crunch = shaperNode(c, 'drive')
  crunch.connect(droneOut)
  const drone = [oscTo(c, S, 'sawtooth', mtof(first.bass - 12), crunch, 0.6), oscTo(c, S, 'sawtooth', mtof(first.bass), crunch, 0.5, 7)]
  mus = {
    timer: setInterval(musicTick, 25),
    srcs: S,
    combat,
    boss,
    arpBus,
    delay,
    feedback,
    padFilter,
    pad,
    drone,
    next: c.currentTime + 0.05,
    step: 0,
    mode,
    level: 0,
    bossLevel: 0,
    lastReal: performance.now(),
    idleSince: 0,
    setG: -1,
    setB: -1,
  }
  musicTick()
}

function stopMusic() {
  const m = mus
  if (!m) return
  mus = null
  clearInterval(m.timer)
  const now = ctx ? ctx.currentTime : 0
  m.combat.gain.setTargetAtTime(0, now, 0.03) // fade the last trace out rather than cut it
  m.boss.gain.setTargetAtTime(0, now, 0.03)
  for (const s of m.srcs) {
    try {
      s.stop(now + 0.25)
    } catch {
      /* already stopped */
    }
  }
  setTimeout(() => {
    m.delay.disconnect()
    m.feedback.disconnect()
    m.combat.disconnect()
    m.boss.disconnect()
  }, 400)
}

function musicTick() {
  const c = ctx
  const m = mus
  if (!c || !m) return
  const now = c.currentTime
  const real = performance.now()
  const dt = clamp((real - m.lastReal) / 1000, 0, 0.5)
  m.lastReal = real
  const tc = want.combat
  m.level += (tc - m.level) * (1 - Math.exp(-dt / (tc > m.level ? 1.2 : 2.5)))
  const tb = want.boss ? 1 : 0
  m.bossLevel += (tb - m.bossLevel) * (1 - Math.exp(-dt / (tb > m.bossLevel ? 0.7 : 2)))
  const L = Math.max(m.level, m.bossLevel * 0.55) // a boss fight is always a fight
  if (Math.abs(L - m.setG) > 0.004) {
    m.combat.gain.setTargetAtTime(Math.pow(L, 0.6), now, 0.06) // low intensities stay audible
    m.padFilter.frequency.setTargetAtTime(500 + 2500 * L, now, 0.2)
    m.setG = L
  }
  if (Math.abs(m.bossLevel - m.setB) > 0.004) {
    m.boss.gain.setTargetAtTime(m.bossLevel, now, 0.06)
    m.setB = m.bossLevel
  }
  // Wind down once both inputs have been zero and the layers have faded out.
  if (tc <= 0 && !want.boss && L < 0.01 && m.bossLevel < 0.01) {
    if (!m.idleSince) m.idleSince = real
    else if (real - m.idleSince > 4000) {
      stopMusic()
      return
    }
  } else m.idleSince = 0

  if (m.next < now - 0.02) m.next = now + 0.02 // the timer was throttled: skip ahead rather than burst
  while (m.next < now + LOOKAHEAD) {
    if ((m.step & 15) === 0) {
      const mode = want.boss ? 1 : 0
      if (mode !== m.mode) {
        m.mode = mode
        m.delay.delayTime.setValueAtTime((60 / TEMPO[mode]) * 0.75, m.next)
      }
      const ch = PROG[m.mode][m.step >> 4]
      m.pad.forEach((o, i) => o.frequency.setTargetAtTime(mtof(ch.pad[i >> 1]), m.next, 0.05))
      m.drone[0].frequency.setTargetAtTime(mtof(ch.bass - 12), m.next, 0.03)
      m.drone[1].frequency.setTargetAtTime(mtof(ch.bass), m.next, 0.03)
    }
    playStep(m, m.next, L)
    m.next += 60 / TEMPO[m.mode] / 4
    m.step = (m.step + 1) & 63
  }
  cur.out = null
}

function kick(peak: number) {
  T('sine', 150, 45, 0.16, peak, 0, { glide: 0.07 })
  N(0.01, peak * 0.3, 3000)
}

function snare(peak: number) {
  N(0.13, peak, 1800, 0, { q: 0.7 })
  T('triangle', 210, 150, 0.06, peak * 0.5)
}

function playStep(m: Music, t: number, L: number) {
  const s = m.step & 15
  const bar = m.step >> 4
  const ch = PROG[m.mode][bar]
  const B = m.mode ? m.bossLevel : 0
  cur.t0 = t
  cur.count = false
  if (L > 0.01) {
    cur.out = m.combat
    // Pulse bass: 8ths, 16ths once things heat up.
    if (s % 2 === 0 || L > 0.55) {
      const f = mtof(ch.bass)
      T('sawtooth', f, f, 0.11, s % 4 === 0 ? 0.1 : 0.07, 0, { lp: 1600 + 1400 * L, lp2: 220, q: 4 })
    }
    const drums = B < 0.3
    const hat = ramp01(L, 0.3, 0.6)
    if (hat > 0 && s % 4 === 2) N(0.035, 0.05 * hat, 8000, 0, { ft: 'highpass' })
    else if (L > 0.75 && s % 2 === 1) N(0.02, 0.025 * ramp01(L, 0.75, 1), 9000, 0, { ft: 'highpass' })
    const k = ramp01(L, 0.45, 0.75)
    if (drums && k > 0 && s % 4 === 0) kick(0.3 * k)
    const sn = ramp01(L, 0.65, 0.95)
    if (drums && sn > 0 && (s === 4 || s === 12)) snare(0.16 * sn)
    // Arp fades in above a third of the intensity range.
    const av = ramp01(L, 0.2, 0.55)
    if (av > 0) {
      cur.out = m.arpBus
      const f = mtof(ch.arp[ARP_STEPS[s]])
      T('square', f, f, 0.09, 0.03 * av, 0, { lp: 3200 })
    }
  }
  if (B > 0.01) {
    cur.out = m.boss
    if (s % 4 !== 1) {
      // Galloping distorted bass: da, da-da.
      const f = mtof(ch.bass)
      T('sawtooth', f, f, 0.085, 0.09, 0, { shape: 'drive', lp: 1200, lp2: 260, q: 3 })
    }
    if (s % 4 === 0 || s === 7 || s === 15) kick(0.32)
    if (s === 4 || s === 12) snare(0.2)
    if (bar === 3 && s >= 12) {
      const f = [160, 130, 105, 85][s - 12] // tom fill into the next phrase
      T('sine', f, f * 0.6, 0.22, 0.28)
      N(0.06, 0.1, 400)
    }
    if ((bar % 2 === 0 && s === 0) || s === 10) {
      ch.pad.forEach((n, i) => {
        const f = mtof(n + 12) // brass stab
        T('sawtooth', f, f, 0.16, 0.03, 0, { lp: 3000, lp2: 700, detune: i % 2 ? 7 : -7 })
      })
    }
    const lead = s % 4 === 0 ? BOSS_LEAD[bar][s >> 2] : 0
    if (lead) {
      const f = mtof(lead)
      T('square', f, f, 0.22, 0.04, 0, { a: 0.01, vib: 6, vibD: f * 0.01, lp: 2600 })
    }
  }
}

// ---------------------------------------------------------------------------
// Plasma beam loop
// ---------------------------------------------------------------------------

let plasma: { gain: GainNode; srcs: Srcs } | null = null

function setPlasma(on: boolean) {
  const c = ctx
  if (!c || !sfxBus) return
  const now = c.currentTime
  if (on) {
    if (plasma) return
    const S: Srcs = []
    const gain = gainTo(c, 0, sfxBus)
    gain.gain.setTargetAtTime(1, now, 0.03)
    const lp = filterTo(c, 'lowpass', 1000, 5, gainTo(c, 0.06, gain))
    oscTo(c, S, 'sawtooth', 82, lp, 1, -9)
    oscTo(c, S, 'sawtooth', 82, lp, 1, 9)
    oscTo(c, S, 'square', 164.8, lp, 0.4)
    lfoTo(c, S, 7, 450, lp.frequency) // wobble
    const hiss = filterTo(c, 'bandpass', 1800, 1.5, gain)
    bedTo(c, S, 'white', hiss, 0.05)
    lfoTo(c, S, 11, 600, hiss.frequency)
    plasma = { gain, srcs: S }
  } else if (plasma) {
    const p = plasma
    plasma = null
    p.gain.gain.setTargetAtTime(0, now, 0.04)
    for (const s of p.srcs) s.stop(now + 0.3)
  }
}

// ---------------------------------------------------------------------------
// Monster voices
// ---------------------------------------------------------------------------

interface MonsterVoice {
  f: number // base pitch (Hz): small and fast monsters are high, big ones low
  type: OscillatorType
  s: number // size: stretches every call and adds weight above ~1.4
  noise: number // centre of the breath / clatter noise layer (Hz)
  color?: NoiseColor
  vib?: number // tremble rate (Hz)
  fm?: number // FM ratio for metallic or digital timbres
  crush?: boolean // bit-crushed voice
  chirps?: number // the call stutters this many times (insects, beeps)
  chorus?: number // extra detuned copies (swarms)
  echo?: number // recursive repeats on death
  rev?: number // reverb send
}

const VOICES = new Map<string, MonsterVoice>([
  ['byte_mite', { f: 2400, type: 'square', s: 0.5, noise: 6500, vib: 45, chirps: 3 }],
  ['junk_scuttler', { f: 850, type: 'square', s: 0.65, noise: 2600, color: 'crackle', chirps: 4 }],
  ['packet_swarm', { f: 230, type: 'sawtooth', s: 0.8, noise: 3200, vib: 24, chorus: 3 }],
  ['firewall_imp', { f: 720, type: 'sawtooth', s: 0.7, noise: 1800, color: 'crackle', vib: 9 }],
  ['null_phantom', { f: 520, type: 'triangle', s: 1.2, noise: 1100, color: 'pink', vib: 4, rev: 0.45 }],
  ['phase_spider', { f: 1100, type: 'sine', s: 0.8, noise: 4200, color: 'crackle', fm: 1.5, chirps: 2 }],
  ['trojan_goliath', { f: 70, type: 'sawtooth', s: 1.7, noise: 500, color: 'brown', fm: 0.5 }],
  ['logic_bomb', { f: 1500, type: 'square', s: 0.6, noise: 5000, chirps: 3 }],
  ['recursive_worm', { f: 180, type: 'sine', s: 1.2, noise: 700, color: 'pink', vib: 18, echo: 3 }],
  ['kernel_guardian', { f: 110, type: 'square', s: 1.6, noise: 900, fm: 2, rev: 0.3 }],
  ['data_leviathan', { f: 90, type: 'sawtooth', s: 2.2, noise: 420, color: 'brown', vib: 3, rev: 0.5 }],
  ['singularity', { f: 300, type: 'sine', s: 1.8, noise: 2000, color: 'pink', fm: 1.414, vib: 0.7, rev: 0.6 }],
  ['mainframe', { f: 55, type: 'sawtooth', s: 2, noise: 600, color: 'brown', fm: 3, crush: true, rev: 0.4 }],
  ['zero_day', { f: 1800, type: 'square', s: 0.9, noise: 6000, color: 'digital', crush: true, chirps: 3 }],
  ['rootkit_dragon', { f: 60, type: 'sawtooth', s: 2.5, noise: 650, color: 'brown', vib: 6, rev: 0.5 }],
  ['turret', { f: 600, type: 'square', s: 0.7, noise: 3000, fm: 2.5, chirps: 2 }],
  ['mainframe_node', { f: 160, type: 'square', s: 1.4, noise: 1500, color: 'digital', fm: 1.5, rev: 0.3 }],
])

const OSC_TYPES: OscillatorType[] = ['sawtooth', 'square', 'triangle']

// Unknown monsters still get a stable voice of their own, derived from the key.
function voiceFor(key: string): MonsterVoice {
  const v = VOICES.get(key)
  if (v) return v
  const h = hash(key)
  return { f: 160 + (h % 500), type: OSC_TYPES[h % 3], s: 0.8 + ((h >>> 4) % 8) / 10, noise: 800 + ((h >>> 8) % 2000) }
}

function monsterSound(key: string, kind: MonsterSoundKind, v: MonsterVoice) {
  const { f, s } = v
  const x: Partial<ToneOpts> = {
    vib: v.vib,
    vibD: v.vib ? f * 0.05 : undefined,
    fm: v.fm,
    fmI: v.fm ? f * 1.2 : undefined,
    shape: v.crush ? 'crush' : s > 1.9 ? 'drive' : undefined,
    lp: Math.min(12000, f * 8),
  }
  switch (kind) {
    case 'windup': // rising charge
      T(v.type, f * 0.5, f * 1.6, 0.06, 0.12, 0, { ...x, a: 0.4 * s, glide: 0.45 * s })
      N(0.06, 0.14, v.noise * 0.4, 0, { color: v.color, a: 0.4 * s, f2: v.noise * 1.5, q: 2 })
      if (s > 1.4) T('sine', f * 0.5, f, 0.1, 0.15, 0, { a: 0.4 * s, glide: 0.45 * s })
      break
    case 'attack': // strike
      N(0.12 * s, 0.3, v.noise, 0, { color: v.color, q: 0.9 })
      T(v.type, f * 1.25, f * 0.45, 0.16 * s, 0.16, 0, x)
      if (s > 1.4) T('sine', 140, 40, 0.25 * s, 0.28)
      break
    case 'die': {
      T(v.type, f, f * 0.18, 0.6 * s, 0.16, 0, x)
      N(0.5 * s, 0.22, v.noise, 0, { color: v.color, f2: v.noise * 0.25, q: 0.8 })
      for (let i = 0; i < 3; i++) {
        const g = rnd(1200, 3600) // the program breaking apart
        T('square', g, g, 0.03, 0.05, 0.08 + i * 0.07, { shape: 'crush' })
      }
      if (s > 1.6) {
        T('sine', 100, 28, 0.9 * s, 0.32)
        N(0.9 * s, 0.25, 900, 0, { color: 'brown', ft: 'lowpass', f2: 60 })
      }
      for (let i = 1; i <= (v.echo ?? 0); i++) T(v.type, f * (1 + i * 0.2), f * 0.3, 0.2, 0.12 / (i + 1), i * 0.12, x)
      break
    }
    case 'special':
      monsterSpecial(key, v)
      break
    default: {
      // aggro: a call that rises then falls; chirpy monsters stutter it
      const n = v.chirps ?? 1
      for (let i = 0; i < n; i++) T(v.type, f * 0.85, f * 1.35, 0.1 * s, 0.13, i * 0.07 * s, { ...x, glide: 0.06 * s })
      T(v.type, f * 1.3, f * 0.7, 0.25 * s, 0.12, n * 0.07 * s, x)
      for (let i = 1; i <= (v.chorus ?? 0); i++) {
        T(v.type, f * (1 + i * 0.03), f * 0.75, 0.35 * s, 0.06, rnd(0, 0.05), { vib: (v.vib ?? 10) + i * 3, vibD: f * 0.05, lp: x.lp })
      }
      N(0.18 * s, 0.12, v.noise, 0, { color: v.color, q: 1.2 })
    }
  }
}

function monsterSpecial(key: string, v: MonsterVoice) {
  const { f, s } = v
  switch (key) {
    case 'firewall_imp': // Burst Fire
      for (let i = 0; i < 3; i++) {
        N(0.12, 0.25, 1600, i * 0.11, { color: 'crackle', q: 0.7 })
        T('sawtooth', 900, 250, 0.1, 0.1, i * 0.11, { lp: 3000 })
      }
      break
    case 'null_phantom': // Memory Leak: dripping, detuned, sinking tones
      for (let i = 0; i < 4; i++) T('triangle', f * (1.6 - i * 0.2), f * (1.2 - i * 0.2), 0.5, 0.08, i * 0.16, { vib: 5, vibD: 12 })
      N(0.8, 0.08, 900, 0, { color: 'pink', f2: 300, a: 0.2 })
      break
    case 'phase_spider': // Phase Strike
      T('sine', 300, 2400, 0.1, 0.1, 0, { a: 0.25, glide: 0.3, fm: 1.5, fmI: 800 })
      N(0.06, 0.15, 800, 0, { a: 0.25, f2: 6000, q: 6 })
      T('square', 2400, 200, 0.15, 0.12, 0.3)
      N(0.12, 0.25, 3500, 0.3, { color: 'crackle' })
      break
    case 'trojan_goliath': // Payload Delivery: hatch clank, hiss, heavy drop
      T('sine', 180, 175, 0.4, 0.12, 0, { fm: 2.4, fmI: 400 })
      N(0.5, 0.15, 4000, 0.1, { ft: 'highpass' })
      T('sine', 110, 30, 0.7, 0.5, 0.45)
      N(0.6, 0.35, 700, 0.45, { color: 'brown', ft: 'lowpass', f2: 80 })
      break
    case 'logic_bomb': // DETONATE: accelerating beeps over a rising tone
      ;[0, 0.16, 0.29, 0.39, 0.47, 0.53, 0.58, 0.62].forEach((w, i) => T('square', 1500 + i * 90, 1500 + i * 90, 0.035, 0.08, w))
      T('sine', 300, 1800, 0.05, 0.08, 0, { a: 0.6, glide: 0.65 })
      break
    case 'recursive_worm': // Fork Bomb: a blip that doubles every generation
      for (let g = 0, w = 0; g < 3; g++) {
        for (let i = 0; i < 1 << g; i++, w += 0.05) T('sine', f * (2 + g), f * (2.6 + g), 0.05, 0.09, w, { vib: 25, vibD: 15 })
      }
      break
    case 'kernel_guardian': // System Purge: rising scan, then a wash
      T('square', 110, 1760, 0.1, 0.1, 0, { a: 0.4, glide: 0.45, lp: 3000 })
      T('sine', 220, 3520, 0.1, 0.08, 0, { a: 0.4, glide: 0.45 })
      N(0.9, 0.3, 6000, 0.45, { ft: 'lowpass', f2: 300 })
      T('sine', 80, 40, 0.6, 0.35, 0.45)
      break
    case 'data_leviathan': // Corrupting Torrent: a rushing flood of data
      N(1.4, 0.3, 500, 0, { color: 'pink', f2: 1800, q: 0.8, a: 0.3 })
      N(1.2, 0.15, 2500, 0.1, { color: 'digital', q: 1.2, a: 0.2 })
      T('sawtooth', 90, 60, 1.3, 0.12, 0, { lp: 500, vib: 3, vibD: 4, a: 0.2 })
      N(1, 0.12, 3000, 0.2, { color: 'crackle', a: 0.2 })
      break
    case 'singularity': // Event Horizon: inward rush and collapse
      N(0.05, 0.25, 200, 0, { ft: 'lowpass', f2: 3000, a: 0.5 })
      T('sine', 120, 900, 0.05, 0.1, 0, { a: 0.5, glide: 0.55, fm: 1.414, fmI: 300 })
      T('sine', 40, 22, 1.2, 0.5, 0.55)
      T('sawtooth', 200, 30, 0.8, 0.12, 0.55, { lp: 900, lp2: 60 })
      break
    case 'mainframe': // Administrative Override: distorted klaxon and relays
      for (let i = 0; i < 4; i++) T('square', i % 2 ? 660 : 880, i % 2 ? 660 : 880, 0.05, 0.08, i * 0.22, { hold: 0.15, shape: 'drive', lp: 2500 })
      T('sawtooth', 55, 55, 0.9, 0.12, 0, { lp: 300, hold: 0.2 })
      for (let i = 0; i < 3; i++) N(0.02, 0.2, 2500, 0.1 + i * 0.25, { q: 3 })
      break
    case 'zero_day': // Perfect Execution: a clean digital shriek and a drop
      for (let i = 0; i < 5; i++) T('square', 2400 + i * 600, 2400 + i * 600, 0.02, 0.06, i * 0.03, { shape: 'crush' })
      T('sawtooth', 5000, 600, 0.3, 0.1, 0.15, { shape: 'crush', lp: 8000 })
      N(0.08, 0.3, 5000, 0.15, { color: 'digital', ft: 'highpass' })
      T('sine', 120, 30, 0.6, 0.45, 0.15)
      break
    case 'rootkit_dragon': // Privilege Escalation: rising growl and fire breath
      T('sawtooth', 55, 220, 0.3, 0.16, 0, { a: 0.6, glide: 0.9, vib: 7, vibD: 5, lp: 600, lp2: 2500, shape: 'drive' })
      N(1.2, 0.35, 600, 0.3, { color: 'pink', f2: 2200, q: 0.7, a: 0.15 })
      N(1, 0.25, 1800, 0.4, { color: 'crackle', q: 0.6, a: 0.1 })
      T('sine', 45, 35, 1.4, 0.35, 0.2)
      break
    default: // the voice's own call, FM-heavy and stuttered
      for (let i = 0; i < 3; i++) T(v.type, f * 2, f * 1.2, 0.08 * s, 0.1, i * 0.08 * s, { fm: v.fm ?? 1.5, fmI: f * 2, lp: Math.min(12000, f * 10) })
      N(0.4 * s, 0.15, v.noise, 0, { color: v.color, a: 0.15 * s, f2: v.noise * 2, q: 1.5 })
  }
}

// ---------------------------------------------------------------------------
// Larger sound recipes (called after begin() has admitted the sound)
// ---------------------------------------------------------------------------

function weaponSound(kind: WeaponKind) {
  switch (kind) {
    case 'blade':
      N(0.16, 0.25, 900, 0, { f2: 3200, q: 1.4, a: 0.03 }) // swish
      T('sawtooth', 95, 150, 0.18, 0.12, 0, { lp: 1400, lp2: 500 }) // energy hum
      T('sine', 2350, 2300, 0.28, 0.06, 0.02, { fm: 1.41, fmI: 900 }) // metallic ring
      break
    case 'plasma':
      T('square', 420, 110, 0.2, 0.14, 0, { vib: 28, vibD: 40, lp: 1800, lp2: 400 })
      T('sine', 220, 70, 0.22, 0.25)
      N(0.18, 0.18, 700, 0, { ft: 'lowpass', f2: 200 })
      break
    case 'railgun':
      N(0.05, 0.45, 3000, 0, { ft: 'highpass' }) // crack
      T('sine', 3200, 90, 0.5, 0.18) // zing
      T('sawtooth', 140, 38, 0.6, 0.22, 0, { lp: 900, lp2: 120 })
      N(0.6, 0.2, 1200, 0.02, { f2: 150, q: 0.8 }) // air tail
      break
    case 'cannon':
      T('sine', 130, 34, 0.55, 0.55)
      T('square', 90, 40, 0.18, 0.12, 0, { lp: 600 })
      N(0.7, 0.45, 900, 0, { color: 'brown', ft: 'lowpass', f2: 90 })
      N(0.04, 0.2, 2500)
      break
    case 'horizon':
      T('sine', 50, 900, 0.05, 0.12, 0, { a: 0.28, glide: 0.3 }) // inhale ...
      N(0.05, 0.12, 300, 0, { a: 0.28, ft: 'lowpass', f2: 3000 })
      T('sawtooth', 260, 28, 0.9, 0.25, 0.3, { lp: 1600, lp2: 80 }) // ... collapse
      T('sine', 80, 24, 1.1, 0.4, 0.3)
      T('sine', 600, 150, 0.8, 0.06, 0.3, { fm: 0.5, fmI: 300 })
      break
    default: // laser
      T('sawtooth', 1600, 220, 0.12, 0.16)
      T('square', 820, 130, 0.08, 0.07)
      T('sine', 3200, 1200, 0.05, 0.05)
  }
}

function castSound(spell: string) {
  switch (spell) {
    case 'overload': // power surge, then a crackling discharge
      T('sawtooth', 110, 880, 0.12, 0.16, 0, { a: 0.22, glide: 0.25, lp: 600, lp2: 5000 })
      T('square', 220, 1760, 0.1, 0.06, 0, { a: 0.22, glide: 0.25 })
      N(0.1, 0.12, 400, 0, { a: 0.22, f2: 5000, q: 2 })
      N(0.25, 0.3, 1500, 0.25, { color: 'crackle', q: 0.6 })
      T('sawtooth', 900, 70, 0.3, 0.2, 0.25)
      break
    case 'repair': // rising sweep and a sparkling chime
      T('sine', 400, 1200, 0.25, 0.1, 0, { a: 0.1 })
      arp('sine', [1047, 1319, 1568, 2093], 0.06, 0.35, 0.07, 0.1, { fm: 2, fmI: 300 })
      N(0.5, 0.04, 8000, 0.1, { ft: 'highpass', a: 0.1 })
      break
    case 'glitch_step': // stuttered blink
      for (let i = 0; i < 4; i++) {
        const f = rnd(300, 2100)
        T('square', f, f, 0.025, 0.08, i * 0.035, { shape: 'crush' })
      }
      N(0.12, 0.2, 2500, 0, { color: 'digital', q: 0.7 })
      T('sawtooth', 1800, 120, 0.15, 0.1, 0.12)
      break
    case 'system_shock': // electric burst
      N(0.45, 0.35, 3200, 0, { color: 'crackle', q: 0.8 })
      T('sawtooth', 60, 55, 0.4, 0.15, 0, { lp: 1500, vib: 50, vibD: 20 })
      T('square', 2200, 90, 0.2, 0.1)
      T('square', 1800, 70, 0.25, 0.08, 0.1)
      N(0.3, 0.2, 800, 0, { ft: 'lowpass', f2: 120 })
      break
    case 'lullaby': // music-box falling motif
      arp('triangle', [1319, 1047, 880, 988, 784], 0.16, 0.45, 0.08, 0, { vib: 5, vibD: 6 })
      T('sine', 330, 330, 1, 0.05, 0, { a: 0.3 })
      break
    case 'system_snooze': // power-down yawn
      T('sine', 600, 80, 1, 0.18, 0, { a: 0.05 })
      arp('triangle', [784, 659, 523, 392], 0.14, 0.4, 0.07, 0.05, { lp: 2000 })
      N(0.9, 0.06, 900, 0, { color: 'pink', ft: 'lowpass', f2: 200, a: 0.2 })
      break
    case 'stasis_field': // crystalline freeze
      ;[2093, 2489, 3136, 3951].forEach((f, i) => T('sine', f, f, 0.9, 0.05, i * 0.03, { fm: 2.76, fmI: f * 0.3 }))
      N(0.9, 0.06, 9000, 0, { ft: 'highpass', a: 0.15 })
      T('sine', 110, 104, 0.9, 0.18, 0, { a: 0.1 })
      break
    case 'firewall': // roaring wall of fire
      N(0.9, 0.32, 700, 0, { color: 'pink', ft: 'lowpass', f2: 300, a: 0.12 })
      N(0.8, 0.3, 1800, 0, { color: 'crackle', q: 0.6, a: 0.05 })
      N(0.6, 0.18, 300, 0, { f2: 1600, q: 1.2, a: 0.25 })
      T('sawtooth', 70, 95, 0.8, 0.12, 0, { lp: 400, a: 0.15 })
      break
    case 'data_leech': // gurgling drain, then an absorbed chime
      T('sine', 1300, 220, 0.5, 0.14, 0, { vib: 13, vibD: 60 })
      N(0.4, 0.12, 2200, 0, { f2: 400, q: 3, a: 0.2 })
      arp('triangle', [523, 784], 0.08, 0.2, 0.08, 0.5)
      break
    case 'ping': // sonar ping with an echo
      T('sine', 1420, 1420, 1.1, 0.16, 0, { fm: 1.5, fmI: 60 })
      T('sine', 1420, 1420, 0.8, 0.05, 0.35)
      break
    case 'honeypot': // sweet bubbly lure
      ;[523, 659, 784, 1047].forEach((f, i) => T('sine', f * 0.6, f, 0.1, 0.12, i * 0.06, { glide: 0.04 }))
      T('triangle', 2093, 2093, 0.5, 0.04, 0.25, { vib: 7, vibD: 15 })
      break
    case 'hijack': // modem handshake, then a woozy takeover
      for (let i = 0; i < 6; i++) {
        const f = i % 2 ? 2200 : 1200
        T('square', f, f, 0.035, 0.05, i * 0.045, { lp: 3500 })
      }
      T('sine', 900, 200, 0.6, 0.12, 0.27, { vib: 9, vibD: 50 })
      T('sawtooth', 110, 55, 0.6, 0.08, 0.27, { lp: 600 })
      break
    case 'daemon': // dark summoning: tritone swell and a growl
      T('sawtooth', 65.4, 65.4, 1, 0.12, 0, { a: 0.4, lp: 200, lp2: 1800 })
      T('sawtooth', 92.5, 92.5, 1, 0.1, 0, { a: 0.4, lp: 200, lp2: 1800 })
      N(0.4, 0.15, 3000, 0, { a: 0.5, f2: 300 })
      T('sine', 55, 40, 0.8, 0.2, 0.45, { fm: 0.5, fmI: 40 })
      break
    default: {
      const f = 300 + (hash(String(spell)) % 200) // generic cast, pitched per id
      T('sine', f, f * 3, 0.25, 0.12, 0, { a: 0.05 })
      N(0.3, 0.1, 800, 0, { f2: 4000, q: 2 })
      T('triangle', f * 3, f * 3, 0.3, 0.06, 0.2)
    }
  }
}

function explosionSound(kind: ExplosionKind) {
  switch (kind) {
    case 'emp':
      T('sine', 3000, 40, 0.6, 0.2)
      N(0.5, 0.3, 2200, 0, { color: 'crackle', q: 0.7 })
      N(0.4, 0.25, 1500, 0, { f2: 200, q: 1.5 })
      T('sine', 90, 30, 0.5, 0.45)
      T('square', 1200, 100, 0.7, 0.05, 0.05, { lp: 2500 })
      break
    case 'glitch':
      N(0.35, 0.35, 2000, 0, { color: 'digital', q: 0.5 })
      for (let i = 0; i < 5; i++) {
        const f = rnd(200, 2200)
        T('square', f, f, 0.03, 0.09, i * 0.05, { shape: 'crush' })
      }
      T('sawtooth', 600, 40, 0.5, 0.18, 0.05, { shape: 'crush', lp: 3000 })
      T('sine', 80, 35, 0.4, 0.35)
      break
    case 'noise':
      N(0.7, 0.4, 8000, 0, { ft: 'lowpass', f2: 200, q: 0.7 })
      T('sine', 110, 32, 0.5, 0.4)
      N(0.3, 0.2, 3000, 0, { ft: 'highpass' })
      break
    case 'acid':
      N(1, 0.22, 4500, 0, { ft: 'highpass', a: 0.02 }) // sizzle
      N(0.9, 0.2, 2500, 0, { color: 'crackle', q: 0.7 })
      for (let i = 0; i < 4; i++) {
        const f = rnd(300, 800)
        T('sine', f, f * 1.8, 0.06, 0.1, 0.05 + i * 0.12 + rnd(0, 0.05), { glide: 0.05 })
      }
      N(0.3, 0.25, 900, 0, { color: 'pink', q: 0.8 })
      break
    case 'toxic':
      N(1.3, 0.35, 700, 0, { color: 'pink', ft: 'lowpass', f2: 250, a: 0.12 }) // gas cloud
      T('sawtooth', 60, 52, 1.1, 0.12, 0, { lp: 300, a: 0.1 })
      T('sawtooth', 63, 55, 1.1, 0.1, 0, { lp: 300, a: 0.1 })
      for (let i = 0; i < 3; i++) {
        const f = rnd(180, 380)
        T('sine', f, f * 2, 0.08, 0.08, 0.2 + i * 0.25, { glide: 0.06 })
      }
      break
    case 'neutron':
      T('sine', 60, 24, 1.5, 0.55)
      N(1.4, 0.45, 1200, 0, { color: 'brown', ft: 'lowpass', f2: 70 })
      T('sine', 1180, 1100, 1.2, 0.06, 0, { fm: 1.414, fmI: 900 })
      N(0.06, 0.3, 4000, 0, { ft: 'highpass' })
      T('sawtooth', 220, 40, 0.8, 0.12, 0, { lp: 1200, lp2: 100 })
      break
    case 'horizon': // implosion: everything rushes in, then collapses
      N(0.05, 0.3, 200, 0, { ft: 'lowpass', f2: 4000, a: 0.55 })
      T('sine', 100, 1000, 0.05, 0.12, 0, { a: 0.55, glide: 0.6, fm: 0.5, fmI: 200 })
      T('sine', 34, 20, 1.6, 0.6, 0.6)
      N(1.4, 0.35, 900, 0.6, { color: 'brown', ft: 'lowpass', f2: 50 })
      T('sawtooth', 300, 30, 1, 0.15, 0.6, { lp: 1500, lp2: 60 })
      break
    default: // bomb
      N(1, 0.5, 2200, 0, { color: 'brown', ft: 'lowpass', f2: 90 })
      T('sine', 150, 30, 0.6, 0.48)
      N(0.08, 0.35, 3000, 0, { ft: 'highpass' })
      N(0.8, 0.2, 1800, 0.08, { color: 'crackle', q: 0.6 }) // debris
      T('square', 90, 40, 0.25, 0.1, 0, { lp: 500 })
  }
}

function projectileSound(kind: string) {
  const k = String(kind).toLowerCase()
  if (/fire|flame|burn|burst|heat|lava/.test(k)) {
    N(0.3, 0.45, 900, 0, { color: 'pink', f2: 2500, q: 0.8, a: 0.02 })
    N(0.25, 0.3, 2000, 0, { color: 'crackle' })
    T('sawtooth', 200, 90, 0.2, 0.07, 0, { lp: 800 })
  } else if (/acid|toxic|venom|spit|goo|slime|poison/.test(k)) {
    N(0.15, 0.25, 1200, 0, { color: 'pink', f2: 500, q: 2 })
    T('sine', 300, 700, 0.08, 0.12, 0, { glide: 0.05 })
    T('sine', 500, 900, 0.06, 0.06, 0.06)
  } else if (/laser|beam|bolt|ray|zap|shock|spark/.test(k)) {
    T('sawtooth', 1900, 300, 0.12, 0.1)
    T('square', 950, 200, 0.08, 0.05)
    N(0.08, 0.1, 3000, 0, { color: 'crackle' })
  } else if (/plasma|orb|energy|ball|pulse/.test(k)) {
    T('sine', 500, 180, 0.3, 0.16, 0, { vib: 20, vibD: 50 })
    N(0.25, 0.12, 800, 0, { ft: 'lowpass', f2: 300 })
  } else if (/rock|junk|scrap|debris|stone|shard/.test(k)) {
    N(0.25, 0.32, 700, 0, { f2: 250, q: 1.2, a: 0.03 })
    T('triangle', 220, 120, 0.12, 0.1)
  } else if (/missile|rocket|bomb|grenade|shell|payload/.test(k)) {
    N(0.5, 0.3, 1500, 0, { f2: 500, q: 0.8, a: 0.02 })
    T('sawtooth', 120, 80, 0.4, 0.08, 0, { lp: 600 })
    N(0.06, 0.2, 2500)
  } else if (/data|packet|byte|bit|code|virus|worm|glitch|admin|root/.test(k)) {
    for (let i = 0; i < 4; i++) T('square', 1200 + i * 350, 1200 + i * 350, 0.025, 0.06, i * 0.03, { shape: 'crush' })
    N(0.12, 0.08, 3000, 0, { color: 'digital' })
  } else if (/web|silk|net|hook/.test(k)) {
    N(0.1, 0.3, 2500, 0, { f2: 5000, q: 3 })
    T('sine', 1800, 600, 0.08, 0.08)
  } else {
    const h = hash(k) // unknown kinds still get a stable sound of their own
    const f = 400 + (h % 1200)
    T(OSC_TYPES[h % 3], f, f * 0.35, 0.16, 0.12)
    N(0.1, 0.1, f * 2, 0, { q: 1.5 })
  }
}

function eventSound(kind: WorldEventKind) {
  switch (kind) {
    case 'outage': // breaker trips, everything spins down
      N(0.04, 0.3, 1500, 0, { q: 2 })
      T('sawtooth', 220, 28, 1.6, 0.16, 0, { lp: 1400, lp2: 80 })
      T('sine', 120, 22, 1.8, 0.25)
      T('sine', 60, 50, 1.4, 0.1, 0, { hold: 0.2 })
      N(0.5, 0.25, 2600, 0, { color: 'crackle', q: 0.8 })
      break
    case 'outbreak': // wailing siren
      for (let i = 0; i < 4; i++) {
        T('sawtooth', i % 2 ? 950 : 600, i % 2 ? 600 : 950, 0.08, 0.09, i * 0.45, { hold: 0.35, glide: 0.42, lp: 2200, vib: 6, vibD: 8 })
      }
      T('square', 110, 110, 1.6, 0.05, 0, { lp: 400, hold: 0.2 })
      break
    case 'zeroday': // glitches over a swelling drone and a digital shriek
      for (let i = 0; i < 6; i++) {
        const f = rnd(300, 3000)
        T('square', f, f, 0.03, 0.07, i * 0.06, { shape: 'crush' })
      }
      T('sawtooth', 41, 41, 0.8, 0.14, 0.2, { a: 0.6, lp: 300, lp2: 900 })
      T('sine', 3000, 5200, 0.3, 0.05, 0.45, { a: 0.1, shape: 'crush' })
      for (let i = 0; i < 4; i++) {
        const f = i % 2 ? 2400 : 1300
        T('square', f, f, 0.04, 0.04, 0.9 + i * 0.05)
      }
      break
    case 'rootkit': // a giant bell tolling twice over a rumble
      T('sine', 110, 110, 3, 0.22, 0, { fm: 1.4, fmI: 260 })
      T('sine', 55, 55, 3, 0.2)
      T('sine', 98, 98, 3, 0.18, 1.4, { fm: 1.4, fmI: 230 })
      N(1.6, 0.18, 250, 0.2, { color: 'brown', ft: 'lowpass', f2: 900, a: 0.8 })
      break
    case 'season': // bright celebratory run and chord
      arp('triangle', [523, 587, 659, 784, 880, 1047, 1175, 1319], 0.06, 0.3, 0.07)
      for (const f of [523, 659, 784, 1047]) T('triangle', f, f, 1.2, 0.05, 0.5, { vib: 5, vibD: 3 })
      N(1, 0.04, 9000, 0.4, { ft: 'highpass', a: 0.2 })
      break
    default:
      T('triangle', 880, 880, 0.15, 0.08)
      T('triangle', 1175, 1175, 0.25, 0.08, 0.1)
  }
}

// ---------------------------------------------------------------------------
// Public sound effects. pan is -1..1, vol 0..1 (distance), both optional.
// ---------------------------------------------------------------------------

export const sfx = {
  // --- original kit ---
  shoot: (overload = false) => {
    if (!begin(overload ? 'shoot!' : 'shoot', 0, 1, { rev: overload ? 0.15 : 0.03 })) return
    T('sawtooth', overload ? 900 : 1500, overload ? 60 : 180, overload ? 0.35 : 0.14, overload ? 0.35 : 0.18)
    T('square', overload ? 300 : 700, 90, 0.1, 0.08)
    N(0.02, 0.07, 5000)
    if (overload) N(0.3, 0.3, 500)
  },
  remoteShot: (pan: number, vol: number) => {
    if (!begin('remoteShot', pan, vol, { prio: 0 })) return
    T('sawtooth', 1300, 200, 0.12, 0.12)
  },
  hit: () => {
    if (!begin('hit')) return
    N(0.08, 0.35, 2400)
    T('square', 220, 110, 0.06, 0.1)
  },
  kill: () => {
    if (!begin('kill', 0, 1, { rev: 0.12 })) return
    N(0.4, 0.4, 900)
    arp('triangle', [523, 659, 784, 1046], 0.06, 0.12, 0.15)
  },
  hurt: () => {
    if (!begin('hurt', 0, 1, { prio: 2 })) return
    N(0.25, 0.5, 300)
    T('sawtooth', 160, 50, 0.25, 0.2)
  },
  miss: () => {
    if (!begin('miss')) return
    T('sine', 900, 1400, 0.08, 0.06)
  },
  levelup: () => {
    if (!begin('levelup', 0, 1, { prio: 2, rev: 0.25 })) return
    ;[392, 523, 659, 784, 1046, 1318].forEach((f, i) => T('triangle', f, f * 1.01, 0.22, 0.18, i * 0.08))
    N(0.8, 0.04, 8000, 0.4, { ft: 'highpass', a: 0.1 })
  },
  repair: () => {
    if (!begin('repair', 0, 1, { rev: 0.2 })) return
    ;[300, 450, 600, 900].forEach((f, i) => T('sine', f, f * 1.5, 0.2, 0.12, i * 0.05))
  },
  death: () => {
    if (!begin('death', 0, 1, { prio: 2, rev: 0.3, gap: 400 })) return
    T('sawtooth', 400, 30, 1.4, 0.3)
    N(1.2, 0.3, 200)
  },
  step: () => {
    if (!begin('step', 0, 1, { prio: 0 })) return
    const r = rnd(0.85, 1.15) // slight variation so steps don't machine-gun
    N(0.06, 0.3, 140 * r, 0, { color: 'brown', q: 0.9 })
    N(0.025, 0.05, 2200 * r, 0, { q: 1.2 })
  },
  empty: () => {
    if (!begin('empty', 0, 1, { gap: 60 })) return
    T('square', 120, 80, 0.08, 0.08)
  },

  // --- weapons ---
  weapon: (kind: WeaponKind, pan = 0, vol = 1) => {
    const heavy = kind === 'railgun' || kind === 'cannon' || kind === 'horizon'
    if (!begin('w:' + kind, pan, vol, { rev: heavy ? 0.25 : 0.05 })) return
    weaponSound(kind)
  },
  railCharge: () => {
    if (!begin('railCharge', 0, 1, { gap: 120 })) return
    T('sine', 180, 2600, 0.08, 0.12, 0, { a: 0.85, glide: 0.9 })
    T('square', 90, 720, 0.06, 0.035, 0, { a: 0.85, glide: 0.9, lp: 900, lp2: 5000 })
    N(0.08, 0.08, 400, 0, { a: 0.85, f2: 7000, q: 3 })
  },
  plasmaLoop: (on: boolean) => setPlasma(!!on),
  crit: () => {
    if (!begin('crit', 0, 1, { rev: 0.1 })) return
    T('square', 1900, 950, 0.06, 0.1)
    T('sine', 2600, 2600, 0.3, 0.1, 0, { fm: 3.5, fmI: 1800 })
    T('triangle', 1320, 1980, 0.12, 0.08, 0.03)
    N(0.05, 0.2, 6500, 0, { ft: 'highpass' })
  },
  hitmarker: () => {
    if (!begin('hitmarker')) return
    T('square', 3100, 2400, 0.025, 0.07)
    T('sine', 1600, 1500, 0.03, 0.06)
  },
  killConfirm: () => {
    if (!begin('killConfirm', 0, 1, { rev: 0.15 })) return
    T('triangle', 1319, 1319, 0.12, 0.11, 0, { fm: 2, fmI: 400 })
    T('triangle', 1760, 1760, 0.24, 0.11, 0.08, { fm: 2, fmI: 500 })
    N(0.06, 0.06, 7000, 0, { ft: 'highpass' })
  },

  // --- abilities ---
  cast: (spell: string, pan = 0, vol = 1) => {
    if (!begin('c:' + spell, pan, vol, { rev: 0.25 })) return
    castSound(spell)
  },
  cooldownReady: () => {
    if (!begin('cooldownReady', 0, 1, { gap: 80 })) return
    T('triangle', 880, 880, 0.12, 0.08)
    T('triangle', 1319, 1319, 0.2, 0.08, 0.07)
  },
  noMana: () => {
    if (!begin('noMana', 0, 1, { gap: 150 })) return
    for (const w of [0, 0.16]) {
      T('square', 140, 135, 0.12, 0.06, w, { lp: 900 })
      T('square', 147, 140, 0.12, 0.06, w, { lp: 900 })
    }
  },
  dash: () => {
    if (!begin('dash')) return
    N(0.2, 0.3, 400, 0, { f2: 2600, q: 1.2, a: 0.02 })
    T('sine', 180, 520, 0.15, 0.06)
  },

  // --- items and economy ---
  drink: () => {
    if (!begin('drink', 0, 1, { gap: 200 })) return
    for (let i = 0; i < 3; i++) T('sine', 200 + i * 30, 520 + i * 40, 0.06, 0.14, i * 0.13, { glide: 0.05 }) // glug
    N(0.3, 0.06, 500, 0, { color: 'pink', ft: 'lowpass' })
    arp('triangle', [660, 990], 0.06, 0.18, 0.05, 0.45)
  },
  potionShatter: (pan = 0, vol = 1) => {
    if (!begin('potionShatter', pan, vol, { rev: 0.15 })) return
    N(0.25, 0.3, 4500, 0, { ft: 'highpass' })
    for (let i = 0; i < 4; i++) {
      const f = rnd(2500, 6000)
      T('sine', f, f, rnd(0.15, 0.3), 0.05, i * 0.02 + rnd(0, 0.03), { fm: 1.73, fmI: f * 0.5 })
    }
    N(0.35, 0.18, 800, 0.02, { color: 'pink', q: 0.8, f2: 400 }) // splash
  },
  throwItem: () => {
    if (!begin('throwItem')) return
    N(0.25, 0.2, 1400, 0, { f2: 350, q: 1.5, a: 0.03 })
    T('sine', 500, 240, 0.2, 0.04)
  },
  pickup: (rarity: number) => {
    const r = Math.floor(clamp(fin(rarity, 0), 0, 5))
    if (!begin('pickup' + r, 0, 1, { prio: r >= 3 ? 2 : 1, rev: r >= 2 ? 0.2 + r * 0.05 : 0.05 })) return
    const b = [660, 740, 784, 880, 988, 1047][r]
    T('triangle', b, b * 1.5, 0.08, 0.12)
    if (r >= 1) T('triangle', b * 1.5, b * 1.5, 0.15, 0.1, 0.06)
    if (r >= 2) arp('sine', [b * 2, b * 2.5, b * 3], 0.05, 0.25, 0.06, 0.1, { fm: 2, fmI: 200 })
    if (r >= 3) {
      for (const m of [1, 1.25, 1.5, 2]) T('triangle', b * m, b * m, 0.8, 0.04, 0.25, { vib: 5, vibD: 4 })
      N(0.8, 0.04, 9000, 0.2, { ft: 'highpass', a: 0.2 })
    }
    if (r >= 4) {
      T('sawtooth', b / 2, b * 2, 0.3, 0.06, 0, { a: 0.25, glide: 0.3, lp: 3000 })
      T('sine', b / 4, b / 4, 1.2, 0.12, 0.25)
    }
  },
  coins: () => {
    if (!begin('coins', 0, 1, { gap: 40 })) return
    ;[1976, 2637, 2349].forEach((f0, i) => {
      const f = f0 * rnd(0.98, 1.02)
      T('sine', f, f, 0.18, 0.07, i * 0.055 + rnd(0, 0.01), { fm: 3.1, fmI: 1500 })
    })
    N(0.05, 0.05, 7000, 0, { ft: 'highpass' })
  },
  equip: () => {
    if (!begin('equip')) return
    N(0.03, 0.2, 2200, 0, { q: 2 })
    N(0.03, 0.18, 1600, 0.07, { q: 2 })
    T('square', 420, 300, 0.04, 0.05)
    T('sine', 130, 70, 0.1, 0.18, 0.07)
  },
  buy: () => {
    if (!begin('buy', 0, 1, { rev: 0.1 })) return
    N(0.04, 0.15, 3000)
    T('sine', 1568, 1568, 0.2, 0.08, 0, { fm: 3, fmI: 1200 })
    N(0.04, 0.1, 5000, 0.1)
    T('sine', 2093, 2093, 0.4, 0.08, 0.1, { fm: 3, fmI: 1500 })
  },
  sell: () => {
    if (!begin('sell', 0, 1, { rev: 0.1 })) return
    T('sine', 2093, 2093, 0.15, 0.07, 0, { fm: 3, fmI: 1500 })
    T('sine', 1568, 1568, 0.3, 0.07, 0.09, { fm: 3, fmI: 1200 })
    N(0.2, 0.08, 2500, 0, { f2: 600 })
  },
  identify: (good: boolean) => {
    if (!begin('identify', 0, 1, { rev: 0.15 })) return
    for (let i = 0; i < 6; i++) {
      const f = rnd(800, 3200) // scanning
      T('square', f, f, 0.025, 0.035, i * 0.04, { lp: 5000 })
    }
    if (good) arp('triangle', [1047, 1319, 1568, 2093], 0.06, 0.3, 0.1, 0.26, { fm: 2, fmI: 200 })
    else {
      T('sawtooth', 311, 220, 0.35, 0.1, 0.26, { lp: 1200 })
      T('sawtooth', 440, 311, 0.35, 0.07, 0.26, { lp: 1200 })
    }
  },

  // --- explosions ---
  explosion: (kind: ExplosionKind, pan = 0, vol = 1) => {
    if (!begin('x:' + kind, pan, vol, { rev: 0.3 })) return
    explosionSound(kind)
  },

  // --- monsters ---
  monster: (key: string, kind: MonsterSoundKind, pan = 0, vol = 1) => {
    const v = voiceFor(String(key))
    const big = v.s >= 2
    if (!begin('m:' + key + ':' + kind, pan, vol, { prio: big ? 1 : 0, rev: v.rev ?? (v.s > 1.5 ? 0.2 : 0.08) })) return
    monsterSound(String(key), kind, v)
  },
  fuse: (pan = 0, vol = 1) => {
    if (!begin('fuse', pan, vol, { gap: 150 })) return
    N(0.9, 0.12, 4000, 0, { color: 'crackle', ft: 'highpass', a: 0.05 }) // sizzle
    N(0.9, 0.05, 6000, 0, { ft: 'highpass' })
    ;[0, 0.22, 0.4, 0.54, 0.65, 0.73, 0.79].forEach((w, i) => T('square', 1700 + i * 60, 1700 + i * 60, 0.04, 0.06, w, { lp: 4000 }))
  },
  telegraph: (pan = 0, vol = 1) => {
    if (!begin('telegraph', pan, vol, { gap: 80 })) return
    T('sawtooth', 280, 1100, 0.08, 0.1, 0, { a: 0.45, glide: 0.5, lp: 800, lp2: 4000, vib: 12, vibD: 20 })
    N(0.06, 0.12, 2000, 0, { ft: 'highpass', a: 0.45 })
    T('square', 1100, 1100, 0.12, 0.06, 0.5)
  },
  distress: (pan = 0, vol = 1) => {
    if (!begin('distress', pan, vol, { prio: 0, rev: 0.3, gap: 200 })) return
    for (let i = 0; i < 3; i++) {
      const f = i % 2 ? 740 : 988
      T('square', f, f, 0.08, 0.06, i * 0.22, { hold: 0.12, lp: 2500, vib: 7, vibD: 10 })
    }
  },
  ambush: (pan = 0, vol = 1) => {
    if (!begin('ambush', pan, vol, { prio: 2, rev: 0.35, gap: 300 })) return
    for (const f of [130.8, 138.6, 185, 196]) T('sawtooth', f, f * 0.94, 1, 0.08, 0, { lp: 3000, lp2: 400 }) // dissonant sting
    N(0.3, 0.35, 1200, 0, { q: 0.6 })
    T('sine', 90, 30, 0.8, 0.5)
  },
  bossRoar: () => {
    if (!begin('bossRoar', 0, 1, { prio: 2, rev: 0.5, gap: 300 })) return
    T('sawtooth', 55, 42, 1.6, 0.22, 0, { a: 0.15, vib: 7, vibD: 4, lp: 900, shape: 'drive' })
    T('sawtooth', 58, 44, 1.6, 0.18, 0, { a: 0.15, vib: 6, vibD: 5, lp: 900 })
    T('sawtooth', 82, 61, 1.5, 0.12, 0, { a: 0.2, vib: 8, vibD: 6, lp: 1200 })
    N(0.6, 0.35, 350, 0, { color: 'pink', f2: 900, q: 1.5, a: 0.2 })
    N(0.9, 0.3, 900, 0.6, { color: 'pink', f2: 250, q: 1.5 })
    T('sine', 40, 30, 1.8, 0.4, 0, { a: 0.1 })
  },
  projectile: (kind: string, pan = 0, vol = 1) => {
    if (!begin('p:' + kind, pan, vol, { prio: 0 })) return
    projectileSound(kind)
  },

  // --- world ---
  door: (pan = 0, vol = 1) => {
    if (!begin('door', pan, vol, { prio: 0, gap: 100 })) return
    N(0.45, 0.25, 700, 0, { f2: 280, q: 0.9, a: 0.02 }) // pneumatic hiss
    T('sawtooth', 80, 90, 0.35, 0.06, 0, { lp: 300, a: 0.05 }) // motor
    N(0.05, 0.2, 1800, 0.38, { q: 2 }) // latch
    T('sine', 110, 50, 0.15, 0.25, 0.38) // clunk
  },
  gateOpen: () => {
    if (!begin('gateOpen', 0, 1, { rev: 0.35, gap: 300 })) return
    T('sawtooth', 55, 62, 1, 0.1, 0, { a: 0.1, lp: 400, vib: 6, vibD: 2 })
    T('sine', 220, 220, 0.4, 0.06, 0, { fm: 2.4, fmI: 300 })
    T('sine', 180, 180, 0.4, 0.06, 0.35, { fm: 2.4, fmI: 260 })
    N(0.9, 0.12, 400, 0.05, { color: 'brown', ft: 'lowpass' })
    N(0.06, 0.25, 1400, 1.05, { q: 1.5 })
    T('sine', 90, 35, 0.5, 0.45, 1.05)
  },
  vaultOpen: () => {
    if (!begin('vaultOpen', 0, 1, { prio: 2, rev: 0.35, gap: 300 })) return
    for (const w of [0, 0.12, 0.24]) {
      N(0.03, 0.22, 2600, w, { q: 3 }) // bolts
      T('sine', 160, 90, 0.06, 0.12, w)
    }
    N(0.9, 0.18, 5000, 0.35, { ft: 'highpass', a: 0.03 }) // pressure release
    arp('triangle', [523, 659, 784, 1047], 0.07, 0.8, 0.07, 0.6, { vib: 5, vibD: 3 })
    T('sine', 130.8, 130.8, 1, 0.1, 0.6, { a: 0.1 })
  },
  denied: () => {
    if (!begin('denied', 0, 1, { gap: 150 })) return
    T('square', 220, 220, 0.12, 0.08, 0, { lp: 1500 })
    T('square', 175, 175, 0.18, 0.08, 0.15, { lp: 1500 })
  },
  lever: () => {
    if (!begin('lever')) return
    N(0.02, 0.2, 2500, 0, { q: 2 })
    for (const w of [0.03, 0.06, 0.09]) N(0.015, 0.1, 3500, w, { q: 3 }) // ratchet
    T('sine', 160, 60, 0.12, 0.3, 0.12)
    N(0.04, 0.15, 900, 0.12)
  },
  puzzleSolved: () => {
    if (!begin('puzzleSolved', 0, 1, { prio: 2, rev: 0.3, gap: 300 })) return
    arp('triangle', [659, 784, 988, 1319], 0.09, 0.3, 0.12)
    for (const f of [659, 831, 988, 1319]) T('triangle', f, f, 0.9, 0.05, 0.4, { vib: 5, vibD: 3 })
    T('sine', 165, 165, 1, 0.12, 0.4)
    N(0.8, 0.04, 9000, 0.4, { ft: 'highpass', a: 0.1 })
  },
  secret: () => {
    if (!begin('secret', 0, 1, { prio: 2, rev: 0.45, gap: 300 })) return
    arp('triangle', [523, 587, 659, 740, 831, 932, 1047], 0.05, 0.4, 0.07)
    T('sine', 2093, 2093, 1.2, 0.05, 0.35, { fm: 2.5, fmI: 600 })
    T('sine', 131, 131, 1.2, 0.1, 0, { a: 0.3 })
  },
  trapZap: (pan = 0, vol = 1) => {
    if (!begin('trapZap', pan, vol, { gap: 60 })) return
    N(0.3, 0.35, 3000, 0, { color: 'crackle', q: 0.7 })
    T('sawtooth', 60, 60, 0.28, 0.12, 0, { lp: 2000, vib: 60, vibD: 30 })
    T('square', 2000, 100, 0.2, 0.08)
  },
  laserGrid: (pan = 0, vol = 1) => {
    if (!begin('laserGrid', pan, vol, { prio: 0, gap: 100 })) return
    T('sine', 1800, 2200, 0.5, 0.06, 0, { a: 0.1, vib: 18, vibD: 30 })
    T('sawtooth', 100, 100, 0.5, 0.08, 0, { a: 0.08, lp: 900 })
    N(0.4, 0.06, 4000, 0, { color: 'crackle', a: 0.1 })
  },
  turretShot: (pan = 0, vol = 1) => {
    if (!begin('turretShot', pan, vol, { prio: 0 })) return
    T('square', 950, 220, 0.08, 0.1)
    N(0.04, 0.25, 2200, 0, { q: 1.2 })
    T('sine', 160, 70, 0.08, 0.2)
  },
  teleport: () => {
    if (!begin('teleport', 0, 1, { prio: 2, rev: 0.4, gap: 150 })) return
    T('sine', 200, 2000, 0.1, 0.12, 0, { a: 0.3, glide: 0.4, vib: 14, vibD: 40 })
    N(0.1, 0.1, 1000, 0, { a: 0.3, f2: 8000, q: 2 })
    T('sine', 2400, 2400, 0.4, 0.05, 0.3, { fm: 2.5, fmI: 800 })
    T('sine', 300, 80, 0.15, 0.2, 0.4) // pop
  },

  // --- interface ---
  ui: () => {
    if (!begin('ui', 0, 1, { gap: 30 })) return
    T('sine', 1200, 1100, 0.03, 0.06)
    N(0.012, 0.04, 5000, 0, { q: 2 })
  },
  uiOpen: () => {
    if (!begin('uiOpen', 0, 1, { gap: 40 })) return
    T('triangle', 600, 900, 0.06, 0.07)
    T('triangle', 900, 1350, 0.07, 0.06, 0.05)
  },
  uiClose: () => {
    if (!begin('uiClose', 0, 1, { gap: 40 })) return
    T('triangle', 900, 600, 0.06, 0.07)
    T('triangle', 600, 400, 0.07, 0.06, 0.05)
  },
  questComplete: () => {
    if (!begin('questComplete', 0, 1, { prio: 2, rev: 0.3, gap: 300 })) return
    arp('square', [523, 659, 784], 0.1, 0.15, 0.06, 0, { lp: 2500 })
    for (const f of [523, 659, 784, 1047]) T('triangle', f, f, 0.9, 0.07, 0.3, { vib: 5, vibD: 3, a: 0.02 })
    T('sine', 130.8, 130.8, 1, 0.12, 0.3)
    N(0.8, 0.04, 9000, 0.3, { ft: 'highpass', a: 0.1 })
  },
  achievement: () => {
    if (!begin('achievement', 0, 1, { prio: 2, rev: 0.35, gap: 300 })) return
    arp('triangle', [784, 988, 1175, 1568, 1976], 0.07, 0.3, 0.08)
    T('sine', 2637, 2637, 1, 0.05, 0.35, { fm: 2, fmI: 900 })
    for (const f of [392, 494, 587, 784]) T('triangle', f, f, 1.2, 0.05, 0.35, { vib: 5, vibD: 3 })
    N(1, 0.04, 9000, 0.3, { ft: 'highpass', a: 0.15 })
  },
  sectorCleared: () => {
    if (!begin('sectorCleared', 0, 1, { prio: 2, rev: 0.35, gap: 500 })) return
    ;[392, 523, 659].forEach((f, i) => T('sawtooth', f, f, 0.18, 0.08, i * 0.15, { a: 0.02, lp: 2400, lp2: 800 })) // brass stabs
    ;[523, 659, 784, 1047].forEach((f, i) => {
      T('sawtooth', f, f, 0.9, 0.05, 0.45, { a: 0.04, hold: 0.5, lp: 3000, lp2: 900, vib: 5, vibD: 3, detune: i % 2 ? 6 : -6 })
    })
    T('sine', 65.4, 65.4, 1.4, 0.18, 0.45)
    N(0.6, 0.12, 300, 0.2, { f2: 3000, a: 0.25, q: 0.8 })
  },
  talent: () => {
    if (!begin('talent', 0, 1, { rev: 0.3, gap: 100 })) return
    T('sine', 300, 1200, 0.1, 0.1, 0, { a: 0.15, glide: 0.2 })
    arp('triangle', [784, 988, 1175], 0.05, 0.35, 0.07, 0.15, { vib: 5, vibD: 3 })
    N(0.5, 0.04, 8000, 0.15, { ft: 'highpass' })
  },

  // --- world events ---
  event: (kind: WorldEventKind) => {
    if (!begin('e:' + kind, 0, 1, { prio: 2, rev: 0.4, gap: 500 })) return
    eventSound(kind)
  },
}
