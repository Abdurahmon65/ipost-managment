// /api/ai-scout — AI-powered location recommendations for new PVZ.
// Combines internal data (existing branches, order density, regions) with
// curated demographic priors (population, urban centers) into pre-filtered
// candidate set, then asks Claude to rank and explain.

import { redis } from './_lib/redis.js';
import { requireAuth } from './_lib/auth.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

// Curated districts in Uzbekistan with approximate center coords + population +
// avg monthly rent (USD) estimates. In production, refresh from stat.uz / OSM.
const DISTRICTS = [
  { region:'tashkent', district:'Чиланзар', lat:41.2718, lng:69.2025, pop_k:240, rent_usd:1800, urban:true },
  { region:'tashkent', district:'Юнусабад', lat:41.3700, lng:69.2900, pop_k:280, rent_usd:1900, urban:true },
  { region:'tashkent', district:'Мирзо-Улугбек', lat:41.3308, lng:69.3214, pop_k:230, rent_usd:1700, urban:true },
  { region:'tashkent', district:'Сергели', lat:41.2244, lng:69.2436, pop_k:165, rent_usd:1300, urban:true },
  { region:'tashkent', district:'Учтепа', lat:41.2858, lng:69.2074, pop_k:200, rent_usd:1400, urban:true },
  { region:'tashkent', district:'Яшнабад', lat:41.3034, lng:69.3194, pop_k:215, rent_usd:1500, urban:true },
  { region:'tashkent_region', district:'Чирчик', lat:41.4690, lng:69.5820, pop_k:155, rent_usd:900, urban:true },
  { region:'tashkent_region', district:'Ангрен', lat:41.0167, lng:70.1437, pop_k:135, rent_usd:700, urban:true },
  { region:'tashkent_region', district:'Алмалык', lat:40.8447, lng:69.6017, pop_k:130, rent_usd:750, urban:true },
  { region:'samarkand', district:'Самарканд центр', lat:39.6542, lng:66.9597, pop_k:530, rent_usd:1100, urban:true },
  { region:'samarkand', district:'Каттакурган', lat:39.9000, lng:66.2667, pop_k:80,  rent_usd:500, urban:false },
  { region:'samarkand', district:'Ургут', lat:39.4000, lng:67.2500, pop_k:60,  rent_usd:450, urban:false },
  { region:'bukhara', district:'Бухара центр', lat:39.7747, lng:64.4286, pop_k:280, rent_usd:900, urban:true },
  { region:'bukhara', district:'Каган', lat:39.7236, lng:64.5481, pop_k:70,  rent_usd:500, urban:false },
  { region:'fergana', district:'Фергана центр', lat:40.3864, lng:71.7864, pop_k:280, rent_usd:850, urban:true },
  { region:'fergana', district:'Маргилан', lat:40.4708, lng:71.7242, pop_k:235, rent_usd:700, urban:true },
  { region:'fergana', district:'Коканд', lat:40.5286, lng:70.9425, pop_k:255, rent_usd:750, urban:true },
  { region:'andijan', district:'Андижан центр', lat:40.7821, lng:72.3442, pop_k:440, rent_usd:850, urban:true },
  { region:'andijan', district:'Асака', lat:40.6431, lng:72.2381, pop_k:75,  rent_usd:500, urban:false },
  { region:'namangan', district:'Наманган центр', lat:41.0000, lng:71.6667, pop_k:475, rent_usd:850, urban:true },
  { region:'namangan', district:'Чуст', lat:41.0000, lng:71.2333, pop_k:75,  rent_usd:450, urban:false },
  { region:'qashqadaryo', district:'Карши', lat:38.8606, lng:65.7894, pop_k:260, rent_usd:700, urban:true },
  { region:'qashqadaryo', district:'Шахрисабз', lat:39.0581, lng:66.8311, pop_k:110, rent_usd:550, urban:true },
  { region:'surxondaryo', district:'Термез', lat:37.2242, lng:67.2783, pop_k:170, rent_usd:600, urban:true },
  { region:'navoiy', district:'Навои центр', lat:40.0844, lng:65.3792, pop_k:135, rent_usd:700, urban:true },
  { region:'navoiy', district:'Зарафшан', lat:41.5764, lng:64.2056, pop_k:80,  rent_usd:600, urban:true },
  { region:'jizzax', district:'Джизак центр', lat:40.1158, lng:67.8422, pop_k:175, rent_usd:600, urban:true },
  { region:'sirdaryo', district:'Гулистан', lat:40.4897, lng:68.7842, pop_k:90,  rent_usd:550, urban:true },
  { region:'xorazm', district:'Ургенч', lat:41.5500, lng:60.6333, pop_k:160, rent_usd:600, urban:true },
  { region:'xorazm', district:'Хива', lat:41.3789, lng:60.3633, pop_k:95,  rent_usd:500, urban:true },
  { region:'karakalpak', district:'Нукус', lat:42.4533, lng:59.6014, pop_k:330, rent_usd:600, urban:true },
];

