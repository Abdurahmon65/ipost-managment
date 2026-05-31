// /api/shuttles-rc — Учёт шатлов и РЦ (Distribution Centers).
//
// Single endpoint, four resources via ?type= :
//   ?type=shuttle  — GET/POST/PUT/DELETE — список шатлов
//   ?type=rc       — GET/POST/PUT/DELETE — список распределительных центров
//   ?type=tariff   — GET/POST            — матрица тарифов вилоят × услуга × партнёр
//   ?type=record   — GET/POST/DELETE     — записи (дата, вилоят, услуга, кг, выручка)
//
// Полностью изолирован от данных курьерской и dispatch.
// Хранится в Redis под собственными ключами:
//   data:src:shuttles, data:src:rc, data:src:tariffs, data:src:tariff_records

import { redis } from './_lib/redis.js';
import { requireAuth, generateRecordId, isDirector } from './_lib/auth.js';

const K_SHUTTLES = 'data:src:shuttles';
const K_RC       = 'data:src:rc';
const K_TARIFFS  = 'data:src:tariffs';
const K_RECORDS  = 'data:src:tariff_records';
const K_AUDIT    = 'data:records'; // shared audit log

const SERVICES = ['IPOST', 'KG', 'EMU', 'BTS', 'SHUTTLE'];
const PARTNERS = ['IJARA', 'HAMKOR'];

const REGIONS = [
  { key: 'tashkent',        name: 'Ташкент'         },
  { key: 'tashkent_region', name: 'Ташкентская обл.'},
  { key: 'samarkand',       name: 'Самарканд'       },
  { key: 'bukhara',         name: 'Бухара'          },
  { key: 'fergana',         name: 'Фергана'         },
  { key: 'andijan',         name: 'Андижан'         },
  { key: 'namangan',        name: 'Наманган'        },
  { key: 'qashqadaryo',     name: 'Кашкадарья'      },
  { key: 'surxondaryo',     name: 'Сурхандарья'     },
  { key: 'navoiy',          name: 'Навои'           },
  { key: 'jizzax',          name: 'Джизак'          },
  { key: 'sirdaryo',        name: 'Сырдарья'        },
  { key: 'xorazm',          name: 'Хорезм'          },
  { key: 'karakalpak',      name: 'Каракалпакстан'  },
];

async function loadList(key) {
  const raw = await redis.get(key);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveList(key, list) {
  await redis.set(key, JSON.stringify(list));
}
async function loadObj(key) {
  const raw = await redis.get(key);
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveObj(key, obj) {
  await redis.set(key, JSON.stringify(obj));
}

async function audit(rec) {
  try {
    const raw = await redis.get(K_AUDIT);
    const records = !raw ? [] : (typeof raw === 'string' ? JSON.parse(raw) : raw);
    records.unshift(rec);
    await redis.set(K_AUDIT, JSON.stringify(records.slice(0, 500)));
  } catch {}
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ============== SHUTTLES ============== */
function sanitizeShuttle(b) {
  return {
    code:         String(b.code || '').trim().slice(0, 32),
    plate:        String(b.plate || '').trim().slice(0, 32),
    regionKey:    String(b.regionKey || '').trim(),
    capacityKg:   Math.max(0, Number(b.capacityKg) || 0),
    driver:       String(b.driver || '').trim().slice(0, 80),
    driverPhone:  String(b.driverPhone || '').trim().slice(0, 32),
    status:       ['active','maintenance','off','on_route'].includes(b.status) ? b.status : 'active',
    notes:        String(b.notes || '').trim().slice(0, 500),
  };
}
async function handleShuttle(req, res, me) {
  if (req.method === 'GET') {
    const list = await loadList(K_SHUTTLES);
    return res.status(200).json({ shuttles: list, count: list.length });
  }
  if (req.method === 'POST') {
    const data = sanitizeShuttle(req.body || {});
    if (!data.code || !data.regionKey) {
      return res.status(400).json({ error: 'missing_fields', message: 'code и regionKey обязательны' });
    }
    const list = await loadList(K_SHUTTLES);
    const item = {
      id: genId('sh'),
      ...data,
      createdBy: me.login || me.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.unshift(item);
    await saveList(K_SHUTTLES, list);
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_shuttle_added', targetId: item.id, targetName: item.code,
      who: me.fullName || me.login, details: 'регион: ' + item.regionKey,
    });
    return res.status(200).json({ shuttle: item });
  }
  if (req.method === 'PUT') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const list = await loadList(K_SHUTTLES);
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not_found' });
    const data = sanitizeShuttle(req.body || {});
    list[idx] = { ...list[idx], ...data, updatedAt: Date.now() };
    await saveList(K_SHUTTLES, list);
    return res.status(200).json({ shuttle: list[idx] });
  }
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const list = await loadList(K_SHUTTLES);
    const target = list.find(x => x.id === id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    await saveList(K_SHUTTLES, list.filter(x => x.id !== id));
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_shuttle_deleted', targetId: target.id, targetName: target.code,
      who: me.fullName || me.login, details: '',
    });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

/* ============== RC ============== */
function sanitizeRC(b) {
  return {
    code:         String(b.code || '').trim().slice(0, 32),
    name:         String(b.name || '').trim().slice(0, 120),
    regionKey:    String(b.regionKey || '').trim(),
    address:      String(b.address || '').trim().slice(0, 240),
    services:     Array.isArray(b.services) ? b.services.filter(s => SERVICES.includes(s)) : [],
    partnerType:  PARTNERS.includes(b.partnerType) ? b.partnerType : 'IJARA',
    manager:      String(b.manager || '').trim().slice(0, 80),
    managerPhone: String(b.managerPhone || '').trim().slice(0, 32),
    status:       ['active','closed'].includes(b.status) ? b.status : 'active',
    notes:        String(b.notes || '').trim().slice(0, 500),
  };
}
async function handleRC(req, res, me) {
  if (req.method === 'GET') {
    const list = await loadList(K_RC);
    return res.status(200).json({ rc: list, count: list.length });
  }
  if (req.method === 'POST') {
    const data = sanitizeRC(req.body || {});
    if (!data.code || !data.regionKey) {
      return res.status(400).json({ error: 'missing_fields', message: 'code и regionKey обязательны' });
    }
    const list = await loadList(K_RC);
    const item = {
      id: genId('rc'),
      ...data,
      createdBy: me.login || me.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.unshift(item);
    await saveList(K_RC, list);
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_rc_added', targetId: item.id, targetName: item.code + ' / ' + (item.name || ''),
      who: me.fullName || me.login, details: 'регион: ' + item.regionKey + ' · услуги: ' + item.services.join(','),
    });
    return res.status(200).json({ rc: item });
  }
  if (req.method === 'PUT') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const list = await loadList(K_RC);
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not_found' });
    const data = sanitizeRC(req.body || {});
    list[idx] = { ...list[idx], ...data, updatedAt: Date.now() };
    await saveList(K_RC, list);
    return res.status(200).json({ rc: list[idx] });
  }
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const list = await loadList(K_RC);
    const target = list.find(x => x.id === id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    await saveList(K_RC, list.filter(x => x.id !== id));
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_rc_deleted', targetId: target.id, targetName: target.code,
      who: me.fullName || me.login, details: '',
    });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

