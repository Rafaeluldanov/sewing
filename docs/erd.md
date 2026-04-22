# ERD (описание)

> Описание реляционной модели. Точная версия — `prisma/schema.prisma`.

---

## 1. Обзор сущностей

```
                           ┌──────────┐
                           │  Order   │
                           └────┬─────┘
                                │ 1..N
                           ┌────▼─────┐
                           │ OrderItem│── product ──┐
                           └──────────┘── size   ───┤
                                                    │
  ┌──────────┐   ┌──────────┐   ┌──────────┐       │
  │ Product  │   │   Size   │   │ Operation│       │
  └────┬─────┘   └────┬─────┘   └────┬─────┘       │
       │              │              │             │
       └──────┬───────┴──────────────┼──── PieceRate
              │                      │
              │ N..1           N..1  │
         ┌────▼───────────────────────▼───┐
         │           Passport             │──── events (1..N) → PassportEvent
         │  (AGGREGATE ROOT)              │──── entries (1..N) → OperationEntry
         └──┬─────────────────────────────┘──── boxItems(1..N) → BoxItem
            │                                                        │
            │ cutter/creator/currentEmployee ──────┐                 │
            │                                      │                 ▼
            │                              ┌───────▼───┐         ┌────────┐
            │                              │ Employee  │         │  Box   │
            │                              └─┬─────────┘         └────┬───┘
            │                                │                        │
            │                           ┌────▼────┐              ┌────▼───┐
            │                           │ Shift   │              │BoxItem │
            │                           │ Session │              └────────┘
            │                           └─┬───┬───┘
            │                             │   │
            │                       Equipment  Operation
            │
            │  (размещение)
            └──► PassportEvent.cellId ──► Cell ──(1..N)── CellContent ── Size
```

---

## 2. Таблицы

### 2.1. `Size`
Справочник размеров.

| Поле        | Тип     | Ограничения               |
| ----------- | ------- | ------------------------- |
| id          | cuid    | PK                        |
| code        | text    | UNIQUE, напр. `128`, `XL` |
| sortOrder   | int     | NOT NULL                  |

### 2.2. `Product`
Справочник изделий.

| Поле        | Тип     | Ограничения                 |
| ----------- | ------- | --------------------------- |
| id          | cuid    | PK                          |
| name        | text    | NOT NULL                    |
| color       | text    | NOT NULL (`Белая`/`Черная`) |
| active      | bool    | default true                |

### 2.3. `Operation`
Справочник операций + управленческий тариф (см. ADR-0020).

| Поле        | Тип                | Ограничения                                          |
| ----------- | ------------------ | ---------------------------------------------------- |
| id          | cuid               | PK                                                   |
| code        | text               | UNIQUE — стабильный идентификатор для миграций/событий |
| name        | text               | NOT NULL                                             |
| category    | OperationCategory  | enum                                                 |
| sortOrder   | int                | NOT NULL                                             |
| active      | bool               | default true                                         |
| pricingMode | PricingMode        | default `SALARY_ONLY` (см. §3 enums и `domain.md §4a`) |
| fixedRate   | decimal(12,2)      | nullable; обязателен только для `pricingMode=FIXED`  |
| createdAt   | timestamp          |                                                      |
| updatedAt   | timestamp          | `@updatedAt` — UI «когда тариф настраивался»         |

`pricingMode` управляет, откуда `EarningsService` читает ставку (см.
`domain.md §4a`/§9.2):

- `FIXED` → `Operation.fixedRate`;
- `BY_SIZE` → `OperationRateBySize.rate` для нужного `sizeId`
  (`fixedRate` хранится `null`);
- `SALARY_ONLY` → ставка не используется, начисление не создаётся.

### 2.3a. `OperationRateBySize` (ADR-0020)

Сдельная ставка по размерам. Заполняется только для
`Operation.pricingMode = BY_SIZE` (текущий MVP-кейс — оверлок).

| Поле        | Тип             | Ограничения                                       |
| ----------- | --------------- | ------------------------------------------------- |
| id          | cuid            | PK                                                |
| operationId | FK → Operation  | NOT NULL, ON DELETE CASCADE                       |
| sizeId      | FK → Size       | NOT NULL                                          |
| rate        | decimal(12,2)   | NOT NULL — ставка за единицу                      |
| createdAt   | timestamp       |                                                   |
| updatedAt   | timestamp       | `@updatedAt`                                      |

