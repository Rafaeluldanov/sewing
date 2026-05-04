/**
 * Smoke-тест «Дашборд начальника производства»
 * (`/admin/production-dashboard`, `/api/dashboard/production`).
 *
 * Источник истины — backend (`@Roles('SHOP_MANAGER', 'ADMIN')` в
 * `apps/api/src/modules/dashboard/dashboard.controller.ts`). Полные
 * флоу проверяются в `tests/integration/production-dashboard.test.ts`,
 * здесь — лёгкий контракт без БД:
 *
 *   1. Shared-схема (`packages/shared/src/dashboard.ts`) экспортирует
 *      `ProductionDashboardQuerySchema` и валидирует `days ∈ {7, 14, 30}`.
 *   2. `DashboardController` навешен на `@Roles('SHOP_MANAGER','ADMIN')`
 *      и использует `ZodValidationPipe(ProductionDashboardQuerySchema)`.
 *   3. `DashboardService` переиспользует `CostsService` /
 *      `PassportDurationsService` / shopfloor projection — без новой
 *      бизнес-логики на стороне UI.
 *   4. Backend wiring: `DashboardModule` подключён к `AppModule`, импортирует
 *      `CostsModule`.
 *   5. Frontend: layout `/admin/*` режет доступ через `canSeeAdmin`,
 *      страница использует `getProductionDashboard` и шесть управленческих
 *      блоков.
 *   6. Заголовок и главная содержат вход на дашборд под админом/менеджером.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PRODUCTION_DASHBOARD_PERIOD,
  PRODUCTION_DASHBOARD_PERIODS,
  PRODUCTION_DASHBOARD_ROLE_LABELS,
  PRODUCTION_DASHBOARD_STAGE_LABELS,
  ProductionDashboardQuerySchema,
} from '@sewing/shared/dashboard';

const repoRoot = path.resolve(__dirname, '..', '..');
function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Production Dashboard — shared contract', () => {
  test('PRODUCTION_DASHBOARD_PERIODS = [7, 14, 30], default = 7', () => {
    expect([...PRODUCTION_DASHBOARD_PERIODS]).toEqual([7, 14, 30]);
    expect(DEFAULT_PRODUCTION_DASHBOARD_PERIOD).toBe(7);
  });

  test('ProductionDashboardQuerySchema принимает 7/14/30 (включая строку), отвергает остальное', () => {
    expect(ProductionDashboardQuerySchema.parse({}).days).toBe(7);
    expect(ProductionDashboardQuerySchema.parse({ days: '14' }).days).toBe(14);
    expect(ProductionDashboardQuerySchema.parse({ days: 30 }).days).toBe(30);
    expect(() => ProductionDashboardQuerySchema.parse({ days: '99' })).toThrow();
    expect(() => ProductionDashboardQuerySchema.parse({ days: 'abc' })).toThrow();
  });

  test('Stage / Role labels — все стадии и все роли подписаны', () => {
    expect(PRODUCTION_DASHBOARD_STAGE_LABELS.CUT).toBe('Крой');
    expect(PRODUCTION_DASHBOARD_STAGE_LABELS.FINISHED).toBe('Выпущено');
    expect(PRODUCTION_DASHBOARD_ROLE_LABELS.QC).toBe('ОТК');
    expect(PRODUCTION_DASHBOARD_ROLE_LABELS.IRONING).toBe('ВТО');
    expect(PRODUCTION_DASHBOARD_ROLE_LABELS.PACKING).toBe('Упаковка');
  });
});

describe('Production Dashboard — backend wiring', () => {
  test('DashboardModule подключён в AppModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/DashboardModule/);
    expect(src).toMatch(/from '\.\/modules\/dashboard\/dashboard\.module/);
  });

  test('DashboardController защищён @Roles SHOP_MANAGER + ADMIN (+ DISPLAY) и валидирует Query', () => {
    const src = readSrc('apps/api/src/modules/dashboard/dashboard.controller.ts');
    // Базовые роли — менеджер и админ. DISPLAY-учётка тоже допустима
    // (большой монитор начальника), её добавили после §11a (см.
    // `docs/screens.md`), и тест должен это допускать. Остальные роли
    // (SEAMSTRESS / QC / IRONING / PACKING) проверяются интеграционно
    // в `production-dashboard.test.ts` и обязаны получать 403.
    expect(src).toMatch(/@Roles\([^)]*'SHOP_MANAGER'[^)]*\)/);
    expect(src).toMatch(/@Roles\([^)]*'ADMIN'[^)]*\)/);
    expect(src).toMatch(/@Get\('production'\)/);
    expect(src).toMatch(/ZodValidationPipe\(ProductionDashboardQuerySchema\)/);
  });

  test('DashboardService переиспользует CostsService и PassportDurationsService', () => {
    const src = readSrc('apps/api/src/modules/dashboard/dashboard.service.ts');
    expect(src).toMatch(/CostsService/);
    expect(src).toMatch(/PassportDurationsService/);
    // Pipeline через shopfloor-projection (один словарь со «Цех»).
    expect(src).toMatch(/shopfloor-projection/);
    // Свежие QC_PASSED/WTO_PASSED для derived-стадий.
    expect(src).toMatch(/PassportEventType\.QC_PASSED/);
    expect(src).toMatch(/PassportEventType\.PACKED/);
  });

  test('DashboardModule импортирует CostsModule (источник CostsService)', () => {
    const src = readSrc('apps/api/src/modules/dashboard/dashboard.module.ts');
    expect(src).toMatch(/CostsModule/);
    expect(src).toMatch(/DashboardController/);
    expect(src).toMatch(/DashboardService/);
  });
});

describe('Production Dashboard — frontend', () => {
  test('layout /admin/* режет доступ через canSeeAdmin', () => {
    const src = readSrc('apps/web/app/admin/layout.tsx');
    expect(src).toMatch(/canSeeAdmin/);
  });

  test('страница использует getProductionDashboard и все шесть блоков', () => {
    const src = readSrc('apps/web/app/admin/production-dashboard/page.tsx');
    expect(src).toMatch(/getProductionDashboard/);
    // 1) KPI
    expect(src).toMatch(/Выпущено сегодня/);
    expect(src).toMatch(/В работе сейчас/);
    expect(src).toMatch(/Загрузка цеха сегодня/);
    // 2) Pipeline
    expect(src).toMatch(/Где сейчас изделия/);
    expect(src).toMatch(/PRODUCTION_DASHBOARD_STAGE_LABELS/);
    // 3) Trend chart
    expect(src).toMatch(/ProductionDashboardTrendChart/);
    expect(src).toMatch(/Динамика по дням/);
    // 4) Role load
    expect(src).toMatch(/Загрузка по ролям/);
    expect(src).toMatch(/PRODUCTION_DASHBOARD_ROLE_LABELS/);
    // 5) Alerts
    expect(src).toMatch(/Требует внимания/);
    // 6) Quick actions
    expect(src).toMatch(/Быстрые переходы/);
    expect(src).toMatch(/href="\/shopfloor"/);
    expect(src).toMatch(/href="\/production-cost"/);
    expect(src).toMatch(/href="\/earnings"/);
  });

  test('chart-компонент рендерит 3 серии без внешних зависимостей', () => {
    const src = readSrc(
      'apps/web/app/admin/production-dashboard/trend-chart.tsx',
    );
    expect(src).toMatch(/producedUnits/);
    expect(src).toMatch(/totalCost/);
    expect(src).toMatch(/idleCost/);
    expect(src).not.toMatch(/from ['"]recharts['"]/);
    expect(src).not.toMatch(/from ['"]chart\.js['"]/);
    expect(src).toMatch(/<svg/);
  });

  test('lib/dashboard-api ходит в `/dashboard/production`', () => {
    const src = readSrc('apps/web/lib/dashboard-api.ts');
    expect(src).toMatch(/\/dashboard\/production/);
    expect(src).toMatch(/getProductionDashboard/);
    expect(src).toMatch(/days/);
  });

  test('Header содержит ссылку «Дашборд» для SHOP_MANAGER/ADMIN', () => {
    const src = readSrc('apps/web/app/layout.tsx');
    expect(src).toMatch(/href="\/admin\/production-dashboard"/);
    expect(src).toMatch(/Дашборд/);
  });

  test('Production-dashboard остаётся доступен ADMIN/SHOP_MANAGER из шапки', () => {
    // После auth-design-cleanup-а корневая `/` стала pure redirect
    // (см. `docs/auth-design-cleanup-recon.md §3, §7`) — старый
    // tile-grid с «Дашборд начальника» уехал из root, а сам
    // `/admin/production-dashboard` менеджер открывает либо из шапки
    // (Header-тест выше), либо по прямой ссылке. Здесь дублируем
    // проверку link-а в `layout.tsx`, чтобы регрессия не пропала
    // вместе с изменённой главной.
    const layout = readSrc('apps/web/app/layout.tsx');
    expect(layout).toMatch(/href="\/admin\/production-dashboard"/);
    expect(layout).toMatch(/Дашборд/);
  });
});
