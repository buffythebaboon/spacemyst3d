// Drives the authoritative game simulation directly, without sockets.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as ai from '../server/ai.ts'
import { hitMonster, killMonster, monsterRadius } from '../server/combat.ts'
import type { Monster, Player } from '../server/entities.ts'
import { Game } from '../server/game.ts'
import { Store } from '../server/store.ts'
import * as worldstate from '../server/worldstate.ts'
import { PLAYER_RADIUS, cellCenter, toCell } from '../shared/constants.ts'
import { Mode } from '../shared/grid.ts'
import { makeGrenade, makePotion } from '../shared/items.ts'
import type { GameEvent, ServerMsg } from '../shared/protocol.ts'
import { mulberry32 } from '../shared/rng.ts'
import { SPELLS } from '../shared/spells.ts'
import { FAKE, FLOOR, traceBeam } from '../shared/world.ts'
import { buildWorld, validateWorld } from '../shared/worldgen.ts'

const SEED = 20261004

function makeGame(seed = SEED, store = new Store(null)) {
  return new Game({ store, seed, dev: true, rand: mulberry32(seed) })
}

async function bot(g: Game, name: string, pass = '') {
  const inbox: ServerMsg[] = []
  const p = await g.join({ send: (m) => inbox.push(m) }, name, pass)
  assert.ok(p, `join failed: ${JSON.stringify(inbox[0])}`)
  return { p: p!, inbox }
}

function run(g: Game, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 20); i++) g.step(0.05)
}

const eventsOf = (inbox: ServerMsg[]) => inbox.flatMap((m) => (m.t === 'events' ? m.list : [])) as GameEvent[]

/** A straight north-south run of plain floor in a sector, free of traps, hubs and arenas. */
function corridor(g: Game, len: number, sector = 0) {
  const W = g.world.width
  const traps = new Set(g.world.objects.filter((o) => o.kind === 'laser' || o.kind === 'electric' || o.kind === 'turret').map((o) => o.z * W + o.x))
  for (let z = 1; z < g.world.height - len - 1; z++)
    for (let x = 1; x < W - 1; x++) {
      let ok = true
      for (let k = 0; k <= len && ok; k++) {
        const i = (z + k) * W + x
        if (g.world.cells[i] !== FLOOR || g.grid.hubAt[i] || g.grid.arenaAt[i] || g.world.sector[i] !== sector || traps.has(i)) ok = false
      }
      if (ok) return { x: cellCenter(x), north: cellCenter(z), south: cellCenter(z + len) }
    }
  throw new Error('no corridor found')
}

function clearAround(g: Game, x: number, z: number, r = 45) {
  for (const m of [...g.monsters.values()]) if (Math.hypot(m.x - x, m.z - z) < r && !m.boss) g.monsters.delete(m.id)
}

/** Puts a player at the south end of a corridor looking north, with a monster at the north end. */
function duel(g: Game, p: Player, key: string, len = 4) {
  const c = corridor(g, len)
  clearAround(g, c.x, (c.north + c.south) / 2)
  p.x = c.x
  p.z = c.south
  p.yaw = 0
  p.pitch = 0
  const m = ai.spawnMonster(g, key, c.x, c.north, { sector: 0, level: 1, elite: null })
  return { c, m }
}

const north = { dx: 0, dy: 0, dz: -1 }

test('every generated world is valid and fully connected', () => {
  for (let s = 0; s < 8; s++) {
    const { info } = buildWorld(SEED + s * 101, 1)
    assert.deepEqual(validateWorld(info), [], `seed ${SEED + s * 101}`)
    const kinds = new Set(info.puzzles.map((p) => p.kind))
    assert.equal(kinds.size, 4, 'all four puzzle kinds appear')
  }
})

test('players join in the first hub and clients never see puzzle answers', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Ada')
  const welcome = inbox.find((m) => m.t === 'welcome')
  assert.ok(welcome && welcome.t === 'welcome')
  assert.equal(welcome.guest, true)
  for (const pz of welcome.world.puzzles) {
    assert.equal(pz.code, undefined)
    assert.equal(pz.order, undefined)
  }
  run(g, 0.2)
  assert.equal(p.hub, 0)
  assert.ok(inbox.some((m) => m.t === 'snap'))
})

