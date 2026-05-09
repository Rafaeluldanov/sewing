# Operations Test RECON

Дата: 2026-05-04. Документ — карта функций, эндпоинтов и UI-флоу
производственного контура SEWING. Цель — подготовить почву для
интеграционных тестов и обнаружения нестыковок между бэкендом, ORM-моделью
и UI. Production-код в этой задаче не меняется.

---

## 1. Scope

Тестируем полный production flow:

```
CUT  →  SEWING  →  QC  →  WTO/IRONING  →  PACKING
```

В контур входят:

- Раскрой: создание паспорта (`PassportsService.create`), размещение на
  ячейку (`place`), выпуск помощником раскройщика (`issueToEmployee`),
  закрытие раскроя (`CuttingClosureRequest`).
- Шитьё: smena сотрудника, скан паспорта на операцию (`scanOnOperation`),
  завершение операции (`completeOperationByEmployee`), переход по
  маршруту (`OrderRouteStep`).
- ОТК: сканирование, регистрация дефектов (`recordDefect`), завершение
  проверки (`completeQc`).
- ВТО / утюжка: завершение операции IRONING после `QC_PASSED`
  (`completeWto`).
- Упаковка: создание короба (`PackingService.create`), `addPassport`,
  закрытие короба (`close`) с переводом сдельных начислений в `APPROVED`.
- Прозрачные эффекты: записи в `PassportEvent`, `OperationEntry`,
  `SalaryEntry`, `MaterialIssue` (auto cut), `MasterCall`, `AuditLog`.

Роли, которые задействованы в потоке:
`ADMIN`, `SHOP_MANAGER`, `SHOPFLOOR_MASTER`, `CUTTER`, `CUTTER_ASSISTANT`,
`SEAMSTRESS`, `QC`, `IRONING`, `PACKING`, `DISPLAY`.

Не в скоупе этого RECON: складские движения сырья, закупки, патерны/тех-карты,
финансовые отчёты — они влияют на flow только косвенно (`MaterialIssue`,
`PayrollAccrualDocument`).

---

## 2. Backend methods inventory

Source files:

- `apps/api/src/modules/passports/passports.service.ts` (1627 строк)
- `apps/api/src/modules/passports/passports.controller.ts`
- `apps/api/src/modules/passports/order-passports.controller.ts`
- `apps/api/src/modules/passports/cells.controller.ts`
- `apps/api/src/modules/operations/operations.service.ts`
- `apps/api/src/modules/operations/operations.controller.ts`
- `apps/api/src/modules/qc/qc.service.ts`
- `apps/api/src/modules/qc/qc.controller.ts`
- `apps/api/src/modules/qc/passport-defects.controller.ts`
- `apps/api/src/modules/qc/defect-types.controller.ts`
- `apps/api/src/modules/wto/wto.service.ts`
- `apps/api/src/modules/wto/wto.controller.ts`
- `apps/api/src/modules/packing/packing.service.ts`
- `apps/api/src/modules/packing/packing.controller.ts`
- `apps/api/src/modules/salary/salary.service.ts`
- `apps/api/src/modules/payroll/payroll.service.ts`
- `apps/api/src/modules/equipment/equipment.service.ts`
- `apps/api/src/modules/master-actions/master-actions.service.ts`
- `apps/api/src/modules/master-calls/master-calls.service.ts`
- `apps/api/src/modules/employees/employees.controller.ts`
- `apps/api/src/modules/me/me.controller.ts`

### 2.1 PassportsService (core)

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `create` | `passports.service.ts` | `CreatePassportDto`, `creatorEmployeeId` | `PassportDetailDto` | `Passport` (status=`CREATED`, `currentOperationId`=CUT_DIVISION, `qrCode`); `PassportEvent` (`CREATED`); `OperationEntry` (immediate cutter earning через `EarningsService`); `AuditLog` | Атрибуция cutter (PHASE 2 STEP 3): creator=CUTTER auto, иначе обязателен `cutterId`. Падение валидации = 400 `CUTTER_REQUIRED`. |
| `getOne` | `passports.service.ts` | `id`, `options` | `PassportDetailDto` | none | Hint по маршруту строится из активной shift — может расходиться с реальностью при смене смены. |
| `listByOrder` | `passports.service.ts` | `orderId` | `PassportListItemDto[]` | none | — |
| `place` | `passports.service.ts` | `id`, `PlacePassportDto` | `PassportPlacementResultDto` | `Passport.currentCellId`; `PassportEvent` (`CELL_PLACED`); `WorkInProgressMovement` `PLACE` IN + `WorkInProgressBalance.qty` += `qtyCut` (см. `docs/erd.md §2.7b`); `AuditLog` (`PASSPORT_PLACED`) | Идемпотентность WIP по `WIP_PLACE:<eventId>`. |
| `issueToEmployee` | `passports.service.ts` | `id`, `employeeId` | `PassportDetailDto` | `Passport` (status=`IN_PROGRESS`, `currentEmployeeId`, `currentCellId`=null); `PassportEvent` (`ISSUED_TO_EMPLOYEE`); `WorkInProgressMovement` `ISSUE` OUT + декремент баланса; `CutReleasePolicy.consumedQty`; `MaterialIssue` (если auto cut); `AuditLog` (`PASSPORT_ISSUED`) | Скрытое автосписание сырья; пересечение с CutReleasePolicy. Должен срабатывать только в SEWING-ветке маршрута. WIP бросает `WIP_INSUFFICIENT_BALANCE` (409), если списание увело бы баланс ниже нуля. |
| `scanOnOperation` | `passports.service.ts` | `id`, `employeeId` | `PassportDetailDto` | `Passport.currentOperationId`/`currentRouteStepIndex`; `PassportEvent` (`OPERATION_SCAN`); `AuditLog` | QC-gate для входа в IRONING; есть проверка allowed equipment+operation. **Сдельных начислений больше не пишет** — после изменения 2026-05 они создаются в `completeOperationByEmployee`. |
| `completeOperationByEmployee` | `passports.service.ts` | `id`, `employeeId` | `PassportDetailDto` | `Passport.currentEmployeeId`=null; `currentRouteStepIndex` сдвигается; `PassportEvent` (`OPERATION_FINISHED`); `OperationEntry` (`PENDING_RELEASE` сдельной швее за только что завершённую операцию через `EarningsService.createPendingForCompletedOperation`); `AuditLog` (`PASSPORT_OPERATION_COMPLETED`) | Не должен откатывать паспорт назад (тест уже есть). Идемпотентен на той же операции. Закрывает ловушку «последняя швейная операция перед упаковкой» (раньше за неё никто не получал). |
| `findByCode` | `passports.service.ts` | `code` | `PassportDetailDto` | none | Резолвит QR `passport:{id}`, человеческий номер `P-YYYYMMDD-NNNN`, raw id. |
| `listCells` / `getCell` / `findCellByCode` | `passports.service.ts` | — | `CellDetailDto[] / CellDetailDto` | none | — |