Индексы:

- `OperationRateBySize_operation_size_uniq` — UNIQUE
  `(operationId, sizeId)`. Один и тот же размер не может быть привязан
  к одной операции дважды (проверяется и Zod-схемой
  `CreateOperation`/`UpdateOperation`, см. ADR-0020 §7).
- `(operationId)` — быстрый join в `OperationsService.resolveRate`.
- `(sizeId)` — обратный поиск «у каких операций есть ставка для этого
  размера» (для отчётов).

`ON DELETE CASCADE` по `operationId` — конфигурационная связь, без
операции таблица ставок теряет смысл; по `sizeId` каскад не нужен —
размеры в seed/проде не удаляются (только новые добавляются).

### 2.4. `Employee`

| Поле             | Тип              | Ограничения                                                |
| ---------------- | ---------------- | ---------------------------------------------------------- |
| id               | cuid             | PK                                                         |
| fullName         | text             |                                                            |
| login            | text             | UNIQUE                                                     |
| pinHash          | text             |                                                            |
| role             | Role             | enum                                                       |
| paymentType      | PaymentType      | enum (источник истины для сдельного контура `OperationEntry`) |
| salaryBase       | decimal(12,2)    | nullable; legacy-поле под будущий месячный payroll, на MVP runtime не читает |
| compensationType | CompensationType | enum, default `PIECEWORK` (ADR-0021)                       |
| salaryPerShift   | decimal(12,2)    | nullable; обязателен для `compensationType ∈ { SALARY, MIXED }` (ADR-0021) |
| active           | bool             | default true                                               |

Индексы: `(compensationType)` — для админ-фильтра «все окладные».

### 2.5. `Equipment`

| Поле          | Тип   | Ограничения                                              |
| ------------- | ----- | -------------------------------------------------------- |
| id            | cuid  | PK                                                       |
| code          | text  | UNIQUE                                                   |
| qrCode        | text  | UNIQUE                                                   |
| name          | text  |                                                          |
| displayNumber | text  | nullable — ручной номер для физической маркировки станка |
| active        | bool  |                                                          |

`displayNumber` — это «бирочный» номер, который сотрудник видит на
наклейке (см. `GET /api/equipment/:id/print`, ADR-0017 §5). На MVP
без глобальной уникальности: «№1» допустим и у оверлока, и у
распошива — в реальном цеху их и так не путают. Отдельный
`Equipment.serialNumber` (производительская табличка) сюда не
попадает — это разные вещи.

### 2.5a. `EquipmentOperation` (M2M, ADR-0017)

Источник истины «оборудование → разрешённые операции» для seamstress
flow на /work и для админ-настройки в `/admin/equipment`.
До этой таблицы маппинг жил во фронтовом хардкоде по префиксу
`Equipment.code` — теперь это явная конфигурация в БД.

| Поле        | Тип       | Ограничения                                        |
| ----------- | --------- | -------------------------------------------------- |
| id          | cuid      | PK                                                  |
| equipmentId | FK→Equipment | ON DELETE CASCADE                                |
| operationId | FK→Operation | ON DELETE CASCADE                                |
| sortOrder   | int       | default 0 — порядок выбора на /work                 |
| isActive    | bool      | default true — soft-disable                         |
| createdAt   | timestamp | default now                                         |
| updatedAt   | timestamp | @updatedAt                                          |

Индексы:

- `EquipmentOperation_equipmentId_operationId_key` — UNIQUE
  `(equipmentId, operationId)`. Одно и то же `Operation` не может быть
  привязано к одному `Equipment` дважды.
- `EquipmentOperation_equipmentId_sortOrder_idx` — для быстрого
  списка allow-листа в `/api/shifts/meta`.
- `EquipmentOperation_operationId_idx` — обратный поиск
  «на каких станках есть эта операция».

### 2.6. `ShiftSession`

| Поле         | Тип       | Ограничения                        |
| ------------ | --------- | ---------------------------------- |
| id           | cuid      | PK                                 |
| employeeId   | FK→Employee                         |
| equipmentId  | FK→Equipment                        |
| operationId  | FK→Operation                        |
| startedAt    | timestamp | default now                         |
| endedAt      | timestamp | nullable                            |

