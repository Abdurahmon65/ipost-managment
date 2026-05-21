// /api/ai — AI assistant for the director dashboard.
// Proxies questions to Anthropic Claude with full data context.
// Falls back to a smart local-only response if ANTHROPIC_API_KEY is missing.
//
// Required env (Vercel → Project Settings → Environment Variables):
//   ANTHROPIC_API_KEY=sk-ant-...
//   (optional) ANTHROPIC_MODEL=claude-sonnet-4-5

import { requireAuth } from './_lib/auth.js';
import { getBranches, getRecords } from './_lib/redis.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const SYSTEM_PROMPT = `Ты — AI-помощник директора логистической компании iPost GO. Отвечай по-русски, кратко и по делу.
У тебя есть доступ к реальным данным компании через context: курьеры, заказы, треки, филиалы, регионы, маршруты.

Правила:
1. Если вопрос про конкретные цифры — используй данные из context.
2. Если данных нет — честно скажи об этом.
3. Форматируй важные числа жирным (HTML <b>).
4. Будь конкретным: называй имена курьеров, номера треков, точные суммы.
5. Если нужно — предлагай действия ("посмотрите в разделе Курьерская → Треки").
6. Никогда не выдумывай данные — только из context.`;

function buildUserMessage(question, context) {
  const ctx = JSON.stringify(context, null, 2);
  return `Контекст iPost GO (live данные):\n\`\`\`json\n${ctx}\n\`\`\`\n\nВопрос директора: ${question}`;
}

async function callAnthropic(question, context) {
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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(question, context) }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('[api/ai] anthropic error', r.status, t.slice(0, 200));
      return null;
    }
    const j = await r.json();
    const text = (j.content || []).map(b => b.text || '').join('\n').trim();
    return text || null;
  } catch (e) {
    console.error('[api/ai] anthropic fetch failed:', e.message);
    return null;
  }
}

// Local fallback — rule-based smart answers using context
function localAnswer(question, context) {
  const Q = (question || '').toLowerCase();
  const c = context.couriers || {};
  const o = context.orders   || {};
  const fmt = n => new Intl.NumberFormat('ru-RU').format(n);
  const note = '<div style="opacity:.55; font-size:10.5px; margin-top:8px;">Локальный режим. Для умных ответов добавьте ANTHROPIC_API_KEY в окружение Vercel.</div>';

  if (/на маршрут|марш/.test(Q))     return `Сейчас <b>${c.on_route || 0}</b> курьеров на маршруте. Онлайн: <b>${c.online||0}</b>, оффлайн: <b>${c.offline||0}</b>, не работает: <b>${c.not_working||0}</b>.` + note;
  if (/онлайн/.test(Q))               return `Онлайн (готовы к выезду): <b>${c.online||0}</b>. На маршруте: <b>${c.on_route||0}</b>.` + note;
  if (/оффлайн|offline/.test(Q))      return `Оффлайн сейчас <b>${c.offline||0}</b> курьеров.` + note;
  if (/не работает|неисправ/.test(Q)) return `Не работает <b>${c.not_working||0}</b> курьеров (проблема/ТО).` + note;
  if (/вес|кг/.test(Q))               return `Общий вес отправлений за период: <b>${fmt(o.weightKg||0)} кг</b>. Заказов: <b>${o.total||0}</b>.` + note;
  if (/трек|track|ipst/.test(Q))      return `Всего треков в выборке: <b>${o.total||0}</b>. Доставлено: <b>${o.completed||0}</b>.` + note;
  if (/выручк|сумм/.test(Q))          return `Оборот за период: <b>${fmt(o.sumUZS||0)} UZS</b>.` + note;
  if (/филиал|пвз/.test(Q))           return `В реестре ПВЗ: <b>${context.branches||0}</b> филиалов в <b>${context.regions||0}</b> регионах.` + note;

  return `В выборке: <b>${(c.on_route||0)+(c.online||0)+(c.offline||0)+(c.not_working||0)}</b> курьеров (на маршруте: ${c.on_route||0}, онлайн: ${c.online||0}, оффлайн: ${c.offline||0}, не работает: ${c.not_working||0}), <b>${o.total||0}</b> отправлений общим весом <b>${fmt(o.weightKg||0)} кг</b>. Уточните вопрос, пожалуйста.` + note;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // Auth optional — director might use the AI without a full PVZ session in demo mode.
    // Try to attach user info if a valid token is provided.
    let user = null;
    try {
      const ctx = await requireAuth(req, res);
      if (ctx) user = ctx.user;
    } catch {}

    const { question, context: providedContext } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'missing_question' });
    }

    // Enrich context with server-side data
    let serverContext = {};
    try {
      const [branches, records] = await Promise.all([getBranches(), getRecords()]);
      serverContext = {
        pvz_total_branches: branches.length,
        pvz_active_branches: branches.filter(b => !b.closeDate).length,
        pvz_recent_events: (records || []).slice(0, 10).map(r => ({ when: r.when, who: r.who, key: r.eventKey, target: r.targetName })),
      };
    } catch {}

    const fullContext = {
      ...(providedContext || {}),
      server: serverContext,
      who: user ? { fullName: user.fullName, role: user.role } : null,
    };

    // Try Claude
    const aiAnswer = await callAnthropic(question, fullContext);
    if (aiAnswer) {
      return res.status(200).json({ answer: aiAnswer, source: 'claude', model: MODEL });
    }

    // Fallback local
    return res.status(200).json({
      answer: localAnswer(question, fullContext),
      source: 'local',
      hint: process.env.ANTHROPIC_API_KEY ? 'Claude failed, see logs' : 'Add ANTHROPIC_API_KEY for smart mode',
    });
  } catch (e) {
    console.error('[api/ai] error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
}
