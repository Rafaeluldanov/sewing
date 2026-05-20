# Удаление сотрудников — recon

> **Статус:** идея, не реализация. Документ фиксирует, как безопасно
> добавить операцию «удалить сотрудника» из таблицы `/admin/employees`
> и со страницы карточки `/admin/employees/[id]`.
>
> Принцип: **два уровня удаления** — мягкое архивирование (default,
> возможно почти всегда) и жёсткий hard-delete (только для пустых
> карточек, только под ADMIN, с подтверждением). Schema не меняем —
> опираемся на существующее поле `Employee.active` и FK-ограничения.

## 1. Контекст

- `Employee.active: Boolean @default(true)`
  ([`prisma/schema.prisma:797`](../prisma/schema.prisma#L797)) — soft-delete
  by flag, уже работает.
- API `PATCH /api/employees/:id { active: false }` переключает флаг
  (`EmployeesService.update`,
  [`employees.service.ts:204-278`](../apps/api/src/modules/employees/employees.service.ts#L204-L278)).
  Документация сервиса явно фиксирует ([`L28-L31`](../apps/api/src/modules/employees/employees.service.ts#L28-L31)):
  «Удаление по-прежнему out-of-scope — менеджер мягко гасит карточку
  через `active = false`».
- UI на `/admin/employees`
  ([`apps/web/app/admin/employees/page.tsx:70-73`](../apps/web/app/admin/employees/page.tsx#L70-L73))
  уже разделяет вкладки «Активные» / «Архив» (фильтр по `!active`).
  Не хватает только UI-входа: кнопки в строке таблицы и на странице
  карточки.

То есть **архивирование уже реализовано на уровне API и фильтра в UI**.
Нужно добавить только action-кнопки + диалог; и опционально — отдельный
hard-delete endpoint для пустых карточек.

## 2. Что мешает hard-delete (FK-анализ)

Employee в Prisma-схеме упомянут как FK во множестве моделей
([`prisma/schema.prisma:800-895`](../prisma/schema.prisma#L800-L895)).
Поведение `onDelete` различается:

### 2.1 Жёсткие блокировки (Postgres откажет в DELETE)

| Модель | Поле | onDelete | Почему важно сохранить |
|---|---|---|---|
| `OperationEntry` | `employeeId` | NoAction (default) | Сдельные начисления — финансовая история |
| `SalaryEntry` | `employeeId` | NoAction | Окладные начисления — финансовая история |
| `Passport` | `cutterId`/`creatorId`/`currentEmployeeId` | NoAction | Кто резал/выпустил/держит сейчас |
| `PassportDefect` | `employeeId` | NoAction | Кто зафиксировал брак |
| `ShiftSession` | `employeeId` | NoAction | История смен |
| `Box` | `creatorId` | NoAction | Кто собрал коробку |
| `MasterCall` | `employeeId`/`resolverId` | NoAction | Вызовы мастера и кто закрыл |
| `PayrollPayoutLine` | `employeeId` | **Restrict** (явно) | Выплата зарплаты — нельзя сносить |
| `PayrollAccrualDocumentLine` | `employeeId` | **Restrict** (явно) | Документ начисления |

При попытке `DELETE` Prisma вернёт `P2003` (FK violation). Это
правильно — историю удалять нельзя.

### 2.2 «SetNull» — физически не блокируют, но смысл теряется

`PassportEvent.employeeId`, `PurchaseOrder.createdById`,
`PurchaseReceipt.receivedById`, `OrderCostEstimate.completedById` /
`revokedById`, `OrderMaterialArrivalOverride.createdById` /
`revokedById`, `PatternSizeFile.uploadedById`,
`ConstructorTask.createdById` / `assignedToId`,
`CuttingClosureRequest.requesterId` / `reviewerId`,
`SalaryEntry.editorId` (relation `SalaryEntryEditor`).

После hard-delete в этих записях `null` появится, читаемость аудита
снизится, но БД останется консистентной.

### 2.3 «Cascade» — особый случай, требует внимания

`DisplayScreenConfig.employeeId @unique`
([`prisma/schema.prisma:2865`](../prisma/schema.prisma#L2865),
`@onDelete: Cascade`) — удаление учётки `DISPLAY` каскадно снесёт
конфиг привязанного к ней экрана. Это by-design (учётка заводится
строго под экран и не используется где-то ещё), но в UI hard-delete
нужно явно об этом предупреждать.

## 3. Уровень 1 — «Архивировать» (soft delete, default)

### 3.1 Что делает

`PATCH /api/employees/:id { active: false }` — поле флипается, карточка
исчезает из таба «Активные» и появляется в «Архив». Возврат —
`PATCH active=true`.

### 3.2 Предусловия (проверять на backend)

Если **есть открытая активность сотрудника**, архивирование может
оставить систему в неконсистентном состоянии:

| Проверка | Почему |
|---|---|
| Нет `ShiftSession.endedAt = null` для этого `employeeId` | Сотрудник сейчас на смене; QR продолжит сканироваться, на терминалах он будет виден |
| Нет `Passport.currentEmployeeId = employeeId` | Паспорт висит «на нём»; в архивированном виде паспорт никто не сможет передать. Подсказка в UI: «Передайте паспорта через мастер-роут» |
| Нет открытых `MasterCall.employeeId = employeeId AND status NOT IN (RESOLVED, CANCELLED)` | Висячий вызов мастера |
| Нет `CuttingClosureRequest.requesterId = employeeId AND status = REQUESTED` (для роли `CUTTER_ASSISTANT`) | Висячая заявка на закрытие раскроя |
| `viewerId !== targetId` | Нельзя архивировать себя |
| Если `target.role = ADMIN` — должен оставаться ещё хотя бы один активный ADMIN | Нельзя оставить систему без админа |

Если хотя бы одно условие нарушено — backend возвращает
структурированную ошибку с массивом блокеров, UI показывает их
человеку с инструкцией, что делать.

### 3.3 Реактивация

`PATCH active=true`. Особый кейс — `Employee.login @unique`. Пока
карточка в архиве, её login занят. Если за это время менеджер
создал нового сотрудника с тем же login (что архивный сервис позволит
сделать только если архивный был `disconnect`-нут от login'а — но
такой механики у нас нет), реактивация упрётся в уникальность. На MVP
оставляем как есть: если конфликта нет — реактивация работает; если
есть — backend возвращает `EMPLOYEE_LOGIN_TAKEN`, и менеджер решает
вручную (изменить login одного из них).

## 4. Уровень 2 — «Удалить навсегда» (hard delete)

### 4.1 Когда имеет смысл

Только для свежесозданных карточек, у которых **никакой истории нет**:
тестовая учётка, опечатка в ФИО, ошиблись ролью при создании,
дублирующая запись.

Если у карточки есть OperationEntry / SalaryEntry / Passport /
ShiftSession / Box / MasterCall / PayrollPayout / PayrollAccrualDocumentLine /
PassportDefect — hard-delete **запрещён**. UX в этом случае предложит
архив вместо удаления.

### 4.2 Предусловия (backend всё проверяет в одной транзакции)

```text
count(OperationEntry            where employeeId = :id) === 0
count(SalaryEntry               where employeeId = :id) === 0
count(SalaryEntry               where editorId   = :id) === 0
count(Passport                  where cutterId OR creatorId OR currentEmployeeId = :id) === 0
count(PassportDefect            where employeeId = :id) === 0
count(ShiftSession              where employeeId = :id) === 0
count(Box                       where creatorId  = :id) === 0
count(MasterCall                where employeeId OR resolverId = :id) === 0
count(PayrollPayout             where employeeId OR createdById OR issuedById OR ackedById OR cancelledById = :id) === 0
count(PayrollAccrualDocument*   where любой autorId = :id) === 0
count(PayrollAccrualDocumentLine where employeeId = :id) === 0

viewer.id !== target.id                                          # нельзя удалить себя
viewer.role === 'ADMIN'                                          # hard-delete только админ
target.role !== 'ADMIN' || existsOtherActiveAdmin                # не последний админ
target.role !== 'DISPLAY' || ackDisplayCascade                   # явный аск для DISPLAY (DisplayScreenConfig снесётся каскадом)
```

`PassportEvent` (SetNull) и прочие SetNull-таблицы тоже стоит
проверить — формально они hard-delete не заблокируют, но если в UI
показывать «нельзя удалить, потому что есть N исторических событий»,
менеджер поймёт ситуацию точнее. На MVP можно SetNull-связи не
блокировать (тогда смысл «никакой истории» сужается до финансовой и
производственной), а если позже окажется, что менеджеры теряют
attribution в `PassportEvent` — добавим в blockers.

### 4.3 Структурированный ответ backend'а

При попытке hard-delete сервис всегда сначала выполняет preflight и
возвращает либо `204 No Content` (удалили), либо `409 Conflict` с
телом:

```json
{
  "ok": false,
  "code": "EMPLOYEE_HAS_HISTORY",
  "blockers": [
    { "kind": "OperationEntry",            "count": 123 },
    { "kind": "SalaryEntry",                "count": 45,  "lastAt": "2026-04-22T10:30:00Z" },
    { "kind": "Passport",                   "count": 8 },
    { "kind": "ShiftSession",               "count": 12 },
    { "kind": "PayrollAccrualDocumentLine", "count": 3 }
  ],
  "suggestion": "ARCHIVE"
}
```

UI рендерит это как «нельзя удалить — у сотрудника N паспортов,
M начислений…» с кнопкой «Архивировать вместо удаления».

Препоказ (без попытки удалить) — отдельный endpoint
`GET /api/employees/:id/blockers`, чтобы UI мог сразу показать «hard
delete доступен» / «доступен только архив» ещё до открытия модалки.

## 5. API (предложение)

Минимальный набор, опираясь на существующий стиль (`@Patch` для
обновлений, `@Delete` для hard, `@Post` для action'ов как `/archive`):

```
GET    /api/employees/:id/blockers   — preflight: можно ли hard-delete и что мешает
POST   /api/employees/:id/archive    — soft-delete, RBAC: SHOP_MANAGER+
POST   /api/employees/:id/restore    — снять архив, RBAC: SHOP_MANAGER+
DELETE /api/employees/:id            — hard-delete, RBAC: ADMIN only, 409 если есть blockers
```

Альтернатива: оставить только `PATCH active` (как сейчас) для архива +
добавить `DELETE` + `GET .../blockers`. Это меньше кода и не плодит
endpoints — выбор между «явные action endpoints» и «patch one field»
делается по вкусу команды. Рекомендую первое: `archive` / `restore`
позволяет навесить на них preflight-проверки и аудит без if-ов в
generic `update`.

В обоих вариантах `PATCH /api/employees/:id { active }` остаётся как
есть — это совместимо с уже существующей формой
[`apps/web/app/admin/employees/actions.ts`](../apps/web/app/admin/employees/actions.ts).

### 5.1 Shared / DTO

В `@sewing/shared/employees`:

```ts
export interface EmployeeBlockerDto {
  kind: 'OperationEntry' | 'SalaryEntry' | 'Passport' | 'PassportDefect'
      | 'ShiftSession' | 'Box' | 'MasterCall' | 'PayrollPayout'
      | 'PayrollAccrualDocumentLine';
  count: number;
  lastAt?: string;          // ISO, опционально — для UI «последняя запись от …»
}
export interface EmployeeBlockersResponse {
  hardDeleteAllowed: boolean;
  archiveAllowed: boolean;
  blockers: EmployeeBlockerDto[];
  archiveBlockers: EmployeeArchiveBlockerDto[];  // открытая смена, висячие паспорта, висячие master-calls
}
```

## 6. UX

### 6.1 В таблице `/admin/employees`

В правой колонке (там, где сейчас `AdminStatusBadge`) — добавить
кнопку-меню «⋯» для строки, варианты:

- **Активный сотрудник**: «Архивировать», «Удалить» (если backend
  сообщил `hardDeleteAllowed: true`; иначе пункт disabled с tooltip).
- **Архивный**: «Восстановить», «Удалить» (по тем же правилам).

Кнопка «Удалить» не должна стать обычным action одного клика — это
финал. Открывается модалка (см. ниже).

### 6.2 На странице `/admin/employees/[id]`

Внизу формы, отдельным блоком «Опасная зона» (по аналогии с GitHub),
визуально отделённым от полей карточки:

```
─────────────────────────────────────────
 Опасная зона
─────────────────────────────────────────
  [ Архивировать ]   — мягко скрыть из активных
                       (история сохранится)

  [ Удалить навсегда ] — только пустые карточки,
                         требует подтверждения
─────────────────────────────────────────
```

### 6.3 Модалка hard-delete (anti-bumblefuck)

- Заголовок: «Удалить сотрудника навсегда?»
- Содержимое: ФИО, login, роль, дата создания, число дней с создания.
- Список того, что будет удалено каскадом: пусто для обычных ролей;
  для `DISPLAY` — «также удалится экран `DISPLAY-1`».
- Поле ввода: «Введите login сотрудника для подтверждения:».
- Кнопка `Удалить навсегда` (`btn-danger`) — disabled, пока
  введённый login не совпадёт строка-в-строку с реальным.

Архив подобную «трение»-модалку не требует — soft delete всегда
обратим. Достаточно стандартного «Архивировать сотрудника `<ФИО>`?
[Отмена] [Архивировать]».

### 6.4 Сообщения «нельзя архивировать»

Backend вернул blockers — UI показывает список:

```
Невозможно архивировать: у сотрудника есть открытая смена
с 2026-05-20 09:14. Сначала завершите смену через
«⋯ → Завершить смену».
```

Текст под каждый кейс заводится один раз (`getArchiveBlockerLabel(kind)`),
вместо рендера сырого JSON.

## 7. Аудит

Все три операции пишутся в `AuditLog` через `AuditService.log(...)`
([`apps/api/src/modules/audit/audit.service.ts`](../apps/api/src/modules/audit/audit.service.ts)):

| Action | Payload |
|---|---|
| `employee.archive` | `{ targetId, targetSnapshot: { fullName, login, role } }` |
| `employee.restore` | `{ targetId }` |
| `employee.delete`  | `{ targetSnapshot: { fullName, login, role, createdAt }, hadActiveDisplayConfig?: boolean }` |

`employee.delete` критичен: после hard-delete карточка из БД пропадёт,
и без аудита расследовать «куда делась учётка» будет нечем. Snapshot
обязателен.

`actorId` — viewer (из `AuditLogInput.employeeId`).

## 8. RBAC

| Action | SHOP_MANAGER | ADMIN |
|---|---|---|
| `archive` | ✓ | ✓ |
| `restore` | ✓ | ✓ |
| `hard-delete` | ✗ | ✓ |
| `archive ADMIN` | ✗ (не может управлять ADMIN-уровнем) | ✓ |

Архивирование сотрудника с ролью `ADMIN` доступно только другому
`ADMIN` — иначе SHOP_MANAGER мог бы выключить админов и поднять себя
до фактического root-а. Hard-delete `ADMIN` — только из-под другого
`ADMIN` и только если останется хотя бы один активный `ADMIN`.

## 9. Что НЕ делаем в этой задаче

- Не меняем схему БД. Никаких новых полей `deletedAt`, soft-delete
  через timestamp вместо boolean и т.п. Текущий `active: Boolean`
  достаточен — а перевод на `deletedAt`-pattern потянет миграцию
  всех `WHERE active = true` запросов по кодовой базе.
- Не вводим bulk-delete (выделить N строк → удалить). По мере
  необходимости можно навесить позже на тот же endpoint.
- Не правим `PIN`. Архивный сотрудник продолжает иметь `pinHash` в
  БД (логин режется на уровне `AuthService` через гард по `active`).
  Если задача — отозвать доступ безвозвратно без удаления карточки —
  это пока вне scope (для MVP архив == «доступ закрыт»).
- Не делаем «soft-delete с retention» (через N дней становится
  hard-delete автоматом). Это операционно опасно — менеджер может
  пропустить окно и потерять учётку с истёкшим retention.
- Не добавляем bulk-undo для архива — есть отдельная вкладка «Архив»
  и кнопка «Восстановить» по строке, этого достаточно.

## 10. Открытые вопросы

- **`DisplayScreenConfig` каскад**: сейчас единственная Cascade на
  Employee. Допустимо ли при hard-delete DISPLAY-сотрудника сносить
  и его экран автоматически? Или ввести правило «сначала вручную
  открепи экран через `/admin/display`, потом удаляй учётку»? На MVP
  предлагаю первое (с явным согласием в модалке), но решение менять
  будет дорого, если позже передумаем — мы потеряем DisplayScreenConfig'и.
- **PassportEvent attribution**: hard-delete оставит `null` в
  событиях. Считаем ли мы это допустимой ценой за «полностью
  чистого» удалённого сотрудника? Альтернатива — включить
  `PassportEvent.count > 0` в blockers, и тогда hard-delete будет
  доступен только в первые часы жизни карточки (пока никто не успел
  под ней просканировать паспорт).
- **Восстановление с занятым login**: подробнее в §3.3. Возможный
  улучшенный UX — при попытке восстановить с конфликтом сразу
  открывать форму смены `login`.
- **Удалять ли архивные при чистке базы** (например, ежегодная
  «уборка»). За год архив наберёт уволенных сотрудников; периодически
  захочется их hard-delete-ить, но именно у уволенных и есть
  максимум истории, которая блокирует hard-delete. Решение этого
  кейса — отдельная задача про долгосрочное хранение PII (см.
  потенциальный `recon` на retention/anonymization).

## 11. Объём работ (оценочно, без реализации)

- **Backend**:
  - Новый endpoint `GET /api/employees/:id/blockers` — preflight.
  - Новый endpoint `POST /api/employees/:id/archive` / `restore`,
    либо оставить через `PATCH active`. ~60-80 строк сервиса с
    проверкой блокеров и записью аудита.
  - Новый endpoint `DELETE /api/employees/:id` — preflight + один
    `prisma.employee.delete` в транзакции + аудит. ~80-100 строк.
  - Пары новых ошибок в `common/errors.ts` (`EMPLOYEE_HAS_OPEN_SHIFT`,
    `EMPLOYEE_HAS_OPEN_PASSPORTS`, `EMPLOYEE_HAS_HISTORY`,
    `EMPLOYEE_CANNOT_DELETE_SELF`, `EMPLOYEE_LAST_ADMIN`).
- **Shared DTO**: `EmployeeBlockerDto`, `EmployeeBlockersResponse`,
  `EmployeeArchiveBlockerDto`.
- **Frontend**:
  - Кнопка-меню `⋯` в строке таблицы +
    блок «Опасная зона» на `/admin/employees/[id]`.
  - Модалка hard-delete с подтверждением login.
  - Сообщения для blockers (`getArchiveBlockerLabel` /
    `getDeleteBlockerLabel`).
  - Server actions поверх новых endpoints.
- **Тесты**:
  - e2e: «архив с открытой сменой → 409», «архив без блокеров → 200»,
    «hard-delete карточки с историей → 409 + список», «hard-delete
    пустой карточки → 204», «удалить себя → 403», «удалить
    последнего ADMIN → 403», «удалить DISPLAY → каскад
    DisplayScreenConfig».

## 12. Ссылки

- [`prisma/schema.prisma`](../prisma/schema.prisma#L742-L904) — модель `Employee` со всеми back-relations
- [`apps/api/src/modules/employees/employees.service.ts`](../apps/api/src/modules/employees/employees.service.ts) — текущее управление сотрудниками (без удаления)
- [`apps/api/src/modules/employees/employees.controller.ts`](../apps/api/src/modules/employees/employees.controller.ts) — текущие endpoint'ы
- [`apps/web/app/admin/employees/page.tsx`](../apps/web/app/admin/employees/page.tsx) — таблица с вкладками «Активные» / «Архив»
- [`apps/web/app/admin/employees/actions.ts`](../apps/web/app/admin/employees/actions.ts) — server actions создания/правки
- [`apps/api/src/modules/audit/audit.service.ts`](../apps/api/src/modules/audit/audit.service.ts) — куда писать действия удаления
- ADR-0021 (`compensationType`) — почему в кодовой базе принято «не
  удалять, а гасить флагом» вместо hard-delete
