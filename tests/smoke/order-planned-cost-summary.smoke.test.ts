/**
 * Smoke-тесты для блока «Плановая себестоимость» в карточке заказа
 * `/admin/orders/[id]` (см.
 * `apps/web/components/orders/order-planned-cost-summary-card.tsx`).
 *
 * Это UI/API polish: backend / Prisma / `OrderCostEstimate.completeCalculation`
 * / `WorkshopNeedsService` / payroll / `Passport` / `OperationEntry` /
 * `SalaryEntry` / `PurchaseOrder` / `PurchaseReceipt` НЕ изменялись.
 * Соответствующие guard-проверки живут в `order-operation-plan.smoke.test.ts`
 * (общая защита «LABOR в OrderCostEstimate ещё не добавлен» и т.д.) —
 * здесь дублируем только то, что описывает именно эту итерацию.
 *
 * Source-of-truth:
 *   - Web component: `apps/web/components/orders/order-planned-cost-summary-card.tsx`.
 *   - Page wiring:   `apps/web/app/admin/orders/[id]/page.tsx`.
 *   - Styles:        `apps/web/app/globals.css`
 *                    (`.order-planned-cost-card*`,
 *                     `.admin-order-production-cost-grid`).
 *   - Источник данных №1: `OrderDetailDto.currentCostEstimate.lines`
 *                    (если расчёт зафиксирован).
 *   - Источник данных №2: `getOrderWorkshopNeeds(orderId)` через
 *                    `apps/web/lib/workshop-needs-api.ts`.
 *   - Группировка needs по `getWorkshopNeedKind` из
 *                    `@sewing/shared/workshop-needs`.
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
// 1. Component file существует и содержит ключевые элементы
// ---------------------------------------------------------------------------

describe('Web — OrderPlannedCostSummaryCard component file', () => {
  const componentPath =
    'apps/web/components/orders/order-planned-cost-summary-card.tsx';

  test('файл компонента создан', () => {
    expect(exists(componentPath)).toBe(true);
  });

  const src = read(componentPath);

  test('компонент экспортирует именованный async server component', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+OrderPlannedCostSummaryCard/,
    );
    // Принимает order:OrderDetailDto и опциональный workshopNeeds.
    expect(src).toMatch(/order:\s*OrderDetailDto/);
    expect(src).toMatch(/workshopNeeds\?:\s*WorkshopNeedListItemDto\[\]/);
  });

  test('используется helper getWorkshopNeedKind из shared', () => {
    expect(src).toMatch(
      /from '@sewing\/shared\/workshop-needs'/,
    );
    expect(src).toMatch(/getWorkshopNeedKind/);
  });

  test('используются ORDER_COST_ESTIMATE_LINE_KIND_LABELS из shared', () => {
    expect(src).toMatch(
      /ORDER_COST_ESTIMATE_LINE_KIND_LABELS/,
    );
    expect(src).toMatch(
      /from '@sewing\/shared\/order-cost-estimates'/,
    );
  });

  test('операции считаются из order.operationCostPlanRub (не из estimate)', () => {
    expect(src).toMatch(/order\.operationCostPlanRub/);
  });

  test('per-unit делится на order.qtyPlanTotal и защищается от 0', () => {
    expect(src).toMatch(/order\.qtyPlanTotal/);
    // Безопасное деление: если qty <= 0 → null.
    expect(src).toMatch(/totalQty\s*>\s*0/);
  });

  test('источник «estimate» используется при наличии currentCostEstimate', () => {
    expect(src).toMatch(/order\.currentCostEstimate/);
    expect(src).toMatch(/'estimate'/);
  });

  test('источник «workshopNeeds» использует getOrderWorkshopNeeds (без миграций / новых API)', () => {
    expect(src).toMatch(/getOrderWorkshopNeeds\(/);
    expect(src).toMatch(/'workshopNeeds'/);
    expect(src).toMatch(/'empty'/);
  });

  test('USD-строки не попадают в RUB-итог и помечаются hasUsdLines', () => {
    // Логика «если USD — поднять флаг и пропустить».
    expect(src).toMatch(/hasUsdLines/);
    expect(src).toMatch(/'USD'/);
    // Варнинг текстом про курс USD/RUB.
    expect(src).toMatch(/USD\/RUB/);
    // Перенос строк в JSX-тексте допустим — проверяем фразу с
    // лояльным разделителем между «курсом» и «USD/RUB».
    expect(src).toMatch(
      /Есть строки в USD\. Для точного итога завершите расчёт с курсом\s+USD\/RUB\./,
    );
  });

  test('используется purchaseQty ?? calculatedQty для finalQty', () => {
    expect(src).toMatch(/purchaseQty\s*\?\?\s*need\.calculatedQty/);
  });

  test('строки с CANCELLED-статусом не учитываются', () => {
    expect(src).toMatch(/'CANCELLED'/);
  });

  test('операционный stale-badge «Требует пересчёта» виден при isStaleOps', () => {
    expect(src).toMatch(/operationPlanIsStale/);
    expect(src).toMatch(/Требует пересчёта/);
  });

  test('обязательные UI-строки: Материалы / Материалы за 1 изделие / Операции / Операции за 1 изделие / Итого', () => {
    expect(src).toMatch(/Материалы за 1 изделие/);
    expect(src).toMatch(/Операции за 1 изделие/);
    expect(src).toMatch(/Итого/);
    expect(src).toMatch(/Итого за 1 изделие/);
  });

  test('hint-сообщения для трёх режимов источника', () => {
    expect(src).toMatch(/По завершённому расчёту/);
    expect(src).toMatch(/Предварительно по заполненным ценам потребности/);
    expect(src).toMatch(/Заполните цены в потребности цеха/);
    expect(src).toMatch(/Нет заполненных цен по потребности/);
  });

  test('data-testid идентификаторы зафиксированы для smoke / e2e', () => {
    // Корневой контейнер рендерит data-testid напрямую,
    // вложенные строки прокидывают через Row { testId }.
    expect(src).toMatch(/data-testid="order-planned-cost-summary"/);
    expect(src).toMatch(/"order-planned-cost-summary-materials-unit"/);
    expect(src).toMatch(/"order-planned-cost-summary-operations"/);
    expect(src).toMatch(/"order-planned-cost-summary-operations-unit"/);
    expect(src).toMatch(/"order-planned-cost-summary-total"/);
    expect(src).toMatch(/"order-planned-cost-summary-total-unit"/);
    expect(src).toMatch(/"order-planned-cost-summary-usd-warning"/);
  });

  test('CSS-классы соответствуют ТЗ', () => {
    expect(src).toMatch(/order-planned-cost-card__rows/);
    expect(src).toMatch(/order-planned-cost-card__row/);
    expect(src).toMatch(/order-planned-cost-card__row--muted/);
    expect(src).toMatch(/order-planned-cost-card__row--total/);
    expect(src).toMatch(/order-planned-cost-card__label/);
    expect(src).toMatch(/order-planned-cost-card__value/);
    expect(src).toMatch(/order-planned-cost-card__warning/);
  });
});

// ---------------------------------------------------------------------------
// 2. Page wiring: /admin/orders/[id]
// ---------------------------------------------------------------------------

describe('Web — /admin/orders/[id]: «Плановая себестоимость» теперь aggregate-only внутри OrderNeedsTab', () => {
  const pagePath = 'apps/web/app/admin/orders/[id]/page.tsx';
  const src = read(pagePath);
  const needsTabSrc = read(
    'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
  );

  test('страница больше не использует stand-alone карточки «План.» и «Себестоимость» напрямую', () => {
    // Order management redesign: smart-карточки уехали в шапку (KPI)
    // и в `OrderNeedsTab` (aggregate-only). Полный построчный
    // breakdown теперь живёт в отдельной финансовой вкладке
    // «Сводно по заказу» (`?tab=costSummary` → `<OrderSummaryTab>`,
    // wrapper над `OrderSummaryUnifiedTable`). Сама `page.tsx`
    // карточки `OrderPlannedCostSummaryCard` /
    // `OrderCostEstimateCard` напрямую не импортирует.
    expect(src).not.toMatch(/<OrderPlannedCostSummaryCard\b/);
    expect(src).not.toMatch(/<OrderCostEstimateCard\b/);
  });

  test('OrderNeedsTab рендерит OrderPlannedCostSummaryCard как aggregate-only cost-card', () => {
    // В Needs допустим только aggregate-only блок: материалы /
    // фурнитура / нанесение / операции / итого + «за 1 изделие».
    // Полный построчный itemized cost breakdown
    // (`OrderSummaryUnifiedTable`) дублировал бы материалы рядом с
    // `OrderMaterialsUnifiedTable`, поэтому в Needs он по-прежнему
    // запрещён — его место строго в новой финансовой вкладке
    // «Сводно по заказу» (`costSummary`).
    expect(needsTabSrc).toMatch(/<OrderPlannedCostSummaryCard\b/);
    expect(needsTabSrc).toMatch(
      /from '@\/components\/orders\/order-planned-cost-summary-card'/,
    );
    expect(needsTabSrc).not.toMatch(/<OrderSummaryUnifiedTable\b/);
    expect(needsTabSrc).not.toMatch(
      /from '@\/components\/orders\/summary\/order-summary-unified-table'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Styles in globals.css
// ---------------------------------------------------------------------------

describe('Web — globals.css: стили «Плановая себестоимость»', () => {
  const cssPath = 'apps/web/app/globals.css';
  const src = read(cssPath);

  test('добавлен .order-planned-cost-card и его модификаторы', () => {
    expect(src).toMatch(/\.order-planned-cost-card\s*\{/);
    expect(src).toMatch(/\.order-planned-cost-card__rows\s*\{/);
    expect(src).toMatch(/\.order-planned-cost-card__row\s*\{/);
    expect(src).toMatch(/\.order-planned-cost-card__row--muted/);
    expect(src).toMatch(/\.order-planned-cost-card__row--total/);
    expect(src).toMatch(/\.order-planned-cost-card__label\s*\{/);
    expect(src).toMatch(/\.order-planned-cost-card__value\s*\{/);
    expect(src).toMatch(/\.order-planned-cost-card__warning\s*\{/);
  });

  test('добавлен .admin-order-production-cost-grid (две колонки на десктопе)', () => {
    expect(src).toMatch(/\.admin-order-production-cost-grid\s*\{/);
    // На узком экране — одна колонка.
    expect(src).toMatch(
      /@media \(max-width: 1199px\)\s*\{[\s\S]*?\.admin-order-production-cost-grid[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Backend / shared / Prisma НЕ менялись (additive UI/API polish)
// ---------------------------------------------------------------------------

describe('Этап «Плановая себестоимость» — backend / Prisma / shared НЕ менялись', () => {
  test('LABOR не добавлен в ORDER_COST_ESTIMATE_LINE_KINDS (повторная защита)', () => {
    const src = read('packages/shared/src/order-cost-estimates.ts');
    expect(src).not.toMatch(/'LABOR'/);
  });

  test('OrderCostEstimatesService НЕ упоминает operationCostPlan / LABOR', () => {
    const src = read(
      'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    );
    expect(src).not.toMatch(/'LABOR'/);
    expect(src).not.toMatch(/operationCostPlan/);
  });

  test('WorkshopNeedsService НЕ упоминает operationCostPlan', () => {
    const src = read(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    expect(src).not.toMatch(/operationCostPlan/);
  });

  test('Prisma-схема не получала новых моделей под планируемую себестоимость', () => {
    // Достаточно убедиться, что модель «OrderPlannedCostSummary»
    // (которой нет и не должно быть на этом этапе) не появилась.
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/model\s+OrderPlannedCostSummary\b/);
  });
});
