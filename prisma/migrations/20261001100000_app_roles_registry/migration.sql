-- Справочник ролей: роль перестаёт быть enum-ом и заводится из админки.
--
-- До: `Employee.role/roles/activeRole` — Postgres-enum "Role"; новая роль =
-- правка схемы + миграция + деплой. После: те же колонки — обычный текст с
-- `AppRole.code`, а сам справочник редактируется в `/admin/roles`.
--
-- Значения НЕ меняются: коды 12 системных ролей один в один совпадают со
-- старыми значениями enum-а, поэтому данные переносятся приведением типа,
-- а сравнения вида `role = 'CUTTER'` в коде остаются валидны.
--
-- Enum "Role" НЕ удаляем — на нём остались `Equipment.role` и `Printer.role`
-- (привязки железа к производственной роли, см. комментарий у enum-а в схеме).

-- 1. Колонки ролей сотрудника: enum -> text.
ALTER TABLE "Employee" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;
ALTER TABLE "Employee" ALTER COLUMN "activeRole" TYPE TEXT USING "activeRole"::TEXT;
ALTER TABLE "Employee" ALTER COLUMN "roles" DROP DEFAULT;
ALTER TABLE "Employee" ALTER COLUMN "roles" TYPE TEXT[] USING "roles"::TEXT[];
ALTER TABLE "Employee" ALTER COLUMN "roles" SET DEFAULT ARRAY[]::TEXT[];

-- 2. Сам справочник.
CREATE TABLE "AppRole" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "inherits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workspace" TEXT NOT NULL DEFAULT '/',
    "singleWorkspace" BOOLEAN NOT NULL DEFAULT false,
    "lockToWorkspace" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppRole_code_key" ON "AppRole"("code");
CREATE INDEX "AppRole_active_idx" ON "AppRole"("active");

-- 3. Сид 12 системных ролей.
--
-- `workspace`/`singleWorkspace`/`lockToWorkspace` — ровно то поведение, что
-- до этой миграции было захардкожено в `apps/web/lib/rbac.ts`
-- (PRIMARY_WORKSPACE_BY_ROLE, SINGLE_WORKSPACE_ROLES) и в персональных ветках
-- редиректа `apps/web/middleware.ts`. Зеркало — `SYSTEM_ROLE_DEFAULTS`
-- в `@sewing/shared/app-roles`: расходиться этим двум спискам нельзя.
--
-- `inherits` у системных ролей пустой: их права раздают сами декораторы
-- `@Roles(...)`, наследование нужно только кастомным ролям.
INSERT INTO "AppRole" ("id", "code", "name", "system", "inherits", "workspace", "singleWorkspace", "lockToWorkspace", "active", "sortOrder", "createdAt", "updatedAt")
VALUES
    ('sysrole_admin',            'ADMIN',            'Администратор',        true, ARRAY[]::TEXT[], '/',                  false, false, true,  10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_shop_manager',     'SHOP_MANAGER',     'Начальник цеха',       true, ARRAY[]::TEXT[], '/',                  false, false, true,  20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_shopfloor_master', 'SHOPFLOOR_MASTER', 'Мастер цеха',          true, ARRAY[]::TEXT[], '/master',            true,  true,  true,  30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_cutter',           'CUTTER',           'Раскройщик',           true, ARRAY[]::TEXT[], '/cutter',            true,  true,  true,  40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_cutter_assistant', 'CUTTER_ASSISTANT', 'Помощник раскройщика', true, ARRAY[]::TEXT[], '/work',              true,  false, true,  50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_seamstress',       'SEAMSTRESS',       'Швея',                 true, ARRAY[]::TEXT[], '/work',              true,  false, true,  60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_qc',               'QC',               'ОТК',                  true, ARRAY[]::TEXT[], '/qc',                true,  false, true,  70, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_ironing',          'IRONING',          'ВТО',                  true, ARRAY[]::TEXT[], '/wto',               true,  false, true,  80, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_packing',          'PACKING',          'Упаковка',             true, ARRAY[]::TEXT[], '/packing',           true,  false, true,  90, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_constructor',      'CONSTRUCTOR',      'Конструктор',          true, ARRAY[]::TEXT[], '/constructor',       true,  true,  true, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_display',          'DISPLAY',          'Экран цеха',           true, ARRAY[]::TEXT[], '/shopfloor/display', true,  true,  true, 110, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sysrole_superadmin',       'SUPERADMIN',       'Супер-админ',          true, ARRAY[]::TEXT[], '/superadmin',        false, false, true, 120, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