test('a laser kills a monster and pays XP and credits', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Shooter')
  const { m } = duel(g, p, 'byte_mite')
  const credits = p.char.credits
  for (let i = 0; i < 40 && !m.dead; i++) {
    g.handle(p, { t: 'fire', ...north })
    run(g, 0.25)
  }
  assert.ok(m.dead, 'monster died')
  const ev = eventsOf(inbox)
  assert.ok(ev.some((e) => e.kind === 'kill' && e.m === m.id))
  assert.ok(p.char.xp > 0)
  run(g, 1)
  assert.ok(p.char.credits > credits || [...g.loot.values()].some((l) => l.owner === p.id))
})

test('monsters telegraph and land melee attacks on a player in reach', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Bait')
  const c = corridor(g, 4)
  clearAround(g, c.x, c.south)
  p.x = c.x
  p.z = c.south
  p.shieldUntil = 0
  ai.spawnMonster(g, 'junk_scuttler', c.x, c.south - 1.5, { sector: 0, level: 1, elite: null })
  const hp = p.hp
  run(g, 4)
  const ev = eventsOf(inbox)
  assert.ok(ev.some((e) => e.kind === 'windup'), 'attack is telegraphed')
  assert.ok(p.hp < hp || p.dead, 'player got hurt')
})

test('a melee swarm stops at arm\'s length instead of crawling inside the player', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Swarmed')
  const c = corridor(g, 5)
  clearAround(g, c.x, c.south)
  p.x = c.x
  p.z = c.south
  p.shieldUntil = 0
  const mites = [0, 1, 2].map((i) => ai.spawnMonster(g, 'byte_mite', c.x + (i - 1) * 0.4, c.south - 8, { sector: 0, level: 1, elite: null }))
  const hp = p.hp
  let closest = Infinity
  for (let i = 0; i < 60 && !p.dead; i++) {
    g.step(0.05)
    for (const m of mites) if (!m.dead) closest = Math.min(closest, Math.hypot(m.x - p.x, m.z - p.z) - monsterRadius(m) - PLAYER_RADIUS)
  }
  assert.ok(closest > -0.05, `a mite got ${(-closest).toFixed(2)} m inside the player`)
  assert.ok(p.hp < hp || p.dead, 'the mites still land their bites')
})

test('every spell can be cast and does what it says', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Mage')
  p.char.level = 30
  p.char.talents = { hk_ping: 1, hk_hijack: 1, en_honeypot: 1, en_daemon: 1 }
  p.charDirty = true
  run(g, 0.1)
  for (const spell of SPELLS) {
    const { m } = duel(g, p, 'junk_scuttler', 4)
    if (spell.id === 'hijack') m.hp = m.maxHp * 0.3
    // Self-centred spells need the monster close by.
    if (spell.id === 'system_snooze') m.z = p.z - 3
    const other = spell.id === 'system_shock' ? ai.spawnMonster(g, 'byte_mite', m.x + 1.5, m.z, { sector: 0, level: 1, elite: null }) : null
    p.char.spells[0] = spell.id
    p.mana = p.stats.maxMana
    p.spellReady = {}
    const x0 = p.z
    g.handle(p, { t: 'cast', slot: 0, ...north })
    assert.ok(p.mana < p.stats.maxMana, `${spell.id} spent mana`)
    switch (spell.id) {
      case 'overload':
        assert.ok(m.hp < m.maxHp || m.dead)
        break
      case 'repair':
        assert.ok(p.heals.length > 0)
        break
      case 'glitch_step':
        assert.ok(p.z < x0 - 2, 'teleported forward')
        break
      case 'system_shock':
        assert.ok(m.hp < m.maxHp || m.dead)
        assert.ok(other!.hp < other!.maxHp || other!.dead, 'the bolt jumped')
        break
      case 'lullaby':
      case 'system_snooze':
        assert.ok(m.statuses.has('asleep'))
        break
      case 'stasis_field':
        assert.ok(m.statuses.has('frozen'))
        break
      case 'firewall':
      case 'honeypot':
      case 'daemon':
        assert.ok([...g.zones.values()].some((z) => z.kind === spell.id && z.owner === p.id))
        break
      case 'data_leech':
        assert.ok(p.leech && p.leech.m === m.id)
        break
      case 'ping':
        assert.ok(p.statuses.has('scanner'))
        break
      case 'hijack':
        assert.equal(m.allyOf, p.id)
        break
    }
    run(g, 0.5)
    for (const z of [...g.zones.values()]) g.zones.delete(z.id)
    p.leech = null
  }
})

