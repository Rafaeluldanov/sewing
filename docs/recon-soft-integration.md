# Recon мягкой интеграции

> Отчёт по результатам технического обзора текущей архитектуры под
> мягкую интеграцию модулей **«Лекала»**, **«Потребность цеха»**,
> **«Поставщики»** и связки `Order → Pattern + TechCard + Route`.
>
> На этом этапе **никаких миграций и правок бизнес-логики не сделано**.
> Документ — рабочая карта для будущих этапов внедрения.

---

## 1. Краткий вывод

- Проект — **монорепа `npm workspaces`**: `apps/api` (NestJS),
  `apps/web` (Next.js 14 App Router), `apps/agent` (Windows-агент
  печати), `packages/shared` (общие Zod-DTO), `prisma/` (PostgreSQL,
  единственный `schema.prisma`).
- Уже реализованы: `Order`, `OrderItem` (с размерной матрицей и
  `qtyPlan`), `RouteTemplate` + snapshot `OrderRouteStep[]`,
  `TechCardTemplate` + snapshot `OrderMaterialRequirement[]` /
  `OrderOutsourceRequirement[]`, склад/ячейки/линии, паспорта,
  принтеры, печать, клиенты, сотрудники, оборудование, операции,
  начисления.
- Заказ покупателя уже умеет: один `productId`, размерная матрица
  (`OrderItem`), цвет, привязка к `RouteTemplate` и
  `TechCardTemplate`, snapshot маршрута и материалов при `start()`.
- **Чего нет совсем:**
  - модуля «Лекала» (`PatternItem`, размерные DXF-файлы, площади
    материалов по `materialRole`);
  - модуля «Поставщики» (есть только свободная строка `vendorName` в
    техкарте);
  - модуля «Потребность цеха» (расчёт чистой потребности по
    formula `area × density × qty / 1000`);
  - связи `Order → patternItemId`;
  - Файлового хранилища / загрузки изображений и файлов
    (нет multer/storage/S3, печать использует только URL-rewrite).
  - Концепта **`materialRole`** (MAIN_FABRIC / RIB / LINING / …) —
    в техкарте материалы хранятся свободной строкой `name` без
    дискриминатора роли.
  - Поля «плотность г/м²», «характеристика полотна», «плановая
    ширина рулона» — в техкарте этих колонок нет.
- Самый безопасный первый шаг — добавить **раздел «Лекала» как
  отдельный модуль** (Prisma + API + UI) **без вмешательства в
  заказ**. Связку `Order.patternItemId` можно прицепить позже
  опциональной колонкой по тем же правилам, что уже сделано для
  `Order.techCardId` / `Order.routeTemplateId` (см. ADR-0022,
  pattern «soft snapshot»).

---

## 2. Текущая архитектура проекта

### Frontend — `apps/web` (Next.js 14, App Router)

- `apps/web/app/` — страницы (RSC + server actions).
- Ключевые маршруты:
  - `app/admin/*` — админ-панель (под layout
    `apps/web/app/admin/layout.tsx` с `AdminSidebar`):
    - `admin/orders` (новая обёртка над «Заказами»),
    - `admin/orders/[id]` (карточка),
    - `admin/orders/new`,
    - `admin/clients`, `admin/employees`, `admin/equipment`,
    - `admin/operations`, `admin/routes`, `admin/tech-cards`,
    - `admin/warehouses`, `admin/printers`,
    - `admin/display-screens`, `admin/diagnostics`,
    - `admin/production-cost`.
  - `app/orders/*` — старая (расширенная) карточка заказа,
    используется `CUTTER_ASSISTANT` для выпуска паспорта
    (см. `app/orders/[id]/page.tsx`).
  - Терминалы: `app/work`, `app/qc`, `app/wto`, `app/packing`,
    `app/master`, `app/shopfloor/display`.
- Компоненты — `apps/web/components/`. Левый сайдбар админки —
  `apps/web/components/admin-sidebar.tsx` (статический массив
  `SECTIONS`).
- API-клиенты — `apps/web/lib/*-api.ts`, общий `api-base.ts`
  (cookie-аутентификация против NestJS).
- Доступы — `apps/web/lib/rbac.ts` (helpers `canSeeAdmin`,
  `canSeeOrders`, …) + middleware `apps/web/middleware.ts` (только
  cookie-gate и редирект для DISPLAY/SHOPFLOOR_MASTER).

### Backend — `apps/api` (NestJS 10)

- Один `AppModule` (`apps/api/src/app.module.ts`) подключает
  ~30 feature-модулей: `OrdersModule`, `TechCardsModule`,
  `RoutesModule`, `CatalogModule`, `WarehousesModule`,
  `PassportsModule`, `ClientsModule`, `OperationsModule`,
  `EmployeesModule`, `EquipmentModule`, `PrintersModule`,
  `MasterCallsModule`, `AuditModule`, … — структура
  `apps/api/src/modules/<name>/<name>.{controller,service,module}.ts`.
- Базовый префикс API — `/api` (см. `main.ts` и
  `@sewing/shared/config`).
- Аутентификация — глобальный `AuthGuard` + `RolesGuard`,
  декораторы `@Public()` и `@Roles('SHOP_MANAGER', …)`
  (см. `apps/api/src/modules/auth/auth.decorators.ts`,
  `auth.guard.ts`).
- DTO/валидация — Zod-схемы в `packages/shared/src/*.ts`,
  применяются через `ZodValidationPipe`
  (`apps/api/src/common/zod-validation.pipe.ts`).
- Прайма-клиент инкапсулирован в `PrismaService`
  (`apps/api/src/prisma/prisma.service.ts`); всё, что меняет
  состояние агрегата, идёт через `prisma.$transaction(...)`.
- Аудит-журнал — универсальная таблица `AuditLog`, сервис
  `AuditService.log(entry, tx)` пишется в той же транзакции, что
  бизнес-операция.

### Database — PostgreSQL (`prisma/schema.prisma`)

- Один файл `schema.prisma` (1691 строка), все модели описаны там.
- Миграции — `prisma/migrations/*` (хронологический список ~25
  миграций; последняя — `20260505100000_clients_and_order_due_date`).
- Заметные доменные блоки: dictionaries (`Size`, `Product`,
  `Operation`, `OperationRateBySize`), people (`Employee`,
  `Equipment`, `EquipmentOperation`, `ShiftSession`), orders
  (`Order`, `Client`, `OrderItem`, `RouteTemplate`,
  `RouteTemplateStep`, `OrderRouteStep`, `TechCardTemplate`,
  `TechCardMaterialLine`, `TechCardOutsourceLine`,
  `OrderMaterialRequirement`, `OrderOutsourceRequirement`),
  passport core (`Passport`, `PassportEvent`, `PassportDefect`,
  `DefectType`), payroll (`OperationEntry`, `SalaryEntry`;
  историческая таблица `PieceRate` удалена в PHASE 2 STEP 1, ставки
  теперь живут в `Operation.fixedRate` / `OperationRateBySize`,
  см. ADR-0020 §«PHASE 2 — drop legacy»), WMS-light
  (`Warehouse`, `WarehouseLine`, `Cell`,
  `CellContent`), packing (`Box`, `BoxItem`), printing (`Printer`,
  `PrintJob`), policy (`CuttingClosureRequest`,
  `CutReleasePolicy`), audit (`AuditLog`, `MasterCall`,
  `DisplayScreenConfig`).
- Decimal-поля используются для денег и норм
  (`Decimal(12,2)` для ставок, `Decimal(12,4)` для
  `qtyPerUnit` техкарты).

### Auth / роли

- Enum `Role` в `prisma/schema.prisma`: `SHOP_MANAGER`, `CUTTER`,
  `CUTTER_ASSISTANT`, `SEAMSTRESS`, `QC`, `IRONING`, `PACKING`,
  `ADMIN`, `DISPLAY`, `SHOPFLOOR_MASTER`.
- Доступ к админке — `ADMIN`/`SHOP_MANAGER`
  (см. `apps/web/lib/rbac.ts:ADMIN_ALLOWED_ROLES`).
- Роли «закупщик», «технолог», «кладовщик» **сейчас отсутствуют**
  как отдельные значения в enum — расширение enum потребует
  миграции (см. §12 «Риски»).

### Uploads / files

- **Файлового хранилища нет.** В коде нет ни `multer`, ни
  `aws-sdk`, ни локальных папок-аплоадов. Все «file»/«print»
  упоминания — это HTML/QR-эндпоинты для агента печати
  (`/api/passports/:id/print`, `/api/cells/:id/print`, …),
  а не пользовательские загрузки.
- Это значит, что для лекал (DXF + превью) **нужно завести
  полноценный upload-сервис**. Минимум — локальная папка
  `apps/api/uploads/` с раздачей через NestJS `ServeStaticModule`
  (или Next.js `/public/uploads`); максимум — S3-совместимое
  хранилище. См. §12 «Риски» и §13 «План внедрения».

---

## 3. Текущие сущности

