# Cutter Assistant Passport Release RECON

> Дата RECON: 2026-05-05. Связано с инцидентом «`CUTTER_ASSISTANT`
> не может выпустить паспорт» — ошибка 403 `FORBIDDEN_ROLE` на SSR
> страницы `/orders/[id]/passports/new`. Технический recon перед
> точечным фиксом. Код, Prisma, миграции, backend-сервисы и тесты в
> этом recon **не меняются** — единственный исключённый файл —
> сам `docs/cutter-assistant-passport-release-recon.md`.

## 1. Symptom

Помощник раскройщика (`Role.CUTTER_ASSISTANT`) на `/work` запускает
смену через QR оборудования и нажимает кнопку **«Выпустить паспорт»**.

Браузер навигирует на `/work/cut-orders` (упрощённый выбор заказа на
раскрое); если в `IN_PRODUCTION` ровно один заказ — `redirect`
автоматически уводит на `/orders/[id]/passports/new`. Эта страница
рендерится **server-side** (`export const dynamic = 'force-dynamic'`)
и падает.

UI получает generic Next.js production-error
**«server-side exception has occurred»**. В `docker logs` prod-web
лежат повторяющиеся записи:

```
n [Error]: У вашей роли нет доступа к этому действию.
    statusCode: 403,
    code: 'FORBIDDEN_ROLE',
    requestId: 'cba69ca0-114f-47f3-b14a-658e8d60cb86',
    digest: '3691132633'
    at l (/app/apps/web/.next/server/chunks/8636.js:1:23411)
    at process.processTicksAndRejections (...)
    at async h (/app/apps/web/.next/server/app/orders/[id]/passports/new/page.js:1:15128)
```

`async h(...)` в скомпилированном бандле — это server-component
`NewPassportPage` (`apps/web/app/orders/[id]/passports/new/page.tsx`).
Ошибка `code: 'FORBIDDEN_ROLE'` — это бросок глобального `AuthGuard`
в Nest API (`apps/api/src/modules/auth/auth.guard.ts`), доехавший
до Next через `apiFetch` → `ApiRequestError`. Сама ошибка не
перехвачена локально и пробрасывается из server-component, что Next
интерпретирует как 500 → generic «server-side exception».

Поведение воспроизводится 100% для роли `CUTTER_ASSISTANT` и не
воспроизводится для `CUTTER` / `SHOP_MANAGER` / `ADMIN`.

## 2. Route flow

```
[CUTTER_ASSISTANT] login
   |
   | middleware.ts: getDefaultRouteForRole('CUTTER_ASSISTANT') -> /work
   v
[/work]                           apps/web/app/work/page.tsx
   | shift not active -> SeamstressShiftStart (QR оборудования + операция)
   | shift active     -> <CutterAssistantWorkPanel />
   v
[CutterAssistantWorkPanel]        apps/web/app/work/active-shift-panel.tsx
   | button «Выпустить паспорт» -> <Link href="/work/cut-orders" />
   v
[/work/cut-orders]                apps/web/app/work/cut-orders/page.tsx
   | getCurrentUserOrNull()                       (cookie -> /api/auth/me)
   | listOrders({ status: 'IN_PRODUCTION', pageSize: 200 })
   | items.length === 1 -> redirect(`/orders/${items[0].id}/passports/new`)
   | items.length > 1   -> список карточек, каждая ведёт туда же
   v
[/orders/[id]/passports/new]      apps/web/app/orders/[id]/passports/new/page.tsx
   | getOrder(id)                                 (/api/orders/:id)
   | listOrderPassports(id)                       (/api/orders/:id/passports)
   | getCurrentUserOrNull()                       (повторно, для role-флагов)
   | listEmployees({ active: true, role: 'CUTTER' })  <- 403 FORBIDDEN_ROLE
   x throw, page crashes server-side
```

Backend-инварианты на каждом шаге уже выровнены под
`CUTTER_ASSISTANT`:

