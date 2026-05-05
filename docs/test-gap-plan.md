# Test Gap Plan

Дата: 2026-05-04. Точечный план тестов для SEWING. Документ подготовлен
после coverage-анализа (см. `docs/operations-test-recon.md`). В этой
итерации **только документ** — production-код не меняется, новые тесты не
добавляются.

Базовая статистика репо: 79 integration · 111 smoke · 6 unit · 196 файлов
всего. По модулям: ~89% имеют хотя бы один тест, golden path
production-flow покрыт двумя файлами. Слабые места — валидация веток,
race-conditions, инварианты идемпотентности.

---

## 1. Existing coverage to avoid duplication

Эти тесты **уже существуют** и не должны воспроизводиться. Любой gap
из §2/§3, который пересекается с этим списком, должен либо расширять
существующий файл, либо явно пояснять, чем отличается сценарий.

### 1.1 Production flow (golden path)

- `tests/integration/production-flow.test.ts` (1270 строк) — полный
  MVP 1.1: order → passport → shift → issue → scan → complete → QC →
  WTO → packing → close box; покрывает earnings и snapshot
  immutability.
- `tests/integration/e2e-production-flow.test.ts` (530 строк) — golden
  path с `currentRouteStepIndex` и `AuditLog` по каждому событию.
- `tests/integration/pilot-flow.test.ts` — пилотный сценарий.
- `tests/integration/production-routes.test.ts` — `OrderRouteStep`
  snapshot и обход.

### 1.2 Operations (CRUD + plan)

- `tests/integration/operations.test.ts` — CRUD, FIXED/BY_SIZE/
  SALARY_ONLY, уникальность `code`, RBAC.
- `tests/integration/operation-time-norms.test.ts` — timeNorm CRUD,
  mode switch, `resolveTimeNormSec`.
- `tests/integration/operation-salary-plan.test.ts` — планируемая
  стоимость SALARY_ONLY, missing-rate, staleness.
- `tests/integration/order-operation-plan.test.ts` — план заказа.

### 1.3 Cutter / Cutting closure

- `tests/integration/cutter-attribution.test.ts` — атрибуция cutter
  (PHASE 2 STEP 3): creator=CUTTER auto, иначе обязателен `cutterId`.
- `tests/integration/cutter-compensation.test.ts` — B2B/MARKETPLACE
  формула, BY_SIZE rate, missing-rate, идемпотентность.
- `tests/integration/cutter-assistant-shift.test.ts` — shift на cutting-
  table, `SHIFT_SESSION_REQUIRED` для печати, `/shifts/meta`.
- `tests/integration/cutting-closure.test.ts` — closure request
  lifecycle, partial unique, RBAC, planFact.

### 1.4 Material issues / stock / purchasing

- `tests/integration/material-issues.test.ts`
- `tests/integration/material-issues-allow-negative-stock.test.ts`
- `tests/integration/material-issues-auto-cut.test.ts`
- `tests/integration/material-issues-auto-cut-setting.test.ts`
- `tests/integration/material-issues-stock.test.ts`
- `tests/integration/stock.service.test.ts`
- `tests/integration/stock-adjustments.test.ts`
- `tests/integration/stock-readonly-api.test.ts`
- `tests/integration/purchase-receipts-stock.test.ts`
- `tests/integration/purchase-orders.test.ts`

### 1.5 Master / shift gates / RBAC

- `tests/integration/master-calls.test.ts` — OPEN-create, idempotency,
  list, resolve by QR, RBAC, AuditLog.
- `tests/integration/master-actions.test.ts` — unassign / transfer /
  return-to-cell / set-route-step (включая backward → 400, PACKED/
  CANCELLED → 409, reason обязателен, SEAMSTRESS → 403).
- `tests/integration/qc-shift-flow.test.ts` — QC shift-gate, QC_PASSED
  без смены статуса, `/shifts/meta` allow-list.
- `tests/integration/wto-shift-flow.test.ts` — WTO shift-gate, базовый
  `WTO_PASSED`, `/shifts/meta`.
- `tests/integration/role-rbac.test.ts` — RBAC по qc/wto/packing/
  orders/defect-types.
- `tests/integration/earnings-rbac.test.ts` — earnings endpoints RBAC.

### 1.6 Salary / Payroll

- `tests/integration/salary.test.ts` — daily entry per compensationType,
  manual override + auto-sync (двойное покрытие), AuditLog
  `SALARY_ENTRY_UPDATED/RESET`, RBAC.
- `tests/integration/payroll-period.test.ts` / `payroll-daily.test.ts` /
  `payroll-debts.test.ts` / `payroll-employee-detail.test.ts` /
  `payroll-period-net-to-pay.test.ts` — read-only агрегаторы.
