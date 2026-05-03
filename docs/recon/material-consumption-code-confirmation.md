# Material Consumption Code Confirmation RECON

> **Дата:** 2026-05-03
> **Назначение:** Подтверждение в коде элементов ТЗ по модулю списания материалов со склада.
> **Важно:** Этот документ НЕ реализует функционал, а только фиксирует, что найдено/не найдено в проекте.

---

## 1. Stack and project structure

**Источник:** `docs/current-state.md`.

- **Backend:** NestJS (TypeScript), Prisma ORM (PostgreSQL)
- **Frontend:** Next.js (App Router, React Server Components)
- **Shared types:** `packages/shared` (TS)
- **Auth:** session-cookie HMAC-SHA256, RBAC через `AuthGuard` + `@Roles()`
- **Node:** `>=20`, менеджер пакетов — npm workspaces

**Структура:**

```
apps/
  api/      — NestJS API
  web/      — Next.js (UI)
prisma/
  schema.prisma   — источник истины модели БД
  seed.ts
  migrations/
docs/
packages/
  shared/   — общие типы
```

**Команды:**

- `npm run dev:api` / `npm run dev:web`
- `npm run prisma:generate` / `npm run prisma:migrate`
- `npm run docs:check` — проверка консистентности docs

---

## 2. Prisma / DB models found

**Источник истины:** `prisma/schema.prisma`.

Всего моделей: **61** (см. `docs/erd.md §2`).

**Ключевые enum-ы для материалов:**

```prisma
enum Role {
  SHOP_MANAGER
  CUTTER
  CUTTER_ASSISTANT
  SEAMSTRESS
  QC
  IRONING
  PACKING
  ADMIN
  DISPLAY
  SHOPFLOOR_MASTER
}
```

**НЕ найдены роли:**

- `WAREHOUSE_MANAGER`
- `PURCHASER`
- `ACCOUNTANT`

---

## 3. Materials and nomenclature

### 3.1. Найденные сущности

#### `TechCardMaterialLine`

- **Файл:** `prisma/schema.prisma` (строки 2119–2178)
- **Назначение:** строка материала в шаблоне техкарты
- **Ключевые поля:**
  - `techCardTemplateId → TechCardTemplate`
  - `qtyPerUnit: Decimal(12,4)`
  - `unit: String`
  - `name: String`
  - `materialRole?: String` (свободная строка из `MATERIAL_ROLES`)
  - `fabricType?: String`
  - `densityGsm: Int?`
  - `plannedWidthCm: Int?`
  - `colorRule?: String` (`ORDER_COLOR` / `FIXED_COLOR` / etc.)
  - `materialImageUrl?: String`
- **Связи:** cascade от `TechCardTemplate`
- **Можно ли использовать:** ДА, это источник плановой потребности материалов для заказа
- **Индексы:** `materialRole`

#### `OrderMaterialRequirement`

- **Файл:** `prisma/schema.prisma` (строки 2219–2291)
- **Назначение:** snapshot материала на заказе (создаётся при `start-calculation`)
- **Ключевые поля:**
  - `orderId → Order` (cascade)
  - `sourceTechCardLineId? → TechCardMaterialLine` (SetNull)
  - `qtyPerUnit: Decimal(12,4)`
  - `totalQty: Decimal(12,4)`
  - `unit: String`
  - `name: String`
  - `materialRole?: String`
  - `fabricType?: String`
  - `densityGsm: Int?`
  - `plannedWidthCm: Int?`
  - `colorRule?: String`
  - `resolvedColorText?: String`
- **Связи:** cascade от `Order`, SetNull от `TechCardMaterialLine`
- **Можно ли использовать:** ДА, это плановая потребность заказа (snapshot)

#### `WorkshopNeed`

- **Файл:** `prisma/schema.prisma` (строки 3098–3289)
- **Назначение:** потребность цеха (расчётная + закупочная)
- **Ключевые поля:**
  - `orderId → Order` (cascade)
  - `sourceType?: String` (материал / фурнитура / нанесение)
  - `sourceId?: String` (ID источника потребности)
  - `materialRole?: String`
  - `sourceName?: String`
  - `description: String`
  - `fabricType?: String`
  - `densityGsm: Int?`
  - `plannedWidthCm: Int?`
  - `colorRule?: String`
  - `totalAreaM2?: Decimal(14,4)`
  - `calculatedQty: Decimal(14,4)`
  - `purchaseQty: Decimal?(14,4)`
  - `unit: String`
  - `calculationMethod: String` (`AREA_DENSITY` / `QTY_PER_UNIT`)
  - `status: String` (`CALCULATED` / `REVIEWED` / `PURCHASE_PLANNED` / `CANCELLED` / `ORDERED` / `PARTIALLY_RECEIVED` / `RECEIVED`)
  - `supplierNameText?: String`
  - `purchaseItemNameText?: String`
  - `quotedPrice?: Decimal(14,2)`
  - `quotedCurrency?: String`
  - `selectedSupplierId? → Supplier` (SetNull)
  - `selectedSupplierCatalogItemId? → SupplierCatalogItem` (SetNull)
- **Связи:** cascade от `Order`, SetNull от `Supplier` и `SupplierCatalogItem`
- **Индексы:** `orderId`, `status`, `materialRole`, `calculationMethod`, `selectedSupplierId`, `selectedSupplierCatalogItemId`
- **Можно ли использовать:** ДА, это источник истины для закупки и планирования

#### `SupplierCatalogItem`

- **Файл:** `prisma/schema.prisma` (строки 3366–3413)
- **Назначение:** позиция каталога поставщика
- **Ключевые поля:**
  - `supplierId → Supplier` (cascade)
  - `name: String`
  - `supplierArticle?: String`
  - `category?: String`
  - `fabricType?: String`
  - `densityGsm: Int?`
  - `colorText?: String`
  - `unit: String`
  - `lastPrice: Decimal(14,2)?`
  - `currency?: String`
  - `minOrderQty?: Decimal(14,4)?`
  - `deliveryDays: Int?`
  - `status: String` (`ACTIVE` / `INACTIVE`)
- **Связи:** cascade от `Supplier`
- **Можно ли использовать:** ДА, это источник цен и номенклатуры поставщика

#### `PatternMaterialArea`

- **Файл:** `prisma/schema.prisma` (строки не указаны, см. `docs/erd.md §3.1`)
- **Назначение:** площадь материала на размере (м²)
- **Ключевые поля:**
  - `patternItemId → PatternItem`
  - `sizeId → Size`
  - `materialRole: String`
  - `areaM2: Decimal(10,4)`
- **Связи:** cascade от `PatternItem`, уникальность `(patternItemId, sizeId, materialRole)`
- **Можно ли использовать:** ДА, используется для расчёта `totalAreaM2` в `WorkshopNeed`

#### `OrderMaterialArrivalOverride`

- **Файл:** `prisma/schema.prisma` (строки 4075–4141)
- **Назначение:** ручная отметка «материал поступил» в карточке заказа
- **Ключевые поля:**
  - `orderId → Order` (cascade)
  - `workshopNeedId? → WorkshopNeed` (SetNull)
  - `materialRole?: String`
  - `description?: String`
  - `qty: Decimal(14,4)?`
  - `unit?: String`
  - `status: String` (`ACTIVE` / `REVOKED`)
  - `comment?: String`
  - `createdById?: String`
  - `revokedAt?: DateTime`
  - `revokedById?: String`
  - `revokeReason?: String`
- **Связи:** cascade от `Order`, SetNull от `WorkshopNeed`
- **Индексы:** `orderId`, `workshopNeedId`, `status`, `materialRole`
- **Можно ли использовать:** НЕТ, это управленческий override для готовности к крою, а не фактическое списание

### 3.2. НЕ найденные сущности

- ❌ `Material` — отдельной модели номенклатуры материалов нет
- ❌ `Nomenclature` — не найдено
- ❌ `Item` — не найдено (есть только `OrderItem` для размерной матрицы заказа)
- ❌ `ProductMaterial` — не найдено
- ❌ `MaterialRequirement` — есть только `OrderMaterialRequirement` (snapshot)
- ❌ `MaterialIssue` — **НЕ НАЙДЕНО**
- ❌ `MaterialIssueLine` — **НЕ НАЙДЕНО**
- ❌ `MaterialConsumptionRule` — **НЕ НАЙДЕНО**

**Вывод:** В проекте **нет** отдельной master-номенклатуры материалов. Материалы описываются:

1. В техкарте (`TechCardMaterialLine`) — плановая спецификация
2. В каталоге поставщика (`SupplierCatalogItem`) — номенклатура + цена
3. В потребности цеха (`WorkshopNeed`) — расчётная + закупочная
4. В площадях лекала (`PatternMaterialArea`) — норма расхода по размерам

---

## 4. Warehouse and stock

### 4.1. Найденные сущности

#### `Warehouse`

- **Файл:** `prisma/schema.prisma` (строки 1654–1686)
- **Ключевые поля:**
  - `name: String @unique`
  - `code: String? @unique`
  - `isActive: Boolean @default(true)`
  - `labelTemplate?: String`
- **Связи:** `Cell[]`, `WarehouseLine[]`
- **Индексы:** `isActive`
- **Можно ли использовать:** ДА

#### `WarehouseLine`

- **Файл:** `prisma/schema.prisma` (строки 1688–1701)
- **Ключевые поля:**
  - `warehouseId → Warehouse`
  - `code: String @unique` (глобально)
- **Связи:** cascade от `Warehouse`
- **Можно ли использовать:** ДА, для организации ячеек

#### `Cell`

- **Файл:** `prisma/schema.prisma` (строки 1703–1743)
- **Ключевые поля:**
  - `code: String @unique`
  - `qrCode: String @unique`
  - `active: Boolean @default(true)`
  - `warehouseId? → Warehouse`
  - `lineId? → WarehouseLine` (SetNull)
  - `lineIndex: Int?`
- **Связи:** `CellContent[]`, `PassportEvent[]`, `Passport.currentCellId`, `PurchaseReceiptLine.cellId`
- **Индексы:** `warehouseId`, `lineId`, `(lineId, lineIndex)` uniq
- **Можно ли использовать:** ДА, для размещения паспортов и поступлений

#### `CellContent`

- **Файл:** `prisma/schema.prisma` (строки 1745–1766)
- **Ключевые поля:**
  - `cellId → Cell`
  - `sizeId → Size`
  - `quantity: Int @default(0)`
- **Связи:** `(cellId, sizeId)` uniq
- **Можно ли использовать:** ЧАСТИЧНО — это лёгкий счётчик для размещения паспортов, но **не** складской учёт материалов

### 4.2. НЕ найденные сущности