| Endpoint                                   | Allowed roles                                             | Источник                                                       |
| ------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/auth/me`                         | любой авторизованный                                      | `apps/api/src/modules/auth/auth.controller.ts`                 |
| `GET /api/orders` (фильтр `IN_PRODUCTION`) | `SHOP_MANAGER, ADMIN, CUTTER_ASSISTANT, SHOPFLOOR_MASTER` | `apps/api/src/modules/orders/orders.controller.ts`             |
| `GET /api/orders/:id`                      | `SHOP_MANAGER, ADMIN, CUTTER_ASSISTANT`                   | `apps/api/src/modules/orders/orders.controller.ts`             |
| `GET /api/orders/:id/passports`            | любая работающая роль (включая `CUTTER_ASSISTANT`)        | `apps/api/src/modules/passports/order-passports.controller.ts` |
| `GET /api/employees`                       | `SHOP_MANAGER, ADMIN`                                     | `apps/api/src/modules/employees/employees.controller.ts:43`    |

Все звенья кроме последнего пропускают `CUTTER_ASSISTANT`. Сбой
ровно один — на `GET /api/employees`.

## 3. Failing API call

### 3.1 Где вызывается

`apps/web/app/orders/[id]/passports/new/page.tsx`:

```ts
import { listEmployees } from '@/lib/employees-api';
// ...
const cutterEmployees = isCutter
  ? []
  : await listEmployees({ active: true, role: 'CUTTER' });
const cutterOptions = cutterEmployees.map((e) => ({
  id: e.id,
  fullName: e.fullName,
  login: e.login,
}));
```

`isCutter = me?.user.role === 'CUTTER'`. Для `CUTTER_ASSISTANT`
условие `isCutter` ложно, поэтому SSR безусловно дёргает
`listEmployees(...)`.

### 3.2 Что делает helper

`apps/web/lib/employees-api.ts`:

```ts
export function listEmployees(
  query: Partial<ListEmployeesQuery> = {},
): Promise<EmployeeListItemDto[]> {
  return apiFetch<EmployeeListItemDto[]>('/employees', {
    searchParams: {
      active: query.active === undefined ? undefined : query.active ? 'true' : 'false',
      role: query.role,
      compensationType: query.compensationType,
      search: query.search,
      companyDivisionId: query.companyDivisionId,
    },
  });
}
```

То есть SSR делает `GET /api/employees?active=true&role=CUTTER`.

### 3.3 Что делает backend

`apps/api/src/modules/employees/employees.controller.ts`:

```ts
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('employees')
export class EmployeesController {
  // ...
  @Get()
  list(
    @Query(new ZodValidationPipe(ListEmployeesQuerySchema)) query: ListEmployeesQuery,
  ) {
    return this.employees.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) { /* ... */ }

