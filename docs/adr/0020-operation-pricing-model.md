# ADR-0020. Управленческий блок «Операции» и единая модель тарифов

- Статус: Принято
- Дата: 2026-04
- Контекст: пост-ADR-0019, перед расширением админки на сдельные тарифы

---

## 1. Контекст

Со Шага 9 (`docs/index.md`) сдельная зарплата считается из таблицы
`PieceRate(operationId, productId?, sizeId?, ratePerUnit,
validFrom, validTo?)` — общий «универсальный» справочник, который мог
описать любую матрицу ставок. Реальный цех использует ровно три
сценария:

- **Раскрой (`CUT_CUT`).** Одна фиксированная ставка за единицу
  независимо от размера/изделия/времени.
- **Оверлок (`SEW_OVERLOCK_*`).** Разные ставки по размеру: 104 / 110
  дешевле, 6XL дороже. Разница реальная и важна экономически.
- **Все остальные операции пошива/раскроя/упаковки/ОТК/ВТО.** Окладная
  работа — сдельная стоимость не применяется в принципе.

Что не так с `PieceRate` для этой реальности:

- Сложно настроить и поддерживать. Менеджер не понимает, нужно ли
  вводить ставку для каждой комбинации `(operation, product, size)`,
  сколько строк завести, что значит `validFrom`. На пилоте seed-овые
  данные так и остались единственным источником ставок.
- В UI нет управленческого блока «Операции». Создание/изменение
  операции и связанной с ней ставки — только через Prisma Studio или
  миграцию (что для начальника цеха недоступно).
- В коде логика «есть ли у этой операции сдельная ставка» жила
  параллельно: `EarningsService.findRate` лез в `PieceRate`,
  `earnings.constants.ts` отдельно держал «список piecework-операций»
  (`PIECEWORK_OPERATION_CODES` + `isPieceworkOperationCode`). Любое
  изменение требовало синхронизации этих двух источников и нового
  релиза.

Что хочет начальник цеха:

- видеть список операций как обычную управленческую сущность (как
  склады/оборудование — `/admin/equipment`, `/admin/warehouses`);
- создавать/переименовывать операции, явно отмечать «эта операция
  окладная — сдельной стоимости нет»;
- задавать ставку у `CUT_CUT` одним числом, а у оверлока — таблицей
  «размер → ставка», без матрицы из 14 строк;
- быть уверенным, что начисления берут именно эту цифру.

Что **категорически не хочется** делать ради этого:

- ломать pipeline: `PassportsService.create` / `scanOnOperation` /
  `PackingService.close` уже работают на пилоте; любая регрессия там
  стоит дороже, чем удобство админки;
- менять идентичность операций (`Operation.code` остаётся стабильным —
  существующие миграции, события, отчёты ссылаются на коды);
- городить полноценный rate-engine с историей по датам, ставками по
  сотруднику/складу/селлеру, формулами от объёма — это перебор для
  пилотного цеха.

## 2. Решение

1. **Минимальная доменная модель.** На `Operation` добавляем
   управленческие поля: `pricingMode PricingMode @default(SALARY_ONLY)`,
   `fixedRate Decimal(12,2)?`, `updatedAt DateTime @updatedAt`. Заводим
   отдельную таблицу `OperationRateBySize(id, operationId, sizeId, rate
   Decimal(12,2), createdAt, updatedAt)` с `UNIQUE (operationId, sizeId)`
   и `ON DELETE CASCADE` от `Operation`. Полная схема — `docs/erd.md
   §2.3`/§2.3a, доменное описание — `docs/domain.md §4`/§4a.

2. **`PricingMode` — три явных режима.**

   | Mode          | Источник ставки                              | Семантика                                                                                                  |
   | ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
   | `FIXED`       | `Operation.fixedRate`                        | Одна цена за единицу независимо от размера. Менеджер вводит одно число.                                    |
   | `BY_SIZE`     | `OperationRateBySize.rate` для `sizeId`      | Цена различается по размеру (реальный кейс — оверлок). `fixedRate` хранится `null`.                         |
   | `SALARY_ONLY` | —                                            | Операция участвует в pipeline (можно сканировать, она перекидывает паспорт), но **не порождает** `OperationEntry`. |

   Дефолт — `SALARY_ONLY` (самый безопасный: новая операция не сломает
   зарплату, пока менеджер не выберет тариф). Бизнес-валидация
   соответствия `pricingMode ↔ {fixedRate, ratesBySize}` живёт в Zod-
   схемах (`packages/shared/src/operations.ts`) и дублируется в сервисе.