- `tests/integration/payroll-payouts.test.ts` /
  `payroll-payouts-lock.test.ts` /
  `payroll-accrual-documents.test.ts` — выплаты/локи.

### 1.7 Прочее покрытие, к которому не возвращаемся

- `tests/integration/db-invariants.test.ts` — partial-unique shifts,
  unique BoxItem, CellContent.
- `tests/integration/equipment-operations.test.ts` — equipment↔operation
  binding и `/shifts/meta` allow-list.
- `tests/integration/me-employee-qr.test.ts` — собственный QR.
- `tests/integration/passports-complete-operation.test.ts` —
  `complete-operation`: правильный `operationId`, запрет отката,
  идемпотентность на той же операции.
- `tests/integration/current-work.test.ts` — `GET /api/shifts/current-
  work`.

---

## 2. P0 tests to add

P0 = блокирующие риски: либо полностью отсутствует dedicated тест на
крупный сервис, либо инвариант не зафиксирован, и регрессия не будет
поймана. Семь файлов.

| # | Gap | New / extend | Why | Expected assertions |
|---|-----|--------------|-----|---------------------|
| P0-1 ✅ | `PackingService.addPassport` — нет dedicated валидационного теста; покрытие только через golden path. | **DONE** `tests/integration/packing-add-validation.test.ts` (11 тестов). | `addPassport` имеет пять причин 409 (homogeneity product/size/color, capacity `maxQty`, `qtyGood=0`, статус `!= IN_PROGRESS`, закрытый короб) — в golden path не проверяются и регрессии не ловятся. | covered: (1) happy-path с подсчётом `PassportEvent(PACKED)` и `AuditLog(PASSPORT_PACKED)` — production-flow.test.ts этих счётчиков не проверяет; (2) status `CREATED`/`PACKED`/`CANCELLED` → 409 `PASSPORT_NOT_PACKABLE` / `PASSPORT_ALREADY_PACKED` / `PASSPORT_CANCELLED`; (3) `qtyGood=0` → 409 `PASSPORT_NOT_PACKABLE`; (4) закрытый короб → 409 `BOX_CLOSED`; (5) homogeneity по product / size / color — три отдельных теста, все 409 `BOX_HOMOGENEITY_VIOLATED`; (6) capacity (qtyGood > remaining) → **422** `BOX_CAPACITY_EXCEEDED` (не 409); (7) повторный add того же passport → 409 `PASSPORT_ALREADY_PACKED`, `BoxItem`/PACKED event/audit count = 1; helper `expectNoSideEffects` пинит снимок `(boxItemCount, totalQty, status, currentEmployeeId, currentCellId, packedEventCount, auditPackedCount)` на каждом негативном кейсе. |
| P0-2 ⚠️ partial | `PackingService.close` — нет проверки идемпотентности и эффекта на `OperationEntry`. | **PARTIAL** — добавлен targeted `tests/integration/packing-close-idempotent.test.ts` (5 тестов) на missing assertions; основная часть уже covered в `production-flow.test.ts §F` (line 1107-1180), `e2e-production-flow.test.ts` (BOX_CLOSED audit ≥1) и `earnings-service.test.ts §5..§7` (service-level). | Двойной клик «закрыть короб» в UI не должен дублировать перевод `OperationEntry` в `APPROVED` и не должен писать второй `BOX_CLOSED` в AuditLog. Без теста — потенциальное двойное начисление. | **Coverage matrix через `/api/packing/boxes/:id/close`:** `closedAt` filled, PENDING_RELEASE→APPROVED, count stable, close x2 → 409 — production-flow §F; service-level approve idempotency (timestamp stable, terminal preserved) — earnings-service §6/§7. **Gaps пиннуем targeted-тестом:** (1) AuditLog `BOX_CLOSED` count = ровно 1 после close × 2 (production-flow только status/count, не audit count); (2) `approvedAt` timestamp **value** preserved через endpoint при close × 2 (production-flow проверяет только `!== null`); (3) close box с mixed `OperationEntry` — `CANCELLED`/`REVERSED`/уже `APPROVED` сохраняются, только `PENDING_RELEASE` промотирован — через endpoint, не через service; (4) empty box `closedAt=null`, `totalQty=0` → 409 `BOX_EMPTY`, без сайд-эффектов; (5) closed box не пишет audit на повторный close (count=1 invariant + закреплено). |
| P0-3 ✅ | `ShiftsService` — нет dedicated integration теста; покрытие косвенное через 18 других тестов. | **DONE** `tests/integration/shifts.test.ts` (14 тестов). Allow-list enforcement реализован в `ShiftsService.start` — finding закрыт, см. `docs/operations-test-findings.md §Resolved`. | `start/stop`, partial-unique constraint (одна активная смена на сотрудника), вызов `SalaryService.syncDailySalary`, `/shifts/meta` allow-list — все проверяются мимоходом, без негативных кейсов. | covered: (1) повторный `start` → 409 `SHIFT_ALREADY_ACTIVE`; (2) **strict regression** `start` с operation вне `Equipment.allowedOperations` → 409 `SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT`, ShiftSession не создаётся; (2a) то же при `EquipmentOperation.isActive=false` (soft-delete биндинга); (3) `stop` без активной → 409 `SHIFT_NOT_ACTIVE`; (4) salary trigger — оставлен в `salary.test.ts §1..§4`, не дублируется; (5) `getCurrent` без/со сменой; (6) `getCurrentWork` фильтр по `PassportStatus != IN_PROGRESS` (PACKED-кейс); (7) bad equipmentId → 404, bad operationId → 404, inactive equipment/operation → 409; (8) 401 без cookie на все 5 эндпоинтов. |
| P0-4 ✅ | `EarningsService` — нет direct теста; покрыт только через cutter-attribution / cutter-compensation / production-flow. | **DONE** `tests/integration/earnings-service.test.ts` (9 тестов). | Единственное место записи `OperationEntry`. Single-write под race-condition не проверен; `ApprovalMode.IMMEDIATE` vs `AFTER_RELEASE` не разграничен в тесте; `approvePendingForPassport` через `close` короба покрыт мельком. | covered: (1) `createImmediateForCutter` контракт DTO (PASSPORT_CREATED/IMMEDIATE/APPROVED/approvedAt!=null) — идемпотентность остаётся в `cutter-compensation.test.ts`; (2) `createPendingForPreviousOperation` контракт DTO (OPERATION_TRANSITION/AFTER_RELEASE/PENDING_RELEASE/approvedAt=null); (3) повторный `createPendingForPreviousOperation` → 1 строка (composite-key); (4) **RACE**: `Promise.allSettled([fire×5])` — все fulfilled, count=1, без 500; (5) `approvePendingForPassport` PENDING/PENDING_RELEASE → APPROVED, возвращает count; (6) идемпотентность: второй вызов count=0, `approvedAt` стабилен; (7) CANCELLED/REVERSED/уже APPROVED не затронуты; (8) IMMEDIATE + AFTER_RELEASE сосуществуют для одного паспорта; (9) groupBy invariant `(passport, op, emp, source)` count=1 после mixed sequential+parallel. |
| P0-5 ✅ | QC — нет идемпотентности `completeQc × 2` и негативного `recordDefect` (`qty > qtyGood`). | **DONE** `tests/integration/qc-shift-flow.test.ts` (3 → 6 тестов). Идемпотентность реализована в `QcService.completeQc` (row-level check внутри `$transaction`); finding закрыт — см. `docs/operations-test-findings.md §Resolved`. | Существующий файл уже устаканился на shift-gate; добавить туда же два кейса логически близко и не плодит новый файл. | covered: (1) `completeQc × 2` идемпотентен — count=1 для `QC_PASSED` event и `QC_COMPLETED` audit, `qcCompletedAt` стабилен между вызовами; (2) `recordDefect` happy path — `qtyGood=8/qtyDefect=2/sum≤qtyCut`, один `PassportDefect` + один `DEFECT_RECORDED` event; (3) `recordDefect` overflow → **422** `DEFECT_EXCEEDS_REMAINING`, snapshot `qtyGood/qtyDefect/defectsCount/defectEventsCount/defectAuditCount` стабилен. |
| P0-6 ✅ | WTO — нет негативного «WTO до QC → 409». | **DONE** `tests/integration/wto-shift-flow.test.ts` (3 → 5 тестов). Идемпотентность реализована в `WtoService.completeWto` симметрично QC; finding закрыт. | Сейчас файл проверяет только shift-gate и happy-path. Гейт `QC_PASSED` — основной инвариант стадии WTO. | covered: (1) `completeWto` без `QC_PASSED` события → 409 `PASSPORT_NOT_QC_PASSED`; passport на IRONING выставлен напрямую через Prisma (scan-in QC-gate-ит на ту же ошибку, изолируем именно WTO-проверку); count `WTO_PASSED` = 0, count `WTO_COMPLETED` audit = 0; passport.status/currentOperationId не изменились; (2) `completeWto × 2` идемпотентен — count=1 для `WTO_PASSED` event и `WTO_COMPLETED` audit, `wtoCompletedAt` стабилен. |
| P0-7 ⚠️ characterization | UI `/orders/[id]/passports/new` для CUTTER_ASSISTANT — регрессия на admin-only `GET /api/employees`. | **DONE** `tests/smoke/orders-passports-new-cutter-assistant.smoke.test.ts` (11 тестов). **Production-баг ВСЁ ЕЩЁ ПРИСУТСТВУЕТ** — smoke написан как characterization-тест, пинит текущую реальность; FINDING’и зафиксированы в `docs/operations-test-findings.md` (severity **high** для page.tsx, medium для бэкенд endpoint и helper). Production-код не менялся. | RECON §6 инвариант 8: CUTTER_ASSISTANT не должен дёргать admin-only endpoint, иначе форма ломается с 403. Это финальный «production hot-spot» из coverage. | covered (текстовый smoke по исходникам, как `route-wip-work-ui.smoke.test.ts`): (1) routes `/orders/[id]/passports/new` и `/work/cut-orders` существуют, второй ходит через `listOrders`, не через `listEmployees`; (2) backend `EmployeesController` остаётся `@Roles('SHOP_MANAGER','ADMIN')` без CA; (3) **FINDING**: `@Get('cutters')` пока не введён; (4) **FINDING**: `lib/employees-api.ts` не содержит `listActiveCutters`; (5) safe-условие `isCutter ? [] : ...` пинится — оно работает для creator-CUTTER; (6) **FINDING**: для CA защиты нет, регулярка ловит наличие `listEmployees({role:'CUTTER'})` без guard'а на `CUTTER_ASSISTANT` или `listActiveCutters`; (7) `EmployeeListItemDto` в shared всё ещё несёт `salaryPerShift/compensationType` — обоснование, почему широкий endpoint нельзя открывать CA; (8) **FINDING**: `ActiveCutterListItemDto` пока не введён; (9) **FINDING**: catch-блока вокруг `listEmployees` нет — 403 для CA пробрасывается как server-side exception; (10) `frontend-rbac.smoke.test.ts` всё ещё ссылается на `CUTTER_ASSISTANT`. После фикса — 5 FINDING-тестов упадут и обновятся вместе с production-фиксом. |