  @Patch(':id')
  update(/* ... */) { /* ... */ }
  // ...
}
```

`@Roles(...)` стоит на классе и каскадируется на все методы кроме
тех, что переопределены `@Public()` (это только `:id/print` и
`:id/qr`). Глобальный `AuthGuard` в `auth.guard.ts` через
`reflector.getAllAndOverride(ROLES_KEY, [handler, class])`
вытаскивает массив `['SHOP_MANAGER', 'ADMIN']`, проверяет:

```ts
if (principal.role !== 'ADMIN' && !required.includes(principal.role)) {
  throw new ForbiddenException({
    statusCode: 403,
    code: 'FORBIDDEN_ROLE',
    message: 'У вашей роли нет доступа к этому действию.',
  });
}
```

Для `CUTTER_ASSISTANT` это и есть `403 FORBIDDEN_ROLE` из лога.

## 4. RBAC root cause

Почему широкий `GET /api/employees` нельзя просто открыть
`CUTTER_ASSISTANT`:

1. **Утечка payroll-полей.** `EmployeeListItemDto`
   (`packages/shared/src/employees.ts:329`) содержит
   `salaryPerShift`, `compensationType` и
   `companyDivision { id, code, name }`. Это управленческие данные
   ADR-0021 — рабочие роли видят только себя через
   `/api/auth/me`. Открытие endpoint-а помощнику раскройщика
   разнесёт ставки/тип оплаты по всему цеху.
2. **Утечка списка ролей.** Без `?role=` фильтра helper можно
   позвать как `GET /api/employees?active=true`, и в ответе
   придут все сотрудники с их ролями. Это даёт помощнику
   раскройщика снимок organisational chart — не то, что нужно
   для кнопки «выпустить паспорт».
3. **Помощник раскройщика не равен менеджеру.** `CUTTER_ASSISTANT`
   намеренно исключён из `canSeeOrdersMenu` в
   `apps/web/lib/rbac.ts`: у него остался **технический**
   read-доступ к карточке заказа исключительно ради формы
   выпуска паспорта (`canSeeOrders('CUTTER_ASSISTANT') = true`,
   `canSeeOrdersMenu('CUTTER_ASSISTANT') = false`). Та же модель
   нужна и для cutter-справочника: даём узкое чтение, не расширяя
   класс RBAC.
4. **Стабильность POST/PATCH.** `EmployeesController` обслуживает
   POST/PATCH/`@Get(':id')` — это admin-only по самой сути
   (создание сотрудников, правка ставок). Менять `@Roles(...)`
   на классе нельзя, иначе придётся точечно восстанавливать
   декораторы на каждом методе. Любая ошибка в этой расстановке
   = silent privilege escalation на pilot-инсталляции.

Зачем select раскройщика вообще нужен `CUTTER_ASSISTANT` — это
требование PHASE 2 STEP 3 «Cutter attribution» (`docs/api.md §24a`).
Backend `PassportsService.create()` требует явный `dto.cutterId`,
если creator имеет роль не равную `CUTTER`, иначе бросает
`CUTTER_REQUIRED`. То есть UI обязан показать select; пустой select
= UX тупик.

## 5. Safe fix

### 5.1 Узкий read-only endpoint

```
GET /api/employees/cutters
```

| Аспект          | Значение                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| RBAC            | `@Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')` (метод-уровень, переопределяет класс)                                         |
| Фильтр          | hard-coded на уровне сервиса: `role = CUTTER` AND `active = true` (не из query)                                                     |
| Сортировка      | `fullName ASC` (UI-дропдаун в алфавитном порядке)                                                                                   |
| Ответ           | `ActiveCutterListItemDto[]`, поля только `{ id, fullName, login }`                                                                  |
| Идемпотентность | GET, кэширование на агрессивном уровне не нужно — список меняется редко                                                              |
| Side-effects    | нет (read-only)                                                                                                                     |

### 5.2 Декларация маршрута

В `EmployeesController` объявить **до** `@Get(':id')`, иначе Nest
распарсит литерал `cutters` как параметр `:id` и улетит в
`get(id = 'cutters')` → `EMPLOYEE_NOT_FOUND`. Существующий порядок
методов в файле — `@Get()`, `@Post()`, `@Get(':id')`,
`@Patch(':id')`, `@Public() @Get(':id/print')`,
`@Public() @Get(':id/qr')`. Новый метод — после `@Post()` и
**перед** `@Get(':id')`.

### 5.3 Сервисный метод

В `EmployeesService` — отдельный метод `listActiveCutters()`, не
использует существующий `list(query)`. Причина — фиксировать на
уровне сервиса проекцию (`select: { id, fullName, login }`), чтобы
случайный рефактор `EmployeeListItemDto` не пробросил payroll-поля
в этот endpoint.

### 5.4 Shared DTO

Новый интерфейс в `packages/shared/src/employees.ts`:

```ts
export interface ActiveCutterListItemDto {
  id: string;
  fullName: string;
  login: string;
}
```

**Не наследовать** от `EmployeeListItemDto` — иначе при добавлении
новых полей в широкий DTO они автоматически утекут в этот узкий.

### 5.5 Frontend-обёртка

`apps/web/lib/employees-api.ts`:

```ts
export function listActiveCutters(): Promise<ActiveCutterListItemDto[]> {
  return apiFetch<ActiveCutterListItemDto[]>('/employees/cutters');
}
```

