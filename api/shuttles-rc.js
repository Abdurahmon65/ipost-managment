// /api/shuttles-rc — Зеркало данных ipost-tarif-dashboard.vercel.app
//
// Поскольку ipost-tarif-dashboard это чисто-клиентский SPA без бэкенда
// (всё в localStorage браузера: ipost-tarif-entries / ipost-tarif-tariffs),
// мы делаем мост через Redis:
//
//   1) Пользователь на ipost-tarif-dashboard.vercel.app запускает в консоли
//      однострочник (или жмёт bookmarklet) — он отправляет POST на нашу
//      ручку ?type=sync с CORS-разрешением.
//
//   2) Дальше директор-сюита читает синхронизированные данные через
//      ?type=sync (GET) и показывает их 1:1 с тарифной панелью.
//
// Эндпоинты:
//   ?type=sync   GET   — публично, возвращает {entries, tariffs, syncedAt}
//                POST  — публично+CORS, принимает {entries, tariffs}
//                OPTIONS — CORS preflight
//   ?type=clear  DELETE — auth (директор), полная очистка
//
// Хранение в Redis:
//   data:tarif:entries  — массив записей формата ipost-tarif-dashboard
//   data:tarif:tariffs  — таблица тарифов формата ipost-tarif-dashboard
//   data:tarif:meta     — { syncedAt, syncedFrom, entryCount }

import { redis } from './_lib/redis.js';
import { requireAuth, isDirector } from './_lib/auth.js';

const K_ENTRIES = 'data:tarif:entries';
const K_TARIFFS = 'data:tarif:tariffs';
const K_META    = 'data:tarif:meta';

const MAX_ENTRIES = 50000; // защита от мусора

