# Бизнес-потоки

> ⚠️ **Статус документа: OUTDATED (PHASE 1, 2026-Q2)** ⚠️
>
> PHASE 2 (2026-Q2) **завершён**: runtime-потоки заказа,
> паспорта и большого монитора вынесены в три новых документа.
> Этот файл оставлен как исторический контекст; ссылки
> `§F0..§F13` остаются валидными внутри ADR и комментариев в
> коде, но **не являются source of truth** — при расхождении
> верим коду и новым документам.
>
> Источники истины (PHASE 2):
>
> - **Заказ** ([`docs/order-flow.md`](./order-flow.md)) —
>   `OrderStatus`, `startCalculation` / `completeCalculation` /
>   `reopenCalculation` / `start` / `complete` / `cancel`,
>   `syncOrderRouteStepsSnapshot()`,
>   `rebuildMaterialRequirementsSnapshot()`, план операций,
>   `OrderCostEstimate`, `WorkshopNeed`, production balance,
>   cut-readiness, material-arrival overrides, cut-release
>   policy, outsource statuses (`MANUAL` / `CUT_READY`).
> - **Паспорт** ([`docs/production-flow.md`](./production-flow.md))
>   — `PassportStatus`, `PassportEvent` / `PassportEventType`,
>   `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`,
>   `Box` / `BoxItem` / `PACKED`, `OperationEntry` (моменты
>   pending / APPROVED — финальный апрув на `Box.close()`),
>   `SalaryEntry`, master actions / master calls, связь с
>   shopfloor buckets.
> - **Большой монитор**
>   ([`docs/display-board.md`](./display-board.md)) —
>   `/shopfloor/display`, `GET /api/shopfloor/display`,
>   `DisplayScreenConfig`, DISPLAY-учётка, polling /
>   degraded / timeout / visibility recovery, bucket mapping,
>   `sewingColumns` / `sewingRoute (▶/✔)`, layout-цепочка
>   `min-height: 0`, breakpoint `max-width: 1199px`,
>   aggregation risks.
>
> Дополнительные источники: контроллеры
> (`apps/api/src/modules/**/*.controller.ts`) и Prisma-схема
> (`prisma/schema.prisma`). Краткая карта routes — `docs/api.md`,
> карта моделей — `docs/erd.md`.
>
> Содержимое ниже **не переписано и не удалено** в PHASE 2 (по
> правилу «`flows.md` остаётся как индекс-ссылка на новые
> документы, без переписывания старого тела»). Оно сохраняется
> как исторический контекст. Часть потоков (раскрой,
> производственная цепочка, экран цеха, расчёт-себестоимость,
> закупки, потребности цеха) уже разъехалась с реальной
> реализацией в `apps/api/src/modules/**` — для этих зон
> опирайтесь на новые документы PHASE 2 / на код, а не на
> §F2..§F13 ниже.

> Все потоки оперируют QR-кодами. Предварительные условия — активная
> `ShiftSession` (кроме SHOP_MANAGER/ADMIN).
> Предусловие на любой поток (MVP 1.1) — валидная session-cookie
> (см. F0). Identity сотрудника берётся из сессии, не из тела запроса.

---

## F0. Логин / выход / охрана маршрутов (MVP 1.1)

Реализовано на **Шаге 11 (Stabilization)** (`api.md §1`,
[ADR-0014](./adr/0014-auth-and-sessions.md)).

1. Сотрудник открывает любой защищённый маршрут (например, `/work`),
   `middleware.ts` Next.js не находит cookie `sewing_session` → редирект
   на `/login?next=/work`.
2. На `/login` он вводит `login` + `password`. Server action вызывает
   `POST /api/auth/login`. API проверяет `bcrypt.compare(password, pinHash)`,
   при успехе подписывает payload `{ sub: employeeId, role, exp }` HMAC-SHA256
   и возвращает заголовок `Set-Cookie: sewing_session=<base64>.<sig>`.
3. Server action парсит `Set-Cookie` и кладёт куку также в `cookies()` Next-а
   — после этого все RSC и server actions работают авторизованно.
4. На каждом API-запросе `AuthGuard`:
   - читает cookie через `parseCookieHeader`;
   - проверяет подпись/срок (`verifySession`);
   - подтягивает свежие `role`/`active` из БД (Employee может быть
     деактивирован между запросами);
   - кладёт `AuthPrincipal` в `request.user` для `@CurrentUser()`.
5. Декоратор `@Roles(...)` выполняет RBAC после `AuthGuard`. ADMIN — wildcard.
6. `POST /api/auth/logout` идемпотентен — выставляет `Max-Age=0` для
   cookie. Server action на UI дополнительно чистит её в `cookies()`.

Что НЕ делаем на этапе:

- refresh-токенов нет — TTL 12 часов; перезаход явный;
- multi-device session-list нет;
- 2FA нет;
- внешних identity provider-ов нет.

---

## F1. Создание заказа (SHOP_MANAGER / ADMIN)

Реализовано на **Шаге 4 MVP** (см. `docs/api.md §4` и `docs/screens.md §7`).

1. `POST /api/orders` создаёт `Order { number, orderDate, comment?, customer?, dueDate? }`
   в статусе `DRAFT`. Номер автогенерируется (`O-YYYYMMDD-NNNN`).
2. В той же транзакции создаются `OrderItem[]` (product × size × qtyPlan).
   Правила: `qtyPlan > 0`, размер уникален в рамках заказа, все строки
   одного заказа относятся к одному `productId`.
3. `PATCH /api/orders/:id` доступен только в `DRAFT` — можно править шапку
   и полностью заменять состав строк.
4. `POST /api/orders/:id/start` переводит заказ в `IN_PRODUCTION`. После
   этого любая попытка правки возвращает 409 `ORDER_LOCKED` (ADR-0006).
5. `POST /api/orders/:id/complete` — ручной перевод `IN_PRODUCTION → DONE`.
   Автоматический перевод (по факту упаковки всех паспортов) появится
   после Шага 7/8.
6. `POST /api/orders/:id/cancel` — отмена заказа из `DRAFT` или
   `IN_PRODUCTION`.

**Важно:** после `IN_PRODUCTION` `OrderItem.qtyPlan` **не меняется**.

**Подразделение заказа (`Order.division`).** На форме создания
(`/orders/new`) и в форме правки `DRAFT`-заказа (`/orders/[id]/edit`)
есть select «Подразделение» (`MARKETPLACE` / `OTHER`, значения
из `ORDER_DIVISIONS`). Дефолт — `OTHER`. После `start()` поле
блокируется тем же `ORDER_LOCKED` guard'ом, что и остальные поля
шапки, отдельной проверки нет. `division` потом используется
только как фильтр большого экрана `/shopfloor/display?division=…`
(см. F-flow «Большой монитор» в `screens.md §9a` и
`docs/domain.md §9.6.2`). Пер-passport / per-route / payroll он
сознательно не задействует.

---

## F2. Раскрой и создание паспорта

Актёры: **Раскройщик** (CUTTER) + **Помощник раскройщика** (CUTTER_ASSISTANT).

Реализовано на **Шаге 5 MVP** (см. `docs/api.md §5` и `docs/screens.md §8`).

0. **Старт смены помощника на оборудовании.** Помощник открывает
   `/work`. Если активной `ShiftSession` нет — UI рендерит
   `<SeamstressShiftStart>` (тот же mobile-first scan-driven flow,
   что и у швеи): QR-код раскройного стола → выбор разрешённой
   операции из `equipment.allowedOperationIds` (источник истины —
   таблица `EquipmentOperation`, ADR-0017) → `POST /api/shifts/start`.
   Только после успешного старта `<CutterAssistantWorkPanel>`
   показывает action-cards «Выпустить паспорт» / «Разместить на
   стеллаж». Это нужно для печати: `print-jobs.service.ts:resolvePrinter`
   выбирает принтер по `equipmentId` активной смены и без неё
   возвращает `SHIFT_SESSION_REQUIRED`.
1. Раскройщик выполняет операции `CUT_PATTERN_PRINT → CUT_SPREADING → CUT_CUT`
   (фиксация этих операций появится позже — Шаг 6).
2. На операции `CUT_DIVISION` Помощник на странице
   `/orders/[id]/passports/new` вводит: размер из заказа, дату кроя, qtyCut,
   номер рулона.
3. `POST /api/passports` в одной транзакции:
   - проверяет, что заказ в `IN_PRODUCTION` (ADR-0010), размер входит в
     заказ и `qtyCut ≤ qtyPlan − Σ выпущенного` (ADR-0006);
   - создаёт `Passport (status=CREATED, currentOperation=CUT_DIVISION,
     qtyPlan=qtyCut, qtyDefect=0, qtyGood=qtyCut)`;
   - автогенерирует `number = P-YYYYMMDD-NNNN`;
   - пишет `PassportEvent(CREATED, qty=qtyCut, employeeId=creatorId)`;
   - проставляет `qrCode = passport:{id}` (ADR-0008).
4. Сразу после успешного создания паспорта помощник видит
   **компактный post-create блок** прямо на той же странице
   `/orders/:id/passports/new`, без перехода в большую карточку
   `/passports/:id`. Server action `createPassportAction` для роли
   `CUTTER_ASSISTANT` стартует в режиме `mode = 'inline'`
   (передаётся через `bind()` со страницы — источник истины роль
   на сервере, не клиентское поле формы) и вместо `redirect`
   возвращает `success` со снимком паспорта. UI рендерит
   `CutterAssistantSuccessCard` с двумя действиями одного уровня:
   - **«Распечатать паспорт»** — переиспользует общий
     `<PrintButton sourceType="PASSPORT_PRINT" sourceId={passport.id}
     fallbackHref={buildPassportPrintPath(passport.id)} />`. Тот же
     путь, что и в hero-блоке `/passports/:id`: сначала
     `POST /api/print-jobs` (принтер выбирается по `equipmentId`
     активной смены), при `SHIFT_SESSION_REQUIRED` /
     `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT` — открываем печатную
     HTML-форму `GET /api/passports/:id/print` в новом табе. Никакого
     отдельного print subsystem для /work не вводим.
   - **«Выпустить следующий»** — сбрасывает `useFormState` через
     перемонтирование внутреннего компонента (key-bump в обёртке
     `NewPassportForm`) и возвращает пустую форму на той же
     странице. Заказ остаётся выбранным (помощник продолжает
     серийный выпуск по тому же заказу), `qtyCut` и `rollNumber`
     сбрасываются, размер выбирается заново как «первый с
     остатком > 0». Если нужно перейти к другому заказу — есть
     ссылка на `/work/cut-orders` в hint-блоке внизу.

   Прямая ссылка на `/passports/:id` в этом блоке скрыта в
   мелком hint — большая карточка остаётся доступной для ОТК и
   детального просмотра, но рабочее место помощника туда
   автоматически не уходит.

   Менеджеры (`SHOP_MANAGER` / `ADMIN` / `CUTTER`) на той же
   странице получают прежний UX: `mode = 'redirect'` → переход
   на `/passports/:id`. Нажатие «Печать» там работает так же
   (`POST /api/print-jobs` + fallback на печатную HTML-форму).