- ❌ `StockBalance` — **НЕ НАЙДЕНО**
- ❌ `StockMovement` — **НЕ НАЙДЕНО**
- ❌ `MaterialStockLot` — **НЕ НАЙДЕНО**
- ❌ `WarehouseReceipt` (приход) — **НЕ НАЙДЕНО** как отдельная складская операция
- ❌ `WarehouseIssue` (расход) — **НЕ НАЙДЕНО**
- ❌ `InventoryAdjustment` (корректировка) — **НЕ НАЙДЕНО**
- ❌ `StockReservation` (резервирование) — **НЕ НАЙДЕНО**
- ❌ `MaterialWriteOff` (списание) — **НЕ НАЙДЕНО**

### 4.3. Что найдено про приход/расход/цену

#### Приход материалов

**Найдено:** `PurchaseReceiptLine` (строки 3711–3853)

- **Ключевые поля:**
  - `purchaseReceiptId → PurchaseReceipt` (cascade)
  - `purchaseOrderLineId?: String` (SetNull)
  - `workshopNeedId?: String` (SetNull)
  - `supplierCatalogItemId?: String` (SetNull)
  - `receivedQty: Decimal(14,4)`
  - `unit: String`
  - `cellId? → Cell` (SetNull)
  - `locationNote?: String`
  - `batchNumber?: String`
  - `rollNumber?: String`
  - `shade?: String`
  - `actualWidthCm: Int?`
  - `actualDensityGsm: Int?`
  - `priceSnapshot?: Decimal(14,2)`
  - `currencySnapshot?: String`
  - `status: String` (`POSTED` / `CANCELLED`)
- **Можно ли использовать:** ДА, для фиксации прихода материалов с ценой и размещением в ячейке
- **Ограничение:** **НЕТ** записи в `CellContent` при приходе (см. `docs/erd.md §3.4`)

#### Расход материалов

**НЕ НАЙДЕНО:** Отдельной модели расхода/списания материалов **не существует**.

#### Цена материала

**Найдено:**

1. `WorkshopNeed.quotedPrice` — котируемая цена (из запроса поставщику)
2. `PurchaseOrderLine.price` — цена в заказе поставщику
3. `PurchaseOrderLine.confirmedPrice` — подтверждённая поставщиком цена
4. `PurchaseReceiptLine.priceSnapshot` — фактическая цена при приёмке
5. `SupplierCatalogItem.lastPrice` — последняя цена из каталога

**Нет:** единой таблицы `unitCost` или `materialPrice` для складского учёта.

#### Единицы измерения

**Найдено:** поле `unit: String` во всех сущностях материалов (свободная строка, не enum).

**Вывод:** Складской учёт материалов по остаткам **не реализован**. Есть только:

- Приход через `PurchaseReceiptLine` (с размещением в `Cell`, но без записи баланса)
- `CellContent` учитывает только паспорта (по размерам), а не материалы

---

## 5. Purchase and receipts

### 5.1. Найденные сущности

#### `Supplier`

- **Файл:** `prisma/schema.prisma` (строки 3291–3334)
- **Ключевые поля:** `name`, `phone`, `website`, `address`, `status: String` (`ACTIVE` / `INACTIVE`)
- **Связи:** `SupplierContact[]`, `SupplierCatalogItem[]`, `PurchaseOrder[]`, `WorkshopNeed[]`
- **Индексы:** `status`, `name`
- **Можно ли использовать:** ДА

#### `PurchaseOrder`

- **Файл:** `prisma/schema.prisma` (строки 3468–3536)
- **Ключевые поля:**
  - `number: String @unique` (`PO-YYYYMMDD-NNNN`)
  - `supplierId → Supplier` (Restrict)
  - `customerOrderId? → Order` (SetNull)
  - `status: String` (`DRAFT` / `SENT` / `CONFIRMED` / `CANCELLED`)
  - `expectedDeliveryDate?: DateTime`
  - `sentAt?: DateTime`
  - `confirmedAt?: DateTime`
  - `cancelledAt?: DateTime`
  - `createdById? → Employee` (SetNull)
- **Связи:** `PurchaseOrderLine[]`, `PurchaseReceipt[]`
- **Индексы:** `supplierId`, `customerOrderId`, `status`, `expectedDeliveryDate`, `createdAt`
- **Можно ли использовать:** ДА

#### `PurchaseOrderLine`

- **Файл:** `prisma/schema.prisma` (строки 3538–3641)
- **Ключевые поля:**
  - `purchaseOrderId → PurchaseOrder` (cascade)
  - `workshopNeedId? → WorkshopNeed` (SetNull)
  - `supplierCatalogItemId? → SupplierCatalogItem` (SetNull)
  - `qty: Decimal(14,4)`
  - `price: Decimal(14,2)?`
  - `currency?: String`
  - `confirmedQty: Decimal(14,4)?`
  - `confirmedPrice: Decimal(14,2)?`
  - `status: String` (`DRAFT` / `SENT` / `CONFIRMED` / `CANCELLED`)
- **Связи:** cascade от `PurchaseOrder`, SetNull от `WorkshopNeed` и `SupplierCatalogItem`
- **Можно ли использовать:** ДА

#### `PurchaseReceipt`

- **Файл:** `prisma/schema.prisma` (строки 3643–3709)
- **Ключевые поля:**
  - `number: String @unique` (`PR-YYYYMMDD-NNNN`)
  - `purchaseOrderId → PurchaseOrder` (Restrict)
  - `supplierId? → Supplier` (SetNull)
  - `customerOrderId? → Order` (SetNull)
  - `status: String` (`POSTED` / `CANCELLED`)
  - `receivedAt: DateTime @default(now())`
  - `cancelledAt?: DateTime`
  - `receivedById? → Employee` (SetNull)
- **Связи:** `PurchaseReceiptLine[]`
- **Можно ли использовать:** ДА

#### `PurchaseReceiptLine`

- См. §4.3 выше.

### 5.2. Интеграция с материалами

**Найдено:**

1. **Связь PO с потребностью:**
   - `PurchaseOrderLine.workshopNeedId? → WorkshopNeed` (SetNull)
   - При создании PO из потребности копируется snapshot номенклатуры

2. **Связь PR с PO:**
   - `PurchaseReceipt.purchaseOrderId → PurchaseOrder` (Restrict)
   - `PurchaseReceiptLine.purchaseOrderLineId?: String` (SetNull, денормализация)
   - `PurchaseReceiptLine.workshopNeedId?: String` (SetNull, денормализация)

3. **Складской приход из поступления:**
   - `PurchaseReceiptLine.cellId? → Cell` (SetNull)
   - `PurchaseReceiptLine.locationNote?: String`
   - **НЕТ** записи в `CellContent` или `StockBalance`

4. **Цена закупки:**
   - `PurchaseReceiptLine.priceSnapshot?: Decimal(14,2)`
   - `PurchaseReceiptLine.currencySnapshot?: String`

5. **Quantity received:**
   - `PurchaseReceiptLine.receivedQty: Decimal(14,4)`
   - `PurchaseReceiptLine.unit: String`

### 5.3. API

**Источник:** `docs/api.md §19–20`.

**PurchaseOrder:**

- `GET /api/purchase-orders` — список
- `GET /api/purchase-orders/:id` — карточка
- `POST /api/purchase-orders/from-needs` — создание из потребностей
- `PATCH /api/purchase-orders/:id` — правка
- `PATCH /api/purchase-orders/:id/lines/:lineId` — правка строки
- `POST /api/purchase-orders/:id/send` — отправка поставщику
- `POST /api/purchase-orders/:id/confirm` — подтверждение
- `POST /api/purchase-orders/:id/cancel` — отмена
- `GET /api/orders/:id/purchase-orders` — список PO по заказу

**PurchaseReceipt:**

- `GET /api/purchase-receipts` — список
- `GET /api/purchase-receipts/:id` — карточка
- `POST /api/purchase-receipts/from-purchase-order` — создание из PO
- `POST /api/purchase-receipts/:id/cancel` — отмена
- `GET /api/purchase-orders/:id/receipts` — список PR по PO
- `GET /api/orders/:id/purchase-receipts` — список PR по заказу

**Роли:** `ADMIN`, `SHOP_MANAGER`

---

## 6. Production flow

### 6.1. Найденные модели

#### `Passport`

- **Файл:** `prisma/schema.prisma` (строки 1265–1325)
- **Назначение:** агрегат-корень партии (size + color + roll)
- **Ключевые поля:**
  - `number: String @unique`
  - `qrCode: String @unique`
  - `orderId → Order`
  - `productId → Product`
  - `sizeId → Size`
  - `color: String`
  - `rollNumber: Int`
  - `cutDate: DateTime`
  - `qtyPlan: Int`
  - `qtyCut: Int`
  - `qtyDefect: Int @default(0)`
  - `qtyGood: Int`
  - `status: PassportStatus` (`CREATED` / `IN_PROGRESS` / `PACKED` / `CANCELLED`)
  - `currentOperationId?: String`
  - `currentEmployeeId?: String`
  - `currentCellId?: String`
  - `currentRouteStepIndex: Int?`
  - `cutterId → Employee`
  - `creatorId → Employee`
- **Связи:** `PassportEvent[]`, `OperationEntry[]`, `PassportDefect[]`, `BoxItem`, `Order`, `Size`
- **Индексы:** `(status, currentOperationId)`, `orderId`, `(sizeId, status)`, `createdAt`, `currentCellId`

#### `PassportEvent`

- **Файл:** `prisma/schema.prisma` (строки 1327–1355)
- **Назначение:** лог событий паспорта
- **Ключевые поля:**
  - `passportId → Passport`
  - `type: PassportEventType` (enum: `CREATED`, `OPERATION_STARTED`, `OPERATION_FINISHED`, `MOVED`, `DEFECT_RECORDED`, `CELL_PLACED`, `CELL_REMOVED`, `ISSUED_TO_EMPLOYEE`, `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`, `PACKED`, `CANCELLED`)
  - `operationId?: String`
  - `fromOperationId?: String`
  - `employeeId?: String`
  - `qty: Int?`
  - `defectQty: Int?`
  - `cellId?: String`
  - `boxId?: String`
  - `payload: Json?`
  - `createdAt: DateTime @default(now())`
- **Индексы:** `(passportId, createdAt)`, `(type, createdAt)`, `(operationId, createdAt)`

#### `OperationEntry`

- **Файл:** `prisma/schema.prisma` (строки 1357–1392)
- **Назначение:** сдельное начисление
- **Ключевые поля:**
  - `passportId → Passport`
  - `operationId → Operation`
  - `employeeId → Employee`
  - `qty: Int`
  - `ratePerUnit: Decimal(12,2)`
  - `amount: Decimal(12,2)`
  - `status: EntryStatus` (`PENDING`, `PENDING_RELEASE`, `APPROVED`, `CANCELLED`, `REVERSED`)
  - `approvalMode: ApprovalMode` (`IMMEDIATE`, `AFTER_RELEASE`)
  - `sourceEventType: EarningSource` (`PASSPORT_CREATED`, `OPERATION_TRANSITION`)
  - `sourceEventId?: String`
  - `createdAt: DateTime @default(now())`