// Канонические данные ipost-tarif-dashboard
const DEFAULT_TARIFFS = [
  { region: "Andijon",          partner: "IJARA",  ipost: 1000, emu: 800, bts: 800, shuttle: 1000 },
  { region: "Namangan",         partner: "IJARA",  ipost: 1000, emu: 800, bts: 800, shuttle: 1000 },
  { region: "Farg'ona",         partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
  { region: "Qo'qon",           partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
  { region: "Jizzax",           partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
  { region: "Sirdaryo",         partner: "—",      ipost: 0,    emu: 800, bts: 800, shuttle: 0    },
  { region: "Samarqand",        partner: "IJARA",  ipost: 1000, emu: 800, bts: 800, shuttle: 1000 },
  { region: "Qashqadaryo",      partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
  { region: "Surxondaryo",      partner: "IJARA",  ipost: 1000, emu: 800, bts: 800, shuttle: 1000 },
  { region: "Navoiy",           partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
  { region: "Buxoro",           partner: "IJARA",  ipost: 1000, emu: 800, bts: 800, shuttle: 1000 },
  { region: "Xorazm",           partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
  { region: "Qoraqalpog'iston", partner: "HAMKOR", ipost: 1200, emu: 800, bts: 800, shuttle: 1200 },
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function loadJson(key, fallback) {
  const raw = await redis.get(key);
  if (!raw) return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return fallback; }
}
async function saveJson(key, data) {
  await redis.set(key, JSON.stringify(data));
}

function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const kg   = Number(e.kg)   || 0;
  const rate = Number(e.rate) || 0;
  const rev  = Number(e.revenue);
  return {
    id:        String(e.id || '').slice(0, 64) || ('id_' + Math.random().toString(36).slice(2, 10)),
    date:      String(e.date || '').slice(0, 10),
    region:    String(e.region || '').slice(0, 80),
    partner:   String(e.partner || '').slice(0, 20),
    service:   String(e.service || '').slice(0, 20).toLowerCase(),
    kg,
    rate,
    revenue:   isNaN(rev) ? Math.round(kg * rate) : rev,
    note:      String(e.note || '').slice(0, 500),
    author:    String(e.author || '').slice(0, 80),
    createdAt: Number(e.createdAt) || Date.now(),
  };
}

function sanitizeTariffRow(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    region:  String(t.region || '').slice(0, 80),
    partner: String(t.partner || '—').slice(0, 20),
    ipost:   Number(t.ipost)   || 0,
    emu:     Number(t.emu)     || 0,
    bts:     Number(t.bts)     || 0,
    shuttle: Number(t.shuttle) || 0,
  };
}

/* ============== SYNC ============== */
async function handleSyncGet(req, res) {
  const [entries, tariffs, meta] = await Promise.all([
    loadJson(K_ENTRIES, []),
    loadJson(K_TARIFFS, DEFAULT_TARIFFS),
    loadJson(K_META,    { syncedAt: null, syncedFrom: null, entryCount: 0 }),
  ]);
  return res.status(200).json({
    ok: true,
    entries,
    tariffs,
    meta,
    source: 'ipost-tarif-dashboard',
  });
}

async function handleSyncPost(req, res) {
  // Body может быть object или строкой
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const updates = {};

  // Entries
  if (Array.isArray(body.entries)) {
    if (body.entries.length > MAX_ENTRIES) {
      return res.status(413).json({ error: 'too_many_entries', max: MAX_ENTRIES });
    }
    const clean = body.entries.map(sanitizeEntry).filter(Boolean);
    await saveJson(K_ENTRIES, clean);
    updates.entries = clean.length;
  }

  // Tariffs
  if (Array.isArray(body.tariffs)) {
    const clean = body.tariffs.map(sanitizeTariffRow).filter(Boolean);
    await saveJson(K_TARIFFS, clean);
    updates.tariffs = clean.length;
  }

  // Origin / source метка
  const origin = req.headers.origin || req.headers.referer || 'unknown';
  const ua     = req.headers['user-agent'] || '';
  const meta = {
    syncedAt:   Date.now(),
    syncedFrom: origin,
    entryCount: updates.entries ?? null,
    tariffCount: updates.tariffs ?? null,
    ua: String(ua).slice(0, 200),
  };
  await saveJson(K_META, meta);

  return res.status(200).json({ ok: true, ...updates, meta });
}

async function handleSyncClear(req, res, me) {
  if (!me || !isDirector(me)) {
    return res.status(403).json({ error: 'forbidden', message: 'director_required' });
  }
  await Promise.all([
    saveJson(K_ENTRIES, []),
    saveJson(K_TARIFFS, DEFAULT_TARIFFS),
    saveJson(K_META,    { syncedAt: null, syncedFrom: null, entryCount: 0 }),
  ]);
  return res.status(200).json({ ok: true, cleared: true });
}

/* ============== HANDLER ============== */
export default async function handler(req, res) {
  // CORS preflight всегда
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  const url = new URL(req.url, 'http://x');
  const type = url.searchParams.get('type') || 'sync';

  try {
    if (type === 'sync') {
      // Публично, с CORS
      setCors(res);
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET')  return await handleSyncGet(req, res);
      if (req.method === 'POST') return await handleSyncPost(req, res);
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    if (type === 'clear') {
      const ctx = await requireAuth(req, res);
      if (!ctx) return;
      if (req.method === 'DELETE') return await handleSyncClear(req, res, ctx.user);
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    // Совместимость со старыми вызовами — отдаём пустые массивы,
    // чтобы клиент не падал, пока не обновится. Все типы кроме sync теперь deprecated.
    if (['shuttle','rc','tariff','record'].includes(type)) {
      setCors(res);
      if (req.method === 'GET') {
        if (type === 'shuttle') return res.status(200).json({ shuttles: [], _deprecated: true });
        if (type === 'rc')      return res.status(200).json({ rc: [],       _deprecated: true });
        if (type === 'tariff')  return res.status(200).json({ tariffs: {},  _deprecated: true });
        if (type === 'record')  return res.status(200).json({ records: [],  totals: { kg:0, revenue:0, count:0 }, _deprecated: true });
      }
      return res.status(410).json({ error: 'deprecated', message: 'use type=sync' });
    }

    return res.status(400).json({ error: 'invalid_type', allowed: ['sync', 'clear'] });
  } catch (e) {
    console.error('[api/shuttles-rc] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
