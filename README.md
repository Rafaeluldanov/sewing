# Sewing — система управления швейным производством (MVP)

> ⚠️ **README is HISTORICAL ROADMAP (PHASE 1, 2026-Q2)** ⚠️
>
> Текущий `README.md` (≈153 KB) — **исторический roadmap** и
> летопись MVP-этапов 1..N. Он содержит много устаревших
> утверждений о структуре потоков, ролей и snapshot-логики
> заказа, и **не является source of truth** для новых
> разработчиков и Cursor-агентов.
>
> Актуальные источники истины (PHASE 1):
>
> - [`docs/index.md`](./docs/index.md) — карта документации
>   с явными статусами `OK / OUTDATED / DRAFT / ARCHIVED`.
> - [`docs/api.md`](./docs/api.md) — REST-контракт,
>   собран строго из текущих контроллеров
>   `apps/api/src/modules/**/*.controller.ts`.
> - [`docs/erd.md`](./docs/erd.md) — модель БД,
>   собрана строго из `prisma/schema.prisma`.
> - Будущие flow-документы:
>   - `docs/order-flow.md` (TODO)
>   - `docs/production-flow.md` (TODO)
>   - `docs/display-board.md` (TODO)
>
> Сам этот README **не переписывается** в PHASE 1. Используйте
> его только как backlog / historical reference, и при любом
> расхождении доверяйте документам выше и коду
> (`apps/api/src/modules/**`, `prisma/schema.prisma`).

---

Центральная сущность — **Паспорт изделия**: описывает партию (размер + цвет
+ рулон), двигается по всем этапам (раскрой → пошив → ОТК → ВТО → упаковка)
и несёт всю экономику (брак, операции, зарплаты).

---

## Документация

Полная документация в каталоге [`docs/`](./docs/index.md). Главные файлы:

- [`docs/architecture.md`](./docs/architecture.md) — архитектура и стек
- [`docs/domain.md`](./docs/domain.md) — доменная модель
- [`docs/erd.md`](./docs/erd.md) — описание БД
- [`docs/flows.md`](./docs/flows.md) — бизнес-потоки
- [`docs/events.md`](./docs/events.md) — событийная модель
- [`docs/api.md`](./docs/api.md) — REST API
- [`docs/screens.md`](./docs/screens.md) — карта экранов
- [`docs/pilot/`](./docs/pilot) — Pilot Rollout / UAT (план, onboarding, FAQ, фидбек)
- [`docs/deploy-stage.md`](./docs/deploy-stage.md) — развёртывание stage (`stage.teeon.ru`)
- [`docs/deploy-uploads-static-routing.md`](./docs/deploy-uploads-static-routing.md) — nginx-роутинг `/uploads/*` в API
- [`docs/adr/`](./docs/adr) — архитектурные решения

Документация — **источник истины**. При расхождении с кодом — правим код.

---

## Стек

TypeScript · Next.js 14 (App Router, PWA) · NestJS 10 · PostgreSQL 15 ·
Prisma 5 · QR-коды · PDF.

---

## Структура репозитория

```
apps/
  web/     Next.js 14 PWA (клиент)
  api/     NestJS backend
packages/
  shared/  общие типы / Zod-схемы
prisma/
  schema.prisma
  seed.ts
docs/
```

Обоснование — [ADR-0001](./docs/adr/0001-monorepo-structure.md).

---

## Быстрый старт

```bash
cp .env.example .env          # ОБЯЗАТЕЛЬНО: без .env с DATABASE_URL
                              # `prisma:migrate` и `db:seed` упадут с
                              # `Environment variable not found: DATABASE_URL`
npm install
npm run prisma:migrate        # применить миграции (требует DATABASE_URL)
npm run db:seed               # наполнить справочники демо-данными (требует DATABASE_URL)
npm run dev:api               # в одном терминале
npm run dev:web               # в другом
```

> **`DATABASE_URL`** — обязательная переменная окружения. Описана в
> [`.env.example`](./.env.example), читается из `.env` и Prisma'й
> ([`prisma/schema.prisma`](./prisma/schema.prisma): `url = env("DATABASE_URL")`),
> и seed-скриптом. Должна указывать на работающий PostgreSQL.

Полный сброс БД с повторным применением миграций и seed-а:

```bash
npm run db:reset
```

---

## Seed-данные (Шаг 3)

Seed живёт в [`prisma/seed.ts`](./prisma/seed.ts) и подключён через
поле `prisma.seed` в `package.json`, поэтому работает и через стандартный
`prisma db seed`, и через `npm run db:seed`. Seed **идемпотентен**:
повторный запуск не создаёт дубликатов (везде `upsert` по стабильным ключам).

Заполняются:

- **Размеры** (`Size`) — детские `104…164`, взрослые `XS…6XL` с
  `sortOrder` в бизнес-порядке (не по алфавиту).
- **Продукты** (`Product`) — «Футболка белая» (`tshirt_white`), «Футболка
  черная» (`tshirt_black`).
- **Операции** (`Operation`) — полный MVP-набор в нужном порядке,
  коды в UPPER_SNAKE_CASE: `CUT_PATTERN_PRINT`, `CUT_SPREADING`, `CUT_CUT`,
  `CUT_DIVISION`, `CUT_BASE_PREP`, `CUT_RIBANA_PREP`, `CUT_ISSUE`,
  `SEW_OVERLOCK_1`, `SEW_BINDING`, `SEW_OVERLOCK_2`, `SEW_COVERSTITCH`,
  `QC`, `WTO`, `PACKING` (см. [`docs/domain.md §4`](./docs/domain.md)).
- **Сотрудники** (`Employee`) — демо-учётки по одной на каждую роль
  (см. таблицу ниже).
- **Оборудование** (`Equipment`) — 8 демо-единиц с QR в формате
  [ADR-0008](./docs/adr/0008-qr-format.md) (`equipment:{id}`). У
  каждой единицы — ручной `displayNumber` для физической маркировки
  (см. [`docs/domain.md §5c`](./docs/domain.md)). Печатается крупно
  на этикетке `GET /api/equipment/:id/print` (см. `docs/api.md §3a`),
  редактируется в `/admin/equipment/[id]`.
- **Связь оборудование ↔ операции** (`EquipmentOperation`,
  [ADR-0017](./docs/adr/0017-equipment-allowed-operations.md)) — для
  каждого станка задан конфигурируемый набор разрешённых операций.
  Seed создаёт дефолтные связи: `overlock-* → SEW_OVERLOCK_1,
  SEW_OVERLOCK_2`; `coverstitch-* → SEW_COVERSTITCH`; `binding-* →
  SEW_BINDING`; станции ОТК / ВТО / упаковки → соответствующие
  операции. Эти связи — **источник истины** для seamstress flow на
  `/work` (frontend больше не маппит операции по префиксу
  `Equipment.code`). Управление — `/admin/equipment` (список),
  `/admin/equipment/new` (создание нового станка отдельной страницей)
  и `/admin/equipment/[id]` (карточка) — роли `ADMIN`, `SHOP_MANAGER`.
- **Ячейки** (`Cell`) — `A1`, `A2`, `B1`, `B2` с QR `cell:{id}`.
- **Тариф операций** (`Operation.pricingMode` + `OperationRateBySize`,
  Шаг 18, [ADR-0020](./docs/adr/0020-operation-pricing-model.md)) —
  единый источник истины для сдельной зарплаты:
  `CUT_CUT = FIXED` (одна цена 10/шт);
  `SEW_OVERLOCK_1` / `SEW_OVERLOCK_2` = `BY_SIZE`
  (`OperationRateBySize` по размерам, детские дешевле, 2XL+ чуть
  дороже взрослых базовых); все остальные операции = `SALARY_ONLY`.
  Управление — `/admin/operations` (роли `ADMIN`, `SHOP_MANAGER`).
  Историческая таблица `PieceRate` удалена в PHASE 2 STEP 1
  (миграция `20260532100000_drop_legacy_salary_base_and_piece_rate`,
  см. ADR-0020 §«PHASE 2 — drop legacy»). Все ставки живут в
  `Operation.fixedRate` / `OperationRateBySize`; миграция Шага 18
  заранее бэкфилила их из `PieceRate` ещё до удаления таблицы.
- **Виды брака** (`DefectType`, Шаг 7) — `STAIN`, `HOLE`, `CROOKED_SEAM`,
  `SKEW`, `INCOMPLETE`, `OTHER`. Идемпотентно по `code`.

### Демо-учётки

Единый демо-пароль: **`Demo12345!`**. В seed-е (`prisma/seed.ts`) PIN всегда
переустанавливается на `Demo12345!` — поэтому после `npm run db:seed` (даже
на «грязной» БД) демо-учётки гарантированно входят через `/login`
(см. ADR-0014). Пишутся обе колонки PIN: bcrypt-хеш `pinHash` (по нему
проверяется вход) и обратимая копия `pinEnc`, из которой карточка
`/admin/employees/[id]` показывает пароль менеджеру.

| Логин           | Роль                | Тип оплаты   |
| --------------- | ------------------- | ------------ |
| `admin`         | `ADMIN`             | SALARY       |
| `shop-chief`    | `SHOP_MANAGER`      | SALARY       |
| `cutter`        | `CUTTER`            | PIECEWORK    |
| `cutter-helper` | `CUTTER_ASSISTANT`  | SALARY       |
| `seamstress`    | `SEAMSTRESS`        | PIECEWORK    |
| `qc`            | `QC`                | SALARY       |
| `wto`           | `IRONING` (ВТО)     | SALARY       |
| `packer`        | `PACKING`           | SALARY       |

---

## Домены и конфигурация URL-ов

| Окружение | Web                     | API                         |
| --------- | ----------------------- | --------------------------- |
| prod      | `https://prod.teeon.ru` | `https://api.prod.teeon.ru` |
| stage     | `https://stage.teeon.ru`| `https://stage.teeon.ru/api`|
| dev       | `http://localhost:3000` | `http://localhost:3001/api` |

Источник истины для URL-ов — переменные окружения. В коде (`apps/web/lib/config.ts`,
`packages/shared/src/config.ts`) используются:

- `APP_URL` / `NEXT_PUBLIC_APP_URL` — UI;
- `API_URL` / `NEXT_PUBLIC_API_URL` — API.

Константы `DOMAIN_PROD_WEB` / `DOMAIN_PROD_API` / `DOMAIN_STAGE` — только
fallback. Хардкод `localhost` или prod-хостов в исходниках **не допускается**.

---

## Шаг 4 — Заказы

Реализован модуль заказов (`apps/api/src/modules/orders`,
`apps/web/app/orders`):

- `POST /api/orders` — создать заказ (автоген номера `O-YYYYMMDD-NNNN`).
- `GET /api/orders` — список с поиском по номеру, фильтром по статусу,
  сортировкой и пагинацией.
- `GET /api/orders/:id` — карточка с `summary` и `sizeBreakdown`.
- `PATCH /api/orders/:id` — редактирование только в статусе `DRAFT`.
- `POST /api/orders/:id/start` — `DRAFT → IN_PRODUCTION` (блокирует план, ADR-0006).
- `POST /api/orders/:id/complete` — ручной перевод в `DONE`.
- `POST /api/orders/:id/cancel` — отмена заказа.

UI:

- `/orders` — список с поиском / фильтром по статусу / сортировкой.
- `/orders/new` — форма создания (дата, изделие, цвет, комментарий,
  сетка размеров).
- `/orders/[id]` — **агрегированная карточка по размерам**, summary-cards,
  таблица по размерам (план/раскроено/пошив/ОТК/ВТО/упаковка/выпуск/брак/
  остаток/Δ) + блок «Паспорта» (см. Шаг 5).
- `/orders/[id]/edit` — редактирование (только для `DRAFT`).

`qtyCutFact` подключён на Шаге 5 (см. ниже). Остальные факт-показатели
(пошив / ОТК / ВТО / упаковка / выпуск / брак) на Шаге 5 возвращаются как
нули — агрегатор `order-aggregator.ts` подключит их на Шагах 6–8 без
изменения DTO/UI.

---

## Шаг 5 — Паспорт изделия (выпуск + размещение)

Реализован модуль паспортов (`apps/api/src/modules/passports`,
`apps/web/app/passports`, `apps/web/app/orders/[id]/passports`):

- `POST /api/passports` — выпуск паспорта помощником раскройщика
  (автоген номера `P-YYYYMMDD-NNNN`, QR `passport:{id}` —
  [ADR-0008](./docs/adr/0008-qr-format.md), `PassportEvent(CREATED)`).
- `GET /api/passports/:id` — карточка паспорта.
- `GET /api/passports/:id/print` — печатная HTML-форма формата A6 со
  встроенным data-URL QR (см.
  [ADR-0010](./docs/adr/0010-passport-print-and-placement.md) — почему HTML, а не PDF).
- `GET /api/passports/:id/qr` — QR в PNG.
- `POST /api/passports/:id/place` — разместить паспорт в ячейке
  (инкремент `CellContent`, `Passport.currentCellId`,
  `PassportEvent(CELL_PLACED)`).
- `GET /api/orders/:id/passports` — список паспортов заказа (drill-down).
- `GET /api/cells`, `GET /api/cells/:id` — ячейки + срез содержимого.

**Бизнес-правила** (см. `docs/api.md §5`):

- выпуск только для заказа в `IN_PRODUCTION` (ADR-0010);
- размер должен входить в заказ;
- `qtyCut > 0` и не сверх остатка плана по размеру (ADR-0006);
- один паспорт = одна текущая ячейка (ADR-0010); повторное размещение
  даёт `409 PASSPORT_ALREADY_PLACED`;
- `cutterId` (раскройщик-сдельщик) и `creatorId` (помощник) — фиксированные
  демо-сотрудники из seed (`cutter` / `cutter-helper`); реальный
  `creatorId` подтянется из `ShiftSession` на Шаге 7.

**UI:**

- `/orders/[id]` — блок «Паспорта» (кнопка «Выпустить паспорт» +
  компактная таблица, см. `docs/screens.md §7.3`).
- `/orders/[id]/passports/new` — форма выпуска (размер, дата кроя,
  qtyCut, рулон).
- `/passports/[id]` — карточка с QR, печатью и формой размещения.

**Зарплата.** По [ADR-0005](./docs/adr/0005-salary-timing.md)
начисление раскройщику возникает в момент создания паспорта. Сам модуль
начислений реализуется на Шаге 9 — на Шаге 5 факт зафиксирован только
событием `PassportEvent(CREATED)`.

> После применения миграции запустите её локально:
>
> ```bash
> npm run prisma:migrate -- --name step5_passports
> ```

---

## Шаг 6 — Смена + выдача кроя + сканирование

Появляется первый «живой» экран (`apps/web/app/work`) и первое движение
паспортов по операциям. Реализовано:

- **Смены (`apps/api/src/modules/shifts`).**
  - `POST /api/shifts/start` — `{ employeeId, equipmentId, operationId }`;
  - `POST /api/shifts/stop` — `{ employeeId }`;
  - `GET /api/shifts/current?employeeId=…` — активная сессия;
  - `GET /api/shifts/current-work` — массив активных кроев,
    закреплённых за сессионным сотрудником
    (`Passport.currentEmployeeId = me AND status = IN_PROGRESS`).
    Используется на `/work` для устойчивого блока «Текущий крой»;
    backend сам режет данные по сессии — обычный сотрудник не видит
    чужой крой (см. `docs/api.md §3` и `docs/screens.md §3.4`).
  - `GET /api/shifts/meta` — справочник сотрудников/оборудования/операций
    для формы смены. У каждой единицы оборудования возвращается
    `allowedOperationIds` — список разрешённых операций из таблицы
    `EquipmentOperation` (см. ADR-0017); `/work` использует именно его.
  - Правило: у сотрудника не более одной активной
    `ShiftSession (endedAt IS NULL)` — проверяется в сервисе.

- **Выдача кроя (`POST /api/passports/:id/issue`).** Швея на активной
  смене снимает паспорт с ячейки: `CellContent.quantity -= qtyCut`,
  `Passport.currentCellId = NULL`, `currentEmployeeId = employeeId`,
  `status = IN_PROGRESS`; пишется
  `PassportEvent(ISSUED_TO_EMPLOYEE, operationId=session.operationId)`.

- **Сканирование (`POST /api/passports/:id/scan`).** Любое
  сканирование = переход: `currentOperationId = session.operationId`,
  `currentEmployeeId = session.employeeId`,
  `PassportEvent(OPERATION_SCAN)`. Повторный скан той же смены — no-op
  (ADR-0003 §6).

- **Резолв паспорта (`POST /api/passports/by-code`).** Разворачивает
  QR `passport:{id}`, номер `P-…` или голый id — используется `/work`
  перед `issue`/`scan`.

