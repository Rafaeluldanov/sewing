# ADR-0022: Техкарты и snapshot потребностей на заказе

- Статус: принято
- Дата: 2026-04-22

## Контекст

Менеджеру нужен лёгкий способ зафиксировать «что нужно на одну единицу
изделия»: материалы (ткань, нитки, фурнитура) и внешние подрядные
размещения (шелкография, печать этикеток, вышивка — `OUTSOURCED_SERVICE`
из терминологии операций). Без этого:

- план потребностей собирается «на словах» и теряется при передаче;
- к моменту запуска заказа невозможно вытащить, какие материалы и
  подряды нужны конкретно для этой партии;
- любая правка задним числом «протекает» в карточку уже запущенного
  заказа и ломает план-факт по поставкам.

При этом **сейчас** не нужно строить ERP-закупок, склад сырья, vendor
directory, формулы для нестандартных заказов или material-cost внутри
`CostsService`. Это сознательно отложено (см. «Последствия»).

Готовый pattern в проекте — «soft-route» (ADR-0006-производный, см.
`docs/domain.md §«Маршруты производства»`):

1. Админ создаёт `RouteTemplate` со списком шагов.
2. Менеджер опционально привязывает `routeTemplateId` к `Order` в
   `DRAFT`.
3. При `OrdersService.start()` шаги копируются в snapshot
   `OrderRouteStep[]`.
4. Карточка заказа отдаёт snapshot read-only — поздние правки шаблона
   не меняют запущенные заказы.

## Решение

Дублируем тот же шаблон для техкарт.

### Сущности

- **`TechCardTemplate`** (`code` уникален, `name`, `isActive`).
- **`TechCardMaterialLine`** — позиция материала в шаблоне:
  `name`, `unit` (обязательно), `qtyPerUnit Decimal(12,4)` (> 0),
  `note?`, `sortOrder`. Cascade-FK на `TechCardTemplate`.
- **`TechCardOutsourceLine`** — позиция внешнего подряда: `name`,
  `unit?`, `qtyPerUnit Decimal(12,4)?`, `vendorName?`, `note?`,
  `sortOrder`. Cascade-FK на `TechCardTemplate`.
- **`Order.techCardId String?`** — опциональная привязка, как
  `routeTemplateId`.
- **`OrderMaterialRequirement`** / **`OrderOutsourceRequirement`** —
  snapshot строк на заказе. Поля копируют шаблон, добавляется
  `totalQty Decimal(12,4)`. FK
  `sourceTechCardLineId` — nullable, **`ON DELETE SET NULL`**: это
  ключ к независимости snapshot-а.

### Snapshot и `totalQty`

> **Правка после рефакторинга OrdersService (2026-Q2).** Изначальный
> текст ADR говорил, что snapshot `OrderMaterialRequirement[]` /
> `OrderOutsourceRequirement[]` создаётся **только** в
> `OrdersService.start()`. Это больше не так. Реальная логика —
> в `apps/api/src/modules/orders/orders.service.ts`, метод
> `syncOrderRouteStepsSnapshot(...)` и аналогичные tech-card-snapshot
> блоки внутри сервиса:
>
> - snapshot материалов / подрядов техкарты синхронизируется **до
>   запуска заказа в производство**, в той же транзакции, что и
>   сама операция, из следующих точек:
>   - `OrdersService.create()` — при создании заказа с
>     `techCardId`;
>   - `OrdersService.update()` — при правке `techCardId` /
>     `items` / `patternItemId` на DRAFT-заказе;
>   - `OrdersService.recalculateOperationPlan()` — пока заказ
>     в `DRAFT`/`CALCULATION` (см. ТЗ §«План операций»);
>   - `OrdersService.startCalculation()` — финальный snapshot
>     перед фиксацией `OrderCostEstimate`.
> - `OrdersService.start()` сохраняет **defensive fallback** для
>   legacy-заказов, которые были созданы до этого изменения и
>   приехали в production без snapshot-строк (`existing.count() === 0`).
> - После `start()` снапшот заморожен: `update` / `recalculateOperationPlan`
>   к нему не возвращаются (`ORDER_LOCKED` / `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`).
>
> Это не меняет публичного контракта (snapshot-строки приходят в
> `OrderDetailDto` после первого `create`/`update` так же, как
> раньше — после `start`). Но карточка заказа в `DRAFT` уже
> показывает потребности и подряды задолго до запуска производства.
> См. «Snapshot is built before production start» — это инвариант
> текущей реализации.

