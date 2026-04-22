# API

> REST. Префикс всех путей: `/api`. Ответы: `application/json`.
> Аутентификация (MVP 1.1): подписанная HttpOnly session-cookie `sewing_session`
> (HMAC-SHA256, см. [ADR-0014](./adr/0014-auth-and-sessions.md)). Cookie ставится
> на login и удаляется на logout. На защищённых endpoint-ах сервер проверяет
> подпись, срок действия и подгружает «свежие» поля сотрудника из БД.
> JWT с `Authorization: Bearer …` в MVP 1.1 не используется — внешних
> интеграций ещё нет.

Легенда ролей (RBAC): `ADMIN | SHOP_MANAGER | CUTTER | CUTTER_ASSISTANT | SEAMSTRESS | QC | IRONING | PACKING`.

Все endpoint-ы по умолчанию требуют валидную сессию. Публичные исключения
помечены `@Public()` в коде и здесь — пустой колонкой «Роли» / `Any (public)`.
Для специфичных ролей используется `@Roles(...)` (на уровне класса и/или
метода — метод-уровень переопределяет класс). `ADMIN` — глобальный
override и проходит любой `@Roles(...)`. При несоответствии — `403 FORBIDDEN_ROLE`,
при отсутствии сессии — `401 UNAUTHENTICATED`.

### Скоупы доступа по разделам (источник истины — backend)

Закрытые рабочие разделы ограничены ровно теми ролями, которые с ними
работают. Frontend (`apps/web/lib/rbac.ts`) скрывает соответствующие
разделы навигации/кнопки, layouts (`/qc`, `/packing`, `/orders`) делают
SSR-редирект на `/`, но реальный отказ выдаёт API:

| Раздел       | Роли с доступом                       | Прим.                                                                 |
| ------------ | ------------------------------------- | --------------------------------------------------------------------- |
| `/api/qc/*` + `/api/defect-types` | `QC`, `SHOP_MANAGER` (+ `ADMIN`) | Карточка ОТК и справочник видов брака. Прочие роли — `403`.          |
| `/api/packing/boxes/*` (кроме `/qr` и `/label`) | `PACKING`, `SHOP_MANAGER` (+ `ADMIN`) | `qr`/`label` остаются `@Public()` для печати этикетки и сканера. |
| `/api/orders/*` (write)            | `SHOP_MANAGER` (+ `ADMIN`)             | Создание/редактирование/start/complete/cancel.                        |
| `/api/orders` + `/api/orders/:id` + `/api/orders/:id/passports` (read) | `SHOP_MANAGER`, `CUTTER_ASSISTANT` (+ `ADMIN`) | Помощник раскройщика стартует «Выпустить паспорт» с `/work` через упрощённый server-route `/work/cut-orders`, который зовёт `GET /api/orders?status=IN_PRODUCTION`; UI сам admin-раздел `/orders` ему не показывает. |

См. также §10 «Видимость по ролям (RBAC)» для earnings-скоупа.

---

## 0. Health / Ready (MVP 1.1)

| Метод | Путь          | Роли | Описание                                                    |
| ----- | ------------- | ---- | ----------------------------------------------------------- |
| GET   | `/api/health` | —    | Liveness. Возвращает `{ status: "ok", time }`. Без БД.       |
| GET   | `/api/ready`  | —    | Readiness. Дополнительно пингует БД (`SELECT 1`).            |

`health` нужен для docker/nginx liveness, `ready` — для readiness/load balancer.
Никакой бизнес-логики, никаких секретов в ответе.

---

## 1. Auth

| Метод | Путь                | Роли | Описание                                                                      |
| ----- | ------------------- | ---- | ----------------------------------------------------------------------------- |
| POST  | `/api/auth/login`   | —    | `{ login, password }` → `{ user }`. На успех — `Set-Cookie: sewing_session=…`. |
| POST  | `/api/auth/logout`  | —    | Идемпотентно затирает cookie (`Max-Age=0`). Возвращает `204`.                  |
| GET   | `/api/auth/me`      | Any  | Текущий пользователь (`{ user: { id, login, fullName, role } }`).              |

Тело `POST /api/auth/login`:

```json
{ "login": "shop-chief", "password": "Demo12345!" }
```

`401 INVALID_CREDENTIALS` — неверный логин/пароль; `403 EMPLOYEE_INACTIVE` —
сотрудник деактивирован. `password` хранится как `bcrypt(pinHash)` — поле
`Employee.pinHash`.

Cookie:

- имя — `sewing_session`;
- атрибуты — `HttpOnly; Path=/; SameSite=Lax`;
- в production добавляются `Secure` и `Domain=.teeon.ru`, чтобы web
  (`prod.teeon.ru`) и API (`api.prod.teeon.ru`) шарили одну сессию;
- срок жизни — `JWT_EXPIRES_IN` (по умолчанию `12h`), задаётся `Max-Age` и
  внутренним `exp` в подписанном payload.

Frontend (Next.js) проксирует cookie через server actions: при логине из
RSC получаем `Set-Cookie` от API и сохраняем его в `cookies()` Next-а;
при logout — наоборот, очищаем оба слоя.

---

## 2. Справочники

| Метод | Путь                    | Роли                | Описание                     |
| ----- | ----------------------- | ------------------- | ---------------------------- |
| GET   | `/api/sizes`            | Any                 | Все размеры (сорт. по `sortOrder`) |
| POST  | `/api/sizes`            | ADMIN               | Создать размер               |
| PATCH | `/api/sizes/:id`        | ADMIN               | Обновить                     |
| GET   | `/api/products`         | Any                 | Список изделий               |
| POST  | `/api/products`         | ADMIN               | Создать                      |
| GET   | `/api/operations`       | Any                 | Список операций              |
| POST  | `/api/operations`       | ADMIN               | Создать                      |
| GET   | `/api/piece-rates`      | ADMIN, SHOP_MANAGER | Все расценки                 |
| POST  | `/api/piece-rates`      | ADMIN               | Создать расценку             |

---

## 3. Сотрудники и оборудование

| Метод | Путь                       | Роли         | Описание                      |
| ----- | -------------------------- | ------------ | ----------------------------- |
| GET   | `/api/employees`           | ADMIN, SM    | Список сотрудников            |
| POST  | `/api/employees`           | ADMIN        | Создать                       |
| PATCH | `/api/employees/:id`       | ADMIN        | Обновить                      |
| GET   | `/api/equipment`           | ADMIN, SM    | Список оборудования (см. §3a) |
| POST  | `/api/equipment`           | ADMIN, SM    | Создать оборудование (`name` обязательно, `code` опционален — backend сгенерирует slug; `displayNumber` и `operationIds` опциональны) |
| GET   | `/api/equipment/:id`       | ADMIN, SM    | Карточка с allowed-операциями |
| PATCH | `/api/equipment/:id`       | ADMIN, SM    | Точечное обновление карточки (`name` и/или `displayNumber`) |
| PATCH | `/api/equipment/:id/operations` | ADMIN, SM | Полная замена набора разрешённых операций |
| GET   | `/api/equipment/:id/qr`    | Any (public) | PNG QR-кода (`equipment:{id}` по ADR-0008) |
| GET   | `/api/equipment/:id/print` | Any (public) | HTML-этикетка для печати: крупный `displayNumber` + QR + название/код |

> Облегчённый список оборудования для seamstress flow на /work
> (включая `allowedOperationIds`) приходит через `GET /api/shifts/meta`,
> а не через `/api/equipment` — последний реализован как admin/manager
> surface (см. §3a).

### 3a. Управление оборудованием и его операциями (ADR-0017)

Реализовано в модуле `apps/api/src/modules/equipment`. Источник истины
для seamstress flow на `/work` теперь backend: связь
«оборудование → разрешённые операции» хранится в таблице
`EquipmentOperation` (см. `docs/erd.md §2.5a`, `docs/domain.md §5c`).
До этого изменения список вычислялся на фронте по префиксу
`Equipment.code` — этот хардкод удалён.

#### `GET /api/equipment`

Список оборудования для админ-настройки.
Роли: `ADMIN`, `SHOP_MANAGER`.

Ответ — массив `EquipmentSummaryDto`:

```json
[
  {
    "id": "clx...",
    "code": "overlock-01",
    "qrCode": "equipment:clx...",
    "name": "Оверлок 01",
    "displayNumber": "1",
    "active": true,
    "allowedOperationsCount": 2
  }
]
```

`allowedOperationsCount` — число активных связей с активной операцией
(`EquipmentOperation.isActive AND Operation.active`).
`displayNumber` — ручной отображаемый номер станка (см.
`GET /api/equipment/:id/print` ниже). `null`, если не задан.

#### `GET /api/equipment/:id`

Карточка оборудования с разрешёнными операциями (упорядочено по
`EquipmentOperation.sortOrder`). Роли: `ADMIN`, `SHOP_MANAGER`.

```json
{
  "id": "clx...",
  "code": "overlock-01",
  "qrCode": "equipment:clx...",
  "name": "Оверлок 01",
  "displayNumber": "1",
  "active": true,
  "allowedOperations": [
    {
      "operationId": "clx...",
      "operationCode": "SEW_OVERLOCK_1",
      "operationName": "Оверлок 1",
      "operationCategory": "SEWING",
      "sortOrder": 10,
      "isActive": true
    },
    {
      "operationId": "clx...",
      "operationCode": "SEW_OVERLOCK_2",
      "operationName": "Оверлок 2",
      "operationCategory": "SEWING",
      "sortOrder": 20,
      "isActive": true
    }
  ]
}
```

Ошибки: `404 EQUIPMENT_NOT_FOUND`.

#### `POST /api/equipment`

Создание новой единицы оборудования из `/admin/equipment`. Роли:
`ADMIN`, `SHOP_MANAGER`. Тело валидируется Zod-схемой
`CreateEquipmentSchema` (см. `packages/shared/src/equipment.ts`).

Тело:

```json
{
  "name": "Оверлок 03",
  "code": "overlock-03",
  "displayNumber": "3",
  "operationIds": ["clx_op_1", "clx_op_2"]
}
```

Семантика:

- `name` — обязательно, 1..120 символов после трима. Видно в списке
  оборудования, на печатной QR-этикетке и в форме старта смены у швеи.
- `code` — опционально, slug формата `^[a-z0-9][a-z0-9-]*$` до 64 символов.
  Если не передан или пуст, backend генерирует код из транслита `name`
  с автоматическим суффиксом `-2`, `-3`, … для уникальности.
- `displayNumber` — опционально, 1..16 символов. Пустая строка после
  трима трактуется как `null` (см. `PATCH /api/equipment/:id` ниже).
- `operationIds` — опциональный массив `Operation.id`. Если передан,
  в той же транзакции создаются связи `EquipmentOperation` с
  `sortOrder = (i + 1) * 10` (порядок задаёт менеджер из формы).
  До 100 элементов, без дубликатов.

`qrCode` сознательно НЕ принимается — backend ставит каноничный
`equipment:{id}` (ADR-0008), чтобы scan flow на /work остался
совместимым (работает та же двухфазная схема, что и в `prisma/seed.ts`:
сначала временный `equipment-pending:{code}`, затем апдейт на
`equipment:{id}`).

`active` при создании всегда `true` — деактивация выполняется отдельным
PATCH-ом (вне MVP).

Ответ — `EquipmentDetailDto` нового оборудования (HTTP 201).

Ошибки:

| Код                     | HTTP | Когда                                                              |
| ----------------------- | ---- | ------------------------------------------------------------------ |
| `VALIDATION_ERROR`      | 400  | Пустой `name`, длина `name > 120`, неверный формат `code`, дубли в `operationIds` |
| `OPERATION_NOT_FOUND`   | 404  | хотя бы один `operationId` не существует                           |
| `EQUIPMENT_CODE_TAKEN`  | 409  | `code` уже занят (явно переданный или автогенерированный)          |

#### `PATCH /api/equipment/:id`

Точечное обновление карточки оборудования. Роли: `ADMIN`,
`SHOP_MANAGER`. Тело валидируется Zod-схемой
`UpdateEquipmentSchema` (см. `packages/shared/src/equipment.ts`).

Поддерживаются два поля: `name` (переименование) и `displayNumber`
(ручной номер станка для физической маркировки, см.
`GET /api/equipment/:id/print` ниже). Хотя бы одно из них должно
прийти в запросе. `code`, `qrCode` и `active` через эту ручку
сознательно не меняются — это сохраняет совместимость с
существующими printer-bindings, scan flow и уже напечатанными
QR-этикетками.

Тело (любое подмножество полей):

```json
{ "name": "Оверлок 03", "displayNumber": "3" }
```

Семантика:

- `name` — 1..120 символов после трима. После сохранения
  ревалидируется `/work` (швея видит новое имя в форме старта смены).
- `displayNumber` — строка обрезается по краям (`trim`); пустая строка
  после трима трактуется как `null` (сброс номера); `null` передаётся
  явно тоже как сброс; ограничение длины — 16 символов.

Ответ — обновлённый `EquipmentDetailDto`.

Ошибки:

| Код                    | HTTP | Когда                                                  |
| ---------------------- | ---- | ------------------------------------------------------ |
| `VALIDATION_ERROR`     | 400  | Пустой `name`, длина `name > 120`, длина `displayNumber > 16`, пустое тело |
| `EQUIPMENT_NOT_FOUND`  | 404  | `id` не существует                                     |

#### `GET /api/equipment/:id/print` и `GET /api/equipment/:id/qr`

Печатная этикетка QR-кода оборудования. Оба endpoint-а помечены
`@Public()` — той же логикой, что и `/api/passports/:id/print` и
`/api/packing/boxes/:id/label`: принтер-станция в типографии может
работать без сессии. RBAC сохраняется только на изменение
(PATCH-ах).

`/print` отдаёт HTML под `@page A6` + `@media print`. Визуальный
приоритет на этикетке (см. `docs/screens.md §10a` и
`apps/api/src/modules/equipment/equipment-print.ts`):

1. `displayNumber` — самый крупный элемент (~6rem, жирный).
2. QR-код (`equipment:{id}`).
3. Название оборудования.
4. Код оборудования (`Equipment.code`).

Если `displayNumber` не задан, на этикетке выводится «Оборудование
(номер не задан)» и `№—` — это не падение, а явное приглашение
заполнить поле в `/admin/equipment/[id]`.

`/qr` отдаёт чистый PNG того же `equipment:{id}` (формат QR не
меняется, ADR-0008 — scan flow на `/work` остаётся совместимым).

#### `PATCH /api/equipment/:id/operations`

Полная замена набора разрешённых операций. Роли: `ADMIN`,
`SHOP_MANAGER`. Запрос валидируется Zod-схемой
`UpdateEquipmentOperationsSchema`.

Тело:

```json
{ "operationIds": ["clx_op_1", "clx_op_2"] }
```

Семантика:

- сравниваем текущий состав с пришедшим в одной транзакции;
- удаляем строки, чьи `operationId` не попали в запрос;
- добавляем недостающие;
- `sortOrder` обновляется по индексу массива (`(i + 1) * 10`),
  поэтому порядок в `operationIds` — это порядок выбора на /work;
- `isActive` всем оставшимся выставляется в `true` (мягкое
  отключение явно через PATCH сейчас не делается, но поле
  предусмотрено в схеме и интерпретируется при чтении в meta).

Ответ — обновлённый `EquipmentDetailDto`.

Ошибки:

| Код                    | HTTP | Когда                                                  |
| ---------------------- | ---- | ------------------------------------------------------ |
| `VALIDATION_ERROR`     | 400  | Пустые id, дубликаты, длина списка > 100               |
| `EQUIPMENT_NOT_FOUND`  | 404  | `id` не существует                                     |
| `OPERATION_NOT_FOUND`  | 404  | хотя бы один `operationId` не существует               |

#### Связь с `/api/shifts/meta`

`GET /api/shifts/meta` (открыт любой авторизованной роли — нужен
`/work`) теперь возвращает у каждой единицы оборудования поле
`allowedOperationIds` — массив `Operation.id`, отсортированный по
`EquipmentOperation.sortOrder`. Сюда не попадают:

- неактивные связи (`EquipmentOperation.isActive = false`);
- связи с `Operation.active = false`.

Это и есть «контракт между admin/equipment и /work»: после PATCH-а
набора SHOP_MANAGER на следующем чтении meta швея видит уже новый
allow-лист. Frontend `/admin/equipment/[id]` дополнительно ревалидирует
`/work`.

### Сессии смены

> Реализовано на **Шаге 6 MVP** (модуль `apps/api/src/modules/shifts`).
> До появления auth (Шаг 7) `employeeId` приходит явно — в теле POST
> и в query для GET. Web-клиент хранит выбранного демо-сотрудника в
> cookie `demo-employee-id`.

| Метод | Путь                       | Роли                | Описание                                           |
| ----- | -------------------------- | ------------------- | -------------------------------------------------- |
| POST  | `/api/shifts/start`        | Сотрудник           | `{ employeeId, equipmentId, operationId }` → создать сессию |
| POST  | `/api/shifts/stop`         | Сотрудник           | `{ employeeId }` → закрыть активную сессию         |
| GET   | `/api/shifts/current`      | Сотрудник           | `?employeeId=…` — текущая активная сессия или `null` |
| GET   | `/api/shifts/current-work` | Сотрудник           | Активные кройи, закреплённые за сессионным сотрудником (см. ниже) |
| GET   | `/api/shifts/meta`         | Сотрудник           | Справочники для формы смены (employees, equipment с `allowedOperationIds`, operations) |

**Тело `POST /api/shifts/start`:**

```json
{
  "employeeId": "clx...",
  "equipmentId": "clx...",
  "operationId": "clx..."
}
```

**Ответ (`ShiftSessionDto`):**

```json
{
  "id": "clx...",
  "employeeId": "clx...",
  "employeeFullName": "Демо Швея",
  "equipmentId": "clx...",
  "equipmentCode": "overlock-01",
  "equipmentName": "Оверлок 01",
  "operationId": "clx...",
  "operationCode": "SEW_OVERLOCK_1",
  "operationName": "Оверлок 1",
  "startedAt": "2026-04-18T08:00:00.000Z",
  "endedAt": null,
  "active": true
}
```

**Ошибки:**

| Код                    | HTTP | Когда                                         |
| ---------------------- | ---- | --------------------------------------------- |
| `EMPLOYEE_NOT_FOUND`   | 404  | `employeeId` не найден                        |
| `EMPLOYEE_INACTIVE`    | 409  | сотрудник есть, но `active = false`           |
| `EQUIPMENT_NOT_FOUND`  | 404  | `equipmentId` не найден                       |
| `EQUIPMENT_INACTIVE`   | 409  | оборудование деактивировано                   |
| `OPERATION_NOT_FOUND`  | 404  | `operationId` не найден                       |
| `OPERATION_INACTIVE`   | 409  | операция деактивирована                       |
| `SHIFT_ALREADY_ACTIVE` | 409  | у сотрудника уже есть активная смена          |
| `SHIFT_NOT_ACTIVE`     | 409  | `/stop` вызван, когда активной смены нет      |

### `GET /api/shifts/current-work` — текущий крой в работе

Кройи, закреплённые за **текущим сотрудником сессии** прямо сейчас.
Нужен для устойчивого блока «Текущий крой» на `/work` (см.
`docs/screens.md §3.4`).

**Правило отбора:**
`Passport.currentEmployeeId = me.employeeId` И
`Passport.status = IN_PROGRESS`. Любое следующее движение паспорта
(другой сотрудник скан-нул на следующей операции, упаковка закрыла
паспорт) автоматически выводит запись из ответа — отдельной операции
«вернуть крой» нет (см. `docs/flows.md §F3a`/`§F4`).

**Безопасность:** `employeeId` приходит исключительно из cookie
сессии (`@CurrentUser`, ADR-0014). Передать чужой `employeeId` через
query/body нельзя — обычный сотрудник физически не увидит чужой
крой через этот endpoint.