- **Индексы:** `(employeeId, status, createdAt)`, `(status, createdAt)`, `passportId`
- **Уникальность:** `(passportId, operationId, employeeId, sourceEventType)` (идемпотентность)

### 6.2. Найденные методы производства

**Источник:** `apps/api/src/modules/passports/passports.service.ts`.

#### `create(dto)`

- **Строки:** 119–
- **Назначение:** создание паспорта раскройщиком
- **Side effects:**
  - Создаёт `Passport`
  - Пишет `PassportEvent(CREATED)`
  - Создаёт `OperationEntry` для раскройщика (mode `IMMEDIATE`)
  - Пишет `AuditLog(PASSPORT_CREATED)`
- **Роли:** `CUTTER`, `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`

#### `issueToEmployee(passportId, employeeId, tx)`

- **Строки:** 484–
- **Назначение:** швея «получает крой» (выдача задания сотруднику)
- **Side effects:**
  - Снимает паспорт с ячейки (`currentCellId = null`)
  - Выставляет `currentEmployeeId = employeeId`
  - Переводит `status = IN_PROGRESS`
  - Пишет `PassportEvent(ISSUED_TO_EMPLOYEE)`
  - Учитывает `CutReleasePolicy` (лимит выдачи кроя)
  - Учитывает `OrderCutIssueRule` (очередь выдачи по размерам)
- **Роли:** Any auth (employee из сессии)

#### `scanOnOperation(passportId, employeeId, operationId, equipmentId, tx)`

- **Строки:** 735–
- **Назначение:** сканирование паспорта на операции
- **Side effects:**
  - Переводит паспорт на `operationId` текущей смены
  - Для предыдущей операции пишет `OperationEntry(PENDING_RELEASE)` (для пошива)
  - Пишет `PassportEvent(OPERATION_SCAN)`
  - Делает `QC-gate` для `IRONING` (`WTO_PASSED` обязателен)
- **Роли:** Any auth

#### `completeOperationByEmployee(passportId, employeeId, tx)`

- **Строки:** 916–
- **Назначение:** завершение текущей операции сотрудником
- **Side effects:**
  - Обнуляет `currentEmployeeId`
  - Остаётся на текущей операции (не переходит на следующую)
- **Роли:** Any auth

#### Другие найденные методы:

- `placeInCell(passportId, cellId, tx)` — размещение в ячейке
- `recordDefect(passportId, defectTypeId, qty, comment, employeeId, tx)` — фиксация брака
- `completeQC(passportId, tx)` — пишет `PassportEvent(QC_PASSED)`
- `completeWTO(passportId, tx)` — пишет `PassportEvent(WTO_PASSED)`
- `addToBox(passportId, boxId, tx)` — упаковка в коробку (пишет `PACKED`, переводит `status = PACKED`)

### 6.3. НЕ найденные методы/сущности

- ❌ `issueToEmployee` с автосписанием материалов — **НЕ НАЙДЕНО**
- ❌ `releaseCut` (выдача кроя) как отдельный метод — **НЕ НАЙДЕНО** (есть `issueToEmployee`)
- ❌ `assignPassport` — **НЕ НАЙДЕНО** (есть `issueToEmployee` и master-actions)
- ❌ `MaterialIssue` при выдаче кроя — **НЕ НАЙДЕНО**
- ❌ Связь `Passport → MaterialIssue` — **НЕ НАЙДЕНО**

### 6.4. Связь Passport → Order

**Найдено:**

- `Passport.orderId → Order` (cascade от `Order`, см. `prisma/schema.prisma`)
- `Order.items: OrderItem[]` (размерная матрица)
- `Order.materialRequirements: OrderMaterialRequirement[]` (snapshot материалов)
- `Order.workshopNeeds: WorkshopNeed[]` (расчётная + закупочная потребность)

---

## 7. Order flow

### 7.1. Статусы заказа

**Источник:** `prisma/schema.prisma` (enum `OrderStatus`).

```prisma
enum OrderStatus {
  DRAFT
  CALCULATION
  CALCULATION_DONE
  IN_PRODUCTION
  DONE
  CANCELLED
}
```

**Переходы:**

- `DRAFT → CALCULATION` (через `POST /api/orders/:id/start-calculation`)
- `CALCULATION → CALCULATION_DONE` (через `POST /api/orders/:id/complete-calculation`)
- `CALCULATION_DONE → IN_PRODUCTION` (через `POST /api/orders/:id/start`)
- `IN_PRODUCTION → DONE` (через `POST /api/orders/:id/complete`)

### 7.2. Материалы заказа

**Источник:** `docs/api.md §13`.

**API:**

- `GET /api/orders/:id` — карточка заказа (содержит `materialRequirements` snapshot)
- `POST /api/orders/:id/start-calculation` — рассчитывает `WorkshopNeed[]` по заказу
- `GET /api/orders/:id/workshop-needs` — список потребностей одного заказа
- `GET /api/orders/:id/material-arrival-overrides` — список ручных отметок прихода
- `POST /api/orders/:id/material-arrived` — создать ручную отметку прихода
- `GET /api/orders/:id/cut-readiness` — read-only сводка готовности к крою

**НЕ найдены API:**

- ❌ `GET /api/orders/:orderId/materials` — **НЕ НАЙДЕНО**
- ❌ `POST /api/orders/:orderId/materials/recalculate` — **НЕ НАЙДЕНО** (есть `POST /api/orders/:id/workshop-needs/calculate`)
- ❌ `POST /api/material-issues` — **НЕ НАЙДЕНО**
- ❌ `POST /api/material-issues/:id/post` — **НЕ НАЙДЕНО**
- ❌ `POST /api/material-issues/:id/cancel` — **НЕ НАЙДЕНО**

---

## 8. Cost calculation

### 8.1. Найденные сервисы

#### `CostsService`

- **Файл:** `apps/api/src/modules/costs/costs.service.ts`
- **Назначение:** расчёт себестоимости выпуска за период
- **Методы:**
  - `getProductionCost(query)` — `/api/costs/production`
- **Алгоритм:**
  1. Период приходит в `[from..to]` (включительно по дню)
  2. По каждому паспорту, упакованному в этот период, считаем:
     - `piecework = Σ OperationEntry.amount (status=APPROVED)`
     - `salary = Σ durationMinutes × employee.minuteRate` (для QC/WTO/PACKING)
  3. День агрегата = дата `PACKED` event паспорта (UTC)
  4. Простой окладных сотрудников считается отдельно

**Что НЕТ:**

- ❌ `material cost` — **НЕ НАЙДЕНО** в `CostsService`
- ❌ Фактическое списание материалов — **НЕ НАЙДЕНО**

#### `ProductionCostV2Service`

- **Файл:** `apps/api/src/modules/costs/production-cost-v2.service.ts`
- **Назначение:** управленческий P&L по лекалам / заказам / операциям / сотрудникам / размерам
- **API:** `GET /api/admin/production-cost/v2`
- **Что считает:** пока только сдельные и окладные расходы (см. `docs/production-cost-v2-recon.md`)

#### `OrderCostEstimateService`

- **Файл:** `apps/api/src/modules/orders/order-cost-estimates.service.ts` (предположительно)
- **Назначение:** snapshot себестоимости заказа
- **Модель:** `OrderCostEstimate` (строки не указаны, см. `docs/erd.md §3.5`)
- **Ключевые поля:**
  - `orderId → Order` (cascade)
  - `version: Int` (`(orderId, version)` uniq)
  - `status: String` (`COMPLETED` / `REVOKED`)
  - `totalCostRub: Decimal(14,2)`
  - `usdRateRub: Decimal(14,4)?`
  - `completedAt: DateTime`
  - `completedById?: String`
- **Связи:** `OrderCostEstimateLine[]`
- **Что считает:** материалы, фурнитура, нанесения (из `WorkshopNeed.quotedPrice`)

**Модель `OrderCostEstimateLine`:**

- `workshopNeedId? → WorkshopNeed` (SetNull)
- `kind: String` (`MATERIAL` / `HARDWARE` / `APPLICATION` / `OTHER`)
- `description: String`
- `unit: String`
- `calculatedQty?: Decimal(14,4)`
- `purchaseQty: Decimal(14,4)`
- `quotedPrice: Decimal(14,2)`
- `quotedCurrency: String`
- `lineTotalOriginal: Decimal(14,2)`
- `lineTotalRub: Decimal(14,2)`

### 8.2. Откуда берётся material cost

**Найдено:**

1. **Плановая потребность:**
   - `WorkshopNeed.calculatedQty` (из лекала × техкарта × размерная матрица)
   - `WorkshopNeed.quotedPrice` (котируемая цена, ручной ввод закупщика)

2. **Закупка:**
   - `PurchaseOrderLine.price` (цена в заказе поставщику)
   - `PurchaseOrderLine.confirmedPrice` (подтверждённая поставщиком)

3. **Факт прихода:**
   - `PurchaseReceiptLine.priceSnapshot` (фактическая цена при приёмке)

4. **Snapshot себестоимости:**
   - `OrderCostEstimateLine` — фиксирует цены на момент `completeCalculation`

**Что НЕТ:**

- ❌ Фактическое списание материалов при выдаче кроя — **НЕ НАЙДЕНО**
- ❌ `unitCost` материала из складского остатка — **НЕ НАЙДЕНО**
- ❌ FIFO / LIFO / средневзвешенная цена — **НЕ НАЙДЕНО**

### 8.3. Куда подключать фактическое списание

**Вывод:**

1. **Создать новую модель `MaterialIssue` + `MaterialIssueLine`:**
   - Связать с `Passport` (один паспорт — один issue при выдаче)
   - Связать с `WorkshopNeed` (источник плана)
   - Фиксировать `issuedQty`, `unitCost`, `totalCost`

2. **Интегрировать с `PassportsService.issueToEmployee`:**
   - После выдачи кроя создавать `MaterialIssue(status=POSTED)`
   - Списывать `StockBalance` (если будет реализован)

3. **Расширить `CostsService.getProductionCost`:**
   - Добавить `materialCost = Σ MaterialIssueLine.totalCost` по паспорту
   - Итоговая себестоимость = `piecework + salary + materialCost`

4. **Расширить `OrderCostEstimate`:**
   - Добавить фактические material costs из `MaterialIssue`
   - Сравнить плановые (`OrderCostEstimateLine`) vs фактические

---

## 9. Frontend order card

### 9.1. Страница заказа

**Файл:** `apps/web/app/admin/orders/[id]/page.tsx`

**Структура:**

