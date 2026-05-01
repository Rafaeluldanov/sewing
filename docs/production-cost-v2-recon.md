# Production cost v2 — recon

> Recon перед переписыванием отчёта `/admin/production-cost` как
> **управленческого отчёта себестоимости по номенклатуре / лекалам и
> единицам продукции**.
>
> Документ описывает:
>
> - что есть в системе сейчас и какие источники данных мы можем
>   переиспользовать без миграций / без изменений в payroll;
> - что является фактом, а что плановой / расчётной / закупочной
>   основой;
> - почему **паспорт не должен быть основной сущностью отчёта**;
> - как считать **выпуск в единицах изделий**, а не в количестве
>   паспортов и не в сумме `OperationEntry.qty` по всем операциям;
> - рекомендуемую архитектуру v2 (новый endpoint
>   `GET /api/admin/production-cost/v2`, отдельный сервис, без
>   destructive-изменений старого `/api/costs/production`).

## 1. Главный вывод

- Текущий отчёт `/admin/production-cost` — это техническая «карточка
  дня цеха» (`docs/domain.md §17`): по дню упаковки считается
  `pieceworkCost + salaryCost`, выпуск = `Σ Passport.qtyGood` по
  упакованным паспортам, плюс «простой» окладных. Это полезно
  начальнику цеха, но это **не управленческий P&L**: нет разреза по
  лекалам / заказам / клиентам / операциям, нет материалов, нет
  выручки.
- Нам нужно построить **новый управленческий отчёт** поверх
  существующих фактов:
  - факт операций — `OperationEntry` (это единственный источник истины
    по сдельным начислениям);
  - факт выпуска — `Passport.qtyGood` для упакованных партий;
  - материалы / фурнитура / нанесение — **не факт списания** (модели
    `MaterialConsumption` / `WriteOff` сейчас нет в схеме), только
    расчётная основа из `OrderCostEstimateLine` (или fallback из
    `WorkshopNeed`);
  - выручка — `Order.customerUnitPrice × releasedQty`, только в RUB на
    MVP; USD без курса не смешиваем.
- Паспорт в отчёте остаётся **только техническим join-мостом**
  `OperationEntry → Passport → Order → PatternItem`. В UI колонки
  «Паспорт» как основной сущности **нет**; `passportId` /
  `passportNumber` могут лежать в DTO как secondary technical поля для
  trace.
- Никаких изменений в Prisma, payroll (`OperationEntry`, `SalaryEntry`),
  паспортах, `OrderCostEstimate`, `WorkshopNeed`, `PurchaseOrder` /
  `PurchaseReceipt` и production-flow не требуется.
- Старый `GET /api/costs/production` остаётся как есть — в нём могут
  жить bookmarks начальника цеха. Новый отчёт идёт отдельным route
  `GET /api/admin/production-cost/v2`.

## 2. Что есть сейчас

### 2.1 Текущий `CostsService` (`apps/api/src/modules/costs/*`)

`GET /api/costs/production?dateFrom&dateTo` агрегирует **по дню
упаковки**:

- источник дня = `PassportEvent.type = PACKED` в окне `[from..to]`;
- `producedUnits` = `Σ passport.qtyGood` по этим паспортам;
- `pieceworkCost` = `Σ OperationEntry.amount` (status `APPROVED`) по
  тем же паспортам;
- `salaryCost` = распределение оклада по длительности стадий
  `QC` / `WTO` / `PACKING` (см. `PassportDurationsService`,
  `SHIFT_MINUTES = 480`, `MAX_STAGE_MINUTES_PER_PASSPORT = 60`);
- `idleCost` — отдельная сущность «простой», не распределяется на
  изделия (см. ТЗ §11).

Эта механика остаётся жить в старом сервисе — **мы её не трогаем**.

### 2.2 Источники факта операций

`OperationEntry` (`prisma/schema.prisma:1141`) хранит всё, что нужно
для управленческого отчёта:

- `passportId`, `operationId`, `employeeId`;
- `qty`, `ratePerUnit`, `amount` (`Decimal(12,2)`);
- `status` (`PENDING | PENDING_RELEASE | APPROVED | CANCELLED |
  REVERSED`);
