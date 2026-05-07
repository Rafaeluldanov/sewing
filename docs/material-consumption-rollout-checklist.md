# Material Consumption / Stock Rollout Checklist

> Назначение: единый rollout/checklist-документ для владельца проекта и
> разработчиков по итерации «Фактический расход материалов + foundation
> складского учёта». Документ описывает, что уже внедрено, как это
> проверять руками, какие флаги управляют поведением и что осознанно
> вынесено за рамки MVP.
>
> Источник истины кода — код. Этот документ даёт карту и сценарии
> приёмки. При расхождении с кодом — верим коду.

---

## 1. Что внедрено

Перечень функциональности, которая уже доступна в системе:

- **`MaterialIssue` / `MaterialIssueLine`** — доменные сущности для
  документа фактического расхода материалов по заказу (заголовок +
  строки), статусы `DRAFT` / `POSTED` / `CANCELLED`.
- **Ручной расход материалов** — менеджер заказа может создать
  `MaterialIssue`, добавить строки, провести (`DRAFT → POSTED`) или
  отменить.
- **Автосписание при выдаче кроя** — при `issueToEmployee` (выдача
  кроя сотруднику) и включённом флаге `autoIssueMaterialsOnCutRelease`
  создаётся автоматический POSTED `MaterialIssue` с
  `source = AUTO_CUT_ISSUE`. Расход распределяется пропорционально
  доле паспорта в общем количестве изделий заказа.
- **План / факт материалов в заказе** — во вкладке «Потребности»
  карточки заказа в `OrderMaterialsUnifiedTable` рядом с плановой
  потребностью показан факт по POSTED `MaterialIssueLine` с тем же
  `workshopNeedId` и дельта.
- **Фактическая стоимость материалов в сводке заказа** — во вкладке
  «Сводно по заказу» (`OrderSummaryUnifiedTable`) добавлены строки
  «Материалы за тираж · факт» и «Материалы за тираж · Δ
  (факт − план)».
- **Material cost в production cost** — `CostsService.getProductionCost`
  включает `materialCost` в дневную и итоговую сумму
  (`totalCost = pieceworkCost + salaryCost + materialCost`) по
  POSTED `MaterialIssue` с привязкой к паспорту.
- **`StockBalance` / `StockMovement`** — foundation складского учёта:
  таблица текущих остатков (по `workshopNeedId` + `unit` +
  опционально `warehouseId` / `cellId`, уникальность через
  `balanceKey`) и журнал движений.
- **`PurchaseReceipt → StockMovement IN`** — при создании POSTED
  приёмки в той же транзакции пишется входящее движение
  (`type = PURCHASE_RECEIPT`, `direction = IN`), `StockBalance.qty`
  увеличивается, средняя себестоимость пересчитывается.
- **`PurchaseReceipt cancel → REVERSAL OUT`** — при отмене приёмки
  пишется сторнирующее OUT-движение
  (`type = REVERSAL`,
  `sourceKey = PURCHASE_RECEIPT_LINE_CANCEL:<lineId>`),
  `StockBalance.qty` уменьшается. Старые приёмки без исходного IN
  сознательно не реверсятся.
- **`MaterialIssue → StockMovement OUT`** — при `MaterialIssue.post`
  (ручной) и `AUTO_CUT_ISSUE` пишется исходящее движение
  (`type = MATERIAL_ISSUE`, `direction = OUT`), `StockBalance.qty`
  уменьшается.
- **Read-only Stock API** — публичные эндпоинты
  `GET /api/stock/balances` и `GET /api/stock/movements` (RBAC:
  `ADMIN` / `SHOP_MANAGER`), с фильтрами и пагинацией. Записи делает
  только бизнес-flow (приёмка / расход), внешних мутаций нет.
- **UI «Остатки» / «Движения» в разделе «Склады»** — в существующем
  `/admin/warehouses` появились read-only вкладки `?tab=balances` и
  `?tab=movements` (отдельной страницы `/admin/stock` и нового
  пункта меню сознательно нет).
- **UI флагов в «Настройки компании → Материалы и склад»** — в
  `/admin/company-settings` появился блок с двумя переключателями:
  «Автосписание материалов при выдаче кроя» и «Разрешить
  отрицательные остатки материалов».

---

## 2. Основная бизнес-логика

### Ручной расход

```
Заказ
  → вкладка «Потребности»
    → действие «Создать расход»
      → MaterialIssue (DRAFT)
        → действие «Провести»
          → MaterialIssue (POSTED)
            → StockMovement (OUT, MATERIAL_ISSUE)
              → StockBalance.qty уменьшается
```

POSTED-документ участвует в плане/факте по `WorkshopNeed`, в сводке
заказа и (при наличии `passportId`) в `materialCost` production cost
по периоду.

### Автосписание

```
PassportsService.issueToEmployee(passportId, employeeId)
  → флаг autoIssueMaterialsOnCutRelease = true
    → MaterialIssuesService.createAutoCutIssueForPassport
      → MaterialIssue (POSTED, source = AUTO_CUT_ISSUE,
                       sourceKey = AUTO_CUT_ISSUE:<passportId>)
        → StockMovement (OUT, MATERIAL_ISSUE,
                          comment = «Автоматическое списание
                                      при выдаче кроя»)
          → StockBalance.qty уменьшается
            → план / факт обновляется автоматически
              → сводка заказа подхватывает totalCost
                → production cost (per-day) включает materialCost
```

Идемпотентность гарантируется UNIQUE-индексом
`MaterialIssue.sourceKey` и предохранителем «не создавать авто, если
уже есть неотменённый MaterialIssue по этому паспорту».

### Приёмка

```
PurchaseOrder
  → POST /api/purchase-receipts/from-purchase-order
    → PurchaseReceipt (POSTED)
      → StockMovement (IN, PURCHASE_RECEIPT,
                        sourceKey = PURCHASE_RECEIPT_LINE:<lineId>)
        → StockBalance.qty увеличивается
          → средняя себестоимость пересчитывается
```

### Отмена приёмки

```
POST /api/purchase-receipts/:id/cancel
  → для каждой строки с существующим IN
    → StockMovement (OUT, REVERSAL,
                      sourceKey = PURCHASE_RECEIPT_LINE_CANCEL:<lineId>,
                      comment = «Отмена приёмки»)
      → StockBalance.qty уменьшается
```

Строки без исходного IN (исторические приёмки до итерации) сознательно
пропускаются — без падения cancel.

---

## 3. Флаги CompanySettings

Оба флага живут в `CompanySettings` (singleton-row). Это
**глобальные значения по умолчанию** для компании. Начиная с
итерации «division overrides» горячий бизнес-flow
(`PassportsService.issueToEmployee`, `MaterialIssuesService.post` /
`createAutoCutIssueForPassport`, `StockService.createAdjustment`
для `OUT`) читает не эти флаги напрямую, а **эффективную политику
по заказу** через
`CompanySettingsService.getEffectiveMaterialStockSettingsForOrder(orderId)`
(или `-InTx`). Резолвер идёт по цепочке
`Order → Order.companyDivisionId → CompanyDivision.<override>`
и применяет приоритет:

```
division.<override> ?? companySettings.<флаг> ?? hard-coded default
```

То есть:

- `null` у `CompanyDivision.<override>` (default у всех подразделений
  после миграции, в т.ч. базовых `MARKETPLACE` / `OTHER`) → работает
  глобальный `CompanySettings.<флаг>`;
- `true` / `false` у override → перебивают глобальный флаг только
  для заказов этого подразделения;
- если у заказа нет `companyDivisionId` (старые заказы до
  `link_company_divisions_to_orders`, FK `onDelete: SetNull`) —
  используется глобальный `CompanySettings.<флаг>` без override.

Глобальные два переключателя по-прежнему живут в
`/admin/company-settings` → блок «Материалы и склад». Override-ы
редактируются на том же экране в подразделе «Настройки по
подразделениям» — отдельной страницы, нового route-а и пункта
sidebar сознательно **нет** (см. §8 границ MVP и
`docs/current-state.md §«Материалы и склад — division overrides»`).