**Сортировка:** `Passport.updatedAt DESC` — самый свежий крой сверху.

**Ответ — массив `CurrentWorkPassportDto`:**

```json
[
  {
    "id": "clx...",
    "number": "P-20260418-0001",
    "productName": "Футболка базовая",
    "color": "Белая",
    "sizeId": "clx...",
    "sizeCode": "M",
    "qtyCut": 5,
    "qtyGood": 5,
    "qtyDefect": 0,
    "rollNumber": "R-01",
    "status": "IN_PROGRESS",
    "currentOperationId": "clx...",
    "currentOperationCode": "SEW_OVERLOCK_1",
    "currentOperationName": "Оверлок 1",
    "acceptedAt": "2026-04-18T08:12:00.000Z",
    "updatedAt": "2026-04-18T08:12:00.123Z"
  }
]
```

`acceptedAt` — время последнего `PassportEvent(ISSUED_TO_EMPLOYEE)`
самого сотрудника по этому паспорту. Может быть `null`, если событие
не сохранилось (UI в этом случае ориентируется на `updatedAt`).
Если активного кроя нет — возвращается `[]`.

---

## 3b. Сотрудники — управленческий блок (`/api/employees`, ADR-0021)

> Реализовано пост-Шагом 18 (модуль `apps/api/src/modules/employees`,
> см. [ADR-0021](./adr/0021-shift-day-salary.md), `domain.md §9a`,
> `screens.md §10d`). Контракты — `packages/shared/src/employees.ts`
> (`COMPENSATION_TYPES`, `ListEmployeesQuerySchema`,
> `UpdateEmployeeSchema`, `EmployeeListItemDto`, `EmployeeDetailDto`).

Все методы — только `SHOP_MANAGER`/`ADMIN`. Информация о сотрудниках
(логин, ставка, тип компенсации) чувствительна — обычный сотрудник
видит только себя через `/api/auth/me` и никаких списков других
сотрудников из этого модуля не получает.

| Метод | Путь                  | Роли      | Описание                                                     |
| ----- | --------------------- | --------- | ------------------------------------------------------------ |
| GET   | `/api/employees`      | ADMIN, SM | Список с фильтрами `active`, `role`, `compensationType`, `search` |
| GET   | `/api/employees/:id`  | ADMIN, SM | Карточка сотрудника                                          |
| PATCH | `/api/employees/:id`  | ADMIN, SM | Точечная правка management-полей (см. ниже)                  |

`POST /api/employees` (создание сотрудника) на этом шаге **нет** —
сотрудники приходят из `prisma/seed.ts`/будущей админки PIN-ов;
этот модуль занимается только окладной частью существующих карточек.

### Query `GET /api/employees`

| Параметр           | Значения                                  | По умолчанию |
| ------------------ | ----------------------------------------- | ------------ |
| `active`           | `true` / `false`                          | —            |
| `role`             | `Role` enum                               | —            |
| `compensationType` | `PIECEWORK` / `SALARY` / `MIXED`          | —            |
| `search`           | подстрока по `fullName`/`login` (case-insensitive) | —    |

Сортировка — `active DESC, fullName ASC`.

### `PATCH /api/employees/:id`

Тело — `UpdateEmployeeSchema`. Любое поле опционально, но
**хотя бы одно** обязано прийти, иначе 400 `VALIDATION_ERROR`.

```jsonc
{
  "compensationType": "SALARY",   // PIECEWORK | SALARY | MIXED
  "salaryPerShift": 3000,          // > 0 для SALARY/MIXED, null для PIECEWORK
  "active": true                   // bool
}
```

Сервисная валидация (зеркалит инвариант из `domain.md §9a` /
ADR-0021):

- `compensationType ∈ { SALARY, MIXED }` ⇒ `salaryPerShift > 0`.
  Если стейт после PATCH-а нарушает условие — `EMPLOYEE_SALARY_RATE_REQUIRED`
  (422). Проверяется **на результат**, не на тело: можно отправить
  только `salaryPerShift`, сервер прочитает текущий
  `compensationType` из БД.
- `compensationType = PIECEWORK` — допускается любой
  `salaryPerShift` (включая `null`). Это сознательно: сдельщик в
  будущем может стать `MIXED` без потери прежнего значения.
- `fullName`, `login`, `role`, `pinHash` через этот PATCH **не
  редактируются** (отсутствуют в схеме). Это управленческий блок
  «оплата и активность», а не общая CRUD-карточка.

`active = false` мягко отключает сотрудника: текущая активная смена
**не закрывается** автоматически (`ShiftSession` живёт по своим
правилам), но новые смены/начисления уже не будут создаваться —
`SalaryService.syncDailySalary` пропускает неактивных.

200 → `EmployeeDetailDto`. Ошибки: `EMPLOYEE_NOT_FOUND` (404),
`EMPLOYEE_SALARY_RATE_REQUIRED` (422), `VALIDATION_ERROR` (400),
`FORBIDDEN_ROLE` (403).

---

## 4. Заказы

> Реализовано на **Шаге 4 MVP** (модуль `apps/api/src/modules/orders`).

| Метод | Путь                        | Роли      | Описание                                           |
| ----- | --------------------------- | --------- | -------------------------------------------------- |
| GET   | `/api/orders`               | ADMIN, SM, CUTTER_ASSISTANT | Список заказов (search/status/sort + пагинация). Read-доступ помощнику закройщика — он стартует «Выпустить паспорт» с `/work` через упрощённый server-route `/work/cut-orders`, который фильтрует по `status=IN_PRODUCTION`. |
| POST  | `/api/orders`               | ADMIN, SM | Создать заказ со строками (см. тело ниже)          |
| GET   | `/api/orders/:id`           | ADMIN, SM, CUTTER_ASSISTANT | Детали заказа + `summary` + `sizeBreakdown`        |
| PATCH | `/api/orders/:id`           | ADMIN, SM | Редактировать шапку/состав строк (только `DRAFT`)  |
| POST  | `/api/orders/:id/start`     | ADMIN, SM | `DRAFT → IN_PRODUCTION`. План иммутабелен (ADR-0006) |
| POST  | `/api/orders/:id/complete`  | ADMIN, SM | Ручной перевод `IN_PRODUCTION → DONE`              |
| POST  | `/api/orders/:id/cancel`    | ADMIN, SM | Ручная отмена (из `DRAFT` или `IN_PRODUCTION`)     |

### Тело `POST /api/orders`

```json
{
  "orderDate": "2026-04-17",
  "productId": "clx...",
  "color": "Белая",
  "comment": "Срочно к выставке",
  "items": [
    { "sizeId": "clx...", "qtyPlan": 30 },
    { "sizeId": "clx...", "qtyPlan": 45 }
  ]
}
```

- `orderDate` — обязательно, ISO-дата (`YYYY-MM-DD` или ISO-datetime).
- `productId` — обязательно, должен существовать и быть `active = true`.
- `color` — опционально; если не задан, сервер берёт `Product.color`.
- `comment`, `customer`, `dueDate` — опциональны.
- `items` — минимум одна строка; `qtyPlan > 0`; размеры не повторяются.
- `routeTemplateId` — опционально. Если передан, ссылается на
  существующий **активный** шаблон маршрута (`RouteTemplate.isActive`).
  При запуске заказа (`POST /api/orders/:id/start`) шаги шаблона
  фиксируются snapshot-ом в `OrderRouteStep[]` (см. §17). Сменить
  привязку можно `PATCH /api/orders/:id` ровно до запуска и пока
  snapshot не создан; в `PATCH` поле принимает `string | null`
  (передача `null` снимает привязку).
- `techCardId` — опционально, **MVP техкарт** (см. §18 ниже и
  `docs/domain.md §19`, ADR-0022). Ссылается на активный
  `TechCardTemplate`. При `POST /api/orders/:id/start` строки
  техкарты копируются snapshot-ом в `OrderMaterialRequirement[]` и
  `OrderOutsourceRequirement[]` (`totalQty = qtyPerUnit *
  Σ OrderItem.qtyPlan`). В `PATCH` принимается `string | null`,
  правки разрешены только пока snapshot не создан (т.е. пока
  `DRAFT`).

Сервер автогенерирует `number = O-YYYYMMDD-NNNN`. Заказ создаётся в статусе
`DRAFT`.

### Query-параметры `GET /api/orders`

| Параметр   | Значения                                                     | По умолчанию      |
| ---------- | ------------------------------------------------------------ | ----------------- |
| `search`   | подстрока номера (`O-202604...`)                            | —                 |
| `status`   | `DRAFT` / `IN_PRODUCTION` / `DONE` / `CANCELLED`             | —                 |
| `sort`     | `createdAt_desc` / `createdAt_asc` / `orderDate_desc` / `orderDate_asc` | `createdAt_desc` |
| `page`     | ≥ 1                                                          | `1`               |
| `pageSize` | 1..200                                                       | `50`              |

Ответ:

```json
{
  "items": [
    {
      "id": "clx...",
      "number": "O-20260417-0001",
      "orderDate": "2026-04-17T00:00:00.000Z",
      "createdAt": "...",
      "updatedAt": "...",
      "status": "DRAFT",
      "productId": "clx...",
      "productName": "Футболка белая",
      "color": "Белая",
      "comment": null,
      "customer": null,
      "dueDate": null,
      "qtyPlanTotal": 75,
      "routeTemplateId": null,
      "routeTemplateCode": null,
      "routeTemplateName": null
    }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 50
}
```

`routeTemplateId/Code/Name` — **soft-route MVP** (см. §17 и
`docs/domain.md §18`). `null` означает «заказ создавался без
маршрута» / снапшот не фиксировался.

### Ответ `GET /api/orders/:id`

К полям из списка добавляются:

- `items: OrderItemDto[]` — строки с `sizeCode`, `qtyPlan`;
- `summary: OrderSummary` — агрегаты по всему заказу;
- `sizeBreakdown: OrderSizeBreakdownRow[]` — построчная разбивка по размерам;
- `routeSteps: OrderRouteStepDto[]` — snapshot маршрута (заполняется в
  `start()`; до запуска / без шаблона — пустой массив). Каждый
  шаг — `{ id, index, operationId, operationCode, operationName }`.
  **Сортировка строго по `index ASC`** — это контракт для UI карточки
  заказа (`/orders/[id]`, см. `docs/screens.md §7.3`), который рендерит
  read-only список шагов из этого snapshot. Источник истины — именно
  `OrderRouteStep`, а **не** живой `RouteTemplate`: после запуска
  заказа правка шаблона на карточку не влияет.
- `techCardId`, `techCardCode`, `techCardName` — `null` для заказов
  без техкарты.
- `materialRequirements: OrderMaterialRequirementDto[]` — snapshot
  потребностей материалов, отсортирован `sortOrder ASC`. Поля:
  `{ id, sortOrder, name, unit, qtyPerUnit, totalQty, note }`. До
  `start()` / без техкарты — пустой массив.
- `outsourceRequirements: OrderOutsourceRequirementDto[]` — snapshot
  внешних потребностей, отсортирован `sortOrder ASC`. Поля:
  `{ id, sortOrder, name, unit?, qtyPerUnit?, totalQty?, vendorName?,
  note? }`.

> Источник истины для блоков «Материалы» и «Внешние потребности» на
> `/orders/[id]` — именно snapshot заказа. Карточка **не** ходит за
> live-шаблоном. Правка шаблона техкарты после `start()` на старые
> заказы не влияет (см. ADR-0022, §«Edit-after-start»).

На **Шаге 4** поля факта в `summary` / `sizeBreakdown` возвращаются как
нули — будут заполняться с появлением паспортов (Шаг 5+). Структура DTO
уже полная, см. `packages/shared/src/orders.ts` и `docs/domain.md §5b`.

### Ошибки

| Код                          | HTTP | Когда                                                    |
| ---------------------------- | ---- | -------------------------------------------------------- |
| `VALIDATION_ERROR`           | 400  | Zod-валидация (тело/query)                               |
| `PRODUCT_NOT_FOUND`          | 400  | `productId` не существует                                |
| `PRODUCT_INACTIVE`           | 400  | продукт есть, но `active = false`                        |
| `SIZE_NOT_FOUND`             | 400  | один из `items[*].sizeId` не существует                  |
| `ORDER_DUPLICATE_SIZE`       | 400  | размер повторяется в одном заказе                        |
| `ORDER_HAS_NO_ITEMS`         | 400  | попытка запустить пустой заказ                           |
| `ORDER_NOT_FOUND`            | 404  | `/api/orders/:id` не найден                              |
| `ORDER_LOCKED`               | 409  | попытка редактировать заказ в `IN_PRODUCTION`            |
| `ORDER_INVALID_TRANSITION`   | 409  | недопустимый переход статуса                             |
| `ROUTE_TEMPLATE_NOT_FOUND`   | 400  | `routeTemplateId` указывает на несуществующий шаблон    |
| `ROUTE_TEMPLATE_INACTIVE`    | 400  | шаблон существует, но `isActive = false`                |
| `ORDER_ROUTE_ALREADY_STARTED` | 409 | попытка сменить `routeTemplateId` после `start()` (snapshot уже есть) |
| `TECH_CARD_NOT_FOUND`        | 400  | `techCardId` указывает на несуществующий шаблон         |
| `TECH_CARD_INACTIVE`         | 400  | шаблон техкарты существует, но `isActive = false`       |
| `ORDER_TECH_CARD_ALREADY_STARTED` | 409 | попытка сменить `techCardId` после `start()` (snapshot уже есть) |

---

## 5. Паспорта

> Реализовано на **Шаге 5 MVP** (модуль `apps/api/src/modules/passports`).
> Не входит в Шаг 5: список с фильтрами по операции/статусу,
> `POST /api/passports/by-qr`, PDF (используем HTML-печать — см.
> [ADR-0010](./adr/0010-passport-print-and-placement.md)). Эти эндпоинты
> появятся на следующих шагах.

| Метод | Путь                                | Роли             | Описание                                                    |
| ----- | ----------------------------------- | ---------------- | ----------------------------------------------------------- |
| POST  | `/api/passports`                    | CUTTER_ASSISTANT | Выпуск паспорта (см. тело ниже)                             |
| GET   | `/api/passports/:id`                | Any              | Карточка паспорта (плюс ссылки на печать и QR)              |
| GET   | `/api/passports/:id/print`          | Any              | Печатная форма (HTML, под `@page A6`/A4 и термопринтер)     |
| GET   | `/api/passports/:id/qr`             | Any              | PNG QR-кода (формат `passport:{id}` по ADR-0008)            |
| POST  | `/api/passports/:id/place`          | CUTTER_ASSISTANT | Разместить паспорт в ячейке                                 |
| POST  | `/api/passports/:id/issue`          | Сотрудник        | Шаг 6: «Получить крой» — снять с ячейки, закрепить за сотрудником |
| POST  | `/api/passports/:id/scan`           | Сотрудник        | Шаг 6: сканирование на операции (переход на `session.operationId`) |
| POST  | `/api/passports/by-code`            | Сотрудник        | Резолв паспорта по QR/номеру/id (для сканеров на `/work`)   |
| GET   | `/api/orders/:id/passports`         | ADMIN, SM, CUTTER_ASSISTANT | Список паспортов конкретного заказа (drill-down)  |
| GET   | `/api/cells`                        | Any              | Список активных ячеек со срезом содержимого по размерам     |
| GET   | `/api/cells/:id`                    | Any              | Карточка ячейки                                             |
| POST  | `/api/cells/by-code`                | Сотрудник        | Резолв ячейки по QR `cell:{id}`/`code`/id (для shelf-placement flow CUTTER_ASSISTANT) |

### Тело `POST /api/passports`

```json
{
  "orderId": "clx...",
  "sizeId": "clx...",
  "cutDate": "2026-04-17",
  "qtyCut": 12,
  "rollNumber": "R-2026-001"
}
```

- `orderId` — заказ должен быть в статусе `IN_PRODUCTION`
  (см. ADR-0010); иначе 409 `ORDER_NOT_IN_PRODUCTION`.
- `sizeId` — должен присутствовать в `OrderItem` заказа; иначе 400
  `SIZE_NOT_IN_ORDER`.
- `cutDate` — ISO-дата (`YYYY-MM-DD` или ISO-datetime).
- `qtyCut` — `> 0` (Zod), не сверх остатка плана по размеру; иначе 422
  `QTY_EXCEEDS_REMAINING_PLAN`.
- `rollNumber` — обязательная непустая строка (≤ 64 символов).

Сервер автогенерирует `number = P-YYYYMMDD-NNNN`. На паспорте
проставляется:

- `qrCode = passport:{id}` (ADR-0008);
- `cutterId` — демо-раскройщик `cutter` из seed (на этапе без auth);
- `creatorId` — `cutter-helper` из seed;
- `currentOperationId = CUT_DIVISION`;
- `qtyPlan = qtyCut`, `qtyDefect = 0`, `qtyGood = qtyCut`;
- `status = CREATED`.

В транзакции создаётся `PassportEvent(CREATED)` с `qty = qtyCut`,
`operationId = CUT_DIVISION`, `employeeId = creatorId`.

### Тело `POST /api/passports/:id/place`

```json
{ "cellId": "clx..." }       // или
{ "cellCode": "A1" }
```

В одной транзакции:

- инкрементируется срез `CellContent(cellId, sizeId).quantity += passport.qtyCut`;
- проставляется `Passport.currentCellId`;
- пишется `PassportEvent(CELL_PLACED, cellId, qty=passport.qtyCut)`.

Ошибки: 404 `PASSPORT_NOT_FOUND` / `CELL_NOT_FOUND`, 409
`PASSPORT_NOT_PLACEABLE` (статус ≠ `CREATED`), 409
`PASSPORT_ALREADY_PLACED`, 409 `CELL_INACTIVE`.

### Тело `POST /api/passports/:id/issue` (Шаг 6)

```json
{ "employeeId": "clx..." }
```

В одной транзакции:

- `CellContent(cellId, sizeId).quantity -= passport.qtyCut` (не ниже 0);
- `Passport.currentCellId = NULL`, `currentEmployeeId = :employeeId`,
  `status = IN_PROGRESS`. `currentOperationId` **не меняется**;
- пишется `PassportEvent(ISSUED_TO_EMPLOYEE, operationId=session.operationId,
  employeeId, cellId=previousCellId, qty=qtyCut)`.

Ошибки: 404 `PASSPORT_NOT_FOUND`, 409 `SHIFT_SESSION_REQUIRED`,
409 `PASSPORT_NOT_IN_CELL`, 409 `PASSPORT_ALREADY_ISSUED`,
409 `PASSPORT_ALREADY_PACKED`, 409 `PASSPORT_CANCELLED`.

### Тело `POST /api/passports/:id/scan` (Шаг 6)

```json
{ "employeeId": "clx..." }
```

В одной транзакции:

- `Passport.currentOperationId = session.operationId`,
  `currentEmployeeId = session.employeeId`, `status = IN_PROGRESS`;
- `PassportEvent(OPERATION_SCAN, operationId=session.operationId,
  fromOperationId=previous, employeeId, qty=qtyGood)`.

Идемпотентность (ADR-0003 §6): повторный скан того же паспорта той же
сменой — no-op, возвращается `200` с текущим состоянием.

Ошибки: 404 `PASSPORT_NOT_FOUND`, 409 `SHIFT_SESSION_REQUIRED`,
409 `PASSPORT_ALREADY_PACKED`, 409 `PASSPORT_CANCELLED`.

### Тело `POST /api/cells/by-code` (Шаг 13.3)

```json
{ "code": "cell:clx..." }
```

Поддерживаемые форматы `code` (по [ADR-0008](./adr/0008-qr-format.md)):

- `cell:{id}` — QR-код ячейки;
- человекочитаемый `code` (например `A-01`);
- голый `id`.

