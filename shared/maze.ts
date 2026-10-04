// Port of the original create_world.py idea: an outer ring road around a
// biased-DFS maze with extra loops, plus a few open halls for bigger fights.

export function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateMaze(roomsX: number, roomsY: number, seed: number) {
  const rand = mulberry32(seed)
  const W = roomsX * 2 + 1
  const H = roomsY * 2 + 1
  const grid = new Array(W * H).fill(1)
  const set = (x: number, y: number, v: number) => (grid[y * W + x] = v)

  for (let x = 1; x < W - 1; x++) {
    set(x, 1, 0)
    set(x, H - 2, 0)
  }
  for (let y = 1; y < H - 1; y++) {
    set(1, y, 0)
    set(W - 2, y, 0)
  }

  const MX = roomsX - 2
  const MY = roomsY - 2
  const OFF = 2
  const visited = new Array(MX * MY).fill(false)
  const gx = (cx: number) => cx * 2 + 1 + OFF
  const stack: [number, number, number, number][] = []
  const sx = Math.floor(rand() * MX)
  const sy = Math.floor(rand() * MY)
  stack.push([sx, sy, 0, 0])
  visited[sy * MX + sx] = true
  set(gx(sx), gx(sy), 0)

  const dirs = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ]
  while (stack.length) {
    const [cx, cy, ldx, ldy] = stack[stack.length - 1]
    const opts = dirs.filter(([dx, dy]) => {
      const nx = cx + dx
      const ny = cy + dy
      return nx >= 0 && nx < MX && ny >= 0 && ny < MY && !visited[ny * MX + nx]
    })
    if (!opts.length) {
      stack.pop()
      continue
    }
    let pick = opts[Math.floor(rand() * opts.length)]
    const straight = opts.find(([dx, dy]) => dx === ldx && dy === ldy)
    if (straight && rand() < 0.6) pick = straight
    const [dx, dy] = pick
    const nx = cx + dx
    const ny = cy + dy
    set(gx(cx) + dx, gx(cy) + dy, 0)
    set(gx(nx), gx(ny), 0)
    visited[ny * MX + nx] = true
    stack.push([nx, ny, dx, dy])
  }

  // Loops and shortcuts.
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      if (grid[y * W + x] !== 1) continue
      const horiz = grid[y * W + x - 1] === 0 && grid[y * W + x + 1] === 0
      const vert = grid[(y - 1) * W + x] === 0 && grid[(y + 1) * W + x] === 0
      if ((horiz || vert) && rand() < 0.08) set(x, y, 0)
    }

  // Connect the maze to the outer ring road.
  for (let i = 0; i < 4; i++) {
    set(gx(Math.floor(rand() * MX)), 2, 0)
    set(gx(Math.floor(rand() * MX)), H - 3, 0)
    set(2, gx(Math.floor(rand() * MY)), 0)
    set(W - 3, gx(Math.floor(rand() * MY)), 0)
  }

  // Open halls.
  const halls = Math.max(3, Math.floor((roomsX * roomsY) / 60))
  for (let i = 0; i < halls; i++) {
    const hw = 3 + Math.floor(rand() * 3)
    const hh = 3 + Math.floor(rand() * 3)
    const hx = 3 + Math.floor(rand() * (W - hw - 6))
    const hy = 3 + Math.floor(rand() * (H - hh - 6))
    for (let y = hy; y < hy + hh; y++) for (let x = hx; x < hx + hw; x++) set(x, y, 0)
  }

  return { width: W, height: H, grid }
}