> **Пример B2B-подразделения.** На `/admin/company-settings`:
> - глобальный блок «Материалы и склад» можно оставить в любом
>   состоянии (например, автосписание `false`, минус `true`);
> - в «Настройки по подразделениям» для B2B (условно
>   `CompanyDivision(code='OTHER')`) выставить:
>   - «Автосписание при выдаче кроя» → «Включено»
>     (`autoIssueMaterialsOnCutReleaseOverride = true`);
>   - «Отрицательные остатки» → «Запрещены»
>     (`allowNegativeMaterialStockOverride = false`).
>
> Тогда заказы B2B-подразделения автоматически списывают крой и
> блокируются при недостатке материала, а заказы всех остальных
> подразделений продолжают работать по глобальным настройкам
> компании.

`PurchaseReceipt` / `PurchaseReceipt cancel` (REVERSAL OUT)
сознательно **остаются permissive** и от division-override-ов не
зависят — это закрывает сценарий «задним числом оформить приход,
который уже был расходован».

### `autoIssueMaterialsOnCutRelease`

- **Default:** `false`.
- **`false`** → выдача кроя (`POST /api/passports/:id/issue`) **не**
  создаёт `MaterialIssue`. Работают только события паспорта,
  `currentEmployee` и `CutReleasePolicy` / `OrderCutIssueRule`.
- **`true`** → выдача кроя в той же транзакции создаёт POSTED
  `MaterialIssue` с `source = AUTO_CUT_ISSUE` и пишет OUT в склад.
- **Где управлять:** `/admin/company-settings`, блок «Материалы и
  склад», переключатель «Автосписание материалов при выдаче кроя».
- **Default `false` сознательный:** после миграции production
  поведение не меняется само — владелец проекта включает явно.

### `allowNegativeMaterialStock`

- **Default:** `true`.
- **`true`** → `MaterialIssue.post` и `AUTO_CUT_ISSUE` пишут OUT
  даже при нехватке материала. `StockBalance.qty` может уйти в
  минус; при отсутствии положительного баланса создаётся
  no-location negative balance.
- **`false`** → перед записью OUT `StockService.recordMaterialIssueInTx`
  проверяет достаточность остатка. При недостатке — 409
  `MATERIAL_STOCK_INSUFFICIENT`, вся транзакция откатывается:
  `MaterialIssue` остаётся `DRAFT`, OUT не пишется, `StockBalance`
  не меняется.
- **`false` + `autoIssueMaterialsOnCutRelease = true`** → выдача кроя
  может быть **заблокирована** недостатком материала: тогда
  откатывается и сама `issueToEmployee` (`Passport` не переходит в
  `IN_PROGRESS`, `PassportEvent ISSUED_TO_EMPLOYEE` не пишется).
- **Применяется только к OUT-движениям `MaterialIssue`.**
  `PurchaseReceipt` cancel / REVERSAL OUT остаётся permissive.
- **Где управлять:** `/admin/company-settings`, блок «Материалы и
  склад», переключатель «Разрешить отрицательные остатки
  материалов».

---

## 4. Как проверить руками

### 4.1 Проверка ручного расхода

1. Открыть карточку заказа `/admin/orders/[id]`.
2. Перейти во вкладку «Потребности».
3. Нажать «Создать расход» в блоке «Фактический расход материалов».
4. Убедиться, что новый `MaterialIssue` имеет статус **DRAFT**.
5. Нажать «Провести».
6. Убедиться, что статус сменился на **POSTED**.
7. В таблице `OrderMaterialsUnifiedTable` (та же вкладка) проверить,
   что в строке соответствующего `WorkshopNeed` появилось значение
   «факт» в колонках «План / факт» и «Стоимость план / факт».
8. Перейти во вкладку «Сводно по заказу» — убедиться, что строки
   «Материалы за тираж · факт» и «Δ (факт − план)» обновились.
9. Открыть `/admin/warehouses?tab=movements` — убедиться, что
   появилась запись `MATERIAL_ISSUE` / OUT с правильным заказом и
   материалом.
10. Открыть `/admin/warehouses?tab=balances` — убедиться, что
    `StockBalance.qty` по этому материалу уменьшился (или ушёл в
    минус, если разрешено).

### 4.2 Проверка приёмки

1. Создать или открыть `PurchaseOrder`.
2. Создать `PurchaseReceipt` через
   `POST /api/purchase-receipts/from-purchase-order` (или через
   соответствующий UI-флоу).
3. На `/admin/warehouses?tab=movements` убедиться, что появилось
   IN-движение `PURCHASE_RECEIPT`.
4. На `/admin/warehouses?tab=balances` убедиться, что
   `StockBalance.qty` увеличился, средняя себестоимость
   пересчиталась.
5. Отменить приёмку (`POST /api/purchase-receipts/:id/cancel`).
6. На вкладке «Движения» убедиться, что появилось сторнирующее
   OUT-движение `REVERSAL` с комментарием «Отмена приёмки», и
   `StockBalance.qty` уменьшился обратно.

### 4.3 Проверка автосписания

1. На `/admin/company-settings` включить
   `autoIssueMaterialsOnCutRelease`.
2. Выдать крой сотруднику (`POST /api/passports/:id/issue` или
   соответствующий UI).
3. Открыть карточку заказа → вкладка «Потребности» → блок
   «Фактический расход материалов»: должен появиться POSTED
   `MaterialIssue` с пометкой `AUTO_CUT_ISSUE`.
4. На `/admin/warehouses?tab=movements` найти OUT-движение
   `MATERIAL_ISSUE` с комментарием «Автоматическое списание при
   выдаче кроя».
5. На `/admin/warehouses?tab=balances` убедиться, что
   `StockBalance.qty` уменьшился.
6. На вкладке «Потребности» убедиться, что план / факт обновился; в
   `/production-cost` (или в response `GET /api/costs/production`)
   на день упаковки паспорта `materialCost` включает этот документ.

### 4.4 Проверка запрета отрицательных остатков

1. На `/admin/company-settings` установить
   `allowNegativeMaterialStock = false`.
2. Попробовать провести `MaterialIssue` (ручной POST на
   `POST /api/material-issues/:id/post`) для материала, по которому
   текущий положительный `StockBalance.qty` меньше суммарного
   `issuedQty`.
3. Ожидать ответ **409 `MATERIAL_STOCK_INSUFFICIENT`**.
4. Убедиться, что `MaterialIssue` остался в статусе **DRAFT**.
5. На `/admin/warehouses?tab=movements` убедиться, что
   `StockMovement` для этого документа **не создан**.
6. На `/admin/warehouses?tab=balances` убедиться, что
   `StockBalance.qty` **не изменился**.

### 4.5 Проверка корректировки остатка

1. На `/admin/warehouses?tab=balances` нажать кнопку «Корректировка».
2. **IN-сценарий**: выбрать остаток, выбрать «Приход (увеличить)»,
   ввести `qty > 0`, при необходимости указать цену, заполнить
   комментарий, сохранить. Убедиться:
   - вкладка «Остатки» обновилась — `StockBalance.qty` увеличился;
   - вкладка «Движения» содержит новую запись типа «Корректировка»,
     направление «Приход», `Кол-во` равно введённому, `Комментарий` —
     введённой причине;
   - повторный submit с тем же `clientRequestId` (защита от двойного
     клика) НЕ создаёт второй `StockMovement`.
3. **OUT-сценарий**: выбрать остаток с положительным `qty`, выбрать
   «Расход (уменьшить)», ввести `qty > 0` (поле «Цена» становится
   неактивным с подсказкой «Для расходной корректировки используется
   текущая складская цена остатка»), сохранить. Убедиться:
   - `StockBalance.qty` уменьшился;
   - в журнале движений запись типа «Корректировка», направление
     «Расход», `Цена` совпадает с текущей `StockBalance.unitCost`
     до корректировки.
