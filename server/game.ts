// The authoritative game simulation. Runs without sockets, so tests can drive it directly.
import { computeStats, migrateCharacter, newCharacter, type CharacterData } from '../shared/character.ts'
import {
  DASH_TIME,
  INTEREST_RADIUS,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SECTOR_CORRUPTION,
  SPRINT_MULT,
  TICK_RATE,
  cellCenter,
  round2,
  toCell,
} from '../shared/constants.ts'
import { Grid, Mode } from '../shared/grid.ts'
import { potionColors } from '../shared/items.ts'
import { hashString } from '../shared/rng.ts'
import {
  MF,
  statusBit,
  type ClientMsg,
  type GameEvent,
  type LootNet,
  type MonsterNet,
  type PlayerNet,
  type ProjNet,
  type ServerMsg,
  type StatusId,
  type YouNet,
  type ZoneNet,
} from '../shared/protocol.ts'
import { dailyChallenges, dayKey, type DailyDef } from '../shared/quests.ts'
import { generateWorld } from '../shared/worldgen.ts'
import type { Puzzle, Vault, WorldInfo, WorldObject, WorldState } from '../shared/world.ts'
import * as actions from './actions.ts'
import * as ai from './ai.ts'
import * as combat from './combat.ts'
import type { Client, Loot, Monster, Player, Projectile, Zone } from './entities.ts'
import * as progress from './progress.ts'
import { accountKey, type Store } from './store.ts'
import * as worldstate from './worldstate.ts'

export interface GameOptions {
  store: Store
  rand?: () => number
  /** Seed for the first season when there is no saved world. */
  seed?: number
  /** Enables chat cheats such as /purge and /level for testing. */
  dev?: boolean
}

const NAME_RE = /^[A-Za-z0-9_\- ]{2,16}$/
const SPAWN_SHIELD = 4

export class Game {
  /** Simulation time in seconds. */
  time = 0
  tickCount = 0
  readonly rand: () => number
  readonly store: Store
  readonly dev: boolean

  world!: WorldInfo
  /** The world as clients see it: puzzle answers left out. */
  publicWorld!: WorldInfo
  grid!: Grid
  state!: WorldState
  season = 1
  seed = 0
  identified = new Set<string>()
  colors: Record<string, number> = {}
  /** Corruption points left per sector (state.corruption holds the 0..1 fraction). */
  corruptionPoints: number[] = []

  readonly players = new Map<string, Player>()
  readonly monsters = new Map<number, Monster>()
  readonly projectiles = new Map<number, Projectile>()
  readonly zones = new Map<number, Zone>()
  readonly loot = new Map<number, Loot>()
  objects = new Map<string, WorldObject>()
  puzzles = new Map<string, Puzzle>()
  vaults = new Map<string, Vault>()

  daily: DailyDef[] = []
  dailyDate = ''
  stateDirty = false
  private events: { ev: GameEvent; x?: number; z?: number; to?: string }[] = []
  private idCounter = 1
  private pendingJoins = new Set<string>()

  constructor(opts: GameOptions) {
    this.store = opts.store
    this.rand = opts.rand ?? Math.random
    this.dev = !!opts.dev
    const saved = this.store.loadWorld()
    if (saved) this.startSeason(saved.season, saved.seed, saved.state, saved.identified)
    else this.startSeason(1, opts.seed ?? hashString(`spacemyst-${Date.now()}`), null, null)
    this.refreshDaily()
  }

  nextId() {
    return this.idCounter++
  }

