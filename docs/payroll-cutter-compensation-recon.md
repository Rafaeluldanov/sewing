# Cutter compensation recon

> **ARCHIVED / HISTORICAL.** Этот документ написан до введения
> master-справочника `CompanyDivision` и удаления legacy
> `enum OrderDivision` (PHASE 2). Источник истины подразделения
> заказа теперь — `Order.companyDivisionId → CompanyDivision`,
> `EarningsService` ветвится по `passport.order.companyDivision.code`
> (см. `docs/domain.md §«Подразделения заказа»`). Helper
> `getCutterCompensationSchemeForDivision` сохранён с тем же
> контрактом и теперь принимает строку-`code`. Сами схемы
> (`MARKETPLACE_FIXED` / `B2B_SEWING_PERCENT`) и формулы расчёта
> не изменились.
>
> Документ оставлен для исторического контекста — упоминания
> `Order.division` / `enum OrderDivision` ниже в коде уже не
> существуют.
>
> Технический recon перед добавлением второй (B2B) схемы начисления
> закройщика. Код, Prisma, миграции, backend, frontend, DTO и тесты в
> этом recon **не меняются**. Документ описывает, где сейчас живёт
> «hardcoded» начисление, какие у него инварианты и как мягко
> встроить вторую схему, не сломав существующий marketplace-flow.

## 1. Краткий вывод

Что уже есть в системе:

- Единственный путь начисления закройщика — `EarningsService.
  createImmediateForCutter(...)` (`apps/api/src/modules/earnings/
  earnings.service.ts`). Триггер один — момент выпуска паспорта в
  `PassportsService.create(...)` в той же транзакции, что и
  `passport.create` (см. `passports.service.ts` ~ строка 242).
- Источник истины тарифа — `OperationsService.resolveRate(operationId,
  sizeId, tx)`. Для `CUT_CUT` `pricingMode = FIXED`, `fixedRate`
  берётся напрямую (см. `tests/utils/seed.ts` и
  `prisma/seed.ts`). По сути это и есть «hardcoded» формула:
  `amount = Operation.fixedRate × passport.qtyCut`.
- Идемпотентность защищена `@@unique([passportId, operationId,
  employeeId, sourceEventType])` на `OperationEntry` (см.
  `prisma/schema.prisma::OperationEntry`, ADR-0012); сервис ловит
  `P2002` и трактует как «дубль уже создан».

Что нужно добавить (без destructive-миграций, всё additive):

- Поле `Employee.cutterB2bSewingPercent Decimal? @db.Decimal(5, 2)` —
  настраиваемый процент B2B по сотруднику-закройщику.
- Fallback ENV `CUTTER_B2B_SEWING_PERCENT` для случая, когда у
  сотрудника процент не задан.
