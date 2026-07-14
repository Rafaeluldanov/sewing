/**
 * Integration-тесты фичи «Параметры техкарт».
 *
 * Параметр — именованный слот в ЯЧЕЙКЕ строки материала («Полотно → плотность»),
 * значение вводится в ЗАКАЗЕ, по каждой расцветке отдельно. Один шаблон
 * заменяет несколько близнецов ТК-*-160/190/220.
 *
 * Покрытие:
 *   1. Слот материализуется в заказ по расцветкам; значение подставляется в
 *      снимок И В LEGACY-КОЛОНКУ `densityGsm` — именно её читает расчёт
 *      потребности. Параметр, записавший только JSON-характеристику, был бы
 *      виден в UI и молча не влиял бы на закупку.
 *   2. Разные значения по расцветкам → разные плотности в снимке.
 *   3. Гейт `ORDER_SPEC_INCOMPLETE`: с пустым обязательным слотом заказ не
 *      уходит в расчёт, в payload — какая расцветка и какие поля.
 *   4. ФАЗА 2 «техкарта живёт в заказе»: правка шаблона НЕ протекает в заказ,
 *      но количества пересчитываются, а «Обновить из шаблона» подтягивает.
 *   5. Строка, добавленная прямо в заказ, переживает смену техкарты.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — параметры техкарт', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;
  /** Лекало заказа: `startCalculation` требует его первым же гейтом. */
  let patternItemId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    manager = loginAs(t, seed.employees['shop-chief']);
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Худи',
        article: `ART-${Date.now().toString(36)}`,
        status: 'ACTIVE',
      },
    });
    patternItemId = pattern.id;
  });

  /** Шаблон с параметром «плотность», привязанным к ячейке строки полотна. */
  async function createParametricTechCard(opts?: {
    code?: string;
    defaultValue?: string | null;
    qtyPerUnit?: string;
  }): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', manager)
      .send({
        code: opts?.code ?? 'TC-PARAM',
        name: 'Кулирка параметрическая',
        parameters: [
          {
            key: 'main_density',
            label: 'Плотность',
            inputType: 'ENUM',
            options: ['160', '190', '220'],
            unit: 'г/м²',
            isRequired: true,
            ...(opts?.defaultValue === null
              ? {}
              : { defaultValue: opts?.defaultValue ?? '190' }),
          },
        ],
        materialLines: [
          {
            name: 'Полотно',
            unit: 'м2',
            qtyPerUnit: opts?.qtyPerUnit ?? '0.42',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'кулирка',
            colorRule: 'ORDER_COLOR',
            parameterBindings: { 'char:density': 'main_density' },
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  /** Заказ с двумя расцветками на одной техкарте. */
  async function createOrderWithTwoColorways(techCardId: string): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-14T00:00:00.000Z',
        patternItemId,
        techCardId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          {
            color: 'Белый',
            techCardId,
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }],
          },
          {
            color: 'Чёрный',
            techCardId,
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }],
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  const snapshot = (orderId: string) =>
    t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      orderBy: [{ variantColor: 'asc' }, { sortOrder: 'asc' }],
    });

  test('слот материализуется по расцветкам и подставляется в legacy-колонку', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);

    const params = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .expect(200);

    expect(params.body.variants).toHaveLength(2);
    for (const v of params.body.variants) {
      expect(v.parameters).toHaveLength(1);
      // Значение по умолчанию из шаблона.
      expect(v.parameters[0].value).toBe('190');
      expect(v.parameters[0].valueSource).toBe('TEMPLATE');
      expect(v.missingRequiredCount).toBe(0);
      // Параметр знает, в какую ячейку он подставляется.
      expect(v.parameters[0].targets[0].field).toBe('char:density');
    }

    const rows = await snapshot(orderId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // КЛЮЧЕВОЕ: и JSON-характеристика, и legacy-колонка. Downstream
      // (WorkshopNeeds/cut-readiness/себестоимость) читает именно колонку.
      expect(r.densityGsm).toBe(190);
      expect(r.characteristics).toMatchObject({ density: 190 });
      // totalQty = qtyPerUnit × тираж расцветки.
      expect(Number(r.totalQty)).toBeCloseTo(r.variantColor === 'Белый' ? 25.2 : 16.8, 4);
    }
  });

  test('разные значения по расцветкам дают разные плотности в снимке', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);

    const params = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .expect(200);
    const black = params.body.variants.find(
      (v: { color: string }) => v.color === 'Чёрный',
    );

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card-parameters/${black.parameters[0].id}`)
      .set('Cookie', manager)
      .send({ value: '220' })
      .expect(200);

    const rows = await snapshot(orderId);
    const byColor = Object.fromEntries(rows.map((r) => [r.variantColor, r.densityGsm]));
    expect(byColor).toEqual({ Белый: 190, Чёрный: 220 });

    // Значение вне списка ENUM отбивается.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card-parameters/${black.parameters[0].id}`)
      .set('Cookie', manager)
      .send({ value: '999' })
      .expect(409);
  });

  test('пустой обязательный слот не пускает заказ в расчёт', async () => {
    const techCardId = await createParametricTechCard({ defaultValue: null });
    const orderId = await createOrderWithTwoColorways(techCardId);

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(400);

    expect(res.body.code).toBe('ORDER_SPEC_INCOMPLETE');
    // UI должен подсветить конкретные плитки — значит payload обязан доехать.
    const colors = res.body.details.variants.map((v: { color: string }) => v.color);
    expect(colors.sort()).toEqual(['Белый', 'Чёрный']);
    expect(res.body.details.variants[0].parameters[0].label).toBe('Плотность');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('DRAFT');
  });

  test('фаза 2: правка шаблона не протекает в заказ, но количества пересчитываются', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);

    const variants = await t.prisma.orderVariant.findMany({
      where: { orderId },
      orderBy: { ordinal: 'asc' },
    });
    const white = variants.find((v) => v.color === 'Белый')!;

    // Шаблон в справочнике изменился.
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${techCardId}`)
      .set('Cookie', manager)
      .send({
        materialLines: [
          {
            name: 'Полотно ПЕРЕИМЕНОВАНО',
            unit: 'м2',
            qtyPerUnit: '0.99',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'двунитка',
            colorRule: 'ORDER_COLOR',
            parameterBindings: { 'char:density': 'main_density' },
          },
        ],
      })
      .expect(200);

    // Пересборка заказа (самый частый путь — правка расцветки).
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/colorways/${white.id}`)
      .set('Cookie', manager)
      .send({
        color: 'Белый',
        techCardId,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      })
      .expect(200);

    const rows = await snapshot(orderId);
    // Структура НЕ поехала: имя и норма прежние.
    expect(rows.every((r) => r.name === 'Полотно')).toBe(true);
    expect(rows.every((r) => Number(r.qtyPerUnit) === 0.42)).toBe(true);
    // Количества — пересчитаны: 0.42 × 100.
    const whiteRow = rows.find((r) => r.variantColor === 'Белый')!;
    expect(Number(whiteRow.totalQty)).toBeCloseTo(42, 4);

    // Осознанный клапан подтягивает шаблон.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/reload-from-template`)
      .set('Cookie', manager)
      .expect(201);

    const reloaded = await snapshot(orderId);
    expect(reloaded.every((r) => r.name === 'Полотно ПЕРЕИМЕНОВАНО')).toBe(true);
    expect(reloaded.every((r) => Number(r.qtyPerUnit) === 0.99)).toBe(true);
    // Значение параметра пережило перезагрузку — оно живёт в своей таблице.
    expect(reloaded.every((r) => r.densityGsm === 190)).toBe(true);
  });

  test('строка, добавленная в заказе, переживает смену техкарты', async () => {
    const techCardId = await createParametricTechCard();
    const other = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', manager)
      .send({
        code: 'TC-OTHER',
        name: 'Другая',
        materialLines: [
          {
            name: 'Футер',
            unit: 'м2',
            qtyPerUnit: '0.77',
            materialRole: 'MAIN_FABRIC',
            colorRule: 'ORDER_COLOR',
          },
        ],
      })
      .expect(201);
    const orderId = await createOrderWithTwoColorways(techCardId);

    const variants = await t.prisma.orderVariant.findMany({ where: { orderId } });
    const black = variants.find((v) => v.color === 'Чёрный')!;

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({
        orderVariantId: black.id,
        name: 'Лента усилительная',
        unit: 'м',
        qtyPerUnit: '0.9',
      })
      .expect(201);

    // Тираж ручной строки считается тем же путём: 0.9 × 40.
    let manual = await t.prisma.orderMaterialRequirement.findFirst({
      where: { orderId, isManual: true },
    });
    expect(Number(manual?.totalQty)).toBeCloseTo(36, 4);

    // Смена техкарты расцветки: шаблонная строка заменяется, ручная — нет.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/colorways/${black.id}`)
      .set('Cookie', manager)
      .send({
        color: 'Чёрный',
        techCardId: other.body.id,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }],
      })
      .expect(200);

    const rows = await snapshot(orderId);
    const blackRows = rows.filter((r) => r.variantColor === 'Чёрный');
    expect(blackRows.map((r) => r.name).sort()).toEqual([
      'Лента усилительная',
      'Футер',
    ]);
    manual = blackRows.find((r) => r.isManual)!;
    expect(manual.name).toBe('Лента усилительная');

    // Убрать строку из шаблона через этот эндпоинт нельзя.
    const fromTemplate = blackRows.find((r) => !r.isManual)!;
    const res = await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/tech-card/lines/${fromTemplate.id}`)
      .set('Cookie', manager)
      .expect(409);
    expect(res.body.code).toBe('ORDER_MATERIAL_LINE_FROM_TEMPLATE');
  });
});
