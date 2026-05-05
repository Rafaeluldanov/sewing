/**
 * Smoke-щит для управленческого удаления паспорта (см.
 * `apps/api/src/modules/passports/passports.controller.ts::delete`,
 * `apps/web/app/orders/[id]/passports/actions.ts`,
 * `docs/domain.md §7.8 «Удаление паспорта»`).
 *
 * Проверяет ровно структуру исходников, чтобы поймать регрессы вида
 * «потёрли DELETE-эндпоинт», «уехали роли с метода», «фронтенд
 * перестал звать action», «корзинку убрали из таблицы». Реальный
 * end-to-end happy-path и блокеры покрываются integration-тестом
 * `tests/integration/passports-delete.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('PassportsController — DELETE /:id под SHOP_MANAGER/ADMIN', () => {
  test('контроллер выставляет @Delete(":id") с RBAC SHOP_MANAGER+ADMIN и 204', () => {
    const src = readSrc('apps/api/src/modules/passports/passports.controller.ts');
    expect(src).toMatch(/@Delete\(['"]:id['"]\)/);
    expect(src).toMatch(/@Roles\(['"]SHOP_MANAGER['"],\s*['"]ADMIN['"]\)/);
    expect(src).toMatch(/@HttpCode\(204\)/);
    expect(src).toMatch(/this\.passports\.delete\(id,\s*user\.employeeId\)/);
  });

  test('PassportsService.delete блокирует BoxItem / APPROVED earnings / POSTED MaterialIssue', () => {
    const src = readSrc('apps/api/src/modules/passports/passports.service.ts');
    expect(src).toMatch(/async delete\(id:\s*string,\s*deleterEmployeeId:\s*string\)/);
    // Импорт всех трёх блокер-классов
    expect(src).toMatch(/PassportPackedDeleteException/);
    expect(src).toMatch(/PassportHasApprovedEarningsException/);
    expect(src).toMatch(/PassportHasPostedMaterialIssueException/);
    // Использование каждого — в `throw new …` внутри метода
    expect(src).toMatch(/throw new PassportPackedDeleteException/);
    expect(src).toMatch(/throw new PassportHasApprovedEarningsException/);
    expect(src).toMatch(/throw new PassportHasPostedMaterialIssueException/);
    // Каскад в транзакции
    expect(src).toMatch(/passportEvent\.deleteMany/);
    expect(src).toMatch(/operationEntry\.deleteMany/);
    expect(src).toMatch(/passportDefect\.deleteMany/);
    // AuditLog с правильным event-неймом
    expect(src).toMatch(/event:\s*['"]PASSPORT_DELETED['"]/);
  });

  test('коды ошибок объявлены в common/errors.ts с CONFLICT-статусом', () => {
    const src = readSrc('apps/api/src/common/errors.ts');
    expect(src).toMatch(/PASSPORT_HAS_BOX/);
    expect(src).toMatch(/PASSPORT_HAS_APPROVED_EARNINGS/);
    expect(src).toMatch(/PASSPORT_HAS_POSTED_MATERIAL_ISSUE/);
    expect(src).toMatch(
      /class PassportPackedDeleteException extends BusinessException/,
    );
    expect(src).toMatch(
      /class PassportHasApprovedEarningsException extends BusinessException/,
    );
    expect(src).toMatch(
      /class PassportHasPostedMaterialIssueException extends BusinessException/,
    );
  });
});

describe('Frontend — server action и кнопки удаления', () => {
  test('lib/passports-api.ts экспортирует deletePassport(id) и зовёт DELETE /passports/:id', () => {
    const src = readSrc('apps/web/lib/passports-api.ts');
    expect(src).toMatch(/export async function deletePassport\(id:\s*string\)/);
    expect(src).toMatch(/method:\s*['"]DELETE['"]/);
    expect(src).toMatch(/\/passports\/\$\{encodeURIComponent\(id\)\}/);
  });

  test('actions.ts: deletePassportAction (без редиректа) и deletePassportFromDetailAction (с редиректом на admin-таб «Паспорта»)', () => {
    const src = readSrc('apps/web/app/orders/[id]/passports/actions.ts');
    expect(src).toMatch(
      /export async function deletePassportAction\(\s*passportId:\s*string,\s*orderId:\s*string,?\s*\)/,
    );
    expect(src).toMatch(
      /export async function deletePassportFromDetailAction\(/,
    );
    // Оба ревалидируют список паспортов в карточке заказа (admin
    // и legacy), чтобы и admin-tab, и legacy-таблица обновились.
    expect(src).toMatch(/revalidatePath\(`\/orders\/\$\{orderId\}`\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
    // Detail-вариант редиректит на admin-карточку, вкладка
    // «Паспорта» — это и есть «предыдущая страница со списком
    // паспортов» из ТЗ. Legacy `/orders/<id>` после удаления
    // показывал кэш с уже удалённой строкой — отказались.
    expect(src).toMatch(
      /redirect\(`\/admin\/orders\/\$\{orderId\}\?tab=passports`\)/,
    );
    // Защита от регресса: больше НЕ редиректим в legacy-карточку.
    expect(src).not.toMatch(/redirect\(`\/orders\/\$\{orderId\}`\)/);
  });

  test('таблица паспортов на /orders/[id] получает canDelete и рендерит DeletePassportButton', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/import\s*\{\s*DeletePassportButton\s*\}/);
    expect(src).toMatch(/canDelete=\{isManager\}/);
    expect(src).toMatch(/<DeletePassportButton\b/);
    expect(src).toMatch(/variant=['"]icon-only['"]/);
  });

  test('DeletePassportButton использует deletePassportAction и иконку trash', () => {
    const src = readSrc(
      'apps/web/app/orders/[id]/passports/delete-passport-button.tsx',
    );
    expect(src).toMatch(/deletePassportAction/);
    expect(src).toMatch(/Icon\s+name=['"]trash['"]/);
    expect(src).toMatch(/window\.confirm/);
  });

  test('Карточка /passports/[id] рендерит «Удалить паспорт» рядом с «К заказу» только для менеджера', () => {
    const src = readSrc('apps/web/app/passports/[id]/page.tsx');
    expect(src).toMatch(/import\s*\{\s*DeleteFromDetailButton\s*\}/);
    expect(src).toMatch(/canDeletePassport\s*=\s*role\s*===\s*['"]SHOP_MANAGER['"]\s*\|\|\s*role\s*===\s*['"]ADMIN['"]/);
    // Кнопка стоит в той же `actions-row`, где «К заказу» — гарантия,
    // что они на одном ряду в UI (а не в отдельных карточках).
    expect(src).toMatch(
      /К заказу[\s\S]{0,400}DeleteFromDetailButton/,
    );
  });

  test('DeleteFromDetailButton зовёт deletePassportFromDetailAction (а не «обычный» action)', () => {
    const src = readSrc(
      'apps/web/app/passports/[id]/delete-from-detail-button.tsx',
    );
    expect(src).toMatch(/deletePassportFromDetailAction/);
    expect(src).not.toMatch(/[^F]deletePassportAction\(/);
  });

  test('Иконка trash объявлена в icon.tsx (новый IconName)', () => {
    const src = readSrc('apps/web/components/icon.tsx');
    expect(src).toMatch(/\|\s*['"]trash['"]/);
    expect(src).toMatch(/trash:\s*\{/);
  });
});

describe('Admin /admin/orders/[id]?tab=passports — корзинка в OrderPassportsTab', () => {
  test('OrderPassportsTab принимает canDelete и рендерит DeletePassportButton после колонки «Крой»', () => {
    const src = readSrc(
      'apps/web/components/orders/view/tabs/order-passports-tab.tsx',
    );
    expect(src).toMatch(/import\s*\{\s*DeletePassportButton\s*\}/);
    expect(src).toMatch(/canDelete:\s*boolean/);
    expect(src).toMatch(/<DeletePassportButton\b/);
    expect(src).toMatch(/variant=['"]icon-only['"]/);
    // Колонка с корзинкой стоит ПОСЛЕ колонки `cutDate` (Крой) —
    // именно так из ТЗ: «в конце каждого паспорта после столбца
    // крой». Проверяем порядок текстуально (cutDate-блок раньше
    // delete-блока).
    const cutDateIdx = src.indexOf("key: 'cutDate'");
    const deleteIdx = src.indexOf("key: 'delete'");
    expect(cutDateIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(0);
    expect(cutDateIdx).toBeLessThan(deleteIdx);
  });

  test('Серверная страница /admin/orders/[id] прокидывает canDelete={isManager}', () => {
    const src = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(src).toMatch(/<OrderPassportsTab\b[^>]*canDelete=\{isManager\}/s);
  });
});