function kmBetween(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestBranchKm(district, branches) {
  let best = Infinity;
  for (const b of branches) {
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') continue;
    if (b.closeDate) continue;
    const d = kmBetween(district, b);
    if (d < best) best = d;
  }
  return best === Infinity ? null : Math.round(best * 10) / 10;
}

function ordersDensity(district, orders, radiusKm = 5) {
  let n = 0;
  for (const o of orders) {
    if (typeof o.lat !== 'number' || typeof o.lng !== 'number') continue;
    if (kmBetween(district, o) <= radiusKm) n++;
  }
  return n;
}

function buildCandidates(branches, orders) {
  return DISTRICTS.map(d => {
    const nearest   = nearestBranchKm(d, branches);
    const ordersIn5 = ordersDensity(d, orders, 5);
    // Heuristic score 0..100
    let score = 0;
    score += d.urban ? 12 : 4;
    score += Math.min(30, d.pop_k / 10);
    score += nearest == null ? 25 : Math.min(25, nearest * 2);    // далекий нет наших = +
    score += Math.min(20, ordersIn5 * 0.5);                       // плотность спроса
    score -= Math.max(0, (d.rent_usd - 800) / 100);               // дорогая аренда штраф
    return {
      ...d,
      signals: {
        nearestBranchKm: nearest,
        ordersIn5km:     ordersIn5,
        population_k:    d.pop_k,
        avg_rent_usd:    d.rent_usd,
        is_urban:        d.urban,
      },
      pre_score: Math.round(score * 10) / 10,
    };
  }).sort((a,b) => b.pre_score - a.pre_score);
}

const SYSTEM_PROMPT = `Ты — стратег развития сети ПВЗ iPost GO в Узбекистане.
Анализируешь данные и рекомендуешь места для открытия НОВЫХ пунктов выдачи.

ЦЕЛИ:
1. Покрытие районов с высоким спросом, но без существующих ПВЗ
2. Избегать каннибализации (новый ПВЗ не должен быть ближе 3 км к существующему без сильного обоснования)
3. Опережать конкурентов в зонах роста
4. Приемлемая стоимость аренды

ВХОД: JSON со списком районов с signals (ближайший наш ПВЗ в км, заказы в радиусе 5км, население в тыс, средняя аренда USD, городской ли район)

ПРАВИЛА:
- Выбирай 3-7 реально перспективных кандидатов из топа списка
- Не предлагай районы где nearestBranchKm < 3 км
- Для каждого: confidence 0.5-1.0, expected_monthly_orders (число), payback_months (число), 2-4 reasons, возможные risks
- Возвращай ТОЛЬКО валидный JSON по схеме. Без markdown, без комментариев, без \`\`\`

СХЕМА:
{
  "summary": "1-2 предложения",
  "recommendations": [
    {
      "rank": 1,
      "region": "samarkand",
      "district": "Каттакурган",
      "coordinates": { "lat": 39.9, "lng": 66.27 },
      "confidence": 0.82,
      "expected_monthly_orders": 380,
      "payback_months": 7,
      "suggested_format": "small_24h | full | pickup_point",
      "reasons": ["...", "..."],
      "risks": ["..."]
    }
  ]
}`;

async function callClaude(candidates) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Найди до 7 лучших мест для новых ПВЗ из списка кандидатов (топ-15 по pre_score):\n\n\`\`\`json\n${JSON.stringify(candidates.slice(0, 15), null, 2)}\n\`\`\``
        }],
      }),
    });
    if (!r.ok) {
      console.error('[ai-scout] anthropic', r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const j = await r.json();
    const text = (j.content || []).map(b => b.text || '').join('');
    // Strip potential ``` wrappers
    const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[ai-scout] parse error:', e?.message);
    return null;
  }
}