**Зарплата раскройщика (Шаг 9 — реализовано).** По
[ADR-0005](./adr/0005-salary-timing.md) начисление возникает в момент
создания паспорта. В транзакции `PassportsService.create` после
`PassportEvent(CREATED)` вызывается
`EarningsService.createImmediateForCutter` →
`OperationEntry { passportId, employeeId=cutterId, operationId=CUT_CUT,
qty=qtyCut, ratePerUnit, amount, status=APPROVED, approvalMode=IMMEDIATE,
sourceEventType=PASSPORT_CREATED, approvedAt=now() }`. Если для пары
`(CUT_CUT, sizeId)` нет действующей `PieceRate` — транзакция откатывается
с 422 `PIECE_RATE_NOT_FOUND` (silent-skip отключён сознательно — см.
ADR-0005). Идемпотентность гарантирует
`@@unique(passportId, operationId, employeeId, sourceEventType)`
(ADR-0012).

**ADR:** [ADR-0005](./adr/0005-salary-timing.md), [ADR-0008](./adr/0008-qr-format.md),
[ADR-0010](./adr/0010-passport-print-and-placement.md).

---

## F3. Размещение кроя в ячейке

Реализовано на **Шаге 5 MVP**.

1. Помощник на `/passports/[id]` в форме «Разместить в ячейке» выбирает
   ячейку из списка `GET /api/cells` (или вводит код вручную).
2. `POST /api/passports/:id/place` в одной транзакции:
   - проверяет, что паспорт в `CREATED` и ещё не размещён
     (`currentCellId IS NULL`);
   - проверяет, что ячейка существует и `active = true`;
   - upsert `CellContent(cellId, sizeId).quantity += passport.qtyCut`;
   - проставляет `Passport.currentCellId`;
   - пишет `PassportEvent(CELL_PLACED, cellId, qty=passport.qtyCut)`;
   - **не меняет** `currentOperation` (ячейка — хранение, не этап).

> MVP-ограничение: один паспорт = одна текущая ячейка. Перемещение между
> ячейками, частичное размещение и split/merge паспортов — за рамками
> Шага 5 (см. [ADR-0004](./adr/0004-simplified-cells.md) +
> [ADR-0010](./adr/0010-passport-print-and-placement.md)).

---

## F3b. Shelf-placement session «Разместить крой на стеллаж» (CUTTER_ASSISTANT)

Реализовано на **Шаге 13.3** (`apps/web/app/work/shelf-placement-panel.tsx`,
`docs/screens.md §3.8`).

**Актёр.** Помощник раскройщика (CUTTER_ASSISTANT). Сама API-операция
`passports.place` активную `ShiftSession` не требует (как и
`passports.create`), но в UI flow помощник попадает на эту панель
только после старта смены через QR оборудования (см. F2 §0,
`apps/web/app/work/page.tsx`). Это даёт корректный equipment-context
для печати и одинаковую модель «работа = смена → оборудование →
операция → действия» со всеми остальными рабочими ролями.

**Цель.** Дать помощнику быстрый scan-driven сценарий: один раз
сканируешь и подтверждаешь ячейку — дальше сканируешь паспорта в эту
ячейку один за другим, без возврата к выбору ячейки между паспортами.

**Сценарий:**

1. Помощник на `/work` нажимает «Разместить на стеллаж» — открывается
   `<QrScannerModal>` для скана ячейки.
2. Сканирует QR ячейки (формат `cell:{id}` по
   [ADR-0008](./adr/0008-qr-format.md)). Web вызывает
   `POST /api/cells/by-code` (см. `docs/api.md §7`) — backend проверяет
   существование и `active`-флаг и возвращает `CellDetailDto`.
3. Web показывает confirm-модалку с кодом ячейки, QR и срезом
   `(sizeCode × quantity)`. Помощник видит, в какую ячейку он сейчас
   будет класть.
4. Тап «Подтвердить ячейку» → переход в session-режим
   «Сканируйте паспорта в ячейку X».
5. Каждый последующий скан паспорта вызывает
   `POST /api/passports/by-code` + `POST /api/passports/:id/place
   { cellId }`. Транзакция размещения — та же, что у F3 (упрощённая
   форма «по одному паспорту»).
6. На SUCCESS: короткая вибрация + звук «крой принят», паспорт
   попадает в верхушку ленты «Размещено» (последние 5).
7. На ошибке (`PASSPORT_NOT_FOUND`, `PASSPORT_NOT_PLACEABLE`,
   `PASSPORT_ALREADY_PLACED`, `CELL_INACTIVE` и т.д.) показываем
   `error-box` с `requestId`, **session не разрывается** — помощник
   может пересканировать паспорт или взять следующий.
8. Кнопка «Готово» завершает session-режим и возвращает к двум
   action-card на `/work`.

**ADR / правила.** Никаких новых бизнес-правил не вводится — это
тонкая UI-надстройка над уже существующими `passports.place`,
`passports.findByCode` и новым `passports.findCellByCode`. Backend
остаётся источником истины: web-flow перед confirm-модалкой обязан
получить `200` от `/api/cells/by-code`, а каждое размещение
обрабатывается серверной транзакцией F3.

---

## F3a. Выдача кроя швее («Получить крой»)

Реализовано на **Шаге 6 MVP** (модуль `apps/api/src/modules/passports`,
экран `/work`).

**Актёр.** Швея (SEAMSTRESS) с активной `ShiftSession`. До появления
auth (Шаг 7) UI хранит выбранного демо-сотрудника в cookie
`demo-employee-id`.

**Сценарий:**

1. Швея открывает `/work`, выбирает себя из списка демо-сотрудников,
   выбирает оборудование и операцию, стартует смену.
2. Нажимает «Получить крой», сканирует/вводит код паспорта
   (QR `passport:{id}` по [ADR-0008](./adr/0008-qr-format.md), номер
   `P-…` или голый id).
3. Web делает `POST /api/passports/by-code` → получает `passportId`
   и затем `POST /api/passports/:id/issue { employeeId }`.
   - **Soft-route MVP (STEP 8 ТЗ).** Ответ `by-code` теперь несёт
     `routeHint` — текущий/следующий шаг маршрута заказа и сравнение
     с активной сменой. Web показывает блок «маршрут» в модалке
     `PassportConfirmModal` и, если `routeMismatchWithActiveShift`,
     рисует жёлтый информационный warning. **Никакой блокировки**:
     кнопка «Принять» остаётся доступной, backend не возвращает 409
     за «не туда сканировал». См. `docs/api.md §17` и `§5` (поле
     `routeHint`).

**Транзакция `PassportService.issueToEmployee`:**

1. Загружаем паспорт; бросаем `PASSPORT_NOT_FOUND` /
   `PASSPORT_ALREADY_PACKED` / `PASSPORT_CANCELLED` при терминальных
   статусах.
2. Проверяем активную смену сотрудника (`SHIFT_SESSION_REQUIRED`).
3. Дальше — две ветки в зависимости от того, лежит ли паспорт в
   ячейке (`currentCellId IS NOT NULL`):

   **A) Legacy / буферная ветка (`currentCellId IS NOT NULL`).** То же
   поведение, что и раньше. Применяется к заказам без маршрута и к
   маршрутным паспортам, которые после CUT_DIVISION/между шагами
   положили в ячейку как буфер:
   - `CellContent(cellId, sizeId).quantity = max(0, quantity − qtyCut)`;
   - `Passport.currentCellId = NULL`, `currentEmployeeId = :employeeId`,
     `status = IN_PROGRESS`;
   - `PassportEvent(ISSUED_TO_EMPLOYEE, operationId=session.operationId,
     employeeId, cellId=previousCellId, qty=qtyCut)`.

   **B) Route-WIP без ячейки (`currentCellId IS NULL`,
   `currentRouteStepIndex IS NOT NULL`).** Soft-route MVP, см.
   `docs/domain.md §18`: у заказа есть snapshot `OrderRouteStep[]`,
   значит паспорт уже в маршрутном потоке (индекс ставится при
   `Passport.create()`). Размещение на складе между маршрутными
   шагами **не обязательно**, поэтому:
   - `PASSPORT_NOT_IN_CELL` не кидаем;
   - `PASSPORT_ALREADY_ISSUED` кидаем только при реальном конфликте —
     `status = IN_PROGRESS` И `currentEmployeeId ≠ :employeeId`;
   - «висящий» creator (status=CREATED, паспорт только что выпущен
     помощником раскройщика после CUT_DIVISION) и пустой
     `currentEmployeeId` после `complete-operation` не блокируют
     приём — это и есть штатный route-flow перехват;
   - идемпотентно: тот же сотрудник на IN_PROGRESS → no-op (как у scan,
     ADR-0003 §6);
   - `Passport.currentEmployeeId = :employeeId`, `status = IN_PROGRESS`.
     `currentCellId` остаётся `NULL`. `currentOperationId` **не
     трогаем** — его обновит первый `scan` (см. F4).
   - `PassportEvent(ISSUED_TO_EMPLOYEE, operationId=session.operationId,
     employeeId, cellId=NULL, qty=qtyCut)`.

   **C) Без ячейки и без маршрута (`currentCellId IS NULL`,
   `currentRouteStepIndex IS NULL`).** Старое поведение полностью
   сохранено: либо `PASSPORT_ALREADY_ISSUED` (если есть
   `currentEmployeeId`), либо `PASSPORT_NOT_IN_CELL`.

