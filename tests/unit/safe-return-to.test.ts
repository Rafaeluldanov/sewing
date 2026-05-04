/**
 * Unit-тесты `safeReturnTo` (`apps/web/lib/safe-return-to.ts`).
 *
 * Контракт:
 *   - принимаем сырой returnTo;
 *   - валидный относительный путь, не указывающий на /login —
 *     возвращаем как есть;
 *   - всё остальное (absolute URL, protocol-relative `//`, /login,
 *     пустое, не-string) — fallback в `getDefaultRouteForRole(role)`.
 *
 * Цель — закрыть open-redirect surface через `?next=...` без серверной
 * проверки. Backend всё равно режет `@Roles(...)`, но returnTo не
 * должен пускать пользователя на чужой хост по своей сессии.
 */
import { describe, expect, test } from 'vitest';
import { safeReturnTo } from '../../apps/web/lib/safe-return-to';

describe('safeReturnTo — разрешённые пути', () => {
  test('/work — пропускаем как есть', () => {
    expect(safeReturnTo('/work', 'SEAMSTRESS')).toBe('/work');
  });

  test('/qc — пропускаем как есть', () => {
    expect(safeReturnTo('/qc', 'QC')).toBe('/qc');
  });

  test('/admin/orders — пропускаем как есть', () => {
    expect(safeReturnTo('/admin/orders', 'ADMIN')).toBe('/admin/orders');
  });

  test('/orders/abc?tab=plan — пропускаем (относительный путь с query)', () => {
    expect(safeReturnTo('/orders/abc?tab=plan', 'ADMIN')).toBe(
      '/orders/abc?tab=plan',
    );
  });
});

describe('safeReturnTo — open-redirect защита', () => {
  test('https://evil.com — отбрасываем, fallback на роль', () => {
    expect(safeReturnTo('https://evil.com', 'SEAMSTRESS')).toBe('/work');
  });

  test('http://evil.com — отбрасываем', () => {
    expect(safeReturnTo('http://evil.com/path', 'QC')).toBe('/qc');
  });

  test('//evil.com (protocol-relative) — отбрасываем', () => {
    expect(safeReturnTo('//evil.com/path', 'ADMIN')).toBe('/admin');
  });

  test('javascript:alert(1) — отбрасываем (не начинается с /)', () => {
    expect(safeReturnTo('javascript:alert(1)', 'ADMIN')).toBe('/admin');
  });

  test('путь, не начинающийся с / — отбрасываем', () => {
    expect(safeReturnTo('orders', 'ADMIN')).toBe('/admin');
  });
});

describe('safeReturnTo — /login после login запрещён', () => {
  test('/login — отбрасываем (иначе цикл редиректов)', () => {
    expect(safeReturnTo('/login', 'SEAMSTRESS')).toBe('/work');
  });

  test('/login/ — тоже отбрасываем', () => {
    expect(safeReturnTo('/login/', 'QC')).toBe('/qc');
  });

  test('/login?next=... — тоже отбрасываем', () => {
    expect(safeReturnTo('/login?next=/admin', 'ADMIN')).toBe('/admin');
  });
});

describe('safeReturnTo — пустые / невалидные значения', () => {
  test('пустая строка — fallback на роль', () => {
    expect(safeReturnTo('', 'PACKING')).toBe('/packing');
  });

  test('null — fallback на роль', () => {
    expect(safeReturnTo(null, 'IRONING')).toBe('/wto');
  });

  test('undefined — fallback на роль', () => {
    expect(safeReturnTo(undefined, 'SHOPFLOOR_MASTER')).toBe('/master');
  });

  test('одиночный / — отбрасываем (нет смысла редиректить на корень, он сам редиректит)', () => {
    expect(safeReturnTo('/', 'ADMIN')).toBe('/admin');
  });

  test('whitespace-only — отбрасываем', () => {
    expect(safeReturnTo('   ', 'ADMIN')).toBe('/admin');
  });
});

describe('safeReturnTo — fallback использует getDefaultRouteForRole', () => {
  test('unknown роль + плохой returnTo → /login', () => {
    expect(safeReturnTo('https://evil.com', 'UNKNOWN_ROLE')).toBe('/login');
  });

  test('null роль + пустой returnTo → /login', () => {
    expect(safeReturnTo('', null)).toBe('/login');
  });
});
