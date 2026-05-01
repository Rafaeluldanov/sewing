/**
 * Admin Analytics — KPI / Heatmap / новые admin-обёртки smoke.
 *
 * Source-level smoke по тому же паттерну, что и остальные admin-smoke
 * (`admin-ui-polish`, `admin-ui-consistency`): полноценного React-
 * рендера в проекте нет (vitest без jsdom), поэтому фиксируем
 * регрессы в исходниках.
 *
 * Что охраняем:
 *   1. На `/admin` появился KPI-блок и тепловая карта.
 *   2. Хелперы `lib/admin-analytics.ts` существуют (KPI / heatmap /
 *      bottleneck) и опираются на `ShopfloorDisplayDto` + `MasterCallDto`.
 *   3. Компонент `AdminProductionHeatmap` экспортируется барелл-индексом.
 *   4. Sidebar — «Заказы» выше «Сотрудники», и ссылается на
 *      `/admin/orders`, а «Себестоимость» — на `/admin/production-cost`.
 *   5. `/admin/orders` и `/admin/production-cost` существуют и
 *      используют новые admin-компоненты.
 *   6. globals.css содержит новые цветовые токены (blue/green/orange/
 *      purple) и accent-классы.
 *   7. Никаких тёмных фонов в новом блоке стилей.
 *   8. `/master` и `/shopfloor/display` не затронуты.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. /admin — после Admin Final Cleanup KPI и Heatmap убраны
// ---------------------------------------------------------------------------

describe('Admin Analytics — /admin после финальной чистки', () => {
  test('/admin/page.tsx больше НЕ содержит KPI блок и AdminProductionHeatmap', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).not.toMatch(/admin-kpi-grid/);
    expect(src).not.toMatch(/AdminProductionHeatmap/);
    expect(src).not.toMatch(/buildAdminKpis/);
    expect(src).not.toMatch(/buildProductionHeatmap/);
  });

  test('/admin/page.tsx больше не подтягивает heavy production summaries', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).not.toMatch(/getShopfloorDisplaySummary/);
    expect(src).not.toMatch(/listOpenMasterCalls/);
  });

  test('/admin/page.tsx сохраняет цветовые акценты карточек разделов', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).toMatch(/admin-home-card__icon--blue/);
    expect(src).toMatch(/admin-home-card__icon--green/);
    expect(src).toMatch(/admin-home-card__icon--orange/);
    expect(src).toMatch(/admin-home-card__icon--purple/);
  });
});

// ---------------------------------------------------------------------------
// 2. lib/admin-analytics.ts
// ---------------------------------------------------------------------------

describe('Admin Analytics — admin-analytics.ts', () => {
  test('exports buildAdminKpis / buildProductionHeatmap / detectAdminBottleneck', () => {
    const src = readSrc('apps/web/lib/admin-analytics.ts');
    expect(src).toMatch(/export function buildAdminKpis\(/);
    expect(src).toMatch(/export function buildProductionHeatmap\(/);
    expect(src).toMatch(/export function detectAdminBottleneck\(/);
    expect(src).toMatch(/BOTTLENECK_BUFFER_THRESHOLD/);
  });

  test('admin-analytics использует ShopfloorDisplayDto и MasterCallDto', () => {
    const src = readSrc('apps/web/lib/admin-analytics.ts');
    expect(src).toMatch(/ShopfloorDisplayDto/);
    expect(src).toMatch(/MasterCallDto/);
  });
});

// ---------------------------------------------------------------------------
// 3. Heatmap компонент
// ---------------------------------------------------------------------------

describe('Admin Analytics — heatmap component', () => {
  test('admin-production-heatmap.tsx существует и рендерит чипы', () => {
    const src = readSrc(
      'apps/web/components/admin/admin-production-heatmap.tsx',
    );
    expect(src).toMatch(/export function AdminProductionHeatmap/);
    expect(src).toMatch(/admin-heatmap__chip/);
    expect(src).toMatch(/admin-heatmap__chip--/);
  });

  test('barrel @/components/admin реэкспортирует AdminProductionHeatmap', () => {
    const src = readSrc('apps/web/components/admin/index.ts');
    expect(src).toMatch(/AdminProductionHeatmap/);
  });
});

// ---------------------------------------------------------------------------
// 4. Sidebar — порядок и ссылки
// ---------------------------------------------------------------------------

describe('Admin Analytics — sidebar', () => {
  test('sidebar: «Заказы» поднят выше «Сотрудники»', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    const ordersIdx = src.indexOf("label: 'Заказы'");
    const employeesIdx = src.indexOf("label: 'Сотрудники'");
    expect(ordersIdx).toBeGreaterThan(0);
    expect(employeesIdx).toBeGreaterThan(0);
    expect(ordersIdx).toBeLessThan(employeesIdx);
  });

  test('sidebar: ссылка «Заказы» ведёт на /admin/orders', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(
      /href:\s*['"]\/admin\/orders['"][\s\S]*?label:\s*['"]Заказы['"]/,
    );
  });

  test('sidebar: ссылка «Себестоимость» ведёт на /admin/production-cost', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(
      /href:\s*['"]\/admin\/production-cost['"][\s\S]*?label:\s*['"]Себестоимость['"]/,
    );
  });

  test('sidebar: иконка «Заказы» — Package или ClipboardList', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(
      /label:\s*['"]Заказы['"][\s\S]*?Icon:\s*(Package|ClipboardList)/,
    );
  });

  test('sidebar: иконка «Себестоимость» — Box или CircleDollarSign', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(
      /label:\s*['"]Себестоимость['"][\s\S]*?Icon:\s*(Box|CircleDollarSign)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. /admin/orders — новый admin-стиль
// ---------------------------------------------------------------------------

describe('Admin Analytics — /admin/orders', () => {
  test('/admin/orders/page.tsx существует', () => {
    const src = readSrc('apps/web/app/admin/orders/page.tsx');
    expect(src).toMatch(/export default async function/);
  });

  test('/admin/orders использует AdminPageShell + AdminTable + AdminPagination', () => {
    const src = readSrc('apps/web/app/admin/orders/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminTable/);
    expect(src).toMatch(/AdminPagination/);
    expect(src).toMatch(/AdminCard/);
  });

  test('/admin/orders переиспользует существующий list API', () => {
    const src = readSrc('apps/web/app/admin/orders/page.tsx');
    expect(src).toMatch(/listOrders/);
  });

  test('/admin/orders заголовок и подзаголовок соответствуют ТЗ', () => {
    const src = readSrc('apps/web/app/admin/orders/page.tsx');
    expect(src).toMatch(/title="Заказы"/);
    expect(src).toMatch(/Заказы в производстве и подготовке/);
  });
});

// ---------------------------------------------------------------------------
// 6. /admin/production-cost — новый admin-стиль
// ---------------------------------------------------------------------------

describe('Admin Analytics — /admin/production-cost', () => {
  test('/admin/production-cost/page.tsx существует', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/export default async function/);
  });

  test('/admin/production-cost использует AdminPageShell + AdminCard', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
  });

  test('/admin/production-cost переиспользует существующий cost API', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/getProductionCost/);
  });

  test('/admin/production-cost заголовок и подзаголовок по ТЗ', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    // Управленческий отчёт v2 (см. docs/production-cost-v2-recon.md):
    // заголовок и подзаголовок отражают разрезы по номенклатуре /
    // заказам / операциям / сотрудникам.
    expect(src).toMatch(/title="Себестоимость производства"/);
    expect(src).toMatch(
      /По номенклатуре, заказам, операциям и сотрудникам/,
    );
  });

  test('старая страница /production-cost не удалена', () => {
    const src = readSrc('apps/web/app/production-cost/page.tsx');
    expect(src).toMatch(/Себестоимость/);
  });

  test('старая страница /orders не удалена', () => {
    const src = readSrc('apps/web/app/orders/page.tsx');
    expect(src).toMatch(/Заказы/);
  });
});

// ---------------------------------------------------------------------------
// 7. Globals.css — креативные цвета
// ---------------------------------------------------------------------------

describe('Admin Analytics — globals.css color system', () => {
  test('содержит токены blue/green/orange/purple', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/--admin-blue:\s*#2563eb/);
    expect(css).toMatch(/--admin-blue-soft:\s*#dbeafe/);
    expect(css).toMatch(/--admin-green:\s*#16a34a/);
    expect(css).toMatch(/--admin-green-soft:\s*#dcfce7/);
    expect(css).toMatch(/--admin-orange:\s*#f97316/);
    expect(css).toMatch(/--admin-orange-soft:\s*#ffedd5/);
    expect(css).toMatch(/--admin-purple:\s*#7c3aed/);
    expect(css).toMatch(/--admin-purple-soft:\s*#ede9fe/);
  });

  test('содержит accent-классы admin-accent-*', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-accent-blue\s*\{/);
    expect(css).toMatch(/\.admin-accent-green\s*\{/);
    expect(css).toMatch(/\.admin-accent-orange\s*\{/);
    expect(css).toMatch(/\.admin-accent-purple\s*\{/);
  });

  test('содержит классы heatmap и KPI-карточек', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-heatmap\s*\{/);
    expect(css).toMatch(/\.admin-heatmap__chip\s*\{/);
    expect(css).toMatch(/\.admin-heatmap__chip--coral\s*\{/);
    expect(css).toMatch(/\.admin-kpi-grid\s*\{/);
    expect(css).toMatch(/\.admin-kpi-card\s*\{/);
  });

  test('блок Admin Analytics не вводит тёмных фонов', () => {
    const css = readSrc('apps/web/app/globals.css');
    const marker = 'Admin Analytics';
    const idx = css.indexOf(marker);
    expect(idx).toBeGreaterThan(0);
    const block = css.slice(idx);
    expect(block).not.toMatch(/background[^;]*#0f172a/i);
    expect(block).not.toMatch(/background[^;]*#1e293b/i);
    expect(block).not.toMatch(/background[^;]*#111827/i);
    expect(block).not.toMatch(/background[^;]*#000\b/);
  });

  test('prefers-reduced-motion охватывает heatmap/KPI', () => {
    const css = readSrc('apps/web/app/globals.css');
    const marker = 'Admin Analytics';
    const block = css.slice(css.indexOf(marker));
    expect(block).toMatch(/prefers-reduced-motion/);
  });
});

// ---------------------------------------------------------------------------
// 8. /master и /shopfloor/display не затронуты
// ---------------------------------------------------------------------------

describe('Admin Analytics — изолированность', () => {
  test('/master/page.tsx не использует admin-analytics или heatmap', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    expect(src).not.toMatch(/admin-analytics/);
    expect(src).not.toMatch(/AdminProductionHeatmap/);
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
  });

  test('/shopfloor/display/page.tsx не использует admin-analytics', () => {
    const src = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(src).not.toMatch(/admin-analytics/);
    expect(src).not.toMatch(/AdminProductionHeatmap/);
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
  });
});