**UI /work симметричен бэкенду.** UX «приёма кроя» подстроен под то
же правило route-WIP (`currentRouteStepIndex !== null`):

- В `PassportConfirmModal` при route-WIP появляется inline-бейдж
  «Из маршрута» рядом с номером паспорта. Если `currentCell = null`
  (типичный случай между маршрутными шагами) — вместо складской
  тревоги «ячейка не указана» рисуем спокойный subtext «Паспорт
  идёт по маршрутному потоку — ячейка не требуется» (`role="status"`,
  без alert). Кнопка «Принять» disabled только по `pending`.
- В блоке «Сейчас в работе» (`current-work-card.tsx`) для активных
  паспортов с `currentRouteStepIndex !== null` показывается тот же
  бейдж «Из маршрута».
- Подсказки «Получить крой» в обеих панелях (`SeamstressActivePanel`
  и дефолтной `ActiveShiftPanel` для CUTTER/админа) больше не
  утверждают, что ячейка обязательна. Backend сам выбирает ветку
  A/B/C.
- Для **заказов без маршрута** (ветка C) UI ничего не меняет:
  бейдж не рендерится, ячейка остаётся обязательной, а
  `ShelfPlacementPanel` для CUTTER_ASSISTANT по-прежнему доступен
  как обязательный шаг no-route-flow и опциональный буфер маршрутного
  flow. См. `docs/screens.md` подраздел «Route-WIP UX в /work».

UI-критерий совпадает с серверным: `Passport.currentRouteStepIndex
!== null`. Поля прокидываются через server action
`apps/web/app/work/actions.ts:lookupPassportAction` →
`PassportLookupResult.passport.currentRouteStepIndex` /
`currentCellCode` (см. `apps/web/app/work/state.ts`).

**ADR:** [ADR-0003](./adr/0003-event-sourcing-lite.md),
[ADR-0004](./adr/0004-simplified-cells.md),
[ADR-0008](./adr/0008-qr-format.md).

---

## F4. Перемещение паспорта на следующую операцию

Общий сценарий перехода на любую операцию (оверлок, киперка, ОТК, ВТО, …).

**Шаг 6 MVP (реализовано).** Упрощённый вариант: любое сканирование =
переход. Сотрудник на `/work` нажимает «Сканировать паспорт», вводит
код, web делает `POST /api/passports/by-code` + `POST
/api/passports/:id/scan`. В транзакции `PassportService.scanOnOperation`:

1. Загружаем паспорт; терминальные статусы → 409.
2. Проверяем активную смену (`SHIFT_SESSION_REQUIRED`).
3. Идемпотентность: если `currentOperationId == session.operationId`,
   `currentEmployeeId == employeeId` и `status == IN_PROGRESS` —
   возвращаем текущее состояние без нового события (ADR-0003 §6).
4. Обновляем `Passport.currentOperationId = session.operationId`,
   `currentEmployeeId = session.employeeId`, `status = IN_PROGRESS`.
5. Пишем `PassportEvent(OPERATION_SCAN, operationId=session.operationId,
   fromOperationId=previous, employeeId, qty=qtyGood)`.

**Начисление пошива (Шаг 9 — реализовано).** В той же транзакции
`PassportsService.scanOnOperation` после `PassportEvent(OPERATION_SCAN)`
вызывается `EarningsService.createPendingForPreviousOperation(
passportId, previousOperationId, previousEmployeeId, sourceEventId=event.id)`.
Если предыдущая операция оплатная (`Operation.pricingMode ≠ SALARY_ONLY`,
см. ADR-0020) и предыдущий исполнитель — сдельщик (доменная функция
`isPieceworkEligible(employee.compensationType)` — `true` для
`PIECEWORK`/`MIXED`, см. `apps/api/src/modules/employees/compensation.ts`
+ ADR-0021),
создаётся `OperationEntry { qty=passport.qtyCut, ratePerUnit,
amount, status=PENDING_RELEASE, approvalMode=AFTER_RELEASE,
sourceEventType=OPERATION_TRANSITION }`. Раскрой исключён — он уже
получил immediate-начисление в F2. Окладные роли (ОТК, ВТО, упаковка,
помощник раскройщика) в piecework вообще не попадают: `isPieceworkEligible`
возвращает `false` для `compensationType = SALARY` (silent skip).
Подтверждение — в F7 при **закрытии коробки** (ADR-0005).

Идемпотентность скан-сценария гарантируется на двух уровнях: повторный
скан той же сменой → no-op (ADR-0003 §6); даже если в обход
PassportsService возникнет повторная попытка — `OperationEntry_idem`
вернёт `P2002`, и `EarningsService.safeCreate` молча его проглотит
(см. ADR-0012).

`OPERATION_STARTED` / `OPERATION_FINISHED` / `MOVED` на MVP не пишутся —
выработку и начисления восстанавливаем из `OPERATION_SCAN`.

**Шаг 10+ (полноценная версия).** Тот же эндпоинт будет:

**Транзакция:**

1. Определить `fromOperationId = passport.currentOperationId`.
2. Определить `toOperationId = session.operationId`.
3. Записать `PassportEvent(OPERATION_FINISHED, fromOperationId)`.
4. Записать `PassportEvent(OPERATION_STARTED, toOperationId, employeeId)`.
5. Записать `PassportEvent(MOVED, from → to)`.
6. Обновить `Passport.currentOperationId = toOperationId`,
   `currentEmployeeId = session.employeeId`, `status = IN_PROGRESS`.
7. Создать начисление **исполнителю предыдущей операции** (если это пошив):
   `OperationEntry { operationId = fromOperationId, qty = passport.qtyGood, rate = …, status = PENDING }`.

   Исключение:
   - раскрой — начисление уже создано при CREATE (F2);
   - переход с `CUT_DIVISION` на `CUT_BASE_PREP` / `CUT_RIBANA_PREP` — не создаёт начисление (внутри раскроя);
   - с `CUT_ISSUE` — не создаёт (выдача кроя — просто передача партии);
   - окладные операции (`QC`, `WTO`, `PACKING`) — начисление не создаём вообще.

**Агрегаты** дашборда и экрана «Цех» вычитываются запросом из БД на лету
(количество паспортов в состоянии X по размеру Y).

---

## F5. ОТК и фиксация брака (терминал)

Актёр: **QC** (оклад). Реализовано в модуле `apps/api/src/modules/qc`.
Frontend — scan-driven role-terminal `/qc` (см. `docs/screens.md §5`,
`apps/web/app/qc/qc-terminal.tsx`); карточка `/qc/passports/[id]`
оставлена как fallback для менеджеров/админа.

**Сценарий (роль QC):**

1. Сотрудник ОТК открывает `/qc`. Страница SSR-подтягивает
   `getShiftMeta()` + `getCurrentShift()` (как `/packing`, см. F7) и
   решает, что показать:
   - **смены нет** → reuse-форма `SeamstressShiftStart`: большая
     primary-кнопка «Начать смену», скан QR рабочего места ОТК
     (например, `qc-station-01` из seed), затем выбор разрешённой
     операции из allow-листа `EquipmentOperation` (ADR-0017) — для
     qc-станции это одна операция `QC` — и `POST /shifts/start`
     (см. F2). Без этого шага все QC-action'ы упирались бы в
     `SHIFT_SESSION_REQUIRED`, потому что у роли QC нет другой
     страницы, где можно стартовать смену (`/work` редиректит в
     `/qc`, см. `getPrimaryWorkspace`);
   - **смена активна, но категория операции ≠ `QC`** (ОТК случайно
     открыл смену не на том станке) → банер «Смена не на ОТК» с
     подсказкой завершить смену через меню в правом верхнем углу.
     Скан-флоу намеренно не показываем — иначе scan подсадит паспорт
     в чужой `currentOperationId` и поломает shopfloor-проекцию;
   - **смена активна, категория `QC`** → штатный scan-flow ниже.
2. Сканирует QR паспорта (`passport:{id}` или просто номер
   `P-…`). Server-action `lookupQcPassportAction` сначала бьёт
   обычный `POST /api/passports/:id/scan` (вход на операцию
   категории `QC` — это переключает `passport.currentOperationId` и
   двигает паспорт в bucket `QC` на shopfloor-проекции, см. F11),
   а потом `GET /api/qc/passports/:id` и сразу раскрывает карточку
   паспорта под кнопкой. Полный аналог `acceptOnWtoAction` из F6:
   shift-gate теперь enforced на UI, но backend остаётся источником
   истины — если сессии нет (например, истекла между SSR и POST),
   карточка не откроется и UI покажет `SHIFT_SESSION_REQUIRED` как
   обычный error-box. Идемпотентность скана гарантирует backend
   (повторный скан того же паспорта на той же операции — no-op).
3. В карточке видит meta, цифры **Раскроено / Брак / Годных**, бейдж
   «Проверка выполнена · ⟨дата⟩» (если уже подтверждал паспорт
   раньше), форму «Зафиксировать брак» и кнопку
   **«Проверка выполнена»**.
4. При фиксации брака → `POST /qc/passports/:id/defects` (см.
   транзакцию ниже). После успеха карточка перерисовывается с новыми
   значениями.
5. По завершении проверки — нажимает **«Проверка выполнена»** →
   `POST /qc/passports/:id/complete`. В аудит пишется
   `PassportEvent(QC_PASSED)`. Действие идемпотентно: повторное
   нажатие создаёт новое событие (это полезно, если ОТК после
   фиксации дополнительного брака подтверждает повторно). `Passport.status`
   не меняется — ОТК это аудит-маркер, а не движение по pipeline.
   После успеха большая рабочая карточка **сворачивается** в одну
   компактную строку «Проверено ОТК · ⟨время⟩» (`QcCompletedRow`,
   см. `apps/web/app/qc/qc-completed-row.tsx`): паспорт ещё «висит»
   в окне как напоминание, но без кнопок «брак» / «проверка
   выполнена». Минимум содержимого — номер паспорта, размер, годное
   количество, бейдж «Проверено ОТК».
