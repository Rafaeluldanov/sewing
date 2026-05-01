# Документация — Система управления швейным производством

> ⚠️ **PHASE 2 — CORE DOCS (2026-Q2)** ⚠️
>
> Документация перестраивается. Часть старых документов больше **не
> является source of truth** — они оставлены для исторического
> контекста, но новые разработчики и Cursor-агенты должны опираться
> на код и на новые документы (см. таблицу статусов ниже). При
> расхождении документ старого статуса (`OUTDATED`/`DRAFT`/`ARCHIVED`)
> и кода — **верим коду**, а не документу.
>
> Источник истины:
>
> - REST-контракт — `apps/api/src/modules/**/*.controller.ts`
>   (карта собрана в `api.md`).
> - Модель БД — `prisma/schema.prisma` (карта собрана в `erd.md`).
> - Доменная логика — сервисы `apps/api/src/modules/**/*.service.ts`.
> - Runtime-flow — три новых документа:
>   [`docs/order-flow.md`](./order-flow.md),
>   [`docs/production-flow.md`](./production-flow.md),
>   [`docs/display-board.md`](./display-board.md).
>
> PHASE 1 закрыл `index.md` / `api.md` / `erd.md` / ADR-0022 /
> `flows.md` / `README.md`. PHASE 2 разнёс runtime-flow по трём
> новым самостоятельным документам (см. ниже). Полное
> переписывание `flows.md` / `domain.md` / `screens.md` /
> `events.md` остаётся в плане как PHASE 3 (после ревизии
> master-actions / audit-events).

---

## Статусы документов

Каждому документу присвоен один из четырёх статусов:

- **OK** — отражает текущий runtime-код, можно опираться без оглядки.
- **OUTDATED** — содержит устаревшие утверждения, требует ревизии;
  в спорных местах верить коду, а не документу.
- **DRAFT** — частично заполненный/новый документ, заявлен как
  будущий source of truth, но содержание ещё не финальное.
- **ARCHIVED** — исторический контекст / roadmap; в новых решениях
  на него **не опираться**.

| Файл | Статус | Комментарий |
| --- | --- | --- |
| `index.md` | **OK** | Перестроен в PHASE 1 — карта документации со статусами. |
| `api.md` | **OK** | Перестроен в PHASE 1 строго от текущих контроллеров. |
| `erd.md` | **OK** | Перестроен в PHASE 1 строго от `prisma/schema.prisma`. |
| `architecture.md` | OUTDATED | Стек/слои описаны до Patterns / Workshop-needs / Suppliers / PurchaseOrder / PurchaseReceipt / Display screens / Master / OrderApplication / OrderCostEstimate. Ревизия — PHASE 2. |
| `domain.md` | OUTDATED | Большой документ, не покрывает Patterns / WorkshopNeed / Supplier / PurchaseOrder / OrderCostEstimate / cut-readiness / cut-release-policy / master-actions / master-calls. Ревизия — PHASE 2. |
| `flows.md` | OUTDATED | Описывает старый pipeline `F0..F13`. Будет разнесён по `order-flow.md` / `production-flow.md` / `display-board.md`. Не переписывать в PHASE 1. |
| `events.md` | OUTDATED | До-Patterns модель `PassportEvent` / `AuditLog`. Не покрывает `OPERATION_SCAN` / `WTO_PASSED` / последние события. Базовая карта `PassportEvent` теперь живёт в `production-flow.md §3` (PHASE 2); этот документ остаётся OUTDATED до полного переписывания. |
| `screens.md` | OUTDATED | Карта экранов до `/admin/patterns`, `/admin/pattern-categories`, `/admin/clients`, `/admin/suppliers`, `/admin/purchase-orders`, `/admin/purchase-receipts`, `/admin/display-screens`, `/master`, `/admin/workshop-needs`, отдельных дашбордов. Ревизия — PHASE 2. |
| `ui-mobile.md` | OUTDATED | Описывает только мобильный `/work` MVP-1, без master / shopfloor / display редизайнов. |
| `ops.md` | OUTDATED | Не покрывает агентскую печатную станцию (`apps/agent`), production-cost-v2, материнские override-ы. |
| `deploy-stage.md` | OK | Релевантна для stage.teeon.ru, синхронизирована с `.env.example`. |
| `deploy-uploads-static-routing.md` | OK | nginx-роутинг `/uploads/*` остаётся актуальным. |
| `recon-soft-integration.md` | OK | Документ-«лестница» этапов внедрения; работающий план. |
| `prelaunch-cleanup-recon.md` | OK | Cleanup-план перед запуском; рабочий. |
| `production-cost-v2-recon.md` | OK | Описывает работающий `/api/admin/production-cost/v2`. |
| `operation-time-norms-recon.md` | OK | Описывает работающую модель норм времени и плана операций. |
| `payroll-cutter-compensation-recon.md` | OK | Описывает работающий B2B-процент закройщика. |
| `workshop-needs-recon.md` | OK | Описывает работающий модуль `WorkshopNeed`. |
| `pilot/*` | OK | Pilot Rollout / UAT-комплект. |
| `adr/0001..0021` | OK | Принятые ADR, исторические решения. Источник истины внутри своего scope. |
| `adr/0022-tech-cards-and-order-snapshot.md` | OK | Поправлен в PHASE 1 — снят миф «snapshot создаётся только в `OrdersService.start()`». |
| `order-flow.md` | **OK** | PHASE 2 — заказ как объект: `OrderStatus`, `startCalculation` / `completeCalculation` / `reopenCalculation` / `start` / `complete` / `cancel`, `syncOrderRouteStepsSnapshot()`, `rebuildMaterialRequirementsSnapshot()`, план операций, `OrderCostEstimate`, `WorkshopNeed`, production balance, cut-readiness, material-arrival overrides, cut-release policy, outsource (`MANUAL` / `CUT_READY`), сводная таблица «что snapshot-ится и когда». |
| `production-flow.md` | **OK** | PHASE 2 — pipeline паспорта: `PassportStatus`, `PassportEvent` / `PassportEventType`, `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`, `Box` / `BoxItem` / `PACKED`, `OperationEntry` (когда pending, когда APPROVED), `SalaryEntry` (`syncDailySalary`), master actions / master calls, связь с shopfloor buckets. |
| `display-board.md` | **OK** | PHASE 2 — большой монитор `/shopfloor/display`: `GET /api/shopfloor/display`, `DisplayScreenConfig`, DISPLAY-учётка, polling/degraded/timeout/visibility recovery, bucket mapping, `sewingColumns` / `sewingRoute (▶/✔)`, layout-цепочка `min-height: 0`, breakpoint `max-width: 1199px`, aggregation risks. |

