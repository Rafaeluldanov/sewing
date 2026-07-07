# Интеграция с ERP upgifts (erp.upgifts.ru) — recon + дизайн

> Статус: дизайн зафиксирован 07.07.2026. Код ещё не написан.
> Экосистемная идея: клиент из одного окна покупает несколько продуктов (наш
> швейный ERP + upgifts) и оформляет подписку. Здесь описана **точечная
> интеграция двух продуктов по API** (не экосистемный слой — он отдельно).

## 1. Зафиксированные решения

| Вопрос | Решение |
|---|---|
| Объём | Точечная интеграция sewing ↔ upgifts + раздел в настройках. Каждый продукт автономен. |
| Граница продуктов | **sewing = швейный цех** (раскрой/пошив/ОТК/упаковка). **upgifts = коммерция/MRP.** Заказы на пошив → sewing; статусы + себестоимость (план/факт) → upgifts. Их модуль `production` — для не-швейных товаров. |
| Топология (v1) | **sewing = клиент в обе стороны**: опрашиваем их заказы (pull) + пушим статусы/себестоимость (push). Свою inbound-API НЕ поднимаем — у upgifts нет исходящих вебхуков, их REST закрывает и чтение, и запись. |
| Аутентификация исходящих | **Сервисный аккаунт per-org**: `tenant`+`email`+`password` в наших настройках → `POST /auth/token` → короткоживущий Bearer (RS256), авто-рефреш через `/auth/refresh`. |
| Секреты | **Шифруем at-rest** (храним реальный пароль к чужой системе; плейнтекст `agentToken`-style неприемлем). Первый шифруемый секрет в проекте. |

## 2. Что такое upgifts (из openapi.json, 07.07.2026)

- FastAPI (openapi 3.1), `ERP Platform`, **мультитенантная database-per-tenant, модульный монолит**, модули под `/api/v1/<mod>`, межмодульные связи через soft-FK и события (`erp.core.events`). Та же архитектурная модель, что у нас.
- Base URL при разведке: `http://159.194.208.75:8000` (dev). Публичный iss в токене: `https://erp.upgifts.ru`.
- Аутентификация: единственная securityScheme `HTTPBearer` (JWT RS256). `GET /auth/jwks` — публичные ключи. Токен несёт `tenant_id`, `scopes[]`, `roles[]`. Проверено живым токеном: `/auth/me` возвращает принципала; тенант разведки **пустой** (0 заказов/товаров/контрагентов) — поэтому контракты взяты из OpenAPI, не из живых данных.
- Модули (tags): `platform, auth, nsi, orders, marketplace, settlement, prod, production, procurement, treasury, edo, ai`.
- **ВАЖНО:** у upgifts УЖЕ есть свой производственный модуль `production` (calcs, произв.заказы, операции start/finish/defect, терминал, `fact/outputs`, свой агент печати). Отсюда явная граница (см. §1) — не дублируем.

## 3. Контракты upgifts, которые используем

### Auth
- `POST /auth/token` — `LoginIn { tenant, email, password }` → access+refresh.
- `POST /auth/refresh` — refresh → access+refresh.
- `GET /auth/me` — Principal `{ user_id, tenant_id, scopes[], roles[] }`.

### Заказы (читаем) — `orders`
- `GET /api/v1/orders/` → `OrderListItem[]` (пагинация): `id, number, date, counterparty_id, organization_id, amount_total, customer_order_status, customer_order_state, production_status?, calc_ref?, shipment_date?`.
- `GET /api/v1/orders/{id}` → `OrderWithItemsOut` (+ `items: OrderItemOut[]`, `source`, `is_marketplace`, `subdivision_id`, `warehouse_id`).
- `GET /api/v1/orders/{id}/structure` → `DocStructOut`.
- `OrderItemOut`: `line_no, product_id, product_name, product_code, product_color, characteristic_id, characteristic_name, unit_id, qty, price, ext_article, ext_name, requires_marking, marked_qty`.
- Триггер «готово к производству»: `POST /api/v1/orders/{id}/ready-for-production`; смена статуса — `POST /api/v1/orders/{id}/status`.
- **Enums заказа:**
  - `CustomerOrderStatus`: `not_approved | to_supply | to_ship | closed` (грубый).
  - `CustomerOrderState`: `awaiting_approval | awaiting_advance_before_supply | ready_for_supply | awaiting_prepayment_before_shipment | awaiting_supply | ready_for_shipment | shipping_in_progress | awaiting_ownership_transfer | awaiting_payment_after_shipment | ready_for_closing | closed`. Явного «в производстве» нет — фаза производства ≈ снабжение/поставка (`awaiting_supply` → `ready_for_supply`).

### Себестоимость (пушим) — `nsi`  ★ первый слайс
- `POST /api/v1/nsi/costs:write` — `CostWriteIn { items: CostWriteItem[] }` → `CostWriteOut { written }`. **Upsert по dims+date.**
- `CostWriteItem` (req: `product_id, cost_per_unit, valid_from`):
  ```
  product_id: uuid
  characteristic_id?: uuid           // вариант (цвет/размер) у них
  organization_id?: uuid
  cost_per_unit: number|string
  extra_cost_per_unit?: number = 0
  currency_code?: string             // "RUB"
  source: CostSource = "manual"      // ставим "external"
  cost_confidence: CostConfidence = "actual"
  valid_from: date
  ```
- `CostSource`: `manual | import | external | internal_actual`.
- `CostConfidence`: `actual | provisional`.

