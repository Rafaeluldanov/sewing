# Test production payroll flow — seed scenario

> Воспроизводимый «boxed» сценарий: создаёт префиксированный заказ +
> паспорт в **тестовой** БД, прогоняет его через CUT → SEW → QC →
> WTO/IRONING → PACKING тем же production HTTP-flow, что и
> [`tests/integration/production-flow.test.ts`](../tests/integration/production-flow.test.ts),
> и печатает stdout-report по сдельщине + окладу. Цель — увидеть,
> где появляется и где теряется `OperationEntry` (RECON
> [`docs/passport-piecework-payroll-recon.md`](./passport-piecework-payroll-recon.md)).
>
> Сценарий не меняет production-code, prisma schema и UI. Чистит
> только свои префиксированные записи.

## 1. Зачем

После RECON [`docs/passport-piecework-payroll-recon.md`](./passport-piecework-payroll-recon.md)
осталась нужда в воспроизводимом «end-to-end» сценарии, который:

- создаёт минимальный, но реалистичный заказ + паспорт,
- прогоняет его через все pipeline-роли (CUTTER, SEAMSTRESS, QC,
  IRONING, PACKING),
- даёт понять, в какой именно точке появляется/теряется сдельщина,
- проверяет, что окладные `SalaryEntry` создаются ровно для тех
  ролей, у которых `compensationType ∈ {SALARY, MIXED}`,
- сводит ответ в одну управленческую сводку (`PayrollService.period`).

Сценарий — это **integration test** на vitest
([`tests/integration/production-payroll-scenario.integration.test.ts`](../tests/integration/production-payroll-scenario.integration.test.ts)),
но **opt-in**: при обычном `npm run test:integration` он
`describe.skip`-ается, чтобы не плодить тестовые заказы.

## 2. Как запустить

### Prerequisite: схема тестовой БД должна быть актуальной

Сценарий поднимает реальный AppModule. На старте Nest зовёт
`ReferenceDataBootstrapService.onApplicationBootstrap`, который
обращается к колонкам Prisma-схемы (например,
`Operation.producesFinishedGoods`). Если ваша `sewing_test` отстаёт
по миграциям, сценарий упадёт с `P2022 The column ... does not exist
in the current database`.

Перед запуском убедитесь, что схема `sewing_test` совпадает с
`prisma/schema.prisma`. Простейший способ для **локальной**
тестовой БД (НЕ для прода):

```bash
DATABASE_URL="postgresql://anastasiatkaceva@localhost:5432/sewing_test?schema=public" \
npx prisma migrate reset --schema=prisma/schema.prisma --force --skip-seed
```

Это destructive только для `sewing_test`. После этого можно
запускать сценарий — он сам идемпотентно вызовет `seedMinimal` для
reference-data.

### Сам запуск

Требуется только тестовая PostgreSQL, на которую указывает
`TEST_DATABASE_URL`. Если у вас в окружении уже выставлен
`DATABASE_URL` (например, на ту же `sewing_test`), сценарий
сознательно откажется работать с эквивалентным URL — это защита
от «забыл переключить env с прода». Передайте `DATABASE_URL=""` явно:

```bash
DATABASE_URL="" \
TEST_DATABASE_URL="postgresql://anastasiatkaceva@localhost:5432/sewing_test?schema=public" \
RUN_PAYROLL_SCENARIO=1 \
npm run test:payroll-scenario
```

Эквивалентный alias из root `package.json`:

```bash
TEST_DATABASE_URL="postgresql://anastasiatkaceva@localhost:5432/sewing_test?schema=public" \
RUN_PAYROLL_SCENARIO=1 \
npm run seed:test-production-payroll-flow
```

Из workspace `tests` напрямую:

```bash
TEST_DATABASE_URL=... \
RUN_PAYROLL_SCENARIO=1 \
npm run test:payroll-scenario --workspace=tests
```

