// RBAC: departments + permission filtering for the director dashboard.
import { redis } from './redis.js';

/** Default department catalog (seeded if Redis key is empty). */
export const DEFAULT_DEPARTMENTS = {
  logistics: {
    key: 'logistics', name: 'Логистика', color: '#FFB840',
    pages:  ['home','analytics','logistics','fleet','orders','map','courier','courier-daily','courier-monthly','courier-tracks','courier-points','courier-weight','courier-status'],
    scopes: ['orders','routes','vehicles','drivers','customers'],
  },
  finance: {
    key: 'finance', name: 'Финансы', color: '#2CE0A8',
    pages:  ['home','finance','analytics','reports'],
    scopes: ['finance','plans','kpi','records'],
  },
  development: {
    key: 'development', name: 'Развитие сети', color: '#B888FF',
    pages:  ['home','branches','plans','map','analytics'],
    scopes: ['branches','regions','plans'],
  },
  hr: {
    key: 'hr', name: 'HR / Команда', color: '#FF6BD6',
    pages:  ['home','team','courier-status'],
    scopes: ['users','drivers','team'],
  },
  operations: {
    key: 'operations', name: 'Операции ПВЗ', color: '#3CCBFF',
    pages:  ['home','branches','map','customers','courier'],
    scopes: ['branches','customers','records'],
  },
};

const K_DEPARTMENTS = 'data:departments';
let _cache = null, _ts = 0;

export async function getDepartments() {
  if (_cache && Date.now() - _ts < 60_000) return _cache;
  try {
    const raw = await redis.get(K_DEPARTMENTS);
    if (raw) {
      _cache = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } else {
      _cache = { ...DEFAULT_DEPARTMENTS };
      await redis.set(K_DEPARTMENTS, JSON.stringify(_cache));
    }
  } catch {
    _cache = { ...DEFAULT_DEPARTMENTS };
  }
  _ts = Date.now();
  return _cache;
}

export async function setDepartments(map) {
  _cache = map; _ts = Date.now();
  await redis.set(K_DEPARTMENTS, JSON.stringify(map));
}

/** Compute effective permissions for a user.
 *  Director / role==='director' = unrestricted.
 *  Users with role 'manager' but NO departments → also unrestricted (back-compat).
 *  Users with departments → union of department pages + scopes.            */
export async function computeEffectivePermissions(user) {
  if (!user) return { all: false, pages: new Set(['home']), scopes: new Set() };
  if (user.role === 'director' || user.login === 'director') {
    return { all: true, pages: '*', scopes: '*' };
  }
  const depts = Array.isArray(user.departments) ? user.departments : [];
  // Back-compat: if no departments assigned, treat as full access (so existing
  // `ipost` admin keeps working until departments are assigned via UI).
  if (depts.length === 0) {
    return { all: true, pages: '*', scopes: '*' };
  }
  const catalog = await getDepartments();
  const pages = new Set(['home','settings']);
  const scopes = new Set();
  for (const d of depts) {
    const def = catalog[d];
    if (!def) continue;
    (def.pages  || []).forEach(p => pages.add(p));
    (def.scopes || []).forEach(s => scopes.add(s));
  }
  return { all: false, pages, scopes, departments: depts };
}

/** Strip data scopes the user can't see. Mutates payload. */
export function filterPayloadByScopes(payload, perms) {
  if (perms.all) return payload;
  const s = perms.scopes;

  if (!s.has('finance')) {
    if (payload.kpis) {
      delete payload.kpis.revenue;
    }
  }
  if (!s.has('branches') && !s.has('regions')) {
    payload.branches = []; payload.branchesTotal = 0; payload.regions = [];
  }
  if (!s.has('plans')) payload.plans = [];
  if (!s.has('records')) payload.records = [];
  if (!s.has('users')) payload.users = [];

  if (payload.dispatch) {
    if (!s.has('orders'))    payload.dispatch.orders    = [];
    if (!s.has('routes'))    payload.dispatch.routes    = [];
    if (!s.has('vehicles'))  payload.dispatch.vehicles  = [];
    if (!s.has('drivers'))   payload.dispatch.drivers   = [];
    if (!s.has('customers')) payload.dispatch.customers = [];
  }
  return payload;
}

export function permsToJson(perms) {
  if (perms.all) return { all: true, pages: '*', scopes: '*', departments: '*' };
  return {
    all: false,
    pages:  Array.from(perms.pages),
    scopes: Array.from(perms.scopes),
    departments: perms.departments || [],
  };
}
