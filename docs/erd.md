# ERD — модель БД

> ⚠️ **Источник истины — `prisma/schema.prisma`.**
> Этот документ — карта моделей и enum-ов, сгруппированная по доменам.
> Все факты (поля / отношения / индексы / `onDelete`-политики)
> привязаны к конкретным `model` / `enum` в `prisma/schema.prisma`.
> При расхождении документа и кода — верим коду.
>
> Документ сгенерирован/перестроен в PHASE 1 (2026-Q2) и помечен в
> `docs/index.md` статусом **OK**.
>
> Команда быстрой инвентаризации (PHASE 1):
>
> ```bash
> rg "^(model|enum) " prisma/schema.prisma
> ```

---

## Содержание

- [1. Enum-ы](#1-enums)
- [2. Модели по доменам](#2-models-by-domain)
  - [2.1 Users / auth / employees](#21-users--auth--employees)
  - [2.2 Orders](#22-orders)
  - [2.3 Routes / operations / time norms](#23-routes--operations--time-norms)
  - [2.4 Tech cards / materials](#24-tech-cards--materials)
  - [2.5 Passports / production](#25-passports--production)
  - [2.6 Warehouse / cells](#26-warehouse--cells)
  - [2.7 Packing](#27-packing)
  - [2.8 QC / WTO / defects](#28-qc--wto--defects)
  - [2.9 Salary / earnings](#29-salary--earnings)
  - [2.10 Shopfloor / display](#210-shopfloor--display)
  - [2.11 Patterns](#211-patterns)
  - [2.12 Workshop needs / procurement](#212-workshop-needs--procurement)
  - [2.13 Printers / print jobs](#213-printers--print-jobs)
  - [2.14 Audit](#214-audit)
  - [2.15 Company settings](#215-company-settings)
- [3. Новые контуры (детальные карточки)](#3-new-contours)

---

<a id="1-enums"></a>
## 1. Enum-ы

Все enum-ы из `prisma/schema.prisma` (alphabetic):

| Enum | Значения | Источник |
| --- | --- | --- |
| `ApprovalMode` | `IMMEDIATE`, `AFTER_RELEASE` | `prisma/schema.prisma::enum ApprovalMode` |
| `CompensationType` | `PIECEWORK`, `SALARY`, `MIXED` | `prisma/schema.prisma::enum CompensationType` |
| `CuttingClosureRequestStatus` | `REQUESTED`, `APPROVED`, `REJECTED` | `prisma/schema.prisma::enum CuttingClosureRequestStatus` |
| `EarningSource` | `PASSPORT_CREATED`, `OPERATION_TRANSITION` | `prisma/schema.prisma::enum EarningSource` |
| `EntryStatus` | `PENDING`, `PENDING_RELEASE`, `APPROVED`, `CANCELLED`, `REVERSED` | `prisma/schema.prisma::enum EntryStatus` |
| `MasterCallStatus` | `OPEN`, `RESOLVED`, `CANCELLED` | `prisma/schema.prisma::enum MasterCallStatus` |
| `OperationCategory` | `CUTTING`, `SEWING`, `QC`, `IRONING`, `PACKING` | `prisma/schema.prisma::enum OperationCategory` |
| `OrderOutsourceExecutionStatus` | `PLANNED`, `ORDERED`, `RECEIVED` | `prisma/schema.prisma::enum OrderOutsourceExecutionStatus` |
| `OrderStatus` | `DRAFT`, `CALCULATION`, `CALCULATION_DONE`, `IN_PRODUCTION`, `DONE`, `CANCELLED` | `prisma/schema.prisma::enum OrderStatus` |
| `OutsourceTriggerType` | `MANUAL`, `CUT_READY` | `prisma/schema.prisma::enum OutsourceTriggerType` |
| `PassportEventType` | `CREATED`, `OPERATION_STARTED`, `OPERATION_FINISHED`, `MOVED`, `DEFECT_RECORDED`, `CELL_PLACED`, `CELL_REMOVED`, `ISSUED_TO_EMPLOYEE`, `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`, `PACKED`, `CANCELLED` | `prisma/schema.prisma::enum PassportEventType` |
| `PayrollAccrualDocumentStatus` | `DRAFT`, `PAID`, `CANCELLED` | `prisma/schema.prisma::enum PayrollAccrualDocumentStatus` |
| `PayrollPayoutLineKind` | `PIECEWORK`, `SALARY` | `prisma/schema.prisma::enum PayrollPayoutLineKind` |
| `PayrollPayoutStatus` | `DRAFT`, `ISSUED`, `ACKNOWLEDGED`, `CANCELLED` | `prisma/schema.prisma::enum PayrollPayoutStatus` |
| `PassportStatus` | `CREATED`, `IN_PROGRESS`, `PACKED`, `CANCELLED` | `prisma/schema.prisma::enum PassportStatus` |
| `PricingMode` | `FIXED`, `BY_SIZE`, `SALARY_ONLY` | `prisma/schema.prisma::enum PricingMode` |
| `PrintJobSource` | `PASSPORT_QR`, `PASSPORT_PRINT`, `BOX_LABEL`, `CELL_QR`, `CELL_LABEL`, `TEST` | `prisma/schema.prisma::enum PrintJobSource` |
| `PrintJobStatus` | `PENDING`, `PRINTED`, `FAILED` | `prisma/schema.prisma::enum PrintJobStatus` |
| `PrinterType` | `PASSPORT`, `QR`, `LABEL`, `DEFAULT` | `prisma/schema.prisma::enum PrinterType` |
| `Role` | `SHOP_MANAGER`, `CUTTER`, `CUTTER_ASSISTANT`, `SEAMSTRESS`, `QC`, `IRONING`, `PACKING`, `ADMIN`, `DISPLAY`, `SHOPFLOOR_MASTER` | `prisma/schema.prisma::enum Role` |
| `SalaryEntrySource` | `SHIFT_DAY`, `MANUAL` | `prisma/schema.prisma::enum SalaryEntrySource` |

> **Free-form статусы.** В части моделей жизненный цикл хранится **строкой**
> (а не Prisma enum-ом) ради расширяемости без миграции. Источник истины
> для допустимых значений — Zod-listы в `packages/shared/src/**`. Это
> касается:
> `Order.routeTemplateId`-snapshot статусов, `WorkshopNeed.status` /
> `WorkshopNeed.calculationMethod`, `Supplier.status`,
> `SupplierCatalogItem.status`, `PurchaseOrder.status` /
> `PurchaseOrderLine.status`, `PurchaseReceipt.status` /
> `PurchaseReceiptLine.status`, `OrderApplication.type` /
> `.stage` / `.status`, `OrderCostEstimate.status`,
> `OrderCostEstimateLine.kind`, `OrderMaterialArrivalOverride.status`,
> `PatternItem.status`, `PatternCategory.status`,
> `PatternCategoryParameter.status` / `.inputType`,
> `PatternSizeFile.status`, `Operation.timeNormMode`. См. соответствующие
> JSDoc-комментарии в `prisma/schema.prisma`.

---

<a id="2-models-by-domain"></a>
## 2. Модели по доменам

Полный список моделей (61) сгруппирован по доменам. У каждой
модели приведён только базовый contract — поля-ключи, важные
индексы и `onDelete`-политики, которые меняют граф удалений.
Полный набор полей и комментариев — в `prisma/schema.prisma`.

<a id="21-users--auth--employees"></a>
### 2.1 Users / auth / employees

- **`Employee`** — `id` (cuid), `fullName`, `login` (uniq), `pinHash`,
  `role: Role`, `compensationType: CompensationType @default(PIECEWORK)`,
  `salaryPerShift: Decimal?` (для `SALARY`/`MIXED`),
  `cutterB2bSewingPercent: Decimal(5,2)?` (B2B-процент закройщика),
  `companyDivisionId: String? → CompanyDivision` (`onDelete: SetNull`,
  PHASE 2 STEP 2 — основная привязка сотрудника к подразделению,
  используется payroll-фильтром «Подразделение» для окладной части),
  `active: Boolean @default(true)`. Индексы: `role`, `compensationType`,
  `companyDivisionId`.
  - Сессии: `pinHash` хранит `bcrypt(password)`.
  - Источник истины «как платим» — `compensationType` (см. ADR-0021).
  - PHASE 2 STEP 1: историческая колонка `salaryBase` удалена (см.
    ADR-0020 §«PHASE 2 — drop legacy»). Реальная оплата считается
    через `compensationType` + `salaryPerShift`.
- **`ShiftSession`** — открытая/закрытая смена сотрудника на
  оборудовании. `employeeId`, `equipmentId`, `operationId`, `startedAt`,
  `endedAt: DateTime?`. Активная смена = `endedAt IS NULL`. Уникальность
  активной смены — partial unique index из миграций.
- **`Equipment`** — `code` (uniq), `qrCode` (uniq), `name`,
  `displayNumber: String?` (ручной №). Связи: `EquipmentOperation`,
  `Printer`, `MasterCall`.
- **`EquipmentOperation`** — M2M `Equipment ↔ Operation` (источник
  истины разрешённых операций станка, ADR-0017). Уникальность
  пары + cascade со стороны обоих родителей.

<a id="22-orders"></a>
### 2.2 Orders

- **`Order`** — заказ покупателя.
  - **Поля плана**: `number` (uniq), `customer` (legacy),
    `clientId? → Client`, `orderDate`, `dueDate?`, `color?`,
    `comment?`,
    `companyDivisionId? → CompanyDivision` (`onDelete: SetNull`,
    master-связка с справочником подразделений, см.
    «CompanyDivision» в §2.7 и `docs/domain.md §«Подразделения
    заказа»`),
    `status: OrderStatus @default(DRAFT)`,
    `routeTemplateId? → RouteTemplate`,
    `techCardId? → TechCardTemplate`,
    `patternItemId? → PatternItem` (`onDelete: SetNull`).
  - **Snapshot-поля лекала**: `patternNameSnapshot?`,
    `patternArticleSnapshot?`, `patternPreviewSnapshotUrl?`.
  - **Snapshot-поля себестоимости**: `costEstimateTotalRub?`,
    `costEstimateCompletedAt?`, `costEstimateVersion?`.
  - **Snapshot-поля операционного плана**:
    `operationCostPlanRub?`, `operationTimePlanSec?`,
    `operationPlanCalculatedAt?`, `operationPlanWarnings: Json?`.
  - **Цена продажи**: `customerUnitPrice?`, `customerCurrency?`.
  - Связи: `OrderItem[]`, `Passport[]`, `OrderRouteStep[]`,
    `OrderMaterialRequirement[]`, `OrderOutsourceRequirement[]`,
    `WorkshopNeed[]` (cascade), `PurchaseOrder[]` (`SetNull` со стороны
    PO), `PurchaseReceipt[]` (`SetNull`), `OrderApplication[]` (cascade),
    `OrderCostEstimate[]`, `OrderMaterialArrivalOverride[]` (cascade),
    `CuttingClosureRequest[]`, `companyDivision? → CompanyDivision`.
  - Индексы: `status`, `orderDate`, `createdAt`, `routeTemplateId`,
    `techCardId`, `patternItemId`, `clientId`, `dueDate`,
    `companyDivisionId`.
  - **`CompanyDivision` как master-справочник подразделений** (см.
    `docs/domain.md §«Подразделения заказа»`): backend
    `OrdersService.create`/`update` пишет FK
    `companyDivisionId` напрямую, `EarningsService` выбирает схему
    начисления закройщика по `companyDivision.code`,
    shopfloor-фильтр (`?divisionCode=…`) — тоже по `code`.
- **`OrderItem`** — позиция заказа `(orderId, productId, sizeId)` uniq,
  `qtyPlan: Int`. Один заказ — один `productId` (инвариант ADR-0009).
- **`Client`** — справочник клиентов: `name`, `phone?`, `email?`,
  `comment?`, `isActive`. Не уникален по `name`. Индексы:
  `isActive`, `name`.

<a id="23-routes--operations--time-norms"></a>
### 2.3 Routes / operations / time norms

- **`Operation`** — справочник операций. `code` (uniq), `name`,
  `category: OperationCategory`, `sortOrder`, `active`,
  `pricingMode: PricingMode @default(SALARY_ONLY)`,
  `fixedRate: Decimal(12,2)?`,
  `timeNormMode: String @default("FIXED")` (`FIXED` / `BY_SIZE`),
  `timeNormSec: Int?`,
  `salaryPlanRubPerShift: Decimal(14,2)?`,
  `salaryPlanShiftSeconds: Int? @default(28800)`. См. ADR-0020.
- **`OperationRateBySize`** — сдельные ставки по размерам
  (`pricingMode = BY_SIZE`). `(operationId, sizeId)` uniq,
  `onDelete: Cascade` от `Operation`.
- **`OperationTimeNormBySize`** *(новый контур)* — поразмерная
  плановая норма времени (`timeNormMode = "BY_SIZE"`). Decimal не
  используется — `seconds: Int`. `(operationId, sizeId)` uniq,
  cascade от `Operation` и от `Size`. См. §3.6 ниже и
  `docs/operation-time-norms-recon.md`.
- **`RouteTemplate`** — шаблон маршрута. `code` (uniq), `name`, `isActive`.
- **`RouteTemplateStep`** — шаг шаблона: `(templateId, index)` uniq,
  `(templateId, operationId)` uniq, cascade от `RouteTemplate`.
- **`OrderRouteStep`** — snapshot маршрута на заказе.
  `(orderId, index)` uniq, cascade от `Order`. Заполняется
  `OrdersService.syncOrderRouteStepsSnapshot()` (см.
  ADR-0022 и комментарий ниже).

<a id="24-tech-cards--materials"></a>
### 2.4 Tech cards / materials

- **`TechCardTemplate`** — шаблон техкарты. `code` (uniq), `name`,
  `isActive`. Связи: `materialLines`, `outsourceLines`, `orders`.
- **`TechCardMaterialLine`** — строка материала шаблона.
  `qtyPerUnit: Decimal(12,4)`, `unit`, `name`, `note?`,
  `materialRole?` (свободная строка из `MATERIAL_ROLES`),
  `fabricType?`, `densityGsm: Int?`, `plannedWidthCm: Int?`,
  `colorRule?` (`ORDER_COLOR` / `FIXED_COLOR` / `NO_COLOR` /
  `ORDER_SELECTED_COLOR`), `fixedColorText?`,
  `hardwareSizeText?`, `hardwareMaterialText?`,
  `materialImageUrl?`, `materialImageOriginalFileName?`. Cascade
  от `TechCardTemplate`. Индекс: `materialRole`.
- **`TechCardOutsourceLine`** — строка внешнего подряда шаблона.
  `qtyPerUnit?`, `vendorName?`, `triggerType: OutsourceTriggerType
  @default(MANUAL)`. Cascade от `TechCardTemplate`.
- **`OrderMaterialRequirement`** — snapshot материала на заказе
  (`OrdersService.syncOrderRouteStepsSnapshot()` / tech-card-snapshot).
  `sourceTechCardLineId? → TechCardMaterialLine` (`onDelete: SetNull`),
  `qtyPerUnit`, `totalQty`, snapshot-копии `materialRole` /
  `fabricType` / `densityGsm` / `plannedWidthCm` / `colorRule` /
  `fixedColorText` / `resolvedColorText` / `hardware*` /
  `materialImage*`, плюс `requiresColorSelection` и
  `selectedColorText` для `ORDER_SELECTED_COLOR`. Cascade от `Order`.
- **`OrderOutsourceRequirement`** — snapshot подряда на заказе.
  `sourceTechCardLineId? → TechCardOutsourceLine` (`SetNull`),
  `triggerType: OutsourceTriggerType @default(MANUAL)`,
  `executionStatus: OrderOutsourceExecutionStatus @default(PLANNED)`,
  `orderedAt?`, `receivedAt?`. Cascade от `Order`. См. ADR-0022 §«Manual
  execution status (MVP-3)».

<a id="25-passports--production"></a>
### 2.5 Passports / production

- **`Passport`** — агрегат-корень партии (size + color + roll).
  `number` (uniq), `qrCode` (uniq), `orderId`, `productId`, `sizeId`,
  `color`, `rollNumber`, `cutDate`, `qtyPlan`, `qtyCut`,
  `qtyDefect @default(0)`, `qtyGood`, `status: PassportStatus
  @default(CREATED)`. **Текущее размещение**: `currentOperationId?`,
  `currentEmployeeId?`, `currentCellId?`, `currentRouteStepIndex: Int?`.
  `cutterId`, `creatorId`, `pdfUrl?`. Индексы:
  `(status, currentOperationId)`, `orderId`, `(sizeId, status)`,
  `createdAt`, `currentCellId`. **Глобальный uniqueness** на
  `BoxItem.passportId` обеспечивает одно вхождение в коробку.
- **`PassportEvent`** — лог событий паспорта. `type: PassportEventType`,
  `operationId?`, `fromOperationId?`, `employeeId?`, `qty?`, `defectQty?`,
  `cellId?`, `boxId?`, `payload: Json?`. Индексы:
  `(passportId, createdAt)`, `(type, createdAt)`,
  `(operationId, createdAt)`. **Не источник истины** для derived
  состояния паспорта — текущее размещение хранится колонками выше.

<a id="26-warehouse--cells"></a>
### 2.6 Warehouse / cells

- **`Warehouse`** — склад. `name` (uniq), `code: String? @unique`,
  `isActive`, `labelTemplate?`. Связи: `Cell[]`, `WarehouseLine[]`.
  Индекс: `isActive`.
- **`WarehouseLine`** — линия склада (полка/ряд). `code` уникален
  **глобально**, `warehouseId → Warehouse` (cascade).
- **`Cell`** — ячейка хранения. `code` (uniq), `qrCode` (uniq),
  `active`, `warehouseId? → Warehouse` (`onDelete: ?` — без явной
  политики, дефолт), `lineId? → WarehouseLine` (`SetNull`),
  `lineIndex: Int?`. Уникальность `(lineId, lineIndex)`. Связи:
  `CellContent[]`, `PassportEvent[]`, паспорта (`PassportCurrentCell`),
  `PurchaseReceiptLine[]`. Индексы: `warehouseId`, `lineId`.
- **`CellContent`** — содержимое ячейки `(cellId, sizeId, quantity)`,
  uniq `(cellId, sizeId)`. Это лёгкий счётчик; для размещения паспорта
  истина — `Passport.currentCellId`.

<a id="27-packing"></a>
### 2.7 Packing

- **`Box`** — коробка. `number` (uniq), `qrCode` (uniq),
  `totalQty @default(0)`, `maxQty @default(100)`, `closedAt?`,
  `createdById → Employee` (BoxCreator). Индекс: `closedAt`.
- **`BoxItem`** — связь паспорт↔коробка. `passportId String @unique`
  (глобально, ADR-0015), `(boxId, passportId)` uniq, `qty: Int`.
- **`Packed`-флаг** хранится в `Passport.status = PACKED` и в
  `PassportEvent(type = PACKED)`.

<a id="28-qc--wto--defects"></a>
### 2.8 QC / WTO / defects

- **`DefectType`** — справочник видов брака. `code` (uniq), `name`,
  `isActive`, `sortOrder`.
- **`PassportDefect`** — запись дефекта на паспорте.
  `passportId → Passport`, `defectTypeId → DefectType`, `qty`,
  `comment?`, `createdByEmployeeId? → Employee`. Индексы:
  `(passportId, createdAt)`, `(defectTypeId, createdAt)`.
- **`CuttingClosureRequest`** *(новый контур)* — заявка на закрытие
  раскроя по размеру. `(orderId, productId, sizeId)`, `status:
  CuttingClosureRequestStatus`, `requestedByEmployeeId`,
  `reviewedByEmployeeId?`. Partial-unique-индексы из миграций
  гарантируют **ровно одну** активную (`REQUESTED`) и **максимум одну**
  финальную (`APPROVED`) заявку на тройку. См. ADR-0018.
- **WTO** — отдельной модели не имеет: «ВТО прошло» = `PassportEvent
  (WTO_PASSED)` плюс scan-driven вход в `Operation.category = IRONING`.

<a id="29-salary--earnings"></a>
### 2.9 Salary / earnings

- **`OperationEntry`** — сдельное начисление. `passportId`,
  `operationId`, `employeeId`, `qty`, `ratePerUnit: Decimal(12,2)`,
  `amount: Decimal(12,2)`, `status: EntryStatus
  @default(PENDING_RELEASE)`,
  `approvalMode: ApprovalMode @default(AFTER_RELEASE)`,
  `sourceEventType: EarningSource @default(OPERATION_TRANSITION)`,
  `sourceEventId?`. **Идемпотентность**:
  `(passportId, operationId, employeeId, sourceEventType)` uniq
  (`OperationEntry_idem`, ADR-0012). Индексы:
  `(employeeId, status, createdAt)`, `(status, createdAt)`,
  `passportId`.
- **`SalaryEntry`** — окладное начисление. `employeeId`,
  `date: Date`, `amount: Decimal(12,2)`, `source: SalaryEntrySource
  @default(SHIFT_DAY)`, `editedManually @default(false)`,
  `managerComment?`, `editedByEmployeeId? → Employee` (Editor).
  `(employeeId, date, source)` uniq (`SalaryEntry_employee_date_source_uniq`),
  ADR-0021.
- **`PayrollPayout`** *(PHASE 3 STEP 1)* — управленческий документ
  «выплата зарплаты сотруднику за период». `employeeId → Employee`,
  `periodFrom: Date`, `periodTo: Date`, `status: PayrollPayoutStatus
  @default(DRAFT)`, snapshot-итоги
  `amountPieceworkRub` / `amountSalaryRub` / `amountTotalRub`
  (`Decimal(12,2)`, `default 0`), `managerComment?`,
  `createdById → Employee` + опциональные роли
  `issuedById?` / `acknowledgedByEmployeeId?` /
  `cancelledById? → Employee` (`onDelete: SetNull` для опциональных,
  `Restrict` для `employeeId` / `createdById`). Индексы:
  `(employeeId, status)`, `(periodFrom, periodTo)`,
  `(status, createdAt)`. Жизненный цикл — `PayrollPayoutStatus`,
  активная уникальность строк начислений в выплате проверяется
  сервисом (см. `PayrollPayoutLine` ниже).
- **`PayrollPayoutLine`** *(PHASE 3 STEP 1)* — строка выплаты.
  `payoutId → PayrollPayout` (`onDelete: Cascade`),
  `kind: PayrollPayoutLineKind`, ровно одна из
  `operationEntryId? → OperationEntry` /
  `salaryEntryId? → SalaryEntry` (`onDelete: SetNull`),
  `amountRub: Decimal(12,2)`, `occurredOn: Date`,
  `snapshot: Json`. На уровне БД `@@unique` на
  `operationEntryId` / `salaryEntryId` сознательно НЕ ставится:
  после `CANCELLED` выплаты строка снова доступна для включения в
  новую выплату. Индексы: `payoutId`, `operationEntryId`,
  `salaryEntryId`, `(kind, occurredOn)`.

- **`PayrollAccrualDocument`** *(PHASE 3 STEP 6.1)* — управленческий
  документ «начисление зарплаты на дату». `accrualDate: Date` —
  дата расчёта включительно (учитываются только `OperationEntry` /
  `SalaryEntry` с датой ≤ `accrualDate`), `status: PayrollAccrualDocumentStatus
  @default(DRAFT)`, snapshot-итоги
  `totalPieceworkRub` / `totalSalaryRub` / `totalAdjustRub` /
  `totalToPayRub` (`Decimal(12,2)`, `default 0`), `managerComment?`,
  `createdById → Employee` (`onDelete: Restrict`) + опциональные роли
  `paidById?` / `cancelledById? → Employee` (`onDelete: SetNull`).
  Индексы: `(status, accrualDate)`, `createdById`, `paidById`,
  `cancelledById`, `createdAt`. Жизненный цикл —
  `PayrollAccrualDocumentStatus`: `DRAFT → PAID | CANCELLED`.
- **`PayrollAccrualDocumentLine`** *(PHASE 3 STEP 6.1)* — строка
  документа начисления. `documentId → PayrollAccrualDocument`
  (`onDelete: Cascade`), `employeeId → Employee` (`onDelete: Restrict`),
  `amountPieceworkRub` / `amountSalaryRub` / `manualAdjustRub` /
  `amountToPayRub` (`Decimal(12,2)`), `manualComment?`,
  `payoutId? → PayrollPayout` (`onDelete: SetNull`) — заполняется
  после перевода документа в `PAID`,
  `snapshot: Json` — свёрнутый JSON-вид начислений на момент
  формирования строки. `@@unique([documentId, employeeId])`.
  Индексы: `documentId`, `employeeId`, `payoutId`.

  Граф связей: `PayrollAccrualDocument → PayrollAccrualDocumentLine
  → PayrollPayout` (через `payoutId` после PAID).

> **Payroll PHASE 1 (read-only).** Управленческий блок «Зарплата»
> (`/api/payroll/*`, `apps/api/src/modules/payroll/*`,
> [`docs/api.md §10c`](./api.md#30a-payroll),
> [`docs/domain.md §10.6`](./domain.md#106-payroll-phase-1-read-only))
> сознательно НЕ заводит новых таблиц / индексов / FK. UI-агрегатор
> читает существующие `OperationEntry` + `SalaryEntry` +
> `ShiftSession`, объединяет их через `Employee` и дотягивает
> «основное подразделение» через `Passport.order.companyDivisionId`.
> Никаких новых моделей и enum-ов в этой фазе нет.

<a id="210-shopfloor--display"></a>
### 2.10 Shopfloor / display

- **`DisplayScreenConfig`** — конфиг большого монитора цеха.
  `name`,
  `companyDivisionId? → CompanyDivision` (`onDelete: SetNull`,
  master-связка с справочником подразделений),
  `employeeId String @unique → Employee` (cascade), `isActive`.
  Один экран = одна DISPLAY-учётка.
  Индексы: `isActive`, `companyDivisionId`.
  - Backend (`DisplayScreensService.create`) пишет FK
    `companyDivisionId` напрямую (валидируя существование карточки
    через 400 `COMPANY_DIVISION_NOT_FOUND`).
    `ShopfloorService.resolveDisplayDivisionCode` для роли
    `DISPLAY` без `?divisionCode=` берёт
    `displayScreenConfig.companyDivision.code`.
  См. `docs/display-board.md`, `docs/screens.md §10e`.
- **`MasterCall`** *(новый контур)* — вызов мастера цеха.
  `employeeId → Employee` (autor), `equipmentId? → Equipment`,
  `operationId? → Operation`, `status: MasterCallStatus
  @default(OPEN)`, `message?`, `createdAt`, `resolvedAt?`,
  `resolvedById?`. Идемпотентность: на одного `Employee`
  единовременно максимум один `OPEN`. Индексы:
  `(status, createdAt)`, `(employeeId, status)`, `(equipmentId, status)`.

<a id="211-patterns"></a>
### 2.11 Patterns

- **`PatternItem`** *(новый контур)* — карточка лекала.
  `name`, `article` (uniq), `categoryCode? (legacy)`, `categoryId? →
  PatternCategory` (`SetNull`), `previewImageUrl?`, `description?`,
  `status: String @default("ACTIVE")`, `legacyProductId? @unique →
  Product` (`SetNull`, см. «Номенклатура = Лекала»). Связи:
  `sizeFiles`, `materialAreas`, `parameterNorms`,
  `sizeParameterValues`, `orders`. Индексы: `status`, `categoryId`.
- **`PatternCategory`** — справочник категорий номенклатуры.
  `name`, `slug` (uniq), `iconKey`, `iconImageUrl?`,
  `iconOriginalFileName?`, `sortOrder @default(100)`,
  `status: String @default("ACTIVE")`, `description?`.
- **`PatternCategoryParameter`** — параметр категории
  (площади м² / норма на изделие / текст). `categoryId → PatternCategory`
  (cascade), `roleKey`, `label`, `inputType: String
  @default("AREA_M2_BY_SIZE")`, `unit: String @default("м²")`,
  `isRequired @default(false)`, `sortOrder @default(100)`,
  `status @default("ACTIVE")`. Индексы: `(categoryId, roleKey)`
  (НЕ uniq — фурнитура в одной категории может дублировать `roleKey`),
  `categoryId`, `status`, `sortOrder`.
- **`PatternSizeFile`** — DXF-файл лекала по размеру. Версионирование
  `(patternItemId, sizeId, version)` uniq, `status @default("ACTIVE")`,
  `uploadedById? → Employee` (`SetNull`). Cascade от `PatternItem`.
- **`PatternMaterialArea`** — площадь материала на размере (м²).
  `(patternItemId, sizeId, materialRole)` uniq, `areaM2: Decimal(10,4)`.
  Cascade от `PatternItem`.
- **`PatternItemParameterNorm`** — норма «на изделие» по параметру
  категории (`inputType = QTY_PER_ITEM`).
  `(patternItemId, categoryParameterId)` uniq, snapshot-поля
  (`roleKey`, `labelSnapshot`, `inputTypeSnapshot`, `unit`),
  `qtyPerItem: Decimal(14,4)`. Cascade от обоих родителей.
- **`PatternItemSizeParameterValue`** — погонные метры по размерам
  (`inputType = LINEAR_M_BY_SIZE`).
  `(patternItemId, categoryParameterId, sizeId)` uniq.
  `value: Decimal(14,4)`. Cascade от `PatternItem` /
  `PatternCategoryParameter` / `Size`.

<a id="212-workshop-needs--procurement"></a>
### 2.12 Workshop needs / procurement

- **`WorkshopNeed`** *(новый контур)* — потребность цеха.
  `orderId → Order` (cascade), `sourceType?`, `sourceId?`,
  `materialRole?`, `sourceName?`, `description`, `fabricType?`,
  `densityGsm?`, `plannedWidthCm?`, `colorRule? / fixedColorText? /
  resolvedColorText?`, `totalAreaM2?`, `calculatedQty: Decimal(14,4)`,
  `purchaseQty: Decimal?(14,4)`, `unit`,
  `calculationMethod: String @default("QTY_PER_UNIT")`
  (`AREA_DENSITY` / `QTY_PER_UNIT`),
  `status: String @default("CALCULATED")` (`CALCULATED` / `REVIEWED` /
  `PURCHASE_PLANNED` / `CANCELLED` / `ORDERED` / `PARTIALLY_RECEIVED`
  / `RECEIVED`), `supplierNameText?`, `purchaseItemNameText?`,
  `quotedPrice?`, `quotedCurrency?`, `expectedDeliveryDate?`,
  `selectedSupplierId? → Supplier` (`SetNull`),
  `selectedSupplierCatalogItemId? → SupplierCatalogItem` (`SetNull`),
  `comment?`, `calculationNote?`. Индексы: `orderId`, `status`,
  `materialRole`, `calculationMethod`, `selectedSupplierId`,
  `selectedSupplierCatalogItemId`.
- **`Supplier`** *(новый контур)* — поставщик. `name` (не uniq),
  `phone? / website? / address? / comment?`,
  `status: String @default("ACTIVE")`. Индексы: `status`, `name`.
- **`SupplierContact`** — контакт менеджера у поставщика. Cascade от
  `Supplier`.
- **`SupplierCatalogItem`** — позиция каталога поставщика.
  `name`, `supplierArticle?`, `category?`, `fabricType?`,
  `densityGsm?`, `colorText?`, `unit`, `lastPrice: Decimal(14,2)?`,
  `currency?`, `minOrderQty?`, `deliveryDays?`, `comment?`,
  `status @default("ACTIVE")`. Cascade от `Supplier`.
- **`PurchaseOrder`** *(новый контур)* — закупочный документ.
  `number` (uniq, `PO-YYYYMMDD-NNNN`), `supplierId → Supplier`
  (`onDelete: Restrict`), `customerOrderId? → Order` (`SetNull`),
  `status: String @default("DRAFT")` (`DRAFT` / `SENT` / `CONFIRMED` /
  `CANCELLED`), snapshot полей поставщика, `expectedDeliveryDate?`,
  `sentAt?`, `confirmedAt?`, `cancelledAt?`, `comment?`,
  `createdById? → Employee` (`SetNull`). Индексы: `supplierId`,
  `customerOrderId`, `status`, `expectedDeliveryDate`, `createdAt`.
- **`PurchaseOrderLine`** — строка закупочного документа.
  Cascade от `PurchaseOrder`. `workshopNeedId? → WorkshopNeed`
  (`SetNull`), `supplierCatalogItemId? → SupplierCatalogItem`
  (`SetNull`), snapshot-поля номенклатуры, `qty: Decimal(14,4)`,
  `price: Decimal(14,2)?`, `currency?`, `expectedDeliveryDate?`,
  `confirmedQty? / confirmedPrice? / confirmedDeliveryDate?`,
  `status @default("DRAFT")`.
- **`PurchaseReceipt`** *(новый контур)* — приёмка по PO.
  `number` (uniq, `PR-YYYYMMDD-NNNN`), `purchaseOrderId →
  PurchaseOrder` (`Restrict`), `supplierId? → Supplier` (`SetNull`),
  snapshot полей поставщика, `customerOrderId? → Order` (`SetNull`),
  `status @default("POSTED")` (`POSTED` / `CANCELLED`),
  `receivedAt @default(now())`, `cancelledAt?`,
  `receivedById? → Employee` (`SetNull`).
- **`PurchaseReceiptLine`** — строка приёмки. Cascade от
  `PurchaseReceipt`. Денормализация: `purchaseOrderLineId?`,
  `workshopNeedId?`, `supplierCatalogItemId?` — все `SetNull`.
  Snapshot номенклатуры (`itemNameSnapshot`,
  `supplierArticleSnapshot?`, `unitSnapshot`, `orderedQtySnapshot?`,
  `confirmedQtySnapshot?`, `priceSnapshot?`, `currencySnapshot?`).
  `receivedQty: Decimal(14,4)`, `unit`, `cellId? → Cell` (`SetNull`),
  `locationNote?`, `batchNumber? / rollNumber? / shade? /
  actualWidthCm? / actualDensityGsm?`,
  `status @default("POSTED")`.
- **`OrderApplication`** *(новый контур)* — нанесение заказа
  (шелкография / DTF / вышивка / термотрансфер / сублимация).
  `orderId → Order` (cascade), `type: String` (свободная),
  `stage: String @default("CUT_PARTS")` (`CUT_PARTS` /
  `FINISHED_ITEM`), `placement?`, `widthMm?`, `heightMm?`,
  `colorsCount?`, `quantity?`, `unit @default("шт")`, `colorText?`,
  `description?`, `comment?`, `fileUrl?`,
  `status: String @default("PLANNED")` (`PLANNED` / `SENT` / `DONE`
  / `CANCELLED`).
- **`OrderCostEstimate`** *(новый контур)* — итоговый расчёт
  себестоимости. `orderId → Order` (cascade),
  `version: Int` (`(orderId, version)` uniq),
  `status @default("COMPLETED")` (`COMPLETED` / `REVOKED`),
  `totalCostRub: Decimal(14,2)`, `usdRateRub: Decimal(14,4)?`,
  `completedAt`, `completedById?`, `revokedAt?`, `revokedById?`,
  `comment?`. См. `OrdersService.completeCalculation`.
- **`OrderCostEstimateLine`** — строка расчёта.
  Cascade от `OrderCostEstimate`. `workshopNeedId? → WorkshopNeed`
  (`SetNull`), `kind: String` (`MATERIAL` / `HARDWARE` /
  `APPLICATION` / `OTHER`), `description`, `unit`,
  `calculatedQty?`, `purchaseQty: Decimal(14,4)`,
  `quotedPrice: Decimal(14,2)`, `quotedCurrency`,
  `usdRateRub?`, `lineTotalOriginal: Decimal(14,2)`,
  `lineTotalRub: Decimal(14,2)`,
  `supplierNameSnapshot?`, `purchaseItemNameSnapshot?`.
- **`OrderMaterialArrivalOverride`** *(новый контур)* — ручная
  отметка «материал поступил» в карточке заказа. `orderId → Order`
  (cascade), `workshopNeedId? → WorkshopNeed` (`SetNull`),
  `materialRole?`, `description?`, `qty: Decimal(14,4)?`, `unit?`,
  `status @default("ACTIVE")` (`ACTIVE` / `REVOKED`),
  `comment?`, `createdById?`, `revokedAt?`, `revokedById?`,
  `revokeReason?`. Индексы: `orderId`, `workshopNeedId`, `status`,
  `materialRole`. См. `CutReadinessService` — override прибавляется к
  `placedQty`.

<a id="213-printers--print-jobs"></a>
### 2.13 Printers / print jobs

- **`Printer`** — принтер рабочего места. `name`,
  `type: PrinterType @default(DEFAULT)`,
  `equipmentId? → Equipment` (`SetNull`),
  `isActive`, `pairingCode?`, `agentToken?`,
  `isOnline @default(false)`, `lastSeenAt?`,
  `agentHostName?`, `availableWindowsPrinters: String[] @default([])`,
  `windowsPrintersUpdatedAt?`, `selectedWindowsPrinter?`. Индексы:
  `(equipmentId, isActive)`, `isOnline`, `pairingCode`, `agentToken`.
- **`PrintJob`** — задание на печать. `printerId → Printer` (cascade),
  `sourceType: PrintJobSource`, `sourceId?`, `payloadUrl`,
  `status: PrintJobStatus @default(PENDING)`, `errorMessage?`,
  `completedAt?`. Индексы: `(printerId, status, createdAt)`,
  `(status, createdAt)`. См. ADR-0010 (рендер на стороне backend
  через `payloadUrl`, агент работает с непрозрачным URL).

<a id="214-audit"></a>
### 2.14 Audit

- **`AuditLog`** — универсальный журнал управленческих событий.
  `event: String`, `entityType: String`, `entityId: String`,
  `payload: Json`, `employeeId? (without FK)`, `createdAt`.
  Индексы: `(entityType, entityId)`, `createdAt`. Записывается в той
  же `prisma.$transaction`, что и сама бизнес-операция (`AuditService.log`).
- **`CutReleasePolicy`** *(новый контур)* — управленческий лимит на
  выдачу кроя. `isActive`, `color?`, `sizeId?`, `limitQty: Int`,
  `consumedQty @default(0)`, `createdById: String` (без FK),
  `createdAt / updatedAt`. На MVP единовременно максимум одна
  активная (enforcement в сервисе). Используется
  `PassportsService.issueToEmployee`.
- **`OrderCutIssueRule`** *(новый контур)* — «очередь выдачи кроя по
  размерам внутри заказа». `orderId → Order` (`onDelete: Cascade`),
  `sizeId → Size` (`onDelete: Restrict`), `requiredQty: Int`,
  `issuedQty: Int @default(0)` (materialized counter, инкрементится в
  той же транзакции, что и `PassportsService.issueToEmployee`),
  `sortOrder: Int @default(0)`, `isActive: Boolean @default(true)`,
  `createdById: String?` (без FK), `createdAt / updatedAt`. Уникальность
  `(orderId, sizeId)` + индексы `(orderId, isActive)` и `(sizeId)`.
  Применяется ДО `CutReleasePolicy` и только на ПЕРВОЙ операции
  маршрута / категории `CUTTING` (см. `docs/domain.md §«Очередь
  выдачи кроя»`).

<a id="215-company-settings"></a>
### 2.15 Company settings

- **`CompanySettings`** *(новый контур)* — singleton-настройки
  организации (юр. название / ИНН / банковские реквизиты / директор).
  - `id String @id @default("default")` + `singleton Boolean @unique
    @default(true)` гарантируют, что в таблице не больше одной строки
    (вторая `INSERT` валится на уровне БД).
  - все поля реквизитов — `String?` без жёсткой длины; формат
    (10/12 цифр для ИНН, 9 — БИК/КПП, 13/15 — ОГРН, 20 —
    settlement/correspondent) валидируется Zod-ом в
    `@sewing/shared/company-settings`, а не БД.
  - сервис `CompanySettingsService.getOrCreate()` идемпотентно создаёт
    запись с дефолтами при первом обращении.
- **`CompanyDivision`** *(master-справочник)* — soft-delete справочник
  подразделений заказа и display screens.
  - `code String @unique`, `name String`, `description String?`,
    `isActive Boolean @default(true)`, `sortOrder Int @default(100)`.
  - индексы: `isActive`, `sortOrder`.
  - На этот справочник ссылаются `Order.companyDivisionId`,
    `DisplayScreenConfig.companyDivisionId` и (PHASE 2 STEP 2)
    `Employee.companyDivisionId` — основная привязка сотрудника
    к подразделению, см. §2.1. Базовые карточки `MARKETPLACE` /
    `OTHER` гарантированно созданы миграцией
    `…_link_company_divisions_to_orders` и `prisma/seed.ts` /
    `tests/utils/seed.ts`. Маппинг `code → cutter compensation
    scheme` живёт в `getCutterCompensationSchemeForDivision`
    (`MARKETPLACE` → `MARKETPLACE_FIXED`, всё остальное —
    `B2B_SEWING_PERCENT`). См. `docs/domain.md §«Подразделения
    заказа»`.
  - Inverse relations: `orders Order[]`, `displayScreens
    DisplayScreenConfig[]`, `employees Employee[]` — все
    `onDelete: SetNull` со стороны привязки, чтобы деактивация
    карточки не сносила заказ / экран / сотрудника.
- Audit под `entityType = COMPANY_SETTINGS` / `COMPANY_DIVISION`
  (см. `docs/events.md §3.2`).

---

<a id="3-new-contours"></a>
## 3. Новые контуры (детальные карточки)

### 3.1 Pattern* (Лекала)

Источник: `prisma/schema.prisma::PatternItem` /
`PatternCategory` / `PatternCategoryParameter` / `PatternSizeFile` /
`PatternMaterialArea` / `PatternItemParameterNorm` /
`PatternItemSizeParameterValue`.

- **Карточка лекала** (`PatternItem`) хранит конструкцию изделия:
  артикул (uniq), категория, статус, превью, опционально legacy
  Product (для совместимости с paspport / pieceRate / старым flow).
- **Категория** (`PatternCategory`) задаёт колонки таблицы «Площади
  материалов». Параметр (`PatternCategoryParameter.inputType`)
  определяет, в какую таблицу пишутся значения:
  - `AREA_M2_BY_SIZE` → `PatternMaterialArea` (м² по размерам);
  - `QTY_PER_ITEM` → `PatternItemParameterNorm` (норма на изделие,
    например, «Люверсы = 2 шт»);
  - `LINEAR_M_BY_SIZE` → `PatternItemSizeParameterValue`
    (погонные метры по размерам).
- **DXF-файлы** (`PatternSizeFile`) версионируются по
  `(patternItemId, sizeId)`; «удаление» = `status = ARCHIVED`,
  физический файл не удаляется.
- **Soft-интеграция с заказом**: `Order.patternItemId? → PatternItem`
  (`SetNull`). При запуске snapshot фиксируется в
  `Order.patternNameSnapshot / patternArticleSnapshot /
  patternPreviewSnapshotUrl`.

### 3.2 WorkshopNeed (Потребности цеха)

Источник: `prisma/schema.prisma::WorkshopNeed`,
`apps/api/src/modules/workshop-needs/*`.

- Чистая потребность заказа, рассчитанная системой по
  «лекало × техкарта × размерная матрица × нанесения». Closer
  reference — `WorkshopNeedsService.calculateForOrder`.
- НЕ закупочный документ и НЕ складской остаток. Связи:
  - `selectedSupplierId? → Supplier` (`SetNull`);
  - `selectedSupplierCatalogItemId? → SupplierCatalogItem` (`SetNull`);
  - `purchaseOrderLines: PurchaseOrderLine[]` (`SetNull` со стороны
    PO-line, чтобы PO выжил при cascade-удалении заказа);
  - `receiptLines: PurchaseReceiptLine[]` (тот же паттерн);
  - `costEstimateLines: OrderCostEstimateLine[]` (`SetNull`);
  - `materialArrivalOverrides: OrderMaterialArrivalOverride[]`
    (`SetNull`).
- `status` управляется backend-ом (`PURCHASE_PLANNED` /
  `ORDERED` / `PARTIALLY_RECEIVED` / `RECEIVED` /
  `CANCELLED`) — ручной правке доступны только
  `purchaseQty`/`quotedPrice`/`expectedDeliveryDate` через
  `PATCH /api/workshop-needs/:id`.

### 3.3 Supplier / SupplierContact / SupplierCatalogItem

Источник: `prisma/schema.prisma::Supplier` (+ contact + catalog),
`apps/api/src/modules/suppliers/*`.

- Изолированный справочник: НЕТ vendor-portal, НЕТ интеграций,
  НЕТ финансовых документов. Только название + контакты + позиции.
- `WorkshopNeed` использует `Supplier` мягко: `selectedSupplierId`
  опционален, fallback — `supplierNameText`.
- Удаление поставщика блокируется со стороны `PurchaseOrder`
  (`onDelete: Restrict`).

### 3.4 PurchaseOrder / PurchaseReceipt

Источник: `prisma/schema.prisma::PurchaseOrder` /
`PurchaseOrderLine` / `PurchaseReceipt` / `PurchaseReceiptLine`.

- **PO** создаётся из `WorkshopNeed` через
  `POST /api/purchase-orders/from-needs`. Линии копируют snapshot
  номенклатуры (имя / артикул / unit / catalog-цена) и `qty/price`
  из потребности. Один PO — один поставщик; на MVP запрещено
  смешивать строки разных заказов покупателя.
- **PR** создаётся из PO через
  `POST /api/purchase-receipts/from-purchase-order`. Линии PR
  фиксируют размещение в ячейке (`Cell.cellId`) **без** записи в
  `CellContent` — это сознательная граница MVP.
- Cancel-flow возвращает связанные `WorkshopNeed.status` обратно
  (см. сервис; список валидных переходов — в shared-listе
  `WORKSHOP_NEED_STATUSES`).

### 3.5 OrderCostEstimate

Источник: `prisma/schema.prisma::OrderCostEstimate` /
`OrderCostEstimateLine`,
`apps/api/src/modules/orders/order-cost-estimates.service.ts`.

- Документ «Себестоимость заказа» — снимок цен/количеств на момент
  завершения расчёта (`completeCalculation`). Один заказ может
  иметь много расчётов (`(orderId, version)` uniq); активный —
  `status = COMPLETED`. Reopen-action помечает старый как `REVOKED`,
  следующий complete создаёт новую запись с `version = max + 1`.
- Snapshot переписывается «как есть»: имя поставщика,
  имя номенклатуры, цена, валюта, курс USD на момент расчёта.

### 3.6 OperationTimeNormBySize

Источник: `prisma/schema.prisma::OperationTimeNormBySize`,
`docs/operation-time-norms-recon.md §10`.

- Параллельная ось `OperationRateBySize`, но плановая (норма времени
  в секундах). Заполняется из `/admin/operations/[id]` для операций с
  `Operation.timeNormMode = "BY_SIZE"`. **Payroll-контур
  не использует**: это входит только в плановую оценку
  `Order.operationTimePlanSec` через
  `OrderOperationPlanService.recalculateAndWrite()`.

### 3.7 CutReleasePolicy

Источник: `prisma/schema.prisma::CutReleasePolicy`,
`apps/api/src/modules/cut-release-policy/*`.

- Лимит выдачи кроя сотрудникам на ПЕРВОЙ операции маршрута (или
  `OperationCategory.CUTTING`). Мастер цеха задаёт фильтр
  (`color`/`sizeId`) + лимит штук → backend режет
  `PassportsService.issueToEmployee` для несоответствующих
  паспортов и инкрементит `consumedQty` для прошедших.
- На MVP единовременно максимум одна активная политика.

### 3.8 OrderCutIssueRule

Источник: `prisma/schema.prisma::OrderCutIssueRule`,
`apps/api/src/modules/order-cut-issue-rules/*`,
`docs/domain.md §«Очередь выдачи кроя»`.

- «Очередь выдачи кроя по размерам внутри заказа» — менеджер задаёт
  набор строк `(размер, requiredQty)`, и пока хотя бы одна активная
  строка не выполнена, `PassportsService.issueToEmployee` блокирует
  паспорта «не очередных» размеров адресной 409
  `ORDER_CUT_ISSUE_RULE_VIOLATION` (текст собирается
  `formatOrderCutIssueRuleViolationMessage` из `@sewing/shared`).
- Materialized counter `issuedQty` инкрементится в той же транзакции,
  что и `passport.update + passportEvent.create + audit.log` (через
  conditional `updateMany`, как у `CutReleasePolicy.consumedQty`).
  Превышение лимита и race с `disable-all` ловятся пересчётом 0
  затронутых строк.
- Применяется ТОЛЬКО на ПЕРВОЙ операции маршрута
  (`Passport.currentRouteStepIndex === 0`) или операциях категории
  `CUTTING` — точно так же, как `CutReleasePolicy`. Порядок проверок
  внутри `issueToEmployee`: `OrderCutIssueRule → CutReleasePolicy`.
- bulk-upsert (`POST /api/orders/:id/cut-issue-rules`) — source of
  truth формы карточки заказа: строки, не пришедшие в payload,
  переводятся в `isActive = false`. Полное отключение — отдельный
  endpoint `/cut-issue-rules/disable-all`. `requiredQty` нельзя
  опустить ниже `issuedQty` (422
  `ORDER_CUT_ISSUE_RULE_REQUIRED_BELOW_ISSUED`) и поднять выше
  плана по размеру (422
  `ORDER_CUT_ISSUE_RULE_REQUIRED_ABOVE_PLAN`).

### 3.9 OrderMaterialArrivalOverride

Источник: `prisma/schema.prisma::OrderMaterialArrivalOverride`,
`apps/api/src/modules/order-material-arrivals/*`,
`apps/api/src/modules/cut-readiness/cut-readiness.service.ts`.

- Ручная override-кнопка «Материал поступил» в карточке заказа.
  Не складская операция (НЕТ `PurchaseReceipt`, НЕТ `CellContent`,
  НЕТ изменения `WorkshopNeed.status`). Используется только
  `CutReadinessService`: `ACTIVE`-override-ы прибавляются к
  `placedQty` и могут разблокировать крой даже при
  `WorkshopNeed.status != RECEIVED`.

---

## 4. Что НЕ описано в этом документе (умышленно)

PHASE 1 не повторяет:

- DDL миграций (`prisma/migrations/**`). Источник истины — папка миграций.
- partial-unique-индексы / `idempotent CREATE INDEX` блоки в
  `PrismaService.onModuleInit` (см. ADR-0015,
  `apps/api/src/prisma/prisma.service.ts`).
- триггеры / `EXTENSION`-ы / SQL-функции (на момент PHASE 1
  ничего такого в схеме нет — Postgres-настройки тривиальны).

---

## 5. Команды быстрой инвентаризации

```bash
rg "^(model|enum) " prisma/schema.prisma     # все модели и enum
rg "@@unique"        prisma/schema.prisma     # составные unique-ключи
rg "@@index"         prisma/schema.prisma     # составные индексы
rg "onDelete"        prisma/schema.prisma     # каскады/SetNull/Restrict
npx prisma validate                           # проверка валидности схемы
```
