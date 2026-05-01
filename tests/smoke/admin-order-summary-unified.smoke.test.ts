/**
 * Smoke-тесты для рефакторинга «единый рабочий экран по себестоимости»
 * — вкладка «Сводно по заказу» (`?tab=costSummary`) карточки заказа
 * `/admin/orders/[id]`.
 *
 * Source-of-truth:
 *   - Tab wrapper:     `apps/web/components/orders/tabs/order-summary-tab.tsx`
 *   - Unified table:   `apps/web/components/orders/summary/order-summary-unified-table.tsx`
 *   - Row builder:     `apps/web/components/orders/summary/build-order-summary-rows.ts`
 *   - Page wiring:     `apps/web/app/admin/orders/[id]/page.tsx`
 *     (branch `activeTab === 'costSummary'` → `<OrderSummaryTab>`)
 *   - Tabs config:     `apps/web/components/orders/view/order-view-tabs-config.ts`
 *     (id `costSummary`, label `'Сводно по заказу'`).
 *   - Styles:          `apps/web/app/globals.css`
 *
 * Цели проверок (см. ТЗ §«Сводно»):
 *   1. Summary tab рендерит unified-таблицу сводной себестоимости
 *      (Раздел / Статья / Кол-во / Ед. / Цена / Сумма за тираж /
 *      За 1 изделие / Доля / Комментарий).
 *   2. Summary helper комбинирует material-rows + operation-rows
 *      в единый плоский список и считает выручку / маржу.
 *   3. Summary НЕ дублирует backend-formulas: импортирует и
 *      переиспользует `buildOrderMaterialRows` /
 *      `buildOrderOperationRows`.
 *   4. USD без курса не подмешивается в RUB total / margin.
 *   5. Missing price НЕ превращается в 0.
 *   6. Backend / Prisma / WorkshopNeed formulas / OperationPlan
 *      formulas / OrderCostEstimate logic / payroll / Passport —
 *      НЕ менялись.
 *   7. Stand-alone `OrderCostEstimateCard` / `OrderPlannedCostSummaryCard`
 *      во вкладке «Сводно по заказу» не используются (cost-summary
 *      использует только `OrderSummaryUnifiedTable`).
 *   8. `OrderSummaryUnifiedTable` маунтится только в costSummary
 *      branch — в Needs он по-прежнему запрещён (это deep-dive
 *      ownership rule, см. `OrderNeedsTab` / regression-тест
 *      `admin-order-needs-no-duplication.smoke.test.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

/**
 * Удаляет JSDoc / block / line-комментарии. Архитектурные хинты вида
 * «do not render OrderSummaryUnifiedTable here» сознательно живут в
 * комментариях `OrderNeedsTab` и не должны ловиться проверками
 * «компонент не используется».
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1. Files exist
// ---------------------------------------------------------------------------

describe('Summary tab — компоненты existуют', () => {
  test('файлы новых компонентов на месте', () => {
    expect(
      exists('apps/web/components/orders/tabs/order-summary-tab.tsx'),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/summary/order-summary-unified-table.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/summary/build-order-summary-rows.ts',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Page wiring: «Сводно по заказу» — отдельная финансовая вкладка
//    (`?tab=costSummary` → `<OrderSummaryTab>`). itemized cost breakdown
//    разрешён только здесь и по-прежнему запрещён в Needs (см.
//    ownership rule в `order-needs-tab.tsx`).
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — costSummary вкладка + itemized cost breakdown НЕ в Needs', () => {
  const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');
  const needsTabSrc = read(
    'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
  );

  test('страница рендерит costSummary branch через OrderSummaryTab', () => {
    // Финансовая сводка возвращена отдельной вкладкой
    // «Сводно по заказу» (id `costSummary`, не `summary`) — она
    // показывает расходы / себестоимость / выручку / прибыль /
    // маржинальность, а не KPI стадий (KPI стадий живут в шапке и
    // во вкладке «Производство»).
    expect(pageSrc).toMatch(/activeTab === 'costSummary'/);
    expect(pageSrc).toMatch(
      /activeTab === 'costSummary'[\s\S]*?<OrderSummaryTab\b/,
    );
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/tabs\/order-summary-tab'/,
    );
    // Старого generic-summary id больше нет — costSummary
    // сознательно отделён от него, чтобы не путать новую финансовую
    // вкладку со старой generic-сводкой.
    expect(pageSrc).not.toMatch(/activeTab === 'summary'/);
  });

  test('OrderSummaryUnifiedTable допускается только в costSummary branch', () => {
    // OrderSummaryTab — wrapper над OrderSummaryUnifiedTable, поэтому
    // в самой `page.tsx` имя компонента не обязано встречаться.
    // Главное — он не должен случайно появиться в любой другой
    // tab-ветке (например, в operations / needs / production).
    const codeSrc = stripComments(pageSrc);
    expect(codeSrc).not.toMatch(/<OrderSummaryUnifiedTable\b/);
    // На странице импорта OrderSummaryUnifiedTable тоже нет —
    // финансовая вкладка ходит через тонкий wrapper OrderSummaryTab.
    expect(codeSrc).not.toMatch(
      /from '@\/components\/orders\/summary\/order-summary-unified-table'/,
    );
  });

  test('OrderNeedsTab НЕ импортирует OrderSummaryUnifiedTable (itemized cost breakdown)', () => {
    // Канонический материал-блок Needs — это `OrderMaterialsUnifiedTable`;
    // полный itemized cost breakdown (строки материалов + операций
    // в одной таблице) дублирует материалы и поэтому живёт только в
    // вкладке «Сводно по заказу».
    //
    // Имя `OrderSummaryUnifiedTable` сознательно упомянуто в JSDoc
    // OrderNeedsTab как «do not render here»-предупреждение —
    // оно должно остаться. Поэтому проверяем код БЕЗ комментариев.
    const needsTabCode = stripComments(needsTabSrc);
    expect(needsTabCode).not.toMatch(/<OrderSummaryUnifiedTable\b/);
    expect(needsTabCode).not.toMatch(
      /from '@\/components\/orders\/summary\/order-summary-unified-table'/,
    );
    expect(needsTabCode).not.toMatch(/OrderSummaryUnifiedTable/);
  });

  test('страница не импортирует OrderCostEstimateCard / OrderPlannedCostSummaryCard напрямую', () => {
    // OrderPlannedCostSummaryCard подключается через OrderNeedsTab
    // как aggregate-only cost-card. Полный financial breakdown
    // (`OrderSummaryUnifiedTable`) подключается через OrderSummaryTab
    // в costSummary-вкладке. На самой `page.tsx` прямых импортов
    // этих карточек быть не должно.
    expect(pageSrc).not.toMatch(/import\s*\{\s*OrderCostEstimateCard\s*\}/);
    expect(pageSrc).not.toMatch(
      /import\s*\{\s*OrderPlannedCostSummaryCard\s*\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2a. ORDER_VIEW_TABS — costSummary как явно зафиксированная вкладка.
// ---------------------------------------------------------------------------

describe('ORDER_VIEW_TABS — costSummary вкладка зарегистрирована', () => {
  const cfgSrc = read(
    'apps/web/components/orders/view/order-view-tabs-config.ts',
  );

  test('конфиг содержит id `costSummary` с label «Сводно по заказу»', () => {
    expect(cfgSrc).toMatch(/id:\s*'costSummary'/);
    expect(cfgSrc).toMatch(/label:\s*'Сводно по заказу'/);
    // Подсказка empty-state описывает финансовую природу вкладки.
    expect(cfgSrc).toMatch(
      /Расходы, себестоимость, прибыль и маржинальность по заказу\./,
    );
    // Тип `OrderViewTabId` тоже знает про новую вкладку.
    expect(cfgSrc).toMatch(/'costSummary'/);
  });

  test('costSummary встречается между operations и needs', () => {
    const opIdx = cfgSrc.indexOf("id: 'operations'");
    const csIdx = cfgSrc.indexOf("id: 'costSummary'");
    const ndIdx = cfgSrc.indexOf("id: 'needs'");
    expect(opIdx).toBeGreaterThan(-1);
    expect(csIdx).toBeGreaterThan(-1);
    expect(ndIdx).toBeGreaterThan(-1);
    expect(csIdx).toBeGreaterThan(opIdx);
    expect(ndIdx).toBeGreaterThan(csIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. OrderSummaryTab wrapper
// ---------------------------------------------------------------------------

describe('OrderSummaryTab — wrapper рендерит ровно одну сводную таблицу', () => {
  const src = read(
    'apps/web/components/orders/tabs/order-summary-tab.tsx',
  );

  test('экспортирует именованный server component', () => {
    expect(src).toMatch(/export\s+function\s+OrderSummaryTab/);
  });

  test('рендерит OrderSummaryUnifiedTable', () => {
    expect(src).toMatch(/<OrderSummaryUnifiedTable\b/);
    expect(src).toMatch(
      /from '@\/components\/orders\/summary\/order-summary-unified-table'/,
    );
  });

  test('не импортирует legacy-карточки (OrderCostEstimateCard / OrderPlannedCostSummaryCard / OperationPlanBlock)', () => {
    expect(src).not.toMatch(/import\s*\{[^}]*OrderCostEstimateCard[^}]*\}/);
    expect(src).not.toMatch(
      /import\s*\{[^}]*OrderPlannedCostSummaryCard[^}]*\}/,
    );
    expect(src).not.toMatch(/<OrderCostEstimateCard\b/);
    expect(src).not.toMatch(/<OrderPlannedCostSummaryCard\b/);
    expect(src).not.toMatch(/<OperationPlanBlock\b/);
    // Не оборачиваем в AdminCard — wrapper должен быть прозрачным.
    expect(src).not.toMatch(/<AdminCard\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. OrderSummaryUnifiedTable
// ---------------------------------------------------------------------------

describe('OrderSummaryUnifiedTable — единая таблица сводной себестоимости', () => {
  const src = read(
    'apps/web/components/orders/summary/order-summary-unified-table.tsx',
  );

  test('async server component с data-testid=order-summary-unified-table', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+OrderSummaryUnifiedTable/,
    );
    expect(src).toMatch(/data-testid="order-summary-unified-table"/);
  });

  test('переиспользует existing helpers buildOrderMaterialRows / buildOrderOperationRows', () => {
    expect(src).toMatch(/buildOrderMaterialRows/);
    expect(src).toMatch(/buildOrderOperationRows/);
    expect(src).toMatch(
      /from '@\/components\/orders\/materials\/build-order-material-rows'/,
    );
    expect(src).toMatch(
      /from '@\/components\/orders\/operations\/build-order-operation-rows'/,
    );
  });

  test('использует existing API-обёртки, не дублируя backend-вызовы', () => {
    // Helpers из `@/lib/*-api` — те же, что и у вкладок «Материалы»
    // и «Операции», никаких новых backend-эндпоинтов мы не добавляли.
    expect(src).toMatch(/getOrderWorkshopNeeds/);
    expect(src).toMatch(/getOrderCutReadiness/);
    expect(src).toMatch(/getOrderPurchaseOrders/);
    expect(src).toMatch(/getOrderPurchaseReceipts/);
    expect(src).toMatch(/getOperation\b/);
    expect(src).toMatch(/getOrderProductionBalance\b/);
  });

  test('использует новый helper buildOrderSummaryRows / computeOrderSummaryTotals', () => {
    expect(src).toMatch(/buildOrderSummaryRows\b/);
    expect(src).toMatch(/computeOrderSummaryTotals\b/);
    expect(src).toMatch(/from '\.\/build-order-summary-rows'/);
  });

  test('таблица содержит все 9 колонок ТЗ в правильном порядке', () => {
    const expectedHeaders = [
      "header: 'Раздел'",
      "header: 'Статья'",
      "header: 'Кол-во'",
      "header: 'Ед.'",
      "header: 'Цена'",
      "header: 'Сумма за тираж'",
      "header: 'За 1 изделие'",
      "header: 'Доля'",
      "header: 'Комментарий'",
    ];
    let prev = -1;
    for (const h of expectedHeaders) {
      const idx = src.indexOf(h);
      expect(idx, `column ${h} not found`).toBeGreaterThan(-1);
      expect(idx, `column ${h} should follow previous`).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  test('рендерит KPI-полосу с обязательными метриками', () => {
    expect(src).toMatch(/data-testid="order-summary-kpi-bar"/);
    // testId-литералы (`testId: 'order-summary-kpi-...'`) выставляются
    // в одной структуре, JSX превращает их в data-testid="...".
    expect(src).toMatch(/order-summary-kpi-cost-per-unit/);
    expect(src).toMatch(/order-summary-kpi-cost-total/);
    expect(src).toMatch(/order-summary-kpi-revenue/);
    expect(src).toMatch(/order-summary-kpi-margin\b/);
    expect(src).toMatch(/order-summary-kpi-margin-pct/);
    expect(src).toMatch(/Себестоимость \/ шт/);
    expect(src).toMatch(/Себестоимость тиража/);
    expect(src).toMatch(/Цена продажи \/ шт/);
    expect(src).toMatch(/Выручка/);
    expect(src).toMatch(/Маржа/);
    expect(src).toMatch(/Маржинальность/);
  });

  test('рендерит итоговый блок «Себестоимость / Продажа / Маржа»', () => {
    expect(src).toMatch(/data-testid="order-summary-totals"/);
    expect(src).toMatch(/Материалы за тираж/);
    expect(src).toMatch(/Фурнитура за тираж/);
    expect(src).toMatch(/Нанесение за тираж/);
    expect(src).toMatch(/Операции за тираж/);
    expect(src).toMatch(/Итого себестоимость за тираж/);
    expect(src).toMatch(/Итого себестоимость за 1 изделие/);
    expect(src).toMatch(/order-summary-totals-cost-total/);
    expect(src).toMatch(/order-summary-totals-cost-per-unit/);
    expect(src).toMatch(/data-testid="order-summary-totals-margin"/);
    expect(src).toMatch(/data-testid="order-summary-totals-margin-per-unit"/);
    expect(src).toMatch(/data-testid="order-summary-totals-margin-total"/);
    expect(src).toMatch(/data-testid="order-summary-totals-margin-pct"/);
  });

  test('USD без курса показывается отдельно (не подмешивается в RUB total)', () => {
    // TotalCell рисует warning «USD» для строк, у которых
    // totalRub === null, но totalDisplay не пуст (USD без курса).
    expect(src).toMatch(/USD/);
    expect(src).toMatch(/order-summary-table__warning/);
  });
});

// ---------------------------------------------------------------------------
// 5. buildOrderSummaryRows helper
// ---------------------------------------------------------------------------

describe('buildOrderSummaryRows — pure web-helper, не трогает backend', () => {
  const src = read(
    'apps/web/components/orders/summary/build-order-summary-rows.ts',
  );

  test('экспортирует тип OrderSummaryRow со всеми колонками таблицы', () => {
    expect(src).toMatch(/export\s+interface\s+OrderSummaryRow\s*\{/);
    expect(src).toMatch(/section:\s*OrderSummarySection/);
    expect(src).toMatch(/sectionLabel:\s*string/);
    expect(src).toMatch(/article:\s*string/);
    expect(src).toMatch(/qty:\s*number \| null/);
    expect(src).toMatch(/qtyDisplay:\s*string/);
    expect(src).toMatch(/unit:\s*string/);
    expect(src).toMatch(/priceDisplay:\s*string/);
    expect(src).toMatch(/totalRub:\s*number \| null/);
    expect(src).toMatch(/totalDisplay:\s*string/);
    expect(src).toMatch(/unitCostRub:\s*number \| null/);
    expect(src).toMatch(/comment:\s*string \| null/);
    expect(src).toMatch(/warnings:\s*string\[\]/);
  });

  test('экспортирует buildOrderSummaryRows и computeOrderSummaryTotals', () => {
    expect(src).toMatch(/export\s+function\s+buildOrderSummaryRows/);
    expect(src).toMatch(/export\s+function\s+computeOrderSummaryTotals/);
  });

  test('экспортирует ORDER_SUMMARY_SECTION_LABELS со всеми пятью секциями', () => {
    expect(src).toMatch(/MATERIAL: 'Материалы'/);
    expect(src).toMatch(/HARDWARE: 'Фурнитура'/);
    expect(src).toMatch(/APPLICATION: 'Нанесение'/);
    expect(src).toMatch(/OPERATION: 'Операции'/);
    expect(src).toMatch(/OTHER: 'Прочее'/);
  });

  test('импортирует row-builders из вкладок «Материалы» и «Операции»', () => {
    expect(src).toMatch(
      /from '@\/components\/orders\/materials\/build-order-material-rows'/,
    );
    expect(src).toMatch(
      /from '@\/components\/orders\/operations\/build-order-operation-rows'/,
    );
  });

  test('USD-строка без курса не подмешивается в RUB total', () => {
    // Реализация выставляет totalRub = null для USD-строк без
    // estimate.lineTotalRub и поднимает warning «USD без курса».
    expect(src).toMatch(/USD без курса/);
    // Дефолтное состояние totalRub — null, обнуляется обратно в null
    // в ветке «USD без курса».
    expect(src).toMatch(/totalRub\s*=\s*null/);
  });

  test('cost / margin формулы соответствуют ТЗ', () => {
    expect(src).toMatch(/costTotalRub/);
    expect(src).toMatch(/costPerUnitRub/);
    expect(src).toMatch(/revenueTotalRub/);
    expect(src).toMatch(/marginTotalRub/);
    expect(src).toMatch(/marginPerUnitRub/);
    expect(src).toMatch(/marginPercent/);
    // Тираж × цена продажи = выручка.
    expect(src).toMatch(/customerUnitPriceNum\s*\*\s*qtyTotal/);
    // Маржа = выручка - себестоимость.
    expect(src).toMatch(/revenueTotalRub\s*-\s*costTotalRub/);
    // Маржинальность = маржа / выручка × 100.
    expect(src).toMatch(/\(marginTotalRub\s*\/\s*revenueTotalRub\)\s*\*\s*100/);
  });

  test('unitCostRub считается как totalRub / qtyTotal', () => {
    expect(src).toMatch(/r\.totalRub\s*\/\s*qtyTotal/);
    // Если totalRub === null — unitCostRub остаётся null
    // (`unitCostRub: null` в OrderSummaryRow при сборке строки).
    expect(src).toMatch(/unitCostRub:\s*null/);
  });

  test('Missing price не превращается в 0 (totalRub null)', () => {
    // priceNum == null -> totalRub null, fake 0 не показываем.
    expect(src).toMatch(/Цена не указана/);
  });

  test('warnings уровня заказа покрывают перечисленные в ТЗ §9 случаи', () => {
    expect(src).toMatch(/Не указана цена продажи/);
    expect(src).toMatch(/USD без курса/);
    expect(src).toMatch(/Не заполнен тираж/);
    expect(src).toMatch(/Расчёт себестоимости не завершён/);
    expect(src).toMatch(/План операций требует пересчёта/);
  });

  test('helper НЕ дёргает backend напрямую (только pure-функции и shared DTO)', () => {
    // Никаких import из @/lib/*-api здесь быть не должно — за загрузку
    // отвечает компонент.
    expect(src).not.toMatch(/from '@\/lib\//);
    // Никаких импортов prisma / @sewing/api / nest.
    expect(src).not.toMatch(/from '@prisma\/client'/);
    expect(src).not.toMatch(/@nestjs\//);
  });
});

// ---------------------------------------------------------------------------
// 6. CSS classes
// ---------------------------------------------------------------------------

describe('globals.css — стили для unified summary table', () => {
  const css = read('apps/web/app/globals.css');

  test('базовые классы таблицы определены', () => {
    expect(css).toMatch(/\.order-summary-table-card\s*\{/);
    expect(css).toMatch(/\.order-summary-kpi-bar\s*\{/);
    expect(css).toMatch(/\.order-summary-kpi\s*\{/);
    expect(css).toMatch(/\.order-summary-table-wrap\b/);
    expect(css).toMatch(/\.order-summary-table\s*\{/);
    expect(css).toMatch(/\.order-summary-table__section\b/);
    expect(css).toMatch(/\.order-summary-table__money\b/);
    expect(css).toMatch(/\.order-summary-table__unit-cost\b/);
    expect(css).toMatch(/\.order-summary-table__share\b/);
    expect(css).toMatch(/\.order-summary-table__warning\b/);
    expect(css).toMatch(/\.order-summary-totals\s*\{/);
    expect(css).toMatch(/\.order-summary-totals__row\b/);
    expect(css).toMatch(/\.order-summary-totals__row--total\b/);
    expect(css).toMatch(/\.order-summary-margin--positive\b/);
    expect(css).toMatch(/\.order-summary-margin--negative\b/);
  });

  test('таблица имеет min-width для горизонтального скролла', () => {
    expect(css).toMatch(
      /\.order-summary-table\s*\{[\s\S]*?min-width:\s*1100px/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Backend / Prisma / shared НЕ менялись
// ---------------------------------------------------------------------------

describe('Summary tab refactor — backend / Prisma / shared НЕ менялись', () => {
  test('Prisma schema без новых таблиц/полей под unified summary', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/model\s+OrderSummaryUnifiedTable\b/);
    expect(schema).not.toMatch(/model\s+OrderSummaryRow\b/);
  });

  test('OrderCostEstimatesService формулы не упоминают unified-сводку', () => {
    const svc = read(
      'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    );
    expect(svc).not.toMatch(/buildOrderSummaryRows/);
    expect(svc).not.toMatch(/OrderSummaryUnifiedTable/);
  });

  test('OrderOperationPlanService формулы не упоминают unified-сводку', () => {
    const svc = read(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(svc).not.toMatch(/buildOrderSummaryRows/);
    expect(svc).not.toMatch(/OrderSummaryUnifiedTable/);
  });

  test('WorkshopNeedsService не знает про unified-сводку', () => {
    const svc = read(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    expect(svc).not.toMatch(/buildOrderSummaryRows/);
    expect(svc).not.toMatch(/OrderSummaryUnifiedTable/);
  });

  test('Payroll (earnings/salary) / Passport не упоминают unified-сводку', () => {
    const earn = read('apps/api/src/modules/earnings/earnings.service.ts');
    expect(earn).not.toMatch(/buildOrderSummaryRows/);
    expect(earn).not.toMatch(/OrderSummaryUnifiedTable/);
    const sal = read('apps/api/src/modules/salary/salary.service.ts');
    expect(sal).not.toMatch(/buildOrderSummaryRows/);
    expect(sal).not.toMatch(/OrderSummaryUnifiedTable/);
    const p = read('apps/api/src/modules/passports/passports.service.ts');
    expect(p).not.toMatch(/buildOrderSummaryRows/);
    expect(p).not.toMatch(/OrderSummaryUnifiedTable/);
  });

  test('helper buildOrderSummaryRows живёт строго в apps/web (не shared, не backend)', () => {
    expect(
      exists(
        'apps/web/components/orders/summary/build-order-summary-rows.ts',
      ),
    ).toBe(true);
    expect(
      exists('packages/shared/src/order-summary-unified-table.ts'),
    ).toBe(false);
    expect(
      exists('apps/api/src/modules/order-summary-unified-table'),
    ).toBe(false);
  });
});