---

## 3. P1 tests to add

P1 = ценные, но не блокирующие: либо есть smoke-покрытие, либо модуль
маленький, либо risk умеренный. Пять файлов.

| # | Gap | New / extend | Why | Expected assertions |
|---|-----|--------------|-----|---------------------|
| P1-1 | `SuppliersService` (18.9 KB) — нет dedicated теста, упоминается только в setup’ах других тестов. | **NEW** `tests/integration/suppliers.test.ts` | Сервис большой, есть полноценный CRUD + RBAC. Если сломается — упадут зависимые потоки (purchase-orders/receipts), но негативные кейсы не локализованы. | (1) CRUD: create/list/getOne/update/delete (или soft-delete); (2) уникальность ключевого поля (`code`/`name` — посмотреть в схеме); (3) RBAC: `SHOP_MANAGER`/`ADMIN` write, остальные roles 403; (4) попытка удалить supplier с активным `PurchaseOrder` → 409 (или soft-flag). |
| P1-2 | `RoutesService` (RouteTemplate CRUD) — `production-routes.test.ts` тестирует `OrderRouteStep`, не `RouteTemplate`. | **NEW** `tests/integration/route-templates.test.ts` | RouteTemplate — источник snapshot для заказа. Если CRUD сломается, новые заказы тихо потеряют маршрут. Smoke `order-route-snapshot.smoke` покрывает только UI. | (1) create RouteTemplate с N шагами в правильном порядке; (2) update сохраняет порядок; (3) удаление RouteTemplate, на который ссылается заказ в `IN_PRODUCTION` → 409; (4) RBAC: `SHOP_MANAGER`/`ADMIN` only. |
| P1-3 | `cut-readiness` — только UI smoke, нет integration. | **NEW** `tests/integration/cut-readiness.test.ts` | Эндпоинт пишется в `/master` и в раскройных решениях; без integration любая регрессия в агрегации видна только на проде. | (1) корректный расчёт `qtyPlan/qtyCut/qtyRemaining` по живым паспортам; (2) корректное взаимодействие с `CutReleasePolicy.consumedQty`; (3) после полного раскроя элемента — `ready=true`. |
| P1-4 | `auth` login/cookie — нет integration. | **NEW** `tests/integration/auth-login.test.ts` | Auth-guard проверяется во всех других тестах (RBAC), но сам процесс выдачи cookie/PIN-валидации — нет. | (1) валидный логин/PIN → 200 + cookie; (2) неверный PIN → 401; (3) для inactive employee → 401/403 (зафиксировать какое); (4) `/auth/me` без cookie → 401; (5) `/auth/me` с cookie → 200 с правильным `employeeId/role`. |
| P1-5 | RBAC по `master-actions` для не-master ролей и `/api/employees` POST/PATCH. | **EXTEND** `tests/integration/role-rbac.test.ts` | Существующий файл покрывает qc/wto/packing/orders. Master-actions добавлены позже и в этом файле не учтены; подтянуть туда же, не плодя файл. | (1) `POST /api/master-actions/passports/:id/unassign|transfer|return-to-cell|set-route-step` от SEAMSTRESS/CUTTER/QC/IRONING/PACKING → 403; от SHOPFLOOR_MASTER/SHOP_MANAGER/ADMIN → 200/4xx по бизнес-логике; (2) `POST /api/employees` от не-`SHOP_MANAGER`/`ADMIN` → 403. |

