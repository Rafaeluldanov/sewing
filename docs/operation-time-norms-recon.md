# Operation time norms recon

> Технический recon перед добавлением нормирования операций по времени.
> Код, Prisma, миграции, backend, frontend, DTO и тесты в этом recon
> **не меняются**. Это план «как мягко встроиться, ничего не сломав».

## 1. Краткий вывод

Что уже есть в системе:

- Полноценный справочник операций (`Operation`) с тремя тарифными
  режимами `PricingMode = FIXED | BY_SIZE | SALARY_ONLY` и
  поразмерными ставками `OperationRateBySize`.
- Маршруты производства как мягкая ось `RouteTemplate` →
  `RouteTemplateStep`, snapshot на заказ через `OrderRouteStep`,
  фиксируется в `OrdersService.start()`.
- Сдельные начисления (`OperationEntry`) и зарплата (`SalaryEntry`)
  — единственный текущий потребитель ставок операций; источник
  истины — `OperationsService.resolveRate(operationId, sizeId)`.
- Себестоимость заказа `OrderCostEstimate` + `OrderCostEstimateLine`
  c видами строк `MATERIAL | HARDWARE | APPLICATION | OTHER` —
  собирается на `completeCalculation` строго из `WorkshopNeed`,
  про операции в себестоимости пока ничего нет.

Что нужно добавить:

- В операции — поля «нормы времени» (фиксированная или поразмерная,
  хранение в секундах).
- В заказ — снимок плановой стоимости и плановых секунд по
  операциям (snapshot, не live-look-up).
- В себестоимость заказа — новую строку kind = `LABOR`, источник
  `ORDER_OPERATION_PLAN`.

Какая модель рекомендуется (см. §10):

- `Operation.timeNormMode = "FIXED" | "BY_SIZE"`, дефолт `"FIXED"`.
- `Operation.timeNormSec Int?` для FIXED; `null`-friendly.
- Новая таблица `OperationTimeNormBySize` (по аналогии с
  `OperationRateBySize`), `(operationId, sizeId, seconds)`.
- На `Order` — три snapshot-поля:
  `operationCostPlanRub Decimal`, `operationTimePlanSec Int`,
  `operationPlanCalculatedAt DateTime?` + nullable строка
  `operationPlanWarnings Json?` для UI-warnings.
- Детализация — отдельная таблица `OrderOperationPlanLine` —
  выносим в **этап 2/3**, в первой итерации достаточно
  snapshot-totals на заказе.

Почему нельзя сразу менять payroll:

- `OperationEntry` создаётся по факту скана/упаковки и считается из
  `resolveRate(...)`. Подмена ставки на «рассчитанную из норм
  времени» развалит существующие idempotent-ключи и
  PIECEWORK-семантику (`@@unique [passportId, operationId,
  employeeId, sourceEventType]`).
- Плановое нормирование — это **другой контур**: «сколько мы
  ожидали потратить», а фактические начисления — «что реально
  заплатили швее по куску». Их обязательно держать раздельно.

Самый безопасный первый шаг:

- Только добавить поля норм времени в `Operation` +
  `OperationTimeNormBySize`, сделать их nullable/optional
  везде, и НИЧЕГО не делать с заказом и payroll. Затем —
  отдельным этапом — расчёт `operationCostPlanRub` и
  `operationTimePlanSec`. И только потом — строка `LABOR` в
  `OrderCostEstimate`.

## 2. Текущие Prisma-модели

> Источник: `prisma/schema.prisma` (3343 строки).

| Model | Что есть сейчас | Как используется | Риск при изменении |
|-------|-----------------|------------------|---------------------|
| `Operation` | `id`, `code @unique`, `name`, `category` (`OperationCategory`), `sortOrder`, `active`, `createdAt`, `updatedAt`, **`pricingMode PricingMode @default(SALARY_ONLY)`**, **`fixedRate Decimal?`**. Связи: `events`, `entries`, `ratesBySize`, `currentPassports`, `shiftSessions`, `equipmentOperations`, `routeTemplateSteps`, `orderRouteSteps`, `masterCalls`. *(До PHASE 2 STEP 1 в этот список входил и `pieceRates`; таблица удалена, см. ADR-0020 §«PHASE 2 — drop legacy».)* | Источник тарифа для сдельных начислений (`OperationsService.resolveRate`). Появляется в маршруте, в snapshot заказа, в скане паспорта, в `MasterCall`. | Любое obligatory-поле = миграция backfill. Добавлять поля времени — **только nullable + default**. Колонка `pricingMode` НЕ должна получать новую семантику; для времени отдельный режим. |
| `OperationRateBySize` | `id`, `operationId`, `sizeId`, **`rate Decimal(12,2)`**, `createdAt`, `updatedAt`, `@@unique([operationId, sizeId])`. | Поразмерная сдельная ставка. Читается `resolveRate(...)` в той же транзакции, что создание `OperationEntry`. **Используется payroll-ом**. | Подмешивать `timeNormSec` в эту таблицу опасно: payroll-ставка и норма времени имеют разный жизненный цикл (см. §10 Вариант C — отвергнут). |
| `RouteTemplate` | `id`, `code @unique`, `name`, `isActive`, `createdAt`, `updatedAt`. | Менеджерский справочник маршрутов в `/admin/routes`. | Безопасно для расширения нормирования — времени тут нет, мы добавим его на стороне `Operation`. |
| `RouteTemplateStep` | `id`, `templateId`, `index`, `operationId`, `isOptional`, `@@unique([templateId, index])`, `@@unique([templateId, operationId])`. | Шаги маршрута. `RoutesService.replaceSteps` нормализует `index` по позиции в массиве. | Менять не нужно. Поле «учитывать в плане» = `!isOptional` подходит как фильтр. |
| `OrderRouteStep` | `id`, `orderId`, `index`, `operationId`, `@@unique([orderId, index])`. | Snapshot маршрута на заказ. Создаётся **только в `OrdersService.start()`**, не в `create`/`startCalculation`. | Если хотим план до запуска — расчёт нельзя завязывать на `OrderRouteStep` (его ещё нет в DRAFT/CALCULATION). Источник плана — live `RouteTemplate.steps`. |
| `Order` | `id`, `number @unique`, `customer`, `clientId`, `orderDate`, `dueDate`, `color`, `comment`, `status` (`OrderStatus`), `division`, `routeTemplateId`, `techCardId`, `patternItemId`, `customerUnitPrice Decimal?`, `customerCurrency`, `costEstimateTotalRub`, `costEstimateCompletedAt`, `costEstimateVersion`, `patternNameSnapshot`, `patternArticleSnapshot`, `patternPreviewSnapshotUrl`. | Ядро заказа покупателя; есть snapshot полей для патерна и для последнего `OrderCostEstimate`. | Идеальное место для **двух snapshot-полей**: `operationCostPlanRub`, `operationTimePlanSec`, `operationPlanCalculatedAt` — точно по тому же паттерну `costEstimate*`. |
| `OrderItem` | `id`, `orderId`, `productId`, `sizeId`, `qtyPlan`, `@@unique([orderId, productId, sizeId])`. | Размерная матрица заказа. | Безопасно. План считается через items × steps. |
| `Size` | `id`, `code @unique`, `sortOrder`, `createdAt`. | Справочник. | Безопасно. Поразмерные нормы — на новой таблице. |
| `Passport` | `id`, `number`, `qrCode`, `orderId`, `productId`, `sizeId`, `color`, `rollNumber`, `cutDate`, `qtyPlan`, `qtyCut`, `qtyDefect`, `qtyGood`, `status` (`PassportStatus`), `currentOperationId`, `currentEmployeeId`, `currentCellId`, `currentRouteStepIndex`, `cutterId`, `creatorId`, `pdfUrl`. | Агрегат партии. На паспорте «живут» события и сдельные начисления. | Ничего не трогаем. План времени — на заказе, не на паспорте. |
| `OperationEntry` | `id`, `passportId`, `operationId`, `employeeId`, `qty`, `ratePerUnit`, `amount`, `status` (`EntryStatus`), `approvalMode` (`ApprovalMode`), `sourceEventType` (`EarningSource`), `sourceEventId`, `createdAt`, `approvedAt`, `@@unique([passportId, operationId, employeeId, sourceEventType])`. | **Фактические сдельные начисления**. Создаются `EarningsService.createImmediateForCutter` и `EarningsService.createPendingForPreviousOperation`. | **Не трогать**. План — отдельная сущность, не подмешивается сюда. |
| `SalaryEntry` | `id`, `employeeId`, `date`, `amount`, `source` (`SalaryEntrySource`), `editedManually`, `managerComment`, `editedByEmployeeId`, `@@unique([employeeId, date, source])`. | Фактический оклад «один день — одна запись». Управляется `SalaryService`. | **Не трогать**. План времени операций ≠ оклад. |
| ~~`PieceRate`~~ | Удалена в PHASE 2 STEP 1 (миграция `20260532100000_drop_legacy_salary_base_and_piece_rate`). Раньше: `id`, `operationId`, `productId?`, `sizeId?`, `ratePerUnit`, `validFrom`, `validTo?`. | Для новых начислений не использовалась ещё с ADR-0020; runtime ходит через `OperationsService.resolveRate(...)` (`Operation.fixedRate` / `OperationRateBySize.rate`). | Не возвращаем. Нормы времени — отдельная сущность. |
| `OrderCostEstimate` | `id`, `orderId`, `version`, `status` (string `COMPLETED|REVOKED`), `totalCostRub Decimal(14,2)`, `usdRateRub Decimal?`, `completedAt`, `completedById`, `revokedAt`, `revokedById`, `comment`, `@@unique([orderId, version])`. | Документ «Себестоимость заказа», создаётся в `OrderCostEstimatesService.completeCalculation` (status `CALCULATION → CALCULATION_DONE`). Пишется snapshot-ами в `Order.costEstimateTotalRub/CompletedAt/Version`. | Безопасно: добавить строку kind = `LABOR` через **новый sourceType `ORDER_OPERATION_PLAN`** — поле `sourceType` уже хранится строкой и расширяется без миграции. |
| `OrderCostEstimateLine` | `id`, `estimateId`, `workshopNeedId?`, `sourceType?`, `sourceId?`, `kind`, `description`, `unit`, `calculatedQty?`, `purchaseQty Decimal(14,4)`, `quotedPrice Decimal(14,2)`, `quotedCurrency`, `usdRateRub?`, `lineTotalOriginal Decimal`, `lineTotalRub Decimal`, `supplierNameSnapshot?`, `purchaseItemNameSnapshot?`. | Строки расчёта, маппятся 1:1 на активные `WorkshopNeed`. | `kind`/`sourceType` хранятся как строка → можно безопасно завести `LABOR`/`ORDER_OPERATION_PLAN` без миграции схемы (только расширить enum в `@sewing/shared/order-cost-estimates` и `getWorkshopNeedKind`-логику). |