4. **Запрет минуса**: при `allowNegativeMaterialStock = false`
   попытаться сделать OUT-корректировку, превышающую остаток —
   ожидать понятный текст ошибки `MATERIAL_STOCK_INSUFFICIENT`,
   `StockBalance.qty` НЕ изменился, нового движения в журнале нет.
5. Убедиться, что отдельной страницы `/admin/stock` /
   `/admin/stock-adjustments` нет, в sidebar новых пунктов не
   появилось.

### 4.5b Проверка перемещения остатка между складами

1. На `/admin/warehouses?tab=balances` нажать кнопку «Переместить».
2. Выбрать исходный остаток с положительным `qty`, выбрать склад
   назначения (отличный от source), при необходимости выбрать
   ячейку назначения из появившегося select-а «Ячейка назначения»
   (или оставить «Без ячейки»), ввести `qty > 0` (не больше
   текущего остатка), заполнить комментарий, сохранить.
   - При смене склада ранее выбранная ячейка сбрасывается на «Без
     ячейки» (если она не принадлежит новому складу);
   - если в выбранном складе нет ячеек — selectbox задисейблен с
     подсказкой «Нет ячеек на этом складе»;
   - preview-блок «Куда: Склад / Ячейка» под формой обновляется
     при каждом изменении.
3. Убедиться:
   - вкладка «Остатки» обновилась — у источника `qty` уменьшился
     ровно на `qty` перемещения; у назначения появился (или
     увеличился) `StockBalance` с тем же `workshopNeedId`,
     `description`, `materialRole`, `unit` и `unitCost` =
     `source.unitCost`;
   - вкладка «Движения» содержит **две** новые записи типа
     «Перемещение» (`type = TRANSFER`):
     - «Расход» (`direction = OUT`) на исходной локации;
     - «Приход» (`direction = IN`) на целевой локации;
   - повторный submit с тем же `clientRequestId` (защита от
     двойного клика) НЕ создаёт новую пару — backend возвращает
     существующую.
4. **Strict-режим**: попробовать переместить количество, превышающее
   `source.qty`, — ожидать понятный текст ошибки
   `MATERIAL_STOCK_INSUFFICIENT`, балансы НЕ изменились, новых
   движений в журнале нет, **независимо** от
   `CompanySettings.allowNegativeMaterialStock` (transfer всегда
   strict).
5. **Same-location гейт**: попробовать переместить в ту же
   локацию (тот же `warehouseId` + `cellId`) — ожидать ошибку
   `STOCK_TRANSFER_SAME_LOCATION`.
6. Убедиться:
   - `MaterialIssue.totalCost` / order summary / план-факт /
     production cost по заказу источника **не изменились** —
     transfer живёт строго в плоскости склада;
   - отдельной страницы `/admin/stock-transfer[s]` нет, в sidebar
     новых пунктов не появилось.

### 4.5c Проверка фильтров склада

UI-фильтры живут в существующем разделе `/admin/warehouses` и
работают через `searchParams` — backend не меняли. См.
`docs/current-state.md §«Фильтры склада»`.

1. **Остатки → отрицательные через фильтр**:
   - открыть `/admin/warehouses?tab=balances`;
   - в селекте «Остаток» выбрать «Отрицательные», нажать
     «Применить»;
   - убедиться, что URL стал `?tab=balances&stockState=negative`,
     в таблице остались только остатки с `qty < 0` (либо empty
     state «Остатки материалов пока не сформированы»);
   - нажать «Сбросить» — URL `?tab=balances`, фильтр снят.
2. **Остатки → фильтр по складу**:
   - выбрать конкретный склад в селекте «Склад» + поиск по
     названию материала, применить;
   - убедиться, что pagination сохраняет `q` / `warehouseId` /
     `stockState` при переходе «Назад» / «Вперёд»;
   - применение фильтра сбрасывает pagination на первую страницу
     (`offset` не переносится из URL в форму).
3. **Движения → TRANSFER через фильтр type**:
   - открыть `/admin/warehouses?tab=movements`;
   - в селекте «Тип движения» выбрать «Перемещение», применить;
   - убедиться, что URL стал
     `?tab=movements&type=TRANSFER&limit=…`, в таблице — только
     движения `type = TRANSFER` (по два на каждый transfer:
     OUT + IN).
4. **Движения → за период**:
   - заполнить «Период с» / «Период по» (`<input type="date">`);
   - убедиться, что URL содержит `from=YYYY-MM-DD&to=YYYY-MM-DD`,
     в таблице — только движения с `createdAt` в указанном
     диапазоне (включительно).
5. **Движения → направление**:
   - выбрать «Приход» (`IN`) или «Расход» (`OUT`), применить;
   - убедиться, что в таблице остались только движения с
     соответствующим `direction`.
6. **Сохранение фильтров на pagination**:
   - применить любой комбинированный фильтр на любой вкладке;
   - перейти «Вперёд» через `<StockPagination>`;
   - убедиться, что все фильтры (`q`, `warehouseId`, `stockState`,
     `type`, `direction`, `from`, `to`) остались в URL и в форме.
7. **Кнопки «Корректировка» / «Переместить» / «Добавить»**:
   - на вкладке «Остатки» при любом фильтре кнопки «Корректировка»
     и «Переместить» остаются над таблицей (если есть items);
   - кнопка «Добавить» (склад) в header осталась на всех вкладках;
   - отдельной страницы `/admin/stock` / `/admin/stock-filters`
     нет, в sidebar новых пунктов не появилось.

### 4.5d Проверка склада выпуска готовой продукции в заказе

1. Открыть `/admin/orders/new`. В блоке «Основное» появилось поле
   «Склад выпуска готовой продукции» с подсказкой «Склад, на
   который должна поступить готовая продукция после производства /
   упаковки. Это не склад материалов».
2. Создать заказ со выбранным складом. Открыть карточку заказа —
   в `OrderManagementHeader` отображается поле «Склад готовой
   продукции» с именем (и кодом, если задан).
3. Открыть `/admin/orders/[id]/edit`. Поле допускает выбор
   «— не выбран —» (сбросить FK), любого активного склада или
   текущего архивного (опция помечена `— архив`, чтобы submit без
   явного действия не обнулил привязку).
4. **Backend-проверка**:
   - PATCH с `finishedGoodsWarehouseId = "id-несуществующего-склада"`
     → 400 `WAREHOUSE_NOT_FOUND`;
   - PATCH с `id` склада, у которого `isActive = false` → 409
     `WAREHOUSE_INACTIVE`;
   - PATCH с `null` снимает привязку.
5. **Не склад материалов**: убедиться, что после смены
   `finishedGoodsWarehouseId`:
   - `StockBalance` / `StockMovement` НЕ изменились;
   - `MaterialIssue` / `MaterialIssueReturn` НЕ создались;
   - `OrderCostEstimate` / план операций / `WorkshopNeed` НЕ
     пересчитались.
6. Убедиться, что отдельной страницы `/admin/finished-goods` нет,
   в sidebar новых пунктов не появилось.

> **Контуры**: «склад материалов» (`StockBalance` / `StockMovement` —
> `/admin/warehouses?tab=balances|movements`) и «склад выпуска
> готовой продукции» (`Order.finishedGoodsWarehouseId` — поле в
> карточке заказа) — это разные контуры. Изменение поля заказа НЕ
> создаёт ни IN, ни OUT, ни TRANSFER в `StockMovement`. Готовая
> продукция как stock-сущность (`FinishedGoodsBalance` /
> `FinishedGoodsMovement`) на этой итерации сознательно не
> реализована.

### 4.5e Проверка «Давальческое сырьё / фурнитура клиента» (упрощённый MVP)

Упрощённый MVP: на заказе появилась политика
`Order.materialsAndHardwareCostPolicy = INCLUDE | EXCLUDE` (см.
`prisma/schema.prisma`, `docs/current-state.md §«Давальческое сырьё
клиента»`). Отдельный ownership-контур, `CustomerMaterialReceipt`,
ownership-поля, `MaterialStockLot`, master `Material` и FIFO / LIFO
**не реализуются** в этой итерации.

