/**
 * Regression smoke — материалы заказа не дублируются во вкладке
 * «Потребности» (`/admin/orders/:id?tab=needs`).
 *
 * История проблемы:
 *   `OrderSummaryUnifiedTable` (canonical itemized cost breakdown,
 *   рендерит строки материалов И операций в одной таблице) одно
 *   время подключали в `OrderNeedsTab` рядом с
 *   `OrderMaterialsUnifiedTable`. Из-за этого один и тот же
 *   материал (Дюспо, Таффета, Синтепон, Снапбонд, Нитки, Молнии…)
 *   рисовался во вкладке дважды. Флаг `hideKpiBar` проблему не
 *   решал, потому что прятал только верхний KPI-полосу, а не
 *   построчный itemized rows.
 *
 * Архитектурное правило (см. JSDoc в
 * `apps/web/components/orders/view/tabs/order-needs-tab.tsx`):
 *
 *   - Needs владеет только material requirements + procurement +
 *     receipts + outsource + aggregate-only cost totals.
 *   - Канонический материал-блок Needs — `OrderMaterialsUnifiedTable`.
 *   - Полный itemized cost breakdown (`OrderSummaryUnifiedTable`,
 *     или его потенциальный rename `OrderItemizedCostBreakdownTable` /
 *     `OrderCostBreakdownTable`) принадлежит отдельной финансовой
 *     вкладке «Сводно по заказу» (`?tab=costSummary` →
 *     `OrderSummaryTab`), а не Needs. Если когда-нибудь появится
 *     ещё и stand-alone cost route (`/admin/orders/:id/cost`), он
 *     переиспользует тот же компонент.
 *   - Aggregate-only cost-card (например,
 *     `OrderPlannedCostSummaryCard`) допустим в Needs, если он не
 *     рендерит названия конкретных материалов/операций и не
 *     использует `buildOrderMaterialRows` /
 *     `buildOrderOperationRows` / `buildOrderSummaryRows` для
 *     рендера строк.
 *
 * Этот тест должен **упасть**, если кто-то снова добавит во вкладку
 * Needs `OrderSummaryUnifiedTable` или другой компонент с itemized
 * cost rows. Возврат `OrderSummaryUnifiedTable` в новую вкладку
 * «Сводно по заказу» — наоборот, ожидаемое поведение и тестируется
 * в `admin-order-summary-unified.smoke.test.ts`.
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
 * Удаляет JSDoc / block-comments (`/* ... *‍/`) и line-comments
 * (`// ...`) из исходника. Архитектурные хинты вида «do not render
 * OrderSummaryUnifiedTable here» живут в комментариях — иначе
 * следующий контрибьютор не увидит ownership-правил. Поэтому при
 * проверке «компонент не используется» комментарии надо
 * игнорировать, чтобы не ловить сами пояснения.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const NEEDS_TAB_PATH =
  'apps/web/components/orders/view/tabs/order-needs-tab.tsx';
const PLANNED_COST_CARD_PATH =
  'apps/web/components/orders/order-planned-cost-summary-card.tsx';
const SUMMARY_TABLE_PATH =
  'apps/web/components/orders/summary/order-summary-unified-table.tsx';

// ---------------------------------------------------------------------------
// 1. Файлы существуют
// ---------------------------------------------------------------------------

describe('Needs duplication regression — файлы по местам', () => {
  test('order-needs-tab.tsx существует', () => {
    expect(exists(NEEDS_TAB_PATH)).toBe(true);
  });

  test('OrderPlannedCostSummaryCard существует (aggregate-only cost-card)', () => {
    expect(exists(PLANNED_COST_CARD_PATH)).toBe(true);
  });

  test('OrderSummaryUnifiedTable существует (cost-screen deep-dive, не Needs)', () => {
    expect(exists(SUMMARY_TABLE_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Needs НЕ импортирует и НЕ рендерит itemized cost breakdown
// ---------------------------------------------------------------------------

describe('OrderNeedsTab — никаких itemized cost-таблиц', () => {
  const rawSrc = read(NEEDS_TAB_PATH);
  const codeSrc = stripComments(rawSrc);

  test('не импортирует и не рендерит OrderSummaryUnifiedTable (текущее имя)', () => {
    // Только живой код — комментарии-предупреждения «do not render…»
    // допустимы и желательны.
    expect(codeSrc).not.toMatch(/<OrderSummaryUnifiedTable\b/);
    expect(codeSrc).not.toMatch(
      /from '@\/components\/orders\/summary\/order-summary-unified-table'/,
    );
    expect(codeSrc).not.toMatch(/\bimport\b[^;]*OrderSummaryUnifiedTable/);
    expect(codeSrc).not.toMatch(/\bOrderSummaryUnifiedTable\b/);
  });

  test('не импортирует возможные ребрендинги cost breakdown', () => {
    // На случай переименования компонента — Needs всё равно не должен
    // тянуть полный itemized cost breakdown.
    expect(codeSrc).not.toMatch(/OrderItemizedCostBreakdownTable/);
    expect(codeSrc).not.toMatch(/OrderCostBreakdownTable/);
    expect(codeSrc).not.toMatch(/OrderItemizedCostTable/);
  });

  test('не импортирует row-builders для itemized rendering', () => {
    // Эти helpers — для построчного cost breakdown. Их использование
    // в Needs приводит к дублированию материалов (`OrderMaterialsUnifiedTable`
    // уже их рендерит). Сами builders могут быть зависимостью
    // aggregate-card, но не должны попадать прямо в Needs.
    expect(codeSrc).not.toMatch(/buildOrderSummaryRows/);
    expect(codeSrc).not.toMatch(/buildOrderMaterialRows/);
    expect(codeSrc).not.toMatch(/buildOrderOperationRows/);
    expect(codeSrc).not.toMatch(/computeOrderSummaryTotals/);
  });

  test('в коде Needs нет маркеров itemized cost table (Раздел / Статья / Доля / …)', () => {
    // Эти подписи живут только в OrderSummaryUnifiedTable и не должны
    // попадать ни в Needs, ни в aggregate-only cost-card. Проверяем
    // именно код (без комментариев), потому что комментарий-владельца
    // упоминает их как пример того, что мы НЕ рендерим.
    expect(codeSrc).not.toMatch(/'Раздел'/);
    expect(codeSrc).not.toMatch(/'Статья'/);
    expect(codeSrc).not.toMatch(/'Сумма за тираж'/);
    expect(codeSrc).not.toMatch(/'За 1 изделие'/);
    expect(codeSrc).not.toMatch(/'Доля'/);
  });

  test('хранит ownership-комментарий «do not render OrderSummaryUnifiedTable»', () => {
    // Архитектурный hint в коде, чтобы следующий контрибьютор не
    // добавил OrderSummaryUnifiedTable обратно в Needs. Это
    // сознательно проверяется на raw-источнике (с комментариями).
    expect(rawSrc).toMatch(/do not render `?OrderSummaryUnifiedTable/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Needs ВСЁ ЕЩЁ показывает канонический материал-блок
// ---------------------------------------------------------------------------

describe('OrderNeedsTab — canonical material table остаётся', () => {
  const src = read(NEEDS_TAB_PATH);

  test('рендерит OrderMaterialsUnifiedTable (canonical source of truth)', () => {
    expect(src).toMatch(/<OrderMaterialsUnifiedTable\b/);
    expect(src).toMatch(
      /from '@\/components\/orders\/materials\/order-materials-unified-table'/,
    );
  });

  test('рендерит ManualMaterialArrivalActions и OrderOutsourceList', () => {
    expect(src).toMatch(/<ManualMaterialArrivalActions\b/);
    expect(src).toMatch(/<OrderOutsourceList\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. Aggregate-only cost-card в Needs (если есть) — действительно
//    aggregate-only.
// ---------------------------------------------------------------------------

describe('OrderPlannedCostSummaryCard — aggregate-only, без itemized rows', () => {
  const src = read(PLANNED_COST_CARD_PATH);
  const needsSrc = read(NEEDS_TAB_PATH);

  test('Needs действительно использует именно эту cost-card', () => {
    expect(needsSrc).toMatch(/<OrderPlannedCostSummaryCard\b/);
    expect(needsSrc).toMatch(
      /from '@\/components\/orders\/order-planned-cost-summary-card'/,
    );
  });

  test('cost-card НЕ использует row-builders (никакого rendering построчно)', () => {
    expect(src).not.toMatch(/buildOrderMaterialRows/);
    expect(src).not.toMatch(/buildOrderOperationRows/);
    expect(src).not.toMatch(/buildOrderSummaryRows/);
  });

  test('cost-card НЕ рендерит названия конкретных материалов/операций', () => {
    // Никаких имён конкретных материалов / операций как row-content.
    // Допустимы только агрегатные подписи: «Материалы», «Фурнитура»,
    // «Нанесение», «Прочее», «Операции», «Итого», «… за 1 изделие».
    expect(src).not.toMatch(/Дюспо/);
    expect(src).not.toMatch(/Таффета/);
    expect(src).not.toMatch(/Синтепон/);
    // И никаких маркеров AdminTable / itemized-cost columns.
    expect(src).not.toMatch(/<AdminTable\b/);
    expect(src).not.toMatch(/AdminTableColumn/);
    expect(src).not.toMatch(/'Раздел'/);
    expect(src).not.toMatch(/'Статья'/);
    expect(src).not.toMatch(/'Доля'/);
    expect(src).not.toMatch(/Сумма за тираж/);
  });

  test('cost-card показывает ровно агрегатные строки', () => {
    expect(src).toMatch(/Материалы за 1 изделие/);
    expect(src).toMatch(/Операции за 1 изделие/);
    expect(src).toMatch(/Итого за 1 изделие/);
  });
});

// ---------------------------------------------------------------------------
// 5. Owner doc в OrderSummaryUnifiedTable явно запрещает Needs.
// ---------------------------------------------------------------------------

describe('OrderSummaryUnifiedTable — owner doc запрещает Needs', () => {
  const src = read(SUMMARY_TABLE_PATH);

  test('JSDoc предупреждает «Do not use this component in the Needs tab»', () => {
    expect(src).toMatch(/Do not use this component in the Needs tab/);
  });

  test('JSDoc упоминает рекомендованное переименование', () => {
    expect(src).toMatch(/OrderItemizedCostBreakdownTable/);
  });
});