- `approvalMode` (`IMMEDIATE | AFTER_RELEASE`);
- `sourceEventType` (`PASSPORT_CREATED | OPERATION_TRANSITION`);
- `createdAt`, `approvedAt` (`DateTime?`).

Дата для управленческого отчёта = `approvedAt ?? createdAt`. Берём
только `status = APPROVED` по умолчанию (это «реальные деньги, которые
платим»). Опционально можно расширить до `PENDING_RELEASE` (швея
сделала операцию, ждём упаковку), но для MVP оставляем `APPROVED`,
чтобы цифры совпадали с реально начисленной сдельщиной.

`OperationEntry` идемпотентен по
`(passportId, operationId, employeeId, sourceEventType)`. Это значит,
что одна строка в нашем отчёте = одна сущность сдельной выплаты, без
дублей.

### 2.3 Источники факта выпуска

В системе нет отдельной таблицы «отгружено» — финальный статус партии
в production flow это `Passport.status = PACKED`. Это уже используется
текущим `CostsService` (через `PassportEvent.PACKED`) и
`order-aggregator.ts` (`qtyFinished = Σ qtyGood по PACKED-паспортам`).

Поэтому **финальный выпуск изделия = `Passport.qtyGood` для
паспортов в статусе `PACKED`**.

> Нельзя считать выпуск как `Σ OperationEntry.qty по всем операциям` —
> одно изделие проходит много операций (раскрой → оверлок → распошив →
> ОТК → ВТО → упаковка), и это даст «выпуск × N операций» вместо
> реального количества.
>
> Нельзя считать выпуск как `count(Passport)` — паспорт это
> производственная партия с `qtyPlan`/`qtyGood` от 1 до 100+ изделий.

Итого:

- `releasedQty` = `Σ Passport.qtyGood` для паспортов
  `status = PACKED`, у которых дата упаковки в выбранном периоде.
- За дату упаковки берём `PassportEvent` с `type = PACKED`
  (`createdAt` события — UTC). Это совпадает с тем, как считает
  старый `CostsService`. Если по какой-то причине события `PACKED`
  нет, fallback на `Passport.updatedAt` для статуса `PACKED` —
  безопасно.
- Параллельно имеем `passportsCount` (число упакованных партий),
  но это **secondary metric** в отчёте, **не главный** показатель.

### 2.4 Источники материалов / фурнитуры / нанесения

В схеме нет `MaterialConsumption` / `WriteOff` — то есть **факта
списания материалов в производство нет**. Источников расчётной
основы три:

| Источник | Что это | Когда используется |
|---|---|---|
| `Order.currentCostEstimate` (`OrderCostEstimate` со статусом `COMPLETED`) | Завершённый расчёт себестоимости по заказу. Строки `OrderCostEstimateLine` уже классифицированы `kind ∈ { MATERIAL, HARDWARE, APPLICATION, OTHER }`. Цены зафиксированы snapshot-ом, USD пересчитан в RUB по `usdRateRub` из расчёта. | Главный источник: «материалы по завершённому расчёту». |
| `WorkshopNeed` (активные строки) | Текущая потребность цеха по заказу. Используется до завершения расчёта. Цена может быть `null`, валюта `RUB`/`USD`. | Fallback, если у заказа нет `currentCostEstimate`. Только RUB-строки с `quotedPrice` идут в `materialCostRub` итог; для USD-строк отдельный warning. |
| `PurchaseOrder` / `PurchaseReceipt` | Закупочные документы. Связь с заказом покупателя через `PurchaseOrder.customerOrderId`. Это «закуплено / принято под заказ», а **не списано в производство**. | На MVP не используем — можно добавить отдельным эпиком «закупка под заказ» позже. |

В **UI v2 материалы подписываются честно**:

- если есть `currentCostEstimate` → «Материалы по завершённому расчёту»;
- если только `WorkshopNeed` → «Материалы по текущей потребности»;
- никогда не пишем «Факт материалов» / «Фактический расход» — это было
  бы враньём.

### 2.5 Расчёт пропорциональной аллокации по периоду

`OrderCostEstimate.totalCostRub` — это стоимость **всей плановой
партии заказа**. Если за период мы упаковали только часть заказа
(`releasedQtyInPeriodForOrder < order.qtyPlanTotal`), брать всю
себестоимость заказа в отчёт за период = завышение.

