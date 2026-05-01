# Production flow

> Статус: **OK** (создан в PHASE 2, 2026-Q2).
>
> Источник истины — **код**, не этот документ. При расхождении
> верим коду.
>
> Source files:
>
> - `prisma/schema.prisma` — модели `Passport`, `PassportEvent`,
>   `PassportDefect`, `Box`, `BoxItem`, `OperationEntry`,
>   `SalaryEntry`, `MasterCall`, `CutReleasePolicy`,
>   `CellContent`, `Cell`; enum-ы `PassportStatus`,
>   `PassportEventType`, `EntryStatus`, `ApprovalMode`,
>   `EarningSource`, `OperationCategory`, `PricingMode`,
>   `SalaryEntrySource`, `Role`, `MasterCallStatus`.
> - `apps/api/src/modules/passports/**`
>   (`passports.service.ts`, `passports.controller.ts`,
>   `cells.controller.ts`, `order-passports.controller.ts`,
>   `passport-print.ts`, `qr.ts`, `passport-number.service.ts`).
> - `apps/api/src/modules/qc/**`
>   (`qc.service.ts`, `qc.controller.ts`,
>   `defect-types.controller.ts`, `passport-defects.controller.ts`).
> - `apps/api/src/modules/wto/**` (`wto.service.ts`,
>   `wto.controller.ts`).
> - `apps/api/src/modules/packing/**`
>   (`packing.service.ts`, `packing.controller.ts`,
>   `box-number.service.ts`).
> - `apps/api/src/modules/earnings/**`
>   (`earnings.service.ts`, `earnings.controller.ts`,
>   `passport-earnings.controller.ts`, `earnings.constants.ts`).
> - `apps/api/src/modules/salary/**`
>   (`salary.service.ts`, `salary.controller.ts`,
>   `salary.constants.ts`).
> - `apps/api/src/modules/shopfloor/**`
>   (`shopfloor.service.ts`, `shopfloor-projection.ts`,
>   `shopfloor.controller.ts`).
> - `apps/api/src/modules/shifts/shifts.service.ts`
>   (sync-точка `safeSyncSalary` на старте/стопе смены).
> - `apps/api/src/modules/cut-release-policy/**`
>   (применение политики выдачи кроя в `issueToEmployee`).
> - `apps/api/src/modules/master-actions/**` и
>   `master-calls/**` — операции мастера цеха.
> - `docs/api.md` — карта routes.
> - `docs/erd.md` — карта моделей и enum-ов.
> - ADR-0002 (паспорт = агрегат-корень), ADR-0003
>   (event-sourcing-lite), ADR-0005 (моменты начисления),
>   ADR-0010 (печатная форма паспорта), ADR-0011
>   (упаковка / коробки), ADR-0012 (идемпотентность сдельных
>   начислений), ADR-0013 (маппинг паспортов на этапы экрана
>   «Цех»), ADR-0021 (дневной оклад от факта смены).

---

## Содержание

