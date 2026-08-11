/**
 * Admin UI 2.5 — consistency smoke-tests.
 *
 * Тесты source-level (паттерн всех остальных admin-smoke):
 * проверяем, что все `/admin/*` страницы приведены к единому
 * стандарту (AdminPageShell + AdminCard + AdminTechInfo + lucide-react),
 * пагинация подключена там, где списки могут расти, верхний
 * `AppHeader` отключён внутри `/admin`, и `/master` /
 * `/shopfloor/display` остались нетронутыми.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. AppHeader не рендерится для /admin
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — без верхнего header', () => {
  test('AppHeader делает return null для /admin/*', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    expect(src).toMatch(/usePathname/);
    expect(src).toMatch(/\/admin/);
    // Должна быть быстрая ветка с return null для admin-путей.
    expect(src).toMatch(/isAdminPath/);
    expect(src).toMatch(/return null/);
  });

  test('globals.css скрывает .app-header при наличии .admin-layout', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/body:has\(\.admin-layout\)\s*\.app-header/);
  });
});

// ---------------------------------------------------------------------------
// 2. Detail pages → AdminPageShell + AdminCard (+ AdminTechInfo на большинстве)
// ---------------------------------------------------------------------------
//
// `/admin/operations/[id]` намеренно не показывает `AdminTechInfo`:
// блок «Техническая информация» на этой странице был удалён, его место
// в правой колонке занимает компактная карточка «Экономика операции»
// (см. `tests/smoke/operation-economics.smoke.test.ts`). Сам компонент
// `AdminTechInfo` остаётся в проекте и используется на остальных
// detail-страницах.

const DETAIL_PAGES = [
  'apps/web/app/admin/employees/[id]/page.tsx',
  'apps/web/app/admin/equipment/[id]/page.tsx',
  'apps/web/app/admin/operations/[id]/page.tsx',
  'apps/web/app/admin/routes/[id]/page.tsx',
  'apps/web/app/admin/warehouses/[id]/page.tsx',
  'apps/web/app/admin/printers/[id]/page.tsx',
];

const DETAIL_PAGES_WITH_TECH_INFO = DETAIL_PAGES.filter(
  (file) => file !== 'apps/web/app/admin/operations/[id]/page.tsx',
);

describe('Admin UI 2.5 — detail pages migrated', () => {
  test.each(DETAIL_PAGES)('%s использует AdminPageShell', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/AdminPageShell/);
  });

  test.each(DETAIL_PAGES)('%s использует AdminCard', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/AdminCard/);
  });

  test.each(DETAIL_PAGES_WITH_TECH_INFO)('%s использует AdminTechInfo', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/AdminTechInfo/);
  });

  test('apps/web/app/admin/operations/[id]/page.tsx не использует AdminTechInfo (вместо него — «Экономика операции»)', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/page.tsx');
    expect(src).not.toMatch(/AdminTechInfo/);
    expect(src).toMatch(/Экономика операции/);
  });

  test.each(DETAIL_PAGES)('%s не использует DetailPageHeader', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/DetailPageHeader/);
  });

  test.each(DETAIL_PAGES)('%s не использует старый page-shell', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/className=['"]page-shell['"]/);
  });

  test.each(DETAIL_PAGES)('%s импортирует из lucide-react', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/from ['"]lucide-react['"]/);
  });

  test.each(DETAIL_PAGES)('%s не использует старый <Icon name=…>', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });
});

// ---------------------------------------------------------------------------
// 3. Employees/[id] — особо важно: 4 карточки
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — карточка сотрудника', () => {
  test('/admin/employees/[id] содержит ключевые карточки', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/Основная информация/);
    expect(src).toMatch(/Доступ/);
    expect(src).toMatch(/QR сотрудника/);
    // Техническая информация — collapsible AdminTechInfo.
    expect(src).toMatch(/AdminTechInfo/);
  });

  test('двухколоночный layout на desktop', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/admin-grid-2/);
  });
});

// ---------------------------------------------------------------------------
// 4. List pages → AdminPageShell + AdminPagination
// ---------------------------------------------------------------------------

const LIST_PAGES = [
  'apps/web/app/admin/employees/page.tsx',
  'apps/web/app/admin/equipment/page.tsx',
  'apps/web/app/admin/operations/page.tsx',
  'apps/web/app/admin/routes/page.tsx',
  'apps/web/app/admin/warehouses/page.tsx',
  'apps/web/app/admin/printers/page.tsx',
];

/**
 * Страницы, которые перешли на группировку по категории операций
 * (см. ТЗ «Единая группировка»). Им пагинация не нужна — менеджеру
 * удобнее видеть весь каталог, разбитый на компактные секции:
 * Раскрой → Пошив → ОТК → ВТО → Упаковка.
 *
 * После compact-redesign (см. ТЗ «compact grouped-table layout»)
 * группировка живёт внутри одной общей карточки с единым table
 * header'ом, а не внутри `CategorySection` на каждую категорию.
 */