> Замечание: в коде нет публичного метода `recordDefect` / `completeQC` /
> `completeWTO` / `addToBox` на `PassportsService` — эти действия живут в
> сервисах `QcService`, `WtoService`, `PackingService`. Это важно для
> RECON: «концептуальные» имена из таска маппятся на разные файлы.

### 2.2 OperationsService

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `list` / `getOne` | `operations.service.ts` | — | DTO | none | — |
| `create` | `operations.service.ts` | `CreateOperationDto` | `OperationDetailDto` | `Operation`; `OperationRateBySize` (если BY_SIZE); `OperationTimeNormBySize` | Уникальность `code`. |
| `update` | `operations.service.ts` | `id`, `UpdateOperationDto` | `OperationDetailDto` | full-replace `OperationRateBySize` / `OperationTimeNormBySize` | Транзакционность full-replace. |
| `resolveRate` | `operations.service.ts` | `(operationId, sizeId, tx?)` | `Decimal | null` | none | Источник правды для сдельщины; `SALARY_ONLY` → null; missing → `OperationRateMissingException`. |
| `resolveSalaryPlanCostPerSecond` / `resolveTimeNorm` | `operations.service.ts` | `operation`, `(operationId, sizeId, tx?)` | `Decimal | null` | none | Используется планировщиком `OrderOperationPlanService`. |

### 2.3 QcService

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `listDefectTypes` | `qc.service.ts` | — | `DefectTypeDto[]` | none | — |
| `listForQc` | `qc.service.ts` | query | page | none | Фильтр по `IN_PROGRESS`; пагинация. |
| `getQcDetail` | `qc.service.ts` | `passportId` | `QcPassportDetailDto` | none | Считает флаги `canRecordDefect`, `qcCompletedAt`, `removedFromQc`. |
| `listDefectsByPassport` | `qc.service.ts` | `passportId` | `PassportDefectDto[]` | none | — |
| `recordDefect` | `qc.service.ts` | `passportId`, `CreatePassportDefectDto`, `actorEmployeeId` | `QcPassportDetailDto` | `PassportDefect` (create); `Passport.qtyDefect` += qty; `Passport.qtyGood` -= qty; `PassportEvent` (`DEFECT_RECORDED`); `AuditLog` | Проверка `qtyGood >= qty`. |
| `completeQc` | `qc.service.ts` | `passportId`, `actorEmployeeId` | `QcPassportDetailDto` | `PassportEvent` (`QC_PASSED`); `AuditLog` (`QC_COMPLETED`). **Status не меняется** (остаётся `IN_PROGRESS`) | Идемпотентность. WTO зависит от наличия `QC_PASSED` события. |

### 2.4 WtoService

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `getWtoDetail` | `wto.service.ts` | `passportId` | `WtoPassportDetailDto` | none | Флаги `wtoCompletedAt`, `qcPassedAt`, `canCompleteWto`, `removedFromWto`. |
| `completeWto` | `wto.service.ts` | `passportId`, `actorEmployeeId` | `WtoPassportDetailDto` | `PassportEvent` (`WTO_PASSED`); `AuditLog` (`WTO_COMPLETED`). Status не меняется | Гейт: `currentOperation.category=IRONING`, `QC_PASSED` событие должно существовать, статус=`IN_PROGRESS`. |

### 2.5 PackingService

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `create` | `packing.service.ts` | `CreateBoxDto`, actor | `BoxDetailDto` | `Box` (number, qrCode=`box:{id}`, totalQty=0, maxQty) | Требует активную смену на PACKING. |
| `list` / `getOne` / `findByCode` | `packing.service.ts` | — | DTO | none | — |
| `addPassport` | `packing.service.ts` | `boxId`, dto, actor | `BoxDetailDto` | `BoxItem` (create); `Box.totalQty` += qtyGood; `Passport` (status=`PACKED`, `currentEmployeeId`=null, `currentCellId`=null); `PassportEvent` (`PACKED`); `AuditLog` (`PASSPORT_PACKED`) | Гейт: passport `IN_PROGRESS`, qtyGood>0, box не закрыт, гомогенность product/size/color, capacity (`maxQty`). |
| `close` | `packing.service.ts` | `boxId`, actor | `BoxDetailDto` | `Box.closedAt`; `OperationEntry` pending → `APPROVED` (через `EarningsService.approvePendingForPassport`). Идемпотентно | Закрытие коробки = «финальное событие», без него сдельщина не валидна. |

### 2.6 SalaryService / PayrollService

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `syncDailySalary` | `salary.service.ts` | `(employeeId, date, tx?)` | `SalaryEntryDto | null` | `SalaryEntry` upsert (source=`SHIFT_DAY`), один на день, idempotent | Не перезаписывает `editedManually=true`. Вызывается из `ShiftsService.start/stop`. |
| `list` / `summary` | `salary.service.ts` | query, viewer | DTO | none | RBAC: сотрудник видит своё, manager — всё. |
| `updateManually` | `salary.service.ts` | id, dto, viewer | DTO | `SalaryEntry` (amount/comment/`editedManually`); `AuditLog` | Только SHOP_MANAGER/ADMIN. |
| `period` / `daily` / `debts` / `employeeDetail` | `payroll.service.ts` | query | DTO | none (read-only) | Aggregator: суммирует `OperationEntry` + `SalaryEntry` + `ShiftSession`; не пишет ни в одну таблицу. Все начисления из операций — через `EarningsService`. |