| Бизнес-сущность | Найденная модель / файл | Что уже подходит | Чего не хватает | Рекомендация |
|---|---|---|---|---|
| Заказ покупателя | `Order` (`prisma/schema.prisma:586`) + `OrderItem` (`:677`); сервис `apps/api/src/modules/orders/orders.service.ts`; UI `app/admin/orders/*` и `app/orders/*` | `clientId`, `productId`, `color`, `dueDate`, `division`, `routeTemplateId`, `techCardId`, размерная матрица в `OrderItem(qtyPlan)`, snapshot маршрута/материалов на `start()` | `patternItemId` (нет), нет колонки превью лекала, нет snapshot изображения | Добавить опциональную колонку `Order.patternItemId` + хранение URL превью лекала; следовать pattern «soft snapshot», как с `routeTemplateId`/`techCardId` |
| Техкарта | `TechCardTemplate` (`:1313`) + `TechCardMaterialLine` (`:1333`) + `TechCardOutsourceLine` (`:1359`); сервис `tech-cards.service.ts`; UI `app/admin/tech-cards/*` | Структура «шаблон + строки», нормализация `sortOrder`, snapshot `OrderMaterialRequirement[]`/`OrderOutsourceRequirement[]` при `start()` | `materialRole`, `densityGsm`, `plannedWidthCm`, характеристика полотна (fabricType), правило цвета. Сейчас материал = свободный `name + unit + qtyPerUnit` | Добавить опциональные колонки в `TechCardMaterialLine` (`materialRole`, `densityGsm`, `plannedWidthCm`, `fabricType`, `colorRule`) — backward-compat через nullable и значения по умолчанию |
| Маршрут производства | `RouteTemplate` (`:1242`) + `RouteTemplateStep` (`:1258`) + snapshot `OrderRouteStep` (`:1281`); сервис `routes.service.ts`; UI `app/admin/routes/*` | Шаблон + упорядоченные шаги (operation, isOptional), snapshot на `start()`, индекс шага в паспорте `Passport.currentRouteStepIndex` | Ничего критичного для нового MVP; маршрут уже отделён от техкарты | **Не трогать.** Соответствует требованиям ТЗ «маршрут отделён от техкарты, маршрут хранит операции» |
| Операции | `Operation` (`:367`), `OperationRateBySize` (`:427`) | `category`, `pricingMode`, `fixedRate`, `BY_SIZE` rates | — | Не трогать; используется маршрутом и payroll |
| Материалы | **Нет отдельного справочника материалов.** В `TechCardMaterialLine.name` хранится свободная строка. | — | Полноценного `Material` / `FabricType` справочника нет | На MVP «потребности цеха» можно остаться без справочника материалов; группировка по `materialRole + fabricType + density + width + color` достаточна. Опционально потом завести `FabricType` справочник |
| Цвета | **Нет отдельного `Color` справочника.** Цвет лежит как `String?` на `Order.color`, `Passport.color`, `Product.color`, в `CutReleasePolicy.color`. | Поле есть везде, где нужно | Нет справочника, нет `colorId` | На MVP оставить как `String?` (как сейчас). Если очень нужно `colorId`, заводить отдельный `Color` справочник позже — это не блокер |
| Размеры | `Size` (`:340`) | `code`, `sortOrder` | — | Использовать как есть для `PatternSizeFile.sizeId` и `PatternMaterialArea.sizeId` |
| Склад | `Warehouse` (`:901`), `WarehouseLine` (`:935`), `Cell` (`:950`), `CellContent` (`:982`) | Полная WMS-light структура, привязка через `Passport.currentCellId` | — | Не трогать; пригодится позже для приёмки от поставщика |
| Поставщики | **Не реализовано.** В `TechCardOutsourceLine.vendorName` — свободная строка для подрядчика. ADR-0022 явно говорит «vendor directory postponed». | — | Всё. Нужны `Supplier` / `SupplierContact` / `SupplierCatalogItem` | Завести модуль `suppliers/` по аналогии с `clients/` |
| Закупки / Purchase Requests | **Не реализовано.** Никаких purchase orders / requests в схеме нет. | — | Всё | Нужна модель «потребность цеха» (`WorkshopNeed`) — это и есть заявка закупщика, без полноценного PO/PR процесса |
| Файлы / uploads | **Нет.** Нет multer/storage/file-сервиса. | — | Всё | Завести минимальный файловый сервис под лекала (см. §12) |
| Изображения / attachments | **Нет.** | — | Всё | Аналогично |
| Номенклатура изделий | `Product` (`:354`) — name, color, active. | `Product.id`/`name`/`color` | Это «product»-сущность, не «изделие/конструкция» (нет артикула, превью, статуса жизненного цикла, категории) | **НЕ переиспользовать `Product` под `PatternItem`** — у них разная семантика. `Product` живёт в паспортах, payroll-ставках и т.д.; ломать его опасно. Заводить отдельный `PatternItem`. |
| Клиенты | `Client` (`:661`) | `name`, `phone`, `email`, `comment`, `isActive` | — | Не трогать |
| Пользователи / Сотрудники | `Employee` (`:449`), enum `Role` | Логин, PIN, роль, compensationType | Нет ролей `PURCHASER`, `WAREHOUSE_KEEPER`, `TECHNOLOGIST` | Расширение enum `Role` потребует миграции — см. §12 |

---

## 4. Заказы покупателя

### Где реализовано

- Prisma: `model Order` (`prisma/schema.prisma:586`), `model OrderItem`
  (`:677`).
- Backend:
  - `apps/api/src/modules/orders/orders.controller.ts` (`/api/orders`),
  - `apps/api/src/modules/orders/orders.service.ts`,
  - `apps/api/src/modules/orders/order-aggregator.ts`,
  - `apps/api/src/modules/orders/order-number.service.ts`.
- Web:
  - `apps/web/app/admin/orders/page.tsx` (новый список),
  - `apps/web/app/admin/orders/[id]/page.tsx` (новая карточка),
  - `apps/web/app/admin/orders/new/admin-create-order-form.tsx`
    (новая форма создания);
  - `apps/web/app/orders/[id]/page.tsx` (старая карточка с
    действиями для `CUTTER_ASSISTANT`).
- Shared DTO: `packages/shared/src/orders.ts`.

### Какие поля уже есть

`Order`:
- `id`, `number` (unique), `customer` (legacy free-text),
- `clientId` → `Client`,
- `orderDate`, `dueDate`,
- `color: String?`,
- `comment: String?`,
- `status: OrderStatus` (`DRAFT | IN_PRODUCTION | DONE | CANCELLED`),
- `companyDivisionId?` → `CompanyDivision` (master-справочник
  подразделений; см. `docs/domain.md §«Подразделения заказа»`),
- `routeTemplateId?` → `RouteTemplate`,
- `techCardId?` → `TechCardTemplate`.

`OrderItem`:
- `orderId` + `productId` + `sizeId` + `qtyPlan` (`@@unique([orderId,
  productId, sizeId])`).

Размерная матрица — это набор `OrderItem` строк одного `productId`
с разными `sizeId` (по ADR-0009 «один заказ = одно изделие, один
цвет, много размеров»).

### Что нужно добавить под «Лекала» в заказе

- `Order.patternItemId String?` → `PatternItem` — опциональная
  ссылка на выбранное лекало.
  *Где добавлять:* `prisma/schema.prisma` — рядом с
  `routeTemplateId` / `techCardId` (см. строки 626–635).
  *Pattern:* такой же, как `routeTemplateId`:
  - nullable (backward-compat для старых заказов),
  - меняется только в `DRAFT` (общий `ORDER_LOCKED` guard
    в `OrdersService.update`),
  - валидация existense через `assertPatternUsable(...)`,
  - в карточке заказа отдаётся `patternItemId`/`patternName` /
    `patternPreviewImageUrl`.
- Превью лекала справа сверху в карточке заказа
  (`apps/web/app/orders/[id]/page.tsx` и
  `apps/web/app/admin/orders/[id]/page.tsx`):
  - на детали заказа уже есть `actions` слот в `AdminPageShell`
    и шапка `page-header` в старом `app/orders/[id]/page.tsx`;
  - превью можно положить в правую колонку
    `admin-stack` (новая карточка) или в правый верхний угол
    шапки старой страницы;
  - источник URL — `PatternItem.previewImageUrl` (через
    `OrderDetailDto.patternPreviewImageUrl`).
- Snapshot изображения лекала при `OrdersService.start()` —
  опционально (см. §7 ниже): можно добавить
  `Order.patternPreviewSnapshotUrl: String?`, который заполняется
  в той же транзакции `start()`. Это делает заказ устойчивым к
  переименованию/удалению превью лекала. На MVP можно не делать —
  достаточно ссылки `patternItemId` и live-загрузки превью при
  чтении.

### Связь с техкартой и маршрутом

Уже работает (см. ADR-0022 и `OrdersService.start`):
- `Order.techCardId` → snapshot
  `OrderMaterialRequirement[]` + `OrderOutsourceRequirement[]`,
- `Order.routeTemplateId` → snapshot `OrderRouteStep[]`.

### Цвет

- Хранится в `Order.color` (`String?`). По умолчанию подставляется
  из `Product.color` (см. `OrdersService.create`).
- `colorId` ссылки на справочник нет; на MVP «потребности цеха»
  можно использовать имеющуюся строку. Если позже потребуется
  справочник цветов, добавлять отдельной модели `Color` без
  переименования существующего поля.

---

## 5. Техкарты

### Текущая структура

- `TechCardTemplate { id, code (unique), name, isActive,
  createdAt, updatedAt, materialLines[], outsourceLines[] }`
  (`prisma/schema.prisma:1313`).
- `TechCardMaterialLine { id, techCardId, sortOrder, name, unit,
  qtyPerUnit Decimal(12,4), note, createdAt, updatedAt }`
  (`:1333`).
- `TechCardOutsourceLine { …, vendorName, triggerType (MANUAL |
  CUT_READY) }` (`:1359`).
- Snapshot на заказе: `OrderMaterialRequirement` (`:1398`),
  `OrderOutsourceRequirement` (`:1427`) — фиксируется в
  `OrdersService.start()` с `totalQty = qtyPerUnit * Σ qtyPlan`.

### Что есть из требований

| Требование ТЗ | Есть сейчас? |
|---|---|
| Материалы | да, в `TechCardMaterialLine` |
| Нанесения / OUTSOURCED_SERVICE | да, в `TechCardOutsourceLine` |
| Связь с операциями | **нет** (это и хорошо: операции живут в `RouteTemplate`) |
| `materialRole` (MAIN_FABRIC / RIB / …) | **нет**, нужно добавить |
| `densityGsm` (плотность г/м²) | **нет** |
| `fabricType` (характеристика полотна: кулирка / двунитка / футер / рибана) | **нет** |
| `plannedWidthCm` (плановая ширина рулона, см) | **нет** |
| `colorRule` / `colorId` (правило цвета) | **нет** (вне `Order.color`) |
| Дополнительные материалы / фурнитура / упаковка | возможны через `name` + `unit`, но нет дискриминатора |

### Минимальные доработки

В существующий `TechCardMaterialLine` добавить **опциональные**
nullable колонки (без миграции бизнес-логики):

