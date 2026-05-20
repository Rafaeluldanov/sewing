# Backlog — невыпущенный / отложенный функционал

> **Назначение.** Единая карта того, что **сознательно не реализовано**
> в текущем MVP, плюс открытый тех-долг и планы внедрения подсистем.
>
> **Это дайджест, а не source of truth.** Первоисточники:
> - `docs/current-state.md` §1 — формулировки «Сознательно **не
>   реализованы** на этой итерации» по каждому модулю (номера строк
>   ниже — на момент сборки 2026-05-19, могут сдвигаться);
> - `docs/test-gap-plan.md` — план тестового покрытия (P0/P1);
> - `docs/operations-test-findings.md` — production-findings из smoke;
> - `docs/index.md` — PHASE 3 переписывания доков;
> - `docs/*-recon.md` — рабочие планы внедрения подсистем.
>
> При расхождении этого файла и первоисточника — **верим
> первоисточнику и коду**. Пункт считается закрытым, когда исчезает
> соответствующая фраза «не реализованы» в `current-state.md` (или
> зелёный тест/finding) — не когда вычеркнут здесь.
>
> Бэклог как трекер задач (issues/доска) не ведётся: проект — один
> разработчик, ветки `develop` / `feature*` синхронны с `main`,
> невыпущенного кода в ветках нет. Этот файл заменяет рассыпанный по
> прозе «не реализовано».

Легенда статуса: **DEFERRED** — намеренно вне scope MVP, поведение
осознанное; **TODO** — признанный тех-долг, ждёт реализации;
**BUG** — подтверждённый production-дефект, зафиксирован
characterization-тестом.

---

## 1. Склад материалов (`StockBalance` / `StockMovement`)

Первоисточник: `current-state.md` §1, блоки «Подключение … к складу»,
«Read-only API склада», «UI остатков и движений», «Фильтры склада»
(строки ~218–530, 1241–1292).

| # | Статус | Пункт | Почему отложено / где зафиксировано |
|---|--------|-------|--------------------------------------|
| 1.1 | DEFERRED | `MaterialStockLot` + партионный учёт | повторяется во всех складских итерациях; `current-state.md` стр. ~218, 374, 425, 479, 527, 601, 1236, 1437 |
| 1.2 | DEFERRED | FIFO / LIFO списания (сейчас средневзвешенная по `StockBalance.unitCost`) | `current-state.md` стр. ~351, 374, 424–425; «`applyMovementInTx` на OUT использует текущий `unitCost`, не партии» |
| 1.3 | DEFERRED | Master-модель `Material` (общий справочник номенклатуры) | материал в MVP идентифицируется через `WorkshopNeed`; `current-state.md` стр. ~219, 233, 374, 425, 1236 |
| 1.4 | DEFERRED | Роли `WAREHOUSE_MANAGER` / `PURCHASER` / `ACCOUNTANT` | склад под `ADMIN` / `SHOP_MANAGER`; `current-state.md` стр. ~375, 427, 480, 1435 |
| 1.5 | TODO | Backend unified warehouse endpoint (серверный total / pagination / sorting) | сейчас материалы + ГП объединяются на UI с потолком `limit=200`; «TODO в коде», `current-state.md` стр. ~830–835 |
| 1.6 | DEFERRED | Multi-warehouse фильтр / группировки по складу / сводка по складам | `current-state.md` стр. ~476–479 |
| 1.7 | DEFERRED | Фильтры склада: chips / advanced summary, фильтр `materialRole` / `unit`, frontend-валидация `from > to` | `current-state.md` стр. ~1287–1292 |
| 1.8 | DEFERRED | Обновление `ProductionCostV2Service` под складскую ось (управленческий P&L по-прежнему берёт материалы из `OrderCostEstimate` / `WorkshopNeed`, не из `MaterialIssue` / `StockBalance`) | `current-state.md` стр. ~126–129, 376, 1436 |
| 1.9 | DEFERRED | `OrderPlannedCostSummaryCard` под складскую ось | `current-state.md` стр. ~377–378 |
| 1.10 | DEFERRED | `PurchaseReceipt.cancel` / REVERSAL OUT остаётся permissive (флаг отрицательного остатка и division-override на него не влияют) | `current-state.md` стр. ~342–343, 514–515, 1405–1409 |

---

## 2. Расход и возврат материалов (`MaterialIssue` / `MaterialIssueReturn`)

Первоисточник: `current-state.md` §1, блоки «Подключение расхода …»,
«Возврат / сторно проведённого `MaterialIssue`» (строки ~284–372,
1443–1503).