  // --- Seasons -------------------------------------------------------------------------------
  startSeason(season: number, seed: number, savedState: WorldState | null, identified: string[] | null) {
    this.season = season
    this.seed = seed
    this.world = generateWorld(seed, season)
    this.publicWorld = { ...this.world, puzzles: this.world.puzzles.map(({ order: _o, code: _c, ...rest }) => rest) }
    this.grid = new Grid(this.world)
    this.objects = new Map(this.world.objects.map((o) => [o.id, o]))
    this.puzzles = new Map(this.world.puzzles.map((p) => [p.id, p]))
    this.vaults = new Map(this.world.vaults.map((v) => [v.id, v]))
    this.colors = potionColors(season)
    this.identified = new Set(identified ?? ['repair_s', 'repair_m', 'energy'])
    this.state = savedState ? worldstate.restoreState(this, savedState) : worldstate.freshState(this)
    this.state.season = season
    this.corruptionPoints = this.state.corruption.map((f, s) => Math.round(f * SECTOR_CORRUPTION[s]))
    this.grid.applyState(this.state)
    this.monsters.clear()
    this.projectiles.clear()
    this.zones.clear()
    for (const [id, l] of this.loot) if (!l.dump) this.loot.delete(id)
    ai.populateWorld(this)
    progress.spawnGroundPotions(this)
    this.stateDirty = true
  }

  /** Called when the Mainframe falls and the countdown ends: a new maze for everyone. */
  resetSeason() {
    const season = this.season + 1
    this.startSeason(season, hashString(`spacemyst-season-${season}-${this.seed}`), null, null)
    this.loot.clear()
    for (const p of this.players.values()) {
      p.char = migrateCharacter(p.char, season)
      p.stats = computeStats(p.char)
      p.char.hubs = ['hub0']
      p.char.respawnHub = 'hub0'
      p.board = {}
      const spawn = this.spawnPoint(p)
      p.x = spawn.x
      p.z = spawn.z
      p.dead = false
      p.hp = p.stats.maxHp
      p.mana = p.stats.maxMana
      p.statuses.clear()
      p.shieldUntil = this.time + SPAWN_SHIELD
      this.send(p, { t: 'world', world: this.publicWorld, state: this.state, colors: this.colors, identified: [...this.identified] })
      this.send(p, { t: 'teleport', x: p.x, z: p.z })
      p.charDirty = true
    }
    this.emit({ kind: 'season', state: 'reset', season, at: 0, msg: `Season ${season} begins. The network has rebuilt itself.` })
    this.save()
  }

  refreshDaily() {
    const today = dayKey()
    if (today === this.dailyDate) return
    this.dailyDate = today
    this.daily = dailyChallenges(today)
  }

  // --- Players --------------------------------------------------------------------------------
  /** Spawn point at the player's respawn hub, slightly spread so people don't stack. */
  spawnPoint(p: { char: CharacterData }) {
    const hub = this.world.hubs.find((h) => h.id === p.char.respawnHub) ?? this.world.hubs[0]
    const a = this.rand() * Math.PI * 2
    return { x: cellCenter(hub.cx) + Math.cos(a) * 1.5, z: cellCenter(hub.cz) + Math.sin(a) * 1.5 }
  }

