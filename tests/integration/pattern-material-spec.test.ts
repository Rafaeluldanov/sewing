/**
 * Integration-тесты этапа 1 плана «техкарты → номенклатура» (анализ
 * 11.08.2026): спецификация материалов в карточке номенклатуры.
 *
 * Покрываем контракт `PUT /api/patterns/:id/material-spec`
 * (`PatternsService.replaceMaterialSpec` + нормализация
 * `pattern-material-spec.util.ts` — адаптация
 * `TechCardsService.materialLineCreateData`):
 *
 *   1. Сохранение строк + слотов-параметров, roundtrip через
 *      `GET /api/patterns/:id` (`materialSpecLines` / `specParameters`).
 *   2. Нормализация: `sortOrder = (i+1)*10`; characteristics зеркалят
 *      legacy-колонки (`densityGsm`/`plannedWidthCm` ↔ density/rollWidth);
 *      для PACKAGING density/width зачищаются, hardware-поля живут только
 *      у PACKAGING; `normUnit === unit` схлопывается в null.
 *   3. Full-replace: повторный PUT пересоздаёт строки (старых id нет).
 *   4. Валидация: невалидная роль → 400 `PATTERN_MATERIAL_ROLE_INVALID`;
 *      биндинг на несуществующий параметр → 400; FIXED_COLOR без цвета →
 *      400; дубль ключа параметра → 400; несуществующий pattern → 404.
 *   5. Клонирование копирует спецификацию вместе с карточкой.
 *
 * Техкарты в этих тестах сознательно не участвуют: этап 1 аддитивен и
 * не должен зависеть от справочника техкарт.
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
import { seedMinimal } from '../utils/seed';

describeWithDb('integration — pattern item material spec', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
  });

  let patternCounter = 0;
  async function createPattern(): Promise<string> {
    patternCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Худи спецификация',
        article: `SPEC-${patternCounter}`,
      })
      .expect(201);
    return r.body.id as string;
  }

  function putSpec(patternId: string, body: unknown) {
    return request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-spec`)
      .set('Cookie', t.adminCookie)
      .send(body as object);
  }

  test('PUT сохраняет строки и слоты; roundtrip и нормализация', async () => {
    const patternId = await createPattern();
    const r = await putSpec(patternId, {
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'кг',
          normUnit: 'м пог.',
          qtyPerUnit: '1.2',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'кулирка',
          densityGsm: 160,
          plannedWidthCm: 180,
          colorRule: 'ORDER_COLOR',
          parameterBindings: { 'char:density': 'main_density' },
        },
        {
          name: 'Молния',
          unit: 'шт',
          // Единица нормы совпадает с закупочной — сервис обязан
          // схлопнуть расщепление в null.
          normUnit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          fabricType: 'Молния',
          subtypeKey: 'ZIPPER',
          // Для PACKAGING density/width должны зачиститься в null.
          densityGsm: 999,
          plannedWidthCm: 999,
          hardwareSizeText: '№5',
          hardwareMaterialText: 'металл',
          colorRule: 'ORDER_SELECTED_COLOR',
        },
      ],
      parameters: [
        {
          key: 'main_density',
          label: 'Плотность полотна',
          inputType: 'NUMBER',
          unit: 'г/м²',
          isRequired: true,
        },
      ],
    }).expect(200);

    expect(r.body.materialSpecLines).toHaveLength(2);
    expect(r.body.specParameters).toHaveLength(1);

    const [fabric, zipper] = r.body.materialSpecLines;
    // sortOrder нормализуется как (i + 1) * 10 — как у техкарты.
    expect(fabric.sortOrder).toBe(10);
    expect(zipper.sortOrder).toBe(20);
    // Расщепление единиц сохраняется только когда единицы разные.
    expect(fabric.normUnit).toBe('м пог.');
    expect(zipper.normUnit).toBeNull();
    // characteristics зеркалят legacy-колонки ткани.
    expect(fabric.densityGsm).toBe(160);
    expect(fabric.characteristics).toMatchObject({
      density: 160,
      rollWidth: 180,
    });
    expect(fabric.parameterBindings).toEqual({
      'char:density': 'main_density',
    });
    // Роль-зависимая очистка: у фурнитуры нет плотности/ширины, зато
    // hardware-поля живут и зеркалятся в characteristics.
    expect(zipper.densityGsm).toBeNull();
    expect(zipper.plannedWidthCm).toBeNull();
    expect(zipper.hardwareSizeText).toBe('№5');
    expect(zipper.characteristics).toMatchObject({
      size: '№5',
      material: 'металл',
    });

    const param = r.body.specParameters[0];
    expect(param).toMatchObject({
      key: 'main_density',
      label: 'Плотность полотна',
      inputType: 'NUMBER',
      unit: 'г/м²',
      isRequired: true,
    });

    // GET карточки отдаёт то же самое (roundtrip).
    const g = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(g.body.materialSpecLines).toHaveLength(2);
    expect(g.body.specParameters).toHaveLength(1);
  });

  test('повторный PUT — full-replace: старые id пересоздаются', async () => {
    const patternId = await createPattern();
    const first = await putSpec(patternId, {
      materialLines: [
        { name: 'Кулирка', unit: 'кг', qtyPerUnit: '1' },
        { name: 'Рибана', unit: 'кг', qtyPerUnit: '0.2' },
      ],
      parameters: [],
    }).expect(200);
    const oldIds = first.body.materialSpecLines.map((l: { id: string }) => l.id);

    const second = await putSpec(patternId, {
      materialLines: [{ name: 'Футер', unit: 'кг', qtyPerUnit: '1.5' }],
      parameters: [],
    }).expect(200);
    expect(second.body.materialSpecLines).toHaveLength(1);
    expect(oldIds).not.toContain(second.body.materialSpecLines[0].id);

    // Пустой PUT очищает спецификацию целиком.
    const cleared = await putSpec(patternId, {
      materialLines: [],
      parameters: [],
    }).expect(200);
    expect(cleared.body.materialSpecLines).toHaveLength(0);
  });

  test('валидация: роль вне whitelist → PATTERN_MATERIAL_ROLE_INVALID', async () => {
    const patternId = await createPattern();
    const r = await putSpec(patternId, {
      materialLines: [
        { name: 'X', unit: 'кг', qtyPerUnit: '1', materialRole: 'NOT_A_ROLE' },
      ],
      parameters: [],
    }).expect(400);
    expect(r.body.code).toBe('PATTERN_MATERIAL_ROLE_INVALID');
  });

  test('валидация: биндинг на несуществующий параметр → 400', async () => {
    const patternId = await createPattern();
    const r = await putSpec(patternId, {
      materialLines: [
        {
          name: 'X',
          unit: 'кг',
          qtyPerUnit: '1',
          parameterBindings: { 'char:density': 'ghost' },
        },
      ],
      parameters: [],
    }).expect(400);
    expect(JSON.stringify(r.body)).toContain('ghost');
  });

  test('валидация: FIXED_COLOR без цвета и дубль ключа параметра → 400', async () => {
    const patternId = await createPattern();
    await putSpec(patternId, {
      materialLines: [
        { name: 'X', unit: 'кг', qtyPerUnit: '1', colorRule: 'FIXED_COLOR' },
      ],
      parameters: [],
    }).expect(400);

    await putSpec(patternId, {
      materialLines: [],
      parameters: [
        { key: 'dup', label: 'A' },
        { key: 'dup', label: 'B' },
      ],
    }).expect(400);
  });

  test('несуществующий pattern → 404', async () => {
    await putSpec('nonexistent-id', {
      materialLines: [],
      parameters: [],
    }).expect(404);
  });

  test('клонирование копирует спецификацию вместе с карточкой', async () => {
    const patternId = await createPattern();
    await putSpec(patternId, {
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'кг',
          normUnit: 'м пог.',
          qtyPerUnit: '1.2',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'кулирка',
          densityGsm: 160,
          parameterBindings: { 'char:density': 'main_density' },
        },
      ],
      parameters: [
        { key: 'main_density', label: 'Плотность', inputType: 'NUMBER' },
      ],
    }).expect(200);

    const c = await request(t.app.getHttpServer())
      .post(`/api/patterns/${patternId}/clone`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    expect(c.body.materialSpecLines).toHaveLength(1);
    expect(c.body.specParameters).toHaveLength(1);
    expect(c.body.materialSpecLines[0]).toMatchObject({
      name: 'Кулирка',
      normUnit: 'м пог.',
      densityGsm: 160,
      parameterBindings: { 'char:density': 'main_density' },
    });
    // Копия — независимые строки, не ссылки на исходные.
    const src = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(c.body.materialSpecLines[0].id).not.toBe(
      src.body.materialSpecLines[0].id,
    );
  });
});