```prisma
model TechCardMaterialLine {
  // ... существующие поля без изменений ...
  materialRole     String?   // 'MAIN_FABRIC' | 'RIB' | 'LINING' | 'THREAD' | 'PACKAGING' | 'APPLICATION'
  fabricType       String?   // свободная строка: 'кулирка' | 'двунитка' | ...
  densityGsm       Int?      // плотность, г/м²
  plannedWidthCm   Int?      // плановая ширина рулона, см
  colorRule        String?   // 'SAME_AS_ORDER' | 'FIXED_<colorCode>' | null
}
```

Все nullable → миграция — `ADD COLUMN ... NULL`, не ломает ни
один существующий заказ. По смыслу — повтор pattern-а, по
которому добавляли `triggerType` в `TechCardOutsourceLine`
(см. ADR-0022 §«Cut-ready readiness»).

Аналогично нужно добавить эти же поля в snapshot
`OrderMaterialRequirement` (повтор pattern-а
`OrderMaterialRequirement` из ADR-0022): чтобы snapshot заказа
оставался самодостаточным.

> **Замечание.** На MVP «справочник `materialRole`» — это
> shared-enum в `packages/shared/src/tech-cards.ts`
> (`MATERIAL_ROLES = ['MAIN_FABRIC', 'RIB', 'LINING', 'THREAD',
> 'PACKAGING', 'APPLICATION'] as const`). В Postgres хранить как
> `String?`, без Prisma-enum — это даёт расширяемость без миграций
> (как сделано с `event` в `AuditLog`).

### Связь с операциями

Уже отделена: операции живут в `Operation` + `RouteTemplateStep`,
техкарта про них не знает. Усиливать не нужно.

---

## 6. Маршруты производства

### Текущая структура

- `RouteTemplate { id, code (unique), name, isActive }`
  (`prisma/schema.prisma:1242`).
- `RouteTemplateStep { id, templateId, index, operationId,
  isOptional }` (`:1258`), `@@unique([templateId, index])`,
  `@@unique([templateId, operationId])`.
- Snapshot на заказе: `OrderRouteStep { id, orderId, index,
  operationId }` (`:1281`).
- В паспорте `Passport.currentRouteStepIndex` (`:724`) хранит
  индекс текущего шага маршрута (без enforcement).

### Связь с заказом

- `Order.routeTemplateId` → `RouteTemplate` (опционально, меняется
  только в `DRAFT`, `OrderRouteAlreadyStartedException` если
  snapshot уже зафиксирован).
- При `OrdersService.start()`:
  ```
  if (order.routeTemplateId) {
    snapshotSteps = await routes.getActiveStepsForSnapshot(...);
    // → orderRouteStep.createMany
  }
  ```
  (см. `apps/api/src/modules/orders/orders.service.ts:737-789`).

### Что нужно

- **Ничего.** Маршрут уже отделён от техкарты, snapshot на запуске
  заказа уже сделан, паспорт уже умеет идти по шагам. Это та
  модель, которую описывает ТЗ.

---

## 7. Лекала

### Есть ли аналог?

- Прямого аналога нет.
- Близкий по смыслу `Product` (`prisma/schema.prisma:354`) — это
  «изделие в payroll/passport», у него только `name + color +
  active`. **Не переиспользуется**: ломать его — значит трогать
  паспорта, ставки и формы выпуска. Конструкторская сущность
  «Лекало» должна быть отдельной.

### Предлагаемая модель (минимальная, не выполняем)

```prisma
model PatternItem {
  id                String   @id @default(cuid())
  name              String
  article           String   @unique
  // categoryId — опционально, можно не заводить справочник
  // категорий на MVP, оставить String? как `fabricType` в техкарте
  categoryCode      String?
  previewImageUrl   String?  // публичный URL мини-превью изделия
  description       String?
  status            String   @default("ACTIVE") // 'ACTIVE' | 'ARCHIVED'
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  sizeFiles         PatternSizeFile[]
  materialAreas     PatternMaterialArea[]

  @@index([status])
}

model PatternSizeFile {
  id                String   @id @default(cuid())
  patternItemId     String
  sizeId            String
  fileUrl           String   // абсолютный URL DXF
  originalFileName  String
  version           Int      @default(1)
  status            String   @default("ACTIVE")
  uploadedById      String?  // FK → Employee.id, но onDelete SetNull
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  patternItem       PatternItem @relation(fields: [patternItemId], references: [id], onDelete: Cascade)
  size              Size        @relation(fields: [sizeId], references: [id])
  uploadedBy        Employee?   @relation(fields: [uploadedById], references: [id], onDelete: SetNull)

  @@unique([patternItemId, sizeId, version])
  @@index([patternItemId])
}

model PatternMaterialArea {
  id                String   @id @default(cuid())
  patternItemId     String
  sizeId            String
  materialRole      String   // 'MAIN_FABRIC' | 'RIB' | ...
  areaM2            Decimal  @db.Decimal(10, 4)
  comment           String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  patternItem       PatternItem @relation(fields: [patternItemId], references: [id], onDelete: Cascade)
  size              Size        @relation(fields: [sizeId], references: [id])

  @@unique([patternItemId, sizeId, materialRole])
  @@index([patternItemId, materialRole])
}
```

### Frontend routes

- `/admin/patterns` — список лекал с мини-превью
  (плитка / таблица).
- `/admin/patterns/new` — карточка создания.
- `/admin/patterns/[id]` — карточка лекала, на ней:
  - превью + основные поля (article, name, category, status,
    description),
  - вкладка «Размеры и DXF» (загрузка `PatternSizeFile`),
  - вкладка «Площади материалов» (`PatternMaterialArea`).

### Backend endpoints (предложение, не выполняем)

- `GET    /api/patterns?search=&status=` — список (с превью URL).
- `GET    /api/patterns/:id` — детальный DTO (sizes, areas).
- `POST   /api/patterns` — создание.
- `PATCH  /api/patterns/:id` — правка name/article/category/
  description/status/previewImageUrl.
- `POST   /api/patterns/:id/preview` — multipart upload превью.
- `POST   /api/patterns/:id/sizes/:sizeId/file` — multipart upload
  DXF (новая версия).
- `PATCH  /api/patterns/:id/material-areas` — bulk-replace
  (по аналогии с `TechCardsService.replaceMaterialLines`).

RBAC: `ADMIN`, `SHOP_MANAGER` (на MVP — те же, что управляют
техкартами/маршрутами; роли `TECHNOLOGIST` ещё нет — см. §12).

### Где приземлить файлы

Лучший минимальный вариант:
1. Завести `apps/api/uploads/patterns/<patternId>/preview-<hash>.<ext>`
   и `apps/api/uploads/patterns/<patternId>/sizes/<sizeId>/<v>.dxf`.
2. В NestJS включить `ServeStaticModule` (или nginx-rewrite)
   на `/uploads/*`.
3. В Prisma хранить **публичный URL** (`fileUrl`,
   `previewImageUrl`), не путь на диске — это упростит миграцию
   на S3 без правки кода-консьюмера.

### Связь с заказом

- `Order.patternItemId String?` → `PatternItem`. Опциональная,
  без enforcement, меняется только в `DRAFT` (по той же логике,
  что и `routeTemplateId`/`techCardId`).
- В UI заказа — превью справа сверху + кнопка «Сменить лекало»
  (только для `DRAFT`).

---

## 8. Потребность цеха

### Предлагаемая модель

```prisma
enum WorkshopNeedStatus {
  CALCULATED      // система просчитала
  REVIEWED        // закупщик посмотрел, утвердил состав
  PURCHASE_PLACED // закупщик заказал у поставщика (вручную)
  RECEIVED        // получено
  CANCELLED
}

model WorkshopNeed {
  id                            String   @id @default(cuid())
  orderId                       String
  materialRole                  String   // как в PatternMaterialArea/TechCardMaterialLine
  description                   String   // человекочитаемая строка («Кулирка 180 г/м², чёрная, 180 см»)
  fabricType                    String?
  densityGsm                    Int?
  plannedWidthCm                Int?
  colorText                     String?  // строка цвета (как в Order.color), либо null
  // colorId               String? — на MVP не вводим, см. §3
  calculatedQty                 Decimal  @db.Decimal(14, 4)
  purchaseQty                   Decimal? @db.Decimal(14, 4)  // заполняет закупщик
  unit                          String   // 'кг' | 'м' | 'шт'
  status                        WorkshopNeedStatus @default(CALCULATED)

  selectedSupplierId            String?
  selectedSupplierCatalogItemId String?
  quotedPrice                   Decimal? @db.Decimal(14, 2)
  quotedCurrency                String?  // 'RUB' и т.п.
  expectedDeliveryDate          DateTime?
  comment                       String?

  createdAt                     DateTime @default(now())
  updatedAt                     DateTime @updatedAt

  order                         Order                 @relation(fields: [orderId], references: [id], onDelete: Cascade)
  selectedSupplier              Supplier?             @relation(fields: [selectedSupplierId], references: [id], onDelete: SetNull)
  selectedSupplierCatalogItem   SupplierCatalogItem?  @relation(fields: [selectedSupplierCatalogItemId], references: [id], onDelete: SetNull)

  @@index([orderId, materialRole])
  @@index([status])
  @@index([selectedSupplierId])
}
```

### Statuses

`CALCULATED → REVIEWED → PURCHASE_PLACED → RECEIVED` (плюс
`CANCELLED`). На первом этапе достаточно `CALCULATED` +
`PURCHASE_PLACED`; остальные оставить под расширение.

### API (без реализации)

- `GET    /api/workshop-needs?orderId=&status=&supplierId=` —
  список / фильтр для рабочего места закупщика.
- `GET    /api/workshop-needs/:id`
- `POST   /api/orders/:id/workshop-needs/calculate` — генерация
  чистой потребности из заказа (см. §10).
- `PATCH  /api/workshop-needs/:id` — закупщик правит
  `purchaseQty`, `selectedSupplierId`, `selectedSupplierCatalogItemId`,
  `quotedPrice`, `expectedDeliveryDate`, `comment`, `status`.
- `POST   /api/workshop-needs/:id/cancel`

### UI

- `/workshop-needs` — список «рабочее место закупщика»: фильтр
  по заказу, статусу, поставщику; колонки `Заказ / materialRole /
  description / calculatedQty / purchaseQty / supplier / quotedPrice`.