  async join(client: Client, rawName: string, rawPass: string): Promise<Player | null> {
    const name = String(rawName ?? '').trim()
    const pass = String(rawPass ?? '')
    const deny = (reason: string) => {
      client.send({ t: 'denied', reason })
      return null
    }
    if (!NAME_RE.test(name)) return deny('Names are 2 to 16 letters, digits, spaces, - or _.')
    const key = accountKey(name)
    if ([...this.players.values()].some((p) => accountKey(p.char.name) === key) || this.pendingJoins.has(key))
      return deny('That hacker is already online.')
    let saved: CharacterData | null = null
    let account: string | null = null
    if (pass) {
      this.pendingJoins.add(key)
      try {
        const res = await this.store.login(name, pass)
        if (!res.ok) return deny(res.reason)
        saved = res.char
        account = key
      } finally {
        this.pendingJoins.delete(key)
      }
      if ([...this.players.values()].some((p) => accountKey(p.char.name) === key)) return deny('That hacker is already online.')
    } else if (this.store.hasAccount(name)) {
      return deny('That name belongs to an account. Enter its password, or pick another name to play as a guest.')
    }
    const char = saved ? migrateCharacter(saved, this.season) : newCharacter(name, this.season)
    char.name = saved ? char.name : name
    const stats = computeStats(char)
    const id = `p${this.nextId()}`
    const p: Player = {
      id,
      client,
      char,
      stats,
      account,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      hp: stats.maxHp,
      mana: stats.maxMana,
      hue: (hashString(char.name) % 1000) / 1000,
      dead: false,
      respawnAt: 0,
      lastMove: this.time,
      dashUntil: 0,
      iframesUntil: 0,
      dashReady: 0,
      fireReady: 0,
      potionReady: 0,
      spellReady: {},
      statuses: new Map(),
      heals: [],
      shieldUntil: this.time + SPAWN_SHIELD,
      leech: null,
      deaths: [],
      board: {},
      hub: -1,
      sector: 0,
      charDirty: false,
      charSoft: false,
      charSentAt: 0,
      lastShot: -10,
      bought: new Set(),
      boughtWindow: -1,
      sessionKills: 0,
      lootSentAt: -10,
      lastFullInv: -10,
      chatTimes: [],
      trapHitAt: {},
      joinedAt: this.time,
      connected: true,
    }
    const spawn = this.spawnPoint(p)
    p.x = spawn.x
    p.z = spawn.z
    p.yaw = Math.PI
    this.players.set(id, p)
    if (account && !saved) this.store.saveCharacter(account, char)
    progress.prepareDaily(this, p)
    progress.restoreQuestLoot(this, p)
    for (const l of this.loot.values()) if (l.dump && l.ownerName && accountKey(l.ownerName) === key) l.owner = id
    this.send(p, {
      t: 'welcome',
      you: id,
      guest: !account,
      world: this.publicWorld,
      state: this.state,
      char,
      colors: this.colors,
      identified: [...this.identified],
      daily: this.daily,
      time: this.time,
    })
    this.emit({ kind: 'system', text: `${char.name} jacked into the network.`, cls: 'sys' })
    if (!account) this.toast(p, 'Playing as a guest: progress is not saved. Enter a password next time to keep your hacker.')
    return p
  }

  leave(p: Player) {
    if (!this.players.has(p.id)) return
    p.connected = false
    this.saveCharacter(p)
    this.players.delete(p.id)
    for (const z of this.zones.values()) if (z.owner === p.id && (z.kind === 'daemon' || z.kind === 'honeypot')) this.zones.delete(z.id)
    for (const m of this.monsters.values()) if (m.allyOf === p.id) m.allyOf = null
    for (const [id, l] of this.loot) if (l.owner === p.id && !l.dump) this.loot.delete(id)
    this.emit({ kind: 'system', text: `${p.char.name} logged off.`, cls: 'sys' })
  }

  saveCharacter(p: Player) {
    if (p.account) this.store.saveCharacter(p.account, p.char)
  }

  save() {
    for (const p of this.players.values()) this.saveCharacter(p)
    this.store.flush()
    this.store.saveWorld({ season: this.season, seed: this.seed, state: this.state, identified: [...this.identified] })
  }

  // --- Messages ---------------------------------------------------------------------------------
  handle(p: Player, msg: ClientMsg) {
    if (!msg || typeof msg !== 'object' || !this.players.has(p.id)) return
    switch (msg.t) {
      case 'move':
        return this.handleMove(p, msg)
      case 'fire':
        return actions.fire(this, p, msg)
      case 'cast':
        return actions.cast(this, p, msg)
      case 'use':
        return actions.useQuickbar(this, p, msg)
      case 'grenade':
        return actions.throwGrenade(this, p, msg)
      case 'throw':
        return actions.throwFromInventory(this, p, msg)
      case 'swap':
        return progress.swapWeapon(this, p)
      case 'interact':
        return worldstate.interact(this, p, String(msg.obj ?? ''), Number(msg.arg ?? 0))
      case 'touch':
        return worldstate.touchFake(this, p, Number(msg.cell))
      case 'inv':
        return progress.inventoryOp(this, p, msg)
      case 'spell':
        return progress.assignSpell(this, p, Number(msg.slot), msg.id === null ? null : String(msg.id))
      case 'talent':
        return progress.learnTalent(this, p, String(msg.id))
      case 'respec':
        return progress.respec(this, p)
      case 'shop':
        return progress.shopAction(this, p, msg)
      case 'quest':
        return progress.questAction(this, p, msg.op, String(msg.id))
      case 'travel':
        return worldstate.travel(this, p, String(msg.hub))
      case 'chat':
        return this.chat(p, String(msg.text ?? ''))
    }
  }

