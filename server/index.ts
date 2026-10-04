import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CELL,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SPRINT_MULT,
  START_MAX_HP,
  TICK_RATE,
  WEAPON_COOLDOWN,
  WEAPON_RANGE,
  OVERLOAD_MANA,
  REPAIR_MANA,
  cellCenter,
  levelFromMaxHp,
  maxManaForLevel,
  toCell,
} from '../shared/constants.ts'
import { generateMaze } from '../shared/maze.ts'
import { MONSTER_BY_KEY, attackDamage, pickMonster } from '../shared/monsters.ts'
import type { ClientMsg, GameEvent, MonsterState, PlayerState, ServerMsg } from '../shared/protocol.ts'

const PORT = Number(process.env.PORT ?? 2567)
const ROOMS = Number(process.env.WORLD_ROOMS ?? 24)
const SEED = Number(process.env.WORLD_SEED ?? 1337)
const MONSTER_COUNT = Number(process.env.MONSTERS ?? 70)

const world = generateMaze(ROOMS, ROOMS, SEED)
const isWall = (cx: number, cz: number) =>
  cx < 0 || cz < 0 || cx >= world.width || cz >= world.height || world.grid[cz * world.width + cx] === 1
const solidAt = (x: number, z: number) => isWall(toCell(x), toCell(z))

const floorCells: [number, number][] = []
for (let z = 0; z < world.height; z++)
  for (let x = 0; x < world.width; x++) if (!isWall(x, z)) floorCells.push([x, z])

const randomFloor = () => floorCells[Math.floor(Math.random() * floorCells.length)]

/** A floor cell with no monster close by, so nobody spawns into a fight. */
function safeSpawn(): [number, number] {
  let best = randomFloor()
  let bestDist = 0
  for (let tries = 0; tries < 40; tries++) {
    const cell = randomFloor()
    const x = cellCenter(cell[0])
    const z = cellCenter(cell[1])
    let nearest = Infinity
    for (const m of monsters.values()) nearest = Math.min(nearest, Math.hypot(m.x - x, m.z - z))
    if (nearest > CELL * 6) return cell
    if (nearest > bestDist) {
      bestDist = nearest
      best = cell
    }
  }
  return best
}

const SPAWN_SHIELD = 4

/** Walks the grid along a segment and reports whether it is unobstructed. */
function lineOfSight(ax: number, az: number, bx: number, bz: number) {
  const dist = Math.hypot(bx - ax, bz - az)
  const steps = Math.ceil(dist / (CELL / 4))
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    if (solidAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false
  }
  return true
}

/** Line of sight to the target's centre or either side of it, so grazing shots past a corner still count. */
function canSee(ax: number, az: number, bx: number, bz: number, halfWidth: number) {
  if (lineOfSight(ax, az, bx, bz)) return true
  const d = Math.hypot(bx - ax, bz - az) || 1
  const ox = (-(bz - az) / d) * halfWidth
  const oz = ((bx - ax) / d) * halfWidth
  return lineOfSight(ax, az, bx + ox, bz + oz) || lineOfSight(ax, az, bx - ox, bz - oz)
}

function blocked(x: number, z: number, r: number) {
  return solidAt(x - r, z - r) || solidAt(x + r, z - r) || solidAt(x - r, z + r) || solidAt(x + r, z + r)
}

interface Player extends PlayerState {
  ws: WebSocket
  lastShot: number
  lastMove: number
  /** Monsters ignore the player until this time (seconds), after joining or respawning. */
  shieldUntil: number
}

interface Monster extends MonsterState {
  homeX: number
  homeZ: number
  wanderX: number
  wanderZ: number
  lastBite: number
  target: string | null
}

const players = new Map<string, Player>()
const monsters = new Map<string, Monster>()
let events: GameEvent[] = []

function spawnMonster() {
  // Keep spawns away from players so nothing pops in on top of someone.
  let cell = randomFloor()
  for (let tries = 0; tries < 20; tries++) {
    const [cx, cz] = cell
    const near = [...players.values()].some((p) => Math.hypot(p.x - cellCenter(cx), p.z - cellCenter(cz)) < CELL * 5)
    if (!near) break
    cell = randomFloor()
  }
  const avgLevel = players.size
    ? [...players.values()].reduce((s, p) => s + p.level, 0) / players.size
    : 1
  const tpl = pickMonster(Math.random, Math.min(5, 2 + Math.floor(avgLevel / 2)))
  const x = cellCenter(cell[0])
  const z = cellCenter(cell[1])
  const id = randomUUID().slice(0, 8)
  monsters.set(id, {
    id,
    key: tpl.key,
    x,
    z,
    hp: tpl.hp,
    maxHp: tpl.hp,
    aggro: 0,
    homeX: x,
    homeZ: z,
    wanderX: x,
    wanderZ: z,
    lastBite: 0,
    target: null,
  })
}

for (let i = 0; i < MONSTER_COUNT; i++) spawnMonster()