### 2.7 EquipmentService

| Method | File | Input | Output | Side effects | Risk |
|--------|------|-------|--------|--------------|------|
| `list` / `getOne` | `equipment.service.ts` | — | DTO | none | — |
| `create` | `equipment.service.ts` | `CreateEquipmentDto` | DTO | `Equipment` (auto code slug, `qrCode=equipment:{id}`); `EquipmentOperation` | — |
| `update` | `equipment.service.ts` | id, dto | DTO | `Equipment` (name, displayNumber) | code/qrCode/active не редактируются. |
| `updateOperations` | `equipment.service.ts` | id, `operationIds[]` | DTO | full-replace `EquipmentOperation` | Сценарий «оборудование не разрешает операцию» — основа для allow-list в `/shifts/meta`. |

### 2.8 MasterActionsService / MasterCallsService

| Method | File | Side effects | Risk |
|--------|------|--------------|------|
| `unassign` | `master-actions.service.ts` | `Passport.currentEmployeeId`=null; `AuditLog` (`MASTER_PASSPORT_UNASSIGNED`) | Reason обязателен. |
| `transferToEmployee` | `master-actions.service.ts` | `Passport.currentEmployeeId/currentCellId`; `AuditLog` (`MASTER_PASSPORT_TRANSFERRED`) | Может авто-сдвинуть `currentRouteStepIndex` если у целевого сотрудника подходящая смена. |
| `returnToCell` | `master-actions.service.ts` | `Passport.currentCellId`; `WorkInProgressMovement` `RETURN` IN + инкремент `WorkInProgressBalance.qty` (см. `docs/erd.md §2.7b`); `AuditLog` (`MASTER_PASSPORT_RETURNED_TO_CELL`) | Идемпотентен в ту же ячейку (noop без WIP-движения). |
| `setRouteStep` | `master-actions.service.ts` | `Passport.currentRouteStepIndex`/`currentOperationId`; `AuditLog` (`MASTER_PASSPORT_ROUTE_STEP_SET`) | Запрет шага «назад». |
| `MasterCallsService.create` | `master-calls.service.ts` | `MasterCall` (OPEN); `AuditLog` (`MASTER_CALLED`, только при реальной создании) | Идемпотентен — повторный POST вернёт ту же запись, без второй строки в Audit. |
| `MasterCallsService.listOpen` | `master-calls.service.ts` | none | FIFO. |
| `MasterCallsService.resolveByEmployeeQr` | `master-calls.service.ts` | `MasterCall` (status=`RESOLVED`, resolvedAt, resolvedById); `AuditLog` (`MASTER_CALL_RESOLVED`) | — |

### 2.9 EmployeesController / MeController

| Endpoint | Roles | Назначение |
|----------|-------|------------|
| `GET /api/employees`, `POST/PATCH /api/employees/:id` | `SHOP_MANAGER`, `ADMIN` | Admin-only список сотрудников. |
| `GET /api/employees/:id/print`, `GET /api/employees/:id/qr` | `@Public` | Печать/QR — публичные. |
| `GET /api/me/employee-qr` | любой авторизованный | Возвращает QR текущего пользователя. |

> Risk: `/orders/[id]/passports/new` для CUTTER_ASSISTANT не должен дёргать
> admin-only `GET /api/employees?role=CUTTER`. Должен использовать
> `/api/me/employee-qr` или дедикейтнутый эндпоинт «cutters». Это —
> ключевой инвариант для теста.

---

## 3. API endpoints inventory

