/**
 * Контракты справочника ролей (`/admin/roles`).
 *
 * ЗАЧЕМ. До этой задачи роль была Postgres-enum `Role`: завести новую
 * («Технолог», «Кладовщик») можно было только правкой схемы + миграцией
 * + деплоем. Теперь роли живут в таблице `AppRole`, а колонки
 * `Employee.role/roles/activeRole` — обычный `String` с кодом роли.
 *
 * МОДЕЛЬ ПРАВ — НАСЛЕДОВАНИЕ. Кастомная роль не описывает права
 * поимённо: она перечисляет в `inherits` коды других ролей, чьи права
 * получает. Благодаря этому все ~215 `@Roles('SHOP_MANAGER', ...)` на
 * бэкенде остались нетронутыми: `AuthGuard` сначала раскрывает набор
 * ролей сотрудника через `expandRoleCodes`, а потом сверяет со списком
 * в декораторе. Роль «Технолог» с `inherits = ['SHOP_MANAGER']`
 * автоматически проходит везде, где пускают начальника цеха.
 *
 * СИСТЕМНЫЕ РОЛИ. 12 исходных кодов (`SYSTEM_ROLE_CODES`) остаются
 * зашитыми в код: на них ссылаются декораторы, гварды и терминалы, их
 * нельзя ни удалить, ни переименовать по коду (название — можно).
 * В БД они лежат тем же `AppRole` с `system = true`, чтобы админка
 * показывала один общий список.
 *
 * Источники истины:
 *   - доменная модель: `prisma/schema.prisma → AppRole`;
 *   - API: `docs/api.md §3c` (`/api/app-roles`);
 *   - UI: `apps/web/app/admin/roles`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Системные роли
// ---------------------------------------------------------------------------

/**
 * Коды системных ролей — ровно те, что раньше были значениями Prisma
 * `enum Role`. Захардкожены сознательно: на них ссылаются `@Roles(...)`,
 * RBAC-хелперы веба и терминалы цеха, поэтому они не могут «уехать»
 * вслед за данными.
 */
export const SYSTEM_ROLE_CODES = [
  'ADMIN',
  'SHOP_MANAGER',
  'SHOPFLOOR_MASTER',
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
  'CONSTRUCTOR',
  'DISPLAY',
  'SUPERADMIN',
] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

const SYSTEM_ROLE_CODE_SET: ReadonlySet<string> = new Set(SYSTEM_ROLE_CODES);

export function isSystemRoleCode(code: string): code is SystemRoleCode {
  return SYSTEM_ROLE_CODE_SET.has(code);
}

/**
 * Все ли коды набора — системные. Быстрый фильтр для `AuthGuard`:
 * если у сотрудника только системные роли, раскрывать нечего и в
 * справочник ходить не нужно (это подавляющее большинство запросов).
 */
export function areAllSystemRoles(codes: readonly string[]): boolean {
  return codes.every((c) => SYSTEM_ROLE_CODE_SET.has(c));
}

/**
 * Рабочие экраны, которые можно выбрать роли. Список закрытый: экран —
 * это существующая страница приложения, из админки её не создать.
 * `/` — многосекционная домашняя (менеджерская модель).
 */
export const ROLE_WORKSPACES = [
  '/',
  '/work',
  '/cutter',
  '/qc',
  '/wto',
  '/packing',
  '/master',
  '/constructor',
  '/shopfloor/display',
  '/superadmin',
] as const;
export type RoleWorkspace = (typeof ROLE_WORKSPACES)[number];

export const ROLE_WORKSPACE_LABELS: Record<RoleWorkspace, string> = {
  '/': 'Главная (полная навигация)',
  '/work': 'Рабочее место швеи',
  '/cutter': 'Кабинет раскройщика',
  '/qc': 'Терминал ОТК',
  '/wto': 'Терминал ВТО',
  '/packing': 'Терминал упаковки',
  '/master': 'Терминал мастера цеха',
  '/constructor': 'Кабинет конструктора',
  '/shopfloor/display': 'Цеховой монитор',
  '/superadmin': 'Панель супер-админа',
};