- Shared-модуль `packages/shared/src/cutter-compensation.ts` с
  enum'ом схем (`MARKETPLACE_FIXED` / `B2B_SEWING_PERCENT`),
  human-labels и helper'ом `getCutterCompensationSchemeForDivision(
  division)`.
- Внутри `EarningsService.createImmediateForCutter` ветвление по
  `Order.division`: marketplace оставляем 1-в-1, для B2B —
  считаем плановую сумму операций пошива по маршруту и берём от
  неё процент.
- В UI `OrderDivision.OTHER` подписываем как `"B2B"` (label-only,
  enum не переименовываем).
- В карточке сотрудника-закройщика — поле «Процент от операций пошива
  B2B».

Почему не меняем триггер начисления:

- Триггер закройщика прибит к `PASSPORT_CREATED` и используется как
  часть ключа идемпотентности (`sourceEventType`). Перенос на
  `CELL_PLACED` или другое событие сломал бы уникальный ключ и
  пересчитал бы начисления старых паспортов. ТЗ явно требует
  «не переносить начисление на другой event без необходимости».

## 2. Где живёт текущая hardcoded схема

Один путь, одно место:

- `apps/api/src/modules/earnings/earnings.service.ts` —
  `createImmediateForCutter(tx, args)`:
  ```ts
  // загружаем employee + проверяем piecework eligibility
  // загружаем Operation { code: 'CUT_CUT' }
  // если pricingMode === 'SALARY_ONLY' → return
  const rate = await this.operations.resolveRate(op.id, args.sizeId, tx);
  if (!rate) return;
  const amount = roundMoney(rate.times(args.qty));
  await this.safeCreate(tx, {
    passportId, operationId: op.id, employeeId: employee.id,
    qty: args.qty, ratePerUnit: rate, amount,
    status: APPROVED, approvalMode: IMMEDIATE,
    sourceEventType: PASSPORT_CREATED,
    sourceEventId: null, approvedAt: new Date(),
  });
  ```
- Вызов: `apps/api/src/modules/passports/passports.service.ts`
  ~ строка 242 (`PassportsService.create`), внутри
  `prisma.$transaction(...)`. Других вызовов
  `createImmediateForCutter` нет — `Grep` по проекту даёт ровно
  одно место.
- Параметры триггера:
  - `operationId = Operation.code = CUT_CUT` (резолвится по `code`);
  - `employeeId = Passport.cutterId` (на MVP = seed-учётка `cutter`,
    либо `creator`, см. `PassportsService.create`);
  - `sourceEventType = EarningSource.PASSPORT_CREATED`;
  - `sourceEventId = null` (для immediate-cutter не используется,
    см. `prisma/schema.prisma::OperationEntry.sourceEventId`);
  - `qty = passport.qtyCut`.

Идемпотентность:

- `@@unique([passportId, operationId, employeeId, sourceEventType])`
  на `OperationEntry` (Prisma, имя `OperationEntry_idem`).
- `EarningsService.safeCreate` глотает `P2002` — повторный create
  паспорта в той же транзакции / повторный фоновый job не плодит
  дублей.

## 3. Как получить `Order.division` из паспорта

- `Passport.orderId → Order.division` (Prisma `Order.division
  OrderDivision @default(OTHER)`).
- Внутри `createImmediateForCutter` мы уже находимся в транзакции;
  `tx.passport.findUnique({ where: { id }, select: { order: { select:
  { division: true, routeTemplateId: true } } } })` стоит дёшево.
- Альтернатива — пробросить `division` параметром из `PassportsService.
  create`, где `Order` уже подгружен (`include: { items: ..., passports:
  true, routeSteps: ... }`). Это микро-оптимизация, на MVP не
  обязательна — внутренний lookup в EarningsService прозрачнее и
  не размазывает контракт между двумя сервисами.

## 4. OrderDivision сейчас

Prisma enum (`prisma/schema.prisma`):
```
enum OrderDivision {
  MARKETPLACE
  OTHER
}
```

Shared (`packages/shared/src/orders.ts`):
```
export const ORDER_DIVISIONS = ['MARKETPLACE', 'OTHER'] as const;
export const ORDER_DIVISION_LABELS = {
  MARKETPLACE: 'Маркетплейс',
  OTHER: 'Другое',
};
```

ТЗ требует:
- enum `OTHER` сохранить (не переименовывать destructive-миграцией);
- в UI label `OTHER` показывать как `"B2B"`;
- helper `getCutterCompensationSchemeForDivision`:
  - `MARKETPLACE → MARKETPLACE_FIXED`;
  - `OTHER → B2B_SEWING_PERCENT` (legacy technical value for B2B);
  - `B2B → B2B_SEWING_PERCENT` (на случай, когда явное значение
    появится в enum в будущем).

## 5. Где сейчас «хардкодится» сумма и почему она «не B2B-friendly»

Сейчас:

```
amount = Operation.fixedRate × passport.qtyCut
```

Для marketplace это правильно (одна фиксированная ставка раскроя на
единицу), но для B2B заказчик готов платить процент от суммы
операций пошива — то есть сумма должна зависеть от ставок швейных
операций маршрута и от размера паспорта (`BY_SIZE`-тарифы).

База B2B = `Σ rate(SEWING-операция, size) × qtyForCompensation`,
где:
- `qtyForCompensation = passport.qtyCut > 0 ? passport.qtyCut :
  passport.qtyPlan` (контракт с ТЗ §4);
- ставки берём через ту же логику, что `OperationsService.resolveRate`:
  - `FIXED` → `Operation.fixedRate`;
  - `BY_SIZE` → `OperationRateBySize` для `passport.sizeId`;
  - `SALARY_ONLY` → пропустить;
- источник списка операций — snapshot маршрута заказа
  (`Order.routeSteps[]`), фильтруем по `Operation.category = 'SEWING'`.
- Если маршрут не назначен — база `0`, warning
  `«Маршрут не выбран — база B2B не рассчитана»`.

## 6. Контракт нового метода

```
EarningsService.calculateB2bSewingOperationBaseForPassport(
  tx, passportId,
): {
  baseAmountRub: Decimal,
  qtyForCompensation: number,
  operations: Array<{
    operationId, operationCode, operationName,
    pricingMode, rate: Decimal, qty: number, amount: Decimal,
  }>,
  warnings: string[],
}
```

Падение операции (нет ставки / нет маршрута / `SALARY_ONLY`) → не
ломаем workflow, добавляем warning, операцию не включаем в base.

## 7. Контракт нового расчёта

```
amount = roundMoney(baseAmountRub × percent / 100)
ratePerUnit = qtyForCompensation > 0
  ? roundMoney(amount / qtyForCompensation)
  : Decimal(0)