/* ============== TARIFFS ============== */
// Stored as nested map: tariffs[partnerType][regionKey][service] = number (UZS per kg)
async function handleTariff(req, res, me) {
  if (req.method === 'GET') {
    const t = await loadObj(K_TARIFFS);
    return res.status(200).json({ tariffs: t, regions: REGIONS, services: SERVICES, partners: PARTNERS });
  }
  if (req.method === 'POST') {
    // Bulk set: body = { tariffs: {...} } or { partner, region, service, value }
    const t = await loadObj(K_TARIFFS);
    if (req.body && req.body.tariffs && typeof req.body.tariffs === 'object') {
      await saveObj(K_TARIFFS, req.body.tariffs);
      await audit({
        id: generateRecordId(), when: Date.now(),
        eventKey: 'ev_tariffs_updated', targetId: '', targetName: 'Все тарифы',
        who: me.fullName || me.login, details: 'bulk update',
      });
      return res.status(200).json({ tariffs: req.body.tariffs });
    }
    const partner = PARTNERS.includes(req.body?.partner) ? req.body.partner : null;
    const region  = String(req.body?.region || '').trim();
    const service = SERVICES.includes(req.body?.service) ? req.body.service : null;
    const value   = Number(req.body?.value);
    if (!partner || !region || !service || isNaN(value)) {
      return res.status(400).json({ error: 'invalid_fields' });
    }
    if (!t[partner]) t[partner] = {};
    if (!t[partner][region]) t[partner][region] = {};
    t[partner][region][service] = value;
    await saveObj(K_TARIFFS, t);
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_tariff_set', targetId: region, targetName: service + '/' + partner,
      who: me.fullName || me.login, details: 'тариф: ' + value + ' UZS/кг',
    });
    return res.status(200).json({ tariffs: t });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

