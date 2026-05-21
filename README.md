# iPost Management — Director Suite

Премиум-дашборд директора iPost GO. Объединяет данные из:
- **iPost PVZ** (256 филиалов) — Upstash Redis
- **iPost GO Dispatch** (маршруты, курьеры, ТС, заказы) — `logistic-system-tau.vercel.app`
- **Курьерская** — ежедневные/ежемесячные отчёты, треки, точки, вес, статусы
- **AI помощник** — Claude API (опционально) + локальный fallback

## Доступ

Production: https://ipost-managment.vercel.app

**Логин:** `ipost` · **Пароль:** `2026`

## Env vars (Vercel → Project → Settings → Environment Variables)

```
KV_REST_API_URL          # Upstash Redis (PVZ data)
KV_REST_API_TOKEN
DISPATCH_URL             # https://logistic-system-tau.vercel.app
ANTHROPIC_API_KEY        # опционально для умного AI
```