### Номенклатура / матч — `nsi`
- `POST /api/v1/nsi/resolve/nomenclature` — `{ items: ResolveKey[] }` → `ResolveNomenclatureOut { items: ResolveResult[] }`. `ResolveKey { key, key_type }` (матч по артикулу/штрихкоду/внешнему id).
- `GET /api/v1/nsi/products` → `{ items: ProductOut[], page }`. `ProductOut`: `id, code, name, nomenclature_type, gtin, uses_characteristics, uses_series, is_set, is_marked, extra{json}, ...`. Товары могут иметь **characteristics** (варианты) — ложится на наши size/color.
- Прецедент маппинга (их marketplace): `ProductMapping { account_id, marketplace, match_key, product_id, characteristic_id?, packaging_id?, multiplier }`. Мы зеркалим этот паттерн на нашей стороне.

### Контрагенты — `nsi`
- `GET /api/v1/nsi/counterparties` → `CounterpartyOut[]`: `id, code, name, full_name, inn, kpp, legal_form, partner_id?, is_archived`. `CounterpartyRole`: `client | supplier`.

### Производство (НЕ используем в v1)
- `POST /api/v1/production/fact/outputs` (`OutputCreateRequest`) существует, но по границе §1 в их производство мы не пишем — только cost + статус заказа.

## 4. Модель данных на нашей стороне (sewing)

Новый модуль `apps/api/src/modules/integrations/` (шаблон — `push`), регистрируется в `app.module.ts`. Шаред-контракт — `packages/shared/src/integration.ts` (Zod). Фича под флагом (mirror `FEATURE_COLORWAYS`): `FEATURE_ERP_INTEGRATION` (OFF прод / ON dev).

- `IntegrationSettings` (singleton, как `CompanySettings`): `upgiftsEnabled`, `upgiftsBaseUrl`, `upgiftsTenant`, `upgiftsEmail`, `upgiftsPasswordEnc` (**шифр at-rest**), `upgiftsOrganizationId?`, `lastTokenAt?`, статусы последних синков.
- `IntegrationProductMap`: `patternItemId/productId (наш) ↔ upgiftsProductId + upgiftsCharacteristicId?`, `matchKey`, `multiplier`. Основа для cost-выгрузки и приёма заказов.
- `IntegrationOrderMap`: `orderId (наш) ↔ upgiftsOrderId`, статус синхронизации. Нужен, чтобы знать, куда слать статусы/себестоимость.
- Crypto-util: AES-GCM на мастер-ключе из env (`INTEGRATION_SECRET_KEY`), decrypt только в рантайме исходящего вызова.

## 5. Маппинг (анти-коррупционный слой)

Ядро sewing не подстраиваем под upgifts — между ними адаптер:
- **Себестоимость →** `CostWriteItem`: наш `OrderProductionDocumentService.getDocument(orderId)` (эндпоинт `GET /api/admin/production-cost/order/:id/document`) уже отдаёт `planUnitCostRub`/`factUnitCostRub`. Шлём 2 строки: план → `cost_confidence: provisional`, факт → `actual`, `source: external`, `product_id`/`characteristic_id` из `IntegrationProductMap`, `valid_from` = дата заказа, `currency_code: RUB`.
- **Заказ upgifts → наш production order:** `OrderWithItemsOut.items[].product_id` → `IntegrationProductMap` → наше лекало/`Product`; `qty` → `qtyPlan`; `product_color`/`characteristic` → наш цвет/размер. Создание — через `OrdersService.create(CreateOrderDto)`.
- **Статус:** событие паспорта/готовности sewing → `POST /orders/{upgiftsOrderId}/status` (маппинг наших статусов в `CustomerOrderState`).
- **Идентичность:** их сущности — UUID; храним соответствия в map-таблицах. Номенклатуру матчим через `resolve/nomenclature` по общему ключу (артикул/штрихкод), с fallback на ручной экран сопоставления в настройках.

## 6. Фазы (рекомендованный порядок)

1. **Каркас + настройки + аутентификация.** Модуль, `IntegrationSettings`, crypto-util, upgifts-клиент (`/auth/token` + refresh + Bearer), раздел «Интеграции» в company-settings, «Проверить соединение» (`GET /auth/me`). Не зависит от бизнес-контрактов.
2. **★ Выгрузка себестоимости план/факт** → `nsi/costs:write`. Самый ценный и низкорисковый слайс: контракт полный, бэкенд-источник (`getDocument`) уже есть, у них идемпотентный upsert. Нужен `IntegrationProductMap` (хотя бы ручной матч).
3. **Пуш статусов** производства → `orders/{id}/status`.
4. **Приём заказов** upgifts → наш production order (самый крупный/рисковый: матч номенклатуры + маппинг полей заказа + резолв лекала/маршрута).
5. **Справочники + контрагенты** (полный двусторонний синк).

## 7. Открытые вопросы (для Фаз 3–4)

- Точный триггер «заказ ушёл в пошив» на стороне upgifts (какой `CustomerOrderState`/эндпоинт наблюдаем при pull).
- Ключ матча номенклатуры: артикул? штрихкод (`gtin`)? отдельный внешний код? (нужен общий у обоих).
- Маппинг наших статусов паспорта → `CustomerOrderState`.
- Как заводится `IntegrationProductMap` первично: авто по `resolve/nomenclature` или ручной экран.
- `organization_id` / `characteristic_id` у них обязательны для части операций — как выбираем per-order.

## 8. Эксплуатация / безопасность

- Per-tenant: настройки живут в БД тенанта (у нас DB-per-tenant); каждый тенант — своя связка с upgifts.
- Шифрование пароля at-rest (AES-GCM), мастер-ключ в env, не в БД.
- Каденс опроса заказов — конфигурируемый; начать с ручной кнопки + периодического пула.
- Fail-soft: исходящие вызовы не роняют основной флоу (стиль `push.service` — всё в try/catch, лог).
- Разведка велась живым токеном тенанта `659341d4-…` (dev). Токен короткоживущий (~15 мин), в репозиторий не коммитится.
