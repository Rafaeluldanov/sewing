# ADR-0013: Маппинг состояний паспорта на этапы экрана «Цех»

- Статус: принято
- Дата: 2026-04-18
- Контекст ТЗ: Шаг 10 MVP («экран Цех»)

## Контекст

На Шаге 10 нужен экран `/shopfloor`, где начальник цеха видит **матрицу
`размер × этап → qty`** и понимает, где сейчас лежит объём
производства. Этап (stage) у нас был только смысловым ярлыком на
дашборде заказа (`OrderSummary.qtyInSewing*` и т. д.), но в самой
доменной модели **отдельной сущности «текущий этап» нет**.

Возможные источники истины:

1. **Журнал событий `PassportEvent`.** Каждое движение паспорта
   фиксируется отдельной записью (`OPERATION_SCAN`, `DEFECT_RECORDED`,
   `PACKED` …). Можно построить полноценную проекцию.
2. **Денормализованные поля паспорта** (`status`, `currentOperationId`,
   `currentEmployeeId`, `currentCellId`) + связанная
   `Operation.category`.
3. **Связанные сущности** (`Box.closedAt` — для упаковки/выпуска).

Полноценная event-проекция — правильный долгосрочный путь, но на MVP:

- усложняет код,
- требует пересчёта при ребалдинге БД,
- работает медленнее.

## Решение

На MVP **не вводим новый источник истины**. Этап вычисляется
детерминированной чистой функцией от текущего состояния паспорта (см.
`apps/api/src/modules/shopfloor/shopfloor-projection.ts`):

| Bucket     | Условие на паспорте                                                                              | qty       |
|------------|--------------------------------------------------------------------------------------------------|-----------|
| `CUT`      | `status = CREATED`                                                                               | `qtyCut`  |
| `SEWING`   | `status = IN_PROGRESS` AND `currentOperation.category ∈ {CUTTING, SEWING}` (или `null`) AND не `SEWING_DONE` | `qtyCut`  |
| `SEWING_DONE` | `status = IN_PROGRESS` AND `category = SEWING` AND `currentEmployeeId = null` AND свежий `OPERATION_FINISHED` по текущей операции (см. §«SEWING_DONE bucket») | `qtyCut`  |
| `QC`       | `status = IN_PROGRESS` AND `currentOperation.category = QC` AND нет свежего `QC_PASSED`          | `qtyCut`  |
| `QC_DONE`  | `status = IN_PROGRESS` AND `category = QC` AND свежий `QC_PASSED` (см. §«QC_DONE bucket»)        | `qtyCut`  |
| `WTO`      | `status = IN_PROGRESS` AND `category = IRONING` AND нет свежего `WTO_PASSED`                     | `qtyCut`  |
| `WTO_DONE` | `status = IN_PROGRESS` AND `category = IRONING` AND свежий `WTO_PASSED` (см. §«WTO_DONE bucket») | `qtyCut`  |
| `PACKING`  | `status = PACKED` AND есть `BoxItem` в OPEN-коробке (`box.closedAt IS NULL`)                     | `qtyGood` |
| `FINISHED` | `status = PACKED` AND PACKING-условие не сработало                                               | `qtyGood` |
| `DEFECT`   | (не stage; отдельный итоговый показатель) `Σ Passport.qtyDefect` среди не-`CANCELLED` паспортов  | —         |

Бакеты **взаимоисключающие**: один паспорт попадает ровно в одну
ячейку матрицы (или ни в одну, если `CANCELLED`). Это позволяет
складывать суммы по строкам и столбцам без двойного счёта.

### Почему `qtyCut`, а не `qtyGood`, для живых стадий

«Размер партии» (`qtyCut`) интуитивен начальнику цеха: «сколько
изделий сейчас на ОТК». `qtyDefect` идёт отдельной колонкой. После
упаковки логично переключиться на `qtyGood` — там брак уже выведен из
оборота и в коробку попадает реальное количество.

### Почему `CUTTING` склеен с `SEWING`

После `ISSUED_TO_EMPLOYEE` (Шаг 6, см. F3a) у паспорта
`status = IN_PROGRESS`, но `currentOperationId` остаётся равным
`CUT_DIVISION` до первого `OPERATION_SCAN`. То есть паспорт уже на
руках у швеи и фактически едет в шитьё. Делать для этого отдельную
колонку «Выдан» — переусложнение для табло; вместо этого засчитываем
такие паспорта в `SEWING`. Сюда же ложится случай
`currentOperationId = NULL` у живого паспорта (теоретически невозможен,
но защищаемся от «дыр»).

## QC_DONE bucket («Проверено ОТК»)