Индексы:

- `(employeeId, endedAt)` — быстрый поиск активной сессии;
- `shift_session_active_employee_uniq` — **partial unique** на
  `(employeeId) WHERE endedAt IS NULL` (MVP 1.1, ADR-0015). Гарантирует
  «одна активная смена на сотрудника» на уровне БД. Создаётся
  идемпотентно при старте API в `PrismaService.onModuleInit`
  (Prisma 5 пока не описывает partial-индексы декларативно).

«Активная смена» = `endedAt IS NULL`. Правило «не более одной активной
смены на сотрудника» поддерживается и в `ShiftsService`, и на БД (MVP 1.1).
Сервис ловит `Prisma.P2002` именно на этом индексе и переводит в
`SHIFT_ALREADY_ACTIVE`.

### 2.7. `Order`

| Поле            | Тип         | Ограничения                         |
| --------------- | ----------- | ----------------------------------- |
| id              | cuid        | PK                                  |
| number          | text        | UNIQUE, автоген `O-YYYYMMDD-NNNN`   |
| customer        | text        | nullable                            |
| orderDate       | timestamp   | NOT NULL — дата заказа              |
| dueDate         | timestamp   | nullable — срок                     |
| color           | text        | nullable — переопределение цвета изделия |
| comment         | text        | nullable                            |
| status          | OrderStatus | enum (`DRAFT`/`IN_PRODUCTION`/`DONE`/`CANCELLED`) |
| routeTemplateId | FK→RouteTemplate | nullable, soft-route MVP (§18 domain.md) |
| techCardId      | FK→TechCardTemplate | nullable, MVP техкарт (§19 domain.md, ADR-0022) |
| createdAt       | timestamp   |                                     |
| updatedAt       | timestamp   | авто-обновление                     |

Индексы: `(status)`, `(orderDate)`, `(createdAt)`,
`(routeTemplateId)`, `(techCardId)`.

### 2.8. `OrderItem`

| Поле      | Тип    | Ограничения |
| --------- | ------ | ----------- |
| id        | cuid   | PK          |
| orderId   | FK     |             |
| productId | FK     |             |
| sizeId    | FK     |             |
| qtyPlan   | int    | > 0         |

UNIQUE `(orderId, productId, sizeId)`.

### 2.8a. `CuttingClosureRequest` (ADR-0018)

Заявка на закрытие раскроя по конкретной размерной строке. Помощник
раскройщика подаёт, мастер цеха подтверждает / отклоняет. После
`APPROVED` `PassportsService.create` запрещает выпуск новых паспортов
(см. `domain.md §15`).

| Поле                  | Тип       | Ограничения                                   |
| --------------------- | --------- | --------------------------------------------- |
| id                    | cuid      | PK                                            |
| orderId               | FK→Order  |                                               |
| productId             | FK→Product|                                               |
| sizeId                | FK→Size   |                                               |
| status                | CuttingClosureRequestStatus | enum (`REQUESTED`/`APPROVED`/`REJECTED`), default `REQUESTED` |
| reason                | text?     | короткая причина от помощника                 |
| requestedByEmployeeId | FK→Employee | автор заявки                                |
| requestedAt           | timestamp | default now                                   |
| reviewedByEmployeeId  | FK→Employee? | мастер, принявший решение                  |
| reviewedAt            | timestamp?|                                               |
| reviewerNote          | text?     | заметка мастера к решению                     |
| createdAt             | timestamp | default now                                   |
| updatedAt             | timestamp | @updatedAt                                    |

Индексы:

- `cutting_closure_request_orderId_productId_sizeId_idx` — обычный
  составной индекс для выборок «есть ли заявки по строке».
- `cutting_closure_request_status_requestedAt_idx` — для менеджерского
  списка `?status=REQUESTED`.
- `cutting_closure_request_active_uniq` — **partial UNIQUE**
  `(orderId, productId, sizeId) WHERE status = 'REQUESTED'`. Одна
  активная заявка на строку (см. ADR-0015, ADR-0018).
- `cutting_closure_request_approved_uniq` — **partial UNIQUE**
  `(orderId, productId, sizeId) WHERE status = 'APPROVED'`. Один
  финальный «закрыт» на строку. `REJECTED` копится без ограничений.