- **UI `/work`.** Mobile-first экран: пикер демо-сотрудника (cookie
  `demo-employee-id`, до auth на Шаге 7) → форма старта смены → две
  крупные кнопки «Получить крой» / «Сканировать паспорт» + инпут кода.
  Для роли SEAMSTRESS поверх этого добавлен устойчивый блок «Текущий
  крой» (`CurrentWorkCard`): после приёма кроя швея всегда видит
  свой рабочий контекст (паспорт, изделие/цвет, размер, количество,
  рулон, текущая операция, время приёма), а не только короткий
  success-state. Данные приходят из `GET /api/shifts/current-work`.

- **Схема.** В `PassportEventType` добавлены значения
  `ISSUED_TO_EMPLOYEE` и `OPERATION_SCAN`. Применить:
  ```bash
  npm run prisma:migrate -- --name step6_work
  ```

**Новые коды ошибок** (`docs/api.md §13`):
`SHIFT_SESSION_REQUIRED`, `SHIFT_ALREADY_ACTIVE`, `SHIFT_NOT_ACTIVE`,
`PASSPORT_NOT_IN_CELL`, `PASSPORT_ALREADY_ISSUED`,
`PASSPORT_ALREADY_PACKED`, `PASSPORT_CANCELLED`,
`EMPLOYEE_NOT_FOUND/INACTIVE`, `EQUIPMENT_NOT_FOUND/INACTIVE`,
`OPERATION_INACTIVE`.

---

## Шаг 7 — ОТК и фиксация брака

Реализован модуль ОТК (`apps/api/src/modules/qc`,
`apps/web/app/qc`):

- **Справочник видов брака.** Новая таблица `DefectType` + seed
  `seedDefectTypes()` (`STAIN/HOLE/CROOKED_SEAM/SKEW/INCOMPLETE/OTHER`).
  `GET /api/defect-types` возвращает только активные.
- **Запись брака.** Новая таблица `PassportDefect`
  (`passportId, defectTypeId, qty, comment?, createdByEmployeeId?,
  createdAt`). Один паспорт = много записей.
- **API.**
  - `GET /api/qc/passports` — список паспортов в работе
    (`status = IN_PROGRESS`) с поиском, пагинацией и фильтром по `orderId`;
  - `GET /api/qc/passports/:id` — карточка ОТК + история дефектов;
  - `POST /api/qc/passports/:id/defects` — фиксация брака в одной
    транзакции с инкрементом `Passport.qtyDefect/qtyGood` и записью
    `PassportEvent(DEFECT_RECORDED)`;
  - `GET /api/passports/:id/defects` — история по паспорту для
    карточки `/passports/[id]`.
- **Агрегаты заказа.** `qtyDefect` по размеру и `qtyDefectTotal` в
  `OrderSummary` теперь берутся из `Σ Passport.qtyDefect` живых
  паспортов (см. `apps/api/src/modules/orders/order-aggregator.ts`).
- **UI.**
  - `/qc` для роли QC — **scan-driven role-terminal** по той же
    модели, что `/work` у швеи (см. `apps/web/app/qc/qc-terminal.tsx`,
    `docs/screens.md §5`): большая кнопка «Сканировать паспорт»,
    после скана раскрывается рабочая карточка паспорта с цифрами,
    формой «Зафиксировать брак» и кнопкой **«Проверка выполнена»**
    (`POST /api/qc/passports/:id/complete`). Глобальный header и
    mobile-nav на `/qc` у роли QC скрыты.
  - **Legacy `/work` для QC отключён.** Если QC попадает на `/work`
    (старая закладка, ручной url), `apps/web/app/work/page.tsx`
    делает SSR-редирект в `/qc` ещё до загрузки `getShiftMeta`.
    Старая ветка с табами «Получить крой / Сканировать паспорт» и
    кнопкой «Завершить смену» для QC больше никогда не рендерится
    (поведение зафиксировано в `tests/smoke/frontend-rbac.smoke.test.ts`,
    блок «legacy /work disabled for QC / IRONING / PACKING»).
    Аналогичный редирект работает для IRONING (`/wto`) и PACKING
    (`/packing`).
  - `/qc/passports/[id]` оставлен как fallback-карточка для
    менеджеров/админа (открывается из `/passports/[id]` или из
    обзорных экранов).
  - В `/passports/[id]` сохранён блок «Качество (ОТК)» со
    счётчиками и ссылкой «Открыть в ОТК».
  - В шапке сайта — пункт меню **ОТК** (для менеджеров/админа).
- **Бизнес-правила** (см. `docs/flows.md §F5`, `docs/domain.md §5.3`):
  - паспорт доступен ОТК только в статусе `IN_PROGRESS`;
  - `qty > 0` и `qty ≤ qtyCut − qtyDefect`;
  - `defectType` существует и активен;
  - `employeeId` опционален (cookie `demo-employee-id`, до auth).
- **Схема.** Добавлены модели `DefectType`, `PassportDefect` и
  обратные связи в `Passport.defects`/`Employee.passportDefects`.
  Применить:
  ```bash
  npm run prisma:migrate -- --name step7_qc_defects
  npm run db:seed
  ```

**Новые коды ошибок** (`docs/api.md §13`):
`PASSPORT_NOT_QCABLE`, `DEFECT_TYPE_NOT_FOUND`, `DEFECT_TYPE_INACTIVE`,
`DEFECT_EXCEEDS_REMAINING`.

**Событие «Проверка выполнена».** В `PassportEventType` добавлено
значение `QC_PASSED` — его пишет `POST /api/qc/passports/:id/complete`,
который дёргается из scan-driven терминала ОТК. Событие не двигает
`Passport.status` и не влияет на pipeline — это аудит-маркер «ОТК
прошло». Применить миграцию:
```bash
npm run prisma:migrate -- --name qc_passed_event
```

**Свернутая строка «Проверено ОТК».** После нажатия «Проверка
выполнена» большая рабочая карточка `QcWorkCard` сворачивается в
одну компактную строку `QcCompletedRow`
(`apps/web/app/qc/qc-completed-row.tsx`): номер паспорта · размер ·
годное количество · бейдж «Проверено ОТК». Кнопок «брак» / «проверка
выполнена» в свернутом виде уже нет.

Когда тот же паспорт реально уходит дальше по pipeline (сотрудник на
следующей операции делает `OPERATION_SCAN`, см. `flows.md §F4`) или
попадает в терминальный статус (`PACKED`/`CANCELLED`), backend
проставляет в `QcPassportDetailDto.removedFromQc = true`
(`QcService.loadDetail` — без новых таблиц и миграций), и терминал
ОТК полностью убирает строку из окна. Frontend сам ничего не
угадывает: он лишь поллит `getQcPassport` каждые ~10 секунд
(`QC_REMOVED_POLL_INTERVAL_MS`) и подчиняется флагу. Подробнее —
`docs/flows.md §F5`, `docs/screens.md §5.1`.

---

## Шаг 8 — ВТО, упаковка и выпуск изделия

Закрыта основная производственная цепочка MVP. Архитектурные решения —
[`docs/adr/0011-packing-and-release.md`](./docs/adr/0011-packing-and-release.md).
Реализованы модуль `apps/api/src/modules/packing` и UI `apps/web/app/packing`.

- **ВТО — отдельный scan-driven role-terminal `/wto`** (полный аналог
  `/qc`, см. ниже §«Шаг 8a — ВТО role-terminal»). Гладильщик
  принимает паспорт по QR (`POST /api/passports/:id/scan` под сменой
  категории `IRONING`) и завершает обработку кнопкой «Завершить ВТО»
  (`POST /api/wto/passports/:id/complete`, пишет
  `PassportEvent(WTO_PASSED)`). На входе работает QC-gate: backend
  отказывается принять паспорт без `QC_PASSED` (409
  `PASSPORT_NOT_QC_PASSED`).
- **Коробки.** Используются модели `Box` и `BoxItem` (`prisma/schema.prisma`).
  Номер коробки — `B-YYYYMMDD-NNNN` (`BoxNumberService`),
  QR — `box:{id}` (по аналогии с паспортом, ADR-0010).
- **Упаковка = выпуск изделия.** Добавление паспорта в коробку через
  `POST /api/packing/boxes/:id/add-passport` в одной транзакции:
  создаёт `BoxItem(qty=passport.qtyGood)`, инкрементит `Box.totalQty`,
  переводит `Passport.status → PACKED`, очищает `currentEmployeeId/currentCellId`,
  пишет `PassportEvent(PACKED, boxId, employeeId, qty)`. Паспорт со
  `status = PACKED` больше не принимает `issue/scan/place/qc/add-passport`
  (`PASSPORT_ALREADY_PACKED`).
- **Инварианты коробки.** Капасити `totalQty + qtyGood ≤ maxQty`
  (на MVP `maxQty = 100`); soft-проверка однородности
  `(productId, color, sizeId)` всех `BoxItem` в коробке
  (`BOX_HOMOGENEITY_VIOLATED`); `BoxItem(boxId, passportId)` уникален.
- **Закрытие коробки.** `POST /api/packing/boxes/:id/close` ставит
  `closedAt` и блокирует дальнейшие добавления (`BOX_CLOSED`).
  Закрытие пустой коробки запрещено (`BOX_EMPTY`).
- **API.**
  - `GET /api/packing/boxes?status=OPEN|CLOSED&q=&page=&pageSize=`
    — список с пагинацией;
  - `GET /api/packing/boxes/:id` — карточка коробки + `items[]` + summary
    + `labelUrl`;
  - `POST /api/packing/boxes` — создание коробки;
  - `POST /api/packing/boxes/:id/add-passport` — упаковка паспорта
    (требует активной смены категории `PACKING`,
    `PACKING_SHIFT_REQUIRED`);
  - `POST /api/packing/boxes/:id/close` — закрытие;
  - `GET /api/packing/boxes/:id/qr` — PNG QR-код;
  - `GET /api/packing/boxes/:id/label` — HTML-этикетка для печати
    (PDF-вариант — за рамками MVP, ADR-0010).
- **Агрегаты заказа.** `order-aggregator.ts` теперь считает
  `qtyFinished` / `qtyFinishedTotal` как `Σ Passport.qtyGood` по
  паспортам со `status = PACKED`. Колонка «Выпущено» в карточке заказа
  заполняется автоматически (см. `docs/domain.md §5.4`).
- **UI.**
  - `/packing` для роли `PACKING` — единый scan-driven терминал
    (см. `apps/web/app/packing/packing-terminal.tsx`,
    `docs/screens.md §6`). Поток в одном окне: «Открой смену
    (QR оборудования) → Создай коробку → Сканируй паспорта → Закрой
    коробку». `<AppHeader>` для роли скрыт, глобальная навигация
    выключена (`SINGLE_WORKSPACE_ROLES`); меню «Завершить смену» и
    «Выйти» спрятаны в три-точечный `SeamstressActionsMenu`.
  - `/packing` для `SHOP_MANAGER` / `ADMIN` — управленческий список
    коробок с фильтром статуса и формой «Новая коробка».
  - `/packing/boxes/:id` — управленческая карточка с QR, сводкой
    партии, `BoxItem[]`, формой «Сканировать паспорт» и кнопкой
    «Закрыть» (используется упаковщиком как fallback и менеджером
    для debug).
  - `/passports/:id` — блок «Упаковка» со ссылкой на коробку, если
    паспорт уже упакован.
  - В шапке сайта — пункт меню **Упаковка** (только для тех ролей,
    у которых не скрыта навигация).
- **Зарплата.** Финальный апрув pending-начислений теперь сидит в
  `PackingService.close` (см. ADR-0005, ADR-0011 §7 и блок «Шаг 9»
  ниже): закрытие коробки идемпотентно переводит все
  `OperationEntry { status = PENDING_RELEASE }` упакованных в
  коробке паспортов в `APPROVED`.

**Новые коды ошибок** (`docs/api.md §13`):
`BOX_NOT_FOUND`, `BOX_CLOSED`, `BOX_EMPTY`,
`BOX_CAPACITY_EXCEEDED`, `BOX_HOMOGENEITY_VIOLATED`,
`PASSPORT_NOT_PACKABLE`, `PACKING_SHIFT_REQUIRED`.

Миграции БД для Шага 8 не нужны — `Box`/`BoxItem`,
`PassportStatus.PACKED` и `PassportEventType.PACKED` уже были в
`prisma/schema.prisma` со Шага 1.

---

## Шаг 8a — ВТО role-terminal (`/wto`, derived stage `WTO_DONE`)

ВТО доведена до того же уровня, что ОТК: scan-driven role-terminal +
derived-стадия на экране «Цех». Бизнес-правила — `docs/flows.md §F6`,
архитектура derived-стадии —
[`docs/adr/0013-shopfloor-stage-mapping.md`](./docs/adr/0013-shopfloor-stage-mapping.md)
§«WTO_DONE bucket». Реализованы модуль `apps/api/src/modules/wto` и
UI `apps/web/app/wto`.

- **`PassportEvent(WTO_PASSED)`.** Новое значение enum (`prisma/schema.prisma`
  + миграция `20260419130000_wto_passed_event`). Аудит-маркер «ВТО
  выполнено», полный аналог `QC_PASSED`. `Passport.status` не меняется.
- **QC-gate на входе.** `PassportsService.scanOnOperation` отказывается
  переключать `currentOperation` на категорию `IRONING`, если у
  паспорта нет ни одного `PassportEvent(QC_PASSED)`. В ответе — 409
  `PASSPORT_NOT_QC_PASSED`. Источник истины — backend, поэтому
  обойти gate через прямой `POST /api/passports/:id/scan` нельзя
  (ни UI, ни сторонний клиент). Идемпотентный re-scan на той же
  операции пропускается без проверки.
- **API.**
  - `GET /api/wto/passports/:id` — карточка ВТО + `qcPassedAt` /
    `wtoCompletedAt` / `canCompleteWto` / `removedFromWto`;
  - `POST /api/wto/passports/:id/complete` — «Завершить ВТО»: пишет
    `PassportEvent(WTO_PASSED, qty=qtyGood,
    operationId=passport.currentOperationId, employeeId)`. Идемпотентно.
    Без `QC_PASSED` отвечает 409 `PASSPORT_NOT_QC_PASSED`; вне
    категории `IRONING` или для терминального паспорта — 409
    `PASSPORT_NOT_WTOABLE`. Полный список ошибок — `docs/api.md §8a`.
  - Списка `GET /api/wto/passports` нет: терминал scan-driven, как и
    `/qc`. Менеджеры/админ смотрят прогресс на `/shopfloor`.
- **RBAC.** `IRONING`, `SHOP_MANAGER`, `ADMIN`. На фронте — `canSeeWto`
  в `apps/web/lib/rbac.ts`; primary workspace для роли `IRONING` —
  теперь `/wto` (а не `/work`), и `IRONING` входит в
  `SINGLE_WORKSPACE_ROLES` (header / mobile-nav на `/wto` спрятаны).
- **Frontend.** `apps/web/app/wto/wto-terminal.tsx` — оркестратор
  скана/полла; `wto-work-card.tsx` — большая карточка с кнопкой
  «Завершить ВТО»; `wto-completed-row.tsx` — компактная свернутая
  строка «ВТО завершено · ⟨время⟩». Полная симметрия с `/qc`:
  свернутая строка автоматически исчезает, как только backend вернёт
  `removedFromWto = true` (есть `OPERATION_SCAN` после
  `wtoCompletedAt`, либо терминальный статус). Поллинг — каждые
  ~10 секунд.
- **Экран «Цех».** Добавлена derived-стадия `WTO_DONE` в shopfloor-проекцию:
  свежий `WTO_PASSED` (новее последнего `OPERATION_SCAN`) переводит
  паспорт из колонки `ВТО` в `ВТО завершено`, не меняя `Passport.status`
  и не плодя новые таблицы. После следующего `OPERATION_SCAN`
  паспорт уходит обычным маппингом (`PACKING/...`). `WTO` и `WTO_DONE`
  взаимоисключающие. Реализация — `shopfloor-projection.ts` +
  `shopfloor.service.ts` (один `groupBy` по `QC_PASSED`/`WTO_PASSED`/
  `OPERATION_SCAN` с фильтром по списку id-кандидатов).

**Новые коды ошибок** (`docs/api.md §8a`):
`PASSPORT_NOT_QC_PASSED`, `PASSPORT_NOT_WTOABLE`.

---

## Шаг 9 — Сдельные начисления (зарплата минимум)

Включена сдельная зарплата раскройщика и пошива поверх уже работающей
цепочки. Архитектурные решения — [ADR-0005](./docs/adr/0005-salary-timing.md)
и [ADR-0012](./docs/adr/0012-earning-deduplication.md). Реализованы
модуль `apps/api/src/modules/earnings`, страница `apps/web/app/earnings`
и блок «Начисления» в карточке паспорта.

