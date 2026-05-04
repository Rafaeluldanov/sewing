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

---

## 5. API для проверки

Все эндпоинты требуют авторизацию (session-cookie + RBAC через
`AuthGuard`). Stock API — read-only.

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/api/stock/balances` | Список текущих остатков (фильтры: `workshopNeedId`, `orderId`, `warehouseId`, `cellId`, `materialRole`, `unit`, `q`, `positiveOnly` / `negativeOnly` / `zeroOnly`) |
| GET | `/api/stock/movements` | Журнал движений (фильтры: `workshopNeedId`, `orderId`, `stockBalanceId`, `warehouseId`, `cellId`, `type`, `direction`, `sourceType`, `sourceId`, `purchaseReceiptId`, `purchaseReceiptLineId`, `materialIssueId`, `materialIssueLineId`, `from`, `to`, `q`) |
| POST | `/api/stock/adjustments` | Ручная корректировка остатка (создаёт `StockMovement` `type=ADJUSTMENT`, см. `docs/api.md §«26a.3»`) |
| GET | `/api/orders/:orderId/material-issues` | Список `MaterialIssue` по заказу |
| GET | `/api/material-issues/:id` | Детали одного документа со строками |
| GET | `/api/company-settings` | Текущие настройки, включая оба флага |
| PATCH | `/api/company-settings` | Обновление настроек (любое подмножество полей) |

Особенности:

- **API требует авторизацию** — без сессии 401.
- **Единственная stock mutation** — `POST /api/stock/adjustments`
  (ручная корректировка). Никаких transfer / cancel adjustment / FIFO
  / партий через REST не предусмотрено. Автоматические IN/OUT/REVERSAL
  по-прежнему пишет бизнес-flow (`PurchaseReceiptsService`,
  `MaterialIssuesService`) через `StockService.applyMovementInTx`.
- **`sourceKey` не отдаётся наружу** — внутренний идемпотентный ключ
  `StockMovement.sourceKey` сознательно вырезан из публичного
  response (`toStockMovementListItem`) и не объявлен в frontend
  типах.

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
- нет transfer между складами / ячейками;
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
2. **Возврат / сторно POSTED `MaterialIssue`** (вместе с возвратом
   материала в ячейку).
3. **Фильтры склада** — расширение UI и/или API:
   - `warehouseId`;
   - `cellId`;
   - `orderId`;
   - `negativeOnly`.
4. **Transfer между складами / ячейками.**
5. **Master-модель `Material`** (отдельная сущность вместо
   идентификации через `WorkshopNeed`).
6. **`MaterialStockLot` / партии.**
7. **FIFO / LIFO / средневзвешенная политика** как явный выбор.
8. **Multi-warehouse UX** — группировки, сводки, фильтры на UI.
