/**
 * Smoke-тесты на «Распечатать все паспорта» в кабинете помощника
 * раскройщика (экран успеха рулонного выпуска
 * `/orders/:id/passports/new`).
 *
 * UX по ТЗ:
 *   1. После «Выпустить паспорт» пер-паспортных кнопок печати больше нет —
 *      у каждого паспорта чекбокс (по умолчанию все выбраны), а внизу одна
 *      кнопка «Распечатать», которая печатает выбранные.
 *   2. Печать шлёт по одному `PrintJob` на паспорт (тот же `POST
 *      /api/print-jobs`, что и одиночный `<PrintButton>`); если принтер на
 *      рабочем месте не настроен — открывается браузерная форма
 *      `GET /api/passports/print-batch?ids=…` со всеми выбранными.
 *   3. Backend-форма `print-batch` отдаёт один HTML-документ, каждая
 *      этикетка — на своей странице (`page-break`).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('CUTTER_ASSISTANT — экран успеха: чекбоксы + одна кнопка «Распечатать»', () => {
  const formPath =
    'apps/web/app/orders/[id]/passports/new/cutter-assistant-roll-form.tsx';

  test('файл формы рулонного выпуска существует', () => {
    expect(existsSync(path.join(repoRoot, formPath))).toBe(true);
  });

  test('пер-паспортные кнопки печати убраны (общий PrintButton больше не импортируется)', () => {
    const src = readSrc(formPath);
    expect(src).not.toMatch(/import \{ PrintButton \}/);
    expect(src).not.toMatch(/<PrintButton/);
  });

  test('каждый выпущенный паспорт — чекбокс (выбор по отдельности)', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/type="checkbox"/);
    expect(src).toMatch(/onChange=\{\(\) => togglePrint\(p\.id\)\}/);
    // По умолчанию к печати выбраны все только что выпущенные паспорта.
    expect(src).toMatch(/setPrintSel\(new Set\(created\.map\(\(p\) => p\.id\)\)\)/);
  });

  test('внизу одна кнопка «Распечатать» печатает выбранные', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/Распечатать \(\$\{printSel\.size\}\)/);
    expect(src).toMatch(/handlePrintSelected\(\[\.\.\.printSel\]\)/);
  });

  test('печать использует пакетный action + браузерный fallback', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(
      /import \{ sendPassportPrintJobsBatch \} from '@\/components\/print-button-actions'/,
    );
    expect(src).toMatch(
      /import \{ buildPassportsBatchPrintPath \} from '@\/lib\/browser-api-paths'/,
    );
    // Fallback — открыть браузерную форму печати всех выбранных.
    expect(src).toMatch(/res\.noPrinter/);
    expect(src).toMatch(/window\.open\(buildPassportsBatchPrintPath\(ids\)/);
  });
});

describe('sendPassportPrintJobsBatch — серийная печать с fallback', () => {
  const actionsPath = 'apps/web/components/print-button-actions.ts';

  test('экспортирует пакетный action и распознаёт «нет принтера»', () => {
    const src = readSrc(actionsPath);
    expect(src).toMatch(
      /export async function sendPassportPrintJobsBatch\(/,
    );
    // Те же коды-триггеры fallback, что у одиночного PrintButton.
    expect(src).toMatch(/PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT/);
    expect(src).toMatch(/SHIFT_SESSION_REQUIRED/);
    expect(src).toMatch(/PRINTER_NOT_FOUND/);
    expect(src).toMatch(/noPrinter:\s*true/);
    // Шлёт штатный одиночный PrintJob на каждый паспорт.
    expect(src).toMatch(/sourceType:\s*'PASSPORT_PRINT'/);
  });
});

describe('browser-api-paths — путь пакетной печати', () => {
  const pathsPath = 'apps/web/lib/browser-api-paths.ts';

  test('buildPassportsBatchPrintPath строит /api/passports/print-batch?ids=…', () => {
    const src = readSrc(pathsPath);
    expect(src).toMatch(/export function buildPassportsBatchPrintPath/);
    expect(src).toMatch(/\/api\/passports\/print-batch\?ids=/);
  });
});

describe('backend — пакетная печатная форма паспортов', () => {
  const controllerPath =
    'apps/api/src/modules/passports/passports.controller.ts';
  const printPath = 'apps/api/src/modules/passports/passport-print.ts';

  test('GET /api/passports/print-batch объявлен ДО :id и Public', () => {
    const src = readSrc(controllerPath);
    expect(src).toMatch(/@Get\('print-batch'\)/);
    const batchIdx = src.indexOf("@Get('print-batch')");
    // Именно декоратор маршрута getOne, а не упоминания `@Get(':id')` в
    // комментариях выше.
    const idIdx = src.search(/@Get\(':id'\)\s*\n\s*getOne/);
    expect(batchIdx).toBeGreaterThan(0);
    expect(idIdx).toBeGreaterThan(0);
    // Иначе роутер разрешит print-batch как id="print-batch".
    expect(batchIdx).toBeLessThan(idIdx);
    // Печать без сессии (киоск), как одиночный :id/print.
    const head = src.slice(batchIdx - 200, batchIdx);
    expect(head).toMatch(/@Public\(\)/);
  });

  test('renderPassportsPrintHtml печатает каждую этикетку на своей странице', () => {
    const src = readSrc(printPath);
    expect(src).toMatch(/export function renderPassportsPrintHtml/);
    expect(src).toMatch(/\.sheet \+ \.sheet/);
    expect(src).toMatch(/page-break-before:\s*always/);
  });
});
