# Integration Full Run RECON

## 1. Summary

| Поле | Значение |
| --- | --- |
| Команда запуска | `npm run test:integration` (resolves to `npm run test:integration --workspace=tests` → `vitest run integration`); конфиг `tests/vitest.config.ts` форсирует sequential — `poolOptions.forks.singleFork = true`, `sequence.concurrent = false` |
| `TEST_DATABASE_URL` | `postgres://…/sewing_test` (см. `tests/utils/db.ts`; конкретный хост/порт из локального `.env`) |
| Test files | 83 (72 passed / **11 failed**) |
| Tests | 934 (880 passed / **54 failed**) |
| Duration | 195.21s |
| Дата запуска | 2026-05-06 |
| Лог | `/tmp/sewing-integration-full.log` |

P0 targeted batch — **зелёный**:
`shifts.test.ts`, `earnings-service.test.ts`, `packing-add-validation.test.ts`,
`packing-close-idempotent.test.ts`, `qc-shift-flow.test.ts`,
`wto-shift-flow.test.ts`, `production-flow.test.ts`,
`equipment-operations.test.ts`. Typecheck / docs / smoke — зелёные.

Профиль 54 падений сводится к ≤ 6 кластерам (см. §2). Production-code в этой
RECON-итерации трогать **не нужно** — выводы по каждому кластеру
сохранены, фиксы планируются отдельной итерацией.

## 2. Failed files inventory

| File | Failed tests | Main symptom | Cluster | Likely cause | Proposed action |
| --- | --- | --- | --- | --- | --- |
| `material-issues-stock.test.ts` | 10 | `expected 201 "Created", got 200 "OK"` на `POST /api/material-issues/:id/post` и `/cancel` | C1: MaterialIssue/Stock 201→200 drift | Контроллер `material-issues.controller.ts:79-86` явно проставляет `@HttpCode(HttpStatus.OK)` для `/post` и `/cancel`. Тесты ждут 201. | Обновить тесты на 200; `docs/api.md §20a` уже без явной 201 для `/post` (упоминание 201 — только для `POST /api/material-issues`). |
| `material-issues-allow-negative-stock.test.ts` | 9 | 7 × `201→200` + 2 × `details undefined` | C1 + C2 | C1 — то же. C2 — `GlobalExceptionFilter` (см. §4) не пробрасывает `details` из `HttpException.getResponse()`. | Обновить ожидание статуса на 200; восстановить `details` в фильтре (см. §4). |
| `material-issues-auto-cut.test.ts` | 1 | повторный `POST /api/passports/:id/issue` → `409` вместо `201` | C7: Auto-cut repeat issue | Идемпотентность `issueToEmployee` действует только на route-WIP-ветке (`passports.service.ts:697-702`). Без route-template вторая выдача попадает в `currentEmployeeId` → `PassportAlreadyIssuedException`. Дубль `MaterialIssue` при этом всё равно не создаётся. | См. §8 — выбрать: либо распространить idempotent no-op на legacy-ветку (production-fix), либо обновить тест на 409 + проверка `count = 1`. |
| `purchase-receipts-stock.test.ts` | 1 | `expected 201 "Created", got 200 "OK"` на `/post` | C1 | то же | Обновить тест на 200. |
| `company-divisions-material-stock-overrides.test.ts` | 1 | `201→200` на `/post` | C1 | то же | Обновить тест на 200. |
| `stock-readonly-api.test.ts` | 4 | `201→200` в helper `postIssue` (вызывает `/post`) | C1 | helper `postIssue` `tests/integration/stock-readonly-api.test.ts:212-216` ждёт 201 от `/post`. | Обновить helper на 200. |
| `printers.test.ts` | 6 | `expected 201 / 409 …, got 500` на `POST /api/print-jobs` | C3: Print 500 cluster | `print-jobs.controller.ts:77` зовёт `resolvePublicApiBaseUrl(req)` (`apps/api/src/modules/printers/public-api-url.ts:31`); функция бросает, если ни `PUBLIC_API_URL`/`API_PUBLIC_URL`/`APP_URL` не выставлен и host = loopback (supertest ставит `127.0.0.1`). 500 «уведомляет» до бизнес-проверок (`SHIFT_SESSION_REQUIRED`/`PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`). | См. §5 — проще выставить `PUBLIC_API_URL` в test setup. |
| `warehouse-print-cells.test.ts` | 10 | `500` на `POST /api/warehouses/:id/print-cells` (включая 404/409 ветки до бизнес-логики) + 1 × `labelSize undefined` | C3 + C4 | C3 — тот же `resolvePublicApiBaseUrl` (`warehouses.controller.ts:119`). C4 (`labelSize undefined`) — отдельная — `dto.labelSize` уходит в ответ через `printAllCells`, и `PrintWarehouseCellsDto` без явного default. | См. §5. После fix C3 пере-проверить C4: проверить `labelSize` default в DTO. |
| `cutter-assistant-shift.test.ts` | 2 | `500` на print-job CUTTER_ASSISTANT (оба про print) | C3 | то же — `resolvePublicApiBaseUrl` бросает на supertest-loopback. | См. §5. |
| `cutter-attribution.test.ts` | 5 | 2 × `attributed === null`; 3 × HTTP-код drift (`404/409` вместо `400`) | C5: Cutter attribution | `CutterNotFoundException` → 404 (`common/errors.ts:337-345`); `CutterInactiveException` → 409 (`common/errors.ts:354-362`). Тесты помнят 400. + `OperationEntry PASSPORT_CREATED` не пишется → helper возвращает null (см. §6). | См. §6 — обновить статус-коды в тестах; для `null`-кейсов проверить `EarningsService.createImmediateForCutter` early-return. |
| `production-cost.test.ts` | 5 | `+1` к `totalCost` во всех 7a/b/c/d/f | C6: Production cost +1 drift | `CostsService` через `passport-durations.service.ts` минимально считает PACKING-стадию = 1 минута и через salary-rate (≥ 0) добавляет 1 ₽ для упаковщика c `salaryPerShift`. | См. §7 — обновить ожидания тестов (учесть `salaryShare` упаковщика) либо вычесть его в setup. |