Ответ — `CellDetailDto` (тот же, что `GET /api/cells/:id`). Ошибки:
404 `CELL_NOT_FOUND` (по коду ничего не нашли), 409 `CELL_INACTIVE`
(ячейка деактивирована — не открываем session размещения, см.
`docs/flows.md §F3b`).

### Тело `POST /api/passports/by-code` (Шаг 6)

```json
{ "code": "passport:clx..." }
```

Поддерживаемые форматы `code` (см. [ADR-0008](./adr/0008-qr-format.md)):

- `passport:{id}` — QR-код паспорта;
- `P-YYYYMMDD-NNNN` — номер паспорта;
- голый `id` — на случай, когда QR уже распарсен на клиенте.

Ответ — `PassportDetailDto` (тот же, что `GET /api/passports/:id`).
Ошибка: 404 `PASSPORT_NOT_FOUND`.

Soft-route MVP (STEP 8 ТЗ, см. §17 ниже): для `by-code` backend
дополнительно подтягивает активную смену сотрудника (`@CurrentUser`)
и заполняет в ответе `routeHint.routeMismatchWithActiveShift` /
`activeShiftOperation*`. Это используется модалкой проверки паспорта
на `/work` для read-only warning. Никаких 409 за «не туда сканировал»
— hint остаётся подсказкой.

### Ответ `GET /api/passports/:id`

```json
{
  "id": "clx...",
  "number": "P-20260418-0001",
  "qrCode": "passport:clx...",
  "printUrl": "https://api.prod.teeon.ru/api/passports/clx.../print",
  "status": "CREATED",
  "cutDate": "2026-04-17T00:00:00.000Z",
  "createdAt": "...",
  "qtyCut": 12,
  "qtyPlan": 12,
  "qtyDefect": 0,
  "qtyGood": 12,
  "rollNumber": "R-2026-001",
  "color": "Белая",
  "sizeId": "clx...", "sizeCode": "128", "sizeSortOrder": 50,
  "orderId": "clx...", "orderNumber": "O-20260418-0001",
  "productId": "clx...", "productName": "Футболка белая",
  "cutterId": "clx...", "cutterName": "Демо Раскройщик",
  "creatorId": "clx...", "creatorName": "Демо Помощник раскройщика",
  "currentCell": { "id": "clx...", "code": "A1" },
  "currentRouteStepIndex": 0,
  "routeHint": {
    "currentRouteStep": {
      "index": 0,
      "operationId": "clx...",
      "operationCode": "SEW_OVERLOCK_1",
      "operationName": "Оверлок 1"
    },
    "nextRouteStep": {
      "index": 1,
      "operationId": "clx...",
      "operationCode": "QC",
      "operationName": "ОТК"
    },
    "expectedOperationId": "clx...",
    "expectedOperationName": "Оверлок 1",
    "activeShiftOperationId": null,
    "activeShiftOperationName": null,
    "routeMismatchWithActiveShift": false
  }
}
```

Поле `routeHint` (soft-route MVP, STEP 8 ТЗ — см. §17):

- `null`, если у заказа нет snapshot маршрута (`OrderRouteStep` пуст);
- `currentRouteStep` — текущий шаг (по `Passport.currentRouteStepIndex`),
  `null`, если у паспорта `currentRouteStepIndex = null` либо индекс
  вне snapshot;
- `nextRouteStep` — `step[currentRouteStepIndex + 1]` или `step[0]`,
  если `currentRouteStepIndex = null`; `null` после последнего шага;
- `expectedOperation*` — то же, что `currentRouteStep.operation`
  (единая конвенция MVP, см. `docs/screens.md §10e`);
- `activeShiftOperation*` — операция активной смены сотрудника, если
  она открыта, иначе `null`. Заполняется только теми эндпоинтами, где
  сервер знает «от чьего имени» строится hint (например,
  `POST /api/passports/by-code`); в `GET /api/passports/:id` остаётся
  `null`;
- `routeMismatchWithActiveShift` — `true` тогда и только тогда, когда
  есть и `expectedOperationId`, и `activeShiftOperationId`, и они
  отличаются. Backend никогда не использует это поле для блокировок —
  только для UI-подсказки (см. §17 «No enforcement on MVP»).

### Ответ `GET /api/orders/:id/passports`

Массив `PassportListItemDto`:

```json
[
  {
    "id": "clx...",
    "number": "P-20260418-0001",
    "status": "CREATED",
    "cutDate": "2026-04-17T00:00:00.000Z",
    "createdAt": "...",
    "qtyCut": 12, "qtyPlan": 12, "qtyDefect": 0, "qtyGood": 12,
    "rollNumber": "R-2026-001",
    "sizeId": "clx...", "sizeCode": "128", "sizeSortOrder": 50,
    "currentCell": { "id": "clx...", "code": "A1" }
  }
]
```

### Ошибки модуля паспортов

| Код                              | HTTP | Когда                                                |
| -------------------------------- | ---- | ---------------------------------------------------- |
| `VALIDATION_ERROR`               | 400  | Zod (тело)                                           |
| `ORDER_NOT_FOUND`                | 404  | Заказа `dto.orderId` нет                             |
| `ORDER_NOT_IN_PRODUCTION`        | 409  | Заказ не в статусе `IN_PRODUCTION` (ADR-0010)        |
| `SIZE_NOT_IN_ORDER`              | 400  | Размер `dto.sizeId` не входит в строки заказа        |
| `QTY_EXCEEDS_REMAINING_PLAN`     | 422  | `qtyCut > qtyPlan − Σ выпущенного`                   |
| `PASSPORT_NOT_FOUND`             | 404  | `/api/passports/:id` не найден                       |
| `PASSPORT_NOT_PLACEABLE`         | 409  | Размещать можно только в статусе `CREATED`           |
| `PASSPORT_ALREADY_PLACED`        | 409  | У паспорта уже есть `currentCellId`                  |
| `CELL_NOT_FOUND`                 | 404  | По `cellId`/`cellCode` ячейка не найдена             |
| `CELL_INACTIVE`                  | 409  | Ячейка деактивирована                                |
| `DEMO_USERS_MISSING`             | 400  | Нет демо-сотрудников `cutter`/`cutter-helper`        |
| `OPERATION_NOT_FOUND`            | 400  | В справочнике нет `CUT_DIVISION` (нужен seed)        |
| `SHIFT_SESSION_REQUIRED`         | 409  | Нет активной смены у сотрудника (Шаг 6)              |
| `PASSPORT_NOT_IN_CELL`           | 409  | Паспорт не в ячейке — нельзя «Получить крой» (Шаг 6) |
| `PASSPORT_ALREADY_ISSUED`        | 409  | Паспорт уже выдан сотруднику (Шаг 6)                 |
| `PASSPORT_ALREADY_PACKED`        | 409  | Паспорт уже упакован (Шаг 6)                         |
| `PASSPORT_CANCELLED`             | 409  | Паспорт отменён (Шаг 6)                              |
| `CUTTING_CLOSED`                 | 409  | По строке есть APPROVED `CuttingClosureRequest` — выпуск запрещён (ADR-0018, §14) |

---

## 6. Перемещения

| Метод | Путь                              | Роли          | Описание                                        |
| ----- | --------------------------------- | ------------- | ----------------------------------------------- |
| POST  | `/api/movements/scan`             | Сотрудник     | `{ passportQr }` — переместить на `session.operationId` |
| GET   | `/api/movements/preview`          | Сотрудник     | `?passportQr=...` — показать, куда поедет паспорт, без записи |

---

## 7. Ячейки

| Метод | Путь                             | Роли                        | Описание                        |
| ----- | -------------------------------- | --------------------------- | ------------------------------- |
| GET   | `/api/cells`                     | Any                         | Список ячеек                    |
| POST  | `/api/cells`                     | ADMIN                       | Создать ячейку + QR             |
| GET   | `/api/cells/:id`                 | Any                         | Содержимое (включая `warehouse: { id, name, code } \| null`, ADR-0019) |
| PATCH | `/api/cells/:id`                 | ADMIN, SM                   | Точечно обновить ячейку. На MVP — только `{ warehouseId: string \| null }` (см. §15) |
| GET   | `/api/cells/:id/qr`              | Any (public)                | PNG QR (`cell:{id}` по ADR-0008) |
| GET   | `/api/cells/:id/print`           | Any (public)                | HTML-этикетка A6 для печати: код ячейки + QR + имя склада (см. §15) |
| POST  | `/api/cells/place`               | CUTTER_ASSISTANT, SEAMSTRESS| `{ passportQr, cellQr }` → +qtyCut |
| POST  | `/api/cells/remove`              | SEAMSTRESS                  | `{ cellQr, sizeId, qty }` → −qty|

---

## 8. ОТК и фиксация брака (Шаг 7)

> Реализовано на **Шаге 7 MVP** (модуль `apps/api/src/modules/qc`).
> До появления auth `employeeId` приходит в теле опционально (берётся
> из cookie `demo-employee-id` на стороне UI). Виновная операция,
> возврат брака в производство и split паспорта на этом шаге не
> реализуются — см. `domain.md §5.3`.

| Метод | Путь                                         | Роли | Описание                                                            |
| ----- | -------------------------------------------- | ---- | ------------------------------------------------------------------- |
| GET   | `/api/defect-types`                          | QC, SM | Справочник видов брака (только активные)                          |
| GET   | `/api/qc/passports`                          | QC, SM | Список паспортов, доступных для ОТК (см. правило ниже). Используется менеджерами/админом; роли QC на `/qc` он не нужен — там scan-driven терминал. |
| GET   | `/api/qc/passports/:id`                      | QC, SM | Карточка паспорта для ОТК + история дефектов + `qcCompletedAt`/`canCompleteQc` |
| POST  | `/api/qc/passports/:id/defects`              | QC, SM | Зафиксировать запись брака                                        |
| POST  | `/api/qc/passports/:id/complete`             | QC, SM | «Проверка выполнена»: пишет `PassportEvent(QC_PASSED)`, не двигает статус |
| GET   | `/api/passports/:id/defects`                 | Any  | История зафиксированных дефектов по паспорту (для карточки паспорта)|

### Правило доступности для ОТК

Паспорт попадает в `GET /api/qc/passports`, если
`Passport.status = IN_PROGRESS`. Это значит, что выпуск/размещение
прошли и крой уже выдан швее или хотя бы один раз отсканирован на
операции (Шаг 6 переводит статус в `IN_PROGRESS`). Терминальные
`PACKED` / `CANCELLED` исключены.

Это компромиссное правило (см. `domain.md §5.3`): оно строже, чем
«просто в работе по событиям», но не требует отдельного запроса по
истории `PassportEvent` и хорошо ложится на denormalised
`Passport.status`. Альтернативный вариант «после хотя бы одного
`OPERATION_SCAN`» эквивалентен по факту, но дороже по запросам.

### Query-параметры `GET /api/qc/passports`

| Параметр   | Значения                                         | По умолчанию |
| ---------- | ------------------------------------------------ | ------------ |
| `search`   | подстрока в номере паспорта/рулона/заказа/изделия/цвете | —     |
| `orderId`  | UUID заказа                                      | —            |
| `page`     | ≥ 1                                              | `1`          |
| `pageSize` | 1..200                                           | `50`         |

### Ответ `GET /api/qc/passports`

```json
{
  "items": [
    {
      "passportId": "clx...",
      "passportNumber": "P-20260418-0001",
      "orderId": "clx...",
      "orderNumber": "O-20260418-0001",
      "productName": "Футболка белая",
      "color": "Белая",
      "sizeId": "clx...", "sizeCode": "128", "sizeSortOrder": 50,
      "qtyCut": 12, "qtyDefect": 1, "qtyGood": 11,
      "status": "IN_PROGRESS",
      "currentOperationCode": "SEW_OVERLOCK_1",
      "currentOperationName": "Оверлок 1",
      "currentEmployeeId": "clx...",
      "currentEmployeeName": "Демо Швея",
      "updatedAt": "2026-04-18T11:25:00.000Z"
    }
  ],
  "total": 4,
  "page": 1,
  "pageSize": 50
}
```

### Ответ `GET /api/qc/passports/:id`

К полям списка добавляются `qtyPlan`, `rollNumber`, `cutDate`,
`createdAt`, `defects: PassportDefectDto[]`, а также
UI-помощники:

- `canRecordDefect: boolean` — `true`, если статус `IN_PROGRESS`
  и `qtyCut − qtyDefect > 0`;
- `remainingForDefect: number` — сколько ещё штук можно отметить
  браком (`max(qtyCut − qtyDefect, 0)`);
- `qcCompletedAt: string | null` — ISO-время последнего события
  `PassportEvent(QC_PASSED)` (когда ОТК подтвердил «Проверка
  выполнена»), либо `null`, если ещё не подтверждалось;
- `canCompleteQc: boolean` — можно ли сейчас вызывать
  `POST /qc/passports/:id/complete` (правило MVP: статус
  `IN_PROGRESS`).

### Тело `POST /api/qc/passports/:id/defects`

```json
{
  "defectTypeId": "clx...",
  "qty": 2,
  "comment": "Пятно на полочке",
  "employeeId": "clx..."
}
```

- `defectTypeId` — обязателен; справочник `/api/defect-types`.
- `qty` — целое > 0; сервер дополнительно проверяет
  `qty ≤ Passport.qtyCut − Passport.qtyDefect`.
- `comment` — опционально, ≤ 500 символов.
- `employeeId` — опционально (на MVP без auth). Когда появится
  auth, поле уйдёт из тела запроса.

В одной транзакции:

- создаётся `PassportDefect`;
- инкрементируется `Passport.qtyDefect += qty`,
  `qtyGood = qtyCut − qtyDefect`;
- пишется `PassportEvent(DEFECT_RECORDED, qty,
  operationId=passport.currentOperationId, employeeId,
  payload={ defectId, defectTypeId, defectTypeCode,
  defectTypeName, comment })`.

Ответ — обновлённый `QcPassportDetailDto`.

### Тело и поведение `POST /api/qc/passports/:id/complete`

Тело пустое — актор берётся из сессии. Endpoint используется
scan-driven терминалом `/qc` (см. `docs/screens.md §5`,
`apps/web/app/qc/qc-terminal.tsx`).

Что делает (`QcService.completeQc`):

- проверяет, что паспорт существует и `status = IN_PROGRESS`
  (иначе 409 `PASSPORT_NOT_QCABLE`);
- проверяет актора (404 / 409 — `EMPLOYEE_NOT_FOUND` / `EMPLOYEE_INACTIVE`);
- пишет `PassportEvent(type=QC_PASSED, qty=qtyGood,
  operationId=passport.currentOperationId, employeeId)`;
- НЕ меняет `Passport.status`, `currentOperationId`,
  `currentEmployeeId`. Это аудит-маркер «ОТК прошло», а не движение
  по pipeline (см. `docs/flows.md §F5`).

Идемпотентность: повторное завершение разрешено и каждое
нажатие создаёт новое событие. `qcCompletedAt` в DTO всегда
соответствует последнему `QC_PASSED`-событию.

Ответ — обновлённый `QcPassportDetailDto` с актуальным
`qcCompletedAt`.

### Ответ `GET /api/passports/:id/defects`

```json
[
  {
    "id": "clx...",
    "passportId": "clx...",
    "defectTypeId": "clx...",
    "defectTypeCode": "STAIN",
    "defectTypeName": "Пятно",
    "qty": 2,
    "comment": "Пятно на полочке",
    "createdAt": "2026-04-18T11:30:00.000Z",
    "createdByEmployeeId": "clx...",
    "createdByEmployeeName": "Демо ОТК"
  }
]
```

### Ошибки модуля ОТК

| Код                          | HTTP | Когда                                                        |
| ---------------------------- | ---- | ------------------------------------------------------------ |
| `VALIDATION_ERROR`           | 400  | Zod (тело/query)                                             |
| `PASSPORT_NOT_FOUND`         | 404  | `:id` не найден                                              |
| `PASSPORT_NOT_QCABLE`        | 409  | `Passport.status ≠ IN_PROGRESS`                              |
| `DEFECT_TYPE_NOT_FOUND`      | 404  | `defectTypeId` не найден                                     |
| `DEFECT_TYPE_INACTIVE`       | 409  | Вид брака деактивирован (`isActive = false`)                 |
| `DEFECT_EXCEEDS_REMAINING`   | 422  | `qty > qtyCut − qtyDefect`                                   |
| `EMPLOYEE_NOT_FOUND`         | 404  | Передан `employeeId`, которого нет                           |
| `EMPLOYEE_INACTIVE`          | 409  | Передан `employeeId` деактивированного сотрудника            |

---

## 8a. ВТО (терминал, QC-gate)

> Реализовано в модуле `apps/api/src/modules/wto`. Бизнес-правила —
> `docs/flows.md §F6`, маппинг на экран «Цех» —
> [ADR-0013](./adr/0013-shopfloor-stage-mapping.md) §«WTO_DONE bucket».
> Полный аналог §8 для роли ВТО: одно scan-driven рабочее окно `/wto`,
> отдельный completion-эндпоинт, без списков и форм брака.
>
> Принципиальное отличие от ОТК: на входе в ВТО backend проверяет, что
> по паспорту уже есть `PassportEvent(QC_PASSED)`. Это **QC-gate** —
> он живёт в `PassportsService.scanOnOperation` и срабатывает на любом
> `POST /api/passports/:id/scan` под сменой с операцией категории
> `IRONING`, а не только на UI-уровне (`acceptOnWtoAction`).

| Метод | Путь                                          | Роли           | Описание                                                                                       |
| ----- | --------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| GET   | `/api/wto/passports/:id`                      | IRONING, SM, ADMIN | Карточка паспорта для ВТО + `qcPassedAt`/`wtoCompletedAt`/`canCompleteWto`/`removedFromWto` |
| POST  | `/api/wto/passports/:id/complete`             | IRONING, SM, ADMIN | «Завершить ВТО»: пишет `PassportEvent(WTO_PASSED)`, не двигает статус                       |

Списка `GET /api/wto/passports` **нет**: терминал `/wto` всегда
открывается через QR-скан (`POST /api/passports/:id/scan` с категорией
`IRONING` под сменой ВТО), как в ОТК-терминале — менеджеры/админ
смотрят аналитику на `/shopfloor`, а не в самой ВТО-карточке.

### Ответ `GET /api/wto/passports/:id`

К полям обычного `PassportDetailDto` добавляются:

- `qcPassedAt: string | null` — ISO-время последнего
  `PassportEvent(QC_PASSED)`. Используется для бейджа «ОТК
  подтверждено · ⟨дата⟩» на карточке ВТО.
- `wtoCompletedAt: string | null` — ISO-время последнего
  `PassportEvent(WTO_PASSED)`. `null`, если «Завершить ВТО» ещё не
  нажимали.
- `canCompleteWto: boolean` — можно ли сейчас вызывать
  `POST /api/wto/passports/:id/complete` (правило MVP: статус
  `IN_PROGRESS` и `currentOperation.category = IRONING`).
- `removedFromWto: boolean` — паспорт «уехал из ВТО»: либо терминальный
  статус (`PACKED`/`CANCELLED`), либо есть `PassportEvent(OPERATION_SCAN)`
  с `createdAt > wtoCompletedAt`. Источник истины для скрытия
  свернутой строки `WtoCompletedRow` в терминале (см.
  `apps/web/app/wto/wto-terminal.tsx`).

### Тело и поведение `POST /api/wto/passports/:id/complete`

Тело пустое — актор берётся из сессии. Используется scan-driven
терминалом `/wto`.

Что делает (`WtoService.completeWto`):

- проверяет, что паспорт существует и `status = IN_PROGRESS` (иначе
  409 `PASSPORT_NOT_WTOABLE`);