---

## 4. Do not duplicate rules

Применяются ко всем gap’ам §2/§3 при реализации:

1. **Расширять существующий файл**, если новый кейс логически продолжает
   тему. Не плодить «one-test-per-file» — тесты теряют контекст.
   Примеры: P0-5 → `qc-shift-flow.test.ts`, P0-6 →
   `wto-shift-flow.test.ts`, P1-5 → `role-rbac.test.ts`.
2. **Новый файл** только когда:
   - модуль не имеет dedicated integration теста (`packing`, `shifts`,
     `earnings`, `suppliers`, `routes`, `cut-readiness`, `auth`);
   - новый сценарий слишком отличается по setup/role-context (UI smoke
     для CUTTER_ASSISTANT — отдельный smoke).
3. **Не повторять golden path.** Если тест нуждается в полной цепочке
   `cut → sew → QC → WTO → packing` — пересчитать, нужна ли цепочка или
   достаточно установить состояние через Prisma + `PassportEvent`
   directly.
4. **Не воспроизводить уже зафиксированные инварианты.** Перед
   реализацией каждого пункта пробежать `grep` по описаниям в
   `tests/integration/*.test.ts` — если invariant уже проверен, удалить
   из плана и заменить пометкой «covered».
5. **Если тест валит из-за текущего поведения**, **не править
   production-код в этой задаче**. Записать finding в комментарий внутри
   теста (`// FINDING: …`) и в отдельную секцию `Findings` в PR
   description; обсудить отдельно. Не маскировать `it.skip`.
