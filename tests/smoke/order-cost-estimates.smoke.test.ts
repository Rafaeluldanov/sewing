/**
 * Smoke-тесты для этапа «Себестоимость заказа» (см. ТЗ
 * «Доработать Потребность цеха до полноценного процесса просчёта
 * себестоимости заказа»).
 *
 * Source-of-truth:
 *   - Prisma:    `prisma/schema.prisma` (`OrderStatus.CALCULATION_DONE`,
 *                модели `OrderCostEstimate` / `OrderCostEstimateLine`,
 *                snapshot-поля `Order.costEstimate*`),
 *                миграция
 *                `prisma/migrations/20260520100000_add_order_cost_estimates`.
 *   - Shared:    `packages/shared/src/money.ts`
 *                (`MONEY_CURRENCIES` / `MoneyCurrencySchema`),
 *                `packages/shared/src/order-cost-estimates.ts`
 *                (`CompleteOrderCalculationSchema`,
 *                 `ReopenOrderCalculationSchema`,
 *                 `OrderCostEstimateDto`,
 *                 `ORDER_COST_ESTIMATE_STATUSES`,
 *                 `ORDER_COST_ESTIMATE_LINE_KINDS`),
 *                расширения `OrderStatus` / `OrderDetailDto` в
 *                `packages/shared/src/orders.ts`,
 *                сужение `quotedCurrency` до RUB/USD в
 *                `packages/shared/src/workshop-needs.ts`.
 *   - Backend:   `apps/api/src/modules/orders/order-cost-estimates.service.ts`,
 *                `apps/api/src/modules/orders/orders.controller.ts`
 *                (`POST /api/orders/:id/complete-calculation`,
 *                 `POST /api/orders/:id/reopen-calculation`),
 *                ошибки `ORDER_CALCULATION_INCOMPLETE` /
 *                `ORDER_CALCULATION_INVALID_STATUS` /
 *                `ORDER_CALCULATION_USD_RATE_REQUIRED` в
 *                `apps/api/src/common/errors.ts`.
 *   - Web:       `apps/web/app/admin/workshop-needs/page.tsx`
 *                (`view=lines` inline-edit), `inline-edit-row.tsx`,
 *                `complete-calculation-form.tsx`,
 *                `apps/web/app/admin/orders/[id]/page.tsx`
 *                (блок «Себестоимость», workflow CALCULATION_DONE),
 *                компоненты `order-cost-estimate-card.tsx` /
 *                `reopen-calculation-button.tsx`,
 *                server-actions
 *                `apps/web/app/orders/actions.ts` (`completeOrderCalculationAction`,
 *                 `reopenOrderCalculationAction`).
 *
 * Все проверки — source-level (как и остальные smoke-тесты).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(path.join(repoRoot, relativePath));
}

// ---------------------------------------------------------------------------
// 1. Shared money / order-cost-estimates
// ---------------------------------------------------------------------------

describe('Shared — money + order-cost-estimates', () => {
  test('money.ts фиксирует валюты RUB / USD', () => {
    const src = read('packages/shared/src/money.ts');
    expect(src).toMatch(/MONEY_CURRENCIES\s*=\s*\['RUB',\s*'USD'\]/);
    expect(src).toMatch(/MONEY_CURRENCY_LABELS/);
    expect(src).toMatch(/RUB:\s*['"]₽ Рубли['"]/);
    expect(src).toMatch(/USD:\s*['"]\$ Доллары['"]/);
    expect(src).toMatch(/MoneyCurrencySchema\s*=\s*z\.enum\(MONEY_CURRENCIES\)/);
  });

  test('barrel @sewing/shared экспортирует money + order-cost-estimates', () => {
    const idx = read('packages/shared/src/index.ts');
    expect(idx).toMatch(/export \* from '\.\/money'/);
    expect(idx).toMatch(/export \* from '\.\/order-cost-estimates'/);
  });

  test('order-cost-estimates.ts: статусы / kinds / схемы DTO', () => {
    const src = read('packages/shared/src/order-cost-estimates.ts');
    expect(src).toMatch(
      /ORDER_COST_ESTIMATE_STATUSES\s*=\s*\['COMPLETED',\s*'REVOKED'\]/,
    );
    // ORDER_COST_ESTIMATE_LINE_KINDS объявлен многострочно — проверяем
    // только наличие перечисленных значений рядом с именем константы.
    expect(src).toMatch(
      /ORDER_COST_ESTIMATE_LINE_KINDS\s*=\s*\[[\s\S]*?'MATERIAL'[\s\S]*?'HARDWARE'[\s\S]*?'APPLICATION'[\s\S]*?'OTHER'[\s\S]*?\]/,
    );
    expect(src).toMatch(/CompleteOrderCalculationSchema\s*=\s*z\.object/);
    expect(src).toMatch(/ReopenOrderCalculationSchema\s*=\s*z\.object/);
    expect(src).toMatch(/usdRateRub:/);
    expect(src).toMatch(/comment:/);
    expect(src).toMatch(/reason:/);
    expect(src).toMatch(/interface OrderCostEstimateDto\b/);
    expect(src).toMatch(/interface OrderCostEstimateLineDto\b/);
  });

  test('OrderStatus в shared/orders.ts расширен значением CALCULATION_DONE', () => {
    const src = read('packages/shared/src/orders.ts');
    expect(src).toMatch(/'CALCULATION_DONE'/);
    expect(src).toMatch(
      /ORDER_STATUS_LABELS[\s\S]*?CALCULATION_DONE:\s*['"]Расчёт завершён['"]/,
    );
  });

  test('OrderDetailDto расширен полями costEstimate*', () => {
    const src = read('packages/shared/src/orders.ts');
    expect(src).toMatch(/costEstimateTotalRub\?:/);
    expect(src).toMatch(/costEstimateCompletedAt\?:/);
    expect(src).toMatch(/costEstimateVersion\?:/);
    expect(src).toMatch(/currentCostEstimate\?:/);
  });

  test('quotedCurrency в WorkshopNeed сужен до MoneyCurrencySchema (RUB/USD)', () => {
    const src = read('packages/shared/src/workshop-needs.ts');
    // Импорт из ./money + использование в QuotedCurrencyField.
    expect(src).toMatch(/from '\.\/money'/);
    expect(src).toMatch(/MoneyCurrencySchema/);
    // QuotedCurrencyField не должен принимать произвольный текст.
    expect(src).toMatch(/QuotedCurrencyField:[\s\S]*?MoneyCurrencySchema/);
  });
});

// ---------------------------------------------------------------------------
// 2. Prisma schema + migration
// ---------------------------------------------------------------------------

describe('Prisma — модели OrderCostEstimate(+Line) и snapshot Order', () => {
  const schema = read('prisma/schema.prisma');

  test('enum OrderStatus содержит CALCULATION_DONE', () => {
    expect(schema).toMatch(/enum OrderStatus\s*\{[\s\S]*?CALCULATION_DONE/);
  });

  test('Order имеет snapshot-поля costEstimate*', () => {
    expect(schema).toMatch(/costEstimateTotalRub\s+Decimal\?/);
    expect(schema).toMatch(/costEstimateCompletedAt\s+DateTime\?/);
    expect(schema).toMatch(/costEstimateVersion\s+Int\?/);
    expect(schema).toMatch(/costEstimates\s+OrderCostEstimate\[\]/);
  });

  test('модель OrderCostEstimate определена и имеет нужные FK', () => {
    expect(schema).toMatch(/model OrderCostEstimate\s*\{/);
    // Cascade на удаление заказа.
    expect(schema).toMatch(
      /order\s+Order\s+@relation\(fields:\s*\[orderId\][^\)]*onDelete:\s*Cascade/,
    );
    expect(schema).toMatch(
      /completedBy\s+Employee\?\s+@relation\("OrderCostEstimateCompleter"/,
    );
    expect(schema).toMatch(
      /revokedBy\s+Employee\?\s+@relation\("OrderCostEstimateRevoker"/,
    );
    // Уникальность (orderId, version).
    expect(schema).toMatch(/@@unique\(\[orderId,\s*version\]\)/);
    // Status default COMPLETED.
    expect(schema).toMatch(/status\s+String\s+@default\("COMPLETED"\)/);
  });

  test('модель OrderCostEstimateLine определена и связана с WorkshopNeed (SetNull)', () => {
    expect(schema).toMatch(/model OrderCostEstimateLine\s*\{/);
    expect(schema).toMatch(
      /workshopNeed\s+WorkshopNeed\?\s+@relation\(fields:\s*\[workshopNeedId\][^\)]*onDelete:\s*SetNull/,
    );
    // Денежные поля.
    // quotedPrice расширен до 14,4 — нужен для цены ниток (₽/м), см.
    // миграцию 20260806100000_widen_quoted_price_decimals.
    expect(schema).toMatch(/quotedPrice\s+Decimal\s+@db\.Decimal\(14,\s*4\)/);
    expect(schema).toMatch(/lineTotalRub\s+Decimal\s+@db\.Decimal\(14,\s*2\)/);
  });

  test('миграция additive: ALTER TYPE и две новые таблицы', () => {
    const migrationPath =
      'prisma/migrations/20260520100000_add_order_cost_estimates/migration.sql';
    expect(exists(migrationPath)).toBe(true);
    const sql = read(migrationPath);
    expect(sql).toMatch(
      /ALTER TYPE\s+"OrderStatus"\s+ADD VALUE\s+'CALCULATION_DONE'/,
    );
    expect(sql).toMatch(/CREATE TABLE\s+"OrderCostEstimate"/);
    expect(sql).toMatch(/CREATE TABLE\s+"OrderCostEstimateLine"/);
    // Уникальный индекс (orderId, version).
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX\s+"OrderCostEstimate_orderId_version_key"/,
    );
    // FK SetNull для workshopNeedId на строке расчёта.
    expect(sql).toMatch(
      /OrderCostEstimateLine_workshopNeedId_fkey[\s\S]*?ON DELETE SET NULL/,
    );
    // ALTER TABLE Order добавляет три колонки snapshot.
    expect(sql).toMatch(/ALTER TABLE\s+"Order"[\s\S]*?costEstimateTotalRub/);
    expect(sql).toMatch(
      /ALTER TABLE\s+"Order"[\s\S]*?costEstimateCompletedAt/,
    );
    expect(sql).toMatch(/ALTER TABLE\s+"Order"[\s\S]*?costEstimateVersion/);
  });
});

// ---------------------------------------------------------------------------
// 3. API endpoints / errors / service
// ---------------------------------------------------------------------------

describe('API — complete-calculation / reopen-calculation', () => {
  test('OrdersController объявляет POST /:id/complete-calculation и /:id/reopen-calculation', () => {
    const src = read('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(/@Post\(['"]:id\/complete-calculation['"]\)/);
    expect(src).toMatch(/@Post\(['"]:id\/reopen-calculation['"]\)/);
    // Schema-валидация через Zod-pipe.
    expect(src).toMatch(/CompleteOrderCalculationSchema/);
    expect(src).toMatch(/ReopenOrderCalculationSchema/);
  });

  test('OrderCostEstimatesService существует с методами completeCalculation / reopenCalculation', () => {
    const path =
      'apps/api/src/modules/orders/order-cost-estimates.service.ts';
    expect(exists(path)).toBe(true);
    const src = read(path);
    expect(src).toMatch(/async completeCalculation\(/);
    expect(src).toMatch(/async reopenCalculation\(/);
    // Эта же служба читает активный расчёт для DTO.
    expect(src).toMatch(/async getActiveEstimateForOrder\(/);
    // Курс USD: при USD-строках обязателен.
    expect(src).toMatch(/OrderCalculationUsdRateRequiredException/);
    // Incomplete: собираем список проблемных строк.
    expect(src).toMatch(/OrderCalculationIncompleteException/);
    // Audit-события.
    expect(src).toMatch(/'ORDER_COST_ESTIMATE_CREATED'/);
    expect(src).toMatch(/'ORDER_CALCULATION_COMPLETED'/);
    expect(src).toMatch(/'ORDER_CALCULATION_REOPENED'/);
  });

  test('OrdersModule регистрирует OrderCostEstimatesService', () => {
    const src = read('apps/api/src/modules/orders/orders.module.ts');
    expect(src).toMatch(/OrderCostEstimatesService/);
  });

  test('OrdersService.toDetailDto подгружает currentCostEstimate', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/currentCostEstimate/);
    expect(src).toMatch(/getActiveEstimateForOrder/);
    // Snapshot-поля заполнены в DTO.
    expect(src).toMatch(/costEstimateTotalRub:/);
  });

  test('OrdersService.start принимает CALCULATION_DONE как валидный исходный статус', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/OrderStatus\.CALCULATION_DONE/);
  });

  test('Бизнес-ошибки добавлены в errors.ts с ожидаемыми кодами', () => {
    const src = read('apps/api/src/common/errors.ts');
    expect(src).toMatch(/'ORDER_CALCULATION_INCOMPLETE'/);
    expect(src).toMatch(/'ORDER_CALCULATION_INVALID_STATUS'/);
    expect(src).toMatch(/'ORDER_CALCULATION_USD_RATE_REQUIRED'/);
    expect(src).toMatch(/class OrderCalculationIncompleteException/);
    expect(src).toMatch(/class OrderCalculationInvalidStatusException/);
    expect(src).toMatch(/class OrderCalculationUsdRateRequiredException/);
  });

  test('AuditService знает entityType ORDER_COST_ESTIMATE', () => {
    const src = read('apps/api/src/modules/audit/audit.service.ts');
    expect(src).toMatch(/'ORDER_COST_ESTIMATE'/);
  });
});

// ---------------------------------------------------------------------------
// 4. Web — inline edit + complete/reopen
// ---------------------------------------------------------------------------

describe('Web — /admin/workshop-needs inline edit', () => {
  test('inline-edit-row.tsx использует MoneyCurrencies и server-action update', () => {
    const path = 'apps/web/app/admin/workshop-needs/inline-edit-row.tsx';
    expect(exists(path)).toBe(true);
    const src = read(path);
    expect(src).toMatch(/MONEY_CURRENCIES/);
    expect(src).toMatch(/MONEY_CURRENCY_LABELS/);
    expect(src).toMatch(/updateWorkshopNeedAction/);
    // Поля inline: purchaseQty / quotedPrice / quotedCurrency /
    // expectedDeliveryDate / supplierNameText / status / comment.
    expect(src).toMatch(/name="purchaseQty"/);
    expect(src).toMatch(/name="quotedPrice"/);
    expect(src).toMatch(/name="quotedCurrency"/);
    expect(src).toMatch(/name="expectedDeliveryDate"/);
    expect(src).toMatch(/name="supplierNameText"/);
    expect(src).toMatch(/name="status"/);
    expect(src).toMatch(/name="comment"/);
    // Кнопка «Сохранить».
    expect(src).toMatch(/Сохранить/);
  });

  test('page.tsx (workshop-needs) рендерит inline-edit в группировке по заказу', () => {
    // Единственный режим — группировка по заказу: строки рисуются
    // `<InlineEditWorkshopNeedRow>` внутри `OrderNeedGroupCard`/
    // `NeedSection`. Прежний построчный режим (NeedsLinesList /
    // showOrderInfo) удалён.
    const src = read('apps/web/app/admin/workshop-needs/page.tsx');
    expect(src).toMatch(/InlineEditWorkshopNeedRow/);
    expect(src).toMatch(/NeedSection/);
    expect(src).not.toMatch(/NeedsLinesList/);
    expect(src).not.toMatch(/showOrderInfo/);
    // CompleteCalculationForm появляется в grouped view.
    expect(src).toMatch(/CompleteCalculationForm/);
  });

  test('complete-calculation-form.tsx использует server-action', () => {
    const path =
      'apps/web/app/admin/workshop-needs/complete-calculation-form.tsx';
    expect(exists(path)).toBe(true);
    const src = read(path);
    expect(src).toMatch(/completeOrderCalculationAction/);
    expect(src).toMatch(/usdRateRub/);
    expect(src).toMatch(/Завершить расчёт/);
  });

  test('quotedCurrency select содержит только MONEY_CURRENCIES (нет input free-text)', () => {
    const src = read('apps/web/app/admin/workshop-needs/inline-edit-row.tsx');
    expect(src).toMatch(
      /<select[^>]*name="quotedCurrency"[\s\S]*?MONEY_CURRENCIES\.map/,
    );
  });
});

describe('Web — /admin/orders/[id] block «Себестоимость»', () => {
  const path = 'apps/web/app/admin/orders/[id]/page.tsx';
  const src = read(path);

  test('aggregate cost-card доступен через OrderNeedsTab → OrderPlannedCostSummaryCard', () => {
    // Order management redesign: финансовая сводка вернулась
    // отдельной вкладкой «Сводно по заказу» (`?tab=costSummary` →
    // `OrderSummaryTab` → `OrderSummaryUnifiedTable`). В Needs мы
    // по-прежнему НЕ ставим итемизированный cost breakdown (он
    // дублирует материалы и операции рядом с
    // `OrderMaterialsUnifiedTable`), а оставляем компактный
    // aggregate-only блок `OrderPlannedCostSummaryCard`: материалы
    // / фурнитура / нанесение / операции / итого + «за 1 изделие».
    // Полный построчный cost breakdown
    // (`OrderSummaryUnifiedTable`) живёт строго в новой вкладке
    // costSummary — у вкладок разные роли (procurement state vs
    // финансовая картина), и это не считается дублированием.
    expect(src).toMatch(/<OrderNeedsTab\b/);
    expect(src).toMatch(/<OrderSummaryTab\b/);
    expect(src).toMatch(/activeTab === 'costSummary'/);
    expect(src).not.toMatch(/<OrderCostEstimateCard\b/);
    const needsTabSrc = read(
      'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
    );
    expect(needsTabSrc).toMatch(/<OrderPlannedCostSummaryCard\b/);
    expect(needsTabSrc).not.toMatch(/<OrderSummaryUnifiedTable\b/);
  });

  test('OrderCostEstimateCard файл всё ещё содержит итог / breakdown / версию (legacy-карточка)', () => {
    const cardPath =
      'apps/web/components/orders/order-cost-estimate-card.tsx';
    expect(exists(cardPath)).toBe(true);
    const card = read(cardPath);
    expect(card).toMatch(/Себестоимость/);
    expect(card).toMatch(/totalCostRub|costEstimateTotalRub/);
    expect(card).toMatch(/ORDER_COST_ESTIMATE_LINE_KIND_LABELS/);
  });

  test('Workflow: «Завершить расчёт» — отдельная форма на /admin/workshop-needs', () => {
    // CTA «Завершить расчёт» исторически живёт на странице
    // `/admin/workshop-needs` через `complete-calculation-form.tsx`
    // — это backend-flow закупщика, на admin-карточке заказа он
    // не размещается (см. `OrderManagementHeader`: нет `showStartProd`
    // → есть `StartProductionButton`, кнопки «Завершить расчёт» в
    // hero нет). Проверяем сам факт существования формы.
    const formPath =
      'apps/web/app/admin/workshop-needs/complete-calculation-form.tsx';
    expect(exists(formPath)).toBe(true);
    const formSrc = read(formPath);
    expect(formSrc).toMatch(/Завершить расчёт/);
    expect(formSrc).toMatch(/completeOrderCalculationAction/);
  });

  test('Workflow: CALCULATION_DONE → «Запустить в производство» + «Вернуть на пересчёт» в OrderManagementHeader', () => {
    const headerSrc = read(
      'apps/web/components/orders/view/order-management-header.tsx',
    );
    expect(headerSrc).toMatch(/CALCULATION_DONE/);
    expect(headerSrc).toMatch(/<ReopenCalculationButton\b/);
    expect(headerSrc).toMatch(/<StartProductionButton\b/);
  });

  test('ReopenCalculationButton использует server-action reopenOrderCalculationAction', () => {
    const btnPath =
      'apps/web/components/orders/reopen-calculation-button.tsx';
    expect(exists(btnPath)).toBe(true);
    const btn = read(btnPath);
    expect(btn).toMatch(/reopenOrderCalculationAction/);
    expect(btn).toMatch(/Вернуть на пересчёт/);
  });
});

// ---------------------------------------------------------------------------
// 5. Server actions
// ---------------------------------------------------------------------------

describe('Web — server actions complete/reopen calculation', () => {
  const actions = read('apps/web/app/orders/actions.ts');

  test('completeOrderCalculationAction проксирует в API', () => {
    expect(actions).toMatch(/export async function completeOrderCalculationAction/);
    expect(actions).toMatch(/completeOrderCalculation\(/);
    expect(actions).toMatch(/usdRateRub/);
    expect(actions).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });

  test('reopenOrderCalculationAction проксирует в API', () => {
    expect(actions).toMatch(/export async function reopenOrderCalculationAction/);
    expect(actions).toMatch(/reopenOrderCalculation\(/);
    expect(actions).toMatch(/reason/);
  });

  test('orders-api.ts экспортирует completeOrderCalculation / reopenOrderCalculation', () => {
    const api = read('apps/web/lib/orders-api.ts');
    expect(api).toMatch(/export function completeOrderCalculation/);
    expect(api).toMatch(/export function reopenOrderCalculation/);
    expect(api).toMatch(/\/complete-calculation/);
    expect(api).toMatch(/\/reopen-calculation/);
  });
});
