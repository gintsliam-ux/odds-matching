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
    role: role === 'admin' ? 'admin' : 'support',
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
  if (patch.role) set.role = patch.role === 'admin' ? 'admin' : 'support';
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