  private handleMove(p: Player, msg: Extract<ClientMsg, { t: 'move' }>) {
    const { x, z, yaw, pitch } = msg
    if (![x, z, yaw, pitch].every(Number.isFinite)) return
    p.yaw = yaw
    p.pitch = Math.max(-1.5, Math.min(1.5, pitch))
    if (p.dead) return
    const now = this.time
    const dt = Math.max(1 / TICK_RATE, now - p.lastMove)
    p.lastMove = now
    if (msg.dash && now >= p.dashReady - 0.15 && !p.statuses.has('rooted')) {
      p.dashUntil = now + DASH_TIME + 0.2
      p.iframesUntil = now + 0.3
      p.dashReady = now + p.stats.dashCooldown
      progress.count(this, p, 'dashes')
    }
    const dashing = now < p.dashUntil
    const rooted = p.statuses.has('rooted')
    const pulled = p.statuses.get('pulled')
    let maxSpeed = PLAYER_SPEED * SPRINT_MULT * this.speedMult(p)
    if (dashing) maxSpeed = Math.max(maxSpeed, 30)
    if (pulled) maxSpeed += pulled.power
    if (rooted && !pulled) maxSpeed = 0.5
    const step = Math.hypot(x - p.x, z - p.z)
    const allowed = maxSpeed * dt * 1.6 + 0.6
    if (step > allowed || this.grid.blocked(x, z, PLAYER_RADIUS * 0.8, Mode.Player)) {
      this.send(p, { t: 'correct', x: p.x, z: p.z })
      return
    }
    // Smoothed velocity, used by monsters that lead their shots.
    const k = Math.min(1, dt * 8)
    p.vx += ((x - p.x) / dt - p.vx) * k
    p.vz += ((z - p.z) / dt - p.vz) * k
    p.x = x
    p.z = z
  }

  /** Movement speed multiplier from statuses and gear. */
  speedMult(p: Player) {
    let m = p.stats.moveSpeed
    if (p.statuses.has('haste')) m *= 1.25
    if (p.statuses.has('slowed')) m *= 0.6
    if (p.stats.powers.includes('adrenal') && p.hp < p.stats.maxHp * 0.3) m *= 1.25
    return m
  }

  private chat(p: Player, raw: string) {
    const text = raw.slice(0, 160).trim()
    if (!text) return
    p.chatTimes = p.chatTimes.filter((t) => this.time - t < 5)
    if (p.chatTimes.length >= 5) return this.toast(p, 'Slow down a little.')
    p.chatTimes.push(this.time)
    if (text.startsWith('/') && this.dev) return worldstate.devCommand(this, p, text)
    this.emit({ kind: 'chat', name: p.char.name, text })
  }

  // --- Output ---------------------------------------------------------------------------------
  send(p: Player, msg: ServerMsg) {
    if (p.connected) p.client.send(msg)
  }

  /** Queues an event. With a position, only nearby players get it; with `to`, only that player. */
  emit(ev: GameEvent, where?: { x: number; z: number } | { to: string }) {
    if (!where) this.events.push({ ev })
    else if ('to' in where) this.events.push({ ev, to: where.to })
    else this.events.push({ ev, x: where.x, z: where.z })
  }

  toast(p: Player, text: string, cls = 'sys') {
    this.emit({ kind: 'toast', text, cls }, { to: p.id })
  }

  markState() {
    this.stateDirty = true
  }

  // --- Simulation -------------------------------------------------------------------------------
  /** Advances the simulation by dt seconds (one tick). */
  step(dt: number) {
    this.time += dt
    this.tickCount++
    worldstate.updateDoors(this)
    combat.updatePlayers(this, dt)
    ai.updateMonsters(this, dt)
    actions.updateProjectiles(this, dt)
    actions.updateZones(this, dt)
    worldstate.update(this, dt)
    ai.spawner(this, dt)
    progress.updateLoot(this)
    if (this.tickCount % (TICK_RATE * 60) === 0) this.refreshDaily()
    this.flush()
  }

