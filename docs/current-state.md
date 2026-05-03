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

Модули с фронтовым UI в MVP-итерации «Фактический расход»:

- **Фактический расход материалов по заказу**
  (`apps/api/src/modules/material-issues/*`,
  `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
  `docs/api.md §20a «Material issues»`). Менеджер фиксирует,
  сколько материала фактически выдано в крой по заказу — ручной
  документ с заголовком и строками, без автосписания и без
  складских остатков.
  В UI реализован frontend-блок «Фактический расход материалов» в
  карточке заказа (`/admin/orders/[id]?tab=needs`, компонент
  `apps/web/components/orders/material-issues/material-issues-section.tsx`).
  Блок размещён во вкладке «Потребности» ПОСЛЕ
  `OrderMaterialsUnifiedTable`; показывает список документов,
  сводку (`всего / DRAFT / POSTED / CANCELLED / Σ POSTED`), preview
  строк и действия `Создать расход` / `Провести` / `Отменить`
  (RBAC — только ADMIN / SHOP_MANAGER).
  **Отдельная страница `/admin/material-issues` сознательно НЕ
  реализована** (UI-решение владельца): нового пункта меню, новой
  вкладки и роута не добавляется.

  Frontend-итерация «План / факт по фактическому расходу
  материалов» (поверх существующих эндпоинтов): в
  `OrderMaterialsUnifiedTable` (вкладка «Потребности») добавлены
  две компактные колонки — «План / факт» (количество) и
  «Стоимость план / факт». В каждой строке `WorkshopNeed` рядом с
  планом показываем факт по POSTED `MaterialIssueLine` с тем же
  `workshopNeedId` и дельту между ними:
  - `plannedQty` = `WorkshopNeed.calculatedQty` (производственная
    потребность, не закупочная `purchaseQty`);
  - `plannedCost` = `calculatedQty * quotedPrice` (только для
    RUB-цены; для USD без курса и для пустой цены — `null`);
  - `issuedQtyFact` = Σ `MaterialIssueLine.issuedQty` по POSTED
    с `workshopNeedId === need.id` **только если** `line.unit`
    совпадает с `need.unit` — конвертация единиц в MVP не
    делается, при mismatch UI показывает короткое предупреждение
    «Ед. изм. отличаются»;
  - `actualCost` = Σ `MaterialIssueLine.totalCost` по POSTED-строкам
    с тем же `workshopNeedId` (стоимость суммируется независимо
    от unit, потому что это уже деньги);
  - DRAFT и CANCELLED документы в факт **не попадают**;
  - строки `MaterialIssueLine` без `workshopNeedId` сопоставить
    нельзя — в план/факт-таблицу они не включаются (но видны в
    блоке «Фактический расход материалов» и в финансовых
    итогах документа).

  Чтобы избежать второго fetch, `OrderNeedsTab` грузит
  `MaterialIssue` (list + per-issue details) **один раз** и
  пробрасывает массив сразу в обе цели:
  `OrderMaterialsUnifiedTable` (для агрегата плана/факта) и
  `MaterialIssuesSection` (для таблицы документов и preview
  строк).

  Frontend-итерация «Фактическая стоимость материалов в финансовой
  сводке заказа» (поверх существующих эндпоинтов): в существующей
  вкладке «Сводно по заказу» (`/admin/orders/[id]?tab=costSummary`,
  `OrderSummaryUnifiedTable` → `TotalsBlock`) рядом с уже
  существующей строкой «Материалы за тираж» (план) показываются
  две новые строки — «Материалы за тираж · факт» и «Материалы за
  тираж · Δ (факт − план)». Для order-level financial summary:
  - `actualMaterialCost` = Σ `MaterialIssue.totalCost` по всем
    POSTED-документам этого заказа (источник истины —
    `MaterialIssue.totalCost`, а не пересчёт строк на frontend);
  - DRAFT и CANCELLED документы **не учитываются**;
  - в сводку входят POSTED-документы **без `passportId`** и
    POSTED-строки **без `workshopNeedId`** — на финансовом уровне
    важен именно факт денег, выданных в производство по заказу;
  - `plannedMaterialCost` берётся из существующего расчёта
    (Σ материалов в RUB по `OrderCostEstimate`-snapshot или
    fallback по `WorkshopNeed`, как и до этой итерации);
  - `deltaMaterialCost = actualMaterialCost − plannedMaterialCost`,
    `null` если плана нет (тогда UI показывает «—»). Тон строки Δ:
    перерасход — danger, экономия — success, ровно по плану —
    neutral.

  Загрузка `MaterialIssue` для финансовой сводки идёт через
  существующий `GET /api/orders/:orderId/material-issues` в
  server-loader самого `OrderSummaryUnifiedTable` — без нового
  backend-эндпоинта и без fetch внутри глубоко вложенного
  client-компонента.

  Backend-итерация «Фактическая стоимость материалов в
  production cost по периоду» (`apps/api/src/modules/costs/costs.service.ts`,
  `GET /api/costs/production`, контракт
  `packages/shared/src/costs.ts`): `CostsService.getProductionCost`
  теперь добавляет к каждому дню и к итогу отдельную сумму
  `materialCost` и включает её в `totalCost = pieceworkCost +
  salaryCost + materialCost`.
  - `materialCost[day]` = Σ `MaterialIssue.totalCost` по
    `POSTED`-документам, у которых `passportId` входит в
    множество паспортов, упакованных в этот день
    (`PACKED`-event внутри окна периода);
  - `DRAFT` / `CANCELLED` документы **не учитываются**;
  - `MaterialIssue` без `passportId` (order-level) сознательно
    **не включаются** в production cost по периоду — без
    привязки к паспорту нельзя корректно разнести расход по
    дню выпуска. Они по-прежнему видны в order-level финансовой
    сводке заказа (предыдущая итерация);
  - сервис использует `MaterialIssue.totalCost` (server-side
    агрегат, пересчитываемый при `POST /:id/post`) — строки
    `MaterialIssueLine` без `workshopNeedId` не мешают, потому
    что сервис их и не читает;
  - frontend-страница `/production-cost` пока **не показывает**
    отдельную колонку «Материалы»: новое поле появилось в
    response аддитивно и UI рендерит существующие колонки без
    изменений (см. `apps/web/app/production-cost/page.tsx`).
  `ProductionCostV2Service` на этой итерации **не менялся** —
  управленческий P&L по-прежнему берёт материалы из расчётной
  основы (`OrderCostEstimate` / `WorkshopNeed`), а не из
  `MaterialIssue`.

  Эта итерация **не меняет** `OrderViewTabs` /
  `OrderMaterialsUnifiedTable` / `OrderSummaryUnifiedTable` /
  `MaterialIssuesSection` и не добавляет новых страниц,
  вкладок, секций или пунктов меню.

  Backend-итерация «Автосписание материалов при выдаче кроя»
  (см. `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
  `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
  `prisma/schema.prisma::MaterialIssue.source / sourceKey`):
  автосписание управляется hardening-флагом
  `CompanySettings.autoIssueMaterialsOnCutRelease` (Boolean,
  default `false`). Если флаг **выключен**, выдача кроя
  (`POST /api/passports/:id/issue`) НЕ создаёт `MaterialIssue` —
  работают только события паспорта, статус, `currentEmployee` и
  учёт `CutReleasePolicy` / `OrderCutIssueRule`. Если флаг
  **включен**, при успешной выдаче в той же транзакции создаётся
  автоматический **POSTED** `MaterialIssue` с `source = AUTO_CUT_ISSUE`
  и `sourceKey = AUTO_CUT_ISSUE:<passportId>`. Если строки
  `CompanySettings` ещё нет (свежая БД), сервис трактует это как
  `false` и не создаёт singleton-строку — настройка остаётся
  явным действием владельца проекта. Default `false` сознательно:
  после миграции production поведение не меняется само. UI для
  управления флагом на этой итерации **не реализован** —
  публичный DTO/PATCH `/api/company-settings` это поле не
  принимает; backend читает значение через приватный getter
  `CompanySettingsService.getAutoIssueMaterialsOnCutRelease()`. Документ содержит по одной строке
  `MaterialIssueLine` на каждую **материальную** строку
  `WorkshopNeed` заказа (исключаются `status = CANCELLED` и
  `sourceType = ORDER_APPLICATION` — нанесения это не материал для
  кроя). Для каждой строки:
  - `issuedQty = WorkshopNeed.calculatedQty * Passport.qtyCut / totalOrderQty`
    (Decimal(14,4)), где `totalOrderQty = Σ OrderItem.qtyPlan` —
    расход распределяется пропорционально доле паспорта в общем
    количестве изделий заказа, а не списывается целиком на первый
    паспорт;
  - `unitCost = WorkshopNeed.quotedPrice` при валюте `RUB`/`null`;
    для `USD` и отсутствующей цены — `unitCost = 0` (конвертация
    валют на этой итерации не делается);
  - `totalCost = issuedQty * unitCost` (Decimal(14,2));
  - `workshopNeedId` проставлен, `cellId = null`, `comment =
    «Автоматически при выдаче кроя»`;
  - `createdById = postedById = employeeId` (сотрудник, получивший крой).

  Идемпотентность (повторный `issueToEmployee` / retry не создаёт
  дубля):
  - UNIQUE-индекс `MaterialIssue.sourceKey` ловит дубль на уровне БД;
  - перед вставкой сервис дополнительно проверяет, нет ли уже
    неотменённого (`DRAFT`/`POSTED`) `MaterialIssue` по этому
    `passportId` — если менеджер успел создать ручной документ, авто-
    списание skip-ается (чтобы не было двойного расхода);
  - при `CANCELLED` авто-документе повторный авто skip-ается по
    sourceKey (сознательное ограничение MVP: сторнирование /
    возвраты в этой итерации не делаем).

  Устойчивость (ТЗ §9 «Ошибки и устойчивость»):
  - если у заказа нет материальных `WorkshopNeed`, все
    `calculatedQty` пропорционально дают `0`, `totalOrderQty <= 0`
    или паспорт уже получил неотменённый `MaterialIssue` —
    `issueToEmployee` проходит успешно и авто-документ **не
    создаётся**. В логах пишется `event=material_issue.auto.skip
    reason=...`;
  - блокируем `issueToEmployee` только при технических ошибках
    (Prisma constraint / целостность). Отсутствие цены / отсутствие
    подходящей WorkshopNeed — это мягкий кейс, не блокирует выдачу
    кроя.

  Audit: в той же транзакции пишутся `MATERIAL_ISSUE_CREATED` и
  `MATERIAL_ISSUE_POSTED` с `entityType = MATERIAL_ISSUE`,
  `entityId = MaterialIssue.id`, payload содержит `source`,
  `sourceKey`, `status = POSTED`, `totalCost`, snapshot `lines`,
  `employeeId`, `calculation = { totalOrderQty, passportQtyCut,
  formula }`.

  Downstream-эффекты через уже существующую логику (никакой
  повторной работы в этой итерации):
  - `CostsService` подхватывает авто-документы как POSTED
    `MaterialIssue` с `passportId` и включает их в production cost
    по периоду (см. предыдущую итерацию);
  - order-level financial summary (`OrderSummaryUnifiedTable`)
    уже суммирует `MaterialIssue.totalCost` по всем POSTED-документам
    заказа — авто-документы попадают туда автоматически;
  - `OrderMaterialsUnifiedTable` (план/факт по `WorkshopNeed`)
    уже агрегирует POSTED `MaterialIssueLine` с `workshopNeedId` —
    авто-строки видны рядом с планом без доработок.

  Сознательные границы MVP (не менялись на итерации авто-списания):
  `MaterialStockLot` / FIFO/LIFO / проверка складских остатков /
  master-модель `Material` / новые роли / новые страницы и пункты
  меню / ручной UI-блок для авто-документа / POSTED → CANCELLED
  отмена / UI для управления флагом `autoIssueMaterialsOnCutRelease`
  — **не реализованы**. Цена берётся из `WorkshopNeed.quotedPrice`
  (fallback `0`); `ProductionCostV2Service` / frontend UI
  (`OrderViewTabs` / `MaterialIssuesSection` /
  `OrderMaterialsUnifiedTable` / `OrderSummaryUnifiedTable`) —
  **не менялись**.

  **Foundation складского учёта материалов** (отдельная итерация,
  `apps/api/src/modules/stock/*`, `prisma/schema.prisma::StockBalance` /
  `StockMovement`):
  - добавлены таблицы текущего остатка и журнала движений; материал
    в MVP идентифицируется через **`WorkshopNeed`** (общего master
    `Material` нет);
  - уникальность строки остатка обеспечивает поле **`balanceKey`**
    (`${workshopNeedId}:NO_WAREHOUSE|<id>:NO_CELL|<id>`), чтобы не
    плодить дубли при `NULL` в `warehouseId` / `cellId`;
  - **`StockService`**: `getOrCreateBalanceInTx`, `applyMovementInTx`,
    `listBalances`, `listMovements`; отрицательный физический остаток
    на foundation **не блокируется**; стоимость на остатке —
    средневзвешенная на `IN` и пропорционально текущей средней на
    `OUT` (без FIFO/LIFO);
  - **бизнес-потоки не подключены**: `PurchaseReceipt` / приёмка **не**
    увеличивают `StockBalance`, `MaterialIssue` (включая POST и авто
    при выдаче кроя) **не** уменьшают остаток, `PassportsService` /
    `CostsService` **не** читают склад; публичных REST-роутов под остатки
    нет.

  По-прежнему **не реализованы**: `MaterialStockLot`, FIFO/LIFO,
  master-модель `Material`, роли `WAREHOUSE_MANAGER` / `PURCHASER` /
  `ACCOUNTANT`, обновление `ProductionCostV2Service` под склад,
  любые другие финансовые сводки (`OrderPlannedCostSummaryCard`) под
  эту ось — вынесены в следующие итерации.

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
