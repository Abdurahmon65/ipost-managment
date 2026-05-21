// Director aggregator — merges live data from:
//   1) ipost-pvz (this Vercel app)        — Redis: branches, users, records
//   2) iPost GO Dispatch (server.cjs)     — local HTTP server (configurable via env DISPATCH_URL)
//
// Returns a single normalized "BoardState" used by director.html.

import { getBranches, getRecords, getUsers, redis } from './_lib/redis.js';
import { requireAuth, safeUser, isDirector } from './_lib/auth.js';

async function getPlans() {
  try {
    const raw = await redis.get('data:plans');
    if (!raw) return [];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return []; }
}

const DISPATCH_URL = process.env.DISPATCH_URL || 'http://localhost:8080';
const DISPATCH_TIMEOUT_MS = 2500;

async function fetchWithTimeout(url, opts = {}, ms = DISPATCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function loadDispatch() {
  const out = { online: false, error: null, routes: [], drivers: [], vehicles: [], orders: [], customers: [], depots: [], activity: [], notifications: [] };
  const endpoints = ['routes', 'drivers', 'vehicles', 'orders', 'customers', 'depots', 'activity', 'notifications'];
  try {
    const results = await Promise.allSettled(
      endpoints.map(e => fetchWithTimeout(`${DISPATCH_URL}/api/${e}`))
    );
    let anyOk = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        const key = endpoints[i];
        const data = r.value;
        // server returns either { routes: [...] } or just [...]
        if (Array.isArray(data)) out[key] = data;
        else if (Array.isArray(data[key])) out[key] = data[key];
        else if (data && typeof data === 'object') out[key] = Object.values(data).find(Array.isArray) || [];
        anyOk = true;
      }
    });
    out.online = anyOk;
    if (!anyOk) out.error = 'no_endpoints_responded';
  } catch (e) {
    out.error = String(e?.message || e);
  }
  return out;
}

/* Region mapping — branches.regionKey → display name + Tashkent center */
const REGION_NAMES = {
  tashkent: 'Ташкент',          tashkent_region: 'Ташкентская область',
  samarkand: 'Самарканд',       bukhara: 'Бухара',
  fergana: 'Фергана',           andijan: 'Андижан',
  namangan: 'Наманган',         qashqadaryo: 'Кашкадарья',
  surxondaryo: 'Сурхандарья',   navoiy: 'Навои',
  jizzax: 'Джизак',             sirdaryo: 'Сырдарья',
  xorazm: 'Хорезм',             karakalpak: 'Каракалпакстан',
};
const REGION_CENTERS = {
  tashkent: [41.31, 69.28],      tashkent_region: [41.20, 69.50],
  samarkand: [39.65, 66.97],     bukhara: [39.77, 64.42],
  fergana: [40.39, 71.78],       andijan: [40.78, 72.34],
  namangan: [41.00, 71.67],      qashqadaryo: [38.85, 65.78],
  surxondaryo: [37.23, 67.28],   navoiy: [40.10, 65.38],
  jizzax: [40.12, 67.83],        sirdaryo: [40.38, 68.66],
  xorazm: [41.55, 60.63],        karakalpak: [42.46, 59.61],
};

function aggregateRegions(branches) {
  const map = new Map();
  for (const b of branches || []) {
    const key = b.regionKey || 'unknown';
    if (!map.has(key)) {
      const [lat, lng] = REGION_CENTERS[key] || [41.5, 64.5];
      map.set(key, {
        key, name: REGION_NAMES[key] || key,
        lat, lng, branches: 0, active: 0, closed: 0,
        sampleManagers: [],
      });
    }
    const r = map.get(key);
    r.branches++;
    if (b.closeDate) r.closed++; else r.active++;
    if (r.sampleManagers.length < 3 && b.manager) r.sampleManagers.push(b.manager);
  }
  return Array.from(map.values()).sort((a,b) => b.branches - a.branches);
}

function buildKpis({ branches, dispatch, records }) {
  const activeBranches = (branches || []).filter(b => !b.closeDate).length;
  const closedBranches = (branches || []).filter(b => b.closeDate).length;
  const totalRoutes = (dispatch.routes || []).length;
  const activeRoutes = (dispatch.routes || []).filter(r => r.status === 'progress' || r.status === 'ready').length;
  const activeDrivers = (dispatch.drivers || []).filter(d => d.status === 'on_route' || d.status === 'ready').length;
  const onRouteVehicles = (dispatch.vehicles || []).filter(v => v.status === 'on_route').length;
  const todayOrders = (dispatch.orders || []).length;
  const completedOrders = (dispatch.orders || []).filter(o => o.status === 'completed').length;
  const revenue = (dispatch.orders || [])
    .filter(o => o.status === 'completed')
    .reduce((s, o) => s + (Number(o.sumUZS) || 0), 0);
  return {
    branches: { total: (branches || []).length, active: activeBranches, closed: closedBranches },
    routes:   { total: totalRoutes, active: activeRoutes },
    drivers:  { total: (dispatch.drivers || []).length, active: activeDrivers },
    vehicles: { total: (dispatch.vehicles || []).length, onRoute: onRouteVehicles },
    orders:   { total: todayOrders, completed: completedOrders,
                completionPct: todayOrders ? Math.round(completedOrders / todayOrders * 100) : 0 },
    revenue:  { uzs: revenue },
    journal:  { entries: (records || []).length },
  };
}

export default async function handler(req, res) {
  try {
    // Auth (uses ipost-pvz session token)
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const [branches, records, users, plans, dispatch] = await Promise.all([
      getBranches().catch(() => []),
      getRecords().catch(() => []),
      getUsers().catch(() => []),
      getPlans().catch(() => []),
      loadDispatch(),
    ]);

    const regions = aggregateRegions(branches);
    const kpis    = buildKpis({ branches, dispatch, records });

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(200).json({
      ts: Date.now(),
      me: safeUser(ctx.user),
      sources: {
        pvz:      { online: true, url: 'redis', count: branches.length },
        dispatch: { online: dispatch.online, url: DISPATCH_URL, error: dispatch.error,
                    counts: {
                      routes:   (dispatch.routes   || []).length,
                      drivers:  (dispatch.drivers  || []).length,
                      vehicles: (dispatch.vehicles || []).length,
                      orders:   (dispatch.orders   || []).length,
                    } },
      },
      kpis,
      regions,
      // Full lists — no slicing, send everything
      branches: branches || [],
      branchesTotal: (branches || []).length,
      plans: plans || [],
      isDirector: isDirector(ctx.user),
      users: (users || []).map(safeUser),
      records: (records || []).slice(0, 100),
      dispatch: {
        routes:        dispatch.routes        || [],
        drivers:       dispatch.drivers       || [],
        vehicles:      dispatch.vehicles      || [],
        orders:        dispatch.orders        || [],   // FULL list
        customers:     dispatch.customers     || [],
        depots:        dispatch.depots        || [],
        activity:      (dispatch.activity     || []).slice(0, 50),
        notifications: (dispatch.notifications|| []).slice(0, 30),
      },
    });
  } catch (e) {
    console.error('[api/aggregator] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