- [1. Passport как агрегат-корень](#1-passport)
- [2. PassportStatus (lifecycle)](#2-status)
- [3. PassportEvent / PassportEventType](#3-events)
- [4. Создание паспорта (`POST /api/passports`)](#4-create)
- [5. Размещение в ячейку (`POST /api/passports/:id/place`)](#5-place)
- [6. Issue (`POST /api/passports/:id/issue`)](#6-issue)
  - [6.3 Cut release policy](#cut-release-policy)
- [7. `OPERATION_SCAN` и `complete-operation`](#7-scan)
- [8. ОТК (`QC_PASSED`)](#8-qc)
- [9. ВТО (`WTO_PASSED`)](#9-wto)
- [10. Packing (`Box` / `BoxItem` / `PACKED`)](#10-packing)
- [11. Earnings (`OperationEntry`)](#11-earnings)
- [12. Salary (`SalaryEntry`)](#12-salary)
- [13. Когда начисления pending, когда APPROVED](#13-timing)
- [14. Master actions / master calls](#14-master)
- [15. Связь с shopfloor buckets](#15-shopfloor)

---

<a id="1-passport"></a>
## 1. Passport как агрегат-корень

Источник: `prisma/schema.prisma::model Passport` (~1092–1148).

Один Passport = одна партия раскроя одного `(orderId, productId,
sizeId)` (ADR-0002, ADR-0009). Денормализованные поля состояния:

- `qtyPlan` — план в момент выпуска (= `qtyCut` на момент
  `create`, см. §4).
- `qtyCut` — фактически выпущено раскройщиком; не уменьшается.
- `qtyDefect` — Σ `PassportDefect.qty` (инкрементится в
  `QcService.recordDefect`).
- `qtyGood = qtyCut − qtyDefect` (поддерживается в
  `QcService.recordDefect` через `decrement`).
- `status: PassportStatus` (см. §2).
- `currentOperationId` / `currentEmployeeId` / `currentCellId` —
  «текущий след» паспорта. После `PACKED` обнуляются
  `currentEmployeeId` / `currentCellId`; `currentOperationId`
  оставляется как «последний след» (см. `PackingService.addPassport`).
- `currentRouteStepIndex Int?` — soft-route индекс текущего
  шага в snapshot маршрута заказа (`OrderRouteStep.index`).
  Заполняется в `create`, обновляется в `scanOnOperation`,
  откатывается мастером через `MasterActionsService.setRouteStep`.

Связи: `events: PassportEvent[]`, `entries: OperationEntry[]`,
`boxItems: BoxItem[]`, `defects: PassportDefect[]`.

Уникальные поля: `number` (формат `P-####…`, выдаётся
`PassportNumberService`), `qrCode` (`passport:{id}`, ADR-0008;
после `create` финальный QR пишется отдельным `tx.update`).

---

<a id="2-status"></a>
## 2. PassportStatus (lifecycle)

Источник: `prisma/schema.prisma::enum PassportStatus` (~175–180).

| Значение | Семантика | Кто меняет |
| --- | --- | --- |
| `CREATED` | Только что выпущен `PassportsService.create`. До `place` лежит «в воздухе»; после `place` — в `Cell`. | `PassportsService.create` (default) |
| `IN_PROGRESS` | Швея «получила крой» (`issueToEmployee`) или паспорт двинулся по операциям (`scanOnOperation`). | `PassportsService.issueToEmployee`, `PassportsService.scanOnOperation` |
| `PACKED` | Добавлен в `Box` через `PackingService.addPassport`. Терминальный для production; `currentEmployeeId` / `currentCellId` обнуляются. | `PackingService.addPassport` |
| `CANCELLED` | Снят. На MVP **API-эндпоинта для перевода в CANCELLED нет**; статус используется как фильтр/защитная семантика (например, в `aggregateOrder` и `bucketOf` он явно отсекается). UNKNOWN/TODO: ручной перевод в CANCELLED — отдельный сценарий, в коде сейчас не реализован. |

Терминальная семантика для разных операций:

- `assertPassportActive` (`PassportsService` private) бросает
  `PassportAlreadyPackedException` (для `PACKED`) и
  `PassportCancelledException` (для `CANCELLED`).
- `PackingService.addPassport` дополнительно требует
  `status === IN_PROGRESS` и `qtyGood > 0`, иначе
  `PassportNotPackableException`.
- `QcService.recordDefect` / `QcService.completeQc` требуют
  `status === IN_PROGRESS`, иначе `PassportNotQcableException`.
- `WtoService.completeWto` требует `status === IN_PROGRESS` И
  `currentOperation.category === IRONING`, иначе
  `PassportNotWtoableException`. Дополнительно — должен быть
  хотя бы один `PassportEvent(QC_PASSED)`, иначе
  `PassportNotQcPassedException`.
- `PassportsService.completeOperationByEmployee` требует
  `status === IN_PROGRESS` и `currentEmployeeId === me`, иначе
  `PassportNotInProgressException` / `PassportNotYoursException`.

---

<a id="3-events"></a>
## 3. PassportEvent / PassportEventType

Источник: `prisma/schema.prisma::model PassportEvent` (~1154) и
`enum PassportEventType` (~182–208).

Контракт: ADR-0003 (event-sourcing-lite). Состояние паспорта =
денормализация по `PassportEvent`-журналу; пишутся всегда в
той же `$transaction`, что и связанные изменения
`Passport.* / Box.* / OperationEntry.*`.

| Тип | Кто пишет | qty | Доп. поля |
| --- | --- | --- | --- |
| `CREATED` | `PassportsService.create` | `qtyCut` | `operationId = CUT_DIVISION`, `payload = { rollNumber, color }`. |
| `ISSUED_TO_EMPLOYEE` | `PassportsService.issueToEmployee` | `qtyCut` | `cellId` (если выдача из ячейки) или `null`, `operationId = session.operationId`, `employeeId`. |
| `OPERATION_SCAN` | `PassportsService.scanOnOperation` | `qtyGood` | `operationId = session.operationId`, `fromOperationId = previous`, `employeeId`. |
| `OPERATION_FINISHED` | `PassportsService.completeOperationByEmployee` | `qtyGood` | `operationId = session.operationId` (а НЕ `passport.currentOperationId`). |
| `CELL_PLACED` | `PassportsService.place` | `qtyCut` | `cellId`, `operationId = currentOperationId`. |
| `CELL_REMOVED` | (используется `MasterActionsService.returnPassportToCell`) | UNKNOWN/TODO | UNKNOWN/TODO — точный набор полей лежит в `master-actions.service.ts`. |
| `DEFECT_RECORDED` | `QcService.recordDefect` | `qty` (брак) | `payload = { defectId, defectTypeId, defectTypeCode, defectTypeName, comment }`. |
| `QC_PASSED` | `QcService.completeQc` | `qtyGood` | `operationId = passport.currentOperationId`, `employeeId = ОТК`. **Не меняет `Passport.status`** — это аудит-маркер. |
| `WTO_PASSED` | `WtoService.completeWto` | `qtyGood` | `operationId = passport.currentOperationId`, `employeeId = ВТО`. **Не меняет `Passport.status`** — аудит-маркер. |
| `PACKED` | `PackingService.addPassport` | `qtyGood` | `boxId`, `employeeId`. Меняет `Passport.status = PACKED`. |
| `OPERATION_STARTED` / `MOVED` / `CANCELLED` | Не пишутся в текущем коде (зарезервированы под расширение). | — | UNKNOWN/TODO. |

Дополнительные audit-events (через `AuditService`, в той же
`$transaction`):

- `ORDER_CREATED` / `ORDER_STARTED` / `ORDER_CALCULATION_STARTED` /
  `ORDER_CALCULATION_COMPLETED` / `ORDER_COST_ESTIMATE_CREATED` /
  `ORDER_CALCULATION_REOPENED` / `ORDER_OPERATION_PLAN_RECALCULATED`
  / `ORDER_PATTERN_SNAPSHOT_CREATED` — см. `order-flow.md`.
- `PASSPORT_ISSUED` (`mode: 'FROM_CELL' | 'ROUTE_WIP'`) —
  `PassportsService.issueToEmployee`.
- `PASSPORT_SCANNED` — `PassportsService.scanOnOperation`.
- `PASSPORT_PACKED` / `BOX_CLOSED` —
  `PackingService.addPassport` / `PackingService.close`.
- `QC_COMPLETED` / `WTO_COMPLETED` — `QcService.completeQc` /
  `WtoService.completeWto`.
- `MASTER_PASSPORT_*` — `MasterActionsService` (см. §14).

---

<a id="4-create"></a>
## 4. Создание паспорта (`POST /api/passports`)

Источник: `PassportsService.create`
(`apps/api/src/modules/passports/passports.service.ts` ~99–255).
Контроллер: `POST /api/passports` (RBAC `CUTTER` /
`CUTTER_ASSISTANT` / `SHOP_MANAGER` + `ADMIN`).

Предусловия:

- `Order` существует и `status === IN_PRODUCTION` — иначе
  `PassportOrderNotInProductionException`.
- `OrderItem` для `dto.sizeId` существует — иначе
  `PassportSizeNotInOrderException`.
- Нет APPROVED-`CuttingClosureRequest` на
  `(orderId, orderItem.productId, sizeId)` —
  `CuttingClosureService.hasApprovedClosure(...)`. Иначе
  `PassportCuttingClosedException` (409 `CUTTING_CLOSED`).
- `dto.qtyCut <= remaining`, где `remaining = orderItem.qtyPlan
  − Σ qtyCut по живым (не-`CANCELLED`) паспортам этого размера`
  — иначе `PassportQtyExceedsRemainingException(remaining)`.
- В справочнике операций должен быть `Operation(code='CUT_DIVISION')`
  — иначе `BadRequestException(OPERATION_NOT_FOUND, "Запустите
  npm run db:seed")`.

Внутри `$transaction`:

1. `PassportNumberService.nextNumber(tx)` → новый `number` вида
   `P-…`.
2. `Passport.create(...)`: `qrCode = 'passport-pending:<number>'`
   как заглушка; `status = CREATED`; `currentOperationId =
   CUT_DIVISION.id`; `currentEmployeeId = creator.id`; `cutterId
   = (Employee.login='cutter') ?? creator.id`; `currentRouteStepIndex
   = (order.routeSteps.length > 0) ? 0 : null`.
3. `Passport.update { qrCode = 'passport:<id>' }` — финальный
   QR-код после получения id.
4. `PassportEvent.create({ type: CREATED, operationId:
   CUT_DIVISION.id, employeeId: creator.id, qty: qtyCut,
   payload: { rollNumber, color } })`.
5. `EarningsService.createImmediateForCutter(tx, ...)` — сдельное
   начисление раскройщику в **той же** транзакции
   (см. §11.1).

Логирование: `event=passport.create passportId=… orderId=…
sizeId=… qtyCut=… creatorId=…`.

**`creatorId`** = текущий пользователь сессии (из ADR-0014).
**`cutterId`** на MVP берётся из seed-учётки `cutter` (если
есть), иначе fallback к `creator`. Когда появится «крой
бригадой», эту логику вынесут в отдельный шаг (UNKNOWN/TODO).

---

<a id="5-place"></a>
## 5. Размещение в ячейку (`POST /api/passports/:id/place`)

Источник: `PassportsService.place`
(`apps/api/src/modules/passports/passports.service.ts` ~337–460).
Контроллер: `POST /api/passports/:id/place` (RBAC
`CUTTER` / `CUTTER_ASSISTANT` / `SHOP_MANAGER` + `ADMIN`).

Предусловия:

- `Passport.status === CREATED` — иначе
  `PassportNotPlaceableException` (если `IN_PROGRESS` /
  `PACKED` / `CANCELLED`).
- Если `currentCellId` уже задан → `PassportAlreadyPlacedException`.

Cell резолвится через `findCellByIdOrCode(dto.cellId, dto.cellCode)`:

- если `cellId` — поиск по id;
- если `cellCode` — поиск по нормализованному коду / QR
  `cell:{id}`;
- ничего не найдено / `Cell.active === false` — соответственно
  `CellNotFoundException` / `CellInactiveException`.

Внутри `$transaction`:

- Инкремент `CellContent` по `(cellId, sizeId)`: если уже есть
  — `update { quantity: +qtyCut }`, иначе `create { quantity:
  qtyCut }`.
- `Passport.update { currentCellId, status: остаётся CREATED }`.
- `PassportEvent.create({ type: CELL_PLACED, cellId, qty: qtyCut,
  operationId = currentOperationId })`.

---

<a id="6-issue"></a>
## 6. Issue (`POST /api/passports/:id/issue`)

Источник: `PassportsService.issueToEmployee`
(`apps/api/src/modules/passports/passports.service.ts` ~462–658).
Контроллер: `POST /api/passports/:id/issue` (RBAC: any
authenticated; `employeeId` — из сессии).

Предусловия:

- Паспорт существует, `status` не терминальный
  (`assertPassportActive`).
- У сотрудника есть открытая `ShiftSession` — иначе
  `ShiftSessionRequiredException`.

Поведение зависит от того, лежит ли паспорт в ячейке и есть ли
у заказа snapshot маршрута (`Passport.currentRouteStepIndex !==
null`):

### 6.1 «Из ячейки» (`passport.currentCellId !== null`)

Внутри `$transaction`:

- Декремент `CellContent.quantity` (`max(quantity − qtyCut, 0)`).
- `Passport.update { currentCellId: null, currentEmployeeId =
  me, status: IN_PROGRESS }`.
- `PassportEvent.create({ type: ISSUED_TO_EMPLOYEE, cellId =
  старый currentCellId, operationId = session.operationId,
  employeeId = me, qty: qtyCut })`.
- `audit.log({ event: 'PASSPORT_ISSUED', payload: { mode:
  'FROM_CELL', fromCellId, operationId, qty } })`.
- `consumeCutReleasePolicyInTx(...)` (см. §6.2).

### 6.2 «Route-WIP без ячейки» (`currentCellId === null`)

Если `currentRouteStepIndex !== null` (у заказа есть snapshot
маршрута):

- Идемпотентность: тот же сотрудник на `IN_PROGRESS` — no-op,
  возвращает текущее состояние без новых событий.
- Если паспорт уже в `IN_PROGRESS` у другого исполнителя —
  `PassportAlreadyIssuedException`.
- Иначе `Passport.update { currentEmployeeId = me, status:
  IN_PROGRESS }` + `PassportEvent.create({ type:
  ISSUED_TO_EMPLOYEE, cellId: null, operationId =
  session.operationId, employeeId, qty: qtyCut })` +
  `audit.log({ event: 'PASSPORT_ISSUED', payload: { mode:
  'ROUTE_WIP', operationId, qty } })`.

Если у заказа маршрута нет (`currentRouteStepIndex === null`)
И `currentCellId === null`:

- Если `currentEmployeeId !== null` → `PassportAlreadyIssuedException`.
- Иначе → `PassportNotInCellException` (старое поведение
  «нужно сначала разместить в ячейке»).

<a id="cut-release-policy"></a>
### 6.3 Cut release policy (применение)

Источник: `evaluateCutReleasePolicyForIssue` +
`consumeCutReleasePolicyInTx` (private) в `passports.service.ts`
~1103–1254 + `CutReleasePolicyService` (см. `order-flow.md §10.1`).

Stage 3 «Мастер цеха». Активная политика проверяется только на
ПЕРВОЙ операции маршрута или операциях категории `CUTTING`
(`session.operation.category === CUTTING` либо
`Passport.currentRouteStepIndex === 0`).

- Если активной политики нет — выдача проходит как обычно.
- Если есть и `Passport.color !== policy.color` (когда
  `policy.color` задан) либо `Passport.sizeId !== policy.sizeId`
  (когда задан) → `CutReleasePolicyViolationException` (409
  `CUT_RELEASE_POLICY_VIOLATION`) с сообщением, собранным
  через `formatCutReleasePolicyMessage`.
- Если фильтр прошёл, но `consumedQty + qtyCut > limitQty` —
  тоже `CutReleasePolicyViolationException`.
- При успешной выдаче `consumeCutReleasePolicyInTx` атомарно
  инкрементит `CutReleasePolicy.consumedQty` через conditional
  `updateMany({ where: { id, consumedQty: <текущее значение> } })`
  — это снимает race между двумя одновременными выдачами.

Само движение паспорта по маршруту (`scan` /
`complete-operation`) политикой НЕ блокируется — ограничение
действует только на «получить крой».

---

<a id="7-scan"></a>
## 7. `OPERATION_SCAN` и `complete-operation`

### 7.1 `POST /api/passports/:id/scan`

Источник: `PassportsService.scanOnOperation`
(`apps/api/src/modules/passports/passports.service.ts` ~673–802).
Контроллер: `POST /api/passports/:id/scan` (RBAC: any auth).

Контракт: «любой скан = переход на `session.operationId`».

Предусловия:

- Паспорт есть, статус не терминальный (`assertPassportActive`).
- Есть открытая `ShiftSession` — иначе
  `ShiftSessionRequiredException`.
- **QC-gate для входа на ВТО**: если
  `session.operation.category === IRONING` И
  `passport.currentOperationId !== session.operationId`
  (т.е. это не повторный скан той же операции) — обязательно
  должен существовать хотя бы один
  `PassportEvent(QC_PASSED)`, иначе
  `PassportNotQcPassedException` (409 `PASSPORT_NOT_QC_PASSED`).

Идемпотентность (ADR-0003 §6): если `currentOperationId ===
session.operationId` И `currentEmployeeId === me` И
`status === IN_PROGRESS` → no-op, новый event не пишется,
ничего в БД не двигается. Логируется
`event=passport.scan.noop`.

Внутри `$transaction`:

- Запоминаем `previousOperationId` / `previousEmployeeId` ДО
  апдейта — нужны для §11.2.
- Считаем `nextRouteStepIndex`: если в `OrderRouteStep` есть
  шаг с `operationId === session.operationId` → берём его
  `index`; иначе оставляем прежний `currentRouteStepIndex` (НЕ
  ломаем UI, НЕ кидаем 409).
- `Passport.update { currentOperationId = session.operationId,
  currentEmployeeId = me, status: IN_PROGRESS,
  currentRouteStepIndex = nextRouteStepIndex }`.
- `PassportEvent.create({ type: OPERATION_SCAN, operationId =
  session.operationId, fromOperationId = previousOperationId,
  employeeId = me, qty: qtyGood })`.
- `EarningsService.createPendingForPreviousOperation(tx, {
  passportId, previousOperationId, previousEmployeeId,
  productId: passport.productId, sizeId: passport.sizeId,
  qty: passport.qtyCut, sourceEventId: event.id })` (см. §11.2).
- `audit.log({ event: 'PASSPORT_SCANNED', payload: {
  operationId, fromOperationId, previousEmployeeId, qty,
  routeStepIndex } })`.

### 7.2 `POST /api/passports/:id/complete-operation`

Источник: `PassportsService.completeOperationByEmployee`
(`apps/api/src/modules/passports/passports.service.ts` ~854~).
Контроллер: `POST /api/passports/:id/complete-operation`
(RBAC: any auth).

Семантика: швея явно завершает свою операцию по паспорту.
Дальнейшее движение — pipeline-driven (следующий сотрудник
перехватит штатным `scan` / `issue`).

Предусловия:

- `assertPassportActive` (терминальные → 409).
- `Passport.status === IN_PROGRESS` — иначе
  `PassportNotInProgressException`.
- `Passport.currentEmployeeId === me` — иначе
  `PassportNotYoursException`.
- Есть открытая `ShiftSession` — иначе
  `ShiftSessionRequiredException`.

Что делает (в одной tx):

- `completedOperationId = session.operationId` —
  **источник истины** для завершаемой операции (а не
  `passport.currentOperationId`). Это критично для route-WIP
  «issue без последующего scan»: после `issueToEmployee`
  паспорт может остаться с `currentOperationId =
  CUT_DIVISION`, и наивный fallback на
  `passport.currentOperationId` дал бы абсурдное
  «завершил CUT_DIVISION» в логе.
- Ищет `OrderRouteStep` с `operationId =
  completedOperationId`. Если стоит в маршруте раньше
  `passport.currentRouteStepIndex` — `PassportCompleteBackwardException`
  (409 `PASSPORT_COMPLETE_BACKWARD`). Откат назад — прерогатива
  мастера через `MasterActionsService.setRouteStep`.
- `Passport.update { currentEmployeeId: null, currentCellId:
  null, currentOperationId = completedOperationId,
  currentRouteStepIndex = completedStep?.index ?? текущий }` —
  паспорт уходит из `current-work` швеи в WIP-buffer.
- `PassportEvent.create({ type: OPERATION_FINISHED,
  operationId = completedOperationId, employeeId = me, qty:
  qtyGood })`.
- НЕ перепрыгивает на следующий шаг — это нужно для семантики
  WIP-buffer'а (complete → ✔ текущей; следующий scan → ▶
  следующей; см. `shopfloor-projection.ts §buildSewingRoute`).

---

<a id="8-qc"></a>
## 8. ОТК (`QC_PASSED`)

Источник: `QcService`
(`apps/api/src/modules/qc/qc.service.ts`).

### 8.1 Доступность для ОТК

`QcService.listForQc` отдаёт все паспорта со
`status === IN_PROGRESS` (см. ADR-0013): это компромисс
строже «после первого `OPERATION_SCAN`», но не требует
отдельного запроса по событиям. Терминальные статусы
исключены.

### 8.2 `POST /api/qc/passports/:id/defects`

`QcService.recordDefect` (RBAC `QC` / `SHOP_MANAGER` + `ADMIN`):

- Проверяет `passport.status === IN_PROGRESS` (иначе
  `PassportNotQcableException`), `defectType` (`DefectTypeNotFoundException`
  / `DefectTypeInactiveException`), активного актора
  (`EmployeeNotFoundException` / `EmployeeInactiveException`).
- Граница: `dto.qty <= passport.qtyCut − passport.qtyDefect`,
  иначе `DefectExceedsRemainingException(remaining)`. Внутри
  tx граница перепроверяется (под локом).
- В одной tx: `PassportDefect.create(...)`,
  `Passport.update { qtyDefect: { increment }, qtyGood: {
  decrement } }`,
  `PassportEvent.create({ type: DEFECT_RECORDED, employeeId,
  operationId = currentOperationId, qty: dto.qty, payload: {
  defectId, defectTypeId, defectTypeCode, defectTypeName,
  comment } })`.

`Order.qtyDefectTotal` денормализованно отрабатывается через
`aggregateOrder` (`apps/api/src/modules/orders/order-aggregator.ts`),
которая считает по живым (не-`CANCELLED`) паспортам заказа.

### 8.3 `POST /api/qc/passports/:id/complete`

`QcService.completeQc` (RBAC `QC` / `SHOP_MANAGER` + `ADMIN`):

- Сознательно **не меняет** `Passport.status` /
  `currentOperationId` / `currentEmployeeId` — `QC_PASSED`
  это аудит-маркер, а не движение по pipeline (см. ADR-0013).
- Требует `passport.status === IN_PROGRESS`.
- В одной tx:
  `PassportEvent.create({ type: QC_PASSED, employeeId = me,
  operationId = passport.currentOperationId, qty: qtyGood })`
  + `audit.log({ event: 'QC_COMPLETED', payload: { passportId,
  operationId, qty } })`.

Идемпотентность: повторное «Проверка выполнена» допустимо.
Каждое нажатие — отдельное событие.

### 8.4 Производные derived-флаги ОТК

`QcService.loadDetail` отдаёт:

- `qcCompletedAt` — `createdAt` самого свежего `QC_PASSED`
  (или `null`).
- `removedFromQc` — `true`, если `qcCompletedAt !== null` И
  либо паспорт стал `PACKED`/`CANCELLED`, либо появился новый
  `OPERATION_SCAN` после `qcCompletedAt`. Используется
  QC-терминалом (`apps/web/app/qc/qc-terminal.tsx`), чтобы
  схлопнутая строка «Проверено ОТК» исчезала, как только
  паспорт двинулся дальше.
- `canRecordDefect = (status === IN_PROGRESS && remainingForDefect > 0)`.
- `canCompleteQc = (status === IN_PROGRESS)`.

---

<a id="9-wto"></a>
## 9. ВТО (`WTO_PASSED`)

Источник: `WtoService`
(`apps/api/src/modules/wto/wto.service.ts`).

### 9.1 «Принять паспорт на ВТО»

Отдельного эндпоинта **нет**. Приём на ВТО = существующий
`POST /api/passports/:id/scan` со сменой на операции категории
`IRONING`. Backend сам делает QC-gate (см. §7.1):
без `PassportEvent(QC_PASSED)` `scanOnOperation` бросает
`PassportNotQcPassedException`.

### 9.2 `POST /api/wto/passports/:id/complete`

`WtoService.completeWto` (RBAC `IRONING` / `SHOP_MANAGER` +
`ADMIN`):

- Полный аналог `QcService.completeQc`.
- Дополнительные предусловия:
  `passport.status === IN_PROGRESS` И
  `passport.currentOperation.category === IRONING` (иначе
  `PassportNotWtoableException`); ещё раз `assertQcPassed`
  (`PassportEvent(QC_PASSED)` обязателен; иначе
  `PassportNotQcPassedException`); активный актор.
- В одной tx:
  `PassportEvent.create({ type: WTO_PASSED, employeeId,
  operationId = currentOperationId, qty: qtyGood })`
  + `audit.log({ event: 'WTO_COMPLETED', … })`.
- Сознательно не меняет `Passport.status` /
  `currentOperationId`.

Производные derived-флаги (`WtoService.loadDetail`):

- `wtoCompletedAt` — самое свежее `WTO_PASSED`.
- `qcPassedAt` — самое свежее `QC_PASSED` (для UI
  «ОТК прошло такого-то»).
- `removedFromWto` — полный аналог `removedFromQc`.
- `canCompleteWto = (status === IN_PROGRESS && currentOperation
  .category === IRONING)`.

---

<a id="10-packing"></a>
## 10. Packing (`Box` / `BoxItem` / `PACKED`)

Источник: `PackingService`
(`apps/api/src/modules/packing/packing.service.ts`).

Контроллер: `@Controller('packing/boxes') @Roles('PACKING',
'SHOP_MANAGER')` + `ADMIN`. Routes — `docs/api.md §29`.

### 10.1 `Box` / `BoxItem`

`prisma/schema.prisma::model Box` (~1404):

- `number String UNIQUE` — выдаётся `BoxNumberService`.
- `qrCode String UNIQUE` — `box:{id}` (ADR-0008).
- `totalQty Int default(0)`, `maxQty Int default(100)`.
- `closedAt DateTime?` — `null` пока коробка открыта.
- `createdById` (Employee).

`prisma/schema.prisma::model BoxItem` (~1421):

- `boxId`, `passportId String UNIQUE` (глобальный uniq —
  ADR-0015), `qty Int`.
- Cascade — нет; `passportId @unique` гарантирует, что один
  паспорт не попадёт в две коробки.

### 10.2 Создание / список

- `POST /api/packing/boxes` — `PackingService.create(dto,
  actorEmployeeId)`. Требует активной смены актора на
  операции `PACKING` (`assertPackingActor`).
- `GET /api/packing/boxes` / `GET /api/packing/boxes/:id` —
  read.

### 10.3 `POST /api/packing/boxes/:id/add-passport`

`PackingService.addPassport`:

- `assertPackingActor(actorEmployeeId)` — у актора есть
  открытая `ShiftSession` на операции категории `PACKING`.
- Резолв паспорта (`resolvePassport(dto)`) — по `passportId`,
  `passportNumber` или QR `passport:{id}`.
- Pre-flight гварды: `PACKED` → `PassportAlreadyPackedException`,
  `CANCELLED` → `PassportCancelledException`,
  `status !== IN_PROGRESS || qtyGood <= 0` →
  `PassportNotPackableException`.

В одной `$transaction`:

- Перечитывает `Box` под локом и проверяет `closedAt === null`
  (иначе `BoxClosedException`); перечитывает паспорт и
  пере-валидирует те же гварды.
- **Однородность коробки** (ADR-0011 §3): `BoxItem` уже есть —
  у всех должен быть тот же `(productId, sizeId, color)` что
  и у нового паспорта. Иначе
  `BoxHomogeneityViolatedException`.
- **Capacity**: `passport.qtyGood > box.maxQty − box.totalQty`
  → `BoxCapacityExceededException(remaining)`.
- `BoxItem.create({ boxId, passportId, qty: qtyGood })`,
  `Box.update { totalQty: { increment: qtyGood } }`.
- `Passport.update { status: PACKED, currentEmployeeId: null,
  currentCellId: null }`. `currentOperationId` оставляется как
  «последний след».
- `PassportEvent.create({ type: PACKED, boxId, employeeId =
  actor, qty: qtyGood })`.
- `audit.log({ event: 'PASSPORT_PACKED', entityType: 'PACKING',
  entityId = boxId, payload: { boxId, passportId, sizeId, qty
  } })`.

**Важно**: финальный апрув начислений происходит **на закрытии
коробки**, не на добавлении (см. §10.4 и §13). Дополнительных
начислений упаковщику не создаётся — упаковка на MVP
оплачивается окладом.

`Order.qtyFinishedTotal` пересчитывается денормализованно
через `aggregateOrder` (`Σ Passport.qtyGood` по PACKED-паспортам
заказа) — отдельной записи в `Order` нет.

### 10.4 `POST /api/packing/boxes/:id/close`

`PackingService.close`:

- `assertPackingActor(actor)`.
- В одной tx: проверяет, что коробка существует, не закрыта
  (`BoxClosedException`), `totalQty > 0`
  (`BoxEmptyCloseException`).
- `Box.update { closedAt: new Date() }`.
- Для каждого `BoxItem.passportId` в коробке:
  `EarningsService.approvePendingForPassport(tx, passportId)`
  (см. §11.3). Идемпотентно — повторный close невозможен из-за
  `BoxClosedException`.
- `audit.log({ event: 'BOX_CLOSED', payload: { boxId, totalQty,
  passportIds } })`.

### 10.5 Public-роуты

- `GET /api/packing/boxes/:id/qr` (Public, ADR-0008) — PNG QR
  `box:{id}`.
- `GET /api/packing/boxes/:id/label` (Public, ADR-0010) —
  HTML A6 80×120 мм этикетка.

---

<a id="11-earnings"></a>
## 11. Earnings (`OperationEntry`)

Источник: `prisma/schema.prisma::model OperationEntry` (~1184) и
`EarningsService` (`apps/api/src/modules/earnings/earnings.service.ts`).

### 11.1 `createImmediateForCutter`

Триггер: `PassportsService.create` (см. §4) — в той же tx, что
выпуск паспорта.

Алгоритм:

- Проверяет, что `Employee(cutterId).active && isPieceworkEligible(compensationType)`
  (т.е. `compensationType ∈ {PIECEWORK, MIXED}`). Иначе тихо
  ничего не создаёт.
- Грузит `Operation(code='CUT_CUT')`. Если не найден —
  тихо skip. Если `pricingMode === 'SALARY_ONLY'` — тоже skip
  (раскрой переведён на оклад).
- Источник истины для выбора схемы — `Order.division` через
  `getCutterCompensationSchemeForDivision` (см.
  `packages/shared/src/cutter-compensation.ts`):
  - `MARKETPLACE` → `MARKETPLACE_FIXED`:
    `createImmediateForCutterMarketplace` →
    `amount = Operation.fixedRate × qty` через
    `OperationsService.resolveRate` (поддерживает FIXED и
    BY_SIZE).
  - `OTHER` (legacy B2B + будущий явный `B2B`) →
    `B2B_SEWING_PERCENT`:
    `createImmediateForCutterB2b` → `base = Σ
    rate(SEWING-операция, размер) × qty`,
    `percent = employee.cutterB2bSewingPercent ?? ENV
    CUTTER_B2B_SEWING_PERCENT`, `amount = base × percent / 100`.

Запись:

- `OperationEntry { passportId, operationId =
  CUT_CUT.id, employeeId = cutterId, qty,
  ratePerUnit, amount, status: APPROVED, approvalMode:
  IMMEDIATE, sourceEventType: PASSPORT_CREATED, approvedAt: new
  Date() }`.
- Идемпотентность через `@@unique([passportId, operationId,
  employeeId, sourceEventType])` (ADR-0012). Повторный
  trigger → `P2002` тихо проглатывается в `safeCreate`.

### 11.2 `createPendingForPreviousOperation`

Триггер: `PassportsService.scanOnOperation` (см. §7.1) — в той
же tx, по «предыдущей» операции/исполнителю.

- Если `previousOperationId === null` или `previousEmployeeId
  === null` (например, первый scan после CUT_DIVISION без
  явного previous) — silent skip.
- Если `qty <= 0` — skip.
- Грузит `Operation(previousOperationId)`. Если
  `pricingMode === 'SALARY_ONLY'` или `code === 'CUT_CUT'`
  (CUT_CUT покрывается immediate-веткой) — skip.
- Грузит `Employee(previousEmployeeId)` — должен быть `active`
  и `isPieceworkEligible` (PIECEWORK/MIXED).
- Грузит ставку через
  `OperationsService.resolveRate(operationId, sizeId, tx)` —
  единственный источник ставки (FIXED / BY_SIZE; SALARY_ONLY
  → `null`/skip).
- Если ставка не найдена — silent skip.

Запись:

- `OperationEntry { passportId, operationId, employeeId, qty,
  ratePerUnit = rate, amount = round(rate × qty),
  status: PENDING_RELEASE, approvalMode: AFTER_RELEASE,
  sourceEventType: OPERATION_TRANSITION, sourceEventId
  (PassportEvent.id для audit), approvedAt: null }`.
- Идемпотентность: см. §11.1.

### 11.3 `approvePendingForPassport`

Триггер: `PackingService.close` (см. §10.4) — в той же tx, по
каждому `BoxItem.passportId`.

- `OperationEntry.updateMany({ where: { passportId, status:
  { in: [PENDING_RELEASE, PENDING] } }, data: { status:
  APPROVED, approvedAt: new Date() } })`.
- Возвращает `count` затронутых записей (для логов).

### 11.4 Read-эндпоинты

- `GET /api/earnings` — `EarningsService.list(query, viewer)`.
  Менеджеры (`SHOP_MANAGER` / `ADMIN` =
  `EARNINGS_MANAGER_ROLES`) видят все строки и могут
  фильтровать `employeeId` / `status`. Остальные роли —
  принудительный скоуп `employeeId = viewer.employeeId` И
  `status: APPROVED` (затирается на сервере, см.
  `applyViewerScope`).
- `GET /api/earnings/summary` — `EarningsService.summary`
  (totalApproved/Pending + counts) с тем же RBAC-скоупом.
- `GET /api/passports/:id/earnings` —
  `EarningsService.listByPassport(passportId, viewer)`.
  Менеджеры — все начисления; остальные — только свои
  `APPROVED`.

---

<a id="12-salary"></a>
## 12. Salary (`SalaryEntry`)

Источник: `prisma/schema.prisma::model SalaryEntry` (~1236) и
`SalaryService` (`apps/api/src/modules/salary/salary.service.ts`).
ADR-0021.

Параллельный контур к сдельщине: `OperationEntry` не трогается.

### 12.1 `syncDailySalary(employeeId, date, tx?)`

Создаёт/обновляет ровно одну `SalaryEntry` на пару
`(employeeId, date)` для `source = SHIFT_DAY`. Безопасно
вызывать любое количество раз.

Алгоритм:

1. Грузит `Employee.compensationType` + `salaryPerShift` +
   `active`. Если `PIECEWORK`, `!active` — skip (return null).
2. Считает количество `ShiftSession` за UTC-сутки (`startedAt
   ∈ [day, dayEnd]`). Если 0 — skip (не создаём окладные за
   дни без смен; уже созданные не удаляем — менеджер мог
   оплатить «ручной» день через `source = MANUAL` (UNKNOWN/TODO
   — на MVP `source = MANUAL` создаётся только через
   `PATCH /api/salary/:id`)).
3. Если `salaryPerShift === null` — skip (аномалия, но не
   валим `start/stop shift`).
4. `upsert` по `(employeeId, date, source = SHIFT_DAY)`:
   - update только если `editedManually = false` →
     `amount = salaryPerShift`;
   - create новой записи: `amount = salaryPerShift,
     source: SHIFT_DAY`;
   - если `editedManually = true` — `amount` не трогается.

Где вызывается:

- `ShiftsService.start(...)` → `safeSyncSalary(employeeId,
  startedAt)` — fail-soft (любая ошибка sync только
  логируется, shift операция не валится).
- `ShiftsService.stop(...)` → `safeSyncSalary(employeeId,
  startedAt)` — подстраховка для legacy-данных, у которых
  start был до внедрения sync. Дата берётся `startedAt` смены,
  чтобы не сдвинуть оклад на следующий день при ночном
  завершении.

### 12.2 Read / manual

- `GET /api/salary` — `SalaryService.list(query, viewer)`.
  Менеджеры (`SHOP_MANAGER` / `ADMIN` через
  `isSalaryManager`) видят всех; остальные — только свои
  строки.
- `GET /api/salary/summary` — `SalaryService.summary`.
- `PATCH /api/salary/:id` (RBAC `SHOP_MANAGER` / `ADMIN`) —
  `SalaryService.updateManually(...)`. Меняет только `amount` /
  `managerComment`. `editedManually` ставится в `true`.
  Если в DTO `reset = true` — `editedManually` снимается,
  `amount` возвращается к `Employee.salaryPerShift`.

---

<a id="13-timing"></a>
## 13. Когда начисления pending, когда APPROVED

Сводная таблица состояний `OperationEntry.status`:

| Сценарий | Когда создаётся | `status` | `approvalMode` | `sourceEventType` | Когда становится APPROVED |
| --- | --- | --- | --- | --- | --- |
| Раскройщик — Marketplace (`Order.division = MARKETPLACE`) | `PassportsService.create` (в tx). | `APPROVED` сразу | `IMMEDIATE` | `PASSPORT_CREATED` | Уже APPROVED при создании. |
| Раскройщик — B2B/OTHER (`Order.division = OTHER`) | `PassportsService.create` (в tx). | `APPROVED` сразу | `IMMEDIATE` | `PASSPORT_CREATED` | Уже APPROVED при создании. |
| Пошив — любая `pricingMode ∈ {FIXED, BY_SIZE}` операция (не CUT_CUT) | `PassportsService.scanOnOperation` для **предыдущего** исполнителя (в tx). | `PENDING_RELEASE` | `AFTER_RELEASE` | `OPERATION_TRANSITION` | `PackingService.close(boxId)` → `EarningsService.approvePendingForPassport(tx, passportId)` для каждого `BoxItem.passportId` (бывшее поведение «на add-passport» переехало на close, см. ADR-0005 §«Подтверждение»). |
| Пошив — `pricingMode === SALARY_ONLY` | Не создаётся. | — | — | — | — |
| Окладные сотрудники (PIECEWORK-условие не выполнено) | Не создаётся `OperationEntry`; вместо этого `SalaryService.syncDailySalary` ведёт `SalaryEntry` (см. §12). | — | — | — | — |
| Упаковщик | Не создаётся. На MVP упаковка оплачивается окладом. | — | — | — | — |

**Расхождение с `docs/api.md §29`** (PHASE 1): там
описано «Side effects: … перевод `OperationEntry(PENDING_RELEASE
→ APPROVED)` на add-passport». В реальном коде апрув
переехал на `close()` (см. `PackingService.close` ~368–424 и
комментарий «Финальный шаг цепочки … перенесено на закрытие
коробки»). При обновлении PHASE 2-карты `api.md` строка про
add-passport должна быть приведена к коду.

Идемпотентность:

- Уникальный составной индекс `OperationEntry_idem`
  (`@@unique([passportId, operationId, employeeId,
  sourceEventType])`, ADR-0012). Повторные триггеры →
  P2002 → silent skip в `safeCreate`.
- `approvePendingForPassport` фильтрует только
  `{ PENDING_RELEASE, PENDING }` — повторный close невозможен
  (BoxClosedException), но и сам updateMany уже idempotent.

`EntryStatus` (`prisma/schema.prisma::enum EntryStatus`):
`PENDING`, `PENDING_RELEASE`, `APPROVED`, `CANCELLED`,
`REVERSED`. На MVP активно используются три:
`PENDING_RELEASE` (пошив до упаковки), `APPROVED` (после
закрытия коробки и для immediate-раскроя),
`PENDING` (legacy — апрув их тоже включает). `CANCELLED` /
`REVERSED` — UNKNOWN/TODO, в коде write-эндпоинтов под них
нет.

---

<a id="14-master"></a>
## 14. Master actions / master calls

### 14.1 Master calls (вызов мастера)

Источник: `prisma/schema.prisma::model MasterCall` (~2112) и
`MasterCallsService` (`apps/api/src/modules/master-calls/`).
Routes — `docs/api.md §22`.

Жизненный цикл `MasterCallStatus`: `OPEN → RESOLVED |
CANCELLED`.

- `POST /api/master-calls` — рабочий нажимает «Мастер». RBAC:
  `SEAMSTRESS` / `CUTTER` / `CUTTER_ASSISTANT` / `QC` /
  `IRONING` / `PACKING` / `SHOPFLOOR_MASTER` / `SHOP_MANAGER`
  + `ADMIN`. Идемпотентно: если у сотрудника уже есть `OPEN`
  — возвращается он, дубль не плодится. В момент создания
  backend подтягивает активную `ShiftSession` сотрудника и
  копирует `equipmentId` / `operationId` (нужно для
  `/master` и подсветки плитки на `/shopfloor/display`).
- `GET /api/master-calls` — `SHOPFLOOR_MASTER` /
  `SHOP_MANAGER` (+ `ADMIN`). Список открытых.
- `POST /api/master-calls/resolve-by-employee-qr` — мастер
  сканирует QR сотрудника (`EMPLOYEE:<id>`) → `OPEN → RESOLVED`,
  фиксируется `resolvedAt` и `resolvedById`.

### 14.2 Master actions

Источник: `MasterActionsService`
(`apps/api/src/modules/master-actions/`). Routes — `docs/api.md §23`.

RBAC: `SHOPFLOOR_MASTER` / `SHOP_MANAGER` + `ADMIN`. Все
эндпоинты возвращают `MasterActionResultDto({ passport, before
})` и пишут в `AuditLog` (`MASTER_PASSPORT_*`).

- `POST /api/master-actions/passports/:id/unassign` —
  `Passport.currentEmployeeId = null` с указанием `reason`.
- `POST /api/master-actions/passports/:id/transfer-to-employee`
  — переназначение паспорта (`employeeId, reason`).
- `POST /api/master-actions/passports/:id/return-to-cell` —
  возврат в активную ячейку (`cellId, reason`).
- `POST /api/master-actions/passports/:id/set-route-step` —
  принудительное `currentRouteStepIndex = index` (`index,
  reason`); используется для отката назад по маршруту,
  который запрещён через `complete-operation`.

UNKNOWN/TODO: точный набор `PassportEvent`-типов, которые
пишет каждое master-action (например, `CELL_REMOVED`
упоминается в enum-е, но в коде сервисов выше `place` /
`addPassport` / `scan` он не используется явно — возможно,
используется в master-actions; полный аудит вынесен в
`master-actions.service.ts`).

---

<a id="15-shopfloor"></a>
## 15. Связь с shopfloor buckets

Источник: `apps/api/src/modules/shopfloor/shopfloor-projection.ts`
(`bucketOf`, `projectShopfloor`, `projectShopfloorDisplay`).
ADR-0013.

Чистая функция `bucketOf(p: ProjectionPassport): ShopfloorStage |
null` определяет, в какой bucket падает паспорт. Это
**read-only проекция** на текущее состояние паспорта —
никаких новых таблиц/событий, никакой материализованной витрины
(см. также `display-board.md`).

| Bucket | Условие на паспорте | qty |
| --- | --- | --- |
| `CUT` | `status = CREATED` ИЛИ (rare) `status = IN_PROGRESS` + `currentOperationCategory = CUTTING` + `currentEmployeeId = null` (CUT-rollback мастером, см. `shopfloor-projection.ts §bucketOf`). | `qtyCut` |
| `SEWING` | `status = IN_PROGRESS` + `currentOperationCategory ∈ {CUTTING, SEWING}` (CUTTING сюда попадает после `issueToEmployee` до первого `OPERATION_SCAN` — паспорт уже у швеи) ИЛИ `currentOperationCategory = null` (защита от «дыр»). | `qtyCut` |
| `QC` | `status = IN_PROGRESS` + `currentOperationCategory = QC` + НЕТ свежего `QC_PASSED`. | `qtyCut` |
| `QC_DONE` | `status = IN_PROGRESS` + `currentOperationCategory = QC` + есть свежий `QC_PASSED` (`createdAt > max(OPERATION_SCAN.createdAt)` для того же паспорта). | `qtyCut` |
| `WTO` | `status = IN_PROGRESS` + `currentOperationCategory = IRONING` + НЕТ свежего `WTO_PASSED`. | `qtyCut` |
| `WTO_DONE` | `status = IN_PROGRESS` + `currentOperationCategory = IRONING` + есть свежий `WTO_PASSED`. | `qtyCut` |
| `PACKING` | `status = PACKED` + хотя бы один `BoxItem` в OPEN-коробке (`box.closedAt IS NULL`). | `qtyGood` |
| `FINISHED` | `status = PACKED` + PACKING-условие не сработало (нет `BoxItem` или все коробки закрыты). | `qtyGood` |

`DEFECT` — это **не** stage; отдельный показатель:
`Σ Passport.qtyDefect` среди не-`CANCELLED` паспортов.

`CANCELLED` исключаются во всех бакетах.

Источник свежести `QC_PASSED` / `WTO_PASSED`:
`ShopfloorService.getDisplaySummary` гонит один `groupBy` по
`PassportEvent`, ограниченный списком id паспортов-кандидатов
(`IN_PROGRESS` + `category ∈ {QC, IRONING}`), и сравнивает
`max(createdAt)` с `max(OPERATION_SCAN.createdAt)`. Это держит
запрос узким даже на длинной истории событий.

Полная карта проекции (включая sewing-операции в виде
динамических колонок и «маршрутный sewing-блок» с
`▶/✔`-подколонками) описана в `display-board.md`.

---

## Что осталось UNKNOWN/TODO

- `PassportStatus = CANCELLED` — в коде нет API-эндпоинта,
  который переводит паспорт в этот статус. Семантика отмены
  (например, через master-action) — UNKNOWN/TODO.
- `PassportEvent` типы `OPERATION_STARTED` / `MOVED` /
  `CANCELLED` / `CELL_REMOVED` — зарезервированы в enum-е,
  но в текущем коде `passports.service.ts` / `qc.service.ts` /
  `wto.service.ts` / `packing.service.ts` не пишутся (кроме
  `CELL_REMOVED`, который, возможно, пишет
  `MasterActionsService.returnPassportToCell` —
  UNKNOWN/TODO без детального чтения master-actions).
- `SalaryEntry.source = MANUAL` — в `prisma/schema.prisma`
  есть, но в `SalaryService` явного create-пути под него
  нет. Документировать после ревизии payroll-flow.
- Точная семантика `removedFromQc` / `removedFromWto` для
  edge-кейса «паспорт `PACKED` без OPERATION_SCAN после
  `QC_PASSED`» (например, если упаковщик добавляет паспорт
  без явного скан-перехода): тестируется в
  `tests/integration/qc.test.ts` / `wto.test.ts`. PHASE 2
  не дублирует.
- `OperationEntry.status ∈ {CANCELLED, REVERSED}` — write-flow
  в коде нет (PHASE 1 PHASE 2 включают только PENDING /
  PENDING_RELEASE / APPROVED).
