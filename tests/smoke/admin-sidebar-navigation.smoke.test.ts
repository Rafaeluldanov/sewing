/**
 * Source-level smoke-тесты левого admin-sidebar (см. комментарии в
 * `apps/web/components/admin-sidebar.tsx` и контракт модулей в
 * `packages/shared/src/auth.ts`).
 *
 * Зачем: после Этапов 4А–7А (workshop-needs / suppliers / purchase-orders /
 * purchase-receipts) и MVP-1 (patterns) собралось несколько модулей, каждый
 * со своим гейтом. Под мультитенантность (Фаза 1) набор модулей переехал из
 * build-time `NEXT_PUBLIC_FEATURE_*` в РАНТАЙМ: API отдаёт `modules` через
 * `GET /api/auth/me`, layout прокидывает их в sidebar пропсом `modules`, а
 * `buildSections(modules)` строит пункты. Эти тесты охраняют:
 *   1. что sidebar содержит все 5 hrefs / labels;
 *   2. что пункт гейтится `modules.<key>` (а не `process.env.NEXT_PUBLIC_*`);
 *   3. что договор default-on (`isModuleEnabledValue`) трактует
 *      `undefined`/пустую строку как «включено»;
 *   4. что он трактует `0`/`false`/`off`/`no`/`disabled` как «выключено»;
 *   5. что `isActive` подсвечивает detail-страницы (startsWith);
 *   6. что `.env.example` документирует runtime-флаги `FEATURE_*`.
 *
 * Паттерн — тот же, что у остальных admin-smoke: читаем исходники напрямую,
 * без рендера React, без подъёма Next.js.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { isModuleEnabledValue } from '@sewing/shared/auth';

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
  /** Ключ модуля в `ModuleFlags` (как читает sidebar: `modules.<key>`). */
  moduleKey: string;
  /** Имя runtime-env API в `.env.example`. */
  envVar: string;
}> = [
  {
    href: '/admin/patterns',
    label: 'Номенклатура',
    moduleKey: 'patterns',
    envVar: 'FEATURE_PATTERNS',
  },
  {
    href: '/admin/workshop-needs',
    label: 'Потребность цеха',
    moduleKey: 'workshopNeeds',
    envVar: 'FEATURE_WORKSHOP_NEEDS',
  },
  {
    href: '/admin/suppliers',
    label: 'Поставщики',
    moduleKey: 'suppliers',
    envVar: 'FEATURE_SUPPLIERS',
  },
  {
    href: '/admin/purchase-orders',
    label: 'Заказы поставщикам',
    moduleKey: 'purchaseOrders',
    envVar: 'FEATURE_PURCHASE_ORDERS',
  },
  {
    href: '/admin/purchase-receipts',
    label: 'Приёмка поставок',
    moduleKey: 'purchaseReceipts',
    envVar: 'FEATURE_PURCHASE_RECEIPTS',
  },
];

describe('Admin sidebar — 5 модулей видны', () => {
  test.each(REQUIRED_NAV_ITEMS)('sidebar содержит href $href', ({ href }) => {
    const src = readSrc(SIDEBAR_PATH);
    // Ищем именно как строковый литерал, чтобы не зацепиться за
    // комментарий/JSDoc.
    expect(src).toMatch(new RegExp(`href:\\s*['"]${href}['"]`));
  });

  test.each(REQUIRED_NAV_ITEMS)(
    'sidebar содержит label «$label»',
    ({ label }) => {
      const src = readSrc(SIDEBAR_PATH);
      expect(src).toMatch(new RegExp(`label:\\s*['"]${label}['"]`));
    },
  );

  test.each(REQUIRED_NAV_ITEMS)(
    'sidebar гейтит пункт через modules.$moduleKey',
    ({ moduleKey }) => {
      const src = readSrc(SIDEBAR_PATH);
      expect(src).toMatch(new RegExp(`modules\\.${moduleKey}\\b`));
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
// 3. Sidebar берёт набор модулей из пропса (runtime), а не из build-time env
// ---------------------------------------------------------------------------

describe('Admin sidebar — runtime-модули, не build-time флаги', () => {
  test('admin-sidebar.tsx принимает modules: ModuleFlags из @sewing/shared/auth', () => {
    const src = readSrc(SIDEBAR_PATH);
    expect(src).toMatch(/from\s+['"]@sewing\/shared\/auth['"]/);
    expect(src).toMatch(/ModuleFlags/);
    // buildSections строит пункты из переданного набора, а не из env.
    expect(src).toMatch(/buildSections\(modules\)/);
  });

  test('admin-sidebar.tsx больше не читает process.env.NEXT_PUBLIC_FEATURE_*', () => {
    const src = readSrc(SIDEBAR_PATH);
    // Под мультитенантность флаги ушли из web-билда: один билд обслуживает
    // тенантов с разным набором модулей. Ловим любое чтение env-флага.
    expect(src).not.toMatch(/process\.env\.NEXT_PUBLIC_FEATURE_[A-Z_]+/);
  });
});

// ---------------------------------------------------------------------------
// 4. isModuleEnabledValue — поведенческий контракт default-on
// ---------------------------------------------------------------------------

describe('isModuleEnabledValue (default-on policy)', () => {
  test('undefined → включено', () => {
    expect(isModuleEnabledValue(undefined)).toBe(true);
  });

  test('null → включено', () => {
    expect(isModuleEnabledValue(null)).toBe(true);
  });

  test('пустая строка → включено', () => {
    expect(isModuleEnabledValue('')).toBe(true);
    expect(isModuleEnabledValue('   ')).toBe(true);
  });

  test.each(['1', 'true', 'TRUE', 'on', 'yes', 'enabled', 'whatever'])(
    '"%s" → включено',
    (value) => {
      expect(isModuleEnabledValue(value)).toBe(true);
    },
  );

  test.each(['0', 'false', 'FALSE', 'off', 'no', 'disabled', '  off  '])(
    '"%s" → выключено',
    (value) => {
      expect(isModuleEnabledValue(value)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Активное состояние работает на detail-страницах (startsWith)
// ---------------------------------------------------------------------------

describe('Admin sidebar — активное состояние detail-страниц', () => {
  test('isActive использует pathname.startsWith(item.href + "/")', () => {
    const src = readSrc(SIDEBAR_PATH);
    // Без startsWith пункт «Номенклатура» не подсвечивался бы на
    // /admin/patterns/[id]. Защищаем общий branch
    // `pathname.startsWith(${item.href}/)`.
    expect(src).toMatch(/pathname\.startsWith\(`\$\{item\.href\}\/`\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. .env.example документирует runtime-флаги FEATURE_*
// ---------------------------------------------------------------------------

describe('.env.example — admin nav feature toggles', () => {
  test.each(REQUIRED_NAV_ITEMS)('$envVar присутствует', ({ envVar }) => {
    const src = readSrc('.env.example');
    expect(src).toMatch(new RegExp(`^${envVar}=`, 'm'));
  });

  test('блок «Admin navigation feature toggles» подписан', () => {
    const src = readSrc('.env.example');
    expect(src).toMatch(/Admin navigation feature toggles/);
  });
});
