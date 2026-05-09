# ADR-0005: Моменты и статусы начислений зарплат

- Статус: принято
- Дата: 2026-04-17

## Контекст

ТЗ §8–§10:

- Раскройщик (сдельный) — начисление сразу при создании паспорта, статус
  APPROVED.
- Пошив (сдельный) — начисление в момент явного завершения операции
  швеёй (`completeOperationByEmployee`), статус PENDING. Становится
  APPROVED только после упаковки.
- Окладные роли (ОТК, помощник раскройщика, упаковка) — никакие
  OperationEntry вообще не создаются.

## Решение

### Создание

- **Раскройщик**: `OperationEntry` создаётся в транзакции `PassportService.create`,
  `operationId = CUT_CUT` (оплачиваемая операция раскроя),
  `qty = passport.qtyCut`, `status = APPROVED`, `approvedAt = now()`.

- **Пошив**: `OperationEntry` создаётся в транзакции
  `PassportsService.completeOperationByEmployee` **для самой швеи и
  только что завершённой операции** (если `Operation.pricingMode ≠
  SALARY_ONLY`, операция не `CUT_CUT` и роль исполнителя —
  `PIECEWORK`/`MIXED`). Источник — `EarningsService.createPendingForCompletedOperation`,
  `sourceEventId = OPERATION_FINISHED PassportEvent.id`,
  `sourceEventType = OPERATION_TRANSITION`. `status = PENDING_RELEASE`,
  `approvedAt = null`.

  **Важно (изменение 2026-05).** Раньше начисление создавалось в
  `scanOnOperation` *для предыдущего исполнителя предыдущей операции*
  при сканировании на следующую. Это создавало ловушку «последняя
  операция перед упаковкой»: за неё никто не получал, потому что
  следующего скана уже не было — паспорт уходил в коробку. Перенос
  записи на `completeOperationByEmployee` устраняет эту ловушку
  (см. также `docs/flows.md §F4`). `scanOnOperation` остаётся
  pipeline-движком (обновление `currentOperationId/Employee`), но
  сдельных строк больше не пишет.

- **Окладные**: ничего не создаём. Зарплата начисляется фиксированным окладом
  (см. `PayrollService.computeSalaryMonth`).

### Апрув

Финальный апрув pending-начислений выполняется в транзакции
`PackingService.close` (закрытие коробки) — это и есть «final
completion event» цепочки в scan-driven packing-терминале
(см. ADR-0011 §7, `docs/screens.md §6`, `docs/flows.md §F7`).

В одной транзакции с `Box.closedAt = now()` сервис итерируется
по `BoxItem[]` и для каждого `passportId` дёргает
`EarningsService.approvePendingForPassport`, что эквивалентно:

```sql
UPDATE OperationEntry
   SET status = APPROVED, approvedAt = NOW()
 WHERE passportId = :id
   AND status IN ('PENDING_RELEASE', 'PENDING');
```

**Что было раньше.** До scan-driven packing-терминала апрув
вызывался прямо в `PackingService.addPassport` (т. е. на каждый скан
паспорта в коробку). Это работало, но размазывало момент
«начислили всем» по часу-двум сканирования. Перенос на close
сохраняет инвариант денег один-в-один: метод
`approvePendingForPassport` идемпотентен (фильтрует только
`PENDING_RELEASE`/legacy `PENDING`), а внешняя защита
`BoxClosedException` не даёт повторно вызвать close ещё раз.

**Что не меняется.** Источник истины и формулы расчёта
(`OperationEntry`, `EarningsService`) остаются прежними. Ставка
по-прежнему берётся как описано ниже.

> **Update 2026-04 (ADR-0020):** runtime-источник ставки —
> `OperationsService.resolveRate(operationId, sizeId)`
> поверх `Operation.fixedRate` / `OperationRateBySize.rate`.
> Константа `PIECEWORK_OPERATION_CODES` снята из runtime
> (заменено на `op.pricingMode ≠ SALARY_ONLY`).
>
> **Update 2026-05 (PHASE 2 STEP 1):** историческая таблица
> `PieceRate` физически удалена (см. ADR-0020 §«PHASE 2 — drop
> legacy»). На контракт §«Ставка» это не влияет — ставку даёт
> `resolveRate` поверх новой модели.

### Ставка

Возвращает `OperationsService.resolveRate(operationId, sizeId)`:

- `pricingMode = FIXED` → `Operation.fixedRate`;
- `pricingMode = BY_SIZE` → `OperationRateBySize.rate` для
  данного размера (отсутствие — 422 `OPERATION_RATE_MISSING`);
- `pricingMode = SALARY_ONLY` → `null`, `EarningsService`
  тихо пропускает операцию и не создаёт `OperationEntry`.

Поиск «по специфичности» (operation+product+size → operation+product
→ operation) был у legacy-таблицы `PieceRate`; новая модель не
смешивает `productId` (см. ADR-0020 §5 — future work).

## Последствия

+ Справедливо: раскройщик не зависит от судьбы партии, швея — зависит.
+ Просто реализуется (всё транзакционно, без отложенных задач).
− Отмена упаковки (в будущем) должна уметь откатывать PENDING — это
  компенсирующее событие и отдельный кейс.