- `/admin/orders/[id]` — добавить вкладку «Потребность цеха»
  (или раздел в карточке) с кнопкой «Просчитать потребность»
  (только для `IN_PRODUCTION`/`DRAFT`?).

### Алгоритм генерации

Подробно описан в §10.

---

## 9. Поставщики

### Есть ли уже?

Нет. В схеме поиск по `supplier|vendor` находит только
`vendorName String?` в `TechCardOutsourceLine` и
`OrderOutsourceRequirement` — это свободная строка, не связь
с реальным справочником (см. ADR-0022 §«vendor directory
postponed»).

### Что добавить

```prisma
enum SupplierStatus {
  ACTIVE
  INACTIVE
}

model Supplier {
  id        String   @id @default(cuid())
  name      String
  phone     String?
  website   String?
  address   String?
  comment   String?
  status    SupplierStatus @default(ACTIVE)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  contacts  SupplierContact[]
  catalog   SupplierCatalogItem[]
  workshopNeeds WorkshopNeed[]

  @@index([status])
}

model SupplierContact {
  id          String   @id @default(cuid())
  supplierId  String
  name        String
  position    String?
  phone       String?
  email       String?
  messenger   String?  // tg: @user, viber: ..., wa: ...
  isPrimary   Boolean  @default(false)
  comment     String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  supplier    Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)

  @@index([supplierId])
}

model SupplierCatalogItem {
  id              String   @id @default(cuid())
  supplierId      String
  name            String   // 'Кулирка BLACK 180'
  supplierArticle String?  // 'KT-180-BLK'
  category        String?
  fabricType      String?
  densityGsm      Int?
  colorText       String?
  unit            String   // 'кг' | 'м' | 'шт'
  lastPrice       Decimal? @db.Decimal(14, 2)
  currency        String?  // 'RUB'
  minOrderQty     Decimal? @db.Decimal(14, 4)
  deliveryDays    Int?
  comment         String?
  status          SupplierStatus @default(ACTIVE)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  supplier        Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  workshopNeeds   WorkshopNeed[]

  @@unique([supplierId, supplierArticle])
  @@index([supplierId, status])
  @@index([fabricType])
}
```

### Frontend

- `/suppliers` — список поставщиков (вкладка sidebar).
- `/suppliers/[id]` — карточка: контакты + номенклатура.
- `/suppliers/new`.

### Backend (без реализации)

- `GET    /api/suppliers?search=&status=`
- `GET    /api/suppliers/:id`
- `POST   /api/suppliers`
- `PATCH  /api/suppliers/:id`
- `POST   /api/suppliers/:id/contacts`
- `PATCH  /api/suppliers/:id/contacts/:contactId`
- `DELETE /api/suppliers/:id/contacts/:contactId`
- `GET    /api/suppliers/:id/catalog`
- `POST   /api/suppliers/:id/catalog`
- `PATCH  /api/suppliers/:id/catalog/:itemId`

RBAC: на MVP — `SHOP_MANAGER`/`ADMIN` (плюс будущая роль
`PURCHASER`).

---

## 10. Алгоритм расчёта чистой потребности

### Формула (ТЗ §6)

```
чистый_вес_кг
  = Σ_по_размерам ( areaM2(materialRole, sizeId)
                    × densityGsm(materialRole)
                    × qtyPlan(sizeId)
                    / 1000 )
```

### Алгоритм (предлагается, не выполняем)

```
function calculateWorkshopNeeds(orderId):
  order = orders.getOne(orderId)
  if not order.patternItemId: throw 'PATTERN_REQUIRED'
  if not order.techCardId:    throw 'TECH_CARD_REQUIRED'

  pattern   = patterns.getOne(order.patternItemId)         // includes materialAreas[]
  techCard  = techCards.getOne(order.techCardId)           // includes materialLines[]

  // Группировка ключа потребности — ровно те поля, по которым
  // мы хотим объединять строки в одну.
  type Key = {
    materialRole : string
    fabricType   : string | null
    densityGsm   : int    | null
    plannedWidth : int    | null
    color        : string | null
  }

  result : Map<Key, {
    description    : string
    calculatedKg   : Decimal
    unit           : 'кг'
  }> = new Map()

  for materialLine of techCard.materialLines:
    if not materialLine.materialRole: continue   // backward-compat
    role = materialLine.materialRole
    density = materialLine.densityGsm
    width   = materialLine.plannedWidthCm
    fabric  = materialLine.fabricType
    color   = resolveColor(materialLine.colorRule, order.color)

    // Σ по размерам
    weightKg = 0
    for item of order.items:
      area = pattern.materialAreas.find(
        a => a.materialRole == role && a.sizeId == item.sizeId
      )?.areaM2
      if not area: continue                       // нет данных по размеру
      // 1 шт = area_м² × density_г/м² / 1000 = килограммы
      weightKg += area × density × item.qtyPlan / 1000

    if weightKg == 0: continue

    key = { materialRole: role, fabricType: fabric,
            densityGsm: density, plannedWidth: width, color }
    description = humanReadable(role, fabric, density, width, color)
    result.upsert(key, +weightKg, description)

  // Запись в БД одной транзакцией.
  prisma.$transaction(async (tx) => {
    // Идемпотентно: либо чистим прежние CALCULATED-строки заказа
    // и создаём новые, либо upsert по (orderId, role+key-hash).
    await tx.workshopNeed.deleteMany({
      where: { orderId, status: 'CALCULATED' }
    })
    await tx.workshopNeed.createMany({
      data: [...result entries → WorkshopNeed { ... }]
    })
    await audit.log({ event: 'WORKSHOP_NEED_CALCULATED', ... }, tx)
  })

  return list of created WorkshopNeed
```

### Пример (из ТЗ §6)

```
лекала.PatternMaterialArea: { sizeId: M, materialRole: MAIN_FABRIC, areaM2: 1.05 }
техкарта.TechCardMaterialLine: { materialRole: MAIN_FABRIC,
                                  fabricType: 'кулирка',
                                  densityGsm: 180,
                                  plannedWidthCm: 180 }
заказ.OrderItem: { sizeId: M, qtyPlan: 100 }
заказ.Order.color: 'чёрный'

weightKg = 1.05 × 180 × 100 / 1000 = 18.9 кг

→ WorkshopNeed:
  description    = 'Кулирка 180 г/м², чёрная, 180 см'
  materialRole   = 'MAIN_FABRIC'
  fabricType     = 'кулирка'
  densityGsm     = 180
  plannedWidthCm = 180
  colorText      = 'чёрный'
  calculatedQty  = 18.9
  unit           = 'кг'
  status         = CALCULATED
```

### Жёсткие инварианты алгоритма

- **Нет потерь**, нет коэффициентов запаса. Только чистый вес.
- **Не создаём** закупочную номенклатуру автоматически.
- **Не создаём** заказ поставщику автоматически.
- **Не трогаем** snapshot техкарты на заказе — потребность это
  отдельная сущность поверх snapshot-а.

---

## 11. Sidebar / routes

### Где находится sidebar

- `apps/web/components/admin-sidebar.tsx` — основной левый
  сайдбар админки (статический массив `SECTIONS: SidebarItem[]`).
  Активный пункт подсвечивается через `usePathname()`.
- Используется в `apps/web/app/admin/layout.tsx`.

### Как добавлять пункты

В `SECTIONS`:

```ts
{ href: '/admin/patterns',         label: 'Лекала',           Icon: Scissors },
{ href: '/admin/workshop-needs',   label: 'Потребность цеха', Icon: ClipboardList },
{ href: '/admin/suppliers',        label: 'Поставщики',       Icon: Truck },
```

(используем `lucide-react`, как везде в проекте).

### Какие routes выбрать

| Раздел | Маршрут | Заметки |
|---|---|---|
| Лекала | `/admin/patterns` | внутри `/admin/*` — попадает под общий `AdminSectionLayout` (RBAC `ADMIN`/`SHOP_MANAGER`) |
| Потребность цеха | `/admin/workshop-needs` | то же |
| Поставщики | `/admin/suppliers` | то же |

> Размещение строго внутри `/admin/*` лучше, чем
> `/patterns` / `/workshop-needs` / `/suppliers` в корне:
> a) переиспользует `AdminPageShell`/`AdminCard`/`AdminTable`
> компоненты; b) автоматически забирает RBAC через
> `apps/web/app/admin/layout.tsx`; c) не плодит новые root-разделы
> рядом с терминалами `/work`, `/qc`, `/wto`, `/packing`,
> `/master`, `/shopfloor`.
>
> Если бизнес настаивает на коротких URL `/patterns` и
> `/suppliers`, можно сделать их через `redirect` в Next.js, не
> переписывая страницы.

### RBAC

- На MVP — `ADMIN` + `SHOP_MANAGER` (как уже сделано для
  техкарт/маршрутов/клиентов).
- Позже добавить `PURCHASER` для `/admin/workshop-needs` и
  `TECHNOLOGIST` для `/admin/patterns` — это требует расширения
  enum `Role` (см. §12).

---

## 12. Риски

### Высокий риск

1. **Файловое хранилище.** Сейчас в проекте **нет** ни одного
   upload-эндпоинта. Введение лекал = введение storage-слоя.
   Нужно сразу решить: локальная папка vs S3-совместимое
   хранилище vs существующий nginx static. Любой выбор
   однонаправленный — менять потом дорого. *Митигация:* хранить в
   БД только `String` URL, а не путь на диске → S3-миграция
   сводится к смене middleware. Сделать через feature flag
   `PATTERNS_STORAGE_DRIVER=local|s3`.
2. **Переименование/«облагораживание» `Product`.** Не делать.
   `Product.id` дёргается из `Passport`, `OrderItem`,
   `CuttingClosureRequest` — переименование = большая миграция и
   риск потерять историю. Вводить `PatternItem` отдельно.
   *(До PHASE 2 STEP 1 в этот список входил и `PieceRate` —
   таблица удалена, см. ADR-0020 §«PHASE 2 — drop legacy».)*
