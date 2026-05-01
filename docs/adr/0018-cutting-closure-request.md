# ADR-0018. Закрытие раскроя по размеру через заявку (request → review)

- Статус: Принято
- Дата: 2026-04
- Контекст: пост-Шаг 14 (Equipment ↔ Operation, ADR-0017),
  стабилизация плана/факта по строкам заказа

---

## 1. Контекст

`OrderItem` хранит `qtyPlan` по тройке `(orderId, productId, sizeId)` —
сколько нужно накроить и выпустить. `Passport.qtyCut`, агрегированный
по живым (не `CANCELLED`) паспортам той же строки, даёт `qtyCutFact`.
`qtyRemaining = qtyPlan − qtyCutFact` — это и есть «сколько ещё нужно
накроить» (см. `docs/domain.md §5`).

В реальности часто бывает «накроили меньше плана и больше не будут»:
кончилась ткань, нашли дефект рулона, переразмеривали по факту.
Сейчас система этот случай не различает — `qtyRemaining > 0` означает
одновременно «ещё накроят» и «уже не накроят». Заказ «висит»: shopfloor
держит строку как незакрытую, помощник раскройщика не может пометить её
как завершённую, кнопка «выпустить паспорт» по-прежнему доступна
(`PassportsService` режет только `qtyCut > remaining` и `OrderStatus`).

План `OrderItem.qtyPlan` мы держим иммутабельным (ADR-0006): «занижение
плана задним числом» путает аналитику и стирает историю причины. Нужен
управленческий контур, который:

- помогает помощнику раскройщика заявить «здесь больше не кроим»,
- даёт мастеру цеха формальное «да/нет»,
- после «да» жёстко режет выпуск паспортов на backend,
- сохраняет план/факт нетронутыми (для отчётов и зарплаты).

## 2. Решение

1. **Новая сущность `CuttingClosureRequest`** на тройке
   `(orderId, productId, sizeId)`, статусы:
   `REQUESTED → APPROVED | REJECTED`. Поля минимальны:
   `reason?`, `requestedByEmployeeId / requestedAt`,
   `reviewedByEmployeeId? / reviewedAt? / reviewerNote?`. Полная схема —
   `docs/erd.md §2.5b`.

2. **DB-инварианты — partial unique indexes** (см. ADR-0015):
   - `cutting_closure_request_active_uniq` —
     `UNIQUE (orderId, productId, sizeId) WHERE status = 'REQUESTED'`;
     гарантирует «одна активная заявка на строку».
   - `cutting_closure_request_approved_uniq` —
     `UNIQUE (orderId, productId, sizeId) WHERE status = 'APPROVED'`;
     гарантирует «один финал на строку» — повторно «закрыть» нельзя.
   - `REJECTED` копится без ограничений: история отказов не мешает
     подать новую заявку.
   - Индексы создаёт миграция и идемпотентно — `PrismaService.onModuleInit`
     (тот же подход, что для других MVP-инвариантов).

3. **Backend-flow** в `CuttingClosureModule`:
   - `POST /api/cutting-close-requests` —
     `CUTTER_ASSISTANT` (основной) и `SHOP_MANAGER` (от его имени);
   - `GET /api/cutting-close-requests` (фильтры: `status`, `orderId`,
     `productId`, `sizeId`) — `SHOP_MANAGER`, `CUTTER_ASSISTANT`,
     `ADMIN`;
   - `GET /api/cutting-close-requests/:id` — те же роли;
   - `POST /api/cutting-close-requests/:id/approve` — `SHOP_MANAGER`,
     `ADMIN`;
   - `POST /api/cutting-close-requests/:id/reject` — `SHOP_MANAGER`,
     `ADMIN`;
   - `GET /api/passports/:id/cutting-closure-request` — подресурс
     паспорта (UI карточки): возвращает «текущую» заявку для строки
     паспорта (приоритет `APPROVED → REQUESTED → последняя REJECTED`)
     или `null`.
   - Все ошибки — типизированные `BusinessException`:
     `CUTTING_CLOSURE_SIZE_NOT_IN_ORDER`,
     `CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION`,
     `CUTTING_CLOSURE_ALREADY_REQUESTED` (P2002 → 409),
     `CUTTING_CLOSURE_ALREADY_APPROVED`,
     `CUTTING_CLOSURE_REQUEST_NOT_FOUND`,
     `CUTTING_CLOSURE_REQUEST_NOT_PENDING`.

4. **Backend enforcement при выпуске паспорта.**
   `PassportsService.create` после стандартных проверок (статус заказа,
   `qtyCut ≤ remaining`) дополнительно зовёт
   `CuttingClosureService.hasApprovedClosure(orderId, productId, sizeId)`.
   Если есть `APPROVED`-заявка — кидает `PassportCuttingClosedException`
   с кодом `CUTTING_CLOSED` (HTTP 409). Это и есть «фронт можно
   спрятать, но реально режет backend» (ADR-0005, ADR-0014 о принципе
   single source of truth).

5. **План/факт/остаток в DTO заявки.** Каждая заявка отдаёт
   `planFact { qtyPlan, qtyCut, qtyRemaining }`, посчитанные тем же
   способом, что и `aggregateOrder.sizeBreakdown`: `qtyCut = Σ
   passport.qtyCut` по живым паспортам той же строки. Это нужно UI
   (помощнику и мастеру) и одновременно фиксирует контракт без
   «магии» в шаблоне.

