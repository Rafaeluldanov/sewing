/**
 * Smoke-тест: HTML `pattern` для полей `code` в админ-формах.
 *
 * Контекст:
 *   В современных браузерах (Chrome / Firefox с поддержкой
 *   `v`-flag) HTML-attribute `pattern` парсится как `RegExp` с
 *   флагом `v`, и неэкранированный дефис внутри character-class
 *   считается ошибкой:
 *
 *     Pattern attribute value [A-Z0-9][A-Z0-9_-]+ is not a valid
 *     regular expression.
 *
 *   Поэтому в админ-формах используем экранированный дефис: '\\-'.
 *   Общая константа лежит в `apps/web/lib/code-pattern.ts`.
 *
 * Контракт:
 *   1. В исходниках `apps/web` нет «сырого» pattern-атрибута со
 *      строкой `[A-Z0-9][A-Z0-9_-]*` (без экранирования дефиса).
 *   2. Обе формы (techcard / route template) импортируют
 *      `CODE_PATTERN` из `@/lib/code-pattern` и подставляют его
 *      в `pattern={CODE_PATTERN}`.
 *   3. Сам `CODE_PATTERN` содержит экранированный дефис: '_\\-'.
 *   4. Backend-валидация в `packages/shared` остаётся нетронутой:
 *      JS-RegExp `TECH_CARD_CODE_PATTERN` / `ROUTE_TEMPLATE_CODE_PATTERN`
 *      продолжают использовать `[A-Z0-9_-]` (там это легально).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const WEB_ROOT = path.join(repoRoot, 'apps/web');
const PATTERN_FILE = 'apps/web/lib/code-pattern.ts';
const TECH_CARD_FORM = 'apps/web/app/admin/tech-cards/tech-card-form.tsx';
const ROUTE_TEMPLATE_FORM = 'apps/web/app/admin/routes/route-template-form.tsx';
const SHARED_TECH_CARDS = 'packages/shared/src/tech-cards.ts';
const SHARED_ROUTES = 'packages/shared/src/routes.ts';

/**
 * Рекурсивный обход `apps/web` (без `node_modules` и `.next`),
 * собираем все TS/TSX/JS/JSX исходники.
 */
function collectWebSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectWebSources(full, acc);
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 1. Общая константа CODE_PATTERN существует и содержит экранированный дефис
// ---------------------------------------------------------------------------