Дополнительно из enum:

```256:260:prisma/schema.prisma
enum PricingMode {
  FIXED
  BY_SIZE
  SALARY_ONLY
}
```

`PricingMode` — это **тариф для денег**. Для времени логично иметь
**свой режим** (см. рекомендация §10), пусть и со схожим именем.

## 3. Backend flow операций

### 3.1 CRUD операции

Файл: `apps/api/src/modules/operations/operations.service.ts` (388 строк).

- `OperationsService.list()` — `findMany` с `_count.ratesBySize`,
  возвращает `OperationSummaryDto[]`.
- `OperationsService.getOne(id)` — `findUnique` с `ratesBySize +
  size`, плюс отдельный `prisma.size.findMany` для UI.
- `OperationsService.create(dto)` — внутри транзакции:
  - создаёт `Operation`;
  - если `pricingMode = FIXED` — записывает `fixedRate`;
  - если `pricingMode = BY_SIZE` — `createMany` в
    `OperationRateBySize`;
  - если `pricingMode = SALARY_ONLY` — ставка не пишется.
- `OperationsService.update(id, dto)` — внутри транзакции:
  - меняет любые meta-поля;
  - **жёсткие инварианты**: `FIXED` ⇒ `fixedRate` есть и
    `ratesBySize` пуст; `BY_SIZE` ⇒ `fixedRate = null`; `SALARY_ONLY`
    ⇒ оба пусты.
  - `replace-all`-семантика для `ratesBySize` (`deleteMany +
    createMany`).
- `OperationsService.resolveRate(operationId, sizeId, tx?)` —
  **источник истины для денег**. Контракт:
  - `SALARY_ONLY` → `null` (вызывающий код пропускает создание
    `OperationEntry`);
  - `FIXED` → `Operation.fixedRate` или `OperationRateMissingException`;
  - `BY_SIZE` → `OperationRateBySize` для пары или
    `OperationRateMissingException`.

Контроллер `apps/api/src/modules/operations/operations.controller.ts`:
RBAC `@Roles('SHOP_MANAGER', 'ADMIN')`, методы `GET /api/operations`,
`POST /api/operations`, `GET /api/operations/:id`, `PATCH /api/operations/:id`.

### 3.2 Маршруты

Файл: `apps/api/src/modules/routes/routes.service.ts`.

- `RoutesService.list/getOne/create/update/remove` — стандартный
  CRUD для `RouteTemplate`.
- `RoutesService.getActiveStepsForSnapshot(templateId)` —
  возвращает упорядоченные `{ index, operationId }[]`,
  используется `OrdersService.start()`.

### 3.3 Snapshot маршрута на заказ

Файл: `apps/api/src/modules/orders/orders.service.ts`,
`OrdersService.start()` (строки ~1127–1406).

- Snapshot пишется **только при переходе в `IN_PRODUCTION`** (из
  `DRAFT | CALCULATION | CALCULATION_DONE`).
- `OrderRouteStep[]` создаётся одной транзакцией с обновлением
  `Order.status`.
- В `DRAFT/CALCULATION/CALCULATION_DONE` маршрута на заказе **ещё
  нет**, а его шаги известны только через live `routeTemplate.steps`.

### 3.4 Использование операции в паспорте

Файл: `apps/api/src/modules/passports/passports.service.ts`.

- При `create` паспорта: если у заказа уже есть
  `OrderRouteStep[]`, проставляется `currentRouteStepIndex = 0`;
- `scanOnOperation`: при сканировании нужного оборудования
  обновляет `currentOperationId`, ищет matching
  `OrderRouteStep` и двигает `currentRouteStepIndex`;
- `completeOperationByEmployee`: сравнивает `session.operationId`
  с шагами маршрута и не разрешает «откат назад» по индексу.

### 3.5 Использование операции в начислениях

Файл: `apps/api/src/modules/earnings/earnings.service.ts`.

- `createImmediateForCutter` (cuter, immediate APPROVED): дергает
  `resolveRate('CUT_CUT', sizeId, tx)`, считает
  `amount = rate * qty`, пишет `OperationEntry` с
  `sourceEventType = PASSPORT_CREATED` и
  `approvalMode = IMMEDIATE`.
- `createPendingForPreviousOperation` (швея, deferred
  PENDING_RELEASE): пропускает `SALARY_ONLY` и `CUT_CUT`, дергает
  `resolveRate(prevOperationId, sizeId, tx)`, пишет
  `OperationEntry` с `sourceEventType = OPERATION_TRANSITION`.
