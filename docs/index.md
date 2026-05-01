# Документация — Система управления швейным производством

> Документация — источник истины. Код должен соответствовать ей.
> При несоответствии: правим код.

---

## Где что

| Файл              | О чём                                          |
| ----------------- | ---------------------------------------------- |
| `architecture.md` | Архитектура, стек, монорепо, слои              |
| `domain.md`       | Доменная модель, глоссарий, роли, операции     |
| `erd.md`          | ERD (описание таблиц, ключей, индексов)        |
| `flows.md`        | Бизнес-потоки (F1…F12)                         |
| `events.md`       | Событийная модель паспорта и EventBus          |
| `api.md`          | REST API, эндпоинты, коды ошибок               |
| `screens.md`      | Карта экранов PWA, навигация по ролям          |
| `pilot/`          | Pilot Rollout / UAT — план, onboarding, FAQ    |
| `adr/`            | Архитектурные решения (ADR)                    |

Техническая схема БД: `prisma/schema.prisma`.
Seed-данные (справочники MVP): `prisma/seed.ts`
(запуск — `npm run db:seed`; подробнее — в `README.md`).

---

## Домены и URL-ы

| Окружение | Web                    | API                       |
| --------- | ---------------------- | ------------------------- |
| prod      | `https://prod.teeon.ru`| `https://api.prod.teeon.ru` |
| stage     | `https://stage.teeon.ru` | `https://stage.teeon.ru/api` |
| dev       | `http://localhost:3000` | `http://localhost:3001/api` |

Источник истины для URL-ов — переменные окружения (`APP_URL`, `API_URL`,
`NEXT_PUBLIC_API_URL`); константы `DOMAIN_PROD_WEB` / `DOMAIN_PROD_API`
в `packages/shared/src/config.ts` используются только как fallback.
Хардкод `localhost` или prod-хостов в исходниках **запрещён**.

---

## ADR (ключевые решения)

- [ADR-0001 Монорепо структура](./adr/0001-monorepo-structure.md)
- [ADR-0002 Паспорт как агрегат-корень](./adr/0002-passport-as-aggregate-root.md)
- [ADR-0003 Event-sourcing lite](./adr/0003-event-sourcing-lite.md)
- [ADR-0004 Упрощённая модель ячеек](./adr/0004-simplified-cells.md)
- [ADR-0005 Моменты начисления зарплат](./adr/0005-salary-timing.md)
- [ADR-0006 План иммутабелен](./adr/0006-plan-is-immutable.md)
- [ADR-0007 Polling вместо WS на MVP](./adr/0007-polling-for-realtime.md)
- [ADR-0008 Формат QR-кодов](./adr/0008-qr-format.md)
- [ADR-0009 Один заказ — одно изделие и один цвет](./adr/0009-order-one-product-one-color.md)
- [ADR-0010 Печатная форма паспорта, текущая ячейка и условие выпуска](./adr/0010-passport-print-and-placement.md)
- [ADR-0011 Упаковка, коробки и выпуск изделия](./adr/0011-packing-and-release.md)
- [ADR-0012 Идемпотентность сдельных начислений](./adr/0012-earning-deduplication.md)
- [ADR-0013 Маппинг паспортов на этапы экрана «Цех»](./adr/0013-shopfloor-stage-mapping.md)
- [ADR-0014 Авторизация и сессии (MVP 1.1)](./adr/0014-auth-and-sessions.md)
- [ADR-0015 Инварианты на уровне БД (MVP 1.1)](./adr/0015-db-invariants.md)
- [ADR-0016 Стратегия тестов MVP 1.1](./adr/0016-test-strategy.md)
- [ADR-0017 Equipment ↔ allowed operations (backend source of truth)](./adr/0017-equipment-allowed-operations.md)
- [ADR-0018 Закрытие раскроя по размеру через заявку](./adr/0018-cutting-closure-request.md)
- [ADR-0019 Склады как управленческая группировка ячеек](./adr/0019-warehouses.md)
- [ADR-0020 Управленческий блок «Операции» и единая модель тарифов](./adr/0020-operation-pricing-model.md)
- [ADR-0021 Дневной оклад от факта смены (`SalaryEntry`)](./adr/0021-shift-day-salary.md)

---

## Как развивать документацию

Правило **docs-first**:

1. Любое существенное изменение бизнес-логики или архитектуры сначала
   описывается здесь или в новом ADR.
2. Потом правится `prisma/schema.prisma` / API / UI.
3. PR без обновлённой документации — не мержим.

Формат ADR: `NNNN-kebab-title.md`. Нумерация монотонная.

---

## Порядок разработки (чек-лист MVP)

Соответствует ТЗ §20.

- [x] **Шаг 1.** Архитектура + Prisma schema
- [x] **Шаг 2.** Docs (architecture / domain / flows / events / erd / api / screens / ADR)
- [x] **Шаг 3.** Seed-данные (размеры, операции, продукты, демо-сотрудники, оборудование, ячейки, базовые PieceRate)
- [x] **Шаг 4.** Заказы (CRUD + блокировка плана + управленческий dashboard по заказу)
- [x] **Шаг 5.** Паспорт (выпуск на `CUT_DIVISION` + QR + печатная форма + размещение в ячейке + факт раскроя в агрегатах заказа). Начисление раскройщику и PDF-рендер — на следующих шагах (см. [ADR-0010](./adr/0010-passport-print-and-placement.md), `flows.md §F2`).
- [x] **Шаг 6.** Сотрудники, смены, оборудование, перемещения (выбор демо-сотрудника, старт/стоп смены на оборудовании, выдача кроя из ячейки, сканирование паспорта на операции, событие `OPERATION_SCAN`). Начисление пошива остаётся PENDING (см. `flows.md §F3a/F4`).
- [x] **Шаг 7.** ОТК и фиксация брака (справочник `DefectType`, `PassportDefect`, `qtyDefect/qtyGood` в паспорте, агрегат `qtyDefectTotal` по заказу, событие `DEFECT_RECORDED`, экраны `/qc` и `/qc/passports/[id]`). Виновная операция, возврат брака в производство и split паспорта — за рамками MVP.
- [x] **Шаг 8.** ВТО + упаковка + выпуск изделия. ВТО — обычный `OPERATION_SCAN` на операцию `WTO` через `/api/passports/:id/scan` (отдельного API нет, см. ADR-0011). Упаковка — `Box`/`BoxItem`, добавление паспорта в коробку = выпуск (`Passport.status = PACKED`, `PassportEvent(PACKED)`, агрегат `qtyFinishedTotal` по заказу). Экраны `/packing` и `/packing/boxes/[id]`. Апрув `OperationEntry(PENDING)`, расчёт зарплаты и сплит коробок — на Шаге 9+.
- [x] **Шаг 9.** Сдельная зарплата (минимум): модель `OperationEntry` расширена `approvalMode` / `sourceEventType` / уникальным индексом идемпотентности (ADR-0012); раскройщик получает `IMMEDIATE`-начисление в транзакции `PassportsService.create`, пошив — `PENDING_RELEASE` в транзакции `scanOnOperation` и `APPROVED` в транзакции `PackingService.addPassport` (ADR-0005). API `/api/earnings`, `/api/earnings/summary`, `/api/passports/:id/earnings`; UI `/earnings` + блок «Начисления» в `/passports/[id]`. Окладная часть, ведомость за месяц, удержания за брак, экспорт и интеграция с 1С/ЗУП — за рамками MVP.
- [x] **Шаг 10.** Экран «Цех» (`/shopfloor`) — управленческая доска `размер × этап → qty` поверх существующих агрегатов (orders + passports + qc + packing). Серверная проекция `ShopfloorService` (`GET /api/shopfloor/state`), без новой материализованной витрины и без новых событий: stage buckets выведены из `Passport.status`, `Passport.currentOperation.category` и `BoxItem.box.closedAt` (см. [ADR-0013](./adr/0013-shopfloor-stage-mapping.md)). Polling `3 сек` (ADR-0007), на изменении значений в ячейке — короткая flash-подсветка (зелёный = «приехало», красный = «уехало»). Полноценная анимация перелёта паспорта и дашборд начальника — за рамками MVP.
- [x] **Шаг 12 (Pilot Rollout / UAT / Bugfix Sprint).** Подготовка к
  реальному запуску в цехе. Не вводит новых модулей. Добавлены:
  пакет документации `docs/pilot/` (rollout-plan, onboarding,
  operator-checklist, FAQ, шаблон сбора фидбека); сквозной
  `requestId` в логах и в каждом ответе ошибки (см. `api.md §13`);
  лёгкий операционный эндпоинт `GET /api/admin/overview` (активные
  смены, открытые коробки, паспорта в работе/в ячейках, события
  за 24ч; см. `api.md §11a`) и компактная страница `/admin/overview`
  для начальника цеха. Quick-fix-пакет: автофокус и быстрый reset
  на `/work`, единая краткая русская формулировка ошибок,
  явные guard-ы (двойной скан = no-op, повторная упаковка
  блокируется, нельзя работать без активной смены, qty не уходит
  в минус). Расширенные тесты: `pilot-flow.test.ts` с double-scan
  stress, rapid issue+scan и pack-after-defect.