- проверяет наличие `PassportEvent(QC_PASSED)` (иначе 409
  `PASSPORT_NOT_QC_PASSED`) — double-check к gate из
  `PassportsService.scanOnOperation`;
- проверяет актора (404 / 409 — `EMPLOYEE_NOT_FOUND` / `EMPLOYEE_INACTIVE`);
- пишет `PassportEvent(type=WTO_PASSED, qty=qtyGood,
  operationId=passport.currentOperationId, employeeId)`;
- НЕ меняет `Passport.status`, `currentOperationId`,
  `currentEmployeeId`. Это аудит-маркер «ВТО прошло», а не движение
  по pipeline.

Идемпотентность: повторное завершение разрешено и каждое нажатие
создаёт новое событие. `wtoCompletedAt` в DTO всегда соответствует
последнему `WTO_PASSED`-событию. Свежий `WTO_PASSED` (новее последнего
`OPERATION_SCAN`) сразу сдвигает паспорт в derived-стадию `WTO_DONE` на
экране «Цех».

### Ошибки модуля ВТО

| Код                          | HTTP | Когда                                                        |
| ---------------------------- | ---- | ------------------------------------------------------------ |
| `VALIDATION_ERROR`           | 400  | Zod (тело/query)                                             |
| `PASSPORT_NOT_FOUND`         | 404  | `:id` не найден                                              |
| `PASSPORT_NOT_QC_PASSED`     | 409  | По паспорту нет ни одного `PassportEvent(QC_PASSED)` (вход на ВТО или completion) |
| `PASSPORT_NOT_WTOABLE`       | 409  | `Passport.status ≠ IN_PROGRESS` (для completion)             |
| `EMPLOYEE_NOT_FOUND`         | 404  | Передан `employeeId`, которого нет                           |
| `EMPLOYEE_INACTIVE`          | 409  | Передан `employeeId` деактивированного сотрудника            |

---

## 9. Упаковка (Шаг 8 MVP)

> Реализовано на **Шаге 8 MVP** (модуль `apps/api/src/modules/packing`).
> Бизнес-правила и обоснование решений — `docs/flows.md §F7` и
> [ADR-0011](./adr/0011-packing-and-release.md). Аутентификации всё ещё
> нет (ADR-0010), поэтому все мутации принимают явный `employeeId`;
> на сервере дополнительно проверяется, что у этого сотрудника
> активна смена на операции категории `PACKING`.
>
> ВТО — отдельный role-terminal со своими эндпоинтами, см. §8a.

| Метод | Путь                                       | Роли    | Описание                                                                   |
| ----- | ------------------------------------------ | ------- | -------------------------------------------------------------------------- |
| POST  | `/api/packing/boxes`                       | PACKING, SM | `{ employeeId, maxQty? }` → создать коробку (`status=OPEN`)            |
| GET   | `/api/packing/boxes?status=&page=&pageSize=` | PACKING, SM | Список коробок (фильтр `OPEN`/`CLOSED`, пагинация)                   |
| GET   | `/api/packing/boxes/:id`                   | PACKING, SM | Карточка коробки + items + summary + `labelUrl`                        |
| POST  | `/api/packing/boxes/:id/add-passport`      | PACKING, SM | `{ employeeId, passportId? \| code? }` → добавить паспорт = выпуск    |
| POST  | `/api/packing/boxes/:id/close`             | PACKING, SM | `{}` → закрыть коробку (`closedAt = now()`) **+ финальный апрув pending-начислений всем участникам цепочки** (см. ADR-0005, ADR-0011 §7) |
| GET   | `/api/packing/boxes/:id/qr`                | Any (public) | PNG QR-кода `box:{id}` (ADR-0008). `@Public()` — печатаем без сессии. |
| GET   | `/api/packing/boxes/:id/label`             | Any (public) | HTML-этикетка для печати (см. ADR-0010 — PDF за рамками MVP)         |

Создание коробки:

```http
POST /api/packing/boxes
Content-Type: application/json

{ "employeeId": "clx...", "maxQty": 100 }
```

Ответ — `BoxDetailDto` (см. ниже). Номер коробки — `B-YYYYMMDD-NNNN`,
QR — `box:{id}`. `maxQty` опционален: по умолчанию 100; на MVP можно
только уменьшать стандартную вместимость, не увеличивать.

Добавление паспорта в коробку = **выпуск изделия**. В одной транзакции:

- проверяем, что коробка открыта (`closedAt IS NULL`);
- проверяем, что паспорт жив (`status = IN_PROGRESS`, `qtyGood > 0`);
- проверяем однородность: все паспорта в коробке должны иметь
  одинаковый `productId`/`color`/`sizeId` (см. ADR-0011 §3);
- проверяем вместимость (`totalQty + qtyGood ≤ maxQty`);
- создаём `BoxItem(boxId, passportId, qty=qtyGood)`,
  инкрементируем `Box.totalQty`;
- ставим `Passport.status = PACKED`, обнуляем `currentEmployeeId` и
  `currentCellId`;
- пишем `PassportEvent(PACKED, boxId, qty=qtyGood, employeeId)`.

Идентификация паспорта при добавлении: либо `passportId`, либо `code`
(QR `passport:{id}`, номер `P-…`, или голый id). Минимум одно поле —
обязательно.

**Закрытие коробки = финальный шаг цепочки начислений.**
`POST /api/packing/boxes/:id/close` проставляет `closedAt = now()` и
**в той же транзакции** итерируется по `BoxItem[]` коробки: для
каждого `passportId` вызывается
`EarningsService.approvePendingForPassport`, который переводит все
`OperationEntry { status = PENDING_RELEASE | PENDING }` паспорта в
`APPROVED` (`approvedAt = now()`). Сами паспорта уже выпущены при
add-passport, повторно «выпускать» их не нужно.

Семантика этого решения зафиксирована в ADR-0005 §«Подтверждение» и
ADR-0011 §7 (раньше апрув жил в `add-passport`, теперь — в `close`,
чтобы scan-driven packing-терминал имел единый «final completion
event» для всей цепочки).

Идемпотентность: повторный `close` отдаёт `409 BOX_CLOSED` ещё до
апрува; сам `approvePendingForPassport` фильтрует только pending и
не плодит дубликатов / не сбрасывает `approvedAt` у уже подтверждённых
строк.

`BoxDetailDto`:

```json
{
  "id": "ckx...",
  "number": "B-20260418-0001",
  "qrCode": "box:ckx...",
  "status": "OPEN",
  "totalQty": 24,
  "maxQty": 100,
  "itemsCount": 2,
  "createdAt": "2026-04-18T08:00:00.000Z",
  "closedAt": null,
  "createdById": "...",
  "createdByName": "Упаковщик ...",
  "labelUrl": "https://api.prod.teeon.ru/api/packing/boxes/ckx.../label",
  "summary": {
    "productName": "Свитер",
    "color": "Синий",
    "sizeId": "...",
    "sizeCode": "128"
  },
  "items": [
    {
      "id": "...",
      "passportId": "...",
      "passportNumber": "P-20260418-0007",
      "productName": "Свитер",
      "color": "Синий",
      "sizeId": "...",
      "sizeCode": "128",
      "sizeSortOrder": 5,
      "qty": 12,
      "orderId": "...",
      "orderNumber": "O-20260418-0001",
      "createdAt": "2026-04-18T08:05:00.000Z"
    }
  ]
}
```

Бизнес-ошибки модуля:

| Код                          | HTTP | Когда возникает                                              |
| ---------------------------- | ---- | ------------------------------------------------------------ |
| `BOX_NOT_FOUND`              | 404  | `:id` не существует                                          |
| `BOX_CLOSED`                 | 409  | Коробка уже закрыта — `add-passport`/`close` запрещены       |
| `BOX_EMPTY`                  | 409  | Закрытие пустой коробки запрещено                            |
| `BOX_CAPACITY_EXCEEDED`      | 422  | `qtyGood` паспорта не помещается в остаток `maxQty − totalQty` |
| `BOX_HOMOGENEITY_VIOLATED`   | 409  | Паспорт другого `product/color/size`, чем содержимое коробки |
| `PASSPORT_NOT_PACKABLE`      | 409  | Статус паспорта не `IN_PROGRESS` или `qtyGood ≤ 0`           |
| `PASSPORT_ALREADY_PACKED`    | 409  | Паспорт уже в какой-то коробке (`status = PACKED`)           |
| `PASSPORT_CANCELLED`         | 409  | Паспорт отменён                                              |
| `PASSPORT_NOT_FOUND`         | 404  | Не найден ни по `passportId`, ни по `code`                   |
| `PACKING_SHIFT_REQUIRED`     | 409  | У `employeeId` нет активной смены на операции категории `PACKING` |
| `EMPLOYEE_NOT_FOUND` / `_INACTIVE` | 404 / 409 | Стандартные ошибки сотрудника                          |

---

## 10. Зарплата (Шаг 9 MVP)

> Реализовано на **Шаге 9 MVP** (модуль `apps/api/src/modules/earnings`).
> Только просмотр сдельных начислений (`OperationEntry`). Расчёт окладов,
> ведомость за месяц, удержания за брак, экспорт, интеграция с 1С/ЗУП —
> за рамками MVP. Бизнес-правила и моменты создания/подтверждения
> описаны в [ADR-0005](./adr/0005-salary-timing.md) и
> [ADR-0012](./adr/0012-earning-deduplication.md). Окладные роли (ОТК,
> помощник раскройщика, упаковщики, ВТО) сюда не попадают.

| Метод | Путь                                  | Роли                | Описание                                                     |
| ----- | ------------------------------------- | ------------------- | ------------------------------------------------------------ |
| GET   | `/api/earnings`                       | Any (с RBAC-скоупом) | Список начислений (фильтры + пагинация)                      |
| GET   | `/api/earnings/summary`               | Any (с RBAC-скоупом) | Свод (`totalApproved/totalPending`, `countApproved/countPending`) |
| GET   | `/api/passports/:id/earnings`         | Any (с RBAC-скоупом) | Начисления, привязанные к паспорту (для карточки паспорта)   |

### RBAC видимости (backend = источник истины)

`EarningsService` принудительно сужает данные на чтении в зависимости
от роли текущего пользователя из сессии (`AuthPrincipal`). Реальный
список «менеджерских» ролей живёт в одном месте —
`EARNINGS_MANAGER_ROLES` (`apps/api/src/modules/earnings/earnings.constants.ts`).

