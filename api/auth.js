import { getUsers } from './_lib/redis.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  extractToken,
  requireAuth,
  safeUser,
  ensureDefaultAdmin,
} from './_lib/auth.js';

export default async function handler(req, res) {
  try {
    // Login
    if (req.method === 'POST') {
      const { emailOrLogin, password } = req.body || {};
      const input = String(emailOrLogin || '').trim().toLowerCase();
      const pwd = String(password || '').trim();
      if (!input || !pwd) return res.status(400).json({ error: 'empty_fields' });

      await ensureDefaultAdmin();
      const users = await getUsers();

      const user = users.find(u =>
        (u.email || '').toLowerCase() === input ||
        (u.login || '').toLowerCase() === input
      );
      if (!user) return res.status(404).json({ error: 'not_found' });

      if (!verifyPassword(pwd, user.salt, user.passwordHash)) {
        return res.status(401).json({ error: 'wrong_password' });
      }

      const token = await createSession(user.id);
      return res.status(200).json({ token, user: safeUser(user) });
    }

    // Get current user
    if (req.method === 'GET') {
      const ctx = await requireAuth(req, res);
      if (!ctx) return;
      return res.status(200).json({ user: safeUser(ctx.user) });
    }

    // Logout
    if (req.method === 'DELETE') {
      const token = extractToken(req);
      await destroySession(token);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/auth] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