`QcService.completeQc` сознательно **не меняет** `Passport.status`
и `currentOperationId` — `QC_PASSED` это аудит-маркер, а не движение
по pipeline (см. F5/F11 и `qc.service.ts`). Без отдельного бакета
крой после нажатия «Проверка выполнена» оставался бы в колонке
`ОТК`, и начальник цеха не видел бы факта прохождения ОТК — экран
«не двигался».

Решение: производный бакет `QC_DONE`, который вычисляется по
существующим событиям без новых таблиц/полей.

Условие: паспорт `IN_PROGRESS`, `currentOperation.category = QC`,
есть `PassportEvent(QC_PASSED)` с `createdAt > max(OPERATION_SCAN.createdAt)`
для того же паспорта (или вообще нет `OPERATION_SCAN` после `QC_PASSED`).

Свойства:

- `QC` и `QC_DONE` **взаимоисключающие** — паспорт лежит ровно в
  одной ячейке (см. `bucketOf` в `shopfloor-projection.ts`).
- Паспорт уходит из `QC_DONE` автоматически:
  1) следующая операция (швея/упаковщик) делает `OPERATION_SCAN` —
     `currentOperation.category` сменится → паспорт уйдёт в
     `SEWING/WTO/PACKING` обычным маппингом, а `hasFreshQcPassed`
     перестанет быть «свежим»;
  2) либо `Passport.status` станет терминальным (`PACKED`/`CANCELLED`).
- Начисления, упаковка и роли-терминалы `qc-terminal.tsx` /
  `seamstress` не трогаются — этот бакет видно **только** на
  `/shopfloor`.
- Запрос за событиями узкий: groupBy по `PassportEvent` ограничен
  списком id паспортов-кандидатов (`IN_PROGRESS` + `category=QC`),
  чтобы поллинг каждые 3 секунды не превращался в скан всей
  таблицы событий.

Альтернативы (отвергнуты):

- **Менять `Passport.status` или вводить новый `PassportStatus.QC_DONE`.**
  Ломает event-sourcing-lite (ADR-0003) и контракт `QcService`/UI ОТК
  (`removedFromQc`); затрагивает RBAC, начисления, упаковку,
  карточку паспорта. Ради визуального движения на одном экране —
  непропорционально.
- **Считать на клиенте.** `/shopfloor` видит только агрегат
  `(size × stage)`, ему недоступен список паспортов и их событий —
  без backend-проекции бакет посчитать невозможно.

## WTO_DONE bucket («ВТО завершено»)

Полный аналог `QC_DONE` для роли ВТО (см. F6 и `wto.service.ts`).
`WtoService.completeWto` сознательно не меняет `Passport.status`
и `currentOperationId` — `WTO_PASSED` это аудит-маркер, а не движение
по pipeline. Без отдельного бакета крой после нажатия «Завершить ВТО»
оставался бы в колонке `ВТО`, и начальник цеха не видел бы факта
завершения ВТО.

Решение: производный бакет `WTO_DONE`, который считается по тому же
правилу «свежее терминальное событие vs. последний `OPERATION_SCAN`»,
что и `QC_DONE`, без новых таблиц.

Условие: паспорт `IN_PROGRESS`, `currentOperation.category = IRONING`,
есть `PassportEvent(WTO_PASSED)` с
`createdAt > max(OPERATION_SCAN.createdAt)` для того же паспорта (или
вообще нет `OPERATION_SCAN` после `WTO_PASSED`).

Свойства (повторяют `QC_DONE`, чтобы не разводить два разных
контракта):

- `WTO` и `WTO_DONE` **взаимоисключающие** — паспорт лежит ровно в
  одной ячейке (см. `bucketOf` в `shopfloor-projection.ts`).
- Паспорт уходит из `WTO_DONE` автоматически:
  1) следующая операция (упаковщик) делает `OPERATION_SCAN` —
     `currentOperation.category` сменится → паспорт уйдёт в
     `PACKING/...` обычным маппингом, а `hasFreshWtoPassed` перестанет
     быть «свежим»;
  2) либо `Passport.status` станет терминальным (`PACKED`/`CANCELLED`).
- Начисления, упаковка и роль-терминал швеи не трогаются — этот
  бакет видно **только** на `/shopfloor` и в самом терминале ВТО
  (`removedFromWto`).
- groupBy за событиями расширен до трёх типов (`QC_PASSED`,
  `WTO_PASSED`, `OPERATION_SCAN`) и фильтруется по списку id
  паспортов-кандидатов (`IN_PROGRESS` + `category ∈ {QC, IRONING}`),
  чтобы запрос оставался узким даже на больших активных заказах.