> Partial unique indexes создаются миграцией
> `20260418200000_cutting_closure_requests` и идемпотентно
> переприменяются в `PrismaService.onModuleInit` (Prisma пока не
> описывает partial-индексы декларативно).

### 2.9. `Passport`  ← **агрегат-корень**

| Поле                | Тип       | Ограничения               |
| ------------------- | --------- | ------------------------- |
| id                  | cuid      | PK                        |
| number              | text      | UNIQUE                    |
| qrCode              | text      | UNIQUE                    |
| orderId             | FK        |                           |
| productId           | FK        |                           |
| sizeId              | FK        |                           |
| color               | text      | денормализация            |
| rollNumber          | text      |                           |
| cutDate             | date      |                           |
| qtyPlan             | int       | > 0                       |
| qtyCut              | int       | ≥ 0                       |
| qtyDefect           | int       | ≥ 0, ≤ qtyCut             |
| qtyGood             | int       | = qtyCut − qtyDefect      |
| status              | PassportStatus | enum                 |
| currentOperationId  | FK→Operation | nullable                |
| currentEmployeeId   | FK→Employee  | nullable                |
| currentCellId       | FK→Cell      | nullable, Шаг 5 (ADR-0010) |
| cutterId            | FK→Employee  | раскройщик-сдельщик     |
| creatorId           | FK→Employee  | помощник, создал паспорт|
| pdfUrl              | text      | nullable                  |
| createdAt           | timestamp |                           |

Индексы: `(currentOperationId, status)`, `(orderId)`, `(sizeId, status)`,
`(createdAt)`, `(currentCellId)`.

### 2.10. `PassportEvent` (журнал)

| Поле         | Тип                | Ограничения |
| ------------ | ------------------ | ----------- |
| id           | cuid               | PK          |
| passportId   | FK                 | NOT NULL    |
| type         | PassportEventType  | enum        |
| operationId  | FK                 | nullable    |
| employeeId   | FK                 | nullable    |
| fromOperationId | FK              | nullable    |
| qty          | int                | nullable    |
| defectQty    | int                | nullable    |
| cellId       | FK                 | nullable    |
| boxId        | FK                 | nullable    |
| payload      | jsonb              | nullable    |
| createdAt    | timestamp          |             |

Индекс: `(passportId, createdAt)`, `(type, createdAt)`.

### 2.11. `OperationEntry` (сдельное начисление, Шаг 9)

Запись в этой таблице есть **только** для сдельных операций
(`PIECEWORK`-сотрудников на `CUT_CUT` / `SEW_OVERLOCK_1` /
`SEW_BINDING` / `SEW_OVERLOCK_2` / `SEW_COVERSTITCH`).
ОТК / ВТО / упаковка / помощник раскройщика сюда не попадают.

| Поле             | Тип             | Ограничения                                    |
| ---------------- | --------------- | ---------------------------------------------- |
| id               | cuid            | PK                                             |
| passportId       | FK→Passport     | NOT NULL                                       |
| operationId      | FK→Operation    | NOT NULL                                       |
| employeeId       | FK→Employee     | NOT NULL                                       |
| qty              | int             | ≥ 0; копия `passport.qtyCut` на момент создания|
| ratePerUnit      | decimal(12,2)   | копия `PieceRate.ratePerUnit`                  |
| amount           | decimal(12,2)   | = qty * ratePerUnit, округление до двух знаков |
| status           | EntryStatus     | `PENDING_RELEASE` / `APPROVED` / `REVERSED` (`PENDING` / `CANCELLED` — legacy, не используется) |
| approvalMode     | ApprovalMode    | `IMMEDIATE` (раскройщик) / `AFTER_RELEASE` (пошив) |
| sourceEventType  | EarningSource   | `PASSPORT_CREATED` / `OPERATION_TRANSITION`    |
| sourceEventId    | text            | nullable; ссылка на `PassportEvent.id`-триггер (для пошива) |
| createdAt        | timestamp       | default now                                    |
| approvedAt       | timestamp       | nullable; для `IMMEDIATE` равен `createdAt`, для `AFTER_RELEASE` ставится в транзакции упаковки |

Индексы и уникальные ключи:

- UNIQUE `(passportId, operationId, employeeId, sourceEventType)` —
  `OperationEntry_idem`. Защищает от дублей при повторных сканах,
  ретраях и иных идемпотентных вызовах. Сервис ловит `P2002` и
  трактует как no-op (см. ADR-0012).
- `(employeeId, status, createdAt)` — выборка «начисления сотрудника».
- `(status, createdAt)` — глобальный фильтр по статусу (например,
  «все pending за период» для свода).
- `(passportId)` — все начисления по конкретному паспорту, нужен
  для блока «Начисления» в карточке (`docs/screens.md §12.2`) и
  для апрува в `EarningsService.approvePendingForPassport`.

### 2.12. `PieceRate`

| Поле         | Тип             | Ограничения |
| ------------ | --------------- | ----------- |
| id           | cuid            | PK          |
| operationId  | FK              |             |
| productId    | FK              | nullable    |
| sizeId       | FK              | nullable    |
| ratePerUnit  | decimal(12,2)   |             |
| validFrom    | timestamp       |             |
| validTo      | timestamp       | nullable    |

Индекс: `(operationId, productId, sizeId, validFrom)`.

### 2.13. `Cell`

| Поле        | Тип  | Ограничения                                    |
| ----------- | ---- | ---------------------------------------------- |
| id          | cuid | PK                                             |
| code        | text | UNIQUE                                         |
| qrCode      | text | UNIQUE                                         |
| active      | bool |                                                |
| warehouseId | text | nullable, FK → `Warehouse(id)` ON DELETE SET NULL (ADR-0019) |

Индекс: `(warehouseId)` для быстрого подсчёта ячеек склада.

### 2.13a. `Warehouse` (ADR-0019)

Управленческая группировка ячеек физического хранения. Введена пост-Шагом 14
для админ-экрана «Склад» (`/admin/warehouses`). Не влияет на flow `place` —
см. `domain.md §16`, [ADR-0019](./adr/0019-warehouses.md).

| Поле      | Тип       | Ограничения                                |
| --------- | --------- | ------------------------------------------ |
| id        | cuid      | PK                                         |
| name      | text      | UNIQUE                                     |
| code      | text      | UNIQUE, nullable                           |
| isActive  | bool      | default `true`                             |
| createdAt | timestamp |                                            |
| updatedAt | timestamp |                                            |

Индексы: `name UNIQUE`, `code UNIQUE`, `(isActive)` для фильтрации
активных в UI.

Связь с `Cell` — один-ко-многим через `Cell.warehouseId` с
`ON DELETE SET NULL`: удаление склада не уничтожает ячейки, только
обнуляет ссылку (ячейка физически существует).

### 2.13b. `SalaryEntry` (ADR-0021)

Дневное окладное начисление. Создаётся `SalaryService.syncDailySalary`
из `ShiftsService.start/stop` для сотрудников с
`compensationType ∈ { SALARY, MIXED }`, по факту наличия хотя бы
одной `ShiftSession` в дате (см. `domain.md §9a`,
[ADR-0021](./adr/0021-shift-day-salary.md)).

| Поле               | Тип               | Ограничения                                              |
| ------------------ | ----------------- | -------------------------------------------------------- |
| id                 | cuid              | PK                                                       |
| employeeId         | FK→Employee       | NOT NULL                                                 |
| date               | date (Postgres `DATE`) | NOT NULL — нормализована к началу суток             |
| amount             | decimal(12,2)     | NOT NULL — дефолт = `Employee.salaryPerShift` на момент sync |
| source             | SalaryEntrySource | default `SHIFT_DAY`; на MVP пишем только `SHIFT_DAY` (`MANUAL` зарезервирован) |
| editedManually     | bool              | default false; `true` после ручной правки через `PATCH /api/salary/:id` |
| managerComment     | text?             | nullable, ≤ 500 символов; короткий комментарий правки   |
| editedByEmployeeId | FK→Employee?      | nullable; кто последним правил руками                   |
| createdAt          | timestamp         | default now                                              |
| updatedAt          | timestamp         | `@updatedAt`                                             |

Индексы и уникальные ключи:

- UNIQUE `(employeeId, date, source)` —
  `SalaryEntry_employee_date_source_uniq`. Бизнес-инвариант
  «один день — одна окладная запись на сотрудника» (см. `domain.md §13`,
  ADR-0021 §2.2). Параллельные `start shift` встают на этом индексе,
  `P2002` в `SalaryService.syncDailySalary` — no-op.
- `(employeeId, date)` — выборка «начисления сотрудника за период».
- `(date)` — глобальный фильтр по дате (свод за день).

Каскадов нет: `Employee` мы и так не удаляем (есть `active` флаг),
`SalaryEntry` живёт вечно как часть зарплатной истории.

### 2.14. `CellContent`

| Поле      | Тип  | Ограничения    |
| --------- | ---- | -------------- |
| id        | cuid | PK             |
| cellId    | FK   |                |
| sizeId    | FK   |                |
| quantity  | int  | ≥ 0            |

UNIQUE `(cellId, sizeId)`.

### 2.15. `Box` (Шаг 8)

Контейнер выпуска. Создаётся упаковщиком на экране `/packing`.

| Поле         | Тип       | Ограничения                              |
| ------------ | --------- | ---------------------------------------- |
| id           | cuid      | PK                                       |
| number       | text      | UNIQUE; формат `B-YYYYMMDD-NNNN` (см. `BoxNumberService`) |
| qrCode       | text      | UNIQUE; формат `box:{id}` (ADR-0010)     |
| totalQty     | int       | ≥ 0, ≤ `maxQty`                          |
| maxQty       | int       | default 100, на MVP всегда 100           |
| closedAt     | timestamp | nullable; `NULL` = коробка `OPEN`        |
| createdById  | FK→Employee | NOT NULL — упаковщик-автор             |
| createdAt    | timestamp |                                          |

Однородность партии (один `productId/color/sizeId` в коробке) —
soft-инвариант сервиса (см. ADR-0011 §3, ошибка
`BOX_HOMOGENEITY_VIOLATED`).

### 2.16. `BoxItem` (Шаг 8)

Запись о попадании паспорта в коробку. Создание `BoxItem` =
выпуск изделия (см. `domain.md §8`, ADR-0011 §2).

| Поле       | Тип  | Ограничения              |
| ---------- | ---- | ------------------------ |
| id         | cuid | PK                       |
| boxId      | FK→Box | NOT NULL               |
| passportId | FK→Passport | NOT NULL, **UNIQUE** (MVP 1.1, ADR-0015) |
| qty        | int  | > 0; копия `passport.qtyGood` на момент упаковки |
| createdAt  | timestamp |                     |

UNIQUE `(boxId, passportId)` (исторически, MVP 1.0) **и**
глобальный UNIQUE `(passportId)` (MVP 1.1, ADR-0015) — паспорт
физически не может оказаться в двух коробках. Сервисный
`assertPassportActive` плюс `status = PACKED` после первой упаковки —
дополнительный слой защиты с понятной бизнес-ошибкой
`PASSPORT_ALREADY_PACKED`.

### 2.17. `DefectType` (Шаг 7)

Справочник видов брака, заполняется через `prisma/seed.ts → seedDefectTypes`.

| Поле       | Тип  | Ограничения             |
| ---------- | ---- | ----------------------- |
| id         | cuid | PK                      |
| code       | text | UNIQUE                  |
| name       | text | NOT NULL                |
| isActive   | bool | default true            |
| sortOrder  | int  | NOT NULL                |
| createdAt  | timestamp |                    |

Индекс: `(sortOrder)` — для стабильного порядка в UI/выпадашках.

### 2.18. `PassportDefect` (Шаг 7)

Один акт фиксации брака от ОТК. Создаётся в одной транзакции с
инкрементом `Passport.qtyDefect` / `Passport.qtyGood` и записью
`PassportEvent(DEFECT_RECORDED)` (см. `flows.md §F5`).

| Поле                 | Тип       | Ограничения              |
| -------------------- | --------- | ------------------------ |
| id                   | cuid      | PK                       |
| passportId           | FK→Passport | NOT NULL               |
| defectTypeId         | FK→DefectType | NOT NULL             |
| qty                  | int       | > 0                      |
| comment              | text      | nullable, ≤ 500 символов |
| createdByEmployeeId  | FK→Employee | nullable (на MVP без auth) |
| createdAt            | timestamp |                          |