3. **Связь `Order ↔ PatternItem`.** Менять только в `DRAFT`
   (общий ORDER_LOCKED guard). Иначе можно «отвязать лекало» от
   уже идущего заказа — это может разойтись с уже посчитанной
   потребностью.

### Средний риск

4. **Расширение enum `Role`** (`PURCHASER`, `WAREHOUSE_KEEPER`,
   `TECHNOLOGIST`). Это **миграция** в Postgres + новые ветки в
   `apps/web/lib/rbac.ts` + проверки во всех `*.controller.ts` с
   `@Roles(...)`. *Митигация:* на первом этапе НЕ заводить новые
   роли, дать раздел `/admin/workshop-needs` существующему
   `SHOP_MANAGER`/`ADMIN`, а позже расширять enum отдельной
   миграцией с feature flag.
5. **Расчёт потребности от lazy-загруженных данных.** Если у
   пользователя выбрано лекало без `PatternMaterialArea` для
   нужного `materialRole`/`sizeId`, генерация молча пропустит
   строку. *Митигация:* отдавать предупреждение в UI («для размера
   M / роли LINING нет данных по площади»), ничего не блокировать
   — это рабочий процесс, а не enforcement.
6. **Постоянный конфликт «техкарта со строкой без `materialRole`»
   vs «расчёт потребности».** Старые техкарты не имеют
   `materialRole`. *Митигация:* `materialRole` опционален; для
   строки без него потребность не считаем (фолбэк — старая
   ручная закупка).

### Низкий риск

7. **Пункты sidebar.** Простое расширение массива `SECTIONS`,
   риск визуальный — слишком длинный список. *Митигация:*
   сгруппировать пункты под subsection («Производство», «Закупки»,
   «Справочники») — но это уже UI-задача отдельным шагом, без
   спешки.
8. **Audit log.** Просто добавлять новые `event`-коды
   (`PATTERN_CREATED`, `WORKSHOP_NEED_CALCULATED`,
   `SUPPLIER_CATALOG_ITEM_UPDATED`, …). По дизайну `AuditLog` это
   делается без миграции (см. комментарий в `prisma/schema.prisma:
   1497-1547`).

### Где лучше через feature flag

- Раздел «Лекала» (env `FEATURE_PATTERNS=1`) — пока
  storage-слой / DXF-загрузка не отлажены.
- Кнопка «Просчитать потребность» в карточке заказа
  (`FEATURE_WORKSHOP_NEEDS=1`) — пока техкарты не получили
  `materialRole`/`densityGsm`.
- Sidebar items должны рендериться только если соответствующий
  flag включён (тривиально через `process.env` в
  server-component).

---

## 13. Пошаговый план внедрения

> Задумано как очередь *отдельных* PR/этапов. Каждый этап
> заканчивается работающим состоянием, можно остановиться на
> любом шаге.

1. **Storage MVP** — добавить минимальный upload-сервис:
   `ServeStaticModule` на `/uploads/*`, `multer`-обвязка для
   multipart, структура папок `apps/api/uploads/patterns/...`.
   Сделать через feature flag `STORAGE_DRIVER=local`.
2. **Раздел «Лекала» (read-only)** — Prisma `PatternItem` +
   `PatternSizeFile` + `PatternMaterialArea`, миграция, API
   (только GET), UI `/admin/patterns` (список), `/admin/patterns/[id]`
   (детали). Sidebar пункт под feature flag.
3. **Лекала: загрузка превью и DXF** — POST/PATCH endpoints,
   формы загрузки на детали лекала, валидация типа файла, лимит
   размера. Версионирование `PatternSizeFile.version`.
4. **Лекала: площади материалов** — UI вкладки «Площади» с bulk
   replace (по аналогии с `TechCardsService.replaceMaterialLines`).
5. **Расширение `TechCardMaterialLine`** — миграция `ADD COLUMN
   materialRole|fabricType|densityGsm|plannedWidthCm|colorRule`
   (все nullable). Расширить UI `/admin/tech-cards/[id]` —
   опциональные поля. Совместимость со старыми техкартами
   полная.
6. **Связь `Order ↔ PatternItem`** — миграция `ADD COLUMN
   Order.patternItemId String NULL`, валидация в
   `OrdersService.create/update`, snapshot
   (`OrderMaterialRequirement` — расширить колонками
   `materialRole/fabricType/...`), UI селекта лекала в форме
   создания/редактирования заказа.
7. **Превью лекала в карточке заказа** — добавить блок
   `PatternPreviewCard` в правый верх в `app/orders/[id]/page.tsx`
   и `app/admin/orders/[id]/page.tsx`. Snapshot URL — опционально
   (можно отдавать live из `PatternItem.previewImageUrl`).
8. **Раздел «Поставщики»** — Prisma `Supplier` + `SupplierContact`
   + `SupplierCatalogItem`, миграция, API, UI
   `/admin/suppliers`, `/admin/suppliers/[id]`. Без связи с
   потребностью — отдельный, изолированный модуль.
9. **Раздел «Потребность цеха»** — Prisma `WorkshopNeed`,
   миграция, API GET/PATCH, UI `/admin/workshop-needs`. Кнопка
   «Просчитать потребность» в карточке заказа (feature flag).
10. **Алгоритм расчёта** — `WorkshopNeedsService.calculate(orderId)`
    реализует §10. Идемпотентно (чистит прежние `CALCULATED`,
    создаёт новые). Audit-log событие
    `WORKSHOP_NEED_CALCULATED`.
11. **Закупщик связывает потребность с поставщиком** — UI
    `/admin/workshop-needs/[id]`: поля `selectedSupplierId`,
    `selectedSupplierCatalogItemId`, `purchaseQty`, `quotedPrice`,
    `expectedDeliveryDate`. Никакой автоматики.
12. **(Позже)** Расширение enum `Role`: `PURCHASER`,
    `WAREHOUSE_KEEPER`, `TECHNOLOGIST`. Раздать раздел
    `/admin/workshop-needs` закупщику; раздел `/admin/patterns` —
    технологу. Отдельная миграция с продуманным набором RBAC-
    переключений.
13. **«PO создан и подтверждён»** — UI-кнопка
    «Подтвердить заказ у поставщика» в `/admin/workshop-needs/[id]`,
    endpoint `POST /api/workshop-needs/:id/place-purchase`,
    переход статуса `CALCULATED|REVIEWED → PURCHASE_PLACED`,
    обязательны `selectedSupplierId` и `purchaseQty`, фиксируем
    `purchasedAt`/`purchasedById`. Audit-event
    `WORKSHOP_NEED_PURCHASE_PLACED`. После этого `WorkshopNeed`
    становится «заказ у поставщика» — закупщик видит его в
    отдельном фильтре. Без отдельной модели `PurchaseOrder` —
    `WorkshopNeed` сам играет роль PO (см. §17).
14. **Приёмка от поставщика → ячейка** — UI-кнопка
    «Принять» в `/admin/workshop-needs/[id]` (или модалка
    `ReceiveDialog`), endpoint `POST /api/workshop-needs/:id/receive`,
    переход `PURCHASE_PLACED → RECEIVED`, поля
    `receivedQty`/`receivedAt`/`receivedById`/`receivedCellId`
    (FK → `Cell`). В той же транзакции — запись о наличии
    сырья в ячейке (см. §17 «Что добавить, чтобы пункт 8 работал»).
    Audit-event `WORKSHOP_NEED_RECEIVED`. Это и есть бывший
    «(Позже) Связать потребность с приёмкой и ячейками».

---

## 14. Предлагаемые изменения в БД

> Только описание схемы. Миграции не выполняем.

| Что добавить | Где | Файлы | Риск | Зависит от | Без миграции? | Нужна миграция? |
|---|---|---|---|---|---|---|
| `Order.patternItemId String?` (FK → `PatternItem`) + `@@index` | `prisma/schema.prisma:586` (рядом с `routeTemplateId`/`techCardId`) | + создаст соответствующую `migration.sql` | низкий (nullable, без default) | требует существования модели `PatternItem` | нет | да (этап 6) |
| `model PatternItem` | новая секция в `schema.prisma` | новая миграция | средний | storage-сервис | нет | да (этап 2) |
| `model PatternSizeFile` | то же | то же | средний | `Size`, `PatternItem`, storage-сервис | нет | да (этап 2/3) |
| `model PatternMaterialArea` | то же | то же | низкий | `Size`, `PatternItem` | нет | да (этап 2/4) |
| `TechCardMaterialLine.materialRole/fabricType/densityGsm/plannedWidthCm/colorRule` (все nullable) | `schema.prisma:1333` | новая миграция | низкий | — | нет | да (этап 5, `ADD COLUMN ... NULL`) |
| Аналогичные поля в `OrderMaterialRequirement` (snapshot) | `schema.prisma:1398` | то же | низкий | предыдущий пункт | нет | да |
| `model Supplier`, `SupplierContact`, `SupplierCatalogItem` + enum `SupplierStatus` | новая секция | новая миграция | низкий (изолированно) | — | нет | да (этап 8) |
| `model WorkshopNeed` + enum `WorkshopNeedStatus` | новая секция | новая миграция | средний (новая бизнес-сущность) | `Order`, `Supplier`, `SupplierCatalogItem` | нет | да (этап 9) |
| `WorkshopNeed.purchasedAt: DateTime?` + `purchasedById: String?` (FK → `Employee`) | секция `model WorkshopNeed` | дополнение миграции этапа 9 либо отдельная | низкий (nullable) | `Employee` | нет | да (этап 13) |
| `WorkshopNeed.receivedAt: DateTime?` + `receivedById: String?` (FK → `Employee`) + `receivedQty: Decimal? @db.Decimal(14,4)` + `receivedCellId: String?` (FK → `Cell`, `onDelete: SetNull`) | то же | то же | низкий (nullable) | `Cell`, `Employee` | нет | да (этап 14) |
| `model MaterialStock { id, cellId, workshopNeedId, materialRole, fabricType?, densityGsm?, plannedWidthCm?, colorText?, qty Decimal(14,4), unit, receivedAt, ... }` (раздельно от `CellContent`, потому что у того ключ `(cellId, sizeId)` и `Int quantity` под готовку) | новая секция в `schema.prisma` | новая миграция | средний (новая складская сущность) | `Cell`, `WorkshopNeed` | нет | да (этап 14) |
| Расширение enum `Role` (`PURCHASER`, …) | `schema.prisma:18` | новая миграция | средний (Postgres enum migration) | UI-слой и rbac.ts | нет | да (этап 12) |
| Audit-log события (`PATTERN_CREATED`, `WORKSHOP_NEED_*`, `SUPPLIER_*`) | `AuditService.log({ event: ... })` | без миграции | нулевой | — | да | нет |