- [x] **Equipment configuration (post-Шаг 13).** Связь
  `Equipment ↔ Operation` вынесена из фронтового хардкода по префиксу
  `Equipment.code` в нормальную M2M-таблицу `EquipmentOperation`
  (см. [ADR-0017](./adr/0017-equipment-allowed-operations.md),
  `domain.md §5c`, `erd.md §2.5a`, `api.md §3a`). Источник истины —
  backend; `/api/shifts/meta` отдаёт у каждой единицы оборудования
  `allowedOperationIds`, `/work` использует только их. Управление —
  `/admin/equipment` и `/admin/equipment/[id]` (роли `ADMIN`,
  `SHOP_MANAGER`, см. `screens.md §10`).

- [x] **Equipment displayNumber + печатная QR-этикетка.** У
  `Equipment` появился ручной `displayNumber String?` (см.
  `domain.md §5c`, `erd.md §2.5`, `api.md §3a`, `screens.md §10a`)
  для физической маркировки станков. В админке его видно списком,
  редактируется на карточке, оттуда же печатается этикетка
  `GET /api/equipment/:id/print` — A6-страница с крупным `№` и QR
  `equipment:{id}` (формат ADR-0008 не меняется). Эндпоинт `@Public()`
  — той же логикой, что у `/api/passports/:id/print`. PATCH-ручка
  `PATCH /api/equipment/:id` — `ADMIN` / `SHOP_MANAGER`.

- [x] **Equipment CRUD (post-Шаг 14).** На `/admin/equipment`
  появилась форма создания нового станка (`POST /api/equipment` с
  `name` обязательным, `code` опциональным — slug автогенерируется
  из имени, `displayNumber` и `operationIds` опциональны). На
  карточке `/admin/equipment/[id]` добавлена секция «Название
  оборудования» — `PATCH /api/equipment/:id` теперь принимает и
  `name`, и `displayNumber`. `code`/`qrCode` через PATCH сознательно
  не меняются — printer-bindings и уже напечатанные QR-этикетки
  переживают переименование. Роли — `ADMIN`/`SHOP_MANAGER` (см.
  `api.md §3a`, `screens.md §10a`).

- [x] **Warehouses (post-Шаг 14).** Управленческая группировка ячеек
  физического хранения. Новая сущность `Warehouse(name UNIQUE,
  code UNIQUE NULL, isActive)` и nullable `Cell.warehouseId` с FK
  `ON DELETE SET NULL` (см. [ADR-0019](./adr/0019-warehouses.md),
  `domain.md §16`, `erd.md §2.13a`). Backend как источник истины:
  CRUD `/api/warehouses` + узкий `PATCH /api/cells/:id { warehouseId }`
  (`api.md §15`), всё под `ADMIN`/`SHOP_MANAGER`. UI — `/admin/warehouses`
  (список + создание) и `/admin/warehouses/[id]` (реквизиты + ячейки
  + блок «Привязать ячейку», см. `screens.md §10b`); тайл «Склад» на
  главной только для менеджеров. QR-этикетка ячейки —
  `GET /api/cells/:id/print` (`@Public()` HTML A6, payload `cell:{id}`
  по ADR-0008 не меняется). Существующий flow «scan cell → place
  passport» специально оставлен 1:1 — `Cell.warehouseId` nullable,
  `POST /api/cells/by-code` и `POST /api/passports/:id/place`
  работают как раньше.