И замена в `apps/web/app/orders/[id]/passports/new/page.tsx`:

```ts
const cutterOptions = isCutter ? [] : await listActiveCutters();
```

`cutterOptions.map(...)` исчезает — формат уже совпадает с
`CutterOption` (`new-passport-form.tsx`).

### 5.6 Тесты-щиты

В `tests/smoke/employees-admin.smoke.test.ts` дописать regress-блок,
фиксирующий ровно эту регрессию:

- `GET /employees/cutters` объявлен **до** `@Get(':id')`;
- `@Roles(...)` на методе включает `CUTTER_ASSISTANT`;
- сервис возвращает только `id/fullName/login` (`select` в
  Prisma-запросе);
- страница `/orders/[id]/passports/new` дёргает `listActiveCutters`
  и **не** дёргает `listEmployees`.

Полноценный integration-тест на права (login as CUTTER_ASSISTANT
→ 200, login as SEAMSTRESS → 403, login as ADMIN → 200, нет
payroll-полей в ответе) — желателен, но необязателен для MVP-фикса.

### 5.7 Документация

Дополнительно — одна строка в `docs/api.md` после
`GET /api/employees`:

```
| GET   | /api/employees/cutters     | CUTTER_ASSISTANT, SHOP_MANAGER, ADMIN | Узкий справочник активных раскройщиков для select-а на форме выпуска паспорта. Возвращает только { id, fullName, login }, не отдаёт payroll-поля. |
```

Это требуется `npm run docs:check` (`[docs:api]`-чек проверяет, что
каждый Nest-маршрут попадает в `docs/api.md`).

### 5.8 Что НЕ делаем

- **Не меняем** `@Roles(...)` на классе `EmployeesController` —
  POST/PATCH/`@Get(':id')` остаются `SHOP_MANAGER, ADMIN`.
- **Не расширяем** `ListEmployeesQuery` ещё одним фильтром —
  отдельный endpoint надёжнее, чем поведенческое разветвление
  внутри широкого `GET /employees`.
- **Не меняем** `EmployeeListItemDto` — это публичный DTO,
  модификация ломает админ-страницы (`/admin/employees`,
  `/admin/payroll/*`), которые читают `salaryPerShift`,
  `compensationType`.
- **Не открываем** маршрут `Public()` — без сессии нельзя; иначе
  pilot-инсталляция отдаст список сотрудников любому поисковому
  боту.

## 6. Data exposure

Endpoint `GET /api/employees/cutters` **обязан** возвращать только:

| Поле       | Тип    | Источник            | Зачем                                                     |
| ---------- | ------ | ------------------- | --------------------------------------------------------- |
| `id`       | string | `Employee.id`       | Подставляется в форму как `cutterId`                      |
| `fullName` | string | `Employee.fullName` | Отображается в `<option>`                                 |
| `login`    | string | `Employee.login`    | Помогает различать тёзок (как в `({login})` в текущем UI) |

И **обязан НЕ возвращать** ни в одной форме:

| Поле                                                                                  | Где живёт                                  | Почему нельзя                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `pinHash`                                                                             | `Employee.pinHash`                         | Bcrypt-хэш PIN-а; никогда не уходит наружу никаким endpoint-ом                                                 |
| `salaryPerShift`                                                                      | `Employee.salaryPerShift Decimal?`         | Управленческая ставка (ADR-0021)                                                                               |
| `compensationType`                                                                    | `Employee.compensationType`                | Управленческое поле, payroll-схема                                                                             |
| `cutterB2bSewingPercent`                                                              | `Employee.cutterB2bSewingPercent Decimal?` | B2B-процент закройщика (`docs/payroll-cutter-compensation-recon.md`)                                           |
| `companyDivisionId` / `companyDivision`                                               | `Employee.companyDivision`                 | Админ-фильтр PHASE 2 STEP 2; помощнику не нужно                                                                |
| `role`                                                                                | `Employee.role`                            | По смыслу избыточно (ответ уже фильтрует `role = CUTTER`); добавлять — расширять surface зря                   |
| `active`                                                                              | `Employee.active`                          | Уже фильтруется на сервере (`active = true`); нет смысла отдавать наружу                                       |
| `createdAt`                                                                           | `Employee.createdAt`                       | Управленческое поле (карточка сотрудника)                                                                      |
| `phone` / `passport data` / любые персональные данные                                 | сейчас в схеме `Employee` отсутствуют      | Если когда-то появятся — не должны подключаться автоматически. Защита — `select` на сервисе, а не `omit`.      |
| любые поля payroll (`SalaryEntry`, `OperationEntry`, `PayrollPeriod`, `PayrollPayout`) | отдельные модели                           | Ничего из payroll-цепочки никаким способом не должно подмешиваться в этот endpoint.                            |

