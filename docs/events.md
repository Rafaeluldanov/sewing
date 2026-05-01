# Событийная модель

> Все изменения состояния паспорта — через события. Текущее состояние —
> денормализованная проекция (колонки на `Passport`), чтобы не читать
> историю для отрисовки.

---

## 1. Доменные события паспорта

Хранятся в таблице `PassportEvent`. Тип — `PassportEventType`.

| Тип                 | Когда                                      | Обязательные поля                      |
| ------------------- | ------------------------------------------ | -------------------------------------- |
| `CREATED` *(Шаг 5)* | F2: помощник создал паспорт                | `operationId=CUT_DIVISION`, `employeeId=creator`, `qty=qtyCut` |
| `OPERATION_STARTED` | F4: паспорт зашёл на операцию              | `operationId`, `employeeId`            |
| `OPERATION_FINISHED`| F4: паспорт покинул операцию               | `operationId` (fromOperation)          |
| `MOVED`             | F4: сам факт перемещения (для аналитики)   | `fromOperationId`, `operationId` (=to) |
| `DEFECT_RECORDED` *(Шаг 7)* | F5: ОТК зафиксировал брак          | `qty=defectQty`, `operationId=passport.currentOperationId`, `employeeId?`, `payload={ defectId, defectTypeId, defectTypeCode, defectTypeName, comment? }` |
| `CELL_PLACED` *(Шаг 5)* | F3: паспорт положили в ячейку          | `cellId`, `qty=passport.qtyCut`        |
| `CELL_REMOVED`      | забрали из ячейки                          | `cellId`, `qty`                        |
| `ISSUED_TO_EMPLOYEE` *(Шаг 6)* | F3a: швея получила крой из ячейки | `employeeId`, `operationId=session.operationId`, `cellId=previousCellId`, `qty=passport.qtyCut` |
| `OPERATION_SCAN` *(Шаг 6)*     | F4 (MVP): скан паспорта на операции | `employeeId`, `operationId=session.operationId`, `fromOperationId?`, `qty=passport.qtyGood` |
| `PACKED` *(Шаг 8)*  | F7: паспорт добавлен в коробку (= выпуск изделия) | `boxId`, `qty=qtyGood`, `employeeId` |
| `CANCELLED`         | паспорт отменён (на будущее, MVP не используем) | —                                 |

`payload` (jsonb) — произвольный контекст: `sessionId`, `notes`, снимки
значений до/после.

---

## 2. Инварианты последовательностей

```
CREATED
  → [CELL_PLACED / CELL_REMOVED …]         // любое количество, в любой момент до PACKED
  → ISSUED_TO_EMPLOYEE                     // Шаг 6: швея получила крой, паспорт снят с ячейки
  → [OPERATION_SCAN …]                     // Шаг 6: любое сканирование = переход
  → OPERATION_FINISHED (from) + OPERATION_STARTED (to) + MOVED  // повторяем много раз (Шаг 7+)
  → DEFECT_RECORDED …                      // ноль или более, обычно в QC
  → PACKED                                 // терминальное (кроме CANCELLED)
```

**Правила:**

- `CREATED` — первое событие паспорта.
- `PACKED` — всегда последнее (кроме `CANCELLED`).
- `OPERATION_STARTED` всегда парное с предыдущим `OPERATION_FINISHED`
  (кроме самого первого `OPERATION_STARTED` после `CREATED`).
- `DEFECT_RECORDED` допустимо только когда `Passport.status = IN_PROGRESS`
  (Шаг 7). Создание дефекта **не** меняет `currentOperationId` /
  `currentEmployeeId` и **не** переводит паспорт в терминальный статус —
  можно зафиксировать несколько подряд.
- `qty` в `DEFECT_RECORDED` = количество брака за один акт фиксации;
  суммарно `Σ qty per passport ≤ Passport.qtyCut`.
- `ISSUED_TO_EMPLOYEE` требует:
  `passport.currentCellId IS NOT NULL`,
  `passport.currentEmployeeId IS NULL OR = session.employeeId`,
  активная `ShiftSession` у сотрудника (`SHIFT_SESSION_REQUIRED`).
- `OPERATION_SCAN` требует активную `ShiftSession` и не меняет паспорта
  в терминальных статусах (`PASSPORT_ALREADY_PACKED` / `PASSPORT_CANCELLED`).
  Повторный скан того же паспорта на той же операции тем же сотрудником —
  no-op (событие не пишется).
- `PACKED` (Шаг 8) пишется в одной транзакции с созданием `BoxItem` и
  переводом `Passport.status = PACKED` (см. `flows.md §F7`,
  ADR-0011). Инвариант: `status = PACKED ⇔ есть ровно одна строка
  `BoxItem` для этого паспорта`. Любые `issue`/`scan`/`qc`/`place` для
  упакованного паспорта возвращают `PASSPORT_ALREADY_PACKED`.