3. **Единый источник истины — `OperationsService.resolveRate(operationId,
   sizeId, tx?)`.**

   - `FIXED` → возвращает `Operation.fixedRate` (с проверкой
     согласованности; отсутствие — серверная ошибка `OPERATION_RATE_MISSING`,
     потому что `pricingMode = FIXED` без `fixedRate` не должно физически
     существовать).
   - `BY_SIZE` → возвращает `OperationRateBySize.rate` для пары
     `(operationId, sizeId)`. Отсутствие — `OPERATION_RATE_MISSING` (422):
     менеджер обязан задать ставку для каждого реально используемого
     размера.
   - `SALARY_ONLY` → возвращает `null`. Это контракт: «у операции нет
     сдельной ставки», и `EarningsService` молча пропускает её, не
     создавая `OperationEntry`.

4. **`EarningsService` использует `resolveRate` как единственный
   источник.** Старая `findRate` (поверх `PieceRate`) и константа
   `PIECEWORK_OPERATION_CODES` / функция `isPieceworkOperationCode`
   удалены из runtime: «является ли операция piecework» теперь = `op.pricingMode
   ≠ SALARY_ONLY`. Конкретно:

   - `createImmediateForCutter` (`PASSPORT_CREATED`, ADR-0005,
     ADR-0012): загружает операцию `CUT_CUT`, если её
     `pricingMode = SALARY_ONLY` — silently возвращает (no-op);
     иначе зовёт `resolveRate(op.id, sizeId, tx)` и создаёт
     `OperationEntry { status=APPROVED, approvalMode=IMMEDIATE,
     sourceEventType=PASSPORT_CREATED }`.
   - `createPendingForPreviousOperation` (`OPERATION_TRANSITION`,
     ADR-0005): то же для предыдущей операции пошива
     (`PENDING_RELEASE` / `AFTER_RELEASE`). Уникальный индекс
     `OperationEntry_idem` (ADR-0012) и `safeCreate` сохраняются:
     повторный скан так же молча проглатывается.
   - Идентификация «оплатной операции» больше не требует
     синхронизации с константой кода; добавили новую `BY_SIZE`-
     операцию через админку — она автоматически попадает в начисления
     без редеплоя backend.

5. **Backend API (новый модуль `apps/api/src/modules/operations`).**

   - `GET /api/operations` — список с `pricingMode`, `fixedRate`,
     `ratesBySizeCount`. Сортировка по `sortOrder, name`.
   - `GET /api/operations/:id` — карточка с полным `ratesBySize[]`
     (упорядоченным по `Size.sortOrder`).
   - `POST /api/operations` — создать (валидация: `code` уникален
     и совпадает с `OperationCodeSchema`; `pricingMode`-специфичные
     правила из Zod-схемы — см. п. 7).
   - `PATCH /api/operations/:id` — точечно `name`/`category`/
     `isActive`/`pricingMode`/`fixedRate`/`ratesBySize`.
     `code` сознательно не меняется — это идентичность.
   - Все четыре — `@Roles('SHOP_MANAGER', 'ADMIN')`. Чтения списка
     через `GET` тоже под этими ролями: операции — управленческая
     сущность, рабочим ролям её видеть незачем (на `/work` allow-лист
     операций приходит уже отфильтрованным через
     `EquipmentOperation`, см. ADR-0017).
   - Новые бизнес-ошибки: `OPERATION_NOT_FOUND` (404),
     `OPERATION_CODE_TAKEN` (409),
     `OPERATION_RATE_SIZE_NOT_FOUND` (400 — в `ratesBySize` указан
     несуществующий `sizeId`), `OPERATION_RATE_DUPLICATE_SIZE` (400 —
     дубль `sizeId` в одной заявке), `OPERATION_RATE_MISSING` (422 —
     `resolveRate` не нашёл ставку при создании начисления).
     Контракт — `docs/api.md §15a`, коды — §13.