Источник истины — `Employee` в `prisma/schema.prisma`. Использовать
`prisma.employee.findMany({ select: { id, fullName, login } })`, а
не `findMany({ where, include: ... })` — `select` исключает все
остальные поля автоматически.

## 7. Regression risks

1. **Payroll-поля случайно протекут.** Если разработчик в
   `EmployeesService.listActiveCutters()` напишет
   `findMany({ where, include: ... })` или вернёт `toListDto(...)`,
   ответ автоматически приобретёт `salaryPerShift` /
   `compensationType`. Защита — phys.-`select` в сервисе и
   smoke-тест, который проверяет
   `select: { id: true, fullName: true, login: true }`.
2. **Сломаем общий admin `/api/employees`.** Существующие
   admin-страницы (`/admin/employees`, `/admin/payroll/*`,
   `/admin/payroll/payouts/*`) опираются на `listEmployees(...)`
   и ждут `EmployeeListItemDto`. Любое изменение `@Roles(...)` на
   классе — высокий шанс сломать админ-pipeline. Защита — новый
   метод никогда не трогает класс-уровень `@Roles(...)`, только
   вешает свой через `@Roles(...)` непосредственно на
   `@Get('cutters')`.
3. **Объявим `@Get('cutters')` ниже `@Get(':id')`.** Тогда Nest при
   обращении к `/employees/cutters` пойдёт в `get(':id')` с
   `id = 'cutters'`, бросит `EMPLOYEE_NOT_FOUND`, фронт получит
   404 вместо успеха, и в логах будет неочевидный «нет такого
   сотрудника» вместо «cutters route не зарегистрирован». Защита
   — smoke-assertion на порядок объявления (см. §5.6).
4. **Починим только frontend, оставив backend 403.** Если кто-то
   попытается «починить» только client-helper (заменив URL без
   изменения backend), endpoint всё равно отдаст 403 и страница
   снова крашнется с тем же symptom-ом. Защита — RECON фиксирует,
   что фикс одновременно затрагивает API + DTO + helper + page;
   PR должен включать все четыре.
5. **На странице `/orders/[id]/passports/new` есть **другие**
   admin-only вызовы.** Пройденный inventory:
   - `getOrder(id)` — `apps/web/lib/orders-api.ts` →
     `GET /api/orders/:id`. RBAC включает `CUTTER_ASSISTANT`
     (см. `OrdersController`). OK.
   - `listOrderPassports(id)` — `apps/web/lib/passports-api.ts` →
     `GET /api/orders/:id/passports`. Контроллер
     `OrderPassportsController` без класс-уровневого `@Roles(...)`,
     открыт любой авторизованной роли. OK.
   - `getCurrentUserOrNull()` — `/api/auth/me`, любая роль. OK.
   - `listEmployees(...)` — **проблемный**, см. §3. FAIL.
   Других admin-only вызовов на странице на момент RECON нет.
6. **Авто-редирект `/work/cut-orders` при ровно одном заказе.**
   Авто-редирект происходит до загрузки employees — поэтому при
   текущем баге ошибка возникает уже на следующем экране, и
   пользователю кажется, что «упало после нажатия кнопки». Это
   сбивает с толку, но фикс на данной странице автоматически
   решает и UX-симптом.
