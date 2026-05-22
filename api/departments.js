import { requireAuth } from './_lib/auth.js';
import { getDepartments, setDepartments } from './_lib/rbac.js';

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;

    if (req.method === 'GET') {
      const depts = await getDepartments();
      return res.status(200).json({ departments: depts });
    }

    if (req.method === 'PUT') {
      // Update department catalog (admin/director)
      const body = req.body || {};
      if (!body.departments || typeof body.departments !== 'object') {
        return res.status(400).json({ error: 'missing_departments' });
      }
      await setDepartments(body.departments);
      return res.status(200).json({ ok: true, departments: body.departments });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/departments] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
