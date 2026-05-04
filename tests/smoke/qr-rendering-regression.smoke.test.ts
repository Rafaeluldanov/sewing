/**
 * Регрессионный smoke для QR-рендера на frontend.
 *
 * Контекст: однажды QR-коды разом перестали отображаться во всех
 * местах из-за неправильного импорта `qrcode.react` (default-импорт
 * вместо named, и попадание клиентского компонента в server boundary
 * без `'use client'`). Чтобы это не повторилось:
 *
 *   1. Существует ровно один централизованный рендер —
 *      `apps/web/components/qr/qr-code-view.tsx`.
 *   2. Он использует именно `import { QRCodeSVG } from 'qrcode.react'`
 *      (а не `import QRCode from 'qrcode.react'` — такого default-
 *      экспорта в v4 не существует, проект просто не соберётся).
 *   3. Никто кроме QrCodeView не импортирует `qrcode.react`. Если
 *      где-то ещё появился прямой импорт — этот тест поднимет тревогу
 *      и попросит пройти через QrCodeView.
 *   4. Никто не зовёт внешние QR-API: сканер пилота не должен
 *      ходить в публичный интернет за картинкой токена.
 *   5. `html5-qrcode` остаётся только в сканер-файлах — это другая
 *      библиотека и другая поверхность.
 *
 * Vitest здесь идёт без jsdom, поэтому проверяем то, что можно
 * прочитать как текст: импорты, testid'ы, fallback-текст.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const QR_VIEW_SRC = 'apps/web/components/qr/qr-code-view.tsx';
const QR_BARREL_SRC = 'apps/web/components/qr/index.ts';

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Поиск использований `qrcode.react` через `git grep` — он быстрее
 * рекурсивного walk'а и автоматически уважает `.gitignore`
 * (отсекает `node_modules`, `.next`, артефакты сборки).
 */
function gitGrepImports(needle: string): string[] {
  try {
    const out = execSync(
      `git grep -n -- ${JSON.stringify(needle)} -- 'apps/**' 'packages/**'`,
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // git grep exits 1 when nothing matched — это валидный кейс.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

describe('QrCodeView — единый клиентский рендер QR', () => {
  test('файл существует и помечен как client component', () => {
    const src = readSrc(QR_VIEW_SRC);
    expect(src).toMatch(/^'use client'/);
  });

  test('использует named import QRCodeSVG, не default', () => {
    const src = readSrc(QR_VIEW_SRC);
    expect(src).toMatch(/import\s*\{\s*QRCodeSVG\s*\}\s*from\s*'qrcode\.react'/);
    // default-импорт qrcode.react в v4 не существует — компонент
    // должен был бы упасть на сборке.
    expect(src).not.toMatch(/import\s+QRCode\s+from\s+'qrcode\.react'/);
    // У qrcode.react v4 нет CommonJS default — `* as QRCode` тоже
    // делать не надо: получим объект-ns с named экспортами.
    expect(src).not.toMatch(/import\s*\*\s*as\s+QRCode\s+from\s+'qrcode\.react'/);
  });

  test('пустой/null/undefined value показывает fallback, а не падает', () => {
    const src = readSrc(QR_VIEW_SRC);
    expect(src).toMatch(/typeof value === 'string'/);
    expect(src).toMatch(/normalizedValue\.length === 0/);
    expect(src).toContain('QR-код недоступен');
    expect(src).toMatch(/qr-code-view--empty/);
  });

  test('SVG имеет data-testid="qr-code-svg", wrapper — "qr-code-view"', () => {
    const src = readSrc(QR_VIEW_SRC);
    expect(src).toContain('data-testid="qr-code-view"');
    expect(src).toContain('data-testid="qr-code-svg"');
  });

  test('не использует внешние QR API и unsafe-DOM', () => {
    const src = readSrc(QR_VIEW_SRC);
    expect(src).not.toMatch(/api\.qrserver\.com/i);
    expect(src).not.toMatch(/chart\.googleapis\.com/i);
    expect(src).not.toMatch(/quickchart\.io/i);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    // window/document на верхнем уровне (вне обработчиков) ломали бы
    // SSR — а этот компонент уже client, но всё же страхуемся.
    expect(src).not.toMatch(/^[^/]*\bwindow\.[A-Za-z]/m);
    expect(src).not.toMatch(/^[^/]*\bdocument\.[A-Za-z]/m);
  });

  test('barrel-экспорт публикует QrCodeView', () => {
    const src = readSrc(QR_BARREL_SRC);
    expect(src).toMatch(/export\s*\{\s*QrCodeView\s*\}/);
  });
});

describe('Никто кроме QrCodeView не импортирует qrcode.react', () => {
  test('git grep по apps/** и packages/** возвращает только qr-code-view.tsx', () => {
    const hits = gitGrepImports("from 'qrcode.react'");
    const offenders = hits.filter((line) => {
      const file = line.split(':')[0];
      // Разрешаем единственный файл — сам централизованный рендер.
      // Также разрешаем тестовые snapshot'ы — у них в исходниках
      // могут быть строковые «import from 'qrcode.react'» в литералах
      // ассертов, но в текущем репо таких файлов нет, поэтому пока
      // фильтр строгий.
      return file !== QR_VIEW_SRC;
    });
    expect(offenders, `Лишний прямой импорт qrcode.react: ${offenders.join('\n')}`)
      .toEqual([]);
  });
});

describe('html5-qrcode — только в файлах сканера', () => {
  test('импортируется только в qr-scanner-modal.tsx', () => {
    const hits = gitGrepImports("'html5-qrcode'");
    const files = Array.from(
      new Set(hits.map((line) => line.split(':')[0])),
    ).sort();
    // Допустимые места: модалка сканера (динамический import) и
    // package.json как декларация зависимости.
    const allowed = new Set([
      'apps/web/app/work/qr-scanner-modal.tsx',
      'apps/web/package.json',
    ]);
    const offenders = files.filter((f) => !allowed.has(f));
    expect(offenders).toEqual([]);
  });
});

describe('EmployeeQrButton сидит на QrCodeView', () => {
  test('импортирует QrCodeView и не использует прямой qrcode.react', () => {
    const src = readSrc('apps/web/components/employees/employee-qr-button.tsx');
    expect(src).toMatch(/QrCodeView/);
    expect(src).not.toMatch(/from 'qrcode\.react'/);
    expect(src).not.toMatch(/<QRCodeCanvas\b/);
    expect(src).not.toMatch(/<QRCodeSVG\b/);
  });
});