Индексы: `(passportId, createdAt)` — история по паспорту;
`(defectTypeId, createdAt)` — будущая аналитика причин брака.

### 2.19. `TechCardTemplate` (ADR-0022)

Шаблон «потребностей на единицу изделия». Подробности — `domain.md §19`.

| Поле       | Тип       | Ограничения           |
| ---------- | --------- | --------------------- |
| id         | cuid      | PK                    |
| code       | text      | UNIQUE                |
| name       | text      | NOT NULL              |
| isActive   | bool      | default true          |
| createdAt  | timestamp |                       |
| updatedAt  | timestamp | @updatedAt            |

Связи: `materialLines: TechCardMaterialLine[]`,
`outsourceLines: TechCardOutsourceLine[]`, `orders: Order[]`.

### 2.20. `TechCardMaterialLine` (ADR-0022)

Строка материала в шаблоне.

| Поле        | Тип            | Ограничения                          |
| ----------- | -------------- | ------------------------------------ |
| id          | cuid           | PK                                   |
| techCardId  | FK→TechCardTemplate | NOT NULL, ON DELETE CASCADE     |
| sortOrder   | int            | NOT NULL                             |
| name        | text           | NOT NULL                             |
| unit        | text           | NOT NULL (м, кг, шт, …)              |
| qtyPerUnit  | decimal(12,4)  | > 0 (валидируется DTO/сервисом)      |
| note        | text           | nullable                             |
| createdAt   | timestamp      |                                      |
| updatedAt   | timestamp      | @updatedAt                           |

Индекс: `(techCardId, sortOrder)`. Имена внутри одной техкарты не
уникализируем.

### 2.21. `TechCardOutsourceLine` (ADR-0022)

Строка внешнего подрядного размещения. Семантически — аналог
`OUTSOURCED_SERVICE`-операции, но живёт сбоку от маршрута.

| Поле        | Тип            | Ограничения                          |
| ----------- | -------------- | ------------------------------------ |
| id          | cuid           | PK                                   |
| techCardId  | FK→TechCardTemplate | NOT NULL, ON DELETE CASCADE     |
| sortOrder   | int            | NOT NULL                             |
| name        | text           | NOT NULL                             |
| unit        | text           | nullable                             |
| qtyPerUnit  | decimal(12,4)  | nullable (> 0, если задан)           |
| vendorName  | text           | nullable, свободный текст            |
| note        | text           | nullable                             |
| createdAt   | timestamp      |                                      |
| updatedAt   | timestamp      | @updatedAt                           |

Индекс: `(techCardId, sortOrder)`.

### 2.22. `OrderMaterialRequirement` (snapshot, ADR-0022)

Read-only план потребностей материалов на конкретном заказе.
Создаётся в `OrdersService.start()` и больше не меняется.

| Поле                  | Тип            | Ограничения                                          |
| --------------------- | -------------- | ---------------------------------------------------- |
| id                    | cuid           | PK                                                   |
| orderId               | FK→Order       | NOT NULL                                             |
| sourceTechCardLineId  | FK→TechCardMaterialLine | nullable, **ON DELETE SET NULL**            |
| sortOrder             | int            | NOT NULL                                             |
| name                  | text           | NOT NULL — копия имени строки шаблона на момент start |
| unit                  | text           | NOT NULL                                             |
| qtyPerUnit            | decimal(12,4)  | > 0                                                  |
| totalQty              | decimal(12,4)  | = `qtyPerUnit * Σ OrderItem.qtyPlan` (Decimal-math)  |
| note                  | text           | nullable                                             |
| createdAt             | timestamp      |                                                      |

Индекс: `(orderId, sortOrder)`. `SET NULL` — это «независимость
snapshot-а»: старые заказы не ломаются, если строку шаблона удалили.

### 2.23. `OrderOutsourceRequirement` (snapshot, ADR-0022)

Read-only план внешних подрядов на конкретном заказе.