> **Что значит OUTDATED.** Документ всё ещё внутри репозитория и
> всё ещё ссылается из ADR / комментариев в коде. Часть утверждений
> в нём корректна, часть — нет. Это **временное** состояние: ревизия
> запланирована, но вне scope PHASE 1. Не правьте OUTDATED-документ
> точечно «по дороге» — это плодит внутренние противоречия.

---

## Где что (короткая карта)

| Файл              | О чём                                                     |
| ----------------- | --------------------------------------------------------- |
| `index.md`        | Эта страница — карта документации со статусами             |
| `api.md`          | REST API, ровно те routes, что есть в контроллерах          |
| `erd.md`          | Модель БД, ровно те `model` / `enum`, что есть в Prisma     |
| `order-flow.md`   | OK — бизнес-цикл одного заказа (PHASE 2)                    |
| `production-flow.md` | OK — бизнес-цикл одного паспорта (PHASE 2)               |
| `display-board.md` | OK — большой экран `/shopfloor/display` (PHASE 2)           |
| `architecture.md` | OUTDATED — стек / слои / монорепо                          |
| `domain.md`       | OUTDATED — глоссарий и доменная модель                     |
| `flows.md`        | OUTDATED — бизнес-потоки `F0..F13`                          |
| `events.md`       | OUTDATED — событийная модель                               |
| `screens.md`      | OUTDATED — карта экранов PWA                               |
| `pilot/`          | OK — Pilot Rollout / UAT                                  |
| `deploy-stage.md` | OK — развёртывание stage (`stage.teeon.ru`)                 |
| `deploy-uploads-static-routing.md` | OK — nginx-роутинг `/uploads/*`            |
| `*-recon.md`      | OK — рабочие планы внедрения отдельных подсистем            |
| `adr/`            | OK — архитектурные решения (см. ниже)                      |

Техническая схема БД: `prisma/schema.prisma`.
Seed-данные (справочники MVP): `prisma/seed.ts`
(запуск — `npm run db:seed`; подробнее — в `README.md`,
помеченном как ARCHIVED roadmap).

---

## Домены и URL-ы

| Окружение | Web                    | API                       |
| --------- | ---------------------- | ------------------------- |
| prod      | `https://prod.teeon.ru`| `https://api.prod.teeon.ru` |
| stage     | `https://stage.teeon.ru` | `https://stage.teeon.ru/api` |
| dev       | `http://localhost:3000` | `http://localhost:3001/api` |

Источник истины для URL-ов — переменные окружения (`APP_URL`, `API_URL`,
`NEXT_PUBLIC_API_URL`); константы `DOMAIN_PROD_WEB` / `DOMAIN_PROD_API`
в `packages/shared/src/config.ts` используются только как fallback.
Хардкод `localhost` или prod-хостов в исходниках **запрещён**.

---

## ADR (ключевые решения)