1. `OrderManagementHeader` — summary заказа + workflow-actions
2. `OrderActionCenter` — короткие задачи / предупреждения
3. `OrderViewTabs` — линейка вкладок:
   - **Производство** (`production`) — KPI стадий, размерный breakdown
   - **Паспорта** (`passports`) — список паспортов + фильтры
   - **План** (`plan`) — продукт / лекало / маршрут / техкарта / очередь выдачи кроя
   - **Операции** (`operations`) — `OrderOperationsUnifiedTable` (маршрут, нормы, план/факт)
   - **Сводно по заказу** (`costSummary`) — `OrderSummaryTab` → `OrderSummaryUnifiedTable` (финансовая вкладка: расходы, себестоимость, цена продажи, прибыль)
   - **Потребности** (`needs`) — `OrderNeedsTab` → `OrderMaterialsUnifiedTable` (материалы + готовность к крою + закупки + приёмки)
   - **История** (`history`) — empty-state (пока нет API audit-log)

### 9.2. Вкладка «Потребности»

**Файл:** `apps/web/components/orders/view/tabs/order-needs-tab.tsx`

**Компоненты:**

1. `OrderMaterialsUnifiedTable` — **canonical source of truth** для материалов заказа
   - **Файл:** `apps/web/components/orders/materials/order-materials-unified-table.tsx`
   - **Назначение:** компактная таблица всех материалов (потребность + готовность + закупка + приёмка)
   - **Источник данных:** `WorkshopNeed` + `PurchaseOrderLine` + `PurchaseReceiptLine`

2. Закупки (выборочно, если нужно)
3. Приёмки (выборочно, если нужно)
4. `OrderPlannedCostSummaryCard` — aggregate-only себестоимость (без itemized breakdown)

**ВАЖНО:** `OrderSummaryUnifiedTable` сюда **не подключать** — это itemized cost breakdown, его место в отдельной вкладке «Сводно по заказу».

### 9.3. Вкладка «Сводно по заказу»

**Файл:** `apps/web/components/orders/tabs/order-summary-tab.tsx`

**Компоненты:**

1. `OrderSummaryUnifiedTable` — itemized cost breakdown
   - **Файл:** `apps/web/components/orders/summary/order-summary-unified-table.tsx`
   - **Назначение:** финансовая таблица расходов (материалы, фурнитура, операции, нанесения), себестоимость, цена продажи, прибыль
   - **Источник данных:** `OrderCostEstimate` + `OrderCostEstimateLine` + `OperationEntry` (plan/fact)

### 9.4. Где лучше добавить вкладку «Материалы» (фактическое списание)

**Рекомендация:**

1. **Не создавать отдельную вкладку** — избыточно, т.к. уже есть «Потребности» и «Сводно».

2. **Расширить вкладку «Потребности»:**
   - Добавить секцию «Фактическое списание» после `OrderMaterialsUnifiedTable`
   - Показать список `MaterialIssue` по заказу (через паспорта)
   - Сравнить плановую потребность vs фактическое списание

3. **Или добавить блок в вкладку «Сводно по заказу»:**
   - После `OrderSummaryUnifiedTable` показать «Фактический расход материалов»
   - Сравнить плановую себестоимость материалов vs фактическую

**Вывод:** Лучше расширить существующую вкладку «Потребности», добавив секцию «Фактическое списание».

### 9.5. Server actions / API client

**Файл:** `apps/web/lib/orders-api.ts` (предположительно)

**Найденные функции:**

- `getOrder(orderId)` — карточка заказа
- `listOrderPassports(orderId)` — список паспортов
- `getOrderCutIssueRules(orderId)` — очередь выдачи кроя

**НЕ найдены:**

- ❌ `getOrderMaterials(orderId)` — **НЕ НАЙДЕНО** (материалы через `WorkshopNeed`)
- ❌ `recalculateMaterialRequirements(orderId)` — **НЕ НАЙДЕНО** (есть `calculateWorkshopNeeds`)
- ❌ `createMaterialIssue(dto)` — **НЕ НАЙДЕНО**
- ❌ `postMaterialIssue(id)` — **НЕ НАЙДЕНО**
- ❌ `cancelMaterialIssue(id)` — **НЕ НАЙДЕНО**

---

## 10. Audit

### 10.1. Модель AuditLog

**Файл:** `prisma/schema.prisma` (строки 2045–2056)

**Поля:**

- `id: String @id @default(cuid())`
- `event: String`
- `entityType: String`
- `entityId: String`
- `payload: Json`
- `employeeId?: String` (без FK)
- `createdAt: DateTime @default(now())`

**Индексы:**

- `(entityType, entityId)`
- `createdAt`

### 10.2. AuditEntityType

**Файл:** `apps/api/src/modules/audit/audit.service.ts` (строки 13–320)

**Найденные типы:**

- `PASSPORT`
- `ORDER`
- `ROUTE`
- `TECH_CARD`
- `PATTERN`
- `PATTERN_CATEGORY`
- `OPERATION`
- `EMPLOYEE`
- `CLIENT`
- `EQUIPMENT`
- `WORKSHOP_NEED`
- `SUPPLIER`
- `PURCHASE_ORDER`
- `PURCHASE_RECEIPT`
- `ORDER_APPLICATION`
- `ORDER_COST_ESTIMATE`
- `ORDER_MATERIAL_ARRIVAL_OVERRIDE`
- `CUTTING_CLOSURE_REQUEST`
- `CUT_RELEASE_POLICY`
- `ORDER_CUT_ISSUE_RULE`
- `MASTER_CALL`
- `MASTER_PASSPORT_ACTION`
- `DEFECT_TYPE`
- `PRINTER`
- `COMPANY_SETTINGS`
- `COMPANY_DIVISION`
- `SALARY_ENTRY`
- `PAYROLL_PAYOUT`
- `PAYROLL_ACCRUAL_DOCUMENT`

### 10.3. Можно ли добавить entityType для материалов

**Да**, можно добавить:

- `MATERIAL_ISSUE` — фактическое списание материалов
- `MATERIAL_CONSUMPTION` — синоним `MATERIAL_ISSUE`
- `MATERIAL_REQUIREMENT_RECALCULATED` — пересчёт плановой потребности (может быть событием `ORDER`)
- `MATERIAL_SHORTAGE_DETECTED` — дефицит материалов (может быть событием `ORDER`)
- `MATERIAL_REPLACED` — замена материала в заказе (может быть событием `ORDER` или `WORKSHOP_NEED`)

### 10.4. События для материалов

**Рекомендованные события:**

1. `MATERIAL_REQUIREMENT_RECALCULATED` (entityType `ORDER` или новый `MATERIAL_REQUIREMENT`)
   - Payload: `{ before: { materials: [...] }, after: { materials: [...] } }`

2. `MATERIAL_ISSUE_CREATED` (entityType `MATERIAL_ISSUE`)
   - Payload: `{ passportId, orderId, lines: [...], totalCost, createdById }`

3. `MATERIAL_ISSUE_POSTED` (entityType `MATERIAL_ISSUE`)
   - Payload: `{ passportId, orderId, postedById }`

4. `MATERIAL_ISSUE_CANCELLED` (entityType `MATERIAL_ISSUE`)
   - Payload: `{ passportId, orderId, cancelledById, reason }`

5. `MATERIAL_ISSUE_RETURNED` (entityType `MATERIAL_ISSUE`)
   - Payload: `{ passportId, orderId, returnedById, reason }`

6. `MATERIAL_SHORTAGE_DETECTED` (entityType `ORDER`)
   - Payload: `{ orderId, materialRole, required, available, shortage }`

7. `MATERIAL_REPLACED` (entityType `WORKSHOP_NEED` или `ORDER`)
   - Payload: `{ before: { materialRole, name, qty }, after: { materialRole, name, qty }, reason }`

### 10.5. AuditService

**Файл:** `apps/api/src/modules/audit/audit.service.ts` (строки 352–)

**Методы:**

- `log(tx, event, entityType, entityId, payload, employeeId?)`
  - Пишет запись в `AuditLog` в той же транзакции, что и бизнес-операция

**Обязательные поля:**

- `event: String` — имя события (например, `MATERIAL_ISSUE_CREATED`)
- `entityType: String` — тип сущности (например, `MATERIAL_ISSUE`)
- `entityId: String` — ID сущности
- `payload: Json` — детали события
- `employeeId?: String` — опционально, ID сотрудника

---

## 11. Roles and permissions

### 11.1. Реальные роли

**Источник:** `prisma/schema.prisma` (enum `Role`).

```prisma
enum Role {
  SHOP_MANAGER
  CUTTER
  CUTTER_ASSISTANT
  SEAMSTRESS
  QC
  IRONING
  PACKING
  ADMIN
  DISPLAY
  SHOPFLOOR_MASTER
}
```

**НЕ найдены роли:**

- ❌ `WAREHOUSE_MANAGER`
- ❌ `PURCHASER`
- ❌ `ACCOUNTANT`

### 11.2. Guards и decorators

**Источник:** `docs/api.md §«Общие соглашения»`.

- `AuthGuard` — глобальный, требует валидную сессию
- `@Public()` — исключение из `AuthGuard`
- `@Roles(...)` — метод-уровень переопределяет класс-уровень
- `ADMIN` глобально проходит любой `@Roles(...)`

**Найденные файлы:**

- `apps/api/src/modules/auth/auth.guard.ts`
- `apps/api/src/modules/auth/roles.guard.ts`
- `apps/api/src/modules/auth/roles.decorator.ts` (предположительно)

### 11.3. Frontend role checks

**Файл:** `apps/web/lib/rbac.ts` (предположительно)

**Найденные проверки:**

- `isManager` — `role === 'ADMIN' || role === 'SHOP_MANAGER'`
- `canSeeHome` — `!isWorkingRole(role)`
- `getPrimaryWorkspace(role)` — роутинг по роли

### 11.4. Матрица прав доступа для материалов

**Рекомендованная матрица:**

| Действие                           | ADMIN | SHOP_MANAGER | SHOPFLOOR_MASTER | CUTTER | CUTTER_ASSISTANT | SEAMSTRESS | QC | IRONING | PACKING | WAREHOUSE_MANAGER (нет) | PURCHASER (нет) | ACCOUNTANT (нет) |
|------------------------------------|-------|--------------|------------------|--------|------------------|-----------|----|---------|---------|-------------------------|--------------------|------------------|
| Смотреть материалы заказа          | ✅    | ✅           | ✅               | ✅     | ✅               | ❌        | ❌ | ❌      | ❌      | —                       | —                  | —                |
| Создать списание (ручное)          | ✅    | ✅           | ❌               | ❌     | ❌               | ❌        | ❌ | ❌      | ❌      | —                       | —                  | —                |
| Провести списание (post)           | ✅    | ✅           | ❌               | ❌     | ❌               | ❌        | ❌ | ❌      | ❌      | —                       | —                  | —                |
| Отменить списание (cancel)         | ✅    | ✅           | ❌               | ❌     | ❌               | ❌        | ❌ | ❌      | ❌      | —                       | —                  | —                |
| Вернуть материал (return)          | ✅    | ✅           | ❌               | ❌     | ❌               | ❌        | ❌ | ❌      | ❌      | —                       | —                  | —                |
| Менять цены/себестоимость          | ✅    | ✅           | ❌               | ❌     | ❌               | ❌        | ❌ | ❌      | ❌      | —                       | —                  | —                |

