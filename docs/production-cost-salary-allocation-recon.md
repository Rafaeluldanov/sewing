# Production cost — окладная часть в себестоимости (recon)

> **Статус:** идея, не реализация. Документ нужен, чтобы зафиксировать
> возможный путь распределения окладной составляющей (ОТК / ВТО /
> упаковка / окладный раскрой) на себестоимость в управленческом
> отчёте `/admin/production-cost` (v2).
>
> Перед внедрением сверить с кодом — структура `PassportEvent`-ов и
> `PassportDurationsService` менялась.

## 1. Контекст

Управленческий отчёт `/admin/production-cost` (v2, см.
[`production-cost-v2-recon.md`](./production-cost-v2-recon.md)) сейчас
показывает в таблице операций только сдельные (`pricingMode != SALARY_ONLY`):
`CUT_CUT`, `SEW_OVERLOCK_1`, `SEW_OVERLOCK_2`, `SEW_BINDING`,
`SEW_COVERSTITCH`. Это by-design — под окладные операции
`EarningsService` намеренно не создаёт `OperationEntry`
(`apps/api/src/modules/earnings/earnings.service.ts` §
`createPendingForCompletedOperation`).

Сам сервис v2 признаёт этот gap warning'ом
(`apps/api/src/modules/costs/production-cost-v2.service.ts:999-1001`):
> «Окладная составляющая не распределена по номенклатуре в этом отчёте».

Для управленческого «куда уходит оклад» этого недостаточно: руководству
надо видеть, какие изделия / заказы тянут окладную нагрузку (ОТК долго
проверяет сложные модели, упаковка завязла на конкретном клиенте и т.д.).

## 2. Что уже работает в коде

**Старый дневной отчёт** `/production-cost` (`CostsService`,
`apps/api/src/modules/costs/costs.service.ts`) уже умеет распределять
окладную часть по паспортам через длительности стадий. Алгоритм:

1. Для каждого окладного сотрудника считается минутная ставка:
   `minuteRate = salaryPerShift / SHIFT_MINUTES` (`SHIFT_MINUTES = 480`,
   см. `@sewing/shared/costs`).
2. `PassportDurationsService.listForPeriod(from, to)` отдаёт массив
   `{ passportId, employeeId, durationMinutes, completedAt }` —
   длительности стадий ОТК / ВТО / упаковки по `PassportEvent`-ам.
3. Доля оклада, осевшая на паспорт:
   `salaryShare(passport) = Σ_stage(duration × minuteRate(employee))`.
4. Простой считается отдельно (`SHIFT_MINUTES − tracked`) и **не**
   попадает в себестоимость изделия — отдельная строка отчёта.

Реальный флоу сканов и важные оговорки см. в auto-memory
`project_no_operation_scan_events`: на ОТК нет события `OPERATION_SCAN`,
длительность считается по `[SCAN, STARTED, FINISHED]`-парам. Перед
переиспользованием инфраструктуры нужно убедиться, что
`PassportDurationsService` корректно работает на актуальных
event-последовательностях.

## 3. Предлагаемый вариант: гибрид A + D

### 3.1 Основной путь — по фактическим длительностям (A)

Переиспользовать `PassportDurationsService` в v2-сервисе. По каждому
паспорту, упакованному в окне периода:

- собрать стадии (`{ employeeId, durationMinutes }`);
- посчитать `salaryShare(passport)` тем же способом, что и
  `CostsService` (см. `costs.service.ts:264-271`);
- разнести эту сумму через `Passport → Order → PatternItem` на
  `nomenclatureGroups` / `orderGroups` (DTO-агрегаты уже имеют
  поле `salaryAllocatedCostRub`, сейчас оно жёстко 0).

`totalCostRub` номенклатуры тогда становится:
`material + hardware + application + operation_piecework + salary_allocated + other`,
а unit-cost честно отражает окладную нагрузку.

### 3.2 Fallback — пропорционально выпуску (D)

Сценарий: у части паспортов нулевая длительность на окладной стадии
(забыли отсканировать на ВТО, прошли мимо весов, и т.п.). Если эту
часть оклада просто потерять, расчётная себестоимость станет
заниженной, и сумма распределённого ≠ сумме фактически выплаченного
оклада.

Решение:

1. Считаем `total_salary_in_period` = `Σ SalaryEntry.amount` за период
   по окладным сотрудникам.
2. Считаем `allocated_salary_by_A` = сумма `salaryShare` по всем
   паспортам с ненулевыми длительностями.
3. `residual = total_salary_in_period − allocated_salary_by_A`.
4. Если `residual > 0` — размазываем его пропорционально `releasedQty`
   по `nomenclatureGroups`. Добавляем warning в отчёт:
   «X ₽ оклада распределено пропорционально выпуску — N паспортов без
    сканов на окладных стадиях».
5. Если `residual < 0` (распределили больше, чем выплатили — теоретически
   возможно, если сотрудник работал сверх смены) — warning без
   корректировки, не уменьшаем фактические значения.

### 3.3 Что попадает в DTO

Новые / используемые поля (уже есть в shared-DTO, надо только
заполнить):

- `ProductionCostNomenclatureGroupDto.salaryAllocatedCostRub` — сумма
  оклада, отнесённая на номенклатуру (A + доля D).
- `ProductionCostOrderGroupDto.salaryAllocatedCostRub` — то же на
  уровне заказа.
- `ProductionCostTotalsDto.salaryAllocatedCostRub` — итого.
- Опционально новое поле `salaryAllocationMethod`:
  `'DURATION' | 'OUTPUT_PROPORTION' | 'MIXED'` — чтобы UI мог честно
  показать, как считалось у конкретной строки.