Cluster keys, использованные ниже:

- **C1** — MaterialIssue/Stock HTTP status drift (201→200)
- **C2** — MATERIAL_STOCK_INSUFFICIENT details drift (details undefined)
- **C3** — Print jobs / warehouse-print 500 (loopback host)
- **C4** — `labelSize` default missing
- **C5** — Cutter attribution (status drift + null entry)
- **C6** — Production cost +1 drift (PACKING-стадия 1 мин)
- **C7** — Auto-cut repeated issueToEmployee → 409

## 3. MaterialIssue / Stock status-code drift (C1)

**Симптом:** во всех затронутых тестах `Error: expected 201 "Created", got 200 "OK"`.

Места падений (тест → строка):

| Test file | Endpoint | Test line | Expected | Actual |
| --- | --- | --- | --- | --- |
| `material-issues-stock.test.ts` | `POST /api/material-issues/:id/post` | 277 | 201 | 200 |
| `material-issues-stock.test.ts` | `POST /api/material-issues/:id/cancel` | 362 | 201 | 200 |
| `material-issues-stock.test.ts` | `POST /api/material-issues/:id/post` (POSTED-cancel блок) | 393 | 201 | 200 |
| `material-issues-stock.test.ts` | `/post` | 450, 531, 570, 604, 643, 688, 824 | 201 | 200 |
| `material-issues-allow-negative-stock.test.ts` | `/post` | 290, 337, 373, 513, 602, 872 | 201 | 200 |
| `purchase-receipts-stock.test.ts` | `/post` | 607 | 201 | 200 |
| `company-divisions-material-stock-overrides.test.ts` | `/post` | 492 | 201 | 200 |
| `stock-readonly-api.test.ts` | `/post` (через helper `postIssue` 212–216) | 302, 329, 440, 472 | 201 | 200 |

