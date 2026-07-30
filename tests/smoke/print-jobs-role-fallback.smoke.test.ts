/**
 * Smoke-щит для role-fallback'а при выборе принтера.
 *
 * Регресс-бекстоп для бага «помощник раскройщика жмёт «Распечатать
 * паспорт», и вместо реальной печати открывается HTML в новой вкладке»
 * (см. `docs/cutter-assistant-passport-release-recon.md §«print fallback»`).
 *
 * Корневая причина: `Printer.role` хранит ровно одну роль, поэтому
 * привязка «принтер = `CUTTER`» не покрывала помощника раскройщика
 * (`CUTTER_ASSISTANT`), и `resolvePrinter` валился в
 * `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT` → `PrintButton` уходил в
 * `fallbackHref`-ветку (`window.open(printHref, '_blank')`).
 *
 * Решение: `PRINTER_ROLE_FALLBACKS` объявляет, что помощник делит
 * принтер с основной ролью. `PrintJobsService.resolvePrinter` после
 * фикса перебирает кандидатов из `resolveCandidateRoles(role)`, а не
 * только саму `employee.role`.
 *
 * Тесты исходник-уровневые (vitest без Prisma/БД): проверяем, что
 * карта определена, что `print-jobs.service.ts` её использует, и что
 * фронтовый PrintButton по-прежнему пишет именно «открыта печатная
 * форма в браузере» — это видимый признак того, что fallback на
 * самом деле срабатывает в проде, который мы и хотим устранить
 * через корректную role-привязку.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('PRINTER_ROLE_FALLBACKS — карта «помощник делит принтер с основной ролью»', () => {
  test('printer-role-resolution.ts экспортирует PRINTER_ROLE_FALLBACKS и resolveCandidateRoles', () => {
    const src = readSrc(
      'apps/api/src/modules/printers/printer-role-resolution.ts',
    );
    expect(src).toMatch(
      /export const PRINTER_ROLE_FALLBACKS:\s*Partial<Record<Role,\s*readonly Role\[\]>>/,
    );
    // Справочник ролей (28.07.2026): на ВХОДЕ роль сотрудника — строка
    // (`AppRole.code`, роли заводятся из `/admin/roles`), на ВЫХОДЕ
    // по-прежнему `Role[]` — привязка принтера осталась enum-ом.
    expect(src).toMatch(
      /export function resolveCandidateRoles\([\s\S]*?role:\s*string,\s*\):\s*readonly Role\[\]/,
    );
  });

  test('CUTTER_ASSISTANT в карте имеет fallback на CUTTER (один раскройный стол)', () => {
    const src = readSrc(
      'apps/api/src/modules/printers/printer-role-resolution.ts',
    );
    // Жёстко — в формате `CUTTER_ASSISTANT: [Role.CUTTER]`. Если в
    // будущем добавим больше fallback-ов, регекс адаптируется.
    expect(src).toMatch(
      /CUTTER_ASSISTANT:\s*\[\s*Role\.CUTTER(?:\s*,[^\]]*)?\s*\]/,
    );
  });

  test('resolveCandidateRoles возвращает [role, ...fallbacks] и дедуплицирует', () => {
    const src = readSrc(
      'apps/api/src/modules/printers/printer-role-resolution.ts',
    );
    // Через `Set([...known, ...fallbacks])` — это то самое свойство
    // «своя роль идёт первой». Если кто-то начнёт перевёртывать
    // порядок, тест поймает. `known` — своя роль, отфильтрованная по
    // enum-у: кастомная роль из справочника принтеру не соответствует.
    expect(src).toMatch(/new Set<Role>\(\[\.\.\.known,\s*\.\.\.fallbacks\]\)/);
  });
});

describe('PrintJobsService.resolvePrinter — перебирает candidate roles', () => {
  test('импортирует resolveCandidateRoles из printer-role-resolution', () => {
    const src = readSrc('apps/api/src/modules/printers/print-jobs.service.ts');
    expect(src).toMatch(
      /import\s*\{\s*resolveCandidateRoles\s*\}\s*from\s*['"]\.\/printer-role-resolution\.js['"]/,
    );
  });

  test('resolvePrinter перебирает roles в цикле, а не один findFirst по employee.role', () => {
    const src = readSrc('apps/api/src/modules/printers/print-jobs.service.ts');
    // `for (const role of candidateRoles)` — главный признак нового
    // поведения. Если кто-то откатит обратно к одиночному
    // `findFirst({ role: employee.role, ... })`, тест поймает.
    expect(src).toMatch(/for\s*\(\s*const\s+role\s+of\s+candidateRoles\s*\)/);
    expect(src).toMatch(/resolveCandidateRoles\(employee\.role\)/);
    // Старый прямой findFirst по employee.role не должен вернуться.
    expect(src).not.toMatch(/role:\s*employee\.role,\s*isActive:\s*true/);
  });
});

describe('PrintButton — fallback в окно браузера остаётся как страховка, но НЕ должен срабатывать на штатной печати CUTTER_ASSISTANT', () => {
  test('PrintButton по-прежнему распознаёт PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT и SHIFT_SESSION_REQUIRED как «нет принтера»', () => {
    const src = readSrc('apps/web/components/print-button.tsx');
    // Коды-триггеры fallback-ветки. Контракт ошибок мы не меняем —
    // меняем только логику resolvePrinter, чтобы CUTTER_ASSISTANT
    // вообще не доходил до этой ветки на корректно привязанном
    // принтере (role=CUTTER на раскройном столе).
    expect(src).toMatch(/PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT/);
    expect(src).toMatch(/SHIFT_SESSION_REQUIRED/);
    expect(src).toMatch(/window\.open\(fallbackHref/);
  });
});