- `approvePendingForPassport`: `updateMany` всем pending-строкам
  паспорта в `APPROVED` при упаковке.

Уникальный ключ `@@unique([passportId, operationId, employeeId,
sourceEventType])` обеспечивает идемпотентность.

### 3.6 Производственная себестоимость (`production-cost`)

Файл: `apps/api/src/modules/costs/costs.service.ts` (`CostsService`).

- Считает **факт**: `pieceworkCost = Σ OperationEntry.amount` (status
  APPROVED) по упакованным паспортам;
- `salaryCost` — окладная доля по длительностям стадий
  (`PassportDurationsService`);
- `idleCost` — простой по сменам (`SHIFT_MINUTES − tracked`);
- В этом сервисе **никаких норм времени** нет, всё считается из
  фактической длительности `PassportEvent`-потока.

Это важно: «production-cost» по факту и «operation time plan»
по нормированию — **два разных контура**, нельзя смешивать.

## 4. Frontend flow операций

### 4.1 Список операций

`apps/web/app/admin/operations/page.tsx`:

- Таблица с колонками «Название / Категория / Тариф / Ставка /
  Статус / Открыть».
- `formatRate(op)` уже различает `FIXED` (число) /
  `BY_SIZE` (счётчик ставок) / `SALARY_ONLY` (—).

Это удобное место, чтобы потом добавить колонку «Норма
времени» с тем же стилем (один badge / счётчик).

### 4.2 Форма редактирования операции

`apps/web/app/admin/operations/[id]/edit-form.tsx` (296 строк):

- Селектор `pricingMode` (`FIXED | BY_SIZE | SALARY_ONLY`)
  переключает блоки:
  - `FIXED` — одно поле «Ставка за единицу»;
  - `BY_SIZE` — таблица «размер → ставка», состояние в
    `useState<Record<sizeId,string>>`;
  - `SALARY_ONLY` — без ставки.
- Bulk-инструмент «Заполнить всем» — единое значение разливает
  во все строки матрицы (`setRateInputs`).
- Server action `updateOperationAction` парсит поля
  `rate-<sizeId>` и шлёт `UpdateOperationDto`.

Этот же UX 1:1 переносится на нормы времени: режим
`timeNormMode` + матрица `seconds-<sizeId>` + bulk-инструмент.
Помощник «ввод в мин/сек, хранение в секундах» — простая
masked-input.

### 4.3 Карточка заказа

`apps/web/app/admin/orders/[id]/page.tsx`:

- `routeStepsForUi` маппится из `order.routeSteps[]` в
  `AdminRouteSteps`.
- В правой колонке — `OrderCostEstimateCard` (см. ниже).

`apps/web/components/orders/order-cost-estimate-card.tsx`:

- Показывает `Σ totalCostRub`, breakdown по `MATERIAL / HARDWARE /
  APPLICATION / OTHER`, число строк, дату фиксации, цена продажи и
  маржу.
- Идеальное место добавить **строку «Операции (LABOR)»** по тому
  же стилю.

### 4.4 Где задаются цены / чем переиспользовать

| Готовый компонент / стиль | Где живёт | Что переиспользуется для норм времени |
|---|---|---|
| `OperationEditForm` (rate matrix + bulk fill) | `apps/web/app/admin/operations/[id]/edit-form.tsx` | Полностью: режим + матрица + bulk. Достаточно скопировать секцию и заменить «₽» на «мин:сек». |
| `OperationsListPage` `formatRate` | `apps/web/app/admin/operations/page.tsx` | Стиль колонки «Ставка» → «Норма времени». |
| `OrderCostEstimateCard` | `apps/web/components/orders/order-cost-estimate-card.tsx` | `bucketLines` уже мап-ит kind → rub-сумма; +1 ключ `LABOR`. |
| `AdminRouteSteps` | `apps/web/components/admin/...` | Текущий рендер шагов маршрута — рядом можно показать «норма времени по шагу». |
| `formatPricingMode` | `apps/web/lib/admin-labels.ts` | Готовый паттерн «русский лейбл по enum». Сделать `formatTimeNormMode`. |

### 4.5 Earnings и production-cost UI

- `apps/web/app/earnings/*` — список начислений и редактор
  `SalaryEntry` за день. **Не трогаем.**
- `apps/web/app/admin/production-cost/page.tsx` — фактическая
  себестоимость по периодам. **Не трогаем.**
- `apps/web/app/work/*` и `apps/web/app/master/*` — сменный flow
  и мастер-действия. **Не трогаем.**

## 5. Shared DTO

### 5.1 Текущие DTO операций

`packages/shared/src/operations.ts`:

- `PRICING_MODES = ['FIXED', 'BY_SIZE', 'SALARY_ONLY'] as const`,
  `PricingMode` тип-алиас.
- `OPERATION_CATEGORIES = ['CUTTING','SEWING','QC','IRONING','PACKING']`.
- `RateField` — общий Zod helper для денежной ставки
  `Decimal(12,2)` (`number | string` → нормализация).
- `CreateOperationSchema` / `UpdateOperationSchema` —
  superRefine-валидация согласованности `pricingMode` /
  `fixedRate` / `ratesBySize`.
- `OperationRateBySizeDto`, `OperationSummaryDto`,
  `OperationDetailDto`.

### 5.2 Текущие DTO маршрутов

`packages/shared/src/routes.ts`:

- `CreateRouteTemplateSchema` / `UpdateRouteTemplateSchema`,
- `RouteTemplateStepInputSchema = { operationId, isOptional? }`,
- `RouteTemplateStepDto`, `RouteTemplateDetailDto`,
- `OrderRouteStepDto` (re-export в `orders.ts`).

### 5.3 Текущие DTO заказов

`packages/shared/src/orders.ts`:

- `CreateOrderSchema` (включает `routeTemplateId`, `techCardId`,
  `patternItemId`, `clientId`, `customerUnitPrice/Currency`,
  `applications`, `items`).
- `UpdateOrderSchema` — те же поля, + `status` для делегации
  `start/complete/cancel/startCalculation`.
- `OrderListItemDto`, `OrderDetailDto extends OrderListItemDto` —
  имеет `routeSteps`, `costEstimateTotalRub`,
  `currentCostEstimate`, snapshot-поля лекала.

### 5.4 Текущие DTO себестоимости

`packages/shared/src/order-cost-estimates.ts`:

- `ORDER_COST_ESTIMATE_STATUSES = ['COMPLETED','REVOKED']`.
- `ORDER_COST_ESTIMATE_LINE_KINDS = ['MATERIAL','HARDWARE','APPLICATION','OTHER']`.
- `CompleteOrderCalculationSchema = { usdRateRub, comment }`,
  `ReopenOrderCalculationSchema = { reason }`.
- `OrderCostEstimateLineDto`, `OrderCostEstimateDto`.

### 5.5 Что потребуется расширить additive

Все расширения **только дополняющие** (старые потребители без
пересборки shared-пакета — продолжают компилироваться):

- `packages/shared/src/operations.ts`:
  - `TIME_NORM_MODES = ['FIXED','BY_SIZE'] as const`, `TimeNormMode`.
  - Новый Zod helper `TimeNormSecondsField` (input в виде
    `{ minutes?, seconds? }` или строки `mm:ss`,
    нормализация в целое число секунд ≥ 0).
  - В `CreateOperationSchema` / `UpdateOperationSchema` —
    `timeNormMode? = 'FIXED'`, `timeNormSec?: number | null`,
    `timeNormsBySize?: { sizeId, seconds }[]`. SuperRefine аналог
    проверки согласованности с pricing.
  - В `OperationSummaryDto` — `timeNormMode?`, `timeNormSec?`,
    `timeNormsBySizeCount?`.
  - В `OperationDetailDto` — `timeNormsBySize?: { sizeId,
    sizeCode, sizeSortOrder, seconds }[]`.
