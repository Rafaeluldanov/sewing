# ADR-0021. Дневной оклад от факта смены (`SalaryEntry`)

- Статус: Принято
- Дата: 2026-04
- Контекст: пост-ADR-0020, расширение зарплатного контура на окладные роли

---

## 1. Контекст

До этого момента зарплатный контур MVP жил только в `OperationEntry`
(см. ADR-0005, ADR-0012, ADR-0020):

- сдельные начисления раскройщика (`CUT_CUT`, `IMMEDIATE`) и пошива
  (`BY_SIZE`, `AFTER_RELEASE`) создаются в pipeline скана/выпуска;
- окладные роли (`QC`, `IRONING`, `PACKING`, `CUTTER_ASSISTANT`)
  никаких `OperationEntry` не получают; ADR-0005 явно отложил их
  расчёт «на следующий шаг».

Реальная нагрузка пилота показала:

- начальник производства не может выплатить ОТК/ВТО/упаковщикам ничего
  системного — каждое начисление считается «ручкой» в Excel;
- если сотрудник забыл нажать «Закончить смену», `shift.stop` так и не
  случается — поэтому привязывать оплату только к закрытию смены
  опасно, день останется неоплаченным;
- полноценный месячный payroll, учёт часов, half-day, отпуск/больничный
  на этом этапе строить рано: бизнес-правила ещё не устаканились,
  нужен «костыль, который не сломаем потом».

Нужна минимальная, но рабочая модель: «была смена в день → платим
ставку за день», с возможностью менеджеру руками поправить сумму.

---

## 2. Решение

Вводим **отдельную таблицу `SalaryEntry`** для окладных начислений
«за день, в который у сотрудника была смена». Это не ветвь
`OperationEntry`, а параллельная сущность — у двух моделей разная
семантика (сделка по операции vs. факт явки) и разный жизненный цикл.

### 2.1. Расширение `Employee`

```
Employee.compensationType  CompensationType  default PIECEWORK
Employee.salaryPerShift    Decimal(12,2)?    // обязателен для SALARY/MIXED
```

`enum CompensationType { PIECEWORK | SALARY | MIXED }` — единственная
ось «как платим». На момент принятия этого ADR в схеме параллельно
жил `Employee.paymentType` (источник истины для сдельщины), но
последующая пост-задача его удалила (миграция
`20260429100000_remove_payment_type`): теперь `compensationType`
одновременно гейтит и сдельный контур (`PIECEWORK`/`MIXED` ⇒
`OperationEntry`, `SALARY` ⇒ silent skip), и окладной (`SALARY`/`MIXED`
⇒ `SalaryEntry`, `PIECEWORK` ⇒ skip). `MIXED` означает «сотрудник
получает и оклад за день, и сдельные `OperationEntry` параллельно» —
кейс мастера-помощника, который иногда сам встаёт на оверлок.

После пост-задачи cleanup-а эти три ветки выражены в коде ровно тремя
pure-функциями `apps/api/src/modules/employees/compensation.ts`:

- `isPieceworkEligible(type)` — `true` для `PIECEWORK`/`MIXED`, gate
  для `EarningsService` перед созданием `OperationEntry`;
- `isSalaryEligible(type)` — `true` для `SALARY`/`MIXED`, gate для
  `SalaryService.syncDailySalary`, `CostsService.minuteRate`,
  `DashboardService` (role load / idle);
- `requiresSalaryRate(type)` — тождествен `isSalaryEligible`,
  используется `EmployeesService.create/update` как guard перед
  бросанием `EMPLOYEE_SALARY_RATE_REQUIRED`.

Никаких прямых сравнений `compensationType === 'SALARY'` /
`=== 'PIECEWORK'` в `*.service.ts` нет — это сознательно, чтобы при
будущем расширении модели (например, появлении `SALARY` без часовой
ставки) изменить семантику можно было ровно в одном файле.

Инвариант сервиса (`EmployeesService.update`):
`requiresSalaryRate(compensationType)` ⇒ `salaryPerShift` обязателен и
`> 0`. Бизнес-ошибка `EMPLOYEE_SALARY_RATE_REQUIRED` (422).

### 2.2. Сущность `SalaryEntry`

