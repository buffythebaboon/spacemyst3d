// The WebSocket connection to the game server.
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts'

let ws: WebSocket | null = null
let onMessage: (msg: ServerMsg) => void = () => {}
let onClose: (reason: string) => void = () => {}

export function connect(name: string, pass: string, handlers: { message: (msg: ServerMsg) => void; close: (reason: string) => void }) {
  onMessage = handlers.message
  onClose = handlers.close
  disconnect()
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const sock = new WebSocket(url)
  ws = sock
  let opened = false
  sock.onopen = () => {
    opened = true
    sock.send(JSON.stringify({ t: 'join', name, pass } satisfies ClientMsg))
  }
  sock.onmessage = (e) => {
    if (sock !== ws) return
    let msg: ServerMsg
    try {
      msg = JSON.parse(String(e.data)) as ServerMsg
    } catch {
      return
    }
    onMessage(msg)
  }
  sock.onclose = () => {
    if (sock !== ws) return
    ws = null
    onClose(opened ? 'The connection to the server was lost.' : 'Could not reach the game server. Is it running?')
  }
}

export function disconnect() {
  if (!ws) return
  const old = ws
  ws = null
  old.onclose = null
  old.close()
}

export function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export const connected = () => ws?.readyState === WebSocket.OPEN
