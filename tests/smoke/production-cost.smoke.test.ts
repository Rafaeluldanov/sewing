/**
 * Smoke-тест модуля «Себестоимость выпуска» (`/api/costs/production`,
 * `/production-cost`).
 *
 * Источник истины — backend (`@Roles('SHOP_MANAGER', 'ADMIN')` в
 * `apps/api/src/modules/costs/costs.controller.ts`). Для full-pipeline
 * проверок есть `tests/integration/production-cost.test.ts`. Здесь
 * фиксируем «контракт» текстом, который не требует БД и работает в
 * любой среде:
 *
 *   1. Shared-схема (`packages/shared/src/costs.ts`) содержит
 *      `ProductionCostQuerySchema`, `ProductionCostResponseDto` и
 *      константы `SHIFT_MINUTES = 480`, `MAX_STAGE_MINUTES_PER_PASSPORT
 *      = 60`.
 *   2. `CostsController` навешен на `@Roles('SHOP_MANAGER', 'ADMIN')` и
 *      использует `ZodValidationPipe(ProductionCostQuerySchema)`.
 *   3. `CostsService.getProductionCost` использует `SHIFT_MINUTES` и
 *      `EntryStatus.APPROVED` для piecework, и группирует по дню
 *      `PACKED` event.
 *   4. `PassportDurationsService` cap-ает длительности
 *      `MAX_STAGE_MINUTES_PER_PASSPORT`, и обрабатывает PACKING без
 *      `OPERATION_SCAN` через fallback по предыдущему PACKED.
 *   5. Frontend RBAC (`canSeeProductionCost`) совпадает с backend.
 *   6. Web-страница `/production-cost` ходит в `getProductionCost` и
 *      рендерит график + summary-карточки + таблицу.
 *   7. `CostsModule` подключён к `AppModule`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ProductionCostQuerySchema,
  SHIFT_MINUTES,
  MAX_STAGE_MINUTES_PER_PASSPORT,
} from '@sewing/shared/costs';
import {
  canSeeProductionCost,
  PRODUCTION_COST_ALLOWED_ROLES,
  type Role,
} from '../../apps/web/lib/rbac';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Production Cost — shared contract', () => {
  test('SHIFT_MINUTES = 480, MAX_STAGE_MINUTES_PER_PASSPORT = 60', () => {
    expect(SHIFT_MINUTES).toBe(480);
    expect(MAX_STAGE_MINUTES_PER_PASSPORT).toBe(60);
  });

  test('ProductionCostQuerySchema принимает пустой объект и валидирует YYYY-MM-DD', () => {
    expect(ProductionCostQuerySchema.parse({}).dateFrom).toBeUndefined();
    expect(ProductionCostQuerySchema.parse({ dateFrom: '2026-04-15' }).dateFrom).toBe(
      '2026-04-15',
    );
    expect(() => ProductionCostQuerySchema.parse({ dateFrom: '15.04.2026' })).toThrow();
    expect(() => ProductionCostQuerySchema.parse({ dateTo: 'not-a-date' })).toThrow();
  });
});

describe('Production Cost — backend wiring', () => {
  test('CostsModule подключён в AppModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/CostsModule/);
    expect(src).toMatch(/from '\.\/modules\/costs\/costs\.module/);
  });

  test('CostsController защищён @Roles SHOP_MANAGER + ADMIN', () => {
    const src = readSrc('apps/api/src/modules/costs/costs.controller.ts');
    expect(src).toMatch(/@Roles\(\s*'SHOP_MANAGER',\s*'ADMIN'\s*\)/);
    expect(src).toMatch(/@Get\('production'\)/);
    expect(src).toMatch(/ZodValidationPipe\(ProductionCostQuerySchema\)/);
  });

  test('CostsService использует SHIFT_MINUTES и EntryStatus.APPROVED для piecework', () => {
    const src = readSrc('apps/api/src/modules/costs/costs.service.ts');
    expect(src).toMatch(/SHIFT_MINUTES/);
    expect(src).toMatch(/EntryStatus\.APPROVED/);
    expect(src).toMatch(/PassportEventType\.PACKED/);
    // Простой считается отдельно и НЕ распределяется на изделия.
    expect(src).toMatch(/idleCost/);
  });

  test('PassportDurationsService cap-ает длительности и обрабатывает PACKING fallback', () => {
    const src = readSrc('apps/api/src/modules/costs/passport-durations.service.ts');
    expect(src).toMatch(/MAX_STAGE_MINUTES_PER_PASSPORT/);
    expect(src).toMatch(/PassportEventType\.OPERATION_SCAN/);
    expect(src).toMatch(/PassportEventType\.QC_PASSED/);
    expect(src).toMatch(/PassportEventType\.WTO_PASSED/);
    expect(src).toMatch(/PassportEventType\.PACKED/);
    expect(src).toMatch(/computePackingAccept/);
  });
});

describe('Production Cost — frontend RBAC', () => {
  test('canSeeProductionCost открывает SHOP_MANAGER и ADMIN, закрывает остальных', () => {
    expect(PRODUCTION_COST_ALLOWED_ROLES).toEqual(['ADMIN', 'SHOP_MANAGER']);
    const allowed: Role[] = ['ADMIN', 'SHOP_MANAGER'];
    const denied: Role[] = [
      'CUTTER',
      'CUTTER_ASSISTANT',
      'SEAMSTRESS',
      'QC',
      'IRONING',
      'PACKING',
    ];
    for (const r of allowed) expect(canSeeProductionCost(r)).toBe(true);
    for (const r of denied) expect(canSeeProductionCost(r)).toBe(false);
    expect(canSeeProductionCost(undefined)).toBe(false);
  });

  test('layout редиректит, если пользователь не может видеть страницу', () => {
    const src = readSrc('apps/web/app/production-cost/layout.tsx');
    expect(src).toMatch(/canSeeProductionCost/);
    expect(src).toMatch(/redirect\('\/login\?next=\/production-cost'\)/);
    expect(src).toMatch(/redirect\('\/'\)/);
  });

  test('header содержит ссылку «Себестоимость» для соответствующих ролей', () => {
    const src = readSrc('apps/web/app/layout.tsx');
    expect(src).toMatch(/canSeeProductionCost/);
    expect(src).toMatch(/href="\/production-cost"/);
    expect(src).toMatch(/Себестоимость/);
  });
});

describe('Production Cost — UI page', () => {
  test('страница ходит в getProductionCost и рендерит график + summary + таблицу', () => {
    const src = readSrc('apps/web/app/production-cost/page.tsx');
    expect(src).toMatch(/getProductionCost/);
    expect(src).toMatch(/ProductionCostChart/);
    expect(src).toMatch(/Себестоимость \/ шт/);
    expect(src).toMatch(/Простой/);
    expect(src).toMatch(/Себестоимость, ₽/);
  });

  test('chart-компонент рендерит три серии без внешних зависимостей', () => {
    const src = readSrc('apps/web/app/production-cost/production-cost-chart.tsx');
    expect(src).toMatch(/producedUnits/);
    expect(src).toMatch(/totalCost/);
    expect(src).toMatch(/idleCost/);
    // Никакого recharts/chart.js/d3 — только SVG.
    expect(src).not.toMatch(/from ['"]recharts['"]/);
    expect(src).not.toMatch(/from ['"]chart\.js['"]/);
    expect(src).toMatch(/<svg/);
  });

  test('костс-API ходит в `/costs/production`', () => {
    const src = readSrc('apps/web/lib/costs-api.ts');
    expect(src).toMatch(/\/costs\/production/);
    expect(src).toMatch(/dateFrom/);
    expect(src).toMatch(/dateTo/);
  });
});