```
SalaryEntry {
  id, employeeId,
  date           Postgres DATE,        // ровно одна запись в день
  amount         Decimal(12,2),
  source         SalaryEntrySource     // SHIFT_DAY | MANUAL
                                       // (на MVP пишем только SHIFT_DAY;
                                       //  MANUAL зарезервирован под
                                       //  будущие «ручные» дни)
  editedManually Boolean default false,
  managerComment Text?,
  editedByEmployeeId String?,          // FK→Employee, кто правил
  createdAt, updatedAt
}

UNIQUE (employeeId, date, source)      // один день — одна запись
INDEX  (employeeId, date), (date)
```

«Один день — одна окладная запись на сотрудника» — это уникальный
индекс на `(employeeId, date, source)`. Параллельные `start shift`
конкурентно встают на этом индексе и `P2002` трактуется как no-op
(`SalaryService.syncDailySalary` ловит и перечитывает запись).

Сумма — `amount`, а не отдельные `quantity * rate`: на MVP ставка
плоская «оклад за смену». Когда понадобится half-day/coefficient/часы,
это станет либо новым `source`, либо дополнительными полями — текущая
структура не запирает себя в одну формулу.

### 2.3. Auto-sync: `SalaryService.syncDailySalary`

Источник истины «день отработан» — наличие хотя бы одной
`ShiftSession` с `startedAt::date == date`. Длительность смены и факт
её закрытия не учитываются: открытая смена тоже считается рабочим
днём (см. §1, кейс «забыл нажать стоп»).

Алгоритм:

1. Загружаем `Employee.compensationType` + `salaryPerShift`. Если
   `!isSalaryEligible(compensationType)` (т.е. `PIECEWORK`) или
   сотрудник неактивен — выходим.
2. Считаем количество `ShiftSession` за этот день. Если 0 — выходим
   (аномальный кейс: вызвали без смены).
3. Если `salaryPerShift = null` — выходим. Это аномалия (инвариант
   запрещает SALARY/MIXED без ставки), но ронять `start/stop shift`
   из-за этого нельзя.
4. `upsert` по `(employeeId, date, source = SHIFT_DAY)`:
   - если запись существует и `editedManually = true` — ничего не
     трогаем. Менеджер сказал «ушёл раньше → 1500», и автоматика
     не имеет права выкатить обратно 3000;
   - если запись существует и `editedManually = false` — обновляем
     `amount = salaryPerShift` (ставка могла поменяться);
   - если записи нет — создаём с `amount = salaryPerShift` и
     `source = SHIFT_DAY`.

Точки вызова: `ShiftsService.start` и `ShiftsService.stop`. Обёрнут
`safeSyncSalary`-логером: любая ошибка sync-а **не** ронит сам
`start/stop shift`. Бизнес-приоритет — продолжить работу, оклад
синхронизируется на следующем событии.

### 2.4. Ручная корректировка

`PATCH /api/salary/:id` (роли `SHOP_MANAGER` / `ADMIN`):

- `amount` (опц.) — новая сумма (≥ 0, до `Decimal(12,2)`);
- `managerComment` (опц., `null` = очистить) — короткий комментарий
  («переработка», «полсмены», «ушёл раньше»);
- `reset = true` — снять ручную правку, вернуть запись под
  `syncDailySalary` и выставить `amount = employee.salaryPerShift`.
  Если ставка не задана — `SALARY_RATE_MISSING` (422).

Любая ручная правка ставит `editedManually = true` и
`editedByEmployeeId = viewer.employeeId`. `employeeId`, `date` и
`source` намеренно не редактируются — иначе ручная правка могла бы
перенести оплату на чужой день/чужого человека и сломать инвариант
«один день — одна запись». Этих полей нет в `UpdateSalaryEntrySchema`.

### 2.5. RBAC

- `GET /api/salary`, `GET /api/salary/summary` — открыты любой
  авторизованной роли, но `SalaryService` принудительно сужает
  данные: не-менеджер всегда видит только `employeeId = viewer.employeeId`.
  Любые `employeeId` в query от обычного сотрудника игнорируются.
- `PATCH /api/salary/:id` — `SHOP_MANAGER` / `ADMIN` (двойная
  защита: `@Roles(...)` + проверка в сервисе).
- `GET /api/employees`, `GET /api/employees/:id`,
  `PATCH /api/employees/:id` — целиком `SHOP_MANAGER` / `ADMIN`.
  Информация о сотрудниках (логин, ставка, тип оплаты) чувствительна;
  обычный сотрудник видит только себя через `/api/auth/me`.