- QC-gate на входе в ВТО (`PassportsService.scanOnOperation` для
  категории `IRONING`) гарантирует, что паспорт без `QC_PASSED` не
  может попасть в `WTO`/`WTO_DONE` — backend возвращает 409
  `PASSPORT_NOT_QC_PASSED` ещё до записи `OPERATION_SCAN`.

## SEWING_DONE bucket («Сшито, ждёт ОТК»)

- Дата: 2026-09-14

`PassportsService.completeOperationByEmployee` («Завершить операцию»
у швеи) сознательно **не двигает** паспорт на следующий шаг: он
снимает исполнителя (`currentEmployeeId = null`), оставляет
`currentOperationId` / `currentRouteStepIndex` на завершённом шаге и
пишет `PassportEvent(OPERATION_FINISHED, operationId = завершённая
операция)`. Следующий шаг (ОТК или следующая швейная операция)
перехватывает паспорт своим `OPERATION_SCAN`/`issue`. До этого
паспорт физически лежит в WIP-буфере «сшито, ждёт ОТК».

Без отдельного бакета такой паспорт оставался в колонке `Пошив`
вместе с теми, что реально на руках у швей, и начальник цеха не
отличал «13 паспортов шьются» от «3 сшиты и ждут ОТК» (живой пример
— заказ ФС-000003: 16 паспортов на ПРЯМОСТРОЧКЕ, из них 13 на руках
(155 шт) и 3 завершены (36 шт); ещё 6 на ОТК (67 шт)). На
`/shopfloor/display` эта разница уже была видна как `▶/✔` в
`sewingRoute`, а в матрице `/shopfloor/state` (ею пользуется и ERP)
— нет.

Решение: производный бакет `SEWING_DONE`, полный аналог
`QC_DONE`/`WTO_DONE` для пошива, без новых таблиц/полей.

Условие: паспорт `IN_PROGRESS`, `currentOperation.category = SEWING`,
`currentEmployeeId = null`, и есть `PassportEvent(OPERATION_FINISHED)`
с `operationId = Passport.currentOperationId`, у которого
`createdAt > max(createdAt)` последних `ISSUED_TO_EMPLOYEE` и
`OPERATION_SCAN` этого паспорта (по любой операции), либо таких
событий нет вовсе.

Свойства:

- `SEWING` и `SEWING_DONE` **взаимоисключающие** — паспорт лежит ровно в
  одной ячейке (см. `bucketOf` в `shopfloor-projection.ts`); сумма
  всех бакетов не меняется.
- `SEWING` теперь означает «на руках у швеи (`currentEmployeeId != null`)
  либо без исполнителя ждёт выдачи» (после отката мастером /
  возврата ОТК на переделку, после `returnToCell`, после
  `setRouteStep` вперёд на ещё не начатый шаг).
- Паспорт уходит из `SEWING_DONE` автоматически:
  1) ОТК (или следующая швейная операция) делает `OPERATION_SCAN` /
     `issue` — категория `currentOperation` сменится либо появится
     исполнитель, и `hasFreshSewingFinished` перестанет быть «свежим»;
  2) мастер откатывает паспорт назад (`setRouteStep` backward с
     ячейкой) или ОТК возвращает на переделку (`returnToRework`) —
     паспорт встаёт на ранее завершённую операцию, но её старый
     `OPERATION_FINISHED` заведомо старше выдачи/скана следующего
     шага → паспорт в `SEWING` («ждёт выдачи»); после повторного
     `issue` → `complete` он снова попадёт в `SEWING_DONE`;
  3) либо `Passport.status` станет терминальным (`PACKED`/`CANCELLED`).
- Почему `OPERATION_FINISHED` фильтруется **по текущей операции**:
  `closeUnclosedOperationByEmployee` дописывает финиш по СТАРОЙ
  операции паспорта, уже уехавшего дальше (долг швеи, см. `GET
  /api/shifts/my-unclosed`), — такой финиш не должен двигать бакет.
- CUT-rollback (`CUTTING` без исполнителя → `CUT`) проверяется в
  `bucketOf` **раньше** буфера пошива; сервис и так считает флаг только
  для категории `SEWING`.
- На `/shopfloor/display` `qtySewingDone` участвует в KPI «В работе»
  и в `totals`, но в `sewingByOp` **не входит** (инвариант
  `Σ sewingByOp === qtySewing` сохранён): по операциям этот буфер уже
  показывает `sewingRoute[].rows[].done` (`buildSewingRoute` считает
  ✔ по `currentEmployeeId = null` + `currentRouteStepIndex`, без
  событий — грубее, но для TV достаточно). Pipeline дашборда
  (`PRODUCTION_DASHBOARD_STAGES`) стадию не выделяет — там
  `hasFreshSewingFinished = false`, завершённые остаются в `SEWING`.