- [ADR-0001 Монорепо структура](./adr/0001-monorepo-structure.md)
- [ADR-0002 Паспорт как агрегат-корень](./adr/0002-passport-as-aggregate-root.md)
- [ADR-0003 Event-sourcing lite](./adr/0003-event-sourcing-lite.md)
- [ADR-0004 Упрощённая модель ячеек](./adr/0004-simplified-cells.md)
- [ADR-0005 Моменты начисления зарплат](./adr/0005-salary-timing.md)
- [ADR-0006 План иммутабелен](./adr/0006-plan-is-immutable.md)
- [ADR-0007 Polling вместо WS на MVP](./adr/0007-polling-for-realtime.md)
- [ADR-0008 Формат QR-кодов](./adr/0008-qr-format.md)
- [ADR-0009 Один заказ — одно изделие и один цвет](./adr/0009-order-one-product-one-color.md)
- [ADR-0010 Печатная форма паспорта, текущая ячейка и условие выпуска](./adr/0010-passport-print-and-placement.md)
- [ADR-0011 Упаковка, коробки и выпуск изделия](./adr/0011-packing-and-release.md)
- [ADR-0012 Идемпотентность сдельных начислений](./adr/0012-earning-deduplication.md)
- [ADR-0013 Маппинг паспортов на этапы экрана «Цех»](./adr/0013-shopfloor-stage-mapping.md)
- [ADR-0014 Авторизация и сессии (MVP 1.1)](./adr/0014-auth-and-sessions.md)
- [ADR-0015 Инварианты на уровне БД (MVP 1.1)](./adr/0015-db-invariants.md)
- [ADR-0016 Стратегия тестов MVP 1.1](./adr/0016-test-strategy.md)
- [ADR-0017 Equipment ↔ allowed operations (backend source of truth)](./adr/0017-equipment-allowed-operations.md)
- [ADR-0018 Закрытие раскроя по размеру через заявку](./adr/0018-cutting-closure-request.md)
- [ADR-0019 Склады как управленческая группировка ячеек](./adr/0019-warehouses.md)
- [ADR-0020 Управленческий блок «Операции» и единая модель тарифов](./adr/0020-operation-pricing-model.md)
- [ADR-0021 Дневной оклад от факта смены (`SalaryEntry`)](./adr/0021-shift-day-salary.md)
- [ADR-0022 Техкарты и snapshot потребностей на заказе](./adr/0022-tech-cards-and-order-snapshot.md)
  (поправлен в PHASE 1: snapshot создаётся через
  `OrdersService.syncOrderRouteStepsSnapshot()` в
  `create`/`update`/`recalculateOperationPlan`/`startCalculation`,
  а не только в `start()`; в `start()` остаётся defensive fallback).

---

## Ключевые документы PHASE 2

PHASE 1 закрыл «кровотечение» в `index.md` / `api.md` / `erd.md` /
ADR-0022 / `flows.md` / `README.md`. PHASE 2 разнёс runtime-flow по
самостоятельным документам — каждый со своим узким scope:

- [`docs/order-flow.md`](./order-flow.md) — **OK** — заказ как
  объект: `OrderStatus`, переходы (`startCalculation` /
  `completeCalculation` / `reopenCalculation` / `start` /
  `complete` / `cancel`), `syncOrderRouteStepsSnapshot()`,
  `rebuildMaterialRequirementsSnapshot()`, план операций,
  `OrderCostEstimate`, `WorkshopNeed`, production balance,
  cut-readiness, material-arrival overrides, cut-release policy,
  outsource (`MANUAL` / `CUT_READY`), сводная таблица «что
  snapshot-ится и когда».
- [`docs/production-flow.md`](./production-flow.md) — **OK** —
  pipeline паспорта: `PassportStatus`, `PassportEvent` /
  `PassportEventType`, `OPERATION_SCAN`, `QC_PASSED`,
  `WTO_PASSED`, `Box` / `BoxItem` / `PACKED`, `OperationEntry`
  (когда pending, когда APPROVED — финальный апрув на
  `Box.close()`, не на add-passport), `SalaryEntry`, master
  actions / master calls, связь с shopfloor buckets.
- [`docs/display-board.md`](./display-board.md) — **OK** —
  большой монитор `/shopfloor/display`: `GET /api/shopfloor/display`,
  `DisplayScreenConfig`, DISPLAY-учётка, polling
  (`POLL_INTERVAL_MS = 3000` / `POLL_INTERVAL_DEGRADED_MS = 15000`
  / `FETCH_TIMEOUT_MS = 6000`), degraded/offline/auth/visibility
  recovery, bucket mapping, `sewingColumns` /
  `sewingRoute (▶/✔)`, layout-цепочка `min-height: 0`,
  breakpoint `max-width: 1199px`, aggregation risks.
- [`docs/api.md`](./api.md) — обновлён, уже OK (PHASE 1).
- [`docs/erd.md`](./erd.md) — обновлён, уже OK (PHASE 1).
- [`docs/events.md`](./events.md) — OUTDATED. Базовая карта
  `PassportEvent` / `AuditLog` теперь живёт в
  `production-flow.md §3` и `order-flow.md §3`. Полное
  переписывание `events.md` — после ревизии master-actions и
  audit-events, отдельным шагом.
- `docs/deployment.md` (TODO PHASE 3) —
  сводный документ по deploy (сейчас распылён между
  `deploy-stage.md` и `deploy-uploads-static-routing.md`).

---

## Как развивать документацию

Правило **docs-first**:

1. Любое существенное изменение бизнес-логики или архитектуры сначала
   описывается здесь или в новом ADR.
2. Потом правится `prisma/schema.prisma` / API / UI.
3. PR без обновлённой документации — не мержим.

Формат ADR: `NNNN-kebab-title.md`. Нумерация монотонная.

---

## Порядок разработки (чек-лист MVP)

Соответствует ТЗ §20.