6. Когда тот же паспорт реально уехал дальше по pipeline — сотрудник
   на следующей операции сканирует его (`F4`), backend пишет
   `PassportEvent(OPERATION_SCAN)` с новым `operationId`. На
   следующем `getQcPassport` (поллинг каждые ~10 секунд или ручной
   refresh / новый скан) backend возвращает
   `removedFromQc = true`, и **схлопнутая строка исчезает из окна
   ОТК совсем**. То же самое для терминальных статусов
   (`PACKED`/`CANCELLED`) — паспорт уже не относится к ОТК. Логика
   решения — backend (`QcService.loadDetail`), фронт лишь
   подчиняется флагу.
7. «Сканировать другой паспорт» — очищает карточку и снова открывает
   QR-сканер. Терминал готов к следующему паспорту.

**Доступ.** RBAC разделяемый со всем `/api/qc/*`:
`QC`, `SHOP_MANAGER`, `ADMIN`. Подробнее — `docs/api.md §8`.

**Транзакция «Проверка выполнена» (`QcService.completeQc`):**

1. Загружаем паспорт; терминальные/`CREATED` статусы → 409
   `PASSPORT_NOT_QCABLE`.
2. Проверяем актора (404 / 409 — `EMPLOYEE_NOT_FOUND` / `EMPLOYEE_INACTIVE`).
3. `INSERT PassportEvent (type=QC_PASSED, qty=qtyGood,
   operationId=passport.currentOperationId, employeeId)`. Никаких
   обновлений `Passport.qty*`/`status`.
4. Возвращаем `QcPassportDetailDto` с обновлённым `qcCompletedAt`
   (= `createdAt` последнего `QC_PASSED`-события) и
   `removedFromQc = false` (см. ниже).

**Backend-флаг «паспорт ушёл из ОТК» (`removedFromQc`).**

`QcService.loadDetail` дополнительно вычисляет `removedFromQc:
boolean` — это источник истины для scan-driven терминала ОТК
(`apps/web/app/qc/qc-terminal.tsx`), который по нему скрывает
свернутую строку «Проверено ОТК». Правило простое и не вводит
нового workflow:

- если `qcCompletedAt = null` — `false` (терминал даже не показывал
  свернутую строку);
- если паспорт в терминальном статусе (`PACKED`/`CANCELLED`) —
  `true` (паспорт уже не «живой», ОТК его не касается);
- иначе ищем `PassportEvent(OPERATION_SCAN)` с
  `createdAt > qcCompletedAt`: если он есть — сотрудник на
  следующей операции уже подхватил паспорт (`F4`,
  `PassportsService.scanOnOperation`), и `removedFromQc = true`.

**Транзакция «Зафиксировать брак» (`QcService.recordDefect`):**

**Транзакция `QcService.recordDefect`:**

1. Загружаем паспорт; терминальные/`CREATED` статусы → 409
   `PASSPORT_NOT_QCABLE`.
2. Проверяем `defectType` (404 / 409) и сотрудника, если он передан
   (404 / 409 — `EMPLOYEE_NOT_FOUND` / `EMPLOYEE_INACTIVE`).
3. Проверяем границу `qty ≤ qtyCut − qtyDefect` (иначе 422
   `DEFECT_EXCEEDS_REMAINING`).
4. В одной транзакции:
   - `INSERT PassportDefect { passportId, defectTypeId, qty,
     comment, createdByEmployeeId }`;
   - `UPDATE Passport SET qtyDefect += qty, qtyGood = qtyCut − qtyDefect`;
   - `INSERT PassportEvent (type=DEFECT_RECORDED, qty,
     operationId=passport.currentOperationId, employeeId,
     payload={ defectId, defectTypeId, defectTypeCode,
     defectTypeName, comment })`.
5. Возвращаем обновлённую карточку (`QcPassportDetailDto`).

**Что не делается в текущем MVP ОТК:**

- Паспорт **не** переводится в терминальный статус, даже если
  `qtyGood = 0`. Можно отметить весь крой браком и продолжать
  историю в `PassportEvent`.
- Виновная операция не определяется. В `PassportEvent.operationId`
  пишется текущая операция паспорта на момент фиксации — этого
  достаточно для аудита, но не для расследования.
- Возврат брака в производство и split паспорта на отдельные
  подпаспорта по браку — за рамками MVP.
- Отдельного «ОТК-перехода» нет: после ОТК паспорт обычным
  скан-сценарием (F4) уезжает на ВТО/упаковку. `QC_PASSED` —
  лишь аудит-маркер, не движение по pipeline.

**Агрегация заказа.** `qtyDefect` по размеру и `qtyDefectTotal` в
`OrderSummary` берутся из `Σ Passport.qtyDefect` живых паспортов
(статус ≠ `CANCELLED`). См. `apps/api/src/modules/orders/order-aggregator.ts`.

---

## F6. ВТО (терминал, QC-gate)

Актёр: **IRONING** (оклад). Реализовано в модуле
`apps/api/src/modules/wto`. Frontend — scan-driven role-terminal `/wto`
(см. `docs/screens.md §5a`, `apps/web/app/wto/wto-terminal.tsx`).
Полный аналог ОТК-терминала из F5: одно рабочее окно, без списков,
паспорт открывается по QR. Карточка `/wto/passports/[id]` не нужна —
сотрудник ВТО работает только из терминала.

Принципиальная разница с F5 — на входе в ВТО есть **QC-gate**: пока по
паспорту нет ни одного `PassportEvent(QC_PASSED)`, backend отказывается
переключить `currentOperation` на категорию `IRONING`.
Источник истины — `PassportsService.scanOnOperation`, поэтому обойти
gate через прямой `POST /api/passports/:id/scan` нельзя (UI лишь
красиво показывает ошибку). Терминальный статус паспорта при ВТО не
меняется (`IN_PROGRESS`), выпуск изделия наступает только при
упаковке (F7).

**Сценарий (роль IRONING):**

1. Сотрудник ВТО открывает `/wto`. Страница SSR-подтягивает
   `getShiftMeta()` + `getCurrentShift()` (как `/qc`, см. F5, и
   `/packing`, см. F7) и решает, что показать:
   - **смены нет** → reuse-форма `SeamstressShiftStart`: большая
     primary-кнопка «Начать смену», скан QR рабочего места ВТО
     (например, `wto-station-01` из seed), затем выбор разрешённой
     операции из allow-листа `EquipmentOperation` (ADR-0017) — для
     wto-станции это одна операция `WTO` — и `POST /shifts/start`
     (см. F2). Без этого шага все WTO-action'ы упирались бы в
     `SHIFT_SESSION_REQUIRED`, потому что у роли IRONING нет другой
     страницы, где можно стартовать смену (`/work` редиректит в
     `/wto`, см. `getPrimaryWorkspace`);
   - **смена активна, но категория операции ≠ `IRONING`** (ВТО
     случайно открыл смену не на том станке) → банер «Смена не на ВТО»
     с подсказкой завершить смену через меню в правом верхнем углу.
     Скан-флоу намеренно не показываем — иначе scan подсадит паспорт
     в чужой `currentOperationId` и поломает shopfloor-проекцию;
   - **смена активна, категория `IRONING`** → штатный scan-flow ниже.
2. Сканирует QR паспорта (`passport:{id}` или просто номер `P-…`).
   Server-action `acceptOnWtoAction` сначала бьёт обычный
   `POST /api/passports/:id/scan` (вход на операцию категории
   `IRONING`), а потом `GET /api/wto/passports/:id` для карточки.
   Frontend-gate выше отрезает `SHIFT_SESSION_REQUIRED` до клика, но
   backend остаётся источником истины: если сессия истекла между SSR
   и POST, scan вернёт 409 `SHIFT_SESSION_REQUIRED` и фронт покажет
   обычный error-box.
   Если у паспорта нет `QC_PASSED` — backend возвращает 409
   `PASSPORT_NOT_QC_PASSED`, фронт показывает error-box с
   подсказкой «Паспорт ещё не прошёл ОТК — принимать на ВТО нельзя».
3. Если паспорт принят — сотрудник видит meta, цифры **Раскроено /
   Брак / Годных**, бейдж «ОТК подтверждено · ⟨дата⟩» (если QC уже
   подтверждал паспорт раньше) и большую кнопку **«Завершить ВТО»**.
   Никаких форм для брака здесь нет — фиксация брака осталась в F5.
4. По окончании обработки — нажимает **«Завершить ВТО»** →
   `POST /api/wto/passports/:id/complete`. В аудит пишется
   `PassportEvent(WTO_PASSED)`. Действие идемпотентно: повторное
   нажатие создаёт новое событие (нужно, если ВТО переподтверждает
   паспорт после возврата). `Passport.status` не меняется — это
   аудит-маркер, а не движение по pipeline. Карточка **сворачивается**
   в одну компактную строку «ВТО завершено · ⟨время⟩»
   (`WtoCompletedRow`, см. `apps/web/app/wto/wto-completed-row.tsx`).
5. Когда тот же паспорт уехал дальше по pipeline — сотрудник на
   следующей операции (упаковка) сканирует его (F4), backend пишет
   `PassportEvent(OPERATION_SCAN)` с новым `operationId`. На
   следующем `GET /api/wto/passports/:id` (поллинг ~10 c или ручной
   refresh / новый скан) backend возвращает `removedFromWto = true`,
   и **схлопнутая строка исчезает из окна ВТО совсем**. То же самое
   для терминальных статусов (`PACKED`/`CANCELLED`).
6. «Сканировать другой паспорт» — очищает карточку и снова открывает
   QR-сканер. Терминал готов к следующему паспорту.

**Доступ.** RBAC разделяемый со всем `/api/wto/*`:
`IRONING`, `SHOP_MANAGER`, `ADMIN`. Подробнее — `docs/api.md §8a`.