6. **Web-UI: `/admin/operations`.**

   - **Список** (`apps/web/app/admin/operations/page.tsx`): таблица
     «Название · Код · Категория · Тип тарифа · Ставка/режим ·
     Активна · Открыть». Над таблицей — форма «Создать операцию»
     (минимальные поля: код, название, категория, `pricingMode`,
     для `FIXED` — поле «Ставка за единицу»).
   - **Карточка** (`apps/web/app/admin/operations/[id]/page.tsx`):
     адаптивная под `pricingMode`. Для `FIXED` — одно числовое
     поле `fixedRate`. Для `BY_SIZE` — таблица «размер ↔ ставка»
     с кнопкой «Заполнить всем одну ставку». Для `SALARY_ONLY` —
     явный блок «Операция окладная — сдельная ставка не используется».
     При смене `pricingMode` UI подстраивает форму, при сохранении
     серверный `update` чистит несовместимые поля (`fixedRate`/
     `ratesBySize`) транзакционно.
   - Тайл «Операции» на главной (`/`) и пункт «Операции» в админ-
     нав-баре — только для `ADMIN`/`SHOP_MANAGER`. Защита
     раздела — существующий `app/admin/layout.tsx` через
     `canSeeAdmin`. Backend перепроверяет `@Roles` независимо.
   - Контракт UI — `docs/screens.md §10c`.

7. **Shared-контракты — Zod как источник правды для валидации.**

   `packages/shared/src/operations.ts` определяет:

   - `PRICING_MODES` enum (`FIXED | BY_SIZE | SALARY_ONLY`);
   - `CreateOperationSchema` / `UpdateOperationSchema` с `superRefine`/
     `refine`, который ловит невалидные комбинации (`FIXED` без
     `fixedRate`, `SALARY_ONLY` с `fixedRate`, `BY_SIZE` с
     `fixedRate`, дубликаты `sizeId` в `ratesBySize` и т.п.) и
     возвращает `400 VALIDATION_ERROR` с понятным `path`. Это и
     контракт для frontend Server Actions, и серверная защита.

8. **Миграция данных.** Миграция
   `prisma/migrations/20260420100000_operation_pricing_model/migration.sql`:

   1. Создаёт enum `PricingMode`, добавляет колонки `Operation.pricingMode`
      (default `SALARY_ONLY`), `Operation.fixedRate`, `Operation.updatedAt`,
      создаёт таблицу `OperationRateBySize` со всеми индексами/FK.
   2. Бэкфилит из существующего `PieceRate`: для каждой операции,
      у которой в `PieceRate` есть строки, выводит `pricingMode`:
      - все `ratePerUnit` совпадают и нет привязки к `sizeId` →
        `FIXED` + `fixedRate = ratePerUnit`;
      - есть зависимость от `sizeId` со значимой разницей ставок →
        `BY_SIZE` + наполняет `OperationRateBySize` по живым
        `sizeId`;
      - иначе оставляет `SALARY_ONLY`.
     Под `BY_SIZE` миграция дополнительно очищает строки
     `OperationRateBySize` для операций, чей итоговый режим всё-таки
     оказался `FIXED` (защита от ложных дублей).
   3. **`PieceRate` сознательно НЕ удаляем сразу**: это исторические
      данные, миграция не сносит их (rollback и аудит). На уровне
      runtime таблица больше не читается — `EarningsService` живёт
      целиком на новой модели. *(Обновление PHASE 2 STEP 1 — см.
      §«PHASE 2 — drop legacy» ниже: после полугода эксплуатации
      на новой модели таблица всё-таки удалена.)*

9. **Seed.** `prisma/seed.ts` обновлён под новую модель:

   - `OPERATIONS[]` теперь явно несёт `pricingMode` и `fixedRate`.
     Текущий MVP-набор: `CUT_CUT = FIXED` (рейт 10), `SEW_OVERLOCK_1`
     / `SEW_OVERLOCK_2` = `BY_SIZE` (рейт по размерам), всё
     остальное = `SALARY_ONLY`.
   - Старый `seedPieceRates()` заменён на `seedOperationRatesBySize()`
     для `BY_SIZE`-операций; `PieceRate` больше не сидится — seed-
     прогон стал чище.
   - `tests/utils/seed.ts` синхронизован: `CUT_CUT = FIXED`
     (`fixedRate=10`) сохраняет совместимость с существующими тестами
     (`production-flow.test.ts` ожидал именно ставку 10);
     `SEW_OVERLOCK_*` — `BY_SIZE` со ставкой 10 для всех размеров.

