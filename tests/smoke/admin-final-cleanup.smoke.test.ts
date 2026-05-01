/**
 * Admin Final Cleanup — source-level smoke.
 *
 * Источник: post-task «Admin Final Cleanup» (см. чат + комментарии в
 * `apps/web/app/admin/*`). Тот же паттерн, что у других admin-smoke
 * (`admin-ui-polish`, `admin-ui-consistency`, `admin-analytics`):
 * полноценного React-рендера в проекте нет (vitest без jsdom),
 * поэтому фиксируем регрессы прямо в исходниках.
 *
 * Что охраняем:
 *   1. /admin — больше нет «Сегодня в производстве» / «Тепловая карта
 *      потока» / KPI-блока, нет импорта `AdminProductionHeatmap`,
 *      нет тяжёлых production-сводок.
 *   2. AdminSidebar содержит кнопку «Выйти» (LogOut + logoutAction)
 *      и в desktop, и в mobile drawer.
 *   3. /admin/routes/[id] и /admin/routes используют AdminRouteSteps,
 *      а сам компонент не светит operation.code.
 *   4. /admin/equipment/[id] использует compact chip-list для
 *      разрешённых операций (`admin-chip-list`, `admin-chip`).
 *   5. /admin/printers/[id] — компактные карточки (Основное /
 *      Подключение / Тест печати / Очередь) + AdminTechInfo, без
 *      длинных описаний и без `<Icon name=…>`.
 *   6. /admin/employees/[id] содержит карточки «Основная информация»,
 *      «Доступ», «QR сотрудника» и AdminTechInfo (4 блока).
 *   7. В detail-страницах admin нет DetailPageHeader / page-shell
 *      legacy.
 *   8. /master и /shopfloor/display не затронуты.
 *   9. globals.css содержит классы для нового UI (admin-chip-list,
 *      admin-chip, admin-route-step, admin-sidebar__logout).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. /admin overview cleanup
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — /admin overview', () => {
  test('/admin/page.tsx не содержит «Сегодня в производстве»', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).not.toMatch(/Сегодня в производстве/);
  });

  test('/admin/page.tsx не содержит «Тепловая карта потока»', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).not.toMatch(/Тепловая карта потока/);
    expect(src).not.toMatch(/Тепловая карта/);
  });

  test('/admin/page.tsx не импортирует AdminProductionHeatmap', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).not.toMatch(/AdminProductionHeatmap/);
    expect(src).not.toMatch(/admin-production-heatmap/);
  });

  test('/admin/page.tsx не подтягивает heavy production summaries', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).not.toMatch(/getShopfloorDisplaySummary/);
    expect(src).not.toMatch(/listOpenMasterCalls/);
    expect(src).not.toMatch(/buildAdminKpis/);
    expect(src).not.toMatch(/buildProductionHeatmap/);
  });

  test('/admin/page.tsx остаётся dashboard разделов (карточки и счётчики)', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).toMatch(/admin-home-grid/);
    expect(src).toMatch(/admin-home-card/);
    expect(src).toMatch(/safeCount/);
  });
});

// ---------------------------------------------------------------------------
// 2. Sidebar — кнопка «Выйти»
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — sidebar logout', () => {
  test('AdminSidebar импортирует LogOut и logoutAction', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/\bLogOut\b/);
    expect(src).toMatch(/logoutAction/);
    expect(src).toMatch(/from ['"]lucide-react['"]/);
  });

  test('AdminSidebar содержит кнопку «Выйти» (форма + кнопка)', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/Выйти/);
    expect(src).toMatch(/<form action=\{logoutAction\}/);
    expect(src).toMatch(/admin-sidebar__logout/);
  });

  test('AdminSidebarMobileToggle тоже содержит кнопку «Выйти»', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/AdminSidebarMobileToggle/);
    expect(src).toMatch(/admin-sidebar-mobile__footer/);
  });
});

// ---------------------------------------------------------------------------
// 3. Routes — компактная цепочка операций
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — route steps', () => {
  test('AdminRouteSteps реэкспортируется барелл-индексом', () => {
    const src = readSrc('apps/web/components/admin/index.ts');
    expect(src).toMatch(/AdminRouteSteps/);
    expect(src).toMatch(/AdminRouteStep/);
  });

  test('AdminRouteSteps не показывает operation.code', () => {
    const src = readSrc('apps/web/components/admin/admin-route-steps.tsx');
    expect(src).not.toMatch(/operationCode/);
    expect(src).not.toMatch(/\bcode\b\s*:\s*string/);
    expect(src).toMatch(/admin-route-step__name/);
    expect(src).toMatch(/admin-route-step__num/);
  });

  test('/admin/routes/[id] использует AdminRouteSteps в карточке «Операции маршрута»', () => {
    const src = readSrc('apps/web/app/admin/routes/[id]/page.tsx');
    expect(src).toMatch(/AdminRouteSteps/);
    expect(src).toMatch(/title="Операции маршрута"/);
  });

  test('/admin/routes (список) тоже использует AdminRouteSteps', () => {
    const src = readSrc('apps/web/app/admin/routes/page.tsx');
    expect(src).toMatch(/AdminRouteSteps/);
    expect(src).toMatch(/maxVisible=\{4\}/);
  });
});

// ---------------------------------------------------------------------------
// 4. Equipment — compact chip list
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — equipment chip list', () => {
  test('EquipmentOperationsEditor использует admin-chip-list', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/edit-form.tsx');
    expect(src).toMatch(/admin-chip-list/);
    expect(src).toMatch(/admin-chip__icon/);
    expect(src).toMatch(/admin-chip__remove/);
    expect(src).toMatch(/admin-chip-add__select/);
  });

  test('EquipmentOperationsEditor не выводит operation.code в чипах', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/edit-form.tsx');
    expect(src).not.toMatch(/op\.code/);
  });

  test('/admin/equipment/[id] не содержит длинных описаний', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/page.tsx');
    expect(src).not.toMatch(/Здесь вы можете/);
    expect(src).not.toMatch(/Управляйте всеми/);
    expect(src).not.toMatch(/Настройте список разрешённых операций/);
  });
});

// ---------------------------------------------------------------------------
// 5. Printers — compact detail
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — printers detail', () => {
  test('/admin/printers/[id] использует AdminCard и AdminTechInfo', () => {
    const src = readSrc('apps/web/app/admin/printers/[id]/page.tsx');
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminTechInfo/);
    expect(src).toMatch(/AdminPageShell/);
  });

  test('/admin/printers/[id] не содержит DetailPageHeader / page-shell legacy', () => {
    const src = readSrc('apps/web/app/admin/printers/[id]/page.tsx');
    expect(src).not.toMatch(/DetailPageHeader/);
    expect(src).not.toMatch(/page-shell/);
  });

  test('/admin/printers/[id] и его формы используют lucide, без <Icon name=…>', () => {
    for (const file of [
      'apps/web/app/admin/printers/[id]/page.tsx',
      'apps/web/app/admin/printers/[id]/edit-form.tsx',
      'apps/web/app/admin/printers/[id]/test-print-form.tsx',
      'apps/web/app/admin/printers/[id]/delete-form.tsx',
      'apps/web/app/admin/printers/[id]/pairing-panel.tsx',
      'apps/web/app/admin/printers/[id]/windows-printer-form.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).not.toMatch(/<Icon\s+name=/);
      expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
    }
  });

  test('/admin/printers/[id] карточки соответствуют ТЗ (Основное / Подключение / Тест печати / Очередь)', () => {
    const src = readSrc('apps/web/app/admin/printers/[id]/page.tsx');
    expect(src).toMatch(/title="Основное"/);
    expect(src).toMatch(/title="Подключение"/);
    expect(src).toMatch(/title="Тест печати"/);
    expect(src).toMatch(/title="Очередь"/);
  });
});

// ---------------------------------------------------------------------------
// 6. Employees — 4 cards
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — employees detail', () => {
  test('/admin/employees/[id] содержит 4 карточки', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/title="Основная информация"/);
    expect(src).toMatch(/title="Доступ"/);
    expect(src).toMatch(/title="QR сотрудника"/);
    expect(src).toMatch(/AdminTechInfo/);
  });

  test('/admin/employees/[id] не показывает PIN в открытом виде', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/PIN/);
    expect(src).toMatch(/скрыт/);
  });
});

// ---------------------------------------------------------------------------
// 7. Operations — compact detail
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — operations detail', () => {
  // Полный layout-контракт страницы (двухколоночный grid, экономика в
  // правой колонке, отсутствие AdminTechInfo и дубликата экономики ниже)
  // зафиксирован в `tests/smoke/operation-economics.smoke.test.ts`.
  // Здесь оставляем только базовые проверки админ-обвязки.

  test('/admin/operations/[id] использует AdminPageShell + AdminCard', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/page.tsx');
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminPageShell/);
  });

  test('/admin/operations/[id] больше не показывает «Техническая информация»', () => {
    // Блок убран из этой страницы (мало пользы) — его место заняла
    // карточка «Экономика операции». Сам компонент `AdminTechInfo`
    // остаётся в проекте и используется на других detail-страницах.
    const src = readSrc('apps/web/app/admin/operations/[id]/page.tsx');
    expect(src).not.toMatch(/AdminTechInfo/);
    expect(src).not.toMatch(/Техническая информация/);
  });
});

// ---------------------------------------------------------------------------
// 8. Detail-страницы не используют DetailPageHeader / page-shell legacy
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — без legacy паттернов в detail-pages', () => {
  const DETAILS = [
    'apps/web/app/admin/employees/[id]/page.tsx',
    'apps/web/app/admin/equipment/[id]/page.tsx',
    'apps/web/app/admin/operations/[id]/page.tsx',
    'apps/web/app/admin/printers/[id]/page.tsx',
    'apps/web/app/admin/routes/[id]/page.tsx',
  ];

  test.each(DETAILS)('%s не содержит DetailPageHeader / page-shell', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/DetailPageHeader/);
    expect(src).not.toMatch(/page-shell\b/);
  });

  test.each(DETAILS)('%s не использует <Icon name=…>', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });
});

// ---------------------------------------------------------------------------
// 9. /master и /shopfloor/display не затронуты
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — изолированность', () => {
  test('/master/page.tsx не использует admin-компоненты и admin-chip', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
    expect(src).not.toMatch(/admin-chip-list/);
    expect(src).not.toMatch(/AdminRouteSteps/);
  });

  test('/shopfloor/display/page.tsx не использует admin-компоненты', () => {
    const src = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
    expect(src).not.toMatch(/AdminRouteSteps/);
  });
});

// ---------------------------------------------------------------------------
// 10. globals.css — компактные классы Admin UI 2.6
// ---------------------------------------------------------------------------

describe('Admin Final Cleanup — globals.css классы', () => {
  test('содержит admin-chip и admin-chip-list', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-chip-list\s*\{/);
    expect(css).toMatch(/\.admin-chip\s*\{/);
    expect(css).toMatch(/\.admin-chip__icon\s*\{/);
    expect(css).toMatch(/\.admin-chip__remove\s*\{/);
  });

  test('содержит admin-route-step* классы', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-route-steps\s*\{/);
    expect(css).toMatch(/\.admin-route-step\s*\{/);
    expect(css).toMatch(/\.admin-route-step__num\s*\{/);
    expect(css).toMatch(/\.admin-route-step__name\s*\{/);
  });

  test('содержит admin-sidebar__logout и admin-sidebar__footer', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-sidebar__footer\s*\{/);
    expect(css).toMatch(/\.admin-sidebar__logout\s*\{/);
  });

  test('содержит compact list / metric / field row классы', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-compact-list\s*\{/);
    expect(css).toMatch(/\.admin-metric-row\s*\{/);
    expect(css).toMatch(/\.admin-field-list\s*\{/);
    expect(css).toMatch(/\.admin-field-row\s*\{/);
  });
});