- [x] **Шаг 1.** Архитектура + Prisma schema
- [x] **Шаг 2.** Docs (architecture / domain / flows / events / erd / api / screens / ADR)
- [x] **Шаг 3.** Seed-данные (размеры, операции, продукты, демо-сотрудники, оборудование, ячейки, базовые PieceRate)
- [x] **Шаг 4.** Заказы (CRUD + блокировка плана + управленческий dashboard по заказу)
- [x] **Шаг 5.** Паспорт (выпуск на `CUT_DIVISION` + QR + печатная форма + размещение в ячейке + факт раскроя в агрегатах заказа). Начисление раскройщику и PDF-рендер — на следующих шагах (см. [ADR-0010](./adr/0010-passport-print-and-placement.md), `flows.md §F2`).
- [x] **Шаг 6.** Сотрудники, смены, оборудование, перемещения (выбор демо-сотрудника, старт/стоп смены на оборудовании, выдача кроя из ячейки, сканирование паспорта на операции, событие `OPERATION_SCAN`). Начисление пошива остаётся PENDING (см. `flows.md §F3a/F4`).
- [x] **Шаг 7.** ОТК и фиксация брака (справочник `DefectType`, `PassportDefect`, `qtyDefect/qtyGood` в паспорте, агрегат `qtyDefectTotal` по заказу, событие `DEFECT_RECORDED`, экраны `/qc` и `/qc/passports/[id]`). Виновная операция, возврат брака в производство и split паспорта — за рамками MVP.
- [x] **Шаг 8.** ВТО + упаковка + выпуск изделия. ВТО — обычный `OPERATION_SCAN` на операцию `WTO` через `/api/passports/:id/scan` (отдельного API нет, см. ADR-0011). Упаковка — `Box`/`BoxItem`, добавление паспорта в коробку = выпуск (`Passport.status = PACKED`, `PassportEvent(PACKED)`, агрегат `qtyFinishedTotal` по заказу). Экраны `/packing` и `/packing/boxes/[id]`. Апрув `OperationEntry(PENDING)`, расчёт зарплаты и сплит коробок — на Шаге 9+.
- [x] **Шаг 9.** Сдельная зарплата (минимум): модель `OperationEntry` расширена `approvalMode` / `sourceEventType` / уникальным индексом идемпотентности (ADR-0012); раскройщик получает `IMMEDIATE`-начисление в транзакции `PassportsService.create`, пошив — `PENDING_RELEASE` в транзакции `scanOnOperation` и `APPROVED` в транзакции `PackingService.close` (через `EarningsService.approvePendingForPassport` по каждому `BoxItem.passportId`; финальный апрув переехал с `addPassport` на `close` — ADR-0005 §«Подтверждение», ADR-0011 §5, `docs/production-flow.md §10.4`/§11.3). API `/api/earnings`, `/api/earnings/summary`, `/api/passports/:id/earnings`; UI `/earnings` + блок «Начисления» в `/passports/[id]`. Окладная часть, ведомость за месяц, удержания за брак, экспорт и интеграция с 1С/ЗУП — за рамками MVP.
- [x] **Шаг 10.** Экран «Цех» (`/shopfloor`) — управленческая доска `размер × этап → qty` поверх существующих агрегатов (orders + passports + qc + packing). Серверная проекция `ShopfloorService` (`GET /api/shopfloor/state`), без новой материализованной витрины и без новых событий: stage buckets выведены из `Passport.status`, `Passport.currentOperation.category` и `BoxItem.box.closedAt` (см. [ADR-0013](./adr/0013-shopfloor-stage-mapping.md)). Polling `3 сек` (ADR-0007), на изменении значений в ячейке — короткая flash-подсветка (зелёный = «приехало», красный = «уехало»). Полноценная анимация перелёта паспорта и дашборд начальника — за рамками MVP.
- [x] **Шаг 12 (Pilot Rollout / UAT / Bugfix Sprint).** Подготовка к
  реальному запуску в цехе. Не вводит новых модулей. Добавлены:
  пакет документации `docs/pilot/` (rollout-plan, onboarding,
  operator-checklist, FAQ, шаблон сбора фидбека); сквозной
  `requestId` в логах и в каждом ответе ошибки (см. `api.md §13`);
  лёгкий операционный эндпоинт `GET /api/admin/overview` (активные
  смены, открытые коробки, паспорта в работе/в ячейках, события
  за 24ч; см. `api.md §11a`) и компактная страница `/admin/overview`
  для начальника цеха. Quick-fix-пакет: автофокус и быстрый reset
  на `/work`, единая краткая русская формулировка ошибок,
  явные guard-ы (двойной скан = no-op, повторная упаковка
  блокируется, нельзя работать без активной смены, qty не уходит
  в минус). Расширенные тесты: `pilot-flow.test.ts` с double-scan
  stress, rapid issue+scan и pack-after-defect.

- [x] **Equipment configuration (post-Шаг 13).** Связь
  `Equipment ↔ Operation` вынесена из фронтового хардкода по префиксу
  `Equipment.code` в нормальную M2M-таблицу `EquipmentOperation`
  (см. [ADR-0017](./adr/0017-equipment-allowed-operations.md),
  `domain.md §5c`, `erd.md §2.5a`, `api.md §3a`). Источник истины —
  backend; `/api/shifts/meta` отдаёт у каждой единицы оборудования
  `allowedOperationIds`, `/work` использует только их. Управление —
  `/admin/equipment` и `/admin/equipment/[id]` (роли `ADMIN`,
  `SHOP_MANAGER`, см. `screens.md §10`).

