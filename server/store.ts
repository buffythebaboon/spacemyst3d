// Accounts, saved characters and the world's season state, kept in JSON files under data/.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CharacterData } from '../shared/character.ts'
import type { WorldState } from '../shared/world.ts'

interface Account {
  name: string
  salt: string
  hash: string
  char: CharacterData
  updated: number
}

export interface SavedWorld {
  season: number
  seed: number
  state: WorldState
  identified: string[]
}

const hashPassword = (pass: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pass, salt, 32, (err, key) => (err ? reject(err) : resolve(key))))

export const accountKey = (name: string) => name.trim().toLowerCase()

export class Store {
  private accounts: Record<string, Account> = {}
  private dirty = false
  private readonly accountsFile: string
  private readonly worldFile: string

  /** `dir` null keeps everything in memory (tests). */
  constructor(private readonly dir: string | null) {
    this.accountsFile = dir ? join(dir, 'accounts.json') : ''
    this.worldFile = dir ? join(dir, 'world.json') : ''
    if (dir) {
      mkdirSync(dir, { recursive: true })
      if (existsSync(this.accountsFile)) {
        try {
          this.accounts = JSON.parse(readFileSync(this.accountsFile, 'utf8'))
        } catch (err) {
          console.error('Could not read accounts.json, starting empty:', err)
        }
      }
    }
  }

  hasAccount(name: string) {
    return !!this.accounts[accountKey(name)]
  }

  /** Logs in, or creates the account if the name is free. Returns the saved character (or null for a new account). */
  async login(name: string, pass: string): Promise<{ ok: true; char: CharacterData | null; created: boolean } | { ok: false; reason: string }> {
    const key = accountKey(name)
    const acc = this.accounts[key]
    if (!acc) {
      if (pass.length < 4) return { ok: false, reason: 'Pick a password of at least 4 characters to create an account.' }
      const salt = randomBytes(16).toString('hex')
      const hash = (await hashPassword(pass, salt)).toString('hex')
      this.accounts[key] = { name: name.trim(), salt, hash, char: null as unknown as CharacterData, updated: Date.now() }
      this.dirty = true
      return { ok: true, char: null, created: true }
    }
    const hash = await hashPassword(pass, acc.salt)
    const expected = Buffer.from(acc.hash, 'hex')
    if (expected.length !== hash.length || !timingSafeEqual(expected, hash)) return { ok: false, reason: 'Wrong password for that name.' }
    return { ok: true, char: acc.char ?? null, created: false }
  }

  saveCharacter(key: string, char: CharacterData) {
    const acc = this.accounts[key]
    if (!acc) return
    acc.char = JSON.parse(JSON.stringify(char))
    acc.updated = Date.now()
    this.dirty = true
  }

  loadWorld(): SavedWorld | null {
    if (!this.dir || !existsSync(this.worldFile)) return null
    try {
      return JSON.parse(readFileSync(this.worldFile, 'utf8'))
    } catch (err) {
      console.error('Could not read world.json, starting a new season:', err)
      return null
    }
  }

  saveWorld(world: SavedWorld) {
    if (!this.dir) return
    this.writeAtomic(this.worldFile, JSON.stringify(world))
  }

  /** Writes accounts to disk if anything changed. */
  flush() {
    if (!this.dir || !this.dirty) return
    this.writeAtomic(this.accountsFile, JSON.stringify(this.accounts))
    this.dirty = false
  }

  private writeAtomic(file: string, data: string) {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  }
}
