# Доменная модель

> Все термины здесь — канон. Используются и в коде (en), и в UI (ru).

---

## 0a. Аутентификация и сессии (MVP 1.1)

С MVP 1.1 любая бизнес-операция выполняется от лица конкретного сотрудника:

- сотрудник логинится по `login` + `password` (`Employee.pinHash`, bcrypt);
- сервер выдаёт подписанную HttpOnly cookie `sewing_session` (HMAC-SHA256
  на `JWT_SECRET`, срок — `JWT_EXPIRES_IN`, по умолчанию 12 часов);
- на каждом защищённом endpoint `AuthGuard` проверяет подпись/срок и
  загружает «свежие» поля Employee из БД (роль/активность не кешируются —
  деактивация работает мгновенно);
- роли проверяются декоратором `@Roles(...)` (`SHOP_MANAGER` для управления
  заказами, `QC` для брака, `PACKING` для упаковки и т.д., `ADMIN`
  переопределяет всё).

Demo-cookie `demo-employee-id` и явная передача `employeeId` в body/query
для state-changing endpoint-ов из MVP 1.0 удалены: identity всегда
берётся из сессии. Подробности — `api.md §1`, `flows.md §F0`,
[ADR-0014](./adr/0014-auth-and-sessions.md).

---

## 1. Глоссарий (en ↔ ru)

| Код (en)          | UI (ru)                       | Описание                               |
| ----------------- | ----------------------------- | -------------------------------------- |
| Order             | Заказ                         | Заявка клиента на N изделий            |
| OrderItem         | Позиция заказа                | Продукт + размер + план (qty_plan)     |
| Product           | Изделие                       | Футболка белая / черная (MVP)          |
| Size              | Размер                        | Справочник (104…6XL)                   |
| Operation         | Операция                      | Этап производства                      |
| Passport          | Паспорт изделия               | Партия (размер+цвет+рулон), корень     |
| PassportEvent     | Событие паспорта              | Любое изменение состояния              |
| OperationEntry    | Начисление                    | Сдельное начисление сотруднику за операцию по паспорту (Шаг 9) |
| ApprovalMode      | Режим подтверждения           | `IMMEDIATE` (раскройщик) / `AFTER_RELEASE` (пошив)             |
| EarningSource     | Источник начисления           | `PASSPORT_CREATED` / `OPERATION_TRANSITION` (Шаг 9, ADR-0012)  |
| CompensationType  | Тип компенсации               | `PIECEWORK` / `SALARY` / `MIXED` (ADR-0021)                    |
| SalaryEntry       | Окладное начисление за день   | Один день — одна запись на сотрудника (ADR-0021)               |
| SalaryEntrySource | Источник окладной записи      | `SHIFT_DAY` (был факт смены) / `MANUAL` (ручной день, MVP не пишем) |
| PieceRate         | Расценка                      | Ставка за единицу                      |
| Cell              | Ячейка                        | Место хранения кроя                    |
| CellContent       | Содержимое ячейки             | Размер → количество                    |
| Box               | Коробка                       | Упаковка (до 100 шт.)                  |
| Employee          | Сотрудник                     | Работник производства                  |
| ShiftSession      | Сессия смены                  | Сотрудник + оборудование + операция    |
| Equipment         | Оборудование                  | Машинка / стол (с QR)                  |
| EquipmentOperation | Разрешённая операция         | M2M: какие операции допустимы на станке (ADR-0017) |
| DefectType        | Вид брака                     | Справочник причин брака (Шаг 7)        |
| PassportDefect    | Запись брака                  | Один акт фиксации (qty, comment)       |

---

## 2. Продукты и размеры (MVP)

**Продукты:**
- `tshirt_white` — Футболка белая
- `tshirt_black` — Футболка черная

**Размеры** (со `sortOrder`):

Детские: `104, 110, 116, 122, 128, 134, 140, 146, 152, 158, 164`
Взрослые: `XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL`

Размеры — справочник в БД. Никаких литералов в коде (см. §23 ТЗ).

---

## 3. Роли

| Код (en)          | UI (ru)                   | Оплата   |
| ----------------- | ------------------------- | -------- |
| `SHOP_MANAGER`    | Начальник цеха            | —        |
| `CUTTER`          | Раскройщик                | Сдельная |
| `CUTTER_ASSISTANT`| Помощник раскройщика      | Оклад    |
| `SEAMSTRESS`      | Швея                      | Сдельная |
| `QC`              | ОТК                       | Оклад    |
| `IRONING`         | ВТО                       | Оклад    |
| `PACKING`         | Упаковка                  | Оклад    |
| `ADMIN`           | Администратор             | —        |

Тип оплаты привязан к `Employee`, а не к роли: тот же сотрудник потенциально
может быть на сдельной или окладной. Но по умолчанию мапится из роли.

> Со Шага 19 (post-ADR-0021) на `Employee` появилась **отдельная**
> управленческая ось `compensationType`
> (`PIECEWORK` / `SALARY` / `MIXED`) и `salaryPerShift Decimal?` —
> ставка за отработанный день. Существующее `paymentType` остаётся
> источником истины для сдельного контура (`OperationEntry`,
> ADR-0005/0012/0020) и не трогается. `compensationType` управляет
> только новым окладным контуром (`SalaryEntry`) — см. §9a и
> [ADR-0021](./adr/0021-shift-day-salary.md).

### 3.1. Видимость рабочих разделов по ролям

Backend — единственный источник истины (`@Roles(...)` на контроллерах).
Frontend дублирует те же правила через `apps/web/lib/rbac.ts` и
layouts `/qc`, `/packing`, `/orders`, чтобы не показывать пустые
страницы и `403`.

| Раздел     | Роли с доступом                                | Эндпоинты                                    |
| ---------- | ---------------------------------------------- | -------------------------------------------- |
| `/qc`      | `QC`, `SHOP_MANAGER` (+ `ADMIN`)               | `/api/qc/*`, `/api/defect-types`             |
| `/packing` | `PACKING`, `SHOP_MANAGER` (+ `ADMIN`)          | `/api/packing/boxes/*` (кроме `/qr`/`/label` — публичные для печати/сканера) |
| `/orders`  | `ADMIN`, `SHOP_MANAGER`; read-only — `CUTTER_ASSISTANT` | write: `/api/orders/*`; read: `GET /api/orders[/:id][/passports]` |
| `/work` для `CUTTER_ASSISTANT` | mobile-clean экран без верхнего тёмного header. Перед стартом — `SeamstressShiftStart` (QR раскройного стола → выбор разрешённой операции → `POST /api/shifts/start`). После старта — `CutterAssistantWorkPanel`: «Выпустить паспорт» (→ `/work/cut-orders`, если заказ один — авто-редирект на `/orders/[id]/passports/new`, иначе короткий список или empty state) и «Разместить на стеллаж» (`ShelfPlacementPanel`). «Завершить смену» и «Выйти» — в три-точечном меню `SeamstressActionsMenu`. | Без активной `ShiftSession` печать падает в `SHIFT_SESSION_REQUIRED` (см. `print-jobs.service.ts:resolvePrinter`), поэтому помощник работает строго в контексте оборудования смены — как и остальные рабочие роли. |