| # | Статус | Пункт | Почему отложено / где зафиксировано |
|---|--------|-------|--------------------------------------|
| 2.1 | DEFERRED | Прямая отмена POSTED `MaterialIssue` (POSTED → CANCELLED) | сторно вынесено в отдельный контур `MaterialIssueReturn`; cancel DRAFT движения не пишет, `current-state.md` стр. ~363–365 |
| 2.2 | TODO | Удаление и отмена `MaterialIssueReturn` | «удаление и отмена возврата НЕ реализованы», `current-state.md` стр. ~1501 |
| 2.3 | DEFERRED | Пересчёт `MaterialIssue.totalCost` по складской стоимости | документный `totalCost` остаётся финансовым snapshot’ом, складская оценка живёт в `StockMovement.totalCost`; `current-state.md` стр. ~357–362 |
| 2.4 | DEFERRED | Реверс «старых» приёмок (до итерации подключения склада) | cancel пропускает строки без исходного `IN` (защита истории); `current-state.md` стр. ~272–274 |

---

## 3. Давальческое сырьё / ownership материала

Первоисточник: `current-state.md` §1, блок «Давальческое сырьё
клиента» (строки ~1177–1239).

| # | Статус | Пункт | Почему отложено / где зафиксировано |
|---|--------|-------|--------------------------------------|
| 3.1 | DEFERRED | Полноценный ownership-контур: `CustomerMaterialReceipt`, `ownerClientId`, разделение `StockBalance` по владельцу материала | MVP — только флаг `Order.materialsAndHardwareCostPolicy = INCLUDE/EXCLUDE` (финансовое включение); `current-state.md` стр. ~1233–1239 |

---

## 4. Готовая продукция (`FinishedGoods*`)

Первоисточник: `current-state.md` §1, блоки «Foundation готовой
продукции», «Выпуск по операции», «Отгрузка», «Отмена/сторно
отгрузки», «Перемещение», «Корректировка готовой продукции» (строки
~606–1175).

| # | Статус | Пункт | Почему отложено / где зафиксировано |
|---|--------|-------|--------------------------------------|
| 4.1 | DEFERRED | Отдельный UI-раздел `/admin/finished-goods` + sidebar item + отдельный отчёт | по решению владельца ГП живёт во вкладках `/admin/warehouses`; `current-state.md` стр. ~710–715, 797–798, 841–843 |
| 4.2 | DEFERRED | Отдельные документные модели `FinishedGoodsTransfer` / `FinishedGoodsAdjustment` (сейчас только пары / одиночные `FinishedGoodsMovement`) | `current-state.md` стр. ~1040, 1088–1089, 1171 |
| 4.3 | DEFERRED | Cancel / partial-cancel transfer и adjustment ГП (компенсируется обратной операцией) | `current-state.md` стр. ~1087–1091, 1169–1174 |
| 4.4 | DEFERRED | History endpoint для transfer / adjustment ГП | `current-state.md` стр. ~1088, 1170 |
| 4.5 | DEFERRED | DRAFT-flow и частичная отмена отгрузки (`FinishedGoodsShipment` всегда POSTED; отмена только целиком) | `current-state.md` стр. ~920–924, 949–951, 996–1000 |
| 4.6 | DEFERRED | Авто-смена `Order.status` при полной отгрузке (сейчас вручную через `POST /orders/:id/complete`) | сознательное решение, `current-state.md` стр. ~885–888, 921–922 |
| 4.7 | DEFERRED | `unitCost` для ГП + флаг разрешения отрицательного остатка ГП | ГП в MVP без стоимости, всегда strict (минус запрещён); `current-state.md` стр. ~1129–1132, 1172–1173 |
| 4.8 | DEFERRED | FIFO / LIFO для готовой продукции | `current-state.md` стр. ~1081, 1089, 1171 |
| 4.9 | DEFERRED | Отдельная операция «Выпуск» (канонично — флаг `Operation.producesFinishedGoods` на «Упаковке») | `current-state.md` стр. ~738–740, 779–780 |

---

## 5. Тестовое покрытие и production-findings

Первоисточник: `docs/test-gap-plan.md` §2/§3, `docs/operations-test-findings.md`.

