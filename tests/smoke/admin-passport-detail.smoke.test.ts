/**
 * Smoke-щит для admin-карточки паспорта `/admin/passports/[id]`
 * (Admin UI 2.6 — переход legacy-страницы паспорта на admin-chrome
 * со sidebar).
 *
 * Покрывает:
 *   - что новая страница реально лежит в `app/admin/passports/[id]`;
 *   - что использует admin-chrome (`AdminPageShell`/`AdminCard`/
 *     `AdminSectionHeader`), а не legacy `AppSectionCard`/`page-shell`;
 *   - что legacy `/passports/[id]` редиректит ADMIN/SHOP_MANAGER
 *     на admin-версию (через `redirect('/admin/passports/...')`);
 *   - что admin-side ссылки (OrderPassportsTab, payroll/employees,
 *     overview) теперь ведут на `/admin/passports/[id]`;
 *   - что server-actions (work, qc, wto, packing, cutting closure,
 *     delete) ревалидируют и `/admin/passports/[id]`, чтобы кэш
 *     админки не висел.
 *
 * Реальный happy-path проверяется только глазами/UI; здесь нам
 * нужен барьер, чтобы случайный `git stash pop` не поломал шапку.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Admin /admin/passports/[id] — admin-chrome вместо legacy header', () => {
  test('страница использует AdminPageShell + AdminCard + AdminSectionHeader', () => {
    const src = readSrc('apps/web/app/admin/passports/[id]/page.tsx');
    expect(src).toMatch(/from '@\/components\/admin'/);
    expect(src).toMatch(/<AdminPageShell\b/);
    expect(src).toMatch(/<AdminCard\b/);
    expect(src).toMatch(/<AdminSectionHeader\b/);
    expect(src).toMatch(/<AdminStatusBadge\b/);
    // Никаких legacy-обёрток на новой странице — мы их специально
    // вынесли на legacy `/passports/[id]`, чтобы не возникала
    // двойная разметка.
    expect(src).not.toMatch(/AppSectionCard/);
    expect(src).not.toMatch(/className=['"]page-shell/);
    expect(src).not.toMatch(/className=['"]passport-hero/);
  });

  test('страница даёт actions: «К заказу», PrintButton и DeleteFromDetailButton', () => {
    const src = readSrc('apps/web/app/admin/passports/[id]/page.tsx');
    expect(src).toMatch(/<PrintButton\b/);
    expect(src).toMatch(/<DeleteFromDetailButton\b/);
    // Менеджер возвращается на admin-карточку заказа (вкладка
    // «Паспорта»), а не на legacy `/orders/[id]` — это и есть
    // «куда вернуться» из admin-chrome.
    expect(src).toMatch(
      /href=\{`\/admin\/orders\/\$\{passport\.orderId\}\?tab=passports`\}/,
    );
  });

  test('страница рендерит секции «Сведения» / «ОТК» / «Упаковка» / «Размещение»', () => {
    const src = readSrc('apps/web/app/admin/passports/[id]/page.tsx');
    expect(src).toMatch(/title=['"]Сведения['"]/);
    expect(src).toMatch(/title=['"]ОТК['"]/);
    expect(src).toMatch(/title=['"]Упаковка['"]/);
    expect(src).toMatch(/title=['"]Размещение в ячейке['"]/);
    expect(src).toMatch(/title=['"]QR-этикетка['"]/);
  });

  test('страница reuse-ит PlaceForm / CuttingClosureSection / DeleteFromDetailButton из legacy-папки', () => {
    const src = readSrc('apps/web/app/admin/passports/[id]/page.tsx');
    expect(src).toMatch(
      /from '@\/app\/passports\/\[id\]\/place-form'/,
    );
    expect(src).toMatch(
      /from '@\/app\/passports\/\[id\]\/cutting-closure-section'/,
    );
    expect(src).toMatch(
      /from '@\/app\/passports\/\[id\]\/delete-from-detail-button'/,
    );
  });
});

describe('Legacy /passports/[id] — редиректит ADMIN/SHOP_MANAGER на admin-версию', () => {
  test('страница импортирует redirect и зовёт его до запросов данных для admin/manager', () => {
    const src = readSrc('apps/web/app/passports/[id]/page.tsx');
    expect(src).toMatch(/from 'next\/navigation'/);
    expect(src).toMatch(/\bredirect\b/);
    expect(src).toMatch(
      /redirect\(`\/admin\/passports\/\$\{params\.id\}`\)/,
    );
    // Проверка, что условие явно бьёт по обеим менеджерским ролям.
    expect(src).toMatch(
      /role\s*===\s*['"]ADMIN['"]\s*\|\|\s*me\?\.user\.role\s*===\s*['"]SHOP_MANAGER['"]/,
    );
  });
});

describe('Admin-side ссылки на `/passports/[id]` обновлены на `/admin/passports/[id]`', () => {
  test('OrderPassportsTab: ссылка из таблицы паспортов ведёт в admin-карточку', () => {
    const src = readSrc(
      'apps/web/components/orders/view/tabs/order-passports-tab.tsx',
    );
    expect(src).toMatch(/href=\{`\/admin\/passports\/\$\{p\.id\}`\}/);
    expect(src).not.toMatch(/href=\{`\/passports\/\$\{p\.id\}`\}/);
  });

  test('admin/payroll/employees/[id]: passport-ссылки в таблице начислений ведут в admin-карточку', () => {
    const src = readSrc('apps/web/app/admin/payroll/employees/[id]/page.tsx');
    expect(src).toMatch(
      /href=\{`\/admin\/passports\/\$\{e\.passportId\}`\}/,
    );
    expect(src).not.toMatch(/href=\{`\/passports\/\$\{e\.passportId\}`\}/);
  });

  test('admin/overview: «Где паспорт» в таблице ведёт в admin-карточку', () => {
    const src = readSrc('apps/web/app/admin/overview/page.tsx');
    expect(src).toMatch(
      /href=\{`\/admin\/passports\/\$\{p\.passportId\}`\}/,
    );
  });
});

describe('Server actions ревалидируют и `/admin/passports/[id]`', () => {
  test('orders/[id]/passports/actions.ts: place / delete / closure ревалидируют admin-URL', () => {
    const src = readSrc('apps/web/app/orders/[id]/passports/actions.ts');
    // Минимум 4 вхождения revalidatePath(`/admin/passports/${...}`)
    // (createPassport.created.id, place, deletePassportAction,
    // deletePassportFromDetailAction).
    const matches = src.match(/revalidatePath\(`\/admin\/passports\/\$\{[^`]+\}`\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(4);
  });

  test('passports/[id]/cutting-closure-actions.ts: все три (request/approve/reject) ревалидируют admin-URL', () => {
    const src = readSrc(
      'apps/web/app/passports/[id]/cutting-closure-actions.ts',
    );
    const matches = src.match(/revalidatePath\(`\/admin\/passports\/\$\{passportId\}`\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  test('work/qc/wto/packing/shelf-placement actions ревалидируют admin-URL после изменения паспорта', () => {
    for (const file of [
      'apps/web/app/work/actions.ts',
      'apps/web/app/qc/actions.ts',
      'apps/web/app/wto/actions.ts',
      'apps/web/app/packing/actions.ts',
      'apps/web/app/work/shelf-placement-actions.ts',
    ]) {
      const src = readSrc(file);
      expect(src).toMatch(/revalidatePath\(`\/admin\/passports\/\$\{[^`]+\}`\)/);
    }
  });
});