  private flush() {
    if (this.stateDirty) {
      this.stateDirty = false
      this.grid.applyState(this.state)
      const msg: ServerMsg = { t: 'state', state: this.state, identified: [...this.identified] }
      for (const p of this.players.values()) this.send(p, msg)
    }
    const R = INTEREST_RADIUS + 8
    const events = this.events
    this.events = []
    const players = [...this.players.values()]
    const playerNets = players.map((p) => this.playerNet(p))
    for (const p of players) {
      if (p.charDirty || (p.charSoft && this.time - p.charSentAt > 2)) {
        p.charDirty = false
        p.charSoft = false
        p.charSentAt = this.time
        p.stats = computeStats(p.char)
        p.hp = Math.min(p.hp, p.stats.maxHp)
        this.send(p, { t: 'char', char: p.char })
      }
      this.send(p, this.snapshot(p, playerNets))
      const mine = events.filter((e) => (e.to ? e.to === p.id : e.x === undefined || Math.hypot(e.x - p.x, (e.z ?? 0) - p.z) < R))
      if (mine.length) this.send(p, { t: 'events', list: mine.map((e) => e.ev) })
    }
  }

  private playerNet(p: Player): PlayerNet {
    const armor = p.char.equipment.armor
    const weapon = p.char.active === 0 ? p.char.equipment.weapon : p.char.equipment.weapon2
    return {
      id: p.id,
      name: p.char.name,
      x: round2(p.x),
      z: round2(p.z),
      yaw: round2(p.yaw),
      pitch: round2(p.pitch),
      hp: Math.ceil(p.hp),
      maxHp: p.stats.maxHp,
      level: p.char.level,
      hue: p.hue,
      armor: armor ? Number(armor.base) : -1,
      weapon: weapon?.base ?? 'laser',
      st: this.statusMask(p.statuses),
      dead: p.dead,
      kills: p.char.counters.kills ?? 0,
      badges: p.char.counters.seasons ?? 0,
    }
  }

  statusMask(statuses: Map<StatusId, unknown>) {
    let mask = 0
    for (const s of statuses.keys()) mask |= statusBit(s)
    return mask
  }

  private snapshot(p: Player, players: PlayerNet[]): ServerMsg {
    const R = INTEREST_RADIUS
    const near = (x: number, z: number) => Math.abs(x - p.x) < R && Math.abs(z - p.z) < R
    const now = this.time
    const monsters: MonsterNet[] = []
    for (const m of this.monsters.values()) {
      if (m.dead || !near(m.x, m.z)) continue
      monsters.push(this.monsterNet(m, now))
    }
    const proj: ProjNet[] = []
    for (const pr of this.projectiles.values()) {
      if (!near(pr.x, pr.z)) continue
      proj.push({
        id: pr.id,
        k: pr.kind === 'grenade' ? `grenade_${pr.data.grenade}` : pr.kind,
        x: round2(pr.x),
        y: round2(pr.y),
        z: round2(pr.z),
        vx: round2(pr.vx),
        vy: round2(pr.vy),
        vz: round2(pr.vz),
        c: pr.data.color,
        o: pr.owner.kind === 'player' ? 1 : 0,
      })
    }
    const zones: ZoneNet[] = []
    for (const zn of this.zones.values()) {
      if (!near(zn.x, zn.z)) continue
      const net: ZoneNet = { id: zn.id, k: zn.kind, x: round2(zn.x), z: round2(zn.z), r: round2(zn.r), t: round2(Math.max(0, zn.until - now)) }
      if (zn.len) {
        net.a = round2(zn.angle)
        net.l = round2(zn.len)
      }
      if (zn.owner) net.o = zn.owner
      zones.push(net)
    }
    let loot: LootNet[] | undefined
    if (now - p.lootSentAt >= 0.25) {
      p.lootSentAt = now
      loot = []
      for (const l of this.loot.values()) {
        if ((l.owner && l.owner !== p.id) || !near(l.x, l.z)) continue
        loot.push(progress.lootNet(this, l, p))
      }
    }
    const statusList: [StatusId, number][] = []
    for (const [s, inst] of p.statuses) statusList.push([s, round2(Math.max(0, inst.until - now))])
    const pull = p.statuses.get('pulled')
    const you: YouNet = {
      hp: Math.ceil(p.hp),
      maxHp: p.stats.maxHp,
      mana: Math.floor(p.mana),
      maxMana: combat.maxManaNow(p),
      xp: p.char.xp,
      level: p.char.level,
      credits: p.char.credits,
      status: statusList,
      cd: p.char.spells.map((id) => (id ? round2(Math.max(0, (p.spellReady[id] ?? 0) - now)) : 0)),
      dash: round2(Math.max(0, p.dashReady - now)),
      potion: round2(Math.max(0, p.potionReady - now)),
      fire: round2(Math.max(0, p.fireReady - now)),
      dead: p.dead,
      respawn: p.dead ? round2(Math.max(0, p.respawnAt - now)) : 0,
      hub: p.hub,
      pull: pull ? [round2(pull.x ?? p.x), round2(pull.z ?? p.z), pull.power] : null,
      seasonEnds: this.state.seasonEndsAt ? round2(Math.max(0, this.state.seasonEndsAt - now)) : 0,
    }
    return { t: 'snap', time: round2(now), you, players, monsters, proj, zones, loot }
  }