**Транзакция «Завершить ВТО» (`WtoService.completeWto`):**

1. Загружаем паспорт; терминальные/`CREATED` статусы → 409
   `PASSPORT_NOT_WTOABLE`.
2. Проверяем `QC_PASSED` (см. QC-gate выше). Если нет — 409
   `PASSPORT_NOT_QC_PASSED`. Это double-check к gate из
   `PassportsService.scanOnOperation`: complete-эндпоинт
   контроллируется отдельной ролью и должен оставаться
   самодостаточным.
3. Проверяем актора (404 / 409 — `EMPLOYEE_NOT_FOUND` /
   `EMPLOYEE_INACTIVE`).
4. `INSERT PassportEvent (type=WTO_PASSED, qty=qtyGood,
   operationId=passport.currentOperationId, employeeId)`. Никаких
   обновлений `Passport.qty*`/`status`.
5. Возвращаем `WtoPassportDetailDto` с обновлённым `wtoCompletedAt`
   (= `createdAt` последнего `WTO_PASSED`-события),
   `qcPassedAt` (= последнего `QC_PASSED`) и
   `removedFromWto = false` (см. ниже).

**Backend-флаг «паспорт ушёл из ВТО» (`removedFromWto`).**

`WtoService.loadDetail` дополнительно вычисляет
`removedFromWto: boolean` — источник истины для скрытия свернутой
строки в `/wto`. Правило симметрично `removedFromQc`:

- если `wtoCompletedAt = null` — `false` (терминал даже не показывал
  свернутую строку);
- если паспорт в терминальном статусе (`PACKED`/`CANCELLED`) —
  `true`;
- иначе ищем `PassportEvent(OPERATION_SCAN)` с
  `createdAt > wtoCompletedAt`: если он есть — сотрудник на
  следующей операции уже подхватил паспорт (F4,
  `PassportsService.scanOnOperation`), и `removedFromWto = true`.

**Связь с экраном «Цех».** Свежий `WTO_PASSED` (новее последнего
`OPERATION_SCAN`) сразу двигает паспорт в derived-стадию `WTO_DONE`
проекции shopfloor, не меняя `Passport.status` — см. F11 и
[ADR-0013](./adr/0013-shopfloor-stage-mapping.md) §«WTO_DONE bucket».

Расчёт зарплаты у ВТО — оклад (Шаг 9+); на Шаге 8 ничего не начисляется.

---

## F7. Упаковка и выпуск

Реализовано на **Шаге 8 MVP** (модуль `apps/api/src/modules/packing`,
scan-driven терминал `/packing`). Контракт API — `docs/api.md §9`.
Архитектурные решения — [ADR-0011](./adr/0011-packing-and-release.md).

Актёр: **PACKING** (оклад). Soft-проверка актёра — у `employeeId`
должна быть активная `ShiftSession` с операцией категории `PACKING`,
иначе мутации возвращают 409 `PACKING_SHIFT_REQUIRED`.

**UX: единое scan-driven окно `/packing`.** Упаковщик видит ровно один
терминал по той же модели, что `/qc` и `/wto`
(см. `apps/web/app/packing/packing-terminal.tsx`,
`docs/screens.md §6`):

1. Если активной смены нет — большая кнопка «Начать смену» открывает
   камеру (тот же `SeamstressShiftStart`, что у швеи). Скан QR со
   станка упаковки → выбор операции категории `PACKING` →
   `POST /api/shifts/start`.
2. После старта смены — тот же экран, но primary-action
   «Создать коробку».
3. Когда коробка открыта — primary-action «Сканировать паспорт».
   Каждый успешный скан вибрирует, играет короткий «дзынь» и
   обновляет список упакованных паспортов прямо в карточке.
4. После сканирования всех паспортов — большая success-кнопка
   «Закрыть коробку». Это финальный шаг цепочки: backend в той же
   транзакции апрувит pending-начисления **всем участникам**
   (см. ниже). После закрытия карточка гасится, и упаковщик
   возвращается к шагу «Создать коробку».

Глобальная навигация (header / mobile-nav) на `/packing` для роли
`PACKING` скрыта — `lib/rbac.ts` относит её к
`SINGLE_WORKSPACE_ROLES`, `components/app-header.tsx` маркирует
терминал через `hideForPacking`. Меню «Завершить смену»/«Выйти»
доступно через три-точечный `SeamstressActionsMenu` в правом верхнем
углу — единый паттерн со швеёй.

**Создание коробки:**
1. В терминале `/packing` (или из управленческого вида для
   `SHOP_MANAGER`/`ADMIN`) сотрудник нажимает «Создать коробку»
   (опционально указывает уменьшенный `maxQty`, по умолчанию 100).
2. `POST /api/packing/boxes { maxQty? }` →
   `Box { number=B-YYYYMMDD-NNNN, qrCode=box:{id}, totalQty=0, maxQty=100, closedAt=NULL }`.
3. Этикетку и QR можно распечатать через `/api/packing/boxes/:id/label`
   (HTML — см. ADR-0010).

**Добавление паспорта в коробку = выпуск изделия:**
1. В терминале `/packing` (или на управленческой карточке
   `/packing/boxes/:id`) сотрудник сканирует QR паспорта или
   вводит номер `P-…`.
2. `POST /api/packing/boxes/:id/add-passport
   { passportId? | code? }`.
3. Сервер в одной транзакции:
   - проверяет, что коробка открыта (`closedAt IS NULL`);
   - проверяет, что паспорт жив (`status = IN_PROGRESS`, `qtyGood > 0`);
   - проверяет однородность коробки (одинаковые
     `productId`/`color`/`sizeId`, см. ADR-0011 §3) →
     `BOX_HOMOGENEITY_VIOLATED`;
   - проверяет вместимость (`totalQty + qtyGood ≤ maxQty`) →
     `BOX_CAPACITY_EXCEEDED`;
   - создаёт `BoxItem(boxId, passportId, qty=passport.qtyGood)`;
   - инкрементирует `Box.totalQty`;
   - ставит `Passport.status = PACKED`, обнуляет `currentEmployeeId` и
     `currentCellId` (паспорт ни у кого на руках, ни в ячейке);
   - пишет `PassportEvent(PACKED, boxId, qty=qtyGood, employeeId)`.
4. После этого паспорт **выпущен**: любые `issue/scan/qc/place` для него
   возвращают `PASSPORT_ALREADY_PACKED` (см. `assertPassportActive` в
   `PassportsService`/`QcService`). Агрегаты заказа сразу видят
   `qtyFinishedTotal += qtyGood`.
5. **Начисления остаются `PENDING_RELEASE`**. Финальный апрув всем
   участникам цепочки происходит при закрытии коробки (см. ниже,
   ADR-0005).

**Закрытие коробки = финальный шаг цепочки и апрув начислений:**
1. В терминале `/packing` упаковщик нажимает крупную success-кнопку
   «Закрыть коробку (N шт.)» (или из управленческой карточки
   `/packing/boxes/:id` — кнопка «Закрыть коробку»).
2. `POST /api/packing/boxes/:id/close {}` →
   `Box.closedAt = now()`. Сами паспорта уже выпущены при добавлении —
   закрытие коробки **не выпускает повторно** (см. ADR-0011 §2).
3. В той же транзакции `PackingService.close` итерируется по
   `BoxItem[]` коробки и для каждого `passportId` вызывает
   `EarningsService.approvePendingForPassport(passportId)`. Метод
   переводит **все** `OperationEntry { passportId, status=PENDING_RELEASE }`
   (а также legacy `PENDING`) в `APPROVED`, проставляя
   `approvedAt = now()`. Это и есть «final completion event» цепочки —
   единая точка, в которой швея/раскройщик/иные сдельщики получают
   подтверждённые начисления (см. ADR-0005 §«Подтверждение»).
4. Закрытая коробка возвращает 409 `BOX_CLOSED` на любые
   `add-passport`/`close`. Идемпотентность апрува гарантирована
   двумя слоями: внешним (`BoxClosedException` не пускает повторно
   в апрув) и внутренним (`approvePendingForPassport` фильтрует
   только `PENDING_RELEASE`/`PENDING` и не трогает уже `APPROVED`).
5. Никаких отдельных начислений за упаковку **не создаётся** —
   упаковщики окладники (ADR-0005).

Просмотр получившихся начислений — `/earnings` и блок «Начисления» в
карточке паспорта (`docs/screens.md §12`).

---

## F8. Смена сотрудника

Реализовано на **Шаге 6 MVP** (модуль `apps/api/src/modules/shifts`,
экран `/work`).

1. Логин по логину/PIN (Шаг 7). **На Шаге 6** auth ещё нет — UI
   `/work` хранит выбранного демо-сотрудника в cookie
   `demo-employee-id` (см. ADR-0010).
2. Сканирование оборудования (MVP: выбор из списка `GET
   /api/shifts/meta` → `equipment[]`).
3. Выбор операции из списка операций
   (`GET /api/shifts/meta → operations[]`; фильтрация по роли
   появится на Шаге 7).
4. `POST /api/shifts/start { employeeId, equipmentId, operationId }`
   → `ShiftSession { employeeId, equipmentId, operationId, startedAt }`.
5. Все последующие действия — в контексте этой сессии. Любой вызов
   `issue`/`scan` без активной смены вернёт 409
   `SHIFT_SESSION_REQUIRED`.
6. «Завершить смену» → `POST /api/shifts/stop { employeeId }`
   (`endedAt = now()`).

**Ограничение:** у сотрудника в любой момент — не более одной активной
`ShiftSession` (`endedAt IS NULL`). Правило проверяется в
`ShiftsService.start` (Шаг 6 — application-level; DB-уровень partial
unique-index появится, если потребуется).

**Side-effect: окладная синхронизация (post-Шаг 18, ADR-0021).**
В транзакции `start` и `stop` `ShiftsService` дополнительно дёргает
`SalaryService.syncDailySalary(employeeId, date)`. Для сотрудников, у
которых `isSalaryEligible(compensationType) = true` (т.е. `SALARY` и
`MIXED`, см. `apps/api/src/modules/employees/compensation.ts`),
это создаёт/обновляет одну `SalaryEntry` за день (см. F9a). Вызов
фейл-софт: ошибка sync-а **не** ронит сам `start/stop` — бизнес-приоритет
«сотрудник работает», синхронизация догонит на следующем событии.

