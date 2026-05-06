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
- [22. Master calls](#22-master-calls)
- [23. Master actions](#23-master-actions)
- [24. Passports](#24-passports)
- [25. Cells](#25-cells)
- [26. Warehouses](#26-warehouses)
- [26a. Stock (read-only)](#26a-stock)
- [27. QC](#27-qc)
- [28. WTO](#28-wto)
- [29. Packing](#29-packing)
- [30. Earnings](#30-earnings)
- [30a. Payroll (PHASE 1, read-only)](#30a-payroll)
- [31. Salary](#31-salary)
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

UI-потребители: `apps/web/components/employees/employee-qr-button.tsx`
(клиентская кнопка + модалка с `qrcode.react`), server-обёртка
`apps/web/lib/employee-qr-api.ts`, action
`apps/web/app/employee-qr/actions.ts`.

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
| POST  | `/api/employees`           | SHOP_MANAGER, ADMIN | Body `CreateEmployeeDto`. Создаёт карточку (с `pinHash` через bcrypt). PHASE 2 STEP 2: тело принимает опциональный `companyDivisionId`; если карточка не найдена — 404 `COMPANY_DIVISION_NOT_FOUND`, если soft-deleted — 409 `COMPANY_DIVISION_INACTIVE`. |
| GET   | `/api/employees/cutters`   | CUTTER_ASSISTANT, SHOP_MANAGER, ADMIN | Узкий справочник активных раскройщиков для select-а на форме выпуска паспорта. Hard-coded `role = CUTTER` AND `active = true`, sort `fullName ASC`. Ответ — `ActiveCutterListItemDto[]`, поля только `{ id, fullName, login }` (не отдаёт payroll-поля). См. RECON `docs/cutter-assistant-passport-release-recon.md §5`. |
| GET   | `/api/employees/:id`       | SHOP_MANAGER, ADMIN | Карточка сотрудника. PHASE 2 STEP 2: ответ включает `companyDivisionId` и краткие `companyDivision { id, code, name }` (`null` без привязки). |
| PATCH | `/api/employees/:id`       | SHOP_MANAGER, ADMIN | Body `UpdateEmployeeDto`. Правит management-поля. PHASE 2 STEP 2: поддерживает `companyDivisionId` (`null` — снять привязку, ID — переставить; те же 404/409, что и POST). |
| GET   | `/api/employees/:id/print` | Public             | HTML-этикетка с QR `EMPLOYEE:<id>`. Используется на `/master`. |
| GET   | `/api/employees/:id/qr`    | Public             | PNG QR (`EMPLOYEE:<id>`, см. `EMPLOYEE_QR_PREFIX`). |

DTO: `packages/shared/src/employees.ts`.

Side effects: `update` может менять `compensationType`,
`salaryPerShift`, `cutterB2bSewingPercent` — мгновенно влияет на
sync-логику окладной (`SalaryService.syncDailyForEmployee`) при
следующем старте/стопе смены.

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
| POST  | `/api/operations`     | SHOP_MANAGER, ADMIN | `CreateOperationDto`. Поддерживает `pricingMode` (`FIXED` / `BY_SIZE` / `SALARY_ONLY`), `timeNormMode` (`FIXED`/`BY_SIZE`), плановые `salaryPlanRubPerShift` / `salaryPlanShiftSeconds`. |
| GET   | `/api/operations/:id` | SHOP_MANAGER, ADMIN | `OperationDetailDto`. |
| PATCH | `/api/operations/:id` | SHOP_MANAGER, ADMIN | `UpdateOperationDto`. Полный full-replace по `OperationRateBySize` / `OperationTimeNormBySize` для соответствующих режимов. |

> Read-only `GET /api/sizes` уже отдаёт справочник для редактирования
> ставок/норм; отдельных endpoints для `OperationRateBySize` /
> `OperationTimeNormBySize` нет — они правятся через PATCH `/operations/:id`.

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
| PUT    | `/api/patterns/:id/material-areas`                    | ADMIN, SHOP_MANAGER | Bulk-replace `PatternMaterialArea[]`. |
| PUT    | `/api/patterns/:id/parameter-norms`                   | ADMIN, SHOP_MANAGER | Bulk-replace `PatternItemParameterNorm[]` (для `inputType = QTY_PER_ITEM`). |
| PUT    | `/api/patterns/:id/size-parameter-values`             | ADMIN, SHOP_MANAGER | Bulk-replace `PatternItemSizeParameterValue[]` (для `inputType = LINEAR_M_BY_SIZE`). |

DTO: `packages/shared/src/patterns.ts`. Audit: `PATTERN_*`.

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
| DELETE | `/api/pattern-categories/:id`                     | ADMIN, SHOP_MANAGER | Soft-archive (`status = ARCHIVED`). |

DTO: `packages/shared/src/pattern-categories.ts`.

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
| POST  | `/api/orders`                                                              | SHOP_MANAGER (+ ADMIN)              | `CreateOrderDto`. Создаёт заказ в `DRAFT`. Тело принимает `companyDivisionId` — FK на master-справочник `CompanyDivision` (см. `docs/domain.md §«Подразделения заказа»`). Поле опциональное и nullable: если не задано, заказ создаётся без подразделения. Если карточка не найдена — 400 `COMPANY_DIVISION_NOT_FOUND`. Side effects: при наличии `routeTemplateId` сразу синхронизирует `OrderRouteStep[]`; при наличии `techCardId` — `OrderMaterialRequirement[]`/`OrderOutsourceRequirement[]`; пересчитывает плановый snapshot операций. |
| GET   | `/api/orders`                                                              | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | List `ListOrdersQuery`. PHASE 1: каждая запись отдаёт `companyDivisionId` и краткие реквизиты `companyDivision { id, code, name }` (`null` для исторических заказов). |
| GET   | `/api/orders/:id`                                                          | SHOP_MANAGER, CUTTER_ASSISTANT (+ ADMIN) | `OrderDetailDto`. Derived: `isCutReadyForOrder`, `isReadyToOrder` для outsource-строк, композитный `displayStatus`. PHASE 1: добавляет `companyDivisionId` и краткие `companyDivision { id, code, name }`. |
| PATCH | `/api/orders/:id`                                                          | SHOP_MANAGER (+ ADMIN)              | `UpdateOrderDto`. Разрешён только в `DRAFT` / `CALCULATION` (см. `ORDER_LOCKED`). Смена `companyDivisionId` — «опасное» поле под тот же ORDER_LOCKED-guard; backend проверяет существование карточки (400 `COMPANY_DIVISION_NOT_FOUND`). При смене `routeTemplateId` / `items` / `patternItemId` пересинхронизирует snapshot маршрута и план операций (см. ADR-0022). |
| POST  | `/api/orders/:id/start`                                                    | SHOP_MANAGER (+ ADMIN)              | Перевод `DRAFT`/`CALCULATION`/`CALCULATION_DONE` → `IN_PRODUCTION`. Defensive fallback на snapshot для legacy-заказов. |
| POST  | `/api/orders/:id/start-calculation`                                        | SHOP_MANAGER (+ ADMIN)              | `DRAFT → CALCULATION`. Side effects: вызывает `WorkshopNeedsService.calculateForOrder` (создаёт `WorkshopNeed[]`), фиксирует план операций. Ошибки: `ORDER_PATTERN_REQUIRED` (400), `ORDER_TECH_CARD_REQUIRED` (400), `ORDER_ITEMS_REQUIRED` (400), `ORDER_INVALID_STATUS_TRANSITION` (409). |
| POST  | `/api/orders/:id/complete-calculation`                                     | SHOP_MANAGER (+ ADMIN)              | `CALCULATION → CALCULATION_DONE`. Body `CompleteOrderCalculationDto` (`{ usdRateRub?, comment? }`). Создаёт `OrderCostEstimate(status=COMPLETED)`, выставляет `Order.costEstimate*Snapshot`-поля. |
| POST  | `/api/orders/:id/reopen-calculation`                                       | SHOP_MANAGER (+ ADMIN)              | `CALCULATION_DONE → CALCULATION`. Body `ReopenOrderCalculationDto` (`{ reason? }`). Активный `OrderCostEstimate` помечает `REVOKED`, `Order.costEstimate*` обнуляет; `WorkshopNeed`/`PurchaseOrder`/`PurchaseReceipt` НЕ трогает. |
| POST  | `/api/orders/:id/operation-plan/recalculate`                               | SHOP_MANAGER (+ ADMIN)              | Ручной пересчёт snapshot-полей `Order.operationCostPlanRub` / `operationTimePlanSec` / `operationPlanWarnings`. Запрещено в `CALCULATION_DONE` / `IN_PRODUCTION` / `DONE` / `CANCELLED` (`ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`). |
| GET   | `/api/orders/:id/production-balance`                                       | SHOP_MANAGER (+ ADMIN)              | Computed-эндпоинт. Query: `strategy` (`LINE_BALANCE` / `TARGET_SHIFT` / `TOTAL_WORKERS` / `TARGET_DURATION`), `shiftSeconds`, `totalWorkers`, `targetDurationSec`. Ничего в БД не пишет. Response — DTO с рекомендацией штата по операциям. |
| POST  | `/api/orders/:id/complete`                                                 | SHOP_MANAGER (+ ADMIN)              | `IN_PRODUCTION → DONE`. |
| POST  | `/api/orders/:id/cancel`                                                   | SHOP_MANAGER (+ ADMIN)              | `DRAFT`/`IN_PRODUCTION` → `CANCELLED`. |
| POST  | `/api/orders/:id/outsource-requirements/:requirementId/status`             | SHOP_MANAGER (+ ADMIN)              | Body `UpdateOrderOutsourceRequirementStatusDto` (`{ executionStatus: 'ORDERED' \| 'RECEIVED' }`). Линейные переходы `PLANNED → ORDERED → RECEIVED`. Для `triggerType=CUT_READY` `PLANNED → ORDERED` блокируется до фактического размещения кроя (`OUTSOURCE_NOT_READY_TO_ORDER`). Идемпотентно. |
| PATCH | `/api/orders/:id/material-requirements/:requirementId/color`               | SHOP_MANAGER (+ ADMIN)              | Body `UpdateOrderMaterialRequirementColorDto` (`{ selectedColorText }`). Только для строк с `requiresColorSelection = true` (`ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED` иначе). |

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
| GET   | `/api/workshop-needs`                             | ADMIN, SHOP_MANAGER | List `ListWorkshopNeedsQuery`. |
| GET   | `/api/workshop-needs/:id`                         | ADMIN, SHOP_MANAGER | Карточка. |
| PATCH | `/api/workshop-needs/:id`                         | ADMIN, SHOP_MANAGER | `UpdateWorkshopNeedDto`. Закупщик правит `purchaseQty`/`quotedPrice`/`quotedCurrency`/`expectedDeliveryDate`/`selectedSupplierId`/`selectedSupplierCatalogItemId`/`comment`. |
| POST  | `/api/workshop-needs/:id/cancel`                  | ADMIN, SHOP_MANAGER | `status → CANCELLED`. |
| POST  | `/api/orders/:id/workshop-needs/calculate`        | ADMIN, SHOP_MANAGER | Body `CalculateWorkshopNeedsDto`. Пересчёт потребностей конкретного заказа. |
| GET   | `/api/orders/:id/workshop-needs`                  | ADMIN, SHOP_MANAGER | Список потребностей одного заказа (фильтр `orderCalculationStatus = ALL`). |

DTO: `packages/shared/src/workshop-needs.ts`.

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
| POST  | `/api/purchase-orders/from-needs`                 | ADMIN, SHOP_MANAGER | 201 Created. Body `CreatePurchaseOrderFromNeedsDto`. Один PO — один поставщик; запрещено смешивать заказы покупателя. |
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

| Метод | Путь                                              | RBAC               | Описание |
| ----- | ------------------------------------------------- | ------------------ | -------- |
| GET   | `/api/material-issues`                            | ADMIN, SHOP_MANAGER | List `ListMaterialIssuesQuery` (фильтры `orderId`/`passportId`/`status`). Сортировка `createdAt desc`. |
| GET   | `/api/material-issues/:id`                        | ADMIN, SHOP_MANAGER | Карточка документа (с `lines`, `order`, `passport`, `workshopNeed` и `cell` по строкам). |
| POST  | `/api/material-issues`                            | ADMIN, SHOP_MANAGER | 201 Created. Body `CreateMaterialIssueDto`. Создаёт документ со `status = DRAFT`. `totalCost` считается на сервере = Σ `issuedQty × unitCost`. Если `workshopNeedId` указан, `description`/`unit`/`materialRole` берутся из `WorkshopNeed`. НЕ создаёт `StockMovement` — склад пишется только при проведении (`/post`). |
| POST  | `/api/material-issues/:id/post`                   | ADMIN, SHOP_MANAGER | `DRAFT → POSTED`. Пересчитывает `totalCost` по строкам. Side effects: для каждой `MaterialIssueLine` с `workshopNeedId`, `unit` и `issuedQty > 0` в той же транзакции пишется исходящий `StockMovement` (`OUT`, `type = MATERIAL_ISSUE`, `sourceKey = MATERIAL_ISSUE_LINE:<lineId>`) через `StockService.recordMaterialIssueInTx` и `StockBalance.qty` уменьшается. Реакция на нехватку остатка управляется флагом `CompanySettings.allowNegativeMaterialStock` (default `true` — минус допустим; `false` — 409 `MATERIAL_STOCK_INSUFFICIENT` с `details = { workshopNeedId, warehouseId, cellId, requestedQty, availableQty, unit, description }`, транзакция целиком откатывается, документ остаётся `DRAFT`, OUT не пишется, `StockBalance` не меняется). `MaterialIssue.totalCost` НЕ пересчитывается по складской стоимости. |
| POST  | `/api/material-issues/:id/cancel`                 | ADMIN, SHOP_MANAGER | Body `CancelMaterialIssueDto` (`{ reason? }`). `DRAFT → CANCELLED`. POSTED отменить нельзя — 409 `MATERIAL_ISSUE_POSTED_CANNOT_CANCEL`. Cancel DRAFT не пишет `StockMovement`. Для отката POSTED — отдельный эндпоинт `/return` (см. ниже). |
| POST  | `/api/material-issues/:id/return`                 | ADMIN, SHOP_MANAGER | Body `ReturnMaterialIssueDto` (`{ reason, clientRequestId? }`). Полное сторно проведённого расхода. Создаёт отдельный документ `MaterialIssueReturn` (status `POSTED`) + строки + `StockMovement` (`IN`, `type = REVERSAL`, `sourceKey = MATERIAL_ISSUE_RETURN_LINE:<id>`) на исходный `warehouseId/cellId` OUT-движения. Исходный `MaterialIssue` НЕ удаляется и НЕ меняет статус. Идемпотентность: `MaterialIssueReturn.sourceKey = MATERIAL_ISSUE_RETURN[_FULL]:<materialIssueId>[:<clientRequestId>]` (UNIQUE) — повторный submit с тем же `clientRequestId` возвращает существующий return. Ошибки: 409 `MATERIAL_ISSUE_RETURN_ONLY_POSTED` для не-POSTED; 409 `MATERIAL_ISSUE_ALREADY_RETURNED`, если все строки уже возвращены. Финансовая стоимость возврата (`unitCost × returnedQty`) уменьшает `netTotalCost` исходного `MaterialIssue` в list/detail-DTO и в order summary. Возврат фигурирует в `GET /api/stock/movements` как `type = REVERSAL` (`direction = IN`). `clientRequestId` ≤ 128 символов, `reason` 2..500. |
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
- частичный возврат с произвольным qty не реализован — UI отдаёт
  только полное сторно остатка (сервер сам считает остаток к возврату
  по каждой строке как `MaterialIssueLine.issuedQty − Σ ранее
  возвращённое`);
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

<a id="22-master-calls"></a>
## 22. Master calls

Источник: `master-calls/master-calls.controller.ts`.
Класс-уровень `@Roles('SEAMSTRESS', 'CUTTER', 'CUTTER_ASSISTANT', 'QC',
'IRONING', 'PACKING', 'SHOPFLOOR_MASTER', 'SHOP_MANAGER')`.

| Метод | Путь                                                 | RBAC                            | Описание |
| ----- | ---------------------------------------------------- | ------------------------------- | -------- |
| POST  | `/api/master-calls`                                  | Все рабочие роли + SHOPFLOOR_MASTER + SHOP_MANAGER (+ ADMIN) | Body `CreateMasterCallDto`. Идемпотентно по сотруднику: если уже есть `OPEN`, возвращает его. Side effects: backend подтягивает `equipmentId`/`operationId` из активной `ShiftSession`. |
| GET   | `/api/master-calls`                                  | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Список открытых вызовов. |
| POST  | `/api/master-calls/resolve-by-employee-qr`           | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `ResolveMasterCallByQrDto` (`{ qr: 'EMPLOYEE:<id>' }`). Закрывает `OPEN`-вызов сотрудника. |

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
| POST  | `/api/master-actions/passports/:id/transfer-to-employee`              | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `TransferPassportDto` (`{ employeeId, reason }`). Переназначает паспорт. |
| POST  | `/api/master-actions/passports/:id/return-to-cell`                    | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `ReturnPassportToCellDto` (`{ cellId, reason }`). Возвращает паспорт в активную ячейку. |
| POST  | `/api/master-actions/passports/:id/set-route-step`                    | SHOPFLOOR_MASTER, SHOP_MANAGER (+ ADMIN) | Body `SetRouteStepDto` (`{ index, reason }`). Назначает паспорт на конкретный шаг snapshot маршрута. |

DTO: `packages/shared` (re-export через `@sewing/shared`).

---

<a id="24-passports"></a>
## 24. Passports

Источник: `passports/passports.controller.ts` +
`passports/order-passports.controller.ts`.

| Метод | Путь                                          | RBAC                                  | Описание |
| ----- | --------------------------------------------- | ------------------------------------- | -------- |
| POST  | `/api/passports`                              | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Body `CreatePassportDto`. В одной транзакции: создаёт паспорт, фиксирует `PassportEvent(CREATED)`, генерирует `OperationEntry(IMMEDIATE)` для раскройщика (ADR-0005). PHASE 2 STEP 3 — требуется явная атрибуция раскройщика: `cutterId` обязателен для не-CUTTER ролей (`CUTTER_REQUIRED`); если creator — CUTTER, `cutterId` опционален и по умолчанию атрибутируется creator-у. См. §«Cutter attribution» ниже. Ошибки: 400 `CUTTER_REQUIRED` / `CUTTER_NOT_FOUND` / `CUTTER_INACTIVE`, 409 `CUTTING_CLOSED` для `APPROVED` заявки на закрытие раскроя. |
| GET   | `/api/passports/my-recent`                    | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Список последних 100 паспортов, выпущенных самим actor-ом (`creatorId === me.employeeId`). Источник «Выпущенные паспорта» помощника раскройщика (`/work/passports`). Возвращает `MyPassportListItem[]` с пред-вычисленным `editable`/`editableBlockReason` — UI гасит «Редактировать»/«Удалить» на двинувшихся паспортах. |
| GET   | `/api/passports/:id`                          | Any auth                              | Карточка паспорта. |
| PATCH | `/api/passports/:id`                          | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Body `UpdatePassportDto` (любая комбинация `sizeId` / `cutDate` / `qtyCut` / `rollNumber` / `cutterId`). В одной транзакции: чистит immediate-начисление раскройщика (`sourceEventType=PASSPORT_CREATED`), обновляет поля паспорта, переписывает `PassportEvent(CREATED)` и пересоздаёт начисление через `EarningsService.createImmediateForCutter` (новый размер/количество/раскройщик). Ошибки: 403 `PASSPORT_NOT_YOURS_TO_EDIT` (для не-менеджерской роли, чужой паспорт), 409 `PASSPORT_NOT_EDITABLE` (status≠CREATED, есть ячейка, есть события кроме CREATED), 422 `QTY_EXCEEDS_REMAINING_PLAN` / 400 `SIZE_NOT_IN_ORDER` / 404 `CUTTER_NOT_FOUND` / 409 `CUTTER_INACTIVE` / 409 `CUTTING_CLOSED`. |
| DELETE| `/api/passports/:id`                          | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Удаление паспорта. 204 No Content. Для CUTTER_ASSISTANT/CUTTER — self-cancel: только свой паспорт (`creatorId === me`), только пока `editable = true` (status=CREATED, без ячейки, без событий кроме CREATED); APPROVED-блокер не применяется (immediate-начисление раскройщика каскадно сносится — работы по выпуску не случилось). Для SHOP_MANAGER/ADMIN — управленческое удаление с строгими блокерами: 409 `PASSPORT_HAS_BOX`, 409 `PASSPORT_HAS_APPROVED_EARNINGS`, 409 `PASSPORT_HAS_POSTED_MATERIAL_ISSUE`. В транзакции чистит `PassportEvent`, `OperationEntry`, `PassportDefect`, удаляет сам `Passport`, пишет `AuditLog(PASSPORT_DELETED, payload.actorRole)`. `MaterialIssue.passportId` обнуляется автоматически (`onDelete: SetNull`). См. `docs/domain.md §7.8 «Удаление паспорта»` и §7.8a «Редактирование паспорта». |
| POST  | `/api/passports/:id/place`                    | CUTTER, CUTTER_ASSISTANT, SHOP_MANAGER (+ ADMIN) | Body `PlacePassportDto` (`{ cellId }`). Размещает в ячейке (`currentCellId`), пишет `PassportEvent(CELL_PLACED)`. |
| POST  | `/api/passports/:id/issue`                    | Any auth                              | Body `IssuePassportDto` (бизнес-поля; `employeeId` берётся из сессии). Швея «получает крой»: снимает с ячейки, выставляет `currentEmployeeId = me`, `status = IN_PROGRESS`, `PassportEvent(ISSUED_TO_EMPLOYEE)`. Учитывает `CutReleasePolicy`. |
| POST  | `/api/passports/:id/scan`                     | Any auth                              | Body `ScanPassportDto` (employee — из сессии). Любой скан = переход на `session.operationId`. Side effects: для предыдущей операции пишет `OperationEntry(PENDING_RELEASE)` (для пошива) и `PassportEvent(OPERATION_SCAN)`. Делает `QC-gate` для `IRONING` (`WTO_PASSED` обязателен). |
| POST  | `/api/passports/:id/complete-operation`       | Any auth                              | Body `CompleteOperationDto` (пустое). Завершает текущую операцию владельца (`currentEmployeeId = me`, `status = IN_PROGRESS`). |
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

DTO: `packages/shared/src/warehouses.ts`. ADR: 0019.

---

<a id="26a-stock"></a>
## 26a. Stock

Источник: `stock/stock.controller.ts`. Класс-уровень
`@Roles('ADMIN', 'SHOP_MANAGER')`.

API для просмотра остатков, журнала движений и ручной корректировки
foundation складского учёта (см.
`apps/api/src/modules/stock/stock.service.ts`,
`prisma/schema.prisma::StockBalance` / `StockMovement`,
`docs/current-state.md §«Foundation складского учёта материалов»`).
GET-эндпоинты остаются read-only. Единственная mutation — ручная
корректировка остатка (`POST /api/stock/adjustments`); остальные
движения по-прежнему пишутся неявно, в той же транзакции, что и
бизнес-документ: `PurchaseReceipt` (POSTED → IN, cancel → REVERSAL
OUT) и `MaterialIssue` (POSTED → OUT, в т.ч. `AUTO_CUT_ISSUE`).

| Метод | Путь                       | RBAC               | Описание |
| ----- | -------------------------- | ------------------ | -------- |
| GET   | `/api/stock/balances`      | ADMIN, SHOP_MANAGER | Список текущих остатков `StockBalance`. Сортировка `updatedAt desc, description asc`. |
| GET   | `/api/stock/movements`     | ADMIN, SHOP_MANAGER | Журнал движений `StockMovement`. Сортировка `createdAt desc`. |
| POST  | `/api/stock/adjustments`   | ADMIN, SHOP_MANAGER | Ручная корректировка остатка — создаёт `StockMovement` `type = ADJUSTMENT`. |

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
| `type`                  | string   | `PURCHASE_RECEIPT \| MATERIAL_ISSUE \| ADJUSTMENT \| REVERSAL`. |
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
`MATERIAL_ISSUE_LINE:<id>` / `STOCK_ADJUSTMENT:<id>`) сознательно
**не отдаётся** в публичном API.

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

### Сознательные границы MVP

- mutation на этой итерации ровно одна (`POST /adjustments`); никаких
  transfer / FIFO/LIFO / `MaterialStockLot` / master-`Material`;
- остатки считаются по `WorkshopNeed`;
- delete / cancel adjustment в этой итерации не реализованы;
- новые роли (`WAREHOUSE_MANAGER`, `PURCHASER`, `ACCOUNTANT`) **не
  введены**;
- UI корректировки живёт прямо во вкладке «Остатки» раздела «Склады»;
  отдельной страницы / пункта sidebar нет.

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
| POST  | `/api/packing/boxes/:id/add-passport`             | PACKING, SHOP_MANAGER (+ ADMIN)   | Body `AddPassportToBoxDto`. Side effects: `BoxItem(boxId, passportId UNIQUE, qty = passport.qtyGood)`, `Box.totalQty += qtyGood`, `Passport.status = PACKED` (+ обнуление `currentEmployeeId` / `currentCellId`), `PassportEvent(PACKED)`, `AuditLog(PASSPORT_PACKED)`. Финальный апрув `OperationEntry(PENDING_RELEASE → APPROVED)` здесь **не** делается — он перенесён на `close()` (см. ADR-0005 §«Подтверждение», ADR-0011 §5, `docs/production-flow.md §10.4`). |
| POST  | `/api/packing/boxes/:id/close`                    | PACKING, SHOP_MANAGER (+ ADMIN)   | Body `CloseBoxDto` (пустое). Side effects: `Box.closedAt = now`, для каждого `BoxItem.passportId` — `EarningsService.approvePendingForPassport(tx, passportId)` (`OperationEntry(PENDING_RELEASE → APPROVED)`, `AuditLog(BOX_CLOSED)`). Идемпотентно: повторный close ловится `BoxClosedException` до апрува, а сама `approvePendingForPassport` фильтрует только `PENDING_RELEASE`/legacy `PENDING` (см. ADR-0005, ADR-0011 §5, `docs/production-flow.md §10.4`/§11.3). |
| GET   | `/api/packing/boxes/:id/qr`                       | Public                            | PNG QR `box:{id}` (ADR-0008). |
| GET   | `/api/packing/boxes/:id/label`                    | Public                            | HTML этикетка коробки (ADR-0010, A6 80×120 мм). |

DTO: `packages/shared/src/packing.ts`. Side-effect: на сервисе
требуется активная смена с операцией `OperationCategory.PACKING`.

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

> Записных операций нет — справочник наполняется через `prisma/seed.ts`.

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