UI работает по модели «одно рабочее окно на роль» (см.
[`docs/screens.md §1.1`](./screens.md#11-модель-одно-рабочее-окно-на-роль)
и `apps/web/lib/rbac.ts`): для производственных ролей `/`
редиректится в их primary workspace (`SEAMSTRESS` /
`CUTTER_ASSISTANT` / `CUTTER` → `/work`, `QC` → `/qc`,
`IRONING` → `/wto`, `PACKING` → `/packing`), отдельной «Главной» и
дублирующей «Работы» в навигации у них нет. Менеджеры и
админ продолжают видеть многосекционный интерфейс.

`ADMIN` глобально проходит любой `@Roles(...)`. Прочие роли получают
`403 FORBIDDEN_ROLE` от API; в UI разделы для них не отображаются —
ни в шапке, ни в `MobileNav`, ни в тайлах главной.

---

## 4. Операции

Категории (`OperationCategory`):

- `CUTTING` — раскрой
- `SEWING` — пошив
- `QC` — контроль качества
- `IRONING` — ВТО
- `PACKING` — упаковка

Список операций (MVP):

| Код                  | Название            | Категория | sort | pricingMode (seed) |
| -------------------- | ------------------- | --------- | ---- | ------------------ |
| `CUT_PATTERN_PRINT`  | Печать лекал        | CUTTING   | 10   | `SALARY_ONLY`      |
| `CUT_SPREADING`      | Настил              | CUTTING   | 20   | `SALARY_ONLY`      |
| `CUT_CUT`            | Раскрой             | CUTTING   | 30   | `FIXED` (10/шт)    |
| `CUT_DIVISION`       | Деление кроя        | CUTTING   | 40   | `SALARY_ONLY`      |
| `CUT_BASE_PREP`      | Подготовка основы   | CUTTING   | 50   | `SALARY_ONLY`      |
| `CUT_RIBANA_PREP`    | Подготовка рибаны   | CUTTING   | 60   | `SALARY_ONLY`      |
| `CUT_ISSUE`          | Выдача кроя         | SEWING    | 70   | `SALARY_ONLY`      |
| `SEW_OVERLOCK_1`     | Оверлок 1           | SEWING    | 80   | `BY_SIZE`          |
| `SEW_BINDING`        | Киперка             | SEWING    | 90   | `SALARY_ONLY`      |
| `SEW_OVERLOCK_2`     | Оверлок 2           | SEWING    | 100  | `BY_SIZE`          |
| `SEW_COVERSTITCH`    | Распошив            | SEWING    | 110  | `SALARY_ONLY`      |
| `QC`                 | ОТК                 | QC        | 120  | `SALARY_ONLY`      |
| `WTO`                | ВТО                 | IRONING   | 130  | `SALARY_ONLY`      |
| `PACKING`            | Упаковка            | PACKING   | 140  | `SALARY_ONLY`      |

> Категории (`OperationCategory` enum) остаются CUTTING/SEWING/QC/IRONING/PACKING.
> Код операции `WTO` логически означает ВТО (влажно-тепловая обработка) и
> относится к категории `IRONING`. Выдача кроя (`CUT_ISSUE`) — граница между
> раскроем и пошивом; на MVP она относится к категории `SEWING`, потому что
> активируется на стороне пошива (см. `flows.md §F2/§F3`).

Правило перехода: **по умолчанию** следующий этап — операция с ближайшим
бо́льшим `sortOrder`. Но система должна позволять «прыгать» через этапы
(на MVP достаточно: при сканировании мы принимаем ту операцию, которую
сотрудник выбрал в `ShiftSession`).

---

## 4a. Тариф операции (`PricingMode`, ADR-0020)

Со Шага 18 каждая операция несёт явный «тарифный режим», который
определяет, как для неё считается сдельная зарплата. Источник истины —
`Operation.pricingMode`, см. `erd.md §2.3`/§2.3a, доменные правила —
[ADR-0020](./adr/0020-operation-pricing-model.md).

| Mode          | Источник ставки                                  | Поведение зарплаты                                                                          |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `FIXED`       | `Operation.fixedRate` (Decimal(12,2))            | Одна ставка за единицу независимо от размера. Менеджер вводит одно число.                     |
| `BY_SIZE`     | `OperationRateBySize.rate` для пары `(operationId, sizeId)` | Цена различается по размеру. `fixedRate` хранится `null`, `OperationRateBySize` — нормализованная таблица с `UNIQUE (operationId, sizeId)`. |
| `SALARY_ONLY` | —                                                | Операция участвует в pipeline (можно сканировать, она перекидывает паспорт), но **не порождает** `OperationEntry`. Дефолт для новых операций. |

**Единый helper.** `OperationsService.resolveRate(operationId, sizeId,
tx?)` — единственный источник истины для earnings:

- `FIXED` → `Operation.fixedRate`;
- `BY_SIZE` → `OperationRateBySize.rate` для `sizeId`; отсутствие
  ставки → `OPERATION_RATE_MISSING` (422) — менеджер обязан задать
  ставку для каждого реально используемого размера;
- `SALARY_ONLY` → `null`. `EarningsService` молча пропускает такую
  операцию (никакого `OperationEntry`).

`EarningsService.createImmediateForCutter` (раскрой,
`PASSPORT_CREATED`, ADR-0005/ADR-0012) и
`EarningsService.createPendingForPreviousOperation` (пошив,
`OPERATION_TRANSITION`) обе зовут именно `resolveRate`. Старая
`findRate` поверх `PieceRate` и константа «список piecework-операций»
(`PIECEWORK_OPERATION_CODES`/`isPieceworkOperationCode`) удалены из
runtime — «оплатная ли операция» теперь = `op.pricingMode ≠ SALARY_ONLY`.

**Жизненный цикл (RBAC: `SHOP_MANAGER` / `ADMIN`).**

1. Менеджер создаёт операцию (`POST /api/operations`) с явным
   `pricingMode`. Дефолт сервера — `SALARY_ONLY` (самый безопасный:
   операция не сломает зарплату, пока менеджер не выберет тариф).
   Уникальность `Operation.code` — `OPERATION_CODE_TAKEN` (409).
2. Меняет тариф или ставку (`PATCH /api/operations/:id`). Транзакция
   чистит несовместимые поля при смене режима (например, `BY_SIZE
   → SALARY_ONLY` стирает `OperationRateBySize`; `FIXED → BY_SIZE`
   очищает `fixedRate`). Дубликаты `sizeId` в `ratesBySize` —
   `OPERATION_RATE_DUPLICATE_SIZE` (400); неизвестный `sizeId` —
   `OPERATION_RATE_SIZE_NOT_FOUND` (400).
3. Деактивация — `PATCH /api/operations/:id { isActive: false }`.
   Операция остаётся в истории (на ней могут существовать
   `OperationEntry`/`PassportEvent`), но не предлагается в новых
   формах. API на удаление сознательно не предоставляется —
   `Operation` — это идентичность, на которую ссылаются исторические
   данные.

**Что осталось из MVP 1.0.** Таблица `PieceRate` физически сохраняется
для аудита/rollback, но runtime больше не читает её — миграция
`20260420100000_operation_pricing_model` бэкфилит соответствующие
`pricingMode`/`fixedRate`/`OperationRateBySize` из живых строк
`PieceRate`. Любые правки `PieceRate` через Prisma Studio после Шага
18 на новые начисления **не повлияют** (см. ADR-0020 §4).

---

## 5. Паспорт изделия — агрегат-корень

**Инварианты:**

1. Один паспорт = один размер + один цвет + один рулон.
2. Создаётся только на операции `CUT_DIVISION` пользователем с ролью
   `CUTTER_ASSISTANT`.
3. `qtyPlan` — плановое количество в партии (напр. 12 шт).
4. `qtyCut` фиксируется при создании (физически раскроено раскройщиком).
5. `qtyDefect` ≥ 0; `qtyGood = qtyCut − qtyDefect`.
6. `currentOperationId` меняется только через `PassportEvent(OPERATION_STARTED)`.
7. После события `PACKED` паспорт недоступен для перемещений.

**Поля** (см. `prisma/schema.prisma`):

- `number`, `qrCode`
- `orderId`, `productId`, `sizeId`, `color`
- `rollNumber`, `cutDate`
- `qtyPlan`, `qtyCut`, `qtyDefect`, `qtyGood`
- `currentOperationId` — текущая операция. Ставится при `CREATED`
  (`CUT_DIVISION`), обновляется событием `OPERATION_SCAN` (Шаг 6).
- `currentEmployeeId` — сотрудник, у которого сейчас находится
  паспорт. Ставится при `ISSUED_TO_EMPLOYEE` (Шаг 6) и обновляется
  при `OPERATION_SCAN`.
- `currentCellId` — текущая ячейка (Шаг 5, см. ADR-0010)
- `cutterId` (раскройщик-сдельщик), `creatorId` (помощник, создавший паспорт)
- `status` (`CREATED | IN_PROGRESS | PACKED | CANCELLED`)
- `pdfUrl`

**Номер** — автонумерация `P-YYYYMMDD-NNNN` (счётчик в рамках дня).

### 5.1. Скоуп Шага 5 MVP

Реализован выпуск паспорта помощником раскройщика и его размещение в
ячейке. Конкретно:

- **Выпуск:** `POST /api/passports` — заказ + размер + дата кроя + кол-во
  + номер рулона. Сервер находит строку заказа по размеру, проверяет
  правила (см. ниже), создаёт `Passport(status=CREATED,
  currentOperationId=CUT_DIVISION, qtyPlan=qtyCut, qtyDefect=0,
  qtyGood=qtyCut)`, пишет `PassportEvent(CREATED)`, генерирует QR
  (`passport:{id}` по [ADR-0008](./adr/0008-qr-format.md)) и печатную
  форму (HTML, см. [ADR-0010](./adr/0010-passport-print-and-placement.md)).
- **Размещение:** `POST /api/passports/:id/place` — увеличивает
  `CellContent.quantity` на `qtyCut`, пишет `PassportEvent(CELL_PLACED)`,
  проставляет `Passport.currentCellId`.
- **Агрегаты заказа:** `qtyCutFact` по размеру и `qtyCutFactTotal` в
  summary считаются из `Σ Passport.qtyCut` (статус ≠ CANCELLED) — см.
  `apps/api/src/modules/orders/order-aggregator.ts`.

**Правила выпуска (валидация на API):**

1. Заказ существует и в статусе `IN_PRODUCTION` (см. ADR-0010); DRAFT,
   DONE, CANCELLED → 409 `ORDER_NOT_IN_PRODUCTION`.
2. Размер из `dto.sizeId` присутствует в `OrderItem` заказа (иначе 400
   `SIZE_NOT_IN_ORDER`).
3. `qtyCut > 0` (валидация Zod).
4. `qtyCut + Σ выпущенных_по_размеру ≤ OrderItem.qtyPlan` (иначе 422
   `QTY_EXCEEDS_REMAINING_PLAN`).
5. `rollNumber` непустой.
6. На паспорт назначаются `cutterId` (демо-раскройщик из seed) и
   `creatorId` (`cutter-helper`) — на этапе без аутентификации
   используем фиксированных демо-сотрудников. Когда появится auth
   (Шаг 7), `creatorId` придёт из активной `ShiftSession`.

**Правила размещения:**

1. Паспорт существует и в статусе `CREATED` (иначе 409
   `PASSPORT_NOT_PLACEABLE`).
2. `Passport.currentCellId` ещё не выставлен — повторное размещение
   запрещено (409 `PASSPORT_ALREADY_PLACED`). Перемещение между
   ячейками появится позже.
3. Ячейка существует (`CELL_NOT_FOUND`) и `active = true`
   (`CELL_INACTIVE`).

**За рамками Шага 5:** выдача кроя швее, пошивные операции, ОТК, ВТО,
упаковка, экран «Цех», сканирование оборудования, мобильный кабинет
сотрудника, перемещение паспорта между ячейками, частичное размещение,
mixed split/merge паспортов, event sourcing сверх уже принятой модели.

> Начисление раскройщику возникает в момент создания паспорта (см.
> [ADR-0005](./adr/0005-salary-timing.md)). Сам модуль начислений
> реализован на Шаге 9 — `EarningsService.createImmediateForCutter`
> вызывается в той же транзакции `PassportsService.create` после
> `PassportEvent(CREATED)`. См. §9 и `flows.md §F2`.

### 5.2. Скоуп Шага 6 MVP

Реализована сессия смены и первое «живое» движение паспорта. Конкретно:

- **Смена (`ShiftSession`).** Обязательна для любой работы с паспортом
  швеи/оверлочницы. API: `POST /api/shifts/start | stop`, `GET
  /api/shifts/current?employeeId=…`. Правило «не более одной активной
  смены на сотрудника» поддерживается в `ShiftsService` (см.
  `docs/flows.md §F8`).
- **Выдача кроя (`POST /api/passports/:id/issue`).** Швея на активной
  смене снимает паспорт с ячейки, `CellContent.quantity` уменьшается
  на `qtyCut`, пишется `PassportEvent(ISSUED_TO_EMPLOYEE)`,
  `passport.status = IN_PROGRESS`, `currentCellId = NULL`,
  `currentEmployeeId = session.employeeId`. `currentOperationId` **не
  меняем** — это сделает первый `scan`.
- **Сканирование на операции (`POST /api/passports/:id/scan`).**
  Любой скан = переход: `currentOperationId = session.operationId`,
  `currentEmployeeId = session.employeeId`, `OPERATION_SCAN`.
  Идемпотентность — по состоянию (ADR-0003 §6).
- **Resolver `POST /api/passports/by-code`.** Разворачивает QR
  `passport:{id}`, номер `P-…` или голый id в паспорт. Используется
  на `/work` перед `issue`/`scan`.
- **UI `/work`.** Mobile-first экран: выбор демо-сотрудника →
  старт/стоп смены → две крупные кнопки «Получить крой» /
  «Сканировать паспорт». См. `docs/screens.md §3`.
- **«Текущий крой в работе» (`GET /api/shifts/current-work`).**
  Список паспортов, у которых `currentEmployeeId = me` и
  `status = IN_PROGRESS`. Источник истины — БД, backend сам режет
  по сессии (см. ADR-0014, `docs/api.md §3` и `docs/screens.md §3.4`).
  Это derived view: запись уходит из ответа автоматически после
  скана следующей операции (другой actor) или упаковки. Никаких
  дополнительных «возвратов кроя» не вводим.

**Правила выдачи кроя (валидация на API):**

1. Паспорт существует (`PASSPORT_NOT_FOUND`).
2. Паспорт не в терминальном статусе
   (`PASSPORT_ALREADY_PACKED` / `PASSPORT_CANCELLED`).
3. У сотрудника активна смена (`SHIFT_SESSION_REQUIRED`).
4. Паспорт ещё не выдан
   (`currentEmployeeId IS NULL OR currentCellId IS NOT NULL`);
   иначе `PASSPORT_ALREADY_ISSUED`.
5. Паспорт лежит в ячейке (`currentCellId IS NOT NULL`);
   иначе `PASSPORT_NOT_IN_CELL`.

**Правила скана на операции:**

1. Паспорт существует и не в терминальном статусе.
2. У сотрудника активна смена (`SHIFT_SESSION_REQUIRED`).
3. Дубликат-скан на ту же операцию тем же сотрудником — no-op,
   возвращаем 200 без нового события.

**За рамками Шага 6:** ОТК, ВТО, упаковка, коробки, реалтайм-
экран «Цех», полноценная история операций (`OPERATION_STARTED` /
`OPERATION_FINISHED` / `MOVED`), полный event sourcing, отдельное
мобильное приложение, аутентификация.

> Сдельные начисления пошива по `OPERATION_SCAN` подключены на Шаге 9 MVP
> в той же транзакции, что и сам скан (см. §9 и `flows.md §F4`).

### 5.3. Скоуп Шага 7 MVP — ОТК и фиксация брака

Реализована первая контрольная точка качества. Конкретно:

- **Справочник `DefectType`.** Минимальный набор причин брака:
  `STAIN`, `HOLE`, `CROOKED_SEAM`, `SKEW`, `INCOMPLETE`, `OTHER`.
  Идемпотентный seed по `code` (см. `prisma/seed.ts → seedDefectTypes`).
  Расширение и деактивация — через будущий админ-UI; на API уже отдаём
  только активные виды (`isActive = true`).
- **Запись брака `PassportDefect`.** Отдельная таблица
  `(id, passportId, defectTypeId, qty, comment?, createdByEmployeeId?,
  createdAt)`. Один паспорт может иметь много записей; каждая запись —
  атомарный акт ОТК, который **не закрывает паспорт** и не переводит
  его в терминальный статус.
- **Денормализованные `qtyDefect` / `qtyGood`** хранятся прямо в
  `Passport` (как и до Шага 7) и поддерживаются в одной транзакции с
  `PassportDefect`: `qtyDefect += dto.qty`, `qtyGood = qtyCut − qtyDefect`.
  Это сохраняет инвариант §13 без отдельного чтения «Σ defects» при
  каждом запросе и не ломает существующий
  `order-aggregator`.
- **Событие `DEFECT_RECORDED`.** Появляется в `PassportEvent` с
  `qty = dto.qty`, `operationId = passport.currentOperationId`,
  `payload = { defectId, defectTypeId, defectTypeCode, defectTypeName,
  comment }`. Append-only, в той же транзакции.
- **Агрегация заказа.** `qtyDefect` по размеру в `sizeBreakdown` =
  `Σ Passport.qtyDefect` по живым (≠ `CANCELLED`) паспортам этого
  размера. `summary.qtyDefectTotal` = сумма по всем размерам. Все
  остальные показатели (`qtyCutFact`, `qtyRemaining`, `qtyDelta`)
  считаются как раньше.

**Правила фиксации брака (валидация на API, см. `flows.md §F5`):**

1. Паспорт существует (`PASSPORT_NOT_FOUND`).
2. Паспорт в статусе `IN_PROGRESS` — иначе `PASSPORT_NOT_QCABLE`.
   Это значит, что выпуск/размещение прошли и крой уже выдан швее
   или просканирован на операции (Шаг 6 переводит статус в
   `IN_PROGRESS`). Дополнительно отсекаются терминальные
   `PACKED` / `CANCELLED`.
3. `defectType` существует (`DEFECT_TYPE_NOT_FOUND`) и активен
   (`DEFECT_TYPE_INACTIVE`).
4. `qty` — целое > 0 (валидация Zod, см. `packages/shared/src/qc.ts`).
5. `qty ≤ qtyCut − qtyDefect`. Иначе 422 `DEFECT_EXCEEDS_REMAINING`.
   Инвариант `qtyGood ≥ 0` (см. §13) защищается в коде в одной
   транзакции с инкрементом.
6. `employeeId` (если передан) существует и активен. На MVP без
   аутентификации поле опционально — UI может слать `employeeId`
   из cookie `demo-employee-id`.

**За рамками Шага 7:** виновная операция (мы пишем
`operationId = currentOperationId`, но не «виновную» — её определит
будущий процесс расследования), возврат брака в производство, split
паспорта на отдельные подпаспорта по браку, экран «Цех», аналитика
по причинам, начисления ОТК (роль `QC` — оклад, см. §9.1) и
исправление уже зафиксированной записи. Терминальное
закрытие паспорта по 100% брака на MVP не предусмотрено: паспорт
просто продолжит жить с `qtyGood = 0`.

### 5.4. ВТО role-terminal и QC-gate

ВТО на MVP — отдельный scan-driven role-terminal `/wto`, полный аналог
ОТК. Реализация: модуль `apps/api/src/modules/wto`, frontend
`apps/web/app/wto/*`. Архитектурное обоснование совпадает с QC_DONE
(см. ADR-0013 §«WTO_DONE bucket»):

- **Событие `WTO_PASSED`** в `PassportEvent` (см. enum
  `PassportEventType` в `prisma/schema.prisma`, миграция
  `20260419130000_wto_passed_event`). Аудит-маркер «ВТО выполнено»,
  `Passport.status` не меняется. По смыслу симметричен `QC_PASSED`.
- **QC-gate.** Вход на операцию категории `IRONING` через
  `PassportsService.scanOnOperation` отказывается записывать
  `OPERATION_SCAN`, если по паспорту нет ни одного `QC_PASSED`. В
  ответе — 409 `PASSPORT_NOT_QC_PASSED`. Идемпотентный re-scan на той
  же операции (`session.operationId === passport.currentOperationId`)
  специально пропускается без проверки — это no-op по pipeline.
- **Завершение ВТО (`WtoService.completeWto`).** Транзакция: грузим
  паспорт (`PASSPORT_NOT_WTOABLE` если статус не `IN_PROGRESS`),
  double-check `QC_PASSED` (`PASSPORT_NOT_QC_PASSED` для случая, когда
  кто-то напрямую дёргает `/api/wto/passports/:id/complete`),
  валидируем актора, пишем `PassportEvent(WTO_PASSED)`. Никаких
  обновлений `Passport.qty*`/`status`/`currentOperationId`.
- **Экран «Цех».** Свежий `WTO_PASSED` (новее последнего
  `OPERATION_SCAN`) переводит паспорт в derived-стадию `WTO_DONE`
  shopfloor-проекции (см. `shopfloor-projection.ts`,
  `shopfloor.service.ts`). После следующего `OPERATION_SCAN` паспорт
  автоматически уходит в обычный bucket по новой категории
  (`PACKING/...`), т. к. `hasFreshWtoPassed` перестаёт быть «свежим».
- **Флаг `removedFromWto`.** Полный аналог `removedFromQc` — UI
  скрывает свернутую строку «ВТО завершено», как только backend
  возвращает `removedFromWto = true` (есть `OPERATION_SCAN` после
  `wtoCompletedAt`, либо паспорт в терминальном статусе).

За рамками Шага 7 для ВТО (как и для ОТК): фиксация брака на ВТО
(брак записывает только ОТК), возврат в производство, расчёт зарплаты
ВТО (роль `IRONING` — оклад, см. §9.1), split паспорта.

---

## 5a. Заказ (Шаг 4 MVP)

**Order** — план производства. Создаётся начальником цеха или админом.

**Поля заказа** (см. `prisma/schema.prisma` / `erd.md §2.7`):

- `number` — автонумер `O-YYYYMMDD-NNNN` (счётчик в рамках дня);
- `orderDate` — дата заказа (обязательна);
- `customer` — заказчик (опционально; на MVP не обязательное поле);
- `dueDate` — срок (опционально);
- `comment` — комментарий (опционально);
- `status` — `DRAFT | IN_PRODUCTION | DONE | CANCELLED`;
- `items: OrderItem[]` — строки заказа по размерам.

**Ограничения MVP (Шаг 4):**

1. Один заказ = **одно изделие + один цвет + много размеров.** Технически
   `OrderItem.productId` хранит продукт для каждой строки, и сервер
   валидирует, что все строки относятся к одному `productId` (см.
   `OrdersService`). Цвет хранится в `Order.color` (свободный текст,
   опционально); если не задан, fallback — `Product.color`.
2. Строка заказа: `qtyPlan > 0`, размер уникален в рамках заказа
   (`@@unique(orderId, productId, sizeId)`).
3. Редактировать `OrderItem[]` и шапку можно **только в статусе `DRAFT`**.
   После перевода в `IN_PRODUCTION` приходит 409 `ORDER_LOCKED`
   (см. ADR-0006).
4. `DONE` / `CANCELLED` — терминальные статусы; перевод вручную через API.

**Переходы статусов (Шаг 4):**

```
DRAFT ──(POST /start)──► IN_PRODUCTION ──(POST /complete)──► DONE
   │                          │
   └──(POST /cancel)──────────┴──► CANCELLED
```

Автоматический перевод `IN_PRODUCTION → DONE` (по факту упаковки всех
паспортов) появится на следующих шагах — сейчас только ручной.

---

## 5b. Агрегация по заказу

API возвращает для каждого заказа:

- `OrderSummary` — итоговые значения по заказу:
  `qtyPlanTotal`, `qtyCutFactTotal`, `qtyInSewingTotal`, `qtyQcTotal`,
  `qtyWtoTotal`, `qtyPackingTotal`, `qtyFinishedTotal`, `qtyDefectTotal`,
  `qtyDeltaTotal` (= `qtyCutFactTotal − qtyPlanTotal`).
- `OrderSizeBreakdownRow[]` — строки по каждому размеру заказа с теми же
  показателями + `qtyRemaining` и `qtyDelta`.

На **Шаге 5** заполнен `qtyCutFact` / `qtyCutFactTotal` — берётся из
паспортов (`Σ Passport.qtyCut` по тем, у которых статус ≠ `CANCELLED`).
`qtyRemaining = max(qtyPlan − qtyCutFact, 0)`, `qtyDelta = qtyCutFact − qtyPlan`.

На **Шаге 7** заполнены `qtyDefect` / `qtyDefectTotal` — `Σ Passport.qtyDefect`
по тем же живым паспортам. Денормализованные счётчики обновляет
`QcService.recordDefect()` в одной транзакции с записью `PassportDefect`
(см. §5.3 и `flows.md §F5`).

На **Шаге 8** заполнен `qtyFinished` / `qtyFinishedTotal` — `Σ Passport.qtyGood`
по паспортам со `status = PACKED`. Источник истины — денормализованные
`Passport.status` и `Passport.qtyGood`, которые `PackingService.addPassport()`
обновляет в одной транзакции с созданием `BoxItem` и `PassportEvent(PACKED)`
(см. `flows.md §F7`, ADR-0011).

Промежуточные показатели (`qtyInSewing`, `qtyQc`, `qtyWto`, `qtyPacking`)
пока остаются `0` — раздельный учёт «по этапам» появится после построения
event-проекции/витрины (Шаг 10).

---

## 5c. Оборудование и его разрешённые операции

С MVP «equipment-config» (см. [ADR-0017](./adr/0017-equipment-allowed-operations.md))
у каждой единицы `Equipment` есть конфигурируемый набор разрешённых
операций — это явная M2M-связь `EquipmentOperation`:

```
Equipment 1 ──< EquipmentOperation >── 1 Operation
```

Поля `EquipmentOperation`:

- `equipmentId`, `operationId` — пара уникальна
  (`@@unique([equipmentId, operationId])`);
- `sortOrder` — порядок отображения операции в списке выбора на /work
  (меньше — выше);
- `isActive` — мягкое отключение без удаления связи (на /work не
  показывается);
- `createdAt` / `updatedAt` — для аудита.

**Где используется:**

- `GET /api/shifts/meta` отдаёт каждой единице оборудования массив
  `allowedOperationIds` (отсортированный по `sortOrder`, неактивные
  и связи с неактивными `Operation` отфильтрованы) — это источник
  истины для seamstress flow на `/work`.
- `POST /api/equipment` (роли `ADMIN`, `SHOP_MANAGER`) создаёт новую
  единицу оборудования. `name` обязателен, `code` опционален (slug
  автогенерируется из имени), `displayNumber` и `operationIds`
  опциональны. `qrCode` каноничный `equipment:{id}` ставится
  автоматически (ADR-0008, scan flow на /work совместим).
- `PATCH /api/equipment/:id` (роли `ADMIN`, `SHOP_MANAGER`)
  переименовывает оборудование (`name`) и/или меняет ручной номер
  (`displayNumber`). `code`, `qrCode`, `active` через эту ручку
  не меняются — printer-bindings и напечатанные QR-этикетки
  переживают переименование.
- `PATCH /api/equipment/:id/operations` (роли `ADMIN`, `SHOP_MANAGER`)
  полностью заменяет набор разрешённых операций.
- UI настройки — `/admin/equipment` (список + форма создания) и
  `/admin/equipment/[id]` (отдельные секции «Название», «Номер»,
  «Разрешённые операции»).

**Что НЕ делает эта связь (намеренно):**

- не защищает `POST /api/shifts/start` — на сервере сейчас остаётся
  старая валидация по существованию/активности `Equipment` и `Operation`,
  без проверки allow-листа. Frontend `/work` показывает только
  разрешённые операции, поэтому в нормальном flow выбора «не той»
  операции произойти не может; жёсткая server-side проверка — за
  пределами MVP «equipment-config»;
- не используется в payroll или event-логике.

**Seed:** `prisma/seed.ts` идемпотентно создаёт стартовый набор связей
(`overlock-* → SEW_OVERLOCK_1, SEW_OVERLOCK_2`, `coverstitch-* →
SEW_COVERSTITCH`, `binding-* → SEW_BINDING`, станции ОТК / ВТО /
упаковки → соответствующие операции). Связи, добавленные вручную в
админке, при повторном seed не удаляются.

### `displayNumber` — ручной номер станка для физической маркировки

У каждой единицы `Equipment` есть опциональное поле `displayNumber`
(`text NULL`). Это **отображаемый порядковый номер**, который
сотрудник видит на наклейке станка — не путать с серийным номером
производителя и не равно `Equipment.code` (тот тех. идентификатор).

- Заполняется руками в `/admin/equipment/[id]` (роли `ADMIN`,
  `SHOP_MANAGER`).
- Печатается крупно на QR-этикетке `GET /api/equipment/:id/print` —
  главный визуальный приоритет, чтобы швея/начальник цеха
  мгновенно различали два соседних оверлока (см. ADR-0017 §«future
  work» и `docs/screens.md §10a`).
- Глобальной уникальности нет: «Оверлок №1» и «Распошив №1» —
  допустимая нормальная ситуация. Уникальность валидируется
  визуально, по типу станка.
- Стартовый seed проставляет `displayNumber` для дефолтного
  оборудования (overlock-01 → «1», overlock-02 → «2», и т. д.).
  При повторном seed уже заданный вручную номер **не
  перезаписывается** — переживает re-seed.

---

## 6. План/факт

План — это `OrderItem.qtyPlan`. **Не меняется.**

Факты агрегируются из паспортов:

```
qty_cut_fact      = Σ passport.qtyCut
qty_finished_fact = Σ passport.qtyGood WHERE status = PACKED
qty_defect        = Σ passport.qtyDefect
delta             = qty_cut_fact − qty_plan  // может быть отрицательной
```

Группировка: по `(orderId, productId, sizeId)` или по `(sizeId)` для дашборда.

> «План иммутабелен» (ADR-0006) означает: если по строке накроили
> меньше плана и больше не будут — план **не уменьшается**. Это
> явный недокрой, который закрывается через заявку
> `CuttingClosureRequest` (см. §15 и [ADR-0018](./adr/0018-cutting-closure-request.md)),
> а не правкой `qtyPlan`.

---

## 7. Ячейки (упрощённо)

- Ячейка имеет `code` и `qrCode`.
- **Нет** статуса «занято/свободно».
- **Нет** истории размещения.
- Есть только срез `CellContent` (уникальный по `(cellId, sizeId)`):
  `sizeId → quantity`.

Операции:

- **Разместить крой**: скан паспорта + скан ячейки → `quantity += passport.qtyCut`
  для `(cell, passport.sizeId)`.
- **Забрать крой**: скан ячейки + выбор размера/кол-ва → `quantity -= N`
  (не уходим ниже 0).

---

## 8. Коробки

Реализовано на **Шаге 8 MVP** (модуль `apps/api/src/modules/packing`,
экран `/packing`). Архитектурные решения — ADR-0011.

- Коробка создаётся упаковщиком: `Box { number=B-YYYYMMDD-NNNN,
  qrCode=box:{id}, totalQty=0, maxQty=100, closedAt=NULL }`.
- На MVP коробка **однородна** по `productId/color/sizeId`
  (см. ADR-0011 §3); проверка — на уровне сервиса (`BOX_HOMOGENEITY_VIOLATED`).
- При сканировании паспорта в одной транзакции:
  `BoxItem(boxId, passportId, qty=passport.qtyGood)`,
  `Box.totalQty += qtyGood`, `Passport.status = PACKED`,
  `PassportEvent(PACKED)` (см. `flows.md §F7`).
- Капасити: `totalQty + qtyGood ≤ maxQty` (`BOX_CAPACITY_EXCEEDED`).
- Один паспорт — одна коробка (UNIQUE `BoxItem(boxId, passportId)`
  плюс `assertPassportActive` отсекает `PACKED` на других сервисах).
- Закрытие коробки только проставляет `closedAt`; повторный выпуск
  не нужен, т.к. паспорта уже выпущены при добавлении (см. ADR-0011 §2).
- Этикетка — HTML по `GET /api/packing/boxes/:id/label` (PDF за рамками
  MVP, см. ADR-0010).

**Упаковка = выпуск изделия.** После `PACKED`:
- паспорт не перемещается дальше: `issue/scan/place/qc/add-passport`
  возвращают `PASSPORT_ALREADY_PACKED`;
- агрегаты заказа сразу видят `qtyFinishedTotal += qtyGood`;
- апрув всех `OperationEntry{passportId, status=PENDING_RELEASE} → APPROVED`
  выполняется при **закрытии коробки** — `PackingService.close()`
  итерируется по `BoxItem[]` и для каждого паспорта дёргает
  `EarningsService.approvePendingForPassport(passportId)`. Это
  «final completion event» цепочки, единый момент истины «коробка
  закрыта = всем начислили» (см. `flows.md §F7`, ADR-0005, ADR-0011 §7).
  Идемпотентно: повторный close отдаёт `BOX_CLOSED`, сам метод не
  трогает уже `APPROVED`-строки.

---

## 9. Зарплата

### 9.1. Окладная (`SALARY`)

- На Шаге 19 (post-ADR-0021) окладные роли получают **дневное
  окладное начисление** `SalaryEntry` от факта смены — см. §9a.
- Месячный payroll/учёт часов/half-day/удержания за брак для
  окладных ролей — за рамками MVP (см. ограничения ниже и в
  `flows.md §F9`).
- Историческое `Employee.salaryBase` (месячная ставка) **на MVP не
  читается** runtime-логикой — оставлено в схеме как legacy-поле
  для будущего месячного payroll. Источник истины для оплаты за
  смену — `Employee.salaryPerShift` (см. §9a).
- Роли по умолчанию: `CUTTER_ASSISTANT`, `QC`, `IRONING`, `PACKING`
  — `paymentType = SALARY`. `compensationType` (`PIECEWORK` /
  `SALARY` / `MIXED`) выставляется отдельно через
  `/admin/employees/[id]` — см. `screens.md §10d`.

### 9.2. Сдельная (`PIECEWORK`) — Шаг 9 MVP

Запись `OperationEntry { passportId, employeeId, operationId, qty,
ratePerUnit, amount, status, approvalMode, sourceEventType,
sourceEventId?, createdAt, approvedAt? }`. См. `erd.md §2.13` и
`schema.prisma`.

- `amount = qty * ratePerUnit`, округлено до двух знаков
  (`Decimal(12,2)`). На сервере используется `roundMoney` —
  `EarningsService`.
- `qty` — `passport.qtyCut` (и для раскроя, и для пошива). Брак
  не вычитается из ранее созданных начислений (см. ADR-0012 §3).
- `ratePerUnit` берётся через единый helper
  `OperationsService.resolveRate(operationId, sizeId, tx?)` (Шаг 18,
  [ADR-0020](./adr/0020-operation-pricing-model.md)):
  - `Operation.pricingMode = FIXED` → `Operation.fixedRate`;
  - `Operation.pricingMode = BY_SIZE` →
    `OperationRateBySize.rate` для пары `(operationId, sizeId)`;
    отсутствие — `OPERATION_RATE_MISSING` (422), транзакция падает;
  - `Operation.pricingMode = SALARY_ONLY` → `null`,
    `OperationEntry` **не создаётся** (silent skip).

  Раньше расценка читалась из `PieceRate` по
  `(operationId, productId?, sizeId?, validFrom..validTo)`. Эта
  таблица сохранена в БД как исторические данные, но runtime больше
  не читает её — источник истины перенесён на
  `Operation`/`OperationRateBySize`. Миграция Шага 18
  бэкфилит существующие ставки.

**Какие операции попадают в `OperationEntry`.**

«Оплатная ли операция» теперь = `Operation.pricingMode ≠ SALARY_ONLY`.
Никакой отдельной константы со списком кодов в runtime нет. Конкретно
для MVP-набора (см. §4):

| Код              | `pricingMode` (seed) | Кто получает                | Когда создаётся                | Статус             |
| ---------------- | -------------------- | --------------------------- | ------------------------------ | ------------------ |
| `CUT_CUT`        | `FIXED` (10/шт)      | Раскройщик (`Employee.paymentType=PIECEWORK`) | В транзакции `PassportsService.create` после `PassportEvent(CREATED)` | `APPROVED`, `IMMEDIATE`, `PASSPORT_CREATED` |
| `SEW_OVERLOCK_1` | `BY_SIZE`            | Предыдущий исполнитель пошива (`PIECEWORK`)  | В транзакции `PassportsService.scanOnOperation` после `PassportEvent(OPERATION_SCAN)` | `PENDING_RELEASE`, `AFTER_RELEASE`, `OPERATION_TRANSITION` |
| `SEW_OVERLOCK_2` | `BY_SIZE`            | — // —                      | — // —                         | — // —             |

Если менеджер через `/admin/operations` (см. §4a, `screens.md §10c`)
переведёт ещё одну операцию в `FIXED` или `BY_SIZE`, она автоматически
попадёт в начисления — без редеплоя backend. Окладные сотрудники
по-прежнему молча пропускаются (`Employee.paymentType` ≠ `PIECEWORK`
→ skip), даже если их посадить на сдельную операцию.

### 9.3. Approval mode (`OperationEntry.approvalMode`, см. ADR-0005)

| Mode             | Кто                  | Когда `APPROVED`                  | Зачем                                                      |
| ---------------- | -------------------- | --------------------------------- | ---------------------------------------------------------- |
| `IMMEDIATE`      | Раскройщик (`CUT_CUT`) | В момент создания (`approvedAt = createdAt`) | Раскройщик отвечает за факт кроя; качество шитья — не его зона. |
| `AFTER_RELEASE`  | Пошив                | В транзакции **закрытия коробки** (`PackingService.close` → `EarningsService.approvePendingForPassport` для каждого `BoxItem`) | Защищает от выплат за партии, которые до выпуска так и не дошли. См. ADR-0005, ADR-0011 §7. |

`REVERSED` заложен на будущий flow возврата паспорта в производство;
на MVP не выставляется.

### 9.4. Источник и идемпотентность (`sourceEventType`, см. ADR-0012)

`OperationEntry.sourceEventType` дискриминирует, *почему* начисление
возникло:

- `PASSPORT_CREATED` — раскройщик, в `PassportsService.create`;
- `OPERATION_TRANSITION` — пошив, в `PassportsService.scanOnOperation`
  для предыдущей операции/исполнителя.

Поверх этого работает уникальный индекс
`@@unique(passportId, operationId, employeeId, sourceEventType)`
(`OperationEntry_idem`). Любая повторная попытка создать такое же
начисление (повторный скан, ретрай транзакции) ловится сервисом как
`P2002` и трактуется как no-op (без бизнес-ошибки). См. ADR-0012.

`sourceEventId` (опц.) — ссылка на конкретный `PassportEvent.id`,
который послужил триггером (для пошива). У раскройщика мы не
заполняем — само событие `CREATED` всегда одно на паспорт, и
`(passportId, sourceEventType=PASSPORT_CREATED)` уже однозначен.

### 9.5. Что выпустили API/UI (Шаг 9)

- API: `GET /api/earnings`, `GET /api/earnings/summary`,
  `GET /api/passports/:id/earnings` — см. `docs/api.md §10`.
- UI: `/earnings` (список + сводка + фильтры) и блок «Начисления» в
  `/passports/[id]` — см. `docs/screens.md §12`.
- Бизнес-ошибки: `PIECE_RATE_NOT_FOUND` (422) и зарезервированный
  `EARNING_NOT_FOUND` (404) — см. `docs/api.md §13`.
- **RBAC видимости.** `SHOP_MANAGER` и `ADMIN` видят все начисления
  всех сотрудников; все остальные роли получают ровно свой
  `employeeId` и только статус `APPROVED`. Принудительное сужение
  делает `EarningsService` на чтении — backend остаётся источником
  истины, web-клиент только адаптирует UI (см. `docs/api.md §10`,
  ADR-0014). Покрыто `tests/integration/earnings-rbac.test.ts`.

### 9.6. Скоуп Шага 10 MVP — экран «Цех»

**Не доменная сущность, а проекция.** Модуль `apps/api/src/modules/shopfloor`
вычисляет матрицу `размер × этап → qty` поверх уже существующих
агрегатов (заказы, паспорта, ОТК, упаковка). Никаких новых таблиц,
событий или мутаций транзакций. Все правила маппинга — в чистой
функции `projectShopfloor()` и зафиксированы [ADR-0013](./adr/0013-shopfloor-stage-mapping.md).

Зачем выделили в отдельный модуль:

- начальник цеха не должен листать список паспортов как основной
  сценарий — ему нужно видеть **где сейчас лежит объём**;
- сводка должна обновляться визуально (polling + flash-подсветка
  ячеек), не нагружая существующие транзакции;
- маппинг этапов — компромисс на текущей доменной модели и должен
  быть явно описан, а не «зашит» в дашборд заказа.

API/UI:

- `GET /api/shopfloor/state[?orderId=…]`, `GET /api/shopfloor/orders` —
  см. `docs/api.md §11`.
- `GET /api/shopfloor/equipment` — статусы оборудования (ONLINE/WARNING/OFFLINE +
  `kind` для иконки) для production board.
- UI: `/shopfloor` (board + summary strip + selector + flash-анимация) —
  см. `docs/screens.md §9`.
- Polling: 3 сек, [ADR-0007](./adr/0007-polling-for-realtime.md).

#### 9.6.1. Большой монитор `/shopfloor/display` (Шаг 10b)

Light-theme дашборд под ТВ/моноблок в самом цеху. Read-only,
изолированная light-тема, один агрегированный endpoint
`GET /api/shopfloor/display` (см. `docs/api.md §11` и
`docs/screens.md §9a`). Доменно — это та же проекция «живых
паспортов в стадиях», что и `/shopfloor`, плюс два дополнительных
измерения:

- **цвет** — группировка матрицы по `Passport.color` с
  нормализацией (`Чёрный` ≡ `чёрный` ≡ `black`); правила в
  `projectShopfloorDisplay()` + `SHOPFLOOR_DISPLAY_KNOWN_COLORS`;
- **категория оборудования** — `ShopfloorEquipmentKind`
  (`SEWING/CUTTING/QC/IRONING/PACKING/OTHER`), выводится backend'ом
  из `OperationCategory` разрешённых на станке операций; UI
  использует только для выбора иконки в плитке (см. `pickEquipmentKind`).

Никаких новых таблиц или событий не вводится — это всё ещё
полностью read-only проекция поверх существующего домена.
Менеджерский `/shopfloor` остаётся на старом контракте — цветовое
измерение нужно только большому монитору.

---

## 9a. Дневной оклад от факта смены (`SalaryEntry`, ADR-0021)

Параллельный сдельщине контур: «была смена в день → платим ставку за
день». Источник истины — backend, модуль `apps/api/src/modules/salary`.
Бизнес-обоснование и альтернативы — [ADR-0021](./adr/0021-shift-day-salary.md).

### 9a.1. Расширение `Employee`

| Поле               | Тип                    | Семантика                                                  |
| ------------------ | ---------------------- | ---------------------------------------------------------- |
| `compensationType` | `CompensationType` enum| `PIECEWORK` / `SALARY` / `MIXED`. Default `PIECEWORK`.     |
| `salaryPerShift`   | `Decimal(12,2)?`       | Ставка за отработанный день. Обязателен для `SALARY`/`MIXED`. |

Существующее `paymentType` оставлено как источник истины для
сдельного контура (`OperationEntry`) — оно никак **не** влияет на
`SalaryEntry`. `compensationType` — независимая управленческая ось.

| `compensationType` | Получает `SalaryEntry`? | Получает `OperationEntry`?                          |
| ------------------ | ----------------------- | --------------------------------------------------- |
| `PIECEWORK`        | нет                     | да — по обычным правилам ADR-0005/0012/0020         |
| `SALARY`           | да (за каждый день со сменой) | нет — ОТК/ВТО/упаковка/помощник раскройщика  |
| `MIXED`            | да                      | да — мастер-помощник, который иногда сам встаёт на оверлок |

Инвариант сервиса (`EmployeesService.update`):
`compensationType ∈ { SALARY, MIXED }` ⇒ `salaryPerShift > 0`. Ошибка
`EMPLOYEE_SALARY_RATE_REQUIRED` (422).

### 9a.2. Сущность `SalaryEntry`

```
SalaryEntry {
  id, employeeId,
  date           Postgres DATE,        // одна запись в день на сотрудника
  amount         Decimal(12,2),
  source         SalaryEntrySource     // SHIFT_DAY | MANUAL
                                       // (на MVP пишем только SHIFT_DAY)
  editedManually Boolean default false,
  managerComment Text?,
  editedByEmployeeId String?,          // FK→Employee, кто правил
  createdAt, updatedAt
}

UNIQUE (employeeId, date, source)      // ← инвариант «один день — одна запись»
```

«Один день — одна окладная запись на сотрудника для одного
`source`» — гарантировано составным `@@unique`. Параллельные
`start shift` встают на этом индексе и `P2002` ловится сервисом как
no-op (см. `apps/api/src/modules/salary/salary.service.ts`).

`amount` хранится плоским значением (а не `quantity * rate`):
на MVP ставка плоская «оклад за смену». Half-day/коэффициенты/часы
— расширение схемы потом, без миграции бизнес-смысла.

### 9a.3. Auto-sync (`SalaryService.syncDailySalary`)

Источник истины «день отработан» — наличие хотя бы одной
`ShiftSession` с `startedAt::date == date`. Длительность смены и
факт её закрытия не учитываются: открытая смена тоже считается
рабочим днём (защита от «забыл нажать стоп»).

Алгоритм:

1. Загружаем `Employee.compensationType`/`salaryPerShift`. Если тип
   `PIECEWORK` или сотрудник неактивен — выходим.
2. Считаем `ShiftSession` за этот день. Если 0 — выходим.
3. Если `salaryPerShift = null` — выходим (аномалия, но валить
   `start/stop shift` нельзя).
4. `upsert` по `(employeeId, date, source = SHIFT_DAY)`:
   - запись существует и `editedManually = true` → ничего не
     трогаем (менеджер сказал «1500 за полсмены», автоматика не
     откатывает);
   - запись существует и `editedManually = false` → обновляем
     `amount = salaryPerShift` (ставка могла поменяться);
   - записи нет → создаём с `amount = salaryPerShift`,
     `source = SHIFT_DAY`.

**Точки вызова.** `ShiftsService.start` и `ShiftsService.stop`,
обёрнуты `safeSyncSalary`-логером: ошибка sync-а **не** ронит сам
`start/stop shift` (бизнес-приоритет — продолжить работу,
синхронизация догонит на следующем событии).

### 9a.4. Ручная корректировка

`PATCH /api/salary/:id` (роли `SHOP_MANAGER`/`ADMIN`, см.
`api.md §10a`):

- `amount` (опц.) — новая сумма (≥ 0, до `Decimal(12,2)`);
- `managerComment` (опц., `null` = очистить) — короткий
  комментарий («переработка», «полсмены», «ушёл раньше»);
- `reset = true` — снять ручную правку, вернуть запись под
  `syncDailySalary` и выставить `amount = employee.salaryPerShift`.
  Если ставка не задана — `SALARY_RATE_MISSING` (422).

Любая правка ставит `editedManually = true` и
`editedByEmployeeId = viewer.employeeId`. `employeeId`/`date`/`source`
в схему `UpdateSalaryEntrySchema` физически не приходят — иначе
ручная правка могла бы перенести оплату на чужой день/чужого человека
и сломать инвариант «один день — одна запись».

### 9a.5. RBAC

| Endpoint                                | Роли с правом                           |
| --------------------------------------- | --------------------------------------- |
| `GET /api/salary`, `GET /api/salary/summary` | Любая авторизованная (RBAC-скоуп в сервисе: не-менеджер видит только свои) |
| `PATCH /api/salary/:id`                 | `SHOP_MANAGER`, `ADMIN`                 |
| `GET /api/employees`, `GET /api/employees/:id`, `PATCH /api/employees/:id` | `SHOP_MANAGER`, `ADMIN` |

Список менеджерских ролей — `SALARY_MANAGER_ROLES`
(`apps/api/src/modules/salary/salary.constants.ts`), зеркало
`EARNINGS_MANAGER_ROLES`. Любые попытки обычного сотрудника
передать чужой `employeeId` в query `/api/salary` молча
отбрасываются в `applyViewerScope` — backend остаётся источником
истины (тесты — `tests/integration/salary.test.ts`).

### 9a.6. Что сознательно не делаем (scope)

- расчёт часов, half-day, коэффициенты загрузки;
- автозакрытие смены по таймауту неактивности;
- месячный payroll по календарю/норме часов;
- отпуска/больничные/командировки;
- удержания за брак для окладных ролей;
- интеграцию с 1С/ЗУП и экспорт в Excel;
- историю изменений `amount` (есть только последний `editedBy`).

`SalaryEntrySource = MANUAL` зарезервирован под кейс «оплатить
день, в который смены физически не было» — на MVP не пишется, но
контракт уже знает значение.

---

## 10. ОТК

- ОТК видит список паспортов **в работе** (`status = IN_PROGRESS`),
  а не только тех, что физически на операции `QC`. Это компромисс
  Шага 7: пока не реализован полноценный маршрут операций, ОТК
  способна проверить любой «живой» паспорт. Подробности и
  обоснование — в §5.3 и `flows.md §F5`.
- Фиксирует брак: `qtyDefect += N`, `qtyGood = qtyCut − qtyDefect`.
- Событие `DEFECT_RECORDED` с `qty = N`,
  `payload.defectTypeCode/Name`, `payload.comment`.
- Может пропустить паспорт дальше на ВТО/упаковку — стандартное
  перемещение, отдельного «ОТК-перехода» на этом шаге нет.
- Каждый акт ОТК = одна запись `PassportDefect` (см. §5.3).
  Один паспорт может иметь несколько таких записей, агрегаты
  заказа их сложат.

### Виды брака (seed Шага 7)

| Код             | UI-название      | sortOrder |
| --------------- | ---------------- | --------- |
| `STAIN`         | Пятно            | 10        |
| `HOLE`          | Дырка            | 20        |
| `CROOKED_SEAM`  | Неровный шов     | 30        |
| `SKEW`          | Перекос          | 40        |
| `INCOMPLETE`    | Недокомплект     | 50        |
| `OTHER`         | Прочее           | 100       |

---

## 11. Сотрудник и смена

При входе:

1. Логин / PIN (Шаг 7).
2. Сканирование оборудования (QR) → привязка `equipmentId`.
3. Выбор операции из allow-листа этого `Equipment` (см. §5c —
   `EquipmentOperation`, ADR-0017) → `operationId`.
4. Создаётся `ShiftSession { id, employeeId, equipmentId, operationId,
   startedAt, endedAt? }`.

**Шаг 6 MVP:** auth ещё нет — UI `/work` хранит выбранного демо-
сотрудника в cookie `demo-employee-id`. `POST /api/shifts/start`
принимает `employeeId` явно. Правила:

- у сотрудника не более одной активной смены
  (`endedAt IS NULL`) — проверяется в `ShiftsService`;
- смена обязательна для `POST /api/passports/:id/issue|scan`; без
  активной смены — 409 `SHIFT_SESSION_REQUIRED`;
- `active = (endedAt IS NULL)` — логически derivable, храним только
  `startedAt`/`endedAt` (без дополнительной булевой колонки).

Все последующие действия выполняются в контексте этой сессии.
Завершение — по кнопке «Закончить смену» (`POST /api/shifts/stop`)
или по таймауту неактивности (будущий шаг).

**Side-effect: окладная синхронизация.** Со Шага 19 (post-ADR-0021)
`ShiftsService.start` и `ShiftsService.stop` дополнительно дёргают
`SalaryService.syncDailySalary(employeeId, date)`. Для сотрудников с
`compensationType ∈ { SALARY, MIXED }` это создаёт/обновляет одну
`SalaryEntry` за день. Вызов обёрнут `safeSyncSalary`-логером:
ошибка sync-а **не** ронит сам `start/stop shift`. Подробности —
§9a и [ADR-0021](./adr/0021-shift-day-salary.md).

---

## 12. Идентичность и QR-коды

Все QR-коды имеют формат `{kind}:{id}`:

- `passport:{passportId}`
- `cell:{cellId}`
- `equipment:{equipmentId}`
- `box:{boxId}`

Сканер в приложении парсит префикс и направляет в нужный хендлер.

---

## 13. Инварианты, защищаемые БД/транзакциями

- `OrderItem(orderId, productId, sizeId)` уникален (DB-level, MVP 1.1).
- `CellContent(cellId, sizeId)` уникален; `quantity >= 0`.
- `BoxItem(boxId, passportId)` уникален; вдобавок `BoxItem.passportId`
  глобально-уникален (MVP 1.1, ADR-0015) — паспорт физически не может
  оказаться в двух коробках одновременно.
- `Passport.number`, `Passport.qrCode`, `Box.number`, `Box.qrCode`,
  `Equipment.code`, `Equipment.qrCode`, `Cell.code`, `Cell.qrCode` —
  все глобально-уникальные (DB-level).
- На сотрудника может быть открыта **не более одной** активной смены —
  partial unique index `shift_session_active_employee_uniq` на
  `ShiftSession(employeeId) WHERE endedAt IS NULL` (MVP 1.1, ADR-0015).
  Создаётся через raw SQL при старте API (`PrismaService.onModuleInit`),
  поскольку Prisma пока не описывает partial-индексы декларативно.
- `Passport.qtyGood = qtyCut - qtyDefect` (поддерживаем в коде, читаем из БД).
  Поля `qtyDefect/qtyGood` денормализованы и обновляются в одной
  транзакции с `PassportDefect`/`PassportEvent(DEFECT_RECORDED)` —
  см. §5.3.
- `PassportDefect.qty > 0`, и `Σ PassportDefect.qty per passport ≤ Passport.qtyCut`.
  Защищается в `QcService.recordDefect()` бизнес-ошибкой
  `DEFECT_EXCEEDS_REMAINING` (422).
- Паспорт со `status = PACKED` не принимает новые `PassportEvent`, кроме
  компенсационных (`CANCELLED` — на будущее). На Шаге 7 фиксация брака
  разрешена только для `IN_PROGRESS`.
- На пару `(orderId, productId, sizeId)` существует **не более одной**
  активной (`status = REQUESTED`) и **не более одной** подтверждённой
  (`status = APPROVED`) заявки `CuttingClosureRequest` — partial
  unique indexes `cutting_closure_request_active_uniq` /
  `_approved_uniq` (ADR-0015, ADR-0018). `REJECTED` копится без
  ограничений.
- На пару `(employeeId, date)` существует **не более одной**
  окладной записи `SalaryEntry` для данного `source` — обычный
  составной `@@unique(employeeId, date, source)` (ADR-0021, §9a).
  Параллельные `start shift` ловятся `P2002` в
  `SalaryService.syncDailySalary` и трактуются как no-op.
- `Employee.compensationType ∈ { SALARY, MIXED }` ⇒
  `Employee.salaryPerShift` обязателен и `> 0`. Защищается в
  `EmployeesService.update` бизнес-ошибкой
  `EMPLOYEE_SALARY_RATE_REQUIRED` (422).

---

## 15. Закрытие раскроя по размеру (CuttingClosureRequest)

Реализовано пост-Шагом 14, см. [ADR-0018](./adr/0018-cutting-closure-request.md).
Доменная цель — явно зафиксировать «по этой размерной строке больше
кроить не будут», не трогая иммутабельный `OrderItem.qtyPlan`.

**Сущность.** `CuttingClosureRequest` живёт на тройке
`(orderId, productId, sizeId)` со статусами:

```
REQUESTED → APPROVED      // мастер подтвердил, выпуск паспортов запрещён
REQUESTED → REJECTED      // мастер отклонил, выпуск возможен, заявка закрыта
```

Поля метаданных: `reason?` (короткая причина от помощника),
`requestedByEmployeeId` / `requestedAt`, `reviewedByEmployeeId?` /
`reviewedAt?` / `reviewerNote?`. Полная схема — `erd.md §2.5b`.

**Жизненный цикл.**

1. `CUTTER_ASSISTANT` (или `SHOP_MANAGER` от его имени) подаёт заявку
   через `POST /api/cutting-close-requests`. Backend проверяет, что
   заказ в `IN_PRODUCTION` и строка существует; partial unique index
   запрещает второй `REQUESTED` по той же тройке.
2. `SHOP_MANAGER` / `ADMIN` подтверждает (`/approve`) или отклоняет
   (`/reject`). На terminal-статусе повторное решение запрещено
   (`CUTTING_CLOSURE_REQUEST_NOT_PENDING`, 409).
3. После `APPROVED` `PassportsService.create` возвращает
   `CUTTING_CLOSED` (HTTP 409) на любой попытке выпустить новый
   паспорт по этой строке.
4. После `REJECTED` помощник может подать новую заявку (например, если
   потом ещё накроили и снова закрывают).

**RBAC.**

- Подача — `CUTTER_ASSISTANT` (основной флоу), `SHOP_MANAGER`, `ADMIN`.
- Просмотр (`GET list/detail`, `GET /passports/:id/cutting-closure-request`) —
  `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`. Прочие роли в раздел не
  ходят.
- Approve / reject — только `SHOP_MANAGER`, `ADMIN`.

**Где видно в UI.**

- `/passports/[id]` → блок «Закрытие раскроя» (план/факт/остаток,
  статус, кнопки в зависимости от роли) — см. `screens.md §3`.
- `/orders/[id]` → баннер «Закрытие раскроя по размерам» с активными
  и подтверждёнными заявками.

**Что заявка не делает.** Она не уменьшает `qtyPlan`, не закрывает
сам заказ (статус `Order` мастер по-прежнему ведёт вручную), не
возвращает уже выпущенные паспорта. Это «стоп на новый выпуск», а не
изменение факта раскроя.

---

## 16. Склады (Warehouse)

Реализовано пост-Шагом 14, см. [ADR-0019](./adr/0019-warehouses.md).
Доменная цель — дать начальнику цеха управленческую группировку
ячеек физического хранения, не трогая существующий flow «scan cell →
place passport».

**Сущность.** `Warehouse(id, name UNIQUE, code UNIQUE NULL, isActive,
createdAt, updatedAt)`. Связь one-to-many: `Warehouse 1..N Cell` через
nullable `Cell.warehouseId` (FK `ON DELETE SET NULL`). Полная схема —
`erd.md §2.13a`.

**Зачем nullable.** Существующие ячейки и ячейки, под которые ещё нет
описанного склада, остаются без `warehouseId`. Это:

- не требует data-migration «придумать дефолтный склад»;
- не ломает `POST /api/passports/:id/place` и
  `POST /api/cells/by-code` — оба продолжают работать с любой ячейкой,
  привязана она или нет;
- честно отражает реальность пилотного цеха («есть тележки, которые
  мы пока не описывали»).

**Жизненный цикл.**

1. `SHOP_MANAGER` / `ADMIN` создаёт склад (`POST /api/warehouses`)
   с понятным именем и опциональным коротким `code`. Имена и коды
   уникальны, дубль возвращает `WAREHOUSE_NAME_TAKEN` /
   `WAREHOUSE_CODE_TAKEN` (409).
2. Менеджер привязывает существующую ячейку к складу:
   `PATCH /api/cells/:id { warehouseId }`. Перепривязка между складами
   разрешена явно (никаких блокировок «нельзя двигать ячейку с
   паспортами» — складская группировка не влияет на flow `place`).
3. Деактивация — `PATCH /api/warehouses/:id { isActive: false }`.
   API на удаление склада не предоставляется — менеджер только
   выключает. Если склад всё-таки удалить через БД, `ON DELETE
   SET NULL` сохранит ячейки и обнулит ссылку (см. ADR-0019).

**Массовая печать этикеток** (`POST /api/warehouses/:id/print-cells`,
см. `api.md §15`, `screens.md §10b`). Менеджер из карточки склада
запускает «Печать всех ячеек»: backend создаёт `cellsCount × copies`
PENDING-`PrintJob`-ов с `sourceType=CELL_LABEL`, по одному на каждую
копию каждой **активной** ячейки склада. Очередь идёт через тот же
`PrintJobsService.createBatch`, что и одиночная печать, и тот же
агент рядом с принтером (см. §17 «Принтеры»). Деактивированные
ячейки молча исключаются. Контракт payload-а — `GET /api/cells/:id/print`,
жёсткий формат **38×58 мм горизонтально, QR слева + крупный
номер справа, без любого иного текста** (стандартная термоэтикетка
для маркировки полок; см. ADR-0008 для QR и `cell-print.ts` для
шаблона).

**RBAC.**

- Все ручки `/api/warehouses/*` и `PATCH /api/cells/:id` —
  `SHOP_MANAGER` / `ADMIN`. Прочие роли получают `403 FORBIDDEN_ROLE`.
- `GET /api/cells/:id/print` и `GET /api/cells/:id/qr` — `@Public()`,
  как у passports/equipment (ADR-0010): принтер-станция работает без
  сессии. QR-payload `cell:{id}` (ADR-0008) не меняется.

**Где видно в UI.**

- `/admin/warehouses` — список складов, форма создания (см.
  `screens.md §10b`).
- `/admin/warehouses/[id]` — реквизиты склада, ячейки склада с
  кнопкой «Печать QR» и primary-кнопкой «Печать всех ячеек»
  (открывает модалку настройки массовой печати — выбор принтера,
  размер этикетки 38×58, число копий, превью, см. `screens.md §10b`),
  блок «Линии склада» и блок «Привязать ячейку».
- Тайл «Склад» на главной и пункт в админ-нав-баре — только для
  `ADMIN`/`SHOP_MANAGER`.

**Что склад не делает.** Он не влияет на размещение паспорта в
ячейку, не вводит capacity/планирование, не моделирует
зоны/секции/полки, не пишет audit log перемещений (только
`Warehouse.updatedAt` + структурный лог `event=warehouse.create` /
`event=cell.warehouse.assign`). Всё это сознательно за рамками MVP —
см. ADR-0019 §5.

---

## 17. Себестоимость выпуска (Production Cost)

Управленческий read-only модуль. Доменная цель — дать `SHOP_MANAGER` /
`ADMIN` ответ на «сколько нам стоила смена и где мы простаивали»,
не вводя ни новых сущностей в БД, ни новых событий в журнал.

Источники данных — только то, что уже пишется производственным
процессом:

- `OperationEntry` (статус `APPROVED`) — сдельщина (см. §9);
- `SalaryEntry` (`SHIFT_DAY` / `MANUAL`) — окладные начисления (см. §9a);
- `PassportEvent` (`OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`,
  `PACKED`) — длительности стадий и факт упаковки (см. `events.md`);
- `Employee.compensationType` + `salaryPerShift` — стоимость минуты
  для окладного сотрудника.

### Стоимость минуты

Управленческая константа `SHIFT_MINUTES = 480` (8-часовая смена,
см. ADR-0021). Стоимость минуты сотрудника:

```
minuteRate = salaryPerShift / SHIFT_MINUTES      // ₽/мин
```

Считается только для `compensationType ∈ {SALARY, MIXED}` с
положительной ставкой. `PIECEWORK` минутной стоимости не имеет —
его вклад в себестоимость = только сумма `OperationEntry`.

### Длительность стадии (`PassportDurationsService`)

Для каждого паспорта по стадии `QC` / `WTO` / `PACKING` рассчитываем
пару `acceptedAt → completedAt` из `PassportEvent`:

| Стадия | acceptedAt | completedAt | Исполнитель |
|--------|------------|-------------|-------------|
| QC | последний `OPERATION_SCAN` категории `QC` до `QC_PASSED` | ближайший `QC_PASSED` после accept | `QC_PASSED.employeeId` |
| WTO | последний `OPERATION_SCAN` категории `IRONING` до `WTO_PASSED` | ближайший `WTO_PASSED` | `WTO_PASSED.employeeId` |
| PACKING | предыдущий `PACKED` того же упаковщика в ту же UTC-дату или (если первого нет) `PACKED − 1 минута` | сам `PACKED` | `PACKED.employeeId` |

Длительность округляется вверх до целой минуты (любая ненулевая
работа считается минимум 1 минута) и cap-ается сверху константой
`MAX_STAGE_MINUTES_PER_PASSPORT = 60`. Cap защищает от аномалии
«сотрудник принял паспорт и забыл закрыть» — без него такая запись
съела бы весь оклад смены и ушла в минус по простою.

PACKING обрабатывается отдельно: на MVP `PackingService.addPassport`
не пишет `OPERATION_SCAN` (упаковка — это «scan into box → PACKED»
в одной транзакции). Поэтому accept-точка для упаковки выводится из
разрыва между двумя соседними `PACKED` того же упаковщика — это и
есть «время на одну упаковку». Этот модуль ничего в существующем
flow упаковки не меняет (см. `flows.md §F7`).

### Себестоимость одного упакованного паспорта

```
totalCost(passport) =
    Σ OperationEntry.amount [status=APPROVED]                  // piecework
  + Σ stage.durationMinutes × employee.minuteRate              // оклад tracked
```

Окладная доля распределяется ровно по тем сотрудникам и стадиям, что
работали на этом паспорте — это и есть «учтённое время».

### Простой (`idleMinutes` / `idleCost`)

Считается отдельно по сотруднику-окладнику в день, в который у него
была хотя бы одна `SalaryEntry`:

```
paid     = SHIFT_MINUTES                             // 480 мин
tracked  = Σ stage.durationMinutes за этот день      // из PassportEvent
idleMin  = max(0, paid − tracked)
idleCost = idleMin × minuteRate
```

**Простой НЕ распределяется на изделия и не входит в `totalCost`
изделия.** Это управленческая отдельная строка («сколько мы
заплатили за то, чтобы человек присутствовал, но ничего не делал
по нашему производственному пайплайну»).

### Дневная агрегация

`PACKED.createdAt` (UTC) задаёт дату «выпуска» паспорта. Стадии,
завершившиеся в эту же дату, суммируются в `trackedMinutes` дня;
`SalaryEntry` за эту дату — в множество окладных сотрудников дня.
Дни без событий тоже возвращаются в ответе с нулями — чтобы линия
графика не рвалась (см. `screens.md §17`).

### RBAC и инварианты

- Доступ — `SHOP_MANAGER`, `ADMIN` (см. `api.md §17`). Прочие роли
  получают `403 FORBIDDEN_ROLE`.
- Никаких новых таблиц/колонок/событий: модуль read-only поверх
  существующего журнала.
- Все суммы в `Decimal(12,2)`, в ответе округлены до двух знаков.
- Период считается по UTC; пустой query → последние 14 календарных
  дней.

См. `api.md §17`, `screens.md §17`.

### 17a. Дашборд начальника производства

Управленческая надстройка над §17. Не вводит ни новых сущностей, ни
новых колонок: backend (`/api/dashboard/production`) собирает один
ответ из уже работающих источников:

- pipeline — `Passport` + `Order` + `PassportEvent(QC_PASSED/WTO_PASSED)`,
  правила маппинга на стадии — те же, что у `/shopfloor`
  (см. ADR-0013), чтобы цифры по стадиям совпадали 1:1 между двумя
  экранами;
- выпуск — `Σ Passport.qtyGood` по `PassportEvent(PACKED)` за UTC-сегодня
  и за период;
- WIP — `Passport.status ∈ {CREATED, IN_PROGRESS}`;
- заказы в производстве — `Order.status = IN_PRODUCTION`;
- себестоимость и простой по дням — переиспользуем `CostsService`
  (т.е. ту же логику §17 «Себестоимость выпуска» / `api.md §17`);
- загрузка по ролям — `PassportDurationsService.listForPeriod` за день
  «to», агрегированный по `Employee.role` ∈ `{QC, IRONING, PACKING}`
  с теми же правилами `paid/tracked/idle`, что и в §17 (только
  сгруппированы не по сотруднику, а по роли);
- алерты — top-items проблемных зон: bottleneck-стадия, роль с
  максимальным простоем за день, окладной сотрудник с максимальным
  `idleMinutes`, день периода с самым дорогим простоем, паспорта,
  где сработал cap длительности `MAX_STAGE_MINUTES_PER_PASSPORT`.

Семантика «сегодня vs период» жёсткая: KPI-карточки «сегодня»
(`producedToday`, `avgCostPerUnitToday`, `idleCostToday`,
`utilizationToday`) считаются по UTC-сегодня независимо от `?days=`,
а график (`trend`) и сводки `…Period` — за `[dateTo − days + 1 .. dateTo]`.
Это сделано сознательно, чтобы UI не перемешивал «KPI дня» и «KPI
периода» (см. контракт `api.md §11b` и UX-инварианты `screens.md §18`).

Доступ — `SHOP_MANAGER`, `ADMIN`; backend защищён
`@Roles('SHOP_MANAGER', 'ADMIN')`. См. `api.md §11b`, `screens.md §18`.


## §17b. Печать через агент рабочего места (MVP)

Печать любых документов (паспорт, QR паспорта, этикетка коробки,
QR ячейки) делается не из браузера, а через **агент** —
Node.js-процесс, постоянно живущий рядом с физическим принтером на
Windows-станции. Сотрудник в системе нажимает «Печать», backend
кладёт задание в очередь, агент его забирает и печатает.

### Сущности

#### `Printer`

| Поле          | Тип                  | Назначение                                                  |
|---------------|----------------------|-------------------------------------------------------------|
| `id`          | cuid                 | Постоянный идентификатор.                                   |
| `name`        | string               | «Принтер ОТК-1» — для UI.                                   |
| `type`        | `PrinterType` enum   | `PASSPORT`/`QR`/`LABEL`/`DEFAULT`. На MVP — управленческая метка. |
| `equipmentId` | FK → `Equipment`     | Привязка к рабочему месту. Один принтер на место.           |
| `isActive`    | bool                 | Менеджерская мягкая деактивация без удаления истории.       |
| `pairingCode` | string?              | Одноразовый код, выдаваемый кнопкой «Сгенерировать код».    |
| `agentToken`  | string?              | Постоянный секрет агента (после `pair`). Хранится открытым (внутренняя сеть цеха). |
| `isOnline`    | bool                 | True после успешного heartbeat.                             |
| `lastSeenAt`  | timestamp?           | Время последнего контакта агента.                           |
| `agentHostName`            | string?     | `os.hostname()` Windows-машины, на которой запущен агент. Заполняется агентом, нужен менеджеру, чтобы понимать «какой именно компьютер сейчас представляет этот логический принтер». |
| `availableWindowsPrinters` | string[]    | Список физических Windows-принтеров, найденных агентом через `Get-Printer`. Хранится как массив строк (Postgres `TEXT[]`), всегда есть значение, по умолчанию `[]`. Перезаписывается целиком при каждой синхронизации. |
| `windowsPrintersUpdatedAt` | timestamp?  | Когда агент в последний раз прислал `availableWindowsPrinters` — нужно для UI («список устарел»). |
| `selectedWindowsPrinter`   | string?     | Имя выбранного менеджером физического Windows-принтера из `availableWindowsPrinters`. Это и есть та точка, куда агент реально шлёт печать. `null` = «не выбран» → агент отказывается печатать. |

Логический `Printer` в системе и **физический Windows-принтер** —
разные сущности:

- логический `Printer` живёт в БД, к нему привязан `Equipment` и
  `PrintJob`-и; именно его выбирают по «смене сотрудника»;
- физический Windows-принтер — это драйвер на конкретной Windows-машине
  (HP LaserJet, Zebra ZD220, Microsoft Print to PDF…). На одной машине
  их может быть несколько, и без явного выбора печатать в проде
  небезопасно.

Связка задаётся именно через `selectedWindowsPrinter` (одно конкретное
имя из последнего `availableWindowsPrinters`, что прислал агент с
этого `agentHostName`).

`PrinterType` сейчас не влияет на выбор принтера: на MVP логика
работает только по `equipmentId + isActive`. Тип используется для
UI-различий и заложен на будущее («один QR + один LABEL на место»).

#### `PrintJob`

| Поле           | Тип                    | Назначение                                              |
|----------------|------------------------|---------------------------------------------------------|
| `printerId`    | FK → `Printer`         | Куда печатаем.                                          |
| `sourceType`   | `PrintJobSource` enum  | `PASSPORT_QR`/`PASSPORT_PRINT`/`BOX_LABEL`/`CELL_QR`/`CELL_LABEL`/`TEST`. `CELL_LABEL` — готовая 38×58 HTML-этикетка ячейки (`/api/cells/:id/print`), используется массовой печатью «Печать всех ячеек» (см. §16). |
| `sourceId`     | string?                | Идентификатор объекта-источника (без FK — экономия).    |
| `payloadUrl`   | string                 | Абсолютный URL существующего печатного endpoint-а API.  |
| `status`       | `PrintJobStatus` enum  | `PENDING` → `PRINTED` или `FAILED`.                     |
| `errorMessage` | string?                | Заполняется агентом при `FAILED`.                       |
| `completedAt`  | timestamp?             | Когда агент закрыл задание.                             |

Каждый `PrintJobDto`, который backend отдаёт агенту, дополнительно
несёт `selectedWindowsPrinter` — текущее значение из `Printer`. Это
сделано, чтобы у агента был «снимок выбора на момент задания»: даже
если менеджер сменит физический принтер сразу после polling-а, конкретное
задание уйдёт туда, куда задумывалось при выдаче.

Сознательно простая модель: ретраев и SENT/PROCESSING нет, повторная
печать = новый job. `payloadUrl` указывает на УЖЕ существующие
endpoint-ы (`/api/passports/:id/print`, `/api/passports/:id/qr`,
`/api/packing/boxes/:id/label`, `/api/cells/:id/qr`) — мы НЕ дублируем
рендер.

### Логика выбора принтера

Когда сотрудник нажимает «Печать» (без явного `printerId`):

1. Берём активную смену сотрудника (`ShiftSession.endedAt = null`).
2. Если смены нет — `409 SHIFT_SESSION_REQUIRED`.
3. Берём `equipmentId` смены, ищем `Printer` где
   `equipmentId = ?` и `isActive = true`. Если несколько —
   первый по `createdAt` (на MVP достаточно).
4. Если принтера нет — `409 PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`.

`PrintButton` на фронтенде при коде `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`
или `SHIFT_SESSION_REQUIRED` открывает `fallbackHref` в новой вкладке —
это сохраняет печать на тех рабочих местах, где агент ещё не настроен.

### Подключение агента (pair flow)

1. Менеджер в `/admin/printers` создаёт `Printer`, привязывает к
   `Equipment`.
2. Жмёт «Сгенерировать код» → backend пишет `pairingCode` (формат
   `PAIR-XXXX-XXXX`, алфавит без 0/O/1/I) и возвращает его в UI.
3. Жмёт «Скачать агент» → ссылка на `GET /api/printers/agent-download/sewing-print-agent.exe`
   (public-endpoint, отдаёт собранный Windows-exe из
   `apps/agent/dist/sewing-print-agent.exe`; сборка —
   `cd apps/agent && npm run build:win`).
4. На Windows-станции (без установки Node.js):
   ```
   sewing-print-agent.exe --pair --server https://api.example --code PAIR-XXXX-XXXX
   sewing-print-agent.exe
   ```
   Pair-команда обменивает `pairingCode` на постоянный `agentToken` и
   `printerId`, сохраняет их в локальный `agent-config.json`. После
   `pair`-а `pairingCode` на сервере очищается.
5. Агент в основном режиме раз в 2-3 секунды бьёт
   `GET /api/print-jobs/agent` (с `X-Printer-Agent-Token`). Каждый
   poll обновляет `Printer.lastSeenAt` и `isOnline=true` — так UI
   `/admin/printers` рисует «онлайн».
6. При появлении `PrintJob` агент скачивает `payloadUrl`,
   физически печатает и отправляет `PATCH /api/print-jobs/:id` со
   статусом `PRINTED` или `FAILED + errorMessage`.

### Выбор Windows-принтера (flow)

Полная цепочка `pair → upload printers → manager selects → print`
выглядит так:

1. **Pair.** Менеджер делает шаги 1-4 выше (`Printer` создан,
   `pairingCode` обменян на `agentToken`).
2. **Upload printers.** Сразу после `pair` (и затем каждые ~60 сек)
   агент:
   - читает `os.hostname()`;
   - на Windows вызывает `Get-Printer | Select-Object -ExpandProperty Name`
     и получает `availableWindowsPrinters: string[]`;
   - шлёт `POST /api/printers/agent/windows-printers`
     с `{ hostName, printers }` под `X-Printer-Agent-Token`.

   Backend сохраняет `agentHostName`, `availableWindowsPrinters`,
   `windowsPrintersUpdatedAt`, обновляет `isOnline/lastSeenAt`,
   возвращает текущий `selectedWindowsPrinter` (нужен агенту, чтобы
   сразу знать, куда печатать).
3. **Manager selects.** В `/admin/printers/[id]` появляется блок
   «Физический принтер Windows» с `agentHostName`, статусом «онлайн»
   и `<select>` по `availableWindowsPrinters`. Сохранение делает
   `PATCH /api/printers/:id { selectedWindowsPrinter }`.
   Backend проверяет, что выбранное имя есть в `availableWindowsPrinters`,
   иначе — `422 WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`.
4. **Print.** При выдаче job-а агенту backend кладёт в `PrintJobDto`
   текущий `selectedWindowsPrinter`. Агент печатает именно туда. Если
   `selectedWindowsPrinter = null` (менеджер ещё не выбрал) — агент
   не печатает и сразу закрывает job как `FAILED` с понятным
   `errorMessage`, чтобы было видно в `/admin/printers/:id` и не
   терялось в `payload.pdf`-моменте.

Если агент офлайн, UI всё равно показывает последний известный
`agentHostName + availableWindowsPrinters + selectedWindowsPrinter` и
`windowsPrintersUpdatedAt` («список от 2026-04-20 14:32») —
менеджер видит, с чем работал последний раз.

### RBAC

- `SHOP_MANAGER`/`ADMIN` — управляют принтерами (CRUD), генерируют
  pairingCode, видят список и историю заданий, делают тестовую
  печать на конкретный принтер.
- Любая залогиненная роль — может вызвать `POST /api/print-jobs`
  без `printerId` (выбор принтера по своей смене).
- Передавать явный `printerId` в `POST /api/print-jobs` могут только
  менеджеры (тестовая печать) — иначе `403 FORBIDDEN_ROLE`.
- Агент авторизуется заголовком `X-Printer-Agent-Token`. Без
  токена / с неактивным принтером — `401`.

См. `api.md §16`, `screens.md §18`, `apps/agent/README.md`.


## §18. Маршруты производства (production routes, soft-route MVP)

«Шаблон маршрута производства» — упорядоченный список операций, по
которому идёт партия: например, `Раскрой → Пошив → ОТК → ВТО →
Упаковка`. На MVP это **«мягкий» маршрут**:

- менеджер заводит шаблоны в `/admin/routes`;
- при создании заказа можно (опционально) привязать `routeTemplateId`;
- при `OrdersService.start()` шаги шаблона фиксируются в **snapshot**
  `OrderRouteStep[]` — заказ становится самодостаточным и больше не
  зависит от того, что менеджер сделает с шаблоном дальше (правка
  шагов / деактивация / удаление);
- паспорт хранит подсказку `Passport.currentRouteStepIndex` — индекс
  текущего шага в snapshot-е заказа;
- **никакого enforcement**: на `POST /api/passports/:id/scan` мы не
  проверяем «совпадает ли операция с маршрутом». Если совпадает —
  обновляем `currentRouteStepIndex`, если нет — оставляем как было,
  scan всё равно проходит. UI на `/work` подсветит warning, но не
  заблокирует.

### Сущности

#### `RouteTemplate`

| Поле       | Тип      | Назначение                                                     |
|------------|----------|----------------------------------------------------------------|
| `id`       | cuid     | Постоянный идентификатор.                                      |
| `code`     | string   | Уникальный человекочитаемый код, регистр `[A-Z0-9_-]` (например, `TSHIRT-BASIC`). Используется в API и в селекте при создании заказа. |
| `name`     | string   | Видимое название («Базовая футболка»).                          |
| `isActive` | bool     | Менеджерская мягкая деактивация: неактивный шаблон не виден в селекте при создании нового заказа, но snapshot-ы старых заказов продолжают жить. |
| `createdAt`/`updatedAt` | timestamp | Стандарт. |

#### `RouteTemplateStep`

| Поле          | Тип   | Назначение                                                        |
|---------------|-------|-------------------------------------------------------------------|
| `id`          | cuid  | Постоянный идентификатор.                                         |
| `templateId`  | FK → `RouteTemplate` | `ON DELETE CASCADE`.                                |
| `index`       | int   | 0-based позиция шага. Уникально в рамках шаблона (`@@unique([templateId, index])`). |
| `operationId` | FK → `Operation`     | `ON DELETE RESTRICT` — нельзя случайно удалить операцию, на которую ссылается шаблон. Уникально в рамках шаблона (`@@unique([templateId, operationId])`) — операция в шаблоне ровно один раз. |
| `isOptional`  | bool  | Зафиксировано в данных, но на MVP не используется в enforcement-е (готовим себе пространство для «можно пропустить шаг» в будущем). |

#### `OrderRouteStep` (snapshot)

| Поле          | Тип   | Назначение                                                        |
|---------------|-------|-------------------------------------------------------------------|
| `id`          | cuid  | Постоянный идентификатор.                                         |
| `orderId`     | FK → `Order` | `ON DELETE CASCADE`.                                       |
| `index`       | int   | 0-based позиция шага в snapshot-е (`@@unique([orderId, index])`). |
| `operationId` | FK → `Operation` | `ON DELETE RESTRICT`.                                  |

Snapshot создаётся в **транзакции** внутри `OrdersService.start()`:
если у заказа выставлен `routeTemplateId` И snapshot-а ещё нет —
читаем активные шаги шаблона и инсертим `OrderRouteStep[]`. Если
шаблона нет — snapshot не создаётся, заказ идёт по «старому» flow
без подсказок (полный backward-compatibility).

### Жизненный цикл

1. **Менеджер заводит шаблон** в `/admin/routes/new`: код, название,
   набор операций в нужном порядке (стрелки ↑/↓), флажок
   «опционально» на отдельных шагах.
2. **Менеджер создаёт заказ** в `/orders/new` и (опционально)
   выбирает шаблон в селекте «Шаблон маршрута». До запуска заказ
   живёт в `DRAFT` — `routeTemplateId` можно сменить через
   `PATCH /api/orders/:id` (после `start()` менять нельзя).
3. **Менеджер запускает заказ** (`POST /api/orders/:id/start`).
   В транзакции: статус → `IN_PRODUCTION`, snapshot
   `OrderRouteStep[]` инсертится из активных шагов шаблона.
4. **Создаётся паспорт** (`POST /api/passports`). Если у заказа есть
   snapshot — `Passport.currentRouteStepIndex = 0`.
5. **Швея сканирует паспорт на операции** (`POST /api/passports/:id/scan`).
   Если операция найдена в snapshot-е заказа — индекс паспорта
   обновляется на найденный. Если нет — не меняется. Scan-у это
   никак не мешает.
6. **На `/work` карточка `Сейчас в работе`** показывает
   «Сейчас: Шаг N: <Op>» и «Далее: Шаг N+1: <Op>». Если операция
   текущей смены не совпадает с маршрутом — выводится мягкое
   жёлтое предупреждение «Внимание: ваша смена идёт на другой
   операции — маршрут заказа сейчас на шаге <X>». Кнопки приёма /
   завершения остаются доступными.

### Что специально НЕ делаем на MVP

- Не проверяем порядок шагов на бэкенде (никаких 409-ов «шаг
  пропущен» / «не та операция»). См. `STEP 5` ТЗ MVP.
- Не пересохраняем snapshot при правке шаблона: уже запущенные
  заказы продолжают идти по своему `OrderRouteStep[]`.
- Не показываем маршрут на `/orders/:id` UI диаграммой — на MVP
  достаточно подсказки в `/work`. Snapshot всё равно отдаётся в
  `OrderDetailDto.routeSteps` и доступен фронту.

См. `api.md §17 (routes)`, `screens.md §«Маршруты»`,
`apps/api/src/modules/routes/`.

## §19. Техкарты (tech cards, MVP)

См. ADR-0022. Техкарта — справочный шаблон **«потребностей на единицу
изделия»**: какие материалы нужны и какие внешние подрядные размещения
(шелкография, печать этикеток, вышивка — `OUTSOURCED_SERVICE` из
терминологии операций). Техкарта и маршрут — **независимые** оси:
маршрут отвечает «что делает швея», техкарта — «что нужно положить в
этот заказ». Привязка к заказу опциональна: можно создать заказ без
техкарты (полная backward compatibility со старым flow).

### Сущности

#### `TechCardTemplate`

- `id`, `code` (уникален), `name`, `isActive`.
- Имеет связи `materialLines: TechCardMaterialLine[]` и
  `outsourceLines: TechCardOutsourceLine[]`.
- Деактивированный шаблон скрыт в селекте при создании заказа, но
  остаётся виден в редактировании уже привязанного DRAFT-заказа
  (тот же UX, что и `RouteTemplate`).

#### `TechCardMaterialLine`

- `name`, `unit` (обязательно), `qtyPerUnit Decimal(12,4)` (> 0,
  валидируется DTO/сервисом, не DB-check), `note?`, `sortOrder`.
- Cascade-FK на `TechCardTemplate`. Имена внутри одной техкарты не
  уникализируем (бывают одинаковые ткани разного назначения).

#### `TechCardOutsourceLine`

- `name`, `unit?`, `qtyPerUnit Decimal(12,4)?`, `vendorName?`,
  `note?`, `sortOrder`.
- `unit`/`qtyPerUnit` опциональны: часть подрядов считается «за
  партию» без явной нормы.
- `vendorName` — свободный текст, vendor-directory мы НЕ строим.

#### `Order.techCardId`

- Опциональная FK, аналог `routeTemplateId`. На MVP менеджер
  выбирает техкарту вручную (`Product.defaultTechCardId` отложен).

#### `OrderMaterialRequirement` / `OrderOutsourceRequirement` (snapshot)

- Read-only план потребностей конкретного заказа. Создаётся в
  `OrdersService.start()` и больше не меняется при правках техкарты.
- Поля копируют шаблон + добавляется `totalQty Decimal(12,4)`
  (для outsource — nullable).
- FK `sourceTechCardLineId` — nullable, **`ON DELETE SET NULL`**.
  Это и есть «независимость snapshot-а»: даже если позже строку
  шаблона удалят, snapshot заказа продолжает работать со
  скопированным именем/нормой/итогом, просто без обратной ссылки.

### Жизненный цикл

1. **Менеджер заводит техкарту** в `/admin/tech-cards/new`: код,
   название, активность; добавляет строки материалов и/или внешних
   потребностей (без drag-and-drop, порядок строк = порядок в
   форме).
2. **Менеджер создаёт заказ** в `/orders/new` и опционально
   выбирает техкарту в селекте «Техкарта». До запуска заказ живёт
   в `DRAFT` — `techCardId` можно сменить через
   `PATCH /api/orders/:id`. После `start()` поменять нельзя
   (`409 ORDER_TECH_CARD_ALREADY_STARTED`).
3. **Менеджер запускает заказ** (`POST /api/orders/:id/start`).
   В одной транзакции: статус → `IN_PRODUCTION`, snapshot
   маршрута (если выбран `routeTemplateId`), snapshot техкарты
   (если выбран `techCardId`).
4. **Расчёт `totalQty`**:
   - `baseQty = Σ OrderItem.qtyPlan` по всем строкам заказа;
   - для материалов: `totalQty = qtyPerUnit * baseQty`
     (`Prisma.Decimal`-математика, без округлений);
   - для outsource: `totalQty = qtyPerUnit * baseQty`, если
     `qtyPerUnit != null`; иначе snapshot хранит `totalQty = null`.
5. **Карточка заказа** (`/orders/:id`) отдаёт snapshot read-only:
   блоки «Материалы» и «Внешние потребности». Источник истины —
   snapshot заказа, а не live-шаблон. Если `techCardId == null` или
   заказ ещё в `DRAFT`, оба блока показывают спокойный empty-state
   «не зафиксированы».

### Что специально НЕ делаем на MVP

- **Никаких формул/размерных коэффициентов/процентов отходов** —
  только плоский `qtyPerUnit * baseQty`.
- **Не enforce-им «нельзя стартовать без техкарты»** — техкарта
  опциональна, как `routeTemplateId`.
- **Не строим `Product.defaultTechCardId`** — менеджер выбирает
  руками. Это сахар, который добавится без breaking-changes.
- **Не строим vendor-directory** — `vendorName` свободный текст.
- **Не учитываем snapshot потребностей в `CostsService` /
  dashboard** — material-cost остаётся как есть (см. ADR-0022,
  «Отложено»).
- **Не трогаем shopfloor / display / паспорта / QC / WTO / packing
  flow** — техкарта живёт сбоку и не влияет на пайплайн
  производства.

См. `api.md §«tech-cards»`, `screens.md §«Техкарты»`, ADR-0022,
`apps/api/src/modules/tech-cards/`.
