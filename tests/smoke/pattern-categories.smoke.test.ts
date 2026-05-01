/**
 * Smoke-тесты этапа «Категории номенклатуры» (см.
 * `prisma/schema.prisma` — `model PatternCategory`/`PatternCategoryParameter`,
 * `apps/api/src/modules/pattern-categories/*`,
 * `packages/shared/src/pattern-categories.ts`,
 * `apps/web/app/admin/patterns/*`,
 * `prisma/migrations/20260515100000_add_pattern_categories/migration.sql`).
 *
 * Все проверки — source-level: запускать настоящий браузер ради
 * smoke-сценария дорого, а статика покрывает acceptance-чеклист
 * (категория содержит параметры, в номенклатуре «Площади материалов»
 * показываются только параметры выбранной категории, backend
 * валидирует `materialRole` против параметров категории, legacy
 * `categoryCode` сохранён, Order/WorkshopNeed не изменены).
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

const SCHEMA = 'prisma/schema.prisma';
const MIGRATION =
  'prisma/migrations/20260515100000_add_pattern_categories/migration.sql';
const ICON_MIGRATION =
  'prisma/migrations/20260516100000_add_pattern_category_icon_image/migration.sql';
const SHARED = 'packages/shared/src/pattern-categories.ts';
const SHARED_INDEX = 'packages/shared/src/index.ts';
const SHARED_PKG = 'packages/shared/package.json';
const SHARED_PATTERNS = 'packages/shared/src/patterns.ts';
const API_SERVICE =
  'apps/api/src/modules/pattern-categories/pattern-categories.service.ts';
const API_CONTROLLER =
  'apps/api/src/modules/pattern-categories/pattern-categories.controller.ts';
const API_MODULE =
  'apps/api/src/modules/pattern-categories/pattern-categories.module.ts';
const API_STORAGE =
  'apps/api/src/modules/pattern-categories/pattern-categories-storage.service.ts';
const APP_MODULE = 'apps/api/src/app.module.ts';
const PATTERNS_SERVICE = 'apps/api/src/modules/patterns/patterns.service.ts';
const ERRORS = 'apps/api/src/common/errors.ts';
const AUDIT = 'apps/api/src/modules/audit/audit.service.ts';

const PATTERNS_PAGE = 'apps/web/app/admin/patterns/page.tsx';
const NEW_PAGE = 'apps/web/app/admin/patterns/new/page.tsx';
const DETAIL_PAGE = 'apps/web/app/admin/patterns/[id]/page.tsx';
const CREATE_FORM = 'apps/web/app/admin/patterns/create-form.tsx';
const EDIT_FORM = 'apps/web/app/admin/patterns/[id]/edit-form.tsx';
const AREAS_FORM = 'apps/web/app/admin/patterns/[id]/material-areas-form.tsx';
const SIZES_MGR = 'apps/web/app/admin/patterns/[id]/pattern-sizes-manager.tsx';
const ACTIONS = 'apps/web/app/admin/patterns/actions.ts';
const CATEGORIES_API = 'apps/web/lib/pattern-categories-api.ts';
const PATTERNS_API = 'apps/web/lib/patterns-api.ts';
const CAT_NEW_PAGE = 'apps/web/app/admin/pattern-categories/new/page.tsx';
const CAT_NEW_FORM =
  'apps/web/app/admin/pattern-categories/new/create-pattern-category-form.tsx';
const CAT_NEW_ACTIONS =
  'apps/web/app/admin/pattern-categories/new/actions.ts';
const CAT_NEW_FORM_STATE =
  'apps/web/app/admin/pattern-categories/new/form-state.ts';
// Этап «Редактируемые категории номенклатуры»: страница редактирования
// категории на отдельном route `/admin/pattern-categories/[id]`.
const CAT_EDIT_PAGE = 'apps/web/app/admin/pattern-categories/[id]/page.tsx';
const CAT_EDIT_FORM =
  'apps/web/app/admin/pattern-categories/[id]/edit-pattern-category-form.tsx';
const CAT_EDIT_ACTIONS =
  'apps/web/app/admin/pattern-categories/[id]/actions.ts';
const CAT_EDIT_FORM_STATE =
  'apps/web/app/admin/pattern-categories/[id]/form-state.ts';
const FORM_STATE = 'apps/web/app/admin/patterns/form-state.ts';

// ---------------------------------------------------------------------------
// 1. Prisma — модели и миграция
// ---------------------------------------------------------------------------

describe('Prisma schema — модели категорий', () => {
  const src = read(SCHEMA);

  test('schema содержит PatternCategory', () => {
    expect(src).toMatch(/model PatternCategory\s*\{/);
    expect(src).toMatch(/parameters\s+PatternCategoryParameter\[\]/);
    expect(src).toMatch(/patterns\s+PatternItem\[\]/);
    expect(src).toMatch(/iconKey\s+String/);
    expect(src).toMatch(/sortOrder\s+Int\s+@default\(100\)/);
    expect(src).toMatch(/status\s+String\s+@default\("ACTIVE"\)/);
    // Этап «Загружаемая JPEG-иконка категории»: nullable-поля под
    // картинку категории.
    expect(src).toMatch(/iconImageUrl\s+String\?/);
    expect(src).toMatch(/iconOriginalFileName\s+String\?/);
  });

  test('schema содержит PatternCategoryParameter', () => {
    expect(src).toMatch(/model PatternCategoryParameter\s*\{/);
    expect(src).toMatch(/category\s+PatternCategory\s+@relation/);
    expect(src).toMatch(/onDelete:\s*Cascade/);
    expect(src).toMatch(/roleKey\s+String/);
    expect(src).toMatch(/inputType\s+String\s+@default\("AREA_M2_BY_SIZE"\)/);
    // Этап «Фурнитура: несколько параметров с одним roleKey»: бывший
    // `@@unique([categoryId, roleKey])` заменён обычным индексом.
    // Уникальность для AREA_M2_BY_SIZE валидируется в shared Zod-схеме
    // (см. `packages/shared/src/pattern-categories.ts`).
    expect(src).not.toMatch(/@@unique\(\[categoryId,\s*roleKey\]/);
    expect(src).toMatch(/@@index\(\[categoryId,\s*roleKey\]/);
  });

  test('PatternItem получил categoryId с onDelete: SetNull, categoryCode оставлен', () => {
    expect(src).toMatch(/model PatternItem\s*\{[\s\S]*categoryId\s+String\?/);
    expect(src).toMatch(
      /category\s+PatternCategory\?\s+@relation\(fields:\s*\[categoryId\][\s\S]*onDelete:\s*SetNull\)/,
    );
    expect(src).toMatch(
      /categoryCode\s+String\?/,
    );
  });

  test('PatternMaterialArea остался без изменений (materialRole — String)', () => {
    expect(src).toMatch(/model PatternMaterialArea\s*\{/);
    expect(src).toMatch(/materialRole\s+String/);
  });

  test('Order / WorkshopNeed / OrderItem / Passport / Product не получили новых полей через эту миграцию', () => {
    // Source-level guard: миграция трогает только PatternCategory*, PatternItem.
    const mig = read(MIGRATION);
    expect(mig).not.toMatch(/ALTER TABLE\s+"Order"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"OrderItem"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"Passport"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"WorkshopNeed"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"Product"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"PurchaseOrder"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"PurchaseReceipt"\b/);
    expect(mig).not.toMatch(/ALTER TABLE\s+"PatternMaterialArea"\b/);
  });
});

describe('Migration — категорийная миграция additive', () => {
  test('migration существует и не трогает destructive', () => {
    expect(exists(MIGRATION)).toBe(true);
    const src = read(MIGRATION);
    expect(src).toMatch(/CREATE TABLE "PatternCategory"/);
    expect(src).toMatch(/CREATE TABLE "PatternCategoryParameter"/);
    expect(src).toMatch(/ALTER TABLE "PatternItem"\s+ADD COLUMN "categoryId"/);
    expect(src).toMatch(
      /FOREIGN KEY \("categoryId"\) REFERENCES "PatternCategory"\("id"\)\s+ON DELETE SET NULL/,
    );
    // Категория archived = soft. DROP / DELETE в миграции не должно быть.
    expect(src).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(src).not.toMatch(/\bDROP\s+COLUMN\b/i);
    // categoryCode не трогается (нет ALTER COLUMN / DROP).
    expect(src).not.toMatch(/ALTER\s+TABLE\s+"PatternItem"[\s\S]*categoryCode/i);
  });

  test('hardware-параметры migration: drop unique, add index, не трогает другие таблицы', () => {
    // Этап «Фурнитура: разрешить несколько параметров категории с одним
    // roleKey». См. `prisma/schema.prisma` — `PatternCategoryParameter`,
    // `packages/shared/src/pattern-categories.ts` — Zod-валидация уникальности
    // только для `inputType = AREA_M2_BY_SIZE`.
    const HARDWARE_MIGRATION =
      'prisma/migrations/20260518100000_allow_multiple_category_hardware_parameters/migration.sql';
    expect(exists(HARDWARE_MIGRATION)).toBe(true);
    const src = read(HARDWARE_MIGRATION);
    // Снимаем уникальный индекс, заменяем обычным индексом с тем же
    // составом колонок.
    expect(src).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+"PatternCategoryParameter_category_role_uniq"/i,
    );
    expect(src).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"PatternCategoryParameter_categoryId_roleKey_idx"\s+ON\s+"PatternCategoryParameter"\("categoryId",\s*"roleKey"\)/i,
    );
    // Никаких destructive операций над данными.
    expect(src).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(src).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Не трогаем смежные таблицы — это только ослабление ограничения.
    for (const table of [
      '"Order"',
      '"OrderItem"',
      '"Product"',
      '"WorkshopNeed"',
      '"PurchaseOrder"',
      '"PurchaseReceipt"',
      '"PatternMaterialArea"',
      '"TechCardMaterialLine"',
      '"PatternItem"',
    ]) {
      expect(src).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+${table}\\b`));
    }
  });

  test('icon-image миграция additive, без destructive', () => {
    expect(exists(ICON_MIGRATION)).toBe(true);
    const src = read(ICON_MIGRATION);
    expect(src).toMatch(
      /ALTER TABLE "PatternCategory" ADD COLUMN "iconImageUrl"\s+TEXT/,
    );
    expect(src).toMatch(
      /ALTER TABLE "PatternCategory" ADD COLUMN "iconOriginalFileName"\s+TEXT/,
    );
    // Никаких destructive операций.
    expect(src).not.toMatch(/\bDROP\b/i);
    // iconKey не должен меняться этой миграцией (комментарии могут
    // упоминать поле — поэтому проверяем только SQL-операции на нём).
    expect(src).not.toMatch(/ALTER\s+TABLE[^\n]*iconKey/i);
    expect(src).not.toMatch(/DROP\s+COLUMN[^\n]*iconKey/i);
    // Не трогаем смежные таблицы.
    for (const table of [
      '"Order"',
      '"Product"',
      '"WorkshopNeed"',
      '"PurchaseOrder"',
      '"PurchaseReceipt"',
      '"PatternItem"',
      '"PatternMaterialArea"',
    ]) {
      expect(src).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+${table}\\b`));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Shared — DTO, Zod, константы, экспорты
// ---------------------------------------------------------------------------

describe('@sewing/shared/pattern-categories — публичный контракт', () => {
  test('файл существует и экспортируется из barrel', () => {
    expect(exists(SHARED)).toBe(true);
    const idx = read(SHARED_INDEX);
    expect(idx).toMatch(/from '\.\/pattern-categories'/);
    const pkg = JSON.parse(read(SHARED_PKG));
    expect(pkg.exports['./pattern-categories']).toBeDefined();
  });

  const src = read(SHARED);

  test('константы whitelists', () => {
    // Проверяем наличие имён констант и полный набор значений в файле,
    // не закладываясь на конкретное расположение / форматирование.
    expect(src).toMatch(/PATTERN_CATEGORY_STATUSES\b/);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_STATUSES\b/);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_INPUT_TYPES\b/);
    for (const v of ['ACTIVE', 'ARCHIVED']) {
      expect(src).toMatch(new RegExp(`'${v}'`));
    }
    // Этап «Доработка параметров категорий номенклатуры»: добавлен
    // LINEAR_M_BY_SIZE — погонные метры по размерам. Старые типы
    // должны продолжить работать.
    for (const v of [
      'AREA_M2_BY_SIZE',
      'LINEAR_M_BY_SIZE',
      'QTY_PER_ITEM',
      'TEXT_ONLY',
    ]) {
      expect(src).toMatch(new RegExp(`'${v}'`));
    }
    // Лейбл нового типа ввода — то, что видит менеджер.
    expect(src).toMatch(/'Погонные метры по размерам'/);
    // Whitelist иконок lucide.
    expect(src).toMatch(/PATTERN_CATEGORY_ICON_KEYS\s*=\s*\[/);
    for (const k of [
      'SHIRT',
      'HOODIE',
      'PANTS',
      'SHORTS',
      'DRESS',
      'CAP',
      'PACKAGE',
      'SCISSORS',
      'TAG',
      'STAR',
    ]) {
      expect(src).toMatch(new RegExp(`'${k}'`));
    }
  });

  test('Zod-схемы и DTO-интерфейсы', () => {
    expect(src).toMatch(/CreatePatternCategorySchema\b/);
    expect(src).toMatch(/UpdatePatternCategorySchema\b/);
    expect(src).toMatch(/ReplacePatternCategoryParametersSchema\b/);
    expect(src).toMatch(/ListPatternCategoriesQuerySchema\b/);
    expect(src).toMatch(/PatternCategoryParameterInputSchema\b/);
    expect(src).toMatch(/interface PatternCategoryDto\b/);
    expect(src).toMatch(/interface PatternCategoryListItemDto\b/);
    expect(src).toMatch(/interface PatternCategoryParameterDto\b/);
    // Этап «Загружаемая JPEG-иконка категории»: response DTO содержит
    // iconImageUrl / iconOriginalFileName; iconKey остался как legacy
    // fallback и стал optional на create-схеме.
    expect(src).toMatch(/iconImageUrl:\s*string \| null/);
    expect(src).toMatch(/iconOriginalFileName:\s*string \| null/);
    expect(src).toMatch(
      /iconKey:\s*PatternCategoryIconKeySchema\.optional\(\)/,
    );
  });

  test('roleKey валидируется uppercase letters/digits/underscore', () => {
    // Регулярка `^[A-Z][A-Z0-9_]*$` — точный whitelist для будущих
    // ключей материалов в категории.
    expect(src).toMatch(/\^\[A-Z\]\[A-Z0-9_\]\*\$/);
  });

  test('runtime-поведение: schema rejects невалидный roleKey, accepts AREA_M2_BY_SIZE', async () => {
    const mod: typeof import('../../packages/shared/src/pattern-categories') =
      await import('../../packages/shared/src/pattern-categories');
    const ok = mod.PatternCategoryParameterInputSchema.safeParse({
      roleKey: 'MAIN_FABRIC',
      label: 'Основной материал',
      inputType: 'AREA_M2_BY_SIZE',
    });
    expect(ok.success).toBe(true);

    const badRoleKey = mod.PatternCategoryParameterInputSchema.safeParse({
      roleKey: 'main_fabric',
      label: 'Основной материал',
      inputType: 'AREA_M2_BY_SIZE',
    });
    expect(badRoleKey.success).toBe(false);

    // Этап «Загружаемая JPEG-иконка категории»: iconKey стал optional —
    // create без iconKey должен пройти.
    const noIcon = mod.CreatePatternCategorySchema.safeParse({
      name: 'Худи',
    });
    expect(noIcon.success).toBe(true);

    // Уникальность roleKey внутри AREA_M2_BY_SIZE параметров: повтор → 400.
    // (Этап «Фурнитура»: уникальность теперь работает только для
    // AREA_M2_BY_SIZE, см. ниже отдельный allow-кейс для QTY_PER_ITEM.)
    const dupArea = mod.CreatePatternCategorySchema.safeParse({
      name: 'Худи',
      iconKey: 'HOODIE',
      parameters: [
        { roleKey: 'MAIN_FABRIC', label: 'A', inputType: 'AREA_M2_BY_SIZE' },
        { roleKey: 'MAIN_FABRIC', label: 'B', inputType: 'AREA_M2_BY_SIZE' },
      ],
    });
    expect(dupArea.success).toBe(false);

    // Этап «Фурнитура: разрешить несколько параметров с одним roleKey».
    // Несколько QTY_PER_ITEM параметров с roleKey = PACKAGING — допустимо,
    // если label разный. Это нужно для Люверсы/Молния/Кнопки/Пуговицы.
    const okHardware = mod.CreatePatternCategorySchema.safeParse({
      name: 'Худи',
      iconKey: 'HOODIE',
      parameters: [
        { roleKey: 'MAIN_FABRIC', label: 'Основное полотно', inputType: 'AREA_M2_BY_SIZE' },
        { roleKey: 'PACKAGING', label: 'Люверсы', inputType: 'QTY_PER_ITEM', unit: 'шт' },
        { roleKey: 'PACKAGING', label: 'Шнур', inputType: 'QTY_PER_ITEM', unit: 'шт' },
        { roleKey: 'PACKAGING', label: 'Наконечники', inputType: 'QTY_PER_ITEM', unit: 'шт' },
      ],
    });
    expect(okHardware.success).toBe(true);

    // Дубль label внутри категории отбивается (soft guard, чтобы UI
    // не рисовал две одинаковые колонки).
    const dupLabel = mod.CreatePatternCategorySchema.safeParse({
      name: 'Худи',
      iconKey: 'HOODIE',
      parameters: [
        { roleKey: 'PACKAGING', label: 'Люверсы', inputType: 'QTY_PER_ITEM', unit: 'шт' },
        { roleKey: 'PACKAGING', label: 'Люверсы', inputType: 'QTY_PER_ITEM', unit: 'шт' },
      ],
    });
    expect(dupLabel.success).toBe(false);

    // generatePatternCategorySlug делает что-то полезное.
    expect(mod.generatePatternCategorySlug('Худи')).toMatch(/^[a-z0-9-]+$/);
    expect(mod.generatePatternCategorySlug('T-Shirt 2026')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('@sewing/shared/patterns — categoryId / category на DTO', () => {
  const src = read(SHARED_PATTERNS);

  test('CreatePatternSchema / UpdatePatternSchema принимают categoryId', () => {
    expect(src).toMatch(/categoryId:\s*CategoryIdField/);
    // categoryCode сохранён как legacy.
    expect(src).toMatch(/categoryCode:\s*CategoryCodeField/);
  });

  test('PatternListItemDto и PatternDetailDto получили category-поля', () => {
    expect(src).toMatch(/categoryId:\s*string \| null/);
    expect(src).toMatch(/categoryName:\s*string \| null/);
    expect(src).toMatch(/categorySlug:\s*string \| null/);
    expect(src).toMatch(/categoryIconKey:/);
    // Этап «Загружаемая JPEG-иконка категории»: list/detail отдают
    // categoryIconImageUrl, основной источник иконки в новом UI.
    expect(src).toMatch(/categoryIconImageUrl:\s*string \| null/);
    expect(src).toMatch(/categoryStatus:/);
    // category на детальной DTO — структура PatternCategoryDto | null.
    expect(src).toMatch(/category:\s*PatternCategoryDto \| null/);
    expect(src).toMatch(/categoryAreaParameters:\s*PatternCategoryParameterDto\[\]/);
  });

  test('ListPatternsQuerySchema принимает фильтр categoryId', () => {
    expect(src).toMatch(/categoryId:\s*z\.string\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Backend — модуль и валидация material-areas
// ---------------------------------------------------------------------------

describe('apps/api — pattern-categories модуль', () => {
  test('файлы модуля существуют и зарегистрированы', () => {
    expect(exists(API_SERVICE)).toBe(true);
    expect(exists(API_CONTROLLER)).toBe(true);
    expect(exists(API_MODULE)).toBe(true);
    const app = read(APP_MODULE);
    expect(app).toMatch(/PatternCategoriesModule/);
  });

  test('controller — endpoints + RBAC', () => {
    const ctl = read(API_CONTROLLER);
    expect(ctl).toMatch(/@Controller\('pattern-categories'\)/);
    expect(ctl).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
    expect(ctl).toMatch(/@Get\(\)\s*\n\s*list\b/);
    expect(ctl).toMatch(/@Post\(\)\s*\n\s*create\b/);
    expect(ctl).toMatch(/@Patch\(':id'\)/);
    expect(ctl).toMatch(/@Put\(':id\/parameters'\)/);
    expect(ctl).toMatch(/@Delete\(':id'\)/);
    // Этап «Загружаемая JPEG-иконка категории».
    expect(ctl).toMatch(/@Post\(':id\/icon'\)/);
    expect(ctl).toMatch(/FileInterceptor\('file'/);
    expect(ctl).toMatch(/uploadIcon\b/);
  });

  test('service — события аудита', () => {
    const svc = read(API_SERVICE);
    expect(svc).toMatch(/PATTERN_CATEGORY_CREATED/);
    expect(svc).toMatch(/PATTERN_CATEGORY_UPDATED/);
    expect(svc).toMatch(/PATTERN_CATEGORY_ARCHIVED/);
    expect(svc).toMatch(/PATTERN_CATEGORY_PARAMETERS_REPLACED/);
    // Новый event для загрузки JPEG-иконки.
    expect(svc).toMatch(/PATTERN_CATEGORY_ICON_UPLOADED/);
    expect(svc).toMatch(/entityType:\s*'PATTERN_CATEGORY'/);
    // soft-archive (status = ARCHIVED), без destructive delete.
    expect(svc).toMatch(/status:\s*'ARCHIVED'/);
    expect(svc).not.toMatch(/patternCategory\.delete\b/);
    // service отдаёт iconImageUrl наружу.
    expect(svc).toMatch(/iconImageUrl/);
  });

  test('storage service существует и whitelist расширений jpg/jpeg/png', () => {
    expect(exists(API_STORAGE)).toBe(true);
    const src = read(API_STORAGE);
    expect(src).toMatch(/class PatternCategoriesStorageService\b/);
    // Whitelist расширений: jpg/jpeg/png. SVG/WEBP не разрешены.
    expect(src).toMatch(/ALLOWED_ICON_EXTENSIONS\s*=\s*\[[^\]]*'jpg'[^\]]*\]/);
    expect(src).toMatch(/ALLOWED_ICON_EXTENSIONS\s*=\s*\[[^\]]*'jpeg'[^\]]*\]/);
    expect(src).toMatch(/ALLOWED_ICON_EXTENSIONS\s*=\s*\[[^\]]*'png'[^\]]*\]/);
    expect(src).not.toMatch(/'svg'/);
    expect(src).not.toMatch(/'webp'/);
    // Public URL под `/uploads/pattern-categories/<id>/icon/...`.
    expect(src).toMatch(/pattern-categories/);
    expect(src).toMatch(/icon/);
  });

  test('audit.service знает PATTERN_CATEGORY entityType', () => {
    const a = read(AUDIT);
    expect(a).toMatch(/'PATTERN_CATEGORY'/);
  });

  test('errors.ts содержит коды для категории', () => {
    const e = read(ERRORS);
    expect(e).toMatch(/PatternCategoryNotFoundException/);
    expect(e).toMatch(/PatternCategoryInactiveException/);
    expect(e).toMatch(/PatternCategorySlugTakenException/);
    expect(e).toMatch(/PatternMaterialRoleNotInCategoryException/);
    // Стабильные коды бизнес-ошибок.
    expect(e).toMatch(/PATTERN_CATEGORY_NOT_FOUND/);
    expect(e).toMatch(/PATTERN_CATEGORY_INACTIVE/);
    expect(e).toMatch(/PATTERN_MATERIAL_ROLE_NOT_IN_CATEGORY/);
  });
});

describe('apps/api — patterns.service интеграция с категориями', () => {
  const svc = read(PATTERNS_SERVICE);

  test('list/getOne/create/update учитывают категорию', () => {
    expect(svc).toMatch(/where\.categoryId\s*=\s*query\.categoryId/);
    // include category в getOne / list
    expect(svc).toMatch(/category:\s*\{/);
    expect(svc).toMatch(/include:\s*\{[\s\S]*parameters:/);
    // create/update — assertCategoryUsable
    expect(svc).toMatch(/assertCategoryUsable/);
    // Этап «Загружаемая JPEG-иконка категории»: list/detail отдают
    // categoryIconImageUrl из category.iconImageUrl.
    expect(svc).toMatch(/categoryIconImageUrl/);
    expect(svc).toMatch(/iconImageUrl:\s*true/);
  });

  test('replaceMaterialAreas валидирует materialRole по категории', () => {
    expect(svc).toMatch(/computeAllowedMaterialRoles/);
    // categoryId чтение и условный fallback.
    expect(svc).toMatch(/inputType:\s*'AREA_M2_BY_SIZE'/);
    expect(svc).toMatch(/MATERIAL_ROLES/);
    // throws на неразрешённую роль.
    expect(svc).toMatch(/PatternMaterialRoleNotInCategoryException/);
  });

  test('toDetailDto отдаёт category и categoryAreaParameters', () => {
    expect(svc).toMatch(/categoryAreaParameters:/);
    expect(svc).toMatch(/inputType\s*===\s*'AREA_M2_BY_SIZE'/);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend — список лекал, модалка категории, формы
// ---------------------------------------------------------------------------

describe('admin/patterns/page.tsx — фильтры категорий и кнопки', () => {
  const src = read(PATTERNS_PAGE);

  test('страница загружает категории и рисует фильтр по ним', () => {
    expect(src).toMatch(/listPatternCategories/);
    expect(src).toMatch(/CategoryFilterChip/);
    // Кнопка «Все» + чипсы по категориям.
    expect(src).toMatch(/active=\{!categoryId\}/);
  });

  test('кнопка «Добавить категорию» ведёт на отдельную страницу (не модалка)', () => {
    // Этап «Загружаемая JPEG-иконка категории»: модалка удалена,
    // кнопка теперь — обычная ссылка на /admin/pattern-categories/new.
    expect(src).toMatch(/Добавить категорию/);
    expect(src).toMatch(/href="\/admin\/pattern-categories\/new"/);
    expect(src).toMatch(/Создать номенклатуру/);
    // Никакого CategoryCreateModalLauncher на странице больше нет.
    expect(src).not.toMatch(/CategoryCreateModalLauncher/);
    expect(src).not.toMatch(/category-create-modal/);
  });

  test('фильтр categoryId передаётся в listPatterns', () => {
    expect(src).toMatch(/listPatterns\(\{[\s\S]*categoryId,?[\s\S]*\}\)/);
  });

  test('chip-иконки используют iconImageUrl с fallback на iconKey', () => {
    // CategoryChipIcon рендерит <img> при iconImageUrl, иначе lucide.
    expect(src).toMatch(/CategoryChipIcon/);
    expect(src).toMatch(/iconImageUrl/);
    expect(src).toMatch(/resolvePatternCategoryIcon/);
  });

  test('chip-иконки задают увеличенные размеры через CSS-класс с вариантами', () => {
    // Этап «UI: крупные плитки фильтра категорий»: filter-вариант
    // отрисовывается крупной плиткой (см. `globals.css`), строка
    // таблицы остаётся 32×32. Размеры реализованы CSS-классами в
    // `apps/web/app/globals.css`, а в JSX задаются через `variant`.
    expect(src).toMatch(/variant="filter"/);
    expect(src).toMatch(/variant="row"/);
    expect(src).toMatch(/pattern-category-icon/);
  });

  test('chip фильтра категории — только иконка + title/aria-label, без текста', () => {
    // Этап «UI: крупные плитки фильтра категорий»: чипсы категорий
    // отображают только иконку, название категории доступно через
    // tooltip / a11y. Кнопка «Все» остаётся текстовой.
    expect(src).toMatch(/title=\{c\.name\}/);
    expect(src).toMatch(/aria-label=|ariaLabel=/);
    expect(src).toMatch(/ariaLabel=\{`Фильтр: \$\{c\.name\}`\}/);
    // Текстовое название рядом с иконкой в filter-чипе убрали.
    expect(src).not.toMatch(/variant="filter"[\s\S]*?<span>\{c\.name\}<\/span>/);
    // Внутри `CategoryFilterChip` нет старого `<span>{c.name}</span>`
    // между иконкой и закрывающим тегом чипа.
    expect(src).not.toMatch(/<span>\{c\.name\}<\/span>/);
  });

  test('старая модалка категории удалена', () => {
    expect(
      exists('apps/web/app/admin/patterns/category-create-modal.tsx'),
    ).toBe(false);
    expect(
      exists(
        'apps/web/app/admin/patterns/category-create-modal-launcher.tsx',
      ),
    ).toBe(false);
  });

  test('chip категории — wrapper с sibling edit-link на /admin/pattern-categories/[id]', () => {
    // Этап «Редактируемые категории»: чип категории — wrapper с двумя
    // sibling-link-ами. Основной Link продолжает фильтровать список,
    // вторая ссылка ведёт на страницу редактирования категории.
    // ВАЖНО: нельзя вкладывать `<a>` в `<a>` — поэтому проверяем класс
    // wrapper-а `.pattern-category-filter` и наличие edit-href в JSX.
    expect(src).toMatch(/pattern-category-filter\b/);
    expect(src).toMatch(/pattern-category-filter__edit/);
    // editHref передаётся в чип и указывает на страницу редактирования.
    expect(src).toMatch(/editHref=\{`\/admin\/pattern-categories\/\$\{c\.id\}`\}/);
    expect(src).toMatch(/editAriaLabel=\{`Редактировать категорию: \$\{c\.name\}`\}/);
    // Импорт Pencil-иконки из lucide.
    expect(src).toMatch(/Pencil/);
  });
});

describe('admin/patterns — CSS hover/focus для edit-link на чипе категории', () => {
  // Этап «Редактируемые категории»: edit-button скрыт по умолчанию и
  // появляется на hover/focus. Реализовано CSS-классами в globals.css.
  const css = readFileSync(
    path.join(repoRoot, 'apps/web/app/globals.css'),
    'utf8',
  );

  test('globals.css содержит классы pattern-category-filter и __edit', () => {
    expect(css).toMatch(/\.pattern-category-filter\s*\{/);
    expect(css).toMatch(/\.pattern-category-filter__edit\s*\{/);
  });

  test('edit-link скрыт по умолчанию и появляется на hover/focus', () => {
    expect(css).toMatch(
      /\.pattern-category-filter__edit\s*\{[\s\S]*?opacity:\s*0/,
    );
    // hover родителя и focus-within внутри показывают edit.
    expect(css).toMatch(
      /\.pattern-category-filter:hover\s+\.pattern-category-filter__edit[\s\S]*?opacity:\s*1/,
    );
    expect(css).toMatch(
      /\.pattern-category-filter:focus-within\s+\.pattern-category-filter__edit[\s\S]*?opacity:\s*1/,
    );
  });
});

describe('admin/pattern-categories/[id] — страница редактирования', () => {
  test('файлы страницы существуют и являются client/server компонентами', () => {
    expect(exists(CAT_EDIT_PAGE)).toBe(true);
    expect(exists(CAT_EDIT_FORM)).toBe(true);
    expect(exists(CAT_EDIT_ACTIONS)).toBe(true);
    expect(exists(CAT_EDIT_FORM_STATE)).toBe(true);
    expect(read(CAT_EDIT_FORM).startsWith("'use client'")).toBe(true);
    expect(read(CAT_EDIT_ACTIONS).startsWith("'use server'")).toBe(true);
  });

  test('страница содержит заголовок «Редактировать категорию» и подгружает категорию', () => {
    const src = read(CAT_EDIT_PAGE);
    expect(src).toMatch(/Редактировать категорию/);
    expect(src).toMatch(/getPatternCategory/);
    expect(src).toMatch(/EditPatternCategoryForm/);
    // Если категория не найдена — 404 (Next.js notFound).
    expect(src).toMatch(/notFound\(\)/);
  });

  test('форма имеет блоки Основное / Иконка / Параметры и не показывает технических заголовков', () => {
    const src = read(CAT_EDIT_FORM);
    // Заголовки секций — те же, что в форме создания.
    expect(src).toMatch(/Основное/);
    expect(src).toMatch(/Иконка/);
    expect(src).toMatch(/Параметры категории/);
    // Технические заголовки (`roleKey` / `inputType` / `iconKey` /
    // `sortOrder` / `status`) не должны показываться пользователю.
    expect(src).not.toMatch(/<th[^>]*>\s*roleKey\s*</);
    expect(src).not.toMatch(/<th[^>]*>\s*inputType\s*</);
    expect(src).not.toMatch(/<th[^>]*>\s*iconKey\s*</);
    expect(src).not.toMatch(/<th[^>]*>\s*sortOrder\s*</);
    expect(src).not.toMatch(/>\s*sortOrder\s*</);
    // Никакого PATTERN_CATEGORY_ICON_KEYS-селекта.
    expect(src).not.toMatch(/PATTERN_CATEGORY_ICON_KEYS/);
  });

  test('заголовки таблицы — пользовательские: Название параметра / Группа параметра / Ввод в номенклатуре / Единица потребности / Обязательный', () => {
    const src = read(CAT_EDIT_FORM);
    expect(src).toMatch(/Название параметра/);
    // Этап «UI labels»: бывшая колонка «Роль материала» переименована
    // в «Группа параметра» (для фурнитуры это не «связь с техкартой»).
    expect(src).toMatch(/Группа параметра/);
    expect(src).not.toMatch(/<th>Роль материала<\/th>/);
    // Этап «Исправить смысл и расчёт LINEAR_M_BY_SIZE»: бывшие
    // «Как заполнять» / «Единица» переименованы в осмысленные
    // «Ввод в номенклатуре» / «Единица потребности», старые
    // подписи больше не показываются.
    expect(src).toMatch(/Ввод в номенклатуре/);
    expect(src).toMatch(/Единица потребности/);
    expect(src).not.toMatch(/<th>Как заполнять<\/th>/);
    // «<th>Единица<…» (само по себе слово в шапке колонки) не
    // должно встречаться: оно всегда часть «Единица потребности».
    expect(src).not.toMatch(/<th>Единица<\//);
    expect(src).toMatch(/Обязательный/);
    // Название категории и описание тоже видны.
    expect(src).toMatch(/Название категории/);
    expect(src).toMatch(/Описание/);
  });

  test('файловый input принимает JPG/JPEG/PNG (растровые иконки)', () => {
    const src = read(CAT_EDIT_FORM);
    expect(src).toMatch(/name="iconFile"/);
    expect(src).toMatch(
      /accept="\.jpg,\.jpeg,\.png,image\/jpeg,image\/png"/,
    );
    expect(src).toMatch(/encType="multipart\/form-data"/);
    // Подсказка про JPG/PNG.
    expect(src).toMatch(/JPG/);
    expect(src).toMatch(/PNG/);
  });

  test('понятные лейблы для типов ввода (AREA_M2_BY_SIZE → Площадь по размерам, ...)', () => {
    // Форма редактирования категории берёт лейблы из shared
    // (`PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS`) — поэтому
    // проверяем импорт здесь и сами строки в shared отдельным тестом.
    const src = read(CAT_EDIT_FORM);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS/);
    const sharedSrc = read(SHARED);
    expect(sharedSrc).toMatch(/AREA_M2_BY_SIZE:\s*'Площадь по размерам'/);
    expect(sharedSrc).toMatch(/QTY_PER_ITEM:\s*'Количество на изделие'/);
    expect(sharedSrc).toMatch(/TEXT_ONLY:\s*'Описание \/ услуга'/);
    // Этап «Доработка параметров категорий номенклатуры»: новый тип.
    expect(sharedSrc).toMatch(
      /LINEAR_M_BY_SIZE:\s*'Погонные метры по размерам'/,
    );
  });

  test('пользовательские лейблы групп параметров — без слова «Упаковка»', () => {
    const src = read(CAT_EDIT_FORM);
    // Этап «Доработка параметров категорий номенклатуры»: форма
    // использует whitelist `PATTERN_CATEGORY_PARAMETER_GROUPS`
    // (а не глобальный `MATERIAL_ROLES` техкарты). Все группы
    // должны быть размечены человеко-читаемым лейблом, чтобы
    // пользователю не светить технический roleKey.
    expect(src).toMatch(/Основное полотно/);
    expect(src).toMatch(/Рибана/);
    expect(src).toMatch(/Подклад/);
    expect(src).toMatch(/Нитки/);
    // Этап «UI labels»: вместо «Упаковка / фурнитура» показываем
    // только «Фурнитура»; технический ключ PACKAGING не светится в UI.
    expect(src).toMatch(/Фурнитура/);
    expect(src).not.toMatch(/Упаковка \/ фурнитура/);
    expect(src).not.toMatch(/'Упаковка'/);
    // Форма категорий теперь не использует MATERIAL_ROLES (это
    // whitelist техкарты). Импорта быть не должно.
    expect(src).not.toMatch(/from\s+'@sewing\/shared\/material-roles'/);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_GROUPS/);
  });

  test('блок действий — Сохранить / Архивировать / К номенклатуре', () => {
    const src = read(CAT_EDIT_FORM);
    expect(src).toMatch(/Сохранить/);
    expect(src).toMatch(/Архивировать/);
    expect(src).toMatch(/К номенклатуре/);
    // «К номенклатуре» — Link на /admin/patterns.
    expect(src).toMatch(/href="\/admin\/patterns"/);
  });

  test('action использует существующие API: PATCH + PUT параметры + POST иконка + DELETE архив', () => {
    const src = read(CAT_EDIT_ACTIONS);
    expect(src).toMatch(/editPatternCategoryPageAction\b/);
    expect(src).toMatch(/archivePatternCategoryPageAction\b/);
    expect(src).toMatch(/updatePatternCategory\b/);
    expect(src).toMatch(/replacePatternCategoryParameters\b/);
    expect(src).toMatch(/uploadPatternCategoryIcon\b/);
    expect(src).toMatch(/archivePatternCategory\b/);
    // soft-archive: после успеха редирект на /admin/patterns.
    expect(src).toMatch(/redirect\('\/admin\/patterns'\)/);
  });

  test('action не падает молча, если иконка не загрузилась (правки сохраняются)', () => {
    const src = read(CAT_EDIT_ACTIONS);
    expect(src).toMatch(/iconWarning/);
  });

  test('form-state содержит EditPatternCategoryPageState', () => {
    const fs = read(CAT_EDIT_FORM_STATE);
    expect(fs).toMatch(/EditPatternCategoryPageState\b/);
    expect(fs).toMatch(/initialEditPatternCategoryPageState\b/);
  });
});

describe('admin/pattern-categories/new — отдельная страница создания', () => {
  test('файлы страницы существуют и являются client/server компонентами', () => {
    expect(exists(CAT_NEW_PAGE)).toBe(true);
    expect(exists(CAT_NEW_FORM)).toBe(true);
    expect(exists(CAT_NEW_ACTIONS)).toBe(true);
    expect(exists(CAT_NEW_FORM_STATE)).toBe(true);
    expect(read(CAT_NEW_FORM).startsWith("'use client'")).toBe(true);
    expect(read(CAT_NEW_ACTIONS).startsWith("'use server'")).toBe(true);
  });

  test('страница содержит «Добавить категорию» и подзаголовок', () => {
    const src = read(CAT_NEW_PAGE);
    expect(src).toMatch(/Добавить категорию/);
    expect(src).toMatch(
      /Категория определяет параметры, которые заполняются в номенклатуре\./,
    );
    expect(src).toMatch(/CreatePatternCategoryForm/);
  });

  test('форма имеет блоки Основное / Иконка / Параметры', () => {
    const src = read(CAT_NEW_FORM);
    // Заголовки секций.
    expect(src).toMatch(/Основное/);
    expect(src).toMatch(/Иконка/);
    expect(src).toMatch(/Параметры категории/);
    // Подсказка под загрузку поддерживает JPG/PNG (текст может быть
    // разбит на несколько строк JSX-литералом — учитываем переносы).
    expect(src).toMatch(/JPG или PNG-иконку категории/);
    expect(src).toMatch(/Поддерживаются JPG, JPEG и\s+PNG/);
    expect(src).toMatch(/отображается в фильтрах/);
    // Главное: пользователю больше не говорим только «JPEG».
    expect(src).not.toMatch(/Загрузите JPEG-иконку категории/);
    expect(src).not.toMatch(/Выбрать JPEG-файл/);
  });

  test('форма содержит Название категории / Название параметра / Группа параметра / Ввод в номенклатуре / Единица потребности / Обязательный', () => {
    const src = read(CAT_NEW_FORM);
    expect(src).toMatch(/Название категории/);
    expect(src).toMatch(/Название параметра/);
    // Этап «Исправить смысл и расчёт LINEAR_M_BY_SIZE»: бывшие
    // «Как заполнять» / «Единица» переименованы в осмысленные
    // «Ввод в номенклатуре» / «Единица потребности».
    expect(src).toMatch(/Ввод в номенклатуре/);
    expect(src).toMatch(/Единица потребности/);
    expect(src).not.toMatch(/<th>Как заполнять<\/th>/);
    expect(src).not.toMatch(/<th>Единица<\//);
    expect(src).toMatch(/Обязательный/);
    // Этап «UI labels»: бывшая колонка «Роль материала / связь с
    // техкартой» переименована в «Группа параметра».
    expect(src).toMatch(/Группа параметра/);
    expect(src).not.toMatch(/<th>Роль материала<\/th>/);
  });

  test('лейблы группы параметра не используют слово «Упаковка» (только «Фурнитура»)', () => {
    const src = read(CAT_NEW_FORM);
    expect(src).toMatch(/Фурнитура/);
    // Слово «Упаковка» в форме категории не должно встречаться
    // (ни как лейбл группы, ни в тексте). Технический ключ PACKAGING
    // используется в шаблонах — это допустимо.
    expect(src).not.toMatch(/Упаковка/);
    expect(src).not.toMatch(/Упаковка \/ фурнитура/);
  });

  test('новые группы параметров доступны в форме (Дополнительное полотно, Наполнитель, Дублерин, Маркировка)', () => {
    // Этап «Доработка параметров категорий номенклатуры», ТЗ §1.
    // Группы приходят из `PATTERN_CATEGORY_PARAMETER_GROUPS` —
    // shared whitelist; форма не выписывает лейблы вручную, поэтому
    // мы проверяем сам импорт + рендер групп через select.
    const src = read(CAT_NEW_FORM);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_GROUPS/);
    // Импорта MATERIAL_ROLES в форме категорий быть не должно
    // (whitelist техкарты не используется здесь).
    expect(src).not.toMatch(/from\s+'@sewing\/shared\/material-roles'/);
  });

  test('новый inputType «Погонные метры по размерам» — в шаблонах и select', () => {
    const src = read(CAT_NEW_FORM);
    // Шаблоны Худи / Футболка / Куртка должны использовать
    // LINEAR_M_BY_SIZE для основных полотен (см. ТЗ §4 «Шаблоны
    // категорий»).
    expect(src).toMatch(/'LINEAR_M_BY_SIZE'/);
    // 'м пог.' — единица по умолчанию для погонных метров.
    expect(src).toMatch(/'м пог\.'/);
    // Лейбл нового типа ввода — приходит из shared (через
    // PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS).
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS/);
  });

  test('файловый input принимает JPG/JPEG/PNG (растровые иконки)', () => {
    const src = read(CAT_NEW_FORM);
    expect(src).toMatch(/name="iconFile"/);
    expect(src).toMatch(
      /accept="\.jpg,\.jpeg,\.png,image\/jpeg,image\/png"/,
    );
    expect(src).toMatch(/encType="multipart\/form-data"/);
  });

  test('никаких технических заголовков (roleKey / inputType / iconKey / sortOrder / status)', () => {
    const src = read(CAT_NEW_FORM);
    // Нет ни одного <th> или <label> с техническим текстом.
    // (Внутри кода значения этих ключей могут встречаться как whitelist —
    // например, MATERIAL_ROLES — это нормально; запрещаем именно
    // показывать их как заголовки колонок / лейблы инпутов.)
    expect(src).not.toMatch(/<th[^>]*>\s*roleKey\s*</);
    expect(src).not.toMatch(/<th[^>]*>\s*inputType\s*</);
    expect(src).not.toMatch(/<th[^>]*>\s*iconKey\s*</);
    expect(src).not.toMatch(/<th[^>]*>\s*sortOrder\s*</);
    expect(src).not.toMatch(/>\s*sortOrder\s*</);
    // Никакого PATTERN_CATEGORY_ICON_KEYS-селекта (lucide whitelist
    // больше не показываем пользователю).
    expect(src).not.toMatch(/PATTERN_CATEGORY_ICON_KEYS/);
  });

  test('понятные лейблы для типов ввода (AREA_M2_BY_SIZE → Площадь по размерам, ...)', () => {
    // Форма создания категории берёт лейблы из shared
    // (`PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS`) — поэтому
    // проверяем импорт здесь и сами строки в shared отдельным тестом
    // выше (см. CAT_EDIT_FORM описание).
    const src = read(CAT_NEW_FORM);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS/);
  });

  test('быстрые шаблоны Футболка / Худи / Куртка / Поло, шаблон Худи содержит несколько фурнитурных параметров с roleKey PACKAGING', () => {
    const src = read(CAT_NEW_FORM);
    expect(src).toMatch(/Футболка/);
    expect(src).toMatch(/Худи/);
    expect(src).toMatch(/Куртка/);
    expect(src).toMatch(/Поло/);
    expect(src).toMatch(/'MAIN_FABRIC'/);
    expect(src).toMatch(/'RIB'/);
    expect(src).toMatch(/Рибана/);
    // Этап «Фурнитура: разрешить несколько параметров с одним roleKey».
    // Шаблон «Худи» должен содержать несколько строк с roleKey
    // PACKAGING (Люверсы / Шнур / Наконечники) и QTY_PER_ITEM.
    expect(src).toMatch(/'PACKAGING'/);
    expect(src).toMatch(/'QTY_PER_ITEM'/);
    expect(src).toMatch(/Люверсы/);
    expect(src).toMatch(/Шнур/);
    expect(src).toMatch(/Наконечники/);
    // В шаблоне «Куртка» — Молния / Кнопки.
    expect(src).toMatch(/Молния/);
    expect(src).toMatch(/Кнопки/);
    // В шаблоне «Поло» — Пуговицы.
    expect(src).toMatch(/Пуговицы/);
    // Минимум 3 раза встречается строка `roleKey: 'PACKAGING'` —
    // у Худи (Люверсы / Шнур / Наконечники), у Куртки (Молния / Кнопки),
    // у Поло (Пуговицы): итого ≥6 PACKAGING-параметров в шаблонах.
    const packagingMatches = src.match(/roleKey:\s*'PACKAGING'/g) ?? [];
    expect(packagingMatches.length).toBeGreaterThanOrEqual(6);
  });

  test('action создаёт категорию и грузит иконку отдельным запросом', () => {
    const src = read(CAT_NEW_ACTIONS);
    expect(src).toMatch(/createPatternCategoryPageAction\b/);
    expect(src).toMatch(/createPatternCategory\b/);
    expect(src).toMatch(/uploadPatternCategoryIcon\b/);
    // После успеха — redirect на /admin/patterns?categoryId=...
    expect(src).toMatch(/redirect\(`\/admin\/patterns\?categoryId=/);
  });

  test('action не падает молча, если иконка не загрузилась (категория остаётся)', () => {
    const src = read(CAT_NEW_ACTIONS);
    expect(src).toMatch(/iconWarning/);
  });
});

describe('admin/patterns — server actions и api wrapper', () => {
  const api = read(CATEGORIES_API);

  test('lib/pattern-categories-api.ts — CRUD функции + uploadIcon', () => {
    expect(exists(CATEGORIES_API)).toBe(true);
    for (const fn of [
      'listPatternCategories',
      'getPatternCategory',
      'createPatternCategory',
      'updatePatternCategory',
      'replacePatternCategoryParameters',
      'archivePatternCategory',
      // Этап «Загружаемая JPEG-иконка категории»: новый multipart-метод.
      'uploadPatternCategoryIcon',
    ]) {
      expect(api).toMatch(new RegExp(`export function ${fn}\\b`));
    }
    // multipart helper используется.
    expect(api).toMatch(/apiFetchMultipart/);
  });

  test('listPatterns принимает categoryId', () => {
    const p = read(PATTERNS_API);
    expect(p).toMatch(/query\.categoryId/);
  });

  test('replacePatternMaterialAreasAction поддерживает __roleKeys', () => {
    const a = read(ACTIONS);
    expect(a).toMatch(/__roleKeys/);
    // fallback на MATERIAL_ROLES если roleKeysCsv пуст.
    expect(a).toMatch(/MATERIAL_ROLES/);
  });

  test('actions передают categoryId в pattern create/update', () => {
    const a = read(ACTIONS);
    expect(a).toMatch(/categoryId:\s*\n?\s*form\.get\('categoryId'\)/);
  });

  test('form-state содержит CreatePatternCategoryPageState', () => {
    const fs = read(CAT_NEW_FORM_STATE);
    expect(fs).toMatch(/CreatePatternCategoryPageState\b/);
    expect(fs).toMatch(/initialCreatePatternCategoryPageState\b/);
  });
});

// ---------------------------------------------------------------------------
// 5. Frontend — формы лекала используют categoryId select
// ---------------------------------------------------------------------------

describe('admin/patterns/[id]/edit-form.tsx — categoryId select', () => {
  const src = read(EDIT_FORM);

  test('select по PatternCategoryListItemDto', () => {
    expect(src).toMatch(/categories:\s*PatternCategoryListItemDto\[\]/);
    expect(src).toMatch(/name="categoryId"/);
    expect(src).toMatch(/categories\.map/);
  });

  test('legacy categoryCode сохраняется hidden input-ом, не редактируется в UI', () => {
    expect(src).toMatch(/<input[\s\S]*type="hidden"[\s\S]*name="categoryCode"/);
    // Никакого видимого text input для categoryCode.
    expect(src).not.toMatch(/<input[\s\S]*name="categoryCode"[\s\S]*type="text"/);
  });

  test('legacy hint показывается, когда categoryId null + categoryCode непустой', () => {
    expect(src).toMatch(/Старая категория:/);
  });
});

describe('admin/patterns/create-form.tsx — categoryId select', () => {
  const src = read(CREATE_FORM);
  test('форма принимает categories prop и рендерит select', () => {
    expect(src).toMatch(/categories:\s*PatternCategoryListItemDto\[\]/);
    expect(src).toMatch(/name="categoryId"/);
    // Подсказка про создание категории.
    expect(src).toMatch(/Создайте категорию/);
  });

  test('forms /admin/patterns/new загружает категории', () => {
    const np = read(NEW_PAGE);
    expect(np).toMatch(/listPatternCategories/);
  });
});

// ---------------------------------------------------------------------------
// 6. «Площади материалов» — колонки по параметрам категории
// ---------------------------------------------------------------------------

describe('admin/patterns/[id]/material-areas-form.tsx — категорийные колонки', () => {
  const src = read(AREAS_FORM);

  test('форма принимает categoryAreaParameters и hasCategory', () => {
    expect(src).toMatch(/categoryAreaParameters\?:/);
    expect(src).toMatch(/hasCategory\?:/);
  });

  test('колонки по параметрам категории, fallback на MATERIAL_ROLES', () => {
    // useCategoryColumns ветвление + fallback.
    expect(src).toMatch(/useCategoryColumns/);
    expect(src).toMatch(/MATERIAL_ROLES/);
    expect(src).toMatch(/categoryAreaParameters/);
    // __roleKeys hidden input для action.
    expect(src).toMatch(/__roleKeys/);
  });

  test('empty-state «В категории нет параметров площади»', () => {
    expect(src).toMatch(/В категории нет параметров площади/);
  });

  test('label берётся из parameter.label, materialRole — из parameter.roleKey', () => {
    expect(src).toMatch(/p\.label/);
    expect(src).toMatch(/p\.roleKey/);
  });

  test('manager пробрасывает categoryAreaParameters в форму', () => {
    const mgr = read(SIZES_MGR);
    expect(mgr).toMatch(/categoryAreaParameters/);
    expect(mgr).toMatch(/hasCategory/);
  });

  test('форма не показывает QTY_PER_ITEM колонки (фурнитура остаётся вне «Площадей»)', () => {
    // Этап «Фурнитура: разрешить несколько параметров категории с
    // одним roleKey». Defence-in-depth: даже если backend вдруг отдаст
    // `categoryAreaParameters` без фильтра, фронт фильтрует по
    // `inputType === 'AREA_M2_BY_SIZE'`. См. ТЗ §7 «Material areas».
    expect(src).toMatch(/inputType\s*===\s*'AREA_M2_BY_SIZE'/);
    expect(src).toMatch(/areaColumnsFromCategory/);
  });
});

// ---------------------------------------------------------------------------
// 7. Гарантии «не сломали остальное»
// ---------------------------------------------------------------------------

describe('Этап «Категории номенклатуры» — guards: не сломали остальное', () => {
  test('PatternMaterialArea остаётся прежним (materialRole — String)', () => {
    expect(read(SCHEMA)).toMatch(/model PatternMaterialArea\s*\{[\s\S]*materialRole\s+String/);
  });

  test('Order / OrderItem / Passport / Product / WorkshopNeed модели не получили category-полей через эту миграцию', () => {
    const mig = read(MIGRATION);
    // categoryId добавляется только на PatternItem; на других таблицах
    // — не должно быть.
    expect(mig).not.toMatch(/ALTER\s+TABLE\s+"Order"[\s\S]*categoryId/i);
    expect(mig).not.toMatch(/ALTER\s+TABLE\s+"OrderItem"[\s\S]*categoryId/i);
    expect(mig).not.toMatch(/ALTER\s+TABLE\s+"Passport"[\s\S]*categoryId/i);
    expect(mig).not.toMatch(/ALTER\s+TABLE\s+"Product"[\s\S]*categoryId/i);
    expect(mig).not.toMatch(
      /ALTER\s+TABLE\s+"WorkshopNeed"[\s\S]*categoryId/i,
    );
  });

  test('detail page показывает категорию (live или legacy hint)', () => {
    const src = read(DETAIL_PAGE);
    expect(src).toMatch(/PatternCategoryDisplay/);
    expect(src).toMatch(/Старая категория:/);
  });

  test('detail page рисует крупную иконку категории через --detail класс', () => {
    // Этап «Доработка иконок категорий»: иконка в карточке лекала —
    // 48×48 (CSS-класс `pattern-category-icon--detail`).
    const src = read(DETAIL_PAGE);
    expect(src).toMatch(/pattern-category-icon--detail/);
    expect(src).toMatch(/PatternCategoryDisplayIcon/);
  });

  test('globals.css содержит классы pattern-category-icon с вариантами', () => {
    const css = read('apps/web/app/globals.css');
    expect(css).toMatch(/\.pattern-category-icon\s*\{/);
    expect(css).toMatch(/\.pattern-category-icon--filter\s*\{/);
    expect(css).toMatch(/\.pattern-category-icon--detail\s*\{/);
    // Базовый размер 32, фильтр — плитка 80×80 (этап
    // «UI: компактные плитки фильтра категорий 80×80»), detail 48.
    expect(css).toMatch(/\.pattern-category-icon\s*\{[\s\S]*?width:\s*32px/);
    expect(css).toMatch(
      /\.pattern-category-icon--filter\s*\{[\s\S]*?width:\s*80px/,
    );
    expect(css).toMatch(
      /\.pattern-category-icon--filter\s*\{[\s\S]*?height:\s*80px/,
    );
    expect(css).toMatch(
      /\.pattern-category-icon--filter\s*\{[\s\S]*?border-radius:\s*16px/,
    );
    expect(css).toMatch(
      /\.pattern-category-icon--detail\s*\{[\s\S]*?width:\s*48px/,
    );
    // object-fit: cover для <img> внутри.
    expect(css).toMatch(/\.pattern-category-icon img\s*\{[\s\S]*?object-fit:\s*cover/);
  });

  test('MATERIAL_ROLES глобальный fallback не удалён', () => {
    // shared/material-roles.ts не трогали.
    const src = read('packages/shared/src/material-roles.ts');
    expect(src).toMatch(/MATERIAL_ROLES/);
    expect(src).toMatch(/'MAIN_FABRIC'/);
  });
});

// ---------------------------------------------------------------------------
// 8. UI polish: компактная колонка «Единица потребности»
// ---------------------------------------------------------------------------
//
// Этап «Сделать колонку „Единица потребности“ в форме категории
// номенклатуры сильно компактнее»: длинный пояснительный текст
// «В какой единице строка попадёт в Потребность цеха» под каждым
// select-ом и в шапке колонки раздувал строку и растягивал колонку.
// Теперь:
//   - в шапке таблицы рядом с лейблом стоит маленький ⓘ с tooltip
//     (`title="В этой единице строка попадёт в «Потребность цеха»."`);
//   - под каждым unit-select-ом нет постоянного длинного текста;
//   - сам `<select name="param_*_unit">` помечен классом
//     `pattern-category-param-row__unit`, а CSS закрепляет за ним
//     `max-width: 150px`;
//   - в `<colgroup>` выделена колонка `pattern-category-param-table__unit-col`
//     шириной 150 px.
// allowedUnits / defaultUnit / расчёт WorkshopNeed не трогаем — это
// чисто UI/CSS polish.

describe('admin/pattern-categories — компактная колонка «Единица потребности»', () => {
  const newForm = read(CAT_NEW_FORM);
  const editForm = read(CAT_EDIT_FORM);
  const css = read('apps/web/app/globals.css');

  test('обе формы сохраняют label «Единица потребности»', () => {
    for (const src of [newForm, editForm]) {
      expect(src).toMatch(/Единица потребности/);
    }
  });

  test('пояснение «В какой единице строка попадёт…» больше не висит постоянным div под каждым select', () => {
    // Старый длинный мут-текст под select-ом и длинное пояснение
    // в шапке колонки убраны (см. описание выше). Заодно убедимся,
    // что в файле нет старой формулировки «В какой единице…».
    for (const src of [newForm, editForm]) {
      expect(src).not.toMatch(/В какой единице строка попадёт/);
      expect(src).not.toMatch(
        /<div[^>]*>\s*В этой единице строка попадёт/,
      );
    }
  });

  test('пояснение доступно как title (tooltip) и в шапке, и на самом select', () => {
    const tooltipText =
      'В этой единице строка попадёт в «Потребность цеха».';
    for (const src of [newForm, editForm]) {
      expect(src).toContain(`title="${tooltipText}"`);
      // Маленький ⓘ-индикатор и класс .admin-inline-help на шапке.
      expect(src).toMatch(/admin-inline-help/);
      expect(src).toMatch(/admin-inline-help__icon/);
      expect(src).toMatch(/ⓘ/);
      // На select-е — aria-label «Единица потребности» (для скринридеров,
      // т.к. лейбл-визуально отделён от input-а).
      expect(src).toMatch(/aria-label="Единица потребности"/);
    }
  });

  test('select unit-а имеет класс pattern-category-param-row__unit и сидит в colgroup-колонке 150 px', () => {
    for (const src of [newForm, editForm]) {
      // Класс на select.
      expect(src).toMatch(/pattern-category-param-row__unit/);
      // <col className="pattern-category-param-table__unit-col" />
      expect(src).toMatch(/pattern-category-param-table__unit-col/);
      // Подтверждение, что colgroup действительно объявлен.
      expect(src).toMatch(/<colgroup>/);
    }
    // CSS-ширина закреплена за колонкой и за самим select-ом.
    expect(css).toMatch(
      /\.pattern-category-param-table__unit-col\s*\{[\s\S]*?width:\s*150px/,
    );
    expect(css).toMatch(
      /\.pattern-category-param-row__unit\s*\{[\s\S]*?max-width:\s*150px/,
    );
    // Helper-классы для inline-help (ⓘ + title) тоже описаны.
    expect(css).toMatch(/\.admin-inline-help\s*\{/);
    expect(css).toMatch(/\.admin-inline-help__icon\s*\{/);
  });

  test('колонка «Ввод в номенклатуре» осталась компактной (одна строка пояснения вида «Ввод: …»)', () => {
    // Длинное «Единица ввода: …» убрали; вместо этого — короткая
    // подпись «Ввод: <strong>м пог.</strong>» под select-ом, чтобы
    // строка не плодила 3 уровня текста.
    for (const src of [newForm, editForm]) {
      expect(src).toMatch(/Ввод:\s*<strong>\{inputUnitLabel\}<\/strong>/);
      expect(src).not.toMatch(/Единица ввода:/);
    }
  });

  test('бизнес-инвариант: allowedUnits / defaultUnit / WorkshopNeed расчёт не меняли (shared whitelist цел)', () => {
    const sharedSrc = read(SHARED);
    // Дефолт «кг» для основного полотна — этап «Исправить смысл LINEAR_M_BY_SIZE»,
    // здесь только UI polish, не должны его задеть.
    expect(sharedSrc).toMatch(/getDefaultUnitForParameterGroup/);
    expect(sharedSrc).toMatch(/allowedUnits/);
    // Конкретные единицы по-прежнему в whitelist-е групп.
    for (const u of ["'кг'", "'м пог.'", "'м²'", "'шт'", "'м'"]) {
      expect(sharedSrc).toContain(u);
    }
  });
});