**Вывод:** Для MVP достаточно `ADMIN` и `SHOP_MANAGER`. Остальные роли (`WAREHOUSE_MANAGER`, `PURCHASER`, `ACCOUNTANT`) в проекте не реализованы.

---

## 12. Existing APIs

### 12.1. API материалов

**Найденные:**

- ❌ `GET /api/orders/:orderId/materials` — **НЕ НАЙДЕНО**
- ❌ `POST /api/orders/:orderId/materials/recalculate` — **НЕ НАЙДЕНО**

**Есть аналоги:**

- ✅ `POST /api/orders/:id/workshop-needs/calculate` — пересчёт потребностей (аналог `recalculate`)
- ✅ `GET /api/orders/:id/workshop-needs` — список потребностей (аналог `GET /materials`)
- ✅ `GET /api/workshop-needs/:id` — карточка потребности

**Контроллер:** `apps/api/src/modules/workshop-needs/workshop-needs.controller.ts`

**Роли:** `ADMIN`, `SHOP_MANAGER`

### 12.2. API списания материалов

**НЕ найдены:**

- ❌ `POST /api/material-issues` — **НЕ НАЙДЕНО**
- ❌ `GET /api/material-issues` — **НЕ НАЙДЕНО**
- ❌ `GET /api/material-issues/:id` — **НЕ НАЙДЕНО**
- ❌ `POST /api/material-issues/:id/post` — **НЕ НАЙДЕНО**
- ❌ `POST /api/material-issues/:id/cancel` — **НЕ НАЙДЕНО**
- ❌ `POST /api/material-issues/:id/return` — **НЕ НАЙДЕНО**

**Вывод:** Нужно создать новый контроллер `MaterialIssuesController`.

### 12.3. API склада

**Найденные:**

- ✅ `GET /api/cells` — список ячеек
- ✅ `GET /api/cells/:id` — карточка ячейки
- ✅ `PATCH /api/cells/:id` — правка ячейки (только `warehouseId`)
- ✅ `GET /api/warehouses` — список складов
- ✅ `POST /api/warehouses` — создание склада
- ✅ `GET /api/warehouses/:id` — карточка склада
- ✅ `PATCH /api/warehouses/:id` — правка склада
- ✅ `POST /api/warehouses/:id/lines` — массовое создание ячеек

**Контроллеры:**

- `apps/api/src/modules/passports/cells.controller.ts`
- `apps/api/src/modules/warehouses/warehouses.controller.ts`

**Роли:** `SHOP_MANAGER`, `ADMIN`

**НЕ найдены:**

- ❌ `GET /api/stock` — остатки по складам
- ❌ `GET /api/stock/:materialId` — остатки по материалу
- ❌ `POST /api/stock/adjustment` — корректировка остатков
- ❌ `POST /api/stock/reservation` — резервирование
- ❌ `POST /api/stock/issue` — расход
- ❌ `POST /api/stock/receipt` — приход

### 12.4. API закупок

**Найденные (см. §12.1 и docs/api.md §18–20):**

- ✅ `GET /api/workshop-needs`
- ✅ `GET /api/workshop-needs/:id`
- ✅ `PATCH /api/workshop-needs/:id`
- ✅ `POST /api/workshop-needs/:id/cancel`
- ✅ `POST /api/orders/:id/workshop-needs/calculate`
- ✅ `GET /api/orders/:id/workshop-needs`
- ✅ `GET /api/purchase-orders`
- ✅ `GET /api/purchase-orders/:id`
- ✅ `POST /api/purchase-orders/from-needs`
- ✅ `PATCH /api/purchase-orders/:id`
- ✅ `PATCH /api/purchase-orders/:id/lines/:lineId`
- ✅ `POST /api/purchase-orders/:id/send`
- ✅ `POST /api/purchase-orders/:id/confirm`
- ✅ `POST /api/purchase-orders/:id/cancel`
- ✅ `GET /api/orders/:id/purchase-orders`
- ✅ `GET /api/purchase-receipts`
- ✅ `GET /api/purchase-receipts/:id`
- ✅ `POST /api/purchase-receipts/from-purchase-order`
- ✅ `POST /api/purchase-receipts/:id/cancel`
- ✅ `GET /api/purchase-orders/:id/receipts`
- ✅ `GET /api/orders/:id/purchase-receipts`

**Контроллеры:**

- `apps/api/src/modules/workshop-needs/workshop-needs.controller.ts`
- `apps/api/src/modules/purchase-orders/purchase-orders.controller.ts`
- `apps/api/src/modules/purchase-receipts/purchase-receipts.controller.ts`

**Роли:** `ADMIN`, `SHOP_MANAGER`

### 12.5. API производства

**Найденные (см. docs/api.md §24):**

- ✅ `POST /api/passports` — создание паспорта
- ✅ `GET /api/passports/:id` — карточка паспорта
- ✅ `POST /api/passports/:id/place` — размещение в ячейке
- ✅ `POST /api/passports/:id/issue` — выдача кроя сотруднику
- ✅ `POST /api/passports/:id/scan` — сканирование на операции
- ✅ `POST /api/passports/:id/complete-operation` — завершение операции
- ✅ `GET /api/orders/:id/passports` — список паспортов заказа

**Контроллер:** `apps/api/src/modules/passports/passports.controller.ts`

**Роли:**

- `POST /api/passports` — `CUTTER`, `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`
- `POST /api/passports/:id/issue` — Any auth (employee из сессии)
- Остальные — Any auth

---

## 13. TZ-to-project mapping table