1. Открыть `/admin/orders/new`. В блоке «Основное» рядом со «Склад
   выпуска готовой продукции» появилось поле «Учет материалов и
   фурнитуры в себестоимости» с двумя вариантами:
   - **«Учитывать материалы и фурнитуру»** (default);
   - **«Не учитывать — давальческое сырьё / фурнитура клиента»**.
2. Создать заказ с **«Не учитывать»**. Прогнать flow:
   1) расчёт потребности (`POST /api/orders/:id/start-calculation`);
   2) проверить, что `WorkshopNeed[]` собран — потребность по
      количеству материалов и фурнитуры есть, snapshot
      `OrderMaterialRequirement[]` фиксируется как раньше;
   3) создать и провести `MaterialIssue` (`POST /api/material-issues`
      → `/post`) с `workshopNeedId` и `unit`;
   4) проверить, что `StockBalance.qty` уменьшился, `StockMovement`
      OUT появился, документ `POSTED` — складские движения работают
      без изменений;
   5) в карточке заказа во вкладке «Потребности»
      (`OrderMaterialsUnifiedTable`) колонки «Сумма» и «Стоимость
      план / факт» по строкам MATERIAL / HARDWARE показывают
      «не учитывается»; план/факт по количеству и Δ остаются;
   6) во вкладке «Сводно по заказу» в order-level warnings есть
      «Материалы и фурнитура не учитываются в себестоимости»;
      `materialActualCostRub` = 0, `byKind.material` = 0/null,
      строки MATERIAL / HARDWARE в таблице с totalDisplay
      «не учитывается»;
   7) `OrderCostEstimatesService.completeCalculation` — `totalCostRub`
      собирается без MATERIAL / HARDWARE строк (APPLICATION
      сохраняется);
   8) `GET /api/costs/production-cost` за период с упакованными
      паспортами этого заказа — `materialCost` для этих паспортов
      = 0, `pieceworkCost` / `salaryCost` остаются как раньше.
3. Создать заказ с **«Учитывать»** (default). Тот же flow — старая
   логика без изменений: материалы и фурнитура входят в
   `OrderCostEstimate.totalCostRub` и в production cost.
4. PATCH `materialsAndHardwareCostPolicy` на любом статусе заказа
   разрешён (управленческое поле, без `ORDER_LOCKED`-guard).
   Невалидное значение → 400
   `ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_INVALID`. `null` /
   пустая строка трактуется как `INCLUDE`.
5. Убедиться, что **не появилось**: отдельной страницы под
   давальческое сырьё (`/admin/given-materials`,
   `/admin/customer-materials`), новых пунктов в sidebar, новых
   ролей, отдельных моделей `CustomerMaterialReceipt`,
   `MaterialStockLot`, master `Material`, ownership-полей
   (`ownerClientId`).

> **Контуры**: «складское списание / расход» (`MaterialIssue` +
> `StockMovement` + `StockBalance`) и «учёт в себестоимости»
> (`OrderCostEstimate.totalCostRub`,
> `CostsService.materialCost`) — два разных контура. Поле
> `materialsAndHardwareCostPolicy` управляет **только финансовым**
> контуром: складские движения и расчёт потребности продолжают
> работать.

### 4.6 Проверка сторно `MaterialIssue`

1. Подготовить POSTED-документ расхода — например, через сценарий
   §4.1 (создать `DRAFT`, потом провести). Запомнить `MaterialIssue.id`,
   `totalCost`, `cellId` строк. Убедиться, что `StockBalance.qty`
   уменьшился ровно на сумму `Σ issuedQty`.
2. Открыть карточку заказа (`/admin/orders/[id]?tab=needs`) → блок
   «Фактический расход материалов» → строка проведённого
   документа. Должна появиться кнопка «Сторнировать»; для
   `returnStatus = NONE` — обычный лейбл, для `PARTIAL` —
   «Сторнировать остаток».
3. Нажать «Сторнировать». В открывшейся форме:
   - проверить warning «Будет возвращено всё оставшееся
     количество по документу»;
   - убедиться, что preview-таблица показывает `description`,
     `issuedQty`, `returnedQty`, `remainingQty (netIssuedQty)` и
     `unit` для каждой строки с `netIssuedQty > 0`;
   - ввести причину возврата (`reason`, ≥ 2 символов), сабмит.
4. Убедиться:
   - блок «Фактический расход материалов» обновился; у документа
     `returnStatus = FULL`, кнопка «Сторнировать» исчезла,
     показывается «Сторнирован»;
   - на вкладке «Склады» → «Движения» появилась запись типа
     «Сторно» (`type = REVERSAL`, `direction = IN`),
     `cellId`/`warehouseId` совпадают с исходным OUT;
   - на вкладке «Склады» → «Остатки» `StockBalance.qty`
     увеличился ровно на возвращённое количество;
   - финансовая сводка заказа (вкладка «Себестоимость») показывает
     `materialActualCost = totalCost − returnedTotalCost` (нетто);
   - план/факт в `OrderMaterialsUnifiedTable` тоже использует
     нетто-`issuedQty` (план не изменился, факт уменьшился до 0
     для полностью возвращённой строки);
   - для production cost (`/api/costs/production`) день упаковки
     паспорта вычитает возврат из `materialCost`.
5. Повторный submit с тем же `clientRequestId` (двойной клик /
   refresh формы): UI получит `200 OK` с тем же `MaterialIssueReturn.id`
   — нового движения и нового audit-события нет
   (`MaterialIssueReturn.sourceKey` UNIQUE).
6. Попытка сторнировать DRAFT-документ — ожидать `409
   MATERIAL_ISSUE_RETURN_ONLY_POSTED`. Попытка сторнировать
   уже полностью возвращённый POSTED с НОВЫМ `clientRequestId` —
   `409 MATERIAL_ISSUE_ALREADY_RETURNED`.
7. Убедиться, что отдельной страницы `/admin/material-issue-returns`
   нет, нового пункта меню не появилось.

### 4.7 Проверка частичного возврата `MaterialIssue`

1. Подготовить POSTED-документ расхода с двумя строками — например,
   через сценарий §4.1: списано «Футер 100 м» и «Рибана 20 м» из
   ячейки A1.
2. Открыть карточку заказа (`/admin/orders/[id]?tab=needs`) → блок
   «Фактический расход материалов» → нажать «Сторнировать» по
   нужному документу. В форме появятся:
   - input «Вернуть» по каждой строке (плейсхолдер `0`);
   - колонки «Списано», «Возвращено», «Доступно», «Ед.»;
   - кнопка «Заполнить всё доступное» сверху.
3. **Сценарий A — частичный возврат с разной qty по строкам:**
   - в строку «Футер» ввести `15`, «Рибана» оставить пустой
     (= `0`, отправлять не будет);
   - submit включается, как только ≥ 1 строка с qty > 0;
   - указать причину возврата, сохранить.
4. Убедиться:
   - вкладка «Склады» → «Движения»: одна запись «Сторно» (`type =
     REVERSAL`, `direction = IN`) с `qty = 15` для Футера, для
     Рибаны движения нет;
   - вкладка «Склады» → «Остатки»: Футер вырос на 15, Рибана не
     изменилась;
   - блок «Фактический расход материалов»: `returnStatus = PARTIAL`,
     лейбл кнопки сменился на «Сторнировать остаток»;
   - финансовая сводка заказа: `materialActualCost` уменьшился ровно
     на `15 × unitCost(Футер)`;
   - `OrderMaterialsUnifiedTable`: факт по Футеру = `100 − 15 = 85`,
     по Рибане = 20.
5. **Сценарий B — догнать остаток вторым вызовом:**
   - снова открыть форму «Сторнировать остаток»;
   - input по Футеру предзаполнен `0` / пуст (предыдущие qty не
     запоминаются на UI, это нормально), input по Рибане — `20`;
   - можно нажать «Заполнить всё доступное» — proставит максимумы
     (Футер = 85, Рибана = 20);
   - сохранить → `returnStatus = FULL`, кнопка пропала, появилось
     «Сторнирован».
