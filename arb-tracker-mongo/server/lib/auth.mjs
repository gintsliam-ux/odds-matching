// Sign-in against `gutsy.app_users`, the same collection next-to-go and the
// SwiftBet desk read.
//
// The hash format must stay byte-compatible with what those apps write —
// "<16-byte hex salt>:<64-byte hex key>", scrypt with Node's defaults — or a
// password set in one app stops working in the others.
//
// Sessions are a signed cookie rather than a server-side store: the payload is
// readable by anyone holding it but cannot be forged, so nothing secret goes in.
import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ObjectId } from 'mongodb';
import { betsDb } from './betsMongo.mjs';

const scrypt = promisify(_scrypt);

/*
 * The salt is STORED hex-encoded and fed to scrypt as the bytes it encodes.
 * Passing the hex string instead derives a different key and silently fails
 * every login — the one detail that has to match the other apps exactly.
 */
const saltBytes = (hex) => Buffer.from(hex, 'hex');

const KEY_LEN = 64;
export const COOKIE = 'sod_session';

/*
 * Sliding, not absolute: every session check re-issues the cookie, so this is
 * how long you can stay AWAY before signing in again, not how long one sitting
 * lasts.
 */
const MAX_AGE_S = 60 * 60 * 24 * 30;

const secret = () => {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is not set');
  return s;
};

const b64url = (b) => b.toString('base64url');

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------- passwords */

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, saltBytes(salt), KEY_LEN);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, key] = String(stored ?? '').split(':');
  if (!salt || !key) return false;
  const derived = await scrypt(password, saltBytes(salt), KEY_LEN);
  return safeEqual(derived.toString('hex'), key);
}

/* ---------------------------------------------------------------- session */

export function signSession(u) {
  const payload = b64url(
    Buffer.from(JSON.stringify({ ...u, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S })),
  );
  const sig = b64url(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function readSession(token) {
  if (!token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(sig, b64url(createHmac('sha256', secret()).update(payload).digest()))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!d.exp || d.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: d.id, username: d.username, role: d.role };
  } catch {
    return null;
  }
}

export function cookieHeader(token) {
  const base = `${COOKIE}=${token ?? ''}; HttpOnly; SameSite=Lax; Path=/`;
  // Secure only where there is TLS to be secure over — a Secure cookie is
  // dropped on plain http, which would make local sign-in impossible.
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return token ? `${base}${secure}; Max-Age=${MAX_AGE_S}` : `${base}${secure}; Max-Age=0`;
}

export function sessionFromCookies(header) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return readSession(v.join('='));
  }
  return null;
}

/* ------------------------------------------------------------------ users */

const usersColl = async () => {
  const db = await betsDb();
  if (!db) throw new Error('bets source is not configured');
  return db.collection('app_users');
};

