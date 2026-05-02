# Доменная модель

> **Статус.** Каноническая доменная карта системы SEWING (PHASE 3.2,
> 2026-Q2). Документ переписан от кода в одну итерацию.
>
> **Источник истины — код**, не этот документ. При расхождении доки и
> кода всегда верим коду:
>
> - `prisma/schema.prisma` — модели и enum-ы;
> - `apps/api/src/modules/**` — бизнес-логика, валидаторы,
>   транзакции, идемпотентности;
> - `packages/shared/src/**` — DTO, Zod-схемы, public-контракты.
>
> Производные карты (для глубокого reference):
>
> - `docs/erd.md` — список моделей/enum-ов по доменам;
> - `docs/order-flow.md` — заказы, статусы, snapshot-механика;
> - `docs/production-flow.md` — паспорта, ОТК/ВТО, упаковка, зарплата;
> - `docs/events.md` — `PassportEvent` vs `AuditLog`, инварианты;
> - `docs/api.md` — карта routes от контроллеров.
>
> Где поведение не подтверждено кодом — ставится явная пометка
> **UNKNOWN/TODO**.

---

## Содержание

- [Роль документа](#role)
- [0. Глоссарий](#0-glossary)
- [1. Заказ](#1-order)
- [2. Маршрут и операции](#2-routes-operations)
- [3. Техкарта и материалы](#3-tech-cards)
- [4. Лекала / Patterns](#4-patterns)
- [5. Потребности цеха / WorkshopNeed](#5-workshop-needs)
- [6. Закупки / Supplier / PurchaseOrder / PurchaseReceipt](#6-procurement)
- [7. Паспорт производства](#7-passport)
- [8. ОТК / ВТО / дефекты](#8-qc-wto)
- [9. Упаковка / коробки](#9-packing)
- [10. Начисления / зарплата](#10-payroll)
- [11. Склад / ячейки](#11-warehouse)
- [12. Экран цеха / Display](#12-shopfloor)
- [13. Мастер / MasterCall / MasterActions](#13-master)
- [14. Печать / PrintJob / Agent](#14-printing)
- [15. Audit / Events](#15-audit-events)
- [16. Настройки компании](#16-company-settings)

---

<a id="role"></a>

## Роль документа

**`domain.md` — это:**

- обзорная **доменная карта** системы SEWING;
- единая точка входа, которая связывает между собой:
  - **модели данных** → `docs/erd.md`,
  - **процессы заказа и производства** → `docs/order-flow.md`,
    `docs/production-flow.md`,
  - **события и аудит** → `docs/events.md`,
  - **HTTP API** → `docs/api.md`.

**`domain.md` НЕ является:**

- источником истины по **API** — см. `docs/api.md`;
- источником истины по **структуре БД** (моделям, полям, enum-ам,
  индексам, FK) — см. `docs/erd.md`;
- источником истины по **событиям** (`PassportEvent`, `AuditLog`,
  типы, payload, инварианты) — см. `docs/events.md`;
- источником истины по **пошаговым процессам** (последовательности
  статусов, переходов, побочных эффектов) — см. `docs/order-flow.md`
  и `docs/production-flow.md`.

**Правило разрешения конфликтов.**

При расхождении между `domain.md` и специализированным документом
(`api.md` / `erd.md` / `events.md` / `order-flow.md` /
`production-flow.md`) **доверять специализированному документу**.
`domain.md` в этом случае считается устаревшим и подлежит правке.

> Источником истины по поведению при этом всё равно остаётся **код**
> (`prisma/schema.prisma`, `apps/api/src/modules/**`,
> `packages/shared/src/**`) — см. блок «Статус» в начале файла.
> Иерархия истины: **код → специализированный документ → `domain.md`**.

**Цель `domain.md`:**

- дать **целостное понимание системы** «сверху»: какие подсистемы
  существуют, за что отвечают, какими сущностями оперируют;
- показать **связи между подсистемами** (заказ ↔ маршрут ↔ техкарта
  ↔ паспорт ↔ ОТК ↔ упаковка ↔ зарплата ↔ склад ↔ аудит);
- служить навигатором по специализированным документам, а не их
  заменой.

**Связанные документы:**

- [`docs/erd.md`](./erd.md) — модели и enum-ы по доменам.
- [`docs/order-flow.md`](./order-flow.md) — заказы, статусы,
  snapshot-механика.
- [`docs/production-flow.md`](./production-flow.md) — паспорта, ОТК,
  ВТО, упаковка, зарплата.
- [`docs/events.md`](./events.md) — `PassportEvent` vs `AuditLog`,
  инварианты.
- [`docs/api.md`](./api.md) — карта HTTP-routes от контроллеров.

---

<a id="0-glossary"></a>

## 0. Глоссарий

Канонические термины (en — в коде, ru — в UI).

| Код (en)                | UI (ru)                                | Источник |
| ----------------------- | -------------------------------------- | -------- |
| `Order`                 | Заказ                                  | `prisma/schema.prisma::Order` |
| `OrderItem`             | Позиция заказа (размерная строка)      | `prisma/schema.prisma::OrderItem` |
| `Client`                | Заказчик                               | `prisma/schema.prisma::Client` |
| `OrderApplication`      | Нанесение заказа                       | `prisma/schema.prisma::OrderApplication` |
| `OrderCostEstimate`     | Расчёт себестоимости                   | `prisma/schema.prisma::OrderCostEstimate` |
| `Operation`             | Операция                               | `prisma/schema.prisma::Operation` |
| `RouteTemplate`         | Шаблон маршрута                        | `prisma/schema.prisma::RouteTemplate` |
| `OrderRouteStep`        | Шаг маршрута заказа (snapshot)         | `prisma/schema.prisma::OrderRouteStep` |
| `TechCardTemplate`      | Шаблон техкарты                        | `prisma/schema.prisma::TechCardTemplate` |
| `OrderMaterialRequirement` | Потребность материала (snapshot)    | `prisma/schema.prisma::OrderMaterialRequirement` |
| `OrderOutsourceRequirement` | Внешняя потребность (snapshot)     | `prisma/schema.prisma::OrderOutsourceRequirement` |
| `PatternItem`           | Лекало (карточка изделия)              | `prisma/schema.prisma::PatternItem` |
| `WorkshopNeed`          | Потребность цеха (рабочее место закупщика) | `prisma/schema.prisma::WorkshopNeed` |
| `Supplier`              | Поставщик                              | `prisma/schema.prisma::Supplier` |
| `PurchaseOrder`         | Заказ поставщику                       | `prisma/schema.prisma::PurchaseOrder` |
| `PurchaseReceipt`       | Приёмка поставки                       | `prisma/schema.prisma::PurchaseReceipt` |
| `Passport`              | Паспорт изделия (партия раскроя)       | `prisma/schema.prisma::Passport` |
| `PassportEvent`         | Событие движения паспорта              | `prisma/schema.prisma::PassportEvent` |
| `PassportDefect`        | Запись брака                           | `prisma/schema.prisma::PassportDefect` |
| `Box` / `BoxItem`       | Коробка / содержимое коробки           | `prisma/schema.prisma::Box`/`BoxItem` |
| `OperationEntry`        | Сдельное начисление                    | `prisma/schema.prisma::OperationEntry` |
| `SalaryEntry`           | Окладное начисление за день            | `prisma/schema.prisma::SalaryEntry` |
| `Cell` / `CellContent`  | Ячейка / содержимое ячейки             | `prisma/schema.prisma::Cell`/`CellContent` |
| `Warehouse` / `WarehouseLine` | Склад / линия (полка)            | `prisma/schema.prisma::Warehouse`/`WarehouseLine` |
| `Equipment`             | Оборудование (станок, стол с QR)       | `prisma/schema.prisma::Equipment` |
| `EquipmentOperation`    | Разрешённая операция станка (M2M)      | `prisma/schema.prisma::EquipmentOperation` |
| `Employee`              | Сотрудник                              | `prisma/schema.prisma::Employee` |
| `ShiftSession`          | Сессия смены                           | `prisma/schema.prisma::ShiftSession` |
| `MasterCall`            | Вызов мастера                          | `prisma/schema.prisma::MasterCall` |
| `DisplayScreenConfig`   | Конфиг большого монитора цеха          | `prisma/schema.prisma::DisplayScreenConfig` |
| `Printer` / `PrintJob`  | Логический принтер / задание печати    | `prisma/schema.prisma::Printer`/`PrintJob` |
| `AuditLog`              | Универсальный журнал управленческих действий | `prisma/schema.prisma::AuditLog` |
| `CutReleasePolicy`      | Политика выдачи кроя                   | `prisma/schema.prisma::CutReleasePolicy` |
| `OrderCutIssueRule`     | Очередь выдачи кроя по размерам        | `prisma/schema.prisma::OrderCutIssueRule` |
| `CuttingClosureRequest` | Заявка на закрытие раскроя по размеру  | `prisma/schema.prisma::CuttingClosureRequest` |

Полный список enum-ов и их значений — `docs/erd.md §1`.

### Роли (`enum Role`)

`SHOP_MANAGER`, `CUTTER`, `CUTTER_ASSISTANT`, `SEAMSTRESS`, `QC`,
`IRONING`, `PACKING`, `ADMIN`, `DISPLAY`, `SHOPFLOOR_MASTER`
(`prisma/schema.prisma::Role`). `ADMIN` глобально проходит любой
`@Roles(...)` (`apps/api/src/modules/auth/roles.guard.ts`).

### Аутентификация и сессии

С MVP 1.1 любая бизнес-операция выполняется от лица конкретного
сотрудника:

- `Employee.pinHash` — `bcrypt(password)` (`apps/api/src/modules/auth/auth.service.ts`);
- HttpOnly cookie `sewing_session` (HMAC-SHA256, ADR-0014);
- `AuthGuard` загружает «свежие» поля Employee на каждом запросе
  (роль/активность не кешируются);
- `@Roles(...)` — RBAC на уровне контроллера/метода.

См. `docs/api.md §1`, ADR-0014.

---

<a id="order"></a>
<a id="1-order"></a>

## 1. Заказ

### 1.1 Сущность `Order`

Источник: `prisma/schema.prisma::Order`,
`apps/api/src/modules/orders/orders.service.ts`,
`apps/api/src/modules/orders/orders.controller.ts`,
`docs/erd.md §2.2`, `docs/order-flow.md §1`.

Корневой агрегат «план производства». Один заказ = одно изделие × один
цвет (ADR-0009: `OrderItem.productId` указывает на «технический»
Product, который автоматически создаётся под лекало через
`OrdersService.ensureLegacyProductForPattern()`; `Order.color` живёт
на самом заказе).

Ключевые поля:

- `number` (uniq, формат `O-YYYYMMDD-NNNN`),
- `clientId? → Client`, `customer` (legacy свободный текст),
- `orderDate`, `dueDate?`, `color?`, `comment?`,
- `companyDivisionId? → CompanyDivision` (master-справочник
  подразделений заказа, см. §12.3);
- `status: OrderStatus @default(DRAFT)` (см. §1.2);
- `routeTemplateId? → RouteTemplate` (опционально, см. §2);
- `techCardId? → TechCardTemplate` (опционально, см. §3);
- `patternItemId? → PatternItem` (`onDelete: SetNull`, см. §4);
- snapshot-поля лекала: `patternNameSnapshot?`,
  `patternArticleSnapshot?`, `patternPreviewSnapshotUrl?`;
- snapshot-поля себестоимости: `costEstimateTotalRub?`,
  `costEstimateCompletedAt?`, `costEstimateVersion?`;
- snapshot-поля плана операций: `operationCostPlanRub?`,
  `operationTimePlanSec?`, `operationPlanCalculatedAt?`,
  `operationPlanWarnings: Json?`;
- цена продажи: `customerUnitPrice?`, `customerCurrency?`
  (управленческое поле, не входит в расчёт себестоимости);
- индексы: `status`, `orderDate`, `createdAt`, `routeTemplateId`,
  `techCardId`, `patternItemId`, `companyDivisionId`, `clientId`,
  `dueDate`.

`OrderItem` — строка по размеру:
`(orderId, productId, sizeId)` UNIQUE, `qtyPlan: Int` (план в
штуках). Один заказ — один `productId` (валидируется в
`OrdersService.create/update`, инвариант ADR-0009).

### 1.2 `OrderStatus`

Источник: `prisma/schema.prisma::enum OrderStatus`,
`docs/order-flow.md §2`.

```
DRAFT → CALCULATION → CALCULATION_DONE → IN_PRODUCTION → DONE
                                                    ↘ CANCELLED
```

| Статус              | Семантика                                                                                  | Кто переводит |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| `DRAFT`             | План редактируется (изделие/маршрут/техкарта/лекало/размеры).                              | `OrdersService.create` (default) |
| `CALCULATION`       | Менеджер запустил расчёт. Backend собирает `WorkshopNeed[]`, snapshot-ы заморожены.        | `OrdersService.startCalculation` |
| `CALCULATION_DONE`  | Расчёт завершён, активен `OrderCostEstimate(status=COMPLETED)`.                             | `OrderCostEstimatesService.completeCalculation` |
| `IN_PRODUCTION`     | Запущен в производство. План полностью иммутабелен (ADR-0006).                             | `OrdersService.start` |
| `DONE`              | Завершён вручную. **`AuditLog` не пишется** (`docs/events.md §5.2`, UNKNOWN/TODO осознанно ли это).  | `OrdersService.complete` |
| `CANCELLED`         | Отменён вручную. **`AuditLog` не пишется** (`docs/events.md §5.2`, UNKNOWN/TODO).         | `OrdersService.cancel` |

Postgres-enum расширяется только через `ALTER TYPE … ADD VALUE`,
поэтому `CALCULATION_DONE` лежит после `IN_PRODUCTION`/`DONE`/
`CANCELLED` по порядковому номеру в БД — UI-порядок задаётся явно через
`ORDER_STATUSES` в `@sewing/shared/orders`.

`PATCH /api/orders/:id` валидирует «опасные» поля
(`items`, `productId`, `routeTemplateId`, `techCardId`,
`patternItemId`, `companyDivisionId`) и допускает их к изменению
**только в `DRAFT`**. На любом другом статусе —
`OrderLockedException` (409 `ORDER_LOCKED`). Если в DTO передан
`status`, сервис делегирует переход в соответствующий метод
(`startCalculation` / `start` / `complete` / `cancel`).

### 1.3 Snapshot-механика заказа

Идея (ADR-0006, ADR-0022): после `start()` план иммутабелен. Чтобы UI и
расчёты (`WorkshopNeed`, `OrderOperationPlan`) видели актуальные
данные **до** запуска, используются «синхронизаторы», поддерживающие
snapshot в согласованном виде на каждом важном переходе. Подробная
сводная таблица — `docs/order-flow.md §12`.

> **Снятие старого утверждения.** Раньше доменная карта говорила, что
> snapshot «создаётся в `OrdersService.start()`» — это устаревшая
> формулировка. В реальности у заказа сейчас **четыре** независимых
> snapshot-сущности, и каждая фиксируется/синхронизируется в
> нескольких точках жизненного цикла, не только в `start`. Текущее
> поведение задокументировано в `docs/order-flow.md §4` и
> `OrdersService.{create,update,startCalculation,start,recalculateOperationPlan}`.

| Snapshot                              | Источник                          | Где впервые фиксируется / пересинхронизируется |
| ------------------------------------- | --------------------------------- | --------------------------------------------- |
| `OrderRouteStep[]`                    | `RouteTemplate.steps[]` через `RoutesService.getActiveStepsForSnapshot` | `OrdersService.create` (если есть `routeTemplateId`); `update` в DRAFT при смене items/route/pattern; `recalculateOperationPlan`; `startCalculation`; defensive в `start` (только если `count === 0`). См. `docs/order-flow.md §4.1`. |
| `OrderMaterialRequirement[]`          | `TechCardMaterialLine[]` через `TechCardsService.getLinesForSnapshot` + `Order.color` | `OrdersService.create` (если есть `techCardId`); `update` в DRAFT при смене items/techCard и в DRAFT/CALCULATION/CALCULATION_DONE при смене `Order.color`; `startCalculation` (`rebuildMaterialRequirementsSnapshot`); defensive в `start`. См. `docs/order-flow.md §4.2`. |
| `OrderOutsourceRequirement[]`         | `TechCardOutsourceLine[]`         | Только в `start()` (defensive `count === 0`). Точечно правится только `executionStatus` через action-эндпоинт. |
| `Order.patternNameSnapshot/...`       | `PatternItem` (имя/артикул/превью) | Первый из `startCalculation` или `start`, при `!Order.patternNameSnapshot`. На повторных запусках НЕ перезаписывается. |
| `Order.operationCostPlanRub/...`      | `OrderOperationPlanService.calculateForOrder` | `create`; `update` в DRAFT при смене items/route/pattern; `recalculateOperationPlan`; `startCalculation`. После `start` immutable. |
| `Order.costEstimateTotalRub/...`      | Активный `OrderCostEstimate(status=COMPLETED)` | `completeCalculation`. На `reopenCalculation` обнуляется в `null`; на `cancel` сохраняется. |

Во время `start()` snapshot-ы материалов и outsource-строк работают
**только как defensive fallback** для legacy-заказов, у которых ещё
не материализован snapshot до этого перехода. Основной путь —
синхронизация в `startCalculation` и предыдущих переходах.

### 1.4 `OrderApplication` — нанесения заказа

Источник: `prisma/schema.prisma::OrderApplication`,
`apps/api/src/modules/order-applications/*`,
`docs/api.md §14`.

Свободный список нанесений на изделие или крой (шелкография / DTF /
вышивка / термотрансфер / сублимация). Поля: `type` (свободная
строка), `stage: 'CUT_PARTS' | 'FINISHED_ITEM'`, `placement?`,
`widthMm?`, `heightMm?`, `colorsCount?`, `quantity?`, `unit`,
`colorText?`, `description?`, `comment?`, `fileUrl?`, `status:
'PLANNED' | 'SENT' | 'DONE' | 'CANCELLED'` (свободная строка,
валидируется Zod).

Ручка `PUT /api/orders/:id/applications` — full-replace. Разрешено
**только в `DRAFT`** (общий guard `ORDER_LOCKED`).

`CutReadinessService` использует `OrderApplication(stage='CUT_PARTS')`
как блокер: если поля нанесения не заполнены
(`isOrderApplicationDataFilled`), строка попадает в `blockers`
готовности к крою (см. `docs/order-flow.md §9.1`).

### 1.5 `OrderCostEstimate` (себестоимость)

Источник: `prisma/schema.prisma::OrderCostEstimate` /
`OrderCostEstimateLine`,
`apps/api/src/modules/orders/order-cost-estimates.service.ts`,
`docs/order-flow.md §6`.

Документ «Себестоимость заказа» — снимок цен/количеств на момент
завершения расчёта. Один заказ может иметь много расчётов
(`@@unique([orderId, version])`); активный — `status = COMPLETED`.

Lifecycle:

- `completeCalculation` (`CALCULATION → CALCULATION_DONE`) — создаёт
  COMPLETED-расчёт, копирует строки из `WorkshopNeed[]`, выставляет
  snapshot-поля `Order.costEstimate*`. Audit:
  `ORDER_COST_ESTIMATE_CREATED` + `ORDER_CALCULATION_COMPLETED`.
- `reopenCalculation` (`CALCULATION_DONE → CALCULATION`) — переводит
  активный расчёт в `REVOKED`, обнуляет snapshot-поля заказа в
  `null`. `WorkshopNeed`/`PurchaseOrder`/`PurchaseReceipt` НЕ
  трогаются. Audit: `ORDER_CALCULATION_REOPENED`. **Из
  `IN_PRODUCTION` reopen запрещён** (production data зависит от
  утверждённой себестоимости).

Все цены копируются «как есть» (`supplierNameSnapshot`,
`purchaseItemNameSnapshot`, `usdRateRub`) — расчёт не должен «плыть»
вслед за поздним переименованием.

### 1.6 `OrderMaterialArrivalOverride` — override готовности к крою

Источник: `prisma/schema.prisma::OrderMaterialArrivalOverride`,
`apps/api/src/modules/order-material-arrivals/*`,
`apps/api/src/modules/cut-readiness/cut-readiness.service.ts`,
`docs/erd.md §3.8`, `docs/order-flow.md §9.2`.

Ручная override-кнопка «Материал поступил» в карточке заказа. Это
**не** складская операция:

- НЕ создаёт `PurchaseReceipt` / `PurchaseReceiptLine`,
- НЕ меняет `CellContent` / складские остатки,
- НЕ двигает `WorkshopNeed.status`,
- НЕ создаёт `Passport` / `OperationEntry` / `SalaryEntry`.

Только запись «менеджер сказал — крой можно начинать» + audit-log
(`ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED` /
`ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED`). `CutReadinessService`
читает ACTIVE-overrides и добавляет их `qty` к `placedQty`.

### 1.7 `CutReleasePolicy` — лимит выдачи кроя

Источник: `prisma/schema.prisma::CutReleasePolicy`,
`apps/api/src/modules/cut-release-policy/*`,
`docs/erd.md §3.7`, `docs/order-flow.md §10.1`.

Управленческое ограничение «нельзя выдать больше N штук кроя данного
цвета/размера». На MVP единовременно активна **максимум одна**
политика (enforcement в `CutReleasePolicyService.create`). Применяется
в `PassportsService.issueToEmployee` для первой операции маршрута и
операций категории `CUTTING` (см. §7.5). Само движение паспорта по
маршруту (`scan` / `complete-operation`) политикой **не**
блокируется.

Audit-events: `CUT_RELEASE_POLICY_CREATED` / `_UPDATED` / `_DISABLED`,
а также `CUT_RELEASE_POLICY_CONSUMED` в транзакции
`issueToEmployee` (`docs/events.md §3.3`).

### 1.7a `OrderCutIssueRule` — очередь выдачи кроя по размерам

Источник: `prisma/schema.prisma::OrderCutIssueRule`,
`apps/api/src/modules/order-cut-issue-rules/*`,
`docs/erd.md §3.8`, `docs/order-flow.md §«Очередь выдачи кроя»`,
`docs/production-flow.md §«Issue: очередь выдачи кроя»`.

Менеджер заказа задаёт «первую очередь выдачи кроя по размерам»:
например `S — 70 шт`, `M — 50 шт`, `4XL — 100 шт`. Пока хотя бы одна
активная строка очереди не выполнена (`issuedQty < requiredQty`),
`PassportsService.issueToEmployee` режет паспорта «не очередных»
размеров адресной 409 `ORDER_CUT_ISSUE_RULE_VIOLATION` с
человекочитаемым сообщением «Сначала нужно выдать: S — осталось 20
шт, M — осталось 10 шт, 4XL — осталось 50 шт» (текст собирается
`formatOrderCutIssueRuleViolationMessage` из `@sewing/shared`).
Когда все активные строки выполнены, выдача остальных размеров
становится свободной — никаких ручных «снять очередь» не требуется,
правило гасит само себя по `issuedQty`.

Отличие от `CutReleasePolicy` (§1.7):
- `CutReleasePolicy` — глобальная политика, единовременно активна
  максимум одна, режет по `(color, sizeId, limitQty)`;
- `OrderCutIssueRule` — поразмерная очередь конкретного заказа,
  одна строка на размер (`@@unique [orderId, sizeId]`), может быть
  N активных одновременно.

`issuedQty` — materialized counter (как `CutReleasePolicy.consumedQty`).
Инкрементится в той же транзакции, что и
`passport.update + passportEvent.create + audit.log`, через conditional
`updateMany` (`updateMany where issuedQty <= requiredQty - qty`).
Если строку успели погасить (`isActive = false`) или другая выдача
«съела остаток» между pre-check и transaction'ом — `updateMany`
возвращает `count = 0`, мы перечитываем актуальное состояние и
бросаем VIOLATION (без записи issue).

Применяется ТОЛЬКО на ПЕРВОЙ операции маршрута
(`Passport.currentRouteStepIndex === 0`) или операциях категории
`CUTTING` — точно так же, как `CutReleasePolicy`. Порядок проверок
внутри `issueToEmployee`: `OrderCutIssueRule → CutReleasePolicy`. На
дальнейших шагах маршрута (scan / complete-operation /
master-actions) очередь не применяется.

Audit-events: `ORDER_CUT_ISSUE_RULE_UPSERT` (bulk-сохранение формы),
`ORDER_CUT_ISSUE_RULE_DISABLED` («Отключить очередь»),
`ORDER_CUT_ISSUE_RULE_CONSUMED` (атомарный инкремент `issuedQty` в
транзакции `issueToEmployee`); `entityType = ORDER_CUT_ISSUE_RULE`
(`docs/events.md §3.2`).

### 1.8 `CuttingClosureRequest` — закрытие раскроя по размеру

Источник: `prisma/schema.prisma::CuttingClosureRequest`,
`apps/api/src/modules/cutting-closure/*`, ADR-0018,
`docs/order-flow.md §10.2`.

Заявка на тройку `(orderId, productId, sizeId)`:

```
REQUESTED → APPROVED      // выпуск паспортов запрещён
REQUESTED → REJECTED      // выпуск возможен, заявка закрыта
```

Partial-unique индексы `cutting_closure_request_active_uniq` /
`_approved_uniq` гарантируют ровно одну активную (`REQUESTED`) и
максимум одну финальную (`APPROVED`) заявку (ADR-0015). После
`APPROVED` `PassportsService.create` бросает 409 `CUTTING_CLOSED` на
любой новый паспорт по этому размеру.

RBAC:

- Подача — `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`.
- Approve / reject — только `SHOP_MANAGER`, `ADMIN`.

UNKNOWN/TODO: переход `APPROVED → REJECTED` (отмена закрытия) — в
коде не реализован; recover-сценарий пока не описан.

---

<a id="2-routes-operations"></a>

## 2. Маршрут и операции

### 2.1 `Operation` — справочник операций

Источник: `prisma/schema.prisma::Operation`,
`apps/api/src/modules/operations/*`, ADR-0020,
`docs/erd.md §2.3`, `docs/api.md §6`.

Поля:

- `code` (uniq), `name`, `category: OperationCategory`, `sortOrder`,
  `active: Boolean`;
- `pricingMode: PricingMode @default(SALARY_ONLY)` —
  `FIXED | BY_SIZE | SALARY_ONLY`;
- `fixedRate: Decimal(12,2)?` (для `FIXED`);
- `timeNormMode: String @default("FIXED")` (`FIXED | BY_SIZE`,
  свободная строка с Zod-валидацией),
  `timeNormSec: Int?`;
- `salaryPlanRubPerShift: Decimal(14,2)?`,
  `salaryPlanShiftSeconds: Int? @default(28800)` — плановая
  окладная стоимость для `OrderOperationPlanService` (только план,
  не payroll).

Категории (`enum OperationCategory`):
`CUTTING`, `SEWING`, `QC`, `IRONING`, `PACKING`.

### 2.2 `PricingMode` — тариф операции

| Mode          | Источник ставки                                              | Поведение зарплаты |
| ------------- | ------------------------------------------------------------ | ----------------- |
| `FIXED`       | `Operation.fixedRate`                                        | Одна ставка за единицу независимо от размера. |
| `BY_SIZE`     | `OperationRateBySize.rate` для пары `(operationId, sizeId)`  | Цена различается по размеру. Отсутствие ставки → 422 `OPERATION_RATE_MISSING`. |
| `SALARY_ONLY` | —                                                            | Операция участвует в pipeline, но **не** порождает `OperationEntry` (silent skip в `EarningsService`). Дефолт для новых операций. |

Единый helper — `OperationsService.resolveRate(operationId, sizeId,
tx?)`. Это **единственный** источник истины для earnings:
`EarningsService.createImmediateForCutterMarketplace` /
`createImmediateForCutterB2b` / `createPendingForPreviousOperation`
ходят через него.

`OperationRateBySize` — нормализованная таблица
`(operationId, sizeId, rate)` UNIQUE, cascade от `Operation`.

`OperationTimeNormBySize` — параллельная таблица для плановой нормы
времени (`timeNormMode = "BY_SIZE"`). **Payroll не использует** —
только `OrderOperationPlanService` для snapshot-плана заказа
(`docs/erd.md §3.6`).

Историческая таблица `PieceRate` удалена в PHASE 2 STEP 1
(миграция `20260532100000_drop_legacy_salary_base_and_piece_rate`).
Источник истины бэкфилла — `20260420100000_operation_pricing_model`.

### 2.3 `RouteTemplate` / `RouteTemplateStep`

Источник: `prisma/schema.prisma::RouteTemplate`,
`apps/api/src/modules/routes/*`, `docs/api.md §7`.

«Шаблон маршрута производства» — упорядоченный список операций.
`RouteTemplateStep` имеет уникальные `(templateId, index)` и
`(templateId, operationId)`: операция в шаблоне ровно один раз.
`isOptional: Boolean` — поле есть в схеме, но в enforcement-е MVP не
используется.

### 2.4 `OrderRouteStep` — snapshot маршрута на заказе

Источник: `prisma/schema.prisma::OrderRouteStep`,
`OrdersService.syncOrderRouteStepsSnapshot`
(`apps/api/src/modules/orders/orders.service.ts` ~785–838),
`docs/order-flow.md §4.1`.

Поля: `(orderId, index)` UNIQUE, `operationId` (`onDelete:
RESTRICT` — нельзя случайно удалить операцию, на которую ссылается
snapshot заказа), cascade от `Order`.

`syncOrderRouteStepsSnapshot(orderId, tx)` — идемпотентный
синхронизатор, делает atomic `deleteMany + createMany` только если
состав/порядок шагов отличается от целевого. Точки вызова (`docs/order-flow.md §4.1`):

- `OrdersService.create` (если есть `routeTemplateId`);
- `OrdersService.update` в DRAFT при изменении items/route/pattern;
- `OrdersService.recalculateOperationPlan`;
- `OrdersService.startCalculation` (финальная sync перед
  `CALCULATION`);
- defensive в `start()` — только если `OrderRouteStep.count === 0`
  (для legacy-заказов).

После `start` snapshot **не пересинхронизируется** — гарантирует
ADR-0006 + общий `ORDER_LOCKED`-guard.

### 2.5 Soft-route MVP — поведение во время скана

Источник: `apps/api/src/modules/passports/passports.service.ts`
(`scanOnOperation`, `completeOperationByEmployee`),
`docs/production-flow.md §7`.

Никакого backend enforcement-а порядка маршрута:

- На `POST /api/passports/:id/scan` НЕ проверяется «совпадает ли
  операция с маршрутом». Если совпадает — обновляется
  `Passport.currentRouteStepIndex`, если нет — индекс остаётся
  прежним, scan всё равно проходит.
- На `POST /api/passports/:id/complete-operation` запрещён только
  **откат назад по маршруту** —
  `PassportCompleteBackwardException` (409
  `PASSPORT_COMPLETE_BACKWARD`) если `OrderRouteStep` с
  завершаемой операцией стоит раньше `currentRouteStepIndex`.
  Откат назад — прерогатива мастера через
  `MasterActionsService.setRouteStep` (см. §13).

UI `/work` подсвечивает несовпадение операции с маршрутом мягким
warning, но не блокирует приём (`docs/production-flow.md §7.1`).

---

<a id="3-tech-cards"></a>

## 3. Техкарта и материалы

### 3.1 `TechCardTemplate`

Источник: `prisma/schema.prisma::TechCardTemplate`,
`apps/api/src/modules/tech-cards/*`, ADR-0022,
`docs/erd.md §2.4`, `docs/api.md §8`.

Шаблон «потребностей на единицу изделия». Поля: `code` (uniq),
`name`, `isActive`. Связи: `materialLines: TechCardMaterialLine[]`,
`outsourceLines: TechCardOutsourceLine[]`, `orders: Order[]`.

Техкарта и маршрут — **независимые** оси: маршрут отвечает «что
делает швея», техкарта — «что нужно положить в этот заказ».
Привязка к заказу опциональна.

### 3.2 `TechCardMaterialLine` / `TechCardOutsourceLine`

Источник: `prisma/schema.prisma::TechCardMaterialLine` /
`TechCardOutsourceLine`, `docs/erd.md §2.4`.

`TechCardMaterialLine`:

- `name`, `unit`, `qtyPerUnit: Decimal(12,4)` (> 0, валидируется
  DTO/сервисом), `note?`, `sortOrder`;
- snapshot-поля номенклатуры: `materialRole?` (свободная строка из
  `MATERIAL_ROLES`), `fabricType?`, `densityGsm: Int?`,
  `plannedWidthCm: Int?`;
- цвет: `colorRule?` (`ORDER_COLOR | FIXED_COLOR | NO_COLOR |
  ORDER_SELECTED_COLOR`), `fixedColorText?`;
- фурнитура: `hardwareSizeText?`, `hardwareMaterialText?`;
- картинка: `materialImageUrl?`, `materialImageOriginalFileName?`.

`TechCardOutsourceLine`:

- `name`, `unit?`, `qtyPerUnit: Decimal(12,4)?` (опц. — часть
  подрядов считается «за партию»), `vendorName?` (свободный текст,
  vendor-directory **не строится**), `note?`, `sortOrder`;
- `triggerType: OutsourceTriggerType @default(MANUAL)` —
  `MANUAL | CUT_READY` (см. §3.4).

### 3.3 `OrderMaterialRequirement` (snapshot)

Источник: `prisma/schema.prisma::OrderMaterialRequirement`,
`OrdersService.rebuildMaterialRequirementsSnapshot`
(`apps/api/src/modules/orders/orders.service.ts` ~2519+),
`docs/order-flow.md §4.2`, `docs/erd.md §2.4`.

Read-only план потребностей конкретного заказа. Поля:

- snapshot-копии полей шаблона (`materialRole`, `fabricType`,
  `densityGsm`, `plannedWidthCm`, `colorRule`, `fixedColorText`,
  `hardwareSizeText`, `hardwareMaterialText`, `materialImage*`);
- `qtyPerUnit`, `totalQty: Decimal(12,4) = qtyPerUnit × Σ
  OrderItem.qtyPlan` (без округлений, `Prisma.Decimal`-математика);
- `resolvedColorText?` — резолвится через
  `resolveColorText(colorRule, fixedColorText, Order.color)`;
- `requiresColorSelection: Boolean` — `true` для
  `colorRule = ORDER_SELECTED_COLOR`;
- `selectedColorText?` — выбор менеджера для
  `ORDER_SELECTED_COLOR`-строк, **preserve-ится** при rebuild
  (по `sourceTechCardLineId` или композитному ключу);
- `sourceTechCardLineId?` — `onDelete: SetNull` (см. §1.3:
  «независимость snapshot-а»).

`PATCH /api/orders/:id/material-requirements/:requirementId/color` —
точечная правка `selectedColorText` (доступна только для
`requiresColorSelection = true`, иначе 409
`ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED`).

### 3.4 `OrderOutsourceRequirement` (snapshot) и manual execution status

Источник: `prisma/schema.prisma::OrderOutsourceRequirement`,
`OrdersService.updateOutsourceRequirementStatus`
(`apps/api/src/modules/orders/orders.service.ts` ~2299+), ADR-0022,
`docs/order-flow.md §11`, `docs/erd.md §2.4`.

Создаётся **defensive в `start()`** (если `count === 0`); в
отличие от material-requirements, для outsource нет регулярного
синхронизатора — т.е. изменения техкарты после старта в snapshot
заказа уже не приедут. Точечно правится только `executionStatus`.

#### `OutsourceTriggerType`

- `MANUAL` (default, backward-compat) — UI просто показывает строку.
- `CUT_READY` — потребность считается «готовой к заказу» когда у
  заказа есть паспорта и **все** они физически размещены в ячейки
  (`Passport.currentCellId != null`). Read-derived поле
  `isReadyToOrder` считается на чтении в `OrdersService.getOne`
  (никакой материализации в БД).

#### `OrderOutsourceExecutionStatus`

Линейный жизненный цикл `PLANNED → ORDERED → RECEIVED`
(терминальный, откатов через action нет).

`POST /api/orders/:id/outsource-requirements/:requirementId/status`:

- `PLANNED → ORDERED`: для `triggerType=CUT_READY` дополнительно
  проверяет `isReadyToOrder = true`. Если нет —
  `OrderOutsourceRequirementNotReadyException` (409
  `OUTSOURCE_NOT_READY_TO_ORDER`).
- `ORDERED → RECEIVED`: фиксирует `receivedAt = now()`.
- Идемпотентно: если уже в нужном статусе — no-op без 409 и без
  перезаписи timestamp-ов.

#### Composite `displayStatus` (read-model)

В `OrdersService.getOne` собирается композитный display-статус
(порядок проверок):

1. `executionStatus = RECEIVED` → `RECEIVED` («Получено»);
2. `executionStatus = ORDERED` → `ORDERED` («Заказано»);
3. `triggerType = CUT_READY` и `isReadyToOrder = true` →
   `READY_TO_ORDER` («Готово к заказу»);
4. Иначе → `PLANNED`.

`READY_TO_ORDER` сознательно **не материализуется в БД** — это
функция от `Passport.currentCellId`. `ORDERED` / `RECEIVED`
хранятся (это решение менеджера).

### 3.5 Жизненный цикл техкарты

1. Менеджер заводит техкарту в `/admin/tech-cards/new`. UI —
   `apps/web/app/admin/tech-cards/*`.
2. Менеджер опционально привязывает техкарту к заказу
   (`Order.techCardId`). До запуска — можно сменить через
   `PATCH /api/orders/:id`. После `start()` менять нельзя
   (`ORDER_LOCKED`).
3. `OrdersService.startCalculation` пересобирает
   `OrderMaterialRequirement[]` через
   `rebuildMaterialRequirementsSnapshot`.
4. `OrdersService.start` копирует `OrderOutsourceRequirement[]`
   через defensive snapshot.
5. UI `/orders/:id` отдаёт snapshot read-only.

### 3.6 Что MVP сознательно НЕ делает

- Никаких формул / размерных коэффициентов / процентов отходов —
  только плоский `qtyPerUnit × baseQty`.
- Не enforce-ит «нельзя стартовать без техкарты» —
  `Order.techCardId` опционален. Однако `startCalculation` требует
  `Order.techCardId !== null` (`ORDER_TECH_CARD_REQUIRED`).
- Не строит vendor-directory — `vendorName` свободный текст.
- Не использует snapshot потребностей в `CostsService` /
  dashboard — material-cost остаётся как есть.
- Не трогает shopfloor / display / passports / QC / WTO / packing
  flow — техкарта живёт сбоку.

---

<a id="4-patterns"></a>

## 4. Лекала / Patterns

### 4.1 `PatternItem` — карточка лекала

Источник: `prisma/schema.prisma::PatternItem`,
`apps/api/src/modules/patterns/*`,
`apps/api/src/modules/pattern-categories/*`,
`docs/erd.md §2.11` / §3.1, `docs/api.md §9`-§10.

Конструкция изделия. Поля:

- `name`, `article` (uniq), `categoryCode?` (legacy — свободная
  строка), `categoryId? → PatternCategory` (`onDelete: SetNull`);
- `previewImageUrl?`, `description?`,
  `status: String @default("ACTIVE")` (свободная строка,
  Zod-валидация);
- `legacyProductId? @unique → Product` (`onDelete: SetNull`) —
  совместимость со старым flow «Номенклатура = лекала».

Связи: `sizeFiles`, `materialAreas`, `parameterNorms`,
`sizeParameterValues`, `orders`.

### 4.2 `PatternCategory` и параметры

Источник: `prisma/schema.prisma::PatternCategory` /
`PatternCategoryParameter`.

`PatternCategory` — справочник категорий номенклатуры (футболки,
джемперы, …). Поля: `name`, `slug` (uniq), `iconKey`,
`iconImageUrl?`, `sortOrder`, `status`.

`PatternCategoryParameter` определяет, какие колонки появятся в
таблицах редактирования карточки лекала:

- `roleKey`, `label`, `unit @default("м²")`, `isRequired`;
- `inputType: String @default("AREA_M2_BY_SIZE")` — управляет тем,
  в какую таблицу пишутся значения параметра:
  - `AREA_M2_BY_SIZE` → `PatternMaterialArea` (м² по размерам);
  - `QTY_PER_ITEM` → `PatternItemParameterNorm` (норма «на
    изделие», например, «Люверсы = 2 шт»);
  - `LINEAR_M_BY_SIZE` → `PatternItemSizeParameterValue` (погонные
    метры по размерам).

### 4.3 DXF-файлы (`PatternSizeFile`)

Источник: `prisma/schema.prisma::PatternSizeFile`.

Версионирование `(patternItemId, sizeId, version)` UNIQUE,
`status: String @default("ACTIVE")`. «Удаление» = смена статуса в
`ARCHIVED`; физический файл с диска не удаляется.

### 4.4 Snapshot лекала на заказе

Источник: `Order.patternNameSnapshot` /
`patternArticleSnapshot` / `patternPreviewSnapshotUrl`,
`OrdersService.start` / `startCalculation`,
`docs/order-flow.md §4.4`.

- Заполняются один раз — на первом из `startCalculation` /
  `start`, у которого `!Order.patternNameSnapshot`.
- На последующих запусках **не перезаписываются**.
- `PatternItem.onDelete: SetNull` — удаление карточки лекала
  обнуляет live-связь, snapshot сохраняется.

UNKNOWN/TODO: точный набор `inputType` за пределами трёх
основных — Zod-схема определяет допустимые значения; новые
варианты не требуют миграции БД.

---

<a id="5-workshop-needs"></a>

## 5. Потребности цеха / `WorkshopNeed`

Источник: `prisma/schema.prisma::WorkshopNeed`,
`apps/api/src/modules/workshop-needs/*`,
`docs/erd.md §2.12` / §3.2, `docs/order-flow.md §7`,
`docs/api.md §18`.

### 5.1 Назначение

Чистая потребность заказа в материалах, рассчитанная системой по
«лекало × техкарта × размерная матрица». Это **рабочее место
закупщика**, **не** закупочный документ и **не** складской остаток.

### 5.2 Источник входных данных (`sourceType`)

- `TECH_CARD_MATERIAL_LINE` — заказ в `DRAFT`, расчёт по live
  техкарте.
- `ORDER_MATERIAL_REQUIREMENT` — заказ запущен (или у
  DRAFT-заказа уже есть snapshot), расчёт по snapshot
  `OrderMaterialRequirement[]`.

### 5.3 Формулы расчёта (`calculationMethod`)

Свободная строка с Zod-валидацией:

- `AREA_DENSITY`:
  `totalAreaM2 = Σ (PatternMaterialArea.areaM2 × OrderItem.qtyPlan)`;
  `calculatedQty = totalAreaM2 × densityGsm / 1000` (кг).
- `QTY_PER_UNIT`:
  `calculatedQty = qtyPerUnit × Σ OrderItem.qtyPlan` (live) или
  `requirement.totalQty` (snapshot).

### 5.4 Поля и статусы

`status: String` (свободная, валидируется Zod) — `CALCULATED`
(default) → `REVIEWED` → `PURCHASE_PLANNED` → `ORDERED` →
`PARTIALLY_RECEIVED` / `RECEIVED` либо `CANCELLED`.

Закупщик правит руками через `PATCH /api/workshop-needs/:id`:
`purchaseQty`, `quotedPrice`, `quotedCurrency`, `expectedDeliveryDate`,
`selectedSupplierId`, `selectedSupplierCatalogItemId`, `comment`.

Идемпотентный пересчёт `WorkshopNeedsService.calculateForOrder` (с
параметром `force: false`) сносит только `CALCULATED`-строки и
сохраняет `REVIEWED` / `PURCHASE_PLANNED`. Если такие строки есть и
`force` не задан — 409 `WORKSHOP_NEEDS_ALREADY_REVIEWED`.

### 5.5 Триггеры расчёта

- `OrdersService.startCalculation` → `calculateForOrder(id, { force: false })`.
- `POST /api/orders/:id/workshop-needs/calculate` — ручной пересчёт
  (`force=true` поддерживается).

### 5.6 Связи и onDelete-политика

- `selectedSupplierId? → Supplier` (`SetNull`),
- `selectedSupplierCatalogItemId? → SupplierCatalogItem` (`SetNull`),
- `purchaseOrderLines: PurchaseOrderLine[]` (`SetNull` со стороны PO-line),
- `receiptLines: PurchaseReceiptLine[]` (тот же паттерн),
- `costEstimateLines: OrderCostEstimateLine[]` (`SetNull`),
- `materialArrivalOverrides: OrderMaterialArrivalOverride[]` (`SetNull`).

Cascade при удалении заказа.

### 5.7 Что MVP сознательно НЕ делает

- Не считает потери / отходы.
- Не ведёт vendor-portal / vendor-каталог как «истину» —
  `Supplier` / `SupplierCatalogItem` живут сбоку, привязка soft.

---

<a id="6-procurement"></a>

## 6. Закупки / Supplier / PurchaseOrder / PurchaseReceipt

### 6.1 `Supplier` / `SupplierContact` / `SupplierCatalogItem`

Источник: `prisma/schema.prisma::Supplier` (+ contact + catalog),
`apps/api/src/modules/suppliers/*`,
`docs/erd.md §2.12`, `docs/api.md §12`.

Изолированный справочник: НЕТ vendor-portal, НЕТ интеграций, НЕТ
финансовых документов. Только название + контакты + позиции.

`Supplier`:

- `name` (НЕ uniq), `phone? / website? / address? / comment?`;
- `status: String @default("ACTIVE")` (свободная строка,
  Zod-валидация: `ACTIVE | INACTIVE`).
- `onDelete: Restrict` со стороны `PurchaseOrder` —
  жёсткое удаление поставщика, на которого ссылается PO,
  блокируется БД.

`SupplierContact` — менеджер у поставщика. Cascade от Supplier.

`SupplierCatalogItem` — позиция каталога. Cascade от Supplier.
Поля: `name`, `supplierArticle?`, `category?`, `fabricType?`,
`densityGsm?`, `colorText?`, `unit`, `lastPrice: Decimal(14,2)?`,
`currency?`, `minOrderQty?`, `deliveryDays?`, `comment?`,
`status @default("ACTIVE")`.

### 6.2 `PurchaseOrder` (PO)

Источник: `prisma/schema.prisma::PurchaseOrder`,
`apps/api/src/modules/purchase-orders/*`,
`docs/erd.md §3.4`, `docs/api.md §19`.

Закупочный документ. Поля:

- `number` (uniq, `PO-YYYYMMDD-NNNN`);
- `supplierId → Supplier` (`onDelete: Restrict`);
- `customerOrderId? → Order` (`SetNull`);
- snapshot полей поставщика (имя/телефон/etc на момент создания
  документа);
- `status: String @default("DRAFT")` — свободная строка
  (`DRAFT | SENT | CONFIRMED | CANCELLED | RECEIVED |
  PARTIALLY_RECEIVED`), Zod-валидация;
- timestamps: `expectedDeliveryDate?`, `sentAt?`, `confirmedAt?`,
  `cancelledAt?`;
- `comment?`, `createdById?`.

`PurchaseOrderLine` (`docs/erd.md §2.12`):

- `purchaseOrderId → PurchaseOrder` (Cascade);
- `workshopNeedId? → WorkshopNeed` (`SetNull`);
- `supplierCatalogItemId? → SupplierCatalogItem` (`SetNull`);
- snapshot номенклатуры (имя/артикул/unit);
- `qty: Decimal(14,4)`, `price: Decimal(14,2)?`, `currency?`,
  `expectedDeliveryDate?`;
- confirmed-копии: `confirmedQty? / confirmedPrice? / confirmedDeliveryDate?`;
- `status: String @default("DRAFT")`.

Lifecycle (audit-трейл — `docs/events.md §6.1`):

| Переход                                  | Сервис                       | AuditLog event |
| ---------------------------------------- | ---------------------------- | -------------- |
| (insert) `DRAFT`                         | `createFromNeeds`            | `PURCHASE_ORDER_CREATED` |
| field-level update                       | `update`                     | `PURCHASE_ORDER_UPDATED` |
| line-level update                        | `updateLine`                 | `PURCHASE_ORDER_LINE_UPDATED` |
| `DRAFT → SENT`                           | `send`                       | `PURCHASE_ORDER_SENT` |
| `{DRAFT, SENT} → CONFIRMED`              | `confirm`                    | `PURCHASE_ORDER_CONFIRMED` |
| `{DRAFT, SENT, CONFIRMED} → CANCELLED`   | `cancel`                     | `PURCHASE_ORDER_CANCELLED` |
| авто-переход `→ RECEIVED / PARTIALLY_RECEIVED / откат` | `PurchaseReceiptsService.recalcAfterChange` | **нет AuditLog** (UNKNOWN/TODO, см. `docs/events.md §6.2`) |

Side-effects:

- `createFromNeeds` → связанные `WorkshopNeed.status = ORDERED`;
- `cancel` → строки PO в `CANCELLED`; для каждого `WorkshopNeed`
  проверяется наличие активных PO-строк, если их нет — статус
  возвращается в `PURCHASE_PLANNED`.

Один PO — один поставщик; запрещено смешивать строки разных заказов
покупателя.

### 6.3 `PurchaseReceipt` (PR)

Источник: `prisma/schema.prisma::PurchaseReceipt`,
`apps/api/src/modules/purchase-receipts/*`,
`docs/api.md §20`.

Документ приёмки по PO. Поля:

- `number` (uniq, `PR-YYYYMMDD-NNNN`);
- `purchaseOrderId → PurchaseOrder` (`onDelete: Restrict`);
- `supplierId? → Supplier` (`SetNull`),
- `customerOrderId? → Order` (`SetNull`);
- `status: String @default("POSTED")` — свободная строка
  (`POSTED | CANCELLED`);
- `receivedAt @default(now())`, `cancelledAt?`,
  `receivedById?`.

`PurchaseReceiptLine`:

- cascade от `PurchaseReceipt`;
- денормализация: `purchaseOrderLineId?`, `workshopNeedId?`,
  `supplierCatalogItemId?` — все `SetNull`;
- snapshot номенклатуры (`itemNameSnapshot`,
  `supplierArticleSnapshot?`, `unitSnapshot`,
  `orderedQtySnapshot?`, `confirmedQtySnapshot?`, `priceSnapshot?`,
  `currencySnapshot?`);
- `receivedQty: Decimal(14,4)`, `unit`, `cellId? → Cell`
  (`SetNull`), `locationNote?`, `batchNumber?`, `rollNumber?`,
  `shade?`, `actualWidthCm?`, `actualDensityGsm?`;
- `status: String @default("POSTED")`.

**Граница MVP.** PR фиксирует размещение в ячейке (`Cell.cellId`)
**без** записи в `CellContent`. Это сознательная граница: складские
остатки на ячейках по-прежнему ведутся только через
`PassportsService.place` (см. §11).

Lifecycle:

| Переход               | Сервис                                | AuditLog event |
| --------------------- | ------------------------------------- | -------------- |
| (insert) `POSTED`     | `createFromPurchaseOrder`             | `PURCHASE_RECEIPT_CREATED` |
| `POSTED → CANCELLED`  | `cancel`                              | `PURCHASE_RECEIPT_CANCELLED` |

Side-effects (`recalcAfterChange`):

- пересчёт `PurchaseOrderLine.status`
  (`SENT`/`CONFIRMED → PARTIALLY_RECEIVED / RECEIVED`);
- пересчёт `PurchaseOrder.status` (`RECEIVED / PARTIALLY_RECEIVED`
  / откат в `SENT`/`CONFIRMED`);
- пересчёт `WorkshopNeed.status`.

Эти авто-переходы в `AuditLog` **не пишутся** — источник истины
только `PURCHASE_RECEIPT_CREATED` / `PURCHASE_RECEIPT_CANCELLED`
(UNKNOWN/TODO осознанно ли это, см. `docs/events.md §6.2`).

### 6.4 RBAC

Все ручки `/api/suppliers/*`, `/api/purchase-orders/*`,
`/api/purchase-receipts/*` — `SHOP_MANAGER` / `ADMIN`. Подробнее
`docs/api.md §12`, §19, §20.

---

<a id="production"></a>
<a id="7-passport"></a>

## 7. Паспорт производства

### 7.1 `Passport` — агрегат-корень

Источник: `prisma/schema.prisma::Passport` (~1092),
`apps/api/src/modules/passports/passports.service.ts`,
`docs/erd.md §2.5`, `docs/production-flow.md §1`,
ADR-0002, ADR-0003.

Один Passport = одна партия раскроя одного `(orderId, productId,
sizeId)`. Денормализованные поля состояния:

- `qtyPlan` — план в момент выпуска (= `qtyCut` на `create`);
- `qtyCut` — фактически выпущено раскройщиком; не уменьшается;
- `qtyDefect` — `Σ PassportDefect.qty` (инкрементится в
  `QcService.recordDefect`);
- `qtyGood = qtyCut − qtyDefect` (поддерживается в коде через
  `decrement`);
- `status: PassportStatus` (см. §7.2);
- «текущий след»: `currentOperationId?`, `currentEmployeeId?`,
  `currentCellId?`;
- `currentRouteStepIndex Int?` — soft-route индекс шага в snapshot
  маршрута заказа (см. §2.5).

Уникальные поля: `number` (формат `P-YYYYMMDD-NNNN`,
`PassportNumberService`), `qrCode` (`passport:{id}`, ADR-0008;
финальный QR проставляется отдельным `tx.update` после получения
id).

Связи: `events: PassportEvent[]`, `entries: OperationEntry[]`,
`boxItems: BoxItem[]`, `defects: PassportDefect[]`.

### 7.2 `PassportStatus` (lifecycle)

Источник: `prisma/schema.prisma::enum PassportStatus`,
`docs/production-flow.md §2`, `docs/events.md §9.13`.

| Значение      | Семантика                                                                | Кто меняет |
| ------------- | ------------------------------------------------------------------------ | ---------- |
| `CREATED`     | Только что выпущен `PassportsService.create`. До `place` — «в воздухе»; после — в `Cell`. | `PassportsService.create` (default) |
| `IN_PROGRESS` | Швея получила крой (`issueToEmployee`) или паспорт двинулся по операциям (`scanOnOperation` / `transferToEmployee`). | `PassportsService.{issueToEmployee, scanOnOperation}`, `MasterActionsService.{transferToEmployee, setRouteStep}` |
| `PACKED`      | Добавлен в `Box` через `PackingService.addPassport`. Терминальный для production; `currentEmployeeId` / `currentCellId` обнуляются. | `PackingService.addPassport` |
| `CANCELLED`   | Снят. **В runtime-коде нет ни одного writer-а** `Passport.status = CANCELLED` (`docs/events.md §9.13`). Только read-guards. **UNKNOWN/TODO**: сценария отмены паспорта на MVP не реализован. |

`assertPassportActive` (private в `PassportsService`) бросает:

- `PassportAlreadyPackedException` для `PACKED`;
- `PassportCancelledException` для `CANCELLED`.

### 7.3 `PassportEvent` / `PassportEventType`

Источник: `prisma/schema.prisma::PassportEvent` (~1154),
`enum PassportEventType` (~182–208),
`docs/events.md §2`.

ADR-0003 (event-sourcing-lite): состояние паспорта
**денормализовано** в самом `Passport`; `PassportEvent` накапливает
факты, из которых считаются длительности стадий, derived stage на
shopfloor, pending-начисления, QC-gate.

Все writer-ы `PassportEvent` обёрнуты в `prisma.$transaction` с
изменением state (см. инвариант `docs/events.md §9.1`).

| Тип                  | Пишется? | Writer                                              | Меняет state паспорта?            |
| -------------------- | -------- | --------------------------------------------------- | --------------------------------- |
| `CREATED`            | ДА       | `PassportsService.create`                           | создаёт `status = CREATED`        |
| `OPERATION_STARTED`  | НЕТ      | — (зарезервировано в enum)                          | UNKNOWN/TODO                      |
| `OPERATION_FINISHED` | ДА       | `PassportsService.completeOperationByEmployee`      | нет (остаётся `IN_PROGRESS`)      |
| `MOVED`              | НЕТ      | — (зарезервировано в enum)                          | UNKNOWN/TODO                      |
| `DEFECT_RECORDED`    | ДА       | `QcService.recordDefect`                            | меняет `qtyDefect / qtyGood`      |
| `CELL_PLACED`        | ДА       | `PassportsService.place`                            | нет (остаётся `CREATED`)          |
| `CELL_REMOVED`       | НЕТ      | — (зарезервировано). Физическое снятие при `ISSUED_TO_EMPLOYEE` без отдельного события. UNKNOWN/TODO. |  — |
| `ISSUED_TO_EMPLOYEE` | ДА       | `PassportsService.issueToEmployee` (обе ветки)      | `CREATED → IN_PROGRESS`           |
| `OPERATION_SCAN`     | ДА       | `PassportsService.scanOnOperation`                  | `→ IN_PROGRESS`, обновляет `currentOperationId / currentEmployeeId / currentRouteStepIndex` |
| `QC_PASSED`          | ДА       | `QcService.completeQc`                              | нет (audit-маркер)                |
| `WTO_PASSED`         | ДА       | `WtoService.completeWto`                            | нет (audit-маркер)                |
| `PACKED`             | ДА       | `PackingService.addPassport`                        | `→ PACKED` (терминально)          |
| `CANCELLED`          | НЕТ      | — (зарезервировано). UNKNOWN/TODO.                  | —                                 |

### 7.4 Создание паспорта (`POST /api/passports`)

Источник: `PassportsService.create`
(`apps/api/src/modules/passports/passports.service.ts` ~99–255),
`docs/production-flow.md §4`, `docs/events.md §2.1`.

Контроллер: RBAC `CUTTER` / `CUTTER_ASSISTANT` / `SHOP_MANAGER`
(+ `ADMIN`).

Предусловия:

- Заказ существует и `status === IN_PRODUCTION` — иначе
  `PassportOrderNotInProductionException`.
- `OrderItem` для `dto.sizeId` существует —
  `PassportSizeNotInOrderException`.
- Нет APPROVED `CuttingClosureRequest` на
  `(orderId, orderItem.productId, sizeId)` (см. §1.8) — иначе
  `PassportCuttingClosedException` (409 `CUTTING_CLOSED`).
- `dto.qtyCut <= remaining`, где `remaining = orderItem.qtyPlan −
  Σ qtyCut` по живым (≠ `CANCELLED`) паспортам этого размера —
  иначе `PassportQtyExceedsRemainingException`.
- В справочнике должна быть `Operation(code='CUT_DIVISION')`.

В `prisma.$transaction`:

1. `PassportNumberService.nextNumber(tx)`.
2. `Passport.create({ qrCode = 'passport-pending:<number>', status =
   CREATED, currentOperationId = CUT_DIVISION.id, currentEmployeeId
   = creator.id, cutterId = (Employee.login='cutter') ?? creator.id,
   currentRouteStepIndex = (order.routeSteps.length > 0 ? 0 :
   null) })`.
3. `Passport.update { qrCode = 'passport:<id>' }`.
4. `PassportEvent.create({ type: CREATED, operationId =
   CUT_DIVISION.id, employeeId = creator.id, qty = qtyCut, payload =
   { rollNumber, color } })`.
5. `EarningsService.createImmediateForCutter(tx, ...)` — сдельное
   начисление раскройщику (см. §10.2).

`creatorId` берётся из сессии (ADR-0014). `cutterId` на MVP — из
seed-учётки `cutter`, fallback к `creator`. UNKNOWN/TODO: «крой
бригадой» — отдельный шаг в будущем.

### 7.5 Размещение в ячейку и выдача

`POST /api/passports/:id/place` —
`PassportsService.place`
(`apps/api/src/modules/passports/passports.service.ts` ~337–460),
`docs/production-flow.md §5`.

В транзакции: инкремент `CellContent` по `(cellId, sizeId)` на
`qtyCut`, `Passport.update { currentCellId, status: остаётся
CREATED }`, `PassportEvent(CELL_PLACED)`, audit
`PASSPORT_PLACED` (`employeeId = null` — это управленческое
действие raw-handler-а).

`POST /api/passports/:id/issue` —
`PassportsService.issueToEmployee`
(`apps/api/src/modules/passports/passports.service.ts` ~462–658),
`docs/production-flow.md §6`. Две ветки:

- **«Из ячейки»** (`currentCellId !== null`): декремент
  `CellContent`, `Passport.update { currentCellId: null,
  currentEmployeeId = me, status: IN_PROGRESS }`,
  `PassportEvent(ISSUED_TO_EMPLOYEE)`, audit
  `PASSPORT_ISSUED { mode: 'FROM_CELL' }`.
- **«Route-WIP без ячейки»** (`currentCellId === null` и
  `currentRouteStepIndex !== null`): идемпотентный no-op для того
  же сотрудника на `IN_PROGRESS`; `PassportAlreadyIssuedException`
  при конфликте; иначе обновляем владельца, audit
  `PASSPORT_ISSUED { mode: 'ROUTE_WIP' }`.

Если у заказа **нет** маршрута и `currentCellId === null` —
`PassportNotInCellException` (старое поведение «нужно сначала
разместить в ячейке»).

**Cut release policy** проверяется только для первой операции
маршрута или операций категории `CUTTING` (`docs/production-flow.md §6.3`):

- `Passport.color !== policy.color` или `Passport.sizeId !==
  policy.sizeId` (когда заданы) →
  `CutReleasePolicyViolationException`.
- `consumedQty + qtyCut > limitQty` → та же ошибка.
- При успехе `consumeCutReleasePolicyInTx` атомарно инкрементит
  `CutReleasePolicy.consumedQty` через conditional `updateMany`
  (защита от race) + audit `CUT_RELEASE_POLICY_CONSUMED`.

**Order cut issue rule** проверяется ДО `CutReleasePolicy`, на тех
же условиях (первая операция маршрута / операции категории
`CUTTING`). Если у заказа есть активные строки очереди
(`OrderCutIssueRule.isActive = true && issuedQty < requiredQty`):

- `Passport.sizeId` не среди незавершённых строк →
  `OrderCutIssueRuleViolationException` с сообщением «Сначала нужно
  выдать: …» (см. `formatOrderCutIssueRuleViolationMessage` в
  `@sewing/shared`).
- `Passport.qtyCut > requiredQty - issuedQty` для соответствующей
  строки → та же ошибка с тем же текстом.
- При успехе `OrderCutIssueRulesService.consumeInTx` атомарно
  инкрементит `OrderCutIssueRule.issuedQty` через conditional
  `updateMany` (защита от race) + audit
  `ORDER_CUT_ISSUE_RULE_CONSUMED`. Если 0 строк затронуто (race с
  `disable-all` или другой выдачей) — VIOLATION с актуальным
  сообщением (без записи issue).

### 7.6 Скан и завершение операции

`POST /api/passports/:id/scan` —
`PassportsService.scanOnOperation`
(`apps/api/src/modules/passports/passports.service.ts` ~673–802),
`docs/production-flow.md §7.1`, `docs/events.md §2.9`, §9.5.

Контракт: «любой скан = переход на `session.operationId`».

Идемпотентность (ADR-0003 §6, `docs/events.md §9.8`): если
`currentOperationId === session.operationId && currentEmployeeId
=== me && status === IN_PROGRESS` — early-return до открытия
транзакции, новый event не пишется,
`createPendingForPreviousOperation` не вызывается.

QC-gate: вход на `OperationCategory.IRONING` без существующего
`PassportEvent(QC_PASSED)` отбивается
`PassportNotQcPassedException` (409 `PASSPORT_NOT_QC_PASSED`).

В транзакции:

- запоминаем `previousOperationId` / `previousEmployeeId`;
- считаем `nextRouteStepIndex` через `OrderRouteStep` lookup
  (`OPERATION_SCAN` не двигает `currentRouteStepIndex` если шаг
  не найден в snapshot — soft-route);
- `Passport.update { currentOperationId, currentEmployeeId, status:
  IN_PROGRESS, currentRouteStepIndex }`;
- `PassportEvent.create(OPERATION_SCAN)`;
- `EarningsService.createPendingForPreviousOperation(tx, ...)` —
  pending-начисление **предыдущему** исполнителю (см. §10.2);
- audit `PASSPORT_SCANNED`.

`POST /api/passports/:id/complete-operation` —
`PassportsService.completeOperationByEmployee`,
`docs/production-flow.md §7.2`, `docs/events.md §2.3`.

Швея явно завершает свою операцию по паспорту. Source of truth для
завершаемой операции — `session.operationId` (а **не**
`passport.currentOperationId`); это критично для route-WIP
«issue без последующего scan».

Запрещён откат назад по маршруту — `OrderRouteStep` с
`completedOperationId` стоящий раньше `currentRouteStepIndex` →
`PassportCompleteBackwardException` (409
`PASSPORT_COMPLETE_BACKWARD`). Откат — прерогатива мастера через
`MasterActionsService.setRouteStep`.

В транзакции: `Passport.update { currentEmployeeId: null,
currentCellId: null, currentOperationId =
completedOperationId, currentRouteStepIndex }`,
`PassportEvent(OPERATION_FINISHED)`, audit
`PASSPORT_OPERATION_COMPLETED`. Status остаётся `IN_PROGRESS` —
паспорт уходит из «current-work» швеи в WIP-buffer.

### 7.7 Резолверы по коду

`POST /api/passports/by-code` — `PassportsService.findByCode`
(см. `passports.controller.ts`). Резолв QR `passport:{id}`,
номера `P-…` или голого id без побочных эффектов. Используется
`/work` перед `issue` / `scan`.

---

<a id="8-qc-wto"></a>

## 8. ОТК / ВТО / дефекты

### 8.1 `DefectType`

Источник: `prisma/schema.prisma::DefectType`,
`apps/api/src/modules/qc/defect-types.controller.ts`,
`docs/api.md §38`.

Справочник видов брака. Поля: `code` (uniq), `name`, `isActive`,
`sortOrder`. Seed: `STAIN`, `HOLE`, `CROOKED_SEAM`, `SKEW`,
`INCOMPLETE`, `OTHER` (`prisma/seed.ts → seedDefectTypes`).
Расширение/деактивация — через будущий админ-UI; на MVP
write-эндпоинтов нет.

### 8.2 `PassportDefect` и фиксация брака

Источник: `prisma/schema.prisma::PassportDefect`,
`QcService.recordDefect`
(`apps/api/src/modules/qc/qc.service.ts`),
`docs/production-flow.md §8.2`, `docs/events.md §2.5`.

Поля: `passportId → Passport`, `defectTypeId → DefectType`, `qty`,
`comment?`, `createdByEmployeeId? → Employee`. Индексы:
`(passportId, createdAt)`, `(defectTypeId, createdAt)`.

`POST /api/qc/passports/:id/defects` (RBAC `QC` / `SHOP_MANAGER`
(+ `ADMIN`)). Гварды:

- `passport.status === IN_PROGRESS` — иначе
  `PassportNotQcableException`.
- `defectType` существует и активен.
- `dto.qty <= passport.qtyCut − passport.qtyDefect` (под локом
  внутри tx) — иначе `DefectExceedsRemainingException`.

В одной tx:

- `PassportDefect.create(...)`;
- `Passport.update { qtyDefect: { increment: qty }, qtyGood: {
  decrement: qty } }`;
- `PassportEvent.create({ type: DEFECT_RECORDED, employeeId,
  operationId = currentOperationId, qty, payload: { defectId,
  defectTypeId, defectTypeCode, defectTypeName, comment } })`.

**Асимметрия (`docs/events.md §9.12`).** `recordDefect` НЕ пишет
`AuditLog`. Все остальные «парные» доменные события паспорта
пишутся `PassportEvent + AuditLog`, кроме `CREATED` и
`DEFECT_RECORDED`. UNKNOWN/TODO: осознанный это выбор или пропуск
— код этого не фиксирует явно.

### 8.3 `QC_PASSED` — audit-маркер «ОТК прошло»

Источник: `QcService.completeQc`
(`apps/api/src/modules/qc/qc.service.ts`),
`docs/production-flow.md §8.3`, `docs/events.md §9.3`.

`POST /api/qc/passports/:id/complete` (RBAC `QC` / `SHOP_MANAGER`
(+ `ADMIN`)).

В одной tx:

- `PassportEvent.create({ type: QC_PASSED, employeeId,
  operationId = passport.currentOperationId, qty: qtyGood })`;
- audit `QC_COMPLETED`.

**Не меняет** `Passport.status` / `currentOperationId` /
`currentEmployeeId` / `currentCellId` — это аудит-маркер.
Идемпотентно: повторное «Проверка выполнена» допустимо, каждое
нажатие — отдельное событие.

Derived флаги в `QcService.loadDetail`:

- `qcCompletedAt` — `createdAt` самого свежего `QC_PASSED`;
- `removedFromQc` — `true` если `qcCompletedAt !== null` И
  (паспорт `PACKED`/`CANCELLED` ИЛИ есть `OPERATION_SCAN` после
  `qcCompletedAt`).

### 8.4 `WTO_PASSED` — audit-маркер «ВТО прошло»

Источник: `WtoService.completeWto`
(`apps/api/src/modules/wto/wto.service.ts`),
`docs/production-flow.md §9.2`, `docs/events.md §9.4`.

`POST /api/wto/passports/:id/complete` (RBAC `IRONING` /
`SHOP_MANAGER` (+ `ADMIN`)).

Гварды:

- `passport.status === IN_PROGRESS` —
  `PassportNotWtoableException`;
- `passport.currentOperation.category === IRONING` — то же
  exception;
- существует хотя бы один `PassportEvent(QC_PASSED)`
  (`assertQcPassed`) — иначе `PassportNotQcPassedException`.

В одной tx: `PassportEvent.create({ type: WTO_PASSED })` + audit
`WTO_COMPLETED`. Полный аналог `completeQc`: state паспорта не
меняется. Sub-инвариант «`WTO_PASSED` ⇒ был `QC_PASSED`»
дополнительно защищён в `PassportsService.scanOnOperation`
(QC-gate для `IRONING`, см. §7.6).

«Принять паспорт на ВТО» отдельной ручкой не оформлено — это
обычный `POST /api/passports/:id/scan` с операцией категории
`IRONING`. Backend сам делает QC-gate (`docs/api.md §28`).

### 8.5 RBAC и доступность для ОТК

`QcService.listForQc` отдаёт все паспорта со
`status === IN_PROGRESS` (ADR-0013): это компромисс шире, чем
«после первого `OPERATION_SCAN`», но не требует отдельного
запроса по событиям.

---

<a id="9-packing"></a>

## 9. Упаковка / коробки

### 9.1 `Box` / `BoxItem`

Источник: `prisma/schema.prisma::Box`/`BoxItem`,
`apps/api/src/modules/packing/packing.service.ts`,
`docs/erd.md §2.7`, `docs/production-flow.md §10`,
ADR-0011, ADR-0015.

`Box`:

- `number` (uniq, формат `B-YYYYMMDD-NNNN`,
  `BoxNumberService`);
- `qrCode` (uniq, `box:{id}`, ADR-0008);
- `totalQty Int @default(0)`, `maxQty Int @default(100)`;
- `closedAt DateTime?` — `null` пока коробка открыта;
- `createdById → Employee` (BoxCreator).

`BoxItem`:

- `boxId`, `passportId String @unique` (ГЛОБАЛЬНО уникален —
  ADR-0015), `(boxId, passportId)` UNIQUE, `qty Int`.

«Packed-флаг» хранится в `Passport.status = PACKED` и в
`PassportEvent(type = PACKED)`.

### 9.2 `addPassport` — добавление паспорта в коробку

Источник: `PackingService.addPassport`
(`apps/api/src/modules/packing/packing.service.ts` ~233–355).

`POST /api/packing/boxes/:id/add-passport` (RBAC `PACKING` /
`SHOP_MANAGER` (+ `ADMIN`)).

Pre-flight:

- `assertPackingActor(actorEmployeeId)` — у актора есть открытая
  `ShiftSession` на операции категории `PACKING`;
- резолв паспорта (`resolvePassport`) — по `passportId`,
  `passportNumber` или QR `passport:{id}`;
- гварды: `PACKED` → `PassportAlreadyPackedException`,
  `CANCELLED` → `PassportCancelledException`,
  `status !== IN_PROGRESS || qtyGood <= 0` →
  `PassportNotPackableException`.

В транзакции:

- перечитываем Box под локом, проверяем `closedAt === null`
  (`BoxClosedException`);
- однородность коробки (ADR-0011 §3): все `BoxItem` должны иметь
  тот же `(productId, sizeId, color)` что и новый паспорт —
  иначе `BoxHomogeneityViolatedException`;
- capacity: `passport.qtyGood > box.maxQty − box.totalQty` →
  `BoxCapacityExceededException`;
- `BoxItem.create({ boxId, passportId, qty: qtyGood })`;
- `Box.update { totalQty: { increment: qtyGood } }`;
- `Passport.update { status: PACKED, currentEmployeeId: null,
  currentCellId: null }` (`currentOperationId` оставляется как
  «последний след»);
- `PassportEvent(PACKED)`;
- audit `PASSPORT_PACKED` (`entityType = 'PACKING'`,
  `entityId = boxId`).

### 9.3 `close` — финальный апрув начислений

> **Снятие старого утверждения.** Финальный апрув начислений
> происходит **на закрытии коробки**, а **не** на add-passport.
> Раньше (до scan-driven редизайна `/packing`) апрув был на
> add-passport, и на это до сих пор могли ссылаться старые версии
> доки. Источник истины кода — `PackingService.close`
> (`apps/api/src/modules/packing/packing.service.ts` ~368–424) и
> комментарий `// Финальный шаг цепочки … перенесено на закрытие
> коробки`. Подробности — ADR-0005 §«Подтверждение», ADR-0011 §5,
> `docs/production-flow.md §10.4`/§11.3, `docs/events.md §9.6`.

Источник: `PackingService.close`,
`docs/production-flow.md §10.4`.

`POST /api/packing/boxes/:id/close` (RBAC `PACKING` /
`SHOP_MANAGER` (+ `ADMIN`)).

В одной транзакции:

- `assertPackingActor(actor)`;
- проверяем существование коробки и `closedAt === null`
  (`BoxClosedException`); `totalQty > 0`
  (`BoxEmptyCloseException`);
- `Box.update { closedAt: new Date() }`;
- для каждого `BoxItem.passportId` —
  `EarningsService.approvePendingForPassport(tx, passportId)`
  (см. §10.2);
- audit `BOX_CLOSED` (`payload: { boxId, totalQty, passportIds }`).

Идемпотентность повторного close — двумя уровнями:

- `BoxClosedException` не даст вызвать апрув повторно;
- `approvePendingForPassport` фильтрует только
  `PENDING_RELEASE`/`PENDING` — APPROVED-строки не цепляются.

**Дополнительных начислений упаковщику не создаётся** — упаковка
на MVP оплачивается окладом (см. §10).

### 9.4 Public-роуты

- `GET /api/packing/boxes/:id/qr` (Public, ADR-0008) — PNG QR
  `box:{id}`.
- `GET /api/packing/boxes/:id/label` (Public, ADR-0010) — HTML
  A6 80×120 мм этикетка.

### 9.5 Связь с агрегатами заказа

`Order.qtyFinishedTotal` — `Σ Passport.qtyGood` по PACKED-паспортам
заказа, считается через `aggregateOrder`
(`apps/api/src/modules/orders/order-aggregator.ts`). Отдельной
записи в `Order` нет.

---

<a id="10-payroll"></a>

## 10. Начисления / зарплата

### 10.1 Ось «как платим» — `Employee.compensationType`

Источник: `prisma/schema.prisma::Employee`,
`apps/api/src/modules/employees/compensation.ts`,
ADR-0021, `docs/erd.md §2.1`.

Единственная ось «как платим» —
`Employee.compensationType: CompensationType` enum
(`PIECEWORK | SALARY | MIXED`, default `PIECEWORK`). Историческое
поле `paymentType` удалено из схемы (миграция
`20260429100000_remove_payment_type`).

| `compensationType` | Получает `SalaryEntry`?         | Получает `OperationEntry`? |
| ------------------ | ------------------------------- | -------------------------- |
| `PIECEWORK`        | нет                             | да — по обычным правилам   |
| `SALARY`           | да (за каждый день со сменой)   | нет (silent skip)          |
| `MIXED`            | да                              | да                         |

Pure-функции в `apps/api/src/modules/employees/compensation.ts` —
**единственное** место, где правило выражается прямыми сравнениями
с enum-значениями:

- `isPieceworkEligible(type)` — `true` для `PIECEWORK`/`MIXED`
  (используется `EarningsService` как gate перед
  `OperationEntry`);
- `isSalaryEligible(type)` — `true` для `SALARY`/`MIXED`
  (используется `SalaryService.syncDailySalary` как gate перед
  `SalaryEntry`, а также `CostsService` / `DashboardService`);
- `requiresSalaryRate(type)` — тождествен `isSalaryEligible`,
  используется `EmployeesService.create/update` как guard перед
  `EMPLOYEE_SALARY_RATE_REQUIRED`.

`Employee.salaryPerShift Decimal(12,2)?` — обязателен для
`SALARY`/`MIXED` (инвариант
`requiresSalaryRate ⇒ salaryPerShift > 0`).
Историческое поле `Employee.salaryBase` («месячный оклад») удалено в
PHASE 2 STEP 1 — payroll-движок его никогда не использовал.

`Employee.cutterB2bSewingPercent: Decimal(5,2)?` — B2B-процент для
раскройщика (см. §10.2).

### 10.1a Привязка сотрудника к подразделению (PHASE 2 STEP 2)

Источник: `prisma/schema.prisma::Employee.companyDivisionId`,
`apps/api/src/modules/employees/employees.service.ts`,
`apps/api/src/modules/payroll/payroll.service.ts`.

`Employee.companyDivisionId String? → CompanyDivision` (`onDelete:
SetNull`, миграция
`20260532110000_employee_company_division`) — основная привязка
сотрудника к подразделению компании. Используется payroll-фильтром
«Подразделение» (`/api/payroll/period?divisionCode=...`,
`/api/payroll/daily?divisionCode=...`):

- Сдельная часть фильтра по-прежнему пробивается через
  `OperationEntry.passport.order.companyDivision.code` — крой и
  пошив попадают в подразделение **заказа**, а не сотрудника.
  Это правильно: один и тот же раскройщик может работать как на
  MARKETPLACE-, так и на B2B-заказы.
- Окладная часть и список смен теперь фильтруются через
  `Employee.companyDivision.code` (PHASE 2 STEP 2). Без этого
  поля менеджер не мог отделить «своих» окладников MARKETPLACE-цеха
  от общего цеха при `divisionCode`-фильтре.
- В строке ведомости `companyDivision`: сначала пытается взять
  «основное подразделение по сдельщине за период», иначе fallback
  на `Employee.companyDivision`. Это даёт окладникам без
  сдельщины корректное имя подразделения в колонке.

`null` — сотрудник пока не привязан (legacy-импорт, кадровик ещё
не заполнил). При `divisionCode`-фильтре такие сотрудники
включаются в выдачу, только если у них есть сдельщина в выбранном
подразделении.

`EmployeesService.create` / `update` валидируют, что выбранная
карточка существует (`COMPANY_DIVISION_NOT_FOUND`) и активна
(`COMPANY_DIVISION_INACTIVE`). Снять привязку (`null`) можно
всегда — это не валидируется.

### 10.2 Сдельные начисления (`OperationEntry`)

Источник: `prisma/schema.prisma::OperationEntry` (~1184),
`apps/api/src/modules/earnings/earnings.service.ts`,
ADR-0005, ADR-0012, ADR-0020,
`docs/production-flow.md §11`, `docs/erd.md §2.9`,
`docs/api.md §30`.

Поля: `passportId, operationId, employeeId, qty,
ratePerUnit: Decimal(12,2), amount: Decimal(12,2), status:
EntryStatus @default(PENDING_RELEASE), approvalMode: ApprovalMode
@default(AFTER_RELEASE), sourceEventType: EarningSource
@default(OPERATION_TRANSITION), sourceEventId?, createdAt,
approvedAt?`.

`amount = round(qty × ratePerUnit, 2)` — `Decimal(12,2)` через
`roundMoney`. `qty` берётся как `passport.qtyCut` (для immediate)
или `passport.qtyCut` (для pending — брак не вычитается из
ранее созданных начислений, ADR-0012 §3).

Идемпотентность: `@@unique(passportId, operationId, employeeId,
sourceEventType)` (`OperationEntry_idem`, ADR-0012). Повторный
trigger → `P2002` тихо проглатывается в `safeCreate`
(`docs/events.md §9.9`).

#### `ApprovalMode`

| Mode             | Кто                         | Когда `APPROVED`                                         |
| ---------------- | --------------------------- | -------------------------------------------------------- |
| `IMMEDIATE`      | Раскройщик (`CUT_CUT`)      | В момент создания (`approvedAt = createdAt`).           |
| `AFTER_RELEASE`  | Пошив                       | В транзакции **закрытия коробки** (`PackingService.close` → `EarningsService.approvePendingForPassport` для каждого `BoxItem`). |

`REVERSED` / `CANCELLED` — заложены в enum под будущий flow
возврата паспорта в производство; на MVP write-эндпоинтов под них
**нет** (UNKNOWN/TODO).

#### `EarningSource`

`PASSPORT_CREATED` (раскройщик) | `OPERATION_TRANSITION` (пошив).
`sourceEventId` (опц.) — ссылка на конкретный `PassportEvent.id`,
послуживший триггером (для пошива).

#### Триггеры создания

**`createImmediateForCutter`** — в транзакции
`PassportsService.create` после `PassportEvent(CREATED)`
(`docs/production-flow.md §11.1`):

- проверяет `Employee(cutterId).active &&
  isPieceworkEligible(compensationType)`;
- `Operation(code='CUT_CUT')`; если `pricingMode = SALARY_ONLY`
  — silent skip (раскрой переведён на оклад);
- источник истины для схемы — `passport.order.companyDivision.code`
  через `getCutterCompensationSchemeForDivision`
  (`packages/shared/src/cutter-compensation.ts`):
  - `MARKETPLACE` → `MARKETPLACE_FIXED`:
    `amount = Operation.fixedRate × qty` через
    `OperationsService.resolveRate` (FIXED / BY_SIZE);
  - `OTHER` (а также любой произвольный `CompanyDivision.code` или
    отсутствие привязки) → `B2B_SEWING_PERCENT`:
    `base = Σ rate(SEWING-операция, размер) × qty`,
    `percent = employee.cutterB2bSewingPercent ?? ENV
    CUTTER_B2B_SEWING_PERCENT`,
    `amount = base × percent / 100`.
- запись: `status: APPROVED, approvalMode: IMMEDIATE,
  sourceEventType: PASSPORT_CREATED, approvedAt: createdAt`.

**`createPendingForPreviousOperation`** — в транзакции
`PassportsService.scanOnOperation` для **предыдущей** операции
(`docs/production-flow.md §11.2`):

- skip если `previousOperationId === null` или
  `previousEmployeeId === null` (первый scan после CUT_DIVISION
  без явного previous);
- skip если `qty <= 0`;
- `Operation(previousOperationId).pricingMode === SALARY_ONLY` или
  `code === 'CUT_CUT'` — skip;
- `Employee(previousEmployeeId)` должен быть `active &&
  isPieceworkEligible`;
- `OperationsService.resolveRate(operationId, sizeId, tx)` —
  единственный источник ставки (FIXED / BY_SIZE; SALARY_ONLY →
  null/skip);
- если ставка не найдена — silent skip;
- запись: `status: PENDING_RELEASE, approvalMode: AFTER_RELEASE,
  sourceEventType: OPERATION_TRANSITION, sourceEventId =
  PassportEvent.id, approvedAt: null`.

**`approvePendingForPassport`** — в транзакции
`PackingService.close` для каждого `BoxItem.passportId`
(`docs/production-flow.md §11.3`):

- `OperationEntry.updateMany({ where: { passportId, status: { in:
  [PENDING_RELEASE, PENDING] } }, data: { status: APPROVED,
  approvedAt: new Date() } })`.
- Возвращает `count` затронутых записей (для логов).
- **Единственный** call-site — `PackingService.close`
  (`docs/events.md §9.6`).

> Устаревший JSDoc в `EarningsService` (`earnings.service.ts:52`)
> упоминает «вызывается из `PackingService.addPassport`» — это
> ложный след; реальный call-site только в `close()`. На поведение
> это не влияет, но зафиксировано как WARNING в
> `docs/events.md §9.6`.

#### Read-эндпоинты

`GET /api/earnings`, `/api/earnings/summary`,
`/api/passports/:id/earnings` — RBAC через `applyViewerScope` в
`EarningsService` (`docs/api.md §30`):

- `SHOP_MANAGER`/`ADMIN` (=`EARNINGS_MANAGER_ROLES`) видят все
  строки и могут фильтровать `employeeId`/`status`;
- остальные роли — принудительный скоуп `employeeId =
  viewer.employeeId` И `status: APPROVED`.

### 10.3 Окладные начисления (`SalaryEntry`)

Источник: `prisma/schema.prisma::SalaryEntry` (~1236),
`apps/api/src/modules/salary/*`,
ADR-0021, `docs/production-flow.md §12`, `docs/erd.md §2.9`,
`docs/api.md §31`.

Поля: `employeeId, date: Date, amount: Decimal(12,2), source:
SalaryEntrySource @default(SHIFT_DAY), editedManually: Boolean
@default(false), managerComment?, editedByEmployeeId?,
createdAt, updatedAt`. Уникальность —
`@@unique([employeeId, date, source])` (один день — одна запись на
сотрудника для одного `source`).

#### `SalaryEntrySource`

- `SHIFT_DAY` — автоматическая запись от факта смены (см. ниже).
- `MANUAL` — зарезервирован под кейс «оплатить день, в который
  смены физически не было». UNKNOWN/TODO: в `SalaryService` нет
  явного create-пути под `source = MANUAL`
  (`docs/production-flow.md §12.1`).

#### `syncDailySalary(employeeId, date, tx?)`

Создаёт/обновляет ровно одну `SalaryEntry` на пару `(employeeId,
date)` для `source = SHIFT_DAY`. Безопасно вызывать любое
количество раз. Алгоритм:

1. Грузит `Employee.compensationType`/`salaryPerShift`/`active`.
   `PIECEWORK` или `!active` → return null.
2. Считает количество `ShiftSession` за UTC-сутки. 0 → return null.
3. `salaryPerShift === null` → return null (аномалия, но не валим
   `start/stop shift`).
4. `upsert` по `(employeeId, date, source = SHIFT_DAY)`:
   - update только если `editedManually = false` →
     `amount = salaryPerShift`;
   - создание новой → `amount = salaryPerShift, source: SHIFT_DAY`;
   - если `editedManually = true` — `amount` не трогается.

Точки вызова — `ShiftsService.start` / `ShiftsService.stop` через
`safeSyncSalary` (fail-soft логер: ошибка sync **не валит** сам
shift).

#### Ручная корректировка

`PATCH /api/salary/:id` (RBAC `SHOP_MANAGER` / `ADMIN`):

- `amount` (опц.) — новая сумма;
- `managerComment` (опц., `null` = очистить);
- `reset = true` — снять ручную правку, вернуть запись под
  `syncDailySalary` (`amount = employee.salaryPerShift`; если
  ставка не задана — 422 `SALARY_RATE_MISSING`).

Любая правка ставит `editedManually = true` и `editedByEmployeeId
= viewer.employeeId`. `employeeId`/`date`/`source` менять через
PATCH **нельзя**.

### 10.4 RBAC

| Endpoint                                | Роли                                  |
| --------------------------------------- | ------------------------------------- |
| `GET /api/earnings`, `/summary`         | Any auth (scope в сервисе)            |
| `GET /api/salary`, `/summary`           | Any auth (scope в сервисе)            |
| `PATCH /api/salary/:id`                 | `SHOP_MANAGER`, `ADMIN`               |
| `GET /api/employees`, `POST/PATCH /:id` | `SHOP_MANAGER`, `ADMIN`               |

Список менеджерских ролей — `SALARY_MANAGER_ROLES`
(`apps/api/src/modules/salary/salary.constants.ts`,
зеркало `EARNINGS_MANAGER_ROLES`).

### 10.5 Что MVP сознательно НЕ делает

- Расчёт часов / half-day / коэффициенты загрузки.
- Месячный payroll по календарю / норме часов.
- Отпуска / больничные / командировки.
- Удержания за брак для окладных ролей.
- Интеграция с 1С/ЗУП и экспорт в Excel.
- История изменений `SalaryEntry.amount` (только последний
  `editedBy`).

<a id="106-payroll-phase-1-read-only"></a>

### 10.6 Payroll PHASE 1 — read-only управленческая ведомость

Источник: `apps/api/src/modules/payroll/*`,
`packages/shared/src/payroll.ts`, `docs/api.md §10c`,
`docs/screens.md §12a`.

Задача — дать `SHOP_MANAGER` и `ADMIN` собранный взгляд на зарплату
за период / день / по сотруднику, **не меняя ядро начислений**:
сдельщину пишет `EarningsService`, оклад — `SalaryService`,
закрытие коробки апрувит pending — `PackingService.close`. Payroll
ничего из этого не трогает: только агрегирует через `groupBy` и
`findMany`.

Source of truth остаётся прежним:

- сдельная зарплата → `OperationEntry`
  (см. §10.2, ADR-0005, ADR-0012);
- окладная зарплата → `SalaryEntry`
  (см. §10.3, ADR-0021);
- факт смены → `ShiftSession`
  (см. `apps/api/src/modules/shifts/*`).

**Что считаем (`/api/payroll/period`):**

Релевантные сотрудники — те, у кого В ПЕРИОДЕ есть хоть одна
строка `OperationEntry`, `SalaryEntry` или `ShiftSession`. Дальше
по каждому считаем:

- `pieceworkApprovedRub` — Σ `OperationEntry.amount`,
  `status = APPROVED` (по `createdAt`);
- `pieceworkPendingRub` — Σ `OperationEntry.amount`,
  `status ∈ {PENDING_RELEASE, PENDING}` (legacy `PENDING`
  считается тем же ведром, как и в `EarningsService.toDto`);
- `salaryRub` — Σ `SalaryEntry.amount` по `date`
  (включая `MANUAL`-источник, если такой появится);
- `salaryEditedRub` — Σ `SalaryEntry.amount` среди
  `editedManually = true` (KPI «сколько правки» для аудита);
- `daysOnShift` — количество **уникальных дат** `startedAt::date`
  (совпадает с правилом `SalaryService.syncDailySalary`);
- `entriesCount` — количество строк сдельщины;
- `companyDivision` — «основное подразделение сотрудника» как
  подразделение с наибольшим числом сдельных строк за период
  (`OperationEntry.passport.order.companyDivision`); для окладных
  ролей и для сотрудников без сдельщины — `null`.

Total на сотрудника:

```
totalApproved = pieceworkApproved + salaryRub
totalPending  = pieceworkPending
total         = totalApproved + totalPending
```

Эти три значения суммируются в `summary` ответа.

**Фильтры:**

- `dateFrom` / `dateTo` — обязательны (защита от случайного «всё за
  всё время»);
- `employeeId` / `role` — фильтр по сотруднику или его роли;
- `divisionCode` — режет сдельщину через
  `OperationEntry.passport.order.companyDivision.code`. Окладные
  начисления подразделению **не принадлежат** (они прибиты к
  сотруднику), поэтому при выбранном `divisionCode` сотрудник
  попадает в выдачу, только если у него в этом подразделении
  была хоть одна сдельная строка; `salaryRub` при этом
  включается полностью (мы не дробим оклад по подразделениям —
  это была бы искусственная атрибуция).
- `status` — `APPROVED` / `PENDING_RELEASE` (legacy `PENDING`
  входит в `PENDING_RELEASE`); фильтрует только сдельщину.

**Что считаем (`/api/payroll/daily`):** ровно те же поля, но за
один календарный день. Дополнительно — `hadShift` (была ли
`ShiftSession` за `date`), `shiftStartedAt = MIN(startedAt)`,
`shiftStoppedAt = MAX(endedAt)` (последнее `null`, если хоть одна
смена дня не закрыта).

**Что считаем (`/api/payroll/employees/:id`):** карточка одного
сотрудника за период — реквизиты + summary + `shifts[]` +
`operationEntries[]` + `salaryEntries[]`. Pagination сознательно
нет: на одного сотрудника за разумный период (месяц-два) объём
небольшой.

**RBAC.** Только `SHOP_MANAGER` и `ADMIN`
(`PAYROLL_MANAGER_ROLES` в
`apps/api/src/modules/payroll/payroll.constants.ts`). Все
остальные роли по-прежнему ходят за личной зарплатой через
`/api/earnings` и `/api/salary` — там `applyViewerScope` режет
ответ по своему `employeeId` (см. §10.4). Payroll сознательно
жёстче: это **управленческая** ведомость, не личный кабинет.

**Чего PHASE 1 НЕ делает:**

- не пишет в БД (нет POST/PATCH ручек, нет ledger-таблицы);
- не меняет статусы / суммы / lifecycle `OperationEntry` /
  `SalaryEntry`;
- не пишет `AuditLog` — read-only журналировать нечего
  (см. `docs/events.md`);
- не вводит «manual entry» / «reverse» / «lock period» — это
  скоуп PHASE 3 PayrollPayout. PHASE 2 STEP 1 удалила legacy-поля
  `Employee.salaryBase` и таблицу `PieceRate`, чтобы реальная модель
  payroll стала прозрачной.

UI поверх этих ручек живёт в `/admin/payroll`,
`/admin/payroll/daily`, `/admin/payroll/employees/[id]` и
навигационном hub-е `/admin/payroll/settings`
(см. `docs/screens.md §12a`).

---

<a id="11-warehouse"></a>

## 11. Склад / ячейки

### 11.1 `Warehouse` / `WarehouseLine`

Источник: `prisma/schema.prisma::Warehouse`,
`apps/api/src/modules/warehouses/*`, ADR-0019,
`docs/erd.md §2.6`, `docs/api.md §26`.

`Warehouse`: `name` (uniq), `code? @unique`, `isActive`,
`labelTemplate?`. Связи: `Cell[]`, `WarehouseLine[]`. Индекс
`isActive`.

`WarehouseLine` — линия склада (полка/ряд). `code` уникален
**глобально**. `warehouseId → Warehouse` (Cascade).

### 11.2 `Cell` / `CellContent`

Источник: `prisma/schema.prisma::Cell`/`CellContent`,
`apps/api/src/modules/passports/cells.controller.ts`,
ADR-0008, `docs/erd.md §2.6`, `docs/api.md §25`.

`Cell`: `code` (uniq), `qrCode` (uniq, `cell:{id}` — ADR-0008),
`active`, `warehouseId? → Warehouse`, `lineId? → WarehouseLine`
(`SetNull`), `lineIndex: Int?`. `(lineId, lineIndex)` UNIQUE.

`CellContent` — `(cellId, sizeId, quantity)`,
`@@unique([cellId, sizeId])`. Это **лёгкий счётчик**;
истинный размещённый паспорт хранится в
`Passport.currentCellId`.

### 11.3 Операции

- **`POST /api/passports/:id/place`** — инкремент
  `CellContent[size] += qtyCut`, `Passport.currentCellId = cell.id`,
  `PassportEvent(CELL_PLACED)`. См. §7.5.
- **`POST /api/passports/:id/issue`** (FROM_CELL ветка) —
  декремент `CellContent[size]` через `max(quantity − qtyCut, 0)`,
  `Passport.currentCellId = null`. Отдельного `CELL_REMOVED`
  события на этом шаге **не пишется** (`docs/events.md §2.7`,
  `§9.1` WARNING).
- **`MasterActionsService.returnToCell` / `setRouteStep`
  (BACKWARD)** — инкремент `CellContent[size]`. Идемпотентно для
  той же ячейки (`noop = true` в audit).

### 11.4 RBAC и UI

- `GET /api/cells*`, `POST /api/cells/by-code` — Any auth.
- `PATCH /api/cells/:id` — `SHOP_MANAGER`/`ADMIN`. На MVP правит
  только `warehouseId` (см. `WarehousesService.setCellWarehouse`).
- Все `/api/warehouses/*` — `SHOP_MANAGER`/`ADMIN`.
- `GET /api/cells/:id/print`, `/qr` — `@Public()` (для принтер-станции).

Массовая печать этикеток (`POST /api/warehouses/:id/print-cells`,
`docs/api.md §26`): backend создаёт `cellsCount × copies`
PENDING-`PrintJob`-ов с `sourceType=CELL_LABEL` (см. §14).

### 11.5 Что склад НЕ делает

- Не влияет на размещение паспорта в ячейку (любая ячейка
  пригодна, склад — только группировка).
- Не вводит capacity/планирование.
- Не моделирует зоны/секции/полки за пределами `WarehouseLine`.

---

<a id="12-shopfloor"></a>

## 12. Экран цеха / Display

### 12.1 Shopfloor projection (read-only)

Источник: `apps/api/src/modules/shopfloor/shopfloor.service.ts`,
`apps/api/src/modules/shopfloor/shopfloor-projection.ts`
(`bucketOf`, `projectShopfloor`, `projectShopfloorDisplay`),
ADR-0013, `docs/production-flow.md §15`, `docs/api.md §32`.

Не доменная сущность, а **проекция** «размер × этап → qty» поверх
существующих агрегатов (orders + passports + qc + packing). Никаких
новых таблиц, событий или мутаций — все правила маппинга в чистой
функции `bucketOf(p: ProjectionPassport): ShopfloorStage | null`.

### 12.2 ShopfloorStage buckets

| Bucket    | Условие на паспорте                                                                                                          | qty       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- |
| `CUT`     | `status = CREATED` ИЛИ (rare) `IN_PROGRESS + currentOperationCategory = CUTTING + currentEmployeeId = null` (CUT-rollback мастером). | `qtyCut`  |
| `SEWING`  | `IN_PROGRESS + currentOperationCategory ∈ {CUTTING, SEWING}` (CUTTING сюда попадает после `issueToEmployee` до первого `OPERATION_SCAN`) ИЛИ `currentOperationCategory = null` (защита от «дыр»). | `qtyCut`  |
| `QC`      | `IN_PROGRESS + currentOperationCategory = QC + НЕТ свежего QC_PASSED`.                                                       | `qtyCut`  |
| `QC_DONE` | `IN_PROGRESS + currentOperationCategory = QC + есть свежий QC_PASSED` (`createdAt > max(OPERATION_SCAN.createdAt)`).         | `qtyCut`  |
| `WTO`     | `IN_PROGRESS + currentOperationCategory = IRONING + НЕТ свежего WTO_PASSED`.                                                 | `qtyCut`  |
| `WTO_DONE`| `IN_PROGRESS + currentOperationCategory = IRONING + есть свежий WTO_PASSED`.                                                 | `qtyCut`  |
| `PACKING` | `PACKED + хотя бы один BoxItem в OPEN-коробке (box.closedAt IS NULL)`.                                                       | `qtyGood` |
| `FINISHED`| `PACKED + PACKING-условие не сработало` (нет `BoxItem` или все коробки закрыты).                                             | `qtyGood` |

`DEFECT` — **не stage**; отдельный показатель
`Σ Passport.qtyDefect` среди не-`CANCELLED` паспортов.
`CANCELLED`-паспорта исключаются во всех бакетах.

Источник свежести `QC_PASSED` / `WTO_PASSED`:
`ShopfloorService.getDisplaySummary` гонит один `groupBy` по
`PassportEvent`, ограниченный кандидатами (`IN_PROGRESS + category
∈ {QC, IRONING}`), и сравнивает `max(createdAt)` с
`max(OPERATION_SCAN.createdAt)`.

### 12.3 `Order.companyDivisionId` (CompanyDivision = master)

Источник: `prisma/schema.prisma::Order.companyDivisionId`,
`docs/order-flow.md §1`, `docs/api.md §13`.

`CompanyDivision` — единственный источник истины подразделений
заказа и display screens (см. `docs/erd.md §«CompanyDivision»`).
У `Order` есть FK `companyDivisionId → CompanyDivision`
(`onDelete: SetNull`). Базовые карточки `MARKETPLACE` / `OTHER`
(B2B) гарантированно созданы миграцией
`…_link_company_divisions_to_orders` и `prisma/seed.ts` /
`tests/utils/seed.ts`.

`OrdersService.create` / `update` пишут `companyDivisionId`
напрямую:

- если фронт передал id, backend проверяет существование карточки
  (400 `COMPANY_DIVISION_NOT_FOUND` иначе);
- если фронт передал `null` — привязка снимается;
- если поле не пришло (на create) или `undefined` (на update) —
  заказ остаётся без подразделения / Prisma не трогает колонку.

Меняется только в `DRAFT`, после `IN_PRODUCTION` блокируется общим
guard `ORDER_LOCKED`. Индекс — `companyDivisionId`.

Влияет на сдельную схему раскройщика (см. §10.2):
`EarningsService` читает `passport.order.companyDivision?.code` и
выбирает схему через `getCutterCompensationSchemeForDivision`:

- `MARKETPLACE` → `MARKETPLACE_FIXED`;
- `OTHER` / любой произвольный `CompanyDivision.code` / `null` →
  `B2B_SEWING_PERCENT` (безопасный default).

### 12.4 `DisplayScreenConfig` и DISPLAY-учётка

Источник: `prisma/schema.prisma::DisplayScreenConfig`,
`apps/api/src/modules/display-screens/*`,
`docs/erd.md §2.10`, `docs/api.md §33`.

Управленческая запись «один большой монитор цеха». 1:1 связана с
`Employee(role = DISPLAY)` через `employeeId @unique`.

Поля: `name`,
`companyDivisionId? → CompanyDivision` (master-связка с
справочником подразделений, `onDelete: SetNull`),
`employeeId String UNIQUE → Employee` (`onDelete: Cascade`),
`isActive`. Индексы: `isActive`, `companyDivisionId`.

`DisplayScreensService.create` пишет FK `companyDivisionId`
напрямую. Если карточка не найдена — 400
`COMPANY_DIVISION_NOT_FOUND` (Zod дополнительно требует
непустую строку id, чтобы UI получал адресные ошибки без
round-trip).

Жёсткие правила:

- Создание DISPLAY-учётки идёт только через
  `DisplayScreensService.create` — одной транзакцией создаёт
  `Employee(role=DISPLAY, compensationType=SALARY,
  salaryPerShift=null, active=true)` и `DisplayScreenConfig`.
- В `/admin/employees/new` роль `DISPLAY` сознательно скрыта
  (`EMPLOYEE_ROLES`).
- `compensationType=SALARY, salaryPerShift=null` — DISPLAY-учётки
  не загрязняют ни `OperationEntry`, ни `SalaryEntry`.
- `DISPLAY` middleware (`apps/web/middleware.ts`) уводит на
  `/shopfloor/display`; backend `@Roles` режет её во всех
  управленческих endpoint-ах.

**Auto-resolve подразделения в `/api/shopfloor/display`.** Без
`?divisionCode=` `ShopfloorService.resolveDisplayDivisionCode`
смотрит на роль вызывающего: если `DISPLAY` и есть активный
`DisplayScreenConfig` с привязанным `companyDivisionId` — фильтр
берётся из `config.companyDivision.code`. Конфиг с
`isActive = false` сознательно игнорируется (мягкий выключатель
экрана). `?divisionCode=<code>` всегда перекрывает auto-resolve.

### 12.5 Дашборд начальника производства

Источник: `apps/api/src/modules/dashboard/dashboard.service.ts`,
`docs/api.md §34`.

`/api/dashboard/production` (RBAC `SHOP_MANAGER`/`ADMIN`/`DISPLAY`)
— агрегатор поверх существующих источников: `Passport` + `Order` +
`PassportEvent(QC_PASSED/WTO_PASSED)` + `CostsService` +
`PassportDurationsService`. Маппинг на стадии — те же правила, что
у `/shopfloor` (ADR-0013), чтобы цифры совпадали 1:1.

Семантика «сегодня vs период» жёсткая:

- KPI «сегодня» (`producedToday`, `avgCostPerUnitToday`,
  `idleCostToday`, `utilizationToday`) — UTC-сегодня независимо от
  `?days=`;
- график (`trend`) и сводки `…Period` — за `[dateTo − days + 1 .. dateTo]`.

---

<a id="13-master"></a>

## 13. Мастер / MasterCall / MasterActions

### 13.1 `MasterCall` (вызов мастера)

Источник: `prisma/schema.prisma::MasterCall` (~2112),
`apps/api/src/modules/master-calls/*`,
`docs/erd.md §2.10` / §3, `docs/production-flow.md §14.1`,
`docs/api.md §22`, `docs/events.md §4`.

Поля:

- `employeeId → Employee` (инициатор вызова);
- `equipmentId? → Equipment` — снэпшот оборудования активной
  смены на момент создания;
- `operationId? → Operation` — снэпшот операции активной смены;
- `status: MasterCallStatus @default(OPEN)` —
  `OPEN | RESOLVED | CANCELLED` (последний зарезервирован, в коде
  не используется — UNKNOWN/TODO `docs/events.md §4.2`);
- `message?` — комментарий рабочего (UI пустой на MVP);
- `createdAt`, `resolvedAt?`, `resolvedById?`.

Индексы: `(status, createdAt)`, `(employeeId, status)`,
`(equipmentId, status)`.

Lifecycle:

| Переход                  | Сервис                                       | AuditLog event           |
| ------------------------ | -------------------------------------------- | ------------------------ |
| (insert) `OPEN`          | `MasterCallsService.create`                  | `MASTER_CALLED` (только при реальном создании; идемпотентный return existing — без audit) |
| `OPEN → RESOLVED`        | `MasterCallsService.resolveByEmployeeQr`     | `MASTER_CALL_RESOLVED`   |

Идемпотентность: у одного сотрудника не может быть больше одного
`OPEN`. `MasterCallsService.create` перед `INSERT` ищет существующий
`OPEN` и возвращает его без создания дубля и без audit-записи.

`PassportEvent` при вызовах мастера **не пишется** — это action над
сотрудником, не над паспортом (`docs/events.md §4.3`).

RBAC:

- `POST /api/master-calls` — все рабочие роли + `SHOPFLOOR_MASTER`
  + `SHOP_MANAGER` + `ADMIN`.
- `GET /api/master-calls`, `POST /resolve-by-employee-qr` —
  `SHOPFLOOR_MASTER` / `SHOP_MANAGER` / `ADMIN`.

### 13.2 `MasterActions` (действия мастера над паспортами)

Источник: `apps/api/src/modules/master-actions/master-actions.service.ts`,
`packages/shared/src/master-actions.ts`,
`docs/production-flow.md §14.2`, `docs/api.md §23`.

Stage 2 «Мастер цеха» — ручной инструментарий «закрытия проблем».
Все эндпоинты возвращают `MasterActionResultDto({ passport,
before })` и пишут в `AuditLog` (`MASTER_PASSPORT_*`,
`entityType = 'PASSPORT'`).

| Действие              | Сервис                              | Что меняется в `Passport`                                                                                                        | AuditLog event |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `unassign`            | `MasterActionsService.unassign`     | `currentEmployeeId = null`. `currentOperationId` / `currentRouteStepIndex` сохраняются.                                          | `MASTER_PASSPORT_UNASSIGNED` |
| `transferToEmployee`  | `MasterActionsService.transferToEmployee` | `currentEmployeeId = target`, `currentCellId = null`, `status = IN_PROGRESS`. Если у target активная смена с операцией из snapshot — двигаем `currentRouteStepIndex` / `currentOperationId`. | `MASTER_PASSPORT_TRANSFERRED` |
| `returnToCell`        | `MasterActionsService.returnToCell` | `currentCellId = cell.id`, `currentEmployeeId = null`. `CellContent[size] += qtyCut`. Идемпотентно: `noop = true` если уже в этой ячейке. | `MASTER_PASSPORT_RETURNED_TO_CELL` |
| `setRouteStep`        | `MasterActionsService.setRouteStep` | `currentOperationId = op.id`, `currentRouteStepIndex = idx`, `currentEmployeeId = null`, `status = IN_PROGRESS`. **Forward**: `currentCellId = null`. **Backward**: обязательно требуется placement в ячейку (`MASTER_BACKWARD_ROUTE_REQUIRES_CELL` если нет cellQr/cellId), `currentCellId = cell.id`, `CellContent[size] += qtyCut`. | `MASTER_PASSPORT_ROUTE_STEP_SET` (`payload: { direction: 'FORWARD' | 'BACKWARD', requiredCellPlacement: bool, cellId? }`) |

Каждое действие требует обязательного `reason` (Zod-enum
`MASTER_ACTION_REASONS = WRONG_SCAN | SHIFT_HANDOVER |
EMPLOYEE_MISTAKE | ROUTE_CORRECTION | CELL_CORRECTION |
MANAGER_DECISION | OTHER`) и опциональный `comment` (≤500 символов).
Без `reason` API возвращает 400 ещё до сервиса (Zod).

Audit-payload содержит `reason`, `comment?`, `before`/`after`-снэпшот
ключевых полей паспорта (`currentEmployeeId`, `currentCellId`,
`currentOperationId`, `currentRouteStepIndex`, `status`) +
target-метаданные (`targetEmployeeId`, `cellId`/`cellCode`,
`operationId`/`routeStepIndex`, `qtyReturned`/`noop`).

### 13.3 Safety-инварианты

- Запрещено менять терминальные паспорта `PACKED` / `CANCELLED`
  (`PassportTerminalForMasterException`, 409 `PASSPORT_TERMINAL`).
- `setRouteStep` принимает только шаг из snapshot
  `OrderRouteStep` заказа (`MASTER_ROUTE_STEP_NOT_IN_SNAPSHOT`);
  если у заказа snapshot нет — `MASTER_ORDER_HAS_NO_ROUTE_SNAPSHOT`.
- `setRouteStep` назад без placement —
  `MASTER_BACKWARD_ROUTE_REQUIRES_CELL` (400).
- `transferToEmployee` запрещён для несуществующего/неактивного
  target (`MASTER_TARGET_EMPLOYEE_NOT_FOUND`/`_INACTIVE`).
- `returnToCell` запрещён для несуществующей/неактивной ячейки
  (`CELL_NOT_FOUND` / `CELL_INACTIVE`).

### 13.4 WARNING — нарушение инварианта PassportEvent в одной транзакции

Источник: `docs/events.md §9.1` — частичное нарушение.

`MasterActionsService.{unassign, transferToEmployee, returnToCell,
setRouteStep}` меняют «горячие» поля паспорта (`currentEmployeeId`,
`currentOperationId`, `currentCellId`, `currentRouteStepIndex`,
`status`), но **`PassportEvent` НЕ пишут** — только `AuditLog`.

Это сознательная асимметрия (см. `docs/events.md §8.3`), но
формально инвариант «PassportEvent атомарен с change of state»
(`docs/events.md §9.1`) в этих транзакциях не выполняется. Все
читатели `PassportEvent` (durations, stage derivation,
shopfloor-projection) этих изменений в потоке событий **не
увидят**.

UNKNOWN/TODO: переход на пара `PassportEvent + AuditLog` для
master-actions — отдельная задача; в MVP сознательно отложен.

### 13.5 RBAC

- `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN`.
- Запрещено: `SEAMSTRESS`, `CUTTER`, `CUTTER_ASSISTANT`, `QC`,
  `IRONING`, `PACKING`, `DISPLAY`.
- `SHOPFLOOR_MASTER` сознательно **не** имеет доступа к
  admin-справочникам, ценам, маршрутам, пользователям, техкартам
  — это зона менеджера/админа. Его UI ограничен `/master`.

### 13.6 Что master-actions сознательно не делает

- Не вводит ограничения выдачи кроя — `issueToEmployee` не
  меняется. Ограничение выдачи делается через `CutReleasePolicy`
  (см. §1.7).
- Не делает «автомастера» / auto-fix — каждое действие требует
  явного подтверждения и причины.
- Не закрывает `MasterCall` автоматически после действия —
  `MasterCall` закрывается отдельной кнопкой
  `resolve-by-employee-qr`.

---

<a id="14-printing"></a>

## 14. Печать / PrintJob / Agent

### 14.1 Сущности

Источник: `prisma/schema.prisma::Printer`/`PrintJob`,
`apps/api/src/modules/printers/*`,
ADR-0008, ADR-0010, `docs/erd.md §2.13`, `docs/api.md §39`-§41,
`docs/events.md §7`, `apps/agent/README.md`.

#### `Printer` (логический)

| Поле                           | Тип                  | Назначение                                            |
| ------------------------------ | -------------------- | ----------------------------------------------------- |
| `id`                           | cuid                 | Постоянный идентификатор.                             |
| `name`                         | string               | UI-имя.                                               |
| `type`                         | `PrinterType` enum   | `PASSPORT`/`QR`/`LABEL`/`DEFAULT`. Управленческая метка. На MVP логика выбора принтера НЕ использует — только `equipmentId + isActive`. |
| `equipmentId? → Equipment`     | FK (`SetNull`)       | Привязка к рабочему месту.                            |
| `isActive`                     | bool                 | Менеджерская мягкая деактивация.                      |
| `pairingCode?`                 | string               | Одноразовый код для агента.                           |
| `agentToken?`                  | string               | Постоянный секрет агента после `pair`.                |
| `isOnline`                     | bool                 | True после успешного heartbeat.                       |
| `lastSeenAt?`                  | timestamp            | Время последнего контакта агента.                     |
| `agentHostName?`               | string               | `os.hostname()` Windows-машины.                       |
| `availableWindowsPrinters`     | string[] (`@default([])`) | Список физических Windows-принтеров (от `Get-Printer`). |
| `windowsPrintersUpdatedAt?`    | timestamp            | Когда агент в последний раз прислал список.           |
| `selectedWindowsPrinter?`      | string               | Имя выбранного физического Windows-принтера.          |

Индексы: `(equipmentId, isActive)`, `isOnline`, `pairingCode`,
`agentToken`.

Логический `Printer` (БД) и физический Windows-принтер (драйвер на
машине) — **разные сущности**. Связка задаётся через
`selectedWindowsPrinter` (имя из последнего
`availableWindowsPrinters` от этого `agentHostName`).

#### `PrintJob`

| Поле           | Тип                    | Назначение                                              |
| -------------- | ---------------------- | ------------------------------------------------------- |
| `printerId`    | FK → `Printer` (Cascade) | Куда печатаем.                                        |
| `sourceType`   | `PrintJobSource` enum  | `PASSPORT_QR | PASSPORT_PRINT | BOX_LABEL | CELL_QR | CELL_LABEL | TEST`. |
| `sourceId?`    | string                 | ID объекта-источника (без FK).                          |
| `payloadUrl`   | string                 | Абсолютный URL уже существующего печатного endpoint-а. |
| `status`       | `PrintJobStatus` enum  | `PENDING → PRINTED | FAILED`.                            |
| `errorMessage?`| string                 | Заполняется агентом при `FAILED`.                       |
| `completedAt?` | timestamp              | Когда агент закрыл задание.                             |

Индексы: `(printerId, status, createdAt)`, `(status, createdAt)`.

Lifecycle (`docs/events.md §7.2`):

| Переход               | Writer                              | Примечание                                  |
| --------------------- | ----------------------------------- | ------------------------------------------- |
| (insert) `PENDING`    | `PrintJobsService.createForUser` / `createBatch` | `payloadUrl` собирается через `buildPayloadUrl` (`sourceType → /api/.../print|qr|label`). |
| `PENDING → PRINTED`   | `PrintJobsService.updateStatus`     | агент патчит, фиксируется `completedAt`.    |
| `PENDING → FAILED`    | `PrintJobsService.updateStatus`     | агент сохраняет `errorMessage`.             |

Нельзя закрыть закрытый job (`PrintJobAlreadyClosedException`).
Ретраев нет; повторная печать = новый `PrintJob`. Каждый
`PrintJobDto`, который backend отдаёт агенту, дополнительно несёт
`selectedWindowsPrinter` — снимок выбора на момент задания.

`PrintJob` — операционная сущность. Ни `AuditLog`, ни `PassportEvent`
на его переходы **не пишутся** (`docs/events.md §7.4`).

### 14.2 Логика выбора принтера

При `POST /api/print-jobs` без явного `printerId`
(`apps/api/src/modules/printers/print-jobs.service.ts:resolvePrinter`):

1. Берём активную смену сотрудника (`ShiftSession.endedAt = null`).
2. Если смены нет — `409 SHIFT_SESSION_REQUIRED`.
3. Берём `equipmentId` смены; ищем `Printer { equipmentId,
   isActive: true }`. Если несколько — первый по `createdAt`.
4. Если принтера нет — `409 PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`.

`PrintButton` (`apps/web/`) при коде
`PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT` или
`SHIFT_SESSION_REQUIRED` открывает `fallbackHref` в новой вкладке
— это сохраняет печать на тех рабочих местах, где агент ещё не
настроен.

Передавать явный `printerId` могут только `SHOP_MANAGER`/`ADMIN`
(тестовая печать), иначе `403 FORBIDDEN_ROLE`.

### 14.3 Подключение агента

Агент — Node.js-процесс, постоянно живущий рядом с физическим
принтером на Windows-станции. Сборка — `apps/agent/` →
`sewing-print-agent.exe` (Public-эндпоинт
`/api/printers/agent-download/sewing-print-agent.exe`).

Pair flow (`docs/api.md §41`):

1. Менеджер создаёт `Printer` в `/admin/printers` и привязывает
   к `Equipment`.
2. Жмёт «Сгенерировать код» — `POST /api/printers/:id/pairing-code`
   пишет `Printer.pairingCode` (формат `PAIR-XXXX-XXXX`).
3. На Windows-станции запускается `sewing-print-agent.exe --pair
   --server <url> --code <pairingCode>`. Pair-команда обменивает
   `pairingCode` на `agentToken + printerId`, сохраняет в
   `agent-config.json`. После pair `pairingCode` на сервере
   очищается.
4. Агент в основном режиме раз в 2-3 секунды бьёт
   `GET /api/print-jobs/agent` (`X-Printer-Agent-Token`). Каждый
   poll обновляет `Printer.lastSeenAt` и `isOnline=true`
   (`PrintJobsService.pollForAgent` + `printers.heartbeat`).
5. При появлении `PrintJob` агент скачивает `payloadUrl`,
   физически печатает и отправляет
   `PATCH /api/print-jobs/:id { status: 'PRINTED' | 'FAILED',
   errorMessage? }`.

### 14.4 Выбор Windows-принтера

После pair агент периодически (~60 сек) шлёт
`POST /api/printers/agent/windows-printers { hostName, printers:
string[] }`. Backend сохраняет `agentHostName`,
`availableWindowsPrinters`, `windowsPrintersUpdatedAt`, обновляет
`isOnline/lastSeenAt`, возвращает текущий `selectedWindowsPrinter`.

Менеджер выбирает физический принтер через
`PATCH /api/printers/:id { selectedWindowsPrinter }`. Backend
проверяет наличие выбранного имени в
`availableWindowsPrinters`, иначе —
`422 WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`.

Если `selectedWindowsPrinter = null` — агент не печатает и сразу
закрывает job как `FAILED` с понятным `errorMessage`.

### 14.5 RBAC

- `SHOP_MANAGER`/`ADMIN` — управляют принтерами (CRUD), генерируют
  `pairingCode`, видят список и историю заданий, делают тестовую
  печать.
- Любая залогиненная роль — может вызвать `POST /api/print-jobs`
  без `printerId`.
- Агент авторизуется заголовком `X-Printer-Agent-Token`
  (`AgentAuthGuard`). Без токена / с неактивным принтером — 401.

---

<a id="events"></a>
<a id="15-audit-events"></a>

## 15. Audit / Events

Источник: `prisma/schema.prisma::PassportEvent` / `AuditLog`,
`apps/api/src/modules/audit/audit.service.ts`,
`docs/events.md` целиком, `docs/erd.md §2.5` / §2.14.

### 15.1 Две независимые сущности

В системе сосуществуют **две** независимые сущности «события», и
важно их не путать:

#### `PassportEvent` — доменные события движения паспорта

- Schema-level enum `PassportEventType` (нельзя опечататься).
- Только `Passport`-агрегат (`passportId` FK).
- **Читается бизнес-логикой**: guard `QC → IRONING`
  (`PassportsService.scanOnOperation`,
  `WtoService.assertQcPassed`); derived stage на `/shopfloor` и
  `/dashboard`; расчёт длительностей стадий
  (`apps/api/src/modules/costs/passport-durations.service.ts`);
  pending-начисление через `sourceEventId` (`OPERATION_SCAN.id` ⇢
  `OperationEntry.sourceEventId`).
- Пишется только тогда, когда реально меняется физический факт по
  паспорту.

#### `AuditLog` — универсальный журнал управленческих действий

- Свободная строка `event` (новые коды добавляются без миграции).
- Любой агрегат через `entityType: String + entityId: String` (без
  FK).
- `payload: Json` (произвольный срез контекста; часто
  `before/after/changedFields`).
- **Не читается бизнес-логикой** ни в одном месте — только
  запись (`docs/events.md §8.2`).

Допустимые `entityType` (источник истины — тип `AuditEntityType`
в `audit.service.ts:13-170`):

```
PASSPORT | ORDER | QC | WTO | PACKING |
MASTER_CALL | CUT_RELEASE_POLICY |
CLIENT | PATTERN | PATTERN_CATEGORY |
WORKSHOP_NEED | SUPPLIER |
PURCHASE_ORDER | PURCHASE_RECEIPT |
ORDER_APPLICATION | ORDER_COST_ESTIMATE |
ORDER_MATERIAL_ARRIVAL_OVERRIDE |
SIZE |
COMPANY_SETTINGS | COMPANY_DIVISION
```

### 15.2 Атомарность `AuditLog` с операцией

Источник: `AuditService.log(input, tx?)`
(`audit.service.ts:229-260`), `docs/events.md §3.1`, §9.11.

- Если передан `tx` — запись идёт в той же транзакции, что и сама
  бизнес-операция («либо и операция, и аудит, либо ничего»).
- Без `tx` — fail-soft: ошибка глушится в WARN-лог. Это сознательный
  legacy-fallback. Все известные сейчас call-сайты передают `tx`.

### 15.3 Парность доменных событий и аудита

Парные пары (одна транзакция пишет обе записи):

| Действие                   | `PassportEvent`        | `AuditLog`                       |
| -------------------------- | ---------------------- | -------------------------------- |
| поставить паспорт в ячейку | `CELL_PLACED`          | `PASSPORT_PLACED`                |
| выдать швее                | `ISSUED_TO_EMPLOYEE`   | `PASSPORT_ISSUED { mode }`       |
| скан на операции           | `OPERATION_SCAN`       | `PASSPORT_SCANNED`               |
| швея завершила операцию    | `OPERATION_FINISHED`   | `PASSPORT_OPERATION_COMPLETED`   |
| ОТК подтвердил             | `QC_PASSED`            | `QC_COMPLETED`                   |
| ВТО подтвердил             | `WTO_PASSED`           | `WTO_COMPLETED`                  |
| упаковали в коробку        | `PACKED`               | `PASSPORT_PACKED`                |

Асимметрии (зафиксированы в коде):

- **Создание паспорта** пишет только `PassportEvent(CREATED)`, без
  `AuditLog` (`docs/events.md §3.3`).
- **Фиксация брака** пишет только `PassportEvent(DEFECT_RECORDED)`
  + `PassportDefect`, без `AuditLog` (`docs/events.md §9.12`).
- **Закрытие коробки** (`BOX_CLOSED`) и **master-actions**
  (`MASTER_PASSPORT_*`) пишут только `AuditLog`, без
  `PassportEvent`.
- **Вызовы мастера** (`MASTER_CALLED`, `MASTER_CALL_RESOLVED`) пишут
  только `AuditLog` — паспорт тут не меняется.
- **Заказы поставщикам и приёмки** живут полностью в `AuditLog` —
  `PassportEvent` для них не существует.

### 15.4 Реестр audit-event-кодов (PHASE 2 inventory)

Полный, актуальный реестр — `docs/events.md §3.3`. Самые важные
коды по доменам:

#### Паспорта (`entityType = PASSPORT`)

`PASSPORT_PLACED`, `PASSPORT_ISSUED { mode: 'FROM_CELL' |
'ROUTE_WIP' }`, `PASSPORT_SCANNED`,
`PASSPORT_OPERATION_COMPLETED`, `MASTER_PASSPORT_UNASSIGNED`,
`MASTER_PASSPORT_TRANSFERRED`, `MASTER_PASSPORT_RETURNED_TO_CELL`,
`MASTER_PASSPORT_ROUTE_STEP_SET`.

#### Упаковка (`entityType = PACKING`)

`PASSPORT_PACKED` (`entityId = boxId`), `BOX_CLOSED`.

#### ОТК / ВТО

`QC_COMPLETED` (`entityType = QC, entityId = passportId`),
`WTO_COMPLETED` (`entityType = WTO`).

#### Заказы (`entityType = ORDER` / `ORDER_COST_ESTIMATE`)

`ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_PATTERN_CHANGED`,
`ORDER_PATTERN_SNAPSHOT_CREATED`, `ORDER_OPERATION_PLAN_RECALCULATED`,
`ORDER_CALCULATION_STARTED`, `ORDER_CALCULATION_COMPLETED`,
`ORDER_COST_ESTIMATE_CREATED`, `ORDER_CALCULATION_REOPENED`,
`ORDER_STARTED`.

UNKNOWN/TODO: `ORDER_COMPLETED` / `ORDER_CANCELLED` коды
**не пишутся** — `OrdersService.complete` и `cancel` без
audit-event (`docs/events.md §5.4`).

#### Master / Calls (`entityType = MASTER_CALL`)

`MASTER_CALLED`, `MASTER_CALL_RESOLVED`. UNKNOWN/TODO:
`MasterCallStatus.CANCELLED` не выставляется ни одним сервисом
(`docs/events.md §4.2`).

#### Закупки

`PURCHASE_ORDER_CREATED/_UPDATED/_LINE_UPDATED/_SENT/_CONFIRMED/_CANCELLED`,
`PURCHASE_RECEIPT_CREATED/_CANCELLED`. UNKNOWN/TODO: авто-переходы
PO `→ RECEIVED / PARTIALLY_RECEIVED` через
`PurchaseReceiptsService.recalcAfterChange` идут **без** audit-события
(`docs/events.md §6.2`).

#### Cut release / прочее

`CUT_RELEASE_POLICY_CREATED/_UPDATED/_DISABLED/_CONSUMED`,
`ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED/_REVOKED`,
`CLIENT_*`, `PATTERN_*`, `PATTERN_CATEGORY_*`, `WORKSHOP_NEED_*`,
`SUPPLIER_*`, `ORDER_APPLICATION_*`, `SIZE_CREATED`,
`EQUIPMENT_CREATED/_UPDATED/_OPERATIONS_REPLACED`.

### 15.5 Ключевые инварианты (сводная таблица)

Источник: `docs/events.md §9` целиком.

| № | Инвариант                                                       | Где обеспечивается                              | Нарушения / WARNING                                                                                  |
| - | --------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1 | `PassportEvent` в той же tx, что и change of state              | `passports`, `qc`, `wto`, `packing`             | **WARNING.** `MasterActionsService` меняет state без `PassportEvent` (только `AuditLog`, см. §13.4). |
| 2 | `PACKED ⟺ Passport.status = PACKED`                            | `PackingService.addPassport`                    | нет                                                                                                  |
| 3 | `QC_PASSED` не меняет state                                     | `QcService.completeQc`                          | нет                                                                                                  |
| 4 | `WTO_PASSED` не меняет state; sub-инвариант `WTO ⇒ был QC_PASSED` | `WtoService.{completeWto, assertQcPassed}` + `PassportsService.scanOnOperation` IRONING-gate | нет |
| 5 | `OPERATION_SCAN` не финализирует операцию                       | пара `scanOnOperation` vs `completeOperationByEmployee` | нет                                                                                          |
| 6 | `approvePendingForPassport` только после `close()`              | `PackingService.close` → единственный call-site | **WARNING.** Устаревший JSDoc `earnings.service.ts:52`.                                              |
| 7 | `CREATED` — первое событие паспорта                             | `PassportsService.create`                       | нет                                                                                                  |
| 8 | `OPERATION_SCAN` идемпотентен на (passport, op, employee)      | early-return + `OperationEntry @@unique`        | нет                                                                                                  |
| 9 | Создание начислений идемпотентно                                | `EarningsService.safeCreate` + schema `@@unique`| нет                                                                                                  |
| 10| `close()` идемпотентен                                          | `BoxClosedException` + фильтр `approvePending`  | нет                                                                                                  |
| 11| `AuditLog` атомарен с операцией только при передаче `tx`        | `AuditService.log`                              | **WARNING.** Без `tx` fail-soft (WARN-лог).                                                          |
| 12| `DEFECT_RECORDED` пишется без `AuditLog`                        | `QcService.recordDefect`                        | **WARNING — асимметрия.**                                                                            |
| 13| `PassportStatus.CANCELLED` ни одним сервисом не выставляется    | (нет writer-а)                                  | **WARNING — invariant by absence.**                                                                  |

### 15.6 Что MVP сознательно НЕ делает

- `AuditLog` НЕ источник правды для денежных и доменных проекций
  (для этого есть `PassportEvent`, `OperationEntry`, `SalaryEntry`).
- Не плодит события ради событий: новый `event` добавляется только
  если он отвечает на конкретный операционный вопрос.
- Не enforce-ит схему `payload` на уровне БД — эволюция payload-а
  должна быть дешёвой. Согласованность поддерживается code review.
- UI/API над журналом — out-of-scope MVP. Чтение пока — задача
  поддержки/админа через БД.

---

<a id="16-company-settings"></a>
## 16. Настройки компании

Источник: `prisma/schema.prisma::CompanySettings` /
`CompanyDivision`,
`apps/api/src/modules/company-settings/*`,
`apps/web/app/admin/company-settings/page.tsx`,
`docs/api.md §42`, `docs/erd.md §2.15`.

### 16.1 Назначение

Управленческий блок «Настройки компании» закрывает две независимые
сущности:

- **Реквизиты организации** (`CompanySettings`) — singleton-карточка
  с юридическими и банковскими реквизитами (legal/short name, ИНН,
  КПП, ОГРН, юр./факт. адрес, телефон, email, ФИО директора и
  главбуха, банк, БИК, корреспондентский счёт, расчётный счёт). На
  MVP подразумевается одна компания на инсталляцию.
- **Подразделения компании** (`CompanyDivision`) — soft-delete
  справочник структурных подразделений (цех, склад, бухгалтерия).
  Карточка несёт `code` (уникальный slug), `name`, `description?`,
  `isActive`, `sortOrder`.

UI — одна страница `/admin/company-settings` (см. `docs/screens.md
§10g`), pinned-ссылка «Настройки» в футере sidebar рядом с «Выйти».
RBAC — `SHOP_MANAGER` / `ADMIN`.

### 16.2 Singleton-инвариант `CompanySettings`

- `id String @id @default("default")` + `singleton Boolean @unique
  @default(true)` — двойная защита: гарантирует на уровне БД, что в
  таблице не больше одной строки.
- `CompanySettingsService.getOrCreate()` идемпотентно создаёт строку
  при первом GET (`/api/company-settings`); параллельный create
  словит P2002 на `singleton`-unique и сделает повторное чтение.
- PATCH `/api/company-settings` принимает любое подмножество полей
  (`undefined` ⇒ не трогать; `null` / пустая строка ⇒ очистить поле).
  Если ни одно поле реально не поменялось — UPDATE и `AuditLog` не
  пишутся (idempotent PATCH).

### 16.3 Soft-delete `CompanyDivision`

- Hard-delete не делаем: «отключение» — это PATCH
  `{ isActive: false }`. UI рисует кнопку «Отключить» в строке
  таблицы; обратное действие — «Включить».
- `code` глобально уникален; дубликат → `409
  COMPANY_DIVISION_CODE_TAKEN` (`P2002` транслируется в сервисе).
- `sortOrder` управляется руками (default `100`); list-эндпоинт
  сортирует `[isActive desc, sortOrder asc, name asc]` — активные
  всегда сверху, отключённые тонут вниз.

### 16.4 `CompanyDivision` = подразделение заказа

`CompanyDivision` — единственный источник истины «к какому
подразделению относится заказ / экран цеха». На него ссылаются
`Order.companyDivisionId` и `DisplayScreenConfig.companyDivisionId`
(см. §12.3, §12.4). Базовые карточки `MARKETPLACE` / `OTHER`
гарантированно созданы миграцией
`…_link_company_divisions_to_orders` и каждым re-seed
(`prisma/seed.ts`, `tests/utils/seed.ts`).

Менеджер может расширить справочник через UI (`/admin/company-settings`)
и привязать новые подразделения к заказам / display screens. На MVP
earnings-схема закройщика для подразделений с произвольным `code`
использует безопасный default `B2B_SEWING_PERCENT` (см. §10.2):
marketplace остаётся единственным whitelist'ом под фиксированную
схему. Карточки `MARKETPLACE` / `OTHER` нельзя hard-delete'ить
(FK + soft-delete) — `getCutterCompensationSchemeForDivision`
ожидает их `code` для marketplace-flow.

### 16.5 Audit

- `COMPANY_SETTINGS_UPDATED` — `entityType = COMPANY_SETTINGS`,
  `entityId = "default"`, payload `{ changed: { <field>: { before,
  after }, … } }`.
- `COMPANY_DIVISION_CREATED` / `COMPANY_DIVISION_UPDATED` —
  `entityType = COMPANY_DIVISION`, `entityId = CompanyDivision.id`.

См. также `docs/events.md §3.2` / §3.3.

---

## UNKNOWN / TODO (сводный список)

Все факты, которые **нельзя** подтвердить только из кода или которые
зарезервированы в схеме без runtime-write:

1. `PassportStatus.CANCELLED` — ни один сервис в `apps/api/src` не
   выставляет этот статус. Сценария отмены паспорта на MVP нет
   (`docs/events.md §9.13`).
2. `PassportEventType.OPERATION_STARTED` / `MOVED` / `CELL_REMOVED`
   / `CANCELLED` — зарезервированы в enum, но runtime их не пишет
   (`docs/events.md §2.2`, §2.4, §2.7, §2.13).
3. `MasterCallStatus.CANCELLED` — зарезервирован, не выставляется
   (`docs/events.md §4.2`).
4. `OrdersService.complete` (`IN_PRODUCTION → DONE`) и `cancel`
   (`* → CANCELLED`) **не пишут `AuditLog`** —
   осознанное упрощение или пропуск, из кода однозначно не следует
   (`docs/events.md §5.4`).
5. `QcService.recordDefect` пишет `PassportEvent(DEFECT_RECORDED)`
   без парного `AuditLog` — асимметрия с остальными доменными
   событиями (`docs/events.md §9.12`).
6. Авто-переходы `PurchaseOrder.status` (`RECEIVED` /
   `PARTIALLY_RECEIVED` / откат) внутри
   `PurchaseReceiptsService.recalcAfterChange` идут без
   собственного `AuditLog`-события (`docs/events.md §6.2`).
7. `OperationEntry.status ∈ {CANCELLED, REVERSED}` — заложены
   в enum под будущий flow возврата паспорта в производство;
   write-эндпоинтов под них на MVP нет.
8. `SalaryEntry.source = MANUAL` — есть в schema, в
   `SalaryService.syncDailySalary` явного create-пути под него
   нет; пишется только через `PATCH /api/salary/:id` сценарий
   ручной правки (`docs/production-flow.md §12.1`).
9. `RouteTemplateStep.isOptional` — поле есть в схеме, но в
   enforcement-е MVP не используется (см. §2.3).
10. `CuttingClosureRequest`: переход `APPROVED → REJECTED`
    (отмена закрытия) — в коде не реализован.
11. `PurchaseReceiptLine.cellId` фиксирует ячейку приёмки, но
    `CellContent` при этом **не** обновляется — складские
    остатки на ячейках на MVP по-прежнему ведутся только через
    `PassportsService.place` (см. §6.3).
12. Поведение `PassportEvent.employeeId` при удалении сотрудника:
    FK без явной директивы `onDelete` (дефолт Prisma) —
    UNKNOWN/TODO (`docs/events.md §10`).
13. Точная формулировка set warnings
    `OrderOperationPlanWarnings[]` — собирается в
    `OrderOperationPlanService.calculateForOrder`; полный
    human-readable набор сообщений документируется по факту
    отдельным разделом после ревизии (`docs/order-flow.md §«Что
    осталось UNKNOWN/TODO»`).

---

## Использованные исходники

Prisma:
- `prisma/schema.prisma` — модели и enum-ы (источник истины);
- `prisma/migrations/**` — DDL.

Сервисы (`apps/api/src/modules/**`):
- `orders/orders.service.ts`,
  `orders/order-cost-estimates.service.ts`,
  `orders/order-operation-plan.service.ts`,
  `orders/order-production-balance.service.ts`,
  `orders/order-aggregator.ts`;
- `routes/routes.service.ts`;
- `tech-cards/tech-cards.service.ts`;
- `patterns/patterns.service.ts`,
  `pattern-categories/pattern-categories.service.ts`;
- `workshop-needs/workshop-needs.service.ts`;
- `suppliers/suppliers.service.ts`;
- `purchase-orders/purchase-orders.service.ts`;
- `purchase-receipts/purchase-receipts.service.ts`;
- `passports/passports.service.ts`,
  `passports/passport-number.service.ts`,
  `passports/cells.controller.ts`;
- `qc/qc.service.ts`;
- `wto/wto.service.ts`;
- `packing/packing.service.ts`,
  `packing/box-number.service.ts`;
- `earnings/earnings.service.ts`;
- `salary/salary.service.ts`;
- `shifts/shifts.service.ts`;
- `shopfloor/shopfloor.service.ts`,
  `shopfloor/shopfloor-projection.ts`;
- `display-screens/display-screens.service.ts`;
- `dashboard/dashboard.service.ts`;
- `costs/costs.service.ts`,
  `costs/passport-durations.service.ts`,
  `costs/production-cost-v2.service.ts`;
- `master-calls/master-calls.service.ts`;
- `master-actions/master-actions.service.ts`;
- `cut-readiness/cut-readiness.service.ts`;
- `cut-release-policy/cut-release-policy.service.ts`;
- `cutting-closure/cutting-closure.service.ts`;
- `order-applications/order-applications.service.ts`;
- `order-material-arrivals/order-material-arrivals.service.ts`;
- `printers/printers.service.ts`,
  `printers/print-jobs.service.ts`,
  `printers/printers-agent.controller.ts`;
- `audit/audit.service.ts`;
- `employees/employees.service.ts`,
  `employees/compensation.ts`;
- `equipment/equipment.service.ts`;
- `warehouses/warehouses.service.ts`;
- `diagnostics/diagnostics.service.ts`.

Производные доки (карты от того же кода):
- `docs/erd.md` — модели/enum-ы по доменам;
- `docs/order-flow.md` — заказы и snapshot-механика;
- `docs/production-flow.md` — паспорта, ОТК/ВТО, упаковка, payroll;
- `docs/events.md` — `PassportEvent` vs `AuditLog`, инварианты;
- `docs/api.md` — карта routes от контроллеров.

ADR (контекст решений): 0002, 0003, 0005, 0006, 0007, 0008, 0009,
0010, 0011, 0012, 0013, 0014, 0015, 0017, 0018, 0019, 0020, 0021,
0022 — см. `docs/adr/`.