6. **Ошибки:**
   - попытка ввести по Футеру qty `200` — UI красит input, под
     полем подсказка «Не больше 100», submit заблокирован;
   - программный POST с `returnedQty = 200` (например через curl) —
     `409 MATERIAL_ISSUE_RETURN_QTY_EXCEEDS_AVAILABLE` с
     `details = { materialIssueLineId, requestedQty, availableQty }`,
     движений / документов возврата не создаётся;
   - дубль `materialIssueLineId` в `lines[]` —
     `409 MATERIAL_ISSUE_RETURN_DUPLICATE_LINE`;
   - чужой `materialIssueLineId` (от другого `MaterialIssue`) —
     `409 MATERIAL_ISSUE_RETURN_LINE_NOT_FOUND`;
   - все qty = 0 на стороне UI — submit не отправляется
     (предупреждение «Укажите количество к возврату хотя бы по одной
     строке»);
   - пустой массив `lines` через программный POST —
     `409 MATERIAL_ISSUE_NOTHING_TO_RETURN`.
7. **Идемпотентность:** двойной submit с тем же `clientRequestId`
   возвращает один и тот же `MaterialIssueReturn.id`, второго
   движения склада нет, баланс не меняется второй раз.
8. **Production cost:** `/api/costs/production` за период,
   включающий день упаковки паспорта, использует
   `materialCost = Σ MaterialIssue.totalCost − Σ
   MaterialIssueReturn.totalCost` — частичный возврат уменьшает
   `materialCost` ровно на `Σ returnedQty × unitCost`.

---

## 5. API для проверки

