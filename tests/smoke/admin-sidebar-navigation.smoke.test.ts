/**
 * Source-level smoke-тесты левого admin-sidebar (Admin Navigation
 * Polish, см. чат + комментарии в `apps/web/components/admin-sidebar.tsx`,
 * `apps/web/lib/feature-flags.ts`).
 *
 * Зачем: в один момент после Этапов 4А–7А (workshop-needs / suppliers /
 * purchase-orders / purchase-receipts) и MVP-1 (patterns) в проекте
 * собралось 5 модулей, каждый со своим `NEXT_PUBLIC_FEATURE_*`-флагом.
 * Старая логика `=== '1'` означала, что на свежем `.env` без флагов
 * пункты тихо прятались, и менеджер не видел готовые страницы. Эти
 * тесты охраняют:
 *   1. что sidebar содержит все 5 hrefs / labels;
 *   2. что используется helper `isFeatureEnabled` (а не строгое `=== '1'`);
 *   3. что helper трактует `undefined` / пустую строку как «включено»;
 *   4. что helper трактует `0` / `false` / `off` / `no` / `disabled`
 *      как «выключено»;
 *   5. что `isActive` подсвечивает detail-страницы (startsWith);
 *   6. что `.env.example` документирует все 5 флагов.
 *
 * Паттерн — тот же, что у остальных admin-smoke (`admin-ui-consistency`,
 * `purchase-receipts-admin`, `workshop-needs-admin`): читаем исходники
 * напрямую, без рендера React, без подъёма Next.js.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { isFeatureEnabled } from '../../apps/web/lib/feature-flags';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const SIDEBAR_PATH = 'apps/web/components/admin-sidebar.tsx';

// ---------------------------------------------------------------------------
// 1. Все 5 модулей видны в sidebar (hrefs + labels)
// ---------------------------------------------------------------------------

const REQUIRED_NAV_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  flag: string;
}> = [
  {
    href: '/admin/patterns',
    label: 'Номенклатура',
    flag: 'NEXT_PUBLIC_FEATURE_PATTERNS',
  },
  {
    href: '/admin/workshop-needs',
    label: 'Потребность цеха',
    flag: 'NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS',
  },
  {
    href: '/admin/suppliers',
    label: 'Поставщики',
    flag: 'NEXT_PUBLIC_FEATURE_SUPPLIERS',
  },
  {
    href: '/admin/purchase-orders',
    label: 'Заказы поставщикам',
    flag: 'NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS',
  },
  {
    href: '/admin/purchase-receipts',
    label: 'Приёмка поставок',
    flag: 'NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS',
  },
];

describe('Admin sidebar — 5 модулей видны', () => {
  test.each(REQUIRED_NAV_ITEMS)(
    'sidebar содержит href $href',
    ({ href }) => {
      const src = readSrc(SIDEBAR_PATH);
      // Ищем именно как строковый литерал, чтобы не зацепиться за
      // комментарий/JSDoc.
      expect(src).toMatch(new RegExp(`href:\\s*['"]${href}['"]`));
    },
  );

  test.each(REQUIRED_NAV_ITEMS)(
    'sidebar содержит label «$label»',
    ({ label }) => {
      const src = readSrc(SIDEBAR_PATH);
      expect(src).toMatch(new RegExp(`label:\\s*['"]${label}['"]`));
    },
  );

  test.each(REQUIRED_NAV_ITEMS)(
    'sidebar читает флаг $flag',
    ({ flag }) => {
      const src = readSrc(SIDEBAR_PATH);
      expect(src).toMatch(new RegExp(`process\\.env\\.${flag}\\b`));
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Все 5 admin-страниц физически существуют — иначе ссылка отдаст 404
// ---------------------------------------------------------------------------

const REQUIRED_ROUTE_FILES: ReadonlyArray<string> = [
  'apps/web/app/admin/patterns/page.tsx',
  'apps/web/app/admin/workshop-needs/page.tsx',
  'apps/web/app/admin/suppliers/page.tsx',
  'apps/web/app/admin/purchase-orders/page.tsx',
  'apps/web/app/admin/purchase-receipts/page.tsx',
];

describe('Admin sidebar — ссылки ведут на существующие страницы', () => {
  test.each(REQUIRED_ROUTE_FILES)('%s существует', (file) => {
    expect(() => readSrc(file)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Sidebar использует helper isFeatureEnabled, а не строгое === '1'
// ---------------------------------------------------------------------------

describe('Admin sidebar — feature-flag helper', () => {
  test('admin-sidebar.tsx импортирует isFeatureEnabled из @/lib/feature-flags', () => {
    const src = readSrc(SIDEBAR_PATH);
    expect(src).toMatch(/from\s+['"]@\/lib\/feature-flags['"]/);
    expect(src).toMatch(/isFeatureEnabled/);
  });

  test('admin-sidebar.tsx больше не сравнивает env строго с "1"', () => {
    const src = readSrc(SIDEBAR_PATH);
    // Раньше было `process.env.NEXT_PUBLIC_FEATURE_X === '1'` — это
    // делало модули «default-off» при пустом .env. Новая логика —
    // через `isFeatureEnabled(...)`. Ловим именно strict-equals на
    // NEXT_PUBLIC_FEATURE_*, чтобы не зацепить чужие env.
    expect(src).not.toMatch(/NEXT_PUBLIC_FEATURE_[A-Z_]+\s*===\s*['"]1['"]/);
  });
});

// ---------------------------------------------------------------------------
// 4. isFeatureEnabled — поведенческий контракт
// ---------------------------------------------------------------------------

describe('isFeatureEnabled (default-on policy)', () => {
  test('undefined → видимо', () => {
    expect(isFeatureEnabled(undefined)).toBe(true);
  });

  test('null → видимо', () => {
    expect(isFeatureEnabled(null)).toBe(true);
  });

  test('пустая строка → видимо', () => {
    expect(isFeatureEnabled('')).toBe(true);
    expect(isFeatureEnabled('   ')).toBe(true);
  });

  test.each(['1', 'true', 'TRUE', 'on', 'yes', 'enabled', 'whatever'])(
    '"%s" → видимо',
    (value) => {
      expect(isFeatureEnabled(value)).toBe(true);
    },
  );

  test.each(['0', 'false', 'FALSE', 'off', 'no', 'disabled', '  off  '])(
    '"%s" → скрыто',
    (value) => {
      expect(isFeatureEnabled(value)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Активное состояние работает на detail-страницах (startsWith)
// ---------------------------------------------------------------------------

describe('Admin sidebar — активное состояние detail-страниц', () => {
  test('isActive использует pathname.startsWith(item.href + "/")', () => {
    const src = readSrc(SIDEBAR_PATH);
    // Без startsWith пункт «Лекала» не подсвечивался бы на
    // /admin/patterns/[id]. Защищаем именно общий branch
    // `pathname.startsWith(${item.href}/)`.
    expect(src).toMatch(/pathname\.startsWith\(`\$\{item\.href\}\/`\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. .env.example документирует все 5 флагов
// ---------------------------------------------------------------------------

describe('.env.example — admin nav feature toggles', () => {
  test.each(REQUIRED_NAV_ITEMS)(
    '$flag присутствует',
    ({ flag }) => {
      const src = readSrc('.env.example');
      expect(src).toMatch(new RegExp(`^${flag}=`, 'm'));
    },
  );

  test('блок «Admin navigation feature toggles» подписан', () => {
    const src = readSrc('.env.example');
    expect(src).toMatch(/Admin navigation feature toggles/);
  });
});
