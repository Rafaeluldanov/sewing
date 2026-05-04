/**
 * Smoke-тест на CUTTER `DefaultActivePanel` (`/work` для CUTTER /
 * менеджера, попавшего на `/work`).
 *
 * Что фиксируем:
 *   1. `.work-tabs` (pill-tabs Шага 13) и `.scan-card` остаются — это
 *      канонический дизайн Шага 13, см. `docs/ui-mobile.md §4.2`.
 *   2. Inline `style={{ display: 'flex', flexDirection: 'column',
 *      gap: '1rem' }}` на корневом контейнере убран — заменён на
 *      класс `.work-active`.
 *   3. Inline `style={{ display: 'flex', justifyContent: 'flex-end' }}`
 *      на форме «Завершить смену» убран — заменён на класс
 *      `.work-active__shift-end`.
 *   4. Inline `style={{ color: 'var(--color-fg-muted)', ... }}` для
 *      «годных N» в result-card убран — заменён на класс
 *      `.result-card__row-meta`.
 *   5. Бизнес-логика (`stopShiftAction`, `issuePassportAction`,
 *      `scanPassportAction`) не тронута.
 *
 * Полный план — `docs/design-cleanup-recon.md §7 Этап 3`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('CUTTER DefaultActivePanel cosmetics (/work)', () => {
  const SRC_PATH = 'apps/web/app/work/active-shift-panel.tsx';

  test('сохраняет канонический Шаг-13 дизайн (.work-tabs + .scan-card)', () => {
    const src = readSrc(SRC_PATH);
    // Pill-tabs (Шаг 13, см. docs/ui-mobile.md §4.2) — остаются.
    expect(src).toMatch(/className="work-tabs"/);
    expect(src).toMatch(/className=\{\s*`work-tab\s/);
    // Scan-card — основа всех терминалов.
    expect(src).toMatch(/className="scan-card"/);
    expect(src).toMatch(/className="scan-card__title"/);
    expect(src).toMatch(/className="scan-card__hint"/);
  });

  test('inline style={{}} убран — используются классы work-active*', () => {
    const src = readSrc(SRC_PATH);
    // Контейнер «активной смены» — теперь класс, не inline-style.
    expect(src).toMatch(/<div className="work-active">/);
    expect(src).not.toMatch(
      /style=\{\{\s*display:\s*'flex',\s*flexDirection:\s*'column',\s*gap:/,
    );
    // Форма «Завершить смену» — класс, не inline.
    expect(src).toMatch(/className="work-active__shift-end"/);
    expect(src).not.toMatch(
      /style=\{\{\s*display:\s*'flex',\s*justifyContent:\s*'flex-end'\s*\}\}/,
    );
  });

  test('result-card meta — теперь класс, не inline color/fontWeight', () => {
    const src = readSrc(SRC_PATH);
    expect(src).toMatch(/className="result-card__row-meta"/);
    // Регрессия: старый inline пропал.
    expect(src).not.toMatch(
      /style=\{\{\s*color:\s*'var\(--color-fg-muted\)',\s*fontWeight:\s*500\s*\}\}/,
    );
  });

  test('бизнес-логика смены/скана не тронута', () => {
    const src = readSrc(SRC_PATH);
    // Server actions те же, что раньше (см. ./actions.ts).
    expect(src).toMatch(/issuePassportAction/);
    expect(src).toMatch(/scanPassportAction/);
    expect(src).toMatch(/stopShiftAction/);
    // Компонент по-прежнему public — экспортирован для page.tsx.
    expect(src).toMatch(/export function ActiveShiftPanel/);
    expect(src).toMatch(/export function CutterAssistantWorkPanel/);
  });

  test('CSS-класс .work-active существует в globals.css', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Точечная проверка нового правила, без хрупких regex-ов на
    // полную форму — достаточно, что класс объявлен.
    expect(css).toMatch(/\.work-active\s*\{/);
    expect(css).toMatch(/\.work-active__shift-end\s*\{/);
    expect(css).toMatch(/\.result-card__row-meta\s*\{/);
  });
});