- **Кто считается.** Только `Employee.compensationType ≠ SALARY`
  (т.е. `PIECEWORK` или `MIXED`) на операциях `CUT_CUT`,
  `SEW_OVERLOCK_1`, `SEW_BINDING`, `SEW_OVERLOCK_2`, `SEW_COVERSTITCH`.
  Окладные сотрудники (`compensationType = SALARY` — ОТК, помощник
  раскройщика, упаковщики, ВТО) в `OperationEntry` не попадают.
  Историческое `Employee.paymentType` удалено — `compensationType`
  единственный источник истины «как платим» (см.
  `docs/domain.md §9a`, миграция `20260429100000_remove_payment_type`).
- **Раскройщик (immediate).** В транзакции `PassportsService.create`
  после `PassportEvent(CREATED)` создаётся
  `OperationEntry { qty=qtyCut, ratePerUnit, amount, status=APPROVED,
  approvalMode=IMMEDIATE, sourceEventType=PASSPORT_CREATED,
  approvedAt=now() }`. Если для пары `(CUT_CUT, sizeId)` нет
  ставки в `OperationRateBySize` (или `Operation(CUT_CUT).fixedRate`
  пуст для `pricingMode=FIXED`) — транзакция падает с 422
  `OPERATION_RATE_MISSING` (silent-skip отключён сознательно;
  ADR-0005, ADR-0020).
- **Пошив (after release).** В транзакции
  `PassportsService.scanOnOperation` после
  `PassportEvent(OPERATION_SCAN)` создаётся
  `OperationEntry { qty=qtyCut, status=PENDING_RELEASE,
  approvalMode=AFTER_RELEASE, sourceEventType=OPERATION_TRANSITION }`
  для **предыдущих** `operationId`/`employeeId` — если предыдущая
  операция входит в piecework-набор пошива и предыдущий исполнитель
  сдельщик. При повторном скане сработает уникальный индекс
  `OperationEntry_idem` и `safeCreate` молча его проглотит
  (см. ADR-0012).
- **Подтверждение при закрытии коробки** (см. ADR-0005, ADR-0011 §7).
  Финальный апрув pending-начислений теперь происходит в транзакции
  `PackingService.close`: сервис итерируется по `BoxItem[]`
  закрываемой коробки и для каждого `passportId` вызывает
  `EarningsService.approvePendingForPassport(passportId)`, который
  переводит все `PENDING_RELEASE` (а также legacy `PENDING`) в
  `APPROVED` с `approvedAt = now()`. Это ровно один «final completion
  event» на коробку — соответствует scan-driven UX упаковщика
  («открыл смену → создал коробку → отсканировал паспорта → закрыл
  коробку = начислил всем»). Идемпотентно: повторный close отдаёт
  `BOX_CLOSED`, а сам метод фильтрует только pending-строки. Никаких
  начислений за саму упаковку **не создаётся** — упаковщик окладник.
- **API** (`docs/api.md §10`):
  - `GET /api/earnings` — список с фильтрами `employeeId`,
    `passportId`, `status`, `approvalMode`, `dateFrom`, `dateTo` и
    пагинацией;
  - `GET /api/earnings/summary` — сводка
    (`totalApproved/totalPending/countApproved/countPending`);
  - `GET /api/passports/:id/earnings` — начисления по паспорту.
- **RBAC видимости** (источник истины — backend, см. `docs/api.md §10`).
  `SHOP_MANAGER` и `ADMIN` (`EARNINGS_MANAGER_ROLES` в
  `apps/api/src/modules/earnings/earnings.constants.ts`) видят все
  строки и могут фильтровать по любому `employeeId`/`status`. Все
  остальные роли (`SEAMSTRESS`, `CUTTER`, `CUTTER_ASSISTANT`, `QC`,
  `IRONING`, `PACKING`, …) принудительно сужаются `EarningsService` до
  своего `employeeId` и только статуса `APPROVED` — попытки обойти
  ограничение через query-параметры молча игнорируются. Покрыто
  `tests/integration/earnings-rbac.test.ts`.
- **UI** (`docs/screens.md §12`):
  - `/earnings` для менеджера — полный список + сводка
    (Подтверждено / Ожидает выпуск / Всего) + фильтры (сотрудник,
    статус, период);
  - `/earnings` для обычного сотрудника — «Мои начисления»: одна
    сумма Подтверждено, таблица без колонок «Сотрудник»/«Статус», без
    фильтра по сотруднику и статусу;
  - блок «Начисления» в `/passports/[id]` — для менеджера три суммы и
    полная таблица, для обычного сотрудника только свои подтверждённые
    строки;
  - в шапке сайта — пункт меню **Зарплата**.
- **Схема.** Расширение `OperationEntry` тремя полями
  (`approvalMode`, `sourceEventType`, `sourceEventId`), новые enum-ы
  `ApprovalMode`/`EarningSource`, новые значения
  `EntryStatus.PENDING_RELEASE` / `REVERSED` и уникальный индекс
  `OperationEntry_idem(passportId, operationId, employeeId,
  sourceEventType)`. Применить:
  ```bash
  npm run prisma:migrate -- --name step9_earnings
  ```

**Новые коды ошибок** (`docs/api.md §13`):
`PIECE_RATE_NOT_FOUND`, `EARNING_NOT_FOUND` (зарезервирован).

**За рамками Шага 9 (см. ограничения в `flows.md §F9`):** окладная
часть, ведомость за месяц, удержания за брак по виновной операции,
экспорт в Excel/PDF, интеграция с 1С/ЗУП, сложные правила ревизии,
полноценный личный кабинет сотрудника, экран «Цех».

---

## Шаг 10 — Экран «Цех» (живой дашборд по этапам)

Управленческий экран `/shopfloor` для начальника цеха: матрица
**размер × этап → qty** поверх уже работающей цепочки (заказы +
паспорта + ОТК + упаковка). Никаких изменений схемы БД, никаких новых
событий, никакого realtime — только агрегированный endpoint и
3-секундный polling. Архитектурное решение по маппингу — [ADR-0013](./docs/adr/0013-shopfloor-stage-mapping.md);
polling — [ADR-0007](./docs/adr/0007-polling-for-realtime.md).

- **Stage buckets** (см. `docs/flows.md §F11` и ADR-0013):

  | Колонка    | Что попадает                                                                       | qty       |
  |------------|------------------------------------------------------------------------------------|-----------|
  | `Крой`     | `status = CREATED`                                                                 | `qtyCut`  |
  | `Пошив`    | `IN_PROGRESS` + `currentOperation.category ∈ {CUTTING, SEWING}` (выдача → шитьё)   | `qtyCut`  |
  | `ОТК`      | `IN_PROGRESS` + `category = QC` + нет свежего `QC_PASSED`                          | `qtyCut`  |
  | `Проверено ОТК` | `IN_PROGRESS` + `category = QC` + свежий `QC_PASSED` (`QC_DONE`, ADR-0013)    | `qtyCut`  |
  | `ВТО`      | `IN_PROGRESS` + `category = IRONING` + нет свежего `WTO_PASSED`                    | `qtyCut`  |
  | `ВТО завершено` | `IN_PROGRESS` + `category = IRONING` + свежий `WTO_PASSED` (`WTO_DONE`, ADR-0013) | `qtyCut`  |
  | `Упаковка` | `PACKED` + есть `BoxItem` в OPEN-коробке (MVP-аппроксимация, ADR-0013)             | `qtyGood` |
  | `Выпущено` | `PACKED` И НЕ попал в «Упаковка»                                                   | `qtyGood` |
  | `Брак`     | `Σ Passport.qtyDefect` среди не-`CANCELLED`. Не stage; отдельная колонка.          | —         |

  Бакеты взаимоисключающие — каждое изделие учитывается ровно один раз.

- **API** (`docs/api.md §11`):
  - `GET /api/shopfloor/state[?orderId=…]` — снапшот матрицы
    (`updatedAt`, `scope`, `summary`, `rows[]`).
  - `GET /api/shopfloor/orders` — активные заказы для селекта на UI.
- **UI** (`docs/screens.md §9`):
  - `/shopfloor` — крупная доска с summary-стрипом и таблицей по
    размерам;
  - селектор «Заказ» (все активные / конкретный); URL обновляется
    через `history.replaceState`;
  - чекбокс «Авто-обновление» (по умолчанию включён) и ручная кнопка
    «↻ Обновить»;
  - индикатор `● обновлено HH:MM:SS` в шапке;
  - адаптив: ≥ 1500 px — увеличенный шрифт цифр (для ТВ/моноблока),
    ≤ 900 px — компактный шрифт + горизонтальный скролл таблицы.
- **Анимация**. При изменении значения в ячейке — короткий (~1.1 сек)
  flash-фон: **зелёный** для прироста, **красный** для убыли.
  Реализовано чистым CSS-keyframes (`shopfloor-flash-up` /
  `shopfloor-flash-down` в `globals.css`). Полноценная анимация
  «перелёта объекта» — за рамками MVP (см. ADR-0013 §«Аппроксимация
  анимации»).
- **Polling**. Клиент `apps/web/app/shopfloor/shopfloor-board.tsx`
  вызывает `${NEXT_PUBLIC_API_URL}/shopfloor/state` каждые 3 секунды.
  В шапке сайта появился пункт меню **Цех**.

### Шаг 10b — большой монитор `/shopfloor/display` (light-theme dashboard)

Отдельный read-only экран под ТВ/моноблок в самом цеху. Это
не управленческий `/shopfloor` (его трогать не стали), а
сфокусированный на потоке производства dashboard для роли
`DISPLAY`. Подробности — в [`docs/screens.md §9a`](./docs/screens.md)
и [`docs/api.md §11`](./docs/api.md).

- **Один агрегированный endpoint.** `GET /api/shopfloor/display`
  возвращает KPI-блок (`producedToday/inWork/waiting/qc/wto/packing/finished/defect`),
  матрицу `цвет × размер × stage` и статусы оборудования с
  категорией для иконки одним «снимком». Реализация —
  `ShopfloorService.getDisplaySummary()` поверх той же чистой
  проекции, что и `/shopfloor` (`projectShopfloorDisplay`); никаких
  новых таблиц/событий. Цифры между `/shopfloor` и `/shopfloor/display`
  гарантированно сходятся (общий `bucketOf`/`pickQty`).
- **Светлая тема (изолированная).** CSS-переменные
  `--display-bg/--display-fg/--display-accent/--display-ok/...`
  скоупаны под `.display-screen` в `apps/web/app/globals.css`,
  плюс модификатор `.display-screen--light` (`color-scheme: light`).
  Глобальная тема приложения **не** переключается — на других
  страницах интерфейс остаётся прежним.
- **Layout.**
  - шапка: «ЦЕХ · LIVE» + крупное текущее время + статус связи
    «обновлено N сек назад»;
  - KPI-row (8 карточек) — Выпущено сегодня, В работе, Ждёт, ОТК,
    ВТО, Упаковка, Готово, Брак;
  - слева — большая матрица «Поток производства по размерам и цветам»
    (Чёрный/Белый сверху, остальные по алфавиту, итоги по цвету
    и общий итог);
  - справа — компактные плитки оборудования (~30 рабочих мест:
    иконка `kind` + крупный `displayNumber`, цвет рамки по
    статусу `ONLINE/WARNING/OFFLINE`, легенда сверху, счётчики снизу).
  - блоки «Активные заказы» и «Проблемы» убраны — на большом
    мониторе они уводили внимание от потока.
- **Иконки оборудования.** Backend выводит
  `ShopfloorEquipmentStatusDto.kind` (`SEWING/CUTTING/QC/IRONING/PACKING/OTHER`)
  из `OperationCategory` разрешённых на станке операций
  (приоритет `SEWING > CUTTING > IRONING > QC > PACKING`); UI
  выбирает inline-SVG по `kind` (`IconSewingMachine`/`IconCuttingTable`/
  `IconIron`/`IconQcMagnifier`/`IconBox`).
- **Polling 7 сек** (окно 5–10 по ADR-0007). Soft-fail: первые
  ≤4 сетевые ошибки подряд не пересобирают экран — так сетевые
  glitch-и у планшета на стене не вызывают мерцания. На 5-й
  показывается крупный indicator «Нет связи».
- **Read-only гарантирован тестом.** В `display-board.tsx` нет
  `<button>`, `<form>`, `onClick`, `onSubmit` — фиксируется
  `tests/smoke/shopfloor-display.smoke.test.ts`. Backend-контракт
  и матрица «цвет × размер» покрыты smoke + integration
  (`tests/integration/shopfloor-display.test.ts`).

**Что НЕ делает Шаг 10:**

- не вводит websocket/SSE и любую отдельную realtime-инфраструктуру;
- не создаёт новых таблиц / событий / снапшотов;
- не трогает существующие транзакции `PassportsService`,
  `QcService`, `PackingService`, `EarningsService`;
- не делает Canvas/WebGL и реальную timeline-анимацию;
- не делает drill-down с экрана в список паспортов;
- не делает auth/RBAC, BI/reporting и дашборд начальника
  (`/dashboard`).

---

## Шаг 11 — MVP 1.1 / Stabilization

Этап стабилизации перед внутренним запуском. Архитектурные решения —
[ADR-0014](./docs/adr/0014-auth-and-sessions.md) (auth/sessions),
[ADR-0015](./docs/adr/0015-db-invariants.md) (DB-инварианты),
[ADR-0016](./docs/adr/0016-test-strategy.md) (стратегия тестов).

- **Реальная авторизация.** Demo-cookie `demo-employee-id` удалён из всех
  потоков. Появились `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/me` (см. `docs/api.md §1`). Сессия — подписанная
  HttpOnly cookie `sewing_session` (HMAC-SHA256 на `JWT_SECRET`,
  `SameSite=Lax`, в production — `Secure` и `Domain=.teeon.ru`).
  TTL — `JWT_EXPIRES_IN` (по умолчанию `12h`).
- **RBAC.** Глобальный `AuthGuard` валидирует cookie и подгружает
  свежие `role/active` на каждом запросе. `@Roles(...)` ограничивает
  endpoint-ы. ADMIN — wildcard. Identity сотрудника всегда из сессии,
  `employeeId` в body/query запрещён. Закрытые рабочие разделы:
  `/api/qc/*` и `/api/defect-types` — `QC`/`SHOP_MANAGER`;
  `/api/packing/boxes/*` (кроме публичных `/qr` и `/label`) —
  `PACKING`/`SHOP_MANAGER`; write по `/api/orders/*` — `SHOP_MANAGER`,
  read (`GET /api/orders[/:id][/passports]`) дополнительно открыт
  `CUTTER_ASSISTANT` для запуска «Выпустить паспорт» с `/work` через
  упрощённый server-route `/work/cut-orders` (один заказ — авто-редирект
  на `/orders/[id]/passports/new`, несколько — короткий список карточек,
  ноль — empty state; верхний тёмный header у `CUTTER_ASSISTANT` на
  `/work*` и на странице выпуска паспорта скрыт, см. `docs/screens.md §3.7`).
  Помимо «Выпустить паспорт», у `CUTTER_ASSISTANT` на `/work` есть
  второе крупное действие — «Разместить крой на стеллаж» (scan-driven
  session: scan QR ячейки → confirm-модалка → серия скан-паспортов в
  подтверждённую ячейку, см. `docs/flows.md §F3b` и
  `docs/screens.md §3.8`). Перед обоими действиями `CUTTER_ASSISTANT`
  обязательно стартует смену через QR-код раскройного стола
  (тот же `<SeamstressShiftStart>`, что и у швеи): без активной
  `ShiftSession` печать падает в `SHIFT_SESSION_REQUIRED`
  (`apps/api/src/modules/printers/print-jobs.service.ts:resolvePrinter`),
  а значит «Выпустить паспорт» физически не доходит до отпечатанного QR.
  Поэтому модель «работа = смена → оборудование → операция → действия»
  у помощника теперь такая же, как у других рабочих ролей.
  Backend остаётся источником истины:
  `POST /api/cells/by-code` резолвит ячейку с проверкой `active`,
  размещение делает уже существующий `POST /api/passports/:id/place`.
  Тайл «Заказы» на главной странице у этой роли скрыт (используется
  та же матрица `canSeeOrdersMenu`, что и в шапке/`MobileNav`).
  Frontend дублирует логику через `apps/web/lib/rbac.ts` и SSR-layouts
  `/qc`, `/packing`, `/orders` — у не-разрешённых ролей разделы не
  видны ни в шапке/`MobileNav`, ни на главной (см. `docs/domain.md §3.1`,
  `docs/api.md`, `docs/screens.md §3,5,6,7`). Покрыто
  `tests/integration/role-rbac.test.ts` и
  `tests/smoke/frontend-rbac.smoke.test.ts`.
- **UI auth.** `/login` (login + password), `middleware.ts` Next.js
  редиректит неавторизованных на `/login?next=<url>`, в шапке — ФИО +
  роль + кнопка «Выйти».