| Endpoint | Controller | Roles | Used by UI | Expected operation |
|----------|------------|-------|------------|--------------------|
| `POST /api/passports` | `passports.controller.ts` | `CUTTER`, `CUTTER_ASSISTANT`, `SHOP_MANAGER` | `/orders/[id]/passports/new` | `PassportsService.create` |
| `GET /api/passports/:id` | `passports.controller.ts` | auth | `/qc/passports/[id]`, `/work` (детали) | `getOne` |
| `POST /api/passports/:id/place` | `passports.controller.ts` | `CUTTER`, `CUTTER_ASSISTANT`, `SHOP_MANAGER` | `/work` (cutter), shelf-placement | `place` |
| `POST /api/passports/:id/issue` | `passports.controller.ts` | auth | `/work` (seamstress accept) | `issueToEmployee` |
| `POST /api/passports/:id/scan` | `passports.controller.ts` | auth | `/work`, `/qc`, `/wto` | `scanOnOperation` |
| `POST /api/passports/:id/complete-operation` | `passports.controller.ts` | auth | `/work` complete menu | `completeOperationByEmployee` |
| `POST /api/passports/by-code` | `passports.controller.ts` | auth | scanner modals в `/work`, `/qc`, `/wto`, `/master` | `findByCode` |
| `GET /api/passports/:id/print`, `GET /api/passports/:id/qr` | `passports.controller.ts` | `@Public` | print sheet | qr renderer |
| `GET /api/orders/:id/passports` | `order-passports.controller.ts` | `SHOP_MANAGER`, `CUTTER_ASSISTANT` | `/orders/[id]/passports/new` (remaining qty) | `listByOrder` |
| `GET /api/cells`, `GET /api/cells/:id`, `POST /api/cells/by-code`, `PATCH /api/cells/:id` | `cells.controller.ts` | auth (PATCH: `SHOP_MANAGER`/`ADMIN`) | placement panels | cell read/update |
| `GET /api/operations`, `POST /api/operations`, `GET /api/operations/:id`, `PATCH /api/operations/:id` | `operations.controller.ts` | `SHOP_MANAGER`, `ADMIN` | `/admin/operations` | CRUD |
| `GET /api/qc/defect-types` | `defect-types.controller.ts` | auth (читает QC-флоу) | `/qc`, `/qc/passports/[id]` | `listDefectTypes` |
| `GET /api/qc/passports`, `GET /api/qc/passports/:id` | `qc.controller.ts` | `QC`, `SHOP_MANAGER` | `/qc` | `listForQc`, `getQcDetail` |
| `POST /api/qc/passports/:id/defects` | `qc.controller.ts` | `QC`, `SHOP_MANAGER` | `/qc`, `/qc/passports/[id]` | `recordDefect` |
| `POST /api/qc/passports/:id/complete` | `qc.controller.ts` | `QC`, `SHOP_MANAGER` | `/qc`, `/qc/passports/[id]` | `completeQc` |
| `GET /api/passports/:id/defects` | `passport-defects.controller.ts` | auth | history view | `listDefectsByPassport` |
| `GET /api/wto/passports/:id`, `POST /api/wto/passports/:id/complete` | `wto.controller.ts` | `IRONING`, `SHOP_MANAGER` | `/wto` | `getWtoDetail`, `completeWto` |
| `POST /api/packing/boxes`, `GET /api/packing/boxes`, `GET /api/packing/boxes/:id` | `packing.controller.ts` | `PACKING`, `SHOP_MANAGER` | `/packing`, `/packing/boxes/[id]` | create/list/getOne |
| `POST /api/packing/boxes/:id/add-passport` | `packing.controller.ts` | `PACKING`, `SHOP_MANAGER` | `/packing`, `/packing/boxes/[id]` | `addPassport` |
| `POST /api/packing/boxes/:id/close` | `packing.controller.ts` | `PACKING`, `SHOP_MANAGER` | `/packing`, `/packing/boxes/[id]` | `close` |
| `GET /api/packing/boxes/:id/qr`, `/label` | `packing.controller.ts` | `@Public` | print | qr/label |
| `GET /api/equipment`, `POST /api/equipment`, `GET /api/equipment/:id`, `PATCH /api/equipment/:id`, `PATCH /api/equipment/:id/operations` | `equipment.controller.ts` | `SHOP_MANAGER`, `ADMIN` | `/admin/equipment` | CRUD + binding |
| `GET /api/equipment/:id/print`, `GET /api/equipment/:id/qr` | `equipment.controller.ts` | `@Public` | print | qr |
| `POST /api/master-actions/passports/:id/unassign` / `/transfer-to-employee` / `/return-to-cell` / `/set-route-step` | `master-actions.controller.ts` | `SHOPFLOOR_MASTER`, `SHOP_MANAGER` | `/master` | master actions |
| `POST /api/master-calls`, `GET /api/master-calls`, `POST /api/master-calls/resolve` (`/resolve-by-employee-qr`) | `master-calls.controller.ts` | create=auth; list/resolve=`SHOPFLOOR_MASTER`,`SHOP_MANAGER`,`ADMIN` | `/master`, `/work` (call master button) | calls flow |
| `GET /api/employees`, `POST/PATCH /api/employees/:id` | `employees.controller.ts` | `SHOP_MANAGER`, `ADMIN` | `/admin/employees` | RBAC-чувствителен; **не** должен использоваться в seamstress/CUTTER_ASSISTANT флоу. |
| `GET /api/me/employee-qr` | `me.controller.ts` | auth | `/work`, FAB «My QR» | self qr |
| `GET /api/shifts/meta`, `GET /api/shifts/current`, `POST /api/shifts/start`, `POST /api/shifts/stop`, `GET /api/shifts/current-work` | `shifts.controller.ts` (вне сегодняшнего скоупа, но нужен) | auth | все терминалы | shift gate |
| `GET /api/shopfloor/state`, `GET /api/shopfloor/orders`, `GET /api/shopfloor/equipment-status`, `GET /api/shopfloor/display` | `shopfloor.*.controller.ts` | `ADMIN`/`SHOP_MANAGER`/`DISPLAY` | `/shopfloor`, `/shopfloor/display` | read-only board |
| `GET /api/cut-release-policy/active` | `cut-release-policy.controller.ts` | auth | `/master`, `/work` (cutter assistant) | политика выпуска |

> Замечание: `GET /api/auth/me` — централизованный SSR-fetch в большинстве
> страниц через `getCurrentUserOrNull`. Используется для решения о
> редиректе и о том, какой UI рисовать (упрощённый CUTTER_ASSISTANT vs
> полный CUTTER/SHOP_MANAGER).

---

## 4. UI flow inventory

