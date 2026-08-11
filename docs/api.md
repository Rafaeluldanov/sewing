# API

> ⚠️ **Источник истины — контроллеры**
> `apps/api/src/modules/**/*.controller.ts`.
>
> Этот документ — карта routes, собранная **строго от существующих
> контроллеров** (PHASE 1, 2026-Q2). Все роуты ниже привязаны к
> конкретному файлу контроллера. Где DTO/response не очевиден из
> контроллера — указано `UNKNOWN/TODO` и ссылка на исходник
> (`apps/api/src/...` или `packages/shared/src/...`).
>
> При расхождении документа и кода — **верим коду**.
>
> Команда быстрой инвентаризации:
>
> ```bash
> rg "@(Controller|Get|Post|Patch|Delete|Put)" apps/api/src/modules
> ```

---

## Общие соглашения

- Префикс всех путей — `/api`. Ответы — `application/json`
  (исключения: `/print` — `text/html; charset=utf-8`,
  `/qr` / `/label` — `image/png` или `text/html`,
  `/printers/agent-download/...` — `application/octet-stream`).
- **Аутентификация (MVP 1.1)**: подписанная HttpOnly session-cookie
  `sewing_session` (HMAC-SHA256, ADR-0014). Cookie ставится на
  login и удаляется на logout.
- **Глобальный `AuthGuard`**: каждый запрос требует валидную сессию,
  кроме маршрутов с декоратором `@Public()` (см. ниже).
- **`@Roles(...)`**: метод-уровень переопределяет класс-уровень.
  `ADMIN` глобально проходит любой `@Roles(...)` (см.
  `apps/api/src/modules/auth/roles.guard.ts`). Роли:
  `ADMIN | SHOP_MANAGER | SHOPFLOOR_MASTER | CUTTER | CUTTER_ASSISTANT |
  SEAMSTRESS | QC | IRONING | PACKING | DISPLAY`.
- **AgentAuthGuard**: используется на агентских (принтерных) routes,
  принимает `X-Printer-Agent-Token` (см.
  `apps/api/src/modules/printers/agent.guard.ts`).
- **Validation**: тело и query валидируются через `ZodValidationPipe`
  (см. `apps/api/src/common/zod-validation.pipe.ts`); схемы и DTO
  лежат в `packages/shared/src/**`.

### Легенда таблиц

- `Метод`: HTTP-метод.
- `Путь`: с `/api` префиксом.
- `RBAC`: эффективные роли с учётом класса + метода. `Public` =
  есть `@Public()`. `AgentAuthGuard` = тот же `@Public()` для
  AuthGuard, но защищён токеном принтера.
- `Источник`: путь до контроллера (короткий — относительно
  `apps/api/src/modules/`).

---

## Содержание