const send = (ws: WebSocket, msg: ServerMsg) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}
const broadcast = (msg: ServerMsg) => {
  const data = JSON.stringify(msg)
  for (const p of players.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data)
}

function publicPlayer(p: Player): PlayerState {
  const { ws: _ws, lastShot: _s, lastMove: _m, shieldUntil: _shield, ...rest } = p
  return rest
}

function respawn(p: Player) {
  const [cx, cz] = safeSpawn()
  p.shieldUntil = performance.now() / 1000 + SPAWN_SHIELD
  p.x = cellCenter(cx)
  p.z = cellCenter(cz)
  p.hp = p.maxHp
  p.mana = p.maxMana
  p.coins = Math.floor(p.coins / 2)
  send(p.ws, { t: 'correct', x: p.x, z: p.z })
}

function damageMonster(p: Player, m: Monster, dmg: number) {
  m.hp -= dmg
  m.aggro = 1
  m.target = p.id
  events.push({ kind: 'hit', monster: m.id, dmg, by: p.id })
  if (m.hp > 0) return
  const tpl = MONSTER_BY_KEY[m.key]
  monsters.delete(m.id)
  p.coins += tpl.coins
  p.kills++
  const before = p.level
  p.maxHp += tpl.hpReward
  p.hp = Math.min(p.maxHp, p.hp + tpl.hpReward)
  p.level = levelFromMaxHp(p.maxHp)
  p.maxMana = maxManaForLevel(p.level)
  events.push({ kind: 'kill', monster: m.id, name: tpl.name, by: p.id, byName: p.name, coins: tpl.coins })
  if (p.level > before) {
    p.hp = p.maxHp
    p.mana = p.maxMana
    events.push({ kind: 'levelup', player: p.id, name: p.name, level: p.level })
  }
  setTimeout(spawnMonster, 4000 + Math.random() * 6000)
}

function handle(p: Player, msg: ClientMsg) {
  const now = performance.now() / 1000
  switch (msg.t) {
    case 'move': {
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.z) || !Number.isFinite(msg.yaw)) return
      const dt = Math.max(0.05, now - p.lastMove)
      p.lastMove = now
      const maxStep = PLAYER_SPEED * SPRINT_MULT * dt * 1.5 + 0.5
      const step = Math.hypot(msg.x - p.x, msg.z - p.z)
      if (step > maxStep || blocked(msg.x, msg.z, PLAYER_RADIUS * 0.8)) {
        send(p.ws, { t: 'correct', x: p.x, z: p.z })
        return
      }
      p.x = msg.x
      p.z = msg.z
      p.yaw = msg.yaw
      return
    }
    case 'shoot': {
      if (p.hp <= 0 || now - p.lastShot < WEAPON_COOLDOWN * 0.9) return
      p.lastShot = now
      let overload = !!msg.overload
      if (overload) {
        if (p.mana < OVERLOAD_MANA) overload = false
        else p.mana -= OVERLOAD_MANA
      }
      const len = Math.hypot(msg.dx, msg.dz) || 1
      let tx = p.x + (msg.dx / len) * WEAPON_RANGE
      let tz = p.z + (msg.dz / len) * WEAPON_RANGE
      const m = msg.target ? monsters.get(msg.target) : undefined
      if (m && Math.hypot(m.x - p.x, m.z - p.z) <= WEAPON_RANGE + 2 && canSee(p.x, p.z, m.x, m.z, MONSTER_BY_KEY[m.key].size * 0.3)) {
        tx = m.x
        tz = m.z
        const base = 4 + p.level * 3 + Math.floor(Math.random() * (3 + p.level))
        damageMonster(p, m, overload ? base * 2 : base)
      }
      events.push({ kind: 'shot', by: p.id, x: p.x, z: p.z, tx, tz, overload })
      return
    }
    case 'repair': {
      if (p.hp <= 0 || p.mana < REPAIR_MANA || p.hp >= p.maxHp) return
      p.mana -= REPAIR_MANA
      const amount = Math.ceil(p.maxHp * 0.35)
      p.hp = Math.min(p.maxHp, p.hp + amount)
      events.push({ kind: 'repair', player: p.id, amount })
      return
    }
    case 'chat': {
      const text = String(msg.text ?? '').slice(0, 160).trim()
      if (text) events.push({ kind: 'chat', name: p.name, text })
      return
    }
  }
}

