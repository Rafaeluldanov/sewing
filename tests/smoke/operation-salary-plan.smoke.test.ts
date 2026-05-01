/**
 * Smoke-тесты для «Плановой стоимости окладных операций»
 * (см. ТЗ «Плановая стоимость окладных операций по нормам времени»).
 *
 * Без рендера React и без работы с БД — проверяем, что исходники
 * содержат нужные сущности (additive). Это страхует от регресса
 * «случайно удалили плановую окладную ставку у операции» и
 * «по ошибке вернули `cost = 0` для SALARY_ONLY».
 *
 * Что фиксируем:
 *   - Prisma: Operation.salaryPlanRubPerShift / salaryPlanShiftSeconds
 *     + миграция additive.
 *   - Shared: Create/UpdateOperationSchema принимают новые поля,
 *     OperationSummaryDto/OperationDetailDto их отдают.
 *   - OperationsService: помощник `resolveSalaryPlanCostPerSecond` +
 *     поля сохраняются в `create`/`update`.
 *   - OrderOperationPlanService: SALARY_ONLY теперь использует
 *     `salaryPlanRubPerShift / salaryPlanShiftSeconds`, а не cost = 0.
 *   - Frontend: формы создания/редактирования содержат блок «Плановая
 *     окладная стоимость», operation-economics показывает SALARY_ONLY-блок.
 *   - Helper `calculateSalaryPlanEconomics` существует и считает:
 *     `costPerUnit = salaryPlanRubPerShift / salaryPlanShiftSeconds × timeNormSec`.
 *   - Что НЕ изменилось: payroll (earnings/salary), Passport,
 *     OperationEntry, SalaryEntry, production-cost, Employee.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  calculateSalaryPlanEconomics,
  formatCostPerUnit,
} from '../../apps/web/lib/operation-economics';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Prisma + миграция
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — Prisma: salaryPlanRubPerShift / salaryPlanShiftSeconds', () => {
  test('Prisma-схема содержит salaryPlanRubPerShift и salaryPlanShiftSeconds', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(
      /salaryPlanRubPerShift\s+Decimal\?\s+@db\.Decimal\(14,\s*2\)/,
    );
    expect(src).toMatch(/salaryPlanShiftSeconds\s+Int\?\s+@default\(28800\)/);
  });

  test('Миграция 20260524100000_add_operation_salary_plan_rate существует и additive', () => {
    const src = readSrc(
      'prisma/migrations/20260524100000_add_operation_salary_plan_rate/migration.sql',
    );
    expect(src).toMatch(/ALTER TABLE "Operation"/);
    expect(src).toMatch(
      /ADD COLUMN "salaryPlanRubPerShift"\s+DECIMAL\(14,\s*2\)/,
    );
    expect(src).toMatch(
      /ADD COLUMN "salaryPlanShiftSeconds"\s+INTEGER\s+DEFAULT\s+28800/,
    );
    expect(src).not.toMatch(/DROP TABLE/);
    expect(src).not.toMatch(/DROP COLUMN/);
    // Никаких изменений на критичных payroll/факт-таблицах.
    expect(src).not.toMatch(/ALTER TABLE "Employee"/);
    expect(src).not.toMatch(/ALTER TABLE "OperationEntry"/);
    expect(src).not.toMatch(/ALTER TABLE "SalaryEntry"/);
    expect(src).not.toMatch(/ALTER TABLE "Passport"/);
    expect(src).not.toMatch(/ALTER TABLE "Order"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — Shared: schemas + DTOs', () => {
  test('CreateOperationSchema принимает salaryPlanRubPerShift / salaryPlanShiftSeconds', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    const create = src.split('CreateOperationSchema')[1] ?? '';
    expect(create).toMatch(/salaryPlanRubPerShift/);
    expect(create).toMatch(/salaryPlanShiftSeconds/);
  });

  test('UpdateOperationSchema принимает salaryPlanRubPerShift / salaryPlanShiftSeconds', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    const update = src.split('UpdateOperationSchema')[1] ?? '';
    expect(update).toMatch(/salaryPlanRubPerShift/);
    expect(update).toMatch(/salaryPlanShiftSeconds/);
  });

  test('OperationSummaryDto отдаёт salaryPlanRubPerShift и salaryPlanShiftSeconds', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    expect(src).toMatch(/salaryPlanRubPerShift:\s*number\s*\|\s*null/);
    expect(src).toMatch(/salaryPlanShiftSeconds:\s*number\s*\|\s*null/);
  });

  test('UpdateOperationSchema.refine считает salaryPlan-поля как «есть что сохранять»', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    expect(src).toMatch(
      /obj\.salaryPlanRubPerShift\s+!==\s+undefined/,
    );
    expect(src).toMatch(
      /obj\.salaryPlanShiftSeconds\s+!==\s+undefined/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. OperationsService
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — OperationsService', () => {
  const src = readSrc(
    'apps/api/src/modules/operations/operations.service.ts',
  );

  test('create() сохраняет salaryPlanRubPerShift / salaryPlanShiftSeconds', () => {
    expect(src).toMatch(/salaryPlanRubPerShift,\s*\n\s*salaryPlanShiftSeconds,/);
  });

  test('update() обрабатывает salaryPlanRubPerShift / salaryPlanShiftSeconds', () => {
    expect(src).toMatch(/dto\.salaryPlanRubPerShift\s*!==\s*undefined/);
    expect(src).toMatch(/dto\.salaryPlanShiftSeconds\s*!==\s*undefined/);
  });

  test('resolveSalaryPlanCostPerSecond существует и возвращает Decimal | null', () => {
    expect(src).toMatch(
      /resolveSalaryPlanCostPerSecond\(\s*operation:\s*\{/,
    );
    expect(src).toMatch(/operation\.salaryPlanRubPerShift\.div\(/);
  });

  test('resolveRate НЕ изменён (контракт сохраняется)', () => {
    expect(src).toMatch(/async\s+resolveRate\(/);
    expect(src).toMatch(/OperationRateMissingException/);
    // SALARY_ONLY → null
    expect(src).toMatch(
      /if\s+\(op\.pricingMode\s+===\s+'SALARY_ONLY'\)\s+return\s+null/,
    );
  });

  test('toSummary включает salaryPlan-поля в DTO', () => {
    expect(src).toMatch(/salaryPlanRubPerShift:\s*row\.salaryPlanRubPerShift/);
    expect(src).toMatch(/salaryPlanShiftSeconds:\s*row\.salaryPlanShiftSeconds/);
  });
});

// ---------------------------------------------------------------------------
// 4. OrderOperationPlanService: SALARY_ONLY теперь считается по плану
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — OrderOperationPlanService', () => {
  const src = readSrc(
    'apps/api/src/modules/orders/order-operation-plan.service.ts',
  );

  test('select подгружает salaryPlanRubPerShift / salaryPlanShiftSeconds', () => {
    expect(src).toMatch(/salaryPlanRubPerShift:\s*true/);
    expect(src).toMatch(/salaryPlanShiftSeconds:\s*true/);
  });

  test('SALARY_ONLY больше НЕ всегда `cost = new Prisma.Decimal(0)`', () => {
    // Старая ветка `rate = new Prisma.Decimal(0)` для SALARY_ONLY
    // должна исчезнуть: теперь cost = timeSec × costPerSec × qty.
    // Допускаем `Prisma.Decimal(0)` где-то ещё (totalCost инициализация),
    // но не в ветке SALARY_ONLY.
    const salaryBranch = src.match(
      /op\.pricingMode\s*===\s*'SALARY_ONLY'[\s\S]*?\n\s{8}\}\s+else\s+if/,
    );
    expect(salaryBranch).not.toBeNull();
    const branchSrc = salaryBranch?.[0] ?? '';
    expect(branchSrc).not.toMatch(/rate\s*=\s*new\s+Prisma\.Decimal\(0\)/);
  });

  test('SALARY_ONLY использует salaryCostPerSec.mul(timeSec).mul(qty)', () => {
    expect(src).toMatch(/salaryCostPerSec/);
    expect(src).toMatch(
      /salaryCostPerSec\.mul\(timeSec\)\.mul\(qty\)/,
    );
  });

  test('salaryCostPerSec считается как salaryPlanRubPerShift / salaryPlanShiftSeconds (с fallback 28800)', () => {
    expect(src).toMatch(
      /op\.salaryPlanRubPerShift\.div\(\s*\n?\s*op\.salaryPlanShiftSeconds[\s\S]*?28800/,
    );
  });

  test('Если ставка не задана — warning «Не задана плановая окладная ставка»', () => {
    expect(src).toMatch(/Не задана плановая окладная ставка операции/);
  });

  test('Время по-прежнему считается даже без плановой ставки', () => {
    // Время вычисляется до денег и складывается независимо.
    // `if (timeSec != null) totalTimeSec += timeSec * qty;` остался.
    expect(src).toMatch(/if\s*\(\s*timeSec\s*!=\s*null\s*\)\s*\{?\s*\n?\s*totalTimeSec\s*\+=/);
  });

  test('Stale-detection учитывает Operation.updatedAt (включая salaryPlan)', () => {
    // Operation.updatedAt уже учитывается в getFreshnessForOrder; правка
    // salaryPlan-полей меняет updatedAt автоматически.
    expect(src).toMatch(/operation\.aggregate/);
    // В docstring stale-detection упоминается salaryPlan.
    expect(src).toMatch(/salaryPlanRubPerShift/);
  });
});

// ---------------------------------------------------------------------------
// 5. Frontend: формы и блок экономики
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — Frontend формы', () => {
  test('OperationEditForm содержит блок «Плановая окладная стоимость»', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/edit-form.tsx');
    expect(src).toMatch(/Плановая окладная стоимость/);
    expect(src).toMatch(/Стоимость смены, ₽/);
    expect(src).toMatch(/Длительность смены, ч/);
    expect(src).toMatch(/name="salaryPlanRubPerShift"/);
    expect(src).toMatch(/name="salaryPlanShiftHours"/);
    // Подсказка про то, что фактическая зарплата не меняется.
    expect(src).toMatch(/[Фф]актическая зарплата[^\n]+не меняется/);
  });

  test('CreateOperationForm содержит блок «Плановая стоимость смены»', () => {
    const src = readSrc('apps/web/app/admin/operations/create-form.tsx');
    expect(src).toMatch(/[Пп]лановая стоимость смены/);
    expect(src).toMatch(/name="salaryPlanRubPerShift"/);
    expect(src).toMatch(/name="salaryPlanShiftHours"/);
  });

  test('actions.ts парсит salaryPlanRubPerShift/salaryPlanShiftHours из FormData', () => {
    const src = readSrc('apps/web/app/admin/operations/actions.ts');
    expect(src).toMatch(/parseSalaryPlanFromForm/);
    expect(src).toMatch(/salaryPlanRubPerShift/);
    expect(src).toMatch(/salaryPlanShiftHours/);
    // Часы → секунды (× 3600).
    expect(src).toMatch(/hours\s*\*\s*3600/);
  });

  test('updateOperationAction передаёт salaryPlanRub/Sec в DTO', () => {
    const src = readSrc('apps/web/app/admin/operations/actions.ts');
    expect(src).toMatch(/dto\.salaryPlanRubPerShift\s*=/);
    expect(src).toMatch(/dto\.salaryPlanShiftSeconds\s*=/);
  });

  test('createOperationAction передаёт salaryPlanRub/Sec в createOperation', () => {
    const src = readSrc('apps/web/app/admin/operations/actions.ts');
    // Используется conditional spread — ищем оба поля рядом.
    expect(src).toMatch(/salaryPlanRubPerShift:\s*salaryPlan\.salaryPlanRubPerShift/);
    expect(src).toMatch(
      /salaryPlanShiftSeconds:\s*salaryPlan\.salaryPlanShiftSeconds/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Operation economics UI: SALARY_ONLY-блок и helper
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — UI карточки операции', () => {
  test('Карточка операции показывает SALARY_ONLY-блок с плановой стоимостью', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/page.tsx');
    expect(src).toMatch(/SalaryOnlyEconomicsBlock/);
    expect(src).toMatch(/Плановая стоимость смены/);
    expect(src).toMatch(/Стоимость на изделие/);
    expect(src).toMatch(/Выработка за смену/);
    expect(src).toMatch(/Плановая окладная ставка не задана/);
  });

  test('Page импортирует calculateSalaryPlanEconomics + formatCostPerUnit', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/page.tsx');
    expect(src).toMatch(/calculateSalaryPlanEconomics/);
    expect(src).toMatch(/formatCostPerUnit/);
  });

  test('operation-economics.ts экспортирует calculateSalaryPlanEconomics', () => {
    const src = readSrc('apps/web/lib/operation-economics.ts');
    expect(src).toMatch(/export function calculateSalaryPlanEconomics/);
    expect(src).toMatch(/SalaryPlanEconomicsInput/);
    expect(src).toMatch(/SalaryPlanEconomics\b/);
  });

  test('calculateSalaryPlanEconomics: 3200₽ / 28800с × 120с = 13.33₽/изделие', () => {
    const econ = calculateSalaryPlanEconomics({
      salaryPlanRubPerShift: 3200,
      salaryPlanShiftSeconds: 28800,
      timeNormSec: 120,
    });
    expect(econ.unitsPerShift).toBe(28800 / 120); // 240
    expect(econ.totalShiftCostRub).toBe(3200);
    // 3200 / 240 = 13.333...
    expect(econ.costPerUnitRub).toBeCloseTo(3200 / 240, 4);
  });

  test('calculateSalaryPlanEconomics: ставка не задана ⇒ costPerUnit/totalShiftCost null, units считаются', () => {
    const econ = calculateSalaryPlanEconomics({
      salaryPlanRubPerShift: null,
      salaryPlanShiftSeconds: 28800,
      timeNormSec: 120,
    });
    expect(econ.totalShiftCostRub).toBeNull();
    expect(econ.costPerUnitRub).toBeNull();
    expect(econ.unitsPerShift).toBe(240);
  });

  test('calculateSalaryPlanEconomics: норма не задана ⇒ всё null кроме totalShiftCost', () => {
    const econ = calculateSalaryPlanEconomics({
      salaryPlanRubPerShift: 3200,
      salaryPlanShiftSeconds: 28800,
      timeNormSec: null,
    });
    expect(econ.unitsPerShift).toBeNull();
    expect(econ.costPerUnitRub).toBeNull();
    expect(econ.totalShiftCostRub).toBe(3200);
  });

  test('calculateSalaryPlanEconomics: shiftSeconds null ⇒ fallback 28800', () => {
    const econ = calculateSalaryPlanEconomics({
      salaryPlanRubPerShift: 3200,
      salaryPlanShiftSeconds: null,
      timeNormSec: 120,
    });
    expect(econ.effectiveShiftSeconds).toBe(28800);
    expect(econ.unitsPerShift).toBe(240);
  });

  test('formatCostPerUnit: < 100₽ ⇒ 2 знака после запятой', () => {
    expect(formatCostPerUnit(0.13)).toMatch(/0,13\s\u20BD/);
    expect(formatCostPerUnit(13.33)).toMatch(/13,33\s\u20BD/);
  });

  test('formatCostPerUnit: ≥ 100₽ ⇒ целые', () => {
    expect(formatCostPerUnit(133.33)).toMatch(/133\s\u20BD/);
  });

  test('formatCostPerUnit: null/NaN ⇒ «—»', () => {
    expect(formatCostPerUnit(null)).toBe('—');
    expect(formatCostPerUnit(undefined)).toBe('—');
    expect(formatCostPerUnit(NaN)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// 7. Что НЕ должно меняться (payroll / Employee / SalaryEntry / OperationEntry)
// ---------------------------------------------------------------------------

describe('Прайс-плана окладных — НЕ трогаем payroll / Employee / Passport / production-cost', () => {
  const forbiddenInFiles = [
    'apps/api/src/modules/earnings/earnings.service.ts',
    'apps/api/src/modules/salary/salary.service.ts',
    'apps/api/src/modules/passports/passports.service.ts',
    'apps/api/src/modules/costs/costs.service.ts',
  ];

  for (const file of forbiddenInFiles) {
    test(`${file} не упоминает salaryPlanRubPerShift / salaryPlanShiftSeconds`, () => {
      const src = readSrc(file);
      expect(src).not.toMatch(/salaryPlanRubPerShift/);
      expect(src).not.toMatch(/salaryPlanShiftSeconds/);
      expect(src).not.toMatch(/resolveSalaryPlanCostPerSecond/);
    });
  }

  test('OperationEntry / SalaryEntry в Prisma-схеме не получили новых полей', () => {
    const src = readSrc('prisma/schema.prisma');
    // Старые модели не получают salaryPlan*
    const opEntryBlock = src.match(/model\s+OperationEntry\s*\{[\s\S]*?\n\}/);
    const salEntryBlock = src.match(/model\s+SalaryEntry\s*\{[\s\S]*?\n\}/);
    expect(opEntryBlock).not.toBeNull();
    expect(salEntryBlock).not.toBeNull();
    expect(opEntryBlock?.[0] ?? '').not.toMatch(/salaryPlan/);
    expect(salEntryBlock?.[0] ?? '').not.toMatch(/salaryPlan/);
  });

  test('Employee Prisma-модель не получила salaryPlan-поля', () => {
    const src = readSrc('prisma/schema.prisma');
    const empBlock = src.match(/model\s+Employee\s*\{[\s\S]*?\n\}/);
    expect(empBlock).not.toBeNull();
    expect(empBlock?.[0] ?? '').not.toMatch(/salaryPlanRubPerShift/);
    expect(empBlock?.[0] ?? '').not.toMatch(/salaryPlanShiftSeconds/);
  });
});