`totalCostRub` пересчитывается с учётом нового слагаемого, маржа
автоматически становится честнее.

## 4. Альтернативы (рассмотрено, отложено)

- **Норматив времени в техкарте** —
  [`docs/operation-time-norms-recon.md`](./operation-time-norms-recon.md)
  уже описывает инфраструктуру. Когда нормы появятся в техкарте, можно
  будет считать `salary_norm = released_qty × Σ norm_min × avg_minute_rate`.
  Это эталонная, а не фактическая себестоимость; имеет смысл показывать
  рядом с A для контроля производительности, но не заменять A.
- **Shadow rate на каждую окладную операцию** — добавить в `Operation`
  поле `shadowRatePerUnit` и считать так же, как сдельщину. Отвергнуто:
  это в чистом виде возврат к идее, от которой мы ушли через
  `pricingMode = SALARY_ONLY`; расчётная сумма всё равно разойдётся с
  фактом оклада и потребует реконсиляции.
- **Накладные расходы единым процентом (factory overhead)** —
  годится для P&L уровня всего цеха, но даёт «среднюю температуру
  по больнице» при per-product unit cost. Не годится для обоснования
  цены клиенту.
- **ABC по драйверам активности** — для каждой окладной операции
  свой драйвер (qtyGood, boxes, …), оклад делится по сумме драйвера в
  периоде. По сути упрощённая версия (A), но без чувствительности к
  длительности конкретной операции; даёт грубее результат, чем (A).
  Имеет смысл только если откажемся от опоры на сканы.

## 5. Открытые вопросы / риски

- **Качество сканов.** Если на ОТК/ВТО/упаковке часть событий не
  фиксируется, `PassportDurationsService` вернёт `durationMinutes = 0`,
  и весь оклад этого сотрудника уйдёт в `residual`-bucket для D. Надо
  заранее оценить, насколько большая будет доля D в реальных данных —
  возможно, прежде чем включать, стоит провести аудит флоу через
  `display`-доску / `master`-доску движения тиража.
- **Совпадение `SalaryEntry` ↔ длительности.** В (D) мы берём
  `Σ SalaryEntry.amount` как «итого выплаченного оклада за период».
  Надо проверить, что `SalaryEntry` создаются за КАЖДУЮ смену окладного
  сотрудника (а не только когда были сдельные начисления у других).
  Источник истины — `payroll.service.ts` § окладной слой. Если есть
  пробелы — нужно либо чинить там, либо в costs-v2 считать оклад как
  `count_shifts × salaryPerShift`.
- **Раскрой `CUT_CUT`** — формально `pricingMode = FIXED`, но если
  раскройщик переведён на `compensationType = SALARY`,
  `createImmediateForCutter` тихо выходит (см. `earnings.service.ts:144`).
  Такой случай сейчас «теряется» в обоих отчётах. Если решаем учитывать
  окладного раскройщика — нужно отдельно: либо его смена идёт в общий
  пул для (D), либо считать длительности по `PassportEvent.CREATED` →
  следующая стадия как «время раскроя» (но это не факт, а оценка).
- **Поведение при пустых периодах.** `total_salary_in_period > 0`, а
  `released_qty = 0` — нечего размазывать в D. Логичнее всего в этом
  случае показать пустую таблицу с warning'ом «выпуска не было,
  X ₽ оклада не распределено».
- **Куда деть простой.** Сейчас простой в дневном отчёте — отдельная
  строка, не в себестоимости. В v2 пока такой строки нет. Если
  принимаем (A + D), простой автоматически становится частью
  `residual`, и попадает в (D). Это даст «честную» себестоимость, но
  смажет управленческий сигнал «у нас простаивает ОТК». Альтернатива —
  выделять простой отдельной строкой в KPI v2, как в legacy-отчёте.

## 6. Объём работ (ориентировочно, без реализации)

Только для оценки масштаба — не делать до приёмки идеи:

- `apps/api/src/modules/costs/production-cost-v2.service.ts` — добавить
  вызов `durations.listForPeriod`, новый блок «распределение оклада»
  между шагами 7 (материалы) и 8 (orderGroups). ~80-120 строк кода.
- `apps/api/src/modules/costs/costs.module.ts` — `PassportDurationsService`
  уже provided.
- `packages/shared/src/production-cost.ts` — поля DTO уже есть; добавить
  `salaryAllocationMethod` (опционально).
- `apps/web/app/admin/production-cost/page.tsx` — показать
  `salaryAllocatedCostRub` в таблицах + одну строку KPI «Оклад,
  распределён». Убрать существующий disclaimer о нераспределённой
  окладной части, заменить на конкретные warning'и из бэка.
- Тесты бэка: e2e на сценарии «факт > распределённого» (residual > 0),
  «факт = распределённому», «нулевой выпуск, оклад выплачен».

## 7. Ссылки

- [`docs/production-cost-v2-recon.md`](./production-cost-v2-recon.md) —
  базовая архитектура v2-отчёта
- [`docs/operation-time-norms-recon.md`](./operation-time-norms-recon.md) —
  норматив времени, кандидат на будущее
- `apps/api/src/modules/costs/costs.service.ts` —
  готовый алгоритм распределения по длительностям (вариант A)
- `apps/api/src/modules/costs/passport-durations.service.ts` —
  источник длительностей
- `apps/api/src/modules/earnings/earnings.service.ts` —
  почему окладные операции не пишут `OperationEntry`
- auto-memory `project_no_operation_scan_events` — особенности
  реального event-флоу, на которых базируется (A)