- [x] **Operations management & unified pricing (post-Шаг 17).**
  Управленческий блок «Операции» как нормальная админ-сущность.
  На `Operation` добавлены `pricingMode` (`FIXED` / `BY_SIZE` /
  `SALARY_ONLY`), `fixedRate`, `updatedAt`; новая таблица
  `OperationRateBySize(operationId, sizeId, rate)` с
  `UNIQUE (operationId, sizeId)` и `ON DELETE CASCADE` от
  `Operation` (см. [ADR-0020](./adr/0020-operation-pricing-model.md),
  `domain.md §4`/§4a, `erd.md §2.3`/§2.3a). Backend как источник
  истины: CRUD `/api/operations` под `ADMIN`/`SHOP_MANAGER`
  (`api.md §15a`), единый helper
  `OperationsService.resolveRate(operationId, sizeId)` —
  единственный источник ставки для earnings (`FIXED` →
  `fixedRate`, `BY_SIZE` → `OperationRateBySize.rate`,
  `SALARY_ONLY` → `null`/skip). `EarningsService` (раскрой и
  пошив) переведён на `resolveRate`; старая `findRate` поверх
  `PieceRate` и константа `PIECEWORK_OPERATION_CODES` удалены из
  runtime. UI — `/admin/operations` (список + создание) и
  `/admin/operations/[id]` (адаптивная форма под `pricingMode`,
  с быстрой кнопкой «Заполнить всем одну ставку» для `BY_SIZE`,
  см. `screens.md §10c`); тайл «Операции» на главной только для
  менеджеров. Миграция бэкфилит данные из `PieceRate` (саму
  таблицу оставляем для аудита/rollback). Существующий pipeline
  выпуска паспорта / scan / упаковки / earnings — без изменений,
  все 249 интеграционных и smoke-тестов зелёные
  (`tests/integration/operations.test.ts` — 20 новых сценариев,
  включая RBAC и интеграцию с earnings).

- [x] **Shift-day salary (post-Шаг 18).** Управленческая модель
  оклада «была смена в день → платим ставку за день» как параллельный
  контур к сдельщине (`OperationEntry` не трогается). На `Employee`
  добавлены `compensationType` (`PIECEWORK` / `SALARY` / `MIXED`,
  default `PIECEWORK`) и `salaryPerShift Decimal?`; новая таблица
  `SalaryEntry(employeeId, date, amount, source, editedManually,
  managerComment, editedByEmployeeId)` с уникальным
  `(employeeId, date, source)` (см. [ADR-0021](./adr/0021-shift-day-salary.md),
  `domain.md §9a`, `erd.md §2.13b`). Backend как источник истины:
  `SalaryService.syncDailySalary` дёргается из `ShiftsService.start/stop`
  и идемпотентно создаёт/обновляет одну запись в день, не трогая
  суммы с `editedManually = true`. API — `/api/salary` (list/summary)
  + `PATCH /api/salary/:id` для `SHOP_MANAGER`/`ADMIN` (ручная правка
  суммы и комментария, либо `reset = true` чтобы вернуть под
  автоматику; см. `api.md §10a`); `/api/employees` (list/get/PATCH,
  только менеджер; `api.md §3b`). UI — `/admin/employees`
  (список + карточка с инлайн-редактированием `compensationType` /
  `salaryPerShift` / `active`, см. `screens.md §10d`) и блок
  «Окладные начисления» в `/earnings` с инлайн-кнопками «Исправить» /
  «Вернуть в авто» (`screens.md §12.3`). RBAC: рабочие роли видят
  только свои окладные строки и не редактируют сотрудников/суммы.
  Сдельный pipeline (выпуск паспорта / scan / упаковка / earnings)
  не меняется, все 261 интеграционный/smoke тест зелёные
  (`tests/integration/salary.test.ts` — 12 сценариев).

- [x] **Cutting closure requests (post-Шаг 14).** Новая управленческая
  цепочка «помощник раскройщика подаёт заявку — мастер подтверждает /
  отклоняет». На пару `(orderId, productId, sizeId)` живёт ровно одна
  активная (`REQUESTED`) и максимум одна финальная (`APPROVED`) заявка
  — гарантировано partial unique indexes (`erd.md §2.5b`,
  [ADR-0015](./adr/0015-db-invariants.md)). После `APPROVED` backend
  режет `POST /api/passports` ошибкой `CUTTING_CLOSED` (HTTP 409,
  `api.md §14`). Карточка паспорта (`/passports/[id]`) показывает
  блок «Закрытие раскроя» помощнику и мастеру с планом/фактом/остатком,
  на `/orders/[id]` менеджер видит баннер pending/approved заявок
  (см. [ADR-0018](./adr/0018-cutting-closure-request.md), `domain.md §15`,
  `flows.md §F13`, `screens.md §3`).