6. **AuditLog ассерты** — отдельной строкой в каждом негативном кейсе:
   при ошибке/гейте audit-запись либо отсутствует, либо помечена
   `success=false`. Это уже стандарт в репо (см. `master-calls`,
   `master-actions`, `salary`).
7. **Минимизировать setup-дубликат.** Использовать `tests/utils/db.ts`
   (`describeWithDb`, `resetDatabase`) и существующих фикстур (нагляднее
   всего в `master-actions.test.ts`).

---

## 5. Run commands

```sh
# Документ-чек (этот RECON):
npm run docs:check

# Точечный запуск нового файла после реализации:
npm run test:integration -- tests/integration/packing-add-validation.test.ts

# Все integration:
npm run test:integration

# Smoke:
npm run test:smoke

# Полный прогон:
npm run test
```

Конкретные имена скриптов и runner — из корневого `package.json`.
Проверить точные сценарии перед запуском (`npm run` без аргументов
покажет список).

---

## 6. Implementation order

Рекомендованный порядок (от риска к удобству):

1. **P0-3** `shifts.test.ts` — фундамент всех терминалов; ловит
   проблемы партиал-уник и salary-sync.
2. **P0-4** `earnings-service.test.ts` — разобраться с double-write до
   того, как чинить P0-1/P0-2.
3. **P0-1** `packing-add-validation.test.ts` — закрывает 5 веток
   валидации.
4. **P0-2** `packing-close-idempotent.test.ts` — после P0-4.
5. **P0-5** + **P0-6** — расширения двух существующих файлов.
6. **P0-7** — UI smoke, лёгкий.
7. P1 — по возможности в порядке P1-1 → P1-5.

---

## 7. Что считаем done

- Все P0 реализованы и зелёные.
- Минимум один новый finding из P0-2 / P0-4 (если найдены) задокументирован.
- `npm run docs:check` зелёный.
- `npm run test:integration` зелёный.
- В `docs/operations-test-recon.md` строки «Missing» обновлены: либо
  вычеркнуты (covered now), либо помечены ссылкой на новый тест.