7. **CUTTER_ASSISTANT не имеет активных раскройщиков в БД.**
   Endpoint вернёт `[]`, фронт уже показывает блок «Нет активных
   сотрудников с ролью раскройщика. Заведите раскройщика в
   /admin/employees или активируйте существующего — без этого
   backend не сможет записать сдельное начисление за раскрой
   (CUTTER_REQUIRED).» (см.
   `apps/web/app/orders/[id]/passports/new/new-passport-form.tsx`
   ветка `noActiveCutters`). Поведение корректное; backend всё
   равно бросит `CUTTER_REQUIRED` при попытке отправить форму
   без `cutterId`, что и есть источник истины.
8. **Production-сборка кэширует старый код.** В prod-логах в
   `n [Error]: ...` уже минифицированный бандл; после релиза
   фикса нужно
   `docker compose -f docker-compose.prod.yml up -d --build api web`
   (или эквивалентный deploy-скрипт). Без пересборки контейнеров
   фикс не доедет до пользователя. Базы и миграций фикс не
   трогает.

## 8. Sub-issue: drift лейбла роли «Помощник закройщика»

Этот пункт пользователь прислал в одном письме с основным багом —
он не приводит к 500-й ошибке, но это видимый visual drift и его
нужно починить тем же PR-ом.

### 8.1 Symptom

На `/work` для `CUTTER_ASSISTANT` шапка `RoleHeaderCard` показывает
**«Помощник закройщика»**. Должно быть **«Помощник раскройщика»** —
именно это название использует админка при создании сотрудника
(`/admin/employees/new`), и именно это название знает остальной
проект (`apps/web/lib/admin-labels.ts`,
`apps/web/app/admin/employees/create-form.tsx`,
`tests/smoke/frontend-rbac.smoke.test.ts`, JSDoc-комментарии в
`apps/api/src/modules/passports/passports.service.ts` и т.д.).

### 8.2 Где живёт опечатка

```
apps/web/app/work/page.tsx:32
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник закройщика',  <- drift
  SEAMSTRESS: 'Швея',
};
```

«Закройщик» — устаревшая форма «раскройщик». В остальной системе
используется «раскройщик»:

| Файл                                              | Лейбл                          |
| ------------------------------------------------- | ------------------------------ |
| `apps/web/lib/admin-labels.ts:37`                 | `'Помощник раскройщика'`       |
| `apps/web/app/admin/employees/create-form.tsx:29` | `'Помощник раскройщика'`       |
| `apps/web/app/work/page.tsx:36` (это место)       | `'Помощник закройщика'` (drift) |

Локальные `ROLE_LABELS` в `apps/web/app/qc/page.tsx`,
`apps/web/app/wto/page.tsx`, `apps/web/app/packing/page.tsx`
помощника раскройщика **не содержат** (он туда не приходит) —
поэтому drift только в одном файле.

### 8.3 Safe fix

Минимальный фикс — заменить строку в `apps/web/app/work/page.tsx:36`
на `'Помощник раскройщика'`. Источником истины должен быть
канонический словарь `apps/web/lib/admin-labels.ts::ROLE_LABELS`
(он покрывает все 9 ролей, включая
`IRONING`/`PACKING`/`QC`/`SHOPFLOOR_MASTER`, для которых на `/work`
лейбл и так не показывается из-за SSR-redirect-а в их primary
workspace).

Идеальный фикс — заменить локальный `ROLE_LABELS` в
`apps/web/app/work/page.tsx` на `formatRole(role)` из
`@/lib/admin-labels`, чтобы будущие drift-ы попросту не получались.
Но это уже не «исправление опечатки», а small refactor; можно
сделать тем же PR-ом, можно оставить как follow-up. RECON фиксирует
обе опции; выбор — за реализацией.

### 8.4 Defensive smoke

Дописать в `tests/smoke/frontend-rbac.smoke.test.ts` (где уже живут
assertions про `/work` и `CUTTER_ASSISTANT`):

