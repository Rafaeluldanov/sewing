/**
 * Smoke-тесты для Этапа 2 «План операций на заказе»
 * (см. `docs/operation-time-norms-recon.md §10/§11`).
 *
 * Без рендера React и без работы с БД — проверяем, что исходники
 * содержат нужные сущности (additive). Это страхует от регресса
 * «случайно убрали snapshot-поля плана / сервис расчёта /
 * UI-блок».
 *
 * Что фиксируем:
 *   - Prisma: Order.operationCostPlanRub / TimePlanSec / CalculatedAt /
 *     PlanWarnings + миграция additive.
 *   - Shared: OrderListItemDto/OrderDetailDto содержат план-поля.
 *   - Backend: OrderOperationPlanService существует с calculateForOrder
 *     и recalculateAndWrite; OrdersService вызывает его в create /
 *     update / startCalculation; OrdersModule подключает provider.
 *   - DTO mapper: toListItemDto/toDetailDto отдают план-поля.
 *   - Frontend: карточка заказа `/admin/orders/[id]` содержит блок
 *     «План операций» с «Стоимость операций» и «Плановое время»;
 *     `formatDurationSec` присутствует в `lib/operations-time-norm.ts`.
 *   - НЕ изменены: payroll (earnings/salary), Passport, OperationEntry,
 *     SalaryEntry, WorkshopNeed, OrderCostEstimate completion, PurchaseOrder /
 *     PurchaseReceipt, OrderApplication, PatternItem, TechCard,
 *     production-cost; LABOR в OrderCostEstimate ещё не добавлен.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Prisma + миграция
// ---------------------------------------------------------------------------

describe('Этап 2 — Prisma: snapshot-поля плана операций на Order', () => {
  test('Prisma-схема содержит четыре snapshot-поля на Order', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/operationCostPlanRub\s+Decimal\?\s+@db\.Decimal\(14,\s*2\)/);
    expect(src).toMatch(/operationTimePlanSec\s+Int\?/);
    expect(src).toMatch(/operationPlanCalculatedAt\s+DateTime\?/);
    expect(src).toMatch(/operationPlanWarnings\s+Json\?/);
  });

  test('Миграция 20260523100000_add_order_operation_plan_snapshot существует и additive', () => {
    const src = readSrc(
      'prisma/migrations/20260523100000_add_order_operation_plan_snapshot/migration.sql',
    );
    expect(src).toMatch(/ALTER TABLE "Order"/);
    expect(src).toMatch(/ADD COLUMN "operationCostPlanRub"\s+DECIMAL\(14,\s*2\)/);
    expect(src).toMatch(/ADD COLUMN "operationTimePlanSec"\s+INTEGER/);
    expect(src).toMatch(/ADD COLUMN "operationPlanCalculatedAt"\s+TIMESTAMP\(3\)/);
    expect(src).toMatch(/ADD COLUMN "operationPlanWarnings"\s+JSONB/);
    expect(src).not.toMatch(/DROP TABLE/);
    expect(src).not.toMatch(/DROP COLUMN/);
    // Никаких изменений на критичных payroll/факт-таблицах.
    expect(src).not.toMatch(/ALTER TABLE "OperationEntry"/);
    expect(src).not.toMatch(/ALTER TABLE "SalaryEntry"/);
    expect(src).not.toMatch(/ALTER TABLE "Passport"/);
    expect(src).not.toMatch(/ALTER TABLE "OperationRateBySize"/);
    expect(src).not.toMatch(/ALTER TABLE "OperationTimeNormBySize"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared DTO
// ---------------------------------------------------------------------------

describe('Этап 2 — Shared: OrderListItemDto / OrderDetailDto', () => {
  test('OrderListItemDto содержит план-поля (опционально + nullable)', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    // Поля сидят на OrderListItemDto, чтобы и список, и detail
    // могли отображать сводку (`OrderDetailDto extends ...`).
    const list = src.split('OrderListItemDto')[1] ?? '';
    expect(list).toMatch(/operationCostPlanRub\?:\s*string\s*\|\s*number\s*\|\s*null/);
    expect(list).toMatch(/operationTimePlanSec\?:\s*number\s*\|\s*null/);
    expect(list).toMatch(/operationPlanCalculatedAt\?:\s*string\s*\|\s*null/);
    expect(list).toMatch(/operationPlanWarnings\?:\s*string\[\]\s*\|\s*null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Backend: OrderOperationPlanService
// ---------------------------------------------------------------------------

describe('Этап 2 — Backend: OrderOperationPlanService существует', () => {
  test('Сервис содержит calculateForOrder и recalculateAndWrite', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(src).toMatch(/class\s+OrderOperationPlanService/);
    expect(src).toMatch(
      /async\s+calculateForOrder\(\s*orderId:\s*string,\s*tx:\s*Prisma\.TransactionClient/,
    );
    expect(src).toMatch(
      /async\s+recalculateAndWrite\(\s*orderId:\s*string,\s*tx:\s*Prisma\.TransactionClient/,
    );
  });

  test('Сервис читает routeTemplate.steps + items + operation.timeNormsBySize / ratesBySize', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(src).toMatch(/routeTemplate:/);
    expect(src).toMatch(/steps:/);
    expect(src).toMatch(/ratesBySize:/);
    expect(src).toMatch(/timeNormsBySize:/);
    expect(src).toMatch(/timeNormMode/);
    expect(src).toMatch(/pricingMode/);
  });

  test('Сервис обрабатывает все три pricingMode (FIXED / BY_SIZE / SALARY_ONLY)', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(src).toMatch(/'SALARY_ONLY'/);
    expect(src).toMatch(/'FIXED'/);
    expect(src).toMatch(/'BY_SIZE'/);
  });

  test('Сервис обрабатывает оба timeNormMode (FIXED / BY_SIZE)', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    // Уже проверены строковые литералы выше; здесь подтверждаем, что
    // `timeNormMode` сравнивается явно.
    expect(src).toMatch(/op\.timeNormMode\s*===\s*'FIXED'/);
  });

  test('Сервис не блокирует заказ — отсутствие ставки/нормы превращается в warning', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(src).toMatch(/Маршрут не выбран/);
    expect(src).toMatch(/Не заполнен план по размерам/);
    expect(src).toMatch(/Нет ставки операции/);
    expect(src).toMatch(/Нет нормы времени операции/);
    // На «нет данных» возвращаем null totals + warnings, не throw.
    expect(src).not.toMatch(/throw new Error/);
  });

  test('Сервис подключён в OrdersModule', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.module.ts');
    expect(src).toMatch(/OrderOperationPlanService/);
    expect(src).toMatch(/providers:\s*\[[\s\S]*OrderOperationPlanService[\s\S]*\]/);
  });
});

// ---------------------------------------------------------------------------
// 4. OrdersService: вызовы recalculateAndWrite
// ---------------------------------------------------------------------------

describe('Этап 2 — OrdersService: вызовы recalculateAndWrite', () => {
  const src = readSrc('apps/api/src/modules/orders/orders.service.ts');

  test('OrdersService импортирует OrderOperationPlanService и инжектирует его', () => {
    expect(src).toMatch(
      /import\s+\{\s*OrderOperationPlanService\s*\}\s+from\s+['"]\.\/order-operation-plan\.service\.js['"]/,
    );
    expect(src).toMatch(/orderOperationPlan:\s*OrderOperationPlanService/);
  });

  test('OrdersService.create вызывает recalculateAndWrite внутри транзакции', () => {
    // Уникальный маркер для create — `created.id` (после `tx.order.create`).
    expect(src).toMatch(
      /this\.orderOperationPlan\.recalculateAndWrite\(\s*created\.id\s*,\s*tx\s*\)/,
    );
  });

  test('OrdersService.update вызывает recalculateAndWrite в DRAFT при изменении состава/маршрута/лекала', () => {
    // Уникальный маркер для update — guard `isDraft && (wantsItemsChange || ...)`.
    expect(src).toMatch(
      /if\s*\(\s*isDraft\s*&&[\s\S]*?wantsItemsChange\s*\|\|\s*wantsRouteChange[\s\S]*?\)\s*\)\s*\{[\s\S]*?orderOperationPlan\.recalculateAndWrite\(\s*id\s*,\s*tx\s*\)/,
    );
  });

  test('OrdersService.startCalculation вызывает recalculateAndWrite перед сменой статуса', () => {
    // Привязываемся к маркеру «`status: OrderStatus.CALCULATION`», который
    // живёт только в `startCalculation` — так не путаемся со
    // smoke-обнаружением.
    expect(src).toMatch(
      /orderOperationPlan\.recalculateAndWrite\(\s*id\s*,\s*tx\s*\)[\s\S]*?status:\s*OrderStatus\.CALCULATION,/,
    );
  });

  test('OrdersService.start НЕ вызывает recalculateAndWrite (план зафиксирован)', () => {
    // start() — это переход DRAFT/CALCULATION/CALCULATION_DONE → IN_PRODUCTION;
    // план уже был посчитан в startCalculation/create/update.
    // Проверяем, что в теле start() нет вызова recalculateAndWrite.
    const startMatch = src.match(
      /async start\([^)]*\):\s*Promise<OrderDetailDto>\s*\{([\s\S]*?)\n\s{2}async /,
    );
    expect(startMatch).not.toBeNull();
    expect(startMatch?.[1] ?? '').not.toMatch(/recalculateAndWrite/);
  });
});

// ---------------------------------------------------------------------------
// 4b. OrdersService: вызовы syncOrderRouteStepsSnapshot
// ---------------------------------------------------------------------------

describe('Этап «План операций до запуска»: snapshot OrderRouteStep[] синхронизируется', () => {
  // Этап «План операций до запуска» (см. ТЗ «Подтягивать операции при
  // выборе маршрута»): snapshot шагов маршрута больше не привязан к
  // `start()`. Helper `syncOrderRouteStepsSnapshot` вызывается из
  // `create` / `update` (DRAFT) / `recalculateOperationPlan` /
  // `startCalculation`, чтобы вкладки «Операции» и «Сводно по заказу»
  // показывали операции уже в DRAFT/CALCULATION.
  const src = readSrc('apps/api/src/modules/orders/orders.service.ts');

  test('OrdersService содержит приватный helper syncOrderRouteStepsSnapshot', () => {
    expect(src).toMatch(
      /private\s+async\s+syncOrderRouteStepsSnapshot\(\s*orderId:\s*string,\s*tx:\s*Prisma\.TransactionClient/,
    );
    // Helper использует RoutesService.getActiveStepsForSnapshot —
    // не дублирует логику чтения шагов шаблона.
    expect(src).toMatch(/this\.routes\.getActiveStepsForSnapshot/);
  });

  test('create зовёт syncOrderRouteStepsSnapshot вместе с recalculateAndWrite', () => {
    // Уникальный маркер для create — `created.id`.
    expect(src).toMatch(
      /this\.syncOrderRouteStepsSnapshot\(\s*created\.id\s*,\s*tx\s*\)/,
    );
  });

  test('update в DRAFT зовёт syncOrderRouteStepsSnapshot в той же ветке, что recalculateAndWrite', () => {
    // Должен быть в одном if-блоке `isDraft && (wantsItemsChange ||
    // wantsRouteChange || wantsPatternChange)`.
    expect(src).toMatch(
      /isDraft\s*&&[\s\S]*?wantsItemsChange[\s\S]*?wantsRouteChange[\s\S]*?\)\s*\)\s*\{[\s\S]*?orderOperationPlan\.recalculateAndWrite[\s\S]*?syncOrderRouteStepsSnapshot/,
    );
  });

  test('recalculateOperationPlan зовёт syncOrderRouteStepsSnapshot', () => {
    const block = src.match(
      /async\s+recalculateOperationPlan\([\s\S]*?\n\s{2}\}/,
    );
    expect(block).not.toBeNull();
    expect(block?.[0] ?? '').toMatch(/syncOrderRouteStepsSnapshot/);
  });

  test('startCalculation зовёт syncOrderRouteStepsSnapshot', () => {
    // Между маркером recalculateAndWrite и status: CALCULATION должен
    // быть syncOrderRouteStepsSnapshot — та же tx, тот же id.
    expect(src).toMatch(
      /orderOperationPlan\.recalculateAndWrite\(\s*id\s*,\s*tx\s*\)[\s\S]*?syncOrderRouteStepsSnapshot\(\s*id\s*,\s*tx\s*\)[\s\S]*?status:\s*OrderStatus\.CALCULATION,/,
    );
  });

  test('start() НЕ зовёт syncOrderRouteStepsSnapshot (план immutable после запуска)', () => {
    const startMatch = src.match(
      /async start\([^)]*\):\s*Promise<OrderDetailDto>\s*\{([\s\S]*?)\n\s{2}async /,
    );
    expect(startMatch).not.toBeNull();
    // Тело метода может содержать комментарий `см. syncOrderRouteStepsSnapshot`
    // (документация ссылается на helper, чтобы будущему читателю было
    // понятно, что snapshot уже зафиксирован раньше). Поэтому проверяем
    // именно вызов `this.syncOrderRouteStepsSnapshot(`, а не любую
    // подстроку с именем.
    expect(startMatch?.[1] ?? '').not.toMatch(
      /this\.syncOrderRouteStepsSnapshot\(/,
    );
  });

  test('update больше не бросает ORDER_ROUTE_ALREADY_STARTED при правке маршрута в DRAFT', () => {
    // Snapshot теперь живёт в DRAFT, поэтому старый guard
    // `snapshotCount > 0 → throw OrderRouteAlreadyStartedException`
    // ложно-срабатывал бы. Проверяем, что он удалён из update().
    expect(src).not.toMatch(/throw new OrderRouteAlreadyStartedException/);
    // Защита от смены маршрута на запущенном заказе осталась за
    // upper-level ORDER_LOCKED guard (`wantsUnsafeChange && !isDraft`).
    expect(src).toMatch(/wantsUnsafeChange\s*&&\s*!isDraft/);
    expect(src).toMatch(/OrderLockedException/);
  });

  test('syncOrderRouteStepsSnapshot не оборачивает route-service / БД-вызовы в try/catch', () => {
    // Edge-case-проверка после переноса OrderRouteStep[] snapshot в
    // DRAFT: «допустимо silently no-op только когда routeTemplateId
    // отсутствует; ошибки БД / route service должны пробрасываться».
    // Контракт фиксируется на source-уровне: внутри тела helper-а
    // нет ни одного `try {`. Ловить технические ошибки тут нечем —
    // tx-обёртка в `create` / `update` / `recalculateOperationPlan` /
    // `startCalculation` корректно откатит транзакцию.
    const m = src.match(
      /private\s+async\s+syncOrderRouteStepsSnapshot\([\s\S]*?\n\s{2}\}/,
    );
    expect(m).not.toBeNull();
    const body = m?.[0] ?? '';
    expect(body).not.toMatch(/\btry\s*\{/);
    expect(body).not.toMatch(/\bcatch\s*\(/);
    // Helper всё ещё ходит в БД и в RoutesService — ровно эти
    // вызовы и обязаны пробрасывать ошибки.
    expect(body).toMatch(/tx\.order\.findUnique/);
    expect(body).toMatch(/tx\.orderRouteStep\.findMany/);
    expect(body).toMatch(/tx\.orderRouteStep\.deleteMany/);
    expect(body).toMatch(/this\.routes\.getActiveStepsForSnapshot/);
  });

  test('syncOrderRouteStepsSnapshot silently no-op только при отсутствии шаблона', () => {
    // Этап «edge cases»: документируем единственный допустимый
    // silent-выход — `!order.routeTemplateId` в сочетании с пустым
    // current snapshot-ом возвращает `{steps: 0, replaced: false}`.
    // Никаких других ранних `return`-ов после успешных DB-чтений
    // не должно быть.
    const m = src.match(
      /private\s+async\s+syncOrderRouteStepsSnapshot\([\s\S]*?\n\s{2}\}/,
    );
    expect(m).not.toBeNull();
    const body = m?.[0] ?? '';
    expect(body).toMatch(/if\s*\(!order\.routeTemplateId\)/);
    // Ровно один штатный no-op после сравнения СТРУКТУРЫ маршрута с
    // текущим snapshot-ом (это идемпотентность, не «глушение ошибок»).
    // Сравнение теперь только по структуре (`structureEqual`): per-order
    // оверрайды расценок/норм заказа не зависят от расценок шаблона и
    // сохраняются при ре-синке (фича «редактирование операции в заказе»).
    expect(body).toMatch(/if\s*\(structureEqual\)/);
  });
});

// ---------------------------------------------------------------------------
// 4c. RoutesService.update — touch RouteTemplate.updatedAt при правке шагов.
//     Edge-case: PATCH /api/routes/:id { steps } обязан touch-нуть
//     `RouteTemplate.updatedAt`, иначе зависимые заказы не пометятся
//     stale (см. `OrderOperationPlanService.getFreshnessForOrder`).
// ---------------------------------------------------------------------------

describe('Этап «edge cases» — RoutesService.update touch updatedAt', () => {
  const src = readSrc('apps/api/src/modules/routes/routes.service.ts');

  test('Update touch-ит updatedAt даже когда передан только `steps`', () => {
    // Без этого touch-а `getFreshnessForOrder` не увидит изменения
    // (он смотрит на `RouteTemplate.updatedAt`, а
    // `RouteTemplateStep.updatedAt` в схеме отсутствует).
    expect(src).toMatch(
      /dto\.steps\s*!==\s*undefined\s*&&\s*Object\.keys\(data\)\.length\s*===\s*0[\s\S]{0,80}data\.updatedAt\s*=\s*new Date\(\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. DTO mapper в OrdersService
// ---------------------------------------------------------------------------

describe('Этап 2 — DTO mapper отдаёт snapshot-поля плана', () => {
  const src = readSrc('apps/api/src/modules/orders/orders.service.ts');

  test('toListItemDto и toDetailDto отдают operationCostPlanRub / operationTimePlanSec / …', () => {
    expect(src).toMatch(/operationCostPlanRub:\s*o\.operationCostPlanRub/);
    expect(src).toMatch(/operationTimePlanSec:\s*o\.operationTimePlanSec\s*\?\?\s*null/);
    expect(src).toMatch(/operationPlanCalculatedAt:\s*o\.operationPlanCalculatedAt/);
    expect(src).toMatch(/operationCostPlanRub:\s*order\.operationCostPlanRub/);
    expect(src).toMatch(/operationTimePlanSec:\s*order\.operationTimePlanSec\s*\?\?\s*null/);
  });

  test('Маппер нормализует operationPlanWarnings в string[] | null (без падений на не-массивах)', () => {
    expect(src).toMatch(/normalizeOperationPlanWarnings/);
    expect(src).toMatch(/Array\.isArray\(raw\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. Frontend: блок «План операций» на карточке заказа
// ---------------------------------------------------------------------------

describe('Этап 2 — Frontend: блок «План операций» на /admin/orders/[id]', () => {
  // ТЗ «Переделать вкладку Операции» (apr 29, 2026): блок «План
  // операций» больше не отдельная карточка в page.tsx — он
  // встроен в unified-таблицу `OrderOperationsUnifiedTable`
  // (вкладка «Операции») и в её summary-блок снизу. Поэтому
  // лейблы и data-testid-ы теперь живут в новом компоненте.
  test('OrderOperationsUnifiedTable содержит лейблы плана операций', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/order-operations-unified-table.tsx',
    );
    expect(src).toMatch(/Стоимость операций/);
    expect(src).toMatch(/Плановое время/);
    expect(src).toMatch(/План операций не рассчитан/);
    expect(src).toMatch(/План операций неполный/);
  });

  test('OrderOperationsUnifiedTable использует formatDurationSec из lib/operations-time-norm.ts', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/order-operations-unified-table.tsx',
    );
    expect(src).toMatch(/formatDurationSec/);
    expect(src).toMatch(/from\s+['"]@\/lib\/operations-time-norm['"]/);
  });

  test('lib/operations-time-norm.ts содержит formatDurationSec (часы / минуты / секунды)', () => {
    const src = readSrc('apps/web/lib/operations-time-norm.ts');
    expect(src).toMatch(/export function formatDurationSec/);
    // formatDuration теперь поддерживает «1 ч»/«1 ч 16 мин 40 сек».
    expect(src).toMatch(/`\$\{hours\} ч`/);
  });

  test('globals.css сохраняет стили исторического блока «План операций»', () => {
    // Эти CSS-классы оставлены для backward-compat (например,
    // legacy `/orders/*` карточка может их использовать). Новая
    // unified-таблица операций имеет свои классы
    // `.order-operations-table-card` / `.order-operations-summary`,
    // которые покрывает отдельный smoke-test.
    const src = readSrc('apps/web/app/globals.css');
    expect(src).toMatch(/\.admin-order-operation-plan\s*\{/);
    expect(src).toMatch(/\.admin-order-operation-plan__warnings\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// 7. Что НЕ должно меняться (см. recon §15)
// ---------------------------------------------------------------------------

describe('Этап 2 — НЕ трогаем payroll / Passport / WorkshopNeed / production-cost / LABOR', () => {
  test('Payroll-сдельный (earnings.service.ts) не упоминает operationPlan', () => {
    const src = readSrc('apps/api/src/modules/earnings/earnings.service.ts');
    expect(src).not.toMatch(/operationCostPlan/);
    expect(src).not.toMatch(/operationTimePlan/);
    expect(src).not.toMatch(/operationPlanWarnings/);
    expect(src).not.toMatch(/OrderOperationPlanService/);
    expect(src).not.toMatch(/recalculateAndWrite/);
  });

  test('Payroll-окладный (salary.service.ts) не упоминает operationPlan', () => {
    const src = readSrc('apps/api/src/modules/salary/salary.service.ts');
    expect(src).not.toMatch(/operationCostPlan/);
    expect(src).not.toMatch(/operationTimePlan/);
    expect(src).not.toMatch(/operationPlanWarnings/);
    expect(src).not.toMatch(/OrderOperationPlanService/);
  });

  test('Passport (passports.service.ts) не упоминает operationPlan', () => {
    const src = readSrc(
      'apps/api/src/modules/passports/passports.service.ts',
    );
    expect(src).not.toMatch(/operationCostPlan/);
    expect(src).not.toMatch(/operationTimePlan/);
    expect(src).not.toMatch(/operationPlanWarnings/);
    expect(src).not.toMatch(/OrderOperationPlanService/);
  });

  test('Production-cost (costs.service.ts) не упоминает operationPlan', () => {
    const src = readSrc('apps/api/src/modules/costs/costs.service.ts');
    expect(src).not.toMatch(/operationCostPlan/);
    expect(src).not.toMatch(/operationTimePlan/);
    expect(src).not.toMatch(/OrderOperationPlanService/);
  });

  test('WorkshopNeedsService не изменён (calculateForOrder без плана операций)', () => {
    const src = readSrc(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    expect(src).not.toMatch(/operationCostPlan/);
    expect(src).not.toMatch(/operationTimePlan/);
    expect(src).not.toMatch(/operationPlanWarnings/);
    expect(src).not.toMatch(/OrderOperationPlanService/);
  });

  test('OrderCostEstimatesService не добавляет LABOR на этом этапе', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    );
    expect(src).not.toMatch(/'LABOR'/);
    expect(src).not.toMatch(/operationCostPlan/);
    expect(src).not.toMatch(/ORDER_OPERATION_PLAN/);
  });

  test('PurchaseOrders / PurchaseReceipts не упоминают operationPlan', () => {
    const po = readSrc(
      'apps/api/src/modules/purchase-orders/purchase-orders.service.ts',
    );
    expect(po).not.toMatch(/operationCostPlan/);
    expect(po).not.toMatch(/operationTimePlan/);
    const pr = readSrc(
      'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts',
    );
    expect(pr).not.toMatch(/operationCostPlan/);
    expect(pr).not.toMatch(/operationTimePlan/);
  });

  test('Order-applications / TechCards / Patterns не упоминают operationPlan', () => {
    const oa = readSrc(
      'apps/api/src/modules/order-applications/order-applications.service.ts',
    );
    expect(oa).not.toMatch(/operationCostPlan/);
    const tc = readSrc('apps/api/src/modules/tech-cards/tech-cards.service.ts');
    expect(tc).not.toMatch(/operationCostPlan/);
    const p = readSrc('apps/api/src/modules/patterns/patterns.service.ts');
    expect(p).not.toMatch(/operationCostPlan/);
  });

  test('LABOR ещё не добавлен в shared `ORDER_COST_ESTIMATE_LINE_KINDS`', () => {
    const src = readSrc('packages/shared/src/order-cost-estimates.ts');
    expect(src).not.toMatch(/'LABOR'/);
  });
});

// ---------------------------------------------------------------------------
// 8. Доработка: ручной пересчёт + stale-detection + «За 1 изделие»
//    (см. ТЗ «Доработать план операций в заказе»).
// ---------------------------------------------------------------------------

describe('Этап 2 — Backend: ручной пересчёт плана операций', () => {
  test('OrdersController имеет endpoint POST /:id/operation-plan/recalculate', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(
      /@Post\(['"]:id\/operation-plan\/recalculate['"]\)/,
    );
    expect(src).toMatch(/recalculateOperationPlan\(/);
  });

  test('OrdersService имеет метод recalculateOperationPlan', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(
      /async\s+recalculateOperationPlan\(\s*id:\s*string/,
    );
  });

  test('recalculateOperationPlan разрешён только для DRAFT/CALCULATION', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    // Внутри recalculateOperationPlan присутствуют оба guard'а
    // (DRAFT/CALCULATION разрешены, CALCULATION_DONE — особый адрес).
    const block = src.match(
      /async\s+recalculateOperationPlan\([\s\S]*?\n\s{2}\}/,
    );
    expect(block).not.toBeNull();
    const body = block?.[0] ?? '';
    expect(body).toMatch(/OrderStatus\.CALCULATION_DONE/);
    expect(body).toMatch(/OrderStatus\.DRAFT/);
    expect(body).toMatch(/OrderStatus\.CALCULATION/);
    expect(body).toMatch(
      /OrderOperationPlanRecalculateNotAllowedException/,
    );
    expect(body).toMatch(/верните заказ на просчёт/);
    // Аудит ORDER_OPERATION_PLAN_RECALCULATED.
    expect(body).toMatch(/ORDER_OPERATION_PLAN_RECALCULATED/);
  });

  test('Exception ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED определён в errors.ts', () => {
    const src = readSrc('apps/api/src/common/errors.ts');
    expect(src).toMatch(
      /class\s+OrderOperationPlanRecalculateNotAllowedException/,
    );
    expect(src).toMatch(/ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED/);
    expect(src).toMatch(/HttpStatus\.CONFLICT/);
  });
});

describe('Этап 2 — Backend: stale-detection (getFreshnessForOrder)', () => {
  test('OrderOperationPlanService содержит getFreshnessForOrder', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(src).toMatch(
      /async\s+getFreshnessForOrder\(\s*orderId:\s*string/,
    );
    // Тело учитывает все источники плана:
    expect(src).toMatch(/operationRateBySize\.aggregate/);
    expect(src).toMatch(/operationTimeNormBySize\.aggregate/);
    expect(src).toMatch(/operation\.aggregate/);
    expect(src).toMatch(/routeTemplate\.updatedAt/);
  });

  test('OrdersService.toDetailDto зовёт getFreshnessForOrder и кладёт поля в DTO', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/getFreshnessForOrder\(/);
    expect(src).toMatch(/operationPlanIsStale:\s*freshness\.isStale/);
    expect(src).toMatch(
      /operationPlanStaleReason:\s*freshness\.reason/,
    );
    expect(src).toMatch(
      /operationPlanSourceUpdatedAt:\s*freshness\.sourceUpdatedAt/,
    );
  });
});

describe('Этап 2 — Shared: OrderOperationPlanFreshness в OrderDetailDto', () => {
  test('shared/orders.ts экспортирует OrderOperationPlanFreshness', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(
      /export\s+interface\s+OrderOperationPlanFreshness/,
    );
    expect(src).toMatch(/operationPlanIsStale\?:\s*boolean\s*\|\s*null/);
    expect(src).toMatch(/operationPlanStaleReason\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(
      /operationPlanSourceUpdatedAt\?:\s*string\s*\|\s*null/,
    );
  });

  test('OrderDetailDto extends OrderOperationPlanFreshness', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(
      /OrderDetailDto[\s\S]*?extends[\s\S]*?OrderOperationPlanFreshness/,
    );
  });
});

describe('Этап 2 — Frontend API/action: ручной пересчёт', () => {
  test('orders-api.ts экспортирует recalculateOrderOperationPlan', () => {
    const src = readSrc('apps/web/lib/orders-api.ts');
    expect(src).toMatch(
      /export\s+function\s+recalculateOrderOperationPlan/,
    );
    expect(src).toMatch(/operation-plan\/recalculate/);
  });

  test('actions.ts экспортирует recalculateOrderOperationPlanAction', () => {
    const src = readSrc('apps/web/app/orders/actions.ts');
    expect(src).toMatch(
      /export\s+async\s+function\s+recalculateOrderOperationPlanAction/,
    );
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });
});

describe('Этап 2 — Frontend: блок «План операций» — UI-расширение', () => {
  test('Кнопка RecalculateOperationPlanButton существует', () => {
    const src = readSrc(
      'apps/web/components/orders/recalculate-operation-plan-button.tsx',
    );
    expect(src).toMatch(/RecalculateOperationPlanButton/);
    expect(src).toMatch(/recalculateOrderOperationPlanAction/);
    expect(src).toMatch(/Пересчитать план операций/);
    expect(src).toMatch(/Рассчитать план операций/);
  });

  test('Карточка заказа использует RecalculateOperationPlanButton (в OrderManagementHeader)', () => {
    // Order management redesign: кнопка живёт в шапке через
    // `OrderManagementHeader.showRecalcPlan` (для DRAFT/CALCULATION).
    const src = readSrc(
      'apps/web/components/orders/view/order-management-header.tsx',
    );
    expect(src).toMatch(/RecalculateOperationPlanButton/);
    expect(src).toMatch(/showRecalcPlan/);
    expect(src).toMatch(/status === 'DRAFT'/);
    expect(src).toMatch(/status === 'CALCULATION'/);
    expect(src).toMatch(/status === 'CALCULATION_DONE'/);
  });

  test('OrderOperationsUnifiedTable показывает «Стоимость за 1 изделие» и «Время на 1 изделие»', () => {
    // ТЗ «Переделать вкладку Операции»: эти показатели теперь
    // живут в summary-блоке под единой таблицей операций, а не
    // в отдельной карточке `OrderOperationPlanBlock`.
    const src = readSrc(
      'apps/web/components/orders/operations/order-operations-unified-table.tsx',
    );
    expect(src).toMatch(/Стоимость за 1 изделие/);
    expect(src).toMatch(/Время на 1 изделие/);
    expect(src).toMatch(/data-testid="order-operations-summary-unit-cost"/);
    expect(src).toMatch(/data-testid="order-operations-summary-unit-time"/);
  });

  test('OrderOperationsUnifiedTable показывает stale-warning «План операций требует пересчёта»', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/order-operations-unified-table.tsx',
    );
    expect(src).toMatch(/требует пересчёта/i);
    expect(src).toMatch(/operationPlanIsStale/);
    expect(src).toMatch(/operationPlanStaleReason/);
    expect(src).toMatch(/data-testid="order-operations-summary-stale"/);
  });

  test('globals.css содержит стили stale-badge и подсказок', () => {
    const src = readSrc('apps/web/app/globals.css');
    expect(src).toMatch(/\.admin-order-operation-plan__stale\s*\{/);
    expect(src).toMatch(/\.admin-order-operation-plan__hint\s*\{/);
    expect(src).toMatch(/\.admin-order-operation-plan__actions\s*\{/);
  });
});
