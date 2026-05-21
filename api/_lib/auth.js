import crypto from 'node:crypto';
import { redis, getUsers, setUsers } from './redis.js';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/* ---------- Password hashing (PBKDF2) ---------- */
export function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}
export function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
}
export function verifyPassword(password, salt, expectedHash) {
  const actual = hashPassword(password, salt);
  // timingSafeEqual to prevent timing attacks
  try {
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/* ---------- IDs and tokens ---------- */
export function generateUserId() {
  return 'U-' + Date.now().toString(36).slice(-4).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}
export function generateBranchId() {
  return 'IP-' + Date.now().toString(36).slice(-4).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}
export function generateRecordId() {
  return 'L-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex');
}
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ---------- Sessions ---------- */
export async function createSession(userId) {
  const token = generateSessionToken();
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  await redis.set(`session:${token}`, JSON.stringify({ userId, exp }), { ex: SESSION_TTL_SECONDS });
  return token;
}
export async function destroySession(token) {
  if (!token) return;
  await redis.del(`session:${token}`);
}
export async function getSession(token) {
  if (!token) return null;
  const raw = await redis.get(`session:${token}`);
  if (!raw) return null;
  const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!s.exp || s.exp < Date.now()) {
    await redis.del(`session:${token}`);
    return null;
  }
  return s;
}

/* ---------- Request helpers ---------- */
export function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

export async function requireAuth(req, res) {
  const token = extractToken(req);
  const session = await getSession(token);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  const users = await getUsers();
  const user = users.find(u => u.id === session.userId);
  if (!user) {
    await destroySession(token);
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return { user, token };
}

export function requireManager(authCtx, res) {
  if (!authCtx) return false;
  if (authCtx.user.role !== 'manager') {
    res.status(403).json({ error: 'forbidden', message: 'manager_role_required' });
    return false;
  }
  return true;
}

/* ---------- Safe user (strip secrets) ---------- */
export function safeUser(u) {
  if (!u) return u;
  const { passwordHash, salt, ...rest } = u;
  return rest;
}

/* ---------- Bootstrap: ensure default admin exists ---------- */
const DEFAULT_ADMIN = {
  id: 'U-IPOST',
  fullName: 'iPost Administrator',
  phone: '+998 93 002 29 49',
  email: 'ipost@ipost.uz',
  login: 'ipost',
  role: 'manager',
  createdAt: 0,
};
const DEFAULT_ADMIN_PASSWORD = '2026';

export async function ensureDefaultAdmin() {
  const users = await getUsers();
  const idx = users.findIndex(u => (u.login || '').toLowerCase() === 'ipost');
  if (idx === -1) {
    const salt = generateSalt();
    users.unshift({
      ...DEFAULT_ADMIN,
      createdAt: Date.now(),
      salt,
      passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD, salt),
    });
    await setUsers(users);
    return users[0];
  }
  // Ensure password is correct and role is manager (self-heal)
  const u = users[idx];
  let changed = false;
  if (u.role !== 'manager') { u.role = 'manager'; changed = true; }
  if (u.phone !== DEFAULT_ADMIN.phone) { u.phone = DEFAULT_ADMIN.phone; changed = true; }
  if (!u.salt || !u.passwordHash || !verifyPassword(DEFAULT_ADMIN_PASSWORD, u.salt, u.passwordHash)) {
    const salt = generateSalt();
    u.salt = salt;
    u.passwordHash = hashPassword(DEFAULT_ADMIN_PASSWORD, salt);
    changed = true;
  }
  if (changed) {
    users[idx] = u;
    await setUsers(users);
  }
  return u;
}