- [x] **Equipment displayNumber + печатная QR-этикетка.** У
  `Equipment` появился ручной `displayNumber String?` (см.
  `domain.md §5c`, `erd.md §2.5`, `api.md §3a`, `screens.md §10a`)
  для физической маркировки станков. В админке его видно списком,
  редактируется на карточке, оттуда же печатается этикетка
  `GET /api/equipment/:id/print` — A6-страница с крупным `№` и QR
  `equipment:{id}` (формат ADR-0008 не меняется). Эндпоинт `@Public()`
  — той же логикой, что у `/api/passports/:id/print`. PATCH-ручка
  `PATCH /api/equipment/:id` — `ADMIN` / `SHOP_MANAGER`.

- [x] **Equipment CRUD (post-Шаг 14).** На `/admin/equipment`
  появилась форма создания нового станка (`POST /api/equipment` с
  `name` обязательным, `code` опциональным — slug автогенерируется
  из имени, `displayNumber` и `operationIds` опциональны). На
  карточке `/admin/equipment/[id]` добавлена секция «Название
  оборудования» — `PATCH /api/equipment/:id` теперь принимает и
  `name`, и `displayNumber`. `code`/`qrCode` через PATCH сознательно
  не меняются — printer-bindings и уже напечатанные QR-этикетки
  переживают переименование. Роли — `ADMIN`/`SHOP_MANAGER` (см.
  `api.md §3a`, `screens.md §10a`).

- [x] **Warehouses (post-Шаг 14).** Управленческая группировка ячеек
  физического хранения. Новая сущность `Warehouse(name UNIQUE,
  code UNIQUE NULL, isActive)` и nullable `Cell.warehouseId` с FK
  `ON DELETE SET NULL` (см. [ADR-0019](./adr/0019-warehouses.md),
  `domain.md §16`, `erd.md §2.13a`). Backend как источник истины:
  CRUD `/api/warehouses` + узкий `PATCH /api/cells/:id { warehouseId }`
  (`api.md §15`), всё под `ADMIN`/`SHOP_MANAGER`. UI — `/admin/warehouses`
  (список + создание) и `/admin/warehouses/[id]` (реквизиты + ячейки
  + блок «Привязать ячейку», см. `screens.md §10b`); тайл «Склад» на
  главной только для менеджеров. QR-этикетка ячейки —
  `GET /api/cells/:id/print` (`@Public()` HTML A6, payload `cell:{id}`
  по ADR-0008 не меняется). Существующий flow «scan cell → place
  passport» специально оставлен 1:1 — `Cell.warehouseId` nullable,
  `POST /api/cells/by-code` и `POST /api/passports/:id/place`
  работают как раньше.

- [x] **Operations management & unified pricing (post-Шаг 17).**
  Управленческий блок «Операции» как нормальная админ-сущность.
  На `Operation` добавлены `pricingMode` (`FIXED` / `BY_SIZE` /
  `SALARY_ONLY`), `fixedRate`, `updatedAt`; новая таблица
  `OperationRateBySize(operationId, sizeId, rate)` с
  `UNIQUE (operationId, sizeId)` и `ON DELETE CASCADE` от
  `Operation` (см. [ADR-0020](./adr/0020-operation-pricing-model.md),
  `domain.md §4`/§4a, `erd.md §2.3`/§2.3a). Backend как источник
  истины: CRUD `/api/operations` под `ADMIN`/`SHOP_MANAGER`
  (`api.md §15a`), единый helper
  `OperationsService.resolveRate(operationId, sizeId)` —
  единственный источник ставки для earnings (`FIXED` →
  `fixedRate`, `BY_SIZE` → `OperationRateBySize.rate`,
  `SALARY_ONLY` → `null`/skip). `EarningsService` (раскрой и
  пошив) переведён на `resolveRate`; старая `findRate` поверх
  `PieceRate` и константа `PIECEWORK_OPERATION_CODES` удалены из
  runtime. UI — `/admin/operations` (список + создание) и
  `/admin/operations/[id]` (адаптивная форма под `pricingMode`,
  с быстрой кнопкой «Заполнить всем одну ставку» для `BY_SIZE`,
  см. `screens.md §10c`); тайл «Операции» на главной только для
  менеджеров. Миграция бэкфилит данные из `PieceRate` (саму
  таблицу оставляем для аудита/rollback). Существующий pipeline
  выпуска паспорта / scan / упаковки / earnings — без изменений,
  все 249 интеграционных и smoke-тестов зелёные
  (`tests/integration/operations.test.ts` — 20 новых сценариев,
  включая RBAC и интеграцию с earnings).

