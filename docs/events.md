# События в системе

> Документ переписан от кода. Источник истины — `prisma/schema.prisma`
> и сервисы под `apps/api/src/modules/**`. Всё, что не подтверждено
> кодом, помечено как `UNKNOWN`.

---

## 1. Что такое событие в системе

В коде живут две независимые сущности, которые одновременно называют
«событиями»:

### 1.1. `PassportEvent` — доменные события движения паспорта

Таблица `PassportEvent` (см. `prisma/schema.prisma::PassportEvent`,
строки 1154–1178) хранит поток событий по конкретному паспорту:
создание, размещение в ячейке, выдача швее, сканы на операциях,
фиксация брака, ОТК, ВТО, упаковка.

- тип события — enum `PassportEventType`
  (`prisma/schema.prisma::PassportEventType`, строки 182–208);
- пишется ТОЛЬКО в транзакциях сервисов `passports` / `qc` / `wto` /
  `packing` в момент реального изменения состояния паспорта;
- читается аналитикой и дашбордами (см.
  `apps/api/src/modules/dashboard/dashboard.service.ts`,
  `apps/api/src/modules/shopfloor/shopfloor.service.ts`,
  `apps/api/src/modules/costs/passport-durations.service.ts`,
  `apps/api/src/modules/costs/production-cost-v2.service.ts`,
  `apps/api/src/modules/costs/costs.service.ts`);
- используется как guard: вход на ВТО проверяет наличие `QC_PASSED`
  (`apps/api/src/modules/passports/passports.service.ts:706`,
  `apps/api/src/modules/wto/wto.service.ts:147`).

### 1.2. `AuditLog` — универсальный журнал управленческих действий

Таблица `AuditLog` (см. `prisma/schema.prisma::AuditLog`,
строки 2045–2056) — свободный по форме журнал «кто что сделал».
Запись идёт через `AuditService.log(...)`
(`apps/api/src/modules/audit/audit.service.ts:229`) в ту же
транзакцию, что и бизнес-операция. Используется всеми модулями,
где важно зафиксировать управленческое действие: заказы,
потребности цеха, PO/PR, мастер-вызовы, master-actions, справочники.

### 1.3. Где используется event-sourcing-lite

- Текущее состояние паспорта **денормализовано** в самом `Passport`
  (`status`, `currentOperationId`, `currentEmployeeId`, `currentCellId`,
  `qtyCut`/`qtyGood`/`qtyDefect`, `currentRouteStepIndex`) —
  см. `prisma/schema.prisma::Passport`.
- `PassportEvent` параллельно накапливает факты, из которых
  рассчитывается:
  - длительность стадии (`costs/passport-durations.service.ts`),
  - «упаковано за период» и себестоимость
    (`costs/costs.service.ts`, `costs/production-cost-v2.service.ts`),
  - stage паспорта на экранах `/shopfloor` и `/dashboard`
    (`shopfloor/shopfloor.service.ts`, `dashboard/dashboard.service.ts`).
- Event-bus-а (NestJS `EventEmitter` / внешнего bus-а) в коде **нет**
  (`rg EventEmitter|event-emitter|EventBus` по `apps/api/src` не
  находит ничего). Все «события» пишутся в БД в одной транзакции с
  состоянием; последующие сервисы дёргаются явными вызовами или
  читают таблицы.

---

## 2. `PassportEventType`

Полный список значений enum (`prisma/schema.prisma::PassportEventType`,
строки 182–208):

```
CREATED
OPERATION_STARTED
OPERATION_FINISHED
MOVED
DEFECT_RECORDED
CELL_PLACED
CELL_REMOVED
ISSUED_TO_EMPLOYEE
OPERATION_SCAN
QC_PASSED
WTO_PASSED
PACKED
CANCELLED
```

Ниже по каждому значению — что именно написано **в runtime-коде**.
Если значение нигде не используется на запись, это явно отмечено.

Глобальный смысл «влияет ли на state»: имеется в виду изменение полей
`Passport.status` / `Passport.currentOperationId` /
`Passport.currentEmployeeId` / `Passport.currentCellId` /
`Passport.currentRouteStepIndex` / `Passport.qtyDefect` /
`Passport.qtyGood` в **той же транзакции**, где пишется `PassportEvent`.

### 2.1. `CREATED`

- **Кто пишет:** `PassportsService.create`
  (`apps/api/src/modules/passports/passports.service.ts:224`).
- **Когда:** помощник раскройщика подтвердил выпуск кроя
  (`POST /api/passports`). Первое событие для паспорта.
- **Payload:** `operationId = CUT_DIVISION`, `employeeId = creator.id`,
  `qty = dto.qtyCut`, `payload = { rollNumber, color }`.
- **Влияет ли на state:** ДА. В той же транзакции создаётся сам
  `Passport` со `status = CREATED`, `currentOperationId = CUT_DIVISION`,
  `currentEmployeeId = creator.id`, `currentRouteStepIndex = 0`
  (если у заказа есть `OrderRouteStep`).

### 2.2. `OPERATION_STARTED`

- **Кто пишет:** никто. В `apps/api/src/**` нет ни одного
  `passportEvent.create({ type: PassportEventType.OPERATION_STARTED })`
  (проверено `rg "PassportEventType\\.OPERATION_STARTED"` по `apps/api/src`).
- **Статус:** значение enum зарезервировано, но runtime-кодом не
  пишется. UNKNOWN, пишется ли оно где-то ещё — см. §Конец документа.

### 2.3. `OPERATION_FINISHED`

- **Кто пишет:** `PassportsService.completeOperationByEmployee`
  (`apps/api/src/modules/passports/passports.service.ts:939`).
- **Когда:** швея явно завершает свою операцию через повторный скан
  (`POST /api/passports/:id/complete-operation`). Источник истины для
  `operationId` — `ShiftSession.operationId`, а НЕ
  `passport.currentOperationId`
  (см. комментарий `passports.service.ts:817`).
- **Payload:** `operationId = session.operationId`,
  `fromOperationId = passport.currentOperationId`,
  `employeeId = actor`, `qty = passport.qtyGood`.
- **Влияет ли на state:** ДА. В той же транзакции
  `Passport.currentEmployeeId = null`, `currentCellId = null`,
  `currentOperationId = completedOperationId`, `currentRouteStepIndex`
  обновляется на завершённый шаг (если шаг найден в snapshot-маршруте).
  `Passport.status` НЕ меняется (остаётся `IN_PROGRESS`).

### 2.4. `MOVED`

- **Кто пишет:** никто. `rg "PassportEventType\\.MOVED"` по
  `apps/api/src` — пусто.
- **Статус:** значение enum зарезервировано, runtime-кодом не пишется.
  UNKNOWN — см. §Конец документа.

### 2.5. `DEFECT_RECORDED`

- **Кто пишет:** `QcService.recordDefect`
  (`apps/api/src/modules/qc/qc.service.ts:335`).
- **Когда:** ОТК фиксирует брак (`POST /api/qc/passports/:id/defects`)
  при `Passport.status = IN_PROGRESS`.
- **Payload:** `operationId = fresh.currentOperationId`,
  `employeeId = actor`, `qty = dto.qty`,
  `payload = { defectId, defectTypeId, defectTypeCode, defectTypeName, comment? }`.
- **Влияет ли на state:** ДА (частично). В той же транзакции
  инкрементится `Passport.qtyDefect` и декрементится `qtyGood`
  (`qc.service.ts:328`), создаётся строка `PassportDefect`.
  `Passport.status` / `currentOperationId` / `currentEmployeeId` НЕ
  меняются.
- **Важно:** `AuditLog` для этого события **не пишется** (в том же
  `$transaction` вызова `this.audit.log` нет). Это единственное
  «доменное» событие паспорта без парного `AuditLog`. См. §8.

### 2.6. `CELL_PLACED`

- **Кто пишет:** `PassportsService.place`
  (`apps/api/src/modules/passports/passports.service.ts:389`).
- **Когда:** помощник раскройщика кладёт паспорт в ячейку
  (`POST /api/passports/:id/place`).
- **Payload:** `cellId = cell.id`, `qty = passport.qtyCut`. `employeeId`
  не пишется (endpoint без активной смены, см. комментарий
  `passports.service.ts:397`).
- **Влияет ли на state:** ДА. В той же транзакции обновляется
  `Passport.currentCellId`, инкрементится/создаётся
  `CellContent.quantity`. `Passport.status` остаётся `CREATED`.

### 2.7. `CELL_REMOVED`

- **Кто пишет:** никто. `rg "PassportEventType\\.CELL_REMOVED"` по
  `apps/api/src` — пусто.
- **Статус:** значение enum зарезервировано, runtime-кодом не пишется.
  При `ISSUED_TO_EMPLOYEE` паспорт физически «снимается» с ячейки
  (`CellContent.quantity -= qtyCut`, `currentCellId = null`), но
  отдельного события `CELL_REMOVED` при этом НЕ пишется
  (`passports.service.ts:512-545`). UNKNOWN — см. §Конец документа.

### 2.8. `ISSUED_TO_EMPLOYEE`

- **Кто пишет:** `PassportsService.issueToEmployee` — две ветки:
  - legacy/буфер (паспорт в ячейке):
    `apps/api/src/modules/passports/passports.service.ts:536`;
  - route-WIP (без ячейки):
    `apps/api/src/modules/passports/passports.service.ts:618`.
- **Когда:** швея на активной смене получает крой
  (`POST /api/passports/:id/issue`).
- **Payload:**
  - `cellId = passport.currentCellId` (FROM_CELL) / `null` (ROUTE_WIP),
  - `operationId = session.operationId`,
  - `employeeId = actor`,
  - `qty = passport.qtyCut`.
- **Влияет ли на state:** ДА. В той же транзакции
  `Passport.status = IN_PROGRESS`, `currentEmployeeId = actor`,
  `currentCellId = null`. `currentOperationId` на этом шаге **не**
  меняется (см. комментарий `passports.service.ts:436`).
- **Гварды:** `SHIFT_SESSION_REQUIRED`; active cut-release policy
  (`PassportsService.evaluateCutReleasePolicyForIssue` →
  `CutReleasePolicyViolationException`).

### 2.9. `OPERATION_SCAN`

