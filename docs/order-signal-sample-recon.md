# RECON — Сигнальный образец (Order Signal Sample)

> Источники истины (read-only при RECON):
> - `prisma/schema.prisma`
> - `apps/api/src/modules/passports/passports.service.ts`
> - `apps/api/src/modules/workshop-needs/workshop-needs.service.ts`
> - `apps/api/src/modules/orders/orders.service.ts`
> - `apps/api/src/modules/audit/audit.service.ts`
> - `apps/web/components/orders/view/order-view-tabs-config.ts`
> - `packages/shared/src/index.ts`
> - `docs/api.md`, `docs/erd.md`, `docs/events.md`, `docs/production-flow.md`, `docs/current-state.md`

Документ — фактическая инвентаризация перед минимальным MVP. Никаких
изменений production-flow / payroll / WTO / packing / QC / materials,
никаких новых ролей, никакого redesign.

---

## 1. Что есть в коде сегодня

### 1.1 Prisma — модели

- `Order` (`prisma/schema.prisma:910`):
  - статусы — `OrderStatus` (DRAFT, CALCULATION, CALCULATION_DONE,
    IN_PRODUCTION, DONE, CANCELLED).
  - relations: `items OrderItem[]`, `passports Passport[]`,
    `workshopNeeds WorkshopNeed[]`, `routeTemplate?`, `techCard?`,
    `routeSteps OrderRouteStep[]` (snapshot маршрута).
  - `OrderItem.qtyPlan` (`schema.prisma:1323`) — иммутабельно после
    `IN_PRODUCTION` через guard `OrderLockedException`.
- `Passport` (`schema.prisma:1436`):
  - `orderId / productId / sizeId / color / rollNumber / cutDate /
    qtyCut / qtyPlan / status`,
  - `currentOperationId / currentEmployeeId / currentCellId /
    currentRouteStepIndex`,
  - **никаких** полей `isSample`, `sampleId`, `productionKind` нет.
- `RouteTemplate` (`schema.prisma:2306`),
  `RouteTemplateStep` (`schema.prisma:2322`),
  `OrderRouteStep` (`schema.prisma:2345`) — snapshot маршрута заказа,
  паспорт стоит на `currentRouteStepIndex`. Маршрут паспорта
  наследуется от заказа.
- `WorkshopNeed` (`schema.prisma:3399`):
  - `orderId` обязателен, FK на `Order` (`onDelete: Cascade`).
  - `sourceType String?` (`TECH_CARD_MATERIAL_LINE` |
    `ORDER_MATERIAL_REQUIREMENT`) — расширяемое поле. Полей
    «sampleId» / «origin» нет.
  - `calculatedQty` считается от `Σ OrderItem.qtyPlan` —
    «потребность на весь заказ».
- `MaterialIssue` (`schema.prisma:4723`): `orderId` обязателен,
  `passportId?` опционален (`onDelete: SetNull`). Auto-issue при
  выдаче паспорта пишет `sourceKey = AUTO_CUT_ISSUE:<passportId>`.

**Sample/pilot-моделей в схеме НЕТ.** Чистый лист.

### 1.2 Backend — сервисы

- `PassportsService.create` (`passports.service.ts:136`):
  - блокирует выпуск если `order.status !== IN_PRODUCTION`
    (`PassportOrderNotInProductionException`),
  - guard «закрытый раскрой» (`CuttingClosureService.hasApprovedClosure`),
  - guard «`qtyCut > remaining`» по `Σ qtyCut` существующих
    non-CANCELLED паспортов размера vs `OrderItem.qtyPlan`,
  - в транзакции: `passport-number.service` → `Passport.create` →
    update `qrCode = passport:{id}` → `PassportEvent.CREATED` →
    `EarningsService.createImmediateForCutter` (immediate сдельное
    начисление раскройщику, может бросить `OPERATION_RATE_MISSING`).
  - **Аудит в create НЕ пишется** (audit.log не вызывается). Аудит —
    только в update/delete.
  - `currentRouteStepIndex = 0` если у заказа есть snapshot маршрута.
  - Cutter attribution: явный `dto.cutterId` либо `creator.role=CUTTER`,
    иначе 400 `CUTTER_REQUIRED`.