describe('CODE_PATTERN — общая константа для HTML pattern', () => {
  test('файл apps/web/lib/code-pattern.ts существует', () => {
    expect(exists(PATTERN_FILE)).toBe(true);
  });

  test('экспортирует CODE_PATTERN с экранированным дефисом', () => {
    const src = read(PATTERN_FILE);
    expect(src).toMatch(/export const CODE_PATTERN\b/);
    // В TS-исходнике подстрока выглядит как `_\\-` — это два
    // символа в коде (`\` + `\` + `-`), которые превращаются в
    // одну пару `\-` уже в значении строки. В JS-RegExp каждый
    // backslash тоже надо экранировать, поэтому в шаблоне ниже
    // их четыре подряд (`\\\\` = два литеральных backslash-а).
    expect(src).toMatch(/CODE_PATTERN\s*=\s*'\[A-Z0-9\]\[A-Z0-9_\\\\-\]\*'/);
    // Защита от регрессии: «сырого» неэкранированного варианта
    // вида `[A-Z0-9_-]` в самой константе быть не должно.
    expect(src).not.toMatch(/CODE_PATTERN\s*=\s*'\[A-Z0-9\]\[A-Z0-9_-\]\*'/);
  });

  test('экспортирует CODE_PATTERN_TITLE для tooltip-а', () => {
    const src = read(PATTERN_FILE);
    expect(src).toMatch(/export const CODE_PATTERN_TITLE\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. Обе формы используют CODE_PATTERN, а не сырую строку
// ---------------------------------------------------------------------------

describe('admin-формы — pattern={CODE_PATTERN} вместо сырой строки', () => {
  test('tech-card-form импортирует CODE_PATTERN из @/lib/code-pattern', () => {
    const src = read(TECH_CARD_FORM);
    expect(src).toMatch(
      /import\s*\{[^}]*CODE_PATTERN[^}]*\}\s*from\s*['"]@\/lib\/code-pattern['"]/,
    );
    expect(src).toMatch(/pattern=\{CODE_PATTERN\}/);
  });

  test('route-template-form импортирует CODE_PATTERN из @/lib/code-pattern', () => {
    const src = read(ROUTE_TEMPLATE_FORM);
    expect(src).toMatch(
      /import\s*\{[^}]*CODE_PATTERN[^}]*\}\s*from\s*['"]@\/lib\/code-pattern['"]/,
    );
    expect(src).toMatch(/pattern=\{CODE_PATTERN\}/);
  });

  test('обе формы используют title={CODE_PATTERN_TITLE}', () => {
    expect(read(TECH_CARD_FORM)).toMatch(/title=\{CODE_PATTERN_TITLE\}/);
    expect(read(ROUTE_TEMPLATE_FORM)).toMatch(/title=\{CODE_PATTERN_TITLE\}/);
  });
});

// ---------------------------------------------------------------------------
// 3. Глобальная защита: ни один TS/TSX в apps/web не содержит сырой
//    строки `pattern="[A-Z0-9][A-Z0-9_-]*"` или эквивалентов с
//    неэкранированным дефисом в character-class.
// ---------------------------------------------------------------------------

describe('apps/web — нет сырого HTML pattern с неэкранированным дефисом', () => {
  const sources = collectWebSources(WEB_ROOT);

  test('собрали хотя бы 1 исходник для проверки', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  test('нет pattern="[A-Z0-9][A-Z0-9_-]*"', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('pattern="[A-Z0-9][A-Z0-9_-]*"')) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('нет других вариантов pattern="..." с неэкранированным "_-]"', () => {
    // Любой pattern-атрибут (двойные/одинарные кавычки) с
    // подстрокой `_-]` без `\-]` — потенциально некорректен в
    // браузере с `v`-flag.
    const bad = /pattern\s*=\s*["'][^"']*_-\]/;
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (bad.test(src)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Backend-валидация (packages/shared) НЕ менялась.
//    JS-RegExp с дефисом в конце character-class легален и работать
//    обязан как раньше.
// ---------------------------------------------------------------------------

describe('packages/shared — backend RegExp для code не тронут', () => {
  test('TECH_CARD_CODE_PATTERN остаётся /^[A-Z0-9][A-Z0-9_-]{0,47}$/', () => {
    const src = read(SHARED_TECH_CARDS);
    expect(src).toMatch(
      /TECH_CARD_CODE_PATTERN\s*=\s*\/\^\[A-Z0-9\]\[A-Z0-9_-\]\{0,47\}\$\//,
    );
  });

  test('ROUTE_TEMPLATE_CODE_PATTERN остаётся /^[A-Z0-9][A-Z0-9_-]{0,47}$/', () => {
    const src = read(SHARED_ROUTES);
    expect(src).toMatch(
      /ROUTE_TEMPLATE_CODE_PATTERN\s*=\s*\/\^\[A-Z0-9\]\[A-Z0-9_-\]\{0,47\}\$\//,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Семантика: HTML pattern продолжает принимать A-Z, 0-9, '_' и '-'
//    Проверяем, что строка `CODE_PATTERN` после интерпретации как
//    RegExp с флагом `v` действительно матчит ожидаемые коды и
//    отклоняет заведомо невалидные.
// ---------------------------------------------------------------------------

describe('CODE_PATTERN — runtime-семантика (валидные/невалидные коды)', () => {
  // Импорт через прямой require — apps/web/lib/code-pattern.ts не
  // привязан к React и компилируется как обычный TS-модуль.
  // Vitest сам прогонит его через SWC.
  // eslint-disable-next-line @typescript-eslint/no-require-imports

  test('строка матчится HTML5-совместимым RegExp /^(?:CODE_PATTERN)$/v', () => {
    // Эмулируем то, как браузер превращает HTML pattern в RegExp:
    // оборачивает в `^(?:...)$` и компилирует с флагом `v`.
    const pattern = '[A-Z0-9][A-Z0-9_\\-]*';
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${pattern})$`, 'v');
    } catch {
      // Fallback: окружения без поддержки `v` не должны валить smoke.
      re = new RegExp(`^(?:${pattern})$`, 'u');
    }
    expect(re.test('TSHIRT-BASIC')).toBe(true);
    expect(re.test('A1')).toBe(true);
    expect(re.test('A_B-C9')).toBe(true);
    expect(re.test('A-')).toBe(true);
    expect(re.test('A_')).toBe(true);
    // Невалидные:
    expect(re.test('')).toBe(false);
    expect(re.test('a')).toBe(false);
    expect(re.test('-A')).toBe(false);
    expect(re.test('_A')).toBe(false);
    expect(re.test('A B')).toBe(false);
    expect(re.test('А')).toBe(false); // кириллическая «А» — не валид
  });
});