- **DB-инварианты** (см. `docs/domain.md §13`):
  - partial unique index `shift_session_active_employee_uniq` на
    `ShiftSession(employeeId) WHERE endedAt IS NULL` — на сотрудника
    не более одной активной смены (создаётся идемпотентно при старте
    API);
  - `BoxItem.passportId` — глобально-уникальный (паспорт не может
    быть в двух коробках);
  - `OrderItem(orderId, productId, sizeId)` — одна строка на размер;
  - все номера и QR (`Order.number`, `Passport.number/qrCode`,
    `Box.number/qrCode`, `Equipment.code/qrCode`, `Cell.code/qrCode`)
    глобально-уникальны.
- **Health/Ready.** `GET /api/health` (без БД) и `GET /api/ready`
  (`SELECT 1`) — публичные, без секретов в ответе.
- **Нормализация ошибок.** `GlobalExceptionFilter` нормализует ответы
  API: всегда `{ statusCode, message, code }`, никаких stack trace
  наружу.   Prisma-ошибки маппятся в коды (`P2002 → UNIQUE_VIOLATION`,
  `P2003 → FOREIGN_KEY_VIOLATION`, `P2025 → NOT_FOUND`).
- **Конфигурация.** `.env.example` обновлён (`JWT_SECRET`,
  `JWT_EXPIRES_IN`, `CORS_ALLOWED_ORIGINS`, `TEST_DATABASE_URL`).
  CORS-список собирается из `APP_URL` / `NEXT_PUBLIC_APP_URL` /
  `CORS_ALLOWED_ORIGINS` с `credentials: true`.
- **Smoke / integration тесты** (`tests/`):
  - `npm test` — прогон всего набора;
  - `npm run test:smoke` — auth + health;
  - `npm run test:integration` — полный производственный поток
    (orders → passports → shifts → qc → packing → earnings) и
    проверка DB-инвариантов через `prisma.*.create`.
  - Без `TEST_DATABASE_URL` тесты автоматически skip-аются — `npm
    test` на чистой машине проходит без падений.

### Локальный sanity-чек MVP 1.1

```bash
cp .env.example .env
# при желании раскомментировать TEST_DATABASE_URL
npm install
npm run prisma:migrate
npm run db:seed
npm run dev:api
npm run dev:web
# Открыть http://localhost:3000 → автоматический редирект на /login.
# Войти: shop-chief / Demo12345!  → должны увидеть /shopfloor и шапку с ФИО.
```

Чтобы прогнать тесты:

```bash
createdb sewing_test
TEST_DATABASE_URL="postgresql://sewing:sewing@localhost:5432/sewing_test?schema=public" \
  npm test
```

---

## Шаг 12 — Pilot Rollout / UAT / Bugfix Sprint

Этап подготовки к реальному запуску в цехе. **Не вводит новых модулей**
и не трогает архитектуру — только safety, наблюдаемость, UX-полировка
и операционная документация.

- **Документация пилота** — каталог [`docs/pilot/`](./docs/pilot):
  - [`rollout-plan.md`](./docs/pilot/rollout-plan.md) — цели,
    длительность, состав, критерии успеха, Go/No-go;
  - [`onboarding.md`](./docs/pilot/onboarding.md) — простые
    пошаговые инструкции для каждой роли;
  - [`operator-checklist.md`](./docs/pilot/operator-checklist.md) —
    чек-листы рабочих действий;
  - [`faq.md`](./docs/pilot/faq.md) — типовые проблемы и ответы;
  - [`feedback.md`](./docs/pilot/feedback.md) — шаблон сбора
    фидбека.