- `PassportsModule` (`passports.module.ts`) экспортирует
  `PassportsService` (`exports: [PassportsService]`).
- `WorkshopNeedsService.calculateForOrder`
  (`workshop-needs.service.ts:340`):
  - принимает `(orderId, dto, actorEmployeeId?)`,
  - считает от **полного** заказа (`Σ OrderItem.qtyPlan`),
  - перерасчёт идемпотентный (`dto.force`),
  - пишет аудит `WORKSHOP_NEEDS_CALCULATED` с `entityId = orderId`.
  - **Не умеет** считать «на 1 единицу / на часть размера»: формулы
    привязаны к `OrderItem.qtyPlan`. Чтобы прокинуть sampleQty,
    пришлось бы делать второй контур расчёта.
- `OrdersService.start` (`orders.service.ts:1660+`): переводит заказ
  в `IN_PRODUCTION`, фиксирует snapshot маршрута/техкарты.
  `qtyPlan` после `IN_PRODUCTION` иммутабельно (ADR-0006).
- `MaterialIssuesService.createAutoCutIssueForPassport` —
  идемпотентно по `sourceKey = AUTO_CUT_ISSUE:<passportId>`.
- `AuditService.log(input, tx?)` (`audit.service.ts:514`):
  - `AuditLogInput = { event, entityType: AuditEntityType, entityId,
    payload, employeeId? }`,
  - `AuditEntityType` — TS-union в `audit.service.ts:13`.
    `docs:check` парсит этот union, требует упоминания каждого
    члена в `docs/events.md`.

### 1.3 Backend — структура контроллеров и RBAC

- `@Roles(...)` декораторы — `apps/api/src/modules/auth/auth.decorators.ts`.
- `ADMIN` глобально проходит любой `@Roles` (см.
  `auth/roles.guard.ts`).
- Стиль на паспортах:
  `@Post() @Roles('CUTTER','CUTTER_ASSISTANT','SHOP_MANAGER')`.
- Доменные ошибки — `apps/api/src/common/errors.ts`,
  `BusinessException(code, message, status)`.

### 1.4 Frontend

- Страница заказа: `apps/web/app/admin/orders/[id]/page.tsx`.
- Конфиг табов: `apps/web/components/orders/view/order-view-tabs-config.ts`
  — массив `ORDER_VIEW_TABS` и тип-union `OrderViewTabId`.
- Серверные actions: `apps/web/app/admin/orders/[id]/*-actions.ts`
  (`material-issues-actions.ts`, `applications-actions.ts`, …),
  state `ActionFormState`.
- API-обёртки: `apps/web/lib/orders-api.ts`,
  `apps/web/lib/passports-api.ts` — типизированные `apiFetch`.
- UI-кит: `apps/web/components/admin/index.ts` (`AdminCard`,
  `AdminTable`, `AdminStatusBadge`, …), глобальные классы
  `admin-btn admin-btn--primary`.
- Модалок-абстракции **нет** — стиль «inline-form реndered after
  setOpen(true)» (см. `create-finished-goods-shipment-button.tsx`).
- Switch/Radio как готовых компонентов нет; будем верстать на
  `<input type="checkbox" role="switch">` /
  `<input type="radio">` + admin-классы.

### 1.5 Tests

- Runner — vitest + supertest. `tests/package.json`:
  - `test:integration` → `vitest run integration`,
  - `test:smoke` → `vitest run smoke`.
- Интеграционные: `describeWithDb`, `startTestApp` / `stopTestApp`,
  `resetDatabase`, `seedMinimal`, `loginAs(t, employee)` (см.
  `tests/integration/passports-complete-operation.test.ts`).
- Smoke — source-level, без БД (readFileSync + regex), см.
  `tests/smoke/admin-order-status.smoke.test.ts`.

### 1.6 Docs