Алгоритм MVP — пропорциональная аллокация по выпуску в периоде:

```
costForPeriod_X = totalCost_X(order) × releasedQtyInPeriod(order) / order.qtyPlanTotal
```

(где `X ∈ { MATERIAL, HARDWARE, APPLICATION, OTHER }`).

Если `order.qtyPlanTotal == 0` (странный, но возможный edge-case —
заказ без items) — аллокацию не делаем, ставим `0` для всех материалов
по этому заказу.

Этот же подход используем и для выручки:

```
revenueRub = order.customerUnitPrice (RUB) × releasedQtyInPeriod
```

— тут пропорциональность уже зашита, потому что `releasedQtyInPeriod`
сам линеен по выпуску.

### 2.6 Salary-distribution

Старый `CostsService` уже делает распределение оклада QC/WTO/PACKING на
паспорты по длительности стадий (`PassportDurationsService`). На MVP
v2 мы намеренно **не пытаемся это интегрировать в новый отчёт**:

- алгоритм распределения завязан на длительность стадий, а не на
  стоимость номенклатуры — переплетение этих двух концепций требует
  отдельного recon;
- riски: задвоить с `operationPieceworkCostRub` или потерять часть
  суммы из-за паспортов вне периода;
- для управленческого отчёта (который про «деньги по лекалам»)
  достаточно показать `salaryAllocatedCostRub = 0` и **явно
  предупредить в warnings**: «Окладная составляющая не распределена
  по номенклатуре».

Поле `salaryAllocatedCostRub` остаётся в DTO (нулевое значение), чтобы
позже подключить алгоритм без слома контракта.

## 3. Почему паспорт — не основной разрез

Паспорт — это **производственная партия**: в нём может быть 7, 20 или
100+ единиц. Менеджеру / собственнику бизнеса важны:

- лекало (что выпустили);
- заказ (для кого);
- размер (чего и сколько);
- операция (где формируется работа);
- сотрудник (кто заработал);
- кол-во единиц / сумма / стоимость за 1 шт.

«Сколько паспортов было в работе» — это технический показатель цеха,
полезный мастеру, но не управленцу.

Поэтому в отчёте v2:

- **главный разрез** — номенклатура / лекало
  (`PatternItem` + snapshot полей на `Order`);
- **второстепенные разрезы** — заказ, операция, сотрудник, размер;
- **паспорт** — только бекендный join `OperationEntry → Passport →
  Order → PatternItem`, в UI основной таблицы колонки «Паспорт» нет;
- `passportId` / `passportNumber` могут лежать в DTO
  `ProductionCostOperationLineDto` как **optional technical** поля
  для отладки и будущего drill-down, но UI не делает их основными.

## 4. Резолвинг номенклатуры

Используем тот же resolver, что и в карточке заказа (см.
`apps/api/src/modules/orders/orders.service.ts::toListItemDto`):

```
nomenclatureName =
  order.patternNameSnapshot
  ?? order.patternItem?.name
  ?? order.product?.name              // legacy fallback (через OrderItem)
  ?? null

nomenclatureArticle =
  order.patternArticleSnapshot
  ?? order.patternItem?.article
  ?? null

previewImageUrl =
  order.patternPreviewSnapshotUrl
  ?? order.patternItem?.previewImageUrl
  ?? null
```

Group-key:

```
nomenclatureKey =
  patternItemId
  ?? `legacy:${nomenclatureName}|${nomenclatureArticle ?? ''}`
  ?? 'unknown'
```

`legacy`-префикс безопасен: даже если у заказа отвязали лекало, мы
группируем legacy-заказы по человекочитаемому имени и не путаем их с
заказами с лекалом.

## 5. Архитектура v2

### 5.1 Контракт DTO

Новый файл `packages/shared/src/production-cost.ts`. Он живёт
параллельно `costs.ts` (старый контракт), не пересекается импортами.

Главные DTO:

- `ProductionCostV2QuerySchema` (Zod): `dateFrom`, `dateTo`,
  `patternItemId?`, `orderId?`, `clientId?`, `employeeId?`,
  `operationId?`, `status?`.