| Элемент ТЗ                            | Найдено в коде?                     | Реальный файл/сущность                                      | Вывод                                        | Нужно добавить/расширить                                      |
|---------------------------------------|-------------------------------------|-------------------------------------------------------------|----------------------------------------------|---------------------------------------------------------------|
| **Materials / Nomenclature**          |                                     |                                                             |                                              |                                                               |
| Material (master-номенклатура)        | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | Создать `Material` или использовать `SupplierCatalogItem`     |
| Nomenclature                          | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | —                                                             |
| Item (материал)                       | ❌ Не найдено                       | —                                                           | Есть только `OrderItem` (размерная матрица)  | —                                                             |
| ProductMaterial                       | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | —                                                             |
| MaterialRequirement                   | ✅ Частично                         | `OrderMaterialRequirement` (snapshot), `WorkshopNeed`       | Snapshot есть, но не live master-requirement | —                                                             |
| TechCardMaterialLine                  | ✅ Найдено                          | `prisma/schema.prisma` (строки 2119–2178)                   | Плановая спецификация материалов техкарты    | —                                                             |
| WorkshopNeed                          | ✅ Найдено                          | `prisma/schema.prisma` (строки 3098–3289)                   | Расчётная + закупочная потребность           | —                                                             |
| SupplierCatalogItem                   | ✅ Найдено                          | `prisma/schema.prisma` (строки 3366–3413)                   | Номенклатура + цена поставщика               | —                                                             |
| PatternMaterialArea                   | ✅ Найдено                          | `prisma/schema.prisma` (см. `docs/erd.md §3.1`)             | Площадь материала по размерам                | —                                                             |
| MaterialConsumptionRule               | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | Создать `MaterialConsumptionRule` (опционально)               |
| **Warehouse / Stock**                 |                                     |                                                             |                                              |                                                               |
| Warehouse                             | ✅ Найдено                          | `prisma/schema.prisma` (строки 1654–1686)                   | Склад                                        | —                                                             |
| WarehouseLine                         | ✅ Найдено                          | `prisma/schema.prisma` (строки 1688–1701)                   | Линия склада                                 | —                                                             |
| Cell                                  | ✅ Найдено                          | `prisma/schema.prisma` (строки 1703–1743)                   | Ячейка хранения                              | —                                                             |
| CellContent                           | ✅ Найдено (частично)               | `prisma/schema.prisma` (строки 1745–1766)                   | Лёгкий счётчик для паспортов, не материалов | Расширить для материалов или создать `StockBalance`          |
| StockBalance                          | ❌ Не найдено                       | —                                                           | Остатки материалов не учитываются            | Создать `StockBalance` (material, warehouse, cell, qty, cost) |
| StockMovement                         | ❌ Не найдено                       | —                                                           | Движения материалов не учитываются           | Создать `StockMovement` (type, material, qty, cost, date)     |
| MaterialStockLot                      | ❌ Не найдено                       | —                                                           | Партии материалов не учитываются             | Создать `MaterialStockLot` (опционально, для FIFO)            |
| WarehouseReceipt (приход)             | ✅ Частично                         | `PurchaseReceiptLine` (с размещением в `Cell`)              | Есть приход из закупки, но без `StockBalance`| Расширить `PurchaseReceiptLine` для записи в `StockBalance`   |
| WarehouseIssue (расход)               | ❌ Не найдено                       | —                                                           | Нет отдельной модели расхода                 | Создать `MaterialIssue` + `MaterialIssueLine`                 |
| InventoryAdjustment (корректировка)   | ❌ Не найдено                       | —                                                           | Нет отдельной модели корректировки           | Создать `StockAdjustment` (опционально)                       |
| StockReservation (резервирование)     | ❌ Не найдено                       | —                                                           | Нет резервирования материалов                | Создать `StockReservation` (опционально, для будущего)        |
| MaterialWriteOff (списание)           | ❌ Не найдено                       | —                                                           | Нет отдельной модели списания                | Создать `MaterialIssue` (синоним расхода)                     |
| unitCost (цена материала)             | ✅ Частично                         | `PurchaseReceiptLine.priceSnapshot`                         | Цена только при приёмке, нет в остатках      | Добавить `unitCost` в `StockBalance` или `MaterialStockLot`   |
| **Material Consumption**              |                                     |                                                             |                                              |                                                               |
| MaterialIssue                         | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | **Создать `MaterialIssue`** (id, orderId, passportId, createdAt, postedAt, status, totalCost, createdById) |
| MaterialIssueLine                     | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | **Создать `MaterialIssueLine`** (issueId, materialId/workshopNeedId, issuedQty, unitCost, totalCost, cellId) |
| ProductionIssue                       | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | Синоним `MaterialIssue`, создавать не нужно                   |
| MaterialIssueSourceLink               | ❌ Не найдено                       | —                                                           | Отдельной модели нет                         | Встроить в `MaterialIssue` (passportId, orderId)              |
| **Purchase / Receipts**               |                                     |                                                             |                                              |                                                               |
| Supplier                              | ✅ Найдено                          | `prisma/schema.prisma` (строки 3291–3334)                   | Поставщик                                    | —                                                             |
| PurchaseOrder                         | ✅ Найдено                          | `prisma/schema.prisma` (строки 3468–3536)                   | Закупочный документ                          | —                                                             |
| PurchaseOrderLine                     | ✅ Найдено                          | `prisma/schema.prisma` (строки 3538–3641)                   | Строка закупочного документа                 | —                                                             |
| PurchaseReceipt                       | ✅ Найдено                          | `prisma/schema.prisma` (строки 3643–3709)                   | Приёмка по PO                                | —                                                             |
| PurchaseReceiptLine                   | ✅ Найдено                          | `prisma/schema.prisma` (строки 3711–3853)                   | Строка приёмки                               | Расширить для записи в `StockBalance`                         |
| Связь PR → материалы                  | ✅ Найдено                          | `PurchaseReceiptLine.workshopNeedId`                        | Связь через `WorkshopNeed`                   | —                                                             |
| Складской приход из поступления       | ✅ Частично                         | `PurchaseReceiptLine.cellId`                                | Размещение в ячейке есть, запись в остатки нет | Расширить для записи в `StockBalance`                       |
| Цена закупки                          | ✅ Найдено                          | `PurchaseReceiptLine.priceSnapshot`                         | Фактическая цена при приёмке                 | —                                                             |
| Quantity received                     | ✅ Найдено                          | `PurchaseReceiptLine.receivedQty`                           | Принятое количество                          | —                                                             |
| **Production**                        |                                     |                                                             |                                              |                                                               |
| Passport                              | ✅ Найдено                          | `prisma/schema.prisma` (строки 1265–1325)                   | Агрегат-корень партии                        | —                                                             |
| OperationEntry                        | ✅ Найдено                          | `prisma/schema.prisma` (строки 1357–1392)                   | Сдельное начисление                          | —                                                             |
| PassportEvent                         | ✅ Найдено                          | `prisma/schema.prisma` (строки 1327–1355)                   | Лог событий паспорта                         | Добавить `MATERIAL_ISSUED` (опционально)                      |
| issueToEmployee                       | ✅ Найдено                          | `apps/api/src/modules/passports/passports.service.ts:484`   | Выдача кроя сотруднику                       | **Расширить для автосписания материалов**                     |
| issue                                 | ✅ Найдено (синоним)                | `issueToEmployee`                                           | —                                            | —                                                             |
| assignPassport                        | ❌ Не найдено                       | —                                                           | Есть `issueToEmployee` + master-actions      | —                                                             |
| releaseCut (выдача кроя)              | ❌ Не найдено                       | —                                                           | Есть `issueToEmployee` (синоним)             | —                                                             |
| create passport                       | ✅ Найдено                          | `apps/api/src/modules/passports/passports.service.ts:119`   | Создание паспорта раскройщиком               | —                                                             |
| scan operation                        | ✅ Найдено                          | `apps/api/src/modules/passports/passports.service.ts:735`   | Сканирование паспорта на операции            | —                                                             |
| complete operation                    | ✅ Найдено                          | `apps/api/src/modules/passports/passports.service.ts:916`   | Завершение операции сотрудником              | —                                                             |
| close packing box                     | ✅ Найдено                          | `apps/api/src/modules/packing/packing.service.ts` (предположительно) | Закрытие коробки упаковки            | —                                                             |
| **Costs / Pricing**                   |                                     |                                                             |                                              |                                                               |
| ProductionCost                        | ✅ Найдено (частично)               | `apps/api/src/modules/costs/costs.service.ts`               | Считает только piecework + salary, без материалов | **Расширить для включения material cost**                  |
| GET /api/costs/production             | ✅ Найдено                          | `apps/api/src/modules/costs/costs.controller.ts`            | Себестоимость выпуска за период              | Расширить для включения material cost                         |
| GET /api/admin/production-cost/v2     | ✅ Найдено                          | `apps/api/src/modules/costs/production-cost-v2.controller.ts`| Управленческий P&L                           | Расширить для включения material cost                         |
| OrderSummary                          | ✅ Найдено (частично)               | `OrderCostEstimate` + `OrderCostEstimateLine`               | Snapshot себестоимости (плановая, из `WorkshopNeed`) | Расширить для включения фактических material costs        |
| material cost (сейчас)                | ✅ Частично                         | `OrderCostEstimateLine` (плановая, из `WorkshopNeed.quotedPrice`) | Есть плановая, нет фактической            | **Добавить фактическую из `MaterialIssue`**                   |
| Откуда берётся material cost          | ✅ Плановая потребность / закупка   | `WorkshopNeed.quotedPrice`, `PurchaseReceiptLine.priceSnapshot` | Плановая + фактическая цена закупки      | **Добавить фактическое списание**                             |
| **Frontend**                          |                                     |                                                             |                                              |                                                               |
| Страница /admin/orders/[id]           | ✅ Найдено                          | `apps/web/app/admin/orders/[id]/page.tsx`                   | Управленческая карточка заказа               | —                                                             |
| Вкладки заказа                        | ✅ Найдено                          | `OrderViewTabs` (production, passports, plan, operations, costSummary, needs, history) | Все вкладки реализованы            | —                                                             |
| Вкладка «Потребности»                 | ✅ Найдено                          | `apps/web/components/orders/view/tabs/order-needs-tab.tsx`  | Материалы + закупки + приёмки                | **Добавить секцию «Фактическое списание»**                    |
| Вкладка «Сводно»                      | ✅ Найдено                          | `apps/web/components/orders/tabs/order-summary-tab.tsx`     | Финансовая вкладка себестоимости             | **Добавить фактические material costs**                       |
| OrderMaterialsUnifiedTable            | ✅ Найдено                          | `apps/web/components/orders/materials/order-materials-unified-table.tsx` | Canonical source для материалов заказа | **Добавить колонку «Списано» (факт)**                     |
| OrderSummaryUnifiedTable              | ✅ Найдено                          | `apps/web/components/orders/summary/order-summary-unified-table.tsx` | Itemized cost breakdown               | **Добавить фактические material costs**                       |
| Server actions / API client           | ✅ Частично                         | `apps/web/lib/orders-api.ts` (предположительно)             | `getOrder`, `listOrderPassports`, `getOrderCutIssueRules` | **Добавить `listMaterialIssues`**, `createMaterialIssue`  |
| **API endpoints**                     |                                     |                                                             |                                              |                                                               |
| GET /orders/:orderId/materials        | ❌ Не найдено                       | —                                                           | Есть аналог `GET /workshop-needs`            | Не нужен (есть `GET /workshop-needs`)                         |
| POST /orders/:orderId/materials/recalculate | ✅ Аналог найдено               | `POST /api/orders/:id/workshop-needs/calculate`             | Пересчёт потребностей                        | —                                                             |
| POST /material-issues                 | ❌ Не найдено                       | —                                                           | Нужно создать API                            | **Создать `POST /api/material-issues`**                       |
| POST /material-issues/:id/post        | ❌ Не найдено                       | —                                                           | Нужно создать API                            | **Создать `POST /api/material-issues/:id/post`**              |
| POST /material-issues/:id/cancel      | ❌ Не найдено                       | —                                                           | Нужно создать API                            | **Создать `POST /api/material-issues/:id/cancel`**            |
| **Integration**                       |                                     |                                                             |                                              |                                                               |
| Интеграция с выдачей кроя             | ❌ Не реализовано                   | —                                                           | `issueToEmployee` не списывает материалы     | **Расширить `issueToEmployee` для автосписания**              |
| Вкладка «Материалы»                   | ✅ Частично (есть «Потребности»)    | `OrderNeedsTab` → `OrderMaterialsUnifiedTable`              | Есть планирование, нет фактического списания | **Добавить секцию «Фактическое списание» в «Потребности»**   |
| Пересчет себестоимости                | ✅ Частично (есть плановая)         | `OrderCostEstimate`, `CostsService`                         | Есть плановая, нет фактической               | **Расширить для включения фактических material costs**        |
| **Audit**                             |                                     |                                                             |                                              |                                                               |
| AuditLog                              | ✅ Найдено                          | `prisma/schema.prisma` (строки 2045–2056)                   | Универсальный журнал действий                | —                                                             |
| AuditService                          | ✅ Найдено                          | `apps/api/src/modules/audit/audit.service.ts`               | Сервис записи аудита                         | —                                                             |
| AuditEntityType                       | ✅ Найдено                          | `apps/api/src/modules/audit/audit.service.ts:13–320`        | Типы сущностей для аудита                   | **Добавить `MATERIAL_ISSUE`**                                 |
| MATERIAL_ISSUE события                | ❌ Не найдено                       | —                                                           | Нет событий для списания материалов          | **Добавить события:** `MATERIAL_ISSUE_CREATED`, `MATERIAL_ISSUE_POSTED`, `MATERIAL_ISSUE_CANCELLED`, `MATERIAL_ISSUE_RETURNED` |
| MATERIAL_SHORTAGE_DETECTED            | ❌ Не найдено                       | —                                                           | Нет событий для дефицита материалов          | **Добавить событие `MATERIAL_SHORTAGE_DETECTED`**             |
| **Roles**                             |                                     |                                                             |                                              |                                                               |
| ADMIN, SHOP_MANAGER                   | ✅ Найдено                          | `prisma/schema.prisma` (enum `Role`)                        | Основные роли реализованы                    | —                                                             |
| CUTTER, CUTTER_ASSISTANT, SEAMSTRESS  | ✅ Найдено                          | `prisma/schema.prisma` (enum `Role`)                        | Производственные роли реализованы            | —                                                             |
| QC, IRONING, PACKING                  | ✅ Найдено                          | `prisma/schema.prisma` (enum `Role`)                        | Роли контроля качества реализованы           | —                                                             |
| SHOPFLOOR_MASTER, DISPLAY             | ✅ Найдено                          | `prisma/schema.prisma` (enum `Role`)                        | Роли цехового управления реализованы         | —                                                             |
| WAREHOUSE_MANAGER                     | ❌ Не найдено                       | —                                                           | Роль не реализована                          | Не критично для MVP (достаточно SHOP_MANAGER)                 |
| PURCHASER                             | ❌ Не найдено                       | —                                                           | Роль не реализована                          | Не критично для MVP (достаточно SHOP_MANAGER)                 |
| ACCOUNTANT                            | ❌ Не найдено                       | —                                                           | Роль не реализована                          | Не критично для MVP (достаточно SHOP_MANAGER)                 |

---

## 14. Gaps (что не найдено)

### 14.1. Модели данных

1. **Складской учёт материалов:**
   - ❌ `StockBalance` — остатки материалов по складам
   - ❌ `StockMovement` — движения материалов (приход/расход/корректировка)
   - ❌ `MaterialStockLot` — партии материалов (для FIFO/LIFO)

2. **Списание материалов:**
   - ❌ `MaterialIssue` — документ списания материалов
   - ❌ `MaterialIssueLine` — строки списания

3. **Номенклатура материалов:**
   - ❌ `Material` — master-справочник материалов (есть только в техкарте и каталоге поставщика)

### 14.2. API