| Route | Role | Main action | Backend call | Risk |
|-------|------|-------------|--------------|------|
| `/work` | `SEAMSTRESS`, `CUTTER`, `CUTTER_ASSISTANT`, `ADMIN`, `SHOP_MANAGER` | Старт смены, скан паспорта, accept/issue, scan, complete | `POST /api/shifts/start|stop`, `POST /api/passports/by-code`, `POST /api/passports/:id/issue|scan|complete-operation`, `GET /api/shifts/meta|current` | Двойной сканер; модалка подтверждения; ручка «Master» = `POST /api/master-calls`. |
| `/work/cut-orders` | `CUTTER_ASSISTANT` | Выбор IN_PRODUCTION-заказа | `GET /api/orders?status=IN_PRODUCTION&pageSize=200` | Если только один заказ — auto-redirect. |
| `/orders/[id]/passports/new` | `CUTTER`, `CUTTER_ASSISTANT`, `ADMIN`, `SHOP_MANAGER` | Создание паспорта (выпуск раскроя) | `GET /api/orders/:id`, `GET /api/orders/:id/passports`, `POST /api/passports`, `GET /api/auth/me`, **`GET /api/employees?role=CUTTER`** (только не-CUTTER), опционально `POST /api/cutting-closure-requests` | **Risk #1 (по тз):** CUTTER_ASSISTANT не должен дёргать admin-only `GET /api/employees`. Тест должен проверить, что для CUTTER_ASSISTANT этот вызов не делается, либо что он работает без 403. |
| `/orders/[id]/passports` | `ADMIN`, `SHOP_MANAGER` | Список паспортов заказа | `GET /api/orders/:id/passports` | — |
| `/qc` | `QC`, `ADMIN`, `SHOP_MANAGER` | Скан паспорта, регистрация дефекта, complete QC, старт/стоп смены | `GET /api/shifts/meta|current`, `GET /api/qc/defect-types`, `POST /api/passports/by-code`, `POST /api/passports/:id/scan`, `GET /api/qc/passports/:id`, `POST /api/qc/passports/:id/defects|complete` | Нет shift = `SHIFT_SESSION_REQUIRED`. |
| `/qc/passports/[id]` | `QC`, `ADMIN`, `SHOP_MANAGER` | Детали QC, форма дефекта, complete | `GET /api/qc/passports/:id`, `POST /api/qc/passports/:id/defects|complete`, `GET /api/qc/defect-types` | — |
| `/wto` | `IRONING`, `ADMIN`, `SHOP_MANAGER` | Скан паспорта, complete WTO | `GET /api/shifts/meta|current`, `POST /api/passports/by-code`, `POST /api/passports/:id/scan`, `GET /api/wto/passports/:id`, `POST /api/wto/passports/:id/complete` | Нет `QC_PASSED` → 409 `PASSPORT_NOT_QC_PASSED`. |
| `/packing` | `PACKING` (terminal) / `ADMIN` / `SHOP_MANAGER` (list) | Создание короба, добавить паспорт, закрыть короб | `GET /api/shifts/meta|current`, `GET /api/packing/boxes`, `POST /api/packing/boxes`, `GET /api/packing/boxes/:id`, `POST /api/packing/boxes/:id/add-passport|close` | Гомогенность product/size/color, capacity. |
| `/packing/boxes/[id]` | `PACKING`, `ADMIN`, `SHOP_MANAGER` | Содержимое короба, add/close | `GET /api/packing/boxes/:id`, `POST /api/packing/boxes/:id/add-passport|close` | — |
| `/master` | `SHOPFLOOR_MASTER` (forced), `ADMIN`, `SHOP_MANAGER` | Очередь open-вызовов, resolve по QR | `GET /api/master-calls`, `POST /api/master-calls`, `POST /api/master-calls/resolve-by-employee-qr`, `GET /api/cut-release-policy/active`, `GET /api/sizes` | Polling. |
| `/shopfloor` | `ADMIN`, `SHOP_MANAGER` | Live доска по операциям | `GET /api/shopfloor/state|orders|equipment-status` (poll 3s) | Поллинг. |
| `/shopfloor/display` | `DISPLAY` (forced), `ADMIN`, `SHOP_MANAGER` | TV-табло | `GET /api/shopfloor/display` (poll 7s) | — |
| `/employee-qr` (action only) | любой авторизованный | Показ собственного QR | `GET /api/me/employee-qr` | Используется FAB-кнопкой. |

---

## 5. Current tests inventory

Файлы из `tests/integration/`, `tests/smoke/`, `tests/unit/`. В колонке
«Missing» — пробелы, которые не покрывает данный файл (но логически близки
к нему).

### 5.1 Integration

| Test file | Covers | Missing |
|-----------|--------|---------|
| `tests/integration/passports-complete-operation.test.ts` | `complete-operation`: правильный `operationId` в `OPERATION_FINISHED`, запрет отката, идемпотентность на той же операции, `AuditLog`. | Нет проверки complete без активной смены (shift gate); нет проверки RBAC (что чужой сотрудник не закроет чужой паспорт); нет проверки, что `currentEmployeeId` действительно очищается. |
| `tests/integration/operations.test.ts` | CRUD операций, `pricingMode` (FIXED/BY_SIZE/SALARY_ONLY), уникальность кода, RBAC. | Нет проверки, что `Operation` нельзя удалить, если есть `OperationEntry`. |
| `tests/integration/operation-time-norms.test.ts` | timeNorm CRUD, mode switch, `resolveTimeNormSec`, legacy-совместимость. | — |
| `tests/integration/operation-salary-plan.test.ts` | планируемая стоимость для SALARY_ONLY, missing-rate warnings, staleness. | — |
| `tests/integration/order-operation-plan.test.ts` | `OrderOperationPlan` (cost/time per size × qty), snapshot `OrderRouteStep`, immutability в IN_PRODUCTION. | — |
| `tests/integration/equipment-operations.test.ts` | binding equipment↔operation, `/shifts/meta` allow-list, RBAC, print/QR. | — |
| `tests/integration/cutter-attribution.test.ts` | creator=CUTTER auto-attrib; иначе `cutterId` обязателен; валидация роли/active; немедленный `OperationEntry`. | — |
| `tests/integration/cutter-assistant-shift.test.ts` | shift на cutting-table, `SHIFT_SESSION_REQUIRED` для печати, `/shifts/meta` для CUTTER_ASSISTANT. | Нет теста, что CUTTER_ASSISTANT может выпустить паспорт без admin-only `/api/employees`. |
| `tests/integration/cutter-compensation.test.ts` | B2B/MARKETPLACE формула, BY_SIZE rate, missing-rate, идемпотентность. | — |
| `tests/integration/cutting-closure.test.ts` | closure request lifecycle, partial unique, RBAC, planFact. | — |
| `tests/integration/current-work.test.ts` | `GET /api/shifts/current-work` фильтрует свои IN_PROGRESS, RBAC. | — |
| `tests/integration/master-actions.test.ts` | unassign / transfer / return-to-cell / set-route-step, reason обязателен, RBAC, AuditLog before/after. | — |
| `tests/integration/master-calls.test.ts` | OPEN-create, idempotency, list, resolve by QR, RBAC, AuditLog. | Нет теста: master-call без активной смены работника (нужен ли shift-gate?). |
| `tests/integration/role-rbac.test.ts` | RBAC по всем endpoint-кластерам (qc/wto/packing/orders/defect-types). | Нет теста на `POST /api/master-actions/*` с не-master ролью. |
| `tests/integration/qc-shift-flow.test.ts` | shift-gate для QC scan, `QC_PASSED` без смены статуса, `/shifts/meta` для QC. | Нет теста: completeQc дважды → идемпотентность. |
| `tests/integration/wto-shift-flow.test.ts` | shift-gate, `QC_PASSED` prerequisite, `WTO_PASSED`. | Нет теста: WTO до QC → 409. |
| `tests/integration/production-flow.test.ts` (1270) | full e2e MVP 1.1 от создания до закрытия короба + earnings. | Нет проверки defect ⇒ qtyDefect/qtyGood корректны до addToBox. |
| `tests/integration/e2e-production-flow.test.ts` (530) | golden path + currentRouteStepIndex + AuditLog по каждому событию + diagnostics. | — |
| `tests/integration/pilot-flow.test.ts` | пилотный сценарий | конкретная нагрузка — не проверена. |
| `tests/integration/production-routes.test.ts` | `OrderRouteStep` snapshot и обход. | — |
| `tests/integration/production-dashboard.test.ts` | `/api/shopfloor/state` агрегаты. | — |
| `tests/integration/shopfloor-display.test.ts` | display KPI. | — |
| `tests/integration/me-employee-qr.test.ts` | `GET /api/me/employee-qr` для самого себя. | — |
| `tests/integration/db-invariants.test.ts` | partial unique (одна активная смена); `BoxItem` (один паспорт в одном коробе); `WorkInProgressBalance.balanceKey` — уникальность пары (orderId/productId/sizeId/color/warehouseId/cellId). | Нет инварианта «один `OperationEntry` на пару (passport, op-completion-event)». |
| `tests/integration/salary.test.ts` | SalaryEntry idempotent, edited manually, RBAC. | — |