/**
 * Дефолты системных ролей — зеркало того, что до этой задачи было
 * зашито в `apps/web/lib/rbac.ts` (`PRIMARY_WORKSPACE_BY_ROLE`,
 * `SINGLE_WORKSPACE_ROLES`) и `apps/web/middleware.ts` (жёсткие
 * редиректы). Отсюда же сидируются строки `AppRole` в миграции —
 * поведение системных ролей после перехода на справочник не меняется.
 *
 *   - `singleWorkspace` — прячем глобальную навигацию, `/` уводит на
 *     рабочий экран (бывший `SINGLE_WORKSPACE_ROLES`);
 *   - `lockToWorkspace` — middleware жёстко не пускает на чужие
 *     страницы (бывшие DISPLAY / SHOPFLOOR_MASTER / CONSTRUCTOR /
 *     CUTTER редиректы). Всегда влечёт `singleWorkspace`.
 */
export interface SystemRoleDefaults {
  name: string;
  workspace: RoleWorkspace;
  singleWorkspace: boolean;
  lockToWorkspace: boolean;
  sortOrder: number;
}

export const SYSTEM_ROLE_DEFAULTS: Record<SystemRoleCode, SystemRoleDefaults> = {
  ADMIN: {
    name: 'Администратор',
    workspace: '/',
    singleWorkspace: false,
    lockToWorkspace: false,
    sortOrder: 10,
  },
  SHOP_MANAGER: {
    name: 'Начальник цеха',
    workspace: '/',
    singleWorkspace: false,
    lockToWorkspace: false,
    sortOrder: 20,
  },
  SHOPFLOOR_MASTER: {
    name: 'Мастер цеха',
    workspace: '/master',
    singleWorkspace: true,
    lockToWorkspace: true,
    sortOrder: 30,
  },
  CUTTER: {
    name: 'Раскройщик',
    workspace: '/cutter',
    singleWorkspace: true,
    lockToWorkspace: true,
    sortOrder: 40,
  },
  CUTTER_ASSISTANT: {
    name: 'Помощник раскройщика',
    workspace: '/work',
    singleWorkspace: true,
    lockToWorkspace: false,
    sortOrder: 50,
  },
  SEAMSTRESS: {
    name: 'Швея',
    workspace: '/work',
    singleWorkspace: true,
    lockToWorkspace: false,
    sortOrder: 60,
  },
  QC: {
    name: 'ОТК',
    workspace: '/qc',
    singleWorkspace: true,
    lockToWorkspace: false,
    sortOrder: 70,
  },
  IRONING: {
    name: 'ВТО',
    workspace: '/wto',
    singleWorkspace: true,
    lockToWorkspace: false,
    sortOrder: 80,
  },
  PACKING: {
    name: 'Упаковка',
    workspace: '/packing',
    singleWorkspace: true,
    lockToWorkspace: false,
    sortOrder: 90,
  },
  CONSTRUCTOR: {
    name: 'Конструктор',
    workspace: '/constructor',
    singleWorkspace: true,
    lockToWorkspace: true,
    sortOrder: 100,
  },
  DISPLAY: {
    name: 'Экран цеха',
    workspace: '/shopfloor/display',
    singleWorkspace: true,
    lockToWorkspace: true,
    sortOrder: 110,
  },
  SUPERADMIN: {
    name: 'Супер-админ',
    workspace: '/superadmin',
    singleWorkspace: false,
    lockToWorkspace: false,
    sortOrder: 120,
  },
};

/**
 * Fallback-названия системных ролей для мест, где каталог из БД
 * недоступен (например, `formatRole` в чистом клиентском компоненте).
 * Для кастомных ролей название всегда приходит из `AppRole.name`.
 */
export const SYSTEM_ROLE_LABELS: Record<string, string> = Object.fromEntries(
  SYSTEM_ROLE_CODES.map((code) => [code, SYSTEM_ROLE_DEFAULTS[code].name]),
);

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * Роль как её видят API и UI. Один и тот же шейп у системных и
 * кастомных — различает их только флаг `system`.
 */