10. **Тесты** (`tests/integration/operations.test.ts`, 20 сценариев):
    CRUD под все три `pricingMode`, валидации (`FIXED` без `fixedRate`,
    `SALARY_ONLY` с `fixedRate` — оба `400 VALIDATION_ERROR`),
    уникальность `code` (`OPERATION_CODE_TAKEN`), уникальность
    `(operationId, sizeId)` (`OPERATION_RATE_DUPLICATE_SIZE`),
    несуществующий `sizeId` (`OPERATION_RATE_SIZE_NOT_FOUND`), смена
    режима (`FIXED → BY_SIZE`, `BY_SIZE → SALARY_ONLY` чистит
    `ratesBySize`), пустой `ratesBySize=[]` стирает все ставки,
    `404 OPERATION_NOT_FOUND`, RBAC (`SEAMSTRESS`/`CUTTER`/`QC`/`PACKING`
    → 403; `ADMIN`/`SHOP_MANAGER` → 200/201) и три сценария earnings-
    интеграции:

    - `FIXED` — раскройщик получает `Operation.fixedRate * qty` (10 × 7
      = 70);
    - `SALARY_ONLY` (после `PATCH ... pricingMode: SALARY_ONLY`) —
      `OperationEntry` не создаётся;
    - `BY_SIZE` (после `PATCH ... ratesBySize: [{S, 7}, {M, 9}]`) —
      ставка берётся именно из `OperationRateBySize` для `M` (4 × 9 =
      36).

    Все 249 тестов в репозитории зелёные — pipeline не сломан.

## 3. Альтернативы

- **Оставить `PieceRate` как единственный источник, добавить только
  CRUD над ним.** Минимальная правка кода, но сохраняет UX-проблему:
  менеджер не понимает разницу «фиксированная / по размеру / нет
  ставки», и для оверлока ему всё равно придётся забивать 14 строк
  с одинаковым кодом. Не решает корневую проблему.
- **Сделать ставку JSON-полем у `Operation` (`rates: { kind, value
  | bySize: { id: rate } }`).** Дешевле по схеме, но теряем UNIQUE
  `(operationId, sizeId)`, агрегаты по размерам и нормальные FK.
  Нельзя строить простые join-запросы «сколько начислений по
  размеру» — а это понадобится в первой же отчётной задаче.
- **Полноценный rate-engine** с историей `validFrom/validTo`,
  привязкой к сотруднику/складу/селлеру, скидками от объёма и т.п.
  Соответствует «классической» зарплатной системе, но: на пилотном
  цехе с тремя реальными сценариями это оверкилл, который требует
  отдельного UI согласования и отдельных тестов на каждую размерность.
  ADR явно оставляет это в future work — текущая модель не закрывает
  расширение, но и не блокирует его (можно надстроить новую таблицу
  `OperationRateOverride` сверху).
- **Удалить `PieceRate` сразу той же миграцией.** Аккуратно по
  схеме, но без runtime-зависимости лишает нас «отката»: если что-то
  пойдёт не так, мы хотим иметь возможность вернуть `findRate` и
  пересчитать. Решено: данные оставляем, runtime-зависимость
  обрываем — это безопаснее.

## 4. Последствия

- В админке появляется явный экран «Операции», и начальник цеха
  может без релиза:
  - заводить новые операции,
  - переименовывать и менять категорию,
  - выбирать тариф и задавать его одним числом или таблицей
    «размер ↔ ставка»,
  - явно отмечать операцию окладной (тогда `EarningsService` её
    тихо пропустит).
- Pipeline (`PassportsService.create` / `scanOnOperation`,
  `PackingService.close`, `EarningsService.approvePendingForPassport`)
  не меняется ни на байт. Тесты `production-flow`, `pilot-flow`,
  `cutting-closure`, `equipment-operations`, `warehouses` остаются
  зелёными (см. п. 10).
- Контракт «начисления для пошива создаются по предыдущей операции
  при `OPERATION_TRANSITION`» сохраняется ровно как в ADR-0005 /
  ADR-0012; меняется только источник ставки.
- `PieceRate` физически остаётся в БД (rollback / аудит), но больше
  не читается runtime. Любое его изменение через Prisma Studio
  не повлияет на новые начисления — это явный, осознанный обрыв
  зависимости.
- Frontend получает ровно один контракт (`OperationDetailDto`):
  никаких клиентских join'ов между «справочником операций» и
  «таблицей расценок». Это снимает целый класс рассогласований
  «UI показывает ставку, начисление берёт другую».