- [x] **Production cost (post-Шаг 19).** Управленческий read-only
  модуль `/production-cost` (`SHOP_MANAGER` / `ADMIN`) поверх уже
  работающего журнала. Никаких новых таблиц/событий: `CostsService`
  сводит дневные метрики выпуска (units / piecework / распределённый
  оклад / простой) из `OperationEntry`, `SalaryEntry` и
  `PassportEvent`, а `PassportDurationsService` выводит длительности
  стадий `QC` / `WTO` / `PACKING` с cap-ом `MAX_STAGE_MINUTES_PER_PASSPORT
  = 60`. Стоимость минуты = `salaryPerShift / SHIFT_MINUTES`
  (`SHIFT_MINUTES = 480`, ADR-0021), простой = `max(0, SHIFT_MINUTES
  − tracked) × minuteRate` и **не** распределяется на изделия.
  Эндпойнт — `GET /api/costs/production?dateFrom&dateTo`
  (`api.md §17`), страница — SVG-чарт + summary-карточки + таблица
  по дням (`screens.md §17`), бизнес-правила — `domain.md §17`.
  Интеграционные тесты — `tests/integration/production-cost.test.ts`,
  smoke — `tests/smoke/production-cost.smoke.test.ts`.

- [x] **Production dashboard (post-Шаг 19).** Управленческий read-only
  экран `/admin/production-dashboard` (`SHOP_MANAGER` / `ADMIN`), который
  собирает в одном ответе всё, что раньше было размазано по
  `/shopfloor`, `/production-cost`, `/admin/overview`, `/earnings` и
  `/admin/employees`. Backend — единый агрегатор
  `GET /api/dashboard/production?days=7|14|30` (`api.md §11b`); UI
  ничего не пересчитывает. Никаких новых таблиц/событий: pipeline
  через ту же `bucketOf` из shopfloor-проекции (ADR-0013); выпуск —
  по `PassportEvent(PACKED)`; себестоимость и простой по дням —
  переиспользуем `CostsService`; нагрузка по ролям —
  `PassportDurationsService` за день «to», агрегированный по
  `Employee.role` ∈ `{QC, IRONING, PACKING}`; алерты — top-items
  проблемных зон (bottleneck, role idle, employee idle, peak idle
  day, capped passports). KPI «сегодня» считаются по UTC-сегодня
  независимо от `?days=`, график и сводки `…Period` — за период.
  Экран — `screens.md §18`, доменные правила — `domain.md §17a`,
  ссылка «Дашборд» в шапке и крупный primary-тайл «Дашборд
  начальника» на главной для менеджеров. Тесты —
  `tests/integration/production-dashboard.test.ts`,
  `tests/smoke/production-dashboard.smoke.test.ts`.

- [x] **Шаг 11 (MVP 1.1, Stabilization).** Реальная авторизация (`/api/auth/login`/`logout`/`me`), session-cookie с подписью HMAC-SHA256 и `Domain=.teeon.ru`, RBAC через `AuthGuard` + `@Roles()` (см. [ADR-0014](./adr/0014-auth-and-sessions.md)). Критические инварианты на уровне БД: partial-unique для активной смены, глобальный unique на `BoxItem.passportId`, фиксация уникальности номеров и QR (см. [ADR-0015](./adr/0015-db-invariants.md)). Интеграционные/smoke-тесты на ключевой производственный поток (orders → passports → shifts → qc → packing → earnings); тесты автоматически skip-аются без `TEST_DATABASE_URL` (см. [ADR-0016](./adr/0016-test-strategy.md)). Health/Ready endpoints (`/api/health`, `/api/ready`) и `GlobalExceptionFilter` (нормализация ошибок). UI: страница `/login`, route protection через `middleware.ts`, индикация текущего пользователя и logout-action в шапке. Подробнее в `domain.md §0a`, `api.md §1`, `flows.md §F0`.

---

## Не в скоупе MVP

См. `architecture.md §13`.
