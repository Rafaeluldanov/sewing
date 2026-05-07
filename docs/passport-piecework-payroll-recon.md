# Passport Piecework Payroll RECON

> Симптом: на пробном выпуске одного паспорта в зарплате видны
> только окладные `SalaryEntry`, сдельщина по паспорту не
> суммируется. Этот документ — диагностика, **без правок** кода,
> тестов, Prisma и UI.

## 1. Scope

RECON касается ровно одной проблемы: «по пробному паспорту видны
окладные начисления, но сдельщина не суммируется или не видна».

Что делаем:

- разбираем фактическую модель payroll по коду
  (`apps/api/src/modules/passports`,
  `apps/api/src/modules/earnings`,
  `apps/api/src/modules/packing`,
  `apps/api/src/modules/payroll`,
  `apps/api/src/modules/salary`,
  `apps/api/src/modules/operations`);
- фиксируем точки создания `OperationEntry` и условия попадания в
  `PayrollService` агрегацию;
- собираем read-only SQL-чеклист по конкретному `PASSPORT_ID`;
- классифицируем результат и предлагаем следующее действие.

Что **НЕ** делаем:

- не меняем production-code;
- не меняем `tests/`;
- не меняем `prisma/schema.prisma` и не запускаем миграции;
- не подгоняем тесты, не добавляем endpoint-ы, не правим UI;
- не выполняем destructive-SQL (только `SELECT`).

## 2. Current salary model

| Entity | Meaning | Created by | Included in payroll when |
| --- | --- | --- | --- |
| `SalaryEntry` (`SalaryEntrySource.SHIFT_DAY`) | Окладной день сотрудника `SALARY` / `MIXED` | `SalaryService.syncDailySalary` из `ShiftsService.start/stop` (`apps/api/src/modules/salary/salary.service.ts:99`) | Всегда: `PayrollService.period/daily/employeeDetail/debts` берёт `SalaryEntry` за окно (`SalaryEntry.date`). Если сотрудник `PIECEWORK` — запись вовсе не создаётся (`isSalaryEligible`, `apps/api/src/modules/employees/compensation.ts:53`). |
| `SalaryEntry` (`SalaryEntrySource.MANUAL`) | Ручная окладная корректировка | Только через `PATCH /api/salary/:id` (правка существующей записи); автогенерации нет | Так же, как `SHIFT_DAY`. |
| `OperationEntry` (`PASSPORT_CREATED`, `IMMEDIATE`) | Сдельное начисление раскройщика при выпуске паспорта | `EarningsService.createImmediateForCutter` из `PassportsService.create` (`apps/api/src/modules/earnings/earnings.service.ts:121`, вызов в `passports.service.ts:284`) | Всегда: создаётся `status = APPROVED`, `approvedAt = now()`. В `PayrollService.period/daily/debts` попадает по `createdAt` сразу. |
| `OperationEntry` (`OPERATION_TRANSITION`, `AFTER_RELEASE`) | Сдельное начисление швее за предыдущую операцию | `EarningsService.createPendingForPreviousOperation` из `PassportsService.scanOnOperation` (`earnings.service.ts:723`, вызов в `passports.service.ts:1399`) | Создаётся `status = PENDING_RELEASE`. В `PayrollService` попадает в `pieceworkPendingRub`, **не** в `pieceworkApprovedRub` и **не** в `debtRub`. APPROVED — только после `PackingService.close`. |
| `PayrollPayoutLine` | Snapshot выплаты | `PayrollPayoutsService` (manual) | Не «исключает» начисления — `PayrollService.period/debts` показывают и accrued, и `payoutCoveredRub` отдельно. Lock-by-line блокирует только ручную правку (`SalaryService.updateManually`, `salary.service.ts:323`). |
| `PayrollAccrualDocumentLine` | Snapshot документа начисления | `PayrollAccrualDocumentsService` (manual) | На MVP в `PayrollService` напрямую не вычитается; используется UI-документами `/admin/payroll/accrual-documents`. |

**Какие `OperationEntry.status` попадают в payroll**:

| Status | `PayrollService.period.totalApprovedRub` / `daily.pieceworkApprovedRub` / `debts.accruedPieceworkRub` | `PayrollService.*.pieceworkPendingRub` |
| --- | --- | --- |
| `APPROVED` | да | нет |
| `PENDING_RELEASE` | нет | да |
| `PENDING` (legacy) | нет | да (фолбэк через `in: [PENDING_RELEASE, PENDING]`, `payroll.service.ts:152, 239, 583, 892`) |
| `CANCELLED` | нет | нет |
| `REVERSED` | нет | нет |

`ApprovalMode` (`IMMEDIATE` / `AFTER_RELEASE`) **не** используется
как фильтр в `PayrollService` — это только дискриминатор контракта
на стороне `EarningsService`. Фильтр payroll идёт исключительно по
`status`.

`PENDING_RELEASE` переходит в `APPROVED` в `PackingService.close()`
(`apps/api/src/modules/packing/packing.service.ts:390`), который для
каждого `BoxItem.passportId` зовёт
`EarningsService.approvePendingForPassport(tx, passportId)`
(`earnings.service.ts:789`). Это ровно один SQL-update:

```ts
tx.operationEntry.updateMany({
  where: { passportId, status: { in: ['PENDING_RELEASE', 'PENDING'] } },
  data: { status: 'APPROVED', approvedAt },
});
```

`PayrollService` исключений «уже выплачено» по `OperationEntry` /
`SalaryEntry` **не делает**: суммы accrued считаются всегда полностью,
а `payoutCoveredRub` показывается отдельной колонкой. То есть строка,
включённая в `PayrollPayoutLine`, всё равно попадает в accrued —
просто параллельно растёт `payoutCoveredRub` и `netToPayRub` падает
до нуля (`payroll.service.ts:296`–`349`, `payroll.service.ts:986`–
`1015`).

## 3. OperationEntry creation points