---

## 15. Предлагаемые API endpoints

Без реализации. Полностью повторяет стиль уже существующих
`routes`/`tech-cards`/`clients` модулей.

### `/api/patterns`
- `GET    /api/patterns?search=&status=`
- `GET    /api/patterns/:id`
- `POST   /api/patterns`
- `PATCH  /api/patterns/:id`
- `POST   /api/patterns/:id/preview` (multipart)
- `GET    /api/patterns/:id/sizes`
- `POST   /api/patterns/:id/sizes/:sizeId/file` (multipart)
- `DELETE /api/patterns/:id/sizes/:sizeId/file/:fileId`
- `PUT    /api/patterns/:id/material-areas` (full-replace)

### `/api/suppliers`
- `GET    /api/suppliers?search=&status=`
- `GET    /api/suppliers/:id`
- `POST   /api/suppliers`
- `PATCH  /api/suppliers/:id`
- `POST   /api/suppliers/:id/contacts`
- `PATCH  /api/suppliers/:id/contacts/:contactId`
- `DELETE /api/suppliers/:id/contacts/:contactId`
- `GET    /api/suppliers/:id/catalog`
- `POST   /api/suppliers/:id/catalog`
- `PATCH  /api/suppliers/:id/catalog/:itemId`
- `DELETE /api/suppliers/:id/catalog/:itemId`

### `/api/workshop-needs`
- `GET    /api/workshop-needs?orderId=&status=&supplierId=`
- `GET    /api/workshop-needs/:id`
- `PATCH  /api/workshop-needs/:id`
- `POST   /api/workshop-needs/:id/cancel`
- `POST   /api/workshop-needs/:id/place-purchase` — закупщик
  подтверждает заказ у поставщика. Тело: `{ purchaseQty,
  selectedSupplierId, selectedSupplierCatalogItemId?, quotedPrice?,
  quotedCurrency?, expectedDeliveryDate? }`. Переход
  `CALCULATED|REVIEWED → PURCHASE_PLACED`. Audit
  `WORKSHOP_NEED_PURCHASE_PLACED`. Идемпотентно: повторный вызов
  на `PURCHASE_PLACED` отдаёт 409 (или мердж — на обсуждение).
- `POST   /api/workshop-needs/:id/receive` — приёмка от поставщика.
  Тело: `{ receivedQty, cellCode (или cellId) }` (`cellCode` —
  человекочитаемое `A-01-02`, резолвим в `cellId` через
  `Cell.code @unique`). Переход `PURCHASE_PLACED → RECEIVED`.
  В одной транзакции: апдейт `WorkshopNeed`, `prisma.materialStock.create({...})`,
  `audit.log({ event: 'WORKSHOP_NEED_RECEIVED' })`. Возвращает
  обновлённый `WorkshopNeed` + созданный `MaterialStock`.

### `/api/material-stock` (для пункта 8)
- `GET    /api/material-stock?cellId=&materialRole=&workshopNeedId=` —
  чтение остатков сырья по ячейке/роли/потребности.
  На MVP — только GET; create идёт только через `/receive`.

### Расширение `/api/orders`
- `POST   /api/orders/:id/workshop-needs/calculate` — сгенерировать
  потребность из заказа (использует выбранные `patternItemId`,
  `techCardId`, `OrderItem[]`).
- `GET    /api/orders/:id/workshop-needs` — список рассчитанных
  потребностей конкретного заказа.

---

## 16. Предлагаемые UI-страницы

Без реализации. Стиль — как у существующих
`/admin/tech-cards`, `/admin/routes`, `/admin/clients`.

### Лекала
- `/admin/patterns` — список карточек/таблица с превью.
- `/admin/patterns/new` — карточка создания (загрузка превью).
- `/admin/patterns/[id]` — детали:
  - блок «Основное» (article, name, category, status, description),
  - блок «Превью» (большое + ссылка на загрузку),
  - вкладка «Размеры и DXF» (таблица: размер, текущая версия
    файла, загрузить новую, история версий),
  - вкладка «Площади материалов» (матрица `Size × MaterialRole`
    с `areaM2`, edit-режим bulk replace).

### Заказы (расширение)
- `/admin/orders/new`, `/admin/orders/[id]/edit` —
  добавить селект «Лекало» рядом с «Техкартой» и «Маршрутом».
- `/admin/orders/[id]` и `/orders/[id]` — добавить компонент
  `PatternPreviewCard` в правый верхний угол + блок
  «Потребность цеха» (со списком рассчитанных потребностей и
  кнопкой «Просчитать»).

### Потребность цеха
- `/admin/workshop-needs` — рабочее место закупщика. Колонки:
  Заказ / materialRole / description / calculatedQty / purchaseQty
  / Поставщик / Цена / Статус. Фильтры: по заказу, по статусу,
  по поставщику, по материалу.
- `/admin/workshop-needs/[id]` — карточка одной потребности с
  редактированием полей закупщика.

### Поставщики
- `/admin/suppliers` — список.
- `/admin/suppliers/new` — карточка создания.
- `/admin/suppliers/[id]` — карточка:
  - блок «Реквизиты» (name, phone, website, address, comment, status),
  - блок «Контакты» (CRUD `SupplierContact`),
  - блок «Номенклатура» (CRUD `SupplierCatalogItem`).

---

## 17. Опорный happy-path E2E

> Это **acceptance-сценарий** для всей мягкой интеграции —
> проходит через все три новых модуля (Лекала, Потребность цеха,
> Поставщики) и заканчивается приходом сырья в ячейку. Если этот
> сценарий проходит end-to-end, MVP интеграции считается
> завершённым. Каждый шаг ниже привязан к существующей или
> предлагаемой сущности; ничего «магически» не предполагается.

### Исходные данные сценария

| Параметр | Значение |
|---|---|
| Заказ | один `Order` в `DRAFT`, с привязкой к `patternItemId`, `techCardId`, `routeTemplateId` |
| Размерная матрица | `OrderItem { sizeId: M, qtyPlan: 100 }` (только размер `M`) |
| Лекало | `PatternItem` с `PatternSizeFile { sizeId: M, fileUrl: '...M.dxf' }` и `PatternMaterialArea { sizeId: M, materialRole: MAIN_FABRIC, areaM2: 1.05 }` |
| Техкарта | `TechCardMaterialLine { materialRole: MAIN_FABRIC, fabricType: 'кулирка', densityGsm: 180, plannedWidthCm: 180 }` |
| Цвет | `Order.color = 'чёрный'` |
| Ячейка | существующий `Cell { code: 'A-01-02' }` (создаётся обычным `/admin/warehouses` flow, к рекону не относится) |

### Шаги

#### 1. Заказ с лекалом, техкартой, маршрутом

- **Актёр:** `SHOP_MANAGER` / `ADMIN`.
- **UI:** `apps/web/app/admin/orders/new/admin-create-order-form.tsx`
  — форма создания, поля «Маршрут», «Техкарта», **новый** селект
  «Лекало» (см. §16).
- **API:** `POST /api/orders` с `routeTemplateId`, `techCardId`,
  `patternItemId`.
- **БД:** `Order { status: DRAFT, routeTemplateId, techCardId,
  patternItemId, color }` + строки `OrderItem`.
- **Валидации:** `assertPatternUsable(patternItemId)`,
  `assertTechCardUsable(techCardId)`, `assertRouteTemplateUsable(...)`
  (все по той же схеме, что уже работает с `routeTemplateId` /
  `techCardId`, см. `OrdersService.create`).
- **Audit:** `ORDER_CREATED` (уже существует).

#### 2. Размер `M = 100`

- **Часть того же запроса** `POST /api/orders` либо последующего
  `PATCH`-а размерной матрицы.
- **БД:** `OrderItem { orderId, productId, sizeId: M, qtyPlan: 100 }`
  (`@@unique([orderId, productId, sizeId])`).
- **Никакой новой логики** — это уже работает.

#### 3. Лекало имеет DXF для `M`

- **Актёр:** `SHOP_MANAGER` (на MVP) / будущий `TECHNOLOGIST`.
- **UI:** `/admin/patterns/[id]` → вкладка «Размеры и DXF» (§16).
- **API:** `POST /api/patterns/:id/sizes/:sizeId/file` (multipart),
  storage-сервис кладёт файл в
  `apps/api/uploads/patterns/<patternId>/sizes/<sizeId>/<v>.dxf`,
  Prisma пишет `PatternSizeFile { patternItemId, sizeId: M, version,
  fileUrl }`.
- **Audit:** `PATTERN_SIZE_FILE_UPLOADED`.
- **Зависит от:** этап 1 §13 (Storage MVP), этап 3 §13 (загрузка
  превью и DXF).

#### 4. Площадь `MAIN_FABRIC` заполнена

- **Актёр:** тот же.
- **UI:** `/admin/patterns/[id]` → вкладка «Площади материалов»,
  bulk-replace (по образу `TechCardsService.replaceMaterialLines`,
  см. §16).
- **API:** `PUT /api/patterns/:id/material-areas` —
  full-replace (один tx: `deleteMany` + `createMany`).
- **БД:** `PatternMaterialArea { patternItemId, sizeId: M,
  materialRole: 'MAIN_FABRIC', areaM2: 1.05 }`.
- **Audit:** `PATTERN_MATERIAL_AREAS_REPLACED`.
- **Зависит от:** этап 4 §13.

#### 5. Потребность рассчитана

- **Актёр:** `SHOP_MANAGER` (нажимает «Просчитать потребность»
  в карточке заказа), позже — `PURCHASER`.