### 5.2 Smoke (UI)

| Test file | Covers | Missing |
|-----------|--------|---------|
| `tests/smoke/route-wip-work-ui.smoke.test.ts` | `/work` рендерится, shift meta + current work. | Нет проверки, что для CUTTER_ASSISTANT кнопка создания паспорта работает без admin endpoint. |
| `tests/smoke/employee-workplaces-design.smoke.test.ts` | admin рабочих мест. | — |
| `tests/smoke/employees-admin.smoke.test.ts` | `/admin/employees`. | — |
| `tests/smoke/qc-collapsed-row.smoke.test.ts` | строка списка QC. | — |
| `tests/smoke/qc-start-shift.smoke.test.ts` | форма старта смены QC. | — |
| `tests/smoke/wto-start-shift.smoke.test.ts` | форма старта смены WTO. | — |
| `tests/smoke/cutter-active-shift-panel.smoke.test.ts` | панель активной смены раскройщика. | — |
| `tests/smoke/seamstress-feedback.smoke.test.ts` | feedback на `/work`. | — |
| `tests/smoke/master-actions.smoke.test.ts` / `master-calls.smoke.test.ts` / `master-layout.smoke.test.ts` | UI master. | — |
| `tests/smoke/shopfloor-display.smoke.test.ts` / `shopfloor-qc-done.smoke.test.ts` / `shopfloor-wto-done.smoke.test.ts` | TV-табло, статусы. | — |
| `tests/smoke/equipment-admin.smoke.test.ts` | UI оборудования. | — |
| `tests/smoke/employee-qr-button.smoke.test.ts` / `me-employee-qr.smoke.test.ts` | FAB «My QR». | — |
| `tests/smoke/operations-admin.smoke.test.ts` / `operation-economics.smoke.test.ts` | UI операций. | — |
| `tests/smoke/frontend-rbac.smoke.test.ts` | редиректы по ролям. | — |

### 5.3 Unit

| Test file | Covers |
|-----------|--------|
| `tests/unit/role-redirect.test.ts` | role → home route. |
| `tests/unit/employee-qr-token.test.ts` | parsing/validity QR токена сотрудника. |
| `tests/unit/compensation-helpers.test.ts` | формулы B2B/percent. |

---

## 6. Invariants to test

Список правил, которые должны держаться вне зависимости от роли и пути:

1. **No double-close.** Операция не закрывается дважды: повторный
   `POST /api/passports/:id/complete-operation` на той же операции либо
   идемпотентен (тест в `passports-complete-operation.test.ts`), либо
   возвращает 409. **Ни в коем случае не создаёт второй
   `OPERATION_FINISHED` `PassportEvent` и не дублирует `OperationEntry`.**
2. **RBAC 403.** Неправильная роль на любом доменно-чувствительном
   endpoint получает 403. Покрытие: QC/WTO/PACKING/master-actions —
   тест должен явно проверить SEAMSTRESS, CUTTER, IRONING, PACKING вне
   своей зоны.
3. **No stage skip.** Паспорт не перескакивает этапы:
   - `WTO_PASSED` невозможен без существующего `QC_PASSED` события.
   - `PACKED` невозможен на паспорте, у которого `currentOperation` не
     IRONING/последний шаг маршрута либо без `WTO_PASSED` (если flow
     требует ВТО).
   - `currentRouteStepIndex` не идёт назад через `setRouteStep` (есть
     запрет в `MasterActionsService`).
4. **OperationEntry single-write.** На каждое завершение операции
   создаётся ровно один `OperationEntry` с правильным
   `(passportId, operationId, employeeId, sourceEventType)`. Не
   дублируется при повторных скроллах/таймаутах.
5. **qtyGood / qtyDefect инвариант.** `qtyGood + qtyDefect ≤ qtyCut`.
   `recordDefect` падает 400 если `qty > Passport.qtyGood`.