---

## F9. Просмотр сдельных начислений (Шаг 9 MVP)

Реализовано на **Шаге 9 MVP** (модуль `apps/api/src/modules/earnings`,
экран `/earnings` + блок «Начисления» в `/passports/[id]`). Контракт API
— `docs/api.md §10`.

**Кто видит и что:**

- начальник цеха / админ открывает `/earnings`, фильтрует по сотруднику,
  статусу (`PENDING_RELEASE` / `APPROVED`), периоду по `createdAt`,
  и видит сводку (`Подтверждено` / `Ожидает выпуск` / `Всего`) +
  таблицу с колонками *дата*, *сотрудник*, *операция*, *паспорт*,
  *размер*, *qty*, *ставка*, *сумма*, *статус*;
- из карточки паспорта (`/passports/[id]`) виден тот же срез по одному
  паспорту: одна-две строки за раскрой и каждый пошивной переход.

**Откуда берутся суммы (для периода `[from, to]`):**

```
totalApproved = Σ amount
                 WHERE status = APPROVED
                   AND createdAt BETWEEN from AND to
                   AND (employeeId = X)?

totalPending  = Σ amount
                 WHERE status = PENDING_RELEASE
                   AND createdAt BETWEEN from AND to
                   AND (employeeId = X)?
```

`countApproved`/`countPending` — `COUNT(*)` по тем же условиям.
`REVERSED` (заложен на будущее) на MVP не выставляется и в свод не
попадает.

**За рамками Шага 9 MVP:** ведомость за месяц `{ employee,
salary_fixed, piecework_approved, piecework_pending, total }`;
удержания за брак по виновной операции; экспорт в Excel/PDF;
интеграция с 1С/ЗУП. См. `docs/index.md` чек-лист и
`architecture.md §13`. Окладная часть (ОТК / помощник раскройщика /
упаковщики / ВТО) реализована отдельным контуром `SalaryEntry` —
см. F9a.

---

## F9a. Окладные начисления от факта смены (post-Шаг 18, ADR-0021)

Реализовано пост-Шагом 18 (модуль `apps/api/src/modules/salary`,
блок «Окладные начисления» в `/earnings` и блок «Последние окладные
начисления» в `/admin/employees/[id]`). Контракт API — `docs/api.md
§10a` и §3b. Бизнес-обоснование — [ADR-0021](./adr/0021-shift-day-salary.md).

**Кто видит и что:**

- начальник цеха / админ открывает `/earnings`, видит блок
  «Окладные начисления» под сдельной таблицей: *дата*, *сотрудник*,
  *тип* (всегда «Оклад за смену»), *сумма*, бейдж «Исправлено
  вручную» с комментарием менеджера, кнопки **«Исправить»** и
  **«Вернуть в авто»** (см. `screens.md §12.3`);
- обычный сотрудник видит только свои окладные суммы без действий —
  `SalaryService` сужает скоуп на чтении (см. `api.md §10a`).

**Auto-flow (создание `SalaryEntry`):**

1. Сотрудник нажимает «Начать смену» → `POST /api/shifts/start`.
2. В транзакции `ShiftsService.start` после создания `ShiftSession`
   дёргается `SalaryService.syncDailySalary(employeeId, today)`.
3. Если `isSalaryEligible(compensationType) = true` (т.е. `SALARY`/`MIXED`)
   и в этот день есть хотя бы одна `ShiftSession` — `upsert` по
   `(employeeId, date, source = SHIFT_DAY)`:
   - запись существует с `editedManually = true` → `amount` не
     трогаем (менеджер сказал «1500», автоматика не перезаписывает);
   - запись существует с `editedManually = false` → обновляем
     `amount = salaryPerShift` (ставка могла поменяться);
   - записи нет → создаём с `amount = salaryPerShift`.
4. Аналогично — на `POST /api/shifts/stop`.

**Ручная корректировка flow:**

1. На `/earnings` менеджер кликает «Исправить» в строке окладной
   записи, вводит новую сумму (опц.) и комментарий (опц.).
2. Server action шлёт `PATCH /api/salary/:id { amount?, managerComment? }`.
3. `SalaryService.updateManually` ставит `editedManually = true`,
   `editedByEmployeeId = viewer.employeeId`, обновляет переданные
   поля.
4. На последующих `start/stop shift` `syncDailySalary` пропускает
   эту запись (см. шаг 3 выше).

**Reset flow (вернуть под автоматику):**

1. Менеджер кликает «Вернуть в авто» в строке записи с
   `editedManually = true`.
2. Server action шлёт `PATCH /api/salary/:id { reset: true }`.
3. `SalaryService.updateManually` снимает `editedManually`,
   очищает `managerComment` и `editedByEmployeeId`, выставляет
   `amount = employee.salaryPerShift`. Если ставка не задана —
   `SALARY_RATE_MISSING` (422), запись не меняется.

**За рамками этого шага:** учёт часов и half-day, автозакрытие
смены по таймауту, месячный payroll/норма часов, удержания за
брак для окладных ролей, экспорт в Excel/1С/ЗУП. См. ADR-0021 §3.

---

## F10. Дашборд начальника

Обновление polling'ом раз в 2–5 сек. Группировка по `Size`:

Для каждого размера:

- `plan = Σ OrderItem.qtyPlan`
- `cut = Σ Passport.qtyCut WHERE currentOperation.category = CUTTING`
- `in_sewing = Σ Passport.qtyCut WHERE currentOperation.category = SEWING`
- `qc = Σ ... WHERE currentOperation.code = QC`
- `ironing = Σ ... WHERE currentOperation.code = WTO`
- `packing = Σ ... WHERE currentOperation.code = PACKING AND status != PACKED`
- `released = Σ Passport.qtyGood WHERE status = PACKED`
- `defect = Σ Passport.qtyDefect`

(См. `prisma/schema.prisma` и `ShopfloorService` для SQL.)

---

## F11. Экран «Цех» — Шаг 10 MVP

Управленческий экран `/shopfloor`. Столбцы = макро-этапы:
**КРОЙ → ПОШИВ → ОТК → ВТО → УПАКОВКА → ВЫПУЩЕНО** + отдельная
колонка **БРАК** (не stage). Строки = размеры. Клетка = количество
изделий: `qtyCut` для живых стадий, `qtyGood` — для упаковки и выпуска.

### Источник истины

На MVP **нет отдельного источника истины** для текущего этапа партии.
Серверная проекция `ShopfloorService` (`apps/api/src/modules/shopfloor`)
читает живой `Passport` (+ `Operation.category` через `currentOperation`,
+ `BoxItem.box.closedAt`) и за один SQL-запрос строит матрицу
`size × stage → qty`. Никаких новых таблиц, событий или
материализованных витрин — см. [ADR-0013](./adr/0013-shopfloor-stage-mapping.md).

Stage buckets:

- `CUT`      — `Passport.status = CREATED` (qty = `qtyCut`).
- `SEWING`   — `IN_PROGRESS` AND `currentOperation.category ∈ {CUTTING, SEWING}` (qty = `qtyCut`).
  Категория `CUTTING` сюда попадает после `ISSUED_TO_EMPLOYEE` до
  первого `OPERATION_SCAN` (паспорт уже на руках у швеи; см. F3a/F4).
- `QC`       — `IN_PROGRESS` AND `category = QC` AND нет свежего
  `PassportEvent(QC_PASSED)` (qty = `qtyCut`).
- `QC_DONE`  — «Проверено ОТК». `IN_PROGRESS` AND `category = QC` AND
  есть `PassportEvent(QC_PASSED)`, более свежее, чем последний
  `OPERATION_SCAN` (qty = `qtyCut`). Производный бакет, **не двигает**
  `Passport.status`: после нажатия «Проверка выполнена» крой
  визуально уезжает из колонки `ОТК` в `Проверено ОТК` и остаётся там,
  пока следующая операция не сделает `OPERATION_SCAN` (после этого
  паспорт уйдёт в `SEWING/WTO/...` обычным способом). См.
  ADR-0013 §«QC_DONE bucket».
- `WTO`      — `IN_PROGRESS` AND `category = IRONING` AND нет свежего
  `PassportEvent(WTO_PASSED)` (qty = `qtyCut`).
- `WTO_DONE` — «ВТО завершено». Полный аналог `QC_DONE` для роли
  ВТО: `IN_PROGRESS` AND `category = IRONING` AND есть
  `PassportEvent(WTO_PASSED)`, более свежее, чем последний
  `OPERATION_SCAN` (qty = `qtyCut`). Производный бакет, **не двигает**
  `Passport.status`: после нажатия «Завершить ВТО» крой визуально
  уезжает из колонки `ВТО` в `ВТО завершено` и остаётся там, пока
  следующая операция не сделает `OPERATION_SCAN` (после этого паспорт
  уйдёт в `PACKING/...` обычным способом). См. ADR-0013
  §«WTO_DONE bucket».
- `PACKING`  — `PACKED` AND есть `BoxItem` в OPEN-коробке (qty = `qtyGood`).
  **MVP-аппроксимация:** в текущей доменной модели промежуточного
  «в упаковке» статуса у паспорта нет (ADR-0011 §3) — добавление
  паспорта в коробку сразу делает его `PACKED`. Используем открытые
  коробки как живой индикатор «в упаковке прямо сейчас». См.
  ADR-0013 §«Аппроксимация колонки PACKING».
- `FINISHED` — `PACKED` AND PACKING-условие не сработало (qty = `qtyGood`).
- `DEFECT`   — `Σ Passport.qtyDefect` среди не-`CANCELLED`. Отдельная
  колонка-итог, не stage.

Бакеты взаимоисключающие — каждое изделие учитывается ровно один раз.
Активные заказы = `status NOT IN (DONE, CANCELLED)`.

### Polling и анимация (клиент)

Реализация — `apps/web/app/shopfloor/shopfloor-board.tsx` (client
component).