```

Если процент `null` (нет у сотрудника и нет ENV) — **не создаём**
`OperationEntry`, не падаем, пишем audit/log warning
`«Не задан процент начисления закройщика для B2B»`.

## 8. Идемпотентность B2B

Тот же `@@unique([passportId, operationId, employeeId,
sourceEventType])`. `operationId = CUT_CUT`,
`sourceEventType = PASSPORT_CREATED`. Повторный trigger —
`P2002` глотаем как и раньше. UI начислений (`/earnings`) не
ломается: запись та же `OperationEntry` с тем же
`approvalMode = IMMEDIATE`, тем же `status = APPROVED` — отличается
только `amount` / `ratePerUnit`.

## 9. Что НЕ меняем

- `SalaryEntry` — окладные начисления (ОТК, ВТО, упаковка, помощник
  раскройщика, MIXED-сотрудники).
- Pricing/payroll швей: `createPendingForPreviousOperation`,
  `approvePendingForPassport` — обе ветки остаются как есть.
- `OperationEntry` schema — нового поля не добавляем.
- `Passport` schema — нового поля не добавляем.
- `OrderCostEstimate`, `WorkshopNeed`, `PurchaseOrder`,
  `PurchaseReceipt`, `Operation`, `OperationRateBySize` — не
  трогаем.
- `OrderDivision` enum — `OTHER` остаётся как legacy technical
  value для B2B (rename без `--shadow-database` рискованнее, чем
  label-only).
- Старые начисления автоматически не пересчитываются — только новые
  паспорта B2B-заказов получают новую формулу.

## 10. Как теперь читается схема

```
┌─ PassportsService.create  (триггер не меняется)
│  └─ EarningsService.createImmediateForCutter(tx, …)
│     ├─ загружает order.division
│     ├─ scheme = getCutterCompensationSchemeForDivision(division)
│     │
│     ├─ MARKETPLACE_FIXED:
│     │   amount = resolveRate(CUT_CUT, sizeId) × qtyCut
│     │   (1-в-1 старая формула)
│     │
│     └─ B2B_SEWING_PERCENT:
│         base    = calculateB2bSewingOperationBaseForPassport(...)
│         percent = employee.cutterB2bSewingPercent ?? ENV
│         if percent == null → audit warning, skip
│         amount = base × percent / 100
│         ratePerUnit = amount / qtyForCompensation
│
└─ В обоих случаях запись в `OperationEntry` через тот же `safeCreate`,
   с тем же ключом идемпотентности. Marketplace-flow получает audit
   `scheme = MARKETPLACE_FIXED`, B2B-flow — `scheme = B2B_SEWING_PERCENT`
   c полным breakdown'ом.
```

## 11. Проверки

- `CUTTER`-сотрудник на marketplace заказе с теми же ставками
  → amount как раньше (regression), процент B2B не используется.
- B2B заказ + два FIXED-оверлока (50 ₽ и 40 ₽), qty=20, percent=5
  → base=1800, amount=90, ratePerUnit=4.5.
- B2B заказ + BY_SIZE-оверлок (size M = 70), qty=10, percent=10
  → base=700, amount=70, ratePerUnit=7.
- B2B заказ + SALARY_ONLY швейная операция → не попадает в base.
- B2B заказ + SEWING-операция без ставки → не падаем, warning,
  операция не в base.
- B2B заказ + percent отсутствует → нет `OperationEntry`, warning.
- Повторный create паспорта → один `OperationEntry`, не два.
- ОТК/ВТО/упаковка/швеи: payroll не изменился (regress).

## 12. Связанные файлы

- `apps/api/src/modules/earnings/earnings.service.ts` — `createImmediateForCutter`.
- `apps/api/src/modules/passports/passports.service.ts` — единственный
  вызов `createImmediateForCutter`.
- `apps/api/src/modules/operations/operations.service.ts` — `resolveRate`.
- `apps/api/src/modules/employees/employees.service.ts` — create/update,
  ставка процента сохраняется здесь.
- `prisma/schema.prisma::Employee` — добавляется
  `cutterB2bSewingPercent`.
- `prisma/schema.prisma::Order.division` / enum `OrderDivision` —
  не трогаем.
- `packages/shared/src/cutter-compensation.ts` — новый.
- `packages/shared/src/employees.ts` — поле в DTO.
- `packages/shared/src/orders.ts` — label `OTHER` → `B2B`.
- `apps/web/app/admin/employees/{[id],new,create-form,actions}` —
  поле в форме.