test('drinking an unknown potion identifies it for everyone', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Taster')
  const other = await bot(g, 'Watcher')
  assert.ok(!g.identified.has('overclock'))
  p.char.inventory[5] = makePotion('overclock', 1)
  g.handle(p, { t: 'inv', op: 'use', from: 5 })
  assert.ok(g.identified.has('overclock'))
  assert.ok(p.statuses.has('haste'))
  run(g, 0.1)
  assert.ok(eventsOf(other.inbox).some((e) => e.kind === 'identify' && e.base === 'overclock'))
  assert.ok(inbox.some((m) => m.t === 'state' && m.identified.includes('overclock')))
})

test('a thrown vial of acid leaves a pool that eats monsters', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Chemist')
  const { m } = duel(g, p, 'junk_scuttler', 3)
  statusFreeze(m)
  p.char.inventory[6] = makePotion('acid', 1)
  g.handle(p, { t: 'throw', from: 6, dx: 0, dy: -0.15, dz: -1 })
  run(g, 1.2)
  const pool = [...g.zones.values()].find((z) => z.kind === 'acid')
  assert.ok(pool, 'acid pool exists')
  m.x = pool!.x
  m.z = pool!.z
  const hp = m.hp
  run(g, 1.5)
  assert.ok(m.hp < hp || m.dead)
})

function statusFreeze(m: Monster) {
  m.statuses.set('rooted', { until: 1e9, power: 0 })
}

test('grenades bounce, burn their fuse and stun machines', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Grenadier')
  const { m } = duel(g, p, 'junk_scuttler', 2)
  statusFreeze(m)
  p.char.inventory[7] = makeGrenade('emp', 1)
  p.char.grenade = 'emp'
  g.handle(p, { t: 'grenade', dx: 0, dy: -0.1, dz: -1 })
  assert.equal(g.projectiles.size > 0, true)
  run(g, 1.6)
  assert.ok(eventsOf(inbox).some((e) => e.kind === 'explode' && e.what === 'emp'))
  assert.ok(m.statuses.has('stunned') || m.dead)
})

test('the four puzzle kinds open their vaults', async () => {
  const g = makeGame()
  const a = await bot(g, 'Solver')
  const b = await bot(g, 'Helper')
  const p = a.p
  const at = (who: Player, x: number, z: number) => {
    who.x = cellCenter(x)
    who.z = cellCenter(z)
  }
  const { solutions } = buildWorld(g.seed, g.season)
  for (const pz of g.world.puzzles) {
    const objs = g.world.objects.filter((o) => o.puzzle === pz.id)
    if (pz.kind === 'cipher') {
      const panel = objs.find((o) => o.kind === 'cipher')!
      at(p, panel.x, panel.z)
      const code = pz.code!
      const wrong = ((code[0] + 1) % 6) + code[1] * 6 + code[2] * 36 + code[3] * 216
      g.handle(p, { t: 'interact', obj: panel.id, arg: wrong })
      assert.ok(!g.state.solved.includes(pz.id), 'wrong code is refused')
      g.time += 2
      g.handle(p, { t: 'interact', obj: panel.id, arg: code[0] + code[1] * 6 + code[2] * 36 + code[3] * 216 })
    } else if (pz.kind === 'relay') {
      for (const c of pz.order!) {
        const relay = objs.find((o) => o.kind === 'relay' && o.color === c)!
        at(p, relay.x, relay.z)
        g.handle(p, { t: 'interact', obj: relay.id })
      }
    } else if (pz.kind === 'mirror') {
      const sol = solutions[pz.id]
      for (const o of objs.filter((x) => x.kind === 'mirror')) {
        if ((g.state.mirrors[o.id] ?? 0) === sol[o.id]) continue
        at(p, o.x, o.z)
        g.handle(p, { t: 'interact', obj: o.id })
      }
      const mirrorAt = (x: number, z: number) => {
        const o = objs.find((m) => m.kind === 'mirror' && m.x === x && m.z === z)
        return o ? g.state.mirrors[o.id] : undefined
      }
      assert.ok(traceBeam(pz.lab!, mirrorAt).solved)
    } else if (pz.kind === 'plates') {
      const [p1, p2] = objs.filter((o) => o.kind === 'plate')
      at(p, p1.x, p1.z)
      at(b.p, p2.x, p2.z)
      run(g, 0.1)
    }
    assert.ok(g.state.solved.includes(pz.id), `${pz.kind} puzzle solved`)
    assert.ok(g.state.vaults.includes(pz.vault), `${pz.kind} vault open`)
  }
  run(g, 0.1)
  const vault = g.vaults.get(g.world.puzzles[0].vault)!
  assert.equal(g.grid.solid(toCell(cellCenter(vault.x)), toCell(cellCenter(vault.z)), Mode.Player), false)
})