- `docs:check` (`scripts/docs/check-docs.mjs`):
  - все `enum` / `model` из `schema.prisma` ⇒ упомянуты в
    `docs/erd.md`;
  - каждый controller файл + каждый роут ⇒ в `docs/api.md`;
  - каждый `PassportEventType` + каждый `AuditEntityType` ⇒
    в `docs/events.md`;
  - все md-ссылки резолвятся.
- `docs/production-flow.md` — упоминаний «sample/pilot» НЕТ.

---

## 2. Ответы на вопросы RECON

### 2.1 Есть ли уже sample-модель?
Нет. Ни `Passport`, ни `Order`, ни `OrderItem` не знают про образец.
Нет ни `isSample`, ни `productionKind`, ни `sampleId`. Нет ни
отдельного passport-flag, ни отдельного route-type. Сигнальный
образец — новая концепция.

### 2.2 Как лучше связать sample с Passport? Можно ли `Passport.sampleId?`?
**Да, добавляем `Passport.sampleId?` (nullable FK на `OrderSample`).**

Аргументы:
- `Passport` — aggregate-root, уже хранит весь production-state
  (status, cell, operation, route step). Расширять его одним
  nullable полем безопаснее, чем выносить sample-flow в параллельный
  тип паспорта.
- Тиражные паспорта остаются с `sampleId = null` (default), нынешние
  list/aggregation запросы не ломаются.
- Если завтра потребуется быстро «отделить sample от тиража» в
  любом запросе — `where: { sampleId: null }` либо
  `where: { sampleId: { not: null } }`.

### 2.3 Нужен ли `Passport.productionKind = SAMPLE/BULK`, или достаточно `sampleId`?
**Достаточно `sampleId`.** Признак «образец» = «`sampleId !== null`».
Это минимизирует enum-поля и устраняет риск рассинхрона
(`productionKind = BULK` при наличии `sampleId`). В DTO отдадим
производный boolean-флаг `isSample`, чтобы UI не цеплялся за
структуру FK.

### 2.4 Как сейчас считать material needs на 1 единицу выбранного размера?
**Не считается.** `WorkshopNeedsService.calculateForOrder` оперирует
суммой `Σ OrderItem.qtyPlan` по заказу. Существующих helper-ов для
«1 единицы выбранного размера» нет. Чистый расчёт «материал на
sampleQty по выбранному размеру» — пограничный случай нового
контура.

### 2.5 Можно ли использовать существующий workshop-needs calculation?
Только в режиме `materialMode = FULL_ORDER` — это полностью
существующий пайплайн `WorkshopNeedsService.calculateForOrder(orderId)`
по всему заказу.

Для `materialMode = SAMPLE_ONLY` существующий calc не подходит:
- запись результата идёт в `WorkshopNeed.orderId` без признака
  «sample-only / bulk», pollute тиражной потребности недопустим;
- формулы привязаны к `qtyPlan` всего заказа.

**Решение для MVP:** в `SAMPLE_ONLY` мы НЕ пишем `WorkshopNeed` в
БД; вместо этого в endpoint `GET /api/order-samples/:id` отдаём
**preview-расчёт** (не персистится). Затем после `APPROVED` менеджер
может позвать существующий `calculateForOrder` для тиражной
потребности отдельной кнопкой (как сейчас). Ограничение явно
документируется в `order-signal-sample-flow.md` и в этом RECON
ниже.

### 2.6 Как не смешать потребности образца и тиража?
Никакой записи в `WorkshopNeed` в режиме `SAMPLE_ONLY`. В
`FULL_ORDER` — стандартный flow `calculateForOrder` для тиража;
образец живёт «сверху» как отдельный passport (одна шт.). Никакой
автоматической мутации существующих `WorkshopNeed`-строк MVP не
делает.

### 2.7 Как хранить `materialMode`?
Поле `OrderSampleMaterialMode` — Postgres enum (SAMPLE_ONLY /
FULL_ORDER) на новой модели `OrderSample`. Не строкой: enum
сужает значения, а добавление новых значений делается
`ALTER TYPE … ADD VALUE` (как уже сделано для `OrderStatus`).
Это локальный enum для нового контура, не пересекается с
существующими.

