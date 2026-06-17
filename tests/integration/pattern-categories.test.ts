/**
 * Integration-тесты этапа «Категории номенклатуры» (см.
 * `apps/api/src/modules/pattern-categories/*`,
 * `apps/api/src/modules/patterns/patterns.service.ts`,
 * `prisma/schema.prisma::PatternCategory` /
 * `PatternCategoryParameter` / `PatternItem.categoryId`).
 *
 * Что проверяем:
 *   1. Создание категории с параметрами `MAIN_FABRIC` и `RIB`.
 *   2. Создание лекала с привязкой к категории.
 *   3. Получение карточки лекала возвращает category + параметры.
 *   4. `GET /api/patterns?categoryId=...` фильтрует по категории.
 *   5. Сохранение площадей по `MAIN_FABRIC` / `RIB` — успешно.
 *   6. Сохранение площади по роли вне категории (`PACKAGING`) — 422
 *      `PATTERN_MATERIAL_ROLE_NOT_IN_CATEGORY`.
 *   7. Категория с архивным статусом — `PATTERN_CATEGORY_INACTIVE`
 *      на create-pattern; soft-archive не трогает уже привязанные.
 *   8. Лекало без `categoryId` (legacy fallback) принимает любой
 *      `materialRole` из `MATERIAL_ROLES`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — pattern-categories', () => {
  let t: TestApp;
  let seed: SeedResult;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function createHoodieCategory(): Promise<{
    id: string;
    parameters: Array<{ id: string; roleKey: string; label: string; inputType: string }>;
  }> {
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Худи',
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основной материал',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'RIB',
            label: 'Кашкорсе',
            inputType: 'AREA_M2_BY_SIZE',
          },
        ],
      })
      .expect(201);
    return { id: r.body.id, parameters: r.body.parameters };
  }

  async function createPattern(opts: {
    article: string;
    categoryId?: string | null;
  }): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Худи база',
        article: opts.article,
        categoryId: opts.categoryId ?? undefined,
      })
      .expect(201);
    return r.body.id;
  }

  // -------------------------------------------------------------------------
  // 1. Категория с параметрами
  // -------------------------------------------------------------------------

  test('создаёт категорию с параметрами MAIN_FABRIC и RIB', async () => {
    const cat = await createHoodieCategory();
    expect(cat.parameters).toHaveLength(2);
    const roles = cat.parameters.map((p) => p.roleKey).sort();
    expect(roles).toEqual(['MAIN_FABRIC', 'RIB']);
    const labels = cat.parameters.map((p) => p.label).sort();
    expect(labels).toEqual(['Кашкорсе', 'Основной материал']);

    // GET возвращает категорию с параметрами и счётчиками.
    const got = await request(t.app.getHttpServer())
      .get(`/api/pattern-categories/${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(got.body.parametersCount).toBe(2);
    expect(got.body.parameters).toHaveLength(2);
  });

  test('параметр с подтипом (FILLER/SINTEPON) сохраняет и возвращает subtypeKey', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Жилетки на синтепоне',
        iconKey: 'PACKAGE',
        parameters: [
          {
            roleKey: 'FILLER',
            subtypeKey: 'SINTEPON',
            label: 'Синтепон',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
        ],
      })
      .expect(201);
    expect(r.body.parameters).toHaveLength(1);
    expect(r.body.parameters[0].subtypeKey).toBe('SINTEPON');
    expect(r.body.parameters[0].roleKey).toBe('FILLER');

    // Параметр «Другое» (без подтипа) сохраняется с subtypeKey = null.
    const r2 = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Категория ручная',
        iconKey: 'PACKAGE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Своё полотно',
            inputType: 'LINEAR_M_BY_SIZE',
          },
        ],
      })
      .expect(201);
    expect(r2.body.parameters[0].subtypeKey).toBeNull();
  });

  test('подтип чужой группы (PACKAGING + SINTEPON) отклоняется', async () => {
    await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Битая категория',
        iconKey: 'PACKAGE',
        parameters: [
          {
            roleKey: 'PACKAGING',
            subtypeKey: 'SINTEPON',
            label: 'Синтепон',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(400);
  });

  // -------------------------------------------------------------------------
  // 2. Лекало с категорией
  // -------------------------------------------------------------------------

  test('создаёт лекало с categoryId и возвращает category в детали', async () => {
    const cat = await createHoodieCategory();
    const patternId = await createPattern({
      article: 'HOODIE-001',
      categoryId: cat.id,
    });
    const detail = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(detail.body.categoryId).toBe(cat.id);
    expect(detail.body.category?.id).toBe(cat.id);
    expect(detail.body.category?.parameters).toHaveLength(2);
    // categoryAreaParameters содержит только AREA_M2_BY_SIZE-параметры
    expect(detail.body.categoryAreaParameters).toHaveLength(2);
  });

  test('фильтр /api/patterns?categoryId возвращает только лекала категории', async () => {
    const cat = await createHoodieCategory();
    await createPattern({ article: 'HOODIE-001', categoryId: cat.id });
    await createPattern({ article: 'HOODIE-002', categoryId: cat.id });
    await createPattern({ article: 'NO-CAT-001', categoryId: null });

    const r = await request(t.app.getHttpServer())
      .get(`/api/patterns?categoryId=${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(r.body).toHaveLength(2);
    const articles = r.body.map((p: { article: string }) => p.article).sort();
    expect(articles).toEqual(['HOODIE-001', 'HOODIE-002']);
  });

  // -------------------------------------------------------------------------
  // 3. Backend material-areas валидация по категории
  // -------------------------------------------------------------------------

  test('сохранение площадей по MAIN_FABRIC и RIB — успешно', async () => {
    const cat = await createHoodieCategory();
    const patternId = await createPattern({
      article: 'HOODIE-VALIDATE-OK',
      categoryId: cat.id,
    });
    const sizeId = seed.sizes.M;

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-areas`)
      .set('Cookie', t.adminCookie)
      .send({
        areas: [
          { sizeId, materialRole: 'MAIN_FABRIC', areaM2: '1.5' },
          { sizeId, materialRole: 'RIB', areaM2: '0.3' },
        ],
      })
      .expect(200);
  });

  test('PACKAGING вне категории Худи отбивается 422 PATTERN_MATERIAL_ROLE_NOT_IN_CATEGORY', async () => {
    const cat = await createHoodieCategory();
    const patternId = await createPattern({
      article: 'HOODIE-VALIDATE-FAIL',
      categoryId: cat.id,
    });
    const sizeId = seed.sizes.M;

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-areas`)
      .set('Cookie', t.adminCookie)
      .send({
        areas: [
          { sizeId, materialRole: 'PACKAGING', areaM2: '1' },
        ],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_MATERIAL_ROLE_NOT_IN_CATEGORY');
    expect(String(r.body.message)).toContain('PACKAGING');
  });

  test('лекало без categoryId принимает любую роль из MATERIAL_ROLES (legacy fallback)', async () => {
    const patternId = await createPattern({
      article: 'LEGACY-001',
      categoryId: null,
    });
    const sizeId = seed.sizes.M;
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-areas`)
      .set('Cookie', t.adminCookie)
      .send({
        areas: [
          { sizeId, materialRole: 'PACKAGING', areaM2: '1' },
          { sizeId, materialRole: 'MAIN_FABRIC', areaM2: '2' },
        ],
      })
      .expect(200);
  });

  // -------------------------------------------------------------------------
  // 4. Архивная категория и status guards
  // -------------------------------------------------------------------------

  test('архивная категория не выбирается на create-pattern (PATTERN_CATEGORY_INACTIVE)', async () => {
    const cat = await createHoodieCategory();
    await request(t.app.getHttpServer())
      .delete(`/api/pattern-categories/${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Худи',
        article: 'INACTIVE-001',
        categoryId: cat.id,
      })
      .expect(409);
    expect(r.body.code).toBe('PATTERN_CATEGORY_INACTIVE');
  });

  test('soft-archive категории не сносит уже привязанные карточки лекал', async () => {
    const cat = await createHoodieCategory();
    const patternId = await createPattern({
      article: 'HOODIE-LIVE',
      categoryId: cat.id,
    });
    await request(t.app.getHttpServer())
      .delete(`/api/pattern-categories/${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    const detail = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    // categoryId по-прежнему привязан, category.status = ARCHIVED.
    expect(detail.body.categoryId).toBe(cat.id);
    expect(detail.body.category?.status).toBe('ARCHIVED');
  });

  // -------------------------------------------------------------------------
  // 5. PUT /parameters — bulk replace
  // -------------------------------------------------------------------------

  test('PUT /pattern-categories/:id/parameters заменяет полный набор', async () => {
    const cat = await createHoodieCategory();
    const r = await request(t.app.getHttpServer())
      .put(`/api/pattern-categories/${cat.id}/parameters`)
      .set('Cookie', t.adminCookie)
      .send({
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основной материал',
            inputType: 'AREA_M2_BY_SIZE',
          },
          // RIB удалили, добавили APPLICATION (нанесение, TEXT_ONLY).
          {
            roleKey: 'APPLICATION',
            label: 'Нанесение',
            inputType: 'TEXT_ONLY',
            unit: '',
          },
        ],
      })
      .expect(200);
    const roles = r.body.parameters.map((p: { roleKey: string }) => p.roleKey).sort();
    expect(roles).toEqual(['APPLICATION', 'MAIN_FABRIC']);
  });

  // -------------------------------------------------------------------------
  // 6. Загружаемая JPEG-иконка категории (этап «Загружаемая JPEG-иконка
  //    категории»). См. `apps/api/src/modules/pattern-categories/
  //    pattern-categories-storage.service.ts`.
  // -------------------------------------------------------------------------

  test('upload JPEG icon — обновляет iconImageUrl + iconOriginalFileName, GET содержит поля', async () => {
    const cat = await createHoodieCategory();
    // Минимальный валидный JPEG (Buffer не обязан быть «правильным»
    // изображением — backend смотрит на расширение и размер).
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const up = await request(t.app.getHttpServer())
      .post(`/api/pattern-categories/${cat.id}/icon`)
      .set('Cookie', t.adminCookie)
      .attach('file', jpegBytes, { filename: 'hoodie.jpg', contentType: 'image/jpeg' })
      // `@Post(':id/icon')` без явного `@HttpCode` отдаёт 201 — это
      // дефолт NestJS для POST. См. `pattern-categories.controller.ts`.
      .expect(201);
    expect(up.body.iconImageUrl).toMatch(
      /\/uploads\/pattern-categories\/[^/]+\/icon\/[^/]+\.jpg$/,
    );
    expect(up.body.iconOriginalFileName).toBe('hoodie.jpg');

    const got = await request(t.app.getHttpServer())
      .get(`/api/pattern-categories/${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(got.body.iconImageUrl).toBe(up.body.iconImageUrl);
    expect(got.body.iconOriginalFileName).toBe('hoodie.jpg');
  });

  test('upload .txt — отклоняется как недопустимое расширение', async () => {
    const cat = await createHoodieCategory();
    const r = await request(t.app.getHttpServer())
      .post(`/api/pattern-categories/${cat.id}/icon`)
      .set('Cookie', t.adminCookie)
      .attach('file', Buffer.from('not a jpeg'), {
        filename: 'sneaky.txt',
        contentType: 'text/plain',
      })
      .expect(400);
    expect(r.body.code).toBe('PATTERN_UPLOAD_INVALID');
  });

  test('upload PNG — обновляет iconImageUrl с расширением .png', async () => {
    // Этап «Доработка иконок категорий: PNG»: backend должен принимать
    // PNG и хранить файл с расширением `.png` (не нормализовать в .jpg).
    const cat = await createHoodieCategory();
    // Минимальный PNG-сигнатурный буфер. Backend смотрит на
    // расширение и размер, поэтому полный валидный PNG не нужен.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const up = await request(t.app.getHttpServer())
      .post(`/api/pattern-categories/${cat.id}/icon`)
      .set('Cookie', t.adminCookie)
      .attach('file', pngBytes, {
        filename: 'hoodie.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect(up.body.iconImageUrl).toMatch(
      /\/uploads\/pattern-categories\/[^/]+\/icon\/[^/]+\.png$/,
    );
    expect(up.body.iconOriginalFileName).toBe('hoodie.png');

    const got = await request(t.app.getHttpServer())
      .get(`/api/pattern-categories/${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(got.body.iconImageUrl).toBe(up.body.iconImageUrl);
    expect(got.body.iconOriginalFileName).toBe('hoodie.png');
  });

  test('upload .svg — отклоняется (whitelist остаётся jpg/jpeg/png)', async () => {
    // SVG исключаем умышленно (риск XSS/SVG-инъекций), даже если
    // PNG/JPG теперь разрешены.
    const cat = await createHoodieCategory();
    const r = await request(t.app.getHttpServer())
      .post(`/api/pattern-categories/${cat.id}/icon`)
      .set('Cookie', t.adminCookie)
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        filename: 'evil.svg',
        contentType: 'image/svg+xml',
      })
      .expect(400);
    expect(r.body.code).toBe('PATTERN_UPLOAD_INVALID');
  });

  // -------------------------------------------------------------------------
  // 7. Этап «Фурнитура: разрешить несколько параметров категории с одним
  //    roleKey» (см. `prisma/schema.prisma` — `PatternCategoryParameter`,
  //    `packages/shared/src/pattern-categories.ts`,
  //    `prisma/migrations/20260518100000_allow_multiple_category_hardware_parameters`).
  // -------------------------------------------------------------------------

  test('создаёт категорию с несколькими PACKAGING / QTY_PER_ITEM параметрами (Люверсы / Молния / Кнопки)', async () => {
    // Несколько параметров фурнитуры в одной категории — основной
    // юзкейс: техническая роль одна и та же (PACKAGING), а строк
    // должно быть несколько (Люверсы / Молния / Кнопки / Пуговицы).
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Куртка',
        iconKey: 'TAG',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'LINING',
            label: 'Подклад',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Молния',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Кнопки',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Пуговицы',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    const labels = r.body.parameters
      .map((p: { label: string }) => p.label)
      .sort();
    expect(labels).toEqual([
      'Кнопки',
      'Молния',
      'Основное полотно',
      'Подклад',
      'Пуговицы',
    ]);
    const packagingRows = r.body.parameters.filter(
      (p: { roleKey: string }) => p.roleKey === 'PACKAGING',
    );
    expect(packagingRows).toHaveLength(3);
    for (const row of packagingRows) {
      expect(row.inputType).toBe('QTY_PER_ITEM');
      expect(row.unit).toBe('шт');
    }
  });

  test('Дубль AREA_M2_BY_SIZE с одним roleKey отклоняется (Zod 400)', async () => {
    // Уникальность roleKey остаётся внутри AREA_M2_BY_SIZE параметров —
    // иначе для PatternMaterialArea.materialRole стало бы неоднозначно,
    // в какую колонку м² уходит ячейка площадей.
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Дубль',
        iconKey: 'TAG',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основной материал',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Доп. полотно',
            inputType: 'AREA_M2_BY_SIZE',
          },
        ],
      })
      .expect(400);
    expect(String(JSON.stringify(r.body))).toMatch(/MAIN_FABRIC/);
  });

  test('PatternItem категории с фурнитурой — categoryAreaParameters содержит только AREA_M2_BY_SIZE', async () => {
    // Создаём категорию «Худи» с площадью + фурнитурой, лекало этой
    // категории, и проверяем что детальная DTO лекала возвращает
    // в `categoryAreaParameters` только AREA_M2_BY_SIZE-параметры.
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Худи (фурнитура)',
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'RIB',
            label: 'Подвязы / кашкорсе',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Люверсы',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Шнур',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Наконечники',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    const patternId = await createPattern({
      article: 'HOODIE-HARDWARE-001',
      categoryId: cat.body.id,
    });
    const detail = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    // Сама категория содержит все 5 параметров.
    expect(detail.body.category?.parameters).toHaveLength(5);
    // А `categoryAreaParameters` — только AREA_M2_BY_SIZE (2 шт).
    expect(detail.body.categoryAreaParameters).toHaveLength(2);
    const areaRoles = detail.body.categoryAreaParameters
      .map((p: { roleKey: string }) => p.roleKey)
      .sort();
    expect(areaRoles).toEqual(['MAIN_FABRIC', 'RIB']);
    for (const p of detail.body.categoryAreaParameters) {
      expect(p.inputType).toBe('AREA_M2_BY_SIZE');
    }
  });

  test('PatternMaterialArea не принимает QTY_PER_ITEM роль (PACKAGING с QTY_PER_ITEM нельзя сохранить как area)', async () => {
    // Защита: backend computeAllowedMaterialRoles фильтрует параметры
    // категории до AREA_M2_BY_SIZE. Если категория содержит только
    // PACKAGING / QTY_PER_ITEM — материальная роль PACKAGING не
    // должна приниматься как area.
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Только фурнитура',
        iconKey: 'TAG',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Люверсы',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    const patternId = await createPattern({
      article: 'HARDWARE-NO-AREA-001',
      categoryId: cat.body.id,
    });
    const sizeId = seed.sizes.M;

    // PACKAGING (QTY_PER_ITEM в категории) НЕ должна сохраняться как
    // area — даже если такая роль формально присутствует у категории.
    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-areas`)
      .set('Cookie', t.adminCookie)
      .send({
        areas: [{ sizeId, materialRole: 'PACKAGING', areaM2: '1' }],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_MATERIAL_ROLE_NOT_IN_CATEGORY');
  });

  test('GET /api/patterns отдаёт categoryIconImageUrl на детальной DTO', async () => {
    const cat = await createHoodieCategory();
    const patternId = await createPattern({
      article: 'HOODIE-ICON-001',
      categoryId: cat.id,
    });
    // Загружаем иконку категории.
    await request(t.app.getHttpServer())
      .post(`/api/pattern-categories/${cat.id}/icon`)
      .set('Cookie', t.adminCookie)
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        filename: 'h.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);

    const list = await request(t.app.getHttpServer())
      .get(`/api/patterns?categoryId=${cat.id}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(list.body[0].categoryIconImageUrl).toMatch(/\/uploads\/pattern-categories\//);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(detail.body.category?.iconImageUrl).toMatch(
      /\/uploads\/pattern-categories\//,
    );
  });
});
