// POST /api/auth — sign in/out, read the session, and manage users.
//
// One endpoint rather than several because every api/*.ts here is
// self-contained (no shared imports), and splitting auth across files would
// mean duplicating the cookie signing and the scrypt verify in each one.
// Dispatch is on `action`.
//
//   { action: 'login',  username, password }  → { user }        + Set-Cookie
//   { action: 'logout' }                      → { ok: true }    + cleared cookie
//   { action: 'me' }                          → { user | null }
//   { action: 'prefs',  prefs: {…} }          → { user }        (own prefs only)
//   { action: 'users' }                       → { users: [] }   (admin)
//   { action: 'create-user', username, password, role }         (admin)
//   { action: 'update-user', id, username?, password?, role? }  (admin)
//   { action: 'delete-user', id }                               (admin)
//
// USERS LIVE IN gutsy.app_users, which the SwiftBet app also uses. Same people,
// same passwords, one place to manage them — but it does mean a change made
// here changes their SwiftBet login too. The stored shape is
//   { username, passwordHash: "<salt-hex>:<scrypt-hex>", role, createdAt, updatedAt }
// with scrypt(password, Buffer.from(saltHex,'hex'), 64) — verified against the
// live `admin` row before this was written, so existing credentials keep working
// and anything created here logs into SwiftBet as well.
//
// Env: MONGO_URI, MONGO_DB (default "gutsy"), AUTH_SECRET.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient, ObjectId } from 'mongodb'

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const USERS_COLL = process.env.MONGO_USERS_COLL ?? 'app_users'
const AUTH_SECRET = process.env.AUTH_SECRET

const COOKIE = 'lf_session'
/** Long enough that a terminal left open all day doesn't sign you out. */
const SESSION_DAYS = 30

let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

export interface UserPrefs {
  /** Silence the notification chime. */
  muteSound?: boolean
  /** Stop alert toasts appearing over the board (the Notifications page still lists them). */
  hideToasts?: boolean
}

interface UserDoc {
  _id: ObjectId | string
  username: string
  passwordHash: string
  role?: string
  prefs?: UserPrefs
  createdAt?: string
  updatedAt?: string
}

/**
 * Support is the role that exists to watch alerts, so alerts stay on for it.
 *
 * Enforced here rather than just seeded, because a default drifts: one person
 * mutes the chime during a meeting, never turns it back on, and the alert the
 * role exists to catch goes unheard. Applied on read as well as on write, so a
 * row edited directly in Mongo still behaves.
 */
function effectivePrefs(u: UserDoc): UserPrefs {
  const prefs = u.prefs ?? {}
  if ((u.role ?? 'user') === 'support') return { ...prefs, muteSound: false, hideToasts: false }
  return prefs
}

/** True when the role cannot change its own notification switches. */
export function alertsLocked(role: string | undefined): boolean {
  return (role ?? 'user') === 'support'
}

/** What the client is allowed to see. Never the hash. */
function publicUser(u: UserDoc) {
  return {
    id: String(u._id),
    username: u.username,
    role: u.role ?? 'user',
    prefs: effectivePrefs(u),
    alertsLocked: alertsLocked(u.role),
    createdAt: u.createdAt ?? null,
    updatedAt: u.updatedAt ?? null,
  }
}

// --- password ---------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = String(stored ?? '').split(':')
  if (!saltHex || !hashHex) return false
  // The salt is stored hex-encoded and must be hashed as BYTES — passing the
  // hex string itself produces a different key and every login fails.
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

// --- session cookie ---------------------------------------------------------
//
// `<payload-b64url>.<hmac>` where payload is { id, username, role, exp }. Signed
// rather than stored: there is no session table to keep, and a tampered cookie
// fails the HMAC. httpOnly so page scripts cannot read it.

function sign(payload: string): string {
  if (!AUTH_SECRET) throw new Error('AUTH_SECRET not set')
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
}

function makeToken(u: UserDoc): string {
  const body = Buffer.from(
    JSON.stringify({
      id: String(u._id),
      username: u.username,
      role: u.role ?? 'user',
      exp: Date.now() + SESSION_DAYS * 86_400_000,
    }),
  ).toString('base64url')
  return `${body}.${sign(body)}`
}

function readToken(token: string | undefined): { id: string; username: string; role: string } | null {
  if (!token) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = sign(body)
  // Compare as buffers of equal length; a length mismatch is already a failure.
  if (mac.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!p?.id || typeof p.exp !== 'number' || p.exp < Date.now()) return null
    return { id: String(p.id), username: String(p.username), role: String(p.role ?? 'user') }
  } catch {
    return null
  }
}