### 2.8 Как хранить `countsTowardOrderQty`?
Boolean-поле на `OrderSample`. `@default(false)`. Намеренно
держим на самой модели sample, чтобы можно было поменять его до
`APPROVED` (если бизнес поправит решение). Никакой логической
мутации `OrderItem.qtyPlan` MVP не делает — эффект на тираж
считается «логически» в DTO (`OrderSampleBulkEffectDto.remainingQty`).
Это безопасно для существующего `OrderLocked` guard и для
`PassportsService.create` (его guard `qtyCut > remaining` остаётся
корректным).

### 2.9 Как использовать отдельный sample route?
Заказ уже имеет `routeTemplateId` и snapshot `OrderRouteStep[]`.
Чтобы не разветвлять snapshot заказа, sample получает свой
`routeTemplateId` отдельным полем на `OrderSample`. На MVP мы:
- **не создаём** второй `OrderRouteStep` snapshot для sample;
- sample-passport создаётся стандартным `PassportsService.create`,
  стоит на той же оси `currentRouteStepIndex` от snapshot заказа
  (если он есть);
- если `OrderSample.routeTemplateId` отличается от
  `Order.routeTemplateId`, **факт фиксируется в `OrderSample`**
  как метаинформация (UI показывает «маршрут образца отличается»);
  но enforcement маршрута паспорта остаётся mainstream-flow (без
  enforcement, как и сегодня).
- Это сознательное ограничение MVP. Если позже потребуется отдельный
  снимок маршрута для образца — добавим `OrderSampleRouteStep[]` без
  миграции бизнес-логики.

### 2.10 Какие роли должны запускать/согласовывать образец?
- **Старт sample**: `SHOP_MANAGER`, `CUTTER_ASSISTANT`, `ADMIN`.
  (Помощник раскройщика — потому что он же выпускает обычные
  паспорта; не плодим extra-роль.)
- **Approve / reject / cancel**: `SHOP_MANAGER`, `ADMIN`.
- **List / get**: `SHOP_MANAGER`, `CUTTER_ASSISTANT`, `CUTTER`,
  `SHOPFLOOR_MASTER` (read-only), `ADMIN`.
- Новых ролей не добавляем.

### 2.11 Какие статусы нужны образцу?
`OrderSampleStatus` — `IN_PROGRESS`, `READY_FOR_APPROVAL`,
`APPROVED`, `REJECTED`, `CANCELLED`. На MVP terminal-переходы:
- `IN_PROGRESS → READY_FOR_APPROVAL` (через `PassportsService`
  достигается, когда sample-passport дошёл до конца маршрута,
  то есть `PassportStatus = PACKED`). Чтобы не плодить webhook-и
  / events, в MVP сделаем явный POST endpoint, но в первый MVP-итог
  будем входить из `IN_PROGRESS` напрямую в `APPROVED` / `REJECTED`
  через явный action менеджера (нажал «Согласован»).
- `IN_PROGRESS → APPROVED` (менеджер).
- `IN_PROGRESS → REJECTED` (менеджер, с reason).
- `IN_PROGRESS → CANCELLED` (менеджер).

`READY_FOR_APPROVAL` сохранён в enum «на будущее» — без блокирующих
переходов в коде MVP, но enum-значение объявляется сразу, чтобы
расширение не требовало миграции.

### 2.12 Что происходит при APPROVED / REJECTED / CANCELLED?

- **APPROVED**: `OrderSample.status=APPROVED`, `approvedAt`,
  `approvedById`. В response endpoint-а возвращаем
  `OrderSampleBulkEffectDto`:
  - если `countsTowardOrderQty = true`: `remainingQty =
    OrderItem.qtyPlan − sampleQty` (по выбранному размеру);
  - если `false`: `remainingQty = OrderItem.qtyPlan`,
    `extraSampleQty = sampleQty`.
  - **Не мутирует** `OrderItem.qtyPlan` (это критически важно — guard
    `OrderLocked` + `PassportsService.create` уже опираются на это
    поле как иммутабельный план; мутировать его на полпути MVP опасно).
  - Audit `ORDER_SAMPLE_APPROVED`.
  - Sample passport НЕ удаляется и НЕ переименовывается.