В каждой точке вызова, в той же транзакции, что и сама операция:

- `baseQty = Σ OrderItem.qtyPlan` по строкам заказа.
- Для каждой `TechCardMaterialLine`:
  `totalQty = qtyPerUnit * baseQty` (Decimal-математика).
- Для `TechCardOutsourceLine`: если `qtyPerUnit == null`, то и
  `totalQty == null` (часто подряд считается «за партию», без явной
  нормы).

Никаких формул, размеров, коэффициентов, отходов. Это сознательно
упрощённый MVP — см. «Отложено».

### Edit-after-start

Поведение полностью повторяет route:

- `Order.update` пускает `techCardId` только пока snapshot пуст
  (в DRAFT он всегда пуст). Если кто-то попытается переустановить
  привязку после `start()` — 409 `ORDER_TECH_CARD_ALREADY_STARTED`.
- Правка строк шаблона `PATCH /api/tech-cards/:id` использует
  full-replace (delete-all + create-many в транзакции), как
  `RoutesService.replaceSteps`.
- Snapshot заказа физически живёт в отдельных таблицах и не зависит
  от `TechCardMaterialLine.id`/`TechCardOutsourceLine.id` после
  `SET NULL`.

### Soft-protection селекта

`assertTechCardUsable`:
- 404 `TECH_CARD_NOT_FOUND` — нет такой техкарты;
- 409 `TECH_CARD_INACTIVE` — деактивирована.

Используется в `OrdersService.create/update`. UI прячет неактивные
шаблоны в селекте, кроме «текущей» привязки в режиме edit (тот же
паттерн, что у `routeTemplate`).

## Альтернативы и почему они отвергнуты

### A. Слить техкарту с маршрутом

Сделать «расширенный» `RouteTemplate`, где у шага есть материалы и
вендор. Отвергнуто:

- размывает семантику маршрута («что делает швея на следующем шаге»);
- ломает уже работающий контур /work, паспортов, snapshot-а
  `OrderRouteStep`;
- материал может быть не привязан ни к какому шагу (просто «нужен на
  заказ»);
- внешний подряд почти никогда не привязан к конкретной операции
  внутри потока.

Разделение `RouteTemplate` ⊥ `TechCardTemplate` — две независимые
оси.

### B. Хранить внешний подряд как операцию `OUTSOURCED_SERVICE`

Это уже есть в `OperationCategory`. Соблазн «положить» внешний подряд
в маршрут. Отвергнуто:

- маршрут — это «что делает швея»; добавление туда подряда раздувает
  список и путает /work;
- подряд считается за «единицу заказа» (qty/штука + всего штук + опц.
  vendor), это другой DTO;
- не у всех подрядов есть `qtyPerUnit` (часто «за партию»);
- vendor-directory мы НЕ строим в этом MVP, поэтому `vendorName` —
  свободный текст, и его место в техкарте, а не в каталоге операций.

`OUTSOURCED_SERVICE`-операция остаётся валидной для случая «подряд
внутри потока швейного цеха» — она просто живёт параллельно техкарте.

### C. Объединить материалы и внешние потребности в одну таблицу

С `lineType: enum`. Отвергнуто:

- набор полей различается (`unit`, `qtyPerUnit` обязательны для
  материала, опциональны для подряда; `vendorName` — только для
  подряда);
- два независимых snapshot-а легче читать (read-only карточка заказа
  показывает их разными блоками: «Материалы» и «Внешние потребности»).

### D. Добавить `Product.defaultTechCardId`

Удобно: при выборе изделия префиллить техкарту в форме заказа.
Отвергнуто **в этом MVP**:

- усложняет миграцию (новая колонка в `Product`);
- нужен fallback-UX «защита от неактивной дефолтной техкарты»;
- этот UX-сахар можно добавить позже без breaking-changes.

### E. Делать формулы для нестандартных заказов

Был запрос «на длинных рукавах нужно больше ткани» и т.п. Отвергнуто
**в этом MVP**:

- формулы тянут DSL и UI редактора;
- большинство потоковых заказов закрываются плоским «qty/штука»;
- расширение поверх текущей модели делается аддитивно
  (новая колонка `formulaJson?` или отдельная таблица), не ломая
  snapshot.