- `ProductionCostReportDto`: периодика + totals + три блока:
  `nomenclatureGroups[]`, `orderGroups[]`, `operationLines[]`,
  `warnings: string[]`.
- `ProductionCostTotalsDto`: единый набор сумм для KPI.
- `ProductionCostNomenclatureGroupDto` — главная сущность отчёта.
- `ProductionCostOrderGroupDto` — разрез по заказу.
- `ProductionCostOperationLineDto` — одна `OperationEntry`,
  `passportId/passportNumber` optional technical.
- `ProductionCostOperationAggregateDto`,
  `ProductionCostEmployeeAggregateDto`,
  `ProductionCostSizeAggregateDto` — breakdown'ы внутри
  `nomenclatureGroup`.

Все суммы — `string` (Decimal сериализуется как в
`OrderCostEstimateLineDto`); количества — `number`.

### 5.2 Сервис

`apps/api/src/modules/costs/production-cost-v2.service.ts`. Чистый
read-only Nest-сервис, зависит только от `PrismaService`. Алгоритм:

1. Распарсить период (`dateFrom`, `dateTo`), нормализовать в UTC-окно
   `[from..to]`.
2. Достать все `OperationEntry` со `status = APPROVED` (по умолчанию)
   в окне дат `approvedAt ?? createdAt`. Применить любые `where`
   фильтры (passport.order для `patternItemId` / `orderId` /
   `clientId`, `employeeId`, `operationId`).
3. Достать все паспорта `status = PACKED` (через `PassportEvent` типа
   `PACKED` в окне) — они дают `releasedQty` и идентифицируют, какие
   заказы реально выпускались в периоде.
4. Включить:
   - `Passport.size`, `Passport.order` (с `client`, `patternItem` →
     `category`, `items`, `currentCostEstimate.lines`).
   - `OperationEntry.operation`, `OperationEntry.employee`.
5. Промапить каждую `OperationEntry` в
   `ProductionCostOperationLineDto`.
6. Сгруппировать по `nomenclatureKey` и по `orderId`.
7. На каждый заказ:
   - `releasedQtyInPeriod` = сумма `qtyGood` по PACKED-паспортам
     этого заказа в окне.
   - Получить `currentCostEstimate`. Аллоцировать
     `MATERIAL/HARDWARE/APPLICATION/OTHER` пропорционально
     `releasedQtyInPeriod / order.qtyPlanTotal`.
   - Если `currentCostEstimate` нет → fallback на активные
     `WorkshopNeed` с `quotedPrice` (только RUB), warning по USD.
   - `revenueRub`: `customerUnitPrice (RUB) × releasedQtyInPeriod`.
     Если `customerCurrency = USD` — `revenueRub = 0` и warning.
8. На каждую `nomenclatureGroup`:
   - `releasedQty` = сумма `releasedQtyInPeriod` по заказам этого
     лекала.
   - `operationPieceworkCostRub` = `Σ OperationEntry.amount` в группе.
   - Материалы / фурнитура / нанесение / прочее = `Σ` по заказам.
   - `revenueRub` = `Σ` по заказам.
   - `operationBreakdown[]`, `employeeBreakdown[]`,
     `sizeBreakdown[]` — внутренние агрегаты.
9. `totals` — суммирование по всем nomenclatureGroups.
10. Никаких group-by по паспорту.

### 5.3 Контроллер

`apps/api/src/modules/costs/production-cost-v2.controller.ts`,
`@Roles('ADMIN','SHOP_MANAGER')`, route `GET
/api/admin/production-cost/v2`. Использует
`ZodValidationPipe(ProductionCostV2QuerySchema)`. Регистрируется в
существующем `CostsModule`.

### 5.4 Frontend

- `apps/web/lib/production-cost-api.ts` →
  `getProductionCostV2(query)` через `apiFetch`.
- `apps/web/app/admin/production-cost/page.tsx` переписан как
  SaaS-отчёт: фильтры (период / номенклатура / заказ / клиент /
  сотрудник / операция), KPI-карточки, три таба:
  - «По номенклатуре» (главный);
  - «По заказам»;
  - «Операции / сотрудники» (расшифровка `operationLines`,
    **без колонки «Паспорт»**).