const GROUPED_LIST_PAGES = new Set<string>([
  'apps/web/app/admin/equipment/page.tsx',
  'apps/web/app/admin/operations/page.tsx',
]);
const PAGINATED_LIST_PAGES = LIST_PAGES.filter(
  (p) => !GROUPED_LIST_PAGES.has(p),
);

describe('Admin UI 2.5 — list pages', () => {
  test.each(LIST_PAGES)('%s использует AdminPageShell', (file) => {
    const src = readSrc(file);
    expect(src).toMatch(/AdminPageShell/);
  });

  test.each(PAGINATED_LIST_PAGES)(
    '%s использует AdminPagination',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/AdminPagination/);
      expect(src).toMatch(/paginate\(/);
    },
  );

  // Страницы с группировкой по категориям рендерят compact grouped
  // table вместо пагинации: один table header, категории внутри tbody
  // как тонкие group-row.
  test.each([...GROUPED_LIST_PAGES])(
    '%s использует compact grouped-table layout (группировка вместо пагинации)',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/admin-compact-grouped-table/);
      expect(src).toMatch(/admin-compact-group-row/);
      // Старая «карточка на каждую категорию» через CategorySection
      // здесь больше не используется — она раздувала страницу.
      expect(src).not.toMatch(/CategorySection/);
      // Один thead и один <table> на страницу — ровно то, что отличает
      // compact layout от старого «по карточке на категорию».
      expect(src.match(/<thead>/g) ?? []).toHaveLength(1);
      expect(src.match(/<table\b/g) ?? []).toHaveLength(1);
    },
  );

  /**
   * Единый каркас списка (эталон — `/admin/routes`).
   *
   * Список с вкладками архива = ОДНА `AdminCard`, внутри неё по
   * порядку: вкладки → поиск → `AdminSectionHeader` («Активные ·
   * Всего: N») → таблица. Никаких «второй карточки под таблицу» и
   * никакого `padding: 0` с заголовком-полоской во всю ширину: именно
   * так /admin/operations и /admin/equipment выбивались из остальных
   * списков админки.
   */
  const TABBED_LIST_PAGES = LIST_PAGES.filter((file) =>
    readSrc(file).includes('AdminArchiveTabs'),
  );

  test.each(TABBED_LIST_PAGES)(
    '%s держит вкладки, «Активные · Всего: N» и таблицу в ОДНОЙ AdminCard',
    (file) => {
      const src = readSrc(file);
      expect(src.match(/<AdminCard\b/g) ?? []).toHaveLength(1);
      expect(src).toMatch(/<AdminSectionHeader/);
      // Компактная карточка с обнулённым padding (заголовок-полоска
      // с border-bottom) — регресс каркаса.
      expect(src).not.toMatch(/className="admin-compact-grouped-card/);
    },
  );

  test.each(LIST_PAGES)('%s не использует старый admin-shell wrapper', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/className=['"]admin-shell['"]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Pagination component существует
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — AdminPagination', () => {
  test('admin-pagination.tsx существует и экспортирует helper', () => {
    const src = readSrc('apps/web/components/admin/admin-pagination.tsx');
    expect(src).toMatch(/export function AdminPagination/);
    expect(src).toMatch(/export function paginate/);
    expect(src).toMatch(/Показано/);
  });

  test('PageSizeSelect — отдельный client-компонент', () => {
    const src = readSrc('apps/web/components/admin/admin-pagination.client.tsx');
    expect(src).toMatch(/'use client'/);
    expect(src).toMatch(/export function PageSizeSelect/);
    expect(src).toMatch(/useRouter/);
  });

  test('barrel @/components/admin реэкспортирует AdminPageShell + AdminPagination', () => {
    const src = readSrc('apps/web/components/admin/index.ts');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminPagination/);
    expect(src).toMatch(/paginate/);
  });
});