- [x] **Shift-day salary (post-Шаг 18).** Управленческая модель
  оклада «была смена в день → платим ставку за день» как параллельный
  контур к сдельщине (`OperationEntry` не трогается). На `Employee`
  добавлены `compensationType` (`PIECEWORK` / `SALARY` / `MIXED`,
  default `PIECEWORK`) и `salaryPerShift Decimal?`; новая таблица
  `SalaryEntry(employeeId, date, amount, source, editedManually,
  managerComment, editedByEmployeeId)` с уникальным
  `(employeeId, date, source)` (см. [ADR-0021](./adr/0021-shift-day-salary.md),
  `domain.md §9a`, `erd.md §2.13b`). Backend как источник истины:
  `SalaryService.syncDailySalary` дёргается из `ShiftsService.start/stop`
  и идемпотентно создаёт/обновляет одну запись в день, не трогая
  суммы с `editedManually = true`. API — `/api/salary` (list/summary)
  + `PATCH /api/salary/:id` для `SHOP_MANAGER`/`ADMIN` (ручная правка
  суммы и комментария, либо `reset = true` чтобы вернуть под
  автоматику; см. `api.md §10a`); `/api/employees` (list/get/PATCH,
  только менеджер; `api.md §3b`). UI — `/admin/employees`
  (список + карточка с инлайн-редактированием `compensationType` /
  `salaryPerShift` / `active`, см. `screens.md §10d`) и блок
  «Окладные начисления» в `/earnings` с инлайн-кнопками «Исправить» /
  «Вернуть в авто» (`screens.md §12.3`). RBAC: рабочие роли видят
  только свои окладные строки и не редактируют сотрудников/суммы.
  Сдельный pipeline (выпуск паспорта / scan / упаковка / earnings)
  не меняется, все 261 интеграционный/smoke тест зелёные
  (`tests/integration/salary.test.ts` — 12 сценариев).

- [x] **Cutting closure requests (post-Шаг 14).** Новая управленческая
  цепочка «помощник раскройщика подаёт заявку — мастер подтверждает /
  отклоняет». На пару `(orderId, productId, sizeId)` живёт ровно одна
  активная (`REQUESTED`) и максимум одна финальная (`APPROVED`) заявка
  — гарантировано partial unique indexes (`erd.md §2.5b`,
  [ADR-0015](./adr/0015-db-invariants.md)). После `APPROVED` backend
  режет `POST /api/passports` ошибкой `CUTTING_CLOSED` (HTTP 409,
  `api.md §14`). Карточка паспорта (`/passports/[id]`) показывает
  блок «Закрытие раскроя» помощнику и мастеру с планом/фактом/остатком,
  на `/orders/[id]` менеджер видит баннер pending/approved заявок
  (см. [ADR-0018](./adr/0018-cutting-closure-request.md), `domain.md §15`,
  `flows.md §F13`, `screens.md §3`).

- [x] **Production cost (post-Шаг 19).** Управленческий read-only
  модуль `/production-cost` (`SHOP_MANAGER` / `ADMIN`) поверх уже
  работающего журнала. Никаких новых таблиц/событий: `CostsService`
  сводит дневные метрики выпуска (units / piecework / распределённый
  оклад / простой) из `OperationEntry`, `SalaryEntry` и
  `PassportEvent`, а `PassportDurationsService` выводит длительности
  стадий `QC` / `WTO` / `PACKING` с cap-ом `MAX_STAGE_MINUTES_PER_PASSPORT
  = 60`. Стоимость минуты = `salaryPerShift / SHIFT_MINUTES`
  (`SHIFT_MINUTES = 480`, ADR-0021), простой = `max(0, SHIFT_MINUTES
  − tracked) × minuteRate` и **не** распределяется на изделия.
  Эндпойнт — `GET /api/costs/production?dateFrom&dateTo`
  (`api.md §17`), страница — SVG-чарт + summary-карточки + таблица
  по дням (`screens.md §17`), бизнес-правила — `domain.md §17`.
  Интеграционные тесты — `tests/integration/production-cost.test.ts`,
  smoke — `tests/smoke/production-cost.smoke.test.ts`.

- [x] **Production dashboard (post-Шаг 19).** Управленческий read-only
  экран `/admin/production-dashboard` (`SHOP_MANAGER` / `ADMIN`), который
  собирает в одном ответе всё, что раньше было размазано по
  `/shopfloor`, `/production-cost`, `/admin/overview`, `/earnings` и
  `/admin/employees`. Backend — единый агрегатор
  `GET /api/dashboard/production?days=7|14|30` (`api.md §11b`); UI
  ничего не пересчитывает. Никаких новых таблиц/событий: pipeline
  через ту же `bucketOf` из shopfloor-проекции (ADR-0013); выпуск —
  по `PassportEvent(PACKED)`; себестоимость и простой по дням —
  переиспользуем `CostsService`; нагрузка по ролям —
  `PassportDurationsService` за день «to», агрегированный по
  `Employee.role` ∈ `{QC, IRONING, PACKING}`; алерты — top-items
  проблемных зон (bottleneck, role idle, employee idle, peak idle
  day, capped passports). KPI «сегодня» считаются по UTC-сегодня
  независимо от `?days=`, график и сводки `…Period` — за период.
  Экран — `screens.md §18`, доменные правила — `domain.md §17a`,
  ссылка «Дашборд» в шапке и крупный primary-тайл «Дашборд
  начальника» на главной для менеджеров. Тесты —
  `tests/integration/production-dashboard.test.ts`,
  `tests/smoke/production-dashboard.smoke.test.ts`.

