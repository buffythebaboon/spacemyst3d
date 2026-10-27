// Spacemyst 3D server: serves the built client and runs the game over WebSocket at /ws.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { TICK_RATE } from '../shared/constants.ts'
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts'
import type { Client, Player } from './entities.ts'
import { Game } from './game.ts'
import { Store } from './store.ts'

const PORT = Number(process.env.PORT ?? 2567)
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data'))
const DEV = process.env.DEV_COMMANDS === '1'
const SEED = process.env.WORLD_SEED ? Number(process.env.WORLD_SEED) : undefined
const SAVE_EVERY = 20

const store = new Store(DATA_DIR)
const game = new Game({ store, dev: DEV, seed: SEED })

// --- Static files (the built client) --------------------------------------------------------------
const DIST = join(import.meta.dirname, '..', 'dist')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/health') return res.end('ok')
  let file = normalize(join(DIST, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)))
  if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.')
  }
})

// --- Sockets ---------------------------------------------------------------------------------------
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 })
const MSG_PER_SEC = 120

wss.on('connection', (ws) => {
  let player: Player | null = null
  let joining = false
  let budget = MSG_PER_SEC
  let budgetAt = Date.now()
  const client: Client = {
    send(msg: ServerMsg) {
      if (ws.readyState !== WebSocket.OPEN) return
      // A slow connection skips snapshots rather than building up a backlog.
      if (msg.t === 'snap' && ws.bufferedAmount > 256 * 1024) return
      ws.send(JSON.stringify(msg))
    },
    close() {
      ws.close()
    },
  }
  ws.on('message', async (data) => {
    const now = Date.now()
    budget = Math.min(MSG_PER_SEC, budget + ((now - budgetAt) / 1000) * MSG_PER_SEC)
    budgetAt = now
    if (budget < 1) return
    budget -= 1
    let msg: ClientMsg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (!player) {
      if (msg.t !== 'join' || joining) return
      joining = true
      try {
        player = await game.join(client, msg.name, msg.pass)
      } catch (err) {
        console.error('Join failed:', err)
        client.send({ t: 'denied', reason: 'The server could not log you in. Try again.' })
      } finally {
        joining = false
      }
      if (player && ws.readyState !== WebSocket.OPEN) {
        game.leave(player)
        player = null
      }
      return
    }
    try {
      game.handle(player, msg)
    } catch (err) {
      console.error('Error handling message', msg.t, err)
    }
  })
  ws.on('close', () => {
    if (player) game.leave(player)
    player = null
  })
  ws.on('error', () => ws.close())
})

// --- The loop ----------------------------------------------------------------------------------------
const DT = 1 / TICK_RATE
let last = performance.now()
let acc = 0
let sinceSave = 0
setInterval(() => {
  const now = performance.now()
  acc += Math.min(0.25, (now - last) / 1000)
  last = now
  while (acc >= DT) {
    acc -= DT
    try {
      game.step(DT)
    } catch (err) {
      console.error('Tick failed:', err)
    }
    sinceSave += DT
  }
  if (sinceSave >= SAVE_EVERY) {
    sinceSave = 0
    try {
      game.save()
    } catch (err) {
      console.error('Save failed:', err)
    }
  }
}, 1000 / TICK_RATE / 2)

function shutdown() {
  console.log('Saving and shutting down...')
  try {
    game.save()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

http.listen(PORT, () => {
  console.log(`Spacemyst 3D server on http://localhost:${PORT} (season ${game.season}, data in ${DATA_DIR}${DEV ? ', dev commands on' : ''})`)
})
