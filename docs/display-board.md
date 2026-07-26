# Display board (`/shopfloor/display`)

> Статус: **OK** (создан в PHASE 2, 2026-Q2).
>
> Источник истины — **код**. При расхождении верим коду.
>
> Source files:
>
> - `apps/api/src/modules/shopfloor/**`
>   (`shopfloor.controller.ts`, `shopfloor.service.ts`,
>   `shopfloor-projection.ts`).
> - `apps/api/src/modules/display-screens/**`
>   (`display-screens.controller.ts`,
>   `display-screens.service.ts`).
> - `apps/web/app/shopfloor/display/**`
>   (`page.tsx`, `layout.tsx`, `display-board.tsx`).
> - `apps/web/lib/rbac.ts` (`canSeeDisplayPage`,
>   `DISPLAY_PAGE_ALLOWED_ROLES`).
> - `apps/web/lib/shopfloor-api.ts`
>   (`getShopfloorDisplaySummary`).
> - `apps/web/app/globals.css` — селекторы `.display-screen`,
>   `.display-board`, `.display-block`, `.display-matrix__scroll`,
>   media-queries `@media (max-width: 1199px)`.
> - `packages/shared/src/shopfloor.ts` — DTO
>   (`ShopfloorDisplayDto`, `ShopfloorDisplayKpiDto`,
>   `ShopfloorDisplayMatrixSummary`,
>   `ShopfloorDisplayColorBlock`, `ShopfloorDisplayRow`,
>   `ShopfloorDisplaySewingColumnDto`,
>   `ShopfloorDisplayRouteOperationDto`,
>   `ShopfloorDisplayRouteSizeRowDto`,
>   `ShopfloorEquipmentStatusDto`,
>   `ShopfloorOrphanMasterCallDto`,
>   `SHOPFLOOR_STAGES`, `SHOPFLOOR_DISPLAY_MATRIX_STAGES`,
>   `SHOPFLOOR_DISPLAY_KNOWN_COLORS`,
>   `SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY`).
> - `prisma/schema.prisma::model DisplayScreenConfig`,
>   `model Employee` (роль `DISPLAY` через `enum Role`),
>   `model CompanyDivision` (master-справочник подразделений).
> - `docs/api.md` — карта routes (`§32 Shopfloor`,
>   `§33 Display screens`).
> - `docs/erd.md` — карта моделей и enum-ов.
> - ADR-0007 (polling вместо WS на MVP), ADR-0013 (маппинг
>   паспортов на этапы экрана «Цех»).

---

## Содержание

