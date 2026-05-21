import { getRecords, setRecords } from './_lib/redis.js';
import { requireAuth, requireManager } from './_lib/auth.js';

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;

    if (req.method === 'GET') {
      const records = await getRecords();
      return res.status(200).json({ records });
    }

    if (req.method === 'DELETE') {
      // Clear logs — manager only
      if (!requireManager(ctx, res)) return;
      await setRecords([]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/records] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
