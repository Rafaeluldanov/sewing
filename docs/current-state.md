# Current State — короткая карта проекта

> Назначение: точка входа для агента. Прочитав этот файл, дальше можно читать
> только узкий документ или конкретный модуль (см.
> `.cursor/rules/00-context-optimization.mdc`).
> Полная карта документации — `docs/index.md` (читать только при необходимости).

---

## 1. Что это

Система управления швейным производством (MVP).
Pipeline: **заказ → паспорт → раскрой → пошив → ОТК → ВТО → упаковка →
выпуск**, плюс начисления (сдельщина + оклад от факта смены), shopfloor
display board и payroll-админка.

Stage домены: `stage.teeon.ru` (web) / `stage.teeon.ru/api` (API).
Подробности окружений — `docs/index.md` § «Домены и URL-ы».

Backend-итерация «Фактическая стоимость материалов в production cost
по периоду» (`apps/api/src/modules/costs/costs.service.ts`,
`GET /api/costs/production`, контракт `packages/shared/src/costs.ts`):
`CostsService.getProductionCost` теперь добавляет к каждому дню и к
итогу периода отдельную сумму `materialCost` и включает её в
`totalCost = pieceworkCost + salaryCost + materialCost`.

- `materialCost[day]` = Σ `MaterialIssue.totalCost` по
  `POSTED`-документам, у которых `passportId` входит в множество
  паспортов, упакованных в этот день (`PACKED`-event внутри окна
  периода);
- `DRAFT` и `CANCELLED` документы **не учитываются**;
- `MaterialIssue` без `passportId` (order-level) сознательно
  **не включаются** в production cost по периоду — без привязки к
  паспорту нельзя корректно разнести расход по дню выпуска. Они
  по-прежнему видны в order-level финансовой сводке заказа;
- сервис использует `MaterialIssue.totalCost` (server-side агрегат,
  пересчитываемый при `POST /api/material-issues/:id/post`) — строки
  `MaterialIssueLine` без `workshopNeedId` не мешают, потому что
  сервис их и не читает;
- frontend-страница `/production-cost` пока **не показывает**
  отдельную колонку «Материалы»: новое поле появилось в response
  аддитивно, UI рендерит существующие колонки без изменений.

`ProductionCostV2Service` на этой итерации **не менялся** —
управленческий P&L по-прежнему берёт материалы из расчётной основы
(`OrderCostEstimate` / `WorkshopNeed`), а не из `MaterialIssue`.

Складские остатки (`StockBalance` / `StockMovement` /
`MaterialStockLot` / FIFO/LIFO), автосписание при выдаче кроя,
master-модель `Material`, роли `WAREHOUSE_MANAGER` / `PURCHASER` /
`ACCOUNTANT` на этой итерации **не реализованы и не менялись** —
они вынесены в следующие итерации.

---

## 2. Стек

- **Backend:** NestJS (TypeScript), Prisma ORM (PostgreSQL).
- **Frontend:** Next.js (App Router, React Server Components).
- **Mobile/Print station:** `apps/agent` (Node printing agent).
- **Shared types:** `packages/shared` (TS).
- **Tests:** интеграционные + smoke (Node test runner).
- **Auth:** session-cookie HMAC-SHA256, RBAC через `AuthGuard` + `@Roles()`
  (см. ADR-0014).
- **Realtime:** polling (ADR-0007), без WebSocket в MVP.
- **Node:** `>=20`. Менеджер пакетов — npm workspaces.

---

## 3. Структура репозитория (top-level)

```
apps/
  api/      — NestJS API (источник истины REST)
  web/      — Next.js (UI: /admin, /work, /shopfloor, /master, /packing, /qc, /earnings, …)
  agent/    — печатная станция (узкий сервис)
packages/
  shared/   — общие TS-типы и контракты
prisma/
  schema.prisma   — единственный source of truth модели БД
  seed.ts         — демо-данные / справочники
  migrations/     — НЕ читать без явной необходимости
docs/             — документация (см. §5)
scripts/          — deploy / docs:check / backup / cleanup
tests/            — integration + smoke
deploy/           — конфиги развёртывания
```