1. **Списание материалов:**
   - ❌ `POST /api/material-issues` — создание документа списания
   - ❌ `GET /api/material-issues` — список документов списания
   - ❌ `GET /api/material-issues/:id` — карточка документа списания
   - ❌ `POST /api/material-issues/:id/post` — проведение документа
   - ❌ `POST /api/material-issues/:id/cancel` — отмена документа
   - ❌ `POST /api/material-issues/:id/return` — возврат материала

2. **Складской учёт:**
   - ❌ `GET /api/stock` — остатки по складам
   - ❌ `GET /api/stock/:materialId` — остатки по материалу
   - ❌ `POST /api/stock/adjustment` — корректировка остатков
   - ❌ `POST /api/stock/reservation` — резервирование

### 14.3. Frontend

1. **Вкладка «Материалы» (фактическое списание):**
   - ❌ Секция «Фактическое списание» в вкладке «Потребности»
   - ❌ Таблица `MaterialIssuesTable` — список документов списания по заказу
   - ❌ Форма `CreateMaterialIssueForm` — ручное создание документа
   - ❌ Кнопка «Провести списание» в карточке `MaterialIssue`

2. **Себестоимость с фактическими материалами:**
   - ❌ Колонка «Списано (факт)» в `OrderMaterialsUnifiedTable`
   - ❌ Блок «Фактические расходы на материалы» в `OrderSummaryUnifiedTable`
   - ❌ Сравнение «План vs Факт» для material cost

### 14.4. Интеграция

1. **Автосписание при выдаче кроя:**
   - ❌ `PassportsService.issueToEmployee` не создаёт `MaterialIssue`
   - ❌ Не списывает `StockBalance`
   - ❌ Не пишет `AuditLog(MATERIAL_ISSUE_CREATED)`

2. **Пересчёт себестоимости с фактическими материалами:**
   - ❌ `CostsService.getProductionCost` не включает material cost
   - ❌ `ProductionCostV2Service` не включает material cost
   - ❌ `OrderCostEstimate` не включает фактические material costs

### 14.5. Роли

1. ❌ `WAREHOUSE_MANAGER` — роль не реализована (не критично для MVP)
2. ❌ `PURCHASER` — роль не реализована (не критично для MVP)
3. ❌ `ACCOUNTANT` — роль не реализована (не критично для MVP)

### 14.6. Audit

1. ❌ `MATERIAL_ISSUE` — entityType для списания материалов
2. ❌ События: `MATERIAL_ISSUE_CREATED`, `MATERIAL_ISSUE_POSTED`, `MATERIAL_ISSUE_CANCELLED`, `MATERIAL_ISSUE_RETURNED`
3. ❌ `MATERIAL_SHORTAGE_DETECTED` — событие дефицита материалов
4. ❌ `MATERIAL_REPLACED` — событие замены материала

---

## 15. Risks (главные риски)

### 15.1. Дубль остатков

**Риск:** Если создать `StockBalance` и продолжать использовать `PurchaseReceiptLine.cellId`, возможен рассинхрон между:

- `StockBalance` (бухгалтерский остаток)
- `PurchaseReceiptLine` (фактическое размещение)
- `MaterialIssue` (фактическое списание)

**Минимизация:**

1. **Источник истины = `StockBalance`:**
   - `PurchaseReceiptLine.cellId` — это только **hint** размещения, не остаток
   - Реальный остаток всегда читать из `StockBalance`

2. **Транзакционность:**
   - Все операции (приход/расход/корректировка) должны быть атомарными
   - При приходе: `PurchaseReceiptLine` + `StockBalance` в одной транзакции
   - При расходе: `MaterialIssue` + `StockBalance` в одной транзакции

3. **Миграция:**
   - Создать `StockBalance` с пересчётом из `PurchaseReceiptLine` и `MaterialIssue`
   - Добавить уникальность `(materialId, warehouseId, cellId, lotId?)`

### 15.2. Двойное списание

**Риск:** При выдаче кроя (`issueToEmployee`) можно случайно:

- Создать несколько `MaterialIssue` на один паспорт
- Списать материалы повторно при retry

**Минимизация:**

1. **Идемпотентность:**
   - Добавить уникальность `MaterialIssue.passportId` (один паспорт — одно списание)
   - Или `(passportId, status)` partial unique (только для `POSTED`)

2. **Статусы:**
   - `DRAFT` — создан, но не проведён (можно отменить)
   - `POSTED` — проведён (остатки списаны)
   - `CANCELLED` — отменён (остатки восстановлены, если был `POSTED`)

3. **Проверка при выдаче кроя:**
   - Перед созданием `MaterialIssue` проверить: есть ли уже `POSTED` issue для этого паспорта
   - Если есть — вернуть 409 `MATERIAL_ALREADY_ISSUED`

### 15.3. Отрицательные остатки

**Риск:** Если не проверять остатки перед списанием, возможен отрицательный `StockBalance.qty`.

**Минимизация:**

1. **Проверка перед списанием:**
   - В `MaterialIssuesService.post(id)` перед обновлением `StockBalance`:
     ```ts
     const balance = await tx.stockBalance.findFirst({
       where: { materialId, warehouseId, cellId }
     });
     if (balance.qty < issueQty) {
       throw new InsufficientStockException();
     }
     ```

2. **Constraint:**
   - Добавить `CHECK (qty >= 0)` в `StockBalance` (на уровне БД)
   - Падение транзакции если отрицательный остаток

3. **UI-предупреждение:**
   - Перед проведением `MaterialIssue` показать сводку остатков
   - Если недостаточно — показать предупреждение «Недостаточно материала на складе»

### 15.4. Поломка выдачи кроя

**Риск:** Если интеграция списания материалов с `issueToEmployee` сломает существующий flow:

- Раньше выдача кроя работала без материалов
- Теперь при отсутствии остатков выдача будет падать

**Минимизация:**

1. **Поэтапная интеграция:**
   - **Шаг 1:** Создать `MaterialIssue` вручную (через UI, без автосписания)
   - **Шаг 2:** Добавить автосписание в `issueToEmployee` (с флагом `autoIssue: boolean` в настройках)
   - **Шаг 3:** Включить флаг `autoIssue = true` после тестирования

2. **Fallback:**
   - Если остатков нет, но выдача разрешена (`allowNegativeStock: true` в настройках):
     - Списать материалы «в минус» (с audit-событием `MATERIAL_SHORTAGE_DETECTED`)
     - Продолжить выдачу кроя

3. **Тесты:**
   - Написать интеграционные тесты для `issueToEmployee` с автосписанием:
     - Достаточно остатков → списание успешно
     - Недостаточно остатков + `allowNegativeStock = false` → 409 `INSUFFICIENT_STOCK`
     - Недостаточно остатков + `allowNegativeStock = true` → списание в минус + event `MATERIAL_SHORTAGE_DETECTED`

### 15.5. Неверная себестоимость

**Риск:** Если фактическое списание материалов не синхронизировано с `CostsService`, себестоимость будет неверной.

**Минимизация:**

1. **Расширить `CostsService.getProductionCost`:**
   - Добавить расчёт `materialCost`:
     ```ts
     const materialCost = await tx.materialIssueLine.aggregate({
       where: {
         materialIssue: {
           passportId: passport.id,
           status: 'POSTED'
         }
       },
       _sum: { totalCost: true }
     });
     ```
   - Итоговая себестоимость = `piecework + salary + materialCost.totalCost`

2. **Расширить `OrderCostEstimate`:**
   - Добавить фактические material costs из `MaterialIssue`:
     ```ts
     const actualMaterialCost = await tx.materialIssue.aggregate({
       where: {
         orderId: order.id,
         status: 'POSTED'
       },
       _sum: { totalCost: true }
     });
     ```
   - Сравнить с плановой (`OrderCostEstimateLine.kind = MATERIAL`)

3. **Тесты:**
   - Написать интеграционный тест:
     - Создать паспорт
     - Выдать крой (создать `MaterialIssue`)
     - Упаковать паспорт
     - Запросить `GET /api/costs/production`
     - Проверить: `materialCost > 0` и включён в `totalCost`

---

## 16. Recommended MVP

### 16.1. Минимальный набор моделей

1. **`MaterialIssue`** — документ списания материалов:
   - `id: String @id`
   - `orderId → Order` (cascade)
   - `passportId? → Passport` (SetNull, для автосписания при выдаче кроя)
   - `status: String` (`DRAFT` / `POSTED` / `CANCELLED`)
   - `totalCost: Decimal(14,2)`
   - `createdAt: DateTime @default(now())`
   - `postedAt?: DateTime`
   - `cancelledAt?: DateTime`
   - `createdById?: String`
   - `postedById?: String`
   - `cancelledById?: String`

2. **`MaterialIssueLine`** — строка списания:
   - `id: String @id`
   - `materialIssueId → MaterialIssue` (cascade)
   - `workshopNeedId? → WorkshopNeed` (SetNull, источник плана)
   - `description: String` (snapshot имени материала)
   - `unit: String`
   - `issuedQty: Decimal(14,4)`
   - `unitCost: Decimal(14,2)` (фактическая цена из `PurchaseReceiptLine.priceSnapshot` или ручная)
   - `totalCost: Decimal(14,2)` (`issuedQty × unitCost`)
   - `cellId? → Cell` (SetNull, откуда списано)

3. **`StockBalance`** — остатки материалов (опционально, для будущего):
   - `id: String @id`
   - `workshopNeedId → WorkshopNeed` (ссылка на «материал»)
   - `warehouseId → Warehouse`
   - `cellId? → Cell`
   - `qty: Decimal(14,4) CHECK (qty >= 0)`
   - `unitCost: Decimal(14,2)` (средневзвешенная или FIFO)
   - `totalCost: Decimal(14,2)` (`qty × unitCost`)
   - `@@unique([workshopNeedId, warehouseId, cellId])`

**Вывод:** Для MVP достаточно `MaterialIssue` + `MaterialIssueLine`. `StockBalance` можно отложить на фазу 2.

### 16.2. Минимальный набор API

1. **`POST /api/material-issues`** — создание документа списания (ручное):
   - Body: `CreateMaterialIssueDto` (`{ orderId, passportId?, lines: [{ workshopNeedId, issuedQty, unitCost }] }`)
   - Status: `DRAFT`
   - Роли: `ADMIN`, `SHOP_MANAGER`

2. **`GET /api/material-issues`** — список документов списания:
   - Query: `{ orderId?, passportId?, status? }`
   - Роли: `ADMIN`, `SHOP_MANAGER`

3. **`GET /api/material-issues/:id`** — карточка документа:
   - Роли: `ADMIN`, `SHOP_MANAGER`

4. **`POST /api/material-issues/:id/post`** — проведение документа:
   - Переход `DRAFT → POSTED`
   - Side effects: пересчитать `totalCost`, зафиксировать `postedAt`
   - Роли: `ADMIN`, `SHOP_MANAGER`