// ---------------------------------------------------------------------------
// 6. AdminPageShell компонент
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — AdminPageShell', () => {
  test('admin-page-shell.tsx существует с нужными props', () => {
    const src = readSrc('apps/web/components/admin/admin-page-shell.tsx');
    expect(src).toMatch(/export function AdminPageShell/);
    expect(src).toMatch(/title/);
    expect(src).toMatch(/subtitle/);
    expect(src).toMatch(/icon/);
    expect(src).toMatch(/actions/);
  });
});

// ---------------------------------------------------------------------------
// 7. Globals.css — типографика, токены, анимации
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — globals.css', () => {
  test('содержит токены отступов admin-space-*', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/--admin-space-xs:\s*6px/);
    expect(css).toMatch(/--admin-space-sm:\s*10px/);
    expect(css).toMatch(/--admin-space-md:\s*16px/);
    expect(css).toMatch(/--admin-space-lg:\s*24px/);
    expect(css).toMatch(/--admin-space-xl:\s*32px/);
  });

  test('содержит .admin-page-title / .admin-section-title / .admin-muted', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-page-title\s*\{/);
    expect(css).toMatch(/\.admin-section-title\s*\{/);
    expect(css).toMatch(/\.admin-muted\s*\{/);
  });

  test('содержит .admin-form / .admin-form-grid / .admin-field / .admin-actions-row', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-form\s*\{/);
    expect(css).toMatch(/\.admin-form-grid\s*\{/);
    expect(css).toMatch(/\.admin-field\s*\{/);
    expect(css).toMatch(/\.admin-actions-row\s*\{/);
  });

  test('содержит .admin-pagination', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-pagination\s*\{/);
  });

  test('prefers-reduced-motion отключает анимации', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

// ---------------------------------------------------------------------------
// 8. Никаких тёмных фонов в admin-блоке
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — без тёмных фонов', () => {
  test('блок Admin UI 2.5 в globals.css не вводит bg-black / bg-slate-900', () => {
    const css = readSrc('apps/web/app/globals.css');
    const marker = 'Admin UI 2.5';
    const idx = css.indexOf(marker);
    expect(idx).toBeGreaterThan(0);
    const block = css.slice(idx);
    expect(block).not.toMatch(/background[^;]*#0f172a/i);
    expect(block).not.toMatch(/background[^;]*#1e293b/i);
    expect(block).not.toMatch(/background[^;]*#111827/i);
    expect(block).not.toMatch(/background[^;]*#000\b/);
  });
});

// ---------------------------------------------------------------------------
// 9. /master и /shopfloor/display не затронуты
// ---------------------------------------------------------------------------

describe('Admin UI 2.5 — изолированность', () => {
  test('/master/page.tsx не использует admin-page-shell', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    expect(src).not.toMatch(/AdminPageShell/);
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
  });

  test('/shopfloor/display/page.tsx не использует admin-page-shell', () => {
    const src = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(src).not.toMatch(/AdminPageShell/);
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
  });
});
