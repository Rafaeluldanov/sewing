# ADR-0005: Моменты и статусы начислений зарплат

- Статус: принято
- Дата: 2026-04-17

## Контекст

ТЗ §8–§10:

- Раскройщик (сдельный) — начисление сразу при создании паспорта, статус
  APPROVED.
- Пошив (сдельный) — начисление при переходе на следующую операцию,
  статус PENDING. Становится APPROVED только после упаковки.
- Окладные роли (ОТК, помощник раскройщика, упаковка) — никакие
  OperationEntry вообще не создаются.

## Решение

### Создание

- **Раскройщик**: `OperationEntry` создаётся в транзакции `PassportService.create`,
  `operationId = CUT_CUT` (оплачиваемая операция раскроя),
  `qty = passport.qtyCut`, `status = APPROVED`, `approvedAt = now()`.

- **Пошив**: `OperationEntry` создаётся в транзакции `MovementsService.move`
  **для предыдущего сотрудника и операции** (если операция принадлежит
  категории `SEWING` и роль исполнителя — `PIECEWORK`).
  `status = PENDING`, `approvedAt = null`.

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
(`OperationEntry`, `PieceRate`, `EarningsService.PIECEWORK_OPERATION_CODES`)
остаются прежними. Ставка по-прежнему берётся как описано ниже.

### Ставка

Берётся из `PieceRate` — ищется запись с максимально специфичным
совпадением (operation+product+size → operation+product → operation),
действующая на `createdAt` паспорта/перехода.

## Последствия

+ Справедливо: раскройщик не зависит от судьбы партии, швея — зависит.
+ Просто реализуется (всё транзакционно, без отложенных задач).
− Отмена упаковки (в будущем) должна уметь откатывать PENDING — это
  компенсирующее событие и отдельный кейс.