Все эндпоинты требуют авторизацию (session-cookie + RBAC через
`AuthGuard`). Stock API — read-only.

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/api/stock/balances` | Список текущих остатков (фильтры: `workshopNeedId`, `orderId`, `warehouseId`, `cellId`, `materialRole`, `unit`, `q`, `positiveOnly` / `negativeOnly` / `zeroOnly`) |
| GET | `/api/stock/movements` | Журнал движений (фильтры: `workshopNeedId`, `orderId`, `stockBalanceId`, `warehouseId`, `cellId`, `type`, `direction`, `sourceType`, `sourceId`, `purchaseReceiptId`, `purchaseReceiptLineId`, `materialIssueId`, `materialIssueLineId`, `from`, `to`, `q`) |
| POST | `/api/stock/adjustments` | Ручная корректировка остатка (создаёт `StockMovement` `type=ADJUSTMENT`, см. `docs/api.md §«26a.3»`) |
| POST | `/api/stock/transfers` | Перемещение остатка между складами / ячейками (создаёт пару `StockMovement` `type=TRANSFER` `OUT`+`IN`, см. `docs/api.md §«26a.4»`) |
| GET | `/api/orders/:orderId/material-issues` | Список `MaterialIssue` по заказу |
| GET | `/api/material-issues/:id` | Детали одного документа со строками |
| GET | `/api/company-settings` | Текущие настройки, включая оба флага |
| PATCH | `/api/company-settings` | Обновление настроек (любое подмножество полей) |

Особенности:

- **API требует авторизацию** — без сессии 401.
- **Stock mutations**: ручная корректировка
  (`POST /api/stock/adjustments`) и перемещение между складами /
  ячейками (`POST /api/stock/transfers`). Никаких cancel adjustment /
  cancel transfer / FIFO / партий через REST не предусмотрено.
  Автоматические IN/OUT/REVERSAL по-прежнему пишет бизнес-flow
  (`PurchaseReceiptsService`, `MaterialIssuesService`) через
  `StockService.applyMovementInTx`.
- **`sourceKey` не отдаётся наружу** — внутренний идемпотентный ключ
  `StockMovement.sourceKey` сознательно вырезан из публичного
  response (`toStockMovementListItem`) и не объявлен в frontend
  типах.

---

## 5a. Готовая продукция

Готовая продукция — **отдельный контур** от материалов
(`apps/api/src/modules/finished-goods/*`,
`prisma/schema.prisma::FinishedGoodsBalance` / `FinishedGoodsMovement`,
`docs/current-state.md §«Foundation готовой продукции»`,
`docs/api.md §29a`).

`StockBalance` / `StockMovement` / `MaterialIssue` /
`MaterialIssueReturn` / `PurchaseReceipt` / `StockAdjustment` /
`StockTransfer` / `CostsService` / `ProductionCostV2Service` —
**этим контуром не затрагиваются и не меняются**.

Что уже реализовано на этой итерации:
- модели `FinishedGoodsBalance` / `FinishedGoodsMovement` (миграция
  `20260615100000_add_finished_goods_foundation`);
- автоматический приход `PRODUCTION_RECEIPT IN` в момент
  `Passport.status = PACKED` (через `PackingService.addPassport` →
  `FinishedGoodsService.recordPackedPassportInTx`), idempotent по
  `sourceKey = PACKED_PASSPORT:<passportId>`;
- **Operation flag `producesFinishedGoods`** (миграция
  `20260616100000_add_operation_produces_finished_goods`):
  если на операции стоит `producesFinishedGoods = true`, выпуск
  фиксируется уже при прохождении этой операции
  (`PassportsService.scanOnOperation` для предыдущей операции +
  `PassportsService.completeOperationByEmployee` для завершаемой).
  Идемпотентный `sourceKey` совпадает с packed-flow, поэтому
  последующая упаковка дубль не создаёт;
- read-only API: `GET /api/finished-goods/balances` и
  `GET /api/finished-goods/movements` отдают `clientId` /
  `clientName` (через `Order.client → Client`); те же поля
  добавлены в `GET /api/stock/movements`;
- UI колонка «Заказчик» в `/admin/warehouses?tab=movements`;
- UI чекбокс «Выпускает готовую продукцию» в формах создания и
  редактирования операции (`/admin/operations/new` и
  `/admin/operations/[id]`); badge «Выпуск ГП» в таблице списка
  операций;
- **готовая продукция отображается в существующих вкладках
  `/admin/warehouses?tab=balances` и `?tab=movements`** вместе с
  материалами (см. итерация «Готовая продукция в существующих
  вкладках склада» в `docs/current-state.md`). Отдельная вкладка /
  страница / sidebar-пункт под готовую продукцию не создавалась.
  Имя строки готовой продукции — `productName / color / sizeCode`,
  цена и сумма — `«—»` (это не material cost). Тип
  `PRODUCTION_RECEIPT` отображается как «Выпуск»;
- audit `FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED` (под
  `entityType = FINISHED_GOODS_MOVEMENT`) с расширенным payload
  `trigger: 'OPERATION_OUTPUT' | 'PACKED_PASSPORT'` и
  `triggerOperationId` для operation-driven выпуска.

Что добавлено итерацией «Отгрузка готовой продукции»:
- модели `FinishedGoodsShipment` (`status` всегда `POSTED` на MVP,
  номер `S-YYYYMMDD-NNNN`) и `FinishedGoodsShipmentLine` (snapshot
  product / size / color / warehouse / cell от `FinishedGoodsBalance`
  на момент создания);
- API: `POST /api/orders/:orderId/finished-goods-shipments`,
  `GET /api/orders/:orderId/finished-goods-shipments`,
  `GET /api/finished-goods/shipments/:id` (RBAC ADMIN / SHOP_MANAGER);
- по каждой строке shipment создаётся ровно один
  `FinishedGoodsMovement` `type = SHIPMENT, direction = OUT` (sourceKey
  `FINISHED_GOODS_SHIPMENT_LINE:<lineId>`); `FinishedGoodsBalance.qty`
  уменьшается атомарно; `FINISHED_GOODS_INSUFFICIENT_BALANCE` (409)
  при попытке отгрузить больше доступного;
- идемпотентность повторного submit формы — `FinishedGoodsShipment.sourceKey
  @unique` = `FINISHED_GOODS_SHIPMENT:<orderId>:<clientRequestId>`;
- UI блок «Отгрузка готовой продукции» во вкладке «Производство»
  карточки заказа (
  `apps/web/components/orders/finished-goods/*`); отдельная страница
  `/admin/finished-goods` / sidebar-пункт / новая вкладка
  `OrderViewTabs` НЕ создавались;
- audit `FINISHED_GOODS_SHIPMENT_CREATED` (`entityType =
  FINISHED_GOODS_SHIPMENT`).

Что добавлено итерацией «Отмена / сторно отгрузки готовой продукции»:
- `FinishedGoodsShipment` расширен полями `cancelledAt` /
  `cancelledById` / `cancelReason` (миграция
  `20260618100000_finished_goods_shipment_cancel`);
- API: `POST /api/finished-goods/shipments/:id/cancel` (RBAC
  ADMIN / SHOP_MANAGER), body `{ reason }` (2..500);
- по каждой `FinishedGoodsShipmentLine` создаётся обратное
  `FinishedGoodsMovement type = REVERSAL, direction = IN` с
  `sourceKey FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>`;
  `FinishedGoodsBalance.qty` атомарно увеличивается обратно;
- идемпотентность повторного cancel-вызова — `shipment.status ===
  CANCELLED` возвращает existing detail без новых движений;
- UI кнопка «Отменить» в существующем блоке «Отгрузка готовой
  продукции» карточки заказа (для `POSTED`-документов); badge
  «Отменена» + `cancelReason` для `CANCELLED`;
- audit `FINISHED_GOODS_SHIPMENT_CANCELLED`.

Что добавлено итерацией «Перемещение готовой продукции»:
- API: `POST /api/finished-goods/transfers` (RBAC ADMIN /
  SHOP_MANAGER), body `{ fromFinishedGoodsBalanceId, toWarehouseId? |
  null, toCellId? | null, qty (int > 0), comment (2..500),
  clientRequestId? }`. `orderId` / `productId` / `sizeId` / `color` /
  `warehouseId` / `cellId` сервис достаёт из исходного
  `FinishedGoodsBalance` — клиент их не присылает;
- transfer фиксируется парой `FinishedGoodsMovement` `type = TRANSFER`
  через `applyMovementInTx`: `direction = OUT` (sourceKey
  `FINISHED_GOODS_TRANSFER:<id>:OUT`) уменьшает исходный баланс,
  `direction = IN` (sourceKey
  `FINISHED_GOODS_TRANSFER:<id>:IN`) создаёт / увеличивает целевой
  баланс той же номенклатуры;
- transfer всегда **strict** — нельзя переместить больше, чем есть
  на источнике (`FINISHED_GOODS_INSUFFICIENT_BALANCE`, 409);
- same-location guard
  (`FINISHED_GOODS_TRANSFER_SAME_LOCATION`, 409);
- идемпотентность по `clientRequestId`; inconsistent state
  (`FINISHED_GOODS_TRANSFER_INCONSISTENT_STATE`, 409) при
  частичном дубле sourceKey;
- UI: единая кнопка «Переместить» во вкладке
  `/admin/warehouses?tab=balances` (общий диалог
  `StockTransferDialog`); по `kind` выбранного остатка идёт в
  `POST /api/stock/transfers` (материал) или в
  `POST /api/finished-goods/transfers` (готовая продукция). Для
  готовой продукции `qty` валидируется как целое (`Number.isInteger`)
  на frontend и backend;
- audit `FINISHED_GOODS_TRANSFER_CREATED` (`entityType =
  FINISHED_GOODS_MOVEMENT`).

Чего нет на этой итерации (отдельный backlog по готовой продукции):
- частичная отмена shipment — пользователь отменяет ошибочный
  shipment целиком и создаёт новый корректный;
- отдельные модели `FinishedGoodsShipmentReturn` /
  `FinishedGoodsShipmentCancel` — отмена решена через
  `status = CANCELLED` + REVERSAL IN, без нового документа;
- DRAFT-flow shipment (на MVP всегда POSTED → CANCELLED);
- автоматическая смена `Order.status` при полной отгрузке —
  сознательное решение, статус заказа меняется только через
  `POST /api/orders/:id/complete`;
- cancel transfer / partial / batch transfer / transfer history
  endpoint / отдельная модель `FinishedGoodsTransfer` — transfer
  представлен парой `FinishedGoodsMovement type = TRANSFER`,
  ошибочный transfer оператор компенсирует обратным transfer-ом;
- cancel adjustment / partial cancel / adjustment history endpoint
  / отдельная модель `FinishedGoodsAdjustment` — adjustment
  представлен одним `FinishedGoodsMovement type = ADJUSTMENT`,
  ошибочную корректировку оператор компенсирует обратной (IN ↔
  OUT);
- сторно (`REVERSAL`) движений готовой продукции вручную
  (REVERSAL пишется автоматически только на cancel shipment);
- `unitCost` / `totalCost` для движений готовой продукции (это не
  material cost);
- флаг разрешения отрицательного остатка готовой продукции
  (`OUT` всегда strict);
- размещение готовой продукции по ячейкам автоматически (`cellId`
  всегда `null` для `PRODUCTION_RECEIPT`; для `SHIPMENT` snapshot-ом
  берётся существующий `cellId` баланса; для `TRANSFER` оператор
  выбирает ячейку назначения сам);
- UI-раздел `/admin/finished-goods` / sidebar item / отчёт;
- новые роли (RBAC ограничен `ADMIN` / `SHOP_MANAGER`).

Что добавлено итерацией «Корректировка готовой продукции»:
- API: `POST /api/finished-goods/adjustments` (RBAC ADMIN /
  SHOP_MANAGER), body `{ finishedGoodsBalanceId, direction
  ('IN'|'OUT'), qty (int > 0), comment (2..500), clientRequestId? }`.
  `orderId` / `productId` / `sizeId` / `color` / `warehouseId` /
  `cellId` / `unit` сервис достаёт из исходного
  `FinishedGoodsBalance` — клиент их не присылает;
- adjustment фиксируется одним `FinishedGoodsMovement`
  `type = ADJUSTMENT` через `applyMovementInTx`: `direction = IN`
  увеличивает баланс, `direction = OUT` уменьшает; sourceKey
  `FINISHED_GOODS_ADJUSTMENT:<clientRequestId>`;
- `OUT` всегда **strict** — нельзя списать больше, чем есть на
  балансе (`FINISHED_GOODS_INSUFFICIENT_BALANCE`, 409). Готовая
  продукция не уходит в минус, аналога
  `allowNegativeMaterialStock` для finished goods нет;
- идемпотентность по `clientRequestId`;
- UI: единая кнопка «Корректировка» во вкладке
  `/admin/warehouses?tab=balances` (общий диалог
  `StockAdjustmentDialog`); по `kind` выбранного остатка идёт в
  `POST /api/stock/adjustments` (материал) или в
  `POST /api/finished-goods/adjustments` (готовая продукция). Для
  готовой продукции `qty` валидируется как целое (`Number.isInteger`)
  на frontend и backend; поле «Цена за единицу» **disabled** для
  готовой продукции (это не material cost);
- audit `FINISHED_GOODS_ADJUSTMENT_CREATED` (`entityType =
  FINISHED_GOODS_MOVEMENT`).

### Как проверить «Корректировку готовой продукции»

1. Подготовить остаток готовой продукции: упаковать паспорт или
   провести операцию с `Operation.producesFinishedGoods = true`. На
   вкладке «Остатки» `/admin/warehouses?tab=balances` должна
   появиться строка готовой продукции (имя `productName / color /
   sizeCode`, ед. изм. — `шт`).
2. Нажать кнопку «Корректировка» над таблицей остатков.
   Открывается inline-диалог «Корректировка остатка».
3. В select «Остаток» выбрать строку из группы «Готовая
   продукция». Под select-ом отрисуется подсказка «Готовая
   продукция корректируется в штуках». Поле «Цена за единицу»
   станет disabled с подсказкой «Стоимость для готовой продукции в
   этой корректировке не указывается». В подсказке под полем
   количества виден текущий остаток в шт.
4. Сценарий **IN (увеличение)**: выбрать «Приход (увеличить)»,
   ввести целое число, заполнить причину (2..500), нажать
   «Сохранить корректировку». Проверить: на вкладке «Остатки»
   `FinishedGoodsBalance.qty` увеличился на введённую величину;
   на вкладке `?tab=movements` появилась строка `type = ADJUSTMENT,
   direction = IN` («Корректировка», «Приход») с тем же
   количеством и комментарием.
5. Сценарий **OUT (уменьшение)**: выбрать «Расход (уменьшить)»,
   ввести количество ≤ доступного, заполнить причину, сохранить.
   Проверить, что баланс уменьшился, в журнале появилась строка
   `type = ADJUSTMENT, direction = OUT` («Корректировка»,
   «Расход»).
6. Сценарий **OUT > доступного** → 409
   `FINISHED_GOODS_INSUFFICIENT_BALANCE`, понятный текст backend
   без raw JSON. Баланс не изменился.
7. Сценарий **дробное qty** → frontend-валидация «Для готовой
   продукции количество должно быть целым числом», submit не
   отправляется. На уровне backend-DTO дробное значение даёт 400
   через `qty.int()`.
8. Идемпотентность: повторный submit формы (двойной клик / network
   retry) с тем же `clientRequestId` НЕ задваивает движение и НЕ
   меняет баланс повторно.
9. Roles: попытка вызвать endpoint от роли `SEAMSTRESS` / `MASTER`
   → 403 `FORBIDDEN_ROLE`. Доступ есть только у `ADMIN` /
   `SHOP_MANAGER`.
10. Изоляция: после adjustment-а готовой продукции `StockBalance`
    / `StockMovement` материалов / `MaterialIssue` / production
    cost **не изменились**.

### Как проверить «Перемещение готовой продукции»

1. Подготовить остаток готовой продукции: упаковать паспорт
   (см. сценарий ниже про packing) или провести операцию с
   `Operation.producesFinishedGoods = true`. На вкладке «Остатки»
   `/admin/warehouses?tab=balances` должна появиться строка готовой
   продукции (имя `productName / color / sizeCode`, ед. изм. — `шт`).
2. Нажать кнопку «Переместить» над таблицей остатков. Открывается
   inline-диалог «Перемещение остатка».
3. В select «Исходный остаток» выбрать строку из группы «Готовая
   продукция». Под select-ом отрисуется подсказка «Готовая продукция
   перемещается в штуках». В сводке «Откуда» виден текущий склад /
   ячейка / номенклатура остатка.
4. Выбрать склад и (опционально) ячейку назначения. Если выбрать
   ту же локацию, что у источника — submit вернёт 409
   `FINISHED_GOODS_TRANSFER_SAME_LOCATION`.
5. Указать целое количество ≤ доступного. Дробное число → frontend
   валидация «Для готовой продукции количество должно быть целым
   числом», backend `FINISHED_GOODS_TRANSFER_QTY_INVALID` (400).
   Превышение доступного → 409
   `FINISHED_GOODS_INSUFFICIENT_BALANCE`.
6. Указать причину перемещения (комментарий, 2..500 символов) и
   нажать «Создать перемещение».
7. После успеха диалог закрывается, страница ревалидируется.
   Проверить:
   - на вкладке «Остатки» исходный `FinishedGoodsBalance.qty`
     уменьшился, в локации назначения появился (или вырос)
     `FinishedGoodsBalance` той же номенклатуры с
     перемещённым `qty`;
   - на вкладке `/admin/warehouses?tab=movements` появились две
     строки `type = TRANSFER`: одна с направлением «Расход» (OUT) в
     исходной локации и одна с «Приход» (IN) в локации назначения,
     обе с одинаковым `qty` и комментарием. Колонка «Заказчик»
     показывает клиента заказа.
8. Идемпотентность: повторный submit формы (двойной клик / network
   retry) с тем же `clientRequestId` НЕ задваивает движения и НЕ
   меняет балансы повторно. UNIQUE на
   `FinishedGoodsMovement.sourceKey` (sourceKey
   `FINISHED_GOODS_TRANSFER:<id>:OUT/IN`) подстрахует от
   race-condition.
9. Roles: попытка вызвать endpoint от роли `SEAMSTRESS` / `MASTER` →
   403 `FORBIDDEN_ROLE`. Доступ есть только у `ADMIN` /
   `SHOP_MANAGER`.
10. Изоляция: после transfer-а готовой продукции `StockBalance` /
    `StockMovement` материалов / `MaterialIssue` / production cost
    **не изменились**.

### Как проверить «Отмену отгрузки готовой продукции»

1. Создать `FinishedGoodsShipment` (см. сценарий «Отгрузка готовой
   продукции из заказа» ниже). Запомнить `shipment.id`,
   `shipment.number` и текущие `FinishedGoodsBalance.qty` строк
   (после отгрузки они уменьшились).
2. В блоке «История отгрузок» в `/admin/orders/[id]?tab=production`
   убедиться, что у строки статус «Проведена» и видна кнопка
   «Отменить». Нажать.
3. В форме указать причину отмены (минимум 2 символа), нажать
   «Отменить отгрузку».
4. Проверить:
   - `FinishedGoodsShipment.status = CANCELLED`,
     `cancelledAt` / `cancelledById` / `cancelReason` заполнены
     (см. detail `GET /api/finished-goods/shipments/:id`);
   - на каждую строку создалось `FinishedGoodsMovement`
     `type = REVERSAL, direction = IN` с `sourceType =
     FINISHED_GOODS_SHIPMENT_CANCEL_LINE`,
     `sourceId = shipmentLine.id`;
   - `FinishedGoodsBalance.qty` восстановился до значения **до
     отгрузки** (исходный SHIPMENT OUT остаётся в журнале — это
     корректное историческое движение).
5. В блоке «История отгрузок» строка теперь со статусом
   «Отменена», виден `cancelReason` и дата отмены. Кнопка
   «Отменить» больше не показывается.
6. В `/admin/warehouses?tab=movements` появилась строка REVERSAL
   IN с типом «Сторно», правильной номенклатурой / заказом /
   заказчиком. Comment содержит причину отмены.
7. Повторно дёрнуть `POST /api/finished-goods/shipments/:id/cancel`
   с любым reason — backend возвращает существующий detail; новых
   движений / списаний / audit-записей НЕ создаётся (idempotent
   при `status === CANCELLED`).
8. Проверить, что `Order.status` после отмены **остался прежним**
   и что material `StockBalance` / `StockMovement` не изменились.

### Как проверить «Отгрузку готовой продукции из заказа»

1. Выпустить готовую продукцию (через `producesFinishedGoods`-операцию
   или упаковку паспорта). В `/admin/warehouses?tab=balances`
   появится строка готовой продукции с `qty > 0`.
2. Открыть карточку заказа `/admin/orders/[id]?tab=production`.
   В блоке «Отгрузка готовой продукции» должны быть видны доступные
   остатки. Нажать «Создать отгрузку».
3. В форме указать `qty` по одной или нескольким строкам (частичная
   отгрузка). Submit.
4. Проверить:
   - `FinishedGoodsShipment` с `status = POSTED`,
     `number = S-YYYYMMDD-NNNN` (см. detail
     `GET /api/finished-goods/shipments/:id`);
   - `FinishedGoodsShipmentLine` по каждой отправленной строке;
   - `FinishedGoodsBalance.qty` уменьшился на сумму отгруженных
     `qty`;
   - в `/admin/warehouses?tab=movements` появилась строка с типом
     «Отгрузка», направлением «Расход», правильной номенклатурой и
     заказчиком; источник `FINISHED_GOODS_SHIPMENT_LINE:<lineId>`.
5. Попробовать отгрузить больше доступного в форме — backend
   возвращает 409 `FINISHED_GOODS_SHIPMENT_QTY_EXCEEDS_AVAILABLE`,
   UI показывает осмысленное сообщение.
6. Повторить submit формы с тем же `clientRequestId` (например,
   двойной клик / network retry) — backend возвращает существующий
   документ; новые движения / списания НЕ создаются (идемпотентность
   по `FinishedGoodsShipment.sourceKey @unique`).
7. Проверить, что `Order.status` после полной отгрузки **остался
   прежним** — переход в `DONE` сознательно НЕ автоматизирован.
8. Проверить, что material `StockBalance` / `StockMovement` не
   изменились (отдельный контур).

### Как проверить «Выпуск по операции»

1. Открыть `/admin/operations/[id]` (например, операцию «Упаковка»
   или «ОТК финальный») и включить чекбокс «Выпускает готовую
   продукцию», сохранить.
2. Создать паспорт по заказу с заданным
   `Order.finishedGoodsWarehouseId` (или без — для проверки
   «no-warehouse»-ветки).
3. Провести паспорт по маршруту до операции с признаком —
   завершить её (`completeOperationByEmployee`) или сканировать
   на следующей операции (`scanOnOperation`). В `GET
   /api/finished-goods/movements?passportId=…` должен появиться
   ровно один `PRODUCTION_RECEIPT IN` с
   `qty = passport.qtyGood` и
   `warehouseId = finishedGoodsWarehouseId`.
4. Повторно провести паспорт через ту же операцию (или сканировать
   ещё раз, или дополнительно упаковать через `PackingService`):
   количество движений по этому passportId не должно вырасти —
   `sourceKey = PACKED_PASSPORT:<passportId>` UNIQUE удерживает
   идемпотентность.
5. Открыть `/admin/warehouses?tab=movements` — в общем журнале
   движений (материалы + готовая продукция) колонка «Заказчик»
   должна показывать `Client.name` для строк, привязанных к заказу
   с клиентом, и «—» для остальных. Строка выпуска готовой
   продукции должна иметь тип «Выпуск», название
   `productName / color / sizeCode` и прочерк в колонках «Цена» /
   «Сумма».
6. Открыть `/admin/warehouses?tab=balances` — текущий остаток по
   паспорту/партии должен появиться в той же таблице, что и
   материалы; имя строки — `productName / color / sizeCode`.
   Цена / сумма — прочерк. Готовая продукция различима по имени —
   отдельной колонки «Тип» нет.

Эти типы зарезервированы строковыми литералами в
`FINISHED_GOODS_MOVEMENT_TYPE`, но writer-ов / API нет. Добавление
UI-раздела требует подтверждения владельца проекта.

---

## 6. Что НЕ реализовано

Зафиксированные ограничения MVP — задачи, которые **сознательно не
делались** в этой итерации (см. также §8):

- нет master-сущности `Material` — материал идентифицируется через
  `WorkshopNeed`;
- нет `MaterialStockLot` (партий);
- нет FIFO / LIFO — на OUT используется текущий
  `StockBalance.unitCost` (средневзвешенная);
- нет сложной multi-warehouse фильтрации / группировок по складу /
  отдельной сводки по складам в UI;
- transfer между складами / ячейками реализован как пара
  `StockMovement` `type=TRANSFER` (`OUT`+`IN`) через
  `POST /api/stock/transfers`; UI — кнопка «Переместить» во вкладке
  `/admin/warehouses?tab=balances`. Остаются нерешёнными: cell
  selector в форме перемещения (ждём API списка ячеек по складу) и
  отмена / удаление transfer;
- нет возврата / сторно POSTED `MaterialIssue` (POSTED отменить
  нельзя — DRAFT cancel не пишет движение);
- нет новых ролей `WAREHOUSE_MANAGER` / `PURCHASER` / `ACCOUNTANT`
  (RBAC ограничен `ADMIN` / `SHOP_MANAGER`);
- `PurchaseReceipt` cancel остаётся **permissive**-сценарием — флаг
  `allowNegativeMaterialStock` на REVERSAL OUT не распространяется;
- `MaterialIssueLine` **не дробится** между несколькими остатками —
  одна строка → одно OUT-движение;
- **stock valuation** (средневзвешенная по `StockBalance.unitCost`) и
  **`MaterialIssue.totalCost`** (Σ по строкам через
  `WorkshopNeed.quotedPrice`) — **независимые стоимости**;
  `StockMovement.totalCost` ≠ `MaterialIssue.totalCost` по
  построению;
- `ProductionCostV2Service` (управленческий P&L) **не обновлён** под
  склад — материалы по-прежнему берёт из расчётной основы
  (`OrderCostEstimate` / `WorkshopNeed`), не из `MaterialIssue`.

---

## 7. Известные технические замечания

- Для локальной разработки можно использовать прямой push схемы:

  ```bash
  npx prisma db push --schema=prisma/schema.prisma
  ```

- `npm run prisma:migrate` (`prisma migrate dev`) может падать на
  historical migrations / shadow database, если история старых
  миграций не replayable на пустой БД.
- Это **отдельная инфраструктурная задача**, не связанная с
  `MaterialIssue` / Stock foundation, и решается вне этой итерации.
- **Не менять** historical migrations в рамках функциональных
  задач без отдельного решения — любые правки старых миграций
  должны идти отдельным согласованным изменением.

---

## 8. Следующие этапы

Backlog по оси «материалы / склад» (порядок ориентировочный — реальная
приоритизация определяется владельцем проекта):

1. **Ручная корректировка остатков** — реализована в текущей итерации
   как `StockMovement` `type=ADJUSTMENT` через `POST /api/stock/adjustments`
   и UI кнопку «Корректировка» во вкладке `/admin/warehouses?tab=balances`
   (см. `docs/api.md §«26a.3»`, `docs/current-state.md §«Ручная
   корректировка остатка»`). `IN` увеличивает остаток, `OUT` уменьшает;
   `OUT` уважает `allowNegativeMaterialStock`. Delete / cancel
   adjustment в этой итерации не реализованы.
2. **Возврат / сторно POSTED `MaterialIssue`** — реализовано
   полностью (полное сторно + частичный возврат по строкам):
   `POST /api/material-issues/:id/return` создаёт документ
   `MaterialIssueReturn` + `StockMovement` `type=REVERSAL`
   `direction=IN` в одной транзакции. UI — кнопка «Сторнировать»
   в карточке заказа → вкладка «Потребности» → блок «Фактический
   расход материалов» с per-line input «Вернуть» и кнопкой
   «Заполнить всё доступное». Backend принимает `lines = [{
   materialIssueLineId, returnedQty }]` (партиал) или вызов без
   `lines` (legacy полное сторно). Идемпотентность по
   `MaterialIssueReturn.sourceKey`. Order summary, plan/fact и
   production cost считают **нетто** (`Σ MaterialIssue.totalCost
   − Σ MaterialIssueReturn.totalCost`). На один `MaterialIssue`
   можно сделать несколько частичных возвратов подряд:
   `availableToReturn = issuedQty − Σ ранее возвращённое`.
   Будущий этап — **удаление / отмена возврата**.
3. **Фильтры склада** — расширение UI и/или API:
   - `warehouseId`;
   - `cellId`;
   - `orderId`;
   - `negativeOnly`.
4. **Transfer между складами / ячейками** — реализовано как пара
   `StockMovement` `type=TRANSFER` (`OUT`+`IN`) через
   `POST /api/stock/transfers`. UI — кнопка «Переместить» во
   вкладке `/admin/warehouses?tab=balances`. Идемпотентность по
   `clientRequestId` (UNIQUE на парных
   `STOCK_TRANSFER:<id>:OUT|IN`-ключах). Backlog: cell selector в
   форме перемещения (нужен API списка ячеек по складу) и
   отмена / удаление transfer.
5. **Master-модель `Material`** (отдельная сущность вместо
   идентификации через `WorkshopNeed`).
6. **`MaterialStockLot` / партии.**
7. **FIFO / LIFO / средневзвешенная политика** как явный выбор.
8. **Multi-warehouse UX** — группировки, сводки, фильтры на UI.