| Поле                  | Тип            | Ограничения                                          |
| --------------------- | -------------- | ---------------------------------------------------- |
| id                    | cuid           | PK                                                   |
| orderId               | FK→Order       | NOT NULL                                             |
| sourceTechCardLineId  | FK→TechCardOutsourceLine | nullable, **ON DELETE SET NULL**           |
| sortOrder             | int            | NOT NULL                                             |
| name                  | text           | NOT NULL                                             |
| unit                  | text           | nullable                                             |
| qtyPerUnit            | decimal(12,4)  | nullable (> 0, если задан)                           |
| totalQty              | decimal(12,4)  | nullable, `null` если в шаблоне `qtyPerUnit == null` |
| vendorName            | text           | nullable                                             |
| note                  | text           | nullable                                             |
| createdAt             | timestamp      |                                                      |

Индекс: `(orderId, sortOrder)`.

---

## 3. Enums

```
Role               = SHOP_MANAGER | CUTTER | CUTTER_ASSISTANT | SEAMSTRESS
                   | QC | IRONING | PACKING | ADMIN
OperationCategory  = CUTTING | SEWING | QC | IRONING | PACKING
PaymentType        = SALARY | PIECEWORK
OrderStatus        = DRAFT | IN_PRODUCTION | DONE | CANCELLED
PassportStatus     = CREATED | IN_PROGRESS | PACKED | CANCELLED
PassportEventType  = CREATED | OPERATION_STARTED | OPERATION_FINISHED
                   | MOVED | DEFECT_RECORDED | CELL_PLACED | CELL_REMOVED
                   | ISSUED_TO_EMPLOYEE | OPERATION_SCAN
                   | PACKED | CANCELLED
EntryStatus        = PENDING | PENDING_RELEASE | APPROVED | CANCELLED | REVERSED
                     # Шаг 9 использует только PENDING_RELEASE / APPROVED / REVERSED;
                     # PENDING и CANCELLED сохранены для обратной совместимости.
ApprovalMode       = IMMEDIATE | AFTER_RELEASE                # Шаг 9
EarningSource      = PASSPORT_CREATED | OPERATION_TRANSITION  # Шаг 9, см. ADR-0012
CuttingClosureRequestStatus
                   = REQUESTED | APPROVED | REJECTED            # ADR-0018
PricingMode        = FIXED | BY_SIZE | SALARY_ONLY              # Шаг 18, см. ADR-0020
CompensationType   = PIECEWORK | SALARY | MIXED                 # Шаг 19, см. ADR-0021
SalaryEntrySource  = SHIFT_DAY | MANUAL                         # Шаг 19, см. ADR-0021
```

---

## 4. Целостность

- Каскадное удаление — **нет** нигде, кроме `EquipmentOperation`
  (M2M «оборудование ↔ операция», ADR-0017) и
  `OperationRateBySize` (ставка по размерам каскадится с операцией,
  ADR-0020). Обе — конфигурационные таблицы, без родительской сущности
  обвязка теряет смысл. `SalaryEntry` каскада не имеет — `Employee`
  мы и так не удаляем (есть `active` флаг), история выплат живёт
  вечно (ADR-0021).
- Soft-delete — **нет** на MVP (достаточно флагов `active`;
  `EquipmentOperation.isActive` — отдельный мягкий выключатель связи).
- Все денежные поля — `decimal(12, 2)`.
- Временные метки — `timestamptz`.

---

## 5. Проекции (не сущности БД, а вычисляемые представления)

- `PlanFactView(orderId, productId, sizeId) → { qtyPlan, qtyCut, qtyGood, qtyDefect }`
  — реализована частично через `apps/api/src/modules/orders/order-aggregator.ts`
  (см. `OrderSummary` / `OrderSizeBreakdownRow` в `@sewing/shared/orders`).
- `ShopfloorView(scope, sizeId) → { qtyCut, qtySewing, qtyQc, qtyQcDone, qtyWto, qtyPacking, qtyFinished, qtyDefect }`
  — экран «Цех» (Шаг 10 MVP). Реализуется на лету в
  `apps/api/src/modules/shopfloor/shopfloor.service.ts` через один
  запрос за паспортами активных заказов и чистую функцию
  `projectShopfloor()`. Никакой материализованной таблицы / снапшота
  на MVP не вводится — правила буккетов зафиксированы
  [ADR-0013](./adr/0013-shopfloor-stage-mapping.md).
- `StageAggregateView(sizeId)` — старое название той же проекции до
  Шага 10; на MVP заменено `ShopfloorView`.

Дашборд начальника (`DashboardService`) — за рамками MVP (см. ТЗ §17,
`docs/index.md`).