- [x] **Шаг 11 (MVP 1.1, Stabilization).** Реальная авторизация (`/api/auth/login`/`logout`/`me`), session-cookie с подписью HMAC-SHA256 и `Domain=.teeon.ru`, RBAC через `AuthGuard` + `@Roles()` (см. [ADR-0014](./adr/0014-auth-and-sessions.md)). Критические инварианты на уровне БД: partial-unique для активной смены, глобальный unique на `BoxItem.passportId`, фиксация уникальности номеров и QR (см. [ADR-0015](./adr/0015-db-invariants.md)). Интеграционные/smoke-тесты на ключевой производственный поток (orders → passports → shifts → qc → packing → earnings); тесты автоматически skip-аются без `TEST_DATABASE_URL` (см. [ADR-0016](./adr/0016-test-strategy.md)). Health/Ready endpoints (`/api/health`, `/api/ready`) и `GlobalExceptionFilter` (нормализация ошибок). UI: страница `/login`, route protection через `middleware.ts`, индикация текущего пользователя и logout-action в шапке. Подробнее в `domain.md §0a`, `api.md §1`, `flows.md §F0`.

- [x] **Company settings (post-RECON).** Управленческий блок «Настройки
  компании» — singleton-реквизиты организации (`CompanySettings`) и
  soft-delete справочник «Подразделения компании» (`CompanyDivision`).
  Backend как источник истины: `CompanySettingsModule` с двумя
  контроллерами (`/api/company-settings` GET/PATCH, `/api/company-divisions`
  GET/POST/GET:id/PATCH:id) под `SHOP_MANAGER`/`ADMIN`. Singleton —
  `CompanySettings.id = "default"` + `singleton @unique`, race-safe
  идемпотентный `getOrCreate`. UI — единый экран
  `/admin/company-settings` (см. `screens.md §10h`) с тремя
  карточками реквизитов и inline-таблицей подразделений (см.
  `domain.md §16`, `erd.md §2.15`, `api.md §42`). Pinned-ссылка
  «Настройки» в футере sidebar рядом с «Выйти». Audit —
  `COMPANY_SETTINGS_UPDATED` / `COMPANY_DIVISION_CREATED` /
  `COMPANY_DIVISION_UPDATED`.

- [x] **PHASE 1 «CompanyDivision как master-справочник».**
  Подразделения компании теперь являются источником истины для
  поля «Подразделение» в карточках заказа и в конфиге display-
  экранов. Добавлены FK `Order.companyDivisionId` и
  `DisplayScreenConfig.companyDivisionId` (`onDelete: SetNull`),
  inverse-связи на `CompanyDivision`. Базовые карточки
  `MARKETPLACE` / `OTHER` гарантированно созданы миграцией
  `…_link_company_divisions_to_orders` и каждым re-seed.
  Backend (`OrdersService` / `DisplayScreensService`) синхронно
  пишет пару `(companyDivisionId, legacy division)` по `code`;
  earnings (`getCutterCompensationSchemeForDivision`) и
  shopfloor-фильтр (`?divisionCode=…` приоритетнее `?division=…`)
  работают через `CompanyDivision.code` с fallback на legacy
  enum. Legacy `enum OrderDivision`, `Order.division` и
  `DisplayScreenConfig.division` сохранены до PHASE 2 ради
  backward-compat. См. `docs/domain.md §«Подразделения заказа»`,
  `docs/display-board.md`, `docs/erd.md §«CompanyDivision»`.

---

## PR gate / Docs consistency

Каждый PR должен проходить локально и в CI:

```bash
npm run docs:check
```

Скрипт — `scripts/docs/check-docs.mjs`, без сторонних зависимостей,
запускается из workflow `Docs consistency`
(`.github/workflows/docs-check.yml`, job `docs-check`,
Node 20, `npm ci --ignore-scripts`) на `push` и `pull_request`.

Что проверяется:

- `[docs:critical]` — наличие ключевых документов
  (`api.md` / `erd.md` / `events.md` / `order-flow.md` /
  `production-flow.md` / `display-board.md` / `domain.md`).
- `[docs:erd]` — каждый top-level `enum` и `model` из
  `prisma/schema.prisma` упомянут в `docs/erd.md`.
- `[docs:api]` — каждый файл `*.controller.ts` и каждый его
  HTTP-route (`@Get` / `@Post` / `@Patch` / `@Put` / `@Delete`)
  упомянут в `docs/api.md`.
- `[docs:events]` — каждое значение `PassportEventType` (Prisma)
  и каждый член `AuditEntityType` (TS-union в
  `apps/api/src/modules/audit/audit.service.ts`) упомянут в
  `docs/events.md`.
- `[docs:links]` — все относительные markdown-ссылки и якоря в
  `README.md` + `docs/**/*.md` существуют. Проверяются:
  - `[…](path.md)` — файл должен существовать;
  - `[…](path.md#anchor)` — файл и якорь должны существовать;
  - `[…](#anchor)` — якорь в текущем файле должен существовать.

  Игнорируются: `http(s)://`, `mailto:`, `tel:`, протокол-relative
  `//…`, картинки `![…](…)`, ссылки на каталоги и не-`.md` файлы,
  содержимое fenced-code-blocks и inline-code.

Якори распознаются в двух формах:

- явные HTML: `<a id="role"></a>`, `<a id="role" />`,
  `<a name="role"></a>` — **рекомендуется для критичных
  cross-doc ссылок**, не ломаются при ревизии заголовков;
