// /api/plans — Director-controlled monthly plans for PVZ branches.
//
// Plans are stored in Redis (Upstash) under key `data:plans`.
// Plans are LOCKED: once approved by director, they cannot be deleted or
// modified by anyone except a request bearing a director session token.
// Even a manager (admin of the PVZ platform) cannot change a locked plan.

import { redis } from './_lib/redis.js';
import { requireAuth, generateRecordId } from './_lib/auth.js';

const K_PLANS  = 'data:plans';
const K_RECORDS= 'data:records';

async function getPlans() {
  const raw = await redis.get(K_PLANS);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function setPlans(plans) {
  await redis.set(K_PLANS, JSON.stringify(plans));
}
async function appendRecord(rec) {
  const raw = await redis.get(K_RECORDS);
  const records = !raw ? [] : (typeof raw === 'string' ? JSON.parse(raw) : raw);
  records.unshift(rec);
  await redis.set(K_RECORDS, JSON.stringify(records.slice(0, 500)));
}

function isDirector(user) {
  return user && (user.role === 'director' || user.login === 'director');
}

function sanitizePlan(body) {
  return {
    branchId:  String(body.branchId || '').trim(),
    month:     String(body.month || '').trim(),   // 'YYYY-MM'
    targets: {
      orders:        Number(body.targets?.orders)        || 0,
      revenue:       Number(body.targets?.revenue)       || 0,   // UZS
      deliveries:    Number(body.targets?.deliveries)    || 0,
      newCustomers:  Number(body.targets?.newCustomers)  || 0,
      avgRating:     Number(body.targets?.avgRating)     || 0,
    },
    notes:     String(body.notes || '').trim().slice(0, 2000),
  };
}

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    const me = ctx.user;
    const director = isDirector(me);

    // GET: list all plans (everyone authenticated can read)
    if (req.method === 'GET') {
      const plans = await getPlans();
      return res.status(200).json({ plans, canEdit: director });
    }

    // POST: approve & create plan(s) — director only
    if (req.method === 'POST') {
      if (!director) {
        return res.status(403).json({ error: 'forbidden', message: 'director_role_required' });
      }
      // Bulk approve
      if (Array.isArray(req.body?.batch)) {
        const plans = await getPlans();
        const added = [];
        for (const item of req.body.batch) {
          const data = sanitizePlan(item);
          if (!data.branchId || !data.month) continue;
          // Replace existing plan for same branch+month
          const idx = plans.findIndex(p => p.branchId === data.branchId && p.month === data.month);
          const plan = {
            id: 'plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
            ...data,
            approvedBy: me.login || me.id,
            approvedAt: Date.now(),
            locked: true,
            version: 1,
          };
          if (idx >= 0) {
            plan.version = (plans[idx].version || 1) + 1;
            plan.id = plans[idx].id;
            plans[idx] = plan;
          } else {
            plans.unshift(plan);
          }
          added.push(plan);
        }
        await setPlans(plans);
        await appendRecord({
          id: generateRecordId(),
          when: Date.now(),
          eventKey: 'ev_plans_approved',
          targetId: '',
          targetName: 'Bulk approval (' + added.length + ' plans)',
          who: (me.fullName || me.login) + ' (director)',
          details: 'Locked plans for month ' + (added[0]?.month || ''),
        });
        return res.status(200).json({ added: added.length, plans: added, canEdit: true });
      }

      // Single plan
      const data = sanitizePlan(req.body || {});
      if (!data.branchId || !data.month) {
        return res.status(400).json({ error: 'missing_fields', message: 'branchId and month required' });
      }
      const plans = await getPlans();
      const idx = plans.findIndex(p => p.branchId === data.branchId && p.month === data.month);
      const plan = {
        id: 'plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        ...data,
        approvedBy: me.login || me.id,
        approvedAt: Date.now(),
        locked: true,
        version: 1,
      };
      if (idx >= 0) {
        plan.version = (plans[idx].version || 1) + 1;
        plan.id = plans[idx].id;
        plans[idx] = plan;
      } else {
        plans.unshift(plan);
      }
      await setPlans(plans);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_plan_approved',
        targetId: plan.branchId,
        targetName: 'Plan ' + plan.month + ' for ' + plan.branchId,
        who: (me.fullName || me.login) + ' (director)',
        details: 'Targets: orders=' + plan.targets.orders + ', revenue=' + plan.targets.revenue,
      });
      return res.status(200).json({ plan, canEdit: true });
    }

    // PUT: update plan — director only (even when locked)
    if (req.method === 'PUT') {
      if (!director) {
        return res.status(403).json({ error: 'forbidden', message: 'director_role_required_to_modify' });
      }
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const plans = await getPlans();
      const idx = plans.findIndex(p => p.id === id);
      if (idx === -1) return res.status(404).json({ error: 'not_found' });
      const data = sanitizePlan(req.body || {});
      const updated = {
        ...plans[idx],
        ...data,
        version: (plans[idx].version || 1) + 1,
        approvedBy: me.login || me.id,
        approvedAt: Date.now(),
        locked: true,
      };
      plans[idx] = updated;
      await setPlans(plans);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_plan_updated',
        targetId: updated.branchId,
        targetName: 'Plan ' + updated.month + ' (v' + updated.version + ')',
        who: (me.fullName || me.login) + ' (director)',
        details: '',
      });
      return res.status(200).json({ plan: updated });
    }

    // DELETE: remove plan — director only
    if (req.method === 'DELETE') {
      if (!director) {
        return res.status(403).json({ error: 'forbidden', message: 'director_role_required_to_delete' });
      }
      const { id, all } = req.body || {};
      if (all === true) {
        const old = await getPlans();
        await setPlans([]);
        await appendRecord({
          id: generateRecordId(),
          when: Date.now(),
          eventKey: 'ev_plans_cleared',
          targetId: '',
          targetName: '',
          who: (me.fullName || me.login) + ' (director)',
          details: 'Cleared ' + old.length + ' plans',
        });
        return res.status(200).json({ ok: true, deleted: old.length });
      }
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const plans = await getPlans();
      const target = plans.find(p => p.id === id);
      if (!target) return res.status(404).json({ error: 'not_found' });
      const next = plans.filter(p => p.id !== id);
      await setPlans(next);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_plan_deleted',
        targetId: target.branchId,
        targetName: 'Plan ' + target.month,
        who: (me.fullName || me.login) + ' (director)',
        details: '',
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/plans] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