## Последствия

### Положительные

- Менеджер получает единый артефакт «потребности на единицу изделия»
  и план в `Decimal` для конкретной партии после `start()`.
- Snapshot независим от шаблона: историчность плана сохраняется
  бессрочно.
- Архитектура повторяет уже отлаженный route-MVP — низкая стоимость
  поддержки, почти отсутствует риск регрессии (route-контур не
  тронут).
- Разделение материалов и подряда позволяет позже навесить разные
  модули (сток сырья vs vendor-directory) независимо.

### Отрицательные / отложено

- `Product.defaultTechCardId` нет — менеджер выбирает руками. Сахар
  на потом.
- `totalQty` — плоский продукт qty × норма, без размерных
  коэффициентов, без процента отходов. На MVP ок, но «реальная»
  потребность будет включать отходы и размерную сетку — сделаем,
  когда будет конкретный кейс.
- Vendor directory не строим — `vendorName` свободный текст,
  поиск/группировка вручную.
- `CostsService` и dashboard material-cost не учитывают snapshot
  потребностей. Это **сознательно**: на MVP мы фиксируем план
  потребностей, не бюджет.
- Сток сырья / закупки / приёмка — **не наш скоуп**. Ничто из
  shopfloor / passport / QC / WTO / packing flow не зависит от
  snapshot потребностей.

## Cut-ready readiness (MVP-2)

После первичного MVP выяснилось: основная управленческая ценность от
техкарт — не сам snapshot потребностей, а ответ на вопрос «когда мы
можем отдать подряд?». Самый частый кейс — печать/шелкография по
готовому крою: подрядчику физически нужны вырезанные детали, а у нас
момент «крой готов» уже неявно фиксируется в `Passport.currentCellId`
(размещение паспорта в ячейку, ADR-0008/0010). Из этого вырастает
MVP-2 — **read-only** сигнал готовности на карточке заказа.

### Решение

1. На `TechCardOutsourceLine` и `OrderOutsourceRequirement` добавляем
   поле `triggerType OutsourceTriggerType @default(MANUAL)`. Значения
   enum-а — `MANUAL` (текущее поведение, дефолт для всех существующих
   строк) и `CUT_READY` (привязка к готовности кроя).
2. На `OrdersService.start()` `triggerType` копируется в snapshot
   ровно так же, как `name`/`unit`/`qtyPerUnit` — чтобы поздние
   правки шаблона **не меняли** уже зафиксированные строки заказа.
3. В `OrdersService.getOne()` (и **только** там) считается
   `isCutReadyForOrder = order.passports.length > 0 &&
   order.passports.every((p) => p.currentCellId !== null)`. Для
   каждой `OrderOutsourceRequirement` с `triggerType === 'CUT_READY'`
   мы выставляем derived поля `isReadyToOrder` (boolean) и
   `readinessLabel` (`"Готово к заказу"` / `"Ожидает размещения
   кроя"`). Для `MANUAL` — `isReadyToOrder = false`,
   `readinessLabel = null`.
4. UI карточки заказа `/orders/[id]` показывает эти derived поля
   read-only под соответствующей строкой блока «Внешние
   потребности». Никаких кнопок/чекбоксов/dropdown статусов.
5. Admin-форма техкарты (`/admin/tech-cards/{new,[id]}`) добавляет
   `<select>` `triggerType` с подписями «Вручную» / «Когда крой
   размещён в ячейки».

### Почему именно так

- **Почему не общий trigger-engine.** В системе ровно один реальный
  кейс (печать по крою) и один сигнал (`Passport.currentCellId`).
  Строить generic движок (event-bus, набор правил, conditions) ради
  одного триггера — это спекулятивная сложность; MVP закрывается
  плоским enum-ом и одной веткой `if`. Когда появится второй
  реальный триггер (например, route-step-based), enum
  `OutsourceTriggerType` расширится без изменения публичных API.