test('fake walls give way when touched and count as a secret', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Explorer')
  const W = g.world.width
  const fake = g.world.fakes[0]
  const fx = fake.cell % W
  const fz = Math.floor(fake.cell / W)
  // Stand on the open side of the fake wall (not inside the secret room).
  let spot: [number, number] | null = null
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const x = fx + dx
    const z = fz + dz
    const inside = x >= fake.x0 && x <= fake.x1 && z >= fake.z0 && z <= fake.z1
    if (!inside && g.world.cells[z * W + x] === FLOOR) spot = [x, z]
  }
  assert.ok(spot)
  p.x = cellCenter(spot![0])
  p.z = cellCenter(spot![1])
  assert.equal(g.world.cells[fake.cell], FAKE)
  g.handle(p, { t: 'touch', cell: fake.cell })
  assert.ok(g.state.fakes.includes(fake.cell))
  assert.equal(p.char.counters.secrets, 1)
})

test('purging a sector opens its gates', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Purger')
  worldstate.reduceCorruption(g, 0, 1e6, [p])
  run(g, 0.1)
  const gates = g.world.gates.filter((gt) => gt.sector === 0)
  for (const gt of gates) {
    assert.ok(g.state.gates.includes(gt.cell))
    assert.equal(g.grid.solid(gt.x, gt.z, Mode.Player), false)
  }
  assert.ok(p.char.achievements.includes('spotless'))
  assert.ok(eventsOf(inbox).some((e) => e.kind === 'gate'))
})

test('a sector boss drops keycards that open its vault', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Slayer')
  const boss = [...g.monsters.values()].find((m) => m.boss && m.arena === 'arena0')!
  assert.ok(boss, 'Trojan Goliath is in its arena')
  hitMonster(g, boss, p, 1, { type: 'laser' })
  killMonster(g, boss, p)
  assert.equal(g.state.bosses.arena0.alive, false)
  const card = [...g.loot.values()].find((l) => l.owner === p.id && l.item?.kind === 'keycard')
  assert.ok(card, 'keycard dropped')
  p.x = card!.x
  p.z = card!.z
  run(g, 0.1)
  assert.ok(p.char.inventory.some((it) => it?.kind === 'keycard'))
  const vault = g.world.vaults.find((v) => v.lock === 'keycard' && v.sector === 0)!
  // Stand next to the vault door.
  const W = g.world.width
  const vx = vault.cell % W
  const vz = Math.floor(vault.cell / W)
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const x = vx + dx
    const z = vz + dz
    const inside = x >= vault.x0 && x <= vault.x1 && z >= vault.z0 && z <= vault.z1
    if (!inside && g.world.cells[z * W + x] === FLOOR) {
      p.x = cellCenter(x)
      p.z = cellCenter(z)
    }
  }
  g.handle(p, { t: 'interact', obj: vault.id })
  assert.ok(g.state.vaults.includes(vault.id))
  assert.ok(!p.char.inventory.some((it) => it?.kind === 'keycard'), 'keycard used up')
})