function updateMonsters(dt: number, now: number) {
  const list = [...players.values()].filter((p) => p.hp > 0 && p.shieldUntil < now)
  for (const m of monsters.values()) {
    const tpl = MONSTER_BY_KEY[m.key]
    let target: Player | undefined
    let best = CELL * 4
    for (const p of list) {
      const d = Math.hypot(p.x - m.x, p.z - m.z)
      const sticky = p.id === m.target ? CELL * 2 : 0
      if (d < best + sticky && lineOfSight(m.x, m.z, p.x, p.z)) {
        best = d
        target = p
      }
    }
    m.aggro = target ? 1 : 0
    m.target = target?.id ?? null

    let gx = m.wanderX
    let gz = m.wanderZ
    let speed = tpl.speed * 0.35
    if (target) {
      gx = target.x
      gz = target.z
      speed = tpl.speed
    } else if (Math.hypot(gx - m.x, gz - m.z) < 0.5 || Math.random() < 0.004) {
      // Pick a nearby open cell to drift to.
      const cx = toCell(m.homeX) + Math.floor(Math.random() * 5) - 2
      const cz = toCell(m.homeZ) + Math.floor(Math.random() * 5) - 2
      if (!isWall(cx, cz) && lineOfSight(m.x, m.z, cellCenter(cx), cellCenter(cz))) {
        m.wanderX = cellCenter(cx)
        m.wanderZ = cellCenter(cz)
      }
    }

    const dx = gx - m.x
    const dz = gz - m.z
    const d = Math.hypot(dx, dz)
    const reach = 1.4 + tpl.size * 0.25
    if (d > (target ? reach : 0.2)) {
      const r = Math.min(0.9, tpl.size * 0.3)
      const nx = m.x + (dx / d) * speed * dt
      const nz = m.z + (dz / d) * speed * dt
      if (!blocked(nx, m.z, r)) m.x = nx
      if (!blocked(m.x, nz, r)) m.z = nz
    }

    if (target && d <= reach + 0.3 && now - m.lastBite > 1.3) {
      m.lastBite = now
      const miss = Math.random() < tpl.missChance
      const useSpecial = !!tpl.special && Math.random() < tpl.special.chance
      const dmg = miss ? 0 : attackDamage(useSpecial ? tpl.special!.attack : tpl.attack)
      target.hp -= dmg
      events.push({
        kind: 'bite',
        monster: m.id,
        player: target.id,
        dmg,
        special: useSpecial && !miss ? tpl.special!.name : null,
        miss,
      })
      if (tpl.key === 'logic_bomb' && useSpecial && !miss) {
        monsters.delete(m.id)
        setTimeout(spawnMonster, 8000)
      }
      if (target.hp <= 0) {
        events.push({ kind: 'death', player: target.id, name: target.name, killer: tpl.name })
        const victim = target
        setTimeout(() => players.has(victim.id) && respawn(victim), 3000)
      }
    }
  }
}

let last = performance.now() / 1000
let manaTimer = 0
setInterval(() => {
  const now = performance.now() / 1000
  const dt = Math.min(0.1, now - last)
  last = now
  updateMonsters(dt, now)
  manaTimer += dt
  if (manaTimer > 1.5) {
    manaTimer = 0
    for (const p of players.values()) if (p.hp > 0) p.mana = Math.min(p.maxMana, p.mana + 1)
  }
  if (!players.size) {
    events = []
    return
  }
  broadcast({
    t: 'snap',
    players: [...players.values()].map(publicPlayer),
    monsters: [...monsters.values()].map(({ id, key, x, z, hp, maxHp, aggro }) => ({ id, key, x, z, hp, maxHp, aggro })),
  })
  if (events.length) {
    broadcast({ t: 'events', list: events })
    events = []
  }
}, 1000 / TICK_RATE)

// --- HTTP: serves the built client in production, WebSocket on /ws ---
const DIST = join(import.meta.dirname, '..', 'dist')
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/health') return res.end('ok')
  let file = normalize(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname))
  if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.')
  }
})

const wss = new WebSocketServer({ server: http, path: '/ws' })
wss.on('connection', (ws) => {
  let player: Player | null = null
  ws.on('message', (raw) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!player) {
      if (msg.t !== 'join') return
      const [cx, cz] = safeSpawn()
      const name = String(msg.name ?? '').trim().slice(0, 16) || `Hacker${Math.floor(Math.random() * 900 + 100)}`
      player = {
        id: randomUUID().slice(0, 8),
        name,
        x: cellCenter(cx),
        z: cellCenter(cz),
        yaw: 0,
        hp: START_MAX_HP,
        maxHp: START_MAX_HP,
        mana: maxManaForLevel(1),
        maxMana: maxManaForLevel(1),
        level: 1,
        coins: 0,
        kills: 0,
        hue: Math.random(),
        ws,
        lastShot: 0,
        lastMove: performance.now() / 1000,
        shieldUntil: performance.now() / 1000 + SPAWN_SHIELD,
      }
      players.set(player.id, player)
      send(ws, { t: 'welcome', you: player.id, world, spawn: { x: player.x, z: player.z } })
      events.push({ kind: 'system', text: `${name} kopplade upp sig mot nätet.` })
      return
    }
    handle(player, msg)
  })
  ws.on('close', () => {
    if (!player) return
    players.delete(player.id)
    events.push({ kind: 'system', text: `${player.name} loggade ut.` })
  })
})

http.listen(PORT, () => {
  console.log(`Spacemyst server on http://localhost:${PORT} (${world.width}x${world.height} grid, ${monsters.size} monsters)`)
})