- **Почему readiness не пишем в БД.** Состояние «крой готов»
  — это **функция от уже существующих данных** (`Passport.currentCellId`).
  Любая зеркальная колонка `OrderOutsourceRequirement.status` или
  `readinessAt` потребует синхронизатор/cron/событие на каждое
  изменение паспорта (issue/scan/move/place/QC), и это:
  1) расширит граф side-effect далеко за пределы scope MVP;
  2) внесёт риск рассогласования (кто-то поправит `currentCellId`
     напрямую, а derived колонка останется stale);
  3) даст 0 user-видимой ценности — карточка заказа всё равно
     грузится одним запросом и считает читая `passports[]`.
  Поэтому readiness — **derived read-model**, считается at-read.
  Если когда-нибудь потребуется список «все строки, готовые к
  заказу» поверх множества заказов — добавим материализацию
  отдельным шагом, не трогая текущий контракт.
- **Почему критерий — ALL_PASSPORTS, а не ANY.** Подрядчику нужно
  отдавать всю партию кроя за раз; «кусочный» подряд по части
  паспортов в текущем процессе не бывает. ANY_PASSPORTS как режим
  сознательно отложен: он вводит понятие «частичной готовности»,
  которому в текущем UI/процессе не на что лечь. Когда появится
  реальный кейс кусочной отдачи — добавим как третье значение
  enum-а (`ANY_PASSPORTS`) или per-line флаг, без обратной
  несовместимости.
- **Почему `currentCellId`, а не события `CELL_PLACED`.**
  `currentCellId` — каноническое состояние паспорта (см. ADR-0010);
  события — лог. Использовать лог как источник истины здесь дороже
  и хрупче (что делать, если событие потеряли при rollback?).
  `currentCellId` — единственная колонка, которую читаем.

### Что **не** меняется

- Schema паспортов, ячеек, маршрутов, операций, расчёта зарплат и
  себестоимости — не тронуты.
- Транзиции `start/complete/cancel` — без изменений, кроме копирования
  одного дополнительного поля.
- `OrdersService.list()` и order summaries — без изменений; readiness
  считается только на `getOne()`.
- Никакого cron/background-job-а, никаких новых событий.
- `MANUAL`-строки ведут себя ровно как до MVP-2.

### Что отложено явно

- ~~Workflow `ORDERED` / `RECEIVED` / `IN_PROGRESS_AT_VENDOR`~~ —
  частично закрыт MVP-3 (см. ниже). `IN_PROGRESS_AT_VENDOR` и
  rollback-переходы остаются отложенными.
- ANY_PASSPORTS criterion (см. выше).
- Generic trigger framework / route-step-based триггеры.
- Vendor portal / нотификация подрядчика по готовности.
- Bulk-view «все готовые подряды» поверх заказов.

## Manual execution status (MVP-3)

После MVP-2 menager увидел готовность подряда (derived `CUT_READY`),
но всё ещё не мог зафиксировать в системе **факт**, что он реально
отдал подряд подрядчику и что результат уже получен. Это
управленческий blind spot: статус застрявал в чужих чатах /
бумажках, и невозможно было «по системе» ответить «эта строка —
заказана?». MVP-3 закрывает его минимально-возможным способом.

### Решение

1. На `OrderOutsourceRequirement` добавлены три поля (additive,
   default-friendly):
   - `executionStatus OrderOutsourceExecutionStatus @default(PLANNED)`
     — enum `PLANNED | ORDERED | RECEIVED`;
   - `orderedAt DateTime?`, `receivedAt DateTime?` — лёгкий
     audit-trail без отдельной event-log таблицы.
2. На `OrdersService.start()` snapshot создаётся с
   `executionStatus = PLANNED`, `orderedAt = null`,
   `receivedAt = null` (backward-compat для всех старых сценариев).
3. Один новый action-эндпоинт:
   `POST /api/orders/:id/outsource-requirements/:requirementId/status`
   c телом `{ executionStatus: 'ORDERED' | 'RECEIVED' }`. Линейные
   переходы `PLANNED → ORDERED → RECEIVED`, идемпотентен. Для
   `triggerType = CUT_READY` действует guard:
   `PLANNED → ORDERED` запрещён, пока derived `isReadyToOrder = false`
   (`409 OUTSOURCE_NOT_READY_TO_ORDER`).
4. В `OrdersService.getOne()` собирается **композитный**
   display-статус: `displayStatus` /
   `displayStatusLabel` (см. ADR-0022, `domain.md`, `api.md`,
   `screens.md`). В БД композитный статус **не пишется**.
