/**
 * Integration-тесты «операция делается на стороне» (сторонние услуги на
 * шаге маршрута заказа).
 *
 * Решение владельца 10.09.2026: «если мы указали, что это будет делаться на
 * стороне, тогда мы не берём стоимость операций, а считаем стоимость
 * стороннего размещения». Уточнения: метка ставится и на ЧАСТЬ объёма (по
 * размерам/штукам); цена размещения — за ОДНО изделие; поведение — только
 * деньги и метка (плановое время, доска, паспорта, ЗП не меняются).
 *
 * Правило расчёта (единственный источник истины —
 * `OrderOperationPlanService.computeTotals`, зеркала в
 * `order-production-document.service.ts` и в web-таблице операций):
 *
 *   outMap = { sizeId → outsourcedQty }, только заданные значения
 *   outMap пуст при `outsourced` ⇒ на стороне ВЕСЬ тираж операции
 *   иначе                        ⇒ ровно расписанные штуки (0 — тоже
 *                                  «расписан», размеры вне карты → 0)
 *   ownQty = qtyPlan − outQty
 *   деньги = ставка_эффективного_режима × ownQty + цена × outQty
 *   ВРЕМЯ  = timeSec × qtyPlan (ПОЛНОЕ количество, метка его не трогает)
 *
 * Что ловим этими тестами (то, что легко сломать неосторожной правкой):
 *   0. Нейтральность: без метки числа-контракты плана прежние
 *      (FIXED 100₽×10 = 1000₽/1000с; BY_SIZE 900₽/1750с; SALARY_ONLY
 *      cost=0/time>0), а расшифровка размещения = 0, а не null.
 *   1. Вся операция на стороне: своя расценка НЕ берётся.
 *   2. Частичный подряд: остаток по своей расценке, штуки не задвоены;
 *      явный ноль ≠ «размеры не расписаны»; объём больше тиража обрезается.
 *   3. Метка без цены: план не падает, размещение 0, warning, заказ
 *      сохраняется; «Нет ставки операции» при полном подряде НЕ шумит.
 *   4. SALARY_ONLY и BY_SIZE живут по тому же правилу.
 *   5. Плановое ВРЕМЯ не меняется ни от полного, ни от частичного подряда.
 *   6. Метка переживает пересборку снимка маршрута (смена шаблона) и
 *      переключение вариантов просчёта, но не утекает в соседний вариант.
 *   7. Гарды правки: объём > плана размера → 400; «сделка без расценки»
 *      снят ТОЛЬКО для операции целиком на стороне; снятие метки гасит
 *      цену и объём (иначе выключенный подряд оживает при повторном
 *      включении).
 *
 * Что НЕ проверяем здесь:
 *   - исходники и UI-поверхности (smoke `order-operation-outsourced.smoke.test.ts`);
 *   - payroll/Passport/доску — метка их по контракту не касается, и это
 *     закреплено smoke-гардами «в earnings/salary/passports/packing/qc нет
 *     упоминаний outsourc*».
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — сторонние услуги на операции заказа', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;

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
  });

  function api() {
    return request(t.app.getHttpServer());
  }

  /** id шага снимка маршрута по операции (метка живёт на шаге ЗАКАЗА). */
  async function stepIdOf(orderId: string, operationId: string): Promise<string> {
    const step = await t.prisma.orderRouteStep.findFirstOrThrow({
      where: { orderId, operationId },
      select: { id: true },
    });
    return step.id;
  }

  /** Шаг снимка целиком — для проверок «что реально записано в БД». */
  async function stepOf(orderId: string, operationId: string) {
    return t.prisma.orderRouteStep.findFirstOrThrow({
      where: { orderId, operationId },
      select: {
        id: true,
        outsourced: true,
        outsourcePriceRub: true,
        sizeOverrides: {
          select: { sizeId: true, rate: true, seconds: true, outsourcedQty: true },
        },
      },
    });
  }

  /**
   * `PUT /api/orders/:id/route-overrides` — единственная ручка, которой
   * ставится метка. Возвращает `OrderDetailDto`, поэтому им же проверяем
   * контракт отдачи (не только запись в БД).
   */
  async function putOverrides(
    orderId: string,
    steps: Array<Record<string, unknown>>,
    expectStatus = 200,
  ) {
    return api()
      .put(`/api/orders/${orderId}/route-overrides`)
      .set('Cookie', manager)
      .send({ steps })
      .expect(expectStatus);
  }

  /** Снимок плана заказа в удобной для сравнения форме. */
  async function planOf(orderId: string): Promise<{
    costRub: number | null;
    outsourceRub: number | null;
    timeSec: number | null;
    warnings: string[] | null;
  }> {
    const o = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        operationCostPlanRub: true,
        operationOutsourceCostPlanRub: true,
        operationTimePlanSec: true,
        operationPlanWarnings: true,
      },
    });
    return {
      costRub:
        o.operationCostPlanRub == null ? null : Number(o.operationCostPlanRub),
      outsourceRub:
        o.operationOutsourceCostPlanRub == null
          ? null
          : Number(o.operationOutsourceCostPlanRub),
      timeSec: o.operationTimePlanSec,
      warnings: (o.operationPlanWarnings ?? null) as string[] | null,
    };
  }

  // ===========================================================================
  // 0. НЕЙТРАЛЬНОСТЬ: ветка подряда не должна двигать существующие числа
  // ===========================================================================

  test('без метки: числа-контракты плана прежние, размещение = 0 (а не null)', async () => {
    // Те же три сценария, что в `order-operation-plan.test.ts` — если
    // деление тиража на «своё/подряд» где-то посчитается даже при
    // выключенной метке, сломается именно здесь.
    const fixed = await createOperation(t, {
      code: 'OUTS-NEU-FIX',
      name: 'Нейтраль FIXED',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const bySize = await createOperation(t, {
      code: 'OUTS-NEU-BSZ',
      name: 'Нейтраль BY_SIZE',
      pricingMode: 'BY_SIZE',
      ratesBySize: [
        { sizeId: seed.sizes.M, rate: 50 },
        { sizeId: seed.sizes.L, rate: 80 },
      ],
      timeNormMode: 'BY_SIZE',
      timeNormsBySize: [
        { sizeId: seed.sizes.M, seconds: 100 },
        { sizeId: seed.sizes.L, seconds: 150 },
      ],
    });
    const salary = await createOperation(t, {
      code: 'OUTS-NEU-SAL',
      name: 'Нейтраль SALARY',
      pricingMode: 'SALARY_ONLY',
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });

    const fixedOrder = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: (await createRoute(t, {
        code: 'RT-OUTS-NEU-FIX',
        operationIds: [fixed.id],
      })).id,
    });
    const bySizeOrder = await createOrder(t, seed, manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: (await createRoute(t, {
        code: 'RT-OUTS-NEU-BSZ',
        operationIds: [bySize.id],
      })).id,
    });
    const salaryOrder = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: (await createRoute(t, {
        code: 'RT-OUTS-NEU-SAL',
        operationIds: [salary.id],
      })).id,
    });

    const fixedPlan = await planOf(fixedOrder);
    expect(fixedPlan.costRub).toBeCloseTo(1000, 2);
    expect(fixedPlan.timeSec).toBe(1000);
    expect(fixedPlan.warnings).toBeNull();

    const bySizePlan = await planOf(bySizeOrder);
    expect(bySizePlan.costRub).toBeCloseTo(900, 2); // 10×50 + 5×80
    expect(bySizePlan.timeSec).toBe(1750); // 10×100 + 5×150
    expect(bySizePlan.warnings).toBeNull();

    const salaryPlan = await planOf(salaryOrder);
    expect(salaryPlan.costRub).toBe(0);
    expect(salaryPlan.timeSec).toBe(600);
    expect(
      salaryPlan.warnings?.some((w) =>
        w.includes('Не задана плановая окладная ставка'),
      ),
    ).toBe(true);

    // Расшифровка «в том числе размещение» = 0, а НЕ null: `null` означает
    // «план не считался» (нет маршрута / нет items) и означает для UI
    // совсем другое.
    expect(fixedPlan.outsourceRub).toBe(0);
    expect(bySizePlan.outsourceRub).toBe(0);
    expect(salaryPlan.outsourceRub).toBe(0);
  });

  test('явное outsourced=false в правке ничего не меняет', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-OFF',
      name: 'Подряд выключен',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-OFF',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    await putOverrides(orderId, [
      { stepId: await stepIdOf(orderId, op.id), outsourced: false },
    ]);

    const plan = await planOf(orderId);
    expect(plan.costRub).toBeCloseTo(1000, 2);
    expect(plan.outsourceRub).toBe(0);
    expect(plan.timeSec).toBe(1000);
    expect(plan.warnings).toBeNull();
  });

  // ===========================================================================
  // 1. ВСЯ ОПЕРАЦИЯ НА СТОРОНЕ
  // ===========================================================================

  test('вся операция на стороне: своя расценка не берётся, план = цена × тираж', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-ALL',
      name: 'Пошив на стороне',
      pricingMode: 'FIXED',
      fixedRate: 100, // своя расценка ЕСТЬ и всё равно не должна попасть в план
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-ALL',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });
    expect((await planOf(orderId)).costRub).toBeCloseTo(1000, 2);

    // Метка без поразмерных объёмов = «на стороне весь тираж операции».
    const detail = await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        outsourcePriceRub: 180,
      },
    ]);

    const plan = await planOf(orderId);
    // 10 × 180 = 1800. Ни 1000 (своя расценка), ни 2800 (обе сразу).
    expect(plan.costRub).toBeCloseTo(1800, 2);
    expect(plan.outsourceRub).toBeCloseTo(1800, 2);
    expect(plan.timeSec).toBe(1000);
    expect(plan.warnings).toBeNull();

    // Контракт отдачи: полный план + расшифровка «в том числе» строкой,
    // метка и цена на шаге маршрута.
    expect(Number(detail.body.operationCostPlanRub)).toBeCloseTo(1800, 2);
    expect(Number(detail.body.operationOutsourceCostPlanRub)).toBeCloseTo(
      1800,
      2,
    );
    expect(detail.body.routeSteps[0].outsourced).toBe(true);
    expect(detail.body.routeSteps[0].outsourcePriceRub).toBe(180);

    const fromGet = await api()
      .get(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .expect(200);
    expect(Number(fromGet.body.operationOutsourceCostPlanRub)).toBeCloseTo(
      1800,
      2,
    );
  });

  // ===========================================================================
  // 2. ЧАСТИЧНЫЙ ПОДРЯД ПО РАЗМЕРАМ
  // ===========================================================================

  test('частичный подряд BY_SIZE: остаток по своей ставке, штуки не задвоены', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-PART-BSZ',
      name: 'Оверлок частично',
      pricingMode: 'BY_SIZE',
      ratesBySize: [
        { sizeId: seed.sizes.M, rate: 50 },
        { sizeId: seed.sizes.L, rate: 80 },
      ],
      timeNormMode: 'BY_SIZE',
      timeNormsBySize: [
        { sizeId: seed.sizes.M, seconds: 100 },
        { sizeId: seed.sizes.L, seconds: 150 },
      ],
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-PART-BSZ',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });
    expect((await planOf(orderId)).costRub).toBeCloseTo(900, 2);

    // Весь размер M (10 шт) отдан подрядчику по 30 ₽, L цех шьёт сам.
    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        outsourcePriceRub: 30,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 10 }],
      },
    ]);

    const plan = await planOf(orderId);
    // Своя часть: только L = 5 × 80 = 400. Размещение: 10 × 30 = 300.
    // 700, а не 1200 (900 своих + 300 размещения) — иначе штуки размера M
    // посчитаны дважды, и не 400 — иначе размещение потеряно.
    expect(plan.costRub).toBeCloseTo(700, 2);
    expect(plan.outsourceRub).toBeCloseTo(300, 2);
    expect(plan.timeSec).toBe(1750);
    expect(plan.warnings).toBeNull();
  });

  test('частичный подряд FIXED: своя ставка на остаток, цена размещения на отданное', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-PART-FIX',
      name: 'Пошив частично',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-PART-FIX',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        outsourcePriceRub: 25,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);

    const plan = await planOf(orderId);
    // 6 × 100 (своё) + 4 × 25 (размещение) = 700.
    expect(plan.costRub).toBeCloseTo(700, 2);
    expect(plan.outsourceRub).toBeCloseTo(100, 2);
    expect(plan.timeSec).toBe(1000);

    // Строка объёма живёт в поразмерных переопределениях шага и законна
    // без `rate`/`seconds` — «объём на сторону без правки расценки».
    const step = await stepOf(orderId, op.id);
    const row = step.sizeOverrides.find((o) => o.sizeId === seed.sizes.M);
    expect(row?.outsourcedQty).toBe(4);
    expect(row?.rate).toBeNull();
    expect(row?.seconds).toBeNull();
  });

  test('явный ноль по размеру ≠ «размеры не расписаны»', async () => {
    // Ключевая развилка правила: пустая карта объёмов = весь тираж на
    // стороне, а карта с нулём = «по этому размеру не отдаём ничего», и
    // размеры вне карты тоже остаются цеху. Если ноль перестанет считаться
    // «расписанным», операция целиком уедет подрядчику по цене 0.
    const op = await createOperation(t, {
      code: 'OUTS-ZERO',
      name: 'Подряд с нулём',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-ZERO',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });

    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 0 }],
      },
    ]);

    const plan = await planOf(orderId);
    expect(plan.costRub).toBeCloseTo(1500, 2); // 15 × 100, всё своё
    expect(plan.outsourceRub).toBe(0);
    expect(plan.timeSec).toBe(1500);
    // Цена размещения не задана, но отдавать нечего ⇒ и предупреждать не о чем.
    expect(plan.warnings).toBeNull();
  });

  test('объём больше плана: правка отбита 400, а движок обрезает по тиражу', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-OVER',
      name: 'Перебор объёма',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-OVER',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });
    const stepId = await stepIdOf(orderId, op.id);

    // Первый рубеж — валидация правки.
    const rejected = await putOverrides(
      orderId,
      [
        {
          stepId,
          outsourced: true,
          outsourcePriceRub: 30,
          sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 11 }],
        },
      ],
      400,
    );
    expect(rejected.body.code).toBe('ORDER_ROUTE_OUTSOURCED_QTY_OVER_PLAN');
    expect(rejected.body.message).toMatch(/план 10 шт/);

    // Второй рубеж — сам расчёт. Портим объём в обход API (так выглядят
    // данные, приехавшие до появления валидации) и пересчитываем план:
    // платить за несуществующие изделия нельзя, лишнее должно сгореть.
    await putOverrides(orderId, [
      {
        stepId,
        outsourced: true,
        outsourcePriceRub: 30,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);
    await t.prisma.orderRouteStepSizeOverride.updateMany({
      where: { orderRouteStepId: stepId, sizeId: seed.sizes.M },
      data: { outsourcedQty: 999 },
    });
    await api()
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', manager)
      .send({})
      .expect(201);

    const plan = await planOf(orderId);
    // 10 отданных штук (не 999) × 30 = 300, своей части не осталось.
    expect(plan.costRub).toBeCloseTo(300, 2);
    expect(plan.outsourceRub).toBeCloseTo(300, 2);
    expect(plan.timeSec).toBe(1000);
  });

  // ===========================================================================
  // 3. МЕТКА БЕЗ ЦЕНЫ
  // ===========================================================================

  test('метка без цены: план не падает, размещение 0, warning, заказ сохраняется', async () => {
    // Операция БЕЗ своей расценки (`fixedRate = null`) и без цены
    // размещения: обе половины денег отсутствуют, но заказ обязан
    // сохраниться и посчитаться — молчаливый отказ хуже нуля с warning-ом.
    const op = await createOperation(t, {
      code: 'OUTS-NOPRICE',
      name: 'Печать',
      pricingMode: 'FIXED',
      fixedRate: null,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-NOPRICE',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });
    const stepId = await stepIdOf(orderId, op.id);

    await putOverrides(orderId, [{ stepId, outsourced: true }]); // 200 = сохранился

    const plan = await planOf(orderId);
    expect(plan.costRub).toBe(0); // ноль, а не null: план посчитан
    expect(plan.outsourceRub).toBe(0);
    expect(plan.timeSec).toBe(1000); // время метка не трогает
    expect(plan.warnings).not.toBeNull();
    expect(
      plan.warnings?.some((w) =>
        w.includes(
          'Не задана цена стороннего размещения по операции «Печать» — размещение посчитано как 0',
        ),
      ),
    ).toBe(true);
    // Своя ставка при полном подряде не нужна — это НЕ повод шуметь в
    // `operationPlanWarnings` (их читают и цех, и ERP).
    expect(plan.warnings?.some((w) => w.includes('Нет ставки операции'))).toBe(
      false,
    );

    // Цену задали — warning уходит, план становится денежным.
    await putOverrides(orderId, [{ stepId, outsourcePriceRub: 180 }]);
    const priced = await planOf(orderId);
    expect(priced.costRub).toBeCloseTo(1800, 2);
    expect(priced.outsourceRub).toBeCloseTo(1800, 2);
    expect(priced.warnings).toBeNull();
  });

  // ===========================================================================
  // 4. SALARY_ONLY И BY_SIZE ПО ТОМУ ЖЕ ПРАВИЛУ
  // ===========================================================================

  test('SALARY_ONLY: окладные деньги считаются по остатку, отданное — по цене размещения', async () => {
    // 2880 ₽ за смену 28800 с = 0.1 ₽/с; норма 100 с ⇒ 10 ₽ за изделие.
    const op = await createOperation(t, {
      code: 'OUTS-SAL',
      name: 'ВТО на стороне',
      pricingMode: 'SALARY_ONLY',
      timeNormMode: 'FIXED',
      timeNormSec: 100,
      salaryPlanRubPerShift: 2880,
      salaryPlanShiftSeconds: 28800,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-SAL',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });
    expect((await planOf(orderId)).costRub).toBeCloseTo(100, 2); // 10 шт × 10 ₽

    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        outsourcePriceRub: 25,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);

    const plan = await planOf(orderId);
    // Своё: 6 × 10 = 60. Размещение: 4 × 25 = 100. Итого 160.
    expect(plan.costRub).toBeCloseTo(160, 2);
    expect(plan.outsourceRub).toBeCloseTo(100, 2);
    // Время окладной операции не режется: отданные штуки всё равно
    // проходят по нормам (метка — только про деньги).
    expect(plan.timeSec).toBe(1000);
  });

  test('SALARY_ONLY целиком на стороне: warning про окладную ставку не выдаётся', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-SAL-ALL',
      name: 'Упаковка на стороне',
      pricingMode: 'SALARY_ONLY',
      timeNormMode: 'FIXED',
      timeNormSec: 60,
      // Плановой окладной ставки нет — но она и не нужна: своей части не
      // осталось. Warning здесь был бы чистым шумом.
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-SAL-ALL',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        outsourcePriceRub: 12,
      },
    ]);

    const plan = await planOf(orderId);
    expect(plan.costRub).toBeCloseTo(120, 2);
    expect(plan.outsourceRub).toBeCloseTo(120, 2);
    expect(plan.timeSec).toBe(600);
    expect(plan.warnings).toBeNull();
  });

  test('BY_SIZE целиком на стороне: не жалуется на отсутствующую ставку размера', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-BSZ-ALL',
      name: 'Оверлок на стороне',
      pricingMode: 'BY_SIZE',
      ratesBySize: [{ sizeId: seed.sizes.M, rate: 50 }], // для L ставки НЕТ
      timeNormMode: 'BY_SIZE',
      timeNormsBySize: [
        { sizeId: seed.sizes.M, seconds: 100 },
        { sizeId: seed.sizes.L, seconds: 150 },
      ],
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-BSZ-ALL',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });
    // До метки отсутствие ставки на L — законный warning.
    expect(
      (await planOf(orderId)).warnings?.some((w) =>
        w.includes('Нет ставки операции'),
      ),
    ).toBe(true);

    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op.id),
        outsourced: true,
        outsourcePriceRub: 30,
      },
    ]);

    const plan = await planOf(orderId);
    expect(plan.costRub).toBeCloseTo(450, 2); // 15 шт × 30 ₽
    expect(plan.outsourceRub).toBeCloseTo(450, 2);
    expect(plan.timeSec).toBe(1750);
    expect(plan.warnings).toBeNull();
  });

  // ===========================================================================
  // 5. ПЛАНОВОЕ ВРЕМЯ — РЕШЕНИЕ ВЛАДЕЛЬЦА
  // ===========================================================================

  test('плановое время не меняется ни от полного, ни от частичного подряда', async () => {
    // Отдельный тест, потому что это решение владельца, а не следствие
    // формулы: доска, узкое место и загрузка цеха считаются по полному
    // тиражу — «пропуск» отданных штук во времени сместил бы планирование.
    const op = await createOperation(t, {
      code: 'OUTS-TIME',
      name: 'Время не режем',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-TIME',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });
    const baseline = await planOf(orderId);
    expect(baseline.timeSec).toBe(1500); // 15 × 100 с
    const stepId = await stepIdOf(orderId, op.id);

    // Частично (10 из 15 штук).
    await putOverrides(orderId, [
      {
        stepId,
        outsourced: true,
        outsourcePriceRub: 1,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 10 }],
      },
    ]);
    const partial = await planOf(orderId);
    expect(partial.timeSec).toBe(baseline.timeSec);
    expect(partial.costRub).toBeCloseTo(510, 2); // 5×100 + 10×1

    // Целиком (снимаем поразмерный объём пустым replace-all набором).
    await putOverrides(orderId, [
      { stepId, outsourced: true, outsourcePriceRub: 1, sizeOverrides: [] },
    ]);
    const whole = await planOf(orderId);
    expect(whole.timeSec).toBe(baseline.timeSec);
    expect(whole.costRub).toBeCloseTo(15, 2); // 15 × 1
  });

  // ===========================================================================
  // 6. ПЕРЕСБОРКА СНИМКА МАРШРУТА И ВАРИАНТЫ ПРОСЧЁТА
  // ===========================================================================

  test('метка переживает пересборку снимка маршрута (смена шаблона)', async () => {
    // Смена шаблона пересоздаёт `OrderRouteStep[]`, а подряда в шаблоне нет
    // и взяться ему неоткуда: без переноса per-order правок метка «делаем на
    // стороне» молча слетала бы, и план тихо возвращался к полной своей
    // стоимости.
    const op1 = await createOperation(t, {
      code: 'OUTS-SYNC-1',
      name: 'Пошив',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const op2 = await createOperation(t, {
      code: 'OUTS-SYNC-2',
      name: 'Упаковка',
      pricingMode: 'FIXED',
      fixedRate: 20,
      timeNormMode: 'FIXED',
      timeNormSec: 50,
    });
    const routeA = await createRoute(t, {
      code: 'RT-OUTS-SYNC-A',
      operationIds: [op1.id],
    });
    const routeB = await createRoute(t, {
      code: 'RT-OUTS-SYNC-B',
      operationIds: [op2.id, op1.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: routeA.id,
    });

    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op1.id),
        outsourced: true,
        outsourcePriceRub: 180,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);
    expect((await planOf(orderId)).costRub).toBeCloseTo(1320, 2); // 6×100 + 4×180

    // Переключаем шаблон: структура другая ⇒ снимок пересоздаётся.
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ routeTemplateId: routeB.id })
      .expect(200);

    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
      select: { operationId: true },
    });
    expect(steps.map((s) => s.operationId)).toEqual([op2.id, op1.id]);

    const carried = await stepOf(orderId, op1.id);
    expect(carried.outsourced).toBe(true);
    expect(Number(carried.outsourcePriceRub)).toBe(180);
    expect(
      carried.sizeOverrides.find((o) => o.sizeId === seed.sizes.M)
        ?.outsourcedQty,
    ).toBe(4);
    // Новая операция маршрута подряда не получает — метка привязана к
    // операции, а не «ко всему заказу».
    expect((await stepOf(orderId, op2.id)).outsourced).toBe(false);

    const plan = await planOf(orderId);
    // op1: 6×100 + 4×180 = 1320; op2: 10×20 = 200.
    expect(plan.costRub).toBeCloseTo(1520, 2);
    expect(plan.outsourceRub).toBeCloseTo(720, 2);
    expect(plan.timeSec).toBe(1500); // 10×100 + 10×50
  });

  test('варианты просчёта: метка едет в снимок варианта и не утекает в соседний', async () => {
    // «Шьём сами» / «шьём на стороне» — типичная пара вкладок. Метка
    // принадлежит ВАРИАНТУ: при возврате она обязана вернуться, а при
    // переключении — не приехать туда, где операцию делает цех.
    const op1 = await createOperation(t, {
      code: 'OUTS-VAR-1',
      name: 'Пошив',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const op2 = await createOperation(t, {
      code: 'OUTS-VAR-2',
      name: 'Упаковка',
      pricingMode: 'FIXED',
      fixedRate: 20,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-VAR',
      operationIds: [op1.id, op2.id],
    });
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало подряда', article: 'P-OUTS-VAR', status: 'ACTIVE' },
    });
    await seedSpec(t, manager, pattern.id, [
      { name: 'Нитки', unit: 'м', qtyPerUnit: '1' },
    ]);
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
      patternItemId: pattern.id,
    });

    // Вариант A: пошив частично на стороне (4 шт по 180 ₽).
    await putOverrides(orderId, [
      {
        stepId: await stepIdOf(orderId, op1.id),
        outsourced: true,
        outsourcePriceRub: 180,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);
    const planA = await planOf(orderId);
    expect(planA.costRub).toBeCloseTo(1520, 2); // (6×100 + 4×180) + 10×20
    expect(planA.outsourceRub).toBeCloseTo(720, 2);

    const clone = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({ title: 'Шьём сами' })
      .expect(201);
    const calcA = clone.body.items[0].id as string;
    const calcB = clone.body.items[1].id as string;

    // Вариант B: пошив свой, зато упаковку целиком отдали (5 ₽/шт).
    await putOverrides(orderId, [
      { stepId: await stepIdOf(orderId, op1.id), outsourced: false },
      {
        stepId: await stepIdOf(orderId, op2.id),
        outsourced: true,
        outsourcePriceRub: 5,
      },
    ]);
    const planB = await planOf(orderId);
    expect(planB.costRub).toBeCloseTo(1050, 2); // 10×100 + 10×5
    expect(planB.outsourceRub).toBeCloseTo(50, 2);

    // --- Возврат в A: метка и объём восстановлены, метка B погашена ------
    await api()
      .post(`/api/orders/${orderId}/calculations/${calcA}/activate`)
      .set('Cookie', manager)
      .expect(201);

    const a1 = await stepOf(orderId, op1.id);
    expect(a1.outsourced).toBe(true);
    expect(Number(a1.outsourcePriceRub)).toBe(180);
    expect(
      a1.sizeOverrides.find((o) => o.sizeId === seed.sizes.M)?.outsourcedQty,
    ).toBe(4);
    const a2 = await stepOf(orderId, op2.id);
    expect(a2.outsourced).toBe(false);
    expect(a2.outsourcePriceRub).toBeNull();
    expect(a2.sizeOverrides.filter((o) => o.outsourcedQty != null)).toHaveLength(
      0,
    );
    const restoredA = await planOf(orderId);
    expect(restoredA.costRub).toBeCloseTo(1520, 2);
    expect(restoredA.outsourceRub).toBeCloseTo(720, 2);

    // --- И обратно в B: метка A не протекла ------------------------------
    await api()
      .post(`/api/orders/${orderId}/calculations/${calcB}/activate`)
      .set('Cookie', manager)
      .expect(201);

    const b1 = await stepOf(orderId, op1.id);
    expect(b1.outsourced).toBe(false);
    expect(b1.outsourcePriceRub).toBeNull();
    expect(b1.sizeOverrides.filter((o) => o.outsourcedQty != null)).toHaveLength(
      0,
    );
    const b2 = await stepOf(orderId, op2.id);
    expect(b2.outsourced).toBe(true);
    expect(Number(b2.outsourcePriceRub)).toBe(5);
    const restoredB = await planOf(orderId);
    expect(restoredB.costRub).toBeCloseTo(1050, 2);
    expect(restoredB.outsourceRub).toBeCloseTo(50, 2);
  });

  // ===========================================================================
  // 7. ГАРДЫ ПРАВКИ
  // ===========================================================================

  test('снятие метки гасит цену и объём — выключенный подряд не оживает', async () => {
    const op = await createOperation(t, {
      code: 'OUTS-CLEAR',
      name: 'Пошив',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-CLEAR',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });
    const stepId = await stepIdOf(orderId, op.id);

    await putOverrides(orderId, [
      {
        stepId,
        outsourced: true,
        outsourcePriceRub: 180,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 10 }],
      },
    ]);
    expect((await planOf(orderId)).costRub).toBeCloseTo(2300, 2); // 5×100 + 10×180

    // Снимаем метку, поразмерный набор НЕ присылаем — объём обязан
    // погаснуть сам.
    await putOverrides(orderId, [{ stepId, outsourced: false }]);
    const cleared = await stepOf(orderId, op.id);
    expect(cleared.outsourced).toBe(false);
    expect(cleared.outsourcePriceRub).toBeNull();
    expect(
      cleared.sizeOverrides.filter((o) => o.outsourcedQty != null),
    ).toHaveLength(0);
    const off = await planOf(orderId);
    expect(off.costRub).toBeCloseTo(1500, 2);
    expect(off.outsourceRub).toBe(0);

    // Повторное включение метки с другой ценой: прошлые 10 штук не должны
    // воскреснуть — пустая карта объёмов = весь тираж на стороне.
    await putOverrides(orderId, [
      { stepId, outsourced: true, outsourcePriceRub: 5 },
    ]);
    const again = await planOf(orderId);
    expect(again.costRub).toBeCloseTo(75, 2); // 15 × 5, а не 5×100 + 10×5
    expect(again.outsourceRub).toBeCloseTo(75, 2);
  });

  test('уменьшили тираж — устаревший объём обрезается по плану, форма не заперта', async () => {
    // Менеджер расписал подряд, а потом урезал тираж размера. Форма правки
    // маршрута присылает поразмерный набор ЦЕЛИКОМ (replace-all), то есть
    // возвращает и прежний объём. Жёсткий 400 на него запер бы всю форму —
    // нельзя было бы поправить даже расценку соседней операции, а причина
    // («уменьшили тираж на прошлой неделе») в сообщении не видна.
    const op = await createOperation(t, {
      code: 'OUTS-STALE-QTY',
      name: 'Пошив',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-STALE-QTY',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });
    const stepId = await stepIdOf(orderId, op.id);

    await putOverrides(orderId, [
      {
        stepId,
        outsourced: true,
        outsourcePriceRub: 30,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);

    // Тираж урезали до 3 — объём подряда (4) стал больше плана.
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }] })
      .expect(200);

    // Форма присылает прежние 4 — сохраняется, объём обрезается по плану.
    await putOverrides(orderId, [
      {
        stepId,
        outsourced: true,
        outsourcePriceRub: 30,
        sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 4 }],
      },
    ]);
    const step = await stepOf(orderId, op.id);
    expect(
      step.sizeOverrides.find((o) => o.sizeId === seed.sizes.M)?.outsourcedQty,
    ).toBe(3);
    const plan = await planOf(orderId);
    expect(plan.costRub).toBeCloseTo(90, 2); // 3 × 30, своей части не осталось
    expect(plan.outsourceRub).toBeCloseTo(90, 2);

    // А вот НОВОЕ значение сверх плана — по-прежнему опечатка и 400.
    const rejected = await putOverrides(
      orderId,
      [
        {
          stepId,
          outsourced: true,
          outsourcePriceRub: 30,
          sizeOverrides: [{ sizeId: seed.sizes.M, outsourcedQty: 9 }],
        },
      ],
      400,
    );
    expect(rejected.body.code).toBe('ORDER_ROUTE_OUTSOURCED_QTY_OVER_PLAN');
  });

  test('гард «сделка без расценки» держится и на операции, целиком отданной на сторону', async () => {
    // ⛔ Соблазн «на стороне — своя расценка не нужна» ломает цех: метка
    // меняет только ДЕНЬГИ ПЛАНА, шаг из маршрута не исчезает, паспорт
    // по-прежнему идёт через него, и приёмщик закрывает операцию сканом,
    // когда партия вернулась от подрядчика. Сдельная операция без
    // расценки роняет этот скан (`OperationRateMissingException`).
    const op = await createOperation(t, {
      code: 'OUTS-RATE-GUARD',
      name: 'Вышивка',
      pricingMode: 'SALARY_ONLY',
      fixedRate: null,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-OUTS-RATE-GUARD',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });
    const stepId = await stepIdOf(orderId, op.id);

    // Целиком на стороне, но перевод на сделку без расценки — всё равно 400.
    const rejected = await putOverrides(
      orderId,
      [
        {
          stepId,
          pricingModeOverride: 'FIXED',
          outsourced: true,
          outsourcePriceRub: 40,
        },
      ],
      400,
    );
    expect(rejected.body.code).toBe('ORDER_ROUTE_OVERRIDE_RATE_REQUIRED');
    expect(rejected.body.message).toMatch(/задайте расценку/);

    // С расценкой — сохраняется, и в плане стоит цена размещения, а не она.
    await putOverrides(orderId, [
      {
        stepId,
        pricingModeOverride: 'FIXED',
        rateOverride: 25,
        outsourced: true,
        outsourcePriceRub: 40,
      },
    ]);
    const plan = await planOf(orderId);
    expect(plan.costRub).toBeCloseTo(400, 2); // 10 × 40 (не 10 × 25)
    expect(plan.outsourceRub).toBeCloseTo(400, 2);
  });
});