function cookieHeader(value: string, maxAgeSec: number): string {
  // Secure is omitted on localhost, where the dev server is plain http and the
  // browser would silently drop the cookie.
  const secure = process.env.VERCEL ? '; Secure' : ''
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`
}

function cookieFrom(req: VercelRequest): string | undefined {
  const fromParsed = (req.cookies as Record<string, string> | undefined)?.[COOKIE]
  if (fromParsed) return fromParsed
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

// --- handler ----------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    if (!AUTH_SECRET) {
      res.status(500).json({ error: 'AUTH_SECRET not configured' })
      return
    }
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) ?? {}
    const action = String(body.action ?? '')
    const client = await getClient()
    const users = client.db(MONGO_DB).collection<UserDoc>(USERS_COLL)
    const session = readToken(cookieFrom(req))

    // --- login ---
    if (action === 'login') {
      const username = String(body.username ?? '').trim()
      const password = String(body.password ?? '')
      if (!username || !password) {
        res.status(400).json({ error: 'Username and password are required' })
        return
      }
      // Case-insensitive on the username, exact on the password.
      const doc = await users.findOne({
        username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      })
      // Same message and the same work either way, so a wrong username and a
      // wrong password are indistinguishable from outside.
      if (!doc || !(await verifyPassword(password, doc.passwordHash))) {
        res.status(401).json({ error: 'Incorrect username or password' })
        return
      }
      res.setHeader('Set-Cookie', cookieHeader(makeToken(doc), SESSION_DAYS * 86_400))
      res.status(200).json({ user: publicUser(doc) })
      return
    }

    // --- logout ---
    if (action === 'logout') {
      res.setHeader('Set-Cookie', cookieHeader('', 0))
      res.status(200).json({ ok: true })
      return
    }

    // --- me ---
    if (action === 'me') {
      if (!session) {
        res.status(200).json({ user: null })
        return
      }
      // Re-read the row so a role change or a deletion takes effect without
      // waiting for the cookie to expire.
      const doc = await users.findOne({ _id: toId(session.id) })
      res.status(200).json({ user: doc ? publicUser(doc) : null })
      return
    }

    if (!session) {
      res.status(401).json({ error: 'Not signed in' })
      return
    }

    // --- own preferences ---
    if (action === 'prefs') {
      const self = await users.findOne({ _id: toId(session.id) })
      if (!self) {
        res.status(401).json({ error: 'Not signed in' })
        return
      }
      if (alertsLocked(self.role)) {
        res.status(403).json({ error: 'Support accounts always have alerts on' })
        return
      }
      const prefs: UserPrefs = {
        muteSound: !!body?.prefs?.muteSound,
        hideToasts: !!body?.prefs?.hideToasts,
      }
      await users.updateOne(
        { _id: toId(session.id) },
        { $set: { prefs, updatedAt: new Date().toISOString() } },
      )
      const doc = await users.findOne({ _id: toId(session.id) })
      res.status(200).json({ user: doc ? publicUser(doc) : null })
      return
    }

    // --- everything below is admin-only ---
    const me = await users.findOne({ _id: toId(session.id) })
    if (!me || (me.role ?? 'user') !== 'admin') {
      res.status(403).json({ error: 'Admins only' })
      return
    }

    if (action === 'users') {
      const all = await users.find({}, { projection: { passwordHash: 0 } }).sort({ username: 1 }).toArray()
      res.status(200).json({ users: all.map((u) => publicUser(u as UserDoc)) })
      return
    }

    if (action === 'create-user') {
      const username = String(body.username ?? '').trim()
      const password = String(body.password ?? '')
      if (!username || password.length < 6) {
        res.status(400).json({ error: 'Username required, password at least 6 characters' })
        return
      }
      const clash = await users.findOne({
        username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      })
      if (clash) {
        res.status(409).json({ error: `"${username}" already exists` })
        return
      }
      const now = new Date().toISOString()
      const doc: Omit<UserDoc, '_id'> = {
        username,
        passwordHash: await hashPassword(password),
        role: String(body.role ?? 'user'),
        prefs: {},
        createdAt: now,
        updatedAt: now,
      }
      const r = await users.insertOne(doc as UserDoc)
      res.status(200).json({ user: publicUser({ ...doc, _id: r.insertedId } as UserDoc) })
      return
    }

    if (action === 'update-user') {
      const id = String(body.id ?? '')
      if (!id) {
        res.status(400).json({ error: 'id required' })
        return
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
      if (typeof body.username === 'string' && body.username.trim()) set.username = body.username.trim()
      if (typeof body.role === 'string' && body.role.trim()) set.role = body.role.trim()
      if (typeof body.password === 'string' && body.password) {
        if (body.password.length < 6) {
          res.status(400).json({ error: 'Password must be at least 6 characters' })
          return
        }
        set.passwordHash = await hashPassword(body.password)
      }
      // Don't let the last admin demote themselves into a terminal nobody can
      // administer.
      if (set.role && set.role !== 'admin' && String(me._id) === id) {
        const admins = await users.countDocuments({ role: 'admin' })
        if (admins <= 1) {
          res.status(400).json({ error: 'You are the only admin — promote someone else first' })
          return
        }
      }
      await users.updateOne({ _id: toId(id) }, { $set: set })
      const doc = await users.findOne({ _id: toId(id) })
      res.status(200).json({ user: doc ? publicUser(doc) : null })
      return
    }

    if (action === 'delete-user') {
      const id = String(body.id ?? '')
      if (!id) {
        res.status(400).json({ error: 'id required' })
        return
      }
      if (String(me._id) === id) {
        res.status(400).json({ error: 'You cannot delete the account you are signed in as' })
        return
      }
      await users.deleteOne({ _id: toId(id) })
      res.status(200).json({ ok: true })
      return
    }

    res.status(400).json({ error: `Unknown action "${action}"` })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

/** app_users holds a mix of ObjectId and string _ids (the seeded rows are
 *  strings), so an id has to be tried both ways. */
function toId(id: string): ObjectId | string {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : id
}