export interface AppRoleDto {
  id: string;
  /** Стабильный код (UPPER_SNAKE). У системных ролей неизменяем. */
  code: string;
  name: string;
  /** Системная роль: код зашит в коде приложения, удалять нельзя. */
  system: boolean;
  /** Коды ролей, чьи права наследуются (транзитивно). */
  inherits: string[];
  /** Рабочий экран (см. `ROLE_WORKSPACES`). */
  workspace: string;
  singleWorkspace: boolean;
  lockToWorkspace: boolean;
  /** `false` = роль в архиве: не назначается, но у кого была — работает. */
  active: boolean;
  sortOrder: number;
  /** Сколько сотрудников имеет эту роль в `Employee.roles`. */
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Поля
// ---------------------------------------------------------------------------

/**
 * Код роли. UPPER_SNAKE, латиница — он попадает в session-cookie, в
 * `@Roles(...)`-сравнения и в URL-ы, поэтому кириллицу и пробелы не
 * пускаем. Ввод нормализуем (trim + upper), чтобы «technolog» и
 * « Technolog » не создали две роли.
 */
export const RoleCodeField = z
  .string()
  .trim()
  .min(2, 'Код роли должен быть не короче 2 символов')
  .max(40, 'Код роли слишком длинный (макс. 40 символов)')
  .transform((v) => v.toUpperCase().replace(/[\s-]+/g, '_'))
  .refine(
    (v) => /^[A-Z][A-Z0-9_]*$/.test(v),
    'Код роли — только латиница, цифры и подчёркивание, начинается с буквы',
  );

export const RoleNameField = z
  .string()
  .trim()
  .min(2, 'Название роли должно быть не короче 2 символов')
  .max(80, 'Название роли слишком длинное (макс. 80 символов)');

const WorkspaceField = z
  .string()
  .trim()
  .refine(
    (v) => (ROLE_WORKSPACES as readonly string[]).includes(v),
    'Неизвестный рабочий экран',
  );

/**
 * Тело `POST /api/app-roles`.
 *
 * `inherits` — коды ролей-доноров. Пустой список допустим: получится
 * роль без прав (только вход в систему и свой рабочий экран) — это
 * осмысленно, например, для учётки-заглушки.
 */
export const CreateAppRoleSchema = z.object({
  code: RoleCodeField,
  name: RoleNameField,
  inherits: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  workspace: WorkspaceField.optional().default('/'),
  singleWorkspace: z.boolean().optional().default(false),
  lockToWorkspace: z.boolean().optional().default(false),
});
export type CreateAppRoleDto = z.infer<typeof CreateAppRoleSchema>;

/**
 * Тело `PATCH /api/app-roles/:id`. Код не редактируется НИКОГДА — ни у
 * системной роли, ни у кастомной: он уже записан в `Employee.roles`
 * живых сотрудников и в выданные session-cookie. Роль с ошибочным
 * кодом заводят заново, старую — в архив.
 */
export const UpdateAppRoleSchema = z.object({
  name: RoleNameField.optional(),
  inherits: z.array(z.string().trim().min(1)).max(20).optional(),
  workspace: WorkspaceField.optional(),
  singleWorkspace: z.boolean().optional(),
  lockToWorkspace: z.boolean().optional(),
});
export type UpdateAppRoleDto = z.infer<typeof UpdateAppRoleSchema>;

// ---------------------------------------------------------------------------
// Раскрытие наследования
// ---------------------------------------------------------------------------

/** Минимум, нужный для раскрытия: код → от кого наследует. */
export interface RoleInheritanceNode {
  code: string;
  inherits: readonly string[];
}

/**
 * Транзитивно раскрывает набор ролей в ЭФФЕКТИВНЫЙ набор: сами роли
 * плюс всё, что они наследуют, плюс то, что наследуют доноры.
 *
 * Это ядро всей фичи — на результат опираются `AuthGuard` (`@Roles`),
 * `/api/auth/me` и RBAC веба. Свойства, на которые можно полагаться:
 *
 *   - порядок стабильный: сначала исходные коды в переданном порядке,
 *     потом унаследованные по мере обхода (важно, чтобы «основная роль
 *     первой» не ломалось);
 *   - циклы безопасны: `A → B → A` раскрывается в `[A, B]`, а не
 *     зависает (админка циклы запрещает, но данные могут приехать из
 *     ручного SQL);
 *   - неизвестный код не отбрасывается: если роль удалили из каталога,
 *     а у сотрудника она осталась, код останется в наборе — доступ по
 *     нему просто нигде не совпадёт.
 */
export function expandRoleCodes(
  codes: readonly string[],
  catalog: readonly RoleInheritanceNode[],
): string[] {
  const byCode = new Map<string, RoleInheritanceNode>();
  for (const node of catalog) byCode.set(node.code, node);

  const seen = new Set<string>();
  const result: string[] = [];
  const queue = [...codes];

  while (queue.length > 0) {
    const code = queue.shift()!;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
    const node = byCode.get(code);
    if (node) queue.push(...node.inherits);
  }
  return result;
}

/**
 * Ищет цикл, который появится, если роли `code` назначить `inherits`.
 * Возвращает путь цикла (`['TECHNOLOGIST','QA','TECHNOLOGIST']`) или
 * `null`. Используется валидацией `POST/PATCH /api/app-roles`, чтобы
 * «A наследует B, B наследует A» не попало в БД.
 */
export function findInheritanceCycle(
  code: string,
  inherits: readonly string[],
  catalog: readonly RoleInheritanceNode[],
): string[] | null {
  const byCode = new Map<string, readonly string[]>();
  for (const node of catalog) byCode.set(node.code, node.inherits);
  // Правим граф «как будет после сохранения».
  byCode.set(code, inherits);

  const path: string[] = [];
  const inPath = new Set<string>();
  const done = new Set<string>();

  function walk(current: string): string[] | null {
    if (inPath.has(current)) {
      return [...path.slice(path.indexOf(current)), current];
    }
    if (done.has(current)) return null;
    inPath.add(current);
    path.push(current);
    for (const next of byCode.get(current) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    inPath.delete(current);
    done.add(current);
    return null;
  }

  return walk(code);
}

/**
 * Итоговое поведение «рабочего окна» для набора ролей сотрудника.
 * Считается на бэкенде (там есть каталог) и отдаётся в `/api/auth/me`,
 * чтобы веб не гадал по захардкоженным спискам.
 *
 * Правило то же, что было для системных ролей: «одно рабочее окно» —
 * это про сотрудника с РОВНО ОДНОЙ ролью. Совместитель (2+ ролей)
 * получает полноценную навигацию.
 *
 * ВАЖНО: считаем по ИСХОДНОМУ набору `Employee.roles`, а не по
 * раскрытому — иначе кастомная роль «Швея-бригадир» с
 * `inherits = ['SEAMSTRESS']` раскрылась бы в две роли и потеряла бы
 * свой терминал.
 */
export interface RoleWorkspaceResolution {
  workspace: string;
  singleWorkspace: boolean;
  lockToWorkspace: boolean;
}

export function resolveRoleWorkspace(
  roles: readonly string[],
  catalog: readonly (RoleInheritanceNode & RoleWorkspaceResolution)[],
): RoleWorkspaceResolution {
  const primary = roles.length === 1 ? roles[0] : null;
  if (!primary) {
    return { workspace: '/', singleWorkspace: false, lockToWorkspace: false };
  }
  const node = catalog.find((r) => r.code === primary);
  if (!node) {
    return { workspace: '/', singleWorkspace: false, lockToWorkspace: false };
  }
  return {
    workspace: node.workspace,
    singleWorkspace: node.singleWorkspace,
    lockToWorkspace: node.lockToWorkspace,
  };
}