- GitHub-style heading slug
  (`## Роль документа` → `#роль-документа`,
  `## 1. Заказ` → `#1-заказ`).

### Что обновлять при изменении кода

- Добавлен/изменён Prisma `model` или `enum`
  (`prisma/schema.prisma`) → обновить `docs/erd.md`.
- Добавлен/изменён `*.controller.ts` или его route в
  `apps/api/src/modules/**` → обновить `docs/api.md`
  (как файл-контроллер, так и `METHOD /api/...`).
- Добавлено новое значение `PassportEventType`
  (`prisma/schema.prisma`) или новый член `AuditEntityType`
  (`apps/api/src/modules/audit/audit.service.ts`) →
  обновить `docs/events.md`.
- Добавлены новые секции в любой `docs/*.md`, на которые
  планируется ссылаться из других документов → ставить явный
  `<a id="..."></a>`, не полагаться только на slug заголовка.

PR без `docs:check OK` не мержится.

---

## Hard enforcement / Branch protection

`docs:check` запускается из CI (`.github/workflows/docs-check.yml`,
job `docs-check`) на каждом `push` и `pull_request`. Чтобы PR
**физически не мержился** при красном `docs-check`, статус-чек
нужно сделать обязательным на уровне репозитория — это делается
руками в GitHub UI (через API/Terraform — по желанию).

### 1. Branch protection rule для `main`

GitHub → **Settings → Branches → Add branch protection rule**

- **Branch name pattern:** `main`
- Включить:
  - ☑ **Require a pull request before merging**
    - (опционально) `Require approvals` ≥ 1
    - ☑ **Dismiss stale pull request approvals when new commits are pushed**
  - ☑ **Require status checks to pass before merging**
    - ☑ **Require branches to be up to date before merging**
    - В списке **Status checks that are required** выбрать:
      - `docs-check` *(имя job-а из `.github/workflows/docs-check.yml`)*
  - ☑ **Require review from Code Owners**
    *(только после того, как в `.github/CODEOWNERS` подставлен
    реальный GitHub username/team вместо плейсхолдера `@OWNER`)*
  - ☑ **Do not allow bypassing the above settings**
  - Если в Settings репозитория доступно — отдельно
    отключить прямой push в `main`
    (`Restrict who can push to matching branches` → пусто, либо
    только release-bot).

### 2. То же правило для `dev` (если ветка используется)

Если в проекте есть долгоживущая `dev`-ветка — повторить ту же
конфигурацию для `Branch name pattern: dev`. Если `dev` не
используется (всё в `main` через короткоживущие feature-ветки) —
шаг можно пропустить.

### 3. Важные нюансы

- **`docs-check` появится в списке required checks только после
  первого запуска GitHub Actions** на этом репозитории. Если в
  выпадающем списке его пока нет — сделайте любой PR (или push в
  ветку), дождитесь, пока workflow `Docs consistency` отработает
  хотя бы один раз, и после этого имя `docs-check` станет
  доступно для выбора.
- Имя required-чека должно совпадать с **job name**, а не с
  workflow name. Сейчас это `docs-check` (см.
  `.github/workflows/docs-check.yml` → `jobs.docs-check.name`).
  Если переименуете job — обновите branch protection.
- `Require review from Code Owners` без валидного хендла в
  `CODEOWNERS` молча не сработает: GitHub просто проигнорирует
  несуществующих овнеров. Сначала подставьте реальный
  username/team (`@your-handle` или `@org/team-slug`) — потом
  включайте чек-бокс.
- Hard enforcement распространяется и на администраторов только
  если включён **`Do not allow bypassing the above settings`**.
  Без него admin может смержить PR в обход красного `docs-check`.

### 4. Что должно лежать в репозитории

- ✅ `.github/workflows/docs-check.yml` — workflow `Docs consistency`,
  job `docs-check`, Node 20, `npm ci --ignore-scripts` →
  `npm run docs:check` (push + pull_request).
- ✅ `.github/pull_request_template.md` — чек-лист docs-consistency
  (`docs:check passed`, обновление `erd.md` / `api.md` / `events.md`
  при правке схемы / контроллеров / событий).
- ✅ `.github/CODEOWNERS` — карта ответственности за docs / api /
  prisma / shared. До подстановки реального хендла файл работает
  как документация, GitHub-овнерство неактивно.
- ✅ `scripts/docs/check-docs.mjs` — сам скрипт `docs:check`,
  без сторонних зависимостей.

### 5. Чек-лист «настроил hard enforcement»

- [ ] В `.github/CODEOWNERS` `@OWNER` заменён на реальный
      GitHub username/team.
- [ ] На `main` создан branch protection rule с required check
      `docs-check`.
- [ ] (если используется) на `dev` создан тот же branch
      protection rule.
- [ ] Включён `Require review from Code Owners`.
- [ ] Включён `Require branches to be up to date before merging`.
- [ ] Включён `Do not allow bypassing the above settings`
      (или явно решено, что admin-ы могут байпасить — задокументировать).
- [ ] Прямой push в `main` запрещён через
      `Restrict who can push to matching branches` (если доступно
      на тарифе репозитория).

---

## Не в скоупе MVP

См. `architecture.md §13`.