Список менеджерских ролей — `SALARY_MANAGER_ROLES` в
`apps/api/src/modules/salary/salary.constants.ts` (зеркало
`EARNINGS_MANAGER_ROLES`).

---

## 3. Что сознательно не делаем (scope)

Это «практичная временная модель», не финальный payroll. **Намеренно**
не делаем:

- расчёт часов, half-day, коэффициенты загрузки;
- автозакрытие смены по таймауту неактивности;
- месячный payroll по календарю/норме часов;
- отпуска/больничные/командировки;
- удержания за брак для окладных ролей;
- интеграцию с 1С/ЗУП и экспорт в Excel;
- историю изменений `amount` (есть только последний `editedBy`).

Отдельный `source = MANUAL` зарезервирован под кейс «менеджер
оплачивает день, в который смены физически не было» — на MVP не
используется, но контракт уже знает это значение.

---

## 4. Альтернативы

### 4.1. Расширить `OperationEntry`, добавить `EarningsKind = SHIFT_SALARY`

Идея: одна таблица для всех начислений, дискриминатор — поле kind.

Минусы:

- ломает уникальный индекс `OperationEntry_idem` (он завязан на
  `(passportId, operationId, employeeId, sourceEventType)`, у
  окладной записи нет ни `passportId`, ни `operationId`);
- поля `qty`/`ratePerUnit`/`approvalMode`/`sourceEventType` для
  окладного начисления бессмысленны и заставляют писать `null`
  везде — теряется смысл унификации;
- придётся аккуратно «прятать» окладные записи от уже существующих
  выборок `EarningsService` и от UI `/earnings` блока «Сдельные» —
  риск тонких регрессий.

### 4.2. Считать на лету (`computeMonthlySalary`)

Идея: ничего не хранить, при запросе агрегата считать «сколько было
дней со сменой × ставка».

Минусы:

- ручная правка некуда сохранять: пришлось бы отдельную «таблицу
  поправок», что эквивалентно `SalaryEntry`, только сложнее;
- нельзя дешёво показать «оклад за конкретный день в общем списке
  начислений» — каждый запрос придётся пересчитывать;
- разрыв с UX: менеджер хочет видеть «начисления по дням», а не
  «итог за месяц».

### 4.3. Реализовать сразу часы и half-day

Идея: записывать `hours`, `halfDay`, считать по формуле.

Минусы:

- бизнес-правила пилота про часы ещё не устаканились;
- требует автозакрытия смены и трекинга простоев — в текущем
  пилоте этого нет;
- нарушает принцип «минимальная модель, не запирающая будущее»:
  можно добавить позже расширением `SalaryEntry` без миграции
  бизнес-смысла.

---

## 5. Последствия

- Окладные роли получают системные начисления; начальник производства
  больше не считает их в Excel.
- Сдельный контур (`OperationEntry`, ADR-0005/0012/0020) **не
  меняется**, все 261 интеграционный/smoke тест зелёные.
- Ручная правка живёт в `editedManually` + `managerComment` +
  `editedByEmployeeId` — этого достаточно для аудита «кто и почему».
- Существующие сотрудники после миграции получают
  `compensationType = PIECEWORK` (default), `salaryPerShift = NULL`
  — менеджер сам переводит ОТК/ВТО/упаковку/помощника раскройщика
  на `SALARY` через `/admin/employees/[id]`. Безопасный backfill:
  до этого окладные записи никому не создаются.
- `prisma/seed.ts` ставит `compensationType = SALARY` и осмысленный
  `salaryPerShift` для демо-сотрудников `qc`, `wto`, `packer`, чтобы
  feature можно было сразу проверить руками.
- Новых событий PassportEvent не появляется: окладные начисления —
  параллельная сущность, не часть жизненного цикла паспорта.
- `SalaryEntry.source = MANUAL` оставлен как точка расширения для
  будущего «оплатить день без смены», не используется на MVP.

---

## 6. Сопутствующее

- `docs/domain.md §9a` — доменное описание окладной модели.
- `docs/erd.md §2.13b` — схема `SalaryEntry`.
- `docs/api.md §10a` — `/api/salary*` контракт.
- `docs/api.md §3b` — `/api/employees` контракт (карточка сотрудника).
- `docs/screens.md §10d` — `/admin/employees`.
- `docs/screens.md §12.3` — окладные строки в `/earnings`.
- `tests/integration/salary.test.ts` — 12 сценариев (sync, RBAC,
  ручная правка, reset, employees PATCH).