- **UI:** кнопка в `apps/web/app/admin/orders/[id]/page.tsx`
  (под `FEATURE_WORKSHOP_NEEDS=1`, см. §11/§12).
- **API:** `POST /api/orders/:id/workshop-needs/calculate`.
- **Алгоритм:** ровно §10. Считает
  `1.05 × 180 × 100 / 1000 = 18.9 кг`.
- **БД:** `WorkshopNeed { orderId, materialRole: 'MAIN_FABRIC',
  fabricType: 'кулирка', densityGsm: 180, plannedWidthCm: 180,
  colorText: 'чёрный', calculatedQty: 18.9, unit: 'кг',
  status: CALCULATED, description: 'Кулирка 180 г/м², чёрная,
  180 см' }`.
- **Идемпотентность:** повторный вызов чистит старые `CALCULATED`
  по `orderId` и заводит заново — см. §10.
- **Audit:** `WORKSHOP_NEED_CALCULATED`.
- **Зависит от:** этапы 5/6/9/10 §13.

#### 6. `purchaseQty = 20 кг`

- **Актёр:** закупщик (на MVP — тот же `SHOP_MANAGER`).
- **UI:** `/admin/workshop-needs/[id]` — поле «Заказать у
  поставщика, кг», селект `selectedSupplierId` +
  `selectedSupplierCatalogItemId`, опционально `quotedPrice`.
  Здесь же он округляет 18.9 → 20 (запас, кратность фасовки) —
  это его решение, не системы (см. инвариант §10
  «нет коэффициентов запаса»).
- **API:** `PATCH /api/workshop-needs/:id` с
  `{ purchaseQty: 20, selectedSupplierId, ... }`. Статус остаётся
  `CALCULATED` (или `REVIEWED`, если такое разрешим переключать
  отдельной кнопкой).
- **БД:** апдейт тех же полей `WorkshopNeed`. Никаких новых
  сущностей.
- **Audit:** `WORKSHOP_NEED_UPDATED` (универсальный) либо точечный
  `WORKSHOP_NEED_PURCHASE_QTY_SET`.
- **Зависит от:** этап 11 §13.

#### 7. PO создан и подтверждён

- **Семантика:** «PO» в этой архитектуре — это **тот же**
  `WorkshopNeed`, переведённый в статус `PURCHASE_PLACED`.
  Отдельной сущности `PurchaseOrder` нет и не нужно — ровно по
  принципу «не создаём заказ поставщику автоматически» из §10:
  `WorkshopNeed` и есть фиксация «закупщик заказал столько-то у
  такого-то». Если в будущем понадобятся multi-line PO (одна
  бумажка → несколько `WorkshopNeed`), вводим `PurchaseOrder`
  отдельной миграцией без слома существующего flow.
- **Актёр:** закупщик.
- **UI:** кнопка «Подтвердить заказ у поставщика» в
  `/admin/workshop-needs/[id]`. Кнопка активна, только если
  `purchaseQty > 0` и `selectedSupplierId != null`.
- **API:** `POST /api/workshop-needs/:id/place-purchase` (см. §15).
- **БД:** апдейт `WorkshopNeed { status: PURCHASE_PLACED,
  purchasedAt: now(), purchasedById }`. Новых сущностей нет,
  поля добавляем по §14.
- **Гарды:** только из `CALCULATED` или `REVIEWED`; обязательны
  `purchaseQty` и `selectedSupplierId`.
- **Audit:** `WORKSHOP_NEED_PURCHASE_PLACED`
  (`{ supplierId, purchaseQty, quotedPrice, quotedCurrency }`).
- **Зависит от:** этап 13 §13 (новый).

#### 8. Приёмка: `MAIN_FABRIC = 20 кг, cell = A-01-02`

- **Актёр:** будущий `WAREHOUSE_KEEPER` (на MVP — `SHOP_MANAGER`).
- **UI:** кнопка «Принять» в `/admin/workshop-needs/[id]`,
  открывает модалку `ReceiveDialog` с полями
  `receivedQty` (по умолчанию = `purchaseQty`) и `cellCode`
  (свободный ввод или сканирование QR ячейки;
  `Cell.qrCode @unique` уже есть).
- **API:** `POST /api/workshop-needs/:id/receive` (см. §15)
  с телом `{ receivedQty: 20, cellCode: 'A-01-02' }`.
- **БД (одна транзакция):**
  1. `cell = prisma.cell.findUniqueOrThrow({ where: { code: 'A-01-02' } })`.
  2. `prisma.workshopNeed.update({ status: RECEIVED, receivedAt:
     now(), receivedById, receivedQty: 20, receivedCellId: cell.id })`.
  3. `prisma.materialStock.create({ workshopNeedId, cellId: cell.id,
     materialRole: 'MAIN_FABRIC', fabricType: 'кулирка',
     densityGsm: 180, plannedWidthCm: 180, colorText: 'чёрный',
     qty: 20, unit: 'кг', receivedAt: now() })`.
  4. `audit.log({ event: 'WORKSHOP_NEED_RECEIVED', ... })`.
- **Гарды:** только из `PURCHASE_PLACED`; ячейка `active = true`;
  `receivedQty > 0`.
- **Audit:** `WORKSHOP_NEED_RECEIVED` + (опционально) производный
  `MATERIAL_STOCK_CREATED`.
- **Зависит от:** этап 14 §13 (новый).

### Что добавить, чтобы пункт 8 работал (важное про `CellContent`)

Существующий `CellContent` (`prisma/schema.prisma:1087`) под
приёмку сырья **не подходит**:

- ключ `(cellId, sizeId)` — у сырья нет `sizeId`;
- `quantity Int` — нам нужен `Decimal(14,4)` под килограммы.

**Вывод:** под приёмку сырья завести отдельную модель
`MaterialStock` (см. §14), не пытаясь расширить `CellContent`.
Это сохранит инварианты текущей WMS-light для готовой
продукции и явно разведёт два разных потока (готовка vs сырьё),
что согласуется со стилем «новый модуль рядом, старый не
ломаем» из §1.

Минимальный prisma-набросок (фиксируем здесь, миграцию НЕ
делаем — это этап 14 §13):

```prisma
model MaterialStock {
  id              String   @id @default(cuid())
  workshopNeedId  String
  cellId          String
  materialRole    String
  fabricType      String?
  densityGsm      Int?
  plannedWidthCm  Int?
  colorText       String?
  qty             Decimal  @db.Decimal(14, 4)
  unit            String   // 'кг' | 'м' | 'шт'
  receivedAt      DateTime @default(now())
  receivedById    String?

  workshopNeed    WorkshopNeed @relation(fields: [workshopNeedId], references: [id], onDelete: Restrict)
  cell            Cell         @relation(fields: [cellId], references: [id], onDelete: Restrict)
  receivedBy      Employee?    @relation(fields: [receivedById], references: [id], onDelete: SetNull)

  @@index([cellId])
  @@index([workshopNeedId])
  @@index([materialRole])
}
```

> На MVP «расход сырья в производство» из этой модели **не
> делаем** — только приход. Списание появится отдельным шагом,
> когда понадобится. Этим мы сохраняем правило «каждый этап
> заканчивается работающим состоянием».

### Пограничные случаи, которые сценарий явно НЕ покрывает

Перечислены, чтобы их не путали с regress'ами:

- **Частичная приёмка** (`receivedQty < purchaseQty`) — на MVP
  допустима как разовое событие, но без статуса
  `PARTIALLY_RECEIVED`; учётно отражается одной записью
  `MaterialStock` на фактический вес. Множественные приёмки —
  следующий этап, не входит в этот сценарий.
- **Возврат поставщику** — не входит, не вводим обратные статусы.
- **Списание сырья в производство** — не входит, см. выше.
- **Резерв сырья под конкретный заказ** — не вводится. На MVP
  `MaterialStock` лежит «общим котлом» в ячейке; связь с
  `Order` есть только через `WorkshopNeed.orderId`, без
  блокировок.
- **Несколько `MAIN_FABRIC` строк в одной техкарте** — алгоритм
  §10 их сгруппирует по ключу
  `(materialRole, fabricType, densityGsm, plannedWidthCm, color)`,
  поэтому в результате — один `WorkshopNeed`, как в сценарии.

### Acceptance-чек-лист (короткий)

После того как все пункты §13 (включая новые 13 и 14) реализованы,
этот сценарий должен проходиться без правок схемы:

- [ ] `POST /api/orders` принимает `patternItemId`.
- [ ] `POST /api/patterns/:id/sizes/M/file` сохраняет DXF и
      создаёт `PatternSizeFile`.
- [ ] `PUT /api/patterns/:id/material-areas` пишет
      `{ sizeId: M, materialRole: MAIN_FABRIC, areaM2: 1.05 }`.
- [ ] `POST /api/orders/:id/workshop-needs/calculate` создаёт
      `WorkshopNeed` с `calculatedQty = 18.9`, `unit = 'кг'`.
- [ ] `PATCH /api/workshop-needs/:id` принимает
      `purchaseQty = 20` + `selectedSupplierId`.
- [ ] `POST /api/workshop-needs/:id/place-purchase` переводит в
      `PURCHASE_PLACED`, пишет `purchasedAt`/`purchasedById`,
      аудит `WORKSHOP_NEED_PURCHASE_PLACED`.
- [ ] `POST /api/workshop-needs/:id/receive` с
      `{ receivedQty: 20, cellCode: 'A-01-02' }`:
      - переводит `WorkshopNeed` в `RECEIVED`,
      - создаёт `MaterialStock { qty: 20, cell.code = 'A-01-02' }`,
      - пишет аудит `WORKSHOP_NEED_RECEIVED`,
      - всё одной транзакцией.
- [ ] `GET /api/material-stock?cellId=<A-01-02 id>` возвращает
      созданную позицию.

---

## Итог: краткое резюме

### Что уже реализовано

- **Заказы покупателя** с `routeTemplateId`, `techCardId`, размерной
  матрицей, snapshot маршрута/материалов на запуске.
- **Маршруты производства** с шаблонами и snapshot на заказе.
  Маршрут уже отделён от техкарты — точно как просит ТЗ.
- **Техкарты** с материалами и внешними подрядными размещениями,
  snapshot на заказе, идемпотентный pattern.