- **Кто пишет:** `PassportsService.scanOnOperation`
  (`apps/api/src/modules/passports/passports.service.ts:752`).
- **Когда:** любой скан паспорта на операции (`POST
  /api/passports/:id/scan`). Повторный скан того же паспорта на той же
  операции тем же сотрудником — no-op, событие не пишется
  (`passports.service.ts:715`).
- **Payload:** `operationId = session.operationId`,
  `fromOperationId = passport.currentOperationId` (до апдейта),
  `employeeId = actor`, `qty = passport.qtyGood`.
- **Влияет ли на state:** ДА. В той же транзакции
  `Passport.status = IN_PROGRESS`, `currentOperationId =
  session.operationId`, `currentEmployeeId = actor`,
  `currentRouteStepIndex` сдвигается, если операция есть в
  snapshot-маршруте (`passports.service.ts:735`).
- **Side-effect:** `EarningsService.createPendingForPreviousOperation`
  вызывается в той же транзакции (`passports.service.ts:767`) —
  pending-начисление предыдущему исполнителю.
- **QC-gate:** вход на операцию категории `IRONING` без существующего
  `PassportEvent(QC_PASSED)` отбивается
  `PassportNotQcPassedException` (`passports.service.ts:695-711`).

### 2.10. `QC_PASSED`

- **Кто пишет:** `QcService.completeQc`
  (`apps/api/src/modules/qc/qc.service.ts:231`).
- **Когда:** ОТК подтверждает проверку паспорта (`POST
  /api/qc/passports/:id/complete`) при `Passport.status = IN_PROGRESS`.
- **Payload:** `operationId = passport.currentOperationId`,
  `employeeId = actor`, `qty = passport.qtyGood`.
- **Влияет ли на state:** НЕТ. Event — аудит-маркер «ОТК прошло»
  (см. комментарий `schema.prisma:196-199`). `Passport.status` /
  `currentOperationId` / `currentEmployeeId` не меняются.
- **Читатели:** `PassportsService.scanOnOperation` (QC-gate для
  IRONING), `WtoService.assertQcPassed`
  (`apps/api/src/modules/wto/wto.service.ts:146`), shopfloor/dashboard
  (stage derivation).

### 2.11. `WTO_PASSED`

- **Кто пишет:** `WtoService.completeWto`
  (`apps/api/src/modules/wto/wto.service.ts:112`).
- **Когда:** сотрудник ВТО подтверждает обработку (`POST
  /api/wto/passports/:id/complete`). Требуется:
  - `Passport.status = IN_PROGRESS`,
  - `Passport.currentOperation.category = IRONING`,
  - существующий `PassportEvent(QC_PASSED)` (`wto.service.ts:98`).
- **Payload:** `operationId = passport.currentOperationId`,
  `employeeId = actor`, `qty = passport.qtyGood`.
- **Влияет ли на state:** НЕТ. Event — аудит-маркер «ВТО прошло»
  (см. комментарий `schema.prisma:200-205`).
- **Читатели:** shopfloor/dashboard для derived-стадии `WTO_DONE`.

### 2.12. `PACKED`

- **Кто пишет:** `PackingService.addPassport`
  (`apps/api/src/modules/packing/packing.service.ts:319`).
- **Когда:** упаковщик добавил паспорт в коробку (`POST
  /api/packing/boxes/:id/items`).
- **Payload:** `boxId = box.id`, `employeeId = actor`,
  `qty = fresh.qtyGood`.
- **Влияет ли на state:** ДА (терминально). В той же транзакции
  `Passport.status = PACKED`, `currentEmployeeId = null`,
  `currentCellId = null`. `currentOperationId` сознательно НЕ
  обнуляется (комментарий `packing.service.ts:312-314`).
- **Инвариант:** создаётся `BoxItem(boxId, passportId, qty)`,
  инкрементится `Box.totalQty`. Unique constraint на
  `BoxItem(boxId, passportId)` + проверка статуса.

### 2.13. `CANCELLED`

- **Кто пишет:** никто. `rg "PassportEventType\\.CANCELLED"` и
  `rg "status:\\s*PassportStatus\\.CANCELLED"` по `apps/api/src` —
  нет ни одного места записи в обеих формах (единственная ссылка
  `PassportStatus.CANCELLED` на запись — это `diagnostics.service.ts:246`,
  но это SELECT в проверке инвариантов, а не UPDATE).
- **Статус:** значение enum зарезервировано, runtime-кодом не пишется.
  `PassportStatus.CANCELLED` уже используется в read-guards
  (`passports.service.ts:1250`, `packing.service.ts:222`, и т.д.), но
  ни один сервис этот статус не выставляет. UNKNOWN — см. §Конец
  документа.

### 2.14. Сводная таблица

| Тип                   | Пишется?  | Writer                                               | Меняет `Passport.status`?         |
| --------------------- | --------- | ---------------------------------------------------- | --------------------------------- |
| `CREATED`             | ДА        | `PassportsService.create`                            | создаёт со `status = CREATED`     |
| `OPERATION_STARTED`   | НЕТ       | —                                                    | —                                 |
| `OPERATION_FINISHED`  | ДА        | `PassportsService.completeOperationByEmployee`       | нет (остаётся `IN_PROGRESS`)      |
| `MOVED`               | НЕТ       | —                                                    | —                                 |
| `DEFECT_RECORDED`     | ДА        | `QcService.recordDefect`                             | нет (меняет `qtyDefect`/`qtyGood`)|
| `CELL_PLACED`         | ДА        | `PassportsService.place`                             | нет (остаётся `CREATED`)          |
| `CELL_REMOVED`        | НЕТ       | —                                                    | —                                 |
| `ISSUED_TO_EMPLOYEE`  | ДА        | `PassportsService.issueToEmployee`                   | `CREATED → IN_PROGRESS`           |
| `OPERATION_SCAN`      | ДА        | `PassportsService.scanOnOperation`                   | `→ IN_PROGRESS`                   |
| `QC_PASSED`           | ДА        | `QcService.completeQc`                               | нет                               |
| `WTO_PASSED`          | ДА        | `WtoService.completeWto`                             | нет                               |
| `PACKED`              | ДА        | `PackingService.addPassport`                         | `→ PACKED` (терминально)          |
| `CANCELLED`           | НЕТ       | —                                                    | —                                 |

---

## 3. `AuditLog`

### 3.1. Схема и контракт

`prisma/schema.prisma::AuditLog` (строки 2045–2056):

```
model AuditLog {
  id         String   @id @default(cuid())
  event      String   // свободный код
  entityType String   // свободный тип агрегата
  entityId   String   // id агрегата (строкой, без FK)
  payload    Json
  employeeId String?  // кто инициировал (без FK)
  createdAt  DateTime @default(now())

  @@index([entityType, entityId])
  @@index([createdAt])
}
```

Точка записи — `AuditService.log(input, tx?)`
(`apps/api/src/modules/audit/audit.service.ts:229`):

- если передан `tx` — запись идёт в той же транзакции («либо и
  операция, и аудит, либо ничего», `audit.service.ts:241-247`);
- если `tx` не передан — fail-soft: ошибка глушится в WARN
  (`audit.service.ts:250-259`). Это сознательно оставлено для
  legacy-вызовов.

### 3.2. Допустимые `entityType`

Источник истины — тип `AuditEntityType`
(`apps/api/src/modules/audit/audit.service.ts:13-170`):

```
PASSPORT | ORDER | QC | WTO | PACKING |
MASTER_CALL | CUT_RELEASE_POLICY |
ORDER_CUT_ISSUE_RULE |
CLIENT | PATTERN | PATTERN_CATEGORY |
WORKSHOP_NEED | SUPPLIER |
PURCHASE_ORDER | PURCHASE_RECEIPT |
ORDER_APPLICATION | ORDER_COST_ESTIMATE |
ORDER_MATERIAL_ARRIVAL_OVERRIDE |
MATERIAL_ISSUE |
SIZE |
COMPANY_SETTINGS | COMPANY_DIVISION |
SALARY_ENTRY | PAYROLL_PAYOUT |
PAYROLL_ACCRUAL_DOCUMENT
```

<a id="33-salary-entry"></a>

### 3.3. Что именно логируется (собрано по `rg "event:\\s*'" apps/api/src`)

Полный список кодов событий, которые **реально пишутся** в
runtime-коде (не из комментариев/документации). Для каждого кода
указан writer (`*.service.ts` + метод).

#### Паспорта (`entityType = PASSPORT`)

- `PASSPORT_PLACED` — `PassportsService.place`
  (`passports.service.ts:403`). Парный с `PassportEvent(CELL_PLACED)`.
- `PASSPORT_ISSUED` — `PassportsService.issueToEmployee`, обе ветки:
  `passports.service.ts:550` (FROM_CELL), `passports.service.ts:632`
  (ROUTE_WIP). Парный с `PassportEvent(ISSUED_TO_EMPLOYEE)`.
  `payload.mode ∈ { FROM_CELL, ROUTE_WIP }`.
- `PASSPORT_SCANNED` — `PassportsService.scanOnOperation`
  (`passports.service.ts:780`). Парный с
  `PassportEvent(OPERATION_SCAN)`.
- `PASSPORT_OPERATION_COMPLETED` —
  `PassportsService.completeOperationByEmployee`
  (`passports.service.ts:953`). Парный с
  `PassportEvent(OPERATION_FINISHED)`. Payload содержит
  `before`/`after`-снэпшоты полей паспорта.
- `MASTER_PASSPORT_UNASSIGNED` — `MasterActionsService.unassign`
  (`master-actions.service.ts:94`). Управленческое действие мастера.
- `MASTER_PASSPORT_TRANSFERRED` — `MasterActionsService.transfer`
  (`master-actions.service.ts:196`).
- `MASTER_PASSPORT_RETURNED_TO_CELL` —
  `MasterActionsService.returnToCell` (`master-actions.service.ts:289`).
- `MASTER_PASSPORT_ROUTE_STEP_SET` — `MasterActionsService.setRouteStep`
  (`master-actions.service.ts:436`).

`PassportsService.create` **НЕ** пишет `PASSPORT_CREATED` в
`AuditLog` — только `PassportEvent(CREATED)`. `QcService.recordDefect`
тоже НЕ пишет `AuditLog` — только `PassportEvent(DEFECT_RECORDED)`.