5. **`POST /api/material-issues/:id/cancel`** — отмена документа:
   - Переход `POSTED → CANCELLED` или `DRAFT → CANCELLED`
   - Роли: `ADMIN`, `SHOP_MANAGER`

6. **`GET /api/orders/:orderId/material-issues`** — список документов по заказу:
   - Роли: `ADMIN`, `SHOP_MANAGER`

**Вывод:** Для MVP достаточно CRUD + `post` + `cancel`. Автосписание можно отложить на фазу 2.

### 16.3. Минимальная интеграция

1. **Frontend:**
   - Расширить вкладку «Потребности» (`OrderNeedsTab`):
     - Добавить секцию «Фактическое списание» после `OrderMaterialsUnifiedTable`
     - Показать кнопку «Создать документ списания» (для ручного ввода)
     - Показать таблицу `MaterialIssuesTable` — список документов по заказу

2. **Себестоимость:**
   - Расширить `CostsService.getProductionCost`:
     - Добавить расчёт `materialCost` из `MaterialIssue.totalCost` (только `POSTED`)
     - Включить в итоговую себестоимость: `totalCost = piecework + salary + materialCost`

3. **Audit:**
   - Добавить `AuditEntityType = 'MATERIAL_ISSUE'`
   - Добавить события:
     - `MATERIAL_ISSUE_CREATED`
     - `MATERIAL_ISSUE_POSTED`
     - `MATERIAL_ISSUE_CANCELLED`

**Вывод:** Для MVP достаточно ручного списания + включения в себестоимость. Автосписание при выдаче кроя — фаза 2.

### 16.4. Фазировка

**Фаза 1 (MVP):**

1. Создать модели `MaterialIssue` + `MaterialIssueLine` ✅
2. Создать API CRUD + `post` + `cancel` ✅
3. Расширить вкладку «Потребности» (секция «Фактическое списание») ✅
4. Расширить `CostsService.getProductionCost` (включить material cost) ✅
5. Добавить audit-события ✅

**Фаза 2 (автосписание при выдаче кроя):**

1. Расширить `PassportsService.issueToEmployee`:
   - Создавать `MaterialIssue(status=POSTED)` автоматически
   - Брать `unitCost` из `PurchaseReceiptLine.priceSnapshot` (последняя приёмка)
   - Fallback на `WorkshopNeed.quotedPrice` если нет приёмок
2. Добавить флаг настроек `autoIssueMaterialsOnCutRelease: boolean`
3. Написать интеграционные тесты

**Фаза 3 (складской учёт остатков):**

1. Создать модель `StockBalance` ✅
2. Расширить `PurchaseReceiptLine` для записи в `StockBalance` (приход) ✅
3. Расширить `MaterialIssuesService.post` для списания `StockBalance` (расход) ✅
4. Добавить проверку отрицательных остатков ✅
5. Добавить API `GET /api/stock` ✅

**Фаза 4 (FIFO / партионный учёт):**

1. Создать модель `MaterialStockLot`
2. Реализовать FIFO-списание
3. Добавить отчёт по партиям

---

## 17. Open questions (решения для владельца проекта)

### 17.1. Складской учёт

**Вопрос:** Нужен ли складской учёт остатков материалов (`StockBalance`) в MVP?

**Варианты:**

1. **Да, сразу:**
   - ✅ Корректный учёт остатков
   - ✅ Проверка отрицательных остатков
   - ✅ Предупреждения о дефиците
   - ❌ Больше сложности в миграции
   - ❌ Нужно пересчитывать остатки из `PurchaseReceiptLine`

2. **Нет, отложить на фазу 3:**
   - ✅ Быстрее реализация MVP
   - ✅ Меньше рисков
   - ❌ Списание «в слепую» (без проверки остатков)
   - ❌ Возможны отрицательные остатки

**Рекомендация:** Отложить на фазу 3. Для MVP достаточно `MaterialIssue` без проверки остатков.

### 17.2. Автосписание при выдаче кроя

**Вопрос:** Нужно ли автоматически создавать `MaterialIssue` при выдаче кроя (`issueToEmployee`)?

**Варианты:**

1. **Да, сразу в MVP:**
   - ✅ Автоматизация
   - ✅ Фактическое списание синхронизировано с production
   - ❌ Риск поломки выдачи кроя
   - ❌ Нужна интеграция с `PurchaseReceiptLine.priceSnapshot`

2. **Нет, сначала ручное списание:**
   - ✅ Меньше рисков
   - ✅ Можно протестировать отдельно
   - ❌ Менеджер должен вручную создавать `MaterialIssue`

**Рекомендация:** Отложить на фазу 2. Для MVP достаточно ручного списания.

### 17.3. Цена материала (unitCost)

**Вопрос:** Откуда брать `unitCost` для списания материалов?

**Варианты:**

1. **Из `PurchaseReceiptLine.priceSnapshot`** (последняя приёмка):
   - ✅ Фактическая цена закупки
   - ✅ Корректная себестоимость
   - ❌ Нужна связь `MaterialIssueLine → PurchaseReceiptLine`
   - ❌ Что делать, если нет приёмки?

2. **Из `WorkshopNeed.quotedPrice`** (плановая):
   - ✅ Всегда есть (рассчитывается при `start-calculation`)
   - ✅ Простая реализация
   - ❌ Может быть неточной (план ≠ факт)

3. **Ручной ввод:**
   - ✅ Гибкость
   - ✅ Можно скорректировать
   - ❌ Менеджер должен вводить вручную
   - ❌ Риск ошибок

4. **FIFO / средневзвешенная из `StockBalance`:**
   - ✅ Бухгалтерски корректно
   - ✅ Учитывает партии
   - ❌ Нужен `StockBalance` (фаза 3)
   - ❌ Сложная реализация

**Рекомендация:** Для MVP — ручной ввод (вариант 3). Для фазы 2 — `PurchaseReceiptLine.priceSnapshot` с fallback на `WorkshopNeed.quotedPrice`.

### 17.4. Негативные остатки

**Вопрос:** Разрешить ли списание материалов «в минус» (отрицательные остатки)?

**Варианты:**

1. **Да, разрешить (с предупреждением):**
   - ✅ Производство не останавливается
   - ✅ Можно догнать остатки позже
   - ❌ Риск неучтённых материалов
   - ❌ Некорректная себестоимость

2. **Нет, блокировать:**
   - ✅ Корректный учёт остатков
   - ✅ Корректная себестоимость
   - ❌ Производство останавливается при дефиците
   - ❌ Нужен `StockBalance` для проверки

**Рекомендация:** Для MVP — разрешить (вариант 1), с событием `MATERIAL_SHORTAGE_DETECTED` в аудите. Для фазы 3 — добавить флаг настроек `allowNegativeStock: boolean`.

### 17.5. Отмена списания

**Вопрос:** Что делать с отменой `MaterialIssue` после `POSTED`?

**Варианты:**

1. **Отменить с восстановлением остатков:**
   - ✅ Корректный учёт остатков
   - ✅ Можно исправить ошибку
   - ❌ Нужен `StockBalance` для восстановления
   - ❌ Риск рассинхрона

2. **Отменить без восстановления (только статус):**
   - ✅ Простая реализация
   - ✅ Меньше рисков
   - ❌ Остатки не восстанавливаются
   - ❌ Нужна ручная корректировка

3. **Запретить отмену `POSTED` документов:**
   - ✅ Защита от ошибок
   - ✅ Audit trail
   - ❌ Нельзя исправить ошибку
   - ❌ Нужна ручная корректировка

**Рекомендация:** Для MVP — вариант 3 (запретить отмену `POSTED`). Если нужно исправить — создать новый `MaterialIssue` с отрицательным `issuedQty` (возврат). Для фазы 3 — вариант 1 (с восстановлением остатков).

### 17.6. Роли для материалов

**Вопрос:** Кто может создавать/проводить/отменять `MaterialIssue`?

**Варианты:**

1. **Только `ADMIN` + `SHOP_MANAGER`:**
   - ✅ Защита от ошибок
   - ✅ Контроль
   - ❌ Узкое место (менеджер занят)

2. **Добавить роль `WAREHOUSE_MANAGER`:**
   - ✅ Отдельный человек на складе
   - ✅ Разделение обязанностей
   - ❌ Нужно реализовать роль
   - ❌ Нужно обучать

3. **Разрешить всем (с аудитом):**
   - ✅ Гибкость
   - ✅ Быстрее
   - ❌ Риск ошибок
   - ❌ Некорректные данные

**Рекомендация:** Для MVP — вариант 1 (`ADMIN` + `SHOP_MANAGER`). Для будущего — вариант 2 (добавить роль `WAREHOUSE_MANAGER`).

---

## Заключение

**Реальное состояние проекта:**

1. ✅ Полноценная система управления швейным производством (NestJS + Next.js)
2. ✅ Есть модели потребности цеха (`WorkshopNeed`), закупок (`PurchaseOrder`, `PurchaseReceipt`), производства (`Passport`, `OperationEntry`)
3. ✅ Есть склады (`Warehouse`, `Cell`), но без учёта остатков материалов
4. ✅ Есть приход материалов из закупки (`PurchaseReceiptLine.cellId`), но без записи в `StockBalance`
5. ✅ Есть себестоимость выпуска (`CostsService`), но только по операциям (piecework + salary), без материалов
6. ❌ **НЕТ** складского учёта остатков материалов (`StockBalance`)
7. ❌ **НЕТ** фактического списания материалов (`MaterialIssue`)
8. ❌ **НЕТ** интеграции списания с выдачей кроя (`issueToEmployee`)
9. ❌ **НЕТ** пересчёта себестоимости с фактическими материалами

**Рекомендованный MVP:**

1. Создать модели `MaterialIssue` + `MaterialIssueLine`
2. Создать API CRUD + `post` + `cancel`
3. Расширить вкладку «Потребности» (секция «Фактическое списание»)
4. Расширить `CostsService.getProductionCost` (включить material cost из `MaterialIssue`)
5. Добавить audit-события (`MATERIAL_ISSUE_CREATED`, `MATERIAL_ISSUE_POSTED`, `MATERIAL_ISSUE_CANCELLED`)
6. Отложить на фазу 2: автосписание при выдаче кроя, складской учёт остатков

**Главные риски:**

- Дубль остатков (минимизация: источник истины = `StockBalance`, транзакционность)
- Двойное списание (минимизация: идемпотентность, статусы, проверка)
- Отрицательные остатки (минимизация: проверка перед списанием, constraint, UI-предупреждение)
- Поломка выдачи кроя (минимизация: поэтапная интеграция, fallback, тесты)
- Неверная себестоимость (минимизация: расширить `CostsService`, тесты)

**Открытые вопросы для владельца:**

1. Нужен ли складской учёт остатков в MVP?
2. Нужно ли автосписание при выдаче кроя в MVP?
3. Откуда брать `unitCost` для списания?
4. Разрешить ли отрицательные остатки?
5. Что делать с отменой `POSTED` документов?
6. Кто может создавать/проводить списание?