- **REJECTED**: `status=REJECTED`, `rejectedAt`, `rejectedById`,
  `rejectionReason`. Sample passport НЕ удаляется (история
  сохраняется); кнопка «Отменить sample» (cancel) — отдельный
  action, см. ниже.

- **CANCELLED**: `status=CANCELLED`, `cancelledAt`. Sample passport
  **не удаляется** автоматически — менеджер при необходимости
  делает обычный `DELETE /api/passports/:id` по существующему flow
  (с обычными guards: `PassportPackedDeleteException`, и т. д.).

---

## 3. Решения по дизайну для MVP

| Решение | Значение | Обоснование |
|---|---|---|
| Новый Postgres enum `OrderSampleStatus` | `IN_PROGRESS / READY_FOR_APPROVAL / APPROVED / REJECTED / CANCELLED` | Локальный enum для нового контура. |
| Новый Postgres enum `OrderSampleMaterialMode` | `SAMPLE_ONLY / FULL_ORDER` | Зафиксировать допустимые значения. |
| Новая модель `OrderSample` | См. §4 | Образец = отдельная сущность с двумя связями: Order, Passport. |
| `Passport.sampleId String? UNIQUE` | nullable | Связь один-к-одному с `OrderSample`, тиражные паспорта `sampleId = null`. |
| `OrderItem.qtyPlan` | НЕ мутируем | План тиражa остаётся иммутабельным; эффект на тираж вычисляется в DTO. |
| `WorkshopNeed` | НЕ мутируем для SAMPLE_ONLY | Materials preview-only в DTO. Для FULL_ORDER используется существующий `calculateForOrder`. |
| `Passport.create` для sample | Через `PassportsService.create(dto, creatorId)` + дополнительный internal helper `createForSample(...)` | Сохраняем все side-effects (number, QR, event, immediate earnings, route step). |
| Маршрут sample | `OrderSample.routeTemplateId?` — метаинформация | Не разветвляем `OrderRouteStep`. |
| Аудит | Новый `AuditEntityType = 'ORDER_SAMPLE'`, events `ORDER_SAMPLE_STARTED / _APPROVED / _REJECTED / _CANCELLED` | Стандартная схема. |
| Frontend | Новый таб `signalSample` в `ORDER_VIEW_TABS` + список + модалка | Минимально, без sidebar. |

---

## 4. Целевая Prisma-схема (фрагменты)

```prisma
enum OrderSampleStatus {
  IN_PROGRESS
  READY_FOR_APPROVAL
  APPROVED
  REJECTED
  CANCELLED
}

enum OrderSampleMaterialMode {
  SAMPLE_ONLY
  FULL_ORDER
}

model OrderSample {
  id        String                  @id @default(cuid())
  orderId   String
  productId String
  sizeId    String
  qty       Int                     @default(1)

  /// Опциональный маршрут sample. Метаинформация — на MVP enforcement не делаем.
  routeTemplateId String?

  materialMode         OrderSampleMaterialMode
  countsTowardOrderQty Boolean                 @default(false)

  status OrderSampleStatus @default(IN_PROGRESS)

  comment         String?
  rejectionReason String?

  createdById  String?
  approvedById String?
  rejectedById String?

  createdAt   DateTime  @default(now())
  approvedAt  DateTime?
  rejectedAt  DateTime?
  cancelledAt DateTime?
  updatedAt   DateTime  @updatedAt

  order         Order          @relation(fields: [orderId], references: [id], onDelete: Cascade)
  product       Product        @relation(fields: [productId], references: [id])
  size          Size           @relation(fields: [sizeId], references: [id])
  routeTemplate RouteTemplate? @relation(fields: [routeTemplateId], references: [id])
  passport      Passport?      @relation("OrderSamplePassport")

  @@index([orderId, status])
  @@index([orderId, sizeId])
}

model Passport {
  // ... existing fields ...

  /// Сигнальный образец. Тиражные паспорта имеют `sampleId = null`.
  sampleId String?      @unique
  sample   OrderSample? @relation("OrderSamplePassport", fields: [sampleId], references: [id], onDelete: SetNull)
}

model Order {
  // ... existing relations ...
  samples OrderSample[]
}
```