/* ============== TARIFF RECORDS (учёт за день) ============== */
function sanitizeRecord(b, tariffs) {
  const partner = PARTNERS.includes(b.partner) ? b.partner : 'IJARA';
  const region  = String(b.region || '').trim();
  const service = SERVICES.includes(b.service) ? b.service : 'IPOST';
  const kg      = Math.max(0, Number(b.kg) || 0);
  const tariff  = Number(b.tariff) > 0
    ? Number(b.tariff)
    : (tariffs?.[partner]?.[region]?.[service] || 0);
  return {
    date:    String(b.date || '').slice(0, 10), // YYYY-MM-DD
    region,
    service,
    partner,
    kg,
    tariff,
    revenue: kg * tariff,
    note:    String(b.note || '').trim().slice(0, 240),
    rcId:    String(b.rcId || '').trim(),
    shuttleId: String(b.shuttleId || '').trim(),
  };
}
async function handleRecord(req, res, me) {
  if (req.method === 'GET') {
    const url  = new URL(req.url, 'http://x');
    const from = url.searchParams.get('from'); // YYYY-MM-DD
    const to   = url.searchParams.get('to');
    const region  = url.searchParams.get('region');
    const service = url.searchParams.get('service');
    const partner = url.searchParams.get('partner');
    let list = await loadList(K_RECORDS);
    if (from)    list = list.filter(r => r.date >= from);
    if (to)      list = list.filter(r => r.date <= to);
    if (region)  list = list.filter(r => r.region === region);
    if (service) list = list.filter(r => r.service === service);
    if (partner) list = list.filter(r => r.partner === partner);
    const totals = list.reduce((acc, r) => {
      acc.kg += r.kg; acc.revenue += r.revenue; acc.count++;
      return acc;
    }, { kg: 0, revenue: 0, count: 0 });
    return res.status(200).json({ records: list, totals });
  }
  if (req.method === 'POST') {
    const tariffs = await loadObj(K_TARIFFS);
    // Batch insert
    if (Array.isArray(req.body?.batch)) {
      const list = await loadList(K_RECORDS);
      const added = [];
      for (const item of req.body.batch) {
        const data = sanitizeRecord(item, tariffs);
        if (!data.date || !data.region || data.kg <= 0) continue;
        const r = {
          id: genId('tr'),
          ...data,
          createdBy: me.login || me.id,
          createdByName: me.fullName || me.login,
          createdAt: Date.now(),
        };
        list.unshift(r);
        added.push(r);
      }
      await saveList(K_RECORDS, list.slice(0, 5000));
      await audit({
        id: generateRecordId(), when: Date.now(),
        eventKey: 'ev_tariff_records_added', targetId: '', targetName: 'Batch +' + added.length,
        who: me.fullName || me.login,
        details: 'Сумма выручки: ' + added.reduce((s,x) => s + x.revenue, 0) + ' UZS',
      });
      return res.status(200).json({ added: added.length, records: added });
    }
    const data = sanitizeRecord(req.body || {}, tariffs);
    if (!data.date || !data.region || data.kg <= 0) {
      return res.status(400).json({ error: 'invalid_fields', message: 'date, region, kg обязательны' });
    }
    const list = await loadList(K_RECORDS);
    const r = {
      id: genId('tr'),
      ...data,
      createdBy: me.login || me.id,
      createdByName: me.fullName || me.login,
      createdAt: Date.now(),
    };
    list.unshift(r);
    await saveList(K_RECORDS, list.slice(0, 5000));
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_tariff_record_added', targetId: r.region, targetName: r.service + ' · ' + r.kg + 'кг',
      who: me.fullName || me.login, details: 'Доход: ' + r.revenue + ' UZS',
    });
    return res.status(200).json({ record: r });
  }
  if (req.method === 'DELETE') {
    const { id, all } = req.body || {};
    if (all === true) {
      if (!isDirector(me)) {
        return res.status(403).json({ error: 'forbidden', message: 'director_required' });
      }
      const old = await loadList(K_RECORDS);
      await saveList(K_RECORDS, []);
      await audit({
        id: generateRecordId(), when: Date.now(),
        eventKey: 'ev_tariff_records_cleared', targetId: '', targetName: '',
        who: me.fullName || me.login, details: 'Удалено ' + old.length + ' записей',
      });
      return res.status(200).json({ ok: true, deleted: old.length });
    }
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const list = await loadList(K_RECORDS);
    const target = list.find(r => r.id === id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    // Only director can delete tariff records (preserve audit history)
    if (!isDirector(me)) {
      // Allow self-delete within 5 minutes (mistake correction)
      if (target.createdBy !== (me.login || me.id) || (Date.now() - target.createdAt) > 5 * 60 * 1000) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'Удалить чужую или старую запись может только директор',
        });
      }
    }
    await saveList(K_RECORDS, list.filter(r => r.id !== id));
    await audit({
      id: generateRecordId(), when: Date.now(),
      eventKey: 'ev_tariff_record_deleted', targetId: target.region, targetName: target.service,
      who: me.fullName || me.login, details: '',
    });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const url = new URL(req.url, 'http://x');
    const type = url.searchParams.get('type') || 'shuttle';
    switch (type) {
      case 'shuttle': return handleShuttle(req, res, ctx.user);
      case 'rc':      return handleRC(req, res, ctx.user);
      case 'tariff':  return handleTariff(req, res, ctx.user);
      case 'record':  return handleRecord(req, res, ctx.user);
      default:        return res.status(400).json({ error: 'invalid_type', allowed: ['shuttle','rc','tariff','record'] });
    }
  } catch (e) {
    console.error('[api/shuttles-rc] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