- `packages/shared/src/orders.ts`:
  - В `OrderDetailDto` — `operationCostPlanRub?`,
    `operationTimePlanSec?`, `operationPlanCalculatedAt?`,
    `operationPlanWarnings?: string[]`.
  - В `OrderListItemDto` (опционально, для сводных бейджей) —
    те же поля.
- `packages/shared/src/order-cost-estimates.ts`:
  - В `ORDER_COST_ESTIMATE_LINE_KINDS` — добавить `'LABOR'`.
  - В `ORDER_COST_ESTIMATE_LINE_KIND_LABELS` — `LABOR: 'Операции'`.
  - В `OrderCostEstimateLineDto.sourceType` уже допускает
    `string` → новое значение `ORDER_OPERATION_PLAN` —
    backward-compatible.

Package exports (`packages/shared/package.json`): уже есть
`./operations`, `./orders`, `./routes`. Менять не нужно.

## 6. Где считается стоимость операций сейчас

| Контур | Что считается | Где код | Источник ставки |
|---|---|---|---|
| Сдельная ЗП (payroll-piece) | Фактический `OperationEntry.amount = rate × qty` по факту скана/упаковки | `apps/api/src/modules/earnings/earnings.service.ts::createImmediateForCutter / createPendingForPreviousOperation` | `OperationsService.resolveRate(operationId, sizeId)` |
| Окладная ЗП (payroll-salary) | Фактический `SalaryEntry.amount` | `apps/api/src/modules/salary/salary.service.ts` | `Employee.salaryPerShift` |
| Production cost (отчёт) | `pieceworkCost = Σ OperationEntry.amount`, `salaryCost = stages × minuteRate`, `idleCost` | `apps/api/src/modules/costs/costs.service.ts` | Уже посчитанные `OperationEntry` + `Employee.salaryPerShift` |
| Себестоимость заказа | `OrderCostEstimateLine` строки из `WorkshopNeed` (материалы / фурнитура / нанесение) | `apps/api/src/modules/orders/order-cost-estimates.service.ts::completeCalculation` | Цены поставщиков (`WorkshopNeed.quotedPrice/Currency`) |

Ответы по вопросам ТЗ:

- **Считается ли стоимость операции при создании заказа?** —
  Нет. Сейчас никакой плановой стоимости операций при `create` /
  `update` / `startCalculation` / `start` не считается.
- **Есть ли snapshot стоимости операции в заказе?** — Нет.
  В `Order` пока snapshot-ятся только себестоимость
  (`costEstimate*`) и лекало (`pattern*Snapshot`).
- **Где лучше добавить плановый snapshot?** — На `Order` —
  плоские поля по модели `costEstimateTotalRub` (см. рекомендация
  §10). Не на `OrderCostEstimate` — он завязан на
  `WorkshopNeed`-цикл (CALCULATION → CALCULATION_DONE) и на
  курс USD; план операций живёт раньше и не зависит от валют.
- **Как не сломать фактические начисления?** — Не трогать
  `OperationEntry`, `SalaryEntry`, `EarningsService`,
  `SalaryService`. Все новые поля — **dedicated** для плана.
  *(Историческая таблица `PieceRate` удалена в PHASE 2 STEP 1, см.
  ADR-0020 §«PHASE 2 — drop legacy».)*

## 7. Как операции связаны с маршрутом и заказом

Цепочка:

```
Operation (справочник, OperationsService)
  └─> RouteTemplateStep (по operationId, isOptional)
        └─> RouteTemplate.steps[] (RoutesService)
              └─> Order.routeTemplateId (DRAFT/CALCULATION/CALCULATION_DONE — live ссылка)
                    └─> OrderRouteStep[] (snapshot, OrdersService.start, IN_PRODUCTION)
                          └─> Passport.currentRouteStepIndex (PassportsService.scanOnOperation)
                                └─> PassportEvent.operationId (OPERATION_SCAN, OPERATION_FINISHED)
                                      └─> OperationEntry.operationId (EarningsService)
```

Ключевые моменты:

- `OrderRouteStep[]` появляется **только в `IN_PRODUCTION`**.
  Расчёт плана при `create`/`update`/`startCalculation` берёт шаги
  **из live `RouteTemplate`**.
- `routeTemplateId` менять можно только в `DRAFT` (защита по
  `OrderLockedException` + `OrderRouteAlreadyStartedException`).
  То есть план можно безопасно пересчитывать на любые DRAFT-
  изменения (route / items / sizes).
- После `start()` план **не трогать**: `OrderRouteStep` уже
  зафиксирован, и любое изменение `RouteTemplate`/`Operation` не
  должно перетереть план запущенного заказа.

## 8. Как операции связаны с payroll

| Сущность | Поле | Влияние на payroll |
|---|---|---|
| `Operation.pricingMode` | `FIXED|BY_SIZE|SALARY_ONLY` | Управляет, создаётся ли `OperationEntry` (см. `EarningsService.createPendingForPreviousOperation`). |
| `Operation.fixedRate` | `Decimal(12,2)` | Прямо попадает в `OperationEntry.ratePerUnit` для FIXED. |
| `OperationRateBySize.rate` | `Decimal(12,2)` | Прямо попадает в `OperationEntry.ratePerUnit` для BY_SIZE. |
| `OperationEntry.@@unique` | `(passportId, operationId, employeeId, sourceEventType)` | Идемпотентный ключ — повторный скан не плодит начисления. |
| ~~`PieceRate`~~ | удалена в PHASE 2 STEP 1 | До удаления — historical-таблица, новыми начислениями не использовалась. См. ADR-0020 §«PHASE 2 — drop legacy». |

Что значит «нельзя смешивать с плановой нормой времени»:

- Если положить `timeNormSec` в `OperationRateBySize` — `payroll`
  начнёт считать ставку и норму как «связку», и любое изменение
  нормы времени станет управленческим действием с риском повлиять
  на сдельную ставку. Это ломает SRP таблицы.
- Если переинтерпретировать `pricingMode` → «время + деньги»,
  `EarningsService.createPendingForPreviousOperation` начнёт
  читать иные значения и поведение payroll поменяется.
  Категорически нельзя.

Поэтому план времени держим в отдельном пространстве (см. §10).

## 9. Как лучше добавить нормы времени

### Вариант A — расширить `Operation` + новая `OperationTimeNormBySize`

Поля:

- `Operation.timeNormMode  String  @default("FIXED")` — `"FIXED" | "BY_SIZE"`.
- `Operation.timeNormSec   Int?` — для FIXED.
- Новая таблица `OperationTimeNormBySize { id, operationId,
  sizeId, seconds Int, @@unique([operationId, sizeId]) }`.

Плюсы:

- Семантически чисто: «настройки операции» — на одной модели.
- Полностью изолировано от `OperationRateBySize` — payroll не
  затронут.
- Нативно ложится на текущий UI: тот же паттерн «режим + матрица
  + bulk-fill», что и для ставок.
- Легко делать `resolveTimeNormSec(operationId, sizeId)` по образцу
  `resolveRate`.

Минусы:

- Новая таблица + миграция (один новый объект — это легко).
- Два режима (`pricingMode` и `timeNormMode`) — менеджеру нужно
  понять, что это разные оси.

Риски:

- Низкие. Новые поля nullable + default, payroll не трогается,
  старые операции работают без изменений.

Вердикт: **рекомендуется**.

