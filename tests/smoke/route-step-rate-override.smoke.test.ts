/**
 * Smoke-тесты фичи «цена операции зависит от изделия»
 * (переопределение сдельной расценки на шаге маршрута).
 *
 * Идея: операция остаётся одна на всю систему (например, «Оверлок»),
 * но в каждом изделии у неё может быть своя расценка. Реализация —
 * nullable-поле `RouteTemplateStep.rateOverride`, снимок которого едет
 * в `OrderRouteStep.rateOverride` при старте заказа. Источник истины
 * при чтении — `OperationsService.resolveRate(... , orderId)`.
 *
 * Тесты без БД и без рендера: проверяем, что проводка на месте
 * (additive). Это страхует от регресса «случайно убрали override из
 * snapshot-а / из расчёта зарплаты / из плановой себестоимости / из UI».
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

describe('Prisma: rateOverride на шаге маршрута и в snapshot-е заказа', () => {
  test('Схема содержит rateOverride на RouteTemplateStep и OrderRouteStep', () => {
    const src = readSrc('prisma/schema.prisma');
    const tpl = src.split('model RouteTemplateStep')[1]?.split('model ')[0] ?? '';
    const ord = src.split('model OrderRouteStep')[1]?.split('model ')[0] ?? '';
    expect(tpl).toMatch(/rateOverride\s+Decimal\?\s+@db\.Decimal\(12,\s*2\)/);
    expect(ord).toMatch(/rateOverride\s+Decimal\?\s+@db\.Decimal\(12,\s*2\)/);
  });

  test('Миграция additive: добавляет два столбца, ничего не дропает', () => {
    const src = readSrc(
      'prisma/migrations/20260819100000_add_route_step_rate_override/migration.sql',
    );
    expect(src).toMatch(
      /ALTER TABLE "RouteTemplateStep" ADD COLUMN "rateOverride" DECIMAL\(12,2\)/,
    );
    expect(src).toMatch(
      /ALTER TABLE "OrderRouteStep" ADD COLUMN "rateOverride" DECIMAL\(12,2\)/,
    );
    expect(src).not.toMatch(/DROP TABLE/);
    expect(src).not.toMatch(/DROP COLUMN/);
    // Никаких изменений на критичных payroll/факт-таблицах.
    expect(src).not.toMatch(/ALTER TABLE "OperationEntry"/);
    expect(src).not.toMatch(/ALTER TABLE "SalaryEntry"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared DTO
// ---------------------------------------------------------------------------

describe('Shared: route DTO содержат rateOverride', () => {
  test('RouteTemplateStepInputSchema принимает rateOverride (nullable)', () => {
    const src = readSrc('packages/shared/src/routes.ts');
    expect(src).toMatch(/RouteStepRateOverrideField/);
    expect(src).toMatch(/rateOverride:\s*RouteStepRateOverrideField/);
    // Деньги: неотрицательное, ≤ 2 знака.
    expect(src).toMatch(/\.nonnegative\(/);
  });

  test('Response-DTO шага и snapshot-а отдают rateOverride: number | null', () => {
    const src = readSrc('packages/shared/src/routes.ts');
    const stepDto = src.split('RouteTemplateStepDto')[1] ?? '';
    expect(stepDto).toMatch(/rateOverride:\s*number\s*\|\s*null/);
    const orderStepDto = src.split('OrderRouteStepDto')[1] ?? '';
    expect(orderStepDto).toMatch(/rateOverride:\s*number\s*\|\s*null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Backend: resolveRate подхватывает override изделия
// ---------------------------------------------------------------------------

describe('Backend: resolveRate + snapshot + earnings используют override', () => {
  test('resolveRate принимает orderId и ищет OrderRouteStep.rateOverride для FIXED', () => {
    const src = readSrc(
      'apps/api/src/modules/operations/operations.service.ts',
    );
    expect(src).toMatch(/orderId\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(/orderRouteStep\.findFirst/);
    // override вытесняет дефолт fixedRate.
    expect(src).toMatch(/override\?\.rateOverride\s*\?\?\s*op\.fixedRate/);
  });

  test('RoutesService снапшотит rateOverride (create / replaceSteps / snapshot)', () => {
    const src = readSrc('apps/api/src/modules/routes/routes.service.ts');
    // Минимум: чтение в snapshot + запись в createMany.
    const occurrences = src.match(/rateOverride/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
  });

  test('OrdersService копирует rateOverride в OrderRouteStep при синхронизации snapshot-а', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/rateOverride:\s*s\.rateOverride\s*\?\?\s*null/);
  });

  test('B2B-база закройщика учитывает rateOverride снапшота вместо дефолта', () => {
    const src = readSrc('apps/api/src/modules/earnings/earnings.service.ts');
    expect(src).toMatch(/step\.rateOverride\s*\?\?\s*op\.fixedRate/);
    // Отложенный пошив передаёт orderId паспорта в resolveRate.
    expect(src).toMatch(/passportForOrder\?\.orderId/);
  });

  test('Плановая себестоимость использует override (совпадает с фактом)', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    // Эффективная FIXED-расценка плана: per-order оверрайд снимка заказа
    // (`ov.rateOverride`) вытесняет дефолт, при дивергенции — расценка
    // шаблона (`step.rateOverride`), затем `op.fixedRate`. План должен
    // совпадать с фактическим начислением (`resolveRate`).
    expect(src).toMatch(/step\.rateOverride\)\s*\?\?\s*op\.fixedRate/);
    expect(src).toMatch(/ov\s*\?\s*ov\.rateOverride/);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend: редактор маршрута даёт задать расценку для изделия
// ---------------------------------------------------------------------------

describe('Frontend: редактор маршрута + server action', () => {
  test('Форма рендерит поле расценки только для FIXED-операций', () => {
    const src = readSrc('apps/web/app/admin/routes/route-template-form.tsx');
    expect(src).toMatch(/op\.pricingMode === 'FIXED'/);
    expect(src).toMatch(/name=\{`stepRate\[\$\{step\.operationId\}\]`\}/);
    expect(src).toMatch(/rateOverride/);
  });

  test('Server action парсит stepRate в число или null', () => {
    const src = readSrc('apps/web/app/admin/routes/actions.ts');
    expect(src).toMatch(/stepRate\[\$\{operationId\}\]/);
    expect(src).toMatch(/function parseRate/);
  });

  test('OperationLiteDto и shifts-meta отдают pricingMode/fixedRate для UI', () => {
    const dto = readSrc('packages/shared/src/shifts.ts');
    expect(dto).toMatch(/pricingMode\?:\s*string/);
    expect(dto).toMatch(/fixedRate\?:\s*number\s*\|\s*null/);
    const meta = readSrc('apps/api/src/modules/shifts/shifts.service.ts');
    expect(meta).toMatch(/pricingMode:\s*o\.pricingMode/);
    expect(meta).toMatch(/fixedRate:\s*o\.fixedRate/);
  });
});