| Flow point | Method | When called | `sourceEventType` | `status` | `approvalMode` | Employee |
| --- | --- | --- | --- | --- | --- | --- |
| `Passport.create` | `EarningsService.createImmediateForCutter` (`earnings.service.ts:121`) | Внутри той же транзакции, что `passport.create` (`passports.service.ts:284`) | `PASSPORT_CREATED` | `APPROVED` | `IMMEDIATE` | `Passport.cutterId` (резолв `resolveCutter`, `passports.service.ts:1962`). Только `role = CUTTER`, `active = true`, `compensationType ≠ SALARY`. |
| `Passport.update` (правка кроя на CREATED) | `createImmediateForCutter` повторно (после `deleteMany sourceEventType=PASSPORT_CREATED`) | `passports.service.ts:577`, `passports.service.ts:620` | `PASSPORT_CREATED` | `APPROVED` | `IMMEDIATE` | Новый `cutterId` |
| `Passport.scanOnOperation` | `EarningsService.createPendingForPreviousOperation` (`earnings.service.ts:723`) | Внутри той же транзакции, что `passport.update` + `OPERATION_SCAN` (`passports.service.ts:1399`) | `OPERATION_TRANSITION` | `PENDING_RELEASE` | `AFTER_RELEASE` | `previousEmployeeId` (предыдущий исполнитель), но только если предыдущая операция не `CUT_CUT`, не `SALARY_ONLY`, есть ставка и работник `PIECEWORK`/`MIXED`. |
| `Passport.completeOperationByEmployee` | — | `passports.service.ts:1503` | — | — | — | **OperationEntry не создаётся.** Метод только пишет `OPERATION_FINISHED` event и снимает `currentEmployeeId`. Сдельщина создаётся следующим `scanOnOperation` (когда другой швея/упаковщик сканирует паспорт). |
| `Passport.issueToEmployee` | — | `passports.service.ts:972` | — | — | — | **OperationEntry не создаётся.** Issue — это «получить крой», не переход операции. |
| `PackingService.addPassport` | — | `packing.service.ts:211` | — | — | — | **OperationEntry не создаётся**, упаковка оплачивается окладом. Только `PassportEvent(PACKED)` + `Passport.status = PACKED`. |
| `PackingService.close` | `EarningsService.approvePendingForPassport` (`earnings.service.ts:789`) | `packing.service.ts:421` для каждого `BoxItem.passportId` | — | `PENDING_RELEASE → APPROVED` (UPDATE, не INSERT) | — | Не создаются новые записи; промоутятся уже существующие. |
| Manual / admin | — | — | — | — | — | Ни в одном контроллере (`earnings.controller.ts`, `passport-earnings.controller.ts`, `admin/*`) явного создания `OperationEntry` через HTTP **нет**. Все записи создаются только из transactions выше. |

Ключевая семантика:

- сдельщина раскройщику = `Passport.create` (один атомарный
  immediate `APPROVED`);
- сдельщина швее = `Passport.scanOnOperation` следующим
  исполнителем (creates `PENDING_RELEASE` для предыдущей операции и
  её работника);
- финализация всех `PENDING_RELEASE` по паспорту = только
  `PackingService.close` (закрытие коробки, в которой лежит этот
  паспорт).

## 4. Passport create / cutter attribution flow

`PassportsService.create` (`apps/api/src/modules/passports/passports.service.ts:133`–`297`):

1. Проверяется заказ (`status = IN_PRODUCTION`), строка размера
   (`OrderItem`), отсутствие `CuttingClosureRequest = APPROVED` для
   `(orderId, productId, sizeId)`, остаток плана.
2. Загружается `creator` (`creatorEmployeeId` из сессии,
   ADR-0014) и операция `CUT_DIVISION` (нужна для
   `currentOperationId` нового паспорта).
3. **Cutter attribution** — `resolveCutter(dto.cutterId, creator)`
   (`passports.service.ts:1962`):
   - Если `dto.cutterId` пришёл — ищем `Employee`, требуем
     `role = CUTTER` + `active = true`. Иначе:
     - не найден / не CUTTER → `CutterNotFoundException` (HTTP **404**, `code: CUTTER_NOT_FOUND`, см. `common/errors.ts`).
     - не active → `CutterInactiveException` (HTTP **409**, `code: CUTTER_INACTIVE`).
   - Если `dto.cutterId` пуст и `creator.role = CUTTER` →
     возвращаем самого creator-а (исторический happy-path).
   - Иначе (creator = `CUTTER_ASSISTANT` / `SHOP_MANAGER` /
     `ADMIN` без `cutterId`) → `CutterRequiredException` (HTTP
     400, `code: CUTTER_REQUIRED`). Фронт обязан показывать select
     раскройщика.
4. В `prisma.$transaction`:
   - резервируется номер (`passport-number.service.ts`);
   - создаётся `Passport` (`status = CREATED`,
     `currentOperationId = CUT_DIVISION`,
     `currentEmployeeId = creator.id`, `cutterId = cutter.id`,
     `creatorId = creator.id`, `currentRouteStepIndex = 0` если у
     заказа есть snapshot маршрута);
   - проставляется финальный `qrCode`;
   - пишется `PassportEvent(CREATED)`;
   - **вызывается `EarningsService.createImmediateForCutter(tx, …)`**
     (`passports.service.ts:284`).

`createImmediateForCutter` (`earnings.service.ts:121`–`196`)
выполняет следующие проверки в порядке (early-return):

| # | Условие → ранний выход | Эффект |
| --- | --- | --- |
| 1 | `qty <= 0` | сдельщина не создаётся |
| 2 | `Employee` не найден / `active = false` | сдельщина не создаётся |
| 3 | `!isPieceworkEligible(compensationType)` (т.е. `compensationType = SALARY`) | сдельщина не создаётся (тихий skip — ADR-0021) |
| 4 | `Operation(code='CUT_CUT')` отсутствует | сдельщина не создаётся (на проде это аномалия, см. JSDoc) |
| 5 | `Operation.pricingMode = SALARY_ONLY` | сдельщина не создаётся |
| 6 | `Passport` не найден (теоретически невозможно — мы только что его создали) | сдельщина не создаётся |

После этого выбирается схема через
`getCutterCompensationSchemeForDivision(passport.order.companyDivision?.code ?? null)` (`packages/shared/src/cutter-compensation.ts`):