  monsterNet(m: Monster, now: number): MonsterNet {
    let f = 0
    if (m.target) f |= MF.aggro
    if (m.boss) f |= MF.boss
    const revealed = m.revealedUntil > now
    if ((m.def.behaviour === 'phantom' || m.def.behaviour === 'zeroday') && !revealed) f |= MF.invisible
    if (m.def.behaviour === 'leviathan' && m.submergedUntil > now) f |= MF.invisible
    if (revealed) f |= MF.revealed
    if (m.ambush) f |= MF.hidden
    if (m.windup) f |= MF.windup
    if (m.shield > 0) f |= MF.shield
    if (m.distressUntil > now) f |= MF.distress
    if (m.allyOf) f |= MF.ally
    if (m.fuseAt > 0) f |= MF.fuse
    const net: MonsterNet = {
      id: m.id,
      k: m.def.key,
      x: round2(m.x),
      z: round2(m.z),
      y: round2(m.yaw),
      hp: Math.ceil(m.hp),
      mhp: m.maxHp,
      lv: m.level,
      f,
      st: this.statusMask(m.statuses),
    }
    if (m.elite) net.e = m.elite
    if (m.shieldMax > 0) net.sh = round2(m.shield / m.shieldMax)
    if (m.size !== 1) net.s = round2(m.size)
    if (m.fuseAt > 0) net.t = round2(Math.max(0, m.fuseAt - now))
    else if (m.distressUntil > now) net.t = round2(m.distressUntil - now)
    if (m.phase) net.ph = m.phase
    return net
  }

  // --- Helpers used across modules ---------------------------------------------------------------
  /** Players that are alive, connected and inside the world. */
  livePlayers() {
    return [...this.players.values()].filter((p) => !p.dead)
  }

  nearestPlayerDist(x: number, z: number) {
    let best = Infinity
    for (const p of this.players.values()) best = Math.min(best, Math.hypot(p.x - x, p.z - z))
    return best
  }

  cellOf(x: number, z: number) {
    return toCell(z) * this.world.width + toCell(x)
  }

  /** World position of a cell's centre. */
  cellPos(i: number) {
    return { x: cellCenter(i % this.world.width), z: cellCenter(Math.floor(i / this.world.width)) }
  }

  /** Is any of the given statuses on the entity? */
  static has(statuses: Map<StatusId, unknown>, ...ids: StatusId[]) {
    return ids.some((s) => statuses.has(s))
  }
}

