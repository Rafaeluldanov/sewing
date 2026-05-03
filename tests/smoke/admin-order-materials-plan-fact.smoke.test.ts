/**
 * Smoke-тесты frontend-итерации «План / факт по фактическому
 * расходу материалов» в `OrderMaterialsUnifiedTable` (вкладка
 * «Потребности» карточки заказа `/admin/orders/[id]?tab=needs`).
 *
 * UI-решение владельца:
 *   - НЕ создаётся новая страница / роут;
 *   - НЕ создаётся новый пункт меню;
 *   - НЕ создаётся новая вкладка;
 *   - НЕ создаётся новый раздел;
 *   - факт расхода добавляется в **уже существующую** таблицу
 *     `OrderMaterialsUnifiedTable` через 2 компактные колонки
 *     «План / факт» (количество) и «Стоимость план / факт».
 *
 * Source-of-truth:
 *   - Builder:    `apps/web/components/orders/materials/build-order-material-rows.ts`
 *   - Table:      `apps/web/components/orders/materials/order-materials-unified-table.tsx`
 *   - Tab wiring: `apps/web/components/orders/view/tabs/order-needs-tab.tsx`
 *   - Section:    `apps/web/components/orders/material-issues/material-issues-section.tsx`
 *   - Shared:     `packages/shared/src/material-issues.ts`
 *
 * Цели проверок (см. ТЗ §11 «Tests» итерации план/факт):
 *   1. OrderMaterialsUnifiedTable принимает MaterialIssue / actual расход.
 *   2. POSTED MaterialIssueLine агрегируется по workshopNeedId.
 *   3. DRAFT MaterialIssueLine не попадает в факт.
 *   4. CANCELLED MaterialIssueLine не попадает в факт.
 *   5. Строка без workshopNeedId не попадает в план/факт.
 *   6. actualCost считается из line.totalCost.
 *   7. issuedQtyFact считается только при совпадении unit.
 *   8. unit mismatch показывает warning.
 *   9. plannedQty берётся из WorkshopNeed.calculatedQty.
 *  10. plannedCost считается из calculatedQty * quotedPrice.
 *  11. Не создаётся новая страница /admin/material-issues.
 *  12. Не меняется OrderViewTabs.
 *
 * Часть тестов — функциональные (через `buildOrderMaterialRows`),
 * часть — статические по исходникам (как соседний smoke-набор
 * `admin-order-material-issues.smoke.test.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  buildOrderMaterialRows,
  type OrderMaterialTableRow,
} from '../../apps/web/components/orders/materials/build-order-material-rows';
import type { MaterialIssueDetailDto } from '../../packages/shared/src/material-issues';
import type { WorkshopNeedListItemDto } from '../../packages/shared/src/workshop-needs';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

// ---------------------------------------------------------------------------
// Helpers: фабрики minimal-DTO для агрегатора
// ---------------------------------------------------------------------------

let workshopNeedSeq = 0;
function makeWorkshopNeed(
  overrides: Partial<WorkshopNeedListItemDto> = {},
): WorkshopNeedListItemDto {
  workshopNeedSeq += 1;
  const id = overrides.id ?? `wn-${workshopNeedSeq}`;
  return {
    id,
    orderId: 'order-1',
    orderNumber: 'OR-1',
    orderStatus: 'CALCULATION',
    orderDueDate: null,
    orderColor: null,
    clientId: null,
    clientName: null,
    nomenclatureName: null,
    nomenclatureArticle: null,
    nomenclaturePreviewImageUrl: null,
    nomenclatureSource: 'PATTERN',
    sourceType: 'PATTERN',
    sourceId: null,
    materialRole: 'MAIN_FABRIC',
    sourceName: null,
    description: 'Дюспо',
    fabricType: null,
    densityGsm: null,
    plannedWidthCm: null,
    colorRule: null,
    fixedColorText: null,
    resolvedColorText: null,
    totalAreaM2: null,
    calculatedQty: '10',
    purchaseQty: null,
    unit: 'м',
    calculationMethod: 'AREA',
    status: 'CALCULATED',
    supplierNameText: null,
    purchaseItemNameText: null,
    quotedPrice: '100',
    quotedCurrency: 'RUB',
    expectedDeliveryDate: null,
    ...(overrides as Partial<WorkshopNeedListItemDto>),
  } as WorkshopNeedListItemDto;
}

let issueSeq = 0;
function makeIssue(
  status: 'DRAFT' | 'POSTED' | 'CANCELLED',
  lines: Array<{
    workshopNeedId: string | null;
    issuedQty: string;
    unitCost: string;
    totalCost: string;
    unit: string;
    description?: string;
    materialRole?: string | null;
  }>,
): MaterialIssueDetailDto {
  issueSeq += 1;
  return {
    id: `issue-${issueSeq}`,
    orderId: 'order-1',
    orderNumber: 'OR-1',
    orderStatus: 'CALCULATION',
    passportId: null,
    passportNumber: null,
    status,
    totalCost: lines
      .reduce((s, l) => s + Number(l.totalCost), 0)
      .toString(),
    createdAt: new Date('2026-01-01').toISOString(),
    postedAt: status === 'POSTED' ? new Date('2026-01-02').toISOString() : null,
    cancelledAt:
      status === 'CANCELLED' ? new Date('2026-01-03').toISOString() : null,
    createdById: 'u-1',
    postedById: status === 'POSTED' ? 'u-1' : null,
    cancelledById: status === 'CANCELLED' ? 'u-1' : null,
    cancelReason: null,
    lines: lines.map((l, idx) => ({
      id: `issue-${issueSeq}-line-${idx}`,
      workshopNeedId: l.workshopNeedId,
      workshopNeed: l.workshopNeedId
        ? {
            id: l.workshopNeedId,
            description: l.description ?? 'Дюспо',
            materialRole: l.materialRole ?? 'MAIN_FABRIC',
            unit: l.unit,
          }
        : null,
      description: l.description ?? 'Дюспо',
      materialRole: l.materialRole ?? 'MAIN_FABRIC',
      unit: l.unit,
      issuedQty: l.issuedQty,
      unitCost: l.unitCost,
      totalCost: l.totalCost,
      cellId: null,
      cellCode: null,
      comment: null,
    })),
  };
}

function buildRow(
  needs: WorkshopNeedListItemDto[],
  materialIssues: MaterialIssueDetailDto[] | undefined,
): OrderMaterialTableRow[] {
  return buildOrderMaterialRows({
    workshopNeeds: needs,
    cutReadiness: null,
    purchaseOrders: [],
    purchaseReceipts: [],
    purchaseReceiptDetails: new Map(),
    materialIssues,
  });
}

// ---------------------------------------------------------------------------
// 1. Файлы: ничего нового создавать не должны
// ---------------------------------------------------------------------------

describe('План/факт: новые страницы / разделы НЕ создаются', () => {
  test('отдельная страница /admin/material-issues НЕ существует', () => {
    expect(exists('apps/web/app/admin/material-issues/page.tsx')).toBe(false);
    expect(exists('apps/web/app/admin/material-issues')).toBe(false);
  });

  test('новая отдельная вкладка / страница «План/факт» НЕ создавалась', () => {
    expect(exists('apps/web/app/admin/material-plan-fact')).toBe(false);
    expect(
      exists('apps/web/components/orders/view/tabs/order-plan-fact-tab.tsx'),
    ).toBe(false);
    expect(
      exists(
        'apps/web/components/orders/materials/order-materials-plan-fact-table.tsx',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. OrderViewTabs / OrderNeedsTab: набор вкладок не меняется
// ---------------------------------------------------------------------------

describe('OrderViewTabs не меняется (не появляется новый таб)', () => {
  const tabsCandidate = [
    'apps/web/components/orders/view/order-view-tabs.tsx',
    'apps/web/components/orders/view/tabs/order-view-tabs.tsx',
  ].find((p) => exists(p));

  test('файл вкладок если существует — не упоминает «план/факт» как отдельный таб', () => {
    if (!tabsCandidate) {
      // Tabs могут жить прямо в page.tsx — это не делает итерацию
      // некорректной, главное чтобы новый таб не появился.
      const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');
      expect(pageSrc.toLowerCase()).not.toMatch(/['"]plan-fact['"]/);
      expect(pageSrc.toLowerCase()).not.toMatch(
        /['"]material-issues['"][^,)]*\?tab/,
      );
      return;
    }
    const src = read(tabsCandidate);
    expect(src.toLowerCase()).not.toMatch(/['"]plan-fact['"]/);
    expect(src.toLowerCase()).not.toMatch(/['"]material-plan-fact['"]/);
  });
});

// ---------------------------------------------------------------------------
// 3. buildOrderMaterialRows: агрегация по статусам
// ---------------------------------------------------------------------------

describe('buildOrderMaterialRows — агрегация план/факт по MaterialIssue', () => {
  test('1. без MaterialIssue: issuedQtyFact=0, actualCost=0, deltaQty=-plannedQty', () => {
    const need = makeWorkshopNeed({
      id: 'wn-A',
      calculatedQty: '7',
      quotedPrice: '50',
      unit: 'м',
    });
    const [row] = buildRow([need], undefined);
    expect(row.plannedQty).toBe('7');
    expect(row.plannedCost).toBe('350');
    expect(row.issuedQtyFact).toBe('0');
    expect(row.actualCost).toBe('0');
    expect(row.deltaQty).toBe('-7');
    // deltaCost = 0 - 350 = -350
    expect(row.deltaCost).toBe('-350');
    expect(row.unitMismatch).toBe(false);
    expect(row.postedIssueLineCount).toBe(0);
  });

  test('2. POSTED MaterialIssueLine агрегируется по workshopNeedId', () => {
    const need = makeWorkshopNeed({
      id: 'wn-B',
      calculatedQty: '10',
      quotedPrice: '100',
      unit: 'м',
    });
    const issue = makeIssue('POSTED', [
      {
        workshopNeedId: 'wn-B',
        issuedQty: '4',
        unitCost: '100',
        totalCost: '400',
        unit: 'м',
      },
      {
        workshopNeedId: 'wn-B',
        issuedQty: '3',
        unitCost: '100',
        totalCost: '300',
        unit: 'м',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.issuedQtyFact).toBe('7');
    expect(row.actualCost).toBe('700');
    // 7 - 10 = -3
    expect(row.deltaQty).toBe('-3');
    // 700 - 1000 = -300
    expect(row.deltaCost).toBe('-300');
    expect(row.postedIssueLineCount).toBe(2);
  });

  test('3. DRAFT MaterialIssueLine НЕ попадает в факт', () => {
    const need = makeWorkshopNeed({ id: 'wn-C', calculatedQty: '5' });
    const issue = makeIssue('DRAFT', [
      {
        workshopNeedId: 'wn-C',
        issuedQty: '3',
        unitCost: '100',
        totalCost: '300',
        unit: 'м',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.issuedQtyFact).toBe('0');
    expect(row.actualCost).toBe('0');
    expect(row.postedIssueLineCount).toBe(0);
  });

  test('4. CANCELLED MaterialIssueLine НЕ попадает в факт', () => {
    const need = makeWorkshopNeed({ id: 'wn-D', calculatedQty: '5' });
    const issue = makeIssue('CANCELLED', [
      {
        workshopNeedId: 'wn-D',
        issuedQty: '2',
        unitCost: '100',
        totalCost: '200',
        unit: 'м',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.issuedQtyFact).toBe('0');
    expect(row.actualCost).toBe('0');
    expect(row.postedIssueLineCount).toBe(0);
  });

  test('5. строка без workshopNeedId НЕ попадает в план/факт', () => {
    const need = makeWorkshopNeed({ id: 'wn-E', calculatedQty: '5' });
    const issue = makeIssue('POSTED', [
      // Свободная строка без workshopNeedId — backend разрешает,
      // фронт не должен её агрегировать.
      {
        workshopNeedId: null,
        issuedQty: '2',
        unitCost: '100',
        totalCost: '200',
        unit: 'м',
      },
      {
        workshopNeedId: 'wn-E',
        issuedQty: '3',
        unitCost: '100',
        totalCost: '300',
        unit: 'м',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.issuedQtyFact).toBe('3');
    expect(row.actualCost).toBe('300');
    expect(row.postedIssueLineCount).toBe(1);
  });

  test('6. actualCost считается из line.totalCost (а не unitCost*issuedQty)', () => {
    const need = makeWorkshopNeed({ id: 'wn-F', calculatedQty: '10' });
    const issue = makeIssue('POSTED', [
      // totalCost явно «переопределённый» (например, скидка) — мы
      // суммируем именно его, а не пересчитываем.
      {
        workshopNeedId: 'wn-F',
        issuedQty: '2',
        unitCost: '100',
        totalCost: '180',
        unit: 'м',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.actualCost).toBe('180');
  });

  test('7. issuedQtyFact считается только при совпадении unit', () => {
    const need = makeWorkshopNeed({
      id: 'wn-G',
      calculatedQty: '10',
      unit: 'м',
    });
    const issue = makeIssue('POSTED', [
      {
        workshopNeedId: 'wn-G',
        issuedQty: '2',
        unitCost: '100',
        totalCost: '200',
        unit: 'м',
      },
      // Другой unit — НЕ суммируется в количество.
      {
        workshopNeedId: 'wn-G',
        issuedQty: '3000',
        unitCost: '0.1',
        totalCost: '300',
        unit: 'см',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.issuedQtyFact).toBe('2');
    // Стоимость суммируется независимо от unit (totalCost — это деньги).
    expect(row.actualCost).toBe('500');
  });

  test('8. unit mismatch выставляет unitMismatch=true', () => {
    const need = makeWorkshopNeed({
      id: 'wn-H',
      calculatedQty: '10',
      unit: 'м',
    });
    const issue = makeIssue('POSTED', [
      {
        workshopNeedId: 'wn-H',
        issuedQty: '500',
        unitCost: '0.1',
        totalCost: '50',
        unit: 'см',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.unitMismatch).toBe(true);
    expect(row.issuedQtyFact).toBe('0');
    // Стоимость остаётся: totalCost суммируется независимо от unit.
    expect(row.actualCost).toBe('50');
  });

  test('9. plannedQty берётся из WorkshopNeed.calculatedQty (не purchaseQty)', () => {
    const need = makeWorkshopNeed({
      id: 'wn-I',
      calculatedQty: '7.5',
      // purchaseQty намеренно > calculatedQty (закупаем с запасом),
      // план расхода берём из calculatedQty.
      purchaseQty: '10',
      quotedPrice: '100',
      unit: 'м',
    });
    const [row] = buildRow([need], undefined);
    expect(row.plannedQty).toBe('7.5');
  });

  test('10. plannedCost = calculatedQty * quotedPrice (для RUB)', () => {
    const need = makeWorkshopNeed({
      id: 'wn-J',
      calculatedQty: '4',
      quotedPrice: '125',
      quotedCurrency: 'RUB',
    });
    const [row] = buildRow([need], undefined);
    expect(row.plannedCost).toBe('500');
  });

  test('plannedCost = null, если quotedPrice отсутствует', () => {
    const need = makeWorkshopNeed({
      id: 'wn-K',
      calculatedQty: '4',
      quotedPrice: null,
      quotedCurrency: null,
    });
    const [row] = buildRow([need], undefined);
    expect(row.plannedCost).toBeNull();
    expect(row.deltaCost).toBeNull();
  });

  test('plannedCost = null для USD-цены (курса нет, см. ТЗ §6 «формат денег»)', () => {
    const need = makeWorkshopNeed({
      id: 'wn-L',
      calculatedQty: '4',
      quotedPrice: '125',
      quotedCurrency: 'USD',
    });
    const [row] = buildRow([need], undefined);
    expect(row.plannedCost).toBeNull();
  });

  test('строка с workshopNeedId, не существующим в наборе needs, не падает и не агрегирует', () => {
    const need = makeWorkshopNeed({ id: 'wn-M', calculatedQty: '5' });
    const issue = makeIssue('POSTED', [
      {
        workshopNeedId: 'wn-MISSING',
        issuedQty: '99',
        unitCost: '99',
        totalCost: '9999',
        unit: 'м',
      },
      {
        workshopNeedId: 'wn-M',
        issuedQty: '2',
        unitCost: '100',
        totalCost: '200',
        unit: 'м',
      },
    ]);
    const [row] = buildRow([need], [issue]);
    expect(row.issuedQtyFact).toBe('2');
    expect(row.actualCost).toBe('200');
  });
});

// ---------------------------------------------------------------------------
// 4. OrderMaterialsUnifiedTable: новые колонки + props materialIssues
// ---------------------------------------------------------------------------

describe('OrderMaterialsUnifiedTable — новые колонки «План / факт»', () => {
  const src = read(
    'apps/web/components/orders/materials/order-materials-unified-table.tsx',
  );

  test('принимает props.materialIssues (опционально)', () => {
    expect(src).toMatch(/materialIssues\?:\s*MaterialIssueDetailDto\[\]/);
    // Прокидывается в builder.
    expect(src).toMatch(/buildOrderMaterialRows\(\{[\s\S]*?materialIssues/);
  });

  test('таблица содержит новые колонки «План / факт» и «Стоимость план / факт»', () => {
    expect(src).toMatch(/header:\s*['"]План \/ факт['"]/);
    expect(src).toMatch(/header:\s*['"]Стоимость план \/ факт['"]/);
    // Render-функции для них существуют.
    expect(src).toMatch(/PlanFactQtyCell/);
    expect(src).toMatch(/PlanFactCostCell/);
  });

  test('таблица показывает «нет проведённых расходов» при отсутствии факта', () => {
    expect(src).toMatch(/нет проведённых расходов/);
  });

  test('таблица показывает warning «Ед. изм. отличаются» при unit mismatch', () => {
    expect(src).toMatch(/Ед\. изм\. отличаются/);
    expect(src).toMatch(/data-testid="order-materials-planfact-unit-mismatch"/);
  });

  test('таблица не превратилась в новую таблицу/страницу', () => {
    // Никаких ссылок на отдельный роут /admin/material-plan-fact.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/['"`]\/admin\/material-plan-fact/);
  });
});

// ---------------------------------------------------------------------------
// 5. OrderNeedsTab — Variant A: один fetch, передача в оба компонента
// ---------------------------------------------------------------------------

describe('OrderNeedsTab — Variant A: MaterialIssue загружается один раз', () => {
  const src = read(
    'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
  );

  test('OrderNeedsTab стал async и использует listOrderMaterialIssues + getMaterialIssue', () => {
    expect(src).toMatch(/export\s+async\s+function\s+OrderNeedsTab/);
    expect(src).toMatch(/listOrderMaterialIssues\(/);
    expect(src).toMatch(/getMaterialIssue\(/);
  });

  test('передаёт materialIssues в OrderMaterialsUnifiedTable', () => {
    expect(src).toMatch(
      /<OrderMaterialsUnifiedTable[\s\S]*?materialIssues=\{materialIssues\}/,
    );
  });

  test('передаёт preloadedItems / preloadedIssueDetails в MaterialIssuesSection', () => {
    expect(src).toMatch(
      /<MaterialIssuesSection[\s\S]*?preloadedItems=\{materialIssueItems\}/,
    );
    expect(src).toMatch(
      /<MaterialIssuesSection[\s\S]*?preloadedIssueDetails=\{materialIssueDetails\}/,
    );
  });

  test('структура вкладки не изменилась: MaterialIssuesSection всё ещё ПОСЛЕ OrderMaterialsUnifiedTable', () => {
    const idxMaterials = src.indexOf('<OrderMaterialsUnifiedTable');
    const idxIssues = src.indexOf('<MaterialIssuesSection');
    expect(idxMaterials).toBeGreaterThan(-1);
    expect(idxIssues).toBeGreaterThan(-1);
    expect(idxIssues).toBeGreaterThan(idxMaterials);
  });
});

// ---------------------------------------------------------------------------
// 6. MaterialIssuesSection — поддержка preloaded data (без второго fetch)
// ---------------------------------------------------------------------------

describe('MaterialIssuesSection — preloaded data, без повторного fetch', () => {
  const src = read(
    'apps/web/components/orders/material-issues/material-issues-section.tsx',
  );

  test('Props добавлены: preloadedItems / preloadedIssueDetails', () => {
    expect(src).toMatch(/preloadedItems\?:\s*MaterialIssueListItemDto\[\]/);
    expect(src).toMatch(
      /preloadedIssueDetails\?:\s*Record<\s*string,\s*MaterialIssueDetailDto \| undefined\s*>/,
    );
  });

  test('если preloaded — fetch не делается', () => {
    // Грубая проверка: вызов listOrderMaterialIssues / getMaterialIssue
    // обёрнут в условие `if (!preloadedItems)` / `if (preloadedIssueDetails) … else { ... }`.
    expect(src).toMatch(/if\s*\(\s*!preloadedItems\s*\)/);
    expect(src).toMatch(/if\s*\(\s*preloadedIssueDetails\s*\)/);
  });

  test('обратная совместимость: без preloaded работает по-старому (fallback)', () => {
    expect(src).toMatch(/listOrderMaterialIssues\(/);
    expect(src).toMatch(/getMaterialIssue\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. CSS-классы для нового блока «План / Факт / Δ»
// ---------------------------------------------------------------------------

describe('globals.css — стили для блока «План / Факт / Δ»', () => {
  const css = read('apps/web/app/globals.css');

  test('классы plan/fact определены', () => {
    expect(css).toMatch(/\.order-materials-table__planfact\s*\{/);
    expect(css).toMatch(/\.order-materials-table__planfact-row\b/);
    expect(css).toMatch(/\.order-materials-table__planfact-label\b/);
    expect(css).toMatch(/\.order-materials-table__planfact-value\b/);
    expect(css).toMatch(/\.order-materials-table__planfact-delta\b/);
    expect(css).toMatch(/\.order-materials-table__planfact-delta--over\b/);
    expect(css).toMatch(/\.order-materials-table__planfact-delta--under\b/);
    expect(css).toMatch(/\.order-materials-table__planfact-delta--equal\b/);
  });
});

// ---------------------------------------------------------------------------
// 8. Backend / shared / docs не трогаем без необходимости
// ---------------------------------------------------------------------------

describe('Backend / shared НЕ менялись (frontend-only итерация план/факт)', () => {
  test('shared/material-issues — DTO без изменений (Detail / Line / ListItem)', () => {
    const src = read('packages/shared/src/material-issues.ts');
    expect(src).toMatch(/export\s+interface\s+MaterialIssueDetailDto\b/);
    expect(src).toMatch(/export\s+interface\s+MaterialIssueLineDto\b/);
    expect(src).toMatch(/export\s+interface\s+MaterialIssueListItemDto\b/);
  });

  test('OrderSummaryUnifiedTable не использует per-row issuedQtyFact (только order-level totalCost)', () => {
    const summarySrc = read(
      'apps/web/components/orders/summary/order-summary-unified-table.tsx',
    );
    // План/факт по количествам (`issuedQtyFact`) — это ownership
    // вкладки «Потребности» (`OrderMaterialsUnifiedTable`).
    // Финансовая сводка показывает только order-level
    // фактическую СТОИМОСТЬ материалов через
    // `MaterialIssue.totalCost` (см. соседний smoke
    // `admin-order-summary-actual-material-cost.smoke.test.ts`),
    // и не должна тянуть на frontend пересчёт строк.
    expect(summarySrc).not.toMatch(/issuedQtyFact/);
  });

  test('не появилось master-модели Material и WAREHOUSE_MANAGER роли', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/model\s+Material\s*\{/);
    expect(schema).not.toMatch(/WAREHOUSE_MANAGER/);
    expect(schema).not.toMatch(/model\s+StockBalance\b/);
    expect(schema).not.toMatch(/model\s+StockMovement\b/);
    expect(schema).not.toMatch(/model\s+MaterialStockLot\b/);
  });
});