#### Упаковка (`entityType = PACKING`, `entityId = Box.id`)

- `PASSPORT_PACKED` — `PackingService.addPassport`
  (`packing.service.ts:333`). Парный с `PassportEvent(PACKED)`.
- `BOX_CLOSED` — `PackingService.close` (`packing.service.ts:407`).
  Собственно парного `PassportEvent` нет — закрытие коробки это
  box-level действие; в payload летит список `passportIds` упакованных
  паспортов.

#### ОТК (`entityType = QC`, `entityId = passportId`)

- `QC_COMPLETED` — `QcService.completeQc` (`qc.service.ts:240`).
  Парный с `PassportEvent(QC_PASSED)`.
- `QcService.recordDefect` **не** пишет в `AuditLog` (см. выше).

#### ВТО (`entityType = WTO`, `entityId = passportId`)

- `WTO_COMPLETED` — `WtoService.completeWto` (`wto.service.ts:121`).
  Парный с `PassportEvent(WTO_PASSED)`.

#### Вызовы мастера (`entityType = MASTER_CALL`)

- `MASTER_CALLED` — `MasterCallsService.create`
  (`master-calls.service.ts:105`). Пишется только при реальном создании
  (идемпотентность: если `OPEN`-вызов уже есть, дубль не пишется).
- `MASTER_CALL_RESOLVED` — `MasterCallsService.resolveByEmployeeQr`
  (`master-calls.service.ts:227`).

#### Заказы поставщикам (`entityType = PURCHASE_ORDER`)

- `PURCHASE_ORDER_CREATED` — `PurchaseOrdersService.createFromNeeds`
  (`purchase-orders.service.ts:267`).
- `PURCHASE_ORDER_UPDATED` — `PurchaseOrdersService.update`
  (`purchase-orders.service.ts:339`).
- `PURCHASE_ORDER_LINE_UPDATED` — `PurchaseOrdersService.updateLine`
  (`purchase-orders.service.ts:437`).
- `PURCHASE_ORDER_SENT` — `PurchaseOrdersService.send`
  (`purchase-orders.service.ts:480`).
- `PURCHASE_ORDER_CONFIRMED` — `PurchaseOrdersService.confirm`
  (`purchase-orders.service.ts:568`).
- `PURCHASE_ORDER_CANCELLED` — `PurchaseOrdersService.cancel`
  (`purchase-orders.service.ts:658`).

#### Приёмки (`entityType = PURCHASE_RECEIPT`)

- `PURCHASE_RECEIPT_CREATED` —
  `PurchaseReceiptsService.createFromPurchaseOrder`
  (`purchase-receipts.service.ts:281`).
- `PURCHASE_RECEIPT_CANCELLED` — `PurchaseReceiptsService.cancel`
  (`purchase-receipts.service.ts:387`).

#### Material issues (`entityType = MATERIAL_ISSUE`, `entityId = MaterialIssue.id`)