### Вариант B — отдельная таблица `OperationTimeNorm` (без полей в `Operation`)

Поля:

- `OperationTimeNorm { id, operationId @unique, mode, seconds Int? }`
- `OperationTimeNormBySize { id, operationId, sizeId, seconds }`

Плюсы:

- Полная изоляция от `Operation` (можно удалять одной строкой).

Минусы:

- Надо два запроса для базового getOne(operationId) — лишний
  JOIN/include.
- В DTO `OperationDetailDto` всё равно нужно полю
  `timeNormMode`/`timeNormSec` — а они хранятся в отдельной
  таблице → лишние сервисы.
- UI всё равно показывает их «как часть операции», и инвалидация
  кэша усложняется.

Риски:

- Средние. Расхождение между «есть `Operation`, нет
  `OperationTimeNorm`» — нужно дополнительные миграции backfill.

Вердикт: **избыточно**. Поля времени логически принадлежат
операции.

### Вариант C — расширить `OperationRateBySize`

Поля:

- `OperationRateBySize.timeNormSec Int?`.
- В `Operation` добавить `timeNormSecFixed Int?`.

Плюсы:

- Не нужно новой таблицы.

Минусы / риски:

- **Высокий риск для payroll**. Вся таблица сейчас читается в
  `OperationsService.resolveRate(...)` — добавление нового
  столбца, который не используется в `resolveRate`, — ок.
  Но любая правка нормы времени теперь требует UPDATE на ту же
  строку, что и ставка. Любая случайная UPDATE-маска (например,
  частичное `set { rate, timeNormSec }`) может затереть ставку.
- Семантика разная. Ставка может быть `BY_SIZE` (без матрицы — нет
  начисления → exception). Норма времени может быть `FIXED`
  (одна на всю операцию), а ставка — `BY_SIZE`. В одной таблице
  эти оси не совмещаются.
- Невозможно иметь `pricingMode = SALARY_ONLY`, но при этом
  плановое время BY_SIZE (а это нужно — оклад без сдельной ставки
  не отменяет, что операция занимает Х секунд).

Вердикт: **отвергнуто**.

## 10. Рекомендуемая модель

Базовая рекомендация — **Вариант A** (см. §9). Конкретно:

### 10.1 Prisma (только additive, all nullable)

```prisma
// дополнить model Operation:
model Operation {
  // ... существующие поля ...
  /// Режим нормы времени: "FIXED" — одна норма на операцию,
  /// "BY_SIZE" — поразмерная матрица (см. OperationTimeNormBySize).
  /// Хранится строкой по тому же паттерну, что order-applications/colorRule:
  /// расширяется без миграции (например, "PER_PAIR" в будущем).
  timeNormMode String @default("FIXED")
  /// Фиксированная норма времени в секундах (для timeNormMode="FIXED").
  /// null — норма не задана; UI показывает «—».
  timeNormSec  Int?
  // back-relation:
  timeNormsBySize OperationTimeNormBySize[]
}

// новая модель:
model OperationTimeNormBySize {
  id          String   @id @default(cuid())
  operationId String
  sizeId      String
  /// Норма времени в СЕКУНДАХ (целое). Хранится как Int — точность
  /// одной секунды достаточна; ввод в UI — «мин:сек».
  seconds     Int
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  operation Operation @relation(fields: [operationId], references: [id], onDelete: Cascade)
  size      Size      @relation(fields: [sizeId], references: [id])

  @@unique([operationId, sizeId], name: "OperationTimeNormBySize_operation_size_uniq")
  @@index([operationId])
  @@index([sizeId])
}

// дополнить model Order:
model Order {
  // ... существующие поля ...
  /// План: суммарная стоимость операций в рублях (snapshot).
  /// Заполняется на create/update в DRAFT (если есть routeTemplateId),
  /// замораживается при start() — после start не трогаем.
  /// null — план не считался (нет маршрута / нет items / etc).
  operationCostPlanRub        Decimal? @db.Decimal(14, 2)
  /// План: суммарное время выполнения заказа в секундах (snapshot).
  /// Заполняется так же, как operationCostPlanRub.
  operationTimePlanSec        Int?
  /// Когда был посчитан текущий план.
  operationPlanCalculatedAt   DateTime?
  /// JSON-массив строковых warnings: «нет нормы для операции X»,
  /// «нет ставки», «нет маршрута». Опционально; UI показывает блок
  /// «План операций неполный, обратите внимание». null — warnings
  /// не было / план не считался.
  operationPlanWarnings       Json?
}

// дополнить model Size: ничего не меняется (back-relation
// OperationTimeNormBySize — необязательно, но опционально):
model Size {
  // ... существующие поля ...
  // Опциональная back-relation для аккуратного onDelete:
  operationTimeNormsBySize OperationTimeNormBySize[]
}
```

Плюсы такой модели:

- **Не трогает payroll**: `Operation.fixedRate` /
  `OperationRateBySize.rate` остаются source of truth для денег,
  `EarningsService` не меняется.
- **Не трогает себестоимость как существующий контракт**:
  `OrderCostEstimate(.totalCostRub)` — по-прежнему сумма строк
  `WorkshopNeed`. Строка `LABOR` появляется как новый kind, но
  её можно включать **по флагу** на этапе 3 (см. §14).
- **Не трогает Order-flow**: `start()` / `startCalculation()` /
  `complete()` / `cancel()` / `reopenCalculation()` остаются как
  есть. Plan считается **в `create`/`update`/реcчёт-helper-е**,
  не в transition-методах.
- **Backward-compatible**:
  - старые операции без норм времени → `timeNormMode = "FIXED",
    timeNormSec = null` (backfill в default);
  - старые заказы → `operationCostPlanRub = null,
    operationTimePlanSec = null` — `OrderDetailDto`-консьюмеры
    получают `null` и UI рисует «—».

### 10.2 Опционально — отдельная таблица детализации (этап 2/3, не сразу)

Если потребуется **построчная детализация** (UI «по шагам:
сколько секунд / сколько рублей»):

```prisma
model OrderOperationPlanLine {
  id             String   @id @default(cuid())
  orderId        String
  /// Snapshot на момент расчёта (operationId + название) — чтобы
  /// поздняя правка операции не «двигала» исторический план.
  operationId    String
  operationCode  String
  operationName  String
  routeStepIndex Int     // позиция в маршруте на момент расчёта
  /// Итоговое время по шагу × Σ qtyPlan: секунды.
  totalTimeSec   Int
  /// Итоговая стоимость по шагу × Σ qtyPlan: рубли.
  totalCostRub   Decimal  @db.Decimal(14, 2)
  /// Метод: 'FIXED' / 'BY_SIZE_AVG' / etc. Строка для расширения.
  method         String
  /// Произвольный warning по строке (нет ставки / нет нормы).
  warning        String?

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
  @@index([operationId])
}
```

В первой итерации делать **не нужно** — для UI достаточно
snapshot-полей `Order.operationCostPlanRub` /
`Order.operationTimePlanSec` + `operationPlanWarnings`.
`OrderOperationPlanLine` появится только если потребуется
детализация в `OrderCostEstimateCard`.

### 10.3 DTO (additive)

`packages/shared/src/operations.ts`:

```ts
export const TIME_NORM_MODES = ['FIXED', 'BY_SIZE'] as const;
export type TimeNormMode = (typeof TIME_NORM_MODES)[number];

const TimeNormSecondsField = z
  .union([z.number(), z.string()])
  .transform(/* mm:ss или Int → Int seconds, ≥0, ≤ 1_000_000 */);

export const CreateOperationSchema = z
  .object({
    // ... существующие поля ...
    timeNormMode: z.enum(TIME_NORM_MODES).optional().default('FIXED'),
    timeNormSec: TimeNormSecondsField.nullable().optional(),
    timeNormsBySize: z
      .array(z.object({ sizeId: z.string(), seconds: TimeNormSecondsField }))
      .optional(),
  })
  .superRefine((d, ctx) => {
    if (d.timeNormMode === 'FIXED' && d.timeNormsBySize?.length) /* error */;
    if (d.timeNormMode === 'BY_SIZE' && d.timeNormSec != null) /* error */;
  });

export interface OperationDetailDto extends OperationSummaryDto {
  // ... существующие поля ...
  timeNormMode: TimeNormMode;
  timeNormSec: number | null;
  timeNormsBySize: Array<{
    sizeId: string;
    sizeCode: string;
    sizeSortOrder: number;
    seconds: number;
  }>;
}
```

`packages/shared/src/orders.ts` — в `OrderDetailDto`:

```ts
export interface OrderDetailDto extends OrderListItemDto {
  // ... существующие поля ...
  operationCostPlanRub?: string | number | null;
  operationTimePlanSec?: number | null;
  operationPlanCalculatedAt?: string | null;
  operationPlanWarnings?: string[] | null;
}
```

`packages/shared/src/order-cost-estimates.ts` —
расширяем kind:

```ts
export const ORDER_COST_ESTIMATE_LINE_KINDS = [
  'MATERIAL',
  'HARDWARE',
  'APPLICATION',
  'OTHER',
  'LABOR',
] as const;
```

## 11. Алгоритм расчёта стоимости и времени заказа

Псевдокод (для нового хелпера, например
`OrderOperationPlanService.recalculate(orderId, tx?)` —
вызывается из `OrdersService.create` /
`OrdersService.update` в DRAFT):

```text
function recalculateOperationPlan(orderId, tx):
  order = tx.order.findUnique(orderId, { include: { items, routeTemplate: { steps } } })
  if !order: return

  warnings = []

  if !order.routeTemplateId:
    warnings.push("Маршрут не выбран — план операций не считается")
    write Order { operationCostPlanRub=null, operationTimePlanSec=null,
                  operationPlanCalculatedAt=now(), operationPlanWarnings=warnings }
    return

  if order.items.length == 0:
    warnings.push("Нет размерной матрицы — план операций не считается")
    same: null/null/now()/warnings
    return

  // Готовим набор шагов из live RouteTemplate (а не OrderRouteStep,
  // которого ещё нет до start). Игнорируем isOptional — в плане
  // считаем только обязательные шаги, опциональные не входят.
  steps = order.routeTemplate.steps.filter(s => !s.isOptional)

  // Подгружаем все нужные операции одним запросом.
  ops = tx.operation.findMany({
    where: { id: in steps.map(operationId) },
    include: { ratesBySize: true, timeNormsBySize: true },
  })
  opsMap = byId(ops)

  totalCostKop = 0n   // считаем в копейках, чтобы избежать FP
  totalTimeSec = 0

  for step in steps:
    op = opsMap[step.operationId]
    if !op:
      warnings.push("Операция шага удалена")
      continue

    for item in order.items:
      qty = item.qtyPlan
      if qty <= 0: continue

      // --- ВРЕМЯ ---
      timeSec = resolveTimeNormSec(op, item.sizeId)
      if timeSec == null:
        warnings.push(`Нет нормы времени: ${op.code} / size=${item.sizeId}`)
        timeSec = 0  // считаем 0, не блокируем заказ
      totalTimeSec += timeSec * qty

      // --- ДЕНЬГИ ---
      // SALARY_ONLY → не платим за единицу (но время идёт в plan!)
      if op.pricingMode == 'SALARY_ONLY':
        continue
      rateRub = resolveRateRub(op, item.sizeId)   // повторяет
                                                  // OperationsService.resolveRate
                                                  // но без exception → возвращает null + warning
      if rateRub == null:
        warnings.push(`Нет ставки: ${op.code} / size=${item.sizeId}`)
        continue
      totalCostKop += round( rateRub * 100 ) * qty

  write Order {
    operationCostPlanRub: Decimal( totalCostKop / 100 ),
    operationTimePlanSec: totalTimeSec,
    operationPlanCalculatedAt: now(),
    operationPlanWarnings: warnings.length ? warnings : null
  }
```

Где `resolveTimeNormSec(op, sizeId)`:

- `op.timeNormMode = 'FIXED'` → `op.timeNormSec ?? null`.
- `op.timeNormMode = 'BY_SIZE'` → `op.timeNormsBySize.find(t =>
  t.sizeId == sizeId)?.seconds ?? null`.

Контракты:

- **Нет `routeTemplateId`** → `null` / `null` / `[warning]`. Заказ
  не блокируем.
- **Нет ставки** → строка пропускается (по деньгам), warning в
  массив. Время по этой строке всё равно идёт.
- **Нет нормы времени** → время = 0, warning. Деньги по этой
  строке считаются как обычно.
- **`SALARY_ONLY`** → деньги = 0 для этой операции (это норма!),
  время — считается. Так и должно быть.

Когда вызывать:

- `OrdersService.create` в конце (после создания заказа в
  транзакции, тем же `tx`).
- `OrdersService.update` в DRAFT — после изменения `items` /
  `routeTemplateId` (в той же транзакции).
- При **выходе из** DRAFT (`startCalculation` или `start`) —
  ещё раз пересчитать (это финальный «слепок плана»). Это нужно,
  чтобы план соответствовал актуальному состоянию заказа на
  момент перехода в производство. После перехода — больше не
  трогаем, snapshot уже зафиксирован.
- **НЕ вызывать** на каждый GET. План — БД-snapshot, а не
  read-derived.

## 12. Как добавить LABOR в себестоимость

### 12.1 Когда добавлять

Только в `OrderCostEstimatesService.completeCalculation`,
**после** валидации существующих `WorkshopNeed`-строк.

### 12.2 Какую строку создавать

Одна строка на `OrderCostEstimate`:

```ts
{
  estimateId,
  workshopNeedId: null,                    // нет связи с WorkshopNeed
  sourceType: 'ORDER_OPERATION_PLAN',      // новый sourceType (строка в БД)
  sourceId: null,                          // или Order.id, если хотим следить
  kind: 'LABOR',                           // новый kind
  description: 'Операции производства (план)',
  unit: 'шт',
  calculatedQty: null,                     // план — не штуки в обычном смысле
  purchaseQty: orderQtyPlanTotal,          // Σ qtyPlan, чтобы было видно «база»
  quotedPrice: priceForUnit,               // operationCostPlanRub / qtyPlanTotal
  quotedCurrency: 'RUB',                   // план всегда RUB
  usdRateRub: null,
  lineTotalOriginal: order.operationCostPlanRub,
  lineTotalRub:      order.operationCostPlanRub,
  supplierNameSnapshot: null,
  purchaseItemNameSnapshot: null,
}
```

Эту строку считаем в `totalCostRub` точно так же, как материалы:
`totalCostRub = Σ lineTotalRub`.

### 12.3 Как не сломать существующие estimate-строки

- `OrderCostEstimateLine.kind` — уже `String`, расширение
  массива в `@sewing/shared/order-cost-estimates` —
  backward-compatible.
- `OrderCostEstimateLine.sourceType` — `String?`, новое значение
  `ORDER_OPERATION_PLAN` — backward-compatible.
- `getWorkshopNeedKind(...)` **не трогаем** — он работает только
  для строк, происходящих из `WorkshopNeed`. Для LABOR-строки
  kind проставляется напрямую в коде.
- UI: `OrderCostEstimateCard.bucketLines` уже использует
  `Record<OrderCostEstimateLineKind, number>` — добавить ключ
  `LABOR` (Операции).

