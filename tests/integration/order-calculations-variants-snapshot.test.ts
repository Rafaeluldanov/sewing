/**
 * Integration-тесты: снимок варианта просчёта и смета неактивного варианта
 * (Аудит движка расчёта 13.09.2026, группа «A7_variants_snapshot»:
 * V1-2, V1-4, V1-3, V1-5, E1-2/V1-1). Ассерты закрепляют ПРАВИЛЬНОЕ
 * поведение; пробы, воспроизводившие баги, — `tests/scratch/calc_D/*`,
 * `tests/scratch/calc_B/E1-2_V1-1.test.ts`.
 *
 * Покрытие:
 *   V1-2 — состав шагов и `Order.routeCustomizedAt` едут в снимок: холст
 *          одного варианта не протекает в другой, правка холста не
 *          теряется при смене шаблона в соседнем варианте;
 *   V1-4 — повтор операции (ОТК до и после): оверрайды и метка подряда
 *          восстанавливаются по вхождению, а не по одному `operationId`;
 *   V1-3 — заказ без расцветок (inline «Сделать расчёт»): тираж
 *          (`OrderItem`) едет в снимок и восстанавливается;
 *   V1-5 — отказ фазы D (FIXED без расценки при снятом `fixedRate`)
 *          отбивается ДО мутаций; незавершённое переключение
 *          долечивается повторным activate, а не no-op;
 *   E1-2/V1-1 — смета НЕактивного варианта догоняет правку строки и
 *          order-level логистики; при активации смета сверяется с
 *          входами и расхождение становится `costEstimateStaleAt`.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — варианты просчёта: снимок маршрута/тиража и смета неактивного', () => {
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

  const api = () => request(t.app.getHttpServer());

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function createOperation(options: {
    code: string;
    name: string;
    fixedRate: number | null;
  }): Promise<{ id: string }> {
    const op = await t.prisma.operation.create({
      data: {
        code: options.code,
        name: options.name,
        category: 'SEWING',
        sortOrder: 1000 + Math.floor(Math.random() * 100000),
        active: true,
        pricingMode: 'FIXED',
        fixedRate:
          options.fixedRate == null ? null : new Prisma.Decimal(options.fixedRate),
        timeNormMode: 'FIXED',
        timeNormSec: 60,
      },
    });
    return { id: op.id };
  }

  async function createTemplate(
    code: string,
    operationIds: string[],
  ): Promise<string> {
    const r = await t.prisma.routeTemplate.create({
      data: {
        code,
        name: `Route ${code}`,
        isActive: true,
        steps: {
          create: operationIds.map((operationId, index) => ({
            index,
            operationId,
            isOptional: false,
          })),
        },
      },
    });
    return r.id;
  }

  /** Заказ с лекалом и двумя расцветками (Белый 60 / Чёрный 40, размер M) = 100 шт. */
  async function createPatternOrder(routeTemplateId?: string): Promise<string> {
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Худи снимок',
        article: `ART-VS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'ACTIVE',
      },
    });
    await api()
      .put(`/api/patterns/${pattern.id}/material-spec`)
      .set('Cookie', manager)
      .send({
        materialLines: [
          {
            name: 'Полотно снимок',
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
    const res = await api()
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-16T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId: pattern.id,
        routeTemplateId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  async function planOf(orderId: string) {
    const o = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        operationCostPlanRub: true,
        operationOutsourceCostPlanRub: true,
        routeCustomizedAt: true,
        routeTemplateId: true,
      },
    });
    return {
      costRub: o.operationCostPlanRub == null ? null : Number(o.operationCostPlanRub),
      outsourceRub:
        o.operationOutsourceCostPlanRub == null
          ? null
          : Number(o.operationOutsourceCostPlanRub),
      routeCustomizedAt: o.routeCustomizedAt,
      routeTemplateId: o.routeTemplateId,
    };
  }

  async function stepsOf(orderId: string) {
    const rows = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
      select: {
        id: true,
        index: true,
        operationId: true,
        rateOverride: true,
        pricingModeOverride: true,
        outsourced: true,
        outsourcePriceRub: true,
        operation: { select: { code: true } },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      index: s.index,
      operationId: s.operationId,
      code: s.operation.code,
      rateOverride: s.rateOverride == null ? null : Number(s.rateOverride),
      pricingModeOverride: s.pricingModeOverride,
      outsourced: s.outsourced,
      outsourcePriceRub:
        s.outsourcePriceRub == null ? null : Number(s.outsourcePriceRub),
    }));
  }

  /** «+ Вариант просчёта»: [idПрежнего(A), idНового(B)]. */
  async function cloneCalc(orderId: string): Promise<{ calcA: string; calcB: string }> {
    const res = await api()
      .post(`/api/orders/${orderId}/calculations`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const a = res.body.items.find((x: { isActive: boolean }) => !x.isActive);
    const b = res.body.items.find((x: { isActive: boolean }) => x.isActive);
    expect(a && b).toBeTruthy();
    return { calcA: a.id as string, calcB: b.id as string };
  }

  function activate(orderId: string, calcId: string, expectStatus = 201) {
    return api()
      .post(`/api/orders/${orderId}/calculations/${calcId}/activate`)
      .set('Cookie', manager)
      .expect(expectStatus);
  }

  function putOverrides(orderId: string, steps: Array<Record<string, unknown>>) {
    return api()
      .put(`/api/orders/${orderId}/route-overrides`)
      .set('Cookie', manager)
      .send({ steps })
      .expect(200);
  }

  async function applyRoute(orderId: string, operationIds: string[]): Promise<void> {
    const r = await api()
      .put(`/api/orders/${orderId}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: operationIds.map((operationId) => ({ operationId })),
        reason: 'регрессионный тест аудита',
      })
      .expect(200);
    expect(r.body.applied).toBe(true);
  }

  async function snapshotOf(calcId: string) {
    return (await t.prisma.orderCalculation.findUniqueOrThrow({ where: { id: calcId } }))
      .snapshot as {
      order: Record<string, unknown>;
      routeSteps?: Array<{ index: number; operationId: string }>;
      routeOverrides: Array<{
        operationId: string;
        index?: number | null;
        rateOverride: string | null;
        pricingModeOverride: string | null;
        outsourced?: boolean;
      }>;
      items?: Array<{ sizeId: string; qtyPlan: number }>;
    } | null;
  }

  // -------------------------------------------------------------------------
  // V1-2
  // -------------------------------------------------------------------------

  test('V1-2: маршрут, правленный холстом в B, не протекает в A и возвращается в B', async () => {
    const X = await createOperation({ code: 'VS-12-X', name: 'Крой', fixedRate: 10 });
    const Y = await createOperation({ code: 'VS-12-Y', name: 'Пошив', fixedRate: 20 });
    const Z = await createOperation({ code: 'VS-12-Z', name: 'ОТК', fixedRate: 30 });
    const W = await createOperation({ code: 'VS-12-W', name: 'Вышивка', fixedRate: 50 });
    const T = await createTemplate('RT-VS-12', [X.id, Y.id, Z.id]);
    const orderId = await createPatternOrder(T); // 100 шт
    expect((await planOf(orderId)).costRub).toBe(6000); // 100 × (10+20+30)

    const { calcA, calcB } = await cloneCalc(orderId);
    // В B правим маршрут холстом: + Вышивка.
    await applyRoute(orderId, [X.id, Y.id, Z.id, W.id]);
    expect((await planOf(orderId)).costRub).toBe(11000);

    // Переключение на A: маршрут A — из шаблона, без холста B.
    await activate(orderId, calcA);
    const planA = await planOf(orderId);
    expect(planA.routeTemplateId).toBe(T);
    expect(planA.routeCustomizedAt).toBeNull();
    expect((await stepsOf(orderId)).map((s) => s.code)).toEqual(['VS-12-X', 'VS-12-Y', 'VS-12-Z']);
    expect(planA.costRub).toBe(6000);

    // Снимок B несёт флаг холста и полный состав шагов.
    const snapB = await snapshotOf(calcB);
    expect(snapB?.order.routeCustomizedAt).toEqual(expect.any(String));
    expect(snapB?.routeSteps?.map((s) => s.operationId)).toEqual([X.id, Y.id, Z.id, W.id]);

    // И обратно на B: холст восстановлен.
    await activate(orderId, calcB);
    const planB = await planOf(orderId);
    expect(planB.routeCustomizedAt).not.toBeNull();
    expect((await stepsOf(orderId)).map((s) => s.code)).toEqual([
      'VS-12-X',
      'VS-12-Y',
      'VS-12-Z',
      'VS-12-W',
    ]);
    expect(planB.costRub).toBe(11000);
  });

  test('V1-2: холст в A переживает смену шаблона в B', async () => {
    const X = await createOperation({ code: 'VS-12b-X', name: 'Крой', fixedRate: 10 });
    const Y = await createOperation({ code: 'VS-12b-Y', name: 'Пошив', fixedRate: 20 });
    const Z = await createOperation({ code: 'VS-12b-Z', name: 'ОТК', fixedRate: 30 });
    const W = await createOperation({ code: 'VS-12b-W', name: 'Вышивка', fixedRate: 50 });
    const T = await createTemplate('RT-VS-12b', [X.id, Y.id, Z.id]);
    const T2 = await createTemplate('RT-VS-12b-2', [X.id, Y.id, W.id]);
    const orderId = await createPatternOrder(T);

    // В A убираем ОТК холстом → 3 000.
    await applyRoute(orderId, [X.id, Y.id]);
    expect((await planOf(orderId)).costRub).toBe(3000);

    const { calcA, calcB } = await cloneCalc(orderId);
    // В B выбираем другой шаблон → routeCustomizedAt := null, маршрут из T2.
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ routeTemplateId: T2 })
      .expect(200);
    const planB0 = await planOf(orderId);
    expect(planB0.routeCustomizedAt).toBeNull();
    expect(planB0.costRub).toBe(8000); // 100 × (10+20+50)

    // Возврат на A: правка холста (без ОТК) на месте.
    await activate(orderId, calcA);
    const planA = await planOf(orderId);
    expect(planA.routeTemplateId).toBe(T);
    expect(planA.routeCustomizedAt).not.toBeNull();
    expect((await stepsOf(orderId)).map((s) => s.code)).toEqual(['VS-12b-X', 'VS-12b-Y']);
    expect(planA.costRub).toBe(3000);

    // Снова B: шаблон T2 без холста.
    await activate(orderId, calcB);
    const planB1 = await planOf(orderId);
    expect(planB1.routeTemplateId).toBe(T2);
    expect(planB1.routeCustomizedAt).toBeNull();
    expect((await stepsOf(orderId)).map((s) => s.code)).toEqual([
      'VS-12b-X',
      'VS-12b-Y',
      'VS-12b-W',
    ]);
    expect(planB1.costRub).toBe(8000);
  });

  // -------------------------------------------------------------------------
  // V1-4
  // -------------------------------------------------------------------------

  async function routeWithDoubleQc(prefix: string) {
    const X = await createOperation({ code: `${prefix}-X`, name: 'Крой', fixedRate: 10 });
    const Q = await createOperation({ code: `${prefix}-Q`, name: 'ОТК', fixedRate: 3 });
    const Y = await createOperation({ code: `${prefix}-Y`, name: 'Пошив', fixedRate: 20 });
    const T = await createTemplate(`RT-${prefix}`, [X.id, Q.id]);
    const orderId = await createPatternOrder(T); // 100 шт
    // Холст: Крой, ОТК, Пошив, ОТК — повтор операции вне параллельной группы.
    await applyRoute(orderId, [X.id, Q.id, Y.id, Q.id]);
    const steps = await stepsOf(orderId);
    expect(steps.map((s) => s.code)).toEqual([`${prefix}-X`, `${prefix}-Q`, `${prefix}-Y`, `${prefix}-Q`]);
    return { orderId, q1: steps[1], q2: steps[3] };
  }

  test('V1-4: расценки двух вхождений ОТК восстанавливаются каждая на своё вхождение', async () => {
    const { orderId, q1, q2 } = await routeWithDoubleQc('VS-14a');
    await putOverrides(orderId, [
      { stepId: q1.id, rateOverride: 5 },
      { stepId: q2.id, rateOverride: 8 },
    ]);
    expect((await planOf(orderId)).costRub).toBe(4300); // 1000 + 500 + 2000 + 800

    const { calcA, calcB } = await cloneCalc(orderId);
    const snapA = await snapshotOf(calcA);
    expect(snapA?.routeOverrides).toHaveLength(2);
    expect(snapA?.routeOverrides.map((o) => o.index)).toEqual([1, 3]);

    // Туда-обратно: B → A.
    await activate(orderId, calcA);
    const after = await stepsOf(orderId);
    expect(after[1].rateOverride).toBe(5);
    expect(after[3].rateOverride).toBe(8);
    expect((await planOf(orderId)).costRub).toBe(4300);

    // И снова B (клон без изменений — те же цифры).
    await activate(orderId, calcB);
    const afterB = await stepsOf(orderId);
    expect(afterB[1].rateOverride).toBe(5);
    expect(afterB[3].rateOverride).toBe(8);
    expect((await planOf(orderId)).costRub).toBe(4300);
  });

  test('V1-4: метка «на стороне» первого ОТК и своя ставка второго переживают переключение', async () => {
    const { orderId, q1, q2 } = await routeWithDoubleQc('VS-14b');
    await putOverrides(orderId, [
      { stepId: q1.id, rateOverride: 5, outsourced: true, outsourcePriceRub: 30 },
      { stepId: q2.id, rateOverride: 8 },
    ]);
    const plan0 = await planOf(orderId);
    expect(plan0.costRub).toBe(6800); // 1000 + 3000 (100×30) + 2000 + 800
    expect(plan0.outsourceRub).toBe(3000);

    const { calcA } = await cloneCalc(orderId);
    await activate(orderId, calcA);
    const after = await stepsOf(orderId);
    expect(after[1]).toMatchObject({ rateOverride: 5, outsourced: true, outsourcePriceRub: 30 });
    expect(after[3]).toMatchObject({ rateOverride: 8, outsourced: false, outsourcePriceRub: null });
    const plan = await planOf(orderId);
    expect(plan.costRub).toBe(6800);
    expect(plan.outsourceRub).toBe(3000);
  });

  // -------------------------------------------------------------------------
  // V1-3
  // -------------------------------------------------------------------------

  test('V1-3: inline-заказ без расцветок — тираж варианта едет в снимок и восстанавливается', async () => {
    const res = await api()
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-16T00:00:00.000Z',
        clientId: seed.client.id,
        customer: 'Клиент-инлайн',
        productMode: 'CREATE_FOR_CALCULATION',
        newProductCalculation: { sizes: [{ sizeId: seed.sizes.M, qtyPlan: 100 }] },
        items: [],
      })
      .expect(201);
    const orderId = res.body.id as string;
    expect(await t.prisma.orderVariant.count({ where: { orderId } })).toBe(0);

    const { calcA, calcB } = await cloneCalc(orderId);
    expect((await snapshotOf(calcA))?.items).toEqual([{ sizeId: seed.sizes.M, qtyPlan: 100 }]);

    // В варианте B (DRAFT) правим тираж: 150.
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 150 }] })
      .expect(200);
    expect((await t.prisma.orderItem.findMany({ where: { orderId } })).map((i) => i.qtyPlan)).toEqual([150]);

    // Переключение на A: тираж A = 100.
    await activate(orderId, calcA);
    expect((await t.prisma.orderItem.findMany({ where: { orderId } })).map((i) => i.qtyPlan)).toEqual([100]);
    const detailA = await api().get(`/api/orders/${orderId}`).set('Cookie', manager).expect(200);
    expect(detailA.body.qtyPlanTotal).toBe(100);
    expect((await snapshotOf(calcB))?.items).toEqual([{ sizeId: seed.sizes.M, qtyPlan: 150 }]);

    // И обратно: B снова 150.
    await activate(orderId, calcB);
    expect((await t.prisma.orderItem.findMany({ where: { orderId } })).map((i) => i.qtyPlan)).toEqual([150]);
    const detailB = await api().get(`/api/orders/${orderId}`).set('Cookie', manager).expect(200);
    expect(detailB.body.qtyPlanTotal).toBe(150);
  });

  // -------------------------------------------------------------------------
  // V1-5
  // -------------------------------------------------------------------------

  test('V1-5: FIXED без расценки при снятом fixedRate отбивается до мутаций; незавершённое переключение долечивается', async () => {
    const P = await createOperation({ code: 'VS-15-P', name: 'Пошив', fixedRate: 40 });
    const T = await createTemplate('RT-VS-15', [P.id]);
    const orderId = await createPatternOrder(T); // 100 шт
    const [step] = await stepsOf(orderId);

    // A: явный FIXED без своей расценки — гард пропускает (есть Operation.fixedRate).
    await putOverrides(orderId, [{ stepId: step.id, pricingModeOverride: 'FIXED', rateOverride: null }]);
    expect((await planOf(orderId)).costRub).toBe(4000);

    const { calcA, calcB } = await cloneCalc(orderId);
    // B: своя расценка 55.
    await putOverrides(orderId, [{ stepId: step.id, rateOverride: 55 }]);
    expect((await planOf(orderId)).costRub).toBe(5500);

    // Пока активен B, у операции сняли расценку справочника.
    await t.prisma.operation.update({ where: { id: P.id }, data: { fixedRate: null } });

    // Переключение B→A: честный отказ ДО мутаций.
    const failed = await activate(orderId, calcA, 400);
    expect(failed.body.code).toBe('ORDER_ROUTE_OVERRIDE_RATE_REQUIRED');
    const calcs = await t.prisma.orderCalculation.findMany({
      where: { orderId },
      select: { id: true, isActive: true, snapshot: true },
    });
    expect(calcs.find((c) => c.id === calcB)!.isActive).toBe(true);
    expect(calcs.find((c) => c.id === calcB)!.snapshot).toBeNull();
    expect(calcs.find((c) => c.id === calcA)!.isActive).toBe(false);
    const [stepAfter] = await stepsOf(orderId);
    expect(stepAfter.rateOverride).toBe(55);
    expect((await planOf(orderId)).costRub).toBe(5500);
    // Снимок A не тронут: по-прежнему FIXED без своей расценки.
    const snapA = await snapshotOf(calcA);
    expect(snapA?.routeOverrides[0]).toMatchObject({ rateOverride: null, pricingModeOverride: 'FIXED' });

    // Вернули расценку справочника → переключение проходит с расценкой A.
    await t.prisma.operation.update({ where: { id: P.id }, data: { fixedRate: new Prisma.Decimal(40) } });
    await activate(orderId, calcA, 201);
    const [stepA] = await stepsOf(orderId);
    expect(stepA.rateOverride).toBeNull();
    expect(stepA.pricingModeOverride).toBe('FIXED');
    expect((await planOf(orderId)).costRub).toBe(4000);
    // Переключение завершено — снимок у активного варианта снят.
    expect((await snapshotOf(calcA))).toBeNull();

    // Незавершённое переключение (фазы A+B закоммичены, C–D нет): активный
    // вариант со снимком и с утёкшей расценкой прошлого варианта.
    // Повторный activate — не no-op, а долечивание из снимка.
    await t.prisma.orderCalculation.update({
      where: { id: calcA },
      data: { snapshot: snapA as unknown as Prisma.InputJsonValue },
    });
    await t.prisma.orderRouteStep.update({
      where: { id: stepA.id },
      data: { rateOverride: new Prisma.Decimal(55) },
    });
    const healed = await activate(orderId, calcA, 201);
    expect(healed.body.activeId).toBe(calcA);
    const [stepHealed] = await stepsOf(orderId);
    expect(stepHealed.rateOverride).toBeNull();
    expect((await planOf(orderId)).costRub).toBe(4000);
    expect(await snapshotOf(calcA)).toBeNull();

    // Штатный повторный activate активного — по-прежнему no-op.
    const noop = await activate(orderId, calcA, 201);
    expect(noop.body.activeId).toBe(calcA);
  });

  // -------------------------------------------------------------------------
  // E1-2 / V1-1
  // -------------------------------------------------------------------------

  async function money(orderId: string) {
    const o = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        status: true,
        costEstimateTotalRub: true,
        costEstimateStaleAt: true,
        costEstimateStaleReason: true,
      },
    });
    return {
      status: o.status,
      total: o.costEstimateTotalRub == null ? null : Number(o.costEstimateTotalRub),
      stale: o.costEstimateStaleAt != null,
      reason: o.costEstimateStaleReason,
    };
  }

  async function completedEstimateTotal(orderId: string, calcId: string): Promise<number | null> {
    const e = await t.prisma.orderCostEstimate.findFirst({
      where: { orderId, orderCalculationId: calcId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
    });
    return e ? Number(e.totalCostRub) : null;
  }

  async function tabTotal(orderId: string, calcId: string): Promise<number | null> {
    const tabs = await api().get(`/api/orders/${orderId}/calculations`).set('Cookie', manager).expect(200);
    const tab = (tabs.body.items as Array<{ id: string; costTotalRub: string | null }>).find((i) => i.id === calcId)!;
    return tab.costTotalRub == null ? null : Number(tab.costTotalRub);
  }

  /** Два рассчитанных варианта: A (Белый 60 / Чёрный 40, ×10×100 ₽) активен, B (Синий 150, ×10×200 ₽) неактивен. */
  async function twoCompletedVariants() {
    const orderId = await createPatternOrder();
    await api().post(`/api/orders/${orderId}/start-calculation`).set('Cookie', manager).expect(201);
    const calcA = (await t.prisma.orderCalculation.findFirstOrThrow({ where: { orderId, isActive: true } })).id;
    const rowsA = await t.prisma.workshopNeed.count({ where: { orderId, orderCalculationId: calcA } });
    expect(rowsA).toBeGreaterThan(0);
    await t.prisma.workshopNeed.updateMany({
      where: { orderId, orderCalculationId: calcA },
      data: { purchaseQty: '10', quotedPrice: '100', quotedCurrency: 'RUB' },
    });
    await api().post(`/api/orders/${orderId}/complete-calculation`).set('Cookie', manager).send({}).expect(201);
    const totalA = rowsA * 10 * 100;

    const { calcB } = await cloneCalc(orderId);
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ variants: [{ color: 'Синий', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 150 }] }] })
      .expect(200);
    await api().post(`/api/orders/${orderId}/start-calculation`).set('Cookie', manager).expect(201);
    const needsB = await t.prisma.workshopNeed.findMany({ where: { orderId, orderCalculationId: calcB } });
    expect(needsB.length).toBeGreaterThan(0);
    await t.prisma.workshopNeed.updateMany({
      where: { orderId, orderCalculationId: calcB },
      data: { purchaseQty: '10', quotedPrice: '200', quotedCurrency: 'RUB' },
    });
    await api().post(`/api/orders/${orderId}/complete-calculation`).set('Cookie', manager).send({}).expect(201);
    const totalB = needsB.length * 10 * 200;

    await activate(orderId, calcA);
    expect((await money(orderId)).total).toBe(totalA);
    return { orderId, calcA, calcB, totalA, totalB, needsB };
  }

  test('E1-2/V1-1: смета неактивного варианта догоняет логистику и правку своей строки; активация показывает свежую сумму', async () => {
    const { orderId, calcA, calcB, totalA, totalB, needsB } = await twoCompletedVariants();

    // (V1-1) Order-level расход: логистика 5 000 ₽ входит в смету КАЖДОГО варианта.
    await api()
      .post(`/api/orders/${orderId}/logistics-lines`)
      .set('Cookie', manager)
      .send({ name: 'Доставка', costRub: '5000' })
      .expect(201);
    const afterLogistics = await money(orderId);
    expect(afterLogistics.total).toBe(totalA + 5000);
    expect(afterLogistics.stale).toBe(false);
    expect(await completedEstimateTotal(orderId, calcB)).toBe(totalB + 5000);
    expect(await tabTotal(orderId, calcB)).toBe(totalB + 5000);
    // Одна COMPLETED-смета на вариант — прежняя отозвана.
    expect(
      await t.prisma.orderCostEstimate.count({ where: { orderId, orderCalculationId: calcB, status: 'COMPLETED' } }),
    ).toBe(1);

    // (E1-2) Закупщик правит цену строки НЕАКТИВНОГО B: 200 → 250.
    const bNeed = needsB[0]!;
    await api().patch(`/api/workshop-needs/${bNeed.id}`).set('Cookie', manager).send({ quotedPrice: '250' }).expect(200);
    const expectedB = totalB - 2000 + 2500 + 5000;
    const afterBEdit = await money(orderId);
    expect(afterBEdit.total).toBe(totalA + 5000); // A не тронут
    expect(afterBEdit.stale).toBe(false);
    expect(await completedEstimateTotal(orderId, calcB)).toBe(expectedB);
    expect(await tabTotal(orderId, calcB)).toBe(expectedB);

    // Правка без денег (комментарий) версию сметы B не плодит.
    const versionsBefore = await t.prisma.orderCostEstimate.count({ where: { orderId, orderCalculationId: calcB } });
    await api().patch(`/api/workshop-needs/${bNeed.id}`).set('Cookie', manager).send({ comment: 'x' }).expect(200);
    expect(await t.prisma.orderCostEstimate.count({ where: { orderId, orderCalculationId: calcB } })).toBe(versionsBefore);

    // Активация B: заказ показывает свежую смету B, отметки «устарела» нет.
    await activate(orderId, calcB);
    const afterActivateB = await money(orderId);
    expect(afterActivateB.status).toBe('CALCULATION_DONE');
    expect(afterActivateB.total).toBe(expectedB);
    expect(afterActivateB.stale).toBe(false);
    const detail = await api().get(`/api/orders/${orderId}`).set('Cookie', manager).expect(200);
    expect(Number(detail.body.currentCostEstimate.totalCostRub)).toBe(expectedB);

    // Обратно на A: его смета тоже свежая (логистика вошла ещё при активном A).
    await activate(orderId, calcA);
    const afterActivateA = await money(orderId);
    expect(afterActivateA.total).toBe(totalA + 5000);
    expect(afterActivateA.stale).toBe(false);
  });

  test('E1-2/V1-1: если смету неактивного варианта пересобрать нельзя, активация ставит отметку «устарела» с причиной', async () => {
    const { orderId, calcB, totalB, needsB } = await twoCompletedVariants();

    // Закупщик снял цену со строки B: план B не собирается («Не указана цена»),
    // смета B остаётся прежней и уже не соответствует строкам.
    await api().patch(`/api/workshop-needs/${needsB[0]!.id}`).set('Cookie', manager).send({ quotedPrice: null }).expect(200);
    expect(await completedEstimateTotal(orderId, calcB)).toBe(totalB);
    expect((await money(orderId)).stale).toBe(false); // A не тронут

    // Активация B: не «Расчёт завершён по свежей смете», а видимая отметка.
    await activate(orderId, calcB);
    const afterActivateB = await money(orderId);
    expect(afterActivateB.status).toBe('CALCULATION_DONE');
    expect(afterActivateB.total).toBe(totalB);
    expect(afterActivateB.stale).toBe(true);
    expect(afterActivateB.reason ?? '').toContain('Не указана цена');

    // Закупщик вернул цену (уже на активном B) — автопересчёт снял отметку.
    await api().patch(`/api/workshop-needs/${needsB[0]!.id}`).set('Cookie', manager).send({ quotedPrice: '250' }).expect(200);
    const fixed = await money(orderId);
    expect(fixed.stale).toBe(false);
    expect(fixed.total).toBe(totalB - 2000 + 2500);
  });
});