- Идентификация «оплатной операции» в коде = `op.pricingMode ≠
  SALARY_ONLY`. Никаких больше литералов
  `PIECEWORK_OPERATION_CODES` / `isPieceworkOperationCode` в runtime.
  Соответствующая константа сохранена в `earnings.constants.ts` как
  `DEFAULT_PIECEWORK_OPERATION_CODES` исключительно для seed-/исторической
  справки и помечена комментарием «не используется в runtime».

## 5. Открытые вопросы / future work

- История ставок по датам (`validFrom/validTo`). Сейчас сознательно
  нет — менеджер меняет ставку и она применяется ко всем последующим
  начислениям. Если потребуется — поверх `OperationRateBySize`
  ставится надстройка `OperationRateRevision`, без переезда основной
  таблицы.
- Ставки по `productId` (разные изделия — разные расценки). Текущий
  пилот один продуктовый сегмент (футболки), и расценки от изделия
  не зависят. Когда появится второй принципиально другой продукт —
  обсуждаем расширение `OperationRateBySize` колонкой `productId`
  (UNIQUE становится `(operationId, productId, sizeId)`).
- Ставки по сотруднику/смене/складу. Намеренно вне скоупа — это уже
  ERP-территория. Если бизнес попросит — отдельный ADR.
- Авто-перевод операции в `SALARY_ONLY` при удалении всех
  `OperationRateBySize` строк. Сейчас сервис, наоборот, требует от
  менеджера явно сказать «этот оверлок становится окладным» — это
  безопаснее, чтобы случайная очистка таблицы не «обнулила» зарплату.
- Soft-delete операций. На MVP достаточно `Operation.active = false`;
  если когда-нибудь понадобится физически удалять — `OperationRateBySize`
  уже под `ON DELETE CASCADE`, `OperationEntry` остаётся как исторический
  факт.

## 6. PHASE 2 — drop legacy (2026-05)

Контекст: PHASE 2 (`docs/index.md §«PHASE 2 — нормализация
сотрудников»`) готовит payroll core к PHASE 3 PayrollPayout.
По ходу ревизии модели зарплаты обнаружены два legacy-объекта,
которые с момента ADR-0020 уже не читаются runtime, но продолжают
сбивать с толку при чтении схемы и при онбординге:

- таблица `PieceRate` (была сохранена «для отката» по §2.8.3 выше);
- поле `Employee.salaryBase` (исторический «оклад»; реальный
  payroll-движок никогда его не использовал — он считает оклад
  через `compensationType` + `salaryPerShift`, см. ADR-0021).

Решение PHASE 2 STEP 1:

- Миграция
  `prisma/migrations/20260532100000_drop_legacy_salary_base_and_piece_rate/migration.sql`
  делает `DROP TABLE IF EXISTS "PieceRate"` (вместе с FK-ограничениями
  на `Operation`/`Product`/`Size`) и `ALTER TABLE "Employee" DROP
  COLUMN "salaryBase"`.
- В `prisma/schema.prisma` модель `PieceRate` и связи
  `Operation.pieceRates`/`Product.pieceRates`/`Size.pieceRates` сняты,
  поле `Employee.salaryBase` удалено.
- Бизнес-исключение `PieceRateNotFoundException` снято из
  `apps/api/src/common/errors.ts` — единственный источник «нет
  ставки» теперь `OPERATION_RATE_MISSING` из `OperationsService.resolveRate`.
- `prisma/seed.ts` и `tests/utils/seed.ts` больше не записывают
  `salaryBase`; никаких вспомогательных `seedPieceRates` не остаётся.
- DTO/UI (`packages/shared/src/employees.ts`, страницы
  `/admin/employees/*`, AdminTechInfo) не содержат `salaryBase`.

Откат: миграция down не пишется (см. общий стиль миграций в репо).
Если потребуется восстановить таблицу — это делается через копию
БД, где `PieceRate` ещё жив; runtime восстановления не требуется,
потому что `EarningsService` уже несколько релизов читает только
`Operation.fixedRate` / `OperationRateBySize.rate`.

Что это меняет в текущем ADR-0020:

- §2.8.3 «`PieceRate` сознательно НЕ удаляем» закрыто как
  выполненное переходное состояние — оно отработало роль защиты на
  пилоте.
- §«Альтернативы → Удалить `PieceRate` сразу той же миграцией»
  больше не релевантна: к моменту drop'а runtime-зависимости уже
  нет, и safety-окно §2.8.3 истекло.
- Контракт §1–§5 не меняется: тарифы по-прежнему живут в
  `Operation.fixedRate` / `OperationRateBySize`, payroll-pipeline
  не трогается.