> На Windows-cmd установка переменных другая:
> `set RUN_PAYROLL_SCENARIO=1 && npm run ...` (PowerShell:
> `$env:RUN_PAYROLL_SCENARIO=1; npm run ...`).

### Опции (все через env)

| Env | Эффект |
| --- | --- |
| `RUN_PAYROLL_SCENARIO=1` | Включает сценарий. Без него тест `describe.skip`. |
| `PAYROLL_SCENARIO_KEEP=1` | Не удалять записи после прогона. На stdout печатается имя prefix-а для ручной чистки позже. |
| `PAYROLL_SCENARIO_CLEANUP_PREFIX=<prefix>` | Cleanup-only-режим: удалить записи только с этим prefix-ом и выйти. Сам сценарий не запускается. Не требует `RUN_PAYROLL_SCENARIO=1`. |

## 3. Safety-гарды (`assertSafeTestDatabaseUrl`)

Сценарий **не запустится**, если выполняется хотя бы одно из:

1. `TEST_DATABASE_URL` не задан;
2. `TEST_DATABASE_URL` совпадает с _оригинальным_ `DATABASE_URL`
   процесса (snapshot `__ORIG_DATABASE_URL__` снимается на самом
   верху `production-payroll-scenario.integration.test.ts` ДО
   side-effect импортов; сценарий сознательно НЕ импортирует
   [`tests/utils/db.ts`](../tests/utils/db.ts), который мутирует
   `DATABASE_URL` при загрузке);
3. URL содержит токены `prod` / `production` / `teeon_prod`
   (case-insensitive);
4. Имя БД (часть после последнего `/`) не содержит `sewing_test` /
   `sewing_ci` / `test`.

> Если у вас локально `DATABASE_URL = TEST_DATABASE_URL = sewing_test`,
> запустите с `DATABASE_URL=""`, как в §2. Это намеренная защита
> «отдельный явный TEST_DATABASE_URL вместо общего».

Любая проверка падает — `throw` с понятным сообщением до начала
любых записей.

Сценарий **никогда** не делает `TRUNCATE` всей базы (в отличие от
обычных integration-тестов через
[`tests/utils/db.ts::resetDatabase`](../tests/utils/db.ts)), поэтому
параллельно с ним по той же тестовой БД могут работать чужие данные —
будут затронуты только префиксированные сущности.

## 4. Что создаёт сценарий

Точкой старта берутся **уже существующие** reference-данные из
[`tests/utils/seed.ts::seedMinimal`](../tests/utils/seed.ts) (вызов
идемпотентный):

- `Size` `S/M/L`,
- `Operation` `CUT_DIVISION`/`CUT_CUT`/`SEW_OVERLOCK_1/2`/`QC`/`IRONING`/`PACKING`,
- `Equipment` `cutting-table-01`/`overlock-01`/`qc-station-01`/`ironing-station-01`/`packing-station-01`,
- `Cell` `A1`/`A2`,
- `CompanyDivision` `MARKETPLACE` / `OTHER`,
- `DefectType` `STAIN`.

Поверх этого создаются **префиксированные** сущности с уникальным
prefix-ом `payroll-flow-test-<ISO-timestamp>`:

| Сущность | Поле | Значение |
| --- | --- | --- |
| `Product` | `name` | `${prefix} Test Tee` |
| `Employee` | `login` | `${prefix}-manager` (SHOP_MANAGER, SALARY 1500 ₽/смена) |
| `Employee` | `login` | `${prefix}-cutter` (CUTTER, **PIECEWORK**) |
| `Employee` | `login` | `${prefix}-seamstress` (SEAMSTRESS, **MIXED**, 1000 ₽/смена) |
| `Employee` | `login` | `${prefix}-qc` (QC, SALARY, 900 ₽/смена) |
| `Employee` | `login` | `${prefix}-ironing` (IRONING, SALARY, 900 ₽/смена) |
| `Employee` | `login` | `${prefix}-packer` (PACKING, SALARY, 900 ₽/смена) |
| `Order` | — | `companyDivisionId = MARKETPLACE` (для `MARKETPLACE_FIXED`-схемы cutter-attribution, см. ниже §6) |
| `Passport` | — | `qtyCut = 3`, размер `M`, `cutterId = ${prefix}-cutter` |
| `Box` | — | создаётся упаковщиком в шаге PACKING |