/** Local fallback ranking — same heuristic with formulaic reasoning. */
function localRanking(candidates) {
  const top = candidates.slice(0, 6).filter(c => !c.signals.nearestBranchKm || c.signals.nearestBranchKm >= 3);
  return {
    summary: `Локальный анализ ${candidates.length} районов: топ-${top.length} по покрытию, спросу и аренде.`,
    recommendations: top.map((c, i) => ({
      rank: i + 1,
      region: c.region,
      district: c.district,
      coordinates: { lat: c.lat, lng: c.lng },
      confidence: Math.min(0.95, 0.45 + c.pre_score / 100),
      expected_monthly_orders: Math.round(c.signals.population_k * 0.7 + c.signals.ordersIn5km * 4),
      payback_months: Math.max(4, Math.round(12 - c.pre_score / 10)),
      suggested_format: c.signals.is_urban && c.signals.population_k > 200 ? 'full' : c.signals.is_urban ? 'small_24h' : 'pickup_point',
      reasons: [
        c.signals.nearestBranchKm == null
          ? 'В этом районе ещё нет наших ПВЗ — чистое покрытие'
          : `Ближайший наш ПВЗ в ${c.signals.nearestBranchKm} км — зона недопокрытия`,
        `Население ~${c.signals.population_k} тыс. чел.`,
        c.signals.ordersIn5km > 20
          ? `Уже есть спрос: ${c.signals.ordersIn5km} заказов в радиусе 5 км`
          : (c.signals.is_urban ? 'Городской район с потенциалом роста' : 'Стратегическая локация для расширения'),
        `Средняя аренда ~${c.signals.avg_rent_usd} USD/мес`,
      ].filter(Boolean),
      risks: c.signals.nearestBranchKm != null && c.signals.nearestBranchKm < 5
        ? [`Возможна каннибализация: ПВЗ в ${c.signals.nearestBranchKm} км`]
        : [],
    })),
    source: 'local',
  };
}

export default async function handler(req, res) {
  try {
    const ctx = await requireAuth(req, res);
    if (!ctx) return;
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    // Load branches + orders for context
    const branchesRaw = await redis.get('data:branches');
    const branches = !branchesRaw ? [] : (typeof branchesRaw === 'string' ? JSON.parse(branchesRaw) : branchesRaw);

    // Optionally enrich with dispatch orders if URL provided
    let orders = [];
    if (process.env.DISPATCH_URL) {
      try {
        const r = await fetch(process.env.DISPATCH_URL + '/api/orders', { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = await r.json();
          orders = j.orders || j;
          if (!Array.isArray(orders)) orders = [];
        }
      } catch {}
    }

    const candidates = buildCandidates(branches, orders);

    let result = await callClaude(candidates);
    if (!result) result = localRanking(candidates);
    result.candidates_total = candidates.length;
    result.ts = Date.now();

    // Audit log
    try {
      await redis.set('data:ai_scout:last', JSON.stringify({ user: ctx.user.login, result, ts: Date.now() }));
    } catch {}

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (e) {
    console.error('[api/ai-scout] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
