// /api/bonuses — Bonuses and penalties tracking for employees.
//
// GET    — list bonuses (optionally ?employeeId=xxx&month=2026-05)
// POST   — create bonus / penalty (manager+ allowed)
// DELETE — revoke bonus (director only)
//
// Stored in Redis key `data:bonuses` as an array.

import { redis } from './_lib/redis.js';
import { requireAuth, generateRecordId, isDirector } from './_lib/auth.js';

const K_BONUSES = 'data:bonuses';
const K_RECORDS = 'data:records';

async function getBonuses() {
  const raw = await redis.get(K_BONUSES);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function setBonuses(arr) {
  await redis.set(K_BONUSES, JSON.stringify(arr));
}
async function appendRecord(rec) {
  try {
    const raw = await redis.get(K_RECORDS);
    const records = !raw ? [] : (typeof raw === 'string' ? JSON.parse(raw) : raw);
    records.unshift(rec);
    await redis.set(K_RECORDS, JSON.stringify(records.slice(0, 500)));
  } catch {}
}

function sanitize(body) {
  return {
    employeeId:    String(body.employeeId || '').trim(),
    employeeName:  String(body.employeeName || '').trim(),
    employeeType:  ['courier','manager','user','staff'].includes(body.employeeType) ? body.employeeType : 'staff',
    type:          body.type === 'penalty' ? 'penalty' : 'bonus',
    amount:        Math.abs(Number(body.amount) || 0),
    reason:        String(body.reason || '').trim().slice(0, 500),
    month:         String(body.month || new Date().toISOString().slice(0, 7)),
  };
}

function nextMonthLabel() {
  return new Date().toISOString().slice(0, 7);
}

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    const me = ctx.user;

    // LIST
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const employeeId = url.searchParams.get('employeeId');
      const month      = url.searchParams.get('month');
      let bonuses = await getBonuses();
      if (employeeId) bonuses = bonuses.filter(b => b.employeeId === employeeId);
      if (month)      bonuses = bonuses.filter(b => b.month === month);
      // Aggregates
      const totals = bonuses.reduce((acc, b) => {
        if (b.type === 'bonus')   acc.bonusTotal   += b.amount;
        if (b.type === 'penalty') acc.penaltyTotal += b.amount;
        return acc;
      }, { bonusTotal: 0, penaltyTotal: 0 });
      totals.net = totals.bonusTotal - totals.penaltyTotal;
      return res.status(200).json({ bonuses, totals, count: bonuses.length });
    }

    // POST — create (any logged-in user of director suite)
    if (req.method === 'POST') {
      const data = sanitize(req.body || {});
      if (!data.employeeId || !data.employeeName) {
        return res.status(400).json({ error: 'missing_fields', message: 'employeeId и employeeName обязательны' });
      }
      if (data.amount <= 0) {
        return res.status(400).json({ error: 'invalid_amount', message: 'Сумма должна быть больше 0' });
      }
      const bonus = {
        id: 'bns_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        ...data,
        createdBy: me.login || me.id,
        createdByName: me.fullName || me.login,
        createdAt: Date.now(),
        revoked: false,
      };
      const list = await getBonuses();
      list.unshift(bonus);
      await setBonuses(list);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: data.type === 'bonus' ? 'ev_bonus_added' : 'ev_penalty_added',
        targetId: data.employeeId,
        targetName: data.employeeName,
        who: (me.fullName || me.login),
        details: `${data.type === 'bonus' ? '+' : '−'}${data.amount} UZS · ${data.reason || ''}`,
      });
      return res.status(200).json({ bonus });
    }

    // DELETE — revoke (director only, by id; also supports {all:true} as full reset for director)
    if (req.method === 'DELETE') {
      const { id, all } = req.body || {};
      if (all === true) {
        if (!isDirector(me)) {
          return res.status(403).json({ error: 'forbidden', message: 'director_role_required_for_bulk_delete' });
        }
        const old = await getBonuses();
        await setBonuses([]);
        await appendRecord({
          id: generateRecordId(),
          when: Date.now(),
          eventKey: 'ev_bonuses_cleared',
          targetId: '',
          targetName: '',
          who: (me.fullName || me.login) + ' (director)',
          details: 'Cleared ' + old.length + ' bonuses',
        });
        return res.status(200).json({ ok: true, deleted: old.length });
      }
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const list = await getBonuses();
      const target = list.find(b => b.id === id);
      if (!target) return res.status(404).json({ error: 'not_found' });
      // Only director may revoke an existing bonus (cannot edit history)
      if (!isDirector(me)) {
        // Allow self-revoke within 5 minutes (mistake correction)
        if (target.createdBy !== (me.login || me.id) || (Date.now() - target.createdAt) > 5 * 60 * 1000) {
          return res.status(403).json({ error: 'forbidden', message: 'Отменить чужой или старый бонус может только директор' });
        }
      }
      const next = list.filter(b => b.id !== id);
      await setBonuses(next);
      await appendRecord({
        id: generateRecordId(),
        when: Date.now(),
        eventKey: 'ev_bonus_revoked',
        targetId: target.employeeId,
        targetName: target.employeeName,
        who: (me.fullName || me.login),
        details: `Отменён ${target.type === 'bonus' ? 'бонус' : 'штраф'} ${target.amount} UZS`,
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[api/bonuses] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