Equipment, cells и операции не дублируются — они общие на всю
тестовую БД и разделяются между разными prefix-ами.

## 5. Какие операции / ставки используются

Никакие новые операции/ставки сценарий не создаёт. Использует
ровно то, что положил `seedMinimal`:

| Operation code | Category | pricingMode | Ставка | Используется для |
| --- | --- | --- | --- | --- |
| `CUT_CUT` | CUTTING | `FIXED` | `fixedRate = 10` | Immediate cutter earning через `MARKETPLACE_FIXED` |
| `CUT_DIVISION` | CUTTING | `SALARY_ONLY` | — | `Passport.currentOperationId` сразу после create; не платит сдельщину |
| `SEW_OVERLOCK_1` | SEWING | `BY_SIZE` | `OperationRateBySize(M)=10` | `OPERATION_TRANSITION` для seamstress |
| `QC` | QC | `SALARY_ONLY` | — | Не платит сдельщину; QC role на окладе |
| `IRONING` | IRONING | `SALARY_ONLY` | — | То же |
| `PACKING` | PACKING | `SALARY_ONLY` | — | То же |

`MARKETPLACE`-привязка заказа — критичная: с `null` или `OTHER`
заказы идут в `B2B_SEWING_PERCENT`-схему, где cutter-immediate-entry
silent-skip-нется (нет `cutterB2bSewingPercent` и нет ENV
`CUTTER_B2B_SEWING_PERCENT`). См. RECON
[`docs/passport-piecework-payroll-recon.md §4`](./passport-piecework-payroll-recon.md).

## 6. Что прогоняет сценарий (production HTTP)

Шаги один-в-один как в
[`tests/integration/production-flow.test.ts §E+F`](../tests/integration/production-flow.test.ts):

1. `POST /api/orders` (manager-cookie) с `companyDivisionId =
   MARKETPLACE` → `POST /api/orders/:id/start`.
2. `POST /api/passports` (manager-cookie, `cutterId =
   ${prefix}-cutter`) → backend атомарно создаёт
   `OperationEntry(PASSPORT_CREATED, APPROVED, IMMEDIATE)` для
   cutter-а. Сценарий снимает snapshot **до любого scan-а** и
   фиксирует invariant `cutterEntryCreatedBeforeAnyScan`.
3. `POST /api/passports/:id/place` в seed-cell `A1`.
4. Seamstress (`MIXED`) — `start shift` (`overlock-01`,
   `SEW_OVERLOCK_1`) → `issue` → `scan` → `stop`. На scan
   `previousOperationId = CUT_DIVISION` (`SALARY_ONLY` → silent
   skip), `previousEmployeeId = seamstress`, `currentOperation`
   меняется на `SEW_OVERLOCK_1`.
5. QC — `start shift` (`qc-station-01`, `QC`) → `scan` (на этом
   шаге backend создаёт `OperationEntry(OPERATION_TRANSITION,
   PENDING_RELEASE)` для seamstress по `SEW_OVERLOCK_1`) →
   `complete` (`QC_PASSED`) → `stop`.
6. IRONING — `start shift` → `scan` (gate `QC_PASSED` пройден) →
   `complete` (`WTO_PASSED`) → `stop`.