**Источник истины (production-code):**
[apps/api/src/modules/material-issues/material-issues.controller.ts:79-94](../apps/api/src/modules/material-issues/material-issues.controller.ts#L79-L94)

```ts
@Post(':id/post')
@HttpCode(HttpStatus.OK)
post(...)

@Post(':id/cancel')
@HttpCode(HttpStatus.OK)
cancel(...)
```

`@HttpCode(200)` явно поставлен — это намеренное поведение: семантически
`/post` и `/cancel` — это state-transition существующего ресурса, а не
создание нового. `POST /api/material-issues` (создание DRAFT-документа)
сохраняет 201 (`material-issues.controller.ts:69-77`).

**Источник истины (docs):**
[docs/api.md](api.md) (строки 622–625) описывает `/post` и `/cancel`
без явного «201», в отличие от `POST /api/material-issues` (где явно
«201 Created»). Это согласуется с контроллером.

**Canonical contract (предложение):**

| Endpoint | Status |
| --- | --- |
| `POST /api/material-issues` | 201 Created |
| `POST /api/material-issues/:id/post` | **200 OK** |
| `POST /api/material-issues/:id/cancel` | **200 OK** |

**Proposed action:** обновить ожидания тестов на 200 OK для всех 7 файлов
(C1 покрывает 26 из 54 падений). Production-code и docs не трогаем.

## 4. MATERIAL_STOCK_INSUFFICIENT details drift (C2)

**Симптом:** `expected undefined to match object {…}` / `Cannot read
properties of undefined (reading 'cellId' / 'availableQty')`.

Места падений:

| Test | Line | Поле, которое отсутствует |
| --- | --- | --- |
| `material-issues-allow-negative-stock.test.ts:416` | `res.body.details` | `workshopNeedId`, `cellId`, `unit` |
| `material-issues-allow-negative-stock.test.ts:468-470` | `res.body.details.cellId`, `availableQty` | `cellId`, `availableQty` |
| `material-issues-allow-negative-stock.test.ts:556` | `res.body.details.availableQty` | `availableQty` |

**Источник истины (производство):**

`MaterialStockInsufficientException` ([apps/api/src/common/errors.ts:2788-2811](../apps/api/src/common/errors.ts#L2788-L2811))
**уже** кладёт `details` в response-body:

```ts
super({
  statusCode: HttpStatus.CONFLICT,
  message,
  code: 'MATERIAL_STOCK_INSUFFICIENT',
  details, // ← { workshopNeedId, warehouseId, cellId, requestedQty, availableQty, unit, description }
}, HttpStatus.CONFLICT);
```

`StockService.applyMovementInTx` и `pickBalanceForLine` бросают
`MaterialStockInsufficientException` с полным `details`
(`apps/api/src/modules/stock/stock.service.ts:361-372, 968-977`).

**Регрессия — `GlobalExceptionFilter`:**
[apps/api/src/common/global-exception.filter.ts:64-77](../apps/api/src/common/global-exception.filter.ts#L64-L77)
читает `getResponse()` и собирает финальный body вручную:

```ts
return {
  statusCode: status,
  code: (obj.code as string) ?? defaultCode(status),
  message: pickMessage(obj.message) ?? defaultMessage(status),
  ...(obj.issues ? { issues: obj.issues } : {}),
};
```

`obj.details` **не пробрасывается**. Это и есть причина — `details`
строится в exception, но фильтр его срезает. Документация (`docs/api.md`
строка 624) же явно перечисляет, какие поля должны быть в `details`:
`{ workshopNeedId, warehouseId, cellId, requestedQty, availableQty, unit,
description }`. UI/диагностика на это поле опираются.

**Нужны ли details:** да — `docs/api.md §20a`, `docs/material-consumption-rollout-checklist.md:220-300+`
явно описывают `details` как контракт API. Это используется UI для
показа конкретной ячейки/недостающего количества.

**Proposed action:**

1. (Предпочтительно — production-fix, но НЕ в этой итерации.) Расширить
   `GlobalExceptionFilter.toResponse()`: пробрасывать `obj.details`,
   когда оно есть. Минимальный diff:
   ```ts
   ...(obj.issues ? { issues: obj.issues } : {}),
   ...(obj.details !== undefined ? { details: obj.details } : {}),
   ```
   Это восстановит контракт для всех `BusinessException`-производных
   (не только MaterialStockInsufficient).
2. Если решено пока не править production — обновить 3 затронутые
   проверки тестов (но это понизит покрытие контракта; см. C2 как
   **production-path regression**, не «outdated test»).

## 5. Printer / warehouse print 500 cluster (C3 + C4)

**Симптом:** `expected 201 / 409 / 404 …, got 500 "Internal Server Error"`
на каждом запросе к `POST /api/print-jobs` и `POST /api/warehouses/:id/print-cells`,
независимо от того, должен ли тест проверить успех или 4xx-ветку.

Затронуто 6 (`printers.test.ts`) + 10 (`warehouse-print-cells.test.ts`)
+ 2 (`cutter-assistant-shift.test.ts`) = **18 падений**.

| Endpoint | Test file | Лог-строки |
| --- | --- | --- |
| `POST /api/print-jobs` | `printers.test.ts:187, 201, 218, 247, 346, 566` | 1553–1671 |
| `POST /api/warehouses/:id/print-cells` | `warehouse-print-cells.test.ts:118, 157, 176, 213, 233, 247, 258, 275, 347` | 1840–1970 |
| `POST /api/print-jobs` (CUTTER_ASSISTANT) | `cutter-assistant-shift.test.ts:160, 182` | 1016, 1035 |

**Источник истины (production):**

[apps/api/src/modules/printers/public-api-url.ts:31-60](../apps/api/src/modules/printers/public-api-url.ts#L31-L60)

```ts
export function resolvePublicApiBaseUrl(req: Request): string {
  const fromEnv = firstNonEmpty(process.env.PUBLIC_API_URL, process.env.API_PUBLIC_URL);
  if (fromEnv) return trimTrailingSlash(fromEnv);
  const appUrl = firstNonEmpty(process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL);
  if (appUrl) return `${trimTrailingSlash(appUrl)}${API_PREFIX}`;
  // host header path …
  if (candidate && !isLoopbackHost(host)) return candidate;
  throw new Error('Не задан публичный адрес API …');
}
```

Используется в:

- [apps/api/src/modules/printers/print-jobs.controller.ts:77](../apps/api/src/modules/printers/print-jobs.controller.ts#L77)
- [apps/api/src/modules/warehouses/warehouses.controller.ts:119](../apps/api/src/modules/warehouses/warehouses.controller.ts#L119)

В тестовом окружении (`tests/setup.ts` ничего не выставляет)
ни `PUBLIC_API_URL`, ни `API_PUBLIC_URL`, ни `APP_URL`, ни
`NEXT_PUBLIC_APP_URL` не выставлены, а supertest шлёт запросы на
loopback (`127.0.0.1`) — `resolvePublicApiBaseUrl` бросает Error,
`GlobalExceptionFilter` маппит в 500 INTERNAL_ERROR. Поэтому 500
возникает РАНЬШЕ бизнес-проверок (`SHIFT_SESSION_REQUIRED`,
`PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`, `WAREHOUSE_NOT_FOUND`,
`PRINTER_INACTIVE` и т.д.) — отсюда и «404/409 → 500» и «201 → 500».

**Это — production-path regression относительно тестов**, потому что
ранее (до loopback-restriction) supertest успешно проходил, и тесты
покрывали бизнес-ветки. Hardening loopback-проверки сделан правильно,
но не сопровождался env-фикстурой для интеграционных тестов.

**C4 — `labelSize undefined`** (`warehouse-print-cells.test.ts:189`):
после fix C3 это всплывёт как отдельное падение. Тест ждёт
`res.body.labelSize === '38x58'`, без передачи поля в запросе. DTO
[`PrintWarehouseCellsDto`](../packages/shared/printers) и сервис
`warehouses.service.ts:430-433` возвращают `labelSize: dto.labelSize`,
без default. Z-схема DTO должна проставлять `'38x58'` по умолчанию;
проверить `packages/shared/src/printers/...` после устранения C3.

**Не чинить пока, только plan:**

- Минимальный fix теста (предпочтительно): в `tests/setup.ts` или в
  `tests/integration/_helpers/app.ts` добавить
  `process.env.PUBLIC_API_URL ??= 'http://localhost/api'`. Этого
  достаточно, чтобы все 18 падений C3 снялись и проявилось C4.
- Альтернатива на стороне продакшна (рискованнее, требует обсуждения):
  расширить `isLoopbackHost`-исключение `process.env.NODE_ENV === 'test'`.
  Тогда supertest пойдёт через host-header и тесты снова станут зелёными
  без изменения env. Это снижает строгость защиты от записи loopback в
  payloadUrl, но только для NODE_ENV=test.

## 6. Cutter attribution cluster (C5)

**Симптом:** 5 падений в `cutter-attribution.test.ts`. Делятся на 2 подкластера:

### 6.1. `immediateCutterEntryEmployee` returns null (2 падения)

| Test | Line | Expected | Received |
| --- | --- | --- | --- |
| `creator-CUTTER без cutterId → начисление creator-у` | `cutter-attribution.test.ts:134` | `seed.employees['cutter'].id` | `null` |
| `SHOP_MANAGER с явным cutterId → начисление выбранному CUTTER` | `cutter-attribution.test.ts:180` | `anotherCutter.id` | `null` |

Helper (`cutter-attribution.test.ts:106-117`) ищет
`OperationEntry.findFirst({ passportId, sourceEventType: 'PASSPORT_CREATED' })`.

`EarningsService.createImmediateForCutter`
([apps/api/src/modules/earnings/earnings.service.ts:121-196](../apps/api/src/modules/earnings/earnings.service.ts#L121-L196))
имеет 4 early-return:

```ts
if (args.qty <= 0) return;
if (!employee || !employee.active) return;
if (!isPieceworkEligible(employee.compensationType)) return;
const op = await tx.operation.findUnique({ where: { code: 'CUT_CUT' } });
if (!op) return;
if (op.pricingMode === 'SALARY_ONLY') return;
```

Затем выбирается схема через `companyDivision.code` —
`MARKETPLACE_FIXED` или B2B. Любая из них пишет
`OperationEntry` с `sourceEventType: EarningSource.PASSPORT_CREATED`
(`earnings.service.ts:231, 365`), но если ни одна не дойдёт (или
`op.fixedRate = 0` / не найдена ставка) — entry не появится.

**Возможные первопричины (требуют seed-инспекции, не правок):**
- `seed.employees['cutter'].compensationType` — НЕ `PIECEWORK` (тогда
  `isPieceworkEligible` возвращает false → return).
- `Operation.code = 'CUT_CUT'` отсутствует в seed (return на `!op`).
- `Order.companyDivision = null` → B2B-схема, но `cutterB2bSewingPercent`
  у сотрудника = 0 → запись `amount = 0` может быть отфильтрована.
- HTTP-коды для других 3 тестов в этом файле сходятся (см. §6.2),
  значит сам endpoint `POST /api/passports` отрабатывает; проблема —
  earnings ветвление.

**Это, скорее, real service / seed regression** — а не «outdated test».
Тест корректно проверяет атрибуцию immediate-начисления; нулевая запись
означает, что после раскроя CUTTER не получил ни одной строки в
`OperationEntry`. На пилоте это означает «cutter не получил ЗП за
выпуск» — это не то поведение, которое фронт показывает.

### 6.2. HTTP-коды для невалидного `cutterId` (3 падения)

| Test | Line | Expected | Received | Production источник |
| --- | --- | --- | --- | --- |
| `cutterId не-CUTTER → 400 CUTTER_NOT_FOUND` | 196 | 400 | **404** | `CutterNotFoundException` `errors.ts:337-345` (`HttpStatus.NOT_FOUND`) |
| `cutterId — несуществующий → 400 CUTTER_NOT_FOUND` | 208 | 400 | **404** | то же |
| `cutterId — деактивированный CUTTER → 400 CUTTER_INACTIVE` | 230 | 400 | **409** | `CutterInactiveException` `errors.ts:354-362` (`HttpStatus.CONFLICT`) |

Production-комментарий (`errors.ts:330-336, 347-353`) явно говорит:
«PHASE 2 STEP 3 делает явный 404» / «отбиваем 409 ещё на input-валидации».
То есть статусы 404 и 409 — **намеренный production-контракт**.

**Proposed action:**

- 6.1 — RECON-only пометка как **real service bug / seed regression**.
  В этой итерации не чиним (см. §10), но в следующей нужно: запустить
  тест локально с `console.log` после `EarningsService.createImmediateForCutter`,
  чтобы понять, какой early-return срабатывает.
- 6.2 — обновить 3 теста: `expect(r.status).toBe(404)` для
  `CUTTER_NOT_FOUND` и `expect(r.status).toBe(409)` для `CUTTER_INACTIVE`.

## 7. Production cost +1 drift (C6)

**Симптом:** во всех 5 тестах 7a/b/c/d/f `totalCost` больше ожидаемого
ровно на `1`.

| Test | Line | Expected `totalCost` | Received |
| --- | --- | --- | --- |
| 7a. POSTED MaterialIssue с passportId | 389 | 1254.56 | 1255.56 |
| 7b. DRAFT MaterialIssue с passportId | 430 | 0 | 1 |
| 7c. CANCELLED MaterialIssue с passportId | 470 | 0 | 1 |
| 7d. POSTED MaterialIssue без passportId | 513 | 0 | 1 |
| 7f. Несколько POSTED MaterialIssue | 666 | 500.5 | 501.5 |

**Источник:** [apps/api/src/modules/costs/costs.service.ts:196-213](../apps/api/src/modules/costs/costs.service.ts#L196-L213)
+ [apps/api/src/modules/costs/passport-durations.service.ts:1-80](../apps/api/src/modules/costs/passport-durations.service.ts#L1-L80)

`CostsService` собирает `salaryShare` за каждый паспорт исходя из
`stagesByPassport`. `PassportDurationsService` (PACKING-стадия)
вычисляет длительность по разрыву между PACKED-событиями; даже когда
тест пишет одну PACKED-событие напрямую через `prisma.passportEvent.create`,
PACKING-стадия фиксируется минимум на 1 минуту (round-up + cap).

`employeeRate` для `seed.employees.packer`, скорее всего, > 0
(`computeMinuteRate(salaryPerShift)`), так что
`salaryShare = 1 минута × 1 ₽/мин = 1 ₽`. Это ровно тот «+1», который
получают все тесты.

**Setup pollution** маловероятен: `production-cost.test.ts` создаёт
свой `Order/Passport/PackedEvent` (`createPlacedPassport`,
`writePacked` — line 852-892, 930+), фильтр идёт по дате периода
(`dateFrom = dateTo = day`), а тесты не пересекаются по дате.

**Proposed action:** обновить ожидания в 5 тестах — учесть
`packer.salaryShare = computeMinuteRate(packer.salaryPerShift)`.
Самый чистый вариант: либо в `writePacked` дополнительно писать
`WTO_PASSED` (тогда длительность считается от WTO_PASSED до PACKED
честно), либо считать ожидаемое `salaryShare` через тот же helper,
что и production. Production-code не трогать.

Альтернатива — поставить `seed.employees.packer.compensationType =
PIECEWORK` или `salaryPerShift = 0`, чтобы `employeeRate` стал 0 и
`salaryShare` вышел нулём; но это меняет shared seed и может сломать
другие тесты.

## 8. Auto-cut repeated issue contract (C7)

**Симптом:** `expected 201 "Created", got 409 "Conflict"`,
`material-issues-auto-cut.test.ts:360`.

**Контекст теста:**
Тест выполняет `POST /api/passports/:id/issue` дважды одним и тем же
сотрудником (швеёй). Ожидание — повтор идемпотентен (201, no-op),
второй `MaterialIssue (AUTO_CUT_ISSUE)` не создаётся.

**Источник истины (production):**
[apps/api/src/modules/passports/passports.service.ts:687-714](../apps/api/src/modules/passports/passports.service.ts#L687-L714)

```ts
// currentCellId === null. Без маршрута — старое поведение …
if (!isRouteWip) {
  if (passport.currentEmployeeId) {
    throw new PassportAlreadyIssuedException();
  }
  …
}

// Route-WIP без ячейки: разрешаем «получить крой» прямо в маршруте.
// Идемпотентность: тот же сотрудник на IN_PROGRESS — no-op.
if (passport.status === IN_PROGRESS && passport.currentEmployeeId === employeeId) {
  return this.getOne(passportId);
}
```

Идемпотентность есть, но **только для route-WIP-ветки**. Тест
готовит паспорт без route-template (или попадает в legacy-ветку с
`currentCellId` сразу после места). После первого `issue`:
`currentCellId = null`, `currentEmployeeId = seamstress`. Второй вызов
повторяет → попадает в проверку `if (passport.currentEmployeeId)` →
`PassportAlreadyIssuedException` (409).

**Дубль `MaterialIssue` НЕ создаётся** (и тест не может это проверить
т.к. падает раньше) — UNIQUE `MaterialIssue.sourceKey =
AUTO_CUT_ISSUE:<passportId>` гарантирует одну запись на паспорт
(`material-issues.service.ts` шапка + `prisma/schema.prisma`).

**Контракт-выбор:**

Вариант A (production-fix, разумнее, но НЕ в этой итерации): расширить
idempotent-no-op на легаси-ветку: `if (passport.status === IN_PROGRESS
&& passport.currentEmployeeId === employeeId) return this.getOne(...)`
ДО проверки `currentCellId === null`. Тогда retry того же сотрудника
снова возвращает 201 с актуальным DTO. Это согласуется со scan
(ADR-0003 §6) и с комментарием в коде.

Вариант B (test-only): обновить тест на 409 + проверка что
`MaterialIssue.count = 1`. Этого достаточно для верификации «дубль
не создаётся».

`409 + no duplicate` приемлемо, если согласовано как контракт; но
комментарий в production-коде явно говорит про idempotent no-op,
поэтому А — правильный fix.

## 9. Prioritized fix plan

Порядок (низкий риск → высокий, по влиянию):

1. **C1 — MaterialIssue/Stock 201→200 drift.** Чисто tests-only:
   обновить `expect(201)` → `expect(200)` в 7 файлах (≈ 26 падений).
   Production-code и docs — не трогать.

2. **C2 — MATERIAL_STOCK_INSUFFICIENT details.** Production-fix в
   `GlobalExceptionFilter.toResponse()` — пробросить `details` (1 строка).
   Покрытие восстанавливается для всех `BusinessException` с `details`,
   не только MaterialStock. Чинит 3 падения; критично для UI/diagnostics.

3. **C3 — Print 500.** Test-env fix: добавить
   `process.env.PUBLIC_API_URL ??= 'http://localhost/api'` в
   `tests/setup.ts`. Чинит 18 падений (включая 2 в
   `cutter-assistant-shift.test.ts`). После этого пере-проверить C4.

4. **C4 — `labelSize` default.** Если всплывает после C3 — добавить
   default `'38x58'` в Zod-схеме `PrintWarehouseCellsDto` (1 файл в
   `packages/shared`).

5. **C5 — Cutter attribution.** Разделить:
   - 5.2 (HTTP-коды) — tests-only: обновить 400 → 404/409 в 3 тестах.
   - 5.1 (`null` entry) — `RECON.next-iteration` — нужна локальная
     инструментовка `EarningsService.createImmediateForCutter` чтобы
     понять, какой early-return бьёт. Не чинить вслепую.

6. **C6 — Production cost +1.** Tests-only: переписать ожидания 5
   тестов с учётом `packer.salaryShare`. Альтернатива — добавить в
   `writePacked` парный `WTO_PASSED` чтобы стадия PACKING получила
   честную длительность.

7. **C7 — Auto-cut repeat issue.** Предпочтительно — production-fix
   (вариант A в §8): распространить idempotent-no-op на legacy-ветку.
   Если не в эту итерацию — обновить тест (вариант B).

8. После всех фиксов — повторный full sequential `npm run test:integration`,
   ожидание: `0 failed`.

## 10. Do not touch

- P0 targeted batch — `shifts.test.ts`, `earnings-service.test.ts`,
  `packing-add-validation.test.ts`, `packing-close-idempotent.test.ts`,
  `qc-shift-flow.test.ts`, `wto-shift-flow.test.ts`,
  `production-flow.test.ts`, `equipment-operations.test.ts` — все
  зелёные, в этой RECON-итерации не нужно.
- QC/WTO idempotency fix (см. недавний коммит `06ebac8 fix(qc-wto):
  make completion idempotent`).
- Shifts allow-list fix (`089beb9 fix(shifts): enforce equipment
  operation allow-list`).
- Salary/payroll зелёные тесты.
- Production-code в `material-issues.controller.ts`, `costs.service.ts`,
  `passport-durations.service.ts`, `errors.ts` (cutter-exceptions),
  `public-api-url.ts` — в RECON-итерации только описаны как «источник
  истины», не правятся.

## Verification

- `npm run docs:check` после сохранения этого файла.
- При фиксах будущих итераций — повторно запустить full integration
  (`npm run test:integration`) и сверить с этим документом.