- Старая страница `/production-cost` (cell-фокус, simpler chart) и
  старый endpoint остаются как есть.

## 6. Источники данных и их статус

| Поле в отчёте | Источник | Что это | Подпись в UI |
|---|---|---|---|
| `releasedQty` | `Passport.qtyGood` для PACKED в периоде | Факт выпуска | «Выпущено, шт» |
| `passportsCount` | `count(Passport)` PACKED в периоде | Технический secondary | (не показывается явно как метрика) |
| `operationPieceworkCostRub` | `Σ OperationEntry.amount` (`APPROVED`) в периоде | **Факт начислений** | «Операции: факт по начислениям» |
| `materialCostRub` | `OrderCostEstimateLine.kind = MATERIAL` × прората | Расчётная основа | «Материалы по завершённому расчёту» / «по текущей потребности» |
| `hardwareCostRub` | `kind = HARDWARE` | Расчётная основа | «Фурнитура по завершённому расчёту» |
| `applicationCostRub` | `kind = APPLICATION` | Расчётная основа | «Нанесение по завершённому расчёту» |
| `otherCostRub` | `kind = OTHER` | Расчётная основа | «Прочее по завершённому расчёту» |
| `salaryAllocatedCostRub` | (в MVP = `0`) | Не распределено по номенклатуре | warning: «Окладная составляющая не распределена по номенклатуре» |
| `revenueRub` | `Order.customerUnitPrice` (RUB) × `releasedQty` | Управленческое поле заказа | «Выручка» |
| `marginRub` | `revenueRub - totalCostRub` | Производное | «Маржа» |
| `unitCostRub` | `totalCostRub / releasedQty` | Производное | «Себестоимость за 1 изделие» |

## 7. Что не делаем и почему

- **Не меняем Prisma** — все данные есть, миграции не нужны.
- **Не трогаем `OperationEntry`/`SalaryEntry`/`Passport`** — payroll
  и production flow остаются ровно такими, какие есть.
- **Не пишем новый `MaterialConsumption`** — это полноценный новый
  модуль, отдельный эпик. До его появления материалы в отчёте честно
  подписываются как «расчётная основа», а не как «факт списания».
- **Не реюзаем `salaryCost` из старого CostsService** — там логика
  per-day per-employee, она не аллоцируется по лекалам без отдельного
  алгоритма. Оставляем `salaryAllocatedCostRub = 0` + warning.
- **Не показываем колонку «Паспорт» в UI основных таблиц** — паспорт
  только технический мост. `passportId` / `passportNumber` могут
  лежать в DTO `operationLines[*]` как secondary поля.

## 8. Acceptance / smoke / integration

Smoke (без БД):

- DTO `ProductionCostOperationLineDto` имеет `nomenclatureName` и
  **не требует** `passportNumber`.
- UI `/admin/production-cost` содержит «По номенклатуре», «По
  заказам», «Операции / сотрудники».
- UI **не содержит** обязательной колонки «Паспорт» в основных
  таблицах.
- UI содержит правильные подписи источника материалов («по
  завершённому расчёту» / «по текущей потребности»).
- Сервис использует `OperationEntry` как факт операций.
- Сервис не группирует основной отчёт по паспорту.
- Никаких новых Prisma-моделей.

Integration (БД):

1. Создать pattern + order + passport `qtyPlan = 20`,
   `OperationEntry`. Выпустить (PACKED).
2. `GET /api/admin/production-cost/v2` за этот период.
3. Проверить:
   - `operationLines[*].nomenclatureName` есть;
   - `operationLines[*].qty/amount/unitCost` корректны;
   - `nomenclatureGroup.releasedQty = 20` (а не количество паспортов);
   - `nomenclatureGroup.operationPieceworkCostRub = Σ OperationEntry.amount`;
   - `nomenclatureGroup.unitCostRub = totalCost / 20`.
4. Два паспорта по 20 изделий под одно лекало → `releasedQty = 40`,
   одна группа.
5. `currentCostEstimate` с MATERIAL → `materialCostRub` пропорционален
   выпуску.
6. `customerUnitPrice` RUB × 40 → корректный `revenueRub` и
   `marginRub`.
