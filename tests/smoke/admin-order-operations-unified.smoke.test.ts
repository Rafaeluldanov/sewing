/**
 * Smoke-тесты для рефакторинга «единый рабочий экран по операциям»
 * — вкладка «Операции» карточки заказа `/admin/orders/[id]`.
 *
 * Source-of-truth:
 *   - Tab wrapper:     `apps/web/components/orders/tabs/order-operations-tab.tsx`
 *   - Unified table:   `apps/web/components/orders/operations/order-operations-unified-table.tsx`
 *   - Row builder:     `apps/web/components/orders/operations/build-order-operation-rows.ts`
 *   - Page wiring:     `apps/web/app/admin/orders/[id]/page.tsx`
 *   - Styles:          `apps/web/app/globals.css`
 *
 * Цели проверок (см. ТЗ §11):
 *   1. Operations tab рендерит unified-таблицу.
 *   2. Operations tab больше не рендерит отдельные большие блоки
 *      (`OrderOperationPlanBlock` / `ProductionBalanceCard` /
 *      stand-alone `AdminRouteSteps`).
 *   3. Таблица содержит 12 колонок (№ / Операция / Статус / План /
 *      Ожидает / В работе / Выполнено / Норма / Цена / Время /
 *      Стоимость / Комментарий) и НЕ содержит колонку «Категория».
 *   4. Статусы Ожидает / В работе / Выполнено вычисляемые из
 *      существующих passports (`Passport.currentRouteStepIndex` /
 *      `Passport.status`); никаких новых enum-статусов в БД.
 *   5. Колонка «Цена» обрабатывает FIXED / BY_SIZE / SALARY_ONLY.
 *   6. Под таблицей есть итоговый блок «Стоимость / Стоимость за 1
 *      изделие / Плановое время / Время на 1 изделие / Узкое место».
 *   7. Backend / Prisma / OperationPlanService / ProductionBalanceService
 *      / payroll / Passport / OperationEntry — НЕ менялись.
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
// 1. Files exist
// ---------------------------------------------------------------------------

describe('Operations tab — компоненты existуют', () => {
  test('файлы новых компонентов на месте', () => {
    expect(
      exists('apps/web/components/orders/tabs/order-operations-tab.tsx'),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/operations/order-operations-unified-table.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/operations/build-order-operation-rows.ts',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Page wiring: вкладка «Операции» использует профильный wrapper
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — вкладка «Операции» возвращена через профильный компонент', () => {
  const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');

  test('страница рендерит вкладку «operations» через OrderOperationsTab', () => {
    // Вкладка «Операции» вернулась после редизайна управленческой
    // карточки, потому что без неё менеджер терял рабочий экран
    // «маршрут / норма / план/факт / план операций / узкое место».
    // Возвращаем профильный компонент `OrderOperationsTab`, а не
    // `OrderSummaryUnifiedTable` (это itemized cost breakdown — он
    // запрещён в Needs и не место ему здесь).
    expect(pageSrc).toMatch(/activeTab === 'operations'/);
    expect(pageSrc).toMatch(/<OrderOperationsTab\b/);
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/tabs\/order-operations-tab'/,
    );
    // Никаких legacy stand-alone карточек операций мы не возвращаем —
    // они уже свёрнуты внутрь `OrderOperationsUnifiedTable`.
    expect(pageSrc).not.toMatch(
      /import\s*\{\s*ProductionBalanceCard\s*\}/,
    );
    expect(pageSrc).not.toMatch(/function\s+OrderOperationPlanBlock\b/);
    // И не дёргаем cost-screen компонент — он живёт за пределами
    // карточки заказа.
    expect(pageSrc).not.toMatch(/<OrderSummaryUnifiedTable\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. OrderOperationsTab wrapper
// ---------------------------------------------------------------------------

describe('OrderOperationsTab — wrapper рендерит ровно одну таблицу', () => {
  const src = read(
    'apps/web/components/orders/tabs/order-operations-tab.tsx',
  );

  test('экспортирует именованный server component', () => {
    expect(src).toMatch(/export\s+function\s+OrderOperationsTab/);
  });

  test('рендерит OrderOperationsUnifiedTable', () => {
    expect(src).toMatch(/<OrderOperationsUnifiedTable\b/);
    expect(src).toMatch(
      /from '@\/components\/orders\/operations\/order-operations-unified-table'/,
    );
  });

  test('не импортирует legacy-карточки операций', () => {
    expect(src).not.toMatch(/import\s*\{[^}]*ProductionBalanceCard[^}]*\}/);
    expect(src).not.toMatch(/import\s*\{[^}]*OrderOperationPlanBlock[^}]*\}/);
    expect(src).not.toMatch(/<ProductionBalanceCard\b/);
    expect(src).not.toMatch(/<OrderOperationPlanBlock\b/);
    expect(src).not.toMatch(/<AdminRouteSteps\b/);
    // Не оборачиваем в AdminCard — wrapper должен быть прозрачным.
    expect(src).not.toMatch(/<AdminCard\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. OrderOperationsUnifiedTable
// ---------------------------------------------------------------------------

describe('OrderOperationsUnifiedTable — единая таблица операций', () => {
  const src = read(
    'apps/web/components/orders/operations/order-operations-unified-table.tsx',
  );

  test('async server component с data-testid=order-operations-unified-table', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+OrderOperationsUnifiedTable/,
    );
    expect(src).toMatch(/data-testid="order-operations-unified-table"/);
  });

  test('использует existing API-обёртки (ничего нового на backend)', () => {
    expect(src).toMatch(/getOperation\b/);
    expect(src).toMatch(/getOrderProductionBalance\b/);
    // Никаких новых endpoint-ов не вводим.
    expect(src).not.toMatch(/operation-plan\/.*\/recalculate/);
  });

  test('использует helper buildOrderOperationRows', () => {
    expect(src).toMatch(/buildOrderOperationRows\b/);
    expect(src).toMatch(/from '\.\/build-order-operation-rows'/);
  });

  test('таблица содержит 12 колонок ТЗ в правильном порядке', () => {
    const expectedHeaders = [
      "header: '№'",
      "header: 'Операция'",
      "header: 'Статус'",
      "header: 'План'",
      "header: 'Ожидает'",
      "header: 'В работе'",
      "header: 'Выполнено'",
      "header: 'Норма'",
      "header: 'Цена'",
      "header: 'Время'",
      "header: 'Стоимость'",
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

  test('таблица НЕ содержит колонку «Категория» (ТЗ §1)', () => {
    expect(src).not.toMatch(/header:\s*'Категория'/);
    expect(src).not.toMatch(/operationCategory:/);
  });

  test('строка таблицы НЕ повторяет название номенклатуры / номер заказа / клиента', () => {
    expect(src).not.toMatch(/order\.customer\b/);
    expect(src).not.toMatch(/order\.client\?/);
    expect(src).not.toMatch(/nomenclatureName/);
  });

  test('отображает все три pricingMode и оба timeNormMode через row data-attribute', () => {
    expect(src).toMatch(/data-pricing-mode/);
    expect(src).toMatch(/data-time-norm-mode/);
  });

  test('summary-блок под таблицей содержит итог и data-testid маркеры', () => {
    expect(src).toMatch(/data-testid="order-operations-summary"/);
    expect(src).toMatch(/data-testid="order-operations-summary-total-cost"/);
    expect(src).toMatch(/data-testid="order-operations-summary-unit-cost"/);
    expect(src).toMatch(/data-testid="order-operations-summary-total-time"/);
    expect(src).toMatch(/data-testid="order-operations-summary-unit-time"/);
    expect(src).toMatch(/data-testid="order-operations-summary-bottleneck"/);
    expect(src).toMatch(/Стоимость операций/);
    expect(src).toMatch(/Стоимость за 1 изделие/);
    expect(src).toMatch(/Плановое время/);
    expect(src).toMatch(/Время на 1 изделие/);
    expect(src).toMatch(/Узкое место/);
  });

  test('summary деградирует к «План операций не рассчитан», если данных нет', () => {
    expect(src).toMatch(/План операций не рассчитан/);
  });

  test('summary рисует stale-warning, если operationPlanIsStale', () => {
    expect(src).toMatch(/operationPlanIsStale/);
    expect(src).toMatch(/data-testid="order-operations-summary-stale"/);
    expect(src).toMatch(/требует пересчёта/i);
  });

  test('summary использует source-of-truth — Order.operationCostPlanRub / TimePlanSec', () => {
    // Если backend snapshot есть — берём его (не дублируем формулу).
    expect(src).toMatch(/operationCostPlanRub/);
    expect(src).toMatch(/operationTimePlanSec/);
  });

  test('summary рисует рекомендацию по сотрудникам, если её отдал production-balance', () => {
    expect(src).toMatch(/recommendedAdditions/);
    expect(src).toMatch(/data-testid="order-operations-summary-recommendation"/);
  });
});

// ---------------------------------------------------------------------------
// 5. buildOrderOperationRows helper
// ---------------------------------------------------------------------------

describe('buildOrderOperationRows — pure web-helper, не трогает backend', () => {
  const src = read(
    'apps/web/components/orders/operations/build-order-operation-rows.ts',
  );

  test('экспортирует тип OrderOperationTableRow со всеми колонками таблицы', () => {
    expect(src).toMatch(/export\s+interface\s+OrderOperationTableRow\s*\{/);
    expect(src).toMatch(/rowNumber:\s*number/);
    expect(src).toMatch(/operationName:\s*string/);
    expect(src).toMatch(/statusLabel:\s*OrderOperationStatusLabel/);
    expect(src).toMatch(/plannedQty:\s*number/);
    expect(src).toMatch(/waitingQty:\s*number/);
    expect(src).toMatch(/inProgressQty:\s*number/);
    expect(src).toMatch(/completedQty:\s*number/);
    expect(src).toMatch(/normLabel:\s*string/);
    expect(src).toMatch(/priceLabel:\s*string/);
    expect(src).toMatch(/totalTimeSec:\s*number \| null/);
    expect(src).toMatch(/lineTotalRub:\s*number \| null/);
    expect(src).toMatch(/warnings:\s*string\[\]/);
  });

  test('экспортирует buildOrderOperationRows и summariseOrderOperationRows', () => {
    expect(src).toMatch(/export\s+function\s+buildOrderOperationRows/);
    expect(src).toMatch(/export\s+function\s+summariseOrderOperationRows/);
  });

  test('лейблы статусов соответствуют ТЗ §3 (Ожидает / В работе / Выполнено)', () => {
    expect(src).toMatch(/'Ожидает'/);
    expect(src).toMatch(/'В работе'/);
    expect(src).toMatch(/'Выполнено'/);
    // Никаких новых enum-статусов в БД мы не вводим — статусы
    // вычисляются на лету.
    expect(src).not.toMatch(/PassportStatusSchema/);
  });

  test('статус считается из passports.currentRouteStepIndex / status', () => {
    expect(src).toMatch(/currentRouteStepIndex/);
    expect(src).toMatch(/'PACKED'/);
    expect(src).toMatch(/qtyCut/);
  });

  test('обрабатывает все три pricingMode (FIXED / BY_SIZE / SALARY_ONLY)', () => {
    expect(src).toMatch(/'FIXED'/);
    expect(src).toMatch(/'BY_SIZE'/);
    expect(src).toMatch(/'SALARY_ONLY'/);
    // Для SALARY_ONLY есть fallback-лейбл «окладная».
    expect(src).toMatch(/'окладная'/);
  });

  test('обрабатывает оба timeNormMode (FIXED / BY_SIZE)', () => {
    expect(src).toMatch(/timeNormMode/);
    expect(src).toMatch(/timeNormSec/);
    expect(src).toMatch(/timeNormsBySize/);
  });

  test('warnings включают «Нет ставки» / «Нет нормы времени» / «Недостаточно данных»', () => {
    expect(src).toMatch(/'Нет ставки'/);
    expect(src).toMatch(/'Нет нормы времени'/);
    expect(src).toMatch(/Недостаточно данных/);
  });

  test('helper НЕ дёргает backend напрямую и не импортирует Prisma / Nest', () => {
    expect(src).not.toMatch(/from '@\/lib\//);
    expect(src).not.toMatch(/from '@prisma\/client'/);
    expect(src).not.toMatch(/@nestjs\//);
  });

  test('helper использует только shared DTO (operations / orders / passports / production-balance)', () => {
    expect(src).toMatch(/from '@sewing\/shared\/operations'/);
    expect(src).toMatch(/from '@sewing\/shared\/orders'/);
    expect(src).toMatch(/from '@sewing\/shared\/passports'/);
    expect(src).toMatch(/from '@sewing\/shared\/order-production-balance'/);
  });
});

// ---------------------------------------------------------------------------
// 6. CSS classes
// ---------------------------------------------------------------------------

describe('globals.css — стили для unified operations table', () => {
  const css = read('apps/web/app/globals.css');

  test('базовые классы таблицы определены', () => {
    expect(css).toMatch(/\.order-operations-table-card\s*\{/);
    expect(css).toMatch(/\.order-operations-table-wrap\b/);
    expect(css).toMatch(/\.order-operations-table\s*\{/);
    expect(css).toMatch(/\.order-operations-table__status\b/);
    expect(css).toMatch(/\.order-operations-table__qty\b/);
    expect(css).toMatch(/\.order-operations-table__money\b/);
    expect(css).toMatch(/\.order-operations-table__duration\b/);
    expect(css).toMatch(/\.order-operations-table__warning\b/);
  });

  test('таблица имеет min-width для горизонтального скролла', () => {
    expect(css).toMatch(
      /\.order-operations-table\s*\{[\s\S]*?min-width:\s*1100px/,
    );
  });

  test('summary-блок имеет свои классы (не AdminCard)', () => {
    expect(css).toMatch(/\.order-operations-summary\s*\{/);
    expect(css).toMatch(/\.order-operations-summary__item\b/);
    expect(css).toMatch(/\.order-operations-summary__warning\b/);
  });
});

// ---------------------------------------------------------------------------
// 7. Backend / Prisma / shared не менялись (UI/layout refactor)
// ---------------------------------------------------------------------------

describe('Operations tab refactor — backend / Prisma НЕ менялись', () => {
  test('Prisma schema без новых таблиц/полей для unified-операций', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/model\s+OrderOperationsUnifiedTable\b/);
    expect(schema).not.toMatch(/model\s+OrderOperationRow\b/);
    // Никаких новых статусов операций в БД не вводим — Ожидает/
    // В работе/Выполнено вычисляемые.
    expect(schema).not.toMatch(/enum\s+OperationRunStatus\b/);
    expect(schema).not.toMatch(/enum\s+OrderOperationStatus\b/);
  });

  test('OrderOperationPlanService формулы не упоминают unified-таблицу', () => {
    const svc = read(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(svc).not.toMatch(/OrderOperationsUnifiedTable/);
    expect(svc).not.toMatch(/buildOrderOperationRows/);
  });

  test('OrderProductionBalanceService не знает про unified-таблицу', () => {
    const svc = read(
      'apps/api/src/modules/orders/order-production-balance.service.ts',
    );
    expect(svc).not.toMatch(/OrderOperationsUnifiedTable/);
    expect(svc).not.toMatch(/buildOrderOperationRows/);
  });

  test('Payroll (earnings/salary) не упоминает unified-таблицу', () => {
    const earn = read('apps/api/src/modules/earnings/earnings.service.ts');
    expect(earn).not.toMatch(/OrderOperationsUnifiedTable/);
    expect(earn).not.toMatch(/buildOrderOperationRows/);
    const sal = read('apps/api/src/modules/salary/salary.service.ts');
    expect(sal).not.toMatch(/OrderOperationsUnifiedTable/);
    expect(sal).not.toMatch(/buildOrderOperationRows/);
  });

  test('Passport / OperationEntry services не упоминают unified-таблицу', () => {
    const p = read('apps/api/src/modules/passports/passports.service.ts');
    expect(p).not.toMatch(/OrderOperationsUnifiedTable/);
    expect(p).not.toMatch(/buildOrderOperationRows/);
    // OperationEntry-сервис не должен знать про новую таблицу.
    const opsCtl = read('apps/api/src/modules/operations/operations.service.ts');
    expect(opsCtl).not.toMatch(/OrderOperationsUnifiedTable/);
  });

  test('helper buildOrderOperationRows живёт строго в apps/web', () => {
    expect(
      exists(
        'apps/web/components/orders/operations/build-order-operation-rows.ts',
      ),
    ).toBe(true);
    expect(
      exists('packages/shared/src/order-operations-unified-table.ts'),
    ).toBe(false);
    expect(
      exists('apps/api/src/modules/order-operations-unified-table'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Existing routes / operation-plan freshness preserved
// ---------------------------------------------------------------------------

describe('Existing actions / API preserved', () => {
  test('operations API клиент не изменился по экспортам', () => {
    const src = read('apps/web/lib/operations-api.ts');
    expect(src).toMatch(/export\s+function\s+listOperations/);
    expect(src).toMatch(/export\s+function\s+getOperation/);
  });

  test('production-balance API клиент не изменился', () => {
    const src = read('apps/web/lib/order-production-balance-api.ts');
    expect(src).toMatch(/export\s+function\s+getOrderProductionBalance/);
  });

  test('RecalculateOperationPlanButton доступен в OrderManagementHeader', () => {
    const headerSrc = read(
      'apps/web/components/orders/view/order-management-header.tsx',
    );
    expect(headerSrc).toMatch(/<RecalculateOperationPlanButton\b/);
  });
});