6. **QC gate.** `completeQc` нельзя позвать, если паспорт не в
   `IN_PROGRESS` или у него ещё открыты обязательные SEWING-операции.
   `QC_PASSED` создаётся ровно один раз (идемпотентность `completeQc`).
7. **PACKING gate.** `addPassport` падает, если:
   - `Passport.status != IN_PROGRESS`;
   - `Passport.qtyGood == 0`;
   - короб закрыт;
   - product/size/color не совпадают с уже лежащими паспортами;
   - `Box.totalQty + qtyGood > maxQty`.
8. **Cutter assistant без admin endpoint.** Выпуск паспорта помощником
   раскройщика не использует admin-only `GET /api/employees`. Текущий
   код `apps/web/app/orders/[id]/passports/new` зовёт
   `getCurrentUserOrNull` и пропускает employee-список для CUTTER /
   CUTTER_ASSISTANT — это нужно зафиксировать тестом, чтобы регрессия не
   прошла.
9. **Equipment scan не ломает flow.** `Equipment` без `EquipmentOperation`
   не может стартовать смену под недопустимой операцией; повторный скан
   того же QR на активной смене → no-op. Отзыв смены не должен убить
   `OperationEntry` уже завершённых паспортов.
10. **Idempotent close.** `POST /api/packing/boxes/:id/close` второй раз
    не дублирует переводы `OperationEntry` в `APPROVED` и не создаёт
    второе событие `BOX_CLOSED` в `AuditLog`.
11. **Salary single-source.** На один (`employeeId`, `date`) может быть
    максимум один `SalaryEntry` источника `SHIFT_DAY`. Manual override
    защищён от перезаписи `syncDailySalary`.
12. **Master call idempotency.** Повторный `POST /api/master-calls` от
    одного сотрудника возвращает существующий OPEN-call, не пишет второй
    `MASTER_CALLED` в `AuditLog`.
13. **Work-in-progress invariant.** При place/issue/return/delete/
    pack-out `WorkInProgressBalance.qty` меняется ровно на `qtyCut`
    паспорта в одном `WorkInProgressMovement` с уникальным
    `sourceKey`. `qty` никогда не уходит ниже нуля — backend бросает
    `WIP_INSUFFICIENT_BALANCE` (409). См. `docs/erd.md §2.7b`.
14. **AuditLog complete.** Каждое доменное действие пишет ровно одну
    запись `AuditLog` (e.g. `PASSPORT_PLACED`, `PASSPORT_ISSUED`,
    `PASSPORT_OPERATION_COMPLETED`, `QC_COMPLETED`, `WTO_COMPLETED`,
    `PASSPORT_PACKED`, `BOX_CLOSED`, `MASTER_PASSPORT_*`,
    `MASTER_CALLED`, `MASTER_CALL_RESOLVED`).

---

## 7. Recommended test plan

Разбиваем на четыре уровня. Каждый уровень — отдельные файлы, чтобы
падения локализовались.

### 7.1 Backend integration tests (`tests/integration/`)

Новые файлы (предлагаемые имена):

1. `passport-issue-rbac.integration.test.ts` — проверка инварианта 8:
   `POST /api/passports` от CUTTER_ASSISTANT работает без вызова
   `GET /api/employees`. Использует тестовый http-клиент и проверяет, что
   401/403 по `/api/employees` для CUTTER_ASSISTANT остаётся, но flow
   создания паспорта проходит.
2. `passport-stage-skip.integration.test.ts` — инвариант 3:
   - WTO до QC: ожидается 409 `PASSPORT_NOT_QC_PASSED`.
   - Packing до WTO (если последняя операция — IRONING): ожидается 409.
   - `setRouteStep` назад: 409.
3. `qc-complete-idempotent.integration.test.ts` — инварианты 6 и 14:
   повторный `completeQc` даёт идемпотентный результат, в `PassportEvent`
   и `AuditLog` ровно одна запись `QC_PASSED` / `QC_COMPLETED`.
4. `packing-add-validation.integration.test.ts` — инвариант 7: все пять
   причин отказа `addPassport`, плюс закрытие пустого короба,
   `closeBox` × 2 идемпотентно.
5. `operation-entry-single-write.integration.test.ts` — инвариант 4:
   многократный `scan` подряд и параллельно (Promise.all) не плодит
   `OperationEntry`. (Может быть пересечение с
   `cutter-compensation.test.ts` — посмотреть, не сделать ли обновление
   там.)
6. `qty-good-defect.integration.test.ts` — инвариант 5: серия
   `recordDefect` до и после полного исчерпания `qtyGood`.
7. `salary-source-conflict.integration.test.ts` — инвариант 11: ручное
   обновление + повторный `syncDailySalary`.

### 7.2 API/RBAC tests

1. Расширить `role-rbac.test.ts`: добавить master-actions endpoints
   (`SHOPFLOOR_MASTER` only) и `POST /api/employees` (manager-only).
2. `cutter-assistant-flow.rbac.test.ts` — точечный набор: что доступно
   CUTTER_ASSISTANT (`/orders`, `/passports`, `/cutting-closure-requests`,
   `/me/employee-qr`) и что недоступно (`/employees`, `/operations`).
3. `display-role-readonly.rbac.test.ts` — `DISPLAY` не может вызвать ни
   один write-endpoint; редирект middleware подтверждён smoke-тестом, но
   API-уровень нужно проверить отдельно.

### 7.3 Frontend smoke tests

1. `orders-passports-new-cutter-assistant.smoke.test.ts` — рендер формы
   `/orders/[id]/passports/new` для CUTTER_ASSISTANT без вызова
   `/api/employees` (мокаем sso как CA, ожидаем что в network call
   из теста этого endpoint нет).
2. `qc-flow-end-to-end.smoke.test.ts` — кликнуть scan → defect → complete
   на дет странице QC.
3. `wto-flow-end-to-end.smoke.test.ts` — аналогично, плюс негативный
   кейс «нет QC_PASSED».
4. `packing-add-and-close.smoke.test.ts` — создание короба, добавление
   паспорта, закрытие.