Источник: `apps/api/src/modules/material-issues/material-issues.service.ts`,
`prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
`docs/api.md §«Material issues»`.

- `MATERIAL_ISSUE_CREATED` — пишется в двух сценариях:
  - `MaterialIssuesService.create` (ручной `POST /api/material-issues`)
    сразу после `materialIssue.create` в той же транзакции —
    `status: 'DRAFT'`, `source: 'MANUAL'`, `sourceKey: null`;
  - `MaterialIssuesService.createAutoCutIssueForPassport`
    (автосписание при `PassportsService.issueToEmployee`) —
    `status: 'POSTED'`, `source: 'AUTO_CUT_ISSUE'`,
    `sourceKey: 'AUTO_CUT_ISSUE:<passportId>'`. Payload дополнительно
    содержит `calculation = { totalOrderQty, passportQtyCut,
    formula: 'WorkshopNeed.calculatedQty * Passport.qtyCut / totalOrderQty' }`.
  Базовый payload (общий для обоих сценариев):
  `materialIssueId`, `orderId`, `passportId`, `status`, `source`,
  `sourceKey`, `totalCost`, `lines` (snapshot строк документа),
  `employeeId`, `timestamp`.
- `MATERIAL_ISSUE_POSTED` — пишется в двух сценариях:
  - `MaterialIssuesService.post` (`DRAFT → POSTED`) — `source:
    'MANUAL'`;
  - `MaterialIssuesService.createAutoCutIssueForPassport`
    (сразу после `MATERIAL_ISSUE_CREATED` — авто-документ
    проводится в той же транзакции) — `source: 'AUTO_CUT_ISSUE'`.
  Payload — те же поля, что у `MATERIAL_ISSUE_CREATED`, плюс
  `previousStatus: 'DRAFT'`.
- `MATERIAL_ISSUE_CANCELLED` — `MaterialIssuesService.cancel`
  (`DRAFT → CANCELLED`, только `source: 'MANUAL'`). Payload —
  те же поля + `previousStatus` и `cancelReason` (если передан).

Cancel для `POSTED`-документа в MVP запрещён
(`MaterialIssuePostedCannotCancelException`, 409). Запрос
возвращает ошибку без записи в `AuditLog` — это та же стратегия,
что и у `WorkshopNeedsService.update` для locked-строк.

Если автосписание skip-ается (повторный retry по `sourceKey`, уже
есть неотменённый документ по `passportId`, нет подходящей
`WorkshopNeed`, `totalOrderQty <= 0`) — audit-события **не
пишутся** (skip — это успешное отсутствие действия), только
structured-лог `event=material_issue.auto.skip reason=...` в
stdout сервиса.

#### Заказы покупателя (`entityType = ORDER` / `ORDER_COST_ESTIMATE`)

- `ORDER_CREATED` — `OrdersService.create`
  (`orders.service.ts`). Payload содержит `companyDivisionId` и
  `companyDivisionCode` (FK на master-справочник
  `CompanyDivision`). По журналу видно, к какому подразделению
  привязан заказ (см. `docs/domain.md §«Подразделения заказа»`).
- `ORDER_UPDATED` — `OrdersService.update`
  (`orders.service.ts`). Смена `companyDivisionId` попадает в
  `changedFields` — историю смены подразделения можно
  фильтровать по этому полю.
- `ORDER_PATTERN_CHANGED` — `OrdersService.update` при смене лекала
  (`orders.service.ts:1353`).
- `ORDER_OPERATION_PLAN_RECALCULATED` —
  `OrdersService.recalcOrderOperationPlan` (`orders.service.ts:922`).
- `ORDER_STARTED` — `OrdersService.start`
  (`orders.service.ts:1698`).
- `ORDER_PATTERN_SNAPSHOT_CREATED` — `OrdersService.start` и
  `OrdersService.startCalculation` (`orders.service.ts:1754`,
  `orders.service.ts:1961`).
- `ORDER_CALCULATION_STARTED` — `OrdersService.startCalculation`
  (`orders.service.ts:1934`).
- `ORDER_CALCULATION_COMPLETED` —
  `OrderCostEstimatesService.complete`
  (`order-cost-estimates.service.ts:281`).
- `ORDER_CALCULATION_REOPENED` —
  `OrderCostEstimatesService.reopen`
  (`order-cost-estimates.service.ts:376`).
- `ORDER_COST_ESTIMATE_CREATED` —
  `OrderCostEstimatesService.complete`
  (`order-cost-estimates.service.ts:262`).

`OrdersService.complete` (`orders.service.ts:1984`) и
`OrdersService.cancel` (`orders.service.ts:2001`) **НЕ** пишут
`AuditLog`. Статусы `OrderStatus.DONE` / `OrderStatus.CANCELLED`
ставятся без аудит-записи. UNKNOWN — см. §Конец документа.

#### Остальные модули

Эти модули пишут `AuditLog` по своим собственным действиям — они
важны для полноты картины, но выходят за рамки источников, перечисленных
в задаче. Значения `entityType` зафиксированы в `AuditEntityType`
(`audit.service.ts`):

- `CLIENT`, `PATTERN`, `PATTERN_CATEGORY`, `WORKSHOP_NEED`,
  `SUPPLIER`, `ORDER_APPLICATION`, `ORDER_MATERIAL_ARRIVAL_OVERRIDE`,
  `SIZE`, `CUT_RELEASE_POLICY` — см. соответствующие сервисы.
- `COMPANY_SETTINGS` — `CompanySettingsService.update`
  (`apps/api/src/modules/company-settings/company-settings.service.ts`):
  `COMPANY_SETTINGS_UPDATED` с `entityId = "default"` (singleton-id) и
  payload-снимком `{ changed: { <field>: { before, after }, … } }`.
  Пишется только когда реально что-то изменилось (idempotent PATCH с
  тем же значением аудит-строку не плодит).
- `COMPANY_DIVISION` —
  `CompanyDivisionsService.create` / `update`
  (`apps/api/src/modules/company-settings/company-divisions.service.ts`):
  `COMPANY_DIVISION_CREATED` / `COMPANY_DIVISION_UPDATED` с
  `entityId = CompanyDivision.id` и `before`/`after`-payload (для
  update). Soft-delete тоже идёт `COMPANY_DIVISION_UPDATED`
  (`isActive: false`), отдельного `*_DELETED` события нет.
- `SALARY_ENTRY` (PHASE 2 STEP 4) — `SalaryService.updateManually`
  (`apps/api/src/modules/salary/salary.service.ts`):
  - `SALARY_ENTRY_UPDATED` — менеджер изменил `amount` /
    `managerComment` через `PATCH /api/salary/:id`. Запись
    приобретает `editedManually = true`,
    `editedByEmployeeId = viewer`. Payload —
    `{ salaryEntryId, employeeId, date,
       before: { amount, managerComment, editedManually },
       after: { amount, managerComment, editedManually },
       reset: false, editedByEmployeeId }`.
  - `SALARY_ENTRY_RESET` — менеджер прислал `reset = true`.
    Запись возвращается под автоматический sync
    (`editedManually = false`, `managerComment = null`,
    `editedByEmployeeId = null`,
    `amount = employee.salaryPerShift`). Payload — тот же набор
    полей с `reset: true` и сброшенными `after.*`.

  `entityId = SalaryEntry.id`. Автоматический `syncDailySalary`
  (вызывается на `start/stop shift` из `ShiftsService`) аудит
  **не** пишет — это сознательно (см. JSDoc
  `SalaryService.updateManually` и ТЗ STEP 4 «не зашумлять журнал»).
  Никаких новых таблиц истории не заводим — `SalaryEntry` модель
  не меняется.
- `CUT_RELEASE_POLICY_CONSUMED` — пишется в транзакции
  `PassportsService.issueToEmployee` (через
  `consumeCutReleasePolicyInTx`, `passports.service.ts:1223`) при
  активной политике выдачи кроя.
- `ORDER_CUT_ISSUE_RULE_*` — «очередь выдачи кроя по размерам внутри
  заказа» (`apps/api/src/modules/order-cut-issue-rules/*`,
  `prisma/schema.prisma::OrderCutIssueRule`):
  - `ORDER_CUT_ISSUE_RULE_UPSERT` — менеджер сохранил bulk-форму
    карточки заказа (заведено/обновлено/деактивировано N строк),
    `entityId = orderId`, payload содержит `rowsCount`,
    `deactivatedCount`, список после сохранения.
  - `ORDER_CUT_ISSUE_RULE_DISABLED` — менеджер нажал «Отключить
    очередь» (`isActive = false` для всех строк заказа). Если
    активных не было — событие не пишется (идемпотентность).
  - `ORDER_CUT_ISSUE_RULE_CONSUMED` — атомарный инкремент
    `issuedQty` в той же транзакции, что и
    `PassportsService.issueToEmployee`. `entityId =
    OrderCutIssueRule.id`, payload содержит `passportId` /
    `qty` / `beforeIssued` / `afterIssued` / `sizeCode` /
    `orderId`.

<a id="33b-payroll-payout"></a>

#### Выплаты зарплаты (`entityType = PAYROLL_PAYOUT`)

Источник: `apps/api/src/modules/payroll-payouts/payroll-payouts.service.ts`,
[`docs/api.md §«Payroll payouts»`](./api.md#30b-payroll-payouts),
`prisma/schema.prisma::PayrollPayout`. Все события пишутся в той же
транзакции, что и соответствующая мутация. `entityId =
PayrollPayout.id`. `employeeId` события (см. `AuditLogInput`) — это
`viewer.employeeId` (кто нажал кнопку); `payload.employeeId` —
сотрудник-получатель (для CREATE/RECOMPUTE/ISSUE/CANCEL это разные
люди, для ACKNOWLEDGED — один и тот же).

- `PAYROLL_PAYOUT_CREATED` — `PayrollPayoutsService.create`.
  `POST /api/payroll/payouts` создал черновик. Payload —
  `{ payoutId, employeeId, periodFrom, periodTo,
  amountPieceworkRub, amountSalaryRub, amountTotalRub, lineCount,
  createdById }`.
- `PAYROLL_PAYOUT_LINES_RECOMPUTED` —
  `PayrollPayoutsService.recompute`. `POST /…/recompute` пересобрал
  строки `DRAFT`-выплаты. Payload —
  `{ payoutId, employeeId, periodFrom, periodTo,
  before:{ amountTotalRub, lineCount },
  after:{ amountTotalRub, lineCount } }`.
- `PAYROLL_PAYOUT_ISSUED` — `PayrollPayoutsService.issue`.
  `POST /…/issue` перевёл `DRAFT → ISSUED` (внутри транзакции
  выполнен `recompute`). Payload —
  `{ payoutId, employeeId, periodFrom, periodTo, amountTotalRub,
  lineCount, issuedById, issuedAt }`.
- `PAYROLL_PAYOUT_ACKNOWLEDGED` — `PayrollPayoutsService.ack`.
  `POST /…/ack` перевёл `ISSUED → ACKNOWLEDGED`. Подтверждать имеет
  право только сам сотрудник-получатель — иначе сервис отдаёт 403
  `PAYROLL_PAYOUT_FORBIDDEN_ACK` без записи аудита. Повторный `ack`
  по уже `ACKNOWLEDGED`-выплате тем же владельцем — идемпотентен и
  тоже **не** пишет аудит. Payload —
  `{ payoutId, employeeId, acknowledgedByEmployeeId,
  amountTotalRub }`.
- `PAYROLL_PAYOUT_CANCELLED` — `PayrollPayoutsService.cancel`.
  `POST /…/cancel` перевёл `DRAFT|ISSUED → CANCELLED`. `ACKNOWLEDGED`
  отменить нельзя — сервис отдаст 409 `PAYROLL_PAYOUT_INVALID_TRANSITION`.
  Payload — `{ payoutId, employeeId, fromStatus, cancelledById,
  cancelReason }`.

`OperationEntry` / `SalaryEntry` сервис **не** меняет — статус
выплаты живёт исключительно в `PayrollPayout`. Активная уникальность
строк (одна `OperationEntry` / `SalaryEntry` — максимум в одной
не-`CANCELLED` выплате) проверяется в `rebuildLines` и при конфликте
бросает 422 `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED` — отдельного
события для этого нет (бизнес-операция отбивается до записи
аудита).

<a id="34-payroll_accrual_document"></a>

#### Документ начисления зарплаты (`entityType = PAYROLL_ACCRUAL_DOCUMENT`)

`entityId = PayrollAccrualDocument.id`. Источник —
`apps/api/src/modules/payroll-accrual-documents/payroll-accrual-documents.service.ts`.
Все события пишутся в той же транзакции, что и соответствующая мутация
(передаётся `tx` в `AuditService.log`).

- `PAYROLL_ACCRUAL_DOCUMENT_CREATED` — `PayrollAccrualDocumentsService.create`.
  Менеджер создал DRAFT через `POST /api/payroll/accrual-documents`.
  Payload — `{ documentId, accrualDate, linesCount, totalToPayRub, createdById }`.

- `PAYROLL_ACCRUAL_DOCUMENT_RECOMPUTED` — `PayrollAccrualDocumentsService.recompute`.
  Пересчитаны строки DRAFT (`POST /…/:id/recompute`); `manualAdjustRub` /
  `manualComment` сохранены.
  Payload — `{ documentId, accrualDate, before: { linesCount, totalToPayRub },
  after: { linesCount, totalToPayRub } }`.

- `PAYROLL_ACCRUAL_DOCUMENT_LINE_UPDATED` — `PayrollAccrualDocumentsService.updateLine`.
  Менеджер скорректировал строку (`PATCH /…/:id/lines/:lineId`).
  Payload — `{ documentId, lineId, employeeId,
  before: { manualAdjustRub, amountToPayRub },
  after: { manualAdjustRub, amountToPayRub } }`.

- `PAYROLL_ACCRUAL_DOCUMENT_PAID` — `PayrollAccrualDocumentsService.pay`.
  Документ проведён (`POST /…/:id/pay`): `DRAFT → PAID`; созданы
  `PayrollPayout` ISSUED для каждой строки с `amountToPayRub > 0`.
  Payload — `{ documentId, accrualDate, payoutsCreated, totalToPayRub,
  paidById, paidAt }`.

- `PAYROLL_ACCRUAL_DOCUMENT_CANCELLED` — `PayrollAccrualDocumentsService.cancel`.
  Черновик отменён (`POST /…/:id/cancel`): `DRAFT → CANCELLED`.
  Payload — `{ documentId, accrualDate, cancelledById, cancelReason,
  cancelledAt }`.

**Ограничение STEP 6.2 (`manualAdjustRub`).** Если строка документа
имеет `manualAdjustRub ≠ 0`, а `PayrollPayoutLineKind` не содержит
`ADJUSTMENT`, проводка блокируется 409
`PAYROLL_ACCRUAL_MANUAL_ADJUST_NOT_SUPPORTED` — аудит `PAID` не пишется.
Расширение enum — STEP 6.3/6.4.

<a id="33a-payroll-phase-1-read-only"></a>

### 3.3a. Payroll PHASE 1 — read-only, без AuditLog

Источник: `apps/api/src/modules/payroll/*`,
[`docs/api.md §10c`](./api.md#30a-payroll),
[`docs/domain.md §10.6`](./domain.md#106-payroll-phase-1-read-only).

Управленческий блок «Зарплата» в PHASE 1 сознательно read-only:
сервис `PayrollService` ничего не пишет ни в БД, ни в `AuditLog`.
Журналировать здесь нечего — это GET-агрегатор поверх уже
существующих `OperationEntry` / `SalaryEntry` / `ShiftSession`,
которые сами пишут свой `PassportEvent` / `AuditLog` (см. §2 и
§3.3 выше).

В частности:

- `GET /api/payroll/period`, `/daily`, `/employees/:id` —
  никаких записей в `AuditLog`;
- никаких новых `PassportEventType` / `AuditEntityType`;
- никаких новых событий «начислено/откачено/закрыт период» —
  это область PHASE 2.

UI-роуты `/admin/payroll/*` тоже не дёргают мутирующих ручек
(см. `apps/web/lib/payroll-api.ts`: только три GET-вызова).

### 3.4. Чем отличается от `PassportEvent`

| Ось                    | `PassportEvent`                                     | `AuditLog`                                              |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Тип                    | enum `PassportEventType` (schema-level)             | свободная строка (schema-level `event String`)          |
| Агрегат                | только `Passport` (FK `passportId`)                 | любой агрегат (`entityType/entityId` строкой, без FK)   |
| Бизнес-логика читает   | да (guard QC→IRONING, stage derivation, earnings)   | нет (только UI/ретроспектива)                           |
| FK на актора           | `employeeId` → `Employee` (FK, `onDelete`?)         | `employeeId?` строкой, без FK                           |
| Индексы                | `(passportId,createdAt)`, `(type,createdAt)`, `(operationId,createdAt)` | `(entityType,entityId)`, `(createdAt)`    |
| Покрытие кодом         | 9 из 13 значений enum пишутся                       | расширяется без миграции, ~30 event-кодов в коде        |

---

## 4. Master events (вызовы мастера цеха)

### 4.1. Модель

`prisma/schema.prisma::MasterCall` (строки 2112–2131) — карточка
вызова:

```
id, employeeId (инициатор),
equipmentId?, operationId? — копия с активной ShiftSession на
                              момент создания,
status MasterCallStatus @default(OPEN),
message?, createdAt, resolvedAt?, resolvedById?
```

Жизненный цикл — enum `MasterCallStatus`
(`prisma/schema.prisma:93-97`): `OPEN | RESOLVED | CANCELLED`.

### 4.2. Переходы (в коде)

Сервис — `MasterCallsService`
(`apps/api/src/modules/master-calls/master-calls.service.ts`).

- **`OPEN`** — выставляется по default-у, когда рабочий нажал «Мастер»
  (`create(...)`, `master-calls.service.ts:73`). Идемпотентно: если у
  сотрудника уже есть `OPEN`-вызов, он возвращается без изменений,
  новая строка и `AuditLog` не создаются (`master-calls.service.ts:79-87`).
  Пишется `AuditLog(MASTER_CALLED)` только при реальном создании
  (`master-calls.service.ts:105`).
- **`RESOLVED`** — `resolveByEmployeeQr(...)`
  (`master-calls.service.ts:179`) при сканировании мастером QR
  сотрудника. Выставляются `status = RESOLVED`, `resolvedAt = now()`,
  `resolvedById = actor.employeeId`. Пишется
  `AuditLog(MASTER_CALL_RESOLVED)` (`master-calls.service.ts:227`).
- **`CANCELLED`** — значение enum зарезервировано, но **ни один
  сервис его не выставляет**. Комментарий в schema
  (`prisma/schema.prisma:89-91`): «зарезервирован для будущих
  сценариев, на MVP не используется». UNKNOWN — см. §Конец документа.

### 4.3. `PassportEvent` при вызовах мастера

Нет. Вызов мастера — action над самим сотрудником, не над паспортом.
Привязанные к мастеру действия над паспортами (`unassign`, `transfer`,
`returnToCell`, `setRouteStep`) выполняются **отдельным** сервисом
`MasterActionsService` и пишутся **только** в `AuditLog` (§3.3,
раздел «Паспорта»). `PassportEvent` при master-actions НЕ пишется.

---

## 5. Order events (заказы покупателя)

### 5.1. Модель и статусы

`prisma/schema.prisma::Order` + enum `OrderStatus`
(`prisma/schema.prisma:117-142`):

```
DRAFT → CALCULATION → CALCULATION_DONE → IN_PRODUCTION → DONE
                                                    ↘  CANCELLED
```

### 5.2. Переходы (в коде)

Все переходы живут в `OrdersService`
(`apps/api/src/modules/orders/orders.service.ts`) и
`OrderCostEstimatesService`
(`apps/api/src/modules/orders/order-cost-estimates.service.ts`).

| Переход                                   | Writer                                              | AuditLog event                          |
| ----------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| (insert) `DRAFT`                          | `OrdersService.create`                              | `ORDER_CREATED`                         |
| `DRAFT → CALCULATION`                     | `OrdersService.startCalculation`                    | `ORDER_CALCULATION_STARTED`             |
| `CALCULATION → CALCULATION_DONE`          | `OrderCostEstimatesService.complete`                | `ORDER_CALCULATION_COMPLETED` (+ `ORDER_COST_ESTIMATE_CREATED`) |
| `CALCULATION_DONE → CALCULATION`          | `OrderCostEstimatesService.reopen`                  | `ORDER_CALCULATION_REOPENED`            |
| `{DRAFT,CALCULATION,CALCULATION_DONE} → IN_PRODUCTION` | `OrdersService.start`                     | `ORDER_STARTED`                         |
| `IN_PRODUCTION → DONE`                    | `OrdersService.complete` (`orders.service.ts:1984`) | **нет `AuditLog`**                      |
| `* → CANCELLED`                           | `OrdersService.cancel`  (`orders.service.ts:2001`)  | **нет `AuditLog`**                      |

Дополнительные `AuditLog`-события по заказу, которые **не** меняют
статус:
- `ORDER_UPDATED` — редактирование полей заказа
  (`orders.service.ts:1327`);
- `ORDER_PATTERN_CHANGED` — смена лекала
  (`orders.service.ts:1353`);
- `ORDER_PATTERN_SNAPSHOT_CREATED` — фиксация snapshot-а лекала в
  `start`/`startCalculation` (`orders.service.ts:1754`,
  `orders.service.ts:1961`);
- `ORDER_OPERATION_PLAN_RECALCULATED` — пересчёт плана операций
  (`orders.service.ts:922`).

### 5.3. `PassportEvent` и «calculation done»

`PassportEvent` НЕ пишется при переходах статуса заказа. «Calculation
done» — это `AuditLog(ORDER_CALCULATION_COMPLETED)` +
`AuditLog(ORDER_COST_ESTIMATE_CREATED)` + вставка
`OrderCostEstimate` в БД. Паспорты на этот переход не создаются и
не обновляются.

Фактический «запуск» заказа (`ORDER_STARTED`) тоже не создаёт
паспортов — `Passport` создаются позже, через
`PassportsService.create` из помощника раскройщика. Связь
«паспорт → заказ» односторонняя (`Passport.orderId`).

### 5.4. UNKNOWN

Ни в `PassportEvent`, ни в `AuditLog` нет записи о переходах
`IN_PRODUCTION → DONE` и `* → CANCELLED` заказа — см. §Конец
документа.

---

## 6. Procurement events (PO / PR)

### 6.1. `PurchaseOrder`

Модель — `prisma/schema.prisma::PurchaseOrder` (строки 3105–3168).
`status` хранится как свободная строка (комментарий
`schema.prisma:3091-3102`): `DRAFT | SENT | CONFIRMED | CANCELLED`
(+ `RECEIVED` / `PARTIALLY_RECEIVED`, см. логику
`PurchaseReceiptsService.recalcAfterChange`).

Сервис — `PurchaseOrdersService`
(`apps/api/src/modules/purchase-orders/purchase-orders.service.ts`).
Переходы (с записью в `AuditLog`):

| Переход                                   | Writer                                   | AuditLog event             |
| ----------------------------------------- | ---------------------------------------- | -------------------------- |
| (insert) `DRAFT`                          | `createFromNeeds`                        | `PURCHASE_ORDER_CREATED`   |
| field-level update (`comment`/`expectedDeliveryDate`/`status`) | `update`       | `PURCHASE_ORDER_UPDATED`   |
| line-level update                         | `updateLine`                             | `PURCHASE_ORDER_LINE_UPDATED` |
| `DRAFT → SENT`                            | `send`                                   | `PURCHASE_ORDER_SENT`      |
| `{DRAFT,SENT} → CONFIRMED`                | `confirm`                                | `PURCHASE_ORDER_CONFIRMED` |
| `{DRAFT,SENT,CONFIRMED} → CANCELLED`      | `cancel`                                 | `PURCHASE_ORDER_CANCELLED` |

Side-effect-ы в транзакциях PO-переходов
(`purchase-orders.service.ts`):
- `createFromNeeds` → связанные `WorkshopNeed.status = ORDERED`
  (`purchase-orders.service.ts:262-265`);
- `cancel` → строки PO → `CANCELLED`, по каждому `WorkshopNeed`
  проверяется, нет ли ещё активных строк PO; если нет — возвращаем
  `WorkshopNeed.status = PURCHASE_PLANNED`
  (`purchase-orders.service.ts:631-655`).

`PassportEvent` при операциях с `PurchaseOrder` НЕ пишется
(паспортов в этом контуре нет).

### 6.2. `PurchaseReceipt`

Модель — `prisma/schema.prisma::PurchaseReceipt` (строки 3280–3342).
`status` — свободная строка: `POSTED | CANCELLED`.

Сервис — `PurchaseReceiptsService`
(`apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts`).

| Переход                     | Writer                                   | AuditLog event              |
| --------------------------- | ---------------------------------------- | --------------------------- |
| (insert) `POSTED`           | `createFromPurchaseOrder`                | `PURCHASE_RECEIPT_CREATED`  |
| `POSTED → CANCELLED`        | `cancel`                                 | `PURCHASE_RECEIPT_CANCELLED`|

Side-effect-ы в транзакциях PR
(`recalcAfterChange`,
`purchase-receipts.service.ts:416-...`):
- пересчёт `PurchaseOrderLine.status`
  (`SENT`/`CONFIRMED` → `PARTIALLY_RECEIVED`/`RECEIVED`) по сумме
  `receivedQty` активных `PurchaseReceiptLine`;
- пересчёт `PurchaseOrder.status` (заголовка) — `RECEIVED` /
  `PARTIALLY_RECEIVED` / откат в `SENT`/`CONFIRMED`;
- пересчёт `WorkshopNeed.status`.

Отдельных `AuditLog`-событий на эти авто-переходы **не** пишется —
источник истины только `PURCHASE_RECEIPT_CREATED` /
`PURCHASE_RECEIPT_CANCELLED`. UNKNOWN — см. §Конец документа.

`PassportEvent` при операциях с `PurchaseReceipt` НЕ пишется.

---

## 7. Print events

### 7.1. Модель

`prisma/schema.prisma::PrintJob` (строки 1608–1629):

```
id, printerId (FK, onDelete Cascade),
sourceType  PrintJobSource,      // enum: PASSPORT_QR | PASSPORT_PRINT |
                                 //       BOX_LABEL | CELL_QR | CELL_LABEL | TEST
sourceId?,
payloadUrl  String,
status      PrintJobStatus @default(PENDING),   // PENDING | PRINTED | FAILED
errorMessage?,
createdAt, completedAt?
```

Enum-ы:
- `PrintJobStatus` (`schema.prisma:298-302`): `PENDING | PRINTED | FAILED`;
- `PrintJobSource` (`schema.prisma:360-372`): источник payload-а.

### 7.2. Lifecycle

Сервис — `PrintJobsService`
(`apps/api/src/modules/printers/print-jobs.service.ts`).

| Переход               | Writer                                           | Примечание                              |
| --------------------- | ------------------------------------------------ | --------------------------------------- |
| (insert) `PENDING`    | `createForUser` (`print-jobs.service.ts:38`) / `createBatch` (`print-jobs.service.ts:77`) | payload-URL собирается через `buildPayloadUrl` (маппинг `sourceType → /api/.../print|qr|label`, `print-jobs.service.ts:281`) |
| `PENDING → PRINTED`   | `updateStatus` (`print-jobs.service.ts:153`)     | агент патчит, фиксируется `completedAt = now()` |
| `PENDING → FAILED`    | `updateStatus` (`print-jobs.service.ts:153`)     | агент сохраняет `errorMessage`          |

Нельзя закрыть уже закрытый job — `PrintJobAlreadyClosedException`
(`print-jobs.service.ts:161`). Ретраев нет, повторная печать = новый
`PrintJob` (комментарий `schema.prisma:296-297`).

### 7.3. Agent interaction

- Агент опрашивает очередь через `pollForAgent(printerId)`
  (`print-jobs.service.ts:140`): возвращает один `PENDING`-job
  (FIFO по `createdAt`), одновременно бьёт heartbeat принтера
  (`this.printers.heartbeat(printerId)`). Статус самого job-а на
  этом шаге НЕ меняется.
- Агент патчит результат: `PATCH /api/print-jobs/:id`
  (`print-jobs.controller.ts:111`), авторизация через
  `AgentAuthGuard` + `X-Printer-Agent-Token`.

### 7.4. Audit / event-trail

`PrintJob` — операционная сущность. Ни `AuditLog`, ни `PassportEvent`
на его переходы не пишутся (`rg "audit\\.log"` в
`apps/api/src/modules/printers` — пусто). История хранится в самой
таблице `PrintJob` (`createdAt`, `completedAt`, `status`,
`errorMessage`).

---

## 8. Граница: event vs audit

### 8.1. Что считается бизнес-событием (`PassportEvent`)

Значения enum `PassportEventType`, которые пишутся из кода (см. §2):
`CREATED`, `OPERATION_FINISHED`, `DEFECT_RECORDED`, `CELL_PLACED`,
`ISSUED_TO_EMPLOYEE`, `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`,
`PACKED`.

Признаки «бизнес-события» в этой системе (по факту кода):
- enum-значение в `PassportEventType` (schema-level, нельзя опечататься);
- читается бизнес-логикой: guard QC→IRONING
  (`passports.service.ts:706`, `wto.service.ts:147`); derived stage на
  `/shopfloor` и `/dashboard`; расчёт длительностей стадий
  (`costs/passport-durations.service.ts`); расчёт «упаковано за
  период» (`costs/costs.service.ts`); pending-начисление в
  `OPERATION_SCAN` (через `sourceEventId`, `passports.service.ts:774`);
- пишется только тогда, когда реально меняется физический факт по
  паспорту — выдан крой, состоялся скан, зафиксирован брак, упакован.

### 8.2. Что считается «просто логом» (`AuditLog`)

Всё остальное. Признаки по коду:
- свободная строка `event` — новые коды добавляются без миграции БД;
- `entityType` — любой агрегат, включая не-паспортные (`ORDER`,
  `PURCHASE_ORDER`, `MASTER_CALL`, `CUT_RELEASE_POLICY`,
  `ORDER_CUT_ISSUE_RULE`, `PATTERN`,
  `CLIENT`, …);
- `payload` — произвольный JSON-срез, часто с
  `before`/`after`/`changedFields`;
- **НЕ** читается бизнес-логикой ни в одном месте (проверено `rg
  "prisma\\.auditLog\\.findFirst|prisma\\.auditLog\\.findMany|tx\\.auditLog\\.find"`
  по `apps/api/src` — записи есть, чтения бизнес-логикой нет; только
  запись).

### 8.3. Где они пересекаются

В модуле `passports` / `qc` / `wto` / `packing` одно и то же
действие часто пишет **обе** записи в одной транзакции:

| Действие                      | `PassportEvent`              | `AuditLog` event                 |
| ----------------------------- | ---------------------------- | -------------------------------- |
| поставить паспорт в ячейку    | `CELL_PLACED`                | `PASSPORT_PLACED`                |
| выдать швее                   | `ISSUED_TO_EMPLOYEE`         | `PASSPORT_ISSUED` (+`mode`)      |
| скан на операции              | `OPERATION_SCAN`             | `PASSPORT_SCANNED`               |
| швея завершила операцию       | `OPERATION_FINISHED`         | `PASSPORT_OPERATION_COMPLETED`   |
| ОТК подтвердил                | `QC_PASSED`                  | `QC_COMPLETED`                   |
| ВТО подтвердил                | `WTO_PASSED`                 | `WTO_COMPLETED`                  |
| упаковали паспорт в коробку   | `PACKED`                     | `PASSPORT_PACKED`                |

Асимметрии (тоже зафиксированы в коде):

- **Создание паспорта** пишет только `PassportEvent(CREATED)`, без
  `AuditLog` (`passports.service.ts:224-236`).
- **Фиксация брака** пишет только `PassportEvent(DEFECT_RECORDED)` +
  `PassportDefect`, без `AuditLog` (`qc.service.ts:335-350`).
- **Закрытие коробки** (`BOX_CLOSED`) и **master-actions**
  (`MASTER_PASSPORT_*`) пишут только `AuditLog`, без `PassportEvent`.
- **Вызовы мастера** (`MASTER_CALLED`, `MASTER_CALL_RESOLVED`) пишут
  только `AuditLog`, без `PassportEvent` (паспорт тут не меняется).
- **Заказы поставщикам и приёмки** живут полностью в `AuditLog` —
  `PassportEvent` для них не существует.

---

## 9. Event Invariants

Раздел собран от кода. Каждый инвариант — это правило, на которое
полагаются другие участки системы (бизнес-логика, аудит, расчёт
зарплаты, дашборды). Для каждого зафиксировано: где он обеспечивается
(сервис + метод) и нарушается ли он где-либо в `apps/api/src`. Где
гарантия не транзакционная или не полная — стоит пометка `WARNING`.

### 9.1. Атомарность: `PassportEvent` пишется в той же транзакции, что и изменение состояния паспорта

- **Описание.** Любое изменение «горячих» полей паспорта
  (`Passport.status` / `currentOperationId` / `currentEmployeeId` /
  `currentCellId` / `currentRouteStepIndex` / `qtyDefect` / `qtyGood`)
  должно сопровождаться записью соответствующего `PassportEvent` в
  той же транзакции. Это нужно, чтобы поток событий невозможно было
  «обогнать» состоянием (и наоборот): аналитика длительностей
  (`costs/passport-durations.service.ts`), guard QC→IRONING
  (`passports.service.ts:702-711`), pending-начисления
  (`OPERATION_SCAN.id` ⇢ `OperationEntry.sourceEventId`,
  `passports.service.ts:752-775`) — все читают `PassportEvent` и
  предполагают, что он отражает реальное состояние.
- **Где обеспечивается.** Все writer-ы `PassportEvent` (см. §2)
  обёрнуты в `prisma.$transaction`:
  - `PassportsService.create` (`passports.service.ts:188-250`,
    `tx.passport.create` + `tx.passport.update(qrCode)` +
    `tx.passportEvent.create(CREATED)`);
  - `PassportsService.place` (`passports.service.ts:361-417`,
    `tx.passport.update(currentCellId)` +
    `tx.passportEvent.create(CELL_PLACED)`);
  - `PassportsService.issueToEmployee`, обе ветки
    (`passports.service.ts:512-571` legacy/буфер,
    `passports.service.ts:610-652` route-WIP) —
    `tx.passport.update(status=IN_PROGRESS, ...)` +
    `tx.passportEvent.create(ISSUED_TO_EMPLOYEE)`;
  - `PassportsService.scanOnOperation`
    (`passports.service.ts:742-796`) —
    `tx.passport.update(currentOperationId, currentEmployeeId,
    status, currentRouteStepIndex)` +
    `tx.passportEvent.create(OPERATION_SCAN)`;
  - `PassportsService.completeOperationByEmployee`
    (`passports.service.ts:929-968`) —
    `tx.passport.update(currentEmployeeId=null, ...)` +
    `tx.passportEvent.create(OPERATION_FINISHED)`;
  - `QcService.recordDefect` (`qc.service.ts:300-351`) —
    `tx.passport.update(qtyDefect/qtyGood)` +
    `tx.passportDefect.create` +
    `tx.passportEvent.create(DEFECT_RECORDED)`;
  - `PackingService.addPassport` (`packing.service.ts:233-355`) —
    `tx.passport.update(status=PACKED, ...)` + `tx.boxItem.create` +
    `tx.box.update(totalQty)` +
    `tx.passportEvent.create(PACKED)`.
- **WARNING — частичное нарушение в `MasterActionsService`.**
  Сервис меняет «горячие» поля паспорта, но `PassportEvent` НЕ
  пишет — только `AuditLog`. Это сознательная асимметрия (см. §8.3),
  но формально инвариант №9.1 в этих транзакциях не выполняется:
  - `MasterActionsService.unassign`
    (`master-actions.service.ts:78-100`): меняет `currentEmployeeId
    = null`. Без `PassportEvent`.
  - `MasterActionsService.transfer`
    (`master-actions.service.ts:184-213`): меняет `status =
    IN_PROGRESS`, `currentEmployeeId`, `currentCellId = null`,
    `currentOperationId`, `currentRouteStepIndex`. Без
    `PassportEvent`.
  - `MasterActionsService.returnToCell`
    (`master-actions.service.ts:255-309`): меняет `currentCellId`,
    `currentEmployeeId = null`. Без `PassportEvent`.
  - `MasterActionsService.setRouteStep`
    (`master-actions.service.ts:415-440`, transaction): меняет
    `currentOperationId`, `currentRouteStepIndex`,
    `currentEmployeeId = null`, `currentCellId`, `status =
    IN_PROGRESS`. Без `PassportEvent`.

  То есть для master-actions источником истины «что произошло с
  паспортом» становится только `AuditLog(MASTER_PASSPORT_*)`. Все
  читатели `PassportEvent` (durations, stage derivation,
  shopfloor-projection) этих изменений в потоке событий **не
  увидят**.

### 9.2. `PACKED` ⟺ `Passport.status = PACKED` (терминальная семантика)

- **Описание.** Если по паспорту существует `PassportEvent(PACKED)`,
  то его `Passport.status = PACKED`. И наоборот: единственный путь
  получить `Passport.status = PACKED` — это `addPassport`, который в
  той же транзакции пишет `PACKED`-событие.
- **Где обеспечивается.** `PackingService.addPassport`
  (`packing.service.ts:308-327`): `tx.passport.update({ status:
  PACKED, currentEmployeeId: null, currentCellId: null })` сразу
  сопровождается `tx.passportEvent.create({ type: PACKED, boxId,
  qty })`. Других writer-ов `Passport.status = PACKED` в
  `apps/api/src` нет (`rg "status:\s*PassportStatus\.PACKED"` —
  ровно один матч в `packing.service.ts:311`).
- **Нарушений в коде нет.**

### 9.3. `QC_PASSED` не меняет состояние паспорта

- **Описание.** Запись `PassportEvent(QC_PASSED)` — чисто
  аудит-маркер «ОТК подтвердил проверку». Она НЕ меняет
  `Passport.status`, `currentOperationId`, `currentEmployeeId`,
  `currentCellId`, `currentRouteStepIndex`, `qtyDefect`/`qtyGood`.
  Этот инвариант явно используется UI ОТК-терминала
  (`qcCompletedAt = lastQcPassed.createdAt`,
  `qc.service.ts:447`) и читателями stage-derivation: «было ли ОТК»
  отвечает событие, не статус.
- **Где обеспечивается.** `QcService.completeQc`
  (`qc.service.ts:200-259`): внутри `prisma.$transaction` —
  единственная мутация состояния это `tx.passportEvent.create({
  type: QC_PASSED })` плюс `tx.auditLog.create(QC_COMPLETED)`. Ни
  одного `tx.passport.update` в теле метода нет.
- **Нарушений в коде нет.**

### 9.4. `WTO_PASSED` не меняет состояние паспорта

- **Описание.** Полный аналог §9.3 для ВТО. `WTO_PASSED` — это
  чисто аудит-маркер, паспорт остаётся `IN_PROGRESS` на той же
  ironing-операции; следующее физическое движение — отдельный
  `OPERATION_SCAN` (упаковщиком/складом) или `addPassport`
  (упаковка).
- **Где обеспечивается.** `WtoService.completeWto`
  (`wto.service.ts:77-140`): внутри `prisma.$transaction` пишутся
  только `tx.passportEvent.create({ type: WTO_PASSED })` и
  `tx.auditLog.create(WTO_COMPLETED)`. `tx.passport.update`
  отсутствует.
- **Дополнительный sub-инвариант:** `WTO_PASSED` невозможен без
  существующего `QC_PASSED`. Обеспечивается двумя независимыми
  чеками:
  - `WtoService.assertQcPassed` (`wto.service.ts:98, 146-152`) —
    кидает `PassportNotQcPassedException`, если по паспорту нет
    `PassportEvent(QC_PASSED)`;
  - `PassportsService.scanOnOperation`
    (`passports.service.ts:702-711`) — не пускает на операцию
    категории `IRONING` без `QC_PASSED`.
- **Нарушений в коде нет.**

### 9.5. `OPERATION_SCAN` не финализирует операцию

- **Описание.** Скан паспорта на операции — это **переход**
  паспорта на новую операцию (с новым исполнителем), а не
  завершение предыдущей. `OPERATION_SCAN` инициирует
  pending-начисление **предыдущему** исполнителю
  предыдущей операции, но не пишет `OPERATION_FINISHED` и не
  «закрывает» текущий шаг швеи. Финализация требует отдельного
  явного действия швеи — `complete-operation`.
- **Где обеспечивается.**
  - Writer `OPERATION_SCAN` —
    `PassportsService.scanOnOperation`
    (`passports.service.ts:752-761`). В той же транзакции:
    `tx.passport.update(currentOperationId = session.operationId,
    currentEmployeeId = actor, status = IN_PROGRESS)` + начисление
    предыдущему через `EarningsService.createPendingForPreviousOperation`
    (`passports.service.ts:767-775`). `OPERATION_FINISHED` НЕ
    пишется.
  - Writer `OPERATION_FINISHED` —
    `PassportsService.completeOperationByEmployee`
    (`passports.service.ts:854-974`). Только этот метод
    финализирует текущую операцию: пишет `OPERATION_FINISHED`,
    обнуляет `currentEmployeeId` и `currentCellId`, фиксирует
    `currentOperationId = session.operationId` и сдвигает
    `currentRouteStepIndex`. `Passport.status` остаётся
    `IN_PROGRESS`.
- **Нарушений в коде нет.** Пара методов чётко разделена:
  `scanOnOperation` (scan-driven переход) ≠
  `completeOperationByEmployee` (явное «Завершить»).

### 9.6. `approvePendingForPassport` вызывается только после `close()`

- **Описание.** Pending-начисления (`EntryStatus.PENDING_RELEASE`)
  переходят в `APPROVED` ровно в момент закрытия коробки,
  объединяющего «выпущенные» паспорта. Это правило ADR-0005
  §«Подтверждение» / ADR-0011 §5: пока коробка не закрыта,
  начисления остаются висящими; при `close()` все pending по
  каждому `BoxItem.passportId` финализируются разом.
- **Где обеспечивается.**
  - Точка вызова — `PackingService.close`
    (`packing.service.ts:368-424`). Внутри транзакции после
    `box.update({ closedAt: new Date() })` идёт цикл по
    `BoxItem` и для каждого паспорта вызывается
    `this.earnings.approvePendingForPassport(tx, item.passportId)`
    (`packing.service.ts:394-400`).
  - Реализация — `EarningsService.approvePendingForPassport`
    (`earnings.service.ts:776-792`). Один
    `tx.operationEntry.updateMany` с фильтром `status ∈
    [PENDING_RELEASE, PENDING]`.
  - Идемпотентность повторного `close()` обеспечивается двумя
    уровнями: `BoxClosedException` (`packing.service.ts:380`) не
    даст вызвать апрув повторно, а сам `updateMany` всё равно
    отработает no-op (фильтр уже не зацепит APPROVED).
- **Глобальный поиск.** `rg approvePendingForPassport apps/api/src`
  даёт ровно одно тело метода (`earnings.service.ts:776`) и ровно
  один call-site (`packing.service.ts:399`). Других вызовов нет —
  ни из `addPassport`, ни из qc/wto, ни из master-actions.
- **WARNING — устаревший docstring.** В JSDoc-комментарии
  `EarningsService` (`earnings.service.ts:52`) написано
  «вызывается из `PackingService.addPassport`» — это устаревший
  текст, в коде вызов уже перенесён на `close()` (см. ADR-0005
  §«Подтверждение», `addPassport` сознательно НЕ финализирует
  начисления, см. комментарий `packing.service.ts:348-355`). На
  поведение это не влияет, но при чтении сервиса легко спутать.

### 9.7. `CREATED` — первое событие паспорта

- **Описание.** Любой `PassportEvent` для паспорта пишется только
  после того, как у этого паспорта уже есть `PassportEvent(CREATED)`.
  Все остальные writer-ы предполагают существование `Passport`-row,
  который сам по себе создаётся ровно в одном месте.
- **Где обеспечивается.** `PassportsService.create`
  (`passports.service.ts:188-250`). В одной транзакции:
  `tx.passport.create({ status: CREATED, ... })` →
  `tx.passport.update({ qrCode })` →
  `tx.passportEvent.create({ type: CREATED, ... })` →
  `EarningsService.createImmediateForCutter(tx, ...)`. Других
  writer-ов `PassportEventType.CREATED` в коде нет.
- **Нарушений в коде нет.**

### 9.8. Идемпотентность `OPERATION_SCAN` на повторный скан

- **Описание.** Повторный скан того же паспорта тем же сотрудником
  на той же операции — no-op. Состояние паспорта не меняется,
  новый `PassportEvent(OPERATION_SCAN)` НЕ пишется,
  `EarningsService.createPendingForPreviousOperation` НЕ
  вызывается. Это нужно, чтобы случайный двойной скан не двоил
  pending-начисления и не плодил мусорные events.
- **Где обеспечивается.** `PassportsService.scanOnOperation`
  (`passports.service.ts:713-723`): early-return по условию
  `sameOp && sameEmployee && status === IN_PROGRESS` ДО открытия
  транзакции. На уровне БД от двойного начисления дополнительно
  страхует `@@unique` на `OperationEntry(passportId, operationId,
  employeeId, sourceEventType)` + `safeCreate` ловит P2002
  (`earnings.service.ts:1055-1071`).
- **Нарушений в коде нет.**

### 9.9. Идемпотентность создания начислений

- **Описание.** Любой повторный trigger
  (`createImmediateForCutter`, `createPendingForPreviousOperation`)
  на тот же ключ `(passportId, operationId, employeeId,
  sourceEventType)` приводит к тихому skip, а не к дублирующему
  начислению или 500-ке.
- **Где обеспечивается.** Schema-level `@@unique` на
  `OperationEntry` (см. `prisma/schema.prisma::OperationEntry`,
  ADR-0012) + `EarningsService.safeCreate`
  (`earnings.service.ts:1055-1071`), который ловит
  `Prisma.PrismaClientKnownRequestError(P2002)` и возвращает
  `false` (создания не было). Cutter-аудит логируется только
  когда `safeCreate` вернул `true`
  (`earnings.service.ts:223-235, 357-381`) — иначе журнал засорится
  на повторных trigger-ах.
- **Нарушений в коде нет.**

### 9.10. Идемпотентность `close()` коробки

- **Описание.** Закрытие уже закрытой коробки — отказ
  (`BoxClosedException`), а не повторный апрув. Pending-начисления
  не подтверждаются повторно.
- **Где обеспечивается.** `PackingService.close`
  (`packing.service.ts:380` — гард) +
  `EarningsService.approvePendingForPassport`
  (`earnings.service.ts:781-790` — `updateMany` с фильтром по
  `PENDING_RELEASE`/`PENDING`, APPROVED-строки не цепляются).
- **Нарушений в коде нет.**

### 9.11. `AuditLog` атомарен с операцией только при передаче `tx`

- **Описание.** `AuditService.log(input, tx?)` гарантирует «либо
  и операция, и аудит, либо ничего» **только** когда вызывающая
  сторона передала активный `Prisma.TransactionClient`. Без `tx`
  ошибка записи в `AuditLog` глушится в WARN — операция при этом
  остаётся успешной, но аудит-строка теряется.
- **Где обеспечивается.** Реализация —
  `AuditService.log` (`audit.service.ts:229-260`):
  `tx.auditLog.create` пробрасывает ошибки наружу, ветка без `tx`
  оборачивает запись в `try/catch` с `logger.warn`. Все известные
  passport/qc/wto/packing/master-actions/master-calls/orders/
  purchase-orders/purchase-receipts call-сайты передают `tx` (см.
  выше § 3.3, §8.3 и список писателей).
- **WARNING — fail-soft без `tx`.** Любой будущий вызов
  `audit.log({...})` без второго аргумента откроет лазейку:
  бизнес-операция пройдёт, но `AuditLog` может тихо потеряться.
  Это сознательный legacy-fallback, см. комментарий
  `audit.service.ts:250-259`.

### 9.12. `DEFECT_RECORDED` пишется без `AuditLog`

- **Описание.** Все остальные «доменные» события паспорта (см.
  §8.3) пишутся в паре `PassportEvent + AuditLog`. `DEFECT_RECORDED`
  — единственный writer, который пишет ТОЛЬКО `PassportEvent` и
  только `PassportDefect`-row, без парного `AuditLog`-события.
- **Где видно.** `QcService.recordDefect`
  (`qc.service.ts:300-351`): внутри `$transaction` —
  `tx.passportDefect.create` + `tx.passport.update(qtyDefect++,
  qtyGood--)` + `tx.passportEvent.create({ type:
  DEFECT_RECORDED })`. `this.audit.log(...)` НЕ вызывается.
- **WARNING — асимметрия.** С точки зрения общего инварианта «pair
  event + audit для passport-доменных писателей» — это нарушение
  (зафиксировано как UNKNOWN-зона §7 в конце документа). С точки
  зрения функциональности — потерянных данных нет, потому что вся
  полезная нагрузка уезжает в payload `PassportEvent` и в строку
  `PassportDefect`.

### 9.13. `PassportStatus.CANCELLED` ни одним сервисом не выставляется

- **Описание.** В runtime-коде нет ни одного writer-а
  `Passport.status = CANCELLED` и ни одного writer-а
  `PassportEventType.CANCELLED`. Сценария отмены паспорта
  фактически нет.
- **Где видно.** `rg "PassportStatus\.CANCELLED"
  apps/api/src` — все упоминания являются read-guard-ами
  (`passports.service.ts:1250`, `packing.service.ts:222`,
  `qc.service.ts:404-405`, `wto.service.ts:194-195`,
  `diagnostics.service.ts:246`), либо проверкой статуса в
  exception-классе. Ни одного `update({ status: CANCELLED })`.
- **WARNING — потенциальный «invariant by absence».** Статус
  зарезервирован, но через API его выставить нельзя. Любой
  алгоритм, полагающийся на «обработка отменённых паспортов», на
  MVP не сработает: их в системе физически не появляется.

### 9.14. Сводная таблица: инварианты и потенциальные нарушения

| № | Инвариант                                                                | Где обеспечивается                                       | Нарушения / WARNING                                                                                                                                |
| - | ------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `PassportEvent` в той же tx, что и change of state                       | `passports`, `qc`, `wto`, `packing` (все writer-ы события) | **WARNING.** `MasterActionsService.{unassign, transfer, returnToCell, setRouteStep}` меняют состояние паспорта без `PassportEvent` (только `AuditLog`). |
| 2 | `PACKED` ⟺ `status = PACKED`                                             | `PackingService.addPassport`                               | нет                                                                                                                                                 |
| 3 | `QC_PASSED` не меняет state                                              | `QcService.completeQc`                                     | нет                                                                                                                                                 |
| 4 | `WTO_PASSED` не меняет state                                             | `WtoService.completeWto`                                   | нет (sub-инвариант «`WTO_PASSED` ⇒ был `QC_PASSED`» — `WtoService.assertQcPassed`, `PassportsService.scanOnOperation` IRONING-gate)                |
| 5 | `OPERATION_SCAN` не финализирует операцию                                | `PassportsService.scanOnOperation` vs `completeOperationByEmployee` | нет                                                                                                                                                 |
| 6 | `approvePendingForPassport` только после `close()`                       | `PackingService.close`                                     | **WARNING.** Устаревший JSDoc `earnings.service.ts:52` упоминает `addPassport` — реальный call-site только в `close()` (`packing.service.ts:399`).  |
| 7 | `CREATED` — первое событие паспорта                                      | `PassportsService.create`                                  | нет                                                                                                                                                 |
| 8 | `OPERATION_SCAN` идемпотентен на (passport, operation, employee)         | `PassportsService.scanOnOperation` (early-return) + `OperationEntry @@unique` | нет                                                                                                                                                 |
| 9 | Создание начислений идемпотентно                                         | `EarningsService.safeCreate` + schema `@@unique`           | нет                                                                                                                                                 |
| 10| `close()` идемпотентен                                                   | `BoxClosedException` + `approvePendingForPassport` фильтр  | нет                                                                                                                                                 |
| 11| `AuditLog` атомарен с операцией только при передаче `tx`                 | `AuditService.log` (audit.service.ts:241-260)              | **WARNING.** Без `tx` запись fail-soft (WARN-лог). Все известные сейчас call-сайты (passports/qc/wto/packing/master-actions/...) передают `tx`.    |
| 12| `DEFECT_RECORDED` пишется без `AuditLog`                                 | `QcService.recordDefect`                                   | **WARNING — асимметрия.** Все остальные «парные» доменные события пишут `PassportEvent + AuditLog`, кроме `DEFECT_RECORDED` и `CREATED` (см. §8.3). |
| 13| `PassportStatus.CANCELLED` не выставляется                                | (нет writer-а в `apps/api/src`)                            | **WARNING — invariant by absence.** Статус зарезервирован, через API его получить нельзя.                                                          |

---

## Использованные файлы

Prisma-схема:
- `prisma/schema.prisma` (enum `PassportEventType`, `MasterCallStatus`,
  `PrintJobStatus`, `PrintJobSource`, `OrderStatus`; модели
  `PassportEvent`, `AuditLog`, `MasterCall`, `PurchaseOrder`,
  `PurchaseOrderLine`, `PurchaseReceipt`, `PurchaseReceiptLine`,
  `PrintJob`).

Сервисы:
- `apps/api/src/modules/passports/passports.service.ts`
- `apps/api/src/modules/qc/qc.service.ts`
- `apps/api/src/modules/wto/wto.service.ts`
- `apps/api/src/modules/packing/packing.service.ts`
- `apps/api/src/modules/master-calls/master-calls.service.ts`
- `apps/api/src/modules/master-actions/master-actions.service.ts`
- `apps/api/src/modules/purchase-orders/purchase-orders.service.ts`
- `apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts`
- `apps/api/src/modules/printers/print-jobs.service.ts`
- `apps/api/src/modules/printers/print-jobs.controller.ts`
- `apps/api/src/modules/audit/audit.service.ts`
- `apps/api/src/modules/orders/orders.service.ts`
- `apps/api/src/modules/orders/order-cost-estimates.service.ts`

Читатели `PassportEvent` (для проверки, что и как вычитывается):
- `apps/api/src/modules/dashboard/dashboard.service.ts`
- `apps/api/src/modules/shopfloor/shopfloor.service.ts`
- `apps/api/src/modules/costs/costs.service.ts`
- `apps/api/src/modules/costs/production-cost-v2.service.ts`
- `apps/api/src/modules/costs/passport-durations.service.ts`
- `apps/api/src/modules/shifts/shifts.service.ts`

---

## UNKNOWN зоны

Факты, которые **нельзя** подтвердить только из кода
`apps/api/src/modules/**` и `prisma/schema.prisma`:

1. **`PassportEventType.OPERATION_STARTED`** — значение enum есть, но
   ни один сервис его не пишет (`rg` по `apps/api/src` — пусто).
   Неясно, осталось ли от предыдущей итерации или будет использоваться
   в будущем. Комментарий в schema к этому значению отсутствует.
2. **`PassportEventType.MOVED`** — аналогично, enum-значение без
   writer-а в runtime-коде.
3. **`PassportEventType.CELL_REMOVED`** — аналогично. Физическое
   «снятие с ячейки» при `ISSUED_TO_EMPLOYEE` происходит
   (`passports.service.ts:512-545`), но отдельного события не
   пишется.
4. **`PassportEventType.CANCELLED`** и **`PassportStatus.CANCELLED`** —
   в `apps/api/src` нет ни одного `UPDATE Passport SET status =
   CANCELLED`. Сценария отмены паспорта в runtime-коде нет.
5. **`MasterCallStatus.CANCELLED`** — enum-значение зарезервировано,
   но ни `MasterCallsService`, ни кто-либо ещё не выставляет его
   (комментарий `schema.prisma:89-91` сам так и говорит: «на MVP не
   используется»).
6. **Переходы `Order.status`** `IN_PRODUCTION → DONE` и
   `* → CANCELLED` (`orders.service.ts:1984`, `orders.service.ts:2001`)
   **не** пишут `AuditLog`. Это может быть осознанным упрощением или
   пропуском — из кода однозначно не следует.
7. **`QcService.recordDefect`** пишет `PassportEvent(DEFECT_RECORDED)`,
   но **не** пишет `AuditLog`. В остальных методах `qc`/`wto`/`packing`
   пары «event + audit» выдержаны, здесь — асимметрия. Осознанный
   выбор или пропуск — не указано явно.
8. **Авто-переходы `PurchaseOrder.status`** (в `RECEIVED` /
   `PARTIALLY_RECEIVED` / откат) внутри
   `PurchaseReceiptsService.recalcAfterChange` происходят без
   собственного `AuditLog`-события. Источник истины для таких
   переходов — только `PURCHASE_RECEIPT_CREATED` /
   `PURCHASE_RECEIPT_CANCELLED`.
9. **Идентификатор актора в `PassportEvent`**. В модели
   `PassportEvent` `employeeId` — это FK на `Employee` с `onDelete`
   по-умолчанию (без явной директивы в schema). Поведение при удалении
   сотрудника для events — не зафиксировано явно. См.
   `prisma/schema.prisma:1154-1178`.
10. **Порядок/упорядочивание внутри одной транзакции**. `PassportEvent`
    и `AuditLog` пишутся двумя отдельными `INSERT`-ами. Их `createdAt`
    одинаково (`@default(now())`), но относительный порядок в пределах
    миллисекунды из кода гарантировать невозможно. Для анализа это,
    как правило, не важно, но формально — UNKNOWN.

