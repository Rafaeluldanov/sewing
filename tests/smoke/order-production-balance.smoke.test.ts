/**
 * Smoke-тесты «Производственная цепочка» — балансировка по операциям
 * заказа (см.
 * `apps/api/src/modules/orders/order-production-balance.service.ts`,
 * `apps/api/src/modules/orders/orders.controller.ts::getProductionBalance`,
 * `packages/shared/src/order-production-balance.ts`,
 * `apps/web/components/orders/production-balance-card.tsx`,
 * `apps/web/app/admin/orders/[id]/page.tsx`).
 *
 * Без рендера React и без работы с БД — проверяем, что исходники
 * содержат нужные сущности (additive). Это страхует от регресса
 * «случайно убрали сервис балансировки / эндпоинт / UI-блок» и от
 * скатывания обратно к режиму «выполнить заказ за одну смену» как
 * default.
 *
 * Что фиксируем:
 *   - Shared: `OrderProductionBalanceDto`, `OrderProductionBalanceLineDto`,
 *     `PRODUCTION_BALANCE_STRATEGIES` содержит `LINE_BALANCE`,
 *     default = `LINE_BALANCE`, есть DTO рекомендации.
 *   - Backend: `OrderProductionBalanceService.getForOrder` существует;
 *     читает `Operation.timeNormMode` / `timeNormSec` /
 *     `timeNormsBySize`; содержит mapping `Operation.category →
 *     Employee.role`; читает active employees через
 *     `prisma.employee.groupBy`; считает `capacityPerShift`,
 *     `lineThroughputPerShift`, `idlePercent`,
 *     `recommendedAdditions`; не использует payroll/Passport/
 *     OperationEntry/SalaryEntry; прописан в OrdersModule providers.
 *   - Endpoint: `GET /orders/:id/production-balance` зарегистрирован
 *     в `OrdersController` и принимает `strategy` query.
 *   - Frontend API + UI: `order-production-balance-api.ts` экспортирует
 *     `getOrderProductionBalance` и проксит `strategy`; карточка
 *     заказа содержит `ProductionBalanceCard` с лейблами
 *     «Производственная цепочка», «Балансировка по текущему штату»,
 *     «Выпуск за смену», «Плановых смен», «Узкое место»,
 *     «Доступно сотрудников», «Рекомендуем добавить», «Простой».
 *   - НЕ изменены: payroll (earnings/salary), Passport, OperationEntry,
 *     SalaryEntry, WorkshopNeed, OrderCostEstimate, PurchaseOrder /
 *     PurchaseReceipt, production-cost; LABOR в OrderCostEstimate
 *     по-прежнему НЕ добавлен.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Shared DTO
// ---------------------------------------------------------------------------

describe('Производственная цепочка — Shared DTO', () => {
  test('shared/order-production-balance.ts экспортирует DTO и стратегии', () => {
    const src = readSrc('packages/shared/src/order-production-balance.ts');
    expect(src).toMatch(/export\s+interface\s+OrderProductionBalanceDto/);
    expect(src).toMatch(/export\s+interface\s+OrderProductionBalanceLineDto/);
    expect(src).toMatch(
      /export\s+interface\s+OrderProductionBalanceRecommendationDto/,
    );
    expect(src).toMatch(/PRODUCTION_BALANCE_STRATEGIES/);
    expect(src).toMatch(/'LINE_BALANCE'/);
    expect(src).toMatch(/'TARGET_SHIFT'/);
    expect(src).toMatch(/'TOTAL_WORKERS'/);
    expect(src).toMatch(/'TARGET_DURATION'/);
    expect(src).toMatch(/DEFAULT_PRODUCTION_BALANCE_STRATEGY/);
    expect(src).toMatch(/PRODUCTION_BALANCE_STRATEGY_LABELS/);
    // Поля DTO, на которые опирается UI/тесты.
    expect(src).toMatch(/expectedOutputPerShift/);
    expect(src).toMatch(/orderPlannedDurationSec/);
    expect(src).toMatch(/bottleneckOperationName/);
    expect(src).toMatch(/suggestedWorkers/);
    expect(src).toMatch(/assignedWorkers/);
    expect(src).toMatch(/isBottleneck/);
    expect(src).toMatch(/utilizationPercent/);
    expect(src).toMatch(/throughputPerShift/);
    expect(src).toMatch(/capacityPerShift/);
    expect(src).toMatch(/idlePercent/);
    expect(src).toMatch(/lineThroughputPerShift/);
    expect(src).toMatch(/plannedShifts/);
    expect(src).toMatch(/availableWorkersTotal/);
    expect(src).toMatch(/recommendedAdditions/);
    expect(src).toMatch(/recommendedToAddWorker/);
    expect(src).toMatch(/addOneWorkerGain/);
  });

  test('LINE_BALANCE — default стратегия', () => {
    const src = readSrc('packages/shared/src/order-production-balance.ts');
    expect(src).toMatch(
      /DEFAULT_PRODUCTION_BALANCE_STRATEGY:\s*ProductionBalanceStrategy\s*=\s*\n?\s*'LINE_BALANCE'/,
    );
  });

  test('shared/index.ts реэкспортирует order-production-balance', () => {
    const src = readSrc('packages/shared/src/index.ts');
    expect(src).toMatch(/export \* from ['"]\.\/order-production-balance['"]/);
  });
});

// ---------------------------------------------------------------------------
// 2. Backend: OrderProductionBalanceService
// ---------------------------------------------------------------------------

describe('Производственная цепочка — Backend сервис', () => {
  const src = readSrc(
    'apps/api/src/modules/orders/order-production-balance.service.ts',
  );

  test('Сервис содержит класс и метод getForOrder', () => {
    expect(src).toMatch(/class\s+OrderProductionBalanceService/);
    expect(src).toMatch(/async\s+getForOrder\(\s*orderId:\s*string/);
  });

  test('Сервис читает Operation.timeNormMode / timeNormSec / timeNormsBySize', () => {
    expect(src).toMatch(/timeNormMode/);
    expect(src).toMatch(/timeNormSec/);
    expect(src).toMatch(/timeNormsBySize/);
    expect(src).toMatch(/routeTemplate:/);
    expect(src).toMatch(/steps:/);
  });

  test('Сервис различает FIXED и BY_SIZE для timeNormMode', () => {
    expect(src).toMatch(/op\.timeNormMode\s*===\s*'FIXED'/);
  });

  test('Сервис обрабатывает все стратегии', () => {
    expect(src).toMatch(/'LINE_BALANCE'/);
    expect(src).toMatch(/'TARGET_SHIFT'/);
    expect(src).toMatch(/'TOTAL_WORKERS'/);
    expect(src).toMatch(/'TARGET_DURATION'/);
  });

  test('Сервис содержит mapping Operation.category → Employee.role', () => {
    expect(src).toMatch(/CATEGORY_TO_ROLE/);
    expect(src).toMatch(/CUTTING:\s*'CUTTER'/);
    expect(src).toMatch(/SEWING:\s*'SEAMSTRESS'/);
    expect(src).toMatch(/QC:\s*'QC'/);
    expect(src).toMatch(/IRONING:\s*'IRONING'/);
    expect(src).toMatch(/PACKING:\s*'PACKING'/);
  });

  test('Сервис читает active employees', () => {
    expect(src).toMatch(/prisma\.employee\.groupBy/);
    expect(src).toMatch(/active:\s*true/);
  });

  test('Сервис считает capacityPerShift, lineThroughputPerShift, idlePercent, recommendedAdditions', () => {
    expect(src).toMatch(/capacityPerShift/);
    expect(src).toMatch(/lineThroughputPerShift/);
    expect(src).toMatch(/idlePercent/);
    expect(src).toMatch(/computeRecommendations/);
  });

  test('Сервис не использует payroll-сущности', () => {
    expect(src).not.toMatch(/prisma\.operationEntry\./);
    expect(src).not.toMatch(/prisma\.salaryEntry\./);
    expect(src).not.toMatch(/prisma\.pieceRate\./);
    expect(src).not.toMatch(/prisma\.passport\./);
    expect(src).not.toMatch(/prisma\.workshopNeed\./);
    expect(src).not.toMatch(/prisma\.orderCostEstimate\./);
    expect(src).not.toMatch(/prisma\.purchaseOrder\./);
    expect(src).not.toMatch(/prisma\.purchaseReceipt\./);
    // Никаких side-effect-сервисов payroll/факта.
    expect(src).not.toMatch(/EarningsService/);
    expect(src).not.toMatch(/SalaryService/);
    // Не пишет в БД: разрешены только prisma.order.findUnique и
    // prisma.employee.groupBy для подсчёта штата.
    expect(src).not.toMatch(/prisma\.order\.update/);
    expect(src).not.toMatch(/prisma\.order\.create/);
    expect(src).not.toMatch(/prisma\.order\.delete/);
    expect(src).not.toMatch(/prisma\.employee\.update/);
    expect(src).not.toMatch(/prisma\.employee\.create/);
    expect(src).not.toMatch(/prisma\.employee\.delete/);
    expect(src).not.toMatch(/prisma\.\$transaction/);
  });

  test('Сервис содержит warning о параллельной оценке', () => {
    expect(src).toMatch(/Расчёт является плановой оценкой/);
  });

  test('Сервис скипает isOptional = true', () => {
    expect(src).toMatch(/isOptional\s*===\s*true/);
  });

  test('OrdersModule подключает OrderProductionBalanceService', () => {
    const m = readSrc('apps/api/src/modules/orders/orders.module.ts');
    expect(m).toMatch(/OrderProductionBalanceService/);
    expect(m).toMatch(
      /providers:\s*\[[\s\S]*OrderProductionBalanceService[\s\S]*\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Endpoint
// ---------------------------------------------------------------------------

describe('Производственная цепочка — endpoint /orders/:id/production-balance', () => {
  const src = readSrc('apps/api/src/modules/orders/orders.controller.ts');

  test('Контроллер регистрирует GET :id/production-balance', () => {
    expect(src).toMatch(/@Get\(['"]:id\/production-balance['"]\)/);
    expect(src).toMatch(/getProductionBalance\(/);
  });

  test('Контроллер использует OrderProductionBalanceService', () => {
    expect(src).toMatch(/OrderProductionBalanceService/);
    expect(src).toMatch(/productionBalance:\s*OrderProductionBalanceService/);
    expect(src).toMatch(/this\.productionBalance\.getForOrder/);
  });

  test('Контроллер принимает strategy query', () => {
    expect(src).toMatch(/@Query\(['"]strategy['"]\)/);
    expect(src).toMatch(/parseStrategy/);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend API + UI
// ---------------------------------------------------------------------------

describe('Производственная цепочка — Frontend API + UI', () => {
  test('lib/order-production-balance-api.ts экспортирует getOrderProductionBalance и проксит strategy', () => {
    const src = readSrc('apps/web/lib/order-production-balance-api.ts');
    expect(src).toMatch(/export\s+function\s+getOrderProductionBalance/);
    expect(src).toMatch(/production-balance/);
    expect(src).toMatch(/strategy:\s*query\.strategy/);
  });

  test('Карточка ProductionBalanceCard содержит ключевые лейблы', () => {
    const src = readSrc(
      'apps/web/components/orders/production-balance-card.tsx',
    );
    expect(src).toMatch(/ProductionBalanceCard/);
    expect(src).toMatch(/Производственная цепочка/);
    expect(src).toMatch(/Балансировка по текущему штату/);
    expect(src).toMatch(/Выпуск за смену/);
    expect(src).toMatch(/Плановых смен/);
    expect(src).toMatch(/Узкое место/);
    expect(src).toMatch(/Доступно сотрудников/);
    expect(src).toMatch(/Рекомендуем добавить/);
    expect(src).toMatch(/Простой/);
    expect(src).toMatch(/Загрузка/);
    expect(src).toMatch(/Текущая расстановка/);
    expect(src).toMatch(/data-testid="order-production-balance-summary"/);
    expect(src).toMatch(/data-testid="order-production-balance-staffing"/);
    expect(src).toMatch(
      /data-testid="order-production-balance-recommendation"/,
    );
  });

  test('Unified-таблица операций потребляет данные production-balance API', () => {
    // ТЗ «Переделать вкладку Операции» (apr 29, 2026): отдельной
    // карточки `ProductionBalanceCard` во вкладке «Операции»
    // больше нет — узкое место и рекомендация по сотрудникам
    // встроены в summary-блок под единой таблицей операций.
    // Сам сервис `OrderProductionBalanceService` НЕ менялся — мы
    // переиспользуем тот же endpoint `/api/orders/:id/production-balance`
    // через web-обёртку `getOrderProductionBalance`.
    const src = readSrc(
      'apps/web/components/orders/operations/order-operations-unified-table.tsx',
    );
    expect(src).toMatch(/getOrderProductionBalance/);
    expect(src).toMatch(/bottleneckOperationName/);
    expect(src).toMatch(/recommendedAdditions/);
  });

  test('globals.css содержит стили блока «Производственная цепочка»', () => {
    const src = readSrc('apps/web/app/globals.css');
    expect(src).toMatch(/\.admin-order-production-balance__summary\s*\{/);
    expect(src).toMatch(/\.admin-order-production-balance__staffing\s*\{/);
    expect(src).toMatch(/\.admin-order-production-balance__warnings\s*\{/);
    expect(src).toMatch(
      /\.admin-order-production-balance__recommendation\s*\{/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Что НЕ должно меняться
// ---------------------------------------------------------------------------

describe('Производственная цепочка — НЕ трогаем payroll/Passport/WorkshopNeed/OrderCostEstimate', () => {
  test('Earnings (сдельный payroll) не упоминает балансировку', () => {
    const src = readSrc('apps/api/src/modules/earnings/earnings.service.ts');
    expect(src).not.toMatch(/OrderProductionBalance/);
    expect(src).not.toMatch(/productionBalance/);
  });

  test('Salary (окладной payroll) не упоминает балансировку', () => {
    const src = readSrc('apps/api/src/modules/salary/salary.service.ts');
    expect(src).not.toMatch(/OrderProductionBalance/);
    expect(src).not.toMatch(/productionBalance/);
  });

  test('Passport не упоминает балансировку', () => {
    const src = readSrc(
      'apps/api/src/modules/passports/passports.service.ts',
    );
    expect(src).not.toMatch(/OrderProductionBalance/);
    expect(src).not.toMatch(/productionBalance/);
  });

  test('Production-cost не упоминает балансировку', () => {
    const src = readSrc('apps/api/src/modules/costs/costs.service.ts');
    expect(src).not.toMatch(/OrderProductionBalance/);
    expect(src).not.toMatch(/productionBalance/);
  });

  test('WorkshopNeedsService не упоминает балансировку', () => {
    const src = readSrc(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    expect(src).not.toMatch(/OrderProductionBalance/);
    expect(src).not.toMatch(/productionBalance/);
  });

  test('OrderCostEstimatesService не добавляет LABOR (этап ещё не реализован)', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    );
    expect(src).not.toMatch(/'LABOR'/);
    expect(src).not.toMatch(/OrderProductionBalance/);
  });

  test('PurchaseOrders / PurchaseReceipts не упоминают балансировку', () => {
    const po = readSrc(
      'apps/api/src/modules/purchase-orders/purchase-orders.service.ts',
    );
    expect(po).not.toMatch(/OrderProductionBalance/);
    const pr = readSrc(
      'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts',
    );
    expect(pr).not.toMatch(/OrderProductionBalance/);
  });

  test('LABOR ещё не добавлен в shared `ORDER_COST_ESTIMATE_LINE_KINDS`', () => {
    const src = readSrc('packages/shared/src/order-cost-estimates.ts');
    expect(src).not.toMatch(/'LABOR'/);
  });
});