6. **UI.** На `/passports/[id]` появляется блок «Закрытие раскроя»
   (`CuttingClosureSection`):
   - `CUTTER_ASSISTANT` без активной заявки — форма «Подать заявку»
     с опциональной причиной;
   - после `REQUESTED` — статус и метаданные, кнопка скрыта;
   - `SHOP_MANAGER` / `ADMIN` поверх `REQUESTED` — кнопки
     `Подтвердить закрытие` / `Отклонить` с опциональной заметкой;
   - после `APPROVED` — пометка «Раскрой закрыт» и пояснение, что
     новые паспорта по этой строке выпустить нельзя;
   - после `REJECTED` — отказ виден всем, помощник может подать
     заявку повторно.

   На `/orders/[id]` менеджер дополнительно видит баннер
   «Закрытие раскроя по размерам» с активными `REQUESTED` и уже
   `APPROVED` заявками и быстрой ссылкой на паспорт нужного размера —
   чтобы решение принималось не через поиск.

7. **Тесты.** Новый `tests/integration/cutting-closure.test.ts`
   фиксирует:
   - помощник может подать заявку, второй `REQUESTED` → 409
     (partial unique index);
   - approve/reject доступны только `SHOP_MANAGER`/`ADMIN`;
     остальные роли — 403 `FORBIDDEN_ROLE`;
   - после `APPROVED` `POST /api/passports` → 409 `CUTTING_CLOSED`;
   - `REJECTED` не блокирует ни выпуск, ни новую заявку;
   - `planFact` совпадает с фактом по живым паспортам;
   - подресурс `/passports/:id/cutting-closure-request` отдаёт
     ожидаемый приоритет.

## 3. Альтернативы

- **Поле `status` на `OrderItem` (`OPEN | CLOSED`).** Выглядит проще,
  но: (1) теряется история «кто/когда/почему/кто подтвердил»;
  (2) требует ввести в сам план флаги, что путает агрегацию;
  (3) нет естественного места для `REJECTED` — пришлось бы городить
  параллельный «лог изменений статуса».

- **Уменьшать `OrderItem.qtyPlan` до факта при закрытии.** Самое
  «дешёвое» с точки зрения остального кода — `qtyRemaining` сразу
  становится 0. Но это противоречит ADR-0006 «План иммутабелен»,
  ломает аналитику «насколько недокроили относительно планового
  заказа» и стирает разницу между «по плану 300, накроили 280,
  закрыли» и «по плану 280, накроили 280».

- **Workflow-движок (states + transitions + roles в одной таблице).**
  Перебор для одного типа заявки. Дороже поддерживать, чем явный
  модуль с тремя статусами.

- **Закрывать раскрой одним нажатием SHOP_MANAGER без заявки от
  помощника.** Лечит «висит вечно», но убирает ровно то, ради чего
  это делалось: явное действие со стороны того, кто в цехе видит
  ткань и фактическое состояние раскроя.

- **Запрещать выпуск паспортов в самом `OrderItem` через флаг
  `cuttingClosed`, дублируя его при approve/reject.** Дублирование
  правды между `OrderItem.cuttingClosed` и
  `CuttingClosureRequest.status` — почти наверняка источник
  будущих рассинхронизаций. Лучше держать одну таблицу, в которой
  и решение, и метаданные, и UNIQUE-инварианты.

## 4. Последствия

- `OrderItem.qtyPlan` остаётся иммутабельным; «недокрой» становится
  явным фактом, а не молчаливым `qtyRemaining > 0`. Аналитика
  «план vs факт» сохраняет смысл.
- `PassportsService.create` приобретает один новый failure-mode —
  `CUTTING_CLOSED` (409). Все остальные пути выпуска (валидация
  статуса заказа, `QTY_EXCEEDS_REMAINING_PLAN`, тариф раскроя)
  работают как раньше; регресс по существующим тестам отсутствует
  (`production-flow`, `pilot-flow`, `current-work` зелёные).
- Появляется новая роль-цепочка `CUTTER_ASSISTANT → SHOP_MANAGER`
  без изменений в `auth/session` (`@Roles` поверх `RolesGuard`,
  ADR-0014).
- `CuttingClosureRequest` участвует в `resetDatabase` тестов —
  отдельный `beforeEach` для нового сьюта не нужен.
- Шопфлор и зарплата сценарием не затронуты: `OperationEntry`,
  `Passport`, `Box` живут параллельно и не зависят от заявок на
  закрытие раскроя.

## 5. Открытые вопросы / future work

- **Авто-закрытие заказа при APPROVED по всем строкам.** Сейчас
  `Order.status` мастер по-прежнему вручную ведёт `IN_PRODUCTION → DONE`.
  Можно научить `OrdersService` подсказывать «все размеры закрыты»
  или предлагать переход. Не делаем сейчас, чтобы не размывать MVP.
- **Уведомления.** В чат/почту `SHOP_MANAGER`-у при `REQUESTED` и
  `CUTTER_ASSISTANT`-у при `APPROVED`/`REJECTED`. Зависит от общего
  notification-каркаса, который мы пока не делаем.
- **Audit-лог.** Сейчас храним метаданные only-essential
  (`requestedAt`/`reviewedAt`/`reviewerNote`/`reason`). Если появится
  общий audit log админских действий — заявки войдут туда же.
- **«Снять» APPROVED.** В MVP — нет (исключительный кейс «передумали»
  через миграцию данных или отдельный admin-инструмент). Партиал
  unique index гарантирует, что обычным API-путём вернуться к
  `REQUESTED` нельзя.