/** A username match that is case-insensitive but not a pattern injection. */
const byName = (name) => ({
  username: { $regex: `^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
});

const toPublic = (d) => ({
  id: String(d._id),
  username: d.username,
  role: d.role ?? 'support',
  createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
});

export async function authenticate(username, password) {
  const col = await usersColl();
  const d = await col.findOne(byName(username));
  if (!d) return null;
  if (!(await verifyPassword(password, d.passwordHash))) return null;
  return { id: String(d._id), username: d.username, role: d.role ?? 'support' };
}

export async function listUsers() {
  const col = await usersColl();
  const docs = await col.find({}, { projection: { passwordHash: 0 } }).sort({ username: 1 }).toArray();
  return docs.map(toPublic);
}

/**
 * The roles an account can hold.
 *
 * `support` is the baseline: everything the desk has. `admin` adds two things
 * and only two — user management (this file) and the pending-bets view, which
 * shows the book's own position bet by bet. `trading` SUBTRACTS instead: it
 * keeps the board, the event page, the ticker and the prices page, and loses
 * movers, settlement, late bets and the mapping tables, along with all price
 * history. The two lists live where they are enforced — ADMIN_ONLY and
 * TRADING_ALLOWED in routes.mjs — because a hidden link is not a restriction.
 *
 * This said for a long time that trading and support were equal and differed
 * only in what they said. That was true when the role was a label; it stopped
 * being true the day TRADING_ALLOWED was written, and a comment claiming two
 * roles are interchangeable is worse than none when one of them is the
 * narrower account.
 *
 * A whitelist rather than a coercion. The old `role === 'admin' ? 'admin' :
 * 'support'` quietly turned anything unrecognised into support, which is a safe
 * default but would have silently swallowed 'trading' and left no trace of why.
 */
export const ROLES = new Set(['admin', 'trading', 'support']);
const asRole = (r) => (ROLES.has(r) ? r : 'support');

export async function createUser(username, password, role) {
  const col = await usersColl();
  const name = String(username ?? '').trim();
  if (!name) throw new Error('username required');
  if (String(password ?? '').length < 8) throw new Error('password must be at least 8 characters');
  if (await col.findOne(byName(name))) throw new Error('username already taken');
  const now = new Date();
  const doc = {
    username: name,
    passwordHash: await hashPassword(password),
    role: asRole(role),
    createdAt: now,
    updatedAt: now,
  };
  const r = await col.insertOne(doc);
  return toPublic({ ...doc, _id: r.insertedId });
}

export async function updateUser(id, patch) {
  const col = await usersColl();
  const set = { updatedAt: new Date() };
  if (patch.username?.trim()) set.username = patch.username.trim();
  if (patch.role) set.role = asRole(patch.role);
  if (patch.password) {
    if (patch.password.length < 8) throw new Error('password must be at least 8 characters');
    set.passwordHash = await hashPassword(patch.password);
  }
  const d = await col.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: set },
    { returnDocument: 'after', projection: { passwordHash: 0 } },
  );
  if (!d) throw new Error('user not found');
  return toPublic(d);
}

export async function deleteUser(id, actingUserId) {
  if (String(id) === String(actingUserId)) throw new Error('you cannot delete your own account');
  const col = await usersColl();
  const target = await col.findOne({ _id: new ObjectId(id) });
  if (!target) throw new Error('user not found');
  // This collection is shared with the other desks — never leave it adminless.
  if (target.role === 'admin' && (await col.countDocuments({ role: 'admin' })) <= 1) {
    throw new Error('cannot delete the last admin');
  }
  await col.deleteOne({ _id: new ObjectId(id) });
}

/* ---------------------------------------------------------------- handoff */

/*
 * Arriving already signed in from the Margin Comparison dashboard, which uses
 * the same accounts but sits on another vercel.app host, so it can't share
 * our cookie. It sends a ticket instead (margin-dashboard/lib/handoff.ts):
 * "<b64url JSON {u, aud, exp, n}>.<b64url HMAC-SHA256 of 'sso.v1.' + payload>"
 * under SSO_SECRET, the same value on both projects. A ticket lives 60 seconds
 * and works once: its id is recorded in sso_used_tickets (a TTL index clears
 * them), so a copied link can't be replayed.
 */
let ticketsIndexed = null;

export async function verifyHandoff(token) {
  const key = process.env.SSO_SECRET;
  if (!key || !token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = b64url(createHmac('sha256', key).update(`sso.v1.${payload}`).digest());
  if (!safeEqual(sig, expected)) return null;
  let d;
  try { d = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (d.aud !== 'sports-odds-desk' || !d.u || !d.n || !(d.exp >= Math.floor(Date.now() / 1000))) return null;

  const db = await betsDb();
  if (!db) return null;
  const used = db.collection('sso_used_tickets');
  ticketsIndexed ??= used.createIndex({ at: 1 }, { expireAfterSeconds: 600 }).catch((e) => { ticketsIndexed = null; throw e; });
  await ticketsIndexed;
  try {
    await used.insertOne({ _id: String(d.n), at: new Date() });
  } catch (e) {
    if (e?.code === 11000) return null; // already used
    throw e;
  }
  // the account must still exist; take its current role from the collection
  const u = await (await usersColl()).findOne(byName(d.u), { projection: { username: 1, role: 1 } });
  return u ? { id: String(u._id), username: u.username, role: u.role ?? 'support' } : null;
}