### 12.4 Включение через флаг (этап 3)

Чтобы менять контракт `OrderCostEstimate` **в один проход**, можно
ввести флаг `INCLUDE_OPERATION_PLAN_IN_COST=true` на старте; для
исторических `COMPLETED` расчётов LABOR-строки не появятся
(они в БД лежат как есть). Новые расчёты — с LABOR.

## 13. Риски

| Риск | Степень | Mitigation |
|---|---|---|
| Payroll использует `OperationRateBySize` для подсчёта `OperationEntry.amount` — добавление timeNorm в эту же таблицу сломает invariants. | Высокий | Вариант A: отдельная `OperationTimeNormBySize`. Не трогаем `OperationRateBySize`. |
| Подмешать плановую себестоимость в `production-cost` отчёт — он считает факт по `OperationEntry`. | Высокий | План — **отдельные snapshot-поля** `Order.operationCostPlanRub/PlanSec`. Не трогать `CostsService`. |
| Изменение операции (ставки / норма) после фиксации плана может «переписать» прошлый расчёт. | Высокий | План — `Order`-snapshot, считается на `create/update/start*` и фиксируется. После `start()` (или `startCalculation` — см. §11) — read-only. |
| Поразмерные нормы могут конфликтовать со ставками: операция `BY_SIZE`-rate, но `FIXED`-time или наоборот. | Средний | Два независимых режима (`pricingMode`, `timeNormMode`). UI показывает их раздельно. |
| Отсутствие нормы времени блокирует заказ. | Средний | Алгоритм §11: нет нормы → `timeSec = 0` + warning, заказ не блокируется. |
| Старые операции без норм времени должны работать. | Средний | `timeNormMode @default("FIXED")`, `timeNormSec Int?` (null) — на пустых данных всё считается без exception. |
| Изменение формы операции может сломать старые операции/ставки. | Средний | DTO additive: новые поля optional + nullable. Существующие потребители без пересборки shared компилируются. |
| `OrderCostEstimate` должен сохранять историческую себестоимость, а не live-значение. | Высокий | LABOR-строка в `OrderCostEstimateLine` — это snapshot из `Order.operationCostPlanRub` на момент `completeCalculation`. После этого — read-only, как и остальные строки. |
| Изменение `pricingMode` в админке после `start()` могло бы переписать стоимость операций в плане. | Средний | После `start()` план не трогаем; `OrderRouteStep` уже зафиксирован, и любые правки `Operation` не вызывают `recalculateOperationPlan`. |
| План в DRAFT может «прыгать» при правке `routeTemplate` извне. | Низкий | Это нормально: расчёт пере-вызывается на каждом `update` заказа. Шаблон в DRAFT можно менять. |
| Маршрут с `isOptional = true` — учитывать или нет? | Низкий | По умолчанию **не учитываем** — это «можно пропустить шаг». Если потом нужно — флаг в DTO `includeOptional`. |
| `OrderRouteStep` и `RouteTemplateStep` могут разъезжаться (после `start()` шаблон можно менять). | Низкий | План считается из live `RouteTemplate.steps` ДО `start()`, после `start()` — план фиксируется и больше не пересчитывается. UI пишет «План зафиксирован <дата>». |
| Если payroll кто-то добавит «оплата по времени», он попытается прочитать `timeNormSec`. | Высокий | НЕ ДЕЛАТЬ. План времени не имеет отношения к фактическим начислениям. Если когда-то нужно «нормирование сделки» — это отдельный ADR. |

## 14. Пошаговый план внедрения

### Этап 1: «Нормы времени в операции»

Меняется только справочник операций. Заказы и payroll не
затрагиваются.

- **Prisma**:
  - `Operation.timeNormMode String @default("FIXED")`,
    `Operation.timeNormSec Int?`.
  - Новая таблица `OperationTimeNormBySize`.
- **Миграция**: одна, additive. Backfill: оставить null/default.
- **Backend**:
  - `apps/api/src/modules/operations/operations.service.ts` —
    расширить `create` / `update` / `getOne` / `list` /
    `_count.timeNormsBySize`. SuperRefine-валидация
    согласованности `timeNormMode` / `timeNormSec` /
    `timeNormsBySize` (по образцу `pricingMode`).
  - Новый helper `OperationsService.resolveTimeNormSec(...)`
    (по образцу `resolveRate`, но без exception → возвращает
    `number | null`).
- **Frontend**:
  - `apps/web/app/admin/operations/[id]/edit-form.tsx` — добавить
    блок «Норма времени» с режимом `FIXED|BY_SIZE`, инпут
    «мин:сек», bulk-fill.
  - `apps/web/app/admin/operations/page.tsx` — колонка «Норма
    времени» (по образцу «Ставка»).
- **DTO**:
  - `packages/shared/src/operations.ts` — `TIME_NORM_MODES`,
    `TimeNormSecondsField`, расширить
    `Create/UpdateOperationSchema`,
    `OperationSummaryDto`/`OperationDetailDto`.
- **Тесты**:
  - E2E на `/admin/operations` (создание/редактирование с
    нормой); инварианты `FIXED ⇒ нет матрицы`, `BY_SIZE ⇒ нет
    timeNormSec`.
- **Риски**: минимальны. Поле nullable, payroll не задействован.
- **Что НЕ трогать**: `EarningsService`, `SalaryService`,
  `CostsService`, `OrdersService`, `OrderCostEstimatesService`,
  `OrderCostEstimate*`, `Passport*`, `OperationEntry`,
  `SalaryEntry` *(историческая `PieceRate` уже удалена в PHASE 2
  STEP 1, ничего возвращать не нужно)*.

### Этап 2: «Расчёт плана на заказе»

Заказ начинает хранить snapshot плана. Себестоимость пока не
меняется.

- **Prisma**:
  - `Order.operationCostPlanRub Decimal?(14,2)`,
    `Order.operationTimePlanSec Int?`,
    `Order.operationPlanCalculatedAt DateTime?`,
    `Order.operationPlanWarnings Json?`.
- **Миграция**: одна, additive. Backfill: null.
- **Backend**:
  - Новый сервис / приватный helper
    `OrdersService.recalculateOperationPlan(orderId, tx)` или
    отдельный `OrderOperationPlanService` (см. §11).
  - Вызовы: в `OrdersService.create` (в конце транзакции),
    `OrdersService.update` (если `wantsItemsChange ||
    wantsRouteChange` в DRAFT), `OrdersService.startCalculation`
    (перед сменой статуса — финальный snapshot).
  - В `OrdersService.toDetailDto` — отдать `operationCostPlanRub`,
    `operationTimePlanSec`, `operationPlanCalculatedAt`,
    `operationPlanWarnings`.
- **Frontend**:
  - В карточке заказа — блок «План операций»: время (формат
    `HH:MM:SS`), стоимость, дата фиксации, warnings.
  - Опционально — в `/admin/orders` колонка «План времени» / «План
    стоимости».
- **DTO**:
  - `packages/shared/src/orders.ts` — расширить `OrderDetailDto` /
    `OrderListItemDto` плановыми полями (все optional + nullable).
- **Тесты**:
  - E2E: создаю заказ с маршрутом → проверяю
    `operationCostPlanRub > 0`, `operationTimePlanSec > 0`.
  - Заказ без маршрута → план = null, warning «нет маршрута».
  - Меняю items → план пересчитывается.
  - После `start()` — план фиксируется и не меняется при правке
    операции.
- **Риски**: средние. Изменения в `OrdersService.update` —
  чувствительный код, нужно покрыть тесты на
  status-transitions (DRAFT → CALCULATION → IN_PRODUCTION).
