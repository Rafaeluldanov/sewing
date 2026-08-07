/**
 * Smoke-тесты фичи «Сводно по заказу: разбиение материалов по
 * расцветкам» (07.08).
 *
 * Source-of-truth:
 *   - Row builder + группировщик:
 *     `apps/web/components/orders/summary/build-order-summary-rows.ts`
 *     (`OrderSummaryRow.orderVariantId` / `variantColor`,
 *     `groupOrderSummaryRowsByColorway`);
 *   - Сворачиваемый блок:
 *     `apps/web/components/orders/summary/order-summary-colorway-collapsible.tsx`;
 *   - Таблица: `apps/web/components/orders/summary/order-summary-unified-table.tsx`;
 *   - Стили: `apps/web/app/globals.css` (`.order-summary-groups`,
 *     `.summary-colorway*`).
 *
 * Контракт фичи (решение владельца 07.08, вариант «а»):
 *   1. Материальные строки группируются по `WorkshopNeed.orderVariantId`;
 *      каждая расцветка — сворачиваемый блок.
 *   2. Подытог блока — ТОЛЬКО материальная часть расцветки (Σ строк
 *      группы); операции и order-level строки в подытог расцветки не
 *      входят.
 *   3. «За 1 изделие» внутри блока делится на тираж РАСЦВЕТКИ, не заказа.
 *   4. Строки без расцветки — блок «Общее по заказу»; операции — единой
 *      таблицей ниже блоков.
 *   5. Общий итог (KPI / TotalsBlock) считается ДО группировки и от неё
 *      не зависит; заказ без расцветок рендерится плоской таблицей.
 *   6. Backend / Prisma / WorkshopNeed formulas — НЕ менялись; живые
 *      расцветки берутся существующей обёрткой `getOrderColorways`.
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

// ---------------------------------------------------------------------------
// 1. Row builder: атрибуция строки к расцветке + группировщик
// ---------------------------------------------------------------------------

describe('build-order-summary-rows — расцветка на строке + группировщик', () => {
  const src = read(
    'apps/web/components/orders/summary/build-order-summary-rows.ts',
  );

  test('OrderSummaryRow несёт orderVariantId / variantColor', () => {
    expect(src).toMatch(/orderVariantId:\s*string \| null/);
    expect(src).toMatch(/variantColor:\s*string \| null/);
    // Материальная строка берёт атрибуцию из потребности…
    expect(src).toMatch(/row\.originalNeed\.orderVariantId/);
    expect(src).toMatch(/row\.originalNeed\.variantColor/);
    // …а операция к расцветке не привязана.
    expect(src).toMatch(/Маршрут один на заказ/);
  });

  test('экспортирует groupOrderSummaryRowsByColorway + типы групп', () => {
    expect(src).toMatch(
      /export\s+function\s+groupOrderSummaryRowsByColorway/,
    );
    expect(src).toMatch(
      /export\s+interface\s+OrderSummaryColorwayGroup\s*\{/,
    );
    expect(src).toMatch(
      /export\s+interface\s+OrderSummaryColorwayGrouping\s*\{/,
    );
  });

  test('подытог блока — только материальная часть (вариант «а»)', () => {
    // Операции уходят в отдельную коллекцию, не в группы расцветок.
    expect(src).toMatch(/section === 'OPERATION'/);
    expect(src).toMatch(/operationRows\.push/);
    // Подытог группы — Σ totalRub строк группы.
    expect(src).toMatch(/materialTotalRub/);
    expect(src).toMatch(/materialPerUnitRub/);
  });

  test('«За 1 изделие» в блоке — на тираж расцветки', () => {
    // Пересчёт unitCostRub строк группы по qty расцветки.
    expect(src).toMatch(/r\.totalRub\s*\/\s*qty\b/);
    // Тираж расцветки — Σ qtyPlan живого поразмерного плана.
    expect(src).toMatch(/qty\s*\+=\s*s\.qtyPlan/);
  });

  test('лейбл группы деградирует на snapshot variantColor', () => {
    expect(src).toMatch(/live\?\.color\s*\?\?\s*snapshotColor/);
  });

  test('helper остаётся pure: без импортов из @/lib', () => {
    expect(src).not.toMatch(/from '@\/lib\//);
  });
});

// ---------------------------------------------------------------------------
// 2. Сворачиваемый блок расцветки
// ---------------------------------------------------------------------------

describe('OrderSummaryColorwayCollapsible — client-блок сворачивания', () => {
  test('файл существует', () => {
    expect(
      exists(
        'apps/web/components/orders/summary/order-summary-colorway-collapsible.tsx',
      ),
    ).toBe(true);
  });

  const src = read(
    'apps/web/components/orders/summary/order-summary-colorway-collapsible.tsx',
  );

  test('client-компонент по паттерну OrderNeedsCollapsible', () => {
    expect(src).toMatch(/^'use client';/);
    expect(src).toMatch(
      /export\s+function\s+OrderSummaryColorwayCollapsible/,
    );
    expect(src).toMatch(/useState\(defaultOpen\)/);
    expect(src).toMatch(/aria-expanded=\{open\}/);
    expect(src).toMatch(/data-open=\{open \|\| undefined\}/);
  });

  test('testid-ы блоков расцветки и «Общее по заказу»', () => {
    expect(src).toMatch(/order-summary-colorway-block/);
    expect(src).toMatch(/order-summary-common-block/);
  });
});

// ---------------------------------------------------------------------------
// 3. Unified-таблица: блоки + фолбэк на плоскую таблицу
// ---------------------------------------------------------------------------

describe('OrderSummaryUnifiedTable — блоки расцветок', () => {
  const src = read(
    'apps/web/components/orders/summary/order-summary-unified-table.tsx',
  );

  test('живые расцветки — существующая обёртка getOrderColorways', () => {
    expect(src).toMatch(/getOrderColorways/);
    expect(src).toMatch(/from '@\/lib\/colorways-api'/);
    // Запрос делается только когда потребность посчитана по расцветкам.
    expect(src).toMatch(
      /workshopNeeds\.some\(\(n\) => n\.orderVariantId\)/,
    );
  });

  test('группировка после подсчёта общего итога, итог не меняется', () => {
    expect(src).toMatch(/groupOrderSummaryRowsByColorway/);
    const totalsIdx = src.indexOf('computeOrderSummaryTotals({');
    const groupingIdx = src.indexOf('groupOrderSummaryRowsByColorway({');
    expect(totalsIdx).toBeGreaterThan(-1);
    expect(groupingIdx).toBeGreaterThan(totalsIdx);
    // TotalsBlock внизу — как раньше.
    expect(src).toMatch(/<TotalsBlock totals=\{totals\} \/>/);
  });

  test('рендерит блоки + «Общее по заказу» + операции единой таблицей', () => {
    expect(src).toMatch(/<OrderSummaryColorwayCollapsible/);
    expect(src).toMatch(/data-testid="order-summary-colorway-groups"/);
    expect(src).toMatch(/Общее по заказу/);
    expect(src).toMatch(/grouping\.operationRows/);
    // Подытог блока — материальная часть расцветки.
    expect(src).toMatch(/Материалы и фурнитура за тираж/);
    expect(src).toMatch(/За 1 изделие расцветки/);
  });

  test('заказ без расцветок — плоская таблица как раньше', () => {
    expect(src).toMatch(/hasColorwayBlocks/);
    expect(src).toMatch(/!hasColorwayBlocks \? \(/);
    // Плоская ветка рендерит все строки одним AdminTable.
    expect(src).toMatch(/rows=\{summaryRows\}/);
  });
});

// ---------------------------------------------------------------------------
// 4. CSS
// ---------------------------------------------------------------------------

describe('globals.css — стили блоков расцветок', () => {
  const css = read('apps/web/app/globals.css');

  test('классы блоков определены', () => {
    expect(css).toMatch(/\.order-summary-groups\s*\{/);
    expect(css).toMatch(/\.summary-colorway\s*\{/);
    expect(css).toMatch(/\.summary-colorway__head\b/);
    expect(css).toMatch(/\.summary-colorway__sum-v\b/);
    expect(css).toMatch(/\.summary-colorway__toggle\b/);
    expect(css).toMatch(
      /\.summary-colorway\[data-open\] \.summary-colorway__chev/,
    );
  });
});