7. PACKER — `start shift` (`packing-station-01`, `PACKING`) →
   `POST /api/packing/boxes` → `POST .../add-passport`.
   - До `close` сценарий снимает snapshot и фиксирует invariant
     `sewingEntryPendingBeforeClose` (sewing-entry должна быть
     `PENDING_RELEASE`, `approvedAt = null`).
   - `POST /api/packing/boxes/:id/close` →
     `EarningsService.approvePendingForPassport` промоутит все
     `PENDING_RELEASE` → `APPROVED, approvedAt = now()`.
   - Снимок «после close» фиксирует invariant
     `sewingEntryApprovedAfterClose`.
8. `GET /api/payroll/period?dateFrom=...&dateTo=...&pageSize=100`
   (manager-cookie) — те же агрегаты, что видит UI
   `/admin/payroll`. Сценарий фильтрует строки только по своим
   `employeeId`-ам и сводит summary.

Сценарий **не использует** `completeOperationByEmployee` для
seamstress. Причина — RECON
[`docs/passport-piecework-payroll-recon.md §5`](./passport-piecework-payroll-recon.md):
после complete `currentEmployeeId = null`, и следующий scan не
сможет создать `OPERATION_TRANSITION` (silent skip по
`previousEmployeeId == null`).

## 7. Как читать report

После прогона печатается один блок stdout, например:

```
======================================================================
PAYROLL FLOW TEST SCENARIO — REPORT
======================================================================
testPrefix:       payroll-flow-test-2026-05-07T12-34-56-789Z
TEST_DATABASE_URL: <redacted>
db name:          sewing_test

CREATED ENTITIES
  product:   <id>  (name="payroll-flow-test-... Test Tee")
  order:     <id>  number=O-... division=MARKETPLACE
  passport:  <id>  number=P-... status=PACKED qtyCut=3 qtyGood=3
  box:       <id>  number=B-... closedAt=2026-05-07T12:35:01.123Z

EMPLOYEES (prefixed)
  manager     <id>  login=...-manager      role=SHOP_MANAGER comp=SALARY    salaryPerShift=1500
  cutter      <id>  login=...-cutter       role=CUTTER       comp=PIECEWORK
  seamstress  <id>  login=...-seamstress   role=SEAMSTRESS   comp=MIXED     salaryPerShift=1000
  qc          <id>  login=...-qc           role=QC           comp=SALARY    salaryPerShift=900
  ironing     <id>  login=...-ironing      role=IRONING      comp=SALARY    salaryPerShift=900
  packer      <id>  login=...-packer       role=PACKING      comp=SALARY    salaryPerShift=900

OPERATIONS (existing seed-reference, not created)
  CUT_CUT          <id>  FIXED fixedRate=10
  SEW_OVERLOCK_1   <id>  BY_SIZE rate(M)=10
  QC               <id>  SALARY_ONLY
  IRONING          <id>  SALARY_ONLY
  PACKING          <id>  SALARY_ONLY

INVARIANTS
  cutterEntryCreatedBeforeAnyScan: true
  sewingEntryPendingBeforeClose:   true
  sewingEntryApprovedAfterClose:   true

OPERATION_ENTRIES (2)
  source                | role         | op                | status          | qty | rate | amount | approvedAt
  PASSPORT_CREATED      | cutter       | CUT_CUT           | APPROVED        |   3 |   10 |     30 | 2026-05-07T12:34:56.789Z
  OPERATION_TRANSITION  | seamstress   | SEW_OVERLOCK_1    | APPROVED        |   3 |   10 |     30 | 2026-05-07T12:35:01.456Z

SALARY_ENTRIES (5)
  role         | source     | date       | amount
  manager      | SHIFT_DAY  | 2026-05-07 | 1500   (если manager делал shift; иначе строки нет)
  seamstress   | SHIFT_DAY  | 2026-05-07 | 1000
  qc           | SHIFT_DAY  | 2026-05-07 | 900
  ironing      | SHIFT_DAY  | 2026-05-07 | 900
  packer       | SHIFT_DAY  | 2026-05-07 | 900

PAYROLL period 2026-05-06..2026-05-08
  role         | piecework_approved | pending | salary | total_approved | total | covered
  cutter       |                 30 |       0 |      0 |             30 |    30 |       0
  seamstress   |                 30 |       0 |   1000 |           1030 |  1030 |       0
  qc           |                  0 |       0 |    900 |            900 |   900 |       0
  ironing      |                  0 |       0 |    900 |            900 |   900 |       0
  packer       |                  0 |       0 |    900 |            900 |   900 |       0

PAYROLL summary
  totalApprovedRub:      3760
  totalPendingRub:       0
  pieceworkRub:          60
  salaryRub:             3700
  totalPayoutCoveredRub: 0

CLASSIFICATION: OK_FULL_FLOW
======================================================================
```