5. `master-resolve-by-qr.smoke.test.ts` — открыть `/master`, sym
   QR-резолв, увидеть очередь без вызова.
6. `shopfloor-poll.smoke.test.ts` — рендер `/shopfloor` + проверка, что
   повторный fetch не падает на ошибке параллельного запроса.

### 7.4 End-to-end (Playwright)

В репозитории сейчас Playwright не подключён (не нашёл `playwright`
в `package.json` зависимостях). Если планируется добавлять — следующий
сценарий покрыл бы 1.1 → 1.5 пилота:

1. CUTTER_ASSISTANT логинится, открывает заказ, создаёт паспорт,
   размещает на ячейке.
2. SEAMSTRESS логинится, стартует смену на оверлоке, скан-issue из
   ячейки, скан на следующую операцию, complete.
3. QC роль завершает QC.
4. IRONING завершает WTO.
5. PACKING создаёт короб, добавляет паспорт, закрывает.
6. ADMIN видит паспорт в DONE-секции `/shopfloor`.

До появления Playwright — заменить эквивалентным сценарием в
`tests/integration/e2e-production-flow.test.ts` плюс отдельным smoke-
тестом для каждой роли (через серверные actions).

---

## 8. Risk hot-spots (краткий список для приоритизации)

1. `passports.service.ts` — 1627 строк, плотный код, много инвариантов
   уже встроены. Любое изменение в `issueToEmployee` и `scanOnOperation`
   должно тестироваться вместе с MaterialIssue, CutReleasePolicy,
   `OperationEntry`.
2. UI `/orders/[id]/passports/new` — зависит от `/api/auth/me` для
   ветвления и от `/api/employees` для не-CUTTER ролей. Регрессионная
   точка для CUTTER_ASSISTANT.
3. `EarningsService` (вызывается из `PassportsService.create` и
   `scanOnOperation`, плюс `PackingService.close`) — единственное место
   записи `OperationEntry`. Обязателен тест на single-write.
4. `MasterActionsService.transferToEmployee` — авто-смещение
   `currentRouteStepIndex` при попадании в активную смену цели —
   потенциальный stage-skip, нужен явный тест.
5. `WtoService.completeWto` — гейт `currentOperation.category=IRONING` —
   тест должен покрыть случай, когда `setRouteStep` master-ом подменил
   операцию.

---

## 9. Глоссарий моделей (свод)

Ключевые Prisma-модели и их состояния (детали — `docs/erd.md`,
`docs/events.md`, `prisma/schema.prisma`):

- `Passport` — ключ потока. Enum `PassportStatus`:
  `CREATED` → `IN_PROGRESS` → `PACKED` (или `CANCELLED`).
  Ссылочные поля: `currentOperationId`, `currentEmployeeId`, `currentCellId`,
  `currentRouteStepIndex`, `cutterId`, `creatorId`.
- `PassportEvent` — журнал. Enum `PassportEventType`:
  `CREATED`, `OPERATION_STARTED`, `OPERATION_FINISHED`, `MOVED`,
  `DEFECT_RECORDED`, `CELL_PLACED`, `CELL_REMOVED`,
  `ISSUED_TO_EMPLOYEE`, `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`,
  `PACKED`, `CANCELLED`.
- `PassportDefect` — индивидуальные дефекты, ссылается на `DefectType`.
- `OperationEntry` — сдельные начисления.
  Enum `EntryStatus`: `PENDING`, `PENDING_RELEASE`, `APPROVED`,
  `CANCELLED`, `REVERSED`. Enum `ApprovalMode`: `IMMEDIATE`,
  `AFTER_RELEASE`. Enum `EarningSource`: `PASSPORT_CREATED`,
  `OPERATION_TRANSITION`.
- `Operation` — справочник. Enum `OperationCategory`: `CUTTING`, `SEWING`,
  `QC`, `IRONING`, `PACKING`. Enum `PricingMode`: `FIXED`, `BY_SIZE`,
  `SALARY_ONLY`.
- `Employee` — Enum `Role`: `SHOP_MANAGER`, `CUTTER`, `CUTTER_ASSISTANT`,
  `SEAMSTRESS`, `QC`, `IRONING`, `PACKING`, `ADMIN`, `DISPLAY`,
  `SHOPFLOOR_MASTER`. Enum `CompensationType`: `PIECEWORK`, `SALARY`,
  `MIXED`.
- `Equipment` + `EquipmentOperation` — allow-list операций для рабочего
  места.
- `Cell` + `WorkInProgressBalance` / `WorkInProgressMovement` —
  полуфабрикат в ячейках с полным контекстом (orderId / productId /
  sizeId / color) и журналом движений.
- `Box` + `BoxItem` — упаковка; короб закрывается ровно один раз.
- `SalaryEntry` — суточная зарплата. Enum `SalaryEntrySource`:
  `SHIFT_DAY`, `MANUAL`.
- `PayrollPayout`, `PayrollPayoutLine`, `PayrollAccrualDocument`,
  `PayrollAccrualDocumentLine` — выплаты; для теста потока операций
  достаточно убедиться, что они **не пишутся напрямую** из flow, а
  собираются из `OperationEntry`/`SalaryEntry`.
- `MasterCall` — Enum `MasterCallStatus`: `OPEN`, `RESOLVED`,
  `CANCELLED`.
- `ShiftSession` — гарантия партиально-уникального индекса (одна
  активная смена на сотрудника).
- `MaterialIssue` — авто-списание сырья при выпуске раскроя.

---

## 10. Источники

- `apps/api/src/modules/**/*.{controller,service}.ts`
- `prisma/schema.prisma`
- `apps/web/app/{work,qc,wto,packing,master,shopfloor,orders}/**`
- `apps/web/middleware.ts`
- Документы `docs/api.md`, `docs/erd.md`, `docs/events.md`,
  `docs/production-flow.md` — авторитетные на момент написания.

Дальше — собственно написание тестов из секции 7.