// ===========================================================================
// helpers (те же, что в `order-operation-plan.test.ts`, плюс окладные поля)
// ===========================================================================

async function createOperation(
  t: TestApp,
  options: {
    code: string;
    name: string;
    pricingMode: 'FIXED' | 'BY_SIZE' | 'SALARY_ONLY';
    fixedRate?: number | null;
    ratesBySize?: Array<{ sizeId: string; rate: number }>;
    timeNormMode: 'FIXED' | 'BY_SIZE';
    timeNormSec?: number | null;
    timeNormsBySize?: Array<{ sizeId: string; seconds: number }>;
    /** Плановая окладная ставка за смену — только для SALARY_ONLY. */
    salaryPlanRubPerShift?: number | null;
    salaryPlanShiftSeconds?: number | null;
  },
): Promise<{ id: string }> {
  // Через Prisma, а не через CRUD-API: тестируем расчёт плана, а не
  // валидаторы справочника операций.
  const op = await t.prisma.operation.create({
    data: {
      code: options.code,
      name: options.name,
      category: 'SEWING',
      sortOrder: 1000 + Math.floor(Math.random() * 100000),
      active: true,
      pricingMode: options.pricingMode,
      fixedRate:
        options.pricingMode === 'FIXED' && options.fixedRate != null
          ? new Prisma.Decimal(options.fixedRate)
          : null,
      timeNormMode: options.timeNormMode,
      timeNormSec:
        options.timeNormMode === 'FIXED' && options.timeNormSec != null
          ? options.timeNormSec
          : null,
      salaryPlanRubPerShift:
        options.salaryPlanRubPerShift != null
          ? new Prisma.Decimal(options.salaryPlanRubPerShift)
          : null,
      salaryPlanShiftSeconds: options.salaryPlanShiftSeconds ?? undefined,
    },
  });
  if (options.pricingMode === 'BY_SIZE' && options.ratesBySize?.length) {
    await t.prisma.operationRateBySize.createMany({
      data: options.ratesBySize.map((r) => ({
        operationId: op.id,
        sizeId: r.sizeId,
        rate: new Prisma.Decimal(r.rate),
      })),
    });
  }
  if (options.timeNormMode === 'BY_SIZE' && options.timeNormsBySize?.length) {
    await t.prisma.operationTimeNormBySize.createMany({
      data: options.timeNormsBySize.map((tn) => ({
        operationId: op.id,
        sizeId: tn.sizeId,
        seconds: tn.seconds,
      })),
    });
  }
  return { id: op.id };
}