| Роль                                                         | `/api/earnings`, `/api/earnings/summary`                                                                | `/api/passports/:id/earnings`                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SHOP_MANAGER`, `ADMIN`                                      | Все начисления всех сотрудников; фильтры `employeeId`, `status`, `approvalMode`, period работают как обычно | Все строки по паспорту                                                     |
| Все остальные (`SEAMSTRESS`, `CUTTER`, `CUTTER_ASSISTANT`, `QC`, `IRONING`, `PACKING`, …) | `employeeId` принудительно = текущий сотрудник; `status` принудительно = `APPROVED`; pending не возвращается ни в списке, ни в `summary.totalPending` | Только свои `APPROVED` строки. Если их нет — `[]` (даже если у других сотрудников по этому паспорту есть `APPROVED`/`PENDING_RELEASE`) |

Любые попытки обычного сотрудника передать `employeeId` чужого
сотрудника или `status=PENDING_RELEASE` через query-string **молча
игнорируются на сервере** — это явно покрыто
`tests/integration/earnings-rbac.test.ts`. Web-клиент опирается на
это и не ставит «защиту» от неправильных query-параметров — backend
остаётся единственным источником истины.

### Query-параметры `GET /api/earnings`

| Параметр       | Значения                                            | По умолчанию |
| -------------- | --------------------------------------------------- | ------------ |
| `employeeId`   | id сотрудника                                       | —            |
| `passportId`   | id паспорта                                         | —            |
| `status`       | `PENDING_RELEASE` / `APPROVED` / `REVERSED`         | —            |
| `approvalMode` | `IMMEDIATE` / `AFTER_RELEASE`                       | —            |
| `dateFrom`     | ISO-дата (`YYYY-MM-DD` или ISO-datetime), `>= createdAt` | —       |
| `dateTo`       | ISO-дата, `<= createdAt`                            | —            |
| `page`         | ≥ 1                                                 | `1`          |
| `pageSize`     | 1..200                                              | `50`         |

Список сортируется по `createdAt DESC`.

### Ответ `GET /api/earnings`

```json
{
  "items": [
    {
      "id": "clx...",
      "passportId": "clx...",
      "passportNumber": "P-20260418-0001",
      "orderId": "clx...",
      "orderNumber": "O-20260418-0001",
      "productName": "Футболка белая",
      "color": "Белая",
      "sizeId": "clx...", "sizeCode": "128", "sizeSortOrder": 50,
      "operationId": "clx...",
      "operationCode": "CUT_CUT",
      "operationName": "Раскрой",
      "employeeId": "clx...",
      "employeeFullName": "Демо Раскройщик",
      "qty": 12,
      "ratePerUnit": 5.50,
      "amount": 66.00,
      "status": "APPROVED",
      "approvalMode": "IMMEDIATE",
      "sourceEventType": "PASSPORT_CREATED",
      "createdAt": "2026-04-18T08:01:00.000Z",
      "approvedAt": "2026-04-18T08:01:00.000Z"
    }
  ],
  "total": 17,
  "page": 1,
  "pageSize": 50
}
```

### Ответ `GET /api/earnings/summary`

```json
{
  "totalApproved": 12345.67,
  "totalPending": 890.00,
  "countApproved": 42,
  "countPending": 7
}
```

`totalApproved` суммирует `amount` всех `APPROVED`, попавших под фильтр;
`totalPending` — всех `PENDING_RELEASE`. `REVERSED` (заложен на будущее,
на MVP не выставляется) не входит ни в одну сумму.

### Ответ `GET /api/passports/:id/earnings`

Массив `EarningDto` (тех же полей, что и в списке) по конкретному
паспорту, отсортированный по `createdAt ASC` (порядок «по операциям»).

### Ошибки модуля начислений

| Код                       | HTTP | Когда                                                              |
| ------------------------- | ---- | ------------------------------------------------------------------ |
| `VALIDATION_ERROR`        | 400  | Zod (query/тело) или некорректные `dateFrom/dateTo`                |
| `PASSPORT_NOT_FOUND`      | 404  | `:id` не найден (для `/api/passports/:id/earnings`)                |
| `PIECE_RATE_NOT_FOUND`    | 422  | Нет действующей `PieceRate` для операции/размера. Возникает не на чтении, а на интеграционных вызовах (`POST /api/passports`, `POST /api/passports/:id/scan`) — ADR-0005 §«Ставка». |
| `EARNING_NOT_FOUND`       | 404  | Зарезервирован под будущий detail-lookup; на MVP не возвращается. |

> Дубль начисления для одной и той же тройки (`passportId`,
> `operationId`, `employeeId`, `sourceEventType`) гасится на уровне БД
> уникальным индексом `OperationEntry_idem` и обрабатывается сервисом
> как no-op (без `EARNING_ALREADY_EXISTS`). Это даёт идемпотентность
> повторным сканам и ретраям (см. ADR-0012).

---

## 10a. Окладные начисления (`/api/salary`, ADR-0021)

> Реализовано пост-Шагом 18 (модуль `apps/api/src/modules/salary`,
> см. [ADR-0021](./adr/0021-shift-day-salary.md), `domain.md §9a`,
> `screens.md §12.3`). Контракты — `packages/shared/src/salary.ts`
> (`SALARY_ENTRY_SOURCES`, `ListSalaryQuerySchema`,
> `SalarySummaryQuerySchema`, `UpdateSalaryEntrySchema`,
> `SalaryEntryDto`, `SalaryPage`, `SalarySummaryDto`).

| Метод | Путь                  | Роли                  | Описание                                          |
| ----- | --------------------- | --------------------- | ------------------------------------------------- |
| GET   | `/api/salary`         | Any (RBAC-скоуп)      | Список окладных записей (фильтры + пагинация)     |
| GET   | `/api/salary/summary` | Any (RBAC-скоуп)      | Свод (`total`, `totalEditedManually`, counts)     |
| PATCH | `/api/salary/:id`     | SHOP_MANAGER, ADMIN   | Ручная правка `amount`/`managerComment` или `reset` |

`POST` нет: окладные записи создаёт только
`SalaryService.syncDailySalary` из `ShiftsService.start/stop`.
Никакого «вручную создать запись за день без смены» на MVP нет —
поэтому `SalaryEntrySource.MANUAL` зарезервирован, но из API не
пишется.

### RBAC видимости (backend = источник истины)

`SalaryService` сужает данные на чтении в зависимости от роли (зеркало
`EarningsService`, см. §10). Список менеджерских ролей —
`SALARY_MANAGER_ROLES` (`apps/api/src/modules/salary/salary.constants.ts`).

| Роль                                    | `/api/salary`, `/api/salary/summary`                                   |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `SHOP_MANAGER`, `ADMIN`                 | Все начисления всех сотрудников; фильтр `employeeId` работает как обычно |
| Все остальные                           | `employeeId` принудительно = текущий сотрудник; чужие записи не возвращаются ни в списке, ни в `summary.total` |

Любые `employeeId` чужого сотрудника в query от не-менеджера **молча
игнорируются на сервере** (`applyViewerScope`) — это покрыто
`tests/integration/salary.test.ts`.

### Query-параметры `GET /api/salary`

| Параметр       | Значения                              | По умолчанию |
| -------------- | ------------------------------------- | ------------ |
| `employeeId`   | id сотрудника (только менеджер)        | —            |
| `dateFrom`     | ISO-дата `YYYY-MM-DD`, `>= date`       | —            |
| `dateTo`       | ISO-дата `YYYY-MM-DD`, `<= date`       | —            |
| `page`         | ≥ 1                                   | `1`          |
| `pageSize`     | 1..200                                | `50`         |

Сортировка — `date DESC, createdAt DESC`.

### Ответ `GET /api/salary`

```json
{
  "items": [
    {
      "id": "clx...",
      "employeeId": "clx...",
      "employeeFullName": "Демо ОТК",
      "date": "2026-04-19",
      "amount": 3000.00,
      "source": "SHIFT_DAY",
      "editedManually": false,
      "managerComment": null,
      "editedByEmployeeId": null,
      "editedByFullName": null,
      "createdAt": "2026-04-19T07:01:00.000Z",
      "updatedAt": "2026-04-19T07:01:00.000Z"
    }
  ],
  "total": 17,
  "page": 1,
  "pageSize": 50
}
```

### Ответ `GET /api/salary/summary`

```json
{
  "total": 45000.00,
  "totalEditedManually": 1500.00,
  "count": 15,
  "countEditedManually": 1
}
```

`total` суммирует `amount` всех записей под фильтр; `totalEditedManually`
— подмножество с `editedManually = true` (полезно показать
«сколько в этом месяце ушло на ручные корректировки»).

### `PATCH /api/salary/:id`

Тело — `UpdateSalaryEntrySchema`. Хотя бы одно из `amount`,
`managerComment`, `reset` должно прийти, иначе 400.

```jsonc
{
  "amount": 1500,                      // ≥ 0, до Decimal(12,2)
  "managerComment": "ушёл раньше",     // null = очистить, ≤ 500 символов
  "reset": false                        // true = вернуть под автоматику
}
```

Семантика:

- Обычный PATCH (`reset` отсутствует или `false`):
  `editedManually = true`, `editedByEmployeeId = viewer.employeeId`,
  переданные поля обновляются, остальные не трогаются.
- `reset = true`: снять флаг, вернуть запись под `syncDailySalary`,
  выставить `amount = employee.salaryPerShift`, очистить
  `managerComment` и `editedByEmployeeId`. Если ставка не задана —
  `SALARY_RATE_MISSING` (422).

`employeeId`, `date`, `source` через PATCH **не редактируются** —
их физически нет в `UpdateSalaryEntrySchema`, чтобы ручная правка
не могла перенести оплату на чужой день/чужого человека и сломать
инвариант «один день — одна запись».

200 → `SalaryEntryDto`. Ошибки: `SALARY_ENTRY_NOT_FOUND` (404),
`SALARY_RATE_MISSING` (422), `VALIDATION_ERROR` (400),
`FORBIDDEN_ROLE` (403).

> Параллельные `start shift` (две вкладки/ретрай транзакции) встают
> на уникальном `(employeeId, date, source)` и `P2002` ловится в
> `SalaryService.syncDailySalary` как no-op. Никакой бизнес-ошибки
> наружу не уходит — это часть идемпотентности sync-логики.

---

## 11. Дашборды

| Метод | Путь                                  | Роли                   | Описание                              |
| ----- | ------------------------------------- | ---------------------- | ------------------------------------- |
| GET   | `/api/dashboard/sizes`                | SHOP_MANAGER, ADMIN    | Агрегаты по размерам                  |
| GET   | `/api/dashboard/plan-fact?orderId=`   | SHOP_MANAGER, ADMIN    | План/факт по заказу                   |
| GET   | `/api/shopfloor/state`                | Any                    | Матрица `size × stage → qty` для экрана «Цех» (Шаг 10) |
| GET   | `/api/shopfloor/orders`               | Any                    | Активные заказы для селекта на `/shopfloor` (Шаг 10)   |
| GET   | `/api/shopfloor/equipment`            | Any                    | Статусы оборудования (`ONLINE/WARNING/OFFLINE`) для production board |
| GET   | `/api/shopfloor/display`              | Any                    | Единый агрегат для большого монитора `/shopfloor/display` (Шаг 10b) |

> На MVP `/api/dashboard/*` ещё не реализован — это плановые маршруты
> для будущих шагов. Реализовано: `/api/shopfloor/*` (Шаг 10 + 10b).

### `GET /api/shopfloor/state` — экран «Цех» (Шаг 10 MVP)

Источник данных — `ShopfloorService` (`apps/api/src/modules/shopfloor`).
Никаких новых таблиц / событий / снапшотов: проекция `size × stage`
считается на лету из `Passport`, `Operation.category` и `BoxItem.box.closedAt`.
Правила маппинга — [ADR-0013](./adr/0013-shopfloor-stage-mapping.md).

**Query params:**

| Параметр | Тип    | Описание                                                                |
|----------|--------|-------------------------------------------------------------------------|
| orderId  | string | Опциональный. Если задан — срез по одному заказу; иначе — все активные. |

**Активный заказ** = `status NOT IN (DONE, CANCELLED)` (т. е. `DRAFT`
или `IN_PRODUCTION`). Документировано как «scope = ALL_ACTIVE».

**Stage buckets:** `CUT · SEWING · QC · QC_DONE · WTO · PACKING · FINISHED`
плюс отдельная колонка `qtyDefect` (не stage). Подробное правило —
ADR-0013 §«Решение». Колонка `PACKING` на MVP — аппроксимация по
открытым коробкам (см. ADR-0013 §«Аппроксимация колонки PACKING»).
Колонка `QC_DONE` («Проверено ОТК») — производный бакет от
`PassportEvent(QC_PASSED)`; перекрывает `QC` для того же паспорта,
не двигая `Passport.status` (см. ADR-0013 §«QC_DONE bucket»).

**Ответ (`ShopfloorStateDto`):**

```json
{
  "updatedAt": "2026-04-18T12:00:00.000Z",
  "scope": "ALL_ACTIVE",
  "orderId": null,
  "scopeLabel": "Все активные заказы (3)",
  "summary": {
    "qtyCut": 120,
    "qtySewing": 64,
    "qtyQc": 12,
    "qtyQcDone": 4,
    "qtyWto": 10,
    "qtyPacking": 5,
    "qtyFinished": 300,
    "qtyDefect": 7
  },
  "rows": [
    {
      "sizeId": "clx128",
      "sizeCode": "128",
      "sizeSortOrder": 50,
      "qtyCut": 120,
      "qtySewing": 64,
      "qtyQc": 12,
      "qtyQcDone": 4,
      "qtyWto": 10,
      "qtyPacking": 5,
      "qtyFinished": 300,
      "qtyDefect": 4
    }
  ]
}
```

Правила вывода строк:

- **scope = ALL_ACTIVE** — `rows` содержит только размеры, по которым
  есть хотя бы один не нулевой показатель (чтобы доска не была
  загромождена пустыми строками из всего справочника).
- **scope = ORDER** — `rows` всегда содержит все размеры из
  `OrderItem` заказа (даже если по ним пока 0), плюс размеры,
  встретившиеся в паспортах заказа.

`updatedAt` — момент формирования ответа на сервере; UI показывает
его в строке статуса polling-а (см. [ADR-0007](./adr/0007-polling-for-realtime.md)).

### `GET /api/shopfloor/orders` — селект заказов на `/shopfloor`

Возвращает массив `ShopfloorOrderOptionDto[]` для выпадающего списка
«Заказ» в шапке экрана. Содержит только активные (`DRAFT` /
`IN_PRODUCTION`).

```json
[
  {
    "id": "clx123",
    "number": "ORD-20260418-0007",
    "status": "IN_PRODUCTION",
    "productName": "Футболка детская",
    "color": "белый",
    "qtyPlanTotal": 600,
    "createdAt": "2026-04-15T08:00:00.000Z"
  }
]
```

### `GET /api/shopfloor/display` — большой монитор `/shopfloor/display` (Шаг 10b)

Единый read-only агрегат под light-theme dashboard в цеху (см.
`screens.md §9a`). Делает работу четырёх запросов сразу: KPI-блок,
матрицу `цвет × размер × stage` и статусы оборудования с
категорией для иконки. Введён, чтобы:

- большой монитор слал один polling-запрос вместо четырёх;
- агрегация по цветам считалась на backend, а не в браузере планшета;
- KPI и матрица всегда были одного «снимка» (нет рассинхрона между
  отдельными endpoint-ами).

Доступен любой авторизованной роли (включая `DISPLAY`). Никаких
мутаций — только проекция живых данных. Менеджерский `/shopfloor`
по-прежнему ходит за `/api/shopfloor/state` и `/api/shopfloor/orders`.

**Latency / структура запросов.** `getDisplaySummary` намеренно
склеен из нескольких независимых Prisma-запросов и гонит их
параллельно (`Promise.all`), чтобы один polling-tick укладывался
в `FETCH_TIMEOUT_MS = 6 c` фронта даже при средней нагрузке на
БД:

1. `[passports, sizes]` — первая параллельная пара (нужны для
   проекции матрицы);
2. затем одним `Promise.all` —
   `[eventMaxes, packedToday, listEquipmentStatus()]`:
   - `eventMaxes` — derived QC_DONE/WTO_DONE для матрицы;
   - `packedToday` — KPI «Выпущено сегодня» (Σ `qtyGood` по
     `PassportEvent(PACKED)` за UTC-сегодня);
   - `listEquipmentStatus()` — плитки оборудования (внутри тоже
     параллелизован: `[equipment, activeShifts]` гоняются вместе,
     и только следом — `groupBy(OPERATION_SCAN)` по сотрудникам с
     открытой сменой).

Никакого backend-кэша или TTL у display-summary нет: запросы лёгкие
и параллельны, а маленький TTL ради «почти realtime» только
запутал бы оператора (см. ADR-0007). Контракт ответа (`ShopfloorDisplayDto`)
от этого не меняется.

**Ответ (`ShopfloorDisplayDto`):**

```json
{
  "updatedAt": "2026-04-21T19:00:00.000Z",
  "kpi": {
    "producedToday": 120,
    "inWork": 84,
    "waiting": 40,
    "qc": 16,
    "wto": 10,
    "packing": 5,
    "finished": 300,
    "defect": 7
  },
  "sewingColumns": [
    { "key": "clxop_overlock1", "label": "Оверлок 1", "sortOrder": 80 },
    { "key": "clxop_overlock2", "label": "Оверлок 2", "sortOrder": 100 }
  ],
  "colors": [
    {
      "colorKey": "black",
      "colorLabel": "Чёрный",
      "rows": [
        {
          "sizeId": "clx128",
          "sizeCode": "128",
          "sizeSortOrder": 50,
          "qtyCut": 10,
          "qtySewing": 4,
          "qtyQc": 2,
          "qtyQcDone": 1,
          "qtyWto": 0,
          "qtyWtoDone": 0,
          "qtyPacking": 0,
          "qtyFinished": 30,
          "qtyDefect": 1,
          "sewingByOp": { "clxop_overlock1": 3, "clxop_overlock2": 1 }
        }
      ],
      "totals": { "qtyCut": 10, "qtySewing": 4, "qtyQc": 2, "qtyQcDone": 1, "qtyWto": 0, "qtyWtoDone": 0, "qtyPacking": 0, "qtyFinished": 30, "qtyDefect": 1, "sewingByOp": { "clxop_overlock1": 3, "clxop_overlock2": 1 } }
    },
    { "colorKey": "white", "colorLabel": "Белый", "rows": [], "totals": { "qtyCut": 0, "qtySewing": 0, "qtyQc": 0, "qtyQcDone": 0, "qtyWto": 0, "qtyWtoDone": 0, "qtyPacking": 0, "qtyFinished": 0, "qtyDefect": 0, "sewingByOp": {} } }
  ],
  "totals": { "qtyCut": 40, "qtySewing": 32, "qtyQc": 12, "qtyQcDone": 4, "qtyWto": 10, "qtyWtoDone": 0, "qtyPacking": 5, "qtyFinished": 300, "qtyDefect": 7, "sewingByOp": { "clxop_overlock1": 20, "clxop_overlock2": 12 } },
  "equipment": [
    {
      "id": "clxeq1",
      "code": "overlock-03",
      "name": "Оверлок 03",
      "displayNumber": "3",
      "active": true,
      "status": "ONLINE",
      "kind": "SEWING",
      "employeeName": "Иванова И. И.",
      "operationName": "Оверлок 1",
      "shiftStartedAt": "2026-04-21T05:00:00.000Z",
      "lastActivityAt": "2026-04-21T18:55:00.000Z"
    }
  ]
}
```

**KPI правила:**

- `producedToday` — Σ `Passport.qtyGood` по `PassportEvent(PACKED)`
  за UTC-сегодня (`createdAt >= startOfDay`).
- `inWork` = `qtySewing + qtyQc + qtyQcDone + qtyWto + qtyWtoDone + qtyPacking`
  (всё «живое» внутри pipeline без `CUT` и `FINISHED`).
- `waiting` = `qtyCut` (готовый крой ждёт швею).
- `qc`, `wto`, `packing`, `finished`, `defect` — алиасы из `totals`.

**Матрица `colors[]`:**

- группировка по нормализованному цвету (`Чёрный`/`чёрный`/`black`
  → `colorKey: "black"`, label `Чёрный`; то же для белого);
- сначала канонические `black`/`white` в фиксированном порядке,
  затем остальные по алфавиту;
- пустой `Passport.color` попадает в служебный блок «Без цвета»
  (`colorKey: "__unknown__"`);
- внутри каждого `colors[].rows` — только размеры с ненулевыми
  показателями, отсортированы по `sizeSortOrder`;
- бакеты (`qtyCut/qtySewing/qtyQc/qtyQcDone/qtyWto/qtyWtoDone/qtyPacking/qtyFinished`)
  считаются ровно по тем же правилам, что в `/shopfloor/state` —
  цифры между «менеджерским» и «дисплейным» экранами должны сходиться.

**Динамическая разбивка пошива (`sewingColumns` + `sewingByOp`):**

Колонка «Пошив» на дисплее не суммарная: её состав определяется в
рантайме и привязан к доменной модели `Operation` (категория
`SEWING`).

- `sewingColumns: ShopfloorDisplaySewingColumnDto[]` — упорядоченный
  список фактических sewing-операций, по которым прямо сейчас есть
  ненулевая Σ продукции; каждая — `{ key, label, sortOrder }`.
  - `key` — стабильный идентификатор (для обычных операций =
    `Operation.id`; для passport'ов в SEWING-бакете без явной
    SEWING-операции — служебный `__pending__`);
  - `label` = `Operation.name` (или «Ожидает» для `__pending__`),
    UI берёт его «как есть» — никаких хардкодов «Оверлок/Киперка»;
  - `sortOrder` = `Operation.sortOrder` (`__pending__` всегда уезжает
    в конец через `Number.MAX_SAFE_INTEGER`).
  - порядок: сначала по `sortOrder`, при равенстве — по `label`,
    при равенстве — по `key`. Стабилен между опросами.
- Если `Σ` по операции в текущем снимке = 0 (по всем строкам, цветам
  и итогу) — она НЕ попадает ни в `sewingColumns`, ни в
  `sewingByOp` ни одной строки/цвета/итога.
- Если SEWING-продукции вообще нет, `sewingColumns: []`, в `rows`/
  `colors[].totals`/`totals` будет `sewingByOp: {}`. UI просто не
  рисует sewing-колонок, остальные стадии не сдвигаются.
- `colors[].rows[i].sewingByOp[key]` и `colors[].totals.sewingByOp[key]`
  и `totals.sewingByOp[key]` дают разбивку штук по той же `key`,
  что в `sewingColumns`. Если ключа нет → 0 (UI читает через safe
  helper, отсутствие записи = 0).
- Совместимость: `qtySewing` сохранён и равен `Σ sewingByOp.values()`
  (на всех уровнях — row, color total, grand total). Это держит KPI
  «В работе» (`inWork`) и любых старых консьюмеров, которые читали
  только агрегат, без изменений.

Источник правды для названия и сортировки — `Operation` (поля `id`,
`name`, `sortOrder`, `category`); фронтенд НЕ нормализует названия
и НЕ строит sewing-колонки самостоятельно.

**`equipment[].kind`:** `CUTTING | SEWING | QC | IRONING | PACKING | OTHER`
(см. `ShopfloorEquipmentKind`). Выводится backend'ом из
`OperationCategory` разрешённых на станке операций; приоритет —
`SEWING > CUTTING > IRONING > QC > PACKING`. UI использует это
поле только для выбора иконки в плитке.

### `GET /api/shopfloor/equipment` — статусы оборудования (Production Board)

Возвращает массив `ShopfloorEquipmentStatusDto[]`. Те же `kind` и
правила вывода статуса, что у `/api/shopfloor/display.equipment`.
Отдельный endpoint оставлен для UI, которому нужны только статусы
без KPI/матрицы.

### Ошибки модуля «Цех»

| Код               | HTTP | Когда                                  |
|-------------------|------|----------------------------------------|
| `ORDER_NOT_FOUND` | 404  | `?orderId=` указывает на несуществующий заказ |
| `VALIDATION_ERROR`| 400  | Невалидный `orderId` (пустая строка)   |

---

## 11a. Admin / monitoring (Шаг 12 — Pilot Rollout)

Лёгкий операционный обзор для начальника цеха. Без аналитики, без
графиков, без поллинга. UI — `/admin/overview` (см. `screens.md §10`).
Контракт типов — `@sewing/shared/admin`.

| Метод | Путь                  | Роли                  | Описание                                    |
| ----- | --------------------- | --------------------- | ------------------------------------------- |
| GET   | `/api/admin/overview` | `SHOP_MANAGER, ADMIN` | Снимок «что прямо сейчас в цехе» (см. ниже) |

Ответ — `AdminOverviewDto`:

```json
{
  "updatedAt": "2026-04-18T09:30:01.234Z",
  "counters": {
    "activeShifts": 3,
    "openBoxes": 1,
    "passportsInProgress": 5,
    "passportsInCells": 2,
    "passportsCreatedToday": 7,
    "eventsLast24h": 84
  },
  "shifts":   [ { "shiftId": "...", "employeeName": "Иванова А. С.",
                  "operationCode": "SEW_OVERLOCK_1", "equipmentCode": "overlock-01",
                  "startedAt": "..." } ],
  "openBoxes": [ { "boxId": "...", "number": "B-20260418-0003",
                   "totalQty": 12, "maxQty": 100, "itemsCount": 4,
                   "productName": "Футболка детская", "color": "белый",
                   "sizeCode": "104", "createdAt": "..." } ],
  "passports": [ { "passportId": "...", "number": "P-20260418-0001",
                   "status": "IN_PROGRESS", "qtyCut": 20, "qtyGood": 19,
                   "productName": "Футболка детская", "color": "белый",
                   "sizeCode": "104", "location": "EMPLOYEE",
                   "currentEmployeeName": "Иванова А. С.",
                   "currentCellCode": null,
                   "currentOperationCode": "SEW_OVERLOCK_1",
                   "currentOperationName": "Оверлок 1",
                   "updatedAt": "..." } ]
}
```

Жёсткие лимиты: `shifts ≤ 50`, `openBoxes ≤ 50`, `passports ≤ 100`.
На пилоте больше быть не должно (см. `docs/pilot/rollout-plan.md §2`).

Зачем не SSE/poll: задача — мониторинг, а не живая доска. Начальник
цеха обновляет страницу осознанно (или это делает скрипт раз в
минуту). Для realtime-доски остаётся `/api/shopfloor/state` со своим
поллингом 3с.

### Ошибки модуля Admin

| Код               | HTTP | Когда                              |
|-------------------|------|------------------------------------|
| `UNAUTHENTICATED` | 401  | Нет/невалидная session-cookie       |
| `FORBIDDEN_ROLE`  | 403  | Роль не SHOP_MANAGER/ADMIN          |

---

## 11b. Дашборд начальника производства (`/api/dashboard/production`)

Единый управленческий ответ для экрана `/admin/production-dashboard`
(см. `screens.md §18`). UI ничего не пересчитывает — backend агрегирует
KPI, pipeline, ряд графика, нагрузку по ролям и алерты в одном
запросе. Ни новых таблиц, ни новых событий: данные собираются из уже
существующих `Passport` / `PassportEvent` / `Order` / `OperationEntry`
/ `SalaryEntry`, плюс переиспользуются `CostsService` / shopfloor
projection (см. `domain.md §17`).

| Метод | Путь                          | Роли                  | Описание                                                                |
| ----- | ----------------------------- | --------------------- | ----------------------------------------------------------------------- |
| GET   | `/api/dashboard/production`   | `SHOP_MANAGER, ADMIN` | KPI + pipeline + trend + roleLoad + alerts (один ответ для дашборда)    |

**Query params:**

| Параметр | Тип    | Допустимо | По умолчанию | Описание                                                                                                  |
| -------- | ------ | --------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `days`   | number | `7\|14\|30` | `7`          | Длина периода для `trend`, `kpi.totalCostPeriod`, `kpi.idleCostPeriod`, `kpi.producedPeriod`. Включает сегодня. |

«Сегодня»-метрики KPI (`producedToday`, `avgCostPerUnitToday`,
`idleCostToday`, `utilizationToday`) считаются по UTC-сегодня
независимо от `days` — это часть управленческого контракта, чтобы UI
не перемешивал «сегодня» и «период».

**Ответ — `ProductionDashboardDto`:**

```json
{
  "generatedAt": "2026-04-20T12:00:00.000Z",
  "today": "2026-04-20",
  "periodDays": 7,
  "dateFrom": "2026-04-14",
  "dateTo": "2026-04-20",
  "kpi": {
    "producedToday": 24,
    "producedPeriod": 187,
    "wipUnits": 312,
    "wipPassports": 41,
    "ordersInProduction": 7,
    "avgCostPerUnitToday": 32.10,
    "idleCostToday": 412.00,
    "utilizationToday": 73,
    "idleCostPeriod": 2860.50,
    "totalCostPeriod": 9210.40
  },
  "pipeline": {
    "stages": [
      { "stage": "CUT",      "qty": 80,  "passports": 6  },
      { "stage": "SEWING",   "qty": 120, "passports": 9  },
      { "stage": "QC",       "qty": 40,  "passports": 4  },
      { "stage": "QC_DONE",  "qty": 12,  "passports": 1  },
      { "stage": "WTO",      "qty": 30,  "passports": 3  },
      { "stage": "WTO_DONE", "qty": 10,  "passports": 1  },
      { "stage": "PACKING",  "qty": 20,  "passports": 2  },
      { "stage": "FINISHED", "qty": 187, "passports": 14 }
    ],
    "defectQty": 5,
    "bottleneckStage": "SEWING",
    "bottleneckQty": 120
  },
  "trend": [
    { "date": "2026-04-14", "producedUnits": 28, "totalCost": 1320.00, "idleCost": 410.00 }
    /* ... остальные дни в периоде ... */
  ],
  "roleLoad": [
    { "role": "QC",      "employees": 1, "paidMinutes": 480, "trackedMinutes": 320, "idleMinutes": 160, "idleCost": 160.00, "utilization": 67 },
    { "role": "IRONING", "employees": 1, "paidMinutes": 480, "trackedMinutes": 410, "idleMinutes":  70, "idleCost":  70.00, "utilization": 85 },
    { "role": "PACKING", "employees": 1, "paidMinutes": 480, "trackedMinutes": 290, "idleMinutes": 190, "idleCost": 190.00, "utilization": 60 }
  ],
  "alerts": [
    { "type": "PIPELINE_BOTTLENECK", "severity": "WARN", "message": "Самая длинная очередь: Пошив", "value": 120, "unit": "шт",   "href": "/shopfloor" },
    { "type": "ROLE_IDLE",           "severity": "INFO", "message": "Простой по роли «Упаковка»", "value": 190,  "unit": "₽" },
    { "type": "EMPLOYEE_IDLE",       "severity": "INFO", "message": "Иванова А. С.: неучтённое время за день", "value": 220, "unit": "мин" },
    { "type": "PEAK_IDLE_DAY",       "severity": "INFO", "message": "Самый дорогой простой за период: 18.04", "value": 480, "unit": "₽", "href": "/production-cost" },
    { "type": "CAPPED_PASSPORTS",    "severity": "INFO", "message": "Аномальные паспорта по времени стадии (cap 60 мин)", "value": 2, "unit": "шт" }
  ]
}
```

**Что считается на каких данных:**

- `kpi.producedToday` / `producedPeriod` — `Σ Passport.qtyGood` по
  `PassportEvent(PACKED)` за UTC-сегодня / период.
- `kpi.wipUnits` / `wipPassports` — `Passport.status ∈ {CREATED, IN_PROGRESS}`
  (то же окно, что у `/shopfloor`).
- `kpi.ordersInProduction` — `Order.status = IN_PRODUCTION`.
- `kpi.avgCostPerUnitToday` — `totalCost / producedUnits` за сегодня
  (см. `/api/costs/production`, §17). 0, если выпуска не было.
- `kpi.idleCostToday` / `idleCostPeriod` — `idleCost` из
  `/api/costs/production` за сегодня / период.
- `kpi.utilizationToday` — `Σ trackedMinutes / Σ paidMinutes × 100` по
  окладным ролям (`QC` / `IRONING` / `PACKING`) за UTC-сегодня.
- `pipeline.*` — те же правила, что у `/api/shopfloor/state`
  (см. ADR-0013 + `domain.md §17`); `bottleneckStage` = стадия с
  максимальным `qty` среди живых (`FINISHED` в bottleneck не идёт).
- `trend[]` — подмассив `ProductionCostDayDto` (`producedUnits`,
  `totalCost`, `idleCost`) за `[dateFrom..dateTo]`, всегда полный
  диапазон (пустые дни тоже).
- `roleLoad[].*` — день «to» периода, по `Employee.role` ∈
  `{QC, IRONING, PACKING}`. `paidMinutes = employees × SHIFT_MINUTES`;
  `trackedMinutes` = Σ длительностей стадий (cap 60 мин на паспорт);
  `idleMinutes = max(0, paid − tracked)`; `idleCost` начисляется только
  окладным (`SALARY`/`MIXED`).
- `alerts[]` — top-items проблемных зон (см. ниже). Если значимых
  отклонений нет — массив пустой.

**Типы алертов (`ProductionDashboardAlertType`):**

| `type`                | Когда срабатывает                                                                  | Severity                                            |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `PIPELINE_BOTTLENECK` | `pipeline.bottleneckQty > 0`                                                       | `WARN` если ≥ 50, иначе `INFO`                      |
| `ROLE_IDLE`           | максимум `idleCost` среди ролей > 0                                                | `WARN` если ≥ 1000 ₽, иначе `INFO`                  |
| `EMPLOYEE_IDLE`       | окладной сотрудник на смене (`SalaryEntry`) с самым большим `idleMinutes` за день  | `WARN` если ≥ 240 мин, иначе `INFO`                 |
| `PEAK_IDLE_DAY`       | день периода с самым дорогим простоем                                              | `INFO`                                              |
| `CAPPED_PASSPORTS`    | в периоде есть паспорта, чья стадия была cap-нута `MAX_STAGE_MINUTES_PER_PASSPORT` | `WARN` если ≥ 5, иначе `INFO`                       |

### Ошибки модуля Dashboard

| Код                | HTTP | Когда                                  |
| ------------------ | ---- | -------------------------------------- |
| `UNAUTHENTICATED`  | 401  | Нет/невалидная session-cookie          |
| `FORBIDDEN_ROLE`   | 403  | Роль не `SHOP_MANAGER` / `ADMIN`       |
| `VALIDATION_ERROR` | 400  | `days` не из набора `{7, 14, 30}`      |

---

## 14. Закрытие раскроя по размеру (CuttingClosureRequest, ADR-0018)

Управленческая цепочка «помощник раскройщика подаёт заявку — мастер
цеха подтверждает / отклоняет». Доменная модель и инварианты — см.
`domain.md §15`, `erd.md §2.8a`. Backend = источник истины: после
`APPROVED` `POST /api/passports` режется бизнес-ошибкой
`CUTTING_CLOSED` (см. §5).

| Метод | Путь                                                | Роли                                                  | Описание                                                  |
| ----- | --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| POST  | `/api/cutting-close-requests`                       | `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`           | Подать заявку на закрытие раскроя по строке                |
| GET   | `/api/cutting-close-requests`                       | `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`           | Список с фильтрами `?status=...&orderId=...&productId=...&sizeId=...` |
| GET   | `/api/cutting-close-requests/:id`                   | `CUTTER_ASSISTANT`, `SHOP_MANAGER`, `ADMIN`           | Детали заявки                                              |
| POST  | `/api/cutting-close-requests/:id/approve`           | `SHOP_MANAGER`, `ADMIN`                               | Подтвердить → `APPROVED`                                   |
| POST  | `/api/cutting-close-requests/:id/reject`            | `SHOP_MANAGER`, `ADMIN`                               | Отклонить → `REJECTED`                                     |
| GET   | `/api/passports/:id/cutting-closure-request`        | Все авторизованные роли (как и сама карточка паспорта) | «Текущая» заявка для строки этого паспорта или `null`     |

`employeeId` подающего/рассматривающего берётся из сессии (см. §12).

### Тело `POST /api/cutting-close-requests`

```json
{
  "orderId":   "ord_...",
  "productId": "prd_...",
  "sizeId":    "sz_...",
  "reason":    "Ткани больше нет"   // optional, ≤ 280 символов
}
```

### Тело `POST /api/cutting-close-requests/:id/approve|reject`

```json
{
  "note": "Подтверждаю, ткани больше не будет"  // optional, ≤ 280 символов
}
```

### Ответ заявки (DTO)

```json
{
  "id": "ccr_...",
  "orderId": "ord_...",
  "orderNumber": "Z-2026-0001",
  "productId": "prd_...",
  "productName": "Футболка",
  "sizeId": "sz_M",
  "sizeCode": "M",
  "status": "REQUESTED",
  "reason": "Ткани больше нет",
  "reviewerNote": null,
  "requestedByEmployeeId": "emp_...",
  "requestedByEmployeeName": "Иванов И.И.",
  "requestedAt": "2026-04-18T16:39:32.000Z",
  "reviewedByEmployeeId": null,
  "reviewedByEmployeeName": null,
  "reviewedAt": null,
  "planFact": {
    "qtyPlan": 10,
    "qtyCut": 7,
    "qtyRemaining": 3
  }
}
```

`planFact` считается тем же способом, что и `OrderSizeBreakdownRow`:
`qtyCut = Σ Passport.qtyCut` по живым (не `CANCELLED`) паспортам той же
строки. Это нужно UI (`/passports/[id]`, `/orders/[id]`) и одновременно
снимает «магию» с шаблонов.

`GET /api/passports/:id/cutting-closure-request` возвращает «текущую»
заявку с приоритетом `APPROVED → REQUESTED → последняя REJECTED`,
либо `null`, если заявок по строке нет.

### Combined-flow «выпуск паспорта + заявка» (web-only)

Помощник раскройщика на форме выпуска паспорта
(`/orders/:id/passports/new`, см. `docs/screens.md §7.5`) может
поставить чекбокс «Подать заявку на закрытие раскроя». Server action
`createPassportAction` оркестрирует два API-вызова:

1. `POST /api/passports` — обычный выпуск.
2. Если чекбокс включён и шаг 1 прошёл успешно —
   `POST /api/cutting-close-requests` с
   `{ orderId, productId, sizeId, reason? }`.

Шаги выполняются последовательно, не атомарно: backend оба вызова
обрабатывает независимо. Если шаг 2 падает (`CUTTING_CLOSURE_*` /
сетевой), паспорт остаётся в БД, и UI отдаёт mixed-result со ссылкой
на карточку паспорта. Это намеренно — `Passport` уже подписан
`PassportEvent(CREATED)` и начислением раскройщику, откат запрещён
ADR-0006 / ADR-0005. Новых backend-эндпоинтов и кодов ошибок этот
flow не вводит.

### Ошибки модуля «Закрытие раскроя»

| Код                                       | HTTP | Когда                                                              |
| ----------------------------------------- | ---- | ------------------------------------------------------------------ |
| `VALIDATION_ERROR`                        | 400  | Zod (тело/параметры)                                                |
| `CUTTING_CLOSURE_SIZE_NOT_IN_ORDER`       | 400  | Тройки `(orderId, productId, sizeId)` нет в заказе                  |
| `CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION` | 409  | Заказ не в `IN_PRODUCTION`                                          |
| `CUTTING_CLOSURE_ALREADY_REQUESTED`       | 409  | По строке уже есть `REQUESTED`-заявка (partial unique index)        |
| `CUTTING_CLOSURE_ALREADY_APPROVED`        | 409  | По строке уже есть `APPROVED`-заявка                                |
| `CUTTING_CLOSURE_REQUEST_NOT_FOUND`       | 404  | Заявка `:id` не найдена                                             |
| `CUTTING_CLOSURE_REQUEST_NOT_PENDING`     | 409  | Approve/reject допустимы только для `REQUESTED`                     |
| `FORBIDDEN_ROLE`                          | 403  | Роль не из allow-листа маршрута                                     |

Связанная ошибка модуля паспортов: `CUTTING_CLOSED` (§5) — выпуск
нового `Passport` после `APPROVED`.

---

## 15. Склады и привязка ячеек (Warehouse, ADR-0019)

Реализовано пост-Шагом 14 для админ-экрана «Склад» (см.
`screens.md §10b`, `domain.md §16`,
[ADR-0019](./adr/0019-warehouses.md)). Источник истины — backend,
модуль `apps/api/src/modules/warehouses`. Контракты — в
`packages/shared/src/warehouses.ts`.

| Метод | Путь                          | Роли      | Описание |
| ----- | ----------------------------- | --------- | -------- |
| GET   | `/api/warehouses`             | ADMIN, SM | Список складов с `cellsCount` |
| POST  | `/api/warehouses`             | ADMIN, SM | Создать склад (`name` обязателен, `code` опционально) |
| GET   | `/api/warehouses/:id`         | ADMIN, SM | Карточка склада + `cells[]` с готовыми `printUrl` |
| PATCH | `/api/warehouses/:id`         | ADMIN, SM | Точечно `name`/`code`/`isActive` (≥ 1 поле) |
| PATCH | `/api/cells/:id`              | ADMIN, SM | См. §7. На MVP — только `{ warehouseId: string \| null }` |
| GET   | `/api/cells/:id/print`        | Public    | HTML-этикетка 38×58 мм (горизонтально, QR слева + номер справа). `@Public()` (как у /equipment/print, ADR-0010). На этикетке только QR + номер — никакого имени склада, internal id или payload-строки `cell:{id}` |
| GET   | `/api/cells/:id/qr`           | Public    | См. §7. PNG QR с payload `cell:{id}` (ADR-0008, формат не меняется) |
| POST  | `/api/warehouses/:id/lines`   | ADMIN, SM | Массовое создание ячеек через линию: `code` + `count` ⇒ `${code}1..${code}N` |
| POST  | `/api/warehouses/:id/print-cells` | ADMIN, SM | Массовая печать «Печать всех ячеек»: создаёт `cellsCount × copies` PENDING-job-ов с `sourceType=CELL_LABEL` на выбранный `printerId` |

### `POST /api/warehouses`

Тело — `CreateWarehouseSchema`:

```jsonc
{
  "name": "Главный склад",  // обязательно, ≤ 120 символов
  "code": "MAIN",            // опционально, ≤ 32 символов; "" → null
  "isActive": true            // опционально, default true
}
```

201 → `WarehouseDetailDto`. Конфликты:

- `WAREHOUSE_NAME_TAKEN` (409) — повторное `name`;
- `WAREHOUSE_CODE_TAKEN` (409) — повторное `code`.

### `PATCH /api/warehouses/:id`

Тело — `UpdateWarehouseSchema`. Любое поле опционально, но **хотя бы
одно** обязано прийти, иначе 400 `VALIDATION_ERROR`. `code: null`
обнуляет код; пустая строка/whitespace тоже трактуются как `null`.

200 → `WarehouseDetailDto`. Ошибки те же, плюс
`WAREHOUSE_NOT_FOUND` (404).

### `PATCH /api/cells/:id`

Узкое тело — `UpdateCellSchema`:

```jsonc
{ "warehouseId": "ck...id..." }   // привязать к складу
{ "warehouseId": null }            // отвязать (cell сохраняется)
```

`warehouseId` обязателен в теле (`refine`-валидация); пустой объект →
400. На несуществующую ячейку — 404 `CELL_NOT_FOUND`, на
несуществующий склад — 404 `WAREHOUSE_NOT_FOUND`. Перепривязка
между складами разрешена явно (никаких блокировок «нельзя двигать
ячейку с активными паспортами» — складская группировка не влияет
на flow `place`/`issue`).

200 → `CellDetailDto` (то же, что у `GET /api/cells/:id`), с
обновлённым `warehouse: WarehouseLiteDto | null`.

### `GET /api/cells/:id/print` и `GET /api/cells/:id/qr`

Помечены `@Public()` — принтер-станция работает без сессии (та же
модель, что у passports/equipment, ADR-0010). На несуществующую
ячейку — 404. Печатная форма (`text/html; charset=utf-8`):

- жёсткий формат **38×58 мм горизонтально** (`@page { size: 58mm 38mm; margin: 0 }`),
  стандартный размер термоэтикетки на маркировку полок/ячеек;
- левая половина — QR (data URL PNG, payload `cell:{id}` ADR-0008);
- правая половина — крупный номер ячейки (шрифт подбирается под длину кода);
- больше ничего: ни имени склада, ни internal id, ни payload-строки `cell:...`,
  ни footer-текста, ни кнопки «Печать» в реальной печати
  (`@media print { .actions { display: none } }`);
- print-safety: `overflow: hidden`, `page-break-inside: avoid`,
  `break-inside: avoid`, `print-color-adjust: exact` +
  `-webkit-print-color-adjust: exact` — чёрный QR не «оптимизируется»
  драйвером в серый, контент гарантированно не уезжает на 2-ю страницу;
- кнопка «Печать» остаётся видимой только в screen-режиме — single-cell
  flow: менеджер открыл этикетку в новой вкладке, чтобы напечатать руками.

Эта же страница используется агентом массовой печати (см. ниже
`POST /api/warehouses/:id/print-cells`) — payload-URL job-а
`CELL_LABEL` указывает прямо на неё.

### `POST /api/warehouses/:id/lines`

Массовое создание ячеек через линию (см. §16 `domain.md`). Тело:

```jsonc
{ "code": "A", "count": 12 }   // создаст A1..A12 на этом складе
```

201 → `CreateWarehouseLineResultDto` (созданная линия + список
ячеек с готовыми `printUrl`). Конфликты:

- `WAREHOUSE_LINE_CODE_TAKEN` (409) — код линии уже занят;
- `WAREHOUSE_LINE_CELL_CODE_TAKEN` (409) — кто-то занял один из
  кодов `${code}${i}` руками (откатывается вся транзакция).

### `POST /api/warehouses/:id/print-cells`

Массовая печать «Печать всех ячеек» из карточки склада (см.
`screens.md §10b`). Менеджер выбирает принтер, размер этикетки и
число копий — backend создаёт `cellsCount × copies` PENDING-job-ов
с `sourceType=CELL_LABEL`, по одному на каждую копию каждой
**активной** ячейки склада. Деактивированные ячейки молча
исключаются — они и не должны печататься.

Тело — `PrintWarehouseCellsSchema`:

```jsonc
{
  "printerId": "ck...id...",  // обязательно (выбор менеджера в UI)
  "copies": 1,                  // int ≥ 1, ≤ WAREHOUSE_PRINT_CELLS_MAX_COPIES (50), default 1
  "labelSize": "38x58"         // enum WAREHOUSE_LABEL_SIZES, default "38x58"
}
```

201 → `PrintWarehouseCellsResultDto`:

```jsonc
{
  "warehouseId": "...",
  "printerId": "...",
  "cellsCount": 24,
  "copies": 2,
  "jobsCreated": 48,
  "labelSize": "38x58"
}
```

Поведение:

- `payloadUrl` каждого job-а указывает на `GET /api/cells/:id/print`
  через `resolvePublicApiBaseUrl()` — тот же резолв, что у
  паспортов/боксов: hostname берётся из `PUBLIC_API_URL` или
  `Forwarded`-заголовка, никогда не loopback (иначе агент на
  другой Windows-машине не достучится);
- порядок ячеек — `lineId asc → lineIndex asc → code asc` (тот же,
  что в `GET /api/warehouses/:id`), что даёт детерминированную
  очередь печати: сначала вся линия `A`, потом `B`, потом
  «без линии»;
- все job-ы создаются в одной `prisma.printJob.createMany`-транзакции —
  не оставляем «половину» очереди, если один из insert-ов упал.

Ошибки:

| Код                          | HTTP | Когда                                              |
| ---------------------------- | ---- | -------------------------------------------------- |
| `VALIDATION_ERROR`           | 400  | Zod (например, `copies > 50` или нет `printerId`)   |
| `WAREHOUSE_NOT_FOUND`        | 404  | `:id` склада не существует                          |
| `PRINTER_NOT_FOUND`          | 404  | `printerId` не существует                           |
| `PRINTER_INACTIVE`           | 409  | Принтер деактивирован                                |
| `WAREHOUSE_NO_CELLS_TO_PRINT`| 409  | На складе нет ни одной активной ячейки               |
| `FORBIDDEN_ROLE`             | 403  | Роль не из allow-листа `ADMIN`/`SHOP_MANAGER`        |

UI на frontend-е дополнительно держит кнопку disabled, если активных
ячеек нет — backend валидирует то же самое, чтобы не положить в
очередь принтера 0 заданий молча.

### Ошибки модуля warehouses

| Код                       | HTTP | Когда                                              |
| ------------------------- | ---- | -------------------------------------------------- |
| `VALIDATION_ERROR`        | 400  | Zod (тело/параметры)                                |
| `WAREHOUSE_NOT_FOUND`     | 404  | `:id` склада не существует                          |
| `WAREHOUSE_NAME_TAKEN`    | 409  | `name` дублирует существующий склад                 |
| `WAREHOUSE_CODE_TAKEN`    | 409  | `code` дублирует существующий склад                 |
| `WAREHOUSE_LINE_CODE_TAKEN` | 409 | `POST /:id/lines`: код линии занят                  |
| `WAREHOUSE_LINE_CELL_CODE_TAKEN` | 409 | `POST /:id/lines`: код ячейки занят руками     |
| `WAREHOUSE_NO_CELLS_TO_PRINT` | 409 | `POST /:id/print-cells`: нет активных ячеек        |
| `PRINTER_NOT_FOUND`       | 404  | `POST /:id/print-cells`: принтер не существует       |
| `PRINTER_INACTIVE`        | 409  | `POST /:id/print-cells`: принтер деактивирован       |
| `CELL_NOT_FOUND`          | 404  | `PATCH /api/cells/:id`: ячейка не найдена           |
| `FORBIDDEN_ROLE`          | 403  | Роль не из allow-листа `ADMIN`/`SHOP_MANAGER`        |

Не предусмотрено API на удаление склада — сознательное ограничение
MVP (см. ADR-0019). Менеджер выключает `isActive`. Если склад всё-таки
удалить через БД, `ON DELETE SET NULL` сохранит ячейки и обнулит
ссылку (покрыто тестом «Удаление склада на уровне БД…» в
`tests/integration/warehouses.test.ts`).

---

## 15a. Операции и тариф (Operation, ADR-0020)

Управленческий блок «Операции» (см. `screens.md §10c`, `domain.md §4a`,
[ADR-0020](./adr/0020-operation-pricing-model.md)). Источник истины —
backend, модуль `apps/api/src/modules/operations`. Контракты — в
`packages/shared/src/operations.ts` (`PRICING_MODES`,
`CreateOperationSchema`, `UpdateOperationSchema`,
`OperationDetailDto`, `OperationSummaryDto`).

| Метод | Путь                       | Роли      | Описание                                                                 |
| ----- | -------------------------- | --------- | ------------------------------------------------------------------------ |
| GET   | `/api/operations`          | ADMIN, SM | Список с `pricingMode`, `fixedRate`, `ratesBySizeCount`. Сортировка `sortOrder, name`. |
| GET   | `/api/operations/:id`      | ADMIN, SM | Карточка + `ratesBySize[]` (упорядочен по `Size.sortOrder`)              |
| POST  | `/api/operations`          | ADMIN, SM | Создать (валидация `pricingMode`-специфичная — см. ниже)                  |
| PATCH | `/api/operations/:id`      | ADMIN, SM | Точечно `name`/`category`/`isActive`/`pricingMode`/`fixedRate`/`ratesBySize` |

`code` сознательно не редактируется — это идентичность, на которую
ссылаются исторические события и `OperationEntry`. Удаления тоже нет —
менеджер выключает `isActive`.

> **UX-привязка к оборудованию (без расширения API).** Форма
> `/admin/operations/new` (см. `screens.md §10c`) умеет в одной
> отправке создать операцию и сразу включить её на выбранных станках.
> Backend для этого **не расширяется**: server action
> `createOperationAction` сначала делает обычный `POST /api/operations`,
> затем для каждого выбранного `equipmentId` читает текущий allow-list
> через `GET /api/equipment/:id` и шлёт уже существующий full-replace
> `PATCH /api/equipment/:id/operations` с дописанным `operationId`.
> Это сохраняет ранее разрешённые связи и не требует отдельного
> «add-single-operation» эндпоинта (см. ADR-0017). При частичном
> сбое (PATCH к одному из станков упал) операция **не удаляется** —
> action возвращает понятную server-action ошибку с перечислением
> сбойных id, чтобы менеджер мог дослать привязку из
> `/admin/equipment/[id]`.

### `POST /api/operations`

Тело — `CreateOperationSchema`:

```jsonc
{
  "code": "SEW_OVERLOCK_3",          // обязательно, UPPER_SNAKE_CASE
  "name": "Оверлок 3",                // обязательно, ≤ 120 символов
  "category": "SEWING",               // OperationCategory enum
  "pricingMode": "BY_SIZE",           // FIXED | BY_SIZE | SALARY_ONLY
  "fixedRate": null,                  // только для FIXED, иначе null/опущен
  "ratesBySize": [                    // только для BY_SIZE
    { "sizeId": "...", "rate": 12 },
    { "sizeId": "...", "rate": 14 }
  ],
  "sortOrder": 105,                   // опционально, default — за последним
  "isActive": true                    // опционально, default true
}
```

Серверная валидация (Zod `superRefine` + сервис):

- `pricingMode = FIXED` → `fixedRate` обязателен (`> 0`),
  `ratesBySize` запрещён;
- `pricingMode = BY_SIZE` → `ratesBySize` опционален, но если
  передан — каждый `sizeId` должен существовать
  (`OPERATION_RATE_SIZE_NOT_FOUND`, 400) и быть уникальным в
  пределах массива (`OPERATION_RATE_DUPLICATE_SIZE`, 400);
  `fixedRate` запрещён;
- `pricingMode = SALARY_ONLY` → ни `fixedRate`, ни `ratesBySize`
  передавать нельзя.

Конфликты: `OPERATION_CODE_TAKEN` (409) на дубль кода. 201 →
`OperationDetailDto`.

### `PATCH /api/operations/:id`

Тело — `UpdateOperationSchema`. Любое поле опционально, но
**хотя бы одно** обязано прийти, иначе 400 `VALIDATION_ERROR`.
`code` не передаётся (схема его не принимает).

Семантика смены `pricingMode` в одной транзакции:

- `* → SALARY_ONLY` — сервер выставляет `fixedRate = null` и стирает
  все `OperationRateBySize` для операции;
- `* → FIXED` — стирает `OperationRateBySize`, требует `fixedRate` в
  теле (если ещё не задан);
- `* → BY_SIZE` — обнуляет `fixedRate`. `ratesBySize` опционален в
  одном PATCH, но без него `EarningsService` упадёт с
  `OPERATION_RATE_MISSING` (422) на ближайшем начислении —
  менеджер обязан задать ставки до запуска новых паспортов;
- `BY_SIZE → BY_SIZE` с `ratesBySize: []` — стирает все ставки
  (явное «начнём с нуля»).

Изменения `ratesBySize` — это **полная замена набора** (как у
`PATCH /api/equipment/:id/operations`, ADR-0017): сервер удаляет
строки, которых нет в массиве, апсертит остальные. Сортировка
ответа — по `Size.sortOrder`.

200 → `OperationDetailDto`. Ошибки те же, плюс
`OPERATION_NOT_FOUND` (404).

### Ошибки модуля operations

| Код                              | HTTP | Когда                                                                  |
| -------------------------------- | ---- | ---------------------------------------------------------------------- |
| `VALIDATION_ERROR`               | 400  | Zod (тело/параметры), включая `pricingMode`-несоответствия              |
| `OPERATION_NOT_FOUND`            | 404  | `:id` операции не существует                                           |
| `OPERATION_CODE_TAKEN`           | 409  | `code` дублирует существующую операцию                                  |
| `OPERATION_RATE_SIZE_NOT_FOUND`  | 400  | В `ratesBySize` указан `sizeId`, которого нет в `Size`                  |
| `OPERATION_RATE_DUPLICATE_SIZE`  | 400  | В одном `ratesBySize[]` дублируется `sizeId`                            |
| `OPERATION_RATE_MISSING`         | 422  | `EarningsService` не нашёл ставку: `BY_SIZE` без `OperationRateBySize` для нужного `sizeId`, либо `FIXED` без `fixedRate` (последнее — внутренний инвариант) |
| `FORBIDDEN_ROLE`                 | 403  | Роль не из allow-листа `ADMIN`/`SHOP_MANAGER`                            |

`OPERATION_RATE_MISSING` пришёл на смену `PIECE_RATE_NOT_FOUND` —
последний больше не возвращается из runtime, но код оставлен в
таблице ниже как зарезервированный (`PieceRate` сохранена в БД для
аудита/rollback, см. ADR-0020 §4).

---

## 17. Себестоимость выпуска (`/api/costs/production`)

Read-only управленческий ендпойнт. Бизнес-правила — `domain.md §17`,
экран — `screens.md §17`. Не вводит новых таблиц/событий: всё считается
поверх существующих `OperationEntry`, `SalaryEntry` и `PassportEvent`.

### `GET /api/costs/production`

Запрос:

```
GET /api/costs/production?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
```

Параметры (Zod, `ProductionCostQuerySchema` из
`@sewing/shared/costs`):

- `dateFrom` — `YYYY-MM-DD`, опционально. По умолчанию = `dateTo − 13`.
- `dateTo` — `YYYY-MM-DD`, опционально. По умолчанию = текущая
  UTC-дата.
- Если переданы оба и `dateFrom > dateTo`, сервер сам нормализует
  направление (это страховка для UI-пагинации).

RBAC: `@Roles('SHOP_MANAGER', 'ADMIN')`. Прочие роли — `403
FORBIDDEN_ROLE`.

Ответ:

```json
{
  "dateFrom": "2026-04-01",
  "dateTo": "2026-04-14",
  "days": [
    {
      "date": "2026-04-01",
      "producedUnits": 5,
      "totalCost": 59.00,
      "pieceworkCost": 50.00,
      "salaryCost": 9.00,
      "trackedMinutes": 9,
      "idleMinutes": 1431,
      "idleCost": 1431.00
    }
  ],
  "summary": {
    "producedUnits": 5,
    "totalCost": 59.00,
    "pieceworkCost": 50.00,
    "salaryCost": 9.00,
    "idleCost": 1431.00,
    "trackedMinutes": 9,
    "idleMinutes": 1431,
    "avgCostPerUnit": 11.80
  }
}
```

Поля:

- `producedUnits` — Σ `qtyGood` по паспортам, для которых в этот день
  есть `PassportEvent.PACKED`.
- `pieceworkCost` — Σ `OperationEntry.amount` (статус `APPROVED`) по
  тем же паспортам.
- `salaryCost` — Σ `stage.durationMinutes × employee.minuteRate` по
  стадиям `QC` / `WTO` / `PACKING`. Длительности cap-аются
  `MAX_STAGE_MINUTES_PER_PASSPORT = 60`.
- `totalCost` = `pieceworkCost + salaryCost`. **Не включает простой.**
- `trackedMinutes` — Σ длительностей стадий, завершённых в этот день.
- `idleMinutes` = Σ по окладным сотрудникам с `SalaryEntry` за этот
  день: `max(0, SHIFT_MINUTES − tracked(employee, date))`.
- `idleCost` = Σ `idleMinutes(employee) × minuteRate(employee)`.
- `avgCostPerUnit` = `totalCost / producedUnits` (или `0`, если за
  период не выпущено ни одной штуки).

Все суммы — `Decimal(12,2)`, в ответе округлены до двух знаков.

Гарантии диапазона:

- Дни без событий тоже присутствуют в `days` (с нулями) — это
  нужно фронту для непрерывного графика.
- Период считается включительно по обеим границам, по UTC.

См. `domain.md §17`, `screens.md §17`.

---

## 12. Общие правила

- Все `POST/PATCH` принимают `application/json`.
- Ошибки — в формате (нормализуется через `GlobalExceptionFilter`, MVP 1.1):

  ```json
  {
    "statusCode": 400,
    "message": "...",
    "code": "PASSPORT_ALREADY_PACKED",
    "requestId": "9a4e6f0c-3e2c-4f4d-9a18-2c5b6d8a1f10"
  }
  ```

  `requestId` (Шаг 12) — UUID, которые middleware
  `requestIdMiddleware` присваивает каждому запросу. Тот же
  идентификатор уходит в логи `GlobalExceptionFilter` и
  возвращается в заголовке `X-Request-Id` любого ответа (включая
  успешные). Сотрудник на пилоте называет это значение поддержке —
  и в логах сразу находится нужная строка (см.
  `docs/pilot/faq.md`). Если входящий запрос уже содержит
  `X-Request-Id`, мы его уважаем (полезно для прокси).

  Stack trace и внутренние имена классов клиенту не выдаются. Для непойманных
  ошибок API возвращает `500 INTERNAL_ERROR` с обобщённым сообщением.
  Известные ошибки Prisma маппятся в коды: `P2002 → UNIQUE_VIOLATION`,
  `P2003 → FOREIGN_KEY_VIOLATION`, `P2025 → NOT_FOUND`.
- `employeeId` для всех state-changing endpoint-ов берётся из сессии. Передавать
  его в body/query запрещено и игнорируется (если случайно прислан).
- Пагинация: `?page=1&pageSize=50` → `{ items, total, page, pageSize }`.
- OpenAPI: `/api/docs` (Swagger UI).

---

## 13. Коды ошибок (бизнес)

| Код                               | HTTP | Описание                                      |
| --------------------------------- | ---- | --------------------------------------------- |
| `SHIFT_SESSION_REQUIRED`          | 409  | Нет активной сессии смены (Шаг 6)             |
| `SHIFT_ALREADY_ACTIVE`            | 409  | У сотрудника уже есть активная смена (Шаг 6)  |
| `SHIFT_NOT_ACTIVE`                | 409  | Завершение смены без активной смены (Шаг 6)   |
| `EMPLOYEE_NOT_FOUND`              | 404  | `employeeId` не найден (Шаг 6)                |
| `EMPLOYEE_INACTIVE`               | 409  | Сотрудник деактивирован (Шаг 6)               |
| `EQUIPMENT_NOT_FOUND`             | 404  | Оборудование не найдено (Шаг 6)               |
| `EQUIPMENT_INACTIVE`              | 409  | Оборудование деактивировано (Шаг 6)           |
| `OPERATION_INACTIVE`              | 409  | Операция деактивирована (Шаг 6)               |
| `PASSPORT_NOT_IN_CELL`            | 409  | Паспорт не в ячейке (Шаг 6 «Получить крой»)   |
| `PASSPORT_ALREADY_ISSUED`         | 409  | Паспорт уже выдан сотруднику (Шаг 6)          |
| `PASSPORT_CANCELLED`              | 409  | Паспорт отменён (Шаг 6)                       |
| `PASSPORT_ALREADY_PACKED`         | 409  | Паспорт уже упакован                          |
| `BOX_CAPACITY_EXCEEDED`           | 422  | Коробка переполнена (см. §9)                  |
| `DEFECT_EXCEEDS_REMAINING`        | 422  | `qty > qtyCut − qtyDefect` (Шаг 7)            |
| `DEFECT_TYPE_NOT_FOUND`           | 404  | Вид брака не найден (Шаг 7)                   |
| `DEFECT_TYPE_INACTIVE`            | 409  | Вид брака деактивирован (Шаг 7)               |
| `PASSPORT_NOT_QCABLE`             | 409  | Паспорт не в статусе `IN_PROGRESS` (Шаг 7)    |
| `OPERATION_TRANSITION_INVALID`    | 422  | Недопустимый переход                          |
| `PIECE_RATE_NOT_FOUND`            | 422  | Нет действующей расценки для операции (Шаг 9) |
| `EARNING_NOT_FOUND`               | 404  | Начисление не найдено (Шаг 9, зарезервировано) |
| `ORDER_LOCKED`                    | 409  | Нельзя менять план у заказа в IN_PRODUCTION   |
| `ORDER_INVALID_TRANSITION`        | 409  | Недопустимый переход статуса заказа           |
| `ORDER_HAS_NO_ITEMS`              | 400  | Нельзя запустить пустой заказ                 |
| `ORDER_DUPLICATE_SIZE`            | 400  | Размер повторяется в одном заказе             |
| `ORDER_NOT_IN_PRODUCTION`         | 409  | Выпуск паспорта только для `IN_PRODUCTION` (Шаг 5) |
| `SIZE_NOT_IN_ORDER`               | 400  | Размер паспорта не входит в заказ (Шаг 5)     |
| `QTY_EXCEEDS_REMAINING_PLAN`      | 422  | `qtyCut > qtyPlan − Σ выпущенного` (Шаг 5)    |
| `PASSPORT_NOT_FOUND`              | 404  | Паспорт не найден (Шаг 5)                     |
| `UNAUTHENTICATED`                 | 401  | Нет/невалидная session-cookie (MVP 1.1)        |
| `INVALID_CREDENTIALS`             | 401  | Неверный login/password (MVP 1.1)              |
| `FORBIDDEN_ROLE`                  | 403  | Нет требуемой роли для endpoint (MVP 1.1)      |
| `UNIQUE_VIOLATION`                | 409  | Маппинг `Prisma P2002` в API-ошибку (MVP 1.1)  |
| `FOREIGN_KEY_VIOLATION`           | 409  | Маппинг `Prisma P2003`                         |
| `NOT_FOUND`                       | 404  | Маппинг `Prisma P2025`                         |
| `INTERNAL_ERROR`                  | 500  | Непойманная ошибка; детали — только в логах    |
| `PASSPORT_NOT_PLACEABLE`          | 409  | Размещать можно только `CREATED` (Шаг 5)      |
| `PASSPORT_ALREADY_PLACED`         | 409  | Паспорт уже размещён в ячейке (Шаг 5)         |
| `CELL_NOT_FOUND`                  | 404  | Ячейка не найдена (Шаг 5)                     |
| `CELL_INACTIVE`                   | 409  | Ячейка деактивирована (Шаг 5)                 |
| `DEMO_USERS_MISSING`              | 400  | Нет seed-сотрудников `cutter`/`cutter-helper` (Шаг 5) |
| `OPERATION_NOT_FOUND`             | 400  | В справочнике нет нужной операции — нужен seed |
| `VALIDATION_ERROR`                | 400  | Zod-валидация тела/параметров запроса         |
| `CUTTING_CLOSURE_SIZE_NOT_IN_ORDER`     | 400 | Заявка на отсутствующую `(orderId, productId, sizeId)` (§14, ADR-0018) |
| `CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION` | 409 | Заявку можно подать только по `IN_PRODUCTION` (§14)            |
| `CUTTING_CLOSURE_ALREADY_REQUESTED`     | 409 | По строке уже есть `REQUESTED`-заявка (partial unique index, §14) |
| `CUTTING_CLOSURE_ALREADY_APPROVED`      | 409 | По строке уже есть `APPROVED`-заявка — раскрой закрыт (§14)       |
| `CUTTING_CLOSURE_REQUEST_NOT_FOUND`     | 404 | `:id` заявки не существует (§14)                                 |
| `CUTTING_CLOSURE_REQUEST_NOT_PENDING`   | 409 | Approve/reject допустим только для `REQUESTED` (§14)             |
| `CUTTING_CLOSED`                        | 409 | `POST /api/passports` запрещён: APPROVED-заявка по строке (§5, §14) |
| `WAREHOUSE_NOT_FOUND`                   | 404 | Склад не найден (§15, ADR-0019)                                    |
| `WAREHOUSE_NAME_TAKEN`                  | 409 | Имя склада уже занято (§15)                                        |
| `WAREHOUSE_CODE_TAKEN`                  | 409 | Код склада уже занят (§15)                                         |
| `OPERATION_CODE_TAKEN`                  | 409 | `Operation.code` уже занят (§15a, ADR-0020)                        |
| `OPERATION_RATE_SIZE_NOT_FOUND`         | 400 | В `ratesBySize` указан несуществующий `sizeId` (§15a)              |
| `OPERATION_RATE_DUPLICATE_SIZE`         | 400 | Дубль `sizeId` в одном `ratesBySize[]` (§15a)                      |
| `OPERATION_RATE_MISSING`                | 422 | `EarningsService.resolveRate` не нашёл ставку (§15a, заменяет `PIECE_RATE_NOT_FOUND`) |
| `SALARY_ENTRY_NOT_FOUND`                | 404 | `:id` окладной записи не существует (§10a, ADR-0021)               |
| `SALARY_RATE_MISSING`                   | 422 | `PATCH /api/salary/:id { reset: true }` для сотрудника без `salaryPerShift` (§10a) |
| `EMPLOYEE_SALARY_RATE_REQUIRED`         | 422 | `PATCH /api/employees/:id` оставил `compensationType ∈ { SALARY, MIXED }` без `salaryPerShift > 0` (§3b) |

## §16. Принтеры и задания на печать (MVP)

См. `docs/domain.md §17b`, `docs/screens.md §18`,
`apps/agent/README.md`. Все ответы — JSON, форматы соответствуют
`packages/shared/src/printers.ts` (`PrinterSummaryDto`,
`PrinterDetailDto`, `PrintJobDto`, `AgentPairResultDto`).

### Управление принтерами (роли `SHOP_MANAGER`, `ADMIN`)

| Метод     | URL                                          | Описание                                                                  |
|-----------|----------------------------------------------|---------------------------------------------------------------------------|
| `GET`     | `/api/printers`                              | Список принтеров (имя, тип, привязка, isOnline, lastSeenAt, queue depth). |
| `GET`     | `/api/printers/:id`                          | Детальная карточка (включая текущий `pairingCode`, без `agentToken`). Дополнительно отдаёт `agentHostName`, `availableWindowsPrinters`, `windowsPrintersUpdatedAt`, `selectedWindowsPrinter`. |
| `POST`    | `/api/printers`                              | Создать принтер (`name`, `type`, `equipmentId?`, `isActive?`).            |
| `PATCH`   | `/api/printers/:id`                          | Обновить принтер. Хотя бы одно поле обязательно. Поддерживает `selectedWindowsPrinter?: string \| null` — менеджер выбирает физический Windows-принтер из последнего `availableWindowsPrinters` от агента (или сбрасывает выбор `null`-ом). |
| `DELETE`  | `/api/printers/:id`                          | Удалить принтер. Каскадно удаляет историю заданий.                        |
| `POST`    | `/api/printers/:id/pairing-code`             | Сгенерировать новый `pairingCode` (старый теряется).                      |
| `GET`     | `/api/printers/agent-download/sewing-print-agent.exe` | `@Public` — отдаёт собранный Windows-exe агента (`application/octet-stream`, attachment). Файл ищется в `apps/agent/dist/sewing-print-agent.exe`. |

### Подключение и heartbeat агента (`X-Printer-Agent-Token`)

| Метод   | URL                                  | Кто                                  | Описание                                                                  |
|---------|--------------------------------------|--------------------------------------|---------------------------------------------------------------------------|
| `POST`  | `/api/printers/agent/pair`           | `@Public`, по `pairingCode` в теле   | Обмен `pairingCode` → `{ printerId, printerName, agentToken }`. После успеха `pairingCode` на сервере очищается. |
| `POST`  | `/api/printers/agent/heartbeat`      | агент по `X-Printer-Agent-Token`     | Обновляет `Printer.lastSeenAt`, `isOnline=true`. Тело пустое. Возвращает `{ ok: true, selectedWindowsPrinter: string \| null }` — текущий выбор менеджера, чтобы агент знал, куда печатать. |
| `POST`  | `/api/printers/agent/windows-printers` | агент по `X-Printer-Agent-Token`   | Агент шлёт `{ hostName: string, printers: string[] }` (имена физических Windows-принтеров с этой машины). Backend сохраняет `agentHostName`, перезаписывает `availableWindowsPrinters` (с дедупликацией), обновляет `windowsPrintersUpdatedAt`, `isOnline/lastSeenAt`. Возвращает `{ printerId, agentHostName, availableWindowsPrinters, selectedWindowsPrinter, windowsPrintersUpdatedAt }`. Уже выбранный менеджером `selectedWindowsPrinter` НЕ сбрасывается, даже если новой синхронизации он не содержит — менеджер сам решит, что делать. |

### Задания на печать

| Метод   | URL                                | Кто                                   | Описание                                                                                                  |
|---------|------------------------------------|---------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `POST`  | `/api/print-jobs`                  | любая залогиненная роль; `printerId` — только `SHOP_MANAGER`/`ADMIN` | Создаёт `PrintJob`. Тело: `{ sourceType, sourceId?, printerId? }`. Без `printerId` принтер берётся по активной смене. |
| `GET`   | `/api/print-jobs?printerId=…&limit=…` | `SHOP_MANAGER`/`ADMIN`             | Хвост заданий принтера для UI карточки (по умолчанию 20).                                                 |
| `GET`   | `/api/print-jobs/agent`            | агент                                  | Возвращает 0 или 1 PENDING-задание для своего принтера. Параллельно — heartbeat. Каждый `PrintJobDto` содержит `selectedWindowsPrinter` (на момент выдачи), чтобы агент печатал именно туда, куда задумал менеджер. |
| `PATCH` | `/api/print-jobs/:id`              | агент                                  | Закрывает задание. Тело: `{ status: 'PRINTED' | 'FAILED', errorMessage? }`. Для `FAILED` errorMessage обязателен. |

### Коды ошибок

| Код                                       | HTTP | Когда                                                                            |
|-------------------------------------------|------|----------------------------------------------------------------------------------|
| `PRINTER_NOT_FOUND`                       | 404  | `:id` принтера не существует.                                                    |
| `PRINTER_INACTIVE`                        | 409  | Попытка использовать принтер с `isActive=false`.                                 |
| `PRINTER_PAIRING_CODE_INVALID`            | 409  | `agent/pair` с неверным или уже использованным кодом.                            |
| `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`    | 409  | Активная смена есть, но на её `equipmentId` нет ни одного активного принтера.    |
| `PRINT_JOB_NOT_FOUND`                     | 404  | `:id` задания нет, или задание принадлежит другому принтеру (агент видит то же). |
| `PRINT_JOB_ALREADY_CLOSED`                | 409  | Попытка повторно закрыть задание (PRINTED/FAILED).                               |
| `SHIFT_SESSION_REQUIRED`                  | 409  | `POST /api/print-jobs` без `printerId` и без активной смены.                     |
| `FORBIDDEN_ROLE`                          | 403  | `POST /api/print-jobs` с `printerId` от не-менеджерской роли.                    |
| `AGENT_BUNDLE_NOT_FOUND`                  | 404  | `agent-download` не нашёл `apps/agent/dist/sewing-print-agent.exe` на сервере. Соберите агент: `cd apps/agent && npm run build:win`. |
| `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`     | 422  | `PATCH /api/printers/:id` с `selectedWindowsPrinter`, которого нет в последнем `availableWindowsPrinters` от агента. Менеджеру в UI просим запустить агент рядом с принтером и дождаться обновления списка. |

## §17. Маршруты производства (`/api/routes`)

> Реализовано вместе с MVP soft-route (см. `docs/domain.md §18`,
> `apps/api/src/modules/routes`). Это «мягкий» маршрут: API только
> хранит каталог шаблонов и помогает фронту подсказывать швее
> «куда дальше». Никакой 409-валидации scan-а на маршрут нет (см.
> `STEP 5` ТЗ MVP).

| Метод  | Путь                     | Роли           | Описание                                                                  |
|--------|--------------------------|----------------|---------------------------------------------------------------------------|
| GET    | `/api/routes`            | любой залогин. | Список шаблонов. `?isActive=true|false` фильтрует. `?search=` — по `code`/`name`. |
| GET    | `/api/routes/:id`        | любой залогин. | Шаблон + упорядоченные шаги (`RouteTemplateStepDto[]`).                   |
| POST   | `/api/routes`            | ADMIN, SM      | Создать шаблон. Тело — `CreateRouteTemplateDto`.                          |
| PATCH  | `/api/routes/:id`        | ADMIN, SM      | Частичный апдейт. Передача `steps` — **полная замена** набора шагов.      |
| DELETE | `/api/routes/:id`        | ADMIN, SM      | Удалить. Snapshot-ы (`OrderRouteStep`) на старых заказах остаются жить.   |

### Тело `POST /api/routes`

```json
{
  "code": "TSHIRT-BASIC",
  "name": "Базовая футболка",
  "isActive": true,
  "steps": [
    { "operationId": "clx...", "isOptional": false },
    { "operationId": "clx...", "isOptional": false },
    { "operationId": "clx..." }
  ]
}
```

- `code` — уникальный, регистр `^[A-Z0-9][A-Z0-9_-]{0,47}$`.
- `name` — до 120 символов.
- `isActive` — по умолчанию `true`. Деактивированный шаблон нельзя
  привязать к новому заказу (см. `ROUTE_TEMPLATE_INACTIVE`), но
  старые snapshot-ы продолжают работать.
- `steps` — массив (можно пустой). Порядок шагов в snapshot-е и в
  ответе API определяется **позицией в массиве** — `index` в DTO
  не нужен и игнорируется. Уникальность `operationId` в рамках
  массива проверяется и Zod-схемой, и БД (`@@unique`).
- `steps[i].isOptional` — на MVP только сохраняется в данных, в
  enforcement не используется.

### Тело `PATCH /api/routes/:id`

Все поля опциональны; должно быть указано хотя бы одно. `steps`
заменяет шаги целиком (внутри транзакции `delete + createMany`).
Менять `isActive` отдельно от шагов — типичный сценарий «временно
скрыть шаблон из списка выбора».

### Ответ

```json
{
  "id": "clx...",
  "code": "TSHIRT-BASIC",
  "name": "Базовая футболка",
  "isActive": true,
  "stepsCount": 5,
  "createdAt": "...",
  "updatedAt": "...",
  "steps": [
    {
      "id": "clx...",
      "index": 0,
      "operationId": "clx...",
      "operationCode": "CUT",
      "operationName": "Раскрой",
      "isOptional": false
    }
  ]
}
```

`GET /api/routes` отдаёт массив `RouteTemplateSummaryDto` (без
`steps`, но с `stepsCount`) — этого достаточно для admin-списка и
для select-а на форме создания заказа.

### Ошибки

| Код                         | HTTP | Когда                                                       |
|-----------------------------|------|-------------------------------------------------------------|
| `VALIDATION_ERROR`          | 400  | Zod (тело/query): неверный `code`, дубль `operationId` и т.п. |
| `ROUTE_TEMPLATE_NOT_FOUND`  | 404  | `:id` не существует.                                        |
| `ROUTE_TEMPLATE_CODE_TAKEN` | 409  | `code` уже используется другим шаблоном.                    |
| `OPERATION_NOT_FOUND`       | 400  | `steps[*].operationId` не существует.                       |

### Использование из заказов

См. §4: `POST /api/orders` принимает `routeTemplateId`,
`PATCH /api/orders/:id` позволяет сменить/снять привязку до запуска,
`POST /api/orders/:id/start` создаёт snapshot `OrderRouteStep[]`.
После `start()` менять `routeTemplateId` нельзя:
`ORDER_ROUTE_ALREADY_STARTED` (409).

### Soft-route hint в DTO паспорта (STEP 8 ТЗ MVP)

`PassportDetailDto.routeHint` — read-only подсказка для UI на `/work`
(модалка `PassportConfirmModal` и блок «Сейчас в работе»). Полная схема
поля — в §5 «Ответ `GET /api/passports/:id`». Ключевые свойства:

- источник истины — `OrderRouteStep` snapshot заказа, **не**
  `RouteTemplate` (snapshot самодостаточен и переживает удаление
  шаблона);
- `currentRouteStep` берётся по `Passport.currentRouteStepIndex`;
- `nextRouteStep` = `step[currentRouteStepIndex + 1]` (или `step[0]`,
  если индекс ещё `null`);
- единая конвенция MVP: `expectedOperation = currentRouteStep.operation`
  (та же, что в `current-work-card.tsx` — см. `docs/screens.md §10e`);
- `routeMismatchWithActiveShift` populated только теми эндпоинтами,
  где сервер знает «от чьего имени» строит hint:
  - `POST /api/passports/by-code` — да (берёт активную смену
    `@CurrentUser`);
  - `GET /api/passports/:id` — нет (mismatch=false, активная смена не
    подтягивается).

**No enforcement on MVP.** Backend никогда не возвращает 409 за «не туда
сканировал» и не использует `routeHint` для бизнес-логики
`scanOnOperation` / `issueToEmployee` / `completeOperationByEmployee`.
Hint существует исключительно ради UI-подсказки оператору.

## §18. Техкарты (`/api/tech-cards`)

> Реализовано вместе с MVP техкарт (см. `docs/domain.md §19`,
> ADR-0022, `apps/api/src/modules/tech-cards`). Контракт повторяет
> «soft-route» pattern: каталог шаблонов + опциональная привязка к
> заказу + snapshot потребностей при `OrdersService.start()`.

| Метод  | Путь                       | Роли                | Описание                                                                  |
|--------|----------------------------|---------------------|---------------------------------------------------------------------------|
| GET    | `/api/tech-cards`          | любой залогин.      | Список шаблонов (`TechCardTemplateSummaryDto[]`). `?isActive=true|false`, `?search=` по `code`/`name`. |
| GET    | `/api/tech-cards/:id`      | любой залогин.      | Детальный DTO (`TechCardTemplateDetailDto`) с `materialLines` и `outsourceLines`, отсортированными `sortOrder ASC`. |
| POST   | `/api/tech-cards`          | ADMIN, SHOP_MANAGER | Создать шаблон. Тело — `CreateTechCardSchema`.                             |
| PATCH  | `/api/tech-cards/:id`      | ADMIN, SHOP_MANAGER | Частичный апдейт. Передача `materialLines` / `outsourceLines` — **полная замена** соответствующего списка строк. |

> `DELETE` сознательно не реализован. Деактивация — через
> `PATCH { isActive: false }` (snapshot-ы заказов остаются
> независимыми).

### Тело `POST /api/tech-cards`

```json
{
  "code": "TSHIRT-BASIC",
  "name": "Базовая футболка — потребности",
  "isActive": true,
  "materialLines": [
    { "name": "Кулирка 180 г/м²", "unit": "м",  "qtyPerUnit": "0.55", "note": null },
    { "name": "Нитки 40/2 белые", "unit": "м",  "qtyPerUnit": "120",  "note": null }
  ],
  "outsourceLines": [
    {
      "name": "Шелкография — лого спереди",
      "unit": "шт",
      "qtyPerUnit": "1",
      "vendorName": "Print&Co",
      "note": null
    },
    {
      "name": "Печать этикеток (за партию)",
      "unit": null,
      "qtyPerUnit": null,
      "vendorName": null,
      "note": null
    }
  ]
}
```

- `code` — уникальный, валидируется по тому же стилю, что и
  `RouteTemplate.code`.
- `name` — обязателен, trim.
- `isActive` — опционален (default `true`).
- `materialLines` — массив; пустой допустим.
  - `name`, `unit` — обязательны.
  - `qtyPerUnit` — строка с положительным числом (Decimal-семантика).
  - `note` — опционален (`null`/`""` нормализуется в `null`).
- `outsourceLines` — массив; пустой допустим.
  - `name` — обязателен.
  - `unit`, `qtyPerUnit`, `vendorName`, `note` — опциональны
    (`qtyPerUnit`, если задан, должен быть положительным).
- `sortOrder` из формы **не принимается**: backend расставляет его
  как `(index + 1) * 10` по порядку массива.

### Тело `PATCH /api/tech-cards/:id`

```json
{
  "name": "Новое имя",
  "isActive": false,
  "materialLines": [ /* full-replace */ ],
  "outsourceLines": [ /* full-replace */ ]
}
```

- Любое подмножество полей. `code`, `name`, `isActive` обновляются
  по принципу «передал — заменил».
- Передача `materialLines` или `outsourceLines` — **full-replace
  pattern** (как `RouteTemplateService.replaceSteps` /
  `EquipmentOperation`): в одной транзакции выкидываем все строки
  соответствующего типа и пересоздаём из тела с новыми
  `sortOrder = (index + 1) * 10`. Если хочется оставить строки
  как есть — поле просто не передаётся.
- Snapshot уже запущенных заказов **не меняется**: они физически
  лежат в `OrderMaterialRequirement[]` / `OrderOutsourceRequirement[]`
  и не зависят от `TechCardMaterialLine.id` после
  `ON DELETE SET NULL`.

### Ответ

`TechCardTemplateDetailDto`:

```json
{
  "id": "clx...",
  "code": "TSHIRT-BASIC",
  "name": "Базовая футболка — потребности",
  "isActive": true,
  "createdAt": "...",
  "updatedAt": "...",
  "materialLines": [
    {
      "id": "clx...",
      "sortOrder": 10,
      "name": "Кулирка 180 г/м²",
      "unit": "м",
      "qtyPerUnit": "0.55",
      "note": null
    }
  ],
  "outsourceLines": [
    {
      "id": "clx...",
      "sortOrder": 10,
      "name": "Шелкография — лого спереди",
      "unit": "шт",
      "qtyPerUnit": "1",
      "vendorName": "Print&Co",
      "note": null
    }
  ]
}
```

`GET /api/tech-cards` отдаёт массив `TechCardTemplateSummaryDto`
(без `materialLines`/`outsourceLines`, но с `materialLinesCount` и
`outsourceLinesCount`) — этого достаточно для admin-списка и для
select-а на форме создания заказа.

### Ошибки

| Код                               | HTTP | Когда                                                                 |
|-----------------------------------|------|-----------------------------------------------------------------------|
| `VALIDATION_ERROR`                | 400  | Zod (тело/query): пустой `name`, не-положительный `qtyPerUnit`, и т.п.|
| `TECH_CARD_NOT_FOUND`             | 404  | `:id` не существует.                                                  |
| `TECH_CARD_CODE_TAKEN`            | 409  | `code` уже используется другим шаблоном (Prisma `P2002`).             |
| `TECH_CARD_INACTIVE`              | 409  | Попытка использовать `isActive=false` шаблон в `POST/PATCH /api/orders`. |
| `ORDER_TECH_CARD_ALREADY_STARTED` | 409  | Попытка сменить `techCardId` на заказе, у которого snapshot уже зафиксирован. |

### Использование из заказов

См. §4:

- `POST /api/orders` принимает `techCardId` (опц.). Сервер вызывает
  `assertTechCardUsable(id)` — 404/409 при отсутствии/деактивации.
- `PATCH /api/orders/:id` пускает смену `techCardId` пока заказ в
  `DRAFT` и snapshot не создан (т.е. до `start()`); иначе 409
  `ORDER_TECH_CARD_ALREADY_STARTED`.
- `POST /api/orders/:id/start` в одной транзакции:
  - переводит статус `DRAFT → IN_PRODUCTION`;
  - копирует `RouteTemplateStep[]` → `OrderRouteStep[]` (если
    выбран `routeTemplateId`);
  - копирует `TechCardMaterialLine[]` → `OrderMaterialRequirement[]`
    и `TechCardOutsourceLine[]` → `OrderOutsourceRequirement[]`,
    если выбран `techCardId`;
  - `totalQty = qtyPerUnit * Σ OrderItem.qtyPlan` (`Prisma.Decimal`).
    Для outsource без `qtyPerUnit` снапшот хранит `totalQty = null`.
  - идемпотентен: если snapshot уже есть — повторно не создаёт.
- `GET /api/orders/:id` отдаёт `techCardId/Code/Name` и оба массива
  snapshot-ов. См. §4 «Ответ `GET /api/orders/:id`».

> Контракт: **источник истины для блоков «Материалы» и «Внешние
> потребности» на `/orders/[id]` — snapshot заказа, не live-шаблон.**
> Карточка не ходит в `/api/tech-cards/:id`; правка шаблона после
> `start()` на запущенный заказ не влияет.
