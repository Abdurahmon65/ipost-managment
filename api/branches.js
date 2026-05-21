import { getBranches, setBranches, appendRecord, redis } from './_lib/redis.js';
import {
  generateBranchId,
  generateRecordId,
  requireAuth,
  requireManager,
  isDirector,
} from './_lib/auth.js';

// Check if a given branch is "locked" by an active director plan for the current/future month.
async function getLockedPlanForBranch(branchId) {
  try {
    const raw = await redis.get('data:plans');
    const plans = !raw ? [] : (typeof raw === 'string' ? JSON.parse(raw) : raw);
    const today = new Date();
    const ym = today.toISOString().slice(0, 7); // 'YYYY-MM'
    // A plan locks the branch if month >= current month
    return plans.find(p => p.branchId === branchId && p.locked === true && (p.month || '') >= ym) || null;
  } catch { return null; }
}

function logEntry(eventKey, user, branch, extra = '') {
  return {
    id: generateRecordId(),
    when: Date.now(),
    eventKey,
    targetId: branch.id,
    targetName: branch.name,
    who: user.fullName + ' (' + user.role + ')',
    details: (branch.marking || '') + (extra ? ' · ' + extra : ''),
  };
}

function sanitizeBranchInput(body) {
  return {
    marking: String(body.marking || '').trim(),
    regionKey: String(body.regionKey || '').trim(),
    name: String(body.name || '').trim(),
    manager: String(body.manager || '').trim(),
    phone1: String(body.phone1 || '').trim(),
    phone2: String(body.phone2 || '').trim(),
    address: String(body.address || '').trim(),
    landmark: String(body.landmark || '').trim(),
    lat: body.lat == null || body.lat === '' ? null : Number(body.lat),
    lng: body.lng == null || body.lng === '' ? null : Number(body.lng),
    openDate: String(body.openDate || '').trim(),
    closeDate: String(body.closeDate || '').trim(),
    rent: Boolean(body.rent),
    bank: {
      account: String(body.bank?.account || '').trim(),
      mfo: String(body.bank?.mfo || '').trim(),
      inn: String(body.bank?.inn || '').trim(),
      card: String(body.bank?.card || '').trim(),
    },
    passport: body.passport || null,
    locPhoto: body.locPhoto || null,
    banner: body.banner || null,
    contract: body.contract || null,
    contractName: String(body.contractName || '').trim(),
    yattPhoto: body.yattPhoto || null,
  };
}

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    const me = ctx.user;
    const isManager = me.role === 'manager';

    // LIST  (manager + operator)
    if (req.method === 'GET') {
      const branches = await getBranches();
      return res.status(200).json({ branches });
    }

    // CREATE  (manager + operator)
    if (req.method === 'POST') {
      // Batch import support
      if (Array.isArray(req.body?.batch)) {
        if (!isManager) {
          return res.status(403).json({ error: 'forbidden', message: 'manager_role_required' });
        }
        const branches = await getBranches();
        const added = [];
        const seenIds = new Set(branches.map(b => b.id));
        for (const item of req.body.batch) {
          const data = sanitizeBranchInput(item);
          if (!data.marking || !data.name || !data.manager || !data.regionKey) continue;
          let id = String(item.id || '').trim();
          if (id) {
            // Validate; skip the row if format is bad or duplicate
            if (!/^[A-Za-zА-Яа-я0-9_\-]{1,40}$/.test(id) || seenIds.has(id)) {
              id = generateBranchId();
            }
          } else {
            id = generateBranchId();
          }
          seenIds.add(id);
          const branch = { id, ...data };
          branches.unshift(branch);
          added.push(branch);
          await appendRecord(logEntry('ev_added', me, branch, 'Excel import'));
        }
        await setBranches(branches);
        return res.status(200).json({ added: added.length, branches: added });
      }

      const data = sanitizeBranchInput(req.body || {});
      if (!data.marking || !data.name || !data.manager || !data.regionKey || !data.openDate) {
        return res.status(400).json({ error: 'missing_fields' });
      }
      const branches = await getBranches();
      // Accept user-provided ID or auto-generate
      let id = String(req.body?.id || '').trim();
      if (id) {
        // Validate format: letters / digits / hyphen / underscore, 1-40 chars
        if (!/^[A-Za-zА-Яа-я0-9_\-]{1,40}$/.test(id)) {
          return res.status(400).json({ error: 'invalid_id' });
        }
        if (branches.find(b => b.id === id)) {
          return res.status(409).json({ error: 'id_taken' });
        }
      } else {
        id = generateBranchId();
      }
      const branch = { id, ...data };
      branches.unshift(branch);
      await setBranches(branches);
      await appendRecord(logEntry('ev_added', me, branch));
      return res.status(200).json({ branch });
    }

    // UPDATE  (manager + operator can edit, but status-toggle reserved for manager)
    if (req.method === 'PUT') {
      const { id, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const branches = await getBranches();
      const idx = branches.findIndex(b => b.id === id);
      if (idx === -1) return res.status(404).json({ error: 'not_found' });

      // PLAN LOCK CHECK — locked plans block all edits on this platform.
      // Plans can only be unlocked from the director suite (ipost-managment).
      const lockedPlan = await getLockedPlanForBranch(id);
      if (lockedPlan) {
        return res.status(423).json({
          error: 'plan_locked',
          message: 'Филиал заблокирован планом на месяц ' + lockedPlan.month + '. Снять блокировку можно только из директорского центра (ipost-managment).',
          plan: { id: lockedPlan.id, month: lockedPlan.month, approvedBy: lockedPlan.approvedBy, approvedAt: lockedPlan.approvedAt },
        });
      }

      // Status toggle: manager only
      if (action === 'toggleStatus') {
        if (!isManager && !isDirector(me)) {
          return res.status(403).json({ error: 'forbidden', message: 'manager_role_required' });
        }
        const current = branches[idx];
        const today = new Date().toISOString().slice(0, 10);
        const willClose = !current.closeDate;
        current.closeDate = willClose ? today : '';
        branches[idx] = current;
        await setBranches(branches);
        await appendRecord(logEntry(willClose ? 'ev_closed' : 'ev_reopened', me, current));
        return res.status(200).json({ branch: current });
      }

      const data = sanitizeBranchInput(req.body || {});
      const merged = { ...branches[idx], ...data, id };
      branches[idx] = merged;
      await setBranches(branches);
      await appendRecord(logEntry('ev_updated', me, merged));
      return res.status(200).json({ branch: merged });
    }

    // DELETE  (manager only; director can override plan-lock)
    if (req.method === 'DELETE') {
      if (!isManager && !isDirector(me)) {
        return res.status(403).json({ error: 'forbidden', message: 'manager_role_required' });
      }
      const { id, all } = req.body || {};

      // Clear all — director only (mass delete + plan lock would be massive)
      if (all === true) {
        if (!isDirector(me)) {
          return res.status(403).json({ error: 'forbidden', message: 'director_role_required_for_bulk_delete' });
        }
        const old = await getBranches();
        await setBranches([]);
        await appendRecord({
          id: generateRecordId(),
          when: Date.now(),
          eventKey: 'ev_cleared',
          targetId: '',
          targetName: '',
          who: me.fullName + ' (' + me.role + ')',
          details: 'Cleared ' + old.length + ' branches',
        });
        return res.status(200).json({ ok: true, deleted: old.length });
      }

      if (!id) return res.status(400).json({ error: 'missing_id' });
      const branches = await getBranches();
      const target = branches.find(b => b.id === id);
      if (!target) return res.status(404).json({ error: 'not_found' });

      // PLAN LOCK CHECK
      const lockedPlan = await getLockedPlanForBranch(id);
      if (lockedPlan) {
        return res.status(423).json({
          error: 'plan_locked',
          message: 'Филиал заблокирован планом на месяц ' + lockedPlan.month + '. Снять блокировку можно только из директорского центра (ipost-managment).',
          plan: { id: lockedPlan.id, month: lockedPlan.month, approvedBy: lockedPlan.approvedBy },
        });
      }

      const next = branches.filter(b => b.id !== id);
      await setBranches(next);
      await appendRecord(logEntry('ev_deleted', me, target));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/branches] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