### Семантика классификации

| Метка | Что значит |
| --- | --- |
| `OK_FULL_FLOW` | Все три инварианта прошли + payroll показывает обоих сдельщиков (`cutter`, `seamstress`) с `pieceworkApprovedRub > 0`. |
| `MISSING_CUTTER_PIECEWORK` | По паспорту нет `OperationEntry(PASSPORT_CREATED, CUT_CUT)`. Чаще всего: silent-skip B2B-схемы (нет division `MARKETPLACE`, нет percent), `cutter.compensationType = SALARY` или `CUT_CUT.pricingMode = SALARY_ONLY`. |
| `MISSING_SEWING_PIECEWORK` | По паспорту нет `OperationEntry(OPERATION_TRANSITION, SEW_OVERLOCK_1)`. Возможные причины: seamstress на `SALARY`, `SEW_OVERLOCK_1` без ставки для `M`, отсутствие `OPERATION_SCAN` следующим исполнителем (см. recon §5). |
| `EXPECTED_PENDING_BEFORE_CLOSE` | Sewing-entry застряла в `PENDING_RELEASE` после `close box` — регрессия в `EarningsService.approvePendingForPassport` или в `PackingService.close`. |
| `PAYROLL_FILTER_BUG` | Все entry в БД корректны, но `GET /api/payroll/period` не показывает их по сотруднику — проблема в `PayrollService` (см. recon §7: дата окна, `divisionCode`, role-фильтр). |
| `RATE_SETUP_PROBLEM` | Entry создалась, но `amount = 0` — `Operation.fixedRate = 0` или `OperationRateBySize.rate = 0`. |
| `COMPENSATION_SETUP_PROBLEM` | Sewing entry создана, но не в `PENDING_RELEASE` (например, сразу `APPROVED` через какой-то нестандартный путь). |

## 8. Что значит `PENDING_RELEASE`

Сдельщина пошива (`OPERATION_TRANSITION`) на момент создания живёт в
статусе `PENDING_RELEASE` (см.
[`prisma/schema.prisma::OperationEntry`](../prisma/schema.prisma) и
[`apps/api/src/modules/earnings/earnings.service.ts:723`](../apps/api/src/modules/earnings/earnings.service.ts)).
В `pieceworkApprovedRub` / `accruedPieceworkRub` payroll она **не**
попадает; в `pieceworkPendingRub` — попадает. APPROVED-перевод
выполняется только в `PackingService.close` через
`EarningsService.approvePendingForPassport` (см. RECON
[`§6`](./passport-piecework-payroll-recon.md)).

Поэтому **сделка может быть невидима до закрытия коробки**:
- работнику на `/earnings` (`status = APPROVED`-only) — нет;
- менеджеру на `/admin/payroll` — видна как `pieceworkPendingRub`;
- в этом сценарии видна как invariant
  `sewingEntryPendingBeforeClose=true`.

## 9. Ручной cleanup по prefix

Если запустили с `PAYROLL_SCENARIO_KEEP=1` или сценарий упал
посередине, в БД остались префиксированные записи. Удалить:

```bash
TEST_DATABASE_URL=... \
PAYROLL_SCENARIO_CLEANUP_PREFIX=payroll-flow-test-2026-05-07T12-34-56-789Z \
npm run test:payroll-scenario
```

Сценарий запустится в cleanup-only-режиме: TRUNCATE не делается,
сам пайплайн не выполняется. Удаляются только записи с этим
prefix-ом, в правильном порядке зависимостей:

`PayrollPayoutLine → PayrollPayout → OperationEntry → SalaryEntry →
BoxItem → Box → PassportDefect → PassportEvent → Passport →
ShiftSession → Order (CASCADE для items / route steps / needs) →
Product → AuditLog → Employee`.

## 10. SQL-проверки вручную

После запуска (и до cleanup) можно посмотреть данные напрямую.
Подставить prefix из stdout-report.

```sql
-- паспорт + статус + кому отдали раскрой
SELECT id, number, status, "cutterId", "creatorId",
       "currentOperationId", "currentEmployeeId"
FROM "Passport"
WHERE "productId" IN (
  SELECT id FROM "Product" WHERE name LIKE 'payroll-flow-test-%'
);

-- сдельщина паспорта
SELECT id, "sourceEventType", "employeeId", "operationId",
       status, "approvalMode", qty, "ratePerUnit", amount,
       "approvedAt", "createdAt"
FROM "OperationEntry"
WHERE "passportId" IN (
  SELECT id FROM "Passport" WHERE "productId" IN (
    SELECT id FROM "Product" WHERE name LIKE 'payroll-flow-test-%'
  )
)
ORDER BY "createdAt";

-- окладные за день сценария
SELECT id, "employeeId", source, date, amount, "editedManually"
FROM "SalaryEntry"
WHERE "employeeId" IN (
  SELECT id FROM "Employee" WHERE login LIKE 'payroll-flow-test-%'
)
ORDER BY "employeeId", date;

-- audit-trail cutter-immediate-entry
SELECT event, "entityId", "employeeId", payload, "createdAt"
FROM "AuditLog"
WHERE "entityId" IN (
    SELECT id FROM "Passport" WHERE "productId" IN (
      SELECT id FROM "Product" WHERE name LIKE 'payroll-flow-test-%'
    )
  )
  AND event IN ('CUTTER_EARNING_CREATED',
                'CUTTER_B2B_PERCENT_MISSING',
                'CUTTER_B2B_AMOUNT_ZERO')
ORDER BY "createdAt";
```

## 11. Что не делает сценарий

- Не меняет production-code (`apps/api/src/modules/**`).
- Не меняет `prisma/schema.prisma` и не запускает миграции.
- Не меняет UI и не добавляет endpoint-ы.
- Не делает `TRUNCATE` (в отличие от `tests/utils/db.ts::resetDatabase`).
- Не трогает чужие записи (без `${prefix}-` / `${prefix} `).
- Не работает на production / dev DB — гард `assertSafeTestDatabaseUrl`.
- Не использует `completeOperationByEmployee` для seamstress —
  это сознательно (см. [§5 RECON](./passport-piecework-payroll-recon.md)).

## 12. Связанные документы

- [`docs/passport-piecework-payroll-recon.md`](./passport-piecework-payroll-recon.md)
  — RECON «где теряется сдельщина по паспорту».
- [`docs/production-flow.md`](./production-flow.md) — pipeline
  паспорта и события.
- [`docs/payroll-cutter-compensation-recon.md`](./payroll-cutter-compensation-recon.md)
  — `MARKETPLACE_FIXED` vs `B2B_SEWING_PERCENT` cutter-схема.
- [`tests/integration/production-flow.test.ts`](../tests/integration/production-flow.test.ts)
  — источник истины для порядка шагов flow.
- [`tests/integration/packing-close-idempotent.test.ts`](../tests/integration/packing-close-idempotent.test.ts)
  — инвариант `PENDING_RELEASE → APPROVED` через close box.
