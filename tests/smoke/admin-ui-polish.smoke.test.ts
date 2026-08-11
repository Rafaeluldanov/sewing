/**
 * Smoke-тесты Admin UI Polish.
 *
 * Зеркальный паттерн остальных admin-smoke-тестов (`employees-admin`,
 * `equipment-admin`, …): полноценного React-рендера в проекте нет
 * (vitest + Node, без jsdom), поэтому фиксируем регрессы прямо в
 * исходниках. Цель — поймать «откат полировки», а не проверять
 * runtime-поведение:
 *
 *   1. Admin-списки больше не показывают технические `equipment.code`
 *      / `operation.code` / `routeTemplate.code` в таблицах.
 *   2. Все полированные страницы используют `lucide-react`, а не
 *      внутренний `<Icon name=…>` компонент.
 *   3. Используются label-helpers из `lib/admin-labels.ts`.
 *   4. `/admin` теперь самостоятельный dashboard, а не редирект на
 *      `/admin/overview`.
 *   5. Общие admin-компоненты (`AdminCard`, `AdminTable`,
 *      `AdminStatusBadge`, `AdminEmptyState`, `AdminSectionHeader`,
 *      `AdminTechInfo`) реально подключены к страницам и/или
 *      экспортируются барелл-индексом.
 *   6. В новых стилях нет тёмных фонов (background:#0f172a и т.п.).
 *   7. `/master` и `/shopfloor/display` не затронуты — токены
 *      остались прежними, никаких `admin-shell` там нет.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Технические коды ушли из списков
// ---------------------------------------------------------------------------

describe('Admin UI Polish — списки без технических кодов', () => {
  test('/admin/equipment не показывает eq.code в таблице', () => {
    const src = readSrc('apps/web/app/admin/equipment/page.tsx');
    // Раньше колонка «Код» рендерилась как <code>{eq.code}</code>.
    expect(src).not.toMatch(/<code>\{eq\.code\}<\/code>/);
    expect(src).not.toMatch(/eq\.code/);
    // А название и displayNumber должны остаться — это «человеческие»
    // данные.
    expect(src).toMatch(/eq\.name/);
    expect(src).toMatch(/eq\.displayNumber/);
  });

  test('/admin/operations не показывает op.code в таблице', () => {
    const src = readSrc('apps/web/app/admin/operations/page.tsx');
    expect(src).not.toMatch(/<code>\{op\.code\}<\/code>/);
    expect(src).not.toMatch(/op\.code/);
    expect(src).toMatch(/op\.name/);
  });

  test('/admin/routes не показывает tpl.code в таблице', () => {
    const src = readSrc('apps/web/app/admin/routes/page.tsx');
    expect(src).not.toMatch(/<code>\{tpl\.code\}<\/code>/);
    expect(src).not.toMatch(/tpl\.code/);
    expect(src).toMatch(/tpl\.name/);
  });


  test('/admin/warehouses не показывает w.code в таблице', () => {
    const src = readSrc('apps/web/app/admin/warehouses/page.tsx');
    expect(src).not.toMatch(/<code>\{w\.code\}<\/code>/);
    expect(src).not.toMatch(/w\.code/);
    expect(src).toMatch(/w\.name/);
  });

  test('/admin/employees не показывает логин как <code>', () => {
    const src = readSrc('apps/web/app/admin/employees/page.tsx');
    // Логин — техническое поле, в карточке остаётся, в списке убрали.
    expect(src).not.toMatch(/<code>\{e\.login\}<\/code>/);
    expect(src).toMatch(/e\.fullName/);
  });

  test('/admin/printers не выводит equipmentCode рядом с названием', () => {
    const src = readSrc('apps/web/app/admin/printers/page.tsx');
    expect(src).not.toMatch(/p\.equipmentCode/);
    expect(src).toMatch(/p\.equipmentName/);
  });
});

// ---------------------------------------------------------------------------
// 2. lucide-react используется вместо локального <Icon name=…>
// ---------------------------------------------------------------------------

describe('Admin UI Polish — иконки на lucide-react', () => {
  const POLISHED_PAGES = [
    'apps/web/app/admin/page.tsx',
    'apps/web/app/admin/employees/page.tsx',
    'apps/web/app/admin/equipment/page.tsx',
    'apps/web/app/admin/operations/page.tsx',
    'apps/web/app/admin/routes/page.tsx',
    'apps/web/app/admin/warehouses/page.tsx',
    'apps/web/app/admin/printers/page.tsx',
  ];

  test.each(POLISHED_PAGES)('%s импортирует из lucide-react', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/from ['"]lucide-react['"]/);
  });

  test.each(POLISHED_PAGES)('%s не использует локальный <Icon name=…>', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('/admin (dashboard) использует основные lucide-иконки разделов', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    for (const name of [
      'Users',
      'Factory',
      'Scissors',
      'Activity',
      'ClipboardList',
      'Warehouse',
      'Printer',
      'Search',
    ]) {
      expect(src).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  test('strokeWidth у lucide-иконок задан в «1.6» (см. ТЗ)', () => {
    for (const file of POLISHED_PAGES) {
      const src = readSrc(file);
      expect(src).toMatch(/strokeWidth=\{1\.6\}/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Label helpers подключены и используются
// ---------------------------------------------------------------------------

describe('Admin UI Polish — label helpers', () => {
  test('lib/admin-labels экспортирует все 4 обязательные функции', () => {
    const src = readSrc('apps/web/lib/admin-labels.ts');
    expect(src).toMatch(/export function formatRole\(/);
    expect(src).toMatch(/export function formatOperationCategory\(/);
    expect(src).toMatch(/export function formatEquipmentKind\(/);
    expect(src).toMatch(/export function formatStatus\(/);
  });

  test('formatRole превращает SEAMSTRESS → Швея', () => {
    // Справочник ролей (28.07.2026): названия ролей переехали в
    // `@sewing/shared/app-roles` (`SYSTEM_ROLE_DEFAULTS`) — оттуда их
    // берут и сид миграции, и fallback фронта. `admin-labels.ts` теперь
    // только собирает словарь и подмешивает кастомные роли из БД.
    const shared = readSrc('packages/shared/src/app-roles.ts');
    expect(shared).toMatch(/name:\s*'Швея'/);
    expect(shared).toMatch(/name:\s*'Мастер цеха'/);
    expect(shared).toMatch(/name:\s*'ВТО'/);
    expect(shared).toMatch(/name:\s*'ОТК'/);
    expect(shared).toMatch(/name:\s*'Упаковка'/);

    const src = readSrc('apps/web/lib/admin-labels.ts');
    expect(src).toContain('export function formatRole');
    expect(src).toContain('export function buildRoleLabels');
    expect(src).toContain('SYSTEM_ROLE_LABELS');
    // Лейблы категорий операций теперь живут в shared (см. ТЗ
    // «Единая группировка»), `admin-labels.ts` их только реэкспортирует
    // через `getOperationCategoryLabel`. Защищаем источник истины.
    const sharedOps = readSrc('packages/shared/src/operations.ts');
    expect(sharedOps).toMatch(/CUTTING:\s*'Раскрой'/);
  });

  test('страница /admin/employees использует formatRole', () => {
    const src = readSrc('apps/web/app/admin/employees/page.tsx');
    expect(src).toMatch(/formatRole/);
    expect(src).toMatch(/from ['"]@\/lib\/admin-labels['"]/);
  });

  test('страница /admin/operations подписывает категории через shared-helper', () => {
    const src = readSrc('apps/web/app/admin/operations/page.tsx');
    // С переходом на группировку (см. ТЗ «Единая группировка») лейблы
    // секций берутся из `groupOperationsByCategory` — поле `group.label`
    // уже содержит человекочитаемый заголовок. Локального дубликата
    // словаря категорий быть не должно.
    expect(src).toMatch(/groupOperationsByCategory/);
    expect(src).not.toMatch(/CATEGORY_LABEL\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. /admin теперь dashboard
// ---------------------------------------------------------------------------

describe('Admin UI Polish — /admin как dashboard', () => {
  test('/admin/page.tsx существует и рендерит карточки разделов', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).toMatch(/AdminHomePage/);
    expect(src).toMatch(/admin-home-grid/);
    expect(src).toMatch(/admin-home-card/);
    // На карточках должны быть иконка + название + описание + CTA.
    expect(src).toMatch(/admin-home-card__icon/);
    expect(src).toMatch(/admin-home-card__title/);
    expect(src).toMatch(/admin-home-card__desc/);
    expect(src).toMatch(/admin-home-card__cta/);
  });

  test('/admin/page.tsx ссылается на все ключевые разделы', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    // Заказы и Себестоимость теперь живут под /admin/* (Admin Analytics).
    for (const href of [
      '/admin/employees',
      '/admin/equipment',
      '/admin/operations',
      '/admin/routes',
      '/admin/warehouses',
      '/admin/printers',
      '/admin/diagnostics',
      '/admin/orders',
    ]) {
      expect(src).toMatch(new RegExp(`href:\\s*['"]${href.replace(/\//g, '\\/')}['"]`));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Общие компоненты подключены
// ---------------------------------------------------------------------------

describe('Admin UI Polish — общие компоненты', () => {
  test('барелл @/components/admin реэкспортирует основные компоненты', () => {
    const src = readSrc('apps/web/components/admin/index.ts');
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminSectionHeader/);
    expect(src).toMatch(/AdminStatusBadge/);
    expect(src).toMatch(/AdminEmptyState/);
    expect(src).toMatch(/AdminTable/);
    expect(src).toMatch(/AdminTechInfo/);
  });

  test('admin-card компонент существует и рендерит .admin-card', () => {
    const src = readSrc('apps/web/components/admin/admin-card.tsx');
    expect(src).toMatch(/'admin-card'/);
    expect(src).toMatch(/admin-card--clickable/);
  });

  test('AdminTable / AdminEmptyState / AdminStatusBadge подключены к /admin/employees', () => {
    // /admin/employees остался на классическом AdminTable (паджинация).
    // /admin/equipment и /admin/operations перешли на compact grouped
    // table — у них собственный inline `<table>` с group-row внутри
    // общего каркаса списка (см. ТЗ «compact grouped-table layout»),
    // и они проверяются ниже отдельным блоком на compact CSS classes.
    const employees = readSrc('apps/web/app/admin/employees/page.tsx');
    expect(employees).toMatch(/AdminTable/);
    expect(employees).toMatch(/AdminStatusBadge/);
    expect(employees).toMatch(/AdminEmptyState/);
    expect(employees).toMatch(/from ['"]@\/components\/admin['"]/);
  });

  test('compact grouped table подключён к /admin/equipment и /admin/operations', () => {
    const equipment = readSrc('apps/web/app/admin/equipment/page.tsx');
    const operations = readSrc('apps/web/app/admin/operations/page.tsx');
    for (const src of [equipment, operations]) {
      // EmptyState и StatusBadge остаются — данные те же, изменился
      // только layout таблицы.
      expect(src).toMatch(/AdminStatusBadge/);
      expect(src).toMatch(/AdminEmptyState/);
      expect(src).toMatch(/from ['"]@\/components\/admin['"]/);
      // Compact CSS-классы — основной контракт нового layout.
      expect(src).toMatch(/admin-compact-grouped-table/);
      expect(src).toMatch(/admin-compact-group-row/);
      // Таблица живёт в такой же рамке, как AdminTable на остальных
      // списках (`.admin-table-wrap`), плюс горизонтальный скролл.
      expect(src).toMatch(
        /className="admin-table-wrap admin-compact-table-wrap"/,
      );
      // Старая «карточка на категорию» с собственным header'ом ушла —
      // защищаем от регресса.
      expect(src).not.toMatch(/CategorySection/);
      // И отдельная «компактная карточка» с padding: 0 тоже ушла:
      // каркас списка теперь общий для всей админки (см. /admin/routes).
      expect(src).not.toMatch(/className="admin-compact-grouped-card/);
    }
    // У equipment-страницы chips категорий имеют отдельный класс,
    // защищаем источник истины (см. ТЗ §5).
    expect(equipment).toMatch(/admin-equipment-category-chips/);
  });

  test('globals.css содержит compact grouped-table классы', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-compact-table-wrap\s*\{/);
    expect(css).toMatch(/\.admin-compact-grouped-table\s*\{/);
    expect(css).toMatch(/\.admin-compact-group-row\b/);
    expect(css).toMatch(/\.admin-equipment-category-chips\s*\{/);
    expect(css).toMatch(/\.admin-equipment-category-chip\s*\{/);
    // На узких экранах оставляем horizontal scroll, а не «карточки» —
    // colspan group-row иначе ломается. Защищаем минимальную ширину.
    expect(css).toMatch(/\.admin-operations-compact-table\s*\{[\s\S]*?min-width:\s*760px/);
    expect(css).toMatch(/\.admin-equipment-compact-table\s*\{[\s\S]*?min-width:\s*860px/);
  });

  test('locallne category labels не вернулись в /admin/operations и /admin/equipment', () => {
    for (const file of [
      'apps/web/app/admin/operations/page.tsx',
      'apps/web/app/admin/equipment/page.tsx',
    ]) {
      const src = readSrc(file);
      // Локального словаря лейблов категорий быть не должно — лейблы
      // живут в shared (`OPERATION_CATEGORY_LABELS` /
      // `getOperationCategoryLabel`).
      expect(src).not.toMatch(/CATEGORY_LABEL\b/);
      expect(src).not.toMatch(
        /OPERATION_CATEGORY_LABELS\s*:\s*Record<OperationCategory/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Светлая тема — без тёмных фонов в новом блоке стилей
// ---------------------------------------------------------------------------

describe('Admin UI Polish — без тёмных блоков', () => {
  test('блок Admin UI Polish в globals.css не вводит тёмных background', () => {
    const css = readSrc('apps/web/app/globals.css');
    const marker = 'Admin UI Polish';
    const idx = css.indexOf(marker);
    expect(idx).toBeGreaterThan(0);
    const polishBlock = css.slice(idx);

    // Никаких background: #0f172a / #1e293b / #111827 в новом блоке.
    expect(polishBlock).not.toMatch(/background[^;]*#0f172a/i);
    expect(polishBlock).not.toMatch(/background[^;]*#1e293b/i);
    expect(polishBlock).not.toMatch(/background[^;]*#111827/i);
    expect(polishBlock).not.toMatch(/background[^;]*#000\b/);

    // Зато светлые токены — обязательны.
    expect(polishBlock).toMatch(/--admin-bg:\s*#f8fafc/);
    expect(polishBlock).toMatch(/--admin-surface:\s*#ffffff/);
    expect(polishBlock).toMatch(/--admin-border:\s*#e2e8f0/);
  });
});

// ---------------------------------------------------------------------------
// 7. /master и /shopfloor/display не затронуты
// ---------------------------------------------------------------------------

describe('Admin UI Polish — изолированность', () => {
  test('/master/page.tsx не использует admin-shell и lucide-react из админки', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    expect(src).not.toMatch(/admin-shell/);
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
  });

  test('/shopfloor/display/page.tsx не использует admin-shell и admin-компоненты', () => {
    const src = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(src).not.toMatch(/admin-shell/);
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
  });
});

// ---------------------------------------------------------------------------
// 8. Admin UI 2.0 — sidebar
// ---------------------------------------------------------------------------

describe('Admin UI 2.0 — sidebar', () => {
  test('AdminSidebar компонент существует и использует lucide-react', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/export function AdminSidebar/);
    expect(src).toMatch(/export function AdminSidebarMobileToggle/);
    expect(src).toMatch(/from ['"]lucide-react['"]/);
    // Иконки строго из ТЗ.
    for (const icon of [
      'Home',
      'Users',
      'Factory',
      'Scissors',
      'Activity',
      'ClipboardList',
      'Warehouse',
      'Printer',
      'Search',
      'Package',
      'Box',
    ]) {
      expect(src).toMatch(new RegExp(`\\b${icon}\\b`));
    }
    // Активный пункт подсвечивается классом-модификатором.
    expect(src).toMatch(/admin-sidebar__link--active/);
    // Все 11 разделов из ТЗ в боковом меню. После Admin Analytics
    // Заказы и Себестоимость переехали под `/admin/*`, чтобы открываться
    // в admin shell, а не в legacy layout.
    for (const href of [
      '/admin',
      '/admin/employees',
      '/admin/equipment',
      '/admin/operations',
      '/admin/routes',
      '/admin/warehouses',
      '/admin/printers',
      '/admin/diagnostics',
      '/admin/orders',
      '/admin/production-cost',
    ]) {
      expect(src).toMatch(new RegExp(`href:\\s*['"]${href.replace(/\//g, '\\/')}['"]`));
    }
  });

  test('admin/layout.tsx подключает AdminSidebar', () => {
    const src = readSrc('apps/web/app/admin/layout.tsx');
    expect(src).toMatch(/AdminSidebar/);
    expect(src).toMatch(/admin-layout/);
    expect(src).toMatch(/from ['"]@\/components\/admin-sidebar['"]/);
  });

  test('globals.css содержит токены и блок Admin UI 2.0 sidebar', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Ширина sidebar-колонки 240 px (см. ТЗ).
    expect(css).toMatch(/grid-template-columns:\s*240px/);
    // Активный пункт подсвечивается мягким primary-фоном.
    expect(css).toMatch(/\.admin-sidebar__link--active[\s\S]*?--admin-primary-soft/);
    // Override `.app-main` для админки — снимаем max-width 1280px.
    expect(css).toMatch(/body:has\(\.admin-layout\)\s*\.app-main/);
    // На ≤ 900 px sidebar скрывается.
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.admin-sidebar\s*\{\s*display:\s*none/);
  });
});

// ---------------------------------------------------------------------------
// 9. Admin UI 2.0 — dashboard со счётчиками
// ---------------------------------------------------------------------------

describe('Admin UI 2.0 — dashboard со счётчиками', () => {
  test('/admin/page.tsx параллельно подтягивает счётчики разделов', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).toMatch(/Promise\.all/);
    expect(src).toMatch(/listEmployees/);
    expect(src).toMatch(/listEquipment/);
    expect(src).toMatch(/listOperations/);
    expect(src).toMatch(/listRouteTemplates/);
    expect(src).toMatch(/listWarehouses/);
    expect(src).toMatch(/listPrinters/);
    // Карточка статистики и склонение по ru-RU.
    expect(src).toMatch(/admin-home-card__stat/);
    expect(src).toMatch(/Intl\.PluralRules/);
  });

  test('/admin/page.tsx ссылается на admin-обёртку себестоимости', () => {
    const src = readSrc('apps/web/app/admin/page.tsx');
    expect(src).toMatch(/href:\s*['"]\/admin\/production-cost['"]/);
  });
});

// ---------------------------------------------------------------------------
// 10. Admin UI 2.0 — detail-страница оборудования по новому стандарту
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — detail-страница оборудования', () => {
  test('/admin/equipment/[id] использует AdminPageShell + AdminCard + AdminTechInfo', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminSectionHeader/);
    expect(src).toMatch(/AdminTechInfo/);
    expect(src).toMatch(/AdminStatusBadge/);
    // Старый DetailPageHeader / page-shell больше не нужен.
    expect(src).not.toMatch(/DetailPageHeader/);
    expect(src).not.toMatch(/page-shell/);
    // Иконки только lucide.
    expect(src).toMatch(/from ['"]lucide-react['"]/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });
});
