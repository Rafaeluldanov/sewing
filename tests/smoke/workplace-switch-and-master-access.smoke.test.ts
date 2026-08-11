/**
 * Smoke-щит фичи «единое переключение участков + назначение участков
 * мастером» (11.08.2026).
 *
 * Полноценного React-рендера в проекте нет (vitest идёт в Node без
 * jsdom + RTL — см. `tests/smoke/frontend-rbac.smoke.test.ts`), поэтому
 * фиксируем инварианты по исходникам и по чистым хелперам:
 *
 *   1. Переключение участка — ОДИН компонент в корневом layout, значит
 *      во всех кабинетах ведёт себя одинаково; кабинеты про него не
 *      знают и своих переключалок не заводят.
 *   2. Кнопка показывается по НАЗНАЧЕННЫМ ролям (`assignedRoles`), а не
 *      по эффективным: роль с `inherits` раздувает эффективный набор и
 *      кнопка светилась бы человеку с единственным участком.
 *   3. Выбрать участок можно списком (`/api/me/workplaces`), скан QR
 *      остаётся вторым путём — и у сканера своя подсказка, а не «QR-код
 *      паспорта».
 *   4. Белый список ролей мастера закрытый и НЕ содержит
 *      привилегированных ролей; сервер проверяет его сам, а не только
 *      UI. Пара CUTTER + CUTTER_ASSISTANT запрещена: выпуск и стеллаж у
 *      раскройщика уже во вкладках кабинета.
 *   5. Роли мастер правит СВОЕЙ узкой ручкой, а не админским
 *      `PATCH /api/employees/:id` (там же зарплата, PIN, архив).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MASTER_ASSIGNABLE_ROLES,
  isMasterAssignableRole,
} from '../../packages/shared/src/master-employee-stats';
import { getActiveWorkplaceLabel, getActiveWorkplaceRole } from '../../apps/web/lib/rbac';

const ROOT = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('единое переключение участков', () => {
  test('переключалка живёт только в корневом layout — кабинеты своих не заводят', () => {
    const layout = readSrc('apps/web/app/layout.tsx');
    expect(layout).toMatch(/<SwitchWorkplaceButton \/>/);
    const cabinets = [
      'apps/web/app/work/layout.tsx',
      'apps/web/app/qc/layout.tsx',
      'apps/web/app/wto/layout.tsx',
      'apps/web/app/packing/layout.tsx',
      'apps/web/app/cutter/layout.tsx',
      'apps/web/app/constructor/layout.tsx',
    ];
    for (const file of cabinets) {
      expect(readSrc(file), file).not.toMatch(/SwitchWorkplaceButton/);
    }
  });

  test('кнопка показывается по назначенным участкам, а не по эффективным ролям', () => {
    const layout = readSrc('apps/web/app/layout.tsx');
    expect(layout).toMatch(/assignedRoles\.length > 1 \? <SwitchWorkplaceButton/);
    // Старое условие по эффективному набору вернуться не должно.
    expect(layout).not.toMatch(/roles\.length > 1 \? <SwitchWorkplaceButton/);
  });

  test('участок выбирается списком, скан остаётся вторым путём', () => {
    const btn = readSrc('apps/web/components/workplace/switch-workplace-button.tsx');
    expect(btn).toMatch(/loadMyWorkplacesAction/);
    expect(btn).toMatch(/workplace-switch-sheet/);
    // Скан никуда не делся.
    expect(btn).toMatch(/QrScannerModal/);
    // И у него своя подсказка — раньше сканер звал наводить камеру на
    // «QR-код паспорта», хотя сканируют рабочее место.
    expect(btn).toMatch(/hint="Наведите камеру на QR рабочего места\."/);
    const scanner = readSrc('apps/web/app/work/qr-scanner-modal.tsx');
    expect(scanner).toMatch(/hint\?: string/);
  });

  test('бэкенд принимает и код рабочего места, и код участка — ровно один из двух', () => {
    const contract = readSrc('packages/shared/src/workplace.ts');
    expect(contract).toMatch(/code:\s*z[\s\S]*?\.optional\(\)/);
    expect(contract).toMatch(/role:\s*z[\s\S]*?\.optional\(\)/);
    expect(contract).toMatch(/Boolean\(v\.code\) !== Boolean\(v\.role\)/);

    const service = readSrc('apps/api/src/modules/me/me.service.ts');
    // Доступ к участку проверяется по НАЗНАЧЕННОМУ набору: наследование
    // даёт права донора, но не отдельный участок.
    expect(service).toMatch(/loadAssignedRoles/);
    expect(service).toMatch(/WorkplaceRoleForbiddenException/);
    expect(service).toMatch(/listWorkplaces/);
  });

  test('активный участок — единый хелпер, а не копии в терминалах', () => {
    expect(getActiveWorkplaceRole({ role: 'QC', activeRole: 'IRONING' })).toBe(
      'IRONING',
    );
    // Сотрудник ни разу не переключался — остаётся основная роль.
    expect(getActiveWorkplaceRole({ role: 'QC', activeRole: null })).toBe('QC');
    // Подпись считает сервер; fallback — системный словарь.
    expect(
      getActiveWorkplaceLabel({
        role: 'QC',
        activeRole: 'IRONING',
        activeRoleLabel: 'ВТО',
      }),
    ).toBe('ВТО');
    expect(getActiveWorkplaceLabel({ role: 'QC', activeRole: 'IRONING' })).toBe(
      'ВТО',
    );
  });
});

describe('мастер назначает участки', () => {
  test('белый список закрытый и без привилегированных ролей', () => {
    expect([...MASTER_ASSIGNABLE_ROLES]).toEqual([
      'SEAMSTRESS',
      'QC',
      'IRONING',
      'PACKING',
      'CUTTER',
      'CUTTER_ASSISTANT',
    ]);
    for (const role of ['ADMIN', 'SHOP_MANAGER', 'SHOPFLOOR_MASTER', 'SUPERADMIN', 'CONSTRUCTOR']) {
      expect(isMasterAssignableRole(role), role).toBe(false);
    }
    expect(isMasterAssignableRole('IRONING')).toBe(true);
  });

  test('белый список проверяет сервер, а не только UI', () => {
    const service = readSrc(
      'apps/api/src/modules/master-employee-stats/master-employee-stats.service.ts',
    );
    expect(service).toMatch(/isMasterAssignableRole/);
    expect(service).toMatch(/MasterRoleNotAssignableException/);
    // Нельзя редактировать того, у кого уже есть роль вне цеха, —
    // иначе сохранение набора молча отобрало бы ему доступ.
    expect(service).toMatch(/MasterEmployeeNotEditableException/);
    // Раскройщику роль помощника не нужна: выпуск и стеллаж у него уже
    // во вкладках кабинета.
    expect(service).toMatch(/MasterRolePairRedundantException/);
    // Активный участок сбрасывается, если роль ушла из набора.
    expect(service).toMatch(/activeRole/);
  });

  test('мастер ходит своей ручкой, а не админским PATCH /employees/:id', () => {
    const ctrl = readSrc(
      'apps/api/src/modules/master-employee-stats/master-employee-stats.controller.ts',
    );
    expect(ctrl).toMatch(/@Roles\('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN'\)/);
    expect(ctrl).toMatch(/@Put\('access\/:employeeId'\)/);
    expect(ctrl).toMatch(/@Get\('access'\)/);

    // Админский контроллер сотрудников мастеру по-прежнему закрыт.
    const employees = readSrc(
      'apps/api/src/modules/employees/employees.controller.ts',
    );
    expect(employees).not.toMatch(/SHOPFLOOR_MASTER/);
  });

  test('во вкладке «Сотрудники» появился третий режим «Доступы»', () => {
    const view = readSrc('apps/web/app/master/employee-stats-view.tsx');
    expect(view).toMatch(/'stats' \| 'active' \| 'access'/);
    expect(view).toMatch(/EmployeeAccessCard/);
    expect(view).toMatch(/MASTER_ASSIGNABLE_ROLES/);
  });
});