- [1. Назначение и режим работы](#1-purpose)
- [2. Route `/shopfloor/display` (web)](#2-route)
- [3. RBAC и DISPLAY-учётка](#3-rbac)
- [4. `DisplayScreenConfig`](#4-config)
- [5. `GET /api/shopfloor/display` (API)](#5-api)
- [6. Bucket mapping (что куда падает)](#6-buckets)
- [7. Полезный контракт `ShopfloorDisplayDto`](#7-dto)
- [8. Polling и degraded behavior (frontend)](#8-polling)
- [9. Layout constraints для TV / WebView](#9-layout)
  (в т.ч. §9.4 — адаптивные слои «под каждый экран»)
- [10. Aggregation risks](#10-risks)

---

<a id="1-purpose"></a>
## 1. Назначение и режим работы

Большой монитор цеха (`/shopfloor/display`) — read-only витрина
для висящего в зале экрана. Интерактив отсутствует **по
дизайну**: ни кнопок, ни форм, ни hover-меню — только цифры.

Один backend-эндпоинт `GET /api/shopfloor/display` отдаёт сразу:

- KPI-блок «Выпущено сегодня / В работе / Ждёт / ОТК / ВТО /
  Упаковка / Готово / Брак» (`ShopfloorDisplayKpiDto`).
- Матрицу «цвет × размер × stage» (Поток производства,
  `colors[].rows[]`).
- Динамические столбцы стадии «Пошив»
  (`sewingColumns[]`) — раскладывает SEWING на конкретные
  операции (Оверлок 1, Киперка, Распошивальная, …).
- Маршрутный sewing-блок с подколонками `▶/✔`
  (`sewingRoute[]`) — для каждой sewing-операции активного
  заказа.
- Статусы оборудования (`equipment[]`).
- Открытые «orphan» вызовы мастера без `equipmentId`
  (`orphanMasterCalls[]`).

Это позволяет:

- большому монитору слать 1 polling-запрос вместо 4;
- считать агрегацию по цветам на backend (а не в браузере
  планшета на крыше цеха);
- держать KPI и матрицу всегда «одного снимка» (нет рассинхрона
  между запросами).

---

<a id="2-route"></a>
## 2. Route `/shopfloor/display` (web)

Источник: `apps/web/app/shopfloor/display/page.tsx`.

```text
GET /shopfloor/display?divisionCode=<CompanyDivision.code>
GET /shopfloor/display                    # без фильтра / DISPLAY-auto
```

- `dynamic = 'force-dynamic'` — RSC всегда дёргается заново.
- Парсит `?divisionCode` — основной query-параметр, любая строка
  `CompanyDivision.code` (см. `docs/domain.md §«Подразделения
  заказа»`). Параметр опциональный; пустое значение / отсутствие
  считается «фильтра нет».
- **Deprecated alias** на web-уровне: `?division=<value>` тихо
  мапится в `divisionCode`, чтобы старые TV-закладки не падали
  в 404. На API-уровне (`ShopfloorDisplayQuerySchema`) этот
  параметр уже не принимается; алиас будет убран после
  переезда всех закладок.
- RSC делает initial fetch
  (`getShopfloorDisplaySummary(divisionCode ?? undefined)`),
  чтобы первый кадр показал данные без спиннера. Если запрос
  падает — `initialError` пробрасывается в client-компонент,
  но snapshot не блокирует рендер.
- Передаёт в `<ShopfloorDisplayBoard>` `initialSummary`,
  `initialError`, `divisionCode`. Шапка экрана рисует код
  подразделения как саб-лейбл (или ничего, если фильтра нет).

Layout-обёртка:
`apps/web/app/shopfloor/display/layout.tsx`. Делает
route-level guard:

- `await getCurrentUserOrNull()` — если не залогинен,
  `redirect('/login?next=/shopfloor/display')`.
- `canSeeDisplayPage(me.user.role)` (см. §3) — иначе
  `redirect('/')`.

Анонимы уже отсекаются `apps/web/middleware.ts` редиректом на
`/login?next=...`; этот guard ловит «вошёл, но не той ролью».

---

<a id="3-rbac"></a>
## 3. RBAC и DISPLAY-учётка

Источник: `apps/web/lib/rbac.ts` (`canSeeDisplayPage`,
`DISPLAY_PAGE_ALLOWED_ROLES`).

```ts
export const DISPLAY_PAGE_ALLOWED_ROLES: readonly Role[] = [
  'DISPLAY',
  'ADMIN',
  'SHOP_MANAGER',
];
```

- `DISPLAY` — учётка большого монитора, единственная её
  страница. Создаётся через `POST /api/display-screens`
  (см. §4) — никакого ручного создания через
  `/admin/employees/new`, в `EMPLOYEE_ROLES` фронта роль
  сознательно не входит.
- `ADMIN` / `SHOP_MANAGER` — менеджер может посмотреть «как
  это выглядит на экране» с собственного устройства.

Backend контроллер `ShopfloorController.display`
(`@Controller('shopfloor') @Get('display')`) сознательно
**не имеет** `@Roles(...)` — endpoint доступен любой
авторизованной роли (включая DISPLAY). Никаких write-методов
в `ShopfloorController` нет.

Сама роль `DISPLAY` сознательно **не пускается** в
`DisplayScreensController` — управлять учётками DISPLAY должен
только менеджер (`@Roles('SHOP_MANAGER', 'ADMIN')` на
классе).

---

<a id="4-config"></a>
## 4. `DisplayScreenConfig`

Источник: `prisma/schema.prisma::model DisplayScreenConfig`
(~2058–2085) и `DisplayScreensService`
(`apps/api/src/modules/display-screens/display-screens.service.ts`).

```prisma
model DisplayScreenConfig {
  id                String         @id @default(cuid())
  name              String
  companyDivisionId String?
  companyDivision   CompanyDivision? @relation(fields: [companyDivisionId], references: [id], onDelete: SetNull)
  employeeId        String         @unique
  isActive          Boolean        @default(true)
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt

  employee Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)

  @@index([isActive])
  @@index([companyDivisionId])
}
```

Поля:

- `name` — человекочитаемое имя экрана («ТВ маркетплейс на
  стене у выхода»). Используется только в админ-листинге
  `/admin/display-screens`; фронту дисплея не отдаётся.
- `companyDivisionId? → CompanyDivision` — FK на карточку
  master-справочника подразделений (см. `docs/domain.md
  §«Подразделения заказа»`). Backend
  (`DisplayScreensService.create`) валидирует существование
  карточки (400 `COMPANY_DIVISION_NOT_FOUND` иначе).
  `onDelete: SetNull` — удаление карточки не сносит экран.
- `employeeId String UNIQUE` — FK на `Employee.id` под этой
  DISPLAY-учёткой. Один экран = ровно одна учётка. На delete
  сотрудника `onDelete: Cascade` удаляет и конфиг.
- `isActive` — мягкий выключатель экрана. Если `false` —
  `ShopfloorService.resolveDisplayDivisionCode` игнорирует
  конфиг при автоопределении подразделения для DISPLAY-
  пользователя и возвращает «общий» агрегат. Сама учётка
  продолжает работать.

Эндпоинты `/api/display-screens`
(RBAC `SHOP_MANAGER` / `ADMIN`):

- `GET /api/display-screens` — `DisplayScreensService.list()`
  (full-list, sort by `createdAt desc`). Каждая запись отдаёт
  `companyDivisionId` и краткие реквизиты
  `companyDivision { id, code, name }`.
- `POST /api/display-screens` —
  `DisplayScreensService.create(dto)`. В одной `$transaction`:
  - `Employee.create({ fullName: 'Display: <name>',
    login, pinHash: bcrypt.hash(pin, 10), role: DISPLAY,
    compensationType: SALARY, salaryPerShift: null,
    active: true })`. `compensationType = SALARY` без
    `salaryPerShift` сознательно даёт ноль в `SalaryService`
    и не плодит сдельных начислений.
  - `DisplayScreenConfig.create({ name, companyDivisionId,
    employeeId: employee.id, isActive })`. Тело DTO требует
    `companyDivisionId`; backend пишет FK напрямую.
- `P2002` на `Employee.login` транслируется в стабильный
  `DISPLAY_LOGIN_TAKEN` (409, см. `docs/api.md §33`).

---

<a id="5-api"></a>
## 5. `GET /api/shopfloor/display` (API)

Источник: `ShopfloorService.getDisplaySummary`
(`apps/api/src/modules/shopfloor/shopfloor.service.ts` ~632–1084)
и `ShopfloorController.display` (`/shopfloor` controller, без
`@Roles` — open для любой авторизованной роли).

### 5.1 Query

```ts
ShopfloorDisplayQuerySchema = z.object({
  divisionCode: z.string().trim().min(1).optional(),
});
```

`divisionCode` — единственный поддерживаемый параметр API,
любая строка `CompanyDivision.code`. Если параметр не передан,
фильтра нет (выборка по всем активным заказам), либо (для роли
DISPLAY) фильтр берётся из `DisplayScreenConfig` (см. §5.2).

### 5.2 Резолв `divisionCode` (приоритеты)

`ShopfloorService.resolveDisplayDivisionCode(query, user)`:

1. `query.divisionCode` — побеждает всё.
2. `user.role === 'DISPLAY'` → ищем `DisplayScreenConfig` по
   `employeeId`. Применяем подразделение оттуда **только** если
   `isActive = true` и привязан `companyDivisionId`; берём
   `config.companyDivision.code`.
3. Иначе → `null` (фильтра нет, выборка по всем активным
   заказам).

Запрос в БД (`displayScreenConfig.findUnique`) делается только
в случае (2): для не-`DISPLAY`-ролей и для запросов с явным
фильтром лишний round-trip не нужен.

### 5.3 Что фильтруется по подразделению

- Активные заказы: `Order.status NOT IN {DONE, CANCELLED}`
  плюс `companyDivision: { code: divisionCode }` (см.
  `buildOrderDivisionFilter`).
- Паспорта (`passports`-выборка) и snapshot маршрутов
  (`activeOrdersPromise / routeSteps`) — оба фильтруются по
  тому же условию.

Что **не** фильтруется по подразделению:

- `equipment` (`listEquipmentStatus`) — оборудование не
  принадлежит подразделению, и одни и те же станки могут шить
  разные заказы между сменами.

### 5.4 Параллельные запросы

`getDisplaySummary` гонит независимые Prisma-запросы
параллельно через `Promise.all`:

- `eventMaxesPromise` — `groupBy` по `PassportEvent`
  (`QC_PASSED`, `WTO_PASSED`, `OPERATION_SCAN`),
  ограниченный списком id паспортов-кандидатов
  (`IN_PROGRESS` + `currentOperation.category ∈ {QC,
  IRONING}`). Узкий запрос, не сканирует всю таблицу
  событий даже на длинной истории.
- `packedTodayPromise` — `passportEvent.findMany({ type:
  PACKED, createdAt >= startOfDayUtc })` для KPI «Выпущено
  сегодня».
- `equipmentPromise` — `loadEquipmentAndOpenMasterCalls()`
  (внутри тоже параллелизован).
- `activeOrdersPromise` — список активных заказов с
  `OrderItem.sizeId` для fallback в `buildSewingRoute`.

После `Promise.all` отдельно дёргается `routeSteps` (зависит
от списка активных orderId — `+1 sequential round-trip`,
но фильтр уже узкий: только sewing-категория, только нужные
orderId).

### 5.5 KPI-формулы

```ts
producedToday  = Σ qtyGood по PassportEvent(PACKED) за UTC-сегодня
inWork         = qtySewing + qtyQc + qtyQcDone + qtyWto + qtyWtoDone + qtyPacking
waiting        = qtyCut          // алиас для UI «Ждёт»
qc             = qtyQc + qtyQcDone
wto            = qtyWto + qtyWtoDone
packing        = qtyPacking
finished       = qtyFinished
defect         = qtyDefect
```

`qty*` — поля `ShopfloorDisplayMatrixSummary`, считаются
проекцией `projectShopfloorDisplay` (см. §6).

---

<a id="6-buckets"></a>
## 6. Bucket mapping (что куда падает)

Полная таблица — `production-flow.md §15`. Здесь — display-
специфичные особенности.

### 6.1 Источник истины проекции

Чистая функция `bucketOf(p): ShopfloorStage | null` из
`apps/api/src/modules/shopfloor/shopfloor-projection.ts` +
обёртка `projectShopfloorDisplay({ passports }, sizeMeta)`.

`SHOPFLOOR_STAGES` (`packages/shared/src/shopfloor.ts`):

```ts
['CUT', 'SEWING', 'QC', 'QC_DONE', 'WTO', 'WTO_DONE', 'PACKING', 'FINISHED']
```

Bucket-ы взаимоисключающие — один паспорт лежит ровно в
одной ячейке матрицы.

### 6.2 Что отрисовывается обычной (одно-клеточной) колонкой

`SHOPFLOOR_DISPLAY_MATRIX_STAGES`:

```ts
['CUT', 'PACKING', 'FINISHED']
```

`SEWING` намеренно отсутствует: на дисплее стадия пошива
раскладывается на отдельные операции через `sewingColumns[]`
и/или `sewingRoute[]` (см. §6.3 / §6.4).

`QC / QC_DONE / WTO / WTO_DONE` тоже не входят в этот список:
UI рисует их парой `▶/✔` под общим заголовком «ОТК» / «ВТО»
(`▶ = qtyQc/qtyWto`, `✔ = qtyQcDone/qtyWtoDone`). Stage-ключи
в `ShopfloorStage` сохраняются — они остаются доменной правдой
проекции и используются менеджерским `/shopfloor`, KPI и
интеграционными тестами.

### 6.3 Динамические `sewingColumns[]`

`projectShopfloorDisplay` раскладывает SEWING-бакет на
конкретные `Operation`-колонки. Источник колонок —
фактическая `Operation`, на которой сейчас стоит
`Passport.currentOperation` живых паспортов. Backend кладёт
сюда **только те операции**, по которым в текущем срезе есть
ненулевая продукция.

`ShopfloorDisplaySewingColumnDto`:

- `key` — `Operation.id` ИЛИ
  `SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY = '__pending__'` для
  паспортов в SEWING без явной sewing-операции (CUTTING-
  категория после `issueToEmployee` до первого
  `OPERATION_SCAN`, либо `currentOperation = NULL`).
- `label` — `Operation.name` или «Ожидает» для pending.
- `sortOrder` — `Operation.sortOrder` для именованных,
  `Number.MAX_SAFE_INTEGER` для pending (всегда последняя).

`Σ values(row.sewingByOp) === row.qtySewing` (инвариант).

### 6.4 Маршрутный `sewingRoute[]` с `▶/✔`

Источник: `buildSewingRoute(passports, routeSteps, sizes,
orderItemSizes)` в `shopfloor.service.ts`.

Для каждой уникальной sewing-операции, упомянутой в snapshot
маршрута активных заказов, формируется
`ShopfloorDisplayRouteOperationDto`:

- `operationId / operationName / operationSortOrder`.
- `rows: ShopfloorDisplayRouteSizeRowDto[]` — построчно по
  `Size.code`:
  - `inProgress` (▶) = `Σ qtyCut` у паспортов, которые
    физически сейчас в работе на этой sewing-операции.
    Resolver: операция активной смены швеи (после
    `issueToEmployee`) → fallback на последний
    `OPERATION_SCAN`. Гварды: `status = IN_PROGRESS`,
    `currentEmployeeId !== null`.
  - `done` (✔) = `Σ qtyCut` у паспортов, ЗАВЕРШИВШИХ эту
    sewing-операцию и ожидающих перехода к следующему step'у:
    `currentEmployeeId === null`, `status = IN_PROGRESS`,
    `currentRouteStepIndex === step.index`.

Семантика — это **текущее накопление WIP**, а не исторический
факт «когда-то выполнено». Как только следующий step делает
`OPERATION_SCAN`, `currentRouteStepIndex` сдвигается, и ✔
старого step'а автоматически становится 0.

Виден весь маршрут активных заказов, даже если по операции
сейчас 0/0. Это нужно для UI-эвристики «узкое место»
(`docs/screens.md §9a.4`): подсветка СЛЕДУЮЩЕЙ операции
требует, чтобы пустая Киперка после Оверлока с накопленным
✔=32 оставалась видимой.

Дедупликация: одна и та же `operationId`, упомянутая в
маршрутах нескольких активных заказов, даёт ровно один блок
(rows — union размеров всех таких заказов; `▶/✔` — `Σ` по
всем заказам). Заказы без snapshot маршрута в агрегации не
участвуют.

### 6.5 Equipment status

`ShopfloorService.listEquipmentStatus` (см. большой блок
JSDoc выше):

- `ONLINE` — оборудование `active`, есть открытая
  `ShiftSession` И `currentSizes.length > 0` (на станке
  прямо сейчас лежит хотя бы один паспорт в работе).
- `WARNING` — `active` + открытая смена, но `currentSizes`
  пуст (швея зашла, но крой ещё не взяла / только что
  закончила).
- `OFFLINE` — нет открытой смены ИЛИ `Equipment.active = false`.

Раньше использовался time-based порог (15 мин по последнему
`OPERATION_SCAN`), но он давал ложно зелёный сигнал на TV.
Теперь backend источник — однозначный признак из
`currentSizes` (тот же, что и `▶`-колонка sewing-маршрута).

Поле `lastActivityAt` сохранено в DTO — диагностический
ISO-timestamp последнего `OPERATION_SCAN` сотрудника, не
управляет цветом плитки.

`hasOpenMasterCall` — `true`, если по этому оборудованию есть
открытый `MasterCall` с `equipmentId = eq.id` и
`status = OPEN`. UI большого монитора подсвечивает плитку
мягким violet/blue pulse через CSS-класс
`display-equipment-tile--master-call`.

### 6.6 Orphan master calls

`orphanMasterCalls[]` — открытые `MasterCall` без
`equipmentId` (рабочий нажал «Мастер» вне станка). UI рисует
их отдельным блоком; пустой массив — нормальное состояние,
блок скрывается.

---

<a id="7-dto"></a>
## 7. Полезный контракт `ShopfloorDisplayDto`

```ts
interface ShopfloorDisplayDto {
  updatedAt: string; // ISO момента формирования ответа
  kpi: ShopfloorDisplayKpiDto;
  colors: ShopfloorDisplayColorBlock[];
  totals: ShopfloorDisplayMatrixSummary;
  sewingColumns: ShopfloorDisplaySewingColumnDto[];
  equipment: ShopfloorEquipmentStatusDto[];
  sewingRoute: ShopfloorDisplayRouteOperationDto[];
  orphanMasterCalls: ShopfloorOrphanMasterCallDto[];
}
```

Полные поля каждого DTO — `packages/shared/src/shopfloor.ts`.
Здесь — только инварианты.

- `colors` отсортированы: сначала канонические цвета
  (`SHOPFLOOR_DISPLAY_KNOWN_COLORS = { black: 'Чёрный',
  white: 'Белый' }`) в фиксированном порядке, затем остальные
  по алфавиту.
- `colors[].rows[]` отсортированы по `Size.sortOrder`.
- `totals = Σ colors[].totals` (по всем bucket-ам и `sewingByOp`).
- `Σ values(sewingByOp) === qtySewing` на любом уровне (row,
  color total, grand total).
- Ключи `sewingByOp` — подмножество
  `sewingColumns[].key`.
- `sewingRoute` может быть пустым, если ни в одном активном
  заказе нет snapshot маршрута с sewing-шагами.
- `updatedAt` — клиентский TV-board использует его для
  диагностики свежести данных в логах.

---

<a id="8-polling"></a>
## 8. Polling и degraded behavior (frontend)

Источник: `apps/web/app/shopfloor/display/display-board.tsx`
(полностью; полл-логика — строки ~50–595). ADR-0007.

### 8.1 Константы (фактические значения в коде)

| Константа | Значение | Назначение |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | `3000` ms | Базовый период polling в healthy-режиме. |
| `POLL_INTERVAL_DEGRADED_MS` | `15000` ms | Период polling в degraded/offline/auth-режимах (после первой же не-transient ошибки). |
| `FETCH_TIMEOUT_MS` | `6000` ms | Жёсткий timeout одного fetch-запроса (`AbortController`). |
| `MAX_SOFT_ERRORS` | `5` | После скольких подряд soft-ошибок (timeout / network / 5xx / parse) индикатор переключается в «Нет связи». |
| `MAX_NETWORK_GRACE` | `2` | Сколько подряд `network`-glitch'ей съесть молча, не накручивая `failures` и не уводя UI даже в `degraded`. |

> После PHASE 2.5 ADR-0007, `display-board.tsx` и этот документ
> синхронизированы по polling-константам:
> `POLL_INTERVAL_MS = 3000 ms`,
> `POLL_INTERVAL_DEGRADED_MS = 15000 ms`,
> `FETCH_TIMEOUT_MS = 6000 ms`,
> `MAX_SOFT_ERRORS = 5`. Источник истины — код
> (`apps/web/app/shopfloor/display/display-board.tsx`); ADR-0007
> и этот раздел зеркалируют его.

### 8.2 Состояния polling-цикла

| Состояние | Cadence | Шапка | Триггер |
| --- | --- | --- | --- |
| `online` | `POLL_INTERVAL_MS = 3 c` | «онлайн» (зелёный) | `failures = 0` И нет `authError`. |
| `transient` | без изменений (см. `online`) | без изменений | первые `MAX_NETWORK_GRACE = 2` подряд `network`-glitch'ей. Только `network`-ветка; для timeout/server/parse обычная degraded-логика. |
| `degraded` | `POLL_INTERVAL_DEGRADED_MS = 15 c` | «обновление замедлено» (жёлтый) | `0 < failures < MAX_SOFT_ERRORS = 5`. |
| `offline` | `POLL_INTERVAL_DEGRADED_MS = 15 c` | «Нет связи» (красный, snapshot жив) | `failures >= MAX_SOFT_ERRORS`. |
| `auth` | `POLL_INTERVAL_DEGRADED_MS = 15 c` | «Сессия истекла» (жёлтый, snapshot жив) | HTTP 401/403. Auth НЕ инкрементирует `failures` — отдельный сигнал. |

### 8.3 Классификация ошибок (`FetchErrorKind`)

- `timeout` — наш `AbortController` сработал по
  `FETCH_TIMEOUT_MS`.
- `network` — `fetch` упал до получения HTTP-ответа
  (DNS / CORS / обрыв / `net::ERR_NETWORK_CHANGED`).
- `auth` — HTTP 401/403.
- `server` — HTTP 5xx.
- `client` — прочие 4xx (теоретически не должно быть на
  read-only эндпоинте, но классифицируем явно).
- `parse` — HTTP 200, но тело не валидный JSON.

### 8.4 Retained snapshot

Последний УСПЕШНО полученный `ShopfloorDisplayDto`
**никогда не очищается** ошибкой и продолжает отрисовываться
даже в degraded / offline / auth. Меняется только индикатор в
шапке. Это критично: read-only монитор не должен гасить
цифры из-за единичного 502.

Любой успешный ответ моментально:

- сбрасывает `failures = 0` (и индикатор → `online`);
- снимает `authError`;
- сбрасывает `networkGraceUsed = 0` (подушка для transient
  glitch'ей).

### 8.5 Recursive scheduler

Используется `setTimeout`-based recursive scheduler (а не
`setInterval`). Следующий tick ставится только из `finally`
текущего:

```ts
const scheduleNext = (): void => {
  const interval =
    failuresRef.current > 0 ? POLL_INTERVAL_DEGRADED_MS : POLL_INTERVAL_MS;
  timerRef.current = setTimeout(() => {
    void refresh().finally(scheduleNext);
  }, interval);
};
```

- Запросы не наслаиваются (даже если `FETCH_TIMEOUT_MS >
  POLL_INTERVAL_MS`).
- `inFlightCtrlRef` дополнительно защищает immediate refresh
  на mount от гонки с первым scheduled tick'ом.

### 8.6 Page Visibility recovery

При уходе вкладки/окна в background браузер throttle-ит
`setTimeout` (часто до ≥ 60 c) — на TV это означает, что после
sleep / переключения HDMI экран мог бы ложно показывать «Нет
связи» из-за всплеска накопившихся таймеров.

`onVisibilityChange = visible` → cancel текущего scheduled
tick'а + один forced `refresh()` + перезапуск `scheduleNext`
из его `finally`. Никаких новых состояний и редиректов.

### 8.7 Debug-канал

`dlog()` печатает компактный payload в `console.log` с префиксом
`[DISPLAY]`:

```
{ status, errorKind, failures, failuresAfter,
  networkGraceUsed, authError, requestUrl,
  errorName, errorMessage, online, visibility,
  updatedAt? }
```

Цель — на реальном TV / WebView без подключения DevTools
можно через chrome-remote-debugging увидеть, в каком
состоянии экран и какой именно URL он дёргает.

---

<a id="9-layout"></a>
## 9. Layout constraints для TV / WebView

Источник: `apps/web/app/globals.css` (~4015–4250) +
`apps/web/app/shopfloor/display/display-board.tsx`.

### 9.1 Цепочка `min-height: 0`

Главный фикс TV/fullscreen geometry — каскад `min-height: 0`
по цепочке flex/grid item-ов:

```text
.display-screen → .display-board → .display-board__production /
                                  .display-board__equipment   →
.display-block → .display-matrix__scroll
```

Каждый из этих селекторов в `globals.css` имеет
`min-height: 0` (плюс часто `min-width: 0`):

- `.display-board { display: grid; grid-template-columns:
  minmax(0, 2fr) minmax(320px, 1fr); min-height: 0;
  min-width: 0; }` — матрица слева (растягивается),
  оборудование справа (минимум 320px, до 1fr).
- `.display-board__production`, `.display-board__equipment`
  — `display: flex; flex-direction: column; min-height: 0;
  min-width: 0;`.
- `.display-board__production > .display-block`,
  `.display-board__equipment > .display-block` —
  `flex: 1 1 auto; min-height: 0; min-width: 0;`.
- `.display-block` — `overflow: hidden;
  display: flex; flex-direction: column; min-height: 0;`.
- `.display-matrix__scroll` —
  `flex: 1 1 auto; min-height: 0; display: block;
  overflow: auto; contain: layout paint;`.

**Почему это критично.** Без `min-height: 0` flex/grid items
получают неявный `min-height: auto`, равный intrinsic height
содержимого (длинная таблица матрицы). Тогда внешний
`.display-block { overflow: hidden }` срезает матрицу так, что
на экране остаются только заголовки — ровно то, как выглядел
TV до этого фикса.

`.display-matrix__scroll` дополнительно ставит
`display: block` (а не унаследованный flex/grid), потому что
sticky `<th>` требует устойчивого block-formatting контекста
для scroll-ancestor; и `contain: layout paint;` — на TV WebKit
это даёт более предсказуемый sticky без «прыгающих»
заголовков.

### 9.2 Breakpoint `@media (max-width: 1199px)`

```css
@media (max-width: 1199px) {
  .display-board {
    grid-template-columns: 1fr;
  }
}
```

Под 1200px grid схлопывается в одну колонку (матрица сверху,
оборудование под ней). На 1080p TV (1920×1080) это **не**
должно срабатывать; именно поэтому `display-board.tsx` в
`useEffect`-mount пишет `dlog({ kind: 'viewport', width,
height, dpr, tier })` — чтобы по логу удалённого WebView сразу
увидеть, не попал ли экран в mobile-брейкпоинт (наложенный
chrome / custom DPR / нестандартный resolution). Поле `tier`
считает `viewportTier()` — это ЗЕРКАЛО css-слоёв из §9.4,
на раскладку оно не влияет и правится вместе с брейкпоинтами.

Этот же breakpoint используется ещё в нескольких местах
`globals.css` (см. строки ~9126, ~9560, ~10670, ~10970,
~11081, ~11678, ~13107) — для других экранов (admin,
forms, dashboards), не только для display.

### 9.4 Адаптивные слои («под каждый экран»)

Секция `globals.css` → «Адаптив монитора». Один и тот же URL
открывают с очень разных устройств, поэтому слоёв шесть:

| Слой | Условие | Поведение |
|---|---|---|
| `phone` | `max-width: 767px` | шапка в две строки (`brand clock` / `meta`), плотные KPI 4×2, мелкие плитки станков |
| `compact` | `max-width: 1199px` **и** `max-height: 1399px` | планшет/узкий ноутбук: строки грида по `max-content`, экран скроллится ВНУТРИ себя |
| `desktop` | 1200–1599px | базовые правила, без изменений |
| `tv` / `tv-4k` | `min-width: 1600px` / `2400px` | апскейл шрифтов, board остаётся 2-колоночным (§9.2 выше) |
| `portrait-kiosk` | `orientation: portrait` **и** `min-height: 1400px` | TV, повешенный вертикально (1080×1920, 2160×3840): киоск без внешнего скролла, board стопкой `1.5fr / 1fr`, шрифты как на TV |
| низкий экран | `max-height: 560px` | телефон в ландшафте / панель-«полоса»: ужатые шапка и KPI (при ширине ≥ 720px — 8 карточек в один ряд), матрице отдаётся 72dvh |

Два режима поведения:

- **киоск** (`desktop`, `tv`, `tv-4k`, `portrait-kiosk`) — экран
  никогда не скроллится целиком, `fixed; inset: 0`, скроллятся
  только матрица и сетка оборудования (цепочка `min-height: 0`,
  §9.1);
- **ручной** (`phone`, `compact`, низкий экран) — контент выше
  вьюпорта скроллится ВНУТРИ `.display-screen`
  (`overflow-y: auto`; сам `<body>` заблокирован правилом
  `body:has(.display-screen) { overflow: hidden }`).

**Почему `grid-template-rows: max-content`, а не `auto`.** У грида
с определённой высотой (`100dvh`) `auto`-строки ужимаются до
min-content, а min-content матрицы равен нулю — по всей цепочке
стоит `min-height: 0` (§9.1). В результате при схлопывании board'а
в одну колонку матрица сплющивалась в ~16px вместо того, чтобы
переполнить экран и дать себя проскроллить, а панель оборудования
уезжала под `overflow: hidden` и была недостижима вообще.

**Липкая колонка «Размер».** `.display-matrix__row-label` и
«угловой» `.display-matrix__th--first` липнут по оси X
(`position: sticky; left: 0`), z-index'ы: обычные ячейки → метка
строки (1) → sticky-шапка (2) → угол (5). Заголовок цветовой
группы растянут `colSpan`'ом на всю таблицу, поэтому липнет не
сама ячейка, а вложенный `.display-matrix__color-label-inner`.
Без этого при горизонтальном скролле (телефон — всегда, TV — на
маршруте из 8+ операций) цифры теряли «адрес».

**Нижняя `.mobile-nav`.** На `/shopfloor/display` глобальный
header скрыт для всех ролей, поэтому у ADMIN/SHOP_MANAGER с
телефона мобильное меню — единственный способ уйти со страницы.
Оно `fixed` и с `z-index: 25` (выше витрины), поэтому под ≤ 900px
`body:has(.mobile-nav) .display-screen` резервирует 120px снизу
(6 пунктов при сетке в 4 колонки = две строки). У учётки `DISPLAY`
меню не рендерится вовсе — `:has()` не даст лишний отступ на
зальном киоске.

### 9.3 Sticky-заголовки и border-collapse

- `.display-matrix { border-collapse: separate;
  border-spacing: 0; font-variant-numeric: tabular-nums; }`
  — `separate` нужен, потому что `collapse` ломает
  `border-left/right` на соседних split-колонках
  (`display-matrix__op-divider`, `display-matrix__cut/qc/wto-divider`).
- `.display-matrix__th { position: sticky; top: 0;
  background: var(--display-bg-soft); background-clip:
  padding-box; z-index: 2; }` — непрозрачный фон + clip
  обязательны, иначе при скролле под заголовком
  просвечивают строки данных.

---

<a id="10-risks"></a>
## 10. Aggregation risks

### 10.1 Расхождение KPI и матрицы

Раньше экран собирал данные из 4 endpoint'ов и довычислял
проекцию по цветам на клиенте. Это давало гонку: «выпустили
паспорт, KPI обновился, а матрица отстала на 1 цикл».

Перенос агрегации на backend через `getDisplaySummary`:

- KPI и матрица всегда из **одного снимка** (нет рассинхрона);
- одна `Promise.all`-волна за паспортами и оборудованием — те
  же данные используются и для bucket-ов, и для KPI.

### 10.2 Свежесть `QC_PASSED` / `WTO_PASSED`

`groupBy` по `PassportEvent` ограничен списком id паспортов-
кандидатов (`IN_PROGRESS` + `category ∈ {QC, IRONING}`),
чтобы поллинг каждые 3 секунды не превращался в скан всей
таблицы событий. На длинной истории это критично — иначе
запрос рос бы линейно с числом обработанных паспортов.

### 10.3 Cold-start заказ без паспортов

`sewingRoute` строится по `OrderRouteStep` всех активных
заказов (берём через `Order` напрямую с тем же фильтром, что
и `passports`-выборка). Раньше использовались только orderId
живых паспортов, и активный заказ без паспортов исчезал из
sewingRoute — тогда UI-эвристика «следующая пустая операция
= узкое место» теряла подсветку. Сейчас инвариант:
«есть активный order + route snapshot → его операции
ОБЯЗАНЫ быть в sewingRoute».

`orderItemSizes` (`Map<orderId, Set<sizeId>>`) используется как
fallback в `buildSewingRoute`, когда у заказа нет ни одного
живого паспорта (все PACKED/CANCELLED или ещё не выпущены) —
иначе блок операции получил бы `rows = []`, и оператор не
понимал бы, под какой размер ждать загрузку.

### 10.4 Дедупликация по `operationId`

Одна и та же sewing-операция в маршрутах разных активных
заказов даёт ровно ОДИН блок в `sewingRoute`. Это
сознательное решение: TV-оператор видит операцию как
«производственный шаг», а не как «заказ A × шаг 3» и
«заказ B × шаг 2». Если нужна детализация по заказам —
менеджер открывает `/shopfloor` (с `?orderId=...`).

### 10.5 PACKING ≠ настоящая стадия паспорта

`PACKING`-bucket — **MVP-аппроксимация**: у паспорта нет
отдельного `PassportStatus.PACKING`. Считаем «в упаковке
прямо сейчас» = «в OPEN-коробке» (`status = PACKED` AND
`box.closedAt IS NULL`). См. ADR-0013 §«Аппроксимация
колонки PACKING»:

```text
PACKING  = Σ qtyGood по PACKED-паспортам, у которых хотя бы один
           BoxItem.box.closedAt IS NULL
FINISHED = Σ qtyGood по PACKED-паспортам, не попавшим в PACKING
```

Если в будущем появится промежуточный `PassportStatus`,
правило в `bucketOf` обновится без миграции дисплея.

### 10.6 Polling vs realtime

ADR-0007: на MVP сознательно polling, не WS/SSE. Trade-off:

- (+) Простой деплой и отладка через любые прокси.
- (+) `/shopfloor/display` переживает короткие glitch'и сети
  без потери последнего успешного снимка и без «мерцания»
  индикатора (см. §8).
- (−) В healthy-режиме ~20 запросов в минуту с DISPLAY-планшета
  (`60_000 / POLL_INTERVAL_MS` = 60_000 / 3000 = 20). В
  degraded — 4 в минуту. Для цеха (5–20 планшетов) это
  нормально.

После MVP — переезд на SSE (`/api/shopfloor/stream`), без
смены фронта (wrapper с одинаковым интерфейсом «подписаться
на состояние»).

---

## Что осталось UNKNOWN/TODO

- Точный набор edge-кейсов `bucketOf` для CUT-rollback мастера
  (`MasterActionsService.setRouteStep` назад до CUT_DIVISION
  с одновременным placement в ячейку): описан в коде
  `shopfloor-projection.ts §bucketOf` (строки ~155–164),
  но конкретный сценарий мастер-action в `production-flow.md`
  оставлен UNKNOWN/TODO до ревизии master-actions.
- Полные правила построения `sewingByOp` для pending (когда
  `currentOperation = null` или `category = CUTTING`) —
  смотри `projectShopfloorDisplay` целиком.
- Поведение фильтра `?divisionCode` для пользователя
  `DISPLAY` с `DisplayScreenConfig.isActive = false`:
  фактически возвращает «общий» агрегат — мягкий выключатель
  экрана. Если в будущем потребуется явно блокировать такой
  экран, нужно либо вернуть отдельную ошибку, либо схлопнуть
  до пустого query (UNKNOWN/TODO).
- Сводный список flash-классов матрицы (`shopfloor-flash-up`
  / `shopfloor-flash-down`) и алгоритм `computeChangedCellKeys`
  — реализованы в `display-board.tsx`. PHASE 2 не дублирует.