test('the Mainframe falls, the countdown runs and a new season begins', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Hero')
  const mf = [...g.monsters.values()].find((m) => m.def.key === 'mainframe')!
  assert.ok(mf)
  killMonster(g, mf, p)
  assert.ok(g.state.seasonEndsAt !== undefined)
  run(g, 61)
  assert.equal(g.season, 2)
  assert.ok(p.char.achievements.includes('season'))
  assert.ok(inbox.some((m) => m.t === 'world'))
  assert.equal(g.state.seasonEndsAt, undefined)
  assert.ok(g.monsters.size > 50, 'the new maze is populated')
})

test('the Mainframe raises shield nodes and is immune until they fall', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Raider')
  const mf = [...g.monsters.values()].find((m) => m.def.key === 'mainframe')!
  p.x = mf.x
  p.z = mf.z + 12
  p.shieldUntil = 0
  mf.hp = mf.maxHp * 0.6
  run(g, 0.5)
  const nodes = [...g.monsters.values()].filter((m) => m.def.behaviour === 'node')
  assert.equal(nodes.length, 4)
  const hp = mf.hp
  hitMonster(g, mf, p, 500, { type: 'laser' })
  assert.equal(mf.hp, hp, 'immune while nodes stand')
  for (const n of nodes) killMonster(g, n, p)
  hitMonster(g, mf, p, 500, { type: 'laser' })
  assert.ok(mf.hp < hp)
})

test('accounts keep their character and refuse wrong passwords', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spacemyst-'))
  try {
    const g1 = makeGame(SEED, new Store(dir))
    const { p } = await bot(g1, 'Keeper', 'hunter22')
    p.char.credits = 4321
    g1.leave(p)
    g1.save()
    const g2 = makeGame(SEED, new Store(dir))
    const wrong: ServerMsg[] = []
    assert.equal(await g2.join({ send: (m) => wrong.push(m) }, 'Keeper', 'nope'), null)
    assert.equal(wrong[0].t, 'denied')
    const guest: ServerMsg[] = []
    assert.equal(await g2.join({ send: (m) => guest.push(m) }, 'keeper', ''), null, 'guests cannot take an account name')
    const back = await bot(g2, 'Keeper', 'hunter22')
    assert.equal(back.p.char.credits, 4321)
    assert.equal(g2.season, g1.season)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the black market buys and sells', async () => {
  const g = makeGame()
  const { p, inbox } = await bot(g, 'Trader')
  run(g, 0.1)
  const shop = g.world.objects.find((o) => o.kind === 'shop' && o.hub === 'hub0')!
  p.x = cellCenter(shop.x) + 1.5
  p.z = cellCenter(shop.z) + 1.5
  g.handle(p, { t: 'interact', obj: shop.id })
  const stock = inbox.find((m) => m.t === 'shop')
  assert.ok(stock && stock.t === 'shop' && stock.stock.length >= 6)
  p.char.credits = 1000
  const before = p.char.inventory.filter(Boolean).length
  g.handle(p, { t: 'shop', op: 'buy', id: 'potion:repair_m' })
  assert.ok(p.char.credits < 1000)
  const slot = p.char.inventory.findIndex((it) => it?.base === 'repair_m')
  assert.ok(slot >= 0)
  assert.ok(p.char.inventory.filter(Boolean).length >= before)
  const credits = p.char.credits
  g.handle(p, { t: 'shop', op: 'sell', from: slot })
  assert.ok(p.char.credits > credits)
})

test('quests from the board complete and pay out', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Quester')
  run(g, 0.1)
  const board = g.world.objects.find((o) => o.kind === 'board' && o.hub === 'hub0')!
  p.x = cellCenter(board.x)
  p.z = cellCenter(board.z) + 1.5
  g.handle(p, { t: 'interact', obj: board.id })
  const offers = p.board.hub0.offers
  assert.equal(offers.length, 3)
  const q = offers[0]
  q.kind = 'purge'
  q.goal = 2
  q.sector = 0
  g.handle(p, { t: 'quest', op: 'accept', id: q.id })
  assert.equal(p.char.quests.length, 1)
  const credits = p.char.credits
  for (let i = 0; i < 2; i++) {
    const m = ai.spawnMonster(g, 'byte_mite', p.x, p.z, { sector: 0, level: 1, elite: null })
    killMonster(g, m, p)
  }
  assert.equal(p.char.quests.length, 0)
  assert.ok(p.char.credits >= credits + q.credits)
})