- Запрос узкий: отдельный groupBy по `PassportEvent` ограничен id
  кандидатов (`IN_PROGRESS` + `SEWING` + без исполнителя) и тремя
  типами (`OPERATION_FINISHED`, `ISSUED_TO_EMPLOYEE`, `OPERATION_SCAN`);
  в `by` добавлен `operationId`, чтобы отфильтровать финиш по текущей
  операции. Гоняется параллельно с QC/WTO-groupBy
  (`ShopfloorService.computeFreshSewingFinishedSet`).
- Порядок в `SHOPFLOOR_STAGES`: `… 'SEWING', 'SEWING_DONE', 'QC',
  'QC_DONE', …`; подпись `SEWING_DONE: 'Сшито, ждёт ОТК'`; поле
  `qtySewingDone` в `ShopfloorSummaryDto` (строки и summary). Контракт
  общий с ERP (`GET /api/shopfloor/state`).

Альтернативы (отвергнуты):

- **Считать ✔ как `buildSewingRoute` (без событий, только
  `currentEmployeeId = null`).** Тогда паспорт, откаченный мастером в
  ячейку или возвращённый ОТК на переделку, показывался бы как «сшит»,
  хотя физически ждёт выдачи. Для матрицы, которую читает ERP, нужен
  честный признак завершения — им и является `OPERATION_FINISHED`.
- **Расширять `PassportEventType`/`PassportStatus`.** Те же причины,
  что у `QC_DONE`: непропорционально ради визуального движения.

## Аппроксимация колонки `PACKING`

В текущей модели **промежуточного «в упаковке» статуса у паспорта
нет** (см. ADR-0011 §3): добавление паспорта в коробку сразу делает
его `PACKED`. То есть «в упаковке прямо сейчас» = «в OPEN-коробке».
Используем именно это правило:

```text
PACKING  = Σ qtyGood по PACKED-паспортам, у которых хотя бы один
           BoxItem.box.closedAt IS NULL
FINISHED = Σ qtyGood по PACKED-паспортам, не попавшим в PACKING
```

Это **MVP-аппроксимация**, явно описанная в `docs/flows.md §F11`. Она
обеспечивает «живой» индикатор для упаковщика без ввода нового статуса
у паспорта и без усложнения транзакции `PackingService.addPassport`.

## Аппроксимация анимации «перелёта»

ТЗ просило «моргание красным квадратом при перемещении». Полноценная
анимация перелёта объекта с одной ячейки на другую требует:

- знания корреляции «эта дельта в `(size, A)` → эта дельта в `(size, B)`»;
- стабильной координатной системы между rerender-ами;
- Canvas/WebGL (или дорогих CSS transform-ов с absolute positioning).

На MVP **сознательно** заменяем это на **flash-подсветку ячейки**:

- если значение выросло — короткий зелёный flash (`shopfloor-flash-up`);
- если упало — короткий красный flash (`shopfloor-flash-down`).

Этого достаточно, чтобы взгляд заметил изменение, и не требует ни
сложной координатной геометрии, ни Canvas. Полноценная анимация
перелёта — отдельный пост-MVP пункт.

## Polling, а не realtime

Используем `GET /api/shopfloor/state` каждые 3 секунды (см.
[ADR-0007](./0007-polling-for-realtime.md)). Никаких WS/SSE на этом шаге.

## Альтернативы (отвергнуты)

- **Полноценная event-проекция в отдельной таблице
  `ShopfloorSnapshot`.** Лишняя сложность: нужно ловить события и
  транзакционно пересчитывать. Без явных проблем производительности
  на MVP не оправдано.
- **Считать stage из последнего `PassportEvent`.** Дублирует логику и
  заставляет читать events на каждый polling — медленнее, чем
  агрегат по `Passport`.
- **Ввести `Passport.stage` (новый enum).** Нарушает event-sourcing-lite
  (ADR-0003) — единственным источником истины состояния остаётся
  набор полей, выводимых из событий. Лишнее поле быстро станет
  рассинхронизированным.

## Последствия

+ Никаких миграций БД для Шага 10.
+ Логика проекции — одна чистая функция, которую легко тестировать
  и изменять.
+ Если домен захочет добавить «WTO как отдельный статус», достаточно
  завести новый `OperationCategory` или новое правило в `bucketOf()` —
  без правок на всех слоях.
− Колонка `PACKING` — приближение, не «настоящий» этап. Если в
  будущем появится промежуточный статус у паспорта (например,
  `PACKING_IN_PROGRESS`), правило в `bucketOf` придётся обновить.
− «Перелёт» сводится к flash-у. Полноценная анимация — отдельная
  задача после MVP.
