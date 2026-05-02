# Order flow

> Статус: **OK** (создан в PHASE 2, 2026-Q2).
>
> Источник истины — **код**, не этот документ. При любом расхождении
> верим коду, документ обновляем сразу следом.
>
> Source files:
>
> - `prisma/schema.prisma` — модели `Order`, `OrderItem`,
>   `OrderRouteStep`, `OrderMaterialRequirement`,
>   `OrderOutsourceRequirement`, `OrderApplication`,
>   `OrderCostEstimate`, `OrderCostEstimateLine`,
>   `OrderMaterialArrivalOverride`, `WorkshopNeed`,
>   `CutReleasePolicy`; enum `OrderStatus`,
>   `OrderOutsourceExecutionStatus`, `OutsourceTriggerType`,
>   `CuttingClosureRequestStatus`.
> - `apps/api/src/modules/orders/**`
>   (`orders.service.ts`, `orders.controller.ts`,
>   `order-cost-estimates.service.ts`,
>   `order-operation-plan.service.ts`,
>   `order-production-balance.service.ts`,
>   `order-aggregator.ts`).
> - `apps/api/src/modules/workshop-needs/**`
>   (`workshop-needs.service.ts`,
>   `workshop-needs.controller.ts`,
>   `workshop-needs.order-controller.ts`).
> - `apps/api/src/modules/order-material-arrivals/**`
>   (`order-material-arrivals.service.ts`,
>   `order-material-arrivals.controller.ts`).
> - `apps/api/src/modules/cut-readiness/**`
>   (`cut-readiness.service.ts`,
>   `cut-readiness.controller.ts`).
> - `apps/api/src/modules/cut-release-policy/**`
>   (`cut-release-policy.service.ts`,
>   `cut-release-policy.controller.ts`).
> - `docs/api.md` — карта routes.
> - `docs/erd.md` — карта моделей и enum-ов.
> - ADR-0006 (план иммутабелен), ADR-0009 (один заказ — один продукт
>   и цвет), ADR-0018 (закрытие раскроя по размеру), ADR-0022
>   (техкарты и snapshot).

---

## Содержание

