/**
 * Integration-тесты «норма из заказа против нормы номенклатуры» и читаемости
 * строки потребности.
 *
 * Разбор прода 24.08.2026 (заказ 02-00024) вскрыл две вещи помимо нулевого
 * расхода:
 *
 *   1. правка нормы в заказе отбрасывалась сверкой единиц, если технолог
 *      записал единицу со знаменателем — «м/шт» против «м» в номенклатуре.
 *      Нитки: 80 м/шт в заказе, 50 м в номенклатуре, в закупку уходило 5000 м
 *      вместо 8000 — и ни ноты, ни предупреждения;
 *   2. когда единица действительно не сходится, правка тоже молчала: строку
 *      считали по номенклатуре, а на экране заказа стояло другое число;
 *   3. две строки одного типа материала («ПВХ Бирка» и «Жаккардовая Бирка»,
 *      обе `fabricType = Бирка`) давали в потребности две одинаковые строки
 *      «Бирка Графит» — какая из них какая, по списку не понять.
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
import { copySpecLinesTo, createSpecPattern, type SpecLineInput } from '../utils/spec';

describeWithDb('integration — норма заказа vs номенклатура, имя в потребности', () => {
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

  let counter = 0;

  async function createCategory(param: {
    roleKey: string;
    label: string;
    unit: string;
  }): Promise<{ id: string; parameterId: string }> {
    counter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Категория норм ${counter}`,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: param.roleKey,
            label: param.label,
            inputType: 'QTY_PER_ITEM',
            unit: param.unit,
          },
        ],
      })
      .expect(201);
    return { id: r.body.id, parameterId: r.body.parameters[0].id };
  }

  async function createPattern(categoryId: string | null): Promise<string> {
    counter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Лекало норм ${counter}`,
        article: `NORM-PRIO-${counter}`,
        categoryId: categoryId ?? undefined,
      })
      .expect(201);
    return r.body.id as string;
  }

  /** Заказ на 100 шт со спецификацией, скопированной на лекало заказа. */
  async function createOrderWithSpec(
    patternItemId: string,
    materialLines: SpecLineInput[],
  ): Promise<string> {
    counter += 1;
    const donor = await createSpecPattern(t, t.adminCookie, {
      article: `NORM-PRIO-SPEC-${counter}`,
      name: `Спецификация норм ${counter}`,
      materialLines,
    });
    await copySpecLinesTo(t, donor.id, patternItemId);
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-08-24T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      })
      .expect(201);
    return r.body.id as string;
  }

  /** Правка нормы прямо в заказе — она и ставит `qtySource = ORDER`. */
  async function editNormInOrder(
    orderId: string,
    lineName: string,
    qtyPerUnit: string,
  ): Promise<void> {
    const row = await t.prisma.orderMaterialRequirement.findFirstOrThrow({
      where: { orderId, name: lineName },
      select: { id: true },
    });
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card/lines/${row.id}`)
      .set('Cookie', t.adminCookie)
      .send({ qtyPerUnit })
      .expect(200);
  }

  function calculate(orderId: string) {
    return request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({ force: true });
  }

  test('единица нормы со знаменателем («м/шт») сходится с «м» из номенклатуры', async () => {
    const cat = await createCategory({
      roleKey: 'THREAD',
      label: 'Нитки',
      unit: 'м',
    });
    const patternId = await createPattern(cat.id);
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({ norms: [{ categoryParameterId: cat.parameterId, qtyPerItem: '50' }] })
      .expect(200);

    const orderId = await createOrderWithSpec(patternId, [
      {
        name: 'Нитки',
        unit: 'м/шт',
        qtyPerUnit: '1',
        materialRole: 'THREAD',
        fabricType: 'Нитки',
      },
    ]);
    await editNormInOrder(orderId, 'Нитки', '80');

    const calc = await calculate(orderId).expect(201);
    const needs = calc.body.needs as Array<{
      materialRole: string | null;
      calculatedQty: string;
      calculationNote: string | null;
    }>;
    const thread = needs.filter((n) => n.materialRole === 'THREAD');
    expect(thread).toHaveLength(1);
    // 80 м/шт из заказа × 100 шт, а не 50 м/шт из номенклатуры.
    expect(Number(thread[0].calculatedQty)).toBe(8000);
    expect(thread[0].calculationNote).toMatch(/Норма правлена в заказе/);
  });

  test('единица действительно не сходится — правка отброшена, но не молча', async () => {
    const cat = await createCategory({
      roleKey: 'PACKAGING',
      label: 'Люверсы',
      unit: 'шт',
    });
    const patternId = await createPattern(cat.id);
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({ norms: [{ categoryParameterId: cat.parameterId, qtyPerItem: '2' }] })
      .expect(200);

    const orderId = await createOrderWithSpec(patternId, [
      {
        name: 'Шнур',
        unit: 'м',
        qtyPerUnit: '1',
        materialRole: 'PACKAGING',
        fabricType: 'Шнур',
      },
    ]);
    await editNormInOrder(orderId, 'Шнур', '1.2');

    const calc = await calculate(orderId).expect(201);
    const needs = calc.body.needs as Array<{
      materialRole: string | null;
      calculatedQty: string;
      calculationNote: string | null;
    }>;
    const packaging = needs.filter((n) => n.materialRole === 'PACKAGING');
    expect(packaging).toHaveLength(1);
    // Метры шнура не могут стать штуками люверсов — считаем по номенклатуре.
    expect(Number(packaging[0].calculatedQty)).toBe(200);
    expect(packaging[0].calculationNote).toMatch(/правка в расчёт не вошла/);
    expect(
      (calc.body.warnings as string[]).some((w) =>
        /правка в расчёт не вошла/.test(w),
      ),
    ).toBe(true);
  });

  test('две строки одного типа материала различимы в потребности', async () => {
    const patternId = await createPattern(null);
    const orderId = await createOrderWithSpec(patternId, [
      {
        name: 'ПВХ Бирка',
        unit: 'шт',
        qtyPerUnit: '1',
        fabricType: 'Бирка',
        colorRule: 'FIXED_COLOR',
        fixedColorText: 'Графит',
      },
      {
        name: 'Жаккардовая Бирка',
        unit: 'шт',
        qtyPerUnit: '1',
        fabricType: 'Бирка',
        colorRule: 'FIXED_COLOR',
        fixedColorText: 'Графит',
      },
    ]);

    const calc = await calculate(orderId).expect(201);
    const descriptions = (calc.body.needs as Array<{ description: string }>).map(
      (n) => n.description,
    );
    expect(descriptions).toHaveLength(2);
    expect(new Set(descriptions).size).toBe(2);
    expect(descriptions.some((d) => d.includes('ПВХ Бирка'))).toBe(true);
    expect(descriptions.some((d) => d.includes('Жаккардовая Бирка'))).toBe(true);
  });
});