Миграция чисто additive: новые таблица + 2 enum + nullable поле +
1 индекс. Нет изменений существующих колонок, нет backfill.

---

## 5. Целевые backend endpoints (минимальный набор)

| Метод | Путь | RBAC | Контроллер |
|---|---|---|---|
| POST | `/api/orders/:orderId/samples/start` | SHOP_MANAGER, CUTTER_ASSISTANT (ADMIN глобально) | `order-samples.controller.ts` |
| GET  | `/api/orders/:orderId/samples` | SHOP_MANAGER, CUTTER_ASSISTANT, CUTTER, SHOPFLOOR_MASTER | `order-samples.controller.ts` |
| GET  | `/api/order-samples/:id` | SHOP_MANAGER, CUTTER_ASSISTANT, CUTTER, SHOPFLOOR_MASTER | `order-samples.controller.ts` |
| POST | `/api/order-samples/:id/approve` | SHOP_MANAGER | `order-samples.controller.ts` |
| POST | `/api/order-samples/:id/reject` | SHOP_MANAGER | `order-samples.controller.ts` |
| POST | `/api/order-samples/:id/cancel` | SHOP_MANAGER | `order-samples.controller.ts` |

`POST /samples/:id/calculate-material-needs` **не добавляем** в MVP —
переносим в следующую итерацию вместе с моделированием sample-only
needs.

---

## 6. Доменные ошибки

- `ORDER_SAMPLE_NOT_FOUND` — 404
- `ORDER_SAMPLE_ALREADY_ACTIVE` — 409 (для пары `orderId+productId+sizeId`
  в нетерминальном статусе уже есть запись)
- `ORDER_SAMPLE_INVALID_STATUS` — 409 (нельзя approve REJECTED и т. д.)
- `ORDER_SAMPLE_SIZE_NOT_IN_ORDER` — 400 (sizeId не из `OrderItem`)
- `ORDER_SAMPLE_ORDER_INVALID_STATUS` — 409 (заказ DONE / CANCELLED)
- `ORDER_SAMPLE_QTY_EXCEEDS_ORDER_SIZE_QTY` — 400 (только если
  `countsTowardOrderQty=true` и `qty > OrderItem.qtyPlan`)
- `ORDER_SAMPLE_REJECTION_REASON_REQUIRED` — 400

`ORDER_SAMPLE_ROUTE_REQUIRED` MVP **не использует**: маршрут sample
опционален.

---

## 7. Аудит

Новый `AuditEntityType = 'ORDER_SAMPLE'` в
`audit.service.ts::AuditEntityType`. События:

- `ORDER_SAMPLE_STARTED` — entityId = `OrderSample.id`,
  payload = `{ orderId, productId, sizeId, qty, materialMode,
  countsTowardOrderQty, passportId, employeeId }`.
- `ORDER_SAMPLE_APPROVED` — `{ orderId, sizeId, qty,
  countsTowardOrderQty, approvedBy, approvedAt }`.
- `ORDER_SAMPLE_REJECTED` — `{ orderId, rejectionReason, rejectedBy }`.
- `ORDER_SAMPLE_CANCELLED` — `{ orderId, cancelledBy }`.

Все пишутся внутри транзакции через `audit.log(input, tx)`.

---

## 8. Frontend

- Новый таб `signalSample` в `ORDER_VIEW_TABS`
  (`order-view-tabs-config.ts`).
- Новая папка `apps/web/components/orders/samples/`:
  - `order-samples-card.tsx` — список образцов + кнопка «Запустить
    образец».
  - `start-order-sample-modal.tsx` — inline-форма (стиль
    `create-finished-goods-shipment-dialog`).
  - `order-sample-status-badge.tsx`.
  - `order-sample-effect-preview.tsx` — таблица «Материалы /
    Включить в тираж / Сейчас / После согласования».
