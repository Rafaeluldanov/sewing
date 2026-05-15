# Order signal sample flow (MVP)

> Источник истины — код:
> - `apps/api/src/modules/order-samples/*`
> - `packages/shared/src/order-samples.ts`
> - `prisma/schema.prisma::OrderSample` / `OrderSampleStatus` / `OrderSampleMaterialMode`
> - `apps/web/components/orders/samples/*`
> - `apps/web/app/admin/orders/[id]/order-samples-actions.ts`
>
> Контекстный RECON: [`docs/order-signal-sample-recon.md`](order-signal-sample-recon.md).
> API таблица: [`docs/api.md §24b`](api.md#24b-order-samples).
> Аудит: [`docs/events.md §3a`](events.md).

---

## 1. Что это и зачем

«Сигнальный образец» — отдельный sample-flow внутри заказа. Менеджер
запускает образец перед тиражом, чтобы:
- проверить лекало / маршрут / материал «в железе»;
- показать клиенту первую штуку;
- зафиксировать решение «согласовано / отклонено».

Это **не** новая ось производства, не новая роль и не новый
production-flow. Sample-passport создаётся стандартным
`PassportsService.create` и движется по обычному маршруту.
Отличается одним полем: `Passport.sampleId !== null`.

---

## 2. Сущности

- **`OrderSample`** — сама единица учёта образца:
  `id, orderId, productId, sizeId, qty, routeTemplateId?,
  materialMode, countsTowardOrderQty, status, comment?,
  rejectionReason?, createdById?, approvedById?, rejectedById?,
  createdAt, approvedAt?, rejectedAt?, cancelledAt?, updatedAt`.

- **`Passport.sampleId? @unique`** — sample-passport ссылается на
  `OrderSample`. Тиражные паспорта — `sampleId = null`.

- **`OrderSampleStatus`**:
  `IN_PROGRESS → APPROVED | REJECTED | CANCELLED`. Значение
  `READY_FOR_APPROVAL` зарезервировано (MVP не использует, см. RECON §2.11).

- **`OrderSampleMaterialMode`**:
  - `SAMPLE_ONLY` — материалы считаем **только на образец** (UI
    preview, в `WorkshopNeed` ничего не пишем).
  - `FULL_ORDER` — материалы считаем сразу на весь заказ через
    существующий `WorkshopNeedsService.calculateForOrder` (отдельная
    кнопка «Потребности цеха» в карточке заказа).

---

## 3. Switch «Включить образец в тираж» (`countsTowardOrderQty`)

UI — `<input type="checkbox" role="switch" name="countsTowardOrderQty">`,
default `false`.

| Значение | Текст-подсказка | Семантика |
|---|---|---|
| `false` (default) | «Образец будет отдельной единицей сверх тиража. Количество заказа не уменьшится.» | Образец **не** входит в тираж. `OrderItem.qtyPlan` не меняется. |
| `true` | «После согласования образец будет засчитан в количество заказа по выбранному размеру.» | Образец входит в тираж. После согласования (логически) к тиражу остаётся `qtyPlan − qty`. |

`OrderItem.qtyPlan` **никогда не мутируется** MVP-кодом — эффект
считается в DTO `OrderSampleBulkEffectDto.remainingQty`:

```
remainingQty =
  countsTowardOrderQty && status ∈ {IN_PROGRESS, READY_FOR_APPROVAL, APPROVED}
    ? max(qtyPlan − sampleQty, 0)
    : qtyPlan
extraSampleQty =
  !countsTowardOrderQty && status ∈ {IN_PROGRESS, READY_FOR_APPROVAL, APPROVED}
    ? sampleQty
    : 0
```

Примеры из ТЗ (заказ M = 300, sample M = 1):
- `countsTowardOrderQty = true` → `remainingQty = 299`,
  `extraSampleQty = 0`.
- `countsTowardOrderQty = false` → `remainingQty = 300`,
  `extraSampleQty = 1`.

---

## 4. Матрица бизнес-логики

Sample-потребности — это записи `WorkshopNeed` с
`orderSampleId = OrderSample.id` (см.
`prisma/schema.prisma::WorkshopNeed.orderSampleId`,
[`docs/erd.md §2.12`](erd.md)). Тиражные строки имеют
`orderSampleId = null` и считаются отдельным контуром
`WorkshopNeedsService.calculateForOrder`.

| materialMode | countsTowardOrderQty | При запуске образца (sample-needs) | После согласования (bulk-needs) |
|---|---|---|---|
| `SAMPLE_ONLY` | `true` | `WorkshopNeedsService.calculateForSampleInTx` пишет строки с `orderSampleId = sample.id`, формула `qtyPerUnit × sample.qty` для каждой строки техкарты или snapshot-а. | Тираж логически уменьшается на `qty` по размеру. Менеджер запускает «Потребности цеха» (`calculateForOrder`) на остаток тиража. |
| `SAMPLE_ONLY` | `false` | То же — `WorkshopNeed` с `orderSampleId = sample.id`, `qtyPerUnit × sample.qty`. | Тираж не уменьшается. Менеджер запускает «Потребности цеха» на полный тираж. |
| `FULL_ORDER` | `true` | Sample-needs (`orderSampleId = sample.id`) пишутся как и в `SAMPLE_ONLY`. Дополнительно менеджер может запустить «Потребности цеха» (`calculateForOrder`) на весь заказ — две группы строк сосуществуют, фильтруются по `orderSampleId`. | Тираж логически уменьшается на `qty` по размеру. |
| `FULL_ORDER` | `false` | То же — sample-needs пишутся, bulk-needs менеджер запускает отдельно. | Тираж не уменьшается. **Ограничение MVP:** «материал на образец сверху тиража» в bulk-`WorkshopNeed` не выделяется отдельной строкой автоматически — sample-needs живут отдельной плашкой через `orderSampleId`. |

### Что пишется и что не пишется в `WorkshopNeed`

Sample-расчёт **поддерживает** (см.
`WorkshopNeedsService.calculateForSampleInTx`):

- `TechCardMaterialLine` (live) и `OrderMaterialRequirement` (snapshot
  после `OrdersService.start`) — каждая строка превращается в
  `WorkshopNeed` с `qtyPerUnit × sample.qty`;
- цвет, фабрик-тип, плотность, ширину — переносятся из строки
  источника;
- `calculationNote` дополняется маркером
  `«Расчёт на сигнальный образец (qty=N, size=CODE)»`.

Sample-расчёт **сознательно НЕ пишет** в MVP:

- `OrderApplication` (нанесения) — они уже считаются per-order;
- `PatternItemParameterNorm` (фурнитура нормами) — отдельный
  category-driven путь, в sample MVP не входит;
- `PatternItemSizeParameterValue` (погонные метры по размерам) —
  то же;
- `PATTERN_MATERIAL_AREA` для category-driven заказов — sample
  считает только по строкам техкарты / snapshot, без AREA_DENSITY-
  «через лекало». Если у заказа нет техкарты и нет snapshot-а,
  sample-needs **не пишутся** (fail-soft, count=0).

Расширение этих веток — следующая итерация. Bulk-расчёт
(`calculateForOrder`) их поддерживает в полном объёме.

---

## 5. RBAC

- **Старт sample**: `SHOP_MANAGER`, `CUTTER_ASSISTANT` (+ `ADMIN`).
- **Approve / Reject / Cancel**: `SHOP_MANAGER` (+ `ADMIN`).
- **Read**: `SHOP_MANAGER`, `CUTTER_ASSISTANT`, `CUTTER`,
  `SHOPFLOOR_MASTER` (+ `ADMIN`).
- Никаких новых ролей.

---

## 6. Endpoints

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/orders/:orderId/samples/start` | Запускает образец: создаёт `OrderSample(IN_PROGRESS)` + sample-passport (`Passport.sampleId = OrderSample.id`). |
| GET  | `/api/orders/:orderId/samples` | Список образцов заказа. |
| GET  | `/api/order-samples/:id` | Карточка образца. |
| POST | `/api/order-samples/:id/approve` | `IN_PROGRESS → APPROVED`. |
| POST | `/api/order-samples/:id/reject` | `IN_PROGRESS → REJECTED` + `reason`. |
| POST | `/api/order-samples/:id/cancel` | `IN_PROGRESS → CANCELLED`. |

DTO: `packages/shared/src/order-samples.ts`. Доменные ошибки —
`ORDER_SAMPLE_*` (см. `apps/api/src/common/errors.ts`).

---

## 7. Аудит

`AuditEntityType = 'ORDER_SAMPLE'`. События:
`ORDER_SAMPLE_STARTED`, `ORDER_SAMPLE_APPROVED`,
`ORDER_SAMPLE_REJECTED`, `ORDER_SAMPLE_CANCELLED`. См.
[`docs/events.md §3a`](events.md).

---

## 7a. Sample-flow vs bulk-flow (создание passport)

Тиражный `PassportsService.create` (см. [`docs/production-flow.md
§4`](production-flow.md)) сознательно строго требует:

- `cutterId` — обязателен для не-CUTTER ролей (`CUTTER_REQUIRED`),
  иначе 400; должен ссылаться на `Employee` с `role = CUTTER &&
  active = true` (ADR-0005, см. `docs/api.md §24a`);
- immediate-сдельное начисление раскройщику записывается в
  `OperationEntry` в той же транзакции, что и `Passport.create`.

Это правильно для тиража, **но не для сигнального образца**: образец
запускается до того, как раскройщик встаёт за раскрой, маршрут
образца отдельный, и платить за «попробовать лекало» не нужно.

Поэтому `OrderSamplesService.start` создаёт sample-passport
**в отдельной транзакции внутри самого сервиса**, минуя
`PassportsService.create`, и применяет «расслабленную» атрибуцию:

| Поле | Sample-flow | Bulk-flow (`PassportsService.create`) |
|---|---|---|
| `cutterId` | `dto.cutterId` если передан и сотрудник активен, иначе actor (`creatorId`). **Роль не проверяется** | строго `Employee.role = CUTTER && active = true`, иначе `CUTTER_REQUIRED` |
| immediate `OperationEntry` | **не пишется** (payroll out-of-scope для образца) | пишется через `EarningsService.createImmediateForCutter` |
| `currentOperationId` | `CUT_DIVISION` (тот же, что у тиража) | `CUT_DIVISION` |
| `currentRouteStepIndex` | `0`, если у заказа есть `OrderRouteStep[]`, иначе `null` | то же |
| `PassportEvent CREATED` | пишется с `payload.origin = 'ORDER_SAMPLE'` + `sampleId` | пишется без `origin` |
| `qrCode` | `passport:{id}` (см. [`qr.ts`](../apps/api/src/modules/passports/qr.ts)) | то же |
| `sampleId` | `OrderSample.id` (`@unique`) | `null` |

Тиражные паспорта и `PassportsService.create` **не меняются** —
sample-flow живёт отдельной веткой.

---

## 8. MVP-ограничения

1. **`OrderItem.qtyPlan` не мутируется** — эффект на тираж только
   логический (DTO).
2. **`WorkshopNeed` для образца пишется через
   `calculateForSampleInTx`** с `orderSampleId = sample.id` — это
   реальные строки потребности на `qty × qtyPerUnit`. Тиражные
   строки (`orderSampleId = null`) считаются отдельно через
   `calculateForOrder`. Sample-расчёт сознательно скипает
   `OrderApplication` / category-driven `PatternItemParameterNorm` /
   `PatternItemSizeParameterValue` / AREA_DENSITY-через-лекало
   (см. §4 «Что пишется и что не пишется»).
3. **Sample-passport не удаляется автоматически** при `REJECTED` /
   `CANCELLED` — менеджер при необходимости использует штатный
   `DELETE /api/passports/:id`.
4. **Маршрут sample** (`OrderSample.routeTemplateId?`) — метаинформация;
   реального второго `OrderRouteStep` snapshot для образца не создаём.
5. **Multiple active samples** на пару `(orderId, productId, sizeId)`
   запрещены: 409 `ORDER_SAMPLE_ALREADY_ACTIVE`. После REJECTED /
   CANCELLED можно запустить новый.
6. **Auto-launch тиража после APPROVED не делаем** — менеджер
   решает вручную.
7. **Никаких новых ролей**, никаких изменений payroll / materials /
   packing / QC / WTO / PLT / CutLay / CutReleasePolicy /
   OrderCutIssueRule бизнес-логики.

---

## 9. UI

Карточка заказа `/admin/orders/[id]` — таб `signalSample`
(см. [`docs/screens.md §7`](screens.md)). Компоненты:
- `OrderSamplesCard` — список + кнопка «Запустить образец»;
- `StartOrderSampleModal` — inline-форма;
- `OrderSampleStatusBadge` — бейдж статуса;
- `OrderSampleEffectPreview` — таблица «Материалы / Включить в тираж /
  Сейчас / После согласования».
- `apps/web/lib/order-samples-api.ts` — типизированные fetch-обёртки.

Никакого добавления в sidebar / административное меню не делаем.