test('dying leaves a data dump with half the credits, and walking over it returns them', async () => {
  const g = makeGame()
  const { p } = await bot(g, 'Unlucky')
  p.char.credits = 200
  const c = corridor(g, 3)
  p.x = c.x
  p.z = c.south
  p.shieldUntil = 0
  p.hp = 1
  const m = ai.spawnMonster(g, 'byte_mite', c.x, c.north, { sector: 0, level: 1, elite: null })
  hitMonster(g, m, null, 0, { type: 'laser' })
  const dumpX = p.x
  const dumpZ = p.z
  // Hurt the player directly so the test does not depend on monster timing.
  const { hurtPlayer } = await import('../server/combat.ts')
  hurtPlayer(g, p, 10, 'pure', { name: 'test', x: p.x, z: p.z })
  assert.ok(p.dead)
  assert.equal(p.char.credits, 100)
  run(g, 4.5)
  assert.ok(!p.dead, 'respawned')
  p.x = dumpX
  p.z = dumpZ
  run(g, 0.1)
  assert.equal(p.char.counters.dumps, 1)
  assert.ok(p.char.achievements.includes('dump'))
  // 100 back from the dump plus 150 for the Data Recovery achievement.
  assert.equal(p.char.credits, 350)
})

test('three bots fighting for five minutes keep the server stable and fast', async () => {
  const g = makeGame(SEED + 7)
  const bots = await Promise.all(['Alpha', 'Bravo', 'Charlie'].map((n) => bot(g, n)))
  const rand = mulberry32(99)
  for (const { p } of bots) {
    p.char.level = 12
    p.char.talents = { hk_ping: 1, hk_hijack: 1, en_honeypot: 1, en_daemon: 1 }
    p.char.spells = ['system_shock', 'stasis_field', 'firewall', 'daemon']
    p.charDirty = true
    for (let i = 0; i < 4; i++) p.char.inventory[10 + i] = makePotion(['acid', 'toxic', 'repair_m', 'scanner'][i], 5)
    p.char.inventory[14] = makeGrenade('glitch', 5)
  }
  const ticks: number[] = []
  for (let t = 0; t < 20 * 300; t++) {
    for (const { p } of bots) {
      if (p.dead) continue
      if (rand() < 0.05) p.yaw += (rand() - 0.5) * 2
      const step = 0.32
      const res = g.grid.slide(p.x, p.z, -Math.sin(p.yaw) * step, -Math.cos(p.yaw) * step, 0.44, Mode.Player)
      if (res.hitX || res.hitZ) p.yaw += Math.PI / 2
      g.handle(p, { t: 'move', x: res.x, z: res.z, yaw: p.yaw, pitch: 0, dash: rand() < 0.01 })
      const aim = { dx: -Math.sin(p.yaw), dy: 0, dz: -Math.cos(p.yaw) }
      const r = rand()
      if (r < 0.3) g.handle(p, { t: 'fire', ...aim })
      else if (r < 0.33) g.handle(p, { t: 'cast', slot: Math.floor(rand() * 4), ...aim })
      else if (r < 0.335) g.handle(p, { t: 'use', slot: Math.floor(rand() * 4), ...aim })
      else if (r < 0.337) g.handle(p, { t: 'throw', from: 10 + Math.floor(rand() * 2), ...aim })
      else if (r < 0.338) g.handle(p, { t: 'grenade', ...aim })
      else if (r < 0.339) g.handle(p, { t: 'swap' })
    }
    const a = performance.now()
    g.step(0.05)
    ticks.push(performance.now() - a)
  }
  ticks.sort((a, b) => a - b)
  const p95 = ticks[Math.floor(ticks.length * 0.95)]
  assert.ok(p95 < 15, `p95 tick ${p95.toFixed(2)} ms`)
  assert.ok(bots.every(({ inbox }) => inbox.some((m) => m.t === 'snap')))
})