- ВТО (Шаг 8) — это обычный `OPERATION_SCAN` на операцию `WTO`,
  отдельных событий ВТО нет.

Эти инварианты проверяются в `PassportService`, не в БД-триггерах (на MVP).

---

## 3. Интеграционные события (EventBus)

Используем `@nestjs/event-emitter` (in-process). Имена в kebab-case.

| Событие                    | Эмиттится из                    | Слушатели                                 |
| -------------------------- | ------------------------------- | ----------------------------------------- |
| `passport.created`         | `PassportService.create` (Шаг 5) | `EarningsService.createImmediateForCutter` (Шаг 9 — **в той же транзакции**, не через emitter), `PrintHandler` (PDF — за рамками Шага 5; на Шаге 5 печать out-of-band через `GET /api/passports/:id/print`) |
| `passport.cell-placed`     | `PassportService.place`  (Шаг 5) | `DashboardCache` (Шаг 8+)                  |
| `passport.issued`          | `PassportService.issueToEmployee` (Шаг 6) | `DashboardCache` (Шаг 8+)         |
| `passport.operation-scanned` | `PassportService.scanOnOperation` (Шаг 6) | `EarningsService.createPendingForPreviousOperation` (Шаг 9 — **в той же транзакции**, см. `flows.md §F4`), `DashboardCache` (Шаг 8+) |
| `passport.moved`           | `MovementsService.move`         | На MVP не эмитится — `OPERATION_SCAN` достаточно (Шаг 9 учитывает именно его) |
| `passport.defect-recorded` | `QcService.recordDefect`        | `DashboardCache` (инвалидация, если есть). Начисления не пересчитываются (ADR-0012) |
| `passport.packed` *(Шаг 8)* | `PackingService.addPassport`   | `DashboardCache` (упаковка добавляет паспорт в коробку и помечает его `PACKED`; апрув начислений переехал на закрытие коробки — см. строку ниже) |
| `box.closed` *(Шаг 8 → packing-terminal)* | `PackingService.close` | `EarningsService.approvePendingForPassport` для каждого `BoxItem` (**в той же транзакции**, переводит `PENDING_RELEASE → APPROVED`). Это «final completion event» цепочки начислений, см. ADR-0005, ADR-0011 §7. |
| `cell.content-changed`     | `CellsService.place/remove`     | — (на MVP)                                |

Все обработчики выполняются **в той же транзакции**, где было изменение, —
через `prisma.$transaction(async (tx) => ...)` и явные вызовы методов,
а не асинхронный emitter. Emitter используется только для «рыхлых»
побочных эффектов вроде инвалидации кеша.

> MVP-упрощение: **начисления и апрув пишем прямо в транзакции**, без
> асинхронного event-bus-а. Это безопаснее для денег.

---

## 4. Схема таблицы `PassportEvent`

См. `erd.md §2.10` и `prisma/schema.prisma`.

Ключевые индексы:

- `(passportId, createdAt)` — построение истории паспорта.
- `(type, createdAt)` — выборки для дашборда (напр., «все MOVED за час»).
- `(operationId, createdAt)` — «что происходило на операции».

---

## 5. Проекции от событий

На MVP текущее состояние паспорта держим **денормализованно** в
`Passport.currentOperationId / status / qty*`. Это быстрее и проще.

Что можно пересчитать из событий:

- История перемещений: все `MOVED` по `passportId`.
- Время на каждой операции: по парам `OPERATION_STARTED` / `OPERATION_FINISHED`.
- Количество дефектов: `SUM(qty)` по `DEFECT_RECORDED` для паспорта
  (тождественно `Passport.qtyDefect` — мы держим оба для скорости).
  Подробная разбивка по причинам — из таблицы `PassportDefect`.

**Шаг 10 (экран «Цех»)** **намеренно не считает stage из событий**.
Проекция `ShopfloorService` читает текущий `Passport.status` /
`currentOperation.category` / `BoxItem.box.closedAt` и собирает
матрицу `size × stage → qty` за один SQL-запрос. См.
[ADR-0013](./adr/0013-shopfloor-stage-mapping.md) — отказ от
event-проекции на этом шаге обоснован простотой и производительностью.

---

## 6. Идемпотентность

Любое событие пишется в транзакции вместе с изменением состояния агрегата.
Повторный скан того же паспорта на той же операции сотрудником — **no-op**
(проверяем: если `currentOperationId` уже равен целевому — возвращаем 200
без создания новых событий).

Клиент-сторона может слать `Idempotency-Key` в заголовке (на будущее), на MVP
достаточно идемпотентности по состоянию.

---

## 7. Audit / журнал действий (отдельно)

Вне скоупа MVP. Для продового режима предусмотрена будущая таблица
`ActivityLog(userId, action, entity, entityId, payload, createdAt)` —
пока фиксируем только `PassportEvent`.
