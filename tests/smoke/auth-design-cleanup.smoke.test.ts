/**
 * Smoke-тесты «cleanup-а» auth-зоны (см.
 * `docs/auth-design-cleanup-recon.md`).
 *
 * Цели:
 *   1. Экран входа собран на новом дизайне (AuthShell + AuthCard +
 *      LoginForm), без legacy-классов и inline style.
 *   2. После успешного входа пользователь не видит старый
 *      промежуточный экран — корневая `/` стала pure redirect-page.
 *   3. Тексты на login-экране соответствуют ТЗ.
 *   4. Auth UI не использует внешних QR/auth API и не дублирует
 *      auth-protocol на клиенте — это server-actions-only flow.
 *
 * Тесты опираются только на чтение исходников (нет JSDOM/RTL в
 * проекте), что и согласуется с остальными smoke-тестами проекта.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('login UI — новый дизайн и тексты ТЗ', () => {
  test('apps/web/app/login/page.tsx собран на AuthShell + AuthCard + LoginForm', () => {
    const src = readSrc('apps/web/app/login/page.tsx');
    expect(src).toMatch(/AuthShell/);
    expect(src).toMatch(/AuthCard/);
    expect(src).toMatch(/LoginForm/);
    // Старого pilot-leak ("Demo12345!") и ссылки «← На главную»
    // больше быть не должно — это были атрибуты legacy-страницы.
    expect(src).not.toMatch(/Demo12345/);
    expect(src).not.toMatch(/На главную/);
  });

  test('AuthCard содержит заголовок и подзаголовок из ТЗ', () => {
    const src = readSrc('apps/web/components/auth/auth-card.tsx');
    expect(src).toContain('Вход в SEWING');
    expect(src).toContain('Система управления швейным производством');
  });

  test('LoginForm содержит кнопку «Войти» и loading-текст «Входим…»', () => {
    const src = readSrc('apps/web/components/auth/login-form.tsx');
    expect(src).toContain('Войти');
    expect(src).toContain('Входим…');
    // Loading-стейт должен реально привязываться к `pending`
    // (`useFormStatus`), а не быть фразой в комментарии.
    expect(src).toMatch(/pending\s*\?\s*'Входим…'\s*:\s*'Войти'/);
  });

  test('AuthErrorState содержит текст ошибки из ТЗ', () => {
    const src = readSrc('apps/web/components/auth/auth-error-state.tsx');
    expect(src).toContain(
      'Не удалось войти. Проверьте данные и попробуйте ещё раз.',
    );
  });

  test('AuthLoadingState содержит loading-текст «Входим…»', () => {
    const src = readSrc('apps/web/components/auth/auth-loading-state.tsx');
    expect(src).toContain('Входим…');
  });
});

describe('login UI — отсутствие legacy-классов и inline style', () => {
  const AUTH_FILES = [
    'apps/web/app/login/page.tsx',
    'apps/web/components/auth/auth-shell.tsx',
    'apps/web/components/auth/auth-card.tsx',
    'apps/web/components/auth/login-form.tsx',
    'apps/web/components/auth/auth-loading-state.tsx',
    'apps/web/components/auth/auth-error-state.tsx',
  ];

  test('ни один auth-компонент не использует legacy `.auth-page` / `.auth-card` / `.auth-form*` classNames', () => {
    // Регулярки нарочно зажаты под JSX-className-литералы (`"…"` /
    // `'…'`), чтобы не зацепить путь импорта компонента
    // `'@/components/auth/auth-card'` — это новый, не legacy.
    for (const f of AUTH_FILES) {
      const src = readSrc(f);
      expect(src, f).not.toMatch(/["']auth-page\b/);
      expect(src, f).not.toMatch(/["']auth-card\b/);
      expect(src, f).not.toMatch(/["']auth-card__/);
      expect(src, f).not.toMatch(/["']auth-form\b/);
      expect(src, f).not.toMatch(/["']auth-form__/);
    }
  });

  test('legacy CSS-блоки удалены из globals.css', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Старые правила `.auth-page` / `.auth-card` / `.auth-form*`
    // должны быть удалены — иначе при рефакторе кто-то снова
    // воткнёт legacy-классы и они визуально «оживут».
    expect(css).not.toMatch(/\.auth-page\b/);
    expect(css).not.toMatch(/\.auth-card\b/);
    expect(css).not.toMatch(/\.auth-card__/);
    expect(css).not.toMatch(/\.auth-form\b/);
    expect(css).not.toMatch(/\.auth-form__/);
    // А новый `.auth-screen` в стилях должен присутствовать.
    expect(css).toMatch(/\.auth-screen\b/);
  });

  test('auth-компоненты не используют inline `style={{...}}`', () => {
    for (const f of AUTH_FILES) {
      const src = readSrc(f);
      // Никаких hardcoded inline-стилей — только классы из новой
      // секции `auth-screen*` в `globals.css`.
      expect(src, f).not.toMatch(/style=\{/);
    }
  });

  test('login-form использует server action `loginAction`, без своего fetch на /api/auth/login', () => {
    const src = readSrc('apps/web/components/auth/login-form.tsx');
    expect(src).toMatch(/loginAction/);
    expect(src).not.toMatch(/fetch\(['"]\/api\/auth/);
    // Внешних QR/SSO/etc. библиотек у формы нет.
    expect(src).not.toMatch(/qrcode/);
  });
});

describe('post-login: корневой / больше не показывает legacy dashboard', () => {
  test('apps/web/app/page.tsx — pure redirect через getDefaultRouteForRole', () => {
    const src = readSrc('apps/web/app/page.tsx');
    expect(src).toMatch(/redirect\('\/login'\)/);
    expect(src).toMatch(/getDefaultRouteForRole/);
    // Никаких легаси UI-кусков не должно остаться: tile-grid,
    // карточки, brand-mark, MobileActionCard, page-shell, action-grid.
    expect(src).not.toMatch(/MobileActionCard/);
    expect(src).not.toMatch(/page-shell/);
    expect(src).not.toMatch(/action-grid/);
    expect(src).not.toMatch(/brand-mark/);
    // Старого ROLE_LABELS-словаря и приветствия «Здравствуйте» —
    // тоже нет. Это были типичные элементы старого dashboard.
    expect(src).not.toMatch(/ROLE_LABELS/);
    expect(src).not.toMatch(/Здравствуйте/);
  });

  test('apps/web/app/page.tsx — никаких redirect на корневой `/` (защита от циклов)', () => {
    const src = readSrc('apps/web/app/page.tsx');
    expect(src).not.toMatch(/redirect\(\s*['"]\/['"]\s*\)/);
  });
});

describe('safeReturnTo / getDefaultRouteForRole интегрированы в auth-flow', () => {
  test('login action использует safeReturnTo, а не legacy `getPrimaryWorkspace`', () => {
    const src = readSrc('apps/web/app/login/actions.ts');
    expect(src).toMatch(/safeReturnTo/);
    expect(src).not.toMatch(/getPrimaryWorkspace/);
  });

  test('login page использует safeReturnTo для уже залогиненного', () => {
    const src = readSrc('apps/web/app/login/page.tsx');
    expect(src).toMatch(/safeReturnTo\(/);
  });
});

describe('legacy login-form удалён, новый компонент в components/auth', () => {
  test('старый apps/web/app/login/login-form.tsx удалён', () => {
    expect(() =>
      readFileSync(
        path.join(repoRoot, 'apps/web/app/login/login-form.tsx'),
        'utf8',
      ),
    ).toThrow();
  });

  test('новый компонент лежит в apps/web/components/auth/login-form.tsx', () => {
    const src = readSrc('apps/web/components/auth/login-form.tsx');
    expect(src).toMatch(/'use client'/);
    expect(src).toMatch(/export function LoginForm/);
  });
});
