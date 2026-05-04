/**
 * Unit-тесты единого helper-а post-login редиректа
 * (`apps/web/lib/role-redirect.ts`).
 *
 * Helper — единственное место, где хранится таблица «роль → её
 * landing после login и при заходе на `/`». На него опираются:
 *   - server action `loginAction` (см. `apps/web/app/login/actions.ts`),
 *   - корневая страница `/` (см. `apps/web/app/page.tsx`),
 *   - login page для уже залогиненного (см. `apps/web/app/login/page.tsx`).
 *
 * Закрепляем матрицу из `docs/auth-design-cleanup-recon.md §4`.
 */
import { describe, expect, test } from 'vitest';
import { getDefaultRouteForRole } from '../../apps/web/lib/role-redirect';

describe('getDefaultRouteForRole', () => {
  test('ADMIN → /admin (новая admin home, не корневой `/`)', () => {
    expect(getDefaultRouteForRole('ADMIN')).toBe('/admin');
  });

  test('SHOP_MANAGER → /admin', () => {
    expect(getDefaultRouteForRole('SHOP_MANAGER')).toBe('/admin');
  });

  test('SHOPFLOOR_MASTER → /master', () => {
    expect(getDefaultRouteForRole('SHOPFLOOR_MASTER')).toBe('/master');
  });

  test('CUTTER → /work', () => {
    expect(getDefaultRouteForRole('CUTTER')).toBe('/work');
  });

  test('CUTTER_ASSISTANT → /work', () => {
    expect(getDefaultRouteForRole('CUTTER_ASSISTANT')).toBe('/work');
  });

  test('SEAMSTRESS → /work', () => {
    expect(getDefaultRouteForRole('SEAMSTRESS')).toBe('/work');
  });

  test('QC → /qc', () => {
    expect(getDefaultRouteForRole('QC')).toBe('/qc');
  });

  test('IRONING → /wto', () => {
    expect(getDefaultRouteForRole('IRONING')).toBe('/wto');
  });

  test('PACKING → /packing', () => {
    expect(getDefaultRouteForRole('PACKING')).toBe('/packing');
  });

  test('DISPLAY → /shopfloor/display', () => {
    expect(getDefaultRouteForRole('DISPLAY')).toBe('/shopfloor/display');
  });

  test('null / undefined / "" / unknown — безопасный fallback на /login', () => {
    // `/login` (а не `/`) — иначе `app/page.tsx` зацикливается:
    // `/` → этот хелпер → `/` → этот хелпер → ...
    expect(getDefaultRouteForRole(null)).toBe('/login');
    expect(getDefaultRouteForRole(undefined)).toBe('/login');
    expect(getDefaultRouteForRole('')).toBe('/login');
    expect(getDefaultRouteForRole('UNKNOWN_ROLE')).toBe('/login');
  });

  test('никогда не возвращает корневой `/` (защита от redirect loop)', () => {
    const roles = [
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
      'UNKNOWN',
      '',
    ];
    for (const r of roles) {
      expect(getDefaultRouteForRole(r)).not.toBe('/');
    }
    expect(getDefaultRouteForRole(null)).not.toBe('/');
    expect(getDefaultRouteForRole(undefined)).not.toBe('/');
  });
});