---

## 4. Где что (узкий маршрут чтения)

- **Backend модуль:** `apps/api/src/modules/<module>/*.controller.ts` +
  `*.service.ts`. Любой REST-эндпоинт ищется здесь, не в документации.
- **Frontend экран:** `apps/web/app/<route>/page.tsx` (+ соседние `*.tsx`).
- **Модель БД:** `prisma/schema.prisma` (читать целиком — дорого; искать
  конкретный `model` / `enum` через grep).
- **Контракты между API и Web:** `packages/shared/src/*.ts`.
- **События:** `apps/api/src/modules/audit/audit.service.ts`
  (`AuditEntityType`) + `prisma/schema.prisma` (`enum PassportEventType`).

---

## 5. Документация (карта по узким темам)

Источник истины кода — код. Документы дают карту и бизнес-смысл.

| Файл | Когда читать |
| --- | --- |
| `docs/current-state.md` | **первый шаг для агента** (этот файл) |
| `docs/index.md` | полная карта документов и статусы (только при необходимости) |
| `docs/domain.md` | доменная модель / глоссарий |
| `docs/api.md` | карта REST-эндпоинтов (от контроллеров) |
| `docs/erd.md` | модели БД (от `prisma/schema.prisma`) |
| `docs/events.md` | `PassportEvent` / `AuditLog` |
| `docs/order-flow.md` | бизнес-цикл заказа (PHASE 2, OK) |
| `docs/production-flow.md` | бизнес-цикл паспорта (PHASE 2, OK) |
| `docs/display-board.md` | большой экран `/shopfloor/display` |
| `docs/screens.md` | карта экранов PWA (часть OUTDATED — сверять с кодом) |
| `docs/adr/*.md` | принятые архитектурные решения |
| `docs/pilot/*` | rollout / UAT (не нужно для разработки) |
| `docs/*-recon.md` | рабочие планы внедрения подсистем (читать только по теме) |

Архивные / устаревшие документы помечены `OUTDATED` / `ARCHIVED` в
`docs/index.md`. В спорных местах **верим коду**, а не документу.

---

## 6. Команды (из `package.json`)

- `npm run dev:api` — backend (`apps/api`).
- `npm run dev:web` — frontend (`apps/web`).
- `npm run prisma:generate` — Prisma client.
- `npm run prisma:migrate` — миграции (dev).
- `npm run db:seed` / `npm run db:reset` — демо-данные / полный сброс.
- `npm run test` / `test:integration` / `test:smoke` — тесты.
- `npm run typecheck` — root + workspace `tsc --noEmit`.
- `npm run docs:check` — проверка консистентности docs (см. §7).
- `npm run deploy:stage` — деплой на stage.

---

## 7. `docs:check` (консистентность кода и документации)

Скрипт `scripts/docs/check-docs.mjs` проверяет:

- наличие критических документов (`api.md` / `erd.md` / `events.md` /
  `order-flow.md` / `production-flow.md` / `display-board.md` / `domain.md`);
- каждый top-level `enum` / `model` из `prisma/schema.prisma` упомянут в
  `docs/erd.md`;
- каждый `*.controller.ts` и его HTTP-route упомянут в `docs/api.md`;
- каждое значение `PassportEventType` и `AuditEntityType` упомянуто в
  `docs/events.md`;
- все относительные markdown-ссылки и якоря в `README.md` + `docs/**/*.md`
  валидны.

PR без `docs:check OK` не мержится (CI: `.github/workflows/docs-check.yml`,
job `docs-check`).

При изменении кода обязательно правится соответствующий документ
(см. правило `.cursor/rules/04-docs-and-commit.mdc`).

---

## 8. Правила работы агента

См. `.cursor/rules/00-context-optimization.mdc`:

- читать **только** файлы, явно нужные для задачи;
- не читать весь `docs/`, весь `prisma/schema.prisma`, `node_modules`,
  `dist`, `.next`, `migrations` без явной необходимости;
- начинать с этого файла, дальше — узкий документ из §5 или конкретный
  модуль из §4;
- если данных не хватает — **запросить** конкретный файл, а не сканировать
  проект.
