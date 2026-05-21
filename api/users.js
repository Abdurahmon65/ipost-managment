import { getUsers, setUsers, appendRecord } from './_lib/redis.js';
import {
  generateSalt,
  hashPassword,
  generateUserId,
  generateRecordId,
  requireAuth,
  requireManager,
  safeUser,
} from './_lib/auth.js';

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    if (!requireManager(ctx, res)) return;

    const me = ctx.user;

    // LIST
    if (req.method === 'GET') {
      const users = await getUsers();
      return res.status(200).json({ users: users.map(safeUser) });
    }

    // CREATE
    if (req.method === 'POST') {
      const { fullName, phone, email, login, password, role } = req.body || {};
      if (!fullName || !phone || !email || !login || !password || !role) {
        return res.status(400).json({ error: 'missing_fields' });
      }
      const emailLower = String(email).trim().toLowerCase();
      const loginLower = String(login).trim().toLowerCase();
      const users = await getUsers();
      if (users.find(u => (u.email || '').toLowerCase() === emailLower)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      if (users.find(u => (u.login || '').toLowerCase() === loginLower)) {
        return res.status(409).json({ error: 'login_taken' });
      }
      const salt = generateSalt();
      const newUser = {
        id: generateUserId(),
        fullName: String(fullName).trim(),
        phone: String(phone).trim(),
        email: emailLower,
        login: loginLower,
        salt,
        passwordHash: hashPassword(password, salt),
        role: role === 'manager' ? 'manager' : 'operator',
        createdAt: Date.now(),
      };
      users.unshift(newUser);
      await setUsers(users);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_user_added',
        targetId: newUser.id,
        targetName: newUser.fullName,
        who: me.fullName + ' (' + me.role + ')',
        details: newUser.login + ' · ' + newUser.role,
      });
      return res.status(200).json({ user: safeUser(newUser) });
    }

    // UPDATE
    if (req.method === 'PUT') {
      const { id, fullName, phone, email, login, password, role } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const users = await getUsers();
      const idx = users.findIndex(u => u.id === id);
      if (idx === -1) return res.status(404).json({ error: 'not_found' });

      const target = { ...users[idx] };
      const emailLower = email != null ? String(email).trim().toLowerCase() : null;
      const loginLower = login != null ? String(login).trim().toLowerCase() : null;
      if (emailLower && users.find(u => u.id !== id && (u.email || '').toLowerCase() === emailLower)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      if (loginLower && users.find(u => u.id !== id && (u.login || '').toLowerCase() === loginLower)) {
        return res.status(409).json({ error: 'login_taken' });
      }

      if (fullName != null) target.fullName = String(fullName).trim();
      if (phone != null) target.phone = String(phone).trim();
      if (emailLower) target.email = emailLower;
      if (loginLower) target.login = loginLower;
      if (role) target.role = role === 'manager' ? 'manager' : 'operator';
      if (password) {
        // Allow changing own password regardless; allow changing others only as manager (already enforced)
        const salt = generateSalt();
        target.salt = salt;
        target.passwordHash = hashPassword(password, salt);
      }

      users[idx] = target;
      await setUsers(users);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_user_updated',
        targetId: target.id,
        targetName: target.fullName,
        who: me.fullName + ' (' + me.role + ')',
        details: target.login + ' · ' + target.role,
      });
      return res.status(200).json({ user: safeUser(target) });
    }

    // DELETE
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing_id' });
      if (id === me.id) return res.status(400).json({ error: 'cannot_delete_self' });
      if (id === 'U-IPOST') return res.status(400).json({ error: 'cannot_delete_admin' });

      const users = await getUsers();
      const target = users.find(u => u.id === id);
      if (!target) return res.status(404).json({ error: 'not_found' });
      const next = users.filter(u => u.id !== id);
      await setUsers(next);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_user_deleted',
        targetId: target.id,
        targetName: target.fullName,
        who: me.fullName + ' (' + me.role + ')',
        details: target.login,
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/users] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
