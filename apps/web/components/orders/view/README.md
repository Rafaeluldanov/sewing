# Order management view ownership

Карточка заказа `/admin/orders/:id` собирается из шапки + action-центра +
семи тематических вкладок (Производство → Паспорта → План → Операции
→ Сводно по заказу → Потребности → История). Каждая зона отвечает
за свой слой данных, и дублирование запрещено: один и тот же
материал / операция / KPI не должны рендериться сразу в двух
местах. Единственное сознательное исключение — финансовая вкладка
«Сводно по заказу»: она видит материалы и операции как **строки
себестоимости**, а соседние вкладки — как **procurement state** или
**рабочий экран операций**. Это разные роли, не дубль.

Источники правды по слотам:

## Header — `view/order-management-header.tsx`

Owns order-level KPI и основные workflow-действия. Видна на всех
вкладках.

- статус заказа (бейдж, переходы);
- общий план / выпущено паспортов / упаковано / прогресс выпуска;
- срок (deadline-бейдж, «осталось N дн.»);
- workflow-actions (Перевести в расчёт, Запустить в производство,
  Завершить, Отменить, Пересчитать план, Редактировать, Выпустить
  паспорт).

В шапке нет таблиц, finance-метрик (выручка / маржа), нет списка
паспортов, нет size-breakdown.

## ActionCenter — `view/order-action-center.tsx`

Actionable warnings only — короткие алерты с глубокими ссылками в
нужную вкладку. Никаких таблиц / метрик / итогов.

## Production tab — `view/tabs/order-production-tab.tsx`

Production facts: KPI стадий, размерный breakdown, текущие stage
buckets из `/api/shopfloor/state`.

## Passports tab — `view/tabs/order-passports-tab.tsx`

Список паспортов + фильтры. Это единственная вкладка, где видны
паспорта.

## Plan tab — `view/tabs/order-plan-tab.tsx`

Immutable order plan и snapshot: продукт / лекало / цвет / план по
размерам / маршрут / привязка к техкарте.

## CostSummary tab / «Сводно по заказу» — `tabs/order-summary-tab.tsx`

Owns the **full financial summary** заказа — единственная вкладка,
где менеджер видит финансовую картину тиража одной таблицей и одним
KPI-блоком. id вкладки — `costSummary` (не `summary`), чтобы явно
отделить новую финансовую вкладку от старого generic-summary,
который раньше создавал путаницу.

- Owns the full financial summary заказа.
- Owns itemized cost breakdown — одна таблица с колонками Раздел /
  Статья / Кол-во / Ед. / Цена / Сумма за тираж / За 1 изделие /
  Доля / Комментарий.
- May render материалы как cost rows (это сознательно допускается
  именно здесь — другая роль, другая колоночная модель, другой
  владелец данных, чем у Needs).
- May render операции как cost rows.
- May render выручку, прибыль, маржу, маржинальность.
- Uses `OrderSummaryTab` (`apps/web/components/orders/tabs/order-summary-tab.tsx`)
  как тонкий wrapper над `OrderSummaryUnifiedTable`
  (`apps/web/components/orders/summary/order-summary-unified-table.tsx`).
- Использует pure helpers `buildOrderSummaryRows` /
  `computeOrderSummaryTotals` + переиспользует
  `buildOrderMaterialRows` / `buildOrderOperationRows` — не
  дублирует backend и не добавляет новых API-эндпоинтов.

CostSummary tab — единственное место в карточке, где разрешён
`OrderSummaryUnifiedTable`. В Needs (см. ниже) он по-прежнему
запрещён.

## Needs tab — `view/tabs/order-needs-tab.tsx`

Owns material requirements + procurement state + receipts +
outsource + **aggregate-only** cost totals.

- Canonical material table — `OrderMaterialsUnifiedTable` (роль /
  описание / чистая / к закупке / цена / сумма / принято / в ячейках /
  статус / поставщик / комментарий). Это единственный UI-владелец
  конкретных материалов на этой вкладке.
- Manual unblock — `ManualMaterialArrivalActions`.
- Outsource — `OrderOutsourceList`.
- Aggregate cost totals — `OrderPlannedCostSummaryCard` (материалы /
  фурнитура / нанесение / операции / итого + «за 1 изделие»).
  Это **aggregate-only**: не рендерит названия конкретных материалов
  или операций и не использует `buildOrderMaterialRows` /
  `buildOrderOperationRows` / `buildOrderSummaryRows` для рендера
  строк.

### Forbidden in Needs

- `OrderSummaryUnifiedTable` (или его потенциальные ребрендинги
  `OrderItemizedCostBreakdownTable` / `OrderCostBreakdownTable` /
  `OrderItemizedCostTable`) — это полный itemized cost breakdown
  с per-material и per-operation строками. Подключение в Needs
  даёт двойной показ материалов рядом с
  `OrderMaterialsUnifiedTable`. Никакой `hideKpiBar` / `hideRows` /
  `needsMode` флаг это правило не отменяет — компонент
  концептуально принадлежит CostSummary tab.
- Любой второй блок с конкретными материалами заказа.
- Любой второй блок с операциями как cost breakdown.
- Полный построчный itemized cost-табель (Раздел / Статья / Кол-во /
  Цена / Сумма за тираж / Доля).
- Финансовая выручка / маржа / маржинальность — это CostSummary
  tab (или Header KPI, если когда-нибудь туда переедут), но не
  Needs.

### Where the full itemized cost breakdown lives

Полная построчная себестоимость (`OrderSummaryUnifiedTable`)
живёт во вкладке **«Сводно по заказу»** (`costSummary`):
`apps/web/components/orders/tabs/order-summary-tab.tsx` →
`apps/web/components/orders/summary/order-summary-unified-table.tsx`.
Это единственное место в `/admin/orders/:id`, где этот компонент
маунтится. Если в будущем понадобится отдельный deep-dive route
(`/admin/orders/:id/cost`), он переиспользует тот же компонент.

Регрессионный тест против возврата дубля —
`tests/smoke/admin-order-needs-no-duplication.smoke.test.ts`.

## History tab — `view/tabs/order-history-tab.tsx`

Audit / history only; пока пустая вкладка с TODO-комментарием —
будет наполнена, когда появится публичное audit-log API.