- `apps/web/lib/order-samples-api.ts` — typed fetch обёртки.
- `apps/web/app/admin/orders/[id]/order-samples-actions.ts` —
  server actions (стиль `material-issues-actions.ts`,
  `ActionFormState`).

UI-переключатель «Включить образец в тираж» — `<input
type="checkbox" role="switch">` (нет shadcn). Тексты-подсказки
меняются в зависимости от значения, как описано в ТЗ.

---

## 9. Тесты

- Integration: `tests/integration/order-samples.test.ts`. По
  стандартному паттерну `describeWithDb` + `seedMinimal` +
  `loginAs`. Покрытие — см. ТЗ §«Tests».
- Smoke: `tests/smoke/order-samples-ui.smoke.test.ts` — source-level
  проверка наличия таба, переключателя, текстов, действий, отсутствия
  сайдбара.

---

## 10. MVP-ограничения (явно зафиксированы)

1. **MaterialMode = SAMPLE_ONLY**: при запуске sample backend пишет
   реальные строки `WorkshopNeed` с `orderSampleId = sample.id`
   через `WorkshopNeedsService.calculateForSampleInTx` (см.
   [`docs/order-signal-sample-flow.md §4`](order-signal-sample-flow.md)).
   После APPROVE менеджер вручную запускает обычный
   `calculateForOrder` для тиражной части (если нужно).
2. **MaterialMode = FULL_ORDER**: sample-needs пишутся так же
   (`orderSampleId = sample.id`). Bulk-needs менеджер запускает
   отдельно. Две группы строк сосуществуют, фильтруются по
   `orderSampleId`.
3. **OrderItem.qtyPlan не мутируется** — план иммутабелен, эффект
   на тираж вычисляется логически и отдаётся в DTO.
4. **Sample passport** создаётся **отдельным flow** в
   `OrderSamplesService.start` (см.
   `docs/order-signal-sample-flow.md §7a` и JSDoc сервиса):
   используются shared-сервисы (`PassportNumberService.nextNumber`,
   `buildPassportQrPayload`, `AuditService`), но **без**
   `PassportsService.create`. Это позволяет:
   - НЕ требовать жёстко `cutterId` / role=CUTTER (для sample
     atribution «расслаблена»: cutter = actor по умолчанию);
   - НЕ писать immediate `OperationEntry` (payroll out-of-scope).
   Тиражный `PassportsService.create` остаётся без изменений
   (его строгие гарды нужны для production payroll).
5. **Multiple active samples** для пары `(orderId, productId, sizeId)`
   запрещены: 409 `ORDER_SAMPLE_ALREADY_ACTIVE`. После REJECTED /
   CANCELLED можно запустить новый.
6. **Sample passport не удаляется** автоматически при rejection /
   cancel — для удаления используется штатный `DELETE
   /api/passports/:id` с его обычными инвариантами.
7. **Маршрут sample** — поле `routeTemplateId?` хранится как
   метаинформация; реального второго snapshot маршрута не создаём.
8. **Никаких новых ролей.**
9. **Никаких изменений** в payroll / materials / packing / QC / WTO /
   PLT / CutLay / CutReleasePolicy / OrderCutIssueRule бизнес-логике.

---

## 11. Что нужно обновить в документации

- `docs/erd.md` — добавить `OrderSampleStatus`, `OrderSampleMaterialMode`
  (Enum-ы), `OrderSample` (Models).
- `docs/api.md` — раздел «Order samples» с шестью endpoints, ссылка
  на `order-samples/order-samples.controller.ts`.
- `docs/events.md` — `ORDER_SAMPLE` в `AuditEntityType` + 4 события.
- `docs/production-flow.md` — короткий раздел про sample vs bulk.
- `docs/screens.md` — таб «Сигнальный образец» в карточке заказа.
- `docs/current-state.md` — короткое упоминание модуля.
- Новый: `docs/order-signal-sample-flow.md` — полный flow + примеры
  «order M=300, sample M=1» для обоих значений `countsTowardOrderQty`.
