/**
 * Smoke-тест правила «страница со своим каркасом не получает
 * глобальных шапки и подвала».
 *
 * Что чинили. Верхний `AppHeader` прятался по паре «роль + путь»
 * (`role === 'CUTTER' && isCutterPath`), а нижний `MobileNav` не
 * смотрел на путь вообще — только на роль. Из-за этого:
 *
 *   - ADMIN / SHOP_MANAGER, открывшие ЧУЖОЙ ролевой терминал с
 *     телефона, получали одновременно старую шапку с ссылками в
 *     админку, новый `.employee-toolbar` и старый нижний подвал;
 *   - на `/admin/*` подвал дублировал drawer «Меню»;
 *   - резерв места `.app-main { padding-bottom: 96px }` был
 *     безусловным: там, где подвала нет, он давал мёртвую полосу, а
 *     на `/admin/*` и `/master` его снимал собственный `padding: 0`,
 *     и фиксированный подвал ложился поверх контента.
 *
 * Полноценного React-рендера в проекте нет (vitest в Node без jsdom),
 * поэтому предикат проверяем напрямую, а его подключение — грепом по
 * исходникам, как в остальных smoke-тестах.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  hasOwnAppChrome,
  hidesMobileNav,
  isAdminChromePath,
  isLoginChromePath,
  isRoleSplitPath,
  isRoleTerminalPath,
} from '../../apps/web/lib/app-chrome';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** Ролевые терминалы: изолированные экраны роли, выхода наружу нет. */
const TERMINALS = [
  '/qc',
  '/wto',
  '/cutter',
  '/cutter/lays/abc',
  '/constructor',
  '/constructor/abc',
  '/master',
  '/master/calls',
  '/shopfloor/display',
];

/** Ветвятся по роли: терминал рабочему, управленческий вид менеджеру. */
const ROLE_SPLIT = ['/work', '/work/cut-orders', '/packing'];

/** Управленческие экраны: глобальная навигация остаётся целиком. */
const MANAGEMENT = [
  '/orders',
  '/orders/abc',
  '/orders/abc/passports/new',
  '/earnings',
  '/shopfloor',
  '/production-cost',
  '/qc/passports/abc',
  '/wto/passports/abc',
];

describe('app chrome: у страницы либо свой каркас, либо глобальный', () => {
  test('ролевые терминалы опознаются, включая хвостовой слэш', () => {
    for (const p of TERMINALS) {
      expect(isRoleTerminalPath(p), p).toBe(true);
      expect(isRoleTerminalPath(`${p}/`), `${p}/`).toBe(true);
      // Ни шапки, ни подвала — ни у одной роли.
      expect(hasOwnAppChrome(p), p).toBe(true);
      expect(hidesMobileNav(p), p).toBe(true);
    }
  });

  test('`/work*` и `/packing` теряют подвал, но НЕ шапку', () => {
    // Эти URL ветвятся по роли: рабочему — терминал со своим каркасом,
    // менеджеру — управленческий вид, у которого каркаса нет. Снять
    // шапку у всех = оставить ADMIN без навигации и выхода, в том
    // числе на десктопе. Подвал же ведёт наружу и режется у всех.
    for (const p of ROLE_SPLIT) {
      expect(isRoleSplitPath(p), p).toBe(true);
      expect(hidesMobileNav(p), p).toBe(true);
      expect(hasOwnAppChrome(p), p).toBe(false);
    }
    // `/packing` — ровно корень: `/packing/boxes/:id` сюда не попадает.
    expect(isRoleSplitPath('/packing/boxes/abc')).toBe(false);
  });

  test('управленческие экраны каркас не теряют', () => {
    for (const p of MANAGEMENT) {
      expect(isRoleTerminalPath(p), p).toBe(false);
      expect(isRoleSplitPath(p), p).toBe(false);
      expect(hasOwnAppChrome(p), p).toBe(false);
      expect(hidesMobileNav(p), p).toBe(false);
    }
  });

  test('`/qc`, `/wto`, `/shopfloor/display` — терминал ровно на корне', () => {
    // Подстраницы этих разделов открывает менеджер/админ, там нужна
    // обычная навигация. Это поведение было и до правки — фиксируем,
    // чтобы предикат его не «расширил» до префикса.
    expect(isRoleTerminalPath('/qc/passports/1')).toBe(false);
    expect(isRoleTerminalPath('/shopfloor')).toBe(false);
    // Соседние префиксы не должны цепляться.
    expect(hidesMobileNav('/packings')).toBe(false);
    expect(hidesMobileNav('/workshop-needs')).toBe(false);
    expect(isRoleTerminalPath('/cutterX')).toBe(false);
  });

  test('админка и логин — свой каркас', () => {
    for (const p of ['/admin', '/admin/orders', '/admin/orders/1/edit'])
      expect(isAdminChromePath(p), p).toBe(true);
    expect(isAdminChromePath('/administration')).toBe(false);
    for (const p of ['/login', '/login/']) expect(isLoginChromePath(p), p).toBe(true);
  });

  test('AppHeader режет шапку по пути ДО чтения роли', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    expect(src).toMatch(/from '@\/lib\/app-chrome'/);
    const body = src.slice(src.indexOf('export function AppHeader'));
    const chromeAt = body.indexOf('hasOwnAppChrome(pathname)');
    const roleAt = body.indexOf("role === '");
    expect(chromeAt).toBeGreaterThan(0);
    // Иначе шапка мигнёт на гидрации client-роутинга.
    expect(chromeAt).toBeLessThan(roleAt);
  });

  test('MobileNav режет подвал по пути', () => {
    const src = readSrc('apps/web/components/mobile-nav.tsx');
    expect(src).toMatch(/from '@\/lib\/app-chrome'/);
    expect(src).toMatch(/if \(hidesMobileNav\(pathname\)\) return null;/);
    // Ролевые флаги остаются — путь их не заменяет, а дополняет.
    expect(src).toMatch(/items\.length === 0/);
  });

  test('резерв места под подвал висит только когда подвал отрисован', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Безусловного правила быть не должно — именно оно давало мёртвую
    // полосу на терминалах.
    expect(css).not.toMatch(/\n\s*\.app-main \{ padding-bottom: calc\(96px/);
    expect(css).toMatch(
      /body:has\(\.mobile-nav\)\s+\.app-main\s*\{[\s\S]{0,160}?padding-bottom:\s*calc\(96px/,
    );
    // 5+ пунктов = вторая строка пунктов (у ADMIN их шесть).
    expect(css).toMatch(
      /body:has\(\.mobile-nav__list > li:nth-child\(5\)\)\s+\.app-main\s*\{[\s\S]{0,160}?padding-bottom:\s*calc\(120px/,
    );
  });
});