1. Клиент поллит `GET /api/shopfloor/state` каждые **3 сек**
   ([ADR-0007](./adr/0007-polling-for-realtime.md)). Polling включается
   чекбоксом «Авто-обновление» и стопится автоматически при unmount.
2. Сравнивает новый снапшот с предыдущим по каждой `(sizeId, stage)`
   и каждой ячейке summary-стрипа.
3. На каждой изменившейся ячейке запускается короткая
   (~1.1 сек) flash-подсветка:
   - **зелёная** — если значение выросло (что-то «приехало»);
   - **красная** — если уменьшилось (что-то «уехало»).

Никакой серверной логики анимации, никакого Canvas/WebGL и никакой
полноценной timeline-анимации перелёта объекта на MVP не делаем — это
сознательная аппроксимация (см. ADR-0013 §«Аппроксимация анимации»).

### Что НЕ делает Шаг 10

- Не вводит websocket/SSE (ADR-0007).
- Не создаёт новых событий и не трогает существующие транзакции
  (`PassportsService`, `QcService`, `PackingService`, `EarningsService`).
- Не вводит `Passport.stage` или `ShopfloorSnapshot`.
- Не делает drill-down c экрана; для деталей — `/orders/:id`.

---

## F11a. UAT flow — сквозной пилотный сценарий (Шаг 12)

Один путь, который должен пройти без ошибок, прежде чем считать пилот
успешным. Покрывается интеграционным тестом `tests/integration/pilot-flow.test.ts`
и должен быть пройден руками каждой ролью на onboarding-сессии
(см. `docs/pilot/rollout-plan.md §3`).

Действующие лица: помощник раскройщика (`cutter-helper`), швея
(`seamstress`), ОТК (`qc`), упаковщик (`packer`), начальник цеха
(`shop-chief`).

1. **`shop-chief`** создаёт заказ `POST /api/orders` (один продукт,
   несколько размеров) и переводит его `POST /api/orders/:id/start`
   в `IN_PRODUCTION`.
2. **`cutter-helper`** выпускает паспорт `POST /api/passports`
   (см. F2). Транзакционно создаётся `OperationEntry` для
   раскройщика (`status=APPROVED`).
3. **`cutter-helper`** размещает паспорт в ячейке через
   `POST /api/passports/:id/place` (см. F3).
4. **`seamstress`** открывает смену `POST /api/shifts/start`
   (`overlock-01`, `SEW_OVERLOCK_1`).
5. **`seamstress`** забирает крой `POST /api/passports/:id/issue`
   (см. F3a). Паспорт уходит из ячейки, статус `IN_PROGRESS`.
6. **`seamstress`** сканирует паспорт `POST /api/passports/:id/scan`
   (см. F4). Создаётся `PassportEvent(OPERATION_SCAN)` и
   `OperationEntry(status=PENDING_RELEASE)` для предыдущей операции.
7. **`qc`** фиксирует брак `POST /api/qc/passports/:id/defects`
   (необязательно, но в пилотном UAT обязательно прогоняем хотя бы
   одну запись для проверки агрегатов; см. F5).
8. **`packer`** открывает смену с операцией `PACKING`, создаёт
   коробку `POST /api/packing/boxes`, добавляет паспорт
   `POST /api/packing/boxes/:id/add-passport` (см. F7). В той же
   транзакции `Passport.status` становится `PACKED`, а все
   `PENDING_RELEASE`-начисления по этому паспорту переводятся в
   `APPROVED` (см. ADR-0005).
9. **`packer`** закрывает коробку `POST /api/packing/boxes/:id/close`.
10. **Проверки UAT (без новых API)** — все должны совпасть:
    - `GET /api/orders/:id` → `summary.qtyCutFactTotal == Σ qtyCut`
      живых паспортов; `summary.qtyFinishedTotal == Σ qtyGood по
      PACKED`; `summary.qtyDefectTotal == Σ qtyDefect живых`;
    - `GET /api/earnings?employeeId=…` → есть строки и `APPROVED`,
      и (если был промежуточный пошив) `APPROVED`-же после упаковки;
    - `GET /api/shopfloor/state` → есть колонки FINISHED ≥ упакованный
      qtyGood; PACKING становится 0 после закрытия коробки;
    - `GET /api/admin/overview` (Шаг 12) → активные смены / открытые
      коробки / паспорта в работе адекватны факту.

UAT flow сознательно не повторяет «несколько паспортов параллельно» —
это покрывается `pilot-flow.test.ts` (double scan stress, rapid issue+scan,
pack after defect).

---

## F12. Печать PDF и QR

- **Шаг 5 (реализовано):** `GET /api/passports/:id/print` — HTML-страница
  формата A6 (`@page`/`@media print`) с QR в `data:image/png;base64,...` и
  человекочитаемой ссылкой `prod.teeon.ru/passports/{id}`. Печатается из
  браузера системным диалогом — это покрывает и обычный принтер, и термо
  через драйвер ОС. См. [ADR-0010](./adr/0010-passport-print-and-placement.md).
- **Шаг 5 (реализовано):** `GET /api/passports/:id/qr` — `image/png` QR-кода
  паспорта (формат `passport:{id}` — [ADR-0008](./adr/0008-qr-format.md)).
- **Будущие шаги:** `pdf`-эндпоинт паспорта, QR ячейки/оборудования/коробки.

---

## F13. Закрытие раскроя по размеру через заявку (ADR-0018)

Менеджерская цепочка для типичного кейса «накроили меньше плана и
больше не будут». Доменная модель — `domain.md §15`,
схема — `erd.md §2.8a`, API — `api.md §14`.

1. **CUTTER_ASSISTANT** может подать заявку двумя путями — итог
   тот же, экономится переход:
   - **Inline в форме выпуска паспорта** (`/orders/:id/passports/new`,
     см. `docs/screens.md §7.5`). Под полями формы есть
     checkbox-карточка «Подать заявку на закрытие раскроя» с
     опциональным полем «Причина». При submit server action
     `createPassportAction` создаёт паспорт, и если чекбокс включён —
     сразу зовёт `POST /api/cutting-close-requests` по той же строке
     `(orderId, productId, sizeId)`. Если паспорт создался, а заявка
     упала, паспорт **не откатывается** — UI показывает mixed-result
     «паспорт создан, но заявку отправить не удалось» и ссылку на
     карточку паспорта, чтобы подать заявку вручную.
   - **С карточки паспорта** (`/passports/[id]`). Помощник видит блок
     «Закрытие раскроя» с планом / выпущено / остаток по строке
     `(orderId, productId, sizeId)`. Если по строке нет
     активной/подтверждённой заявки — есть кнопка «Подать заявку на
     закрытие» с опциональной короткой причиной.
2. POST `/api/cutting-close-requests` создаёт
   `CuttingClosureRequest { status: REQUESTED, requestedByEmployeeId,
   requestedAt, reason? }`. Backend валидирует:
   - заказ в `IN_PRODUCTION` (иначе
     `CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION`, 409);
   - `(orderId, productId, sizeId)` существует в `OrderItem`
     (иначе `CUTTING_CLOSURE_SIZE_NOT_IN_ORDER`, 400);
   - нет другой `REQUESTED` (partial unique index
     `cutting_closure_request_active_uniq` →
     `CUTTING_CLOSURE_ALREADY_REQUESTED`, 409);
   - нет `APPROVED` (`cutting_closure_request_approved_uniq` →
     `CUTTING_CLOSURE_ALREADY_APPROVED`, 409).
3. **SHOP_MANAGER** видит pending-заявки в баннере карточки заказа
   (`/orders/[id]`) и в карточке самого паспорта. Принимает решение:
   - POST `/api/cutting-close-requests/:id/approve` — статус
     `APPROVED`, фиксируем `reviewedByEmployeeId`/`reviewedAt`/
     `reviewerNote`. После этого `PassportsService.create` для этой
     строки возвращает `409 CUTTING_CLOSED` (см. F2).
   - POST `/api/cutting-close-requests/:id/reject` — статус
     `REJECTED`. Выпуск паспортов продолжается как обычно; помощник
     может подать новую заявку (`REJECTED` не блокирует).
   - На terminal-статусах повторное решение запрещено
     (`CUTTING_CLOSURE_REQUEST_NOT_PENDING`, 409).
4. **UI обновлений** — `revalidatePath('/passports/:id')` и
   `revalidatePath('/orders/:id')` после каждой server action
   (`requestCuttingClosureAction`, `approveCuttingClosureAction`,
   `rejectCuttingClosureAction`).

**Что заявка не делает.** Не уменьшает `OrderItem.qtyPlan` (план
иммутабелен, [ADR-0006](./adr/0006-plan-is-immutable.md)), не
переводит сам `Order` в `DONE`, не возвращает уже выпущенные
паспорта. Это «стоп на новый выпуск», а не правка факта.

## F-Master. Вызов мастера цеха (MVP)

Мобильный «эскалационный» flow без смены владельца паспортов и без
блокировок выдачи кроя — соответствует §10a `domain.md`
(`MasterCall`), `screens.md §«/master»` и API-модулю
`apps/api/src/modules/master-calls/*`.

Назначение: рабочий нажимает одну заметную кнопку «Мастер» на своём
терминале → мастер цеха видит карточку в очереди на `/master` и
подсветку плитки на `/shopfloor/display` → подходит к сотруднику →
сканирует QR его бейджа → вызов закрыт.

### Шаги

1. **Рабочий нажимает «Мастер».**
   Кнопка `<CallMasterButton>` живёт в layouts `/work`, `/qc`,
   `/wto`, `/packing` и доступна `SEAMSTRESS`, `CUTTER`,
   `CUTTER_ASSISTANT`, `QC`, `IRONING`, `PACKING`. Server action
   `callMasterAction` вызывает `POST /api/master-calls`.

2. **API создаёт OPEN или возвращает существующий.**
   `MasterCallsService.create` идемпотентно ищет `OPEN` вызов по
   `(employeeId, status=OPEN)`. Если есть — возвращает его без
   `INSERT` и без повторного `MASTER_CALLED` audit-события.
   Если нет — создаёт, снимая снэпшот `equipmentId` / `operationId`
   из активной `ShiftSession` и пишет `MASTER_CALLED`.

