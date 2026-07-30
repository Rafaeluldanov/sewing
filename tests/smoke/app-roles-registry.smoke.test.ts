/**
 * Smoke-тест «Справочник ролей» (`/admin/roles`).
 *
 * Роль перестала быть значением Prisma-enum `Role`: она заводится из
 * админки (`AppRole`), а права получает НАСЛЕДОВАНИЕМ от системных
 * ролей. Тест сторожит ровно те инварианты, поломка которых тихая —
 * то есть typecheck и билд промолчат, а доступ поедет:
 *
 *   1. `expandRoleCodes` раскрывает наследование транзитивно и не
 *      зависает на циклах (на нём висит ВСЯ авторизация).
 *   2. Колонки ролей сотрудника — `String`, а не enum; иначе новая роль
 *      не запишется в БД.
 *   3. Сид системных ролей в миграции совпадает с
 *      `SYSTEM_ROLE_DEFAULTS` — два списка расходятся молча, и роль
 *      получает чужой рабочий экран.
 *   4. `AuthGuard` сверяет `@Roles(...)` с ЭФФЕКТИВНЫМ набором, а
 *      `resolvePrincipal` считает его на лету (не из токена) — иначе
 *      правка наследования не догоняет уже вошедших сотрудников.
 *   5. `@Roles(...)` остаются написаны на СИСТЕМНЫХ кодах: как только
 *      в декоратор попадёт кастомный код, приложение снова начнёт
 *      зависеть от данных.
 *   6. Гейты `purge`: системную роль не снести, выданную — тоже.
 *   7. Post-login редирект берёт рабочий экран С СЕРВЕРА. Это главная
 *      засада фичи: без него кастомная роль не находится в
 *      захардкоженной матрице и вход заканчивается на `/login`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  SYSTEM_ROLE_CODES,
  SYSTEM_ROLE_DEFAULTS,
  areAllSystemRoles,
  expandRoleCodes,
  findInheritanceCycle,
  resolveRoleWorkspace,
} from '@sewing/shared/app-roles';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const MIGRATION =
  'prisma/migrations/20261001100000_app_roles_registry/migration.sql';

describe('shared — раскрытие наследования ролей', () => {
  const catalog = [
    { code: 'TECHNOLOGIST', inherits: ['SHOP_MANAGER'] },
    { code: 'SHOP_MANAGER', inherits: [] },
    { code: 'LEAD_SEAMSTRESS', inherits: ['TECHNOLOGIST', 'SEAMSTRESS'] },
    { code: 'SEAMSTRESS', inherits: [] },
  ];

  test('кастомная роль получает права донора', () => {
    expect(expandRoleCodes(['TECHNOLOGIST'], catalog)).toEqual([
      'TECHNOLOGIST',
      'SHOP_MANAGER',
    ]);
  });

  test('наследование транзитивно (донор донора тоже считается)', () => {
    const effective = expandRoleCodes(['LEAD_SEAMSTRESS'], catalog);
    expect(effective).toContain('TECHNOLOGIST');
    expect(effective).toContain('SHOP_MANAGER');
    expect(effective).toContain('SEAMSTRESS');
  });

  test('исходные коды идут первыми и в переданном порядке', () => {
    const effective = expandRoleCodes(['SEAMSTRESS', 'TECHNOLOGIST'], catalog);
    expect(effective[0]).toBe('SEAMSTRESS');
    expect(effective[1]).toBe('TECHNOLOGIST');
  });

  test('цикл не зашивает раскрытие', () => {
    const cyclic = [
      { code: 'A', inherits: ['B'] },
      { code: 'B', inherits: ['A'] },
    ];
    expect(expandRoleCodes(['A'], cyclic).sort()).toEqual(['A', 'B']);
  });

  test('неизвестный код не отбрасывается (роль удалили из справочника)', () => {
    expect(expandRoleCodes(['GHOST'], catalog)).toEqual(['GHOST']);
  });

  test('дубликатов в эффективном наборе нет', () => {
    const effective = expandRoleCodes(
      ['TECHNOLOGIST', 'SHOP_MANAGER'],
      catalog,
    );
    expect(new Set(effective).size).toBe(effective.length);
  });

  test('`findInheritanceCycle` ловит цикл до записи в БД', () => {
    // B уже наследует A; пытаемся выдать A наследование от B.
    const graph = [
      { code: 'A', inherits: [] },
      { code: 'B', inherits: ['A'] },
    ];
    expect(findInheritanceCycle('A', ['B'], graph)).not.toBeNull();
    expect(findInheritanceCycle('A', [], graph)).toBeNull();
  });

  test('`areAllSystemRoles` — быстрый выход горячего пути авторизации', () => {
    expect(areAllSystemRoles(['ADMIN', 'QC'])).toBe(true);
    expect(areAllSystemRoles(['ADMIN', 'TECHNOLOGIST'])).toBe(false);
  });

  test('«одно рабочее окно» — только у сотрудника с ОДНОЙ ролью', () => {
    const nodes = [
      {
        code: 'CUTTER_LEAD',
        inherits: ['CUTTER'],
        workspace: '/cutter',
        singleWorkspace: true,
        lockToWorkspace: true,
      },
      {
        code: 'CUTTER',
        inherits: [],
        workspace: '/cutter',
        singleWorkspace: true,
        lockToWorkspace: true,
      },
    ];
    expect(resolveRoleWorkspace(['CUTTER_LEAD'], nodes)).toEqual({
      workspace: '/cutter',
      singleWorkspace: true,
      lockToWorkspace: true,
    });
    // Совместитель — полная навигация, никаких редиректов.
    expect(resolveRoleWorkspace(['CUTTER_LEAD', 'QC'], nodes)).toEqual({
      workspace: '/',
      singleWorkspace: false,
      lockToWorkspace: false,
    });
  });
});

describe('prisma — роль стала данными', () => {
  const schema = readSrc('prisma/schema.prisma');

  test('колонки ролей сотрудника — String, а не enum', () => {
    const model = schema.slice(
      schema.indexOf('model Employee {'),
      schema.indexOf('model Employee {') + 4000,
    );
    expect(model).toMatch(/^\s+role\s+String$/m);
    expect(model).toMatch(/^\s+roles\s+String\[\]/m);
    expect(model).toMatch(/^\s+activeRole\s+String\?/m);
  });

  test('`AppRole` описывает наследование и рабочий экран', () => {
    expect(schema).toContain('model AppRole {');
    const model = schema.slice(
      schema.indexOf('model AppRole {'),
      schema.indexOf('model Employee {'),
    );
    for (const field of [
      'code',
      'name',
      'system',
      'inherits',
      'workspace',
      'singleWorkspace',
      'lockToWorkspace',
      'active',
    ]) {
      expect(model).toMatch(new RegExp(`^\\s+${field}\\s`, 'm'));
    }
  });

  test('enum `Role` не удалён — на нём висят Equipment/Printer', () => {
    expect(schema).toContain('enum Role {');
    expect(schema).toMatch(/^\s+role\s+Role\?/m);
  });
});

describe('миграция — сид системных ролей', () => {
  const sql = readSrc(MIGRATION);

  test('колонки переводятся в текст с сохранением значений', () => {
    expect(sql).toContain(
      'ALTER TABLE "Employee" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT',
    );
    expect(sql).toContain(
      'ALTER COLUMN "roles" TYPE TEXT[] USING "roles"::TEXT[]',
    );
  });

  test('все 12 системных кодов засеяны', () => {
    for (const code of SYSTEM_ROLE_CODES) {
      expect(sql).toContain(`'${code}'`);
    }
  });

  test('сид совпадает с `SYSTEM_ROLE_DEFAULTS` (иначе экраны разъедутся)', () => {
    for (const code of SYSTEM_ROLE_CODES) {
      const d = SYSTEM_ROLE_DEFAULTS[code];
      const line = sql
        .split('\n')
        .find((l) => l.includes(`'${code}',`) && l.includes('ARRAY[]::TEXT[]'));
      expect(line, `нет строки сида для ${code}`).toBeTruthy();
      expect(line, `${code}: имя разошлось`).toContain(`'${d.name}'`);
      expect(line, `${code}: рабочий экран разошёлся`).toContain(
        `'${d.workspace}'`,
      );
      // `system` первым булевым флагом в строке — все системные `true`.
      expect(line).toMatch(/true,\s*ARRAY\[\]::TEXT\[\]/);
    }
  });
});

describe('api — авторизация раскрывает наследование', () => {
  test('`AuthGuard` сверяет `@Roles(...)` с эффективным набором', () => {
    const src = readSrc('apps/api/src/modules/auth/auth.guard.ts');
    expect(src).toContain('const roles = principal.roles;');
    expect(src).toMatch(/roles\.includes\('ADMIN'\)/);
  });

  test('`resolvePrincipal` раскрывает роли на лету, а не берёт из токена', () => {
    const src = readSrc('apps/api/src/modules/auth/auth.service.ts');
    expect(src).toContain('this.appRoles.resolveAccess(assignedRoles)');
    // Назначенный набор берётся из БД — правка ролей в админке должна
    // применяться до перевыпуска cookie.
    expect(src).toContain('roles: effective');
    expect(src).toContain('assignedRoles');
  });

  test('эффективный набор в токен не пишется', () => {
    const src = readSrc('apps/api/src/modules/auth/session.ts');
    // В payload едут только назначенные роли + рабочий экран.
    expect(src).toMatch(/roles\?: string\[\]/);
    expect(src).toMatch(/ws\?: string/);
    expect(src).toMatch(/lock\?: boolean/);
  });

  test('горячий путь не ходит в БД для чисто системных наборов', () => {
    const src = readSrc('apps/api/src/modules/app-roles/app-roles.service.ts');
    expect(src).toContain('areAllSystemRoles(codes)');
  });

  test('`@Roles(...)` перечисляют только системные коды', () => {
    const known = new Set<string>(SYSTEM_ROLE_CODES);
    const files = [
      'apps/api/src/modules/employees/employees.controller.ts',
      'apps/api/src/modules/app-roles/app-roles.controller.ts',
      'apps/api/src/modules/passports/passports.controller.ts',
      'apps/api/src/modules/orders/orders.controller.ts',
    ];
    for (const file of files) {
      const src = readSrc(file);
      for (const m of src.matchAll(/@Roles\(([^)]*)\)/g)) {
        for (const code of m[1].matchAll(/'([A-Z_]+)'/g)) {
          expect(known.has(code[1]), `${file}: ${code[1]} не системная`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe('api — гейты справочника', () => {
  const src = readSrc('apps/api/src/modules/app-roles/app-roles.service.ts');

  test('системную роль нельзя ни в архив, ни удалить', () => {
    expect(src).toContain('системная роль, её нельзя убрать в архив');
    expect(src).toContain('системная роль, её нельзя удалить');
  });

  test('удаление навсегда — только из архива и только «ничью»', () => {
    expect(src).toContain("reason: 'NOT_ARCHIVED' as const");
    expect(src).toContain('назначена сотрудникам');
    expect(src).toContain('наследуют роли');
  });

  test('архивная роль продолжает работать у тех, кому выдана', () => {
    // `expand`/`resolveAccess` не фильтруют каталог по `active`.
    const access = src.slice(
      src.indexOf('async resolveAccess('),
      src.indexOf('// READ'),
    );
    expect(access).not.toContain('active: true');
  });

  test('код роли не редактируется даже у кастомной', () => {
    const shared = readSrc('packages/shared/src/app-roles.ts');
    const update = shared.slice(shared.indexOf('export const UpdateAppRoleSchema'));
    expect(update.slice(0, 400)).not.toMatch(/^\s+code:/m);
  });
});

describe('api — сотрудник ссылается на справочник', () => {
  test('DTO принимает любой код роли, а не enum', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toContain('export const RoleCodeRefSchema');
    expect(src).toContain('role: RoleCodeRefSchema');
  });

  test('несуществующий код отбивается сервисом', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.service.ts');
    expect(src).toContain('assertRolesExist');
    expect(src).toContain('EmployeeRoleUnknownException');
  });

  test('«админ» считается по РАСКРЫТОМУ набору — иначе эскалация', () => {
    // Дыра, которую открывает наследование: роль с `inherits: ['ADMIN']`
    // не содержит кода ADMIN, и наивная проверка `roles.includes(ADMIN)`
    // пропустила бы её мимо запрета «не-админ не выдаёт ADMIN».
    const src = readSrc('apps/api/src/modules/employees/employees.service.ts');
    expect(src).toContain('private async grantsAdmin(');
    expect(src).toContain('expandRoleCodes(codes, catalog).includes(Role.ADMIN)');
    // Оба гейта — и «кого можно править», и «что можно выдать».
    expect(src).toMatch(/this\.grantsAdmin\(currentRoles\)/);
    expect(src).toMatch(/this\.grantsAdmin\(nextRoles\)/);
    expect(src).toMatch(/await this\.grantsAdmin\(targetRoles\)/);
    // И защита последнего админа: иначе последний фактический админ
    // ушёл бы в архив без возражений.
    const lastAdmin = src.slice(
      src.indexOf('private async assertNotLastActiveAdmin('),
      src.indexOf('private async assertNotLastActiveAdmin(') + 1800,
    );
    expect(lastAdmin).toContain('expandRoleCodes');
  });
});

describe('web — рабочий экран приходит с сервера', () => {
  test('post-login редирект использует `workspace` из /auth/me', () => {
    // Без этого роль из справочника не найдётся в захардкоженной
    // матрице `PRIMARY_WORKSPACE_BY_ROLE` и вход уедет на `/login`.
    const helper = readSrc('apps/web/lib/role-redirect.ts');
    expect(helper).toMatch(/workspace\?: string \| null/);

    const root = readSrc('apps/web/app/page.tsx');
    expect(root).toContain('me.user.workspace');

    const login = readSrc('apps/web/app/login/actions.ts');
    expect(login).toContain('result.user.workspace');
  });

  test('middleware запирает роль по `ws`/`lock` из cookie', () => {
    const src = readSrc('apps/web/middleware.ts');
    expect(src).toContain('payload?.lock && payload.ws');
    // Legacy-ветка для старых токенов обязана остаться.
    expect(src).toContain('SHOPFLOOR_MASTER_ROLE');
  });

  test('«одно окно» считается по назначенному набору, а не раскрытому', () => {
    const layout = readSrc('apps/web/app/layout.tsx');
    expect(layout).toContain('me?.user.singleWorkspace');
    expect(layout).toContain('me?.user.assignedRoles');
  });

  test('названия ролей берутся из справочника', () => {
    const labels = readSrc('apps/web/lib/admin-labels.ts');
    expect(labels).toContain('export function buildRoleLabels');
    const list = readSrc('apps/web/app/admin/employees/page.tsx');
    expect(list).toContain('buildRoleLabels');
  });

  test('раздел `/admin/roles` есть в навигации админки', () => {
    const sidebar = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(sidebar).toContain("href: '/admin/roles'");
  });
});