5. UI карточки заказа `/orders/[id]` рендерит 0–1 кнопку под
   строкой («Отметить как заказано» / «Отметить как получено»),
   только для `SHOP_MANAGER` / `ADMIN`. Никаких dropdown-ов,
   inline-edit, vendor-edit, форм поставщика. Подтверждение через
   `window.confirm`.

### Почему ровно так

- **Почему ручные `ORDERED` / `RECEIVED` храним в БД, а
  `READY_TO_ORDER` — нет.** `READY_TO_ORDER` — функция от уже
  существующего `Passport.currentCellId`, поэтому это derived (см.
  «Cut-ready readiness»). `ORDERED` / `RECEIVED` же — **решение
  менеджера**, которое никаким сигналом системы не «вычисляется»;
  отсутствие источника = обязательная колонка.
- **Почему ручные статусы — только на уровне snapshot-строки
  (`OrderOutsourceRequirement`).** Это локальное состояние одной
  строки конкретного заказа. Поднимать его выше (например, на
  `Order` или на `TechCardOutsourceLine`) — потерять «который из
  трёх подрядов уже у нас, а который ещё нет».
- **Почему линейный flow без откатов через action.** На MVP менеджер
  ставит статусы вперёд по жизни подряда; «снять как заказано»
  обычно означает «ой, ошиблись». Это редкий кейс, и его удобнее
  закрыть админ-ручкой (вне MVP), чем тащить откат-кнопку в карточку
  и плодить ветки в state-machine. `RECEIVED` поэтому терминальный.
- **Почему `executionStatus`-enum, а не пара boolean-ов.**
  Boolean-пара `isOrdered`/`isReceived` допускает невалидные
  состояния (`isReceived=true && isOrdered=false`). Enum явно
  перечисляет три валидных состояния, и валидация перехода
  становится ровно одним сравнением.
- **Почему отдельный POST-endpoint, а не PATCH-в общий
  `OrderOutsourceRequirement`.** Карточка заказа намеренно
  read-only по vendor/qty/note (см. ADR-0022 §«Edit-after-start»);
  единственная разрешённая правка — переход статуса. Узкий
  POST-action делает контракт явным, а UI-формy простой
  (одна кнопка → один action), и закрывает поверхность атаки на
  vendor/qty.
- **Почему не вводим vendor-master / purchase orders / счета /
  оплаты / складской приход.** Это полноценный procurement-модуль
  с собственным жизненным циклом, документами и интеграциями. В
  scope SEWING-MVP его нет: нам достаточно ответа «отдали /
  получили». Внедрение PO без соответствующего бизнес-процесса
  превратит фичу в карго-культ, и любая правка cargo-PO будет
  тащить за собой каскад изменений в shopfloor / costs / dashboard,
  которые мы сознательно не трогаем (см. §«Положительные / Отрицательные»).

### Что **не** меняется (MVP-3)

- Schema паспортов, ячеек, маршрутов, операций, расчёта зарплат и
  себестоимости — не тронуты.
- `start/complete/cancel`-транзиции и order summaries — без
  изменений (кроме копирования трёх default-полей в snapshot).
- `OrdersService.list()` — без изменений; композитный статус
  считается только на `getOne()`.
- `MANUAL`-строки до первого action ведут себя как раньше
  (`displayStatusLabel = null` для MANUAL+PLANNED — UI остаётся
  нейтральным).
- Никакого cron/background-job-а, никаких новых событий.

### Что отложено явно (MVP-3)

- Vendor / supplier directory.
- Purchase order documents, счета, оплаты, складской приход.
- `IN_PROGRESS_AT_VENDOR` (промежуточный статус «у подрядчика»).
- Rollback / cancel-action для `executionStatus`.
- Bulk-action «отметить N подрядов разом» из `/orders` (списка).
- Уведомления / e-mail / интеграция с подрядчиком при переходах.
- Audit-log с автором перехода (хранится только timestamp; кто
  именно нажал кнопку — пока не фиксируем, это можно добавить
  отдельной колонкой `orderedByEmployeeId` без миграционной боли).

## Связанные документы

- `docs/domain.md §«Техкарты»`
- `docs/erd.md` (новые сущности и связи)
- `docs/api.md §«tech-cards»` и расширения `orders`
- `docs/screens.md §«Техкарты»`
- ADR-0006 «План не меняется» (общий принцип snapshot-ов)
- ADR-0017 «Equipment allowed operations» (паттерн full-replace)
- ADR-0020 «Operation pricing model»
