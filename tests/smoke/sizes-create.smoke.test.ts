/**
 * Smoke-тесты этапа «Создание пользовательского размера»
 * (см. ТЗ «Добавить возможность создавать пользовательские размеры
 * через страницу номенклатуры», `apps/api/src/modules/sizes/*`,
 * `apps/web/app/admin/patterns/[id]/create-size-modal.tsx`,
 * `packages/shared/src/sizes.ts`).
 *
 * Цель smoke-тестов:
 *   - зафиксировать контракт shared-схемы (`CreateSizeSchema`,
 *     `normalizeSizeCode`, `SizeDto`);
 *   - убедиться, что backend-эндпоинт `POST /api/sizes` существует
 *     и подключён в `AppModule`;
 *   - проверить, что на карточке номенклатуры есть кнопка
 *     «Создать размер», модалка с placeholder и текстом «общем
 *     справочнике», server action `createSizeAction` есть, и
 *     `revalidatePath('/admin/patterns/[id]')` вызывается;
 *   - убедиться, что admin order forms используют listSizes, а не
 *     hardcoded списки.
 *
 * Все тесты — source-level (без запуска браузера / NestJS).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  CreateSizeSchema,
  SIZE_CODE_MAX_LENGTH,
  normalizeSizeCode,
  type SizeDto,
} from '@sewing/shared/sizes';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}
function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

// ---------------------------------------------------------------------------
// 1. Shared: схема + нормализатор
// ---------------------------------------------------------------------------

describe('shared/sizes — CreateSizeSchema + normalizeSizeCode', () => {
  test('normalizeSizeCode приводит «человеческий ввод» к каноничной форме', () => {
    expect(normalizeSizeCode('200*300*10')).toBe('200×300×10');
    expect(normalizeSizeCode('200x300x10')).toBe('200×300×10');
    expect(normalizeSizeCode('200X300X10')).toBe('200×300×10');
    // Кириллическая «х» между цифрами тоже должна стать ×.
    expect(normalizeSizeCode('200х300х10')).toBe('200×300×10');
    // Уже каноничный — не меняется.
    expect(normalizeSizeCode('200×300×10')).toBe('200×300×10');
    // Пробелы вокруг разделителей.
    expect(normalizeSizeCode('200 x 300 x 10')).toBe('200×300×10');
    // Trim + collapse пробелов.
    expect(normalizeSizeCode('  6xl ')).toBe('6XL');
    // ASCII-латиница: подъём регистра. «shopper-200x300x10» →
    // «SHOPPER-200×300×10». Зафиксировано тестом, чтобы новые
    // изменения нормализатора не «съехали» по casing-у.
    expect(normalizeSizeCode('shopper-200x300x10')).toBe(
      'SHOPPER-200×300×10',
    );
    // Кириллические строки: регистр сохраняется как у пользователя
    // (см. комментарий в `normalizeSizeCode`).
    expect(normalizeSizeCode('сумка 200x300x10')).toBe('сумка 200×300×10');
    expect(normalizeSizeCode('плед 120×150')).toBe('плед 120×150');
    // Стандартные размеры остаются на месте.
    expect(normalizeSizeCode('XS')).toBe('XS');
    expect(normalizeSizeCode('104')).toBe('104');
    expect(normalizeSizeCode('  6XL  ')).toBe('6XL');
  });

  test('CreateSizeSchema нормализует и парсит код', () => {
    const r = CreateSizeSchema.safeParse({ code: '200*300*10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.code).toBe('200×300×10');
      expect(r.data.sortOrder).toBeUndefined();
    }
  });

  test('CreateSizeSchema принимает sortOrder опционально', () => {
    const ok = CreateSizeSchema.safeParse({
      code: 'XYZ-1',
      sortOrder: 999,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.sortOrder).toBe(999);
  });

  test('CreateSizeSchema отбивает пустую строку и слишком длинную', () => {
    expect(CreateSizeSchema.safeParse({ code: '' }).success).toBe(false);
    expect(CreateSizeSchema.safeParse({ code: '   ' }).success).toBe(false);
    const tooLong = '1'.repeat(SIZE_CODE_MAX_LENGTH + 1);
    expect(CreateSizeSchema.safeParse({ code: tooLong }).success).toBe(false);
  });

  test('SizeDto re-export доступен из @sewing/shared/sizes', () => {
    // Smoke-проверка: тип используется, чтобы tsc убедился, что он
    // действительно экспортирован. Если бы re-export-а не было, эта
    // строка не скомпилировалась бы.
    const _example: SizeDto = { id: 'x', code: 'M', sortOrder: 10 };
    expect(_example.code).toBe('M');
  });
});

// ---------------------------------------------------------------------------
// 2. Backend: модуль/контроллер/сервис POST /api/sizes
// ---------------------------------------------------------------------------

const SIZES_MODULE = 'apps/api/src/modules/sizes/sizes.module.ts';
const SIZES_CONTROLLER = 'apps/api/src/modules/sizes/sizes.controller.ts';
const SIZES_SERVICE = 'apps/api/src/modules/sizes/sizes.service.ts';
const APP_MODULE = 'apps/api/src/app.module.ts';
const CATALOG_CONTROLLER =
  'apps/api/src/modules/catalog/catalog.controller.ts';

describe('api/sizes — модуль, контроллер, сервис', () => {
  test('файлы модуля существуют', () => {
    expect(exists(SIZES_MODULE)).toBe(true);
    expect(exists(SIZES_CONTROLLER)).toBe(true);
    expect(exists(SIZES_SERVICE)).toBe(true);
  });

  test('SizesModule подключён в AppModule', () => {
    const src = read(APP_MODULE);
    expect(src).toMatch(
      /import\s*\{\s*SizesModule\s*\}\s*from\s*'\.\/modules\/sizes\/sizes\.module\.js'/,
    );
    // В imports массиве AppModule.
    expect(src).toMatch(/SizesModule\b/);
  });

  test('SizesController — POST /api/sizes под RBAC ADMIN/SHOP_MANAGER', () => {
    const src = read(SIZES_CONTROLLER);
    expect(src).toMatch(/@Controller\(\s*['"]sizes['"]\s*\)/);
    expect(src).toMatch(/@Roles\(\s*['"]ADMIN['"]\s*,\s*['"]SHOP_MANAGER['"]/);
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/CreateSizeSchema/);
    expect(src).toMatch(/CreateSizeDto/);
    // Контракт ответа — SizeDto.
    expect(src).toMatch(/Promise<SizeDto>/);
  });

  test('SizesService — idempotent create, normalize, max+10 sortOrder, аудит', () => {
    const src = read(SIZES_SERVICE);
    // Проверяем существование на code.
    expect(src).toMatch(/findUnique\(\s*\{\s*where:\s*\{\s*code\s*\}/);
    // Idempotent return существующего размера.
    expect(src).toMatch(/return toDto\(existing\)/);
    // sortOrder = max + 10, если не передан.
    expect(src).toMatch(/aggregate\(\s*\{[\s\S]*_max:\s*\{\s*sortOrder:\s*true\s*\}/);
    expect(src).toMatch(/sortOrder\s*\?\?\s*0\)\s*\+\s*10/);
    // Создание Size.
    expect(src).toMatch(/this\.prisma\.size\.create/);
    // Аудит SIZE_CREATED.
    expect(src).toMatch(/event:\s*['"]SIZE_CREATED['"]/);
    expect(src).toMatch(/entityType:\s*['"]SIZE['"]/);
  });

  test('GET /api/sizes по-прежнему отдаётся CatalogController (любая роль)', () => {
    // Read-only contract не сломали — write-эндпоинт живёт в отдельном
    // модуле, чтобы списки/формы могли продолжать ходить без ADMIN.
    const src = read(CATALOG_CONTROLLER);
    expect(src).toMatch(/@Get\(\s*['"]sizes['"]\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Frontend: «Создать размер» на странице номенклатуры
// ---------------------------------------------------------------------------

const PAGE = 'apps/web/app/admin/patterns/[id]/page.tsx';
const MANAGER = 'apps/web/app/admin/patterns/[id]/pattern-sizes-manager.tsx';
const CREATE_MODAL = 'apps/web/app/admin/patterns/[id]/create-size-modal.tsx';
const ACTIONS = 'apps/web/app/admin/patterns/actions.ts';
const FORM_STATE = 'apps/web/app/admin/patterns/form-state.ts';
const ORDERS_API = 'apps/web/lib/orders-api.ts';

describe('admin/patterns/[id] — кнопка и модалка «Создать размер»', () => {
  test('файлы созданы и являются клиентскими', () => {
    expect(exists(CREATE_MODAL)).toBe(true);
    expect(read(CREATE_MODAL).startsWith("'use client'")).toBe(true);
  });

  test('PatternSizesManager подключает CreateSizeModal и отдельный openCreateSize', () => {
    const src = read(MANAGER);
    expect(src).toMatch(/from '\.\/create-size-modal'/);
    expect(src).toMatch(/<CreateSizeModal\b/);
    expect(src).toMatch(/openCreateSize/);
    expect(src).toMatch(/createSizeOpen\b/);
    // В заголовке блока «Размеры номенклатуры» рендерится отдельная
    // кнопка «Создать размер» рядом с «Добавить размер».
    expect(src).toMatch(/Создать размер/);
    expect(src).toMatch(/Добавить размер/);
  });

  test('модалка имеет dialog-семантику и контракт ввода', () => {
    const src = read(CREATE_MODAL);
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    // Заголовок и подсказка про общий справочник.
    expect(src).toMatch(/Создать размер/);
    expect(src).toMatch(/общем справочнике/);
    // Подсказка про доступность во всех номенклатурах и заказах.
    expect(src).toMatch(/во всех номенклатурах и заказах/);
    // Поле ввода с placeholder, упомянутым в ТЗ.
    expect(src).toMatch(/placeholder="например, 200×300×10"/);
    // Принимаются альтернативные написания.
    expect(src).toMatch(/200×300×10/);
    // Сабмит-кнопка «Создать» (текст — внутри SubmitButton).
    expect(src).toMatch(/['"]Создать['"]/);
    expect(src).toMatch(/type="submit"/);
    // Action биндится по patternId.
    expect(src).toMatch(/createSizeAction\.bind\(null,\s*patternId\)/);
  });

  test('createSizeAction есть в actions.ts и ревалидирует страницу + cache tag', () => {
    const src = read(ACTIONS);
    expect(src).toMatch(/export async function createSizeAction\b/);
    // Использует CreateSizeSchema из shared.
    expect(src).toMatch(/CreateSizeSchema/);
    // Вызывает backend через createSize.
    expect(src).toMatch(/createSize\(/);
    // Ревалидирует /admin/patterns/[id] (через шаблон с patternId).
    expect(src).toMatch(/revalidatePath\(`\/admin\/patterns\/\$\{patternId\}`\)/);
    // И `sizes` cache-tag, чтобы listSizes() обновился во всех формах.
    expect(src).toMatch(/revalidateTag\(\s*['"]sizes['"]\s*\)/);
  });

  test('CreateSizeState и initial-значение есть в form-state', () => {
    const src = read(FORM_STATE);
    expect(src).toMatch(/export interface CreateSizeState\b/);
    expect(src).toMatch(/export const initialCreateSizeState/);
  });

  test('lib/orders-api.ts экспортирует createSize и сохраняет listSizes', () => {
    const src = read(ORDERS_API);
    expect(src).toMatch(/export function createSize\b/);
    // POST /sizes.
    expect(src).toMatch(/'\/sizes'[\s\S]*method:\s*'POST'/);
    // listSizes продолжает использовать cache-tag 'sizes', который мы
    // ревалидируем.
    expect(src).toMatch(/tags:\s*\[\s*['"]sizes['"]\s*\]/);
  });

  test('страница карточки номенклатуры по-прежнему грузит sizes через listSizes', () => {
    // Ничего не сломали в существующей загрузке справочника.
    const src = read(PAGE);
    expect(src).toMatch(/listSizes/);
  });
});

// ---------------------------------------------------------------------------
// 4. Order forms продолжают использовать listSizes (нет hardcoded
//    списков размеров)
// ---------------------------------------------------------------------------

describe('order forms — sizes из listSizes (а не hardcoded)', () => {
  const ORDER_FILES = [
    'apps/web/app/orders/new/page.tsx',
    'apps/web/app/orders/[id]/edit/page.tsx',
    'apps/web/app/admin/orders/new/page.tsx',
    'apps/web/app/admin/orders/[id]/edit/page.tsx',
  ];

  test('каждая форма заказа берёт sizes из listSizes()', () => {
    for (const f of ORDER_FILES) {
      expect(exists(f)).toBe(true);
      const src = read(f);
      expect(src).toMatch(/listSizes\(\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Никаких новых таблиц / миграций / правок схемы
// ---------------------------------------------------------------------------

describe('Prisma не менялся: existing model Size, никаких новых миграций', () => {
  test('model Size существует с существующими полями', () => {
    const schemaPath = 'prisma/schema.prisma';
    if (!exists(schemaPath)) return;
    const src = read(schemaPath);
    expect(src).toMatch(/^model Size\s*\{/m);
    // Базовые поля справочника.
    expect(src).toMatch(/code\s+String\s+@unique/);
    expect(src).toMatch(/sortOrder\s+Int\b/);
  });

  test('OrderItem.sizeId / Passport.sizeId / PatternSizeFile.sizeId — на месте', () => {
    const schemaPath = 'prisma/schema.prisma';
    if (!exists(schemaPath)) return;
    const src = read(schemaPath);
    // OrderItem — sizeId String (не nullable).
    expect(src).toMatch(/model OrderItem\s*\{[\s\S]*?sizeId\s+String\b/);
    // Passport — sizeId String (не nullable).
    expect(src).toMatch(/model Passport\s*\{[\s\S]*?sizeId\s+String\b/);
    // PatternSizeFile — sizeId String.
    expect(src).toMatch(/model PatternSizeFile\s*\{[\s\S]*?sizeId\s+String\b/);
  });
});