| # | Статус | Пункт | Где зафиксировано |
|---|--------|-------|-------------------|
| 5.1 | TODO | P1-1 `tests/integration/suppliers.test.ts` (CRUD + RBAC + delete-with-active-PO) | `test-gap-plan.md` §3, P1-1 |
| 5.2 | TODO | P1-2 `tests/integration/route-templates.test.ts` (`RouteTemplate` CRUD/порядок/RBAC) | `test-gap-plan.md` §3, P1-2 |
| 5.3 | TODO | P1-3 `tests/integration/cut-readiness.test.ts` (агрегация `qtyPlan/qtyCut/qtyRemaining`) | `test-gap-plan.md` §3, P1-3 |
| 5.4 | TODO | P1-4 `tests/integration/auth-login.test.ts` (login/PIN/cookie/`/auth/me`) | `test-gap-plan.md` §3, P1-4 |
| 5.5 | TODO | P1-5 расширить `role-rbac.test.ts` (master-actions + `POST /api/employees`) | `test-gap-plan.md` §3, P1-5 |
| 5.6 | **BUG** | CUTTER_ASSISTANT на `/orders/[id]/passports/new` дёргает admin-only `GET /api/employees` → 403 / server-side exception (P0-7, severity **high**) | `operations-test-findings.md` §таблица; characterization-smoke `tests/smoke/orders-passports-new-cutter-assistant.smoke.test.ts` пинит баг. Фикс: `@Get('cutters')` + `listActiveCutters()` + `ActiveCutterListItemDto` |
| 5.7 | TODO | P0-2 `PackingService.close` — добить идемпотентность/`OperationEntry` (partial) | `test-gap-plan.md` §2, P0-2 (⚠️ partial) |

---

## 6. Документация — PHASE 3

Первоисточник: `docs/index.md` (шапка PHASE 2 / PHASE 3).

| # | Статус | Пункт |
|---|--------|-------|
| 6.1 | TODO | Полное переписывание `flows.md` / `domain.md` / `screens.md` / `events.md` после ревизии master-actions / audit-events (часть `screens.md` помечена `OUTDATED`) |

---

## 7. Recon-планы внедрения подсистем

`docs/*-recon.md` — рабочие планы «как мягко встроить подсистему,
ничего не сломав». Часть уже реализована (см. `current-state.md`),
часть — план на будущее. Читать **по теме**, перед работой сверять с
кодом и `current-state.md`.

- [`docs/order-signal-sample-recon.md`](./order-signal-sample-recon.md) — сигнальный образец (свежий, 18.05)
- [`docs/production-cost-v2-recon.md`](./production-cost-v2-recon.md) — управленческий P&L v2
- [`docs/production-cost-salary-allocation-recon.md`](./production-cost-salary-allocation-recon.md) — распределение окладной части в v2 (идея, не реализовано)
- [`docs/employee-deletion-recon.md`](./employee-deletion-recon.md) — удаление сотрудников: архив + hard-delete (идея, не реализовано)
- [`docs/operation-time-norms-recon.md`](./operation-time-norms-recon.md) — нормы времени операций
- [`docs/workshop-needs-recon.md`](./workshop-needs-recon.md) — расчёт потребностей
- [`docs/passport-piecework-payroll-recon.md`](./passport-piecework-payroll-recon.md) — сдельный расчёт по паспорту
- [`docs/payroll-cutter-compensation-recon.md`](./payroll-cutter-compensation-recon.md) — компенсация раскройщику
- [`docs/cutter-assistant-passport-release-recon.md`](./cutter-assistant-passport-release-recon.md) — выпуск паспорта помощником раскройщика
- [`docs/recon-soft-integration.md`](./recon-soft-integration.md) — общий каркас мягкой интеграции
- [`docs/integration-full-run-recon.md`](./integration-full-run-recon.md) — сквозной прогон
- [`docs/operations-test-recon.md`](./operations-test-recon.md) — план тестов операций
- [`docs/prelaunch-cleanup-recon.md`](./prelaunch-cleanup-recon.md) · [`docs/design-cleanup-recon.md`](./design-cleanup-recon.md) · [`docs/auth-design-cleanup-recon.md`](./auth-design-cleanup-recon.md) — предзапусковые чистки
- [`docs/packing-close-ui-recon.md`](./packing-close-ui-recon.md) · [`docs/packing-open-boxes-recon.md`](./packing-open-boxes-recon.md) — упаковка
- [`docs/warehouse-bulk-print-modal-runtime-recon.md`](./warehouse-bulk-print-modal-runtime-recon.md) · [`docs/modal-positioning-recon.md`](./modal-positioning-recon.md) · [`docs/qr-regression-recon.md`](./qr-regression-recon.md) — UI / печать / QR
- [`docs/cutter-assistant-passport-release-recon.md`](./cutter-assistant-passport-release-recon.md), [`docs/recon/material-consumption-code-confirmation.md`](./recon/material-consumption-code-confirmation.md) — подтверждения кода

Чек-лист приёмки фактического расхода и foundation склада —
[`docs/material-consumption-rollout-checklist.md`](./material-consumption-rollout-checklist.md).