- **UAT flow** — единый сквозной сценарий, описанный в
  [`docs/flows.md §F11a`](./docs/flows.md#f11a-uat-flow--сквозной-пилотный-сценарий-шаг-12)
  и покрытый интеграционным тестом
  `tests/integration/pilot-flow.test.ts` (double-scan stress, rapid
  issue+scan, pack after defect).
- **Error tagging.** Каждый ответ API теперь содержит
  `requestId` (uuid). Тот же `requestId` пишется в логи
  `GlobalExceptionFilter` и проброшен в красную плашку ошибки на
  `/work` — сотрудник называет его поддержке. См. раздел
  «Ошибки и коды (общие соглашения)» в
  [`docs/api.md`](./docs/api.md).
- **Структурированные логи** в ключевых действиях: `auth.login`,
  `passport.create`, `passport.issue`, `passport.scan`, `qc.defect`,
  `packing.add` — формат `{ event, actorId, requestId, ... }`.
- **Quick fixes / Safety guards** — усиление инвариантов,
  существовавших со Шагов 6–8: двойной скан = no-op (ADR-0003),
  повторная упаковка → `409 PASSPORT_ALREADY_PACKED`,
  работа без активной смены → `409 SHIFT_SESSION_REQUIRED`,
  `qty` дефекта не может уйти ниже нуля
  (`DEFECT_EXCEEDS_REMAINING`), `Passport.qtyCut` ограничен
  остатком плана по размеру (ADR-0006).
- **UX-полировка `/work`** — крупные кнопки, autoFocus и быстрый
  reset поля кода паспорта, единая русская формулировка ошибок,
  loading-состояния. См. `docs/screens.md §11` (общие UI-правила).
- **Tactile/audio feedback швеи на `/work`** — короткая вибрация
  (`navigator.vibrate(40)`) ровно в момент успешного распознавания
  QR паспорта и короткий звук `/sounds/cut-accepted.wav` (~180 мс)
  ровно после backend SUCCESS на «Принять». Реализация —
  `apps/web/app/work/feedback.ts`, оба сигнала best-effort: не
  зовутся при ошибках/cancel/lookup и не ломают UI, если устройство
  не поддерживает Vibration/Audio. См. `docs/screens.md §3.6`.
- **Monitoring light.** Новый эндпоинт
  `GET /api/admin/overview` (роли `SHOP_MANAGER`/`ADMIN`) —
  активные смены, открытые коробки, паспорта в работе и в ячейках,
  события за последние 24 часа. На вебе — простая страница
  `/admin/overview` (без поллинга, кнопка Refresh).
- **Тесты пилота.** В `tests/integration/pilot-flow.test.ts`
  добавлены три сценария: «double-scan stress», «rapid issue+scan»
  (несколько паспортов сразу) и «pack after defect» (паспорт с
  зафиксированным браком корректно дорабатывается, упаковывается
  только `qtyGood`).

### Как провести пилот

1. Раздать оператору каждой роли соответствующую страницу
   `docs/pilot/onboarding.md` и `operator-checklist.md`.
2. Прогнать UAT flow руками (см. `docs/flows.md §F11a`) — всем
   составом, в реальный рабочий день.
3. Каждый инцидент фиксировать по шаблону
   `docs/pilot/feedback.md` (с обязательным `requestId`).
4. Начальник цеха проверяет состояние через `/admin/overview`.
5. По итогам недели — ретроспектива и решение Go/No-go (см.
   `docs/pilot/rollout-plan.md §5`).

---

## Шаг 13 — Mobile clean redesign (UX для цеха)

Этап чисто фронтовый: бэк, API, миграции и auth-flow не меняются.
Цель — сделать интерфейс понятным и лёгким на телефоне для трёх
ключевых ролей: **швея**, **ВТО**, **помощник закройщика**.

- **Дизайн-токены** — `apps/web/app/globals.css`. Белый фон, светлые
  карточки, мягкие синие акценты, крупные радиусы и тени, тач-цели
  ≥ 44 px (на /work — ≥ 56 px).
- **Layout** — `apps/web/app/layout.tsx`. Тёмно-синий хедер
  оставлен как фирменный элемент; на мобильном экране верхняя
  навигация скрыта, появляется фиксированная нижняя `MobileNav`.
  Состав пунктов зависит от роли (модель «одно рабочее окно на
  роль», см. ниже и `docs/screens.md §1.1`): менеджеру/админу —
  Главная / Работа / ОТК / Упаковка / Заказы (по матрице доступа),
  ОТК и упаковщику — только их раздел, а у швеи и помощника
  раскройщика `MobileNav` не рендерится вообще — экран остаётся
  одним сфокусированным терминалом.
- **`/login`** — компактная центрированная карточка, мягкие
  inputs и крупная primary-кнопка вместо служебной формы.
- **`/work`** — главный мобильный экран. Сверху —
  фирменный `RoleHeaderCard` (имя, роль, активная операция и
  оборудование, статус смены). Дальше — либо «Начать смену» (мягкая
  scan-card с двумя селектами), либо переключатель «Получить крой /
  Сканировать паспорт» с крупным input-блоком, primary-кнопкой и
  чистой success/error-карточкой результата.
- **`/passports/[id]`** — переработана в mobile card layout: hero с
  QR и ключевыми полями, отдельные мягкие секции «Качество», 
  «Упаковка», «Начисления», «Размещение». Десктоп-таблица заменена
  карточками + аккуратной таблицей начислений с горизонтальной 
  прокруткой.
- **Главная (`/`)** — для менеджеров/админа превратилась в плитку
  крупных action-карточек по ролям; для гостя — короткий CTA
  «Войти». Для производственных ролей `/` теперь делает
  server-side редирект в их primary workspace
  (`apps/web/lib/rbac.ts:getPrimaryWorkspace`,
  `apps/web/app/page.tsx`), а login без явного `?next=` ведёт туда
  же. Это часть модели «одно рабочее окно на роль»: швея и
  помощник раскройщика после логина сразу попадают в `/work`,
  ОТК — в `/qc`, упаковка — в `/packing`. Подробности —
  [`docs/screens.md §1.1`](./docs/screens.md#role-window-model).
- **Reusable-компоненты** — `apps/web/components`:
  `mobile-action-card.tsx`, `role-header-card.tsx`, 
  `app-section-card.tsx`, `status-pill.tsx`, `mobile-nav.tsx`.
- Подробное описание UX-принципов и поведения экранов — в
  [`docs/ui-mobile.md`](./docs/ui-mobile.md), карта экранов
  (`docs/screens.md`) обновлена под новый вид.

Что **не** делаем на этом шаге: backend, API, Prisma, auth, новые
бизнес-потоки, тяжёлые UI-библиотеки. Всё остаётся в чистом
React/Next.js + CSS-tokens.

---

## Шаг 14 — Equipment Configuration (allowed operations)

Минимальная доработка после Шага 13: вынос «какие операции доступны
на каком станке» из фронтового хардкода по префиксу `Equipment.code`
в нормальную доменную модель. Источник истины — backend/БД, см.
[ADR-0017](./docs/adr/0017-equipment-allowed-operations.md).

- **Prisma / DB.** Новая M2M-таблица `EquipmentOperation`
  (`equipmentId`, `operationId`, `sortOrder`, `isActive`,
  `createdAt`, `updatedAt`) с уникальным индексом
  `(equipmentId, operationId)` и FK `ON DELETE CASCADE`.
  Миграция: `prisma/migrations/20260418115500_equipment_operations`.
- **Seed.** `prisma/seed.ts` идемпотентно создаёт стартовый набор
  связей (`overlock-* → SEW_OVERLOCK_1, SEW_OVERLOCK_2`,
  `coverstitch-* → SEW_COVERSTITCH`, `binding-* → SEW_BINDING`,
  станции ОТК / ВТО / упаковки → одноимённые операции). Вручную
  добавленные связи seed не удаляет.
- **Backend API.** Новый модуль
  `apps/api/src/modules/equipment`:
  - `GET /api/equipment` — список с `allowedOperationsCount`;
  - `GET /api/equipment/:id` — карточка с `allowedOperations[]`
    (упорядочено по `sortOrder`);
  - `PATCH /api/equipment/:id/operations` — полная замена набора;
    sortOrder выставляется по позиции в массиве `operationIds`.
  - Все три — `ADMIN` / `SHOP_MANAGER`.
  - `GET /api/shifts/meta` теперь у каждой единицы оборудования
    возвращает `allowedOperationIds` (отфильтровано по
    `EquipmentOperation.isActive` и `Operation.active`).
- **Frontend `/work`.** `apps/web/lib/equipment-operations.ts` больше
  не содержит карты префиксов — `operationsForEquipment()` берёт
  список из `equipment.allowedOperationIds`. Если у станка нет ни
  одной разрешённой операции — форма «Начать смену» показывает
  явный empty-state со ссылкой на админку, а не пустой селект.
- **Admin UI.** Новые экраны `/admin/equipment` (список) и
  `/admin/equipment/[id]` (карточка с чеклистом операций и Server
  Action для PATCH-а). Доступ ограничен `apps/web/app/admin/layout.tsx`
  (`canSeeAdmin` → `ADMIN` / `SHOP_MANAGER`). После сохранения
  ревалидируется `/work` — швеи увидят новый allow-лист на ближайшем
  открытии формы смены.
- **Tests.** `tests/integration/equipment-operations.test.ts` —
  seed-связи, GET list / detail (включая порядок и фильтрацию
  неактивных), PATCH (добавление/удаление/переупорядочивание,
  ошибки на дубликаты и несуществующие операции), проброс в
  `/api/shifts/meta`, RBAC на оба эндпоинта, зелёный путь старта
  смены через backend-driven операции.

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name equipment_operations
npm run db:seed
```

Что **не** делаем на этом шаге: server-side enforcement allow-листа
в `POST /api/shifts/start` (фронт уже отдаёт только разрешённые,
жёсткая проверка вынесена за рамки MVP equipment-config), CRUD
самих `Equipment` (создание/деактивация — отдельная админ-история),
большой ERP-модуль оборудования.

---

## Шаг 15 — Equipment displayNumber + печатная QR-этикетка

Маленькая, но важная для цеха доработка: у каждого `Equipment`
появляется ручной отображаемый номер (`displayNumber`, nullable
`String`), а из админки можно распечатать наклейку с QR-кодом и
этим номером — крупно, чтобы швея/начальник смены различали два
соседних оверлока с расстояния.

- **Prisma / DB.** В `Equipment` добавлено поле `displayNumber
  String?` — без `@unique` (один и тот же «№1» допустим у оверлока и
  у распошива). Миграция:
  `prisma/migrations/20260418130000_equipment_display_number`.
- **Seed.** `prisma/seed.ts` проставляет дефолтные `displayNumber`
  («1», «2», …) идемпотентно — пустой/`null` обновляет до seed-
  значения, вручную изменённое значение **не трогает**.
- **Backend API** (модуль `apps/api/src/modules/equipment`):
  - `displayNumber` добавлен в `EquipmentSummaryDto` /
    `EquipmentDetailDto`;
  - `PATCH /api/equipment/:id` — обновление `displayNumber`
    (Zod: trim, пустая строка → `null`, max 16 символов). Роли —
    `ADMIN` / `SHOP_MANAGER`.
  - `GET /api/equipment/:id/print` — `@Public()` HTML-этикетка под
    `@page A6` для термопринтера: крупный `№displayNumber`, QR
    `equipment:{id}` (формат ADR-0008 не меняется), название и
    технический код. Та же модель доступа, что у
    `/api/passports/:id/print` и `/api/packing/boxes/:id/label` —
    принтер-станция работает без сессии.
  - `GET /api/equipment/:id/qr` — `@Public()` PNG QR-кода (на
    случай встраивания в другие шаблоны).
- **Admin UI.**
  - `/admin/equipment` — новая колонка «№» (`displayNumber` или «—»).
  - `/admin/equipment/[id]` — `displayNumber` крупно в шапке, новая
    форма «Номер станка» с Server Action `updateEquipmentDisplayNumberAction`,
    кнопка «Печать QR» (открывает `/api/equipment/:id/print` в
    новой вкладке).
- **Tests.** Расширен `tests/integration/equipment-operations.test.ts`:
  seed `displayNumber`, наличие в list/detail, PATCH (успех, trim,
  пустая строка → `null`, валидация длины, 404), RBAC (`SEAMSTRESS`
  → 403, `ADMIN` → 200), HTML print (`@Public()`, есть
  `displayNumber`/QR/код, корректный fallback при `null`), QR PNG.

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name equipment_display_number
npm run db:seed
```

Что **не** делаем на этом шаге: глобальную уникальность номера,
авто-генерацию следующего номера, PDF-этикетку (только HTML — см.
ADR-0010), массовый bulk-edit. CRUD самих `Equipment` (создание /
деактивация) по-прежнему за рамками.

---

## Шаг 16 — Закрытие раскроя по размеру через заявку

Управленческая цепочка для типичного цехового кейса «накроили меньше
плана и больше не будут». Архитектурное решение —
[ADR-0018](./docs/adr/0018-cutting-closure-request.md), доменная
модель — [`docs/domain.md §15`](./docs/domain.md), API —
[`docs/api.md §14`](./docs/api.md).

- **Prisma / DB.** Новая модель `CuttingClosureRequest`
  (`orderId`, `productId`, `sizeId`, `status`, `reason?`,
  `requestedByEmployeeId`, `requestedAt`, `reviewedByEmployeeId?`,
  `reviewedAt?`, `reviewerNote?`) и enum
  `CuttingClosureRequestStatus = REQUESTED | APPROVED | REJECTED`.
  Миграция: `prisma/migrations/20260418200000_cutting_closure_requests`.
  Партиал-уникальные индексы
  `cutting_closure_request_active_uniq` (для `REQUESTED`) и
  `cutting_closure_request_approved_uniq` (для `APPROVED`)
  применяются миграцией и идемпотентно — `PrismaService.onModuleInit`
  (см. [ADR-0015](./docs/adr/0015-db-invariants.md)).
- **Backend API.** Новый модуль
  `apps/api/src/modules/cutting-closure`:
  - `POST /api/cutting-close-requests` — `CUTTER_ASSISTANT`,
    `SHOP_MANAGER`, `ADMIN`;
  - `GET /api/cutting-close-requests[?status&orderId&productId&sizeId]`
    — те же роли;
  - `GET /api/cutting-close-requests/:id` — те же роли;
  - `POST /api/cutting-close-requests/:id/approve` — `SHOP_MANAGER`,
    `ADMIN`;
  - `POST /api/cutting-close-requests/:id/reject` — `SHOP_MANAGER`,
    `ADMIN`;
  - `GET /api/passports/:id/cutting-closure-request` — «текущая»
    заявка по строке паспорта (или `null`).
- **Backend enforcement.** `PassportsService.create` после стандартных
  проверок зовёт `CuttingClosureService.hasApprovedClosure(...)`. Если
  по строке есть `APPROVED` — возвращает `409 CUTTING_CLOSED`. Это
  единственный новый failure-mode выпуска паспорта; существующие
  тесты `production-flow` / `pilot-flow` не сломаны.
- **UI.**
  - `/passports/[id]` — блок «Закрытие раскроя»
    (`apps/web/app/passports/[id]/cutting-closure-section.tsx`):
    план/факт/остаток, статус-badge, метаданные, кнопка «Подать
    заявку» для `CUTTER_ASSISTANT`, кнопки «Подтвердить / Отклонить»
    для `SHOP_MANAGER` / `ADMIN`. Server actions —
    `cutting-closure-actions.ts`, API-обёртка —
    `apps/web/lib/cutting-closure-api.ts`.
  - `/orders/[id]/passports/new` — inline-чекбокс «Подать заявку на
    закрытие раскроя» прямо в форме выпуска паспорта (только для
    `CUTTER_ASSISTANT`). Server action `createPassportAction` после
    успешного `POST /api/passports` сразу зовёт
    `POST /api/cutting-close-requests` по той же строке. Если заявка
    падает — паспорт остаётся, UI показывает mixed-result со ссылкой
    на карточку паспорта (см. `docs/screens.md §7.5`,
    `docs/api.md §14`).
  - `/orders/[id]` — баннер «Закрытие раскроя по размерам» с
    активными `REQUESTED` и уже подтверждёнными заявками + быстрые
    ссылки на паспорта.
- **Tests.** `tests/integration/cutting-closure.test.ts` — 10
  сценариев: подача и дубликат `REQUESTED` (partial unique index),
  approve/reject, повтор approve, RBAC (`SEAMSTRESS`/`QC`/`PACKING`/
  `CUTTER`/`CUTTER_ASSISTANT` не могут approve/reject), backend режет
  выпуск паспорта `409 CUTTING_CLOSED`, `REJECTED` снова разрешает
  заявку, подресурс `/passports/:id/cutting-closure-request`,
  `planFact` совпадает с агрегатом по живым паспортам, плюс
  combined-flow «помощник создаёт паспорт и сразу подаёт заявку из
  той же формы» (happy path и mixed-result, когда заявка падает, а
  паспорт остаётся). Все 87 интеграционных тестов зелёные.
- **Новые коды ошибок** (`docs/api.md §13`):
  `CUTTING_CLOSURE_SIZE_NOT_IN_ORDER`,
  `CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION`,
  `CUTTING_CLOSURE_ALREADY_REQUESTED`,
  `CUTTING_CLOSURE_ALREADY_APPROVED`,
  `CUTTING_CLOSURE_REQUEST_NOT_FOUND`,
  `CUTTING_CLOSURE_REQUEST_NOT_PENDING`,
  `CUTTING_CLOSED` (на стороне выпуска паспорта).

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name cutting_closure_requests
```

Что **не** делаем на этом шаге: авто-перевод заказа в `DONE` при
`APPROVED` по всем строкам, уведомления, общий audit-лог, «снять»
APPROVED через API (только через миграцию данных, см. ADR-0018 §5).

---

## Шаг 17 — Склады (управленческая группировка ячеек)

Новая управленческая сущность «Склад» поверх уже работающего модуля
ячеек. Архитектурное решение —
[ADR-0019](./docs/adr/0019-warehouses.md), доменная модель —
[`docs/domain.md §16`](./docs/domain.md), API —
[`docs/api.md §15`](./docs/api.md), экран —
[`docs/screens.md §10b`](./docs/screens.md).

- **Prisma / DB.** Новая модель `Warehouse(id, name UNIQUE,
  code UNIQUE NULL, isActive, createdAt, updatedAt)`. На `Cell`
  добавлено nullable `warehouseId` с FK `ON DELETE SET NULL`.
  Миграция: `prisma/migrations/20260418210000_warehouses`.
  Сознательно nullable — существующие ячейки и ячейки, под которые
  ещё нет описанного склада, остаются без `warehouseId`. Это
  сохраняет flow «scan cell → place passport» 1:1
  (`POST /api/cells/by-code` и `POST /api/passports/:id/place`
  не требуют `warehouseId`).
- **Backend API.** Новый модуль
  `apps/api/src/modules/warehouses` (CRUD + бизнес-ошибки):
  - `GET /api/warehouses` — список с `cellsCount`;
  - `GET /api/warehouses/:id` — карточка с `cells[]` и готовыми
    `printUrl`;
  - `POST /api/warehouses` / `PATCH /api/warehouses/:id` —
    создание / точечное обновление;
  - `PATCH /api/cells/:id` — узкое тело `{ warehouseId: string |
    null }` для привязки/отвязки/перепривязки ячейки к складу.
  - Все четыре — `ADMIN` / `SHOP_MANAGER`.
  - Печать QR ячейки переиспользует модель ADR-0010:
    `GET /api/cells/:id/print` (HTML A6) и `GET /api/cells/:id/qr`
    (PNG) — `@Public()`, payload `cell:{id}` (ADR-0008) **не
    меняется**, уже напечатанные стикеры остаются валидными.
- **Shared DTOs.** Контракты в `packages/shared/src/warehouses.ts`:
  `CreateWarehouseSchema`, `UpdateWarehouseSchema`, `UpdateCellSchema`
  и DTO ответов (`WarehouseSummaryDto`, `WarehouseDetailDto`,
  `WarehouseLiteDto`, `WarehouseCellDto`). `CellDetailDto` (Шаг 5)
  расширен полем `warehouse: { id, name, code } | null`.
- **Web UI.**
  - `/admin/warehouses` — чистый список складов с primary-кнопкой
    «Добавить склад» в шапке (ведёт на `/admin/warehouses/new`).
    Раньше форма создания жила прямо в списке и его перегружала —
    теперь она вынесена на отдельную страницу, по тому же UX, что
    `/admin/equipment/new` (ADR-0017) и `/admin/operations/new`
    (ADR-0020).
  - `/admin/warehouses/new` — отдельный экран создания склада с
    `DetailPageHeader` и back-link'ом «К списку складов»; на успехе
    редиректит на карточку нового склада.
  - `/admin/warehouses/[id]` — реквизиты склада, таблица ячеек с
    кнопкой «Печать QR» и «Отвязать», блок «Привязать ячейку»
    (select из активных ячеек с пометкой «переедет из «<имя другого
    склада>»», если ячейка уже привязана).
  - В админ-нав-баре появился пункт **Склад**, на главной (`/`) —
    тайл «Склад» только для `ADMIN`/`SHOP_MANAGER`. Защита
    раздела — существующий `app/admin/layout.tsx` через
    `canSeeAdmin`. Backend перепроверяет `@Roles` независимо.
- **Tests.** `tests/integration/warehouses.test.ts` — 29 сценариев:
  CRUD (включая пустой `code` → `null`, обнуление через `code: null`),
  уникальность `name`/`code` (`WAREHOUSE_NAME_TAKEN` /
  `WAREHOUSE_CODE_TAKEN`), привязка/перепривязка/отвязка ячеек,
  «существующий flow Cell остаётся рабочим» (явно проверяется, что
  `GET /api/cells` и `POST /api/cells/by-code` продолжают
  отдавать ячейки без склада с `warehouse: null`), QR/print
  (`@Public()`, HTML с QR data URL, payload `cell:{id}`, имя склада
  на этикетке), полный RBAC-набор (`SEAMSTRESS`/`QC`/`CUTTER`/
  `PACKING` — 403, `ADMIN`/`SHOP_MANAGER` — 200), и проверка
  `ON DELETE SET NULL` (физическое удаление склада через Prisma
  не уничтожает ячейки, только обнуляет ссылку).
- **Новые коды ошибок** (`docs/api.md §13`):
  `WAREHOUSE_NOT_FOUND` (404), `WAREHOUSE_NAME_TAKEN` (409),
  `WAREHOUSE_CODE_TAKEN` (409). `CELL_NOT_FOUND` теперь срабатывает
  и на `PATCH /api/cells/:id`.

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name warehouses
```

Что **не** делаем на этом шаге: зоны / секции / полки внутри склада,
capacity / план «сколько паспортов помещается», audit-лог перемещений
ячеек между складами, API на удаление склада (менеджер выключает
`isActive`; если склад всё-таки удалить через БД — `ON DELETE SET
NULL` сохранит ячейки, см. ADR-0019). Сам QR-payload ячейки и flow
размещения паспорта в ячейку **не меняются**.

---

## Шаг 18 — Управленческий блок «Операции» и единый тариф

Минимальная управленческая доработка после Шага 17: вынос
сдельного тарифа из таблицы `PieceRate` в нормальную модель
`Operation` + `OperationRateBySize` с тремя явными режимами
(`FIXED` / `BY_SIZE` / `SALARY_ONLY`). Архитектурное решение —
[ADR-0020](./docs/adr/0020-operation-pricing-model.md), доменная
модель — [`docs/domain.md §4` / §4a](./docs/domain.md), API —
[`docs/api.md §15a`](./docs/api.md), экран —
[`docs/screens.md §10c`](./docs/screens.md).

- **Prisma / DB.** Новый enum `PricingMode = FIXED | BY_SIZE |
  SALARY_ONLY`. На `Operation` добавлены `pricingMode` (default
  `SALARY_ONLY`), `fixedRate Decimal(12,2)?` и `updatedAt`. Новая
  таблица `OperationRateBySize(operationId, sizeId, rate, ...)` с
  `UNIQUE (operationId, sizeId)` и `ON DELETE CASCADE` от
  `Operation`. Миграция:
  `prisma/migrations/20260420100000_operation_pricing_model`. Она
  бэкфилит существующие данные из `PieceRate`: операции с одной
  ставкой получают `FIXED`+`fixedRate`, операции с разными
  ставками по размерам — `BY_SIZE`+ заполненный
  `OperationRateBySize`, остальные остаются `SALARY_ONLY`. Сама
  `PieceRate` таблица была сохранена для аудита/rollback, но
  runtime её не читал; в PHASE 2 STEP 1 таблица физически удалена
  миграцией `20260532100000_drop_legacy_salary_base_and_piece_rate`
  (см. ADR-0020 §«PHASE 2 — drop legacy»).
- **Backend API.** Новый модуль
  `apps/api/src/modules/operations`:
  - `GET /api/operations` — список с `pricingMode`, `fixedRate`,
    `ratesBySizeCount`;
  - `GET /api/operations/:id` — карточка с `ratesBySize[]`;
  - `POST /api/operations` — создать (Zod-валидация
    `pricingMode`-специфичных правил);
  - `PATCH /api/operations/:id` — точечно
    `name`/`category`/`isActive`/`pricingMode`/`fixedRate`/`ratesBySize`,
    смена режима транзакционно чистит несовместимые поля.
  - Все четыре — `ADMIN` / `SHOP_MANAGER`. `code` сознательно
    нередактируем (это идентичность), удаления нет (выключают
    `isActive`).
- **Единый helper `OperationsService.resolveRate(operationId, sizeId,
  tx?)`** — единственный источник истины для earnings:
  - `FIXED` → `Operation.fixedRate`;
  - `BY_SIZE` → `OperationRateBySize.rate` для `sizeId`; нет ставки
    → `OPERATION_RATE_MISSING` (422);
  - `SALARY_ONLY` → `null` (silent skip, `OperationEntry` не
    создаётся).
- **`EarningsService` использует `resolveRate`.** Раскрой
  (`createImmediateForCutter`, `PASSPORT_CREATED`) и пошив
  (`createPendingForPreviousOperation`, `OPERATION_TRANSITION`)
  оба зовут именно его. Старая `findRate` поверх таблицы
  `PieceRate` и константа `PIECEWORK_OPERATION_CODES` /
  `isPieceworkOperationCode` удалены из runtime — «оплатная ли
  операция» теперь = `op.pricingMode ≠ SALARY_ONLY` (см. ADR-0020 §4).
  Сама таблица `PieceRate` снесена в PHASE 2 STEP 1.
- **Shared DTOs.** Контракты в `packages/shared/src/operations.ts`:
  `PRICING_MODES`, `OPERATION_CATEGORIES`, `CreateOperationSchema`,
  `UpdateOperationSchema`, `OperationDetailDto`,
  `OperationSummaryDto`, `OperationRateBySizeDto`.
- **Web UI.**
  - `/admin/operations` — список без встроенной формы создания.
    В правом краю шапки — primary-кнопка «Добавить операцию»,
    ведущая на отдельную страницу `/admin/operations/new`. На
    пустом стейте — inline-ссылка «Создайте первую операцию» туда
    же. *(History note.* Изначально форма создания жила прямо на
    списке — при росте числа операций она перегружала страницу;
    пост-Equipment CRUD вынесли её на отдельный экран по аналогии
    с `/admin/equipment/new`, backend `POST /api/operations` и
    server action `createOperationAction` не менялись.)
  - `/admin/operations/new` — отдельная страница создания операции:
    `DetailPageHeader` с back-link'ом «← К списку операций» и одна
    карточка «Параметры операции» с переиспользуемой формой
    `CreateOperationForm` (поля «Код», «Название», «Категория»,
    «Тип тарифа»; для `FIXED` — поле «Ставка за единицу», для
    `BY_SIZE` / `SALARY_ONLY` — info-плашка вместо лишних полей).
    После успешного создания action редиректит на карточку
    операции (`/admin/operations/[id]`) — поведение и валидация
    идентичны прежней встроенной форме.
  - `/admin/operations/[id]` — адаптивная карточка под `pricingMode`.
    Для `FIXED` — одно числовое поле, для `BY_SIZE` — таблица
    «размер ↔ ставка» с кнопкой «Заполнить всем одну ставку» и
    «Опасной зоной» «Очистить все ставки», для `SALARY_ONLY` —
    явный блок «Сдельная ставка не используется».
  - В админ-нав-баре пункт **Операции**, на главной (`/`) — тайл
    «Операции» только для `ADMIN`/`SHOP_MANAGER`.
- **Seed.** `prisma/seed.ts` обновлён: `OPERATIONS[]` несёт
  `pricingMode`/`fixedRate`, старый `seedPieceRates()` заменён на
  `seedOperationRatesBySize()` для `BY_SIZE`-операций. Таблицы
  `PieceRate` больше не существует (PHASE 2 STEP 1).
  `tests/utils/seed.ts` синхронизован (`CUT_CUT = FIXED`/
  `fixedRate=10`, `SEW_OVERLOCK_*` = `BY_SIZE`).
- **Tests.** `tests/integration/operations.test.ts` — 20 сценариев:
  CRUD под все три `pricingMode`, валидации
  (`FIXED` без `fixedRate`, `SALARY_ONLY` с `fixedRate` — оба `400
  VALIDATION_ERROR`), уникальность `code`
  (`OPERATION_CODE_TAKEN`), уникальность `(operationId, sizeId)`
  (`OPERATION_RATE_DUPLICATE_SIZE`), несуществующий `sizeId`
  (`OPERATION_RATE_SIZE_NOT_FOUND`), смена режима (`FIXED → BY_SIZE`,
  `BY_SIZE → SALARY_ONLY` чистит ставки), пустой `ratesBySize=[]`
  стирает все ставки, RBAC (`SEAMSTRESS`/`CUTTER`/`QC`/`PACKING`
  → 403; `ADMIN`/`SHOP_MANAGER` → 200/201) и три сценария
  earnings-интеграции (FIXED, SALARY_ONLY, BY_SIZE — `EarningsService`
  ходит через `resolveRate`). Все 249 интеграционных/smoke-тестов в
  репозитории зелёные — pipeline не сломан.
- **Новые коды ошибок** (`docs/api.md §13`):
  `OPERATION_CODE_TAKEN` (409), `OPERATION_RATE_SIZE_NOT_FOUND`
  (400), `OPERATION_RATE_DUPLICATE_SIZE` (400),
  `OPERATION_RATE_MISSING` (422 — заменяет
  `PIECE_RATE_NOT_FOUND` в runtime).

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name operation_pricing_model
npm run db:seed
```

Что **не** делаем на этом шаге: историю ставок по датам
(`validFrom/validTo`), ставки по `productId`/сотруднику/складу,
soft-delete операций (`Operation.code` остаётся стабильным
идентификатором, удаление через API не предусмотрено), авто-перевод
в `SALARY_ONLY` при пустом `OperationRateBySize` (это всегда явное
действие менеджера). Сам QR/print/`OperationEntry`-схема **не
меняются**.

---

## Шаг 19 — Дневной оклад от факта смены (post-Шаг 18)

Управленческая модель оклада «была смена в день → платим ставку за
день» как параллельный контур к сдельщине. Архитектурное решение —
[ADR-0021](./docs/adr/0021-shift-day-salary.md), описание домена —
[`docs/domain.md §9a`](./docs/domain.md), API —
[`docs/api.md §10a` и §3b](./docs/api.md), UI —
[`docs/screens.md §10d` и §12.3](./docs/screens.md).

**Что появилось:**

- **Новые поля `Employee`.** `compensationType`
  (`PIECEWORK` / `SALARY` / `MIXED`, default `PIECEWORK`) и
  `salaryPerShift Decimal(12,2)?`. Историческое `paymentType`
  удалено пост-задачей «remove paymentType» (миграция
  `20260429100000_remove_payment_type`); теперь `compensationType`
  одновременно гейтит и сдельный контур (`OperationEntry`), и
  окладной (`SalaryEntry`) — единственный источник истины «как
  платим» (см. ADR-0021 §2.1, обновлённую под удаление).
- **Новая таблица `SalaryEntry`.** Поля `employeeId`, `date` (Postgres
  `DATE`), `amount Decimal(12,2)`, `source` (`SHIFT_DAY` / `MANUAL`,
  на MVP пишем только `SHIFT_DAY`), `editedManually`,
  `managerComment`, `editedByEmployeeId`. Уникальный
  `(employeeId, date, source)` гарантирует «один день — одна
  окладная запись на сотрудника» (см. `domain.md §13`).
- **`SalaryService.syncDailySalary(employeeId, date)`** —
  единственный источник создания `SalaryEntry`. Вызывается из
  `ShiftsService.start` и `ShiftsService.stop` через
  fail-soft-обёртку `safeSyncSalary` (ошибка sync-а не ронит
  `start/stop shift`). Уважает `editedManually = true` — ручную
  правку не перезаписывает.
- **API.**
  - `GET /api/salary` / `GET /api/salary/summary` — открыты любой
    авторизованной роли с RBAC-скоупом в сервисе (не-менеджер
    видит только свои строки);
  - `PATCH /api/salary/:id` — `SHOP_MANAGER` / `ADMIN`, ручная
    правка `amount`/`managerComment` или `reset = true`
    (вернуть под автоматику);
  - `GET /api/employees`, `GET /api/employees/:id`, `PATCH
    /api/employees/:id` — целиком `SHOP_MANAGER` / `ADMIN`,
    управление `compensationType`, `salaryPerShift`, `active`.
- **UI.**
  - `/admin/employees` (список + карточка с инлайн-формой
    «Оплата за смену») — менеджерский блок настройки оплаты;
  - блок «Окладные начисления» в `/earnings` — отдельная таблица
    под сдельной частью, с инлайн-кнопками **«Исправить»** и
    **«Вернуть в авто»** (только для менеджера).
- **Seed.** `prisma/seed.ts` ставит `compensationType = SALARY` и
  осмысленный `salaryPerShift` для демо-сотрудников `qc`, `wto`,
  `packer` — фичу можно сразу проверить руками после
  `npm run db:seed`. Все остальные сотрудники остаются `PIECEWORK`
  (default).

**Безопасный backfill.** Миграция выкатывает `compensationType =
PIECEWORK` для всех существующих `Employee`, поэтому никаких
автоматических окладных начислений до явного перевода сотрудника
менеджером не появляется. Сдельный pipeline (выпуск паспорта,
scan, упаковка, earnings) **не меняется**, все 261 интеграционный/
smoke тест зелёные (`tests/integration/salary.test.ts` — 12
сценариев: SALARY/MIXED/PIECEWORK поведение, идемпотентность,
ручная правка, `reset`, RBAC видимости и редактирования).

**Локальный rollout:**

```bash
npm run prisma:migrate -- --name employee_compensation_and_salary_entry
npm run db:seed
```

Что **не** делаем на этом шаге (см. ADR-0021 §3): расчёт часов и
half-day, автозакрытие смены по таймауту, месячный payroll по
календарю/норме часов, отпуска/больничные, удержания за брак для
окладных ролей, экспорт в Excel/1С/ЗУП, история изменений `amount`
(есть только последний `editedBy`). `SalaryEntrySource = MANUAL`
зарезервирован под кейс «оплатить день, в который смены физически
не было», но на MVP не пишется.

---

## Шаг 20 — Себестоимость выпуска (`/production-cost`)

Управленческий read-only модуль «сколько нам стоила смена и где мы
простаивали». Полностью поверх уже работающего журнала
(`OperationEntry`, `SalaryEntry`, `PassportEvent`) — **ни одной новой
таблицы, ни одного нового события**, миграция не нужна. Описание
домена — [`docs/domain.md §17`](./docs/domain.md), API —
[`docs/api.md §17`](./docs/api.md), экран —
[`docs/screens.md §17`](./docs/screens.md).

- **Backend.** Новый модуль `apps/api/src/modules/costs`:
  - `CostsService.getProductionCost({ dateFrom, dateTo })` — сводит
    дневные метрики выпуска (units / piecework / распределённый оклад
    / простой);
  - `PassportDurationsService` — выводит длительность стадий
    `QC` / `WTO` / `PACKING` из `PassportEvent` с cap-ом
    `MAX_STAGE_MINUTES_PER_PASSPORT = 60`. Для PACKING (где на MVP
    нет отдельного `OPERATION_SCAN`, см.
    [`docs/flows.md §F7`](./docs/flows.md)) accept-точка выводится из
    разрыва между двумя соседними `PACKED` того же упаковщика — это и
    есть «время на одну упаковку», существующий упаковочный flow не
    меняется;
  - `GET /api/costs/production?dateFrom&dateTo` — единственный
    эндпойнт, `@Roles('SHOP_MANAGER', 'ADMIN')`. Без query —
    возвращает последние 14 UTC-дней. Дни без событий тоже
    присутствуют в ответе (с нулями), чтобы график на UI не рвался.
- **Стоимость минуты.** `minuteRate = salaryPerShift /
  SHIFT_MINUTES`, где `SHIFT_MINUTES = 480` (см. ADR-0021). Считается
  только для `compensationType ∈ {SALARY, MIXED}` с положительной
  ставкой; `PIECEWORK` минутной стоимости не имеет.
- **Себестоимость одного паспорта** =
  `Σ OperationEntry.amount [APPROVED] + Σ stage.durationMinutes ×
  employee.minuteRate`. Простой **не входит** в `totalCost` изделия
  и идёт отдельной строкой в дневной агрегации.
- **Простой** = `Σ по окладным сотрудникам с SalaryEntry в этот
  день: max(0, SHIFT_MINUTES − tracked(employee, date)) ×
  minuteRate`. Это ровно «мы заплатили за то, что человек присутствовал,
  но ни одной минуты не попало в наш производственный пайплайн».
- **Frontend.** Новая страница `apps/web/app/production-cost/`
  (SSR, `force-dynamic`):
  - layout-guard `canSeeProductionCost` (`apps/web/lib/rbac.ts`)
    редиректит чужие роли на `/`;
  - заголовок + summary-карточки (выпуск, себестоимость, ₽/шт,
    простой);
  - фильтр периода `dateFrom` / `dateTo` через `<input type="date">`
    + GET-submit;
  - SVG-чарт `production-cost-chart.tsx` — три серии (выпуск, ₽
    себестоимость, ₽ простой) без внешних зависимостей;
  - таблица по дням с детальной разбивкой piecework / salary / idle.
- **Навигация.** Пункт **Себестоимость** в шапке
  (`apps/web/app/layout.tsx`) и тайл «Себестоимость» на
  менеджерской главной (`apps/web/app/page.tsx`) — оба видны только
  `SHOP_MANAGER` / `ADMIN`.
- **Tests.**
  - `tests/integration/production-cost.test.ts` — базовая
    агрегация по дням, cap длительности стадии в 60 минут, расчёт
    простоя для окладника, RBAC (`SEAMSTRESS`/`QC` → 403,
    `SHOP_MANAGER`/`ADMIN` → 200), фильтр по датам, агрегация
    нескольких паспортов в одном дне;
  - `tests/smoke/production-cost.smoke.test.ts` — структурные
    инварианты модуля (наличие `SHIFT_MINUTES` /
    `MAX_STAGE_MINUTES_PER_PASSPORT`, валидация
    `ProductionCostQuerySchema`, wiring `CostsModule` в `AppModule`,
    `@Roles` на контроллере, использование `EntryStatus.APPROVED` и
    `PassportEventType.PACKED` в сервисе, PACKING-fallback в
    `PassportDurationsService`, страница `/production-cost` тянет
    `getProductionCost` и рендерит чарт + summary + таблицу).

Что **не** делаем на этом шаге: drill-down (по сотруднику / по
паспорту), помесячный отчёт, экспорт в Excel/1С/ЗУП, графики
сравнения «план vs факт», авто-перезапись `OperationEntry` при
повторных пересчётах. Все действия read-only — ни одного
`POST/PATCH` со страницы не идёт.

---

## Шаг 21 — Дашборд начальника производства (`/admin/production-dashboard`)

Управленческий read-only экран, который собирает в одном месте всё,
что раньше начальник производства собирал руками с
`/shopfloor`, `/production-cost`, `/admin/overview`, `/earnings` и
`/admin/employees`. Никаких новых таблиц/событий — backend
переиспользует уже работающие сервисы (`CostsService`,
`PassportDurationsService`, `shopfloor-projection`); UI ничего не
пересчитывает. Описание домена —
[`docs/domain.md §17a`](./docs/domain.md), API —
[`docs/api.md §11b`](./docs/api.md), экран —
[`docs/screens.md §18`](./docs/screens.md).

- **Backend.** Новый модуль
  `apps/api/src/modules/dashboard`:
  - `DashboardService.getProductionDashboard({ days })` — агрегирует
    KPI / pipeline / ряд графика (`trend`) / нагрузку по ролям
    (`roleLoad`) / алерты в одном ответе;
  - `GET /api/dashboard/production?days=7|14|30` — единственный
    эндпойнт, `@Roles('SHOP_MANAGER', 'ADMIN')`,
    `ZodValidationPipe(ProductionDashboardQuerySchema)`. Без query —
    `days = 7`.
- **Семантика «сегодня vs период».** KPI-карточки `producedToday`,
  `avgCostPerUnitToday`, `idleCostToday`, `utilizationToday` всегда
  считаются по UTC-сегодня независимо от `?days=`. График и сводки
  `…Period` — за `[dateTo − days + 1 .. dateTo]`. Это сделано
  сознательно: чтобы UI не перемешивал «сегодня» и «период».
- **Pipeline.** Те же правила, что у `/shopfloor` (см. ADR-0013) —
  стадии `CUT · SEWING · QC · QC_DONE · WTO · WTO_DONE · PACKING ·
  FINISHED`, плюс отдельная карточка «Брак». Bottleneck-стадия = с
  максимальным `qty` среди живых (без `FINISHED`). За счёт общей
  `bucketOf` цифры по стадиям совпадают 1:1 с экраном «Цех».
- **Загрузка по ролям.** Только окладные терминальные роли
  `QC` / `IRONING` / `PACKING`: для каждой считаем `paidMinutes`
  (employees × `SHIFT_MINUTES`), `trackedMinutes` (`Σ` длительностей
  стадий за день, cap 60 мин/паспорт), `idleMinutes`, `idleCost` и
  `utilization`. Сдельщикам (швеи, раскройщики) простой не считаем —
  они в строке шумели бы «всегда 0%».
- **Алерты.** Top-items проблемных зон:
  `PIPELINE_BOTTLENECK` (`WARN` если ≥ 50 шт),
  `ROLE_IDLE` (`WARN` если ≥ 1000 ₽),
  `EMPLOYEE_IDLE` (`WARN` если ≥ 240 мин),
  `PEAK_IDLE_DAY`,
  `CAPPED_PASSPORTS` (`WARN` если ≥ 5). Каждый может тащить
  опциональный `href` (например, `PIPELINE_BOTTLENECK → /shopfloor`).
- **Frontend.** Новая страница
  `apps/web/app/admin/production-dashboard/` (SSR, `force-dynamic`):
  - layout-guard `canSeeAdmin` (`apps/web/app/admin/layout.tsx`);
  - 6 KPI-карточек с подсветкой `idleCostToday > 0` красным и
    `utilizationToday` цветом-светофором;
  - блок Pipeline — карточки по стадиям с красной рамкой на
    bottleneck;
  - SVG-чарт `trend-chart.tsx` (3 серии: выпуск / себестоимость /
    простой), без внешних зависимостей — та же стратегия, что у
    `production-cost-chart.tsx` (см. Шаг 20);
  - таблица «Загрузка по ролям» (день `dateTo`);
  - блок «Требует внимания» — список карточек-алертов с цветным dot
    и переходом по `href`;
  - блок «Быстрые переходы» — ссылки на `Цех / Себестоимость /
    Зарплата / Сотрудники / Операции / Склад / Заказы / Операционный
    обзор`;
  - переключатель периода `7 / 14 / 30` дней через `?days=`.
- **Навигация.** Пункт **Дашборд** в шапке
  (`apps/web/app/layout.tsx`) и крупный primary-тайл «Дашборд
  начальника» на менеджерской главной (`apps/web/app/page.tsx`) —
  оба видны только `SHOP_MANAGER` / `ADMIN`. Существующий пункт
  «Обзор» (`/admin/overview`) сохранён как точка для лёгкого
  операционного снимка.
- **Tests.**
  - `tests/integration/production-dashboard.test.ts` — RBAC
    (`SEAMSTRESS` / `QC` / `IRONING` / `PACKING` → 403,
    `SHOP_MANAGER` / `ADMIN` → 200, без сессии → 401), базовый KPI
    по упакованному сегодня паспорту, pipeline / bottleneck для
    живого паспорта в `CUT`, role load для окладного ОТК с
    `SalaryEntry`, период `days=14`, отказ при `days=99`;
  - `tests/smoke/production-dashboard.smoke.test.ts` — структурные
    инварианты модуля: shared-схема (`PRODUCTION_DASHBOARD_PERIODS`,
    дефолтный период, валидация query), backend-wiring
    (`DashboardModule` в `AppModule`, `@Roles` на контроллере,
    переиспользование `CostsService` / `PassportDurationsService` /
    shopfloor projection), frontend (страница использует
    `getProductionDashboard` и шесть управленческих блоков, чарт без
    внешних зависимостей, навигация и тайл главной).

Что **не** делаем на этом шаге: drill-down по сотруднику /
паспорту, custom `dateFrom`/`dateTo` (только закрытый список
`7 / 14 / 30`), второй режим «по сотрудникам» в блоке загрузки,
экспорт в Excel/1С, графики сравнения «план vs факт». Все действия
read-only — ни одного `POST/PATCH` со страницы не идёт.

---

## UI Refresh — единая визуальная система и иконки

Сделан визуальный refresh интерфейса без изменения backend / API /
доменной логики. Цель — современный industrial SaaS-вид, единая
система карточек / таблиц / форм / алертов, и аккуратная иконография
поверх существующих экранов. Все production-смыслы (RBAC,
scan-flows, redirect-ы, server actions) сохранены.

- **Иконки** — `apps/web/components/icon.tsx`. Inline-SVG в стиле
  Lucide / Tabler (24×24, stroke-based, `currentColor`), без
  внешней зависимости и без увеличения bundle на сотни kB.
  Имена иконок сделаны под предметную область (`dashboard`,
  `orders`, `shopfloor`, `production-cost`, `earnings`, `employees`,
  `operations`, `warehouses`, `equipment`, `qc`, `wto`, `packing`,
  `cutting`, `sewing`, `bottleneck`, `idle`, `output`, `price`,
  `scan`, `period`, `filter`, `refresh`, `logout`, …) — UI
  самодокументируется. Добавить новую иконку → добавить путь в
  `ICON_PATHS`.
- **Design system layer** — `apps/web/app/globals.css`,
  блок «Modern visual refresh (UI v2)». Новые reusable-классы
  (`page-shell` / `page-eyebrow` / `page-title` / `page-subtitle`,
  `section-header`, `kpi-grid` / `kpi-card`, `stage-card`,
  `alert-stack` / `alert-row--{info,warn,crit,success}`,
  `quick-grid` / `quick-link`, `toggle-group`, `filter-card`,
  `empty-state`, `brand-mark`) лежат поверх старых
  (`.card`, `.btn`, `.data-table`, `.status-badge`, `.summary-card`,
  `.action-card`, `.scan-card`, `.role-header`) — старые продолжают
  работать на не-обновлённых экранах. Палитра, радиусы и тени
  взяты из существующих CSS-токенов (`--color-*`, `--radius-*`,
  `--shadow-*`), новых цветов не вводилось.
- **Менеджерские экраны** — обновлены с иконкой в заголовке
  и edroбой подсказки (`page-eyebrow / page-title / page-subtitle`):
  - `/admin/production-dashboard` — KPI-grid с цветовыми тонами
    (ok / warn / danger / accent), pipeline как stage-cards с
    подсветкой bottleneck, alerts через severity-цвет + иконку,
    quick-links как иконочные shortcut-карточки, toggle-group для
    переключателя периода.
  - `/production-cost` — KPI-grid + filter-card + аккуратная
    «Динамика по дням» с подзаголовком и empty-state для пустого
    периода.
  - `/earnings` — четыре KPI-card вместо плоского summary,
    одинаковый стиль фильтров, кнопки с иконкой filter / reset.
  - `/admin/employees`, `/admin/operations`, `/admin/warehouses`,
    `/admin/equipment` — единый header (`page-eyebrow + page-title +
    page-subtitle`), section-header с иконкой, empty-state
    вместо плоских «Пусто»; «Открыть →» получили `arrow-right` из
    icon-системы.
- **Главная (`/`)** — заголовок с `page-eyebrow + page-title`,
  блок «Управление производством» с section-header, action-card
  получили SVG-иконки вместо ASCII-символов (✦ ✓ ≋ ▦ ₽ ≡ ◉ ◫ □ ◊ ∑).
  Порядок плиток у менеджеров перестроен под приоритет: дашборд
  и цех — наверху, операционные справочники — ниже, role-terminals
  в конце.
- **Шапка / навигация** — ссылки в `app-header__nav` и пункты
  `MobileNav` получили иконки из единой системы; brand-mark
  с фирменным градиентом; кнопки login/logout — с иконками `login`
  / `logout`.
- **Цеховые терминалы (`/qc`, `/wto`, `/packing`, `/work`,
  `/shopfloor`)** — оставлены strict & fast, как и требует ТЗ.
  Только в заголовки `scan-card` и primary-кнопки добавлены крупные
  иконки (`scan`, `qc`, `wto`, `packing`, `warning`) — текстовые
  лейблы сохранены, размеры тач-целей и flow не менялись.

Acceptance: `npm run typecheck`, `npm run build --workspace=apps/web`
и `npm run test:smoke` проходят (91 / 91 active tests). Никаких
изменений в backend, миграциях, API-контрактах и server-actions.

### Detail-page unification (UI Refresh v2 → detail layer)

Поверх UI Refresh v2 проведена полная унификация **detail-страниц**
(карточки одной сущности): теперь все detail-view собираются по
одному канону (см. `docs/screens.md §10c «Detail-page standard»`):

- Общий компонент `apps/web/components/detail-page-header.tsx`
  (`<DetailPageHeader …>`) — единый back-link / eyebrow / title +
  иконка / subtitle / meta / badges / actions для любой detail-page.
- Новые reusable-классы в `apps/web/app/globals.css`:
  - `.detail-header*` (layout шапки),
  - `.data-list` (label/value пары без таблиц),
  - `.detail-form*` (`__grid` / `__field` / `__field--inline` /
    `__hint` / `__actions` / `__success` / `__error`) — единые
    формы редактирования внутри карточек,
  - `.inline-table-wrap` (скролл-обёртка для таблиц в карточке),
  - `.table-actions` (action-row внутри ячейки таблицы),
  - `.danger-zone` (опасные операции),
  - `.pricing-mode` + `--fixed/--by-size/--salary-only` (бэйджи
    режима тарификации операции),
  - `.rate-table-grid` + `.rate-cell` (современная сетка ставок по
    размерам внутри редактирования операции),
  - `.option-list` (чек-лист «attachable» элементов — operations
    на оборудовании).
- Унифицированные detail-страницы:
  - `/admin/employees/[id]` — hero + карточки «Основное», «Оплата»,
    «Последние начисления», `compensationType` / `active` через `pill`.
  - `/admin/operations/[id]` — hero + выразительный pricingMode-бэйдж
    (FIXED / BY\_SIZE / SALARY\_ONLY) + современная таблица ставок
    по размерам (`.rate-table-grid`).
  - `/admin/warehouses/[id]` — hero + редактирование склада + создание
    линии + список линий + список ячеек с `.table-actions` (печать
    QR / отвязка) + форма привязки ячейки.
  - `/admin/equipment/[id]` — hero + форма ручного номера станка +
    чек-лист разрешённых операций (`.option-list`).
  - `/passports/[id]` — passport-hero (со специальным QR-блоком слева,
    backlink к заказу, status-badge), единые секции «Закрытие
    раскроя», «Качество», «Упаковка», «Начисления», «Размещение в
    ячейке»; `place-form` и `cutting-closure-section` приведены к
    `detail-form`.

Refresh — чисто визуальный/структурный, бизнес-логика, server actions,
backend, API-контракты, миграции, маршруты и тестовые текстовые якоря
**не менялись**. `npm run build --workspace=apps/web` остаётся зелёным.

---

## Deploy / Stage (`stage.teeon.ru`)

Развёртывание stage-окружения — отдельный документ
[`docs/deploy-stage.md`](./docs/deploy-stage.md). Здесь — короткая
выжимка, чтобы не открывать его при каждом перезапуске.

### Настройка stage-домена (DNS)

Перед всем остальным `stage.teeon.ru` должен резолвиться в IP
stage-сервера. Проверка:

```bash
getent hosts stage.teeon.ru
```

Если запись пустая — создать в DNS-панели `teeon.ru`:

| Поле     | Значение      |
| -------- | ------------- |
| Тип      | `A`           |
| Имя      | `stage`       |
| Значение | `<SERVER_IP>` |

`<SERVER_IP>` — публичный IP stage-сервера (`curl -s
https://api.ipify.org` на самом сервере). **Не хардкодить IP в
репозитории** — он зависит от площадки.

### NGINX

Файл `/etc/nginx/sites-available/stage.teeon.ru`:

```nginx
server {
    listen 80;
    server_name stage.teeon.ru;

    # ОБЯЗАТЕЛЬНО: статика Next.js идёт мимо Node.js, иначе
    # браузер получит HTML 404 вместо JS → ChunkLoadError.
    # Подробнее — docs/deploy-stage.md §2a.
    location /_next/static/ {
        alias /sewing/apps/web/.next/static/;
        access_log off;
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location /_next/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # ОБЯЗАТЕЛЬНО: /uploads/* должен идти в API, не в Next.js — иначе
    # превью лекал на /admin/patterns и в форме заказа отдаётся как
    # HTML 404. Подробнее — docs/deploy-uploads-static-routing.md.
    # Блок объявлен ДО `location /` сознательно (см. там же).
    location ^~ /uploads/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }
}
```

Активация:

```bash
sudo ln -s /etc/nginx/sites-available/stage.teeon.ru \
           /etc/nginx/sites-enabled/stage.teeon.ru
sudo nginx -t
sudo systemctl reload nginx
```

### Next.js static chunks (предупреждение)

> **Если в nginx нет блока `location /_next/static/`, приложение
> упадёт с `ChunkLoadError` у любого пользователя.** Браузер запросит
> `/_next/static/chunks/...js`, Next отдаст HTML 404, JS не выполнится.
> Лечится только настройкой nginx (`alias /sewing/apps/web/.next/static/`).
> После каждого деплоя ОБЯЗАТЕЛЬНО прогнать health-check —
> [`docs/deploy-stage.md §2a`](./docs/deploy-stage.md#2a-nextjs-static-chunks-обязательно).

### `.env` для stage

В `.env` на stage-сервере:

```env
APP_URL=https://stage.teeon.ru
API_URL=https://stage.teeon.ru/api
NEXT_PUBLIC_APP_URL=https://stage.teeon.ru
NEXT_PUBLIC_API_URL=https://stage.teeon.ru/api
```

`DATABASE_URL` на stage **не меняется** — остаётся как настроено
локально на сервере.

### Запуск приложения

API на `:3001`, WEB на `:3000` (nginx из §«NGINX» проксирует наружу
только их).

DEV-режим:

```bash
npm run dev:api    # NestJS на :3001
npm run dev:web    # Next.js на :3000
```

PROD-режим (то, что крутится на stage):

```bash
npm install
npm run prisma:migrate
npm run db:seed
npm run build
npm run start --workspace=apps/api    # на :3001
npm run start --workspace=apps/web    # на :3000
```

### Checklist проверки stage

```bash
getent hosts stage.teeon.ru                  # 1. DNS резолвится
ss -ltnp | grep ':3000 '                     # 2. WEB слушает :3000
ss -ltnp | grep ':3001 '                     # 3. API слушает :3001
curl -sS http://127.0.0.1:3000 | head        # 4. отдаётся HTML
curl -sS http://127.0.0.1:3001/api/health    # 5. {"status":"ok",...}
curl -sSI http://stage.teeon.ru              # 6. nginx → 200/302
# 7. http://stage.teeon.ru открывается в браузере (редирект на /login)

# 8. Next.js static chunks (см. docs/deploy-stage.md §2a):
CHUNK_URL=$(curl -s http://stage.teeon.ru/login \
  | grep -oE '/_next/static/chunks/[^"]+\.js' | head -n 1)
curl -sSI "http://stage.teeon.ru${CHUNK_URL}"
#   ожидаем: 200 OK + Content-Type: application/javascript
#   если HTML/404 → nginx сломан, будет ChunkLoadError у всех клиентов

# 9. /uploads/* идёт в API, а не в Next.js
#    Подробнее: docs/deploy-uploads-static-routing.md
#    Берём произвольный реально существующий файл из apps/api/uploads/:
SAMPLE=$(find /sewing/apps/api/uploads -type f | head -n 1)
SAMPLE_URL="/uploads${SAMPLE#/sewing/apps/api/uploads}"
curl -sSI "http://127.0.0.1:3001${SAMPLE_URL}"           # API: 200
curl -sSI "https://stage.teeon.ru${SAMPLE_URL}"          # nginx: 200
#   если nginx → 404/HTML → блок `location ^~ /uploads/` отсутствует
#   или объявлен ниже `location /` — чинить.
```

Если шаг падает — дальше идти бессмысленно, чинить именно его.
Подробности и расширенные проверки — `docs/deploy-stage.md §5`.

---

## Шаг 22 — Печать через агент рабочего места (`/admin/printers`)

Минимальный MVP «нажал → напечаталось» поверх существующих печатных
endpoint-ов. Сотрудник в системе жмёт «Печать», backend по активной
смене находит принтер на его рабочем месте и кладёт задание в очередь;
рядом с принтером живёт Node.js-агент (`apps/agent`), который раз в
2-3 секунды поллит API и печатает. Описание домена —
[`docs/domain.md §17b`](./docs/domain.md), API —
[`docs/api.md §16`](./docs/api.md), экран —
[`docs/screens.md §18`](./docs/screens.md), агент —
[`apps/agent/README.md`](./apps/agent/README.md).

- **Prisma / DB.** Новые модели `Printer` (`name`, `type`,
  `equipmentId?`, `isActive`, `pairingCode?`, `agentToken?`, `isOnline`,
  `lastSeenAt`) и `PrintJob` (`printerId`, `sourceType`, `sourceId?`,
  `payloadUrl`, `status`, `errorMessage?`, `completedAt?`) + enum-ы
  `PrinterType` / `PrintJobStatus` / `PrintJobSource`. Миграция:
  `prisma/migrations/20260422100000_printers_and_print_jobs`.
- **Backend API.** Новый модуль
  `apps/api/src/modules/printers`: `PrintersController` (CRUD +
  `pairing-code` + публичный `agent-download/sewing-print-agent.exe`),
  `PrintersAgentController` (`agent/pair` и `agent/heartbeat`),
  `PrintJobsController` (`POST /api/print-jobs`, `GET` для менеджера,
  `GET /api/print-jobs/agent` и `PATCH /api/print-jobs/:id` для
  агента под `X-Printer-Agent-Token`). `payloadUrl` собирается из
  существующих печатных endpoint-ов (`/api/passports/:id/print`,
  `/api/passports/:id/qr`, `/api/packing/boxes/:id/label`,
  `/api/cells/:id/qr`) — рендер не дублируется.
- **Логика выбора принтера.** При `POST /api/print-jobs` без
  `printerId`: берём активную смену сотрудника → `equipmentId` →
  активный принтер на этом equipment. Без смены — `409
  SHIFT_SESSION_REQUIRED`, без принтера — `409
  PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`.
- **Агент** (`apps/agent`). Модульный ESM-агент (без runtime-deps),
  собирается в один Windows .exe через `esbuild` + `@yao-pkg/pkg`:
  ```bash
  cd apps/agent
  npm install
  npm run build:win   # → apps/agent/dist/sewing-print-agent.exe
  ```
  CLI:
  ```bash
  sewing-print-agent.exe --pair --server <URL> --code PAIR-XXXX-XXXX
  sewing-print-agent.exe
  ```
  При pair-е обменивает `pairingCode` на постоянный `agentToken` и
  сохраняет в локальный `agent-config.json` рядом с exe. Скачивается
  из UI как `GET /api/printers/agent-download/sewing-print-agent.exe`
  (`@Public`); endpoint ищет exe в `apps/agent/dist/` (несколько
  кандидатных путей — см. `printers.controller.ts`). Payload-ы складываются
  в `spool/` → `printed/` (или `failed/`). На MVP физическая печать —
  заглушка (только сохранение файла); точка расширения — `processJob`
  в `src/runtime.mjs`. Подробно: `apps/agent/README.md`.
- **Web UI.**
  - `/admin/printers` — список с pill «онлайн/офлайн», pendingJobsCount,
    форма создания.
  - `/admin/printers/:id` — параметры (PATCH), карточка «Подключение
    агента» (текущий `pairingCode`, кнопки «Сгенерировать код» и
    «Скачать агент»), «Тестовая печать», «Последние задания»,
    «Опасная зона» (удаление).
  - Универсальный компонент `apps/web/components/print-button.tsx`
    заменяет поведение существующих кнопок «Печать» (на MVP подключён
    в `/passports/[id]`): сначала `POST /api/print-jobs`, при коде
    `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`/`SHIFT_SESSION_REQUIRED`
    fallback — открыть прежнюю печатную HTML-форму в новой вкладке.
- **RBAC.** `SHOP_MANAGER`/`ADMIN` — управляют принтерами и видят
  историю; любая залогиненная роль — может вызвать `POST /api/print-jobs`
  без `printerId`; явный `printerId` (тестовая печать) разрешён
  только менеджерам (`403 FORBIDDEN_ROLE`); агент — по
  `X-Printer-Agent-Token`.
- **Tests.** `tests/integration/printers.test.ts` — 14 сценариев:
  CRUD принтеров, RBAC, генерация и обмен `pairingCode`, ошибки
  выбора принтера (`SHIFT_SESSION_REQUIRED`,
  `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`), end-to-end agent flow
  (pair → poll → patch → isOnline), heartbeat, обязательность
  `errorMessage` при `FAILED`, изоляция job-ов между принтерами,
  RBAC на explicit `printerId`.

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name printers_and_print_jobs
```

Что **не** делаем на этом шаге: сложная маршрутизация (несколько
принтеров на сценарий по типу), retry-очередь, обновление агента,
GUI у агента, реальная отправка на физический принтер
(на MVP — заглушка), массовая выгрузка истории заданий, метрики
по очереди. Существующие печатные endpoint-ы и их HTML-формы **не
меняются**, кнопки «Печать» в системе сохраняют название и место —

## Шаг 23 — Выбор физического Windows-принтера для агента

Шаг 22 связал `Printer` ↔ `Equipment` ↔ агент по `agentToken`, но агент
не знал, на какой именно физический Windows-принтер слать задание. На
одной Windows-станции обычно несколько принтеров (HP LaserJet, Zebra
ZD220, Microsoft Print to PDF), поэтому без явного выбора печатать в
проде небезопасно. Этот шаг добавляет end-to-end выбор. Подробно:
[`docs/domain.md §17b`](./docs/domain.md), API —
[`docs/api.md §16`](./docs/api.md), экран —
[`docs/screens.md §18`](./docs/screens.md), агент —
[`apps/agent/README.md`](./apps/agent/README.md).

- **Prisma / DB.** `Printer` дополнен:
  `agentHostName: string?`, `availableWindowsPrinters: string[]
  @default([])`, `windowsPrintersUpdatedAt: timestamp?`,
  `selectedWindowsPrinter: string?`. Миграция:
  `prisma/migrations/20260423100000_printer_agent_windows_printers`.
- **Backend API.**
  - Новый endpoint `POST /api/printers/agent/windows-printers`
    (`@Public + AgentAuthGuard`): агент шлёт
    `{ hostName, printers: string[] }`, backend перезаписывает
    `availableWindowsPrinters` (с дедупликацией), сохраняет
    `agentHostName + windowsPrintersUpdatedAt`, обновляет
    `isOnline/lastSeenAt`. Возвращает текущий `selectedWindowsPrinter`.
    Уже выбранный менеджером принтер НЕ сбрасывается, даже если в новом
    списке его нет.
  - `PATCH /api/printers/:id` принимает
    `selectedWindowsPrinter?: string | null`. Имя должно быть в
    `availableWindowsPrinters`, иначе — `422
    WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`. `null` сбрасывает выбор.
  - `GET /api/printers/:id` теперь отдаёт `agentHostName`,
    `availableWindowsPrinters`, `windowsPrintersUpdatedAt`,
    `selectedWindowsPrinter`.
  - `POST /api/printers/agent/heartbeat` дополнительно возвращает
    `selectedWindowsPrinter`.
  - В каждом `PrintJobDto` теперь лежит `selectedWindowsPrinter` — это
    «снимок выбора на момент выдачи задания», чтобы менеджерская
    смена выбора не разъезжалась с уже забранными агентом job-ами.
- **Агент** (`apps/agent`).
  - Новый модуль `src/windows-printers.mjs` — `listWindowsPrinters()`
    через PowerShell `Get-Printer | Select-Object -ExpandProperty Name`;
    на не-Windows платформах возвращает пустой список (для
    разработки/тестов).
  - `runtime.mjs` сразу при старте и затем каждые ~60 секунд шлёт
    `POST /api/printers/agent/windows-printers` с `os.hostname()` и
    списком принтеров. Heartbeat обновляет `state.selectedWindowsPrinter`.
  - `processJob` использует `job.selectedWindowsPrinter ??
    state.selectedWindowsPrinter`. Если оба `null` — job сразу
    закрывается как `FAILED` («Не выбран Windows-принтер для
    логического принтера…»). Иначе — лог `Would print to:
    <selectedWindowsPrinter>` (реальная печать остаётся точкой
    расширения, как и в шаге 22).
- **Web UI.** В `/admin/printers/:id` новый блок «Физический принтер
  Windows» (`apps/web/app/admin/printers/[id]/windows-printer-form.tsx`):
  показывает `agentHostName`, online/offline pill,
  `windowsPrintersUpdatedAt`, текущий `selectedWindowsPrinter` (badge),
  `<select>` со всеми `availableWindowsPrinters` + опцией «не выбран».
  Server action `selectWindowsPrinterAction` зовёт
  `PATCH /api/printers/:id`. Empty state, если список пуст; если
  агент офлайн — показываем последний известный список с
  предупреждением «агент офлайн, печать сейчас не пойдёт».
- **Tests.** `tests/integration/printers.test.ts` расширен:
  агент успешно загружает hostname + список (+ дедупликация при
  повторных загрузках), `AgentAuthGuard` режет запросы без токена,
  менеджерский `selectedWindowsPrinter` не сбрасывается новой
  синхронизацией, `PATCH` валидирует выбор против списка
  (`422 WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`) и принимает `null`,
  `GET /api/printers/:id` отдаёт все новые поля, офлайн-принтер
  показывает последний известный список, `GET /api/print-jobs/agent`
  включает `selectedWindowsPrinter` в `PrintJobDto`, heartbeat
  возвращает текущий выбор.

Применить миграцию локально:

```bash
npm run prisma:migrate -- --name printer_agent_windows_printers
```

Что **не** делаем на этом шаге: реальная печать на Windows-принтер
(остаётся «Would print to: …» + сохранение в `printed/`), GUI у агента,
автообновление списка чаще раза в минуту, поддержка нескольких
`agentHostName` для одного логического `Printer`, вытаскивание
информации о статусе/очереди принтера из Windows.
заменено только поведение.

---

## Post-Шаг 23 — Массовая печать ячеек склада (38×58 мм)

Управленческая доработка карточки склада `/admin/warehouses/[id]`.
До этого ячейки можно было распечатать только по одной (кнопка
«Печать QR» рядом с каждой ячейкой). При первой раскатке на стеллаж
с 50–200 ячейками этот UX неприемлем — менеджер хочет один клик
«Распечатать всё». Подробно: [`docs/screens.md §10b`](./docs/screens.md),
API — [`docs/api.md §15`](./docs/api.md), доменная модель —
[`docs/domain.md §16`](./docs/domain.md).

- **Печатная форма ячейки.** `apps/api/src/modules/passports/cell-print.ts`
  переписан на жёсткий формат **38×58 мм горизонтально**
  (стандартная термоэтикетка для маркировки полок/ячеек):
  `@page { size: 58mm 38mm; margin: 0 }`, левая половина —
  QR (`cell:{id}` ADR-0008, не меняется), правая половина — крупный
  номер ячейки (шрифт подбирается под длину кода). На самой
  этикетке в реальной печати **никакого** другого текста: ни имени
  склада, ни internal id, ни payload-строки `cell:...`, ни кнопки
  «Печать» (она спрятана через `@media print`). Print-safety
  (`overflow: hidden`, `page-break-inside: avoid`,
  `print-color-adjust: exact` + `-webkit-print-color-adjust: exact`)
  не даёт драйверу «оптимизировать» чёрный QR в серый и не
  выпускает контент на 2-ю страницу. Кнопка «Печать» остаётся
  видимой только в screen-режиме (single-cell flow: менеджер открыл
  этикетку в новой вкладке).
- **Backend API.** Новый endpoint
  `POST /api/warehouses/:id/print-cells` (контракт —
  `PrintWarehouseCellsSchema` в `packages/shared/src/warehouses.ts`).
  Принимает `{ printerId, copies?, labelSize? }`, создаёт
  `cellsCount × copies` PENDING-`PrintJob`-ов с `sourceType=CELL_LABEL`,
  по одному на каждую копию каждой **активной** ячейки склада.
  Деактивированные ячейки молча исключаются. Бизнес-ошибки:
  `WAREHOUSE_NOT_FOUND` (404), `PRINTER_NOT_FOUND` (404),
  `PRINTER_INACTIVE` (409), `WAREHOUSE_NO_CELLS_TO_PRINT` (409).
  Все job-ы создаются одной транзакцией через новый
  `PrintJobsService.createBatch` — не оставляем «половину» очереди
  при ошибке.
- **Print job source.** В enum `PrintJobSource`
  (`packages/shared/src/printers.ts`) добавлен новый литерал
  `CELL_LABEL`. Отличается от существующего `CELL_QR` тем, что это
  уже свёрстанная HTML-этикетка 38×58, а не голый PNG-QR — не
  ломает старые потребители `CELL_QR`. `payloadUrl` job-а указывает
  на `GET /api/cells/:id/print` через
  `resolvePublicApiBaseUrl()` (вынесен в новый
  `apps/api/src/modules/printers/public-api-url.ts`, чтобы и
  `PrintJobsController`, и `WarehousesController` строили URL
  одинаково и не выдавали loopback-адрес агенту).
- **Web UI.** В шапке секции «Ячейки склада» появилась primary-кнопка
  **«Печать всех ячеек»**, открывающая аккуратное модальное окно
  (`apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx`,
  тот же CSS-паттерн `.qr-modal`, что у сканера на `/work`):
  - select «Принтер» — список логических `Printer` с пометкой
    `онлайн/офлайн`; если активных принтеров нет — submit заблокирован
    с подсказкой про `/admin/printers`;
  - select «Размер этикетки» — пока единственный вариант
    `38 × 58 мм (горизонтально, QR + номер)` (`WAREHOUSE_LABEL_SIZES`,
    архитектура готова к расширению — например, A6);
  - input «Копий каждой» — int 1..50 (`WAREHOUSE_PRINT_CELLS_MAX_COPIES`),
    default 1;
  - сводка «Ячеек к печати / Копий / Всего заданий» (live);
  - сетка «Превью этикеток» — первые 24 плитки, повторяющие layout
    `cell-print.ts` (QR слева, номер справа, пропорция 58:38), QR
    тянется через тот же `@Public()` `GET /api/cells/:id/qr`;
  - submit идёт через server action `printWarehouseCellsAction` —
    модалка не закрывается, показывает success-плашку «Поставлено
    N заданий в очередь принтера (M ячеек × K копий)» или
    error-плашку с `requestId`. Кнопка disabled, если активных
    ячеек нет (UI + backend синхронны).
  - Esc / клик по бэкдропу / крестик закрывают окно, скролл фона
    блокируется.
- **Tests.**
  - `tests/integration/warehouses.test.ts` обновлён: проверяем, что
    `GET /api/cells/:id/print` отдаёт жёсткий 38×58 (`@page size: 58mm
    38mm`, `width: 58mm`, `height: 38mm`), включая print-safety
    (`print-color-adjust: exact`, `page-break-inside: avoid`,
    `overflow: hidden`) и `@media print { .actions { display: none } }`,
    что в HTML есть только QR + номер ячейки и **нет** ни имени
    склада, ни внутреннего id, ни payload-строки `cell:...`.
  - Новый `tests/integration/warehouse-print-cells.test.ts` —
    happy path (job-ы созданы под `sourceType=CELL_LABEL` с
    payload-URL `/cells/:id/print`), `copies × cellsCount` (включая
    дефолт 1), фильтр деактивированных ячеек, пустой склад → 409
    `WAREHOUSE_NO_CELLS_TO_PRINT`, отсутствующий/деактивированный
    принтер → 404/409, валидация `printerId`/`copies > 50` → 400,
    single-cell HTML не сломан, RBAC (SEAMSTRESS/QC/CUTTER → 403,
    ADMIN/SHOP_MANAGER → 201).
  - `tests/smoke/warehouses-admin.smoke.test.ts` расширен: detail-страница
    подключает `WarehouseBulkPrintPanel` и `listPrinters()`, модалка
    содержит выбор принтера/копий/размера, превью и кнопки
    «Отмена» + «Печать», контроллер выставляет `POST /:id/print-cells`,
    `cell-print.ts` фиксирует 38×58 и не упоминает warehouse / qr-payload.

Что **не** делаем на этом шаге: реальные размеры этикеток помимо
38×58 (dropdown пока с одним вариантом — расширение под A6/A7
заведено в `WAREHOUSE_LABEL_SIZES`), приоритезация очереди печати
(агент берёт FIFO), отдельный «print preflight» с проверкой
занятости принтера, цветной QR. QR-payload `cell:{id}` (ADR-0008)
**не меняется** — уже напечатанные стикеры остаются валидными.

---

## Post-Шаг 23 — Equipment CRUD: создание и переименование

Маленькая, но важная для цеха доработка `/admin/equipment`:
управленческий раздел теперь поддерживает не только настройку
операций и `displayNumber`, но и полноценное создание/переименование
оборудования. До этого новое оборудование можно было завести только
через seed.

- **Prisma / DB.** Без миграций — поля `Equipment.name` (NOT NULL),
  `Equipment.code` (UNIQUE), `Equipment.qrCode` (UNIQUE),
  `Equipment.displayNumber` (nullable), `Equipment.active` уже
  существовали (см. ADR-0017, Шаг 14/15).
- **Backend API** (модуль `apps/api/src/modules/equipment`):
  - `POST /api/equipment` — создание оборудования. `name` обязателен
    (1..120 символов после трима). `code` опционален: если пуст,
    backend генерирует slug имени с автоматическим суффиксом `-2`,
    `-3`, … для уникальности (та же UX-логика, что у `/admin/warehouses`).
    `displayNumber` и `operationIds` опциональны; для последних в той
    же транзакции создаются связи `EquipmentOperation` со sortOrder
    `(i + 1) * 10`. `qrCode` НЕ принимается — backend ставит каноничный
    `equipment:{id}` (ADR-0008, scan flow на /work совместим).
  - `PATCH /api/equipment/:id` теперь принимает и `name` (переименование),
    и `displayNumber`. Хотя бы одно поле обязательно. `code` / `qrCode` /
    `active` через эту ручку сознательно не меняются — printer-bindings
    и уже напечатанные QR-этикетки переживают переименование.
  - Новая бизнес-ошибка `EQUIPMENT_CODE_TAKEN` (409) — транслируется
    из P2002 на unique-индексе `Equipment.code`.
  - Роли — `ADMIN` / `SHOP_MANAGER` (контроллер уже под `@Roles(...)`).
- **Web UI.**
  - `/admin/equipment` — список без встроенной формы создания.
    В правом краю шапки — primary-кнопка «Добавить оборудование»,
    ведущая на отдельную страницу `/admin/equipment/new` (см. ниже).
    На пустом стейте — inline-ссылка «Добавьте первый станок» туда же.
    *(History note.* Изначально форма создания жила прямо в списке —
    при росте количества операций она перегружала страницу и мешала
    просмотру таблицы; пост-Шаг 23.5 вынесли её на отдельный экран,
    backend `POST /api/equipment` и server action `createEquipmentAction`
    не менялись.)
  - `/admin/equipment/new` — отдельная страница создания оборудования:
    `DetailPageHeader` с back-link'ом «← К списку оборудования» и
    одна карточка «Параметры оборудования» с переиспользуемой формой
    `CreateEquipmentForm` (поля «Название», «Номер оборудования»,
    «Код», чек-лист «Операции»; submit — «Создать оборудование»).
    После успешного создания action редиректит на карточку нового
    станка (`/admin/equipment/[id]`) — поведение и валидация
    идентичны прежней встроенной форме.
  - `/admin/equipment/[id]` — добавлена секция «Название оборудования»
    с отдельной формой переименования (Server Action
    `updateEquipmentNameAction`). Существующие секции «Номер станка»
    и «Разрешённые операции» сохранены без изменений.
  - После переименования ревалидируется `/work` — швея сразу видит
    новое имя в форме старта смены.
- **Tests.** Расширен `tests/integration/equipment-operations.test.ts`
  (создание с явным/автогенерируемым кодом, связи операций и порядок
  sortOrder, конфликт кода → 409, длина и пустой `name` → 400,
  переименование, RBAC для POST). Новый
  `tests/smoke/equipment-admin.smoke.test.ts` фиксирует наличие форм
  на странице и контракт `CreateEquipmentSchema` /
  `UpdateEquipmentSchema`.
- **Docs.** Обновлены `docs/api.md §3a` (POST + расширенный PATCH),
  `docs/screens.md §10a` (форма создания + секция «Название»),
  `docs/domain.md §5c` (POST/PATCH ручки), `docs/index.md`
  (Equipment CRUD).

Что **не** делаем на этом шаге: деактивация оборудования (`active`
через PATCH), ручная смена `code`/`qrCode` (это сломало бы
напечатанные стикеры — другая история), история переименований,
soft-delete оборудования.

---

## Порядок разработки

См. чек-лист в [`docs/index.md`](./docs/index.md#порядок-разработки-чек-лист-mvp).

Сейчас закрыты **Шаги 1–10** (MVP 1.0) + **Шаг 11** (MVP 1.1,
Stabilization) + **Шаг 12** (Pilot Rollout / UAT / Bugfix Sprint) +
управленческие шаги пост-пилота **13/14/15/16/17/18/19/20/21/22/23**
+ post-23 **Equipment CRUD (создание и переименование)**
(mobile redesign, equipment configuration + displayNumber, закрытие
раскроя по размеру, склады, управленческий блок «Операции» с единым
тарифом, дневной оклад от факта смены, себестоимость выпуска,
дашборд начальника производства, печать через агент рабочего места):
архитектура, Prisma-схема, проектная документация, seed-данные,
заказы, паспорта (выпуск + QR + печать + размещение), смены и
сканирование паспортов на операциях, ОТК и фиксация брака,
ВТО + упаковка + выпуск изделия, сдельные начисления раскройщика и
пошива (immediate / after-release с подтверждением при закрытии коробки),
экран «Цех» (`/shopfloor`) с автообновлением и flash-подсветкой,
реальная авторизация, RBAC, DB-инварианты, health/ready и
интеграционные тесты, а также пилотная документация (`docs/pilot/`),
сквозной `requestId` в логах и ответах ошибок,
лёгкий операционный обзор `/admin/overview`, UX-полировка `/work`,
управление оборудованием/складами/операциями из админки. Дашборд
начальника (`/dashboard`), WS/SSE, аналитика и интеграции — за
рамками MVP.