- [0. Health / Readiness / Diagnostics](#0-health-ready-diagnostics)
- [1. Auth](#1-auth)
- [1a. Me (личный кабинет)](#1a-me)
- [2. Catalog (sizes / products / sizes-CRUD)](#2-catalog)
- [3. Employees](#3-employees)
- [4. Equipment](#4-equipment)
- [5. Shifts](#5-shifts)
- [6. Operations](#6-operations)
- [7. Routes](#7-routes)
- [8. Tech-cards](#8-tech-cards)
- [9. Patterns](#9-patterns)
- [10. Pattern categories](#10-pattern-categories)
- [11. Clients](#11-clients)
- [12. Suppliers](#12-suppliers)
- [13. Orders](#13-orders)
- [14. Order applications](#14-order-applications)
- [15. Order material arrivals](#15-order-material-arrivals)
- [16. Cut readiness](#16-cut-readiness)
- [17. Cutting closure requests](#17-cutting-closure-requests)
- [18. Workshop needs](#18-workshop-needs)
- [19. Purchase orders](#19-purchase-orders)
- [20. Purchase receipts](#20-purchase-receipts)
- [20a. Material issues](#20a-material-issues)
- [21. Cut release policy](#21-cut-release-policy)
- [21a. Order cut issue rules](#21a-order-cut-issue-rules)
- [21c. Order calculations (варианты просчёта)](#21c-order-calculations)
- [22. Master calls](#22-master-calls)
- [23. Master actions](#23-master-actions)
- [24. Passports](#24-passports)
- [24b. Order samples (Сигнальный образец)](#24b-order-samples)
- [25. Cells](#25-cells)
- [26. Warehouses](#26-warehouses)
- [26a. Stock](#26a-stock)
- [27. QC](#27-qc)
- [28. WTO](#28-wto)
- [29. Packing](#29-packing)
- [29a. Finished goods (read-only)](#29a-finished-goods)
- [30. Earnings](#30-earnings)
- [30a. Payroll (PHASE 1, read-only)](#30a-payroll)
- [31. Salary](#31-salary)
- [31a. Payroll calendar (производственный календарь)](#31a-payroll-calendar)
- [32. Shopfloor](#32-shopfloor)
- [33. Display screens](#33-display-screens)
- [34. Dashboard](#34-dashboard)
- [35. Costs / production-cost-v2](#35-costs)
- [36. Admin overview](#36-admin)
- [37. Admin diagnostics](#37-diagnostics)
- [38. Defect types](#38-defect-types)
- [39. Printers](#39-printers)
- [40. Print jobs](#40-print-jobs)
- [41. Printers agent](#41-printers-agent)
- [42. Company settings](#42-company-settings)

---

<a id="0-health-ready-diagnostics"></a>
## 0. Health / Readiness

Источник: `health/health.controller.ts`.

| Метод | Путь          | RBAC   | Описание |
| ----- | ------------- | ------ | -------- |
| GET   | `/api/health` | Public | Liveness. `{ status: 'ok', time }`. БД не пингует. |
| GET   | `/api/ready`  | Public | Readiness. Дополнительно `SELECT 1` к БД; при ошибке возвращает 200 `{ status: 'not-ready', reason: 'database', time }`. |

Response DTO: `HealthResponseDto`, `ReadyResponseDto`
(`packages/shared/src/auth.ts`).

---

<a id="1-auth"></a>
## 1. Auth

Источник: `auth/auth.controller.ts`.

| Метод | Путь                | RBAC   | Описание |
| ----- | ------------------- | ------ | -------- |
| POST  | `/api/auth/login`   | Public | Body: `LoginRequestDto` (`{ login, password }`). На успех — `Set-Cookie: sewing_session=…`, ответ `LoginResponseDto`. 401 `INVALID_CREDENTIALS` / 403 `EMPLOYEE_INACTIVE`. |
| POST  | `/api/auth/logout`  | Public | Идемпотентно затирает cookie (`Max-Age=0`), возвращает 204. |
| GET   | `/api/auth/me`      | Any auth | Возвращает `MeResponseDto` (`{ user: { id, login, fullName, role } }`). 401 `UNAUTHENTICATED`, если сессии нет. |

Side effects: `login` обновляет `Employee.lastSeenAt`-style-поля
не пишет (на MVP отдельной таблицы сессий нет, см. ADR-0014).

---

<a id="1a-me"></a>
## 1a. Me (личный кабинет)

Источник: `me/me.controller.ts`. Класс-уровень `@Controller('me')`,
доступ — любой авторизованный пользователь (в т.ч. `DISPLAY` проходит,
но UI-кнопки для этой роли скрыты, см. `apps/web/lib/rbac.ts`
`canSeeEmployeeQrButton`). Контракты — `packages/shared/src/employee-qr.ts`.

| Метод | Путь                  | RBAC     | Описание |
| ----- | --------------------- | -------- | -------- |
| GET   | `/api/me/employee-qr` | Any auth | Возвращает `EmployeeQrResponseDto` — подписанный QR-код текущего сотрудника для показа мастеру / сканирования на рабочем терминале. Payload: `{ employee: { id, name, role }, qrPayload: "SEWING_EMPLOYEE:<signedToken>", expiresAt }`. Токен HMAC-SHA256 (тот же `JWT_SECRET`, что у session-cookie), TTL = 12 часов, `type = "EMPLOYEE_QR"`, не содержит `pinHash` / `login` / `phone` / паспортных / salary-данных. 401 `UNAUTHENTICATED` без сессии; 404 `EMPLOYEE_PROFILE_NOT_FOUND`, если у авторизованного пользователя нет карточки сотрудника; 403 `EMPLOYEE_INACTIVE`, если карточка `active=false`. |
| GET   | `/api/me/workplaces` | Any auth | `MyWorkplacesDto` — участки, между которыми сотрудник может переключаться (источник списка в шторке «Сменить участок»). Строится по НАЗНАЧЕННЫМ ролям (`Employee.roles`), а не по эффективным: наследование даёт права донора, но не отдельное рабочее место. Каждая строка — `{ role, label, workspace, current, primary }`; `label`/`workspace` из справочника `AppRole` (для системных ролей — fallback `SYSTEM_ROLE_DEFAULTS`), `current` = `activeRole ?? role`. |
| POST  | `/api/me/switch-workplace` | Any auth | Смена активного участка. Body `SwitchWorkplaceDto` — ровно одно из `{ code }` (сырая строка QR рабочего места: `equipment:{id}`, голый id или `Equipment.code`) и `{ role }` (код участка из списка), плюс `force?`. Закрывает открытую смену и ставит `Employee.activeRole`; новую смену НЕ открывает (её стартует терминал обычным сканом). Ответ `SwitchWorkplaceResultDto` — `equipment*` заполнены только при скане. 400 `WORKPLACE_NO_ROLE` (у рабочего места не задана роль участка), 403 `WORKPLACE_ROLE_FORBIDDEN` (участок не назначен сотруднику), 409 `EQUIPMENT_INACTIVE`, 409 `WORKPLACE_SWITCH_CONFIRM_REQUIRED` (есть паспорт в работе — UI подтверждает и повторяет с `force: true`). |

UI-потребители: `apps/web/components/employees/employee-qr-button.tsx`
(клиентская кнопка + модалка с `qrcode.react`), server-обёртка
`apps/web/lib/employee-qr-api.ts`, action
`apps/web/app/employee-qr/actions.ts`; шторка «Сменить участок» —
`apps/web/components/workplace/switch-workplace-button.tsx` (одна на всё
приложение, рендерится в корневом layout при 2+ назначенных участках).

---

<a id="2-catalog"></a>
## 2. Catalog (sizes / products)

Источник: `catalog/catalog.controller.ts`, `sizes/sizes.controller.ts`.

| Метод | Путь            | RBAC                  | Описание |
| ----- | --------------- | --------------------- | -------- |
| GET   | `/api/sizes`    | Any auth              | Список размеров (sort by `sortOrder asc`). Response `SizeDto[]`. |
| GET   | `/api/products` | Any auth              | Список активных Product (`active = true`). Response `ProductDto[]`. |
| POST  | `/api/sizes`    | ADMIN, SHOP_MANAGER   | Создать размер. Body `CreateSizeDto` (`{ code, sortOrder? }`). Идемпотентно по `code`. Audit: `SIZE_CREATED`. |

> **Нет CRUD `Product` в API.** Создание Product производится
> неявно `OrdersService.ensureLegacyProductForPattern()`
> (см. `apps/api/src/modules/orders/orders.service.ts`); отдельных
> POST/PATCH `/api/products` контроллер не выставляет.

Связанные DTO — `packages/shared/src/orders.ts`,
`packages/shared/src/sizes.ts`.

---

<a id="3-employees"></a>
## 3. Employees

Источник: `employees/employees.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                       | RBAC               | Описание |
| ----- | -------------------------- | ------------------ | -------- |
| GET   | `/api/employees`           | SHOP_MANAGER, ADMIN | List с фильтрами `ListEmployeesQuery` (active/role/comp/search/companyDivisionId). PHASE 2 STEP 2: каждая запись отдаёт `companyDivisionId` и краткие реквизиты `companyDivision { id, code, name }` (`null` для не привязанных). |
| POST  | `/api/employees`           | SHOP_MANAGER, ADMIN | Body `CreateEmployeeDto`. Создаёт карточку, записывая обе колонки PIN разом (`pinHash` + `pinEnc`, см. «Хранение PIN» ниже). **Не-ADMIN не может завести привилегированную учётку** (`ADMIN`, `SUPERADMIN` или кастомная роль, наследующая `ADMIN`) — 403 `EMPLOYEE_ADMIN_TARGET_FORBIDDEN`. Гейт симметричен запрету выдавать эти роли в `PATCH`: без него запрет обходился бы созданием нового админа. PHASE 2 STEP 2: тело принимает опциональный `companyDivisionId`; если карточка не найдена — 404 `COMPANY_DIVISION_NOT_FOUND`, если soft-deleted — 409 `COMPANY_DIVISION_INACTIVE`. |
| GET   | `/api/employees/cutters`   | CUTTER_ASSISTANT, SHOP_MANAGER, ADMIN | Узкий справочник активных раскройщиков для select-а на форме выпуска паспорта. Hard-coded `role = CUTTER` AND `active = true`, sort `fullName ASC`. Ответ — `ActiveCutterListItemDto[]`, поля только `{ id, fullName, login }` (не отдаёт payroll-поля). См. RECON `docs/cutter-assistant-passport-release-recon.md §5`. |
| GET   | `/api/employees/:id`       | SHOP_MANAGER, ADMIN | Карточка сотрудника. PHASE 2 STEP 2: ответ включает `companyDivisionId` и краткие `companyDivision { id, code, name }` (`null` без привязки). Плюс флаг `hasStoredPin` — сработает ли «Показать пароль» (см. `reveal-pin`). |
| PATCH | `/api/employees/:id`       | SHOP_MANAGER, ADMIN | Body `UpdateEmployeeDto`. Правит management-поля. PHASE 2 STEP 2: поддерживает `companyDivisionId` (`null` — снять привязку, ID — переставить; те же 404/409, что и POST). Опциональный `pin` меняет пароль: перезаписывает `pinHash` + `pinEnc` одним апдейтом, пишет `EMPLOYEE_PIN_CHANGED` в аудит (флагом, без значения). Не-ADMIN не может сменить PIN админской учётке — 403 `EMPLOYEE_ADMIN_TARGET_FORBIDDEN`. |
| POST  | `/api/employees/:id/reveal-pin` | SHOP_MANAGER, ADMIN | Показать текущий PIN (блок «Доступ» карточки `/admin/employees/[id]`). Ответ `EmployeePinRevealDto`. Пишет `EMPLOYEE_PIN_VIEWED` в аудит — потому и `POST`, а не `GET` (кэш/префетч засорили бы журнал). Не-ADMIN не может посмотреть PIN админской учётки — 403 `EMPLOYEE_ADMIN_TARGET_FORBIDDEN`; свой собственный PIN смотреть можно всегда. 200 с `pin: null` + `reason` (`NOT_STORED` / `NO_KEY` / `DECRYPT_FAILED`) — показывать нечего, это не ошибка. |
| GET   | `/api/employees/:id/print` | Public             | HTML-этикетка с QR `EMPLOYEE:<id>`. Используется на `/master`. |
| GET   | `/api/employees/:id/qr`    | Public             | PNG QR (`EMPLOYEE:<id>`, см. `EMPLOYEE_QR_PREFIX`). |

DTO: `packages/shared/src/employees.ts`.

Side effects: `update` может менять `compensationType`,
`salaryPerShift`, `cutterB2bSewingPercent` — мгновенно влияет на
sync-логику окладной (`SalaryService.syncDailyForEmployee`) при
следующем старте/стопе смены.

**Хранение PIN.** С фичи «показать пароль сотрудника» PIN лежит в двух
колонках `Employee`:

- `pinHash` — bcrypt cost 10; **вход проверяется только по нему**
  (`AuthService.login`), колонка обязательная;
- `pinEnc` — AES-256-GCM (`v1.<base64>`, ключ из env
  `INTEGRATION_SECRET_KEY`, тот же crypto-util, что у пароля
  интеграции upgifts). Нужна ровно для `reveal-pin`.

Колонки обязаны меняться ВМЕСТЕ, иначе карточка уверенно покажет
менеджеру прежний, уже недействительный код. Единственная точка, где
пара вычисляется, — **`apps/api/src/common/pin-columns.ts`**
(`buildPinColumns`). Модуль общий, а не приватный метод сервиса,
потому что `Employee` пишут четыре независимых места:
`EmployeesService`, `DisplayScreensService` (заводит и правит
DISPLAY-учётку напрямую), `prisma/seed.ts` и
`scripts/tenants/create-tenant.ts`. Любой новый писатель `Employee`
обязан звать этот же хелпер — сторож в
`tests/smoke/employee-pin.smoke.test.ts` сплошняком сканирует
`apps/api/src`, `prisma` и `scripts` и падает на втором вызове
`bcrypt.hash` где угодно, кроме самого хелпера.

`pinEnc = null` означает «показать нечего»: карточка заведена до фичи
(бэкфилла нет и быть не может — bcrypt односторонний) либо в момент
задания PIN'а не был настроен ключ. Отсутствие ключа не мешает ни
создать сотрудника, ни сменить ему PIN — сохранится только хеш, а
`hasStoredPin` придёт `false`. Ни `pinHash`, ни `pinEnc` не уезжают ни
в одном DTO.

**RBAC привилегированных учёток.** Гейты `create` / `update`(`pin`,
роли) / `reveal-pin` / archive / restore / hard-delete ходят через
`EmployeesService.isPrivilegedTarget` — это `grantsAdmin` (ADMIN +
наследники) **плюс `SUPERADMIN`**. Отдельный предикат, а не правка
`grantsAdmin`, сознательно: тем же `grantsAdmin` считается последний
активный администратор, и если SUPERADMIN начнёт считаться «ещё одним
админом», систему разрешат оставить без единого реального ADMIN.

---

<a id="3c-app-roles"></a>
## 3c. App roles (справочник ролей)

Источник: `app-roles/app-roles.controller.ts`. Класс-уровень
`@Roles('ADMIN')`; `GET`-и расширены до `SHOP_MANAGER` (ему нужен
список ролей для селектов в карточке сотрудника).

Роль перестала быть значением Prisma-enum `Role`: с миграции
`20261001100000_app_roles_registry` роли живут в таблице `AppRole`, а
`Employee.role/roles/activeRole` — `String` с `AppRole.code`. Enum
`Role` остался только у `Equipment.role` и `Printer.role`.

Модель прав — **наследование**: роль перечисляет в `inherits` коды
ролей-доноров и получает их права целиком и транзитивно. `AuthGuard`
раскрывает набор ролей сотрудника (`AppRolesService.expand` →
`expandRoleCodes`) ДО сверки с `@Roles(...)`, поэтому все существующие
декораторы остались написаны на системных кодах и не менялись.

| Метод | Путь                      | RBAC                | Описание |
| ----- | ------------------------- | ------------------- | -------- |
| GET   | `/api/app-roles`          | SHOP_MANAGER, ADMIN | Весь справочник (активные + архив), `AppRoleDto[]` с `employeeCount`. |
| GET   | `/api/app-roles/:id`      | SHOP_MANAGER, ADMIN | Одна роль. 404 `APP_ROLE_NOT_FOUND`. |
| POST  | `/api/app-roles`          | ADMIN               | Body `CreateAppRoleDto`. 409 `APP_ROLE_CODE_TAKEN`, 400 `APP_ROLE_UNKNOWN_PARENT` / `APP_ROLE_INHERITANCE_CYCLE`. |
| PATCH | `/api/app-roles/:id`      | ADMIN               | Body `UpdateAppRoleDto`. `code` не меняется никогда; у системной роли правится только `name` — иначе 409 `APP_ROLE_SYSTEM_IMMUTABLE`. |
| POST  | `/api/app-roles/archive`  | ADMIN               | Bulk-архив (`@sewing/shared/archive`). Системные — `skipped: FORBIDDEN`. |
| POST  | `/api/app-roles/restore`  | ADMIN               | Возврат из архива. |
| POST  | `/api/app-roles/purge`    | ADMIN               | Удалить навсегда. Только из архива (`NOT_ARCHIVED`), только если роль никому не выдана и её никто не наследует (`IN_USE`). |

DTO: `packages/shared/src/app-roles.ts`. UI: `apps/web/app/admin/roles`.
Audit: `APP_ROLE_CREATE`, `APP_ROLE_UPDATE`, `APP_ROLE_ARCHIVE`,
`APP_ROLE_RESTORE`, `APP_ROLE_PURGE` (`entityType = APP_ROLE`).

Смежные эффекты:

- `GET /api/auth/me` теперь отдаёт `roles` как **эффективный** набор (с
  раскрытым наследованием), плюс `assignedRoles` (что выдано в карточке),
  `workspace`, `singleWorkspace`, `lockToWorkspace` — рабочий экран
  считает сервер, веб больше не держит свою копию матрицы «роль → экран».
- session-cookie получила поля `ws` / `lock` — по ним web-middleware
  запирает роль на её экране без обращения к БД. Токены без этих полей
  (выпущенные до миграции) обрабатываются legacy-веткой по системным
  ролям — поведение то же.
- `POST/PATCH /api/employees` больше не валидируют роль enum-ом: код
  проверяется по справочнику, неизвестный → 400 `EMPLOYEE_ROLE_UNKNOWN`.
  Архивная роль в наборе допускается (иначе правку карточки сотрудника
  заблокировало бы архивирование одной из его ролей).

---

<a id="4-equipment"></a>
## 4. Equipment

Источник: `equipment/equipment.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                              | RBAC               | Описание |
| ----- | --------------------------------- | ------------------ | -------- |
| GET   | `/api/equipment`                  | SHOP_MANAGER, ADMIN | `EquipmentSummaryDto[]`. |
| POST  | `/api/equipment`                  | SHOP_MANAGER, ADMIN | `CreateEquipmentDto`. `code` опционален — сгенерируется из `name`. |
| GET   | `/api/equipment/:id`              | SHOP_MANAGER, ADMIN | `EquipmentDetailDto`. |
| PATCH | `/api/equipment/:id`              | SHOP_MANAGER, ADMIN | Body `UpdateEquipmentDto`. Правит `name` / `displayNumber`. `code/qrCode` через PATCH не меняются. |
| PATCH | `/api/equipment/:id/operations`   | SHOP_MANAGER, ADMIN | Body `UpdateEquipmentOperationsDto`. Bulk-replace разрешённых операций (full-replace по ADR-0017). |
| GET   | `/api/equipment/:id/print`        | Public             | HTML A6-этикетка (крупно `displayNumber` + QR `equipment:{id}`). |
| GET   | `/api/equipment/:id/qr`           | Public             | PNG QR `equipment:{id}` (ADR-0008). |

DTO: `packages/shared/src/equipment.ts`. Audit: `EQUIPMENT_CREATED`,
`EQUIPMENT_UPDATED`, `EQUIPMENT_OPERATIONS_REPLACED`.

---

<a id="5-shifts"></a>
## 5. Shifts

Источник: `shifts/shifts.controller.ts`. На классе RBAC не задан —
доступ любой авторизованной роли.

| Метод | Путь                       | RBAC      | Описание |
| ----- | -------------------------- | --------- | -------- |
| POST  | `/api/shifts/start`        | Any auth  | Body `StartShiftDto` (без `employeeId` — он берётся из сессии). Открывает `ShiftSession`. Side effects: `SalaryService.syncDailyForEmployee` для `compensationType ∈ {SALARY,MIXED}`. |
| POST  | `/api/shifts/stop`         | Any auth  | Body `StopShiftDto` (пустое). Закрывает активную смену сотрудника. Side effects: `SalaryService.syncDailyForEmployee`. |
| GET   | `/api/shifts/current`      | Any auth  | Текущая активная смена. |
| GET   | `/api/shifts/current-work` | Any auth  | Список кроев, закреплённых за текущим сотрудником прямо сейчас (`Passport.currentEmployeeId = me`, `status = IN_PROGRESS`). |
| GET   | `/api/shifts/meta`         | Any auth  | Список оборудования + разрешённые операции (`allowedOperationIds` через `EquipmentOperation`, ADR-0017). |

DTO: `packages/shared/src/shifts.ts`.

---

<a id="6-operations"></a>
## 6. Operations

Источник: `operations/operations.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                  | RBAC               | Описание |
| ----- | --------------------- | ------------------ | -------- |
| GET   | `/api/operations`     | SHOP_MANAGER, ADMIN | `OperationSummaryDto[]`. |
| POST  | `/api/operations`     | SHOP_MANAGER, ADMIN | `CreateOperationDto`. Поддерживает `pricingMode` (`FIXED` / `BY_SIZE` / `SALARY_ONLY`), `timeNormMode` (`FIXED`/`BY_SIZE`), плановые `salaryPlanRubPerShift` / `salaryPlanShiftSeconds`, `producesFinishedGoods: boolean` (default `false`). |
| GET   | `/api/operations/:id` | SHOP_MANAGER, ADMIN | `OperationDetailDto`. Включает `producesFinishedGoods: boolean`. |
| PATCH | `/api/operations/:id` | SHOP_MANAGER, ADMIN | `UpdateOperationDto`. Полный full-replace по `OperationRateBySize` / `OperationTimeNormBySize` для соответствующих режимов. Поле `producesFinishedGoods` опционально — если передано, обновляется; иначе значение в БД не трогается. При включении флага последующие прохождения операции по паспорту начинают создавать `FinishedGoodsMovement PRODUCTION_RECEIPT IN` (`sourceKey = PACKED_PASSPORT:<passportId>`); уже выпущенные паспорты не пересоздаются. Мягкое удаление операции — этот же PATCH с `isActive: false`. |
| GET   | `/api/operations/:id/blockers` | SHOP_MANAGER, ADMIN | `OperationBlockersResponse`. Preflight «можно ли физически удалить»: `{ hardDeleteAllowed, blockers: [{ kind, count }] }`. Считает ссылки на операцию (`OperationEntry`, `PassportEvent`, `OrderRouteStep`, `RouteTemplateStep`, `ShiftSession`, текущая операция паспорта, `MasterCall`, `OperationSubstitution`). Конфигурация с `onDelete: Cascade` (тарифы, нормы, привязка к станкам) в блокеры не входит. |
| DELETE | `/api/operations/:id` | **ADMIN** | Физическое удаление. Метод-уровневый `@Roles('ADMIN')` переопределяет класс-уровневый. `204` при успехе; каскад снимает только конфигурацию, в `AuditLog` пишется `OPERATION_DELETED`. `409 OPERATION_IN_USE`, если есть любые ссылки (детали — `GET :id/blockers`); тогда менеджеру остаётся мягкое удаление (`PATCH { isActive: false }`). |

> Read-only `GET /api/sizes` уже отдаёт справочник для редактирования
> ставок/норм; отдельных endpoints для `OperationRateBySize` /
> `OperationTimeNormBySize` нет — они правятся через PATCH `/operations/:id`.
>
> Удаление операции — двухуровневое: мягкое (`PATCH { isActive: false }`,
> основной путь, обратимо) и физическое (`DELETE`, только `ADMIN`, только
> для нигде не использованных операций).

DTO: `packages/shared/src/operations.ts`.

---

<a id="7-routes"></a>
## 7. Routes

Источник: `routes/routes.controller.ts`. Класс RBAC не задан —
GET открыт всем авторизованным; write-методы дополнительно помечены
`@Roles('ADMIN','SHOP_MANAGER')`.

| Метод  | Путь              | RBAC               | Описание |
| ------ | ----------------- | ------------------ | -------- |
| GET    | `/api/routes`     | Any auth           | List, query `ListRouteTemplatesQuery`. |
| GET    | `/api/routes/:id` | Any auth           | `RouteTemplateDetailDto`. |
| POST   | `/api/routes`     | ADMIN, SHOP_MANAGER | `CreateRouteTemplateDto`. |
| PATCH  | `/api/routes/:id` | ADMIN, SHOP_MANAGER | `UpdateRouteTemplateDto`. Full-replace `RouteTemplateStep[]`. |
| DELETE | `/api/routes/:id` | ADMIN, SHOP_MANAGER | 204 No Content. Soft-delete или hard-delete — см. `RoutesService.remove`. |

DTO: `packages/shared/src/routes.ts`.

---

<a id="8-tech-cards"></a>
## 8. Tech-cards

Источник: `tech-cards/tech-cards.controller.ts`. Класс RBAC не задан;
write-методы — `@Roles('ADMIN','SHOP_MANAGER')`.

| Метод | Путь                                              | RBAC               | Описание |
| ----- | ------------------------------------------------- | ------------------ | -------- |
| GET   | `/api/tech-cards`                                 | Any auth           | List `ListTechCardsQuery`. |
| GET   | `/api/tech-cards/:id`                             | Any auth           | `TechCardTemplateDetailDto`. |
| POST  | `/api/tech-cards`                                 | ADMIN, SHOP_MANAGER | `CreateTechCardDto`. |
| PATCH | `/api/tech-cards/:id`                             | ADMIN, SHOP_MANAGER | `UpdateTechCardDto`. Full-replace `TechCardMaterialLine[]` / `TechCardOutsourceLine[]` (delete-all + createMany в транзакции). |
| POST  | `/api/tech-cards/:id/material-lines/:lineId/image`| ADMIN, SHOP_MANAGER | multipart `file` (JPG/JPEG/PNG). Лимит — `TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES`. |

DTO: `packages/shared/src/tech-cards.ts`. ADR: 0022.

---

<a id="9-patterns"></a>
## 9. Patterns

Источник: `patterns/patterns.controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод  | Путь                                                  | RBAC               | Описание |
| ------ | ----------------------------------------------------- | ------------------ | -------- |
| GET    | `/api/patterns`                                       | ADMIN, SHOP_MANAGER | List `ListPatternsQuery`. |
| POST   | `/api/patterns`                                       | ADMIN, SHOP_MANAGER | `CreatePatternDto`. |
| GET    | `/api/patterns/:id`                                   | ADMIN, SHOP_MANAGER | `PatternDetailDto`. |
| PATCH  | `/api/patterns/:id`                                   | ADMIN, SHOP_MANAGER | `UpdatePatternDto`. |
| POST   | `/api/patterns/:id/preview`                           | ADMIN, SHOP_MANAGER | multipart `file` (превью изображение). Лимит `PATTERN_FILE_MAX_SIZE_BYTES`. |
| POST   | `/api/patterns/:id/sizes/:sizeId/file`                | ADMIN, SHOP_MANAGER | multipart `file` (DXF). Создаёт новую версию `PatternSizeFile`. |
| DELETE | `/api/patterns/:id/sizes/:sizeId/file/:fileId`        | ADMIN, SHOP_MANAGER | Soft-archive (`PatternSizeFile.status = ARCHIVED`). Файл с диска не удаляется. |
| POST   | `/api/patterns/:id/sizes/:sizeId/file/:fileId/restore` | ADMIN, SHOP_MANAGER | Вернуть файл размера из архива (`status = ACTIVE`). |
| DELETE | `/api/patterns/:id/sizes/:sizeId/file/:fileId/permanent` | ADMIN, SHOP_MANAGER | Hard-delete архивного файла размера (запись + файл на диске). |
| PUT    | `/api/patterns/:id/material-areas`                    | ADMIN, SHOP_MANAGER | Bulk-replace `PatternMaterialArea[]`. |
| PUT    | `/api/patterns/:id/parameter-norms`                   | ADMIN, SHOP_MANAGER | Bulk-replace `PatternItemParameterNorm[]` (для `inputType = QTY_PER_ITEM`). |
| PUT    | `/api/patterns/:id/size-parameter-values`             | ADMIN, SHOP_MANAGER | Bulk-replace `PatternItemSizeParameterValue[]` (для `inputType = LINEAR_M_BY_SIZE`). |
| PUT    | `/api/patterns/:id/material-spec`                     | ADMIN, SHOP_MANAGER | Этап 1 плана «техкарты → номенклатура»: атомарный full-replace состава материалов карточки — строки `PatternItemMaterialLine[]` + слоты `PatternItemSpecParameter[]` (body `ReplacePatternItemMaterialSpecDto`, см. `@sewing/shared/pattern-item-spec`). |
| POST   | `/api/patterns/:id/clone`                             | ADMIN, SHOP_MANAGER | Body `ClonePatternDto` (опционален: `name`/`article` подбираются backend-ом). Этап «Создать номенклатуру по готовому лекалу» — см. `PatternsService.clone`. Возвращает `PatternDetailDto`. |
| DELETE | `/api/patterns/:id/permanent`                         | ADMIN, SHOP_MANAGER | Hard-delete одной архивной карточки. 409 `PATTERN_DELETE_FORBIDDEN`, если статус ≠ `ARCHIVED` или на лекало ссылаются заказы. |
| POST   | `/api/patterns/archive`                               | ADMIN, SHOP_MANAGER | Bulk soft-archive (`status = ARCHIVED`). Body `PatternsArchiveRequestDto` (`patternIds[]`), ответ `PatternsArchiveResultDto`. |
| POST   | `/api/patterns/restore`                               | ADMIN, SHOP_MANAGER | Bulk возврат из архива → `ACTIVE` (или `DRAFT`, если задача конструктора ещё не закрыта). |
| POST   | `/api/patterns/purge`                                 | ADMIN, SHOP_MANAGER | Bulk hard-delete архивных карточек. Пропускает с причиной: `NOT_FOUND` / `NOT_ARCHIVED` / `USED_BY_ORDERS` (частичный успех вместо 409). |

DTO: `packages/shared/src/patterns.ts` (`ClonePatternSchema`,
`PatternsArchiveRequestSchema`). Audit: `PATTERN_*` (`PATTERNS_ARCHIVED` /
`PATTERNS_RESTORED` / `PATTERN_DELETED`).

---

<a id="10-pattern-categories"></a>
## 10. Pattern categories

Источник: `pattern-categories/pattern-categories.controller.ts`.
Класс-уровень `@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод  | Путь                                              | RBAC               | Описание |
| ------ | ------------------------------------------------- | ------------------ | -------- |
| GET    | `/api/pattern-categories`                         | ADMIN, SHOP_MANAGER | List `ListPatternCategoriesQuery`. По умолчанию `status = ACTIVE`. |
| GET    | `/api/pattern-categories/:id`                     | ADMIN, SHOP_MANAGER | Карточка с параметрами. |
| POST   | `/api/pattern-categories`                         | ADMIN, SHOP_MANAGER | `CreatePatternCategoryDto` (включая параметры). |
| PATCH  | `/api/pattern-categories/:id`                     | ADMIN, SHOP_MANAGER | `UpdatePatternCategoryDto`. |
| PUT    | `/api/pattern-categories/:id/parameters`          | ADMIN, SHOP_MANAGER | Bulk-replace параметров (`PatternCategoryParameter[]`). |
| POST   | `/api/pattern-categories/:id/icon`                | ADMIN, SHOP_MANAGER | multipart `file` (JPG/JPEG/PNG). Лимит — `PatternCategoriesStorageService.ICON_MAX_SIZE_BYTES`. |
| GET    | `/api/pattern-categories/:id/compatible-tech-cards` | ADMIN, SHOP_MANAGER | Inline-создание изделия из формы заказа: активные техкарты с compatibility-оценкой по этой категории. Возвращает `CompatibleTechCardsResponseDto`. |
| DELETE | `/api/pattern-categories/:id`                     | ADMIN, SHOP_MANAGER | Soft-archive (`status = ARCHIVED`). |

DTO: `packages/shared/src/pattern-categories.ts`.

---

<a id="10a-constructor-tasks"></a>
## 10a. Constructor tasks

Источник: `constructor-tasks/constructor-tasks.controller.ts`. Заявки
конструктору (этап «Отправить изделие конструктору») и кабинет
конструктора (`apps/web/app/constructor/`). RBAC задаётся на методе
(класс-уровень `@Roles` не выставлен). Роль `CONSTRUCTOR` работает
только со своими задачами (`enforceOwnership = true`); ADMIN /
SHOP_MANAGER могут вмешаться в любую (отладка пилота).

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| GET   | `/api/constructor-tasks`              | ADMIN, SHOP_MANAGER | Список всех задач (админ-страница). `ConstructorTaskSummaryDto[]`. |
| GET   | `/api/constructor-tasks/my`           | CONSTRUCTOR, ADMIN, SHOP_MANAGER | Список для кабинета. Query `scope` = `mine` / `pool` / `all` (default `all`, `ConstructorTaskListScopeSchema`). `employeeId` — из сессии; без привязанного `Employee` отдаётся `pool`. |
| GET   | `/api/constructor-tasks/:id`          | ADMIN, SHOP_MANAGER, CONSTRUCTOR | Детальная карточка `ConstructorTaskDetailDto`. |
| POST  | `/api/constructor-tasks`              | ADMIN, SHOP_MANAGER | `multipart/form-data`: `payload` (JSON `SaveConstructorDraftDto`) + `files[]`. Создаёт задачу + DRAFT-pattern + material areas + файлы. Query `?createDraftOrder=true` — в той же транзакции создать DRAFT-Order и привязать pattern. Возвращает `SaveConstructorDraftResultDto`. |
| POST  | `/api/constructor-tasks/:id/cancel`   | ADMIN, SHOP_MANAGER | Отмена. Идемпотентен на `CANCELLED`; cancel `DONE` → 409 `CONSTRUCTOR_TASK_INVALID_TRANSITION`. |
| POST  | `/api/constructor-tasks/:id/assign-self` | CONSTRUCTOR, ADMIN, SHOP_MANAGER | Конструктор берёт задачу в работу. См. `ConstructorTasksService.assignSelf` (идемпотентность / переходы статуса). |
| PATCH | `/api/constructor-tasks/:id/comment`  | CONSTRUCTOR, ADMIN, SHOP_MANAGER | Body `UpdateConstructorTaskCommentSchema` (`{ comment }`). Перезаписывает комментарий задачи. |
| POST  | `/api/constructor-tasks/:id/complete` | CONSTRUCTOR, ADMIN, SHOP_MANAGER | `multipart/form-data`: `payload` (JSON `CompleteConstructorTaskDto`, маппинг `sizeId → fileFieldName`) + по файлу на размер (`file_<sizeId>`). Завершение с готовыми DXF (`status → PENDING_ACCEPT`). `AnyFilesInterceptor` (имена полей зависят от sizeId). |
| POST  | `/api/constructor-tasks/:id/accept`   | ADMIN, SHOP_MANAGER | Менеджер «Принять»: `PENDING_ACCEPT → DONE`, `PatternItem → ACTIVE`. `CONSTRUCTOR` не может принять свою работу. |
| POST  | `/api/constructor-tasks/:id/rework`   | ADMIN, SHOP_MANAGER | `multipart/form-data`: `payload` (JSON `{ comment }`, `RequestReworkConstructorTaskSchema`) + `rework_files[]`. `PENDING_ACCEPT → REWORK`; файлы сохраняются как `ConstructorTaskFile` `direction='REWORK'`. |

DTO: `@sewing/shared/constructor-tasks`
(`SaveConstructorDraftSchema`, `CompleteConstructorTaskSchema`,
`RequestReworkConstructorTaskSchema`,
`UpdateConstructorTaskCommentSchema`,
`ConstructorTaskListScopeSchema`). Доменная ошибка валидации —
`ConstructorTaskFileInvalidException`. См.
`docs/current-state.md` (роль `CONSTRUCTOR` + кабинет `/constructor`).

---

<a id="11-clients"></a>
## 11. Clients

Источник: `clients/clients.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                | RBAC               | Описание |
| ----- | ------------------- | ------------------ | -------- |
| GET   | `/api/clients`      | SHOP_MANAGER, ADMIN | List `ListClientsQuery` (по умолчанию `isActive = true`). |
| POST  | `/api/clients`      | SHOP_MANAGER, ADMIN | `CreateClientDto`. |
| GET   | `/api/clients/:id`  | SHOP_MANAGER, ADMIN | Карточка. |
| PATCH | `/api/clients/:id`  | SHOP_MANAGER, ADMIN | `UpdateClientDto` (включая `isActive` для мягкой деактивации). |

DTO: `packages/shared/src/clients.ts`. Audit: `CLIENT_*`.

---

<a id="12-suppliers"></a>
## 12. Suppliers

Источник: `suppliers/suppliers.controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

### 12.1 Поставщик

| Метод | Путь                       | RBAC               | Описание |
| ----- | -------------------------- | ------------------ | -------- |
| GET   | `/api/suppliers`           | ADMIN, SHOP_MANAGER | List `ListSuppliersQuery`. |
| GET   | `/api/suppliers/:id`       | ADMIN, SHOP_MANAGER | Карточка. |
| POST  | `/api/suppliers`           | ADMIN, SHOP_MANAGER | `CreateSupplierDto`. |
| PATCH | `/api/suppliers/:id`       | ADMIN, SHOP_MANAGER | `UpdateSupplierDto` (включая `status = INACTIVE` для мягкой деактивации). Hard-delete нет. |

### 12.2 Контакты

| Метод  | Путь                                       | RBAC               | Описание |
| ------ | ------------------------------------------ | ------------------ | -------- |
| POST   | `/api/suppliers/:id/contacts`              | ADMIN, SHOP_MANAGER | `CreateSupplierContactDto`. |
| PATCH  | `/api/suppliers/:id/contacts/:contactId`   | ADMIN, SHOP_MANAGER | `UpdateSupplierContactDto`. |
| DELETE | `/api/suppliers/:id/contacts/:contactId`   | ADMIN, SHOP_MANAGER | 204 No Content. Hard-delete контакта. |

### 12.3 Каталог

| Метод  | Путь                                          | RBAC               | Описание |
| ------ | --------------------------------------------- | ------------------ | -------- |
| GET    | `/api/suppliers/:id/catalog`                  | ADMIN, SHOP_MANAGER | List `ListSupplierCatalogQuery`. |
| POST   | `/api/suppliers/:id/catalog`                  | ADMIN, SHOP_MANAGER | `CreateSupplierCatalogItemDto`. |
| PATCH  | `/api/suppliers/:id/catalog/:itemId`          | ADMIN, SHOP_MANAGER | `UpdateSupplierCatalogItemDto`. |
| DELETE | `/api/suppliers/:id/catalog/:itemId`          | ADMIN, SHOP_MANAGER | Soft-archive (`status = INACTIVE`). Hard-delete нет. |

DTO: `packages/shared/src/suppliers.ts`. Audit: `SUPPLIER_*`.

---

<a id="13-orders"></a>
## 13. Orders

Источник: `orders/orders.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER')`. Read-роуты дополнительно помечены
`@Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT')`. (`ADMIN` глобально
проходит любой `@Roles(...)`.)

| Метод | Путь                                                                       | RBAC                                | Описание |
| ----- | -------------------------------------------------------------------------- | ----------------------------------- | -------- |
| POST  | `/api/orders`                                                              | SHOP_MANAGER (+ ADMIN)              | `CreateOrderDto`. Создаёт заказ в `DRAFT`. Тело принимает `companyDivisionId` — FK на master-справочник `CompanyDivision` (см. `docs/domain.md §«Подразделения заказа»`). Поле опциональное и nullable: если не задано, заказ создаётся без подразделения. Если карточка не найдена — 400 `COMPANY_DIVISION_NOT_FOUND`. **Этап «Склад выпуска готовой продукции»**: тело также принимает `finishedGoodsWarehouseId?: string \| null` — FK на `Warehouse` (см. `prisma/schema.prisma::Order.finishedGoodsWarehouseId`). Управленческое поле — НЕ влияет на `StockBalance` / `StockMovement` / `MaterialIssue`. На несуществующий склад — 400 `WAREHOUSE_NOT_FOUND`, на неактивный — 409 `WAREHOUSE_INACTIVE`. **Этап «Давальческое сырьё / фурнитура клиента»**: тело принимает `materialsAndHardwareCostPolicy?: 'INCLUDE' \| 'EXCLUDE'` (default `INCLUDE`). При `EXCLUDE` MATERIAL / HARDWARE не учитываются в себестоимости заказа и production cost. Расчёт потребности и складские движения работают как раньше. Side effects: при наличии `routeTemplateId` сразу синхронизирует `OrderRouteStep[]`; при наличии `techCardId` — `OrderMaterialRequirement[]`/`OrderOutsourceRequirement[]`; пересчитывает плановый snapshot операций. |
| GET   | `/api/orders`                                                              | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | List `ListOrdersQuery`. PHASE 1: каждая запись отдаёт `companyDivisionId` и краткие реквизиты `companyDivision { id, code, name }` (`null` для исторических заказов). `search` — регистронезависимый частичный OR по номеру, клиенту (`customer` + карточка), подразделению (код/название), **названию изделия** (`patternNameSnapshot` → `patternItem.name` → `items[].product.name`), количеству и дате/сроку. **Этап «Архив заказов»**: query-параметр `tab: 'active' \| 'archive'` делит список на рабочие и архивные заказы. Архив — производная от статуса (`ORDER_ARCHIVED_STATUSES`, сейчас только `CANCELLED`), отдельного поля `archivedAt` у заказа нет. Параметр опционален и без default-а: без него ручка отдаёт заказы всех статусов (на это рассчитывают дашборд `/admin` и блок «Заказы клиента»). Когда `tab` передан, ответ дополнительно содержит `tabCounts { active, archive }` — счётчики обеих вкладок под фильтрами, переживающими переключение вкладки (`search` / `clientId` / `companyDivisionId`), но БЕЗ `status` / `deadline` (они существуют только на активной вкладке). |
| GET   | `/api/orders/:id`                                                          | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | `OrderDetailDto`. Derived: `isCutReadyForOrder`, `isReadyToOrder` для outsource-строк, композитный `displayStatus`. PHASE 1: добавляет `companyDivisionId` и краткие `companyDivision { id, code, name }`. **Этап «Склад выпуска готовой продукции»**: ответ включает `finishedGoodsWarehouseId` и краткие `finishedGoodsWarehouse { id, name, code }` (`null`, если склад не выбран). **Этап «Давальческое сырьё / фурнитура клиента»**: ответ включает `materialsAndHardwareCostPolicy: 'INCLUDE' \| 'EXCLUDE'` (default `INCLUDE`). |
| PATCH | `/api/orders/:id`                                                          | SHOP_MANAGER (+ ADMIN)              | `UpdateOrderDto`. Разрешён только в `DRAFT` / `CALCULATION` (см. `ORDER_LOCKED`). Смена `companyDivisionId` — «опасное» поле под тот же ORDER_LOCKED-guard; backend проверяет существование карточки (400 `COMPANY_DIVISION_NOT_FOUND`). При смене `routeTemplateId` / `items` / `patternItemId` пересинхронизирует snapshot маршрута и план операций (см. ADR-0022). **Этап «Склад выпуска готовой продукции»**: `finishedGoodsWarehouseId` — управленческое поле, разрешено менять на любом статусе (без `ORDER_LOCKED`-guard). `null` снимает привязку, непустая строка валидируется (400 `WAREHOUSE_NOT_FOUND` / 409 `WAREHOUSE_INACTIVE`). **Этап «Давальческое сырьё / фурнитура клиента»**: `materialsAndHardwareCostPolicy` — управленческая политика учёта в себестоимости, разрешено менять на любом статусе (без `ORDER_LOCKED`-guard). `null` / пустая строка трактуется как `INCLUDE`. Складские движения и расчёт потребности по этому полю не отключаются — меняется только финансовое включение MATERIAL / HARDWARE в себестоимость и production cost. **Этап «Клиент — обязательный атрибут заказа»**: `clientId` — «безопасное» поле (замена разрешена на любом статусе, backend валидирует карточку: 404 `CLIENT_NOT_FOUND` / 400 `CLIENT_INACTIVE`), но СНЯТЬ привязку нельзя — `clientId: null` отдаёт 400 `ORDER_CLIENT_REQUIRED`. |
| GET   | `/api/orders/:id/transitions`                                              | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | `OrderTransitionDto[]` — переходы статуса из текущего состояния (по одному элементу на каждый статус, кроме текущего, включая недоступные с `reasonCode`/`reason`). Тот же массив лежит в `OrderDetailDto.availableTransitions`; отдельная ручка нужна контролу «Статус заказа» в строке списка `/admin/orders` (ленивый догруз по открытию — гейты по всем строкам сразу считать дорого). Правила — общий pure-helper `evaluateOrderTransitions` (`@sewing/shared/order-transitions`), зеркалящий гейты `startCalculation` / `start`. |
| POST  | `/api/orders/:id/start`                                                    | SHOP_MANAGER (+ ADMIN)              | Перевод `DRAFT`/`CALCULATION`/`CALCULATION_DONE` → `IN_PRODUCTION`. Defensive fallback на snapshot для legacy-заказов. |
| POST  | `/api/orders/:id/start-calculation`                                        | SHOP_MANAGER (+ ADMIN)              | `DRAFT → CALCULATION`. Side effects: вызывает `WorkshopNeedsService.calculateForOrder` (создаёт `WorkshopNeed[]`, штампует активный вариант просчёта `sentToCalculationAt`), фиксирует план операций. Фича «Варианты просчёта», итерация 3: на заказе УЖЕ в `CALCULATION` с активным вариантом-черновиком — ветка isVariantCalc «Рассчитать вариант» (те же side effects, статус заказа не меняется; audit `ORDER_CALCULATION_VARIANT_SENT`); повторная отправка отправленного варианта — 409. Ошибки: `ORDER_PATTERN_REQUIRED` (400), `ORDER_CLIENT_REQUIRED` (400 — этап «Клиент — обязательный атрибут заказа»: заказ без `clientId` из `DRAFT` не выпускаем; потребности при этом не создаются), `ORDER_TECH_CARD_REQUIRED` (400), `ORDER_ITEMS_REQUIRED` (400), `ORDER_INVALID_STATUS_TRANSITION` (409). |
| POST  | `/api/orders/:id/complete-calculation`                                     | SHOP_MANAGER (+ ADMIN)              | `CALCULATION → CALCULATION_DONE`. Body `CompleteOrderCalculationDto` (`{ usdRateRub?, comment? }`). Создаёт `OrderCostEstimate(status=COMPLETED)`, выставляет `Order.costEstimate*Snapshot`-поля. |
| POST  | `/api/orders/:id/reopen-calculation`                                       | SHOP_MANAGER (+ ADMIN)              | `CALCULATION_DONE → CALCULATION`. Body `ReopenOrderCalculationDto` (`{ reason? }`). Активный `OrderCostEstimate` помечает `REVOKED`, `Order.costEstimate*` обнуляет; `WorkshopNeed`/`PurchaseOrder`/`PurchaseReceipt` НЕ трогает. |
| POST  | `/api/orders/:id/recalculate-cost-estimate`                                | SHOP_MANAGER (+ ADMIN)              | Пересчёт себестоимости БЕЗ смены статуса заказа. Body `CompleteOrderCalculationDto`. Разрешён из `CALCULATION_DONE` / `IN_PRODUCTION` / `DONE` (фича «Правка потребности на любой стадии» — ошибку чинят и после выпуска). Текущая смета → `REVOKED`, создаётся новая версия по актуальным `WorkshopNeed` + `OrderExtraCost`; снимает `Order.costEstimateStaleAt`. Обычно не нужен: правка потребности/расхода пересчитывает смету сама, кнопка остаётся для случаев, когда автопересчёт не смог (курс USD). |
| POST  | `/api/orders/:id/operation-plan/recalculate`                               | SHOP_MANAGER (+ ADMIN)              | Ручной пересчёт snapshot-полей `Order.operationCostPlanRub` / `operationTimePlanSec` / `operationPlanWarnings`. Запрещено в `CALCULATION_DONE` / `IN_PRODUCTION` / `DONE` / `CANCELLED` (`ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`). |
| GET   | `/api/orders/:id/production-balance`                                       | SHOP_MANAGER (+ ADMIN)              | Computed-эндпоинт. Query: `strategy` (`LINE_BALANCE` / `TARGET_SHIFT` / `TOTAL_WORKERS` / `TARGET_DURATION`), `shiftSeconds`, `totalWorkers`, `targetDurationSec`. Ничего в БД не пишет. Response — DTO с рекомендацией штата по операциям. |
| POST  | `/api/orders/:id/complete`                                                 | SHOP_MANAGER (+ ADMIN)              | `IN_PRODUCTION → DONE`. |
| POST  | `/api/orders/:id/cancel`                                                   | SHOP_MANAGER (+ ADMIN)              | `DRAFT`/`IN_PRODUCTION` → `CANCELLED`. |
| POST  | `/api/orders/:id/outsource-requirements/:requirementId/status`             | SHOP_MANAGER (+ ADMIN)              | Body `UpdateOrderOutsourceRequirementStatusDto` (`{ executionStatus: 'ORDERED' \| 'RECEIVED' }`). Линейные переходы `PLANNED → ORDERED → RECEIVED`. Для `triggerType=CUT_READY` `PLANNED → ORDERED` блокируется до фактического размещения кроя (`OUTSOURCE_NOT_READY_TO_ORDER`). Идемпотентно. |
| PATCH | `/api/orders/:id/material-requirements/:requirementId/color`               | SHOP_MANAGER (+ ADMIN)              | Body `UpdateOrderMaterialRequirementColorDto` (`{ selectedColorText }`). Только для строк с `requiresColorSelection = true` (`ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED` иначе). |
| POST | `/api/orders/:id/logistics-lines`                                          | SHOP_MANAGER (+ ADMIN)              | Ручная строка логистики (кнопка «Добавить поле» в таблице «Операции»). Body `CreateOrderLogisticsLineDto` (`{ name, costRub, status?, deliveryDeadline? }`). Разрешено в любом статусе — это собственные данные заказа, не снимок. Side effect: `syncAfterNeedsChange` — строка входит в смету позицией `sourceType = LOGISTICS`, поэтому себестоимость пересчитывается либо помечается устаревшей. |
| PATCH | `/api/orders/:id/logistics-lines/:lineId`                                  | SHOP_MANAGER (+ ADMIN)              | Body `UpdateOrderLogisticsLineDto` (контракт совпадает с create — форма присылает все поля). Тот же пересчёт сметы. `ORDER_LOGISTICS_LINE_NOT_FOUND` (404). |
| DELETE | `/api/orders/:id/logistics-lines/:lineId`                                 | SHOP_MANAGER (+ ADMIN)              | Удаление строки. Деньги ушли из заказа — смета пересчитывается тем же `syncAfterNeedsChange`. |

DTO: `packages/shared/src/orders.ts`,
`packages/shared/src/order-cost-estimates.ts`,
`packages/shared/src/order-production-balance.ts`. ADR: 0006, 0009, 0022.

---

<a id="14-order-applications"></a>
## 14. Order applications

Источник: `order-applications/order-applications.controller.ts`.
Класс-уровень `@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод | Путь                              | RBAC               | Описание |
| ----- | --------------------------------- | ------------------ | -------- |
| GET   | `/api/orders/:id/applications`    | ADMIN, SHOP_MANAGER | Список `OrderApplication[]` по заказу. |
| PUT   | `/api/orders/:id/applications`    | ADMIN, SHOP_MANAGER | Body `ReplaceOrderApplicationsDto`. Full-replace (delete + createMany в транзакции). Только в `DRAFT`. |

DTO: `packages/shared/src/order-applications.ts`.

---

<a id="15-order-material-arrivals"></a>
## 15. Order material arrivals

Источник: `order-material-arrivals/order-material-arrivals.controller.ts`.
Класс-уровень `@Roles('ADMIN', 'SHOP_MANAGER', 'CUTTER', 'CUTTER_ASSISTANT')`
(GET; POST на write проверяет роль дополнительно).

| Метод | Путь                                                                    | RBAC                                | Описание |
| ----- | ----------------------------------------------------------------------- | ----------------------------------- | -------- |
| GET   | `/api/orders/:orderId/material-arrival-overrides`                       | ADMIN, SHOP_MANAGER, CUTTER, CUTTER_ASSISTANT | List `OrderMaterialArrivalOverrideDto[]` (включая `REVOKED`). |
| POST  | `/api/orders/:orderId/material-arrived`                                 | ADMIN, SHOP_MANAGER (write — режется в сервисе) | Body `CreateOrderMaterialArrivalOverrideDto`. Создаёт `OrderMaterialArrivalOverride[]` со `status = ACTIVE`. Side effects: `CutReadinessService` начинает учитывать override как «материал поступил». |
| POST  | `/api/orders/:orderId/material-arrival-overrides/:overrideId/revoke`    | ADMIN, SHOP_MANAGER (write — режется в сервисе) | Body `RevokeOrderMaterialArrivalOverrideDto` (`{ revokeReason }`). `ACTIVE → REVOKED`. |

DTO: `packages/shared/src/order-material-arrivals.ts`.

---

<a id="16-cut-readiness"></a>
## 16. Cut readiness

Источник: `cut-readiness/cut-readiness.controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER', 'CUTTER', 'CUTTER_ASSISTANT')`.

| Метод | Путь                                | RBAC                                | Описание |
| ----- | ----------------------------------- | ----------------------------------- | -------- |
| GET   | `/api/orders/:orderId/cut-readiness` | ADMIN, SHOP_MANAGER, CUTTER, CUTTER_ASSISTANT | Read-only сводка готовности к крою (см. `CutReadinessService`). Учитывает `WorkshopNeed.status`, `OrderMaterialArrivalOverride`, `OrderApplication(stage='CUT_PARTS')`. |

DTO: `packages/shared/src/cut-readiness.ts`.

---

<a id="17-cutting-closure-requests"></a>
## 17. Cutting closure requests

Источник: `cutting-closure/cutting-closure.controller.ts` +
`cutting-closure/passport-cutting-closure.controller.ts`.

| Метод | Путь                                                | RBAC                              | Описание |
| ----- | --------------------------------------------------- | --------------------------------- | -------- |
| POST  | `/api/cutting-close-requests`                       | CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Body `CreateCuttingClosureRequestDto`. Создаёт заявку (`status = REQUESTED`). Уникальность активной заявки на `(orderId, productId, sizeId)` гарантируется partial-uniq-индексом. |
| GET   | `/api/cutting-close-requests`                       | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | List `ListCuttingClosureRequestsQuery`. |
| GET   | `/api/cutting-close-requests/:id`                   | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | Карточка. |
| POST  | `/api/cutting-close-requests/:id/approve`           | SHOP_MANAGER (+ ADMIN)            | Body `ReviewCuttingClosureRequestDto`. `REQUESTED → APPROVED`. После этого `PassportsService.create` режет новые паспорта по этому размеру (`CUTTING_CLOSED`, 409). |
| POST  | `/api/cutting-close-requests/:id/reject`            | SHOP_MANAGER (+ ADMIN)            | Body `ReviewCuttingClosureRequestDto`. `REQUESTED → REJECTED`. |
| GET   | `/api/passports/:id/cutting-closure-request`        | Any auth                          | «Текущая» заявка на закрытие раскроя по той же `(orderId, productId, sizeId)`, что у паспорта. Read-only. |

DTO: `packages/shared/src/cutting-closure.ts`. ADR: 0018.

---

<a id="18-workshop-needs"></a>
## 18. Workshop needs

Источник: `workshop-needs/workshop-needs.controller.ts` +
`workshop-needs/workshop-needs.order-controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод | Путь                                              | RBAC               | Описание |
| ----- | ------------------------------------------------- | ------------------ | -------- |
| GET   | `/api/workshop-needs`                             | ADMIN, SHOP_MANAGER | List `ListWorkshopNeedsQuery`. Управленческий фильтр `orderCalculationStatus` по `Order.status`: `ACTIVE` (default без `orderId`) = `CALCULATION`, `DONE` = `CALCULATION_DONE`, `IN_PRODUCTION` = `IN_PRODUCTION` (запущенные заказы — их закупка могла остаться незакрытой), `ORDER_DONE` = `DONE` (выпущенные — сверка постфактум), `ALL` = без фильтра. Имена значений не равны `Order.status`: `DONE` здесь — завершённый расчёт, выпущенный заказ — `ORDER_DONE`. Скоуп архива — `orderArchive` (`ACTIVE`/`ARCHIVED`/`ALL`). |
| GET   | `/api/workshop-needs/:id`                         | ADMIN, SHOP_MANAGER | Карточка. |
| PATCH | `/api/workshop-needs/:id`                         | ADMIN, SHOP_MANAGER | `UpdateWorkshopNeedDto`. Закупочные поля (`purchaseQty`/`quotedPrice`/`quotedCurrency`/`expectedDeliveryDate`/`selectedSupplierId`/`selectedSupplierCatalogItemId`/`comment`) — без гейта по статусу. Фича «Правка потребности на любой стадии»: состав (`description`/`unit`/`materialRole`/`calculatedQty`) правится у ЛЮБОЙ строки, включая системную из техкарты (раньше 409 `WORKSHOP_NEED_NOT_MANUAL`), но только при статусе заказа `CALCULATION`…`DONE` (иначе 409 `ORDER_MATERIAL_CORRECTION_INVALID_STATUS`). Правка помечается `manualEditAt` (+ `calculatedQtyOriginal`) и блокирует пересчёт потребности без `force`. Любая правка сразу тянет автопересчёт себестоимости; если он невозможен — на заказе появляется `costEstimateStaleAt` + причина. |
| POST  | `/api/workshop-needs/:id/cancel`                  | ADMIN, SHOP_MANAGER | `status → CANCELLED`. Штатный способ убрать СИСТЕМНУЮ строку из потребности и себестоимости (физическое `DELETE` — только для `isManual`). Тянет автопересчёт себестоимости. |
| POST  | `/api/orders/:id/workshop-needs/calculate`        | ADMIN, SHOP_MANAGER | Body `CalculateWorkshopNeedsDto`. Пересчёт потребностей конкретного заказа. |
| GET   | `/api/orders/:id/workshop-needs`                  | ADMIN, SHOP_MANAGER | Список потребностей одного заказа (фильтр `orderCalculationStatus = ALL`). Фича «Варианты просчёта»: query `calculationScope` — default `ACTIVE` (только строки активного варианта + вне контура вариантов; так ходят производственно-финансовые таблицы карточки), `ALL` — все варианты с меткой (`orderCalculationId/Title/IsActive` в DTO; вкладка «Потребности»). |

DTO: `packages/shared/src/workshop-needs.ts`. Bulk `accept-calculated`
(«Принять теорию», см. строку выше в order-scoped роутере) скоуплен
строками АКТИВНОГО варианта просчёта.

---

<a id="19-purchase-orders"></a>
## 19. Purchase orders

Источник: `purchase-orders/purchase-orders.controller.ts` +
`purchase-orders/purchase-orders.order-controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод | Путь                                              | RBAC               | Описание |
| ----- | ------------------------------------------------- | ------------------ | -------- |
| GET   | `/api/purchase-orders`                            | ADMIN, SHOP_MANAGER | List `ListPurchaseOrdersQuery`. |
| GET   | `/api/purchase-orders/:id`                        | ADMIN, SHOP_MANAGER | Карточка. |
| POST  | `/api/purchase-orders/from-needs`                 | ADMIN, SHOP_MANAGER | 201 Created. Body `CreatePurchaseOrderFromNeedsDto`. Один PO — один поставщик; запрещено смешивать заказы покупателя. Фича «Варианты просчёта»: 409 `PURCHASE_ORDER_NEED_INACTIVE_CALCULATION`, если строка принадлежит НЕактивному варианту (закупка — только под выбранный вариант). |
| PATCH | `/api/purchase-orders/:id`                        | ADMIN, SHOP_MANAGER | `UpdatePurchaseOrderDto`. |
| PATCH | `/api/purchase-orders/:id/lines/:lineId`          | ADMIN, SHOP_MANAGER | `UpdatePurchaseOrderLineDto`. |
| POST  | `/api/purchase-orders/:id/send`                   | ADMIN, SHOP_MANAGER | `DRAFT → SENT`. Side effects: фиксирует `sentAt`, переводит активные строки в `SENT`. |
| POST  | `/api/purchase-orders/:id/confirm`                | ADMIN, SHOP_MANAGER | Body `ConfirmPurchaseOrderDto`. `SENT → CONFIRMED`. Зафиксирует `confirmedAt` и опциональные `confirmedQty/Price/DeliveryDate` в строках. |
| POST  | `/api/purchase-orders/:id/cancel`                 | ADMIN, SHOP_MANAGER | `→ CANCELLED`. Side effects: связанные `WorkshopNeed.status` могут вернуться в `PURCHASE_PLANNED`. |
| GET   | `/api/orders/:id/purchase-orders`                 | ADMIN, SHOP_MANAGER | Список PO по заказу покупателя. |

DTO: `packages/shared/src/purchase-orders.ts`.

---

<a id="20-purchase-receipts"></a>
## 20. Purchase receipts

Источник: `purchase-receipts/purchase-receipts.controller.ts` +
`purchase-receipts/purchase-receipts.purchase-order-controller.ts` +
`purchase-receipts/purchase-receipts.order-controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод | Путь                                                  | RBAC               | Описание |
| ----- | ----------------------------------------------------- | ------------------ | -------- |
| GET   | `/api/purchase-receipts`                              | ADMIN, SHOP_MANAGER | List `ListPurchaseReceiptsQuery`. |
| GET   | `/api/purchase-receipts/:id`                          | ADMIN, SHOP_MANAGER | Карточка. |
| POST  | `/api/purchase-receipts/from-purchase-order`          | ADMIN, SHOP_MANAGER | 201 Created. Body `CreatePurchaseReceiptFromPurchaseOrderDto`. Side effects: пересчёт статусов связанных `PurchaseOrderLine` и `WorkshopNeed`; для каждой строки с `workshopNeedId`/`unit`/`receivedQty > 0` в той же транзакции пишется входящий `StockMovement` (`IN`, `type = PURCHASE_RECEIPT`, `sourceKey = PURCHASE_RECEIPT_LINE:<lineId>`) и обновляется `StockBalance.qty`/средняя себестоимость (`apps/api/src/modules/stock/stock.service.ts`). |
| POST  | `/api/purchase-receipts/:id/cancel`                   | ADMIN, SHOP_MANAGER | Body `CancelPurchaseReceiptDto`. `POSTED → CANCELLED`. Side effects: пересчёт статусов PO/PO-line/WorkshopNeed обратно; для каждой строки, у которой существует исходный `IN`-`StockMovement` (`sourceKey = PURCHASE_RECEIPT_LINE:<lineId>`), пишется сторнирующий `StockMovement` (`OUT`, `type = REVERSAL`, `sourceKey = PURCHASE_RECEIPT_LINE_CANCEL:<lineId>`) и `StockBalance.qty` уменьшается. |
| GET   | `/api/purchase-orders/:id/receipts`                   | ADMIN, SHOP_MANAGER | Список PR по конкретному PO. |
| GET   | `/api/orders/:id/purchase-receipts`                   | ADMIN, SHOP_MANAGER | Список PR по заказу покупателя. |

DTO: `packages/shared/src/purchase-receipts.ts`.

Сознательные границы MVP (см. также `docs/erd.md §«2.12b»` и
`§«3.4»`):

- НЕТ FIFO/LIFO и `MaterialStockLot` — себестоимость на остатке
  считается средневзвешенной (см. `StockService.applyMovementInTx`),
  отрицательный остаток не блокируется.
- `unitCost` входящего движения = `priceSnapshot` строки приёмки при
  `currencySnapshot` в `RUB`/`null`; для других валют и для
  отсутствующего/отрицательного `priceSnapshot` — `0`. Конвертация
  валют не делается.
- `warehouseId` входящего движения берётся через `Cell.warehouseId`
  (если `cellId` пустой — `warehouseId = null`).
- Старые приёмки (созданные до подключения склада) не реверсятся
  при cancel: cancel пишет `REVERSAL` только при наличии исходного
  `IN`. Идемпотентность гарантирует UNIQUE
  `StockMovement.sourceKey`.
- `MaterialIssue.post` и `AUTO_CUT_ISSUE` **симметричны** приёмке: в
  той же транзакции пишется OUT-`StockMovement`
  (`sourceKey = MATERIAL_ISSUE_LINE:<lineId>`,
  `type = MATERIAL_ISSUE`) через
  `StockService.recordMaterialIssueInTx`, `StockBalance.qty`
  уменьшается. Поведение при нехватке остатка управляется
  hardening-флагом `CompanySettings.allowNegativeMaterialStock`
  (Boolean, default `true`, см.
  `apps/api/src/modules/company-settings/company-settings.service.ts::getAllowNegativeMaterialStock`):
  при `true` (default) минусовой `StockBalance.qty` допустим
  (включая создание no-location negative balance, если
  положительного остатка нет); при `false` `MaterialIssue.post`
  возвращает 409 `MATERIAL_STOCK_INSUFFICIENT`, транзакция
  целиком откатывается (`MaterialIssue` остаётся `DRAFT`, OUT не
  пишется, `StockBalance` не меняется). Флаг применяется ТОЛЬКО к
  OUT-движениям `MaterialIssue` (`MANUAL post` и `AUTO_CUT_ISSUE`):
  `PurchaseReceipt` cancel / REVERSAL OUT остаётся permissive —
  отмена приёмки выходит за рамки этой итерации. Публичный DTO/PATCH
  `/api/company-settings` **принимает** это поле (блок «Материалы и
  склад» в `/admin/company-settings`, см. §42 ниже); в горячем flow
  backend читает значение через приватный getter
  `CompanySettingsService.getAllowNegativeMaterialStock()`.
  Reversal/сторно для `MaterialIssue` на этой итерации также **не
  реализован** (POSTED отменить нельзя).
- Публичных REST-роутов под складские остатки в этой итерации нет
  (`StockBalance`/`StockMovement` — внутренние таблицы).

---

<a id="20a-material-issues"></a>
## 20a. Material issues

Источник: `material-issues/material-issues.controller.ts` +
`material-issues/material-issues.order-controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

Документ фактического расхода материалов по заказу. Жизненный цикл
документа: `DRAFT → POSTED` или `DRAFT → CANCELLED` (ручная
фиксация). Автосписание материалов при выдаче кроя создаёт документ
сразу в `POSTED`, минуя `DRAFT` (см. ниже «Автосписание при выдаче
кроя»).

Ответ содержит `source` (`MANUAL` | `AUTO_CUT_ISSUE`) — для
клиентов, которым важно отличать ручные документы от автоматических.
Технический ключ идемпотентности `sourceKey` в публичном API **не
отдаётся** (внутреннее поле, см. `prisma/schema.prisma::MaterialIssue.sourceKey`).

> **Этап «Давальческое сырьё / фурнитура клиента»**
> (`Order.materialsAndHardwareCostPolicy = EXCLUDE`): складские
> движения и документы расхода работают как раньше — этот флаг
> заказа НЕ меняет ни жизненный цикл `MaterialIssue`, ни
> `StockMovement`, ни `StockBalance`. Он отключает **только**
> финансовое включение MATERIAL / HARDWARE в себестоимость заказа
> (`OrderCostEstimate.totalCostRub`) и в production cost
> (`CostsService.getProductionCost.materialCost` для паспортов
> заказа = 0). См. `docs/current-state.md §«Давальческое сырьё
> клиента»`.

| Метод | Путь                                              | RBAC               | Описание |
| ----- | ------------------------------------------------- | ------------------ | -------- |
| GET   | `/api/material-issues`                            | ADMIN, SHOP_MANAGER | List `ListMaterialIssuesQuery` (фильтры `orderId`/`passportId`/`status`). Сортировка `createdAt desc`. |
| GET   | `/api/material-issues/:id`                        | ADMIN, SHOP_MANAGER | Карточка документа (с `lines`, `order`, `passport`, `workshopNeed` и `cell` по строкам). |
| POST  | `/api/material-issues`                            | ADMIN, SHOP_MANAGER | 201 Created. Body `CreateMaterialIssueDto`. Создаёт документ со `status = DRAFT`. `totalCost` считается на сервере = Σ `issuedQty × unitCost`. Если `workshopNeedId` указан, `description`/`unit`/`materialRole` берутся из `WorkshopNeed`. НЕ создаёт `StockMovement` — склад пишется только при проведении (`/post`). |
| POST  | `/api/material-issues/:id/post`                   | ADMIN, SHOP_MANAGER | `DRAFT → POSTED`. Пересчитывает `totalCost` по строкам. Side effects: для каждой `MaterialIssueLine` с `workshopNeedId`, `unit` и `issuedQty > 0` в той же транзакции пишется исходящий `StockMovement` (`OUT`, `type = MATERIAL_ISSUE`, `sourceKey = MATERIAL_ISSUE_LINE:<lineId>`) через `StockService.recordMaterialIssueInTx` и `StockBalance.qty` уменьшается. Реакция на нехватку остатка управляется флагом `CompanySettings.allowNegativeMaterialStock` (default `true` — минус допустим; `false` — 409 `MATERIAL_STOCK_INSUFFICIENT` с `details = { workshopNeedId, warehouseId, cellId, requestedQty, availableQty, unit, description }`, транзакция целиком откатывается, документ остаётся `DRAFT`, OUT не пишется, `StockBalance` не меняется). `MaterialIssue.totalCost` НЕ пересчитывается по складской стоимости. |
| POST  | `/api/material-issues/:id/cancel`                 | ADMIN, SHOP_MANAGER | Body `CancelMaterialIssueDto` (`{ reason? }`). `DRAFT → CANCELLED`. POSTED отменить нельзя — 409 `MATERIAL_ISSUE_POSTED_CANNOT_CANCEL`. Cancel DRAFT не пишет `StockMovement`. Для отката POSTED — отдельный эндпоинт `/return` (см. ниже). |
| POST  | `/api/material-issues/:id/return`                 | ADMIN, SHOP_MANAGER | Body `ReturnMaterialIssueDto` (`{ reason, clientRequestId?, lines? }`). Возврат проведённого расхода. **Два режима:** *(a)* `lines` не передан → полное сторно всего оставшегося остатка по всем строкам (legacy / backward-compat для server-to-server клиентов); *(b)* `lines = [{ materialIssueLineId, returnedQty }]` → частичный возврат только указанных `MaterialIssueLine`. Каждый `returnedQty > 0` и ≤ `availableToReturn = MaterialIssueLine.issuedQty − Σ ранее возвращённое`; дубликаты `materialIssueLineId` в одном запросе запрещены. В обоих режимах создаётся документ `MaterialIssueReturn` (status `POSTED`) + строки + `StockMovement` (`IN`, `type = REVERSAL`, `sourceKey = MATERIAL_ISSUE_RETURN_LINE:<id>`) на исходный `warehouseId/cellId` OUT-движения. Исходный `MaterialIssue` НЕ удаляется и НЕ меняет статус. Идемпотентность: `MaterialIssueReturn.sourceKey = MATERIAL_ISSUE_RETURN[_FULL]:<materialIssueId>[:<clientRequestId>]` (UNIQUE) — повторный submit с тем же `clientRequestId` возвращает существующий return. Ошибки: 409 `MATERIAL_ISSUE_RETURN_ONLY_POSTED` для не-POSTED; 409 `MATERIAL_ISSUE_ALREADY_RETURNED`, если полное сторно по уже-полностью-возвращённому документу; 409 `MATERIAL_ISSUE_RETURN_LINE_NOT_FOUND` (строка не принадлежит этому документу); 409 `MATERIAL_ISSUE_RETURN_QTY_EXCEEDS_AVAILABLE` с `details = { materialIssueLineId, requestedQty, availableQty }`; 409 `MATERIAL_ISSUE_RETURN_DUPLICATE_LINE`; 409 `MATERIAL_ISSUE_NOTHING_TO_RETURN` (для частичных запросов с пустым результатом). Финансовая стоимость возврата (`unitCost × returnedQty`) уменьшает `netTotalCost` исходного `MaterialIssue` в list/detail-DTO и в order summary. `returnStatus`: `NONE` → нет возвратов, `PARTIAL` → есть остаток, `FULL` → возвращено всё. Возврат фигурирует в `GET /api/stock/movements` как `type = REVERSAL` (`direction = IN`). `clientRequestId` ≤ 128 символов, `reason` 2..500. |
| GET   | `/api/orders/:orderId/material-issues`            | ADMIN, SHOP_MANAGER | Список документов расхода по заказу покупателя (с `lines`). Каждый элемент содержит `returnedTotalCost`, `netTotalCost`, `returnsCount`, `returnStatus` (`NONE` | `PARTIAL` | `FULL`). |

DTO: `apps/api/src/modules/material-issues/dto/*.ts`. Audit-события
(`MATERIAL_ISSUE_CREATED` / `MATERIAL_ISSUE_POSTED` /
`MATERIAL_ISSUE_CANCELLED` / `MATERIAL_ISSUE_RETURNED`) — см.
`docs/events.md §«Material issues»`.

Возвраты (`MaterialIssueReturn`) — отдельная сущность, не отменяющая
исходный расход:

- `MaterialIssue` НЕ удаляется и НЕ переводится обратно в `DRAFT`;
- `MaterialIssueReturn` всегда `status = POSTED` на MVP-итерации
  (`DRAFT`-возврата нет);
- удаление / отмена возврата не реализованы;
- **частичный возврат с произвольным qty по строкам реализован**: UI
  отправляет `lines = [{ materialIssueLineId, returnedQty }]`,
  кнопка «Заполнить всё доступное» проставляет максимумы; backend
  валидирует `returnedQty ≤ availableToReturn`, отказывает на
  дубликатах строк и на чужих `materialIssueLineId`. Несколько
  частичных возвратов на один `MaterialIssue` допускаются — каждый
  следующий считает `availableToReturn = issuedQty − Σ ранее
  возвращённое`. Полное сторно как отдельный режим оставлен для
  server-to-server клиентов: вызов без `lines` → возвращается весь
  оставшийся остаток;
- `sourceKey` возврата в публичном API **не отдаётся** (внутреннее
  поле для идемпотентности, см.
  `prisma/schema.prisma::MaterialIssueReturn.sourceKey`);
- складское IN-движение возврата типа `REVERSAL` от настройки
  `CompanySettings.allowNegativeMaterialStock` НЕ зависит — IN всегда
  разрешено (остаток только увеличивается);
- финансовая стоимость возврата = snapshot `MaterialIssueLine.unitCost`
  × `returnedQty`. Складская стоимость IN-движения берётся из
  исходного OUT-движения `MaterialIssueLine` (`StockMovement.unitCost`),
  если оно есть, иначе — снапшот из строки возврата;
- order-level фактическая стоимость материалов считается как
  `Σ MaterialIssue.totalCost − Σ MaterialIssueReturn.totalCost`
  (см. `apps/web/components/orders/summary/build-order-summary-rows.ts`);
- production cost (`/api/costs/production`, `CostsService`) использует
  ту же нетто-формулу для дня упаковки паспорта.

Автосписание при выдаче кроя
(`apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
вызывается из `PassportsService.issueToEmployee` в той же
транзакции; публичного API для ручного вызова **нет** — это
внутренний hook выдачи кроя):

- создаётся POSTED-документ с `source = AUTO_CUT_ISSUE`,
  `sourceKey = AUTO_CUT_ISSUE:<passportId>` (UNIQUE → идемпотентность
  retry);
- строки — по одной на каждую материальную `WorkshopNeed` заказа
  (исключаются `status = CANCELLED` и `sourceType = ORDER_APPLICATION`);
- `issuedQty = WorkshopNeed.calculatedQty * Passport.qtyCut /
  totalOrderQty`, где `totalOrderQty = Σ OrderItem.qtyPlan`;
- `unitCost = WorkshopNeed.quotedPrice` (RUB / null-валюта); `0`
  для USD и для отсутствующей цены;
- пустые наборы / `totalOrderQty <= 0` / уже существующий
  неотменённый `MaterialIssue` по `passportId` → skip без ошибки
  (выдача кроя продолжается);
- **side effect на склад**: сразу после создания авто-документа
  `MaterialIssuesService` вызывает
  `StockService.recordMaterialIssueInTx` в той же транзакции — для
  каждой строки пишется OUT-`StockMovement` (`type = MATERIAL_ISSUE`,
  `sourceKey = MATERIAL_ISSUE_LINE:<lineId>`,
  `comment = "Автоматическое списание при выдаче кроя"`) и
  `StockBalance.qty` уменьшается. `PassportsService` склад напрямую
  не трогает. Блокировка выдачи кроя при нехватке материала
  управляется hardening-флагом
  `CompanySettings.allowNegativeMaterialStock`: при default
  `true` минусовой `StockBalance.qty` допустим, `issueToEmployee`
  проходит; при `false` `StockService` бросает 409
  `MATERIAL_STOCK_INSUFFICIENT` и **вся транзакция выдачи кроя
  откатывается** — `Passport` не переходит в IN_PROGRESS,
  `PassportEvent ISSUED_TO_EMPLOYEE` и `AUTO_CUT_ISSUE`
  `MaterialIssue` не создаются, `StockMovement` не пишется,
  `StockBalance` не меняется. Если автосписание выключено
  (`autoIssueMaterialsOnCutRelease = false`), `allowNegativeMaterialStock`
  на `issueToEmployee` не влияет — авто-документ просто не
  создаётся.

Сознательная граница MVP:

- OUT-движение использует текущий `StockBalance.unitCost`, а не
  `MaterialIssueLine.unitCost` — документная и складская стоимость
  живут независимо. `MaterialIssue.totalCost` не пересчитывается
  по складу.
- НЕТ FIFO/LIFO и `MaterialStockLot`;
- проверка достаточности остатков опциональна и управляется
  `CompanySettings.allowNegativeMaterialStock` (default `true` —
  POSTED проходит при минусе; `false` — 409
  `MATERIAL_STOCK_INSUFFICIENT` с rollback). Strict-режим `false`
  применяется только к `MaterialIssue` OUT (ручному `post` и
  `AUTO_CUT_ISSUE`); `PurchaseReceipt` cancel / REVERSAL OUT
  остаётся permissive — отмена приёмки выходит за рамки этой
  итерации;
- UI/публичного API для управления флагом
  `allowNegativeMaterialStock` пока нет — `CompanySettings`-DTO
  не включает это поле, переключение делается прямой записью в БД
  владельцем проекта;
- POSTED-документ нельзя отменить в MVP (reversal/сторно склада
  для `MaterialIssue` — отдельная будущая итерация);
- НЕТ master-модели `Material` — описание/единица берутся из
  `WorkshopNeed` или вводятся текстом;
- конвертации валют нет — USD/без курса у документа списывается с
  `MaterialIssueLine.unitCost = 0`.

---

<a id="21-cut-release-policy"></a>
## 21. Cut release policy

Источник: `cut-release-policy/cut-release-policy.controller.ts`.
Класс-уровень `@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')`
(`ADMIN` глобально).

| Метод | Путь                                  | RBAC                              | Описание |
| ----- | ------------------------------------- | --------------------------------- | -------- |
| GET   | `/api/cut-release-policy`             | SHOPFLOOR_MASTER, SHOP_MANAGER, ADMIN | `{ policy: CutReleasePolicyDto \| null }`. |
| POST  | `/api/cut-release-policy`             | SHOPFLOOR_MASTER, SHOP_MANAGER, ADMIN | Body `CreateCutReleasePolicyDto`. В транзакции деактивирует другие активные политики. |
| PATCH | `/api/cut-release-policy/:id`         | SHOPFLOOR_MASTER, SHOP_MANAGER, ADMIN | Body `UpdateCutReleasePolicyDto`. 404 `CUT_RELEASE_POLICY_NOT_FOUND`. |
| POST  | `/api/cut-release-policy/:id/disable` | SHOPFLOOR_MASTER, SHOP_MANAGER, ADMIN | `isActive = false`. Идемпотентно. |

DTO: `@sewing/shared` (`CreateCutReleasePolicySchema`,
`UpdateCutReleasePolicySchema`, `CutReleasePolicyDto`).

---

<a id="21a-order-cut-issue-rules"></a>
## 21a. Order cut issue rules

Источник:
`order-cut-issue-rules/order-cut-issue-rules.controller.ts`. На уровне
класса `@Roles` намеренно не задан: GET доступен любой авторизованной
роли (нужно швеям/закройщикам для диагностики «почему не выдаётся
крой»), а write-эндпоинты закрыты явным `@Roles` на методе.

| Метод | Путь                                                 | RBAC                                  | Описание |
| ----- | ---------------------------------------------------- | ------------------------------------- | -------- |
| GET   | `/api/orders/:id/cut-issue-rules`                    | Any auth                              | `OrderCutIssueRulesSummaryDto` — `status` (`OFF` / `IN_PROGRESS` / `DONE`) + список строк (см. `@sewing/shared/order-cut-issue-rules`). 404 `ORDER_NOT_FOUND`, если заказ не существует. |
| POST  | `/api/orders/:id/cut-issue-rules`                    | SHOP_MANAGER, SHOPFLOOR_MASTER (+ ADMIN) | Body `BulkUpsertOrderCutIssueRulesDto` (`{ rows: [{ sizeId, requiredQty, sortOrder? }] }`). Bulk = source of truth формы карточки заказа: строки, не пришедшие в payload, переводятся в `isActive = false`. 400 `ORDER_CUT_ISSUE_RULE_SIZE_NOT_IN_ORDER`, 422 `ORDER_CUT_ISSUE_RULE_REQUIRED_BELOW_ISSUED`, 422 `ORDER_CUT_ISSUE_RULE_REQUIRED_ABOVE_PLAN`. Audit `ORDER_CUT_ISSUE_RULE_UPSERT`. |
| POST  | `/api/orders/:id/cut-issue-rules/disable-all`        | SHOP_MANAGER, SHOPFLOOR_MASTER (+ ADMIN) | Полностью отключить очередь по заказу (`isActive = false` для всех строк). Идемпотентно: если активных не было, audit-событие не пишется. Audit `ORDER_CUT_ISSUE_RULE_DISABLED`. |
| POST  | `/api/orders/:id/cut-issue-rules/queues/:queueIndex/disable` | SHOP_MANAGER, SHOPFLOOR_MASTER (+ ADMIN) | Отключить одну конкретную очередь заказа (`isActive = false` для всех её активных строк). Идемпотентно. Без body. См. `OrderCutIssueRulesService.disableQueue`. |
| DELETE| `/api/orders/:id/cut-issue-rules/queues/:queueIndex` | SHOP_MANAGER, SHOPFLOOR_MASTER (+ ADMIN) | Удалить целиком одну очередь заказа. Разрешено только если это последняя очередь и в ней `Σ issuedQty = 0`. Без body. См. `OrderCutIssueRulesService.deleteQueue`. |

Связанная ошибка `PassportsService.issueToEmployee`: 409
`ORDER_CUT_ISSUE_RULE_VIOLATION` (текст собирается
`formatOrderCutIssueRuleViolationMessage` из `@sewing/shared`,
показывается швее inline без префикса `[CODE] ` —
см. `apps/web/app/work/actions.ts::RAW_API_ERROR_CODES`). Проверка
применяется только на ПЕРВОЙ операции маршрута / категории `CUTTING`,
ДО `CutReleasePolicy`.

DTO: `@sewing/shared` (`BulkUpsertOrderCutIssueRulesSchema`,
`DisableOrderCutIssueRulesSchema`, `OrderCutIssueRuleDto`,
`OrderCutIssueRulesSummaryDto`,
`formatOrderCutIssueRuleViolationMessage`).

---

<a id="21b-cut-issue-banner"></a>
## 21b. Cut issue banner

Источник: `order-cut-issue-rules/cut-issue-banner.controller.ts`.
Отдельный контроллер от §21a: тот привязан к карточке заказа, а этот
даёт срез по всем заказам, применимым к текущей операции швеи. Доступ
— любая авторизованная роль (подсказку видят швеи, помощник
раскройщика, мастер цеха при диагностике). Никакого write-эффекта.

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| GET   | `/api/cut-issue-banner` | Any auth | Query `?operationId=<id>` (швея читает из активной смены). Возвращает `OrderCutIssueRuleBannerDto`. Без `operationId` или если операция не подходит ни под одну активную очередь — `{ applicable: false, orders: [] }` (фронт прячет баннер). |

DTO: `@sewing/shared` (`OrderCutIssueRuleBannerDto`). Обслуживается
`OrderCutIssueRulesService.getActiveBannerForOperation`.

---

<a id="21c-order-calculations"></a>
## 21c. Order calculations (варианты просчёта)

Источник: `order-calculations/order-calculations.controller.ts` (фича
`FEATURE_ORDER_CALCULATIONS`). У заказа N альтернативных расчётов;
активный = живые данные заказа, неактивные хранят JSON-снимок входов
(см. `prisma/schema.prisma::OrderCalculation`,
`@sewing/shared/order-calculations`). GET открыт любой авторизованной
роли, write — `@Roles('ADMIN','SHOP_MANAGER')` на методах. Все
write-эндпоинты возвращают свежий `OrderCalculationsDto`.

| Метод | Путь                                              | RBAC                | Описание |
| ----- | ------------------------------------------------- | ------------------- | -------- |
| GET   | `/api/orders/:id/calculations`                    | Any auth            | Ряд вкладок (`OrderCalculationsDto`: `activeId`, `canSwitch`, items c `costTotalRub`-ярлыком). Lazy-ensure: заказу без калькуляций заводится активная #0. 404 `ORDER_NOT_FOUND`. |
| POST  | `/api/orders/:id/calculations`                    | ADMIN, SHOP_MANAGER | «+ Вариант просчёта»: клон активного (старый получает снимок, новый активен, живые таблицы не меняются). Клон рождается ЧЕРНОВИКОМ (`sentToCalculationAt = null`) — его потребности считаются только явной кнопкой (см. `start-calculation`). Body `CreateOrderCalculationSchema` (`{ title? }`). 409 `ORDER_CALCULATION_LOCKED` вне DRAFT/CALCULATION. Audit `ORDER_CALCULATION_CREATED`. |
| POST  | `/api/orders/:id/calculations/:calcId/activate`   | ADMIN, SHOP_MANAGER | Переключение активного варианта: capture текущего → restore снимка → пересборка производных (`resyncColorwayDerived` без пересчёта потребностей) + оверлей route-оверрайдов. Потребности живут per вариант (`WorkshopNeed.orderCalculationId`); переключение НИЧЕГО не считает (итерация 3 «стадия per вариант»): строки варианта только ре-линкуются к пересозданным расцветкам, а вариант-черновик рассчитывается явной кнопкой (`POST /orders/:id/start-calculation`, ветка isVariantCalc — статус заказа не меняется, вариант получает `sentToCalculationAt`, audit `ORDER_CALCULATION_VARIANT_SENT`). Гейты: 409 `ORDER_CALCULATION_LOCKED` (статус), 409 `ORDER_CALCULATION_SNAPSHOT_INVALID`. No-op, если уже активен. Audit `ORDER_CALCULATION_ACTIVATED`. |
| PATCH | `/api/orders/:id/calculations/:calcId`            | ADMIN, SHOP_MANAGER | Переименование (`RenameOrderCalculationSchema`). Разрешено в любом статусе. Audit `ORDER_CALCULATION_RENAMED`. |
| DELETE| `/api/orders/:id/calculations/:calcId`            | ADMIN, SHOP_MANAGER | Удалить НЕактивный вариант. 409 `ORDER_CALCULATION_ACTIVE_DELETE_FORBIDDEN` / `ORDER_CALCULATION_LAST_DELETE_FORBIDDEN` / `ORDER_CALCULATION_LOCKED`. Audit `ORDER_CALCULATION_DELETED`. |

DTO/коды: `@sewing/shared/order-calculations`
(`OrderCalculationsDto`, `OrderCalculationSnapshotV1Schema`,
`ORDER_CALCULATION_ERROR_CODES`).

---

<a id="22-master-calls"></a>
## 22. Master calls

Источник: `master-calls/master-calls.controller.ts`.
Класс-уровень `@Roles('SEAMSTRESS', 'CUTTER', 'CUTTER_ASSISTANT', 'QC',
'IRONING', 'PACKING', 'SHOPFLOOR_MASTER', 'SHOP_MANAGER')`.

| Метод | Путь                                                 | RBAC                            | Описание |
| ----- | ---------------------------------------------------- | ------------------------------- | -------- |
| POST  | `/api/master-calls`                                  | Все рабочие роли + SHOPFLOOR_MASTER + SHOP_MANAGER (+ ADMIN) | Body `CreateMasterCallDto`. Идемпотентно по сотруднику: если уже есть `OPEN`, возвращает его. Side effects: backend подтягивает `equipmentId`/`operationId` из активной `ShiftSession`. |
| GET   | `/api/master-calls`                                  | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Список открытых вызовов. |
| POST  | `/api/master-calls/resolve-by-employee-qr`           | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `ResolveMasterCallByQrDto` (`{ qr }`). Принимает оба бейджа: `EMPLOYEE:<id>` с бумажной этикетки и `SEWING_EMPLOYEE:<token>` из «Мой QR-код» на терминале сотрудника (подпись проверяет `MeService`, протухший токен → 400 `EMPLOYEE_QR_TOKEN_INVALID`). Закрывает `OPEN`-вызов сотрудника. |
| GET   | `/api/master-calls/recently-resolved`                | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Последние закрытые вызовы для блока «Архив» на `/master`. Тот же RBAC, что у листинга открытых. |
| POST  | `/api/master-calls/:id/resolve`                      | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Ручное закрытие вызова из карточки (кнопка «Проблема решена», без QR). RBAC тот же, что у resolve-by-qr. |

DTO: `packages/shared/src/master-calls.ts`.

---

<a id="23-master-actions"></a>
## 23. Master actions

Источник: `master-actions/master-actions.controller.ts`. Класс-уровень
`@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')` (+ `ADMIN` глобально).
Все эндпоинты возвращают `MasterActionResultDto` (`{ passport, before }`)
и пишут запись в `AuditLog` (`MASTER_PASSPORT_*`).

| Метод | Путь                                                                  | RBAC                                | Описание |
| ----- | --------------------------------------------------------------------- | ----------------------------------- | -------- |
| POST  | `/api/master-actions/passports/:id/unassign`                          | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `UnassignPassportDto` (`{ reason }`). Снимает паспорт с сотрудника (`Passport.currentEmployeeId = null`). |
| POST  | `/api/master-actions/passports/:id/transfer-to-employee`              | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `TransferPassportDto` (`{ employeeId \| employeeQr, reason }`). Переназначает паспорт. UI отдаёт `employeeId` из списка кандидатов (см. `transfer-candidates`); `employeeQr` принимает оба бейджа — `EMPLOYEE:<id>` с этикетки и подписанный `SEWING_EMPLOYEE:<token>` из «Мой QR-код». |
| POST  | `/api/master-actions/passports/:id/return-to-cell`                    | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `ReturnPassportToCellDto` (`{ cellId, reason }`). Возвращает паспорт в активную ячейку. |
| POST  | `/api/master-actions/passports/:id/set-route-step`                    | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `SetRouteStepDto` (`{ index, reason }`). Назначает паспорт на конкретный шаг snapshot маршрута. |
| POST  | `/api/master-actions/find-passport-by-code`                           | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `FindMasterPassportByCodeDto` (`{ code }` — QR / номер / id). Read-only pre-step для кнопки «Сканировать паспорт» на `/master`: резолвит паспорт перед открытием `PassportActionsSheet`. Возвращает `FindMasterPassportByCodeResultDto` (НЕ `MasterActionResultDto`, audit не пишется). |
| GET   | `/api/master-actions/transfer-candidates?passportId=`                 | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Read-only. Активные сотрудники с их открытой сменой для «Передать сотруднику»: `MasterTransferCandidatesDto`. Порядок строк готов к отрисовке — смена на текущем шаге паспорта, затем смена на другой операции маршрута, затем прочие смены, затем остальные по алфавиту. Без `passportId` маршрутные пометки всегда `false`. Мастер сюда ходит потому, что `GET /api/employees` закрыт ролями `SHOP_MANAGER`/`ADMIN`. |
| POST  | `/api/master-actions/resolve-employee-qr`                             | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `ResolveEmployeeQrDto` (`{ qr }`), ответ `ResolvedEmployeeQrDto`. Read-only: отсканированный бейдж → карточка сотрудника. Принимает оба формата; подписанный `SEWING_EMPLOYEE:<token>` на клиенте не разбирается, поэтому резолв серверный. Чужой QR → 400 `INVALID_EMPLOYEE_QR`, протухшая подпись → 400 `EMPLOYEE_QR_TOKEN_INVALID`. |
| GET   | `/api/master-actions/passports/:id/self-operation-steps`              | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Read-only. Шаги снимка маршрута заказа с доступностью для взятия на себя (`available` + `blockedReason` — расчёт `PassportsService.previewOperationAvailability`, тот же гейт, что у «получить крой»), станками операции (`EquipmentOperation`) и флагом `pieceworkPaid`. Возвращает `MasterSelfOperationStepsDto`. |
| POST  | `/api/master-actions/passports/:id/self-operation`                    | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `MasterSelfOperationDto` (`{ operationId, equipmentId?, comment? }`; `reason` НЕ требуется — мастер фиксирует свою работу). Мастер выполнила операцию маршрута сама: техническая смена → `issueToEmployee` → `completeOperationByEmployee` → закрытие смены. Audit `MASTER_PASSPORT_SELF_OPERATION`. |

DTO: `packages/shared` (re-export через `@sewing/shared`).

«Выполнить операцию самой» (`self-operation`) — единственное действие
мастера, которое ДВИГАЕТ паспорт по маршруту, а не правит его атрибуты.
Своей копии правил маршрута у него нет: оба шага идут через
`PassportsService`, поэтому гейты (откат назад, параллельные группы, ОТК
перед ВТО, работа вне маршрута, подстановки операций) и начисления
работают ровно так же, как у швеи на `/work`. Смена заводится напрямую и
закрывается в `finally`, минуя `ShiftsService.start/stop`: штатный старт
синхронизирует оклад, и мастер на почасовой ставке получила бы
повременные часы за минуту работы.

---

<a id="23a-production-board"></a>
## 23a. Production board

Источник: `production-board/production-board.controller.ts`.
Класс-уровень `@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')`.
«Доска движения тиража» — вкладка «Движение тиража» в кабинете мастера
(`apps/web/app/master`). Тот же доступ, что у `/master`
(`canSeeMasterPage`). Read-only — мутаций нет.

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| GET   | `/api/master/production-board`       | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Query `ProductionBoardQuerySchema` (`?days=7|14|30`). Возвращает `ProductionBoardDto`. |
| GET   | `/api/master/production-board/drill` | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Query `ProductionBoardDrillQuerySchema` (`?cutDate&stage[&employeeId]`). Drill-down — `ProductionBoardDrillDto`. |

DTO: `@sewing/shared` (`ProductionBoardQuerySchema`,
`ProductionBoardDrillQuerySchema`, `ProductionBoardDto`,
`ProductionBoardDrillDto`). См.
`docs/current-state.md` (доска движения тиража в кабинете мастера).

---

## 23b. Master orders (заказы и маршруты в кабинете мастера)

Источник: `master-orders/master-orders.controller.ts`.
Класс-уровень `@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')`.
Вкладка «Заказы» кабинета мастера: список заказов с маршрутом и фронтом
производства. Read-only — правка маршрута идёт ручкой
`PUT /api/orders/:id/amendments/route` (см. §«Order amendments»), к
которой `SHOPFLOOR_MASTER` допущен отдельно; количество, размерность и
операции остаются менеджеру заказа.

Отдельная ручка, а не общий `GET /api/orders`: тот отдаёт управленческий
DTO (себестоимость, склад, freshness плана) и закрыт `SHOP_MANAGER`.

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| GET   | `/api/master/orders` | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Query `MasterOrdersQuerySchema` (`?tab=production|pending|done[&search=…]`). Возвращает `MasterOrdersDto`. |

DTO: `@sewing/shared/master-orders` (`MasterOrdersQuerySchema`,
`MasterOrdersDto`, `MasterOrderListItemDto`, `MasterOrderRouteStepDto`).

---

## 23c. Master employee stats (вкладка «Сотрудники»)

Источник: `master-employee-stats/master-employee-stats.controller.ts`.
Класс-уровень `@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')` —
тот же доступ, что у экрана `/master`. Три режима вкладки:
статистика, активные смены и доступы.

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| GET   | `/api/master/employee-stats`                              | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Query `MasterEmployeeStatsQuerySchema` (`?from&to`, UTC-дни включительно). `MasterEmployeeStatsDto` — «кто сколько сделал» по `PassportEvent.OPERATION_FINISHED`. |
| GET   | `/api/master/employee-stats/drill`                        | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Query `?from&to&employeeId`. `MasterEmployeeDrillDto` — разбивка по операциям и дням. |
| GET   | `/api/master/employee-stats/active-shifts`                | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | `MasterActiveShiftsDto` — открытые смены прямо сейчас, `startedAt` ASC. |
| POST  | `/api/master/employee-stats/active-shifts/:shiftId/close` | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `ForceCloseShiftSchema` (`{ force? }`). Принудительное завершение смены. Уже закрытая — успех-noop (`closed: false`); паспорта на руках без `force` — 409 `SHIFT_HAS_ACTIVE_PASSPORTS`. Аудит `MASTER_SHIFT_FORCE_CLOSED`. |
| GET   | `/api/master/employee-stats/access`                       | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | `MasterEmployeeAccessListDto` — активные сотрудники с назначенными участками. `editable = false`, если в наборе есть роль вне белого списка мастера (правит админка). |
| PUT   | `/api/master/employee-stats/access/:employeeId`           | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `MasterUpdateEmployeeAccessSchema` (`{ roles[], primaryRole }` — полная замена набора). Узкая ручка вместо `PATCH /api/employees/:id`: там же зарплата, PIN и архив, и открывать её мастеру ради ролей нельзя. Белый список — `MASTER_ASSIGNABLE_ROLES` (швея, ОТК, ВТО, упаковка, раскройщик, помощник раскройщика), проверяется на сервере с обеих сторон. Побочный эффект: `activeRole` сбрасывается, если участок выпал из набора. Ошибки: 403 `MASTER_ROLE_NOT_ASSIGNABLE`, 403 `MASTER_EMPLOYEE_NOT_EDITABLE`, 409 `MASTER_ROLE_PAIR_REDUNDANT` (CUTTER + CUTTER_ASSISTANT одному человеку: выпуск и стеллаж у раскройщика уже во вкладках кабинета). Аудит `MASTER_EMPLOYEE_ROLES_UPDATED`. |

DTO: `@sewing/shared` (`master-employee-stats.ts`).

---

<a id="24-passports"></a>
## 23a. Cutting tasks (кабинет раскройщика)

Источник: `cutting-tasks/cutting-tasks.controller.ts`.

Задача на раскрой (`CuttingTask`) рождается автоматически из
`OrdersService.start()` при запуске заказа в производство. Раскройщик
(`CUTTER`) в `/cutter` берёт её в работу, вводит раскладку по размерам
(`perLayerQty`) и настилает рулоны (`CuttingTaskRoll`: `ordinal`/`layers`),
затем завершает (`DONE`). После завершения заказ уходит помощнику
раскройщика для рулонного выпуска паспортов (см. `/api/passports/
release-from-rolls` ниже).

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| GET   | `/api/cutting-tasks`                                  | CUTTER, SHOP_MANAGER, ADMIN | Очередь кабинета раскройщика (всё, кроме `CANCELLED`). `CuttingTaskSummaryDto[]`. |
| GET   | `/api/cutting-tasks/ready-for-release`               | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER, ADMIN | Очередь выпуска (вкладка «Выпуск» кабинета раскройщика + доска помощника `/work/cut-orders`): заказы, по которым **закрыт хотя бы один расклад** (`CuttingTaskLay.completedAt`), а не только с `CuttingTask = DONE`. `OrderReadyForReleaseDto[]`: счётчик `releasedPassports/totalPassports` (единица — ПАСПОРТ: одна тройка «расклад × размер × рулон» = один паспорт), `laysClosed/laysTotal`, `cuttingInProgress` и `status`: `NEW` (есть невыпущенное по закрытым раскладам) / `WAITING` (по закрытым выпущено всё, раскрой продолжается) / `DONE` (раскрой завершён и выпущено всё). Считается только по закрытым раскладам — открытый ещё может измениться. |
| GET   | `/api/cutting-tasks/by-order/:orderId/release-state` | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER, ADMIN | Данные заказа для рулонного выпуска: размеры (с `perLayerQty` «на настиле»), рулоны, `completedAt` каждого расклада (открытый = выпуск по нему запрещён, UI рисует «настилается») и карта уже выпущенных троек `(расклад, размер, рулон)`. `OrderReleaseStateDto`. 404 `CUTTING_TASK_NOT_FOUND`. |
| GET   | `/api/cutting-tasks/:id`                             | CUTTER, SHOP_MANAGER, ADMIN | Карточка задачи. `CuttingTaskDetailDto`. |
| POST  | `/api/cutting-tasks/:id/start`                       | CUTTER, SHOP_MANAGER, ADMIN | «Принять задание»: `NEW → IN_PROGRESS`, фиксирует `assignedToId`/`startedAt`. Идемпотентно. |
| PATCH | `/api/cutting-tasks/:id`                             | CUTTER, SHOP_MANAGER, ADMIN | Автосохранение прогресса: `SaveCuttingTaskProgressDto`. **Merge по `ordinal`, не replace**: элемент с `ordinal` существующего расклада обновляет его; без `ordinal` — новый расклад с номером `max + 1` (append-only, номера не переиспользуются); открытый расклад, которого нет в payload, удаляется. ЗАКРЫТЫЙ расклад неприкосновенен — попытка изменить/удалить даёт 409 `CUTTING_LAY_LOCKED` (его номер записан в `Passport.cuttingLayOrdinal` выпущенных паспортов). Требует `IN_PROGRESS`. |
| POST  | `/api/cutting-tasks/:id/lays/:ordinal/complete`      | CUTTER, SHOP_MANAGER, ADMIN | «Расклад готов» — частичное завершение раскроя: закрывает ОДИН расклад, задача остаётся `IN_PROGRESS`. По закрытому раскладу сразу разрешён выпуск паспортов, пока остальные настилаются. Идемпотентно. Гейт заполненности — `listLayCompletionProblems` (те же формулировки, что у завершения всего раскроя). Ошибки: 404 `CUTTING_LAY_NOT_FOUND`, 409 `CUTTING_TASK_NOT_IN_PROGRESS`, 400 `CUTTING_LAY_COMPLETION_INCOMPLETE`. |
| POST  | `/api/cutting-tasks/:id/lays/:ordinal/reopen`        | CUTTER, SHOP_MANAGER, ADMIN | «Открыть расклад» — снять закрытие, чтобы поправить настил или удалить лишний расклад. **Свежие паспорта расклада при этом удаляются** (в той же транзакции, с `AuditLog` `PASSPORT_DELETED` + `reason: CUTTING_LAY_REOPENED`): настил меняется, а паспорт несёт его снимок (`qtyCut`, «Расклад N · Рулон M»). «Свежий» = условие самостоятельного удаления паспорта автором (`CREATED`, без ячейки, без событий кроме `CREATED`, не в коробке, без POSTED-списания); каскадом уходят и сдельные начисления за выпуск. Если хоть один паспорт УЖЕ ушёл в работу — 409 `CUTTING_LAY_HAS_PASSPORTS` с их номерами, расклад остаётся закрытым (отменяет мастер). Авторство паспортов не проверяется: печатать мог помощник, а настил — зона раскройщика. Если задача была `DONE`, возвращается в `IN_PROGRESS`. Идемпотентно. Ошибки: 404 `CUTTING_LAY_NOT_FOUND`. |
| POST  | `/api/cutting-tasks/:id/complete`                    | CUTTER, SHOP_MANAGER, ADMIN | «Раскрой завершён»: финальное сохранение, закрытие ВСЕХ ещё открытых раскладов + `IN_PROGRESS → DONE` (`completedAt`). Паспорта не трогаются — выпуск мог уже частично пройти по закрытым раскладам. |

## 24. Passports

Источник: `passports/passports.controller.ts` +
`passports/order-passports.controller.ts`.

| Метод | Путь                                          | RBAC                                  | Описание |
| ----- | --------------------------------------------- | ------------------------------------- | -------- |
| POST  | `/api/passports`                              | CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Ручной выпуск паспорта. Body `CreatePassportDto`. В одной транзакции: создаёт паспорт, фиксирует `PassportEvent(CREATED)`, генерирует `OperationEntry(IMMEDIATE)` для раскройщика (ADR-0005). Требуется явная атрибуция раскройщика: `cutterId` обязателен (`CUTTER_REQUIRED`). **Роль `CUTTER` исключена** — раскройщик паспорта больше не выпускает (только раскрой в `/cutter`); выпуск ведёт помощник, преимущественно через рулонный `release-from-rolls` ниже. Ошибки: 400 `CUTTER_REQUIRED`, 404 `CUTTER_NOT_FOUND`, 409 `CUTTER_INACTIVE`, 409 `CUTTING_CLOSED`. |
| POST  | `/api/passports/release-from-rolls`           | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER, ADMIN | Рулонный выпуск паспортов (помощник раскройщика или сам раскройщик — в цехах без помощника). Body `ReleaseFromRollsDto` (`{ orderId, layOrdinal, sizeId, cutDate, rollOrdinals[] }`). Количество и номер рулона берутся из расклада задачи раскроя: на каждый рулон создаётся паспорт с `qtyCut = CuttingTaskRoll.layers × CuttingTaskLaySize.perLayerQty` (раскладка **в этом раскладе**) и `rollOrdinal = ordinal`. Сдельное за раскрой всегда идёт `CuttingTask.assignedToId` — независимо от того, кто нажал кнопку. **Гейт готовности — по РАСКЛАДУ**: достаточно `CuttingTaskLay.completedAt` («Расклад готов»), задача может быть ещё `IN_PROGRESS`; для задач, завершённых до появления частичного завершения (у их раскладов `completedAt` пустой), работает фолбэк `CuttingTask.status = DONE`. Идемпотентно: тройки `(расклад, размер, рулон)`, уже выпущенные, пропускаются (`skipped`) — кейс «сломался принтер, продолжить с рулона». Возвращает `ReleaseFromRollsResultDto` (`{ created[], skipped[], overCut }`). Перекрой плана размера **не блокирует** выпуск — печать идёт, превышение отдаётся в `overCut` как уведомление. Инварианты: заказ `IN_PRODUCTION`, closure-блок (ADR-0018). Ошибки: 400 `CUTTING_TASK_NOT_FOUND` / `CUTTING_LAY_NOT_FOUND` / `CUTTING_LAY_NOT_DONE` / `CUTTING_ROLL_NOT_FOUND`, 400 `CUTTER_REQUIRED` (нет `assignedToId`), 409 `CUTTING_CLOSED`. |
| GET   | `/api/passports/my-recent`                    | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Список последних 100 паспортов, выпущенных самим actor-ом (`creatorId === me.employeeId`). Источник «Выпущенные паспорта» помощника раскройщика (`/work/passports`). Возвращает `MyPassportListItem[]` с пред-вычисленным `editable`/`editableBlockReason` — UI гасит «Редактировать»/«Удалить» на двинувшихся паспортах. |
| GET   | `/api/passports/:id`                          | Any auth                              | Карточка паспорта. |
| GET   | `/api/passports/:id/history`                  | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Хронологический список `PassportEvent` для экрана `/master` (кнопка «Посмотреть историю паспорта» в `PassportActionsSheet`). Возвращает `PassportHistoryDto` (см. `@sewing/shared` → `passports.ts`): массив `events`, отсортирован `createdAt asc`, с подтянутыми именами `operation`/`employee`/`cell`/`fromOperation`. Поле `manual=true` помечает события с id-префиксом `man_*` — записи, созданные ручной правкой админа (см. инциденты 12.05.2026). Ошибки: 404 `PASSPORT_NOT_FOUND`, 403 для других ролей. |
| PATCH | `/api/passports/:id`                          | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Body `UpdatePassportDto` (любая комбинация `sizeId` / `cutDate` / `qtyCut` / `rollNumber` / `cutterId`). В одной транзакции: чистит immediate-начисление раскройщика (`sourceEventType=PASSPORT_CREATED`), обновляет поля паспорта, переписывает `PassportEvent(CREATED)` и пересоздаёт начисление через `EarningsService.createImmediateForCutter` (новый размер/количество/раскройщик). Ошибки: 403 `PASSPORT_NOT_YOURS_TO_EDIT` (для не-менеджерской роли, чужой паспорт), 409 `PASSPORT_NOT_EDITABLE` (status≠CREATED, есть ячейка, есть события кроме CREATED), 422 `QTY_EXCEEDS_REMAINING_PLAN` / 400 `SIZE_NOT_IN_ORDER` / 404 `CUTTER_NOT_FOUND` / 409 `CUTTER_INACTIVE` / 409 `CUTTING_CLOSED`. |
| DELETE| `/api/passports/:id`                          | CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Удаление паспорта. 204 No Content. Для CUTTER_ASSISTANT/CUTTER — self-cancel: только свой паспорт (`creatorId === me`), только пока `editable = true` (status=CREATED, без ячейки, без событий кроме CREATED); APPROVED-блокер не применяется (immediate-начисление раскройщика каскадно сносится — работы по выпуску не случилось). Для SHOP_MANAGER/ADMIN — управленческое удаление с строгими блокерами: 409 `PASSPORT_HAS_BOX`, 409 `PASSPORT_HAS_APPROVED_EARNINGS`, 409 `PASSPORT_HAS_POSTED_MATERIAL_ISSUE`. В транзакции чистит `PassportEvent`, `OperationEntry`, `PassportDefect`, удаляет сам `Passport`, пишет `AuditLog(PASSPORT_DELETED, payload.actorRole)`. `MaterialIssue.passportId` обнуляется автоматически (`onDelete: SetNull`). См. `docs/domain.md §7.8 «Удаление паспорта»` и §7.8a «Редактирование паспорта». |
| POST  | `/api/passports/:id/place`                    | CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Body `PlacePassportDto` (`{ cellId }`). Размещает в ячейке (`currentCellId`), пишет `PassportEvent(CELL_PLACED)`. |
| POST  | `/api/passports/:id/issue`                    | Any auth                              | Body `IssuePassportDto` (бизнес-поля; `employeeId` берётся из сессии). Швея «получает крой»: снимает с ячейки, выставляет `currentEmployeeId = me`, `status = IN_PROGRESS`, `PassportEvent(ISSUED_TO_EMPLOYEE)`. Учитывает `CutReleasePolicy`. |
| POST  | `/api/passports/:id/scan`                     | Any auth                              | Body `ScanPassportDto` (employee — из сессии). Любой скан = переход на `session.operationId`. Side effects: для предыдущей операции пишет `OperationEntry(PENDING_RELEASE)` (для пошива) и `PassportEvent(OPERATION_SCAN)`. Делает `QC-gate` для `IRONING` (`WTO_PASSED` обязателен). |
| POST  | `/api/passports/:id/complete-operation`       | Any auth                              | Body `CompleteOperationDto` (пустое). Завершает текущую операцию владельца (`currentEmployeeId = me`, `status = IN_PROGRESS`). |
| POST  | `/api/passports/batch/complete-operations`    | Any auth                              | Body `BatchCompleteOperationsDto` (`{ passportIds: string[] }`). Пакетное завершение операций швеи разом по нескольким своим паспортам (UX «Завершить выбранные» в «Текущий крой»). Каждый паспорт — отдельная транзакция через `completeOperationByEmployee`; партиальный успех → `{ completed, failed }` (см. F4b). |
| POST  | `/api/passports/by-code`                      | Any auth                              | Body `{ code }` (QR `passport:{id}`, номер `P-…`, или голый id). Резолв без побочных эффектов. Возвращает паспорт + `routeHint.routeMismatchWithActiveShift` (read-only подсказка). |
| GET   | `/api/passports/:id/print`                    | Public                                | HTML A6 печатная форма + QR `passport:{id}`. Используется принтер-станцией (ADR-0010). |
| GET   | `/api/passports/:id/qr`                       | Public                                | PNG QR `passport:{id}` (ADR-0008). |
| GET   | `/api/orders/:id/passports`                   | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | Список паспортов одного заказа. |

DTO: `packages/shared/src/passports.ts`,
`packages/shared/src/shifts.ts`. ADR: 0005, 0008, 0010, 0012, 0014.

<a id="24a-cutter-attribution"></a>
### 24a. Cutter attribution (PHASE 2 STEP 3)

`POST /api/passports` теперь требует **явной атрибуции раскройщика** —
старый fallback по seed-учётке `Employee.login = 'cutter'` удалён
(он давал ложные начисления при любом несовпадении логина и рушил
payroll).

`CreatePassportSchema` (см. `packages/shared/src/passports.ts`)
расширен необязательным полем:

```ts
cutterId: z.string().min(1, 'cutterId обязателен').optional()
```

Алгоритм `PassportsService.create`:

1. `dto.cutterId` указан явно → ищем в БД, требуем
   `role = CUTTER && active = true`. Иначе:
   - сотрудник не найден / не CUTTER → `400 CUTTER_NOT_FOUND`;
   - сотрудник CUTTER, но `active = false` → `400 CUTTER_INACTIVE`.
2. `dto.cutterId` не указан, но `creator.role = CUTTER` → атрибуция
   creator-у (рабочее место раскройщика, исторический happy-path).
3. `dto.cutterId` не указан, и creator — НЕ CUTTER (CUTTER_ASSISTANT
   / SHOP_MANAGER / ADMIN) → `400 CUTTER_REQUIRED`. UI обязан
   показать select раскройщика для этих ролей (см.
   `docs/screens.md §«Новый паспорт»`).

Тесты атрибуции — `tests/integration/cutter-attribution.test.ts`
(все 6 веток выше: happy-path для CUTTER, обязательность для
не-CUTTER, явный `cutterId` идёт в начисление, ошибки
`CUTTER_NOT_FOUND` / `CUTTER_INACTIVE`, регрессия на legacy
`login=cutter` fallback).

---

<a id="24b-order-samples"></a>
## 24b. Order samples (Сигнальный образец)

Источник: `order-samples/order-samples.controller.ts`. MVP, см.
`docs/order-signal-sample-flow.md`,
`docs/order-signal-sample-recon.md`.

Подресурс заказа: запуск sample, его согласование / отклонение /
отмена. Sample-passport создаётся стандартным
`PassportsService.create` (со всеми side-effects), затем `sampleId`
проставляется в той же `prisma.$transaction`, что и `OrderSample`.

| Метод | Путь | RBAC | Описание |
| --- | --- | --- | --- |
| POST | `/api/orders/:orderId/samples/start` | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | Body `StartOrderSampleDto`. Создаёт `OrderSample(IN_PROGRESS)` + sample-passport (`Passport.sampleId = OrderSample.id`). Валидация: размер из заказа (400 `ORDER_SAMPLE_SIZE_NOT_IN_ORDER`); если `countsTowardOrderQty = true` и `qty > qtyPlan` (400 `ORDER_SAMPLE_QTY_EXCEEDS_ORDER_SIZE_QTY`); активный sample на пару (productId, sizeId) даёт 409 `ORDER_SAMPLE_ALREADY_ACTIVE`; заказ DONE/CANCELLED → 409 `ORDER_SAMPLE_ORDER_INVALID_STATUS`. Audit `ORDER_SAMPLE_STARTED`. |
| GET  | `/api/orders/:orderId/samples` | SHOP_MANAGER, CUTTER_ASSISTANT, CUTTER, SHOPFLOOR_MASTER (+ ADMIN) | Список образцов заказа (`OrderSampleListItemDto[]`) + `bulkEffect`. |
| GET  | `/api/order-samples/:id` | SHOP_MANAGER, CUTTER_ASSISTANT, CUTTER, SHOPFLOOR_MASTER (+ ADMIN) | Карточка `OrderSampleDto`. |
| POST | `/api/order-samples/:id/approve` | SHOP_MANAGER (+ ADMIN) | Body `ApproveOrderSampleDto` (`{ comment? }`). Только `IN_PROGRESS → APPROVED`, иначе 409 `ORDER_SAMPLE_INVALID_STATUS`. Audit `ORDER_SAMPLE_APPROVED`. Эффект на тираж — derived в DTO (`bulkEffect.remainingQty`); `OrderItem.qtyPlan` не мутируется. |
| POST | `/api/order-samples/:id/reject` | SHOP_MANAGER (+ ADMIN) | Body `RejectOrderSampleDto` (`{ reason }`). 400 `ORDER_SAMPLE_REJECTION_REASON_REQUIRED` если пусто. Audit `ORDER_SAMPLE_REJECTED`. Sample-passport не удаляется. |
| POST | `/api/order-samples/:id/cancel` | SHOP_MANAGER (+ ADMIN) | Body `CancelOrderSampleDto` (`{ comment? }`). Audit `ORDER_SAMPLE_CANCELLED`. Sample-passport не удаляется. |

> **Парсер `docs:check`.** Файл `order-samples.controller.ts` содержит
> два `@Controller`-класса (`orders` и `order-samples`), а
> `scripts/docs/check-docs.mjs` берёт только первый `@Controller`-префикс
> на файл. Поэтому он резолвит `:id/approve` / `:id/reject` /
> `:id/cancel` как `/api/orders/:id/approve` / `/api/orders/:id/reject` /
> `/api/orders/:id/cancel`. **Реальные роуты —**
> `/api/order-samples/:id/approve`, `/api/order-samples/:id/reject` (см.
> таблицу выше); алиасы перечислены здесь только чтобы `docs:check`
> совпал по строке и оставался зелёным.

DTO: `packages/shared/src/order-samples.ts`. Доменные коды ошибок —
`ORDER_SAMPLE_*` (см. `apps/api/src/common/errors.ts`).

---

<a id="25-cells"></a>
## 25. Cells

Источник: `passports/cells.controller.ts`.

| Метод | Путь                          | RBAC               | Описание |
| ----- | ----------------------------- | ------------------ | -------- |
| GET   | `/api/cells`                  | Any auth           | Список ячеек (read-only). |
| GET   | `/api/cells/:id`              | Any auth           | Карточка ячейки. |
| POST  | `/api/cells/by-code`          | Any auth           | Body `{ code }` (QR `cell:{id}`, человекочитаемый `code`, или голый id). Резолв без побочных эффектов. |
| PATCH | `/api/cells/:id`              | SHOP_MANAGER, ADMIN | Body `UpdateCellDto`. На MVP правит только `warehouseId` (см. `WarehousesService.setCellWarehouse`). |
| GET   | `/api/cells/:id/print`        | Public             | HTML A6 этикетка ячейки. |
| GET   | `/api/cells/:id/qr`           | Public             | PNG QR `cell:{id}` (ADR-0008). |

DTO: `packages/shared/src/warehouses.ts` (`UpdateCellSchema`).

---

<a id="26-warehouses"></a>
## 26. Warehouses

Источник: `warehouses/warehouses.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                                  | RBAC               | Описание |
| ----- | ------------------------------------- | ------------------ | -------- |
| GET   | `/api/warehouses`                     | SHOP_MANAGER, ADMIN | `WarehouseSummaryDto[]`. |
| POST  | `/api/warehouses`                     | SHOP_MANAGER, ADMIN | `CreateWarehouseDto`. |
| GET   | `/api/warehouses/:id`                 | SHOP_MANAGER, ADMIN | `WarehouseDetailDto`. |
| PATCH | `/api/warehouses/:id`                 | SHOP_MANAGER, ADMIN | `UpdateWarehouseDto`. |
| POST  | `/api/warehouses/:id/lines`           | SHOP_MANAGER, ADMIN | Body `CreateWarehouseLineDto` (`{ code, count }`). Массово создаёт ячейки `${code}1..${code}N`, привязывает к складу и линии. |
| POST  | `/api/warehouses/:id/print-cells`     | SHOP_MANAGER, ADMIN | Body `PrintWarehouseCellsDto` (`{ printerId, copies?, labelSize }`). Создаёт `cellsCount × copies` PENDING-job-ов с `sourceType=CELL_LABEL`. Ошибки: 404 `WAREHOUSE_NOT_FOUND` / `PRINTER_NOT_FOUND`, 409 `PRINTER_INACTIVE` / `WAREHOUSE_NO_CELLS_TO_PRINT`. |
| POST  | `/api/warehouses/:id/lines/:lineId/print-cells` | SHOP_MANAGER, ADMIN | Per-line вариант `print-cells` (те же поля body / сводка в ответе). Ошибки: 404 `WAREHOUSE_NOT_FOUND` / `WAREHOUSE_LINE_NOT_FOUND` / `PRINTER_NOT_FOUND`, 409 `PRINTER_INACTIVE` / `WAREHOUSE_LINE_NO_CELLS_TO_PRINT`. |
| DELETE| `/api/warehouses/:id/lines/:lineId`   | SHOP_MANAGER, ADMIN | Удаляет линию и все её ячейки — только если ни в одной ячейке нет содержимого / паспортов / событий / ненулевого остатка. 204 No Content. Ошибки: 404 `WAREHOUSE_NOT_FOUND` / `WAREHOUSE_LINE_NOT_FOUND`, 409 `WAREHOUSE_LINE_HAS_CONTENT` (со списком занятых кодов). |

DTO: `packages/shared/src/warehouses.ts`. ADR: 0019.

---

<a id="26a-stock"></a>
## 26a. Stock

Источник: `stock/stock.controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

API для просмотра остатков, журнала движений, ручной корректировки и
перемещения остатка foundation складского учёта (см.
`apps/api/src/modules/stock/stock.service.ts`,
`prisma/schema.prisma::StockBalance` / `StockMovement`,
`docs/current-state.md §«Foundation складского учёта материалов»`).
GET-эндпоинты остаются read-only. Mutation-эндпоинтов два: ручная
корректировка (`POST /api/stock/adjustments`) и перемещение
(`POST /api/stock/transfers`). Остальные движения по-прежнему
пишутся неявно, в той же транзакции, что и бизнес-документ:
`PurchaseReceipt` (POSTED → IN, cancel → REVERSAL OUT) и
`MaterialIssue` (POSTED → OUT, в т.ч. `AUTO_CUT_ISSUE`).

| Метод | Путь                       | RBAC               | Описание |
| ----- | -------------------------- | ------------------ | -------- |
| GET   | `/api/stock/balances`      | ADMIN, SHOP_MANAGER | Список текущих остатков `StockBalance`. Сортировка `updatedAt desc, description asc`. |
| GET   | `/api/stock/movements`     | ADMIN, SHOP_MANAGER | Журнал движений `StockMovement`. Сортировка `createdAt desc`. |
| POST  | `/api/stock/adjustments`   | ADMIN, SHOP_MANAGER | Ручная корректировка остатка — создаёт `StockMovement` `type = ADJUSTMENT`. |
| POST  | `/api/stock/transfers`     | ADMIN, SHOP_MANAGER | Перемещение остатка между складами / ячейками — создаёт пару `StockMovement` `type = TRANSFER` (`OUT` + `IN`). |

DTO query: `apps/api/src/modules/stock/dto/list-stock-balances.dto.ts`,
`apps/api/src/modules/stock/dto/list-stock-movements.dto.ts`.
Ответ обоих эндпоинтов:

```ts
{ items: T[]; total: number; limit: number; offset: number }
```

Pagination — общий контракт: `limit` default `50`, max `200`, > 0;
`offset` default `0`, ≥ 0. Все `Decimal`-поля сериализуются строкой
(`qty`, `unitCost`, `totalCost`, `balanceBeforeQty`, `balanceAfterQty`),
`Date` — ISO-строкой (`createdAt`, `updatedAt`, `lastMovementAt`).

### 26a.1 `GET /api/stock/balances`

Query (все опциональны, склеиваются по AND):

| Параметр         | Тип      | Описание |
| ---------------- | -------- | -------- |
| `workshopNeedId` | string   | Точечный фильтр по идентичности материала. |
| `orderId`        | string   | Через relation `workshopNeed.orderId`. |
| `warehouseId`    | string   | Точечный фильтр. |
| `cellId`         | string   | Точечный фильтр. |
| `materialRole`   | string   | Например `MAIN_FABRIC` / `LINING`. |
| `unit`           | string   | Точное совпадение единицы измерения. |
| `q`              | string   | Case-insensitive substring по `description` остатка и `WorkshopNeed.description` / `sourceName`. |
| `positiveOnly`   | boolean  | `qty > 0`. |
| `negativeOnly`   | boolean  | `qty < 0`. |
| `zeroOnly`       | boolean  | `qty = 0`. |
| `limit`          | number   | 1..200, default 50. |
| `offset`         | number   | ≥ 0, default 0. |

`positiveOnly` / `negativeOnly` / `zeroOnly` — взаимоисключающие.
Передача больше одного флага одновременно отдаёт 400 `VALIDATION_ERROR`
(сообщение «Фильтры positiveOnly / negativeOnly / zeroOnly
взаимоисключающие — выберите один»).

Каждый item:

```ts
{
  id: string;
  balanceKey: string;
  workshopNeedId: string;
  orderId: string | null;
  orderNumber: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  description: string;
  materialRole: string | null;
  unit: string;
  qty: string;          // Decimal
  unitCost: string;     // Decimal
  totalCost: string;    // Decimal
  lastMovementAt: string | null; // ISO
  updatedAt: string;             // ISO
}
```

### 26a.2 `GET /api/stock/movements`

Query (все опциональны, склеиваются по AND):

| Параметр                | Тип      | Описание |
| ----------------------- | -------- | -------- |
| `workshopNeedId`        | string   | |
| `orderId`               | string   | Через relation `workshopNeed.orderId`. |
| `stockBalanceId`        | string   | |
| `warehouseId`           | string   | |
| `cellId`                | string   | |
| `type`                  | string   | `PURCHASE_RECEIPT \| MATERIAL_ISSUE \| ADJUSTMENT \| REVERSAL \| TRANSFER`. |
| `direction`             | string   | `IN \| OUT`. |
| `sourceType`            | string   | Внешний классификатор источника (например, `PURCHASE_RECEIPT_LINE`). |
| `sourceId`              | string   | id строки источника. |
| `purchaseReceiptId`     | string   | |
| `purchaseReceiptLineId` | string   | |
| `materialIssueId`       | string   | |
| `materialIssueLineId`   | string   | |
| `from`                  | ISO date | `createdAt >= from`. |
| `to`                    | ISO date | `createdAt <= to`. |
| `q`                     | string   | Case-insensitive substring по `comment`. |
| `limit`                 | number   | 1..200, default 50. |
| `offset`                | number   | ≥ 0, default 0. |

Каждый item:

```ts
{
  id: string;
  stockBalanceId: string | null;
  workshopNeedId: string;
  orderId: string | null;
  orderNumber: string | null;
  // Управленческая привязка к карточке клиента (Order.client → Client).
  // Read-only — UI журнала движений отображает в колонке «Заказчик».
  clientId: string | null;
  clientName: string | null;
  type: string;
  direction: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: string;            // Decimal
  unit: string;
  unitCost: string;       // Decimal
  totalCost: string;      // Decimal
  balanceBeforeQty: string | null; // Decimal
  balanceAfterQty: string | null;  // Decimal
  sourceType: string | null;
  sourceId: string | null;
  purchaseReceiptId: string | null;
  purchaseReceiptLineId: string | null;
  materialIssueId: string | null;
  materialIssueLineId: string | null;
  comment: string | null;
  createdById: string | null;
  createdAt: string;       // ISO
}
```

`StockMovement.sourceKey` (внутренний идемпотентный ключ
`PURCHASE_RECEIPT_LINE:<id>` / `PURCHASE_RECEIPT_LINE_CANCEL:<id>` /
`MATERIAL_ISSUE_LINE:<id>` / `STOCK_ADJUSTMENT:<id>` /
`STOCK_TRANSFER:<id>:OUT|IN`) сознательно **не отдаётся** в
публичном API.

### 26a.3 `POST /api/stock/adjustments`

Ручная корректировка остатка материала. Создаёт `StockMovement` с
`type = ADJUSTMENT`, `direction = IN | OUT`, апдейтит `StockBalance` и
пишет audit `STOCK_ADJUSTMENT_CREATED` (под `entityType = STOCK_MOVEMENT`,
`entityId = StockMovement.id`) в одной транзакции.

UI — `/admin/warehouses?tab=balances`, кнопка «Корректировка»
(см. `apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx`,
`apps/web/lib/stock-api.ts::createStockAdjustment`). Отдельной
страницы / пункта меню под корректировки сознательно не вводим.

Body:

| Поле              | Тип                | Обязательно | Описание |
| ----------------- | ------------------ | ----------- | -------- |
| `stockBalanceId`  | string             | да          | Корректируем существующий `StockBalance` (для MVP — только его). |
| `direction`       | `'IN' \| 'OUT'`    | да          | `IN` увеличивает остаток, `OUT` уменьшает. |
| `qty`             | string \| number   | да          | > 0; Decimal. |
| `unitCost`        | string \| number   | нет         | Используется только для `IN`. Для `OUT` — игнорируется (складская оценка OUT берётся из текущего `StockBalance.unitCost`). Если `IN` без `unitCost` — берётся текущий `balance.unitCost` или `0`. |
| `comment`         | string             | да          | 2..500 символов; причина корректировки. |
| `clientRequestId` | string             | нет         | Если передан — используется в `sourceKey` (`STOCK_ADJUSTMENT:<clientRequestId>`). Защита от двойного submit формы: один `clientRequestId` → одно `StockMovement`. Если не передан, сервер сгенерирует свой. |

Сервис **сознательно не принимает** `sourceKey`, `totalCost`,
`balanceBeforeQty`, `balanceAfterQty`, `createdById` — это служебные
поля, которые рассчитывает / выставляет сам.

Ответ — созданное (или ранее существовавшее при идемпотентном повторе)
`StockMovement` в shape `26a.2 StockMovement`. `sourceKey` не
возвращается.

Правила:

- `StockMovement.type` всегда `ADJUSTMENT`;
- `IN` увеличивает `StockBalance.qty`, `OUT` уменьшает;
- `OUT` уважает `CompanySettings.allowNegativeMaterialStock`:
  - `true` — OUT может увести `StockBalance.qty` в минус (текущее
    MVP-поведение);
  - `false` — нехватка остатка → 409 `MATERIAL_STOCK_INSUFFICIENT`;
- `IN` от флага не зависит — всегда добавляет qty;
- `PurchaseReceipt` cancel остаётся permissive (REVERSAL может уйти в
  минус), поведение `MaterialIssue.totalCost` корректировка **не
  меняет** — adjustment живёт только в плоскости склада;
- `StockAdjustment` модель **не создаётся** — корректировка
  представлена строкой `StockMovement type=ADJUSTMENT`.

Ошибки:

- 400 `VALIDATION_ERROR` — невалидный body (qty/comment/direction).
- 400 `STOCK_MOVEMENT_QTY_INVALID` — `qty <= 0`.
- 400 `STOCK_MOVEMENT_VALUE_INVALID` — некорректный числовой формат `qty` / `unitCost`.
- 400 `STOCK_MOVEMENT_UNIT_COST_INVALID` — `unitCost < 0` для `IN`.
- 404 `STOCK_BALANCE_NOT_FOUND` — `stockBalanceId` не существует.
- 409 `MATERIAL_STOCK_INSUFFICIENT` — `OUT` при `allowNegativeMaterialStock = false`.

### 26a.4 `POST /api/stock/transfers`

Перемещение остатка `StockBalance` между складами / ячейками. Создаёт
**пару** `StockMovement` `type = TRANSFER` (`direction = OUT` из
источника + `direction = IN` в назначение), апдейтит исходный
`StockBalance` и создаёт / увеличивает целевой `StockBalance`, и
пишет audit `STOCK_TRANSFER_CREATED` (под `entityType =
STOCK_MOVEMENT`, `entityId = OUT.id`) в одной транзакции.

UI — `/admin/warehouses?tab=balances`, кнопка «Переместить»
(см. `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`,
`apps/web/lib/stock-api.ts::createStockTransfer`). Отдельной страницы /
пункта меню под перемещения сознательно не вводим.

Body:

| Поле                 | Тип                | Обязательно | Описание |
| -------------------- | ------------------ | ----------- | -------- |
| `fromStockBalanceId` | string             | да          | Источник перемещения. `workshopNeedId`, `unit`, `description`, `materialRole`, `unitCost` сервис достаёт из исходного `StockBalance`. |
| `toWarehouseId`      | string \| null     | нет         | Склад назначения. Если передан `toCellId`, destination warehouse берётся из `Cell.warehouseId` (с fallback на `toWarehouseId`). |
| `toCellId`           | string \| null     | нет         | Ячейка назначения. Если передана — destination warehouse берётся из `Cell.warehouseId`. |
| `qty`                | string \| number   | да          | > 0; Decimal. |
| `comment`            | string             | да          | 2..500 символов; причина перемещения, попадает в `comment` обоих движений. |
| `clientRequestId`    | string             | нет         | Если передан — становится частью пары идемпотентных ключей `STOCK_TRANSFER:<clientRequestId>:OUT` и `STOCK_TRANSFER:<clientRequestId>:IN`. Защита от двойного submit формы. Если не передан, сервер сгенерирует свой uuid. |

Сервис **сознательно не принимает** `sourceKey`, `totalCost`,
`unitCost`, `balanceBeforeQty`, `balanceAfterQty`, `createdById`,
`workshopNeedId`, `unit` — это служебные / выводимые из источника поля.

Ответ:

```ts
{
  transferId: string;
  outMovement: StockMovement; // shape `26a.2 StockMovement`
  inMovement: StockMovement;  // shape `26a.2 StockMovement`
}
```

`sourceKey` ни для одного из движений в response **не возвращается**
(`STOCK_TRANSFER:<id>:OUT|IN` живёт только в БД и audit).

Правила:

- `StockMovement.type` всегда `TRANSFER` для обоих движений;
- `OUT` уменьшает источник, `IN` создаёт / увеличивает назначение;
- transfer всегда **strict**: при `source.qty < qty` отдаём 409
  `MATERIAL_STOCK_INSUFFICIENT`, баланс не меняется, ни одно
  движение не пишется. `CompanySettings.allowNegativeMaterialStock`
  на transfer **не влияет** — отрицательный остаток источника
  через transfer запрещён независимо от глобальных настроек;
- IN использует `source.unitCost` — destination через
  `applyMovementInTx` пересчитывает свою средневзвешенную цену;
- transfer **не** меняет `MaterialIssue.totalCost`, `OrderSummary` /
  плановую/фактическую себестоимость заказа и production cost —
  движение живёт строго в плоскости склада;
- отдельная модель `StockTransfer` **не создаётся** — пара движений
  сама себе документ (общий `sourceId` / парные `sourceKey` ключи);
- `delete` / `cancel` transfer в этой итерации **не реализованы**.

Ошибки:

- 400 `VALIDATION_ERROR` — невалидный body (qty/comment).
- 400 `STOCK_MOVEMENT_QTY_INVALID` — `qty <= 0`.
- 400 `STOCK_MOVEMENT_VALUE_INVALID` — некорректный числовой формат `qty`.
- 404 `STOCK_BALANCE_NOT_FOUND` — `fromStockBalanceId` не существует.
- 404 `STOCK_TRANSFER_CELL_NOT_FOUND` — `toCellId` не существует.
- 409 `MATERIAL_STOCK_INSUFFICIENT` — `qty > source.qty`.
- 409 `STOCK_TRANSFER_SAME_LOCATION` — destination совпадает с source
  (`warehouseId` + `cellId`).
- 409 `STOCK_TRANSFER_INCONSISTENT_STATE` — структурная аномалия:
  есть только один из двух `sourceKey` пары; обычно не возникает.

### Сознательные границы MVP

- mutation на этой итерации две: `POST /adjustments` (ручная
  корректировка) и `POST /transfers` (перемещение). FIFO/LIFO /
  `MaterialStockLot` / master-`Material` / отдельная модель
  `StockTransfer` НЕ вводятся;
- остатки считаются по `WorkshopNeed`;
- delete / cancel adjustment / cancel transfer в этой итерации не
  реализованы;
- новые роли (`WAREHOUSE_MANAGER`, `PURCHASER`, `ACCOUNTANT`) **не
  введены**;
- UI корректировки и перемещения живут прямо во вкладке «Остатки»
  раздела «Склады»; отдельной страницы / пункта sidebar нет.

---

<a id="27-qc"></a>
## 27. QC

Источник: `qc/qc.controller.ts` +
`qc/passport-defects.controller.ts`. Класс-уровень
`@Roles('QC', 'SHOP_MANAGER')` (+ ADMIN) — на
`PassportDefectsController` класс-уровень RBAC не задан (см. колонку
RBAC по строкам).

| Метод | Путь                                            | RBAC                         | Описание |
| ----- | ----------------------------------------------- | ---------------------------- | -------- |
| GET   | `/api/qc/passports`                             | QC, SHOP_MANAGER (+ ADMIN)   | List `ListQcPassportsQuery`. |
| GET   | `/api/qc/passports/:id`                         | QC, SHOP_MANAGER (+ ADMIN)   | Карточка ОТК по паспорту. |
| POST  | `/api/qc/passports/:id/defects`                 | QC, SHOP_MANAGER (+ ADMIN)   | Body `CreatePassportDefectDto`. Создаёт `PassportDefect`, `PassportEvent(DEFECT_RECORDED)`, инкрементит `Passport.qtyDefect`. |
| POST  | `/api/qc/passports/:id/complete`                | QC, SHOP_MANAGER (+ ADMIN)   | Body пустое. Пишет `PassportEvent(QC_PASSED)` (audit-маркер, `Passport.status` не меняется). |
| GET   | `/api/passports/:id/defects`                    | Any auth                     | История дефектов по паспорту. |

DTO: `packages/shared/src/qc.ts`.

---

<a id="28-wto"></a>
## 28. WTO

Источник: `wto/wto.controller.ts`. Класс-уровень
`@Roles('IRONING', 'SHOP_MANAGER')` (+ ADMIN).

| Метод | Путь                                            | RBAC                              | Описание |
| ----- | ----------------------------------------------- | --------------------------------- | -------- |
| GET   | `/api/wto/passports/:id`                        | IRONING, SHOP_MANAGER (+ ADMIN)   | Карточка паспорта на стороне ВТО. |
| POST  | `/api/wto/passports/:id/complete`               | IRONING, SHOP_MANAGER (+ ADMIN)   | Body пустое. Пишет `PassportEvent(WTO_PASSED)` (audit-маркер). |

> «Принять паспорт на ВТО» = существующий
> `POST /api/passports/:id/scan` (общий scan-driven вход на любую
> операцию). Backend сам делает `QC-gate` через
> `PassportsService.scanOnOperation`.

DTO: см. shared (`WtoPassportDetailDto`). UNKNOWN/TODO для DTO —
`apps/api/src/modules/wto/wto.service.ts`.

---

<a id="29-packing"></a>
## 29. Packing

Источник: `packing/packing.controller.ts`. Класс-уровень
`@Roles('PACKING', 'SHOP_MANAGER')` (+ ADMIN). `@Public()`-маршруты
`/qr` и `/label` остаются доступны без сессии.

| Метод | Путь                                              | RBAC                              | Описание |
| ----- | ------------------------------------------------- | --------------------------------- | -------- |
| POST  | `/api/packing/boxes`                              | PACKING, SHOP_MANAGER (+ ADMIN)   | Body `CreateBoxDto`. |
| GET   | `/api/packing/boxes`                              | PACKING, SHOP_MANAGER (+ ADMIN)   | List `ListBoxesQuery`. |
| GET   | `/api/packing/boxes/:id`                          | PACKING, SHOP_MANAGER (+ ADMIN)   | Карточка. |
| POST  | `/api/packing/boxes/:id/add-passport`             | PACKING, SHOP_MANAGER (+ ADMIN)   | Body `AddPassportToBoxDto`. Side effects: `BoxItem(boxId, passportId UNIQUE, qty = passport.qtyGood)`, `Box.totalQty += qtyGood`, `Passport.status = PACKED` (+ обнуление `currentEmployeeId` / `currentCellId`), `PassportEvent(PACKED)`, `AuditLog(PASSPORT_PACKED)`, **`FinishedGoodsMovement` `type = PRODUCTION_RECEIPT` `direction = IN`** + апдейт `FinishedGoodsBalance.qty` + `AuditLog(FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED)` в той же транзакции (см. §29a, идемпотент по `sourceKey = PACKED_PASSPORT:<passportId>`). Финальный апрув `OperationEntry(PENDING_RELEASE → APPROVED)` здесь **не** делается — он перенесён на `close()` (см. ADR-0005 §«Подтверждение», ADR-0011 §5, `docs/production-flow.md §10.4`). |
| POST  | `/api/packing/boxes/:id/place`                    | PACKING, SHOP_MANAGER (+ ADMIN)   | Body `PlaceBoxDto` (`PlaceBoxSchema`). Размещает короб в ячейке хранения. См. `PackingService.place`. |
| POST  | `/api/packing/boxes/:id/close`                    | PACKING, SHOP_MANAGER (+ ADMIN)   | Body `CloseBoxDto` (пустое). Side effects: `Box.closedAt = now`, для каждого `BoxItem.passportId` — `EarningsService.approvePendingForPassport(tx, passportId)` (`OperationEntry(PENDING_RELEASE → APPROVED)`, `AuditLog(BOX_CLOSED)`). Идемпотентно: повторный close ловится `BoxClosedException` до апрува, а сама `approvePendingForPassport` фильтрует только `PENDING_RELEASE`/legacy `PENDING` (см. ADR-0005, ADR-0011 §5, `docs/production-flow.md §10.4`/§11.3). |
| GET   | `/api/packing/boxes/:id/qr`                       | Public                            | PNG QR `box:{id}` (ADR-0008). |
| GET   | `/api/packing/boxes/:id/label`                    | Public                            | HTML этикетка коробки (ADR-0010, A6 80×120 мм). |

DTO: `packages/shared/src/packing.ts`. Side-effect: на сервисе
требуется активная смена с операцией `OperationCategory.PACKING`.

---

<a id="29a-finished-goods"></a>
## 29a. Finished goods (read-only)

Источник: `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
`apps/api/src/modules/finished-goods/finished-goods.service.ts`,
`prisma/schema.prisma::FinishedGoodsBalance` / `FinishedGoodsMovement`,
`docs/current-state.md §«Foundation готовой продукции»`.

**Отдельный контур от материалов** — не путать с §26a Stock.
`StockBalance` / `StockMovement` / `MaterialIssue` / `PurchaseReceipt` /
`StockAdjustment` / `StockTransfer` / `CostsService` /
`ProductionCostV2Service` НЕ затрагиваются. На MVP-итерации
реализованы:
- автоматический приход `PRODUCTION_RECEIPT` (`direction = IN`) в
  момент упаковки паспорта / прохождения операции с
  `Operation.producesFinishedGoods = true`;
- ручная отгрузка готовой продукции из карточки заказа —
  `SHIPMENT` (`direction = OUT`), см. блок «Finished goods shipments»
  ниже.

Запись `PRODUCTION_RECEIPT` идёт неявно из `PackingService.addPassport`
/ `PassportsService.scanOnOperation` →
`FinishedGoodsService.recordPassportOutputInTx` (idempotent по
`sourceKey = PACKED_PASSPORT:<passportId>`).

| Метод | Путь                              | RBAC                | Описание |
| ----- | --------------------------------- | ------------------- | -------- |
| GET   | `/api/finished-goods/balances`    | ADMIN, SHOP_MANAGER | List `ListFinishedGoodsBalancesQuery`. Фильтры: `orderId`, `productId`, `sizeId`, `warehouseId`, `cellId`, `q` (substring по `color`), `positiveOnly` / `negativeOnly` / `zeroOnly` (взаимоисключающие), `limit` (default 50, max 200), `offset`. Response: `{ items, total, limit, offset }`. Item: `id`, `balanceKey`, `orderId`, `orderNumber`, `clientId`, `clientName` (через `Order.client → Client`), `productId`, `productName`, `sizeId`, `sizeCode`, `color`, `warehouseId`, `warehouseName`, `cellId`, `cellCode`, `qty`, `lastMovementAt`, `updatedAt`. |
| GET   | `/api/finished-goods/movements`   | ADMIN, SHOP_MANAGER | List `ListFinishedGoodsMovementsQuery`. Фильтры: `orderId`, `productId`, `sizeId`, `warehouseId`, `cellId`, `type` ∈ `PRODUCTION_RECEIPT \| REVERSAL \| ADJUSTMENT \| SHIPMENT \| TRANSFER`, `direction` ∈ `IN \| OUT`, `passportId`, `boxId`, `from` / `to` (ISO-8601), `limit`, `offset`. Response: `{ items, total, limit, offset }`. Item: `id`, `finishedGoodsBalanceId`, `type`, `direction`, `orderId`, `orderNumber`, `clientId`, `clientName` (через `Order.client → Client`), `productId`, `productName`, `sizeId`, `sizeCode`, `color`, `warehouseId`, `warehouseName`, `cellId`, `cellCode`, `qty`, `balanceBeforeQty`, `balanceAfterQty`, `sourceType`, `sourceId`, `passportId`, `boxId`, `comment`, `createdById`, `createdAt`. |
| GET   | `/api/finished-goods/shipments/:id` | ADMIN, SHOP_MANAGER | Detail документа отгрузки. Response — `FinishedGoodsShipmentDetailDto`: `id`, `number`, `orderId`, `status` (`POSTED` \| `CANCELLED`), `shippedAt`, `comment`, `createdAt`, `createdById`, `cancelledAt`, `cancelledById`, `cancelReason` (заполнены при `status = CANCELLED`, иначе `null`), `lines: [{ id, finishedGoodsBalanceId, productId, productName, sizeId, sizeCode, color, warehouseId, warehouseName, cellId, cellCode, qty, comment }]`. |

`sourceKey` сознательно **не возвращается** ни для движений, ни для
shipment-документа — это внутренний идемпотентный технический ключ.

Поведение при отсутствии склада: если у заказа
`Order.finishedGoodsWarehouseId = null`, баланс ведётся как
«no-warehouse» (`warehouseId = null`); упаковка НЕ блокируется.

Audit:
- `FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED` с
  `entityType = FINISHED_GOODS_MOVEMENT`,
  `entityId = FinishedGoodsMovement.id`. Payload содержит
  `finishedGoodsMovementId`, `finishedGoodsBalanceId`, `orderId`,
  `passportId`, `boxId`, `productId`, `sizeId`, `color`, `warehouseId`,
  `cellId`, `qty`, `balanceBeforeQty`, `balanceAfterQty`, `employeeId`,
  `timestamp`;
- `FINISHED_GOODS_SHIPMENT_CREATED` — см. блок «Finished goods
  shipments» ниже.

### Finished goods shipments

Источник: `apps/api/src/modules/finished-goods/finished-goods-order-shipments.controller.ts`,
`apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`,
`prisma/schema.prisma::FinishedGoodsShipment` /
`FinishedGoodsShipmentLine`,
`docs/current-state.md §«Отгрузка готовой продукции»`.

Менеджерская акция «Отгрузка готовой продукции» из карточки заказа
(вкладка «Производство»). Поддерживается частичная отгрузка: можно
отгрузить часть остатка по любому сочетанию `product / size / color
/ warehouse / cell`. Каждая строка shipment-документа создаёт ровно
один `FinishedGoodsMovement type=SHIPMENT direction=OUT` (sourceKey
`FINISHED_GOODS_SHIPMENT_LINE:<lineId>`); `FinishedGoodsBalance.qty`
атомарно уменьшается. **Order.status автоматически НЕ меняется.**

| Метод | Путь                                             | RBAC                | Описание |
| ----- | ------------------------------------------------ | ------------------- | -------- |
| GET   | `/api/orders/:orderId/finished-goods-shipments`  | ADMIN, SHOP_MANAGER | Список документов отгрузки по заказу (`FinishedGoodsShipmentDetailDto[]`, включая статус, `cancelledAt`, `cancelReason`), сортировка `shippedAt desc, createdAt desc, id desc`. CANCELLED-документы НЕ скрываются. |
| POST  | `/api/orders/:orderId/finished-goods-shipments`  | ADMIN, SHOP_MANAGER | Body — `CreateFinishedGoodsShipmentDto`: `{ shippedAt? (ISO datetime), comment? (max 500), clientRequestId? (max 128), lines: [{ finishedGoodsBalanceId, qty (int > 0), comment? (max 500) }] }`. Минимум одна строка. `orderId` берётся из URL. Response — созданный (или existing для повторного `clientRequestId`) `FinishedGoodsShipmentDetailDto`. |
| POST  | `/api/finished-goods/shipments/:id/cancel`       | ADMIN, SHOP_MANAGER | Отмена ранее проведённого документа целиком. Body — `CancelFinishedGoodsShipmentDto`: `{ reason (2..500) }`. Документ получает `status = CANCELLED` + `cancelledAt` / `cancelledById` / `cancelReason`; по каждой строке создаётся `FinishedGoodsMovement` `type = REVERSAL, direction = IN` (sourceKey `FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>`); `FinishedGoodsBalance.qty` атомарно увеличивается обратно. Idempotent при повторном вызове на CANCELLED-документе — возвращает existing detail без новых движений. **Частичная отмена не поддерживается.** Order.status / material stock не меняются. Response — обновлённый `FinishedGoodsShipmentDetailDto`. |

Идемпотентность POST — `FinishedGoodsShipment.sourceKey @unique`
(`FINISHED_GOODS_SHIPMENT:<orderId>:<clientRequestId>`). Повторный
submit формы (двойной клик / network retry) с тем же
`clientRequestId` возвращает существующий документ и НЕ создаёт
дублирующих движений / списаний. Если `clientRequestId` не передан,
сервис генерирует UUID server-side, но идемпотентность тогда
отсутствует — UI всегда обязан генерировать UUID.

Ошибки:
- `FINISHED_GOODS_SHIPMENT_DUPLICATE_BALANCE` (400) — duplicate
  `finishedGoodsBalanceId` в request;
- `FINISHED_GOODS_BALANCE_NOT_FOUND` (404) — `finishedGoodsBalanceId`
  не существует;
- `FINISHED_GOODS_SHIPMENT_BALANCE_ORDER_MISMATCH` (400) — баланс
  принадлежит другому заказу;
- `FINISHED_GOODS_SHIPMENT_QTY_EXCEEDS_AVAILABLE` (409) — `qty >
  balance.qty`;
- `FINISHED_GOODS_INSUFFICIENT_BALANCE` (409) — конкурентная
  отгрузка успела увести остаток ниже нуля (защита внутри
  `applyMovementInTx`); транзакция полностью откатывается;
- `FINISHED_GOODS_SHIPMENT_NOT_FOUND` (404) — на cancel: документа
  с таким `id` нет;
- `FINISHED_GOODS_SHIPMENT_INVALID_STATUS` (409) — на cancel:
  документ не в статусе `POSTED` (и не `CANCELLED` — last для
  идемпотентности возвращает existing detail);
- `ORDER_NOT_FOUND` (404) — заказа нет.

Audit-события (entityType `FINISHED_GOODS_SHIPMENT`, entityId —
`FinishedGoodsShipment.id`):
- `FINISHED_GOODS_SHIPMENT_CREATED` пишется в той же транзакции,
  что и сам документ + N `FinishedGoodsMovement` SHIPMENT OUT.
  Payload — `{ finishedGoodsShipmentId, number, orderId, shippedAt,
  comment, lines: [{ finishedGoodsShipmentLineId,
  finishedGoodsBalanceId, productId, sizeId, color, warehouseId,
  cellId, qty }], employeeId, timestamp }`.
- `FINISHED_GOODS_SHIPMENT_CANCELLED` пишется в той же транзакции,
  что и `status → CANCELLED` + N `FinishedGoodsMovement` REVERSAL IN.
  Payload — `{ finishedGoodsShipmentId, number, orderId, cancelledAt,
  cancelReason, lines: [{ finishedGoodsShipmentLineId,
  finishedGoodsBalanceId, productId, sizeId, color, warehouseId,
  cellId, qty }], employeeId, timestamp }`. Идемпотентен — повторный
  cancel-вызов на уже отменённом документе audit заново не пишет.

Сознательно **не реализованы** на этой итерации (см.
`docs/current-state.md §«Отгрузка готовой продукции»`):
- частичная отмена shipment — пользователь отменяет ошибочный
  shipment целиком и создаёт новый корректный;
- отдельные модели `FinishedGoodsShipmentReturn` /
  `FinishedGoodsShipmentCancel` — отмена решена через
  `status = CANCELLED` + REVERSAL IN, без нового документа;
- DRAFT-flow shipment;
- adjustment готовой продукции;
- автоматическая смена `Order.status` при полной отгрузке /
  отмене shipment;
- материальный stock не затрагивается.

### Finished goods transfers

Источник: `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
`apps/api/src/modules/finished-goods/finished-goods.service.ts::createTransfer`,
`apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`,
`docs/current-state.md §«Готовая продукция»`.

Перемещение готовой продукции между складами / ячейками. Для
пользователя это та же складская операция, что и перемещение
материалов: одна кнопка «Переместить» во вкладке
`/admin/warehouses?tab=balances`. UI смотрит на `kind` выбранного
остатка и идёт либо в `POST /api/stock/transfers` (материал), либо в
`POST /api/finished-goods/transfers` (готовая продукция). Backend
держит контуры раздельными — `FinishedGoodsBalance` /
`FinishedGoodsMovement` не пересекаются с `StockBalance` /
`StockMovement` материалов.

Transfer фиксируется парой `FinishedGoodsMovement` `type = TRANSFER`:
`direction = OUT` (sourceKey `FINISHED_GOODS_TRANSFER:<id>:OUT`)
уменьшает исходный `FinishedGoodsBalance.qty`, `direction = IN`
(sourceKey `FINISHED_GOODS_TRANSFER:<id>:IN`) создаёт / увеличивает
целевой `FinishedGoodsBalance` той же номенклатуры
(`order × product × size × color × warehouse × cell`). Отдельной модели
`FinishedGoodsTransfer` сознательно нет — transfer полностью
описывается парой движений.

| Метод | Путь                                | RBAC                | Описание |
| ----- | ----------------------------------- | ------------------- | -------- |
| POST  | `/api/finished-goods/transfers`     | ADMIN, SHOP_MANAGER | Body — `CreateFinishedGoodsTransferDto`: `{ fromFinishedGoodsBalanceId, toWarehouseId? \| null, toCellId? \| null, qty (int > 0), comment (2..500), clientRequestId? (max 128) }`. `orderId`, `productId`, `sizeId`, `color`, `warehouseId`, `cellId` сервис достаёт из исходного `FinishedGoodsBalance` — клиент их не присылает. `qty` всегда целое (готовая продукция штучная). Response — `{ transferId, outMovement, inMovement }`, где movements — `FinishedGoodsMovementListItem` БЕЗ `sourceKey`. Создаёт пару движений `type = TRANSFER` (`OUT` / `IN`) и audit `FINISHED_GOODS_TRANSFER_CREATED` в одной транзакции. |

Правила:
- transfer всегда **strict** — нельзя переместить больше, чем есть на
  исходном балансе (`source.qty >= qty`). Готовая продукция не уходит
  в минус;
- если `toCellId` передан — destination `warehouseId` берётся из
  `Cell.warehouseId` (с fallback на `toWarehouseId`); иначе `cellId =
  null`;
- если source `(warehouseId, cellId)` совпадает с destination — 409
  `FINISHED_GOODS_TRANSFER_SAME_LOCATION`;
- идемпотентность по `clientRequestId`: повторный submit с тем же
  ключом возвращает существующую пару движений и не апдейтит балансы
  повторно. Если найден только один из двух ключей — 409
  `FINISHED_GOODS_TRANSFER_INCONSISTENT_STATE` (структурная аномалия);
- `sourceKey` сознательно НЕ возвращается (внутренний идемпотентный
  технический ключ).

Ошибки:
- `FINISHED_GOODS_TRANSFER_QTY_INVALID` (400) — `qty` не целое
  положительное число (zod-pipe ловит большую часть кейсов раньше);
- `FINISHED_GOODS_BALANCE_NOT_FOUND` (404) — исходного баланса нет;
- `FINISHED_GOODS_INSUFFICIENT_BALANCE` (409) — `qty > source.qty`;
- `FINISHED_GOODS_TRANSFER_CELL_NOT_FOUND` (404) — целевой ячейки нет;
- `FINISHED_GOODS_TRANSFER_SAME_LOCATION` (409) — source/destination
  совпадают;
- `FINISHED_GOODS_TRANSFER_INCONSISTENT_STATE` (409) — найден только
  один из пары sourceKey-ключей.

Audit:
- `FINISHED_GOODS_TRANSFER_CREATED` (entityType
  `FINISHED_GOODS_MOVEMENT`, entityId — `FinishedGoodsMovement.id`
  для OUT). Payload — `{ sourceType: 'FINISHED_GOODS_TRANSFER',
  transferId, fromFinishedGoodsBalanceId, toFinishedGoodsBalanceId,
  outMovementId, inMovementId, orderId, productId, sizeId, color,
  qty, from: { warehouseId, cellId }, to: { warehouseId, cellId },
  comment, employeeId, timestamp }`.

Сознательная граница MVP:
- **не создаём** отдельную модель `FinishedGoodsTransfer`;
- **не реализуем** cancel transfer / partial cancel — ошибочный
  transfer оператор компенсирует обратным transfer-ом;
- **не реализуем** transfer history endpoint — пара движений видна
  через стандартный `GET /api/finished-goods/movements` (фильтр
  `type=TRANSFER`);
- **не вводим** FIFO/LIFO/MaterialStockLot;
- **не меняем** material `StockTransfer` business logic / MaterialIssue
  / PurchaseReceipt / StockAdjustment / Packing / Operation /
  CostsService / ProductionCostV2Service.

### Finished goods adjustments

Источник: `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
`apps/api/src/modules/finished-goods/finished-goods.service.ts::createAdjustment`,
`apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`,
`docs/current-state.md §«Готовая продукция»`.

Ручная корректировка остатка готовой продукции. Для пользователя это
та же складская операция, что и корректировка материалов: одна кнопка
«Корректировка» во вкладке `/admin/warehouses?tab=balances`. UI
смотрит на `kind` выбранного остатка и идёт либо в
`POST /api/stock/adjustments` (материал), либо в
`POST /api/finished-goods/adjustments` (готовая продукция). Backend
держит контуры раздельными — `FinishedGoodsBalance` /
`FinishedGoodsMovement` не пересекаются с `StockBalance` /
`StockMovement` материалов.

Adjustment фиксируется одним `FinishedGoodsMovement` `type =
ADJUSTMENT, direction = IN | OUT` (sourceKey
`FINISHED_GOODS_ADJUSTMENT:<clientRequestId>`); `FinishedGoodsBalance.qty`
атомарно меняется в той же транзакции через `applyMovementInTx`.
Отдельной модели `FinishedGoodsAdjustment` сознательно нет —
корректировка полностью описывается одним движением.

| Метод | Путь                                  | RBAC                | Описание |
| ----- | ------------------------------------- | ------------------- | -------- |
| POST  | `/api/finished-goods/adjustments`     | ADMIN, SHOP_MANAGER | Body — `CreateFinishedGoodsAdjustmentDto`: `{ finishedGoodsBalanceId, direction ('IN'\|'OUT'), qty (int > 0), comment (2..500), clientRequestId? (max 128) }`. `orderId`, `productId`, `sizeId`, `color`, `warehouseId`, `cellId`, `unit` сервис достаёт из исходного `FinishedGoodsBalance` — клиент их не присылает. `qty` всегда целое (готовая продукция штучная); `unitCost` для готовой продукции **не запрашивается** (это не material cost). Response — `FinishedGoodsMovementListItem` БЕЗ `sourceKey`. Создаёт одно движение `type = ADJUSTMENT` и audit `FINISHED_GOODS_ADJUSTMENT_CREATED` в одной транзакции. |

Правила:
- `IN` увеличивает `FinishedGoodsBalance.qty` на `qty`; `OUT`
  уменьшает;
- `OUT` всегда **strict** — нельзя списать больше, чем есть на
  балансе (`source.qty >= qty`). Готовая продукция не уходит в минус,
  аналога `allowNegativeMaterialStock` для finished goods на этой
  итерации нет;
- идемпотентность по `clientRequestId`: повторный submit с тем же
  ключом возвращает существующее движение и не апдейтит баланс
  повторно (UNIQUE на `FinishedGoodsMovement.sourceKey`);
- `sourceKey` сознательно НЕ возвращается (внутренний идемпотентный
  технический ключ).

Ошибки:
- `FINISHED_GOODS_ADJUSTMENT_QTY_INVALID` (400) — `qty` не целое
  положительное число (zod-pipe ловит большую часть кейсов раньше);
- `FINISHED_GOODS_MOVEMENT_DIRECTION_INVALID` (400) — direction не
  `IN` / `OUT`;
- `FINISHED_GOODS_BALANCE_NOT_FOUND` (404) — баланс не существует;
- `FINISHED_GOODS_INSUFFICIENT_BALANCE` (409) — `OUT` с `qty >
  balance.qty`.

Audit:
- `FINISHED_GOODS_ADJUSTMENT_CREATED` (entityType
  `FINISHED_GOODS_MOVEMENT`, entityId — `FinishedGoodsMovement.id`).
  Payload — `{ sourceType: 'FINISHED_GOODS_ADJUSTMENT', adjustmentId,
  finishedGoodsBalanceId, movementId, orderId, productId, sizeId,
  color, warehouseId, cellId, direction, qty, balanceBeforeQty,
  balanceAfterQty, comment, employeeId, timestamp }`.

Сознательная граница MVP:
- **не создаём** отдельную модель `FinishedGoodsAdjustment`;
- **не реализуем** cancel adjustment / partial cancel — ошибочную
  корректировку оператор компенсирует обратной (IN ↔ OUT);
- **не реализуем** adjustment history endpoint — движения видны
  через стандартный `GET /api/finished-goods/movements` (фильтр
  `type=ADJUSTMENT`);
- **не запрашиваем** `unitCost` для готовой продукции (это не
  material cost);
- **не вводим** FIFO/LIFO/MaterialStockLot;
- **не меняем** material `StockAdjustment` business logic /
  MaterialIssue / PurchaseReceipt / StockTransfer /
  FinishedGoodsShipment / FinishedGoodsTransfer / Packing /
  Operation / CostsService / ProductionCostV2Service.

---

<a id="29b-work-in-progress"></a>
## 29b. Work in progress (read-only)

Источник: `apps/api/src/modules/work-in-progress/work-in-progress.controller.ts`,
`apps/api/src/modules/work-in-progress/work-in-progress.service.ts`,
`prisma/schema.prisma::WorkInProgressBalance` /
`WorkInProgressMovement`, `docs/erd.md §2.7b`.

**Отдельный контур** от материалов (§26a Stock) и готовой продукции
(§29a Finished goods). Учёт паспортов, лежащих в ячейках после
раскроя и до выдачи в пошив, плюс обратные движения (возврат
master-action'ом, удаление, упаковка из ячейки).

**Единственный источник истины** для «что лежит в ячейках» — после
удаления legacy `CellContent` все consumer'ы (`/api/cells`,
`WarehousesService.deleteLine`, `DiagnosticsService`,
shelf-placement UI) читают из `WorkInProgressBalance`.

Запись движений идёт неявно из `PassportsService.place` /
`issueToEmployee` / `delete`, `MasterActionsService.returnToCell` /
`setRouteStep` (backward + cell), `PackingService.addPassport` (defensive)
через `WorkInProgressService.recordXxxInTx`-обёртки. Идемпотентность —
`WorkInProgressMovement.sourceKey @unique` (формат
`WIP_<TYPE>:<sourceId>`, где `sourceId` — `PassportEvent.id` для
PLACE/ISSUE, `AuditLog.id` для RETURN, `passportId` для DELETE/PACK_OUT).

| Метод | Путь                                | RBAC                | Описание |
| ----- | ----------------------------------- | ------------------- | -------- |
| GET   | `/api/work-in-progress/balances`    | ADMIN, SHOP_MANAGER | List `ListWorkInProgressBalancesQuery`. Фильтры: `orderId`, `productId`, `sizeId`, `color`, `warehouseId`, `cellId`, `nonZero` (если `true` — только qty > 0), `take` (default 100, max 500), `skip`. Response: `{ items, total }`. Item: `id`, `orderId`, `orderNumber`, `productId`, `productName`, `sizeId`, `sizeCode`, `color`, `warehouseId`, `warehouseName`, `cellId`, `cellCode`, `qty`, `updatedAt`, `lastMovementAt`. |
| GET   | `/api/work-in-progress/movements`   | ADMIN, SHOP_MANAGER | List `ListWorkInProgressMovementsQuery`. Фильтры: `orderId`, `passportId`, `warehouseId`, `cellId`, `type` ∈ `PLACE \| ISSUE \| RETURN \| DELETE \| PACK_OUT`, `direction` ∈ `IN \| OUT`, `take`, `skip`. Response: `{ items, total }`. Item: `id`, `type`, `direction`, `orderId`, `orderNumber`, `productId`, `productName`, `sizeId`, `sizeCode`, `color`, `warehouseId`, `warehouseName`, `cellId`, `cellCode`, `qty`, `balanceBeforeQty`, `balanceAfterQty`, `passportId`, `passportNumber`, `sourceType`, `comment`, `createdAt`. |

`sourceKey` сознательно **не возвращается** — внутренний
идемпотентный технический ключ.

Защита от рассинхронизации: `applyMovementInTx` бросает
`WIP_INSUFFICIENT_BALANCE` (409) на любом OUT, который увёл бы
`WorkInProgressBalance.qty` ниже нуля. На проде после миграции
обязателен backfill существующих паспортов в ячейках (см. план
деплоя).

---

<a id="30-earnings"></a>
## 30. Earnings

Источник: `earnings/earnings.controller.ts` +
`earnings/passport-earnings.controller.ts`. Класс RBAC не задан;
скоуп по сотруднику выполняется на сервисном уровне.

| Метод | Путь                              | RBAC      | Описание |
| ----- | --------------------------------- | --------- | -------- |
| GET   | `/api/earnings`                   | Any auth  | List `ListEarningsQuery`. SHOP_MANAGER/ADMIN видят всех + могут фильтровать `employeeId`/`status`. Остальные роли скоупятся на свой `employeeId` и только `APPROVED`. |
| GET   | `/api/earnings/summary`           | Any auth  | Агрегаты `EarningsSummaryQuery` (totalApproved/Pending + counts). |
| GET   | `/api/passports/:id/earnings`     | Any auth  | Список начислений по паспорту. SHOP_MANAGER/ADMIN видят все, остальные — только свои `APPROVED`. |

DTO: `packages/shared/src/earnings.ts`. ADR: 0005, 0012.

---

<a id="30a-payroll"></a>
<a id="10c"></a>
## 30a. Payroll (PHASE 1, read-only)

Источник: `payroll/payroll.controller.ts` + `payroll/payroll.service.ts`.
Класс-уровень `@Roles('SHOP_MANAGER', 'ADMIN')`. Все роли, кроме
`SHOP_MANAGER` и `ADMIN`, получают `403 FORBIDDEN`. Сервис ничего не
пишет в БД — только агрегирует уже существующие
`OperationEntry` / `SalaryEntry` / `ShiftSession` / `Employee` /
`Order.companyDivision` (см. `docs/domain.md §10.6`,
`docs/screens.md §12a`, ADR-0005, ADR-0021).

| Метод | Путь                                | RBAC                | Описание |
| ----- | ----------------------------------- | ------------------- | -------- |
| GET   | `/api/payroll/period`               | SHOP_MANAGER, ADMIN | Query `PayrollPeriodQuery` (`{ dateFrom, dateTo, employeeId?, role?, divisionCode?, status?, page?, pageSize? }`). Ведомость по сотрудникам за период: суммирует `OperationEntry.amount` (сдельщина, approved + pending) и `SalaryEntry.amount` (оклад) по каждому сотруднику + общий summary. Каждая строка содержит поля начислений (`pieceworkApprovedRub`, `pieceworkPendingRub`, `salaryRub`, `totalApprovedRub`, `totalPendingRub`, `totalRub`) и поля выплат: `grossAccruedRub` (= approved-сдельщина + оклад), `payoutCoveredRub` (Σ активных `PayrollPayoutLine` за период по сотруднику, статусы DRAFT/ISSUED/ACKNOWLEDGED), `payoutPieceworkCoveredRub`, `payoutSalaryCoveredRub`, `netToPayRub` = `max(0, grossAccruedRub − payoutCoveredRub)`. Summary дополнен `totalPayoutCoveredRub` / `totalNetToPayRub`. `divisionCode` фильтрует через паспорт → заказ → подразделение. |
| GET   | `/api/payroll/daily`                | SHOP_MANAGER, ADMIN | Query `PayrollDailyQuery` (`{ date, role?, divisionCode? }`). Снимок «кто работал сегодня»: для каждого сотрудника отдаёт флаг `hadShift`, `MIN(startedAt)` / `MAX(endedAt)` (последнее `null`, если хоть одна смена не закрыта), сдельщину approved/pending за день и `SalaryEntry` за `date`. |
| GET   | `/api/payroll/employees/:id`        | SHOP_MANAGER, ADMIN | Query `PayrollEmployeeQuery` (`{ dateFrom, dateTo }`). Карточка сотрудника: реквизиты, summary за период, `shifts[]`, `operationEntries[]` (status включает legacy `PENDING` под публичным `PENDING_RELEASE`, как в `EarningsService.toDto`), `salaryEntries[]`. 404 `EMPLOYEE_NOT_FOUND`, если сотрудника нет. |
| GET   | `/api/payroll/debts`                | SHOP_MANAGER, ADMIN | Query `PayrollDebtsQuery` (`{ asOfDate?, employeeId?, role?, divisionCode?, page?, pageSize? }`). Управленческий отчёт задолженности по сотрудникам на выбранную дату (по умолчанию — сегодня). **Формулы:** `accruedGrossRub = accruedPieceworkRub + accruedSalaryRub`; `payoutCoveredRub` = Σ PIECEWORK/SALARY `PayrollPayoutLine`, ссылающихся на начисления `createdAt ≤ asOfDate 23:59:59.999 UTC` (сдельщина) или `date ≤ asOfDate` (оклад), по активным выплатам (`DRAFT`/`ISSUED`/`ACKNOWLEDGED`); `payoutAdjustRub` = Σ `BONUS`/`DEDUCTION`/`ADVANCE`/`ADJUSTMENT` lines без FK, `payout.periodTo ≤ asOfDate`; `paidTotalRub = payoutCoveredRub + payoutAdjustRub`; `debtRub = max(0, accruedGrossRub − payoutCoveredRub)` — базовый долг без корректировок; `cashBalanceRub = accruedGrossRub − paidTotalRub` — с корректировками; `pendingPieceworkRub` — pending OperationEntry до asOfDate, НЕ входит в debtRub. `CANCELLED` выплаты не учитываются. Возвращает `PayrollDebtsPageDto` (`items`, `summary`, `asOfDate`, pagination). |

DTO: `packages/shared/src/payroll.ts`
(`PayrollPeriodQuerySchema` / `PayrollDailyQuerySchema` /
`PayrollEmployeeQuerySchema` + соответствующие `*Dto`).
RBAC-константа — `apps/api/src/modules/payroll/payroll.constants.ts`
(`PAYROLL_MANAGER_ROLES`).

Что API **сознательно не делает** в PHASE 1:

- не пишет в БД (никаких POST/PATCH ручек, никакой ledger-таблицы);
- не меняет статусы / суммы / lifecycle `OperationEntry` /
  `SalaryEntry`;
- не пишет `AuditLog` — журналировать нечего, см.
  `docs/events.md §«Payroll PHASE 1»`.

Связанные документы:
[docs/domain.md §10.6](./domain.md#106-payroll-phase-1-read-only),
[docs/screens.md §12a](./screens.md#12a-payroll),
[docs/erd.md](./erd.md),
[docs/events.md](./events.md).

---

<a id="30b-payroll-payouts"></a>
## 30b. Payroll payouts (PHASE 3)

Источник: `payroll-payouts/payroll-payouts.controller.ts` +
`payroll-payouts/payroll-payouts.service.ts`. DTO/zod —
`packages/shared/src/payroll-payouts.ts`. Источник истины модели —
`prisma/schema.prisma::PayrollPayout` / `PayrollPayoutLine` (см.
[docs/erd.md §2.9](./erd.md#29-salary--earnings)).

«Папка выплаты» поверх существующих `OperationEntry` / `SalaryEntry`:
менеджер собирает черновик за период, выдаёт его сотруднику, сотрудник
подтверждает получение. Сами таблицы начислений «выплачено» **не**
помечаются — статус живёт в `PayrollPayout.status`. `EarningsService`
и `SalaryService` сервис не трогает (см. PHASE 3 STEP 2 ТЗ).

Жизненный цикл — `PayrollPayoutStatus`:
`DRAFT → ISSUED → ACKNOWLEDGED|CANCELLED` или `DRAFT → CANCELLED`.

| Метод | Путь                                          | RBAC                                | Описание |
| ----- | --------------------------------------------- | ----------------------------------- | -------- |
| GET   | `/api/payroll/payouts`                        | Any auth (scope в сервисе)          | Query `PayrollPayoutListQuery` (`{ employeeId?, status?, periodFrom?, periodTo?, page?, pageSize? }`). Менеджер/админ видят всё; обычный сотрудник — только свои строки (`employeeId = viewer.employeeId`, явный `employeeId`-фильтр игнорируется). Период интерпретируется как «выплаты, период которых пересекается с заданным». Возвращает `PayrollPayoutPageDto` (без `lines`). |
| POST  | `/api/payroll/payouts`                        | SHOP_MANAGER, ADMIN                  | Body `CreatePayrollPayoutDto` (`{ employeeId, periodFrom, periodTo, managerComment? }`). Создаёт `DRAFT` и сразу собирает строки snapshot-ом по APPROVED `OperationEntry` за `periodFrom 00:00:00.000 UTC` — `periodTo 23:59:59.999 UTC` и `SalaryEntry` за `[periodFrom, periodTo]`. Pending сдельщина исключается. `amountPieceworkRub` / `amountSalaryRub` / `amountTotalRub` считаются из строк. Конфликт активной строки → 422 `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED`. AuditLog: `PAYROLL_PAYOUT_CREATED`. |
| GET   | `/api/payroll/payouts/:id`                    | Any auth (scope в сервисе)          | Карточка с `lines`. Чужой выплате обычный сотрудник получает 404 `PAYROLL_PAYOUT_NOT_FOUND`, а не 403 — иначе утекают id. |
| POST  | `/api/payroll/payouts/:id/recompute`          | SHOP_MANAGER, ADMIN                  | Body `RecomputePayrollPayoutDto` (на MVP `{}`). Только из `DRAFT`. Удаляет текущие строки и пересобирает snapshot, пересчитывает суммы. Конфликт активной строки → 422. AuditLog: `PAYROLL_PAYOUT_LINES_RECOMPUTED` (payload `before`/`after` сумм/количества). |
| POST  | `/api/payroll/payouts/:id/issue`              | SHOP_MANAGER, ADMIN                  | Body `IssuePayrollPayoutDto` (`{}`). Только из `DRAFT`. Внутри транзакции выполняется recompute, затем `status = ISSUED`, фиксируются `issuedAt` / `issuedById`. AuditLog: `PAYROLL_PAYOUT_ISSUED`. |
| POST  | `/api/payroll/payouts/:id/ack`                | Any auth, **только владелец**       | Body `AckPayrollPayoutDto` (`{}`). Подтверждает только сам сотрудник-получатель: `viewer.employeeId === payout.employeeId`. Менеджер/админ за чужого работника → 403 `PAYROLL_PAYOUT_FORBIDDEN_ACK`. `ISSUED → ACKNOWLEDGED`, фиксируются `acknowledgedAt` / `acknowledgedByEmployeeId`. Повторный `ack` тем же владельцем по `ACKNOWLEDGED` — идемпотентен (возвращает текущий DTO без записи аудита). Прочие статусы → 409 `PAYROLL_PAYOUT_INVALID_TRANSITION`. AuditLog: `PAYROLL_PAYOUT_ACKNOWLEDGED`. |
| POST  | `/api/payroll/payouts/:id/cancel`             | SHOP_MANAGER, ADMIN                  | Body `CancelPayrollPayoutDto` (`{ reason? }`). `DRAFT → CANCELLED` или `ISSUED → CANCELLED`. `ACKNOWLEDGED` отменить нельзя — 409 `PAYROLL_PAYOUT_INVALID_TRANSITION`. AuditLog: `PAYROLL_PAYOUT_CANCELLED`. |

**PHASE 3 STEP 3 — lock-by-line.** Если `SalaryEntry` уже привязана
к `PayrollPayoutLine`, чьим родителем является выплата со статусом
`ISSUED` или `ACKNOWLEDGED`, то любая ручная правка (`PATCH /api/salary/:id`,
включая `reset = true`) возвращает `409 PAYROLL_LOCKED` (см. §10a).
`DRAFT` сознательно не блокирует — черновик ещё пересобирается;
`CANCELLED` тоже не блокирует — snapshot снят, строка свободна.
Автоматический `SalaryService.syncDailySalary` (`POST /api/shifts/start`
/ `POST /api/shifts/stop`) на locked-записи делает silent skip,
чтобы сменный flow не падал из-за «правильного» оклада за уже
выплаченный день. `OperationEntry` на MVP write-once + approve-only
(единственный post-create write — `EarningsService.approvePendingForPassport`,
PENDING_RELEASE → APPROVED при упаковке, а pending сдельщина в payout
snapshot не входит), отдельного guard-а нет.

Бизнес-инвариант (active uniqueness):
одна и та же `OperationEntry` / `SalaryEntry` не может попасть сразу
в две **активные** выплаты (`DRAFT` / `ISSUED` / `ACKNOWLEDGED`).
`CANCELLED`-выплаты строки **не** блокируют — после отмены строка
снова доступна. На уровне БД `@@unique` на `operationEntryId` /
`salaryEntryId` сознательно НЕ ставится — иначе re-include после
`CANCELLED` был бы невозможен. Конфликт проверяется в
`PayrollPayoutsService` перед `payrollPayoutLine.createMany` и
отдаётся как 422 `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED`.

Snapshot строк (см. `PayrollPayoutLine.snapshot`):
- PIECEWORK — `{ operationId, passportId, qty, ratePerUnit, amount,
  sourceEventType, createdAt, approvedAt }`;
- SALARY — `{ date, source, amount, editedManually, managerComment }`.

Бизнес-ошибки:
- `PAYROLL_PAYOUT_NOT_FOUND` (404) — карточка не найдена / чужая для
  обычного сотрудника;
- `PAYROLL_PAYOUT_INVALID_TRANSITION` (409) — недопустимый переход
  статуса (`recompute` после `ISSUED`, `cancel` после `ACKNOWLEDGED`,
  `ack` не из `ISSUED`/`ACKNOWLEDGED`, …);
- `PAYROLL_PAYOUT_FORBIDDEN_ACK` (403) — попытка `ack` за чужого
  сотрудника;
- `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED` (422) — строка начисления
  уже в активной выплате.

Связанные документы:
[docs/erd.md §2.9](./erd.md#29-salary--earnings),
[docs/events.md §3.3 «PAYROLL_PAYOUT»](./events.md#33-salary-entry).

---

<a id="30c-payroll-accrual-documents"></a>
## 30c. Payroll accrual documents (PHASE 3 STEP 6)

Источник: `payroll-accrual-documents/payroll-accrual-documents.controller.ts` +
`payroll-accrual-documents/payroll-accrual-documents.service.ts`. DTO/zod —
`packages/shared/src/payroll-accrual-documents.ts`. Источник истины модели —
`prisma/schema.prisma::PayrollAccrualDocument` / `PayrollAccrualDocumentLine`
(см. [docs/erd.md §2.9](./erd.md#29-salary--earnings)).

Менеджер создаёт DRAFT-документ с `accrualDate` (дата начисления включительно):
система рассчитывает строки по всем сотрудникам из `OperationEntry` (APPROVED,
`createdAt ≤ accrualDate 23:59:59.999 UTC`) и `SalaryEntry` (`date ≤ accrualDate`).
Уже попавшие в активные `PayrollPayoutLine` (`DRAFT`/`ISSUED`/`ACKNOWLEDGED`)
начисления исключаются. При проводке (`pay`) для каждой строки с
`amountToPayRub > 0` создаётся индивидуальный `PayrollPayout` в статусе `ISSUED`.

Жизненный цикл — `PayrollAccrualDocumentStatus`:
`DRAFT → PAID` или `DRAFT → CANCELLED`. `PAID` и `CANCELLED` — терминальные.

**Все endpoints доступны только `SHOP_MANAGER` / `ADMIN`.**

| Метод | Путь                                                            | RBAC                | Описание |
| ----- | --------------------------------------------------------------- | ------------------- | -------- |
| GET   | `/api/payroll/accrual-documents`                                | SHOP_MANAGER, ADMIN | Query `PayrollAccrualDocumentListQuerySchema` (`{ status?, dateFrom?, dateTo?, page?, pageSize? }`). Фильтрация по статусу и `accrualDate`. Сортировка `createdAt desc`. Возвращает `PayrollAccrualDocumentPageDto` (без `lines`, но с `linesCount`). |
| POST  | `/api/payroll/accrual-documents`                                | SHOP_MANAGER, ADMIN | Body `CreatePayrollAccrualDocumentDto` (`{ accrualDate, managerComment? }`). Создаёт `DRAFT` и рассчитывает строки по всем сотрудникам: APPROVED `OperationEntry` (`createdAt ≤ accrualDate 23:59:59.999 UTC`, не в активных выплатах) + `SalaryEntry` (`date ≤ accrualDate`, не в активных выплатах). Строка создаётся только при `amountPieceworkRub + amountSalaryRub > 0`. AuditLog: `PAYROLL_ACCRUAL_DOCUMENT_CREATED`. |
| GET   | `/api/payroll/accrual-documents/:id`                            | SHOP_MANAGER, ADMIN | Карточка со строками `lines` (полный `PayrollAccrualDocumentDto`). 404 `PAYROLL_ACCRUAL_DOCUMENT_NOT_FOUND` при отсутствии. |
| POST  | `/api/payroll/accrual-documents/:id/recompute`                  | SHOP_MANAGER, ADMIN | Только DRAFT. Пересчитывает авто-часть строк; `manualAdjustRub` / `manualComment` сохраняются по `employeeId`. Строка без начислений и `manualAdjustRub = 0` удаляется. AuditLog: `PAYROLL_ACCRUAL_DOCUMENT_RECOMPUTED`. |
| PATCH | `/api/payroll/accrual-documents/:id/lines/:lineId`              | SHOP_MANAGER, ADMIN | Только DRAFT. Body `UpdatePayrollAccrualDocumentLineDto` (`{ manualAdjustRub?, manualComment? }`). После изменения пересчитываются `amountToPayRub` и итоги документа. 404 `PAYROLL_ACCRUAL_DOCUMENT_LINE_NOT_FOUND`. AuditLog: `PAYROLL_ACCRUAL_DOCUMENT_LINE_UPDATED`. |
| POST  | `/api/payroll/accrual-documents/:id/pay`                        | SHOP_MANAGER, ADMIN | Только DRAFT. Документ переходит в `PAID`. Для каждой строки с `amountToPayRub > 0` создаётся `PayrollPayout` (статус `ISSUED`). Перед созданием повторная проверка активной уникальности → 422 `PAYROLL_ACCRUAL_LINE_ALREADY_PAID`. **STEP 6.4:** если `manualAdjustRub ≠ 0`, создаётся дополнительная `PayrollPayoutLine` с `kind = ADJUSTMENT`, `operationEntryId = null`, `salaryEntryId = null`. AuditLog: `PAYROLL_ACCRUAL_DOCUMENT_PAID` (payload содержит `adjustmentsCount` / `totalAdjustRub`). |
| POST  | `/api/payroll/accrual-documents/:id/cancel`                     | SHOP_MANAGER, ADMIN | Только DRAFT. `DRAFT → CANCELLED`. Body `CancelPayrollAccrualDocumentDto` (`{ reason? }`). PAID нельзя отменить в MVP. AuditLog: `PAYROLL_ACCRUAL_DOCUMENT_CANCELLED`. |

Snapshot строки (`PayrollAccrualDocumentLine.snapshot`):
```json
{
  "accrualDate": "YYYY-MM-DD",
  "operationEntryIds": ["<id>", ...],
  "salaryEntryIds": ["<id>", ...],
  "operationEntries": [{ "id", "operationId", "passportId", "qty", "ratePerUnit", "amount", "sourceEventType", "createdAt", "approvedAt" }],
  "salaryEntries": [{ "id", "date", "source", "amount", "editedManually", "managerComment" }]
}
```

Бизнес-ошибки:
- `PAYROLL_ACCRUAL_DOCUMENT_NOT_FOUND` (404) — документ не найден;
- `PAYROLL_ACCRUAL_DOCUMENT_INVALID_STATE` (409) — операция недопустима
  в текущем статусе (например, `pay`/`recompute`/`cancel` после `PAID`);
- `PAYROLL_ACCRUAL_DOCUMENT_LINE_NOT_FOUND` (404) — строка не найдена
  в документе;
- `PAYROLL_ACCRUAL_LINE_ALREADY_PAID` (422) — начисление из snapshot
  уже входит в активную выплату на момент проводки.

**`manualAdjustRub` и ADJUSTMENT (STEP 6.4):** при `pay` документа каждая строка с
`manualAdjustRub ≠ 0` создаёт дополнительную `PayrollPayoutLine`:
`kind = ADJUSTMENT`, `operationEntryId = null`, `salaryEntryId = null`,
`amountRub = manualAdjustRub`. Snapshot содержит `{ manual, source, documentId,
documentLineId, employeeId, manualAdjustRub, manualComment, accrualDate, createdById }`.
ADJUSTMENT-строки не закрывают `OperationEntry` / `SalaryEntry` и не уменьшают
`grossAccruedRub`/`netToPayRub` в ведомости периода — они учитываются отдельно
в `payoutAdjustRub`.

Связанные документы:
[docs/erd.md §2.9](./erd.md#29-salary--earnings),
[docs/events.md §3.4 «PAYROLL_ACCRUAL_DOCUMENT»](./events.md#34-payroll_accrual_document),
[docs/domain.md §«Документ начисления зарплаты»](./domain.md#документ-начисления-зарплаты).

---

<a id="31-salary"></a>
## 31. Salary

Источник: `salary/salary.controller.ts`. На GET-методах класс RBAC
**не выставлен** — скоуп делается на сервисе (`applyViewerScope`); на
`PATCH` — `@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                       | RBAC               | Описание |
| ----- | -------------------------- | ------------------ | -------- |
| GET   | `/api/salary`              | Any auth (scope в сервисе) | List `ListSalaryQuery`. SHOP_MANAGER/ADMIN видят всех; остальные — только свои строки. |
| GET   | `/api/salary/summary`      | Any auth (scope в сервисе) | Агрегат `SalarySummaryQuery`. |
| PATCH | `/api/salary/:id`          | SHOP_MANAGER, ADMIN | Body `UpdateSalaryEntryDto`. Ручная корректировка суммы / комментария / `reset = true` (вернуть под автоматику). PHASE 2 STEP 4 — каждая успешная правка пишет ровно одно событие в `AuditLog`: `SALARY_ENTRY_UPDATED` (обычный PATCH) или `SALARY_ENTRY_RESET` (`reset = true`). Payload содержит `before` / `after`-снимки `amount`/`managerComment`/`editedManually` + `salaryEntryId`/`employeeId`/`date`/`reset`/`editedByEmployeeId`. См. `docs/events.md §3.3 «SALARY_ENTRY»`. Автоматический `syncDailySalary` (на `start/stop shift`) аудит сознательно НЕ пишет. **PHASE 3 STEP 3 lock-by-line:** если эта `SalaryEntry` уже включена в `PayrollPayoutLine` выплаты со статусом `ISSUED` или `ACKNOWLEDGED`, любой PATCH (включая `reset = true`) отдаёт `409 PAYROLL_LOCKED`. `DRAFT` и `CANCELLED` не блокируют. См. §«Payroll payouts». |

DTO: `packages/shared/src/salary.ts`. ADR: 0021.

---

<a id="31a-payroll-calendar"></a>
## 31a. Payroll calendar (производственный календарь)

Источник: `payroll-calendar/payroll-calendar.controller.ts`.
Класс-уровень `@Roles('SHOP_MANAGER', 'ADMIN')` — норма часов участвует
в расчёте денег (производная ставка ₽/час месячного окладника),
поэтому доступ тот же, что у ручной правки начислений.

| Метод  | Путь                                | RBAC                | Описание |
| ------ | ----------------------------------- | ------------------- | -------- |
| GET    | `/api/payroll-calendar`             | SHOP_MANAGER, ADMIN | Query `{ year? }`. Нормы месяцев, сортировка `(year, month) ASC`. Без `year` — все года. |
| PUT    | `/api/payroll-calendar`             | SHOP_MANAGER, ADMIN | Body `UpsertPayrollCalendarMonthDto` (`year`, `month` 1..12, `normDays` 0..31, `normHours > 0`, `comment?`). Идемпотентный upsert по естественному ключу `(year, month)` — отдельных POST/PATCH нет сознательно. Пишет `PAYROLL_CALENDAR_MONTH_UPSERTED` в `AuditLog`. |
| DELETE | `/api/payroll-calendar/:year/:month` | SHOP_MANAGER, ADMIN | Убрать норму месяца. Нет строки — `404 PAYROLL_CALENDAR_MONTH_NOT_FOUND`. Пишет `PAYROLL_CALENDAR_MONTH_DELETED`. |

Зачем: `normHours` — знаменатель ставки ₽/час у сотрудника с месячным
окладом (`salaryPerMonth / normHours`), по которой считаются доплата за
подкрой, ₽/минуту простоя в дашборде и разнос оклада на себестоимость.
На саму сумму месячного оклада норма НЕ влияет — он начисляется за
месяц целиком. Незаполненный месяц не ломает расчёт: он падает на
`DEFAULT_MONTH_NORM_HOURS = 168` (21 × 8), экран
`/admin/payroll/calendar` подсвечивает пропуск.

DTO: `packages/shared/src/payroll-calendar.ts`. Домен:
`docs/domain.md §10.3a–10.3b`.

---

<a id="32-shopfloor"></a>
## 32. Shopfloor

Источник: `shopfloor/shopfloor.controller.ts`. Класс RBAC не задан —
доступ любой авторизованной роли.

| Метод | Путь                          | RBAC                        | Описание |
| ----- | ----------------------------- | --------------------------- | -------- |
| GET   | `/api/shopfloor/state`        | Any auth                    | Query `ShopfloorStateQuery`. Менеджерская проекция «размер × этап → qty» поверх `Order`/`Passport`/`PassportEvent`/`BoxItem`. ADR-0013. |
| GET   | `/api/shopfloor/orders`       | Any auth                    | Список активных заказов для выпадашки. |
| GET   | `/api/shopfloor/equipment`    | Any auth                    | Статусы оборудования (онлайн/предупреждение/оффлайн) по открытым сменам. **Сознательно вне `EquipmentController`** — `DISPLAY` должен видеть статус без admin-доступа. |
| GET   | `/api/shopfloor/display`      | Any auth                    | Query `ShopfloorDisplayQuery` (`{ divisionCode? }`). Единый агрегат под `/shopfloor/display`. `divisionCode` принимает любой `CompanyDivision.code`. Если параметр пуст и роль `DISPLAY` — фильтр авто-резолвится из `DisplayScreenConfig.companyDivision.code`. См. `docs/display-board.md` и `docs/domain.md §«Подразделения заказа»`. |

DTO: `packages/shared/src/shopfloor.ts`. ADR: 0007, 0013.

---

<a id="33-display-screens"></a>
## 33. Display screens

Источник: `display-screens/display-screens.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`. Сама роль `DISPLAY` сюда не пускается
сознательно (ADR — управлять учётками DISPLAY должен только менеджер).

| Метод | Путь                              | RBAC               | Описание |
| ----- | --------------------------------- | ------------------ | -------- |
| GET   | `/api/display-screens`            | SHOP_MANAGER, ADMIN | Список конфигов. Каждая запись отдаёт `companyDivisionId` и краткие реквизиты `companyDivision { id, code, name }` (`null` — для конфигов без привязки к карточке). |
| POST  | `/api/display-screens`            | SHOP_MANAGER, ADMIN | Body `CreateDisplayScreenDto`. В одной транзакции создаёт `Employee(role=DISPLAY)` + `DisplayScreenConfig` (1:1 по `employeeId`). Тело обязательно содержит `companyDivisionId` (FK на `CompanyDivision`); если карточка не найдена — 400 `COMPANY_DIVISION_NOT_FOUND`. |
| GET   | `/api/display-screens/:id`        | SHOP_MANAGER, ADMIN | Один экран для карточки `/admin/display-screens/[id]`. Форма ответа — та же, что у элемента списка. Нет экрана — 404 `DISPLAY_SCREEN_NOT_FOUND`. |
| PATCH | `/api/display-screens/:id`        | SHOP_MANAGER, ADMIN | Body `UpdateDisplayScreenDto` (`name?`, `companyDivisionId?`, `login?`, `pin?` — все необязательны, схема `.strict()`). Одной транзакцией правит ПАРУ «конфиг + учётка»: `DisplayScreenConfig.name/companyDivisionId` и `Employee.login` + **обе колонки PIN** (`pinHash` и `pinEnc`, см. «Хранение PIN» в §3b) + `fullName` (пересобирается как `Display: <имя>`). Писать здесь только `pinHash` нельзя: DISPLAY-учётка — обычная строка `Employee`, она видна в `/admin/employees/[id]`, и карточка показывала бы прежний код. Ошибки: 404 `DISPLAY_SCREEN_NOT_FOUND`, 400 `COMPANY_DIVISION_NOT_FOUND`, 409 `DISPLAY_LOGIN_TAKEN`. Пишет `AuditLog(DISPLAY_SCREEN_UPDATED)` с «было → стало» только по изменившимся полям; PIN — флагами `pinChanged: true` и `revealable`, без значения и хеша. |

`isActive` в PATCH сознательно НЕ принимается (`.strict()` вернёт 400 на
попытку): включением и выключением экрана заведует контур архива
(`POST /archive|restore` ниже), который синхронно гасит и зажигает
DISPLAY-учётку. Второй путь к тому же флагу разъехался бы с
`Employee.active`. Удаление — только `POST /purge` из архива (там же
освобождается логин учётки).

DTO: `packages/shared/src/display-screens.ts`.

---

<a id="34-dashboard"></a>
## 34. Dashboard

Источник: `dashboard/dashboard.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN', 'DISPLAY')`.

| Метод | Путь                          | RBAC                         | Описание |
| ----- | ----------------------------- | ---------------------------- | -------- |
| GET   | `/api/dashboard/production`   | SHOP_MANAGER, ADMIN, DISPLAY | Query `ProductionDashboardQuery` (`days=7|14|30`). Единый агрегатор для `/admin/production-dashboard`. |

DTO: `packages/shared/src/dashboard.ts`.

---

<a id="35-costs"></a>
## 35. Costs / production-cost-v2

Источник: `costs/costs.controller.ts`,
`costs/production-cost-v2.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')` на каждом контроллере.

| Метод | Путь                                       | RBAC               | Описание |
| ----- | ------------------------------------------ | ------------------ | -------- |
| GET   | `/api/costs/production`                    | SHOP_MANAGER, ADMIN | Query `ProductionCostQuery` (`{ dateFrom, dateTo }`). Старый отчёт «Себестоимость выпуска» по дням. Response — `ProductionCostResponseDto` (см. `packages/shared/src/costs.ts`): `days[]` + `summary`. Каждый день и summary содержат `pieceworkCost`, `salaryCost`, **`materialCost`** и `totalCost = pieceworkCost + salaryCost + materialCost`. `materialCost` = Σ `MaterialIssue.totalCost` по `POSTED`-документам, у которых `passportId` входит в множество паспортов, упакованных в этот день (`PACKED`-event внутри окна). DRAFT / CANCELLED и order-level (`passportId IS NULL`) документы фактического расхода в production cost по периоду **не включаются** — без привязки к паспорту нельзя корректно разнести расход по дню выпуска. На MVP нет ни `StockBalance`, ни автосписания при выдаче кроя, ни FIFO/LIFO. |
| GET   | `/api/admin/production-cost/v2`            | SHOP_MANAGER, ADMIN | Query `ProductionCostV2Query`. Управленческий P&L по лекалам / заказам / операциям / сотрудникам / размерам (см. `docs/production-cost-v2-recon.md`). На текущей итерации **не меняется** и материалы здесь по-прежнему берутся из `OrderCostEstimate` / `WorkshopNeed` (расчётная основа), а не из `MaterialIssue`. |

DTO: `packages/shared/src/costs.ts`,
`packages/shared/src/production-cost.ts`.

---

<a id="36-admin"></a>
## 36. Admin overview

Источник: `admin/admin.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`.

| Метод | Путь                  | RBAC               | Описание |
| ----- | --------------------- | ------------------ | -------- |
| GET   | `/api/admin/overview` | SHOP_MANAGER, ADMIN | Лёгкий операционный обзор для `/admin/overview` (активные смены, открытые коробки, паспорта в работе/в ячейках, события за 24ч). |

DTO: `AdminOverviewDto` в `packages/shared/src/admin.ts`.

---

<a id="37-diagnostics"></a>
## 37. Admin diagnostics

Источник: `diagnostics/diagnostics.controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

| Метод | Путь                                  | RBAC               | Описание |
| ----- | ------------------------------------- | ------------------ | -------- |
| GET   | `/api/admin/diagnostics/consistency`  | ADMIN, SHOP_MANAGER | Read-only диагностика консистентности (см. `docs/ops.md` — OUTDATED). Возвращает `DiagnosticConsistencyReportDto`. |

> Никаких write-методов в этом модуле быть не должно — это инвариант,
> закреплённый smoke-тестом
> `tests/smoke/diagnostics-admin.smoke.test.ts`.

---

<a id="38-defect-types"></a>
## 38. Defect types

Источник: `qc/defect-types.controller.ts`. Класс-уровень
`@Roles('QC', 'SHOP_MANAGER')` (+ ADMIN).

| Метод | Путь                  | RBAC                         | Описание |
| ----- | --------------------- | ---------------------------- | -------- |
| GET   | `/api/defect-types`   | QC, SHOP_MANAGER (+ ADMIN)   | Справочник `DefectType[]` (только `isActive`, sort by `sortOrder`). |
| POST  | `/api/defect-types`   | QC, SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Создать вид брака «на лету» из формы фиксации брака (`CreateDefectTypeSchema`: `name` обязателен, `code` опционален — без него подбирается свободный `DT-N`). `sortOrder = max + 10`. Конфликт кода → 409 `DEFECT_TYPE_CODE_TAKEN`. |

> Базовое наполнение справочника — `prisma/seed.ts`; admin-CRUD
> (деактивация/переименование) пока отсутствует.

---

<a id="39-printers"></a>
## 39. Printers

Источник: `printers/printers.controller.ts`. Класс-уровень
`@Roles('SHOP_MANAGER', 'ADMIN')`. Метод `agent-download/...` —
`@Public()`.

| Метод  | Путь                                                  | RBAC               | Описание |
| ------ | ----------------------------------------------------- | ------------------ | -------- |
| GET    | `/api/printers`                                       | SHOP_MANAGER, ADMIN | `PrinterSummaryDto[]`. |
| GET    | `/api/printers/:id`                                   | SHOP_MANAGER, ADMIN | `PrinterDetailDto`. |
| POST   | `/api/printers`                                       | SHOP_MANAGER, ADMIN | `CreatePrinterDto`. |
| PATCH  | `/api/printers/:id`                                   | SHOP_MANAGER, ADMIN | `UpdatePrinterDto`. |
| DELETE | `/api/printers/:id`                                   | SHOP_MANAGER, ADMIN | 204 No Content. |
| POST   | `/api/printers/:id/pairing-code`                      | SHOP_MANAGER, ADMIN | Сгенерировать новый одноразовый `pairingCode` для агента. |
| GET    | `/api/printers/agent-download/sewing-print-agent.exe` | Public             | Скачать собранный Windows-exe агента (`PRINT_AGENT_PATH`/`apps/agent/dist/sewing-print-agent.exe`). 404 `AGENT_BUNDLE_NOT_FOUND` если сборка не найдена. |
| GET    | `/api/printers/:id/test-page`                         | Public             | `text/html; charset=utf-8`, `cache-control: no-store`. A6-HTML с именем принтера и временем — payload для job-ов `sourceType=TEST` (агент скачивает без сессии). Объявлен ВЫШЕ `@Get(':id')` (иначе nest заматчит `:id='test-page'`). |

DTO: `packages/shared/src/printers.ts`.

---

<a id="40-print-jobs"></a>
## 40. Print jobs

Источник: `printers/print-jobs.controller.ts`.

| Метод | Путь                          | RBAC                              | Описание |
| ----- | ----------------------------- | --------------------------------- | -------- |
| POST  | `/api/print-jobs`             | Any auth (с `printerId` — только SHOP_MANAGER/ADMIN, иначе 403 `FORBIDDEN_ROLE`) | Body `CreatePrintJobDto`. Создаёт PENDING-задание. Без `printerId` — обычная пользовательская «Печать» (принтер берётся по активной смене). |
| GET   | `/api/print-jobs`             | SHOP_MANAGER, ADMIN               | Query `?printerId=<id>&limit=<n>` (default 20). Менеджерский просмотр очереди. Без `printerId` — возвращает пустой массив. |
| GET   | `/api/print-jobs/agent`       | AgentAuthGuard (`X-Printer-Agent-Token`) | Агент опрашивает свою очередь. Возвращает 0 или 1 job. |
| PATCH | `/api/print-jobs/:id`         | AgentAuthGuard                    | Body `UpdatePrintJobStatusDto` (`{ status: 'PRINTED' \| 'FAILED', errorMessage? }`). |

DTO: `packages/shared/src/printers.ts`. ADR: 0008, 0010.

---

<a id="41-printers-agent"></a>
## 41. Printers agent

Источник: `printers/printers-agent.controller.ts`.

| Метод | Путь                                              | RBAC                              | Описание |
| ----- | ------------------------------------------------- | --------------------------------- | -------- |
| POST  | `/api/printers/agent/pair`                        | Public (auth по `pairingCode` в теле) | Body `AgentPairDto`. Меняет `pairingCode` на `printerId + agentToken`. |
| POST  | `/api/printers/agent/heartbeat`                   | AgentAuthGuard                    | Возвращает `{ ok: true, selectedWindowsPrinter: string \| null }`. |
| POST  | `/api/printers/agent/windows-printers`            | AgentAuthGuard                    | Body `AgentWindowsPrintersDto` (`{ hostName, printers: string[] }`). Сохраняет список Windows-принтеров и возвращает `selectedWindowsPrinter`. |
| POST  | `/api/printers/agent/select-windows-printer`      | AgentAuthGuard                    | Body `AgentSelectWindowsPrinterDto` (`{ name }`). Оператор сам выбирает физический Windows-принтер из агентского wizard-а (`apps/agent/src/wizard.mjs`). Имя должно лежать в `availableWindowsPrinters`, иначе 422 `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`. |

DTO: `packages/shared/src/printers.ts`.

---

<a id="42-company-settings"></a>
## 42. Company settings

Источник:
- `company-settings/company-settings.controller.ts`
- `company-settings/company-divisions.controller.ts`

Класс-уровень `@Roles('SHOP_MANAGER', 'ADMIN')` на обоих контроллерах.

### 42.1 Реквизиты организации (singleton)

| Метод | Путь                       | RBAC                | Описание |
| ----- | -------------------------- | ------------------- | -------- |
| GET   | `/api/company-settings`    | SHOP_MANAGER, ADMIN | Текущие реквизиты + флаги блока «Материалы и склад» (`autoIssueMaterialsOnCutRelease`, `allowNegativeMaterialStock`). Backend идемпотентно создаёт singleton-строку, если её ещё нет (`CompanySettingsService.getOrCreate`) — в этом случае флаги отдаются со значениями Prisma-default (`false` / `true`). |
| PATCH | `/api/company-settings`    | SHOP_MANAGER, ADMIN | `UpdateCompanySettingsDto` (любое подмножество полей: legalName/shortName/INN/КПП/ОГРН/адреса/телефон/email/руководители/банк/БИК/р/с/к/с + `autoIssueMaterialsOnCutRelease?`, `allowNegativeMaterialStock?`). Audit `COMPANY_SETTINGS_UPDATED`. |

DTO: `packages/shared/src/company-settings.ts`. Audit:
`COMPANY_SETTINGS_UPDATED` (`entityType = COMPANY_SETTINGS`,
`entityId = "default"`).

Флаги блока «Материалы и склад» (рендерятся в UI
`/admin/company-settings` переключателями, см.
`apps/web/app/admin/company-settings/settings-form.tsx`). Это
**глобальные default-значения**: каждая карточка `CompanyDivision`
может их переопределить через `*Override`-поля (`null` ⇒
наследовать, см. §42.2 ниже и `docs/current-state.md §«Материалы
и склад — division overrides»`). Effective policy для конкретного
заказа считает
`CompanySettingsService.getEffectiveMaterialStockSettingsForOrder(orderId)`
(`InTx`-sibling — для горячего flow внутри транзакции).

- `autoIssueMaterialsOnCutRelease Boolean @default(false)` —
  глобальный default автосписания материалов при выдаче кроя
  (см. §20a «Material issues»). GET отдаёт текущее значение;
  PATCH принимает `true` / `false` (поле опциональное — `undefined`
  ⇒ backend не трогает).
- `allowNegativeMaterialStock Boolean @default(true)` — глобальный
  default гейта отрицательных остатков для `MaterialIssue` OUT
  (`MANUAL post` и `AUTO_CUT_ISSUE`) и OUT-корректировки
  `POST /api/stock/adjustments`; подробности и контракт ошибки 409
  `MATERIAL_STOCK_INSUFFICIENT` — в §20a «Material issues» и
  `docs/current-state.md §«Подключение расхода материалов к
  складу»`. GET отдаёт текущее значение; PATCH принимает `true` /
  `false`.

Effective policy (вместо прямого getter-а) применяется в:

- `PassportsService.issueToEmployee` — гейт автосписания по
  `passport.orderId`;
- `MaterialIssuesService.post` и `createAutoCutIssueForPassport`
  — гейт отрицательных остатков `MaterialIssue` OUT;
- `StockService.createAdjustment` OUT — гейт отрицательных
  остатков ручной корректировки (по `StockBalance → WorkshopNeed.orderId`).

`PurchaseReceipt` cancel / REVERSAL OUT сознательно остаётся
permissive и от division overrides НЕ зависит (см. §28.3).

### 42.2 Подразделения компании

| Метод | Путь                                | RBAC                | Описание |
| ----- | ----------------------------------- | ------------------- | -------- |
| GET   | `/api/company-divisions`            | SHOP_MANAGER, ADMIN | List `ListCompanyDivisionsQuery` (по умолчанию `isActive = true`, `search` по `name`/`code`). |
| POST  | `/api/company-divisions`            | SHOP_MANAGER, ADMIN | `CreateCompanyDivisionDto` (включая `*Override`-поля). 409 `COMPANY_DIVISION_CODE_TAKEN` при дубликате `code`. |
| GET   | `/api/company-divisions/:id`        | SHOP_MANAGER, ADMIN | Карточка. 404 `COMPANY_DIVISION_NOT_FOUND`. |
| PATCH | `/api/company-divisions/:id`        | SHOP_MANAGER, ADMIN | `UpdateCompanyDivisionDto` (включая `isActive` для мягкой деактивации и `*Override`-поля блока «Материалы и склад»). Hard-delete нет. |

DTO: `packages/shared/src/company-divisions.ts`. Audit:
`COMPANY_DIVISION_CREATED` / `COMPANY_DIVISION_UPDATED`
(`entityType = COMPANY_DIVISION`).

Per-division override блока «Материалы и склад» (см.
`docs/current-state.md §«Материалы и склад — division overrides»`,
`prisma/schema.prisma::CompanyDivision.{autoIssueMaterialsOnCutReleaseOverride, allowNegativeMaterialStockOverride}`):

- `autoIssueMaterialsOnCutReleaseOverride: boolean | null` — override
  глобальной `CompanySettings.autoIssueMaterialsOnCutRelease`
  для этого подразделения;
- `allowNegativeMaterialStockOverride: boolean | null` — override
  `CompanySettings.allowNegativeMaterialStock` для этого
  подразделения.

Семантика `null/true/false`:

- `null`      — **наследовать** глобальную `CompanySettings.<флаг>`
  (default после миграции у всех карточек, в т.ч. базовых
  `MARKETPLACE` / `OTHER`);
- `true`      — принудительно включить для подразделения;
- `false`     — принудительно выключить для подразделения;
- `undefined` — PATCH поле не трогает (стандартный контракт).

PATCH умеет и поставить конкретный `true`/`false`, и сбросить
override в `null` (вернуть «наследовать»). Для override-only PATCH
(`{ autoIssueMaterialsOnCutReleaseOverride: null }`) refine-гвард
«Нечего обновлять» НЕ срабатывает. Effective policy для
конкретного заказа считает
`CompanySettingsService.getEffectiveMaterialStockSettingsForOrder(orderId)`
(см. §42.1). UI этих override-ов живёт в карточке «Настройки по
подразделениям» на `/admin/company-settings`
(`material-stock-division-overrides-section.tsx`) — отдельная
страница / новый route / пункт sidebar **не создавались**.

> Пример B2B: `CompanyDivision(code='OTHER')` с
> `autoIssueMaterialsOnCutReleaseOverride = true`,
> `allowNegativeMaterialStockOverride = false` — в заказах этого
> подразделения крой автосписывается, минус на остатках запрещён,
> независимо от глобальных настроек.

> **Не путать с компанией / `CompanySettings`** — это master-справочник
> подразделений, см. `docs/domain.md §«Подразделения заказа»`.
> `CompanyDivision` — структурное подразделение компании (цех,
> склад, бухгалтерия). Карточки `MARKETPLACE` / `OTHER` создаются
> миграцией / seed-ом и используются `EarningsService` для выбора
> схемы начисления закройщика; менеджер может расширять справочник
> через UI без миграции.

---

<a id="43-archive"></a>
## 43. Архив справочников (archive / restore / purge)

Единый контракт «сначала архив, потом безвозвратное удаление» для
справочников админки. Контракт — `packages/shared/src/archive.ts`
(`BulkArchiveRequestSchema`, `BulkArchiveResultDto`), общая механика на
backend — `apps/api/src/common/bulk-archive.ts`, UI — `AdminArchiveTabs`
+ `BulkArchiveProvider` (`apps/web/components/admin`).

У всех разделов одинаковые три ручки:

| Метод | Путь                 | Описание |
| ----- | -------------------- | -------- |
| POST  | `{base}/archive`     | Мягкая архивация. Обратимо, данные сохраняются. Идемпотентно. |
| POST  | `{base}/restore`     | Возврат из архива. Идемпотентно. |
| POST  | `{base}/purge`       | Безвозвратное удаление. **Только из архива** + гейт раздела «используется». |

Тело — `{ "ids": ["…"] }` (1..1000). Ответ — частичный успех:
`{ "processed": ["…"], "skipped": [{ "id", "reason", "detail"? }] }`,
где `reason` ∈ `NOT_FOUND` | `NOT_ARCHIVED` | `IN_USE` | `FORBIDDEN`.
4xx прилетает только на невалидное тело или RBAC.

| Раздел | `{base}` | Признак архива | Гейт `purge` |
| ------ | -------- | -------------- | ------------ |
| Номенклатура | `/api/patterns` | `status = ARCHIVED` | ссылки заказов (`Order.patternItemId`) |
| Техкарты | `/api/tech-cards` | `isActive = false` | заказы, расцветки заказов, снимки строк в потребностях |
| Маршруты | `/api/routes` | `isActive = false` | заказы, пробники (`OrderSample`) |
| Операции | `/api/operations` | `active = false` | `GET :id/blockers` (история/маршруты/substitute). `purge` — `ADMIN`-only |
| Заявки конструктору | `/api/constructor-tasks` | `archivedAt != null` | — (строки размеров и вложения уходят каскадом; лекало остаётся) |
| Цеховой монитор | `/api/display-screens` | `isActive = false` | — (archive гасит DISPLAY-учётку, purge удаляет и её) |
| Оборудование | `/api/equipment` | `active = false` | смены, события паспортов, вызовы мастера |
| Принтеры | `/api/printers` | `isActive = false` | — (очередь `PrintJob` уходит каскадом) |
| Сотрудники | `/api/employees` | `active = false` | гейты раздела (история, «нельзя на себе», последний админ, экран цеха). `purge` — `ADMIN`-only |
| Поставщики | `/api/suppliers` | `status = INACTIVE` | заказы поставщикам |

Полный список путей (для инвентаризации и `npm run docs:check`):

| Метод | Путь | RBAC | Описание |
| ----- | ---- | ---- | -------- |
| POST | `/api/patterns/archive` | ADMIN, SHOP_MANAGER | Номенклатура: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/patterns/restore` | ADMIN, SHOP_MANAGER | Номенклатура: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/patterns/purge` | ADMIN, SHOP_MANAGER | Номенклатура: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/tech-cards/archive` | ADMIN, SHOP_MANAGER | Техкарты: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/tech-cards/restore` | ADMIN, SHOP_MANAGER | Техкарты: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/tech-cards/purge` | ADMIN, SHOP_MANAGER | Техкарты: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/routes/archive` | ADMIN, SHOP_MANAGER | Маршруты: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/routes/restore` | ADMIN, SHOP_MANAGER | Маршруты: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/routes/purge` | ADMIN, SHOP_MANAGER | Маршруты: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/operations/archive` | ADMIN, SHOP_MANAGER | Операции: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/operations/restore` | ADMIN, SHOP_MANAGER | Операции: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/operations/purge` | **ADMIN** | Операции: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/constructor-tasks/archive` | ADMIN, SHOP_MANAGER | Заявки конструктору: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/constructor-tasks/restore` | ADMIN, SHOP_MANAGER | Заявки конструктору: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/constructor-tasks/purge` | ADMIN, SHOP_MANAGER | Заявки конструктору: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/display-screens/archive` | ADMIN, SHOP_MANAGER | Цеховой монитор: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/display-screens/restore` | ADMIN, SHOP_MANAGER | Цеховой монитор: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/display-screens/purge` | ADMIN, SHOP_MANAGER | Цеховой монитор: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/equipment/archive` | ADMIN, SHOP_MANAGER | Оборудование: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/equipment/restore` | ADMIN, SHOP_MANAGER | Оборудование: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/equipment/purge` | ADMIN, SHOP_MANAGER | Оборудование: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/printers/archive` | ADMIN, SHOP_MANAGER | Принтеры: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/printers/restore` | ADMIN, SHOP_MANAGER | Принтеры: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/printers/purge` | ADMIN, SHOP_MANAGER | Принтеры: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/employees/archive` | ADMIN, SHOP_MANAGER | Сотрудники: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/employees/restore` | ADMIN, SHOP_MANAGER | Сотрудники: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/employees/purge` | **ADMIN** | Сотрудники: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/suppliers/archive` | ADMIN, SHOP_MANAGER | Поставщики: мягкая архивация. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/suppliers/restore` | ADMIN, SHOP_MANAGER | Поставщики: возврат из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/suppliers/purge` | ADMIN, SHOP_MANAGER | Поставщики: безвозвратное удаление из архива. Тело `BulkArchiveRequestDto`, ответ `BulkArchiveResultDto`. |
| POST | `/api/employees/:id/archive` | SHOP_MANAGER, ADMIN | Одиночная архивация карточки сотрудника (была до общего контракта; bulk выше её и вызывает). |
| POST | `/api/employees/:id/restore` | SHOP_MANAGER, ADMIN | Одиночный возврат карточки сотрудника из архива. |
| POST | `/api/workshop-needs/archive` | ADMIN, SHOP_MANAGER | Архив расчётов цеха — предшественник этого контракта: единица операции ЗАКАЗ, тело `{ orderIds }`, свои причины пропуска (см. `@sewing/shared/workshop-needs`). |
| POST | `/api/workshop-needs/restore` | ADMIN, SHOP_MANAGER | Вернуть заказ(ы) в список потребностей. |
| POST | `/api/workshop-needs/purge` | ADMIN, SHOP_MANAGER | Безвозвратно стереть просчёт заказа (варианты + строки потребности); сам заказ остаётся. |

Одиночные пути, где они уже были, сохранены и подчиняются той же
политике: `DELETE /api/patterns/:id/permanent`,
`DELETE /api/tech-cards/:id/permanent`, `DELETE /api/routes/:id`
(теперь 409 `ROUTE_TEMPLATE_DELETE_FORBIDDEN` для активного шаблона или
используемого заказами), `DELETE /api/printers/:id`
(409 `PRINTER_DELETE_FORBIDDEN` для активного), `DELETE /api/operations/:id`
и `DELETE /api/employees/:id` (`ADMIN`-only, с preflight `:id/blockers`),
`DELETE /api/suppliers/:id`.

Аудит: `<X>S_ARCHIVED` / `<X>S_RESTORED` (одно событие на пачку) и
`<X>_DELETED` на каждую удалённую запись (`payload.bulk = true`).

---

## 44. Правка заказа в производстве (order amendments)

Второй, узкий ярус редактируемости заказа: после `start()` план заморожен
(ADR-0006), но аддитивные forward-only правки разрешены. Фича под флагом
`FEATURE_ORDER_AMENDMENTS`. Контракт — `packages/shared/src/amendments.ts`,
backend — `order-amendments/order-amendments.controller.ts`, UI — drawer
«Изменить в производстве» (`components/orders/amendments/*`).

Write-ручки пишут запись в журнал правок (`GET .../history`). Правки
количества и размерности работают только когда заказ в `IN_PRODUCTION`
(иначе 409 `ORDER_NOT_AMENDABLE`) и требуют `reason`.

**Правка маршрута — исключение.** Её окно — `ORDER_ROUTE_EDITABLE_STATUSES`
(всё, кроме `DONE` / `CANCELLED`): состав операций меняют и на расчёте, и
на ходу в цеху. Один и тот же холст обслуживает оба сценария — разделяет их
не статус, а фронт производства: до запуска паспортов нет,
`frontierIndex = −1`, замороженный префикс пуст и правится вся цепочка.
`reason` там обязателен только у запущенного заказа (`started = true` в
GET-состоянии), иначе 400 `AMENDMENT_REASON_REQUIRED`.

| Метод | Путь                                    | RBAC                | Описание |
| ----- | --------------------------------------- | ------------------- | -------- |
| GET   | `/api/orders/:id/amendments/quantities` | любая авторизованная| План и уже раскроенное по размерам. |
| POST  | `/api/orders/:id/amendments/quantities` | ADMIN, SHOP_MANAGER | Правка планового тиража. 409 `AMENDMENT_BELOW_CUT` ниже раскроя. |
| GET   | `/api/orders/:id/amendments/sizes`      | любая авторизованная| Текущая и доступная размерность. |
| POST  | `/api/orders/:id/amendments/sizes`      | ADMIN, SHOP_MANAGER | Добавить / убрать размеры. 409 `AMENDMENT_SIZE_HAS_WORK`. |
| GET   | `/api/orders/:id/amendments/operations` | любая авторизованная| Снимок маршрута + фронт производства + палитра операций. |
| POST  | `/api/orders/:id/amendments/operations` | ADMIN, SHOP_MANAGER | Вставить одну операцию (`afterIndex`). Legacy-путь. |
| PUT   | `/api/orders/:id/amendments/route`      | ADMIN, SHOP_MANAGER | Правка маршрута целиком: состав, порядок, параллельные группы. |
| GET   | `/api/orders/:id/amendments/history`    | любая авторизованная| Журнал правок с готовым `summary`. |

### 44.1 `PUT /api/orders/:id/amendments/route`

Тело — **весь целевой маршрут**, а не дельта: холст остаётся источником
истины «как должно быть», а что добавлено / убрано / переставлено, считает
бэкенд (`planRouteAmendment`, чистая функция в shared, покрыта
`tests/unit/route-amendment-plan.test.ts`).

Точки входа в холст — две, ручка одна:

- кнопка **«Изменить маршрут»** в карточке «Маршрут операций» вкладки
  «Производство» — окно `ORDER_ROUTE_EDITABLE_STATUSES`;
- вкладка **«Маршрут»** drawer-а «Изменить в производстве» — только
  `IN_PRODUCTION`, рядом с количеством и размерностью.

```json
{
  "steps": [
    { "operationId": "…", "parallelGroup": null },
    { "operationId": "…", "parallelGroup": 1 },
    { "operationId": "…", "parallelGroup": 1 }
  ],
  "reason": "клиент попросил ОТК перед упаковкой"
}
```

Инварианты (проверяются до записи):

- **Замороженный префикс.** Шаги с `index <= frontierIndex`
  (`frontierIndex` = максимальный `Passport.currentRouteStepIndex`) обязаны
  прийти теми же и в том же порядке, включая `parallelGroup`. Иначе 409
  `AMENDMENT_ROUTE_FRONTIER_CHANGED` — как правило, это гонка: пока
  менеджер собирал маршрут, фронт уехал вперёд.
- **Удаление** шага допустимо только впереди фронта И когда по его
  операции в заказе нет ни одной записи выработки (`OperationEntry`),
  иначе 409 `AMENDMENT_ROUTE_STEP_HAS_WORK`.
- **Дубли** операции в маршруте запрещены (409
  `AMENDMENT_OPERATION_ALREADY_IN_ROUTE`): доска и подстановки дедуплят по
  `operationId`.
- Новая операция должна быть активной в справочнике (400
  `AMENDMENT_OPERATION_INACTIVE`).

`Passport.currentRouteStepIndex` не трогается: по построению ни один
паспорт не стоит правее фронта, а меняется только хвост за ним. После
перекладки индексов вызывается `rebuildRouteDerivedSnapshotsInTx` —
плановая стоимость и время пересчитываются по снимку. Снимок материалов
при этом НЕ пересобирается: состав операций на него не влияет, а окно
правки включает `CALCULATION_DONE`, где потребности уже отработал
закупщик. Аудит — `ORDER_ROUTE_AMENDED` с человекочитаемым `summary`.

**`Order.routeCustomizedAt`.** Успешная правка проставляет эту отметку, и
с этого момента снимок `OrderRouteStep[]` главнее шаблона:
`syncOrderRouteStepsSnapshot` перестаёт пересобирать маршрут из
`RouteTemplate`, а `recalculateAndWrite` считает план по снимку. Без этого
первая же «Пересчитать план операций» на расчёте молча вернула бы маршрут
к шаблону. Побочные следствия, видимые пользователю:

- правки шаблона в справочнике до такого заказа больше не доезжают
  (в UI — пометка «изменён в заказе» рядом с названием шаблона,
  `OrderDetailDto.routeCustomized`);
- `RouteTemplate.updatedAt` исключается из источников stale-detection,
  иначе висел бы неснимаемый badge «план операций устарел».

Отметка снимается, когда менеджер выбирает в заказе **другой** шаблон
маршрута (включая сброс на «без маршрута»); повторная отправка того же
`routeTemplateId` из формы редактирования её не трогает.

Ответ:

```json
{
  "orderId": "…", "applied": true,
  "addedCount": 1, "removedCount": 0, "movedCount": 2,
  "summary": "+ «Упаковка» после «Раскрой»; «ОТК» → шаг 3",
  "warnings": []
}
```

`applied: false` + предупреждение — маршрут не изменился (no-op, аудита нет).

---

## Что отсутствует в API (умышленно или legacy)

PHASE 1 явно фиксирует:

- **Нет `/api/movements/*`.** Старая legacy-секция «Перемещения»
  удалена. Реальный поток scan-driven вход — это
  `POST /api/passports/:id/scan` /
  `POST /api/passports/:id/complete-operation`. Любой документ /
  комментарий, упоминающий `/api/movements/*`, считается устаревшим.
- **Нет CRUD `Product`.** Создание Product выполняется неявно через
  `OrdersService.ensureLegacyProductForPattern()`; PATCH/POST/DELETE
  для `Product` контроллеры не выставляют.
- **Нет общего `/api/audit-log/*`.** `AuditLog` пишется внутри
  транзакций (`AuditService.log`), но read-API на MVP не выставлен.
- **Нет `/api/passports/:id/qc/*` / `/api/passports/:id/wto/*`.**
  Раздельные role-terminal-эндпоинты живут под
  `/api/qc/passports/:id/*` и `/api/wto/passports/:id/*`.
- **Нет `/api/equipment` без авторизации.** `GET /api/equipment` —
  это admin/manager surface; поток `/work` смотрит оборудование через
  `GET /api/shifts/meta` (Any auth).
- **Нет `/api/orders/:id/cost-estimate/*` отдельным ресурсом.**
  Расчёт-себестоимости управляется action-эндпоинтами на самом
  заказе (`/start-calculation`, `/complete-calculation`,
  `/reopen-calculation`).
- **Нет `/api/agent-download/*` для linux/mac.** Скачивается только
  Windows-exe (`/api/printers/agent-download/sewing-print-agent.exe`).

---

## Команды быстрой инвентаризации

```bash
rg "@(Controller|Get|Post|Patch|Delete|Put)\(" apps/api/src/modules
rg "@Roles\("                                    apps/api/src/modules
rg "@Public\(\)"                                 apps/api/src/modules
rg "@UseGuards\("                                apps/api/src/modules
```

---

## Ошибки и коды (общие соглашения)

- 400 `VALIDATION_ERROR` — Zod-валидация (тело/query).
- 401 `UNAUTHENTICATED` — нет/невалидная сессия.
- 403 `FORBIDDEN_ROLE` — RBAC не пройден.
- 403 `EMPLOYEE_INACTIVE` — учётка деактивирована.
- 404 `<RESOURCE>_NOT_FOUND` — резерв-агрегат не найден.
- 409 `<RESOURCE>_<STATE>` — нарушение бизнес-инварианта
  (`ORDER_LOCKED`, `CUTTING_CLOSED`,
  `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`,
  `OUTSOURCE_NOT_READY_TO_ORDER`,
  `ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED`,
  `WAREHOUSE_NO_CELLS_TO_PRINT`, `PRINTER_INACTIVE`,
  `CUT_RELEASE_POLICY_NOT_FOUND`, `OPERATION_RATE_NOT_FOUND`, …).

Полный список — `apps/api/src/common/errors.ts` и
`apps/api/src/common/global-exception.filter.ts`.