```ts
test('/work лейбл CUTTER_ASSISTANT соответствует канону admin-labels', () => {
  const src = readSrc('apps/web/app/work/page.tsx');
  const labelsBlock = src.slice(
    src.indexOf('const ROLE_LABELS'),
    src.indexOf('};', src.indexOf('const ROLE_LABELS')),
  );
  expect(labelsBlock).toMatch(/CUTTER_ASSISTANT:\s*'Помощник раскройщика'/);
  expect(labelsBlock).not.toMatch(/закройщик/);
});
```

Это превращает «опечатку» в зафиксированный инвариант — следующая
случайная замена обратно ловится в CI.

### 8.5 Out of scope для §8

JSDoc-комментарии в `packages/shared/src/employees.ts` и
`apps/api/src/modules/employees/employees.service.ts` про
«B2B-процент закройщика» — это другая сущность
(`Employee.cutterB2bSewingPercent`), там «закройщик» используется
намеренно как короткое имя поля и из исторического
`docs/payroll-cutter-compensation-recon.md`. Эти комментарии RECON
**не трогает**.

## 9. Out of scope

- Сам фикс кода (controller / service / DTO / helper / page /
  smoke). Этот RECON — техническое описание, без изменений
  исходников.
- `OrderPassportsController.list` и его допуски — RBAC уже
  корректен (см. §2).
- ADR-0014 / ADR-0021 — обоснование общего класс-уровневого
  `@Roles('SHOP_MANAGER', 'ADMIN')` на `EmployeesController`
  остаётся в силе, RECON его не пересматривает.
- Refactor локальных `ROLE_LABELS` в `/qc/page.tsx`,
  `/wto/page.tsx`, `/packing/page.tsx` к одному источнику истины
  — отдельная задача (`docs/auth-design-cleanup-recon.md` уже
  предлагает централизовать post-login UI).

## 10. Implementation checklist (для будущего PR)

После принятия RECON — реализовывать одним PR-ом, фиксы §5 и §8
не разрывать (один источник симптома — пользователь увидел оба за
один сеанс):

- [ ] `packages/shared/src/employees.ts` → новый
      `ActiveCutterListItemDto` (без наследования).
- [ ] `apps/api/src/modules/employees/employees.service.ts` →
      `listActiveCutters()` с `select: { id, fullName, login }`.
- [ ] `apps/api/src/modules/employees/employees.controller.ts` →
      `@Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')`
      `@Get('cutters')` **до** `@Get(':id')`.
- [ ] `apps/web/lib/employees-api.ts` → `listActiveCutters()`.
- [ ] `apps/web/app/orders/[id]/passports/new/page.tsx` →
      `listActiveCutters()` вместо `listEmployees(...)`.
- [ ] `apps/web/app/work/page.tsx` → исправить
      `'Помощник закройщика'` → `'Помощник раскройщика'`
      (или заменить локальный `ROLE_LABELS` на `formatRole(role)`).
- [ ] `tests/smoke/employees-admin.smoke.test.ts` — regress-блок
      §5.6.
- [ ] `tests/smoke/frontend-rbac.smoke.test.ts` — assertion §8.4.
- [ ] `docs/api.md` — строка для `GET /api/employees/cutters`
      (требование `[docs:api]`-чека).
- [ ] Deploy:
      `docker compose -f docker-compose.prod.yml up -d --build api web`,
      smoke на prod (`CUTTER_ASSISTANT` логин → /work → выпуск
      паспорта по тестовому заказу).

## 11. Follow-up: «выпустил паспорт, нажал распечатать → новая вкладка вместо реальной печати»

> Дата: 2026-05-05 (тот же сеанс, после деплоя §1–§10).

### 11.1 Симптом

Помощник раскройщика на проде проходит §1–§10 успешно — паспорт
выпускается. На посткарточке `CutterAssistantSuccessCard` жмёт
«Распечатать паспорт» — открывается новая вкладка с HTML-документом,
а реальный TSC TE200 не печатает. Пользователь:

> «создается задача на печать и дальше не печатается. Предполагается,
> что при нажатии на распечатать документ документ для печати
> отправится на печать без дополнительных переходов в окно браузера
> с документом».

### 11.2 Что происходит на самом деле

1. `PrintButton` (`apps/web/components/print-button.tsx`) делает
   `POST /api/print-jobs { sourceType: 'PASSPORT_PRINT', sourceId }`.
2. `PrintJobsService.resolvePrinter` для `CUTTER_ASSISTANT`:
   — ищет `Printer { role: CUTTER_ASSISTANT, isActive: true }` →
   нет (на проде заведён один принтер `Passport`, `role=CUTTER`,
   `equipmentId=null`);
   — fallback по `equipmentId` активной смены: смена помощника
   сидит на `cutting-table-01`, но у принтера `equipmentId=null` →
   нет;
   — бросает `409 PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`.
3. `PrintButton` распознаёт код как «нет принтера» и открывает
   `fallbackHref` (`/api/passports/:id/print`) в новой вкладке.

В БД ровно ноль `PrintJob` со `sourceType='PASSPORT_PRINT'` —
до `prisma.printJob.create` дело не доходит. В логах
`sewing-prod-api-1` подряд `WARN POST /api/print-jobs → 409
PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT` на каждый клик.

### 11.3 Корневая причина

`Printer.role` хранит ровно одну роль, а помощник раскройщика
физически работает за тем же раскройным столом и должен печатать
на тот же принтер, что и сам раскройщик. Отдельный
`role=CUTTER_ASSISTANT` принтер заводить бессмысленно (одна
физическая железяка), а equipment-fallback здесь не срабатывает,
потому что менеджер привязал принтер по новой схеме (`role=CUTTER`),
а не по старой (`equipmentId=cutting-table-01`).

### 11.4 Решение (реализовано)

Helper-роли явно делят принтер с основной ролью через карту
`PRINTER_ROLE_FALLBACKS`
(`apps/api/src/modules/printers/printer-role-resolution.ts`).
`PrintJobsService.resolvePrinter` перебирает кандидатов из
`resolveCandidateRoles(employee.role)` (своя роль + fallback'и) и
берёт первый активный принтер. На MVP единственный fallback —
`CUTTER_ASSISTANT → CUTTER`. Контракт ошибок не меняется,
fallback в браузер у `PrintButton` остаётся как страховка для
рабочих мест без агента.

После фикса:

- помощник раскройщика жмёт «Распечатать паспорт» → backend
  находит принтер `Passport` (role=CUTTER) → создаёт
  `PrintJob { sourceType: 'PASSPORT_PRINT', status: PENDING }` →
  агент `DESKTOP-IQ7EFMT` подхватывает job FIFO-ом, печатает на
  `TSC TE200` через Chrome `--kiosk-printing` → PATCH PRINTED;
- никакой новой вкладки в браузере — UI показывает только
  «Отправлено на принтер рабочего места.».

### 11.5 Implementation checklist (выполнено)

- [x] `apps/api/src/modules/printers/printer-role-resolution.ts` —
      `PRINTER_ROLE_FALLBACKS` (`CUTTER_ASSISTANT → CUTTER`) +
      `resolveCandidateRoles`.
- [x] `apps/api/src/modules/printers/print-jobs.service.ts` —
      `resolvePrinter` перебирает `resolveCandidateRoles(role)`.
- [x] `tests/smoke/print-jobs-role-fallback.smoke.test.ts` —
      smoke-щит на маппинг и use-в-сервисе.
- [x] `tests/integration/cutter-assistant-shift.test.ts` —
      integration-кейс «принтер role=CUTTER, помощник печатает
      без активной смены через fallback».
- [x] `docs/domain.md §14.2` — описание role-fallback.
- [x] Deploy: `docker compose -f docker-compose.prod.yml up -d
      --build api`, smoke на проде (выпуск паспорта помощником,
      кнопка «Распечатать паспорт» создаёт PASSPORT_PRINT job,
      агент закрывает его в PRINTED).
