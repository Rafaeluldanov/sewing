/**
 * Admin Legacy Cleanup — source-level smoke (Admin UI 2.6).
 *
 * Источник задачи: «добить оставшиеся legacy-части Admin UI». Vitest
 * без jsdom — поэтому, как и в `admin-final-cleanup.smoke.test.ts`,
 * фиксируем регрессы прямо на уровне исходников: ни tech-card-form,
 * ни warehouses, ни display-screens, ни production-dashboard больше
 * не содержат `<Icon name=…>`, новые карточки заказа собираются
 * AdminPageShell + AdminCard, а sidebar содержит «Цеховой монитор».
 *
 * Что охраняем:
 *   1. Sidebar содержит пункт «Цеховой монитор» с href
 *      `/admin/display-screens` (управление мониторами в админке —
 *      сам TV-экран `/shopfloor/display` намеренно не висит в
 *      admin-навигации), и порядок Заказы → Цеховой монитор →
 *      Сотрудники сохранён.
 *   2. `/admin/orders/[id]/page.tsx` существует и собран на новых
 *      компонентах (AdminPageShell / AdminCard / AdminRouteSteps);
 *      кнопка «Открыть» на `/admin/orders` ведёт на
 *      `/admin/orders/[id]`. `AdminTechInfo` из карточки убран —
 *      см. polish-итерацию «убрать техническую информацию» в
 *      `apps/web/app/admin/orders/[id]/page.tsx`.
 *   3. tech-card-form, production-dashboard, display-screens
 *      create-form, warehouses create-form / edit-form /
 *      bulk-print-panel не содержат `<Icon name=…>` и используют
 *      `lucide-react`.
 *   4. `/shopfloor/display` остаётся изолированным (не импортирует
 *      admin layout / admin компоненты).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Sidebar — «Цеховой монитор»
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — sidebar «Цеховой монитор»', () => {
  test('AdminSidebar содержит пункт «Цеховой монитор» c href /admin/display-screens', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/Цеховой монитор/);
    // В админке этот пункт ведёт на управление мониторами,
    // а не на сам TV-экран /shopfloor/display.
    expect(src).toMatch(/href:\s*['"]\/admin\/display-screens['"]/);
    expect(src).not.toMatch(/href:\s*['"]\/shopfloor\/display['"]/);
  });

  test('AdminSidebar импортирует MonitorSmartphone из lucide-react', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/\bMonitorSmartphone\b/);
    expect(src).toMatch(/from ['"]lucide-react['"]/);
  });

  test('Порядок: Заказы выше «Цеховой монитор» выше Сотрудники', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    const orders = src.indexOf("label: 'Заказы'");
    const monitor = src.indexOf("label: 'Цеховой монитор'");
    const employees = src.indexOf("label: 'Сотрудники'");
    expect(orders).toBeGreaterThan(-1);
    expect(monitor).toBeGreaterThan(-1);
    expect(employees).toBeGreaterThan(-1);
    expect(orders).toBeLessThan(monitor);
    expect(monitor).toBeLessThan(employees);
  });
});

// ---------------------------------------------------------------------------
// 2. Order detail 2.0 — новый /admin/orders/[id]
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — order detail 2.0', () => {
  test('/admin/orders/[id]/page.tsx существует и использует новые компоненты', () => {
    const src = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    // Order management redesign: страница теперь строит карточку через
    // компактную `OrderManagementHeader` + `OrderActionCenter` + 5
    // тематических вкладок (`OrderViewTabs`). `AdminPageShell` всё
    // ещё на месте, deep-tech (`AdminTechInfo`) сознательно не
    // используется (никогда и не использовался).
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/OrderWorkspaceLayout/);
    expect(src).toMatch(/OrderManagementHeader/);
    expect(src).toMatch(/OrderActionCenter/);
    expect(src).toMatch(/OrderViewTabs/);
    expect(src).not.toMatch(/<AdminTechInfo\b/);
  });

  test('/admin/orders/[id]/page.tsx использует lucide-react и не содержит <Icon name=…>', () => {
    const src = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(src).toMatch(/from ['"]lucide-react['"]/);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('/admin/orders/[id]/page.tsx рендерит ровно 7 management-вкладок и не дублирует контент', () => {
    const src = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    // Order management redesign: вкладок ровно 7
    // (`production / passports / plan / operations / costSummary /
    // needs / history`) — это фиксируется через ветки рендера в
    // page.tsx. «Операции» вернулись после редизайна, потому что
    // без них менеджер терял профильный рабочий экран по операциям
    // заказа. «Сводно по заказу» (`costSummary`) — отдельная
    // финансовая вкладка для расходов / себестоимости / выручки /
    // прибыли / маржинальности; используем id `costSummary` (а не
    // `summary`), чтобы явно отделить её от старого generic-summary.
    for (const tab of [
      'production',
      'passports',
      'plan',
      'operations',
      'costSummary',
      'needs',
      'history',
    ]) {
      expect(src).toMatch(new RegExp(`activeTab === '${tab}'`));
    }
    // Старых вкладок («product» как «Обзор», старого «summary» как
    // generic-сводка, «logistics», «recommendations» как
    // самостоятельные таб-ветки, «materials» как отдельная вкладка)
    // на странице больше нет — их данные собраны в шапке + 7 новых
    // вкладках. Финансовая сводка теперь живёт под `costSummary`
    // (см. выше), а не под legacy-`summary`.
    expect(src).not.toMatch(/activeTab === 'product'/);
    expect(src).not.toMatch(/activeTab === 'summary'/);
    expect(src).not.toMatch(/activeTab === 'logistics'/);
    expect(src).not.toMatch(/activeTab === 'recommendations'/);
    expect(src).not.toMatch(/activeTab === 'materials'/);
  });

  test('/admin/orders/[id]/page.tsx больше не ведёт ссылку «Старая карточка»', () => {
    const src = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    // Order management redesign: ссылку «Старая карточка» из hero убрали.
    // Карточка должна быть единой управленческой точкой; legacy
    // `/orders/[id]` остаётся живым ради CUTTER_ASSISTANT-flow «Выпустить
    // паспорт» и доступен по прямой ссылке, но из admin-карточки на
    // него больше не ходим, чтобы не плодить «две одинаковые
    // карточки заказа в системе».
    expect(src).not.toMatch(/Старая карточка/);
  });

  test('/admin/orders/page.tsx ведёт «Открыть» на /admin/orders/[id]', () => {
    const src = readSrc('apps/web/app/admin/orders/page.tsx');
    expect(src).toMatch(/href=\{`\/admin\/orders\/\$\{o\.id\}`\}/);
    expect(src).not.toMatch(/href=\{`\/orders\/\$\{o\.id\}`\}/);
  });

  test('старая карточка /orders/[id]/page.tsx не удалена (нужна CUTTER_ASSISTANT)', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/OrderDetailPage|export default/);
  });
});

// ---------------------------------------------------------------------------
// 3. Tech-cards form cleanup
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — tech-cards form', () => {
  test('tech-card-form не содержит <Icon name=…> и не импортирует @/components/icon', () => {
    const src = readSrc('apps/web/app/admin/tech-cards/tech-card-form.tsx');
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('tech-card-form использует lucide-react и admin-form классы', () => {
    const src = readSrc('apps/web/app/admin/tech-cards/tech-card-form.tsx');
    expect(src).toMatch(/from ['"]lucide-react['"]/);
    expect(src).toMatch(/admin-form/);
    expect(src).toMatch(/admin-field/);
    expect(src).toMatch(/admin-actions-row/);
  });

  test('tech-cards/[id] и tech-cards/new — admin shell + admin card', () => {
    for (const file of [
      'apps/web/app/admin/tech-cards/new/page.tsx',
      'apps/web/app/admin/tech-cards/[id]/page.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).toMatch(/AdminPageShell/);
      expect(src).toMatch(/AdminCard/);
      expect(src).toMatch(/from ['"]lucide-react['"]/);
      expect(src).not.toMatch(/<Icon\s+name=/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Production-dashboard cleanup
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — production-dashboard', () => {
  test('production-dashboard не содержит icon="…" и <Icon name=…>', () => {
    const src = readSrc('apps/web/app/admin/production-dashboard/page.tsx');
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/icon="[a-z-]+"/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('production-dashboard использует lucide-react + AdminPageShell + AdminCard', () => {
    const src = readSrc('apps/web/app/admin/production-dashboard/page.tsx');
    expect(src).toMatch(/from ['"]lucide-react['"]/);
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
  });
});

// ---------------------------------------------------------------------------
// 5. Display-screens create-form
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — display-screens create-form', () => {
  test('display-screens create-form не содержит <Icon name=…>', () => {
    const src = readSrc('apps/web/app/admin/display-screens/create-form.tsx');
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('display-screens create-form использует lucide-react и admin-form', () => {
    const src = readSrc('apps/web/app/admin/display-screens/create-form.tsx');
    expect(src).toMatch(/from ['"]lucide-react['"]/);
    expect(src).toMatch(/admin-form/);
    expect(src).toMatch(/admin-field/);
  });
});

// ---------------------------------------------------------------------------
// 6. Warehouses forms
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — warehouses forms', () => {
  const FILES = [
    'apps/web/app/admin/warehouses/create-form.tsx',
    'apps/web/app/admin/warehouses/[id]/edit-form.tsx',
    'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
  ];

  test.each(FILES)('%s не содержит <Icon name=…>', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test.each(FILES)('%s использует lucide-react', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/from ['"]lucide-react['"]/);
  });

  test('warehouses create-form / edit-form используют admin-form классы', () => {
    for (const file of [
      'apps/web/app/admin/warehouses/create-form.tsx',
      'apps/web/app/admin/warehouses/[id]/edit-form.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).toMatch(/admin-form/);
      expect(src).toMatch(/admin-field/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. /shopfloor/display изолирован
// ---------------------------------------------------------------------------

describe('Admin Legacy Cleanup — /shopfloor/display изолирован', () => {
  test('/shopfloor/display/page.tsx не импортирует admin layout / admin компоненты', () => {
    const src = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
    expect(src).not.toMatch(/AdminPageShell/);
    expect(src).not.toMatch(/admin-sidebar/);
  });
});