- **Клиенты, склад/ячейки/линии, паспорта, печать,
  принтеры/агент, оборудование, операции, начисления, аудит** —
  всё работает.

### Что нужно добавить

- **Лекала** (`PatternItem` + `PatternSizeFile` +
  `PatternMaterialArea`) — отдельный модуль, не перепиливать
  `Product`.
- **Поставщики** (`Supplier` + `SupplierContact` +
  `SupplierCatalogItem`) — изолированный модуль.
- **Потребность цеха** (`WorkshopNeed`) — рабочее место закупщика,
  считает чистую потребность по формуле
  `area × density × qty / 1000`.
- **Расширения `TechCardMaterialLine`** — `materialRole`,
  `fabricType`, `densityGsm`, `plannedWidthCm`, `colorRule`
  (все nullable).
- **`Order.patternItemId`** — опциональная связь с лекалом, по
  тем же правилам, что `routeTemplateId`/`techCardId`.
- **Storage-сервис** для DXF и превью лекала — сейчас в проекте
  файловых аплоадов нет совсем.
- **PO/приёмка как продолжение `WorkshopNeed`** (этапы 13–14
  §13): поля `purchasedAt`/`purchasedById`/`receivedAt`/
  `receivedById`/`receivedQty`/`receivedCellId` на
  `WorkshopNeed` + endpoint'ы `/place-purchase` и `/receive`.
  Без отдельной модели `PurchaseOrder` — сам `WorkshopNeed`
  играет роль PO.
- **`MaterialStock`** — новая модель учёта сырья по ячейкам
  (отдельно от `CellContent`, у которого ключ `(cellId, sizeId)`
  под готовую продукцию). Создаётся в той же транзакции, что
  и `RECEIVED`-переход потребности.
- Опорный сценарий, который должен пройти end-to-end после
  всех правок, описан в §17.

### Самый безопасный первый шаг

Завести **новый модуль «Лекала» (`PatternItem`) read-only** без
вмешательства в заказы и техкарты:

1. Простой storage-сервис (`ServeStaticModule` + `multer`).
2. Prisma `PatternItem` + `PatternSizeFile` + `PatternMaterialArea`
   (новая изолированная миграция).
3. API `GET/POST/PATCH /api/patterns` (RBAC: `ADMIN` /
   `SHOP_MANAGER`).
4. UI `/admin/patterns/*` под общим `AdminSectionLayout`.
5. Sidebar пункт под feature flag `FEATURE_PATTERNS=1`.

Заказ при этом **не трогаем**: `Order.patternItemId` и расчёт
потребности подключаются на следующих этапах. После шага 1
систему можно показать пользователю — она остаётся полностью
работоспособной, лекала живут как самостоятельный справочник.

---

## 8. «Номенклатура = Лекала» — лекало как единственная видимая номенклатура

### Цель

Перенести создание заказа на UX-модель «номенклатура = лекало»:
менеджер видит только `PatternItem` («Номенклатура / лекало»),
старая «учётная» сущность `Product` сознательно прячется в backend
как legacy-совместимая.

Бизнес-смысл:

- Было — менеджер выбирает `Product` (учётное изделие) и отдельно
  лекало; цвет приходил из `Product.color` по умолчанию.
- Стало — менеджер выбирает только `PatternItem`; цвет указывается
  отдельно; технический `Product` создаётся/находится автоматически
  и остаётся живым только для legacy-связей (паспорта, payroll,
  маршруты, техкарты; историческую таблицу `PieceRate` снесли в
  PHASE 2 STEP 1, см. ADR-0020 §«PHASE 2 — drop legacy»).

### Что НЕ меняем

- `Product` как таблица остаётся (паспорта и payroll по нему живут).
- `OrderItem.productId` остаётся обязательным.
- `Passport.productId` не трогаем.
- payroll / маршруты / техкарты / крой не меняем (историческая
  таблица `PieceRate` удалена в PHASE 2 STEP 1, ставки живут
  в `Operation.fixedRate` / `OperationRateBySize`).
- Легаси-страницы `/orders/new` и `/orders/[id]/edit` оставляем как
  есть — на них полагается `CUTTER_ASSISTANT`-flow и прямые
  POST-интеграции, которые ходят с `productId` без `patternItemId`.

### Что меняем

1. **Prisma**

   В `model PatternItem` добавляется nullable связь со скрытым
   legacy `Product`:

   ```prisma
   legacyProductId String? @unique
   legacyProduct   Product? @relation("PatternLegacyProduct",
       fields: [legacyProductId], references: [id],
       onDelete: SetNull, onUpdate: Cascade)
   ```

   В `model Product` — back-relation `patternItems
   PatternItem[] @relation("PatternLegacyProduct")`. Миграция
   `20260513100000_pattern_legacy_product_link` — additive (только
   `ALTER TABLE PatternItem ADD COLUMN`, UNIQUE-индекс и FK с
   `ON DELETE SET NULL`); `OrderItem`/`Passport`/`Product` SQL не
   трогается.

2. **Backend — `OrdersService.ensureLegacyProductForPattern(patternItemId, tx)`**

   - вызывается ВНУТРИ транзакции `OrdersService.create()` и
     `OrdersService.update()` (когда меняется `patternItemId`);
   - возвращает id «технического» `Product` для подстановки в
     `OrderItem.productId`;
   - если у лекала уже есть `legacyProductId` и `Product`
     существует — переиспользует его (инвариант «один лекало =
     один Product», обеспечен `@unique` на `legacyProductId`);
   - иначе создаёт новый `Product` (`name = pattern.name`,
     `color = ''`, `active = true`) и проставляет
     `PatternItem.legacyProductId`.

   Лекало предварительно валидируется через `assertPatternUsable`
   (404 `PATTERN_NOT_FOUND` / 409 `PATTERN_INACTIVE`).

3. **Shared / Zod — `CreateOrderSchema` / `UpdateOrderSchema`**

   - `productId: z.string().min(1).optional()` — больше НЕ требуется
     жёстко;
   - `patternItemId: z.string().min(1).nullable().optional()` — как
     раньше;
   - `superRefine`: если **оба** поля пустые → адресная ошибка
     `«Выберите номенклатуру / лекало»` на пути `patternItemId`.

   `UpdateOrderSchema` оставляет `productId` опциональным —
   admin-форма его больше не шлёт; backend сам derive-ит legacy
   product при смене лекала, либо использует текущий
   `OrderItem.productId`.

4. **Frontend — `/admin/orders/new`**

   - Удалено поле «Учётное изделие» (`productId`-select,
     secondary-контейнер, подсказка «Используется для текущего
     учёта»).
   - В блоке «2. Изделие» ровно один select
     `name="patternItemId"` с лейблом **«Номенклатура / лекало»**
     и подсказкой «Основная карточка изделия: превью, DXF и площади
     материалов.».
   - `required` на select-е — для UX, валидное сообщение
     приходит от Zod-superRefine на server action.
   - Страница `/admin/orders/new/page.tsx` больше не вызывает
     `listProducts()`.

5. **Frontend — `/admin/orders/[id]/edit`**

   - Из карточки «3. Изделие» удалён `productId`-select;
     селект «Номенклатура / лекало» (`patternItemId`) переехал
     сюда — это и есть номенклатура заказа.
   - В DRAFT — редактируется; в IN_PRODUCTION/DONE/CANCELLED —
     `disabled` (snapshot полей лекала уже зафиксирован).
   - При смене `patternItemId` в DRAFT backend через
     `ensureLegacyProductForPattern()` пересинхронизирует
     `OrderItem.productId` для всех строк заказа сразу — менеджер
     этого не видит, паспорта/payroll получают согласованную
     legacy-привязку «через пересоздание helper-ом».

6. **Тесты**

   - Smoke: `/admin/orders/new` НЕ содержит
     `name="productId"` / «Учётное изделие» / «Используется для
     текущего учёта», содержит `name="patternItemId"` и
     «Номенклатура / лекало» (см.
     `tests/smoke/admin-orders-create.smoke.test.ts`).
   - Smoke на edit: `/admin/orders/[id]/edit` содержит
     `name="patternItemId"`, не содержит `name="productId"` (см.
     `tests/smoke/admin-order-edit.smoke.test.ts`).
   - Integration: `tests/integration/orders-pattern-as-product.test.ts`
     проверяет:
       - POST без productId создаёт legacy Product, проставляет
         `PatternItem.legacyProductId` и заполняет
         `OrderItem.productId`;
       - повторный POST с тем же лекалом не плодит второй Product;
       - POST без обоих полей → 400 с адресным сообщением;
       - legacy POST с productId без patternItemId продолжает
         работать;
       - PATCH `patternItemId` на DRAFT синхронизирует
         `OrderItem.productId` на legacy Product нового лекала.

### Stage / dev cleanup

Миграция additive и **не делает** destructive cleanup. Если в
stage-/dev-окружении есть «тестовые» заказы, их можно безопасно
удалить через существующий админ-API/UI до проверки нового flow —
никаких SQL-скриптов не требуется.

---

## RESOLUTION 2026-05-09: единая сущность полуфабриката

Все упоминания `CellContent` в этом документе теперь **исторические**.
Модель физически удалена из схемы; на её место пришли
`WorkInProgressBalance` + `WorkInProgressMovement` (Вариант 3).

Ключевые отличия от старой `CellContent`:
- больше измерений: `(orderId, productId, sizeId, color,
  warehouseId?, cellId?)` вместо `(cellId, sizeId)`;
- журнал движений `WorkInProgressMovement` (PLACE / ISSUE / RETURN /
  DELETE / PACK_OUT) с `sourceKey @unique` для идемпотентности;
- единый источник истины — все consumer'ы (`listCells()` API,
  `WarehousesService.deleteLine`, `DiagnosticsService`,
  shelf-placement UI) читают отсюда;
- может быть использована как основа для фичи «промежуточный контроль
  расхода материала на выпуске кроя» (привязка `MaterialIssue` к
  конкретному `WorkInProgressMovement.PLACE`).

Подробнее: `docs/erd.md §2.7b`, `docs/api.md §29b`,
`docs/flows.md §F3`/`§F3b`.