- **Что НЕ трогать**: payroll (всё, что в §15). `OrderCostEstimate`
  и `WorkshopNeed`-flow тоже не трогаем здесь.

### Этап 3: «LABOR в `OrderCostEstimate`»

Себестоимость заказа начинает включать строку «Операции».

- **Prisma**: ничего нового; `OrderCostEstimateLine.kind` уже
  String.
- **Backend**:
  - `OrderCostEstimatesService.completeCalculation` — после
    обработки `WorkshopNeed`-строк добавить одну LABOR-строку
    (см. §12). `totalCostRub += operationCostPlanRub`.
- **Frontend**:
  - `OrderCostEstimateCard.bucketLines` — добавить ключ `LABOR`.
  - Лейбл «Операции».
- **DTO**:
  - `packages/shared/src/order-cost-estimates.ts` — добавить
    `'LABOR'` в `ORDER_COST_ESTIMATE_LINE_KINDS` +
    `_LABEL`-словарь.
- **Тесты**:
  - E2E: complete-calculation для заказа с
    `operationCostPlanRub = 100500` → в estimate появляется
    LABOR-строка, `totalCostRub` корректно суммируется.
  - Reopen-calculation возвращает заказ к live-плану (LABOR-
    строки нет, но `Order.operationCostPlanRub` остаётся).
- **Риски**: средние. Изменяет финансовый итог по заказу. Нужно
  обязательно добавить тест «исторический COMPLETED-расчёт без
  LABOR-строки → продолжает корректно отображаться».
- **Что НЕ трогать**: `WorkshopNeed`, `PurchaseOrder`,
  `PurchaseReceipt`. Их contract не меняется.

### Этап 4: UI-polish

Доводка интерфейсов; никаких бизнес-изменений.

- **Frontend**:
  - В списках заказов (`/admin/orders`) — sortable колонка
    «План времени», бейдж warnings.
  - В карточке маршрута — рядом с шагом показать норму времени из
    `Operation.timeNormSec` / `OperationTimeNormBySize`.
  - В карточке операции — превью «итого по матрице средн.
    время».
- **Backend**: ничего.
- **Тесты**: визуальные / smoke.
- **Риски**: минимальны.

## 15. Что НЕ трогать

> Буквально: эти файлы и поля **не должны меняться** при
> внедрении норм времени. Если что-то из них необходимо
> изменить — это отдельный ADR / отдельная задача с явным
> обсуждением.

- **Payroll-сдельный**:
  - `apps/api/src/modules/earnings/earnings.service.ts`
  - `apps/api/src/modules/earnings/earnings.module.ts`
  - `OperationEntry` (модель и `@@unique`-ключ).
  - `apps/api/src/modules/operations/operations.service.ts::resolveRate`
    — менять контракт нельзя.
- **Payroll-окладный**:
  - `apps/api/src/modules/salary/salary.service.ts`
  - `SalaryEntry` (модель и `@@unique`-ключ).
- **Production cost** (фактический отчёт):
  - `apps/api/src/modules/costs/costs.service.ts`
  - `apps/api/src/modules/costs/passport-durations.service.ts`
- **Паспорт и сменный flow**:
  - `apps/api/src/modules/passports/passports.service.ts`
    (особенно `scanOnOperation`, `completeOperationByEmployee`,
    `currentRouteStepIndex`-логика).
  - `apps/api/src/modules/master-actions/master-actions.service.ts`
    (особенно `setRouteStep`).
  - `Passport` (модель).
  - `apps/web/app/work/*`, `apps/web/app/master/*`.
- **Production route** (snapshot и его правка):
  - `OrderRouteStep` (Prisma-модель).
  - `OrdersService.start()` snapshot-логика — НЕ ДОБАВЛЯТЬ
    в неё расчёт плана; план считается до `start()` и
    замораживается.
- **Workshop-needs / закупки / приёмки**:
  - `WorkshopNeed`, `apps/api/src/modules/workshop-needs/*`.
  - `PurchaseOrder`, `apps/api/src/modules/purchase-orders/*`.
  - `PurchaseReceipt`, `apps/api/src/modules/purchase-receipts/*`.
- **Лекала / техкарты**:
  - `PatternItem`, `apps/api/src/modules/patterns/*`.
  - `TechCardTemplate` / `TechCardMaterialLine` /
    `TechCardOutsourceLine` / `OrderMaterialRequirement` /
    `OrderOutsourceRequirement`,
    `apps/api/src/modules/tech-cards/*`.
- **Заказные нанесения**:
  - `OrderApplication`, `apps/api/src/modules/order-applications/*`.
- **Существующие тесты `tests/smoke/*`** — менять только тогда,
  когда меняется поведение. Этап 1 их не трогает.

## 16. Acceptance criteria будущей реализации

(на этап 1 — нормы времени в операции)

- [ ] `Operation.timeNormMode` существует, дефолт `"FIXED"`.
- [ ] `Operation.timeNormSec` существует, nullable.
- [ ] `OperationTimeNormBySize` создаётся миграцией; `@@unique
  (operationId, sizeId)`.
- [ ] `OperationDetailDto` содержит `timeNormMode`,
  `timeNormSec`, `timeNormsBySize: { sizeId, sizeCode,
  sizeSortOrder, seconds }[]`.
- [ ] `CreateOperationSchema` / `UpdateOperationSchema` валидируют
  согласованность: `FIXED ⇒ нет матрицы`, `BY_SIZE ⇒ нет
  timeNormSec`.
- [ ] UI `/admin/operations/[id]` показывает новый блок «Норма
  времени» с режимом + (опц.) матрицей + bulk fill.
- [ ] Старые операции продолжают редактироваться (поля времени
  пустые, ничего не падает).
- [ ] `EarningsService.createImmediate*/createPending*` ведёт
  себя как прежде — все существующие тесты payroll проходят.
- [ ] `OperationsService.resolveRate` возвращает прежние значения
  на тех же данных.
- [ ] `OperationsService.resolveTimeNormSec(operationId, sizeId)`:
  - `FIXED` → `Operation.timeNormSec ?? null`;
  - `BY_SIZE` → `OperationTimeNormBySize.seconds` или `null`.
- [ ] Typecheck зелёный во всех трёх пакетах.

(на этап 2 — расчёт плана на заказе)

- [ ] `Order.operationCostPlanRub`, `Order.operationTimePlanSec`,
  `Order.operationPlanCalculatedAt`, `Order.operationPlanWarnings`
  присутствуют в Prisma.
- [ ] `OrdersService.create` после фиксации заказа в DRAFT
  пересчитывает план (если `routeTemplateId` указан).
- [ ] `OrdersService.update` пересчитывает план при изменениях
  `items` / `routeTemplateId` в DRAFT.
- [ ] `OrdersService.startCalculation` пересчитывает план перед
  сменой статуса.
- [ ] После `OrdersService.start()` план не пересчитывается.
- [ ] `OrderDetailDto.operationCostPlanRub` /
  `operationTimePlanSec` доступны в API ответе.
- [ ] UI карточки заказа показывает «План операций» (время и
  деньги) с warnings, если они есть.

(на этап 3 — LABOR в себестоимости)

- [ ] `ORDER_COST_ESTIMATE_LINE_KINDS` содержит `'LABOR'`.
- [ ] При `completeCalculation` создаётся одна LABOR-строка с
  `lineTotalRub = order.operationCostPlanRub`;
  `totalCostRub` суммируется корректно.
- [ ] Старые `COMPLETED` без LABOR-строки продолжают корректно
  отображаться.

---

**Дата recon:** 2026-04-27
**Скоуп:** только документ. Код, Prisma, миграции, backend,
frontend, DTO, tests — не изменены.