async function createRoute(
  t: TestApp,
  options: { code: string; operationIds: string[] },
): Promise<{ id: string }> {
  const r = await t.prisma.routeTemplate.create({
    data: {
      code: options.code,
      name: `Route ${options.code}`,
      isActive: true,
      steps: {
        create: options.operationIds.map((operationId, index) => ({
          index,
          operationId,
          isOptional: false,
        })),
      },
    },
  });
  return { id: r.id };
}

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  options: {
    items: Array<{ sizeId: string; qtyPlan: number }>;
    routeTemplateId?: string | null;
    patternItemId?: string | null;
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-09-10T00:00:00.000Z',
      clientId: seed.client.id,
      productId: seed.product.id,
      items: options.items,
      routeTemplateId: options.routeTemplateId ?? undefined,
      patternItemId: options.patternItemId ?? undefined,
    })
    .expect(201);
  return r.body.id as string;
}

/** Спецификация материалов лекала — нужна заказу, который уходит в вариант. */
async function seedSpec(
  t: TestApp,
  cookie: string,
  patternItemId: string,
  materialLines: Array<{ name: string; unit: string; qtyPerUnit: string }>,
): Promise<void> {
  await request(t.app.getHttpServer())
    .put(`/api/patterns/${patternItemId}/material-spec`)
    .set('Cookie', cookie)
    .send({ materialLines, parameters: [] })
    .expect(200);
}
