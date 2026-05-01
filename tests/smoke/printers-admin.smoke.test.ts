/**
 * Smoke-тесты для управления принтерами (`/admin/printers`,
 * `/admin/printers/new`, `/admin/printers/[id]` — см.
 * `docs/screens.md §18`).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без
 * jsdom), поэтому фиксируем структуру на уровне исходников: что
 * нужная кнопка ведёт на отдельную страницу создания, что страница
 * `/admin/printers/new` подключает форму и back-link, что server
 * action редиректит на карточку, и что backend-роут на месте.
 *
 * Этого достаточно, чтобы поймать регресс «удалили кнопку», «вернули
 * inline-форму на список» или «убрали редирект на карточку». Полный
 * happy-path create принтера покрыт integration-тестом
 * `tests/integration/printers.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/printers — список без встроенной формы создания', () => {
  test('страница НЕ подключает CreatePrinterForm и ведёт на /admin/printers/new', () => {
    const src = readSrc('apps/web/app/admin/printers/page.tsx');
    expect(src).not.toMatch(/CreatePrinterForm/);
    expect(src).toMatch(/href="\/admin\/printers\/new"/);
    // Admin UI 2.5: текст action-кнопки сократили до «Добавить»;
    // длинный лейбл «Добавить принтер» остаётся в EmptyState.
    expect(src).toMatch(/Добавить/);
    // Admin UI 2.5: actions переехали в `AdminPageShell`.
    expect(src).toMatch(/AdminPageShell/);
  });

  test('страница /admin/printers/new рендерит форму создания и back-link', () => {
    const src = readSrc('apps/web/app/admin/printers/new/page.tsx');
    expect(src).toMatch(/CreatePrinterForm/);
    expect(src).toMatch(/equipment=\{equipment\}/);
    // Admin UI 2.5: AdminPageShell + back-link через обычный <Link>.
    expect(src).toMatch(/href="\/admin\/printers"/);
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/listEquipment/);
  });

  test('CreatePrinterForm содержит поля name/type/equipmentId и submit', () => {
    const src = readSrc('apps/web/app/admin/printers/create-form.tsx');
    expect(src).toMatch(/name="name"/);
    expect(src).toMatch(/required/);
    expect(src).toMatch(/name="type"/);
    expect(src).toMatch(/PRINTER_TYPES/);
    expect(src).toMatch(/name="equipmentId"/);
    // Admin UI 2.6: текст кнопки сократили до «Создать».
    expect(src).toMatch(/Создать/);
  });

  test('createPrinterAction обращается к POST /api/printers и редиректит на карточку', () => {
    const src = readSrc('apps/web/app/admin/printers/actions.ts');
    expect(src).toMatch(/createPrinter\(/);
    expect(src).toMatch(/redirect\(`\/admin\/printers\/\$\{createdId\}`\)/);
    expect(src).toMatch(/revalidatePath\('\/admin\/printers'\)/);
    expect(src).toMatch(/Имя принтера обязательно/);
  });
});

describe('backend printers контракт', () => {
  test('контроллер выставляет POST /printers с CreatePrinterSchema под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc('apps/api/src/modules/printers/printers.controller.ts');
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/CreatePrinterSchema/);
    expect(src).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
  });

  test('CreatePrinterSchema умеет name/type/equipmentId и не требует чего-то лишнего', () => {
    const src = readSrc('packages/shared/src/printers.ts');
    expect(src).toMatch(/CreatePrinterSchema\s*=\s*z\.object\(/);
    expect(src).toMatch(/name:\s*NonEmptyString\(120\)/);
    expect(src).toMatch(/type:\s*z\.enum\(PRINTER_TYPES\)\.default\('DEFAULT'\)/);
    expect(src).toMatch(/equipmentId:\s*z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/);
  });
});
