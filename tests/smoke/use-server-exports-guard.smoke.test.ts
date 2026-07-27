/**
 * Сторож инварианта Next.js App Router: файл с директивой
 * `'use server'` может экспортировать ТОЛЬКО async-функции.
 *
 * Почему это отдельный тест, а не «здравый смысл»:
 *   - нарушение не ловится ни `tsc`, ни `next lint`, ни сборкой —
 *     `next build` проходит зелёным;
 *   - падает оно в РАНТАЙМЕ, при первом рендере страницы, которая
 *     подтянула такой модуль:
 *       «A "use server" file can only export async functions,
 *        found object»
 *     и роняет ВСЮ страницу в `Application error: a server-side
 *     exception has occurred`, а не только свою форму;
 *   - соблазн велик: `export const initialXxxFormState = {}` рядом с
 *     экшеном для `useFormState` выглядит абсолютно естественно.
 *
 * Так уже падала карточка заказа `/admin/orders/[id]`: объект
 * `initialOrderApplicationsFormState` лежал в `applications-actions.ts`
 * и вместе с блоком «Нанесение» убивал страницу целиком.
 *
 * Лечение — вынести тип и initial state в соседний модуль без
 * директивы (`*-form-state.ts`), экшены оставить в `*-actions.ts`.
 * Типы (`export interface` / `export type`) стираются при компиляции
 * и инвариант не нарушают — их не трогаем.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const webRoot = path.join(repoRoot, 'apps', 'web');
const SCAN_DIRS = ['app', 'components', 'lib'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Файлы `apps/web`, у которых `'use server'` стоит директивой модуля. */
function useServerFiles(): { rel: string; src: string }[] {
  const found: { rel: string; src: string }[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(webRoot, dir))) {
      const src = readFileSync(file, 'utf8');
      // Директива модуля — только в самом начале файла (до неё
      // допустимы лишь комментарии и пустые строки).
      if (!/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"];/.test(src)) {
        continue;
      }
      found.push({ rel: path.relative(repoRoot, file), src });
    }
  }
  return found;
}

describe('Next.js: `use server` файлы экспортируют только async-функции', () => {
  const files = useServerFiles();

  test('в apps/web вообще есть server-action модули (сканер жив)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test('ни один `use server` файл не экспортирует значение (const/let/class/enum)', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/^export\s+(const|let|var|class|enum)\s/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'Вынеси значение в соседний модуль без `use server` ' +
        '(конвенция репозитория — `*-form-state.ts`), иначе страница ' +
        'падает в рантайме целиком.',
    ).toEqual([]);
  });

  test('ни один `use server` файл не имеет default-экспорта', () => {
    const offenders = files
      .filter(({ src }) => /^export\s+default\s/m.test(src))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
