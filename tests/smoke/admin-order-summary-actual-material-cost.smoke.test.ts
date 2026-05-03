/**
 * Smoke-тесты frontend-итерации «Фактическая стоимость материалов в
 * финансовой сводке заказа» (`/admin/orders/[id]?tab=costSummary`).
 *
 * UI-решение владельца:
 *   - НЕ создаётся новая страница / роут;
 *   - НЕ создаётся новый пункт меню;
 *   - НЕ создаётся новая вкладка;
 *   - НЕ создаётся новая секция;
 *   - факт стоимости материалов добавляется в **уже существующую**
 *     финансовую сводку (`OrderSummaryUnifiedTable` →
 *     `TotalsBlock`) тремя строками внутри блока «Себестоимость»:
 *     «Материалы за тираж» (план), «Материалы за тираж · факт»,
 *     «Материалы за тираж · Δ (факт − план)».
 *
 * Source-of-truth:
 *   - Helper:    `apps/web/components/orders/summary/build-order-summary-rows.ts`
 *   - Table:     `apps/web/components/orders/summary/order-summary-unified-table.tsx`
 *   - API:       `apps/web/lib/material-issues-api.ts`
 *   - Shared:    `packages/shared/src/material-issues.ts`
 *
 * Цели проверок (см. ТЗ §10 «Tests» итерации «order-summary actual
 * material cost»):
 *   1. OrderSummaryUnifiedTable принимает materialIssues (через
 *      собственный server-loader) и пробрасывает в
 *      computeOrderSummaryTotals.
 *   2. В финансовой сводке отображается фактическая стоимость
 *      материалов и отклонение.
 *   3. actualMaterialCost считается только по POSTED MaterialIssue.
 *   4. DRAFT не учитывается.
 *   5. CANCELLED не учитывается.
 *   6. Issue без passportId учитывается.
 *   7. Issue без workshopNeedId-строк учитывается через issue.totalCost.
 *   8. plannedMaterialCost берётся из существующего расчёта
 *      (MATERIAL-секция unified-таблицы).
 *   9. deltaMaterialCost = actual - planned.
 *  10. Если plannedMaterialCost === null, deltaMaterialCost === null
 *      и UI показывает «—» для дельты.
 *  11. Не создаётся новая страница /admin/material-issues.
 *  12. Не меняется OrderViewTabs.
 *  13. Не меняется OrderMaterialsUnifiedTable в этой итерации (нет
 *      новых колонок поверх «План / факт» из предыдущей).
 *  14. Не меняется CostsService / ProductionCostV2Service.
 *
 * Часть тестов — функциональные (через `computeOrderSummaryTotals`),
 * часть — статические по исходникам (как соседний смок-набор
 * `admin-order-summary-unified.smoke.test.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  computeOrderSummaryTotals,
  type OrderSummaryRow,
} from '../../apps/web/components/orders/summary/build-order-summary-rows';
import type { MaterialIssueListItemDto } from '../../packages/shared/src/material-issues';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

// ---------------------------------------------------------------------------
// Helpers — фабрики minimal-DTO
// ---------------------------------------------------------------------------

let issueSeq = 0;
function makeIssue(
  status: 'DRAFT' | 'POSTED' | 'CANCELLED',
  totalCost: string,
  overrides: Partial<MaterialIssueListItemDto> = {},
): MaterialIssueListItemDto {
  issueSeq += 1;
  return {
    id: `mi-${issueSeq}`,
    orderId: 'order-1',
    orderNumber: 'OR-1',
    passportId: null,
    passportNumber: null,
    status,
    totalCost,
    createdAt: new Date('2026-01-01').toISOString(),
    postedAt: status === 'POSTED' ? new Date('2026-01-02').toISOString() : null,
    cancelledAt:
      status === 'CANCELLED' ? new Date('2026-01-03').toISOString() : null,
    linesCount: 1,
    ...overrides,
  };
}

let rowSeq = 0;
function makeMaterialRow(
  totalRub: number | null,
  unitCostRub: number | null = null,
): OrderSummaryRow {
  rowSeq += 1;
  return {
    id: `wn-${rowSeq}`,
    sourceKind: 'material',
    section: 'MATERIAL',
    sectionLabel: 'Материалы',
    article: 'Дюспо',
    qty: 10,
    qtyDisplay: '10',
    unit: 'м',
    priceDisplay: totalRub == null ? '—' : `${totalRub} ₽`,
    priceCurrency: totalRub == null ? null : 'RUB',
    totalRub,
    totalDisplay: totalRub == null ? '—' : `${totalRub} ₽`,
    unitCostRub,
    comment: null,
    warnings: [],
  };
}

function baseTotalsInput(rows: OrderSummaryRow[]) {
  return {
    rows,
    qtyTotal: 100,
    customerUnitPrice: null,
    customerCurrency: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Никаких новых страниц / роутов / вкладок не появляется
// ---------------------------------------------------------------------------

describe('Order summary actual material cost — новые роуты НЕ создаются', () => {
  test('страница /admin/material-issues отсутствует', () => {
    expect(exists('apps/web/app/admin/material-issues/page.tsx')).toBe(false);
    expect(exists('apps/web/app/admin/material-issues')).toBe(false);
  });

  test('конфиг вкладок заказа не содержит новых id под факт материалов', () => {
    const cfgSrc = read(
      'apps/web/components/orders/view/order-view-tabs-config.ts',
    );
    expect(cfgSrc.toLowerCase()).not.toMatch(/['"]material-cost['"]/);
    expect(cfgSrc.toLowerCase()).not.toMatch(/['"]actual-materials['"]/);
    expect(cfgSrc.toLowerCase()).not.toMatch(/['"]material-fact['"]/);
  });

  test('OrderViewTabs в page.tsx не упоминает новый таб', () => {
    const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');
    expect(pageSrc.toLowerCase()).not.toMatch(/['"]material-cost['"]/);
    expect(pageSrc.toLowerCase()).not.toMatch(/['"]actual-materials['"]/);
  });
});

// ---------------------------------------------------------------------------
// 2. computeOrderSummaryTotals — actualMaterialCost / deltaMaterialCost
// ---------------------------------------------------------------------------

describe('computeOrderSummaryTotals — actualMaterialCost по POSTED MaterialIssue', () => {
  test('1. POSTED-документы суммируются в materialActualCostRub', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [makeIssue('POSTED', '300'), makeIssue('POSTED', '450')],
    });
    expect(totals.materialActualCostRub).toBe(750);
  });

  test('2. DRAFT НЕ учитывается', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [
        makeIssue('POSTED', '500'),
        makeIssue('DRAFT', '999'),
      ],
    });
    expect(totals.materialActualCostRub).toBe(500);
  });

  test('3. CANCELLED НЕ учитывается', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [
        makeIssue('POSTED', '500'),
        makeIssue('CANCELLED', '999'),
      ],
    });
    expect(totals.materialActualCostRub).toBe(500);
  });

  test('4. Если POSTED документов нет, materialActualCostRub === 0 (массив пуст / только DRAFT)', () => {
    const onlyDraft = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [makeIssue('DRAFT', '999')],
    });
    expect(onlyDraft.materialActualCostRub).toBe(0);

    const empty = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [],
    });
    expect(empty.materialActualCostRub).toBe(0);
  });

  test('5. Если materialIssues не передан (load-error), materialActualCostRub === null', () => {
    const totals = computeOrderSummaryTotals(
      baseTotalsInput([makeMaterialRow(1000)]),
    );
    expect(totals.materialActualCostRub).toBeNull();
  });

  test('6. Issue без passportId учитывается (passportId=null допустим)', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [
        makeIssue('POSTED', '700', { passportId: null, passportNumber: null }),
      ],
    });
    expect(totals.materialActualCostRub).toBe(700);
  });

  test('7. Issue с linesCount=0 (строки без workshopNeedId) учитывается через totalCost', () => {
    // На уровне финансовой сводки источник — `issue.totalCost`
    // (а не пересчёт строк), поэтому даже документы со строками
    // без `workshopNeedId` входят в order-level summary.
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [
        makeIssue('POSTED', '420', { linesCount: 0 }),
      ],
    });
    expect(totals.materialActualCostRub).toBe(420);
  });

  test('8. NaN / нечисловой totalCost игнорируется без падений', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [
        makeIssue('POSTED', '500'),
        makeIssue('POSTED', 'oops' as unknown as string),
      ],
    });
    expect(totals.materialActualCostRub).toBe(500);
  });
});

describe('computeOrderSummaryTotals — plannedMaterialCost & deltaMaterialCost', () => {
  test('plannedMaterialCost == byKind.material (Σ MATERIAL-rows totalRub)', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([
        makeMaterialRow(600),
        makeMaterialRow(400),
      ]),
      materialIssues: [makeIssue('POSTED', '900')],
    });
    expect(totals.byKind.material).toBe(1000);
    expect(totals.materialActualCostRub).toBe(900);
    // Δ = 900 - 1000 = -100 (экономия)
    expect(totals.materialDeltaCostRub).toBe(-100);
  });

  test('Δ положительная при перерасходе', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(500)]),
      materialIssues: [
        makeIssue('POSTED', '600'),
        makeIssue('POSTED', '50'),
      ],
    });
    expect(totals.materialDeltaCostRub).toBe(150);
  });

  test('Δ === null, если plannedMaterialCost отсутствует (нет ни одной MATERIAL-строки в RUB)', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([]),
      materialIssues: [makeIssue('POSTED', '700')],
    });
    expect(totals.byKind.material).toBeNull();
    expect(totals.materialActualCostRub).toBe(700);
    expect(totals.materialDeltaCostRub).toBeNull();
  });

  test('Δ === null, если materialIssues не передан', () => {
    const totals = computeOrderSummaryTotals(
      baseTotalsInput([makeMaterialRow(1000)]),
    );
    expect(totals.materialActualCostRub).toBeNull();
    expect(totals.materialDeltaCostRub).toBeNull();
  });

  test('Δ === 0, если факт ровно равен плану', () => {
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(800)]),
      materialIssues: [makeIssue('POSTED', '800')],
    });
    expect(totals.materialDeltaCostRub).toBe(0);
  });

  test('Источник истины — issue.totalCost, а не пересчёт строк на frontend', () => {
    // Even if issue has linesCount=5, мы суммируем именно
    // totalCost. Frontend никаких lines не достаёт для сводки.
    const totals = computeOrderSummaryTotals({
      ...baseTotalsInput([makeMaterialRow(1000)]),
      materialIssues: [
        makeIssue('POSTED', '777', { linesCount: 5 }),
      ],
    });
    expect(totals.materialActualCostRub).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// 3. OrderSummaryUnifiedTable: загружает MaterialIssue и рендерит факт
// ---------------------------------------------------------------------------

describe('OrderSummaryUnifiedTable — загрузка MaterialIssue и UI', () => {
  const src = read(
    'apps/web/components/orders/summary/order-summary-unified-table.tsx',
  );

  test('импортирует listOrderMaterialIssues из существующего API-обёртки', () => {
    expect(src).toMatch(/listOrderMaterialIssues/);
    expect(src).toMatch(/from '@\/lib\/material-issues-api'/);
  });

  test('использует существующий endpoint /api/orders/:orderId/material-issues, без новых backend-вызовов', () => {
    // Грузится в общем `Promise.all` рядом с workshopNeeds /
    // cutReadiness / purchaseOrders / purchaseReceipts. Никаких
    // отдельных fetch для finance summary не появляется.
    expect(src).toMatch(/safe[\s\S]*?listOrderMaterialIssues/);
    expect(src).toMatch(/Фактический расход материалов/);
  });

  test('пробрасывает materialIssues в computeOrderSummaryTotals', () => {
    expect(src).toMatch(
      /computeOrderSummaryTotals\(\{[\s\S]*?materialIssues:/,
    );
  });

  test('рендерит три строки итогов по материалам: план / факт / Δ', () => {
    // testId-литералы (`testId: 'order-summary-totals-material-...'`)
    // выставляются в одной структуре с rows и попадают в JSX как
    // `data-testid={r.testId}`. Проверяем substring — той же
    // конвенцией пользуется соседний smoke
    // `admin-order-summary-unified.smoke.test.ts`.
    expect(src).toMatch(/order-summary-totals-material-planned/);
    expect(src).toMatch(/order-summary-totals-material-actual/);
    expect(src).toMatch(/order-summary-totals-material-delta/);
    expect(src).toMatch(/Материалы за тираж · факт/);
    expect(src).toMatch(/Материалы за тираж · Δ \(факт − план\)/);
  });

  test('Δ-строка применяет тон success / danger через order-summary-margin', () => {
    expect(src).toMatch(/order-summary-margin--positive/);
    expect(src).toMatch(/order-summary-margin--negative/);
  });

  test('OrderSummaryTab остался тонким wrapper (без логики загрузки факта)', () => {
    // Per ТЗ §7: `OrderSummaryTab` — server component, fetch внутри
    // глубоко вложенного клиента не делаем. Загрузка
    // `MaterialIssue` живёт в server-loader самого
    // `OrderSummaryUnifiedTable`, а не в `OrderSummaryTab`.
    const tabSrc = read(
      'apps/web/components/orders/tabs/order-summary-tab.tsx',
    );
    expect(tabSrc).not.toMatch(/listOrderMaterialIssues/);
    expect(tabSrc).not.toMatch(/getMaterialIssue/);
    expect(tabSrc).toMatch(/<OrderSummaryUnifiedTable\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. Backend / OrderViewTabs / прочие модули НЕ менялись
// ---------------------------------------------------------------------------

describe('Order-level actual material cost — backend / соседние модули НЕ менялись', () => {
  test('backend модуль material-issues остался без изменений в эту итерацию', () => {
    // Базовая sanity-проверка — контроллер на месте, RBAC
    // ADMIN/SHOP_MANAGER, эндпоинт /orders/:id/material-issues есть.
    const controller = read(
      'apps/api/src/modules/material-issues/material-issues.controller.ts',
    );
    expect(controller).toMatch(/@Controller\(['"]material-issues['"]\)/);
    expect(controller).toMatch(
      /@Roles\(\s*['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\s*\)/,
    );
    const orderController = read(
      'apps/api/src/modules/material-issues/material-issues.order-controller.ts',
    );
    expect(orderController).toMatch(/@Get\(['"]\:orderId\/material-issues['"]\)/);
  });

  test('CostsService и ProductionCostV2Service не упоминают финансовую сводку с фактом материалов', () => {
    const costs = exists('apps/api/src/modules/costs/costs.service.ts')
      ? read('apps/api/src/modules/costs/costs.service.ts')
      : '';
    if (costs) {
      expect(costs).not.toMatch(/materialActualCostRub/);
      expect(costs).not.toMatch(/buildOrderSummaryRows/);
    }
    const prodV2 = exists(
      'apps/api/src/modules/production-cost/production-cost-v2.service.ts',
    )
      ? read(
          'apps/api/src/modules/production-cost/production-cost-v2.service.ts',
        )
      : '';
    if (prodV2) {
      expect(prodV2).not.toMatch(/materialActualCostRub/);
      expect(prodV2).not.toMatch(/buildOrderSummaryRows/);
    }
  });

  test('OrderMaterialsUnifiedTable и MaterialIssuesSection в этой итерации не получают новых колонок/секций', () => {
    // Sanity: вкладка «Потребности» не пересобирается. Файлы
    // существуют, но никаких новых пометок «order-level summary»
    // там быть не должно.
    expect(
      exists(
        'apps/web/components/orders/materials/order-materials-unified-table.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/material-issues/material-issues-section.tsx',
      ),
    ).toBe(true);
    const matSrc = read(
      'apps/web/components/orders/materials/order-materials-unified-table.tsx',
    );
    expect(matSrc).not.toMatch(/materialActualCostRub/);
    expect(matSrc).not.toMatch(/materialDeltaCostRub/);
  });

  test('Prisma schema не получала новых таблиц/полей под order-level financial summary', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/materialActualCostRub/);
    expect(schema).not.toMatch(/materialDeltaCostRub/);
  });

  test('shared/material-issues — DTO без изменений (Detail / Line / ListItem)', () => {
    const src = read('packages/shared/src/material-issues.ts');
    expect(src).toMatch(/export\s+interface\s+MaterialIssueDetailDto\b/);
    expect(src).toMatch(/export\s+interface\s+MaterialIssueLineDto\b/);
    expect(src).toMatch(/export\s+interface\s+MaterialIssueListItemDto\b/);
  });
});