- [1. Объекты заказа](#1-objects)
- [2. OrderStatus](#2-status)
- [3. Переходы статусов](#3-transitions)
- [4. Snapshot-механика](#4-snapshots)
  - [4.1 `syncOrderRouteStepsSnapshot()`](#41-route-steps)
  - [4.2 `rebuildMaterialRequirementsSnapshot()`](#42-material-requirements)
  - [4.3 Snapshot техкарты в `start()`](#43-tech-card-snapshot)
  - [4.4 Snapshot лекала](#44-pattern-snapshot)
- [5. План операций (`OrderOperationPlan`)](#5-operation-plan)
- [6. `OrderCostEstimate` (себестоимость)](#6-cost-estimate)
- [7. `WorkshopNeed` (потребность цеха)](#7-workshop-need)
- [8. Production balance](#8-production-balance)
- [9. Cut-readiness и material arrivals](#9-cut-readiness)
- [10. Cut release policy и closure requests](#10-cut-release-policy)
- [11. Outsource requirements (`MANUAL` / `CUT_READY`)](#11-outsource)
- [12. Что snapshot-ится и когда (сводная таблица)](#12-snapshot-summary)

---

<a id="1-objects"></a>
## 1. Объекты заказа

Корневой агрегат — `Order` (`prisma/schema.prisma::model Order`,
строки ~789–1048). Один заказ = ровно одно изделие × один цвет
(ADR-0009; в коде `Order.color` живёт на самом заказе, а
`OrderItem.productId` указывает на «технический» Product, который
автоматически создаётся под лекало через
`OrdersService.ensureLegacyProductForPattern()`).

Связанные строки и snapshot-ы (по `model Order { ... }`):

- `items` → `OrderItem[]` — размерная матрица
  (`OrderItem.qtyPlan` — план в штуках по `sizeId`).
- `routeSteps` → `OrderRouteStep[]` — snapshot маршрута
  (`prisma/schema.prisma::model OrderRouteStep`).
- `materialRequirements` → `OrderMaterialRequirement[]` — snapshot
  материалов из техкарты (`prisma/schema.prisma::model
  OrderMaterialRequirement`).
- `outsourceRequirements` → `OrderOutsourceRequirement[]` — snapshot
  внешних работ (`prisma/schema.prisma::model
  OrderOutsourceRequirement`).
- `applications` → `OrderApplication[]` — заказные нанесения
  (`prisma/schema.prisma::model OrderApplication`, строки ~3467–3521).
- `workshopNeeds` → `WorkshopNeed[]` — рассчитанная потребность
  цеха (`prisma/schema.prisma::model WorkshopNeed`).
- `costEstimates` → `OrderCostEstimate[]` — история расчётов
  себестоимости (`prisma/schema.prisma::model OrderCostEstimate`).
- `materialArrivalOverrides` → `OrderMaterialArrivalOverride[]` —
  ручные отметки «материал поступил».
- `passports` → `Passport[]` — производственные паспорта
  (см. `production-flow.md`).

Денормализованные snapshot-поля прямо на `Order`:

- `patternNameSnapshot`, `patternArticleSnapshot`,
  `patternPreviewSnapshotUrl` — slice карточки `PatternItem` на
  момент `startCalculation` или (legacy) `start`.
- `costEstimateTotalRub`, `costEstimateCompletedAt`,
  `costEstimateVersion` — slice последнего `COMPLETED`-расчёта
  для UI без `JOIN` на `OrderCostEstimate`.
- `operationCostPlanRub`, `operationTimePlanSec`,
  `operationPlanCalculatedAt`, `operationPlanWarnings` — snapshot
  плана операций (см. §5).
- `customerUnitPrice`, `customerCurrency` — цена продажи за
  единицу (управленческое поле, на расчёт себестоимости не
  влияет).

`Order.companyDivisionId? → CompanyDivision` (см.
`docs/domain.md §«Подразделения заказа»`) — FK на master-справочник
подразделений. UI-форма заказа выбирает подразделение из активных
карточек `CompanyDivision`. `OrdersService.create`/`update`
пишут FK напрямую: backend проверяет существование карточки (400
`COMPANY_DIVISION_NOT_FOUND` иначе), `null` снимает привязку.
Меняется только в `DRAFT`, после `IN_PRODUCTION` блокируется
общим guard-ом `ORDER_LOCKED`.

`EarningsService` для выбора схемы начисления закройщика читает
`passport.order.companyDivision?.code` (см.
`getCutterCompensationSchemeForDivision`); shopfloor-фильтр
большого монитора — `?divisionCode=<CompanyDivision.code>` (см.
`display-board.md`).

---

<a id="2-status"></a>
## 2. OrderStatus

Источник: `prisma/schema.prisma::enum OrderStatus` (строки ~117–142).

| Значение | Семантика | Кто меняет |
| --- | --- | --- |
| `DRAFT` | План ещё редактируется (изделие/маршрут/техкарта/лекало/размерная матрица). | Создание заказа `OrdersService.create`. |
| `CALCULATION` | Менеджер перевёл заказ в расчёт. Backend автоматически собрал `WorkshopNeed[]`; закупщик правит `purchaseQty` / поставщиков, план уже «заморожен» в snapshot-ах. | `OrdersService.startCalculation`. |
| `CALCULATION_DONE` | Расчёт завершён, зафиксирован активный `OrderCostEstimate(status=COMPLETED)` и snapshot полей `Order.costEstimate*`. | `OrderCostEstimatesService.completeCalculation`. |
| `IN_PRODUCTION` | Запущен в производство. План полностью иммутабелен (ADR-0006). | `OrdersService.start`. |
| `DONE` | Завершён ручным переводом. | `OrdersService.complete`. |
| `CANCELLED` | Отменён. | `OrdersService.cancel`. |

Postgres-enum расширяется только через `ALTER TYPE … ADD VALUE`,
поэтому `CALCULATION_DONE` лежит после `IN_PRODUCTION`/`DONE`/
`CANCELLED` по порядковому номеру в БД — UI порядок задаётся явно
через `ORDER_STATUSES` в `@sewing/shared/orders`.

---

<a id="3-transitions"></a>
## 3. Переходы статусов

```text
                ┌────────────────────────────────────────┐
                │                                        │
                │                                        ▼
   DRAFT ──┬── startCalculation ──▶ CALCULATION ──── CANCELLED
           │                          │  ▲
           │                          │  │
           │             completeCalc │  │ reopenCalculation
           │                          ▼  │
           │                       CALCULATION_DONE
           │                          │
           │     start ───────────────┤
           ▼                          │
       (старый flow start            ▼
        напрямую из DRAFT)      IN_PRODUCTION ─── complete ─▶ DONE
                                     │
                                     └─── cancel ───────────▶ CANCELLED
```

### 3.1 `startCalculation(id, actorEmployeeId)`

Источник: `OrdersService.startCalculation`
(`apps/api/src/modules/orders/orders.service.ts` ~1811).
Контроллер: `POST /api/orders/:id/start-calculation` (RBAC
`SHOP_MANAGER` + `ADMIN`).

Предусловия (бросаются до любого `tx`):

- `Order.status === DRAFT` — иначе
  `OrderInvalidStatusTransitionException` (409
  `ORDER_INVALID_STATUS_TRANSITION`).
- `Order.patternItemId !== null` —
  `OrderPatternRequiredException` (400 `ORDER_PATTERN_REQUIRED`).
- `Order.techCardId !== null` —
  `OrderTechCardRequiredException` (400 `ORDER_TECH_CARD_REQUIRED`).
- `Σ OrderItem.qtyPlan > 0` —
  `OrderItemsRequiredException` (400 `ORDER_ITEMS_REQUIRED`).
- `Order.routeTemplateId` сознательно НЕ требуется — он не
  влияет на расчёт `WorkshopNeed`.

Шаги:

1. `rebuildMaterialRequirementsSnapshot(id, tx)` — гарантированно
   пересобираем `OrderMaterialRequirement[]` из live-строк
   техкарты (preserve `selectedColorText` для
   `colorRule = ORDER_SELECTED_COLOR`).
2. `WorkshopNeedsService.calculateForOrder(id, { force: false })`
   создаёт строки `WorkshopNeed`. Если уже есть строки в статусах
   `REVIEWED` / `PURCHASE_PLANNED`, бросается
   `WORKSHOP_NEEDS_ALREADY_REVIEWED` — менеджер должен
   очистить руками или дать `force=true` через ручной
   `POST /api/orders/:id/workshop-needs/calculate`.
3. Снаружи tx подгружаем `PatternItem` (`select: id/name/article/
   previewImageUrl`).
4. Внутри второй `$transaction`:
   - `OrderOperationPlanService.recalculateAndWrite(id, tx)` —
     финальный snapshot плана операций (см. §5);
   - `syncOrderRouteStepsSnapshot(id, tx)` — финальная
     синхронизация snapshot шагов маршрута (см. §4.1);
   - `Order.update { status: CALCULATION,
     patternNameSnapshot/patternArticleSnapshot/
     patternPreviewSnapshotUrl }` — snapshot карточки лекала
     пишется только если он ещё пуст;
   - `audit.log({ event: 'ORDER_CALCULATION_STARTED', payload: {
     orderId, previousStatus: DRAFT, nextStatus: CALCULATION,
     workshopNeedsCount, methods, warningsCount, patternItemId,
     patternSnapshotCaptured } })`;
   - при первом фиксировании snapshot-а лекала — отдельная
     запись `audit.log({ event: 'ORDER_PATTERN_SNAPSHOT_CREATED',
     payload: { …, capturedAt: 'CALCULATION' } })`.

Порядок «сначала calculate, потом status update» сознателен:
если шаг 2 упал — заказ остаётся `DRAFT`, нет полупустого
«расчётного» состояния.

### 3.2 `completeCalculation(orderId, dto, actorEmployeeId)`

Источник: `OrderCostEstimatesService.completeCalculation`
(`apps/api/src/modules/orders/order-cost-estimates.service.ts` ~61).
Контроллер: `POST /api/orders/:id/complete-calculation`
(RBAC `SHOP_MANAGER` + `ADMIN`).

Предусловия:

- `Order.status === CALCULATION` — иначе
  `OrderCalculationInvalidStatusException` (409
  `ORDER_CALCULATION_INVALID_STATUS`).
- Все живые `WorkshopNeed` (NOT `CANCELLED`) валидны:
  `purchaseQty ?? calculatedQty > 0`, `quotedPrice > 0`,
  `quotedCurrency ∈ {RUB, USD}`. Иначе —
  `OrderCalculationIncompleteException` (409
  `ORDER_CALCULATION_INCOMPLETE`) со списком ошибок
  `[{ needId, description, reason }]`.
- Если есть USD-строки, обязателен `dto.usdRateRub > 0` —
  `OrderCalculationUsdRateRequiredException` (400
  `ORDER_CALCULATION_USD_RATE_REQUIRED`).

Внутри `$transaction`:

- `OrderCostEstimate.create({ version: max+1, status: COMPLETED,
  totalCostRub, usdRateRub, completedById, lines: { create: [...] } })`
  — копирует все нужные поля из `WorkshopNeed` в
  `OrderCostEstimateLine` (kind, description, unit,
  calculatedQty, purchaseQty, quotedPrice, quotedCurrency,
  usdRateRub, lineTotalOriginal, lineTotalRub,
  supplierNameSnapshot, purchaseItemNameSnapshot).
- `Order.update { status: CALCULATION_DONE,
  costEstimateTotalRub, costEstimateCompletedAt,
  costEstimateVersion }`.
- `audit.log({ event: 'ORDER_COST_ESTIMATE_CREATED' })` +
  `audit.log({ event: 'ORDER_CALCULATION_COMPLETED' })`.

`WorkshopNeed`, `PurchaseOrder`, `PurchaseReceipt` сервис здесь
**не трогает** — это исторический срез.

### 3.3 `reopenCalculation(orderId, dto, actorEmployeeId)`

Источник: `OrderCostEstimatesService.reopenCalculation`
(`apps/api/src/modules/orders/order-cost-estimates.service.ts` ~323).
Контроллер: `POST /api/orders/:id/reopen-calculation`
(RBAC `SHOP_MANAGER` + `ADMIN`).

Предусловия:

- `Order.status === CALCULATION_DONE` — иначе
  `OrderCalculationInvalidStatusException`.

Внутри `$transaction`:

- Активный `OrderCostEstimate(status=COMPLETED)` помечается
  `status = REVOKED`, `revokedAt`, `revokedById`,
  `comment = dto.reason ?? old comment`.
- `Order.update { status: CALCULATION,
  costEstimateTotalRub: null, costEstimateCompletedAt: null,
  costEstimateVersion: null }`.
- `audit.log({ event: 'ORDER_CALCULATION_REOPENED', payload: {
  orderId, previousStatus: CALCULATION_DONE, nextStatus: CALCULATION,
  revokedEstimateId, revokedVersion, reason } })`.
- `WorkshopNeed`, `PurchaseOrder`, `PurchaseReceipt` **не
  трогаются** — закупщик правит существующие строки заново.

MVP-ограничение: reopen из `IN_PRODUCTION` сознательно запрещён
(production data уже зависит от текущей себестоимости).

### 3.4 `start(id, actorEmployeeId)`

Источник: `OrdersService.start`
(`apps/api/src/modules/orders/orders.service.ts` ~1472).
Контроллер: `POST /api/orders/:id/start` (RBAC
`SHOP_MANAGER` + `ADMIN`).

Предусловия:

- `Order.status ∈ { DRAFT, CALCULATION, CALCULATION_DONE }` —
  иначе `OrderInvalidTransitionException`. Старый flow `DRAFT →
  IN_PRODUCTION` оставлен как backward-compat; рекомендуемый —
  через `CALCULATION_DONE`.
- `Order.items.length > 0` — иначе
  `BadRequestException(ORDER_HAS_NO_ITEMS)`.

Шаги (вне tx):

- Если `Order.routeTemplateId` есть → грузим активные шаги
  (`RoutesService.getActiveStepsForSnapshot`).
- Если `Order.techCardId` есть → грузим строки для snapshot-а
  (`TechCardsService.getLinesForSnapshot`) и считаем
  `baseQty = Σ OrderItem.qtyPlan`.
- Загружаем `PatternItem` для snapshot-а (если есть и snapshot
  ещё не зафиксирован).

Внутри `$transaction`:

- `Order.update { status: IN_PRODUCTION,
  patternNameSnapshot/patternArticleSnapshot/
  patternPreviewSnapshotUrl }` — snapshot пишется только если
  `!order.patternNameSnapshot` (`captureSnapshot`).
- Defensive fallback `OrderRouteStep[]`-snapshot: только если
  `OrderRouteStep.count === 0` для этого заказа (для
  legacy-заказов, у которых snapshot ещё не материализован
  через `syncOrderRouteStepsSnapshot()`). Иначе snapshot
  считается immutable и не перезаписывается.
- Defensive fallback `OrderMaterialRequirement[]`-snapshot:
  только если `count === 0`. Поля копируются из техкарты;
  `totalQty = qtyPerUnit × baseQty`; `resolvedColorText`
  считается через `resolveColorText(colorRule, fixedColorText,
  Order.color)`; `requiresColorSelection = (colorRule ===
  'ORDER_SELECTED_COLOR')`.
- Defensive fallback `OrderOutsourceRequirement[]`-snapshot:
  только если `count === 0`. `executionStatus = PLANNED`,
  `triggerType` копируется со строки техкарты.
- `audit.log({ event: 'ORDER_STARTED', payload: { fromStatus,
  toStatus: IN_PRODUCTION, routeTemplateId, routeStepCount,
  techCardId, techCardMaterialLineCount,
  techCardOutsourceLineCount, baseQty, patternItemId,
  patternSnapshotCaptured, patternSnapshotPreserved } })`.
- При фактической фиксации pattern-snapshot-а — отдельная
  `audit.log({ event: 'ORDER_PATTERN_SNAPSHOT_CREATED',
  payload: { …, capturedAt: 'IN_PRODUCTION' } })`.

### 3.5 `complete(id)`

Источник: `OrdersService.complete`
(`apps/api/src/modules/orders/orders.service.ts` ~1984).
Контроллер: `POST /api/orders/:id/complete`.

- `Order.status` обязан быть `IN_PRODUCTION` — иначе
  `OrderInvalidTransitionException`.
- `Order.update { status: DONE }`. Аудит-event здесь **не
  пишется**.

### 3.6 `cancel(id)`

Источник: `OrdersService.cancel`
(`apps/api/src/modules/orders/orders.service.ts` ~2001).
Контроллер: `POST /api/orders/:id/cancel`.

- Запрещено только из терминальных `DONE` / `CANCELLED` —
  иначе `OrderInvalidTransitionException`. Разрешён из `DRAFT`,
  `CALCULATION`, `CALCULATION_DONE`, `IN_PRODUCTION`.
- `Order.update { status: CANCELLED }`. Snapshot-поля
  `costEstimate*` НЕ обнуляются — это «исторический срез»,
  который нужен для отчётности и аудита. Аудит-event здесь
  **не пишется**.

### 3.7 PATCH `/api/orders/:id` и status-делегирование

`OrdersService.update` валидирует «опасные» поля
(`items`, `productId`, `routeTemplateId`, `techCardId`,
`patternItemId`, `companyDivisionId`) и допускает их к изменению
**только в `DRAFT`**. На любом другом статусе бросается
`OrderLockedException` (409 `ORDER_LOCKED`).

Если в DTO передан `status`, и он отличается от текущего,
делегируется в существующие методы:

- `DRAFT → CALCULATION` → `startCalculation`;
- `{DRAFT, CALCULATION, CALCULATION_DONE} → IN_PRODUCTION`
  → `start`;
- `IN_PRODUCTION → DONE` → `complete`;
- `{DRAFT, CALCULATION, CALCULATION_DONE, IN_PRODUCTION} →
  CANCELLED` → `cancel`;
- любой другой переход → `OrderInvalidTransitionException`
  (409 `ORDER_INVALID_TRANSITION`).

---

<a id="4-snapshots"></a>
## 4. Snapshot-механика

Идея: после `start()` план иммутабелен (ADR-0006). Чтобы UI и
расчёты (`WorkshopNeed`, `OrderOperationPlan`) видели актуальные
данные ещё **до** запуска, используются «синхронизаторы», которые
держат snapshot в согласованном виде на каждом важном переходе.

<a id="41-route-steps"></a>
### 4.1 `syncOrderRouteStepsSnapshot(orderId, tx)`

Источник: `OrdersService.syncOrderRouteStepsSnapshot`
(`apps/api/src/modules/orders/orders.service.ts` ~785–838).

Контракт:

- Читает `Order.routeTemplateId` и текущий `OrderRouteStep[]`
  внутри переданной транзакции.
- Если шаблон не выбран → удаляет все snapshot-строки
  (заказ остался без маршрута).
- Если шаблон есть → сравнивает с текущим snapshot-ом и, если
  состав либо порядок отличаются, атомарно
  `deleteMany + createMany` (это единственный безопасный
  путь при `@@unique([orderId, index])`).
- Идемпотентен: повторный вызов без изменений шаблона ничего
  не пишет.

Где вызывается:

- `OrdersService.create` (после `OrderOperationPlanService.
  recalculateAndWrite`).
- `OrdersService.update` — только в DRAFT и только при
  изменении `items` / `routeTemplateId` / `patternItemId`.
- `OrdersService.recalculateOperationPlan` (`POST
  /api/orders/:id/operation-plan/recalculate`) — финальная
  актуализация, чтобы вкладка «Операции» в UI карточки заказа
  не отставала.
- `OrdersService.startCalculation` — финальная sync перед
  переводом в `CALCULATION`.

После `start()` НЕ вызывается. `start()` сам содержит
defensive `existing.count() === 0` snapshot-вставку для
legacy-заказов, у которых snapshot не был материализован
ранее (см. JSDoc).

Сами шаги маршрута берутся из
`RoutesService.getActiveStepsForSnapshot(routeTemplateId)`:
этот helper отдаёт `RouteTemplate.steps[]` отсортированными по
`index`.

<a id="42-material-requirements"></a>
### 4.2 `rebuildMaterialRequirementsSnapshot(orderId, tx)`

Источник: `OrdersService.rebuildMaterialRequirementsSnapshot`
(`apps/api/src/modules/orders/orders.service.ts` ~2519–2636).

Контракт:

- Загружает текущие `OrderMaterialRequirement[]` (чтобы
  preserve введённый менеджером `selectedColorText` для строк
  с `colorRule = ORDER_SELECTED_COLOR`).
- Если `Order.techCardId` сброшен → стирает snapshot
  полностью (snapshot всегда консистентен с текущей привязкой
  техкарты).
- Иначе грузит строки шаблона через
  `TechCardsService.getLinesForSnapshot(techCardId)`, считает
  `baseQty = Σ OrderItem.qtyPlan` и резолвит цвет:
  - `ORDER_COLOR` → `Order.color`;
  - `FIXED_COLOR` → `fixedColorText`;
  - `NO_COLOR` / null → `null`;
  - `ORDER_SELECTED_COLOR` → preserve старый
    `selectedColorText`, `requiresColorSelection = true`.
- Match для preserve `selectedColorText`:
  1. по `sourceTechCardLineId` (если строка шаблона жива);
  2. fallback по композитному ключу `materialRole | fabricType
     | hardwareSizeText | hardwareMaterialText` (если строка
     шаблона удалена и создана заново с теми же атрибутами).
- Атомарно `deleteMany + createMany` (внутри tx).

Где вызывается:

- `OrdersService.create` — если у заказа сразу выбрана
  техкарта.
- `OrdersService.update` — в `DRAFT` при смене `items` /
  `techCardId`; в `DRAFT|CALCULATION|CALCULATION_DONE` при
  смене `Order.color` (для `ORDER_COLOR`-строк
  `resolvedColorText` следует за новым цветом заказа).
- `OrdersService.startCalculation` — гарантированный
  rebuild перед `WorkshopNeedsService.calculateForOrder`,
  чтобы расчёт использовал актуальный snapshot.

В `start()` не вызывается. `start()` имеет defensive
`existingMat.count() === 0` snapshot-вставку для legacy-заказов
(см. §3.4).

Этот helper сознательно не трогает `WorkshopNeed`,
`OperationEntry`, `Passport` — snapshot изолирован от расчётов
и payroll.

<a id="43-tech-card-snapshot"></a>
### 4.3 Snapshot техкарты в `start()`

В `start()` (см. §3.4) копируются:

- `OrderMaterialRequirement[]` со snapshot-ом полей
  `materialRole`, `fabricType`, `densityGsm`, `plannedWidthCm`,
  `colorRule`, `fixedColorText`, `resolvedColorText`,
  `requiresColorSelection`, `selectedColorText`,
  `hardwareSizeText`, `hardwareMaterialText`,
  `materialImageUrl`, `materialImageOriginalFileName` —
  defensive (только если `count === 0`).
- `OrderOutsourceRequirement[]` со snapshot-ом полей
  `name`, `unit`, `qtyPerUnit`, `totalQty`, `vendorName`,
  `triggerType`, `executionStatus = PLANNED`, `orderedAt =
  null`, `receivedAt = null` — также defensive.

Защита от двойного snapshot гарантируется:

- guard-ом `existingMat / existingOuts === 0`;
- общим `ORDER_LOCKED` в `update` (опасные поля менять нельзя
  после DRAFT) и
  `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED` в
  `recalculateOperationPlan`.

<a id="44-pattern-snapshot"></a>
### 4.4 Snapshot лекала

Поля `Order.patternNameSnapshot`, `patternArticleSnapshot`,
`patternPreviewSnapshotUrl` (см. `prisma/schema.prisma::model
Order` ~860–872):

- Заполняются один раз — на первом из `startCalculation` /
  `start`, у которого `!Order.patternNameSnapshot` (т.е.
  snapshot ещё пуст).
- Источник — текущая карточка `PatternItem` (`select: id,
  name, article, previewImageUrl`).
- На последующих `start()` НЕ перезаписываются — это «слепок»
  лекала на момент расчёта/запуска. Если `PatternItem` позже
  переименовали / удалили, заказ продолжает показывать
  snapshot.
- `PatternItem.onDelete: SetNull` — удаление карточки лекала
  обнуляет live-связь (`patternItemId = null`), snapshot
  сохраняется.

---

<a id="5-operation-plan"></a>
## 5. План операций (`OrderOperationPlan`)

Источник: `OrderOperationPlanService`
(`apps/api/src/modules/orders/order-operation-plan.service.ts`).

Snapshot-поля на `Order`:

- `operationCostPlanRub` — Decimal(14,2), плановая стоимость
  операций в рублях.
- `operationTimePlanSec` — Int, плановое время выполнения
  заказа в секундах.
- `operationPlanCalculatedAt` — DateTime, момент последнего
  пересчёта (заполняется даже если результат `null`).
- `operationPlanWarnings` — JSON-массив человекочитаемых
  warnings («Нет ставки операции "Распошив" для размера XL»,
  «Маршрут не выбран — план операций не рассчитан», …).

Алгоритм `calculateForOrder(orderId, tx)`:

- Читает `Order.routeTemplate.steps[]` (с
  `operation.pricingMode / fixedRate / timeNormMode /
  timeNormSec / salaryPlanRubPerShift / salaryPlanShiftSeconds
  / ratesBySize`) и `OrderItem[]`.
- Для каждой обязательной операции (`step.isOptional !== true`)
  и каждого `OrderItem` считает время и стоимость:
  - `pricingMode = FIXED` → cost = `fixedRate × qty`;
  - `pricingMode = BY_SIZE` → cost = `OperationRateBySize.rate
    × qty` (warning, если для размера ставки нет);
  - `pricingMode = SALARY_ONLY` + есть плановая окладная
    ставка → cost = `timeSec × (salaryPlanRubPerShift /
    salaryPlanShiftSeconds) × qty`;
  - `pricingMode = SALARY_ONLY` без ставки → деньги по
    операции = 0, время считается, в `warnings`
    добавляется «Не задана плановая окладная ставка
    операции "…"».
- Никогда не бросает на «нет данных» — отдаёт `null`-totals и
  warnings; CRUD заказа не блокируется.
- НЕ пишет `OperationEntry` / `SalaryEntry` (это payroll,
  факт), НЕ использует `OperationsService.resolveRate`
  (там exception-семантика для payroll; здесь нужно «нет ставки
  → warning»), НЕ трогает `OrderRouteStep` snapshot, НЕ трогает
  `OrderCostEstimate`.

Где вызывается `OrderOperationPlanService.recalculateAndWrite`:

- `OrdersService.create`;
- `OrdersService.update` — только в `DRAFT` и только при
  изменении `items` / `routeTemplateId` / `patternItemId`;
- `OrdersService.recalculateOperationPlan` (см. ниже);
- `OrdersService.startCalculation` — финальный snapshot
  перед `CALCULATION`.

### Ручной пересчёт

`POST /api/orders/:id/operation-plan/recalculate` →
`OrdersService.recalculateOperationPlan` (RBAC
`SHOP_MANAGER` + `ADMIN`):

- Запрещён в `CALCULATION_DONE` / `IN_PRODUCTION` / `DONE` /
  `CANCELLED` — `OrderOperationPlanRecalculateNotAllowedException`
  (409 `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`). Для
  `CALCULATION_DONE` сообщение явно предлагает
  `reopenCalculation`.
- В одной tx: `recalculateAndWrite` + `syncOrderRouteStepsSnapshot`
  + `audit.log({ event: 'ORDER_OPERATION_PLAN_RECALCULATED',
  payload: { previousCost, previousTimeSec, nextCost,
  nextTimeSec, warningsCount } })`.

---

<a id="6-cost-estimate"></a>
## 6. `OrderCostEstimate` (себестоимость)

Источник: `prisma/schema.prisma::model OrderCostEstimate` (~3551)
и `OrderCostEstimateLine` (~3605); сервис
`OrderCostEstimatesService`
(`apps/api/src/modules/orders/order-cost-estimates.service.ts`).

Идея:

- Один заказ может иметь много `OrderCostEstimate` (история
  «расчёт → reopen → новый расчёт»).
- Активный — `status = COMPLETED`; повторное завершение помечает
  старый как `REVOKED` и создаёт новый с `version = max + 1`
  (`@@unique([orderId, version])`).
- Все цены копируются «как есть» в `OrderCostEstimateLine`
  вместе с курсом USD (`usdRateRub` дублируется в строку для
  самодостаточности) и snapshot-именами поставщика и
  номенклатуры — расчёт не должен «плыть» вслед за поздним
  переименованием.
- `Order.costEstimateTotalRub / costEstimateCompletedAt /
  costEstimateVersion` — денормализованный slice последнего
  COMPLETED-расчёта для UI без `JOIN`. На `reopen` обнуляется,
  на `cancel` сохраняется.

Lifecycle:

- `completeCalculation` (см. §3.2) — создаёт COMPLETED-расчёт.
- `reopenCalculation` (см. §3.3) — переводит активный в
  REVOKED.
- `getActiveEstimateForOrder(orderId)` — возвращает COMPLETED
  для UI карточки заказа (`OrdersService.toDetailDto`
  заполняет `OrderDetailDto.currentCostEstimate`).

Удаление заказа cascade-удаляет историю расчётов
(`onDelete: Cascade`); `OrderCostEstimateLine.workshopNeedId`
имеет `onDelete: SetNull` — удаление потребности не сносит
строку расчёта.

---

<a id="7-workshop-need"></a>
## 7. `WorkshopNeed` (потребность цеха)

Источник: `prisma/schema.prisma::model WorkshopNeed` (~2735) и
сервис `WorkshopNeedsService`
(`apps/api/src/modules/workshop-needs/workshop-needs.service.ts`).

Назначение — рабочее место закупщика: чистая потребность заказа
в материалах, рассчитанная системой по «лекало × техкарта ×
размерная матрица».

Источник входных данных (`WorkshopNeed.sourceType`):

- `TECH_CARD_MATERIAL_LINE` — заказ в `DRAFT`, считаем по live
  техкарте.
- `ORDER_MATERIAL_REQUIREMENT` — заказ запущен (или у
  DRAFT-заказа уже есть snapshot), считаем по snapshot
  `OrderMaterialRequirement[]`.

Формулы расчёта (`WorkshopNeed.calculationMethod`):

- `AREA_DENSITY`: `totalAreaM2 = Σ (PatternMaterialArea.areaM2 ×
  OrderItem.qtyPlan)`; `calculatedQty = totalAreaM2 ×
  densityGsm / 1000` (кг).
- `QTY_PER_UNIT`: `calculatedQty = qtyPerUnit × Σ OrderItem.qtyPlan`
  (live) или `requirement.totalQty` (snapshot).

Свойства:

- Закупщик правит `purchaseQty` / `status` / `quotedPrice` /
  `quotedCurrency` / `expectedDeliveryDate` /
  `selectedSupplierId` / `selectedSupplierCatalogItemId` /
  `comment` руками (`PATCH /api/workshop-needs/:id`).
- `WorkshopNeed.status` хранится строкой (без Prisma enum):
  `CALCULATED` (default) → `REVIEWED` → `PURCHASE_PLANNED` →
  `RECEIVED` (через приёмки) либо `CANCELLED`. Расширение
  списка не требует миграции (см. `@sewing/shared/workshop-needs`).
- Идемпотентный пересчёт: при `force: false` сносятся только
  `CALCULATED`-строки, `REVIEWED` / `PURCHASE_PLANNED`
  сохраняются. Если они есть и не `force` —
  `WORKSHOP_NEEDS_ALREADY_REVIEWED` (409).
- Удаление заказа cascade-удаляет потребность; снос потребности
  cascade-сохраняет `PurchaseOrderLine` и `PurchaseReceiptLine`
  через `onDelete: SetNull`.

Триггеры расчёта:

- `OrdersService.startCalculation` → `calculateForOrder(id,
  { force: false })`.
- `POST /api/orders/:id/workshop-needs/calculate` →
  `WorkshopNeedsService.calculateForOrder(id, dto)` —
  ручной пересчёт (с поддержкой `force=true`).

Этот модуль НЕ создаёт заказы поставщикам, НЕ ведёт справочник
поставщиков и НЕ считает потери (граница MVP).

---

<a id="8-production-balance"></a>
## 8. Production balance

Источник: `OrderProductionBalanceService`
(`apps/api/src/modules/orders/order-production-balance.service.ts`).

Эндпоинт: `GET /api/orders/:id/production-balance` (RBAC
`SHOP_MANAGER` + `ADMIN`). Computed-эндпоинт — **ничего не пишет
в БД**; отдаёт DTO с построчной рекомендацией штата по
операциям и сводкой.

Стратегии (query `strategy`):

- `LINE_BALANCE` (default) — балансировка цепочки по текущему
  активному штату (`Employee.role × Employee.active`,
  mapping `OperationCategory → Role`):
  `CUTTING → CUTTER`, `SEWING → SEAMSTRESS`, `QC → QC`,
  `IRONING → IRONING`, `PACKING → PACKING`. Алгоритм считает
  `workSec = Σ qtyPlan × timeSec(op,size)`, распределяет
  доступных людей внутри категории, считает
  `capacityPerShift`, узкое место и симулирует «+1 сотрудника»
  для рекомендации.
- `TARGET_SHIFT` — `suggestedWorkers = ceil(workSec /
  shiftSeconds)`; отдаёт `requiredWorkersTotal`,
  `availableWorkersTotal`, `missingWorkersForTargetShift`.
- `TOTAL_WORKERS` — фиксированный общий штат, активирован
  query `totalWorkers` (имеет приоритет над `strategy`).
- `TARGET_DURATION` — целевая длительность производства,
  активирован query `targetDurationSec`.

Длительность смены `shiftSeconds` — query `shiftSeconds` (default
`OrderProductionBalanceService.DEFAULT_SHIFT_SECONDS = 28800`,
8 часов).

Что НЕ делает:

- Не пишет в БД (computed endpoint, без снапшотов).
- Не назначает конкретных сотрудников по именам.
- Не трогает payroll (`OperationEntry` / `SalaryEntry` /
  `PieceRate`), `Passport`, `OrderCostEstimate`, `WorkshopNeed`,
  `PurchaseOrder` / `PurchaseReceipt`.
- НЕ добавляет LABOR-строку в себестоимость.
- Не использует `Employee.salaryPerShift`.

---

<a id="9-cut-readiness"></a>
## 9. Cut-readiness и material arrivals

Источник: `CutReadinessService`
(`apps/api/src/modules/cut-readiness/cut-readiness.service.ts`)
и `OrderMaterialArrivalsService`
(`apps/api/src/modules/order-material-arrivals/order-material-arrivals.service.ts`).

### 9.1 `GET /api/orders/:orderId/cut-readiness`

Read-only сводка готовности к крою (`SHOP_MANAGER`/`ADMIN`/
`CUTTER`/`CUTTER_ASSISTANT`). Сервис **ничего не пишет**:

- Проверяет setup заказа (`status` / размеры / `patternItemId` /
  `techCardId` / `routeTemplateId` / цвет).
- Проверяет лекало: для каждого размера с `qtyPlan > 0` —
  активный DXF (`PatternSizeFile.status = ACTIVE`); для
  «cut-blocking» материалов (см.
  `CUT_BLOCKING_MATERIAL_ROLES` в `@sewing/shared/cut-readiness`)
  — наличие `PatternMaterialArea`.
- По каждой `WorkshopNeed` считает `targetQty / receivedQty /
  placedQty` по POSTED строкам приёмки + `manualArrivedQty` по
  ACTIVE-overrides (см. §9.2). Если `placedQty +
  manualArrivedQty >= targetQty`, строка считается готовой и
  помечается `manuallyUnblocked = true`, если override
  фактически закрыл разрыв.
- Учитывает `OrderApplication(stage = 'CUT_PARTS')`: если
  данные нанесения не заполнены (через
  `isOrderApplicationDataFilled`), строка попадает в
  `blockers`.

Возвращает `CutReadinessDto` с плоскими списками `blockers /
warnings` и секцией `sections.materials` для UI-таблицы.

### 9.2 Manual material arrival overrides

Источник: `OrderMaterialArrivalsService` +
`order-material-arrivals.controller.ts`.

Эндпоинты:

- `GET /api/orders/:orderId/material-arrival-overrides` —
  список (включая REVOKED). RBAC: `ADMIN` / `SHOP_MANAGER`
  / `CUTTER` / `CUTTER_ASSISTANT`.
- `POST /api/orders/:orderId/material-arrived` — создать
  overrides по blocking-потребностям (или по списку
  `workshopNeedIds`). Write-RBAC дополнительно режется в
  сервисе до `ADMIN` / `SHOP_MANAGER`. Идемпотентно: если по
  потребности уже есть ACTIVE-override, не плодит дубли.
- `POST /api/orders/:orderId/material-arrival-overrides/:overrideId/revoke`
  — `ACTIVE → REVOKED`. Идемпотентно: повторный revoke на
  REVOKED — no-op без аудит-дубля.

`OrderMaterialArrivalOverride` (см.
`prisma/schema.prisma::model OrderMaterialArrivalOverride` ~3712)
— это **override готовности к крою**, а **не складская
операция**. Сервис сознательно НЕ создаёт `PurchaseReceipt` /
`PurchaseReceiptLine`, НЕ меняет `CellContent` / складские
остатки, НЕ двигает `WorkshopNeed.status`, НЕ меняет
`Order.status`, НЕ создаёт `Passport` / `OperationEntry` /
`SalaryEntry`. Запись существует только ради учёта факта
«менеджер сказал — крой можно начинать», + audit-log
(`ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED` /
`ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED`).

`CutReadinessService` читает ACTIVE-overrides и добавляет их
`qty` к `placedQty` для проверки готовности.

---

<a id="10-cut-release-policy"></a>
## 10. Cut release policy и closure requests

### 10.1 `CutReleasePolicy` — управленческое ограничение выдачи

Источник: `prisma/schema.prisma::model CutReleasePolicy`
(~2661) и `CutReleasePolicyService`
(`apps/api/src/modules/cut-release-policy/cut-release-policy.service.ts`).

Stage 3 «Мастер цеха». Мастер задаёт фильтр (`color` / `sizeId`
/ суммарный `limitQty`) → backend режет
`PassportsService.issueToEmployee` для паспортов, не
подходящих под фильтр, и инкрементит `consumedQty` для
подходящих. Само движение паспорта по маршруту
(`scan`/`complete-operation`) НЕ блокируется — ограничение
действует только на «получить крой» (см. `production-flow.md`).

Эндпоинты (RBAC `SHOPFLOOR_MASTER` / `SHOP_MANAGER` / + `ADMIN`):

- `GET /api/cut-release-policy` → `{ policy: CutReleasePolicyDto |
  null }`.
- `POST /api/cut-release-policy` — создать; в той же tx
  деактивирует другие активные политики (MVP-инвариант
  «одновременно активна максимум одна»).
- `PATCH /api/cut-release-policy/:id` — точечное обновление.
  Если переводят `isActive: true`, в той же tx гасит остальные
  активные.
- `POST /api/cut-release-policy/:id/disable` — `isActive =
  false`. Идемпотентно (повторный disable — no-op без
  audit-дубля).

Audit-events: `CUT_RELEASE_POLICY_CREATED` /
`CUT_RELEASE_POLICY_UPDATED` / `CUT_RELEASE_POLICY_DISABLED`.

Применение в production-flow — см. `docs/production-flow.md`
секция «Issue to employee».

### 10.2 Cutting closure requests (ADR-0018)

Источник: `prisma/schema.prisma::model CuttingClosureRequest`
(~1492) и `CuttingClosureService`
(`apps/api/src/modules/cutting-closure/cutting-closure.service.ts`).

Жизненный цикл: `REQUESTED → APPROVED | REJECTED` (см.
`enum CuttingClosureRequestStatus`).

Инварианты:

- На пару `(orderId, productId, sizeId)` живёт ровно одна
  активная (`REQUESTED`) и максимум одна финальная (`APPROVED`)
  заявка — partial unique index (см. ADR-0015).
- Уникальность активной заявки и одной финальной гарантируется
  на уровне БД; backend дополнительно проверяет через
  `CuttingClosureService.hasApprovedClosure(...)`.

Эндпоинты — см. `docs/api.md §17`.

После `APPROVED` `PassportsService.create` бросает
`PassportCuttingClosedException` (409 `CUTTING_CLOSED`) на
любой новый паспорт по этому размеру — это и есть «закрыт
крой по размеру».

---

<a id="11-outsource"></a>
## 11. Outsource requirements (`MANUAL` / `CUT_READY`)

Источник: `prisma/schema.prisma::model OrderOutsourceRequirement`
(~1936) + enum-ы `OutsourceTriggerType` и
`OrderOutsourceExecutionStatus`.

Snapshot создаётся в `OrdersService.start()` (см. §3.4) из
`TechCardOutsourceLine[]` через
`TechCardsService.getLinesForSnapshot`. Поле `triggerType`
копируется без изменений; `executionStatus = PLANNED`.

### 11.1 `OutsourceTriggerType`

- `MANUAL` (default, backward-compat): UI просто показывает
  строку в snapshot заказа без сигнала готовности.
- `CUT_READY`: потребность считается «готовой к заказу», когда
  у заказа есть паспорта и **все** они физически размещены в
  ячейки (`Passport.currentCellId != null`). Read-derived,
  считается на чтении в `OrdersService.getOne()` через
  `displayStatus` / `isReadyToOrder`.

### 11.2 `OrderOutsourceExecutionStatus`

Линейный жизненный цикл: `PLANNED → ORDERED → RECEIVED`
(терминальный статус, откатов через action нет).

Эндпоинт: `POST /api/orders/:id/outsource-requirements/:requirementId/status`
(RBAC `SHOP_MANAGER` + `ADMIN`).

Источник: `OrdersService.updateOutsourceRequirementStatus`
(`apps/api/src/modules/orders/orders.service.ts` ~2299).

- `PLANNED → ORDERED`: для `triggerType = CUT_READY`
  дополнительно проверяет, что все паспорта заказа физически
  в ячейке. Если нет —
  `OrderOutsourceRequirementNotReadyException` (409
  `OUTSOURCE_NOT_READY_TO_ORDER`). При успешном переходе
  фиксируется `orderedAt = new Date()` (только если был null).
- `ORDERED → RECEIVED`: фиксируется `receivedAt = new Date()`.
  `orderedAt` задним числом не заполняется.
- Идемпотентно: если уже в нужном статусе → no-op без 409 и
  без перезаписи timestamp-ов.
- Любой другой переход (например, `PLANNED → RECEIVED` или
  откат) — `OrderOutsourceRequirementInvalidTransitionException`
  (409).

### 11.3 PATCH цвета строки материала

`PATCH /api/orders/:id/material-requirements/:requirementId/color`
→ `OrdersService.updateMaterialRequirementColor`. Доступно
**только** для строк с `requiresColorSelection = true` (т.е.
`colorRule = ORDER_SELECTED_COLOR`); для остальных — 409
`ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED`. `selectedColorText`
синхронно дублируется в `resolvedColorText` строки.

Никаких side-effect на `WorkshopNeed` / `PurchaseOrder` /
payroll.

---

<a id="12-snapshot-summary"></a>
## 12. Что snapshot-ится и когда (сводная таблица)

| Поле / таблица | Источник | Когда фиксируется | Когда обновляется | Когда стирается |
| --- | --- | --- | --- | --- |
| `OrderRouteStep[]` | `RouteTemplate.steps[]` через `RoutesService.getActiveStepsForSnapshot` | `create` (если есть `routeTemplateId`); `update` в DRAFT при изменении items/route/pattern; `recalculateOperationPlan`; `startCalculation`; defensive `start` если ещё пуст. | На каждом `syncOrderRouteStepsSnapshot` — diff: если состав/порядок отличаются, atomic delete+createMany. Идемпотентно. | `update` в DRAFT при `routeTemplateId = null`. После `start` не пересчитывается (ADR-0006). |
| `OrderMaterialRequirement[]` | `TechCardMaterialLine[]` через `TechCardsService.getLinesForSnapshot` + `Order.color` | `create` (если есть `techCardId`); `update` в DRAFT при изменении items/techCard; `update` в DRAFT/CALCULATION/CALCULATION_DONE при изменении `Order.color`; `startCalculation`; defensive `start` если `count === 0`. | На каждом `rebuildMaterialRequirementsSnapshot` — preserve `selectedColorText` для `ORDER_SELECTED_COLOR`-строк; atomic delete+createMany. | `update` в DRAFT при `techCardId = null`. После `start` не пересчитывается (ADR-0006); поле `selectedColorText` точечно правится через `PATCH /api/orders/:id/material-requirements/:requirementId/color`. |
| `OrderOutsourceRequirement[]` | `TechCardOutsourceLine[]` через `TechCardsService.getLinesForSnapshot` | Только в `start()` (defensive `count === 0`). | НЕ обновляется. Точечно правится `executionStatus` через `POST /api/orders/:id/outsource-requirements/:requirementId/status`. | НЕ стирается (cascade от заказа). |
| `Order.patternNameSnapshot / patternArticleSnapshot / patternPreviewSnapshotUrl` | `PatternItem` (`name / article / previewImageUrl`) | Первый из `startCalculation` или `start`, при `!Order.patternNameSnapshot`. | НЕ перезаписывается на повторных запусках. | НЕ стирается. `PatternItem.onDelete: SetNull` обнуляет live-связь, snapshot живёт. |
| `Order.operationCostPlanRub / operationTimePlanSec / operationPlanCalculatedAt / operationPlanWarnings` | `OrderOperationPlanService.calculateForOrder` (live `RouteTemplate.steps × OrderItem`) | `create`; `update` в DRAFT при изменении items/route/pattern; `recalculateOperationPlan`; `startCalculation`. | На каждом `recalculateAndWrite` (полный перезапис). | После `start` не пересчитывается (ADR-0006). На пересчёте может стать `null` (с warnings). |
| `Order.costEstimateTotalRub / costEstimateCompletedAt / costEstimateVersion` | Активный `OrderCostEstimate(status=COMPLETED)` | `completeCalculation`. | Перезаписывается на каждом новом `completeCalculation` (новая версия). | `reopenCalculation` обнуляет в `null` (история остаётся в `OrderCostEstimate`-таблице со статусом REVOKED). На `cancel` сохраняется. |
| `OrderCostEstimate(+lines)` | `WorkshopNeed[]` (по состоянию на момент `completeCalculation`) | `completeCalculation` создаёт новую версию. | НЕ перезаписывается. На повторном `completeCalculation` — новый ряд с `version = max + 1`. | `reopenCalculation` помечает старый `status = REVOKED` (физически не удаляет). Cascade при удалении заказа. |
| `WorkshopNeed[]` | Расчёт по live-техкарте (DRAFT) или snapshot `OrderMaterialRequirement` (CALCULATION+) | `startCalculation` (force=false); `POST /api/orders/:id/workshop-needs/calculate` (с поддержкой force=true). | Пересчёт сносит только `CALCULATED`-строки; `REVIEWED` / `PURCHASE_PLANNED` сохраняются (если не `force`). | Cascade при удалении заказа. |
| `OrderMaterialArrivalOverride` | Создаётся вручную через `POST /api/orders/:orderId/material-arrived` | На запросе менеджера. | Идемпотентно — повторный markArrived на потребности с уже ACTIVE-override no-op. | `revoke` переводит в REVOKED (физически не удаляет). Cascade при удалении заказа. |
| `Order.status` | Сама сущность | На `create` = `DRAFT`. | См. §3 — `startCalculation`/`completeCalculation`/`reopenCalculation`/`start`/`complete`/`cancel`. | Не стирается, только переходит. |

---

## Что осталось UNKNOWN/TODO

- Полный список warnings `OrderOperationPlanWarnings[]` —
  формат строки задаётся внутри
  `OrderOperationPlanService.calculateForOrder`. Точный
  human-readable набор сообщений документируем по факту
  отдельным разделом в `domain.md` после ревизии (PHASE 2+).
- Семантика `displayStatus` / `isCutReadyForOrder` /
  `isReadyToOrder` для `OrderDetailDto` собирается в
  `OrdersService.toDetailDto`, формальный контракт описан в
  `packages/shared/src/orders.ts` — здесь только ссылаемся,
  чтобы не дублировать.
- Конкретный набор `WorkshopNeed.status` доменных переходов
  при создании `PurchaseOrder` / `PurchaseReceipt` /
  `cancel(PurchaseOrder)` — лежит в `WorkshopNeedsService` /
  `PurchaseOrdersService` / `PurchaseReceiptsService`. PHASE 2
  описывает только периметр заказа; полная цепочка закупок
  остаётся в `docs/recon-soft-integration.md` (status OK).
