/**
 * Integration-тесты: «Варианты просчёта заказа»
 * (`/api/orders/:id/calculations`, фича FEATURE_ORDER_CALCULATIONS).
 *
 * Дизайн «активный = живые данные»: активный вариант не хранит данных,
 * его состояние = текущие таблицы заказа; неактивные — JSON-снимок
 * входов. Переключение = capture → restore → пересборка производных
 * существующими путями (см. `OrderCalculationsService.activate`).
 *
 * Покрытие:
 *   1. Создание заказа (оба пути, включая inline-pattern) заводит ровно
 *      одну активную калькуляцию #0.
 *   2. POST /calculations клонирует активный: старый получает валидный
 *      снимок, новый активен, живые таблицы не меняются.
 *   3. Основной сценарий A↔B: расцветки, route-оверрайды (включая
 *      СБРОС утечки carry), ad-hoc параметр, ручная строка снимка
 *      материалов (восстанавливается с исходным id). Смена техкарты
 *      между вариантами ушла вместе со справочником техкарт: состав
 *      материалов теперь живёт в спецификации номенклатуры.
 *   4. Цены закупщика в CALCULATION переживают переключение
 *      (восстановление по match-ключу; статус остаётся CALCULATED).
 *   5. Гейты: REVIEWED-строка → 409; ручная isManual REVIEWED не
 *      блокирует; статус вне DRAFT/CALCULATION → 409; удаление
 *      активного → 409; activate активного → no-op 200.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — варианты просчёта заказа (OrderCalculation)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;
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

  /**
   * Простая спецификация с одной строкой полотна на общем лекале
   * (справочника техкарт больше нет — состав даёт номенклатура).
   */
  async function seedFabricSpec(name: string): Promise<void> {
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternItemId}/material-spec`)
      .set('Cookie', manager)
      .send({
        materialLines: [
          {
            name: `Полотно ${name}`,
            unit: 'м2',
            qtyPerUnit: '0.42',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'кулирка',
            colorRule: 'ORDER_COLOR',
          },
        ],
        parameters: [],
      })
      .expect(200);
  }

  /** Маршрут из двух BY_SIZE-операций (ставки в seed). */
  async function createRouteTemplate(): Promise<string> {
    const rt = await t.prisma.routeTemplate.create({
      data: {
        code: `RT-CALC-${Date.now().toString(36)}`,
        name: 'Маршрут вариантов',
        steps: {
          create: [
            { index: 0, operationId: seed.operations['SEW_OVERLOCK_1'].id },
            { index: 1, operationId: seed.operations['SEW_OVERLOCK_2'].id },
          ],
        },
      },
    });
    return rt.id;
  }

  /** Заказ с двумя расцветками (Белый 60 / Чёрный 40 по размеру M). */
  async function createOrder(routeTemplateId?: string): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-16T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId,
        routeTemplateId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          {
            color: 'Белый',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }],
          },
          {
            color: 'Чёрный',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }],
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  function api() {
    return request(t.app.getHttpServer());
  }

  async function activate(orderId: string, calcId: string, expectStatus = 201) {
    return api()
      .post(`/api/orders/${orderId}/calculations/${calcId}/activate`)
      .set('Cookie', manager)
      .expect(expectStatus);
  }

  /** Оверрайд расценки шага по операции через PUT /route-overrides. */
  async function setRateOverride(
    orderId: string,
    operationId: string,
    rate: number | null,
  ): Promise<void> {
    const step = await t.prisma.orderRouteStep.findFirst({
      where: { orderId, operationId },
      select: { id: true },
    });
    expect(step).not.toBeNull();
    await api()
      .put(`/api/orders/${orderId}/route-overrides`)
      .set('Cookie', manager)
      .send({ steps: [{ stepId: step!.id, rateOverride: rate }] })
      .expect(200);
  }

  async function rateOverrideOf(
    orderId: string,
    operationId: string,
  ): Promise<number | null> {
    const step = await t.prisma.orderRouteStep.findFirst({
      where: { orderId, operationId },
      select: { rateOverride: true },
    });
    return step?.rateOverride == null ? null : Number(step.rateOverride);
  }

  // -------------------------------------------------------------------------

  test('создание заказа заводит ровно одну активную калькуляцию #0', async () => {
    await seedFabricSpec('База');
    const orderId = await createOrder();

    const calcs = await t.prisma.orderCalculation.findMany({
      where: { orderId },
    });
    expect(calcs).toHaveLength(1);
    expect(calcs[0]).toMatchObject({
      ordinal: 0,
      title: 'Вариант 1',
      isActive: true,
      snapshot: null,
    });
  });

  test('inline-pattern путь создания тоже заводит калькуляцию #0', async () => {
    const res = await api()
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-16T00:00:00.000Z',
        clientId: seed.client.id,
        customer: 'Клиент-инлайн',
        productMode: 'CREATE_FOR_CALCULATION',
        newProductCalculation: {
          sizes: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
        },
        items: [],
      })
      .expect(201);
    const calcs = await t.prisma.orderCalculation.findMany({
      where: { orderId: res.body.id as string },
    });
    expect(calcs).toHaveLength(1);
    expect(calcs[0].isActive).toBe(true);
  });

  test('клонирование: старый активный получает снимок, живые данные не меняются', async () => {
    await seedFabricSpec('Клон');
    const orderId = await createOrder();

    const res = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({ title: 'Кулирка 190' })
      .expect(201);

    expect(res.body.items).toHaveLength(2);
    const [first, second] = res.body.items;
    expect(first).toMatchObject({ ordinal: 0, title: 'Вариант 1', isActive: false });
    expect(second).toMatchObject({ ordinal: 1, title: 'Кулирка 190', isActive: true });
    expect(res.body.activeId).toBe(second.id);
    expect(res.body.canSwitch).toBe(true);

    // Снимок старого активного валиден и несёт расцветки.
    const stored = await t.prisma.orderCalculation.findUniqueOrThrow({
      where: { id: first.id as string },
    });
    const snap = stored.snapshot as {
      version: number;
      variants: Array<{ color: string }>;
    };
    expect(snap.version).toBe(1);
    expect(snap.variants.map((v) => v.color)).toEqual(['Белый', 'Чёрный']);

    // Живые таблицы не тронуты — клон == текущие данные.
    expect(
      await t.prisma.orderVariant.count({ where: { orderId } }),
    ).toBe(2);
    const items = await t.prisma.orderItem.findMany({ where: { orderId } });
    expect(items.map((i) => i.qtyPlan)).toEqual([100]);
  });

  test('A↔B: расцветки, route-оверрайды (со сбросом утечки), параметр, ручная строка материалов', async () => {
    await seedFabricSpec('Кулирка 160');
    const rt = await createRouteTemplate();
    const orderId = await createOrder(rt);
    const op1 = seed.operations['SEW_OVERLOCK_1'].id;
    const op2 = seed.operations['SEW_OVERLOCK_2'].id;

    // Состояние варианта A: оверрайд только на op1; ad-hoc параметр на
    // расцветке #0; ручная строка снимка материалов.
    await setRateOverride(orderId, op1, 55.5);
    const variantA0 = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId, ordinal: 0 },
      select: { id: true },
    });
    await t.prisma.orderTechCardParameter.create({
      data: {
        orderId,
        orderVariantId: variantA0.id,
        key: 'density',
        label: 'Плотность',
        inputType: 'TEXT',
        isRequired: false,
        sortOrder: 100,
        sourceTechCardId: null, // ad-hoc: параметр заведён в заказе
        value: '160',
      },
    });
    // Ручная строка снимка материалов — НА РАСЦВЕТКЕ #0 (order-level
    // группа при ≥2 расцветках «мертва», и пересборка снесла бы строку —
    // это существующее поведение rebuild, не фичи).
    const manualRow = await t.prisma.orderMaterialRequirement.create({
      data: {
        orderId,
        orderVariantId: variantA0.id,
        sortOrder: 900,
        name: 'Усилительная лента A',
        unit: 'м',
        qtyPerUnit: '0.1',
        totalQty: '10',
        isManual: true,
      },
      select: { id: true },
    });

    // Клон → вариант B активен; меняем в нём всё.
    const cloneRes = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const calcA = cloneRes.body.items[0].id as string;
    const calcB = cloneRes.body.items[1].id as string;

    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({
        variants: [
          {
            color: 'Красный',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
          },
        ],
      })
      .expect(200);
    await setRateOverride(orderId, op1, 99);
    await setRateOverride(orderId, op2, 77);
    // PATCH variants выше СНЁС каскадом variant-scoped параметр (полная
    // замена OrderVariant — существующее поведение edit-формы). В B
    // заводим свой ad-hoc параметр ORDER-LEVEL (`orderVariantId: null`):
    // при ≤1 расцветке группа параметров живёт на уровне заказа, а
    // variant-scoped группу materializeTechCardParameters счёл бы
    // сиротой и снёс при resync.
    await t.prisma.orderTechCardParameter.create({
      data: {
        orderId,
        orderVariantId: null,
        key: 'density',
        label: 'Плотность',
        inputType: 'TEXT',
        isRequired: false,
        sortOrder: 100,
        sourceTechCardId: null,
        value: '190',
      },
    });
    await t.prisma.orderMaterialRequirement.delete({
      where: { id: manualRow.id },
    });

    // B действительно живёт в живых таблицах.
    expect(
      (await t.prisma.orderItem.findMany({ where: { orderId } })).map(
        (i) => i.qtyPlan,
      ),
    ).toEqual([10]);

    // --- Переключаемся на A: всё состояние A восстановлено -----------------
    await activate(orderId, calcA);

    const variantsA = await t.prisma.orderVariant.findMany({
      where: { orderId },
      orderBy: { ordinal: 'asc' },
      include: { sizes: true },
    });
    expect(variantsA.map((v) => v.color)).toEqual(['Белый', 'Чёрный']);
    expect(variantsA.map((v) => v.sizes[0]?.qtyPlan)).toEqual([60, 40]);
    expect(
      (await t.prisma.orderItem.findMany({ where: { orderId } })).map(
        (i) => i.qtyPlan,
      ),
    ).toEqual([100]);
    // Оверрайды A: op1=55.5, op2 — ЯВНЫЙ null (сброс carry-утечки B).
    expect(await rateOverrideOf(orderId, op1)).toBe(55.5);
    expect(await rateOverrideOf(orderId, op2)).toBeNull();
    // Ad-hoc параметр вернулся со значением A на расцветке #0.
    const paramA = await t.prisma.orderTechCardParameter.findFirstOrThrow({
      where: { orderId, key: 'density' },
      select: { value: true, orderVariantId: true },
    });
    expect(paramA.value).toBe('160');
    expect(paramA.orderVariantId).toBe(
      variantsA.find((v) => v.ordinal === 0)!.id,
    );
    // Ручная строка материалов вернулась С ИСХОДНЫМ id и перецеплена на
    // НОВУЮ расцветку #0 (remap по ordinal).
    const manualBack = await t.prisma.orderMaterialRequirement.findUnique({
      where: { id: manualRow.id },
    });
    expect(manualBack).not.toBeNull();
    expect(manualBack!.isManual).toBe(true);
    expect(manualBack!.orderVariantId).toBe(
      variantsA.find((v) => v.ordinal === 0)!.id,
    );

    // --- И обратно на B: состояние B восстановлено --------------------------
    await activate(orderId, calcB);

    const variantsB = await t.prisma.orderVariant.findMany({
      where: { orderId },
      include: { sizes: true },
    });
    expect(variantsB.map((v) => v.color)).toEqual(['Красный']);
    expect(variantsB[0].sizes[0]?.qtyPlan).toBe(10);
    expect(await rateOverrideOf(orderId, op1)).toBe(99);
    expect(await rateOverrideOf(orderId, op2)).toBe(77);
    expect(
      (
        await t.prisma.orderTechCardParameter.findFirstOrThrow({
          where: { orderId, key: 'density' },
          select: { value: true },
        })
      ).value,
    ).toBe('190');
    // Ручной строки A в варианте B нет — она удалена в B.
    expect(
      await t.prisma.orderMaterialRequirement.findUnique({
        where: { id: manualRow.id },
      }),
    ).toBeNull();
  });

  test('CALCULATION: потребности вариантов сосуществуют; строки и цены живут, ре-линк расцветок', async () => {
    await seedFabricSpec('Цены');
    const orderId = await createOrder();

    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);

    const calcAId = (
      await t.prisma.orderCalculation.findFirstOrThrow({
        where: { orderId, isActive: true },
        select: { id: true },
      })
    ).id;
    const rowsA = await t.prisma.workshopNeed.findMany({
      where: { orderId, isManual: false },
      select: { id: true, orderCalculationId: true },
    });
    expect(rowsA.length).toBeGreaterThan(0);
    // Все строки штампованы активной калькуляцией.
    expect(new Set(rowsA.map((r) => r.orderCalculationId))).toEqual(
      new Set([calcAId]),
    );
    const priced = rowsA[0];
    await t.prisma.workshopNeed.update({
      where: { id: priced.id },
      data: {
        purchaseQty: '50',
        quotedPrice: '123.4500',
        quotedCurrency: 'RUB',
        supplierNameText: 'ООО Ткани',
        comment: 'скидка 5%',
      },
    });

    // Клон в CALCULATION: B становится активным ЧЕРНОВИКОМ — итерация 3:
    // автоматически НЕ рассчитывается (жалоба цеха «другой вариант тоже
    // переводится в расчёт»). Строки A остаются жить рядом.
    const cloneRes = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const calcA = cloneRes.body.items[0].id as string;
    const calcB = cloneRes.body.items[1].id as string;
    expect(calcA).toBe(calcAId);
    // Стадии в DTO: A отправлен на расчёт, клон B — черновик.
    expect(cloneRes.body.items[0].sentToCalculationAt).not.toBeNull();
    expect(cloneRes.body.items[1].sentToCalculationAt).toBeNull();
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcB },
      }),
    ).toBe(0);

    // «Отправить вариант на расчёт» = та же ручка start-calculation
    // (ветка isVariantCalc: заказ уже в CALCULATION, статус не меняется).
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);
    const rowsB = await t.prisma.workshopNeed.findMany({
      where: { orderId, orderCalculationId: calcB },
      select: { id: true },
    });
    expect(rowsB.length).toBe(rowsA.length);
    expect(
      (
        await t.prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        })
      ).status,
    ).toBe('CALCULATION');
    // Повторная отправка уже отправленного варианта — адресная ошибка.
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(409);
    // Строки A живы (те же id, цены на месте).
    const pricedAfterClone = await t.prisma.workshopNeed.findUnique({
      where: { id: priced.id },
    });
    expect(pricedAfterClone).not.toBeNull();
    expect(Number(pricedAfterClone!.quotedPrice)).toBeCloseTo(123.45, 4);

    // Скоуп per-order эндпоинта: default = только активный вариант (B),
    // ?calculationScope=ALL — все строки с меткой варианта.
    const activeScope = await api()
      .get(`/api/orders/${orderId}/workshop-needs`)
      .set('Cookie', manager)
      .expect(200);
    expect(
      new Set(activeScope.body.map((n: { orderCalculationId: string }) => n.orderCalculationId)),
    ).toEqual(new Set([calcB]));
    const allScope = await api()
      .get(`/api/orders/${orderId}/workshop-needs?calculationScope=ALL`)
      .set('Cookie', manager)
      .expect(200);
    expect(allScope.body.length).toBe(rowsA.length + rowsB.length);

    // Переключение на A: строки НЕ пересчитываются (тот же id, цены на
    // месте), а orderVariantId ре-линкуется к пересозданным расцветкам.
    await activate(orderId, calcA);
    const pricedBack = await t.prisma.workshopNeed.findUnique({
      where: { id: priced.id },
    });
    expect(pricedBack).not.toBeNull();
    expect(Number(pricedBack!.purchaseQty)).toBe(50);
    expect(Number(pricedBack!.quotedPrice)).toBeCloseTo(123.45, 4);
    expect(pricedBack!.supplierNameText).toBe('ООО Ткани');
    expect(pricedBack!.comment).toBe('скидка 5%');
    expect(pricedBack!.status).toBe('CALCULATED');
    // Ре-линк: строка снова привязана к живой расцветке своего цвета.
    const relinked = await t.prisma.workshopNeed.findMany({
      where: {
        orderId,
        orderCalculationId: calcA,
        variantColor: { not: null },
      },
      select: { orderVariantId: true, variantColor: true },
    });
    const liveVariants = await t.prisma.orderVariant.findMany({
      where: { orderId },
      select: { id: true, color: true },
    });
    const variantIdByColor = new Map(
      liveVariants.map((v) => [v.color, v.id]),
    );
    for (const r of relinked) {
      expect(r.orderVariantId).toBe(variantIdByColor.get(r.variantColor!));
    }
    // Строки B не тронуты переключением.
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcB },
      }),
    ).toBe(rowsB.length);
  });

  test('смета считается только по активному варианту; PO под неактивный — 409', async () => {
    await seedFabricSpec('Смета');
    const orderId = await createOrder();
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);

    // Вариант A: заполняем цены всем строкам (иначе completeCalculation
    // отдаст ORDER_CALCULATION_INCOMPLETE).
    const calcA = (
      await t.prisma.orderCalculation.findFirstOrThrow({
        where: { orderId, isActive: true },
        select: { id: true },
      })
    ).id;
    await t.prisma.workshopNeed.updateMany({
      where: { orderId, orderCalculationId: calcA },
      data: { purchaseQty: '10', quotedPrice: '100', quotedCurrency: 'RUB' },
    });

    // Клон B (активен, черновик) → явная отправка на расчёт (итерация 3),
    // цены НЕ заполнены. Смета по заказу при активном A обязана видеть
    // только строки A.
    const cloneRes = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const calcB = cloneRes.body.items[1].id as string;
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);
    await activate(orderId, calcA);

    const est = await api()
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    // Σ = строки A: rowsA × 10 шт × 100 ₽; строки B без цен не мешают и
    // не попадают в смету (иначе completeCalculation отдал бы
    // ORDER_CALCULATION_INCOMPLETE, а сумма задвоилась бы).
    const rowsACount = await t.prisma.workshopNeed.count({
      where: { orderId, orderCalculationId: calcA },
    });
    expect(Number(est.body.totalCostRub)).toBe(rowsACount * 10 * 100);

    // PO-гейт: строка неактивного варианта B не уходит в закупку.
    const supplier = await t.prisma.supplier.create({
      data: { name: 'ООО Ткани', status: 'ACTIVE' },
      select: { id: true },
    });
    const bRow = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId, orderCalculationId: calcB },
      select: { id: true },
    });
    await t.prisma.workshopNeed.update({
      where: { id: bRow.id },
      data: {
        purchaseQty: '5',
        quotedPrice: '100',
        quotedCurrency: 'RUB',
        selectedSupplierId: supplier.id,
      },
    });
    const poBlocked = await api()
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', manager)
      .send({ workshopNeedIds: [bRow.id] })
      .expect(409);
    expect(poBlocked.body.code).toBe('PURCHASE_ORDER_NEED_INACTIVE_CALCULATION');
  });

  test('удаление варианта уносит его потребности — строки не утекают в активный', async () => {
    await seedFabricSpec('Удаление варианта');
    const orderId = await createOrder();
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);

    const calcA = (
      await t.prisma.orderCalculation.findFirstOrThrow({
        where: { orderId, isActive: true },
        select: { id: true },
      })
    ).id;
    await t.prisma.workshopNeed.updateMany({
      where: { orderId, orderCalculationId: calcA },
      data: { purchaseQty: '10', quotedPrice: '100', quotedCurrency: 'RUB' },
    });

    // Вариант B считается, но цены ему не заполняем — именно этим он и
    // выдаёт себя, если утечёт в активный контур: смета отобьётся
    // «не указана цена».
    const cloneRes = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const calcB = cloneRes.body.items[1].id as string;
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcB },
      }),
    ).toBeGreaterThan(0);

    await activate(orderId, calcA);
    await api()
      .delete(`/api/orders/${orderId}/calculations/${calcB}`)
      .set('Cookie', manager)
      .expect(200);

    // Строки ушли вместе с вариантом и не осиротели: `onDelete: SetNull`
    // оставил бы их с пустым `orderCalculationId`, а канонический скоуп
    // читает пустое значение как «показывать всем».
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcB },
      }),
    ).toBe(0);
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: null },
      }),
    ).toBe(0);

    // Смета считается только по A. До фикса строки B без цен подпадали
    // под скоуп и роняли расчёт с ORDER_CALCULATION_INCOMPLETE.
    const rowsACount = await t.prisma.workshopNeed.count({
      where: { orderId, orderCalculationId: calcA },
    });
    const est = await api()
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    expect(Number(est.body.totalCostRub)).toBe(rowsACount * 10 * 100);
  });

  test('гейты: REVIEWED других вариантов НЕ блокируют; первый расчёт при активации; accept-calculated скоуплен; статус/удаление/no-op', async () => {
    await seedFabricSpec('Гейты');
    const orderId = await createOrder();
    const cloneRes = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const calcA = cloneRes.body.items[0].id as string;
    const calcB = cloneRes.body.items[1].id as string;

    // Клон в DRAFT — потребностей ещё нет. Расчёт при активном B.
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);
    const bRows = await t.prisma.workshopNeed.count({
      where: { orderId, orderCalculationId: calcB },
    });
    expect(bRows).toBeGreaterThan(0);

    // Итерация 2: REVIEWED-строка варианта B НЕ блокирует переключение —
    // строки вариантов сосуществуют, activate ничего не пересчитывает у
    // чужих. Итерация 3: активация НЕ считает вариант — A остаётся
    // черновиком, пока менеджер явно не нажмёт «Рассчитать вариант».
    const bNeed = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId, orderCalculationId: calcB },
      select: { id: true },
    });
    await t.prisma.workshopNeed.update({
      where: { id: bNeed.id },
      data: { status: 'REVIEWED' },
    });
    await activate(orderId, calcA); // 201 — прошло, гейта больше нет
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcA },
      }),
    ).toBe(0); // активация НЕ рассчитала черновик (жалоба цеха закрыта)

    // Явная отправка варианта A на расчёт.
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .expect(201);
    const aRows = await t.prisma.workshopNeed.count({
      where: { orderId, orderCalculationId: calcA },
    });
    expect(aRows).toBeGreaterThan(0);
    // Строка B осталась REVIEWED и нетронутой.
    expect(
      (
        await t.prisma.workshopNeed.findUniqueOrThrow({
          where: { id: bNeed.id },
          select: { status: true },
        })
      ).status,
    ).toBe('REVIEWED');

    // accept-calculated («Принять теорию») скоуплен активным вариантом:
    // CALCULATED-строки варианта B не трогаются.
    await api()
      .post(`/api/orders/${orderId}/workshop-needs/accept-calculated`)
      .set('Cookie', manager)
      .expect(201);
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcA, status: 'REVIEWED' },
      }),
    ).toBe(aRows);
    expect(
      await t.prisma.workshopNeed.count({
        where: { orderId, orderCalculationId: calcB, status: 'CALCULATED' },
      }),
    ).toBe(bRows - 1); // все, кроме вручную помеченной REVIEWED

    // Статусный гейт: вне DRAFT/CALCULATION всё write-API отвечает 409.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CALCULATION_DONE' },
    });
    const lockedActivate = await activate(orderId, calcB, 409);
    expect(lockedActivate.body.code).toBe('ORDER_CALCULATION_LOCKED');
    const lockedCreate = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(409);
    expect(lockedCreate.body.code).toBe('ORDER_CALCULATION_LOCKED');
    // GET продолжает работать и honestly говорит canSwitch=false.
    const listRes = await api()
      .get(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .expect(200);
    expect(listRes.body.canSwitch).toBe(false);

    // Возвращаем DRAFT-подобное окно и проверяем остальные гейты.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CALCULATION' },
    });
    const delActive = await api()
      .delete(`/api/orders/${orderId}/calculations/${calcA}`)
      .set('Cookie', manager)
      .expect(409);
    expect(delActive.body.code).toBe('ORDER_CALCULATION_ACTIVE_DELETE_FORBIDDEN');

    // activate уже активного — no-op 201 с тем же activeId.
    const noop = await activate(orderId, calcA);
    expect(noop.body.activeId).toBe(calcA);

    // Удаление неактивного разрешено.
    const afterDelete = await api()
      .delete(`/api/orders/${orderId}/calculations/${calcB}`)
      .set('Cookie', manager)
      .expect(200);
    expect(afterDelete.body.items).toHaveLength(1);
  });
});
