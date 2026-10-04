// Tiny synthesised sound kit, so the prototype needs no audio files.
let ctx: AudioContext | null = null
let master: GainNode | null = null

export function initAudio() {
  if (ctx) return
  ctx = new AudioContext()
  master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)
  ambience()
}

function env(gain: GainNode, t: number, attack: number, decay: number, peak: number) {
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, peak = 0.3, when = 0, pan = 0) {
  if (!ctx || !master) return
  const t = ctx.currentTime + when
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  const p = ctx.createStereoPanner()
  p.pan.value = pan
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
  env(g, t, 0.005, dur, peak)
  o.connect(g).connect(p).connect(master)
  o.start(t)
  o.stop(t + dur + 0.05)
}

function noise(dur: number, peak: number, freq: number, when = 0) {
  if (!ctx || !master) return
  const t = ctx.currentTime + when
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  const f = ctx.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.value = freq
  const g = ctx.createGain()
  env(g, t, 0.003, dur, peak)
  src.connect(f).connect(g).connect(master)
  src.start(t)
}

function ambience() {
  if (!ctx || !master) return
  const g = ctx.createGain()
  g.gain.value = 0.05
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 280
  for (const f of [43.65, 44.1, 65.4]) {
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = f
    o.connect(lp)
    o.start()
  }
  const lfo = ctx.createOscillator()
  const lfoGain = ctx.createGain()
  lfo.frequency.value = 0.07
  lfoGain.gain.value = 120
  lfo.connect(lfoGain).connect(lp.frequency)
  lfo.start()
  lp.connect(g).connect(master)
}

export const sfx = {
  shoot: (overload = false) => {
    tone('sawtooth', overload ? 900 : 1500, overload ? 60 : 180, overload ? 0.35 : 0.14, overload ? 0.35 : 0.18)
    tone('square', overload ? 300 : 700, 90, 0.1, 0.08)
    if (overload) noise(0.3, 0.3, 500)
  },
  remoteShot: (pan: number, vol: number) => tone('sawtooth', 1300, 200, 0.12, 0.12 * vol, 0, pan),
  hit: () => {
    noise(0.08, 0.35, 2400)
    tone('square', 220, 110, 0.06, 0.1)
  },
  kill: () => {
    noise(0.4, 0.4, 900)
    ;[523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.12, 0.15, i * 0.06))
  },
  hurt: () => {
    noise(0.25, 0.5, 300)
    tone('sawtooth', 160, 50, 0.25, 0.2)
  },
  miss: () => tone('sine', 900, 1400, 0.08, 0.06),
  levelup: () => [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone('triangle', f, f * 1.01, 0.22, 0.18, i * 0.08)),
  repair: () => [300, 450, 600, 900].forEach((f, i) => tone('sine', f, f * 1.5, 0.2, 0.12, i * 0.05)),
  death: () => {
    tone('sawtooth', 400, 30, 1.4, 0.3)
    noise(1.2, 0.3, 200)
  },
  step: () => noise(0.05, 0.05, 160),
  empty: () => tone('square', 120, 80, 0.08, 0.08),
}
