/**
 * Smoke-тесты кнопки «Мой QR-код» (`EmployeeQrButton`) и её
 * интеграции в шапки рабочих экранов.
 *
 * Vitest в этом проекте идёт без jsdom, поэтому рендерить React мы
 * не можем — проверяем то, что можно зафиксировать как текст:
 *
 *   1. RBAC-хелпер `canSeeEmployeeQrButton` включает все
 *      производственные роли, SHOPFLOOR_MASTER и менеджеров; прячет
 *      DISPLAY и пустые/неизвестные роли.
 *   2. Компонент `components/employees/employee-qr-button.tsx`
 *      действительно опирается на `qrcode.react`, открывает модалку с
 *      ожидаемыми текстами из ТЗ и грузит данные через
 *      `getMyEmployeeQrAction`.
 *   3. Все секционные layout'ы `/work`, `/qc`, `/wto`, `/packing` и
 *      серверная `/master/page.tsx` используют `canSeeEmployeeQrButton`
 *      и рендерят кнопку.
 *   4. Глобальный `AppHeader` в `app/layout.tsx` показывает кнопку
 *      авторизованным ролям, для которых canSeeEmployeeQrButton true
 *      (чтобы ADMIN/SHOP_MANAGER видели её без ухода в терминал).
 *   5. Серверная обёртка `lib/employee-qr-api.ts` дергает именно
 *      `/me/employee-qr` и не использует внешние QR-API.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  canSeeEmployeeQrButton,
  EMPLOYEE_QR_BUTTON_ALLOWED_ROLES,
  type Role,
} from '../../apps/web/lib/rbac';

const ALL_ROLES: Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
  'DISPLAY',
  'SHOPFLOOR_MASTER',
];

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('canSeeEmployeeQrButton', () => {
  test('включает все производственные/терминальные роли и менеджеров; прячет DISPLAY', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeEmployeeQrButton(r));
    expect(allowed.sort()).toEqual(
      [
        'ADMIN',
        'CUTTER',
        'CUTTER_ASSISTANT',
        'IRONING',
        'PACKING',
        'QC',
        'SEAMSTRESS',
        'SHOPFLOOR_MASTER',
        'SHOP_MANAGER',
      ].sort(),
    );
    expect(canSeeEmployeeQrButton('DISPLAY')).toBe(false);
    expect(canSeeEmployeeQrButton(undefined)).toBe(false);
    expect(canSeeEmployeeQrButton(null)).toBe(false);
    expect(canSeeEmployeeQrButton('')).toBe(false);
    expect(canSeeEmployeeQrButton('UNKNOWN_ROLE')).toBe(false);
  });

  test('матрица ролей явно перечислена и совпадает с ТЗ', () => {
    // ТЗ: видимо для CUTTER/CUTTER_ASSISTANT/SEAMSTRESS/QC/IRONING/
    // PACKING/SHOPFLOOR_MASTER + ADMIN/SHOP_MANAGER для тестирования.
    expect(Array.from(EMPLOYEE_QR_BUTTON_ALLOWED_ROLES).sort()).toEqual(
      [
        'ADMIN',
        'CUTTER',
        'CUTTER_ASSISTANT',
        'IRONING',
        'PACKING',
        'QC',
        'SEAMSTRESS',
        'SHOPFLOOR_MASTER',
        'SHOP_MANAGER',
      ].sort(),
    );
  });
});

describe('EmployeeQrButton component', () => {
  const SRC = 'apps/web/components/employees/employee-qr-button.tsx';

  test('client component, рендерит QR через единый QrCodeView', () => {
    const src = readSrc(SRC);
    expect(src).toMatch(/^'use client'/);
    // EmployeeQrButton идёт через единый QrCodeView (см.
    // apps/web/components/qr/qr-code-view.tsx) — это hotfix против
    // регрессии, когда прямой QRCodeCanvas/Default-импорт ломал
    // рендер во всех местах сразу. Прямого импорта qrcode.react
    // здесь больше быть не должно.
    expect(src).toMatch(/from '@\/components\/qr'/);
    expect(src).toMatch(/<QrCodeView\b/);
    expect(src).not.toMatch(/from 'qrcode\.react'/);
  });

  test('загружает QR через server action getMyEmployeeQrAction', () => {
    const src = readSrc(SRC);
    expect(src).toMatch(/getMyEmployeeQrAction/);
    // Внешние QR-API не используем (security/tenancy — см.
    // employee-qr.ts).
    expect(src).not.toMatch(/api\.qrserver\.com/i);
    expect(src).not.toMatch(/chart\.googleapis\.com/i);
  });

  test('тексты из ТЗ: кнопка, заголовок модалки, подпись, ошибка', () => {
    const src = readSrc(SRC);
    expect(src).toContain('Мой QR-код');
    expect(src).toContain('QR-код сотрудника');
    expect(src).toContain(
      'Покажите этот код мастеру или отсканируйте на рабочем терминале',
    );
    expect(src).toContain(
      'Не удалось загрузить QR-код. Попробуйте ещё раз.',
    );
  });

  test('модалка управляется aria-атрибутами и Escape', () => {
    const src = readSrc(SRC);
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    expect(src).toMatch(/e\.key === 'Escape'/);
    // data-testid-ы пригодятся для будущего e2e.
    expect(src).toContain('data-testid="employee-qr-open"');
    expect(src).toContain('data-testid="employee-qr-modal"');
  });
});

describe('server-side integration of EmployeeQrButton', () => {
  const SECTION_LAYOUTS: Array<[string, string]> = [
    ['/work', 'apps/web/app/work/layout.tsx'],
    ['/qc', 'apps/web/app/qc/layout.tsx'],
    ['/wto', 'apps/web/app/wto/layout.tsx'],
    ['/packing', 'apps/web/app/packing/layout.tsx'],
  ];

  for (const [label, file] of SECTION_LAYOUTS) {
    test(`layout ${label} рендерит EmployeeQrButton под canSeeEmployeeQrButton`, () => {
      const src = readSrc(file);
      expect(src).toMatch(/canSeeEmployeeQrButton/);
      expect(src).toMatch(/<EmployeeQrButton\b/);
      // Кнопка не ломает существующий «Мастер»-flow — `CallMasterButton`
      // должен остаться на тех же страницах.
      expect(src).toMatch(/CallMasterButton/);
    });
  }

  test('master page рендерит EmployeeQrButton под canSeeEmployeeQrButton', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    expect(src).toMatch(/canSeeEmployeeQrButton/);
    expect(src).toMatch(/<EmployeeQrButton\b/);
  });

  test('root layout (app-header) показывает кнопку авторизованным ролям из матрицы', () => {
    const src = readSrc('apps/web/app/layout.tsx');
    expect(src).toMatch(/canSeeEmployeeQrButton/);
    expect(src).toMatch(/<EmployeeQrButton\b/);
  });
});

describe('lib/employee-qr-api.ts — only backend, no external QR APIs', () => {
  const SRC = 'apps/web/lib/employee-qr-api.ts';

  test('обёртка дергает именно /me/employee-qr через apiFetch', () => {
    const src = readSrc(SRC);
    expect(src).toMatch(/apiFetch</);
    expect(src).toContain("'/me/employee-qr'");
    expect(src).toMatch(/getMyEmployeeQrCode/);
    expect(src).not.toMatch(/api\.qrserver\.com/i);
    expect(src).not.toMatch(/chart\.googleapis\.com/i);
  });

  test('server action возвращает единый Result-shape (ok/error + requestId)', () => {
    const src = readSrc('apps/web/app/employee-qr/actions.ts');
    expect(src).toMatch(/^'use server'/);
    expect(src).toMatch(/getMyEmployeeQrAction/);
    expect(src).toMatch(/ok: true/);
    expect(src).toMatch(/ok: false/);
    expect(src).toMatch(/errorRequestId\?/);
    expect(src).toMatch(/EMPLOYEE_PROFILE_NOT_FOUND/);
    expect(src).toMatch(/EMPLOYEE_INACTIVE/);
  });
});
