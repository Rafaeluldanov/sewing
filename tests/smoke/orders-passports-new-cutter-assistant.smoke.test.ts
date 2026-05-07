/**
 * Smoke regression для P0-7: выпуск паспорта помощником раскройщика
 * (`CUTTER_ASSISTANT`) не должен дёргать admin-only `/api/employees`.
 *
 * **Контекст production-инцидента (см. `docs/test-gap-plan.md §P0-7`,
 * `docs/operations-test-recon.md §6 invariant 8):**
 *   1. CUTTER_ASSISTANT идёт `/work` → `/work/cut-orders` → нажимает
 *      «Выпустить паспорт».
 *   2. Next.js ведёт на `/orders/[id]/passports/new`.
 *   3. SSR-страница вызывает `listEmployees({active:true, role:'CUTTER'})`.
 *   4. Этот endpoint защищён `@Roles('SHOP_MANAGER','ADMIN')` —
 *      CUTTER_ASSISTANT получает 403 `FORBIDDEN_ROLE` и видит
 *      «server-side exception has occurred».
 *
 * **Правильное поведение (целевое):**
 *   - в page.tsx ветка `isCutter || isCutterAssistant ? [] : ...`,
 *     либо вызов узкого `listActiveCutters()`/`/api/employees/cutters`;
 *   - backend выставляет `@Get('cutters')` с `@Roles('CUTTER_ASSISTANT',
 *     'SHOP_MANAGER', 'ADMIN')` ВЫШЕ `@Get(':id')` (иначе попадёт в
 *     wildcard и упадёт в 404 NOT_FOUND);
 *   - service возвращает только `id/fullName/login` — без
 *     `salaryPerShift`/`compensationType`/`pinHash` etc.
 *
 * **Текущая реальность (на момент написания smoke):**
 * production-баг всё ещё присутствует. Этот smoke написан как
 * **characterization-тест**: он пинит фактическое состояние и
 * документирует расхождение с целевым контрактом. Когда production
 * будет исправлен, FINDING-тесты упадут и станут «канареечной
 * сигнализацией» — обновляются вместе с фиксом.
 *
 * Подход «текстовый smoke по исходникам» — тот же, что в
 * `route-wip-work-ui.smoke.test.ts`, `route-hint-modal.smoke.test.ts`,
 * `seamstress-feedback.smoke.test.ts`: vitest идёт в Node без jsdom,
 * мы фиксируем контракт регулярками по содержимому файлов.
 *
 * Findings — `docs/operations-test-findings.md` (P0-7 entries).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}
function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

describe('P0-7: CUTTER_ASSISTANT passport release should not hit admin-only employees', () => {
  // ---------------------------------------------------------------------------
  // 1. Файлы на местах
  // ---------------------------------------------------------------------------

  test('route /orders/[id]/passports/new существует', () => {
    expect(
      exists('apps/web/app/orders/[id]/passports/new/page.tsx'),
    ).toBe(true);
    expect(
      exists('apps/web/app/orders/[id]/passports/new/new-passport-form.tsx'),
    ).toBe(true);
  });

  test('route /work/cut-orders существует и ведёт на /orders/[id]/passports/new', () => {
    const src = read('apps/web/app/work/cut-orders/page.tsx');
    // Authoritative: backend `GET /api/orders?status=IN_PRODUCTION`
    // открыт CUTTER_ASSISTANT, страница использует listOrders без
    // дёргания /api/employees.
    expect(src).toMatch(/listOrders\b/);
    expect(src).not.toMatch(/listEmployees\b/);
    expect(src).toMatch(/\/orders\/\$\{[^}]+\}\/passports\/new/);
  });

  // ---------------------------------------------------------------------------
  // 2. Бэкенд employees.controller — wide /api/employees admin-only;
  //    /api/employees/cutters пока не существует (FINDING).
  // ---------------------------------------------------------------------------

  test('GET /api/employees защищён @Roles(SHOP_MANAGER, ADMIN) на уровне контроллера', () => {
    const src = read(
      'apps/api/src/modules/employees/employees.controller.ts',
    );
    // Контроллер-level Roles ставит барьер на ВСЕ маршруты этого
    // контроллера, кроме @Public(). CUTTER_ASSISTANT в списке нет —
    // если когда-нибудь добавят, это знак, что широкий endpoint
    // открыли роли, которой видна вся payroll-чувствительная
    // карточка. Здесь это намеренно блокируем.
    expect(src).toMatch(
      /@Roles\(['"]SHOP_MANAGER['"]\s*,\s*['"]ADMIN['"]\)\s*\n@Controller\(['"]employees['"]\)/,
    );
    expect(src).not.toMatch(/@Roles\([^)]*['"]CUTTER_ASSISTANT['"][^)]*\)/);
  });

  test('FINDING: /api/employees/cutters endpoint пока не существует — page.tsx вынужден ходить через широкий /api/employees', () => {
    const src = read(
      'apps/api/src/modules/employees/employees.controller.ts',
    );
    // Целевой узкий endpoint: @Get('cutters'). Если он появится,
    // тест упадёт — обновить smoke и снять FINDING из
    // docs/operations-test-findings.md.
    expect(src).not.toMatch(/@Get\(['"]cutters['"]\)/);
  });

  // ---------------------------------------------------------------------------
  // 3. Frontend helper. listActiveCutters пока не существует (FINDING),
  //    но employees-api.ts должен оставаться без CA-заточенного fallback'а
  //    в широком listEmployees().
  // ---------------------------------------------------------------------------

  test('FINDING: lib/employees-api.ts пока не имеет узкого listActiveCutters helper', () => {
    const src = read('apps/web/lib/employees-api.ts');
    expect(src).toMatch(/export\s+function\s+listEmployees\b/);
    expect(src).not.toMatch(/listActiveCutters\b/);
  });

  // ---------------------------------------------------------------------------
  // 4. **Главный FINDING-тест**: SSR страница `/orders/[id]/passports/new`
  //    всё ещё вызывает широкий listEmployees для CUTTER_ASSISTANT
  //    (production-баг), потому что ветка `isCutter ? []` не покрывает
  //    CUTTER_ASSISTANT.
  // ---------------------------------------------------------------------------

  test('page.tsx содержит safe-условие isCutter (creator с role=CUTTER) и пропускает employees для него', () => {
    const src = read(
      'apps/web/app/orders/[id]/passports/new/page.tsx',
    );
    // Authoritative invariant, который УЖЕ работает: для creator-CUTTER
    // backend сам подставляет атрибуцию, и UI не загружает список.
    expect(src).toMatch(/isCutter\s*=\s*me\?\.user\.role\s*===\s*['"]CUTTER['"]/);
    expect(src).toMatch(/isCutter\s*\?\s*\[\]/);
  });

  test('FINDING: page.tsx НЕ имеет safe-условия для CUTTER_ASSISTANT — listEmployees все ещё вызывается для CA', () => {
    const src = read(
      'apps/web/app/orders/[id]/passports/new/page.tsx',
    );
    // Текущая реальность: вызов есть, и он не защищён от CA.
    expect(src).toMatch(/listEmployees\(\s*\{[^}]*role:\s*['"]CUTTER['"]/);

    // Безопасные ветки, которые сделали бы запрос условным для CA,
    // отсутствуют. Эти регулярки — антипаттерны: если они начнут
    // совпадать, FINDING закрыт и тест нужно обновить.
    expect(src).not.toMatch(/isCutterAssistant\s*\?\s*\[\]\s*:/);
    expect(src).not.toMatch(
      /role\s*===\s*['"]CUTTER_ASSISTANT['"][^}]*\?\s*\[\]/,
    );
    expect(src).not.toMatch(/listActiveCutters\b/);
  });

  // ---------------------------------------------------------------------------
  // 5. Поверхность данных. Подтверждаем, что широкий EmployeeListItemDto
  //    несёт чувствительные поля — этим обосновываем «нельзя широким
  //    endpoint-ом отдавать CA». Если кто-то добавит /cutters endpoint,
  //    у него в DTO этих полей быть не должно.
  // ---------------------------------------------------------------------------

  test('shared EmployeeListItemDto содержит payroll-чувствительные поля (compensationType, salaryPerShift)', () => {
    const src = read('packages/shared/src/employees.ts');
    expect(src).toMatch(/EmployeeListItemDto\b[\s\S]*?salaryPerShift/);
    expect(src).toMatch(/EmployeeListItemDto\b[\s\S]*?compensationType/);
  });

  test('FINDING: shared не содержит узкого ActiveCutterListItemDto (узкая схема пока не введена)', () => {
    const src = read('packages/shared/src/employees.ts');
    expect(src).not.toMatch(/\bActiveCutterListItemDto\b/);
    expect(src).not.toMatch(/\bCutterLite\b/);
  });

  // ---------------------------------------------------------------------------
  // 6. UX: страница не должна показывать generic «server-side exception»
  //    как нормальный fallback. Текущая страница вообще не имеет
  //    catch-блока вокруг listEmployees — что и приводит к серверной
  //    ошибке Next.js. Pin'им именно отсутствие осмысленного fallback'а
  //    как часть FINDING'а.
  // ---------------------------------------------------------------------------

  test('FINDING: page.tsx не имеет catch вокруг listEmployees — 403 для CA пробрасывается как server-side exception', () => {
    const src = read(
      'apps/web/app/orders/[id]/passports/new/page.tsx',
    );
    // Грубо: ищем вызов listEmployees и проверяем, что в той же
    // лексической области нет `try`/`catch`. Достаточно для smoke:
    // если кто-то обернёт в try/catch, регулярка обновляется вместе
    // с фиксом.
    const callMatch = src.match(/(await\s+listEmployees\([\s\S]*?\);)/);
    expect(callMatch, 'expected listEmployees call to be present').toBeTruthy();
    // Контекст +/- 200 символов вокруг вызова не содержит try/catch.
    const idx = src.indexOf(callMatch![1]);
    const context = src.slice(Math.max(0, idx - 200), idx + 200);
    expect(context).not.toMatch(/\btry\s*\{/);
  });

  // ---------------------------------------------------------------------------
  // 7. Существующие зелёные smoke-файлы должны ссылаться на роли —
  //    мы не сломали матрицу ролей.
  // ---------------------------------------------------------------------------

  test('frontend-rbac smoke ссылается на роль CUTTER_ASSISTANT и сохраняет её матрицу', () => {
    const src = read('tests/smoke/frontend-rbac.smoke.test.ts');
    expect(src).toMatch(/CUTTER_ASSISTANT/);
  });
});
