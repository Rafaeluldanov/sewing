/**
 * Smoke-тест fullscreen-режима `/master` для роли SHOPFLOOR_MASTER.
 *
 * Полноценного React-рендера в проекте нет (vitest идёт в Node без
 * jsdom + RTL — см. `tests/smoke/frontend-rbac.smoke.test.ts`),
 * поэтому фиксируем инварианты по исходникам:
 *
 *   1. `apps/web/components/app-header.tsx` скрывает шапку для
 *      SHOPFLOOR_MASTER и для любой роли на `/master*` — мобильный
 *      терминал работает как `/shopfloor/display`: fullscreen, без
 *      глобальной навигации. Решение по пути принимает общий
 *      `hasOwnAppChrome` (`apps/web/lib/app-chrome.ts`).
 *   2. Остальные терминалы (`/work`, `/qc`, `/wto`, `/packing`,
 *      `/cutter`, `/constructor`, `/shopfloor/display`) остались в
 *      том же списке — мы ничего не сломали другим ролям.
 *   3. `MobileNav` на `/master*` не рендерится ни у одной роли: для
 *      SHOPFLOOR_MASTER срабатывает `isSingleWorkspaceRole` в
 *      `apps/web/app/layout.tsx`, для ADMIN / SHOP_MANAGER (их пускает
 *      `MASTER_PAGE_ALLOWED_ROLES`) — проверка пути внутри самого
 *      компонента.
 *   4. Helper `isShopfloorMasterRole` существует и опознаёт роль —
 *      ТЗ просит хелпер `isMasterRole`, у нас он назван длиннее
 *      (`isShopfloorMaster*` повсюду в кодовой базе), но контракт
 *      идентичен.
 *   5. В `globals.css` для fullscreen-режима убираем padding /
 *      max-width / min-height у `.app-main` под `.master-page` —
 *      так же, как у `/shopfloor/display`. И сама `.master-page`
 *      добавляет safe-area-top, чтобы нотч не накрывал заголовок.
 *   6. ADMIN и SHOP_MANAGER не теряют доступ к header'у на остальных
 *      страницах (никто случайно не скрыл им навигацию).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  hasOwnAppChrome,
  isRoleTerminalPath,
} from '../../apps/web/lib/app-chrome';
import {
  isShopfloorMasterRole,
  isSingleWorkspaceRole,
  SHOPFLOOR_MASTER_ALLOWED_PATH,
  type Role,
} from '../../apps/web/lib/rbac';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('master fullscreen layout (SHOPFLOOR_MASTER)', () => {
  test('app-header.tsx прячет header для SHOPFLOOR_MASTER и на пути /master', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    // Роль — safety net на случай, если редирект middleware отвалится.
    expect(src).toMatch(/role === 'SHOPFLOOR_MASTER'/);
    // Путь `/master*` закрывает общий предикат, а не локальная переменная.
    expect(src).toMatch(/hasOwnAppChrome\(pathname\)/);
    expect(isRoleTerminalPath('/master')).toBe(true);
    expect(isRoleTerminalPath('/master/')).toBe(true);
    expect(isRoleTerminalPath('/master/calls')).toBe(true);
  });

  test('остальные терминалы не сломались (никаких регрессий для других ролей)', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    // Терминалы, у которых свой каркас у всего раздела.
    for (const p of ['/cutter', '/cutter/lays/1', '/constructor'])
      expect(isRoleTerminalPath(p)).toBe(true);
    // Терминал — ровно корневой путь; подстраницы остаются обычными
    // экранами менеджера с глобальной навигацией.
    for (const p of ['/qc', '/wto', '/shopfloor/display'])
      expect(isRoleTerminalPath(p)).toBe(true);
    for (const p of ['/qc/passports/1', '/wto/passports/1', '/shopfloor'])
      expect(isRoleTerminalPath(p)).toBe(false);
    // Управленческие экраны каркас не теряют.
    for (const p of ['/orders', '/orders/1', '/earnings', '/production-cost'])
      expect(hasOwnAppChrome(p)).toBe(false);
    // Под ADMIN / SHOP_MANAGER в шапке нет и не должно быть ни одной
    // ветки по роли — решение принимается по пути.
    expect(src).not.toMatch(/role === 'ADMIN'/);
    expect(src).not.toMatch(/role === 'SHOP_MANAGER'/);
  });

  test('MobileNav не рендерится на /master ни у одной роли', () => {
    // Сама матрица — единый источник истины: SHOPFLOOR_MASTER
    // обязан попадать в single-workspace, иначе под master экраном
    // снова появится нижняя навигация.
    expect(isSingleWorkspaceRole('SHOPFLOOR_MASTER')).toBe(true);
    // Layout рендерит MobileNav только для !singleWorkspace — это
    // условие фиксируем тут же, чтобы случайный рефактор layout'а
    // не сломал master.
    const layout = readSrc('apps/web/app/layout.tsx');
    expect(layout).toMatch(/isSingleWorkspaceRole/);
    expect(layout).toMatch(/isStaff && !singleWorkspace/);
    // Роли ADMIN / SHOP_MANAGER не single-workspace, их `MASTER_PAGE_
    // ALLOWED_ROLES` пускает на `/master` — им подвал режет уже сам
    // компонент по пути.
    expect(isSingleWorkspaceRole('ADMIN')).toBe(false);
    expect(isSingleWorkspaceRole('SHOP_MANAGER')).toBe(false);
    const nav = readSrc('apps/web/components/mobile-nav.tsx');
    expect(nav).toMatch(/if \(hidesMobileNav\(pathname\)\) return null;/);
  });

  test('isShopfloorMasterRole опознаёт роль и не задевает соседние', () => {
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
    const matched = ALL_ROLES.filter((r) => isShopfloorMasterRole(r));
    expect(matched).toEqual(['SHOPFLOOR_MASTER']);
    expect(isShopfloorMasterRole(undefined)).toBe(false);
    expect(isShopfloorMasterRole(null)).toBe(false);
    expect(isShopfloorMasterRole('UNKNOWN')).toBe(false);
    // Allowed path константа — единый источник истины и для
    // middleware, и для layout-ассертов.
    expect(SHOPFLOOR_MASTER_ALLOWED_PATH).toBe('/master');
  });

  test('globals.css снимает .app-main padding/max-width/min-height под .master-page', () => {
    const src = readSrc('apps/web/app/globals.css');
    // То же правило, что у `/shopfloor/display` (см. `body:has(.display-screen)`).
    expect(src).toMatch(/body:has\(\.master-page\)\s*\.app-main\s*\{/);
    const block = src.slice(src.indexOf('body:has(.master-page)'));
    expect(block).toMatch(/padding:\s*0/);
    expect(block).toMatch(/max-width:\s*none/);
    expect(block).toMatch(/min-height:\s*0/);
  });

  test('.master-page учитывает safe-area-top (нотч/dynamic-island), раз header убран', () => {
    const src = readSrc('apps/web/app/globals.css');
    const idx = src.indexOf('.master-page {');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    // Top padding строится через env(safe-area-inset-top).
    expect(block).toMatch(/env\(safe-area-inset-top/);
    // Bottom-padding под sticky-кнопку остался.
    expect(block).toMatch(/env\(safe-area-inset-bottom/);
    // 100vh — иначе экран не «во весь экран» на мобильном.
    expect(block).toMatch(/min-height:\s*100vh/);
  });

  test('master/page.tsx не рендерит свой header/нав-меню (терминал = только MasterPageClient)', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    // Серверный компонент — тонкая обёртка над MasterPageClient,
    // никакой собственной навигации/header'а заводить не должен.
    expect(src).toMatch(/MasterPageClient/);
    expect(src).not.toMatch(/<nav\b/);
    expect(src).not.toMatch(/<header\b/);
    expect(src).not.toMatch(/AppHeader/);
    expect(src).not.toMatch(/MobileNav/);
  });

  test('master-page-client.tsx использует именно класс .master-page (на него опираются CSS-правила выше)', () => {
    const src = readSrc('apps/web/app/master/master-page-client.tsx');
    expect(src).toMatch(/className="master-page"/);
    // И сам файл не подтягивает глобальную навигацию.
    expect(src).not.toMatch(/AppHeader/);
    expect(src).not.toMatch(/MobileNav/);
  });
});