3. **`/shopfloor/display` мигает.**
   `ShopfloorService.getDisplaySummary` подгружает `OPEN` вызовы
   тем же запросом, что и оборудование, и:
   - выставляет `ShopfloorEquipmentStatusDto.hasOpenMasterCall = true`
     для плиток, у которых есть `OPEN MasterCall` с `equipmentId`;
   - кладёт остальные (без `equipmentId` или с уже закрытой сменой)
     в `ShopfloorDisplayDto.orphanMasterCalls`.

   Frontend (`display-board.tsx`) добавляет на плитку класс
   `display-equipment-tile--master-call` (мягкий violet/blue pulse,
   отдельно от bottleneck coral pulse) и рендерит блок «Вызовы
   мастера» с orphan-вызовами.

4. **Мастер открывает `/master`.**
   `GET /api/master-calls` отдаёт список `OPEN` вызовов с
   сотрудником, операцией, оборудованием, временем ожидания и
   текущими паспортами активной смены сотрудника. `MasterPageClient`
   обновляет очередь polling'ом раз в 5 секунд и тикает «ожидает N
   мин» раз в секунду на клиенте.

5. **Мастер сканирует QR сотрудника.**
   QR-этикетка печатается через `GET /api/employees/:id/print`,
   payload — `EMPLOYEE:<employeeId>`. На `/master` карточка
   открывает общий `<QrScannerModal>`; результат скана уходит в
   `resolveMasterCallByEmployeeQrAction` → `POST /api/master-calls/resolve-by-employee-qr`.

6. **API закрывает вызов.**
   `MasterCallsService.resolveByEmployeeQr` парсит payload через
   `parseEmployeeQr`, ищет последний `OPEN` вызов сотрудника и
   переводит его в `RESOLVED` (`resolvedAt = now()`,
   `resolvedById = текущий user`). Эмитит `MASTER_CALL_RESOLVED`.
   Если открытого вызова нет — возвращает `404 NOT_FOUND` с
   человекочитаемым сообщением, UI показывает inline-ошибку и не
   падает.

7. **UI показывает «Вызов закрыт».**
   `MasterPageClient` оптимистично убирает карточку из списка и
   показывает короткий success-toast «Вызов закрыт» (3 сек), затем
   принудительно дёргает `refreshOpenMasterCallsAction`, чтобы
   синхронизироваться с БД. На `/shopfloor/display` плитка
   перестаёт пульсировать на следующем тике (`POLL_INTERVAL_MS`).

### Edge-cases

- **Кнопка «Мастер» нажата до старта смены.** Создаём вызов без
  `equipmentId` / `operationId`. На `/shopfloor/display` он
  отрисуется в `orphanMasterCalls`, на `/master` — в карточке без
  оборудования (метка «Без активной смены»).
- **Спам кнопки «Мастер».** Идемпотентный `create` гарантирует один
  `OPEN` на сотрудника; UI показывает persistent статус «Мастер
  вызван» до закрытия. Audit пишется один раз.
- **Скан чужого QR (не EMPLOYEE).** `parseEmployeeQr` возвращает
  `null`, server action отказывает с `VALIDATION_ERROR`. Карточки
  в очереди не меняются.
- **Скан QR сотрудника без `OPEN` вызова.** API возвращает
  `404 NOT_FOUND` (`MASTER_CALL_NOT_FOUND`). UI показывает inline-
  сообщение, очередь не дёргается.
- **Ошибка backend'а при `POST /api/master-calls`.** Server action
  возвращает `{ ok: false, error }`, кнопка показывает «Ошибка»
  inline и **не блокирует** работу — рабочий может продолжать
  основной flow (`/work` сканы, ОТК и т.д.).

### Что сознательно не делается (MVP)

- Не открываем «issue override» — выдача кроя остаётся как было
  (см. §F-issue). Передача / возврат / переназначение — отдельные
  ручные действия мастера, см. §F-Master actions ниже.
- Нет alerts/sounds на `/shopfloor/display`: только мягкий pulse.
- Нет авторазрешения вызова по таймеру: только ручной resolve через
  скан QR.

---

## F-Master actions. Действия мастера над паспортами (Stage 2)

Stage 2 «Мастер цеха» добавляет в карточку вызова на `/master` блок
«Действия с кроем». Источник истины — `apps/api/src/modules/master-actions/*`,
`docs/domain.md §10b`, `docs/screens.md §«/master mobile actions UI»`.

### Общий порядок

1. Мастер открывает карточку вызова на `/master`. В блоке «Действия с
   кроем» он видит список паспортов сотрудника (`MasterCallPassportDto`):
   номер, заказ, размер, цвет, `qtyCut`, текущая операция, статус,
   текущая ячейка, snapshot маршрута заказа.
2. Тапает «Действия» на нужном паспорте — открывается mobile bottom-sheet
   (`PassportActionsSheet`).
3. Выбирает одно из четырёх действий, заполняет специфичные поля
   (QR/выбор), затем — **обязательно** причину из enum
   `MASTER_ACTION_REASONS` и опциональный комментарий.
4. Нажимает «Подтвердить». UI вызывает соответствующий server action
   (`master-actions-actions.ts`) → `POST /api/master-actions/passports/:id/...`.
5. Сервис выполняет всё в `prisma.$transaction`: проверки, мутацию
   `Passport`/`CellContent` и запись в `AuditLog` (`MASTER_PASSPORT_*`).
6. UI получает `MasterActionResultDto` (`{ passport, before }`),
   показывает toast «Действие выполнено», обновляет карточку вызова
   и **не закрывает** `MasterCall` — закрытие отдельной кнопкой
   «Сканировать QR сотрудника» (см. §F-Master).

### Сценарий 1 — «Снять с сотрудника» (`unassign`)

- API: `POST /api/master-actions/passports/:id/unassign`
  body `{ reason, comment? }`.
- Эффект: `currentEmployeeId = null`. `currentOperationId` /
  `currentRouteStepIndex` сохраняются. Статус не меняется.
- Audit: `MASTER_PASSPORT_UNASSIGNED` с before/after.
- Когда применимо: паспорт ошибочно «висит» на сотруднике
  (`reason = WRONG_SCAN` / `EMPLOYEE_MISTAKE`).

### Сценарий 2 — «Передать сотруднику» (`transferToEmployee`)

- API: `POST /api/master-actions/passports/:id/transfer-to-employee`
  body `{ employeeQr | employeeId, reason, comment? }`.
- Сервис проверяет: target существует и `active = true`. Иначе
  `TARGET_EMPLOYEE_NOT_FOUND` / `TARGET_EMPLOYEE_INACTIVE`.
- Если у target открыта `ShiftSession` с операцией, входящей в
  snapshot маршрута заказа — двигаем `currentOperationId` /
  `currentRouteStepIndex` (route-WIP логика). Если нет — операцию не
  трогаем, только владельца.
- Эффект: `currentEmployeeId = target.id`, `currentCellId = null`,
  `status = IN_PROGRESS`.
- Audit: `MASTER_PASSPORT_TRANSFERRED` с `targetEmployeeId`.
- Когда применимо: пересменка (`SHIFT_HANDOVER`), решение менеджера
  (`MANAGER_DECISION`).

### Сценарий 3 — «Вернуть в ячейку» (`returnToCell`)

- API: `POST /api/master-actions/passports/:id/return-to-cell`
  body `{ cellQr | cellId, reason, comment? }`.
- Сервис проверяет: ячейка существует и активна (`CELL_NOT_FOUND` /
  `CELL_INACTIVE`).
- Эффект: `currentCellId = cell.id`, `currentEmployeeId = null`,
  `CellContent[size] += qtyCut`. Статус сохраняется (см. §10b
  «Safety-инварианты»).
- Идемпотентность: если паспорт уже в этой ячейке — пишем audit с
  `noop = true`, `qtyReturned = 0`, `CellContent` не двоится.
- Audit: `MASTER_PASSPORT_RETURNED_TO_CELL` с `cellId` / `cellCode` /
  `qtyReturned` / `noop?`.
- Когда применимо: паспорт ошибочно выдан, нужно вернуть на склад
  (`WRONG_SCAN` / `CELL_CORRECTION`).

### Сценарий 4 — «Назначить операцию» (`setRouteStep`)

- API: `POST /api/master-actions/passports/:id/set-route-step`
  body `{ routeStepIndex | operationId, reason, comment? }`.
- Сервис грузит snapshot маршрута заказа (`OrderRouteStep`). Если
  snapshot пуст — `ORDER_HAS_NO_ROUTE_SNAPSHOT`. Если индекс /
  operation не из snapshot — `ROUTE_STEP_NOT_IN_SNAPSHOT`.
- Эффект: `currentOperationId = op.id`,
  `currentRouteStepIndex = idx`, `currentEmployeeId = null`,
  `currentCellId = null`, `status = IN_PROGRESS`.
- Audit: `MASTER_PASSPORT_ROUTE_STEP_SET` с `operationId` /
  `routeStepIndex`.
- Когда применимо: ручная коррекция маршрута (`ROUTE_CORRECTION`).

### Edge-cases / отказ

- **Паспорт `PACKED` / `CANCELLED`.** Любое из четырёх действий
  отказывает с `409 PASSPORT_TERMINAL`. UI показывает inline-ошибку
  и не закрывает sheet, чтобы мастер видел причину.
- **Без `reason`.** Zod возвращает `400 VALIDATION_ERROR` ещё до
  сервиса. Кнопка «Подтвердить» остаётся `disabled`, пока select
  пустой.
- **Скан чужого QR в `transferToEmployee`.** `parseEmployeeQr`
  возвращает `null` → `400 INVALID_EMPLOYEE_QR`. UI показывает
  «QR не распознан как сотрудник».
- **Двойной тап «Подтвердить».** Кнопка переходит в
  `disabled + busy`, повторного запроса не происходит. Бэкенд
  идемпотентен только для `returnToCell` (см. выше) — в остальных
  случаях защищает UI.