- `code = MARKETPLACE` → `MARKETPLACE_FIXED`:
  `createImmediateForCutterMarketplace` (`earnings.service.ts:203`)
  - `rate = OperationsService.resolveRate('CUT_CUT'.id, sizeId, tx)` (`operations.service.ts:418`).
    - `pricingMode = FIXED`: `Operation.fixedRate`. Если `null` — кидается `OperationRateMissingException` (HTTP 422). Это **обрушит всю транзакцию `passport.create`**, паспорт не создастся.
    - `pricingMode = BY_SIZE`: `OperationRateBySize` для `(operationId, sizeId)`. Нет строки — тоже `OperationRateMissingException`.
    - `pricingMode = SALARY_ONLY`: `null` → `if (!rate) return;` → silent skip (ветка #5 выше уже отсёкла бы).
  - `amount = rate × qtyCut`, `safeCreate(... status=APPROVED, sourceEventType=PASSPORT_CREATED, approvalMode=IMMEDIATE)`.
- любой другой `code` (включая `OTHER`) или `null` → `B2B_SEWING_PERCENT`:
  `createImmediateForCutterB2b` (`earnings.service.ts:260`)
  - `percent = resolveCutterB2bPercent(employee.cutterB2bSewingPercent)`:
    1. `Employee.cutterB2bSewingPercent` если `>0` и `<=100`;
    2. ENV `CUTTER_B2B_SEWING_PERCENT` (запятая → точка, `(0; 100]`);
    3. иначе `null`.
  - **Если `percent = null` → silent skip**: `audit('CUTTER_B2B_PERCENT_MISSING')`, `OperationEntry` не создаётся (`earnings.service.ts:272`–`293`).
  - `base = calculateB2bSewingOperationBaseForPassport` (`earnings.service.ts:534`–`700`):
    - перебирает `Order.routeSteps[]` с `category = SEWING`;
    - для каждой швейной операции резолвит ставку: `FIXED` (`Operation.fixedRate`), `BY_SIZE` (`OperationRateBySize` для `passport.sizeId`), `SALARY_ONLY` пропускает с warning;
    - `base = Σ rate × qtyForCompensation` (qtyCut > 0 ? qtyCut : qtyPlan);
    - **если `base = 0` или `qtyForCompensation = 0`** (нет switch-операций / нет ставок / SALARY_ONLY на всех / нет маршрута) → `audit('CUTTER_B2B_AMOUNT_ZERO')`, **`OperationEntry` не создаётся** (`earnings.service.ts:306`–`343`).
  - Иначе `amount = roundMoney(base × percent / 100)`, `safeCreate(... status=APPROVED, sourceEventType=PASSPORT_CREATED, approvalMode=IMMEDIATE)`.

**Кластер C5 из `docs/integration-full-run-recon.md`**:
тесты `cutter-attribution.test.ts:134, 180` проверяют, что в
`PassportsService.create` immediate-cutter-entry создаётся
(`OperationEntry.findFirst({ passportId, sourceEventType:
'PASSPORT_CREATED' })`). На реальном запуске они возвращают
`null` — то есть `createImmediateForCutter` уходит в
один из silent-skip (B2B percent missing / B2B amount zero / no
fixedRate / SALARY-cutter). Это та же ветка, в которой может
застрять и пробный паспорт.

## 5. Sewing operation flow

Пошив создаёт сдельщину **только** в `PassportsService.scanOnOperation`
(`passports.service.ts:1287`), и платит **предыдущему** исполнителю
**предыдущей** операции:

- `issueToEmployee` (`passports.service.ts:972`) — НЕ создаёт
  сдельщину; меняет только `currentEmployeeId`,
  `currentCellId = null`, `status = IN_PROGRESS`, пишет
  `ISSUED_TO_EMPLOYEE` event.
- `scanOnOperation` (`passports.service.ts:1287`): берёт
  `previousOperationId`/`previousEmployeeId` ДО апдейта, обновляет
  паспорт на новую `session.operationId` + `currentEmployeeId =
  scanner`, пишет `OPERATION_SCAN` event и зовёт
  `createPendingForPreviousOperation`.
- `completeOperationByEmployee` (`passports.service.ts:1503`) —
  НЕ создаёт сдельщину; снимает `currentEmployeeId = null`, пишет
  `OPERATION_FINISHED`. Сдельщина за «эту» операцию появится только
  когда следующий сотрудник просканирует паспорт.

`createPendingForPreviousOperation` (`earnings.service.ts:723`–`776`)
early-returns:

| # | Условие → ранний выход |
| --- | --- |
| 1 | `previousOperationId == null` (паспорт ещё ни разу не сканировался — например, после `Passport.create` `currentOperationId = CUT_DIVISION`, и первый scan на швейной операции платит за `CUT_DIVISION`. См. ниже.) |
| 2 | `previousEmployeeId == null` (паспорт лежал «бесхозный» после complete) |
| 3 | `qty <= 0` |
| 4 | `Operation` не найден |
| 5 | `Operation.pricingMode = SALARY_ONLY` |
| 6 | `Operation.code = 'CUT_CUT'` (cutter покрыт immediate-веткой) |
| 7 | `Employee` не найден / неактивен |
| 8 | `!isPieceworkEligible(compensationType)` |
| 9 | `OperationsService.resolveRate(prevOpId, sizeId, tx)` вернул `null` (= `SALARY_ONLY`) — но если ставка для FIXED/BY_SIZE отсутствует, `resolveRate` **бросает** `OperationRateMissingException` и обрушивает scan-транзакцию. |

Иначе создаётся `safeCreate(... status=PENDING_RELEASE,
approvalMode=AFTER_RELEASE, sourceEventType=OPERATION_TRANSITION,
sourceEventId=event.id, qty=passport.qtyCut)`.

Замечание про `CUT_DIVISION`: после `Passport.create`
`previousOperationId = CUT_DIVISION` (это значение проставляется в
`Passport.create`). Когда швея впервые сканирует паспорт,
`createPendingForPreviousOperation` вызывается с
`previousOperationId = CUT_DIVISION`. `pricingMode` у `CUT_DIVISION`
зависит от seed/admin-конфига; `code !== 'CUT_CUT'`, поэтому ветка #6
не сработает. Если `CUT_DIVISION.pricingMode = SALARY_ONLY` или нет
ставки для размера паспорта — реакция как в таблице выше (silent
skip / 422 на scan).

Поведение по конфигурации:

- `compensationType = SALARY` у предыдущего сотрудника → silent skip
  на проверке #8.
- `pricingMode = SALARY_ONLY` → silent skip.
- ставки нет (FIXED без `fixedRate` / BY_SIZE без
  `OperationRateBySize`) → 422 `OPERATION_RATE_MISSING` на сам scan
  (`scanOnOperation` упадёт, паспорт останется на предыдущем шаге).

## 6. Packing / release approval flow

`PackingService.addPassport` (`apps/api/src/modules/packing/packing.service.ts:211`–`384`):

- проверяет упаковщика (`PACKING`-сессия), `Passport.status =
  IN_PROGRESS` + `qtyGood > 0`, однородность коробки, capacity;
- создаёт `BoxItem`, инкрементит `Box.totalQty`, выставляет
  `Passport.status = PACKED`, `currentEmployeeId/currentCellId =
  null`;
- пишет `PassportEvent(PACKED)` и
  `FinishedGoodsService.recordPackedPassportInTx` (foundation
  готовой продукции, к payroll отношения не имеет);
- **сдельщина не апрувится** — это намеренно, см. ADR-0011 §5 и
  JSDoc `PackingService` (`packing.service.ts:373`).

`PackingService.close` (`packing.service.ts:390`–`446`):

- проверяет `closedAt = null` и `totalQty > 0`;
- `box.update({ closedAt: new Date() })`;
- для каждого `BoxItem.passportId` зовёт
  `EarningsService.approvePendingForPassport(tx, passportId)`
  (`packing.service.ts:421`);
- пишет `BOX_CLOSED` audit-событие.

`approvePendingForPassport` — один `updateMany` по `(passportId,
status IN (PENDING_RELEASE, PENDING)) → APPROVED, approvedAt = now()`.
Уже `APPROVED` / `CANCELLED` / `REVERSED` записи не трогаются. Поэтому
повторный close невозможен (`BoxClosedException` срабатывает раньше);
а если бы и случился — `updateMany` пройдёт по 0 строк и `approvedAt`
у уже `APPROVED` записей не сдвинется.

**Следствие**: сдельщина пошива (`OPERATION_TRANSITION`) **не
суммируется в `pieceworkApprovedRub`** до момента, пока паспорт не
попал в коробку и коробку не закрыли. До этого она сидит в
`pieceworkPendingRub`. Это и есть expected behavior — единственный
управленческий «final completion event» для пошивных начислений.

`PayrollPayout` / `PayrollAccrualDocument` начисление ничего не
двигают: они работают «поверх» `OperationEntry`/`SalaryEntry`. Если
строка попала в `PayrollPayoutLine`, её `status` в `OperationEntry`
не меняется; `PayrollService` это учитывает раздельно.

## 7. Payroll aggregation flow

`PayrollService` (`apps/api/src/modules/payroll/payroll.service.ts`)
read-only. Период разворачивается в окно `[from, to]` для
`OperationEntry.createdAt` и `[dayFrom, dayTo]` для `SalaryEntry.date`
(`payroll.service.ts:1220`).

| Source | Included? | Condition | Notes |
| --- | --- | --- | --- |
| `OperationEntry` `APPROVED` | да | `createdAt ∈ period` + employee + role/divisionCode | `pieceworkApprovedRub`, `totalApprovedRub`, `accruedPieceworkRub` (debts), `daily.pieceworkApprovedRub`. См. `payroll.service.ts:231`, `payroll.service.ts:574`, `payroll.service.ts:971`. |
| `OperationEntry` `PENDING_RELEASE` | частично | `createdAt ∈ period` + employee | Только в `pieceworkPendingRub` / `totalPendingRub` / `pendingPieceworkRub` (debts). **Не** в accrued / debt / netToPay. `payroll.service.ts:236`–`248`, `:579`–`592`, `:976`–`984`. |
| `OperationEntry` `PENDING` (legacy) | частично | то же | Подмешивается через `in: [PENDING_RELEASE, PENDING]` ради совместимости. |
| `OperationEntry` `CANCELLED` | нет | — | Не входит ни в один агрегат. |
| `OperationEntry` `REVERSED` | нет | — | Не входит ни в один агрегат. |
| `SalaryEntry` `SHIFT_DAY` | да | `date ∈ period` + employee | `salaryRub`, `accruedSalaryRub`. `payroll.service.ts:249`, `:587`. |
| `SalaryEntry` `MANUAL` | да | то же | Тот же агрегат, дополнительно фигурирует в `salaryEditedRub` если `editedManually = true`. |
| `PayrollPayoutLine` (`status ∈ DRAFT|ISSUED|ACKNOWLEDGED`) | через snapshot | join по `OperationEntry.createdAt` / `SalaryEntry.date` | Заполняет `payoutCoveredRub`/`payoutPieceworkCoveredRub`/`payoutSalaryCoveredRub`/`netToPayRub`. **Не вычитается** из accrued. `payroll.service.ts:296`–`349`. |
| `PayrollAccrualDocumentLine` | нет (косвенно) | — | В `PayrollService.period/daily/employeeDetail/debts` напрямую не используется. UI документов начисления (`/admin/payroll/accrual-documents`) сам читает таблицу. |

Где может «потеряться» APPROVED `OperationEntry`:

- `createdAt` вне `dateFrom..dateTo` (например, период
  «сегодня», а паспорт выпущен вчера в 23:30 UTC, и в локальной
  таймзоне это «сегодня», но `period` использует UTC).
- `divisionCode`-фильтр: для сдельщины фильтр через
  `passport.order.companyDivision.code` (`payroll.service.ts:136`,
  `:514`, `:908`). Если у `Order` `companyDivisionId = null`, при
  выборе любого конкретного `divisionCode` сдельщина **не попадает**
  в выдачу. Эта же проблема разъясняется в JSDoc `period`
  («сотрудники без `companyDivisionId` не попадают…»).
- `role`-фильтр (`employee.role`).
- `employeeId`-фильтр.
- `status`-фильтр (`PayrollPeriodQuery.status`) сужает только
  сдельщину; передача `status = APPROVED` исключит
  `PENDING_RELEASE`, что для пробного паспорта без close —
  ожидаемо.

`employeeDetail` (`payroll.service.ts:691`) считает суммы прямо из
прочитанных `operationEntries[]` / `salaryEntries[]`, без отдельных
агрегатов. Поэтому если в БД сдельщина по сотруднику **есть**, она в
`employeeDetail` будет; если её нет — её не будет нигде.

## 8. UI / API visibility

Где пользователь смотрит зарплату:

- `apps/web/app/earnings/page.tsx` — личная страница `/earnings`
  (видна всем ролям). Не-менеджер: только свои `APPROVED`
  начисления + свои `SalaryEntry`. Менеджер: фильтры по статусу
  (включая `PENDING_RELEASE`), `employeeId`, периоду. API:
  `GET /api/earnings`, `GET /api/earnings/summary`,
  `GET /api/salary`, `GET /api/salary/summary`,
  `GET /api/payroll-payouts` (`apps/web/lib/earnings-api.ts`,
  `apps/web/lib/salary-api.ts`,
  `apps/web/lib/payroll-payouts-api.ts`).
- `apps/web/app/admin/payroll/page.tsx` — ведомость «Зарплата
  за период» (`PayrollService.period`, `GET /api/payroll/period`).
- `apps/web/app/admin/payroll/daily/page.tsx` — снимок «кто
  сегодня работал» (`PayrollService.daily`).
- `apps/web/app/admin/payroll/employees/[id]/page.tsx` —
  карточка сотрудника (`PayrollService.employeeDetail`).
- `apps/web/app/admin/payroll/debts/page.tsx` — отчёт долгов
  (`PayrollService.debts`).
- `apps/web/app/admin/payroll/accrual-documents/*`,
  `apps/web/app/admin/payroll/payouts/*` — документы
  начисления и выплаты.
- `apps/web/app/passports/[id]/page.tsx` и
  `apps/web/app/admin/passports/[id]/page.tsx` —
  карточка паспорта со списком начислений (`GET
  /api/passports/:id/earnings`,
  `EarningsService.listByPassport`, `earnings.service.ts:920`).

UI-семантика статусов:

- `EARNING_STATUS_LABELS` (`apps/web/lib/earnings-api.ts`):
  `PENDING_RELEASE` → «Ожидает выпуск», `APPROVED` →
  «Подтверждено», `REVERSED` → «Сторнировано». То есть
  pending-сдельщина показывается, **если** пользователь /
  endpoint вообще видит pending.
- `/earnings`: не-менеджер видит **только** `APPROVED`
  (`status: 'APPROVED'` принудительно, `earnings.service.ts:967`,
  `apps/web/app/earnings/page.tsx:79`). Это значит, что для
  не-менеджера cdsельщина паспорта станет видна только после
  `PackingService.close`. До close — её на `/earnings` нет.
- `/admin/payroll`: менеджер видит обе колонки —
  `pieceworkApprovedRub` и `pieceworkPendingRub`. Если в `period`
  у сотрудника `pieceworkPendingRub > 0`, а
  `pieceworkApprovedRub = 0`, это и есть «сдельщина создалась, но
  ждёт close».
- `EarningsService.listByPassport`: для не-менеджера фильтрует
  `employeeId = viewer.employeeId` + `status = APPROVED`
  (`earnings.service.ts:935`–`942`). Если работнику показывают
  карточку чужого паспорта — он видит пустой список, даже если
  по паспорту реально есть `APPROVED` чужие.

## 9. Diagnostic SQL for a real passport

> Все запросы только `SELECT`, ничего не пишут. Подставить
> `'<PASSPORT_ID>'`. Имена колонок выверены по
> `prisma/schema.prisma::Passport / OperationEntry / SalaryEntry /
> Operation / OperationRateBySize / Employee / PayrollPayoutLine /
> PayrollAccrualDocumentLine`. PostgreSQL: имена квотируются.

### 9.1 Passport

```sql
SELECT id, "orderId", status, "qtyCut", "qtyGood", "qtyDefect",
       "cutterId", "creatorId", "currentEmployeeId",
       "currentOperationId", "currentRouteStepIndex",
       "createdAt"
FROM "Passport"
WHERE id = '<PASSPORT_ID>';
```

### 9.2 Passport events

```sql
SELECT id, type, "employeeId", "operationId", "fromOperationId",
       qty, "createdAt", payload
FROM "PassportEvent"
WHERE "passportId" = '<PASSPORT_ID>'
ORDER BY "createdAt";
```

### 9.3 OperationEntry by passport

```sql
SELECT id, "passportId", "employeeId", "operationId",
       "sourceEventType", status, "approvalMode",
       qty, "ratePerUnit", amount, "approvedAt", "createdAt"
FROM "OperationEntry"
WHERE "passportId" = '<PASSPORT_ID>'
ORDER BY "createdAt";
```

> Если строк нет — `createImmediateForCutter` ушёл в silent-skip
> на одной из проверок §4 (B2B percent missing / B2B amount zero /
> SALARY-cutter / SALARY_ONLY на CUT_CUT). Audit-trail в §9.10
> подскажет, по какой именно ветке.

### 9.4 Employee compensation

```sql
SELECT id, "fullName", role, "compensationType", "salaryPerShift",
       "cutterB2bSewingPercent", active, "companyDivisionId"
FROM "Employee"
WHERE id IN (
    SELECT "employeeId" FROM "OperationEntry"
    WHERE "passportId" = '<PASSPORT_ID>'
)
   OR id IN (
    SELECT "cutterId" FROM "Passport" WHERE id = '<PASSPORT_ID>'
)
   OR id IN (
    SELECT "creatorId" FROM "Passport" WHERE id = '<PASSPORT_ID>'
)
   OR id IN (
    SELECT "currentEmployeeId" FROM "Passport" WHERE id = '<PASSPORT_ID>'
);
```

> Реальная Prisma-схема не содержит поля `pieceworkPercent` —
> аналогичный смысловой параметр живёт только для cutter-а:
> `cutterB2bSewingPercent`. Поэтому в запрос подставлено именно
> оно. `paymentType` удалён в Шаге 19; единственная ось — `compensationType`.

### 9.5 SalaryEntry

```sql
-- по тем сотрудникам, у которых есть OperationEntry на паспорте
SELECT id, "employeeId", date, source, amount, "editedManually",
       "managerComment", "createdAt"
FROM "SalaryEntry"
WHERE "employeeId" IN (
    SELECT "employeeId" FROM "OperationEntry"
    WHERE "passportId" = '<PASSPORT_ID>'
)
ORDER BY "employeeId", date;
```

Альтернатива, если по паспорту вообще нет `OperationEntry`:

```sql
-- по cutter / creator / currentEmployee паспорта
SELECT id, "employeeId", date, source, amount, "editedManually",
       "managerComment", "createdAt"
FROM "SalaryEntry"
WHERE "employeeId" IN (
    SELECT "cutterId"          FROM "Passport" WHERE id = '<PASSPORT_ID>'
    UNION
    SELECT "creatorId"          FROM "Passport" WHERE id = '<PASSPORT_ID>'
    UNION
    SELECT "currentEmployeeId"  FROM "Passport" WHERE id = '<PASSPORT_ID>'
)
ORDER BY "employeeId", date;
```

### 9.6 Payroll payout lines

```sql
SELECT ppl.id, ppl."payoutId", ppl.kind, ppl."operationEntryId",
       ppl."salaryEntryId", ppl."amountRub", ppl."occurredOn",
       pp.status AS payout_status, pp."employeeId" AS payout_employee
FROM "PayrollPayoutLine" ppl
JOIN "PayrollPayout" pp ON pp.id = ppl."payoutId"
WHERE ppl."operationEntryId" IN (
    SELECT id FROM "OperationEntry" WHERE "passportId" = '<PASSPORT_ID>'
);
```

### 9.7 Payroll accrual document lines

В фактической Prisma-схеме `PayrollAccrualDocumentLine` **не**
хранит прямую FK на `OperationEntry` — снимок начислений живёт в
JSON-поле `snapshot` (`prisma/schema.prisma::
PayrollAccrualDocumentLine.snapshot`). Поэтому прямой `JOIN` через
`operationEntryId` невозможен. Используем JSON-фильтр по
`passportId` внутри snapshot-а (актуально для текущей формы
snapshot-а; форма может меняться от версии).

```sql
SELECT padl.id, padl."documentId", padl."employeeId",
       padl."amountPieceworkRub", padl."amountSalaryRub",
       padl."amountToPayRub", padl."payoutId",
       pad.status   AS document_status,
       pad."accrualDate"
FROM "PayrollAccrualDocumentLine" padl
JOIN "PayrollAccrualDocument"     pad ON pad.id = padl."documentId"
WHERE padl.snapshot::text LIKE '%<PASSPORT_ID>%';
```

> Если форма snapshot-а изменится — заменить `LIKE` на
> `jsonb_path_exists(snapshot, '$.** ? (@.passportId == "<PASSPORT_ID>")')`
> или эквивалент.

### 9.8 Operation rates

```sql
-- операции, по которым есть начисления у этого паспорта,
-- а также его текущая операция
SELECT o.id, o.code, o.name, o.category, o."pricingMode",
       o."fixedRate", o."salaryPlanRubPerShift",
       o."salaryPlanShiftSeconds"
FROM "Operation" o
WHERE o.id IN (
    SELECT "operationId" FROM "OperationEntry"
    WHERE "passportId" = '<PASSPORT_ID>'
)
   OR o.id = (
    SELECT "currentOperationId" FROM "Passport"
    WHERE id = '<PASSPORT_ID>'
);

-- rate-by-size (если pricingMode = BY_SIZE)
SELECT obs."operationId", o.code AS operation_code,
       obs."sizeId", s.code AS size_code, obs.rate
FROM "OperationRateBySize" obs
JOIN "Operation" o ON o.id = obs."operationId"
JOIN "Size"      s ON s.id = obs."sizeId"
WHERE obs."operationId" IN (
    SELECT "operationId" FROM "OperationEntry"
    WHERE "passportId" = '<PASSPORT_ID>'
)
   OR (obs."operationId", obs."sizeId") IN (
    SELECT p."currentOperationId", p."sizeId"
    FROM "Passport" p
    WHERE p.id = '<PASSPORT_ID>'
);

-- Полный route-snapshot заказа (нужно для B2B base):
SELECT ors.index, ors."operationId", o.code, o.category,
       o."pricingMode", o."fixedRate"
FROM "OrderRouteStep" ors
JOIN "Operation" o ON o.id = ors."operationId"
WHERE ors."orderId" = (
    SELECT "orderId" FROM "Passport" WHERE id = '<PASSPORT_ID>'
)
ORDER BY ors.index;
```

### 9.9 Payroll summary diagnostic

```sql
-- 9.9.1 Попадает ли начисление в текущий период PayrollService?
-- Подставить дату пробного выпуска в условие.
SELECT oe.id, oe."employeeId", oe.status, oe."createdAt",
       oe."approvedAt", oe.amount, oe."sourceEventType"
FROM "OperationEntry" oe
WHERE oe."passportId" = '<PASSPORT_ID>'
  AND oe."createdAt" BETWEEN '2026-05-01 00:00:00+00'
                         AND '2026-05-31 23:59:59+00';

-- 9.9.2 Покрытие выплатами по сотрудникам паспорта.
SELECT pp.id AS payout_id, pp.status, pp."periodFrom", pp."periodTo",
       pp."amountTotalRub", pp."employeeId"
FROM "PayrollPayout" pp
WHERE pp.id IN (
    SELECT "payoutId" FROM "PayrollPayoutLine" ppl
    WHERE ppl."operationEntryId" IN (
        SELECT id FROM "OperationEntry"
        WHERE "passportId" = '<PASSPORT_ID>'
    )
);

-- 9.9.3 PayrollAccrualDocument, в которых упоминается паспорт.
SELECT pad.id, pad.status, pad."accrualDate",
       pad."totalPieceworkRub", pad."totalSalaryRub",
       pad."totalToPayRub"
FROM "PayrollAccrualDocument" pad
WHERE pad.id IN (
    SELECT "documentId" FROM "PayrollAccrualDocumentLine" padl
    WHERE padl.snapshot::text LIKE '%<PASSPORT_ID>%'
);

-- 9.9.4 Есть ли текущий BoxItem (т.е. дошёл ли паспорт до упаковки)?
SELECT bi.id, bi."boxId", bi.qty, b.number AS box_number,
       b."closedAt", b."totalQty"
FROM "BoxItem" bi
JOIN "Box"     b ON b.id = bi."boxId"
WHERE bi."passportId" = '<PASSPORT_ID>';
```

### 9.10 Audit trail (cutter earnings)

`EarningsService` пишет audit-события `CUTTER_EARNING_CREATED`,
`CUTTER_B2B_PERCENT_MISSING`, `CUTTER_B2B_AMOUNT_ZERO`
(`earnings.service.ts:439`, `:277`, `:316`). По ним сразу видно,
почему immediate-cutter-entry не появился.

```sql
SELECT al.id, al.event, al."entityType", al."entityId",
       al."employeeId", al.payload, al."createdAt"
FROM "AuditLog" al
WHERE al."entityId" = '<PASSPORT_ID>'
  AND al.event IN (
      'CUTTER_EARNING_CREATED',
      'CUTTER_B2B_PERCENT_MISSING',
      'CUTTER_B2B_AMOUNT_ZERO'
  )
ORDER BY al."createdAt";
```

## 10. Diagnostic checklist for the real passport

Заполнить после прогона запросов §9. Если `PASSPORT_ID` пока не
выдан — таблица остаётся пустой, см. финальное замечание.

| Check | Result | Meaning |
| --- | --- | --- |
| Passport exists | _todo_ | если `null`, то пользователь смотрит другой ID или паспорт удалён |
| Passport status (`CREATED` / `IN_PROGRESS` / `PACKED` / `CANCELLED`) | _todo_ | `CREATED` → ещё не сканировали, OPERATION_TRANSITION-сдельщины не должно быть; `PACKED` без close box → сдельщина пошива в `PENDING_RELEASE` |
| `cutterId` filled (≠ null) | _todo_ | в Prisma это `NOT NULL`; если приложение это нарушит — это уже баг схемы |
| `creatorId` role | _todo_ | `CUTTER` → cutter-attribution = creator; `CUTTER_ASSISTANT` / `SHOP_MANAGER` → должен был приехать `dto.cutterId` |
| `currentEmployeeId` (last actor) | _todo_ | если `null`, паспорт стоит в WIP-buffer или PACKED |
| `currentOperationId` | _todo_ | `CUT_DIVISION` → паспорт ещё ни разу не сканировали швейкой |
| OperationEntry count | _todo_ | 0 → ни immediate-cutter, ни pending-sewing не создавалось |
| `PASSPORT_CREATED` entry exists | _todo_ | если нет — см. §4 silent-skip; смотреть §9.10 audit |
| `OPERATION_TRANSITION` entry exists | _todo_ | если нет — паспорт не сканировался швеёй на следующую операцию или швея на `SALARY` / op `SALARY_ONLY` |
| APPROVED entries total amount | _todo_ | сравнить с тем, что показывает `/earnings` сотрудника |
| PENDING_RELEASE entries total amount | _todo_ | если `> 0` — paid после close box; до close в `pieceworkApprovedRub` не попадает |
| SalaryEntry count for involved employees | _todo_ | окладная всегда видна, если есть смены и `compensationType ∈ SALARY/MIXED` |
| PayrollPayoutLine exists for passport entries | _todo_ | если есть и payout `ISSUED`/`ACKNOWLEDGED` — `SalaryEntry` уже под lock |
| PayrollAccrualDocumentLine упоминает passportId | _todo_ | проверить в snapshot json |
| Operation rate exists for `currentOperationId` × `sizeId` | _todo_ | если нет — на следующем `scan` будет 422 |
| Employee.compensationType (cutter / scanners) | _todo_ | `SALARY` → сдельщина не создаётся, тихий skip |
| Employee.cutterB2bSewingPercent (cutter) | _todo_ | если null + ENV пуст + division ≠ MARKETPLACE → cutter-immediate skip |
| Order.companyDivision.code | _todo_ | `MARKETPLACE` → `MARKETPLACE_FIXED`, любой другой / `null` → `B2B_SEWING_PERCENT` |
| UI endpoint, на котором смотрят зарплату | _todo_ | `/earnings` (не-менеджер: только APPROVED) vs `/admin/payroll` (видно pending) |

> Для финальной классификации нужен `PASSPORT_ID` пробного
> паспорта.

## 11. Classification rules

| Tag | Когда выставляется |
| --- | --- |
| `SERVICE_BUG` | OperationEntry должна быть создана (по §3 → §4/§5), но в БД её нет; audit `CUTTER_EARNING_CREATED` тоже отсутствует. Например: cutter-attribution прошла, employee `PIECEWORK`, percent задан, ставки есть — а записи нет. |
| `ATTRIBUTION_BUG` | OperationEntry создана, но `employeeId` не совпадает с `Passport.cutterId` / последним сканировавшим. Чаще всего проявляется в подмене seed-учётки `cutter`. |
| `EXPECTED_PENDING` | OperationEntry есть в `PENDING_RELEASE`, паспорт ещё не упакован или коробка не закрыта. По текущей логике сдельщина пошива и не должна приходить в `pieceworkApprovedRub` до close box. |
| `PAYROLL_FILTER_BUG` | OperationEntry `APPROVED`, но `PayrollService.period/daily/employeeDetail` её не показывают: проверить `dateFrom..dateTo`, `divisionCode`, `role`-фильтры; cf. §7 «Где может потеряться». |
| `RATE_SETUP_PROBLEM` | `Operation.fixedRate = null` для FIXED, или нет `OperationRateBySize` для (op, size), или `pricingMode = SALARY_ONLY`, или ENV `CUTTER_B2B_SEWING_PERCENT` пуст / `Employee.cutterB2bSewingPercent` null. |
| `COMPENSATION_SETUP_PROBLEM` | Сотрудник на `SALARY` (раскройщик/швея), либо `Employee.cutterB2bSewingPercent = 0`, либо у предыдущего скана работника `compensationType = SALARY`. |
| `UI_DISPLAY_BUG` | Backend агрегаты в `/api/payroll/...` верны (видно через §9.9 + curl), но конкретный экран отображает не то: фильтр по ролям, по статусу, не-менеджер видит только `APPROVED`. |
| `BUSINESS_DECISION` | Спорный кейс: «должна ли вообще сдельщина считаться на этом этапе» (паспорт ещё `IN_PROGRESS`, BoxItem нет). Решает product owner. |
| `TEST_OUTDATED` | Тест ищет `pieceworkPercent` (поля нет) / другой `sourceEventType` / старый HTTP-код. К пробному паспорту обычно не применимо, но если симптом увиден через `npm test`. |

## 12. Known related findings

- `docs/integration-full-run-recon.md §6 «Cutter attribution
  cluster (C5)»` — те же 2 подкластера: `immediateCutterEntryEmployee
  returns null` и HTTP-коды `CUTTER_NOT_FOUND` / `CUTTER_INACTIVE`.
  Первый подкластер прямо ложится на нашу гипотезу №1 (cutter
  immediate skip).
- `tests/integration/cutter-attribution.test.ts` — failing на боевом
  seed по линиям `134`, `180`, `196`, `208`, `230`. Тест запросы
  ровно эквивалентны §4 проверкам.
- `tests/integration/earnings-service.test.ts` — green, контракт
  DTO/idempotency проверен в изоляции (свой `setup.passportId` /
  `op.findUnique('CUT_CUT')`). Это значит, что сервис как функция
  работает; падает либо seed, либо параметры пробного паспорта
  (division / percent / rate).
- `tests/integration/cutter-compensation.test.ts` — green; это
  модуль `packages/shared/cutter-compensation`, не сервис.
- `tests/integration/salary.test.ts` — green; `SalaryEntry` поведение
  стабильно.
- `tests/integration/payroll-payouts.test.ts`,
  `tests/integration/payroll-accrual-documents.test.ts` — green;
  выплата/документ накладывается поверх существующих начислений.
- `tests/integration/packing-close-idempotent.test.ts` — green;
  именно она доказывает, что `PENDING_RELEASE → APPROVED` через
  `PackingService.close` работает идемпотентно. Если pending в
  payroll есть, а после close его нет в approved — это уже регрессия
  по этому тесту, что маловероятно.
- `tests/integration/passports-complete-operation.test.ts` —
  фиксирует, что `completeOperationByEmployee` сам сдельщину НЕ
  создаёт.

Цель: понять, почему изолированный `EarningsService` зелёный,
а production `Passport.create` пробного паспорта может не записать
`PASSPORT_CREATED OperationEntry`. На реальных данных самый частый
ответ — silent-skip в B2B-ветке (`CUTTER_B2B_PERCENT_MISSING` /
`CUTTER_B2B_AMOUNT_ZERO`). Audit §9.10 это покажет в одну строку.

## 13. Current hypotheses

> Гипотезы. Подтверждаются только §9.

1. **OperationEntry по паспорту отсутствует** → `PASSPORT_CREATED`
   silent-skip в `createImmediateForCutter`. Подсказки:
   - `Order.companyDivisionId IS NULL` или `code != 'MARKETPLACE'`
     → ушли в B2B-ветку;
   - `Employee.cutterB2bSewingPercent IS NULL` и нет ENV
     `CUTTER_B2B_SEWING_PERCENT` → silent skip;
   - `Order.routeSteps` без `category=SEWING` или все швейные
     операции `SALARY_ONLY` / без ставок → `base = 0`, silent skip.
2. **OperationEntry есть в `PENDING_RELEASE`** → expected: ждём
   `PackingService.close`. На пробном паспорте, который не упакован
   и/или коробка не закрыта, это нормальное поведение. Видно только
   менеджеру в `/admin/payroll` (`pieceworkPendingRub`); работнику
   на `/earnings` — нет.
3. **OperationEntry `APPROVED` есть, но в payroll не видно** →
   фильтр `PayrollService` (период, role, divisionCode, employeeId)
   или `period=APPROVED` query на `/admin/payroll`. Также возможен
   case с `Order.companyDivisionId = NULL` в ведомости с фильтром
   по подразделению.
4. **OperationEntry создана не тому employeeId** → cutter-
   attribution: `creator.role` не CUTTER и `dto.cutterId` пришёл
   неверным; либо seed-учётка `cutter` поломалась. Сверяем
   `OperationEntry.employeeId` с `Passport.cutterId`.
5. **OperationEntry amount = 0** → B2B percent / base zero, либо
   ставка операции = 0. По правилам §4 нулевое начисление
   намеренно не создаётся; в БД его не будет.

## 14. Recommended next action

> **Без правок кода** — этот recon ничего не правит. Ниже —
> кандидаты на следующую задачу:

- Снять `PASSPORT_ID` пробного паспорта, прогнать §9 + §9.10,
  заполнить §10 — это однозначно классифицирует находку (§11) и
  отвечает на вопрос «починить ли `PassportsService.create` или это
  rate/setup».
- Если §9.10 показал `CUTTER_B2B_PERCENT_MISSING` — задать
  `Employee.cutterB2bSewingPercent` (для конкретного раскройщика)
  или ENV `CUTTER_B2B_SEWING_PERCENT` (на инстансе). Это setup,
  не код.
- Если §9.10 показал `CUTTER_B2B_AMOUNT_ZERO` — пройтись по
  `OrderRouteStep[]` заказа и `Operation.pricingMode/fixedRate/
  OperationRateBySize`. Это либо отсутствующий маршрут, либо
  ставки. Тоже setup.
- Если §10 показал `EXPECTED_PENDING` — обсудить с product owner,
  должен ли UI `/earnings` (не-менеджер) показывать
  `PENDING_RELEASE` отдельной колонкой, чтобы швея видела
  «ожидает упаковки».
- Если §10 показал `PAYROLL_FILTER_BUG` — фикс в
  `PayrollService.period` (вероятно, по `divisionCode`+null
  правилу).
- Если §10 показал `SERVICE_BUG` — отдельная задача на
  `PassportsService.create` / `EarningsService.
  createImmediateForCutter`. На текущий момент изолированный
  тест зелёный, поэтому регрессия должна быть в seed/configuration.

Менять что-либо без §10 преждевременно: backend имеет ровно одну
функцию создания cutter-сдельщины, и она проверяется
интеграционным тестом.

## 15. No changes made

В рамках RECON production-code, tests, Prisma schema и UI **не
изменялись**. Создан только этот документ
(`docs/passport-piecework-payroll-recon.md`).
